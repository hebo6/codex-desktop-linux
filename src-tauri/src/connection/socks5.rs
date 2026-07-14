use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};

#[cfg(test)]
use std::collections::BTreeMap;
#[cfg(test)]
use std::sync::Arc;

use fast_socks5::{
    ReplyError, consts,
    util::target_addr::{TargetAddr, read_address},
};
use serde::Deserialize;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpStream, lookup_host},
    time::timeout,
};
use url::Host;
use zeroize::Zeroizing;

use crate::configuration::SecretText;

use super::remote_websocket::{
    CommandError, ConnectionProgressCallback, RemoteConnectionStage, RemoteWebSocket, TargetHost,
    ValidatedTarget, connect_error, connect_tcp, open_target_websocket_with_progress,
};

#[cfg(test)]
use super::connection_id::ConnectionId;

const MAX_PROXY_HOST_BYTES: usize = 253;
const MAX_CREDENTIAL_BYTES: usize = u8::MAX as usize;
const MIN_PROXY_CONNECT_TIMEOUT_MS: u64 = 1_000;
const MAX_PROXY_CONNECT_TIMEOUT_MS: u64 = 120_000;

#[cfg(test)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConnectSocks5ProxyWebSocketRequest {
    connection_id: String,
    target: Socks5ProxyWebSocketTargetRequest,
    proxy: Socks5ProxyRequest,
}

#[cfg(test)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Socks5ProxyWebSocketTargetRequest {
    url: String,
    insecure_transport_confirmed: bool,
    connect_timeout_ms: u64,
    #[serde(default)]
    non_sensitive_headers: BTreeMap<String, String>,
}

#[cfg(test)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Socks5ProxyRequest {
    host: String,
    port: u16,
    #[serde(default)]
    dns_resolution: Socks5DnsResolution,
    connect_timeout_ms: u64,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum Socks5DnsResolution {
    #[default]
    Proxy,
    Local,
}

#[derive(Debug)]
pub(super) struct ValidatedSocks5Proxy {
    host: TargetHost,
    port: u16,
    dns_resolution: Socks5DnsResolution,
    connect_timeout: Duration,
}

#[cfg(test)]
impl ConnectSocks5ProxyWebSocketRequest {
    fn validate(
        self,
    ) -> Result<(ConnectionId, ValidatedTarget, ValidatedSocks5Proxy), CommandError> {
        let connection_id = ConnectionId::parse(self.connection_id)
            .map_err(|_| CommandError::invalid_connection_id())?;
        let target = ValidatedTarget::parse(
            &self.target.url,
            self.target.insecure_transport_confirmed,
            self.target.connect_timeout_ms,
            &self.target.non_sensitive_headers,
        )?;
        let proxy = self.proxy.validate()?;
        Ok((connection_id, target, proxy))
    }
}

#[cfg(test)]
impl Socks5ProxyRequest {
    fn validate(self) -> Result<ValidatedSocks5Proxy, CommandError> {
        validate_socks5_proxy(
            self.host,
            self.port,
            self.dns_resolution,
            self.connect_timeout_ms,
        )
    }
}

pub(super) fn validate_socks5_proxy(
    host: String,
    port: u16,
    dns_resolution: Socks5DnsResolution,
    connect_timeout_ms: u64,
) -> Result<ValidatedSocks5Proxy, CommandError> {
    if host.is_empty() || host.len() > MAX_PROXY_HOST_BYTES {
        return Err(socks5_error::invalid_host());
    }
    if port == 0 {
        return Err(socks5_error::invalid_port());
    }
    if !(MIN_PROXY_CONNECT_TIMEOUT_MS..=MAX_PROXY_CONNECT_TIMEOUT_MS).contains(&connect_timeout_ms)
    {
        return Err(socks5_error::invalid_timeout());
    }

    let host = parse_proxy_host(&host)?;
    Ok(ValidatedSocks5Proxy {
        host,
        port,
        dns_resolution,
        connect_timeout: Duration::from_millis(connect_timeout_ms),
    })
}

fn parse_proxy_host(value: &str) -> Result<TargetHost, CommandError> {
    if let Ok(address) = value.parse::<IpAddr>() {
        return Ok(TargetHost::Ip(address));
    }

    match Host::parse(value).map_err(|_| socks5_error::invalid_host())? {
        Host::Domain(domain) if !domain.is_empty() && domain.len() <= MAX_PROXY_HOST_BYTES => {
            Ok(TargetHost::Domain(domain))
        }
        Host::Ipv4(address) => Ok(TargetHost::Ip(address.into())),
        Host::Ipv6(address) => Ok(TargetHost::Ip(address.into())),
        Host::Domain(_) => Err(socks5_error::invalid_host()),
    }
}

// 用户名和密码只能由 Rust 凭据层构造，WebView 命令固定使用无认证
#[cfg_attr(not(test), allow(dead_code))]
pub(super) enum Socks5ProxyAuthentication {
    None,
    UsernamePassword {
        username: String,
        password: SecretText,
    },
}

impl Socks5ProxyAuthentication {
    fn method(&self) -> Result<u8, Socks5ConnectFailure> {
        match self {
            Self::None => Ok(consts::SOCKS5_AUTH_METHOD_NONE),
            Self::UsernamePassword { username, password }
                if !username.trim().is_empty()
                    && username.len() <= MAX_CREDENTIAL_BYTES
                    && !username.chars().any(char::is_control)
                    && !password.as_bytes().is_empty()
                    && password.as_bytes().len() <= MAX_CREDENTIAL_BYTES
                    && !password.as_str().contains('\0') =>
            {
                Ok(consts::SOCKS5_AUTH_METHOD_PASSWORD)
            }
            Self::UsernamePassword { .. } => Err(Socks5ConnectFailure::InvalidAuthentication),
        }
    }
}

#[cfg(test)]
pub(super) async fn open_socks5_proxy_websocket(
    target: ValidatedTarget,
    proxy: ValidatedSocks5Proxy,
    authentication: Socks5ProxyAuthentication,
) -> Result<RemoteWebSocket, CommandError> {
    open_socks5_proxy_websocket_with_progress(target, proxy, authentication, Arc::new(|_| {})).await
}

pub(super) async fn open_socks5_proxy_websocket_with_progress(
    target: ValidatedTarget,
    proxy: ValidatedSocks5Proxy,
    authentication: Socks5ProxyAuthentication,
    progress: ConnectionProgressCallback,
) -> Result<RemoteWebSocket, CommandError> {
    let proxy_timeout = proxy.connect_timeout;
    let tunnel = match timeout(
        proxy_timeout,
        open_socks5_tunnel_with_progress(&target, proxy, authentication, &progress),
    )
    .await
    {
        Ok(Ok(tunnel)) => tunnel,
        Ok(Err(error)) => return Err(map_socks5_failure(error)),
        Err(_) => return Err(socks5_error::timed_out()),
    };

    match timeout(
        target.connect_timeout,
        open_target_websocket_with_progress(target, Box::new(tunnel), &progress),
    )
    .await
    {
        Ok(Ok(websocket)) => Ok(websocket),
        Ok(Err(error)) => Err(connect_error(error)),
        Err(_) => Err(CommandError::connect_timed_out()),
    }
}

#[cfg(test)]
async fn open_socks5_tunnel(
    target: &ValidatedTarget,
    proxy: ValidatedSocks5Proxy,
    authentication: Socks5ProxyAuthentication,
) -> Result<TcpStream, Socks5ConnectFailure> {
    let progress: ConnectionProgressCallback = Arc::new(|_| {});
    open_socks5_tunnel_with_progress(target, proxy, authentication, &progress).await
}

async fn open_socks5_tunnel_with_progress(
    target: &ValidatedTarget,
    proxy: ValidatedSocks5Proxy,
    authentication: Socks5ProxyAuthentication,
    progress: &ConnectionProgressCallback,
) -> Result<TcpStream, Socks5ConnectFailure> {
    authentication.method()?;
    progress(RemoteConnectionStage::ResolvingTarget);
    let target_address = socks5_target_address(target, proxy.dns_resolution).await?;
    progress(RemoteConnectionStage::ConnectingProxy);
    let mut stream = connect_tcp(&proxy.host, proxy.port)
        .await
        .map_err(|_| Socks5ConnectFailure::ProxyNetwork)?;
    stream
        .set_nodelay(true)
        .map_err(|_| Socks5ConnectFailure::ProxyNetwork)?;

    progress(RemoteConnectionStage::ProxyAuthentication);
    negotiate_authentication(&mut stream, &authentication).await?;
    progress(RemoteConnectionStage::EstablishingTunnel);
    send_connect_request(&mut stream, target_address).await?;
    Ok(stream)
}

async fn socks5_target_address(
    target: &ValidatedTarget,
    dns_resolution: Socks5DnsResolution,
) -> Result<TargetAddr, Socks5ConnectFailure> {
    match &target.host {
        TargetHost::Ip(address) => Ok(TargetAddr::Ip(SocketAddr::new(*address, target.port))),
        TargetHost::Domain(domain) if dns_resolution == Socks5DnsResolution::Proxy => {
            if domain.len() > u8::MAX as usize {
                return Err(Socks5ConnectFailure::InvalidTargetAddress);
            }
            Ok(TargetAddr::Domain(domain.clone(), target.port))
        }
        TargetHost::Domain(domain) => lookup_host((domain.as_str(), target.port))
            .await
            .map_err(|_| Socks5ConnectFailure::LocalDns)?
            .next()
            .map(TargetAddr::Ip)
            .ok_or(Socks5ConnectFailure::LocalDns),
    }
}

async fn negotiate_authentication(
    stream: &mut TcpStream,
    authentication: &Socks5ProxyAuthentication,
) -> Result<(), Socks5ConnectFailure> {
    let method = authentication.method()?;
    stream
        .write_all(&[consts::SOCKS5_VERSION, 1, method])
        .await
        .map_err(|_| Socks5ConnectFailure::Protocol)?;

    let mut selection = [0_u8; 2];
    stream
        .read_exact(&mut selection)
        .await
        .map_err(|_| Socks5ConnectFailure::Protocol)?;
    if selection[0] != consts::SOCKS5_VERSION {
        return Err(Socks5ConnectFailure::Protocol);
    }
    if selection[1] != method {
        return Err(Socks5ConnectFailure::Authentication);
    }

    let Socks5ProxyAuthentication::UsernamePassword { username, password } = authentication else {
        return Ok(());
    };
    let username_length =
        u8::try_from(username.len()).map_err(|_| Socks5ConnectFailure::InvalidAuthentication)?;
    let password_length = u8::try_from(password.as_bytes().len())
        .map_err(|_| Socks5ConnectFailure::InvalidAuthentication)?;
    let mut packet = Zeroizing::new(Vec::with_capacity(
        3 + username.len() + password.as_bytes().len(),
    ));
    packet.extend_from_slice(&[1, username_length]);
    packet.extend_from_slice(username.as_bytes());
    packet.push(password_length);
    packet.extend_from_slice(password.as_bytes());
    stream
        .write_all(packet.as_slice())
        .await
        .map_err(|_| Socks5ConnectFailure::Protocol)?;

    let mut response = [0_u8; 2];
    stream
        .read_exact(&mut response)
        .await
        .map_err(|_| Socks5ConnectFailure::Protocol)?;
    if response[0] != 1 {
        return Err(Socks5ConnectFailure::Protocol);
    }
    if response[1] != 0 {
        return Err(Socks5ConnectFailure::Authentication);
    }
    Ok(())
}

async fn send_connect_request(
    stream: &mut TcpStream,
    target_address: TargetAddr,
) -> Result<(), Socks5ConnectFailure> {
    let encoded_address = target_address
        .to_be_bytes()
        .map_err(|_| Socks5ConnectFailure::InvalidTargetAddress)?;
    let mut request = Vec::with_capacity(3 + encoded_address.len());
    request.extend_from_slice(&[consts::SOCKS5_VERSION, consts::SOCKS5_CMD_TCP_CONNECT, 0]);
    request.extend_from_slice(&encoded_address);
    stream
        .write_all(&request)
        .await
        .map_err(|_| Socks5ConnectFailure::Protocol)?;

    let mut response = [0_u8; 4];
    stream
        .read_exact(&mut response)
        .await
        .map_err(|_| Socks5ConnectFailure::Protocol)?;
    if response[0] != consts::SOCKS5_VERSION || response[2] != 0 {
        return Err(Socks5ConnectFailure::Protocol);
    }
    if response[1] != consts::SOCKS5_REPLY_SUCCEEDED {
        let reply = match response[1] {
            consts::SOCKS5_REPLY_GENERAL_FAILURE
            | consts::SOCKS5_REPLY_CONNECTION_NOT_ALLOWED
            | consts::SOCKS5_REPLY_NETWORK_UNREACHABLE
            | consts::SOCKS5_REPLY_HOST_UNREACHABLE
            | consts::SOCKS5_REPLY_CONNECTION_REFUSED
            | consts::SOCKS5_REPLY_TTL_EXPIRED
            | consts::SOCKS5_REPLY_COMMAND_NOT_SUPPORTED
            | consts::SOCKS5_REPLY_ADDRESS_TYPE_NOT_SUPPORTED => ReplyError::from_u8(response[1]),
            _ => return Err(Socks5ConnectFailure::Protocol),
        };
        return Err(Socks5ConnectFailure::Reply(reply));
    }

    read_address(stream, response[3])
        .await
        .map_err(|_| Socks5ConnectFailure::Protocol)?;
    Ok(())
}

#[derive(Debug)]
enum Socks5ConnectFailure {
    InvalidAuthentication,
    InvalidTargetAddress,
    LocalDns,
    ProxyNetwork,
    Authentication,
    Protocol,
    Reply(ReplyError),
}

fn map_socks5_failure(error: Socks5ConnectFailure) -> CommandError {
    match error {
        Socks5ConnectFailure::InvalidAuthentication => socks5_error::invalid_authentication(),
        Socks5ConnectFailure::InvalidTargetAddress => socks5_error::invalid_target_address(),
        Socks5ConnectFailure::LocalDns => socks5_error::local_dns_failed(),
        Socks5ConnectFailure::ProxyNetwork => socks5_error::network_failed(),
        Socks5ConnectFailure::Authentication => socks5_error::authentication_failed(),
        Socks5ConnectFailure::Protocol => socks5_error::protocol_failed(),
        Socks5ConnectFailure::Reply(ReplyError::Succeeded) => socks5_error::protocol_failed(),
        Socks5ConnectFailure::Reply(ReplyError::GeneralFailure) => socks5_error::connect_failed(),
        Socks5ConnectFailure::Reply(ReplyError::ConnectionNotAllowed) => {
            socks5_error::connection_not_allowed()
        }
        Socks5ConnectFailure::Reply(ReplyError::NetworkUnreachable) => {
            socks5_error::network_unreachable()
        }
        Socks5ConnectFailure::Reply(ReplyError::HostUnreachable) => {
            socks5_error::host_unreachable()
        }
        Socks5ConnectFailure::Reply(ReplyError::ConnectionRefused) => {
            socks5_error::connection_refused()
        }
        Socks5ConnectFailure::Reply(ReplyError::ConnectionTimeout) => {
            socks5_error::target_timed_out()
        }
        Socks5ConnectFailure::Reply(ReplyError::TtlExpired) => socks5_error::ttl_expired(),
        Socks5ConnectFailure::Reply(ReplyError::CommandNotSupported) => {
            socks5_error::command_not_supported()
        }
        Socks5ConnectFailure::Reply(ReplyError::AddressTypeNotSupported) => {
            socks5_error::address_type_not_supported()
        }
    }
}

mod socks5_error {
    use super::CommandError;

    pub(super) const fn invalid_host() -> CommandError {
        CommandError::new("invalidSocks5ProxyHost", "The SOCKS5 proxy host is invalid")
    }

    pub(super) const fn invalid_port() -> CommandError {
        CommandError::new("invalidSocks5ProxyPort", "The SOCKS5 proxy port is invalid")
    }

    pub(super) const fn invalid_timeout() -> CommandError {
        CommandError::new(
            "invalidSocks5ProxyConnectTimeout",
            "The SOCKS5 proxy connection timeout is invalid",
        )
    }

    pub(super) const fn invalid_authentication() -> CommandError {
        CommandError::new(
            "invalidSocks5ProxyAuthentication",
            "The SOCKS5 proxy authentication configuration is invalid",
        )
    }

    pub(super) const fn invalid_target_address() -> CommandError {
        CommandError::new(
            "invalidSocks5TargetAddress",
            "The SOCKS5 target address is invalid",
        )
    }

    pub(super) const fn timed_out() -> CommandError {
        CommandError::new(
            "socks5ProxyConnectTimedOut",
            "The SOCKS5 proxy connection timed out",
        )
    }

    pub(super) const fn local_dns_failed() -> CommandError {
        CommandError::new(
            "socks5LocalDnsResolutionFailed",
            "The SOCKS5 target could not be resolved locally",
        )
    }

    pub(super) const fn network_failed() -> CommandError {
        CommandError::new(
            "socks5ProxyNetworkConnectFailed",
            "The SOCKS5 proxy network connection could not be established",
        )
    }

    pub(super) const fn authentication_failed() -> CommandError {
        CommandError::new(
            "socks5ProxyAuthenticationFailed",
            "The SOCKS5 proxy rejected the configured authentication method",
        )
    }

    pub(super) const fn protocol_failed() -> CommandError {
        CommandError::new(
            "socks5ProxyProtocolFailed",
            "The SOCKS5 proxy returned an invalid response",
        )
    }

    pub(super) const fn connect_failed() -> CommandError {
        CommandError::new(
            "socks5ConnectFailed",
            "The SOCKS5 proxy could not establish the target connection",
        )
    }

    pub(super) const fn connection_not_allowed() -> CommandError {
        CommandError::new(
            "socks5ConnectionNotAllowed",
            "The SOCKS5 proxy rules do not allow the target connection",
        )
    }

    pub(super) const fn network_unreachable() -> CommandError {
        CommandError::new(
            "socks5NetworkUnreachable",
            "The target network is unreachable through the SOCKS5 proxy",
        )
    }

    pub(super) const fn host_unreachable() -> CommandError {
        CommandError::new(
            "socks5HostUnreachable",
            "The target host is unreachable through the SOCKS5 proxy",
        )
    }

    pub(super) const fn connection_refused() -> CommandError {
        CommandError::new(
            "socks5ConnectionRefused",
            "The target connection was refused through the SOCKS5 proxy",
        )
    }

    pub(super) const fn target_timed_out() -> CommandError {
        CommandError::new(
            "socks5TargetConnectTimedOut",
            "The SOCKS5 target connection timed out",
        )
    }

    pub(super) const fn ttl_expired() -> CommandError {
        CommandError::new(
            "socks5TtlExpired",
            "The SOCKS5 target connection TTL expired",
        )
    }

    pub(super) const fn command_not_supported() -> CommandError {
        CommandError::new(
            "socks5CommandNotSupported",
            "The SOCKS5 proxy does not support TCP CONNECT",
        )
    }

    pub(super) const fn address_type_not_supported() -> CommandError {
        CommandError::new(
            "socks5AddressTypeNotSupported",
            "The SOCKS5 proxy does not support the target address type",
        )
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeMap,
        io::ErrorKind,
        net::SocketAddr,
        sync::{Arc, Mutex},
        time::Duration,
    };

    use fast_socks5::{ReplyError, consts, util::target_addr::TargetAddr};
    use futures_util::{SinkExt, StreamExt};
    use serde_json::json;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt, copy_bidirectional},
        net::{TcpListener, TcpStream},
        task::JoinHandle,
        time::timeout,
    };
    use tokio_tungstenite::{
        accept_async,
        tungstenite::{Message, Utf8Bytes},
    };

    use super::{
        ConnectSocks5ProxyWebSocketRequest, Socks5ConnectFailure, Socks5DnsResolution,
        Socks5ProxyAuthentication, Socks5ProxyRequest, Socks5ProxyWebSocketTargetRequest,
        ValidatedSocks5Proxy, map_socks5_failure, open_socks5_proxy_websocket,
        open_socks5_proxy_websocket_with_progress, open_socks5_tunnel,
    };
    use crate::{
        configuration::SecretText,
        connection::remote_websocket::{
            CommandError, RemoteConnectionStage, TargetHost, ValidatedTarget,
        },
    };

    fn secret_text(value: &str) -> SecretText {
        serde_json::from_value(serde_json::Value::String(value.to_owned())).unwrap()
    }

    fn validated_target(url: &str) -> ValidatedTarget {
        ValidatedTarget::parse(url, true, 5_000, &BTreeMap::new()).unwrap()
    }

    fn validated_proxy(
        address: SocketAddr,
        dns_resolution: Socks5DnsResolution,
        connect_timeout: Duration,
    ) -> ValidatedSocks5Proxy {
        ValidatedSocks5Proxy {
            host: TargetHost::Ip(address.ip()),
            port: address.port(),
            dns_resolution,
            connect_timeout,
        }
    }

    fn request(
        target_url: &str,
        proxy_host: &str,
        proxy_port: u16,
    ) -> ConnectSocks5ProxyWebSocketRequest {
        ConnectSocks5ProxyWebSocketRequest {
            connection_id: "remote".to_owned(),
            target: Socks5ProxyWebSocketTargetRequest {
                url: target_url.to_owned(),
                insecure_transport_confirmed: true,
                connect_timeout_ms: 5_000,
                non_sensitive_headers: BTreeMap::new(),
            },
            proxy: Socks5ProxyRequest {
                host: proxy_host.to_owned(),
                port: proxy_port,
                dns_resolution: Socks5DnsResolution::Proxy,
                connect_timeout_ms: 5_000,
            },
        }
    }

    async fn read_greeting(stream: &mut TcpStream, expected_method: u8) {
        let mut greeting = [0_u8; 3];
        stream.read_exact(&mut greeting).await.unwrap();
        assert_eq!(greeting, [consts::SOCKS5_VERSION, 1, expected_method]);
    }

    async fn read_target(stream: &mut TcpStream) -> TargetAddr {
        let mut header = [0_u8; 4];
        stream.read_exact(&mut header).await.unwrap();
        assert_eq!(
            header[..3],
            [consts::SOCKS5_VERSION, consts::SOCKS5_CMD_TCP_CONNECT, 0,]
        );
        fast_socks5::util::target_addr::read_address(stream, header[3])
            .await
            .unwrap()
    }

    async fn spawn_websocket_target() -> (SocketAddr, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut websocket = accept_async(stream).await.unwrap();
            let message = websocket.next().await.unwrap().unwrap();
            assert_eq!(message, Message::Text(Utf8Bytes::from_static("{\"id\":1}")));
            websocket.send(message).await.unwrap();
            assert!(matches!(
                websocket.next().await,
                Some(Ok(Message::Close(_)))
            ));
            websocket.flush().await.unwrap();
        });
        (address, task)
    }

    async fn spawn_no_auth_proxy(
        upstream_address: Option<SocketAddr>,
        reply: u8,
    ) -> (SocketAddr, JoinHandle<TargetAddr>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut client, _) = listener.accept().await.unwrap();
            read_greeting(&mut client, consts::SOCKS5_AUTH_METHOD_NONE).await;
            client
                .write_all(&[consts::SOCKS5_VERSION, consts::SOCKS5_AUTH_METHOD_NONE])
                .await
                .unwrap();
            let target = read_target(&mut client).await;
            client
                .write_all(&[
                    consts::SOCKS5_VERSION,
                    reply,
                    0,
                    consts::SOCKS5_ADDR_TYPE_IPV4,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                ])
                .await
                .unwrap();
            if reply == consts::SOCKS5_REPLY_SUCCEEDED {
                let mut upstream = TcpStream::connect(upstream_address.unwrap()).await.unwrap();
                if let Err(error) = copy_bidirectional(&mut client, &mut upstream).await {
                    assert!(
                        matches!(
                            error.kind(),
                            ErrorKind::BrokenPipe
                                | ErrorKind::ConnectionReset
                                | ErrorKind::UnexpectedEof
                        ),
                        "unexpected SOCKS5 tunnel copy failure: {error}"
                    );
                }
            }
            target
        });
        (address, task)
    }

    #[test]
    fn validates_proxy_fields_and_keeps_credentials_out_of_ipc() {
        let (_, _, proxy) = request("ws://target.example.test/app", "proxy.example.test", 1080)
            .validate()
            .unwrap();
        assert_eq!(proxy.dns_resolution, Socks5DnsResolution::Proxy);

        let invalid_host = request("ws://target.example.test/app", "socks5://proxy", 1080);
        assert_eq!(
            invalid_host.validate().unwrap_err(),
            CommandError::new("invalidSocks5ProxyHost", "The SOCKS5 proxy host is invalid")
        );

        let mut invalid_port = request("ws://target.example.test/app", "proxy.example.test", 1080);
        invalid_port.proxy.port = 0;
        assert_eq!(
            invalid_port.validate().unwrap_err().code,
            "invalidSocks5ProxyPort"
        );

        let mut invalid_timeout =
            request("ws://target.example.test/app", "proxy.example.test", 1080);
        invalid_timeout.proxy.connect_timeout_ms = 999;
        assert_eq!(
            invalid_timeout.validate().unwrap_err().code,
            "invalidSocks5ProxyConnectTimeout"
        );

        let serialized = json!({
            "connectionId": "remote",
            "target": {
                "url": "ws://target.example.test/app",
                "insecureTransportConfirmed": true,
                "connectTimeoutMs": 5000
            },
            "proxy": {
                "host": "proxy.example.test",
                "port": 1080,
                "connectTimeoutMs": 5000,
                "username": "must-stay-in-rust",
                "password": "must-stay-in-rust"
            }
        });
        assert!(serde_json::from_value::<ConnectSocks5ProxyWebSocketRequest>(serialized).is_err());
    }

    #[tokio::test]
    async fn uses_proxy_dns_by_default_and_local_dns_only_when_selected() {
        for (host, dns_resolution, expects_domain) in [
            ("remote.invalid", Socks5DnsResolution::Proxy, true),
            ("localhost", Socks5DnsResolution::Local, false),
        ] {
            let (target_address, target_task) = spawn_websocket_target().await;
            let (proxy_address, proxy_task) =
                spawn_no_auth_proxy(Some(target_address), consts::SOCKS5_REPLY_SUCCEEDED).await;
            let target =
                validated_target(&format!("ws://{host}:{}/app-server", target_address.port()));
            let proxy = validated_proxy(proxy_address, dns_resolution, Duration::from_secs(5));

            let stages = Arc::new(Mutex::new(Vec::new()));
            let captured_stages = Arc::clone(&stages);
            let mut websocket = open_socks5_proxy_websocket_with_progress(
                target,
                proxy,
                Socks5ProxyAuthentication::None,
                Arc::new(move |stage| captured_stages.lock().unwrap().push(stage)),
            )
            .await
            .unwrap();
            websocket
                .send(Message::Text(Utf8Bytes::from_static("{\"id\":1}")))
                .await
                .unwrap();
            assert_eq!(
                websocket.next().await.unwrap().unwrap(),
                Message::Text(Utf8Bytes::from_static("{\"id\":1}"))
            );
            websocket.close(None).await.unwrap();
            drop(websocket);

            let observed_target = proxy_task.await.unwrap();
            target_task.await.unwrap();
            assert_eq!(observed_target.is_domain(), expects_domain);
            assert_eq!(
                observed_target.into_string_and_port().1,
                target_address.port()
            );
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
        }
    }

    #[tokio::test]
    async fn encodes_ipv4_ipv6_and_domain_targets() {
        let cases = [
            ("ws://127.0.0.1:41001/app", 1_u8),
            ("ws://[::1]:41002/app", 4_u8),
            ("ws://target.example.test:41003/app", 3_u8),
        ];

        for (url, expected_address_type) in cases {
            let (proxy_address, proxy_task) =
                spawn_no_auth_proxy(None, consts::SOCKS5_REPLY_CONNECTION_REFUSED).await;
            let result = open_socks5_tunnel(
                &validated_target(url),
                validated_proxy(
                    proxy_address,
                    Socks5DnsResolution::Proxy,
                    Duration::from_secs(5),
                ),
                Socks5ProxyAuthentication::None,
            )
            .await;
            assert_eq!(
                map_socks5_failure(result.unwrap_err()).code,
                "socks5ConnectionRefused"
            );
            let target = proxy_task.await.unwrap();
            let address_type = match target {
                TargetAddr::Ip(SocketAddr::V4(_)) => 1,
                TargetAddr::Ip(SocketAddr::V6(_)) => 4,
                TargetAddr::Domain(_, _) => 3,
            };
            assert_eq!(address_type, expected_address_type);
        }
    }

    #[tokio::test]
    async fn enforces_rfc1929_without_no_auth_downgrade() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_address = listener.local_addr().unwrap();
        let proxy_task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_greeting(&mut stream, consts::SOCKS5_AUTH_METHOD_PASSWORD).await;
            stream
                .write_all(&[consts::SOCKS5_VERSION, consts::SOCKS5_AUTH_METHOD_PASSWORD])
                .await
                .unwrap();

            let mut auth_header = [0_u8; 2];
            stream.read_exact(&mut auth_header).await.unwrap();
            assert_eq!(auth_header[0], 1);
            let mut username = vec![0_u8; auth_header[1] as usize];
            stream.read_exact(&mut username).await.unwrap();
            let password_length = stream.read_u8().await.unwrap();
            let mut password = vec![0_u8; password_length as usize];
            stream.read_exact(&mut password).await.unwrap();
            assert_eq!(username, b"proxy-user");
            assert_eq!(password, b"proxy-password");
            stream.write_all(&[1, 0]).await.unwrap();

            assert!(matches!(
                read_target(&mut stream).await,
                TargetAddr::Domain(_, 443)
            ));
            stream
                .write_all(&[
                    consts::SOCKS5_VERSION,
                    consts::SOCKS5_REPLY_SUCCEEDED,
                    0,
                    consts::SOCKS5_ADDR_TYPE_IPV4,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                ])
                .await
                .unwrap();
            assert_eq!(
                stream.read_u8().await.unwrap_err().kind(),
                std::io::ErrorKind::UnexpectedEof
            );
        });

        let tunnel = open_socks5_tunnel(
            &validated_target("wss://target.example.test/app"),
            validated_proxy(
                proxy_address,
                Socks5DnsResolution::Proxy,
                Duration::from_secs(5),
            ),
            Socks5ProxyAuthentication::UsernamePassword {
                username: "proxy-user".to_owned(),
                password: secret_text("proxy-password"),
            },
        )
        .await
        .unwrap();
        drop(tunnel);
        proxy_task.await.unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_address = listener.local_addr().unwrap();
        let downgrade_task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_greeting(&mut stream, consts::SOCKS5_AUTH_METHOD_PASSWORD).await;
            stream
                .write_all(&[consts::SOCKS5_VERSION, consts::SOCKS5_AUTH_METHOD_NONE])
                .await
                .unwrap();
            assert_eq!(
                stream.read_u8().await.unwrap_err().kind(),
                std::io::ErrorKind::UnexpectedEof
            );
        });
        let result = open_socks5_tunnel(
            &validated_target("wss://target.example.test/app"),
            validated_proxy(
                proxy_address,
                Socks5DnsResolution::Proxy,
                Duration::from_secs(5),
            ),
            Socks5ProxyAuthentication::UsernamePassword {
                username: "proxy-user".to_owned(),
                password: secret_text("proxy-password"),
            },
        )
        .await;
        assert_eq!(
            map_socks5_failure(result.unwrap_err()).code,
            "socks5ProxyAuthenticationFailed"
        );
        downgrade_task.await.unwrap();
    }

    #[tokio::test]
    async fn rejects_invalid_rfc1929_lengths_before_network_access() {
        for authentication in [
            Socks5ProxyAuthentication::UsernamePassword {
                username: String::new(),
                password: secret_text("password"),
            },
            Socks5ProxyAuthentication::UsernamePassword {
                username: "é".repeat(128),
                password: secret_text("password"),
            },
            Socks5ProxyAuthentication::UsernamePassword {
                username: "user".to_owned(),
                password: secret_text(&"x".repeat(256)),
            },
        ] {
            let result = open_socks5_tunnel(
                &validated_target("wss://target.example.test/app"),
                validated_proxy(
                    "127.0.0.1:9".parse().unwrap(),
                    Socks5DnsResolution::Proxy,
                    Duration::from_secs(5),
                ),
                authentication,
            )
            .await;
            assert_eq!(
                map_socks5_failure(result.unwrap_err()).code,
                "invalidSocks5ProxyAuthentication"
            );
        }
    }

    #[test]
    fn maps_standard_reply_codes_to_distinct_errors() {
        let cases = [
            (ReplyError::GeneralFailure, "socks5ConnectFailed"),
            (
                ReplyError::ConnectionNotAllowed,
                "socks5ConnectionNotAllowed",
            ),
            (ReplyError::NetworkUnreachable, "socks5NetworkUnreachable"),
            (ReplyError::HostUnreachable, "socks5HostUnreachable"),
            (ReplyError::ConnectionRefused, "socks5ConnectionRefused"),
            (ReplyError::TtlExpired, "socks5TtlExpired"),
            (ReplyError::CommandNotSupported, "socks5CommandNotSupported"),
            (
                ReplyError::AddressTypeNotSupported,
                "socks5AddressTypeNotSupported",
            ),
        ];
        for (reply, expected_code) in cases {
            assert_eq!(
                map_socks5_failure(Socks5ConnectFailure::Reply(reply)).code,
                expected_code
            );
        }
    }

    #[tokio::test]
    async fn treats_unknown_reply_as_protocol_failure_without_panicking() {
        let (proxy_address, proxy_task) = spawn_no_auth_proxy(None, 9).await;
        let result = open_socks5_tunnel(
            &validated_target("wss://target.example.test/app"),
            validated_proxy(
                proxy_address,
                Socks5DnsResolution::Proxy,
                Duration::from_secs(5),
            ),
            Socks5ProxyAuthentication::None,
        )
        .await;
        assert_eq!(
            map_socks5_failure(result.unwrap_err()).code,
            "socks5ProxyProtocolFailed"
        );
        proxy_task.await.unwrap();
    }

    #[tokio::test]
    async fn timeout_drops_the_proxy_socket_and_never_connects_directly() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_address = listener.local_addr().unwrap();
        let timeout_task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_greeting(&mut stream, consts::SOCKS5_AUTH_METHOD_NONE).await;
            let mut byte = [0_u8; 1];
            assert_eq!(stream.read(&mut byte).await.unwrap(), 0);
        });
        let error = match open_socks5_proxy_websocket(
            validated_target("ws://target.example.test:41004/app"),
            validated_proxy(
                proxy_address,
                Socks5DnsResolution::Proxy,
                Duration::from_millis(50),
            ),
            Socks5ProxyAuthentication::None,
        )
        .await
        {
            Err(error) => error,
            Ok(_) => panic!("a stalled SOCKS5 proxy must time out"),
        };
        assert_eq!(error.code, "socks5ProxyConnectTimedOut");
        timeout(Duration::from_secs(1), timeout_task)
            .await
            .unwrap()
            .unwrap();

        let target_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_address = target_listener.local_addr().unwrap();
        let (proxy_address, proxy_task) =
            spawn_no_auth_proxy(None, consts::SOCKS5_REPLY_CONNECTION_REFUSED).await;
        let error = match open_socks5_proxy_websocket(
            validated_target(&format!("ws://{target_address}/app")),
            validated_proxy(
                proxy_address,
                Socks5DnsResolution::Proxy,
                Duration::from_secs(5),
            ),
            Socks5ProxyAuthentication::None,
        )
        .await
        {
            Err(error) => error,
            Ok(_) => panic!("a rejected SOCKS5 tunnel must not connect directly"),
        };
        assert_eq!(error.code, "socks5ConnectionRefused");
        proxy_task.await.unwrap();
        assert!(
            timeout(Duration::from_millis(100), target_listener.accept())
                .await
                .is_err()
        );
    }
}
