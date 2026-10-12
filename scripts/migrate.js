'use strict';

const fs = require('fs');
const path = require('path');
const { pool, withTransaction } = require('../src/config/db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

/** Applies every unapplied *.sql file in order, each in its own transaction. */
async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  const ran = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    ran.push(file);
  }
  return ran;
}

module.exports = { runMigrations };

if (require.main === module) {
  runMigrations()
    .then((ran) => {
      console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database is up to date.');
      return pool.end();
    })
    .catch(async (err) => {
      console.error('Migration failed:', err.message);
      await pool.end().catch(() => {});
      process.exit(1);
    });
}
