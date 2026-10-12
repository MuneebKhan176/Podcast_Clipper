'use strict';

const { rateLimit } = require('express-rate-limit');
const config = require('../config/env');
const { sendError } = require('../utils/response');

function createLimiter({ windowMs, max, message, skipSuccessfulRequests = false }) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests,
    handler: (req, res) => sendError(res, 429, message),
  });
}

const { windowMs, registerMax, verifyMax, loginMax } = config.rateLimit;

const registerLimiter = createLimiter({
  windowMs,
  max: registerMax,
  message: 'Too many registration attempts. Please try again later.',
});

const verifyEmailLimiter = createLimiter({
  windowMs,
  max: verifyMax,
  message: 'Too many verification attempts. Please try again later.',
});

// Only failed logins count, so normal use is never throttled.
const loginLimiter = createLimiter({
  windowMs,
  max: loginMax,
  message: 'Too many login attempts. Please try again later.',
  skipSuccessfulRequests: true,
});

module.exports = { createLimiter, registerLimiter, verifyEmailLimiter, loginLimiter };
