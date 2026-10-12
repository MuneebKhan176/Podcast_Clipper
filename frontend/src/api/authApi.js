import { request } from './httpClient.js';

// One function per backend endpoint under /api/auth. Each returns the useful part of `data`.

/** POST /api/auth/register -> { verificationRequired, email, expiresInSeconds } */
export async function register({ username, email, password, confirmPassword }) {
  const res = await request('/api/auth/register', {
    method: 'POST',
    body: { username, email, password, confirmPassword },
    suppressUnauthorized: true,
  });
  return res.data;
}

/** POST /api/auth/verify-email -> user. On success the backend has set the `token` cookie. */
export async function verifyEmail({ email, code }) {
  const res = await request('/api/auth/verify-email', {
    method: 'POST',
    body: { email, code },
    suppressUnauthorized: true,
  });
  return res.data.user;
}

/** POST /api/auth/login -> user. On success the backend has set the `token` cookie. */
export async function login({ email, password }) {
  const res = await request('/api/auth/login', {
    method: 'POST',
    body: { email, password },
    suppressUnauthorized: true,
  });
  return res.data.user;
}

/** GET /api/auth/me -> { id, username, email, createdAt }. Throws ApiError(401) when not signed in. */
export async function getMe(signal) {
  const res = await request('/api/auth/me', { signal, suppressUnauthorized: true });
  return res.data.user;
}

/** POST /api/auth/logout. Clears the cookie in the browser. */
export async function logout() {
  await request('/api/auth/logout', { method: 'POST', suppressUnauthorized: true });
}
