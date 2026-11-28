import './icons.js';
import './common.js';
import { renderMarkdown } from './markdown.js';
import { loadYouTubeApi } from './youtube.js';

(function () {
  const P = window.Papan;
  const $ = (id) => document.getElementById(id);

  let settings = {};
  let playlist = { main: [], screensaver: [] };
  let snap = null;
  let unlocked = false;

  // Layar ini diidentifikasi lewat jalur /layar/<slug>. Tanpa slug (jalur /): semua antrian dan konten bersama.
  const pathSlug = (location.pathname.match(/^\/layar\/([^/]+)\/?$/) || [])[1];
  const slug = decodeURIComponent(pathSlug || '').trim().toLowerCase();
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

  const itemSig = (it) => JSON.stringify([it.type, it.title, it.body, it.url, it.videoId, it.duration]);

  function showItem(it) {
    clearTimeout(unitTimer);
    token += 1;
    const my = token;
    if (cur && cur.player) { try { cur.player.destroy(); } catch { /* sudah hilang */ } }
    const slide = $('slide');
    slide.innerHTML = '';
    $('trackerBox').classList.remove('hidden');

    cur = {
      item: it,
      sig: itemSig(it),
      pdf: it.type === 'pdf',
      untilEnded: (it.type === 'video' || it.type === 'youtube') && it.duration === 0,
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
      // Isi pengumuman adalah markdown; renderMarkdown menyanitasi hasilnya (tanpa atribut, tautan, atau gambar).
      const box = el('div', 'slide-text',
        '<div class="bar"></div>' + (it.title ? '<h2>' + P.esc(it.title) + '</h2>' : '') + '<div class="md">' + renderMarkdown(it.body) + '</div>');
      slide.appendChild(box);
      fitText(box);
      startUnit();
    } else if (it.type === 'youtube') {
      showYoutube(it, my);
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
        if (my !== token || !cur || !cur.untilEnded) return;
        if (paused) cur.endedWhilePaused = true; else showNext();
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

  // Teks panjang muat di panggung lewat tiga tahap: (1) diperkecil sampai batas masih terbaca (60%), (2) dibagi dua kolom
  // (hanya di layar lebar), (3) bila masih terpotong, ukuran tengah dan digulir otomatis pelan dari atas ke bawah selama
  // durasi tayang. Di layar interaktif pengunjung bisa menggulir manual saat tayangan dijeda.
  let scrollAnim = null;
  function stopScroll() {
    if (scrollAnim) { scrollAnim.cancel(); scrollAnim = null; }
  }

  function startAutoScroll(box, ms) {
    stopScroll();
    const stage = box.parentElement;
    const dist = box.scrollHeight - stage.clientHeight + 16;
    if (dist <= 0) return;
    const run = Math.max(6000, ms - 4000);
    // Jeda 2 detik di awal agar judul terbaca, lalu gulir linear; berhenti di dasar sampai item berganti.
    scrollAnim = box.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(-' + dist + 'px)' }], { duration: run, delay: 2000, easing: 'linear', fill: 'both' });
  }

  function fitText(box, durMs) {
    const stage = box.parentElement;
    const ms = durMs || (cur && cur.item ? cur.item.duration * 1000 : 20000);
    stopScroll();
    box.classList.remove('cols2');
    delete box.dataset.mode;
    stage.classList.remove('scrollmode', 'manual');
    stage.scrollTop = 0;
    box.style.transform = '';
    const fits = () => box.scrollHeight <= stage.clientHeight + 1 && box.scrollWidth <= box.clientWidth + 1;
    const shrink = (floor) => {
      let scale = 1;
      box.style.setProperty('--fit', '1');
      for (let i = 0; i < 20 && !fits() && scale > floor; i += 1) {
        scale -= 0.05;
        box.style.setProperty('--fit', scale.toFixed(2));
      }
      return fits();
    };
    if (shrink(0.6)) return;
    if (!narrow.matches) {
      box.classList.add('cols2');
      if (shrink(0.5)) return;
      box.classList.remove('cols2');
    }
    box.style.setProperty('--fit', '0.7');
    box.dataset.mode = 'scroll';
    stage.classList.add('scrollmode');
    if (paused && infoOnly) setManualScroll(true);
    else startAutoScroll(box, ms);
  }

  // Layar interaktif: saat dijeda, gulir otomatis berhenti dan pengunjung menggulir sendiri (roda mouse atau sentuhan).
  function setManualScroll(on) {
    const box = document.querySelector('.slide-text');
    if (!box || box.dataset.mode !== 'scroll') return;
    const stage = box.parentElement;
    if (on) {
      stopScroll();
      box.style.transform = '';
      stage.classList.add('manual');
    } else {
      stage.classList.remove('manual');
      stage.scrollTop = 0;
      startAutoScroll(box, cur && cur.item ? cur.item.duration * 1000 : 20000);
    }
  }

  // ----- YouTube (IFrame API): berganti saat video selesai; durasi item menjadi batas maksimum -----

  async function showYoutube(it, my) {
    const f = el('div', 'fill');
    const host = el('div');
    f.appendChild(host);
    $('slide').appendChild(f);
    cur.loading = true;
    const skip = (ms) => {
      clearTimeout(unitTimer);
      unitTimer = setTimeout(() => my === token && showNext(), ms);
    };
    // Pemutar yang tak kunjung siap (internet mati, video diblokir) dilewati agar papan tidak macet.
    skip(15000);
    try {
      const YT = await loadYouTubeApi();
      if (my !== token) return;
      cur.player = new YT.Player(host, {
        host: 'https://www.youtube-nocookie.com',
        videoId: it.videoId,
        width: '100%',
        height: '100%',
        playerVars: { autoplay: 1, mute: 1, controls: 0, rel: 0, modestbranding: 1, playsinline: 1, iv_load_policy: 3, disablekb: 1, fs: 0, origin: location.origin },
        events: {
          onReady: (e) => {
            if (my !== token) return;
            e.target.mute();
            e.target.playVideo();
            cur.loading = false;
            startUnit();
          },
          onStateChange: (e) => {
            if (my !== token || e.data !== YT.PlayerState.ENDED) return;
            if (paused) cur.endedWhilePaused = true; else showNext();
          },
          onError: () => skip(1500),
        },
      });
    } catch {
      if (my === token) skip(5000);
    }
  }

  function startUnit() {
    if (!cur) return;
    const my = token;
    cur.unitEndsAt = Date.now() + cur.unitMs;
    if (!cur.startedAt) cur.startedAt = Date.now();
    clearTimeout(unitTimer);
    if (paused) return tickCountdown(); // pengunjung sedang menjelajah: durasi tayang dimatikan sementara
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
      // Build legacy pdf.js (kompatibel dengan browser TV lama), dibundel Vite sebagai potongan terpisah.
      pdfjsPromise = Promise.all([
        import('pdfjs-dist/legacy/build/pdf.min.mjs'),
        import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
      ]).then(([m, w]) => {
        m.GlobalWorkerOptions.workerSrc = w.default;
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
        pdfDocs.set(it.url, m.getDocument({ url: it.url, standardFontDataUrl: '/pdf-fonts/' }).promise);
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
    if (paused) {
      text = 'Dijeda';
    } else if (cur.loading) {
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
    if (paused) {
      ratio = cur.frozenRatio || 0; // isian bilah berhenti di posisi terakhir selama pengunjung menjelajah
    } else if (!cur.loading && !cur.untilEnded && cur.startedAt && cur.totalMs) {
      ratio = Math.min(1, (now - cur.startedAt) / cur.totalMs);
      cur.frozenRatio = ratio;
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
    markGrid();
  }

  function applyPlaylist(newPl) {
    const prevId = items[idx] && items[idx].id;
    playlist = newPl;
    items = playlist.main;
    prepareSaver();
    renderInfoGrid();
    if (!items.length) return renderEmpty();
    buildTracker();
    if (infoOnly) renderBrowseList();
    const keep = items.findIndex((x) => x.id === prevId);
    if (keep >= 0) {
      // Item aktif tidak diganggu selama isinya sama; hitung mundur lanjut sampai habis. Bila admin mengubah
      // isinya (judul, teks, tautan, durasi), item itu ditampilkan ulang agar perubahan langsung terlihat.
      idx = keep;
      if (cur && cur.sig !== itemSig(items[idx])) showItem(items[idx]);
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
    if (!saverItems.length || (!infoOnly && !snap)) return false;
    const own = screenCfg && screenCfg.idleMinutes;
    const minutes = Math.max(1, parseInt(own || settings.idle_minutes || '3', 10));
    // Diam = tanpa aktivitas antrian (bila layar menampilkan antrian) dan tanpa gerakan kursor/sentuhan/tombol.
    const last = Math.max(infoOnly || !snap ? 0 : snap.lastActivity, lastUserActivity);
    return P.timeSync.now() - last > minutes * 60000;
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
    // Ponsel/tablet potret: selalu satu kolom dengan baris penuh (kelas two/dense hanya untuk tata letak TV).
    box.classList.toggle('two', !narrow.matches && snap.counters.length > 4);
    box.classList.toggle('dense', !narrow.matches && snap.counters.length > 10);
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
    renderQCard();
  }

  // ---------- Kartu antrian mengambang (ponsel/tablet potret) ----------
  // Nomor terakhir dipanggil + kisi meja; dapat diseret (menempel ke sudut terdekat) atau diperkecil menjadi tombol.
  // Panggilan baru membuka kembali kartu yang diperkecil. Posisi dan status diingat per layar di perangkat ini.
  const qKeyName = 'papan.qcard.' + (slug || 'all');
  const qState = { c: 'tl', m: false };
  try { Object.assign(qState, JSON.parse(localStorage.getItem(qKeyName) || '{}')); } catch { /* mode privat */ }
  let qSeen = null;
  const saveQ = () => { try { localStorage.setItem(qKeyName, JSON.stringify(qState)); } catch { /* mode privat */ } };

  function renderQCard() {
    if (infoOnly || !snap) return;
    document.body.classList.add('qon');
    const latest = snap.recent && snap.recent[0];
    const label = latest ? latest.label : '—';
    $('qnow').innerHTML = '<div class="qn num' + (latest ? '' : ' idle') + '">' + P.esc(label) + '</div>' +
      '<div class="qw">' + (latest ? 'ke ' + P.esc(latest.counter || 'meja layanan') : 'Menunggu panggilan') + '</div>';
    $('qfabNum').textContent = label;
    $('qgrid').innerHTML = snap.counters.length
      ? snap.counters.map((c) =>
          '<div class="qc' + (c.current ? ' busy' : '') + '"><b class="num">' + (c.current ? P.esc(c.current.label) : 'Kosong') +
          '</b><span>' + P.esc(c.name) + '</span></div>').join('')
      : '<div class="muted">Belum ada meja</div>';

    const key = latest ? latest.label + '@' + latest.calledAt : '';
    // Muat pertama memakai status tersimpan; hanya panggilan yang datang sesudahnya yang membuka kartu lagi.
    const isNew = key && qSeen !== null && key !== qSeen;
    qSeen = key;
    if (isNew) {
      if (qState.m) { qState.m = false; saveQ(); }
      const card = $('qcard');
      card.classList.remove('flash');
      void card.offsetWidth;
      card.classList.add('flash');
    }
    document.body.classList.toggle('qmin', qState.m);
    placeQ();
  }

  // Sudut menempel: margin 12 px + area aman; sudut atas berada di bawah header agar tidak menutup nama instansi.
  function placeQ(live) {
    const el = qState.m ? $('qfab') : $('qcard');
    if (!el || !narrow.matches || infoOnly) return;
    const probe = $('qsafe');
    const cs = getComputedStyle(probe);
    const M = 12;
    const sl = parseFloat(cs.paddingLeft) || 0, sr = parseFloat(cs.paddingRight) || 0, sb = parseFloat(cs.paddingBottom) || 0, st = parseFloat(cs.paddingTop) || 0;
    const w = el.offsetWidth, h = el.offsetHeight;
    const headBottom = Math.max(0, document.querySelector('.head').getBoundingClientRect().bottom);
    const left = M + sl;
    const right = innerWidth - w - M - sr;
    const top = Math.max(M + st, headBottom + 8);
    const bottom = innerHeight - h - M - sb;
    const c = qState.c;
    el.style.transition = live ? 'none' : '';
    el.style.left = Math.max(0, c[1] === 'r' ? right : left) + 'px';
    el.style.top = Math.max(0, c[0] === 'b' ? bottom : Math.min(top, bottom)) + 'px';
  }

  function dragQ(el, handle, onTap) {
    let sx = 0, sy = 0, ox = 0, oy = 0, moved = false, id = null;
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button') && e.target.closest('button') !== handle) return;
      id = e.pointerId;
      sx = e.clientX; sy = e.clientY;
      ox = el.offsetLeft; oy = el.offsetTop;
      moved = false;
      handle.setPointerCapture(id);
    });
    handle.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 6) return;
      moved = true;
      el.style.transition = 'none';
      el.style.left = Math.max(0, Math.min(innerWidth - el.offsetWidth, ox + dx)) + 'px';
      el.style.top = Math.max(0, Math.min(innerHeight - el.offsetHeight, oy + dy)) + 'px';
    });
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      if (!moved) { if (onTap) onTap(); return; }
      const cx = el.offsetLeft + el.offsetWidth / 2, cy = el.offsetTop + el.offsetHeight / 2;
      qState.c = (cy > innerHeight / 2 ? 'b' : 't') + (cx > innerWidth / 2 ? 'r' : 'l');
      saveQ();
      placeQ();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    // Klik yang menyusul seret tidak boleh memicu aksi tombol di dalamnya.
    handle.addEventListener('click', (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);
  }
  dragQ($('qcard'), $('qgrip'), null);
  dragQ($('qfab'), $('qfab'), () => { qState.m = false; saveQ(); renderQCard(); });
  $('qmin').addEventListener('click', () => { qState.m = true; saveQ(); renderQCard(); });
  window.addEventListener('resize', () => placeQ());

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
    applyMode();
  }

  // Mode layar: tampil antrian atau hanya papan informasi. Perubahan mode saat berjalan memuat ulang halaman
  // (suara, overlay, dan langganan antrian bergantung pada mode sejak awal).
  let modeKnown = false;
  function applyMode() {
    const want = !!(screenCfg && screenCfg.showQueue === false);
    if (!modeKnown) {
      modeKnown = true;
      infoOnly = want;
      document.getElementById('board').classList.toggle('info-only', want);
      document.body.classList.toggle('info-only', want); // tombol "Daftar" mengambang berada di luar #board
      if (want) {
        unlocked = true; // tanpa suara antrian, tidak perlu menunggu ketukan "Aktifkan"
        $('unlock').classList.add('hidden');
      }
    } else if (want !== infoOnly) {
      location.reload();
    }
  }

  async function loadSettings() {
    settings = await P.api('/api/settings');
    applyIdentity();
  }

  async function loadPlaylist() {
    applyPlaylist(await P.api('/api/playlist' + scopeQs));
  }

  async function loadState() {
    if (infoOnly) return; // layar papan-informasi-saja tidak memuat antrian
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

  // ---------- Aktivitas pengunjung: screensaver, kursor, dan menjelajah (layar tanpa antrian) ----------

  let infoOnly = false;
  let paused = false;        // pengunjung sedang menjelajah: durasi tayang dibekukan
  let resumeTimer = null;
  let cursorTimer = null;
  let lastX = null;
  let lastY = null;
  let lastUserActivity = P.timeSync.now();
  const resumeMs = () => ((screenCfg && screenCfg.resumeSeconds) || 20) * 1000;
  const MOVE_THRESHOLD = 8; // piksel; getaran kecil sensor/mouse tidak dihitung

  function showCursor() {
    document.body.classList.remove('nocursor');
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => document.body.classList.add('nocursor'), 3000);
  }

  function onUserActivity(kind, e) {
    if (kind === 'move') {
      if (lastX === null) { lastX = e.clientX; lastY = e.clientY; return; }
      if (Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY) < MOVE_THRESHOLD) return;
      lastX = e.clientX;
      lastY = e.clientY;
    }
    lastUserActivity = P.timeSync.now();
    showCursor();
    if (saverOn) stopSaver(); // screensaver hilang begitu kursor bergerak atau layar disentuh
    // Di ponsel, hanya ketukan pada kartu informasi yang menjeda tayangan (gulir dan sentuhan biasa tidak).
    if (infoOnly && !narrow.matches) enterBrowse();
  }
  document.addEventListener('pointermove', (e) => onUserActivity('move', e), { passive: true });
  for (const t of ['pointerdown', 'keydown', 'touchstart', 'wheel']) document.addEventListener(t, (e) => onUserActivity(t, e), { passive: true });
  showCursor();

  // Tata letak ponsel (<= 820 px): kolom meja dan teks panjang dihitung ulang saat ukuran layar berubah.
  const narrow = window.matchMedia('(max-width: 820px)');
  narrow.addEventListener('change', () => {
    renderQueue();
    placeQ();
    const box = document.querySelector('.slide-text');
    if (box) fitText(box);
  });
  window.addEventListener('resize', () => {
    const box = document.querySelector('.slide-text');
    if (box) fitText(box);
  });
  // Lebar panggung berubah saat daftar pilihan membuka/menutup: ukur ulang teks agar tetap muat.
  let refitQueued = false;
  new ResizeObserver(() => {
    if (refitQueued) return;
    refitQueued = true;
    requestAnimationFrame(() => {
      refitQueued = false;
      const box = document.querySelector('.slide-text');
      if (box) fitText(box);
    });
  }).observe($('slide'));

  const TYPE_ICON = { text: 'list', image: 'image', video: 'play', pdf: 'file', youtube: 'youtube' };
  const TYPE_LABEL = { text: 'Teks', image: 'Gambar', video: 'Video', pdf: 'Dokumen PDF', youtube: 'Video YouTube' };

  // Kartu informasi 2 kolom di bawah panggung (hanya tampil di ponsel/tablet potret).
  let gridIdx = -2;
  function renderInfoGrid() {
    const box = $('infoGrid');
    box.innerHTML = items.map((it, i) =>
      '<button type="button" class="ig' + (i === idx ? ' on' : '') + '" data-i="' + i + '"' + (i === idx ? ' aria-current="true"' : '') + '>' +
      '<span class="bic">' + P.icon(TYPE_ICON[it.type] || 'list') + '</span>' +
      '<span class="n">' + P.esc(it.title || TYPE_LABEL[it.type] || 'Informasi') + '</span>' +
      '<span class="m">' + (TYPE_LABEL[it.type] || '') + '</span></button>').join('');
    box.parentElement.classList.toggle('has-grid', items.length > 0);
    gridIdx = idx;
  }

  // Menyorot kartu yang sedang tayang tanpa menggambar ulang (agar ketukan yang sedang berlangsung tidak hilang).
  function markGrid() {
    if (gridIdx === idx) return;
    gridIdx = idx;
    $('infoGrid').querySelectorAll('.ig').forEach((b, i) => {
      b.classList.toggle('on', i === idx);
      if (i === idx) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    });
  }

  $('infoGrid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    enterBrowse(); // jeda; lanjut otomatis setelah resumeSeconds tanpa interaksi
    jumpTo(Number(b.dataset.i));
  });

  function renderBrowseList() {
    renderInfoGrid();
    const box = $('browseList');
    box.innerHTML = items.map((it, i) =>
      '<button type="button" class="bi' + (i === idx ? ' on' : '') + '" data-i="' + i + '"' + (i === idx ? ' aria-current="true"' : '') + '>' +
      '<span class="bic">' + P.icon(TYPE_ICON[it.type] || 'list') + '</span>' +
      '<span class="bt"><span class="n">' + P.esc(it.title || TYPE_LABEL[it.type] || 'Informasi') + '</span>' +
      '<span class="m">' + (TYPE_LABEL[it.type] || '') + '</span></span></button>').join('');
    $('browsePdf').classList.toggle('hidden', !(cur && cur.pdf && cur.doc && cur.units > 1));
    const on = box.querySelector('.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  }

  function enterBrowse() {
    if (!items.length) return;
    document.body.classList.add('browsing');
    if (!paused) {
      paused = true;
      clearTimeout(unitTimer); // matikan durasi penayangan selama pengunjung melihat-lihat
      setManualScroll(true);
      tickCountdown();
    }
    // Daftar hanya digambar ulang saat dibuka: menggambar ulang tiap gerakan menghapus tombol yang sedang diklik.
    if (!$('browse').classList.contains('open')) renderBrowseList();
    $('browse').classList.add('open');
    document.querySelector('.stage').classList.add('browsing');
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(leaveBrowse, resumeMs());
  }

  // Tidak ada gerakan selama resumeSeconds: sembunyikan daftar dan lanjutkan dengan durasi penayangan penuh.
  function leaveBrowse() {
    paused = false;
    clearTimeout(resumeTimer);
    document.body.classList.remove('browsing');
    $('browse').classList.remove('open');
    document.querySelector('.stage').classList.remove('browsing');
    setManualScroll(false);
    if (!cur || cur.endedWhilePaused) return showNext();
    cur.startedAt = 0;
    cur.frozenRatio = 0;
    startUnit();
  }

  function jumpTo(i) {
    if (!items[i]) return;
    idx = i;
    showItem(items[i]); // startUnit menahan timer selama paused
    renderBrowseList();
  }

  function pdfStep(d) {
    if (!cur || !cur.pdf || !cur.doc) return;
    const u = Math.max(0, Math.min(cur.units - 1, cur.unit + d));
    if (u === cur.unit) return;
    cur.unit = u;
    renderPdfPage(cur, token);
    tickCountdown();
  }

  $('browseClose').addEventListener('click', () => leaveBrowse());
  $('browse').addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (b) return jumpTo(Number(b.dataset.i));
    const p = e.target.closest('[data-pdf]');
    if (p) pdfStep(Number(p.dataset.pdf));
  });

  // ---------- Pemanggilan (suara) ----------

  function announce(c) {
    if (!unlocked || infoOnly) return;
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
