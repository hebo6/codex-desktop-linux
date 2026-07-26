use std::{
    error::Error,
    fmt,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::State;

use crate::configuration::ServerId;

const MAX_PROTOCOL_ID_BYTES: usize = 1024;

#[derive(Clone)]
pub(crate) struct PendingThreadResultRepository {
    pool: SqlitePool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PendingThreadResultsRequest {
    server_id: ServerId,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PendingThreadResultRequest {
    server_id: ServerId,
    thread_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PendingThreadResultTurnRequest {
    server_id: ServerId,
    thread_id: String,
    turn_id: String,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingThreadResult {
    thread_id: String,
    turn_id: String,
}

#[derive(Debug)]
enum PendingThreadResultError {
    Invalid,
    Corrupt,
    Clock,
    Database(sqlx::Error),
}

impl fmt::Display for PendingThreadResultError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid => formatter.write_str("The pending thread result request is invalid"),
            Self::Corrupt => formatter.write_str("The persisted pending thread result is corrupt"),
            Self::Clock => formatter.write_str("The system clock is unavailable"),
            Self::Database(_) => {
                formatter.write_str("The pending thread result database operation failed")
            }
        }
    }
}

impl Error for PendingThreadResultError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Database(source) => Some(source),
            _ => None,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingThreadResultCommandError {
    code: &'static str,
    message: &'static str,
}

impl From<PendingThreadResultError> for PendingThreadResultCommandError {
    fn from(error: PendingThreadResultError) -> Self {
        match error {
            PendingThreadResultError::Invalid => Self {
                code: "invalidRequest",
                message: "待查看结果请求无效",
            },
            PendingThreadResultError::Corrupt
            | PendingThreadResultError::Clock
            | PendingThreadResultError::Database(_) => Self {
                code: "storageUnavailable",
                message: "待查看结果存储暂时不可用",
            },
        }
    }
}

impl PendingThreadResultRepository {
    pub(crate) fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    async fn list(
        &self,
        request: PendingThreadResultsRequest,
    ) -> Result<Vec<PendingThreadResult>, PendingThreadResultError> {
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT thread_id, turn_id
             FROM pending_thread_results
             WHERE server_id = ?
             ORDER BY updated_at_ms DESC",
        )
        .bind(request.server_id.to_persisted_string())
        .fetch_all(&self.pool)
        .await
        .map_err(PendingThreadResultError::Database)?;
        rows.into_iter()
            .map(|(thread_id, turn_id)| {
                validate_protocol_id(&thread_id)
                    .and_then(|()| validate_protocol_id(&turn_id))
                    .map_err(|_| PendingThreadResultError::Corrupt)?;
                Ok(PendingThreadResult { thread_id, turn_id })
            })
            .collect()
    }

    async fn record(
        &self,
        request: PendingThreadResultTurnRequest,
    ) -> Result<(), PendingThreadResultError> {
        validate_protocol_id(&request.thread_id)?;
        validate_protocol_id(&request.turn_id)?;
        sqlx::query(
            "INSERT INTO pending_thread_results (
                server_id, thread_id, turn_id, updated_at_ms
             ) VALUES (?, ?, ?, ?)
             ON CONFLICT (server_id, thread_id) DO UPDATE SET
                turn_id = excluded.turn_id,
                updated_at_ms = excluded.updated_at_ms",
        )
        .bind(request.server_id.to_persisted_string())
        .bind(request.thread_id)
        .bind(request.turn_id)
        .bind(now_ms()?)
        .execute(&self.pool)
        .await
        .map_err(PendingThreadResultError::Database)?;
        Ok(())
    }

    async fn acknowledge(
        &self,
        request: PendingThreadResultTurnRequest,
    ) -> Result<(), PendingThreadResultError> {
        validate_protocol_id(&request.thread_id)?;
        validate_protocol_id(&request.turn_id)?;
        sqlx::query(
            "DELETE FROM pending_thread_results
             WHERE server_id = ? AND thread_id = ? AND turn_id = ?",
        )
        .bind(request.server_id.to_persisted_string())
        .bind(request.thread_id)
        .bind(request.turn_id)
        .execute(&self.pool)
        .await
        .map_err(PendingThreadResultError::Database)?;
        Ok(())
    }

    async fn clear(
        &self,
        request: PendingThreadResultRequest,
    ) -> Result<(), PendingThreadResultError> {
        validate_protocol_id(&request.thread_id)?;
        sqlx::query(
            "DELETE FROM pending_thread_results
             WHERE server_id = ? AND thread_id = ?",
        )
        .bind(request.server_id.to_persisted_string())
        .bind(request.thread_id)
        .execute(&self.pool)
        .await
        .map_err(PendingThreadResultError::Database)?;
        Ok(())
    }
}

fn validate_protocol_id(value: &str) -> Result<(), PendingThreadResultError> {
    if value.is_empty()
        || value.len() > MAX_PROTOCOL_ID_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(PendingThreadResultError::Invalid);
    }
    Ok(())
}

fn now_ms() -> Result<i64, PendingThreadResultError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| PendingThreadResultError::Clock)?;
    i64::try_from(duration.as_millis()).map_err(|_| PendingThreadResultError::Clock)
}

#[tauri::command]
pub(crate) async fn list_pending_thread_results(
    repository: State<'_, PendingThreadResultRepository>,
    request: PendingThreadResultsRequest,
) -> Result<Vec<PendingThreadResult>, PendingThreadResultCommandError> {
    repository.list(request).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn record_pending_thread_result(
    repository: State<'_, PendingThreadResultRepository>,
    request: PendingThreadResultTurnRequest,
) -> Result<(), PendingThreadResultCommandError> {
    repository.record(request).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn acknowledge_pending_thread_result(
    repository: State<'_, PendingThreadResultRepository>,
    request: PendingThreadResultTurnRequest,
) -> Result<(), PendingThreadResultCommandError> {
    repository.acknowledge(request).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn clear_pending_thread_result(
    repository: State<'_, PendingThreadResultRepository>,
    request: PendingThreadResultRequest,
) -> Result<(), PendingThreadResultCommandError> {
    repository.clear(request).await.map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::{
        PendingThreadResult, PendingThreadResultRepository, PendingThreadResultRequest,
        PendingThreadResultTurnRequest, PendingThreadResultsRequest,
    };
    use crate::configuration::ServerId;

    const SERVER_ID: &str = "11111111-1111-4111-8111-111111111111";

    async fn repository() -> PendingThreadResultRepository {
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
        sqlx::query(
            "INSERT INTO servers (
                server_id, name, server_type, version,
                display_preferences_json, created_at_ms, updated_at_ms
             ) VALUES (?, '测试服务器', 'local', 1, '{}', 1, 1)",
        )
        .bind(SERVER_ID)
        .execute(&pool)
        .await
        .unwrap();
        PendingThreadResultRepository::new(pool)
    }

    fn server_id() -> ServerId {
        ServerId::parse_persisted(SERVER_ID).unwrap()
    }

    fn turn_request(thread_id: &str, turn_id: &str) -> PendingThreadResultTurnRequest {
        PendingThreadResultTurnRequest {
            server_id: server_id(),
            thread_id: thread_id.to_owned(),
            turn_id: turn_id.to_owned(),
        }
    }

    #[tokio::test]
    async fn records_latest_result_and_acknowledges_exact_turn() {
        let repository = repository().await;
        repository
            .record(turn_request("thread-1", "turn-1"))
            .await
            .unwrap();
        repository
            .record(turn_request("thread-1", "turn-2"))
            .await
            .unwrap();

        repository
            .acknowledge(turn_request("thread-1", "turn-1"))
            .await
            .unwrap();
        assert_eq!(
            repository
                .list(PendingThreadResultsRequest {
                    server_id: server_id(),
                })
                .await
                .unwrap(),
            vec![PendingThreadResult {
                thread_id: "thread-1".to_owned(),
                turn_id: "turn-2".to_owned(),
            }],
        );

        repository
            .acknowledge(turn_request("thread-1", "turn-2"))
            .await
            .unwrap();
        assert!(
            repository
                .list(PendingThreadResultsRequest {
                    server_id: server_id(),
                })
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn clears_thread_result_without_matching_turn() {
        let repository = repository().await;
        repository
            .record(turn_request("thread-1", "turn-1"))
            .await
            .unwrap();

        repository
            .clear(PendingThreadResultRequest {
                server_id: server_id(),
                thread_id: "thread-1".to_owned(),
            })
            .await
            .unwrap();

        assert!(
            repository
                .list(PendingThreadResultsRequest {
                    server_id: server_id(),
                })
                .await
                .unwrap()
                .is_empty()
        );
    }
}
