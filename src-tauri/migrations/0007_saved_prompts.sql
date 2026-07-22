CREATE TABLE saved_prompts (
    prompt_id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(prompt_id)) > 0),
    name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (
        length(trim(name)) BETWEEN 1 AND 80
    ),
    content TEXT NOT NULL CHECK (
        length(trim(content)) > 0 AND length(content) <= 32000
    ),
    sort_order INTEGER NOT NULL CHECK (
        sort_order BETWEEN 0 AND 9007199254740991
    ),
    version INTEGER NOT NULL DEFAULT 1 CHECK (
        version BETWEEN 1 AND 9007199254740991
    ),
    created_at_ms INTEGER NOT NULL CHECK (
        created_at_ms BETWEEN 0 AND 9007199254740991
    ),
    updated_at_ms INTEGER NOT NULL CHECK (
        updated_at_ms BETWEEN created_at_ms AND 9007199254740991
    )
) STRICT;

CREATE INDEX saved_prompts_sort_order
ON saved_prompts (sort_order, created_at_ms, prompt_id);
