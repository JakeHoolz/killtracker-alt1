const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { get, run, migrate } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-prod';

const router = express.Router();
router.use(express.json());

migrate().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to run migrations', err);
});

async function findUserByUsername(username) {
  return get('SELECT * FROM users WHERE username = $1', [username]);
}

function createToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, {
    expiresIn: '7d',
  });
}

async function upsertStats(userId, data) {
  const json = JSON.stringify(data || {});
  await run(
    `INSERT INTO stats (user_id, data, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT(user_id)
     DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [userId, json]
  );
}

async function getStats(userId) {
  const row = await get('SELECT data FROM stats WHERE user_id = $1', [userId]);
  if (!row) return {};
  if (row.data && typeof row.data === 'object') return row.data;
  try {
    const parsed = JSON.parse(row.data);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
}

function authMiddleware(req, res, next) {
  const header = req.get('authorization') || '';
  const [, token] = header.split(' ');
  if (!token) return res.status(401).json({ error: 'Missing token' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.id, username: payload.username };
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

router.post('/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const existing = await findUserByUsername(username);
  if (existing) {
    return res.status(409).json({ error: 'User already exists' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const result = await run(
    'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id',
    [username, passwordHash]
  );

  const user = { id: result.rows[0].id, username };
  const token = createToken(user);
  return res.status(201).json({ token, user });
});

router.post('/users/:username/register', async (req, res) => {
  const { username } = req.params;
  const { password, username: bodyUsername } = req.body || {};

  if (!password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  if (bodyUsername && bodyUsername !== username) {
    return res.status(400).json({ error: 'Username mismatch' });
  }

  const existing = await findUserByUsername(username);
  if (existing) {
    return res.status(409).json({ error: 'User already exists' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const result = await run(
    'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id',
    [username, passwordHash]
  );

  const user = { id: result.rows[0].id, username };
  const token = createToken(user);
  return res.status(201).json({ token, user });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const user = await findUserByUsername(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  const token = createToken(user);
  return res.json({ token, user: { id: user.id, username: user.username } });
});

router.post('/users/:username/login', async (req, res) => {
  const { username } = req.params;
  const { password, username: bodyUsername } = req.body || {};

  if (!password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  if (bodyUsername && bodyUsername !== username) {
    return res.status(400).json({ error: 'Username mismatch' });
  }

  const user = await findUserByUsername(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  const token = createToken(user);
  return res.json({ token, user: { id: user.id, username: user.username } });
});

router.get('/stats', authMiddleware, async (req, res) => {
  const data = await getStats(req.user.id);
  return res.json({ data });
});

router.put('/stats', authMiddleware, async (req, res) => {
  const { data } = req.body || {};
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Missing stats payload' });
  }

  await upsertStats(req.user.id, data);
  return res.json({ ok: true });
});

router.get('/users/:username/stats', authMiddleware, async (req, res) => {
  const { username } = req.params;
  if (username !== req.user.username) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const user = await findUserByUsername(username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const data = await getStats(user.id);
  return res.json({ data });
});

router.put('/users/:username/stats', authMiddleware, async (req, res) => {
  const { username } = req.params;
  const { data } = req.body || {};

  if (username !== req.user.username) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Missing stats payload' });
  }

  const user = await findUserByUsername(username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  await upsertStats(user.id, data);
  return res.json({ ok: true });
});

module.exports = router;
