'use strict';

const { Pool } = require('pg');
const config = require('./env');

const pool = new Pool({
  connectionString: config.db.url,
  ssl: config.db.ssl ? { rejectUnauthorized: true } : false,
  max: config.db.poolMax,
});

// An error on an idle client must not crash the process.
pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client:', err.message);
});

/**
 * Runs `fn(client)` inside BEGIN/COMMIT on ONE dedicated connection.
 * Rolls back on any error and always releases the connection in `finally`.
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  let releaseError;
  
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('ROLLBACK failed:', rollbackErr.message);
      releaseError = rollbackErr; // tells the pool to discard this possibly-broken connection
    }
    throw err;
  } finally {
    client.release(releaseError);
  }
}

module.exports = { pool, withTransaction };
