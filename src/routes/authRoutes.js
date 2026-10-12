'use strict';

const express = require('express');
const controller = require('../controllers/authController');
const { authenticate } = require('../middleware/authenticate');
const { validate } = require('../middleware/validate');
const { registerLimiter, verifyEmailLimiter, loginLimiter } = require('../middleware/rateLimiters');
const { registerSchema, verifyEmailSchema, loginSchema } = require('../validators/authValidators');

const router = express.Router();

// Limiter runs before validation so malformed requests are counted too.
router.post('/register', registerLimiter, validate(registerSchema), controller.register);
router.post('/verify-email', verifyEmailLimiter, validate(verifyEmailSchema), controller.verifyEmail);
router.post('/login', loginLimiter, validate(loginSchema), controller.login);
router.get('/me', authenticate, controller.me);
router.post('/logout', controller.logout);

module.exports = router;
