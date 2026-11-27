import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import WebSocket from 'ws';
import {
  ROOT, startServer, client, adminClient, upload, FIXTURES, tmpDir, sleep, waitFor, sql, makeTarGz,
} from './helpers.js';

const haveTar = spawnSync('tar', ['--version']).status === 0;
const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const NODE_ENV = { ...process.env, NODE_OPTIONS: '--disable-warning=ExperimentalWarning' };

function script(name, args, env = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', name), ...args], { encoding: 'utf8', env: { ...NODE_ENV, ...env } });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const tree = (dir) => {
  const out = [];
  const walk = (d) => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n); fs.statSync(p).isDirectory() ? walk(p) : out.push(path.relative(dir, p) + ':' + sha(p)); } };
  if (fs.existsSync(dir)) walk(dir);
  return out.join('\n');
};

describe('penutupan anggun', () => {
  it('SIGTERM saat idle: keluar bersih (kode 0) dengan cepat, berkas PID dihapus', async () => {
    const srv = await startServer();
    assert.equal(fs.readFileSync(path.join(srv.dataDir, 'papan.pid'), 'utf8').trim(), String(srv.child.pid));
    const t0 = Date.now();
    const code = await srv.stop('SIGTERM');
    assert.equal(code, 0);
    assert.ok(Date.now() - t0 < 3000, 'harus cepat saat idle');
    assert.match(srv.logs(), /berhenti dengan bersih/);
    assert.ok(!fs.existsSync(path.join(srv.dataDir, 'papan.pid')));
    rm(srv.dataDir);
  });

  it('WebSocket menerima kode 1001, dan unggahan yang menggantung dibuang saat berhenti', async () => {
    const srv = await startServer();
    const admin = await adminClient(srv.base);
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
    await new Promise((r) => ws.on('open', r));
    const wsClose = new Promise((r) => ws.on('close', r));
    ws.on('error', () => {});
    const hang = net.connect(srv.port, '127.0.0.1', () => {
      hang.write(`POST /api/admin/upload HTTP/1.1\r\nHost: x\r\nCookie: ${admin.cookie}\r\nx-filename: a.pdf\r\nContent-Length: 5000000\r\n\r\n%PDF-1.4 sebagian`);
    });
    hang.on('error', () => {});
    await waitFor(() => fs.readdirSync(path.join(srv.dataDir, 'uploads')).length === 1, 3000, 'unggahan mulai');
    const t0 = Date.now();
    const code = await srv.stop('SIGTERM');
    assert.equal(await wsClose, 1001);
    assert.equal(code, 0, 'keluar bersih, bukan paksa');
    assert.ok(Date.now() - t0 < 9000, 'di bawah batas 10 detik');
    assert.equal(fs.readdirSync(path.join(srv.dataDir, 'uploads')).length, 0, 'unggahan setengah jadi dihapus');
    assert.match(srv.logs(), /berhenti dengan bersih/);
    hang.destroy();
    rm(srv.dataDir);
  });

  it('SIGTERM saat ffmpeg berjalan: ffmpeg dihentikan, tidak ada .part/.src tersisa', { skip: !haveFfmpeg && 'ffmpeg tidak tersedia', timeout: 90000 }, async () => {
    const d = tmpDir('ff-');
    const clip = path.join(d, 'long.mp4');
    const gen = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=duration=40:size=1920x1080:rate=30', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip]);
    assert.equal(gen.status, 0);
    const srv = await startServer();
    const admin = await adminClient(srv.base);
    const r = await upload(admin, 'long.mp4', fs.readFileSync(clip));
    assert.equal(r.status, 202);
    const up = path.join(srv.dataDir, 'uploads');
    await waitFor(() => fs.readdirSync(up).some((f) => f.endsWith('.part.mp4')), 10000, 'konversi mulai');
    // Hanya ffmpeg milik server ini yang diperiksa (pgrep global ikut menangkap ffmpeg tes lain yang berjalan paralel).
    const kids = spawnSync('pgrep', ['-x', '-P', String(srv.child.pid), 'ffmpeg'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(Number);
    assert.ok(kids.length >= 1, 'ffmpeg anak server sedang berjalan sebelum SIGTERM');
    const code = await srv.stop('SIGTERM');
    assert.equal(code, 0);
    assert.deepEqual(fs.readdirSync(up).filter((f) => /\.part|\.src\./.test(f)), []);
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    assert.deepEqual(kids.filter(alive), [], 'tidak ada ffmpeg yatim');
    rm(srv.dataDir); rm(d);
  });

  it('/healthz menjawab 200 saat sehat', async () => {
    const srv = await startServer();
    const r = await client(srv.base).get('/healthz');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    await srv.stop();
    rm(srv.dataDir);
  });

  it('dbOk() bernilai false setelah database ditutup (cabang 503)', async () => {
    const d = tmpDir('dbok-');
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      process.env.DATA_DIR = ${JSON.stringify(d)};
      const m = await import(${JSON.stringify(path.join(ROOT, 'server/db.js'))});
      const a = m.dbOk(); m.db.close(); const b = m.dbOk();
      console.log(JSON.stringify([a, b]));`], { encoding: 'utf8', env: NODE_ENV });
    assert.equal(r.stdout.trim(), '[true,false]');
    rm(d);
  });

  it('HOST=127.0.0.1: tidak dapat dijangkau lewat alamat non-loopback', async () => {
    const { networkInterfaces } = await import('node:os');
    const other = Object.values(networkInterfaces()).flat().find((i) => i && !i.internal && i.family === 'IPv4');
    if (!other) return; // tidak ada antarmuka lain untuk diuji
    const srv = await startServer({ HOST: '127.0.0.1' });
    const reach = await fetch(`http://${other.address}:${srv.port}/healthz`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
    assert.equal(reach, false);
    assert.equal((await client(srv.base).get('/healthz')).status, 200);
    await srv.stop();
    rm(srv.dataDir);
  });
});

describe('backup dan restore', { skip: !haveTar && 'tar tidak tersedia' }, () => {
  let srv, root, src, out;
  before(async () => {
    root = tmpDir('bk-');
    src = path.join(root, 'src');
    out = path.join(root, 'out');
    srv = await startServer({ DATA_DIR: src, TICKET_RATE: '1000000' });
    const admin = await adminClient(srv.base);
    await admin.post('/api/admin/users', { username: 'budi', name: 'Budi', password: 'password1', counterIds: [1] });
    await upload(admin, 'a.png', FIXTURES.png());
    await upload(admin, 'a.pdf', FIXTURES.pdf());
    await admin.put('/api/admin/settings', { org_name: 'Dinas Backup Uji' });
    for (let i = 0; i < 20; i++) await client(srv.base).post('/api/tickets', { categoryId: 1 });
  });
  after(async () => { await srv.stop(); rm(root); });

  const newestArchive = (dir = out) => path.join(dir, fs.readdirSync(dir).filter((f) => /^papan-backup-.*\.tar\.gz$/.test(f)).sort().pop());

  it('backup saat server menulis: snapshot konsisten, berizin 0600, tanpa sisa sementara', async () => {
    const before = (await sql(src + '/papan.db', 'SELECT COUNT(*) n FROM tickets')).n;
    let stop = false;
    let done = 0;
    const writers = Array.from({ length: 3 }, async () => {
      const c = client(srv.base);
      while (!stop) { await c.post('/api/tickets', { categoryId: 1 + Math.floor(Math.random() * 2) }); done += 1; }
    });
    // Tunggu sampai penulisan benar-benar berjalan (mesin CI lambat), bukan jeda waktu tetap.
    for (let i = 0; i < 100 && done < 30; i++) await sleep(100);
    const r = script('backup.js', ['--data', src, '--out', out, '--keep', '0']);
    stop = true;
    await Promise.all(writers);
    assert.equal(r.code, 0, r.out);
    const after = (await sql(src + '/papan.db', 'SELECT COUNT(*) n FROM tickets')).n;
    assert.ok(after - before >= 30, 'penulisan paralel harus benar-benar terjadi (' + (after - before) + ')');

    const arc = newestArchive();
    assert.equal((fs.statSync(arc).mode & 0o777).toString(8), '600');
    assert.equal((fs.statSync(out).mode & 0o777).toString(8), '700');
    assert.equal(fs.readdirSync(out).filter((f) => f.startsWith('.')).length, 0, 'tidak ada berkas sementara');
    const x = path.join(root, 'x');
    fs.mkdirSync(x);
    assert.equal(spawnSync('tar', ['-xzf', arc, '-C', x]).status, 0);
    assert.equal((await sql(x + '/papan.db', 'PRAGMA integrity_check')).integrity_check, 'ok');
    const n = (await sql(x + '/papan.db', 'SELECT COUNT(*) n FROM tickets')).n;
    assert.ok(n >= before && n <= after, `snapshot ${n} harus di antara ${before} dan ${after}`);
    const a = await sql(x + '/papan.db', 'SELECT COUNT(*) c, MAX(number) m FROM tickets WHERE category_id = 1');
    assert.equal(a.c, a.m, 'nomor berurutan tanpa lubang (snapshot tidak terpotong di tengah transaksi)');
    assert.equal(fs.readdirSync(path.join(x, 'uploads')).length, 2);
  });

  it('lima backup paralel menghasilkan lima arsip berbeda (nama tidak bertabrakan)', async () => {
    const dir = path.join(root, 'out-par');
    await Promise.all(Array.from({ length: 5 }, () => new Promise((resolve) => {
      spawn(process.execPath, [path.join(ROOT, 'scripts/backup.js'), '--data', src, '--out', dir, '--keep', '0'], { env: NODE_ENV, stdio: 'ignore' }).on('exit', resolve);
    })));
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.tar.gz')).length, 5);
    assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('.')).length, 0);
  });

  it('retensi: menyimpan N terbaru, nama lama dan baru bercampur, berkas lain tidak disentuh', () => {
    const dir = path.join(root, 'out-ret');
    fs.mkdirSync(dir);
    for (const d of ['20250101-000000', '20250102-000000', '20250103-000000']) fs.writeFileSync(path.join(dir, `papan-backup-${d}.tar.gz`), '');
    fs.writeFileSync(path.join(dir, 'catatan-saya.txt'), 'x');
    const r = script('backup.js', ['--data', src, '--out', dir, '--keep', '2']);
    assert.equal(r.code, 0, r.out);
    const left = fs.readdirSync(dir).filter((f) => f.endsWith('.tar.gz'));
    assert.equal(left.length, 2);
    assert.ok(left.includes('papan-backup-20250103-000000.tar.gz'));
    assert.ok(fs.existsSync(path.join(dir, 'catatan-saya.txt')));
  });

  it('opsi: --no-uploads, data tidak ada (1), opsi tak dikenal (2), database rusak gagal tanpa sampah', () => {
    const d = path.join(root, 'out-opt');
    assert.equal(script('backup.js', ['--data', src, '--out', d, '--no-uploads']).code, 0);
    assert.equal(spawnSync('tar', ['-tzf', newestArchive(d)], { encoding: 'utf8' }).stdout.includes('uploads'), false);
    assert.equal(script('backup.js', ['--data', path.join(root, 'tidak-ada'), '--out', path.join(root, 'o1')]).code, 1);
    assert.equal(script('backup.js', ['--bukan-opsi']).code, 2);
    const bad = path.join(root, 'bad');
    fs.mkdirSync(path.join(bad, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(bad, 'papan.db'), crypto.randomBytes(4096));
    const o4 = path.join(root, 'o4');
    assert.equal(script('backup.js', ['--data', bad, '--out', o4]).code, 1);
    assert.deepEqual(fs.readdirSync(o4), []);
  });

  describe('restore', () => {
    let arc, dst, snap;
    before(() => { arc = newestArchive(); dst = path.join(root, 'dst'); snap = path.join(root, 'x'); });

    it('pratinjau tanpa --yes keluar dengan kode 2 dan tidak membuat apa pun', () => {
      const r = script('restore.js', [arc, '--data', dst]);
      assert.equal(r.code, 2);
      assert.ok(!fs.existsSync(dst));
    });
    it('--yes memulihkan data, unggahan, dan rahasia secara identik', async () => {
      const r = script('restore.js', [arc, '--data', dst, '--yes']);
      assert.equal(r.code, 0, r.out);
      for (const t of ['tickets', 'users', 'contents', 'settings']) {
        assert.equal((await sql(dst + '/papan.db', `SELECT COUNT(*) n FROM ${t}`)).n, (await sql(snap + '/papan.db', `SELECT COUNT(*) n FROM ${t}`)).n, t);
      }
      assert.equal((await sql(dst + '/papan.db', "SELECT value v FROM secrets WHERE key = 'vapid_public'")).v, (await sql(snap + '/papan.db', "SELECT value v FROM secrets WHERE key = 'vapid_public'")).v);
      assert.equal(tree(path.join(dst, 'uploads')), tree(path.join(src, 'uploads')));
      assert.equal(fs.readdirSync(dst).filter((f) => f.startsWith('.restore-')).length, 0);
    });
    it('server berjalan di data hasil restore: login lama dan pengaturan terpulihkan', async () => {
      const s = await startServer({ DATA_DIR: dst });
      assert.equal((await client(s.base).post('/api/auth/login', { username: 'budi', password: 'password1' })).status, 200);
      assert.equal((await client(s.base).get('/api/settings')).body.org_name, 'Dinas Backup Uji');
      // restore menolak saat server hidup
      const refused = script('restore.js', [arc, '--data', dst, '--yes']);
      assert.equal(refused.code, 1);
      assert.match(refused.out, /server masih berjalan \(PID \d+\)/);
      // --force melewatinya
      assert.equal(script('restore.js', [arc, '--data', dst, '--yes', '--force']).code, 0);
      await s.stop();
    });
    it('berkas PID usang atau milik proses lain tidak dianggap server', () => {
      fs.writeFileSync(path.join(dst, 'papan.pid'), '999999');
      assert.equal(script('restore.js', [arc, '--data', dst, '--yes']).code, 0, 'PID mati');
      const sleeper = spawn('sleep', ['30']);
      fs.writeFileSync(path.join(dst, 'papan.pid'), String(sleeper.pid));
      assert.equal(script('restore.js', [arc, '--data', dst, '--yes']).code, 0, 'PID proses lain');
      sleeper.kill();
    });
    it('data lama disimpan di .bak-*, dan folder backups di dalam direktori data dibiarkan', () => {
      const d2 = path.join(root, 'dst2');
      fs.mkdirSync(path.join(d2, 'uploads'), { recursive: true });
      fs.mkdirSync(path.join(d2, 'backups'));
      fs.writeFileSync(path.join(d2, 'uploads', 'lama.txt'), 'data-penting');
      fs.writeFileSync(path.join(d2, 'backups', 'arsip.txt'), 'jangan-dipindah');
      assert.equal(script('restore.js', [arc, '--data', d2, '--yes']).code, 0);
      const bak = fs.readdirSync(d2).find((f) => f.startsWith('.bak-'));
      assert.equal(fs.readFileSync(path.join(d2, bak, 'uploads', 'lama.txt'), 'utf8'), 'data-penting');
      assert.ok(fs.existsSync(path.join(d2, 'backups', 'arsip.txt')), 'folder backups tetap di tempatnya');
      assert.ok(!fs.existsSync(path.join(d2, bak, 'backups')));
    });

    describe('arsip berbahaya atau rusak ditolak tanpa menyentuh data', () => {
      let data, goodDb;
      before(async () => {
        data = path.join(root, 'victim');
        fs.mkdirSync(path.join(data, 'uploads'), { recursive: true });
        fs.writeFileSync(path.join(data, 'uploads', 'penting.txt'), 'data-penting');
        goodDb = fs.readFileSync(path.join(snap, 'papan.db'));
      });
      const bad = {
        'path traversal (../)': async (f) => makeTarGz(f, [{ name: 'papan.db', data: goodDb }, { name: '../evil-traversal.txt', data: 'x' }]),
        'path absolut': async (f) => makeTarGz(f, [{ name: 'papan.db', data: goodDb }, { name: '/tmp/evil-absolute.txt', data: 'x' }]),
        'tautan simbolik': async (f) => makeTarGz(f, [{ name: 'papan.db', data: goodDb }, { name: 'tautan', type: '2', linkname: '/etc' }]),
        'hard link': async (f) => makeTarGz(f, [{ name: 'papan.db', data: goodDb }, { name: 'keras', type: '1', linkname: '/etc/passwd' }]),
        'tanpa papan.db': async (f) => makeTarGz(f, [{ name: 'uploads/a.txt', data: 'halo' }]),
        'database acak': async (f) => makeTarGz(f, [{ name: 'papan.db', data: crypto.randomBytes(8192) }]),
        'bukan gzip': async (f) => fs.writeFileSync(f, 'ini bukan arsip sama sekali'),
      };
      for (const [name, make] of Object.entries(bad)) {
        it(`menolak: ${name}`, async () => {
          const f = path.join(root, `jahat-${crypto.randomBytes(3).toString('hex')}.tar.gz`);
          await make(f);
          const before = tree(data);
          const r = script('restore.js', [f, '--data', data, '--yes']);
          assert.equal(r.code, 1, r.out);
          assert.match(r.out, /Pemulihan dibatalkan/);
          assert.equal(tree(data), before, 'data tidak boleh berubah');
          assert.equal(fs.readdirSync(data).filter((n) => n.startsWith('.bak-') || n.startsWith('.restore-')).length, 0);
          assert.ok(!fs.existsSync(path.join(root, '..', 'evil-traversal.txt')));
          assert.ok(!fs.existsSync('/tmp/evil-absolute.txt'));
        });
      }
    });
  });
});

describe('direktori data tidak dapat ditulis', () => {
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const haveSetpriv = spawnSync('setpriv', ['--version']).status === 0;
  const canTest = asRoot ? haveSetpriv : typeof process.getuid === 'function';
  it('keluar kode 1 dengan pesan yang bisa ditindaklanjuti, bukan tumpukan galat SQLite', { skip: !canTest && 'tidak bisa meniru pengguna non-root' }, () => {
    const d = tmpDir('ro-');
    fs.chmodSync(d, 0o755); // milik pengguna tes (atau root)
    const code = `await import(${JSON.stringify(path.join(ROOT, 'server/db.js'))})`;
    const args = ['--input-type=module', '-e', code];
    // Sebagai root: jalankan sebagai uid 65534 pada direktori milik root. Non-root: cabut izin tulis.
    let r;
    if (asRoot) {
      r = spawnSync('setpriv', ['--reuid=65534', '--regid=65534', '--clear-groups', process.execPath, ...args], { encoding: 'utf8', env: { ...NODE_ENV, DATA_DIR: d } });
    } else {
      fs.chmodSync(d, 0o555);
      r = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...NODE_ENV, DATA_DIR: d } });
    }
    fs.chmodSync(d, 0o755);
    rm(d);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Tidak dapat memakai direktori data/);
    assert.match(r.stderr, /uid \d+/);
    assert.match(r.stderr, /chown -R 1000:1000/);
    assert.doesNotMatch(r.stderr, /ERR_SQLITE_ERROR/);
  });
});
