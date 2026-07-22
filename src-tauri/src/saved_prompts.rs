use std::{
    collections::HashSet,
    error::Error,
    fmt,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sqlx::{Row as _, SqlitePool, error::ErrorKind, sqlite::SqliteRow};
use tauri::{AppHandle, Emitter as _, State};
use uuid::Uuid;

const MAX_NAME_CHARS: usize = 80;
const MAX_CONTENT_CHARS: usize = 32_000;
const SAVED_PROMPTS_CHANGED_EVENT: &str = "saved-prompts-changed";

#[derive(Clone)]
pub(crate) struct SavedPromptRepository {
    pool: SqlitePool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedPrompt {
    prompt_id: String,
    name: String,
    content: String,
    version: i64,
    created_at_ms: i64,
    updated_at_ms: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateSavedPromptRequest {
    name: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateSavedPromptRequest {
    prompt_id: String,
    expected_version: i64,
    name: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeleteSavedPromptRequest {
    prompt_id: String,
    expected_version: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReorderSavedPromptsRequest {
    prompt_ids: Vec<String>,
}

#[derive(Debug)]
enum SavedPromptError {
    Invalid,
    NameConflict,
    NotFound,
    VersionConflict,
    CollectionConflict,
    Clock,
    Corrupt,
    Database(sqlx::Error),
}

impl fmt::Display for SavedPromptError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid => formatter.write_str("The saved prompt request is invalid"),
            Self::NameConflict => formatter.write_str("The saved prompt name already exists"),
            Self::NotFound => formatter.write_str("The saved prompt does not exist"),
            Self::VersionConflict => formatter.write_str("The saved prompt version has changed"),
            Self::CollectionConflict => {
                formatter.write_str("The saved prompt collection has changed")
            }
            Self::Clock => formatter.write_str("The system clock is unavailable"),
            Self::Corrupt => formatter.write_str("The persisted saved prompt is corrupt"),
            Self::Database(_) => formatter.write_str("The saved prompt database operation failed"),
        }
    }
}

impl Error for SavedPromptError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Database(source) => Some(source),
            _ => None,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedPromptCommandError {
    code: &'static str,
    message: &'static str,
}

impl From<SavedPromptError> for SavedPromptCommandError {
    fn from(error: SavedPromptError) -> Self {
        match error {
            SavedPromptError::Invalid => Self {
                code: "invalidRequest",
                message: "常用提示词请求无效",
            },
            SavedPromptError::NameConflict => Self {
                code: "nameConflict",
                message: "常用提示词名称已存在",
            },
            SavedPromptError::NotFound => Self {
                code: "notFound",
                message: "常用提示词不存在",
            },
            SavedPromptError::VersionConflict => Self {
                code: "versionConflict",
                message: "常用提示词已在其他窗口中修改",
            },
            SavedPromptError::CollectionConflict => Self {
                code: "collectionConflict",
                message: "常用提示词列表已在其他窗口中修改",
            },
            SavedPromptError::Clock | SavedPromptError::Corrupt => Self {
                code: "storageUnavailable",
                message: "常用提示词存储暂时不可用",
            },
            SavedPromptError::Database(source) => {
                tracing::error!(error = %source, "saved prompt database operation failed");
                Self {
                    code: "storageUnavailable",
                    message: "常用提示词存储暂时不可用",
                }
            }
        }
    }
}

impl SavedPromptRepository {
    pub(crate) fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    async fn list(&self) -> Result<Vec<SavedPrompt>, SavedPromptError> {
        let rows = sqlx::query(
            "SELECT prompt_id, name, content, version, created_at_ms, updated_at_ms
             FROM saved_prompts
             ORDER BY sort_order, created_at_ms, prompt_id",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(SavedPromptError::Database)?;
        rows.into_iter().map(decode_saved_prompt).collect()
    }

    async fn create(
        &self,
        request: CreateSavedPromptRequest,
    ) -> Result<SavedPrompt, SavedPromptError> {
        let name = validate_name(request.name)?;
        validate_content(&request.content)?;
        let prompt_id = Uuid::new_v4().hyphenated().to_string();
        let now = now_ms()?;
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(SavedPromptError::Database)?;
        let last_order: Option<i64> =
            sqlx::query_scalar("SELECT MAX(sort_order) FROM saved_prompts")
                .fetch_one(&mut *transaction)
                .await
                .map_err(SavedPromptError::Database)?;
        let sort_order = last_order
            .map_or(Some(0), |value| value.checked_add(1))
            .ok_or(SavedPromptError::Corrupt)?;
        sqlx::query(
            "INSERT INTO saved_prompts
               (prompt_id, name, content, sort_order, version, created_at_ms, updated_at_ms)
             VALUES (?, ?, ?, ?, 1, ?, ?)",
        )
        .bind(&prompt_id)
        .bind(&name)
        .bind(&request.content)
        .bind(sort_order)
        .bind(now)
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(map_write_error)?;
        transaction
            .commit()
            .await
            .map_err(SavedPromptError::Database)?;
        Ok(SavedPrompt {
            prompt_id,
            name,
            content: request.content,
            version: 1,
            created_at_ms: now,
            updated_at_ms: now,
        })
    }

    async fn update(
        &self,
        request: UpdateSavedPromptRequest,
    ) -> Result<SavedPrompt, SavedPromptError> {
        validate_prompt_id(&request.prompt_id)?;
        validate_version(request.expected_version)?;
        let name = validate_name(request.name)?;
        validate_content(&request.content)?;
        let row = sqlx::query(
            "UPDATE saved_prompts
             SET name = ?, content = ?, version = version + 1,
                 updated_at_ms = MAX(updated_at_ms, ?)
             WHERE prompt_id = ? AND version = ?
             RETURNING prompt_id, name, content, version, created_at_ms, updated_at_ms",
        )
        .bind(name)
        .bind(request.content)
        .bind(now_ms()?)
        .bind(&request.prompt_id)
        .bind(request.expected_version)
        .fetch_optional(&self.pool)
        .await
        .map_err(map_write_error)?;
        match row {
            Some(row) => decode_saved_prompt(row),
            None => Err(self.missing_or_stale(&request.prompt_id).await?),
        }
    }

    async fn delete(
        &self,
        request: DeleteSavedPromptRequest,
    ) -> Result<(), SavedPromptError> {
        validate_prompt_id(&request.prompt_id)?;
        validate_version(request.expected_version)?;
        let result = sqlx::query("DELETE FROM saved_prompts WHERE prompt_id = ? AND version = ?")
            .bind(&request.prompt_id)
            .bind(request.expected_version)
            .execute(&self.pool)
            .await
            .map_err(SavedPromptError::Database)?;
        if result.rows_affected() == 0 {
            return Err(self.missing_or_stale(&request.prompt_id).await?);
        }
        Ok(())
    }

    async fn reorder(
        &self,
        request: ReorderSavedPromptsRequest,
    ) -> Result<(), SavedPromptError> {
        let requested = request.prompt_ids;
        let unique = requested.iter().collect::<HashSet<_>>();
        if unique.len() != requested.len()
            || requested.iter().any(|prompt_id| validate_prompt_id(prompt_id).is_err())
        {
            return Err(SavedPromptError::Invalid);
        }
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(SavedPromptError::Database)?;
        let current = sqlx::query_scalar::<_, String>("SELECT prompt_id FROM saved_prompts")
            .fetch_all(&mut *transaction)
            .await
            .map_err(SavedPromptError::Database)?;
        if current.len() != requested.len()
            || current.iter().collect::<HashSet<_>>() != unique
        {
            return Err(SavedPromptError::CollectionConflict);
        }
        for (sort_order, prompt_id) in requested.iter().enumerate() {
            sqlx::query("UPDATE saved_prompts SET sort_order = ? WHERE prompt_id = ?")
                .bind(i64::try_from(sort_order).map_err(|_| SavedPromptError::Invalid)?)
                .bind(prompt_id)
                .execute(&mut *transaction)
                .await
                .map_err(SavedPromptError::Database)?;
        }
        transaction
            .commit()
            .await
            .map_err(SavedPromptError::Database)
    }

    async fn missing_or_stale(
        &self,
        prompt_id: &str,
    ) -> Result<SavedPromptError, SavedPromptError> {
        let exists = sqlx::query_scalar::<_, i64>(
            "SELECT EXISTS(SELECT 1 FROM saved_prompts WHERE prompt_id = ?)",
        )
        .bind(prompt_id)
        .fetch_one(&self.pool)
        .await
        .map_err(SavedPromptError::Database)?;
        Ok(if exists == 0 {
            SavedPromptError::NotFound
        } else {
            SavedPromptError::VersionConflict
        })
    }
}

fn decode_saved_prompt(row: SqliteRow) -> Result<SavedPrompt, SavedPromptError> {
    let prompt = SavedPrompt {
        prompt_id: row
            .try_get("prompt_id")
            .map_err(|_| SavedPromptError::Corrupt)?,
        name: row.try_get("name").map_err(|_| SavedPromptError::Corrupt)?,
        content: row
            .try_get("content")
            .map_err(|_| SavedPromptError::Corrupt)?,
        version: row
            .try_get("version")
            .map_err(|_| SavedPromptError::Corrupt)?,
        created_at_ms: row
            .try_get("created_at_ms")
            .map_err(|_| SavedPromptError::Corrupt)?,
        updated_at_ms: row
            .try_get("updated_at_ms")
            .map_err(|_| SavedPromptError::Corrupt)?,
    };
    validate_prompt_id(&prompt.prompt_id).map_err(|_| SavedPromptError::Corrupt)?;
    validate_name(prompt.name.clone()).map_err(|_| SavedPromptError::Corrupt)?;
    validate_content(&prompt.content).map_err(|_| SavedPromptError::Corrupt)?;
    validate_version(prompt.version).map_err(|_| SavedPromptError::Corrupt)?;
    Ok(prompt)
}

fn validate_prompt_id(prompt_id: &str) -> Result<(), SavedPromptError> {
    Uuid::parse_str(prompt_id)
        .map(|_| ())
        .map_err(|_| SavedPromptError::Invalid)
}

fn validate_name(name: String) -> Result<String, SavedPromptError> {
    let name = name.trim().to_owned();
    if name.is_empty()
        || name.chars().count() > MAX_NAME_CHARS
        || name.chars().any(char::is_control)
    {
        return Err(SavedPromptError::Invalid);
    }
    Ok(name)
}

fn validate_content(content: &str) -> Result<(), SavedPromptError> {
    if content.trim().is_empty() || content.chars().count() > MAX_CONTENT_CHARS {
        return Err(SavedPromptError::Invalid);
    }
    Ok(())
}

fn validate_version(version: i64) -> Result<(), SavedPromptError> {
    if version < 1 {
        return Err(SavedPromptError::Invalid);
    }
    Ok(())
}

fn map_write_error(error: sqlx::Error) -> SavedPromptError {
    if error
        .as_database_error()
        .is_some_and(|error| error.kind() == ErrorKind::UniqueViolation)
    {
        SavedPromptError::NameConflict
    } else {
        SavedPromptError::Database(error)
    }
}

fn now_ms() -> Result<i64, SavedPromptError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| SavedPromptError::Clock)?;
    i64::try_from(duration.as_millis()).map_err(|_| SavedPromptError::Clock)
}

fn emit_saved_prompts_changed(app: &AppHandle) {
    if let Err(error) = app.emit(SAVED_PROMPTS_CHANGED_EVENT, ()) {
        tracing::warn!(%error, "failed to emit saved prompt change");
    }
}

#[tauri::command]
pub(crate) async fn list_saved_prompts(
    repository: State<'_, SavedPromptRepository>,
) -> Result<Vec<SavedPrompt>, SavedPromptCommandError> {
    repository.list().await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn create_saved_prompt(
    app: AppHandle,
    repository: State<'_, SavedPromptRepository>,
    request: CreateSavedPromptRequest,
) -> Result<SavedPrompt, SavedPromptCommandError> {
    let prompt = repository.create(request).await?;
    emit_saved_prompts_changed(&app);
    Ok(prompt)
}

#[tauri::command]
pub(crate) async fn update_saved_prompt(
    app: AppHandle,
    repository: State<'_, SavedPromptRepository>,
    request: UpdateSavedPromptRequest,
) -> Result<SavedPrompt, SavedPromptCommandError> {
    let prompt = repository.update(request).await?;
    emit_saved_prompts_changed(&app);
    Ok(prompt)
}

#[tauri::command]
pub(crate) async fn delete_saved_prompt(
    app: AppHandle,
    repository: State<'_, SavedPromptRepository>,
    request: DeleteSavedPromptRequest,
) -> Result<(), SavedPromptCommandError> {
    repository.delete(request).await?;
    emit_saved_prompts_changed(&app);
    Ok(())
}

#[tauri::command]
pub(crate) async fn reorder_saved_prompts(
    app: AppHandle,
    repository: State<'_, SavedPromptRepository>,
    request: ReorderSavedPromptsRequest,
) -> Result<(), SavedPromptCommandError> {
    repository.reorder(request).await?;
    emit_saved_prompts_changed(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::{
        CreateSavedPromptRequest, DeleteSavedPromptRequest, ReorderSavedPromptsRequest,
        SavedPromptError, SavedPromptRepository, UpdateSavedPromptRequest,
    };

    async fn repository() -> SavedPromptRepository {
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
        SavedPromptRepository::new(pool)
    }

    #[tokio::test]
    async fn creates_updates_reorders_and_deletes_prompts() {
        let repository = repository().await;
        let first = repository
            .create(CreateSavedPromptRequest {
                name: " 代码审查 ".to_owned(),
                content: "审查当前修改".to_owned(),
            })
            .await
            .unwrap();
        let second = repository
            .create(CreateSavedPromptRequest {
                name: "补充测试".to_owned(),
                content: "请补充测试".to_owned(),
            })
            .await
            .unwrap();
        assert_eq!(
            repository
                .list()
                .await
                .unwrap()
                .iter()
                .map(|prompt| prompt.name.as_str())
                .collect::<Vec<_>>(),
            ["代码审查", "补充测试"],
        );

        let updated = repository
            .update(UpdateSavedPromptRequest {
                prompt_id: first.prompt_id.clone(),
                expected_version: first.version,
                name: "严格审查".to_owned(),
                content: "  保留内容空白  ".to_owned(),
            })
            .await
            .unwrap();
        assert_eq!(updated.version, 2);
        assert_eq!(updated.content, "  保留内容空白  ");

        repository
            .reorder(ReorderSavedPromptsRequest {
                prompt_ids: vec![second.prompt_id.clone(), first.prompt_id.clone()],
            })
            .await
            .unwrap();
        assert_eq!(repository.list().await.unwrap()[0].prompt_id, second.prompt_id);

        repository
            .delete(DeleteSavedPromptRequest {
                prompt_id: first.prompt_id,
                expected_version: updated.version,
            })
            .await
            .unwrap();
        assert_eq!(repository.list().await.unwrap(), vec![second]);
    }

    #[tokio::test]
    async fn rejects_duplicate_names_and_stale_mutations() {
        let repository = repository().await;
        let prompt = repository
            .create(CreateSavedPromptRequest {
                name: "Review".to_owned(),
                content: "Review changes".to_owned(),
            })
            .await
            .unwrap();
        assert!(matches!(
            repository
                .create(CreateSavedPromptRequest {
                    name: "review".to_owned(),
                    content: "Duplicate".to_owned(),
                })
                .await,
            Err(SavedPromptError::NameConflict),
        ));
        assert!(matches!(
            repository
                .update(UpdateSavedPromptRequest {
                    prompt_id: prompt.prompt_id.clone(),
                    expected_version: prompt.version + 1,
                    name: prompt.name.clone(),
                    content: prompt.content.clone(),
                })
                .await,
            Err(SavedPromptError::VersionConflict),
        ));
        assert!(matches!(
            repository
                .reorder(ReorderSavedPromptsRequest { prompt_ids: vec![] })
                .await,
            Err(SavedPromptError::CollectionConflict),
        ));
    }
}
