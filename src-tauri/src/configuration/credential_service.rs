use std::{fmt, path::PathBuf, sync::Arc, time::Duration};

use tokio::{sync::Mutex, time::timeout};

use crate::credentials::{
    CredentialDescriptor, CredentialReference, CredentialStorageBackend, CredentialStore,
    CredentialStoreError, PendingCredentialCleanup, PlaintextFileCredentialStore,
    PreferredCredentialStore, ProxyCredentialKind, SecretServiceCredentialStore,
    ServerCredentialKind,
};

use super::{
    ClearProxyCredentialRequest, ClearServerCredentialRequest, ConfigurationRepository,
    ConfigurationRepositoryError, CredentialBinding, ProxyConnectionTestCredentialSource,
    ProxyProfile, ResolvedDraftProxyConnection, ResolvedDraftServerConnection,
    ResolvedProxyConnection, ResolvedServerConnection, ServerConnectionTestCredentialSource,
    ServerId, ServerProfile, SetProxyCredentialRequest, SetServerCredentialRequest,
    credential_model::{
        CredentialValidationError, ResolvedCredential, StoredCredentialError,
        ValidatedCredentialWrite, decode_stored_credential,
    },
    model::{
        HttpProxyAuthentication, ProxyConfiguration, RemoteServerAuthentication,
        ServerConfiguration, Socks5Authentication, SshAuthenticationConfiguration,
        SshHostKeyRecord,
    },
};

const CLEANUP_BATCH_TIMEOUT: Duration = Duration::from_secs(120);

pub(crate) struct DraftProxyConnectionInput {
    pub(crate) configuration: ProxyConfiguration,
    pub(crate) credential_source: ProxyConnectionTestCredentialSource,
    pub(crate) ssh_host_key: Option<SshHostKeyRecord>,
}

pub(crate) struct CredentialManager {
    store: Arc<dyn CredentialStore>,
    preferred_store: Option<Arc<PreferredCredentialStore>>,
    operation_lock: Mutex<()>,
}

impl CredentialManager {
    pub(crate) fn system(plaintext_directory: PathBuf) -> Self {
        let preferred_store = Arc::new(PreferredCredentialStore::new(
            Arc::new(SecretServiceCredentialStore::default()),
            Arc::new(PlaintextFileCredentialStore::new(plaintext_directory)),
        ));
        Self {
            store: preferred_store.clone(),
            preferred_store: Some(preferred_store),
            operation_lock: Mutex::new(()),
        }
    }

    pub(crate) async fn storage_backend(
        &self,
    ) -> Result<CredentialStorageBackend, CredentialOperationError> {
        let _guard = self.operation_lock.lock().await;
        let preferred_store = self
            .preferred_store
            .as_ref()
            .expect("the system credential manager always has a preferred store");
        preferred_store.storage_backend().await.map_err(Into::into)
    }

    pub(crate) async fn delete_all(
        &self,
        bindings: &[(CredentialReference, CredentialDescriptor)],
    ) -> Result<(), CredentialOperationError> {
        let _guard = self.operation_lock.lock().await;
        for (reference, descriptor) in bindings {
            match self.store.delete(reference, *descriptor).await {
                Ok(()) | Err(CredentialStoreError::NotFound) => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn new(store: Arc<dyn CredentialStore>) -> Self {
        Self {
            store,
            preferred_store: None,
            operation_lock: Mutex::new(()),
        }
    }

    pub(crate) async fn set_server_credential(
        &self,
        repository: &ConfigurationRepository,
        request: SetServerCredentialRequest,
    ) -> Result<ServerProfile, CredentialOperationError> {
        let _guard = self.operation_lock.lock().await;
        let write = request.validate()?;
        let descriptor = write.descriptor;
        let expected_version = write.expected_version;
        let new_reference = self.create_reserved_credential(repository, &write).await?;
        drop(write);
        match repository
            .commit_server_credential(descriptor, expected_version, &new_reference)
            .await
        {
            Ok(profile) => {
                self.cleanup_pending_locked(repository).await;
                Ok(profile)
            }
            Err(error) => {
                self.cleanup_failed_commit_locked(repository, &new_reference, descriptor)
                    .await;
                self.cleanup_pending_locked(repository).await;
                Err(error.into())
            }
        }
    }

    pub(crate) async fn set_proxy_credential(
        &self,
        repository: &ConfigurationRepository,
        request: SetProxyCredentialRequest,
    ) -> Result<ProxyProfile, CredentialOperationError> {
        let _guard = self.operation_lock.lock().await;
        let write = request.validate()?;
        let descriptor = write.descriptor;
        let expected_version = write.expected_version;
        let new_reference = self.create_reserved_credential(repository, &write).await?;
        drop(write);
        match repository
            .commit_proxy_credential(descriptor, expected_version, &new_reference)
            .await
        {
            Ok(profile) => {
                self.cleanup_pending_locked(repository).await;
                Ok(profile)
            }
            Err(error) => {
                self.cleanup_failed_commit_locked(repository, &new_reference, descriptor)
                    .await;
                self.cleanup_pending_locked(repository).await;
                Err(error.into())
            }
        }
    }

    pub(crate) async fn clear_server_credential(
        &self,
        repository: &ConfigurationRepository,
        request: ClearServerCredentialRequest,
    ) -> Result<ServerProfile, CredentialOperationError> {
        let _guard = self.operation_lock.lock().await;
        let (descriptor, expected_version) = request.validate()?;
        let profile = repository
            .clear_server_credential(descriptor, expected_version)
            .await?;
        self.cleanup_pending_locked(repository).await;
        Ok(profile)
    }

    pub(crate) async fn clear_proxy_credential(
        &self,
        repository: &ConfigurationRepository,
        request: ClearProxyCredentialRequest,
    ) -> Result<ProxyProfile, CredentialOperationError> {
        let _guard = self.operation_lock.lock().await;
        let (descriptor, expected_version) = request.validate()?;
        let profile = repository
            .clear_proxy_credential(descriptor, expected_version)
            .await?;
        self.cleanup_pending_locked(repository).await;
        Ok(profile)
    }

    pub(crate) async fn cleanup_pending(&self, repository: &ConfigurationRepository) {
        let _guard = self.operation_lock.lock().await;
        self.cleanup_pending_locked(repository).await;
    }

    pub(crate) async fn resolve_server_connection(
        &self,
        repository: &ConfigurationRepository,
        server_id: ServerId,
    ) -> Result<ResolvedServerConnection, CredentialOperationError> {
        let _guard = self.operation_lock.lock().await;
        let plan = repository.connection_plan(server_id).await?;
        let server_credential = self.read_binding(plan.credential.as_ref()).await?;
        let proxy = match plan.proxy {
            Some(proxy) => {
                let credential = self.read_binding(proxy.credential.as_ref()).await?;
                Some(ResolvedProxyConnection {
                    proxy_id: proxy.proxy_id,
                    proxy_version: proxy.proxy_version,
                    configuration: proxy.configuration,
                    credential,
                    ssh_host_key: proxy.ssh_host_key,
                })
            }
            None => None,
        };
        let resolved = ResolvedServerConnection {
            server_id: plan.server_id,
            server_version: plan.server_version,
            configuration: plan.configuration,
            credential: server_credential,
            proxy,
        };
        validate_resolved_connection(&resolved)
            .map_err(|_| CredentialOperationError::Store(CredentialStoreError::InvalidItem))?;
        Ok(resolved)
    }

    pub(crate) async fn resolve_server_connection_test(
        &self,
        repository: &ConfigurationRepository,
        configuration: ServerConfiguration,
        credential_source: ServerConnectionTestCredentialSource,
        draft_proxy: Option<DraftProxyConnectionInput>,
    ) -> Result<ResolvedDraftServerConnection, CredentialOperationError> {
        let prepared_credential =
            prepare_test_credential_source(&configuration, credential_source)?;
        let uses_stored_credential = prepared_credential.stored.is_some();

        let _guard = self.operation_lock.lock().await;
        let plan = repository
            .server_connection_test_plan(configuration, prepared_credential.stored)
            .await?;
        let credential = if uses_stored_credential {
            Some(
                self.read_binding(plan.credential.as_ref())
                    .await?
                    .ok_or(ConfigurationRepositoryError::CredentialNotConfigured)?,
            )
        } else {
            prepared_credential.provided
        };
        let proxy = match (draft_proxy, plan.proxy) {
            (None, Some(proxy)) => {
                let credential = self.read_binding(proxy.credential.as_ref()).await?;
                Some(ResolvedDraftProxyConnection {
                    proxy_id: Some(proxy.proxy_id),
                    proxy_version: Some(proxy.proxy_version),
                    configuration: proxy.configuration,
                    credential,
                    ssh_host_key: proxy.ssh_host_key,
                })
            }
            (Some(proxy), None) => Some(
                self.resolve_draft_proxy_connection(repository, proxy)
                    .await?,
            ),
            (None, None) => None,
            (Some(_), Some(_)) => {
                return Err(ConfigurationRepositoryError::Corrupt.into());
            }
        };
        let resolved = ResolvedDraftServerConnection {
            configuration: plan.configuration,
            credential,
            proxy,
        };
        validate_resolved_draft_connection(&resolved).map_err(|_| {
            CredentialOperationError::Repository(
                ConfigurationRepositoryError::CredentialConfigurationMismatch,
            )
        })?;
        Ok(resolved)
    }

    async fn resolve_draft_proxy_connection(
        &self,
        repository: &ConfigurationRepository,
        proxy: DraftProxyConnectionInput,
    ) -> Result<ResolvedDraftProxyConnection, CredentialOperationError> {
        let expected_kind = proxy_credential_kind(&proxy.configuration);
        let credential_required = proxy_credential_required(&proxy.configuration);
        let credential = match proxy.credential_source {
            ProxyConnectionTestCredentialSource::None {} if credential_required => {
                return Err(ConfigurationRepositoryError::CredentialNotConfigured.into());
            }
            ProxyConnectionTestCredentialSource::None {} => None,
            ProxyConnectionTestCredentialSource::Provided { credential }
                if expected_kind == Some(credential.kind()) =>
            {
                Some(credential.resolve()?)
            }
            ProxyConnectionTestCredentialSource::Provided { .. } => {
                return Err(ConfigurationRepositoryError::CredentialConfigurationMismatch.into());
            }
            ProxyConnectionTestCredentialSource::Stored {
                proxy_id,
                expected_version,
            } if expected_kind.is_some() => {
                let plan = repository
                    .proxy_connection_test_plan(proxy_id, expected_version, &proxy.configuration)
                    .await?;
                Some(
                    self.read_binding(plan.credential.as_ref())
                        .await?
                        .ok_or(ConfigurationRepositoryError::CredentialNotConfigured)?,
                )
            }
            ProxyConnectionTestCredentialSource::Stored { .. } => {
                return Err(ConfigurationRepositoryError::CredentialConfigurationMismatch.into());
            }
        };
        let resolved = ResolvedDraftProxyConnection {
            proxy_id: None,
            proxy_version: None,
            configuration: proxy.configuration,
            credential,
            ssh_host_key: proxy.ssh_host_key,
        };
        validate_resolved_draft_proxy(&resolved).map_err(|_| {
            CredentialOperationError::Repository(
                ConfigurationRepositoryError::CredentialConfigurationMismatch,
            )
        })?;
        Ok(resolved)
    }

    async fn cleanup_pending_locked(&self, repository: &ConfigurationRepository) {
        if timeout(
            CLEANUP_BATCH_TIMEOUT,
            self.cleanup_pending_batch(repository),
        )
        .await
        .is_err()
        {
            tracing::warn!("credential cleanup batch timed out");
        }
    }

    async fn cleanup_pending_batch(&self, repository: &ConfigurationRepository) {
        let pending = match repository.pending_credential_cleanup().await {
            Ok(pending) => pending,
            Err(error) => {
                tracing::warn!(
                    category = repository_error_category(&error),
                    "credential cleanup queue could not be read"
                );
                return;
            }
        };
        for item in pending {
            if !self.cleanup_one(repository, item).await {
                break;
            }
        }
    }

    async fn cleanup_failed_commit_locked(
        &self,
        repository: &ConfigurationRepository,
        reference: &CredentialReference,
        descriptor: CredentialDescriptor,
    ) {
        let pending = match repository
            .pending_credential_cleanup_by_reference(reference)
            .await
        {
            Ok(Some(pending)) if pending.descriptor == descriptor => pending,
            Ok(Some(_)) => {
                tracing::warn!("failed credential commit left an invalid cleanup record");
                return;
            }
            Ok(None) => return,
            Err(error) => {
                tracing::warn!(
                    category = repository_error_category(&error),
                    "failed credential commit could not be checked for cleanup"
                );
                return;
            }
        };
        self.cleanup_one(repository, pending).await;
    }

    async fn create_reserved_credential(
        &self,
        repository: &ConfigurationRepository,
        write: &ValidatedCredentialWrite,
    ) -> Result<CredentialReference, CredentialOperationError> {
        let reference = CredentialReference::new();
        let environment_names = write.environment_names();
        repository
            .reserve_credential(
                write.descriptor,
                write.expected_version,
                &reference,
                environment_names.as_ref(),
            )
            .await?;

        let encoded_environment = write.encoded_environment()?;
        let secret = match (
            write.text_bytes(),
            encoded_environment.as_ref().map(|value| value.as_slice()),
        ) {
            (Some(secret), None) | (None, Some(secret)) => secret,
            _ => {
                return Err(CredentialOperationError::Validation(
                    CredentialValidationError::invalid_payload(),
                ));
            }
        };
        if let Some(preferred_store) = &self.preferred_store {
            preferred_store
                .create_with_plaintext_confirmation(
                    &reference,
                    write.descriptor,
                    secret,
                    write.plaintext_fallback_confirmed,
                )
                .await?;
        } else {
            self.store
                .create(&reference, write.descriptor, secret)
                .await?;
        }
        Ok(reference)
    }

    async fn read_binding(
        &self,
        binding: Option<&CredentialBinding>,
    ) -> Result<Option<ResolvedCredential>, CredentialOperationError> {
        let Some(binding) = binding else {
            return Ok(None);
        };
        let value = self
            .store
            .read(&binding.reference, binding.descriptor)
            .await?;
        decode_stored_credential(binding.descriptor, value)
            .map(Some)
            .map_err(|_| CredentialOperationError::Store(CredentialStoreError::InvalidItem))
    }

    async fn cleanup_one(
        &self,
        repository: &ConfigurationRepository,
        pending: PendingCredentialCleanup,
    ) -> bool {
        match self
            .store
            .delete(&pending.reference, pending.descriptor)
            .await
        {
            Ok(()) | Err(CredentialStoreError::NotFound) => {
                if let Err(error) = repository.complete_credential_cleanup(&pending).await {
                    tracing::warn!(
                        category = repository_error_category(&error),
                        "credential cleanup completion could not be recorded"
                    );
                    return false;
                }
                true
            }
            Err(error) => {
                tracing::warn!(
                    category = store_error_category(&error),
                    "credential cleanup was deferred"
                );
                false
            }
        }
    }
}

fn validate_resolved_connection(
    resolved: &ResolvedServerConnection,
) -> Result<(), StoredCredentialError> {
    validate_resolved_connection_configuration(
        &resolved.configuration,
        &resolved.credential,
        &resolved.proxy,
    )
}

fn validate_resolved_connection_configuration(
    configuration: &ServerConfiguration,
    credential: &Option<ResolvedCredential>,
    proxy: &Option<ResolvedProxyConnection>,
) -> Result<(), StoredCredentialError> {
    validate_resolved_server_credential(configuration, credential.as_ref())?;

    let configured_proxy_id = match configuration {
        ServerConfiguration::LocalStdio { .. } => None,
        ServerConfiguration::RemoteWebSocket { proxy_id, .. } => *proxy_id,
    };
    match (configured_proxy_id, proxy) {
        (None, None) => Ok(()),
        (Some(proxy_id), Some(proxy)) if proxy.proxy_id == proxy_id => {
            validate_resolved_proxy(proxy)
        }
        _ => Err(StoredCredentialError),
    }
}

fn validate_resolved_draft_connection(
    resolved: &ResolvedDraftServerConnection,
) -> Result<(), StoredCredentialError> {
    validate_resolved_server_credential(&resolved.configuration, resolved.credential.as_ref())?;
    let configured_proxy_id = match &resolved.configuration {
        ServerConfiguration::LocalStdio { .. } => None,
        ServerConfiguration::RemoteWebSocket { proxy_id, .. } => *proxy_id,
    };
    match (configured_proxy_id, &resolved.proxy) {
        (None, None) => Ok(()),
        (Some(configured_proxy_id), Some(proxy))
            if proxy.proxy_id == Some(configured_proxy_id) && proxy.proxy_version.is_some() =>
        {
            validate_resolved_draft_proxy(proxy)
        }
        (None, Some(proxy)) if proxy.proxy_id.is_none() && proxy.proxy_version.is_none() => {
            validate_resolved_draft_proxy(proxy)
        }
        _ => Err(StoredCredentialError),
    }
}

fn validate_resolved_server_credential(
    configuration: &ServerConfiguration,
    credential: Option<&ResolvedCredential>,
) -> Result<(), StoredCredentialError> {
    match (configuration, credential) {
        (
            ServerConfiguration::LocalStdio {
                non_sensitive_environment,
                ..
            },
            Some(ResolvedCredential::SensitiveEnvironment(environment)),
        ) => {
            if environment
                .iter()
                .any(|(name, _)| non_sensitive_environment.contains_key(name))
            {
                return Err(StoredCredentialError);
            }
        }
        (ServerConfiguration::LocalStdio { .. }, None)
        | (
            ServerConfiguration::RemoteWebSocket {
                authentication: RemoteServerAuthentication::None,
                ..
            },
            None,
        )
        | (
            ServerConfiguration::RemoteWebSocket {
                authentication: RemoteServerAuthentication::Bearer,
                ..
            },
            Some(ResolvedCredential::BearerToken(_)),
        ) => {}
        _ => return Err(StoredCredentialError),
    }
    Ok(())
}

struct PreparedTestCredentialSource {
    provided: Option<ResolvedCredential>,
    stored: Option<(ServerId, u64)>,
}

impl PreparedTestCredentialSource {
    const fn none() -> Self {
        Self {
            provided: None,
            stored: None,
        }
    }
}

fn prepare_test_credential_source(
    configuration: &ServerConfiguration,
    credential_source: ServerConnectionTestCredentialSource,
) -> Result<PreparedTestCredentialSource, CredentialOperationError> {
    let required_kind = match configuration {
        ServerConfiguration::LocalStdio { .. } => Some(ServerCredentialKind::SensitiveEnvironment),
        ServerConfiguration::RemoteWebSocket {
            authentication: RemoteServerAuthentication::Bearer,
            ..
        } => Some(ServerCredentialKind::BearerToken),
        ServerConfiguration::RemoteWebSocket {
            authentication: RemoteServerAuthentication::None,
            ..
        } => None,
    };
    match (required_kind, credential_source) {
        (
            Some(ServerCredentialKind::SensitiveEnvironment),
            ServerConnectionTestCredentialSource::None {},
        ) => Ok(PreparedTestCredentialSource::none()),
        (Some(_), ServerConnectionTestCredentialSource::None {}) => {
            Err(ConfigurationRepositoryError::CredentialNotConfigured.into())
        }
        (Some(required), ServerConnectionTestCredentialSource::Provided { credential })
            if credential.kind() == required =>
        {
            let credential = credential.resolve()?;
            validate_resolved_server_credential(configuration, Some(&credential)).map_err(
                |_| {
                    CredentialOperationError::Repository(
                        ConfigurationRepositoryError::CredentialConfigurationMismatch,
                    )
                },
            )?;
            Ok(PreparedTestCredentialSource {
                provided: Some(credential),
                stored: None,
            })
        }
        (Some(_), ServerConnectionTestCredentialSource::Provided { .. })
        | (None, ServerConnectionTestCredentialSource::Provided { .. }) => {
            Err(ConfigurationRepositoryError::CredentialConfigurationMismatch.into())
        }
        (
            Some(_) | None,
            ServerConnectionTestCredentialSource::Stored {
                server_id,
                expected_version,
            },
        ) => Ok(PreparedTestCredentialSource {
            provided: None,
            stored: Some((server_id, expected_version)),
        }),
        (None, ServerConnectionTestCredentialSource::None {}) => {
            Ok(PreparedTestCredentialSource::none())
        }
    }
}

fn validate_resolved_proxy(proxy: &ResolvedProxyConnection) -> Result<(), StoredCredentialError> {
    validate_resolved_proxy_parts(&proxy.configuration, &proxy.credential, &proxy.ssh_host_key)
}

fn validate_resolved_proxy_parts(
    configuration: &ProxyConfiguration,
    credential: &Option<ResolvedCredential>,
    ssh_host_key: &Option<SshHostKeyRecord>,
) -> Result<(), StoredCredentialError> {
    let valid = matches!(
        (configuration, credential),
        (
            ProxyConfiguration::HttpConnect {
                authentication: HttpProxyAuthentication::None,
                ..
            },
            None,
        ) | (
            ProxyConfiguration::Socks5 {
                authentication: Socks5Authentication::None,
                ..
            },
            None,
        ) | (
            ProxyConfiguration::Ssh {
                authentication: SshAuthenticationConfiguration::Agent {},
                ..
            },
            None,
        ) | (
            ProxyConfiguration::HttpConnect {
                authentication: HttpProxyAuthentication::Basic,
                ..
            },
            Some(ResolvedCredential::HttpBasicPassword(_)),
        ) | (
            ProxyConfiguration::HttpConnect {
                authentication: HttpProxyAuthentication::Bearer,
                ..
            },
            Some(ResolvedCredential::HttpBearerToken(_)),
        ) | (
            ProxyConfiguration::Socks5 {
                authentication: Socks5Authentication::UsernamePassword,
                ..
            },
            Some(ResolvedCredential::Socks5Password(_)),
        ) | (
            ProxyConfiguration::Ssh {
                authentication: SshAuthenticationConfiguration::PrivateKey { .. },
                ..
            },
            None | Some(ResolvedCredential::SshPrivateKeyPassphrase(_)),
        ) | (
            ProxyConfiguration::Ssh {
                authentication: SshAuthenticationConfiguration::Password {},
                ..
            },
            Some(ResolvedCredential::SshPassword(_)),
        )
    );
    if !valid
        || (!matches!(configuration, ProxyConfiguration::Ssh { .. }) && ssh_host_key.is_some())
    {
        Err(StoredCredentialError)
    } else {
        Ok(())
    }
}

fn validate_resolved_draft_proxy(
    proxy: &ResolvedDraftProxyConnection,
) -> Result<(), StoredCredentialError> {
    validate_resolved_proxy_parts(&proxy.configuration, &proxy.credential, &proxy.ssh_host_key)
}

fn proxy_credential_kind(configuration: &ProxyConfiguration) -> Option<ProxyCredentialKind> {
    match configuration {
        ProxyConfiguration::HttpConnect { authentication, .. } => match authentication {
            HttpProxyAuthentication::None => None,
            HttpProxyAuthentication::Basic => Some(ProxyCredentialKind::HttpBasicPassword),
            HttpProxyAuthentication::Bearer => Some(ProxyCredentialKind::HttpBearerToken),
        },
        ProxyConfiguration::Socks5 { authentication, .. } => match authentication {
            Socks5Authentication::None => None,
            Socks5Authentication::UsernamePassword => Some(ProxyCredentialKind::Socks5Password),
        },
        ProxyConfiguration::Ssh { authentication, .. } => match authentication {
            SshAuthenticationConfiguration::Agent {} => None,
            SshAuthenticationConfiguration::PrivateKey { .. } => {
                Some(ProxyCredentialKind::SshPrivateKeyPassphrase)
            }
            SshAuthenticationConfiguration::Password {} => Some(ProxyCredentialKind::SshPassword),
        },
    }
}

fn proxy_credential_required(configuration: &ProxyConfiguration) -> bool {
    !matches!(
        configuration,
        ProxyConfiguration::HttpConnect {
            authentication: HttpProxyAuthentication::None,
            ..
        } | ProxyConfiguration::Socks5 {
            authentication: Socks5Authentication::None,
            ..
        } | ProxyConfiguration::Ssh {
            authentication: SshAuthenticationConfiguration::Agent {},
            ..
        } | ProxyConfiguration::Ssh {
            authentication: SshAuthenticationConfiguration::PrivateKey { .. },
            ..
        }
    )
}

#[derive(Debug)]
pub(crate) enum CredentialOperationError {
    Validation(CredentialValidationError),
    Repository(ConfigurationRepositoryError),
    Store(CredentialStoreError),
}

impl fmt::Display for CredentialOperationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Validation(error) => formatter.write_str(error.message),
            Self::Repository(error) => fmt::Display::fmt(error, formatter),
            Self::Store(error) => fmt::Display::fmt(error, formatter),
        }
    }
}

impl std::error::Error for CredentialOperationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Repository(error) => Some(error),
            Self::Store(error) => Some(error),
            Self::Validation(_) => None,
        }
    }
}

impl From<CredentialValidationError> for CredentialOperationError {
    fn from(error: CredentialValidationError) -> Self {
        Self::Validation(error)
    }
}

impl From<ConfigurationRepositoryError> for CredentialOperationError {
    fn from(error: ConfigurationRepositoryError) -> Self {
        Self::Repository(error)
    }
}

impl From<CredentialStoreError> for CredentialOperationError {
    fn from(error: CredentialStoreError) -> Self {
        Self::Store(error)
    }
}

fn store_error_category(error: &CredentialStoreError) -> &'static str {
    match error {
        CredentialStoreError::Unavailable => "unavailable",
        CredentialStoreError::Locked => "locked",
        CredentialStoreError::PromptDismissed => "prompt-dismissed",
        CredentialStoreError::AccessDenied => "access-denied",
        CredentialStoreError::TimedOut => "timed-out",
        CredentialStoreError::NotFound => "not-found",
        CredentialStoreError::AlreadyExists => "already-exists",
        CredentialStoreError::Duplicate => "duplicate",
        CredentialStoreError::InvalidItem => "invalid-item",
        CredentialStoreError::PlaintextFallbackConfirmationRequired => {
            "plaintext-fallback-confirmation-required"
        }
        CredentialStoreError::Backend(_) => "backend",
        CredentialStoreError::Filesystem(_) => "filesystem",
    }
}

fn repository_error_category(error: &ConfigurationRepositoryError) -> &'static str {
    match error {
        ConfigurationRepositoryError::Database(_) => "database",
        ConfigurationRepositoryError::Corrupt => "corrupt",
        _ => "configuration",
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::{BTreeSet, HashMap},
        sync::{
            Arc, Mutex as StdMutex,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
    };

    use serde::de::DeserializeOwned;
    use serde_json::{Value, json};
    use sqlx::{
        SqlitePool,
        sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    };
    use tokio::sync::Notify;
    use zeroize::Zeroizing;

    use super::{CredentialManager, CredentialOperationError, DraftProxyConnectionInput};
    use crate::{
        configuration::{
            ClearServerCredentialRequest, ConfigurationRepository, ConfigurationRepositoryError,
            CreateServerProfileRequest, HttpProxyAuthentication, ProxyConfiguration,
            ProxyConnectionTestCredentialSource, ResolvedCredential, ServerConfiguration,
            ServerConfigurationInput, ServerConnectionTestCredentialSource,
            SetServerCredentialRequest, TlsCertificatePolicy, UpdateServerProfileRequest,
        },
        credentials::{
            CredentialDescriptor, CredentialReference, CredentialStore, CredentialStoreError,
            CredentialStoreFuture, ServerCredentialKind,
        },
    };

    struct StoredCredential {
        descriptor: CredentialDescriptor,
        secret: Zeroizing<Vec<u8>>,
    }

    #[derive(Default)]
    struct MemoryCredentialStore {
        items: StdMutex<HashMap<CredentialReference, StoredCredential>>,
        fail_next_create: AtomicBool,
        fail_delete: AtomicBool,
        delete_calls: AtomicUsize,
    }

    impl MemoryCredentialStore {
        fn item_count(&self) -> usize {
            self.items.lock().unwrap().len()
        }

        fn only_secret(&self) -> Zeroizing<Vec<u8>> {
            let items = self.items.lock().unwrap();
            let item = items.values().next().unwrap();
            Zeroizing::new(item.secret.as_slice().to_vec())
        }

        fn fail_next_create(&self) {
            self.fail_next_create.store(true, Ordering::SeqCst);
        }

        fn set_delete_failure(&self, fail: bool) {
            self.fail_delete.store(fail, Ordering::SeqCst);
        }

        fn delete_calls(&self) -> usize {
            self.delete_calls.load(Ordering::SeqCst)
        }
    }

    impl CredentialStore for MemoryCredentialStore {
        fn create<'a>(
            &'a self,
            reference: &'a CredentialReference,
            descriptor: CredentialDescriptor,
            secret: &'a [u8],
        ) -> CredentialStoreFuture<'a, ()> {
            Box::pin(async move {
                if self.fail_next_create.swap(false, Ordering::SeqCst) {
                    return Err(CredentialStoreError::Unavailable);
                }
                let mut items = self.items.lock().unwrap();
                if items.contains_key(reference) {
                    return Err(CredentialStoreError::AlreadyExists);
                }
                items.insert(
                    reference.clone(),
                    StoredCredential {
                        descriptor,
                        secret: Zeroizing::new(secret.to_vec()),
                    },
                );
                Ok(())
            })
        }

        fn read<'a>(
            &'a self,
            reference: &'a CredentialReference,
            descriptor: CredentialDescriptor,
        ) -> CredentialStoreFuture<'a, Zeroizing<Vec<u8>>> {
            Box::pin(async move {
                let items = self.items.lock().unwrap();
                let item = items.get(reference).ok_or(CredentialStoreError::NotFound)?;
                if item.descriptor != descriptor {
                    return Err(CredentialStoreError::InvalidItem);
                }
                Ok(Zeroizing::new(item.secret.as_slice().to_vec()))
            })
        }

        fn delete<'a>(
            &'a self,
            reference: &'a CredentialReference,
            descriptor: CredentialDescriptor,
        ) -> CredentialStoreFuture<'a, ()> {
            Box::pin(async move {
                self.delete_calls.fetch_add(1, Ordering::SeqCst);
                if self.fail_delete.load(Ordering::SeqCst) {
                    return Err(CredentialStoreError::Locked);
                }
                let mut items = self.items.lock().unwrap();
                let item = items.get(reference).ok_or(CredentialStoreError::NotFound)?;
                if item.descriptor != descriptor {
                    return Err(CredentialStoreError::InvalidItem);
                }
                items.remove(reference);
                Ok(())
            })
        }
    }

    #[derive(Default)]
    struct BlockingCredentialStore {
        inner: MemoryCredentialStore,
        create_started: Notify,
        release_create: Notify,
    }

    impl CredentialStore for BlockingCredentialStore {
        fn create<'a>(
            &'a self,
            reference: &'a CredentialReference,
            descriptor: CredentialDescriptor,
            secret: &'a [u8],
        ) -> CredentialStoreFuture<'a, ()> {
            Box::pin(async move {
                self.create_started.notify_one();
                self.release_create.notified().await;
                self.inner.create(reference, descriptor, secret).await
            })
        }

        fn read<'a>(
            &'a self,
            reference: &'a CredentialReference,
            descriptor: CredentialDescriptor,
        ) -> CredentialStoreFuture<'a, Zeroizing<Vec<u8>>> {
            self.inner.read(reference, descriptor)
        }

        fn delete<'a>(
            &'a self,
            reference: &'a CredentialReference,
            descriptor: CredentialDescriptor,
        ) -> CredentialStoreFuture<'a, ()> {
            self.inner.delete(reference, descriptor)
        }
    }

    async fn memory_repository() -> (ConfigurationRepository, SqlitePool) {
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
        (ConfigurationRepository::new(pool.clone()), pool)
    }

    fn request<Request: DeserializeOwned>(value: Value) -> Request {
        serde_json::from_value(value).unwrap()
    }

    fn local_server(name: &str) -> CreateServerProfileRequest {
        request(json!({
            "name": name,
            "configuration": {
                "type": "localStdio",
                "executablePath": "/usr/bin/codex",
                "arguments": ["app-server"],
                "nonSensitiveEnvironment": {}
            }
        }))
    }

    fn set_environment(
        server_id: impl serde::Serialize,
        expected_version: u64,
        value: &str,
    ) -> SetServerCredentialRequest {
        request(json!({
            "serverId": server_id,
            "expectedVersion": expected_version,
            "credential": {
                "type": "sensitiveEnvironment",
                "values": { "ACCESS_TOKEN": value }
            }
        }))
    }

    fn clear_environment(
        server_id: impl serde::Serialize,
        expected_version: u64,
    ) -> ClearServerCredentialRequest {
        request(json!({
            "serverId": server_id,
            "expectedVersion": expected_version,
            "credentialType": "sensitiveEnvironment"
        }))
    }

    #[tokio::test]
    async fn stores_replaces_and_clears_without_exposing_secret_values() {
        let (repository, _pool) = memory_repository().await;
        let server = repository
            .create_server(local_server("Credential lifecycle"))
            .await
            .unwrap();
        let store = Arc::new(MemoryCredentialStore::default());
        let manager = CredentialManager::new(store.clone());

        let first_secret = "FIRST_SERVER_SECRET_SENTINEL";
        let configured = manager
            .set_server_credential(
                &repository,
                set_environment(server.server_id, 1, first_secret),
            )
            .await
            .unwrap();
        assert_eq!(configured.version, 2);
        assert!(configured.credential_configured);
        assert_eq!(store.item_count(), 1);
        assert_eq!(
            store.only_secret().as_slice(),
            br#"{"ACCESS_TOKEN":"FIRST_SERVER_SECRET_SENTINEL"}"#
        );
        assert!(
            !serde_json::to_string(&configured)
                .unwrap()
                .contains(first_secret)
        );

        let second_secret = "SECOND_SERVER_SECRET_SENTINEL";
        let replaced = manager
            .set_server_credential(
                &repository,
                set_environment(server.server_id, 2, second_secret),
            )
            .await
            .unwrap();
        assert_eq!(replaced.version, 3);
        assert_eq!(store.item_count(), 1);
        assert_eq!(store.delete_calls(), 1);
        assert_eq!(
            store.only_secret().as_slice(),
            br#"{"ACCESS_TOKEN":"SECOND_SERVER_SECRET_SENTINEL"}"#
        );

        let cleared = manager
            .clear_server_credential(&repository, clear_environment(server.server_id, 3))
            .await
            .unwrap();
        assert_eq!(cleared.version, 4);
        assert!(!cleared.credential_configured);
        assert_eq!(store.item_count(), 0);
        assert_eq!(store.delete_calls(), 2);
        assert!(
            repository
                .pending_credential_cleanup()
                .await
                .unwrap()
                .is_empty()
        );
        let snapshot = serde_json::to_string(&repository.snapshot().await.unwrap()).unwrap();
        assert!(!snapshot.contains(first_secret));
        assert!(!snapshot.contains(second_secret));
    }

    #[tokio::test]
    async fn resolves_provided_draft_credentials_without_persisting_them() {
        let (repository, _pool) = memory_repository().await;
        let store = Arc::new(MemoryCredentialStore::default());
        let manager = CredentialManager::new(store.clone());
        let configuration = request::<ServerConfigurationInput>(json!({
            "type": "remoteWebSocket",
            "url": "wss://codex.example.test/app",
            "authentication": "bearer",
            "connectTimeoutMs": 5000,
            "tlsCertificatePolicy": "strict",
            "plaintextConfirmed": false
        }))
        .validate()
        .unwrap();
        let source = request::<ServerConnectionTestCredentialSource>(json!({
            "type": "provided",
            "credential": {
                "type": "bearerToken",
                "value": "DRAFT_ONLY_TOKEN"
            }
        }));

        let resolved = manager
            .resolve_server_connection_test(&repository, configuration.clone(), source, None)
            .await
            .unwrap();
        assert!(matches!(
            resolved.credential,
            Some(ResolvedCredential::BearerToken(_))
        ));
        assert_eq!(store.item_count(), 0);
        assert!(repository.snapshot().await.unwrap().servers.is_empty());

        let missing = manager
            .resolve_server_connection_test(
                &repository,
                configuration,
                request(json!({ "type": "none" })),
                None,
            )
            .await;
        assert!(matches!(
            missing,
            Err(CredentialOperationError::Repository(
                ConfigurationRepositoryError::CredentialNotConfigured
            ))
        ));
    }

    #[tokio::test]
    async fn resolves_inline_proxy_drafts_without_persisting_configuration_or_credentials() {
        let (repository, _pool) = memory_repository().await;
        let store = Arc::new(MemoryCredentialStore::default());
        let manager = CredentialManager::new(store.clone());
        let configuration = request::<ServerConfigurationInput>(json!({
            "type": "remoteWebSocket",
            "url": "wss://codex.example.test/app",
            "authentication": "none",
            "connectTimeoutMs": 5000,
            "tlsCertificatePolicy": "strict",
            "plaintextConfirmed": false
        }))
        .validate()
        .unwrap();
        let proxy = DraftProxyConnectionInput {
            configuration: ProxyConfiguration::HttpConnect {
                url: "http://proxy.example.test:8080".to_owned(),
                authentication: HttpProxyAuthentication::Basic,
                username: Some("draft-user".to_owned()),
                non_sensitive_headers: Default::default(),
                connect_timeout_ms: 5_000,
                tls_certificate_policy: TlsCertificatePolicy::Strict,
            },
            credential_source: request::<ProxyConnectionTestCredentialSource>(json!({
                "type": "provided",
                "credential": {
                    "type": "httpBasicPassword",
                    "value": "DRAFT_PROXY_SECRET"
                }
            })),
            ssh_host_key: None,
        };

        let resolved = manager
            .resolve_server_connection_test(
                &repository,
                configuration,
                request(json!({ "type": "none" })),
                Some(proxy),
            )
            .await
            .unwrap();

        assert!(matches!(
            resolved.proxy.and_then(|proxy| proxy.credential),
            Some(ResolvedCredential::HttpBasicPassword(_))
        ));
        assert_eq!(store.item_count(), 0);
        assert!(repository.snapshot().await.unwrap().proxies.is_empty());
    }

    #[tokio::test]
    async fn resolves_and_revalidates_stored_credentials_for_connections() {
        let (repository, _pool) = memory_repository().await;
        let server = repository
            .create_server(local_server("Resolved credential"))
            .await
            .unwrap();
        let store = Arc::new(MemoryCredentialStore::default());
        let manager = CredentialManager::new(store.clone());
        manager
            .set_server_credential(
                &repository,
                set_environment(server.server_id, 1, "RESOLVED_SECRET_SENTINEL"),
            )
            .await
            .unwrap();

        let resolved = manager
            .resolve_server_connection(&repository, server.server_id)
            .await
            .unwrap();
        assert_eq!(resolved.server_id, server.server_id);
        assert_eq!(resolved.server_version, 2);
        assert!(matches!(
            resolved.configuration,
            ServerConfiguration::LocalStdio { .. }
        ));
        let Some(ResolvedCredential::SensitiveEnvironment(environment)) = resolved.credential
        else {
            panic!("expected the resolved sensitive environment");
        };
        assert_eq!(
            environment.iter().collect::<Vec<_>>(),
            vec![("ACCESS_TOKEN", "RESOLVED_SECRET_SENTINEL")]
        );

        {
            let mut items = store.items.lock().unwrap();
            items.values_mut().next().unwrap().secret =
                Zeroizing::new(br#"{"INVALID-NAME":"CORRUPT_SECRET_SENTINEL"}"#.to_vec());
        }
        assert!(matches!(
            manager
                .resolve_server_connection(&repository, server.server_id)
                .await,
            Err(CredentialOperationError::Store(
                CredentialStoreError::InvalidItem
            ))
        ));
    }

    #[tokio::test]
    async fn keeps_failed_create_reserved_until_idempotent_cleanup() {
        let (repository, _pool) = memory_repository().await;
        let server = repository
            .create_server(local_server("Failed credential"))
            .await
            .unwrap();
        let store = Arc::new(MemoryCredentialStore::default());
        store.fail_next_create();
        let manager = CredentialManager::new(store.clone());

        let result = manager
            .set_server_credential(
                &repository,
                set_environment(server.server_id, 1, "FAILED_CREATE_SENTINEL"),
            )
            .await;
        assert!(matches!(
            result,
            Err(CredentialOperationError::Store(
                CredentialStoreError::Unavailable
            ))
        ));
        assert_eq!(
            repository.pending_credential_cleanup().await.unwrap().len(),
            1
        );
        assert!(!repository.snapshot().await.unwrap().servers[0].credential_configured);

        let unchanged = manager
            .clear_server_credential(&repository, clear_environment(server.server_id, 1))
            .await
            .unwrap();
        assert_eq!(unchanged.version, 1);
        assert!(!unchanged.credential_configured);
        assert!(
            repository
                .pending_credential_cleanup()
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(store.delete_calls(), 1);
    }

    #[tokio::test]
    async fn stops_cleanup_after_first_store_failure_and_retries_later() {
        let (repository, _pool) = memory_repository().await;
        let server = repository
            .create_server(local_server("Deferred cleanup"))
            .await
            .unwrap();
        let descriptor = CredentialDescriptor::Server {
            server_id: server.server_id.0,
            kind: ServerCredentialKind::SensitiveEnvironment,
        };
        let names = BTreeSet::from(["ACCESS_TOKEN".to_owned()]);
        let references = [CredentialReference::new(), CredentialReference::new()];
        let store = Arc::new(MemoryCredentialStore::default());
        for reference in &references {
            repository
                .reserve_credential(descriptor, 1, reference, Some(&names))
                .await
                .unwrap();
            store
                .create(reference, descriptor, b"deferred-secret")
                .await
                .unwrap();
        }
        store.set_delete_failure(true);
        let manager = CredentialManager::new(store.clone());

        manager.cleanup_pending(&repository).await;
        assert_eq!(store.delete_calls(), 1);
        assert_eq!(store.item_count(), 2);
        assert_eq!(
            repository.pending_credential_cleanup().await.unwrap().len(),
            2
        );

        store.set_delete_failure(false);
        manager.cleanup_pending(&repository).await;
        assert_eq!(store.delete_calls(), 3);
        assert_eq!(store.item_count(), 0);
        assert!(
            repository
                .pending_credential_cleanup()
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn never_deletes_a_cleanup_record_that_is_still_active() {
        let (repository, pool) = memory_repository().await;
        let server = repository
            .create_server(local_server("Active credential"))
            .await
            .unwrap();
        let store = Arc::new(MemoryCredentialStore::default());
        let manager = CredentialManager::new(store.clone());
        manager
            .set_server_credential(
                &repository,
                set_environment(server.server_id, 1, "ACTIVE_SECRET_SENTINEL"),
            )
            .await
            .unwrap();
        let reference: String = sqlx::query_scalar(
            "SELECT sensitive_environment_credential_reference
             FROM local_server_configs WHERE server_id = ?",
        )
        .bind(server.server_id.0.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO credential_cleanup_queue
             (credential_reference, owner_kind, owner_id, credential_kind, queued_at_ms)
             VALUES (?, 'server', ?, 'sensitive-environment', 1)",
        )
        .bind(reference)
        .bind(server.server_id.0.to_string())
        .execute(&pool)
        .await
        .unwrap();

        manager.cleanup_pending(&repository).await;
        assert_eq!(store.delete_calls(), 0);
        assert_eq!(store.item_count(), 1);
        assert!(matches!(
            repository.pending_credential_cleanup().await,
            Err(ConfigurationRepositoryError::Corrupt)
        ));
    }

    #[tokio::test]
    async fn prioritizes_failed_commit_cleanup_beyond_the_batch_limit() {
        let (repository, pool) = memory_repository().await;
        let server = repository
            .create_server(local_server("Prioritized cleanup"))
            .await
            .unwrap();
        for queued_at_ms in 0..64_i64 {
            let reference = CredentialReference::new();
            sqlx::query(
                "INSERT INTO credential_cleanup_queue
                 (credential_reference, owner_kind, owner_id, credential_kind, queued_at_ms)
                 VALUES (?, 'server', ?, 'sensitive-environment', ?)",
            )
            .bind(reference.as_str())
            .bind(server.server_id.0.to_string())
            .bind(queued_at_ms)
            .execute(&pool)
            .await
            .unwrap();
        }
        let store = Arc::new(BlockingCredentialStore::default());
        let manager = Arc::new(CredentialManager::new(store.clone()));
        let set_manager = Arc::clone(&manager);
        let set_repository = repository.clone();
        let set_request = set_environment(server.server_id, 1, "PRIORITIZED_SECRET_SENTINEL");
        let set_task = tokio::spawn(async move {
            set_manager
                .set_server_credential(&set_repository, set_request)
                .await
        });
        store.create_started.notified().await;
        repository
            .update_server(request::<UpdateServerProfileRequest>(json!({
                "serverId": server.server_id,
                "expectedVersion": 1,
                "name": "Prioritized cleanup updated",
                "configuration": {
                    "type": "localStdio",
                    "executablePath": "/usr/bin/codex",
                    "arguments": ["app-server", "--updated"],
                    "nonSensitiveEnvironment": {}
                }
            })))
            .await
            .unwrap();
        store.release_create.notify_one();

        assert!(matches!(
            set_task.await.unwrap(),
            Err(CredentialOperationError::Repository(
                ConfigurationRepositoryError::ServerVersionConflict
            ))
        ));
        assert_eq!(store.inner.item_count(), 0);
        assert_eq!(store.inner.delete_calls(), 65);
        assert!(
            repository
                .pending_credential_cleanup()
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn serializes_full_mutations_and_compensates_a_commit_conflict() {
        let (repository, _pool) = memory_repository().await;
        let server = repository
            .create_server(local_server("Concurrent credential"))
            .await
            .unwrap();
        let store = Arc::new(BlockingCredentialStore::default());
        let manager = Arc::new(CredentialManager::new(store.clone()));

        let set_manager = Arc::clone(&manager);
        let set_repository = repository.clone();
        let set_request = set_environment(server.server_id, 1, "CONCURRENT_SECRET_SENTINEL");
        let set_task = tokio::spawn(async move {
            set_manager
                .set_server_credential(&set_repository, set_request)
                .await
        });
        store.create_started.notified().await;

        let clear_attempted = Arc::new(Notify::new());
        let clear_manager = Arc::clone(&manager);
        let clear_repository = repository.clone();
        let clear_request = clear_environment(server.server_id, 1);
        let clear_attempted_in_task = Arc::clone(&clear_attempted);
        let clear_task = tokio::spawn(async move {
            clear_attempted_in_task.notify_one();
            clear_manager
                .clear_server_credential(&clear_repository, clear_request)
                .await
        });
        clear_attempted.notified().await;
        tokio::task::yield_now().await;
        assert!(!clear_task.is_finished());

        repository
            .update_server(request::<UpdateServerProfileRequest>(json!({
                "serverId": server.server_id,
                "expectedVersion": 1,
                "name": "Concurrent credential updated",
                "configuration": {
                    "type": "localStdio",
                    "executablePath": "/usr/bin/codex",
                    "arguments": ["app-server", "--updated"],
                    "nonSensitiveEnvironment": {}
                }
            })))
            .await
            .unwrap();
        store.release_create.notify_one();

        assert!(matches!(
            set_task.await.unwrap(),
            Err(CredentialOperationError::Repository(
                ConfigurationRepositoryError::ServerVersionConflict
            ))
        ));
        assert!(matches!(
            clear_task.await.unwrap(),
            Err(CredentialOperationError::Repository(
                ConfigurationRepositoryError::ServerVersionConflict
            ))
        ));
        assert_eq!(store.inner.item_count(), 0);
        assert_eq!(store.inner.delete_calls(), 1);
        assert!(
            repository
                .pending_credential_cleanup()
                .await
                .unwrap()
                .is_empty()
        );
    }
}
