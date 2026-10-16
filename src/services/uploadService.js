'use strict';

const crypto = require('crypto');
const config = require('../config/env');
const uploadRepository = require('../repositories/uploadRepository');
const storage = require('./storageService');
const { AppError } = require('../utils/errors');
const { planParts, partLength } = require('../utils/uploadMath');

const PG_FOREIGN_KEY_VIOLATION = '23503';

// ---------------------------------------------------------------------------------------------
// Design in one paragraph: the browser sends the bytes straight to cloud storage using short-lived
// presigned URLs (a 5 GB file never flows through this server). This service owns the session: it
// creates the multipart upload, hands out URLs, and on "complete" asks the storage service which
// parts it really holds (ListParts) and verifies every one before assembling the object. That
// listing is also the resume checkpoint, so the database can never disagree with reality.
// ---------------------------------------------------------------------------------------------

function sanitizeFilename(name) {
  const base = String(name).split(/[\\/]/).pop();
  const cleaned = base
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+/, '')
    .slice(-100);
  return cleaned || 'video';
}

const buildObjectKey = (userId, uploadId, filename) =>
  `uploads/${userId}/${uploadId}/${sanitizeFilename(filename)}`;

const encodeKey = (key) => key.split('/').map(encodeURIComponent).join('/');

function serialize(upload, completedParts) {
  const out = {
    id: upload.id,
    filename: upload.filename,
    contentType: upload.contentType,
    sizeBytes: upload.sizeBytes,
    partSizeBytes: upload.partSizeBytes,
    totalParts: upload.totalParts,
    status: upload.status,
    createdAt: upload.createdAt,
    completedAt: upload.completedAt,
  };
  if (upload.status === 'completed') {
    out.publicUrl = `${config.storage.publicUri}/${encodeKey(upload.objectKey)}`;
  }
  if (completedParts) out.completedParts = completedParts;
  return out;
}

/** Storage-service problems become a clean 502 (retryable) instead of leaking SDK details as a 500. */
async function viaStorage(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError || storage.isNoSuchUpload(err)) throw err;
    console.error('Storage error:', { name: err.name, message: err.message, status: err.$metadata?.httpStatusCode });
    throw new AppError(502, 'The storage service is temporarily unavailable. Please try again.', {
      reason: 'storage_unavailable',
    });
  }
}

async function getOwnedOrThrow(userId, id) {
  const upload = await uploadRepository.findOwned(userId, id);
  if (!upload) throw new AppError(404, 'Upload not found');
  return upload;
}

/**
 * The resume checkpoint: part numbers the storage service durably holds, or null when the storage
 * service has forgotten this upload (then the session is marked expired).
 */
async function completedPartNumbers(upload) {
  try {
    const parts = await viaStorage(() =>
      storage.listAllParts({ key: upload.objectKey, uploadId: upload.storageUploadId })
    );
    return parts.map((p) => p.partNumber);
  } catch (err) {
    if (storage.isNoSuchUpload(err)) {
      await uploadRepository.markExpired(upload.id);
      return null;
    }
    throw err;
  }
}

/** Which of parts 1..N are missing, or stored with the wrong byte size (e.g. a truncated PUT). */
function findProblemParts(upload, storedParts) {
  const bySize = new Map(storedParts.map((p) => [p.partNumber, p.size]));
  const missing = [];
  for (let n = 1; n <= upload.totalParts; n++) {
    const size = bySize.get(n);
    if (size === undefined || size !== partLength(n, upload.sizeBytes, upload.partSizeBytes)) missing.push(n);
  }
  return missing;
}

// ---------------------------------------------------------------------------------------------

/**
 * Idempotent. Same user + same file fingerprint => the same session (so a page refresh or a second tab
 * resumes instead of starting over). A finished file is returned as-is, so it is never uploaded twice.
 */
async function initiate(userId, { filename, size, contentType, fingerprint }) {
  const done = await uploadRepository.findCompletedByFingerprint(userId, fingerprint);
  if (done) return { upload: serialize(done, []), created: false };

  const existing = await uploadRepository.findActiveByFingerprint(userId, fingerprint);
  if (existing) {
    const resumed = await resumeExisting(existing);
    if (resumed) return { upload: resumed, created: false };
    // else: it had vanished from storage; fall through and start a fresh session
  }

  if ((await uploadRepository.countActive(userId)) >= config.upload.maxActivePerUser) {
    throw new AppError(
      429,
      `You already have ${config.upload.maxActivePerUser} uploads in progress. Finish or cancel one first.`,
      { reason: 'too_many_active_uploads' }
    );
  }

  const { partSizeBytes, totalParts } = planParts(size, config.upload.partSizeBytes);
  const id = crypto.randomUUID();
  const objectKey = buildObjectKey(userId, id, filename);
  const storageUploadId = await viaStorage(() => storage.createMultipartUpload({ key: objectKey, contentType }));

  let row;
  try {
    row = await uploadRepository.insertActive({
      id, userId, fingerprint, filename, contentType, sizeBytes: size, partSizeBytes, totalParts,
      objectKey, storageUploadId,
    });
  } catch (err) {
    await storage.abortMultipartUpload({ key: objectKey, uploadId: storageUploadId }).catch(() => {});
    if (err.code === PG_FOREIGN_KEY_VIOLATION) throw new AppError(401, 'Account no longer exists');
    throw err;
  }

  if (!row) {
    // Lost a race with a parallel initiate for the same file: discard our multipart upload, use theirs.
    await storage.abortMultipartUpload({ key: objectKey, uploadId: storageUploadId }).catch((e) =>
      console.error('Could not discard duplicate multipart upload:', e.message)
    );
    const winner = await uploadRepository.findActiveByFingerprint(userId, fingerprint);
    if (!winner) throw new AppError(409, 'Upload session changed, please retry', { reason: 'conflict' });
    const resumed = await resumeExisting(winner);
    if (!resumed) throw new AppError(409, 'Upload session changed, please retry', { reason: 'conflict' });
    return { upload: resumed, created: false };
  }

  return { upload: serialize(row, []), created: true };
}

async function resumeExisting(upload) {
  const parts = await completedPartNumbers(upload);
  if (parts === null) return null;
  await uploadRepository.touch(upload.id);
  return serialize(upload, parts);
}

async function getUpload(userId, id) {
  const upload = await getOwnedOrThrow(userId, id);
  if (upload.status !== 'uploading') return serialize(upload, []);
  const parts = await completedPartNumbers(upload);
  if (parts === null) return serialize({ ...upload, status: 'expired' }, []);
  await uploadRepository.touch(upload.id);
  return serialize(upload, parts);
}

async function listUploads(userId) {
  const uploads = await uploadRepository.listByUser(userId);
  return uploads.map((u) => serialize(u));
}

async function signParts(userId, id, partNumbers) {
  const upload = await getOwnedOrThrow(userId, id);
  if (upload.status !== 'uploading') {
    throw new AppError(409, 'This upload is no longer accepting parts', { reason: 'not_active', status: upload.status });
  }
  const outOfRange = partNumbers.filter((n) => n < 1 || n > upload.totalParts);
  if (outOfRange.length) {
    throw new AppError(400, `Part numbers must be between 1 and ${upload.totalParts}`, { reason: 'bad_part_number' });
  }

  const { urlTtlSeconds } = config.upload;
  const parts = await viaStorage(() =>
    Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await storage.presignUploadPart({
          key: upload.objectKey,
          uploadId: upload.storageUploadId,
          partNumber,
          expiresInSeconds: urlTtlSeconds,
        }),
      }))
    )
  );
  await uploadRepository.touch(upload.id);
  return { parts, expiresInSeconds: urlTtlSeconds, expiresAt: new Date(Date.now() + urlTtlSeconds * 1000).toISOString() };
}

/**
 * Verifies every part against what storage really holds, then assembles the object.
 * Safe to call repeatedly and concurrently: exactly one caller performs the finalization.
 */
async function complete(userId, id) {
  const upload = await getOwnedOrThrow(userId, id);
  if (upload.status === 'completed') return serialize(upload);
  if (upload.status !== 'uploading' && upload.status !== 'completing') {
    throw new AppError(409, 'This upload was cancelled or has expired. Please start again.', {
      reason: 'not_active',
      status: upload.status,
    });
  }

  const claimed = await uploadRepository.claimForCompletion(id, config.upload.completeStaleSeconds);
  if (!claimed) {
    const fresh = await getOwnedOrThrow(userId, id);
    if (fresh.status === 'completed') return serialize(fresh);
    if (fresh.status === 'completing') {
      throw new AppError(409, 'The upload is being finalized. Try again in a moment.', { reason: 'in_progress' });
    }
    throw new AppError(409, 'This upload is no longer active.', { reason: 'not_active', status: fresh.status });
  }

  let finalized = false;
  try {
    const result = await finalize(claimed);
    const row = await uploadRepository.markCompleted(id, result.etag);
    finalized = true;
    return serialize(row ?? { ...claimed, status: 'completed' });
  } finally {
    if (!finalized) await uploadRepository.releaseClaim(id).catch((e) => console.error('releaseClaim failed:', e.message));
  }
}

async function finalize(upload) {
  const { objectKey: key, storageUploadId: uploadId } = upload;

  let parts;
  try {
    parts = await viaStorage(() => storage.listAllParts({ key, uploadId }));
  } catch (err) {
    if (storage.isNoSuchUpload(err)) return recoverFinishedObject(upload);
    throw err;
  }

  const missingParts = findProblemParts(upload, parts);
  if (missingParts.length) {
    throw new AppError(409, `Upload is incomplete: ${missingParts.length} part(s) missing or damaged.`, {
      reason: 'incomplete',
      missingParts,
    });
  }

  let etag;
  try {
    ({ etag } = await viaStorage(() => storage.completeMultipartUpload({ key, uploadId, parts })));
  } catch (err) {
    if (storage.isNoSuchUpload(err)) return recoverFinishedObject(upload);
    throw err;
  }

  const head = await viaStorage(() => storage.headObject(key));
  if (!head || head.size !== upload.sizeBytes) {
    console.error('Assembled object size mismatch', { uploadId: upload.id, expected: upload.sizeBytes, actual: head?.size });
    throw new AppError(502, 'The stored file did not match the expected size. Please upload again.', {
      reason: 'size_mismatch',
    });
  }
  return { etag: head.etag || etag };
}

/**
 * The multipart upload is gone. If the finished object exists with the right size, a previous
 * "complete" succeeded in storage but its answer was lost (crash / network): finish the bookkeeping.
 */
async function recoverFinishedObject(upload) {
  const head = await viaStorage(() => storage.headObject(upload.objectKey));
  if (head && head.size === upload.sizeBytes) return { etag: head.etag };
  throw new AppError(409, 'The upload session no longer exists in storage. Please start again.', {
    reason: 'not_active',
    status: 'expired',
  });
}

async function abort(userId, id) {
  const upload = await getOwnedOrThrow(userId, id);
  if (upload.status === 'completed') {
    throw new AppError(409, 'A completed upload cannot be cancelled.', { reason: 'already_completed' });
  }
  if (upload.status === 'aborted' || upload.status === 'expired') return serialize(upload);

  const marked = await uploadRepository.markAborted(id);
  if (!marked) {
    const fresh = await getOwnedOrThrow(userId, id);
    if (fresh.status === 'completed') {
      throw new AppError(409, 'A completed upload cannot be cancelled.', { reason: 'already_completed' });
    }
    if (fresh.status === 'completing') {
      throw new AppError(409, 'The upload is being finalized.', { reason: 'in_progress' });
    }
    return serialize(fresh);
  }

  try {
    await viaStorage(() => storage.abortMultipartUpload({ key: upload.objectKey, uploadId: upload.storageUploadId }));
  } catch (err) {
    await uploadRepository.reopenAborted(id).catch(() => {}); // storage still holds the parts: stay retryable
    throw err;
  }
  return serialize(marked);
}

/** Housekeeping: sessions with no activity for UPLOAD_SESSION_TTL_HOURS are expired and their parts freed. */
async function expireStaleUploads() {
  const { sessionTtlSeconds } = config.upload;
  const stale = await uploadRepository.findStale(sessionTtlSeconds);
  let expired = 0;
  for (const upload of stale) {
    const row = await uploadRepository.expireIfStale(upload.id, sessionTtlSeconds);
    if (!row) continue; // became active again
    expired++;
    await storage
      .abortMultipartUpload({ key: upload.objectKey, uploadId: upload.storageUploadId })
      .catch((e) => console.error('Could not abort expired upload in storage:', e.message));
  }
  return expired;
}

module.exports = {
  initiate, getUpload, listUploads, signParts, complete, abort, expireStaleUploads, sanitizeFilename,
};
