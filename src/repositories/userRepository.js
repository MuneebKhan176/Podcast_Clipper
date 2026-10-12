'use strict';

const { pool } = require('../config/db');

function toUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
  };
}

async function findByEmail(email, executor = pool) {
  const { rows } = await executor.query(
    'SELECT id, username, email, password_hash, created_at FROM users WHERE email = $1',
    [email]
  );
  return toUser(rows[0]);
}

async function findById(id, executor = pool) {
  const { rows } = await executor.query(
    'SELECT id, username, email, password_hash, created_at FROM users WHERE id = $1',
    [id]
  );
  return toUser(rows[0]);
}

/** Pass the transaction client as `executor` when called inside a transaction. */
async function create({ username, email, passwordHash }, executor = pool) {
  const { rows } = await executor.query(
    `INSERT INTO users (username, email, password_hash)
     VALUES ($1, $2, $3)
     RETURNING id, username, email, password_hash, created_at`,
    [username, email, passwordHash]
  );
  return toUser(rows[0]);
}

module.exports = { findByEmail, findById, create };
