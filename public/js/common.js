// Utilitas bersama: API, token, WebSocket, waktu server, suara panggilan.
(function () {
  const TOKEN_KEY = 'papan_token';

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (opts.body !== undefined && !(opts.body instanceof Blob) && !(opts.body instanceof ArrayBuffer)) {
      headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    if (opts.auth) {
      const t = store.get(TOKEN_KEY) || '';
      headers.authorization = 'Bearer ' + t;
    }
    const res = await fetch(path, { ...opts, headers });
    let data = null;
    try { data = await res.json(); } catch { /* bukan JSON */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || 'Permintaan gagal (' + res.status + ')');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // Selisih waktu jam server dengan jam perangkat (ms). Jam tampilan selalu memakai waktu server.
  const timeSync = {
    offset: 0,
    async sync() {
      const t0 = Date.now();
      try {
        const r = await api('/api/time');
        const t1 = Date.now();
        this.offset = r.now - (t0 + t1) / 2;
      } catch { /* abaikan, pakai offset terakhir */ }
    },
    now() { return Date.now() + this.offset; },
  };

  // WebSocket dengan reconnect otomatis (backoff sampai 10 detik).
  function connectWS(onMessage) {
    let ws;
    let delay = 500;
    const open = () => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(proto + '//' + location.host + '/ws');
      ws.onopen = () => { delay = 500; };
      ws.onmessage = (ev) => {
        try { onMessage(JSON.parse(ev.data)); } catch { /* pesan rusak */ }
      };
      ws.onclose = () => {
        setTimeout(open, delay);
        delay = Math.min(delay * 2, 10000);
      };
    };
    open();
    return { get socket() { return ws; } };
  }

  // Bunyi bel sederhana dengan Web Audio (tanpa file audio).
  let audioCtx = null;
  function chime() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t = audioCtx.currentTime;
      [[880, 0], [660, 0.35]].forEach(([f, at]) => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + at);
        g.gain.exponentialRampToValueAtTime(0.35, t + at + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.9);
        o.connect(g).connect(audioCtx.destination);
        o.start(t + at);
        o.stop(t + at + 1);
      });
    } catch { /* audio tidak tersedia */ }
  }

  // Suara TTS Bahasa Indonesia. Browser bisa memblokir sebelum ada interaksi pengguna.
  function speak(text) {
    try {
      if (!('speechSynthesis' in window)) return;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'id-ID';
      u.rate = 0.95;
      const voice = speechSynthesis.getVoices().find((v) => v.lang && v.lang.toLowerCase().startsWith('id'));
      if (voice) u.voice = voice;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch { /* ignore */ }
  }

  const pad = (n) => String(n).padStart(2, '0');
  const fmtTime = (ms, tz) =>
    new Intl.DateTimeFormat('id-ID', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
      .format(new Date(ms));
  const fmtDate = (ms, tz) =>
    new Intl.DateTimeFormat('id-ID', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      .format(new Date(ms));

  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  window.Papan = { api, store, TOKEN_KEY, timeSync, connectWS, chime, speak, fmtTime, fmtDate, toast, esc, pad };
})();
