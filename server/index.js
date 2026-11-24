import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { DATA_DIR, db, dbOk, getSettings } from './db.js';
import * as svc from './service.js';
import { HttpError, bus } from './service.js';
import * as auth from './auth.js';
import * as media from './media.js';
import * as notify from './notify.js';
import { hit } from './ratelimit.js';
import { checkUpload } from './upload-check.js';
import { audit } from './audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD = 300 * 1024 * 1024;

// HTTPS bawaan bila TLS_CERT dan TLS_KEY diset. TRUST_PROXY=1 hanya diaktifkan bila server
// berada di belakang reverse proxy tepercaya (header X-Forwarded-* bisa dipalsukan klien langsung).
const TLS_CERT = process.env.TLS_CERT || '';
const TLS_KEY = process.env.TLS_KEY || '';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.ico': 'image/x-icon',
};
const UPLOAD_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.mp4', '.webm', '.pdf']);

// ---------- helper ----------

function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    // Badan JSON kecil; klien yang mengirimnya sangat lambat (slowloris) diputus.
    const timer = setTimeout(() => {
      reject(new HttpError(408, 'Permintaan terlalu lama'));
      req.destroy();
    }, 15000);
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) {
        clearTimeout(timer);
        reject(new HttpError(413, 'Data terlalu besar'));
        req.destroy();
      }
    });
    req.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new HttpError(400, 'JSON tidak valid'));
      }
    });
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

const isHttps = (req) =>
  !!req.socket.encrypted || (TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');

// Alamat klien untuk pembatas login. Di belakang proxy tepercaya dipakai X-Forwarded-For (entri pertama).
function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xf) return xf;
  }
  return req.socket.remoteAddress || '';
}

function sessionToken(req) {
  return auth.parseCookies(req.headers.cookie)[auth.COOKIE_NAME] || '';
}

// Mengembalikan sesi yang valid, atau melempar 401. role 'admin' membatasi ke admin saja.
function requireSession(req, role = null) {
  const s = auth.getSession(sessionToken(req));
  if (!s) throw new HttpError(401, 'Silakan login terlebih dahulu');
  if (role === 'admin' && s.role !== 'admin') throw new HttpError(403, 'Hanya admin yang boleh mengakses ini');
  return s;
}

// Perlindungan CSRF tambahan di atas SameSite=Lax: tolak permintaan yang mengubah data
// bila header Origin ada tetapi bukan dari host yang sama.
function checkOrigin(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const origin = req.headers.origin;
  if (!origin) return;
  let host = '';
  try {
    host = new URL(origin).host;
  } catch {
    /* origin tidak valid */
  }
  if (host !== req.headers.host) throw new HttpError(403, 'Asal permintaan tidak diizinkan');
}

// ---------- WebSocket ----------

let wss;
function broadcast(payload) {
  if (!wss) return;
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

bus.on('queue', () => broadcast({ type: 'queue' }));
bus.on('call', (c) => broadcast({ type: 'call', ...c }));
bus.on('content', () => broadcast({ type: 'content' }));
bus.on('settings', () => broadcast({ type: 'settings' }));
bus.on('categories', () => broadcast({ type: 'categories' }));
bus.on('screens', () => broadcast({ type: 'screens' }));

// ---------- API ----------

async function api(req, res, url) {
  const m = req.method;
  const p = url.pathname;

  checkOrigin(req);

  // Publik. Parameter ?screen=<slug> memfilter konten dan antrian sesuai pengaturan layar.
  const screenSlug = url.searchParams.get('screen');
  if (m === 'GET' && p === '/api/time') return send(res, 200, { now: Date.now() });
  if (m === 'GET' && p === '/api/settings') return send(res, 200, getSettings());
  if (m === 'GET' && p === '/api/state') return send(res, 200, svc.snapshot(screenSlug));
  if (m === 'GET' && p === '/api/playlist') return send(res, 200, svc.playlist(screenSlug));
  if (m === 'GET' && p === '/api/categories') return send(res, 200, svc.listCategories());
  const screenMatch = p.match(/^\/api\/screen\/([a-z0-9-]{1,40})$/);
  if (m === 'GET' && screenMatch) return send(res, 200, svc.screenConfig(screenMatch[1]));
  if (m === 'POST' && p === '/api/tickets') {
    // Kiosk berbagi satu alamat dan dipakai manusia, jadi batasnya longgar; cukup untuk menahan skrip pembanjir nomor.
    hit('ticket:' + clientIp(req), Number(process.env.TICKET_RATE || 30));
    const b = await readJson(req);
    // Prioritas dari kiosk publik hanya diterima bila admin mengaktifkannya.
    if (b.priority && getSettings().priority_enabled !== '1') {
      throw new HttpError(403, 'Antrian prioritas tidak tersedia di kiosk ini');
    }
    return send(res, 201, svc.createTicket(Number(b.categoryId), { priority: !!b.priority }));
  }

  // Pantau tiket dari ponsel pengunjung. Token 96 bit di URL adalah satu-satunya kunci akses.
  if (m === 'GET' && p === '/api/push/config') return send(res, 200, notify.pushConfig());
  const tk = p.match(/^\/api\/ticket\/([a-f0-9]{24})(\/push|\/qr\.svg)?$/);
  if (tk) {
    const token = tk[1];
    if (!tk[2] && m === 'GET') return send(res, 200, svc.ticketStatus(token));
    if (tk[2] === '/push' && m === 'POST') {
      hit('push:' + clientIp(req), 20);
      return send(res, 200, notify.subscribe(token, (await readJson(req)).subscription));
    }
    if (tk[2] === '/qr.svg' && m === 'GET') {
      svc.ticketStatus(token); // 404 bila tiket tidak ada
      const base = `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
      return res.end(notify.qrSvg(notify.trackUrl(token, base)));
    }
  }

  // Login pegawai
  if (m === 'POST' && p === '/api/auth/login') {
    const b = await readJson(req);
    const r = await auth.login(b.username, b.password, clientIp(req));
    res.setHeader('set-cookie', auth.cookieHeader(r.token, isHttps(req)));
    return send(res, 200, auth.me(auth.getSession(r.token)));
  }
  if (m === 'GET' && p === '/api/auth/me') return send(res, 200, auth.me(requireSession(req)));
  if (m === 'POST' && p === '/api/auth/logout') {
    const s = auth.getSession(sessionToken(req));
    if (s) auth.logout(s);
    res.setHeader('set-cookie', auth.cookieHeader('', isHttps(req)));
    return send(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/auth/counter') {
    const b = await readJson(req);
    return send(res, 200, auth.chooseCounter(requireSession(req), b.counterId ?? null));
  }

  // Riwayat pegawai yang sedang login (hari ini).
  if (m === 'GET' && p === '/api/auth/history') return send(res, 200, svc.historyFor(requireSession(req).userId));

  // Meja: pegawai hanya di mejanya sendiri, admin di meja mana pun.
  const counterAction = p.match(/^\/api\/counter\/(\d+)\/(next|recall|start|done|skip|ticket|transfer)$/);
  if (m === 'POST' && counterAction) {
    const session = requireSession(req);
    const id = Number(counterAction[1]);
    auth.assertCounterAccess(session, id);
    const action = counterAction[2];
    if (action === 'ticket') return send(res, 201, svc.createTicketAtCounter(id, await readJson(req)));
    if (action === 'transfer') return send(res, 200, svc.transfer(id, await readJson(req)));
    const actions = {
      next: () => svc.callNext(id, session.userId),
      recall: () => svc.recall(id),
      start: () => svc.startServing(id),
      done: () => svc.finish(id),
      skip: () => svc.skip(id),
    };
    return send(res, 200, actions[action]());
  }

  // Admin
  if (p.startsWith('/api/admin/')) {
    const session = requireSession(req, 'admin');
    return adminApi(req, res, url, session);
  }

  throw new HttpError(404, 'Tidak ditemukan');
}

async function adminApi(req, res, url, session) {
  const m = req.method;
  const p = url.pathname;
  const idOf = (re) => {
    const r = p.match(re);
    return r ? Number(r[1]) : null;
  };

  if (m === 'GET' && p === '/api/admin/summary') {
    return send(res, 200, { ...svc.summary(), ffmpeg: media.ffmpegAvailable });
  }

  if (m === 'GET' && p === '/api/admin/content') return send(res, 200, svc.listContents());
  if (m === 'POST' && p === '/api/admin/content') {
    const b = await readJson(req);
    media.assertReady(UPLOAD_DIR, b.file);
    return send(res, 201, svc.createContent(b));
  }
  const cid = idOf(/^\/api\/admin\/content\/(\d+)$/);
  if (cid && m === 'PUT') {
    const b = await readJson(req);
    media.assertReady(UPLOAD_DIR, b.file);
    const old = db.prepare('SELECT file FROM contents WHERE id = ?').get(cid);
    const r = svc.updateContent(cid, b);
    if (old && old.file !== b.file) dropIfUnused(old.file);
    return send(res, 200, r);
  }
  if (cid && m === 'DELETE') {
    const old = db.prepare('SELECT file FROM contents WHERE id = ?').get(cid);
    const r = svc.deleteContent(cid);
    if (old) dropIfUnused(old.file);
    return send(res, 200, r);
  }
  // Operasi massal dari bar aksi: { ids: [..], action: 'activate' | 'deactivate' | 'delete' }
  if (m === 'POST' && p === '/api/admin/content/bulk') return send(res, 200, bulkContent(await readJson(req)));

  if (m === 'POST' && p === '/api/admin/upload') {
    const r = await handleUpload(req, url);
    return send(res, r.status === 'processing' ? 202 : 201, r);
  }
  const upStatus = p.match(/^\/api\/admin\/upload\/([a-f0-9]{20}\.[a-z0-9]{2,4})\/status$/);
  if (m === 'GET' && upStatus) return send(res, 200, media.status(UPLOAD_DIR, upStatus[1]));

  if (m === 'GET' && p === '/api/admin/categories') return send(res, 200, svc.listAdminCategories());
  if (m === 'POST' && p === '/api/admin/categories') return send(res, 201, svc.saveCategory(null, await readJson(req)));
  const catId = idOf(/^\/api\/admin\/categories\/(\d+)$/);
  if (catId && m === 'PUT') return send(res, 200, svc.saveCategory(catId, await readJson(req)));
  if (catId && m === 'DELETE') return send(res, 200, svc.deleteCategory(catId));

  if (m === 'GET' && p === '/api/admin/counters') return send(res, 200, svc.listAdminCounters());
  if (m === 'POST' && p === '/api/admin/counters') return send(res, 201, svc.saveCounter(null, await readJson(req)));
  const ctrId = idOf(/^\/api\/admin\/counters\/(\d+)$/);
  if (ctrId && m === 'PUT') return send(res, 200, svc.saveCounter(ctrId, await readJson(req)));
  if (ctrId && m === 'DELETE') return send(res, 200, svc.deleteCounter(ctrId));

  if (m === 'GET' && p === '/api/admin/screens') return send(res, 200, svc.listScreens());
  if (m === 'POST' && p === '/api/admin/screens') return send(res, 201, svc.saveScreen(null, await readJson(req)));
  const scrId = idOf(/^\/api\/admin\/screens\/(\d+)$/);
  if (scrId && m === 'PUT') return send(res, 200, svc.saveScreen(scrId, await readJson(req)));
  if (scrId && m === 'DELETE') return send(res, 200, svc.deleteScreen(scrId));

  if (m === 'GET' && p === '/api/admin/users') return send(res, 200, auth.listUsers());
  if (m === 'POST' && p === '/api/admin/users') {
    const b = await readJson(req);
    const r = await auth.saveUser(null, b);
    audit('user_created', { by: session.username, username: b.username, role: b.role === 'admin' ? 'admin' : 'staff' });
    return send(res, 201, r);
  }
  const userId = idOf(/^\/api\/admin\/users\/(\d+)$/);
  if (userId && m === 'PUT') {
    const b = await readJson(req);
    const r = await auth.saveUser(userId, b);
    // Perubahan yang sensitif dicatat tanpa nilai password.
    audit('user_updated', {
      by: session.username, id: userId, username: b.username, role: b.role === 'admin' ? 'admin' : 'staff',
      active: !(b.active === false || b.active === 0), passwordChanged: !!b.password,
    });
    return send(res, 200, r);
  }
  if (userId && m === 'DELETE') {
    const r = auth.deleteUser(userId, session.userId);
    audit('user_deleted', { by: session.username, id: userId });
    return send(res, 200, r);
  }

  if (m === 'PUT' && p === '/api/admin/settings') {
    const oldLogo = getSettings().org_logo;
    const body = await readJson(req);
    const r = svc.saveSettings(body);
    audit('settings_changed', { by: session.username, keys: Object.keys(body) });
    if (oldLogo && oldLogo !== getSettings().org_logo) dropIfUnused(path.basename(oldLogo));
    return send(res, 200, r);
  }
  if (m === 'GET' && p === '/api/admin/report') return send(res, 200, svc.report());

  throw new HttpError(404, 'Tidak ditemukan');
}

function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function bulkContent(b) {
  const r = svc.bulkContent(b);
  for (const f of r.files) dropIfUnused(f);
  return { ok: true, count: r.count };
}

// Hapus berkas unggahan bila tidak lagi dirujuk konten mana pun maupun logo.
function dropIfUnused(name) {
  if (!name) return;
  const safe = path.basename(name);
  const inUse = db.prepare('SELECT 1 FROM contents WHERE file = ?').get(safe) || path.basename(getSettings().org_logo || '') === safe;
  if (!inUse) fs.unlink(path.join(UPLOAD_DIR, safe), () => {});
}

// Berkas unggahan yang sedang diterima. Saat server berhenti, berkasnya dihapus secara sinkron: proses bisa
// keluar sebelum peristiwa 'close' pada koneksi yang diputus paksa sempat membersihkannya.
const activeUploads = new Set();

// Unggah file mentah: header x-filename berisi nama asli. Disimpan dengan nama acak.
// Video diubah ke MP4 H.264 oleh ffmpeg (bila tersedia); responsnya status 'processing' dan
// klien memantau lewat /api/admin/upload/:file/status.
function handleUpload(req, url) {
  return new Promise((resolve, reject) => {
    const original = decodeURIComponentSafe(String(req.headers['x-filename'] || url.searchParams.get('name') || 'file'));
    const ext = path.extname(original).toLowerCase();
    if (!UPLOAD_EXT.has(ext)) {
      req.resume();
      return reject(new HttpError(400, 'Format file tidak didukung'));
    }
    // Tolak dari header bila ukuran yang diumumkan sudah melebihi batas, tanpa menunggu badan terkirim.
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_UPLOAD) {
      req.resume();
      return reject(new HttpError(413, 'File melebihi 300 MB'));
    }
    const id = crypto.randomBytes(10).toString('hex');
    const transcode = media.VIDEO_EXT.has(ext) && media.ffmpegAvailable;
    // Hasil transcoding selalu .mp4; sumbernya disimpan sementara sebagai <id>.src<ext>.
    const name = id + (transcode ? '.mp4' : ext);
    const dest = path.join(UPLOAD_DIR, transcode ? `${id}.src${ext}` : name);
    const out = fs.createWriteStream(dest);
    activeUploads.add(dest);
    let size = 0;
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      activeUploads.delete(dest);
      out.destroy();
      // Sinkron: saat server berhenti proses bisa keluar sebelum unlink asinkron selesai.
      try { fs.unlinkSync(dest); } catch { /* belum dibuat atau sudah terhapus */ }
      reject(err);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD) fail(new HttpError(413, 'File melebihi 300 MB'));
    });
    req.pipe(out);
    // Klien terputus sebelum badan selesai (Wi-Fi putus, tab ditutup, server berhenti): buang berkas setengah jadi.
    req.on('close', () => {
      if (!req.complete) fail(new HttpError(400, 'Unggahan terputus sebelum selesai'));
    });
    out.on('finish', () => {
      if (failed) return;
      // Periksa isi terhadap ekstensi (tanda tangan berkas; SVG tanpa skrip) sebelum menerima.
      const verdict = checkUpload(dest, ext);
      if (!verdict.ok) return fail(new HttpError(400, verdict.reason));
      activeUploads.delete(dest); // selesai dan sah: kepemilikan berpindah (konversi video atau penyimpanan konten)
      if (transcode) {
        media.enqueueTranscode(dest, path.join(UPLOAD_DIR, name), name);
        return resolve({ file: name, url: `/uploads/${name}`, size, status: 'processing' });
      }
      const warning = media.VIDEO_EXT.has(ext) ? 'ffmpeg tidak tersedia: video disimpan apa adanya, tanpa konversi' : undefined;
      resolve({ file: name, url: `/uploads/${name}`, size, status: 'ready', warning });
    });
    out.on('error', fail);
    req.on('error', fail);
  });
}

// ---------- Static ----------

function serveFile(req, res, filePath, root) {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(root) + path.sep) && resolved !== path.resolve(root)) {
    res.writeHead(403).end();
    return;
  }
  fs.stat(resolved, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Tidak ditemukan');
      return;
    }
    const type = MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
    // Referrer dimatikan: URL halaman pantau memuat token tiket dan tidak boleh bocor ke pihak lain.
    const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-cache', 'referrer-policy': 'no-referrer' };
    // Dukungan Range agar video bisa diputar dan dicari posisinya di browser.
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        const start = m[1] ? Number(m[1]) : st.size - Number(m[2]);
        const end = m[2] && m[1] ? Number(m[2]) : st.size - 1;
        if (start >= 0 && end < st.size && start <= end) {
          res.writeHead(206, {
            ...headers,
            'content-range': `bytes ${start}-${end}/${st.size}`,
            'content-length': end - start + 1,
          });
          fs.createReadStream(resolved, { start, end }).pipe(res);
          return;
        }
      }
    }
    res.writeHead(200, { ...headers, 'content-length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(resolved).pipe(res);
  });
}

// ---------- Server ----------

// Pemeriksaan kesehatan untuk pemantauan, systemd, dan Docker. Tanpa autentikasi dan sengaja minim
// informasi: hanya hidup atau tidak. Saat server berhenti ia menjawab 503 agar balancer berhenti mengirim lalu lintas.
let shuttingDown = false;
function health(res) {
  res.setHeader('cache-control', 'no-store');
  if (shuttingDown) return send(res, 503, { ok: false, reason: 'berhenti' });
  if (!dbOk()) return send(res, 503, { ok: false, reason: 'database' });
  return send(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
}

// Kebijakan konten: skrip hanya dari asal sendiri (tanpa skrip inline), gaya inline diizinkan karena
// atribut style dinamis dipakai di banyak tempat. Worker blob diperlukan sebagai cadangan pdf.js.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

// Header keamanan untuk setiap respons, termasuk galat. Berkas unggahan diperlakukan khusus:
// SVG dapat memuat skrip, jadi bila dibuka langsung ia di-sandbox (sebagai <img> tetap aman karena
// skrip tidak berjalan di sana). Jenis lain tidak diberi CSP karena penampil PDF bawaan browser
// tidak berjalan di dokumen yang di-sandbox; nosniff sudah mencegah salah tafsir tipe.
function setSecurityHeaders(req, res, pathname) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'SAMEORIGIN');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  if (isHttps(req)) res.setHeader('strict-transport-security', 'max-age=15552000');
  if (pathname.startsWith('/uploads/')) {
    if (pathname.toLowerCase().endsWith('.svg')) {
      res.setHeader('content-security-policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
    }
  } else {
    res.setHeader('content-security-policy', CSP);
  }
}

async function handler(req, res) {
  // Permintaan dengan target rusak tidak boleh menjatuhkan proses (handler async yang melempar
  // di luar try menjadi unhandled rejection).
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Permintaan tidak valid');
    return;
  }
  setSecurityHeaders(req, res, url.pathname);
  try {
    if (url.pathname === '/healthz') return health(res);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname.startsWith('/uploads/')) {
      return serveFile(req, res, path.join(UPLOAD_DIR, path.basename(url.pathname)), UPLOAD_DIR);
    }
    let rel = '';
    if (url.pathname === '/') {
      rel = 'display.html';
    } else {
      try {
        rel = decodeURIComponent(url.pathname.slice(1));
      } catch {
        throw new HttpError(400, 'Alamat tidak valid');
      }
    }
    if (rel.includes('\0')) throw new HttpError(400, 'Alamat tidak valid');
    return serveFile(req, res, path.join(PUBLIC_DIR, rel), PUBLIC_DIR);
  } catch (err) {
    const code = err instanceof HttpError ? err.code : 500;
    if (code === 500) console.error(err);
    if (res.headersSent) return res.end();
    if (err && err.retryAfter) res.setHeader('retry-after', String(err.retryAfter));
    // Badan permintaan yang ditolak mungkin masih mengalir (mis. unggahan terlalu besar): tutup koneksinya.
    if (code === 413 || code === 408) res.setHeader('connection', 'close');
    send(res, code, { error: err instanceof HttpError ? err.message : 'Terjadi kesalahan pada server' });
  }
}

// HTTPS bawaan bila sertifikat dan kunci diberikan; kegagalan membaca berkas menghentikan server
// agar tidak diam-diam berjalan tanpa enkripsi.
let server;
if (TLS_CERT || TLS_KEY) {
  if (!TLS_CERT || !TLS_KEY) throw new Error('TLS_CERT dan TLS_KEY harus diisi bersamaan');
  server = https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, handler);
} else {
  server = http.createServer(handler);
}
// Batas waktu: header harus lengkap dalam 20 detik (menahan slowloris); badan permintaan diberi waktu
// lebih lama agar unggahan video besar lewat Wi-Fi lambat tidak terputus (ukurannya sudah dibatasi 300 MB).
server.headersTimeout = 20000;
// Node memeriksa batas waktu koneksi hanya tiap 30 detik secara bawaan, sehingga headersTimeout 20 detik
// baru bekerja belasan detik kemudian. Periksa tiap 5 detik agar penahanan koneksi diputus tepat waktu.
server.connectionsCheckingInterval = 5000;
server.requestTimeout = 30 * 60 * 1000;
server.keepAliveTimeout = 10000;
server.maxHeadersCount = 60;
const SCHEME = TLS_CERT ? 'https' : 'http';

// WebSocket hanya mengirim ke klien; pesan dari klien tidak dipakai, jadi ukurannya dibatasi kecil.
// Jumlah koneksi per alamat dibatasi (di belakang proxy, set TRUST_PROXY=1 agar alamat klien yang dihitung).
const WS_MAX_PER_IP = Number(process.env.WS_MAX_PER_IP || 100);
const wsPerIp = new Map();
wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 1024,
  perMessageDeflate: false,
  verifyClient: (info, done) => {
    const ip = clientIp(info.req);
    if ((wsPerIp.get(ip) || 0) >= WS_MAX_PER_IP) return done(false, 429, 'Terlalu banyak koneksi');
    done(true);
  },
});
wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  wsPerIp.set(ip, (wsPerIp.get(ip) || 0) + 1);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  // Tanpa pendengar 'error', pesan melebihi maxPayload akan melempar dan menjatuhkan proses.
  ws.on('error', () => {});
  ws.on('message', () => {});
  ws.on('close', () => {
    const n = (wsPerIp.get(ip) || 1) - 1;
    if (n <= 0) wsPerIp.delete(ip); else wsPerIp.set(ip, n);
  });
  ws.send(JSON.stringify({ type: 'hello', now: Date.now() }));
});
// Buang koneksi mati (perangkat mati mendadak, Wi-Fi putus) agar tidak menumpuk dan menghabiskan batas.
const wsHeartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* koneksi sudah tertutup */ }
  }
}, 30000);
wsHeartbeat.unref();

db.prepare('SELECT 1').get();
await auth.bootstrapAdmin();
auth.sweepAttempts();
notify.init();

// Bersihkan berkas unggahan yang tidak dirujuk: saat start, lalu tiap jam.
const sweep = () => {
  try {
    const n = media.cleanupUploads(UPLOAD_DIR);
    if (n) console.log(`[papan] ${n} berkas unggahan yatim dihapus`);
  } catch (e) {
    console.error('[papan] pembersihan unggahan gagal:', e.message);
  }
};
sweep();
setInterval(sweep, 60 * 60 * 1000).unref();

if (!media.ffmpegAvailable) console.warn('[papan] ffmpeg tidak ditemukan: video tidak akan dikonversi.');
if (TRUST_PROXY) console.log('[papan] TRUST_PROXY aktif: header X-Forwarded-* dipercaya.');

// ---------- Penutupan anggun ----------

// Berkas PID memungkinkan skrip restore memastikan server sudah berhenti sebelum data diganti.
const PID_FILE = path.join(DATA_DIR, 'papan.pid');
const removePid = () => {
  try {
    // Hanya hapus bila masih milik proses ini.
    if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PID_FILE);
  } catch { /* tidak ada atau bukan milik kita */ }
};

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[papan] ${signal} diterima, menutup server...`);
  const force = setTimeout(() => {
    console.error('[papan] batas waktu penutupan (10 dtk) terlampaui, keluar paksa');
    removePid();
    process.exit(1);
  }, 10000);
  force.unref();

  clearInterval(wsHeartbeat);
  // Berhenti menerima koneksi baru; koneksi diam ditutup, WebSocket diberi tahu, dan sisa koneksi
  // aktif (mis. unggahan yang masih berjalan) diputus setelah 3 detik.
  const closed = new Promise((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  for (const ws of wss.clients) {
    try { ws.close(1001, 'Server berhenti'); } catch { /* sudah tertutup */ }
  }
  setTimeout(() => server.closeAllConnections(), 3000).unref();

  await Promise.all([closed, media.shutdown()]);
  for (const f of activeUploads) {
    try { fs.unlinkSync(f); } catch { /* sudah terhapus */ }
  }
  try { db.close(); } catch { /* sudah tertutup */ }
  removePid();
  console.log('[papan] berhenti dengan bersih');
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('exit', removePid);

// HOST membatasi antarmuka yang didengarkan (mis. 127.0.0.1 di belakang reverse proxy). Kosong = semua.
const HOST = process.env.HOST || '';
server.listen(PORT, HOST || undefined, () => {
  fs.writeFileSync(PID_FILE, String(process.pid));
  console.log(`[papan] berjalan di ${SCHEME}://${HOST || 'localhost'}:${PORT}  (display: /, kiosk: /kiosk.html, meja: /operator.html, admin: /admin.html)`);
});
