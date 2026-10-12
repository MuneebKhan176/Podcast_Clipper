'use strict';

const crypto = require('crypto');
const config = require('../config/env');

/** Cryptographically secure 6-digit code (100000-999999). */
function generateVerificationCode() {
  return String(crypto.randomInt(100000, 1000000));
}

/**
 * Keyed hash of the code, bound to the email. A plain SHA-256 of a 6-digit code could be
 * reversed instantly from a leaked table; the server-side secret makes that impossible
 * without also stealing the secret.
 */
function hashVerificationCode(email, code) {
  return crypto.createHmac('sha256', config.codeHmacSecret).update(`${email}:${code}`).digest('hex');
}

/** Constant-time comparison of two hex digests. */
function safeEqualHex(a, b) {
  const bufA = Buffer.from(String(a), 'hex');
  const bufB = Buffer.from(String(b), 'hex');
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { generateVerificationCode, hashVerificationCode, safeEqualHex };
