use std::{
    error::Error,
    fmt,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;
use tauri::State;

const MAX_DRAFT_KEY_BYTES: usize = 512;
const MAX_DRAFT_BYTES: usize = 1024 * 1024;

#[derive(Clone)]
pub(crate) struct DraftRepository {
    pool: SqlitePool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DraftKeyRequest {
    draft_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DraftKeyPrefixRequest {
    key_prefix: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveDraftRequest {
    draft_key: String,
    draft: Value,
}

#[derive(Debug)]
enum DraftError {
    Invalid,
    Corrupt,
    Clock,
    Database(sqlx::Error),
}

impl fmt::Display for DraftError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid => formatter.write_str("The draft request is invalid"),
            Self::Corrupt => formatter.write_str("The persisted draft is corrupt"),
            Self::Clock => formatter.write_str("The system clock is unavailable"),
            Self::Database(_) => formatter.write_str("The draft database operation failed"),
        }
    }
}

impl Error for DraftError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Database(source) => Some(source),
            _ => None,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DraftCommandError {
    code: &'static str,
    message: &'static str,
}

impl From<DraftError> for DraftCommandError {
    fn from(error: DraftError) -> Self {
        match error {
            DraftError::Invalid => Self {
                code: "invalidRequest",
                message: "草稿请求无效",
            },
            DraftError::Corrupt | DraftError::Clock | DraftError::Database(_) => Self {
                code: "storageUnavailable",
                message: "草稿存储暂时不可用",
            },
        }
    }
}

impl DraftRepository {
    pub(crate) fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    async fn load(&self, request: DraftKeyRequest) -> Result<Option<Value>, DraftError> {
        validate_draft_key(&request.draft_key)?;
        let stored: Option<String> =
            sqlx::query_scalar("SELECT draft_json FROM drafts WHERE draft_key = ?")
                .bind(request.draft_key)
                .fetch_optional(&self.pool)
                .await
                .map_err(DraftError::Database)?;
        stored
            .map(|serialized| {
                let draft =
                    serde_json::from_str::<Value>(&serialized).map_err(|_| DraftError::Corrupt)?;
                draft
                    .is_object()
                    .then_some(draft)
                    .ok_or(DraftError::Corrupt)
            })
            .transpose()
    }

    async fn list_keys(
        &self,
        request: DraftKeyPrefixRequest,
    ) -> Result<Vec<String>, DraftError> {
        validate_draft_key(&request.key_prefix)?;
        sqlx::query_scalar(
            "SELECT draft_key FROM drafts
             WHERE substr(draft_key, 1, length(?)) = ?
               AND (
                 (json_type(draft_json, '$.text') = 'text'
                   AND length(json_extract(draft_json, '$.text')) > 0)
                 OR (json_type(draft_json, '$.tokens') = 'array'
                   AND json_array_length(draft_json, '$.tokens') > 0)
               )
             ORDER BY updated_at_ms DESC",
        )
        .bind(&request.key_prefix)
        .bind(request.key_prefix)
        .fetch_all(&self.pool)
        .await
        .map_err(DraftError::Database)
    }

    async fn save(&self, request: SaveDraftRequest) -> Result<(), DraftError> {
        validate_draft_key(&request.draft_key)?;
        if !request.draft.is_object() {
            return Err(DraftError::Invalid);
        }
        let serialized = serde_json::to_string(&request.draft).map_err(|_| DraftError::Invalid)?;
        if serialized.len() > MAX_DRAFT_BYTES {
            return Err(DraftError::Invalid);
        }
        sqlx::query(
            "INSERT INTO drafts (draft_key, draft_json, updated_at_ms) VALUES (?, ?, ?)
             ON CONFLICT (draft_key) DO UPDATE SET
               draft_json = excluded.draft_json,
               updated_at_ms = excluded.updated_at_ms",
        )
        .bind(request.draft_key)
        .bind(serialized)
        .bind(now_ms()?)
        .execute(&self.pool)
        .await
        .map_err(DraftError::Database)?;
        Ok(())
    }

    async fn delete(&self, request: DraftKeyRequest) -> Result<(), DraftError> {
        validate_draft_key(&request.draft_key)?;
        sqlx::query("DELETE FROM drafts WHERE draft_key = ?")
            .bind(request.draft_key)
            .execute(&self.pool)
            .await
            .map_err(DraftError::Database)?;
        Ok(())
    }
}

fn validate_draft_key(key: &str) -> Result<(), DraftError> {
    if key.is_empty() || key.len() > MAX_DRAFT_KEY_BYTES || key.chars().any(char::is_control) {
        return Err(DraftError::Invalid);
    }
    Ok(())
}

fn now_ms() -> Result<i64, DraftError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| DraftError::Clock)?;
    i64::try_from(duration.as_millis()).map_err(|_| DraftError::Clock)
}

#[tauri::command]
pub(crate) async fn list_draft_keys(
    repository: State<'_, DraftRepository>,
    request: DraftKeyPrefixRequest,
) -> Result<Vec<String>, DraftCommandError> {
    repository.list_keys(request).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn load_draft(
    repository: State<'_, DraftRepository>,
    request: DraftKeyRequest,
) -> Result<Option<Value>, DraftCommandError> {
    repository.load(request).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn save_draft(
    repository: State<'_, DraftRepository>,
    request: SaveDraftRequest,
) -> Result<(), DraftCommandError> {
    repository.save(request).await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn delete_draft(
    repository: State<'_, DraftRepository>,
    request: DraftKeyRequest,
) -> Result<(), DraftCommandError> {
    repository.delete(request).await.map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::{
        DraftError, DraftKeyPrefixRequest, DraftKeyRequest, DraftRepository, SaveDraftRequest,
    };

    async fn repository() -> DraftRepository {
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
        DraftRepository::new(pool)
    }

    #[tokio::test]
    async fn round_trips_and_deletes_draft() {
        let repository = repository().await;
        repository
            .save(SaveDraftRequest {
                draft_key: "window:server:draft".to_owned(),
                draft: json!({"text":"继续实现","tokens":[]}),
            })
            .await
            .unwrap();
        repository
            .save(SaveDraftRequest {
                draft_key: "other:server:draft".to_owned(),
                draft: json!({"text":"其他窗口","tokens":[]}),
            })
            .await
            .unwrap();
        repository
            .save(SaveDraftRequest {
                draft_key: "window:server:empty".to_owned(),
                draft: json!({"text":"","tokens":[]}),
            })
            .await
            .unwrap();
        assert_eq!(
            repository
                .list_keys(DraftKeyPrefixRequest {
                    key_prefix: "window:server:".to_owned(),
                })
                .await
                .unwrap(),
            vec!["window:server:draft"],
        );
        assert_eq!(
            repository
                .load(DraftKeyRequest {
                    draft_key: "window:server:draft".to_owned()
                })
                .await
                .unwrap(),
            Some(json!({"text":"继续实现","tokens":[]})),
        );
        repository
            .delete(DraftKeyRequest {
                draft_key: "window:server:draft".to_owned(),
            })
            .await
            .unwrap();
        assert_eq!(
            repository
                .load(DraftKeyRequest {
                    draft_key: "window:server:draft".to_owned()
                })
                .await
                .unwrap(),
            None,
        );
    }

    #[tokio::test]
    async fn rejects_invalid_key_and_oversized_draft() {
        let repository = repository().await;
        assert!(matches!(
            repository
                .load(DraftKeyRequest {
                    draft_key: "bad\nkey".to_owned()
                })
                .await,
            Err(DraftError::Invalid),
        ));
        assert!(matches!(
            repository
                .save(SaveDraftRequest {
                    draft_key: "valid".to_owned(),
                    draft: json!({"text":"x".repeat(1024 * 1024),"tokens":[]}),
                })
                .await,
            Err(DraftError::Invalid),
        ));
    }
}
