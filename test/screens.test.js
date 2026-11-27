import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer, client, adminClient } from './helpers.js';

describe('mode layar: antrian atau hanya papan informasi', () => {
  let srv, admin;
  before(async () => { srv = await startServer(); admin = await adminClient(srv.base); });
  after(async () => { await srv.stop(); fs.rmSync(srv.dataDir, { recursive: true, force: true }); });

  it('layar baru menampilkan antrian secara bawaan dan jeda lanjut 20 detik', async () => {
    assert.equal((await admin.post('/api/admin/screens', { name: 'Lobi', slug: 'lobi' })).status, 201);
    const cfg = (await client(srv.base).get('/api/screen/lobi')).body;
    assert.equal(cfg.showQueue, true);
    assert.equal(cfg.resumeSeconds, 20);
  });

  it('mode papan-informasi-saja dan jeda lanjut tersimpan, dibatasi 5..600 detik', async () => {
    const mk = await admin.post('/api/admin/screens', { name: 'Info', slug: 'info', showQueue: false, resumeSeconds: 8 });
    assert.equal(mk.status, 201);
    let cfg = (await client(srv.base).get('/api/screen/info')).body;
    assert.equal(cfg.showQueue, false);
    assert.equal(cfg.resumeSeconds, 8);
    const id = (await admin.get('/api/admin/screens')).body.find((s) => s.slug === 'info').id;
    await admin.put('/api/admin/screens/' + id, { name: 'Info', slug: 'info', showQueue: false, resumeSeconds: 1 });
    assert.equal((await client(srv.base).get('/api/screen/info')).body.resumeSeconds, 5, 'minimum 5 detik');
    await admin.put('/api/admin/screens/' + id, { name: 'Info', slug: 'info', showQueue: false, resumeSeconds: 99999 });
    assert.equal((await client(srv.base).get('/api/screen/info')).body.resumeSeconds, 600, 'maksimum 600 detik');
    await admin.put('/api/admin/screens/' + id, { name: 'Info', slug: 'info', showQueue: false, resumeSeconds: '' });
    cfg = (await client(srv.base).get('/api/screen/info')).body;
    assert.equal(cfg.resumeSeconds, 20, 'kosong = bawaan');
    await admin.put('/api/admin/screens/' + id, { name: 'Info', slug: 'info', showQueue: true });
    assert.equal((await client(srv.base).get('/api/screen/info')).body.showQueue, true);
  });

  it('daftar layar untuk admin memuat mode', async () => {
    const list = (await admin.get('/api/admin/screens')).body;
    assert.ok(list.every((s) => typeof s.showQueue === 'boolean' && s.resumeSeconds >= 5));
  });

  it('basis data lama tanpa kolom mode dimigrasi (layar lama tetap menampilkan antrian)', async () => {
    const { spawnSync } = await import('node:child_process');
    const path = await import('node:path');
    const { tmpDir, ROOT } = await import('./helpers.js');
    const dir = tmpDir('scr-legacy-');
    const prep = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(${JSON.stringify(path.join(dir, 'papan.db'))});
      db.exec("CREATE TABLE screens (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, idle_minutes INTEGER); INSERT INTO screens (slug, name) VALUES ('lama', 'Layar Lama');");
      db.close();`], { encoding: 'utf8' });
    assert.equal(prep.status, 0, prep.stderr);
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
      process.env.DATA_DIR = ${JSON.stringify(dir)};
      const svc = await import(${JSON.stringify(path.join(ROOT, 'server/service.js'))});
      console.log(JSON.stringify(svc.screenConfig('lama')));`], { encoding: 'utf8', env: { ...process.env, DATA_DIR: dir } });
    assert.equal(r.status, 0, r.stderr);
    const cfg = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(cfg.showQueue, true);
    assert.equal(cfg.resumeSeconds, 20);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
