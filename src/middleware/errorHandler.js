'use strict';

const { AppError } = require('../utils/errors');
const { sendError } = require('../utils/response');

function notFound(req, res) {
  return sendError(res, 404, 'Route not found');
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err instanceof AppError) {
    return sendError(res, err.statusCode, err.message, err.data);
  }
  // Errors raised by express.json()
  if (err.type === 'entity.too.large') return sendError(res, 413, 'Request body too large');
  if (err.type === 'entity.parse.failed') return sendError(res, 400, 'Malformed JSON body');
  if (err.status >= 400 && err.status < 500) return sendError(res, err.status, 'Bad request');

  // Unexpected: log message/code/stack only (never request bodies), reply generically.
  console.error('Unhandled error:', { message: err.message, code: err.code, stack: err.stack });
  return sendError(res, 500, 'Internal server error');
}

module.exports = { notFound, errorHandler };
