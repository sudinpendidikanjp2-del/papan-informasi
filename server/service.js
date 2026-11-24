import { EventEmitter } from 'node:events';
import { db, getSettings } from './db.js';

// Event bus: 'queue' (antrian berubah), 'call' (ada panggilan), 'content', 'settings', 'categories'.
export const bus = new EventEmitter();

export class HttpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

let lastActivity = Date.now();
export const getLastActivity = () => lastActivity;

function touch() {
  lastActivity = Date.now();
}

export function today() {
  const tz = getSettings().timezone || 'Asia/Jakarta';
  // en-CA menghasilkan format YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

const pad3 = (n) => String(n).padStart(3, '0');
const labelOf = (prefix, number) => `${prefix}-${pad3(number)}`;

function categoryById(id) {
  return db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
}

function counterById(id) {
  return db.prepare('SELECT * FROM counters WHERE id = ?').get(id);
}

function currentFor(counterId) {
  const t = db
    .prepare(
      `SELECT t.id, t.number, t.status, t.called_at, cat.prefix
         FROM tickets t JOIN categories cat ON cat.id = t.category_id
        WHERE t.served_by = ? AND t.status IN ('called','serving')
        ORDER BY t.called_at DESC LIMIT 1`
    )
    .get(counterId);
  if (!t) return null;
  return { id: t.id, label: labelOf(t.prefix, t.number), status: t.status, calledAt: t.called_at };
}

// ---------- Antrian: pengunjung ----------

export function listCategories() {
  return db.prepare('SELECT id, name, prefix FROM categories ORDER BY sort, id').all();
}

export function createTicket(categoryId, counterId = null) {
  const cat = categoryById(categoryId);
  if (!cat) throw new HttpError(404, 'Kategori tidak ditemukan');
  const day = today();
  const { n } = db
    .prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tickets WHERE category_id = ? AND day = ?')
    .get(cat.id, day);
  const info = db
    .prepare('INSERT INTO tickets (category_id, counter_id, number, day, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(cat.id, counterId, n, day, Date.now());
  touch();
  bus.emit('queue');
  return {
    id: Number(info.lastInsertRowid),
    label: labelOf(cat.prefix, n),
    categoryName: cat.name,
  };
}

// ---------- Antrian: meja / petugas ----------

export function callNext(counterId) {
  const c = counterById(counterId);
  if (!c || !c.active) throw new HttpError(404, 'Meja tidak ditemukan');
  if (currentFor(c.id)) throw new HttpError(409, 'Selesaikan atau lewati antrian yang sedang dilayani');

  // Prioritas: antrian yang ditujukan ke meja ini, lalu antrian kategori (meja kosong di kategori yang sama).
  const t = db
    .prepare(
      `SELECT t.*, cat.prefix FROM tickets t JOIN categories cat ON cat.id = t.category_id
        WHERE t.status = 'waiting' AND t.day = ?
          AND (t.counter_id = ? OR (t.counter_id IS NULL AND t.category_id = ?))
        ORDER BY (t.counter_id IS NULL), t.priority DESC, t.created_at
        LIMIT 1`
    )
    .get(today(), c.id, c.category_id);
  if (!t) throw new HttpError(404, 'Tidak ada antrian menunggu');

  const now = Date.now();
  db.prepare("UPDATE tickets SET status = 'called', served_by = ?, called_at = ? WHERE id = ?").run(c.id, now, t.id);
  touch();
  const payload = { label: labelOf(t.prefix, t.number), counter: c.name };
  bus.emit('queue');
  bus.emit('call', payload);
  return payload;
}

export function recall(counterId) {
  const cur = currentFor(counterId);
  if (!cur) throw new HttpError(404, 'Tidak ada antrian yang dipanggil');
  db.prepare('UPDATE tickets SET called_at = ? WHERE id = ?').run(Date.now(), cur.id);
  touch();
  const c = counterById(counterId);
  bus.emit('call', { label: cur.label, counter: c.name });
  return { label: cur.label };
}

function setStatus(counterId, from, to, extra = '') {
  const cur = currentFor(counterId);
  if (!cur) throw new HttpError(404, 'Tidak ada antrian yang dipanggil');
  if (from && cur.status !== from) throw new HttpError(409, 'Status antrian tidak sesuai');
  db.prepare(`UPDATE tickets SET status = ?${extra} WHERE id = ?`).run(
    to,
    ...(extra ? [Date.now(), cur.id] : [cur.id])
  );
  touch();
  bus.emit('queue');
  return { label: cur.label, status: to };
}

export const startServing = (counterId) => setStatus(counterId, 'called', 'serving');
export const finish = (counterId) => setStatus(counterId, null, 'done', ', done_at = ?');
export const skip = (counterId) => setStatus(counterId, null, 'skipped');

// ---------- Snapshot untuk layar ----------

export function snapshot() {
  const day = today();
  const counters = db
    .prepare(
      `SELECT c.id, c.name, c.category_id AS categoryId, cat.name AS categoryName
         FROM counters c LEFT JOIN categories cat ON cat.id = c.category_id
        WHERE c.active = 1 ORDER BY c.id`
    )
    .all()
    .map((c) => ({ ...c, current: currentFor(c.id) }));

  const categories = db
    .prepare(
      `SELECT cat.id, cat.name, cat.prefix,
              (SELECT COUNT(*) FROM tickets t WHERE t.category_id = cat.id AND t.day = ? AND t.status = 'waiting') AS waiting
         FROM categories cat ORDER BY cat.sort, cat.id`
    )
    .all(day);

  const recent = db
    .prepare(
      `SELECT t.number, t.called_at AS calledAt, cat.prefix, c.name AS counter
         FROM tickets t
         JOIN categories cat ON cat.id = t.category_id
         LEFT JOIN counters c ON c.id = t.served_by
        WHERE t.day = ? AND t.called_at IS NOT NULL
        ORDER BY t.called_at DESC LIMIT 6`
    )
    .all(day)
    .map((r) => ({ label: labelOf(r.prefix, r.number), counter: r.counter, calledAt: r.calledAt }));

  return { now: Date.now(), lastActivity: lastActivity, counters, categories, recent };
}

// ---------- Konten ----------

const CONTENT_TYPES = ['text', 'image', 'video', 'pdf'];

function normalizeContent(b) {
  const type = CONTENT_TYPES.includes(b.type) ? b.type : null;
  if (!type) throw new HttpError(400, 'Jenis konten tidak valid');
  const duration = Math.max(0, Math.min(3600, parseInt(b.duration ?? 15, 10) || 0));
  if (type !== 'text' && !b.file) throw new HttpError(400, 'File wajib diunggah untuk jenis ini');
  return {
    type,
    title: String(b.title || '').slice(0, 200),
    body: type === 'text' ? String(b.body || '').slice(0, 5000) : '',
    file: type === 'text' ? '' : String(b.file),
    duration: type === 'video' && duration === 0 ? 0 : Math.max(duration, type === 'text' ? 5 : 3),
    sort: parseInt(b.sort ?? 0, 10) || 0,
    active: b.active === false || b.active === 0 ? 0 : 1,
    screensaver: b.screensaver ? 1 : 0,
  };
}

export function listContents() {
  return db.prepare('SELECT * FROM contents ORDER BY sort, id').all();
}

export function createContent(b) {
  const c = normalizeContent(b);
  const info = db
    .prepare(
      `INSERT INTO contents (type, title, body, file, duration, sort, active, screensaver)
       VALUES (@type, @title, @body, @file, @duration, @sort, @active, @screensaver)`
    )
    .run(c);
  bus.emit('content');
  return { id: Number(info.lastInsertRowid) };
}

export function updateContent(id, b) {
  const c = normalizeContent(b);
  const r = db
    .prepare(
      `UPDATE contents SET type=@type, title=@title, body=@body, file=@file, duration=@duration,
              sort=@sort, active=@active, screensaver=@screensaver WHERE id=@id`
    )
    .run({ ...c, id });
  if (!r.changes) throw new HttpError(404, 'Konten tidak ditemukan');
  bus.emit('content');
  return { ok: true };
}

export function deleteContent(id) {
  db.prepare('DELETE FROM contents WHERE id = ?').run(id);
  bus.emit('content');
  return { ok: true };
}

export function playlist() {
  const rows = db
    .prepare('SELECT id, type, title, body, file, duration, screensaver FROM contents WHERE active = 1 ORDER BY sort, id')
    .all()
    .map((r) => ({ ...r, url: r.file ? `/uploads/${r.file}` : '' }));
  return {
    main: rows.filter((r) => !r.screensaver),
    screensaver: rows.filter((r) => r.screensaver && r.type !== 'text'),
  };
}

// ---------- Kategori & meja ----------

export function listAdminCategories() {
  return db.prepare('SELECT * FROM categories ORDER BY sort, id').all();
}

export function saveCategory(id, b) {
  const name = String(b.name || '').trim();
  const prefix = String(b.prefix || '').trim().toUpperCase().slice(0, 3);
  if (!name || !prefix) throw new HttpError(400, 'Nama dan prefix wajib diisi');
  try {
    if (id) {
      db.prepare('UPDATE categories SET name = ?, prefix = ?, sort = ? WHERE id = ?').run(name, prefix, parseInt(b.sort ?? 0, 10) || 0, id);
    } else {
      // Kategori baru ditaruh di urutan paling akhir bila urutan tidak diisi.
      const sort = b.sort !== undefined && b.sort !== ''
        ? parseInt(b.sort, 10) || 0
        : db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM categories').get().n;
      db.prepare('INSERT INTO categories (name, prefix, sort) VALUES (?, ?, ?)').run(name, prefix, sort);
    }
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Prefix sudah dipakai');
    throw e;
  }
  bus.emit('categories');
  bus.emit('queue');
  return { ok: true };
}

export function deleteCategory(id) {
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  bus.emit('categories');
  bus.emit('queue');
  return { ok: true };
}

export function listAdminCounters() {
  return db
    .prepare(
      `SELECT c.*, cat.name AS categoryName FROM counters c
         LEFT JOIN categories cat ON cat.id = c.category_id ORDER BY c.id`
    )
    .all();
}

export function saveCounter(id, b) {
  const name = String(b.name || '').trim();
  if (!name) throw new HttpError(400, 'Nama meja wajib diisi');
  const categoryId = b.categoryId ? Number(b.categoryId) : null;
  const active = b.active === false || b.active === 0 ? 0 : 1;
  if (id) db.prepare('UPDATE counters SET name = ?, category_id = ?, active = ? WHERE id = ?').run(name, categoryId, active, id);
  else db.prepare('INSERT INTO counters (name, category_id, active) VALUES (?, ?, ?)').run(name, categoryId, active);
  bus.emit('categories');
  bus.emit('queue');
  return { ok: true };
}

export function deleteCounter(id) {
  db.prepare('DELETE FROM counters WHERE id = ?').run(id);
  bus.emit('categories');
  bus.emit('queue');
  return { ok: true };
}

// ---------- Pengaturan & laporan ----------

const EDITABLE_SETTINGS = ['org_name', 'org_logo', 'idle_minutes', 'timezone', 'sound_enabled', 'tts_enabled'];

export function saveSettings(b) {
  for (const k of EDITABLE_SETTINGS) {
    if (b[k] === undefined) continue;
    let v = String(b[k]);
    if (k === 'idle_minutes') {
      const n = parseInt(v, 10);
      v = String(Number.isFinite(n) ? Math.max(1, Math.min(120, n)) : 3);
    }
    if (k === 'org_name') v = v.slice(0, 120);
    if (k === 'sound_enabled' || k === 'tts_enabled') v = v === '0' || v === 'false' ? '0' : '1';
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(k, v);
  }
  bus.emit('settings');
  return { ok: true };
}

export function report() {
  const day = today();
  return db
    .prepare(
      `SELECT cat.name, cat.prefix,
              COUNT(t.id) AS total,
              SUM(t.status = 'done') AS done,
              SUM(t.status = 'skipped') AS skipped,
              SUM(t.status = 'waiting') AS waiting
         FROM categories cat LEFT JOIN tickets t ON t.category_id = cat.id AND t.day = ?
        GROUP BY cat.id ORDER BY cat.sort, cat.id`
    )
    .all(day);
}
