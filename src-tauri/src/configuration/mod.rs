pub(crate) mod commands;
mod connection_plan;
mod credential_model;
mod credential_service;
mod model;
mod repository;

pub(crate) use connection_plan::{
    CredentialBinding, DraftServerConnectionPlan, ProxyConnectionPlan,
    ResolvedDraftProxyConnection, ResolvedDraftServerConnection, ResolvedProxyConnection,
    ResolvedServerConnection, ServerConnectionPlan,
};
pub(crate) use credential_model::{
    ClearProxyCredentialRequest, ClearServerCredentialRequest, ProxyConnectionTestCredentialSource,
    ResolvedCredential, SecretText, SensitiveEnvironment, ServerConnectionTestCredentialSource,
    SetProxyCredentialRequest, SetServerCredentialRequest,
};
pub(crate) use credential_service::{
    CredentialManager, CredentialOperationError, DraftProxyConnectionInput,
};
pub(crate) use model::{
    ConfigurationSnapshot, ConfigurationValidationError, ConfirmProxySshHostKeyRequest,
    CreateProxyProfileRequest, CreateServerProfileRequest, DeleteProxyProfileRequest,
    DeleteServerProfileRequest, HttpProxyAuthentication, ProxyConfiguration,
    ProxyConfigurationRequest, ProxyId, ProxyProfile, RecordProxyTestRequest,
    RemoteServerAuthentication, RemoveProxySshHostKeyRequest, ServerConfiguration,
    ServerConfigurationInput, ServerId, ServerProfile, Socks5Authentication, Socks5DnsResolution,
    SshAuthenticationConfiguration, SshHostKeyRecord, TlsCertificatePolicy,
    UpdateProxyProfileRequest, UpdateServerProfileRequest,
};
pub(crate) use repository::{ConfigurationRepository, ConfigurationRepositoryError};
