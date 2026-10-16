'use strict';

const { pool } = require('../config/db');

const COLUMNS = `id, user_id, fingerprint, original_filename, content_type, size_bytes, part_size_bytes,
  total_parts, object_key, storage_upload_id, status, etag, created_at, updated_at, completed_at`;

function toUpload(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    fingerprint: row.fingerprint,
    filename: row.original_filename,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes), // bigint arrives as a string; files are far below 2^53
    partSizeBytes: Number(row.part_size_bytes),
    totalParts: row.total_parts,
    objectKey: row.object_key,
    storageUploadId: row.storage_upload_id,
    status: row.status,
    etag: row.etag,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

const one = (result) => toUpload(result.rows[0]);

/** Returns null when another request already created the live session for this user+file. */
async function insertActive(u, executor = pool) {
  return one(
    await executor.query(
      `INSERT INTO uploads
         (id, user_id, fingerprint, original_filename, content_type, size_bytes, part_size_bytes,
          total_parts, object_key, storage_upload_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'uploading')
       ON CONFLICT (user_id, fingerprint) WHERE status IN ('uploading', 'completing') DO NOTHING
       RETURNING ${COLUMNS}`,
      [u.id, u.userId, u.fingerprint, u.filename, u.contentType, u.sizeBytes, u.partSizeBytes,
        u.totalParts, u.objectKey, u.storageUploadId]
    )
  );
}

async function findOwned(userId, id, executor = pool) {
  return one(await executor.query(`SELECT ${COLUMNS} FROM uploads WHERE id = $1 AND user_id = $2`, [id, userId]));
}

async function findActiveByFingerprint(userId, fingerprint, executor = pool) {
  return one(
    await executor.query(
      `SELECT ${COLUMNS} FROM uploads
        WHERE user_id = $1 AND fingerprint = $2 AND status IN ('uploading', 'completing')
        ORDER BY created_at DESC LIMIT 1`,
      [userId, fingerprint]
    )
  );
}

async function findCompletedByFingerprint(userId, fingerprint, executor = pool) {
  return one(
    await executor.query(
      `SELECT ${COLUMNS} FROM uploads
        WHERE user_id = $1 AND fingerprint = $2 AND status = 'completed'
        ORDER BY completed_at DESC LIMIT 1`,
      [userId, fingerprint]
    )
  );
}

async function countActive(userId, executor = pool) {
  const { rows } = await executor.query(
    `SELECT count(*)::int AS n FROM uploads WHERE user_id = $1 AND status IN ('uploading', 'completing')`,
    [userId]
  );
  return rows[0].n;
}

async function listByUser(userId, limit = 50, executor = pool) {
  const { rows } = await executor.query(
    `SELECT ${COLUMNS} FROM uploads
      WHERE user_id = $1 AND status IN ('uploading', 'completing', 'completed')
      ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows.map(toUpload);
}

/** Records activity so a session that is being used is never treated as stale. */
async function touch(id, executor = pool) {
  await executor.query(`UPDATE uploads SET updated_at = now() WHERE id = $1 AND status = 'uploading'`, [id]);
}

/**
 * Atomically takes the exclusive right to finalize. Only one caller can win; a claim abandoned by a
 * crashed server (older than staleSeconds) can be taken over.
 */
async function claimForCompletion(id, staleSeconds, executor = pool) {
  return one(
    await executor.query(
      `UPDATE uploads SET status = 'completing', updated_at = now()
        WHERE id = $1
          AND (status = 'uploading'
               OR (status = 'completing' AND updated_at < now() - make_interval(secs => $2)))
        RETURNING ${COLUMNS}`,
      [id, staleSeconds]
    )
  );
}

async function releaseClaim(id, executor = pool) {
  await executor.query(`UPDATE uploads SET status = 'uploading' WHERE id = $1 AND status = 'completing'`, [id]);
}

async function markCompleted(id, etag, executor = pool) {
  return one(
    await executor.query(
      `UPDATE uploads SET status = 'completed', etag = $2, completed_at = now()
        WHERE id = $1 AND status = 'completing'
        RETURNING ${COLUMNS}`,
      [id, etag]
    )
  );
}

/** uploading -> aborted, atomically. Null if the upload was not in the 'uploading' state. */
async function markAborted(id, executor = pool) {
  return one(
    await executor.query(
      `UPDATE uploads SET status = 'aborted' WHERE id = $1 AND status = 'uploading' RETURNING ${COLUMNS}`,
      [id]
    )
  );
}

async function reopenAborted(id, executor = pool) {
  await executor.query(`UPDATE uploads SET status = 'uploading' WHERE id = $1 AND status = 'aborted'`, [id]);
}

/** The storage service no longer knows this upload (e.g. a lifecycle rule removed it). */
async function markExpired(id, executor = pool) {
  return one(
    await executor.query(
      `UPDATE uploads SET status = 'expired' WHERE id = $1 AND status = 'uploading' RETURNING ${COLUMNS}`,
      [id]
    )
  );
}

async function findStale(ttlSeconds, limit = 100, executor = pool) {
  const { rows } = await executor.query(
    `SELECT ${COLUMNS} FROM uploads
      WHERE status = 'uploading' AND updated_at < now() - make_interval(secs => $1)
      ORDER BY updated_at LIMIT $2`,
    [ttlSeconds, limit]
  );
  return rows.map(toUpload);
}

/** Atomic and re-checks staleness, so a session that became active again is left alone. */
async function expireIfStale(id, ttlSeconds, executor = pool) {
  return one(
    await executor.query(
      `UPDATE uploads SET status = 'expired'
        WHERE id = $1 AND status = 'uploading' AND updated_at < now() - make_interval(secs => $2)
        RETURNING ${COLUMNS}`,
      [id, ttlSeconds]
    )
  );
}

module.exports = {
  insertActive,
  findOwned,
  findActiveByFingerprint,
  findCompletedByFingerprint,
  countActive,
  listByUser,
  touch,
  claimForCompletion,
  releaseClaim,
  markCompleted,
  markAborted,
  reopenAborted,
  markExpired,
  findStale,
  expireIfStale,
};
