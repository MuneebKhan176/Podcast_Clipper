import { request } from './httpClient.js';

// One function per backend endpoint under /api/uploads.

/** POST /api/uploads -> { upload, resumed }. Idempotent: the same file returns the same session. */
export async function initiate({ filename, size, contentType, fingerprint }, signal) {
  const res = await request('/api/uploads', { method: 'POST', body: { filename, size, contentType, fingerprint }, signal });
  return res.data;
}

/** GET /api/uploads/:id -> upload (with completedParts while it is still uploading). */
export async function getUpload(id, signal) {
  const res = await request(`/api/uploads/${id}`, { signal });
  return res.data.upload;
}

/** POST /api/uploads/:id/parts/sign -> { parts: [{ partNumber, url }], expiresAt, expiresInSeconds } */
export async function signParts(id, partNumbers, signal) {
  const res = await request(`/api/uploads/${id}/parts/sign`, { method: 'POST', body: { partNumbers }, signal });
  return res.data;
}

/**
 * POST /api/uploads/:id/complete -> upload.
 * Throws ApiError 409 with data.reason 'incomplete' (data.missingParts) or 'in_progress'.
 */
export async function complete(id, signal) {
  const res = await request(`/api/uploads/${id}/complete`, { method: 'POST', signal });
  return res.data.upload;
}

/** POST /api/uploads/:id/abort */
export async function abort(id) {
  const res = await request(`/api/uploads/${id}/abort`, { method: 'POST' });
  return res.data.upload;
}

/** GET /api/uploads -> the user's uploads, newest first. */
export async function list(signal) {
  const res = await request('/api/uploads', { signal });
  return res.data.uploads;
}
