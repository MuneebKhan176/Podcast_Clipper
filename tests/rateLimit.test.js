'use strict';

const { describe, it, before, beforeEach, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { bootstrap } = require('./helpers/helpers');

// Real (low) limits and a real resend cooldown for this file only.
const { app, pool, emailService, runMigrations, origin } = bootstrap({
  RATE_LIMIT_REGISTER_MAX: '4',
  RATE_LIMIT_VERIFY_MAX: '3',
  RATE_LIMIT_LOGIN_MAX: '3',
  RESEND_COOLDOWN_SECONDS: '60',
});

const post = (path) => request(app).post(path).set('Origin', origin);
const reg = (email) =>
  post('/api/auth/register').send({
    username: 'Tester',
    email,
    password: 'Str0ngPass!',
    confirmPassword: 'Str0ngPass!',
  });

before(async () => {
  await runMigrations();
  await pool.query('TRUNCATE users, pending_users CASCADE');
  mock.method(emailService, 'sendVerificationEmail', async () => {});
});
after(async () => {
  mock.restoreAll();
  await pool.end();
});

describe('resend cooldown and rate limiting', () => {
  it('blocks a second code for the same email within the cooldown (429), and rate limits registration', async () => {
    await reg('a@example.com').expect(201);
    const cooldown = await reg('a@example.com').expect(429);
    assert.match(cooldown.body.message, /sent recently/);

    await reg('b@example.com').expect(201);
    await reg('c@example.com').expect(201);
    const limited = await reg('d@example.com').expect(429); // 5th request in the window, max is 4
    assert.match(limited.body.message, /Too many registration attempts/);
    assert.ok(limited.headers['ratelimit'] || limited.headers['ratelimit-policy'], 'standard rate-limit headers');
  });

  it('rate limits verification attempts', async () => {
    for (let i = 0; i < 3; i++) {
      await post('/api/auth/verify-email').send({ email: 'a@example.com', code: '000000' });
    }
    const res = await post('/api/auth/verify-email').send({ email: 'a@example.com', code: '000000' }).expect(429);
    assert.match(res.body.message, /Too many verification attempts/);
  });

  it('rate limits failed logins', async () => {
    for (let i = 0; i < 3; i++) {
      await post('/api/auth/login').send({ email: 'x@example.com', password: 'nope' }).expect(401);
    }
    const res = await post('/api/auth/login').send({ email: 'x@example.com', password: 'nope' }).expect(429);
    assert.match(res.body.message, /Too many login attempts/);
  });
});
