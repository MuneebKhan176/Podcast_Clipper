'use strict';

// A small in-memory, S3-compatible server (path-style) that implements the multipart-upload calls the
// backend uses. It lets the tests run the REAL AWS SDK code (including presigned URLs) with no network,
// and inject failures to prove the system stays consistent.
const http = require('http');
const crypto = require('crypto');

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');
const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xmlUnescape = (s) => String(s).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

class FakeS3 {
  constructor({ bucket = 'test-bucket' } = {}) {
    this.bucket = bucket;
    this.multiparts = new Map(); // uploadId -> { key, parts: Map(partNumber -> { etag, data }) }
    this.objects = new Map(); // key -> { data, etag }
    this.stats = this.freshStats();
    this.faults = []; // { op, remaining, status }
  }

  freshStats() {
    return { create: 0, putPart: 0, list: 0, complete: 0, abort: 0, head: 0 };
  }

  resetStats() {
    this.stats = this.freshStats();
  }

  reset() {
    this.multiparts.clear();
    this.objects.clear();
    this.faults = [];
    this.resetStats();
  }

  /** Make the next `count` calls of `op` fail with an HTTP status (Infinity = until clearFaults). */
  failNext(op, count = 1, status = 503) {
    this.faults.push({ op, remaining: count, status });
  }
  clearFaults() {
    this.faults = [];
  }

  activeUploadIds() {
    return [...this.multiparts.keys()];
  }

  /** Simulates storage finishing the upload (as if a "complete" succeeded but its reply was lost). */
  finishBehindTheScenes(uploadId) {
    const mp = this.multiparts.get(uploadId);
    const ordered = [...mp.parts.entries()].sort((a, b) => a[0] - b[0]);
    const data = Buffer.concat(ordered.map(([, p]) => p.data));
    this.objects.set(mp.key, { data, etag: `"${md5(data)}-${ordered.length}"` });
    this.multiparts.delete(uploadId);
  }

  start() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        this.endpoint = `http://127.0.0.1:${this.server.address().port}`;
        resolve(this);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      this.server.closeAllConnections?.();
      this.server.close(() => resolve());
    });
  }

  consumeFault(op) {
    const fault = this.faults.find((f) => f.op === op && f.remaining > 0);
    if (!fault) return null;
    fault.remaining -= 1;
    return fault.status;
  }

  send(res, status, body = '', headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/xml', 'Content-Length': Buffer.byteLength(body), ...headers });
    res.end(body);
  }

  error(res, status, code, message) {
    this.send(res, status, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message></Error>`);
  }

  async handle(req, res) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);

    const url = new URL(req.url, 'http://fake');
    const [, bucket, ...rest] = decodeURIComponent(url.pathname).split('/');
    const key = rest.join('/');
    const q = url.searchParams;
    const uploadId = q.get('uploadId');

    if (bucket !== this.bucket) return this.error(res, 404, 'NoSuchBucket', 'bucket');

    // ---- CreateMultipartUpload
    if (req.method === 'POST' && q.has('uploads')) {
      this.stats.create++;
      const f = this.consumeFault('create');
      if (f) return this.error(res, f, 'ServiceUnavailable', 'injected');
      const id = `mpu-${crypto.randomBytes(8).toString('hex')}`;
      this.multiparts.set(id, { key, parts: new Map() });
      return this.send(res, 200, `<?xml version="1.0"?><InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
    }

    // ---- UploadPart (browser PUT to a presigned URL)
    if (req.method === 'PUT' && q.has('partNumber')) {
      this.stats.putPart++;
      const f = this.consumeFault('putPart');
      if (f) return this.error(res, f, 'ServiceUnavailable', 'injected');
      const mp = this.multiparts.get(uploadId);
      if (!mp) return this.error(res, 404, 'NoSuchUpload', 'The specified upload does not exist.');
      const n = Number(q.get('partNumber'));
      const etag = `"${md5(body)}"`;
      mp.parts.set(n, { etag, data: body });
      return this.send(res, 200, '', { ETag: etag });
    }

    // ---- ListParts
    if (req.method === 'GET' && uploadId) {
      this.stats.list++;
      const f = this.consumeFault('list');
      if (f) return this.error(res, f, 'ServiceUnavailable', 'injected');
      const mp = this.multiparts.get(uploadId);
      if (!mp) return this.error(res, 404, 'NoSuchUpload', 'The specified upload does not exist.');
      const marker = Number(q.get('part-number-marker') || 0);
      const max = Number(q.get('max-parts') || 1000);
      const all = [...mp.parts.entries()].sort((a, b) => a[0] - b[0]).filter(([n]) => n > marker);
      const page = all.slice(0, max);
      const truncated = all.length > page.length;
      const next = page.length ? page[page.length - 1][0] : marker;
      const partsXml = page
        .map(([n, p]) => `<Part><PartNumber>${n}</PartNumber><LastModified>${new Date().toISOString()}</LastModified><ETag>${xmlEscape(p.etag)}</ETag><Size>${p.data.length}</Size></Part>`)
        .join('');
      return this.send(res, 200, `<?xml version="1.0"?><ListPartsResult><Bucket>${bucket}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${uploadId}</UploadId><PartNumberMarker>${marker}</PartNumberMarker><NextPartNumberMarker>${next}</NextPartNumberMarker><MaxParts>${max}</MaxParts><IsTruncated>${truncated}</IsTruncated>${partsXml}</ListPartsResult>`);
    }

    // ---- CompleteMultipartUpload
    if (req.method === 'POST' && uploadId) {
      this.stats.complete++;
      const f = this.consumeFault('complete');
      if (f) return this.error(res, f, 'ServiceUnavailable', 'injected');
      const mp = this.multiparts.get(uploadId);
      if (!mp) return this.error(res, 404, 'NoSuchUpload', 'The specified upload does not exist.');
      const xml = body.toString('utf8');
      const requested = [...xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)].map((m) => ({
        n: Number(/<PartNumber>(\d+)<\/PartNumber>/.exec(m[1])[1]),
        etag: xmlUnescape(/<ETag>([\s\S]*?)<\/ETag>/.exec(m[1])[1]),
      }));
      for (let i = 0; i < requested.length; i++) {
        const stored = mp.parts.get(requested[i].n);
        if (!stored || stored.etag !== requested[i].etag) return this.error(res, 400, 'InvalidPart', `part ${requested[i].n}`);
        if (i > 0 && requested[i].n <= requested[i - 1].n) return this.error(res, 400, 'InvalidPartOrder', 'order');
      }
      const data = Buffer.concat(requested.map((r) => mp.parts.get(r.n).data));
      const etag = `"${md5(data)}-${requested.length}"`;
      this.objects.set(mp.key, { data, etag });
      this.multiparts.delete(uploadId);
      return this.send(res, 200, `<?xml version="1.0"?><CompleteMultipartUploadResult><Location>x</Location><Bucket>${bucket}</Bucket><Key>${xmlEscape(key)}</Key><ETag>${xmlEscape(etag)}</ETag></CompleteMultipartUploadResult>`);
    }

    // ---- AbortMultipartUpload
    if (req.method === 'DELETE' && uploadId) {
      this.stats.abort++;
      const f = this.consumeFault('abort');
      if (f) return this.error(res, f, 'ServiceUnavailable', 'injected');
      if (!this.multiparts.has(uploadId)) return this.error(res, 404, 'NoSuchUpload', 'The specified upload does not exist.');
      this.multiparts.delete(uploadId);
      return this.send(res, 204);
    }

    // ---- HeadObject
    if (req.method === 'HEAD') {
      this.stats.head++;
      const f = this.consumeFault('head');
      if (f) { res.writeHead(f); return res.end(); }
      const obj = this.objects.get(key);
      if (!obj) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Length': obj.data.length, ETag: obj.etag });
      return res.end();
    }

    return this.error(res, 400, 'NotImplemented', `${req.method} ${req.url}`);
  }
}

module.exports = { FakeS3, md5 };
