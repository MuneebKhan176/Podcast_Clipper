'use strict';

const authService = require('../services/authService');
const { sendSuccess } = require('../utils/response');
const { setAuthCookie, clearAuthCookie } = require('../utils/tokens');

async function register(req, res) {
  const { email, expiresInSeconds } = await authService.register(req.body);
  return sendSuccess(res, 201, 'Verification code sent. Check your email.', {
    verificationRequired: true,
    email,
    expiresInSeconds,
  });
}

async function verifyEmail(req, res) {
  const { user, token } = await authService.verifyEmail(req.body);
  setAuthCookie(res, token);
  return sendSuccess(res, 201, 'Email verified. Account created.', { user });
}

async function login(req, res) {
  const { user, token } = await authService.login(req.body);
  setAuthCookie(res, token);
  return sendSuccess(res, 200, 'Login successful', { user });
}

async function me(req, res) {
  const user = await authService.getCurrentUser(req.user.id); // id comes from the verified JWT only
  return sendSuccess(res, 200, 'Current user', { user });
}

async function logout(req, res) {
  clearAuthCookie(res);
  return sendSuccess(res, 200, 'Logged out');
}

module.exports = { register, verifyEmail, login, me, logout };
