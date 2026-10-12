'use strict';

const config = require('../config/env');
const { AppError } = require('../utils/errors');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for cookie auth, layered on top of SameSite cookies:
 *  1. State-changing requests that carry an Origin header must come from the frontend origin.
 *     Browsers always attach Origin to cross-site POSTs, so a hostile page cannot pass this.
 *  2. Requests with a body must be application/json, which a plain cross-site <form> cannot send.
 * Requests without an Origin header come from non-browser clients (curl, tests, servers); a
 * CSRF attack needs the victim's browser, so they cannot be CSRF.
 */
function requestGuard(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.headers.origin;
  if (origin && origin !== config.frontendOrigin) {
    return next(new AppError(403, 'Origin not allowed'));
  }

  const hasBody = Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding'];
  if (hasBody && !req.is('application/json')) {
    return next(new AppError(415, 'Content-Type must be application/json'));
  }
  return next();
}

module.exports = { requestGuard };
