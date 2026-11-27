// Unggah berkas dengan progres (XMLHttpRequest, karena fetch belum punya progres unggah) dan pantau konversi video.
import { formatBytes } from './dropzone.js';

/** Mengunggah satu berkas ke server. onProgress({loaded,total,pct,speed,etaSec}) dipanggil berkala. */
export function uploadFile(file, onProgress) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    xhr.open('POST', '/api/admin/upload');
    xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
    xhr.responseType = 'json';
    const t0 = Date.now();
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable || !onProgress) return;
      const secs = Math.max(0.2, (Date.now() - t0) / 1000);
      const speed = e.loaded / secs;
      onProgress({ loaded: e.loaded, total: e.total, pct: Math.floor((e.loaded / e.total) * 100), speed, etaSec: speed > 0 ? (e.total - e.loaded) / speed : null });
    };
    xhr.onload = () => {
      const body = xhr.response && typeof xhr.response === 'object' ? xhr.response : {};
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body);
      const err = new Error(body.error || 'Unggahan gagal (' + xhr.status + ')');
      err.status = xhr.status;
      reject(err);
    };
    xhr.onerror = () => reject(new Error('Koneksi terputus saat mengunggah'));
    xhr.onabort = () => reject(new Error('Unggahan dibatalkan'));
    xhr.send(file);
  });
  promise.abort = () => xhr.abort();
  return promise;
}

export function formatEta(sec) {
  if (sec == null || !Number.isFinite(sec)) return '';
  if (sec < 1.5) return 'hampir selesai';
  if (sec < 90) return 'sisa ' + Math.round(sec) + ' dtk';
  return 'sisa ' + Math.round(sec / 60) + ' mnt';
}

export const speedText = (bps) => formatBytes(bps) + '/dtk';

/**
 * Memantau status konversi. onPercent(persen) dipanggil tiap perubahan; selesai bila ready, melempar bila gagal.
 * Mengembalikan fungsi pembatal.
 */
export function watchConversion(name, api, { onPercent, onDone, onError, intervalMs = 800 }) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const s = await api('/api/admin/upload/' + encodeURIComponent(name) + '/status');
      if (stopped) return;
      if (s.status === 'processing') {
        onPercent && onPercent(s.percent || 0);
      } else if (s.status === 'ready') {
        stopped = true;
        return onDone && onDone();
      } else if (s.status === 'error') {
        stopped = true;
        return onError && onError(s.error || 'Konversi gagal');
      } else if (s.status === 'missing') {
        stopped = true;
        return onError && onError('Berkas hilang di server, unggah ulang');
      }
    } catch { /* coba lagi pada tik berikutnya */ }
    setTimeout(tick, intervalMs);
  };
  setTimeout(tick, 300);
  return () => { stopped = true; };
}
