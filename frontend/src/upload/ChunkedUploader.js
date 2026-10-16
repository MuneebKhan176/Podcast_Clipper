import * as defaultApi from '../api/uploadApi.js';
import { ApiError } from '../api/httpClient.js';
import { computeFingerprint } from './fingerprint.js';
import { putPart as defaultPutPart } from './putPart.js';

export const UploadState = Object.freeze({
  IDLE: 'idle',
  PREPARING: 'preparing', // asking the server for a session / the resume checkpoint
  UPLOADING: 'uploading',
  PAUSED: 'paused',
  COMPLETING: 'completing', // all parts sent; server verifies and assembles the file
  COMPLETED: 'completed',
  ERROR: 'error', // gave up after retries; call start() to resume from the checkpoint
  CANCELLED: 'cancelled',
});

const ACTIVE = new Set([UploadState.PREPARING, UploadState.UPLOADING, UploadState.COMPLETING]);

export class UploadFailedError extends Error {
  constructor(message, { fatal = false, cause } = {}) {
    super(message);
    this.name = 'UploadFailedError';
    this.fatal = fatal;
    this.cause = cause;
  }
}

/** Thrown internally to unwind a run that was paused/cancelled. Never shown to the user. */
class StopSignal extends Error {
  constructor() {
    super('stopped');
    this.name = 'StopSignal';
  }
}

const defaultSleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });

/** While the browser reports "offline", wait for the `online` event instead of burning retry attempts. */
function defaultWaitForOnline(signal) {
  if (typeof navigator === 'undefined' || navigator.onLine !== false) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { window.removeEventListener('online', done); resolve(); };
    window.addEventListener('online', done, { once: true });
    signal?.addEventListener('abort', done, { once: true });
  });
}

const isTransientStatus = (status) => status === undefined || status === 0 || status === 408 || status === 429 || status >= 500;

/**
 * Resumable, chunked upload of one File straight to cloud storage.
 *
 *  - The server decides the part size. Parts are sent in parallel (default 3) with presigned URLs.
 *  - The CHECKPOINT lives on the server: it asks cloud storage which parts it really holds. After a crash,
 *    reload, or "Resume" click, start() fetches that list and uploads ONLY the missing parts.
 *  - Every network step is retried with exponential backoff + jitter; offline periods are waited out.
 *  - Re-sending a part is harmless (same bytes overwrite the same part), so retries are always safe.
 *  - Before assembling, the server re-verifies every part; parts it reports missing/damaged are re-sent.
 */
export class ChunkedUploader {
  constructor(file, options = {}) {
    this.file = file;
    this.api = options.api ?? defaultApi;
    this.putPart = options.putPart ?? defaultPutPart;
    this.concurrency = options.concurrency ?? 3;
    this.maxAttempts = options.maxAttempts ?? 6;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 30000;
    this.signBatchSize = options.signBatchSize ?? 6;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.waitForOnline = options.waitForOnline ?? defaultWaitForOnline;
    this.fingerprintFn = options.computeFingerprint ?? computeFingerprint;
    this.onChange = options.onChange ?? (() => {});

    this.state = UploadState.IDLE;
    this.error = null;
    this.notice = '';
    this.session = null;
    this.result = null;
    this.resumedBytes = 0;

    this.completedParts = new Set();
    this.inflight = new Map(); // partNumber -> bytes sent so far in the current attempt
    this.urls = new Map(); // partNumber -> { url, expiresAt }
    this.signing = new Map(); // partNumber -> in-flight sign request
    this.controller = null;
    this.runId = 0;
    this.promise = null;
  }

  // ---------------------------------------------------------------- public API

  /** Starts, or resumes from the server-side checkpoint. Resolves (never rejects) when the run ends. */
  start() {
    if (ACTIVE.has(this.state)) return this.promise;
    if (this.state === UploadState.COMPLETED) return Promise.resolve(this.snapshot());

    const runId = ++this.runId;
    this.controller = new AbortController();
    const { signal } = this.controller;
    this.error = null;
    this.notice = '';
    this.urls.clear();
    this.signing.clear();
    this.inflight.clear();
    this._setState(UploadState.PREPARING);

    this.promise = this._run(signal).then(
      () => this.snapshot(),
      (err) => {
        if (runId !== this.runId) return this.snapshot(); // superseded by pause/cancel/new run
        if (err instanceof StopSignal || err?.name === 'AbortError') return this.snapshot();
        this.error = err?.message || 'Upload failed';
        this.notice = '';
        this._setState(UploadState.ERROR);
        return this.snapshot();
      }
    );
    return this.promise;
  }

  /** Stops sending. Parts already stored stay stored; start() later continues from them. */
  pause() {
    if (this.state !== UploadState.PREPARING && this.state !== UploadState.UPLOADING) return;
    this.runId += 1;
    this.controller.abort();
    this.inflight.clear();
    this.notice = '';
    this._setState(UploadState.PAUSED);
  }

  /** Stops and tells the server to discard the upload (frees the stored parts). */
  async cancel() {
    if (this.state === UploadState.COMPLETED || this.state === UploadState.CANCELLED) return;
    this.runId += 1;
    this.controller?.abort();
    this.inflight.clear();
    this.notice = '';
    const session = this.session;
    this._setState(UploadState.CANCELLED);
    if (session) {
      try {
        await this.api.abort(session.id);
      } catch {
        // Best effort: the server also expires abandoned sessions on its own.
      }
    }
  }

  snapshot() {
    const totalBytes = this.file.size;
    const uploadedBytes = this._uploadedBytes();
    return {
      state: this.state,
      uploadedBytes,
      totalBytes,
      percent: totalBytes ? Math.min(100, Math.floor((uploadedBytes / totalBytes) * 100)) : 0,
      completedParts: this.completedParts.size,
      totalParts: this.session?.totalParts ?? 0,
      resumedBytes: this.resumedBytes,
      notice: this.notice,
      error: this.error,
      upload: this.result,
    };
  }

  // ---------------------------------------------------------------- run

  async _run(signal) {
    const fingerprint = await this.fingerprintFn(this.file);
    this._throwIfStopped(signal);

    const { upload } = await this._withRetry(
      () => this.api.initiate({
        filename: this.file.name,
        size: this.file.size,
        contentType: this.file.type || '',
        fingerprint,
      }, signal),
      signal
    );
    this._throwIfStopped(signal);
    this.session = upload;

    if (upload.status === 'completed') {
      this.completedParts = new Set(this._allParts());
      this.result = upload;
      this.notice = '';
      this._setState(UploadState.COMPLETED);
      return;
    }

    // The checkpoint: exactly the parts the server confirmed are stored.
    this.completedParts = new Set(upload.completedParts ?? []);
    this.resumedBytes = this._completedBytes();
    this._setState(UploadState.UPLOADING);

    for (let round = 0; round < 3; round++) {
      const pending = this._pendingParts();
      if (pending.length) await this._uploadParts(pending, signal);

      this._setState(UploadState.COMPLETING);
      const outcome = await this._complete(signal);
      if (outcome.done) {
        this.completedParts = new Set(this._allParts());
        this.result = outcome.upload;
        this.notice = '';
        this._setState(UploadState.COMPLETED);
        return;
      }
      // The server found parts missing or damaged: forget them and send them again.
      for (const n of outcome.missingParts) {
        this.completedParts.delete(n);
        this.urls.delete(n);
      }
      this._setState(UploadState.UPLOADING);
    }
    throw new UploadFailedError('The upload could not be finalized. Please try again.');
  }

  async _uploadParts(pending, signal) {
    const queue = [...pending];
    const inner = new AbortController(); // lets one fatal failure stop its sibling workers
    const forward = () => inner.abort();
    signal.addEventListener('abort', forward, { once: true });
    let firstError = null;

    const worker = async () => {
      while (!inner.signal.aborted) {
        const partNumber = queue.shift();
        if (partNumber === undefined) return;
        try {
          await this._uploadPart(partNumber, inner.signal);
        } catch (err) {
          firstError ??= err;
          inner.abort();
          return;
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(this.concurrency, queue.length) }, worker));
    signal.removeEventListener('abort', forward);
    if (signal.aborted) throw new StopSignal();
    if (firstError) throw firstError;
  }

  async _uploadPart(partNumber, signal) {
    const blob = this._blobFor(partNumber);
    let lastError;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      this._throwIfStopped(signal);
      await this.waitForOnline(signal);
      this._throwIfStopped(signal);

      const url = await this._urlFor(partNumber, signal);
      this.inflight.set(partNumber, 0);
      try {
        await this.putPart(url, blob, {
          signal,
          onProgress: (loaded) => {
            this.inflight.set(partNumber, Math.min(loaded, blob.size));
            this._emit();
          },
        });
        this.inflight.delete(partNumber);
        this.completedParts.add(partNumber);
        this.notice = '';
        this._emit();
        return;
      } catch (err) {
        this.inflight.delete(partNumber);
        if (signal.aborted || err?.name === 'AbortError') throw new StopSignal();
        lastError = err;

        if (err?.status === 403) {
          // Most likely the presigned URL expired: get a fresh one and retry right away.
          this.urls.delete(partNumber);
        } else if (!isTransientStatus(err?.status)) {
          throw new UploadFailedError(
            `Storage rejected part ${partNumber} (HTTP ${err.status}). Please start the upload again.`,
            { fatal: true, cause: err }
          );
        }
        if (attempt === this.maxAttempts) break;

        if (err?.status !== 403) {
          const delay = this._backoff(attempt);
          this.notice = `Connection problem on part ${partNumber} (attempt ${attempt} of ${this.maxAttempts}). Retrying in ${Math.ceil(delay / 1000)}s…`;
          this._emit();
          await this.sleep(delay, signal);
        }
      }
    }
    throw new UploadFailedError(
      `Part ${partNumber} could not be uploaded after ${this.maxAttempts} attempts. Check your connection, then resume — finished parts will not be sent again.`,
      { cause: lastError }
    );
  }

  /** Presigned URLs are requested in small batches; one request serves several workers. */
  async _urlFor(partNumber, signal) {
    const fresh = (n) => {
      const entry = this.urls.get(n);
      return entry && entry.expiresAt - this.now() > 60000 ? entry.url : null;
    };
    let url = fresh(partNumber);
    if (url) return url;

    let pending = this.signing.get(partNumber);
    if (!pending) {
      const batch = [partNumber];
      for (const n of this._pendingParts()) {
        if (batch.length >= this.signBatchSize) break;
        if (n !== partNumber && !fresh(n) && !this.signing.has(n) && !this.completedParts.has(n)) batch.push(n);
      }
      pending = this._withRetry(() => this.api.signParts(this.session.id, batch, signal), signal)
        .then(({ parts, expiresAt }) => {
          for (const p of parts) this.urls.set(p.partNumber, { url: p.url, expiresAt: Date.parse(expiresAt) });
        })
        .finally(() => { for (const n of batch) this.signing.delete(n); });
      for (const n of batch) this.signing.set(n, pending);
    }
    await pending;
    // A URL that was JUST issued is used as-is; the 60 s safety margin only applies when reusing a cached one.
    const issued = this.urls.get(partNumber);
    if (!issued) throw new UploadFailedError('The server did not return an upload URL.', { fatal: true });
    return issued.url;
  }

  async _complete(signal) {
    for (let i = 1; i <= this.maxAttempts; i++) {
      try {
        const upload = await this._withRetry(() => this.api.complete(this.session.id, signal), signal);
        return { done: true, upload };
      } catch (err) {
        const cause = err instanceof UploadFailedError ? err.cause : err;
        if (cause instanceof ApiError && cause.status === 409) {
          const reason = cause.data?.reason;
          if (reason === 'incomplete') return { done: false, missingParts: cause.data.missingParts ?? [] };
          if (reason === 'in_progress') {
            // Another request (e.g. a retry of ours) is finalizing; give it a moment, then ask again.
            await this.sleep(this._backoff(i), signal);
            this._throwIfStopped(signal);
            continue;
          }
        }
        throw err;
      }
    }
    throw new UploadFailedError('The server is taking too long to finalize the upload. Please try again.');
  }

  /** Retries a server call on network errors / 5xx / 429 with backoff. Other 4xx are final. */
  async _withRetry(fn, signal) {
    let lastError;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      this._throwIfStopped(signal);
      await this.waitForOnline(signal);
      this._throwIfStopped(signal);
      try {
        return await fn();
      } catch (err) {
        if (signal.aborted || err?.name === 'AbortError') throw new StopSignal();
        if (!(err instanceof ApiError)) throw err;
        // A 429 that carries a `reason` (e.g. too_many_active_uploads) is a rule, not throttling: don't retry it.
        const transient = err.status === 429 ? !err.data?.reason : isTransientStatus(err.status);
        if (!transient) {
          throw err.status === 409 ? new UploadFailedError(err.message, { cause: err }) : new UploadFailedError(err.message, { fatal: true, cause: err });
        }
        lastError = err;
        if (attempt === this.maxAttempts) break;
        const delay = this._backoff(attempt);
        this.notice = `Can't reach the server. Retrying in ${Math.ceil(delay / 1000)}s…`;
        this._emit();
        await this.sleep(delay, signal);
      }
    }
    throw new UploadFailedError('Could not reach the server. Check your connection, then resume.', { cause: lastError });
  }

  // ---------------------------------------------------------------- helpers

  _backoff(attempt) {
    const exp = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1));
    return Math.round(exp * (0.5 + 0.5 * this.random())); // jitter: 50%-100% of the exponential delay
  }

  _throwIfStopped(signal) {
    if (signal.aborted) throw new StopSignal();
  }

  _allParts() {
    return Array.from({ length: this.session.totalParts }, (_, i) => i + 1);
  }

  _pendingParts() {
    return this._allParts().filter((n) => !this.completedParts.has(n));
  }

  _partLength(n) {
    const { sizeBytes, partSizeBytes, totalParts } = this.session;
    return n < totalParts ? partSizeBytes : sizeBytes - partSizeBytes * (totalParts - 1);
  }

  _blobFor(n) {
    const { partSizeBytes } = this.session;
    const start = (n - 1) * partSizeBytes;
    const blob = this.file.slice(start, start + this._partLength(n));
    if (blob.size !== this._partLength(n)) {
      throw new UploadFailedError('The selected file changed on disk while uploading. Please select it again.', { fatal: true });
    }
    return blob;
  }

  _completedBytes() {
    let sum = 0;
    for (const n of this.completedParts) sum += this._partLength(n);
    return sum;
  }

  _uploadedBytes() {
    if (!this.session) return 0;
    let sum = this._completedBytes();
    for (const [n, loaded] of this.inflight) if (!this.completedParts.has(n)) sum += loaded;
    return Math.min(sum, this.file.size);
  }

  _setState(state) {
    this.state = state;
    this._emit();
  }

  _emit() {
    this.onChange(this.snapshot());
  }
}
