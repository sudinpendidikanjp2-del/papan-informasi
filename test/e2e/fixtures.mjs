// Membuat berkas uji untuk e2e: PNG, PDF 3 halaman, dan WebM. ffmpeg dipakai bila ada (hasil lebih nyata).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FIXTURES } from '../helpers.js';

// PDF 3 halaman dengan xref yang benar, ditulis tangan agar tidak butuh pustaka.
function threePagePdf() {
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const catalog = add('<< /Type /Catalog /Pages 2 0 R >>');
  add('<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'); // objek 3
  ['Jadwal Pelayanan', 'Persyaratan Dokumen', 'Informasi Kontak'].forEach((t, i) => {
    const stream = `BT /F1 36 Tf 60 400 Td (${t}) Tj ET`;
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${objs.length + 2} 0 R >>`);
    add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export function makeFixtures(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const ff = spawnSync('ffmpeg', ['-version']).status === 0;
  const png = path.join(dir, 'promo.png');
  if (ff && spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x2f6df0:s=1280x720', '-frames:v', '1', png]).status === 0) {
    /* PNG nyata dari ffmpeg */
  } else {
    fs.writeFileSync(png, FIXTURES.png());
  }
  fs.writeFileSync(path.join(dir, 'tiga-halaman.pdf'), threePagePdf());
  const webm = path.join(dir, 'clip.webm');
  if (!(ff && spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=1280x720:rate=25', '-c:v', 'libvpx', '-b:v', '1M', webm]).status === 0)) {
    // tanpa ffmpeg: tanda tangan WebM minimal (cukup untuk validasi unggahan; video tidak dapat diputar)
    fs.writeFileSync(webm, Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(256)]));
  }
  return dir;
}
