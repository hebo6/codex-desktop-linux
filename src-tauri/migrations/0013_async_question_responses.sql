CREATE TABLE async_question_responses (
    server_id TEXT NOT NULL,
    thread_id TEXT NOT NULL
        CHECK (length(thread_id) BETWEEN 1 AND 1024),
    question_key TEXT NOT NULL
        CHECK (question_key <> ''),
    disposition TEXT NOT NULL
        CHECK (disposition IN ('sent', 'ignored')),
    PRIMARY KEY (server_id, thread_id, question_key),
    FOREIGN KEY (server_id)
        REFERENCES servers (server_id)
        ON UPDATE RESTRICT
        ON DELETE CASCADE
) STRICT;
