import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'papan.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS contents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT    NOT NULL CHECK (type IN ('text','image','video','pdf')),
  title       TEXT    NOT NULL DEFAULT '',
  body        TEXT    NOT NULL DEFAULT '',
  file        TEXT    NOT NULL DEFAULT '',
  duration    INTEGER NOT NULL DEFAULT 15,
  sort        INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  screensaver INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS categories (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT    NOT NULL,
  prefix TEXT    NOT NULL UNIQUE,
  sort   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS counters (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS tickets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  counter_id  INTEGER REFERENCES counters(id) ON DELETE SET NULL,
  number      INTEGER NOT NULL,
  day         TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'waiting'
              CHECK (status IN ('waiting','called','serving','done','skipped')),
  served_by   INTEGER REFERENCES counters(id) ON DELETE SET NULL,
  priority    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  called_at   INTEGER,
  done_at     INTEGER,
  UNIQUE (category_id, day, number)
);
CREATE INDEX IF NOT EXISTS idx_tickets_queue ON tickets (day, status, category_id);
`);

const DEFAULT_SETTINGS = {
  org_name: 'Nama Instansi',
  org_logo: '',
  idle_minutes: '3',
  timezone: 'Asia/Jakarta',
  sound_enabled: '1',
  tts_enabled: '1',
};

const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);

// Data contoh hanya ditulis saat database masih kosong.
if (db.prepare('SELECT COUNT(*) AS n FROM categories').get().n === 0) {
  const cat = db.prepare('INSERT INTO categories (name, prefix, sort) VALUES (?, ?, ?)');
  cat.run('Pelayanan Umum', 'A', 1);
  cat.run('Administrasi', 'B', 2);
  const ctr = db.prepare('INSERT INTO counters (name, category_id) VALUES (?, ?)');
  ctr.run('Meja 1', 1);
  ctr.run('Meja 2', 1);
  ctr.run('Meja 3', 2);
  db.prepare(
    'INSERT INTO contents (type, title, body, duration, sort) VALUES (?, ?, ?, ?, ?)'
  ).run('text', 'Selamat datang', 'Silakan ambil nomor antrian melalui kiosk. Terima kasih atas kesabaran Anda.', 15, 1);
}

export function getSettings() {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}
