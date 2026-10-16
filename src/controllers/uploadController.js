'use strict';

const uploadService = require('../services/uploadService');
const { sendSuccess } = require('../utils/response');

async function initiate(req, res) {
  const { upload, created } = await uploadService.initiate(req.user.id, req.body);
  const message = created
    ? 'Upload started'
    : upload.status === 'completed'
      ? 'This file was already uploaded'
      : 'Resuming existing upload';
  return sendSuccess(res, created ? 201 : 200, message, { upload, resumed: !created });
}

async function list(req, res) {
  const uploads = await uploadService.listUploads(req.user.id);
  return sendSuccess(res, 200, 'Uploads', { uploads });
}

async function get(req, res) {
  const upload = await uploadService.getUpload(req.user.id, req.params.id);
  return sendSuccess(res, 200, 'Upload', { upload });
}

async function signParts(req, res) {
  const data = await uploadService.signParts(req.user.id, req.params.id, req.body.partNumbers);
  return sendSuccess(res, 200, 'Upload URLs ready', data);
}

async function complete(req, res) {
  const upload = await uploadService.complete(req.user.id, req.params.id);
  return sendSuccess(res, 200, 'Upload complete', { upload });
}

async function abort(req, res) {
  const upload = await uploadService.abort(req.user.id, req.params.id);
  return sendSuccess(res, 200, 'Upload cancelled', { upload });
}

module.exports = { initiate, list, get, signParts, complete, abort };
