import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { DATA_DIR, db, getSettings } from './db.js';
import * as svc from './service.js';
import { HttpError, bus } from './service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD = 300 * 1024 * 1024;

let ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
if (!ADMIN_TOKEN) {
  ADMIN_TOKEN = crypto.randomBytes(6).toString('hex');
  console.warn(`[papan] ADMIN_TOKEN belum diset. Token sementara: ${ADMIN_TOKEN}`);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
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

function requireToken(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : String(req.headers['x-token'] || '');
  const a = Buffer.from(token);
  const b = Buffer.from(ADMIN_TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Token tidak valid');
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

// ---------- API ----------

async function api(req, res, url) {
  const m = req.method;
  const p = url.pathname;

  // Publik
  if (m === 'GET' && p === '/api/time') return send(res, 200, { now: Date.now() });
  if (m === 'GET' && p === '/api/settings') return send(res, 200, getSettings());
  if (m === 'GET' && p === '/api/state') return send(res, 200, svc.snapshot());
  if (m === 'GET' && p === '/api/playlist') return send(res, 200, svc.playlist());
  if (m === 'GET' && p === '/api/categories') return send(res, 200, svc.listCategories());
  if (m === 'POST' && p === '/api/tickets') {
    const b = await readJson(req);
    return send(res, 201, svc.createTicket(Number(b.categoryId)));
  }

  // Meja / petugas (butuh token)
  const counterAction = p.match(/^\/api\/counter\/(\d+)\/(next|recall|start|done|skip)$/);
  if (m === 'POST' && counterAction) {
    requireToken(req);
    const id = Number(counterAction[1]);
    const actions = {
      next: () => svc.callNext(id),
      recall: () => svc.recall(id),
      start: () => svc.startServing(id),
      done: () => svc.finish(id),
      skip: () => svc.skip(id),
    };
    return send(res, 200, actions[counterAction[2]]());
  }

  // Admin (butuh token)
  if (p.startsWith('/api/admin/')) {
    requireToken(req);
    return adminApi(req, res, url);
  }

  throw new HttpError(404, 'Tidak ditemukan');
}

async function adminApi(req, res, url) {
  const m = req.method;
  const p = url.pathname;
  const idOf = (re) => {
    const r = p.match(re);
    return r ? Number(r[1]) : null;
  };

  if (m === 'GET' && p === '/api/admin/content') return send(res, 200, svc.listContents());
  if (m === 'POST' && p === '/api/admin/content') return send(res, 201, svc.createContent(await readJson(req)));
  const cid = idOf(/^\/api\/admin\/content\/(\d+)$/);
  if (cid && m === 'PUT') return send(res, 200, svc.updateContent(cid, await readJson(req)));
  if (cid && m === 'DELETE') return send(res, 200, svc.deleteContent(cid));

  if (m === 'POST' && p === '/api/admin/upload') return send(res, 201, await handleUpload(req, url));

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

  if (m === 'PUT' && p === '/api/admin/settings') return send(res, 200, svc.saveSettings(await readJson(req)));
  if (m === 'GET' && p === '/api/admin/report') return send(res, 200, svc.report());

  throw new HttpError(404, 'Tidak ditemukan');
}

// Unggah file mentah: header x-filename berisi nama asli. Disimpan dengan nama acak.
function handleUpload(req, url) {
  return new Promise((resolve, reject) => {
    const original = String(req.headers['x-filename'] || url.searchParams.get('name') || 'file');
    const ext = path.extname(original).toLowerCase();
    if (!UPLOAD_EXT.has(ext)) {
      req.resume();
      return reject(new HttpError(400, 'Format file tidak didukung'));
    }
    const name = crypto.randomBytes(10).toString('hex') + ext;
    const dest = path.join(UPLOAD_DIR, name);
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
      if (!failed) resolve({ file: name, url: `/uploads/${name}`, size });
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
    const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' };
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

const server = http.createServer(async (req, res) => {
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
});

wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', now: Date.now() }));
});

// Pembersihan: konfirmasi koneksi DB saat start
db.prepare('SELECT 1').get();

server.listen(PORT, () => {
  console.log(`[papan] berjalan di http://localhost:${PORT}  (display: /, kiosk: /kiosk.html, meja: /operator.html, admin: /admin.html)`);
});
