ALTER TABLE window_server_states
ADD COLUMN tabs_json TEXT NOT NULL DEFAULT '[]'
CHECK (json_valid(tabs_json) AND json_type(tabs_json) = 'array');

ALTER TABLE window_server_states
ADD COLUMN active_tab_id TEXT;

UPDATE window_server_states
SET tabs_json = CASE
        WHEN current_thread_id IS NULL
            THEN json_array(json_object('id', 'initial', 'threadId', NULL))
        ELSE json_array(json_object(
            'id', 'initial',
            'threadId', current_thread_id
        ))
    END,
    active_tab_id = 'initial';

INSERT INTO window_server_states (
    window_id,
    server_id,
    tabs_json,
    active_tab_id,
    updated_at_ms
)
SELECT
    window_states.window_id,
    window_states.server_id,
    CASE
        WHEN window_states.current_thread_id IS NULL
            THEN json_array(json_object('id', 'initial', 'threadId', NULL))
        ELSE json_array(json_object(
            'id', 'initial',
            'threadId', window_states.current_thread_id
        ))
    END,
    'initial',
    window_states.updated_at_ms
FROM window_states
WHERE window_states.server_id IS NOT NULL
ON CONFLICT (window_id, server_id) DO NOTHING;

ALTER TABLE window_server_states DROP COLUMN current_thread_id;

ALTER TABLE window_states DROP COLUMN current_thread_id;

DELETE FROM server_window_references;

CREATE UNIQUE INDEX server_window_references_unique_server
ON server_window_references (server_id);

DELETE FROM drafts
WHERE substr(draft_key, -4) = ':new';
