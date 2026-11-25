// Log audit: satu baris JSON per kejadian penting, ditulis ke stdout (ditangkap journald atau docker logs).
// Tidak pernah memuat password, token sesi, atau token tiket. Nilai teks dipotong dan JSON.stringify
// meloloskan karakter kontrol, sehingga masukan pengguna tidak bisa memalsukan baris log.
const clip = (v) => (typeof v === 'string' ? v.slice(0, 80) : v);

export function audit(event, fields = {}) {
  const line = { t: new Date().toISOString(), event };
  for (const [k, v] of Object.entries(fields)) line[k] = Array.isArray(v) ? v.map(clip) : clip(v);
  console.log('AUDIT ' + JSON.stringify(line));
}
