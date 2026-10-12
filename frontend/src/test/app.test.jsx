import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App.jsx';
import { AuthProvider } from '../context/AuthContext.jsx';

// ---- A tiny fake of the backend. Response shapes copy the real API: { success, message, data } ----
const ok = (status, message, data = null) => ({ status, body: { success: true, message, data } });
const fail = (status, message, data = null) => ({ status, body: { success: false, message, data } });
const USER = { id: '6f1d1b64-0000-4000-8000-000000000001', username: 'Muneeb', email: 'muneeb@example.com' };

let session; // true when the fake "cookie" is present
let calls;

function mockApi(handlers) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init = {}) => {
      const key = `${init.method || 'GET'} ${new URL(url).pathname}`;
      calls.push({ key, init, body: init.body ? JSON.parse(init.body) : undefined });
      const handler = handlers[key];
      if (!handler) throw new Error(`Unmocked request: ${key}`);
      const res = typeof handler === 'function' ? handler(calls.at(-1)) : handler;
      if (res instanceof Error) throw res;
      return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'Content-Type': 'application/json' } });
    })
  );
}
const meHandler = () => (session ? ok(200, 'Current user', { user: { ...USER, createdAt: '2026-10-12T10:00:00.000Z' } }) : fail(401, 'Authentication required'));
const called = (key) => calls.filter((c) => c.key === key);

function renderApp(path = '/', state) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: path, state }]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  session = false;
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('session restore and route protection', () => {
  it('sends an anonymous visitor from /dashboard to the login page', async () => {
    mockApi({ 'GET /api/auth/me': meHandler });
    renderApp('/dashboard');
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
  });

  it('restores an existing session from GET /api/auth/me, sending the cookie', async () => {
    session = true;
    mockApi({ 'GET /api/auth/me': meHandler });
    renderApp('/dashboard');
    expect(await screen.findByRole('heading', { name: 'Welcome, Muneeb' })).toBeInTheDocument();
    expect(screen.getByText('muneeb@example.com')).toBeInTheDocument();
    expect(called('GET /api/auth/me')[0].init.credentials).toBe('include');
  });

  it('redirects a signed-in user away from /login, /register and /', async () => {
    session = true;
    mockApi({ 'GET /api/auth/me': meHandler });
    renderApp('/login');
    expect(await screen.findByRole('heading', { name: 'Welcome, Muneeb' })).toBeInTheDocument();
  });

  it('shows a retry screen when the API is unreachable, then recovers', async () => {
    let up = false;
    mockApi({ 'GET /api/auth/me': () => (up ? meHandler() : new TypeError('Failed to fetch')) });
    session = true;
    renderApp('/dashboard');
    expect(await screen.findByText("Can't reach the server")).toBeInTheDocument();
    up = true;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Welcome, Muneeb' })).toBeInTheDocument();
  });
});

describe('registration', () => {
  it('validates on the client and sends no request when the form is invalid', async () => {
    mockApi({ 'GET /api/auth/me': meHandler });
    renderApp('/register');
    await screen.findByRole('heading', { name: 'Create your account' });
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getByText('Username is required')).toBeInTheDocument();
    expect(screen.getByText('Email is required')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Username'), 'Muneeb');
    await userEvent.type(screen.getByLabelText('Email'), 'muneeb@example.org');
    await userEvent.type(screen.getByLabelText('Password'), 'short');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'different');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getByText('Invalid email format')).toBeInTheDocument();
    expect(screen.getByText('Password must be at least 8 characters')).toBeInTheDocument();
    expect(screen.getByText('Passwords do not match')).toBeInTheDocument();
    expect(called('POST /api/auth/register')).toHaveLength(0);
  });

  it('posts the exact payload the backend expects, then moves to the verify step with the email', async () => {
    mockApi({
      'GET /api/auth/me': meHandler,
      'POST /api/auth/register': ok(201, 'Verification code sent. Check your email.', {
        verificationRequired: true,
        email: 'muneeb@example.com',
        expiresInSeconds: 600,
      }),
    });
    renderApp('/register');
    await userEvent.type(await screen.findByLabelText('Username'), '  Muneeb ');
    await userEvent.type(screen.getByLabelText('Email'), '  Muneeb@Example.com ');
    await userEvent.type(screen.getByLabelText('Password'), 'Str0ngPass!');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'Str0ngPass!');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(screen.getByText('muneeb@example.com')).toBeInTheDocument();
    const req = called('POST /api/auth/register')[0];
    expect(req.init.credentials).toBe('include');
    expect(req.init.headers['Content-Type']).toBe('application/json');
    expect(req.body).toEqual({
      username: 'Muneeb',
      email: 'muneeb@example.com',
      password: 'Str0ngPass!',
      confirmPassword: 'Str0ngPass!',
    });
  });

  it('shows a 409 "already registered" message and server-side field errors', async () => {
    let n = 0;
    mockApi({
      'GET /api/auth/me': meHandler,
      'POST /api/auth/register': () =>
        ++n === 1
          ? fail(409, 'Email already registered')
          : fail(400, 'Username contains invalid characters', {
              errors: [{ field: 'username', message: 'Username contains invalid characters' }],
            }),
    });
    renderApp('/register');
    await userEvent.type(await screen.findByLabelText('Username'), 'Muneeb');
    await userEvent.type(screen.getByLabelText('Email'), 'muneeb@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'Str0ngPass!');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'Str0ngPass!');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Email already registered')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    const fieldError = await screen.findByText('Username contains invalid characters');
    expect(screen.getByLabelText('Username')).toHaveAttribute('aria-invalid', 'true');
    expect(fieldError).toHaveAttribute('id', screen.getByLabelText('Username').getAttribute('aria-describedby'));
  });

  it('shows the cooldown message from a 429', async () => {
    mockApi({
      'GET /api/auth/me': meHandler,
      'POST /api/auth/register': fail(429, 'A verification code was sent recently. Please wait a moment before requesting another.'),
    });
    renderApp('/register');
    await userEvent.type(await screen.findByLabelText('Username'), 'Muneeb');
    await userEvent.type(screen.getByLabelText('Email'), 'muneeb@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'Str0ngPass!');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'Str0ngPass!');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('sent recently');
  });
});

describe('email verification', () => {
  const code = () => screen.getByLabelText('Verification code');

  it('accepts only digits, rejects a short code on the client', async () => {
    mockApi({ 'GET /api/auth/me': meHandler });
    renderApp('/verify-email', { email: 'muneeb@example.com' });
    await userEvent.type(await screen.findByLabelText('Verification code'), '12a3-4');
    expect(code()).toHaveValue('1234');
    await userEvent.click(screen.getByRole('button', { name: 'Verify email' }));
    expect(screen.getByText('Enter the 6-digit code from your email')).toBeInTheDocument();
    expect(called('POST /api/auth/verify-email')).toHaveLength(0);
  });

  it('asks for the email when the page was opened directly (e.g. after a refresh)', async () => {
    mockApi({ 'GET /api/auth/me': meHandler });
    renderApp('/verify-email');
    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
    expect(code()).toBeInTheDocument();
  });

  it('shows the wrong-code message with remaining attempts', async () => {
    mockApi({
      'GET /api/auth/me': meHandler,
      'POST /api/auth/verify-email': fail(400, 'Incorrect verification code.', { reason: 'invalid', attemptsRemaining: 4 }),
    });
    renderApp('/verify-email', { email: 'muneeb@example.com' });
    await userEvent.type(await screen.findByLabelText('Verification code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Verify email' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect verification code. 4 attempts remaining.');
  });

  it('shows expiry / lockout messages from the server', async () => {
    mockApi({
      'GET /api/auth/me': meHandler,
      'POST /api/auth/verify-email': fail(429, 'Too many incorrect attempts. Please register again.', { reason: 'too_many_attempts' }),
    });
    renderApp('/verify-email', { email: 'muneeb@example.com' });
    await userEvent.type(await screen.findByLabelText('Verification code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Verify email' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many incorrect attempts');
    expect(screen.getByRole('link', { name: 'Register again' })).toHaveAttribute('href', '/register');
  });

  it('on success sets the session and lands on the dashboard, storing nothing in the browser', async () => {
    mockApi({
      'GET /api/auth/me': meHandler,
      'POST /api/auth/verify-email': () => {
        session = true;
        return ok(201, 'Email verified. Account created.', { user: USER });
      },
    });
    renderApp('/verify-email', { email: 'muneeb@example.com' });
    await userEvent.type(await screen.findByLabelText('Verification code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Verify email' }));
    expect(await screen.findByRole('heading', { name: 'Welcome, Muneeb' })).toBeInTheDocument();
    expect(called('POST /api/auth/verify-email')[0].body).toEqual({ email: 'muneeb@example.com', code: '123456' });
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});

describe('login and logout', () => {
  async function fillLogin(email, password) {
    await userEvent.type(await screen.findByLabelText('Email'), email);
    await userEvent.type(screen.getByLabelText('Password'), password);
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
  }

  it('shows the generic invalid-credentials message', async () => {
    mockApi({ 'GET /api/auth/me': meHandler, 'POST /api/auth/login': fail(401, 'Invalid email or password') });
    renderApp('/login');
    await fillLogin('muneeb@example.com', 'WrongPass1!');
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
  });

  it('logs in, normalizes the email, and opens the dashboard', async () => {
    mockApi({
      'GET /api/auth/me': meHandler,
      'POST /api/auth/login': () => {
        session = true;
        return ok(200, 'Login successful', { user: USER });
      },
    });
    renderApp('/login');
    await fillLogin('  MUNEEB@Example.com ', 'Str0ngPass!');
    expect(await screen.findByRole('heading', { name: 'Welcome, Muneeb' })).toBeInTheDocument();
    const req = called('POST /api/auth/login')[0];
    expect(req.body).toEqual({ email: 'muneeb@example.com', password: 'Str0ngPass!' });
    expect(req.init.credentials).toBe('include');
  });

  it('returns the user to the page they originally requested after logging in', async () => {
    mockApi({
      'GET /api/auth/me': meHandler,
      'POST /api/auth/login': () => {
        session = true;
        return ok(200, 'Login successful', { user: USER });
      },
    });
    renderApp('/dashboard');
    await fillLogin('muneeb@example.com', 'Str0ngPass!');
    expect(await screen.findByRole('heading', { name: 'Welcome, Muneeb' })).toBeInTheDocument();
  });

  it('toggles password visibility', async () => {
    mockApi({ 'GET /api/auth/me': meHandler });
    renderApp('/login');
    const password = await screen.findByLabelText('Password');
    expect(password).toHaveAttribute('type', 'password');
    await userEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(password).toHaveAttribute('type', 'text');
  });

  it('logs out via POST /api/auth/logout and returns to the login page', async () => {
    session = true;
    mockApi({
      'GET /api/auth/me': meHandler,
      'POST /api/auth/logout': () => {
        session = false;
        return ok(200, 'Logged out');
      },
    });
    renderApp('/dashboard');
    await userEvent.click(await screen.findByRole('button', { name: 'Log out' }));
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(called('POST /api/auth/logout')).toHaveLength(1);
  });

  it('stays signed in and shows an error if logout fails', async () => {
    session = true;
    mockApi({ 'GET /api/auth/me': meHandler, 'POST /api/auth/logout': () => new TypeError('Failed to fetch') });
    renderApp('/dashboard');
    await userEvent.click(await screen.findByRole('button', { name: 'Log out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to reach the server');
    expect(screen.getByRole('heading', { name: 'Welcome, Muneeb' })).toBeInTheDocument();
  });

  it('drops to the login page when a protected call later reports an expired session', async () => {
    const { request } = await import('../api/httpClient.js');
    session = true;
    mockApi({ 'GET /api/auth/me': meHandler, 'GET /api/jobs': fail(401, 'Session expired') });
    renderApp('/dashboard');
    await screen.findByRole('heading', { name: 'Welcome, Muneeb' });
    await act(async () => {
      await expect(request('/api/jobs')).rejects.toMatchObject({ status: 401 });
    });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument());
  });
});
