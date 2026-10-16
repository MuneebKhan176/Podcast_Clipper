'use strict';

const {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const config = require('../config/env');

// Thin wrapper over the S3-compatible API (Cloudflare R2). Nothing outside this file knows about the SDK.
const client = new S3Client({
  region: 'auto',
  endpoint: config.storage.endpoint,
  forcePathStyle: true,
  credentials: {
    accessKeyId: config.storage.accessKeyId,
    secretAccessKey: config.storage.secretAccessKey,
  },
  // Transient failures (timeouts, 5xx, throttling) are retried with backoff before we give up.
  maxAttempts: 4,
  requestHandler: { connectionTimeout: 5000, requestTimeout: 30000 },
  // R2 + browser uploads: never add checksum query params/headers to presigned URLs.
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

const Bucket = config.storage.bucket;

const isNoSuchUpload = (err) => err?.name === 'NoSuchUpload' || err?.Code === 'NoSuchUpload';
const isNotFound = (err) => err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404;

async function createMultipartUpload({ key, contentType }) {
  const res = await client.send(
    new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: contentType })
  );
  return res.UploadId;
}

/** A time-limited URL the browser PUTs one part to. The bytes never pass through this server. */
function presignUploadPart({ key, uploadId, partNumber, expiresInSeconds }) {
  return getSignedUrl(
    client,
    new UploadPartCommand({ Bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
    { expiresIn: expiresInSeconds }
  );
}

/** Every part the storage service has durably stored for this upload (paginates, 1000 per page). */
async function listAllParts({ key, uploadId }) {
  const parts = [];
  let marker;
  for (;;) {
    const res = await client.send(
      new ListPartsCommand({
        Bucket,
        Key: key,
        UploadId: uploadId,
        MaxParts: 1000,
        PartNumberMarker: marker,
      })
    );
    for (const p of res.Parts ?? []) {
      parts.push({ partNumber: p.PartNumber, size: Number(p.Size), etag: p.ETag });
    }
    if (!res.IsTruncated || !res.NextPartNumberMarker) break;
    marker = res.NextPartNumberMarker;
  }
  return parts.sort((a, b) => a.partNumber - b.partNumber);
}

async function completeMultipartUpload({ key, uploadId, parts }) {
  const res = await client.send(
    new CompleteMultipartUploadCommand({
      Bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
    })
  );
  return { etag: res.ETag };
}

/** Idempotent: aborting an upload that no longer exists is not an error. */
async function abortMultipartUpload({ key, uploadId }) {
  try {
    await client.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId }));
  } catch (err) {
    if (!isNoSuchUpload(err)) throw err;
  }
}

/** { size, etag } of the finished object, or null if it does not exist. */
async function headObject(key) {
  try {
    const res = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
    return { size: Number(res.ContentLength), etag: res.ETag };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

module.exports = {
  createMultipartUpload,
  presignUploadPart,
  listAllParts,
  completeMultipartUpload,
  abortMultipartUpload,
  headObject,
  isNoSuchUpload,
};
