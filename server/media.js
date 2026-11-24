import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { HttpError } from './service.js';

export const VIDEO_EXT = new Set(['.mp4', '.webm']);

// ffmpeg opsional: bila tidak ada, video disimpan apa adanya.
export const ffmpegAvailable = (() => {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

// Status job per nama berkas hasil. Berkas yang sudah ada di disk dianggap siap.
const jobs = new Map(); // name -> { status: 'processing'|'error', error? }
const pending = [];
let running = false;

export function status(uploadDir, name) {
  const job = jobs.get(name);
  if (job) return job;
  return fs.existsSync(path.join(uploadDir, name)) ? { status: 'ready' } : { status: 'missing' };
}

// Tolak penyimpanan konten yang berkas videonya belum selesai diproses.
export function assertReady(uploadDir, name) {
  if (!name) return;
  const s = status(uploadDir, name).status;
  if (s === 'processing') throw new HttpError(409, 'Video masih diproses. Tunggu sampai selesai.');
  if (s === 'error') throw new HttpError(409, 'Pemrosesan video gagal. Unggah ulang videonya.');
}

export function enqueueTranscode(srcPath, destPath, name) {
  jobs.set(name, { status: 'processing' });
  pending.push({ srcPath, destPath, name });
  pump();
}

function pump() {
  if (running) return;
  const next = pending.shift();
  if (!next) return;
  running = true;
  const { srcPath, destPath, name } = next;
  const tmp = destPath + '.part.mp4';
  const args = [
    '-y', '-i', srcPath,
    '-vf', "scale=-2:'min(1080,ih)'",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    tmp,
  ];
  const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let tail = '';
  p.stderr.on('data', (d) => {
    tail = (tail + d.toString()).slice(-600);
  });
  const finish = (ok, message) => {
    running = false;
    fs.unlink(srcPath, () => {});
    if (ok) {
      fs.rename(tmp, destPath, (err) => {
        if (err) jobs.set(name, { status: 'error', error: err.message });
        else jobs.delete(name);
        pump();
      });
    } else {
      fs.unlink(tmp, () => {});
      jobs.set(name, { status: 'error', error: message });
      pump();
    }
  };
  p.on('error', (e) => finish(false, e.message));
  p.on('close', (code) => finish(code === 0, code === 0 ? '' : 'ffmpeg gagal: ' + tail.trim().split('\n').pop()));
}

// Hapus berkas unggahan yang tidak dirujuk konten atau logo. Berkas baru (di bawah graceMs)
// dibiarkan karena mungkin belum disimpan ke konten.
export function cleanupUploads(uploadDir, graceMs = 60 * 60 * 1000) {
  const used = new Set();
  for (const r of db.prepare("SELECT file FROM contents WHERE file <> ''").all()) used.add(r.file);
  const logo = db.prepare("SELECT value FROM settings WHERE key = 'org_logo'").get();
  if (logo && logo.value) used.add(path.basename(logo.value));

  let removed = 0;
  for (const name of fs.readdirSync(uploadDir)) {
    if (used.has(name) || jobs.has(name)) continue;
    // Berkas sumber transcoding sedang dipakai job.
    if (/\.src\./.test(name) || name.endsWith('.part.mp4')) {
      if (running || pending.length) continue;
    }
    const full = path.join(uploadDir, name);
    try {
      const st = fs.statSync(full);
      if (st.isFile() && Date.now() - st.mtimeMs > graceMs) {
        fs.unlinkSync(full);
        removed += 1;
      }
    } catch {
      /* berkas hilang atau tak bisa dibaca, abaikan */
    }
  }
  return removed;
}
