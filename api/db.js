const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const db = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'alt1-tracker',
  user: process.env.DB_USER || 'nergly',
  password: process.env.DB_PASSWORD || '564300aA!',
});

function loadBossNames() {
  const source = path.join(process.cwd(), 'rs3-stats', 'boss_latest_kc.txt');
  try {
    const lines = fs
      .readFileSync(source, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));

    const names = new Set();
    for (const line of lines) {
      const [bossName] = line.split(':');
      if (bossName) names.add(bossName.trim());
    }

    return Array.from(names);
  } catch (err) {
    console.warn('Falling back to default boss list (rs3-stats/boss_latest_kc.txt missing)', err);
    return ['general graardor'];
  }
}

const bossNames = loadBossNames();

const ensureTablesPromise = (async () => {
  await db.query('CREATE TABLE IF NOT EXISTS player_stats (username TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW())');
  await db.query('CREATE TABLE IF NOT EXISTS boss_definitions (boss_name TEXT PRIMARY KEY)');
  await db.query(`
    CREATE TABLE IF NOT EXISTS player_boss_stats (
      username TEXT NOT NULL,
      boss_name TEXT NOT NULL,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (username, boss_name),
      FOREIGN KEY (username) REFERENCES player_stats(username) ON DELETE CASCADE,
      FOREIGN KEY (boss_name) REFERENCES boss_definitions(boss_name) ON DELETE CASCADE
    )
  `);

  const insertBosses = bossNames.map((boss) =>
    db.query('INSERT INTO boss_definitions (boss_name) VALUES ($1) ON CONFLICT DO NOTHING', [boss])
  );
  await Promise.all(insertBosses);
})();

module.exports = {
  db,
  ensureTablesPromise,
  bossNames,
};
