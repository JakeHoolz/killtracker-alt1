const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
const pool = connectionString
  ? new Pool({ connectionString })
  : new Pool({
      host: process.env.PGHOST || 'localhost',
      port: Number(process.env.PGPORT) || 5432,
      database: process.env.PGDATABASE || 'alt1-tracker',
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
    });

async function query(sql, params = []) {
  return pool.query(sql, params);
}

async function run(sql, params = []) {
  return query(sql, params);
}

async function get(sql, params = []) {
  const result = await query(sql, params);
  return result.rows[0] || null;
}

async function all(sql, params = []) {
  const result = await query(sql, params);
  return result.rows;
}

async function migrate() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS stats (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

module.exports = {
  query,
  run,
  get,
  all,
  migrate,
};
