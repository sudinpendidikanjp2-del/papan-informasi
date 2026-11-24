import { HttpError } from './service.js';

// Pembatas laju jendela tetap, per kunci (biasanya alamat klien), disimpan di memori. Dipakai untuk
// endpoint publik yang tidak butuh login, mis. pengambilan nomor di kiosk. Reset saat server dimulai ulang
// dapat diterima karena ini bukan kontrol autentikasi (berbeda dengan pembatas login yang disimpan di database).
const buckets = new Map(); // kunci -> { count, resetAt }

export function hit(key, max, windowMs = 60000) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  if (b.count > max) {
    const err = new HttpError(429, 'Terlalu banyak permintaan. Coba lagi sebentar lagi.');
    err.retryAfter = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
    throw err;
  }
}

// Bersihkan jendela yang sudah lewat agar peta tidak membesar tanpa batas.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}, 60000);
sweeper.unref();

export const _size = () => buckets.size;
