'use strict';

const app = require('./app');
const config = require('./config/env');
const { pool } = require('./config/db');
const pendingUserRepository = require('./repositories/pendingUserRepository');
const uploadService = require('./services/uploadService');

const server = app.listen(config.port, () => {
  console.log(`API listening on port ${config.port} (${config.nodeEnv})`);
});

// Housekeeping every 15 minutes: drop expired pending registrations and abandoned upload sessions.
const cleanupTimer = setInterval(async () => {
  try {
    const removed = await pendingUserRepository.deleteExpired();
    if (removed > 0) console.log(`Removed ${removed} expired pending registration(s)`);
  } catch (err) {
    console.error('Pending-user cleanup failed:', err.message);
  }
  try {
    const expired = await uploadService.expireStaleUploads();
    if (expired > 0) console.log(`Expired ${expired} abandoned upload session(s)`);
  } catch (err) {
    console.error('Upload cleanup failed:', err.message);
  }
}, 15 * 60 * 1000);
cleanupTimer.unref();

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  clearInterval(cleanupTimer);
  server.close(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
