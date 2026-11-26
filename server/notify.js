import webpush from 'web-push';
import qrcode from 'qrcode-generator';
import { db, getSettings, getSecret, setSecret } from './db.js';
import { HttpError, bus, aheadOf, today } from './service.js';

// Hanya layanan push milik browser besar yang diterima. Tanpa pembatasan ini pengunjung bisa
// mendaftarkan alamat sembarang dan membuat server mengirim permintaan ke sana (SSRF).
const PUSH_HOSTS = [
  /(^|\.)googleapis\.com$/,            // Chrome, Edge, Android (FCM)
  /(^|\.)push\.services\.mozilla\.com$/, // Firefox
  /(^|\.)push\.apple\.com$/,           // Safari
  /(^|\.)notify\.windows\.com$/,       // Edge lama / Windows
];
const MAX_SUBS_PER_TICKET = 5;

let publicKey = '';
let wired = false;
// Pengirim dapat diganti (untuk pengujian tanpa jaringan).
let sender = (sub, payload) => webpush.sendNotification(sub, payload, { TTL: 3600, urgency: 'high' });
export function setSender(fn) {
  sender = fn;
}

// Kunci VAPID dibuat sekali lalu disimpan di tabel secrets (bukan settings, agar kunci privat
// tidak ikut terkirim lewat /api/settings yang publik).
export function init() {
  let pub = getSecret('vapid_public');
  let priv = getSecret('vapid_private');
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys();
    pub = k.publicKey;
    priv = k.privateKey;
    setSecret('vapid_public', pub);
    setSecret('vapid_private', priv);
  }
  publicKey = pub;
  // Subjek VAPID sebaiknya berupa mailto: atau https: milik instansi (beberapa layanan push memeriksanya).
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@papan.local', pub, priv);

  // Idempoten: pemanggilan berulang tidak boleh mendaftarkan pendengar ganda (push akan terkirim dobel).
  if (wired) return;
  wired = true;
  bus.on('call', (c) => {
    onCall(c).catch((e) => console.warn('[papan] push dipanggil gagal:', e.message));
  });
  bus.on('transfer', (c) => {
    onTransfer(c).catch((e) => console.warn('[papan] push pindah gagal:', e.message));
  });
  let timer = null;
  bus.on('queue', () => {
    clearTimeout(timer);
    timer = setTimeout(() => checkNear().catch((e) => console.warn('[papan] push dekat gagal:', e.message)), 300);
  });
}

const enabled = () => getSettings().push_enabled === '1';
export const pushConfig = () => ({ enabled: enabled(), publicKey });

export function subscribe(token, sub) {
  if (!enabled()) throw new HttpError(403, 'Notifikasi push dimatikan oleh admin');
  const t = db.prepare('SELECT id, status, day FROM tickets WHERE token = ?').get(String(token || ''));
  if (!t) throw new HttpError(404, 'Tiket tidak ditemukan');
  if (t.day !== today() || !['waiting', 'called', 'serving'].includes(t.status)) {
    throw new HttpError(409, 'Tiket ini sudah selesai');
  }

  const endpoint = String((sub && sub.endpoint) || '');
  const p256dh = sub && sub.keys && sub.keys.p256dh;
  const auth = sub && sub.keys && sub.keys.auth;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new HttpError(400, 'Langganan tidak valid');
  }
  if (endpoint.length > 1000 || url.protocol !== 'https:' || !PUSH_HOSTS.some((re) => re.test(url.hostname))) {
    throw new HttpError(400, 'Layanan push tidak dikenal');
  }
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || p256dh.length > 200 || auth.length > 100) {
    throw new HttpError(400, 'Kunci langganan tidak valid');
  }

  const existing = db.prepare('SELECT ticket_id FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
  if (!existing) {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE ticket_id = ?').get(t.id);
    if (n >= MAX_SUBS_PER_TICKET) throw new HttpError(409, 'Terlalu banyak perangkat untuk tiket ini');
  }
  db.prepare(
    `INSERT INTO push_subscriptions (ticket_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET ticket_id = excluded.ticket_id, p256dh = excluded.p256dh,
       auth = excluded.auth, notified_near = 0`
  ).run(t.id, endpoint, p256dh, auth, Date.now());
  return { ok: true };
}

async function deliver(row, payload) {
  try {
    await sender({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, JSON.stringify(payload));
    return true;
  } catch (e) {
    // 404/410: langganan sudah tidak berlaku (pengguna mencabut izin atau menghapus browser).
    if (e && (e.statusCode === 404 || e.statusCode === 410)) {
      db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.id);
    } else {
      console.warn('[papan] push gagal:', (e && (e.statusCode || e.message)) || e);
    }
    return false;
  }
}

// Panggilan ke meja: beri tahu semua perangkat yang berlangganan pada tiket itu.
export async function onCall(c) {
  if (!enabled() || !c || !c.ticketId) return;
  const rows = db
    .prepare(
      `SELECT s.*, t.token FROM push_subscriptions s JOIN tickets t ON t.id = s.ticket_id WHERE s.ticket_id = ?`
    )
    .all(c.ticketId);
  await Promise.allSettled(
    rows.map((r) =>
      deliver(r, {
        kind: 'called',
        title: 'Giliran Anda tiba',
        body: 'Nomor ' + c.label + ', silakan menuju ' + (c.counter || 'meja layanan') + '.',
        tag: 'ticket-' + c.ticketId,
        url: '/antrian/' + r.token,
      })
    )
  );
}

// Tiket dipindah ke kategori lain: nomornya berganti, jadi pengunjung perlu tahu nomor barunya.
export async function onTransfer(c) {
  if (!enabled() || !c || !c.ticketId) return;
  const rows = db
    .prepare('SELECT s.*, t.token FROM push_subscriptions s JOIN tickets t ON t.id = s.ticket_id WHERE s.ticket_id = ?')
    .all(c.ticketId);
  await Promise.allSettled(
    rows.map((r) =>
      deliver(r, {
        kind: 'moved',
        title: 'Nomor antrian Anda dipindahkan',
        body: 'Nomor baru Anda ' + c.label + ' (' + c.categoryName + '), sebelumnya ' + c.prevLabel + '. Waktu tunggu awal tetap dihitung.',
        tag: 'ticket-' + c.ticketId,
        url: '/antrian/' + r.token,
      })
    )
  );
}

// Dipanggil setiap antrian berubah: kirim satu kali "hampir giliran" ketika sisa antrian di depan
// sudah sama dengan atau di bawah batas, lalu bersihkan langganan tiket yang sudah selesai.
export async function checkNear() {
  const day = today();
  if (enabled()) {
    const near = Math.max(1, parseInt(getSettings().notify_ahead || '3', 10) || 3);
    const rows = db
      .prepare(
        `SELECT s.*, t.id AS tid, t.token, t.category_id, t.day, t.priority, t.created_at AS t_created, cat.prefix, t.number
           FROM push_subscriptions s
           JOIN tickets t ON t.id = s.ticket_id
           JOIN categories cat ON cat.id = t.category_id
          WHERE t.status = 'waiting' AND t.day = ? AND s.notified_near = 0`
      )
      .all(day);
    for (const r of rows) {
      const ahead = aheadOf({ id: r.tid, category_id: r.category_id, day: r.day, priority: r.priority, created_at: r.t_created });
      if (ahead > near) continue;
      // Tandai dulu agar perubahan beruntun tidak mengirim ganda.
      db.prepare('UPDATE push_subscriptions SET notified_near = 1 WHERE id = ?').run(r.id);
      const label = r.prefix + '-' + String(r.number).padStart(3, '0');
      await deliver(r, {
        kind: 'near',
        title: 'Giliran Anda hampir tiba',
        body: 'Nomor ' + label + ': ' + (ahead === 0 ? 'Anda berikutnya' : ahead + ' antrian lagi') + '. Mohon bersiap menuju loket.',
        tag: 'ticket-' + r.tid,
        url: '/antrian/' + r.token,
      });
    }
  }
  db.prepare(
    `DELETE FROM push_subscriptions WHERE ticket_id IN (SELECT id FROM tickets WHERE status IN ('done','skipped') OR day <> ?)`
  ).run(day);
}

// ---------- QR ----------

// Alamat dasar untuk tautan QR: pengaturan admin, atau alamat yang dipakai pengunjung saat ini.
export function trackUrl(token, fallbackBase) {
  const base = (getSettings().public_base_url || fallbackBase || '').replace(/\/+$/, '');
  return base + '/antrian/' + token;
}

export function qrSvg(text) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
}
