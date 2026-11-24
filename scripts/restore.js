#!/usr/bin/env node
// Pulihkan data dari arsip buatan scripts/backup.js.
//
//   node scripts/restore.js <arsip.tar.gz> [--data DIR] [--yes] [--force]
//
// Data lama TIDAK dihapus: dipindahkan ke <data>/.bak-<waktu> sehingga pemulihan bisa dibatalkan.
// Hentikan server lebih dulu. Tanpa --yes skrip hanya menjelaskan apa yang akan dilakukan.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage(code) {
  console.log(`Penggunaan: node scripts/restore.js <arsip.tar.gz> [opsi]

  --data DIR   direktori data tujuan (default: $DATA_DIR atau ./data)
  --yes        benar-benar jalankan pemulihan (tanpa ini hanya pratinjau)
  --force      lewati pemeriksaan "server masih berjalan" (mis. server di dalam container)
  -h, --help   tampilkan bantuan`);
  process.exit(code);
}

const args = process.argv.slice(2);
const opt = { data: process.env.DATA_DIR || path.join(root, 'data'), yes: false, force: false, archive: '' };
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--data') { opt.data = args[++i] || usage(2); }
  else if (a === '--yes') opt.yes = true;
  else if (a === '--force') opt.force = true;
  else if (a === '-h' || a === '--help') usage(0);
  else if (a.startsWith('-')) { console.error(`Opsi tidak dikenal: ${a}`); usage(2); }
  else if (!opt.archive) opt.archive = a;
  else { console.error('Hanya satu arsip yang boleh disebut.'); usage(2); }
}
if (!opt.archive) usage(2);
opt.data = path.resolve(opt.data);
opt.archive = path.resolve(opt.archive);

const fail = (msg) => { console.error('Pemulihan dibatalkan: ' + msg); process.exit(1); };
const tar = (a) => spawnSync('tar', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

if (!fs.existsSync(opt.archive)) fail(`arsip tidak ditemukan: ${opt.archive}`);
if (spawnSync('tar', ['--version'], { stdio: 'ignore' }).status !== 0) fail('perintah "tar" tidak ditemukan');

// ---- 1. Periksa isi arsip sebelum mengekstrak apa pun ----
const names = tar(['-tzf', opt.archive]);
if (names.status !== 0) fail('arsip rusak atau bukan .tar.gz: ' + (names.stderr || '').trim());
const entries = names.stdout.split('\n').filter(Boolean);
for (const e of entries) {
  const clean = e.replace(/^\.\//, '');
  if (path.isAbsolute(e) || clean.split('/').includes('..')) fail(`arsip memuat path berbahaya: ${e}`);
}
const verbose = tar(['-tzvf', opt.archive]);
for (const line of verbose.stdout.split('\n').filter(Boolean)) {
  // Karakter pertama baris adalah jenis entri: tautan simbolik (l) dan hard link (h) tidak diperlukan dan berisiko.
  if (/^[lhcbps]/.test(line)) fail(`arsip memuat entri yang tidak diizinkan (tautan atau berkas khusus): ${line.slice(0, 80)}`);
}
if (!entries.some((e) => e.replace(/^\.\//, '') === 'papan.db')) fail('arsip tidak memuat papan.db; bukan arsip backup Papan Informasi');

// ---- 2. Pastikan server tidak sedang berjalan ----
function serverRunning() {
  try {
    const pid = Number(fs.readFileSync(path.join(opt.data, 'papan.pid'), 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0); // melempar bila proses tidak ada
    // Berkas PID bisa usang dan nomornya dipakai proses lain setelah reboot; pastikan itu memang server ini.
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      return /server[\\/]index\.js/.test(cmd) ? pid : null;
    } catch {
      return pid; // tidak bisa memastikan (bukan Linux): anggap berjalan, aman
    }
  } catch {
    return null;
  }
}
const running = opt.force ? null : serverRunning();

console.log(`Arsip   : ${opt.archive}`);
console.log(`Tujuan  : ${opt.data}`);
console.log(`Isi     : ${entries.length} entri`);
if (running) fail(`server masih berjalan (PID ${running}). Hentikan dulu, mis. "sudo systemctl stop papan-informasi", lalu ulangi. (Gunakan --force bila yakin.)`);
if (!opt.yes) {
  console.log('\nIni hanya pratinjau. Data saat ini akan dipindahkan ke <data>/.bak-<waktu>, lalu isi arsip dipulihkan.');
  console.log('Tambahkan --yes untuk menjalankan.');
  process.exit(2);
}

// ---- 3. Ekstrak ke area sementara di dalam direktori data (satu sistem berkas, jadi rename murah) ----
fs.mkdirSync(opt.data, { recursive: true });
const staging = fs.mkdtempSync(path.join(opt.data, '.restore-'));
const cleanup = () => fs.rmSync(staging, { recursive: true, force: true });
try {
  const x = tar(['-xzf', opt.archive, '-C', staging, '--no-same-owner', '--no-same-permissions']);
  if (x.status !== 0) throw new Error('gagal mengekstrak: ' + (x.stderr || '').trim());

  // ---- 4. Validasi isi sebelum menyentuh data yang ada ----
  const dbFile = path.join(staging, 'papan.db');
  let db;
  try {
    db = new DatabaseSync(dbFile);
    db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get(); // membaca halaman pertama: gagal bila bukan database
  } catch {
    throw new Error('papan.db di arsip tidak dapat dibaca (rusak atau bukan database SQLite)');
  }
  try {
    const ic = db.prepare('PRAGMA integrity_check').all();
    if (!(ic.length === 1 && Object.values(ic[0])[0] === 'ok')) throw new Error('database di arsip gagal pemeriksaan integritas');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    for (const t of ['settings', 'users', 'tickets', 'contents', 'categories', 'counters']) {
      if (!tables.has(t)) throw new Error(`tabel "${t}" tidak ada di database arsip`);
    }
  } finally {
    db.close();
  }
  fs.mkdirSync(path.join(staging, 'uploads'), { recursive: true });

  // ---- 5. Pindahkan data lama ke .bak lalu pasang yang baru; batalkan bila gagal di tengah jalan ----
  const bak = path.join(opt.data, `.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(bak);
  // Folder backups (bila arsip disimpan di dalam direktori data, mis. di Docker) dibiarkan di tempatnya.
  const isMeta = (n) => n.startsWith('.bak-') || n.startsWith('.restore-') || n === 'backups';
  const moved = [];
  try {
    for (const n of fs.readdirSync(opt.data).filter((f) => !isMeta(f))) {
      fs.renameSync(path.join(opt.data, n), path.join(bak, n));
      moved.push(n);
    }
    for (const n of fs.readdirSync(staging)) {
      if (n === 'MANIFEST.json') continue;
      fs.renameSync(path.join(staging, n), path.join(opt.data, n));
    }
  } catch (e) {
    // Kembalikan: buang yang sempat terpasang dari arsip, pulihkan yang sudah dipindahkan.
    for (const n of fs.readdirSync(opt.data).filter((f) => !isMeta(f))) fs.rmSync(path.join(opt.data, n), { recursive: true, force: true });
    for (const n of moved) fs.renameSync(path.join(bak, n), path.join(opt.data, n));
    fs.rmSync(bak, { recursive: true, force: true });
    throw new Error('gagal memasang data, data lama dikembalikan: ' + e.message);
  }
  console.log('\nPemulihan selesai.');
  console.log(`  Data lama disimpan di : ${bak}`);
  console.log('  Hapus folder itu setelah yakin pemulihan benar.');
  console.log('  Jalankan server kembali, mis. "sudo systemctl start papan-informasi".');
} catch (e) {
  cleanup();
  fail(e.message);
}
cleanup();
