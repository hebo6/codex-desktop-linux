CREATE TABLE credential_cleanup_queue (
    credential_reference TEXT PRIMARY KEY NOT NULL CHECK (
        length(credential_reference) = 50
        AND substr(credential_reference, 1, 14) = 'credential:v1:'
        AND lower(credential_reference) = credential_reference
        AND substr(credential_reference, 23, 1) = '-'
        AND substr(credential_reference, 28, 1) = '-'
        AND substr(credential_reference, 29, 1) = '4'
        AND substr(credential_reference, 33, 1) = '-'
        AND substr(credential_reference, 34, 1) IN ('8', '9', 'a', 'b')
        AND substr(credential_reference, 38, 1) = '-'
        AND substr(credential_reference, 15) NOT GLOB '*[^0-9a-f-]*'
    ),
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('server', 'proxy')),
    owner_id TEXT NOT NULL CHECK (
        length(owner_id) = 36
        AND lower(owner_id) = owner_id
        AND substr(owner_id, 9, 1) = '-'
        AND substr(owner_id, 14, 1) = '-'
        AND substr(owner_id, 15, 1) = '4'
        AND substr(owner_id, 19, 1) = '-'
        AND substr(owner_id, 20, 1) IN ('8', '9', 'a', 'b')
        AND substr(owner_id, 24, 1) = '-'
        AND owner_id NOT GLOB '*[^0-9a-f-]*'
    ),
    credential_kind TEXT NOT NULL CHECK (
        credential_kind IN (
            'sensitive-environment',
            'bearer-token',
            'http-basic-password',
            'http-bearer-token',
            'socks5-password',
            'ssh-private-key-passphrase',
            'ssh-password'
        )
    ),
    queued_at_ms INTEGER NOT NULL CHECK (
        queued_at_ms BETWEEN 0 AND 9007199254740991
    ),
    CHECK (
        (
            owner_kind = 'server'
            AND credential_kind IN ('sensitive-environment', 'bearer-token')
        ) OR (
            owner_kind = 'proxy'
            AND credential_kind IN (
                'http-basic-password',
                'http-bearer-token',
                'socks5-password',
                'ssh-private-key-passphrase',
                'ssh-password'
            )
        )
    )
) STRICT;

CREATE INDEX credential_cleanup_queue_order_index
    ON credential_cleanup_queue (queued_at_ms, credential_reference);
