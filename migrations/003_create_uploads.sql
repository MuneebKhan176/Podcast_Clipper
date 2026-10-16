-- One row per upload session (a multipart upload in cloud storage).
-- The set of parts that are safely stored is NOT kept here: cloud storage is the source of truth
-- (ListParts), so the database can never disagree with what is really stored.
CREATE TABLE uploads (
    id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           uuid          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    fingerprint       char(64)      NOT NULL,           -- client-side identity of the file (sha-256 hex)
    original_filename varchar(255)  NOT NULL,
    content_type      varchar(100)  NOT NULL,
    size_bytes        bigint        NOT NULL CHECK (size_bytes > 0),
    part_size_bytes   bigint        NOT NULL CHECK (part_size_bytes > 0),
    total_parts       integer       NOT NULL CHECK (total_parts BETWEEN 1 AND 10000),
    object_key        varchar(512)  NOT NULL,
    storage_upload_id text          NOT NULL,           -- the storage service's multipart UploadId
    status            text          NOT NULL DEFAULT 'uploading'
                      CHECK (status IN ('uploading', 'completing', 'completed', 'aborted', 'expired')),
    etag              text,
    created_at        timestamptz   NOT NULL DEFAULT now(),
    updated_at        timestamptz   NOT NULL DEFAULT now(),
    completed_at      timestamptz,
    CONSTRAINT uploads_object_key_key UNIQUE (object_key)
);

-- Idempotent "initiate": at most ONE live session per user per file.
CREATE UNIQUE INDEX uploads_active_fingerprint_idx
    ON uploads (user_id, fingerprint)
    WHERE status IN ('uploading', 'completing');

CREATE INDEX uploads_user_created_idx   ON uploads (user_id, created_at DESC);
CREATE INDEX uploads_status_updated_idx ON uploads (status, updated_at);

CREATE TRIGGER uploads_set_updated_at
    BEFORE UPDATE ON uploads
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
