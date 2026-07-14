use std::{
    collections::{BTreeMap, BTreeSet},
    io,
    pin::Pin,
    sync::Arc,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    task::{Context, Poll},
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use http_body_util::Empty;
use hyper::{
    Method, Request,
    body::Bytes,
    client::conn::http1,
    header::{HOST, HeaderName, HeaderValue, PROXY_AUTHORIZATION},
    http::uri::Authority,
};
use hyper_util::rt::TokioIo;
use rustls::ClientConfig;
#[cfg(test)]
use serde::Deserialize;
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    task::JoinHandle,
    time::timeout,
};
use url::{Host, Url};
use zeroize::Zeroizing;

use crate::{
    authentication_policy::is_valid_bearer_token,
    configuration::{SecretText, TlsCertificatePolicy},
    header_policy::is_reserved_http_connect_header,
    sensitive::looks_sensitive_identifier,
};

use super::remote_websocket::{
    BoxedRemoteTransport, CommandError, ConnectionProgressCallback, RemoteConnectionStage,
    RemoteWebSocket, TargetHost, TargetScheme, ValidatedTarget, connect_error, connect_tcp,
    connect_tls, open_target_websocket_with_progress, tls_config_for_policy,
};

#[cfg(test)]
use super::connection_id::ConnectionId;

#[cfg(test)]
use super::remote_websocket::{open_target_websocket, open_target_websocket_with_config};

const MAX_PROXY_URL_BYTES: usize = 4 * 1024;
const MAX_PROXY_HEADER_COUNT: usize = 32;
const MAX_PROXY_HEADER_NAME_BYTES: usize = 128;
const MAX_PROXY_HEADER_VALUE_BYTES: usize = 8 * 1024;
const MAX_PROXY_RESPONSE_HEADERS: usize = 64;
const MAX_PROXY_RESPONSE_HEAD_BYTES: usize = 64 * 1024;
const MAX_PROXY_USERNAME_BYTES: usize = u8::MAX as usize;
const MAX_HTTP_BASIC_PASSWORD_BYTES: usize = 5_882;
const MAX_HTTP_BEARER_TOKEN_BYTES: usize = 8_185;
const MIN_PROXY_CONNECT_TIMEOUT_MS: u64 = 1_000;
const MAX_PROXY_CONNECT_TIMEOUT_MS: u64 = 120_000;

#[cfg(test)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConnectHttpProxyWebSocketRequest {
    connection_id: String,
    target: HttpProxyWebSocketTargetRequest,
    proxy: HttpConnectProxyRequest,
}

#[cfg(test)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HttpProxyWebSocketTargetRequest {
    url: String,
    insecure_transport_confirmed: bool,
    connect_timeout_ms: u64,
    #[serde(default)]
    non_sensitive_headers: BTreeMap<String, String>,
}

#[cfg(test)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HttpConnectProxyRequest {
    url: String,
    connect_timeout_ms: u64,
    #[serde(default)]
    non_sensitive_headers: BTreeMap<String, String>,
}

#[derive(Debug)]
pub(super) struct ValidatedHttpConnectProxy {
    scheme: TargetScheme,
    host: TargetHost,
    port: u16,
    connect_timeout: Duration,
    headers: Vec<(HeaderName, HeaderValue)>,
    tls_certificate_policy: TlsCertificatePolicy,
}

#[cfg(test)]
impl ConnectHttpProxyWebSocketRequest {
    fn validate(
        self,
    ) -> Result<(ConnectionId, ValidatedTarget, ValidatedHttpConnectProxy), CommandError> {
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
impl HttpConnectProxyRequest {
    fn validate(self) -> Result<ValidatedHttpConnectProxy, CommandError> {
        validate_http_connect_proxy(
            self.url,
            self.connect_timeout_ms,
            self.non_sensitive_headers,
            TlsCertificatePolicy::Strict,
        )
    }
}

pub(super) fn validate_http_connect_proxy(
    url: String,
    connect_timeout_ms: u64,
    non_sensitive_headers: BTreeMap<String, String>,
    tls_certificate_policy: TlsCertificatePolicy,
) -> Result<ValidatedHttpConnectProxy, CommandError> {
    if url.is_empty() || url.len() > MAX_PROXY_URL_BYTES {
        return Err(proxy_error::invalid_url());
    }
    if !(MIN_PROXY_CONNECT_TIMEOUT_MS..=MAX_PROXY_CONNECT_TIMEOUT_MS).contains(&connect_timeout_ms)
    {
        return Err(proxy_error::invalid_timeout());
    }

    let parsed_url = Url::parse(&url).map_err(|_| proxy_error::invalid_url())?;
    let scheme = match parsed_url.scheme() {
        "http" => TargetScheme::Plain,
        "https" => TargetScheme::Tls,
        _ => return Err(proxy_error::invalid_url()),
    };
    if parsed_url.cannot_be_a_base()
        || !parsed_url.username().is_empty()
        || parsed_url.password().is_some()
        || parsed_url.query().is_some()
        || parsed_url.fragment().is_some()
        || parsed_url.path() != "/"
    {
        return Err(proxy_error::invalid_url());
    }

    let host = match parsed_url.host() {
        Some(Host::Domain(domain)) if !domain.is_empty() => TargetHost::Domain(domain.to_owned()),
        Some(Host::Ipv4(address)) => TargetHost::Ip(address.into()),
        Some(Host::Ipv6(address)) => TargetHost::Ip(address.into()),
        _ => return Err(proxy_error::invalid_url()),
    };
    let default_port = match scheme {
        TargetScheme::Plain => 80,
        TargetScheme::Tls => 443,
    };
    let port = parsed_url.port().unwrap_or(default_port);
    if port == 0 {
        return Err(proxy_error::invalid_url());
    }
    if scheme == TargetScheme::Plain && tls_certificate_policy != TlsCertificatePolicy::Strict {
        return Err(proxy_error::invalid_tls_policy());
    }

    Ok(ValidatedHttpConnectProxy {
        scheme,
        host,
        port,
        connect_timeout: Duration::from_millis(connect_timeout_ms),
        headers: validate_proxy_headers(non_sensitive_headers)?,
        tls_certificate_policy,
    })
}

fn validate_proxy_headers(
    headers: BTreeMap<String, String>,
) -> Result<Vec<(HeaderName, HeaderValue)>, CommandError> {
    if headers.len() > MAX_PROXY_HEADER_COUNT {
        return Err(proxy_error::invalid_headers());
    }

    let mut normalized_names = BTreeSet::new();
    let mut validated_headers = Vec::with_capacity(headers.len());
    for (name, value) in headers {
        if name.is_empty()
            || name.len() > MAX_PROXY_HEADER_NAME_BYTES
            || value.len() > MAX_PROXY_HEADER_VALUE_BYTES
            || looks_sensitive_identifier(&name)
            || is_reserved_http_connect_header(&name)
        {
            return Err(proxy_error::invalid_headers());
        }

        let header_name =
            HeaderName::from_bytes(name.as_bytes()).map_err(|_| proxy_error::invalid_headers())?;
        if !normalized_names.insert(header_name.as_str().to_owned()) {
            return Err(proxy_error::invalid_headers());
        }
        let header_value =
            HeaderValue::from_str(&value).map_err(|_| proxy_error::invalid_headers())?;
        validated_headers.push((header_name, header_value));
    }
    Ok(validated_headers)
}

// Basic 和 Bearer 只能由 Rust 凭据层构造，WebView 命令固定使用无认证
#[cfg_attr(not(test), allow(dead_code))]
pub(super) enum HttpConnectAuthentication {
    None,
    Basic {
        username: String,
        password: SecretText,
    },
    Bearer {
        token: SecretText,
    },
}

impl HttpConnectAuthentication {
    fn into_header(self) -> Result<Option<HeaderValue>, CommandError> {
        let value = match self {
            Self::None => return Ok(None),
            Self::Basic { username, password } => {
                if username.trim().is_empty()
                    || username.contains(':')
                    || username.len() > MAX_PROXY_USERNAME_BYTES
                    || username.chars().any(char::is_control)
                    || password.as_bytes().is_empty()
                    || password.as_bytes().len() > MAX_HTTP_BASIC_PASSWORD_BYTES
                    || password.as_str().contains('\0')
                {
                    return Err(proxy_error::invalid_authentication());
                }
                let mut credentials = Zeroizing::new(Vec::with_capacity(
                    username.len() + 1 + password.as_bytes().len(),
                ));
                credentials.extend_from_slice(username.as_bytes());
                credentials.push(b':');
                credentials.extend_from_slice(password.as_bytes());
                let encoded = Zeroizing::new(STANDARD.encode(credentials.as_slice()));
                let mut authorization = Zeroizing::new(Vec::with_capacity(6 + encoded.len()));
                authorization.extend_from_slice(b"Basic ");
                authorization.extend_from_slice(encoded.as_bytes());
                sensitive_authorization_header(&authorization)?
            }
            Self::Bearer { token } => {
                if token.as_bytes().len() > MAX_HTTP_BEARER_TOKEN_BYTES
                    || !is_valid_bearer_token(token.as_str())
                {
                    return Err(proxy_error::invalid_authentication());
                }
                let mut authorization =
                    Zeroizing::new(Vec::with_capacity(7 + token.as_bytes().len()));
                authorization.extend_from_slice(b"Bearer ");
                authorization.extend_from_slice(token.as_bytes());
                sensitive_authorization_header(&authorization)?
            }
        };
        Ok(Some(value))
    }
}

fn sensitive_authorization_header(authorization: &[u8]) -> Result<HeaderValue, CommandError> {
    if authorization.len() > MAX_PROXY_HEADER_VALUE_BYTES {
        return Err(proxy_error::invalid_authentication());
    }
    let mut value = HeaderValue::from_bytes(authorization)
        .map_err(|_| proxy_error::invalid_authentication())?;
    value.set_sensitive(true);
    Ok(value)
}

#[cfg(test)]
pub(super) async fn open_http_proxy_websocket(
    target: ValidatedTarget,
    proxy: ValidatedHttpConnectProxy,
    authentication: HttpConnectAuthentication,
) -> Result<RemoteWebSocket, CommandError> {
    open_http_proxy_websocket_with_progress(target, proxy, authentication, Arc::new(|_| {})).await
}

pub(super) async fn open_http_proxy_websocket_with_progress(
    target: ValidatedTarget,
    proxy: ValidatedHttpConnectProxy,
    authentication: HttpConnectAuthentication,
    progress: ConnectionProgressCallback,
) -> Result<RemoteWebSocket, CommandError> {
    progress(RemoteConnectionStage::ResolvingTarget);
    let authorization = authentication.into_header()?;
    let target_authority = target.authority();
    progress(RemoteConnectionStage::ConnectingProxy);
    let tunnel = match timeout(
        proxy.connect_timeout,
        open_http_connect_tunnel(
            proxy,
            &target_authority,
            authorization,
            None,
            Some(&progress),
        ),
    )
    .await
    {
        Ok(Ok(tunnel)) => tunnel,
        Ok(Err(error)) => return Err(map_proxy_failure(error)),
        Err(_) => return Err(proxy_error::timed_out()),
    };

    match timeout(
        target.connect_timeout,
        open_target_websocket_with_progress(target, tunnel, &progress),
    )
    .await
    {
        Ok(Ok(websocket)) => Ok(websocket),
        Ok(Err(error)) => Err(connect_error(error)),
        Err(_) => Err(CommandError::connect_timed_out()),
    }
}

#[cfg(test)]
async fn open_http_proxy_websocket_with_configs(
    target: ValidatedTarget,
    proxy: ValidatedHttpConnectProxy,
    authentication: HttpConnectAuthentication,
    proxy_tls_config: Option<Arc<ClientConfig>>,
    target_tls_config: Option<Arc<ClientConfig>>,
) -> Result<RemoteWebSocket, CommandError> {
    let authorization = authentication.into_header()?;
    let target_authority = target.authority();
    let tunnel = match timeout(
        proxy.connect_timeout,
        open_http_connect_tunnel(
            proxy,
            &target_authority,
            authorization,
            proxy_tls_config,
            None,
        ),
    )
    .await
    {
        Ok(Ok(tunnel)) => tunnel,
        Ok(Err(error)) => return Err(map_proxy_failure(error)),
        Err(_) => return Err(proxy_error::timed_out()),
    };

    let target_timeout = target.connect_timeout;
    let target_connector = async move {
        match target_tls_config {
            Some(config) => open_target_websocket_with_config(target, tunnel, config).await,
            None => open_target_websocket(target, tunnel).await,
        }
    };
    match timeout(target_timeout, target_connector).await {
        Ok(Ok(websocket)) => Ok(websocket),
        Ok(Err(error)) => Err(connect_error(error)),
        Err(_) => Err(CommandError::connect_timed_out()),
    }
}

async fn open_http_connect_tunnel(
    proxy: ValidatedHttpConnectProxy,
    target_authority: &str,
    authorization: Option<HeaderValue>,
    tls_config_override: Option<Arc<ClientConfig>>,
    progress: Option<&ConnectionProgressCallback>,
) -> Result<BoxedRemoteTransport, ProxyConnectFailure> {
    let tcp_stream = connect_tcp(&proxy.host, proxy.port)
        .await
        .map_err(|_| ProxyConnectFailure::Network)?;
    tcp_stream
        .set_nodelay(true)
        .map_err(|_| ProxyConnectFailure::Network)?;
    let transport: BoxedRemoteTransport = Box::new(tcp_stream);
    let transport = match proxy.scheme {
        TargetScheme::Plain => transport,
        TargetScheme::Tls => {
            let config = match tls_config_override {
                Some(config) => config,
                None => tls_config_for_policy(proxy.tls_certificate_policy)
                    .map_err(|_| ProxyConnectFailure::TlsConfiguration)?,
            };
            connect_tls(transport, &proxy.host, config)
                .await
                .map_err(|_| ProxyConnectFailure::Tls)?
        }
    };

    let _tls_certificate_policy = proxy.tls_certificate_policy;
    if let Some(progress) = progress {
        progress(RemoteConnectionStage::ProxyAuthentication);
        progress(RemoteConnectionStage::EstablishingTunnel);
    }

    establish_connect_tunnel(transport, target_authority, proxy.headers, authorization).await
}

async fn establish_connect_tunnel(
    transport: BoxedRemoteTransport,
    target_authority: &str,
    headers: Vec<(HeaderName, HeaderValue)>,
    authorization: Option<HeaderValue>,
) -> Result<BoxedRemoteTransport, ProxyConnectFailure> {
    let authority = target_authority
        .parse::<Authority>()
        .map_err(|_| ProxyConnectFailure::InvalidTargetAuthority)?;
    let uri = hyper::Uri::builder()
        .authority(authority.clone())
        .build()
        .map_err(|_| ProxyConnectFailure::InvalidTargetAuthority)?;
    let mut request = Request::builder()
        .method(Method::CONNECT)
        .uri(uri)
        .header(HOST, authority.as_str())
        .body(Empty::<Bytes>::new())
        .map_err(|_| ProxyConnectFailure::InvalidRequest)?;
    for (name, value) in headers {
        request.headers_mut().append(name, value);
    }
    if let Some(authorization) = authorization {
        request
            .headers_mut()
            .insert(PROXY_AUTHORIZATION, authorization);
    }

    let (transport, response_head_limit) = ResponseHeadLimitedTransport::new(transport);
    let mut builder = http1::Builder::new();
    builder
        .max_headers(MAX_PROXY_RESPONSE_HEADERS)
        .max_buf_size(MAX_PROXY_RESPONSE_HEAD_BYTES);
    let (mut sender, connection) = builder
        .handshake::<_, Empty<Bytes>>(TokioIo::new(Box::new(transport) as BoxedRemoteTransport))
        .await
        .map_err(|_| ProxyConnectFailure::Protocol)?;
    let connection_task =
        ProxyConnectionTask::new(tokio::spawn(
            async move { connection.with_upgrades().await },
        ));

    let response_result = sender.send_request(request).await;
    let mut response = match response_result {
        Ok(response) => response,
        Err(_) => {
            connection_task.abort().await;
            return Err(ProxyConnectFailure::Protocol);
        }
    };
    response_head_limit.disable();
    let status = response.status();
    if status.as_u16() == 407 {
        connection_task.abort().await;
        return Err(ProxyConnectFailure::AuthenticationRequired);
    }
    if !status.is_success() {
        connection_task.abort().await;
        return Err(ProxyConnectFailure::Rejected(status.as_u16()));
    }

    let upgraded = match hyper::upgrade::on(&mut response).await {
        Ok(upgraded) => upgraded,
        Err(_) => {
            connection_task.abort().await;
            return Err(ProxyConnectFailure::Upgrade);
        }
    };
    match connection_task.join().await {
        Ok(Ok(())) => Ok(Box::new(TokioIo::new(upgraded))),
        Ok(Err(_)) | Err(_) => Err(ProxyConnectFailure::Protocol),
    }
}

struct ProxyConnectionTask {
    task: Option<JoinHandle<Result<(), hyper::Error>>>,
}

struct ResponseHeadReadLimit {
    enabled: AtomicBool,
    remaining: AtomicUsize,
}

impl ResponseHeadReadLimit {
    fn disable(&self) {
        self.enabled.store(false, Ordering::Release);
    }
}

struct ResponseHeadLimitedTransport {
    transport: BoxedRemoteTransport,
    limit: Arc<ResponseHeadReadLimit>,
}

impl ResponseHeadLimitedTransport {
    fn new(transport: BoxedRemoteTransport) -> (Self, Arc<ResponseHeadReadLimit>) {
        let limit = Arc::new(ResponseHeadReadLimit {
            enabled: AtomicBool::new(true),
            remaining: AtomicUsize::new(MAX_PROXY_RESPONSE_HEAD_BYTES),
        });
        (
            Self {
                transport,
                limit: Arc::clone(&limit),
            },
            limit,
        )
    }
}

impl AsyncRead for ResponseHeadLimitedTransport {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if !self.limit.enabled.load(Ordering::Acquire) {
            return Pin::new(&mut self.transport).poll_read(context, buffer);
        }
        if buffer.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }

        let remaining = self.limit.remaining.load(Ordering::Acquire);
        if remaining == 0 {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "HTTP proxy response head exceeds the configured limit",
            )));
        }
        let read_capacity = remaining.min(buffer.remaining()).min(8 * 1024);
        let mut bytes = vec![0_u8; read_capacity];
        let mut limited_buffer = ReadBuf::new(&mut bytes);
        match Pin::new(&mut self.transport).poll_read(context, &mut limited_buffer) {
            Poll::Ready(Ok(())) => {
                let filled = limited_buffer.filled();
                self.limit
                    .remaining
                    .fetch_sub(filled.len(), Ordering::AcqRel);
                buffer.put_slice(filled);
                Poll::Ready(Ok(()))
            }
            Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
            Poll::Pending => Poll::Pending,
        }
    }
}

impl AsyncWrite for ResponseHeadLimitedTransport {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.transport).poll_write(context, bytes)
    }

    fn poll_flush(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.transport).poll_flush(context)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.transport).poll_shutdown(context)
    }
}

impl ProxyConnectionTask {
    fn new(task: JoinHandle<Result<(), hyper::Error>>) -> Self {
        Self { task: Some(task) }
    }

    async fn abort(mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
            let _ = task.await;
        }
    }

    async fn join(mut self) -> Result<Result<(), hyper::Error>, tokio::task::JoinError> {
        self.task
            .take()
            .expect("proxy connection task must be present")
            .await
    }
}

impl Drop for ProxyConnectionTask {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

enum ProxyConnectFailure {
    Network,
    TlsConfiguration,
    Tls,
    InvalidTargetAuthority,
    InvalidRequest,
    Protocol,
    AuthenticationRequired,
    Rejected(u16),
    Upgrade,
}

fn map_proxy_failure(error: ProxyConnectFailure) -> CommandError {
    match error {
        ProxyConnectFailure::Network => proxy_error::network_failed(),
        ProxyConnectFailure::TlsConfiguration => CommandError::tls_configuration_failed(),
        ProxyConnectFailure::Tls => proxy_error::tls_failed(),
        ProxyConnectFailure::InvalidTargetAuthority | ProxyConnectFailure::InvalidRequest => {
            proxy_error::invalid_request()
        }
        ProxyConnectFailure::Protocol | ProxyConnectFailure::Upgrade => {
            proxy_error::protocol_failed()
        }
        ProxyConnectFailure::AuthenticationRequired => proxy_error::authentication_failed(),
        ProxyConnectFailure::Rejected(status_code) => proxy_error::rejected(status_code),
    }
}

mod proxy_error {
    use super::CommandError;

    pub(super) const fn invalid_url() -> CommandError {
        CommandError::new("invalidHttpProxyUrl", "The HTTP proxy URL is invalid")
    }

    pub(super) const fn invalid_timeout() -> CommandError {
        CommandError::new(
            "invalidHttpProxyConnectTimeout",
            "The HTTP proxy connection timeout is invalid",
        )
    }

    pub(super) const fn invalid_headers() -> CommandError {
        CommandError::new(
            "invalidHttpProxyHeaders",
            "The non-sensitive HTTP proxy headers are invalid",
        )
    }

    pub(super) const fn invalid_authentication() -> CommandError {
        CommandError::new(
            "invalidHttpProxyAuthentication",
            "The HTTP proxy authentication configuration is invalid",
        )
    }

    pub(super) const fn invalid_tls_policy() -> CommandError {
        CommandError::new(
            "invalidHttpProxyTlsCertificatePolicy",
            "The HTTP proxy TLS certificate policy is invalid",
        )
    }

    pub(super) const fn timed_out() -> CommandError {
        CommandError::new(
            "httpProxyConnectTimedOut",
            "The HTTP proxy connection timed out",
        )
    }

    pub(super) const fn network_failed() -> CommandError {
        CommandError::new(
            "httpProxyNetworkConnectFailed",
            "The HTTP proxy network connection could not be established",
        )
    }

    pub(super) const fn tls_failed() -> CommandError {
        CommandError::new(
            "httpProxyTlsFailed",
            "The HTTP proxy TLS certificate or handshake could not be validated",
        )
    }

    pub(super) const fn invalid_request() -> CommandError {
        CommandError::new(
            "invalidHttpConnectRequest",
            "The HTTP CONNECT request could not be constructed",
        )
    }

    pub(super) const fn protocol_failed() -> CommandError {
        CommandError::new(
            "httpProxyProtocolFailed",
            "The HTTP proxy returned an invalid CONNECT response",
        )
    }

    pub(super) const fn authentication_failed() -> CommandError {
        CommandError::new(
            "httpProxyAuthenticationFailed",
            "The HTTP proxy rejected the configured credentials",
        )
    }

    pub(super) const fn rejected(status_code: u16) -> CommandError {
        CommandError::with_status_code(
            "httpProxyConnectRejected",
            "The HTTP proxy rejected the CONNECT request",
            status_code,
        )
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeMap,
        io::ErrorKind,
        sync::{Arc, Mutex},
        time::Duration,
    };

    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use futures_util::{SinkExt, StreamExt};
    use rustls::{
        ClientConfig, RootCertStore, ServerConfig,
        pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer},
    };
    use tokio::{
        io::{AsyncRead, AsyncReadExt, AsyncWriteExt, copy_bidirectional},
        net::{TcpListener, TcpStream},
        time::timeout,
    };
    use tokio_rustls::{TlsAcceptor, rustls};
    use tokio_tungstenite::{
        accept_hdr_async,
        tungstenite::{Message, handshake::server::Response},
    };

    use super::{
        ConnectHttpProxyWebSocketRequest, HttpConnectAuthentication, HttpConnectProxyRequest,
        HttpProxyWebSocketTargetRequest, open_http_proxy_websocket,
        open_http_proxy_websocket_with_progress, validate_http_connect_proxy,
    };
    use crate::{
        configuration::{SecretText, TlsCertificatePolicy},
        connection::remote_websocket::{RemoteConnectionStage, ValidatedTarget},
    };

    fn secret_text(value: &str) -> SecretText {
        serde_json::from_value(serde_json::Value::String(value.to_owned())).unwrap()
    }

    fn request(target_url: String, proxy_url: String) -> ConnectHttpProxyWebSocketRequest {
        ConnectHttpProxyWebSocketRequest {
            connection_id: "remote".to_owned(),
            target: HttpProxyWebSocketTargetRequest {
                url: target_url,
                insecure_transport_confirmed: true,
                connect_timeout_ms: 5_000,
                non_sensitive_headers: BTreeMap::new(),
            },
            proxy: HttpConnectProxyRequest {
                url: proxy_url,
                connect_timeout_ms: 5_000,
                non_sensitive_headers: BTreeMap::new(),
            },
        }
    }

    async fn read_http_head<S>(stream: &mut S) -> String
    where
        S: AsyncRead + Unpin,
    {
        let mut head = Vec::new();
        loop {
            let mut chunk = [0_u8; 1024];
            let count = stream.read(&mut chunk).await.unwrap();
            assert!(
                count > 0,
                "proxy client closed before completing request head"
            );
            head.extend_from_slice(&chunk[..count]);
            assert!(
                head.len() <= 128 * 1024,
                "proxy request head exceeded fixture limit"
            );
            if head.windows(4).any(|window| window == b"\r\n\r\n") {
                return String::from_utf8(head).expect("proxy request head must be UTF-8");
            }
        }
    }

    fn connect_authority(head: &str) -> &str {
        let request_line = head
            .lines()
            .next()
            .expect("CONNECT request line must exist");
        let mut parts = request_line.split_ascii_whitespace();
        assert_eq!(parts.next(), Some("CONNECT"));
        let authority = parts.next().expect("CONNECT authority must exist");
        assert_eq!(parts.next(), Some("HTTP/1.1"));
        authority
    }

    fn test_client_tls_config(trust_test_ca: bool) -> Arc<ClientConfig> {
        let mut roots = RootCertStore::empty();
        if trust_test_ca {
            roots
                .add(CertificateDer::from(
                    STANDARD
                        .decode(include_str!("testdata/http-connect-ca.der.b64").trim())
                        .unwrap(),
                ))
                .unwrap();
        }
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        Arc::new(
            ClientConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        )
    }

    fn test_server_tls_config() -> Arc<ServerConfig> {
        let certificate = CertificateDer::from(
            STANDARD
                .decode(include_str!("testdata/http-connect-server.der.b64").trim())
                .unwrap(),
        );
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
            STANDARD
                .decode(include_str!("testdata/http-connect-server-key.der.b64").trim())
                .unwrap(),
        ));
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        Arc::new(
            ServerConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_no_client_auth()
                .with_single_cert(vec![certificate], key)
                .unwrap(),
        )
    }

    #[test]
    fn validates_proxy_endpoint_and_separates_header_namespaces() {
        for (url, expected_port) in [
            ("http://proxy.example.test", 80),
            ("https://proxy.example.test", 443),
            ("http://127.0.0.1:3128", 3128),
            ("https://[::1]:8443", 8443),
        ] {
            let proxy = request("wss://target.example.test/app".to_owned(), url.to_owned())
                .validate()
                .expect("proxy endpoint should be valid")
                .2;
            assert_eq!(proxy.port, expected_port);
        }

        for url in [
            "socks5://proxy.example.test",
            "http://user@proxy.example.test",
            "http://proxy.example.test/path",
            "http://proxy.example.test?token=secret",
            "http://proxy.example.test#fragment",
        ] {
            let error = request("wss://target.example.test/app".to_owned(), url.to_owned())
                .validate()
                .unwrap_err();
            assert_eq!(error.code, "invalidHttpProxyUrl");
        }

        for name in [
            "Authorization",
            "Proxy-Authorization",
            "Cookie",
            "X-ApiToken",
            "Host",
            "Connection",
            "Sec-WebSocket-Key",
            "Sec-WebSocket-Foo",
            "Proxy-Authenticate",
            "TE",
            "Trailer",
        ] {
            let mut invalid = request(
                "wss://target.example.test/app".to_owned(),
                "http://proxy.example.test".to_owned(),
            );
            invalid
                .proxy
                .non_sensitive_headers
                .insert(name.to_owned(), "DO_NOT_REPORT".to_owned());
            let error = invalid.validate().unwrap_err();
            assert_eq!(error.code, "invalidHttpProxyHeaders");
            assert!(
                !serde_json::to_string(&error)
                    .unwrap()
                    .contains("DO_NOT_REPORT")
            );
        }

        let deserialization =
            serde_json::from_value::<ConnectHttpProxyWebSocketRequest>(serde_json::json!({
                "connectionId": "remote",
                "target": {
                    "url": "wss://target.example.test/app",
                    "insecureTransportConfirmed": false,
                    "connectTimeoutMs": 5000
                },
                "proxy": {
                    "url": "https://proxy.example.test",
                    "connectTimeoutMs": 5000,
                    "bearerToken": "DO_NOT_REPORT"
                }
            }));
        let error = deserialization.expect_err("WebView must not provide proxy credentials");
        assert!(!error.to_string().contains("DO_NOT_REPORT"));
    }

    #[test]
    fn builds_sensitive_basic_and_bearer_proxy_authorization_headers() {
        let basic = HttpConnectAuthentication::Basic {
            username: "user".to_owned(),
            password: secret_text("password"),
        }
        .into_header()
        .unwrap()
        .unwrap();
        assert_eq!(basic, "Basic dXNlcjpwYXNzd29yZA==");
        assert!(basic.is_sensitive());

        let bearer = HttpConnectAuthentication::Bearer {
            token: secret_text("proxy-token"),
        }
        .into_header()
        .unwrap()
        .unwrap();
        assert_eq!(bearer, "Bearer proxy-token");
        assert!(bearer.is_sensitive());

        let invalid = HttpConnectAuthentication::Basic {
            username: "user:name".to_owned(),
            password: secret_text("DO_NOT_REPORT"),
        }
        .into_header()
        .unwrap_err();
        assert_eq!(invalid.code, "invalidHttpProxyAuthentication");
        assert!(
            !serde_json::to_string(&invalid)
                .unwrap()
                .contains("DO_NOT_REPORT")
        );

        let invalid = HttpConnectAuthentication::Bearer {
            token: secret_text("DO_NOT_REPORT with-space"),
        }
        .into_header()
        .unwrap_err();
        assert_eq!(invalid.code, "invalidHttpProxyAuthentication");
        assert!(
            !serde_json::to_string(&invalid)
                .unwrap()
                .contains("DO_NOT_REPORT")
        );
    }

    #[test]
    fn validates_tls_policy_for_reusable_proxy_configuration() {
        let error = validate_http_connect_proxy(
            "http://proxy.example.test".to_owned(),
            5_000,
            BTreeMap::new(),
            TlsCertificatePolicy::AllowInvalidCertificate,
        )
        .unwrap_err();
        assert_eq!(error.code, "invalidHttpProxyTlsCertificatePolicy");

        let proxy = validate_http_connect_proxy(
            "https://proxy.example.test".to_owned(),
            5_000,
            BTreeMap::new(),
            TlsCertificatePolicy::AllowInvalidCertificate,
        )
        .unwrap();
        assert_eq!(
            proxy.tls_certificate_policy,
            TlsCertificatePolicy::AllowInvalidCertificate
        );
    }

    #[allow(clippy::result_large_err)]
    #[tokio::test]
    async fn tunnels_websocket_while_isolating_proxy_and_target_headers() {
        let target_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let target_address = target_listener.local_addr().unwrap();
        let target_server = tokio::spawn(async move {
            let (stream, _) = target_listener.accept().await.unwrap();
            let mut websocket = accept_hdr_async(
                stream,
                |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                 response: Response| {
                    assert_eq!(request.uri().path(), "/app");
                    assert_eq!(
                        request.headers().get("host").unwrap(),
                        target_address.to_string().as_str()
                    );
                    assert_eq!(request.headers().get("x-server-mode").unwrap(), "desktop");
                    assert!(!request.headers().contains_key("x-proxy-mode"));
                    assert!(!request.headers().contains_key("proxy-authorization"));
                    Ok(response)
                },
            )
            .await
            .unwrap();
            assert_eq!(
                websocket.next().await.unwrap().unwrap(),
                Message::Text(r#"{"method":"initialize"}"#.into())
            );
            websocket
                .send(Message::Text(r#"{"id":1,"result":null}"#.into()))
                .await
                .unwrap();
            let _ = websocket.close(None).await;
        });

        let proxy_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let proxy_address = proxy_listener.local_addr().unwrap();
        let proxy_server = tokio::spawn(async move {
            let (mut client, _) = proxy_listener.accept().await.unwrap();
            let request_head = read_http_head(&mut client).await;
            let authority = connect_authority(&request_head).to_owned();
            let mut target = TcpStream::connect(&authority).await.unwrap();
            client
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .await
                .unwrap();
            if let Err(error) = copy_bidirectional(&mut client, &mut target).await {
                assert!(
                    matches!(
                        error.kind(),
                        ErrorKind::BrokenPipe
                            | ErrorKind::ConnectionReset
                            | ErrorKind::UnexpectedEof
                    ),
                    "unexpected tunnel copy failure: {error}"
                );
            }
            request_head
        });

        let mut request = request(
            format!("ws://{target_address}/app"),
            format!("http://{proxy_address}"),
        );
        request
            .target
            .non_sensitive_headers
            .insert("X-Server-Mode".to_owned(), "desktop".to_owned());
        request
            .proxy
            .non_sensitive_headers
            .insert("X-Proxy-Mode".to_owned(), "tunnel".to_owned());
        let (_, target, proxy) = request.validate().unwrap();
        let stages = Arc::new(Mutex::new(Vec::new()));
        let captured_stages = Arc::clone(&stages);
        let mut websocket = open_http_proxy_websocket_with_progress(
            target,
            proxy,
            HttpConnectAuthentication::Bearer {
                token: secret_text("proxy-token"),
            },
            Arc::new(move |stage| captured_stages.lock().unwrap().push(stage)),
        )
        .await
        .unwrap();
        websocket
            .send(Message::Text(r#"{"method":"initialize"}"#.into()))
            .await
            .unwrap();
        assert_eq!(
            websocket.next().await.unwrap().unwrap(),
            Message::Text(r#"{"id":1,"result":null}"#.into())
        );
        let _ = websocket.close(None).await;
        let _ = websocket.get_mut().shutdown().await;
        drop(websocket);

        timeout(Duration::from_secs(5), target_server)
            .await
            .expect("target fixture did not shut down")
            .unwrap();
        let proxy_request = timeout(Duration::from_secs(5), proxy_server)
            .await
            .expect("proxy fixture did not shut down")
            .unwrap();
        let proxy_request_lowercase = proxy_request.to_ascii_lowercase();
        assert_eq!(
            connect_authority(&proxy_request),
            target_address.to_string()
        );
        assert!(proxy_request_lowercase.contains("x-proxy-mode: tunnel\r\n"));
        assert!(proxy_request_lowercase.contains("proxy-authorization: bearer proxy-token\r\n"));
        assert!(!proxy_request_lowercase.contains("x-server-mode"));
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

    #[tokio::test]
    async fn validates_https_proxy_tls_before_target_tls_and_websocket_handshake() {
        let server_tls_config = test_server_tls_config();
        let client_tls_config = test_client_tls_config(true);

        let target_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let target_address = target_listener.local_addr().unwrap();
        let target_acceptor = TlsAcceptor::from(Arc::clone(&server_tls_config));
        let target_server = tokio::spawn(async move {
            let (stream, _) = target_listener.accept().await.unwrap();
            let tls_stream = target_acceptor.accept(stream).await.unwrap();
            assert_eq!(tls_stream.get_ref().1.server_name(), Some("localhost"));
            let mut websocket = tokio_tungstenite::accept_async(tls_stream).await.unwrap();
            assert_eq!(
                websocket.next().await.unwrap().unwrap(),
                Message::Text(r#"{"method":"initialize"}"#.into())
            );
            websocket
                .send(Message::Text(r#"{"id":1,"result":null}"#.into()))
                .await
                .unwrap();
            let _ = websocket.close(None).await;
        });

        let proxy_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let proxy_address = proxy_listener.local_addr().unwrap();
        let proxy_acceptor = TlsAcceptor::from(server_tls_config);
        let expected_authority = format!("localhost:{}", target_address.port());
        let proxy_server = tokio::spawn(async move {
            let (stream, _) = proxy_listener.accept().await.unwrap();
            let mut client = proxy_acceptor.accept(stream).await.unwrap();
            assert_eq!(client.get_ref().1.server_name(), None);
            let request_head = read_http_head(&mut client).await;
            assert_eq!(connect_authority(&request_head), expected_authority);
            let mut target = TcpStream::connect(target_address).await.unwrap();
            client
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .await
                .unwrap();
            if let Err(error) = copy_bidirectional(&mut client, &mut target).await {
                assert!(
                    matches!(
                        error.kind(),
                        ErrorKind::BrokenPipe
                            | ErrorKind::ConnectionReset
                            | ErrorKind::UnexpectedEof
                    ),
                    "unexpected TLS tunnel copy failure: {error}"
                );
            }
        });

        let (_, target, proxy) = request(
            format!("wss://localhost:{}/app", target_address.port()),
            format!("https://{proxy_address}"),
        )
        .validate()
        .unwrap();
        let mut websocket = super::open_http_proxy_websocket_with_configs(
            target,
            proxy,
            HttpConnectAuthentication::None,
            Some(Arc::clone(&client_tls_config)),
            Some(client_tls_config),
        )
        .await
        .unwrap();
        websocket
            .send(Message::Text(r#"{"method":"initialize"}"#.into()))
            .await
            .unwrap();
        assert_eq!(
            websocket.next().await.unwrap().unwrap(),
            Message::Text(r#"{"id":1,"result":null}"#.into())
        );
        let _ = websocket.close(None).await;
        let _ = websocket.get_mut().shutdown().await;
        drop(websocket);

        timeout(Duration::from_secs(5), target_server)
            .await
            .expect("TLS target fixture did not shut down")
            .unwrap();
        timeout(Duration::from_secs(5), proxy_server)
            .await
            .expect("TLS proxy fixture did not shut down")
            .unwrap();
    }

    #[tokio::test]
    async fn allow_invalid_certificate_policy_applies_to_proxy_and_target_tls() {
        let server_tls_config = test_server_tls_config();

        let target_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let target_address = target_listener.local_addr().unwrap();
        let target_acceptor = TlsAcceptor::from(Arc::clone(&server_tls_config));
        let target_server = tokio::spawn(async move {
            let (stream, _) = target_listener.accept().await.unwrap();
            let tls_stream = target_acceptor.accept(stream).await.unwrap();
            let mut websocket = tokio_tungstenite::accept_async(tls_stream).await.unwrap();
            let _ = websocket.next().await;
        });

        let proxy_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let proxy_address = proxy_listener.local_addr().unwrap();
        let proxy_acceptor = TlsAcceptor::from(server_tls_config);
        let expected_authority = format!("localhost:{}", target_address.port());
        let proxy_server = tokio::spawn(async move {
            let (stream, _) = proxy_listener.accept().await.unwrap();
            let mut client = proxy_acceptor.accept(stream).await.unwrap();
            let request_head = read_http_head(&mut client).await;
            assert_eq!(connect_authority(&request_head), expected_authority);
            let mut target = TcpStream::connect(target_address).await.unwrap();
            client
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .await
                .unwrap();
            if let Err(error) = copy_bidirectional(&mut client, &mut target).await {
                assert!(
                    matches!(
                        error.kind(),
                        ErrorKind::BrokenPipe
                            | ErrorKind::ConnectionReset
                            | ErrorKind::UnexpectedEof
                    ),
                    "unexpected allow-invalid tunnel copy failure: {error}"
                );
            }
        });

        let target = ValidatedTarget::parse_with_tls_policy(
            &format!("wss://localhost:{}/app", target_address.port()),
            false,
            5_000,
            &BTreeMap::new(),
            TlsCertificatePolicy::AllowInvalidCertificate,
        )
        .unwrap();
        let proxy = validate_http_connect_proxy(
            format!("https://{proxy_address}"),
            5_000,
            BTreeMap::new(),
            TlsCertificatePolicy::AllowInvalidCertificate,
        )
        .unwrap();
        let mut websocket =
            open_http_proxy_websocket(target, proxy, HttpConnectAuthentication::None)
                .await
                .unwrap();
        websocket.close(None).await.unwrap();
        let _ = websocket.get_mut().shutdown().await;
        drop(websocket);

        timeout(Duration::from_secs(5), target_server)
            .await
            .expect("allow-invalid TLS target fixture did not shut down")
            .unwrap();
        timeout(Duration::from_secs(5), proxy_server)
            .await
            .expect("allow-invalid TLS proxy fixture did not shut down")
            .unwrap();
    }

    #[tokio::test]
    async fn rejects_an_untrusted_https_proxy_before_contacting_the_target() {
        let target_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let target_address = target_listener.local_addr().unwrap();
        let proxy_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let proxy_address = proxy_listener.local_addr().unwrap();
        let proxy_acceptor = TlsAcceptor::from(test_server_tls_config());
        let proxy_server = tokio::spawn(async move {
            let (stream, _) = proxy_listener.accept().await.unwrap();
            assert!(proxy_acceptor.accept(stream).await.is_err());
        });

        let (_, target, proxy) = request(
            format!("ws://{target_address}/app"),
            format!("https://{proxy_address}"),
        )
        .validate()
        .unwrap();
        let error = match super::open_http_proxy_websocket_with_configs(
            target,
            proxy,
            HttpConnectAuthentication::None,
            Some(test_client_tls_config(false)),
            None,
        )
        .await
        {
            Ok(_) => panic!("untrusted HTTPS proxy unexpectedly succeeded"),
            Err(error) => error,
        };
        assert_eq!(error.code, "httpProxyTlsFailed");
        assert!(
            timeout(Duration::from_millis(100), target_listener.accept())
                .await
                .is_err(),
            "failed proxy TLS validation must stop before target access"
        );
        timeout(Duration::from_secs(5), proxy_server)
            .await
            .expect("untrusted TLS proxy fixture did not shut down")
            .unwrap();
    }

    #[tokio::test]
    async fn maps_proxy_rejections_safely_and_never_falls_back_to_target() {
        for (status, expected_code) in [
            (407, "httpProxyAuthenticationFailed"),
            (503, "httpProxyConnectRejected"),
        ] {
            let target_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let target_address = target_listener.local_addr().unwrap();
            let proxy_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let proxy_address = proxy_listener.local_addr().unwrap();
            let proxy_server = tokio::spawn(async move {
                let (mut client, _) = proxy_listener.accept().await.unwrap();
                let _ = read_http_head(&mut client).await;
                client
                    .write_all(
                        format!(
                            "HTTP/1.1 {status} Rejected\r\nX-Diagnostic: DO_NOT_REPORT\r\nContent-Length: 0\r\n\r\n"
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            });

            let (_, target, proxy) = request(
                format!("ws://{target_address}/app"),
                format!("http://{proxy_address}"),
            )
            .validate()
            .unwrap();
            let error = match open_http_proxy_websocket(
                target,
                proxy,
                HttpConnectAuthentication::Bearer {
                    token: secret_text("DO_NOT_REPORT"),
                },
            )
            .await
            {
                Ok(_) => panic!("rejected proxy connection unexpectedly succeeded"),
                Err(error) => error,
            };
            assert_eq!(error.code, expected_code);
            assert_eq!(error.status_code, (status == 503).then_some(503));
            assert!(
                !serde_json::to_string(&error)
                    .unwrap()
                    .contains("DO_NOT_REPORT")
            );
            assert!(
                timeout(Duration::from_millis(100), target_listener.accept())
                    .await
                    .is_err(),
                "a rejected proxy must not trigger a direct target connection"
            );
            proxy_server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn bounds_proxy_response_heads_and_cancels_a_timed_out_handshake() {
        let oversized_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let oversized_address = oversized_listener.local_addr().unwrap();
        let oversized_proxy = tokio::spawn(async move {
            let (mut client, _) = oversized_listener.accept().await.unwrap();
            let _ = read_http_head(&mut client).await;
            let mut response = b"HTTP/1.1 200 Connection Established\r\nX-Large: ".to_vec();
            response.extend(vec![b'a'; 70 * 1024]);
            response.extend_from_slice(b"\r\n\r\n");
            let _ = client.write_all(&response).await;
        });
        let (_, target, proxy) = request(
            "ws://127.0.0.1:9/app".to_owned(),
            format!("http://{oversized_address}"),
        )
        .validate()
        .unwrap();
        let error =
            match open_http_proxy_websocket(target, proxy, HttpConnectAuthentication::None).await {
                Ok(_) => panic!("oversized proxy response unexpectedly succeeded"),
                Err(error) => error,
            };
        assert_eq!(error.code, "httpProxyProtocolFailed");
        oversized_proxy.await.unwrap();

        let timeout_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let timeout_address = timeout_listener.local_addr().unwrap();
        let timeout_proxy = tokio::spawn(async move {
            let (mut client, _) = timeout_listener.accept().await.unwrap();
            let _ = read_http_head(&mut client).await;
            let mut trailing = Vec::new();
            timeout(Duration::from_secs(1), client.read_to_end(&mut trailing))
                .await
                .expect("timed-out CONNECT transport must be closed")
                .unwrap();
        });
        let (_, target, mut proxy) = request(
            "ws://127.0.0.1:9/app".to_owned(),
            format!("http://{timeout_address}"),
        )
        .validate()
        .unwrap();
        proxy.connect_timeout = Duration::from_millis(50);
        let error =
            match open_http_proxy_websocket(target, proxy, HttpConnectAuthentication::None).await {
                Ok(_) => panic!("timed-out proxy connection unexpectedly succeeded"),
                Err(error) => error,
            };
        assert_eq!(error.code, "httpProxyConnectTimedOut");
        timeout_proxy.await.unwrap();
    }
}
