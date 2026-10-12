'use strict';

// Each test file runs in its own process, so env can be configured per file BEFORE the app loads.
function bootstrap(overrides = {}) {
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
  };
  Object.assign(process.env, defaults, overrides);

  const app = require('../src/app');
  const { pool } = require('../src/config/db');
  const emailService = require('../src/services/emailService');
  const { runMigrations } = require('../scripts/migrate');
  return { app, pool, emailService, runMigrations, origin: process.env.FRONTEND_ORIGIN };
}

module.exports = { bootstrap };
