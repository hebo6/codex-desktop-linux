use std::{
    error::Error,
    fmt,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqliteConnection, SqlitePool, sqlite::SqliteRow};

use crate::configuration::ServerId;

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MAX_THREAD_ID_BYTES: usize = 1_024;
const MAX_DRAFT_KEY_BYTES: usize = 256;

#[derive(Clone)]
pub(crate) struct WindowStateRepository {
    pool: SqlitePool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowState {
    pub(crate) window_id: String,
    pub(crate) version: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) server_id: Option<ServerId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) current_thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) draft_key: Option<String>,
    pub(crate) updated_at_ms: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct WindowGeometry {
    pub(crate) position: Option<(i32, i32)>,
    pub(crate) size: Option<(u32, u32)>,
    pub(crate) is_maximized: bool,
    pub(crate) is_fullscreen: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BindWindowServerRequest {
    pub(crate) expected_version: u64,
    #[serde(deserialize_with = "deserialize_nullable_server_id")]
    pub(crate) server_id: Option<ServerId>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateWindowSessionRequest {
    pub(crate) expected_version: u64,
    #[serde(deserialize_with = "deserialize_nullable_string")]
    current_thread_id: Option<String>,
    #[serde(deserialize_with = "deserialize_nullable_string")]
    draft_key: Option<String>,
}

#[derive(Debug)]
pub(crate) enum WindowStateRepositoryError {
    InvalidVersion,
    InvalidThreadId,
    InvalidDraftKey,
    SessionWithoutServer,
    WindowNotFound,
    ServerNotFound,
    VersionConflict,
    Corrupt,
    Database(sqlx::Error),
}

impl fmt::Display for WindowStateRepositoryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidVersion => formatter.write_str("The window state version is invalid"),
            Self::InvalidThreadId => formatter.write_str("The current thread ID is invalid"),
            Self::InvalidDraftKey => formatter.write_str("The draft key is invalid"),
            Self::SessionWithoutServer => {
                formatter.write_str("A window without a server cannot select a session")
            }
            Self::WindowNotFound => formatter.write_str("The window state does not exist"),
            Self::ServerNotFound => formatter.write_str("The server does not exist"),
            Self::VersionConflict => {
                formatter.write_str("The window state was modified concurrently")
            }
            Self::Corrupt => formatter.write_str("The persisted window state is corrupt"),
            Self::Database(_) => formatter.write_str("The window state database operation failed"),
        }
    }
}

impl Error for WindowStateRepositoryError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Database(source) => Some(source),
            _ => None,
        }
    }
}

impl WindowStateRepository {
    pub(crate) fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub(crate) async fn initialize(&self) -> Result<(), WindowStateRepositoryError> {
        sqlx::query("DELETE FROM server_window_references")
            .execute(&self.pool)
            .await
            .map_err(database_error)?;
        Ok(())
    }

    pub(crate) async fn load_geometry(
        &self,
        window_id: &str,
    ) -> Result<Option<WindowGeometry>, WindowStateRepositoryError> {
        let row = sqlx::query(
            "SELECT position_x, position_y, width, height, is_maximized, is_fullscreen
             FROM window_states WHERE window_id = ?",
        )
        .bind(window_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(database_error)?;
        row.map(decode_window_geometry).transpose()
    }

    pub(crate) async fn save_geometry(
        &self,
        window_id: &str,
        geometry: WindowGeometry,
    ) -> Result<(), WindowStateRepositoryError> {
        let now_ms = current_time_ms()?;
        let (position_x, position_y) = geometry.position.map_or((None, None), |(x, y)| {
            (Some(i64::from(x)), Some(i64::from(y)))
        });
        let (width, height) = geometry.size.map_or((None, None), |(width, height)| {
            (Some(i64::from(width)), Some(i64::from(height)))
        });
        let result = sqlx::query(
            "UPDATE window_states SET
                position_x = COALESCE(?, position_x),
                position_y = COALESCE(?, position_y),
                width = COALESCE(?, width),
                height = COALESCE(?, height),
                is_maximized = ?,
                is_fullscreen = ?,
                updated_at_ms = ?
             WHERE window_id = ?",
        )
        .bind(position_x)
        .bind(position_y)
        .bind(width)
        .bind(height)
        .bind(i64::from(geometry.is_maximized))
        .bind(i64::from(geometry.is_fullscreen))
        .bind(now_ms)
        .bind(window_id)
        .execute(&self.pool)
        .await
        .map_err(database_error)?;
        if result.rows_affected() == 0 {
            return Err(WindowStateRepositoryError::WindowNotFound);
        }
        Ok(())
    }

    pub(crate) async fn load_and_activate(
        &self,
        window_id: &str,
    ) -> Result<WindowState, WindowStateRepositoryError> {
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database_error)?;
        sqlx::query("INSERT INTO window_states (window_id) VALUES (?) ON CONFLICT DO NOTHING")
            .bind(window_id)
            .execute(&mut *transaction)
            .await
            .map_err(database_error)?;
        let state = load_window_state(&mut transaction, window_id).await?;
        set_active_reference(
            &mut transaction,
            window_id,
            state.server_id,
            state.updated_at_ms,
        )
        .await?;
        transaction.commit().await.map_err(database_error)?;
        Ok(state)
    }

    pub(crate) async fn bind_server(
        &self,
        window_id: &str,
        request: BindWindowServerRequest,
    ) -> Result<WindowState, WindowStateRepositoryError> {
        validate_expected_version(request.expected_version)?;
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database_error)?;
        let current = load_window_state(&mut transaction, window_id).await?;
        if current.version != request.expected_version {
            return Err(WindowStateRepositoryError::VersionConflict);
        }
        if current.server_id == request.server_id {
            set_active_reference(
                &mut transaction,
                window_id,
                current.server_id,
                current.updated_at_ms,
            )
            .await?;
            transaction.commit().await.map_err(database_error)?;
            return Ok(current);
        }

        if let Some(server_id) = request.server_id {
            require_server(&mut transaction, server_id).await?;
        }
        persist_current_server_session(&mut transaction, &current).await?;
        let (current_thread_id, draft_key) = match request.server_id {
            Some(server_id) => load_server_session(&mut transaction, window_id, server_id).await?,
            None => (None, None),
        };
        let now_ms = current_time_ms()?;
        let updated = sqlx::query(
            "UPDATE window_states
             SET server_id = ?, current_thread_id = ?, draft_key = ?, version = version + 1,
                 updated_at_ms = MAX(updated_at_ms + 1, ?)
             WHERE window_id = ? AND version = ? AND version < ?",
        )
        .bind(request.server_id.map(server_id_string))
        .bind(current_thread_id)
        .bind(draft_key)
        .bind(now_ms)
        .bind(window_id)
        .bind(version_to_i64(request.expected_version)?)
        .bind(MAX_SAFE_INTEGER)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?
        .rows_affected();
        if updated != 1 {
            return Err(WindowStateRepositoryError::VersionConflict);
        }
        if let Some(server_id) = request.server_id {
            mark_server_used(&mut transaction, server_id, now_ms).await?;
        }
        let state = load_window_state(&mut transaction, window_id).await?;
        set_active_reference(
            &mut transaction,
            window_id,
            state.server_id,
            state.updated_at_ms,
        )
        .await?;
        transaction.commit().await.map_err(database_error)?;
        Ok(state)
    }

    pub(crate) async fn update_session(
        &self,
        window_id: &str,
        request: UpdateWindowSessionRequest,
    ) -> Result<WindowState, WindowStateRepositoryError> {
        validate_expected_version(request.expected_version)?;
        validate_optional_text(
            request.current_thread_id.as_deref(),
            MAX_THREAD_ID_BYTES,
            WindowStateRepositoryError::InvalidThreadId,
        )?;
        validate_optional_text(
            request.draft_key.as_deref(),
            MAX_DRAFT_KEY_BYTES,
            WindowStateRepositoryError::InvalidDraftKey,
        )?;

        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database_error)?;
        let current = load_window_state(&mut transaction, window_id).await?;
        if current.version != request.expected_version {
            return Err(WindowStateRepositoryError::VersionConflict);
        }
        if current.server_id.is_none()
            && (request.current_thread_id.is_some() || request.draft_key.is_some())
        {
            return Err(WindowStateRepositoryError::SessionWithoutServer);
        }
        if current.current_thread_id == request.current_thread_id
            && current.draft_key == request.draft_key
        {
            transaction.commit().await.map_err(database_error)?;
            return Ok(current);
        }

        let now_ms = current_time_ms()?;
        let updated = sqlx::query(
            "UPDATE window_states
             SET current_thread_id = ?, draft_key = ?, version = version + 1,
                 updated_at_ms = MAX(updated_at_ms + 1, ?)
             WHERE window_id = ? AND version = ? AND version < ?",
        )
        .bind(&request.current_thread_id)
        .bind(&request.draft_key)
        .bind(now_ms)
        .bind(window_id)
        .bind(version_to_i64(request.expected_version)?)
        .bind(MAX_SAFE_INTEGER)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?
        .rows_affected();
        if updated != 1 {
            return Err(WindowStateRepositoryError::VersionConflict);
        }
        if let Some(server_id) = current.server_id {
            upsert_server_session(
                &mut transaction,
                window_id,
                server_id,
                request.current_thread_id.as_deref(),
                request.draft_key.as_deref(),
                now_ms,
            )
            .await?;
        }
        let state = load_window_state(&mut transaction, window_id).await?;
        transaction.commit().await.map_err(database_error)?;
        Ok(state)
    }

    pub(crate) async fn reserve_new_window(
        &self,
        window_id: &str,
        server_id: ServerId,
        current_thread_id: Option<&str>,
    ) -> Result<WindowState, WindowStateRepositoryError> {
        validate_optional_text(
            current_thread_id,
            MAX_THREAD_ID_BYTES,
            WindowStateRepositoryError::InvalidThreadId,
        )?;
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database_error)?;
        require_server(&mut transaction, server_id).await?;
        let now_ms = current_time_ms()?;
        let inserted = sqlx::query(
            "INSERT INTO window_states
             (window_id, server_id, current_thread_id, updated_at_ms)
             VALUES (?, ?, ?, ?)",
        )
        .bind(window_id)
        .bind(server_id_string(server_id))
        .bind(current_thread_id)
        .bind(now_ms)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?
        .rows_affected();
        if inserted != 1 {
            return Err(WindowStateRepositoryError::Corrupt);
        }
        upsert_server_session(
            &mut transaction,
            window_id,
            server_id,
            current_thread_id,
            None,
            now_ms,
        )
        .await?;
        set_active_reference(&mut transaction, window_id, Some(server_id), now_ms).await?;
        mark_server_used(&mut transaction, server_id, now_ms).await?;
        let state = load_window_state(&mut transaction, window_id).await?;
        transaction.commit().await.map_err(database_error)?;
        Ok(state)
    }

    pub(crate) async fn discard_reserved_window(
        &self,
        window_id: &str,
    ) -> Result<(), WindowStateRepositoryError> {
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database_error)?;
        sqlx::query("DELETE FROM server_window_references WHERE window_id = ?")
            .bind(window_id)
            .execute(&mut *transaction)
            .await
            .map_err(database_error)?;
        sqlx::query("DELETE FROM window_states WHERE window_id = ?")
            .bind(window_id)
            .execute(&mut *transaction)
            .await
            .map_err(database_error)?;
        transaction.commit().await.map_err(database_error)
    }

    pub(crate) async fn deactivate(
        &self,
        window_id: &str,
    ) -> Result<(), WindowStateRepositoryError> {
        sqlx::query("DELETE FROM server_window_references WHERE window_id = ?")
            .bind(window_id)
            .execute(&self.pool)
            .await
            .map_err(database_error)?;
        Ok(())
    }
}

async fn load_window_state(
    connection: &mut SqliteConnection,
    window_id: &str,
) -> Result<WindowState, WindowStateRepositoryError> {
    let row = sqlx::query(
        "SELECT window_id, version, server_id, current_thread_id, draft_key, updated_at_ms
         FROM window_states WHERE window_id = ?",
    )
    .bind(window_id)
    .fetch_optional(&mut *connection)
    .await
    .map_err(database_error)?
    .ok_or(WindowStateRepositoryError::WindowNotFound)?;
    decode_window_state(row)
}

fn decode_window_state(row: SqliteRow) -> Result<WindowState, WindowStateRepositoryError> {
    let window_id: String = row.try_get("window_id").map_err(database_error)?;
    if window_id.trim().is_empty() {
        return Err(WindowStateRepositoryError::Corrupt);
    }
    let version: i64 = row.try_get("version").map_err(database_error)?;
    let version = u64::try_from(version)
        .ok()
        .filter(|version| *version > 0 && *version <= MAX_SAFE_INTEGER as u64)
        .ok_or(WindowStateRepositoryError::Corrupt)?;
    let server_id = row
        .try_get::<Option<String>, _>("server_id")
        .map_err(database_error)?
        .map(|value| ServerId::parse_persisted(&value).ok_or(WindowStateRepositoryError::Corrupt))
        .transpose()?;
    let current_thread_id = row
        .try_get::<Option<String>, _>("current_thread_id")
        .map_err(database_error)?;
    let draft_key = row
        .try_get::<Option<String>, _>("draft_key")
        .map_err(database_error)?;
    validate_optional_text(
        current_thread_id.as_deref(),
        MAX_THREAD_ID_BYTES,
        WindowStateRepositoryError::Corrupt,
    )?;
    validate_optional_text(
        draft_key.as_deref(),
        MAX_DRAFT_KEY_BYTES,
        WindowStateRepositoryError::Corrupt,
    )?;
    if server_id.is_none() && (current_thread_id.is_some() || draft_key.is_some()) {
        return Err(WindowStateRepositoryError::Corrupt);
    }
    let updated_at_ms: i64 = row.try_get("updated_at_ms").map_err(database_error)?;
    if !(0..=MAX_SAFE_INTEGER).contains(&updated_at_ms) {
        return Err(WindowStateRepositoryError::Corrupt);
    }
    Ok(WindowState {
        window_id,
        version,
        server_id,
        current_thread_id,
        draft_key,
        updated_at_ms,
    })
}

fn decode_window_geometry(row: SqliteRow) -> Result<WindowGeometry, WindowStateRepositoryError> {
    let position_x = row
        .try_get::<Option<i64>, _>("position_x")
        .map_err(database_error)?;
    let position_y = row
        .try_get::<Option<i64>, _>("position_y")
        .map_err(database_error)?;
    let width = row
        .try_get::<Option<i64>, _>("width")
        .map_err(database_error)?;
    let height = row
        .try_get::<Option<i64>, _>("height")
        .map_err(database_error)?;
    let position = match (position_x, position_y) {
        (Some(x), Some(y)) => Some((
            i32::try_from(x).map_err(|_| WindowStateRepositoryError::Corrupt)?,
            i32::try_from(y).map_err(|_| WindowStateRepositoryError::Corrupt)?,
        )),
        (None, None) => None,
        _ => return Err(WindowStateRepositoryError::Corrupt),
    };
    let size = match (width, height) {
        (Some(width), Some(height)) => Some((
            u32::try_from(width)
                .ok()
                .filter(|value| *value > 0)
                .ok_or(WindowStateRepositoryError::Corrupt)?,
            u32::try_from(height)
                .ok()
                .filter(|value| *value > 0)
                .ok_or(WindowStateRepositoryError::Corrupt)?,
        )),
        (None, None) => None,
        _ => return Err(WindowStateRepositoryError::Corrupt),
    };
    let is_maximized = decode_sqlite_boolean(&row, "is_maximized")?;
    let is_fullscreen = decode_sqlite_boolean(&row, "is_fullscreen")?;
    Ok(WindowGeometry {
        position,
        size,
        is_maximized,
        is_fullscreen,
    })
}

fn decode_sqlite_boolean(
    row: &SqliteRow,
    column: &str,
) -> Result<bool, WindowStateRepositoryError> {
    match row.try_get::<i64, _>(column).map_err(database_error)? {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(WindowStateRepositoryError::Corrupt),
    }
}

async fn require_server(
    connection: &mut SqliteConnection,
    server_id: ServerId,
) -> Result<(), WindowStateRepositoryError> {
    let exists: i64 =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM servers WHERE server_id = ?)")
            .bind(server_id_string(server_id))
            .fetch_one(&mut *connection)
            .await
            .map_err(database_error)?;
    match exists {
        1 => Ok(()),
        0 => Err(WindowStateRepositoryError::ServerNotFound),
        _ => Err(WindowStateRepositoryError::Corrupt),
    }
}

async fn mark_server_used(
    connection: &mut SqliteConnection,
    server_id: ServerId,
    now_ms: i64,
) -> Result<(), WindowStateRepositoryError> {
    let updated = sqlx::query(
        "UPDATE servers SET last_used_at_ms = MAX(COALESCE(last_used_at_ms, 0), ?)
         WHERE server_id = ?",
    )
    .bind(now_ms)
    .bind(server_id_string(server_id))
    .execute(&mut *connection)
    .await
    .map_err(database_error)?
    .rows_affected();
    if updated == 1 {
        Ok(())
    } else {
        Err(WindowStateRepositoryError::ServerNotFound)
    }
}

async fn set_active_reference(
    connection: &mut SqliteConnection,
    window_id: &str,
    server_id: Option<ServerId>,
    updated_at_ms: i64,
) -> Result<(), WindowStateRepositoryError> {
    match server_id {
        Some(server_id) => {
            sqlx::query(
                "INSERT INTO server_window_references (window_id, server_id, updated_at_ms)
                 VALUES (?, ?, ?)
                 ON CONFLICT(window_id) DO UPDATE SET
                     server_id = excluded.server_id,
                     updated_at_ms = excluded.updated_at_ms",
            )
            .bind(window_id)
            .bind(server_id_string(server_id))
            .bind(updated_at_ms)
            .execute(&mut *connection)
            .await
            .map_err(database_error)?;
        }
        None => {
            sqlx::query("DELETE FROM server_window_references WHERE window_id = ?")
                .bind(window_id)
                .execute(&mut *connection)
                .await
                .map_err(database_error)?;
        }
    }
    Ok(())
}

async fn persist_current_server_session(
    connection: &mut SqliteConnection,
    state: &WindowState,
) -> Result<(), WindowStateRepositoryError> {
    let Some(server_id) = state.server_id else {
        return Ok(());
    };
    upsert_server_session(
        connection,
        &state.window_id,
        server_id,
        state.current_thread_id.as_deref(),
        state.draft_key.as_deref(),
        state.updated_at_ms,
    )
    .await
}

async fn upsert_server_session(
    connection: &mut SqliteConnection,
    window_id: &str,
    server_id: ServerId,
    current_thread_id: Option<&str>,
    draft_key: Option<&str>,
    updated_at_ms: i64,
) -> Result<(), WindowStateRepositoryError> {
    sqlx::query(
        "INSERT INTO window_server_states
         (window_id, server_id, current_thread_id, draft_key, updated_at_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(window_id, server_id) DO UPDATE SET
             current_thread_id = excluded.current_thread_id,
             draft_key = excluded.draft_key,
             updated_at_ms = excluded.updated_at_ms",
    )
    .bind(window_id)
    .bind(server_id_string(server_id))
    .bind(current_thread_id)
    .bind(draft_key)
    .bind(updated_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(database_error)?;
    Ok(())
}

async fn load_server_session(
    connection: &mut SqliteConnection,
    window_id: &str,
    server_id: ServerId,
) -> Result<(Option<String>, Option<String>), WindowStateRepositoryError> {
    let row = sqlx::query(
        "SELECT current_thread_id, draft_key FROM window_server_states
         WHERE window_id = ? AND server_id = ?",
    )
    .bind(window_id)
    .bind(server_id_string(server_id))
    .fetch_optional(&mut *connection)
    .await
    .map_err(database_error)?;
    let Some(row) = row else {
        return Ok((None, None));
    };
    let thread_id = row
        .try_get::<Option<String>, _>("current_thread_id")
        .map_err(database_error)?;
    let draft_key = row
        .try_get::<Option<String>, _>("draft_key")
        .map_err(database_error)?;
    validate_optional_text(
        thread_id.as_deref(),
        MAX_THREAD_ID_BYTES,
        WindowStateRepositoryError::Corrupt,
    )?;
    validate_optional_text(
        draft_key.as_deref(),
        MAX_DRAFT_KEY_BYTES,
        WindowStateRepositoryError::Corrupt,
    )?;
    Ok((thread_id, draft_key))
}

fn validate_expected_version(version: u64) -> Result<(), WindowStateRepositoryError> {
    if version == 0 || version > MAX_SAFE_INTEGER as u64 {
        Err(WindowStateRepositoryError::InvalidVersion)
    } else {
        Ok(())
    }
}

fn version_to_i64(version: u64) -> Result<i64, WindowStateRepositoryError> {
    i64::try_from(version)
        .ok()
        .filter(|version| *version > 0 && *version <= MAX_SAFE_INTEGER)
        .ok_or(WindowStateRepositoryError::InvalidVersion)
}

fn validate_optional_text(
    value: Option<&str>,
    max_bytes: usize,
    error: WindowStateRepositoryError,
) -> Result<(), WindowStateRepositoryError> {
    if value
        .is_some_and(|value| value.is_empty() || value.len() > max_bytes || value.contains('\0'))
    {
        Err(error)
    } else {
        Ok(())
    }
}

fn current_time_ms() -> Result<i64, WindowStateRepositoryError> {
    let milliseconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| WindowStateRepositoryError::Corrupt)?
        .as_millis();
    i64::try_from(milliseconds)
        .ok()
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or(WindowStateRepositoryError::Corrupt)
}

fn server_id_string(server_id: ServerId) -> String {
    server_id.to_persisted_string()
}

fn database_error(error: sqlx::Error) -> WindowStateRepositoryError {
    WindowStateRepositoryError::Database(error)
}

fn deserialize_nullable_server_id<'de, D>(deserializer: D) -> Result<Option<ServerId>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<ServerId>::deserialize(deserializer)
}

fn deserialize_nullable_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use crate::configuration::{
        ConfigurationRepository, ConfigurationRepositoryError, CreateServerProfileRequest,
        DeleteServerProfileRequest, ServerId,
    };

    use super::{
        BindWindowServerRequest, UpdateWindowSessionRequest, WindowGeometry, WindowStateRepository,
        WindowStateRepositoryError,
    };

    async fn repositories() -> (WindowStateRepository, ConfigurationRepository) {
        let options = SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        (
            WindowStateRepository::new(pool.clone()),
            ConfigurationRepository::new(pool),
        )
    }

    async fn create_server(repository: &ConfigurationRepository, name: &str) -> ServerId {
        let request: CreateServerProfileRequest = serde_json::from_value(json!({
            "name": name,
            "configuration": {
                "type": "localStdio",
                "executablePath": "/usr/bin/codex",
                "arguments": ["app-server"],
                "defaultWorkingDirectory": "/tmp/project",
                "nonSensitiveEnvironment": {}
            }
        }))
        .unwrap();
        repository.create_server(request).await.unwrap().server_id
    }

    fn bind_request(expected_version: u64, server_id: Option<ServerId>) -> BindWindowServerRequest {
        BindWindowServerRequest {
            expected_version,
            server_id,
        }
    }

    fn session_request(
        expected_version: u64,
        current_thread_id: Option<&str>,
        draft_key: Option<&str>,
    ) -> UpdateWindowSessionRequest {
        UpdateWindowSessionRequest {
            expected_version,
            current_thread_id: current_thread_id.map(str::to_owned),
            draft_key: draft_key.map(str::to_owned),
        }
    }

    async fn active_count(repository: &WindowStateRepository, server_id: ServerId) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM server_window_references WHERE server_id = ?")
            .bind(server_id.to_persisted_string())
            .fetch_one(&repository.pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn load_creates_a_stable_default_state_and_registers_only_bound_windows() {
        let (windows, _) = repositories().await;

        let first = windows.load_and_activate("main").await.unwrap();
        let second = windows.load_and_activate("main").await.unwrap();

        assert_eq!(first, second);
        assert_eq!(first.window_id, "main");
        assert_eq!(first.version, 1);
        assert_eq!(first.server_id, None);
        let reference_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM server_window_references")
                .fetch_one(&windows.pool)
                .await
                .unwrap();
        assert_eq!(reference_count, 0);
    }

    #[tokio::test]
    async fn geometry_updates_preserve_normal_bounds_while_maximized() {
        let (windows, _) = repositories().await;
        let initial = windows.load_and_activate("main").await.unwrap();

        windows
            .save_geometry(
                "main",
                WindowGeometry {
                    position: Some((-1200, 80)),
                    size: Some((1280, 800)),
                    is_maximized: false,
                    is_fullscreen: false,
                },
            )
            .await
            .unwrap();
        windows
            .save_geometry(
                "main",
                WindowGeometry {
                    position: None,
                    size: None,
                    is_maximized: true,
                    is_fullscreen: false,
                },
            )
            .await
            .unwrap();

        assert_eq!(
            windows.load_geometry("main").await.unwrap(),
            Some(WindowGeometry {
                position: Some((-1200, 80)),
                size: Some((1280, 800)),
                is_maximized: true,
                is_fullscreen: false,
            })
        );
        assert_eq!(
            windows.load_and_activate("main").await.unwrap().version,
            initial.version
        );
    }

    #[tokio::test]
    async fn restores_thread_and_draft_per_window_and_server() {
        let (windows, configuration) = repositories().await;
        let server_a = create_server(&configuration, "A").await;
        let server_b = create_server(&configuration, "B").await;
        let initial = windows.load_and_activate("main").await.unwrap();

        let server_a_state = windows
            .bind_server("main", bind_request(initial.version, Some(server_a)))
            .await
            .unwrap();
        let server_a_session = windows
            .update_session(
                "main",
                session_request(server_a_state.version, Some("thread-a"), Some("draft-a")),
            )
            .await
            .unwrap();
        let server_b_state = windows
            .bind_server(
                "main",
                bind_request(server_a_session.version, Some(server_b)),
            )
            .await
            .unwrap();
        assert_eq!(server_b_state.current_thread_id, None);
        assert_eq!(server_b_state.draft_key, None);
        let server_b_session = windows
            .update_session(
                "main",
                session_request(server_b_state.version, Some("thread-b"), Some("draft-b")),
            )
            .await
            .unwrap();

        let restored = windows
            .bind_server(
                "main",
                bind_request(server_b_session.version, Some(server_a)),
            )
            .await
            .unwrap();

        assert_eq!(restored.server_id, Some(server_a));
        assert_eq!(restored.current_thread_id.as_deref(), Some("thread-a"));
        assert_eq!(restored.draft_key.as_deref(), Some("draft-a"));
    }

    #[tokio::test]
    async fn active_references_follow_bind_switch_and_destroy_without_erasing_recovery_state() {
        let (windows, configuration) = repositories().await;
        let server_a = create_server(&configuration, "A").await;
        let server_b = create_server(&configuration, "B").await;
        let first = windows.load_and_activate("first").await.unwrap();
        let second = windows.load_and_activate("second").await.unwrap();
        let first = windows
            .bind_server("first", bind_request(first.version, Some(server_a)))
            .await
            .unwrap();
        windows
            .bind_server("second", bind_request(second.version, Some(server_a)))
            .await
            .unwrap();
        assert_eq!(active_count(&windows, server_a).await, 2);
        assert_eq!(
            configuration
                .snapshot()
                .await
                .unwrap()
                .servers
                .into_iter()
                .find(|server| server.server_id == server_a)
                .unwrap()
                .active_window_count,
            2
        );

        windows
            .bind_server("first", bind_request(first.version, Some(server_b)))
            .await
            .unwrap();
        assert_eq!(active_count(&windows, server_a).await, 1);
        assert_eq!(active_count(&windows, server_b).await, 1);

        windows.deactivate("second").await.unwrap();
        assert_eq!(active_count(&windows, server_a).await, 0);
        let restored = windows.load_and_activate("second").await.unwrap();
        assert_eq!(restored.server_id, Some(server_a));
        assert_eq!(active_count(&windows, server_a).await, 1);
    }

    #[tokio::test]
    async fn reserved_new_window_can_restore_an_explicit_thread() {
        let (windows, configuration) = repositories().await;
        let server = create_server(&configuration, "A").await;

        let reserved = windows
            .reserve_new_window("secondary", server, Some("thread-a"))
            .await
            .unwrap();

        assert_eq!(reserved.server_id, Some(server));
        assert_eq!(reserved.current_thread_id.as_deref(), Some("thread-a"));
        assert_eq!(reserved.draft_key, None);
        assert_eq!(active_count(&windows, server).await, 1);
        assert_eq!(
            windows
                .load_and_activate("secondary")
                .await
                .unwrap()
                .current_thread_id
                .as_deref(),
            Some("thread-a")
        );

        windows.discard_reserved_window("secondary").await.unwrap();
        assert_eq!(active_count(&windows, server).await, 0);
        assert!(matches!(
            windows
                .reserve_new_window("invalid", server, Some(""))
                .await,
            Err(WindowStateRepositoryError::InvalidThreadId)
        ));
    }

    #[tokio::test]
    async fn startup_clears_stale_active_references_but_preserves_recovery_state() {
        let (windows, configuration) = repositories().await;
        let server = create_server(&configuration, "A").await;
        let initial = windows.load_and_activate("main").await.unwrap();
        let bound = windows
            .bind_server("main", bind_request(initial.version, Some(server)))
            .await
            .unwrap();
        assert_eq!(active_count(&windows, server).await, 1);

        windows.initialize().await.unwrap();

        assert_eq!(active_count(&windows, server).await, 0);
        let restored = windows.load_and_activate("main").await.unwrap();
        assert_eq!(restored.server_id, Some(server));
        assert_eq!(restored.version, bound.version);
    }

    #[tokio::test]
    async fn late_activation_after_destroy_cleanup_can_be_reconciled() {
        let (windows, configuration) = repositories().await;
        let server = create_server(&configuration, "A").await;
        let initial = windows.load_and_activate("main").await.unwrap();
        windows
            .bind_server("main", bind_request(initial.version, Some(server)))
            .await
            .unwrap();

        windows.deactivate("main").await.unwrap();
        windows.load_and_activate("main").await.unwrap();
        assert_eq!(active_count(&windows, server).await, 1);

        windows.deactivate("main").await.unwrap();
        assert_eq!(active_count(&windows, server).await, 0);
    }

    #[tokio::test]
    async fn a_closed_window_does_not_block_deletion_and_its_recovery_state_is_cleared() {
        let (windows, configuration) = repositories().await;
        let server = create_server(&configuration, "A").await;
        let initial = windows.load_and_activate("main").await.unwrap();
        let bound = windows
            .bind_server("main", bind_request(initial.version, Some(server)))
            .await
            .unwrap();
        windows.deactivate("main").await.unwrap();

        let request: DeleteServerProfileRequest = serde_json::from_value(json!({
            "serverId": server,
            "expectedVersion": 1
        }))
        .unwrap();
        configuration.delete_server(request).await.unwrap();

        let restored = windows.load_and_activate("main").await.unwrap();
        assert_eq!(restored.server_id, None);
        assert_eq!(restored.current_thread_id, None);
        assert_eq!(restored.draft_key, None);
        assert_eq!(restored.version, bound.version + 1);
    }

    #[tokio::test]
    async fn concurrent_bind_and_delete_are_serialized_without_a_dangling_reference() {
        let (windows, configuration) = repositories().await;
        let server = create_server(&configuration, "A").await;
        let initial = windows.load_and_activate("main").await.unwrap();
        let delete_request: DeleteServerProfileRequest = serde_json::from_value(json!({
            "serverId": server,
            "expectedVersion": 1
        }))
        .unwrap();
        let binding_windows = windows.clone();
        let deleting_configuration = configuration.clone();

        let (binding, deletion) = tokio::join!(
            async move {
                binding_windows
                    .bind_server("main", bind_request(initial.version, Some(server)))
                    .await
            },
            async move { deleting_configuration.delete_server(delete_request).await }
        );

        match (binding, deletion) {
            (Ok(state), Err(ConfigurationRepositoryError::ServerInUse)) => {
                assert_eq!(state.server_id, Some(server));
                assert_eq!(active_count(&windows, server).await, 1);
            }
            (Err(WindowStateRepositoryError::ServerNotFound), Ok(())) => {
                let reference_count: i64 =
                    sqlx::query_scalar("SELECT COUNT(*) FROM server_window_references")
                        .fetch_one(&windows.pool)
                        .await
                        .unwrap();
                assert_eq!(reference_count, 0);
            }
            outcome => panic!("unexpected concurrent outcome: {outcome:?}"),
        }
    }

    #[tokio::test]
    async fn same_server_bind_is_idempotent_and_version_conflicts_are_rejected() {
        let (windows, configuration) = repositories().await;
        let server = create_server(&configuration, "A").await;
        let initial = windows.load_and_activate("main").await.unwrap();
        let bound = windows
            .bind_server("main", bind_request(initial.version, Some(server)))
            .await
            .unwrap();

        let repeated = windows
            .bind_server("main", bind_request(bound.version, Some(server)))
            .await
            .unwrap();
        assert_eq!(repeated, bound);
        assert_eq!(active_count(&windows, server).await, 1);
        assert!(matches!(
            windows
                .bind_server("main", bind_request(initial.version, None))
                .await,
            Err(WindowStateRepositoryError::VersionConflict)
        ));
    }

    #[tokio::test]
    async fn rejects_session_values_without_a_bound_server_or_outside_contract_limits() {
        let (windows, _) = repositories().await;
        let initial = windows.load_and_activate("main").await.unwrap();

        assert!(matches!(
            windows
                .update_session(
                    "main",
                    session_request(initial.version, Some("thread-a"), None),
                )
                .await,
            Err(WindowStateRepositoryError::SessionWithoutServer)
        ));
        assert!(matches!(
            windows
                .update_session(
                    "main",
                    session_request(initial.version, Some(&"a".repeat(1_025)), None),
                )
                .await,
            Err(WindowStateRepositoryError::InvalidThreadId)
        ));
    }

    #[test]
    fn nullable_request_fields_must_be_explicit() {
        assert!(
            serde_json::from_value::<BindWindowServerRequest>(json!({
                "expectedVersion": 1
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<UpdateWindowSessionRequest>(json!({
                "expectedVersion": 1,
                "currentThreadId": null
            }))
            .is_err()
        );
    }
}
