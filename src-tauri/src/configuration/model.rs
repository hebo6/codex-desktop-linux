use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    net::IpAddr,
    path::Path,
    str::FromStr,
};

#[cfg(target_os = "linux")]
use std::os::unix::fs::OpenOptionsExt;

use russh::keys::ssh_key::Fingerprint;
use serde::{Deserialize, Serialize};
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue};
use url::{Host, Url};
use uuid::Uuid;

use crate::{
    header_policy::{is_reserved_http_connect_header, is_reserved_websocket_header},
    sensitive::{looks_sensitive_environment_name, looks_sensitive_identifier},
};

const MAX_NAME_BYTES: usize = 128;
const MAX_PATH_BYTES: usize = 4 * 1024;
const MAX_ARGUMENT_COUNT: usize = 128;
const MAX_ARGUMENT_BYTES: usize = 4 * 1024;
const MAX_ENVIRONMENT_COUNT: usize = 64;
const MAX_ENVIRONMENT_NAME_BYTES: usize = 128;
const MAX_ENVIRONMENT_VALUE_BYTES: usize = 8 * 1024;
const MAX_URL_BYTES: usize = 4 * 1024;
const MAX_HEADER_COUNT: usize = 32;
const MAX_HEADER_NAME_BYTES: usize = 128;
const MAX_HEADER_VALUE_BYTES: usize = 8 * 1024;
const MAX_HOST_BYTES: usize = 253;
const MAX_USERNAME_BYTES: usize = 255;
const MAX_ALGORITHM_BYTES: usize = 128;
const MIN_CONNECT_TIMEOUT_MS: u64 = 1_000;
const MAX_CONNECT_TIMEOUT_MS: u64 = 120_000;
const MIN_KEEP_ALIVE_INTERVAL_MS: u64 = 1_000;
const MAX_KEEP_ALIVE_INTERVAL_MS: u64 = 300_000;
const MAX_KEEP_ALIVE_FAILURES: usize = 10;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct ServerId(pub(super) Uuid);

impl ServerId {
    pub(super) fn new() -> Self {
        Self(Uuid::new_v4())
    }

    pub(crate) fn parse_persisted(value: &str) -> Option<Self> {
        let identifier = Uuid::parse_str(value).ok()?;
        (identifier.get_version() == Some(uuid::Version::Random)
            && identifier.as_hyphenated().to_string() == value)
            .then_some(Self(identifier))
    }

    pub(crate) fn to_persisted_string(self) -> String {
        self.0.to_string()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct ProxyId(pub(super) Uuid);

impl ProxyId {
    pub(super) fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigurationSnapshot {
    pub(crate) servers: Vec<ServerProfile>,
    pub(crate) proxies: Vec<ProxyProfile>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerProfile {
    pub(crate) server_id: ServerId,
    pub(crate) name: String,
    pub(crate) version: u64,
    pub(crate) configuration: ServerConfiguration,
    pub(crate) credential_configured: bool,
    pub(crate) created_at_ms: i64,
    pub(crate) updated_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) last_used_at_ms: Option<i64>,
    pub(crate) active_window_count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ServerConfiguration {
    LocalStdio {
        executable_path: String,
        arguments: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        default_working_directory: Option<String>,
        non_sensitive_environment: BTreeMap<String, String>,
    },
    RemoteWebSocket {
        url: String,
        authentication: RemoteServerAuthentication,
        non_sensitive_headers: BTreeMap<String, String>,
        connect_timeout_ms: u64,
        tls_certificate_policy: TlsCertificatePolicy,
        plaintext_confirmed: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        proxy_id: Option<ProxyId>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RemoteServerAuthentication {
    None,
    Bearer,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TlsCertificatePolicy {
    Strict,
    AllowInvalidCertificate,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateServerProfileRequest {
    name: String,
    configuration: ServerConfigurationInput,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateServerProfileRequest {
    pub(super) server_id: ServerId,
    pub(super) expected_version: u64,
    name: String,
    configuration: ServerConfigurationInput,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeleteServerProfileRequest {
    pub(super) server_id: ServerId,
    pub(super) expected_version: u64,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ServerConfigurationInput {
    LocalStdio {
        executable_path: String,
        arguments: Vec<String>,
        #[serde(default)]
        default_working_directory: Option<String>,
        #[serde(default)]
        non_sensitive_environment: BTreeMap<String, String>,
    },
    RemoteWebSocket {
        url: String,
        authentication: RemoteServerAuthentication,
        #[serde(default)]
        non_sensitive_headers: BTreeMap<String, String>,
        connect_timeout_ms: u64,
        tls_certificate_policy: TlsCertificatePolicy,
        plaintext_confirmed: bool,
        #[serde(default)]
        proxy_id: Option<ProxyId>,
    },
}

pub(super) struct ValidatedServerWrite {
    pub(super) name: String,
    pub(super) configuration: ServerConfiguration,
}

impl CreateServerProfileRequest {
    pub(super) fn validate(self) -> Result<ValidatedServerWrite, ConfigurationValidationError> {
        validate_server_write(self.name, self.configuration)
    }
}

impl UpdateServerProfileRequest {
    pub(super) fn validate(self) -> Result<ValidatedServerWrite, ConfigurationValidationError> {
        if self.expected_version == 0 {
            return Err(ConfigurationValidationError::invalid_version());
        }
        validate_server_write(self.name, self.configuration)
    }
}

impl DeleteServerProfileRequest {
    pub(super) fn validate(&self) -> Result<(), ConfigurationValidationError> {
        if self.expected_version == 0 {
            return Err(ConfigurationValidationError::invalid_version());
        }
        Ok(())
    }
}

fn validate_server_write(
    name: String,
    configuration: ServerConfigurationInput,
) -> Result<ValidatedServerWrite, ConfigurationValidationError> {
    let name = validate_name(name, ConfigurationValidationError::invalid_server_name)?;
    let configuration = validate_server_configuration(configuration)?;
    Ok(ValidatedServerWrite {
        name,
        configuration,
    })
}

fn validate_server_configuration(
    configuration: ServerConfigurationInput,
) -> Result<ServerConfiguration, ConfigurationValidationError> {
    let configuration = match configuration {
        ServerConfigurationInput::LocalStdio {
            executable_path,
            arguments,
            default_working_directory,
            non_sensitive_environment,
        } => {
            validate_absolute_path(&executable_path)
                .map_err(|_| ConfigurationValidationError::invalid_executable_path())?;
            if arguments.len() > MAX_ARGUMENT_COUNT
                || arguments
                    .iter()
                    .any(|argument| argument.len() > MAX_ARGUMENT_BYTES || argument.contains('\0'))
            {
                return Err(ConfigurationValidationError::invalid_arguments());
            }
            if let Some(path) = &default_working_directory {
                validate_absolute_path(path)
                    .map_err(|_| ConfigurationValidationError::invalid_working_directory())?;
            }
            validate_environment(&non_sensitive_environment)?;
            ServerConfiguration::LocalStdio {
                executable_path,
                arguments,
                default_working_directory,
                non_sensitive_environment,
            }
        }
        ServerConfigurationInput::RemoteWebSocket {
            url,
            authentication,
            non_sensitive_headers,
            connect_timeout_ms,
            tls_certificate_policy,
            plaintext_confirmed,
            proxy_id,
        } => {
            validate_connect_timeout(connect_timeout_ms)?;
            validate_headers(&non_sensitive_headers, is_reserved_websocket_header)?;
            validate_websocket_url(&url, plaintext_confirmed, tls_certificate_policy)?;
            ServerConfiguration::RemoteWebSocket {
                url,
                authentication,
                non_sensitive_headers,
                connect_timeout_ms,
                tls_certificate_policy,
                plaintext_confirmed,
                proxy_id,
            }
        }
    };
    Ok(configuration)
}

impl ServerConfigurationInput {
    pub(crate) fn validate(self) -> Result<ServerConfiguration, ConfigurationValidationError> {
        validate_server_configuration(self)
    }
}

impl ServerConfiguration {
    pub(super) fn validate_persisted(
        self,
        name: String,
    ) -> Result<ValidatedServerWrite, ConfigurationValidationError> {
        let request = match self {
            Self::LocalStdio {
                executable_path,
                arguments,
                default_working_directory,
                non_sensitive_environment,
            } => ServerConfigurationInput::LocalStdio {
                executable_path,
                arguments,
                default_working_directory,
                non_sensitive_environment,
            },
            Self::RemoteWebSocket {
                url,
                authentication,
                non_sensitive_headers,
                connect_timeout_ms,
                tls_certificate_policy,
                plaintext_confirmed,
                proxy_id,
            } => ServerConfigurationInput::RemoteWebSocket {
                url,
                authentication,
                non_sensitive_headers,
                connect_timeout_ms,
                tls_certificate_policy,
                plaintext_confirmed,
                proxy_id,
            },
        };
        validate_server_write(name, request)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProxyProfile {
    pub(crate) proxy_id: ProxyId,
    pub(crate) name: String,
    pub(crate) version: u64,
    pub(crate) configuration: ProxyConfiguration,
    pub(crate) credential_configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ssh_host_key: Option<SshHostKeyRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) last_test: Option<ProxyLastTest>,
    pub(crate) referenced_server_count: u64,
    pub(crate) created_at_ms: i64,
    pub(crate) updated_at_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ProxyConfiguration {
    HttpConnect {
        url: String,
        authentication: HttpProxyAuthentication,
        #[serde(skip_serializing_if = "Option::is_none")]
        username: Option<String>,
        non_sensitive_headers: BTreeMap<String, String>,
        connect_timeout_ms: u64,
        tls_certificate_policy: TlsCertificatePolicy,
    },
    Socks5 {
        host: String,
        port: u16,
        authentication: Socks5Authentication,
        #[serde(skip_serializing_if = "Option::is_none")]
        username: Option<String>,
        dns_resolution: Socks5DnsResolution,
        connect_timeout_ms: u64,
    },
    Ssh {
        host: String,
        port: u16,
        username: String,
        authentication: SshAuthenticationConfiguration,
        connect_timeout_ms: u64,
        keep_alive_interval_ms: u64,
        keep_alive_max_failures: usize,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HttpProxyAuthentication {
    None,
    Basic,
    Bearer,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Socks5Authentication {
    None,
    UsernamePassword,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Socks5DnsResolution {
    Proxy,
    Local,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum SshAuthenticationConfiguration {
    Agent {},
    PrivateKey { private_key_path: String },
    Password {},
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshHostKeyRecord {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) algorithm: String,
    pub(crate) sha256_fingerprint: String,
    pub(crate) confirmed_at_ms: i64,
}

impl SshHostKeyRecord {
    pub(crate) fn for_connection_test(
        host: String,
        port: u16,
        algorithm: String,
        sha256_fingerprint: String,
    ) -> Result<Self, ConfigurationValidationError> {
        validate_host_key_record(&host, port, &algorithm, &sha256_fingerprint)?;
        Ok(Self {
            host,
            port,
            algorithm,
            sha256_fingerprint,
            confirmed_at_ms: 0,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProxyTestStatus {
    Succeeded,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProxyLastTest {
    pub(crate) status: ProxyTestStatus,
    pub(crate) tested_at_ms: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateProxyProfileRequest {
    name: String,
    configuration: ProxyConfigurationRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateProxyProfileRequest {
    pub(super) proxy_id: ProxyId,
    pub(super) expected_version: u64,
    name: String,
    configuration: ProxyConfigurationRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeleteProxyProfileRequest {
    pub(super) proxy_id: ProxyId,
    pub(super) expected_version: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoveProxySshHostKeyRequest {
    pub(super) proxy_id: ProxyId,
    pub(super) expected_version: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConfirmProxySshHostKeyRequest {
    pub(super) proxy_id: ProxyId,
    pub(super) expected_version: u64,
    pub(super) host: String,
    pub(super) port: u16,
    pub(super) algorithm: String,
    pub(super) sha256_fingerprint: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecordProxyTestRequest {
    pub(super) proxy_id: ProxyId,
    pub(super) expected_version: u64,
    pub(super) status: ProxyTestStatus,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ProxyConfigurationRequest {
    HttpConnect {
        url: String,
        authentication: HttpProxyAuthentication,
        #[serde(default)]
        username: Option<String>,
        #[serde(default)]
        non_sensitive_headers: BTreeMap<String, String>,
        connect_timeout_ms: u64,
        tls_certificate_policy: TlsCertificatePolicy,
    },
    Socks5 {
        host: String,
        port: u16,
        authentication: Socks5Authentication,
        #[serde(default)]
        username: Option<String>,
        dns_resolution: Socks5DnsResolution,
        connect_timeout_ms: u64,
    },
    Ssh {
        host: String,
        #[serde(default = "default_ssh_port")]
        port: u16,
        username: String,
        authentication: SshAuthenticationConfiguration,
        connect_timeout_ms: u64,
        keep_alive_interval_ms: u64,
        keep_alive_max_failures: usize,
    },
}

const fn default_ssh_port() -> u16 {
    22
}

pub(super) struct ValidatedProxyWrite {
    pub(super) name: String,
    pub(super) configuration: ProxyConfiguration,
}

impl CreateProxyProfileRequest {
    pub(super) fn validate(self) -> Result<ValidatedProxyWrite, ConfigurationValidationError> {
        let write = validate_proxy_write(self.name, self.configuration)?;
        validate_private_key_for_save(&write.configuration)?;
        Ok(write)
    }
}

impl UpdateProxyProfileRequest {
    pub(super) fn validate(self) -> Result<ValidatedProxyWrite, ConfigurationValidationError> {
        if self.expected_version == 0 {
            return Err(ConfigurationValidationError::invalid_version());
        }
        let write = validate_proxy_write(self.name, self.configuration)?;
        validate_private_key_for_save(&write.configuration)?;
        Ok(write)
    }
}

impl DeleteProxyProfileRequest {
    pub(super) fn validate(&self) -> Result<(), ConfigurationValidationError> {
        if self.expected_version == 0 {
            return Err(ConfigurationValidationError::invalid_version());
        }
        Ok(())
    }
}

impl RemoveProxySshHostKeyRequest {
    pub(super) fn validate(&self) -> Result<(), ConfigurationValidationError> {
        if self.expected_version == 0 {
            return Err(ConfigurationValidationError::invalid_version());
        }
        Ok(())
    }
}

impl ConfirmProxySshHostKeyRequest {
    pub(super) fn validate(&self) -> Result<(), ConfigurationValidationError> {
        if self.expected_version == 0 {
            return Err(ConfigurationValidationError::invalid_version());
        }
        validate_host_key_record(
            &self.host,
            self.port,
            &self.algorithm,
            &self.sha256_fingerprint,
        )
    }
}

impl RecordProxyTestRequest {
    pub(super) fn validate(&self) -> Result<(), ConfigurationValidationError> {
        if self.expected_version == 0 {
            return Err(ConfigurationValidationError::invalid_version());
        }
        Ok(())
    }
}

fn validate_proxy_write(
    name: String,
    configuration: ProxyConfigurationRequest,
) -> Result<ValidatedProxyWrite, ConfigurationValidationError> {
    let name = validate_name(name, ConfigurationValidationError::invalid_proxy_name)?;
    let configuration = validate_proxy_configuration(configuration)?;
    Ok(ValidatedProxyWrite {
        name,
        configuration,
    })
}

impl ProxyConfigurationRequest {
    pub(crate) fn validate_for_connection_test(
        self,
    ) -> Result<ProxyConfiguration, ConfigurationValidationError> {
        validate_proxy_configuration(self)
    }
}

fn validate_proxy_configuration(
    configuration: ProxyConfigurationRequest,
) -> Result<ProxyConfiguration, ConfigurationValidationError> {
    let configuration = match configuration {
        ProxyConfigurationRequest::HttpConnect {
            url,
            authentication,
            username,
            non_sensitive_headers,
            connect_timeout_ms,
            tls_certificate_policy,
        } => {
            validate_connect_timeout(connect_timeout_ms)?;
            validate_headers(&non_sensitive_headers, is_reserved_http_connect_header)?;
            validate_http_proxy_url(&url, tls_certificate_policy)?;
            validate_optional_username(
                authentication == HttpProxyAuthentication::Basic,
                &username,
            )?;
            if authentication == HttpProxyAuthentication::Basic
                && username
                    .as_deref()
                    .is_some_and(|username| username.contains(':'))
            {
                return Err(ConfigurationValidationError::invalid_username());
            }
            ProxyConfiguration::HttpConnect {
                url,
                authentication,
                username,
                non_sensitive_headers,
                connect_timeout_ms,
                tls_certificate_policy,
            }
        }
        ProxyConfigurationRequest::Socks5 {
            host,
            port,
            authentication,
            username,
            dns_resolution,
            connect_timeout_ms,
        } => {
            validate_connect_timeout(connect_timeout_ms)?;
            validate_host(&host)?;
            if port == 0 {
                return Err(ConfigurationValidationError::invalid_port());
            }
            validate_optional_username(
                authentication == Socks5Authentication::UsernamePassword,
                &username,
            )?;
            ProxyConfiguration::Socks5 {
                host,
                port,
                authentication,
                username,
                dns_resolution,
                connect_timeout_ms,
            }
        }
        ProxyConfigurationRequest::Ssh {
            host,
            port,
            username,
            authentication,
            connect_timeout_ms,
            keep_alive_interval_ms,
            keep_alive_max_failures,
        } => {
            validate_connect_timeout(connect_timeout_ms)?;
            validate_host(&host)?;
            if port == 0 {
                return Err(ConfigurationValidationError::invalid_port());
            }
            validate_username(&username)?;
            if !(MIN_KEEP_ALIVE_INTERVAL_MS..=MAX_KEEP_ALIVE_INTERVAL_MS)
                .contains(&keep_alive_interval_ms)
            {
                return Err(ConfigurationValidationError::invalid_keep_alive_interval());
            }
            if !(1..=MAX_KEEP_ALIVE_FAILURES).contains(&keep_alive_max_failures) {
                return Err(ConfigurationValidationError::invalid_keep_alive_failures());
            }
            if let SshAuthenticationConfiguration::PrivateKey { private_key_path } = &authentication
            {
                validate_absolute_path(private_key_path)
                    .map_err(|_| ConfigurationValidationError::invalid_private_key_path())?;
            }
            ProxyConfiguration::Ssh {
                host,
                port,
                username,
                authentication,
                connect_timeout_ms,
                keep_alive_interval_ms,
                keep_alive_max_failures,
            }
        }
    };
    Ok(configuration)
}

fn validate_private_key_for_save(
    configuration: &ProxyConfiguration,
) -> Result<(), ConfigurationValidationError> {
    let ProxyConfiguration::Ssh {
        authentication: SshAuthenticationConfiguration::PrivateKey { private_key_path },
        ..
    } = configuration
    else {
        return Ok(());
    };

    let metadata = fs::metadata(private_key_path)
        .map_err(|_| ConfigurationValidationError::invalid_private_key_path())?;
    if !metadata.is_file() {
        return Err(ConfigurationValidationError::invalid_private_key_path());
    }

    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "linux")]
    options.custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32);
    let file = options
        .open(private_key_path)
        .map_err(|_| ConfigurationValidationError::invalid_private_key_path())?;
    let opened_metadata = file
        .metadata()
        .map_err(|_| ConfigurationValidationError::invalid_private_key_path())?;
    if !opened_metadata.is_file() {
        return Err(ConfigurationValidationError::invalid_private_key_path());
    }
    Ok(())
}

impl ProxyConfiguration {
    pub(super) fn validate_persisted(
        self,
        name: String,
    ) -> Result<ValidatedProxyWrite, ConfigurationValidationError> {
        let request = match self {
            Self::HttpConnect {
                url,
                authentication,
                username,
                non_sensitive_headers,
                connect_timeout_ms,
                tls_certificate_policy,
            } => ProxyConfigurationRequest::HttpConnect {
                url,
                authentication,
                username,
                non_sensitive_headers,
                connect_timeout_ms,
                tls_certificate_policy,
            },
            Self::Socks5 {
                host,
                port,
                authentication,
                username,
                dns_resolution,
                connect_timeout_ms,
            } => ProxyConfigurationRequest::Socks5 {
                host,
                port,
                authentication,
                username,
                dns_resolution,
                connect_timeout_ms,
            },
            Self::Ssh {
                host,
                port,
                username,
                authentication,
                connect_timeout_ms,
                keep_alive_interval_ms,
                keep_alive_max_failures,
            } => ProxyConfigurationRequest::Ssh {
                host,
                port,
                username,
                authentication,
                connect_timeout_ms,
                keep_alive_interval_ms,
                keep_alive_max_failures,
            },
        };
        validate_proxy_write(name, request)
    }
}

fn validate_name(
    name: String,
    error: fn() -> ConfigurationValidationError,
) -> Result<String, ConfigurationValidationError> {
    let name = name.trim();
    if name.is_empty() || name.len() > MAX_NAME_BYTES || name.chars().any(char::is_control) {
        return Err(error());
    }
    Ok(name.to_owned())
}

fn validate_absolute_path(value: &str) -> Result<(), ()> {
    if value.is_empty()
        || value.len() > MAX_PATH_BYTES
        || value.contains('\0')
        || !Path::new(value).is_absolute()
    {
        Err(())
    } else {
        Ok(())
    }
}

fn validate_environment(
    environment: &BTreeMap<String, String>,
) -> Result<(), ConfigurationValidationError> {
    if environment.len() > MAX_ENVIRONMENT_COUNT {
        return Err(ConfigurationValidationError::invalid_environment());
    }
    for (name, value) in environment {
        let mut characters = name.chars();
        let valid_first = characters
            .next()
            .is_some_and(|character| character == '_' || character.is_ascii_alphabetic());
        if !valid_first
            || !characters.all(|character| character == '_' || character.is_ascii_alphanumeric())
            || name.len() > MAX_ENVIRONMENT_NAME_BYTES
            || looks_sensitive_environment_name(name)
            || value.len() > MAX_ENVIRONMENT_VALUE_BYTES
            || value.contains('\0')
        {
            return Err(ConfigurationValidationError::invalid_environment());
        }
    }
    Ok(())
}

fn validate_headers(
    headers: &BTreeMap<String, String>,
    is_reserved_header: fn(&str) -> bool,
) -> Result<(), ConfigurationValidationError> {
    if headers.len() > MAX_HEADER_COUNT {
        return Err(ConfigurationValidationError::invalid_headers());
    }
    let mut normalized_names = BTreeSet::new();
    for (name, value) in headers {
        if name.len() > MAX_HEADER_NAME_BYTES
            || value.len() > MAX_HEADER_VALUE_BYTES
            || looks_sensitive_identifier(name)
            || is_reserved_header(name)
            || HeaderName::from_str(name).is_err()
            || HeaderValue::from_str(value).is_err()
            || !normalized_names.insert(name.to_ascii_lowercase())
        {
            return Err(ConfigurationValidationError::invalid_headers());
        }
    }
    Ok(())
}

fn validate_connect_timeout(value: u64) -> Result<(), ConfigurationValidationError> {
    if !(MIN_CONNECT_TIMEOUT_MS..=MAX_CONNECT_TIMEOUT_MS).contains(&value) {
        Err(ConfigurationValidationError::invalid_connect_timeout())
    } else {
        Ok(())
    }
}

fn validate_websocket_url(
    value: &str,
    plaintext_confirmed: bool,
    tls_policy: TlsCertificatePolicy,
) -> Result<(), ConfigurationValidationError> {
    if value.is_empty() || value.len() > MAX_URL_BYTES {
        return Err(ConfigurationValidationError::invalid_websocket_url());
    }
    let url =
        Url::parse(value).map_err(|_| ConfigurationValidationError::invalid_websocket_url())?;
    let is_plaintext = match url.scheme() {
        "ws" => true,
        "wss" => false,
        _ => return Err(ConfigurationValidationError::invalid_websocket_url()),
    };
    if !url.username().is_empty()
        || url.password().is_some()
        || url.host().is_none()
        || url.fragment().is_some()
        || url
            .query_pairs()
            .any(|(name, _)| looks_sensitive_identifier(name.as_ref()))
    {
        return Err(ConfigurationValidationError::invalid_websocket_url());
    }
    if is_plaintext != plaintext_confirmed {
        return Err(ConfigurationValidationError::invalid_plaintext_confirmation());
    }
    if is_plaintext && tls_policy != TlsCertificatePolicy::Strict {
        return Err(ConfigurationValidationError::invalid_tls_policy());
    }
    Ok(())
}

fn validate_http_proxy_url(
    value: &str,
    tls_policy: TlsCertificatePolicy,
) -> Result<(), ConfigurationValidationError> {
    if value.is_empty() || value.len() > MAX_URL_BYTES {
        return Err(ConfigurationValidationError::invalid_proxy_url());
    }
    let url = Url::parse(value).map_err(|_| ConfigurationValidationError::invalid_proxy_url())?;
    let is_tls = match url.scheme() {
        "http" => false,
        "https" => true,
        _ => return Err(ConfigurationValidationError::invalid_proxy_url()),
    };
    if !url.username().is_empty()
        || url.password().is_some()
        || url.host().is_none()
        || !matches!(url.path(), "" | "/")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(ConfigurationValidationError::invalid_proxy_url());
    }
    if !is_tls && tls_policy != TlsCertificatePolicy::Strict {
        return Err(ConfigurationValidationError::invalid_tls_policy());
    }
    Ok(())
}

fn validate_host(value: &str) -> Result<(), ConfigurationValidationError> {
    if value.is_empty() || value.len() > MAX_HOST_BYTES {
        return Err(ConfigurationValidationError::invalid_host());
    }
    if value.parse::<IpAddr>().is_ok() {
        return Ok(());
    }
    match Host::parse(value) {
        Ok(Host::Domain(domain)) if !domain.is_empty() && domain.len() <= MAX_HOST_BYTES => Ok(()),
        Ok(Host::Ipv4(_) | Host::Ipv6(_)) => Ok(()),
        _ => Err(ConfigurationValidationError::invalid_host()),
    }
}

fn validate_username(value: &str) -> Result<(), ConfigurationValidationError> {
    if value.trim().is_empty()
        || value.len() > MAX_USERNAME_BYTES
        || value.chars().any(char::is_control)
    {
        Err(ConfigurationValidationError::invalid_username())
    } else {
        Ok(())
    }
}

fn validate_optional_username(
    required: bool,
    username: &Option<String>,
) -> Result<(), ConfigurationValidationError> {
    match (required, username) {
        (true, Some(username)) => validate_username(username),
        (false, None) => Ok(()),
        _ => Err(ConfigurationValidationError::invalid_username()),
    }
}

pub(super) fn validate_host_key_record(
    host: &str,
    port: u16,
    algorithm: &str,
    fingerprint: &str,
) -> Result<(), ConfigurationValidationError> {
    validate_host(host)?;
    if port == 0 {
        return Err(ConfigurationValidationError::invalid_port());
    }
    if algorithm.trim().is_empty()
        || algorithm.len() > MAX_ALGORITHM_BYTES
        || algorithm.chars().any(char::is_control)
    {
        return Err(ConfigurationValidationError::invalid_host_key());
    }
    let fingerprint = Fingerprint::from_str(fingerprint)
        .map_err(|_| ConfigurationValidationError::invalid_host_key())?;
    if !fingerprint.is_sha256() {
        return Err(ConfigurationValidationError::invalid_host_key());
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ConfigurationValidationError {
    pub(super) code: &'static str,
    pub(super) message: &'static str,
}

impl ConfigurationValidationError {
    const fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }

    const fn invalid_server_name() -> Self {
        Self::new("invalidServerName", "The server name is invalid")
    }

    const fn invalid_proxy_name() -> Self {
        Self::new("invalidProxyName", "The proxy name is invalid")
    }

    const fn invalid_version() -> Self {
        Self::new(
            "invalidConfigurationVersion",
            "The configuration version is invalid",
        )
    }

    const fn invalid_executable_path() -> Self {
        Self::new(
            "invalidExecutablePath",
            "The executable path must be absolute",
        )
    }

    const fn invalid_working_directory() -> Self {
        Self::new(
            "invalidWorkingDirectory",
            "The working directory must be absolute",
        )
    }

    const fn invalid_private_key_path() -> Self {
        Self::new(
            "invalidSshPrivateKeyPath",
            "The SSH private key must be an absolute, readable regular file",
        )
    }

    const fn invalid_arguments() -> Self {
        Self::new("invalidServerArguments", "The server arguments are invalid")
    }

    const fn invalid_environment() -> Self {
        Self::new(
            "invalidNonSensitiveEnvironment",
            "The non-sensitive environment is invalid",
        )
    }

    const fn invalid_headers() -> Self {
        Self::new(
            "invalidNonSensitiveHeaders",
            "The non-sensitive headers are invalid",
        )
    }

    const fn invalid_websocket_url() -> Self {
        Self::new("invalidWebSocketUrl", "The WebSocket URL is invalid")
    }

    const fn invalid_proxy_url() -> Self {
        Self::new("invalidProxyUrl", "The proxy URL is invalid")
    }

    const fn invalid_plaintext_confirmation() -> Self {
        Self::new(
            "invalidPlaintextConfirmation",
            "Plaintext WebSocket transport must be confirmed explicitly",
        )
    }

    const fn invalid_tls_policy() -> Self {
        Self::new(
            "invalidTlsCertificatePolicy",
            "The TLS certificate policy is invalid",
        )
    }

    const fn invalid_connect_timeout() -> Self {
        Self::new("invalidConnectTimeout", "The connection timeout is invalid")
    }

    const fn invalid_host() -> Self {
        Self::new("invalidProxyHost", "The proxy host is invalid")
    }

    const fn invalid_port() -> Self {
        Self::new("invalidProxyPort", "The proxy port is invalid")
    }

    const fn invalid_username() -> Self {
        Self::new("invalidProxyUsername", "The proxy username is invalid")
    }

    const fn invalid_keep_alive_interval() -> Self {
        Self::new(
            "invalidSshKeepAliveInterval",
            "The SSH keep-alive interval is invalid",
        )
    }

    const fn invalid_keep_alive_failures() -> Self {
        Self::new(
            "invalidSshKeepAliveFailures",
            "The SSH keep-alive failure count is invalid",
        )
    }

    const fn invalid_host_key() -> Self {
        Self::new(
            "invalidSshHostKeyRecord",
            "The SSH host key record is invalid",
        )
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        CreateProxyProfileRequest, CreateServerProfileRequest, MAX_ENVIRONMENT_NAME_BYTES,
        ProxyConfiguration, ServerConfiguration, ServerConfigurationInput,
        SshAuthenticationConfiguration,
    };

    #[test]
    fn validates_and_normalizes_non_sensitive_server_profiles() {
        let request: CreateServerProfileRequest = serde_json::from_value(json!({
            "name": "  Local Codex  ",
            "configuration": {
                "type": "localStdio",
                "executablePath": "/usr/bin/codex",
                "arguments": ["app-server"],
                "defaultWorkingDirectory": "/tmp/project",
                "nonSensitiveEnvironment": { "CODEX_MODE": "desktop" }
            }
        }))
        .expect("server request should deserialize");
        let validated = request.validate().expect("server request should validate");
        assert_eq!(validated.name, "Local Codex");
        assert!(matches!(
            validated.configuration,
            ServerConfiguration::LocalStdio { .. }
        ));
    }

    #[test]
    fn validates_server_draft_configuration_without_a_profile_name() {
        let input: ServerConfigurationInput = serde_json::from_value(json!({
            "type": "remoteWebSocket",
            "url": "wss://example.test/app",
            "authentication": "none",
            "connectTimeoutMs": 5000,
            "tlsCertificatePolicy": "strict",
            "plaintextConfirmed": false
        }))
        .expect("draft configuration should deserialize");
        assert!(matches!(
            input.validate().unwrap(),
            ServerConfiguration::RemoteWebSocket { .. }
        ));

        let invalid: ServerConfigurationInput = serde_json::from_value(json!({
            "type": "remoteWebSocket",
            "url": "https://example.test/app",
            "authentication": "none",
            "connectTimeoutMs": 5000,
            "tlsCertificatePolicy": "strict",
            "plaintextConfirmed": false
        }))
        .expect("structurally valid draft should deserialize");
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn rejects_secrets_from_server_configuration_payloads() {
        let payload = json!({
            "name": "Remote",
            "configuration": {
                "type": "remoteWebSocket",
                "url": "wss://example.test/app",
                "authentication": "bearer",
                "token": "DO_NOT_STORE",
                "connectTimeoutMs": 5000,
                "tlsCertificatePolicy": "strict",
                "plaintextConfirmed": false
            }
        });
        let error = serde_json::from_value::<CreateServerProfileRequest>(payload)
            .expect_err("secret fields must be rejected");
        assert!(!error.to_string().contains("DO_NOT_STORE"));
    }

    #[test]
    fn validates_all_proxy_shapes_without_credentials() {
        let readable_private_key_path =
            format!("{}/src/configuration/model.rs", env!("CARGO_MANIFEST_DIR"));
        let payloads = [
            json!({
                "name": "HTTP",
                "configuration": {
                    "type": "httpConnect",
                    "url": "https://proxy.example.test:8443",
                    "authentication": "basic",
                    "username": "alice",
                    "connectTimeoutMs": 5000,
                    "tlsCertificatePolicy": "strict"
                }
            }),
            json!({
                "name": "SOCKS",
                "configuration": {
                    "type": "socks5",
                    "host": "proxy.example.test",
                    "port": 1080,
                    "authentication": "usernamePassword",
                    "username": "alice",
                    "dnsResolution": "proxy",
                    "connectTimeoutMs": 5000
                }
            }),
            json!({
                "name": "SSH",
                "configuration": {
                    "type": "ssh",
                    "host": "ssh.example.test",
                    "username": "alice",
                    "authentication": {
                        "type": "privateKey",
                        "privateKeyPath": readable_private_key_path
                    },
                    "connectTimeoutMs": 5000,
                    "keepAliveIntervalMs": 15000,
                    "keepAliveMaxFailures": 3
                }
            }),
        ];
        for payload in payloads {
            let request: CreateProxyProfileRequest =
                serde_json::from_value(payload).expect("proxy request should deserialize");
            let validated = request.validate().expect("proxy request should validate");
            assert!(matches!(
                validated.configuration,
                ProxyConfiguration::HttpConnect { .. }
                    | ProxyConfiguration::Socks5 { .. }
                    | ProxyConfiguration::Ssh { .. }
            ));
        }
    }

    #[test]
    fn rejects_secret_fields_and_sensitive_non_secret_names() {
        let payload = json!({
            "name": "SSH",
            "configuration": {
                "type": "ssh",
                "host": "ssh.example.test",
                "username": "alice",
                "authentication": { "type": "password", "password": "DO_NOT_STORE" },
                "connectTimeoutMs": 5000,
                "keepAliveIntervalMs": 15000,
                "keepAliveMaxFailures": 3
            }
        });
        let error = serde_json::from_value::<CreateProxyProfileRequest>(payload)
            .expect_err("SSH password must not enter the configuration payload");
        assert!(!error.to_string().contains("DO_NOT_STORE"));

        let request: CreateServerProfileRequest = serde_json::from_value(json!({
            "name": "Local",
            "configuration": {
                "type": "localStdio",
                "executablePath": "/usr/bin/codex",
                "arguments": [],
                "nonSensitiveEnvironment": { "API_TOKEN": "DO_NOT_STORE" }
            }
        }))
        .expect("server request should deserialize");
        assert!(request.validate().is_err());
    }

    #[test]
    fn matches_transport_sensitive_identifier_rules() {
        for environment_name in [
            "ACCESSKEY".to_owned(),
            "SSH_AUTH_SOCK".to_owned(),
            "A".repeat(MAX_ENVIRONMENT_NAME_BYTES + 1),
        ] {
            let request: CreateServerProfileRequest = serde_json::from_value(json!({
                "name": "Local",
                "configuration": {
                    "type": "localStdio",
                    "executablePath": "/usr/bin/codex",
                    "arguments": [],
                    "nonSensitiveEnvironment": { (environment_name): "value" }
                }
            }))
            .expect("server request should deserialize");
            assert!(request.validate().is_err());
        }

        for configuration in [
            json!({
                "type": "remoteWebSocket",
                "url": "wss://example.test/app",
                "authentication": "none",
                "nonSensitiveHeaders": { "X-Auth": "value" },
                "connectTimeoutMs": 5000,
                "tlsCertificatePolicy": "strict",
                "plaintextConfirmed": false
            }),
            json!({
                "type": "remoteWebSocket",
                "url": "wss://example.test/app",
                "authentication": "none",
                "nonSensitiveHeaders": { "Sec-WebSocket-Foo": "value" },
                "connectTimeoutMs": 5000,
                "tlsCertificatePolicy": "strict",
                "plaintextConfirmed": false
            }),
            json!({
                "type": "remoteWebSocket",
                "url": "wss://example.test/app",
                "authentication": "none",
                "nonSensitiveHeaders": { "Proxy-Foo": "value" },
                "connectTimeoutMs": 5000,
                "tlsCertificatePolicy": "strict",
                "plaintextConfirmed": false
            }),
            json!({
                "type": "remoteWebSocket",
                "url": "wss://example.test/app?session=value",
                "authentication": "none",
                "connectTimeoutMs": 5000,
                "tlsCertificatePolicy": "strict",
                "plaintextConfirmed": false
            }),
        ] {
            let request: CreateServerProfileRequest = serde_json::from_value(json!({
                "name": "Remote",
                "configuration": configuration
            }))
            .expect("server request should deserialize");
            assert!(request.validate().is_err());
        }

        for header_name in ["Proxy-Authenticate", "Sec-WebSocket-Foo", "TE", "Trailer"] {
            let request: CreateProxyProfileRequest = serde_json::from_value(json!({
                "name": "HTTP",
                "configuration": {
                    "type": "httpConnect",
                    "url": "https://proxy.example.test",
                    "authentication": "none",
                    "nonSensitiveHeaders": { (header_name): "value" },
                    "connectTimeoutMs": 5000,
                    "tlsCertificatePolicy": "strict"
                }
            }))
            .expect("proxy request should deserialize");
            assert!(request.validate().is_err(), "{header_name}");
        }

        let request: CreateProxyProfileRequest = serde_json::from_value(json!({
            "name": "HTTP",
            "configuration": {
                "type": "httpConnect",
                "url": "https://proxy.example.test",
                "authentication": "basic",
                "username": "alice:administrator",
                "connectTimeoutMs": 5000,
                "tlsCertificatePolicy": "strict"
            }
        }))
        .expect("proxy request should deserialize");
        assert!(request.validate().is_err());
    }

    #[test]
    fn validates_ipv6_and_rejects_backslash_hosts() {
        for (host, should_succeed) in [("[::1]", true), ("example.test\\evil", false)] {
            let request: CreateProxyProfileRequest = serde_json::from_value(json!({
                "name": "SOCKS",
                "configuration": {
                    "type": "socks5",
                    "host": host,
                    "port": 1080,
                    "authentication": "none",
                    "dnsResolution": "proxy",
                    "connectTimeoutMs": 5000
                }
            }))
            .expect("proxy request should deserialize");
            assert_eq!(request.validate().is_ok(), should_succeed, "{host}");
        }
    }

    #[test]
    fn checks_private_key_access_only_when_saving() {
        let missing_path = format!(
            "/tmp/codex-desktop-missing-private-key-{}",
            uuid::Uuid::new_v4()
        );
        let request: CreateProxyProfileRequest = serde_json::from_value(json!({
            "name": "SSH",
            "configuration": {
                "type": "ssh",
                "host": "ssh.example.test",
                "username": "alice",
                "authentication": {
                    "type": "privateKey",
                    "privateKeyPath": &missing_path
                },
                "connectTimeoutMs": 5000,
                "keepAliveIntervalMs": 15000,
                "keepAliveMaxFailures": 3
            }
        }))
        .expect("proxy request should deserialize");
        assert!(request.validate().is_err());

        let persisted = ProxyConfiguration::Ssh {
            host: "ssh.example.test".to_owned(),
            port: 22,
            username: "alice".to_owned(),
            authentication: SshAuthenticationConfiguration::PrivateKey {
                private_key_path: missing_path,
            },
            connect_timeout_ms: 5_000,
            keep_alive_interval_ms: 15_000,
            keep_alive_max_failures: 3,
        };
        assert!(persisted.validate_persisted("SSH".to_owned()).is_ok());
    }
}
