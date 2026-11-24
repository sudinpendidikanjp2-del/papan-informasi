(function () {
  const P = window.Papan;
  const $ = (id) => document.getElementById(id);

  let settings = {};
  let playlist = { main: [], screensaver: [] };
  let snap = null;
  let unlocked = false;

  // ---------- Pengaturan & jam ----------

  function applySettings() {
    $('orgName').textContent = settings.org_name || 'Nama Instansi';
    document.title = (settings.org_name || 'Papan Informasi') + ' · Papan Informasi';
    const logo = $('logo');
    if (settings.org_logo) {
      logo.src = settings.org_logo;
      logo.classList.remove('hidden');
    } else {
      logo.classList.add('hidden');
    }
  }

  function tz() {
    return settings.timezone || 'Asia/Jakarta';
  }

  function tickClock() {
    const now = P.timeSync.now();
    $('clock').textContent = P.fmtTime(now, tz());
    $('date').textContent = P.fmtDate(now, tz());
    const ssClock = document.querySelector('.ss-clock');
    if (ssClock) ssClock.textContent = P.fmtTime(now, tz());
    updateSaver();
  }

  // ---------- Carousel konten ----------

  let items = [];
  let idx = -1;
  let itemTimer = null;
  let endsAt = 0;
  let durMs = 0;
  let countdownTimer = null;

  function renderEmpty() {
    clearTimeout(itemTimer);
    $('slide').innerHTML = '<div class="empty">Belum ada informasi</div>';
    setCountdown('');
    setProgress(0);
  }

  function buildSlide(it) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center';
    if (it.type === 'text') {
      wrap.innerHTML = '<div class="slide-text"><h2>' + P.esc(it.title) + '</h2><p>' + P.esc(it.body) + '</p></div>';
    } else if (it.type === 'image') {
      const img = document.createElement('img');
      img.src = it.url;
      img.alt = it.title || '';
      wrap.appendChild(img);
    } else if (it.type === 'video') {
      const v = document.createElement('video');
      v.src = it.url;
      v.autoplay = true;
      v.muted = true;
      v.playsInline = true;
      v.controls = false;
      v.addEventListener('ended', () => {
        if (it.duration === 0) showNext();
      });
      wrap.appendChild(v);
    } else if (it.type === 'pdf') {
      const f = document.createElement('iframe');
      f.src = it.url + '#toolbar=0&navpanes=0&view=FitH';
      f.title = it.title || 'Dokumen';
      wrap.appendChild(f);
    }
    return wrap;
  }

  function showNext() {
    if (!items.length) return renderEmpty();
    idx = (idx + 1) % items.length;
    const it = items[idx];
    clearTimeout(itemTimer);

    const slide = $('slide');
    slide.innerHTML = '';
    slide.appendChild(buildSlide(it));

    // Durasi 0 pada video berarti sampai video selesai diputar.
    const untilEnded = it.type === 'video' && it.duration === 0;
    durMs = untilEnded ? 0 : it.duration * 1000;
    endsAt = Date.now() + durMs;
    if (!untilEnded) itemTimer = setTimeout(showNext, durMs);

    const vid = slide.querySelector('video');
    if (vid) vid.play().catch(() => {});

    startCountdown(untilEnded);
  }

  function startCountdown(untilEnded) {
    clearInterval(countdownTimer);
    const tick = () => {
      if (untilEnded) {
        setCountdown('Video');
        setProgress(0);
        return;
      }
      const left = Math.max(0, endsAt - Date.now());
      setCountdown(Math.ceil(left / 1000) + ' dtk');
      setProgress(durMs ? 1 - left / durMs : 0);
    };
    tick();
    countdownTimer = setInterval(tick, 250);
  }

  function setCountdown(text) {
    let el = document.getElementById('cd');
    if (!text) {
      if (el) el.remove();
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.id = 'cd';
      el.className = 'countdown';
      $('slide').appendChild(el);
    }
    el.textContent = text;
  }

  function setProgress(ratio) {
    let bar = document.getElementById('pg');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'pg';
      bar.className = 'progress';
      bar.style.cssText = 'position:absolute;left:0;right:0;bottom:0;margin:0;border-radius:0;height:8px';
      bar.innerHTML = '<span></span>';
      $('slide').appendChild(bar);
    }
    bar.firstElementChild.style.width = Math.min(100, Math.max(0, ratio * 100)) + '%';
  }

  function applyPlaylist(newPl) {
    const prevId = items[idx] && items[idx].id;
    playlist = newPl;
    items = playlist.main;
    const keep = items.findIndex((x) => x.id === prevId);
    idx = keep >= 0 ? keep : -1;
    if (!items.length) return renderEmpty();
    // Jika item aktif tetap ada, biarkan countdown berjalan sampai habis; jika tidak, mulai dari awal.
    if (keep < 0) {
      idx = -1;
      showNext();
    } else if (!itemTimer) {
      showNext();
    }
    prepareSaver();
  }

  // ---------- Screensaver ----------

  let saverItems = [];
  let saverIdx = -1;
  let saverTimer = null;
  let saverOn = false;

  function prepareSaver() {
    saverItems = (playlist.screensaver || []).filter((x) => x.type === 'image' || x.type === 'video');
  }

  function isIdle() {
    if (!snap || !saverItems.length) return false;
    const minutes = Math.max(1, parseInt(settings.idle_minutes || '3', 10));
    return P.timeSync.now() - snap.lastActivity > minutes * 60000;
  }

  function updateSaver() {
    const want = isIdle();
    if (want && !saverOn) startSaver();
    if (!want && saverOn) stopSaver();
  }

  function startSaver() {
    saverOn = true;
    $('saver').classList.remove('hidden');
    saverIdx = -1;
    nextSaver();
  }

  function stopSaver() {
    saverOn = false;
    clearTimeout(saverTimer);
    $('saver').classList.add('hidden');
    $('saver').innerHTML = '';
  }

  function nextSaver() {
    clearTimeout(saverTimer);
    if (!saverOn) return;
    if (!saverItems.length) return stopSaver();
    saverIdx = (saverIdx + 1) % saverItems.length;
    const it = saverItems[saverIdx];
    const box = $('saver');
    const logo = settings.org_logo ? '<img src="' + P.esc(settings.org_logo) + '" alt="">' : '';
    box.innerHTML = '';
    if (it.type === 'video') {
      const v = document.createElement('video');
      v.src = it.url;
      v.autoplay = true;
      v.muted = true;
      v.loop = saverItems.length === 1;
      v.playsInline = true;
      v.addEventListener('ended', nextSaver);
      v.addEventListener('error', () => { saverTimer = setTimeout(nextSaver, 1000); });
      box.appendChild(v);
      v.play().catch(() => {});
      if (v.loop === false && it.duration > 0) saverTimer = setTimeout(nextSaver, it.duration * 1000);
    } else {
      const img = document.createElement('img');
      img.src = it.url;
      img.alt = '';
      box.appendChild(img);
      saverTimer = setTimeout(nextSaver, Math.max(3, it.duration || 8) * 1000);
    }
    const badge = document.createElement('div');
    badge.className = 'ss-badge';
    badge.innerHTML = logo + '<span>' + P.esc(settings.org_name || '') + '</span>';
    box.appendChild(badge);
    const clock = document.createElement('div');
    clock.className = 'ss-clock';
    clock.textContent = P.fmtTime(P.timeSync.now(), tz());
    box.appendChild(clock);
  }

  // ---------- Panel antrian ----------

  function renderQueue() {
    if (!snap) return;

    // Panggilan terbaru tampil besar selama 25 detik.
    const latest = snap.recent && snap.recent[0];
    const fresh = latest && P.timeSync.now() - latest.calledAt < 25000;
    if (fresh) {
      $('nowBody').innerHTML =
        '<div class="now-label">' + P.esc(latest.label) + '</div>' +
        '<div class="now-counter">Silakan menuju ' + P.esc(latest.counter || '') + '</div>';
    } else {
      $('nowBody').innerHTML = '<div class="idle-text">Menunggu panggilan berikutnya</div>';
    }

    $('counters').innerHTML = snap.counters.length
      ? snap.counters.map((c) => {
          const cur = c.current;
          const badge = cur
            ? '<span class="badge busy">Melayani</span>'
            : '<span class="badge free">Kosong</span>';
          return '<div class="counter-row">' +
            '<div><div class="cname">' + P.esc(c.name) + '</div>' +
            '<div class="csub">' + P.esc(c.categoryName || 'Tanpa kategori') + '</div></div>' +
            '<div class="row" style="gap:10px;align-items:center">' +
            (cur ? '<span class="num">' + P.esc(cur.label) + '</span>' : '') + badge + '</div></div>';
        }).join('')
      : '<div class="muted">Belum ada meja</div>';

    $('cats').innerHTML = snap.categories.length
      ? snap.categories.map((k) =>
          '<div class="cat-row"><span>' + P.esc(k.name) + ' <span class="muted">(' + P.esc(k.prefix) + ')</span></span>' +
          '<b>' + k.waiting + '</b></div>').join('')
      : '<div class="muted">Belum ada kategori</div>';

    $('recent').innerHTML = (snap.recent || []).slice(0, 6).map((r) =>
      '<span><b>' + P.esc(r.label) + '</b> → ' + P.esc(r.counter || '') + '</span>').join('');
  }

  // ---------- Data loading ----------

  async function loadSettings() {
    settings = await P.api('/api/settings');
    applySettings();
  }

  async function loadPlaylist() {
    applyPlaylist(await P.api('/api/playlist'));
  }

  async function loadState() {
    try {
      snap = await P.api('/api/state');
      renderQueue();
      updateSaver();
      $('offline').classList.add('hidden');
    } catch {
      $('offline').classList.remove('hidden');
    }
  }

  async function loadAll() {
    try {
      await Promise.all([loadSettings(), loadPlaylist(), loadState(), P.timeSync.sync()]);
    } catch {
      $('offline').classList.remove('hidden');
    }
  }

  // ---------- Pemanggilan (suara) ----------

  function announce(c) {
    if (!unlocked) return;
    if (settings.sound_enabled !== '0') P.chime();
    if (settings.tts_enabled !== '0') {
      const m = /^([A-Za-z]+)-0*(\d+)$/.exec(c.label || '');
      const text = m
        ? 'Nomor antrian ' + m[1] + ', ' + m[2] + '. Silakan menuju ' + (c.counter || 'meja layanan') + '.'
        : 'Nomor antrian ' + c.label + '. Silakan menuju ' + (c.counter || 'meja layanan') + '.';
      setTimeout(() => P.speak(text), 1300);
    }
  }

  // ---------- Init ----------

  $('unlockBtn').addEventListener('click', () => {
    unlocked = true;
    $('unlock').classList.add('hidden');
    try { P.chime(); } catch { /* ignore */ }
    try { speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch { /* ignore */ }
    if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {});
  });

  P.connectWS((msg) => {
    switch (msg.type) {
      case 'hello': loadAll(); break;
      case 'queue': loadState(); break;
      case 'call': announce(msg); loadState(); break;
      case 'content': loadPlaylist(); break;
      case 'categories': loadState(); loadPlaylist(); break;
      case 'settings': loadSettings(); break;
    }
  });

  setInterval(loadState, 20000);
  setInterval(() => P.timeSync.sync(), 60000);
  setInterval(tickClock, 500);
  // Papan tetap berjalan walau suara belum diaktifkan; tombol "Aktifkan" hanya mengatur bunyi.
  loadAll().then(tickClock);
})();
