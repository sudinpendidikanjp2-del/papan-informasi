import fs from 'node:fs';

// Pemeriksaan isi berkas unggahan terhadap ekstensinya. Ekstensi saja mudah dipalsukan: berkas
// berisi HTML atau skrip yang dinamai .png tidak boleh diterima.

const MAX_SVG = 2 * 1024 * 1024;

const startsWith = (buf, bytes, offset = 0) => bytes.every((b, i) => buf[offset + i] === b);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

// Tanda tangan (magic bytes) tiap jenis biner.
const SIGNATURES = {
  '.png': (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  '.jpg': (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  '.jpeg': (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  '.gif': (b) => startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a')),
  '.webp': (b) => startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8),
  '.pdf': (b) => b.subarray(0, 1024).includes(Buffer.from('%PDF-')),
  '.mp4': (b) => startsWith(b, ascii('ftyp'), 4),
  '.webm': (b) => startsWith(b, [0x1a, 0x45, 0xdf, 0xa3]),
};

// SVG dapat memuat skrip dan rujukan eksternal. Daftar-tolak ini sengaja ketat: logo dan gambar
// sederhana tidak membutuhkan semua itu.
const SVG_FORBIDDEN = [
  [/<\s*script/i, 'elemen <script>'],
  [/<\s*foreignObject/i, 'elemen <foreignObject>'],
  [/<\s*(iframe|embed|object|audio|video)\b/i, 'elemen yang menyisipkan konten lain'],
  [/\son[a-z]+\s*=/i, 'atribut penangan peristiwa (on...=)'],
  [/javascript\s*:/i, 'URL javascript:'],
  [/data\s*:\s*text\/html/i, 'data:text/html'],
  [/@import/i, '@import CSS'],
  [/url\(\s*["']?\s*(https?:)?\/\//i, 'rujukan URL eksternal pada CSS'],
];

// href dan xlink:href hanya boleh menunjuk ke bagian dokumen sendiri (#id) atau gambar data:image.
// Diperiksa per nilai (bukan satu regex) agar tanda kutip opsional tidak membuat regex mundur dan salah tolak.
const HREF_VALUE = /(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const SAFE_HREF = /^(?:#|data:image\/(?:png|jpe?g|gif|webp);base64,)/i;
function badHref(text) {
  for (const m of text.matchAll(HREF_VALUE)) {
    const value = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!SAFE_HREF.test(value)) return true;
  }
  return false;
}

// Mengembalikan { ok: true } atau { ok: false, reason }.
export function checkUpload(filePath, ext) {
  ext = ext.toLowerCase();
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    if (size === 0) return { ok: false, reason: 'Berkas kosong' };

    if (ext === '.svg') {
      if (size > MAX_SVG) return { ok: false, reason: 'SVG lebih dari 2 MB' };
      const text = fs.readFileSync(filePath, 'utf8');
      // Buang BOM, deklarasi XML, DOCTYPE, dan komentar di awal; sisanya harus dimulai dengan <svg.
      const head = text.replace(/^﻿/, '').replace(/^(\s|<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*/i, '');
      if (!/^<svg[\s>]/i.test(head)) return { ok: false, reason: 'Isi berkas bukan SVG yang valid' };
      for (const [re, what] of SVG_FORBIDDEN) {
        if (re.test(text)) return { ok: false, reason: `SVG memuat ${what}, yang tidak diizinkan` };
      }
      if (badHref(text)) return { ok: false, reason: 'SVG memuat rujukan href selain #id internal, yang tidak diizinkan' };
      return { ok: true };
    }

    const check = SIGNATURES[ext];
    if (!check) return { ok: false, reason: 'Format file tidak didukung' };
    const buf = Buffer.alloc(Math.min(size, 1024));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return check(buf) ? { ok: true } : { ok: false, reason: 'Isi berkas tidak sesuai dengan ekstensinya' };
  } catch (e) {
    return { ok: false, reason: 'Berkas tidak dapat dibaca' };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* sudah tertutup */ }
  }
}
