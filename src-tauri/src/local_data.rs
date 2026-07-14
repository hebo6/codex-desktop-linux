use std::{
    fs::{self, DirBuilder},
    io,
    os::unix::fs::{DirBuilderExt as _, PermissionsExt as _},
    path::{Path, PathBuf},
};

use tauri::{AppHandle, Manager as _};

const TEMPORARY_DIRECTORY_NAME: &str = "codex-desktop-linux";

pub(crate) fn temporary_directory() -> io::Result<PathBuf> {
    let path = temporary_directory_path();
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(io::Error::other(
                "the application temporary path is not a directory",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            DirBuilder::new().mode(0o700).create(&path)?;
        }
        Err(error) => return Err(error),
    }
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
    Ok(path)
}

pub(crate) fn clear_temporary_files() -> io::Result<()> {
    clear_directory_contents(&temporary_directory_path())
}

fn temporary_directory_path() -> PathBuf {
    Path::new("/tmp").join(TEMPORARY_DIRECTORY_NAME)
}

pub(crate) fn clear_application_logs(app: &AppHandle) -> io::Result<()> {
    let directory = app
        .path()
        .app_log_dir()
        .map_err(|error| io::Error::other(error.to_string()))?;
    clear_directory_contents(&directory)
}

fn clear_directory_contents(directory: &Path) -> io::Result<()> {
    let metadata = match fs::symlink_metadata(directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(io::Error::other(
            "the application data path is not a directory",
        ));
    }
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        let entry_metadata = fs::symlink_metadata(&path)?;
        if entry_metadata.is_dir() && !entry_metadata.file_type().is_symlink() {
            fs::remove_dir_all(path)?;
        } else {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{fs, os::unix::fs::symlink};

    use super::clear_directory_contents;

    #[test]
    fn clears_only_children_without_following_symbolic_links() {
        let root = std::env::temp_dir().join(format!(
            "codex-desktop-local-data-test-{}",
            uuid::Uuid::new_v4()
        ));
        let outside = std::env::temp_dir().join(format!(
            "codex-desktop-local-data-outside-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(root.join("log.txt"), b"safe").unwrap();
        fs::write(outside.join("keep.txt"), b"keep").unwrap();
        symlink(&outside, root.join("outside-link")).unwrap();

        clear_directory_contents(&root).unwrap();

        assert_eq!(fs::read(outside.join("keep.txt")).unwrap(), b"keep");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::remove_dir(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}
