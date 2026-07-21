use std::fmt;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::credentials::{CredentialStorageBackend, CredentialStoreError};

use super::{
    ClearProxyCredentialRequest, ClearServerCredentialRequest, ConfigurationRepository,
    ConfigurationRepositoryError, ConfigurationSnapshot, ConfirmProxySshHostKeyRequest,
    CreateProxyProfileRequest, CreateServerProfileRequest, CredentialManager,
    CredentialOperationError, DeleteProxyProfileRequest, DeleteServerProfileRequest, ProxyProfile,
    RecordProxyTestRequest, RemoveProxySshHostKeyRequest, ServerProfile, SetProxyCredentialRequest,
    SetServerCredentialRequest, UpdateProxyProfileRequest, UpdateServerProfileRequest,
};

const CONFIGURATION_PROFILES_CHANGED_EVENT: &str = "configuration-profiles-changed";

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CredentialStorageStatus {
    backend: CredentialStorageBackend,
}

pub(crate) fn emit_configuration_changed(app: &AppHandle) {
    if let Err(error) = app.emit(CONFIGURATION_PROFILES_CHANGED_EVENT, ()) {
        tracing::warn!(%error, "failed to emit configuration profile change");
    }
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigurationCommandError {
    code: &'static str,
    message: &'static str,
}

impl ConfigurationCommandError {
    const fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }
}

impl fmt::Display for ConfigurationCommandError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for ConfigurationCommandError {}

impl From<ConfigurationRepositoryError> for ConfigurationCommandError {
    fn from(error: ConfigurationRepositoryError) -> Self {
        match error {
            ConfigurationRepositoryError::Validation(error) => Self::new(error.code, error.message),
            ConfigurationRepositoryError::ServerNameConflict => {
                Self::new("serverNameConflict", "The server name is already in use")
            }
            ConfigurationRepositoryError::ProxyNameConflict => {
                Self::new("proxyNameConflict", "The proxy name is already in use")
            }
            ConfigurationRepositoryError::ServerNotFound => {
                Self::new("serverNotFound", "The server does not exist")
            }
            ConfigurationRepositoryError::ProxyNotFound => {
                Self::new("proxyNotFound", "The proxy does not exist")
            }
            ConfigurationRepositoryError::ServerVersionConflict => Self::new(
                "serverVersionConflict",
                "The server configuration was modified concurrently",
            ),
            ConfigurationRepositoryError::ProxyVersionConflict => Self::new(
                "proxyVersionConflict",
                "The proxy configuration was modified concurrently",
            ),
            ConfigurationRepositoryError::ProxyReferenced => Self::new(
                "proxyReferenced",
                "The proxy is referenced by one or more servers",
            ),
            ConfigurationRepositoryError::ServerInUse => Self::new(
                "serverInUse",
                "The server is currently used by one or more windows",
            ),
            ConfigurationRepositoryError::CredentialChangeRequired => Self::new(
                "credentialChangeRequired",
                "The stored credential must be changed explicitly",
            ),
            ConfigurationRepositoryError::CredentialConfigurationMismatch => Self::new(
                "credentialConfigurationMismatch",
                "The credential does not match the current configuration",
            ),
            ConfigurationRepositoryError::CredentialNotConfigured => Self::new(
                "credentialNotConfigured",
                "The required credential is not configured",
            ),
            ConfigurationRepositoryError::SshHostKeyRemovalRequired => Self::new(
                "sshHostKeyRemovalRequired",
                "The saved SSH host key must be removed before changing the endpoint",
            ),
            ConfigurationRepositoryError::SshHostKeyNotFound => Self::new(
                "sshHostKeyNotFound",
                "The saved SSH host key does not exist",
            ),
            ConfigurationRepositoryError::Corrupt => Self::new(
                "configurationCorrupt",
                "The persisted configuration is corrupt",
            ),
            ConfigurationRepositoryError::Database(source) => {
                tracing::error!(error = %source, "configuration database operation failed");
                Self::new(
                    "configurationDatabaseFailed",
                    "The configuration database operation failed",
                )
            }
        }
    }
}

impl From<CredentialOperationError> for ConfigurationCommandError {
    fn from(error: CredentialOperationError) -> Self {
        match error {
            CredentialOperationError::Validation(error) => Self::new(error.code, error.message),
            CredentialOperationError::Repository(error) => error.into(),
            CredentialOperationError::Store(error) => match error {
                CredentialStoreError::Unavailable => Self::new(
                    "credentialServiceUnavailable",
                    "The system credential service is unavailable",
                ),
                CredentialStoreError::Locked => Self::new(
                    "credentialServiceLocked",
                    "The system credential service is locked",
                ),
                CredentialStoreError::PromptDismissed => Self::new(
                    "credentialPromptDismissed",
                    "The credential access prompt was dismissed",
                ),
                CredentialStoreError::AccessDenied => Self::new(
                    "credentialAccessDenied",
                    "Access to the system credential service was denied",
                ),
                CredentialStoreError::TimedOut => Self::new(
                    "credentialServiceTimedOut",
                    "The system credential service did not respond in time",
                ),
                CredentialStoreError::NotFound => {
                    Self::new("credentialNotFound", "The saved credential does not exist")
                }
                CredentialStoreError::AlreadyExists
                | CredentialStoreError::Duplicate
                | CredentialStoreError::InvalidItem => Self::new(
                    "credentialRecordInvalid",
                    "The saved credential record is invalid",
                ),
                CredentialStoreError::PlaintextFallbackConfirmationRequired => Self::new(
                    "plaintextCredentialConfirmationRequired",
                    "Plaintext credential storage requires explicit confirmation",
                ),
                CredentialStoreError::Backend(_) => {
                    tracing::error!("system credential service operation failed");
                    Self::new(
                        "credentialStorageFailed",
                        "The system credential operation failed",
                    )
                }
                CredentialStoreError::Filesystem(_) => {
                    tracing::error!("plaintext credential file operation failed");
                    Self::new(
                        "credentialStorageFailed",
                        "The credential file operation failed",
                    )
                }
            },
        }
    }
}

#[tauri::command]
pub(crate) async fn credential_storage_status(
    credentials: State<'_, CredentialManager>,
) -> Result<CredentialStorageStatus, ConfigurationCommandError> {
    credentials
        .storage_backend()
        .await
        .map(|backend| CredentialStorageStatus { backend })
        .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn list_configuration_profiles(
    repository: State<'_, ConfigurationRepository>,
) -> Result<ConfigurationSnapshot, ConfigurationCommandError> {
    repository.snapshot().await.map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn create_server_profile(
    app: AppHandle,
    repository: State<'_, ConfigurationRepository>,
    request: CreateServerProfileRequest,
) -> Result<ServerProfile, ConfigurationCommandError> {
    let profile = repository.create_server(request).await?;
    emit_configuration_changed(&app);
    Ok(profile)
}

#[tauri::command]
pub(crate) async fn update_server_profile(
    app: AppHandle,
    repository: State<'_, ConfigurationRepository>,
    request: UpdateServerProfileRequest,
) -> Result<ServerProfile, ConfigurationCommandError> {
    let profile = repository.update_server(request).await?;
    emit_configuration_changed(&app);
    Ok(profile)
}

#[tauri::command]
pub(crate) async fn delete_server_profile(
    app: AppHandle,
    repository: State<'_, ConfigurationRepository>,
    credentials: State<'_, CredentialManager>,
    request: DeleteServerProfileRequest,
) -> Result<(), ConfigurationCommandError> {
    repository.delete_server(request).await?;
    credentials.cleanup_pending(&repository).await;
    emit_configuration_changed(&app);
    Ok(())
}

#[tauri::command]
pub(crate) async fn create_proxy_profile(
    app: AppHandle,
    repository: State<'_, ConfigurationRepository>,
    request: CreateProxyProfileRequest,
) -> Result<ProxyProfile, ConfigurationCommandError> {
    let profile = repository.create_proxy(request).await?;
    emit_configuration_changed(&app);
    Ok(profile)
}

#[tauri::command]
pub(crate) async fn update_proxy_profile(
    app: AppHandle,
    repository: State<'_, ConfigurationRepository>,
    request: UpdateProxyProfileRequest,
) -> Result<ProxyProfile, ConfigurationCommandError> {
    let profile = repository.update_proxy(request).await?;
    emit_configuration_changed(&app);
    Ok(profile)
}

#[tauri::command]
pub(crate) async fn delete_proxy_profile(
    app: AppHandle,
    repository: State<'_, ConfigurationRepository>,
    credentials: State<'_, CredentialManager>,
    request: DeleteProxyProfileRequest,
) -> Result<(), ConfigurationCommandError> {
    repository.delete_proxy(request).await?;
    credentials.cleanup_pending(&repository).await;
    emit_configuration_changed(&app);
    Ok(())
}

#[tauri::command]
pub(crate) async fn set_server_credential(
    app: AppHandle,
    repository: State<'_, ConfigurationRepository>,
    credentials: State<'_, CredentialManager>,
    request: SetServerCredentialRequest,
) -> Result<ServerProfile, ConfigurationCommandError> {
    let profile = credentials
        .set_server_credential(&repository, request)
        .await
        .map_err(ConfigurationCommandError::from)?;
    emit_configuration_changed(&app);
    Ok(profile)
}

#[tauri::command]
pub(crate) async fn clear_server_credential(
    app: AppHandle,
    repository: State<'_, ConfigurationRepository>,
    credentials: State<'_, CredentialManager>,
    request: ClearServerCredentialRequest,
) -> Result<ServerProfile, ConfigurationCommandError> {
    let profile = credentials
        .clear_server_credential(&repository, request)
        .await
        .map_err(ConfigurationCommandError::from)?;
    emit_configuration_changed(&app);
    Ok(profile)
}

#[tauri::command]
pub(crate) async fn set_proxy_credential(
    app: AppHandle,
    repository: State<'_, ConfigurationRepository>,
    credentials: State<'_, CredentialManager>,
    request: SetProxyCredentialRequest,
) -> Result<ProxyProfile, ConfigurationCommandError> {
    let profile = credentials
        .set_proxy_credential(&repository, request)
        .await
        .map_err(ConfigurationCommandError::from)?;
    emit_configuration_changed(&app);
    Ok(profile)
}

#[tauri::command]
pub(crate) async fn clear_proxy_credential(
    app: AppHandle,
    repository: State<'_, ConfigurationRepository>,
    credentials: State<'_, CredentialManager>,
    request: ClearProxyCredentialRequest,
) -> Result<ProxyProfile, ConfigurationCommandError> {
    let profile = credentials
        .clear_proxy_credential(&repository, request)
        .await
        .map_err(ConfigurationCommandError::from)?;
    emit_configuration_changed(&app);
    Ok(profile)
}

#[tauri::command]
pub(crate) async fn remove_proxy_ssh_host_key(
    app: AppHandle,
    repository: State<'_, ConfigurationRepository>,
    request: RemoveProxySshHostKeyRequest,
) -> Result<ProxyProfile, ConfigurationCommandError> {
    let profile = repository
        .remove_proxy_ssh_host_key(request)
        .await
        .map_err(ConfigurationCommandError::from)?;
    emit_configuration_changed(&app);
    Ok(profile)
}

#[tauri::command]
pub(crate) async fn confirm_proxy_ssh_host_key(
    app: AppHandle,
    repository: State<'_, ConfigurationRepository>,
    request: ConfirmProxySshHostKeyRequest,
) -> Result<ProxyProfile, ConfigurationCommandError> {
    let profile = repository
        .confirm_proxy_ssh_host_key(request)
        .await
        .map_err(ConfigurationCommandError::from)?;
    emit_configuration_changed(&app);
    Ok(profile)
}

#[tauri::command]
pub(crate) async fn record_proxy_test(
    app: AppHandle,
    repository: State<'_, ConfigurationRepository>,
    request: RecordProxyTestRequest,
) -> Result<ProxyProfile, ConfigurationCommandError> {
    let profile = repository
        .record_proxy_test(request)
        .await
        .map_err(ConfigurationCommandError::from)?;
    emit_configuration_changed(&app);
    Ok(profile)
}

#[cfg(test)]
mod tests {
    use super::{
        ConfigurationCommandError, ConfigurationRepositoryError, CredentialOperationError,
        CredentialStoreError,
    };

    #[test]
    fn maps_repository_failures_to_stable_public_errors() {
        let cases = [
            (
                ConfigurationRepositoryError::ServerNameConflict,
                "serverNameConflict",
            ),
            (
                ConfigurationRepositoryError::ProxyNameConflict,
                "proxyNameConflict",
            ),
            (
                ConfigurationRepositoryError::ServerNotFound,
                "serverNotFound",
            ),
            (ConfigurationRepositoryError::ProxyNotFound, "proxyNotFound"),
            (
                ConfigurationRepositoryError::ServerVersionConflict,
                "serverVersionConflict",
            ),
            (
                ConfigurationRepositoryError::ProxyVersionConflict,
                "proxyVersionConflict",
            ),
            (
                ConfigurationRepositoryError::ProxyReferenced,
                "proxyReferenced",
            ),
            (ConfigurationRepositoryError::ServerInUse, "serverInUse"),
            (
                ConfigurationRepositoryError::CredentialChangeRequired,
                "credentialChangeRequired",
            ),
            (
                ConfigurationRepositoryError::CredentialConfigurationMismatch,
                "credentialConfigurationMismatch",
            ),
            (
                ConfigurationRepositoryError::CredentialNotConfigured,
                "credentialNotConfigured",
            ),
            (
                ConfigurationRepositoryError::SshHostKeyRemovalRequired,
                "sshHostKeyRemovalRequired",
            ),
            (
                ConfigurationRepositoryError::SshHostKeyNotFound,
                "sshHostKeyNotFound",
            ),
            (
                ConfigurationRepositoryError::Corrupt,
                "configurationCorrupt",
            ),
        ];

        for (repository_error, expected_code) in cases {
            let command_error = ConfigurationCommandError::from(repository_error);
            assert_eq!(command_error.code, expected_code);
        }
    }

    #[test]
    fn maps_credential_store_failures_without_exposing_backend_details() {
        let cases = [
            (
                CredentialStoreError::Unavailable,
                "credentialServiceUnavailable",
            ),
            (CredentialStoreError::Locked, "credentialServiceLocked"),
            (
                CredentialStoreError::PromptDismissed,
                "credentialPromptDismissed",
            ),
            (CredentialStoreError::AccessDenied, "credentialAccessDenied"),
            (CredentialStoreError::TimedOut, "credentialServiceTimedOut"),
            (CredentialStoreError::NotFound, "credentialNotFound"),
            (
                CredentialStoreError::AlreadyExists,
                "credentialRecordInvalid",
            ),
            (CredentialStoreError::Duplicate, "credentialRecordInvalid"),
            (CredentialStoreError::InvalidItem, "credentialRecordInvalid"),
            (
                CredentialStoreError::PlaintextFallbackConfirmationRequired,
                "plaintextCredentialConfirmationRequired",
            ),
            (
                CredentialStoreError::Backend(secret_service::Error::Crypto(
                    "BACKEND_SECRET_SENTINEL",
                )),
                "credentialStorageFailed",
            ),
            (
                CredentialStoreError::Filesystem(std::io::Error::other(
                    "FILESYSTEM_SECRET_SENTINEL",
                )),
                "credentialStorageFailed",
            ),
        ];

        for (store_error, expected_code) in cases {
            let command_error =
                ConfigurationCommandError::from(CredentialOperationError::Store(store_error));
            assert_eq!(command_error.code, expected_code);
            let serialized = serde_json::to_string(&command_error).unwrap();
            assert!(!serialized.contains("BACKEND_SECRET_SENTINEL"));
            assert!(!serialized.contains("FILESYSTEM_SECRET_SENTINEL"));
            assert!(
                !command_error
                    .to_string()
                    .contains("BACKEND_SECRET_SENTINEL")
            );
            assert!(
                !command_error
                    .to_string()
                    .contains("FILESYSTEM_SECRET_SENTINEL")
            );
        }
    }
}
