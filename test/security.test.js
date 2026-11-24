import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import WebSocket from 'ws';
import { startServer, client, adminClient, upload, FIXTURES, tmpDir, sleep, ROOT } from './helpers.js';

// Mengirim permintaan HTTP mentah lewat soket (untuk target dan header yang tidak bisa dibentuk fetch).
function rawRequest(port, payload, waitMs = 600) {
  return new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1', () => c.write(payload));
    let data = '';
    c.on('data', (d) => { data += d; });
    c.on('error', () => {});
    c.on('close', () => resolve(data));
    setTimeout(() => { c.destroy(); resolve(data); }, waitMs);
  });
}

describe('header keamanan', () => {
  let srv, admin;
  before(async () => { srv = await startServer(); admin = await adminClient(srv.base); });
  after(async () => { await srv.stop(); fs.rmSync(srv.dataDir, { recursive: true, force: true }); });

  const h = async (url, c = client(srv.base)) => (await c.get(url)).headers;

  it('halaman: CSP tanpa skrip inline, nosniff, anti-framing, referrer, permissions', async () => {
    const headers = await h('/');
    const csp = headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self';/);
    assert.doesNotMatch(csp.split(';').find((d) => d.trim().startsWith('script-src')), /unsafe/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /frame-ancestors 'self'/);
    assert.equal(headers.get('x-content-type-options'), 'nosniff');
    assert.equal(headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(headers.get('referrer-policy'), 'no-referrer');
    assert.ok(headers.get('permissions-policy'));
  });
  it('HSTS tidak dikirim lewat HTTP polos', async () => {
    assert.equal((await h('/')).get('strict-transport-security'), null);
  });
  it('API dan galat 404 juga membawa nosniff', async () => {
    assert.equal((await h('/api/time')).get('x-content-type-options'), 'nosniff');
    assert.equal((await h('/tidak-ada')).get('x-content-type-options'), 'nosniff');
  });
  it('tidak ada skrip inline di halaman HTML (CSP akan memblokirnya)', () => {
    for (const f of fs.readdirSync(path.join(ROOT, 'public')).filter((x) => x.endsWith('.html'))) {
      const html = fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');
      assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/i.test(html), `${f} memuat skrip inline`);
      assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(html), `${f} memuat atribut penangan peristiwa inline`);
    }
  });
  it('SVG unggahan disajikan dengan CSP sandbox; PDF tanpa CSP (agar penampil PDF jalan)', async () => {
    const svg = (await upload(admin, 'logo.svg', FIXTURES.svg())).body.file;
    const pdf = (await upload(admin, 'a.pdf', FIXTURES.pdf())).body.file;
    const s = await h('/uploads/' + svg);
    assert.match(s.get('content-security-policy'), /sandbox/);
    assert.equal(s.get('content-type'), 'image/svg+xml');
    const p = await h('/uploads/' + pdf);
    assert.equal(p.get('content-security-policy'), null);
    assert.equal(p.get('x-content-type-options'), 'nosniff');
  });
  it('/healthz minim: hanya status dan uptime', async () => {
    const r = await client(srv.base).get('/healthz');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['ok', 'uptime']);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });
});

describe('HSTS lewat HTTPS', () => {
  const haveOpenssl = spawnSync('openssl', ['version']).status === 0;
  it('dikirim saat dilayani lewat TLS', { skip: !haveOpenssl && 'openssl tidak tersedia' }, async () => {
    const d = tmpDir('tls-');
    const cert = path.join(d, 'c.pem');
    const key = path.join(d, 'k.pem');
    const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', key, '-out', cert], { stdio: 'ignore' });
    assert.equal(r.status, 0);
    // fetch menolak sertifikat self-signed; pakai modul https langsung
    const { default: https } = await import('node:https');
    const { startServer: start } = await import('./helpers.js');
    const srv = await (async () => {
      // startServer memeriksa /healthz lewat http; untuk TLS jalankan manual
      const { spawn } = await import('node:child_process');
      const { freePort, waitFor } = await import('./helpers.js');
      const port = await freePort();
      const child = spawn(process.execPath, ['server/index.js'], {
        cwd: ROOT, stdio: 'ignore',
        env: { ...process.env, NODE_OPTIONS: '--disable-warning=ExperimentalWarning', DATA_DIR: d, PORT: String(port), ADMIN_PASSWORD: 'rahasia123', TLS_CERT: cert, TLS_KEY: key },
      });
      const get = () => new Promise((res, rej) => https.get({ host: '127.0.0.1', port, path: '/', rejectUnauthorized: false }, (resp) => { resp.resume(); res(resp.headers); }).on('error', rej));
      await waitFor(get, 15000, 'server TLS');
      const headers = await get();
      child.kill('SIGTERM');
      return headers;
    })();
    assert.match(srv['strict-transport-security'], /max-age=\d+/);
    void start;
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe('input dan permintaan rusak', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.stop(); fs.rmSync(srv.dataDir, { recursive: true, force: true }); });

  it('path dengan encoding rusak atau NUL = 400', async () => {
    const c = client(srv.base);
    assert.equal((await c.get('/%E0%A4%A')).status, 400);
    assert.equal((await c.get('/index%00.html')).status, 400);
  });
  it('path traversal ke luar folder publik tidak berhasil', async () => {
    const c = client(srv.base);
    for (const p of ['/../package.json', '/%2e%2e/package.json', '/js/../../package.json', '/..%2fpackage.json']) {
      const r = await c.get(p);
      assert.ok([400, 403, 404].includes(r.status), `${p} -> ${r.status}`);
      assert.ok(!String(r.body).includes('papan-informasi"'), `${p} membocorkan package.json`);
    }
  });
  it('target permintaan rusak menghasilkan 400 dan server tetap hidup', async () => {
    const a = await rawRequest(srv.port, 'GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    const b = await rawRequest(srv.port, 'GET http://[::1 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    assert.match(a, /^HTTP\/1\.1 400/);
    assert.match(b, /^HTTP\/1\.1 400/);
    assert.equal((await client(srv.base).get('/healthz')).status, 200);
    assert.ok(!srv.exited());
  });
  it('JSON rusak = 400; badan terlalu besar = 413', async () => {
    const c = client(srv.base);
    assert.equal((await c.raw('POST', '/api/auth/login', '{bukan json', { 'content-type': 'application/json' })).status, 400);
    const big = JSON.stringify({ username: 'x'.repeat(2_000_000), password: 'y' });
    const r = await c.raw('POST', '/api/auth/login', big, { 'content-type': 'application/json' }).catch((e) => ({ status: 'putus:' + e.cause?.code }));
    assert.ok(r.status === 413 || String(r.status).startsWith('putus'), 'badan 2 MB harus ditolak atau diputus, dapat: ' + r.status);
    assert.equal((await client(srv.base).get('/healthz')).status, 200);
  });
  it('Content-Length melebihi batas unggah ditolak sejak header (413) tanpa menunggu badan', async () => {
    const admin = await adminClient(srv.base);
    const cookie = admin.cookie;
    const t0 = Date.now();
    const res = await rawRequest(srv.port,
      `POST /api/admin/upload HTTP/1.1\r\nHost: x\r\nCookie: ${cookie}\r\nx-filename: besar.mp4\r\nContent-Length: 400000000\r\n\r\n`, 3000);
    assert.match(res, /^HTTP\/1\.1 413/);
    assert.ok(Date.now() - t0 < 2500, 'harus segera, bukan menunggu badan');
  });
});

describe('unggahan lewat HTTP', () => {
  let srv, admin;
  before(async () => { srv = await startServer(); admin = await adminClient(srv.base); });
  after(async () => { await srv.stop(); fs.rmSync(srv.dataDir, { recursive: true, force: true }); });
  const files = () => fs.readdirSync(path.join(srv.dataDir, 'uploads'));

  it('SVG berskrip dan HTML bernama .png ditolak (400) dan tidak meninggalkan berkas', async () => {
    const a = await upload(admin, 'evil.svg', FIXTURES.evilSvg());
    assert.equal(a.status, 400);
    assert.match(a.body.error, /<script>/);
    assert.equal((await upload(admin, 'fake.png', '<html><script>alert(1)</script></html>')).status, 400);
    assert.equal(files().length, 0);
  });
  it('berkas asli diterima (PNG, PDF, SVG bersih)', async () => {
    assert.equal((await upload(admin, 'a.png', FIXTURES.png())).status, 201);
    assert.equal((await upload(admin, 'a.pdf', FIXTURES.pdf())).status, 201);
    assert.equal((await upload(admin, 'a.svg', FIXTURES.svg())).status, 201);
  });
  it('ekstensi tak dikenal ditolak', async () => {
    assert.equal((await upload(admin, 'a.exe', 'MZ')).status, 400);
  });
  it('klien memutus koneksi di tengah unggahan: tidak ada berkas setengah jadi', async () => {
    const before = files().length;
    await new Promise((resolve) => {
      const c = net.connect(srv.port, '127.0.0.1', () => {
        c.write(`POST /api/admin/upload HTTP/1.1\r\nHost: x\r\nCookie: ${admin.cookie}\r\nx-filename: putus.pdf\r\nContent-Length: 5000000\r\n\r\n%PDF-1.4 sebagian`);
        setTimeout(() => { c.destroy(); resolve(); }, 300);
      });
      c.on('error', () => {});
    });
    await sleep(300);
    assert.equal(files().length, before);
    assert.equal((await client(srv.base).get('/healthz')).status, 200);
  });
  it('hanya admin yang boleh mengunggah (401 tanpa sesi)', async () => {
    assert.equal((await upload(client(srv.base), 'a.png', FIXTURES.png())).status, 401);
  });
});

describe('validasi lewat API admin', () => {
  let srv, admin;
  before(async () => { srv = await startServer(); admin = await adminClient(srv.base); });
  after(async () => { await srv.stop(); fs.rmSync(srv.dataDir, { recursive: true, force: true }); });

  it('prefix, slug, username, logo, dan zona waktu berbahaya ditolak', async () => {
    const P = `"><img src=x onerror=window.__xss=1>`;
    assert.equal((await admin.post('/api/admin/categories', { name: 'a', prefix: P })).status, 400);
    assert.equal((await admin.post('/api/admin/screens', { name: 'a', slug: P })).status, 400);
    assert.equal((await admin.post('/api/admin/users', { username: P, name: 'a', password: 'password1' })).status, 400);
    assert.equal((await admin.put('/api/admin/settings', { org_logo: P })).status, 400);
    assert.equal((await admin.put('/api/admin/settings', { timezone: 'Mars/Phobos' })).status, 400);
    assert.equal((await admin.get('/api/state')).status, 200, 'API tetap sehat setelah zona waktu buruk ditolak');
  });
  it('nama berkas konten harus hasil unggahan dan cocok dengan jenisnya', async () => {
    assert.equal((await admin.post('/api/admin/content', { type: 'image', file: '../../etc/passwd', duration: 5 })).status, 400);
    const pdf = (await upload(admin, 'a.pdf', FIXTURES.pdf())).body.file;
    assert.equal((await admin.post('/api/admin/content', { type: 'image', file: pdf, duration: 5 })).status, 400);
    assert.equal((await admin.post('/api/admin/content', { type: 'pdf', file: pdf, duration: 5 })).status, 201);
  });
  it('GET /api/settings publik tidak membocorkan kunci VAPID atau hash', async () => {
    const t = JSON.stringify((await client(srv.base).get('/api/settings')).body);
    assert.doesNotMatch(t, /vapid|scrypt|password/i);
  });
});

describe('pembatasan laju', () => {
  let srv;
  before(async () => { srv = await startServer({ TICKET_RATE: '5' }); });
  after(async () => { await srv.stop(); fs.rmSync(srv.dataDir, { recursive: true, force: true }); });

  it('pengambilan nomor melewati batas mendapat 429 dengan Retry-After', async () => {
    const out = [];
    let last;
    for (let i = 0; i < 7; i++) { last = await client(srv.base).post('/api/tickets', { categoryId: 1 }); out.push(last.status); }
    assert.deepEqual(out, [201, 201, 201, 201, 201, 429, 429]);
    assert.ok(Number(last.headers.get('retry-after')) >= 1);
  });
});

describe('WebSocket', () => {
  let srv;
  before(async () => { srv = await startServer({ WS_MAX_PER_IP: '3' }); });
  after(async () => { await srv.stop(); fs.rmSync(srv.dataDir, { recursive: true, force: true }); });
  const open = (port) => new Promise((resolve) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    w.on('open', () => resolve(w));
    w.on('unexpected-response', (_rq, rs) => resolve('ditolak ' + rs.statusCode));
    w.on('error', () => {});
  });

  it('koneksi ke-4 dari satu alamat ditolak (429); slot bebas setelah koneksi tertutup', async () => {
    const [a, b, c] = [await open(srv.port), await open(srv.port), await open(srv.port)];
    assert.equal(await open(srv.port), 'ditolak 429');
    const closed = new Promise((r) => a.on('close', r));
    a.close();
    await closed;
    await sleep(200);
    const e = await open(srv.port);
    assert.notEqual(typeof e, 'string');
    for (const w of [b, c, e]) w.close();
  });
  it('pesan klien di atas 1 KB memutus koneksi (1009) dan server tetap hidup', async () => {
    // Slot dari tes sebelumnya dibebaskan secara asinkron; tunggu sampai koneksi baru diterima.
    let w = 'ditolak';
    for (let i = 0; i < 40 && typeof w === 'string'; i++) { w = await open(srv.port); if (typeof w === 'string') await sleep(50); }
    assert.notEqual(typeof w, 'string', 'tidak ada slot koneksi yang bebas');
    const code = new Promise((r) => w.on('close', r));
    w.send('x'.repeat(5000));
    assert.equal(await code, 1009);
    assert.equal((await client(srv.base).get('/healthz')).status, 200);
    assert.ok(!srv.exited());
  });
});

describe('log audit', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.stop(); fs.rmSync(srv.dataDir, { recursive: true, force: true }); });

  it('mencatat kejadian penting tanpa password, dan tidak bisa dipalsukan lewat newline', async () => {
    const admin = await adminClient(srv.base);
    await client(srv.base).post('/api/auth/login', { username: 'budi', password: 'salah' });
    await client(srv.base).post('/api/auth/login', { username: 'kata-sandi-saya-123!\nAUDIT {"event":"palsu"}', password: 'x' });
    await admin.post('/api/admin/users', { username: 'budi', name: 'Budi', password: 'SANGAT-RAHASIA-9' });
    await admin.put('/api/admin/settings', { org_name: 'Dinas Uji' });
    await sleep(300);
    const lines = srv.logs().split('\n').filter((l) => l.startsWith('AUDIT '));
    const events = lines.map((l) => JSON.parse(l.slice(6)));   // semua baris harus JSON valid
    const names = events.map((e) => e.event);
    for (const expected of ['login_ok', 'login_failed', 'user_created', 'settings_changed']) assert.ok(names.includes(expected), expected);
    assert.ok(!names.includes('palsu'), 'tidak ada kejadian palsu dari newline');
    assert.ok(events.some((e) => e.username === '(bentuk tidak valid)'), 'username mencurigakan tidak dicatat apa adanya');
    const log = srv.logs();
    assert.ok(!log.includes('SANGAT-RAHASIA'), 'password pegawai muncul di log');
    assert.ok(!log.includes('rahasia123'), 'password admin muncul di log');
    assert.ok(!log.includes('kata-sandi-saya-123'), 'isi kolom username yang mencurigakan tercatat');
  });
});

describe('slowloris (lambat, aktifkan dengan SLOW_TESTS=1)', { skip: !process.env.SLOW_TESTS && 'set SLOW_TESTS=1 untuk menjalankan' }, () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.stop(); fs.rmSync(srv.dataDir, { recursive: true, force: true }); });

  it('header yang tidak pernah lengkap diputus dalam ~25 detik (408)', { timeout: 40000 }, async () => {
    const res = await rawRequest(srv.port, 'GET /api/time HTTP/1.1\r\nHost: x\r\n', 35000);
    assert.match(res, /^HTTP\/1\.1 408/);
  });
  it('badan JSON yang tak kunjung selesai diputus dalam ~15 detik', { timeout: 30000 }, async () => {
    const t0 = Date.now();
    await rawRequest(srv.port, 'POST /api/auth/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"user', 25000);
    const s = (Date.now() - t0) / 1000;
    assert.ok(s >= 14 && s < 20, `diputus setelah ${s} dtk`);
  });
});
