'use strict';

/** An error that is safe to show to the client. */
class AppError extends Error {
  constructor(statusCode, message, data = null) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.data = data;
  }
}

module.exports = { AppError };
