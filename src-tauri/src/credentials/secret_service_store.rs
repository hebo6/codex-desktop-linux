use std::{collections::HashMap, time::Duration};

use secret_service::{EncryptionType, Item, SecretService};
use tokio::{sync::Mutex, time::timeout};
use zeroize::Zeroizing;

use super::{
    CredentialDescriptor, CredentialReference, CredentialStore, CredentialStoreError,
    CredentialStoreFuture, CredentialStoreProbe,
};

const APPLICATION_ID: &str = "com.codexdesktop.linux";
const ATTRIBUTE_SCHEMA: &str = "com.codexdesktop.linux.credential.v1";
const ITEM_LABEL: &str = "Codex Desktop credential";
const OPERATION_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Default)]
pub(crate) struct SecretServiceCredentialStore {
    operation_lock: Mutex<()>,
}

impl CredentialStoreProbe for SecretServiceCredentialStore {
    fn probe(&self) -> CredentialStoreFuture<'_, ()> {
        Box::pin(async move {
            let _guard = self.operation_lock.lock().await;
            run_with_timeout(async move {
                let service = connect().await?;
                service
                    .get_default_collection()
                    .await
                    .map(|_| ())
                    .map_err(map_default_collection_error)
            })
            .await
        })
    }
}

struct ItemAttributes {
    credential_reference: String,
    owner_id: String,
    owner_kind: &'static str,
    credential_kind: &'static str,
}

impl ItemAttributes {
    fn new(reference: &CredentialReference, descriptor: CredentialDescriptor) -> Self {
        Self {
            credential_reference: reference.as_str().to_owned(),
            owner_id: descriptor.owner_id().hyphenated().to_string(),
            owner_kind: descriptor.owner_kind(),
            credential_kind: descriptor.credential_kind(),
        }
    }

    fn identity_map(&self) -> HashMap<&str, &str> {
        HashMap::from([
            ("application", APPLICATION_ID),
            ("xdg:schema", ATTRIBUTE_SCHEMA),
            ("credential-reference", self.credential_reference.as_str()),
        ])
    }

    fn complete_map(&self) -> HashMap<&str, &str> {
        HashMap::from([
            ("application", APPLICATION_ID),
            ("xdg:schema", ATTRIBUTE_SCHEMA),
            ("credential-reference", self.credential_reference.as_str()),
            ("owner-kind", self.owner_kind),
            ("owner-id", self.owner_id.as_str()),
            ("credential-kind", self.credential_kind),
        ])
    }
}

impl CredentialStore for SecretServiceCredentialStore {
    fn create<'a>(
        &'a self,
        reference: &'a CredentialReference,
        descriptor: CredentialDescriptor,
        secret: &'a [u8],
    ) -> CredentialStoreFuture<'a, ()> {
        Box::pin(async move {
            let _guard = self.operation_lock.lock().await;
            run_with_timeout(async move {
                let service = connect().await?;
                let attributes = ItemAttributes::new(reference, descriptor);
                let existing = service
                    .search_items(attributes.identity_map())
                    .await
                    .map_err(map_error)?;
                let mut existing_items = existing.unlocked;
                existing_items.extend(existing.locked);
                if existing_items.len() > 1 {
                    return Err(CredentialStoreError::Duplicate);
                }
                if let Some(item) = existing_items.pop() {
                    validate_item_attributes(&item, &attributes).await?;
                    return Err(CredentialStoreError::AlreadyExists);
                }

                let collection = service
                    .get_default_collection()
                    .await
                    .map_err(map_default_collection_error)?;
                if collection.is_locked().await.map_err(map_error)? {
                    collection.unlock().await.map_err(map_error)?;
                }
                collection.ensure_unlocked().await.map_err(map_error)?;
                collection
                    .create_item(
                        ITEM_LABEL,
                        attributes.complete_map(),
                        secret,
                        false,
                        descriptor.content_type(),
                    )
                    .await
                    .map_err(map_error)?;
                Ok(())
            })
            .await
        })
    }

    fn read<'a>(
        &'a self,
        reference: &'a CredentialReference,
        descriptor: CredentialDescriptor,
    ) -> CredentialStoreFuture<'a, Zeroizing<Vec<u8>>> {
        Box::pin(async move {
            let _guard = self.operation_lock.lock().await;
            run_with_timeout(async move {
                let service = connect().await?;
                let item = find_item(&service, reference, descriptor).await?;
                item.get_secret()
                    .await
                    .map(Zeroizing::new)
                    .map_err(map_error)
            })
            .await
        })
    }

    fn delete<'a>(
        &'a self,
        reference: &'a CredentialReference,
        descriptor: CredentialDescriptor,
    ) -> CredentialStoreFuture<'a, ()> {
        Box::pin(async move {
            let _guard = self.operation_lock.lock().await;
            run_with_timeout(async move {
                let service = connect().await?;
                let item = find_item(&service, reference, descriptor).await?;
                item.delete().await.map_err(map_error)
            })
            .await
        })
    }
}

async fn run_with_timeout<T>(
    operation: impl std::future::Future<Output = Result<T, CredentialStoreError>>,
) -> Result<T, CredentialStoreError> {
    timeout(OPERATION_TIMEOUT, operation)
        .await
        .map_err(|_| CredentialStoreError::TimedOut)?
}

async fn connect() -> Result<SecretService<'static>, CredentialStoreError> {
    SecretService::connect(EncryptionType::Dh)
        .await
        .map_err(map_connect_error)
}

async fn find_item<'a>(
    service: &'a SecretService<'_>,
    reference: &CredentialReference,
    descriptor: CredentialDescriptor,
) -> Result<Item<'a>, CredentialStoreError> {
    let attributes = ItemAttributes::new(reference, descriptor);
    let mut result = service
        .search_items(attributes.identity_map())
        .await
        .map_err(map_error)?;
    let count = result.unlocked.len() + result.locked.len();
    if count == 0 {
        return Err(CredentialStoreError::NotFound);
    }
    if count != 1 {
        return Err(CredentialStoreError::Duplicate);
    }

    let item = result
        .unlocked
        .pop()
        .or_else(|| result.locked.pop())
        .ok_or(CredentialStoreError::NotFound)?;
    validate_item_attributes(&item, &attributes).await?;
    if item.is_locked().await.map_err(map_error)? {
        item.unlock().await.map_err(map_error)?;
    }
    item.ensure_unlocked().await.map_err(map_error)?;
    Ok(item)
}

async fn validate_item_attributes(
    item: &Item<'_>,
    expected: &ItemAttributes,
) -> Result<(), CredentialStoreError> {
    let actual = item.get_attributes().await.map_err(map_error)?;
    let valid = expected
        .complete_map()
        .into_iter()
        .all(|(name, value)| actual.get(name).is_some_and(|actual| actual == value));
    if valid {
        Ok(())
    } else {
        Err(CredentialStoreError::InvalidItem)
    }
}

fn map_default_collection_error(error: secret_service::Error) -> CredentialStoreError {
    match error {
        secret_service::Error::NoResult | secret_service::Error::Unavailable => {
            CredentialStoreError::Unavailable
        }
        other => map_error(other),
    }
}

fn map_connect_error(error: secret_service::Error) -> CredentialStoreError {
    if matches!(&error, secret_service::Error::Unavailable) {
        return CredentialStoreError::Unavailable;
    }
    classify_zbus_error(&error).unwrap_or(CredentialStoreError::Backend(error))
}

fn map_error(error: secret_service::Error) -> CredentialStoreError {
    if let Some(classification) = classify_zbus_error(&error) {
        return classification;
    }
    match error {
        secret_service::Error::Unavailable => CredentialStoreError::Unavailable,
        secret_service::Error::Locked => CredentialStoreError::Locked,
        secret_service::Error::Prompt => CredentialStoreError::PromptDismissed,
        secret_service::Error::NoResult => CredentialStoreError::NotFound,
        other => CredentialStoreError::Backend(other),
    }
}

fn classify_zbus_error(error: &secret_service::Error) -> Option<CredentialStoreError> {
    match error {
        secret_service::Error::Zbus(zbus::Error::MethodError(name, _, _)) => {
            classify_method_error_name(name.as_str())
        }
        secret_service::Error::Zbus(zbus::Error::FDO(error)) => classify_fdo_error(error),
        secret_service::Error::ZbusFdo(error) => classify_fdo_error(error),
        _ => None,
    }
}

fn classify_method_error_name(name: &str) -> Option<CredentialStoreError> {
    match name {
        "org.freedesktop.Secret.Error.IsLocked" => Some(CredentialStoreError::Locked),
        "org.freedesktop.Secret.Error.NoSuchObject"
        | "org.freedesktop.DBus.Error.UnknownObject" => Some(CredentialStoreError::NotFound),
        "org.freedesktop.DBus.Error.ServiceUnknown"
        | "org.freedesktop.DBus.Error.NameHasNoOwner" => Some(CredentialStoreError::Unavailable),
        "org.freedesktop.DBus.Error.AccessDenied"
        | "org.freedesktop.Secret.Error.PermissionDenied" => {
            Some(CredentialStoreError::AccessDenied)
        }
        "org.freedesktop.DBus.Error.NoReply"
        | "org.freedesktop.DBus.Error.Timeout"
        | "org.freedesktop.DBus.Error.TimedOut" => Some(CredentialStoreError::TimedOut),
        _ => None,
    }
}

fn classify_fdo_error(error: &zbus::fdo::Error) -> Option<CredentialStoreError> {
    match error {
        zbus::fdo::Error::ServiceUnknown(_)
        | zbus::fdo::Error::NameHasNoOwner(_)
        | zbus::fdo::Error::NoServer(_)
        | zbus::fdo::Error::Disconnected(_) => Some(CredentialStoreError::Unavailable),
        zbus::fdo::Error::UnknownObject(_) => Some(CredentialStoreError::NotFound),
        zbus::fdo::Error::AccessDenied(_) | zbus::fdo::Error::AuthFailed(_) => {
            Some(CredentialStoreError::AccessDenied)
        }
        zbus::fdo::Error::NoReply(_)
        | zbus::fdo::Error::Timeout(_)
        | zbus::fdo::Error::TimedOut(_) => Some(CredentialStoreError::TimedOut),
        zbus::fdo::Error::ZBus(error) => {
            let wrapped = secret_service::Error::Zbus(error.clone());
            classify_zbus_error(&wrapped)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::{ItemAttributes, classify_fdo_error, classify_method_error_name};
    use crate::credentials::{
        CredentialDescriptor, CredentialReference, CredentialStoreError, ProxyCredentialKind,
    };

    #[test]
    fn attributes_are_scoped_without_profile_metadata() {
        let reference = CredentialReference::new();
        let descriptor = CredentialDescriptor::Proxy {
            proxy_id: Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap(),
            kind: ProxyCredentialKind::HttpBasicPassword,
        };
        let attributes = ItemAttributes::new(&reference, descriptor);
        let map = attributes.complete_map();

        assert_eq!(map.len(), 6);
        assert_eq!(map.get("application"), Some(&"com.codexdesktop.linux"));
        assert_eq!(
            map.get("xdg:schema"),
            Some(&"com.codexdesktop.linux.credential.v1")
        );
        assert_eq!(map.get("credential-reference"), Some(&reference.as_str()));
        assert_eq!(map.get("owner-kind"), Some(&"proxy"));
        assert_eq!(
            map.get("owner-id"),
            Some(&"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        );
        assert_eq!(map.get("credential-kind"), Some(&"http-basic-password"));
        assert!(
            map.values()
                .all(|value| !value.contains("proxy.example.test")
                    && !value.contains("alice")
                    && !value.contains("/home/"))
        );

        let identity = attributes.identity_map();
        assert_eq!(identity.len(), 3);
        assert!(!identity.contains_key("owner-kind"));
    }

    #[test]
    fn classifies_secret_service_and_dbus_method_errors() {
        let cases = [
            ("org.freedesktop.Secret.Error.IsLocked", "locked"),
            ("org.freedesktop.Secret.Error.NoSuchObject", "not-found"),
            ("org.freedesktop.DBus.Error.ServiceUnknown", "unavailable"),
            ("org.freedesktop.DBus.Error.AccessDenied", "access-denied"),
            ("org.freedesktop.DBus.Error.NoReply", "timed-out"),
        ];
        for (name, expected) in cases {
            let classified = classify_method_error_name(name).unwrap();
            assert_eq!(error_category(&classified), expected);
        }
        assert!(classify_method_error_name("org.example.Unknown").is_none());
    }

    #[test]
    fn classifies_typed_fdo_errors() {
        let cases = [
            (
                zbus::fdo::Error::NameHasNoOwner(String::new()),
                "unavailable",
            ),
            (zbus::fdo::Error::UnknownObject(String::new()), "not-found"),
            (
                zbus::fdo::Error::AccessDenied(String::new()),
                "access-denied",
            ),
            (zbus::fdo::Error::TimedOut(String::new()), "timed-out"),
        ];
        for (error, expected) in cases {
            let classified = classify_fdo_error(&error).unwrap();
            assert_eq!(error_category(&classified), expected);
        }
    }

    fn error_category(error: &CredentialStoreError) -> &'static str {
        match error {
            CredentialStoreError::Unavailable => "unavailable",
            CredentialStoreError::Locked => "locked",
            CredentialStoreError::AccessDenied => "access-denied",
            CredentialStoreError::TimedOut => "timed-out",
            CredentialStoreError::NotFound => "not-found",
            _ => "other",
        }
    }
}
