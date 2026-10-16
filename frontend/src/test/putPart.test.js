import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PartUploadError, putPart } from '../upload/putPart.js';

// Minimal XMLHttpRequest stand-in that the test drives by hand.
class FakeXHR {
  constructor() {
    this.upload = {};
    this.headers = {};
    this.aborted = false;
    this.status = 0;
  }
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(k, v) { this.headers[k] = v; }
  send(body) { this.body = body; }
  abort() { this.aborted = true; }
  getResponseHeader(name) { return name.toLowerCase() === 'etag' ? '"abc"' : null; }
  // helpers used by tests
  progress(loaded) { this.upload.onprogress?.({ loaded }); }
  respond(status) { this.status = status; this.onload?.(); }
}

let xhr;
const factory = () => (xhr = new FakeXHR());
const blob = new Blob([new Uint8Array(100)]);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('putPart', () => {
  it('PUTs the blob to the presigned URL without adding headers, and resolves with the ETag', async () => {
    const p = putPart('https://s3.test/x?sig=1', blob, { xhrFactory: factory });
    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toBe('https://s3.test/x?sig=1');
    expect(xhr.body).toBe(blob);
    expect(xhr.headers).toEqual({}); // headers could invalidate the signature
    xhr.respond(200);
    await expect(p).resolves.toEqual({ etag: '"abc"' });
  });

  it('reports upload progress, ending at the full size', async () => {
    const seen = [];
    const p = putPart('u', blob, { xhrFactory: factory, onProgress: (n) => seen.push(n) });
    xhr.progress(30);
    xhr.progress(70);
    xhr.respond(200);
    await p;
    expect(seen).toEqual([30, 70, 100]);
  });

  it('rejects with the HTTP status on a non-2xx answer (callers decide whether to retry)', async () => {
    const p = putPart('u', blob, { xhrFactory: factory });
    xhr.respond(503);
    await expect(p).rejects.toMatchObject({ name: 'PartUploadError', status: 503 });
  });

  it('rejects without a status on a network error', async () => {
    const p = putPart('u', blob, { xhrFactory: factory });
    xhr.onerror();
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(PartUploadError);
    expect(err.status).toBeUndefined();
  });

  it('aborts and rejects when no bytes move for stallTimeoutMs (dead connection)', async () => {
    const p = putPart('u', blob, { xhrFactory: factory, stallTimeoutMs: 5000 });
    const caught = p.catch((e) => e);
    vi.advanceTimersByTime(4999);
    expect(xhr.aborted).toBe(false);
    vi.advanceTimersByTime(2);
    const err = await caught;
    expect(err.message).toMatch(/stalled/i);
    expect(xhr.aborted).toBe(true);
  });

  it('does NOT time out a slow-but-moving upload (the stall timer resets on progress)', async () => {
    const p = putPart('u', blob, { xhrFactory: factory, stallTimeoutMs: 5000 });
    for (let i = 1; i <= 10; i++) {
      vi.advanceTimersByTime(4000); // 40 s in total, but data keeps flowing
      xhr.progress(i * 10);
    }
    expect(xhr.aborted).toBe(false);
    xhr.respond(200);
    await expect(p).resolves.toBeDefined();
  });

  it('aborts the request and rejects with AbortError when the signal fires', async () => {
    const controller = new AbortController();
    const p = putPart('u', blob, { xhrFactory: factory, signal: controller.signal });
    const caught = p.catch((e) => e);
    controller.abort();
    const err = await caught;
    expect(err.name).toBe('AbortError');
    expect(xhr.aborted).toBe(true);
  });

  it('rejects immediately when already aborted, without touching the network', async () => {
    const controller = new AbortController();
    controller.abort();
    let created = false;
    const p = putPart('u', blob, { xhrFactory: () => { created = true; return new FakeXHR(); }, signal: controller.signal });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(created).toBe(false);
  });

  it('settles only once even if several events fire', async () => {
    const p = putPart('u', blob, { xhrFactory: factory });
    xhr.respond(200);
    xhr.onerror();
    xhr.respond(500);
    await expect(p).resolves.toBeDefined();
  });
});
