use std::{
    fs::{self, DirBuilder, File, OpenOptions},
    io::{self, Read, Write},
    os::unix::fs::{
        DirBuilderExt as _, MetadataExt as _, OpenOptionsExt as _, PermissionsExt as _,
    },
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::{
    CredentialDescriptor, CredentialReference, CredentialStore, CredentialStoreError,
    CredentialStoreFuture,
};

const FILE_FORMAT_VERSION: u8 = 1;
const MAX_CREDENTIAL_FILE_BYTES: u64 = 1024 * 1024;
const CREDENTIAL_FILE_SUFFIX: &str = ".credential";

#[derive(Clone)]
pub(crate) struct PlaintextFileCredentialStore {
    directory: PathBuf,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CredentialFileHeader {
    version: u8,
    credential_reference: String,
    owner_kind: String,
    owner_id: String,
    credential_kind: String,
    content_type: String,
}

impl CredentialFileHeader {
    fn new(reference: &CredentialReference, descriptor: CredentialDescriptor) -> Self {
        Self {
            version: FILE_FORMAT_VERSION,
            credential_reference: reference.as_str().to_owned(),
            owner_kind: descriptor.owner_kind().to_owned(),
            owner_id: descriptor.owner_id().hyphenated().to_string(),
            credential_kind: descriptor.credential_kind().to_owned(),
            content_type: descriptor.content_type().to_owned(),
        }
    }

    fn matches(&self, reference: &CredentialReference, descriptor: CredentialDescriptor) -> bool {
        self.version == FILE_FORMAT_VERSION
            && self.credential_reference == reference.as_str()
            && self.owner_kind == descriptor.owner_kind()
            && self.owner_id == descriptor.owner_id().hyphenated().to_string()
            && self.credential_kind == descriptor.credential_kind()
            && self.content_type == descriptor.content_type()
    }
}

impl PlaintextFileCredentialStore {
    pub(crate) fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    pub(crate) fn contains_credentials(&self) -> CredentialStoreFuture<'_, bool> {
        let directory = self.directory.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || contains_credentials_sync(&directory))
                .await
                .map_err(join_error)?
        })
    }

    fn credential_path(&self, reference: &CredentialReference) -> PathBuf {
        self.directory.join(reference.file_name())
    }
}

impl CredentialStore for PlaintextFileCredentialStore {
    fn create<'a>(
        &'a self,
        reference: &'a CredentialReference,
        descriptor: CredentialDescriptor,
        secret: &'a [u8],
    ) -> CredentialStoreFuture<'a, ()> {
        let directory = self.directory.clone();
        let path = self.credential_path(reference);
        let reference = reference.clone();
        let secret = Zeroizing::new(secret.to_vec());
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                create_sync(
                    &directory,
                    &path,
                    &reference,
                    descriptor,
                    secret.as_slice(),
                )
            })
            .await
            .map_err(join_error)?
        })
    }

    fn read<'a>(
        &'a self,
        reference: &'a CredentialReference,
        descriptor: CredentialDescriptor,
    ) -> CredentialStoreFuture<'a, Zeroizing<Vec<u8>>> {
        let directory = self.directory.clone();
        let path = self.credential_path(reference);
        let reference = reference.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                read_sync(&directory, &path, &reference, descriptor)
            })
            .await
            .map_err(join_error)?
        })
    }

    fn delete<'a>(
        &'a self,
        reference: &'a CredentialReference,
        descriptor: CredentialDescriptor,
    ) -> CredentialStoreFuture<'a, ()> {
        let directory = self.directory.clone();
        let path = self.credential_path(reference);
        let reference = reference.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                delete_sync(&directory, &path, &reference, descriptor)
            })
            .await
            .map_err(join_error)?
        })
    }
}

fn create_sync(
    directory: &Path,
    path: &Path,
    reference: &CredentialReference,
    descriptor: CredentialDescriptor,
    secret: &[u8],
) -> Result<(), CredentialStoreError> {
    ensure_private_directory(directory)?;
    let header = serde_json::to_vec(&CredentialFileHeader::new(reference, descriptor))
        .map_err(|_| CredentialStoreError::InvalidItem)?;
    let total_bytes = header
        .len()
        .checked_add(1)
        .and_then(|size| size.checked_add(secret.len()))
        .ok_or(CredentialStoreError::InvalidItem)?;
    if total_bytes as u64 > MAX_CREDENTIAL_FILE_BYTES {
        return Err(CredentialStoreError::InvalidItem);
    }

    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32);
    let mut file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            return Err(CredentialStoreError::AlreadyExists);
        }
        Err(error) => return Err(CredentialStoreError::Filesystem(error)),
    };
    validate_private_file(&file)?;
    let result = (|| {
        file.write_all(&header)?;
        file.write_all(b"\n")?;
        file.write_all(secret)?;
        file.sync_all()
    })();
    if let Err(error) = result {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(CredentialStoreError::Filesystem(error));
    }
    drop(file);
    sync_directory(directory)
}

fn read_sync(
    directory: &Path,
    path: &Path,
    reference: &CredentialReference,
    descriptor: CredentialDescriptor,
) -> Result<Zeroizing<Vec<u8>>, CredentialStoreError> {
    validate_existing_private_directory(directory)?;
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32);
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(CredentialStoreError::NotFound);
        }
        Err(error) => return Err(CredentialStoreError::Filesystem(error)),
    };
    validate_private_file(&file)?;
    if file
        .metadata()
        .map_err(CredentialStoreError::Filesystem)?
        .len()
        > MAX_CREDENTIAL_FILE_BYTES
    {
        return Err(CredentialStoreError::InvalidItem);
    }
    let mut contents = Zeroizing::new(Vec::new());
    file.take(MAX_CREDENTIAL_FILE_BYTES + 1)
        .read_to_end(&mut contents)
        .map_err(CredentialStoreError::Filesystem)?;
    if contents.len() as u64 > MAX_CREDENTIAL_FILE_BYTES {
        return Err(CredentialStoreError::InvalidItem);
    }
    let Some(separator) = contents.iter().position(|byte| *byte == b'\n') else {
        return Err(CredentialStoreError::InvalidItem);
    };
    let header = serde_json::from_slice::<CredentialFileHeader>(&contents[..separator])
        .map_err(|_| CredentialStoreError::InvalidItem)?;
    if !header.matches(reference, descriptor) {
        return Err(CredentialStoreError::InvalidItem);
    }
    Ok(Zeroizing::new(contents[(separator + 1)..].to_vec()))
}

fn delete_sync(
    directory: &Path,
    path: &Path,
    reference: &CredentialReference,
    descriptor: CredentialDescriptor,
) -> Result<(), CredentialStoreError> {
    drop(read_sync(directory, path, reference, descriptor)?);
    fs::remove_file(path).map_err(CredentialStoreError::Filesystem)?;
    sync_directory(directory)
}

fn ensure_private_directory(directory: &Path) -> Result<(), CredentialStoreError> {
    match fs::symlink_metadata(directory) {
        Ok(metadata) => validate_private_directory_metadata(&metadata),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let mut builder = DirBuilder::new();
            match builder.mode(0o700).create(directory) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(CredentialStoreError::Filesystem(error)),
            }
            let metadata = fs::symlink_metadata(directory)
                .map_err(CredentialStoreError::Filesystem)?;
            validate_private_directory_metadata(&metadata)
        }
        Err(error) => Err(CredentialStoreError::Filesystem(error)),
    }
}

fn validate_existing_private_directory(directory: &Path) -> Result<(), CredentialStoreError> {
    let metadata = match fs::symlink_metadata(directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(CredentialStoreError::NotFound);
        }
        Err(error) => return Err(CredentialStoreError::Filesystem(error)),
    };
    validate_private_directory_metadata(&metadata)
}

fn validate_private_directory_metadata(
    metadata: &fs::Metadata,
) -> Result<(), CredentialStoreError> {
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != rustix::process::geteuid().as_raw()
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err(unsafe_permissions_error());
    }
    Ok(())
}

fn validate_private_file(file: &File) -> Result<(), CredentialStoreError> {
    let metadata = file.metadata().map_err(CredentialStoreError::Filesystem)?;
    if !metadata.is_file()
        || metadata.uid() != rustix::process::geteuid().as_raw()
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err(unsafe_permissions_error());
    }
    Ok(())
}

fn contains_credentials_sync(directory: &Path) -> Result<bool, CredentialStoreError> {
    let metadata = match fs::symlink_metadata(directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(CredentialStoreError::Filesystem(error)),
    };
    validate_private_directory_metadata(&metadata)?;
    for entry in fs::read_dir(directory).map_err(CredentialStoreError::Filesystem)? {
        let entry = entry.map_err(CredentialStoreError::Filesystem)?;
        if entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.ends_with(CREDENTIAL_FILE_SUFFIX))
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn sync_directory(directory: &Path) -> Result<(), CredentialStoreError> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32);
    let file = options
        .open(directory)
        .map_err(CredentialStoreError::Filesystem)?;
    let metadata = file.metadata().map_err(CredentialStoreError::Filesystem)?;
    validate_private_directory_metadata(&metadata)?;
    file.sync_all().map_err(CredentialStoreError::Filesystem)
}

fn join_error(error: tokio::task::JoinError) -> CredentialStoreError {
    CredentialStoreError::Filesystem(io::Error::other(error.to_string()))
}

fn unsafe_permissions_error() -> CredentialStoreError {
    CredentialStoreError::Filesystem(io::Error::new(
        io::ErrorKind::PermissionDenied,
        "the plaintext credential path permissions are unsafe",
    ))
}

#[cfg(test)]
mod tests {
    use std::{fs, os::unix::fs::PermissionsExt as _};

    use uuid::Uuid;

    use super::PlaintextFileCredentialStore;
    use crate::credentials::{
        CredentialDescriptor, CredentialReference, CredentialStore, CredentialStoreError,
        ServerCredentialKind,
    };

    fn test_directory() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "codex-desktop-plaintext-credential-test-{}",
            Uuid::new_v4()
        ))
    }

    fn descriptor() -> CredentialDescriptor {
        CredentialDescriptor::Server {
            server_id: Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap(),
            kind: ServerCredentialKind::BearerToken,
        }
    }

    #[tokio::test]
    async fn persists_plaintext_with_private_permissions() {
        let directory = test_directory();
        let store = PlaintextFileCredentialStore::new(directory.clone());
        let reference = CredentialReference::new();
        store
            .create(&reference, descriptor(), b"PLAIN_TEXT_SECRET")
            .await
            .unwrap();

        let file = directory.join(reference.file_name());
        assert_eq!(
            fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(
            String::from_utf8(fs::read(&file).unwrap())
                .unwrap()
                .contains("PLAIN_TEXT_SECRET")
        );
        assert_eq!(
            store.read(&reference, descriptor()).await.unwrap().as_slice(),
            b"PLAIN_TEXT_SECRET"
        );
        store.delete(&reference, descriptor()).await.unwrap();
        assert!(matches!(
            store.read(&reference, descriptor()).await,
            Err(CredentialStoreError::NotFound)
        ));
        fs::remove_dir(directory).unwrap();
    }

    #[tokio::test]
    async fn rejects_files_visible_to_other_users() {
        let directory = test_directory();
        let store = PlaintextFileCredentialStore::new(directory.clone());
        let reference = CredentialReference::new();
        store
            .create(&reference, descriptor(), b"SECRET")
            .await
            .unwrap();
        let file = directory.join(reference.file_name());
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();

        assert!(matches!(
            store.read(&reference, descriptor()).await,
            Err(CredentialStoreError::Filesystem(error))
                if error.kind() == std::io::ErrorKind::PermissionDenied
        ));
        fs::remove_file(file).unwrap();
        fs::remove_dir(directory).unwrap();
    }
}
