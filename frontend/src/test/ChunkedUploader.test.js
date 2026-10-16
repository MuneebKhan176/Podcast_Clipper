import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api/httpClient.js';
import { ChunkedUploader, UploadState } from '../upload/ChunkedUploader.js';
import { computeFingerprint } from '../upload/fingerprint.js';

// ---- A fake of the backend + cloud storage ------------------------------------------------------
// `stored` plays the role of "parts the storage service holds": it is the resume checkpoint.
function createWorld({ size = 45, partSize = 10, stored = [], status = 'uploading' } = {}) {
  const totalParts = Math.ceil(size / partSize);
  const world = {
    size, partSize, totalParts,
    stored: new Set(stored),
    puts: [], // every part upload attempt that reached "storage": { n, bytes }
    signCalls: [],
    initiateCalls: [],
    completeCalls: 0,
    abortCalls: 0,
    sleeps: [],
    active: 0,
    peakActive: 0,
    putFailures: {}, // partNumber -> array of errors thrown on successive attempts
    completeScript: [], // optional queue of errors for complete()
    initiateFailures: [],
    signFailures: [],
    gate: null, // optional (n, signal) => Promise to hold a PUT open
    expiresInMs: 900_000,
    status,
  };

  world.api = {
    initiate: async (body) => {
      world.initiateCalls.push(body);
      if (world.initiateFailures.length) throw world.initiateFailures.shift();
      return {
        upload: {
          id: 'up-1', status: world.status, sizeBytes: size, partSizeBytes: partSize, totalParts,
          completedParts: [...world.stored].sort((a, b) => a - b),
        },
        resumed: world.stored.size > 0,
      };
    },
    signParts: async (id, parts) => {
      world.signCalls.push(parts);
      if (world.signFailures.length) throw world.signFailures.shift();
      return {
        parts: parts.map((n) => ({ partNumber: n, url: `https://storage.test/${n}` })),
        expiresAt: new Date(Date.now() + world.expiresInMs).toISOString(),
        expiresInSeconds: world.expiresInMs / 1000,
      };
    },
    complete: async () => {
      world.completeCalls++;
      if (world.completeScript.length) throw world.completeScript.shift();
      const missing = [];
      for (let n = 1; n <= totalParts; n++) if (!world.stored.has(n)) missing.push(n);
      if (missing.length) throw new ApiError(409, 'Upload is incomplete', { reason: 'incomplete', missingParts: missing });
      world.status = 'completed';
      return { id: 'up-1', status: 'completed', publicUrl: 'https://pub.test/video.mp4' };
    },
    abort: async () => { world.abortCalls++; },
  };

  world.putPart = async (url, blob, { signal, onProgress }) => {
    const n = Number(url.split('/').pop());
    world.active++;
    world.peakActive = Math.max(world.peakActive, world.active);
    try {
      if (world.gate) await world.gate(n, signal);
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const failure = world.putFailures[n]?.shift();
      if (failure) throw failure;
      onProgress?.(Math.floor(blob.size / 2));
      world.puts.push({ n, bytes: blob.size });
      world.stored.add(n);
      onProgress?.(blob.size);
    } finally {
      world.active--;
    }
  };

  world.sleep = async (ms) => { world.sleeps.push(ms); };
  return world;
}

const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { name: 'PartUploadError', status });
const networkError = () => Object.assign(new Error('Network error'), { name: 'PartUploadError' }); // no status

function makeFile(size, name = 'talk.mp4') {
  return new File([new Uint8Array(size)], name, { type: 'video/mp4', lastModified: 1_700_000_000_000 });
}

function makeUploader(world, extra = {}, file = makeFile(world.size)) {
  const states = [];
  const uploader = new ChunkedUploader(file, {
    api: world.api,
    putPart: world.putPart,
    sleep: world.sleep,
    random: () => 1, // no jitter: delay = full exponential value
    waitForOnline: async () => {},
    baseDelayMs: 100,
    maxDelayMs: 10_000,
    maxAttempts: 4,
    concurrency: 3,
    onChange: (s) => { if (states.at(-1) !== s.state) states.push(s.state); },
    ...extra,
  });
  return { uploader, states };
}

const putsFor = (world, n) => world.puts.filter((p) => p.n === n).length;

// ------------------------------------------------------------------------------------------------
describe('happy path', () => {
  it('uploads every part with the right sizes, then completes once', async () => {
    const world = createWorld({ size: 45, partSize: 10 });
    const { uploader, states } = makeUploader(world);
    const result = await uploader.start();

    expect(result.state).toBe(UploadState.COMPLETED);
    expect(result.percent).toBe(100);
    expect(result.uploadedBytes).toBe(45);
    expect(result.upload.publicUrl).toBe('https://pub.test/video.mp4');
    expect(world.puts.map((p) => p.n).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(world.puts.find((p) => p.n === 5).bytes).toBe(5); // short last part
    expect(world.puts.reduce((s, p) => s + p.bytes, 0)).toBe(45);
    expect(world.completeCalls).toBe(1);
    expect(world.initiateCalls).toHaveLength(1);
    expect(states).toEqual([UploadState.PREPARING, UploadState.UPLOADING, UploadState.COMPLETING, UploadState.COMPLETED]);
  });

  it('sends the file identity the server needs for idempotent initiate', async () => {
    const world = createWorld({ size: 45 });
    await makeUploader(world).uploader.start();
    const body = world.initiateCalls[0];
    expect(body).toMatchObject({ filename: 'talk.mp4', size: 45, contentType: 'video/mp4' });
    expect(body.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never has more than `concurrency` parts in flight, and does use the parallelism', async () => {
    const world = createWorld({ size: 100, partSize: 10 });
    world.gate = () => new Promise((r) => setTimeout(r, 5));
    const { uploader } = makeUploader(world, { concurrency: 3 });
    await uploader.start();
    expect(world.peakActive).toBe(3);
    expect(world.puts).toHaveLength(10);
  });

  it('asks for upload URLs in batches, not one request per part', async () => {
    const world = createWorld({ size: 100, partSize: 10 });
    await makeUploader(world, { signBatchSize: 4, concurrency: 1 }).uploader.start();
    expect(world.signCalls.length).toBeLessThanOrEqual(3);
    expect(world.signCalls.flat().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('reports monotonic progress that ends at exactly 100%', async () => {
    const world = createWorld({ size: 45 });
    const seen = [];
    const { uploader } = makeUploader(world, { concurrency: 1, onChange: (s) => seen.push(s.uploadedBytes) });
    await uploader.start();
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen.at(-1)).toBe(45);
  });
});

describe('resuming from the checkpoint', () => {
  it('uploads ONLY the parts the server says are missing', async () => {
    const world = createWorld({ size: 45, stored: [1, 2, 3] });
    const { uploader } = makeUploader(world);
    const result = await uploader.start();
    expect(result.state).toBe(UploadState.COMPLETED);
    expect(world.puts.map((p) => p.n).sort()).toEqual([4, 5]);
    expect(result.resumedBytes).toBe(30);
  });

  it('returns immediately when the file was already uploaded (no part is sent)', async () => {
    const world = createWorld({ size: 45, status: 'completed' });
    const result = await makeUploader(world).uploader.start();
    expect(result.state).toBe(UploadState.COMPLETED);
    expect(world.puts).toHaveLength(0);
    expect(world.completeCalls).toBe(0);
  });

  it('a brand-new uploader for the same file (page reload) continues where the old one stopped', async () => {
    const world = createWorld({ size: 45 });
    world.putFailures[4] = [networkError(), networkError(), networkError(), networkError()]; // part 4 always dies
    const first = makeUploader(world, { concurrency: 1 });
    expect((await first.uploader.start()).state).toBe(UploadState.ERROR);
    const sentBefore = world.puts.map((p) => p.n);
    expect(sentBefore).toEqual([1, 2, 3]);

    // "reload the page": brand-new uploader object, same file, same server-side checkpoint
    const second = makeUploader(world, { concurrency: 1 });
    const result = await second.uploader.start();
    expect(result.state).toBe(UploadState.COMPLETED);
    for (const n of [1, 2, 3]) expect(putsFor(world, n)).toBe(1); // never re-sent
    expect(world.puts.map((p) => p.n).slice(3)).toEqual([4, 5]);
  });
});

describe('network failures and retries', () => {
  it('retries a failing part with exponential backoff, then succeeds', async () => {
    const world = createWorld({ size: 45 });
    world.putFailures[2] = [httpError(503), networkError(), httpError(500)];
    const { uploader } = makeUploader(world, { maxAttempts: 6 });
    const result = await uploader.start();
    expect(result.state).toBe(UploadState.COMPLETED);
    expect(world.sleeps).toEqual([100, 200, 400]);
    expect(putsFor(world, 2)).toBe(1);
  });

  it('caps the backoff delay and applies jitter', async () => {
    const world = createWorld({ size: 10, partSize: 10 });
    world.putFailures[1] = Array.from({ length: 5 }, () => networkError());
    const { uploader } = makeUploader(world, { maxAttempts: 7, baseDelayMs: 1000, maxDelayMs: 3000, random: () => 0 });
    await uploader.start();
    // random()=0 -> 50% of min(cap, base*2^(n-1)): 500, 1000, 1500, 1500, 1500
    expect(world.sleeps).toEqual([500, 1000, 1500, 1500, 1500]);
  });

  it('gives up after maxAttempts with a helpful message, keeping finished parts', async () => {
    const world = createWorld({ size: 45 });
    world.putFailures[3] = Array.from({ length: 10 }, () => networkError());
    const { uploader } = makeUploader(world, { maxAttempts: 3, concurrency: 1 });
    const result = await uploader.start();
    expect(result.state).toBe(UploadState.ERROR);
    expect(result.error).toMatch(/Part 3 could not be uploaded after 3 attempts/);
    expect(result.error).toMatch(/will not be sent again/);
    expect(world.completeCalls).toBe(0);
    expect(uploader.completedParts.has(1) && uploader.completedParts.has(2)).toBe(true);
  });

  it('after an error, start() resumes and sends only what is left', async () => {
    const world = createWorld({ size: 45 });
    world.putFailures[3] = Array.from({ length: 10 }, () => networkError());
    const { uploader } = makeUploader(world, { maxAttempts: 3, concurrency: 1 });
    expect((await uploader.start()).state).toBe(UploadState.ERROR);

    world.putFailures[3] = []; // network is back
    const result = await uploader.start();
    expect(result.state).toBe(UploadState.COMPLETED);
    for (let n = 1; n <= 5; n++) expect(putsFor(world, n)).toBe(1); // every part stored exactly once
  });

  it('does not burn retry attempts while the browser is offline; continues when it is back', async () => {
    const world = createWorld({ size: 30 });
    let online = false;
    const waiting = [];
    const { uploader } = makeUploader(world, {
      waitForOnline: () => (online ? Promise.resolve() : new Promise((r) => waiting.push(r))),
    });
    const run = uploader.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(world.puts).toHaveLength(0);
    expect(world.initiateCalls).toHaveLength(0); // nothing is attempted while offline
    online = true;
    waiting.forEach((r) => r());
    const result = await run;
    expect(result.state).toBe(UploadState.COMPLETED);
    expect(world.sleeps).toEqual([]); // no backoff was consumed
  });

  it('retries the initial server call on transient errors', async () => {
    const world = createWorld({ size: 30 });
    world.initiateFailures = [new ApiError(0, 'Unable to reach the server'), new ApiError(503, 'down')];
    const result = await makeUploader(world).uploader.start();
    expect(result.state).toBe(UploadState.COMPLETED);
    expect(world.initiateCalls).toHaveLength(3);
    expect(world.sleeps).toEqual([100, 200]);
  });

  it('retries signing failures too', async () => {
    const world = createWorld({ size: 30 });
    world.signFailures = [new ApiError(502, 'storage down')];
    const result = await makeUploader(world, { concurrency: 1, signBatchSize: 1 }).uploader.start();
    expect(result.state).toBe(UploadState.COMPLETED);
    expect(world.sleeps.length).toBe(1);
  });

  it('refreshes an expired presigned URL (403) and retries immediately without backoff', async () => {
    const world = createWorld({ size: 30 });
    world.putFailures[1] = [httpError(403)];
    const result = await makeUploader(world, { concurrency: 1, signBatchSize: 1 }).uploader.start();
    expect(result.state).toBe(UploadState.COMPLETED);
    expect(world.signCalls.flat().filter((n) => n === 1)).toHaveLength(2); // signed twice
    expect(world.sleeps).toEqual([]);
  });

  it('re-signs URLs that are about to expire instead of using them', async () => {
    const world = createWorld({ size: 30, partSize: 10 });
    world.expiresInMs = 30_000; // inside the 60 s safety margin: every URL counts as stale
    const { uploader } = makeUploader(world, { concurrency: 1, signBatchSize: 1 });
    await uploader.start();
    expect(world.signCalls).toHaveLength(3); // one fresh URL per part, never reused after expiry
  });

  it('does not retry permanent storage rejections (4xx)', async () => {
    const world = createWorld({ size: 30 });
    world.putFailures[2] = [httpError(400), httpError(400)];
    const result = await makeUploader(world, { concurrency: 1 }).uploader.start();
    expect(result.state).toBe(UploadState.ERROR);
    expect(result.error).toMatch(/rejected part 2 \(HTTP 400\)/);
    expect(world.sleeps).toEqual([]);
  });

  it('fails clearly (no retry storm) on a rule violation like too many active uploads', async () => {
    const world = createWorld({ size: 30 });
    world.initiateFailures = [new ApiError(429, 'You already have 3 uploads in progress.', { reason: 'too_many_active_uploads' })];
    const result = await makeUploader(world).uploader.start();
    expect(result.state).toBe(UploadState.ERROR);
    expect(result.error).toMatch(/3 uploads in progress/);
    expect(world.initiateCalls).toHaveLength(1);
  });

  it('stops all workers promptly when one part fails fatally', async () => {
    const world = createWorld({ size: 100, partSize: 10 });
    world.putFailures[1] = [httpError(400)];
    world.gate = () => new Promise((r) => setTimeout(r, 5));
    const result = await makeUploader(world, { concurrency: 2 }).uploader.start();
    expect(result.state).toBe(UploadState.ERROR);
    expect(world.puts.length).toBeLessThan(10);
  });
});

describe('server-side verification', () => {
  it('re-sends parts the server reports missing or damaged, then completes', async () => {
    const world = createWorld({ size: 45 });
    // First complete(): the server found part 2 damaged and dropped it from its checkpoint.
    world.completeScript = [];
    const realComplete = world.api.complete;
    let first = true;
    world.api.complete = async (...args) => {
      if (first) {
        first = false;
        world.completeCalls++;
        world.stored.delete(2);
        throw new ApiError(409, 'Upload is incomplete', { reason: 'incomplete', missingParts: [2] });
      }
      return realComplete(...args);
    };
    const result = await makeUploader(world).uploader.start();
    expect(result.state).toBe(UploadState.COMPLETED);
    expect(putsFor(world, 2)).toBe(2); // the damaged part, and only that part, was sent again
    for (const n of [1, 3, 4, 5]) expect(putsFor(world, n)).toBe(1);
  });

  it('waits and asks again when another request is finalizing (409 in_progress)', async () => {
    const world = createWorld({ size: 30 });
    world.completeScript = [
      new ApiError(409, 'being finalized', { reason: 'in_progress' }),
      new ApiError(409, 'being finalized', { reason: 'in_progress' }),
    ];
    const result = await makeUploader(world).uploader.start();
    expect(result.state).toBe(UploadState.COMPLETED);
    expect(world.completeCalls).toBe(3);
    expect(world.sleeps).toEqual([100, 200]);
  });

  it('retries complete() when the server is briefly unavailable (502)', async () => {
    const world = createWorld({ size: 30 });
    world.completeScript = [new ApiError(502, 'storage down', { reason: 'storage_unavailable' })];
    const result = await makeUploader(world).uploader.start();
    expect(result.state).toBe(UploadState.COMPLETED);
    expect(world.completeCalls).toBe(2);
  });

  it('reports an error if the file on disk no longer matches the session', async () => {
    const world = createWorld({ size: 45 });
    const shrunk = makeFile(30); // server expects 45 bytes
    const result = await makeUploader(world, {}, shrunk).uploader.start();
    expect(result.state).toBe(UploadState.ERROR);
    expect(result.error).toMatch(/changed on disk/);
  });
});

describe('pause, resume and cancel', () => {
  it('pause stops sending; resume continues without re-sending finished parts', async () => {
    const world = createWorld({ size: 60, partSize: 10 });
    let release;
    const hold = new Promise((r) => { release = r; });
    world.gate = async (n, signal) => {
      if (n === 3) {
        await new Promise((resolve) => {
          signal?.addEventListener('abort', resolve, { once: true });
          hold.then(resolve);
        });
      }
    };
    const { uploader } = makeUploader(world, { concurrency: 1 });
    const run = uploader.start();
    await new Promise((r) => setTimeout(r, 20)); // parts 1,2 done; part 3 is held open
    expect(world.puts.map((p) => p.n)).toEqual([1, 2]);

    uploader.pause();
    expect(uploader.state).toBe(UploadState.PAUSED);
    await run;
    const sentWhilePaused = world.puts.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(world.puts).toHaveLength(sentWhilePaused); // nothing more is sent while paused

    world.gate = null;
    const result = await uploader.start();
    expect(result.state).toBe(UploadState.COMPLETED);
    expect(putsFor(world, 1)).toBe(1);
    expect(putsFor(world, 2)).toBe(1);
    release();
  });

  it('cancel stops uploading and tells the server to discard the upload', async () => {
    const world = createWorld({ size: 100, partSize: 10 });
    world.gate = (n, signal) => new Promise((resolve) => { setTimeout(resolve, 5); signal?.addEventListener('abort', resolve, { once: true }); });
    const { uploader } = makeUploader(world, { concurrency: 1 });
    const run = uploader.start();
    await new Promise((r) => setTimeout(r, 12));
    await uploader.cancel();
    expect(uploader.state).toBe(UploadState.CANCELLED);
    expect(world.abortCalls).toBe(1);
    await run;
    const count = world.puts.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(world.puts).toHaveLength(count);
    expect(world.completeCalls).toBe(0);
  });

  it('cancel still ends cleanly if the server cannot be reached', async () => {
    const world = createWorld({ size: 30 });
    world.api.abort = async () => { throw new ApiError(0, 'offline'); };
    const { uploader } = makeUploader(world);
    await uploader.start();
    await uploader.cancel();
    expect(uploader.state).toBe(UploadState.COMPLETED); // already finished: cancel is a no-op
  });

  it('calling start() twice does not start two uploads', async () => {
    const world = createWorld({ size: 45 });
    const { uploader } = makeUploader(world);
    const a = uploader.start();
    const b = uploader.start();
    expect(a).toBe(b);
    await a;
    expect(world.initiateCalls).toHaveLength(1);
    expect(world.puts).toHaveLength(5);
  });
});

describe('fingerprint', () => {
  it('is a stable 64-char hex string that changes with name, size or modified time', async () => {
    const f = (name, size, lastModified) => new File([new Uint8Array(size)], name, { lastModified });
    const base = await computeFingerprint(f('a.mp4', 10, 1000));
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(await computeFingerprint(f('a.mp4', 10, 1000))).toBe(base);
    expect(await computeFingerprint(f('b.mp4', 10, 1000))).not.toBe(base);
    expect(await computeFingerprint(f('a.mp4', 11, 1000))).not.toBe(base);
    expect(await computeFingerprint(f('a.mp4', 10, 1001))).not.toBe(base);
  });

  it('falls back to a deterministic hash where crypto.subtle is unavailable (plain http)', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
    try {
      const file = new File([new Uint8Array(5)], 'a.mp4', { lastModified: 5 });
      const a = await computeFingerprint(file);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
      expect(await computeFingerprint(file)).toBe(a);
    } finally {
      Object.defineProperty(globalThis, 'crypto', original);
    }
  });
});
