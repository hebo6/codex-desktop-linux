use std::{
    error::Error,
    fmt, fs, io,
    path::{Path, PathBuf},
    time::Duration,
};

use sqlx::{
    SqlitePool,
    migrate::{MigrateError, Migrator},
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};

#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};

const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CONNECTIONS: u32 = 5;

static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

#[derive(Debug)]
pub(crate) enum StorageError {
    InvalidDatabasePath(PathBuf),
    UnsafePath {
        path: PathBuf,
        reason: &'static str,
    },
    Io {
        operation: &'static str,
        path: PathBuf,
        source: io::Error,
    },
    Database(sqlx::Error),
    Migration(MigrateError),
}

impl fmt::Display for StorageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidDatabasePath(path) => {
                write!(formatter, "无效的数据库路径：{}", path.display())
            }
            Self::UnsafePath { path, reason } => {
                write!(
                    formatter,
                    "数据库路径不安全：{}（{reason}）",
                    path.display()
                )
            }
            Self::Io {
                operation,
                path,
                source,
            } => write!(
                formatter,
                "数据库路径操作失败：{operation} {}：{source}",
                path.display()
            ),
            Self::Database(source) => write!(formatter, "打开数据库失败：{source}"),
            Self::Migration(source) => write!(formatter, "数据库迁移失败：{source}"),
        }
    }
}

impl Error for StorageError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::Database(source) => Some(source),
            Self::Migration(source) => Some(source),
            Self::InvalidDatabasePath(_) | Self::UnsafePath { .. } => None,
        }
    }
}

impl From<sqlx::Error> for StorageError {
    fn from(source: sqlx::Error) -> Self {
        Self::Database(source)
    }
}

pub(crate) async fn open_database(
    database_path: impl AsRef<Path>,
) -> Result<SqlitePool, StorageError> {
    let database_path = database_path.as_ref();
    prepare_database_path(database_path)?;

    let connect_options = SqliteConnectOptions::new()
        .filename(database_path)
        .create_if_missing(false)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(BUSY_TIMEOUT);

    let pool = SqlitePoolOptions::new()
        .max_connections(MAX_CONNECTIONS)
        .connect_with(connect_options)
        .await?;

    if let Err(source) = MIGRATOR.run(&pool).await {
        pool.close().await;
        return Err(StorageError::Migration(source));
    }

    Ok(pool)
}

fn prepare_database_path(database_path: &Path) -> Result<(), StorageError> {
    if !database_path.is_absolute() || database_path.file_name().is_none() {
        return Err(StorageError::InvalidDatabasePath(
            database_path.to_path_buf(),
        ));
    }

    let parent = database_path
        .parent()
        .expect("an absolute file path always has a parent");

    create_database_directory(parent)?;
    secure_database_file(database_path)
}

fn create_database_directory(path: &Path) -> Result<(), StorageError> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);

    #[cfg(unix)]
    builder.mode(0o700);

    builder.create(path).map_err(|source| StorageError::Io {
        operation: "创建目录",
        path: path.to_path_buf(),
        source,
    })?;

    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|source| {
        StorageError::Io {
            operation: "设置目录权限",
            path: path.to_path_buf(),
            source,
        }
    })?;

    Ok(())
}

fn secure_database_file(path: &Path) -> Result<(), StorageError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(StorageError::UnsafePath {
                path: path.to_path_buf(),
                reason: "数据库文件是符号链接",
            });
        }
        Ok(metadata) if !metadata.is_file() => {
            return Err(StorageError::UnsafePath {
                path: path.to_path_buf(),
                reason: "数据库路径不是普通文件",
            });
        }
        Ok(_) => {}
        Err(source) if source.kind() == io::ErrorKind::NotFound => {}
        Err(source) => {
            return Err(StorageError::Io {
                operation: "检查数据库文件",
                path: path.to_path_buf(),
                source,
            });
        }
    }

    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);

    #[cfg(unix)]
    options.mode(0o600);

    // O_NOFOLLOW protects the file creation itself while still allowing XDG parent links
    #[cfg(target_os = "linux")]
    options.custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32);

    let file = options.open(path).map_err(|source| StorageError::Io {
        operation: "创建数据库文件",
        path: path.to_path_buf(),
        source,
    })?;

    let metadata = file.metadata().map_err(|source| StorageError::Io {
        operation: "检查数据库文件",
        path: path.to_path_buf(),
        source,
    })?;

    if !metadata.is_file() {
        return Err(StorageError::UnsafePath {
            path: path.to_path_buf(),
            reason: "数据库路径不是普通文件",
        });
    }

    #[cfg(unix)]
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|source| StorageError::Io {
            operation: "设置数据库文件权限",
            path: path.to_path_buf(),
            source,
        })?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
    };

    use sqlx::{Connection, Row, SqliteConnection, sqlite::SqliteConnectOptions};

    use super::{StorageError, open_database};

    static TEST_PATH_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TestDatabasePath {
        directory: PathBuf,
        database: PathBuf,
    }

    impl TestDatabasePath {
        fn new(test_name: &str) -> Self {
            let sequence = TEST_PATH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let directory = PathBuf::from(format!(
                "/tmp/codex-desktop-storage-{}-{test_name}-{sequence}",
                std::process::id()
            ));
            let database = directory.join("configuration.sqlite3");

            Self {
                directory,
                database,
            }
        }

        fn database(&self) -> &Path {
            &self.database
        }
    }

    impl Drop for TestDatabasePath {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    #[tokio::test]
    async fn opens_secure_wal_database_with_required_pragmas() {
        let test_path = TestDatabasePath::new("pragmas");
        let pool = open_database(test_path.database()).await.unwrap();

        let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
            .fetch_one(&pool)
            .await
            .unwrap();
        let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(&pool)
            .await
            .unwrap();
        let busy_timeout: i64 = sqlx::query_scalar("PRAGMA busy_timeout")
            .fetch_one(&pool)
            .await
            .unwrap();

        assert_eq!(foreign_keys, 1);
        assert_eq!(journal_mode, "wal");
        assert_eq!(busy_timeout, 5_000);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let directory_mode = fs::metadata(&test_path.directory)
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            let database_mode = fs::metadata(test_path.database())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;

            assert_eq!(directory_mode, 0o700);
            assert_eq!(database_mode, 0o600);
        }

        pool.close().await;
    }

    #[tokio::test]
    async fn enforces_normalized_configuration_constraints() {
        let test_path = TestDatabasePath::new("constraints");
        let pool = open_database(test_path.database()).await.unwrap();

        sqlx::query(
            "INSERT INTO proxies (proxy_id, name, proxy_type) VALUES ('proxy-1', 'Office', 'ssh')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"
            INSERT INTO ssh_proxy_configs (
                proxy_id,
                host,
                username,
                authentication_method,
                connect_timeout_ms,
                keep_alive_interval_ms,
                keep_alive_max_failures
            ) VALUES ('proxy-1', 'ssh.example.com', 'codex', 'agent', 10000, 30000, 3)
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"
            INSERT INTO ssh_host_keys (
                proxy_id,
                host,
                port,
                algorithm,
                sha256_fingerprint,
                confirmed_at_ms
            ) VALUES (
                'proxy-1',
                'ssh.example.com',
                22,
                'ssh-ed25519',
                'SHA256:example',
                1
            )
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO servers (server_id, name, server_type) VALUES ('server-1', 'Remote', 'remote')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"
            INSERT INTO remote_server_configs (
                server_id,
                url,
                authentication_method,
                non_sensitive_headers_json,
                connect_timeout_ms,
                proxy_id
            ) VALUES (
                'server-1',
                'wss://example.com/app-server',
                'none',
                '{}',
                10000,
                'proxy-1'
            )
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            "UPDATE remote_server_configs SET authentication_method = 'bearer' WHERE server_id = 'server-1'",
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO window_states (window_id, server_id) VALUES ('window-1', 'server-1')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let unsafe_window_position = sqlx::query(
            "UPDATE window_states SET position_x = 9007199254740992, position_y = 0
             WHERE window_id = 'window-1'",
        )
        .execute(&pool)
        .await;
        assert!(unsafe_window_position.is_err());

        let unsafe_window_size = sqlx::query(
            "UPDATE window_states SET width = 9007199254740992, height = 1
             WHERE window_id = 'window-1'",
        )
        .execute(&pool)
        .await;
        assert!(unsafe_window_size.is_err());

        let referenced_proxy_delete = sqlx::query("DELETE FROM proxies WHERE proxy_id = 'proxy-1'")
            .execute(&pool)
            .await;
        assert!(referenced_proxy_delete.is_err());

        let duplicate_name = sqlx::query(
            "INSERT INTO servers (server_id, name, server_type) VALUES ('server-2', 'remote', 'local')",
        )
        .execute(&pool)
        .await;
        assert!(duplicate_name.is_err());

        let non_positive_version = sqlx::query(
            "INSERT INTO servers (server_id, name, server_type, version) VALUES ('server-3', 'Invalid version', 'local', 0)",
        )
        .execute(&pool)
        .await;
        assert!(non_positive_version.is_err());

        let invalid_json = sqlx::query(
            "UPDATE servers SET display_preferences_json = '{' WHERE server_id = 'server-1'",
        )
        .execute(&pool)
        .await;
        assert!(invalid_json.is_err());

        let referenced_server_delete =
            sqlx::query("DELETE FROM servers WHERE server_id = 'server-1'")
                .execute(&pool)
                .await;
        assert!(referenced_server_delete.is_err());

        sqlx::query("DELETE FROM window_states WHERE window_id = 'window-1'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM servers WHERE server_id = 'server-1'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM proxies WHERE proxy_id = 'proxy-1'")
            .execute(&pool)
            .await
            .unwrap();

        let ssh_config_count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM ssh_proxy_configs WHERE proxy_id = 'proxy-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        let host_key_count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM ssh_host_keys WHERE proxy_id = 'proxy-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(ssh_config_count, 0);
        assert_eq!(host_key_count, 0);

        pool.close().await;
    }

    #[tokio::test]
    async fn preserves_existing_data_when_migration_fails() {
        let test_path = TestDatabasePath::new("migration-failure");
        fs::create_dir_all(&test_path.directory).unwrap();

        let options = SqliteConnectOptions::new()
            .filename(test_path.database())
            .create_if_missing(true);
        let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query("CREATE TABLE sentinel (value TEXT NOT NULL)")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sentinel (value) VALUES ('preserve me')")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE servers (conflict TEXT NOT NULL)")
            .execute(&mut connection)
            .await
            .unwrap();
        connection.close().await.unwrap();

        let result = open_database(test_path.database()).await;
        assert!(matches!(result, Err(StorageError::Migration(_))));

        let options = SqliteConnectOptions::new()
            .filename(test_path.database())
            .create_if_missing(false);
        let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
        let sentinel = sqlx::query("SELECT value FROM sentinel")
            .fetch_one(&mut connection)
            .await
            .unwrap()
            .get::<String, _>("value");
        assert_eq!(sentinel, "preserve me");
        let partially_migrated_table_count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = 'proxies'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(partially_migrated_table_count, 0);
        connection.close().await.unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symbolic_link_database_paths() {
        use std::os::unix::fs::symlink;

        let test_path = TestDatabasePath::new("symlink");
        fs::create_dir_all(&test_path.directory).unwrap();
        let target = test_path.directory.join("target.sqlite3");
        fs::write(&target, []).unwrap();
        symlink(&target, test_path.database()).unwrap();

        let result = super::prepare_database_path(test_path.database());
        assert!(matches!(result, Err(StorageError::UnsafePath { .. })));
    }

    #[test]
    fn rejects_relative_database_paths_without_creating_them() {
        let result = super::prepare_database_path(Path::new("configuration.sqlite3"));
        assert!(matches!(result, Err(StorageError::InvalidDatabasePath(_))));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn allows_symbolic_links_in_parent_path() {
        use std::os::unix::fs::symlink;

        let test_path = TestDatabasePath::new("parent-symlink");
        fs::create_dir_all(&test_path.directory).unwrap();
        let actual_directory = test_path.directory.join("actual");
        let linked_directory = test_path.directory.join("linked");
        fs::create_dir(&actual_directory).unwrap();
        symlink(&actual_directory, &linked_directory).unwrap();

        let pool = open_database(linked_directory.join("configuration.sqlite3"))
            .await
            .unwrap();
        pool.close().await;
    }
}
