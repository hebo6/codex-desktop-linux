use std::{
    error::Error,
    fmt,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Row as _, SqlitePool};
use tauri::{AppHandle, State};

use crate::{
    configuration::{
        CredentialManager, CredentialOperationError, commands::emit_configuration_changed,
    },
    credentials::{CredentialDescriptor, CredentialReference},
    local_data,
};

const MAX_PREFERENCES_BYTES: usize = 64 * 1024;

#[derive(Clone)]
pub(crate) struct PreferencesRepository {
    pool: SqlitePool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SavePreferencesRequest {
    preferences: Value,
}

#[derive(Debug)]
enum PreferencesError {
    Invalid,
    Clock,
    Corrupt,
    Database(sqlx::Error),
    Credential(CredentialOperationError),
    Filesystem(std::io::Error),
}

impl fmt::Display for PreferencesError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid => formatter.write_str("The application preferences are invalid"),
            Self::Clock => formatter.write_str("The system clock is unavailable"),
            Self::Corrupt => formatter.write_str("The persisted preferences are corrupt"),
            Self::Database(_) => formatter.write_str("The preferences database operation failed"),
            Self::Credential(_) => formatter.write_str("The credential store cleanup failed"),
            Self::Filesystem(_) => formatter.write_str("The application data cleanup failed"),
        }
    }
}

impl Error for PreferencesError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Database(source) => Some(source),
            Self::Credential(source) => Some(source),
            Self::Filesystem(source) => Some(source),
            _ => None,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreferencesCommandError {
    code: &'static str,
    message: &'static str,
}

impl From<PreferencesError> for PreferencesCommandError {
    fn from(error: PreferencesError) -> Self {
        match error {
            PreferencesError::Invalid => Self {
                code: "invalidRequest",
                message: "偏好设置无效",
            },
            PreferencesError::Clock
            | PreferencesError::Corrupt
            | PreferencesError::Database(_)
            | PreferencesError::Credential(_)
            | PreferencesError::Filesystem(_) => Self {
                code: "storageUnavailable",
                message: "偏好设置存储暂时不可用",
            },
        }
    }
}

impl PreferencesRepository {
    pub(crate) fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    async fn load(&self) -> Result<Value, PreferencesError> {
        let stored: Option<String> = sqlx::query_scalar(
            "SELECT preferences_json FROM app_preferences WHERE preference_scope = 'global'",
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(PreferencesError::Database)?;
        match stored {
            None => Ok(json!({})),
            Some(serialized) => {
                let value = serde_json::from_str::<Value>(&serialized)
                    .map_err(|_| PreferencesError::Corrupt)?;
                value
                    .is_object()
                    .then_some(value)
                    .ok_or(PreferencesError::Corrupt)
            }
        }
    }

    async fn save(&self, preferences: Value) -> Result<Value, PreferencesError> {
        if !preferences.is_object() {
            return Err(PreferencesError::Invalid);
        }
        let serialized =
            serde_json::to_string(&preferences).map_err(|_| PreferencesError::Invalid)?;
        if serialized.len() > MAX_PREFERENCES_BYTES {
            return Err(PreferencesError::Invalid);
        }
        let updated_at_ms = now_ms()?;
        sqlx::query(
            "INSERT INTO app_preferences (preference_scope, preferences_json, updated_at_ms)
             VALUES ('global', ?, ?)
             ON CONFLICT(preference_scope) DO UPDATE SET
               preferences_json = excluded.preferences_json,
               updated_at_ms = excluded.updated_at_ms",
        )
        .bind(serialized)
        .bind(updated_at_ms)
        .execute(&self.pool)
        .await
        .map_err(PreferencesError::Database)?;
        Ok(preferences)
    }

    async fn credential_bindings(
        &self,
    ) -> Result<Vec<(CredentialReference, CredentialDescriptor)>, PreferencesError> {
        let rows = sqlx::query(
            "SELECT sensitive_environment_credential_reference AS credential_reference,
                    'server' AS owner_kind, server_id AS owner_id,
                    'sensitive-environment' AS credential_kind
             FROM local_server_configs
             WHERE sensitive_environment_credential_reference IS NOT NULL
             UNION
             SELECT credential_reference, 'server', server_id, 'bearer-token'
             FROM remote_server_configs WHERE credential_reference IS NOT NULL
             UNION
             SELECT credential_reference, 'proxy', proxy_id,
                    CASE authentication_method
                      WHEN 'basic' THEN 'http-basic-password'
                      ELSE 'http-bearer-token'
                    END
             FROM http_proxy_configs WHERE credential_reference IS NOT NULL
             UNION
             SELECT credential_reference, 'proxy', proxy_id, 'socks5-password'
             FROM socks_proxy_configs WHERE credential_reference IS NOT NULL
             UNION
             SELECT key_passphrase_credential_reference, 'proxy', proxy_id,
                    'ssh-private-key-passphrase'
             FROM ssh_proxy_configs
             WHERE key_passphrase_credential_reference IS NOT NULL
             UNION
             SELECT password_credential_reference, 'proxy', proxy_id, 'ssh-password'
             FROM ssh_proxy_configs WHERE password_credential_reference IS NOT NULL
             UNION
             SELECT credential_reference, owner_kind, owner_id, credential_kind
             FROM credential_cleanup_queue
             ORDER BY credential_reference",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(PreferencesError::Database)?;
        rows.into_iter()
            .map(|row| {
                let reference = row
                    .try_get::<String, _>("credential_reference")
                    .map_err(|_| PreferencesError::Corrupt)?;
                let owner_kind = row
                    .try_get::<String, _>("owner_kind")
                    .map_err(|_| PreferencesError::Corrupt)?;
                let owner_id = row
                    .try_get::<String, _>("owner_id")
                    .map_err(|_| PreferencesError::Corrupt)?;
                let credential_kind = row
                    .try_get::<String, _>("credential_kind")
                    .map_err(|_| PreferencesError::Corrupt)?;
                Ok((
                    CredentialReference::parse(&reference)
                        .map_err(|_| PreferencesError::Corrupt)?,
                    CredentialDescriptor::parse(&owner_kind, &owner_id, &credential_kind)
                        .map_err(|_| PreferencesError::Corrupt)?,
                ))
            })
            .collect()
    }

    async fn clear_all_local_data(&self) -> Result<(), PreferencesError> {
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(PreferencesError::Database)?;
        for statement in [
            "DELETE FROM drafts",
            "DELETE FROM window_states",
            "DELETE FROM servers",
            "DELETE FROM proxies",
            "DELETE FROM credential_cleanup_queue",
            "DELETE FROM app_preferences",
            "DELETE FROM saved_prompts",
        ] {
            sqlx::query(statement)
                .execute(&mut *transaction)
                .await
                .map_err(PreferencesError::Database)?;
        }
        transaction
            .commit()
            .await
            .map_err(PreferencesError::Database)
    }
}

#[tauri::command]
pub(crate) async fn load_preferences(
    repository: State<'_, PreferencesRepository>,
) -> Result<Value, PreferencesCommandError> {
    repository.load().await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn save_preferences(
    repository: State<'_, PreferencesRepository>,
    request: SavePreferencesRequest,
) -> Result<Value, PreferencesCommandError> {
    repository
        .save(request.preferences)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn clear_application_logs(app: AppHandle) -> Result<(), PreferencesCommandError> {
    local_data::clear_application_logs(&app)
        .map_err(PreferencesError::Filesystem)
        .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn clear_temporary_files() -> Result<(), PreferencesCommandError> {
    local_data::clear_temporary_files()
        .map_err(PreferencesError::Filesystem)
        .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn clear_all_local_data(
    app: AppHandle,
    repository: State<'_, PreferencesRepository>,
    credentials: State<'_, CredentialManager>,
) -> Result<(), PreferencesCommandError> {
    let bindings = repository.credential_bindings().await?;
    credentials
        .delete_all(&bindings)
        .await
        .map_err(PreferencesError::Credential)?;
    local_data::clear_application_logs(&app).map_err(PreferencesError::Filesystem)?;
    local_data::clear_temporary_files().map_err(PreferencesError::Filesystem)?;
    repository.clear_all_local_data().await?;
    emit_configuration_changed(&app);
    Ok(())
}

fn now_ms() -> Result<i64, PreferencesError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| PreferencesError::Clock)?;
    i64::try_from(duration.as_millis()).map_err(|_| PreferencesError::Clock)
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use uuid::Uuid;

    use super::{PreferencesError, PreferencesRepository};
    use crate::credentials::{CredentialDescriptor, CredentialReference, ServerCredentialKind};

    async fn repository() -> PreferencesRepository {
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
        PreferencesRepository::new(pool)
    }

    #[tokio::test]
    async fn round_trips_global_preferences() {
        let repository = repository().await;
        assert_eq!(repository.load().await.unwrap(), json!({}));
        repository
            .save(json!({"theme":"dark","enterToSend":false}))
            .await
            .unwrap();
        assert_eq!(
            repository.load().await.unwrap(),
            json!({"theme":"dark","enterToSend":false})
        );
    }

    #[tokio::test]
    async fn rejects_non_object_preferences() {
        let repository = repository().await;
        assert!(matches!(
            repository.save(json!([])).await,
            Err(PreferencesError::Invalid)
        ));
    }

    #[tokio::test]
    async fn finds_active_credential_bindings_for_complete_cleanup() {
        let repository = repository().await;
        let server_id = Uuid::new_v4();
        let reference = CredentialReference::new();
        sqlx::query(
            "INSERT INTO servers (server_id, name, server_type)
             VALUES (?, 'Local server', 'local')",
        )
        .bind(server_id.to_string())
        .execute(&repository.pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO local_server_configs
             (server_id, executable_path, sensitive_environment_credential_reference)
             VALUES (?, '/usr/bin/codex', ?)",
        )
        .bind(server_id.to_string())
        .bind(reference.as_str())
        .execute(&repository.pool)
        .await
        .unwrap();

        assert_eq!(
            repository.credential_bindings().await.unwrap(),
            vec![(
                reference,
                CredentialDescriptor::Server {
                    server_id,
                    kind: ServerCredentialKind::SensitiveEnvironment,
                },
            )]
        );
    }

    #[tokio::test]
    async fn clears_configuration_windows_drafts_and_preferences_together() {
        let repository = repository().await;
        let server_id = Uuid::new_v4();
        let proxy_id = Uuid::new_v4();
        repository.save(json!({"theme":"dark"})).await.unwrap();
        sqlx::query(
            "INSERT INTO proxies (proxy_id, name, proxy_type)
             VALUES (?, 'Proxy', 'http')",
        )
        .bind(proxy_id.to_string())
        .execute(&repository.pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO servers (server_id, name, server_type)
             VALUES (?, 'Server', 'local')",
        )
        .bind(server_id.to_string())
        .execute(&repository.pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO window_states (window_id) VALUES ('main')")
            .execute(&repository.pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO drafts (draft_key, draft_json, updated_at_ms)
             VALUES ('draft', '{\"text\":\"keep\",\"tokens\":[]}', 1)",
        )
        .execute(&repository.pool)
        .await
        .unwrap();

        repository.clear_all_local_data().await.unwrap();

        assert_eq!(repository.load().await.unwrap(), json!({}));
        for table in ["servers", "proxies", "window_states", "drafts"] {
            let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
                .fetch_one(&repository.pool)
                .await
                .unwrap();
            assert_eq!(count, 0, "{table}");
        }
    }
}
