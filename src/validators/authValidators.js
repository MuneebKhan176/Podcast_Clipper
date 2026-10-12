'use strict';

const { z } = require('zod');

// Same rule the cordEX reference used (only .com addresses). Kept in ONE place so it is
// easy to relax later.
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.com$/;

const text = (label) => z.string({ error: `${label} is required` });

// Trim + lowercase so "User@Example.com " and "user@example.com" are the same account.
const normalizedEmail = text('Email')
  .trim()
  .toLowerCase()
  .min(1, 'Email is required')
  .max(254, 'Email is too long')
  .regex(EMAIL_REGEX, 'Invalid email format');

// Passwords are never trimmed. bcrypt only uses the first 72 bytes, so longer ones are refused.
const newPassword = text('Password')
  .min(8, 'Password must be at least 8 characters')
  .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'Password must be at most 72 bytes');

const registerSchema = z.object({
    username: text('Username')
      .trim()
      .min(2, 'Username must be at least 2 characters')
      .max(50, 'Username must be at most 50 characters')
      .regex(/^[^\u0000-\u001F\u007F]+$/, 'Username contains invalid characters'),
    email: normalizedEmail,
    password: newPassword,
    confirmPassword: text('Confirm password'),
  })
  .refine((d) => d.password === d.confirmPassword, {
    path: ['confirmPassword'],
    error: 'Passwords do not match',
  });

const verifyEmailSchema = z.object({
  email: normalizedEmail,
  code: text('Verification code').trim().regex(/^\d{6}$/, 'Verification code must be 6 digits'),
});

const loginSchema = z.object({
  email: text('Email').trim().toLowerCase().min(1, 'Email is required').max(254, 'Invalid email or password'),
  password: text('Password').min(1, 'Password is required').max(200, 'Invalid email or password'),
});

module.exports = { registerSchema, verifyEmailSchema, loginSchema, EMAIL_REGEX };
