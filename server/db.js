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

-- Layar: tiap layar bisa punya playlist dan filter kategori sendiri.
CREATE TABLE IF NOT EXISTS screens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT    NOT NULL UNIQUE,
  name         TEXT    NOT NULL,
  idle_minutes INTEGER
);
-- Tanpa baris = semua kategori.
CREATE TABLE IF NOT EXISTS screen_categories (
  screen_id   INTEGER NOT NULL REFERENCES screens(id)    ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (screen_id, category_id)
);
-- Tanpa baris = konten bersama (tampil di semua layar).
CREATE TABLE IF NOT EXISTS content_screens (
  content_id INTEGER NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
  screen_id  INTEGER NOT NULL REFERENCES screens(id)  ON DELETE CASCADE,
  PRIMARY KEY (content_id, screen_id)
);

-- Pegawai dan sesi login.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'staff' CHECK (role IN ('admin','staff')),
  active        INTEGER NOT NULL DEFAULT 1
);
-- Meja yang boleh dipakai pegawai.
CREATE TABLE IF NOT EXISTS user_counters (
  user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  counter_id INTEGER NOT NULL REFERENCES counters(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, counter_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash    TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  counter_id INTEGER REFERENCES counters(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
`);

// Migrasi dari iterasi 1: catat pegawai yang melayani tiap antrian.
const ticketCols = db.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name);
if (!ticketCols.includes('served_user_id')) {
  db.exec('ALTER TABLE tickets ADD COLUMN served_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
}

// Transaksi sederhana (DatabaseSync tidak punya helper transaction).
export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

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
