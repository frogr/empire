// SQLite persistence (PRD §7). One file, four tables, no ORM.

import Database from 'better-sqlite3';

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      pwhash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS saves (
      user_id INTEGER NOT NULL REFERENCES users(id),
      slot INTEGER NOT NULL,
      version INTEGER NOT NULL,
      char_name TEXT NOT NULL DEFAULT '',
      networth INTEGER NOT NULL DEFAULT 0,
      alive INTEGER NOT NULL DEFAULT 1,
      blob BLOB NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, slot)
    );
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      seed TEXT NOT NULL,
      char_name TEXT NOT NULL,
      networth INTEGER NOT NULL,
      cause_of_death TEXT NOT NULL,
      turns INTEGER NOT NULL,
      started_at INTEGER,
      ended_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
  `);
  return db;
}
