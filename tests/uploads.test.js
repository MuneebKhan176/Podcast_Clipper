'use strict';

const { describe, it, before, beforeEach, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');
const { bootstrapWithStorage } = require('./helpers/helpers');
const { md5 } = require('./helpers/fakeS3');

const PART = 10; // bytes per part in tests (production default is 16 MiB)
const FP = (n) => crypto.createHash('sha256').update(`file-${n}`).digest('hex');

let ctx; // { app, pool, emailService, fakeS3, origin, ... }
const sent = [];

// ---- helpers --------------------------------------------------------------------------------
async function signUp(email) {
  const username = email.split('@')[0];
  await request(ctx.app).post('/api/auth/register').set('Origin', ctx.origin)
    .send({ username, email, password: 'Str0ngPass!', confirmPassword: 'Str0ngPass!' }).expect(201);
  const agent = request.agent(ctx.app);
  const res = await agent.post('/api/auth/verify-email').set('Origin', ctx.origin)
    .send({ email, code: sent.at(-1).code }).expect(201);
  return { agent, user: res.body.data.user };
}

const api = (agent) => ({
  post: (path, body) => agent.post(path).set('Origin', ctx.origin).send(body),
  get: (path) => agent.get(path),
});

/** A video "file": deterministic bytes so the assembled object can be compared byte-for-byte. */
function makeFile(size, seed = 1) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 31 + seed) % 251;
  return buf;
}
const slice = (buf, n) => buf.subarray((n - 1) * PART, Math.min(n * PART, buf.length));

const initiateBody = (buf, n = 1, extra = {}) => ({
  filename: `episode-${n}.mp4`, size: buf.length, contentType: 'video/mp4', fingerprint: FP(n), ...extra,
});

// Not async on purpose: it must return the chainable supertest request so callers can .expect(...).
const initiate = (agent, buf, n = 1, extra = {}) => api(agent).post('/api/uploads', initiateBody(buf, n, extra));

/** Signs the given parts and PUTs their bytes straight to "storage", like the browser does. */
async function putParts(agent, uploadId, buf, partNumbers, { bytes } = {}) {
  const sign = await api(agent).post(`/api/uploads/${uploadId}/parts/sign`, { partNumbers }).expect(200);
  const results = await Promise.all(
    sign.body.data.parts.map(async ({ partNumber, url }) => {
      const body = bytes?.[partNumber] ?? slice(buf, partNumber);
      const r = await fetch(url, { method: 'PUT', body });
      return { partNumber, status: r.status, etag: r.headers.get('etag') };
    })
  );
  for (const r of results) assert.equal(r.status, 200, `part ${r.partNumber} PUT failed`);
  return results;
}

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
// The updated_at trigger rewrites the column on every UPDATE, so disable it while faking an old timestamp.
const backdate = (id, interval) =>
  ctx.pool.query(`
    ALTER TABLE uploads DISABLE TRIGGER uploads_set_updated_at;
    UPDATE uploads SET updated_at = now() - interval '${interval}' WHERE id = '${id}';
    ALTER TABLE uploads ENABLE TRIGGER uploads_set_updated_at;`);
const dbRow = async (id) => (await ctx.pool.query('SELECT * FROM uploads WHERE id = $1', [id])).rows[0];

// ---- setup ----------------------------------------------------------------------------------
before(async () => {
  ctx = await bootstrapWithStorage({
    UPLOAD_PART_SIZE_BYTES: String(PART),
    UPLOAD_MAX_BYTES: '10000',
    UPLOAD_MAX_ACTIVE_PER_USER: '3',
    UPLOAD_COMPLETE_STALE_SECONDS: '120',
    UPLOAD_URL_TTL_SECONDS: '900',
  });
  await ctx.runMigrations();
  mock.method(ctx.emailService, 'sendVerificationEmail', async (email, code) => { sent.push({ email, code }); });
});
beforeEach(async () => {
  sent.length = 0;
  ctx.fakeS3.reset();
  await ctx.pool.query('TRUNCATE users, pending_users CASCADE');
});
after(async () => {
  mock.restoreAll();
  await ctx.pool.end();
  await ctx.fakeS3.stop();
});

// ---------------------------------------------------------------------------------------------
describe('access control and validation', () => {
  it('requires authentication on every upload endpoint', async () => {
    const id = crypto.randomUUID();
    const calls = [
      request(ctx.app).get('/api/uploads'),
      request(ctx.app).post('/api/uploads').set('Origin', ctx.origin).send({}),
      request(ctx.app).get(`/api/uploads/${id}`),
      request(ctx.app).post(`/api/uploads/${id}/parts/sign`).set('Origin', ctx.origin).send({ partNumbers: [1] }),
      request(ctx.app).post(`/api/uploads/${id}/complete`).set('Origin', ctx.origin),
      request(ctx.app).post(`/api/uploads/${id}/abort`).set('Origin', ctx.origin),
    ];
    for (const res of await Promise.all(calls)) assert.equal(res.status, 401);
  });

  it('rejects invalid initiate requests', async () => {
    const { agent } = await signUp('val@example.com');
    const ok = initiateBody(makeFile(25));
    const bad = [
      [{}, 400],
      [{ ...ok, size: 0 }, 400],
      [{ ...ok, size: 10001 }, 400], // over UPLOAD_MAX_BYTES
      [{ ...ok, size: 12.5 }, 400],
      [{ ...ok, size: '25' }, 400],
      [{ ...ok, filename: 'virus.exe' }, 400],
      [{ ...ok, filename: 'notes' }, 400],
      [{ ...ok, contentType: 'text/html' }, 400],
      [{ ...ok, fingerprint: 'nothex' }, 400],
      [{ ...ok, filename: '' }, 400],
    ];
    for (const [body, status] of bad) {
      const res = await api(agent).post('/api/uploads', body);
      assert.equal(res.status, status, JSON.stringify(body));
      assert.equal(res.body.success, false);
    }
    assert.equal(ctx.fakeS3.stats.create, 0, 'nothing is created in storage for invalid requests');
  });

  it('accepts a missing/octet-stream content type for a known video extension', async () => {
    const { agent } = await signUp('ct@example.com');
    const buf = makeFile(25);
    const res = await api(agent).post('/api/uploads', { ...initiateBody(buf), filename: 'clip.mkv', contentType: '' }).expect(201);
    assert.equal(res.body.data.upload.contentType, 'video/x-matroska');
  });

  it('sanitizes hostile filenames in the storage key', async () => {
    const { agent, user } = await signUp('evil@example.com');
    const res = await initiate(agent, makeFile(25), 1, { filename: '../../etc/pa ss"wd<>.mp4' }).expect(201);
    const row = await dbRow(res.body.data.upload.id);
    assert.match(row.object_key, new RegExp(`^uploads/${user.id}/${res.body.data.upload.id}/[A-Za-z0-9._-]+\\.mp4$`));
    assert.ok(!row.object_key.includes('..'));
    assert.equal(row.original_filename, '../../etc/pa ss"wd<>.mp4'.trim());
  });

  it('treats a malformed upload id as 404', async () => {
    const { agent } = await signUp('uuid@example.com');
    await api(agent).get('/api/uploads/not-a-uuid').expect(404);
    await api(agent).post('/api/uploads/123/complete').expect(404);
  });
});

describe('initiate (idempotency)', () => {
  it('creates a session: 5 parts for 45 bytes, a real multipart upload in storage, one DB row', async () => {
    const { agent, user } = await signUp('init@example.com');
    const buf = makeFile(45);
    const res = await initiate(agent, buf).expect(201);
    const up = res.body.data.upload;
    assert.equal(res.body.data.resumed, false);
    assert.deepEqual(
      { status: up.status, sizeBytes: up.sizeBytes, partSizeBytes: up.partSizeBytes, totalParts: up.totalParts, completedParts: up.completedParts },
      { status: 'uploading', sizeBytes: 45, partSizeBytes: PART, totalParts: 5, completedParts: [] }
    );
    assert.equal(up.publicUrl, undefined, 'no public URL until completed');
    assert.equal(ctx.fakeS3.multiparts.size, 1);
    const row = await dbRow(up.id);
    assert.equal(row.user_id, user.id);
    assert.equal(row.fingerprint, FP(1));
    assert.ok(row.storage_upload_id.startsWith('mpu-'));
  });

  it('is idempotent: the same file returns the SAME session and does not create another upload', async () => {
    const { agent } = await signUp('idem@example.com');
    const buf = makeFile(45);
    const first = await initiate(agent, buf).expect(201);
    const second = await initiate(agent, buf).expect(200);
    assert.equal(second.body.data.resumed, true);
    assert.equal(second.body.data.upload.id, first.body.data.upload.id);
    assert.equal(ctx.fakeS3.stats.create, 1);
    assert.equal((await ctx.pool.query('SELECT count(*)::int n FROM uploads')).rows[0].n, 1);
  });

  it('survives parallel initiates: one session, one live multipart upload, losers cleaned up', async () => {
    const { agent } = await signUp('race@example.com');
    const buf = makeFile(45);
    const results = await Promise.all(Array.from({ length: 6 }, () => initiate(agent, buf)));
    for (const r of results) assert.ok([200, 201].includes(r.status), `status ${r.status}`);
    const ids = new Set(results.map((r) => r.body.data.upload.id));
    assert.equal(ids.size, 1);
    assert.equal((await ctx.pool.query('SELECT count(*)::int n FROM uploads')).rows[0].n, 1);
    assert.equal(ctx.fakeS3.activeUploadIds().length, 1, 'duplicate multipart uploads were aborted');
  });

  it('does not share sessions between users', async () => {
    const a = await signUp('usera@example.com');
    const b = await signUp('userb@example.com');
    const buf = makeFile(45);
    const ra = await initiate(a.agent, buf).expect(201);
    const rb = await initiate(b.agent, buf).expect(201);
    assert.notEqual(ra.body.data.upload.id, rb.body.data.upload.id);
  });

  it('limits concurrent unfinished uploads per user (429)', async () => {
    const { agent } = await signUp('limit@example.com');
    for (let n = 1; n <= 3; n++) await initiate(agent, makeFile(25, n), n).expect(201);
    const res = await initiate(agent, makeFile(25, 4), 4).expect(429);
    assert.equal(res.body.data.reason, 'too_many_active_uploads');
    // an existing file can still be resumed at the limit
    await initiate(agent, makeFile(25, 1), 1).expect(200);
  });

  it('starts a fresh session when storage has forgotten the old one (expired/lifecycle-aborted)', async () => {
    const { agent } = await signUp('gone@example.com');
    const buf = makeFile(45);
    const first = await initiate(agent, buf).expect(201);
    ctx.fakeS3.multiparts.clear(); // e.g. a lifecycle rule removed it
    const second = await initiate(agent, buf).expect(201);
    assert.notEqual(second.body.data.upload.id, first.body.data.upload.id);
    assert.equal((await dbRow(first.body.data.upload.id)).status, 'expired');
    assert.equal(ctx.fakeS3.multiparts.size, 1);
  });
});

describe('presigned part URLs', () => {
  it('signs exactly the requested parts, pointing at storage, with no checksum params', async () => {
    const { agent } = await signUp('sign@example.com');
    const up = (await initiate(agent, makeFile(45)).expect(201)).body.data.upload;
    const res = await api(agent).post(`/api/uploads/${up.id}/parts/sign`, { partNumbers: [2, 4] }).expect(200);
    assert.equal(res.body.data.parts.length, 2);
    assert.equal(res.body.data.expiresInSeconds, 900);
    assert.ok(Date.parse(res.body.data.expiresAt) > Date.now());
    for (const { partNumber, url } of res.body.data.parts) {
      const u = new URL(url);
      assert.equal(u.origin, ctx.fakeS3.endpoint);
      assert.equal(u.searchParams.get('partNumber'), String(partNumber));
      assert.equal(u.searchParams.get('uploadId'), (await dbRow(up.id)).storage_upload_id);
      assert.ok(u.searchParams.get('X-Amz-Signature'));
      assert.equal(u.searchParams.get('X-Amz-Expires'), '900');
      assert.ok(![...u.searchParams.keys()].some((k) => /checksum/i.test(k)), 'no checksum params (R2 compatibility)');
    }
  });

  it('rejects bad part numbers', async () => {
    const { agent } = await signUp('bad@example.com');
    const up = (await initiate(agent, makeFile(45)).expect(201)).body.data.upload;
    const sign = (partNumbers) => api(agent).post(`/api/uploads/${up.id}/parts/sign`, { partNumbers });
    await sign([0]).expect(400);
    await sign([6]).expect(400); // only 5 parts exist
    await sign([1, 1]).expect(400);
    await sign([]).expect(400);
    await sign(range(1, 51)).expect(400); // over 50 per request
    await sign(['1']).expect(400);
    await sign([1.5]).expect(400);
    await api(agent).post(`/api/uploads/${up.id}/parts/sign`, {}).expect(400);
  });

  it('refuses to sign for aborted or completed uploads (409)', async () => {
    const { agent } = await signUp('inactive@example.com');
    const buf = makeFile(25);
    const up = (await initiate(agent, buf).expect(201)).body.data.upload;
    await api(agent).post(`/api/uploads/${up.id}/abort`).expect(200);
    const res = await api(agent).post(`/api/uploads/${up.id}/parts/sign`, { partNumbers: [1] }).expect(409);
    assert.equal(res.body.data.reason, 'not_active');
  });
});

describe('uploading, resuming and completing', () => {
  it('uploads all parts and assembles the exact bytes; completion is recorded once', async () => {
    const { agent } = await signUp('full@example.com');
    const buf = makeFile(45);
    const up = (await initiate(agent, buf).expect(201)).body.data.upload;
    await putParts(agent, up.id, buf, range(1, 5));

    const res = await api(agent).post(`/api/uploads/${up.id}/complete`).expect(200);
    const done = res.body.data.upload;
    assert.equal(done.status, 'completed');
    assert.ok(done.completedAt);
    assert.match(done.publicUrl, /^https:\/\/pub-test\.r2\.dev\/uploads\/[0-9a-f-]+\/[0-9a-f-]+\/episode-1\.mp4$/);

    const row = await dbRow(up.id);
    assert.equal(row.status, 'completed');
    const stored = ctx.fakeS3.objects.get(row.object_key);
    assert.ok(stored, 'object exists in storage');
    assert.equal(md5(stored.data), md5(buf), 'stored bytes are identical to the source file');
    assert.equal(row.etag, stored.etag);
    assert.equal(ctx.fakeS3.stats.complete, 1);
    assert.equal(ctx.fakeS3.multiparts.size, 0, 'multipart upload was consumed');
  });

  it('RESUME: after a "crash", only the missing parts are uploaded; finished parts are never re-sent', async () => {
    const { agent } = await signUp('resume@example.com');
    const buf = makeFile(45);
    const up = (await initiate(agent, buf).expect(201)).body.data.upload;

    await putParts(agent, up.id, buf, [1, 3]); // ...then the network dies / the tab closes
    assert.equal(ctx.fakeS3.stats.putPart, 2);

    // A new browser session: same user selects the same file again.
    const again = await initiate(agent, buf).expect(200);
    assert.equal(again.body.data.upload.id, up.id);
    assert.deepEqual(again.body.data.upload.completedParts, [1, 3], 'checkpoint comes from storage');
    const status = await api(agent).get(`/api/uploads/${up.id}`).expect(200);
    assert.deepEqual(status.body.data.upload.completedParts, [1, 3]);

    await putParts(agent, up.id, buf, [2, 4, 5]); // only what was missing
    assert.equal(ctx.fakeS3.stats.putPart, 5, 'five parts sent in total, not seven');

    await api(agent).post(`/api/uploads/${up.id}/complete`).expect(200);
    assert.equal(md5(ctx.fakeS3.objects.get((await dbRow(up.id)).object_key).data), md5(buf));
  });

  it('re-sending an already stored part is harmless (idempotent) and does not change the result', async () => {
    const { agent } = await signUp('dupe@example.com');
    const buf = makeFile(45);
    const up = (await initiate(agent, buf).expect(201)).body.data.upload;
    const first = await putParts(agent, up.id, buf, range(1, 5));
    const second = await putParts(agent, up.id, buf, [2, 5]);
    assert.equal(second[0].etag, first[1].etag, 'same bytes -> same ETag');
    const status = await api(agent).get(`/api/uploads/${up.id}`).expect(200);
    assert.deepEqual(status.body.data.upload.completedParts, range(1, 5));
    await api(agent).post(`/api/uploads/${up.id}/complete`).expect(200);
    assert.equal(md5(ctx.fakeS3.objects.get((await dbRow(up.id)).object_key).data), md5(buf));
  });

  it('refuses to complete while parts are missing, names them, and leaves the upload resumable', async () => {
    const { agent } = await signUp('missing@example.com');
    const buf = makeFile(45);
    const up = (await initiate(agent, buf).expect(201)).body.data.upload;
    await putParts(agent, up.id, buf, [1, 2, 4]);

    const res = await api(agent).post(`/api/uploads/${up.id}/complete`).expect(409);
    assert.equal(res.body.data.reason, 'incomplete');
    assert.deepEqual(res.body.data.missingParts, [3, 5]);
    assert.equal((await dbRow(up.id)).status, 'uploading', 'claim was released');
    assert.equal(ctx.fakeS3.stats.complete, 0, 'storage was never asked to assemble a partial file');
    assert.equal(ctx.fakeS3.objects.size, 0);

    await putParts(agent, up.id, buf, [3, 5]);
    await api(agent).post(`/api/uploads/${up.id}/complete`).expect(200);
  });

  it('detects a damaged (wrong-size) part, reports it, and accepts the corrected re-upload', async () => {
    const { agent } = await signUp('damaged@example.com');
    const buf = makeFile(45);
    const up = (await initiate(agent, buf).expect(201)).body.data.upload;
    await putParts(agent, up.id, buf, range(1, 5), { bytes: { 2: buf.subarray(10, 17) } }); // 7 bytes instead of 10

    const res = await api(agent).post(`/api/uploads/${up.id}/complete`).expect(409);
    assert.deepEqual(res.body.data.missingParts, [2]);
    assert.equal(ctx.fakeS3.stats.complete, 0);

    await putParts(agent, up.id, buf, [2]); // overwrite with the right bytes
    await api(agent).post(`/api/uploads/${up.id}/complete`).expect(200);
    assert.equal(md5(ctx.fakeS3.objects.get((await dbRow(up.id)).object_key).data), md5(buf));
  });

  it('complete is idempotent: repeating it returns the same result and never re-assembles', async () => {
    const { agent } = await signUp('again@example.com');
    const buf = makeFile(45);
    const up = (await initiate(agent, buf).expect(201)).body.data.upload;
    await putParts(agent, up.id, buf, range(1, 5));
    const a = await api(agent).post(`/api/uploads/${up.id}/complete`).expect(200);
    const b = await api(agent).post(`/api/uploads/${up.id}/complete`).expect(200);
    assert.equal(b.body.data.upload.completedAt, a.body.data.upload.completedAt);
    assert.equal(ctx.fakeS3.stats.complete, 1);
  });

  it('concurrent completes finalize exactly once', async () => {
    const { agent } = await signUp('concurrent@example.com');
    const buf = makeFile(45);
    const up = (await initiate(agent, buf).expect(201)).body.data.upload;
    await putParts(agent, up.id, buf, range(1, 5));

    const results = await Promise.all(Array.from({ length: 6 }, () => api(agent).post(`/api/uploads/${up.id}/complete`)));
    for (const r of results) {
      assert.ok(r.status === 200 || (r.status === 409 && r.body.data.reason === 'in_progress'), `unexpected ${r.status}`);
    }
    assert.ok(results.some((r) => r.status === 200));
    assert.equal(ctx.fakeS3.stats.complete, 1, 'storage assembled the object exactly once');
    assert.equal((await dbRow(up.id)).status, 'completed');
    await api(agent).post(`/api/uploads/${up.id}/complete`).expect(200);
  });

  it('recovers when storage finished but the reply was lost (object exists, session gone)', async () => {
    const { agent } = await signUp('lostreply@example.com');
    const buf = makeFile(45);
    const up = (await initiate(agent, buf).expect(201)).body.data.upload;
    await putParts(agent, up.id, buf, range(1, 5));
    ctx.fakeS3.finishBehindTheScenes((await dbRow(up.id)).storage_upload_id);

    const res = await api(agent).post(`/api/uploads/${up.id}/complete`).expect(200);
    assert.equal(res.body.data.upload.status, 'completed');
    assert.equal(ctx.fakeS3.stats.complete, 0, 'no second assemble attempt');
  });

  it('a fresh "completing" claim blocks others (409 in_progress); an abandoned one is taken over', async () => {
    const { agent } = await signUp('claim@example.com');
    const buf = makeFile(45);
    const up = (await initiate(agent, buf).expect(201)).body.data.upload;
    await putParts(agent, up.id, buf, range(1, 5));

    await ctx.pool.query(`UPDATE uploads SET status = 'completing' WHERE id = $1`, [up.id]);
    const blocked = await api(agent).post(`/api/uploads/${up.id}/complete`).expect(409);
    assert.equal(blocked.body.data.reason, 'in_progress');

    await backdate(up.id, '10 minutes');
    await api(agent).post(`/api/uploads/${up.id}/complete`).expect(200);
  });

  it('returns a finished file instead of uploading it again (same file, same user)', async () => {
    const { agent } = await signUp('dedupe@example.com');
    const buf = makeFile(45);
    const up = (await initiate(agent, buf).expect(201)).body.data.upload;
    await putParts(agent, up.id, buf, range(1, 5));
    await api(agent).post(`/api/uploads/${up.id}/complete`).expect(200);

    const again = await initiate(agent, buf).expect(200);
    assert.equal(again.body.data.upload.id, up.id);
    assert.equal(again.body.data.upload.status, 'completed');
    assert.ok(again.body.data.upload.publicUrl);
    assert.equal(ctx.fakeS3.stats.create, 1);
  });
});

describe('storage failures', () => {
  it('rides out transient storage errors (retried with backoff inside the SDK)', async () => {
    const { agent } = await signUp('transient@example.com');
    const buf = makeFile(45);
    const up = (await initiate(agent, buf).expect(201)).body.data.upload;
    await putParts(agent, up.id, buf, [1, 2]);

    ctx.fakeS3.failNext('list', 2, 503);
    const res = await api(agent).get(`/api/uploads/${up.id}`).expect(200);
    assert.deepEqual(res.body.data.upload.completedParts, [1, 2]);
    assert.equal(ctx.fakeS3.stats.list, 3, 'two failures + one success');
  });

  it('reports a persistent outage as 502 and leaves the upload intact and resumable', async () => {
    const { agent } = await signUp('outage@example.com');
    const buf = makeFile(45);
    const up = (await initiate(agent, buf).expect(201)).body.data.upload;
    await putParts(agent, up.id, buf, range(1, 5));

    ctx.fakeS3.failNext('list', Infinity, 500);
    const res = await api(agent).post(`/api/uploads/${up.id}/complete`);
    assert.equal(res.status, 502);
    assert.equal(res.body.data.reason, 'storage_unavailable');
    assert.equal((await dbRow(up.id)).status, 'uploading', 'claim released after the failure');

    ctx.fakeS3.clearFaults();
    await api(agent).post(`/api/uploads/${up.id}/complete`).expect(200);
    assert.equal(md5(ctx.fakeS3.objects.get((await dbRow(up.id)).object_key).data), md5(buf));
  });

  it('if assembling fails in storage, nothing is marked completed and a retry works', async () => {
    const { agent } = await signUp('assemblefail@example.com');
    const buf = makeFile(45);
    const up = (await initiate(agent, buf).expect(201)).body.data.upload;
    await putParts(agent, up.id, buf, range(1, 5));

    ctx.fakeS3.failNext('complete', Infinity, 500);
    await api(agent).post(`/api/uploads/${up.id}/complete`).expect(502);
    const row = await dbRow(up.id);
    assert.equal(row.status, 'uploading');
    assert.equal(row.completed_at, null);
    assert.equal(ctx.fakeS3.objects.size, 0);

    ctx.fakeS3.clearFaults();
    await api(agent).post(`/api/uploads/${up.id}/complete`).expect(200);
  });
});

describe('cancel, expiry and isolation', () => {
  it('abort removes the storage upload, is idempotent, and stops further uploads', async () => {
    const { agent } = await signUp('abort@example.com');
    const buf = makeFile(45);
    const up = (await initiate(agent, buf).expect(201)).body.data.upload;
    await putParts(agent, up.id, buf, [1, 2]);

    const res = await api(agent).post(`/api/uploads/${up.id}/abort`).expect(200);
    assert.equal(res.body.data.upload.status, 'aborted');
    assert.equal(ctx.fakeS3.multiparts.size, 0, 'uploaded parts were freed in storage');
    await api(agent).post(`/api/uploads/${up.id}/abort`).expect(200);
    assert.equal(ctx.fakeS3.stats.abort, 1);
    await api(agent).post(`/api/uploads/${up.id}/complete`).expect(409);

    // the same file can be started again from scratch
    const fresh = await initiate(agent, buf).expect(201);
    assert.notEqual(fresh.body.data.upload.id, up.id);
  });

  it('a completed upload cannot be cancelled', async () => {
    const { agent } = await signUp('nocancel@example.com');
    const buf = makeFile(25);
    const up = (await initiate(agent, buf).expect(201)).body.data.upload;
    await putParts(agent, up.id, buf, range(1, 3));
    await api(agent).post(`/api/uploads/${up.id}/complete`).expect(200);
    const res = await api(agent).post(`/api/uploads/${up.id}/abort`).expect(409);
    assert.equal(res.body.data.reason, 'already_completed');
  });

  it('a failed storage abort keeps the upload retryable instead of pretending it was cancelled', async () => {
    const { agent } = await signUp('abortfail@example.com');
    const up = (await initiate(agent, makeFile(25)).expect(201)).body.data.upload;
    ctx.fakeS3.failNext('abort', Infinity, 500);
    await api(agent).post(`/api/uploads/${up.id}/abort`).expect(502);
    assert.equal((await dbRow(up.id)).status, 'uploading');
    ctx.fakeS3.clearFaults();
    await api(agent).post(`/api/uploads/${up.id}/abort`).expect(200);
  });

  it('GET reports "expired" when storage no longer knows the upload', async () => {
    const { agent } = await signUp('vanish@example.com');
    const up = (await initiate(agent, makeFile(45)).expect(201)).body.data.upload;
    ctx.fakeS3.multiparts.clear();
    const res = await api(agent).get(`/api/uploads/${up.id}`).expect(200);
    assert.equal(res.body.data.upload.status, 'expired');
    assert.equal((await dbRow(up.id)).status, 'expired');
  });

  it('users cannot see or touch each other\'s uploads (404 everywhere)', async () => {
    const a = await signUp('owner@example.com');
    const b = await signUp('intruder@example.com');
    const buf = makeFile(45);
    const up = (await initiate(a.agent, buf).expect(201)).body.data.upload;
    await putParts(a.agent, up.id, buf, range(1, 5));

    await api(b.agent).get(`/api/uploads/${up.id}`).expect(404);
    await api(b.agent).post(`/api/uploads/${up.id}/parts/sign`, { partNumbers: [1] }).expect(404);
    await api(b.agent).post(`/api/uploads/${up.id}/complete`).expect(404);
    await api(b.agent).post(`/api/uploads/${up.id}/abort`).expect(404);
    const list = await api(b.agent).get('/api/uploads').expect(200);
    assert.deepEqual(list.body.data.uploads, []);
    assert.equal((await dbRow(up.id)).status, 'uploading', 'owner\'s upload untouched');
  });

  it('lists only the caller\'s uploads, newest first, with publicUrl only for finished ones', async () => {
    const { agent } = await signUp('list@example.com');
    const done = makeFile(25, 1);
    const u1 = (await initiate(agent, done, 1).expect(201)).body.data.upload;
    await putParts(agent, u1.id, done, range(1, 3));
    await api(agent).post(`/api/uploads/${u1.id}/complete`).expect(200);
    const u2 = (await initiate(agent, makeFile(25, 2), 2).expect(201)).body.data.upload;

    const res = await api(agent).get('/api/uploads').expect(200);
    const list = res.body.data.uploads;
    assert.deepEqual(list.map((u) => u.id), [u2.id, u1.id]);
    assert.equal(list[0].status, 'uploading');
    assert.equal(list[0].publicUrl, undefined);
    assert.equal(list[1].status, 'completed');
    assert.ok(list[1].publicUrl);
  });

  it('expireStaleUploads aborts abandoned sessions in storage and leaves active ones alone', async () => {
    const { agent } = await signUp('stale@example.com');
    const stale = (await initiate(agent, makeFile(25, 1), 1).expect(201)).body.data.upload;
    const fresh = (await initiate(agent, makeFile(25, 2), 2).expect(201)).body.data.upload;
    await backdate(stale.id, '3 days');

    const uploadService = require('../src/services/uploadService');
    assert.equal(await uploadService.expireStaleUploads(), 1);
    assert.equal((await dbRow(stale.id)).status, 'expired');
    assert.equal((await dbRow(fresh.id)).status, 'uploading');
    assert.equal(ctx.fakeS3.multiparts.size, 1, 'only the active upload remains in storage');
    assert.equal(await uploadService.expireStaleUploads(), 0);
  });
});
