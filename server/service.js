import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { db, getSettings, tx } from './db.js';

// Event bus: 'queue' (antrian berubah), 'call' (ada panggilan), 'content', 'settings', 'categories', 'screens'.
export const bus = new EventEmitter();

export class HttpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Aktivitas antrian dicatat global dan per kategori, supaya screensaver sebuah layar
// hanya bergantung pada kategori yang ia tampilkan.
const bootTime = Date.now();
let lastActivity = bootTime;
const categoryActivity = new Map();

function touch(categoryId = null) {
  lastActivity = Date.now();
  if (categoryId) categoryActivity.set(categoryId, lastActivity);
}

function activityFor(categoryIds) {
  if (!categoryIds) return lastActivity;
  return Math.max(bootTime, ...categoryIds.map((id) => categoryActivity.get(id) || 0));
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
      `SELECT t.id, t.number, t.status, t.called_at, t.category_id, t.priority, cat.prefix
         FROM tickets t JOIN categories cat ON cat.id = t.category_id
        WHERE t.served_by = ? AND t.status IN ('called','serving')
        ORDER BY t.called_at DESC LIMIT 1`
    )
    .get(counterId);
  if (!t) return null;
  return {
    id: t.id,
    label: labelOf(t.prefix, t.number),
    status: t.status,
    calledAt: t.called_at,
    categoryId: t.category_id,
    priority: !!t.priority,
  };
}

export function hasActiveTicket(counterId) {
  return !!currentFor(counterId);
}

// ---------- Antrian: pengunjung ----------

// Daftar kategori untuk kiosk, lengkap dengan jumlah menunggu dan perkiraan tunggu bagi pendatang baru.
export function listCategories() {
  const day = today();
  return db
    .prepare('SELECT id, name, prefix FROM categories ORDER BY sort, id')
    .all()
    .map((c) => {
      const { ahead, etaMinutes } = aheadAndEta(c.id, day, 0);
      return { ...c, waiting: ahead, etaMinutes };
    });
}

// Rata-rata lama layanan hari ini untuk satu kategori (ms), atau null bila belum ada data.
function avgServiceMs(categoryId, day) {
  const r = db
    .prepare(
      `SELECT AVG(done_at - called_at) AS avg, COUNT(*) AS n FROM tickets
        WHERE category_id = ? AND day = ? AND status = 'done' AND done_at IS NOT NULL AND called_at IS NOT NULL`
    )
    .get(categoryId, day);
  return r.n > 0 && r.avg > 0 ? r.avg : null;
}

// Jumlah antrian menunggu yang akan dilayani lebih dulu, dan perkiraan menit tunggu.
function aheadAndEta(categoryId, day, priority) {
  const { n: ahead } = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tickets
        WHERE category_id = ? AND day = ? AND status = 'waiting' AND priority >= ?`
    )
    .get(categoryId, day, priority);
  const avg = avgServiceMs(categoryId, day);
  const { n: counters } = db
    .prepare('SELECT COUNT(*) AS n FROM counters WHERE active = 1 AND category_id = ?')
    .get(categoryId);
  const eta = ahead > 0 && avg ? Math.max(1, Math.ceil((ahead * avg) / 60000 / Math.max(1, counters))) : null;
  return { ahead, etaMinutes: eta };
}

// opts: { counterId: tujuan khusus meja (atau null), priority: boolean }
export function createTicket(categoryId, opts = {}) {
  const counterId = opts.counterId ?? null;
  const priority = opts.priority ? 1 : 0;
  const cat = categoryById(categoryId);
  if (!cat) throw new HttpError(404, 'Kategori tidak ditemukan');
  const day = today();
  const { ahead, etaMinutes } = aheadAndEta(cat.id, day, priority);
  const { n } = db
    .prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tickets WHERE category_id = ? AND day = ?')
    .get(cat.id, day);
  // Token acak 96 bit: satu-satunya "kunci" untuk memantau tiket ini dari ponsel pengunjung.
  const token = crypto.randomBytes(12).toString('hex');
  const info = db
    .prepare('INSERT INTO tickets (category_id, counter_id, number, day, priority, created_at, token) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(cat.id, counterId, n, day, priority, Date.now(), token);
  touch(cat.id);
  bus.emit('queue');
  return {
    id: Number(info.lastInsertRowid),
    label: labelOf(cat.prefix, n),
    categoryName: cat.name,
    priority: !!priority,
    ahead,
    etaMinutes,
    token,
  };
}

// Jumlah antrian menunggu di kategori yang sama yang akan dipanggil lebih dulu daripada tiket ini
// (urutan sama dengan callNext: prioritas, lalu waktu ambil).
export function aheadOf(t) {
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM tickets
        WHERE category_id = ? AND day = ? AND status = 'waiting' AND id <> ?
          AND (priority > ? OR (priority = ? AND (created_at < ? OR (created_at = ? AND id < ?))))`
    )
    .get(t.category_id, t.day, t.id, t.priority, t.priority, t.created_at, t.created_at, t.id).n;
}

// Status tiket untuk halaman pantau pengunjung. Hanya berisi data milik tiket itu sendiri.
export function ticketStatus(token) {
  const t = db
    .prepare(
      `SELECT t.*, cat.prefix, cat.name AS category_name, sc.name AS counter_name, dc.name AS dedicated_name
         FROM tickets t
         JOIN categories cat ON cat.id = t.category_id
         LEFT JOIN counters sc ON sc.id = t.served_by
         LEFT JOIN counters dc ON dc.id = t.counter_id
        WHERE t.token = ?`
    )
    .get(String(token || ''));
  if (!t) throw new HttpError(404, 'Tiket tidak ditemukan');
  const day = today();
  const settings = getSettings();
  let ahead = null;
  let etaMinutes = null;
  if (t.status === 'waiting' && t.day === day) {
    ahead = aheadOf(t);
    const avg = avgServiceMs(t.category_id, day);
    const { n: counters } = db.prepare('SELECT COUNT(*) AS n FROM counters WHERE active = 1 AND category_id = ?').get(t.category_id);
    if (ahead > 0 && avg) etaMinutes = Math.max(1, Math.ceil((ahead * avg) / 60000 / Math.max(1, counters)));
  }
  return {
    label: labelOf(t.prefix, t.number),
    categoryName: t.category_name,
    status: t.status,
    priority: !!t.priority,
    ahead,
    etaMinutes,
    counter: t.status === 'called' || t.status === 'serving' ? t.counter_name : null,
    dedicatedTo: t.status === 'waiting' ? t.dedicated_name : null,
    calledAt: t.called_at,
    createdAt: t.created_at,
    expired: t.day !== day,
    nearAt: Math.max(1, parseInt(settings.notify_ahead || '3', 10) || 3),
    orgName: settings.org_name,
    timezone: settings.timezone,
  };
}

// Operator membuat nomor dari panel mejanya. Tanpa kategori, dipakai kategori meja itu.
export function createTicketAtCounter(counterId, b) {
  const c = counterById(counterId);
  if (!c || !c.active) throw new HttpError(404, 'Meja tidak ditemukan');
  const categoryId = b.categoryId ? Number(b.categoryId) : c.category_id;
  if (!categoryId) throw new HttpError(400, 'Pilih kategori untuk nomor ini');
  return createTicket(categoryId, { counterId: b.dedicated ? c.id : null, priority: !!b.priority });
}

// Pindahkan antrian yang sedang dipegang sebuah meja ke meja lain. Nomor tetap, kembali menunggu.
export function transfer(counterId, toCounterId) {
  const target = counterById(Number(toCounterId));
  if (!target || !target.active) throw new HttpError(404, 'Meja tujuan tidak ditemukan');
  if (target.id === counterId) throw new HttpError(400, 'Pilih meja lain sebagai tujuan');
  const cur = currentFor(counterId);
  if (!cur) throw new HttpError(404, 'Tidak ada antrian yang bisa dipindahkan');
  db.prepare(
    `UPDATE tickets SET status = 'waiting', counter_id = ?, served_by = NULL, served_user_id = NULL,
            called_at = NULL, transferred_from = ? WHERE id = ?`
  ).run(target.id, counterId, cur.id);
  touch(cur.categoryId);
  bus.emit('queue');
  return { label: cur.label, to: target.name };
}

// Riwayat antrian yang dilayani seorang pegawai hari ini.
export function historyFor(userId) {
  return db
    .prepare(
      `SELECT t.number, t.status, t.called_at AS calledAt, t.done_at AS doneAt, t.priority,
              cat.prefix, c.name AS counter
         FROM tickets t
         JOIN categories cat ON cat.id = t.category_id
         LEFT JOIN counters c ON c.id = t.served_by
        WHERE t.day = ? AND t.served_user_id = ?
        ORDER BY t.called_at DESC LIMIT 50`
    )
    .all(today(), userId)
    .map((r) => ({
      label: labelOf(r.prefix, r.number),
      status: r.status,
      counter: r.counter,
      priority: !!r.priority,
      calledAt: r.calledAt,
      doneAt: r.doneAt,
    }));
}

// Antrian yang menunggu khusus untuk satu meja (hasil pindah atau dibuat khusus meja).
export function dedicatedWaiting(counterId) {
  return db
    .prepare(
      `SELECT t.number, t.priority, cat.prefix FROM tickets t JOIN categories cat ON cat.id = t.category_id
        WHERE t.status = 'waiting' AND t.day = ? AND t.counter_id = ? ORDER BY t.priority DESC, t.created_at`
    )
    .all(today(), counterId)
    .map((r) => ({ label: labelOf(r.prefix, r.number), priority: !!r.priority }));
}

// ---------- Antrian: meja / petugas ----------

export function callNext(counterId, userId = null) {
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
  db.prepare(
    "UPDATE tickets SET status = 'called', served_by = ?, served_user_id = ?, called_at = ? WHERE id = ?"
  ).run(c.id, userId, now, t.id);
  touch(t.category_id);
  const payload = {
    label: labelOf(t.prefix, t.number),
    counter: c.name,
    categoryId: t.category_id,
    priority: !!t.priority,
    ticketId: t.id,
  };
  bus.emit('queue');
  bus.emit('call', payload);
  return payload;
}

export function recall(counterId) {
  const cur = currentFor(counterId);
  if (!cur) throw new HttpError(404, 'Tidak ada antrian yang dipanggil');
  db.prepare('UPDATE tickets SET called_at = ? WHERE id = ?').run(Date.now(), cur.id);
  touch(cur.categoryId);
  const c = counterById(counterId);
  bus.emit('call', { label: cur.label, counter: c.name, categoryId: cur.categoryId, priority: cur.priority, ticketId: cur.id });
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
  touch(cur.categoryId);
  bus.emit('queue');
  return { label: cur.label, status: to };
}

export const startServing = (counterId) => setStatus(counterId, 'called', 'serving');
export const finish = (counterId) => setStatus(counterId, null, 'done', ', done_at = ?');
export const skip = (counterId) => setStatus(counterId, null, 'skipped');

// ---------- Snapshot untuk layar ----------

// ---------- Layar ----------

function screenRow(slug) {
  const s = db.prepare('SELECT * FROM screens WHERE slug = ?').get(slug);
  if (!s) throw new HttpError(404, 'Layar tidak terdaftar');
  return s;
}

function screenCategoryIds(screenId) {
  return db.prepare('SELECT category_id FROM screen_categories WHERE screen_id = ?').all(screenId).map((r) => r.category_id);
}

// null berarti tanpa filter (semua kategori).
function categoryFilter(slug) {
  if (!slug) return null;
  const ids = screenCategoryIds(screenRow(slug).id);
  return ids.length ? ids : null;
}

export function screenConfig(slug) {
  const s = screenRow(slug);
  return { slug: s.slug, name: s.name, idleMinutes: s.idle_minutes, categoryIds: screenCategoryIds(s.id) };
}

export function listScreens() {
  return db
    .prepare('SELECT * FROM screens ORDER BY name')
    .all()
    .map((s) => ({ id: s.id, slug: s.slug, name: s.name, idleMinutes: s.idle_minutes, categoryIds: screenCategoryIds(s.id) }));
}

export function saveScreen(id, b) {
  const slug = String(b.slug || '').trim().toLowerCase();
  const name = String(b.name || '').trim().slice(0, 80);
  if (!/^[a-z0-9-]{1,40}$/.test(slug)) throw new HttpError(400, 'Slug hanya boleh huruf kecil, angka, dan tanda hubung (maks 40)');
  if (!name) throw new HttpError(400, 'Nama layar wajib diisi');
  const idle = b.idleMinutes === '' || b.idleMinutes == null ? null : Math.max(1, Math.min(120, parseInt(b.idleMinutes, 10) || 3));
  const catIds = [...new Set((Array.isArray(b.categoryIds) ? b.categoryIds : []).map(Number).filter(Number.isInteger))];
  try {
    tx(() => {
      let sid = id;
      if (id) {
        const r = db.prepare('UPDATE screens SET slug = ?, name = ?, idle_minutes = ? WHERE id = ?').run(slug, name, idle, id);
        if (!r.changes) throw new HttpError(404, 'Layar tidak ditemukan');
      } else {
        sid = Number(db.prepare('INSERT INTO screens (slug, name, idle_minutes) VALUES (?, ?, ?)').run(slug, name, idle).lastInsertRowid);
      }
      db.prepare('DELETE FROM screen_categories WHERE screen_id = ?').run(sid);
      const ins = db.prepare('INSERT OR IGNORE INTO screen_categories (screen_id, category_id) VALUES (?, ?)');
      for (const cid of catIds) ins.run(sid, cid);
    });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Slug sudah dipakai layar lain');
    throw e;
  }
  bus.emit('screens');
  return { ok: true };
}

export function deleteScreen(id) {
  db.prepare('DELETE FROM screens WHERE id = ?').run(id);
  bus.emit('screens');
  return { ok: true };
}

// ---------- Snapshot untuk layar ----------

export function snapshot(slug = null) {
  const day = today();
  const filter = categoryFilter(slug);
  const inFilter = (categoryId) => !filter || filter.includes(categoryId);

  const counters = db
    .prepare(
      `SELECT c.id, c.name, c.category_id AS categoryId, cat.name AS categoryName
         FROM counters c LEFT JOIN categories cat ON cat.id = c.category_id
        WHERE c.active = 1 ORDER BY c.id`
    )
    .all()
    .filter((c) => inFilter(c.categoryId))
    .map((c) => ({ ...c, current: currentFor(c.id), dedicatedWaiting: dedicatedWaiting(c.id) }));

  const categories = db
    .prepare(
      `SELECT cat.id, cat.name, cat.prefix,
              (SELECT COUNT(*) FROM tickets t WHERE t.category_id = cat.id AND t.day = ? AND t.status = 'waiting') AS waiting
         FROM categories cat ORDER BY cat.sort, cat.id`
    )
    .all(day)
    .filter((k) => inFilter(k.id));

  const recent = db
    .prepare(
      `SELECT t.number, t.priority, t.called_at AS calledAt, t.category_id AS categoryId, cat.prefix, c.name AS counter
         FROM tickets t
         JOIN categories cat ON cat.id = t.category_id
         LEFT JOIN counters c ON c.id = t.served_by
        WHERE t.day = ? AND t.called_at IS NOT NULL
        ORDER BY t.called_at DESC LIMIT 40`
    )
    .all(day)
    .filter((r) => inFilter(r.categoryId))
    .slice(0, 6)
    .map((r) => ({ label: labelOf(r.prefix, r.number), counter: r.counter, calledAt: r.calledAt, priority: !!r.priority }));

  // Total yang sedang dilayani dan menunggu di layar ini, untuk kartu hero papan.
  const serving = counters.filter((c) => c.current).length;
  const waiting = categories.reduce((sum, k) => sum + k.waiting, 0);

  return { now: Date.now(), lastActivity: activityFor(filter), counters, categories, recent, serving, waiting };
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
  const links = db.prepare('SELECT content_id, screen_id FROM content_screens').all();
  return db
    .prepare('SELECT * FROM contents ORDER BY sort, id')
    .all()
    .map((c) => ({ ...c, screens: links.filter((l) => l.content_id === c.id).map((l) => l.screen_id) }));
}

function setContentScreens(contentId, screens) {
  const ids = [...new Set((Array.isArray(screens) ? screens : []).map(Number).filter(Number.isInteger))];
  db.prepare('DELETE FROM content_screens WHERE content_id = ?').run(contentId);
  const ins = db.prepare('INSERT OR IGNORE INTO content_screens (content_id, screen_id) VALUES (?, ?)');
  for (const sid of ids) ins.run(contentId, sid);
}

export function createContent(b) {
  const c = normalizeContent(b);
  const id = tx(() => {
    const info = db
      .prepare(
        `INSERT INTO contents (type, title, body, file, duration, sort, active, screensaver)
         VALUES (@type, @title, @body, @file, @duration, @sort, @active, @screensaver)`
      )
      .run(c);
    const newId = Number(info.lastInsertRowid);
    setContentScreens(newId, b.screens);
    return newId;
  });
  bus.emit('content');
  return { id };
}

export function updateContent(id, b) {
  const c = normalizeContent(b);
  tx(() => {
    const r = db
      .prepare(
        `UPDATE contents SET type=@type, title=@title, body=@body, file=@file, duration=@duration,
                sort=@sort, active=@active, screensaver=@screensaver WHERE id=@id`
      )
      .run({ ...c, id });
    if (!r.changes) throw new HttpError(404, 'Konten tidak ditemukan');
    setContentScreens(id, b.screens);
  });
  bus.emit('content');
  return { ok: true };
}

// Aksi massal dari bar aksi admin. Mengembalikan nama berkas yang dilepas agar bisa dibersihkan.
export function bulkContent(b) {
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Number.isInteger))];
  if (!ids.length) throw new HttpError(400, 'Pilih minimal satu konten');
  if (!['activate', 'deactivate', 'delete'].includes(b.action)) throw new HttpError(400, 'Aksi tidak dikenal');
  const marks = ids.map(() => '?').join(',');
  let files = [];
  if (b.action === 'delete') {
    files = db.prepare(`SELECT file FROM contents WHERE id IN (${marks})`).all(...ids).map((r) => r.file).filter(Boolean);
    db.prepare(`DELETE FROM contents WHERE id IN (${marks})`).run(...ids);
  } else {
    db.prepare(`UPDATE contents SET active = ? WHERE id IN (${marks})`).run(b.action === 'activate' ? 1 : 0, ...ids);
  }
  bus.emit('content');
  return { ok: true, count: ids.length, files };
}

export function deleteContent(id) {
  db.prepare('DELETE FROM contents WHERE id = ?').run(id);
  bus.emit('content');
  return { ok: true };
}

// Tanpa slug: hanya konten bersama. Dengan slug: konten bersama + konten yang ditujukan ke layar itu.
export function playlist(slug = null) {
  const screenId = slug ? screenRow(slug).id : null;
  const rows = db
    .prepare(
      `SELECT c.id, c.type, c.title, c.body, c.file, c.duration, c.screensaver
         FROM contents c
        WHERE c.active = 1
          AND (NOT EXISTS (SELECT 1 FROM content_screens cs WHERE cs.content_id = c.id)
               OR EXISTS (SELECT 1 FROM content_screens cs WHERE cs.content_id = c.id AND cs.screen_id = ?))
        ORDER BY c.sort, c.id`
    )
    .all(screenId)
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

const EDITABLE_SETTINGS = [
  'org_name', 'org_logo', 'idle_minutes', 'timezone', 'sound_enabled', 'tts_enabled', 'priority_enabled',
  'public_base_url', 'notify_ahead', 'push_enabled',
];
const BOOLEAN_SETTINGS = new Set(['sound_enabled', 'tts_enabled', 'priority_enabled', 'push_enabled']);

export function saveSettings(b) {
  // Satu transaksi: bila satu nilai ditolak, tidak ada pengaturan lain yang ikut tersimpan.
  tx(() => saveSettingsRows(b));
  bus.emit('settings');
  return { ok: true };
}

function saveSettingsRows(b) {
  for (const k of EDITABLE_SETTINGS) {
    if (b[k] === undefined) continue;
    let v = String(b[k]);
    if (k === 'idle_minutes') {
      const n = parseInt(v, 10);
      v = String(Number.isFinite(n) ? Math.max(1, Math.min(120, n)) : 3);
    }
    if (k === 'org_name') v = v.slice(0, 120);
    if (k === 'notify_ahead') {
      const n = parseInt(v, 10);
      v = String(Number.isFinite(n) ? Math.max(1, Math.min(20, n)) : 3);
    }
    if (k === 'public_base_url') {
      v = v.trim().replace(/\/+$/, '');
      // Kosong berarti ikut alamat yang dipakai pengunjung. Selain itu harus berupa alamat http(s) saja.
      if (v && !/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(v)) {
        throw new HttpError(400, 'Alamat dasar harus berupa URL http:// atau https:// yang valid, mis. http://192.168.1.10:3000');
      }
    }
    if (BOOLEAN_SETTINGS.has(k)) v = v === '0' || v === 'false' ? '0' : '1';
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(k, v);
  }
}

// Angka ringkas untuk kartu KPI di dasbor admin.
export function summary() {
  const one = (sql, ...args) => db.prepare(sql).get(...args).n;
  const day = today();
  return {
    contentsActive: one('SELECT COUNT(*) AS n FROM contents WHERE active = 1'),
    contentsTotal: one('SELECT COUNT(*) AS n FROM contents'),
    screens: one('SELECT COUNT(*) AS n FROM screens'),
    staffActive: one("SELECT COUNT(*) AS n FROM users WHERE role = 'staff' AND active = 1"),
    onlineCounters: one('SELECT COUNT(DISTINCT counter_id) AS n FROM sessions WHERE counter_id IS NOT NULL AND expires_at > ?', Date.now()),
    countersTotal: one('SELECT COUNT(*) AS n FROM counters WHERE active = 1'),
    waitingToday: one("SELECT COUNT(*) AS n FROM tickets WHERE day = ? AND status = 'waiting'", day),
    doneToday: one("SELECT COUNT(*) AS n FROM tickets WHERE day = ? AND status = 'done'", day),
    ticketsToday: one('SELECT COUNT(*) AS n FROM tickets WHERE day = ?', day),
  };
}

export function report() {
  const day = today();
  const staff = db
    .prepare(
      `SELECT u.name, u.username,
              COUNT(t.id) AS total,
              SUM(t.status = 'done') AS done,
              SUM(t.status = 'skipped') AS skipped
         FROM tickets t JOIN users u ON u.id = t.served_user_id
        WHERE t.day = ?
        GROUP BY u.id ORDER BY total DESC, u.name`
    )
    .all(day);
  return { categories: reportByCategory(day), staff };
}

function reportByCategory(day) {
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
