use std::{
    error::Error,
    fmt,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Row, SqlitePool};
use tauri::State;

use crate::configuration::ServerId;

const MAX_THREAD_ID_BYTES: usize = 1_024;
const MAX_THREAD_LIST_BYTES: usize = 8 * 1024 * 1024;
const MAX_THREAD_PROJECTION_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone)]
pub(crate) struct OfflineCacheRepository {
    pool: SqlitePool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LoadThreadCacheRequest {
    server_id: ServerId,
    current_thread_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveThreadCacheRequest {
    server_id: ServerId,
    threads: Value,
    next_thread_cursor: Option<String>,
    current_thread_id: Option<String>,
    restored_thread: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadCacheSnapshot {
    threads: Value,
    next_thread_cursor: Option<String>,
    restored_thread: Option<Value>,
    synced_at_ms: i64,
}

#[derive(Debug)]
pub(crate) enum OfflineCacheError {
    InvalidThreadId,
    InvalidThreadList,
    InvalidProjection,
    ProjectionWithoutThread,
    Clock,
    Corrupt,
    Database(sqlx::Error),
}

impl fmt::Display for OfflineCacheError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidThreadId => formatter.write_str("The cached thread ID is invalid"),
            Self::InvalidThreadList => formatter.write_str("The cached thread list is invalid"),
            Self::InvalidProjection => {
                formatter.write_str("The cached thread projection is invalid")
            }
            Self::ProjectionWithoutThread => {
                formatter.write_str("A cached projection requires a thread ID")
            }
            Self::Clock => formatter.write_str("The system clock is unavailable"),
            Self::Corrupt => formatter.write_str("The persisted thread cache is corrupt"),
            Self::Database(_) => formatter.write_str("The thread cache database operation failed"),
        }
    }
}

impl Error for OfflineCacheError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Database(source) => Some(source),
            _ => None,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OfflineCacheCommandError {
    code: &'static str,
    message: &'static str,
}

impl From<OfflineCacheError> for OfflineCacheCommandError {
    fn from(error: OfflineCacheError) -> Self {
        match error {
            OfflineCacheError::InvalidThreadId
            | OfflineCacheError::InvalidThreadList
            | OfflineCacheError::InvalidProjection
            | OfflineCacheError::ProjectionWithoutThread => Self {
                code: "invalidRequest",
                message: "离线缓存请求无效",
            },
            OfflineCacheError::Clock
            | OfflineCacheError::Corrupt
            | OfflineCacheError::Database(_) => Self {
                code: "cacheUnavailable",
                message: "离线缓存暂时不可用",
            },
        }
    }
}

impl OfflineCacheRepository {
    pub(crate) fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    async fn load(
        &self,
        request: LoadThreadCacheRequest,
    ) -> Result<Option<ThreadCacheSnapshot>, OfflineCacheError> {
        validate_optional_thread_id(request.current_thread_id.as_deref())?;
        let server_id = request.server_id.to_persisted_string();
        let list = sqlx::query(
            "SELECT threads_json, next_cursor, synced_at_ms
             FROM thread_list_caches WHERE server_id = ?",
        )
        .bind(&server_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(OfflineCacheError::Database)?;
        let Some(list) = list else {
            return Ok(None);
        };
        let threads_json = list
            .try_get::<String, _>("threads_json")
            .map_err(|_| OfflineCacheError::Corrupt)?;
        let threads =
            serde_json::from_str::<Value>(&threads_json).map_err(|_| OfflineCacheError::Corrupt)?;
        if !threads.is_array() {
            return Err(OfflineCacheError::Corrupt);
        }
        let list_synced_at = list
            .try_get::<i64, _>("synced_at_ms")
            .map_err(|_| OfflineCacheError::Corrupt)?;
        let next_thread_cursor = list
            .try_get::<Option<String>, _>("next_cursor")
            .map_err(|_| OfflineCacheError::Corrupt)?;

        let projection = match request.current_thread_id {
            Some(thread_id) => sqlx::query(
                "SELECT projection_json, synced_at_ms
                 FROM thread_projection_caches WHERE server_id = ? AND thread_id = ?",
            )
            .bind(&server_id)
            .bind(thread_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(OfflineCacheError::Database)?,
            None => None,
        };
        let (restored_thread, synced_at_ms) = match projection {
            Some(row) => {
                let json = row
                    .try_get::<String, _>("projection_json")
                    .map_err(|_| OfflineCacheError::Corrupt)?;
                let value =
                    serde_json::from_str::<Value>(&json).map_err(|_| OfflineCacheError::Corrupt)?;
                if !value.is_object() {
                    return Err(OfflineCacheError::Corrupt);
                }
                let projection_synced_at = row
                    .try_get::<i64, _>("synced_at_ms")
                    .map_err(|_| OfflineCacheError::Corrupt)?;
                (Some(value), list_synced_at.max(projection_synced_at))
            }
            None => (None, list_synced_at),
        };
        Ok(Some(ThreadCacheSnapshot {
            threads,
            next_thread_cursor,
            restored_thread,
            synced_at_ms,
        }))
    }

    async fn save(&self, request: SaveThreadCacheRequest) -> Result<(), OfflineCacheError> {
        validate_optional_thread_id(request.current_thread_id.as_deref())?;
        if request.restored_thread.is_some() != request.current_thread_id.is_some() {
            return Err(OfflineCacheError::ProjectionWithoutThread);
        }
        if !request.threads.is_array() {
            return Err(OfflineCacheError::InvalidThreadList);
        }
        let threads_json = serialize_bounded(&request.threads, MAX_THREAD_LIST_BYTES)
            .map_err(|_| OfflineCacheError::InvalidThreadList)?;
        let projection_json = match request.restored_thread {
            Some(projection) if projection.is_object() => Some(
                serialize_bounded(&projection, MAX_THREAD_PROJECTION_BYTES)
                    .map_err(|_| OfflineCacheError::InvalidProjection)?,
            ),
            Some(_) => return Err(OfflineCacheError::InvalidProjection),
            None => None,
        };
        let synced_at_ms = now_ms()?;
        let server_id = request.server_id.to_persisted_string();
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(OfflineCacheError::Database)?;
        sqlx::query(
            "INSERT INTO thread_list_caches (server_id, threads_json, next_cursor, synced_at_ms)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(server_id) DO UPDATE SET
               threads_json = excluded.threads_json,
               next_cursor = excluded.next_cursor,
               synced_at_ms = excluded.synced_at_ms",
        )
        .bind(&server_id)
        .bind(threads_json)
        .bind(request.next_thread_cursor)
        .bind(synced_at_ms)
        .execute(&mut *transaction)
        .await
        .map_err(OfflineCacheError::Database)?;
        if let (Some(thread_id), Some(projection_json)) =
            (request.current_thread_id, projection_json)
        {
            sqlx::query(
                "INSERT INTO thread_projection_caches (server_id, thread_id, projection_json, synced_at_ms)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(server_id, thread_id) DO UPDATE SET
                   projection_json = excluded.projection_json,
                   synced_at_ms = excluded.synced_at_ms",
            )
            .bind(&server_id)
            .bind(thread_id)
            .bind(projection_json)
            .bind(synced_at_ms)
            .execute(&mut *transaction)
            .await
            .map_err(OfflineCacheError::Database)?;
        }
        transaction
            .commit()
            .await
            .map_err(OfflineCacheError::Database)
    }
}

#[tauri::command]
pub(crate) async fn load_thread_cache(
    repository: State<'_, OfflineCacheRepository>,
    request: LoadThreadCacheRequest,
) -> Result<Option<ThreadCacheSnapshot>, OfflineCacheCommandError> {
    repository.load(request).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn save_thread_cache(
    repository: State<'_, OfflineCacheRepository>,
    request: SaveThreadCacheRequest,
) -> Result<(), OfflineCacheCommandError> {
    repository.save(request).await.map_err(Into::into)
}

fn validate_optional_thread_id(thread_id: Option<&str>) -> Result<(), OfflineCacheError> {
    if let Some(value) = thread_id
        && (value.trim().is_empty() || value.len() > MAX_THREAD_ID_BYTES || value.contains('\0'))
    {
        return Err(OfflineCacheError::InvalidThreadId);
    }
    Ok(())
}

fn serialize_bounded(value: &Value, limit: usize) -> Result<String, ()> {
    let serialized = serde_json::to_string(value).map_err(|_| ())?;
    (serialized.len() <= limit).then_some(serialized).ok_or(())
}

fn now_ms() -> Result<i64, OfflineCacheError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| OfflineCacheError::Clock)?;
    i64::try_from(duration.as_millis()).map_err(|_| OfflineCacheError::Clock)
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::{
        LoadThreadCacheRequest, OfflineCacheError, OfflineCacheRepository, SaveThreadCacheRequest,
    };
    use crate::configuration::ServerId;

    async fn repository() -> (OfflineCacheRepository, ServerId) {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(":memory:")
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let server_id = ServerId::parse_persisted("11111111-1111-4111-8111-111111111111")
            .expect("test server ID must be valid");
        sqlx::query(
            "INSERT INTO servers (server_id, name, server_type) VALUES (?, 'test', 'local')",
        )
        .bind(server_id.to_persisted_string())
        .execute(&pool)
        .await
        .unwrap();
        (OfflineCacheRepository::new(pool), server_id)
    }

    #[tokio::test]
    async fn round_trips_list_and_projection() {
        let (repository, server_id) = repository().await;
        repository
            .save(SaveThreadCacheRequest {
                server_id,
                threads: json!([{"id":"thread-1"}]),
                next_thread_cursor: Some("next".to_owned()),
                current_thread_id: Some("thread-1".to_owned()),
                restored_thread: Some(
                    json!({"metadata":{"id":"thread-1"},"turns":[],"nextCursor":null}),
                ),
            })
            .await
            .unwrap();
        let cached = repository
            .load(LoadThreadCacheRequest {
                server_id,
                current_thread_id: Some("thread-1".to_owned()),
            })
            .await
            .unwrap()
            .unwrap();

        assert_eq!(cached.threads, json!([{"id":"thread-1"}]));
        assert_eq!(cached.next_thread_cursor.as_deref(), Some("next"));
        assert!(cached.restored_thread.is_some());
    }

    #[tokio::test]
    async fn rejects_projection_without_thread_identity() {
        let (repository, server_id) = repository().await;
        let result = repository
            .save(SaveThreadCacheRequest {
                server_id,
                threads: json!([]),
                next_thread_cursor: None,
                current_thread_id: None,
                restored_thread: Some(json!({})),
            })
            .await;
        assert!(matches!(
            result,
            Err(OfflineCacheError::ProjectionWithoutThread)
        ));
    }
}
