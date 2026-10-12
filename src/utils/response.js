'use strict';

function sendSuccess(res, statusCode, message, data = null) {
  return res.status(statusCode).json({ success: true, message, data });
}

function sendError(res, statusCode, message, data = null) {
  return res.status(statusCode).json({ success: false, message, data });
}

module.exports = { sendSuccess, sendError };
