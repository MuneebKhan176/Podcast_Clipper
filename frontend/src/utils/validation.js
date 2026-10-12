// Client-side checks mirror the backend rules (src/validators/authValidators.js) so users get instant
// feedback. The backend remains the authority and its field errors are shown too.

// Same rule as the backend: .com addresses only. Keep in sync with EMAIL_REGEX there.
export const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.com$/;

export const normalizeEmail = (value) => value.trim().toLowerCase();

const byteLength = (s) => new TextEncoder().encode(s).length;

export function validateRegister({ username, email, password, confirmPassword }) {
  const errors = {};
  const name = username.trim();
  if (!name) errors.username = 'Username is required';
  else if (name.length < 2) errors.username = 'Username must be at least 2 characters';
  else if (name.length > 50) errors.username = 'Username must be at most 50 characters';

  if (!email.trim()) errors.email = 'Email is required';
  else if (!EMAIL_REGEX.test(normalizeEmail(email))) errors.email = 'Invalid email format';

  if (!password) errors.password = 'Password is required';
  else if (password.length < 8) errors.password = 'Password must be at least 8 characters';
  else if (byteLength(password) > 72) errors.password = 'Password must be at most 72 bytes';

  if (!confirmPassword) errors.confirmPassword = 'Please confirm your password';
  else if (password !== confirmPassword) errors.confirmPassword = 'Passwords do not match';
  return errors;
}

export function validateLogin({ email, password }) {
  const errors = {};
  if (!email.trim()) errors.email = 'Email is required';
  if (!password) errors.password = 'Password is required';
  return errors;
}

export function validateVerify({ email, code }) {
  const errors = {};
  if (!email.trim()) errors.email = 'Email is required';
  else if (!EMAIL_REGEX.test(normalizeEmail(email))) errors.email = 'Invalid email format';
  if (!/^\d{6}$/.test(code)) errors.code = 'Enter the 6-digit code from your email';
  return errors;
}
