const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const Database = require('better-sqlite3');
const { parseBusyBlocksFromIcs } = require('./lib/parseBusy');
const { buildRedactedIcs } = require('./lib/redactedFeed');
const { pullBusyBlocksFromIcloud } = require('./lib/icloudPull');
const { encryptSecret } = require('./lib/credentialCrypto');
const { ensureIcloudSchema } = require('./lib/icloudSyncDb');
const { createIcloudSync } = require('./lib/icloudWorker');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'calendarshare.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    manage_key TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS busy_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    share_id INTEGER NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    all_day INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_busy_share ON busy_blocks(share_id);
`);
ensureIcloudSchema(db);

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function publicBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const host = req.get('x-forwarded-host') || req.get('host');
  const proto = req.get('x-forwarded-proto') || req.protocol;
  return `${proto}://${host}`;
}

function replaceBlocks(shareId, blocks) {
  const del = db.prepare('DELETE FROM busy_blocks WHERE share_id = ?');
  const ins = db.prepare(
    'INSERT INTO busy_blocks (share_id, start_ms, end_ms, all_day) VALUES (?,?,?,?)',
  );
  const run = db.transaction(() => {
    del.run(shareId);
    for (const b of blocks) {
      ins.run(shareId, b.startMs, b.endMs, b.allDay ? 1 : 0);
    }
  });
  run();
}

const { syncShare, syncAllShares } = createIcloudSync({ db, replaceBlocks });

function parseCalendarNames(body) {
  const raw = body && body.calendarNames;
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) return raw.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof raw === 'string') {
    return raw
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

app.post('/api/shares/icloud', async (req, res) => {
  try {
    const appleId = req.body?.appleId;
    const appPassword = req.body?.appPassword;
    const manageKeyRaw = req.body?.manageKey;

    if (!appleId || typeof appleId !== 'string' || !appleId.trim()) {
      return res.status(400).json({ error: 'Apple ID (email) is required.' });
    }
    if (!appPassword || typeof appPassword !== 'string') {
      return res
        .status(400)
        .json({ error: 'App-specific password is required. Create one at appleid.apple.com under Security.' });
    }

    let enc;
    try {
      enc = encryptSecret(appPassword);
    } catch (err) {
      return res.status(503).json({
        error: err.message || 'Server is not configured to store credentials safely.',
      });
    }

    const calendarNames = parseCalendarNames(req.body);
    let blocks;
    try {
      blocks = await pullBusyBlocksFromIcloud(appleId.trim(), appPassword, calendarNames);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      return res.status(400).json({
        error:
          msg ||
          'Could not read calendars from iCloud. Check your Apple ID, app-specific password, and network.',
      });
    }

    const manageKeyTrim = manageKeyRaw && String(manageKeyRaw).trim();
    let shareId;
    let token;
    let manageKey;

    if (manageKeyTrim) {
      const share = db
        .prepare('SELECT id, token, manage_key FROM shares WHERE manage_key = ?')
        .get(manageKeyTrim);
      if (!share) {
        return res.status(404).json({ error: 'Unknown manage key. Create a new share or paste the key you saved.' });
      }
      shareId = share.id;
      token = share.token;
      manageKey = share.manage_key;
    } else {
      token = randomToken();
      manageKey = randomToken();
      const now = Date.now();
      const info = db
        .prepare('INSERT INTO shares (token, manage_key, created_at, updated_at) VALUES (?,?,?,?)')
        .run(token, manageKey, now, now);
      shareId = Number(info.lastInsertRowid);
    }

    const filterJson = JSON.stringify(calendarNames);
    const now = Date.now();
    db.prepare(
      `INSERT INTO icloud_sync (share_id, apple_id, password_enc, calendar_filter_json, last_sync_at, last_error)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(share_id) DO UPDATE SET
         apple_id = excluded.apple_id,
         password_enc = excluded.password_enc,
         calendar_filter_json = excluded.calendar_filter_json,
         last_error = NULL`,
    ).run(shareId, appleId.trim(), enc, filterJson, now, null);

    replaceBlocks(shareId, blocks);
    db.prepare('UPDATE shares SET updated_at = ? WHERE id = ?').run(Date.now(), shareId);
    db.prepare('UPDATE icloud_sync SET last_sync_at = ?, last_error = NULL WHERE share_id = ?').run(
      Date.now(),
      shareId,
    );

    const base = publicBaseUrl(req);
    return res.json({
      token,
      manageKey,
      subscribeUrl: `${base}/calendar/${token}.ics`,
      webcalUrl: `webcal://${base.replace(/^https?:\/\//, '')}/calendar/${token}.ics`,
      eventCount: blocks.length,
      icloudSync: true,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong setting up iCloud sync.' });
  }
});

app.delete('/api/sync/icloud', (req, res) => {
  try {
    const manageKey = req.body?.manageKey || req.query?.manageKey;
    if (!manageKey || typeof manageKey !== 'string') {
      return res.status(401).json({ error: 'Manage key required (JSON body or ?manageKey=).' });
    }
    const share = db.prepare('SELECT id FROM shares WHERE manage_key = ?').get(String(manageKey).trim());
    if (!share) {
      return res.status(404).json({ error: 'Unknown manage key.' });
    }
    db.prepare('DELETE FROM icloud_sync WHERE share_id = ?').run(share.id);
    return res.json({ ok: true, icloudSync: false });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to remove iCloud sync.' });
  }
});

app.get('/api/sync/status', (req, res) => {
  try {
    const manageKey = req.query?.manageKey;
    if (!manageKey || typeof manageKey !== 'string') {
      return res.status(400).json({ error: 'Query parameter manageKey is required.' });
    }
    const share = db.prepare('SELECT id FROM shares WHERE manage_key = ?').get(String(manageKey).trim());
    if (!share) {
      return res.status(404).json({ error: 'Unknown manage key.' });
    }
    const row = db
      .prepare(
        'SELECT last_sync_at as lastSyncAt, last_error as lastError, apple_id as appleId FROM icloud_sync WHERE share_id = ?',
      )
      .get(share.id);
    if (!row) {
      return res.json({ icloudSync: false });
    }
    const masked =
      row.appleId && row.appleId.includes('@')
        ? row.appleId.replace(/^(.).+(@.+)$/, '$1***$2')
        : '***';
    return res.json({
      icloudSync: true,
      appleIdMasked: masked,
      lastSyncAt: row.lastSyncAt,
      lastError: row.lastError,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Status check failed.' });
  }
});

app.post('/api/shares', upload.single('calendar'), (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'Upload an .ics file (field name: calendar).' });
    }
    const text = req.file.buffer.toString('utf8');
    let blocks;
    try {
      blocks = parseBusyBlocksFromIcs(text);
    } catch (e) {
      return res.status(400).json({ error: 'Could not read that calendar file. Use a valid .ics export.' });
    }
    if (!blocks.length) {
      return res.status(400).json({
        error: 'No events found in that file. Export a calendar that has appointments, then try again.',
      });
    }

    const token = randomToken();
    const manageKey = randomToken();
    const now = Date.now();

    const ins = db.prepare(
      'INSERT INTO shares (token, manage_key, created_at, updated_at) VALUES (?,?,?,?)',
    );
    const info = ins.run(token, manageKey, now, now);
    const shareId = Number(info.lastInsertRowid);

    replaceBlocks(shareId, blocks);

    const base = publicBaseUrl(req);
    return res.json({
      token,
      manageKey,
      subscribeUrl: `${base}/calendar/${token}.ics`,
      webcalUrl: `webcal://${base.replace(/^https?:\/\//, '')}/calendar/${token}.ics`,
      eventCount: blocks.length,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong creating the share.' });
  }
});

app.put('/api/shares', upload.single('calendar'), (req, res) => {
  try {
    const manageKey = req.body?.manageKey || req.headers['x-manage-key'];
    if (!manageKey || typeof manageKey !== 'string') {
      return res.status(401).json({ error: 'Missing manage key (body manageKey or X-Manage-Key header).' });
    }
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'Upload an .ics file (field name: calendar).' });
    }
    const share = db.prepare('SELECT id FROM shares WHERE manage_key = ?').get(manageKey);
    if (!share) {
      return res.status(404).json({ error: 'Unknown manage key.' });
    }
    const text = req.file.buffer.toString('utf8');
    let blocks;
    try {
      blocks = parseBusyBlocksFromIcs(text);
    } catch {
      return res.status(400).json({ error: 'Could not read that calendar file.' });
    }
    if (!blocks.length) {
      return res.status(400).json({ error: 'No events found in that file.' });
    }
    replaceBlocks(share.id, blocks);
    db.prepare('UPDATE shares SET updated_at = ? WHERE id = ?').run(Date.now(), share.id);
    const base = publicBaseUrl(req);
    const full = db.prepare('SELECT token FROM shares WHERE id = ?').get(share.id);
    return res.json({
      ok: true,
      subscribeUrl: `${base}/calendar/${full.token}.ics`,
      webcalUrl: `webcal://${base.replace(/^https?:\/\//, '')}/calendar/${full.token}.ics`,
      eventCount: blocks.length,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Update failed.' });
  }
});

app.post('/api/sync/icloud/trigger', async (req, res) => {
  try {
    const manageKey = req.body?.manageKey;
    if (!manageKey || typeof manageKey !== 'string') {
      return res.status(401).json({ error: 'manageKey required in JSON body.' });
    }
    const share = db.prepare('SELECT id FROM shares WHERE manage_key = ?').get(String(manageKey).trim());
    if (!share) {
      return res.status(404).json({ error: 'Unknown manage key.' });
    }
    const has = db.prepare('SELECT 1 FROM icloud_sync WHERE share_id = ?').get(share.id);
    if (!has) {
      return res.status(400).json({ error: 'This share is not linked to iCloud. Use “Connect iCloud” first.' });
    }
    const result = await syncShare(share.id);
    if (result.skipped) {
      return res.json({ ok: true, skipped: true, message: 'A sync is already running for this share.' });
    }
    if (!result.ok) {
      return res.status(502).json({ ok: false, error: result.error });
    }
    return res.json({ ok: true, eventCount: result.eventCount });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Sync failed.' });
  }
});

app.get('/calendar/:token', (req, res) => {
  let token = req.params.token;
  if (token.endsWith('.ics')) token = token.slice(0, -4);
  const share = db.prepare('SELECT id FROM shares WHERE token = ?').get(token);
  if (!share) {
    return res.status(404).send('Calendar not found.');
  }
  const blocks = db
    .prepare(
      'SELECT start_ms as startMs, end_ms as endMs, all_day as allDay FROM busy_blocks WHERE share_id = ? ORDER BY start_ms ASC',
    )
    .all(share.id)
    .map((r) => ({
      startMs: r.startMs,
      endMs: r.endMs,
      allDay: r.allDay === 1,
    }));

  const body = buildRedactedIcs(token, blocks);
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="busy.ics"');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(body);
});

app.get('/api/health', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`CalendarShare http://localhost:${PORT}`);
  const sec = Number(process.env.ICLOUD_SYNC_INTERVAL_SEC);
  const intervalMs = (Number.isFinite(sec) && sec > 0 ? sec : 180) * 1000;
  setInterval(() => {
    syncAllShares().catch((e) => console.error('[icloud] periodic sync', e));
  }, intervalMs);
  setImmediate(() => {
    syncAllShares().catch((e) => console.error('[icloud] startup sync', e));
  });
});
