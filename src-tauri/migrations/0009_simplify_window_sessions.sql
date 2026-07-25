INSERT INTO drafts (draft_key, draft_json, updated_at_ms)
SELECT
    window_server_states.window_id || ':' || window_server_states.server_id || ':new',
    drafts.draft_json,
    drafts.updated_at_ms
FROM window_server_states
JOIN drafts
    ON drafts.draft_key =
        window_server_states.window_id || ':' ||
        window_server_states.server_id || ':' ||
        window_server_states.draft_key
WHERE window_server_states.current_thread_id IS NULL
  AND window_server_states.draft_key IS NOT NULL
ON CONFLICT (draft_key) DO UPDATE SET
    draft_json = excluded.draft_json,
    updated_at_ms = excluded.updated_at_ms;

DELETE FROM drafts
WHERE EXISTS (
    SELECT 1
    FROM window_server_states
    WHERE substr(
        drafts.draft_key,
        1,
        length(
            window_server_states.window_id || ':' ||
            window_server_states.server_id || ':draft:'
        )
    ) =
        window_server_states.window_id || ':' ||
        window_server_states.server_id || ':draft:'
);

ALTER TABLE window_server_states DROP COLUMN draft_key;

ALTER TABLE window_states DROP COLUMN draft_key;
