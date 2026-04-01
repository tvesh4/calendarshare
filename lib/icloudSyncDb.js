/**
 * @param {import('better-sqlite3').Database} db
 */
function ensureIcloudSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS icloud_sync (
      share_id INTEGER PRIMARY KEY,
      apple_id TEXT NOT NULL,
      password_enc TEXT NOT NULL,
      calendar_filter_json TEXT,
      last_sync_at INTEGER,
      last_error TEXT,
      FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE
    );
  `);
}

module.exports = { ensureIcloudSchema };
