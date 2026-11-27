import './icons.js';
import './common.js';

(function () {
  const P = window.Papan;
  const I = window.Icons;
  const $ = (id) => document.getElementById(id);
  let user = null;   // hasil /api/auth/me
  let state = null;  // hasil /api/state
  let tab = 'panel';
  let tzName = 'Asia/Jakarta';
  P.api('/api/settings').then((s) => { tzName = s.timezone || tzName; }).catch(() => {});

  // Ikon pada tombol statis
  $('loginLogo').innerHTML = P.icon('monitor', 'lg');
  $('switch').innerHTML = P.icon('swap') + 'Ganti meja';
  $('logout').innerHTML = P.icon('logout') + 'Keluar';
  $('next').innerHTML = P.icon('bell') + 'Panggil berikutnya';
  $('recall').innerHTML = P.icon('bell') + 'Panggil ulang';
  $('done').innerHTML = P.icon('check') + 'Selesai';
  $('skip').innerHTML = P.icon('x') + 'Lewati';
  $('xferBtn').innerHTML = P.icon('swap') + 'Pindahkan';
  $('xferCatBtn').innerHTML = P.icon('swap') + 'Pindahkan';
  $('newBtn').innerHTML = P.icon('ticket') + 'Buat nomor';
  $('nav-panel').innerHTML = P.icon('monitor') + 'Panel';
  $('nav-new').innerHTML = P.icon('ticket') + 'Buat nomor';
  $('nav-hist').innerHTML = P.icon('history') + 'Riwayat';

  function show(view) {
    for (const v of ['loginView', 'pickView', 'panelView']) $(v).classList.toggle('hidden', v !== view);
  }

  function showTab(name) {
    tab = name;
    for (const t of ['panel', 'new', 'hist']) {
      $('pane-' + t).classList.toggle('hidden', t !== name);
      $('nav-' + t).classList.toggle('on', t === name);
    }
    if (name === 'hist') loadHistory();
  }
  document.querySelectorAll('.nav button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // Tentukan layar yang tampil dari status sesi.
  async function route() {
    try {
      user = await P.api('/api/auth/me');
    } catch {
      user = null;
      show('loginView');
      return;
    }
    if (!user.counterId) {
      renderPick();
      show('pickView');
      return;
    }
    await loadState();
    show('panelView');
    showTab(tab);
  }

  // ----- Login & keluar -----
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginErr').textContent = '';
    try {
      await P.api('/api/auth/login', { method: 'POST', body: { username: $('u').value, password: $('p').value } });
      $('p').value = '';
      await route();
    } catch (err) {
      $('loginErr').textContent = err.message;
    }
  });

  async function doLogout() {
    try {
      await P.api('/api/auth/logout', { method: 'POST', body: {} });
      user = null;
      show('loginView');
    } catch (err) {
      P.toast(err.message);
    }
  }
  $('logout').addEventListener('click', doLogout);
  $('pickLogout').addEventListener('click', doLogout);

  // ----- Pilih meja -----
  function renderPick() {
    $('pickWho').textContent = 'Halo, ' + user.name + '. Pilih meja yang akan Anda pakai.';
    $('pickErr').textContent = '';
    $('pickList').innerHTML = user.counters.length
      ? user.counters.map((c) =>
          '<button class="btn btn-ghost btn-lg" style="justify-content:space-between;text-align:left" data-id="' + c.id + '"' + (c.busy ? ' disabled' : '') + '>' +
          '<span class="who"><span class="avatar sq">' + P.esc(counterBadge(c.name)) + '</span><span><div class="n">' + P.esc(c.name) + '</div>' +
          '<div class="s">' + P.esc(c.categoryName || 'Tanpa kategori') + '</div></span></span>' +
          '<span class="pill ' + (c.busy ? 'off' : 'ok') + '">' + (c.busy ? 'Sedang dipakai' : 'Tersedia') + '</span></button>').join('')
      : '<p class="muted">Belum ada meja yang diizinkan untuk akun Anda. Hubungi admin.</p>';
  }

  function counterBadge(name) {
    const m = /(\d+)\s*$/.exec(name || '');
    return m ? m[1] : I.initials(name);
  }

  $('pickList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-id]');
    if (!btn) return;
    try {
      await P.api('/api/auth/counter', { method: 'POST', body: { counterId: Number(btn.dataset.id) } });
      await route();
    } catch (err) {
      $('pickErr').textContent = err.message;
      refreshPick();
    }
  });

  async function refreshPick() {
    try {
      user = await P.api('/api/auth/me');
      if (!user.counterId) renderPick();
    } catch { /* sesi habis, ditangani saat route berikutnya */ }
  }

  $('switch').addEventListener('click', async () => {
    try {
      await P.api('/api/auth/counter', { method: 'POST', body: { counterId: null } });
      await route();
    } catch (err) {
      P.toast(err.message);
    }
  });

  // ----- Panel -----
  async function loadState() {
    state = await P.api('/api/state');
    render();
  }

  const myCounter = () => state && user && state.counters.find((c) => c.id === user.counterId);

  function render() {
    const me = myCounter();
    if (!me) return;
    const cur = me.current;
    $('meAv').textContent = I.initials(user.name);
    $('meName').textContent = user.name;
    $('meCounter').textContent = me.name + (me.categoryName ? ' · ' + me.categoryName : '');

    const big = $('cur');
    big.textContent = cur ? cur.label : '—';
    big.classList.toggle('idle', !cur);
    $('curSub').textContent = cur
      ? 'Sedang dilayani (sudah dipanggil)'
      : 'Belum ada antrian yang dilayani';
    const pill = $('curPill');
    pill.className = 'hero-pill' + (cur && cur.priority ? ' y' : '');
    pill.innerHTML = cur
      ? (cur.priority ? P.icon('star') + 'Prioritas' : P.icon('clock') + 'Dilayani')
      : P.icon('clock') + 'Siap';

    $('next').disabled = !!cur;
    $('recall').disabled = !cur;
    $('done').disabled = !cur;
    $('skip').disabled = !cur;

    const cat = state.categories.find((k) => k.id === me.categoryId);
    $('waiting').textContent = cat ? cat.waiting : 0;
    const ded = me.dedicatedWaiting || [];
    $('dedicated').textContent = ded.length;
    $('queued').innerHTML = ded.map((d) =>
      '<span class="pill ' + (d.priority ? 'hi' : '') + '">' + (d.priority ? P.icon('star') : '') + P.esc(d.label) + '</span>').join('');
    $('hint').textContent = me.categoryName
      ? 'Melayani kategori ' + me.categoryName + '. Antrian kategori dipanggil oleh meja yang sedang kosong; antrian khusus meja dipanggil lebih dulu.'
      : 'Meja ini belum dipetakan ke kategori. Hubungi admin untuk pemetaan.';

    // Pindah antrian: hanya saat memegang antrian, tujuan = meja lain yang aktif.
    const others = state.counters.filter((c) => c.id !== me.id);
    $('xferCard').classList.toggle('hidden', !cur || !others.length);
    const keep = $('xferTo').value;
    $('xferTo').innerHTML = others.map((c) => '<option value="' + c.id + '">' + P.esc(c.name) + (c.current ? ' (sibuk)' : ' (kosong)') + '</option>').join('');
    if (keep && others.some((c) => String(c.id) === keep)) $('xferTo').value = keep;

    // Pindah ke kategori: kategori yang sama berarti "kembalikan ke antrian" (nomor tetap).
    const keepCat = $('xferCat').value;
    $('xferCat').innerHTML = state.categories.map((k) =>
      '<option value="' + k.id + '">' + P.esc(k.name) + ' (' + P.esc(k.prefix) + ')' +
      (cur && k.id === cur.categoryId ? ' - kembalikan ke antrian' : ' - ' + k.waiting + ' menunggu') + '</option>').join('');
    const fallback = state.categories.find((k) => !cur || k.id !== cur.categoryId);
    $('xferCat').value = keepCat && state.categories.some((k) => String(k.id) === keepCat) ? keepCat : (fallback ? String(fallback.id) : '');
    updateXferHint();
    $('xferCard').classList.toggle('hidden', !cur || (!others.length && state.categories.length < 1));

    // Form buat nomor
    const selected = $('newCat').value;
    $('newCat').innerHTML = state.categories.map((k) => '<option value="' + k.id + '">' + P.esc(k.name) + ' (' + P.esc(k.prefix) + ')</option>').join('');
    $('newCat').value = selected || (me.categoryId ? String(me.categoryId) : '');
  }

  async function act(action, body) {
    const me = myCounter();
    if (!me) return null;
    try {
      const r = await P.api('/api/counter/' + me.id + '/' + action, { method: 'POST', body: body || {} });
      await loadState();
      return r;
    } catch (e) {
      if (e.status === 401) { route(); return null; }
      P.toast(e.message);
      return null;
    }
  }
  for (const a of ['next', 'recall', 'done', 'skip']) $(a).addEventListener('click', () => act(a));

  $('xferBtn').addEventListener('click', async () => {
    const r = await act('transfer', { toCounterId: Number($('xferTo').value) });
    if (r) P.toast('Nomor ' + r.label + ' dipindahkan ke ' + r.to);
  });

  // Mode pindah: ke meja atau ke kategori
  function setXferMode(m) {
    document.querySelectorAll('#xferMode button').forEach((b) => {
      b.classList.toggle('on', b.dataset.m === m);
      b.setAttribute('aria-selected', String(b.dataset.m === m));
    });
    $('xferCounter').classList.toggle('hidden', m !== 'counter');
    $('xferCategory').classList.toggle('hidden', m !== 'category');
  }
  $('xferMode').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-m]');
    if (b) setXferMode(b.dataset.m);
  });

  function updateXferHint() {
    const me = myCounter();
    const cur = me && me.current;
    const target = state && state.categories.find((k) => String(k.id) === $('xferCat').value);
    if (!cur || !target) { $('xferCatHint').textContent = ''; return; }
    $('xferCatHint').textContent = target.id === cur.categoryId
      ? 'Nomor tetap ' + cur.label + ' dan kembali ke antrian kategori ini (tidak lagi khusus satu meja).'
      : 'Nomor baru diterbitkan di kategori ' + target.name + ' (awalan ' + target.prefix + '), dan pengunjung diberi tahu lewat halaman pantau. Waktu tunggu awal tetap dihitung, sehingga dilayani sesuai waktu kedatangan.';
  }
  $('xferCat').addEventListener('change', updateXferHint);

  $('xferCatBtn').addEventListener('click', async () => {
    const me = myCounter();
    const cur = me && me.current;
    const r = await act('transfer', { toCategoryId: Number($('xferCat').value), priority: $('xferPrio').checked });
    if (!r) return;
    $('xferPrio').checked = false;
    P.toast(r.prevLabel
      ? 'Nomor ' + r.prevLabel + ' dipindahkan: kini ' + r.label + ' di ' + r.to
      : 'Nomor ' + (cur ? cur.label : r.label) + ' dikembalikan ke antrian ' + r.to);
  });

  // ----- Buat nomor -----
  $('newForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await act('ticket', {
      categoryId: Number($('newCat').value) || null,
      priority: $('newPrio').checked,
      dedicated: $('newDed').checked,
    });
    if (!r) return;
    $('nrNum').textContent = r.label;
    $('nrCat').textContent = r.categoryName;
    $('nrAhead').textContent = r.ahead;
    $('nrEta').textContent = r.ahead === 0 ? 'Berikutnya' : (r.etaMinutes ? r.etaMinutes + ' mnt' : '-');
    const np = $('nrPrio');
    np.innerHTML = r.priority ? P.icon('star') + 'Prioritas' : '';
    np.classList.toggle('hidden', !r.priority);
    $('newResult').classList.remove('hidden');
    $('newPrio').checked = false;
    $('newDed').checked = false;
  });

  // ----- Riwayat -----
  // Status riwayat: [kelas pil, label]
  const STATUS = { done: ['ok', 'Selesai'], skipped: ['warn', 'Dilewati'], serving: ['', 'Dilayani'], waiting: ['off', 'Menunggu'] };
  async function loadHistory() {
    try {
      const rows = await P.api('/api/auth/history');
      $('histCount').textContent = rows.length;
      $('histList').innerHTML = rows.length
        ? rows.map((r) => {
            const s = STATUS[r.status] || ['off', r.status];
            const t = r.calledAt ? P.fmtTime(r.calledAt, tzName).slice(0, 5) : '';
            return '<div class="item"><div><div class="lb">' + P.esc(r.label) + (r.priority ? ' ' + P.icon('star') : '') + '</div>' +
              '<div class="meta">' + P.esc(r.counter || '') + (t ? ' · ' + t : '') + '</div></div>' +
              '<span class="pill ' + s[0] + '">' + s[1] + '</span></div>';
          }).join('')
        : '<div class="empty">Belum ada antrian yang Anda layani hari ini.</div>';
    } catch (e) {
      if (e.status === 401) route();
    }
  }

  route();
  P.connectWS((msg) => {
    if (!user) return;
    if (user.counterId && (msg.type === 'queue' || msg.type === 'categories')) {
      loadState().then(() => { if (tab === 'hist') loadHistory(); }).catch(() => {});
    }
    if (!user.counterId && msg.type === 'queue') refreshPick();
  });
  setInterval(() => {
    if (user && user.counterId) loadState().catch(() => route());
  }, 15000);
})();
