<<<<<<< HEAD
# Podcast Clipper — Backend (Phase 2: Authentication)

Node.js + Express + PostgreSQL. Cookie-based JWT auth (HttpOnly `token` cookie), email verification with a
6-digit code. Rebuilt from the cordEX reference flow with its weaknesses fixed. Authentication only: no wallets,
trading, social profiles, uploads, queues or LLM code.

## Setup

Requirements: Node.js >= 20, PostgreSQL >= 13 (uses built-in `gen_random_uuid()`).

```bash
cd backend
npm install
cp .env.example .env            # then fill in the values (see below)
createdb podcast_clipper        # or create the database however you prefer
npm run migrate                 # applies migrations/*.sql in order (safe to re-run)
npm run dev                     # or: npm start      -> http://localhost:3000
```

Required `.env` values: `DATABASE_URL`, `FRONTEND_ORIGIN`, `JWT_SECRET`, `CODE_HMAC_SECRET`, `EMAIL_USER`,
`EMAIL_PASS`. Generate each secret (32+ chars, and they must differ) with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Gmail: enable 2-step verification and create an **App Password** for `EMAIL_PASS`.
The app refuses to start if a required variable is missing, if the secrets are weak/identical, or if
`NODE_ENV=production` is combined with `COOKIE_SECURE=false`.

## Endpoints (all JSON: `{ success, message, data }`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/auth/register` | public | `{username,email,password,confirmPassword}` -> 201, code emailed |
| POST | `/api/auth/verify-email` | public | `{email,code}` -> 201, user created, cookie set |
| POST | `/api/auth/login` | public | `{email,password}` -> 200, cookie set |
| GET | `/api/auth/me` | required | `{id,username,email,createdAt}` |
| POST | `/api/auth/logout` | none needed | clears the cookie |
| GET | `/api/health` | public | liveness check |

Status codes: 400 validation / wrong or expired code, 401 bad credentials or token, 403 foreign origin,
404 no pending registration, 409 email already registered, 413 body too large, 415 non-JSON body,
429 rate limited / cooldown / too many wrong codes, 502 verification email could not be sent.

Manual walk-through with curl (the code arrives by email):

```bash
H='Content-Type: application/json'; O='Origin: http://localhost:5173'
curl -s -X POST localhost:3000/api/auth/register -H "$H" -H "$O" \
  -d '{"username":"muneeb","email":"you@example.com","password":"Str0ngPass!","confirmPassword":"Str0ngPass!"}'
curl -s -c jar.txt -X POST localhost:3000/api/auth/verify-email -H "$H" -H "$O" \
  -d '{"email":"you@example.com","code":"123456"}'
curl -s -b jar.txt localhost:3000/api/auth/me
curl -s -b jar.txt -c jar.txt -X POST localhost:3000/api/auth/logout -H "$O"
```

## Tests

Integration tests run against a real PostgreSQL. They **TRUNCATE tables**, so point them at a dedicated
database whose name contains `test` (the helper refuses otherwise). Mail is captured in-process; nothing is sent.

```bash
createdb podcast_clipper_test
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/podcast_clipper_test npm test
```

## Layout

```
migrations/   SQL schema (users, pending_users); scripts/migrate.js applies them and records them in schema_migrations
src/config/   env.js (validated config, fail-fast), db.js (pool + withTransaction)
src/routes/ controllers/ services/ repositories/   HTTP -> business logic -> parameterized SQL
src/middleware/  authenticate, requestGuard (CSRF), rateLimiters, validate, errorHandler
src/validators/  zod schemas (incl. the email rule)      src/utils/  crypto, tokens, errors, response
src/app.js (Express wiring)   src/server.js (listen, cleanup timer, graceful shutdown)
```

## Security design (and what changed from cordEX)

- Codes: `crypto.randomInt`; stored only as an HMAC-SHA256 keyed with `CODE_HMAC_SECRET` (bound to the email);
  compared in constant time; never returned by the API or logged. Expiry uses the database clock.
- Brute force: 5 wrong codes delete the pending registration; per-IP rate limits on register/verify/login;
  a 60 s cooldown before a new code can be issued for the same email.
- Pending retries: one atomic `INSERT ... ON CONFLICT (email) DO UPDATE` (no delete-then-insert race).
  If the email fails to send, the pending row is removed and 502 returned.
- Verification: one transaction on a dedicated connection (`SELECT ... FOR UPDATE`, insert user, delete pending),
  released in `finally`. Concurrent verifications create exactly one user.
- Passwords: bcrypt cost 12 (`BCRYPT_ROUNDS`), never trimmed, max 72 bytes. Login does a dummy bcrypt compare for
  unknown emails so timing does not reveal which emails exist.
- JWT: HS256 pinned on verify; payload `{id,email,username}`; lifetime and cookie `maxAge` both come from `SESSION_HOURS`.
  Cookie: `HttpOnly`, `SameSite=Lax` (configurable), `Secure` per env. `/me` re-reads the user from the DB using only `req.user.id`.
- CSRF: `SameSite` cookie + exact-origin CORS + `requestGuard` (state-changing requests with an `Origin` other than
  `FRONTEND_ORIGIN` get 403; bodies must be `application/json`). This relies on frontend and API being **same-site**
  (`localhost:5173` -> `localhost:3000`, or `app.example.com` -> `api.example.com`). If you ever host them on unrelated
  sites you need `SameSite=None; Secure` **plus** a CSRF token.
- Inputs: zod validation, 10 kb body limit, parameterized SQL only, generic 500s, no secrets/passwords/codes in logs.

## Known limitations (honest list)

- **Logout does not revoke tokens.** The JWT is stateless; clearing the cookie only removes it from that browser.
  A stolen token stays valid until it expires (`SESSION_HOURS`). Revocation would need a server-side session/denylist
  or refresh-token rotation, deliberately out of scope for this phase.
- `409 Email already registered` reveals which emails have accounts (chosen for usability).
- Anyone can re-register a victim's email and replace their *pending* (unverified) registration. They cannot read the
  code, and the cooldown + rate limits slow this down, but it can annoy. No existing account is affected.
- Rate limits are in-memory per process and per IP. Behind a proxy set `TRUST_PROXY`; with several instances use a shared store.
- Email rule is the cordEX one (`.com` addresses only) by request; change `EMAIL_REGEX` in `src/validators/authValidators.js`.
- Username is not unique (the reference didn't require it). Password rule is length-only (8..72 bytes).
- Not yet run: tests against your Gmail account and a real browser. The React app comes in Phase 3.
=======
>>>>>>> 3a1dcf55a977d35606728d054941e22f2b795434
