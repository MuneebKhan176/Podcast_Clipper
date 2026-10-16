// Sends ONE part directly to cloud storage with a presigned URL.
// XMLHttpRequest is used (not fetch) because only XHR reports upload progress.
// No headers are set: the URL's signature already authorizes the request, and extra headers could break it.

export class PartUploadError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'PartUploadError';
    this.status = status; // HTTP status, or undefined for network failures / stalls
  }
}

/**
 * Resolves when storage answers 2xx. Rejects with PartUploadError (network error, stall, non-2xx)
 * or an AbortError when `signal` fires.
 *
 * stallTimeoutMs: abort an attempt if NO bytes move for this long. This is deliberately not a total-time
 * limit: a 16 MiB part on a slow link may legitimately take minutes, but a connection that went silent
 * (wifi dropped, laptop slept) must be detected and retried.
 */
export function putPart(url, blob, { signal, onProgress, stallTimeoutMs = 30000, xhrFactory = () => new XMLHttpRequest() } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const xhr = xhrFactory();
    let settled = false;
    let stallTimer;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const armStallTimer = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        finish(reject, new PartUploadError('Upload stalled (no data sent)'));
        xhr.abort();
      }, stallTimeoutMs);
    };
    function onAbort() {
      finish(reject, new DOMException('Aborted', 'AbortError'));
      xhr.abort();
    }

    xhr.open('PUT', url);
    xhr.upload.onprogress = (event) => {
      armStallTimer();
      onProgress?.(event.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(blob.size);
        finish(resolve, { etag: xhr.getResponseHeader?.('ETag') ?? null });
      } else {
        finish(reject, new PartUploadError(`Storage responded with HTTP ${xhr.status}`, { status: xhr.status }));
      }
    };
    xhr.onerror = () => finish(reject, new PartUploadError('Network error while uploading'));
    xhr.ontimeout = () => finish(reject, new PartUploadError('Network timeout while uploading'));
    xhr.onabort = () => finish(reject, new PartUploadError('Upload aborted'));

    signal?.addEventListener('abort', onAbort, { once: true });
    armStallTimer();
    xhr.send(blob);
  });
}
