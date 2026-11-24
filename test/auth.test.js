import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer, client, adminClient, sql, sqlRun, tmpDir, sleep } from './helpers.js';

const login = (c, username, password, ip) =>
  c.post('/api/auth/login', { username, password }, ip ? { 'x-forwarded-for': ip } : {});

describe('peran, sesi, dan meja', () => {
  let srv, admin;
  before(async () => {
    srv = await startServer();
    admin = await adminClient(srv.base);
    await admin.post('/api/admin/users', { username: 'budi', name: 'Budi', password: 'password1', counterIds: [1, 2] });
    await admin.post('/api/admin/users', { username: 'sari', name: 'Sari', password: 'password2', counterIds: [1] });
  });
  after(async () => { await srv.stop(); fs.rmSync(srv.dataDir, { recursive: true, force: true }); });

  it('tanpa sesi: 401', async () => {
    const c = client(srv.base);
    assert.equal((await c.get('/api/auth/me')).status, 401);
    assert.equal((await c.post('/api/counter/1/next', {})).status, 401);
    assert.equal((await c.get('/api/admin/users')).status, 401);
  });
  it('login salah: 401 tanpa membocorkan apakah username ada', async () => {
    const c = client(srv.base);
    const a = await login(c, 'admin', 'salah');
    const b = await login(c, 'tidak-ada', 'salah');
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(a.body.error, b.body.error);
  });
  it('cookie sesi HttpOnly dan SameSite=Lax; tidak Secure lewat HTTP polos', async () => {
    const r = await client(srv.base).post('/api/auth/login', { username: 'admin', password: 'rahasia123' });
    const sc = r.headers.getSetCookie()[0];
    assert.match(sc, /HttpOnly/);
    assert.match(sc, /SameSite=Lax/);
    assert.doesNotMatch(sc, /Secure/);
  });
  it('pegawai tidak boleh memakai API admin (403)', async () => {
    const c = client(srv.base);
    await login(c, 'budi', 'password1');
    assert.equal((await c.get('/api/admin/users')).status, 403);
  });
  it('pegawai hanya boleh memilih meja yang diizinkan (403) dan harus memilih meja dulu', async () => {
    const c = client(srv.base);
    await login(c, 'budi', 'password1');
    assert.equal((await c.post('/api/counter/1/next', {})).status, 403);
    assert.equal((await c.post('/api/auth/counter', { counterId: 3 })).status, 403);
    assert.equal((await c.post('/api/auth/counter', { counterId: 1 })).status, 200);
    await c.post('/api/auth/logout', {}); // lepas meja agar tes berikutnya tidak terpengaruh
  });
  it('satu meja hanya untuk satu pegawai (409), dan bebas lagi setelah keluar', async () => {
    const a = client(srv.base); await login(a, 'sari', 'password2');
    const b = client(srv.base); await login(b, 'budi', 'password1');
    assert.equal((await a.post('/api/auth/counter', { counterId: 1 })).status, 200);
    assert.equal((await b.post('/api/auth/counter', { counterId: 1 })).status, 409);
    assert.equal((await a.post('/api/auth/logout', {})).status, 200);
    assert.equal((await b.post('/api/auth/counter', { counterId: 1 })).status, 200);
    await b.post('/api/auth/logout', {});
  });
  it('tidak bisa keluar atau pindah meja saat masih memegang antrian (409)', async () => {
    const c = client(srv.base); await login(c, 'budi', 'password1');
    await c.post('/api/auth/counter', { counterId: 1 });
    await client(srv.base).post('/api/tickets', { categoryId: 1 });
    assert.equal((await c.post('/api/counter/1/next', {})).status, 200);
    assert.equal((await c.post('/api/auth/logout', {})).status, 409);
    assert.equal((await c.post('/api/auth/counter', { counterId: 2 })).status, 409);
    assert.equal((await c.post('/api/counter/1/done', {})).status, 200);
    assert.equal((await c.post('/api/auth/logout', {})).status, 200);
  });
  it('permintaan lintas asal (Origin asing) ditolak (403)', async () => {
    const r = await admin.post('/api/admin/categories', { name: 'X', prefix: 'X' }, { origin: 'http://evil.example' });
    assert.equal(r.status, 403);
  });
  it('akun dinonaktifkan: sesi lama dicabut seketika', async () => {
    await admin.post('/api/admin/users', { username: 'tmp', name: 'Tmp', password: 'password1' });
    const users = (await admin.get('/api/admin/users')).body;
    const tmp = users.find((u) => u.username === 'tmp');
    const c = client(srv.base); await login(c, 'tmp', 'password1');
    assert.equal((await c.get('/api/auth/me')).status, 200);
    await admin.put('/api/admin/users/' + tmp.id, { username: 'tmp', name: 'Tmp', role: 'staff', active: false });
    assert.equal((await c.get('/api/auth/me')).status, 401);
  });
  it('selalu menyisakan minimal satu admin aktif', async () => {
    const me = (await admin.get('/api/auth/me')).body;
    assert.equal((await admin.del('/api/admin/users/' + me.id)).status, 409);
    assert.equal((await admin.put('/api/admin/users/' + me.id, { username: 'admin', name: 'A', role: 'staff', active: true })).status, 409);
  });
  it('password minimal 8 karakter', async () => {
    assert.equal((await admin.post('/api/admin/users', { username: 'pendek', name: 'P', password: 'abc' })).status, 400);
  });
});

describe('pembatas login', () => {
  let dataDir, srv;
  const start = async () => { srv = await startServer({ DATA_DIR: dataDir, TRUST_PROXY: '1' }); return srv; };
  before(async () => {
    dataDir = tmpDir('auth-lim-');
    await start();
    const admin = await adminClient(srv.base);
    await admin.post('/api/admin/users', { username: 'budi', name: 'Budi', password: 'password1' });
  });
  after(async () => { await srv.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  const codes = async (n, ip, user = 'budi', pass = 'salah') => {
    const out = [];
    for (let i = 0; i < n; i++) out.push((await login(client(srv.base), user, pass, ip)).status);
    return out;
  };

  it('5 percobaan salah diproses (401), yang ke-6 dikunci (429) walau password benar', async () => {
    assert.deepEqual(await codes(5, '2.2.2.2'), [401, 401, 401, 401, 401]);
    const r = await login(client(srv.base), 'budi', 'password1', '2.2.2.2');
    assert.equal(r.status, 429);
    assert.match(r.body.error, /menit/);
  });
  it('penguncian BERTAHAN setelah server dimulai ulang', async () => {
    await srv.stop();
    await start();
    assert.equal((await login(client(srv.base), 'budi', 'password1', '2.2.2.2')).status, 429);
  });
  it('alamat lain dan akun lain dari alamat yang sama tidak ikut terkunci', async () => {
    assert.equal((await login(client(srv.base), 'budi', 'password1', '3.3.3.3')).status, 200);
    assert.equal((await login(client(srv.base), 'admin', 'rahasia123', '2.2.2.2')).status, 200);
  });
  it('permintaan paralel tidak menembus batas: tepat 5 yang diverifikasi', async () => {
    const res = await Promise.all(Array.from({ length: 40 }, () => login(client(srv.base), 'budi', 'salah-salah', '4.4.4.4')));
    const s = res.map((r) => r.status);
    assert.equal(s.filter((x) => x === 401).length, 5);
    assert.equal(s.filter((x) => x === 429).length, 35);
  });
  it('kegagalan lebih tua dari 15 menit tidak dihitung lagi', async () => {
    await codes(3, '5.5.5.5');
    await srv.stop();
    await sqlRun(dataDir + '/papan.db', 'UPDATE login_attempts SET updated_at = updated_at - ? WHERE key = ?', 16 * 60000, 'acct:5.5.5.5|budi');
    await start();
    assert.deepEqual(await codes(5, '5.5.5.5'), [401, 401, 401, 401, 401]);
  });
  it('kunci yang sudah lewat waktunya dibuka (akun dan alamat)', async () => {
    await srv.stop();
    await sqlRun(dataDir + '/papan.db', 'UPDATE login_attempts SET until = ? WHERE key LIKE ?', Date.now() - 1000, '%4.4.4.4%');
    await start();
    assert.equal((await login(client(srv.base), 'budi', 'password1', '4.4.4.4')).status, 200);
    assert.deepEqual(await codes(5, '4.4.4.4'), [401, 401, 401, 401, 401], 'hitungan mulai dari nol');
  });
  it('batas per alamat menahan tebakan banyak username (password spraying)', async () => {
    const out = [];
    for (let i = 1; i <= 20; i++) out.push((await login(client(srv.base), 'user' + i, 'apa-saja', '6.6.6.6')).status);
    assert.ok(out.every((s) => s === 401));
    assert.equal((await login(client(srv.base), 'user21', 'apa-saja', '6.6.6.6')).status, 429);
    assert.equal((await login(client(srv.base), 'admin', 'rahasia123', '6.6.6.6')).status, 429, 'alamat terkunci menahan juga login sah');
    assert.equal((await login(client(srv.base), 'admin', 'rahasia123', '7.7.7.7')).status, 200, 'alamat lain tidak terpengaruh');
  });
  it('login berhasil menghapus hitungan akun dan menurunkan hitungan alamat satu tingkat', async () => {
    for (const u of ['xa', 'xb', 'xc']) await login(client(srv.base), u, 'salah', '8.8.8.8');
    await login(client(srv.base), 'admin', 'rahasia123', '8.8.8.8');
    assert.equal((await sql(dataDir + '/papan.db', "SELECT count FROM login_attempts WHERE key = 'ip:8.8.8.8'")).count, 3);
    assert.equal(await sql(dataDir + '/papan.db', "SELECT count FROM login_attempts WHERE key = 'acct:8.8.8.8|admin'"), undefined);
  });
  it('username "*" tidak bertabrakan dengan kunci alamat', async () => {
    assert.deepEqual(await codes(5, '9.9.9.9', '*'), [401, 401, 401, 401, 401]);
    assert.equal((await login(client(srv.base), '*', 'salah', '9.9.9.9')).status, 429);
    assert.equal((await login(client(srv.base), 'admin', 'rahasia123', '9.9.9.9')).status, 200);
  });
  it('tanpa TRUST_PROXY, X-Forwarded-For palsu tidak menghindari kunci', async () => {
    await srv.stop();
    srv = await startServer({ DATA_DIR: dataDir, TRUST_PROXY: undefined });
    const out = [];
    for (let i = 1; i <= 6; i++) out.push((await login(client(srv.base), 'budi', 'salah', `1.2.3.${i}`)).status);
    assert.deepEqual(out, [401, 401, 401, 401, 401, 429]);
  });
});
