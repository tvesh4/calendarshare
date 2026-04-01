const { decryptSecret } = require('./credentialCrypto');
const { pullBusyBlocksFromIcloud } = require('./icloudPull');

/**
 * @param {{ db: import('better-sqlite3').Database; replaceBlocks: (shareId: number, blocks: unknown[]) => void }} deps
 */
function createIcloudSync(deps) {
  const { db, replaceBlocks } = deps;
  const syncing = new Set();

  async function syncShare(shareId) {
    if (syncing.has(shareId)) return { skipped: true };
    syncing.add(shareId);
    try {
      const row = db
        .prepare(
          `SELECT apple_id, password_enc, calendar_filter_json FROM icloud_sync WHERE share_id = ?`,
        )
        .get(shareId);
      if (!row) return { ok: false, error: 'No iCloud sync configured for this share.' };

      const password = decryptSecret(row.password_enc);
      const filters = row.calendar_filter_json ? JSON.parse(row.calendar_filter_json) : [];
      const blocks = await pullBusyBlocksFromIcloud(row.apple_id, password, filters);
      replaceBlocks(shareId, blocks);
      const now = Date.now();
      db.prepare('UPDATE icloud_sync SET last_sync_at = ?, last_error = NULL WHERE share_id = ?').run(
        now,
        shareId,
      );
      db.prepare('UPDATE shares SET updated_at = ? WHERE id = ?').run(now, shareId);
      return { ok: true, eventCount: blocks.length };
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      db.prepare('UPDATE icloud_sync SET last_error = ?, last_sync_at = ? WHERE share_id = ?').run(
        msg,
        Date.now(),
        shareId,
      );
      return { ok: false, error: msg };
    } finally {
      syncing.delete(shareId);
    }
  }

  async function syncAllShares() {
    const rows = db.prepare('SELECT share_id FROM icloud_sync').all();
    for (const r of rows) {
      await syncShare(r.share_id);
    }
  }

  return { syncShare, syncAllShares };
}

module.exports = { createIcloudSync };
