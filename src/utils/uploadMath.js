'use strict';

// Pure part-size arithmetic for multipart uploads (S3 / Cloudflare R2 limits).
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

const MIN_PART_BYTES = 5 * MiB; // every part except the last must be at least this big
const MAX_PART_BYTES = 5 * GiB;
const MAX_PARTS = 10000;

/**
 * Chooses the part size and part count for a file.
 * Starts from the configured size (default 16 MiB) and grows it, in whole MiB, only when the file would
 * otherwise need more than 10,000 parts (a 5 GB file needs just 299 parts of 16 MiB).
 */
function planParts(sizeBytes, preferredPartBytes) {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new RangeError('sizeBytes must be a positive integer');
  }
  if (!Number.isSafeInteger(preferredPartBytes) || preferredPartBytes <= 0) {
    throw new RangeError('preferredPartBytes must be a positive integer');
  }

  let partSizeBytes = Math.max(preferredPartBytes, Math.ceil(sizeBytes / MAX_PARTS));
  if (partSizeBytes > MiB) partSizeBytes = Math.ceil(partSizeBytes / MiB) * MiB;
  if (partSizeBytes > MAX_PART_BYTES) throw new RangeError('File is too large for a multipart upload');

  return { partSizeBytes, totalParts: Math.ceil(sizeBytes / partSizeBytes) };
}

/** Exact byte length of a 1-based part: full-size, except the last one carries the remainder. */
function partLength(partNumber, sizeBytes, partSizeBytes) {
  const totalParts = Math.ceil(sizeBytes / partSizeBytes);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > totalParts) {
    throw new RangeError(`partNumber must be between 1 and ${totalParts}`);
  }
  return partNumber < totalParts ? partSizeBytes : sizeBytes - partSizeBytes * (totalParts - 1);
}

module.exports = { planParts, partLength, MIN_PART_BYTES, MAX_PART_BYTES, MAX_PARTS, MiB, GiB };
