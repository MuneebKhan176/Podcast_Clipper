'use strict';

const { AppError } = require('../utils/errors');

/** Validates req.body against a zod schema and replaces it with the parsed (normalized) data. */
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      const errors = result.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'body',
        message: issue.message,
      }));
      return next(new AppError(400, errors[0].message, { errors }));
    }
    req.body = result.data;
    return next();
  };
}

module.exports = { validate };
