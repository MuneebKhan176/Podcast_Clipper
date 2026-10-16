'use strict';

const express = require('express');
const controller = require('../controllers/uploadController');
const { authenticate } = require('../middleware/authenticate');
const { validate } = require('../middleware/validate');
const { uploadLimiter } = require('../middleware/rateLimiters');
const { initiateSchema, signPartsSchema } = require('../validators/uploadValidators');
const { AppError } = require('../utils/errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const router = express.Router();

// A malformed id is simply "not found" (and never reaches the database as an invalid uuid).
router.param('id', (req, res, next, id) =>
  UUID_RE.test(id) ? next() : next(new AppError(404, 'Upload not found'))
);

router.use(authenticate, uploadLimiter);

router.get('/', controller.list);
router.post('/', validate(initiateSchema), controller.initiate);
router.get('/:id', controller.get);
router.post('/:id/parts/sign', validate(signPartsSchema), controller.signParts);
router.post('/:id/complete', controller.complete);
router.post('/:id/abort', controller.abort);

module.exports = router;
