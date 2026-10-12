'use strict';

const { pool } = require('../config/db');

/**
 * Atomically creates or replaces the pending registration for an email.
 * Returns { id } or null when a code was issued less than `cooldownSeconds` ago
 * (the conflict update is skipped by the WHERE clause, so nothing is overwritten).
 * Expiry is computed with the database clock so app/DB clock skew cannot matter.
 */
async function upsert(
  { username, email, passwordHash, codeHash, expirySeconds, cooldownSeconds },
  executor = pool
) {
  const { rows } = await executor.query(
    `INSERT INTO pending_users
       (username, email, password_hash, verification_code_hash, expires_at, attempt_count)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5), 0)
     ON CONFLICT (email) DO UPDATE SET
       username               = EXCLUDED.username,
       password_hash          = EXCLUDED.password_hash,
       verification_code_hash = EXCLUDED.verification_code_hash,
       expires_at             = EXCLUDED.expires_at,
       attempt_count          = 0,
       created_at             = now()
     WHERE pending_users.created_at <= now() - make_interval(secs => $6)
     RETURNING id`,
    [username, email, passwordHash, codeHash, expirySeconds, cooldownSeconds]
  );
  return rows[0] || null;
}

/** Locks the row for the rest of the transaction so concurrent verifies are serialized. */
async function findByEmailForUpdate(client, email) {
  const { rows } = await client.query(
    `SELECT id, username, email, password_hash, verification_code_hash, attempt_count,
            (expires_at <= now()) AS is_expired
       FROM pending_users
      WHERE email = $1
        FOR UPDATE`,
    [email]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    passwordHash: row.password_hash,
    codeHash: row.verification_code_hash,
    attemptCount: row.attempt_count,
    isExpired: row.is_expired,
  };
}

async function incrementAttempts(client, id) {
  const { rows } = await client.query(
    'UPDATE pending_users SET attempt_count = attempt_count + 1 WHERE id = $1 RETURNING attempt_count',
    [id]
  );
  return rows[0].attempt_count;
}

async function deleteById(id, executor = pool) {
  await executor.query('DELETE FROM pending_users WHERE id = $1', [id]);
}

async function deleteByEmail(email, executor = pool) {
  await executor.query('DELETE FROM pending_users WHERE email = $1', [email]);
}

async function deleteExpired(executor = pool) {
  const result = await executor.query('DELETE FROM pending_users WHERE expires_at <= now()');
  return result.rowCount;
}

module.exports = {
  upsert,
  findByEmailForUpdate,
  incrementAttempts,
  deleteById,
  deleteByEmail,
  deleteExpired,
};
