use std::{
    borrow::Cow,
    fs::File,
    future::Future,
    io::{self, Read},
    net::IpAddr,
    path::PathBuf,
    pin::Pin,
    str::FromStr,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Duration,
};

#[cfg(test)]
use std::collections::BTreeMap;

use russh::{
    AgentAuthError, Channel, ChannelId, ChannelOpenFailure, ChannelStream, Disconnect, MethodKind,
    client,
    keys::{
        Algorithm, HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKey,
        agent::{
            AgentIdentity,
            client::{AgentClient, AgentStream},
        },
        ssh_key::Fingerprint,
    },
};
#[cfg(test)]
use serde::Deserialize;
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    task::JoinHandle,
    time::{Instant, MissedTickBehavior, interval_at, timeout},
};
use tokio_util::sync::{CancellationToken, WaitForCancellationFutureOwned};
use url::Host;
use zeroize::Zeroizing;

use crate::configuration::SecretText;

use super::remote_websocket::{
    CommandError, CommandErrorDetails, ConnectionProgressCallback, RemoteConnectionStage,
    RemoteTransportFailure, RemoteWebSocket, SshHostKeyIdentity, TargetHost, ValidatedTarget,
    connect_error, connect_tcp, open_target_websocket_with_progress, remote_transport_error,
};

#[cfg(test)]
use super::connection_id::ConnectionId;

#[cfg(test)]
const DEFAULT_SSH_PORT: u16 = 22;
const MAX_SSH_HOST_BYTES: usize = 253;
#[cfg(test)]
const MAX_SSH_USERNAME_BYTES: usize = 255;
const MAX_SSH_ALGORITHM_BYTES: usize = 128;
#[cfg(test)]
const MAX_PRIVATE_KEY_PATH_BYTES: usize = 4 * 1024;
const MAX_PRIVATE_KEY_BYTES: u64 = 1024 * 1024;
#[cfg(test)]
const MIN_SSH_CONNECT_TIMEOUT_MS: u64 = 1_000;
#[cfg(test)]
const MAX_SSH_CONNECT_TIMEOUT_MS: u64 = 120_000;
#[cfg(test)]
const MIN_KEEP_ALIVE_INTERVAL_MS: u64 = 1_000;
#[cfg(test)]
const MAX_KEEP_ALIVE_INTERVAL_MS: u64 = 300_000;
#[cfg(test)]
const MIN_KEEP_ALIVE_FAILURES: usize = 1;
#[cfg(test)]
const MAX_KEEP_ALIVE_FAILURES: usize = 10;
const ORIGINATOR_ADDRESS: &str = "127.0.0.1";
const ORIGINATOR_PORT: u32 = 0;

#[cfg(test)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConnectSshTunnelWebSocketRequest {
    connection_id: String,
    target: SshTunnelWebSocketTargetRequest,
    tunnel: SshTunnelRequest,
}

#[cfg(test)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SshTunnelWebSocketTargetRequest {
    url: String,
    insecure_transport_confirmed: bool,
    connect_timeout_ms: u64,
    #[serde(default)]
    non_sensitive_headers: BTreeMap<String, String>,
}

#[cfg(test)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SshTunnelRequest {
    host: String,
    #[serde(default)]
    port: Option<u16>,
    username: String,
    authentication: SshAuthenticationRequest,
    #[serde(default)]
    host_key: Option<SshHostKeyRequest>,
    connect_timeout_ms: u64,
    keep_alive_interval_ms: u64,
    keep_alive_max_failures: usize,
}

#[cfg(test)]
#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum SshAuthenticationRequest {
    Agent {},
    PrivateKey { private_key_path: String },
}

#[cfg(test)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SshHostKeyRequest {
    algorithm: String,
    sha256_fingerprint: String,
}

pub(super) struct ValidatedSshTunnel {
    pub(super) host: TargetHost,
    pub(super) port: u16,
    pub(super) username: String,
    pub(super) authentication: SshAuthentication,
    pub(super) host_key: Option<SshHostKeyRecord>,
    pub(super) connect_timeout: Duration,
    pub(super) keep_alive_interval: Duration,
    pub(super) keep_alive_max_failures: usize,
}

pub(super) struct SshHostKeyRecord {
    pub(super) algorithm: String,
    pub(super) fingerprint: Fingerprint,
}

// Secret-backed variants are constructed only by the Rust configuration layer. The WebView
// request deliberately exposes only Agent and an unencrypted private-key path.
pub(super) enum SshAuthentication {
    Agent,
    PrivateKey {
        private_key_path: PathBuf,
        passphrase: Option<SecretText>,
    },
    Password {
        password: SecretText,
    },
    #[cfg(test)]
    PrivateKeyMaterial(Arc<PrivateKey>),
}

#[cfg(test)]
impl ConnectSshTunnelWebSocketRequest {
    fn validate(self) -> Result<(ConnectionId, ValidatedTarget, ValidatedSshTunnel), CommandError> {
        let connection_id = ConnectionId::parse(self.connection_id)
            .map_err(|_| CommandError::invalid_connection_id())?;
        let target = ValidatedTarget::parse(
            &self.target.url,
            self.target.insecure_transport_confirmed,
            self.target.connect_timeout_ms,
            &self.target.non_sensitive_headers,
        )?;
        let tunnel = self.tunnel.validate()?;
        Ok((connection_id, target, tunnel))
    }
}

#[cfg(test)]
impl SshTunnelRequest {
    fn validate(self) -> Result<ValidatedSshTunnel, CommandError> {
        if self.host.is_empty() || self.host.len() > MAX_SSH_HOST_BYTES {
            return Err(ssh_error::invalid_host());
        }
        let host = parse_ssh_host(&self.host)?;
        let port = self.port.unwrap_or(DEFAULT_SSH_PORT);
        if port == 0 {
            return Err(ssh_error::invalid_port());
        }
        if self.username.is_empty()
            || self.username.len() > MAX_SSH_USERNAME_BYTES
            || self.username.chars().any(char::is_control)
        {
            return Err(ssh_error::invalid_username());
        }
        if !(MIN_SSH_CONNECT_TIMEOUT_MS..=MAX_SSH_CONNECT_TIMEOUT_MS)
            .contains(&self.connect_timeout_ms)
        {
            return Err(ssh_error::invalid_timeout());
        }
        if !(MIN_KEEP_ALIVE_INTERVAL_MS..=MAX_KEEP_ALIVE_INTERVAL_MS)
            .contains(&self.keep_alive_interval_ms)
        {
            return Err(ssh_error::invalid_keep_alive_interval());
        }
        if !(MIN_KEEP_ALIVE_FAILURES..=MAX_KEEP_ALIVE_FAILURES)
            .contains(&self.keep_alive_max_failures)
        {
            return Err(ssh_error::invalid_keep_alive_failures());
        }

        let authentication = self.authentication.validate()?;
        let host_key = self.host_key.map(SshHostKeyRequest::validate).transpose()?;
        Ok(ValidatedSshTunnel {
            host,
            port,
            username: self.username,
            authentication,
            host_key,
            connect_timeout: Duration::from_millis(self.connect_timeout_ms),
            keep_alive_interval: Duration::from_millis(self.keep_alive_interval_ms),
            keep_alive_max_failures: self.keep_alive_max_failures,
        })
    }
}

#[cfg(test)]
impl SshAuthenticationRequest {
    fn validate(self) -> Result<SshAuthentication, CommandError> {
        match self {
            Self::Agent {} => Ok(SshAuthentication::Agent),
            Self::PrivateKey { private_key_path } => {
                if private_key_path.is_empty()
                    || private_key_path.len() > MAX_PRIVATE_KEY_PATH_BYTES
                    || private_key_path.contains('\0')
                {
                    return Err(ssh_error::invalid_private_key_path());
                }
                let private_key_path = PathBuf::from(private_key_path);
                if !private_key_path.is_absolute() {
                    return Err(ssh_error::invalid_private_key_path());
                }
                Ok(SshAuthentication::PrivateKey {
                    private_key_path,
                    passphrase: None,
                })
            }
        }
    }
}

#[cfg(test)]
impl SshHostKeyRequest {
    fn validate(self) -> Result<SshHostKeyRecord, CommandError> {
        SshHostKeyRecord::parse(self.algorithm, &self.sha256_fingerprint)
    }
}

impl SshHostKeyRecord {
    pub(super) fn parse(algorithm: String, sha256_fingerprint: &str) -> Result<Self, CommandError> {
        if algorithm.is_empty()
            || algorithm.len() > MAX_SSH_ALGORITHM_BYTES
            || algorithm.chars().any(char::is_control)
        {
            return Err(ssh_error::invalid_host_key());
        }
        let fingerprint =
            Fingerprint::from_str(sha256_fingerprint).map_err(|_| ssh_error::invalid_host_key())?;
        if !fingerprint.is_sha256() {
            return Err(ssh_error::invalid_host_key());
        }
        Ok(Self {
            algorithm,
            fingerprint,
        })
    }
}

pub(super) fn parse_ssh_host(value: &str) -> Result<TargetHost, CommandError> {
    if let Ok(address) = value.parse::<IpAddr>() {
        return Ok(TargetHost::Ip(address));
    }

    match Host::parse(value).map_err(|_| ssh_error::invalid_host())? {
        Host::Domain(domain) if !domain.is_empty() && domain.len() <= MAX_SSH_HOST_BYTES => {
            Ok(TargetHost::Domain(domain))
        }
        Host::Ipv4(address) => Ok(TargetHost::Ip(address.into())),
        Host::Ipv6(address) => Ok(TargetHost::Ip(address.into())),
        Host::Domain(_) => Err(ssh_error::invalid_host()),
    }
}

#[cfg(test)]
pub(super) async fn open_ssh_tunnel_websocket(
    target: ValidatedTarget,
    tunnel: ValidatedSshTunnel,
) -> Result<RemoteWebSocket, CommandError> {
    open_ssh_tunnel_websocket_with_progress(target, tunnel, Arc::new(|_| {})).await
}

pub(super) async fn open_ssh_tunnel_websocket_with_progress(
    target: ValidatedTarget,
    tunnel: ValidatedSshTunnel,
    progress: ConnectionProgressCallback,
) -> Result<RemoteWebSocket, CommandError> {
    let ssh_timeout = tunnel.connect_timeout;
    let transport = match timeout(
        ssh_timeout,
        open_ssh_tunnel_with_progress(&target, tunnel, &progress),
    )
    .await
    {
        Ok(Ok(transport)) => transport,
        Ok(Err(error)) => return Err(map_ssh_failure(error)),
        Err(_) => return Err(ssh_error::timed_out()),
    };

    match timeout(
        target.connect_timeout,
        open_target_websocket_with_progress(target, Box::new(transport), &progress),
    )
    .await
    {
        Ok(Ok(websocket)) => Ok(websocket),
        Ok(Err(error)) => Err(connect_error(error)),
        Err(_) => Err(CommandError::connect_timed_out()),
    }
}

#[cfg(test)]
async fn open_ssh_tunnel(
    target: &ValidatedTarget,
    tunnel: ValidatedSshTunnel,
) -> Result<SshTunnelTransport, SshConnectFailure> {
    let progress: ConnectionProgressCallback = Arc::new(|_| {});
    open_ssh_tunnel_with_progress(target, tunnel, &progress).await
}

async fn open_ssh_tunnel_with_progress(
    target: &ValidatedTarget,
    tunnel: ValidatedSshTunnel,
    progress: &ConnectionProgressCallback,
) -> Result<SshTunnelTransport, SshConnectFailure> {
    progress(RemoteConnectionStage::ResolvingTarget);
    progress(RemoteConnectionStage::ConnectingProxy);
    let tcp_stream = connect_tcp(&tunnel.host, tunnel.port)
        .await
        .map_err(|_| SshConnectFailure::Network)?;
    tcp_stream
        .set_nodelay(true)
        .map_err(|_| SshConnectFailure::Network)?;

    let cancellation = CancellationToken::new();
    let connection_guard = SshConnectionGuard::new(cancellation.clone());
    let tcp_stream = CancellableSshStream::new(tcp_stream, cancellation.clone());
    let keep_alive_interval = tunnel.keep_alive_interval;
    let keep_alive_max_failures = tunnel.keep_alive_max_failures;
    let config = ssh_client_config();
    let endpoint_host = display_host(&tunnel.host);
    let handler = SshClientHandler {
        host: endpoint_host,
        port: tunnel.port,
        expected_host_key: tunnel.host_key,
    };

    let mut session = client::connect_stream(Arc::new(config), tcp_stream, handler)
        .await
        .map_err(map_client_connect_error)?;
    progress(RemoteConnectionStage::ProxyAuthentication);
    authenticate(&mut session, &tunnel.username, tunnel.authentication).await?;

    let target_host = display_host(&target.host);
    progress(RemoteConnectionStage::EstablishingTunnel);
    let channel = session
        .channel_open_direct_tcpip(
            target_host,
            u32::from(target.port),
            ORIGINATOR_ADDRESS,
            ORIGINATOR_PORT,
        )
        .await
        .map_err(map_channel_open_error)?;
    let runtime_failure = Arc::new(Mutex::new(None));
    let keep_alive = SshKeepAliveTask::spawn(
        session,
        keep_alive_interval,
        keep_alive_max_failures,
        cancellation,
        Arc::clone(&runtime_failure),
    );
    Ok(SshTunnelTransport {
        _connection_guard: connection_guard,
        runtime_failure,
        channel: channel.into_stream(),
        _keep_alive: keep_alive,
    })
}

fn ssh_client_config() -> client::Config {
    let default_preferred = russh::Preferred::default();
    let preferred = russh::Preferred {
        key: Cow::Owned(
            default_preferred
                .key
                .iter()
                .filter(|algorithm| !matches!(algorithm, Algorithm::Rsa { hash: None }))
                .cloned()
                .collect(),
        ),
        ..default_preferred
    };
    client::Config {
        inactivity_timeout: None,
        keepalive_interval: None,
        nodelay: true,
        preferred,
        ..client::Config::default()
    }
}

fn display_host(host: &TargetHost) -> String {
    match host {
        TargetHost::Domain(domain) => domain.clone(),
        TargetHost::Ip(address) => address.to_string(),
    }
}

struct SshConnectionGuard {
    cancellation: CancellationToken,
}

impl SshConnectionGuard {
    fn new(cancellation: CancellationToken) -> Self {
        Self { cancellation }
    }
}

impl Drop for SshConnectionGuard {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}

struct CancellableSshStream {
    stream: tokio::net::TcpStream,
    cancelled: Pin<Box<WaitForCancellationFutureOwned>>,
}

impl CancellableSshStream {
    fn new(stream: tokio::net::TcpStream, cancellation: CancellationToken) -> Self {
        Self {
            stream,
            cancelled: Box::pin(cancellation.cancelled_owned()),
        }
    }

    fn poll_cancelled(&mut self, context: &mut Context<'_>) -> io::Result<()> {
        if self.cancelled.as_mut().poll(context).is_ready() {
            Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "SSH connection was cancelled",
            ))
        } else {
            Ok(())
        }
    }
}

impl AsyncRead for CancellableSshStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        self.poll_cancelled(context)?;
        Pin::new(&mut self.stream).poll_read(context, buffer)
    }
}

impl AsyncWrite for CancellableSshStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.poll_cancelled(context)?;
        Pin::new(&mut self.stream).poll_write(context, bytes)
    }

    fn poll_flush(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.poll_cancelled(context)?;
        Pin::new(&mut self.stream).poll_flush(context)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.poll_cancelled(context)?;
        Pin::new(&mut self.stream).poll_shutdown(context)
    }
}

async fn authenticate(
    session: &mut client::Handle<SshClientHandler>,
    username: &str,
    authentication: SshAuthentication,
) -> Result<(), SshConnectFailure> {
    match authentication {
        SshAuthentication::Agent => authenticate_with_agent(session, username).await,
        SshAuthentication::PrivateKey {
            private_key_path,
            passphrase,
        } => {
            let private_key = load_private_key(private_key_path, passphrase).await?;
            authenticate_with_private_key(session, username, Arc::new(private_key)).await
        }
        SshAuthentication::Password { password } => {
            authenticate_with_password(session, username, password).await
        }
        #[cfg(test)]
        SshAuthentication::PrivateKeyMaterial(private_key) => {
            authenticate_with_private_key(session, username, private_key).await
        }
    }
}

async fn load_private_key(
    private_key_path: PathBuf,
    passphrase: Option<SecretText>,
) -> Result<PrivateKey, SshConnectFailure> {
    tokio::task::spawn_blocking(move || {
        let file = File::open(&private_key_path).map_err(map_private_key_io_error)?;
        let metadata = file.metadata().map_err(map_private_key_io_error)?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_PRIVATE_KEY_BYTES {
            return Err(SshConnectFailure::PrivateKeyInvalid);
        }

        let mut encoded = Zeroizing::new(String::new());
        file.take(MAX_PRIVATE_KEY_BYTES + 1)
            .read_to_string(&mut encoded)
            .map_err(map_private_key_io_error)?;
        if encoded.len() as u64 > MAX_PRIVATE_KEY_BYTES {
            return Err(SshConnectFailure::PrivateKeyInvalid);
        }
        russh::keys::decode_secret_key(&encoded, passphrase.as_ref().map(SecretText::as_str))
            .map_err(|error| match error {
                russh::keys::Error::KeyIsEncrypted if passphrase.is_none() => {
                    SshConnectFailure::PrivateKeyPassphraseRequired
                }
                _ => SshConnectFailure::PrivateKeyInvalid,
            })
    })
    .await
    .map_err(|_| SshConnectFailure::PrivateKeyRead)?
}

fn map_private_key_io_error(error: io::Error) -> SshConnectFailure {
    match error.kind() {
        io::ErrorKind::NotFound => SshConnectFailure::PrivateKeyNotFound,
        _ => SshConnectFailure::PrivateKeyRead,
    }
}

async fn authenticate_with_private_key(
    session: &mut client::Handle<SshClientHandler>,
    username: &str,
    private_key: Arc<PrivateKey>,
) -> Result<(), SshConnectFailure> {
    let hash_algorithm = secure_rsa_hash(session, private_key.algorithm()).await?;
    let result = session
        .authenticate_publickey(
            username,
            PrivateKeyWithHashAlg::new(private_key, hash_algorithm),
        )
        .await
        .map_err(SshConnectFailure::AuthenticationProtocol)?;
    require_authentication_success(result)
}

async fn authenticate_with_password(
    session: &mut client::Handle<SshClientHandler>,
    username: &str,
    password: SecretText,
) -> Result<(), SshConnectFailure> {
    let result = session
        .authenticate_password(username, password.as_str())
        .await
        .map_err(SshConnectFailure::AuthenticationProtocol)?;
    require_authentication_success(result)
}

async fn authenticate_with_agent(
    session: &mut client::Handle<SshClientHandler>,
    username: &str,
) -> Result<(), SshConnectFailure> {
    let mut agent = AgentClient::connect_env()
        .await
        .map_err(map_agent_connect_error)?;
    authenticate_with_agent_client(session, username, &mut agent).await
}

async fn authenticate_with_agent_client<S: AgentStream + Send + Unpin>(
    session: &mut client::Handle<SshClientHandler>,
    username: &str,
    agent: &mut AgentClient<S>,
) -> Result<(), SshConnectFailure> {
    let identities = agent
        .request_identities()
        .await
        .map_err(|_| SshConnectFailure::AgentCommunication)?;
    if identities.is_empty() {
        return Err(SshConnectFailure::AgentNoMatchingKey);
    }

    let mut skipped_unsafe_rsa = false;
    let mut attempted_safe_identity = false;
    let mut cached_rsa_hash: Option<Option<HashAlg>> = None;
    for identity in identities {
        let public_key = identity.public_key();
        let algorithm = public_key.algorithm();
        let hash_algorithm = if algorithm.clone().is_rsa() {
            let supported = match cached_rsa_hash {
                Some(supported) => supported,
                None => match secure_rsa_hash(session, algorithm).await {
                    Ok(supported) => {
                        cached_rsa_hash = Some(supported);
                        supported
                    }
                    Err(SshConnectFailure::RsaSha2Unsupported) => {
                        cached_rsa_hash = Some(None);
                        None
                    }
                    Err(error) => return Err(error),
                },
            };
            let Some(hash) = supported else {
                skipped_unsafe_rsa = true;
                continue;
            };
            Some(hash)
        } else {
            None
        };
        drop(public_key);
        attempted_safe_identity = true;

        let result = match identity {
            AgentIdentity::PublicKey { key, .. } => {
                session
                    .authenticate_publickey_with(username, key, hash_algorithm, agent)
                    .await
            }
            AgentIdentity::Certificate { certificate, .. } => {
                session
                    .authenticate_certificate_with(username, certificate, hash_algorithm, agent)
                    .await
            }
        };
        let result = result.map_err(|error| match error {
            AgentAuthError::Send(_) => {
                SshConnectFailure::AuthenticationProtocol(russh::Error::SendError)
            }
            AgentAuthError::Key(_) => SshConnectFailure::AgentSigning,
        })?;
        match result {
            client::AuthResult::Success => return Ok(()),
            client::AuthResult::Failure {
                partial_success: true,
                ..
            } => return Err(SshConnectFailure::AdditionalAuthenticationRequired),
            client::AuthResult::Failure {
                remaining_methods, ..
            } => {
                if !remaining_methods.contains(&MethodKind::PublicKey) {
                    return Err(SshConnectFailure::AgentNoMatchingKey);
                }
            }
        }
    }

    if skipped_unsafe_rsa && !attempted_safe_identity {
        Err(SshConnectFailure::RsaSha2Unsupported)
    } else {
        Err(SshConnectFailure::AgentNoMatchingKey)
    }
}

fn map_agent_connect_error(error: russh::keys::Error) -> SshConnectFailure {
    match error {
        russh::keys::Error::EnvVar(_) | russh::keys::Error::BadAuthSock => {
            SshConnectFailure::AgentUnavailable
        }
        russh::keys::Error::IO(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
            ) =>
        {
            SshConnectFailure::AgentUnavailable
        }
        _ => SshConnectFailure::AgentCommunication,
    }
}

async fn secure_rsa_hash(
    session: &client::Handle<SshClientHandler>,
    algorithm: Algorithm,
) -> Result<Option<HashAlg>, SshConnectFailure> {
    if !algorithm.is_rsa() {
        return Ok(None);
    }
    match session
        .best_supported_rsa_hash()
        .await
        .map_err(SshConnectFailure::AuthenticationProtocol)?
    {
        Some(Some(hash @ (HashAlg::Sha256 | HashAlg::Sha512))) => Ok(Some(hash)),
        None => Ok(Some(HashAlg::Sha512)),
        Some(None) | Some(Some(_)) => Err(SshConnectFailure::RsaSha2Unsupported),
    }
}

fn require_authentication_success(result: client::AuthResult) -> Result<(), SshConnectFailure> {
    match result {
        client::AuthResult::Success => Ok(()),
        client::AuthResult::Failure {
            partial_success: true,
            ..
        } => Err(SshConnectFailure::AdditionalAuthenticationRequired),
        client::AuthResult::Failure { .. } => Err(SshConnectFailure::AuthenticationRejected),
    }
}

#[derive(Debug)]
enum SshClientError {
    Protocol(russh::Error),
    HostKeyUnknown {
        host: String,
        port: u16,
        received: SshHostKeyIdentity,
    },
    HostKeyChanged {
        host: String,
        port: u16,
        expected: SshHostKeyIdentity,
        received: SshHostKeyIdentity,
    },
}

impl From<russh::Error> for SshClientError {
    fn from(error: russh::Error) -> Self {
        Self::Protocol(error)
    }
}

struct SshClientHandler {
    host: String,
    port: u16,
    expected_host_key: Option<SshHostKeyRecord>,
}

impl client::Handler for SshClientHandler {
    type Error = SshClientError;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let received_fingerprint = server_public_key.fingerprint(HashAlg::Sha256);
        let received = SshHostKeyIdentity {
            algorithm: server_public_key.algorithm().to_string(),
            sha256_fingerprint: received_fingerprint.to_string(),
        };
        let Some(expected) = &self.expected_host_key else {
            return Err(SshClientError::HostKeyUnknown {
                host: self.host.clone(),
                port: self.port,
                received,
            });
        };
        if expected.algorithm != received.algorithm || expected.fingerprint != received_fingerprint
        {
            return Err(SshClientError::HostKeyChanged {
                host: self.host.clone(),
                port: self.port,
                expected: SshHostKeyIdentity {
                    algorithm: expected.algorithm.clone(),
                    sha256_fingerprint: expected.fingerprint.to_string(),
                },
                received,
            });
        }
        Ok(true)
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        _channel: Channel<client::Msg>,
        _connected_address: &str,
        _connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        reject_server_channel(reply).await;
        Ok(())
    }

    async fn server_channel_open_forwarded_streamlocal(
        &mut self,
        _channel: Channel<client::Msg>,
        _socket_path: &str,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        reject_server_channel(reply).await;
        Ok(())
    }

    async fn server_channel_open_agent_forward(
        &mut self,
        _channel: Channel<client::Msg>,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        reject_server_channel(reply).await;
        Ok(())
    }

    async fn server_channel_open_session(
        &mut self,
        _channel: Channel<client::Msg>,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        reject_server_channel(reply).await;
        Ok(())
    }

    async fn server_channel_open_direct_tcpip(
        &mut self,
        _channel: Channel<client::Msg>,
        _host_to_connect: &str,
        _port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        reject_server_channel(reply).await;
        Ok(())
    }

    async fn server_channel_open_direct_streamlocal(
        &mut self,
        _channel: Channel<client::Msg>,
        _socket_path: &str,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        reject_server_channel(reply).await;
        Ok(())
    }

    async fn server_channel_open_x11(
        &mut self,
        _channel: Channel<client::Msg>,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        reject_server_channel(reply).await;
        Ok(())
    }

    async fn should_accept_unknown_server_channel(
        &mut self,
        _id: ChannelId,
        _channel_type: &str,
    ) -> bool {
        true
    }

    async fn server_channel_open_unknown(
        &mut self,
        _channel: Channel<client::Msg>,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        reply.reject(ChannelOpenFailure::UnknownChannelType).await;
        Ok(())
    }
}

async fn reject_server_channel(reply: client::ChannelOpenHandle) {
    reply
        .reject(ChannelOpenFailure::AdministrativelyProhibited)
        .await;
}

struct SshTunnelTransport {
    _connection_guard: SshConnectionGuard,
    runtime_failure: Arc<Mutex<Option<RemoteTransportFailure>>>,
    channel: ChannelStream<client::Msg>,
    _keep_alive: SshKeepAliveTask,
}

impl SshTunnelTransport {
    fn runtime_error(&self) -> Option<io::Error> {
        self.runtime_failure
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .copied()
            .map(remote_transport_error)
    }
}

impl AsyncRead for SshTunnelTransport {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if let Some(error) = self.runtime_error() {
            return Poll::Ready(Err(error));
        }
        let filled_before = buffer.filled().len();
        let result = Pin::new(&mut self.channel).poll_read(context, buffer);
        let stopped = matches!(&result, Poll::Ready(Err(_)))
            || matches!(&result, Poll::Ready(Ok(()))) && buffer.filled().len() == filled_before;
        if stopped {
            if let Some(error) = self.runtime_error() {
                return Poll::Ready(Err(error));
            }
        }
        result
    }
}

impl AsyncWrite for SshTunnelTransport {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        if let Some(error) = self.runtime_error() {
            return Poll::Ready(Err(error));
        }
        let result = Pin::new(&mut self.channel).poll_write(context, bytes);
        if matches!(&result, Poll::Ready(Err(_) | Ok(0))) {
            if let Some(error) = self.runtime_error() {
                return Poll::Ready(Err(error));
            }
        }
        result
    }

    fn poll_flush(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        if let Some(error) = self.runtime_error() {
            return Poll::Ready(Err(error));
        }
        let result = Pin::new(&mut self.channel).poll_flush(context);
        if result.is_ready() {
            if let Some(error) = self.runtime_error() {
                return Poll::Ready(Err(error));
            }
        }
        result
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        if let Some(error) = self.runtime_error() {
            return Poll::Ready(Err(error));
        }
        let result = Pin::new(&mut self.channel).poll_shutdown(context);
        if result.is_ready() {
            if let Some(error) = self.runtime_error() {
                return Poll::Ready(Err(error));
            }
        }
        result
    }
}

struct SshKeepAliveTask {
    task: JoinHandle<()>,
}

impl SshKeepAliveTask {
    fn spawn(
        session: client::Handle<SshClientHandler>,
        keep_alive_interval: Duration,
        keep_alive_max_failures: usize,
        cancellation: CancellationToken,
        runtime_failure: Arc<Mutex<Option<RemoteTransportFailure>>>,
    ) -> Self {
        let task = tokio::spawn(supervise_ssh_session(
            session,
            keep_alive_interval,
            keep_alive_max_failures,
            cancellation,
            runtime_failure,
        ));
        Self { task }
    }
}

impl Drop for SshKeepAliveTask {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn supervise_ssh_session(
    mut session: client::Handle<SshClientHandler>,
    keep_alive_interval: Duration,
    keep_alive_max_failures: usize,
    cancellation: CancellationToken,
    runtime_failure: Arc<Mutex<Option<RemoteTransportFailure>>>,
) {
    debug_assert!(keep_alive_max_failures > 0);
    let mut ticker = interval_at(Instant::now() + keep_alive_interval, keep_alive_interval);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut consecutive_failures = 0_usize;

    loop {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return,
            result = &mut session => {
                if let Err(error) = result {
                    if let Some(failure) = runtime_transport_failure(error) {
                        record_runtime_failure(&runtime_failure, failure);
                    }
                }
                cancellation.cancel();
                return;
            }
            _ = ticker.tick() => {}
        }

        let ping = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return,
            result = timeout(keep_alive_interval, session.send_ping()) => result,
        };
        if matches!(ping, Ok(Ok(()))) {
            consecutive_failures = 0;
            continue;
        }

        consecutive_failures = consecutive_failures.saturating_add(1);
        if consecutive_failures >= keep_alive_max_failures {
            record_runtime_failure(
                &runtime_failure,
                RemoteTransportFailure::SshKeepAliveTimedOut,
            );
            let _ = session
                .disconnect(Disconnect::ConnectionLost, "SSH keep-alive timed out", "")
                .await;
            cancellation.cancel();
            return;
        }
    }
}

fn runtime_transport_failure(error: SshClientError) -> Option<RemoteTransportFailure> {
    match error {
        SshClientError::Protocol(russh::Error::KeepaliveTimeout) => {
            Some(RemoteTransportFailure::SshKeepAliveTimedOut)
        }
        SshClientError::Protocol(_)
        | SshClientError::HostKeyUnknown { .. }
        | SshClientError::HostKeyChanged { .. } => None,
    }
}

fn record_runtime_failure(
    runtime_failure: &Mutex<Option<RemoteTransportFailure>>,
    failure: RemoteTransportFailure,
) {
    let mut current = runtime_failure
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if current.is_none() {
        *current = Some(failure);
    }
}

enum SshConnectFailure {
    Network,
    Handshake,
    AlgorithmNegotiation,
    HostKeyUnknown {
        host: String,
        port: u16,
        received: SshHostKeyIdentity,
    },
    HostKeyChanged {
        host: String,
        port: u16,
        expected: SshHostKeyIdentity,
        received: SshHostKeyIdentity,
    },
    AgentUnavailable,
    AgentCommunication,
    AgentNoMatchingKey,
    AgentSigning,
    PrivateKeyNotFound,
    PrivateKeyRead,
    PrivateKeyInvalid,
    PrivateKeyPassphraseRequired,
    AuthenticationProtocol(russh::Error),
    AuthenticationRejected,
    AdditionalAuthenticationRequired,
    RsaSha2Unsupported,
    TunnelProhibited,
    TargetConnectFailed,
    TunnelUnsupported,
    TunnelResourceShortage,
    TunnelRejected,
}

fn map_client_connect_error(error: SshClientError) -> SshConnectFailure {
    match error {
        SshClientError::Protocol(russh::Error::NoCommonAlgo { .. }) => {
            SshConnectFailure::AlgorithmNegotiation
        }
        SshClientError::Protocol(_) => SshConnectFailure::Handshake,
        SshClientError::HostKeyUnknown {
            host,
            port,
            received,
        } => SshConnectFailure::HostKeyUnknown {
            host,
            port,
            received,
        },
        SshClientError::HostKeyChanged {
            host,
            port,
            expected,
            received,
        } => SshConnectFailure::HostKeyChanged {
            host,
            port,
            expected,
            received,
        },
    }
}

fn map_channel_open_error(error: russh::Error) -> SshConnectFailure {
    match error {
        russh::Error::ChannelOpenFailure(ChannelOpenFailure::AdministrativelyProhibited) => {
            SshConnectFailure::TunnelProhibited
        }
        russh::Error::ChannelOpenFailure(ChannelOpenFailure::ConnectFailed) => {
            SshConnectFailure::TargetConnectFailed
        }
        russh::Error::ChannelOpenFailure(ChannelOpenFailure::UnknownChannelType) => {
            SshConnectFailure::TunnelUnsupported
        }
        russh::Error::ChannelOpenFailure(ChannelOpenFailure::ResourceShortage) => {
            SshConnectFailure::TunnelResourceShortage
        }
        russh::Error::ChannelOpenFailure(ChannelOpenFailure::Other { .. }) => {
            SshConnectFailure::TunnelRejected
        }
        _ => SshConnectFailure::TunnelRejected,
    }
}

fn map_ssh_failure(error: SshConnectFailure) -> CommandError {
    match error {
        SshConnectFailure::Network => ssh_error::network_failed(),
        SshConnectFailure::Handshake => ssh_error::handshake_failed(),
        SshConnectFailure::AlgorithmNegotiation => ssh_error::algorithm_negotiation_failed(),
        SshConnectFailure::HostKeyUnknown {
            host,
            port,
            received,
        } => ssh_error::host_key_unknown(CommandErrorDetails::SshHostKeyUnknown {
            host,
            port,
            received,
        }),
        SshConnectFailure::HostKeyChanged {
            host,
            port,
            expected,
            received,
        } => ssh_error::host_key_changed(CommandErrorDetails::SshHostKeyChanged {
            host,
            port,
            expected,
            received,
        }),
        SshConnectFailure::AgentUnavailable => ssh_error::agent_unavailable(),
        SshConnectFailure::AgentCommunication => ssh_error::agent_communication_failed(),
        SshConnectFailure::AgentNoMatchingKey => ssh_error::agent_no_matching_key(),
        SshConnectFailure::AgentSigning => ssh_error::agent_signing_failed(),
        SshConnectFailure::PrivateKeyNotFound => ssh_error::private_key_not_found(),
        SshConnectFailure::PrivateKeyRead => ssh_error::private_key_unreadable(),
        SshConnectFailure::PrivateKeyInvalid => ssh_error::private_key_invalid(),
        SshConnectFailure::PrivateKeyPassphraseRequired => {
            ssh_error::private_key_passphrase_required()
        }
        SshConnectFailure::AuthenticationProtocol(error) => {
            let _category = match error {
                russh::Error::KeepaliveTimeout => "keepaliveTimeout",
                russh::Error::Disconnect | russh::Error::HUP => "disconnected",
                russh::Error::SendError | russh::Error::RecvError => "channelClosed",
                _ => "protocol",
            };
            tracing::warn!(
                error_category = _category,
                "SSH authentication protocol failed"
            );
            ssh_error::authentication_protocol_failed()
        }
        SshConnectFailure::AuthenticationRejected => ssh_error::authentication_rejected(),
        SshConnectFailure::AdditionalAuthenticationRequired => {
            ssh_error::additional_authentication_required()
        }
        SshConnectFailure::RsaSha2Unsupported => ssh_error::rsa_sha2_unsupported(),
        SshConnectFailure::TunnelProhibited => ssh_error::tunnel_prohibited(),
        SshConnectFailure::TargetConnectFailed => ssh_error::target_connect_failed(),
        SshConnectFailure::TunnelUnsupported => ssh_error::tunnel_unsupported(),
        SshConnectFailure::TunnelResourceShortage => ssh_error::tunnel_resource_shortage(),
        SshConnectFailure::TunnelRejected => ssh_error::tunnel_rejected(),
    }
}

mod ssh_error {
    use super::{CommandError, CommandErrorDetails};

    pub(super) const fn invalid_host() -> CommandError {
        CommandError::new("invalidSshHost", "The SSH host is invalid")
    }

    #[cfg(test)]
    pub(super) const fn invalid_port() -> CommandError {
        CommandError::new("invalidSshPort", "The SSH port is invalid")
    }

    #[cfg(test)]
    pub(super) const fn invalid_username() -> CommandError {
        CommandError::new("invalidSshUsername", "The SSH username is invalid")
    }

    #[cfg(test)]
    pub(super) const fn invalid_private_key_path() -> CommandError {
        CommandError::new(
            "invalidSshPrivateKeyPath",
            "The SSH private key path must be an absolute path",
        )
    }

    pub(super) const fn invalid_host_key() -> CommandError {
        CommandError::new(
            "invalidSshHostKeyRecord",
            "The SSH host key record is invalid",
        )
    }

    #[cfg(test)]
    pub(super) const fn invalid_timeout() -> CommandError {
        CommandError::new(
            "invalidSshConnectTimeout",
            "The SSH connection timeout is invalid",
        )
    }

    #[cfg(test)]
    pub(super) const fn invalid_keep_alive_interval() -> CommandError {
        CommandError::new(
            "invalidSshKeepAliveInterval",
            "The SSH keep-alive interval is invalid",
        )
    }

    #[cfg(test)]
    pub(super) const fn invalid_keep_alive_failures() -> CommandError {
        CommandError::new(
            "invalidSshKeepAliveFailures",
            "The SSH keep-alive failure count is invalid",
        )
    }

    pub(super) const fn timed_out() -> CommandError {
        CommandError::new("sshConnectTimedOut", "The SSH connection timed out")
    }

    pub(super) const fn network_failed() -> CommandError {
        CommandError::new(
            "sshNetworkConnectFailed",
            "The SSH network connection could not be established",
        )
    }

    pub(super) const fn handshake_failed() -> CommandError {
        CommandError::new(
            "sshHandshakeFailed",
            "The SSH handshake could not be completed",
        )
    }

    pub(super) const fn algorithm_negotiation_failed() -> CommandError {
        CommandError::new(
            "sshAlgorithmNegotiationFailed",
            "The SSH server does not support a compatible secure algorithm",
        )
    }

    pub(super) fn host_key_unknown(details: CommandErrorDetails) -> CommandError {
        CommandError::new(
            "sshHostKeyUnknown",
            "The SSH host key has not been confirmed",
        )
        .with_details(details)
    }

    pub(super) fn host_key_changed(details: CommandErrorDetails) -> CommandError {
        CommandError::new(
            "sshHostKeyChanged",
            "The SSH host key does not match the confirmed key",
        )
        .with_details(details)
    }

    pub(super) const fn agent_unavailable() -> CommandError {
        CommandError::new("sshAgentUnavailable", "The SSH Agent is unavailable")
    }

    pub(super) const fn agent_communication_failed() -> CommandError {
        CommandError::new(
            "sshAgentCommunicationFailed",
            "The SSH Agent could not be queried",
        )
    }

    pub(super) const fn agent_no_matching_key() -> CommandError {
        CommandError::new(
            "sshAgentNoMatchingKey",
            "The SSH Agent has no key accepted by the server",
        )
    }

    pub(super) const fn agent_signing_failed() -> CommandError {
        CommandError::new(
            "sshAgentSigningFailed",
            "The SSH Agent could not sign the authentication request",
        )
    }

    pub(super) const fn private_key_not_found() -> CommandError {
        CommandError::new("sshPrivateKeyNotFound", "The SSH private key was not found")
    }

    pub(super) const fn private_key_unreadable() -> CommandError {
        CommandError::new(
            "sshPrivateKeyUnreadable",
            "The SSH private key could not be read",
        )
    }

    pub(super) const fn private_key_invalid() -> CommandError {
        CommandError::new("sshPrivateKeyInvalid", "The SSH private key is invalid")
    }

    pub(super) const fn private_key_passphrase_required() -> CommandError {
        CommandError::new(
            "sshPrivateKeyPassphraseRequired",
            "The SSH private key requires a configured passphrase",
        )
    }

    pub(super) const fn authentication_protocol_failed() -> CommandError {
        CommandError::new(
            "sshAuthenticationProtocolFailed",
            "SSH authentication could not be completed",
        )
    }

    pub(super) const fn authentication_rejected() -> CommandError {
        CommandError::new(
            "sshAuthenticationRejected",
            "The SSH server rejected the configured authentication method",
        )
    }

    pub(super) const fn additional_authentication_required() -> CommandError {
        CommandError::new(
            "sshAdditionalAuthenticationRequired",
            "The SSH server requires an additional authentication method",
        )
    }

    pub(super) const fn rsa_sha2_unsupported() -> CommandError {
        CommandError::new(
            "sshRsaSha2Unsupported",
            "The SSH server does not support a secure RSA signature algorithm",
        )
    }

    pub(super) const fn tunnel_prohibited() -> CommandError {
        CommandError::new(
            "sshTunnelProhibited",
            "The SSH server prohibits direct TCP/IP channels",
        )
    }

    pub(super) const fn target_connect_failed() -> CommandError {
        CommandError::new(
            "sshTargetConnectFailed",
            "The SSH server could not connect to the WebSocket target",
        )
    }

    pub(super) const fn tunnel_unsupported() -> CommandError {
        CommandError::new(
            "sshTunnelUnsupported",
            "The SSH server does not support direct TCP/IP channels",
        )
    }

    pub(super) const fn tunnel_resource_shortage() -> CommandError {
        CommandError::new(
            "sshTunnelResourceShortage",
            "The SSH server lacks resources to open the tunnel",
        )
    }

    pub(super) const fn tunnel_rejected() -> CommandError {
        CommandError::new(
            "sshTunnelRejected",
            "The SSH server rejected the direct TCP/IP channel",
        )
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeMap,
        fs::OpenOptions,
        future::{Future, pending},
        io::Write,
        net::SocketAddr,
        os::unix::fs::OpenOptionsExt,
        path::PathBuf,
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };

    use futures_util::{SinkExt, StreamExt};
    use russh::{Channel, ChannelOpenFailure, server};
    use serde_json::json;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt, copy_bidirectional},
        net::{TcpListener, TcpStream},
        sync::oneshot,
        task::JoinHandle,
        time::timeout,
    };
    use tokio_tungstenite::{
        accept_async,
        tungstenite::{Error as WebSocketError, Message, Utf8Bytes},
    };

    use super::{
        ConnectSshTunnelWebSocketRequest, SshAuthentication, SshClientHandler, SshHostKeyRecord,
        SshTunnelRequest, ValidatedSshTunnel, authenticate_with_agent_client, display_host,
        load_private_key, map_ssh_failure, open_ssh_tunnel, open_ssh_tunnel_websocket,
        open_ssh_tunnel_websocket_with_progress, ssh_client_config,
    };
    use crate::configuration::SecretText;
    use crate::connection::remote_websocket::{
        CommandErrorDetails, RemoteConnectionStage, RemoteTransportFailure, TargetHost,
        ValidatedTarget,
    };
    use russh::keys::{Algorithm, HashAlg, PrivateKey, agent::client::AgentClient, key::safe_rng};

    static TEMP_FILE_SEQUENCE: AtomicUsize = AtomicUsize::new(0);
    const TEST_PASSWORD: &str = "ssh-test-password";

    fn secret_text(value: &str) -> SecretText {
        serde_json::from_value(json!(value)).expect("test secret should deserialize")
    }

    struct TempPrivateKeyFile(PathBuf);

    impl TempPrivateKeyFile {
        fn write(private_key: &PrivateKey) -> Self {
            let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = PathBuf::from(format!(
                "/tmp/codex-desktop-ssh-key-{}-{sequence}",
                std::process::id()
            ));
            let encoded = private_key
                .to_openssh(russh::keys::ssh_key::LineEnding::LF)
                .expect("test private key should encode");
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)
                .expect("temporary private key should be created");
            file.write_all(encoded.as_bytes())
                .expect("temporary private key should be written");
            Self(path)
        }
    }

    impl Drop for TempPrivateKeyFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    struct DirectTcpipRequest {
        host: String,
        port: u32,
        originator_address: String,
        originator_port: u32,
    }

    struct TestSshServer {
        target_address: SocketAddr,
        expected_user_key_fingerprint: russh::keys::ssh_key::Fingerprint,
        public_key_attempts: Arc<AtomicUsize>,
        password_attempts: Arc<AtomicUsize>,
        direct_request: Option<oneshot::Sender<DirectTcpipRequest>>,
    }

    impl server::Handler for TestSshServer {
        type Error = russh::Error;

        async fn auth_password(
            &mut self,
            user: &str,
            password: &str,
        ) -> Result<server::Auth, Self::Error> {
            self.password_attempts.fetch_add(1, Ordering::SeqCst);
            Ok(if user == "alice" && password == TEST_PASSWORD {
                server::Auth::Accept
            } else {
                server::Auth::reject()
            })
        }

        async fn auth_publickey(
            &mut self,
            user: &str,
            public_key: &russh::keys::PublicKey,
        ) -> Result<server::Auth, Self::Error> {
            self.public_key_attempts.fetch_add(1, Ordering::SeqCst);
            let accepted = user == "alice"
                && public_key.fingerprint(HashAlg::Sha256) == self.expected_user_key_fingerprint;
            Ok(if accepted {
                server::Auth::Accept
            } else {
                server::Auth::reject()
            })
        }

        async fn channel_open_direct_tcpip(
            &mut self,
            channel: Channel<server::Msg>,
            host_to_connect: &str,
            port_to_connect: u32,
            originator_address: &str,
            originator_port: u32,
            reply: server::ChannelOpenHandle,
            _session: &mut server::Session,
        ) -> Result<(), Self::Error> {
            if let Some(sender) = self.direct_request.take() {
                let _ = sender.send(DirectTcpipRequest {
                    host: host_to_connect.to_owned(),
                    port: port_to_connect,
                    originator_address: originator_address.to_owned(),
                    originator_port,
                });
            }
            let target_address = self.target_address;
            tokio::spawn(async move {
                let mut target = match TcpStream::connect(target_address).await {
                    Ok(target) => target,
                    Err(_) => {
                        reply.reject(ChannelOpenFailure::ConnectFailed).await;
                        return;
                    }
                };
                reply.accept().await;
                let mut tunnel = channel.into_stream();
                let _ = copy_bidirectional(&mut tunnel, &mut target).await;
            });
            Ok(())
        }
    }

    struct TestSshFixture {
        address: SocketAddr,
        host_key: SshHostKeyRecord,
        handle_receiver: oneshot::Receiver<server::Handle>,
        task: JoinHandle<()>,
    }

    async fn spawn_test_ssh_server(
        target_address: SocketAddr,
        user_key: &PrivateKey,
        public_key_attempts: Arc<AtomicUsize>,
        password_attempts: Arc<AtomicUsize>,
        direct_request: Option<oneshot::Sender<DirectTcpipRequest>>,
    ) -> TestSshFixture {
        let server_key = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519)
            .expect("test server key should be generated");
        let host_key = SshHostKeyRecord {
            algorithm: server_key.public_key().algorithm().to_string(),
            fingerprint: server_key.public_key().fingerprint(HashAlg::Sha256),
        };
        let expected_user_key_fingerprint = user_key.public_key().fingerprint(HashAlg::Sha256);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test SSH listener should bind");
        let address = listener
            .local_addr()
            .expect("test SSH listener should have an address");
        let config = server::Config {
            auth_rejection_time: Duration::ZERO,
            auth_rejection_time_initial: Some(Duration::ZERO),
            inactivity_timeout: None,
            keys: vec![server_key],
            ..server::Config::default()
        };
        let (handle_sender, handle_receiver) = oneshot::channel();
        let task = tokio::spawn(async move {
            let (socket, _) = listener
                .accept()
                .await
                .expect("test SSH connection should arrive");
            let running = server::run_stream(
                Arc::new(config),
                socket,
                TestSshServer {
                    target_address,
                    expected_user_key_fingerprint,
                    public_key_attempts,
                    password_attempts,
                    direct_request,
                },
            )
            .await
            .expect("test SSH handshake should start");
            let _ = handle_sender.send(running.handle());
            let _ = running.await;
        });
        TestSshFixture {
            address,
            host_key,
            handle_receiver,
            task,
        }
    }

    async fn assert_server_channel_prohibited<F>(channel_open: F)
    where
        F: Future<Output = Result<Channel<server::Msg>, russh::Error>>,
    {
        let result = timeout(Duration::from_secs(2), channel_open)
            .await
            .expect("server channel rejection should not time out");
        assert!(matches!(
            result,
            Err(russh::Error::ChannelOpenFailure(
                ChannelOpenFailure::AdministrativelyProhibited
            ))
        ));
    }

    fn target(url: String) -> ValidatedTarget {
        ValidatedTarget::parse(&url, true, 5_000, &BTreeMap::new())
            .expect("test target should be valid")
    }

    fn tunnel(
        fixture: &TestSshFixture,
        authentication: SshAuthentication,
        host_key: Option<SshHostKeyRecord>,
    ) -> ValidatedSshTunnel {
        ValidatedSshTunnel {
            host: TargetHost::Ip(fixture.address.ip()),
            port: fixture.address.port(),
            username: "alice".to_owned(),
            authentication,
            host_key,
            connect_timeout: Duration::from_secs(5),
            keep_alive_interval: Duration::from_secs(15),
            keep_alive_max_failures: 3,
        }
    }

    #[test]
    fn validates_defaults_keep_alive_and_secret_free_ipc() {
        let host_fingerprint = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519)
            .expect("host key should be generated")
            .public_key()
            .fingerprint(HashAlg::Sha256)
            .to_string();
        let base = json!({
            "connectionId": "remote",
            "target": {
                "url": "wss://target.example.test/app",
                "insecureTransportConfirmed": false,
                "connectTimeoutMs": 10_000
            },
            "tunnel": {
                "host": "ssh.example.test",
                "username": "alice",
                "authentication": { "type": "agent" },
                "hostKey": {
                    "algorithm": "ssh-ed25519",
                    "sha256Fingerprint": host_fingerprint
                },
                "connectTimeoutMs": 8_000,
                "keepAliveIntervalMs": 15_000,
                "keepAliveMaxFailures": 3
            }
        });
        let request: ConnectSshTunnelWebSocketRequest =
            serde_json::from_value(base.clone()).expect("request should deserialize");
        let (_, _, tunnel) = request.validate().expect("request should validate");
        assert_eq!(tunnel.port, 22);
        assert_eq!(tunnel.keep_alive_interval, Duration::from_secs(15));
        assert_eq!(tunnel.keep_alive_max_failures, 3);

        let mut password_in_auth = base.clone();
        password_in_auth["tunnel"]["authentication"]["password"] = json!("top-secret");
        let error = serde_json::from_value::<ConnectSshTunnelWebSocketRequest>(password_in_auth)
            .expect_err("authentication secrets must be rejected");
        assert!(!error.to_string().contains("top-secret"));

        let mut password_in_tunnel = base.clone();
        password_in_tunnel["tunnel"]["password"] = json!("top-secret");
        assert!(
            serde_json::from_value::<ConnectSshTunnelWebSocketRequest>(password_in_tunnel).is_err()
        );

        let mut password_authentication = base.clone();
        password_authentication["tunnel"]["authentication"] = json!({
            "type": "password",
            "password": "top-secret"
        });
        let error =
            serde_json::from_value::<ConnectSshTunnelWebSocketRequest>(password_authentication)
                .expect_err("password authentication must not be accepted from the WebView");
        assert!(!error.to_string().contains("top-secret"));

        let mut zero_keep_alive = base;
        zero_keep_alive["tunnel"]["keepAliveMaxFailures"] = json!(0);
        let request: ConnectSshTunnelWebSocketRequest =
            serde_json::from_value(zero_keep_alive).expect("request should deserialize");
        let error = match request.validate() {
            Err(error) => error,
            Ok(_) => panic!("zero keep-alive failures must be rejected"),
        };
        assert_eq!(error.code, "invalidSshKeepAliveFailures");
    }

    #[test]
    fn rejects_relative_private_key_path() {
        let request = SshTunnelRequest {
            host: "ssh.example.test".to_owned(),
            port: None,
            username: "alice".to_owned(),
            authentication: super::SshAuthenticationRequest::PrivateKey {
                private_key_path: ".ssh/id_ed25519".to_owned(),
            },
            host_key: None,
            connect_timeout_ms: 5_000,
            keep_alive_interval_ms: 15_000,
            keep_alive_max_failures: 3,
        };
        let error = match request.validate() {
            Err(error) => error,
            Ok(_) => panic!("relative private key paths must be rejected"),
        };
        assert_eq!(error.code, "invalidSshPrivateKeyPath");
    }

    #[test]
    fn config_disables_pre_authentication_timers_and_legacy_rsa_host_keys() {
        let config = ssh_client_config();
        assert_eq!(config.inactivity_timeout, None);
        assert_eq!(config.keepalive_interval, None);
        assert!(config.nodelay);
        assert!(
            config
                .preferred
                .key
                .iter()
                .all(|algorithm| !matches!(algorithm, Algorithm::Rsa { hash: None }))
        );
    }

    #[tokio::test]
    async fn cancels_spawned_kex_task_when_connection_attempt_is_dropped() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("silent SSH listener should bind");
        let address = listener
            .local_addr()
            .expect("silent SSH listener should have an address");
        let (kex_sender, kex_receiver) = oneshot::channel();
        let server_task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("SSH client should connect");
            let mut byte = [0_u8; 1];
            loop {
                socket
                    .read_exact(&mut byte)
                    .await
                    .expect("client SSH identification should arrive");
                if byte[0] == b'\n' {
                    break;
                }
            }
            socket
                .write_all(b"SSH-2.0-codex-silent-test\r\n")
                .await
                .expect("server SSH identification should be sent");
            let mut packet_length = [0_u8; 4];
            socket
                .read_exact(&mut packet_length)
                .await
                .expect("client KEX packet should arrive");
            let _ = kex_sender.send(());

            let mut buffer = [0_u8; 4096];
            loop {
                match timeout(Duration::from_secs(1), socket.read(&mut buffer)).await {
                    Ok(Ok(0)) => return true,
                    Ok(Ok(_)) => {}
                    Ok(Err(_)) => return true,
                    Err(_) => return false,
                }
            }
        });
        let user_key = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519)
            .expect("user key should be generated");
        let tunnel = ValidatedSshTunnel {
            host: TargetHost::Ip(address.ip()),
            port: address.port(),
            username: "alice".to_owned(),
            authentication: SshAuthentication::PrivateKeyMaterial(Arc::new(user_key)),
            host_key: None,
            connect_timeout: Duration::from_secs(5),
            keep_alive_interval: Duration::from_secs(15),
            keep_alive_max_failures: 3,
        };

        let connection_task = tokio::spawn(async move {
            open_ssh_tunnel(&target("ws://target.internal:8080/app".to_owned()), tunnel).await
        });
        timeout(Duration::from_secs(2), kex_receiver)
            .await
            .expect("client KEX packet should arrive")
            .expect("silent server should report the KEX packet");
        assert!(
            !connection_task.is_finished(),
            "silent KEX should remain pending"
        );
        connection_task.abort();
        let join_error = match connection_task.await {
            Err(error) => error,
            Ok(_) => panic!("connection task should be cancelled"),
        };
        assert!(join_error.is_cancelled());
        assert!(
            timeout(Duration::from_secs(2), server_task)
                .await
                .expect("silent server should observe cancellation")
                .expect("silent server task should finish"),
            "dropping the connection attempt must close the detached KEX socket"
        );
    }

    #[tokio::test]
    async fn reports_keep_alive_timeout_when_ssh_transport_stops_responding() {
        let target_listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test target listener should bind");
        let target_address = target_listener
            .local_addr()
            .expect("test target listener should have an address");
        let target_task = tokio::spawn(async move {
            let (stream, _) = target_listener
                .accept()
                .await
                .expect("tunnel should reach target");
            let _websocket = accept_async(stream)
                .await
                .expect("target WebSocket should accept handshake");
            pending::<()>().await;
        });

        let user_key = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519)
            .expect("user key should be generated");
        let public_key_attempts = Arc::new(AtomicUsize::new(0));
        let password_attempts = Arc::new(AtomicUsize::new(0));
        let fixture = spawn_test_ssh_server(
            target_address,
            &user_key,
            Arc::clone(&public_key_attempts),
            Arc::clone(&password_attempts),
            None,
        )
        .await;

        let relay_listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test relay listener should bind");
        let relay_address = relay_listener
            .local_addr()
            .expect("test relay listener should have an address");
        let ssh_address = fixture.address;
        let (pause_sender, mut pause_receiver) = oneshot::channel();
        let relay_task = tokio::spawn(async move {
            let (mut client, _) = relay_listener
                .accept()
                .await
                .expect("SSH client should reach relay");
            let mut server = TcpStream::connect(ssh_address)
                .await
                .expect("relay should reach SSH server");
            tokio::select! {
                result = copy_bidirectional(&mut client, &mut server) => {
                    panic!("SSH relay stopped before pause: {result:?}");
                }
                result = &mut pause_receiver => {
                    result.expect("test should request relay pause");
                }
            }
            pending::<()>().await;
        });

        let mut ssh_tunnel = tunnel(
            &fixture,
            SshAuthentication::PrivateKeyMaterial(Arc::new(user_key)),
            Some(SshHostKeyRecord {
                algorithm: fixture.host_key.algorithm.clone(),
                fingerprint: fixture.host_key.fingerprint,
            }),
        );
        ssh_tunnel.host = TargetHost::Ip(relay_address.ip());
        ssh_tunnel.port = relay_address.port();
        ssh_tunnel.keep_alive_interval = Duration::from_millis(50);
        ssh_tunnel.keep_alive_max_failures = 1;
        let mut websocket = open_ssh_tunnel_websocket(
            target(format!(
                "ws://target.internal:{}/app",
                target_address.port()
            )),
            ssh_tunnel,
        )
        .await
        .expect("SSH tunnel WebSocket should connect");

        pause_sender
            .send(())
            .expect("SSH relay should still be running");
        let error = timeout(Duration::from_secs(2), websocket.next())
            .await
            .expect("SSH keep-alive should stop the WebSocket")
            .expect("WebSocket stream should report a result")
            .expect_err("silent SSH transport should fail");
        match error {
            WebSocketError::Io(error) => assert_eq!(
                error
                    .get_ref()
                    .and_then(|source| source.downcast_ref::<RemoteTransportFailure>()),
                Some(&RemoteTransportFailure::SshKeepAliveTimedOut)
            ),
            other => panic!("expected typed SSH keep-alive I/O error, got {other:?}"),
        }

        drop(websocket);
        relay_task.abort();
        target_task.abort();
        fixture.task.abort();
    }

    #[tokio::test]
    async fn loads_private_key_from_bounded_temporary_file() {
        let private_key = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519)
            .expect("test private key should be generated");
        let expected_fingerprint = private_key.public_key().fingerprint(HashAlg::Sha256);
        let temporary_file = TempPrivateKeyFile::write(&private_key);

        let loaded = match load_private_key(temporary_file.0.clone(), None).await {
            Ok(loaded) => loaded,
            Err(_) => panic!("temporary private key should load"),
        };
        assert_eq!(
            loaded.public_key().fingerprint(HashAlg::Sha256),
            expected_fingerprint
        );
    }

    #[tokio::test]
    async fn loads_encrypted_private_key_only_with_matching_passphrase() {
        let private_key = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519)
            .expect("test private key should be generated");
        let expected_fingerprint = private_key.public_key().fingerprint(HashAlg::Sha256);
        let encrypted_private_key = private_key
            .encrypt(&mut safe_rng(), TEST_PASSWORD)
            .expect("test private key should encrypt");
        let temporary_file = TempPrivateKeyFile::write(&encrypted_private_key);

        let missing = load_private_key(temporary_file.0.clone(), None).await;
        assert!(matches!(
            missing,
            Err(super::SshConnectFailure::PrivateKeyPassphraseRequired)
        ));

        let wrong = load_private_key(
            temporary_file.0.clone(),
            Some(secret_text("wrong-passphrase")),
        )
        .await;
        assert!(matches!(
            wrong,
            Err(super::SshConnectFailure::PrivateKeyInvalid)
        ));

        let loaded = match load_private_key(
            temporary_file.0.clone(),
            Some(secret_text(TEST_PASSWORD)),
        )
        .await
        {
            Ok(loaded) => loaded,
            Err(_) => panic!("matching passphrase should decrypt the private key"),
        };
        assert_eq!(
            loaded.public_key().fingerprint(HashAlg::Sha256),
            expected_fingerprint
        );
    }

    #[tokio::test]
    async fn authenticates_with_configured_password_without_public_key_fallback() {
        let target_listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test target listener should bind");
        let target_address = target_listener
            .local_addr()
            .expect("test target listener should have an address");
        let user_key = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519)
            .expect("test user key should be generated");
        let public_key_attempts = Arc::new(AtomicUsize::new(0));
        let password_attempts = Arc::new(AtomicUsize::new(0));
        let fixture = spawn_test_ssh_server(
            target_address,
            &user_key,
            Arc::clone(&public_key_attempts),
            Arc::clone(&password_attempts),
            None,
        )
        .await;
        let host_key = SshHostKeyRecord {
            algorithm: fixture.host_key.algorithm.clone(),
            fingerprint: fixture.host_key.fingerprint,
        };
        let tunnel = tunnel(
            &fixture,
            SshAuthentication::Password {
                password: secret_text(TEST_PASSWORD),
            },
            Some(host_key),
        );

        let transport = match open_ssh_tunnel(
            &target(format!(
                "ws://target.internal:{}/app",
                target_address.port()
            )),
            tunnel,
        )
        .await
        {
            Ok(transport) => transport,
            Err(_) => panic!("matching SSH password should authenticate"),
        };
        assert_eq!(password_attempts.load(Ordering::SeqCst), 1);
        assert_eq!(public_key_attempts.load(Ordering::SeqCst), 0);

        drop(transport);
        fixture.task.abort();
    }

    #[tokio::test]
    async fn authenticates_with_an_in_memory_ssh_agent_identity() {
        let user_key = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519)
            .expect("test user key should be generated");
        let public_key_attempts = Arc::new(AtomicUsize::new(0));
        let password_attempts = Arc::new(AtomicUsize::new(0));
        let fixture = spawn_test_ssh_server(
            "127.0.0.1:9".parse().expect("test address should parse"),
            &user_key,
            Arc::clone(&public_key_attempts),
            Arc::clone(&password_attempts),
            None,
        )
        .await;
        let socket = TcpStream::connect(fixture.address)
            .await
            .expect("test SSH client should connect");
        let handler = SshClientHandler {
            host: fixture.address.ip().to_string(),
            port: fixture.address.port(),
            expected_host_key: Some(SshHostKeyRecord {
                algorithm: fixture.host_key.algorithm.clone(),
                fingerprint: fixture.host_key.fingerprint,
            }),
        };
        let mut session =
            russh::client::connect_stream(Arc::new(ssh_client_config()), socket, handler)
                .await
                .expect("test SSH handshake should complete");

        let (agent_client_stream, agent_server_stream) = tokio::io::duplex(256 * 1024);
        let agent_server = tokio::spawn(async move {
            let listener =
                futures_util::stream::iter([Ok::<_, std::io::Error>(agent_server_stream)]);
            russh::keys::agent::server::serve(listener, ()).await
        });
        agent_server
            .await
            .expect("in-memory agent task should join")
            .expect("in-memory agent should start");
        let mut agent = AgentClient::connect(agent_client_stream);
        agent
            .add_identity(&user_key, &[])
            .await
            .expect("test identity should be added to the agent");

        if authenticate_with_agent_client(&mut session, "alice", &mut agent)
            .await
            .is_err()
        {
            panic!("SSH agent identity should authenticate");
        }
        assert_eq!(public_key_attempts.load(Ordering::SeqCst), 1);
        assert_eq!(password_attempts.load(Ordering::SeqCst), 0);

        let _ = session
            .disconnect(russh::Disconnect::ByApplication, "test complete", "")
            .await;
        fixture.task.abort();
    }

    #[tokio::test]
    async fn reports_rejected_configured_password_without_authentication_fallback() {
        let user_key = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519)
            .expect("test user key should be generated");
        let public_key_attempts = Arc::new(AtomicUsize::new(0));
        let password_attempts = Arc::new(AtomicUsize::new(0));
        let fixture = spawn_test_ssh_server(
            "127.0.0.1:9".parse().expect("test address should parse"),
            &user_key,
            Arc::clone(&public_key_attempts),
            Arc::clone(&password_attempts),
            None,
        )
        .await;
        let host_key = SshHostKeyRecord {
            algorithm: fixture.host_key.algorithm.clone(),
            fingerprint: fixture.host_key.fingerprint,
        };
        let tunnel = tunnel(
            &fixture,
            SshAuthentication::Password {
                password: secret_text("wrong-password"),
            },
            Some(host_key),
        );

        let result =
            open_ssh_tunnel(&target("ws://target.internal:8080/app".to_owned()), tunnel).await;
        let error = match result {
            Err(error) => map_ssh_failure(error),
            Ok(_) => panic!("wrong SSH password must be rejected"),
        };
        assert_eq!(error.code, "sshAuthenticationRejected");
        assert_eq!(password_attempts.load(Ordering::SeqCst), 1);
        assert_eq!(public_key_attempts.load(Ordering::SeqCst), 0);
        fixture.task.abort();
    }

    #[tokio::test]
    async fn reports_unknown_host_key_before_authentication() {
        let user_key = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519)
            .expect("user key should be generated");
        let public_key_attempts = Arc::new(AtomicUsize::new(0));
        let password_attempts = Arc::new(AtomicUsize::new(0));
        let fixture = spawn_test_ssh_server(
            "127.0.0.1:9".parse().expect("test address should parse"),
            &user_key,
            Arc::clone(&public_key_attempts),
            Arc::clone(&password_attempts),
            None,
        )
        .await;
        let tunnel = tunnel(
            &fixture,
            SshAuthentication::PrivateKeyMaterial(Arc::new(user_key)),
            None,
        );
        let result =
            open_ssh_tunnel(&target("ws://target.internal:8080/app".to_owned()), tunnel).await;
        let error = match result {
            Err(error) => map_ssh_failure(error),
            Ok(_) => panic!("unknown host key must stop the connection"),
        };
        assert_eq!(error.code, "sshHostKeyUnknown");
        assert!(matches!(
            error.details.as_deref(),
            Some(CommandErrorDetails::SshHostKeyUnknown { port, .. }) if *port == fixture.address.port()
        ));
        assert_eq!(public_key_attempts.load(Ordering::SeqCst), 0);
        assert_eq!(password_attempts.load(Ordering::SeqCst), 0);
        fixture.task.abort();
    }

    #[tokio::test]
    async fn blocks_changed_host_key_before_authentication() {
        let user_key = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519)
            .expect("user key should be generated");
        let public_key_attempts = Arc::new(AtomicUsize::new(0));
        let password_attempts = Arc::new(AtomicUsize::new(0));
        let fixture = spawn_test_ssh_server(
            "127.0.0.1:9".parse().expect("test address should parse"),
            &user_key,
            Arc::clone(&public_key_attempts),
            Arc::clone(&password_attempts),
            None,
        )
        .await;
        let old_key = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519)
            .expect("old host key should be generated");
        let expected = SshHostKeyRecord {
            algorithm: old_key.public_key().algorithm().to_string(),
            fingerprint: old_key.public_key().fingerprint(HashAlg::Sha256),
        };
        let tunnel = tunnel(
            &fixture,
            SshAuthentication::PrivateKeyMaterial(Arc::new(user_key)),
            Some(expected),
        );
        let result =
            open_ssh_tunnel(&target("ws://target.internal:8080/app".to_owned()), tunnel).await;
        let error = match result {
            Err(error) => map_ssh_failure(error),
            Ok(_) => panic!("changed host key must stop the connection"),
        };
        assert_eq!(error.code, "sshHostKeyChanged");
        assert!(matches!(
            error.details.as_deref(),
            Some(CommandErrorDetails::SshHostKeyChanged { expected, received, .. })
                if expected.sha256_fingerprint != received.sha256_fingerprint
        ));
        assert_eq!(public_key_attempts.load(Ordering::SeqCst), 0);
        assert_eq!(password_attempts.load(Ordering::SeqCst), 0);
        fixture.task.abort();
    }

    #[tokio::test]
    async fn opens_direct_tcpip_without_authentication_fallback() {
        let target_listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test target listener should bind");
        let target_address = target_listener
            .local_addr()
            .expect("test target listener should have an address");
        let target_task = tokio::spawn(async move {
            let (stream, _) = target_listener
                .accept()
                .await
                .expect("tunnel should reach target");
            let mut websocket = accept_async(stream)
                .await
                .expect("target WebSocket should accept handshake");
            let message = websocket
                .next()
                .await
                .expect("target should receive a message")
                .expect("target message should be valid");
            assert_eq!(
                message,
                Message::Text(Utf8Bytes::from_static("through ssh"))
            );
            websocket
                .send(message)
                .await
                .expect("target should echo the message");
        });

        let user_key = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519)
            .expect("user key should be generated");
        let user_key_file = TempPrivateKeyFile::write(&user_key);
        let public_key_attempts = Arc::new(AtomicUsize::new(0));
        let password_attempts = Arc::new(AtomicUsize::new(0));
        let (direct_sender, direct_receiver) = oneshot::channel();
        let fixture = spawn_test_ssh_server(
            target_address,
            &user_key,
            Arc::clone(&public_key_attempts),
            Arc::clone(&password_attempts),
            Some(direct_sender),
        )
        .await;
        let host_key = SshHostKeyRecord {
            algorithm: fixture.host_key.algorithm.clone(),
            fingerprint: fixture.host_key.fingerprint,
        };
        let tunnel = tunnel(
            &fixture,
            SshAuthentication::PrivateKey {
                private_key_path: user_key_file.0.clone(),
                passphrase: None,
            },
            Some(host_key),
        );
        let stages = Arc::new(Mutex::new(Vec::new()));
        let captured_stages = Arc::clone(&stages);
        let mut websocket = open_ssh_tunnel_websocket_with_progress(
            target(format!(
                "ws://target.internal:{}/app",
                target_address.port()
            )),
            tunnel,
            Arc::new(move |stage| captured_stages.lock().unwrap().push(stage)),
        )
        .await
        .expect("SSH tunnel WebSocket should connect");
        let server_handle = fixture
            .handle_receiver
            .await
            .expect("test server handle should be available");
        assert_server_channel_prohibited(server_handle.channel_open_session()).await;
        assert_server_channel_prohibited(server_handle.channel_open_agent()).await;
        assert_server_channel_prohibited(server_handle.channel_open_forwarded_tcpip(
            "127.0.0.1",
            9000,
            "127.0.0.1",
            9001,
        ))
        .await;
        assert_server_channel_prohibited(
            server_handle.channel_open_forwarded_streamlocal("/tmp/forbidden-forwarded.sock"),
        )
        .await;
        assert_server_channel_prohibited(server_handle.channel_open_direct_tcpip(
            "127.0.0.1",
            9000,
            "127.0.0.1",
            9001,
        ))
        .await;
        assert_server_channel_prohibited(
            server_handle.channel_open_direct_streamlocal("/tmp/forbidden-direct.sock"),
        )
        .await;
        assert_server_channel_prohibited(server_handle.channel_open_x11("127.0.0.1", 6000)).await;
        websocket
            .send(Message::Text(Utf8Bytes::from_static("through ssh")))
            .await
            .expect("message should cross tunnel");
        assert_eq!(
            websocket
                .next()
                .await
                .expect("echo should arrive")
                .expect("echo should be valid"),
            Message::Text(Utf8Bytes::from_static("through ssh"))
        );

        let request = timeout(Duration::from_secs(2), direct_receiver)
            .await
            .expect("direct-tcpip request should arrive")
            .expect("direct-tcpip request should be captured");
        assert_eq!(request.host, "target.internal");
        assert_eq!(request.port, u32::from(target_address.port()));
        assert_eq!(request.originator_address, "127.0.0.1");
        assert_eq!(request.originator_port, 0);
        assert_eq!(public_key_attempts.load(Ordering::SeqCst), 1);
        assert_eq!(password_attempts.load(Ordering::SeqCst), 0);
        assert_eq!(
            *stages.lock().unwrap(),
            [
                RemoteConnectionStage::ResolvingTarget,
                RemoteConnectionStage::ConnectingProxy,
                RemoteConnectionStage::ProxyAuthentication,
                RemoteConnectionStage::EstablishingTunnel,
                RemoteConnectionStage::WebSocketHandshake,
            ]
        );

        websocket
            .close(None)
            .await
            .expect("test WebSocket should close");
        drop(websocket);
        timeout(Duration::from_secs(2), target_task)
            .await
            .expect("target task should finish")
            .expect("target task should succeed");
        fixture.task.abort();
    }

    #[test]
    fn display_host_does_not_add_ipv6_url_brackets() {
        let host = TargetHost::Ip("2001:db8::1".parse().expect("IPv6 address should parse"));
        assert_eq!(display_host(&host), "2001:db8::1");
    }
}
