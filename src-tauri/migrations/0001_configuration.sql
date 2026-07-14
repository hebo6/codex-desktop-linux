CREATE TABLE proxies (
    proxy_id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(proxy_id)) > 0),
    name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(name)) > 0),
    proxy_type TEXT NOT NULL CHECK (proxy_type IN ('http', 'socks5', 'ssh')),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 9007199254740991),
    last_test_status TEXT CHECK (
        last_test_status IS NULL OR last_test_status IN ('succeeded', 'failed')
    ),
    last_tested_at_ms INTEGER CHECK (
        last_tested_at_ms IS NULL
        OR last_tested_at_ms BETWEEN 0 AND 9007199254740991
    ),
    created_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
    updated_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        CHECK (updated_at_ms BETWEEN created_at_ms AND 9007199254740991),
    CHECK ((last_test_status IS NULL) = (last_tested_at_ms IS NULL)),
    UNIQUE (proxy_id, proxy_type)
) STRICT;

CREATE TABLE http_proxy_configs (
    proxy_id TEXT PRIMARY KEY NOT NULL,
    proxy_type TEXT NOT NULL DEFAULT 'http' CHECK (proxy_type = 'http'),
    url TEXT NOT NULL CHECK (length(trim(url)) > 0),
    authentication_method TEXT NOT NULL CHECK (
        authentication_method IN ('none', 'basic', 'bearer')
    ),
    username TEXT,
    credential_reference TEXT CHECK (
        credential_reference IS NULL OR length(trim(credential_reference)) > 0
    ),
    non_sensitive_headers_json TEXT NOT NULL DEFAULT '{}'
        CHECK (json_valid(non_sensitive_headers_json)),
    connect_timeout_ms INTEGER NOT NULL CHECK (connect_timeout_ms > 0),
    tls_certificate_policy TEXT NOT NULL DEFAULT 'strict' CHECK (
        tls_certificate_policy IN ('strict', 'allow_invalid')
    ),
    CHECK (
        (
            authentication_method = 'none'
            AND username IS NULL
            AND credential_reference IS NULL
        ) OR (
            authentication_method = 'basic'
            AND username IS NOT NULL
            AND length(trim(username)) > 0
        ) OR (
            authentication_method = 'bearer'
            AND username IS NULL
        )
    ),
    FOREIGN KEY (proxy_id, proxy_type)
        REFERENCES proxies (proxy_id, proxy_type)
        ON DELETE CASCADE
) STRICT;

CREATE TABLE socks_proxy_configs (
    proxy_id TEXT PRIMARY KEY NOT NULL,
    proxy_type TEXT NOT NULL DEFAULT 'socks5' CHECK (proxy_type = 'socks5'),
    host TEXT NOT NULL CHECK (length(trim(host)) > 0),
    port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
    authentication_method TEXT NOT NULL CHECK (
        authentication_method IN ('none', 'username_password')
    ),
    username TEXT,
    credential_reference TEXT CHECK (
        credential_reference IS NULL OR length(trim(credential_reference)) > 0
    ),
    dns_resolution TEXT NOT NULL DEFAULT 'proxy' CHECK (
        dns_resolution IN ('proxy', 'local')
    ),
    connect_timeout_ms INTEGER NOT NULL CHECK (connect_timeout_ms > 0),
    CHECK (
        (
            authentication_method = 'none'
            AND username IS NULL
            AND credential_reference IS NULL
        ) OR (
            authentication_method = 'username_password'
            AND username IS NOT NULL
            AND length(trim(username)) > 0
        )
    ),
    FOREIGN KEY (proxy_id, proxy_type)
        REFERENCES proxies (proxy_id, proxy_type)
        ON DELETE CASCADE
) STRICT;

CREATE TABLE ssh_proxy_configs (
    proxy_id TEXT PRIMARY KEY NOT NULL,
    proxy_type TEXT NOT NULL DEFAULT 'ssh' CHECK (proxy_type = 'ssh'),
    host TEXT NOT NULL CHECK (length(trim(host)) > 0),
    port INTEGER NOT NULL DEFAULT 22 CHECK (port BETWEEN 1 AND 65535),
    username TEXT NOT NULL CHECK (length(trim(username)) > 0),
    authentication_method TEXT NOT NULL CHECK (
        authentication_method IN ('agent', 'private_key', 'password')
    ),
    private_key_path TEXT,
    key_passphrase_credential_reference TEXT,
    password_credential_reference TEXT,
    connect_timeout_ms INTEGER NOT NULL CHECK (connect_timeout_ms > 0),
    keep_alive_interval_ms INTEGER NOT NULL CHECK (keep_alive_interval_ms > 0),
    keep_alive_max_failures INTEGER NOT NULL CHECK (keep_alive_max_failures > 0),
    CHECK (
        key_passphrase_credential_reference IS NULL
        OR length(trim(key_passphrase_credential_reference)) > 0
    ),
    CHECK (
        password_credential_reference IS NULL
        OR length(trim(password_credential_reference)) > 0
    ),
    CHECK (
        (
            authentication_method = 'agent'
            AND private_key_path IS NULL
            AND key_passphrase_credential_reference IS NULL
            AND password_credential_reference IS NULL
        ) OR (
            authentication_method = 'private_key'
            AND private_key_path IS NOT NULL
            AND length(trim(private_key_path)) > 0
            AND password_credential_reference IS NULL
        ) OR (
            authentication_method = 'password'
            AND private_key_path IS NULL
            AND key_passphrase_credential_reference IS NULL
        )
    ),
    UNIQUE (proxy_id, host, port),
    FOREIGN KEY (proxy_id, proxy_type)
        REFERENCES proxies (proxy_id, proxy_type)
        ON DELETE CASCADE
) STRICT;

CREATE TABLE ssh_host_keys (
    proxy_id TEXT PRIMARY KEY NOT NULL,
    host TEXT NOT NULL CHECK (length(trim(host)) > 0),
    port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
    algorithm TEXT NOT NULL CHECK (length(trim(algorithm)) > 0),
    sha256_fingerprint TEXT NOT NULL CHECK (length(trim(sha256_fingerprint)) > 0),
    confirmed_at_ms INTEGER NOT NULL CHECK (
        confirmed_at_ms BETWEEN 0 AND 9007199254740991
    ),
    FOREIGN KEY (proxy_id, host, port)
        REFERENCES ssh_proxy_configs (proxy_id, host, port)
        ON UPDATE RESTRICT
        ON DELETE CASCADE
) STRICT;

CREATE TABLE servers (
    server_id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(server_id)) > 0),
    name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(name)) > 0),
    server_type TEXT NOT NULL CHECK (server_type IN ('local', 'remote')),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 9007199254740991),
    display_preferences_json TEXT NOT NULL DEFAULT '{}'
        CHECK (json_valid(display_preferences_json)),
    created_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
    updated_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        CHECK (updated_at_ms BETWEEN created_at_ms AND 9007199254740991),
    last_used_at_ms INTEGER CHECK (
        last_used_at_ms IS NULL
        OR last_used_at_ms BETWEEN 0 AND 9007199254740991
    ),
    UNIQUE (server_id, server_type)
) STRICT;

CREATE TABLE local_server_configs (
    server_id TEXT PRIMARY KEY NOT NULL,
    server_type TEXT NOT NULL DEFAULT 'local' CHECK (server_type = 'local'),
    executable_path TEXT NOT NULL CHECK (length(trim(executable_path)) > 0),
    arguments_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(arguments_json)),
    default_working_directory TEXT,
    non_sensitive_environment_json TEXT NOT NULL DEFAULT '{}'
        CHECK (json_valid(non_sensitive_environment_json)),
    sensitive_environment_credential_reference TEXT CHECK (
        sensitive_environment_credential_reference IS NULL
        OR length(trim(sensitive_environment_credential_reference)) > 0
    ),
    FOREIGN KEY (server_id, server_type)
        REFERENCES servers (server_id, server_type)
        ON DELETE CASCADE
) STRICT;

CREATE TABLE remote_server_configs (
    server_id TEXT PRIMARY KEY NOT NULL,
    server_type TEXT NOT NULL DEFAULT 'remote' CHECK (server_type = 'remote'),
    url TEXT NOT NULL CHECK (length(trim(url)) > 0),
    authentication_method TEXT NOT NULL CHECK (
        authentication_method IN ('none', 'bearer')
    ),
    credential_reference TEXT CHECK (
        credential_reference IS NULL OR length(trim(credential_reference)) > 0
    ),
    non_sensitive_headers_json TEXT NOT NULL DEFAULT '{}'
        CHECK (json_valid(non_sensitive_headers_json)),
    connect_timeout_ms INTEGER NOT NULL CHECK (connect_timeout_ms > 0),
    tls_certificate_policy TEXT NOT NULL DEFAULT 'strict' CHECK (
        tls_certificate_policy IN ('strict', 'allow_invalid')
    ),
    plaintext_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (plaintext_confirmed IN (0, 1)),
    proxy_id TEXT,
    CHECK (
        (
            authentication_method = 'none'
            AND credential_reference IS NULL
        ) OR (
            authentication_method = 'bearer'
        )
    ),
    FOREIGN KEY (server_id, server_type)
        REFERENCES servers (server_id, server_type)
        ON DELETE CASCADE,
    FOREIGN KEY (proxy_id)
        REFERENCES proxies (proxy_id)
        ON DELETE RESTRICT
) STRICT;

CREATE INDEX remote_server_configs_proxy_id_index
    ON remote_server_configs (proxy_id);

CREATE TABLE window_states (
    window_id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(window_id)) > 0),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 9007199254740991),
    server_id TEXT,
    current_thread_id TEXT,
    draft_key TEXT,
    position_x INTEGER CHECK (
        position_x IS NULL OR position_x BETWEEN -9007199254740991 AND 9007199254740991
    ),
    position_y INTEGER CHECK (
        position_y IS NULL OR position_y BETWEEN -9007199254740991 AND 9007199254740991
    ),
    width INTEGER CHECK (width IS NULL OR width BETWEEN 1 AND 9007199254740991),
    height INTEGER CHECK (height IS NULL OR height BETWEEN 1 AND 9007199254740991),
    is_maximized INTEGER NOT NULL DEFAULT 0 CHECK (is_maximized IN (0, 1)),
    is_fullscreen INTEGER NOT NULL DEFAULT 0 CHECK (is_fullscreen IN (0, 1)),
    ui_state_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(ui_state_json)),
    updated_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991),
    CHECK ((position_x IS NULL) = (position_y IS NULL)),
    CHECK ((width IS NULL) = (height IS NULL)),
    FOREIGN KEY (server_id)
        REFERENCES servers (server_id)
        ON DELETE RESTRICT
) STRICT;

CREATE INDEX window_states_server_id_index
    ON window_states (server_id);
