mod plaintext_file_store;
mod preferred_store;
mod secret_service_store;

use std::{fmt, future::Future, io, pin::Pin};

use uuid::{Uuid, Variant};
use zeroize::Zeroizing;

pub(crate) use plaintext_file_store::PlaintextFileCredentialStore;
pub(crate) use preferred_store::{CredentialStorageBackend, PreferredCredentialStore};
pub(crate) use secret_service_store::SecretServiceCredentialStore;

const CREDENTIAL_REFERENCE_PREFIX: &str = "credential:v1:";

#[derive(Clone, PartialEq, Eq, Hash)]
pub(crate) struct CredentialReference(String);

impl CredentialReference {
    pub(crate) fn new() -> Self {
        Self(format!(
            "{CREDENTIAL_REFERENCE_PREFIX}{}",
            Uuid::new_v4().hyphenated()
        ))
    }

    pub(crate) fn parse(value: &str) -> Result<Self, CredentialReferenceError> {
        let uuid_text = value
            .strip_prefix(CREDENTIAL_REFERENCE_PREFIX)
            .ok_or(CredentialReferenceError)?;
        let uuid = Uuid::parse_str(uuid_text).map_err(|_| CredentialReferenceError)?;
        if uuid.get_version_num() != 4
            || uuid.get_variant() != Variant::RFC4122
            || uuid.hyphenated().to_string() != uuid_text
        {
            return Err(CredentialReferenceError);
        }
        Ok(Self(value.to_owned()))
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }

    fn file_name(&self) -> String {
        format!(
            "{}.credential",
            self.0
                .strip_prefix(CREDENTIAL_REFERENCE_PREFIX)
                .expect("a credential reference always has the canonical prefix")
        )
    }
}

impl fmt::Debug for CredentialReference {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CredentialReference([redacted])")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum ServerCredentialKind {
    SensitiveEnvironment,
    BearerToken,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum ProxyCredentialKind {
    HttpBasicPassword,
    HttpBearerToken,
    Socks5Password,
    SshPrivateKeyPassphrase,
    SshPassword,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum CredentialDescriptor {
    Server {
        server_id: Uuid,
        kind: ServerCredentialKind,
    },
    Proxy {
        proxy_id: Uuid,
        kind: ProxyCredentialKind,
    },
}

impl CredentialDescriptor {
    pub(crate) fn parse(
        owner_kind: &str,
        owner_id: &str,
        credential_kind: &str,
    ) -> Result<Self, CredentialReferenceError> {
        let owner_id = parse_canonical_v4_uuid(owner_id)?;
        match (owner_kind, credential_kind) {
            ("server", "sensitive-environment") => Ok(Self::Server {
                server_id: owner_id,
                kind: ServerCredentialKind::SensitiveEnvironment,
            }),
            ("server", "bearer-token") => Ok(Self::Server {
                server_id: owner_id,
                kind: ServerCredentialKind::BearerToken,
            }),
            ("proxy", "http-basic-password") => Ok(Self::Proxy {
                proxy_id: owner_id,
                kind: ProxyCredentialKind::HttpBasicPassword,
            }),
            ("proxy", "http-bearer-token") => Ok(Self::Proxy {
                proxy_id: owner_id,
                kind: ProxyCredentialKind::HttpBearerToken,
            }),
            ("proxy", "socks5-password") => Ok(Self::Proxy {
                proxy_id: owner_id,
                kind: ProxyCredentialKind::Socks5Password,
            }),
            ("proxy", "ssh-private-key-passphrase") => Ok(Self::Proxy {
                proxy_id: owner_id,
                kind: ProxyCredentialKind::SshPrivateKeyPassphrase,
            }),
            ("proxy", "ssh-password") => Ok(Self::Proxy {
                proxy_id: owner_id,
                kind: ProxyCredentialKind::SshPassword,
            }),
            _ => Err(CredentialReferenceError),
        }
    }

    pub(crate) fn owner_kind(self) -> &'static str {
        match self {
            Self::Server { .. } => "server",
            Self::Proxy { .. } => "proxy",
        }
    }

    pub(crate) fn owner_id(self) -> Uuid {
        match self {
            Self::Server { server_id, .. } => server_id,
            Self::Proxy { proxy_id, .. } => proxy_id,
        }
    }

    pub(crate) fn credential_kind(self) -> &'static str {
        match self {
            Self::Server {
                kind: ServerCredentialKind::SensitiveEnvironment,
                ..
            } => "sensitive-environment",
            Self::Server {
                kind: ServerCredentialKind::BearerToken,
                ..
            } => "bearer-token",
            Self::Proxy {
                kind: ProxyCredentialKind::HttpBasicPassword,
                ..
            } => "http-basic-password",
            Self::Proxy {
                kind: ProxyCredentialKind::HttpBearerToken,
                ..
            } => "http-bearer-token",
            Self::Proxy {
                kind: ProxyCredentialKind::Socks5Password,
                ..
            } => "socks5-password",
            Self::Proxy {
                kind: ProxyCredentialKind::SshPrivateKeyPassphrase,
                ..
            } => "ssh-private-key-passphrase",
            Self::Proxy {
                kind: ProxyCredentialKind::SshPassword,
                ..
            } => "ssh-password",
        }
    }

    pub(crate) fn content_type(self) -> &'static str {
        match self {
            Self::Server {
                kind: ServerCredentialKind::SensitiveEnvironment,
                ..
            } => "application/vnd.com.codexdesktop.linux.environment+json",
            _ => "text/plain;charset=utf-8",
        }
    }
}

fn parse_canonical_v4_uuid(value: &str) -> Result<Uuid, CredentialReferenceError> {
    let uuid = Uuid::parse_str(value).map_err(|_| CredentialReferenceError)?;
    if uuid.get_version_num() != 4
        || uuid.get_variant() != Variant::RFC4122
        || uuid.hyphenated().to_string() != value
    {
        return Err(CredentialReferenceError);
    }
    Ok(uuid)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PendingCredentialCleanup {
    pub(crate) reference: CredentialReference,
    pub(crate) descriptor: CredentialDescriptor,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CredentialReferenceError;

impl fmt::Display for CredentialReferenceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("the credential reference is invalid")
    }
}

impl std::error::Error for CredentialReferenceError {}

#[derive(Debug)]
pub(crate) enum CredentialStoreError {
    Unavailable,
    Locked,
    PromptDismissed,
    AccessDenied,
    TimedOut,
    NotFound,
    AlreadyExists,
    Duplicate,
    InvalidItem,
    PlaintextFallbackConfirmationRequired,
    Backend(secret_service::Error),
    Filesystem(io::Error),
}

impl fmt::Display for CredentialStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable => formatter.write_str("the credential store is unavailable"),
            Self::Locked => formatter.write_str("the credential store is locked"),
            Self::PromptDismissed => {
                formatter.write_str("the credential store prompt was dismissed")
            }
            Self::AccessDenied => formatter.write_str("credential access was denied"),
            Self::TimedOut => formatter.write_str("the credential store operation timed out"),
            Self::NotFound => formatter.write_str("the credential does not exist"),
            Self::AlreadyExists => formatter.write_str("the credential already exists"),
            Self::Duplicate => formatter.write_str("the credential reference is duplicated"),
            Self::InvalidItem => formatter.write_str("the credential item is invalid"),
            Self::PlaintextFallbackConfirmationRequired => {
                formatter.write_str("plaintext credential storage requires confirmation")
            }
            Self::Backend(_) => formatter.write_str("the credential store operation failed"),
            Self::Filesystem(_) => {
                formatter.write_str("the credential file operation failed")
            }
        }
    }
}

impl std::error::Error for CredentialStoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Backend(source) => Some(source),
            Self::Filesystem(source) => Some(source),
            _ => None,
        }
    }
}

pub(crate) type CredentialStoreFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, CredentialStoreError>> + Send + 'a>>;

pub(crate) trait CredentialStore: Send + Sync {
    fn create<'a>(
        &'a self,
        reference: &'a CredentialReference,
        descriptor: CredentialDescriptor,
        secret: &'a [u8],
    ) -> CredentialStoreFuture<'a, ()>;

    fn read<'a>(
        &'a self,
        reference: &'a CredentialReference,
        descriptor: CredentialDescriptor,
    ) -> CredentialStoreFuture<'a, Zeroizing<Vec<u8>>>;

    fn delete<'a>(
        &'a self,
        reference: &'a CredentialReference,
        descriptor: CredentialDescriptor,
    ) -> CredentialStoreFuture<'a, ()>;
}

pub(crate) trait CredentialStoreProbe: CredentialStore {
    fn probe(&self) -> CredentialStoreFuture<'_, ()>;
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::{
        CredentialDescriptor, CredentialReference, ProxyCredentialKind, ServerCredentialKind,
    };

    #[test]
    fn accepts_only_canonical_v4_credential_references() {
        let reference = CredentialReference::new();
        assert_eq!(
            CredentialReference::parse(reference.as_str()).unwrap(),
            reference
        );

        for value in [
            "credential:v1:11111111-1111-1111-8111-111111111111",
            "credential:v1:AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
            "11111111-1111-4111-8111-111111111111",
            "credential:v2:11111111-1111-4111-8111-111111111111",
        ] {
            assert!(CredentialReference::parse(value).is_err(), "{value}");
        }
    }

    #[test]
    fn descriptors_have_stable_scopes_kinds_and_content_types() {
        let server_id = Uuid::new_v4();
        let proxy_id = Uuid::new_v4();
        let cases = [
            (
                CredentialDescriptor::Server {
                    server_id,
                    kind: ServerCredentialKind::SensitiveEnvironment,
                },
                "server",
                "sensitive-environment",
                "application/vnd.com.codexdesktop.linux.environment+json",
            ),
            (
                CredentialDescriptor::Server {
                    server_id,
                    kind: ServerCredentialKind::BearerToken,
                },
                "server",
                "bearer-token",
                "text/plain;charset=utf-8",
            ),
            (
                CredentialDescriptor::Proxy {
                    proxy_id,
                    kind: ProxyCredentialKind::SshPrivateKeyPassphrase,
                },
                "proxy",
                "ssh-private-key-passphrase",
                "text/plain;charset=utf-8",
            ),
        ];

        for (descriptor, owner_kind, credential_kind, content_type) in cases {
            assert_eq!(descriptor.owner_kind(), owner_kind);
            assert_eq!(descriptor.credential_kind(), credential_kind);
            assert_eq!(descriptor.content_type(), content_type);
            assert_eq!(
                CredentialDescriptor::parse(
                    owner_kind,
                    &descriptor.owner_id().hyphenated().to_string(),
                    credential_kind,
                )
                .unwrap(),
                descriptor
            );
        }
    }

    #[test]
    fn debug_output_never_reveals_a_credential_reference() {
        let reference = CredentialReference::new();
        let output = format!("{reference:?}");
        assert!(!output.contains(reference.as_str()));
    }
}
