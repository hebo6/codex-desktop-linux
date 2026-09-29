use std::{error::Error, fmt};

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::State;

use crate::configuration::ServerId;

const MAX_PROTOCOL_ID_BYTES: usize = 1024;

#[derive(Clone)]
pub(crate) struct AsyncQuestionResponseRepository {
    pool: SqlitePool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AsyncQuestionResponsesRequest {
    server_id: ServerId,
    thread_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordAsyncQuestionResponseRequest {
    server_id: ServerId,
    thread_id: String,
    response: AsyncQuestionResponse,
}

#[derive(Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AsyncQuestionResponse {
    question_key: String,
    disposition: AsyncQuestionDisposition,
}

#[derive(Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum AsyncQuestionDisposition {
    Sent,
    Ignored,
}

impl AsyncQuestionDisposition {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Sent => "sent",
            Self::Ignored => "ignored",
        }
    }
}

#[derive(Debug)]
enum AsyncQuestionResponseError {
    Invalid,
    Corrupt,
    Database(sqlx::Error),
}

impl fmt::Display for AsyncQuestionResponseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid => formatter.write_str("The async question response request is invalid"),
            Self::Corrupt => {
                formatter.write_str("The persisted async question response is corrupt")
            }
            Self::Database(_) => {
                formatter.write_str("The async question response database operation failed")
            }
        }
    }
}

impl Error for AsyncQuestionResponseError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Database(source) => Some(source),
            _ => None,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AsyncQuestionResponseCommandError {
    code: &'static str,
    message: &'static str,
}

impl From<AsyncQuestionResponseError> for AsyncQuestionResponseCommandError {
    fn from(error: AsyncQuestionResponseError) -> Self {
        match error {
            AsyncQuestionResponseError::Invalid => Self {
                code: "invalidRequest",
                message: "异步提问处理记录请求无效",
            },
            AsyncQuestionResponseError::Corrupt | AsyncQuestionResponseError::Database(_) => Self {
                code: "storageUnavailable",
                message: "异步提问处理记录存储暂时不可用",
            },
        }
    }
}

impl AsyncQuestionResponseRepository {
    pub(crate) fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    async fn list(
        &self,
        request: AsyncQuestionResponsesRequest,
    ) -> Result<Vec<AsyncQuestionResponse>, AsyncQuestionResponseError> {
        validate_thread_id(&request.thread_id)?;
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT question_key, disposition
             FROM async_question_responses
             WHERE server_id = ? AND thread_id = ?
             ORDER BY question_key",
        )
        .bind(request.server_id.to_persisted_string())
        .bind(request.thread_id)
        .fetch_all(&self.pool)
        .await
        .map_err(AsyncQuestionResponseError::Database)?;
        rows.into_iter()
            .map(|(question_key, disposition)| {
                if question_key.is_empty() {
                    return Err(AsyncQuestionResponseError::Corrupt);
                }
                let disposition = match disposition.as_str() {
                    "sent" => AsyncQuestionDisposition::Sent,
                    "ignored" => AsyncQuestionDisposition::Ignored,
                    _ => return Err(AsyncQuestionResponseError::Corrupt),
                };
                Ok(AsyncQuestionResponse {
                    question_key,
                    disposition,
                })
            })
            .collect()
    }

    async fn record(
        &self,
        request: RecordAsyncQuestionResponseRequest,
    ) -> Result<(), AsyncQuestionResponseError> {
        validate_thread_id(&request.thread_id)?;
        if request.response.question_key.is_empty() {
            return Err(AsyncQuestionResponseError::Invalid);
        }
        sqlx::query(
            "INSERT INTO async_question_responses (
                server_id, thread_id, question_key, disposition
             ) VALUES (?, ?, ?, ?)
             ON CONFLICT (server_id, thread_id, question_key) DO UPDATE SET
                disposition = excluded.disposition",
        )
        .bind(request.server_id.to_persisted_string())
        .bind(request.thread_id)
        .bind(request.response.question_key)
        .bind(request.response.disposition.as_str())
        .execute(&self.pool)
        .await
        .map_err(AsyncQuestionResponseError::Database)?;
        Ok(())
    }
}

fn validate_thread_id(value: &str) -> Result<(), AsyncQuestionResponseError> {
    if value.is_empty()
        || value.len() > MAX_PROTOCOL_ID_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(AsyncQuestionResponseError::Invalid);
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn list_async_question_responses(
    repository: State<'_, AsyncQuestionResponseRepository>,
    request: AsyncQuestionResponsesRequest,
) -> Result<Vec<AsyncQuestionResponse>, AsyncQuestionResponseCommandError> {
    repository.list(request).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn record_async_question_response(
    repository: State<'_, AsyncQuestionResponseRepository>,
    request: RecordAsyncQuestionResponseRequest,
) -> Result<(), AsyncQuestionResponseCommandError> {
    repository.record(request).await.map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::{
        AsyncQuestionDisposition, AsyncQuestionResponse, AsyncQuestionResponseError,
        AsyncQuestionResponseRepository, AsyncQuestionResponsesRequest,
        RecordAsyncQuestionResponseRequest,
    };
    use crate::configuration::ServerId;

    const SERVER_ID: &str = "11111111-1111-4111-8111-111111111111";
    const OTHER_SERVER_ID: &str = "22222222-2222-4222-8222-222222222222";

    async fn repository() -> AsyncQuestionResponseRepository {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(":memory:")
                    .foreign_keys(true)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        for server_id in [SERVER_ID, OTHER_SERVER_ID] {
            sqlx::query(
                "INSERT INTO servers (server_id, name, server_type)
                 VALUES (?, ?, 'local')",
            )
            .bind(server_id)
            .bind(server_id)
            .execute(&pool)
            .await
            .unwrap();
        }
        AsyncQuestionResponseRepository::new(pool)
    }

    fn list_request(server_id: &str, thread_id: &str) -> AsyncQuestionResponsesRequest {
        AsyncQuestionResponsesRequest {
            server_id: ServerId::parse_persisted(server_id).unwrap(),
            thread_id: thread_id.to_owned(),
        }
    }

    fn record_request(
        server_id: &str,
        thread_id: &str,
        question_key: &str,
        disposition: AsyncQuestionDisposition,
    ) -> RecordAsyncQuestionResponseRequest {
        RecordAsyncQuestionResponseRequest {
            server_id: ServerId::parse_persisted(server_id).unwrap(),
            thread_id: thread_id.to_owned(),
            response: AsyncQuestionResponse {
                question_key: question_key.to_owned(),
                disposition,
            },
        }
    }

    #[tokio::test]
    async fn scopes_responses_to_server_thread_and_question() {
        let repository = repository().await;
        for (server_id, thread_id, question_key, disposition) in [
            (
                SERVER_ID,
                "thread-1",
                "question-1",
                AsyncQuestionDisposition::Ignored,
            ),
            (
                SERVER_ID,
                "thread-1",
                "question-2",
                AsyncQuestionDisposition::Ignored,
            ),
            (
                SERVER_ID,
                "thread-2",
                "question-1",
                AsyncQuestionDisposition::Ignored,
            ),
            (
                OTHER_SERVER_ID,
                "thread-1",
                "question-1",
                AsyncQuestionDisposition::Ignored,
            ),
            (
                SERVER_ID,
                "thread-1",
                "question-1",
                AsyncQuestionDisposition::Sent,
            ),
        ] {
            repository
                .record(record_request(
                    server_id,
                    thread_id,
                    question_key,
                    disposition,
                ))
                .await
                .unwrap();
        }

        let reloaded = AsyncQuestionResponseRepository::new(repository.pool.clone());
        assert_eq!(
            reloaded
                .list(list_request(SERVER_ID, "thread-1"))
                .await
                .unwrap(),
            vec![
                AsyncQuestionResponse {
                    question_key: "question-1".to_owned(),
                    disposition: AsyncQuestionDisposition::Sent,
                },
                AsyncQuestionResponse {
                    question_key: "question-2".to_owned(),
                    disposition: AsyncQuestionDisposition::Ignored,
                },
            ],
        );
        for (server_id, thread_id) in [(SERVER_ID, "thread-2"), (OTHER_SERVER_ID, "thread-1")] {
            assert_eq!(
                reloaded
                    .list(list_request(server_id, thread_id))
                    .await
                    .unwrap(),
                vec![AsyncQuestionResponse {
                    question_key: "question-1".to_owned(),
                    disposition: AsyncQuestionDisposition::Ignored,
                }],
            );
        }
    }

    #[tokio::test]
    async fn deletes_responses_when_server_is_removed() {
        let repository = repository().await;
        repository
            .record(record_request(
                SERVER_ID,
                "thread-1",
                "question-1",
                AsyncQuestionDisposition::Sent,
            ))
            .await
            .unwrap();
        sqlx::query("DELETE FROM servers WHERE server_id = ?")
            .bind(SERVER_ID)
            .execute(&repository.pool)
            .await
            .unwrap();

        assert!(
            repository
                .list(list_request(SERVER_ID, "thread-1"))
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn rejects_invalid_identifiers_without_writing_records() {
        let repository = repository().await;
        for (thread_id, question_key) in [
            ("", "question-1"),
            ("thread\n1", "question-1"),
            ("thread-1", ""),
        ] {
            assert!(matches!(
                repository
                    .record(record_request(
                        SERVER_ID,
                        thread_id,
                        question_key,
                        AsyncQuestionDisposition::Sent,
                    ))
                    .await,
                Err(AsyncQuestionResponseError::Invalid),
            ));
        }
        assert!(matches!(
            repository.list(list_request(SERVER_ID, "")).await,
            Err(AsyncQuestionResponseError::Invalid),
        ));
        assert!(
            repository
                .list(list_request(SERVER_ID, "thread-1"))
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn rejects_unknown_dispositions_and_answer_text() {
        for response in [
            json!({"questionKey":"question-1","disposition":"answered"}),
            json!({"questionKey":"question-1","disposition":"sent","answer":"answer text"}),
        ] {
            assert!(
                serde_json::from_value::<RecordAsyncQuestionResponseRequest>(json!({
                    "serverId":SERVER_ID,
                    "threadId":"thread-1",
                    "response":response,
                }))
                .is_err()
            );
        }
    }
}
