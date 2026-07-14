CREATE TABLE thread_list_caches (
    server_id TEXT PRIMARY KEY NOT NULL,
    threads_json TEXT NOT NULL CHECK (json_valid(threads_json) AND json_type(threads_json) = 'array'),
    next_cursor TEXT,
    synced_at_ms INTEGER NOT NULL CHECK (synced_at_ms BETWEEN 0 AND 9007199254740991),
    FOREIGN KEY (server_id)
        REFERENCES servers (server_id)
        ON DELETE CASCADE
) STRICT;

CREATE TABLE thread_projection_caches (
    server_id TEXT NOT NULL,
    thread_id TEXT NOT NULL CHECK (length(trim(thread_id)) > 0),
    projection_json TEXT NOT NULL CHECK (json_valid(projection_json) AND json_type(projection_json) = 'object'),
    synced_at_ms INTEGER NOT NULL CHECK (synced_at_ms BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY (server_id, thread_id),
    FOREIGN KEY (server_id)
        REFERENCES servers (server_id)
        ON DELETE CASCADE
) STRICT;

CREATE INDEX thread_projection_caches_synced_index
    ON thread_projection_caches (server_id, synced_at_ms DESC);
