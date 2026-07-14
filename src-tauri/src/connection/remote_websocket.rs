use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fmt,
    future::Future,
    io,
    net::{IpAddr, SocketAddr},
    sync::{
        Arc, Mutex, MutexGuard, OnceLock, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use rustls::{
    ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    pki_types::{CertificateDer, ServerName, UnixTime},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Runtime, State, WebviewWindow};
use tokio::{
    io::{AsyncRead, AsyncWrite, AsyncWriteExt},
    net::{TcpStream, lookup_host},
    sync::{mpsc, oneshot},
    task::JoinHandle,
    time::{Instant, timeout, timeout_at},
};
use tokio_rustls::TlsConnector;
use tokio_tungstenite::{
    WebSocketStream, client_async_with_config,
    tungstenite::{
        Error as WebSocketError, Message,
        client::IntoClientRequest,
        error::CapacityError,
        handshake::client::Request as WebSocketRequest,
        http::{HeaderName, HeaderValue, header::AUTHORIZATION},
        protocol::WebSocketConfig,
    },
};
use tokio_util::sync::CancellationToken;
use url::{Host, Url};

use crate::{
    authentication_policy::is_valid_bearer_token,
    configuration::{SecretText, TlsCertificatePolicy},
    header_policy::is_reserved_websocket_header,
    sensitive::looks_sensitive_identifier,
};

use super::{connection_id::ConnectionId, lifecycle::ConnectionLifecycle};

const MAX_URL_BYTES: usize = 4 * 1024;
const MAX_HEADER_COUNT: usize = 32;
const MAX_HEADER_NAME_BYTES: usize = 128;
const MAX_HEADER_VALUE_BYTES: usize = 8 * 1024;
const MAX_PROTOCOL_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_RESOLVED_ADDRESSES: usize = 32;
const OUTBOUND_QUEUE_CAPACITY: usize = 64;
const MIN_CONNECT_TIMEOUT_MS: u64 = 1_000;
const MAX_CONNECT_TIMEOUT_MS: u64 = 120_000;
const GRACEFUL_CLOSE_TIMEOUT: Duration = Duration::from_secs(1);
const MANAGER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

pub(super) trait RemoteTransport: AsyncRead + AsyncWrite + Unpin + Send {}

impl<T> RemoteTransport for T where T: AsyncRead + AsyncWrite + Unpin + Send {}

pub(super) type BoxedRemoteTransport = Box<dyn RemoteTransport>;
pub(super) type RemoteWebSocket = WebSocketStream<BoxedRemoteTransport>;
pub(super) type ConnectionProgressCallback = Arc<dyn Fn(RemoteConnectionStage) + Send + Sync>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RemoteTransportFailure {
    SshKeepAliveTimedOut,
}

impl fmt::Display for RemoteTransportFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SshKeepAliveTimedOut => formatter.write_str("SSH keep-alive timed out"),
        }
    }
}

impl std::error::Error for RemoteTransportFailure {}

pub(super) fn remote_transport_error(failure: RemoteTransportFailure) -> io::Error {
    io::Error::other(failure)
}

fn remote_transport_termination(error: &io::Error) -> Option<TerminationReason> {
    error
        .get_ref()
        .and_then(|source| source.downcast_ref::<RemoteTransportFailure>())
        .map(|_| TerminationReason::SshKeepAliveTimedOut)
}

#[cfg(test)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConnectDirectWebSocketRequest {
    connection_id: String,
    url: String,
    insecure_transport_confirmed: bool,
    connect_timeout_ms: u64,
    #[serde(default)]
    non_sensitive_headers: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SendRemoteWebSocketMessageRequest {
    pub(super) connection_id: String,
    pub(super) json: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DisconnectRemoteWebSocketRequest {
    connection_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectRemoteWebSocketResponse {
    pub(super) connection_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ConnectionStatus {
    Connected,
    Disconnected,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RemoteConnectionStage {
    ResolvingTarget,
    ConnectingProxy,
    ProxyAuthentication,
    EstablishingTunnel,
    TargetTls,
    WebSocketHandshake,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminationReason {
    Requested,
    RemoteClosed,
    InvalidJson,
    BinaryMessage,
    UnsupportedMessage,
    MessageTooLarge,
    ReadFailed,
    WriteFailed,
    EventDeliveryFailed,
    SshKeepAliveTimedOut,
}

impl TerminationReason {
    fn status(self) -> ConnectionStatus {
        match self {
            Self::Requested | Self::RemoteClosed => ConnectionStatus::Disconnected,
            Self::InvalidJson
            | Self::BinaryMessage
            | Self::UnsupportedMessage
            | Self::MessageTooLarge
            | Self::ReadFailed
            | Self::WriteFailed
            | Self::EventDeliveryFailed
            | Self::SshKeepAliveTimedOut => ConnectionStatus::Error,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ConnectionEvent {
    Progress {
        connection_id: String,
        stage: RemoteConnectionStage,
    },
    ProtocolMessage {
        connection_id: String,
        json: String,
    },
    Status {
        connection_id: String,
        status: ConnectionStatus,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<TerminationReason>,
        #[serde(skip_serializing_if = "Option::is_none")]
        close_code: Option<u16>,
        forced: bool,
    },
}

impl ConnectionEvent {
    pub(super) fn progress(connection_id: &ConnectionId, stage: RemoteConnectionStage) -> Self {
        Self::Progress {
            connection_id: connection_id.as_str().to_owned(),
            stage,
        }
    }

    fn connected(connection_id: &ConnectionId) -> Self {
        Self::Status {
            connection_id: connection_id.as_str().to_owned(),
            status: ConnectionStatus::Connected,
            reason: None,
            close_code: None,
            forced: false,
        }
    }

    fn protocol_message(connection_id: &ConnectionId, json: String) -> Self {
        Self::ProtocolMessage {
            connection_id: connection_id.as_str().to_owned(),
            json,
        }
    }

    fn terminated(
        connection_id: &ConnectionId,
        reason: TerminationReason,
        close_code: Option<u16>,
        forced: bool,
    ) -> Self {
        Self::Status {
            connection_id: connection_id.as_str().to_owned(),
            status: reason.status(),
            reason: Some(reason),
            close_code,
            forced,
        }
    }
}

pub(super) trait EventSink: Send + Sync {
    fn emit(&self, event: ConnectionEvent) -> Result<(), ()>;
}

#[derive(Debug)]
pub(super) struct ValidatedTarget {
    pub(super) scheme: TargetScheme,
    pub(super) host: TargetHost,
    pub(super) port: u16,
    request: WebSocketRequest,
    pub(super) connect_timeout: Duration,
    tls_certificate_policy: TlsCertificatePolicy,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TargetScheme {
    Plain,
    Tls,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum TargetHost {
    Domain(String),
    Ip(IpAddr),
}

#[cfg(test)]
impl ConnectDirectWebSocketRequest {
    fn validate(&self) -> Result<ValidatedTarget, CommandError> {
        ValidatedTarget::parse(
            &self.url,
            self.insecure_transport_confirmed,
            self.connect_timeout_ms,
            &self.non_sensitive_headers,
        )
    }
}

impl ValidatedTarget {
    #[cfg(test)]
    pub(super) fn parse(
        url: &str,
        insecure_transport_confirmed: bool,
        connect_timeout_ms: u64,
        non_sensitive_headers: &BTreeMap<String, String>,
    ) -> Result<Self, CommandError> {
        Self::parse_with_tls_policy(
            url,
            insecure_transport_confirmed,
            connect_timeout_ms,
            non_sensitive_headers,
            TlsCertificatePolicy::Strict,
        )
    }

    pub(super) fn parse_with_tls_policy(
        url: &str,
        insecure_transport_confirmed: bool,
        connect_timeout_ms: u64,
        non_sensitive_headers: &BTreeMap<String, String>,
        tls_certificate_policy: TlsCertificatePolicy,
    ) -> Result<Self, CommandError> {
        if url.is_empty() || url.len() > MAX_URL_BYTES {
            return Err(CommandError::invalid_url());
        }
        if !(MIN_CONNECT_TIMEOUT_MS..=MAX_CONNECT_TIMEOUT_MS).contains(&connect_timeout_ms) {
            return Err(CommandError::invalid_connect_timeout());
        }

        let parsed_url = Url::parse(url).map_err(|_| CommandError::invalid_url())?;
        let scheme = match parsed_url.scheme() {
            "ws" => {
                if !insecure_transport_confirmed {
                    return Err(CommandError::insecure_transport_not_confirmed());
                }
                if tls_certificate_policy != TlsCertificatePolicy::Strict {
                    return Err(CommandError::invalid_tls_certificate_policy());
                }
                TargetScheme::Plain
            }
            "wss" => TargetScheme::Tls,
            _ => return Err(CommandError::invalid_url()),
        };
        if parsed_url.cannot_be_a_base()
            || !parsed_url.username().is_empty()
            || parsed_url.password().is_some()
            || parsed_url.fragment().is_some()
            || parsed_url
                .query_pairs()
                .any(|(name, _)| looks_sensitive_identifier(&name))
        {
            return Err(CommandError::invalid_url());
        }

        let host = match parsed_url.host() {
            Some(Host::Domain(domain)) if !domain.is_empty() => {
                TargetHost::Domain(domain.to_owned())
            }
            Some(Host::Ipv4(address)) => TargetHost::Ip(IpAddr::V4(address)),
            Some(Host::Ipv6(address)) => TargetHost::Ip(IpAddr::V6(address)),
            _ => return Err(CommandError::invalid_url()),
        };
        let default_port = match scheme {
            TargetScheme::Plain => 80,
            TargetScheme::Tls => 443,
        };
        let port = parsed_url.port().unwrap_or(default_port);
        if port == 0 {
            return Err(CommandError::invalid_url());
        }

        let mut request = parsed_url
            .as_str()
            .into_client_request()
            .map_err(|_| CommandError::invalid_url())?;
        add_non_sensitive_headers(&mut request, non_sensitive_headers)?;

        Ok(ValidatedTarget {
            scheme,
            host,
            port,
            request,
            connect_timeout: Duration::from_millis(connect_timeout_ms),
            tls_certificate_policy,
        })
    }

    pub(super) fn set_bearer_token(&mut self, token: &SecretText) -> Result<(), CommandError> {
        if !is_valid_bearer_token(token.as_str()) {
            return Err(CommandError::invalid_authentication());
        }
        let mut encoded = zeroize::Zeroizing::new(Vec::with_capacity(7 + token.as_bytes().len()));
        encoded.extend_from_slice(b"Bearer ");
        encoded.extend_from_slice(token.as_bytes());
        let mut value = HeaderValue::from_bytes(&encoded)
            .map_err(|_| CommandError::invalid_authentication())?;
        value.set_sensitive(true);
        self.request.headers_mut().insert(AUTHORIZATION, value);
        Ok(())
    }

    pub(super) fn authority(&self) -> String {
        match &self.host {
            TargetHost::Domain(domain) => format!("{domain}:{}", self.port),
            TargetHost::Ip(IpAddr::V4(address)) => format!("{address}:{}", self.port),
            TargetHost::Ip(IpAddr::V6(address)) => format!("[{address}]:{}", self.port),
        }
    }
}

fn add_non_sensitive_headers(
    request: &mut WebSocketRequest,
    headers: &BTreeMap<String, String>,
) -> Result<(), CommandError> {
    if headers.len() > MAX_HEADER_COUNT {
        return Err(CommandError::invalid_headers());
    }

    let mut normalized_names = BTreeSet::new();
    for (name, value) in headers {
        if name.is_empty()
            || name.len() > MAX_HEADER_NAME_BYTES
            || value.len() > MAX_HEADER_VALUE_BYTES
            || looks_sensitive_identifier(name)
            || is_reserved_websocket_header(name)
        {
            return Err(CommandError::invalid_headers());
        }

        let header_name =
            HeaderName::from_bytes(name.as_bytes()).map_err(|_| CommandError::invalid_headers())?;
        let normalized_name = header_name.as_str().to_owned();
        if !normalized_names.insert(normalized_name) {
            return Err(CommandError::invalid_headers());
        }
        let header_value =
            HeaderValue::from_str(value).map_err(|_| CommandError::invalid_headers())?;
        request.headers_mut().append(header_name, header_value);
    }

    Ok(())
}

fn validate_outbound_json(json: &str) -> Result<(), CommandError> {
    if json.len() > MAX_PROTOCOL_MESSAGE_BYTES {
        return Err(CommandError::invalid_message());
    }
    serde_json::from_str::<Value>(json)
        .map(|_| ())
        .map_err(|_| CommandError::invalid_message())
}

enum OutboundCommand {
    Text {
        json: String,
        completion: oneshot::Sender<Result<(), ()>>,
    },
}

struct ConnectionEntry {
    owner_window_label: String,
    generation: u64,
    outbound: Option<mpsc::Sender<OutboundCommand>>,
    cancellation: CancellationToken,
    task: Option<JoinHandle<()>>,
}

impl Drop for ConnectionEntry {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}

#[derive(Default)]
struct RemoteWebSocketManagerState {
    connections: HashMap<ConnectionId, ConnectionEntry>,
    shutting_down: bool,
}

#[derive(Default)]
struct RemoteWebSocketManagerInner {
    state: Mutex<RemoteWebSocketManagerState>,
    next_generation: AtomicU64,
}

impl RemoteWebSocketManagerInner {
    fn state(&self) -> MutexGuard<'_, RemoteWebSocketManagerState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn remove_if_generation(
        &self,
        connection_id: &ConnectionId,
        generation: u64,
    ) -> Option<ConnectionEntry> {
        let mut state = self.state();
        let should_remove = state
            .connections
            .get(connection_id)
            .is_some_and(|entry| entry.generation == generation);
        should_remove
            .then(|| state.connections.remove(connection_id))
            .flatten()
    }

    #[cfg(test)]
    fn connection_count(&self) -> usize {
        self.state().connections.len()
    }
}

#[derive(Clone, Default)]
pub(crate) struct RemoteWebSocketConnectionManager {
    inner: Arc<RemoteWebSocketManagerInner>,
}

impl RemoteWebSocketConnectionManager {
    #[cfg(test)]
    async fn connect_direct(
        &self,
        owner_window_label: String,
        request: ConnectDirectWebSocketRequest,
        event_sink: Arc<dyn EventSink>,
    ) -> Result<ConnectRemoteWebSocketResponse, CommandError> {
        let target = request.validate()?;
        let connection_id = ConnectionId::parse(request.connection_id)
            .map_err(|_| CommandError::invalid_connection_id())?;
        let connector = async move {
            match timeout(target.connect_timeout, open_direct_websocket(target)).await {
                Ok(Ok(websocket)) => Ok(websocket),
                Ok(Err(error)) => Err(connect_error(error)),
                Err(_) => Err(CommandError::connect_timed_out()),
            }
        };
        self.connect_prepared(
            owner_window_label,
            connection_id,
            "direct",
            event_sink,
            None,
            connector,
        )
        .await
    }

    pub(super) async fn connect_prepared<F>(
        &self,
        owner_window_label: String,
        connection_id: ConnectionId,
        connection_path: &'static str,
        event_sink: Arc<dyn EventSink>,
        external_lifecycle: Option<&ConnectionLifecycle>,
        connector: F,
    ) -> Result<ConnectRemoteWebSocketResponse, CommandError>
    where
        F: Future<Output = Result<RemoteWebSocket, CommandError>>,
    {
        let generation = self.inner.next_generation.fetch_add(1, Ordering::Relaxed);
        let cancellation = external_lifecycle
            .map(ConnectionLifecycle::child_token)
            .unwrap_or_default();
        external_lifecycle
            .map(ConnectionLifecycle::begin_start)
            .transpose()
            .map_err(|_| CommandError::connect_cancelled())?;

        {
            let mut state = self.inner.state();
            if state.shutting_down {
                return Err(CommandError::manager_shutting_down());
            }
            if state.connections.contains_key(&connection_id) {
                return Err(CommandError::already_connected());
            }
            state.connections.insert(
                connection_id.clone(),
                ConnectionEntry {
                    owner_window_label: owner_window_label.clone(),
                    generation,
                    outbound: None,
                    cancellation: cancellation.clone(),
                    task: None,
                },
            );
        }
        let connect_result = tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(CommandError::connect_cancelled()),
            result = connector => result,
        };
        let mut websocket = match connect_result {
            Ok(websocket) => websocket,
            Err(error) => {
                self.inner.remove_if_generation(&connection_id, generation);
                return Err(error);
            }
        };

        if event_sink
            .emit(ConnectionEvent::connected(&connection_id))
            .is_err()
        {
            let _ = timeout(GRACEFUL_CLOSE_TIMEOUT, async {
                let _ = websocket.close(None).await;
                let _ = websocket.get_mut().shutdown().await;
            })
            .await;
            self.inner.remove_if_generation(&connection_id, generation);
            return Err(CommandError::event_delivery_failed());
        }

        let (outbound_sender, outbound_receiver) = mpsc::channel(OUTBOUND_QUEUE_CAPACITY);
        let (start_sender, start_receiver) = oneshot::channel();
        let supervisor = SupervisedWebSocket {
            manager: Arc::downgrade(&self.inner),
            connection_id: connection_id.clone(),
            generation,
            websocket,
            outbound_receiver,
            cancellation: cancellation.clone(),
            event_sink,
        };
        let mut task = Some(tokio::spawn(async move {
            if start_receiver.await.is_ok() {
                supervisor.run().await;
            }
        }));

        let activated = {
            let mut state = self.inner.state();
            match state.connections.get_mut(&connection_id) {
                Some(entry)
                    if entry.generation == generation && !entry.cancellation.is_cancelled() =>
                {
                    entry.outbound = Some(outbound_sender);
                    entry.task = task.take();
                    true
                }
                _ => false,
            }
        };
        if !activated {
            cancellation.cancel();
            drop(start_sender);
            if let Some(task) = task {
                let _ = task.await;
            }
            self.inner.remove_if_generation(&connection_id, generation);
            return Err(CommandError::connect_cancelled());
        }
        if start_sender.send(()).is_err() {
            self.inner.remove_if_generation(&connection_id, generation);
            return Err(CommandError::connect_failed());
        }

        tracing::info!(
            connection_id = connection_id.as_str(),
            owner_window_label,
            connection_path,
            "remote WebSocket connection established"
        );

        Ok(ConnectRemoteWebSocketResponse {
            connection_id: connection_id.into_string(),
        })
    }

    pub(super) async fn send(
        &self,
        owner_window_label: &str,
        request: SendRemoteWebSocketMessageRequest,
    ) -> Result<(), CommandError> {
        let connection_id = ConnectionId::parse(request.connection_id)
            .map_err(|_| CommandError::invalid_connection_id())?;
        validate_outbound_json(&request.json)?;
        let message_bytes = request.json.len();

        let (outbound, cancellation) = {
            let state = self.inner.state();
            let entry = state
                .connections
                .get(&connection_id)
                .ok_or_else(CommandError::not_connected)?;
            if entry.owner_window_label != owner_window_label {
                return Err(CommandError::not_owned());
            }
            let outbound = entry
                .outbound
                .clone()
                .ok_or_else(CommandError::not_connected)?;
            (outbound, entry.cancellation.clone())
        };

        let (completion_sender, completion_receiver) = oneshot::channel();
        let command = OutboundCommand::Text {
            json: request.json,
            completion: completion_sender,
        };
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(CommandError::not_connected()),
            result = outbound.send(command) => {
                if result.is_err() {
                    return Err(CommandError::not_connected());
                }
            }
        }

        let completion = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(CommandError::not_connected()),
            result = completion_receiver => result,
        };
        if !matches!(completion, Ok(Ok(()))) {
            cancellation.cancel();
            return Err(CommandError::write_failed());
        }

        tracing::debug!(
            connection_id = connection_id.as_str(),
            message_bytes,
            "remote WebSocket protocol message sent"
        );
        Ok(())
    }

    fn disconnect(
        &self,
        owner_window_label: &str,
        request: DisconnectRemoteWebSocketRequest,
    ) -> Result<(), CommandError> {
        let connection_id = ConnectionId::parse(request.connection_id)
            .map_err(|_| CommandError::invalid_connection_id())?;
        let cancellation = {
            let state = self.inner.state();
            let entry = state
                .connections
                .get(&connection_id)
                .ok_or_else(CommandError::not_connected)?;
            if entry.owner_window_label != owner_window_label {
                return Err(CommandError::not_owned());
            }
            entry.cancellation.clone()
        };

        cancellation.cancel();
        tracing::info!(
            connection_id = connection_id.as_str(),
            owner_window_label,
            "remote WebSocket disconnect requested"
        );
        Ok(())
    }

    pub(crate) fn disconnect_window(&self, owner_window_label: &str) {
        let cancellations = {
            let state = self.inner.state();
            state
                .connections
                .values()
                .filter(|entry| entry.owner_window_label == owner_window_label)
                .map(|entry| entry.cancellation.clone())
                .collect::<Vec<_>>()
        };

        let connection_count = cancellations.len();
        for cancellation in cancellations {
            cancellation.cancel();
        }
        if connection_count > 0 {
            tracing::info!(
                owner_window_label,
                connection_count,
                "requested closure of remote WebSocket connections owned by destroyed window"
            );
        }
    }

    pub(crate) async fn shutdown_all(&self) {
        let mut tasks = {
            let mut state = self.inner.state();
            state.shutting_down = true;
            state
                .connections
                .values_mut()
                .filter_map(|entry| {
                    entry.cancellation.cancel();
                    entry.task.take()
                })
                .collect::<Vec<_>>()
        };

        let connection_count = tasks.len();
        let deadline = Instant::now() + MANAGER_SHUTDOWN_TIMEOUT;
        let mut timed_out = false;
        while let Some(mut task) = tasks.pop() {
            if timeout_at(deadline, &mut task).await.is_err() {
                timed_out = true;
                task.abort();
                for pending_task in &tasks {
                    pending_task.abort();
                }
                let _ = timeout(GRACEFUL_CLOSE_TIMEOUT, task).await;
                for pending_task in tasks {
                    let _ = timeout(GRACEFUL_CLOSE_TIMEOUT, pending_task).await;
                }
                break;
            }
        }

        let remaining_connections = {
            let mut state = self.inner.state();
            let remaining_connections = state.connections.len();
            state.connections.clear();
            remaining_connections
        };
        tracing::info!(
            connection_count,
            remaining_connections,
            timed_out,
            "remote WebSocket connection manager shut down"
        );
    }
}

struct SupervisedWebSocket {
    manager: Weak<RemoteWebSocketManagerInner>,
    connection_id: ConnectionId,
    generation: u64,
    websocket: RemoteWebSocket,
    outbound_receiver: mpsc::Receiver<OutboundCommand>,
    cancellation: CancellationToken,
    event_sink: Arc<dyn EventSink>,
}

struct ConnectionTermination {
    reason: TerminationReason,
    close_code: Option<u16>,
}

impl SupervisedWebSocket {
    async fn run(mut self) {
        let termination = self.run_until_terminated().await;
        let forced = self.finish(&termination).await;

        if let Some(manager) = self.manager.upgrade() {
            manager.remove_if_generation(&self.connection_id, self.generation);
        }
        if self
            .event_sink
            .emit(ConnectionEvent::terminated(
                &self.connection_id,
                termination.reason,
                termination.close_code,
                forced,
            ))
            .is_err()
        {
            tracing::warn!(
                connection_id = self.connection_id.as_str(),
                "failed to deliver remote WebSocket terminal event"
            );
        }
    }

    async fn run_until_terminated(&mut self) -> ConnectionTermination {
        loop {
            tokio::select! {
                biased;
                _ = self.cancellation.cancelled() => {
                    return ConnectionTermination {
                        reason: TerminationReason::Requested,
                        close_code: None,
                    };
                }
                command = self.outbound_receiver.recv() => {
                    let Some(command) = command else {
                        return ConnectionTermination {
                            reason: TerminationReason::Requested,
                            close_code: None,
                        };
                    };
                    let OutboundCommand::Text { json, completion } = command;
                    let send_result = tokio::select! {
                        biased;
                        _ = self.cancellation.cancelled() => Err(None),
                        result = self.websocket.send(Message::Text(json.into())) => {
                            result.map_err(Some)
                        }
                    };
                    match send_result {
                        Ok(()) => {
                            let _ = completion.send(Ok(()));
                        }
                        Err(error) => {
                            let _ = completion.send(Err(()));
                            return ConnectionTermination {
                                reason: if self.cancellation.is_cancelled() {
                                    TerminationReason::Requested
                                } else {
                                    error
                                        .as_ref()
                                        .and_then(|error| match error {
                                            WebSocketError::Io(error) => {
                                                remote_transport_termination(error)
                                            }
                                            _ => None,
                                        })
                                        .unwrap_or(TerminationReason::WriteFailed)
                                },
                                close_code: None,
                            };
                        }
                    }
                }
                incoming = self.websocket.next() => {
                    match incoming {
                        Some(Ok(Message::Text(text))) => {
                            let json = text.as_str();
                            if serde_json::from_str::<Value>(json).is_err() {
                                return ConnectionTermination {
                                    reason: TerminationReason::InvalidJson,
                                    close_code: None,
                                };
                            }
                            if self.event_sink.emit(ConnectionEvent::protocol_message(
                                &self.connection_id,
                                json.to_owned(),
                            )).is_err() {
                                return ConnectionTermination {
                                    reason: TerminationReason::EventDeliveryFailed,
                                    close_code: None,
                                };
                            }
                        }
                        Some(Ok(Message::Binary(_))) => {
                            return ConnectionTermination {
                                reason: TerminationReason::BinaryMessage,
                                close_code: None,
                            };
                        }
                        Some(Ok(Message::Close(frame))) => {
                            return ConnectionTermination {
                                reason: TerminationReason::RemoteClosed,
                                close_code: frame.map(|frame| frame.code.into()),
                            };
                        }
                        Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                        Some(Ok(Message::Frame(_))) => {
                            return ConnectionTermination {
                                reason: TerminationReason::UnsupportedMessage,
                                close_code: None,
                            };
                        }
                        Some(Err(WebSocketError::ConnectionClosed | WebSocketError::AlreadyClosed))
                        | None => {
                            return ConnectionTermination {
                                reason: TerminationReason::RemoteClosed,
                                close_code: None,
                            };
                        }
                        Some(Err(WebSocketError::Capacity(
                            CapacityError::MessageTooLong { .. },
                        ))) => {
                            return ConnectionTermination {
                                reason: TerminationReason::MessageTooLarge,
                                close_code: None,
                            };
                        }
                        Some(Err(WebSocketError::Io(error))) => {
                            return ConnectionTermination {
                                reason: remote_transport_termination(&error)
                                    .unwrap_or(TerminationReason::ReadFailed),
                                close_code: None,
                            };
                        }
                        Some(Err(_)) => {
                            return ConnectionTermination {
                                reason: TerminationReason::ReadFailed,
                                close_code: None,
                            };
                        }
                    }
                }
            }
        }
    }

    async fn finish(&mut self, termination: &ConnectionTermination) -> bool {
        let result = timeout(GRACEFUL_CLOSE_TIMEOUT, async {
            let close_result = match termination.reason {
                TerminationReason::Requested => self.websocket.close(None).await,
                TerminationReason::RemoteClosed => self.websocket.flush().await,
                _ => return false,
            };
            close_result.is_ok() && self.websocket.get_mut().shutdown().await.is_ok()
        })
        .await;
        !matches!(result, Ok(true))
    }
}

#[cfg(test)]
pub(super) async fn open_direct_websocket(
    target: ValidatedTarget,
) -> Result<RemoteWebSocket, ConnectFailure> {
    open_direct_websocket_with_progress(target, Arc::new(|_| {})).await
}

pub(super) async fn open_direct_websocket_with_progress(
    target: ValidatedTarget,
    progress: ConnectionProgressCallback,
) -> Result<RemoteWebSocket, ConnectFailure> {
    progress(RemoteConnectionStage::ResolvingTarget);
    let tcp_stream = connect_tcp(&target.host, target.port)
        .await
        .map_err(|_| ConnectFailure::Network)?;
    tcp_stream
        .set_nodelay(true)
        .map_err(|_| ConnectFailure::Network)?;
    open_target_websocket_with_progress(target, Box::new(tcp_stream), &progress).await
}

#[cfg(test)]
pub(super) async fn open_target_websocket(
    target: ValidatedTarget,
    transport: BoxedRemoteTransport,
) -> Result<RemoteWebSocket, ConnectFailure> {
    let progress: ConnectionProgressCallback = Arc::new(|_| {});
    open_target_websocket_with_progress(target, transport, &progress).await
}

pub(super) async fn open_target_websocket_with_progress(
    target: ValidatedTarget,
    transport: BoxedRemoteTransport,
    progress: &ConnectionProgressCallback,
) -> Result<RemoteWebSocket, ConnectFailure> {
    let transport = match target.scheme {
        TargetScheme::Plain => transport,
        TargetScheme::Tls => {
            progress(RemoteConnectionStage::TargetTls);
            let config = tls_config_for_policy(target.tls_certificate_policy)
                .map_err(|_| ConnectFailure::TlsConfiguration)?;
            connect_tls(transport, &target.host, config)
                .await
                .map_err(|_| ConnectFailure::TargetTls)?
        }
    };
    progress(RemoteConnectionStage::WebSocketHandshake);
    open_websocket_handshake(target, transport).await
}

#[cfg(test)]
pub(super) async fn open_target_websocket_with_config(
    target: ValidatedTarget,
    transport: BoxedRemoteTransport,
    config: Arc<ClientConfig>,
) -> Result<RemoteWebSocket, ConnectFailure> {
    let transport = match target.scheme {
        TargetScheme::Plain => transport,
        TargetScheme::Tls => connect_tls(transport, &target.host, config)
            .await
            .map_err(|_| ConnectFailure::TargetTls)?,
    };
    open_websocket_handshake(target, transport).await
}

async fn open_websocket_handshake(
    target: ValidatedTarget,
    transport: BoxedRemoteTransport,
) -> Result<RemoteWebSocket, ConnectFailure> {
    let websocket_config = WebSocketConfig::default()
        .max_message_size(Some(MAX_PROTOCOL_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_PROTOCOL_MESSAGE_BYTES))
        .max_write_buffer_size(MAX_PROTOCOL_MESSAGE_BYTES + 256 * 1024);
    client_async_with_config(target.request, transport, Some(websocket_config))
        .await
        .map(|(websocket, _)| websocket)
        .map_err(ConnectFailure::WebSocket)
}

pub(super) async fn connect_tcp(host: &TargetHost, port: u16) -> io::Result<TcpStream> {
    match host {
        TargetHost::Ip(address) => TcpStream::connect(SocketAddr::new(*address, port)).await,
        TargetHost::Domain(domain) => {
            let addresses = lookup_host((domain.as_str(), port)).await?;
            let mut last_error = None;
            for address in addresses.take(MAX_RESOLVED_ADDRESSES) {
                match TcpStream::connect(address).await {
                    Ok(stream) => return Ok(stream),
                    Err(error) => last_error = Some(error),
                }
            }
            Err(last_error.unwrap_or_else(|| {
                io::Error::new(io::ErrorKind::NotFound, "target resolved to no addresses")
            }))
        }
    }
}

pub(super) async fn connect_tls(
    transport: BoxedRemoteTransport,
    host: &TargetHost,
    config: Arc<ClientConfig>,
) -> Result<BoxedRemoteTransport, TlsConnectFailure> {
    let server_name = match host {
        TargetHost::Domain(domain) => ServerName::try_from(domain.clone()),
        TargetHost::Ip(address) => Ok(ServerName::from(*address)),
    }
    .map_err(|_| TlsConnectFailure)?;
    let stream = TlsConnector::from(config)
        .connect(server_name, transport)
        .await
        .map_err(|_| TlsConnectFailure)?;
    Ok(Box::new(stream))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct TlsConnectFailure;

pub(super) enum ConnectFailure {
    Network,
    TlsConfiguration,
    TargetTls,
    WebSocket(WebSocketError),
}

pub(super) fn connect_error(error: ConnectFailure) -> CommandError {
    match error {
        ConnectFailure::Network => CommandError::network_connect_failed(),
        ConnectFailure::TlsConfiguration => CommandError::tls_configuration_failed(),
        ConnectFailure::TargetTls => CommandError::target_tls_failed(),
        ConnectFailure::WebSocket(WebSocketError::Http(response)) => {
            tracing::warn!(
                status = response.status().as_u16(),
                "remote WebSocket handshake rejected"
            );
            CommandError::handshake_rejected()
        }
        ConnectFailure::WebSocket(error) => {
            log_websocket_connect_error(&error);
            CommandError::connect_failed()
        }
    }
}

fn log_websocket_connect_error(error: &WebSocketError) {
    let category = match error {
        WebSocketError::Io(error) => match error.kind() {
            io::ErrorKind::InvalidData => "invalidData",
            io::ErrorKind::PermissionDenied => "permissionDenied",
            io::ErrorKind::ConnectionRefused => "connectionRefused",
            io::ErrorKind::ConnectionReset => "connectionReset",
            io::ErrorKind::ConnectionAborted => "connectionAborted",
            io::ErrorKind::TimedOut => "timedOut",
            _ => "io",
        },
        WebSocketError::Tls(_) => "tls",
        WebSocketError::Capacity(_) => "capacity",
        WebSocketError::Protocol(_) => "protocol",
        WebSocketError::Url(_) => "url",
        WebSocketError::HttpFormat(_) => "httpFormat",
        WebSocketError::AttackAttempt => "attackAttempt",
        WebSocketError::Utf8(_) => "utf8",
        WebSocketError::WriteBufferFull(_) => "writeBufferFull",
        WebSocketError::ConnectionClosed | WebSocketError::AlreadyClosed => "closed",
        WebSocketError::Http(_) => "http",
    };
    tracing::warn!(
        error_category = category,
        "remote WebSocket connection failed"
    );
}

#[derive(Clone, Copy)]
pub(super) struct TlsConfigurationError;

static TLS_CONFIG: OnceLock<Result<Arc<ClientConfig>, TlsConfigurationError>> = OnceLock::new();
static ALLOW_INVALID_TLS_CONFIG: OnceLock<Result<Arc<ClientConfig>, TlsConfigurationError>> =
    OnceLock::new();

pub(super) fn tls_config() -> Result<Arc<ClientConfig>, TlsConfigurationError> {
    TLS_CONFIG.get_or_init(build_tls_config).clone()
}

pub(super) fn tls_config_for_policy(
    policy: TlsCertificatePolicy,
) -> Result<Arc<ClientConfig>, TlsConfigurationError> {
    match policy {
        TlsCertificatePolicy::Strict => tls_config(),
        TlsCertificatePolicy::AllowInvalidCertificate => ALLOW_INVALID_TLS_CONFIG
            .get_or_init(build_allow_invalid_tls_config)
            .clone(),
    }
}

fn build_tls_config() -> Result<Arc<ClientConfig>, TlsConfigurationError> {
    let certificate_result = rustls_native_certs::load_native_certs();
    let error_count = certificate_result.errors.len();
    let mut roots = RootCertStore::empty();
    let (added, ignored) = roots.add_parsable_certificates(certificate_result.certs);
    if added == 0 {
        tracing::warn!(
            error_count,
            ignored,
            "no usable native TLS roots were found"
        );
        return Err(TlsConfigurationError);
    }
    if error_count > 0 || ignored > 0 {
        tracing::warn!(
            error_count,
            ignored,
            "some native TLS roots could not be loaded"
        );
    }

    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|_| TlsConfigurationError)?;
    Ok(Arc::new(
        builder.with_root_certificates(roots).with_no_client_auth(),
    ))
}

#[derive(Debug)]
struct AllowInvalidCertificateVerifier(Arc<rustls::crypto::CryptoProvider>);

impl ServerCertVerifier for AllowInvalidCertificateVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        certificate: &CertificateDer<'_>,
        signed: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            certificate,
            signed,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        certificate: &CertificateDer<'_>,
        signed: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            certificate,
            signed,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

fn build_allow_invalid_tls_config() -> Result<Arc<ClientConfig>, TlsConfigurationError> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = Arc::new(AllowInvalidCertificateVerifier(Arc::clone(&provider)));
    let builder = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|_| TlsConfigurationError)?;
    Ok(Arc::new(
        builder
            .dangerous()
            .with_custom_certificate_verifier(verifier)
            .with_no_client_auth(),
    ))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandError {
    pub(super) code: &'static str,
    pub(super) message: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) status_code: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) details: Option<Box<CommandErrorDetails>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(super) enum CommandErrorDetails {
    SshHostKeyUnknown {
        host: String,
        port: u16,
        received: SshHostKeyIdentity,
    },
    SshHostKeyChanged {
        host: String,
        port: u16,
        expected: SshHostKeyIdentity,
        received: SshHostKeyIdentity,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SshHostKeyIdentity {
    pub(super) algorithm: String,
    pub(super) sha256_fingerprint: String,
}

impl CommandError {
    pub(super) const fn new(code: &'static str, message: &'static str) -> Self {
        Self {
            code,
            message,
            status_code: None,
            details: None,
        }
    }

    pub(super) const fn with_status_code(
        code: &'static str,
        message: &'static str,
        status_code: u16,
    ) -> Self {
        Self {
            code,
            message,
            status_code: Some(status_code),
            details: None,
        }
    }

    pub(super) fn with_details(mut self, details: CommandErrorDetails) -> Self {
        self.details = Some(Box::new(details));
        self
    }

    pub(super) const fn invalid_connection_id() -> Self {
        Self::new("invalidConnectionId", "The connection ID is invalid")
    }

    pub(super) const fn invalid_url() -> Self {
        Self::new("invalidWebSocketUrl", "The WebSocket URL is invalid")
    }

    pub(super) const fn insecure_transport_not_confirmed() -> Self {
        Self::new(
            "insecureTransportNotConfirmed",
            "Plaintext WebSocket transport requires explicit confirmation",
        )
    }

    pub(super) const fn invalid_tls_certificate_policy() -> Self {
        Self::new(
            "invalidTlsCertificatePolicy",
            "The TLS certificate policy is invalid for the target",
        )
    }

    pub(super) const fn invalid_authentication() -> Self {
        Self::new(
            "invalidRemoteAuthentication",
            "The remote server authentication configuration is invalid",
        )
    }

    pub(super) const fn invalid_connect_timeout() -> Self {
        Self::new("invalidConnectTimeout", "The connection timeout is invalid")
    }

    pub(super) const fn invalid_headers() -> Self {
        Self::new(
            "invalidNonSensitiveHeaders",
            "The non-sensitive WebSocket headers are invalid",
        )
    }

    pub(super) const fn invalid_message() -> Self {
        Self::new(
            "invalidProtocolMessage",
            "The outbound protocol message is invalid",
        )
    }

    pub(super) const fn manager_shutting_down() -> Self {
        Self::new(
            "connectionManagerShuttingDown",
            "The connection manager is shutting down",
        )
    }

    pub(super) const fn already_connected() -> Self {
        Self::new(
            "connectionAlreadyExists",
            "The connection ID is already in use",
        )
    }

    pub(super) const fn not_connected() -> Self {
        Self::new("connectionNotFound", "The connection is not active")
    }

    pub(super) const fn not_owned() -> Self {
        Self::new(
            "connectionNotOwned",
            "The connection belongs to another application window",
        )
    }

    pub(super) const fn connect_cancelled() -> Self {
        Self::new(
            "connectionCancelled",
            "The connection attempt was cancelled",
        )
    }

    pub(super) const fn connect_timed_out() -> Self {
        Self::new("connectionTimedOut", "The WebSocket connection timed out")
    }

    pub(super) const fn network_connect_failed() -> Self {
        Self::new(
            "networkConnectFailed",
            "The target network connection could not be established",
        )
    }

    pub(super) const fn tls_configuration_failed() -> Self {
        Self::new(
            "tlsConfigurationFailed",
            "The system TLS trust store is unavailable",
        )
    }

    pub(super) const fn target_tls_failed() -> Self {
        Self::new(
            "targetTlsFailed",
            "The target TLS certificate or handshake could not be validated",
        )
    }

    pub(super) const fn handshake_rejected() -> Self {
        Self::new(
            "webSocketHandshakeRejected",
            "The target rejected the WebSocket handshake",
        )
    }

    pub(super) const fn connect_failed() -> Self {
        Self::new(
            "webSocketConnectFailed",
            "The WebSocket connection could not be established",
        )
    }

    pub(super) const fn event_delivery_failed() -> Self {
        Self::new(
            "eventDeliveryFailed",
            "The connection owner cannot receive connection events",
        )
    }

    pub(super) const fn write_failed() -> Self {
        Self::new(
            "protocolWriteFailed",
            "The protocol message could not be written to the WebSocket",
        )
    }
}

impl fmt::Display for CommandError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for CommandError {}

#[tauri::command]
pub(crate) async fn send_remote_websocket_message<R: Runtime>(
    window: WebviewWindow<R>,
    manager: State<'_, RemoteWebSocketConnectionManager>,
    request: SendRemoteWebSocketMessageRequest,
) -> Result<(), CommandError> {
    manager.send(window.label(), request).await
}

#[tauri::command]
pub(crate) fn disconnect_remote_websocket<R: Runtime>(
    window: WebviewWindow<R>,
    manager: State<'_, RemoteWebSocketConnectionManager>,
    request: DisconnectRemoteWebSocketRequest,
) -> Result<(), CommandError> {
    manager.disconnect(window.label(), request)
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeMap,
        future::pending,
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
        time::Duration,
    };

    use super::{
        CommandError, ConnectDirectWebSocketRequest, ConnectionEvent, ConnectionId,
        ConnectionLifecycle, ConnectionStatus, DisconnectRemoteWebSocketRequest, EventSink,
        RemoteWebSocket, RemoteWebSocketConnectionManager, SendRemoteWebSocketMessageRequest,
        TerminationReason, ValidatedTarget, validate_outbound_json,
    };
    use crate::configuration::{SecretText, TlsCertificatePolicy};
    use futures_util::{SinkExt, StreamExt};
    use serde_json::json;
    use tokio::{
        net::TcpListener,
        sync::{mpsc, oneshot},
        time::{sleep, timeout},
    };
    use tokio_tungstenite::{
        accept_hdr_async,
        tungstenite::{Message, handshake::server::Response},
    };

    struct TestEventSink {
        sender: mpsc::UnboundedSender<ConnectionEvent>,
    }

    impl EventSink for TestEventSink {
        fn emit(&self, event: ConnectionEvent) -> Result<(), ()> {
            self.sender.send(event).map_err(|_| ())
        }
    }

    fn test_sink() -> (Arc<dyn EventSink>, mpsc::UnboundedReceiver<ConnectionEvent>) {
        let (sender, receiver) = mpsc::unbounded_channel();
        (Arc::new(TestEventSink { sender }), receiver)
    }

    fn request(connection_id: &str, url: String) -> ConnectDirectWebSocketRequest {
        ConnectDirectWebSocketRequest {
            connection_id: connection_id.to_owned(),
            url,
            insecure_transport_confirmed: true,
            connect_timeout_ms: 5_000,
            non_sensitive_headers: BTreeMap::new(),
        }
    }

    async fn receive_event(
        receiver: &mut mpsc::UnboundedReceiver<ConnectionEvent>,
    ) -> ConnectionEvent {
        timeout(Duration::from_secs(5), receiver.recv())
            .await
            .expect("fixture event timed out")
            .expect("fixture event channel closed")
    }

    async fn wait_for_connection_count(
        manager: &RemoteWebSocketConnectionManager,
        expected: usize,
    ) {
        timeout(Duration::from_secs(5), async {
            loop {
                if manager.inner.connection_count() == expected {
                    return;
                }
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("connection count did not settle");
    }

    #[tokio::test]
    async fn external_cancellation_prevents_remote_connector_start() {
        let manager = RemoteWebSocketConnectionManager::default();
        let connection_id = ConnectionId::parse("cancelled-remote".to_owned()).unwrap();
        let (event_sink, mut events) = test_sink();
        let lifecycle = ConnectionLifecycle::default();
        lifecycle.cancel();
        let connector_polled = Arc::new(AtomicBool::new(false));
        let connector_flag = Arc::clone(&connector_polled);
        let connector = async move {
            connector_flag.store(true, Ordering::SeqCst);
            Err(CommandError::connect_failed())
        };

        let error = manager
            .connect_prepared(
                "closed-window".to_owned(),
                connection_id,
                "direct",
                event_sink,
                Some(&lifecycle),
                connector,
            )
            .await
            .unwrap_err();

        assert_eq!(error.code, "connectionCancelled");
        assert!(!connector_polled.load(Ordering::SeqCst));
        assert_eq!(manager.inner.connection_count(), 0);
        assert!(events.try_recv().is_err());
    }

    #[tokio::test]
    async fn window_cancellation_stops_an_active_remote_connector() {
        let manager = RemoteWebSocketConnectionManager::default();
        let lifecycle = Arc::new(ConnectionLifecycle::default());
        let task_lifecycle = Arc::clone(&lifecycle);
        let task_manager = manager.clone();
        let connection_id = ConnectionId::parse("pending-remote".to_owned()).unwrap();
        let (event_sink, mut events) = test_sink();
        let (started_sender, started_receiver) = oneshot::channel();
        let connector = async move {
            let _ = started_sender.send(());
            pending::<Result<RemoteWebSocket, CommandError>>().await
        };
        let connect_task = tokio::spawn(async move {
            task_manager
                .connect_prepared(
                    "closing-window".to_owned(),
                    connection_id,
                    "direct",
                    event_sink,
                    Some(&task_lifecycle),
                    connector,
                )
                .await
        });
        timeout(Duration::from_secs(5), started_receiver)
            .await
            .expect("connector did not start")
            .expect("connector start signal was dropped");

        lifecycle.cancel();
        let error = timeout(Duration::from_secs(5), connect_task)
            .await
            .expect("cancelled connector did not stop")
            .unwrap()
            .unwrap_err();

        assert_eq!(error.code, "connectionCancelled");
        assert_eq!(manager.inner.connection_count(), 0);
        assert!(events.try_recv().is_err());
    }

    #[test]
    fn validates_url_scheme_plaintext_confirmation_and_sensitive_components() {
        let mut valid = request("remote", "wss://example.com/app?workspace=demo".to_owned());
        valid.insecure_transport_confirmed = false;
        let target = valid.validate().expect("wss target should be valid");
        assert_eq!(target.request.uri().host(), Some("example.com"));
        assert_eq!(target.port, 443);

        let mut plaintext = request("remote", "ws://127.0.0.1:8080/app".to_owned());
        plaintext.insecure_transport_confirmed = false;
        assert_eq!(
            plaintext.validate().unwrap_err().code,
            "insecureTransportNotConfirmed"
        );
        plaintext.insecure_transport_confirmed = true;
        assert_eq!(plaintext.validate().unwrap().port, 8080);

        for url in [
            "https://example.com/app",
            "wss://user@example.com/app",
            "wss://example.com/app#fragment",
            "wss://example.com/app?access_token=secret",
            "wss://example.com/app?accessToken=secret",
            "wss://example.com/app?apiKey=secret",
            "wss://",
        ] {
            assert_eq!(
                request("remote", url.to_owned())
                    .validate()
                    .unwrap_err()
                    .code,
                "invalidWebSocketUrl"
            );
        }
    }

    #[test]
    fn accepts_only_bounded_non_sensitive_non_reserved_headers() {
        let mut valid = request("remote", "wss://example.com/app".to_owned());
        valid
            .non_sensitive_headers
            .insert("X-Client-Mode".to_owned(), "desktop".to_owned());
        let target = valid.validate().expect("custom header should be valid");
        assert_eq!(
            target.request.headers().get("x-client-mode").unwrap(),
            "desktop"
        );

        for name in [
            "Authorization",
            "Cookie",
            "X-Api-Key",
            "X-ApiKey",
            "X-Client-Token",
            "Sec-WebSocket-Protocol",
            "Sec-WebSocket-Foo",
            "Host",
            "Proxy-Authorization",
            "Proxy-Foo",
        ] {
            let mut invalid = request("remote", "wss://example.com/app".to_owned());
            invalid
                .non_sensitive_headers
                .insert(name.to_owned(), "DO_NOT_REPORT".to_owned());
            let error = invalid.validate().unwrap_err();
            assert_eq!(error.code, "invalidNonSensitiveHeaders");
            assert!(
                !serde_json::to_string(&error)
                    .unwrap()
                    .contains("DO_NOT_REPORT")
            );
        }

        let mut duplicate = request("remote", "wss://example.com/app".to_owned());
        duplicate
            .non_sensitive_headers
            .insert("X-Mode".to_owned(), "one".to_owned());
        duplicate
            .non_sensitive_headers
            .insert("x-mode".to_owned(), "two".to_owned());
        assert_eq!(
            duplicate.validate().unwrap_err().code,
            "invalidNonSensitiveHeaders"
        );
    }

    #[test]
    fn applies_bearer_only_to_the_target_handshake_and_validates_tls_policy() {
        let headers = BTreeMap::from([("X-Client-Mode".to_owned(), "desktop".to_owned())]);
        let mut target = ValidatedTarget::parse_with_tls_policy(
            "wss://example.com/app",
            false,
            5_000,
            &headers,
            TlsCertificatePolicy::AllowInvalidCertificate,
        )
        .unwrap();
        let token = SecretText::from_string("target-token".to_owned());
        target.set_bearer_token(&token).unwrap();
        let authorization = target.request.headers().get("authorization").unwrap();
        assert_eq!(authorization, "Bearer target-token");
        assert!(authorization.is_sensitive());
        assert_eq!(
            target.request.headers().get("x-client-mode").unwrap(),
            "desktop"
        );

        let invalid = SecretText::from_string("bad token".to_owned());
        assert_eq!(
            target.set_bearer_token(&invalid).unwrap_err().code,
            "invalidRemoteAuthentication"
        );
        assert_eq!(
            ValidatedTarget::parse_with_tls_policy(
                "ws://example.com/app",
                true,
                5_000,
                &BTreeMap::new(),
                TlsCertificatePolicy::AllowInvalidCertificate,
            )
            .unwrap_err()
            .code,
            "invalidTlsCertificatePolicy"
        );
    }

    #[test]
    fn validates_outbound_json_without_exposing_contents() {
        assert!(validate_outbound_json(r#"{"id":1,"method":"initialize"}"#).is_ok());
        let error = validate_outbound_json(r#"{"token":"DO_NOT_REPORT""#).unwrap_err();
        assert_eq!(error.code, "invalidProtocolMessage");
        assert!(
            !serde_json::to_string(&error)
                .unwrap()
                .contains("DO_NOT_REPORT")
        );
    }

    #[test]
    fn serializes_channel_events_as_a_tagged_union() {
        let event = ConnectionEvent::Status {
            connection_id: "remote".to_owned(),
            status: ConnectionStatus::Disconnected,
            reason: Some(TerminationReason::RemoteClosed),
            close_code: Some(1000),
            forced: false,
        };

        assert_eq!(
            serde_json::to_value(event).unwrap(),
            json!({
                "kind": "status",
                "connectionId": "remote",
                "status": "disconnected",
                "reason": "remoteClosed",
                "closeCode": 1000,
                "forced": false
            })
        );
    }

    #[allow(clippy::result_large_err)]
    #[tokio::test]
    async fn exchanges_text_json_and_rejects_binary_protocol_messages() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut websocket = accept_hdr_async(
                stream,
                |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                 response: Response| {
                    assert_eq!(request.uri().path(), "/app");
                    assert_eq!(request.headers().get("x-client-mode").unwrap(), "desktop");
                    Ok(response)
                },
            )
            .await
            .unwrap();

            let initialize = websocket.next().await.unwrap().unwrap();
            let Message::Text(initialize) = initialize else {
                panic!("expected initialize text message");
            };
            websocket
                .send(Message::Text(r#"{"id":1,"result":{"ready":true}}"#.into()))
                .await
                .unwrap();
            let initialized = websocket.next().await.unwrap().unwrap();
            let Message::Text(initialized) = initialized else {
                panic!("expected initialized text message");
            };
            websocket
                .send(Message::Binary(vec![1, 2, 3].into()))
                .await
                .unwrap();
            (initialize.to_string(), initialized.to_string())
        });

        let manager = RemoteWebSocketConnectionManager::default();
        let (event_sink, mut events) = test_sink();
        let mut connect_request = request("remote", format!("ws://{address}/app"));
        connect_request
            .non_sensitive_headers
            .insert("X-Client-Mode".to_owned(), "desktop".to_owned());
        let response = manager
            .connect_direct("main".to_owned(), connect_request, event_sink)
            .await
            .unwrap();
        assert_eq!(response.connection_id, "remote");
        assert!(matches!(
            receive_event(&mut events).await,
            ConnectionEvent::Status {
                status: ConnectionStatus::Connected,
                ..
            }
        ));

        let not_owned = manager
            .send(
                "other",
                SendRemoteWebSocketMessageRequest {
                    connection_id: "remote".to_owned(),
                    json: r#"{"id":1,"method":"initialize"}"#.to_owned(),
                },
            )
            .await
            .unwrap_err();
        assert_eq!(not_owned.code, "connectionNotOwned");

        manager
            .send(
                "main",
                SendRemoteWebSocketMessageRequest {
                    connection_id: "remote".to_owned(),
                    json: r#"{"id":1,"method":"initialize"}"#.to_owned(),
                },
            )
            .await
            .unwrap();
        assert_eq!(
            receive_event(&mut events).await,
            ConnectionEvent::ProtocolMessage {
                connection_id: "remote".to_owned(),
                json: r#"{"id":1,"result":{"ready":true}}"#.to_owned(),
            }
        );
        manager
            .send(
                "main",
                SendRemoteWebSocketMessageRequest {
                    connection_id: "remote".to_owned(),
                    json: r#"{"method":"initialized"}"#.to_owned(),
                },
            )
            .await
            .unwrap();

        assert_eq!(
            receive_event(&mut events).await,
            ConnectionEvent::Status {
                connection_id: "remote".to_owned(),
                status: ConnectionStatus::Error,
                reason: Some(TerminationReason::BinaryMessage),
                close_code: None,
                forced: true,
            }
        );
        wait_for_connection_count(&manager, 0).await;
        assert_eq!(
            server.await.unwrap(),
            (
                r#"{"id":1,"method":"initialize"}"#.to_owned(),
                r#"{"method":"initialized"}"#.to_owned(),
            )
        );
    }

    #[tokio::test]
    async fn requested_disconnect_is_graceful_and_manager_shutdown_blocks_new_connections() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut websocket = tokio_tungstenite::accept_async(stream).await.unwrap();
            while let Some(message) = websocket.next().await {
                if matches!(message.unwrap(), Message::Close(_)) {
                    break;
                }
            }
        });

        let manager = RemoteWebSocketConnectionManager::default();
        let (event_sink, mut events) = test_sink();
        manager
            .connect_direct(
                "main".to_owned(),
                request("remote", format!("ws://{address}/")),
                event_sink,
            )
            .await
            .unwrap();
        let _ = receive_event(&mut events).await;
        manager
            .disconnect(
                "main",
                DisconnectRemoteWebSocketRequest {
                    connection_id: "remote".to_owned(),
                },
            )
            .unwrap();
        let terminal = receive_event(&mut events).await;
        assert!(matches!(
            terminal,
            ConnectionEvent::Status {
                status: ConnectionStatus::Disconnected,
                reason: Some(TerminationReason::Requested),
                ..
            }
        ));
        server.await.unwrap();
        wait_for_connection_count(&manager, 0).await;

        manager.shutdown_all().await;
        let (event_sink, _) = test_sink();
        let error = manager
            .connect_direct(
                "main".to_owned(),
                request("second", "ws://127.0.0.1:9/".to_owned()),
                event_sink,
            )
            .await
            .unwrap_err();
        assert_eq!(error, CommandError::manager_shutting_down());
    }
}
