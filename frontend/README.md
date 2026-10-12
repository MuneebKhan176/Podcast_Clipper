# Podcast Clipper — Frontend (Phase 3: Authentication)

React + Vite + JavaScript, React Router, `fetch` with `credentials: "include"`. Talks to the Phase 2 backend
(`../backend`). Covers register, email verification, login, a protected dashboard and logout.

## Run it

Start the backend first (see `backend/README.md`), with `FRONTEND_ORIGIN=http://localhost:5173` in its `.env`.

```bash
cd frontend
npm install
cp .env.example .env     # VITE_API_BASE_URL=http://localhost:3000
npm run dev              # http://localhost:5173  (port is fixed on purpose)
```

Other scripts: `npm run build` (production bundle in `dist/`), `npm run preview`, `npm test`.

**Use `localhost` for both** the page (`http://localhost:5173`) and the API (`http://localhost:3000`). Mixing `localhost`
and `127.0.0.1` makes the browser treat them as different sites, so the session cookie is not sent.
The dev server uses `strictPort`: the backend only accepts requests from exactly `FRONTEND_ORIGIN`, so Vite must not
silently move to another port.

## Screens and routes

| Route | Page | Access |
|---|---|---|
| `/register` | Create account -> POST `/api/auth/register` | signed-out only |
| `/verify-email` | Enter the 6-digit code -> POST `/api/auth/verify-email` | signed-out only |
| `/login` | POST `/api/auth/login` | signed-out only |
| `/dashboard` | username, email, log out, placeholder for the clipping workflow | signed-in only |
| `/` and unknown paths | redirect to `/dashboard` (which redirects to `/login` if signed out) | |

User flow: Register -> (code arrives by email) -> Verify -> Dashboard. A verified user is signed in immediately,
because the backend sets the cookie in the verify response.

## How it stays in sync with the backend

- **Session = the HttpOnly `token` cookie.** JavaScript never sees or stores the JWT; nothing is written to
  localStorage/sessionStorage. Every request sends `credentials: "include"`.
- **Page load:** `AuthProvider` calls `GET /api/auth/me`. 200 -> signed in, 401 -> signed out, network error -> a
  "Can't reach the server" screen with a retry button. Login state is never assumed from memory.
- **Expired session mid-use:** a 401 from any protected call (via `httpClient`) sends the user to `/login`.
- **Response shape:** every backend reply is `{ success, message, data }`; `httpClient` turns failures into an
  `ApiError(status, message, data)` that the forms display.
- **Field errors:** backend validation errors (`data.errors: [{field, message}]`) appear under the matching input;
  other errors (409 already registered, 429 rate limit/cooldown, wrong or expired code with attempts remaining)
  appear as one alert. Client-side checks mirror the backend rules (including the `.com`-only email rule, in
  `src/utils/validation.js`), but the server is always the authority.
- **Logout:** POST `/api/auth/logout`; local state is cleared only after the server confirms.

## Layout

```
src/api/          httpClient.js (fetch wrapper, ApiError), authApi.js (one function per endpoint)
src/context/      AuthContext.jsx (session state, login/verify/logout, /me restore)
src/components/   AuthForm.jsx (shared form card), ProtectedRoute.jsx (ProtectedRoute + PublicOnlyRoute)
src/pages/        RegisterPage, VerifyEmailPage, LoginPage, DashboardPage
src/utils/        validation.js        src/test/  UI flow tests (Vitest + Testing Library)
```

## Testing status

- `npm test`: 20 UI flow tests (jsdom, mocked responses copied from the real API shapes): route protection, session
  restore, register/verify/login/logout flows, client and server validation errors, retry screen, 401 handling,
  nothing stored in the browser.
- The same `authApi`/`httpClient` code was also run against the **real running backend** (register -> wrong code ->
  correct code -> cookie -> `/me` -> logout -> login, 409, 401, CORS preflight, cookie flags, network failure); all passed.
  That script is not included in the project.
- **Not tested in a real browser** (none was available where this was built). Do one manual pass in Chrome/Firefox
  before relying on it.

## Limitations

- There is no separate "resend code" endpoint. "Register again" issues a fresh code (the backend enforces a 60 s cooldown).
- The verify page keeps the email only in router state; after a page refresh it asks for the email again.
- Email must end in `.com` (cordEX rule kept by request; change it in both `validation.js` and the backend validator).
- Logout does not revoke a stolen JWT (backend limitation, see its README).
