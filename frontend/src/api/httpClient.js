// Single place that talks to the backend. Authentication is cookie-based: the browser stores the
// HttpOnly `token` cookie and we only have to send `credentials: "include"`. No token ever touches JS.

const BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(status, message, data = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status; // 0 = the server could not be reached
    this.data = data; // backend `data` field, e.g. { errors: [{field, message}] } or { reason }
  }
}

let unauthorizedHandler = null;

/** AuthContext registers a callback here so any 401 from a protected call ends the session in the UI. */
export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = handler;
}

/**
 * Sends a JSON request and returns the backend's `{ success, message, data }` payload.
 * Throws ApiError for network failures and for any non-2xx / `success: false` response.
 * `suppressUnauthorized` is for calls where a 401 is an expected answer (login, /me on page load).
 */
export async function request(path, { method = 'GET', body, signal, suppressUnauthorized = false } = {}) {
  const headers = { Accept: 'application/json' };
  const init = { method, headers, credentials: 'include', signal };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, init);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(0, 'Unable to reach the server. Check your connection and try again.');
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null; // non-JSON body (e.g. a proxy error page)
  }

  if (!response.ok || payload?.success === false) {
    if (response.status === 401 && !suppressUnauthorized && unauthorizedHandler) unauthorizedHandler();
    throw new ApiError(
      response.status,
      payload?.message || 'Something went wrong. Please try again.',
      payload?.data ?? null
    );
  }
  return payload;
}
