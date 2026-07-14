use std::{
    collections::{HashMap, VecDeque},
    fmt,
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{Runtime, State, WebviewWindow, ipc::Channel};
use tokio::time::timeout;

use crate::configuration::{
    ConfigurationRepository, ConfigurationRepositoryError, ConfigurationValidationError,
    CredentialManager, CredentialOperationError, DraftProxyConnectionInput,
    HttpProxyAuthentication as ConfiguredHttpAuthentication, ProxyConfiguration,
    ProxyConfigurationRequest, ProxyConnectionTestCredentialSource, ProxyId,
    RemoteServerAuthentication, ResolvedCredential, ResolvedDraftProxyConnection,
    ResolvedProxyConnection, ResolvedServerConnection, ServerConfiguration,
    ServerConfigurationInput, ServerConnectionTestCredentialSource, ServerId,
    Socks5Authentication as ConfiguredSocks5Authentication,
    Socks5DnsResolution as ConfiguredSocks5DnsResolution, SshAuthenticationConfiguration,
    SshHostKeyRecord,
};

use super::{
    LocalStdioConnectionManager, RemoteWebSocketConnectionManager,
    connection_id::ConnectionId,
    http_connect::{
        HttpConnectAuthentication, open_http_proxy_websocket_with_progress,
        validate_http_connect_proxy,
    },
    lifecycle::ConnectionLifecycle,
    local_stdio::{self, ConfiguredLocalStdioRequest},
    remote_websocket::{
        self, ConnectionProgressCallback, ValidatedTarget, connect_error,
        open_direct_websocket_with_progress,
    },
    shared_pool::{
        ConfiguredConnectionManager, OutboundDisposition, PHYSICAL_CONNECTION_OWNER,
        PhysicalConnectionKey, PhysicalConnectionMetadata, SharedConnectionAttachment,
        SharedPoolError,
    },
    socks5::{
        Socks5DnsResolution, Socks5ProxyAuthentication, open_socks5_proxy_websocket_with_progress,
        validate_socks5_proxy,
    },
    ssh_tunnel::{
        self, SshAuthentication, ValidatedSshTunnel, open_ssh_tunnel_websocket_with_progress,
        parse_ssh_host,
    },
};

pub(crate) use super::shared_pool::{
    ConfiguredConnectionEvent, ConfiguredConnectionPath, ConfiguredServerStatusesEvent,
    ConfiguredTransport,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConnectConfiguredServerRequest {
    connection_id: String,
    server_id: ServerId,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CancelConfiguredServerConnectionRequest {
    connection_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SendConfiguredServerMessageRequest {
    connection_id: String,
    json: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DisconnectConfiguredServerRequest {
    connection_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UnsubscribeConfiguredServerStatusesRequest {
    subscription_id: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConnectServerConnectionTestRequest {
    connection_id: String,
    configuration: ServerConfigurationInput,
    credential_source: ServerConnectionTestCredentialSource,
    #[serde(default)]
    proxy: Option<ProxyConnectionTestRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProxyConnectionTestRequest {
    configuration: ProxyConfigurationRequest,
    credential_source: ProxyConnectionTestCredentialSource,
    #[serde(default)]
    ssh_host_key: Option<ProxyConnectionTestSshHostKeyRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProxyConnectionTestSshHostKeyRequest {
    host: String,
    port: u16,
    algorithm: String,
    sha256_fingerprint: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CancelServerConnectionTestRequest {
    connection_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectConfiguredServerResponse {
    connection_id: String,
    server_id: ServerId,
    server_version: u64,
    transport: ConfiguredTransport,
    connection_path: ConfiguredConnectionPath,
    #[serde(skip_serializing_if = "Option::is_none")]
    proxy_id: Option<ProxyId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    proxy_version: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectServerConnectionTestResponse {
    connection_id: String,
    transport: ConfiguredTransport,
    connection_path: ConfiguredConnectionPath,
    #[serde(skip_serializing_if = "Option::is_none")]
    proxy_id: Option<ProxyId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    proxy_version: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "transport",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ServerConnectionTestEvent {
    LocalStdio {
        event: local_stdio::ConnectionEvent,
    },
    RemoteWebSocket {
        event: remote_websocket::ConnectionEvent,
    },
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub(crate) enum ConfiguredConnectionError {
    Configuration(crate::configuration::commands::ConfigurationCommandError),
    Local(local_stdio::CommandError),
    Remote(remote_websocket::CommandError),
    Request(ConfiguredRequestError),
}

impl fmt::Display for ConfiguredConnectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Configuration(error) => fmt::Display::fmt(error, formatter),
            Self::Local(error) => fmt::Display::fmt(error, formatter),
            Self::Remote(error) => fmt::Display::fmt(error, formatter),
            Self::Request(error) => fmt::Display::fmt(error, formatter),
        }
    }
}

impl std::error::Error for ConfiguredConnectionError {}

impl ProxyConnectionTestRequest {
    fn validate(self) -> Result<DraftProxyConnectionInput, ConfiguredConnectionError> {
        let configuration = self.configuration.validate_for_connection_test()?;
        let ssh_host_key = self
            .ssh_host_key
            .map(|record| {
                SshHostKeyRecord::for_connection_test(
                    record.host,
                    record.port,
                    record.algorithm,
                    record.sha256_fingerprint,
                )
            })
            .transpose()?;
        match (&configuration, &ssh_host_key) {
            (ProxyConfiguration::Ssh { host, port, .. }, Some(record))
                if host == &record.host && port == &record.port => {}
            (_, None) => {}
            _ => return Err(corrupt_configuration()),
        }
        Ok(DraftProxyConnectionInput {
            configuration,
            credential_source: self.credential_source,
            ssh_host_key,
        })
    }
}

impl From<local_stdio::CommandError> for ConfiguredConnectionError {
    fn from(error: local_stdio::CommandError) -> Self {
        Self::Local(error)
    }
}

impl From<remote_websocket::CommandError> for ConfiguredConnectionError {
    fn from(error: remote_websocket::CommandError) -> Self {
        Self::Remote(error)
    }
}

impl From<CredentialOperationError> for ConfiguredConnectionError {
    fn from(error: CredentialOperationError) -> Self {
        Self::Configuration(error.into())
    }
}

impl From<ConfigurationValidationError> for ConfiguredConnectionError {
    fn from(error: ConfigurationValidationError) -> Self {
        Self::Configuration(ConfigurationRepositoryError::from(error).into())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfiguredRequestError {
    code: &'static str,
    message: &'static str,
}

impl ConfiguredRequestError {
    const fn invalid_connection_id() -> Self {
        Self {
            code: "invalidConnectionId",
            message: "The connection ID is invalid",
        }
    }

    const fn already_connected() -> Self {
        Self {
            code: "connectionAlreadyExists",
            message: "The connection ID is already in use",
        }
    }

    const fn not_connected() -> Self {
        Self {
            code: "connectionNotFound",
            message: "The configured connection does not exist",
        }
    }

    const fn not_owned() -> Self {
        Self {
            code: "connectionNotOwned",
            message: "The configured connection belongs to another window",
        }
    }

    const fn invalid_protocol_message() -> Self {
        Self {
            code: "invalidProtocolMessage",
            message: "The configured protocol message is invalid",
        }
    }

    const fn shared_connection_failed() -> Self {
        Self {
            code: "sharedConnectionFailed",
            message: "The shared physical connection could not be established",
        }
    }

    const fn event_delivery_failed() -> Self {
        Self {
            code: "eventDeliveryFailed",
            message: "The connection owner cannot receive connection events",
        }
    }

    const fn connection_cancelled() -> Self {
        Self {
            code: "connectionCancelled",
            message: "The connection attempt was cancelled",
        }
    }

    const fn corrupt_configuration() -> Self {
        Self {
            code: "configurationCorrupt",
            message: "The persisted connection configuration is corrupt",
        }
    }
}

impl fmt::Display for ConfiguredRequestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for ConfiguredRequestError {}

struct AttemptConnectionEntry {
    owner_window_label: String,
    generation: u64,
    lifecycle: Arc<ConnectionLifecycle>,
}

struct PreCancelledConnection {
    owner_window_label: String,
    connection_id: ConnectionId,
}

const MAX_PRE_CANCELLED_CONNECTIONS_PER_WINDOW: usize = 64;
const MAX_PRE_CANCELLED_CONNECTIONS: usize = 1_024;

#[derive(Default)]
struct ConnectionAttemptManagerState {
    connections: HashMap<ConnectionId, AttemptConnectionEntry>,
    pre_cancelled: VecDeque<PreCancelledConnection>,
}

impl ConnectionAttemptManagerState {
    fn take_pre_cancellation(
        &mut self,
        owner_window_label: &str,
        connection_id: &ConnectionId,
    ) -> bool {
        let position = self.pre_cancelled.iter().position(|entry| {
            entry.owner_window_label == owner_window_label && entry.connection_id == *connection_id
        });
        position
            .and_then(|position| self.pre_cancelled.remove(position))
            .is_some()
    }

    fn record_pre_cancellation(&mut self, owner_window_label: &str, connection_id: &ConnectionId) {
        if self.pre_cancelled.iter().any(|entry| {
            entry.owner_window_label == owner_window_label && entry.connection_id == *connection_id
        }) {
            return;
        }

        let owner_count = self
            .pre_cancelled
            .iter()
            .filter(|entry| entry.owner_window_label == owner_window_label)
            .count();
        if owner_count >= MAX_PRE_CANCELLED_CONNECTIONS_PER_WINDOW
            && let Some(position) = self
                .pre_cancelled
                .iter()
                .position(|entry| entry.owner_window_label == owner_window_label)
        {
            self.pre_cancelled.remove(position);
        }
        if self.pre_cancelled.len() >= MAX_PRE_CANCELLED_CONNECTIONS {
            self.pre_cancelled.pop_front();
        }
        self.pre_cancelled.push_back(PreCancelledConnection {
            owner_window_label: owner_window_label.to_owned(),
            connection_id: connection_id.clone(),
        });
    }
}

#[derive(Default)]
struct ConnectionAttemptManagerInner {
    state: Mutex<ConnectionAttemptManagerState>,
    next_generation: AtomicU64,
}

impl ConnectionAttemptManagerInner {
    fn state(&self) -> MutexGuard<'_, ConnectionAttemptManagerState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn remove_if_generation(&self, connection_id: &ConnectionId, generation: u64) {
        let mut state = self.state();
        if state
            .connections
            .get(connection_id)
            .is_some_and(|entry| entry.generation == generation)
        {
            state.connections.remove(connection_id);
        }
    }
}

#[derive(Clone, Default)]
struct ConnectionAttemptManager {
    inner: Arc<ConnectionAttemptManagerInner>,
}

#[derive(Clone, Default)]
pub(crate) struct ServerConnectionTestManager {
    attempts: ConnectionAttemptManager,
}

impl ServerConnectionTestManager {
    fn reserve(
        &self,
        owner_window_label: String,
        connection_id: ConnectionId,
    ) -> Result<ConnectionReservation, ConfiguredConnectionError> {
        self.attempts.reserve(owner_window_label, connection_id)
    }

    pub(crate) fn disconnect_window(&self, owner_window_label: &str) {
        self.attempts.disconnect_window(owner_window_label);
    }

    fn cancel_connection(&self, owner_window_label: &str, connection_id: &ConnectionId) {
        self.attempts
            .cancel_connection(owner_window_label, connection_id);
    }
}

impl ConnectionAttemptManager {
    fn reserve(
        &self,
        owner_window_label: String,
        connection_id: ConnectionId,
    ) -> Result<ConnectionReservation, ConfiguredConnectionError> {
        let generation = self.inner.next_generation.fetch_add(1, Ordering::Relaxed);
        let mut state = self.inner.state();
        if state.connections.contains_key(&connection_id) {
            return Err(ConfiguredConnectionError::Request(
                ConfiguredRequestError::already_connected(),
            ));
        }
        if state.take_pre_cancellation(&owner_window_label, &connection_id) {
            return Err(connection_cancelled());
        }
        let lifecycle = Arc::new(ConnectionLifecycle::default());
        state.connections.insert(
            connection_id.clone(),
            AttemptConnectionEntry {
                owner_window_label,
                generation,
                lifecycle: Arc::clone(&lifecycle),
            },
        );
        drop(state);
        Ok(ConnectionReservation {
            manager: Arc::clone(&self.inner),
            connection_id,
            generation,
            lifecycle,
            committed: false,
        })
    }

    pub(crate) fn disconnect_window(&self, owner_window_label: &str) {
        let lifecycles = {
            let mut state = self.inner.state();
            state
                .pre_cancelled
                .retain(|entry| entry.owner_window_label != owner_window_label);
            state
                .connections
                .values()
                .filter(|entry| entry.owner_window_label == owner_window_label)
                .map(|entry| Arc::clone(&entry.lifecycle))
                .collect::<Vec<_>>()
        };
        for lifecycle in lifecycles {
            lifecycle.cancel();
        }
    }

    fn cancel_connection(&self, owner_window_label: &str, connection_id: &ConnectionId) {
        let lifecycle = {
            let mut state = self.inner.state();
            match state.connections.get(connection_id) {
                Some(entry) if entry.owner_window_label == owner_window_label => {
                    Some(Arc::clone(&entry.lifecycle))
                }
                Some(_) => None,
                None => {
                    state.record_pre_cancellation(owner_window_label, connection_id);
                    None
                }
            }
        };
        if let Some(lifecycle) = lifecycle {
            lifecycle.cancel();
        }
    }
}

struct ConnectionReservation {
    manager: Arc<ConnectionAttemptManagerInner>,
    connection_id: ConnectionId,
    generation: u64,
    lifecycle: Arc<ConnectionLifecycle>,
    committed: bool,
}

impl ConnectionReservation {
    fn local_test_event_sink(
        &self,
        events: Channel<ServerConnectionTestEvent>,
    ) -> Arc<dyn local_stdio::EventSink> {
        Arc::new(LocalTestEventSink {
            manager: Arc::clone(&self.manager),
            connection_id: self.connection_id.clone(),
            generation: self.generation,
            events,
        })
    }

    fn remote_test_event_sink(
        &self,
        events: Channel<ServerConnectionTestEvent>,
    ) -> Arc<dyn remote_websocket::EventSink> {
        Arc::new(RemoteTestEventSink {
            manager: Arc::clone(&self.manager),
            connection_id: self.connection_id.clone(),
            generation: self.generation,
            events,
        })
    }

    fn commit(&mut self) {
        self.committed = true;
    }

    fn lifecycle(&self) -> &Arc<ConnectionLifecycle> {
        &self.lifecycle
    }
}

impl Drop for ConnectionReservation {
    fn drop(&mut self) {
        if !self.committed {
            self.manager
                .remove_if_generation(&self.connection_id, self.generation);
        }
    }
}

struct LocalTestEventSink {
    manager: Arc<ConnectionAttemptManagerInner>,
    connection_id: ConnectionId,
    generation: u64,
    events: Channel<ServerConnectionTestEvent>,
}

impl local_stdio::EventSink for LocalTestEventSink {
    fn emit(&self, event: local_stdio::ConnectionEvent) -> Result<(), ()> {
        if local_event_is_terminal(&event) {
            self.manager
                .remove_if_generation(&self.connection_id, self.generation);
        }
        self.events
            .send(ServerConnectionTestEvent::LocalStdio { event })
            .map_err(|_| ())
    }
}

struct RemoteTestEventSink {
    manager: Arc<ConnectionAttemptManagerInner>,
    connection_id: ConnectionId,
    generation: u64,
    events: Channel<ServerConnectionTestEvent>,
}

impl remote_websocket::EventSink for RemoteTestEventSink {
    fn emit(&self, event: remote_websocket::ConnectionEvent) -> Result<(), ()> {
        if remote_event_is_terminal(&event) {
            self.manager
                .remove_if_generation(&self.connection_id, self.generation);
        }
        self.events
            .send(ServerConnectionTestEvent::RemoteWebSocket { event })
            .map_err(|_| ())
    }
}

fn local_event_is_terminal(event: &local_stdio::ConnectionEvent) -> bool {
    matches!(
        event,
        local_stdio::ConnectionEvent::Status { status, .. }
            if *status != local_stdio::ConnectionStatus::Connected
    )
}

fn remote_event_is_terminal(event: &remote_websocket::ConnectionEvent) -> bool {
    matches!(
        event,
        remote_websocket::ConnectionEvent::Status { status, .. }
            if *status != remote_websocket::ConnectionStatus::Connected
    )
}

#[tauri::command]
pub(crate) fn subscribe_configured_server_statuses<R: Runtime>(
    window: WebviewWindow<R>,
    configured_manager: State<'_, ConfiguredConnectionManager>,
    events: Channel<ConfiguredServerStatusesEvent>,
) -> Result<u64, ConfiguredConnectionError> {
    if window.as_ref().url().is_err() {
        return Err(connection_cancelled());
    }
    configured_manager
        .subscribe_statuses(window.label().to_owned(), events)
        .map_err(shared_pool_error)
}

#[tauri::command]
pub(crate) fn unsubscribe_configured_server_statuses<R: Runtime>(
    window: WebviewWindow<R>,
    configured_manager: State<'_, ConfiguredConnectionManager>,
    request: UnsubscribeConfiguredServerStatusesRequest,
) {
    configured_manager.unsubscribe_statuses(window.label(), request.subscription_id);
}

#[tauri::command]
pub(crate) fn cancel_configured_server_connection<R: Runtime>(
    window: WebviewWindow<R>,
    configured_manager: State<'_, ConfiguredConnectionManager>,
    request: CancelConfiguredServerConnectionRequest,
) -> Result<(), ConfiguredConnectionError> {
    let connection_id = ConnectionId::parse(request.connection_id).map_err(|_| {
        ConfiguredConnectionError::Request(ConfiguredRequestError::invalid_connection_id())
    })?;
    // 与连接命令使用同一 WebView 存活校验，避免已销毁窗口的排队取消命令
    // 在标签被复用后影响新的窗口实例
    if window.as_ref().url().is_err() {
        return Err(connection_cancelled());
    }
    configured_manager.cancel_connection(window.label(), &connection_id);
    Ok(())
}

#[tauri::command]
pub(crate) async fn send_configured_server_message<R: Runtime>(
    window: WebviewWindow<R>,
    configured_manager: State<'_, ConfiguredConnectionManager>,
    local_manager: State<'_, LocalStdioConnectionManager>,
    remote_manager: State<'_, RemoteWebSocketConnectionManager>,
    request: SendConfiguredServerMessageRequest,
) -> Result<(), ConfiguredConnectionError> {
    let connection_id = ConnectionId::parse(request.connection_id).map_err(|_| {
        ConfiguredConnectionError::Request(ConfiguredRequestError::invalid_connection_id())
    })?;
    let disposition = configured_manager
        .prepare_outbound(window.label(), &connection_id, &request.json)
        .map_err(shared_pool_error)?;
    match disposition {
        OutboundDisposition::Suppress => Ok(()),
        OutboundDisposition::Forward(physical) => {
            let lifecycle = Arc::clone(&physical.lifecycle);
            let result = match physical.transport {
                ConfiguredTransport::LocalStdio => local_manager
                    .send(
                        PHYSICAL_CONNECTION_OWNER,
                        local_stdio::SendLocalStdioMessageRequest {
                            connection_id: physical.connection_id.into_string(),
                            json: request.json,
                        },
                    )
                    .await
                    .map_err(Into::into),
                ConfiguredTransport::RemoteWebSocket => remote_manager
                    .send(
                        PHYSICAL_CONNECTION_OWNER,
                        remote_websocket::SendRemoteWebSocketMessageRequest {
                            connection_id: physical.connection_id.into_string(),
                            json: request.json,
                        },
                    )
                    .await
                    .map_err(Into::into),
            };
            if result.is_err() {
                lifecycle.cancel();
            }
            result
        }
    }
}

#[tauri::command]
pub(crate) fn disconnect_configured_server<R: Runtime>(
    window: WebviewWindow<R>,
    configured_manager: State<'_, ConfiguredConnectionManager>,
    request: DisconnectConfiguredServerRequest,
) -> Result<(), ConfiguredConnectionError> {
    let connection_id = ConnectionId::parse(request.connection_id).map_err(|_| {
        ConfiguredConnectionError::Request(ConfiguredRequestError::invalid_connection_id())
    })?;
    configured_manager
        .release(window.label(), &connection_id)
        .map_err(shared_pool_error)
}

#[tauri::command]
pub(crate) fn cancel_server_connection_test<R: Runtime>(
    window: WebviewWindow<R>,
    test_manager: State<'_, ServerConnectionTestManager>,
    request: CancelServerConnectionTestRequest,
) -> Result<(), ConfiguredConnectionError> {
    let connection_id = ConnectionId::parse(request.connection_id).map_err(|_| {
        ConfiguredConnectionError::Request(ConfiguredRequestError::invalid_connection_id())
    })?;
    if window.as_ref().url().is_err() {
        return Err(connection_cancelled());
    }
    test_manager.cancel_connection(window.label(), &connection_id);
    Ok(())
}

#[tauri::command]
#[allow(
    clippy::too_many_arguments,
    reason = "Tauri injects each independently managed connection service at the IPC boundary"
)]
pub(crate) async fn connect_configured_server<R: Runtime>(
    window: WebviewWindow<R>,
    configured_manager: State<'_, ConfiguredConnectionManager>,
    local_manager: State<'_, LocalStdioConnectionManager>,
    remote_manager: State<'_, RemoteWebSocketConnectionManager>,
    repository: State<'_, ConfigurationRepository>,
    credentials: State<'_, CredentialManager>,
    request: ConnectConfiguredServerRequest,
    events: Channel<ConfiguredConnectionEvent>,
) -> Result<ConnectConfiguredServerResponse, ConfiguredConnectionError> {
    let connection_id = ConnectionId::parse(request.connection_id).map_err(|_| {
        ConfiguredConnectionError::Request(ConfiguredRequestError::invalid_connection_id())
    })?;
    let owner_window_label = window.label().to_owned();
    let mut reservation = configured_manager
        .reserve(owner_window_label, connection_id.clone())
        .map_err(shared_pool_error)?;
    // The dispatcher belongs to this exact WebView instance, unlike its reusable label. A queued
    // command from a destroyed window therefore fails even if another window reused the label.
    if reservation.lifecycle().cancellation().is_cancelled() || window.as_ref().url().is_err() {
        return Err(connection_cancelled());
    }
    let resolved = tokio::select! {
        biased;
        _ = reservation.lifecycle().cancellation().cancelled() => return Err(connection_cancelled()),
        result = credentials.resolve_server_connection(&repository, request.server_id) => result?,
    };

    let (key, metadata) = shared_physical_identity(&resolved)?;
    let mut attachment = configured_manager
        .attach(&mut reservation, key, metadata, events)
        .map_err(shared_pool_error)?;
    if attachment.created()
        && let Err(error) = start_shared_physical_connection(
            &configured_manager,
            &local_manager,
            &remote_manager,
            resolved,
            &attachment,
        )
        .await
    {
        configured_manager.fail_start(attachment.key, attachment.generation);
        return Err(error);
    }
    if let Err(error) = attachment
        .wait_until_connected(reservation.lifecycle())
        .await
    {
        return Err(shared_pool_error(error));
    }
    if reservation.lifecycle().cancellation().is_cancelled() || window.as_ref().url().is_err() {
        return Err(connection_cancelled());
    }
    let metadata = attachment.metadata;
    let response = ConnectConfiguredServerResponse {
        connection_id: connection_id.into_string(),
        server_id: metadata.server_id,
        server_version: metadata.server_version,
        transport: metadata.transport,
        connection_path: metadata.connection_path,
        proxy_id: metadata.proxy_id,
        proxy_version: metadata.proxy_version,
    };
    reservation.commit();
    Ok(response)
}

fn shared_physical_identity(
    resolved: &ResolvedServerConnection,
) -> Result<(PhysicalConnectionKey, PhysicalConnectionMetadata), ConfiguredConnectionError> {
    let proxy = resolved
        .proxy
        .as_ref()
        .map(|proxy| (proxy.proxy_id, proxy.proxy_version));
    let (transport, connection_path) = match (&resolved.configuration, &resolved.proxy) {
        (ServerConfiguration::LocalStdio { .. }, None) => (
            ConfiguredTransport::LocalStdio,
            ConfiguredConnectionPath::LocalStdio,
        ),
        (ServerConfiguration::LocalStdio { .. }, Some(_)) => return Err(corrupt_configuration()),
        (ServerConfiguration::RemoteWebSocket { .. }, None) => (
            ConfiguredTransport::RemoteWebSocket,
            ConfiguredConnectionPath::Direct,
        ),
        (ServerConfiguration::RemoteWebSocket { .. }, Some(proxy)) => (
            ConfiguredTransport::RemoteWebSocket,
            match &proxy.configuration {
                ProxyConfiguration::HttpConnect { .. } => ConfiguredConnectionPath::HttpConnect,
                ProxyConfiguration::Socks5 { .. } => ConfiguredConnectionPath::Socks5,
                ProxyConfiguration::Ssh { .. } => ConfiguredConnectionPath::SshDirectTcpip,
            },
        ),
    };
    let key = PhysicalConnectionKey::new(resolved.server_id, resolved.server_version, proxy);
    Ok((
        key,
        PhysicalConnectionMetadata {
            server_id: resolved.server_id,
            server_version: resolved.server_version,
            transport,
            connection_path,
            proxy_id: proxy.map(|(proxy_id, _)| proxy_id),
            proxy_version: proxy.map(|(_, proxy_version)| proxy_version),
        },
    ))
}

async fn start_shared_physical_connection(
    configured_manager: &ConfiguredConnectionManager,
    local_manager: &LocalStdioConnectionManager,
    remote_manager: &RemoteWebSocketConnectionManager,
    resolved: ResolvedServerConnection,
    attachment: &SharedConnectionAttachment,
) -> Result<(), ConfiguredConnectionError> {
    match resolved.configuration {
        configuration @ ServerConfiguration::LocalStdio { .. } => {
            let sensitive_environment = match resolved.credential {
                None => None,
                Some(ResolvedCredential::SensitiveEnvironment(environment)) => Some(environment),
                Some(_) => return Err(corrupt_configuration()),
            };
            if resolved.proxy.is_some() {
                return Err(corrupt_configuration());
            }
            local_manager
                .connect_configured(
                    PHYSICAL_CONNECTION_OWNER.to_owned(),
                    ConfiguredLocalStdioRequest {
                        connection_id: attachment.physical.connection_id.as_str().to_owned(),
                        configuration,
                        working_directory_override: None,
                        sensitive_environment,
                        lifecycle: Arc::clone(&attachment.physical.lifecycle),
                    },
                    configured_manager.local_event_sink(attachment),
                )
                .await?;
        }
        ServerConfiguration::RemoteWebSocket {
            url,
            authentication,
            non_sensitive_headers,
            connect_timeout_ms,
            tls_certificate_policy,
            plaintext_confirmed,
            proxy_id: _,
        } => {
            let mut target = ValidatedTarget::parse_with_tls_policy(
                &url,
                plaintext_confirmed,
                connect_timeout_ms,
                &non_sensitive_headers,
                tls_certificate_policy,
            )?;
            apply_server_authentication(&mut target, authentication, resolved.credential)?;
            let event_sink = configured_manager.remote_event_sink(attachment);
            let progress = remote_connection_progress(
                Arc::clone(&event_sink),
                attachment.physical.connection_id.clone(),
            );
            let (path, connector) = match resolved.proxy {
                None => {
                    let connector = async move {
                        match timeout(
                            target.connect_timeout,
                            open_direct_websocket_with_progress(target, progress),
                        )
                        .await
                        {
                            Ok(Ok(websocket)) => Ok(websocket),
                            Ok(Err(error)) => Err(connect_error(error)),
                            Err(_) => Err(remote_websocket::CommandError::connect_timed_out()),
                        }
                    };
                    (
                        ConfiguredConnectionPath::Direct,
                        Box::pin(connector) as ConfiguredProxyConnector,
                    )
                }
                Some(proxy) => configured_proxy_connector(target, proxy.into(), progress)?,
            };
            remote_manager
                .connect_prepared(
                    PHYSICAL_CONNECTION_OWNER.to_owned(),
                    attachment.physical.connection_id.clone(),
                    path.as_str(),
                    event_sink,
                    Some(&attachment.physical.lifecycle),
                    connector,
                )
                .await?;
        }
    }
    Ok(())
}

#[tauri::command]
#[allow(
    clippy::too_many_arguments,
    reason = "Tauri injects each independently managed connection-test service at the IPC boundary"
)]
pub(crate) async fn connect_server_connection_test<R: Runtime>(
    window: WebviewWindow<R>,
    test_manager: State<'_, ServerConnectionTestManager>,
    local_manager: State<'_, LocalStdioConnectionManager>,
    remote_manager: State<'_, RemoteWebSocketConnectionManager>,
    repository: State<'_, ConfigurationRepository>,
    credentials: State<'_, CredentialManager>,
    request: ConnectServerConnectionTestRequest,
    events: Channel<ServerConnectionTestEvent>,
) -> Result<ConnectServerConnectionTestResponse, ConfiguredConnectionError> {
    let ConnectServerConnectionTestRequest {
        connection_id,
        configuration,
        credential_source,
        proxy,
    } = request;
    let connection_id = ConnectionId::parse(connection_id).map_err(|_| {
        ConfiguredConnectionError::Request(ConfiguredRequestError::invalid_connection_id())
    })?;
    let owner_window_label = window.label().to_owned();
    let mut reservation =
        test_manager.reserve(owner_window_label.clone(), connection_id.clone())?;
    if reservation.lifecycle().cancellation().is_cancelled() || window.as_ref().url().is_err() {
        return Err(connection_cancelled());
    }
    let configuration = configuration.validate()?;
    let draft_proxy = proxy
        .map(ProxyConnectionTestRequest::validate)
        .transpose()?;
    if draft_proxy.is_some()
        && !matches!(
            &configuration,
            ServerConfiguration::RemoteWebSocket { proxy_id: None, .. }
        )
    {
        return Err(corrupt_configuration());
    }
    let resolved = tokio::select! {
        biased;
        _ = reservation.lifecycle().cancellation().cancelled() => return Err(connection_cancelled()),
        result = credentials.resolve_server_connection_test(
            &repository,
            configuration,
            credential_source,
            draft_proxy,
        ) => result?,
    };

    let response = match resolved.configuration {
        configuration @ ServerConfiguration::LocalStdio { .. } => {
            let sensitive_environment = match resolved.credential {
                None => None,
                Some(ResolvedCredential::SensitiveEnvironment(environment)) => Some(environment),
                Some(_) => return Err(corrupt_configuration()),
            };
            if resolved.proxy.is_some() {
                return Err(corrupt_configuration());
            }
            let event_sink = reservation.local_test_event_sink(events);
            local_manager
                .connect_configured(
                    owner_window_label,
                    ConfiguredLocalStdioRequest {
                        connection_id: connection_id.as_str().to_owned(),
                        configuration,
                        working_directory_override: None,
                        sensitive_environment,
                        lifecycle: Arc::clone(reservation.lifecycle()),
                    },
                    event_sink,
                )
                .await?;
            ConnectServerConnectionTestResponse {
                connection_id: connection_id.as_str().to_owned(),
                transport: ConfiguredTransport::LocalStdio,
                connection_path: ConfiguredConnectionPath::LocalStdio,
                proxy_id: None,
                proxy_version: None,
            }
        }
        ServerConfiguration::RemoteWebSocket {
            url,
            authentication,
            non_sensitive_headers,
            connect_timeout_ms,
            tls_certificate_policy,
            plaintext_confirmed,
            proxy_id: _,
        } => {
            let mut target = ValidatedTarget::parse_with_tls_policy(
                &url,
                plaintext_confirmed,
                connect_timeout_ms,
                &non_sensitive_headers,
                tls_certificate_policy,
            )?;
            apply_server_authentication(&mut target, authentication, resolved.credential)?;
            let event_sink = reservation.remote_test_event_sink(events);
            let progress =
                remote_connection_progress(Arc::clone(&event_sink), connection_id.clone());
            let (connection_path, proxy_id, proxy_version) = match resolved.proxy {
                None => {
                    let connector = async move {
                        match timeout(
                            target.connect_timeout,
                            open_direct_websocket_with_progress(target, progress),
                        )
                        .await
                        {
                            Ok(Ok(websocket)) => Ok(websocket),
                            Ok(Err(error)) => Err(connect_error(error)),
                            Err(_) => Err(remote_websocket::CommandError::connect_timed_out()),
                        }
                    };
                    remote_manager
                        .connect_prepared(
                            owner_window_label,
                            connection_id.clone(),
                            "direct",
                            event_sink,
                            Some(reservation.lifecycle()),
                            connector,
                        )
                        .await?;
                    (ConfiguredConnectionPath::Direct, None, None)
                }
                Some(proxy) => {
                    let proxy_id = proxy.proxy_id;
                    let proxy_version = proxy.proxy_version;
                    let (path, connector) =
                        configured_proxy_connector(target, proxy.into(), progress)?;
                    remote_manager
                        .connect_prepared(
                            owner_window_label,
                            connection_id.clone(),
                            path.as_str(),
                            event_sink,
                            Some(reservation.lifecycle()),
                            connector,
                        )
                        .await?;
                    (path, proxy_id, proxy_version)
                }
            };
            ConnectServerConnectionTestResponse {
                connection_id: connection_id.as_str().to_owned(),
                transport: ConfiguredTransport::RemoteWebSocket,
                connection_path,
                proxy_id,
                proxy_version,
            }
        }
    };
    reservation.commit();
    Ok(response)
}

fn apply_server_authentication(
    target: &mut ValidatedTarget,
    authentication: RemoteServerAuthentication,
    credential: Option<ResolvedCredential>,
) -> Result<(), ConfiguredConnectionError> {
    match (authentication, credential) {
        (RemoteServerAuthentication::None, None) => Ok(()),
        (RemoteServerAuthentication::Bearer, Some(ResolvedCredential::BearerToken(token))) => {
            target.set_bearer_token(&token).map_err(Into::into)
        }
        _ => Err(corrupt_configuration()),
    }
}

fn corrupt_configuration() -> ConfiguredConnectionError {
    ConfiguredConnectionError::Request(ConfiguredRequestError::corrupt_configuration())
}

fn connection_cancelled() -> ConfiguredConnectionError {
    ConfiguredConnectionError::Request(ConfiguredRequestError::connection_cancelled())
}

fn shared_pool_error(error: SharedPoolError) -> ConfiguredConnectionError {
    let error = match error {
        SharedPoolError::AlreadyConnected => ConfiguredRequestError::already_connected(),
        SharedPoolError::Cancelled => ConfiguredRequestError::connection_cancelled(),
        SharedPoolError::NotFound => ConfiguredRequestError::not_connected(),
        SharedPoolError::NotOwned => ConfiguredRequestError::not_owned(),
        SharedPoolError::InvalidMessage => ConfiguredRequestError::invalid_protocol_message(),
        SharedPoolError::StartFailed => ConfiguredRequestError::shared_connection_failed(),
        SharedPoolError::EventDeliveryFailed => ConfiguredRequestError::event_delivery_failed(),
    };
    ConfiguredConnectionError::Request(error)
}

type ConfiguredProxyConnector = Pin<
    Box<
        dyn Future<
                Output = Result<remote_websocket::RemoteWebSocket, remote_websocket::CommandError>,
            > + Send,
    >,
>;

struct PreparedProxyConnection {
    configuration: ProxyConfiguration,
    credential: Option<ResolvedCredential>,
    ssh_host_key: Option<SshHostKeyRecord>,
}

impl From<ResolvedProxyConnection> for PreparedProxyConnection {
    fn from(proxy: ResolvedProxyConnection) -> Self {
        Self {
            configuration: proxy.configuration,
            credential: proxy.credential,
            ssh_host_key: proxy.ssh_host_key,
        }
    }
}

impl From<ResolvedDraftProxyConnection> for PreparedProxyConnection {
    fn from(proxy: ResolvedDraftProxyConnection) -> Self {
        Self {
            configuration: proxy.configuration,
            credential: proxy.credential,
            ssh_host_key: proxy.ssh_host_key,
        }
    }
}

fn remote_connection_progress(
    event_sink: Arc<dyn remote_websocket::EventSink>,
    connection_id: ConnectionId,
) -> ConnectionProgressCallback {
    Arc::new(move |stage| {
        let _ = event_sink.emit(remote_websocket::ConnectionEvent::progress(
            &connection_id,
            stage,
        ));
    })
}

fn configured_proxy_connector(
    target: ValidatedTarget,
    proxy: PreparedProxyConnection,
    progress: ConnectionProgressCallback,
) -> Result<(ConfiguredConnectionPath, ConfiguredProxyConnector), ConfiguredConnectionError> {
    match proxy.configuration {
        ProxyConfiguration::HttpConnect {
            url,
            authentication,
            username,
            non_sensitive_headers,
            connect_timeout_ms,
            tls_certificate_policy,
        } => {
            if proxy.ssh_host_key.is_some() {
                return Err(corrupt_configuration());
            }
            let validated_proxy = validate_http_connect_proxy(
                url,
                connect_timeout_ms,
                non_sensitive_headers,
                tls_certificate_policy,
            )?;
            let authentication = match (authentication, username, proxy.credential) {
                (ConfiguredHttpAuthentication::None, None, None) => HttpConnectAuthentication::None,
                (
                    ConfiguredHttpAuthentication::Basic,
                    Some(username),
                    Some(ResolvedCredential::HttpBasicPassword(password)),
                ) => HttpConnectAuthentication::Basic { username, password },
                (
                    ConfiguredHttpAuthentication::Bearer,
                    None,
                    Some(ResolvedCredential::HttpBearerToken(token)),
                ) => HttpConnectAuthentication::Bearer { token },
                _ => return Err(corrupt_configuration()),
            };
            Ok((
                ConfiguredConnectionPath::HttpConnect,
                Box::pin(open_http_proxy_websocket_with_progress(
                    target,
                    validated_proxy,
                    authentication,
                    progress,
                )),
            ))
        }
        ProxyConfiguration::Socks5 {
            host,
            port,
            authentication,
            username,
            dns_resolution,
            connect_timeout_ms,
        } => {
            if proxy.ssh_host_key.is_some() {
                return Err(corrupt_configuration());
            }
            let dns_resolution = match dns_resolution {
                ConfiguredSocks5DnsResolution::Proxy => Socks5DnsResolution::Proxy,
                ConfiguredSocks5DnsResolution::Local => Socks5DnsResolution::Local,
            };
            let validated_proxy =
                validate_socks5_proxy(host, port, dns_resolution, connect_timeout_ms)?;
            let authentication = match (authentication, username, proxy.credential) {
                (ConfiguredSocks5Authentication::None, None, None) => {
                    Socks5ProxyAuthentication::None
                }
                (
                    ConfiguredSocks5Authentication::UsernamePassword,
                    Some(username),
                    Some(ResolvedCredential::Socks5Password(password)),
                ) => Socks5ProxyAuthentication::UsernamePassword { username, password },
                _ => return Err(corrupt_configuration()),
            };
            Ok((
                ConfiguredConnectionPath::Socks5,
                Box::pin(open_socks5_proxy_websocket_with_progress(
                    target,
                    validated_proxy,
                    authentication,
                    progress,
                )),
            ))
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
            let authentication = match (authentication, proxy.credential) {
                (SshAuthenticationConfiguration::Agent {}, None) => SshAuthentication::Agent,
                (SshAuthenticationConfiguration::PrivateKey { private_key_path }, credential) => {
                    let passphrase = match credential {
                        None => None,
                        Some(ResolvedCredential::SshPrivateKeyPassphrase(passphrase)) => {
                            Some(passphrase)
                        }
                        Some(_) => return Err(corrupt_configuration()),
                    };
                    SshAuthentication::PrivateKey {
                        private_key_path: PathBuf::from(private_key_path),
                        passphrase,
                    }
                }
                (
                    SshAuthenticationConfiguration::Password {},
                    Some(ResolvedCredential::SshPassword(password)),
                ) => SshAuthentication::Password { password },
                _ => return Err(corrupt_configuration()),
            };
            let host_key = proxy
                .ssh_host_key
                .map(|record| {
                    ssh_tunnel::SshHostKeyRecord::parse(
                        record.algorithm,
                        &record.sha256_fingerprint,
                    )
                })
                .transpose()?;
            let tunnel = ValidatedSshTunnel {
                host: parse_ssh_host(&host)?,
                port,
                username,
                authentication,
                host_key,
                connect_timeout: Duration::from_millis(connect_timeout_ms),
                keep_alive_interval: Duration::from_millis(keep_alive_interval_ms),
                keep_alive_max_failures,
            };
            Ok((
                ConfiguredConnectionPath::SshDirectTcpip,
                Box::pin(open_ssh_tunnel_websocket_with_progress(
                    target, tunnel, progress,
                )),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CancelConfiguredServerConnectionRequest, CancelServerConnectionTestRequest,
        ConfiguredConnectionEvent, ConfiguredConnectionPath, ConfiguredTransport,
        ConnectConfiguredServerRequest, ConnectConfiguredServerResponse,
        ConnectServerConnectionTestRequest, ConnectServerConnectionTestResponse,
        ConnectionAttemptManager, MAX_PRE_CANCELLED_CONNECTIONS_PER_WINDOW,
        ServerConnectionTestEvent, ServerConnectionTestManager,
    };
    use crate::configuration::ServerId;
    use crate::connection::connection_id::ConnectionId;
    use serde_json::json;
    use std::sync::Arc;

    #[test]
    fn request_contract_rejects_raw_connection_settings() {
        let request = json!({
            "connectionId": "connection-1",
            "serverId": "11111111-1111-4111-8111-111111111111",
            "url": "wss://example.com"
        });
        assert!(serde_json::from_value::<ConnectConfiguredServerRequest>(request).is_err());
    }

    #[test]
    fn connection_test_contract_accepts_only_draft_configuration_and_credential_source() {
        let request = json!({
            "connectionId": "test-connection-1",
            "configuration": {
                "type": "remoteWebSocket",
                "url": "wss://example.test/app",
                "authentication": "bearer",
                "connectTimeoutMs": 5000,
                "tlsCertificatePolicy": "strict",
                "plaintextConfirmed": false
            },
            "credentialSource": {
                "type": "provided",
                "credential": {
                    "type": "bearerToken",
                    "value": "SECRET_TEST_TOKEN"
                }
            },
            "proxy": {
                "configuration": {
                    "type": "httpConnect",
                    "url": "http://proxy.example.test:8080",
                    "authentication": "basic",
                    "username": "draft-user",
                    "connectTimeoutMs": 5000,
                    "tlsCertificatePolicy": "strict"
                },
                "credentialSource": {
                    "type": "provided",
                    "credential": {
                        "type": "httpBasicPassword",
                        "value": "DRAFT_PROXY_SECRET"
                    }
                }
            }
        });
        let parsed = serde_json::from_value::<ConnectServerConnectionTestRequest>(request)
            .expect("draft test request should deserialize");
        assert!(!format!("{parsed:?}").contains("SECRET_TEST_TOKEN"));
        assert!(!format!("{parsed:?}").contains("DRAFT_PROXY_SECRET"));

        assert!(
            serde_json::from_value::<ConnectServerConnectionTestRequest>(json!({
                "connectionId": "test-connection-1",
                "serverId": "11111111-1111-4111-8111-111111111111",
                "configuration": {
                    "type": "localStdio",
                    "executablePath": "/usr/bin/codex",
                    "arguments": []
                },
                "credentialSource": { "type": "none" }
            }))
            .is_err()
        );
    }

    #[test]
    fn connection_test_response_omits_proxy_fields_unless_a_proxy_was_resolved() {
        let direct = ConnectServerConnectionTestResponse {
            connection_id: "test-connection-1".to_owned(),
            transport: ConfiguredTransport::RemoteWebSocket,
            connection_path: ConfiguredConnectionPath::Direct,
            proxy_id: None,
            proxy_version: None,
        };
        assert_eq!(
            serde_json::to_value(direct).unwrap(),
            json!({
                "connectionId": "test-connection-1",
                "transport": "remoteWebSocket",
                "connectionPath": "direct"
            })
        );
    }

    #[test]
    fn response_contract_exposes_versions_and_selected_path() {
        let server_id: ServerId =
            serde_json::from_value(json!("11111111-1111-4111-8111-111111111111")).unwrap();
        let response = ConnectConfiguredServerResponse {
            connection_id: "connection-1".to_owned(),
            server_id,
            server_version: 3,
            transport: ConfiguredTransport::RemoteWebSocket,
            connection_path: ConfiguredConnectionPath::Direct,
            proxy_id: None,
            proxy_version: None,
        };
        assert_eq!(
            serde_json::to_value(response).unwrap(),
            json!({
                "connectionId": "connection-1",
                "serverId": "11111111-1111-4111-8111-111111111111",
                "serverVersion": 3,
                "transport": "remoteWebSocket",
                "connectionPath": "direct"
            })
        );
    }

    #[test]
    fn event_contract_carries_camel_case_server_and_transport_correlation() {
        let server_id: ServerId =
            serde_json::from_value(json!("11111111-1111-4111-8111-111111111111")).unwrap();
        let event = ConfiguredConnectionEvent::LocalStdio {
            server_id,
            event: crate::connection::local_stdio::ConnectionEvent::Status {
                connection_id: "connection-1".to_owned(),
                status: crate::connection::local_stdio::ConnectionStatus::Connected,
                reason: None,
                exit_code: None,
                signal: None,
                stderr_bytes: 0,
                forced: false,
            },
        };

        assert_eq!(
            serde_json::to_value(event).unwrap(),
            json!({
                "serverId": "11111111-1111-4111-8111-111111111111",
                "transport": "localStdio",
                "event": {
                    "kind": "status",
                    "connectionId": "connection-1",
                    "status": "connected",
                    "stderrBytes": 0,
                    "forced": false
                }
            })
        );
    }

    #[test]
    fn connection_test_event_contract_uses_transport_without_a_persisted_server_id() {
        let event = ServerConnectionTestEvent::RemoteWebSocket {
            event: crate::connection::remote_websocket::ConnectionEvent::Status {
                connection_id: "test-connection-1".to_owned(),
                status: crate::connection::remote_websocket::ConnectionStatus::Connected,
                reason: None,
                close_code: None,
                forced: false,
            },
        };
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            json!({
                "transport": "remoteWebSocket",
                "event": {
                    "kind": "status",
                    "connectionId": "test-connection-1",
                    "status": "connected",
                    "forced": false
                }
            })
        );
    }

    #[test]
    fn reserves_connection_ids_across_transport_managers() {
        let manager = ConnectionAttemptManager::default();
        let id = ConnectionId::parse("connection-1".to_owned()).unwrap();
        let _reservation = manager.reserve("main".to_owned(), id.clone()).unwrap();
        assert!(manager.reserve("other".to_owned(), id).is_err());
    }

    #[test]
    fn window_disconnect_cancels_only_its_pending_reservations() {
        let manager = ConnectionAttemptManager::default();
        let main = manager
            .reserve(
                "main".to_owned(),
                ConnectionId::parse("main-connection".to_owned()).unwrap(),
            )
            .unwrap();
        let other = manager
            .reserve(
                "other".to_owned(),
                ConnectionId::parse("other-connection".to_owned()).unwrap(),
            )
            .unwrap();

        manager.disconnect_window("main");

        assert!(main.lifecycle().cancellation().is_cancelled());
        assert!(!other.lifecycle().cancellation().is_cancelled());
    }

    #[test]
    fn cancellation_request_contract_accepts_only_connection_id() {
        let request = serde_json::from_value::<CancelConfiguredServerConnectionRequest>(json!({
            "connectionId": "connection-1"
        }));
        assert!(request.is_ok());
        assert!(
            serde_json::from_value::<CancelConfiguredServerConnectionRequest>(json!({
                "connectionId": "connection-1",
                "serverId": "11111111-1111-4111-8111-111111111111"
            }))
            .is_err()
        );
    }

    #[test]
    fn connection_cancellation_requires_matching_window_and_connection_id() {
        let manager = ConnectionAttemptManager::default();
        let main_id = ConnectionId::parse("main-connection".to_owned()).unwrap();
        let other_id = ConnectionId::parse("other-connection".to_owned()).unwrap();
        let main = manager.reserve("main".to_owned(), main_id.clone()).unwrap();
        let other = manager
            .reserve("other".to_owned(), other_id.clone())
            .unwrap();

        manager.cancel_connection("other", &main_id);
        manager.cancel_connection("main", &other_id);
        assert!(!main.lifecycle().cancellation().is_cancelled());
        assert!(!other.lifecycle().cancellation().is_cancelled());

        manager.cancel_connection("main", &main_id);
        assert!(main.lifecycle().cancellation().is_cancelled());
        assert!(!other.lifecycle().cancellation().is_cancelled());
    }

    #[test]
    fn test_cancellation_is_isolated_from_configured_connections() {
        let configured_manager = ConnectionAttemptManager::default();
        let test_manager = ServerConnectionTestManager::default();
        let id = ConnectionId::parse("shared-correlation-id".to_owned()).unwrap();
        let configured = configured_manager
            .reserve("main".to_owned(), id.clone())
            .unwrap();
        let test = test_manager.reserve("main".to_owned(), id.clone()).unwrap();

        test_manager.cancel_connection("main", &id);

        assert!(test.lifecycle().cancellation().is_cancelled());
        assert!(!configured.lifecycle().cancellation().is_cancelled());
    }

    #[test]
    fn test_cancellation_request_accepts_only_connection_id() {
        assert!(
            serde_json::from_value::<CancelServerConnectionTestRequest>(json!({
                "connectionId": "test-connection-1"
            }))
            .is_ok()
        );
        assert!(
            serde_json::from_value::<CancelServerConnectionTestRequest>(json!({
                "connectionId": "test-connection-1",
                "serverId": "11111111-1111-4111-8111-111111111111"
            }))
            .is_err()
        );
    }

    #[test]
    fn active_configured_connection_keeps_cancellable_lifecycle() {
        let manager = ConnectionAttemptManager::default();
        let id = ConnectionId::parse("active-connection".to_owned()).unwrap();
        let mut reservation = manager.reserve("main".to_owned(), id.clone()).unwrap();
        let lifecycle = Arc::clone(reservation.lifecycle());
        reservation.commit();
        drop(reservation);

        manager.cancel_connection("main", &id);

        assert!(lifecycle.cancellation().is_cancelled());
    }

    #[test]
    fn cancellation_arriving_before_reservation_is_consumed_once() {
        let manager = ConnectionAttemptManager::default();
        let id = ConnectionId::parse("racing-connection".to_owned()).unwrap();

        manager.cancel_connection("main", &id);

        assert!(manager.reserve("main".to_owned(), id.clone()).is_err());
        assert!(manager.reserve("main".to_owned(), id).is_ok());
    }

    #[test]
    fn wrong_window_cannot_leave_a_pre_cancellation_for_an_owned_connection() {
        let manager = ConnectionAttemptManager::default();
        let id = ConnectionId::parse("owned-connection".to_owned()).unwrap();
        let reservation = manager.reserve("owner".to_owned(), id.clone()).unwrap();

        manager.cancel_connection("other", &id);
        drop(reservation);

        assert!(manager.reserve("other".to_owned(), id).is_ok());
    }

    #[test]
    fn window_disconnect_clears_unused_pre_cancellations() {
        let manager = ConnectionAttemptManager::default();
        let id = ConnectionId::parse("abandoned-cancellation".to_owned()).unwrap();
        manager.cancel_connection("main", &id);

        manager.disconnect_window("main");

        assert!(manager.reserve("main".to_owned(), id).is_ok());
    }

    #[test]
    fn unused_pre_cancellations_are_bounded_per_window() {
        let manager = ConnectionAttemptManager::default();
        for index in 0..=MAX_PRE_CANCELLED_CONNECTIONS_PER_WINDOW {
            let id = ConnectionId::parse(format!("abandoned-{index}")).unwrap();
            manager.cancel_connection("main", &id);
        }

        let state = manager.inner.state();
        assert_eq!(
            state
                .pre_cancelled
                .iter()
                .filter(|entry| entry.owner_window_label == "main")
                .count(),
            MAX_PRE_CANCELLED_CONNECTIONS_PER_WINDOW
        );
    }
}
