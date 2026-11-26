import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startServer, client, adminClient, upload, tmpDir, ROOT, sleep, waitFor } from './helpers.js';

process.env.DATA_DIR = tmpDir('content-unit-');
const { parseYoutubeId } = await import('../server/service.js');

describe('parseYoutubeId', () => {
  const ID = 'dQw4w9WgXcQ';
  it('menerima bentuk tautan umum', () => {
    for (const u of [
      `https://www.youtube.com/watch?v=${ID}`,
      `https://youtube.com/watch?v=${ID}&t=42s&list=PL1`,
      `http://m.youtube.com/watch?v=${ID}`,
      `https://music.youtube.com/watch?v=${ID}`,
      `https://youtu.be/${ID}`,
      `https://youtu.be/${ID}?si=abc`,
      `https://www.youtube.com/shorts/${ID}`,
      `https://www.youtube.com/embed/${ID}`,
      `https://www.youtube.com/live/${ID}?feature=share`,
      `https://www.youtube-nocookie.com/embed/${ID}`,
      `  https://youtu.be/${ID}  `,
    ]) assert.equal(parseYoutubeId(u), ID, u);
  });
  it('menolak host lain, skema berbahaya, dan ID rusak', () => {
    for (const u of [
      '', null, undefined, 'bukan url', `javascript:alert(1)//youtu.be/${ID}`, `ftp://youtu.be/${ID}`,
      `https://evil.example/watch?v=${ID}`, `https://youtube.com.evil.example/watch?v=${ID}`,
      `https://notyoutube.com/watch?v=${ID}`, 'https://www.youtube.com/watch?v=pendek',
      'https://www.youtube.com/watch', 'https://www.youtube.com/', `https://www.youtube.com/watch?v=${ID}x`,
      'https://youtu.be/', 'https://www.youtube.com/playlist?list=PL12345678901',
    ]) assert.equal(parseYoutubeId(u), null, String(u));
  });
});

describe('API konten: YouTube, urutan, dan isi teks', () => {
  let srv, admin;
  before(async () => { srv = await startServer(); admin = await adminClient(srv.base); });
  after(async () => { await srv.stop(); fs.rmSync(srv.dataDir, { recursive: true, force: true }); });

  const list = async () => (await admin.get('/api/admin/content')).body;
  const mk = async (title, extra = {}) => (await admin.post('/api/admin/content', { type: 'text', title, body: title, duration: 10, ...extra }));

  it('konten YouTube tersimpan sebagai tautan kanonik dan muncul di playlist dengan videoId', async () => {
    const r = await admin.post('/api/admin/content', { type: 'youtube', title: 'Profil', url: 'https://youtu.be/dQw4w9WgXcQ?si=x', duration: 0 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const row = (await list()).find((c) => c.id === r.body.id);
    assert.equal(row.url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(row.duration, 0, '0 = sampai video selesai');
    assert.equal(row.file, '');
    const pl = (await client(srv.base).get('/api/playlist')).body;
    const item = pl.main.find((x) => x.id === r.body.id);
    assert.equal(item.videoId, 'dQw4w9WgXcQ');
    assert.equal(item.type, 'youtube');
  });

  it('tautan YouTube tidak valid, tanpa tautan, atau untuk screensaver ditolak', async () => {
    assert.equal((await admin.post('/api/admin/content', { type: 'youtube', url: 'https://evil.example/watch?v=dQw4w9WgXcQ' })).status, 400);
    assert.equal((await admin.post('/api/admin/content', { type: 'youtube' })).status, 400);
    assert.equal((await admin.post('/api/admin/content', { type: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ', screensaver: true })).status, 400);
  });

  it('durasi YouTube dibatasi minimal 3 detik bila bukan 0', async () => {
    const r = await admin.post('/api/admin/content', { type: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ', duration: 1 });
    assert.equal((await list()).find((c) => c.id === r.body.id).duration, 3);
  });

  it('konten baru ditambahkan di akhir urutan, dan sunting tidak mengubah urutan', async () => {
    const a = (await mk('Urut-A')).body.id; const b = (await mk('Urut-B')).body.id; const c = (await mk('Urut-C')).body.id;
    let ids = (await list()).map((x) => x.id);
    assert.deepEqual(ids.slice(-3), [a, b, c]);
    await admin.put('/api/admin/content/' + a, { type: 'text', title: 'Urut-A2', body: 'x', duration: 10, sort: 999 });
    ids = (await list()).map((x) => x.id);
    assert.deepEqual(ids.slice(-3), [a, b, c], 'field sort dari klien diabaikan');
  });

  it('reorder menulis urutan baru dan memengaruhi playlist', async () => {
    const all = (await list()).map((x) => x.id);
    const reversed = [...all].reverse();
    const r = await admin.post('/api/admin/content/reorder', { ids: reversed });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((await list()).map((x) => x.id), reversed);
    const pl = (await client(srv.base).get('/api/playlist')).body.main.map((x) => x.id);
    assert.deepEqual(pl, reversed.filter((id) => pl.includes(id)));
  });

  it('reorder menolak daftar tak lengkap (409), ganda, bukan angka, dan tanpa login', async () => {
    const all = (await list()).map((x) => x.id);
    assert.equal((await admin.post('/api/admin/content/reorder', { ids: all.slice(1) })).status, 409);
    assert.equal((await admin.post('/api/admin/content/reorder', { ids: [...all, 99999] })).status, 409);
    assert.equal((await admin.post('/api/admin/content/reorder', { ids: [all[0], all[0], ...all.slice(2)] })).status, 400);
    assert.equal((await admin.post('/api/admin/content/reorder', { ids: ['a', 'b'] })).status, 400);
    assert.equal((await admin.post('/api/admin/content/reorder', {})).status, 400);
    assert.equal((await client(srv.base).post('/api/admin/content/reorder', { ids: all })).status, 401);
  });

  it('isi teks (markdown) dibatasi 20.000 karakter', async () => {
    const r = await mk('Panjang', { body: '# J\n' + 'x'.repeat(30000) });
    const row = (await list()).find((c) => c.id === r.body.id);
    assert.equal(row.body.length, 20000);
  });
});

describe('migrasi basis data lama (tanpa tipe youtube)', () => {
  it('mengubah tabel contents tanpa kehilangan data dan menjaga tautan layar', () => {
    const dir = tmpDir('legacy-');
    // Skema lama diketik langsung, persis sebelum tipe YouTube ada.
    const prep = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(${JSON.stringify(path.join(dir, 'papan.db'))});
      db.exec(\`
        PRAGMA foreign_keys = ON;
        CREATE TABLE contents (id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL CHECK (type IN ('text','image','video','pdf')),
          title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', file TEXT NOT NULL DEFAULT '',
          duration INTEGER NOT NULL DEFAULT 15, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
          screensaver INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE screens (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, idle_minutes INTEGER);
        CREATE TABLE content_screens (content_id INTEGER NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
          screen_id INTEGER NOT NULL REFERENCES screens(id) ON DELETE CASCADE, PRIMARY KEY (content_id, screen_id));
        INSERT INTO contents (type, title, body, duration, sort) VALUES ('text', 'Lama', 'isi lama', 20, 7);
        INSERT INTO screens (slug, name) VALUES ('lobi', 'Lobi');
        INSERT INTO content_screens VALUES (1, 1);
      \`);
      db.close();`], { encoding: 'utf8' });
    assert.equal(prep.status, 0, prep.stderr);
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
      process.env.DATA_DIR = ${JSON.stringify(dir)};
      const { db } = await import(${JSON.stringify(path.join(ROOT, 'server/db.js'))});
      const old = db.prepare("SELECT title, body, duration, sort, url FROM contents WHERE title = 'Lama'").get();
      db.prepare("INSERT INTO contents (type, title, url) VALUES ('youtube', 'Y', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')").run();
      const link = db.prepare('SELECT COUNT(*) AS n FROM content_screens WHERE content_id = ?').get(1).n;
      const fk = db.prepare('PRAGMA foreign_key_check').all().length;
      const fkOn = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
      console.log(JSON.stringify({ old, link, fk, fkOn }));`], { encoding: 'utf8', env: { ...process.env, DATA_DIR: dir } });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.deepEqual(out.old, { title: 'Lama', body: 'isi lama', duration: 20, sort: 7, url: '' });
    assert.equal(out.link, 1, 'tautan konten ke layar utuh');
    assert.equal(out.fk, 0, 'tidak ada pelanggaran kunci asing');
    assert.equal(out.fkOn, 1, 'foreign_keys kembali aktif');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
describe('unggah video: progres konversi', { skip: !haveFfmpeg && 'ffmpeg tidak tersedia' }, () => {
  let srv, admin;
  before(async () => { srv = await startServer(); admin = await adminClient(srv.base); });
  after(async () => { await srv.stop(); fs.rmSync(srv.dataDir, { recursive: true, force: true }); });

  it('status memuat persen yang naik monoton dan berakhir ready', { timeout: 90000 }, async () => {
    const d = tmpDir('prog-');
    const clip = path.join(d, 'long.mp4');
    const gen = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=duration=40:size=1920x1080:rate=30', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip]);
    assert.equal(gen.status, 0);
    const r = await upload(admin, 'long.mp4', fs.readFileSync(clip));
    assert.equal(r.status, 202);
    const seen = [];
    let last;
    await waitFor(async () => {
      last = (await admin.get('/api/admin/upload/' + r.body.file + '/status')).body;
      if (last.status === 'processing') seen.push(last.percent);
      else return true;
      await sleep(60);
      return false;
    }, 60000, 'konversi selesai');
    assert.equal(last.status, 'ready');
    assert.ok(seen.length >= 1, 'status processing teramati');
    assert.ok(seen.every((p) => Number.isInteger(p) && p >= 0 && p <= 99), 'persen 0..99 saat diproses: ' + seen.join(','));
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b), 'persen tidak pernah turun');
    assert.ok(Math.max(...seen) > 0, 'persen sempat naik di atas 0 (' + seen.join(',') + ')');
    fs.rmSync(d, { recursive: true, force: true });
  });
});
