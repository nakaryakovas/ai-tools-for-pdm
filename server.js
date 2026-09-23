const http = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SLOT_TIMES = ['09:00', '11:00', '13:00', '15:00', '17:00'];
const TIME_ZONE = 'Europe/Moscow';

const db = new Database(path.join(__dirname, 'boris.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS walk_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    walk_date TEXT NOT NULL,
    slot_time TEXT NOT NULL,
    booked_by TEXT,
    booked_at TEXT,
    UNIQUE (walk_date, slot_time),
    CHECK (
      (booked_by IS NULL AND booked_at IS NULL)
      OR
      (booked_by IS NOT NULL AND booked_at IS NOT NULL)
    )
  );
  CREATE TABLE IF NOT EXISTS feedings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_name TEXT NOT NULL,
    fed_at TEXT NOT NULL
  );
`);

function currentWalkDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function moscowNowIso() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}+03:00`;
}

function ensureSlots(walkDate) {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO walk_slots (walk_date, slot_time) VALUES (?, ?)'
  );
  for (const slotTime of SLOT_TIMES) {
    insert.run(walkDate, slotTime);
  }
}

function getState() {
  const walkDate = currentWalkDate();
  ensureSlots(walkDate);
  const slots = db
    .prepare(
      'SELECT slot_time, booked_by FROM walk_slots WHERE walk_date = ? ORDER BY slot_time'
    )
    .all(walkDate);
  const lastFeeding = db
    .prepare(
      'SELECT employee_name, fed_at FROM feedings ORDER BY id DESC LIMIT 1'
    )
    .get();
  return { walkDate, slots, lastFeeding: lastFeeding || null };
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

class BodyTooLargeError extends Error {
  constructor() {
    super('Слишком большой запрос');
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e5) {
        req.removeAllListeners('data');
        req.resume();
        reject(new BodyTooLargeError());
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function badRequest(err) {
  if (err instanceof BodyTooLargeError) {
    return { status: 413, message: err.message };
  }
  return { status: 400, message: 'Некорректный запрос' };
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/state') {
    return json(res, 200, getState());
  }

  if (req.method === 'POST' && pathname === '/api/book') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      const bad = badRequest(err);
      return json(res, bad.status, { error: bad.message });
    }
    const name = String(payload.name || '').trim();
    const slotTime = String(payload.slotTime || '');
    if (!name) {
      return json(res, 400, { error: 'Введите ФИО' });
    }
    if (!SLOT_TIMES.includes(slotTime)) {
      return json(res, 400, { error: 'Неизвестный слот прогулки' });
    }
    const walkDate = currentWalkDate();
    ensureSlots(walkDate);
    // Одна атомарная операция: меняем только свободный слот.
    const result = db
      .prepare(
        `UPDATE walk_slots
         SET booked_by = ?, booked_at = ?
         WHERE walk_date = ? AND slot_time = ? AND booked_by IS NULL`
      )
      .run(name, new Date().toISOString(), walkDate, slotTime);
    if (result.changes === 0) {
      const existing = db
        .prepare(
          'SELECT booked_by FROM walk_slots WHERE walk_date = ? AND slot_time = ?'
        )
        .get(walkDate, slotTime);
      return json(res, 409, {
        error: `Слот ${slotTime} уже занят (${existing ? existing.booked_by : '—'})`,
        state: getState(),
      });
    }
    return json(res, 200, { ok: true, state: getState() });
  }

  if (req.method === 'POST' && pathname === '/api/feed') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      const bad = badRequest(err);
      return json(res, bad.status, { error: bad.message });
    }
    const name = String(payload.name || '').trim();
    if (!name) {
      return json(res, 400, { error: 'Введите ФИО' });
    }
    const fedAt = moscowNowIso();
    db.prepare('INSERT INTO feedings (employee_name, fed_at) VALUES (?, ?)').run(
      name,
      fedAt
    );
    return json(res, 200, { ok: true, state: getState() });
  }

  return json(res, 404, { error: 'Маршрут не найден' });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
    } else {
      await serveStatic(res, pathname);
    }
  } catch (err) {
    console.error(err);
    json(res, 500, { error: 'Внутренняя ошибка сервера' });
  }
});

server.listen(PORT, () => {
  console.log(`Борис ждёт: http://localhost:${PORT}`);
});
