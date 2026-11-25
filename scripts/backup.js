#!/usr/bin/env node
// Backup data Papan Informasi: snapshot database SQLite yang konsisten (aman dijalankan saat server hidup)
// ditambah berkas unggahan, dikemas menjadi satu arsip .tar.gz berizin 0600.
//
//   node scripts/backup.js [--data DIR] [--out DIR] [--keep N] [--no-uploads]
//
// Arsip memuat hash password pegawai dan kunci VAPID, jadi simpan di lokasi yang hanya bisa dibaca pemilik.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync, backup } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage(code) {
  console.log(`Penggunaan: node scripts/backup.js [opsi]

  --data DIR      direktori data (default: $DATA_DIR atau ./data)
  --out DIR       tujuan arsip (default: $BACKUP_DIR atau folder "backups" di samping direktori data)
  --keep N        simpan N arsip terbaru, hapus yang lebih lama (default 14; 0 = jangan hapus)
  --no-uploads    hanya database, tanpa berkas unggahan
  -h, --help      tampilkan bantuan`);
  process.exit(code);
}

function parseArgs(argv) {
  const o = { data: process.env.DATA_DIR || path.join(root, 'data'), out: process.env.BACKUP_DIR || '', keep: 14, uploads: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) { console.error(`Opsi ${a} butuh nilai.`); usage(2); }
      i += 1;
      return argv[i];
    };
    if (a === '--data') o.data = val();
    else if (a === '--out') o.out = val();
    else if (a === '--keep') o.keep = Number(val());
    else if (a === '--no-uploads') o.uploads = false;
    else if (a === '-h' || a === '--help') usage(0);
    else { console.error(`Opsi tidak dikenal: ${a}`); usage(2); }
  }
  if (!Number.isInteger(o.keep) || o.keep < 0) { console.error('--keep harus bilangan bulat >= 0'); process.exit(2); }
  o.data = path.resolve(o.data);
  o.out = path.resolve(o.out || path.join(path.dirname(o.data), 'backups'));
  return o;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
// Stempel sampai milidetik: dua backup dalam detik yang sama (mis. manual dan timer) tidak boleh saling menimpa.
function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}`;
}
// Nama lama (tanpa milidetik) tetap dikenali oleh retensi.
const ARCHIVE_RE = /^papan-backup-\d{8}-\d{6}(?:\d{3})?\.tar\.gz$/;

function integrity(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    const r = db.prepare('PRAGMA integrity_check').all();
    return r.length === 1 && Object.values(r[0])[0] === 'ok';
  } finally {
    db.close();
  }
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const dbPath = path.join(opt.data, 'papan.db');
  if (!fs.existsSync(dbPath)) {
    console.error(`Database tidak ditemukan: ${dbPath}\nGunakan --data atau set DATA_DIR.`);
    process.exit(1);
  }
  if (spawnSync('tar', ['--version'], { stdio: 'ignore' }).status !== 0) {
    console.error('Perintah "tar" tidak ditemukan. Pasang tar (mis. apt install tar) lalu ulangi.');
    process.exit(1);
  }

  fs.mkdirSync(opt.out, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(opt.out, '.staging-'));
  const tmpArchive = path.join(opt.out, `.papan-backup-${process.pid}-${Date.now()}.tmp`);
  try {
    // 1. Snapshot database lewat API backup SQLite (konsisten walau server sedang menulis).
    const src = new DatabaseSync(dbPath);
    src.exec('PRAGMA busy_timeout = 5000');
    try {
      await backup(src, path.join(staging, 'papan.db'));
    } finally {
      src.close();
    }
    if (!integrity(path.join(staging, 'papan.db'))) throw new Error('Snapshot database gagal pemeriksaan integritas');

    // 2. Berkas unggahan (lewati berkas sementara konversi video yang belum selesai).
    let uploadCount = 0;
    const uploads = path.join(opt.data, 'uploads');
    if (opt.uploads && fs.existsSync(uploads)) {
      fs.cpSync(uploads, path.join(staging, 'uploads'), {
        recursive: true,
        filter: (s) => !/\.part\.mp4$/.test(s) && !/\.src\./.test(s),
      });
      uploadCount = fs.readdirSync(path.join(staging, 'uploads')).length;
    }

    fs.writeFileSync(
      path.join(staging, 'MANIFEST.json'),
      JSON.stringify({ app: 'papan-informasi', createdAt: new Date().toISOString(), uploads: opt.uploads, uploadCount, node: process.version }, null, 2)
    );

    // 3. Kemas. Ditulis ke berkas sementara lalu di-rename agar arsip setengah jadi tidak pernah terlihat.
    const tar = spawnSync('tar', ['-czf', tmpArchive, '-C', staging, '.'], { encoding: 'utf8' });
    if (tar.status !== 0) throw new Error('tar gagal: ' + (tar.stderr || '').trim());
    fs.chmodSync(tmpArchive, 0o600);
    // link() gagal bila nama sudah ada, jadi arsip yang sudah ada tidak pernah tertimpa diam-diam.
    let final = '';
    for (let attempt = 0; attempt < 20 && !final; attempt += 1) {
      const candidate = path.join(opt.out, `papan-backup-${stamp()}.tar.gz`);
      try {
        fs.linkSync(tmpArchive, candidate);
        final = candidate;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    if (!final) throw new Error('tidak bisa menentukan nama arsip yang unik');
    fs.unlinkSync(tmpArchive);

    // 4. Retensi
    let removed = 0;
    if (opt.keep > 0) {
      const all = fs.readdirSync(opt.out).filter((f) => ARCHIVE_RE.test(f)).sort();
      for (const old of all.slice(0, Math.max(0, all.length - opt.keep))) {
        fs.unlinkSync(path.join(opt.out, old));
        removed += 1;
      }
    }

    const size = fs.statSync(final).size;
    console.log(`Backup selesai: ${final}`);
    console.log(`  ukuran ${(size / 1024 / 1024).toFixed(2)} MB, ${uploadCount} berkas unggahan${opt.uploads ? '' : ' (dilewati)'}, ${removed} arsip lama dihapus`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(tmpArchive, { force: true });
  }
}

main().catch((e) => {
  console.error('Backup gagal:', e.message);
  process.exit(1);
});
