use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fmt,
    net::IpAddr,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use sqlx::{
    Decode, Row, Sqlite, SqliteConnection, SqlitePool, Type, error::ErrorKind, sqlite::SqliteRow,
};
use url::{Host, Url};
use uuid::{Uuid, Version};

use crate::credentials::{
    CredentialDescriptor, CredentialReference, PendingCredentialCleanup, ProxyCredentialKind,
    ServerCredentialKind,
};

use super::model::{
    ConfigurationSnapshot, ConfigurationValidationError, ConfirmProxySshHostKeyRequest,
    CreateProxyProfileRequest, CreateServerProfileRequest, DeleteProxyProfileRequest,
    DeleteServerProfileRequest, HttpProxyAuthentication, ProxyConfiguration, ProxyId,
    ProxyLastTest, ProxyProfile, ProxyTestStatus, RecordProxyTestRequest,
    RemoteServerAuthentication, RemoveProxySshHostKeyRequest, ServerConfiguration, ServerId,
    ServerProfile, Socks5Authentication, Socks5DnsResolution, SshAuthenticationConfiguration,
    SshHostKeyRecord, TlsCertificatePolicy, UpdateProxyProfileRequest, UpdateServerProfileRequest,
    ValidatedProxyWrite, validate_host_key_record,
};

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Clone)]
pub(crate) struct ConfigurationRepository {
    pool: SqlitePool,
}

#[derive(Debug)]
pub(crate) enum ConfigurationRepositoryError {
    Validation(ConfigurationRepositoryValidationError),
    ServerNameConflict,
    ProxyNameConflict,
    ServerNotFound,
    ProxyNotFound,
    ServerVersionConflict,
    ProxyVersionConflict,
    ProxyReferenced,
    ServerInUse,
    CredentialChangeRequired,
    CredentialConfigurationMismatch,
    CredentialNotConfigured,
    SshHostKeyRemovalRequired,
    SshHostKeyNotFound,
    Corrupt,
    Database(sqlx::Error),
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct ConfigurationRepositoryValidationError {
    pub(crate) code: &'static str,
    pub(crate) message: &'static str,
}

impl fmt::Display for ConfigurationRepositoryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Validation(error) => formatter.write_str(error.message),
            Self::ServerNameConflict => formatter.write_str("The server name is already in use"),
            Self::ProxyNameConflict => formatter.write_str("The proxy name is already in use"),
            Self::ServerNotFound => formatter.write_str("The server does not exist"),
            Self::ProxyNotFound => formatter.write_str("The proxy does not exist"),
            Self::ServerVersionConflict => {
                formatter.write_str("The server configuration was modified concurrently")
            }
            Self::ProxyVersionConflict => {
                formatter.write_str("The proxy configuration was modified concurrently")
            }
            Self::ProxyReferenced => formatter.write_str("The proxy is referenced by a server"),
            Self::ServerInUse => formatter.write_str("The server is used by an active window"),
            Self::CredentialChangeRequired => {
                formatter.write_str("The stored credential must be changed explicitly")
            }
            Self::CredentialConfigurationMismatch => {
                formatter.write_str("The credential does not match the current configuration")
            }
            Self::CredentialNotConfigured => {
                formatter.write_str("The required credential is not configured")
            }
            Self::SshHostKeyRemovalRequired => {
                formatter.write_str("The SSH host key must be removed explicitly")
            }
            Self::SshHostKeyNotFound => formatter.write_str("The SSH host key does not exist"),
            Self::Corrupt => formatter.write_str("The persisted configuration is corrupt"),
            Self::Database(_) => formatter.write_str("The configuration database operation failed"),
        }
    }
}

impl Error for ConfigurationRepositoryError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Database(source) => Some(source),
            _ => None,
        }
    }
}

impl From<ConfigurationValidationError> for ConfigurationRepositoryError {
    fn from(error: ConfigurationValidationError) -> Self {
        Self::Validation(ConfigurationRepositoryValidationError {
            code: error.code,
            message: error.message,
        })
    }
}

impl ConfigurationRepository {
    pub(crate) fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub(crate) async fn close(&self) {
        self.pool.close().await;
    }

    pub(crate) async fn reserve_credential(
        &self,
        descriptor: CredentialDescriptor,
        expected_version: u64,
        new_reference: &CredentialReference,
        sensitive_environment_names: Option<&BTreeSet<String>>,
    ) -> Result<(), ConfigurationRepositoryError> {
        let expected_version = version_to_i64(expected_version)?;
        require_canonical_credential_reference(new_reference)?;
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database_error)?;

        let current_reference = match descriptor {
            CredentialDescriptor::Server { server_id, .. } => {
                let server_id = ServerId(server_id);
                let (server_type, current_version, _) =
                    load_server_identity(&mut transaction, server_id).await?;
                if current_version != expected_version {
                    return Err(ConfigurationRepositoryError::ServerVersionConflict);
                }
                let (_, current_reference) =
                    load_server_credential_state(&mut transaction, descriptor, &server_type)
                        .await?;
                validate_sensitive_environment_names(
                    &mut transaction,
                    descriptor,
                    sensitive_environment_names,
                )
                .await?;
                current_reference
            }
            CredentialDescriptor::Proxy { proxy_id, .. } => {
                if sensitive_environment_names.is_some() {
                    return Err(ConfigurationRepositoryError::CredentialConfigurationMismatch);
                }
                let proxy_id = ProxyId(proxy_id);
                let (proxy_type, current_version, _) =
                    load_proxy_identity(&mut transaction, proxy_id).await?;
                if current_version != expected_version {
                    return Err(ConfigurationRepositoryError::ProxyVersionConflict);
                }
                let (_, current_reference) =
                    load_proxy_credential_state(&mut transaction, descriptor, &proxy_type).await?;
                current_reference
            }
        };
        if current_reference.as_ref() == Some(new_reference) {
            return Err(ConfigurationRepositoryError::CredentialConfigurationMismatch);
        }

        enqueue_credential_cleanup(
            &mut transaction,
            new_reference,
            descriptor,
            current_time_ms()?,
        )
        .await?;
        transaction.commit().await.map_err(database_error)
    }

    pub(crate) async fn commit_server_credential(
        &self,
        descriptor: CredentialDescriptor,
        expected_version: u64,
        new_reference: &CredentialReference,
    ) -> Result<ServerProfile, ConfigurationRepositoryError> {
        let CredentialDescriptor::Server { server_id, .. } = descriptor else {
            return Err(ConfigurationRepositoryError::CredentialConfigurationMismatch);
        };
        let server_id = ServerId(server_id);
        let expected_version = version_to_i64(expected_version)?;
        require_canonical_credential_reference(new_reference)?;
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database_error)?;

        let (server_type, current_version, updated_at_ms) =
            load_server_identity(&mut transaction, server_id).await?;
        if current_version != expected_version {
            return Err(ConfigurationRepositoryError::ServerVersionConflict);
        }
        require_incrementable_version(
            current_version,
            ConfigurationRepositoryError::ServerVersionConflict,
        )?;
        require_incrementable_timestamp(updated_at_ms)?;
        let now_ms = current_time_ms()?;
        let (location, old_reference) =
            load_server_credential_state(&mut transaction, descriptor, &server_type).await?;
        if old_reference.as_ref() == Some(new_reference) {
            return Err(ConfigurationRepositoryError::CredentialConfigurationMismatch);
        }
        require_reserved_credential(&mut transaction, new_reference, descriptor).await?;

        update_credential_reference(
            &mut transaction,
            location,
            descriptor.owner_id(),
            Some(new_reference),
        )
        .await?;
        update_server_after_credential_change(
            &mut transaction,
            server_id,
            expected_version,
            now_ms,
        )
        .await?;
        remove_reserved_credential(&mut transaction, new_reference, descriptor).await?;
        if let Some(old_reference) = old_reference {
            enqueue_credential_cleanup(&mut transaction, &old_reference, descriptor, now_ms)
                .await?;
        }

        let profile = load_server(&mut transaction, server_id).await?;
        transaction.commit().await.map_err(database_error)?;
        Ok(profile)
    }

    pub(crate) async fn commit_proxy_credential(
        &self,
        descriptor: CredentialDescriptor,
        expected_version: u64,
        new_reference: &CredentialReference,
    ) -> Result<ProxyProfile, ConfigurationRepositoryError> {
        let CredentialDescriptor::Proxy { proxy_id, .. } = descriptor else {
            return Err(ConfigurationRepositoryError::CredentialConfigurationMismatch);
        };
        let proxy_id = ProxyId(proxy_id);
        let expected_version = version_to_i64(expected_version)?;
        require_canonical_credential_reference(new_reference)?;
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database_error)?;

        let (proxy_type, current_version, updated_at_ms) =
            load_proxy_identity(&mut transaction, proxy_id).await?;
        if current_version != expected_version {
            return Err(ConfigurationRepositoryError::ProxyVersionConflict);
        }
        require_incrementable_version(
            current_version,
            ConfigurationRepositoryError::ProxyVersionConflict,
        )?;
        require_incrementable_timestamp(updated_at_ms)?;
        let now_ms = current_time_ms()?;
        let (location, old_reference) =
            load_proxy_credential_state(&mut transaction, descriptor, &proxy_type).await?;
        if old_reference.as_ref() == Some(new_reference) {
            return Err(ConfigurationRepositoryError::CredentialConfigurationMismatch);
        }
        require_reserved_credential(&mut transaction, new_reference, descriptor).await?;

        update_credential_reference(
            &mut transaction,
            location,
            descriptor.owner_id(),
            Some(new_reference),
        )
        .await?;
        update_proxy_after_credential_change(&mut transaction, proxy_id, expected_version, now_ms)
            .await?;
        remove_reserved_credential(&mut transaction, new_reference, descriptor).await?;
        if let Some(old_reference) = old_reference {
            enqueue_credential_cleanup(&mut transaction, &old_reference, descriptor, now_ms)
                .await?;
        }

        let profile = load_proxy(&mut transaction, proxy_id).await?;
        transaction.commit().await.map_err(database_error)?;
        Ok(profile)
    }

    pub(crate) async fn clear_server_credential(
        &self,
        descriptor: CredentialDescriptor,
        expected_version: u64,
    ) -> Result<ServerProfile, ConfigurationRepositoryError> {
        let CredentialDescriptor::Server { server_id, .. } = descriptor else {
            return Err(ConfigurationRepositoryError::CredentialConfigurationMismatch);
        };
        let server_id = ServerId(server_id);
        let expected_version = version_to_i64(expected_version)?;
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database_error)?;

        let (server_type, current_version, updated_at_ms) =
            load_server_identity(&mut transaction, server_id).await?;
        if current_version != expected_version {
            return Err(ConfigurationRepositoryError::ServerVersionConflict);
        }
        let (location, old_reference) =
            load_server_credential_state(&mut transaction, descriptor, &server_type).await?;
        let Some(old_reference) = old_reference else {
            let profile = load_server(&mut transaction, server_id).await?;
            transaction.commit().await.map_err(database_error)?;
            return Ok(profile);
        };
        require_incrementable_version(
            current_version,
            ConfigurationRepositoryError::ServerVersionConflict,
        )?;
        require_incrementable_timestamp(updated_at_ms)?;
        let now_ms = current_time_ms()?;

        update_credential_reference(&mut transaction, location, descriptor.owner_id(), None)
            .await?;
        update_server_after_credential_change(
            &mut transaction,
            server_id,
            expected_version,
            now_ms,
        )
        .await?;
        enqueue_credential_cleanup(&mut transaction, &old_reference, descriptor, now_ms).await?;

        let profile = load_server(&mut transaction, server_id).await?;
        transaction.commit().await.map_err(database_error)?;
        Ok(profile)
    }

    pub(crate) async fn clear_proxy_credential(
        &self,
        descriptor: CredentialDescriptor,
        expected_version: u64,
    ) -> Result<ProxyProfile, ConfigurationRepositoryError> {
        let CredentialDescriptor::Proxy { proxy_id, .. } = descriptor else {
            return Err(ConfigurationRepositoryError::CredentialConfigurationMismatch);
        };
        let proxy_id = ProxyId(proxy_id);
        let expected_version = version_to_i64(expected_version)?;
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database_error)?;

        let (proxy_type, current_version, updated_at_ms) =
            load_proxy_identity(&mut transaction, proxy_id).await?;
        if current_version != expected_version {
            return Err(ConfigurationRepositoryError::ProxyVersionConflict);
        }
        let (location, old_reference) =
            load_proxy_credential_state(&mut transaction, descriptor, &proxy_type).await?;
        let Some(old_reference) = old_reference else {
            let profile = load_proxy(&mut transaction, proxy_id).await?;
            transaction.commit().await.map_err(database_error)?;
            return Ok(profile);
        };
        require_incrementable_version(
            current_version,
            ConfigurationRepositoryError::ProxyVersionConflict,
        )?;
        require_incrementable_timestamp(updated_at_ms)?;
        let now_ms = current_time_ms()?;

        update_credential_reference(&mut transaction, location, descriptor.owner_id(), None)
            .await?;
        update_proxy_after_credential_change(&mut transaction, proxy_id, expected_version, now_ms)
            .await?;
        enqueue_credential_cleanup(&mut transaction, &old_reference, descriptor, now_ms).await?;

        let profile = load_proxy(&mut transaction, proxy_id).await?;
        transaction.commit().await.map_err(database_error)?;
        Ok(profile)
    }

    pub(crate) async fn pending_credential_cleanup(
        &self,
    ) -> Result<Vec<PendingCredentialCleanup>, ConfigurationRepositoryError> {
        let mut transaction = self.pool.begin().await.map_err(database_error)?;
        let rows = sqlx::query(
            "SELECT credential_reference, owner_kind, owner_id, credential_kind, queued_at_ms
             FROM credential_cleanup_queue
             ORDER BY queued_at_ms, credential_reference
             LIMIT 64",
        )
        .fetch_all(&mut *transaction)
        .await
        .map_err(database_error)?;
        let mut pending = Vec::with_capacity(rows.len());
        for row in rows {
            let item = decode_pending_cleanup(row)?;
            if credential_reference_is_active(&mut transaction, &item.reference).await? {
                return Err(ConfigurationRepositoryError::Corrupt);
            }
            pending.push(item);
        }
        transaction.commit().await.map_err(database_error)?;
        Ok(pending)
    }

    pub(crate) async fn pending_credential_cleanup_by_reference(
        &self,
        reference: &CredentialReference,
    ) -> Result<Option<PendingCredentialCleanup>, ConfigurationRepositoryError> {
        require_canonical_credential_reference(reference)?;
        let mut transaction = self.pool.begin().await.map_err(database_error)?;
        let row = sqlx::query(
            "SELECT credential_reference, owner_kind, owner_id, credential_kind, queued_at_ms
             FROM credential_cleanup_queue WHERE credential_reference = ?",
        )
        .bind(reference.as_str())
        .fetch_optional(&mut *transaction)
        .await
        .map_err(database_error)?;
        let Some(row) = row else {
            transaction.commit().await.map_err(database_error)?;
            return Ok(None);
        };
        let pending = decode_pending_cleanup(row)?;
        if &pending.reference != reference
            || credential_reference_is_active(&mut transaction, reference).await?
        {
            return Err(ConfigurationRepositoryError::Corrupt);
        }
        transaction.commit().await.map_err(database_error)?;
        Ok(Some(pending))
    }

    pub(crate) async fn complete_credential_cleanup(
        &self,
        pending: &PendingCredentialCleanup,
    ) -> Result<(), ConfigurationRepositoryError> {
        require_canonical_credential_reference(&pending.reference)?;
        require_canonical_descriptor(pending.descriptor)?;
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database_error)?;
        if credential_reference_is_active(&mut transaction, &pending.reference).await? {
            return Err(ConfigurationRepositoryError::Corrupt);
        }
        let stored = sqlx::query(
            "SELECT credential_reference, owner_kind, owner_id, credential_kind, queued_at_ms
             FROM credential_cleanup_queue WHERE credential_reference = ?",
        )
        .bind(pending.reference.as_str())
        .fetch_optional(&mut *transaction)
        .await
        .map_err(database_error)?;
        let Some(stored) = stored else {
            transaction.commit().await.map_err(database_error)?;
            return Ok(());
        };
        let stored = decode_pending_cleanup(stored)?;
        if &stored != pending {
            return Err(ConfigurationRepositoryError::Corrupt);
        }
        let removed = sqlx::query(
            "DELETE FROM credential_cleanup_queue
             WHERE credential_reference = ? AND owner_kind = ? AND owner_id = ?
                   AND credential_kind = ?",
        )
        .bind(pending.reference.as_str())
        .bind(pending.descriptor.owner_kind())
        .bind(pending.descriptor.owner_id().to_string())
        .bind(pending.descriptor.credential_kind())
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?
        .rows_affected();
        if removed != 1 {
            return Err(ConfigurationRepositoryError::Corrupt);
        }
        transaction.commit().await.map_err(database_error)
    }

    pub(crate) async fn snapshot(
        &self,
    ) -> Result<ConfigurationSnapshot, ConfigurationRepositoryError> {
        let mut transaction = self.pool.begin().await.map_err(database_error)?;
        if sqlx::query("PRAGMA foreign_key_check")
            .fetch_optional(&mut *transaction)
            .await
            .map_err(database_error)?
            .is_some()
        {
            return Err(ConfigurationRepositoryError::Corrupt);
        }
        let proxies = load_proxies(&mut transaction).await?;
        let servers = load_servers(&mut transaction).await?;
        transaction.commit().await.map_err(database_error)?;
        Ok(ConfigurationSnapshot { servers, proxies })
    }

    pub(crate) async fn connection_plan(
        &self,
        server_id: ServerId,
    ) -> Result<super::ServerConnectionPlan, ConfigurationRepositoryError> {
        let mut transaction = self.pool.begin().await.map_err(database_error)?;
        let server = load_server(&mut transaction, server_id).await?;
        let server_kind = server_type(&server.configuration);
        let server_credential = required_server_connection_credential(
            load_server_credentials_for_cleanup(&mut transaction, server_id, server_kind).await?,
            &server.configuration,
        )?;
        if let Some(binding) = &server_credential {
            validate_active_connection_credential(&mut transaction, binding).await?;
        }
        let proxy = match &server.configuration {
            ServerConfiguration::RemoteWebSocket {
                proxy_id: Some(proxy_id),
                ..
            } => Some(
                load_proxy_connection_plan(&mut transaction, *proxy_id)
                    .await
                    .map_err(|error| match error {
                        ConfigurationRepositoryError::ProxyNotFound => {
                            ConfigurationRepositoryError::Corrupt
                        }
                        error => error,
                    })?,
            ),
            _ => None,
        };
        transaction.commit().await.map_err(database_error)?;
        Ok(super::ServerConnectionPlan {
            server_id: server.server_id,
            server_version: server.version,
            configuration: server.configuration,
            credential: server_credential,
            proxy,
        })
    }

    pub(crate) async fn server_connection_test_plan(
        &self,
        configuration: ServerConfiguration,
        stored_credential: Option<(ServerId, u64)>,
    ) -> Result<super::DraftServerConnectionPlan, ConfigurationRepositoryError> {
        let mut transaction = self.pool.begin().await.map_err(database_error)?;
        let credential = match stored_credential {
            None => None,
            Some((server_id, expected_version)) => {
                version_to_i64(expected_version)?;
                let server = load_server(&mut transaction, server_id).await?;
                if server.version != expected_version {
                    return Err(ConfigurationRepositoryError::ServerVersionConflict);
                }
                if !server_credential_binding_matches_draft(&server.configuration, &configuration)?
                {
                    return Err(ConfigurationRepositoryError::CredentialConfigurationMismatch);
                }
                let server_kind = server_type(&server.configuration);
                let binding = required_server_connection_credential(
                    load_server_credentials_for_cleanup(&mut transaction, server_id, server_kind)
                        .await?,
                    &server.configuration,
                )?
                .ok_or(ConfigurationRepositoryError::CredentialNotConfigured)?;
                validate_active_connection_credential(&mut transaction, &binding).await?;
                Some(binding)
            }
        };
        let proxy = match &configuration {
            ServerConfiguration::RemoteWebSocket {
                proxy_id: Some(proxy_id),
                ..
            } => Some(load_proxy_connection_plan(&mut transaction, *proxy_id).await?),
            _ => None,
        };
        transaction.commit().await.map_err(database_error)?;
        Ok(super::DraftServerConnectionPlan {
            configuration,
            credential,
            proxy,
        })
    }

    pub(crate) async fn proxy_connection_test_plan(
        &self,
        proxy_id: ProxyId,
        expected_version: u64,
        configuration: &ProxyConfiguration,
    ) -> Result<super::ProxyConnectionPlan, ConfigurationRepositoryError> {
        let expected_version = version_to_i64(expected_version)?;
        let mut transaction = self.pool.begin().await.map_err(database_error)?;
        let (old_type, current_version, _) =
            load_proxy_identity(&mut transaction, proxy_id).await?;
        if current_version != expected_version {
            return Err(ConfigurationRepositoryError::ProxyVersionConflict);
        }
        if old_type == "ssh" {
            require_ssh_host_key_change_allowed(&mut transaction, proxy_id, configuration).await?;
        }
        require_proxy_credential_compatibility(
            &mut transaction,
            proxy_id,
            &old_type,
            configuration,
        )
        .await?;
        let plan = load_proxy_connection_plan(&mut transaction, proxy_id).await?;
        transaction.commit().await.map_err(database_error)?;
        Ok(plan)
    }

    pub(crate) async fn create_server(
        &self,
        request: CreateServerProfileRequest,
    ) -> Result<ServerProfile, ConfigurationRepositoryError> {
        let write = request.validate()?;
        let server_id = ServerId::new();
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database_error)?;
        let now_ms = current_time_ms()?;

        require_remote_proxy(&mut transaction, &write.configuration).await?;
        sqlx::query(
            "INSERT INTO servers
             (server_id, name, server_type, created_at_ms, updated_at_ms)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(server_id.0.to_string())
        .bind(&write.name)
        .bind(server_type(&write.configuration))
        .bind(now_ms)
        .bind(now_ms)
        .execute(&mut *transaction)
        .await
        .map_err(map_server_write_error)?;
        insert_server_configuration(&mut transaction, server_id, &write.configuration).await?;

        let profile = load_server(&mut transaction, server_id).await?;
        transaction.commit().await.map_err(database_error)?;
        Ok(profile)
    }

    pub(crate) async fn update_server(
        &self,
        request: UpdateServerProfileRequest,
    ) -> Result<ServerProfile, ConfigurationRepositoryError> {
        let server_id = request.server_id;
        let expected_version = request.expected_version;
        let write = request.validate()?;
        let expected_version = version_to_i64(expected_version)?;
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database_error)?;
        let now_ms = current_time_ms()?;

        let (old_type, current_version, updated_at_ms) =
            load_server_identity(&mut transaction, server_id).await?;
        if current_version != expected_version {
            return Err(ConfigurationRepositoryError::ServerVersionConflict);
        }
        require_incrementable_version(
            current_version,
            ConfigurationRepositoryError::ServerVersionConflict,
        )?;
        require_incrementable_timestamp(updated_at_ms)?;
        require_remote_proxy(&mut transaction, &write.configuration).await?;

        let new_type = server_type(&write.configuration);
        require_server_credential_compatibility(
            &mut transaction,
            server_id,
            &old_type,
            &write.configuration,
        )
        .await?;
        if old_type != new_type {
            delete_server_configuration(&mut transaction, server_id, &old_type).await?;
        }
        let result = sqlx::query(
            "UPDATE servers
             SET name = ?, server_type = ?, version = version + 1,
                 updated_at_ms = MAX(updated_at_ms + 1, ?)
             WHERE server_id = ? AND version = ? AND version < ?",
        )
        .bind(&write.name)
        .bind(new_type)
        .bind(now_ms)
        .bind(server_id.0.to_string())
        .bind(expected_version)
        .bind(MAX_SAFE_INTEGER)
        .execute(&mut *transaction)
        .await
        .map_err(map_server_write_error)?;
        if result.rows_affected() != 1 {
            return Err(ConfigurationRepositoryError::ServerVersionConflict);
        }

        if old_type == new_type {
            update_server_configuration(&mut transaction, server_id, &write.configuration).await?;
        } else {
            insert_server_configuration(&mut transaction, server_id, &write.configuration).await?;
        }

        let profile = load_server(&mut transaction, server_id).await?;
        transaction.commit().await.map_err(database_error)?;
        Ok(profile)
    }

    pub(crate) async fn delete_server(
        &self,
        request: DeleteServerProfileRequest,
    ) -> Result<(), ConfigurationRepositoryError> {
        request.validate()?;
        let expected_version = version_to_i64(request.expected_version)?;
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database_error)?;

        let (old_type, current_version, _) =
            load_server_identity(&mut transaction, request.server_id).await?;
        if current_version != expected_version {
            return Err(ConfigurationRepositoryError::ServerVersionConflict);
        }
        if active_window_count(&mut transaction, request.server_id).await? > 0 {
            return Err(ConfigurationRepositoryError::ServerInUse);
        }
        let credentials =
            load_server_credentials_for_cleanup(&mut transaction, request.server_id, &old_type)
                .await?;
        let now_ms = current_time_ms()?;
        clear_persisted_window_server(&mut transaction, request.server_id, now_ms).await?;
        for (reference, descriptor) in credentials {
            enqueue_credential_cleanup(&mut transaction, &reference, descriptor, now_ms).await?;
        }

        let result = sqlx::query("DELETE FROM servers WHERE server_id = ? AND version = ?")
            .bind(request.server_id.0.to_string())
            .bind(expected_version)
            .execute(&mut *transaction)
            .await
            .map_err(|error| {
                if is_foreign_key_violation(&error) {
                    ConfigurationRepositoryError::ServerInUse
                } else {
                    database_error(error)
                }
            })?;
        if result.rows_affected() != 1 {
            return Err(ConfigurationRepositoryError::ServerVersionConflict);
        }
        transaction.commit().await.map_err(database_error)
    }

    pub(crate) async fn create_proxy(
        &self,
        request: CreateProxyProfileRequest,
    ) -> Result<ProxyProfile, ConfigurationRepositoryError> {
        let write = validate_create_proxy(request).await?;
        let proxy_id = ProxyId::new();
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database_error)?;
        let now_ms = current_time_ms()?;

        sqlx::query(
            "INSERT INTO proxies
             (proxy_id, name, proxy_type, created_at_ms, updated_at_ms)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(proxy_id.0.to_string())
        .bind(&write.name)
        .bind(proxy_type(&write.configuration))
        .bind(now_ms)
        .bind(now_ms)
        .execute(&mut *transaction)
        .await
        .map_err(map_proxy_write_error)?;
        insert_proxy_configuration(&mut transaction, proxy_id, &write.configuration).await?;

        let profile = load_proxy(&mut transaction, proxy_id).await?;
        transaction.commit().await.map_err(database_error)?;
        Ok(profile)
    }

    pub(crate) async fn update_proxy(
        &self,
        request: UpdateProxyProfileRequest,
    ) -> Result<ProxyProfile, ConfigurationRepositoryError> {
        let proxy_id = request.proxy_id;
        let expected_version = request.expected_version;
        let write = validate_update_proxy(request).await?;
        let expected_version = version_to_i64(expected_version)?;
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database_error)?;
        let now_ms = current_time_ms()?;

        let (old_type, current_version, updated_at_ms) =
            load_proxy_identity(&mut transaction, proxy_id).await?;
        if current_version != expected_version {
            return Err(ConfigurationRepositoryError::ProxyVersionConflict);
        }
        require_incrementable_version(
            current_version,
            ConfigurationRepositoryError::ProxyVersionConflict,
        )?;
        require_incrementable_timestamp(updated_at_ms)?;
        let new_type = proxy_type(&write.configuration);
        if old_type == "ssh" {
            require_ssh_host_key_change_allowed(&mut transaction, proxy_id, &write.configuration)
                .await?;
        }
        require_proxy_credential_compatibility(
            &mut transaction,
            proxy_id,
            &old_type,
            &write.configuration,
        )
        .await?;
        if old_type != new_type {
            delete_proxy_configuration(&mut transaction, proxy_id, &old_type).await?;
        }

        let result = sqlx::query(
            "UPDATE proxies
             SET name = ?, proxy_type = ?, version = version + 1,
                 last_test_status = NULL, last_tested_at_ms = NULL,
                 updated_at_ms = MAX(updated_at_ms + 1, ?)
             WHERE proxy_id = ? AND version = ? AND version < ?",
        )
        .bind(&write.name)
        .bind(new_type)
        .bind(now_ms)
        .bind(proxy_id.0.to_string())
        .bind(expected_version)
        .bind(MAX_SAFE_INTEGER)
        .execute(&mut *transaction)
        .await
        .map_err(map_proxy_write_error)?;
        if result.rows_affected() != 1 {
            return Err(ConfigurationRepositoryError::ProxyVersionConflict);
        }

        if old_type == new_type {
            update_proxy_configuration(&mut transaction, proxy_id, &write.configuration).await?;
        } else {
            insert_proxy_configuration(&mut transaction, proxy_id, &write.configuration).await?;
        }

        let profile = load_proxy(&mut transaction, proxy_id).await?;
        transaction.commit().await.map_err(database_error)?;
        Ok(profile)
    }

    pub(crate) async fn delete_proxy(
        &self,
        request: DeleteProxyProfileRequest,
    ) -> Result<(), ConfigurationRepositoryError> {
        request.validate()?;
        let expected_version = version_to_i64(request.expected_version)?;
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database_error)?;

        let (old_type, current_version, _) =
            load_proxy_identity(&mut transaction, request.proxy_id).await?;
        if current_version != expected_version {
            return Err(ConfigurationRepositoryError::ProxyVersionConflict);
        }
        if referenced_server_count(&mut transaction, request.proxy_id).await? > 0 {
            return Err(ConfigurationRepositoryError::ProxyReferenced);
        }
        let credentials =
            load_proxy_credentials_for_cleanup(&mut transaction, request.proxy_id, &old_type)
                .await?;
        let now_ms = current_time_ms()?;
        for (reference, descriptor) in credentials {
            enqueue_credential_cleanup(&mut transaction, &reference, descriptor, now_ms).await?;
        }

        let result = sqlx::query("DELETE FROM proxies WHERE proxy_id = ? AND version = ?")
            .bind(request.proxy_id.0.to_string())
            .bind(expected_version)
            .execute(&mut *transaction)
            .await
            .map_err(|error| {
                if is_foreign_key_violation(&error) {
                    ConfigurationRepositoryError::ProxyReferenced
                } else {
                    database_error(error)
                }
            })?;
        if result.rows_affected() != 1 {
            return Err(ConfigurationRepositoryError::ProxyVersionConflict);
        }
        transaction.commit().await.map_err(database_error)
    }

    pub(crate) async fn remove_proxy_ssh_host_key(
        &self,
        request: RemoveProxySshHostKeyRequest,
    ) -> Result<ProxyProfile, ConfigurationRepositoryError> {
        request.validate()?;
        let expected_version = version_to_i64(request.expected_version)?;
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database_error)?;
        let now_ms = current_time_ms()?;

        let (_, current_version, updated_at_ms) =
            load_proxy_identity(&mut transaction, request.proxy_id).await?;
        if current_version != expected_version {
            return Err(ConfigurationRepositoryError::ProxyVersionConflict);
        }
        require_incrementable_version(
            current_version,
            ConfigurationRepositoryError::ProxyVersionConflict,
        )?;
        require_incrementable_timestamp(updated_at_ms)?;
        let removed = sqlx::query("DELETE FROM ssh_host_keys WHERE proxy_id = ?")
            .bind(request.proxy_id.0.to_string())
            .execute(&mut *transaction)
            .await
            .map_err(database_error)?
            .rows_affected();
        if removed != 1 {
            return Err(ConfigurationRepositoryError::SshHostKeyNotFound);
        }
        let updated = sqlx::query(
            "UPDATE proxies
             SET version = version + 1, last_test_status = NULL, last_tested_at_ms = NULL,
                 updated_at_ms = MAX(updated_at_ms + 1, ?)
             WHERE proxy_id = ? AND version = ? AND version < ?",
        )
        .bind(now_ms)
        .bind(request.proxy_id.0.to_string())
        .bind(expected_version)
        .bind(MAX_SAFE_INTEGER)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?
        .rows_affected();
        if updated != 1 {
            return Err(ConfigurationRepositoryError::ProxyVersionConflict);
        }
        let profile = load_proxy(&mut transaction, request.proxy_id).await?;
        transaction.commit().await.map_err(database_error)?;
        Ok(profile)
    }

    pub(crate) async fn confirm_proxy_ssh_host_key(
        &self,
        request: ConfirmProxySshHostKeyRequest,
    ) -> Result<ProxyProfile, ConfigurationRepositoryError> {
        request.validate()?;
        let expected_version = version_to_i64(request.expected_version)?;
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database_error)?;
        let now_ms = current_time_ms()?;

        let (proxy_type, current_version, updated_at_ms) =
            load_proxy_identity(&mut transaction, request.proxy_id).await?;
        if current_version != expected_version {
            return Err(ConfigurationRepositoryError::ProxyVersionConflict);
        }
        if proxy_type != "ssh" {
            return Err(ConfigurationRepositoryError::CredentialConfigurationMismatch);
        }
        require_incrementable_version(
            current_version,
            ConfigurationRepositoryError::ProxyVersionConflict,
        )?;
        require_incrementable_timestamp(updated_at_ms)?;
        let endpoint = sqlx::query("SELECT host, port FROM ssh_proxy_configs WHERE proxy_id = ?")
            .bind(request.proxy_id.0.to_string())
            .fetch_optional(&mut *transaction)
            .await
            .map_err(database_error)?
            .ok_or(ConfigurationRepositoryError::Corrupt)?;
        let configured_host: String = decode(&endpoint, "host")?;
        let configured_port = decode_port(decode(&endpoint, "port")?)?;
        if configured_host != request.host || configured_port != request.port {
            return Err(ConfigurationRepositoryError::CredentialConfigurationMismatch);
        }
        let result = sqlx::query(
            "INSERT INTO ssh_host_keys
             (proxy_id, host, port, algorithm, sha256_fingerprint, confirmed_at_ms)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(request.proxy_id.0.to_string())
        .bind(&request.host)
        .bind(i64::from(request.port))
        .bind(&request.algorithm)
        .bind(&request.sha256_fingerprint)
        .bind(now_ms)
        .execute(&mut *transaction)
        .await
        .map_err(|error| {
            if is_unique_violation(&error) {
                ConfigurationRepositoryError::SshHostKeyRemovalRequired
            } else {
                database_error(error)
            }
        })?;
        if result.rows_affected() != 1 {
            return Err(ConfigurationRepositoryError::Corrupt);
        }
        let updated = sqlx::query(
            "UPDATE proxies
             SET version = version + 1, updated_at_ms = MAX(updated_at_ms + 1, ?)
             WHERE proxy_id = ? AND version = ? AND version < ?",
        )
        .bind(now_ms)
        .bind(request.proxy_id.0.to_string())
        .bind(expected_version)
        .bind(MAX_SAFE_INTEGER)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        if updated.rows_affected() != 1 {
            return Err(ConfigurationRepositoryError::ProxyVersionConflict);
        }
        let profile = load_proxy(&mut transaction, request.proxy_id).await?;
        transaction.commit().await.map_err(database_error)?;
        Ok(profile)
    }

    pub(crate) async fn record_proxy_test(
        &self,
        request: RecordProxyTestRequest,
    ) -> Result<ProxyProfile, ConfigurationRepositoryError> {
        request.validate()?;
        let expected_version = version_to_i64(request.expected_version)?;
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database_error)?;
        let (_, current_version, _) =
            load_proxy_identity(&mut transaction, request.proxy_id).await?;
        if current_version != expected_version {
            return Err(ConfigurationRepositoryError::ProxyVersionConflict);
        }
        let tested_at_ms = current_time_ms()?;
        let status = match request.status {
            ProxyTestStatus::Succeeded => "succeeded",
            ProxyTestStatus::Failed => "failed",
        };
        let updated = sqlx::query(
            "UPDATE proxies SET last_test_status = ?, last_tested_at_ms = ?
             WHERE proxy_id = ? AND version = ?",
        )
        .bind(status)
        .bind(tested_at_ms)
        .bind(request.proxy_id.0.to_string())
        .bind(expected_version)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        if updated.rows_affected() != 1 {
            return Err(ConfigurationRepositoryError::ProxyVersionConflict);
        }
        let profile = load_proxy(&mut transaction, request.proxy_id).await?;
        transaction.commit().await.map_err(database_error)?;
        Ok(profile)
    }
}

#[derive(Clone, Copy)]
enum CredentialLocation {
    LocalSensitiveEnvironment,
    RemoteBearerToken,
    HttpProxy,
    Socks5Proxy,
    SshPrivateKeyPassphrase,
    SshPassword,
}

async fn load_server_credential_state(
    connection: &mut SqliteConnection,
    descriptor: CredentialDescriptor,
    server_type: &str,
) -> Result<(CredentialLocation, Option<CredentialReference>), ConfigurationRepositoryError> {
    let CredentialDescriptor::Server { server_id, kind } = descriptor else {
        return Err(ConfigurationRepositoryError::CredentialConfigurationMismatch);
    };
    match (server_type, kind) {
        ("local", ServerCredentialKind::SensitiveEnvironment) => {
            let reference: Option<String> = sqlx::query_scalar(
                "SELECT sensitive_environment_credential_reference
                 FROM local_server_configs WHERE server_id = ?",
            )
            .bind(server_id.to_string())
            .fetch_optional(&mut *connection)
            .await
            .map_err(database_error)?
            .ok_or(ConfigurationRepositoryError::Corrupt)?;
            Ok((
                CredentialLocation::LocalSensitiveEnvironment,
                decode_optional_credential_reference(reference)?,
            ))
        }
        ("remote", ServerCredentialKind::BearerToken) => {
            let row = sqlx::query(
                "SELECT authentication_method, credential_reference
                 FROM remote_server_configs WHERE server_id = ?",
            )
            .bind(server_id.to_string())
            .fetch_optional(&mut *connection)
            .await
            .map_err(database_error)?
            .ok_or(ConfigurationRepositoryError::Corrupt)?;
            let authentication: String = decode(&row, "authentication_method")?;
            match decode_remote_authentication(authentication)? {
                RemoteServerAuthentication::Bearer => Ok((
                    CredentialLocation::RemoteBearerToken,
                    decode_optional_credential_reference(decode(&row, "credential_reference")?)?,
                )),
                RemoteServerAuthentication::None => {
                    Err(ConfigurationRepositoryError::CredentialConfigurationMismatch)
                }
            }
        }
        ("local" | "remote", _) => {
            Err(ConfigurationRepositoryError::CredentialConfigurationMismatch)
        }
        _ => Err(ConfigurationRepositoryError::Corrupt),
    }
}

async fn load_proxy_credential_state(
    connection: &mut SqliteConnection,
    descriptor: CredentialDescriptor,
    proxy_type: &str,
) -> Result<(CredentialLocation, Option<CredentialReference>), ConfigurationRepositoryError> {
    let CredentialDescriptor::Proxy { proxy_id, kind } = descriptor else {
        return Err(ConfigurationRepositoryError::CredentialConfigurationMismatch);
    };
    match proxy_type {
        "http" => {
            let row = sqlx::query(
                "SELECT authentication_method, credential_reference
                 FROM http_proxy_configs WHERE proxy_id = ?",
            )
            .bind(proxy_id.to_string())
            .fetch_optional(&mut *connection)
            .await
            .map_err(database_error)?
            .ok_or(ConfigurationRepositoryError::Corrupt)?;
            let authentication =
                decode_http_authentication(decode(&row, "authentication_method")?)?;
            let expected_kind = match authentication {
                HttpProxyAuthentication::Basic => ProxyCredentialKind::HttpBasicPassword,
                HttpProxyAuthentication::Bearer => ProxyCredentialKind::HttpBearerToken,
                HttpProxyAuthentication::None => {
                    return Err(ConfigurationRepositoryError::CredentialConfigurationMismatch);
                }
            };
            if kind != expected_kind {
                return Err(ConfigurationRepositoryError::CredentialConfigurationMismatch);
            }
            Ok((
                CredentialLocation::HttpProxy,
                decode_optional_credential_reference(decode(&row, "credential_reference")?)?,
            ))
        }
        "socks5" => {
            let row = sqlx::query(
                "SELECT authentication_method, credential_reference
                 FROM socks_proxy_configs WHERE proxy_id = ?",
            )
            .bind(proxy_id.to_string())
            .fetch_optional(&mut *connection)
            .await
            .map_err(database_error)?
            .ok_or(ConfigurationRepositoryError::Corrupt)?;
            let authentication =
                decode_socks_authentication(decode(&row, "authentication_method")?)?;
            if authentication != Socks5Authentication::UsernamePassword
                || kind != ProxyCredentialKind::Socks5Password
            {
                return Err(ConfigurationRepositoryError::CredentialConfigurationMismatch);
            }
            Ok((
                CredentialLocation::Socks5Proxy,
                decode_optional_credential_reference(decode(&row, "credential_reference")?)?,
            ))
        }
        "ssh" => {
            let row = sqlx::query(
                "SELECT authentication_method, private_key_path,
                        key_passphrase_credential_reference, password_credential_reference
                 FROM ssh_proxy_configs WHERE proxy_id = ?",
            )
            .bind(proxy_id.to_string())
            .fetch_optional(&mut *connection)
            .await
            .map_err(database_error)?
            .ok_or(ConfigurationRepositoryError::Corrupt)?;
            let authentication = decode_ssh_authentication(
                decode(&row, "authentication_method")?,
                decode(&row, "private_key_path")?,
            )?;
            let key_reference = decode_optional_credential_reference(decode(
                &row,
                "key_passphrase_credential_reference",
            )?)?;
            let password_reference = decode_optional_credential_reference(decode(
                &row,
                "password_credential_reference",
            )?)?;
            match authentication {
                SshAuthenticationConfiguration::Agent {} => {
                    if key_reference.is_some() || password_reference.is_some() {
                        Err(ConfigurationRepositoryError::Corrupt)
                    } else {
                        Err(ConfigurationRepositoryError::CredentialConfigurationMismatch)
                    }
                }
                SshAuthenticationConfiguration::PrivateKey { .. } => {
                    if password_reference.is_some() {
                        Err(ConfigurationRepositoryError::Corrupt)
                    } else if kind == ProxyCredentialKind::SshPrivateKeyPassphrase {
                        Ok((CredentialLocation::SshPrivateKeyPassphrase, key_reference))
                    } else {
                        Err(ConfigurationRepositoryError::CredentialConfigurationMismatch)
                    }
                }
                SshAuthenticationConfiguration::Password {} => {
                    if key_reference.is_some() {
                        Err(ConfigurationRepositoryError::Corrupt)
                    } else if kind == ProxyCredentialKind::SshPassword {
                        Ok((CredentialLocation::SshPassword, password_reference))
                    } else {
                        Err(ConfigurationRepositoryError::CredentialConfigurationMismatch)
                    }
                }
            }
        }
        _ => Err(ConfigurationRepositoryError::Corrupt),
    }
}

async fn validate_sensitive_environment_names(
    connection: &mut SqliteConnection,
    descriptor: CredentialDescriptor,
    sensitive_environment_names: Option<&BTreeSet<String>>,
) -> Result<(), ConfigurationRepositoryError> {
    let CredentialDescriptor::Server {
        server_id,
        kind: ServerCredentialKind::SensitiveEnvironment,
    } = descriptor
    else {
        return if sensitive_environment_names.is_none() {
            Ok(())
        } else {
            Err(ConfigurationRepositoryError::CredentialConfigurationMismatch)
        };
    };
    let sensitive_environment_names = sensitive_environment_names
        .ok_or(ConfigurationRepositoryError::CredentialConfigurationMismatch)?;
    let environment_json: String = sqlx::query_scalar(
        "SELECT non_sensitive_environment_json
         FROM local_server_configs WHERE server_id = ?",
    )
    .bind(server_id.to_string())
    .fetch_optional(&mut *connection)
    .await
    .map_err(database_error)?
    .ok_or(ConfigurationRepositoryError::Corrupt)?;
    let non_sensitive_environment: BTreeMap<String, String> = decode_json(environment_json)?;
    if sensitive_environment_names
        .iter()
        .any(|name| non_sensitive_environment.contains_key(name))
    {
        Err(ConfigurationRepositoryError::CredentialConfigurationMismatch)
    } else {
        Ok(())
    }
}

async fn update_credential_reference(
    connection: &mut SqliteConnection,
    location: CredentialLocation,
    owner_id: Uuid,
    reference: Option<&CredentialReference>,
) -> Result<(), ConfigurationRepositoryError> {
    let reference = reference.map(CredentialReference::as_str);
    let result = match location {
        CredentialLocation::LocalSensitiveEnvironment => sqlx::query(
            "UPDATE local_server_configs
             SET sensitive_environment_credential_reference = ? WHERE server_id = ?",
        ),
        CredentialLocation::RemoteBearerToken => sqlx::query(
            "UPDATE remote_server_configs SET credential_reference = ? WHERE server_id = ?",
        ),
        CredentialLocation::HttpProxy => {
            sqlx::query("UPDATE http_proxy_configs SET credential_reference = ? WHERE proxy_id = ?")
        }
        CredentialLocation::Socks5Proxy => sqlx::query(
            "UPDATE socks_proxy_configs SET credential_reference = ? WHERE proxy_id = ?",
        ),
        CredentialLocation::SshPrivateKeyPassphrase => sqlx::query(
            "UPDATE ssh_proxy_configs
             SET key_passphrase_credential_reference = ? WHERE proxy_id = ?",
        ),
        CredentialLocation::SshPassword => sqlx::query(
            "UPDATE ssh_proxy_configs SET password_credential_reference = ? WHERE proxy_id = ?",
        ),
    }
    .bind(reference)
    .bind(owner_id.to_string())
    .execute(&mut *connection)
    .await
    .map_err(database_error)?;
    if result.rows_affected() == 1 {
        Ok(())
    } else {
        Err(ConfigurationRepositoryError::Corrupt)
    }
}

async fn update_server_after_credential_change(
    connection: &mut SqliteConnection,
    server_id: ServerId,
    expected_version: i64,
    now_ms: i64,
) -> Result<(), ConfigurationRepositoryError> {
    let updated = sqlx::query(
        "UPDATE servers
         SET version = version + 1, updated_at_ms = MAX(updated_at_ms + 1, ?)
         WHERE server_id = ? AND version = ? AND version < ?",
    )
    .bind(now_ms)
    .bind(server_id.0.to_string())
    .bind(expected_version)
    .bind(MAX_SAFE_INTEGER)
    .execute(&mut *connection)
    .await
    .map_err(database_error)?
    .rows_affected();
    if updated == 1 {
        Ok(())
    } else {
        Err(ConfigurationRepositoryError::ServerVersionConflict)
    }
}

async fn update_proxy_after_credential_change(
    connection: &mut SqliteConnection,
    proxy_id: ProxyId,
    expected_version: i64,
    now_ms: i64,
) -> Result<(), ConfigurationRepositoryError> {
    let updated = sqlx::query(
        "UPDATE proxies
         SET version = version + 1, last_test_status = NULL, last_tested_at_ms = NULL,
             updated_at_ms = MAX(updated_at_ms + 1, ?)
         WHERE proxy_id = ? AND version = ? AND version < ?",
    )
    .bind(now_ms)
    .bind(proxy_id.0.to_string())
    .bind(expected_version)
    .bind(MAX_SAFE_INTEGER)
    .execute(&mut *connection)
    .await
    .map_err(database_error)?
    .rows_affected();
    if updated == 1 {
        Ok(())
    } else {
        Err(ConfigurationRepositoryError::ProxyVersionConflict)
    }
}

async fn enqueue_credential_cleanup(
    connection: &mut SqliteConnection,
    reference: &CredentialReference,
    descriptor: CredentialDescriptor,
    queued_at_ms: i64,
) -> Result<(), ConfigurationRepositoryError> {
    require_canonical_credential_reference(reference)?;
    require_canonical_descriptor(descriptor)?;
    decode_timestamp(queued_at_ms)?;
    sqlx::query(
        "INSERT INTO credential_cleanup_queue
         (credential_reference, owner_kind, owner_id, credential_kind, queued_at_ms)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(reference.as_str())
    .bind(descriptor.owner_kind())
    .bind(descriptor.owner_id().to_string())
    .bind(descriptor.credential_kind())
    .bind(queued_at_ms)
    .execute(&mut *connection)
    .await
    .map_err(map_credential_queue_write_error)?;
    Ok(())
}

async fn require_reserved_credential(
    connection: &mut SqliteConnection,
    reference: &CredentialReference,
    descriptor: CredentialDescriptor,
) -> Result<(), ConfigurationRepositoryError> {
    let exists: i64 = sqlx::query_scalar(
        "SELECT EXISTS(
             SELECT 1 FROM credential_cleanup_queue
             WHERE credential_reference = ? AND owner_kind = ? AND owner_id = ?
                   AND credential_kind = ?
         )",
    )
    .bind(reference.as_str())
    .bind(descriptor.owner_kind())
    .bind(descriptor.owner_id().to_string())
    .bind(descriptor.credential_kind())
    .fetch_one(&mut *connection)
    .await
    .map_err(database_error)?;
    if exists == 1 {
        Ok(())
    } else {
        Err(ConfigurationRepositoryError::Corrupt)
    }
}

async fn remove_reserved_credential(
    connection: &mut SqliteConnection,
    reference: &CredentialReference,
    descriptor: CredentialDescriptor,
) -> Result<(), ConfigurationRepositoryError> {
    let removed = sqlx::query(
        "DELETE FROM credential_cleanup_queue
         WHERE credential_reference = ? AND owner_kind = ? AND owner_id = ?
               AND credential_kind = ?",
    )
    .bind(reference.as_str())
    .bind(descriptor.owner_kind())
    .bind(descriptor.owner_id().to_string())
    .bind(descriptor.credential_kind())
    .execute(&mut *connection)
    .await
    .map_err(database_error)?
    .rows_affected();
    if removed == 1 {
        Ok(())
    } else {
        Err(ConfigurationRepositoryError::Corrupt)
    }
}

fn decode_pending_cleanup(
    row: SqliteRow,
) -> Result<PendingCredentialCleanup, ConfigurationRepositoryError> {
    let reference = decode_credential_reference(decode(&row, "credential_reference")?)?;
    let owner_kind: String = decode(&row, "owner_kind")?;
    let owner_id: String = decode(&row, "owner_id")?;
    let credential_kind: String = decode(&row, "credential_kind")?;
    decode_timestamp(decode(&row, "queued_at_ms")?)?;
    let descriptor = CredentialDescriptor::parse(&owner_kind, &owner_id, &credential_kind)
        .map_err(|_| ConfigurationRepositoryError::Corrupt)?;
    Ok(PendingCredentialCleanup {
        reference,
        descriptor,
    })
}

fn require_canonical_credential_reference(
    reference: &CredentialReference,
) -> Result<(), ConfigurationRepositoryError> {
    CredentialReference::parse(reference.as_str())
        .map(|_| ())
        .map_err(|_| ConfigurationRepositoryError::Corrupt)
}

fn require_canonical_descriptor(
    descriptor: CredentialDescriptor,
) -> Result<(), ConfigurationRepositoryError> {
    let parsed = CredentialDescriptor::parse(
        descriptor.owner_kind(),
        &descriptor.owner_id().to_string(),
        descriptor.credential_kind(),
    )
    .map_err(|_| ConfigurationRepositoryError::Corrupt)?;
    if parsed == descriptor {
        Ok(())
    } else {
        Err(ConfigurationRepositoryError::Corrupt)
    }
}

fn decode_credential_reference(
    value: String,
) -> Result<CredentialReference, ConfigurationRepositoryError> {
    CredentialReference::parse(&value).map_err(|_| ConfigurationRepositoryError::Corrupt)
}

fn decode_optional_credential_reference(
    value: Option<String>,
) -> Result<Option<CredentialReference>, ConfigurationRepositoryError> {
    value.map(decode_credential_reference).transpose()
}

async fn credential_reference_is_active(
    connection: &mut SqliteConnection,
    reference: &CredentialReference,
) -> Result<bool, ConfigurationRepositoryError> {
    let active: i64 = sqlx::query_scalar(
        "SELECT EXISTS(
             SELECT 1 FROM local_server_configs
             WHERE sensitive_environment_credential_reference = ?1
             UNION ALL
             SELECT 1 FROM remote_server_configs WHERE credential_reference = ?1
             UNION ALL
             SELECT 1 FROM http_proxy_configs WHERE credential_reference = ?1
             UNION ALL
             SELECT 1 FROM socks_proxy_configs WHERE credential_reference = ?1
             UNION ALL
             SELECT 1 FROM ssh_proxy_configs
             WHERE key_passphrase_credential_reference = ?1
             UNION ALL
             SELECT 1 FROM ssh_proxy_configs WHERE password_credential_reference = ?1
         )",
    )
    .bind(reference.as_str())
    .fetch_one(&mut *connection)
    .await
    .map_err(database_error)?;
    match active {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(ConfigurationRepositoryError::Corrupt),
    }
}

async fn load_server_credentials_for_cleanup(
    connection: &mut SqliteConnection,
    server_id: ServerId,
    server_type: &str,
) -> Result<Vec<(CredentialReference, CredentialDescriptor)>, ConfigurationRepositoryError> {
    let (reference, kind) = match server_type {
        "local" => {
            let reference: Option<String> = sqlx::query_scalar(
                "SELECT sensitive_environment_credential_reference
                 FROM local_server_configs WHERE server_id = ?",
            )
            .bind(server_id.0.to_string())
            .fetch_optional(&mut *connection)
            .await
            .map_err(database_error)?
            .ok_or(ConfigurationRepositoryError::Corrupt)?;
            (
                decode_optional_credential_reference(reference)?,
                ServerCredentialKind::SensitiveEnvironment,
            )
        }
        "remote" => {
            let row = sqlx::query(
                "SELECT authentication_method, credential_reference
                 FROM remote_server_configs WHERE server_id = ?",
            )
            .bind(server_id.0.to_string())
            .fetch_optional(&mut *connection)
            .await
            .map_err(database_error)?
            .ok_or(ConfigurationRepositoryError::Corrupt)?;
            let authentication =
                decode_remote_authentication(decode(&row, "authentication_method")?)?;
            let reference =
                decode_optional_credential_reference(decode(&row, "credential_reference")?)?;
            if authentication == RemoteServerAuthentication::None && reference.is_some() {
                return Err(ConfigurationRepositoryError::Corrupt);
            }
            (reference, ServerCredentialKind::BearerToken)
        }
        _ => return Err(ConfigurationRepositoryError::Corrupt),
    };
    Ok(reference
        .map(|reference| {
            (
                reference,
                CredentialDescriptor::Server {
                    server_id: server_id.0,
                    kind,
                },
            )
        })
        .into_iter()
        .collect())
}

async fn load_proxy_credentials_for_cleanup(
    connection: &mut SqliteConnection,
    proxy_id: ProxyId,
    proxy_type: &str,
) -> Result<Vec<(CredentialReference, CredentialDescriptor)>, ConfigurationRepositoryError> {
    let credential = match proxy_type {
        "http" => {
            let row = sqlx::query(
                "SELECT authentication_method, credential_reference
                 FROM http_proxy_configs WHERE proxy_id = ?",
            )
            .bind(proxy_id.0.to_string())
            .fetch_optional(&mut *connection)
            .await
            .map_err(database_error)?
            .ok_or(ConfigurationRepositoryError::Corrupt)?;
            let authentication =
                decode_http_authentication(decode(&row, "authentication_method")?)?;
            let reference =
                decode_optional_credential_reference(decode(&row, "credential_reference")?)?;
            let kind = match authentication {
                HttpProxyAuthentication::None if reference.is_none() => return Ok(Vec::new()),
                HttpProxyAuthentication::None => {
                    return Err(ConfigurationRepositoryError::Corrupt);
                }
                HttpProxyAuthentication::Basic => ProxyCredentialKind::HttpBasicPassword,
                HttpProxyAuthentication::Bearer => ProxyCredentialKind::HttpBearerToken,
            };
            reference.map(|reference| (reference, kind))
        }
        "socks5" => {
            let row = sqlx::query(
                "SELECT authentication_method, credential_reference
                 FROM socks_proxy_configs WHERE proxy_id = ?",
            )
            .bind(proxy_id.0.to_string())
            .fetch_optional(&mut *connection)
            .await
            .map_err(database_error)?
            .ok_or(ConfigurationRepositoryError::Corrupt)?;
            let authentication =
                decode_socks_authentication(decode(&row, "authentication_method")?)?;
            let reference =
                decode_optional_credential_reference(decode(&row, "credential_reference")?)?;
            if authentication == Socks5Authentication::None {
                if reference.is_some() {
                    return Err(ConfigurationRepositoryError::Corrupt);
                }
                return Ok(Vec::new());
            }
            reference.map(|reference| (reference, ProxyCredentialKind::Socks5Password))
        }
        "ssh" => {
            let row = sqlx::query(
                "SELECT authentication_method, private_key_path,
                        key_passphrase_credential_reference, password_credential_reference
                 FROM ssh_proxy_configs WHERE proxy_id = ?",
            )
            .bind(proxy_id.0.to_string())
            .fetch_optional(&mut *connection)
            .await
            .map_err(database_error)?
            .ok_or(ConfigurationRepositoryError::Corrupt)?;
            let authentication = decode_ssh_authentication(
                decode(&row, "authentication_method")?,
                decode(&row, "private_key_path")?,
            )?;
            let key_reference = decode_optional_credential_reference(decode(
                &row,
                "key_passphrase_credential_reference",
            )?)?;
            let password_reference = decode_optional_credential_reference(decode(
                &row,
                "password_credential_reference",
            )?)?;
            match authentication {
                SshAuthenticationConfiguration::Agent {}
                    if key_reference.is_none() && password_reference.is_none() =>
                {
                    None
                }
                SshAuthenticationConfiguration::PrivateKey { .. }
                    if password_reference.is_none() =>
                {
                    key_reference
                        .map(|reference| (reference, ProxyCredentialKind::SshPrivateKeyPassphrase))
                }
                SshAuthenticationConfiguration::Password {} if key_reference.is_none() => {
                    password_reference
                        .map(|reference| (reference, ProxyCredentialKind::SshPassword))
                }
                _ => return Err(ConfigurationRepositoryError::Corrupt),
            }
        }
        _ => return Err(ConfigurationRepositoryError::Corrupt),
    };
    Ok(credential
        .map(|(reference, kind)| {
            (
                reference,
                CredentialDescriptor::Proxy {
                    proxy_id: proxy_id.0,
                    kind,
                },
            )
        })
        .into_iter()
        .collect())
}

async fn load_proxy_connection_plan(
    connection: &mut SqliteConnection,
    proxy_id: ProxyId,
) -> Result<super::ProxyConnectionPlan, ConfigurationRepositoryError> {
    let proxy = load_proxy(&mut *connection, proxy_id).await?;
    let proxy_kind = proxy_type(&proxy.configuration);
    let credential = required_proxy_connection_credential(
        load_proxy_credentials_for_cleanup(&mut *connection, proxy_id, proxy_kind).await?,
        &proxy.configuration,
    )?;
    if let Some(binding) = &credential {
        validate_active_connection_credential(&mut *connection, binding).await?;
    }
    Ok(super::ProxyConnectionPlan {
        proxy_id: proxy.proxy_id,
        proxy_version: proxy.version,
        configuration: proxy.configuration,
        credential,
        ssh_host_key: proxy.ssh_host_key,
    })
}

fn server_credential_binding_matches_draft(
    stored: &ServerConfiguration,
    draft: &ServerConfiguration,
) -> Result<bool, ConfigurationRepositoryError> {
    match (stored, draft) {
        (
            ServerConfiguration::LocalStdio {
                executable_path: stored_executable_path,
                non_sensitive_environment: stored_environment,
                ..
            },
            ServerConfiguration::LocalStdio {
                executable_path: draft_executable_path,
                non_sensitive_environment: draft_environment,
                ..
            },
        ) => Ok(stored_executable_path == draft_executable_path
            && draft_environment
                .keys()
                .all(|name| stored_environment.contains_key(name))),
        (
            ServerConfiguration::RemoteWebSocket {
                url: stored_url,
                authentication: stored_authentication,
                ..
            },
            ServerConfiguration::RemoteWebSocket {
                url: draft_url,
                authentication: draft_authentication,
                ..
            },
        ) => Ok(stored_authentication == draft_authentication
            && normalized_origin(stored_url)? == normalized_origin(draft_url)?),
        _ => Ok(false),
    }
}

fn required_server_connection_credential(
    credentials: Vec<(CredentialReference, CredentialDescriptor)>,
    configuration: &ServerConfiguration,
) -> Result<Option<super::CredentialBinding>, ConfigurationRepositoryError> {
    let credential = single_connection_credential(credentials)?;
    match configuration {
        ServerConfiguration::LocalStdio { .. }
        | ServerConfiguration::RemoteWebSocket {
            authentication: RemoteServerAuthentication::None,
            ..
        } => Ok(credential),
        ServerConfiguration::RemoteWebSocket {
            authentication: RemoteServerAuthentication::Bearer,
            ..
        } => credential
            .map(Some)
            .ok_or(ConfigurationRepositoryError::CredentialNotConfigured),
    }
}

fn required_proxy_connection_credential(
    credentials: Vec<(CredentialReference, CredentialDescriptor)>,
    configuration: &ProxyConfiguration,
) -> Result<Option<super::CredentialBinding>, ConfigurationRepositoryError> {
    let credential = single_connection_credential(credentials)?;
    let is_required = match configuration {
        ProxyConfiguration::HttpConnect { authentication, .. } => {
            *authentication != HttpProxyAuthentication::None
        }
        ProxyConfiguration::Socks5 { authentication, .. } => {
            *authentication == Socks5Authentication::UsernamePassword
        }
        ProxyConfiguration::Ssh { authentication, .. } => {
            matches!(authentication, SshAuthenticationConfiguration::Password {})
        }
    };
    if is_required && credential.is_none() {
        Err(ConfigurationRepositoryError::CredentialNotConfigured)
    } else {
        Ok(credential)
    }
}

fn single_connection_credential(
    credentials: Vec<(CredentialReference, CredentialDescriptor)>,
) -> Result<Option<super::CredentialBinding>, ConfigurationRepositoryError> {
    let mut credentials = credentials.into_iter();
    let credential = credentials.next();
    if credentials.next().is_some() {
        return Err(ConfigurationRepositoryError::Corrupt);
    }
    Ok(
        credential.map(|(reference, descriptor)| super::CredentialBinding {
            reference,
            descriptor,
        }),
    )
}

async fn validate_active_connection_credential(
    connection: &mut SqliteConnection,
    binding: &super::CredentialBinding,
) -> Result<(), ConfigurationRepositoryError> {
    let row = sqlx::query(
        "SELECT
             (SELECT count(*) FROM local_server_configs
              WHERE sensitive_environment_credential_reference = ?1)
           + (SELECT count(*) FROM remote_server_configs WHERE credential_reference = ?1)
           + (SELECT count(*) FROM http_proxy_configs WHERE credential_reference = ?1)
           + (SELECT count(*) FROM socks_proxy_configs WHERE credential_reference = ?1)
           + (SELECT count(*) FROM ssh_proxy_configs
              WHERE key_passphrase_credential_reference = ?1)
           + (SELECT count(*) FROM ssh_proxy_configs
              WHERE password_credential_reference = ?1) AS active_count,
             (SELECT count(*) FROM credential_cleanup_queue
              WHERE credential_reference = ?1) AS cleanup_count",
    )
    .bind(binding.reference.as_str())
    .fetch_one(&mut *connection)
    .await
    .map_err(database_error)?;
    let active_count: i64 = decode(&row, "active_count")?;
    let cleanup_count: i64 = decode(&row, "cleanup_count")?;
    if active_count != 1 || cleanup_count != 0 {
        return Err(ConfigurationRepositoryError::Corrupt);
    }
    require_canonical_descriptor(binding.descriptor)
}

async fn load_servers(
    connection: &mut SqliteConnection,
) -> Result<Vec<ServerProfile>, ConfigurationRepositoryError> {
    let rows = sqlx::query(
        "SELECT server_id FROM servers
         ORDER BY last_used_at_ms DESC NULLS LAST, created_at_ms DESC,
                  name COLLATE NOCASE, server_id",
    )
    .fetch_all(&mut *connection)
    .await
    .map_err(database_error)?;
    let mut profiles = Vec::with_capacity(rows.len());
    for row in rows {
        let server_id = ServerId(decode_uuid(decode(&row, "server_id")?)?);
        profiles.push(load_server(&mut *connection, server_id).await?);
    }
    Ok(profiles)
}

async fn load_server(
    connection: &mut SqliteConnection,
    server_id: ServerId,
) -> Result<ServerProfile, ConfigurationRepositoryError> {
    let row = sqlx::query(
        "SELECT name, server_type, version, created_at_ms, updated_at_ms, last_used_at_ms,
                (SELECT COUNT(*) FROM server_window_references
                 WHERE server_id = servers.server_id) AS active_window_count
         FROM servers WHERE server_id = ?",
    )
    .bind(server_id.0.to_string())
    .fetch_optional(&mut *connection)
    .await
    .map_err(database_error)?
    .ok_or(ConfigurationRepositoryError::ServerNotFound)?;
    let name: String = decode(&row, "name")?;
    let kind: String = decode(&row, "server_type")?;
    let version = decode_version(decode(&row, "version")?)?;
    let created_at_ms = decode_timestamp(decode(&row, "created_at_ms")?)?;
    let updated_at_ms = decode_timestamp(decode(&row, "updated_at_ms")?)?;
    let last_used_at_ms = decode_optional_timestamp(decode(&row, "last_used_at_ms")?)?;
    let active_window_count = decode_count(decode(&row, "active_window_count")?)?;
    if updated_at_ms < created_at_ms {
        return Err(ConfigurationRepositoryError::Corrupt);
    }

    let configuration = load_server_configuration(connection, server_id, &kind).await?;
    let persisted_name = name.clone();
    let validated = configuration
        .validate_persisted(name)
        .map_err(|_| ConfigurationRepositoryError::Corrupt)?;
    if validated.name != persisted_name {
        return Err(ConfigurationRepositoryError::Corrupt);
    }
    let credential_configured = !load_server_credentials_for_cleanup(connection, server_id, &kind)
        .await?
        .is_empty();
    Ok(ServerProfile {
        server_id,
        name: validated.name,
        version,
        configuration: validated.configuration,
        credential_configured,
        created_at_ms,
        updated_at_ms,
        last_used_at_ms,
        active_window_count,
    })
}

async fn load_server_configuration(
    connection: &mut SqliteConnection,
    server_id: ServerId,
    kind: &str,
) -> Result<ServerConfiguration, ConfigurationRepositoryError> {
    match kind {
        "local" => {
            let row = sqlx::query(
                "SELECT executable_path, arguments_json, default_working_directory,
                        non_sensitive_environment_json,
                        sensitive_environment_credential_reference
                 FROM local_server_configs WHERE server_id = ?",
            )
            .bind(server_id.0.to_string())
            .fetch_optional(&mut *connection)
            .await
            .map_err(database_error)?
            .ok_or(ConfigurationRepositoryError::Corrupt)?;
            decode_optional_credential_reference(decode(
                &row,
                "sensitive_environment_credential_reference",
            )?)?;
            Ok(ServerConfiguration::LocalStdio {
                executable_path: decode(&row, "executable_path")?,
                arguments: decode_json(decode(&row, "arguments_json")?)?,
                default_working_directory: decode(&row, "default_working_directory")?,
                non_sensitive_environment: decode_json(decode(
                    &row,
                    "non_sensitive_environment_json",
                )?)?,
            })
        }
        "remote" => {
            let row = sqlx::query(
                "SELECT url, authentication_method, credential_reference,
                        non_sensitive_headers_json,
                        connect_timeout_ms, tls_certificate_policy, plaintext_confirmed, proxy_id
                 FROM remote_server_configs WHERE server_id = ?",
            )
            .bind(server_id.0.to_string())
            .fetch_optional(&mut *connection)
            .await
            .map_err(database_error)?
            .ok_or(ConfigurationRepositoryError::Corrupt)?;
            decode_optional_credential_reference(decode(&row, "credential_reference")?)?;
            let proxy_id = decode_optional_uuid(decode(&row, "proxy_id")?)?.map(ProxyId);
            Ok(ServerConfiguration::RemoteWebSocket {
                url: decode(&row, "url")?,
                authentication: decode_remote_authentication(decode(
                    &row,
                    "authentication_method",
                )?)?,
                non_sensitive_headers: decode_json(decode(&row, "non_sensitive_headers_json")?)?,
                connect_timeout_ms: decode_u64(decode(&row, "connect_timeout_ms")?)?,
                tls_certificate_policy: decode_tls_policy(decode(&row, "tls_certificate_policy")?)?,
                plaintext_confirmed: decode_boolean(decode(&row, "plaintext_confirmed")?)?,
                proxy_id,
            })
        }
        _ => Err(ConfigurationRepositoryError::Corrupt),
    }
}

async fn load_proxies(
    connection: &mut SqliteConnection,
) -> Result<Vec<ProxyProfile>, ConfigurationRepositoryError> {
    let rows = sqlx::query(
        "SELECT proxy_id FROM proxies
         ORDER BY name COLLATE NOCASE, created_at_ms, proxy_id",
    )
    .fetch_all(&mut *connection)
    .await
    .map_err(database_error)?;
    let mut profiles = Vec::with_capacity(rows.len());
    for row in rows {
        let proxy_id = ProxyId(decode_uuid(decode(&row, "proxy_id")?)?);
        profiles.push(load_proxy(&mut *connection, proxy_id).await?);
    }
    Ok(profiles)
}

async fn load_proxy(
    connection: &mut SqliteConnection,
    proxy_id: ProxyId,
) -> Result<ProxyProfile, ConfigurationRepositoryError> {
    let row = sqlx::query(
        "SELECT name, proxy_type, version, last_test_status, last_tested_at_ms,
                created_at_ms, updated_at_ms
         FROM proxies WHERE proxy_id = ?",
    )
    .bind(proxy_id.0.to_string())
    .fetch_optional(&mut *connection)
    .await
    .map_err(database_error)?
    .ok_or(ConfigurationRepositoryError::ProxyNotFound)?;
    let name: String = decode(&row, "name")?;
    let kind: String = decode(&row, "proxy_type")?;
    let version = decode_version(decode(&row, "version")?)?;
    let created_at_ms = decode_timestamp(decode(&row, "created_at_ms")?)?;
    let updated_at_ms = decode_timestamp(decode(&row, "updated_at_ms")?)?;
    if updated_at_ms < created_at_ms {
        return Err(ConfigurationRepositoryError::Corrupt);
    }
    let last_test = decode_optional_last_test(
        decode(&row, "last_test_status")?,
        decode(&row, "last_tested_at_ms")?,
    )?;
    let configuration = load_proxy_configuration(connection, proxy_id, &kind).await?;
    let persisted_name = name.clone();
    let validated = configuration
        .validate_persisted(name)
        .map_err(|_| ConfigurationRepositoryError::Corrupt)?;
    if validated.name != persisted_name {
        return Err(ConfigurationRepositoryError::Corrupt);
    }
    let ssh_host_key = load_ssh_host_key(connection, proxy_id, &validated.configuration).await?;
    let referenced_server_count = referenced_server_count(connection, proxy_id).await?;
    let credential_configured = !load_proxy_credentials_for_cleanup(connection, proxy_id, &kind)
        .await?
        .is_empty();

    Ok(ProxyProfile {
        proxy_id,
        name: validated.name,
        version,
        configuration: validated.configuration,
        credential_configured,
        ssh_host_key,
        last_test,
        referenced_server_count,
        created_at_ms,
        updated_at_ms,
    })
}

async fn load_proxy_configuration(
    connection: &mut SqliteConnection,
    proxy_id: ProxyId,
    kind: &str,
) -> Result<ProxyConfiguration, ConfigurationRepositoryError> {
    match kind {
        "http" => {
            let row = sqlx::query(
                "SELECT url, authentication_method, username, credential_reference,
                        non_sensitive_headers_json,
                        connect_timeout_ms, tls_certificate_policy
                 FROM http_proxy_configs WHERE proxy_id = ?",
            )
            .bind(proxy_id.0.to_string())
            .fetch_optional(&mut *connection)
            .await
            .map_err(database_error)?
            .ok_or(ConfigurationRepositoryError::Corrupt)?;
            decode_optional_credential_reference(decode(&row, "credential_reference")?)?;
            Ok(ProxyConfiguration::HttpConnect {
                url: decode(&row, "url")?,
                authentication: decode_http_authentication(decode(&row, "authentication_method")?)?,
                username: decode(&row, "username")?,
                non_sensitive_headers: decode_json(decode(&row, "non_sensitive_headers_json")?)?,
                connect_timeout_ms: decode_u64(decode(&row, "connect_timeout_ms")?)?,
                tls_certificate_policy: decode_tls_policy(decode(&row, "tls_certificate_policy")?)?,
            })
        }
        "socks5" => {
            let row = sqlx::query(
                "SELECT host, port, authentication_method, username, credential_reference,
                        dns_resolution,
                        connect_timeout_ms
                 FROM socks_proxy_configs WHERE proxy_id = ?",
            )
            .bind(proxy_id.0.to_string())
            .fetch_optional(&mut *connection)
            .await
            .map_err(database_error)?
            .ok_or(ConfigurationRepositoryError::Corrupt)?;
            decode_optional_credential_reference(decode(&row, "credential_reference")?)?;
            Ok(ProxyConfiguration::Socks5 {
                host: decode(&row, "host")?,
                port: decode_port(decode(&row, "port")?)?,
                authentication: decode_socks_authentication(decode(
                    &row,
                    "authentication_method",
                )?)?,
                username: decode(&row, "username")?,
                dns_resolution: decode_dns_resolution(decode(&row, "dns_resolution")?)?,
                connect_timeout_ms: decode_u64(decode(&row, "connect_timeout_ms")?)?,
            })
        }
        "ssh" => {
            let row = sqlx::query(
                "SELECT host, port, username, authentication_method, private_key_path,
                        key_passphrase_credential_reference, password_credential_reference,
                        connect_timeout_ms, keep_alive_interval_ms, keep_alive_max_failures
                 FROM ssh_proxy_configs WHERE proxy_id = ?",
            )
            .bind(proxy_id.0.to_string())
            .fetch_optional(&mut *connection)
            .await
            .map_err(database_error)?
            .ok_or(ConfigurationRepositoryError::Corrupt)?;
            decode_optional_credential_reference(decode(
                &row,
                "key_passphrase_credential_reference",
            )?)?;
            decode_optional_credential_reference(decode(&row, "password_credential_reference")?)?;
            let authentication_method: String = decode(&row, "authentication_method")?;
            let private_key_path: Option<String> = decode(&row, "private_key_path")?;
            Ok(ProxyConfiguration::Ssh {
                host: decode(&row, "host")?,
                port: decode_port(decode(&row, "port")?)?,
                username: decode(&row, "username")?,
                authentication: decode_ssh_authentication(authentication_method, private_key_path)?,
                connect_timeout_ms: decode_u64(decode(&row, "connect_timeout_ms")?)?,
                keep_alive_interval_ms: decode_u64(decode(&row, "keep_alive_interval_ms")?)?,
                keep_alive_max_failures: decode_usize(decode(&row, "keep_alive_max_failures")?)?,
            })
        }
        _ => Err(ConfigurationRepositoryError::Corrupt),
    }
}

async fn load_ssh_host_key(
    connection: &mut SqliteConnection,
    proxy_id: ProxyId,
    configuration: &ProxyConfiguration,
) -> Result<Option<SshHostKeyRecord>, ConfigurationRepositoryError> {
    let row = sqlx::query(
        "SELECT host, port, algorithm, sha256_fingerprint, confirmed_at_ms
         FROM ssh_host_keys WHERE proxy_id = ?",
    )
    .bind(proxy_id.0.to_string())
    .fetch_optional(&mut *connection)
    .await
    .map_err(database_error)?;
    let Some(row) = row else {
        return Ok(None);
    };
    let host: String = decode(&row, "host")?;
    let port = decode_port(decode(&row, "port")?)?;
    let algorithm: String = decode(&row, "algorithm")?;
    let sha256_fingerprint: String = decode(&row, "sha256_fingerprint")?;
    validate_host_key_record(&host, port, &algorithm, &sha256_fingerprint)
        .map_err(|_| ConfigurationRepositoryError::Corrupt)?;
    let ProxyConfiguration::Ssh {
        host: proxy_host,
        port: proxy_port,
        ..
    } = configuration
    else {
        return Err(ConfigurationRepositoryError::Corrupt);
    };
    if &host != proxy_host || port != *proxy_port {
        return Err(ConfigurationRepositoryError::Corrupt);
    }
    Ok(Some(SshHostKeyRecord {
        host,
        port,
        algorithm,
        sha256_fingerprint,
        confirmed_at_ms: decode_timestamp(decode(&row, "confirmed_at_ms")?)?,
    }))
}

async fn load_server_identity(
    connection: &mut SqliteConnection,
    server_id: ServerId,
) -> Result<(String, i64, i64), ConfigurationRepositoryError> {
    let row =
        sqlx::query("SELECT server_type, version, updated_at_ms FROM servers WHERE server_id = ?")
            .bind(server_id.0.to_string())
            .fetch_optional(&mut *connection)
            .await
            .map_err(database_error)?
            .ok_or(ConfigurationRepositoryError::ServerNotFound)?;
    let kind: String = decode(&row, "server_type")?;
    if !matches!(kind.as_str(), "local" | "remote") {
        return Err(ConfigurationRepositoryError::Corrupt);
    }
    let version = decode_positive_i64(decode(&row, "version")?)?;
    let updated_at_ms = decode_timestamp(decode(&row, "updated_at_ms")?)?;
    Ok((kind, version, updated_at_ms))
}

async fn load_proxy_identity(
    connection: &mut SqliteConnection,
    proxy_id: ProxyId,
) -> Result<(String, i64, i64), ConfigurationRepositoryError> {
    let row =
        sqlx::query("SELECT proxy_type, version, updated_at_ms FROM proxies WHERE proxy_id = ?")
            .bind(proxy_id.0.to_string())
            .fetch_optional(&mut *connection)
            .await
            .map_err(database_error)?
            .ok_or(ConfigurationRepositoryError::ProxyNotFound)?;
    let kind: String = decode(&row, "proxy_type")?;
    if !matches!(kind.as_str(), "http" | "socks5" | "ssh") {
        return Err(ConfigurationRepositoryError::Corrupt);
    }
    let version = decode_positive_i64(decode(&row, "version")?)?;
    let updated_at_ms = decode_timestamp(decode(&row, "updated_at_ms")?)?;
    Ok((kind, version, updated_at_ms))
}

async fn require_server_credential_compatibility(
    connection: &mut SqliteConnection,
    server_id: ServerId,
    old_type: &str,
    configuration: &ServerConfiguration,
) -> Result<(), ConfigurationRepositoryError> {
    let new_type = server_type(configuration);
    match old_type {
        "local" => {
            let row = sqlx::query(
                "SELECT executable_path, non_sensitive_environment_json,
                        sensitive_environment_credential_reference
                 FROM local_server_configs WHERE server_id = ?",
            )
            .bind(server_id.0.to_string())
            .fetch_optional(&mut *connection)
            .await
            .map_err(database_error)?
            .ok_or(ConfigurationRepositoryError::Corrupt)?;
            let old_executable_path: String = decode(&row, "executable_path")?;
            let old_non_sensitive_environment: BTreeMap<String, String> =
                decode_json(decode(&row, "non_sensitive_environment_json")?)?;
            let credential_reference = decode_optional_credential_reference(decode(
                &row,
                "sensitive_environment_credential_reference",
            )?)?;
            let binding_changed = match configuration {
                ServerConfiguration::LocalStdio {
                    executable_path,
                    non_sensitive_environment,
                    ..
                } => {
                    old_executable_path.as_str() != executable_path
                        || non_sensitive_environment
                            .keys()
                            .any(|name| !old_non_sensitive_environment.contains_key(name))
                }
                ServerConfiguration::RemoteWebSocket { .. } => true,
            };
            if credential_reference.is_some() && (new_type != old_type || binding_changed) {
                return Err(ConfigurationRepositoryError::CredentialChangeRequired);
            }
        }
        "remote" => {
            let row = sqlx::query(
                "SELECT url, authentication_method, credential_reference
                 FROM remote_server_configs WHERE server_id = ?",
            )
            .bind(server_id.0.to_string())
            .fetch_optional(&mut *connection)
            .await
            .map_err(database_error)?
            .ok_or(ConfigurationRepositoryError::Corrupt)?;
            let old_url: String = decode(&row, "url")?;
            let old_authentication: String = decode(&row, "authentication_method")?;
            decode_remote_authentication(old_authentication.clone())?;
            let credential_reference =
                decode_optional_credential_reference(decode(&row, "credential_reference")?)?;
            let binding_changed = match configuration {
                ServerConfiguration::RemoteWebSocket {
                    url,
                    authentication,
                    ..
                } => {
                    old_authentication != encode_remote_authentication(*authentication)
                        || normalized_origin(&old_url)? != normalized_origin(url)?
                }
                ServerConfiguration::LocalStdio { .. } => true,
            };
            if credential_reference.is_some() && (new_type != old_type || binding_changed) {
                return Err(ConfigurationRepositoryError::CredentialChangeRequired);
            }
        }
        _ => return Err(ConfigurationRepositoryError::Corrupt),
    }
    Ok(())
}

async fn require_proxy_credential_compatibility(
    connection: &mut SqliteConnection,
    proxy_id: ProxyId,
    old_type: &str,
    configuration: &ProxyConfiguration,
) -> Result<(), ConfigurationRepositoryError> {
    let new_type = proxy_type(configuration);
    if old_type != new_type {
        if proxy_has_credential_reference(connection, proxy_id, old_type).await? {
            return Err(ConfigurationRepositoryError::CredentialChangeRequired);
        }
        return Ok(());
    }

    let incompatible = match (old_type, configuration) {
        (
            "http",
            ProxyConfiguration::HttpConnect {
                url,
                authentication,
                username,
                ..
            },
        ) => {
            let row = sqlx::query(
                "SELECT url, authentication_method, username, credential_reference
                 FROM http_proxy_configs WHERE proxy_id = ?",
            )
            .bind(proxy_id.0.to_string())
            .fetch_optional(&mut *connection)
            .await
            .map_err(database_error)?
            .ok_or(ConfigurationRepositoryError::Corrupt)?;
            let old_url: String = decode(&row, "url")?;
            let old_authentication: String = decode(&row, "authentication_method")?;
            let old_authentication_value = decode_http_authentication(old_authentication.clone())?;
            let old_username: Option<String> = decode(&row, "username")?;
            let credential_reference =
                decode_optional_credential_reference(decode(&row, "credential_reference")?)?;
            credential_reference.is_some()
                && (old_authentication != encode_http_authentication(*authentication)
                    || normalized_origin(&old_url)? != normalized_origin(url)?
                    || (old_authentication_value == HttpProxyAuthentication::Basic
                        && old_username.as_deref() != username.as_deref()))
        }
        (
            "socks5",
            ProxyConfiguration::Socks5 {
                host,
                port,
                authentication,
                username,
                ..
            },
        ) => {
            let row = sqlx::query(
                "SELECT host, port, authentication_method, username, credential_reference
                 FROM socks_proxy_configs WHERE proxy_id = ?",
            )
            .bind(proxy_id.0.to_string())
            .fetch_optional(&mut *connection)
            .await
            .map_err(database_error)?
            .ok_or(ConfigurationRepositoryError::Corrupt)?;
            let old_host: String = decode(&row, "host")?;
            let old_port = decode_port(decode(&row, "port")?)?;
            let old_authentication: String = decode(&row, "authentication_method")?;
            decode_socks_authentication(old_authentication.clone())?;
            let old_username: Option<String> = decode(&row, "username")?;
            let credential_reference =
                decode_optional_credential_reference(decode(&row, "credential_reference")?)?;
            credential_reference.is_some()
                && (old_authentication != encode_socks_authentication(*authentication)
                    || normalized_host(&old_host)? != normalized_host(host)?
                    || old_port != *port
                    || old_username.as_deref() != username.as_deref())
        }
        (
            "ssh",
            ProxyConfiguration::Ssh {
                host,
                port,
                username,
                authentication,
                ..
            },
        ) => {
            let row = sqlx::query(
                "SELECT host, port, username, authentication_method, private_key_path,
                        key_passphrase_credential_reference, password_credential_reference
                 FROM ssh_proxy_configs WHERE proxy_id = ?",
            )
            .bind(proxy_id.0.to_string())
            .fetch_optional(&mut *connection)
            .await
            .map_err(database_error)?
            .ok_or(ConfigurationRepositoryError::Corrupt)?;
            let old_host: String = decode(&row, "host")?;
            let old_port = decode_port(decode(&row, "port")?)?;
            let old_username: String = decode(&row, "username")?;
            let old_authentication: String = decode(&row, "authentication_method")?;
            let old_private_key_path: Option<String> = decode(&row, "private_key_path")?;
            decode_ssh_authentication(old_authentication.clone(), old_private_key_path.clone())?;
            let key_reference = decode_optional_credential_reference(decode(
                &row,
                "key_passphrase_credential_reference",
            )?)?;
            let password_reference = decode_optional_credential_reference(decode(
                &row,
                "password_credential_reference",
            )?)?;
            let (new_authentication, new_private_key_path) =
                encode_ssh_authentication(authentication);
            let has_reference = key_reference.is_some() || password_reference.is_some();
            has_reference
                && (old_authentication != new_authentication
                    || normalized_host(&old_host)? != normalized_host(host)?
                    || old_port != *port
                    || old_username.as_str() != username.as_str()
                    || (old_authentication == "private_key"
                        && old_private_key_path.as_deref() != new_private_key_path))
        }
        _ => return Err(ConfigurationRepositoryError::Corrupt),
    };
    if incompatible {
        Err(ConfigurationRepositoryError::CredentialChangeRequired)
    } else {
        Ok(())
    }
}

async fn proxy_has_credential_reference(
    connection: &mut SqliteConnection,
    proxy_id: ProxyId,
    kind: &str,
) -> Result<bool, ConfigurationRepositoryError> {
    let has_reference = match kind {
        "http" => {
            let row = sqlx::query(
                "SELECT credential_reference FROM http_proxy_configs WHERE proxy_id = ?",
            )
            .bind(proxy_id.0.to_string())
            .fetch_optional(&mut *connection)
            .await
            .map_err(database_error)?
            .ok_or(ConfigurationRepositoryError::Corrupt)?;
            decode_optional_credential_reference(decode(&row, "credential_reference")?)?.is_some()
        }
        "socks5" => {
            let row = sqlx::query(
                "SELECT credential_reference FROM socks_proxy_configs WHERE proxy_id = ?",
            )
            .bind(proxy_id.0.to_string())
            .fetch_optional(&mut *connection)
            .await
            .map_err(database_error)?
            .ok_or(ConfigurationRepositoryError::Corrupt)?;
            decode_optional_credential_reference(decode(&row, "credential_reference")?)?.is_some()
        }
        "ssh" => {
            let row = sqlx::query(
                "SELECT key_passphrase_credential_reference, password_credential_reference
                 FROM ssh_proxy_configs WHERE proxy_id = ?",
            )
            .bind(proxy_id.0.to_string())
            .fetch_optional(&mut *connection)
            .await
            .map_err(database_error)?
            .ok_or(ConfigurationRepositoryError::Corrupt)?;
            decode_optional_credential_reference(decode(
                &row,
                "key_passphrase_credential_reference",
            )?)?
            .is_some()
                || decode_optional_credential_reference(decode(
                    &row,
                    "password_credential_reference",
                )?)?
                .is_some()
        }
        _ => return Err(ConfigurationRepositoryError::Corrupt),
    };
    Ok(has_reference)
}

async fn require_remote_proxy(
    connection: &mut SqliteConnection,
    configuration: &ServerConfiguration,
) -> Result<(), ConfigurationRepositoryError> {
    let ServerConfiguration::RemoteWebSocket {
        proxy_id: Some(proxy_id),
        ..
    } = configuration
    else {
        return Ok(());
    };
    let exists: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM proxies WHERE proxy_id = ?)")
        .bind(proxy_id.0.to_string())
        .fetch_one(&mut *connection)
        .await
        .map_err(database_error)?;
    if exists == 1 {
        Ok(())
    } else {
        Err(ConfigurationRepositoryError::ProxyNotFound)
    }
}

async fn referenced_server_count(
    connection: &mut SqliteConnection,
    proxy_id: ProxyId,
) -> Result<u64, ConfigurationRepositoryError> {
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM remote_server_configs WHERE proxy_id = ?")
            .bind(proxy_id.0.to_string())
            .fetch_one(&mut *connection)
            .await
            .map_err(database_error)?;
    decode_count(count)
}

async fn active_window_count(
    connection: &mut SqliteConnection,
    server_id: ServerId,
) -> Result<u64, ConfigurationRepositoryError> {
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM server_window_references WHERE server_id = ?")
            .bind(server_id.0.to_string())
            .fetch_one(&mut *connection)
            .await
            .map_err(database_error)?;
    decode_count(count)
}

async fn clear_persisted_window_server(
    connection: &mut SqliteConnection,
    server_id: ServerId,
    now_ms: i64,
) -> Result<(), ConfigurationRepositoryError> {
    let referenced_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM window_states WHERE server_id = ?")
            .bind(server_id.0.to_string())
            .fetch_one(&mut *connection)
            .await
            .map_err(database_error)?;
    let referenced_count = decode_count(referenced_count)?;
    let updated = sqlx::query(
        "UPDATE window_states
         SET server_id = NULL, current_thread_id = NULL, draft_key = NULL,
             version = version + 1, updated_at_ms = MAX(updated_at_ms + 1, ?)
         WHERE server_id = ? AND version < ?",
    )
    .bind(now_ms)
    .bind(server_id.0.to_string())
    .bind(MAX_SAFE_INTEGER)
    .execute(&mut *connection)
    .await
    .map_err(database_error)?
    .rows_affected();
    if updated == referenced_count {
        Ok(())
    } else {
        Err(ConfigurationRepositoryError::Corrupt)
    }
}

async fn insert_server_configuration(
    connection: &mut SqliteConnection,
    server_id: ServerId,
    configuration: &ServerConfiguration,
) -> Result<(), ConfigurationRepositoryError> {
    match configuration {
        ServerConfiguration::LocalStdio {
            executable_path,
            arguments,
            default_working_directory,
            non_sensitive_environment,
        } => {
            sqlx::query(
                "INSERT INTO local_server_configs
                 (server_id, executable_path, arguments_json, default_working_directory,
                  non_sensitive_environment_json, sensitive_environment_credential_reference)
                 VALUES (?, ?, ?, ?, ?, NULL)",
            )
            .bind(server_id.0.to_string())
            .bind(executable_path)
            .bind(encode_json(arguments)?)
            .bind(default_working_directory)
            .bind(encode_json(non_sensitive_environment)?)
            .execute(&mut *connection)
            .await
            .map_err(database_error)?;
        }
        ServerConfiguration::RemoteWebSocket {
            url,
            authentication,
            non_sensitive_headers,
            connect_timeout_ms,
            tls_certificate_policy,
            plaintext_confirmed,
            proxy_id,
        } => {
            sqlx::query(
                "INSERT INTO remote_server_configs
                 (server_id, url, authentication_method, credential_reference,
                  non_sensitive_headers_json, connect_timeout_ms, tls_certificate_policy,
                  plaintext_confirmed, proxy_id)
                 VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)",
            )
            .bind(server_id.0.to_string())
            .bind(url)
            .bind(encode_remote_authentication(*authentication))
            .bind(encode_json(non_sensitive_headers)?)
            .bind(u64_to_i64(*connect_timeout_ms)?)
            .bind(encode_tls_policy(*tls_certificate_policy))
            .bind(i64::from(*plaintext_confirmed))
            .bind(proxy_id.map(|id| id.0.to_string()))
            .execute(&mut *connection)
            .await
            .map_err(|error| {
                if is_foreign_key_violation(&error) {
                    ConfigurationRepositoryError::ProxyNotFound
                } else {
                    database_error(error)
                }
            })?;
        }
    }
    Ok(())
}

async fn update_server_configuration(
    connection: &mut SqliteConnection,
    server_id: ServerId,
    configuration: &ServerConfiguration,
) -> Result<(), ConfigurationRepositoryError> {
    let rows_affected = match configuration {
        ServerConfiguration::LocalStdio {
            executable_path,
            arguments,
            default_working_directory,
            non_sensitive_environment,
        } => sqlx::query(
            "UPDATE local_server_configs
             SET executable_path = ?, arguments_json = ?, default_working_directory = ?,
                 non_sensitive_environment_json = ?
             WHERE server_id = ?",
        )
        .bind(executable_path)
        .bind(encode_json(arguments)?)
        .bind(default_working_directory)
        .bind(encode_json(non_sensitive_environment)?)
        .bind(server_id.0.to_string())
        .execute(&mut *connection)
        .await
        .map_err(database_error)?
        .rows_affected(),
        ServerConfiguration::RemoteWebSocket {
            url,
            authentication,
            non_sensitive_headers,
            connect_timeout_ms,
            tls_certificate_policy,
            plaintext_confirmed,
            proxy_id,
        } => sqlx::query(
            "UPDATE remote_server_configs
             SET url = ?, authentication_method = ?, non_sensitive_headers_json = ?,
                 connect_timeout_ms = ?,
                 tls_certificate_policy = ?,
                 plaintext_confirmed = ?, proxy_id = ?
             WHERE server_id = ?",
        )
        .bind(url)
        .bind(encode_remote_authentication(*authentication))
        .bind(encode_json(non_sensitive_headers)?)
        .bind(u64_to_i64(*connect_timeout_ms)?)
        .bind(encode_tls_policy(*tls_certificate_policy))
        .bind(i64::from(*plaintext_confirmed))
        .bind(proxy_id.map(|id| id.0.to_string()))
        .bind(server_id.0.to_string())
        .execute(&mut *connection)
        .await
        .map_err(|error| {
            if is_foreign_key_violation(&error) {
                ConfigurationRepositoryError::ProxyNotFound
            } else {
                database_error(error)
            }
        })?
        .rows_affected(),
    };
    if rows_affected == 1 {
        Ok(())
    } else {
        Err(ConfigurationRepositoryError::Corrupt)
    }
}

async fn delete_server_configuration(
    connection: &mut SqliteConnection,
    server_id: ServerId,
    kind: &str,
) -> Result<(), ConfigurationRepositoryError> {
    let table = match kind {
        "local" => "local_server_configs",
        "remote" => "remote_server_configs",
        _ => return Err(ConfigurationRepositoryError::Corrupt),
    };
    let query = format!("DELETE FROM {table} WHERE server_id = ?");
    let result = sqlx::query(&query)
        .bind(server_id.0.to_string())
        .execute(&mut *connection)
        .await
        .map_err(database_error)?;
    if result.rows_affected() == 1 {
        Ok(())
    } else {
        Err(ConfigurationRepositoryError::Corrupt)
    }
}

async fn insert_proxy_configuration(
    connection: &mut SqliteConnection,
    proxy_id: ProxyId,
    configuration: &ProxyConfiguration,
) -> Result<(), ConfigurationRepositoryError> {
    match configuration {
        ProxyConfiguration::HttpConnect {
            url,
            authentication,
            username,
            non_sensitive_headers,
            connect_timeout_ms,
            tls_certificate_policy,
        } => {
            sqlx::query(
                "INSERT INTO http_proxy_configs
                 (proxy_id, url, authentication_method, username, credential_reference,
                  non_sensitive_headers_json, connect_timeout_ms, tls_certificate_policy)
                 VALUES (?, ?, ?, ?, NULL, ?, ?, ?)",
            )
            .bind(proxy_id.0.to_string())
            .bind(url)
            .bind(encode_http_authentication(*authentication))
            .bind(username)
            .bind(encode_json(non_sensitive_headers)?)
            .bind(u64_to_i64(*connect_timeout_ms)?)
            .bind(encode_tls_policy(*tls_certificate_policy))
            .execute(&mut *connection)
            .await
            .map_err(database_error)?;
        }
        ProxyConfiguration::Socks5 {
            host,
            port,
            authentication,
            username,
            dns_resolution,
            connect_timeout_ms,
        } => {
            sqlx::query(
                "INSERT INTO socks_proxy_configs
                 (proxy_id, host, port, authentication_method, username, credential_reference,
                  dns_resolution, connect_timeout_ms)
                 VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
            )
            .bind(proxy_id.0.to_string())
            .bind(host)
            .bind(i64::from(*port))
            .bind(encode_socks_authentication(*authentication))
            .bind(username)
            .bind(encode_dns_resolution(*dns_resolution))
            .bind(u64_to_i64(*connect_timeout_ms)?)
            .execute(&mut *connection)
            .await
            .map_err(database_error)?;
        }
        ProxyConfiguration::Ssh {
            host,
            port,
            username,
            authentication,
            connect_timeout_ms,
            keep_alive_interval_ms,
            keep_alive_max_failures,
        } => {
            let (authentication_method, private_key_path) =
                encode_ssh_authentication(authentication);
            sqlx::query(
                "INSERT INTO ssh_proxy_configs
                 (proxy_id, host, port, username, authentication_method, private_key_path,
                  key_passphrase_credential_reference, password_credential_reference,
                  connect_timeout_ms, keep_alive_interval_ms, keep_alive_max_failures)
                 VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)",
            )
            .bind(proxy_id.0.to_string())
            .bind(host)
            .bind(i64::from(*port))
            .bind(username)
            .bind(authentication_method)
            .bind(private_key_path)
            .bind(u64_to_i64(*connect_timeout_ms)?)
            .bind(u64_to_i64(*keep_alive_interval_ms)?)
            .bind(usize_to_i64(*keep_alive_max_failures)?)
            .execute(&mut *connection)
            .await
            .map_err(database_error)?;
        }
    }
    Ok(())
}

async fn update_proxy_configuration(
    connection: &mut SqliteConnection,
    proxy_id: ProxyId,
    configuration: &ProxyConfiguration,
) -> Result<(), ConfigurationRepositoryError> {
    let rows_affected = match configuration {
        ProxyConfiguration::HttpConnect {
            url,
            authentication,
            username,
            non_sensitive_headers,
            connect_timeout_ms,
            tls_certificate_policy,
        } => sqlx::query(
            "UPDATE http_proxy_configs
             SET url = ?, authentication_method = ?, username = ?,
                 non_sensitive_headers_json = ?,
                 connect_timeout_ms = ?, tls_certificate_policy = ?
             WHERE proxy_id = ?",
        )
        .bind(url)
        .bind(encode_http_authentication(*authentication))
        .bind(username)
        .bind(encode_json(non_sensitive_headers)?)
        .bind(u64_to_i64(*connect_timeout_ms)?)
        .bind(encode_tls_policy(*tls_certificate_policy))
        .bind(proxy_id.0.to_string())
        .execute(&mut *connection)
        .await
        .map_err(database_error)?
        .rows_affected(),
        ProxyConfiguration::Socks5 {
            host,
            port,
            authentication,
            username,
            dns_resolution,
            connect_timeout_ms,
        } => sqlx::query(
            "UPDATE socks_proxy_configs
             SET host = ?, port = ?, authentication_method = ?, username = ?,
                 dns_resolution = ?, connect_timeout_ms = ?
             WHERE proxy_id = ?",
        )
        .bind(host)
        .bind(i64::from(*port))
        .bind(encode_socks_authentication(*authentication))
        .bind(username)
        .bind(encode_dns_resolution(*dns_resolution))
        .bind(u64_to_i64(*connect_timeout_ms)?)
        .bind(proxy_id.0.to_string())
        .execute(&mut *connection)
        .await
        .map_err(database_error)?
        .rows_affected(),
        ProxyConfiguration::Ssh {
            host,
            port,
            username,
            authentication,
            connect_timeout_ms,
            keep_alive_interval_ms,
            keep_alive_max_failures,
        } => {
            let (authentication_method, private_key_path) =
                encode_ssh_authentication(authentication);
            sqlx::query(
                "UPDATE ssh_proxy_configs
                 SET host = ?, port = ?, username = ?, authentication_method = ?,
                     private_key_path = ?, connect_timeout_ms = ?,
                     keep_alive_interval_ms = ?, keep_alive_max_failures = ?
                 WHERE proxy_id = ?",
            )
            .bind(host)
            .bind(i64::from(*port))
            .bind(username)
            .bind(authentication_method)
            .bind(private_key_path)
            .bind(u64_to_i64(*connect_timeout_ms)?)
            .bind(u64_to_i64(*keep_alive_interval_ms)?)
            .bind(usize_to_i64(*keep_alive_max_failures)?)
            .bind(proxy_id.0.to_string())
            .execute(&mut *connection)
            .await
            .map_err(database_error)?
            .rows_affected()
        }
    };
    if rows_affected == 1 {
        Ok(())
    } else {
        Err(ConfigurationRepositoryError::Corrupt)
    }
}

async fn delete_proxy_configuration(
    connection: &mut SqliteConnection,
    proxy_id: ProxyId,
    kind: &str,
) -> Result<(), ConfigurationRepositoryError> {
    let table = match kind {
        "http" => "http_proxy_configs",
        "socks5" => "socks_proxy_configs",
        "ssh" => "ssh_proxy_configs",
        _ => return Err(ConfigurationRepositoryError::Corrupt),
    };
    let query = format!("DELETE FROM {table} WHERE proxy_id = ?");
    let result = sqlx::query(&query)
        .bind(proxy_id.0.to_string())
        .execute(&mut *connection)
        .await
        .map_err(database_error)?;
    if result.rows_affected() == 1 {
        Ok(())
    } else {
        Err(ConfigurationRepositoryError::Corrupt)
    }
}

async fn require_ssh_host_key_change_allowed(
    connection: &mut SqliteConnection,
    proxy_id: ProxyId,
    configuration: &ProxyConfiguration,
) -> Result<(), ConfigurationRepositoryError> {
    let host_key_exists: i64 =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM ssh_host_keys WHERE proxy_id = ?)")
            .bind(proxy_id.0.to_string())
            .fetch_one(&mut *connection)
            .await
            .map_err(database_error)?;
    if host_key_exists == 0 {
        return Ok(());
    }
    let ProxyConfiguration::Ssh { host, port, .. } = configuration else {
        return Err(ConfigurationRepositoryError::SshHostKeyRemovalRequired);
    };
    let row = sqlx::query("SELECT host, port FROM ssh_proxy_configs WHERE proxy_id = ?")
        .bind(proxy_id.0.to_string())
        .fetch_optional(&mut *connection)
        .await
        .map_err(database_error)?
        .ok_or(ConfigurationRepositoryError::Corrupt)?;
    let old_host: String = decode(&row, "host")?;
    let old_port = decode_port(decode(&row, "port")?)?;
    if old_host != *host || old_port != *port {
        return Err(ConfigurationRepositoryError::SshHostKeyRemovalRequired);
    }
    Ok(())
}

fn normalized_origin(value: &str) -> Result<(String, String, u16), ConfigurationRepositoryError> {
    let url = Url::parse(value).map_err(|_| ConfigurationRepositoryError::Corrupt)?;
    let host = match url.host().ok_or(ConfigurationRepositoryError::Corrupt)? {
        Host::Domain(domain) => format!("domain:{domain}"),
        Host::Ipv4(address) => format!("ip:{address}"),
        Host::Ipv6(address) => format!("ip:{address}"),
    };
    let port = url
        .port_or_known_default()
        .ok_or(ConfigurationRepositoryError::Corrupt)?;
    Ok((url.scheme().to_owned(), host, port))
}

fn normalized_host(value: &str) -> Result<String, ConfigurationRepositoryError> {
    if let Ok(address) = value.parse::<IpAddr>() {
        return Ok(format!("ip:{address}"));
    }
    if let Some(address) = value
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .and_then(|value| value.parse::<IpAddr>().ok())
    {
        return Ok(format!("ip:{address}"));
    }
    match Host::parse(value).map_err(|_| ConfigurationRepositoryError::Corrupt)? {
        Host::Domain(domain) => Ok(format!("domain:{domain}")),
        Host::Ipv4(address) => Ok(format!("ip:{address}")),
        Host::Ipv6(address) => Ok(format!("ip:{address}")),
    }
}

fn server_type(configuration: &ServerConfiguration) -> &'static str {
    match configuration {
        ServerConfiguration::LocalStdio { .. } => "local",
        ServerConfiguration::RemoteWebSocket { .. } => "remote",
    }
}

fn proxy_type(configuration: &ProxyConfiguration) -> &'static str {
    match configuration {
        ProxyConfiguration::HttpConnect { .. } => "http",
        ProxyConfiguration::Socks5 { .. } => "socks5",
        ProxyConfiguration::Ssh { .. } => "ssh",
    }
}

fn encode_remote_authentication(value: RemoteServerAuthentication) -> &'static str {
    match value {
        RemoteServerAuthentication::None => "none",
        RemoteServerAuthentication::Bearer => "bearer",
    }
}

fn decode_remote_authentication(
    value: String,
) -> Result<RemoteServerAuthentication, ConfigurationRepositoryError> {
    match value.as_str() {
        "none" => Ok(RemoteServerAuthentication::None),
        "bearer" => Ok(RemoteServerAuthentication::Bearer),
        _ => Err(ConfigurationRepositoryError::Corrupt),
    }
}

fn encode_tls_policy(value: TlsCertificatePolicy) -> &'static str {
    match value {
        TlsCertificatePolicy::Strict => "strict",
        TlsCertificatePolicy::AllowInvalidCertificate => "allow_invalid",
    }
}

fn decode_tls_policy(value: String) -> Result<TlsCertificatePolicy, ConfigurationRepositoryError> {
    match value.as_str() {
        "strict" => Ok(TlsCertificatePolicy::Strict),
        "allow_invalid" => Ok(TlsCertificatePolicy::AllowInvalidCertificate),
        _ => Err(ConfigurationRepositoryError::Corrupt),
    }
}

fn encode_http_authentication(value: HttpProxyAuthentication) -> &'static str {
    match value {
        HttpProxyAuthentication::None => "none",
        HttpProxyAuthentication::Basic => "basic",
        HttpProxyAuthentication::Bearer => "bearer",
    }
}

fn decode_http_authentication(
    value: String,
) -> Result<HttpProxyAuthentication, ConfigurationRepositoryError> {
    match value.as_str() {
        "none" => Ok(HttpProxyAuthentication::None),
        "basic" => Ok(HttpProxyAuthentication::Basic),
        "bearer" => Ok(HttpProxyAuthentication::Bearer),
        _ => Err(ConfigurationRepositoryError::Corrupt),
    }
}

fn encode_socks_authentication(value: Socks5Authentication) -> &'static str {
    match value {
        Socks5Authentication::None => "none",
        Socks5Authentication::UsernamePassword => "username_password",
    }
}

fn decode_socks_authentication(
    value: String,
) -> Result<Socks5Authentication, ConfigurationRepositoryError> {
    match value.as_str() {
        "none" => Ok(Socks5Authentication::None),
        "username_password" => Ok(Socks5Authentication::UsernamePassword),
        _ => Err(ConfigurationRepositoryError::Corrupt),
    }
}

fn encode_dns_resolution(value: Socks5DnsResolution) -> &'static str {
    match value {
        Socks5DnsResolution::Proxy => "proxy",
        Socks5DnsResolution::Local => "local",
    }
}

fn decode_dns_resolution(
    value: String,
) -> Result<Socks5DnsResolution, ConfigurationRepositoryError> {
    match value.as_str() {
        "proxy" => Ok(Socks5DnsResolution::Proxy),
        "local" => Ok(Socks5DnsResolution::Local),
        _ => Err(ConfigurationRepositoryError::Corrupt),
    }
}

fn encode_ssh_authentication(
    value: &SshAuthenticationConfiguration,
) -> (&'static str, Option<&str>) {
    match value {
        SshAuthenticationConfiguration::Agent {} => ("agent", None),
        SshAuthenticationConfiguration::PrivateKey { private_key_path } => {
            ("private_key", Some(private_key_path))
        }
        SshAuthenticationConfiguration::Password {} => ("password", None),
    }
}

fn decode_ssh_authentication(
    method: String,
    private_key_path: Option<String>,
) -> Result<SshAuthenticationConfiguration, ConfigurationRepositoryError> {
    match (method.as_str(), private_key_path) {
        ("agent", None) => Ok(SshAuthenticationConfiguration::Agent {}),
        ("private_key", Some(private_key_path)) => {
            Ok(SshAuthenticationConfiguration::PrivateKey { private_key_path })
        }
        ("password", None) => Ok(SshAuthenticationConfiguration::Password {}),
        _ => Err(ConfigurationRepositoryError::Corrupt),
    }
}

fn decode<T>(row: &SqliteRow, column: &str) -> Result<T, ConfigurationRepositoryError>
where
    for<'row> T: Decode<'row, Sqlite> + Type<Sqlite>,
{
    row.try_get(column)
        .map_err(|_| ConfigurationRepositoryError::Corrupt)
}

fn decode_json<T>(value: String) -> Result<T, ConfigurationRepositoryError>
where
    T: serde::de::DeserializeOwned,
{
    serde_json::from_str(&value).map_err(|_| ConfigurationRepositoryError::Corrupt)
}

fn encode_json<T>(value: &T) -> Result<String, ConfigurationRepositoryError>
where
    T: Serialize,
{
    serde_json::to_string(value).map_err(|_| ConfigurationRepositoryError::Corrupt)
}

fn decode_uuid(value: String) -> Result<Uuid, ConfigurationRepositoryError> {
    let uuid = Uuid::parse_str(&value).map_err(|_| ConfigurationRepositoryError::Corrupt)?;
    if uuid.get_version() != Some(Version::Random) || uuid.to_string() != value {
        return Err(ConfigurationRepositoryError::Corrupt);
    }
    Ok(uuid)
}

fn decode_optional_uuid(
    value: Option<String>,
) -> Result<Option<Uuid>, ConfigurationRepositoryError> {
    value.map(decode_uuid).transpose()
}

fn decode_version(value: i64) -> Result<u64, ConfigurationRepositoryError> {
    let value = decode_positive_i64(value)?;
    u64::try_from(value).map_err(|_| ConfigurationRepositoryError::Corrupt)
}

fn decode_positive_i64(value: i64) -> Result<i64, ConfigurationRepositoryError> {
    if (1..=MAX_SAFE_INTEGER).contains(&value) {
        Ok(value)
    } else {
        Err(ConfigurationRepositoryError::Corrupt)
    }
}

fn decode_u64(value: i64) -> Result<u64, ConfigurationRepositoryError> {
    u64::try_from(value).map_err(|_| ConfigurationRepositoryError::Corrupt)
}

fn decode_usize(value: i64) -> Result<usize, ConfigurationRepositoryError> {
    usize::try_from(value).map_err(|_| ConfigurationRepositoryError::Corrupt)
}

fn decode_port(value: i64) -> Result<u16, ConfigurationRepositoryError> {
    let port = u16::try_from(value).map_err(|_| ConfigurationRepositoryError::Corrupt)?;
    if port == 0 {
        Err(ConfigurationRepositoryError::Corrupt)
    } else {
        Ok(port)
    }
}

fn decode_boolean(value: i64) -> Result<bool, ConfigurationRepositoryError> {
    match value {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(ConfigurationRepositoryError::Corrupt),
    }
}

fn decode_timestamp(value: i64) -> Result<i64, ConfigurationRepositoryError> {
    if !(0..=MAX_SAFE_INTEGER).contains(&value) {
        return Err(ConfigurationRepositoryError::Corrupt);
    }
    Ok(value)
}

fn decode_optional_last_test(
    status: Option<String>,
    tested_at_ms: Option<i64>,
) -> Result<Option<ProxyLastTest>, ConfigurationRepositoryError> {
    let status = match status.as_deref() {
        Some("succeeded") => super::model::ProxyTestStatus::Succeeded,
        Some("failed") => super::model::ProxyTestStatus::Failed,
        None if tested_at_ms.is_none() => return Ok(None),
        _ => return Err(ConfigurationRepositoryError::Corrupt),
    };
    let tested_at_ms = tested_at_ms.ok_or(ConfigurationRepositoryError::Corrupt)?;
    decode_timestamp(tested_at_ms)?;
    Ok(Some(ProxyLastTest {
        status,
        tested_at_ms,
    }))
}

fn decode_optional_timestamp(
    value: Option<i64>,
) -> Result<Option<i64>, ConfigurationRepositoryError> {
    value.map(decode_timestamp).transpose()
}

async fn validate_create_proxy(
    request: CreateProxyProfileRequest,
) -> Result<ValidatedProxyWrite, ConfigurationRepositoryError> {
    tokio::task::spawn_blocking(move || request.validate())
        .await
        .map_err(|_| internal_error())?
        .map_err(Into::into)
}

async fn validate_update_proxy(
    request: UpdateProxyProfileRequest,
) -> Result<ValidatedProxyWrite, ConfigurationRepositoryError> {
    tokio::task::spawn_blocking(move || request.validate())
        .await
        .map_err(|_| internal_error())?
        .map_err(Into::into)
}

fn current_time_ms() -> Result<i64, ConfigurationRepositoryError> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| internal_error())?;
    let milliseconds = i64::try_from(elapsed.as_millis()).map_err(|_| internal_error())?;
    if milliseconds > MAX_SAFE_INTEGER {
        return Err(internal_error());
    }
    Ok(milliseconds)
}

fn require_incrementable_version(
    version: i64,
    error: ConfigurationRepositoryError,
) -> Result<(), ConfigurationRepositoryError> {
    if version < MAX_SAFE_INTEGER {
        Ok(())
    } else {
        Err(error)
    }
}

fn require_incrementable_timestamp(updated_at_ms: i64) -> Result<(), ConfigurationRepositoryError> {
    if updated_at_ms < MAX_SAFE_INTEGER {
        Ok(())
    } else {
        Err(ConfigurationRepositoryError::Corrupt)
    }
}

fn version_to_i64(value: u64) -> Result<i64, ConfigurationRepositoryError> {
    i64::try_from(value)
        .ok()
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| {
            ConfigurationRepositoryError::Validation(ConfigurationRepositoryValidationError {
                code: "invalidConfigurationVersion",
                message: "The configuration version is invalid",
            })
        })
}

fn decode_count(value: i64) -> Result<u64, ConfigurationRepositoryError> {
    if !(0..=MAX_SAFE_INTEGER).contains(&value) {
        return Err(ConfigurationRepositoryError::Corrupt);
    }
    u64::try_from(value).map_err(|_| ConfigurationRepositoryError::Corrupt)
}

fn u64_to_i64(value: u64) -> Result<i64, ConfigurationRepositoryError> {
    i64::try_from(value).map_err(|_| ConfigurationRepositoryError::Corrupt)
}

fn usize_to_i64(value: usize) -> Result<i64, ConfigurationRepositoryError> {
    i64::try_from(value).map_err(|_| ConfigurationRepositoryError::Corrupt)
}

fn database_error(error: sqlx::Error) -> ConfigurationRepositoryError {
    ConfigurationRepositoryError::Database(error)
}

fn internal_error() -> ConfigurationRepositoryError {
    ConfigurationRepositoryError::Database(sqlx::Error::Protocol(
        "internal configuration operation failed".to_owned(),
    ))
}

fn map_server_write_error(error: sqlx::Error) -> ConfigurationRepositoryError {
    if is_unique_violation(&error) {
        ConfigurationRepositoryError::ServerNameConflict
    } else {
        database_error(error)
    }
}

fn map_proxy_write_error(error: sqlx::Error) -> ConfigurationRepositoryError {
    if is_unique_violation(&error) {
        ConfigurationRepositoryError::ProxyNameConflict
    } else {
        database_error(error)
    }
}

fn map_credential_queue_write_error(error: sqlx::Error) -> ConfigurationRepositoryError {
    if is_unique_violation(&error) {
        ConfigurationRepositoryError::Corrupt
    } else {
        database_error(error)
    }
}

fn is_unique_violation(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .is_some_and(|error| error.kind() == ErrorKind::UniqueViolation)
}

fn is_foreign_key_violation(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .is_some_and(|error| error.kind() == ErrorKind::ForeignKeyViolation)
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeSet,
        fs,
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
    };

    use serde::de::DeserializeOwned;
    use serde_json::{Value, json};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::{ConfigurationRepository, ConfigurationRepositoryError};
    use crate::{
        configuration::model::{
            ConfirmProxySshHostKeyRequest, CreateProxyProfileRequest, CreateServerProfileRequest,
            DeleteProxyProfileRequest, DeleteServerProfileRequest, ProxyConfiguration,
            RecordProxyTestRequest, ServerConfigurationInput, UpdateProxyProfileRequest,
            UpdateServerProfileRequest,
        },
        credentials::{
            CredentialDescriptor, CredentialReference, PendingCredentialCleanup,
            ProxyCredentialKind, ServerCredentialKind,
        },
        storage::open_database,
    };

    static TEST_PATH_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TestDatabasePath {
        directory: PathBuf,
        database: PathBuf,
    }

    impl TestDatabasePath {
        fn new(test_name: &str) -> Self {
            let sequence = TEST_PATH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let directory = PathBuf::from(format!(
                "/tmp/codex-desktop-repository-{}-{test_name}-{sequence}",
                std::process::id()
            ));
            let database = directory.join("configuration.sqlite3");
            Self {
                directory,
                database,
            }
        }

        fn database(&self) -> &Path {
            &self.database
        }
    }

    impl Drop for TestDatabasePath {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    async fn memory_repository() -> ConfigurationRepository {
        let options = SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("in-memory database should open");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("migrations should run");
        ConfigurationRepository::new(pool)
    }

    fn request<T: DeserializeOwned>(value: Value) -> T {
        serde_json::from_value(value).expect("test request should deserialize")
    }

    fn local_server(name: &str) -> CreateServerProfileRequest {
        request(json!({
            "name": name,
            "configuration": {
                "type": "localStdio",
                "executablePath": "/usr/bin/codex",
                "arguments": ["app-server"],
                "defaultWorkingDirectory": "/tmp/project",
                "nonSensitiveEnvironment": { "CODEX_MODE": "desktop" }
            }
        }))
    }

    fn http_proxy(name: &str) -> CreateProxyProfileRequest {
        request(json!({
            "name": name,
            "configuration": {
                "type": "httpConnect",
                "url": "https://proxy.example.test:8443",
                "authentication": "none",
                "connectTimeoutMs": 5000,
                "tlsCertificatePolicy": "strict"
            }
        }))
    }

    fn ssh_proxy(name: &str, host: &str) -> CreateProxyProfileRequest {
        request(json!({
            "name": name,
            "configuration": {
                "type": "ssh",
                "host": host,
                "port": 22,
                "username": "alice",
                "authentication": { "type": "agent" },
                "connectTimeoutMs": 5000,
                "keepAliveIntervalMs": 15000,
                "keepAliveMaxFailures": 3
            }
        }))
    }

    #[tokio::test]
    async fn confirms_ssh_host_key_once_for_exact_proxy_endpoint() {
        let repository = memory_repository().await;
        let proxy = repository
            .create_proxy(ssh_proxy("SSH", "ssh.example.test"))
            .await
            .unwrap();
        let fingerprint = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        let confirmed = repository
            .confirm_proxy_ssh_host_key(request::<ConfirmProxySshHostKeyRequest>(json!({
                "proxyId": proxy.proxy_id,
                "expectedVersion": proxy.version,
                "host": "ssh.example.test",
                "port": 22,
                "algorithm": "ssh-ed25519",
                "sha256Fingerprint": fingerprint
            })))
            .await
            .unwrap();
        assert_eq!(confirmed.version, 2);
        assert_eq!(
            confirmed.ssh_host_key.as_ref().unwrap().sha256_fingerprint,
            fingerprint
        );
        let tested = repository
            .record_proxy_test(request::<RecordProxyTestRequest>(json!({
                "proxyId": proxy.proxy_id,
                "expectedVersion": confirmed.version,
                "status": "succeeded"
            })))
            .await
            .unwrap();
        assert_eq!(tested.version, confirmed.version);
        assert!(matches!(
            tested.last_test,
            Some(super::ProxyLastTest {
                status: super::ProxyTestStatus::Succeeded,
                ..
            })
        ));

        let duplicate = repository
            .confirm_proxy_ssh_host_key(request(json!({
                "proxyId": proxy.proxy_id,
                "expectedVersion": confirmed.version,
                "host": "ssh.example.test",
                "port": 22,
                "algorithm": "ssh-ed25519",
                "sha256Fingerprint": fingerprint
            })))
            .await;
        assert!(matches!(
            duplicate,
            Err(ConfigurationRepositoryError::SshHostKeyRemovalRequired)
        ));
    }

    #[tokio::test]
    async fn persists_crud_across_database_reopen() {
        let test_path = TestDatabasePath::new("crud-reopen");
        let repository =
            ConfigurationRepository::new(open_database(test_path.database()).await.unwrap());
        let proxy = repository.create_proxy(http_proxy("Office")).await.unwrap();
        let server = repository
            .create_server(local_server("Local"))
            .await
            .unwrap();
        assert_eq!(proxy.version, 1);
        assert_eq!(server.version, 1);

        let server = repository
            .update_server(request(json!({
                "serverId": server.server_id,
                "expectedVersion": 1,
                "name": "Local Updated",
                "configuration": {
                    "type": "localStdio",
                    "executablePath": "/usr/bin/codex",
                    "arguments": ["app-server", "--listen", "stdio://"],
                    "nonSensitiveEnvironment": {}
                }
            })))
            .await
            .unwrap();
        assert_eq!(server.version, 2);
        let expected = repository.snapshot().await.unwrap();
        repository.close().await;

        let repository =
            ConfigurationRepository::new(open_database(test_path.database()).await.unwrap());
        assert_eq!(repository.snapshot().await.unwrap(), expected);
        repository
            .delete_server(request(json!({
                "serverId": server.server_id,
                "expectedVersion": server.version
            })))
            .await
            .unwrap();
        repository
            .delete_proxy(request(json!({
                "proxyId": proxy.proxy_id,
                "expectedVersion": proxy.version
            })))
            .await
            .unwrap();
        repository.close().await;

        let repository =
            ConfigurationRepository::new(open_database(test_path.database()).await.unwrap());
        let snapshot = repository.snapshot().await.unwrap();
        assert!(snapshot.servers.is_empty());
        assert!(snapshot.proxies.is_empty());
        repository.close().await;
    }

    #[tokio::test]
    async fn enforces_case_insensitive_unique_names() {
        let repository = memory_repository().await;
        repository
            .create_server(local_server("Local"))
            .await
            .unwrap();
        assert!(matches!(
            repository.create_server(local_server("local")).await,
            Err(ConfigurationRepositoryError::ServerNameConflict)
        ));
        repository.create_proxy(http_proxy("Office")).await.unwrap();
        assert!(matches!(
            repository.create_proxy(http_proxy("OFFICE")).await,
            Err(ConfigurationRepositoryError::ProxyNameConflict)
        ));
    }

    #[tokio::test]
    async fn orders_servers_by_last_use_then_recent_creation() {
        let repository = memory_repository().await;
        let oldest = repository
            .create_server(local_server("Oldest"))
            .await
            .unwrap();
        let newest = repository
            .create_server(local_server("Newest"))
            .await
            .unwrap();
        let used = repository
            .create_server(local_server("Used"))
            .await
            .unwrap();
        sqlx::query(
            "UPDATE servers
             SET created_at_ms = CASE server_id WHEN ? THEN 100 WHEN ? THEN 200 ELSE 50 END,
                 updated_at_ms = 300,
                 last_used_at_ms = CASE server_id WHEN ? THEN 250 ELSE NULL END",
        )
        .bind(oldest.server_id.0.to_string())
        .bind(newest.server_id.0.to_string())
        .bind(used.server_id.0.to_string())
        .execute(&repository.pool)
        .await
        .unwrap();
        let snapshot = repository.snapshot().await.unwrap();
        let ids = snapshot
            .servers
            .iter()
            .map(|server| server.server_id)
            .collect::<Vec<_>>();
        assert_eq!(
            ids,
            vec![used.server_id, newest.server_id, oldest.server_id]
        );
    }

    #[tokio::test]
    async fn orders_unicode_names_by_sqlite_nocase_bytes() {
        let repository = memory_repository().await;
        let supplementary = repository
            .create_proxy(http_proxy("\u{10000}"))
            .await
            .unwrap();
        let private_use = repository
            .create_proxy(http_proxy("\u{e000}"))
            .await
            .unwrap();
        sqlx::query("UPDATE proxies SET created_at_ms = 100, updated_at_ms = 100")
            .execute(&repository.pool)
            .await
            .unwrap();

        let proxy_ids = repository
            .snapshot()
            .await
            .unwrap()
            .proxies
            .into_iter()
            .map(|proxy| proxy.proxy_id)
            .collect::<Vec<_>>();
        assert_eq!(
            proxy_ids,
            vec![private_use.proxy_id, supplementary.proxy_id]
        );
    }

    #[tokio::test]
    async fn enforces_proxy_and_window_references() {
        let repository = memory_repository().await;
        let proxy = repository.create_proxy(http_proxy("Office")).await.unwrap();
        let remote = repository
            .create_server(request(json!({
                "name": "Remote",
                "configuration": {
                    "type": "remoteWebSocket",
                    "url": "wss://codex.example.test/app",
                    "authentication": "none",
                    "connectTimeoutMs": 5000,
                    "tlsCertificatePolicy": "strict",
                    "plaintextConfirmed": false,
                    "proxyId": proxy.proxy_id
                }
            })))
            .await
            .unwrap();
        sqlx::query(
            "UPDATE http_proxy_configs
             SET authentication_method = 'bearer',
                 credential_reference = 'credential:referenced-proxy'
             WHERE proxy_id = ?",
        )
        .bind(proxy.proxy_id.0.to_string())
        .execute(&repository.pool)
        .await
        .unwrap();
        assert!(matches!(
            repository
                .delete_proxy(request::<DeleteProxyProfileRequest>(json!({
                    "proxyId": proxy.proxy_id,
                    "expectedVersion": 1
                })))
                .await,
            Err(ConfigurationRepositoryError::ProxyReferenced)
        ));

        let local = repository
            .create_server(local_server("Local"))
            .await
            .unwrap();
        sqlx::query("INSERT INTO window_states (window_id, server_id) VALUES (?, ?)")
            .bind("main")
            .bind(local.server_id.0.to_string())
            .execute(&repository.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO server_window_references (window_id, server_id) VALUES (?, ?)")
            .bind("main")
            .bind(local.server_id.0.to_string())
            .execute(&repository.pool)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE local_server_configs
             SET sensitive_environment_credential_reference = 'credential:window-server'
             WHERE server_id = ?",
        )
        .bind(local.server_id.0.to_string())
        .execute(&repository.pool)
        .await
        .unwrap();
        assert!(matches!(
            repository
                .delete_server(request::<DeleteServerProfileRequest>(json!({
                    "serverId": local.server_id,
                    "expectedVersion": 1
                })))
                .await,
            Err(ConfigurationRepositoryError::ServerInUse)
        ));

        let missing_proxy_id = uuid::Uuid::new_v4();
        assert!(matches!(
            repository
                .create_server(request(json!({
                    "name": "Missing proxy",
                    "configuration": {
                        "type": "remoteWebSocket",
                        "url": "wss://codex.example.test/app",
                        "authentication": "none",
                        "connectTimeoutMs": 5000,
                        "tlsCertificatePolicy": "strict",
                        "plaintextConfirmed": false,
                        "proxyId": missing_proxy_id
                    }
                })))
                .await,
            Err(ConfigurationRepositoryError::ProxyNotFound)
        ));

        repository
            .delete_server(request(json!({
                "serverId": remote.server_id,
                "expectedVersion": 1
            })))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn rejects_stale_server_and_proxy_versions() {
        let repository = memory_repository().await;
        let server = repository
            .create_server(local_server("Local"))
            .await
            .unwrap();
        let update_server = || -> UpdateServerProfileRequest {
            request(json!({
                "serverId": server.server_id,
                "expectedVersion": 1,
                "name": "Updated",
                "configuration": {
                    "type": "localStdio",
                    "executablePath": "/usr/bin/codex",
                    "arguments": [],
                    "nonSensitiveEnvironment": {}
                }
            }))
        };
        assert_eq!(
            repository
                .update_server(update_server())
                .await
                .unwrap()
                .version,
            2
        );
        assert!(matches!(
            repository.update_server(update_server()).await,
            Err(ConfigurationRepositoryError::ServerVersionConflict)
        ));
        assert!(matches!(
            repository
                .delete_server(request(json!({
                    "serverId": server.server_id,
                    "expectedVersion": 1
                })))
                .await,
            Err(ConfigurationRepositoryError::ServerVersionConflict)
        ));

        let proxy = repository.create_proxy(http_proxy("Office")).await.unwrap();
        let update_proxy = || -> UpdateProxyProfileRequest {
            request(json!({
                "proxyId": proxy.proxy_id,
                "expectedVersion": 1,
                "name": "Office Updated",
                "configuration": {
                    "type": "httpConnect",
                    "url": "https://proxy.example.test:9443",
                    "authentication": "none",
                    "connectTimeoutMs": 5000,
                    "tlsCertificatePolicy": "strict"
                }
            }))
        };
        assert_eq!(
            repository
                .update_proxy(update_proxy())
                .await
                .unwrap()
                .version,
            2
        );
        assert!(matches!(
            repository.update_proxy(update_proxy()).await,
            Err(ConfigurationRepositoryError::ProxyVersionConflict)
        ));
    }

    #[tokio::test]
    async fn serializes_concurrent_updates_with_the_same_expected_version() {
        let repository = memory_repository().await;
        let server = repository
            .create_server(local_server("Local"))
            .await
            .unwrap();
        let update = |name: &str| -> UpdateServerProfileRequest {
            request(json!({
                "serverId": server.server_id,
                "expectedVersion": 1,
                "name": name,
                "configuration": {
                    "type": "localStdio",
                    "executablePath": "/usr/bin/codex",
                    "arguments": [],
                    "nonSensitiveEnvironment": {}
                }
            }))
        };
        let second_repository = repository.clone();
        let (first, second) = tokio::join!(
            repository.update_server(update("First")),
            second_repository.update_server(update("Second"))
        );
        let succeeded = usize::from(first.is_ok()) + usize::from(second.is_ok());
        let conflicted = usize::from(matches!(
            first,
            Err(ConfigurationRepositoryError::ServerVersionConflict)
        )) + usize::from(matches!(
            second,
            Err(ConfigurationRepositoryError::ServerVersionConflict)
        ));
        assert_eq!(succeeded, 1);
        assert_eq!(conflicted, 1);
    }

    #[tokio::test]
    async fn increments_proxy_version_and_manages_ssh_host_key_lifecycle() {
        let repository = memory_repository().await;
        let proxy = repository
            .create_proxy(ssh_proxy("SSH", "ssh.example.test"))
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO ssh_host_keys
             (proxy_id, host, port, algorithm, sha256_fingerprint, confirmed_at_ms)
             VALUES (?, ?, 22, ?, ?, 1000)",
        )
        .bind(proxy.proxy_id.0.to_string())
        .bind("ssh.example.test")
        .bind("ssh-ed25519")
        .bind("SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
        .execute(&repository.pool)
        .await
        .unwrap();
        sqlx::query(
            "UPDATE proxies
             SET last_test_status = 'succeeded', last_tested_at_ms = 1000
             WHERE proxy_id = ?",
        )
        .bind(proxy.proxy_id.0.to_string())
        .execute(&repository.pool)
        .await
        .unwrap();

        let unchanged_endpoint = repository
            .update_proxy(request(json!({
                "proxyId": proxy.proxy_id,
                "expectedVersion": 1,
                "name": "SSH Updated",
                "configuration": {
                    "type": "ssh",
                    "host": "ssh.example.test",
                    "port": 22,
                    "username": "bob",
                    "authentication": { "type": "agent" },
                    "connectTimeoutMs": 6000,
                    "keepAliveIntervalMs": 20000,
                    "keepAliveMaxFailures": 4
                }
            })))
            .await
            .unwrap();
        assert_eq!(unchanged_endpoint.version, 2);
        assert!(unchanged_endpoint.ssh_host_key.is_some());
        assert!(unchanged_endpoint.last_test.is_none());

        assert!(matches!(
            repository
                .update_proxy(request(json!({
                    "proxyId": proxy.proxy_id,
                    "expectedVersion": 2,
                    "name": "SSH Updated",
                    "configuration": {
                        "type": "ssh",
                        "host": "ssh2.example.test",
                        "port": 2222,
                        "username": "bob",
                        "authentication": { "type": "agent" },
                        "connectTimeoutMs": 6000,
                        "keepAliveIntervalMs": 20000,
                        "keepAliveMaxFailures": 4
                    }
                })))
                .await,
            Err(ConfigurationRepositoryError::SshHostKeyRemovalRequired)
        ));
        sqlx::query(
            "UPDATE proxies
             SET last_test_status = 'failed', last_tested_at_ms = 2000
             WHERE proxy_id = ?",
        )
        .bind(proxy.proxy_id.0.to_string())
        .execute(&repository.pool)
        .await
        .unwrap();
        let removed = repository
            .remove_proxy_ssh_host_key(request(json!({
                "proxyId": proxy.proxy_id,
                "expectedVersion": 2
            })))
            .await
            .unwrap();
        assert_eq!(removed.version, 3);
        assert!(removed.ssh_host_key.is_none());
        assert!(removed.last_test.is_none());
        assert!(matches!(
            repository
                .remove_proxy_ssh_host_key(request(json!({
                    "proxyId": proxy.proxy_id,
                    "expectedVersion": 3
                })))
                .await,
            Err(ConfigurationRepositoryError::SshHostKeyNotFound)
        ));

        let changed_endpoint = repository
            .update_proxy(request(json!({
                "proxyId": proxy.proxy_id,
                "expectedVersion": 3,
                "name": "SSH Updated",
                "configuration": {
                    "type": "ssh",
                    "host": "ssh2.example.test",
                    "port": 2222,
                    "username": "bob",
                    "authentication": { "type": "agent" },
                    "connectTimeoutMs": 6000,
                    "keepAliveIntervalMs": 20000,
                    "keepAliveMaxFailures": 4
                }
            })))
            .await
            .unwrap();
        assert_eq!(changed_endpoint.version, 4);
        assert!(changed_endpoint.ssh_host_key.is_none());

        sqlx::query(
            "INSERT INTO ssh_host_keys
             (proxy_id, host, port, algorithm, sha256_fingerprint, confirmed_at_ms)
             VALUES (?, ?, 2222, ?, ?, 2000)",
        )
        .bind(proxy.proxy_id.0.to_string())
        .bind("ssh2.example.test")
        .bind("ssh-ed25519")
        .bind("SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
        .execute(&repository.pool)
        .await
        .unwrap();
        assert!(matches!(
            repository
                .update_proxy(request(json!({
                    "proxyId": proxy.proxy_id,
                    "expectedVersion": 4,
                    "name": "HTTP",
                    "configuration": {
                        "type": "httpConnect",
                        "url": "https://proxy.example.test:8443",
                        "authentication": "none",
                        "connectTimeoutMs": 5000,
                        "tlsCertificatePolicy": "strict"
                    }
                })))
                .await,
            Err(ConfigurationRepositoryError::SshHostKeyRemovalRequired)
        ));
        let key_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ssh_host_keys")
            .fetch_one(&repository.pool)
            .await
            .unwrap();
        assert_eq!(key_count, 1);

        let removed = repository
            .remove_proxy_ssh_host_key(request(json!({
                "proxyId": proxy.proxy_id,
                "expectedVersion": 4
            })))
            .await
            .unwrap();
        assert_eq!(removed.version, 5);
        let changed_type = repository
            .update_proxy(request(json!({
                "proxyId": proxy.proxy_id,
                "expectedVersion": 5,
                "name": "HTTP",
                "configuration": {
                    "type": "httpConnect",
                    "url": "https://proxy.example.test:8443",
                    "authentication": "none",
                    "connectTimeoutMs": 5000,
                    "tlsCertificatePolicy": "strict"
                }
            })))
            .await
            .unwrap();
        assert_eq!(changed_type.version, 6);
        assert!(matches!(
            changed_type.configuration,
            ProxyConfiguration::HttpConnect { .. }
        ));
        assert!(changed_type.ssh_host_key.is_none());
        let key_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ssh_host_keys")
            .fetch_one(&repository.pool)
            .await
            .unwrap();
        assert_eq!(key_count, 0);
    }

    #[tokio::test]
    async fn preserves_compatible_credentials_and_queues_deleted_proxy_credentials() {
        let key_paths = TestDatabasePath::new("credential-keys");
        fs::create_dir_all(&key_paths.directory).unwrap();
        let first_key = key_paths.directory.join("first-key");
        let second_key = key_paths.directory.join("second-key");
        fs::write(&first_key, "test key").unwrap();
        fs::write(&second_key, "replacement key").unwrap();
        let first_key = first_key.to_string_lossy().into_owned();
        let second_key = second_key.to_string_lossy().into_owned();

        let repository = memory_repository().await;
        let before_create = super::current_time_ms().unwrap();
        let proxy = repository
            .create_proxy(request(json!({
                "name": "SSH Private Key",
                "configuration": {
                    "type": "ssh",
                    "host": "ssh.example.test",
                    "port": 22,
                    "username": "alice",
                    "authentication": {
                        "type": "privateKey",
                        "privateKeyPath": first_key
                    },
                    "connectTimeoutMs": 5000,
                    "keepAliveIntervalMs": 15000,
                    "keepAliveMaxFailures": 3
                }
            })))
            .await
            .unwrap();
        let after_create = super::current_time_ms().unwrap();
        assert!((before_create..=after_create).contains(&proxy.created_at_ms));
        assert_eq!(proxy.created_at_ms, proxy.updated_at_ms);
        let stored_reference = CredentialReference::new();

        let future_updated_at_ms = after_create + 60_000;
        sqlx::query(
            "UPDATE ssh_proxy_configs
             SET key_passphrase_credential_reference = ?
             WHERE proxy_id = ?",
        )
        .bind(stored_reference.as_str())
        .bind(proxy.proxy_id.0.to_string())
        .execute(&repository.pool)
        .await
        .unwrap();
        sqlx::query(
            "UPDATE proxies
             SET last_test_status = 'succeeded', last_tested_at_ms = 1000,
                 updated_at_ms = ?
             WHERE proxy_id = ?",
        )
        .bind(future_updated_at_ms)
        .bind(proxy.proxy_id.0.to_string())
        .execute(&repository.pool)
        .await
        .unwrap();

        let compatible = repository
            .update_proxy(request(json!({
                "proxyId": proxy.proxy_id,
                "expectedVersion": 1,
                "name": "SSH Private Key Updated",
                "configuration": {
                    "type": "ssh",
                    "host": "ssh.example.test",
                    "port": 22,
                    "username": "alice",
                    "authentication": {
                        "type": "privateKey",
                        "privateKeyPath": first_key
                    },
                    "connectTimeoutMs": 6000,
                    "keepAliveIntervalMs": 20000,
                    "keepAliveMaxFailures": 4
                }
            })))
            .await
            .unwrap();
        assert_eq!(compatible.version, 2);
        assert!(compatible.updated_at_ms > future_updated_at_ms);
        assert!(compatible.last_test.is_none());
        let credential_reference: Option<String> = sqlx::query_scalar(
            "SELECT key_passphrase_credential_reference
             FROM ssh_proxy_configs WHERE proxy_id = ?",
        )
        .bind(proxy.proxy_id.0.to_string())
        .fetch_one(&repository.pool)
        .await
        .unwrap();
        assert_eq!(
            credential_reference.as_deref(),
            Some(stored_reference.as_str())
        );
        assert!(matches!(
            repository
                .clear_proxy_credential(
                    CredentialDescriptor::Proxy {
                        proxy_id: proxy.proxy_id.0,
                        kind: ProxyCredentialKind::SshPassword,
                    },
                    2,
                )
                .await,
            Err(ConfigurationRepositoryError::CredentialConfigurationMismatch)
        ));

        assert!(matches!(
            repository
                .update_proxy(request(json!({
                    "proxyId": proxy.proxy_id,
                    "expectedVersion": 2,
                    "name": "Changed Key",
                    "configuration": {
                        "type": "ssh",
                        "host": "ssh.example.test",
                        "port": 22,
                        "username": "alice",
                        "authentication": {
                            "type": "privateKey",
                            "privateKeyPath": second_key
                        },
                        "connectTimeoutMs": 6000,
                        "keepAliveIntervalMs": 20000,
                        "keepAliveMaxFailures": 4
                    }
                })))
                .await,
            Err(ConfigurationRepositoryError::CredentialChangeRequired)
        ));
        assert!(matches!(
            repository
                .update_proxy(request(json!({
                    "proxyId": proxy.proxy_id,
                    "expectedVersion": 2,
                    "name": "Changed Authentication",
                    "configuration": {
                        "type": "ssh",
                        "host": "ssh.example.test",
                        "port": 22,
                        "username": "alice",
                        "authentication": { "type": "agent" },
                        "connectTimeoutMs": 6000,
                        "keepAliveIntervalMs": 20000,
                        "keepAliveMaxFailures": 4
                    }
                })))
                .await,
            Err(ConfigurationRepositoryError::CredentialChangeRequired)
        ));
        assert!(matches!(
            repository
                .update_proxy(request(json!({
                    "proxyId": proxy.proxy_id,
                    "expectedVersion": 2,
                    "name": "Changed SSH destination",
                    "configuration": {
                        "type": "ssh",
                        "host": "other.example.test",
                        "port": 22,
                        "username": "alice",
                        "authentication": {
                            "type": "privateKey",
                            "privateKeyPath": first_key
                        },
                        "connectTimeoutMs": 6000,
                        "keepAliveIntervalMs": 20000,
                        "keepAliveMaxFailures": 4
                    }
                })))
                .await,
            Err(ConfigurationRepositoryError::CredentialChangeRequired)
        ));
        assert!(matches!(
            repository
                .update_proxy(request(json!({
                    "proxyId": proxy.proxy_id,
                    "expectedVersion": 2,
                    "name": "Changed SSH username",
                    "configuration": {
                        "type": "ssh",
                        "host": "ssh.example.test",
                        "port": 22,
                        "username": "bob",
                        "authentication": {
                            "type": "privateKey",
                            "privateKeyPath": first_key
                        },
                        "connectTimeoutMs": 6000,
                        "keepAliveIntervalMs": 20000,
                        "keepAliveMaxFailures": 4
                    }
                })))
                .await,
            Err(ConfigurationRepositoryError::CredentialChangeRequired)
        ));
        repository
            .delete_proxy(request(json!({
                "proxyId": proxy.proxy_id,
                "expectedVersion": 2
            })))
            .await
            .unwrap();
        assert_eq!(
            repository.pending_credential_cleanup().await.unwrap(),
            vec![PendingCredentialCleanup {
                reference: stored_reference,
                descriptor: CredentialDescriptor::Proxy {
                    proxy_id: proxy.proxy_id.0,
                    kind: ProxyCredentialKind::SshPrivateKeyPassphrase,
                },
            }]
        );
    }

    #[tokio::test]
    async fn reserves_replaces_and_idempotently_clears_server_credentials() {
        let repository = memory_repository().await;
        let server = repository
            .create_server(local_server("Local credentials"))
            .await
            .unwrap();
        assert!(!server.credential_configured);
        let descriptor = CredentialDescriptor::Server {
            server_id: server.server_id.0,
            kind: ServerCredentialKind::SensitiveEnvironment,
        };

        let conflict_reference = CredentialReference::new();
        assert!(matches!(
            repository
                .reserve_credential(
                    descriptor,
                    1,
                    &conflict_reference,
                    Some(&BTreeSet::from(["CODEX_MODE".to_owned()])),
                )
                .await,
            Err(ConfigurationRepositoryError::CredentialConfigurationMismatch)
        ));
        assert!(
            repository
                .pending_credential_cleanup()
                .await
                .unwrap()
                .is_empty()
        );

        let first_reference = CredentialReference::new();
        repository
            .reserve_credential(
                descriptor,
                1,
                &first_reference,
                Some(&BTreeSet::from(["ACCESS_TOKEN".to_owned()])),
            )
            .await
            .unwrap();
        assert_eq!(
            repository.pending_credential_cleanup().await.unwrap(),
            vec![PendingCredentialCleanup {
                reference: first_reference.clone(),
                descriptor,
            }]
        );
        let first = repository
            .commit_server_credential(descriptor, 1, &first_reference)
            .await
            .unwrap();
        assert_eq!(first.version, 2);
        assert!(first.credential_configured);
        assert!(
            repository
                .pending_credential_cleanup()
                .await
                .unwrap()
                .is_empty()
        );

        let second_reference = CredentialReference::new();
        repository
            .reserve_credential(
                descriptor,
                2,
                &second_reference,
                Some(&BTreeSet::from(["ACCESS_TOKEN".to_owned()])),
            )
            .await
            .unwrap();
        let replaced = repository
            .commit_server_credential(descriptor, 2, &second_reference)
            .await
            .unwrap();
        assert_eq!(replaced.version, 3);
        assert!(replaced.credential_configured);
        let pending = repository.pending_credential_cleanup().await.unwrap();
        assert_eq!(
            pending,
            vec![PendingCredentialCleanup {
                reference: first_reference,
                descriptor,
            }]
        );
        repository
            .complete_credential_cleanup(&pending[0])
            .await
            .unwrap();

        let cleared = repository
            .clear_server_credential(descriptor, 3)
            .await
            .unwrap();
        assert_eq!(cleared.version, 4);
        assert!(!cleared.credential_configured);
        let pending = repository.pending_credential_cleanup().await.unwrap();
        assert_eq!(
            pending,
            vec![PendingCredentialCleanup {
                reference: second_reference,
                descriptor,
            }]
        );
        let cleared_again = repository
            .clear_server_credential(descriptor, 4)
            .await
            .unwrap();
        assert_eq!(cleared_again.version, 4);
        assert!(!cleared_again.credential_configured);
        assert_eq!(
            repository.pending_credential_cleanup().await.unwrap(),
            pending
        );
    }

    #[tokio::test]
    async fn loads_an_atomic_connection_plan_with_exact_credential_bindings() {
        let repository = memory_repository().await;
        let proxy = repository
            .create_proxy(request(json!({
                "name": "Authenticated proxy",
                "configuration": {
                    "type": "httpConnect",
                    "url": "https://proxy.example.test:8443",
                    "authentication": "basic",
                    "username": "alice",
                    "connectTimeoutMs": 5000,
                    "tlsCertificatePolicy": "strict"
                }
            })))
            .await
            .unwrap();
        let server = repository
            .create_server(request(json!({
                "name": "Authenticated remote",
                "configuration": {
                    "type": "remoteWebSocket",
                    "url": "wss://codex.example.test/app",
                    "authentication": "bearer",
                    "connectTimeoutMs": 5000,
                    "tlsCertificatePolicy": "strict",
                    "plaintextConfirmed": false,
                    "proxyId": proxy.proxy_id
                }
            })))
            .await
            .unwrap();
        assert!(matches!(
            repository.connection_plan(server.server_id).await,
            Err(ConfigurationRepositoryError::CredentialNotConfigured)
        ));

        let server_descriptor = CredentialDescriptor::Server {
            server_id: server.server_id.0,
            kind: ServerCredentialKind::BearerToken,
        };
        let server_reference = CredentialReference::new();
        repository
            .reserve_credential(server_descriptor, 1, &server_reference, None)
            .await
            .unwrap();
        repository
            .commit_server_credential(server_descriptor, 1, &server_reference)
            .await
            .unwrap();
        assert!(matches!(
            repository.connection_plan(server.server_id).await,
            Err(ConfigurationRepositoryError::CredentialNotConfigured)
        ));

        let proxy_descriptor = CredentialDescriptor::Proxy {
            proxy_id: proxy.proxy_id.0,
            kind: ProxyCredentialKind::HttpBasicPassword,
        };
        let proxy_reference = CredentialReference::new();
        repository
            .reserve_credential(proxy_descriptor, 1, &proxy_reference, None)
            .await
            .unwrap();
        repository
            .commit_proxy_credential(proxy_descriptor, 1, &proxy_reference)
            .await
            .unwrap();

        let plan = repository.connection_plan(server.server_id).await.unwrap();
        assert_eq!(plan.server_id, server.server_id);
        assert_eq!(plan.server_version, 2);
        let server_binding = plan.credential.unwrap();
        assert_eq!(server_binding.reference, server_reference);
        assert_eq!(server_binding.descriptor, server_descriptor);
        let proxy_plan = plan.proxy.unwrap();
        assert_eq!(proxy_plan.proxy_id, proxy.proxy_id);
        assert_eq!(proxy_plan.proxy_version, 2);
        let proxy_binding = proxy_plan.credential.unwrap();
        assert_eq!(proxy_binding.reference, proxy_reference);
        assert_eq!(proxy_binding.descriptor, proxy_descriptor);

        sqlx::query(
            "INSERT INTO credential_cleanup_queue
             (credential_reference, owner_kind, owner_id, credential_kind, queued_at_ms)
             VALUES (?, 'server', ?, 'bearer-token', 1)",
        )
        .bind(server_reference.as_str())
        .bind(server.server_id.0.to_string())
        .execute(&repository.pool)
        .await
        .unwrap();
        assert!(matches!(
            repository.connection_plan(server.server_id).await,
            Err(ConfigurationRepositoryError::Corrupt)
        ));
    }

    #[tokio::test]
    async fn draft_test_plan_uses_the_draft_proxy_and_strict_stored_credential_binding() {
        let repository = memory_repository().await;
        let saved_proxy = repository
            .create_proxy(http_proxy("Saved proxy"))
            .await
            .unwrap();
        let draft_proxy = repository
            .create_proxy(request(json!({
                "name": "Draft proxy",
                "configuration": {
                    "type": "socks5",
                    "host": "proxy.example.test",
                    "port": 1080,
                    "authentication": "none",
                    "dnsResolution": "proxy",
                    "connectTimeoutMs": 5000
                }
            })))
            .await
            .unwrap();
        let server = repository
            .create_server(request(json!({
                "name": "Stored credential source",
                "configuration": {
                    "type": "remoteWebSocket",
                    "url": "wss://codex.example.test/app",
                    "authentication": "bearer",
                    "connectTimeoutMs": 5000,
                    "tlsCertificatePolicy": "strict",
                    "plaintextConfirmed": false,
                    "proxyId": saved_proxy.proxy_id
                }
            })))
            .await
            .unwrap();
        let descriptor = CredentialDescriptor::Server {
            server_id: server.server_id.0,
            kind: ServerCredentialKind::BearerToken,
        };
        let reference = CredentialReference::new();
        repository
            .reserve_credential(descriptor, 1, &reference, None)
            .await
            .unwrap();
        let server = repository
            .commit_server_credential(descriptor, 1, &reference)
            .await
            .unwrap();

        let draft = request::<ServerConfigurationInput>(json!({
            "type": "remoteWebSocket",
            "url": "wss://codex.example.test/other-path",
            "authentication": "bearer",
            "connectTimeoutMs": 7000,
            "tlsCertificatePolicy": "strict",
            "plaintextConfirmed": false,
            "proxyId": draft_proxy.proxy_id
        }))
        .validate()
        .unwrap();
        let plan = repository
            .server_connection_test_plan(draft.clone(), Some((server.server_id, server.version)))
            .await
            .unwrap();
        assert_eq!(plan.credential.unwrap().reference, reference);
        let resolved_proxy = plan.proxy.expect("draft proxy should be resolved");
        assert_eq!(resolved_proxy.proxy_id, draft_proxy.proxy_id);
        assert_ne!(resolved_proxy.proxy_id, saved_proxy.proxy_id);

        assert!(matches!(
            repository
                .server_connection_test_plan(
                    draft.clone(),
                    Some((server.server_id, server.version - 1)),
                )
                .await,
            Err(ConfigurationRepositoryError::ServerVersionConflict)
        ));

        let changed_origin = request::<ServerConfigurationInput>(json!({
            "type": "remoteWebSocket",
            "url": "wss://other.example.test/app",
            "authentication": "bearer",
            "connectTimeoutMs": 5000,
            "tlsCertificatePolicy": "strict",
            "plaintextConfirmed": false,
            "proxyId": draft_proxy.proxy_id
        }))
        .validate()
        .unwrap();
        assert!(matches!(
            repository
                .server_connection_test_plan(
                    changed_origin,
                    Some((server.server_id, server.version)),
                )
                .await,
            Err(ConfigurationRepositoryError::CredentialConfigurationMismatch)
        ));

        let provided_or_none_plan = repository
            .server_connection_test_plan(draft, None)
            .await
            .unwrap();
        assert!(provided_or_none_plan.credential.is_none());
        assert_eq!(
            provided_or_none_plan.proxy.unwrap().proxy_id,
            draft_proxy.proxy_id
        );

        let missing_proxy = request::<ServerConfigurationInput>(json!({
            "type": "remoteWebSocket",
            "url": "wss://codex.example.test/app",
            "authentication": "none",
            "connectTimeoutMs": 5000,
            "tlsCertificatePolicy": "strict",
            "plaintextConfirmed": false,
            "proxyId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        }))
        .validate()
        .unwrap();
        assert!(matches!(
            repository
                .server_connection_test_plan(missing_proxy, None)
                .await,
            Err(ConfigurationRepositoryError::ProxyNotFound)
        ));
    }

    #[tokio::test]
    async fn keeps_credentials_only_when_their_security_binding_is_unchanged() {
        let repository = memory_repository().await;

        let local = repository
            .create_server(local_server("Bound local"))
            .await
            .unwrap();
        let local_descriptor = CredentialDescriptor::Server {
            server_id: local.server_id.0,
            kind: ServerCredentialKind::SensitiveEnvironment,
        };
        let local_reference = CredentialReference::new();
        repository
            .reserve_credential(
                local_descriptor,
                1,
                &local_reference,
                Some(&BTreeSet::from(["RUST_LOG".to_owned()])),
            )
            .await
            .unwrap();
        repository
            .commit_server_credential(local_descriptor, 1, &local_reference)
            .await
            .unwrap();
        let compatible_local = repository
            .update_server(request(json!({
                "serverId": local.server_id,
                "expectedVersion": 2,
                "name": "Bound local updated",
                "configuration": {
                    "type": "localStdio",
                    "executablePath": "/usr/bin/codex",
                    "arguments": ["app-server", "--analytics=false"],
                    "defaultWorkingDirectory": "/tmp/other-project",
                    "nonSensitiveEnvironment": { "CODEX_MODE": "desktop" }
                }
            })))
            .await
            .unwrap();
        assert_eq!(compatible_local.version, 3);
        assert!(compatible_local.credential_configured);
        assert!(matches!(
            repository
                .update_server(request(json!({
                    "serverId": local.server_id,
                    "expectedVersion": 3,
                    "name": "Added environment name",
                    "configuration": {
                        "type": "localStdio",
                        "executablePath": "/usr/bin/codex",
                        "arguments": ["app-server"],
                        "nonSensitiveEnvironment": {
                            "CODEX_MODE": "desktop",
                            "RUST_LOG": "not-sensitive"
                        }
                    }
                })))
                .await,
            Err(ConfigurationRepositoryError::CredentialChangeRequired)
        ));
        assert!(matches!(
            repository
                .update_server(request(json!({
                    "serverId": local.server_id,
                    "expectedVersion": 3,
                    "name": "Changed executable",
                    "configuration": {
                        "type": "localStdio",
                        "executablePath": "/usr/bin/other-codex",
                        "arguments": ["app-server"],
                        "nonSensitiveEnvironment": { "CODEX_MODE": "desktop" }
                    }
                })))
                .await,
            Err(ConfigurationRepositoryError::CredentialChangeRequired)
        ));

        let http = repository
            .create_proxy(request(json!({
                "name": "Bound HTTP",
                "configuration": {
                    "type": "httpConnect",
                    "url": "https://proxy.example.test:8443",
                    "authentication": "basic",
                    "username": "alice",
                    "connectTimeoutMs": 5000,
                    "tlsCertificatePolicy": "strict"
                }
            })))
            .await
            .unwrap();
        let http_descriptor = CredentialDescriptor::Proxy {
            proxy_id: http.proxy_id.0,
            kind: ProxyCredentialKind::HttpBasicPassword,
        };
        let http_reference = CredentialReference::new();
        repository
            .reserve_credential(http_descriptor, 1, &http_reference, None)
            .await
            .unwrap();
        repository
            .commit_proxy_credential(http_descriptor, 1, &http_reference)
            .await
            .unwrap();
        let compatible_http = repository
            .update_proxy(request(json!({
                "proxyId": http.proxy_id,
                "expectedVersion": 2,
                "name": "Bound HTTP updated",
                "configuration": {
                    "type": "httpConnect",
                    "url": "https://PROXY.example.test:8443",
                    "authentication": "basic",
                    "username": "alice",
                    "connectTimeoutMs": 7000,
                    "tlsCertificatePolicy": "strict"
                }
            })))
            .await
            .unwrap();
        assert_eq!(compatible_http.version, 3);
        assert!(matches!(
            repository
                .update_proxy(request(json!({
                    "proxyId": http.proxy_id,
                    "expectedVersion": 3,
                    "name": "Changed HTTP username",
                    "configuration": {
                        "type": "httpConnect",
                        "url": "https://proxy.example.test:8443",
                        "authentication": "basic",
                        "username": "bob",
                        "connectTimeoutMs": 7000,
                        "tlsCertificatePolicy": "strict"
                    }
                })))
                .await,
            Err(ConfigurationRepositoryError::CredentialChangeRequired)
        ));
        assert!(matches!(
            repository
                .update_proxy(request(json!({
                    "proxyId": http.proxy_id,
                    "expectedVersion": 3,
                    "name": "Changed HTTP origin",
                    "configuration": {
                        "type": "httpConnect",
                        "url": "https://other.example.test:8443",
                        "authentication": "basic",
                        "username": "alice",
                        "connectTimeoutMs": 7000,
                        "tlsCertificatePolicy": "strict"
                    }
                })))
                .await,
            Err(ConfigurationRepositoryError::CredentialChangeRequired)
        ));

        let socks = repository
            .create_proxy(request(json!({
                "name": "Bound SOCKS",
                "configuration": {
                    "type": "socks5",
                    "host": "socks.example.test",
                    "port": 1080,
                    "authentication": "usernamePassword",
                    "username": "alice",
                    "dnsResolution": "proxy",
                    "connectTimeoutMs": 5000
                }
            })))
            .await
            .unwrap();
        let socks_descriptor = CredentialDescriptor::Proxy {
            proxy_id: socks.proxy_id.0,
            kind: ProxyCredentialKind::Socks5Password,
        };
        let socks_reference = CredentialReference::new();
        repository
            .reserve_credential(socks_descriptor, 1, &socks_reference, None)
            .await
            .unwrap();
        repository
            .commit_proxy_credential(socks_descriptor, 1, &socks_reference)
            .await
            .unwrap();
        let compatible_socks = repository
            .update_proxy(request(json!({
                "proxyId": socks.proxy_id,
                "expectedVersion": 2,
                "name": "Bound SOCKS updated",
                "configuration": {
                    "type": "socks5",
                    "host": "SOCKS.example.test",
                    "port": 1080,
                    "authentication": "usernamePassword",
                    "username": "alice",
                    "dnsResolution": "local",
                    "connectTimeoutMs": 7000
                }
            })))
            .await
            .unwrap();
        assert_eq!(compatible_socks.version, 3);
        assert!(matches!(
            repository
                .update_proxy(request(json!({
                    "proxyId": socks.proxy_id,
                    "expectedVersion": 3,
                    "name": "Changed SOCKS binding",
                    "configuration": {
                        "type": "socks5",
                        "host": "other.example.test",
                        "port": 1081,
                        "authentication": "usernamePassword",
                        "username": "bob",
                        "dnsResolution": "local",
                        "connectTimeoutMs": 7000
                    }
                })))
                .await,
            Err(ConfigurationRepositoryError::CredentialChangeRequired)
        ));
    }

    #[tokio::test]
    async fn serializes_concurrent_credential_commits_and_keeps_loser_for_cleanup() {
        let repository = memory_repository().await;
        let proxy = repository
            .create_proxy(request(json!({
                "name": "Concurrent HTTP",
                "configuration": {
                    "type": "httpConnect",
                    "url": "https://proxy.example.test:8443",
                    "authentication": "basic",
                    "username": "alice",
                    "connectTimeoutMs": 5000,
                    "tlsCertificatePolicy": "strict"
                }
            })))
            .await
            .unwrap();
        let descriptor = CredentialDescriptor::Proxy {
            proxy_id: proxy.proxy_id.0,
            kind: ProxyCredentialKind::HttpBasicPassword,
        };
        let first_reference = CredentialReference::new();
        let second_reference = CredentialReference::new();
        repository
            .reserve_credential(descriptor, 1, &first_reference, None)
            .await
            .unwrap();
        repository
            .reserve_credential(descriptor, 1, &second_reference, None)
            .await
            .unwrap();

        let first_repository = repository.clone();
        let second_repository = repository.clone();
        let (first_result, second_result) = tokio::join!(
            first_repository.commit_proxy_credential(descriptor, 1, &first_reference),
            second_repository.commit_proxy_credential(descriptor, 1, &second_reference),
        );
        assert_eq!(first_result.is_ok() as u8 + second_result.is_ok() as u8, 1);
        assert!(matches!(
            (&first_result, &second_result),
            (Ok(profile), Err(ConfigurationRepositoryError::ProxyVersionConflict))
                | (Err(ConfigurationRepositoryError::ProxyVersionConflict), Ok(profile))
                if profile.version == 2 && profile.credential_configured
        ));

        let active_reference: String = sqlx::query_scalar(
            "SELECT credential_reference FROM http_proxy_configs WHERE proxy_id = ?",
        )
        .bind(proxy.proxy_id.0.to_string())
        .fetch_one(&repository.pool)
        .await
        .unwrap();
        let pending = repository.pending_credential_cleanup().await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_ne!(pending[0].reference.as_str(), active_reference);

        let mut connection = repository.pool.acquire().await.unwrap();
        super::enqueue_credential_cleanup(
            &mut connection,
            &CredentialReference::parse(&active_reference).unwrap(),
            descriptor,
            super::current_time_ms().unwrap(),
        )
        .await
        .unwrap();
        drop(connection);
        assert!(matches!(
            repository.pending_credential_cleanup().await,
            Err(ConfigurationRepositoryError::Corrupt)
        ));
        let active_pending = PendingCredentialCleanup {
            reference: CredentialReference::parse(&active_reference).unwrap(),
            descriptor,
        };
        assert!(matches!(
            repository
                .complete_credential_cleanup(&active_pending)
                .await,
            Err(ConfigurationRepositoryError::Corrupt)
        ));
    }

    #[tokio::test]
    async fn deletes_bound_proxy_credentials_through_the_cleanup_queue() {
        let repository = memory_repository().await;
        let proxy = repository
            .create_proxy(request(json!({
                "name": "HTTP Basic",
                "configuration": {
                    "type": "httpConnect",
                    "url": "https://proxy.example.test:8443",
                    "authentication": "basic",
                    "username": "alice",
                    "connectTimeoutMs": 5000,
                    "tlsCertificatePolicy": "strict"
                }
            })))
            .await
            .unwrap();
        let descriptor = CredentialDescriptor::Proxy {
            proxy_id: proxy.proxy_id.0,
            kind: ProxyCredentialKind::HttpBasicPassword,
        };
        let wrong_descriptor = CredentialDescriptor::Proxy {
            proxy_id: proxy.proxy_id.0,
            kind: ProxyCredentialKind::HttpBearerToken,
        };
        let reference = CredentialReference::new();
        assert!(matches!(
            repository
                .reserve_credential(wrong_descriptor, 1, &reference, None)
                .await,
            Err(ConfigurationRepositoryError::CredentialConfigurationMismatch)
        ));
        repository
            .reserve_credential(descriptor, 1, &reference, None)
            .await
            .unwrap();
        let configured = repository
            .commit_proxy_credential(descriptor, 1, &reference)
            .await
            .unwrap();
        assert_eq!(configured.version, 2);
        assert!(configured.credential_configured);

        let cleared = repository
            .clear_proxy_credential(descriptor, 2)
            .await
            .unwrap();
        assert_eq!(cleared.version, 3);
        assert!(!cleared.credential_configured);
        let cleared_pending = repository.pending_credential_cleanup().await.unwrap();
        assert_eq!(
            cleared_pending,
            vec![PendingCredentialCleanup {
                reference: reference.clone(),
                descriptor,
            }]
        );
        let cleared_again = repository
            .clear_proxy_credential(descriptor, 3)
            .await
            .unwrap();
        assert_eq!(cleared_again.version, 3);
        assert_eq!(
            repository.pending_credential_cleanup().await.unwrap(),
            cleared_pending
        );
        repository
            .complete_credential_cleanup(&cleared_pending[0])
            .await
            .unwrap();

        let deletion_reference = CredentialReference::new();
        repository
            .reserve_credential(descriptor, 3, &deletion_reference, None)
            .await
            .unwrap();
        repository
            .commit_proxy_credential(descriptor, 3, &deletion_reference)
            .await
            .unwrap();
        repository
            .delete_proxy(request(json!({
                "proxyId": proxy.proxy_id,
                "expectedVersion": 4
            })))
            .await
            .unwrap();
        let pending = repository.pending_credential_cleanup().await.unwrap();
        assert_eq!(
            pending,
            vec![PendingCredentialCleanup {
                reference: deletion_reference.clone(),
                descriptor,
            }]
        );
        assert!(matches!(
            repository
                .complete_credential_cleanup(&PendingCredentialCleanup {
                    reference: deletion_reference,
                    descriptor: wrong_descriptor,
                })
                .await,
            Err(ConfigurationRepositoryError::Corrupt)
        ));
        assert_eq!(
            repository.pending_credential_cleanup().await.unwrap(),
            pending
        );
        repository
            .complete_credential_cleanup(&pending[0])
            .await
            .unwrap();
        repository
            .complete_credential_cleanup(&pending[0])
            .await
            .unwrap();
        assert!(
            repository
                .pending_credential_cleanup()
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn strictly_decodes_and_limits_pending_credential_cleanup() {
        let repository = memory_repository().await;
        let server = repository
            .create_server(local_server("Cleanup owner"))
            .await
            .unwrap();
        let descriptor = CredentialDescriptor::Server {
            server_id: server.server_id.0,
            kind: ServerCredentialKind::SensitiveEnvironment,
        };
        for (reference, owner_kind, credential_kind, queued_at_ms) in [
            (
                "credential:v1:11111111-1111-1111-8111-111111111111",
                "server",
                "sensitive-environment",
                0_i64,
            ),
            (
                "credential:v1:11111111-1111-4111-8111-111111111111",
                "server",
                "ssh-password",
                0_i64,
            ),
            (
                "credential:v1:11111111-1111-4111-8111-111111111112",
                "server",
                "sensitive-environment",
                super::MAX_SAFE_INTEGER + 1,
            ),
        ] {
            assert!(
                sqlx::query(
                    "INSERT INTO credential_cleanup_queue
                     (credential_reference, owner_kind, owner_id, credential_kind, queued_at_ms)
                     VALUES (?, ?, ?, ?, ?)",
                )
                .bind(reference)
                .bind(owner_kind)
                .bind(server.server_id.0.to_string())
                .bind(credential_kind)
                .bind(queued_at_ms)
                .execute(&repository.pool)
                .await
                .is_err()
            );
        }
        let mut references = Vec::new();
        for queued_at_ms in 0..65_i64 {
            let reference = CredentialReference::new();
            sqlx::query(
                "INSERT INTO credential_cleanup_queue
                 (credential_reference, owner_kind, owner_id, credential_kind, queued_at_ms)
                 VALUES (?, 'server', ?, 'sensitive-environment', ?)",
            )
            .bind(reference.as_str())
            .bind(server.server_id.0.to_string())
            .bind(queued_at_ms)
            .execute(&repository.pool)
            .await
            .unwrap();
            references.push(reference);
        }
        let pending = repository.pending_credential_cleanup().await.unwrap();
        assert_eq!(pending.len(), 64);
        assert_eq!(pending[0].reference, references[0]);
        assert_eq!(pending[63].reference, references[63]);
        assert!(pending.iter().all(|item| item.descriptor == descriptor));
        assert_eq!(
            repository
                .pending_credential_cleanup_by_reference(&references[64])
                .await
                .unwrap(),
            Some(PendingCredentialCleanup {
                reference: references[64].clone(),
                descriptor,
            })
        );

        sqlx::query("DELETE FROM credential_cleanup_queue")
            .execute(&repository.pool)
            .await
            .unwrap();
        sqlx::query("PRAGMA ignore_check_constraints = ON")
            .execute(&repository.pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO credential_cleanup_queue
             (credential_reference, owner_kind, owner_id, credential_kind, queued_at_ms)
             VALUES ('credential:invalid', 'server', ?, 'sensitive-environment', 0)",
        )
        .bind(server.server_id.0.to_string())
        .execute(&repository.pool)
        .await
        .unwrap();
        sqlx::query("PRAGMA ignore_check_constraints = OFF")
            .execute(&repository.pool)
            .await
            .unwrap();
        assert!(matches!(
            repository.pending_credential_cleanup().await,
            Err(ConfigurationRepositoryError::Corrupt)
        ));
    }

    #[tokio::test]
    async fn preserves_server_credentials_and_queues_deleted_server_credentials() {
        let repository = memory_repository().await;
        let server = repository
            .create_server(request(json!({
                "name": "Remote",
                "configuration": {
                    "type": "remoteWebSocket",
                    "url": "wss://codex.example.test/app",
                    "authentication": "bearer",
                    "connectTimeoutMs": 5000,
                    "tlsCertificatePolicy": "strict",
                    "plaintextConfirmed": false
                }
            })))
            .await
            .unwrap();
        let stored_reference = CredentialReference::new();
        sqlx::query(
            "UPDATE remote_server_configs
             SET credential_reference = ?
             WHERE server_id = ?",
        )
        .bind(stored_reference.as_str())
        .bind(server.server_id.0.to_string())
        .execute(&repository.pool)
        .await
        .unwrap();

        let compatible = repository
            .update_server(request(json!({
                "serverId": server.server_id,
                "expectedVersion": 1,
                "name": "Remote Updated",
                "configuration": {
                    "type": "remoteWebSocket",
                    "url": "wss://codex.example.test/updated",
                    "authentication": "bearer",
                    "connectTimeoutMs": 6000,
                    "tlsCertificatePolicy": "strict",
                    "plaintextConfirmed": false
                }
            })))
            .await
            .unwrap();
        assert_eq!(compatible.version, 2);
        let credential_reference: Option<String> = sqlx::query_scalar(
            "SELECT credential_reference FROM remote_server_configs WHERE server_id = ?",
        )
        .bind(server.server_id.0.to_string())
        .fetch_one(&repository.pool)
        .await
        .unwrap();
        assert_eq!(
            credential_reference.as_deref(),
            Some(stored_reference.as_str())
        );

        assert!(matches!(
            repository
                .update_server(request(json!({
                    "serverId": server.server_id,
                    "expectedVersion": 2,
                    "name": "Changed Origin",
                    "configuration": {
                        "type": "remoteWebSocket",
                        "url": "wss://other.example.test/updated",
                        "authentication": "bearer",
                        "connectTimeoutMs": 6000,
                        "tlsCertificatePolicy": "strict",
                        "plaintextConfirmed": false
                    }
                })))
                .await,
            Err(ConfigurationRepositoryError::CredentialChangeRequired)
        ));

        assert!(matches!(
            repository
                .update_server(request(json!({
                    "serverId": server.server_id,
                    "expectedVersion": 2,
                    "name": "Remote Without Authentication",
                    "configuration": {
                        "type": "remoteWebSocket",
                        "url": "wss://codex.example.test/updated",
                        "authentication": "none",
                        "connectTimeoutMs": 6000,
                        "tlsCertificatePolicy": "strict",
                        "plaintextConfirmed": false
                    }
                })))
                .await,
            Err(ConfigurationRepositoryError::CredentialChangeRequired)
        ));
        repository
            .delete_server(request(json!({
                "serverId": server.server_id,
                "expectedVersion": 2
            })))
            .await
            .unwrap();
        assert_eq!(
            repository.pending_credential_cleanup().await.unwrap(),
            vec![PendingCredentialCleanup {
                reference: stored_reference,
                descriptor: CredentialDescriptor::Server {
                    server_id: server.server_id.0,
                    kind: ServerCredentialKind::BearerToken,
                },
            }]
        );
    }

    #[tokio::test]
    async fn rejects_corrupt_persisted_configuration() {
        let repository = memory_repository().await;
        let server = repository
            .create_server(local_server("Local"))
            .await
            .unwrap();
        sqlx::query("UPDATE local_server_configs SET arguments_json = '{}' WHERE server_id = ?")
            .bind(server.server_id.0.to_string())
            .execute(&repository.pool)
            .await
            .unwrap();
        assert!(matches!(
            repository.snapshot().await,
            Err(ConfigurationRepositoryError::Corrupt)
        ));
    }

    #[tokio::test]
    async fn never_persists_credentials_or_rejected_secret_payloads() {
        const TEST_SECRET: &str = "repository-secret-sentinel-4f2c";

        let test_path = TestDatabasePath::new("no-secrets");
        let repository =
            ConfigurationRepository::new(open_database(test_path.database()).await.unwrap());
        let rejected = serde_json::from_value::<CreateProxyProfileRequest>(json!({
            "name": "Rejected",
            "configuration": {
                "type": "ssh",
                "host": "ssh.example.test",
                "username": "alice",
                "authentication": { "type": "password", "password": TEST_SECRET },
                "connectTimeoutMs": 5000,
                "keepAliveIntervalMs": 15000,
                "keepAliveMaxFailures": 3
            }
        }));
        assert!(rejected.is_err());

        repository
            .create_proxy(request(json!({
                "name": "HTTP Basic",
                "configuration": {
                    "type": "httpConnect",
                    "url": "https://proxy.example.test:8443",
                    "authentication": "basic",
                    "username": "alice",
                    "connectTimeoutMs": 5000,
                    "tlsCertificatePolicy": "strict"
                }
            })))
            .await
            .unwrap();
        repository
            .create_proxy(request(json!({
                "name": "SOCKS Auth",
                "configuration": {
                    "type": "socks5",
                    "host": "socks.example.test",
                    "port": 1080,
                    "authentication": "usernamePassword",
                    "username": "alice",
                    "dnsResolution": "proxy",
                    "connectTimeoutMs": 5000
                }
            })))
            .await
            .unwrap();
        repository
            .create_proxy(request(json!({
                "name": "SSH Password",
                "configuration": {
                    "type": "ssh",
                    "host": "ssh.example.test",
                    "username": "alice",
                    "authentication": { "type": "password" },
                    "connectTimeoutMs": 5000,
                    "keepAliveIntervalMs": 15000,
                    "keepAliveMaxFailures": 3
                }
            })))
            .await
            .unwrap();
        repository
            .create_server(request(json!({
                "name": "Bearer",
                "configuration": {
                    "type": "remoteWebSocket",
                    "url": "wss://codex.example.test/app",
                    "authentication": "bearer",
                    "connectTimeoutMs": 5000,
                    "tlsCertificatePolicy": "strict",
                    "plaintextConfirmed": false
                }
            })))
            .await
            .unwrap();

        for query in [
            "SELECT credential_reference FROM http_proxy_configs",
            "SELECT credential_reference FROM socks_proxy_configs",
            "SELECT key_passphrase_credential_reference FROM ssh_proxy_configs",
            "SELECT password_credential_reference FROM ssh_proxy_configs",
            "SELECT credential_reference FROM remote_server_configs",
        ] {
            let references: Vec<Option<String>> = sqlx::query_scalar(query)
                .fetch_all(&repository.pool)
                .await
                .unwrap();
            assert!(references.iter().all(Option::is_none));
        }
        for entry in fs::read_dir(&test_path.directory).unwrap() {
            let bytes = fs::read(entry.unwrap().path()).unwrap();
            assert!(
                !bytes
                    .windows(TEST_SECRET.len())
                    .any(|window| window == TEST_SECRET.as_bytes())
            );
        }
        repository.close().await;
    }
}
