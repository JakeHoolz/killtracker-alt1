const { Pool } = require('pg');

const db = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'alt1-tracker',
  user: process.env.DB_USER || 'nergly',
  password: process.env.DB_PASSWORD || '564300aA!',
});

const ensureTablePromise = db.query(`
  CREATE TABLE IF NOT EXISTS player_stats (
    username TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
`);

module.exports = {
  db,
  ensureTablePromise,
};
