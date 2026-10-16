'use strict';

require('dotenv').config({ quiet: true });

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function toInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative integer`);
  }
  return value;
}

function toBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`Environment variable ${name} must be "true" or "false"`);
}

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';

const jwtSecret = required('JWT_SECRET');
const codeHmacSecret = required('CODE_HMAC_SECRET');
if (jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
if (codeHmacSecret.length < 32) throw new Error('CODE_HMAC_SECRET must be at least 32 characters');
if (jwtSecret === codeHmacSecret) {
  throw new Error('JWT_SECRET and CODE_HMAC_SECRET must be different values');
}

const emailMode = process.env.EMAIL_MODE || 'smtp'; // 'smtp' | 'test' (test discards mail)
if (!['smtp', 'test'].includes(emailMode)) throw new Error('EMAIL_MODE must be "smtp" or "test"');
if (emailMode === 'test' && isProduction) throw new Error('EMAIL_MODE=test is not allowed in production');

const cookieSecure = toBool('COOKIE_SECURE', isProduction);
const cookieSameSite = (process.env.COOKIE_SAMESITE || 'lax').toLowerCase();
if (!['lax', 'strict', 'none'].includes(cookieSameSite)) {
  throw new Error('COOKIE_SAMESITE must be lax, strict or none');
}
if (isProduction && !cookieSecure) throw new Error('COOKIE_SECURE must be true in production');
if (cookieSameSite === 'none' && !cookieSecure) {
  throw new Error('COOKIE_SAMESITE=none requires COOKIE_SECURE=true');
}

// ---- Cloud storage (Cloudflare R2, S3-compatible API) ----
// TOKEN_VALUE (a Cloudflare API token) is NOT needed: uploads use the S3 API with ACCESS_KEY_ID / SECRET_ACCESS_KEY.
const MiB = 1024 * 1024;
const cloudAccountId = required('CLOUD_ACCOUNT_ID');
const partSizeBytes =
  nodeEnv === 'test' && process.env.UPLOAD_PART_SIZE_BYTES
    ? toInt('UPLOAD_PART_SIZE_BYTES', 16 * MiB) // tiny parts are only allowed in tests
    : toInt('UPLOAD_PART_SIZE_MB', 16) * MiB;
if (partSizeBytes < 5 * MiB && nodeEnv !== 'test') {
  throw new Error('UPLOAD_PART_SIZE_MB must be at least 5 (storage services reject smaller parts)');
}

// One value drives both the JWT lifetime and the cookie lifetime so they cannot drift apart.
const sessionSeconds = toInt('SESSION_HOURS', 24) * 3600;
const rateWindowMs = toInt('RATE_LIMIT_WINDOW_MINUTES', 15) * 60 * 1000;

module.exports = Object.freeze({
  nodeEnv,
  isProduction,
  port: toInt('PORT', 3000),
  trustProxy: toInt('TRUST_PROXY', 0), // number of reverse-proxy hops in front of the app
  appName: process.env.APP_NAME || 'Podcast Clipper',
  frontendOrigin: required('FRONTEND_ORIGIN').replace(/\/+$/, ''),
  db: {
    url: required('DATABASE_URL'),
    ssl: toBool('DATABASE_SSL', false),
    poolMax: toInt('DB_POOL_MAX', 10),
  },
  jwtSecret,
  codeHmacSecret,
  session: { seconds: sessionSeconds, ms: sessionSeconds * 1000 },
  cookie: {
    secure: cookieSecure,
    sameSite: cookieSameSite,
    domain: process.env.COOKIE_DOMAIN || undefined,
  },
  bcryptRounds: toInt('BCRYPT_ROUNDS', 12),
  verification: {
    expirySeconds: toInt('VERIFICATION_EXPIRY_SECONDS', 600), // 10 minutes
    maxAttempts: toInt('VERIFICATION_MAX_ATTEMPTS', 5),
    resendCooldownSeconds: toInt('RESEND_COOLDOWN_SECONDS', 60),
  },
  email: {
    mode: emailMode,
    user: emailMode === 'smtp' ? required('EMAIL_USER') : undefined,
    pass: emailMode === 'smtp' ? required('EMAIL_PASS') : undefined,
  },
  storage: {
    accountId: cloudAccountId,
    bucket: required('BUCKET_NAME'),
    publicUri: required('CLOUD_PUBLIC_URI').replace(/\/+$/, ''),
    accessKeyId: required('ACCESS_KEY_ID'),
    secretAccessKey: required('SECRET_ACCESS_KEY'),
    // CLOUD_ENDPOINT is optional (local MinIO, tests). Default is the R2 S3 endpoint for your account.
    endpoint: process.env.CLOUD_ENDPOINT || `https://${cloudAccountId}.r2.cloudflarestorage.com`,
  },
  upload: {
    partSizeBytes,
    maxBytes: toInt('UPLOAD_MAX_BYTES', 10 * 1024 * MiB), // 10 GiB
    maxActivePerUser: toInt('UPLOAD_MAX_ACTIVE_PER_USER', 3),
    urlTtlSeconds: toInt('UPLOAD_URL_TTL_SECONDS', 900),
    sessionTtlSeconds: toInt('UPLOAD_SESSION_TTL_HOURS', 48) * 3600,
    completeStaleSeconds: toInt('UPLOAD_COMPLETE_STALE_SECONDS', 120),
  },
  rateLimit: {
    windowMs: rateWindowMs,
    uploadMax: toInt('RATE_LIMIT_UPLOAD_MAX', 2000),
    registerMax: toInt('RATE_LIMIT_REGISTER_MAX', 5),
    verifyMax: toInt('RATE_LIMIT_VERIFY_MAX', 10),
    loginMax: toInt('RATE_LIMIT_LOGIN_MAX', 10),
  },
});
