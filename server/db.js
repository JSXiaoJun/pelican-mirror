import { DatabaseSync } from 'node:sqlite'

export function openDb(file) {
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS groups (
      id            INTEGER PRIMARY KEY,
      upstream_name TEXT NOT NULL DEFAULT '',
      platform      TEXT NOT NULL DEFAULT '',
      display_name  TEXT,
      visible       INTEGER NOT NULL DEFAULT 1,
      sort_order    INTEGER NOT NULL DEFAULT 0,
      seen_at       INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS items (
      id               INTEGER PRIMARY KEY,
      group_id         INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      model_id         TEXT NOT NULL DEFAULT '',
      reasoning_effort TEXT NOT NULL DEFAULT '',
      latency_ms       INTEGER NOT NULL DEFAULT 0,
      generated_at     TEXT NOT NULL,
      generated_ts     INTEGER NOT NULL,
      content          TEXT,
      content_error    TEXT,
      content_attempts INTEGER NOT NULL DEFAULT 0,
      synced_at        INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_items_group_ts ON items(group_id, generated_ts DESC);
  `)
  return db
}
