'use strict';


/// -------- Test Database URL ---------
/// $env:TEST_DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/podcast_clipper_test"
/// ------------------------------------

// Each test file runs in its own process, so env can be configured per file BEFORE the app loads.
function applyEnv(overrides = {}) {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error('Set TEST_DATABASE_URL to a dedicated test database (tests TRUNCATE tables).');
  }
  if (!/test/i.test(new URL(process.env.TEST_DATABASE_URL).pathname)) {
    throw new Error('TEST_DATABASE_URL database name must contain "test" as a safety check.');
  }

  const defaults = {
    NODE_ENV: 'test',
    DATABASE_URL: process.env.TEST_DATABASE_URL, // never the dev database
    JWT_SECRET: 'test-jwt-secret-'.padEnd(48, 'j'),
    CODE_HMAC_SECRET: 'test-code-secret-'.padEnd(48, 'c'),
    FRONTEND_ORIGIN: 'http://localhost:5173',
    EMAIL_MODE: 'test',
    BCRYPT_ROUNDS: '4',
    RESEND_COOLDOWN_SECONDS: '0',
    RATE_LIMIT_REGISTER_MAX: '1000',
    RATE_LIMIT_VERIFY_MAX: '1000',
    RATE_LIMIT_LOGIN_MAX: '1000',
    RATE_LIMIT_UPLOAD_MAX: '100000',
    // Cloud storage: dummy credentials; the endpoint points at a closed port unless a FakeS3 is started.
    CLOUD_ACCOUNT_ID: 'testaccount',
    BUCKET_NAME: 'test-bucket',
    CLOUD_PUBLIC_URI: 'https://pub-test.r2.dev',
    ACCESS_KEY_ID: 'AKIATESTTESTTESTTEST',
    SECRET_ACCESS_KEY: 'test-secret-access-key',
    CLOUD_ENDPOINT: 'http://127.0.0.1:9',
  };
  Object.assign(process.env, defaults, overrides);
}

function load() {
  const app = require('../../src/app');
  const { pool } = require('../../src/config/db');
  const emailService = require('../../src/services/emailService');
  const { runMigrations } = require('../../scripts/migrate');
  return { app, pool, emailService, runMigrations, origin: process.env.FRONTEND_ORIGIN };
}

/** Synchronous bootstrap used by the authentication tests. */
function bootstrap(overrides = {}) {
  applyEnv(overrides);
  return load();
}

/** Starts an in-memory S3 server first, then loads the app pointed at it. */
async function bootstrapWithStorage(overrides = {}) {
  const { FakeS3 } = require('./fakeS3');
  const fakeS3 = new FakeS3({ bucket: 'test-bucket' });
  await fakeS3.start();
  applyEnv({ CLOUD_ENDPOINT: fakeS3.endpoint, ...overrides });
  return { ...load(), fakeS3 };
}

module.exports = { bootstrap, bootstrapWithStorage };
