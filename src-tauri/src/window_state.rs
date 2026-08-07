use std::{
    collections::HashMap,
    error::Error,
    fmt,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqliteConnection, SqlitePool, sqlite::SqliteRow};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::configuration::ServerId;

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MAX_THREAD_ID_BYTES: usize = 1_024;
const MAX_TAB_ID_BYTES: usize = 64;
const MAX_TABS: usize = 100;

#[derive(Clone)]
pub(crate) struct WindowStateRepository {
    pool: SqlitePool,
    runtime_states: Arc<Mutex<HashMap<String, WindowRuntimeState>>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct WindowRuntimeState {
    server_id: ServerId,
    tabs: Vec<WindowTab>,
    active_tab_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowState {
    pub(crate) window_id: String,
    pub(crate) version: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) server_id: Option<ServerId>,
    pub(crate) tabs: Vec<WindowTab>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) active_tab_id: Option<String>,
    pub(crate) updated_at_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WindowTab {
    pub(crate) id: String,
    pub(crate) thread_id: Option<String>,
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
pub(crate) struct UpdateWindowTabsRequest {
    pub(crate) expected_version: u64,
    tabs: Vec<WindowTab>,
    active_tab_id: String,
}

#[derive(Debug)]
pub(crate) enum WindowStateRepositoryError {
    InvalidVersion,
    InvalidTabs,
    InvalidThreadId,
    TabsWithoutServer,
    WindowNotFound,
    ServerNotFound,
    ServerAlreadyOpen(String),
    VersionConflict,
    Corrupt,
    Database(sqlx::Error),
}

impl fmt::Display for WindowStateRepositoryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidVersion => formatter.write_str("The window state version is invalid"),
            Self::InvalidTabs => formatter.write_str("The window tabs are invalid"),
            Self::InvalidThreadId => formatter.write_str("The current thread ID is invalid"),
            Self::TabsWithoutServer => {
                formatter.write_str("A window without a server cannot update tabs")
            }
            Self::WindowNotFound => formatter.write_str("The window state does not exist"),
            Self::ServerNotFound => formatter.write_str("The server does not exist"),
            Self::ServerAlreadyOpen(_) => {
                formatter.write_str("The server is already open in another window")
            }
            Self::VersionConflict => {
                formatter.write_str("The window state was modified concurrently")
            }
            Self::Corrupt => formatter.write_str("The window state is corrupt"),
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
        Self {
            pool,
            runtime_states: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub(crate) async fn initialize(&self) -> Result<(), WindowStateRepositoryError> {
        let mut runtime_states = self.runtime_states.lock().await;
        sqlx::query("DELETE FROM server_window_references")
            .execute(&self.pool)
            .await
            .map_err(database_error)?;
        runtime_states.clear();
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
        let mut runtime_states = self.runtime_states.lock().await;
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
        let state = load_persisted_window_state(&mut transaction, window_id).await?;
        if let Some(server_id) = state.server_id
            && let Some(active_window_id) =
                active_window_for_server(&mut transaction, server_id, Some(window_id)).await?
        {
            return Err(WindowStateRepositoryError::ServerAlreadyOpen(
                active_window_id,
            ));
        }
        let runtime_state = initial_runtime_state(&state, runtime_states.get(window_id));
        set_active_reference(
            &mut transaction,
            window_id,
            state.server_id,
            state.updated_at_ms,
        )
        .await?;
        transaction.commit().await.map_err(database_error)?;
        replace_runtime_state(&mut runtime_states, window_id, runtime_state.clone());
        attach_runtime_state(state, runtime_state.as_ref())
    }

    pub(crate) async fn bind_server(
        &self,
        window_id: &str,
        request: BindWindowServerRequest,
    ) -> Result<WindowState, WindowStateRepositoryError> {
        validate_expected_version(request.expected_version)?;
        let mut runtime_states = self.runtime_states.lock().await;
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database_error)?;
        let persisted = load_persisted_window_state(&mut transaction, window_id).await?;
        let current_runtime = current_runtime_state(&persisted, runtime_states.get(window_id))?;
        let current = attach_runtime_state(persisted, current_runtime.as_ref())?;
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
            replace_runtime_state(&mut runtime_states, window_id, current_runtime);
            return Ok(current);
        }

        if let Some(server_id) = request.server_id {
            require_server(&mut transaction, server_id).await?;
            if let Some(active_window_id) =
                active_window_for_server(&mut transaction, server_id, Some(window_id)).await?
            {
                return Err(WindowStateRepositoryError::ServerAlreadyOpen(
                    active_window_id,
                ));
            }
        }
        let now_ms = current_time_ms()?;
        let updated = sqlx::query(
            "UPDATE window_states
             SET server_id = ?, version = version + 1,
                 updated_at_ms = MAX(updated_at_ms + 1, ?)
             WHERE window_id = ? AND version = ? AND version < ?",
        )
        .bind(request.server_id.map(server_id_string))
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
        let state = load_persisted_window_state(&mut transaction, window_id).await?;
        let runtime_state = state
            .server_id
            .map(|server_id| WindowRuntimeState::new(server_id, None));
        set_active_reference(
            &mut transaction,
            window_id,
            state.server_id,
            state.updated_at_ms,
        )
        .await?;
        transaction.commit().await.map_err(database_error)?;
        replace_runtime_state(&mut runtime_states, window_id, runtime_state.clone());
        attach_runtime_state(state, runtime_state.as_ref())
    }

    pub(crate) async fn update_tabs(
        &self,
        window_id: &str,
        request: UpdateWindowTabsRequest,
    ) -> Result<WindowState, WindowStateRepositoryError> {
        validate_expected_version(request.expected_version)?;
        validate_tabs(&request.tabs, &request.active_tab_id)?;

        let mut runtime_states = self.runtime_states.lock().await;
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database_error)?;
        let persisted = load_persisted_window_state(&mut transaction, window_id).await?;
        let current_runtime = current_runtime_state(&persisted, runtime_states.get(window_id))?;
        let current = attach_runtime_state(persisted, current_runtime.as_ref())?;
        if current.version != request.expected_version {
            return Err(WindowStateRepositoryError::VersionConflict);
        }
        let Some(server_id) = current.server_id else {
            return Err(WindowStateRepositoryError::TabsWithoutServer);
        };
        if current.tabs == request.tabs
            && current.active_tab_id.as_deref() == Some(request.active_tab_id.as_str())
        {
            transaction.commit().await.map_err(database_error)?;
            replace_runtime_state(&mut runtime_states, window_id, current_runtime);
            return Ok(current);
        }

        let now_ms = current_time_ms()?;
        let updated = sqlx::query(
            "UPDATE window_states
             SET version = version + 1, updated_at_ms = MAX(updated_at_ms + 1, ?)
             WHERE window_id = ? AND version = ? AND version < ?",
        )
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
        let state = load_persisted_window_state(&mut transaction, window_id).await?;
        let runtime_state = WindowRuntimeState {
            server_id,
            tabs: request.tabs,
            active_tab_id: request.active_tab_id,
        };
        transaction.commit().await.map_err(database_error)?;
        runtime_states.insert(window_id.to_owned(), runtime_state.clone());
        attach_runtime_state(state, Some(&runtime_state))
    }

    pub(crate) async fn reserve_new_window(
        &self,
        window_id: &str,
        server_id: ServerId,
        thread_id: Option<&str>,
    ) -> Result<WindowState, WindowStateRepositoryError> {
        validate_optional_text(
            thread_id,
            MAX_THREAD_ID_BYTES,
            WindowStateRepositoryError::InvalidThreadId,
        )?;
        let mut runtime_states = self.runtime_states.lock().await;
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database_error)?;
        require_server(&mut transaction, server_id).await?;
        if let Some(active_window_id) =
            active_window_for_server(&mut transaction, server_id, None).await?
        {
            return Err(WindowStateRepositoryError::ServerAlreadyOpen(
                active_window_id,
            ));
        }
        let now_ms = current_time_ms()?;
        let inserted = sqlx::query(
            "INSERT INTO window_states
             (window_id, server_id, updated_at_ms)
             VALUES (?, ?, ?)",
        )
        .bind(window_id)
        .bind(server_id_string(server_id))
        .bind(now_ms)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?
        .rows_affected();
        if inserted != 1 {
            return Err(WindowStateRepositoryError::Corrupt);
        }
        let runtime_state = WindowRuntimeState::new(server_id, thread_id);
        set_active_reference(&mut transaction, window_id, Some(server_id), now_ms).await?;
        mark_server_used(&mut transaction, server_id, now_ms).await?;
        let state = load_persisted_window_state(&mut transaction, window_id).await?;
        transaction.commit().await.map_err(database_error)?;
        runtime_states.insert(window_id.to_owned(), runtime_state.clone());
        attach_runtime_state(state, Some(&runtime_state))
    }

    pub(crate) async fn active_window_for_server(
        &self,
        server_id: ServerId,
    ) -> Result<Option<String>, WindowStateRepositoryError> {
        let mut connection = self.pool.acquire().await.map_err(database_error)?;
        active_window_for_server(&mut connection, server_id, None).await
    }

    pub(crate) async fn open_tab_for_server(
        &self,
        window_id: &str,
        server_id: ServerId,
        thread_id: Option<&str>,
    ) -> Result<WindowState, WindowStateRepositoryError> {
        validate_optional_text(
            thread_id,
            MAX_THREAD_ID_BYTES,
            WindowStateRepositoryError::InvalidThreadId,
        )?;
        let mut runtime_states = self.runtime_states.lock().await;
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database_error)?;
        let persisted = load_persisted_window_state(&mut transaction, window_id).await?;
        let current_runtime = current_runtime_state(&persisted, runtime_states.get(window_id))?;
        let current = attach_runtime_state(persisted, current_runtime.as_ref())?;
        if current.server_id != Some(server_id) {
            return Err(WindowStateRepositoryError::Corrupt);
        }
        let (tabs, active_tab_id) = match thread_id {
            Some(thread_id) => {
                if let Some(tab) = current
                    .tabs
                    .iter()
                    .find(|tab| tab.thread_id.as_deref() == Some(thread_id))
                {
                    (current.tabs.clone(), tab.id.clone())
                } else {
                    let tab = WindowTab {
                        id: new_tab_id(),
                        thread_id: Some(thread_id.to_owned()),
                    };
                    let mut tabs = current.tabs.clone();
                    tabs.push(tab.clone());
                    (tabs, tab.id)
                }
            }
            None => {
                let tab = WindowTab {
                    id: new_tab_id(),
                    thread_id: None,
                };
                let mut tabs = current.tabs.clone();
                tabs.push(tab.clone());
                (tabs, tab.id)
            }
        };
        validate_tabs(&tabs, &active_tab_id)?;
        if current.active_tab_id.as_deref() == Some(active_tab_id.as_str()) && current.tabs == tabs
        {
            transaction.commit().await.map_err(database_error)?;
            replace_runtime_state(&mut runtime_states, window_id, current_runtime);
            return Ok(current);
        }
        let now_ms = current_time_ms()?;
        let updated = sqlx::query(
            "UPDATE window_states
             SET version = version + 1, updated_at_ms = MAX(updated_at_ms + 1, ?)
             WHERE window_id = ? AND version = ? AND version < ?",
        )
        .bind(now_ms)
        .bind(window_id)
        .bind(version_to_i64(current.version)?)
        .bind(MAX_SAFE_INTEGER)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?
        .rows_affected();
        if updated != 1 {
            return Err(WindowStateRepositoryError::VersionConflict);
        }
        let state = load_persisted_window_state(&mut transaction, window_id).await?;
        let runtime_state = WindowRuntimeState {
            server_id,
            tabs,
            active_tab_id,
        };
        transaction.commit().await.map_err(database_error)?;
        runtime_states.insert(window_id.to_owned(), runtime_state.clone());
        attach_runtime_state(state, Some(&runtime_state))
    }

    pub(crate) async fn discard_reserved_window(
        &self,
        window_id: &str,
    ) -> Result<(), WindowStateRepositoryError> {
        let mut runtime_states = self.runtime_states.lock().await;
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
        transaction.commit().await.map_err(database_error)?;
        runtime_states.remove(window_id);
        Ok(())
    }

    pub(crate) async fn deactivate(
        &self,
        window_id: &str,
    ) -> Result<(), WindowStateRepositoryError> {
        let mut runtime_states = self.runtime_states.lock().await;
        sqlx::query("DELETE FROM server_window_references WHERE window_id = ?")
            .bind(window_id)
            .execute(&self.pool)
            .await
            .map_err(database_error)?;
        runtime_states.remove(window_id);
        Ok(())
    }
}

async fn load_persisted_window_state(
    connection: &mut SqliteConnection,
    window_id: &str,
) -> Result<WindowState, WindowStateRepositoryError> {
    let row = sqlx::query(
        "SELECT window_id, version, server_id, updated_at_ms
         FROM window_states WHERE window_id = ?",
    )
    .bind(window_id)
    .fetch_optional(&mut *connection)
    .await
    .map_err(database_error)?
    .ok_or(WindowStateRepositoryError::WindowNotFound)?;
    decode_window_state(row)
}

impl WindowRuntimeState {
    fn new(server_id: ServerId, thread_id: Option<&str>) -> Self {
        let tab = WindowTab {
            id: new_tab_id(),
            thread_id: thread_id.map(str::to_owned),
        };
        Self {
            server_id,
            active_tab_id: tab.id.clone(),
            tabs: vec![tab],
        }
    }
}

fn initial_runtime_state(
    state: &WindowState,
    current: Option<&WindowRuntimeState>,
) -> Option<WindowRuntimeState> {
    state.server_id.map(|server_id| {
        current
            .filter(|runtime| runtime.server_id == server_id)
            .cloned()
            .unwrap_or_else(|| WindowRuntimeState::new(server_id, None))
    })
}

fn current_runtime_state(
    state: &WindowState,
    current: Option<&WindowRuntimeState>,
) -> Result<Option<WindowRuntimeState>, WindowStateRepositoryError> {
    match (state.server_id, current) {
        (None, None) => Ok(None),
        (Some(server_id), Some(runtime)) if runtime.server_id == server_id => {
            Ok(Some(runtime.clone()))
        }
        _ => Err(WindowStateRepositoryError::Corrupt),
    }
}

fn replace_runtime_state(
    runtime_states: &mut HashMap<String, WindowRuntimeState>,
    window_id: &str,
    state: Option<WindowRuntimeState>,
) {
    match state {
        Some(state) => {
            runtime_states.insert(window_id.to_owned(), state);
        }
        None => {
            runtime_states.remove(window_id);
        }
    }
}

fn attach_runtime_state(
    mut state: WindowState,
    runtime: Option<&WindowRuntimeState>,
) -> Result<WindowState, WindowStateRepositoryError> {
    match (state.server_id, runtime) {
        (None, None) => Ok(state),
        (Some(server_id), Some(runtime)) if runtime.server_id == server_id => {
            validate_tabs(&runtime.tabs, &runtime.active_tab_id)
                .map_err(|_| WindowStateRepositoryError::Corrupt)?;
            state.tabs = runtime.tabs.clone();
            state.active_tab_id = Some(runtime.active_tab_id.clone());
            Ok(state)
        }
        _ => Err(WindowStateRepositoryError::Corrupt),
    }
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
    let updated_at_ms: i64 = row.try_get("updated_at_ms").map_err(database_error)?;
    if !(0..=MAX_SAFE_INTEGER).contains(&updated_at_ms) {
        return Err(WindowStateRepositoryError::Corrupt);
    }
    Ok(WindowState {
        window_id,
        version,
        server_id,
        tabs: Vec::new(),
        active_tab_id: None,
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

async fn active_window_for_server(
    connection: &mut SqliteConnection,
    server_id: ServerId,
    excluded_window_id: Option<&str>,
) -> Result<Option<String>, WindowStateRepositoryError> {
    let row = sqlx::query_scalar::<_, String>(
        "SELECT window_id
         FROM server_window_references
         WHERE server_id = ? AND (? IS NULL OR window_id != ?)",
    )
    .bind(server_id_string(server_id))
    .bind(excluded_window_id)
    .bind(excluded_window_id)
    .fetch_optional(&mut *connection)
    .await
    .map_err(database_error)?;
    Ok(row)
}

fn validate_tabs(
    tabs: &[WindowTab],
    active_tab_id: &str,
) -> Result<(), WindowStateRepositoryError> {
    if tabs.is_empty() || tabs.len() > MAX_TABS {
        return Err(WindowStateRepositoryError::InvalidTabs);
    }
    validate_optional_text(
        Some(active_tab_id),
        MAX_TAB_ID_BYTES,
        WindowStateRepositoryError::InvalidTabs,
    )?;
    let mut tab_ids = std::collections::HashSet::new();
    let mut thread_ids = std::collections::HashSet::new();
    for tab in tabs {
        validate_optional_text(
            Some(&tab.id),
            MAX_TAB_ID_BYTES,
            WindowStateRepositoryError::InvalidTabs,
        )?;
        validate_optional_text(
            tab.thread_id.as_deref(),
            MAX_THREAD_ID_BYTES,
            WindowStateRepositoryError::InvalidThreadId,
        )?;
        if !tab_ids.insert(tab.id.as_str())
            || tab
                .thread_id
                .as_deref()
                .is_some_and(|thread_id| !thread_ids.insert(thread_id))
        {
            return Err(WindowStateRepositoryError::InvalidTabs);
        }
    }
    if !tab_ids.contains(active_tab_id) {
        return Err(WindowStateRepositoryError::InvalidTabs);
    }
    Ok(())
}

fn new_tab_id() -> String {
    Uuid::new_v4().to_string()
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

#[cfg(test)]
mod tests {
    use serde_json::json;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use crate::configuration::{
        ConfigurationRepository, ConfigurationRepositoryError, CreateServerProfileRequest,
        DeleteServerProfileRequest, ServerId,
    };

    use super::{
        BindWindowServerRequest, UpdateWindowTabsRequest, WindowGeometry, WindowStateRepository,
        WindowStateRepositoryError, WindowTab,
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

    fn tabs_request(
        expected_version: u64,
        tabs: Vec<WindowTab>,
        active_tab_id: &str,
    ) -> UpdateWindowTabsRequest {
        UpdateWindowTabsRequest {
            expected_version,
            tabs,
            active_tab_id: active_tab_id.to_owned(),
        }
    }

    fn tab(id: &str, thread_id: Option<&str>) -> WindowTab {
        WindowTab {
            id: id.to_owned(),
            thread_id: thread_id.map(str::to_owned),
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
    async fn switching_servers_always_creates_a_new_blank_tab() {
        let (windows, configuration) = repositories().await;
        let server_a = create_server(&configuration, "A").await;
        let server_b = create_server(&configuration, "B").await;
        let initial = windows.load_and_activate("main").await.unwrap();

        let server_a_state = windows
            .bind_server("main", bind_request(initial.version, Some(server_a)))
            .await
            .unwrap();
        let server_a_tabs = windows
            .update_tabs(
                "main",
                tabs_request(
                    server_a_state.version,
                    vec![tab("tab-a", Some("thread-a")), tab("tab-empty", None)],
                    "tab-empty",
                ),
            )
            .await
            .unwrap();
        let server_b_state = windows
            .bind_server("main", bind_request(server_a_tabs.version, Some(server_b)))
            .await
            .unwrap();
        assert_eq!(server_b_state.tabs.len(), 1);
        assert_eq!(server_b_state.tabs[0].thread_id, None);
        let server_b_tabs = windows
            .update_tabs(
                "main",
                tabs_request(
                    server_b_state.version,
                    vec![tab("tab-b", Some("thread-b"))],
                    "tab-b",
                ),
            )
            .await
            .unwrap();

        let switched_back = windows
            .bind_server("main", bind_request(server_b_tabs.version, Some(server_a)))
            .await
            .unwrap();

        assert_eq!(switched_back.server_id, Some(server_a));
        assert_eq!(switched_back.tabs.len(), 1);
        assert_eq!(switched_back.tabs[0].thread_id, None);
        assert_eq!(
            switched_back.active_tab_id.as_deref(),
            Some(switched_back.tabs[0].id.as_str())
        );
        assert_ne!(switched_back.tabs[0].id, "tab-a");
        assert_ne!(switched_back.tabs[0].id, "tab-empty");
    }

    #[tokio::test]
    async fn active_references_follow_bind_switch_and_destroy() {
        let (windows, configuration) = repositories().await;
        let server_a = create_server(&configuration, "A").await;
        let server_b = create_server(&configuration, "B").await;
        let first = windows.load_and_activate("first").await.unwrap();
        let second = windows.load_and_activate("second").await.unwrap();
        let first = windows
            .bind_server("first", bind_request(first.version, Some(server_a)))
            .await
            .unwrap();
        assert!(matches!(
            windows
            .bind_server("second", bind_request(second.version, Some(server_a)))
            .await,
            Err(WindowStateRepositoryError::ServerAlreadyOpen(window_id))
                if window_id == "first"
        ));
        assert_eq!(active_count(&windows, server_a).await, 1);
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
            1
        );

        windows
            .bind_server("first", bind_request(first.version, Some(server_b)))
            .await
            .unwrap();
        assert_eq!(active_count(&windows, server_a).await, 0);
        assert_eq!(active_count(&windows, server_b).await, 1);

        windows
            .bind_server("second", bind_request(second.version, Some(server_a)))
            .await
            .unwrap();
        windows.deactivate("second").await.unwrap();
        assert_eq!(active_count(&windows, server_a).await, 0);
        let restored = windows.load_and_activate("second").await.unwrap();
        assert_eq!(restored.server_id, Some(server_a));
        assert_eq!(active_count(&windows, server_a).await, 1);
    }

    #[tokio::test]
    async fn reserved_new_window_keeps_an_explicit_thread_during_initial_load() {
        let (windows, configuration) = repositories().await;
        let server = create_server(&configuration, "A").await;

        let reserved = windows
            .reserve_new_window("secondary", server, Some("thread-a"))
            .await
            .unwrap();

        assert_eq!(reserved.server_id, Some(server));
        assert_eq!(reserved.tabs.len(), 1);
        assert_eq!(reserved.tabs[0].thread_id.as_deref(), Some("thread-a"));
        assert_eq!(
            reserved.active_tab_id.as_deref(),
            Some(reserved.tabs[0].id.as_str())
        );
        assert_eq!(active_count(&windows, server).await, 1);
        let restored = windows.load_and_activate("secondary").await.unwrap();
        assert_eq!(restored.tabs, reserved.tabs);
        assert_eq!(restored.active_tab_id, reserved.active_tab_id);

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
    async fn opening_a_target_activates_an_existing_tab_or_appends_a_new_one() {
        let (windows, configuration) = repositories().await;
        let server = create_server(&configuration, "A").await;
        let initial = windows.load_and_activate("main").await.unwrap();
        let bound = windows
            .bind_server("main", bind_request(initial.version, Some(server)))
            .await
            .unwrap();
        let original_tab_id = bound.tabs[0].id.clone();

        let thread_a = windows
            .open_tab_for_server("main", server, Some("thread-a"))
            .await
            .unwrap();
        let thread_a_tab_id = thread_a.active_tab_id.clone().unwrap();
        assert_eq!(thread_a.tabs.len(), 2);
        assert_eq!(
            thread_a.tabs.last().unwrap().thread_id.as_deref(),
            Some("thread-a")
        );

        let blank = windows
            .open_tab_for_server("main", server, None)
            .await
            .unwrap();
        assert_eq!(blank.tabs.len(), 3);
        assert_eq!(blank.tabs.last().unwrap().thread_id, None);

        let reactivated = windows
            .open_tab_for_server("main", server, Some("thread-a"))
            .await
            .unwrap();
        assert_eq!(reactivated.tabs.len(), 3);
        assert_eq!(
            reactivated.active_tab_id.as_deref(),
            Some(thread_a_tab_id.as_str())
        );
        assert_eq!(reactivated.tabs[0].id, original_tab_id);
    }

    #[tokio::test]
    async fn startup_clears_stale_references_and_replaces_tabs_with_a_blank_tab() {
        let (windows, configuration) = repositories().await;
        let server = create_server(&configuration, "A").await;
        let initial = windows.load_and_activate("main").await.unwrap();
        let bound = windows
            .bind_server("main", bind_request(initial.version, Some(server)))
            .await
            .unwrap();
        let with_thread = windows
            .update_tabs(
                "main",
                tabs_request(
                    bound.version,
                    vec![tab("tab-open", Some("thread-a"))],
                    "tab-open",
                ),
            )
            .await
            .unwrap();
        assert_eq!(active_count(&windows, server).await, 1);

        windows.initialize().await.unwrap();

        assert_eq!(active_count(&windows, server).await, 0);
        let restored = windows.load_and_activate("main").await.unwrap();
        assert_eq!(restored.server_id, Some(server));
        assert_eq!(restored.version, with_thread.version);
        assert_eq!(restored.tabs.len(), 1);
        assert_eq!(restored.tabs[0].thread_id, None);
        assert_ne!(restored.tabs[0].id, "tab-open");
        assert_eq!(
            restored.active_tab_id.as_deref(),
            Some(restored.tabs[0].id.as_str())
        );
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
    async fn a_closed_window_does_not_block_deletion_and_its_binding_is_cleared() {
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
        assert!(restored.tabs.is_empty());
        assert_eq!(restored.active_tab_id, None);
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
    async fn rejects_tab_values_without_a_bound_server_or_outside_contract_limits() {
        let (windows, configuration) = repositories().await;
        let initial = windows.load_and_activate("main").await.unwrap();

        assert!(matches!(
            windows
                .update_tabs(
                    "main",
                    tabs_request(
                        initial.version,
                        vec![tab("tab-a", Some("thread-a"))],
                        "tab-a",
                    ),
                )
                .await,
            Err(WindowStateRepositoryError::TabsWithoutServer)
        ));
        let server = create_server(&configuration, "A").await;
        let bound = windows
            .bind_server("main", bind_request(initial.version, Some(server)))
            .await
            .unwrap();
        assert!(matches!(
            windows
                .update_tabs(
                    "main",
                    tabs_request(
                        bound.version,
                        vec![tab("tab-a", Some(&"a".repeat(1_025)))],
                        "tab-a",
                    ),
                )
                .await,
            Err(WindowStateRepositoryError::InvalidThreadId)
        ));
        assert!(matches!(
            windows
                .update_tabs(
                    "main",
                    tabs_request(
                        bound.version,
                        vec![
                            tab("tab-a", Some("thread-a")),
                            tab("tab-b", Some("thread-a")),
                        ],
                        "tab-a",
                    ),
                )
                .await,
            Err(WindowStateRepositoryError::InvalidTabs)
        ));
    }

    #[test]
    fn nullable_request_field_must_be_explicit() {
        assert!(
            serde_json::from_value::<BindWindowServerRequest>(json!({
                "expectedVersion": 1
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<UpdateWindowTabsRequest>(json!({
                "expectedVersion": 1
            }))
            .is_err()
        );
    }
}
