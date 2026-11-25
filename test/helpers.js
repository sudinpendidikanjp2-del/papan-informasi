// Pembantu bersama untuk tes: menjalankan server sungguhan di port acak dengan direktori data sementara,
// klien HTTP berkuki, dan utilitas kecil. Tidak ada dependensi di luar Node.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');

export const tmpDir = (prefix = 'papan-test-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, timeoutMs = 10000, label = 'kondisi') {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* coba lagi */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`Batas waktu menunggu ${label}`);
    await sleep(50);
  }
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const CLEAN_ENV = ['HOST', 'TLS_CERT', 'TLS_KEY', 'TRUST_PROXY', 'TICKET_RATE', 'WS_MAX_PER_IP', 'VAPID_SUBJECT', 'BACKUP_DIR'];

// Menjalankan `node server/index.js`. env menimpa bawaan; nilai undefined menghapus variabel.
export async function startServer(env = {}) {
  const dataDir = env.DATA_DIR || tmpDir();
  const port = await freePort();
  const full = {
    ...process.env,
    NODE_OPTIONS: '--disable-warning=ExperimentalWarning',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'rahasia123',
    ...env,
    DATA_DIR: dataDir,
    PORT: String(port),
  };
  for (const k of CLEAN_ENV) if (!(k in env)) delete full[k];
  for (const [k, v] of Object.entries(full)) if (v === undefined) delete full[k];

  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: full, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => (await fetch(base + '/healthz')).ok, 15000, 'server siap');
  } catch (e) {
    child.kill('SIGKILL');
    throw new Error(e.message + '\n--- log server ---\n' + out);
  }
  return {
    base, port, dataDir, child,
    logs: () => out,
    exited: () => child.exitCode !== null || child.signalCode !== null,
    stop: async (signal = 'SIGTERM') => {
      if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
      const done = new Promise((r) => child.once('exit', (code) => r(code)));
      child.kill(signal);
      return done;
    },
  };
}

// Klien HTTP sederhana dengan cookie sesi. Mengembalikan { status, headers, body } (body = JSON bila bisa).
export function client(base, defaultHeaders = {}) {
  let cookie = '';
  async function raw(method, url, body, extraHeaders = {}) {
    const headers = { ...defaultHeaders, ...extraHeaders };
    if (cookie) headers.cookie = cookie;
    let payload = body;
    if (body !== undefined && !Buffer.isBuffer(body) && typeof body !== 'string') {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + url, { method, headers, body: payload });
    for (const c of res.headers.getSetCookie()) {
      const kv = c.split(';')[0];
      cookie = /max-age=0/i.test(c) ? '' : kv;
    }
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* bukan JSON */ }
    return { status: res.status, headers: res.headers, body: data };
  }
  return {
    get: (u, h) => raw('GET', u, undefined, h),
    post: (u, b, h) => raw('POST', u, b, h),
    put: (u, b, h) => raw('PUT', u, b, h),
    del: (u, h) => raw('DELETE', u, undefined, h),
    raw,
    get cookie() { return cookie; },
  };
}

export async function adminClient(base, headers = {}) {
  const c = client(base, headers);
  const r = await c.post('/api/auth/login', { username: 'admin', password: 'rahasia123' });
  if (r.status !== 200) throw new Error('login admin gagal: ' + JSON.stringify(r.body));
  return c;
}

// Berkas uji minimal yang sah menurut tanda tangan masing-masing jenis.
export const FIXTURES = {
  png: () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]),
  pdf: () => Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n'),
  svg: () => '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#2f6df0"/></svg>',
  evilSvg: () => '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
};

export const upload = (c, name, data) => c.raw('POST', '/api/admin/upload', data, { 'x-filename': name });

// Membaca nilai tunggal dari database tanpa mengganggu server (WAL memungkinkan pembacaan bersamaan).
export async function sql(dbPath, query, ...args) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return db.prepare(query).get(...args);
  } finally {
    db.close();
  }
}

export async function sqlRun(dbPath, query, ...args) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return db.prepare(query).run(...args);
  } finally {
    db.close();
  }
}

// Membuat arsip .tar.gz mentah tanpa alat luar, termasuk entri yang tidak akan dibuat oleh `tar` biasa
// (path ../ atau absolut, tautan). Dipakai untuk menguji penolakan arsip berbahaya.
// entries: [{ name, data?: Buffer|string, type?: '0'|'1'|'2'|'5', linkname?: string }]
export async function makeTarGz(file, entries) {
  const { gzipSync } = await import('node:zlib');
  const blocks = [];
  const octal = (n, w) => Buffer.from(n.toString(8).padStart(w - 1, '0') + '\0', 'latin1');
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '');
    const type = e.type ?? '0';
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100, 'latin1');
    octal(0o644, 8).copy(h, 100);
    octal(0, 8).copy(h, 108);
    octal(0, 8).copy(h, 116);
    octal(type === '0' ? data.length : 0, 12).copy(h, 124);
    octal(0, 12).copy(h, 136);
    h.fill(0x20, 148, 156); // checksum dihitung dengan kolomnya berisi spasi
    h.write(type, 156, 1, 'latin1');
    if (e.linkname) h.write(e.linkname, 157, 100, 'latin1');
    h.write('ustar\0', 257, 6, 'latin1');
    h.write('00', 263, 2, 'latin1');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');
    blocks.push(h);
    if (type === '0' && data.length) {
      blocks.push(data);
      const rem = data.length % 512;
      if (rem) blocks.push(Buffer.alloc(512 - rem));
    }
  }
  blocks.push(Buffer.alloc(1024));
  fs.writeFileSync(file, gzipSync(Buffer.concat(blocks)));
}
