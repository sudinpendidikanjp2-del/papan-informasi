import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { db, tx } from './db.js';
import { HttpError, hasActiveTicket, bus } from './service.js';

const scrypt = promisify(crypto.scrypt);

export const COOKIE_NAME = 'sid';
const SESSION_MS = 12 * 60 * 60 * 1000;
const MIN_PASSWORD = 8;

// ---------- Password ----------

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Hash palsu untuk menyamakan waktu respons saat username tidak ada.
let dummyHash = null;
async function dummy() {
  dummyHash = dummyHash || (await hashPassword('tidak-dipakai'));
  return dummyHash;
}

// ---------- Pembatas percobaan login ----------

// Disimpan di SQLite (tabel login_attempts) agar penguncian bertahan saat server dimulai ulang.
// Dua lapis: per pasangan (alamat, username) untuk menahan tebakan password pada satu akun, dan per
// alamat untuk menahan tebakan banyak username dari satu sumber (password spraying).
const MAX_PER_ACCOUNT = 5;   // percobaan per (alamat, username) dalam satu jendela
const MAX_PER_ADDRESS = 20;  // percobaan per alamat dalam satu jendela
const LOCK_MS = 5 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000; // percobaan lebih tua dari ini tidak dihitung lagi

const lockedError = (until) =>
  new HttpError(429, `Terlalu banyak percobaan. Coba lagi dalam ${Math.max(1, Math.ceil((until - Date.now()) / 60000))} menit`);

const putAttempt = db.prepare(
  `INSERT INTO login_attempts (key, count, until, updated_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(key) DO UPDATE SET count = excluded.count, until = excluded.until, updated_at = excluded.updated_at`
);

// Mencatat satu percobaan SEBELUM password diverifikasi. Verifikasi (scrypt) bersifat async, jadi bila
// pencatatan baru dilakukan setelah gagal, banyak permintaan paralel bisa lolos sebelum hitungan naik.
// Melempar 429 bila batas terlampaui; percobaan yang melampaui batas memulai penguncian.
function reserveAttempt(key, max) {
  const now = Date.now();
  const r = db.prepare('SELECT count, until, updated_at FROM login_attempts WHERE key = ?').get(key);
  let count = 0;
  if (r) {
    if (r.until > now) throw lockedError(r.until);
    const fresh = r.until === 0 && now - r.updated_at <= WINDOW_MS; // bukan bekas kunci, masih dalam jendela
    count = fresh ? r.count : 0;
  }
  count += 1;
  if (count > max) {
    const until = now + LOCK_MS;
    putAttempt.run(key, count, until, now);
    throw lockedError(until);
  }
  putAttempt.run(key, count, 0, now);
}

// Login berhasil: hitungan akun dihapus, dan hitungan alamat turun satu agar pengguna sah di balik
// satu alamat bersama (mis. NAT kantor) tidak ikut terkunci oleh percobaan yang berhasil.
function releaseAttempts(accountKey, addressKey) {
  db.prepare('DELETE FROM login_attempts WHERE key = ?').run(accountKey);
  db.prepare('UPDATE login_attempts SET count = MAX(count - 1, 0) WHERE key = ? AND until = 0').run(addressKey);
}

let lastSweep = 0;
export function sweepAttempts() {
  const now = Date.now();
  lastSweep = now;
  return db.prepare('DELETE FROM login_attempts WHERE until < ? AND updated_at < ?').run(now, now - WINDOW_MS).changes;
}

// ---------- Sesi ----------

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookieHeader(token, secure) {
  const base = `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/`;
  const age = token ? `; Max-Age=${Math.floor(SESSION_MS / 1000)}` : '; Max-Age=0';
  return base + age + (secure ? '; Secure' : '');
}

function createSession(userId) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    sha(token),
    userId,
    now,
    now + SESSION_MS
  );
  return token;
}

export function getSession(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT s.id_hash, s.user_id, s.counter_id, u.username, u.name, u.role, u.active
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id_hash = ? AND s.expires_at > ?`
    )
    .get(sha(token), Date.now());
  if (!row || !row.active) return null;
  return {
    idHash: row.id_hash,
    userId: row.user_id,
    counterId: row.counter_id,
    username: row.username,
    name: row.name,
    role: row.role,
  };
}

export async function login(username, password, ip) {
  const uname = String(username || '').trim();
  // Awalan "ip:" dan "acct:" mencegah nama pengguna tertentu (mis. "*") bertabrakan dengan kunci alamat.
  const addressKey = `ip:${ip}`;
  const accountKey = `acct:${ip}|${uname.toLowerCase().slice(0, 64)}`;
  if (Date.now() - lastSweep > 60000) sweepAttempts();
  reserveAttempt(addressKey, MAX_PER_ADDRESS);
  reserveAttempt(accountKey, MAX_PER_ACCOUNT);
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(uname);
  const ok = await verifyPassword(String(password || ''), user ? user.password_hash : await dummy());
  if (!user || !user.active || !ok) throw new HttpError(401, 'Username atau password salah');
  releaseAttempts(accountKey, addressKey);
  return { token: createSession(user.id), userId: user.id };
}

export function logout(session) {
  if (session.counterId && hasActiveTicket(session.counterId)) {
    throw new HttpError(409, 'Selesaikan atau lewati antrian yang sedang dilayani sebelum keluar');
  }
  db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(session.idHash);
  return { ok: true };
}

// Meja yang boleh dipakai sesi ini, dengan penanda meja yang sedang dipegang sesi lain.
function allowedCounters(session) {
  const rows =
    session.role === 'admin'
      ? db.prepare('SELECT c.id, c.name, cat.name AS categoryName FROM counters c LEFT JOIN categories cat ON cat.id = c.category_id WHERE c.active = 1 ORDER BY c.id').all()
      : db
          .prepare(
            `SELECT c.id, c.name, cat.name AS categoryName
               FROM user_counters uc
               JOIN counters c ON c.id = uc.counter_id AND c.active = 1
               LEFT JOIN categories cat ON cat.id = c.category_id
              WHERE uc.user_id = ? ORDER BY c.id`
          )
          .all(session.userId);
  const held = db
    .prepare('SELECT counter_id FROM sessions WHERE counter_id IS NOT NULL AND id_hash <> ? AND expires_at > ?')
    .all(session.idHash, Date.now())
    .map((r) => r.counter_id);
  return rows.map((c) => ({ ...c, busy: held.includes(c.id) }));
}

export function me(session) {
  return {
    id: session.userId,
    username: session.username,
    name: session.name,
    role: session.role,
    counterId: session.counterId,
    counters: allowedCounters(session),
  };
}

// counterId null = lepas meja.
export function chooseCounter(session, counterId) {
  if (counterId === null || counterId === undefined) {
    if (session.counterId && hasActiveTicket(session.counterId)) {
      throw new HttpError(409, 'Selesaikan atau lewati antrian yang sedang dilayani sebelum berpindah meja');
    }
    db.prepare('UPDATE sessions SET counter_id = NULL WHERE id_hash = ?').run(session.idHash);
    bus.emit('queue');
    return { ok: true, counterId: null };
  }
  const id = Number(counterId);
  if (session.counterId && session.counterId !== id && hasActiveTicket(session.counterId)) {
    throw new HttpError(409, 'Selesaikan atau lewati antrian yang sedang dilayani sebelum berpindah meja');
  }
  const allowed = allowedCounters(session).find((c) => c.id === id);
  if (!allowed) throw new HttpError(403, 'Anda tidak diizinkan memakai meja ini');
  if (allowed.busy) throw new HttpError(409, 'Meja sedang dipakai pegawai lain');
  db.prepare('UPDATE sessions SET counter_id = ? WHERE id_hash = ?').run(id, session.idHash);
  bus.emit('queue');
  return { ok: true, counterId: id };
}

// Pegawai hanya boleh menjalankan aksi di mejanya sendiri; admin boleh di meja mana pun.
export function assertCounterAccess(session, counterId) {
  if (session.role === 'admin') return;
  if (session.counterId !== counterId) throw new HttpError(403, 'Pilih meja Anda terlebih dahulu');
}

// ---------- Manajemen pegawai (admin) ----------

export function listUsers() {
  const links = db.prepare('SELECT user_id, counter_id FROM user_counters').all();
  return db
    .prepare('SELECT id, username, name, role, active FROM users ORDER BY name')
    .all()
    .map((u) => ({ ...u, counterIds: links.filter((l) => l.user_id === u.id).map((l) => l.counter_id) }));
}

function otherActiveAdmins(exceptId) {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?").get(exceptId ?? -1).n;
}

export async function saveUser(id, b) {
  const username = String(b.username || '').trim();
  const name = String(b.name || '').trim().slice(0, 80);
  const role = b.role === 'admin' ? 'admin' : 'staff';
  const active = b.active === false || b.active === 0 ? 0 : 1;
  const password = b.password ? String(b.password) : '';
  const counterIds = [...new Set((Array.isArray(b.counterIds) ? b.counterIds : []).map(Number).filter(Number.isInteger))];

  if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) throw new HttpError(400, 'Username 3-32 karakter: huruf, angka, titik, garis bawah, atau tanda hubung');
  if (!name) throw new HttpError(400, 'Nama wajib diisi');
  if (!id && !password) throw new HttpError(400, 'Password wajib diisi untuk pegawai baru');
  if (password && password.length < MIN_PASSWORD) throw new HttpError(400, `Password minimal ${MIN_PASSWORD} karakter`);

  if (id) {
    const existing = db.prepare('SELECT role, active FROM users WHERE id = ?').get(id);
    if (!existing) throw new HttpError(404, 'Pegawai tidak ditemukan');
    const losesAdmin = existing.role === 'admin' && existing.active && (role !== 'admin' || !active);
    if (losesAdmin && otherActiveAdmins(id) === 0) throw new HttpError(409, 'Harus tersisa minimal satu admin aktif');
  }

  const hash = password ? await hashPassword(password) : null;
  try {
    tx(() => {
      let uid = id;
      if (id) {
        db.prepare('UPDATE users SET username = ?, name = ?, role = ?, active = ? WHERE id = ?').run(username, name, role, active, id);
        if (hash) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
      } else {
        uid = Number(
          db.prepare('INSERT INTO users (username, name, password_hash, role, active) VALUES (?, ?, ?, ?, ?)').run(username, name, hash, role, active).lastInsertRowid
        );
      }
      db.prepare('DELETE FROM user_counters WHERE user_id = ?').run(uid);
      const ins = db.prepare('INSERT OR IGNORE INTO user_counters (user_id, counter_id) VALUES (?, ?)');
      for (const cid of counterIds) ins.run(uid, cid);
      // Nonaktif atau ganti password: paksa login ulang.
      if (id && (hash || !active)) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Username sudah dipakai');
    throw e;
  }
  bus.emit('queue');
  return { ok: true };
}

export function deleteUser(id, actingUserId) {
  if (id === actingUserId) throw new HttpError(409, 'Anda tidak bisa menghapus akun sendiri');
  const u = db.prepare('SELECT role, active FROM users WHERE id = ?').get(id);
  if (!u) throw new HttpError(404, 'Pegawai tidak ditemukan');
  if (u.role === 'admin' && u.active && otherActiveAdmins(id) === 0) {
    throw new HttpError(409, 'Harus tersisa minimal satu admin aktif');
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return { ok: true };
}

// Admin pertama dibuat saat belum ada pengguna sama sekali.
export async function bootstrapAdmin() {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return;
  const username = process.env.ADMIN_USERNAME || 'admin';
  let password = process.env.ADMIN_PASSWORD || '';
  const generated = !password;
  if (generated) password = crypto.randomBytes(9).toString('base64url');
  if (password.length < MIN_PASSWORD) {
    throw new Error(`ADMIN_PASSWORD minimal ${MIN_PASSWORD} karakter`);
  }
  db.prepare("INSERT INTO users (username, name, password_hash, role) VALUES (?, 'Administrator', ?, 'admin')").run(
    username,
    await hashPassword(password)
  );
  console.warn(
    generated
      ? `[papan] Admin pertama dibuat. username: ${username}  password sementara: ${password}  (segera ganti lewat halaman admin)`
      : `[papan] Admin pertama dibuat dengan username "${username}" dari ADMIN_PASSWORD.`
  );
}
