CREATE TABLE pending_thread_results (
    server_id TEXT NOT NULL,
    thread_id TEXT NOT NULL
        CHECK (length(thread_id) BETWEEN 1 AND 1024),
    turn_id TEXT NOT NULL
        CHECK (length(turn_id) BETWEEN 1 AND 1024),
    updated_at_ms INTEGER NOT NULL
        CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY (server_id, thread_id),
    FOREIGN KEY (server_id)
        REFERENCES servers (server_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE
) STRICT;

CREATE INDEX pending_thread_results_updated_at_index
ON pending_thread_results (updated_at_ms DESC);
