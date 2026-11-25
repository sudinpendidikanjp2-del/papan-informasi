// Menyalin pdf.js (build legacy, kompatibel dengan browser TV lama) ke public/vendor/pdfjs
// supaya papan tidak bergantung pada internet. Dijalankan otomatis oleh `npm install` (postinstall).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'node_modules', 'pdfjs-dist');
const dest = path.join(root, 'public', 'vendor', 'pdfjs');

if (!fs.existsSync(src)) {
  console.warn('[vendor] pdfjs-dist belum terpasang, lewati. PDF akan tampil lewat penampil bawaan browser.');
  process.exit(0);
}

fs.mkdirSync(dest, { recursive: true });
for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
  fs.copyFileSync(path.join(src, 'legacy', 'build', f), path.join(dest, f));
}
// Font standar untuk PDF yang tidak menyematkan font-nya.
fs.cpSync(path.join(src, 'standard_fonts'), path.join(dest, 'standard_fonts'), { recursive: true });
console.log('[vendor] pdf.js disalin ke public/vendor/pdfjs');
