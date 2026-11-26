// Tautan dan pemutar YouTube. Mencerminkan parseYoutubeId di server (server tetap yang menentukan sah atau tidaknya).

export function parseYoutubeId(input) {
  let u;
  try {
    u = new URL(String(input || '').trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/);
      if (m) id = m[1];
    }
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

export const thumbnailUrl = (id) => 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg';

// IFrame API dimuat sekali. Gagal (tanpa internet, diblokir) menolak janji agar item dilewati; percobaan berikutnya
// memuat ulang.
let apiPromise = null;
export function loadYouTubeApi(timeoutMs = 8000) {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { apiPromise = null; reject(new Error('API YouTube tidak termuat')); }, timeoutMs);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timer);
      if (typeof prev === 'function') prev();
      resolve(window.YT);
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => { clearTimeout(timer); apiPromise = null; s.remove(); reject(new Error('API YouTube tidak termuat')); };
    document.head.appendChild(s);
  });
  return apiPromise;
}
