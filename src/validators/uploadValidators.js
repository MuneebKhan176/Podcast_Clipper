'use strict';

const { z } = require('zod');
const config = require('../config/env');

const EXTENSION_TO_MIME = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  mpeg: 'video/mpeg',
  mpg: 'video/mpeg',
};

const extensionOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
const text = (label) => z.string({ error: `${label} is required` });

const initiateSchema = z
  .object({
    filename: text('Filename')
      .trim()
      .min(1, 'Filename is required')
      .max(255, 'Filename is too long')
      .regex(/^[^\u0000-\u001F\u007F]+$/, 'Filename contains invalid characters'),
    size: z
      .number({ error: 'File size is required' })
      .int('File size must be a whole number of bytes')
      .positive('File is empty')
      .max(config.upload.maxBytes, `File is too large (limit ${config.upload.maxBytes} bytes)`),
    contentType: z.string().trim().max(100, 'Content type is too long').optional(),
    fingerprint: text('Fingerprint').regex(/^[0-9a-f]{64}$/, 'Fingerprint must be 64 hex characters'),
  })
  .superRefine((data, ctx) => {
    const ext = extensionOf(data.filename);
    if (!EXTENSION_TO_MIME[ext]) {
      ctx.addIssue({
        code: 'custom',
        path: ['filename'],
        message: `Unsupported file type. Allowed: ${Object.keys(EXTENSION_TO_MIME).join(', ')}`,
      });
    }
    const type = (data.contentType || '').toLowerCase();
    if (type && type !== 'application/octet-stream' && !type.startsWith('video/')) {
      ctx.addIssue({ code: 'custom', path: ['contentType'], message: 'Only video files can be uploaded' });
    }
  })
  .transform((data) => {
    const type = (data.contentType || '').toLowerCase();
    const useBrowserType = type.startsWith('video/');
    return {
      filename: data.filename,
      size: data.size,
      fingerprint: data.fingerprint,
      contentType: useBrowserType ? type : EXTENSION_TO_MIME[extensionOf(data.filename)],
    };
  });

const signPartsSchema = z.object({
  partNumbers: z
    .array(z.number({ error: 'Part numbers must be numbers' }).int().min(1, 'Part numbers start at 1'), {
      error: 'partNumbers is required',
    })
    .min(1, 'Request at least one part')
    .max(50, 'At most 50 parts per request')
    .refine((a) => new Set(a).size === a.length, 'Part numbers must be unique'),
});

module.exports = { initiateSchema, signPartsSchema, EXTENSION_TO_MIME };
