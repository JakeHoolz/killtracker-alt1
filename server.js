const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 8080;
const ROOT_DIR = path.join(__dirname);

const db = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'alt1-tracker',
  user: process.env.DB_USER || 'nergly',
  password: process.env.DB_PASSWORD || '564300aA!',
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(ROOT_DIR, { extensions: ['html'] }));

app.use('/api', (req, res, next) => {
  const startTime = Date.now();
  // eslint-disable-next-line no-console
  console.log('[API Debug] Incoming request', {
    method: req.method,
    url: req.originalUrl,
    params: req.params,
    query: req.query,
    body: req.body,
  });

  res.on('finish', () => {
    const durationMs = Date.now() - startTime;
    // eslint-disable-next-line no-console
    console.log('[API Debug] Response sent', {
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      durationMs,
    });
  });

  next();
});

async function ensureTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS player_stats (
      username TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

app.get('/api/stats/:username', async (req, res) => {
  const username = req.params.username?.trim();
  if (!username) return res.status(400).json({ message: 'Username is required' });
  try {
    const { rows } = await db.query(
      'SELECT data FROM player_stats WHERE username = $1',
      [username.toLowerCase()]
    );
    if (!rows.length) return res.status(404).json({ message: 'No stats found' });
    return res.json({ data: rows[0].data });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Failed to fetch stats', err);
    return res.status(500).json({ message: 'Failed to fetch stats' });
  }
});

app.post('/api/stats/:username', async (req, res) => {
  const username = req.params.username?.trim();
  if (!username) return res.status(400).json({ message: 'Username is required' });

  const payload = req.body?.data;
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ message: 'Invalid stats payload' });
  }

  try {
    await db.query(
      `INSERT INTO player_stats (username, data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (username)
       DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
      [username.toLowerCase(), payload]
    );
    return res.json({ ok: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Failed to persist stats', err);
    return res.status(500).json({ message: 'Failed to persist stats' });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'index.html'));
});

ensureTable().then(() => {
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Kill Tracker available at http://localhost:${PORT}`);
  });
}).catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Database initialization failed', err);
  process.exit(1);
});
