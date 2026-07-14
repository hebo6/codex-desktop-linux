CREATE TABLE drafts (
    draft_key TEXT PRIMARY KEY NOT NULL
        CHECK (length(draft_key) BETWEEN 1 AND 512),
    draft_json TEXT NOT NULL
        CHECK (json_valid(draft_json) AND json_type(draft_json) = 'object'),
    updated_at_ms INTEGER NOT NULL
        CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991)
) STRICT;

CREATE INDEX drafts_updated_at_index ON drafts (updated_at_ms DESC);
