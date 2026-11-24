import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { DATA_DIR, db, getSettings } from './db.js';
import * as svc from './service.js';
import { HttpError, bus } from './service.js';
import * as auth from './auth.js';
import * as media from './media.js';
import * as notify from './notify.js';

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
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) {
        reject(new HttpError(413, 'Data terlalu besar'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new HttpError(400, 'JSON tidak valid'));
      }
    });
    req.on('error', reject);
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
    if (tk[2] === '/push' && m === 'POST') return send(res, 200, notify.subscribe(token, (await readJson(req)).subscription));
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
  if (m === 'POST' && p === '/api/admin/users') return send(res, 201, await auth.saveUser(null, await readJson(req)));
  const userId = idOf(/^\/api\/admin\/users\/(\d+)$/);
  if (userId && m === 'PUT') return send(res, 200, await auth.saveUser(userId, await readJson(req)));
  if (userId && m === 'DELETE') return send(res, 200, auth.deleteUser(userId, session.userId));

  if (m === 'PUT' && p === '/api/admin/settings') {
    const oldLogo = getSettings().org_logo;
    const r = svc.saveSettings(await readJson(req));
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
    const id = crypto.randomBytes(10).toString('hex');
    const transcode = media.VIDEO_EXT.has(ext) && media.ffmpegAvailable;
    // Hasil transcoding selalu .mp4; sumbernya disimpan sementara sebagai <id>.src<ext>.
    const name = id + (transcode ? '.mp4' : ext);
    const dest = path.join(UPLOAD_DIR, transcode ? `${id}.src${ext}` : name);
    const out = fs.createWriteStream(dest);
    let size = 0;
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      out.destroy();
      fs.unlink(dest, () => {});
      reject(err);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD) fail(new HttpError(413, 'File melebihi 300 MB'));
    });
    req.pipe(out);
    out.on('finish', () => {
      if (failed) return;
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

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname.startsWith('/uploads/')) {
      return serveFile(req, res, path.join(UPLOAD_DIR, path.basename(url.pathname)), UPLOAD_DIR);
    }
    let rel = url.pathname === '/' ? 'display.html' : decodeURIComponent(url.pathname.slice(1));
    return serveFile(req, res, path.join(PUBLIC_DIR, rel), PUBLIC_DIR);
  } catch (err) {
    const code = err instanceof HttpError ? err.code : 500;
    if (code === 500) console.error(err);
    if (res.headersSent) return res.end();
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
const SCHEME = TLS_CERT ? 'https' : 'http';

wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', now: Date.now() }));
});

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

server.listen(PORT, () => {
  console.log(`[papan] berjalan di ${SCHEME}://localhost:${PORT}  (display: /, kiosk: /kiosk.html, meja: /operator.html, admin: /admin.html)`);
});
