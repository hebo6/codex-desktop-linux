use crate::credentials::{CredentialDescriptor, CredentialReference};

use super::credential_model::ResolvedCredential;
use super::model::{ProxyConfiguration, ProxyId, ServerConfiguration, ServerId, SshHostKeyRecord};

pub(crate) struct CredentialBinding {
    pub(crate) reference: CredentialReference,
    pub(crate) descriptor: CredentialDescriptor,
}

pub(crate) struct ServerConnectionPlan {
    pub(crate) server_id: ServerId,
    pub(crate) server_version: u64,
    pub(crate) configuration: ServerConfiguration,
    pub(crate) credential: Option<CredentialBinding>,
    pub(crate) proxy: Option<ProxyConnectionPlan>,
}

pub(crate) struct DraftServerConnectionPlan {
    pub(crate) configuration: ServerConfiguration,
    pub(crate) credential: Option<CredentialBinding>,
    pub(crate) proxy: Option<ProxyConnectionPlan>,
}

pub(crate) struct ProxyConnectionPlan {
    pub(crate) proxy_id: ProxyId,
    pub(crate) proxy_version: u64,
    pub(crate) configuration: ProxyConfiguration,
    pub(crate) credential: Option<CredentialBinding>,
    pub(crate) ssh_host_key: Option<SshHostKeyRecord>,
}

pub(crate) struct ResolvedServerConnection {
    pub(crate) server_id: ServerId,
    pub(crate) server_version: u64,
    pub(crate) configuration: ServerConfiguration,
    pub(crate) credential: Option<ResolvedCredential>,
    pub(crate) proxy: Option<ResolvedProxyConnection>,
}

pub(crate) struct ResolvedDraftServerConnection {
    pub(crate) configuration: ServerConfiguration,
    pub(crate) credential: Option<ResolvedCredential>,
    pub(crate) proxy: Option<ResolvedDraftProxyConnection>,
}

pub(crate) struct ResolvedDraftProxyConnection {
    pub(crate) proxy_id: Option<ProxyId>,
    pub(crate) proxy_version: Option<u64>,
    pub(crate) configuration: ProxyConfiguration,
    pub(crate) credential: Option<ResolvedCredential>,
    pub(crate) ssh_host_key: Option<SshHostKeyRecord>,
}

pub(crate) struct ResolvedProxyConnection {
    pub(crate) proxy_id: ProxyId,
    pub(crate) proxy_version: u64,
    pub(crate) configuration: ProxyConfiguration,
    pub(crate) credential: Option<ResolvedCredential>,
    pub(crate) ssh_host_key: Option<SshHostKeyRecord>,
}
