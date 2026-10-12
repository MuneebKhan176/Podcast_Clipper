-- Unverified registrations. One row per normalized email.
CREATE TABLE pending_users (
    id                     uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    username               varchar(50)  NOT NULL,
    email                  varchar(254) NOT NULL,
    password_hash          varchar(100) NOT NULL,
    verification_code_hash char(64)     NOT NULL,   -- hex HMAC-SHA256, never the raw code
    expires_at             timestamptz  NOT NULL,
    attempt_count          integer      NOT NULL DEFAULT 0,
    created_at             timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT pending_users_email_key       UNIQUE (email),
    CONSTRAINT pending_users_email_lowercase CHECK (email = lower(email)),
    CONSTRAINT pending_users_attempts_nonneg CHECK (attempt_count >= 0)
);

-- Supports the periodic cleanup of expired rows.
CREATE INDEX pending_users_expires_at_idx ON pending_users (expires_at);
