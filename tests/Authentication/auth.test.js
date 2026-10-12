'use strict';

const { describe, it, before, beforeEach, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { bootstrap } = require('../helpers');

const { app, pool, emailService, runMigrations, origin } = bootstrap();

const sent = []; // captured verification emails: { email, code }
const validUser = {
  username: 'Muneeb',
  email: 'Muneeb@Example.com', // mixed case on purpose: must be normalized
  password: 'Str0ngPass!',
  confirmPassword: 'Str0ngPass!',
};

const post = (path) => request(app).post(path).set('Origin', origin);
const register = (overrides = {}) => post('/api/auth/register').send({ ...validUser, ...overrides });
const lastCode = () => sent[sent.length - 1].code;
const wrongCode = () => (lastCode() === '000000' ? '111111' : '000000');
const tokenCookie = (res) => (res.headers['set-cookie'] || []).find((c) => c.startsWith('token='));

async function verifiedAgent() {
  await register().expect(201);
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/verify-email')
    .set('Origin', origin)
    .send({ email: validUser.email, code: lastCode() })
    .expect(201);
  return { agent, res };
}

before(async () => {
  await runMigrations();
  mock.method(emailService, 'sendVerificationEmail', async (email, code) => {
    sent.push({ email, code });
  });
});
beforeEach(async () => {
  sent.length = 0;
  await pool.query('TRUNCATE users, pending_users');
});
after(async () => {
  mock.restoreAll();
  await pool.end();
});

describe('POST /api/auth/register', () => {
  it('rejects missing fields', async () => {
    const res = await post('/api/auth/register').send({}).expect(400);
    assert.equal(res.body.success, false);
    assert.ok(res.body.data.errors.length >= 4);
  });

  it('rejects an invalid email, short password, and mismatched passwords', async () => {
    await register({ email: 'not-an-email' }).expect(400);
    await register({ password: 'short', confirmPassword: 'short' }).expect(400);
    const res = await register({ confirmPassword: 'Different1!' }).expect(400);
    assert.equal(res.body.message, 'Passwords do not match');
  });

  it('rejects a password longer than 72 bytes', async () => {
    const long = 'a'.repeat(73);
    await register({ password: long, confirmPassword: long }).expect(400);
  });

  it('creates only a pending user, emails a code, and never returns the code', async () => {
    const res = await register().expect(201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.verificationRequired, true);
    assert.equal(res.body.data.email, 'muneeb@example.com');
    assert.equal(sent.length, 1);
    assert.match(sent[0].code, /^\d{6}$/);
    assert.ok(!JSON.stringify(res.body).includes(sent[0].code));
    assert.equal(tokenCookie(res), undefined, 'no session before verification');

    assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 0);
    const pending = (await pool.query('SELECT * FROM pending_users')).rows;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].email, 'muneeb@example.com');
    assert.match(pending[0].password_hash, /^\$2[aby]\$/);
    assert.notEqual(pending[0].verification_code_hash, sent[0].code);
    assert.match(pending[0].verification_code_hash, /^[0-9a-f]{64}$/);
    assert.equal(pending[0].attempt_count, 0);
    const mins = (new Date(pending[0].expires_at) - Date.now()) / 60000;
    assert.ok(mins > 9 && mins <= 10, `expiry should be ~10 minutes, got ${mins}`);
  });

  it('returns 409 when the email is already registered', async () => {
    await verifiedAgent();
    const res = await register({ email: 'MUNEEB@example.com' }).expect(409);
    assert.equal(res.body.message, 'Email already registered');
  });

  it('replaces (not duplicates) a pending registration on retry; old code stops working', async () => {
    await register().expect(201);
    const firstCode = lastCode();
    await register().expect(201);
    const secondCode = lastCode();

    assert.equal((await pool.query('SELECT count(*)::int AS n FROM pending_users')).rows[0].n, 1);
    if (firstCode !== secondCode) {
      await post('/api/auth/verify-email').send({ email: validUser.email, code: firstCode }).expect(400);
    }
    await post('/api/auth/verify-email').send({ email: validUser.email, code: secondCode }).expect(201);
  });

  it('handles concurrent registrations for one email without duplicates or crashes', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => register()));
    // Losers of the race may be told to wait (429); nothing may 5xx.
    assert.ok(results.every((r) => r.status === 201 || r.status === 429));
    assert.ok(results.some((r) => r.status === 201));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM pending_users')).rows[0].n, 1);
  });

  it('removes the pending row and returns 502 if the email cannot be sent', async () => {
    mock.method(emailService, 'sendVerificationEmail', async () => {
      throw new Error('SMTP down');
    });
    const res = await register().expect(502);
    assert.equal(res.body.success, false);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM pending_users')).rows[0].n, 0);
    // restore the capturing mock
    emailService.sendVerificationEmail.mock.restore();
    mock.method(emailService, 'sendVerificationEmail', async (email, code) => {
      sent.push({ email, code });
    });
  });
});

describe('POST /api/auth/verify-email', () => {
  it('rejects malformed input', async () => {
    await post('/api/auth/verify-email').send({ email: 'a@b.com', code: '12' }).expect(400);
    await post('/api/auth/verify-email').send({}).expect(400);
  });

  it('returns 404 when there is no pending registration', async () => {
    const res = await post('/api/auth/verify-email')
      .send({ email: 'nobody@example.com', code: '123456' })
      .expect(404);
    assert.equal(res.body.data.reason, 'not_found');
  });

  it('rejects a wrong code, counts the attempt, and keeps the pending row', async () => {
    await register().expect(201);
    const res = await post('/api/auth/verify-email')
      .send({ email: validUser.email, code: wrongCode() })
      .expect(400);
    assert.equal(res.body.data.reason, 'invalid');
    assert.equal(res.body.data.attemptsRemaining, 4);
    const row = (await pool.query('SELECT attempt_count FROM pending_users')).rows[0];
    assert.equal(row.attempt_count, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 0);
  });

  it('locks out after 5 wrong attempts, even if the right code is then supplied', async () => {
    await register().expect(201);
    const correct = lastCode();
    for (let i = 1; i <= 4; i++) {
      await post('/api/auth/verify-email').send({ email: validUser.email, code: wrongCode() }).expect(400);
    }
    const fifth = await post('/api/auth/verify-email')
      .send({ email: validUser.email, code: wrongCode() })
      .expect(429);
    assert.equal(fifth.body.data.reason, 'too_many_attempts');
    await post('/api/auth/verify-email').send({ email: validUser.email, code: correct }).expect(404);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 0);
  });

  it('rejects an expired code and deletes the pending row', async () => {
    await register().expect(201);
    await pool.query("UPDATE pending_users SET expires_at = now() - interval '1 minute'");
    const res = await post('/api/auth/verify-email')
      .send({ email: validUser.email, code: lastCode() })
      .expect(400);
    assert.equal(res.body.data.reason, 'expired');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM pending_users')).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 0);
  });

  it('creates the user, deletes the pending row, and sets an HttpOnly token cookie', async () => {
    const { res } = await verifiedAgent();
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.user.username, 'Muneeb');
    assert.equal(res.body.data.user.email, 'muneeb@example.com');
    assert.match(res.body.data.user.id, /^[0-9a-f-]{36}$/);
    assert.equal(res.body.data.user.password_hash, undefined);
    assert.equal(res.body.data.user.passwordHash, undefined);

    const cookie = tokenCookie(res);
    assert.ok(cookie, 'token cookie set');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.match(cookie, /Path=\//);
    assert.doesNotMatch(cookie, /Secure/i, 'COOKIE_SECURE=false outside production');
    const jwtValue = cookie.split(';')[0].slice('token='.length);
    const payload = jwt.verify(jwtValue, process.env.JWT_SECRET);
    assert.deepEqual(
      { id: payload.id, email: payload.email, username: payload.username },
      res.body.data.user
    );
    assert.ok(payload.exp - payload.iat === 24 * 3600, 'JWT lifetime matches SESSION_HOURS');

    const users = (await pool.query('SELECT * FROM users')).rows;
    assert.equal(users.length, 1);
    assert.match(users[0].password_hash, /^\$2[aby]\$/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM pending_users')).rows[0].n, 0);
  });

  it('creates no wallets, accounts, or other tables (auth tables only)', async () => {
    await verifiedAgent();
    const { rows } = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1"
    );
    assert.deepEqual(rows.map((r) => r.table_name), ['pending_users', 'schema_migrations', 'users']);
  });

  it('cannot be replayed: a second verify with the same code fails', async () => {
    await register().expect(201);
    const code = lastCode();
    await post('/api/auth/verify-email').send({ email: validUser.email, code }).expect(201);
    await post('/api/auth/verify-email').send({ email: validUser.email, code }).expect(404);
  });

  it('creates exactly one user when verified concurrently', async () => {
    await register().expect(201);
    const code = lastCode();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        post('/api/auth/verify-email').send({ email: validUser.email, code })
      )
    );
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 1);
  });
});

describe('POST /api/auth/login', () => {
  it('logs in with correct credentials (email normalized) and sets the cookie', async () => {
    await verifiedAgent();
    const res = await post('/api/auth/login')
      .send({ email: '  MUNEEB@example.com ', password: validUser.password })
      .expect(200);
    assert.equal(res.body.data.user.email, 'muneeb@example.com');
    assert.match(tokenCookie(res), /HttpOnly/i);
  });

  it('returns the same generic 401 for a wrong password and an unknown email', async () => {
    await verifiedAgent();
    const wrongPw = await post('/api/auth/login')
      .send({ email: validUser.email, password: 'WrongPass1!' })
      .expect(401);
    const unknown = await post('/api/auth/login')
      .send({ email: 'ghost@example.com', password: 'WrongPass1!' })
      .expect(401);
    assert.equal(wrongPw.body.message, 'Invalid email or password');
    assert.deepEqual(wrongPw.body, unknown.body);
    assert.equal(tokenCookie(wrongPw), undefined);
  });

  it('does not accept a user who has only a pending registration', async () => {
    await register().expect(201);
    await post('/api/auth/login').send({ email: validUser.email, password: validUser.password }).expect(401);
  });

  it('rejects missing fields', async () => {
    await post('/api/auth/login').send({ email: 'a@b.com' }).expect(400);
  });
});

describe('GET /api/auth/me and the authentication middleware', () => {
  it('returns 401 JSON when no token is provided', async () => {
    const res = await request(app).get('/api/auth/me').expect(401);
    assert.equal(res.body.success, false);
    assert.equal(res.headers.location, undefined, 'no redirect');
  });

  it('returns the current user via the cookie, without secrets', async () => {
    const { agent } = await verifiedAgent();
    const res = await agent.get('/api/auth/me').expect(200);
    const user = res.body.data.user;
    assert.deepEqual(Object.keys(user).sort(), ['createdAt', 'email', 'id', 'username']);
    assert.equal(user.email, 'muneeb@example.com');
    assert.ok(!JSON.stringify(res.body).includes('$2'), 'no hash in response');
  });

  it('accepts Authorization: Bearer as a fallback', async () => {
    const { res } = await verifiedAgent();
    const token = tokenCookie(res).split(';')[0].slice('token='.length);
    await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`).expect(200);
    await request(app).get('/api/auth/me').set('Authorization', token).expect(401); // scheme required
  });

  it('rejects garbage, tampered, wrong-secret and wrong-algorithm tokens with 401', async () => {
    const { res } = await verifiedAgent();
    const good = tokenCookie(res).split(';')[0].slice('token='.length);
    const payload = jwt.decode(good);
    const claims = { id: payload.id, email: payload.email, username: payload.username };

    const bad = [
      'garbage',
      good.slice(0, -3) + 'abc',
      jwt.sign(claims, 'some-other-secret-that-is-long-enough-123456'),
      jwt.sign(claims, process.env.JWT_SECRET, { algorithm: 'HS512' }),
    ];
    for (const token of bad) {
      const r = await request(app).get('/api/auth/me').set('Cookie', `token=${token}`).expect(401);
      assert.equal(r.body.message, 'Invalid token');
    }
  });

  it('rejects an expired JWT with 401', async () => {
    const { res } = await verifiedAgent();
    const payload = jwt.decode(tokenCookie(res).split(';')[0].slice('token='.length));
    const expired = jwt.sign(
      { id: payload.id, email: payload.email, username: payload.username, exp: Math.floor(Date.now() / 1000) - 60 },
      process.env.JWT_SECRET
    );
    const r = await request(app).get('/api/auth/me').set('Cookie', `token=${expired}`).expect(401);
    assert.equal(r.body.message, 'Session expired');
  });

  it('returns 401 for a valid token whose user no longer exists', async () => {
    const { agent } = await verifiedAgent();
    await pool.query('TRUNCATE users');
    await agent.get('/api/auth/me').expect(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the token cookie with matching attributes, and works without a session', async () => {
    const { agent } = await verifiedAgent();
    const res = await agent.post('/api/auth/logout').set('Origin', origin).expect(200);
    const cookie = tokenCookie(res);
    assert.match(cookie, /^token=;/);
    assert.match(cookie, /Expires=Thu, 01 Jan 1970/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /Path=\//);
    await agent.get('/api/auth/me').expect(401);
    await post('/api/auth/logout').expect(200); // no session: still safe
  });
});

describe('CORS, CSRF guard, and request limits', () => {
  it('answers preflight for the exact frontend origin with credentials allowed', async () => {
    const res = await request(app)
      .options('/api/auth/login')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type')
      .expect(204);
    assert.equal(res.headers['access-control-allow-origin'], origin);
    assert.equal(res.headers['access-control-allow-credentials'], 'true');
  });

  it('rejects state-changing requests from a foreign Origin (403)', async () => {
    const { agent } = await verifiedAgent();
    const res = await agent.post('/api/auth/logout').set('Origin', 'http://evil.example').expect(403);
    assert.equal(res.body.success, false);
    await agent.get('/api/auth/me').expect(200); // session untouched
    await request(app)
      .post('/api/auth/login')
      .set('Origin', 'null')
      .send({ email: validUser.email, password: validUser.password })
      .expect(403);
  });

  it('rejects non-JSON bodies with 415', async () => {
    await request(app)
      .post('/api/auth/login')
      .set('Origin', origin)
      .type('form')
      .send('email=a%40b.com&password=x')
      .expect(415);
  });

  it('rejects oversized bodies with 413 and malformed JSON with 400', async () => {
    await post('/api/auth/register').send({ ...validUser, username: 'x'.repeat(20000) }).expect(413);
    await post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": ')
      .expect(400);
  });

  it('returns JSON 404 for unknown routes and hides the framework header', async () => {
    const res = await request(app).get('/api/nope').expect(404);
    assert.equal(res.body.success, false);
    assert.equal(res.headers['x-powered-by'], undefined);
  });

  it('uses the common response shape on every route', async () => {
    const res = await request(app).get('/api/health').expect(200);
    assert.deepEqual(Object.keys(res.body).sort(), ['data', 'message', 'success']);
  });
});
