CREATE TABLE app_preferences (
    preference_scope TEXT PRIMARY KEY NOT NULL CHECK (preference_scope = 'global'),
    preferences_json TEXT NOT NULL CHECK (json_valid(preferences_json) AND json_type(preferences_json) = 'object'),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991)
) STRICT;
