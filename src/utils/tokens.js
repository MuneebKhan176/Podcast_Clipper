'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config/env');

const COOKIE_NAME = 'token';
const ALGORITHM = 'HS256';

function signAuthToken({ id, email, username }) {
  return jwt.sign({ id, email, username }, config.jwtSecret, {
    algorithm: ALGORITHM,
    expiresIn: config.session.seconds,
  });
}

/** Throws on a bad signature, wrong algorithm, malformed or expired token. */
function verifyAuthToken(token) {
  return jwt.verify(token, config.jwtSecret, { algorithms: [ALGORITHM] });
}

// Attributes must be identical when setting and clearing, or browsers keep the cookie.
function baseCookieOptions() {
  const options = {
    httpOnly: true,
    secure: config.cookie.secure,
    sameSite: config.cookie.sameSite,
    path: '/',
  };
  if (config.cookie.domain) options.domain = config.cookie.domain;
  return options;
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, { ...baseCookieOptions(), maxAge: config.session.ms });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, baseCookieOptions());
}

module.exports = { signAuthToken, verifyAuthToken, setAuthCookie, clearAuthCookie };
