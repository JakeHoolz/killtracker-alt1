const { db, ensureTablesPromise, bossNames } = require('../db');

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;

  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  const username = (req.query.username || '').trim().toLowerCase();
  if (!username) {
    res.statusCode = 400;
    res.json({ message: 'Username is required' });
    return;
  }

  try {
    await ensureTablesPromise;
  } catch (err) {
    console.error('Database initialization failed', err);
    res.statusCode = 500;
    res.json({ message: 'Database initialization failed' });
    return;
  }

  if (req.method === 'GET') {
    try {
      const { rows } = await db.query('SELECT data FROM player_stats WHERE username = $1', [username]);
      if (!rows.length) {
        const defaultBosses = bossNames.reduce((acc, name) => {
          acc[name] = { kc: 0, pets: 0, uniques: [] };
          return acc;
        }, {});

        const defaultData = { bosses: defaultBosses };
        await db.query(
          'INSERT INTO player_stats (username, data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (username) DO NOTHING',
          [username, defaultData]
        );

        const bossInserts = bossNames.map((name) =>
          db.query(
            `INSERT INTO player_boss_stats (username, boss_name, data, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (username, boss_name)
             DO NOTHING`,
            [username, name, defaultBosses[name]]
          )
        );
        await Promise.all(bossInserts);

        res.json({ data: defaultData, created: true });
        return;
      }

      res.json({ data: rows[0].data });
    } catch (err) {
      console.error('Failed to fetch stats', err);
      res.statusCode = 500;
      res.json({ message: 'Failed to fetch stats' });
    }
    return;
  }

  if (req.method === 'POST') {
    let payload;
    try {
      const body = await readJsonBody(req);
      payload = body?.data;
    } catch (err) {
      res.statusCode = 400;
      res.json({ message: 'Invalid JSON payload' });
      return;
    }

    if (!payload || typeof payload !== 'object') {
      res.statusCode = 400;
      res.json({ message: 'Invalid stats payload' });
      return;
    }

    try {
      await db.query(
        `INSERT INTO player_stats (username, data, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (username)
         DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
        [username, payload]
      );

      const bosses = payload.bosses && typeof payload.bosses === 'object' ? payload.bosses : {};
      const bossUpserts = Object.entries(bosses).map(([boss, data]) => {
        const safeData = typeof data === 'object' && data !== null ? data : {};
        return db.query(
          `INSERT INTO boss_definitions (boss_name) VALUES ($1) ON CONFLICT DO NOTHING`,
          [boss]
        ).then(() =>
          db.query(
            `INSERT INTO player_boss_stats (username, boss_name, data, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (username, boss_name)
             DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
            [username, boss, safeData]
          )
        );
      });

      if (bossUpserts.length) {
        await Promise.all(bossUpserts);
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('Failed to persist stats', err);
      res.statusCode = 500;
      res.json({ message: 'Failed to persist stats' });
    }
    return;
  }

  res.setHeader('Allow', 'GET,POST');
  res.statusCode = 405;
  res.json({ message: 'Method not allowed' });
};
