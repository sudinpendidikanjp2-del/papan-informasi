(function () {
  const P = window.Papan;
  const $ = (id) => document.getElementById(id);

  let settings = {};
  let playlist = { main: [], screensaver: [] };
  let snap = null;
  let unlocked = false;

  // Layar ini diidentifikasi lewat ?screen=<slug>. Tanpa parameter: semua antrian dan konten bersama.
  const slug = (new URLSearchParams(location.search).get('screen') || '').trim().toLowerCase();
  let screenCfg = null;
  let screenMissing = false;
  let scopeQs = slug ? '?screen=' + encodeURIComponent(slug) : '';

  // ---------- Pengaturan, jam, identitas ----------

  function applyIdentity() {
    $('orgName').textContent = settings.org_name || 'Nama Instansi';
    const sc = $('screenName');
    if (screenCfg && screenCfg.name) {
      sc.textContent = screenCfg.name;
      sc.classList.remove('hidden');
    } else {
      sc.classList.add('hidden');
    }
    document.title = [settings.org_name || 'Papan Informasi', screenCfg && screenCfg.name].filter(Boolean).join(' · ');
    const logo = $('logo');
    if (settings.org_logo) {
      logo.src = settings.org_logo;
      logo.classList.remove('hidden');
    } else {
      logo.classList.add('hidden');
    }
  }

  const tz = () => settings.timezone || 'Asia/Jakarta';

  function tickClock() {
    const now = P.timeSync.now();
    $('clock').textContent = P.fmtTime(now, tz());
    $('date').textContent = P.fmtDate(now, tz());
    const ssClock = document.querySelector('.saver .clk');
    if (ssClock) ssClock.textContent = P.fmtTime(now, tz());
    updateSaver();
    renderCalling();
  }

  // ---------- Carousel konten ----------

  let items = [];
  let idx = -1;
  let cur = null;      // item yang sedang tampil
  let unitTimer = null;
  let token = 0;       // pembatalan hasil async milik item sebelumnya
  const pdfDocs = new Map();

  function renderEmpty() {
    clearTimeout(unitTimer);
    cur = null;
    token += 1;
    $('slide').innerHTML = '<div class="slide-empty">Belum ada informasi</div>';
    $('trackerBox').classList.add('hidden');
  }

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  // Satu "unit" adalah satu kali hitung mundur: satu item, atau satu halaman PDF.
  function showNext() {
    if (!items.length) return renderEmpty();
    idx = (idx + 1) % items.length;
    showItem(items[idx]);
  }

  function showItem(it) {
    clearTimeout(unitTimer);
    token += 1;
    const my = token;
    const slide = $('slide');
    slide.innerHTML = '';
    $('trackerBox').classList.remove('hidden');

    cur = {
      item: it,
      pdf: it.type === 'pdf',
      untilEnded: it.type === 'video' && it.duration === 0,
      units: 1,
      unit: 0,
      unitMs: it.duration * 1000,
      unitEndsAt: 0,
      startedAt: 0,
      totalMs: it.duration * 1000,
      loading: false,
    };

    const cd = el('div', 'cd');
    cd.id = 'cd';
    cd.innerHTML = '<span class="hero-pill">' + P.icon('clock') + '<span id="cdText"></span></span>';
    slide.appendChild(cd);
    if (it.title && it.type !== 'text') slide.appendChild(el('div', 'ttl', P.esc(it.title)));

    if (it.type === 'text') {
      slide.appendChild(el('div', 'slide-text',
        '<div class="bar"></div><h2>' + P.esc(it.title) + '</h2><p>' + P.esc(it.body) + '</p>'));
      startUnit();
    } else if (it.type === 'image') {
      const f = el('div', 'fill');
      const img = document.createElement('img');
      img.className = 'soft';
      img.src = it.url;
      img.alt = it.title || '';
      f.appendChild(img);
      slide.appendChild(f);
      startUnit();
    } else if (it.type === 'video') {
      const f = el('div', 'fill');
      const v = document.createElement('video');
      v.src = it.url;
      v.autoplay = true;
      v.muted = true;
      v.playsInline = true;
      v.controls = false;
      v.addEventListener('ended', () => {
        if (my === token && cur && cur.untilEnded) showNext();
      });
      v.addEventListener('error', () => {
        // Video rusak atau hilang: lewati agar papan tidak macet.
        if (my === token) unitTimer = setTimeout(() => my === token && showNext(), 1500);
      });
      f.appendChild(v);
      slide.appendChild(f);
      v.play().catch(() => {});
      startUnit();
    } else if (it.type === 'pdf') {
      showPdf(it, my);
    } else {
      startUnit();
    }
  }

  function startUnit() {
    if (!cur) return;
    const my = token;
    cur.unitEndsAt = Date.now() + cur.unitMs;
    if (!cur.startedAt) cur.startedAt = Date.now();
    clearTimeout(unitTimer);
    if (!cur.untilEnded) unitTimer = setTimeout(() => my === token && nextUnit(), cur.unitMs);
    tickCountdown();
  }

  function nextUnit() {
    if (!cur) return;
    if (cur.pdf && cur.doc && cur.unit + 1 < cur.units) {
      const my = token;
      cur.unit += 1;
      renderPdfPage(cur, my).then(() => my === token && startUnit());
    } else {
      showNext();
    }
  }

  // ----- PDF per halaman (pdf.js), dengan fallback ke penampil bawaan browser -----

  let pdfjsPromise = null;
  function loadPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import('/vendor/pdfjs/pdf.min.mjs').then((m) => {
        m.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
        return m;
      });
    }
    return pdfjsPromise;
  }

  async function showPdf(it, my) {
    const wrap = el('div', 'fill pdfbg');
    $('slide').appendChild(wrap);
    cur.loading = true;
    try {
      const m = await loadPdfjs();
      if (!pdfDocs.has(it.url)) {
        pdfDocs.set(it.url, m.getDocument({ url: it.url, standardFontDataUrl: '/vendor/pdfjs/standard_fonts/' }).promise);
      }
      const doc = await pdfDocs.get(it.url);
      if (my !== token) return;
      const canvas = document.createElement('canvas');
      wrap.appendChild(canvas);
      cur.doc = doc;
      cur.canvas = canvas;
      cur.wrap = wrap;
      cur.units = doc.numPages;
      cur.unit = 0;
      cur.totalMs = cur.units * cur.unitMs;
      await renderPdfPage(cur, my);
      if (my !== token) return;
      cur.loading = false;
      cur.startedAt = 0;
      startUnit();
    } catch (e) {
      if (my !== token) return;
      // Fallback: penampil PDF bawaan browser untuk seluruh dokumen, durasi dihitung sekali.
      pdfDocs.delete(it.url);
      wrap.innerHTML = '';
      const f = document.createElement('iframe');
      f.src = it.url + '#toolbar=0&navpanes=0&view=FitH';
      f.title = it.title || 'Dokumen';
      wrap.classList.remove('pdfbg');
      wrap.appendChild(f);
      cur.pdf = false;
      cur.units = 1;
      cur.loading = false;
      startUnit();
    }
  }

  async function renderPdfPage(c, my) {
    const page = await c.doc.getPage(c.unit + 1);
    if (my !== token) return;
    // Area gambar = kotak dikurangi padding (padding atas menyisakan ruang untuk pil hitung mundur).
    const box = c.wrap.getBoundingClientRect();
    const css = getComputedStyle(c.wrap);
    const availW = box.width - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
    const availH = box.height - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom);
    const v1 = page.getViewport({ scale: 1 });
    const fit = Math.min(availW / v1.width, availH / v1.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vp = page.getViewport({ scale: Math.max(0.2, fit) * dpr });
    c.canvas.width = Math.floor(vp.width);
    c.canvas.height = Math.floor(vp.height);
    c.canvas.style.width = Math.floor(vp.width / dpr) + 'px';
    c.canvas.style.height = Math.floor(vp.height / dpr) + 'px';
    await page.render({ canvasContext: c.canvas.getContext('2d'), viewport: vp }).promise;
  }

  // ----- Hitung mundur dan penanda progres -----

  function buildTracker() {
    const box = $('tracker');
    box.innerHTML = items.map(() => '<div class="seg"><i></i><span class="bubble"></span></div>').join('');
    $('trackerBox').classList.toggle('hidden', !items.length);
  }

  function tickCountdown() {
    if (!cur) return;
    const now = Date.now();
    let secs = 0;
    let text;
    if (cur.loading) {
      text = 'Memuat…';
    } else if (cur.untilEnded) {
      text = 'Video';
    } else {
      secs = Math.max(0, Math.ceil((cur.unitEndsAt - now) / 1000));
      text = cur.pdf && cur.units > 1
        ? 'Hal ' + (cur.unit + 1) + '/' + cur.units + ' · ' + secs + ' dtk'
        : secs + ' dtk';
    }
    const t = document.getElementById('cdText');
    if (t) t.textContent = text;

    // Segmen penanda: yang sudah lewat penuh, yang sedang tampil terisi sesuai waktu berjalan.
    const segs = $('tracker').children;
    if (segs.length !== items.length) buildTracker();
    let ratio = 0;
    if (!cur.loading && !cur.untilEnded && cur.startedAt && cur.totalMs) {
      ratio = Math.min(1, (now - cur.startedAt) / cur.totalMs);
    }
    for (let i = 0; i < segs.length; i += 1) {
      const s = segs[i];
      s.classList.toggle('done', i < idx);
      s.classList.toggle('cur', i === idx);
      const fill = s.firstElementChild;
      if (i === idx) {
        fill.style.width = (ratio * 100).toFixed(1) + '%';
        const b = s.lastElementChild;
        b.textContent = cur.untilEnded || cur.loading ? '•' : secs;
        b.style.left = Math.max(4, Math.min(96, ratio * 100)) + '%';
      } else {
        fill.style.width = '';
      }
    }
    $('trackerCount').textContent = items.length ? (idx + 1) + '/' + items.length : '';
  }

  function applyPlaylist(newPl) {
    const prevId = items[idx] && items[idx].id;
    playlist = newPl;
    items = playlist.main;
    prepareSaver();
    if (!items.length) return renderEmpty();
    buildTracker();
    const keep = items.findIndex((x) => x.id === prevId);
    if (keep >= 0) {
      // Item aktif tidak diganggu; hitung mundur lanjut sampai habis.
      idx = keep;
    } else {
      idx = -1;
      showNext();
    }
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
    const own = screenCfg && screenCfg.idleMinutes;
    const minutes = Math.max(1, parseInt(own || settings.idle_minutes || '3', 10));
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
      if (!v.loop && it.duration > 0) saverTimer = setTimeout(nextSaver, it.duration * 1000);
    } else {
      const img = document.createElement('img');
      img.src = it.url;
      img.alt = '';
      box.appendChild(img);
      saverTimer = setTimeout(nextSaver, Math.max(3, it.duration || 8) * 1000);
    }
    const logo = settings.org_logo ? '<img src="' + P.esc(settings.org_logo) + '" alt="">' : '';
    box.appendChild(el('div', 'glass', logo + '<span>' + P.esc(settings.org_name || '') + '</span>'));
    box.appendChild(el('div', 'clk num', P.fmtTime(P.timeSync.now(), tz())));
  }

  // ---------- Panel antrian ----------

  const FRESH_MS = 25000;
  let lastShownLabel = null;

  function counterBadge(name) {
    const m = /(\d+)\s*$/.exec(name || '');
    return m ? m[1] : window.Icons.initials(name);
  }

  function renderCalling() {
    if (!snap) return;
    const latest = snap.recent && snap.recent[0];
    const age = latest ? P.timeSync.now() - latest.calledAt : Infinity;
    const fresh = latest && age >= 0 && age < FRESH_MS;
    const body = $('nowBody');
    const pill = $('nowPill');
    if (fresh) {
      const star = latest.priority ? ' <span class="pill hi">' + P.icon('star') + 'Prioritas</span>' : '';
      body.innerHTML =
        '<div class="big num">' + P.esc(latest.label) + '</div>' +
        '<div class="where">Silakan menuju ' + P.esc(latest.counter || 'meja layanan') + star + '</div>';
      pill.innerHTML = P.icon('clock') + 'Dipanggil ' + P.fmtTime(latest.calledAt, tz()).slice(0, 5);
      pill.classList.remove('hidden');
      if (lastShownLabel !== latest.label + latest.calledAt) {
        lastShownLabel = latest.label + latest.calledAt;
        const panel = $('nowPanel');
        panel.classList.remove('flash');
        void panel.offsetWidth;
        panel.classList.add('flash');
      }
    } else {
      body.innerHTML = '<div class="big idle num">&mdash;</div><div class="where">Menunggu panggilan berikutnya</div>';
      pill.classList.add('hidden');
    }
  }

  function renderQueue() {
    if (!snap) return;
    renderCalling();
    $('statWaiting').textContent = snap.waiting ?? 0;
    $('statServing').textContent = snap.serving ?? 0;

    const box = $('counters');
    box.classList.toggle('two', snap.counters.length > 4);
    box.classList.toggle('dense', snap.counters.length > 10);
    box.innerHTML = snap.counters.length
      ? snap.counters.map((c) => {
          const cur = c.current;
          const queued = (c.dedicatedWaiting || []).length;
          const status = cur
            ? '<span class="pill busy"><span class="t">Melayani</span></span>'
            : '<span class="pill ok" title="Kosong"><span class="dot"></span><span class="t">Kosong</span></span>';
          return '<div class="ctr' + (cur ? ' busy' : '') + '">' +
            '<div class="av">' + P.esc(counterBadge(c.name)) + '</div>' +
            '<div class="grow"><div class="nm">' + P.esc(c.name) + '</div>' +
            '<div class="sb">' + P.esc(c.categoryName || 'Tanpa kategori') + (queued ? ' · antri ' + queued : '') + '</div></div>' +
            '<div class="rt">' + (cur ? '<span class="lb">' + P.esc(cur.label) + '</span>' : '') + status + '</div></div>';
        }).join('')
      : '<div class="muted">Belum ada meja</div>';

    $('recent').innerHTML = (snap.recent || []).slice(0, 4).map((r) =>
      '<span class="rc"><b>' + P.esc(r.label) + '</b> → ' + P.esc(r.counter || '') +
      (r.priority ? ' ' + P.icon('star') : '') + '</span>').join('');
  }

  // ---------- Muat data ----------

  function showBanner(text) {
    const b = $('offline');
    b.textContent = text;
    b.classList.remove('hidden');
  }

  function hideBanner() {
    if (!screenMissing) $('offline').classList.add('hidden');
  }

  // Slug yang belum terdaftar tetap menampilkan konten bersama, disertai peringatan.
  async function loadScreen() {
    if (!slug) return;
    try {
      screenCfg = await P.api('/api/screen/' + encodeURIComponent(slug));
      screenMissing = false;
      scopeQs = '?screen=' + encodeURIComponent(slug);
    } catch (e) {
      if (e.status === 404) {
        screenCfg = null;
        screenMissing = true;
        scopeQs = '';
        showBanner('Layar "' + slug + '" belum terdaftar di admin. Menampilkan konten bersama.');
      }
    }
    applyIdentity();
  }

  async function loadSettings() {
    settings = await P.api('/api/settings');
    applyIdentity();
  }

  async function loadPlaylist() {
    applyPlaylist(await P.api('/api/playlist' + scopeQs));
  }

  async function loadState() {
    try {
      snap = await P.api('/api/state' + scopeQs);
      renderQueue();
      updateSaver();
      hideBanner();
    } catch {
      showBanner('Koneksi ke server terputus, mencoba lagi…');
    }
  }

  async function loadAll() {
    try {
      await loadScreen();
      await Promise.all([loadSettings(), loadPlaylist(), loadState(), P.timeSync.sync()]);
    } catch {
      showBanner('Koneksi ke server terputus, mencoba lagi…');
    }
  }

  // ---------- Pemanggilan (suara) ----------

  function announce(c) {
    if (!unlocked) return;
    // Layar dengan filter kategori hanya mengumumkan panggilan untuk kategorinya.
    if (screenCfg && screenCfg.categoryIds.length && !screenCfg.categoryIds.includes(c.categoryId)) return;
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

  $('clockIc').innerHTML = P.icon('clock');

  $('unlockBtn').addEventListener('click', () => {
    unlocked = true;
    $('unlock').classList.add('hidden');
    try { P.chime(); } catch { /* ignore */ }
    try { speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch { /* ignore */ }
    if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {});
  });

  // ?sound=on: untuk perangkat kiosk yang browsernya dijalankan dengan --autoplay-policy=no-user-gesture-required
  // (lihat deploy/kiosk-display.sh). Bunyi diaktifkan tanpa menunggu ketukan; tanpa flag itu browser tetap
  // menahan audio sampai ada interaksi, jadi tanpa parameter ini overlay "Aktifkan" tetap dipakai.
  if (new URLSearchParams(location.search).get('sound') === 'on') {
    unlocked = true;
    $('unlock').classList.add('hidden');
    if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {});
  }

  P.connectWS((msg) => {
    switch (msg.type) {
      case 'hello': loadAll(); break;
      case 'queue': loadState(); break;
      case 'call': announce(msg); loadState(); break;
      case 'content': loadPlaylist(); break;
      case 'categories': loadState(); loadPlaylist(); break;
      case 'settings': loadSettings(); break;
      case 'screens': loadAll(); break;
    }
  });

  setInterval(loadState, 20000);
  setInterval(() => P.timeSync.sync(), 60000);
  setInterval(tickClock, 500);
  setInterval(tickCountdown, 250);
  // Papan tetap berjalan walau suara belum diaktifkan; tombol "Aktifkan" hanya mengatur bunyi.
  loadAll().then(tickClock);
})();
