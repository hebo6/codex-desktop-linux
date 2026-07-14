CREATE TABLE window_server_states (
    window_id TEXT NOT NULL,
    server_id TEXT NOT NULL,
    current_thread_id TEXT,
    draft_key TEXT,
    updated_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY (window_id, server_id),
    FOREIGN KEY (window_id)
        REFERENCES window_states (window_id)
        ON DELETE CASCADE,
    FOREIGN KEY (server_id)
        REFERENCES servers (server_id)
        ON DELETE CASCADE
) STRICT;

CREATE INDEX window_server_states_server_id_index
    ON window_server_states (server_id);

CREATE TABLE server_window_references (
    window_id TEXT PRIMARY KEY NOT NULL,
    server_id TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991),
    FOREIGN KEY (window_id)
        REFERENCES window_states (window_id)
        ON DELETE CASCADE,
    FOREIGN KEY (server_id)
        REFERENCES servers (server_id)
        ON DELETE RESTRICT
) STRICT;

CREATE INDEX server_window_references_server_id_index
    ON server_window_references (server_id);
