'use strict';

const { AppError } = require('../utils/errors');
const { verifyAuthToken } = require('../utils/tokens');

function extractToken(req) {
  const cookieToken = req.cookies?.token;
  if (typeof cookieToken === 'string' && cookieToken) return cookieToken;

  const header = req.headers.authorization;
  if (typeof header === 'string') {
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (match) return match[1];
  }
  return null;
}

/** Cookie first, `Authorization: Bearer` as fallback. Always answers with JSON, never a redirect. */
function authenticate(req, res, next) {
  const token = extractToken(req);
  if (!token) return next(new AppError(401, 'Authentication required'));

  try {
    req.user = verifyAuthToken(token); // { id, email, username, iat, exp }
    return next();
  } catch (err) {
    const message = err.name === 'TokenExpiredError' ? 'Session expired' : 'Invalid token';
    return next(new AppError(401, message));
  }
}

module.exports = { authenticate };
