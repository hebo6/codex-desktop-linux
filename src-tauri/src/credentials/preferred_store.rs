use std::sync::Arc;

use serde::Serialize;
use zeroize::Zeroizing;

use super::{
    CredentialDescriptor, CredentialReference, CredentialStore, CredentialStoreError,
    CredentialStoreFuture, CredentialStoreProbe, PlaintextFileCredentialStore,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CredentialStorageBackend {
    SecretService,
    PlaintextFile,
    Mixed,
}

pub(crate) struct PreferredCredentialStore {
    primary: Arc<dyn CredentialStoreProbe>,
    fallback: Arc<PlaintextFileCredentialStore>,
}

impl PreferredCredentialStore {
    pub(crate) fn new(
        primary: Arc<dyn CredentialStoreProbe>,
        fallback: Arc<PlaintextFileCredentialStore>,
    ) -> Self {
        Self { primary, fallback }
    }

    pub(crate) async fn storage_backend(
        &self,
    ) -> Result<CredentialStorageBackend, CredentialStoreError> {
        match self.primary.probe().await {
            Ok(()) => {
                if self.fallback.contains_credentials().await? {
                    Ok(CredentialStorageBackend::Mixed)
                } else {
                    Ok(CredentialStorageBackend::SecretService)
                }
            }
            Err(CredentialStoreError::Unavailable) => {
                Ok(CredentialStorageBackend::PlaintextFile)
            }
            Err(error) => Err(error),
        }
    }

    pub(crate) fn create_with_plaintext_confirmation<'a>(
        &'a self,
        reference: &'a CredentialReference,
        descriptor: CredentialDescriptor,
        secret: &'a [u8],
        plaintext_fallback_confirmed: bool,
    ) -> CredentialStoreFuture<'a, ()> {
        Box::pin(async move {
            match self.primary.create(reference, descriptor, secret).await {
                Ok(()) => Ok(()),
                Err(CredentialStoreError::Unavailable) if plaintext_fallback_confirmed => {
                    self.fallback.create(reference, descriptor, secret).await
                }
                Err(CredentialStoreError::Unavailable) => {
                    Err(CredentialStoreError::PlaintextFallbackConfirmationRequired)
                }
                Err(error) => Err(error),
            }
        })
    }
}

impl CredentialStore for PreferredCredentialStore {
    fn create<'a>(
        &'a self,
        reference: &'a CredentialReference,
        descriptor: CredentialDescriptor,
        secret: &'a [u8],
    ) -> CredentialStoreFuture<'a, ()> {
        self.create_with_plaintext_confirmation(reference, descriptor, secret, false)
    }

    fn read<'a>(
        &'a self,
        reference: &'a CredentialReference,
        descriptor: CredentialDescriptor,
    ) -> CredentialStoreFuture<'a, Zeroizing<Vec<u8>>> {
        Box::pin(async move {
            match self.primary.read(reference, descriptor).await {
                Ok(secret) => Ok(secret),
                Err(primary_error @ CredentialStoreError::Unavailable)
                | Err(primary_error @ CredentialStoreError::NotFound) => {
                    match self.fallback.read(reference, descriptor).await {
                        Err(CredentialStoreError::NotFound) => Err(primary_error),
                        result => result,
                    }
                }
                Err(error) => Err(error),
            }
        })
    }

    fn delete<'a>(
        &'a self,
        reference: &'a CredentialReference,
        descriptor: CredentialDescriptor,
    ) -> CredentialStoreFuture<'a, ()> {
        Box::pin(async move {
            match self.primary.delete(reference, descriptor).await {
                Ok(()) => Ok(()),
                Err(primary_error @ CredentialStoreError::Unavailable)
                | Err(primary_error @ CredentialStoreError::NotFound) => {
                    match self.fallback.delete(reference, descriptor).await {
                        Err(CredentialStoreError::NotFound) => Err(primary_error),
                        result => result,
                    }
                }
                Err(error) => Err(error),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use uuid::Uuid;

    use super::{CredentialStorageBackend, PreferredCredentialStore};
    use crate::credentials::{
        CredentialDescriptor, CredentialReference, CredentialStore, CredentialStoreError,
        CredentialStoreFuture, CredentialStoreProbe, PlaintextFileCredentialStore,
        ServerCredentialKind,
    };

    struct UnavailableStore;
    struct LockedStore;
    struct AvailableMissingStore;

    impl CredentialStore for UnavailableStore {
        fn create<'a>(
            &'a self,
            _reference: &'a CredentialReference,
            _descriptor: CredentialDescriptor,
            _secret: &'a [u8],
        ) -> CredentialStoreFuture<'a, ()> {
            Box::pin(async { Err(CredentialStoreError::Unavailable) })
        }

        fn read<'a>(
            &'a self,
            _reference: &'a CredentialReference,
            _descriptor: CredentialDescriptor,
        ) -> CredentialStoreFuture<'a, zeroize::Zeroizing<Vec<u8>>> {
            Box::pin(async { Err(CredentialStoreError::Unavailable) })
        }

        fn delete<'a>(
            &'a self,
            _reference: &'a CredentialReference,
            _descriptor: CredentialDescriptor,
        ) -> CredentialStoreFuture<'a, ()> {
            Box::pin(async { Err(CredentialStoreError::Unavailable) })
        }
    }

    impl CredentialStoreProbe for UnavailableStore {
        fn probe(&self) -> CredentialStoreFuture<'_, ()> {
            Box::pin(async { Err(CredentialStoreError::Unavailable) })
        }
    }

    impl CredentialStore for LockedStore {
        fn create<'a>(
            &'a self,
            _reference: &'a CredentialReference,
            _descriptor: CredentialDescriptor,
            _secret: &'a [u8],
        ) -> CredentialStoreFuture<'a, ()> {
            Box::pin(async { Err(CredentialStoreError::Locked) })
        }

        fn read<'a>(
            &'a self,
            _reference: &'a CredentialReference,
            _descriptor: CredentialDescriptor,
        ) -> CredentialStoreFuture<'a, zeroize::Zeroizing<Vec<u8>>> {
            Box::pin(async { Err(CredentialStoreError::Locked) })
        }

        fn delete<'a>(
            &'a self,
            _reference: &'a CredentialReference,
            _descriptor: CredentialDescriptor,
        ) -> CredentialStoreFuture<'a, ()> {
            Box::pin(async { Err(CredentialStoreError::Locked) })
        }
    }

    impl CredentialStoreProbe for LockedStore {
        fn probe(&self) -> CredentialStoreFuture<'_, ()> {
            Box::pin(async { Ok(()) })
        }
    }

    impl CredentialStore for AvailableMissingStore {
        fn create<'a>(
            &'a self,
            _reference: &'a CredentialReference,
            _descriptor: CredentialDescriptor,
            _secret: &'a [u8],
        ) -> CredentialStoreFuture<'a, ()> {
            Box::pin(async { Err(CredentialStoreError::NotFound) })
        }

        fn read<'a>(
            &'a self,
            _reference: &'a CredentialReference,
            _descriptor: CredentialDescriptor,
        ) -> CredentialStoreFuture<'a, zeroize::Zeroizing<Vec<u8>>> {
            Box::pin(async { Err(CredentialStoreError::NotFound) })
        }

        fn delete<'a>(
            &'a self,
            _reference: &'a CredentialReference,
            _descriptor: CredentialDescriptor,
        ) -> CredentialStoreFuture<'a, ()> {
            Box::pin(async { Err(CredentialStoreError::NotFound) })
        }
    }

    impl CredentialStoreProbe for AvailableMissingStore {
        fn probe(&self) -> CredentialStoreFuture<'_, ()> {
            Box::pin(async { Ok(()) })
        }
    }

    #[tokio::test]
    async fn falls_back_when_secret_service_is_unavailable() {
        let directory = std::env::temp_dir().join(format!(
            "codex-desktop-preferred-credential-test-{}",
            Uuid::new_v4()
        ));
        let fallback = Arc::new(PlaintextFileCredentialStore::new(directory.clone()));
        let store = PreferredCredentialStore::new(Arc::new(UnavailableStore), fallback);
        let reference = CredentialReference::new();
        let descriptor = CredentialDescriptor::Server {
            server_id: Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap(),
            kind: ServerCredentialKind::BearerToken,
        };

        store
            .create_with_plaintext_confirmation(
                &reference,
                descriptor,
                b"FALLBACK_SECRET",
                true,
            )
            .await
            .unwrap();
        assert_eq!(
            store.read(&reference, descriptor).await.unwrap().as_slice(),
            b"FALLBACK_SECRET"
        );
        assert_eq!(
            store.storage_backend().await.unwrap(),
            CredentialStorageBackend::PlaintextFile
        );
        store.delete(&reference, descriptor).await.unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[tokio::test]
    async fn does_not_fall_back_when_secret_service_is_locked_after_confirmation() {
        let directory = std::env::temp_dir().join(format!(
            "codex-desktop-locked-credential-test-{}",
            Uuid::new_v4()
        ));
        let fallback = Arc::new(PlaintextFileCredentialStore::new(directory.clone()));
        let store = PreferredCredentialStore::new(Arc::new(LockedStore), fallback);
        let reference = CredentialReference::new();
        let descriptor = CredentialDescriptor::Server {
            server_id: Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap(),
            kind: ServerCredentialKind::BearerToken,
        };

        assert!(matches!(
            store
                .create_with_plaintext_confirmation(&reference, descriptor, b"SECRET", true)
                .await,
            Err(CredentialStoreError::Locked)
        ));
        assert!(!directory.exists());
    }

    #[tokio::test]
    async fn requires_confirmation_before_plaintext_fallback() {
        let directory = std::env::temp_dir().join(format!(
            "codex-desktop-unconfirmed-credential-test-{}",
            Uuid::new_v4()
        ));
        let fallback = Arc::new(PlaintextFileCredentialStore::new(directory.clone()));
        let store = PreferredCredentialStore::new(Arc::new(UnavailableStore), fallback);
        let reference = CredentialReference::new();
        let descriptor = CredentialDescriptor::Server {
            server_id: Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap(),
            kind: ServerCredentialKind::BearerToken,
        };

        assert!(matches!(
            store.create(&reference, descriptor, b"SECRET").await,
            Err(CredentialStoreError::PlaintextFallbackConfirmationRequired)
        ));
        assert!(!directory.exists());
    }

    #[tokio::test]
    async fn keeps_existing_plaintext_credentials_readable_after_recovery() {
        let directory = std::env::temp_dir().join(format!(
            "codex-desktop-mixed-credential-test-{}",
            Uuid::new_v4()
        ));
        let fallback = Arc::new(PlaintextFileCredentialStore::new(directory.clone()));
        let reference = CredentialReference::new();
        let descriptor = CredentialDescriptor::Server {
            server_id: Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap(),
            kind: ServerCredentialKind::BearerToken,
        };
        fallback
            .create(&reference, descriptor, b"EXISTING_FALLBACK_SECRET")
            .await
            .unwrap();
        let store = PreferredCredentialStore::new(Arc::new(AvailableMissingStore), fallback);

        assert_eq!(
            store.read(&reference, descriptor).await.unwrap().as_slice(),
            b"EXISTING_FALLBACK_SECRET"
        );
        assert_eq!(
            store.storage_backend().await.unwrap(),
            CredentialStorageBackend::Mixed
        );
        store.delete(&reference, descriptor).await.unwrap();
        std::fs::remove_dir(directory).unwrap();
    }
}
