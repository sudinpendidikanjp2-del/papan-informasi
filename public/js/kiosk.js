(function () {
  const P = window.Papan;
  const $ = (id) => document.getElementById(id);
  let settings = {};
  let cats = [];
  let busy = false;
  let hideTimer = null;

  $('clkIc').innerHTML = P.icon('clock');
  $('prioIc').innerHTML = P.icon('star');

  const tz = () => settings.timezone || 'Asia/Jakarta';
  function tickClock() { $('clock').textContent = P.fmtTime(P.timeSync.now(), tz()).slice(0, 5); }

  async function loadSettings() {
    try {
      settings = await P.api('/api/settings');
      $('orgName').textContent = settings.org_name || 'Ambil Nomor Antrian';
      document.title = 'Ambil Nomor · ' + (settings.org_name || '');
      const logo = $('logo');
      if (settings.org_logo) { logo.src = settings.org_logo; logo.classList.remove('hidden'); } else { logo.classList.add('hidden'); }
      $('prioBox').classList.toggle('hidden', settings.priority_enabled !== '1');
      if (settings.priority_enabled !== '1') $('prio').checked = false;
      render();
    } catch { /* biarkan tampilan sebelumnya */ }
  }

  async function loadCats() {
    cats = await P.api('/api/categories');
    render();
  }

  function render() {
    const box = $('cats');
    box.classList.toggle('prio-on', $('prio').checked);
    if (!cats.length) {
      box.innerHTML = '<div class="muted" style="grid-column:1/-1;text-align:center">Belum ada layanan.</div>';
      return;
    }
    box.innerHTML = cats.map((c) =>
      '<button class="cat" data-id="' + c.id + '">' +
      '<span class="top"><span class="code">' + P.esc(c.prefix) + '</span><span class="name">' + P.esc(c.name) + '</span></span>' +
      '<span class="meta">' +
      '<span class="m"><div class="k">Menunggu</div><div class="v">' + c.waiting + '</div></span>' +
      '<span class="m"><div class="k">Perkiraan</div><div class="v">' + (c.etaMinutes ? c.etaMinutes + ' mnt' : (c.waiting ? '-' : 'Langsung')) + '</div></span>' +
      '</span>' +
      '<span class="go">Ketuk untuk mengambil nomor ' + P.icon('right') + '</span></button>').join('');
  }

  $('cats').addEventListener('click', (e) => {
    const b = e.target.closest('button.cat');
    if (!b) return;
    take(cats.find((c) => String(c.id) === b.dataset.id), b);
  });
  $('prio').addEventListener('change', render);

  async function take(cat, btn) {
    if (busy || !cat) return;
    busy = true;
    btn.disabled = true;
    try {
      const priority = $('prio').checked;
      const t = await P.api('/api/tickets', { method: 'POST', body: { categoryId: cat.id, priority } });
      $('sNum').textContent = t.label;
      $('sCat').textContent = cat.name;
      $('sAhead').textContent = t.ahead;
      $('sEta').textContent = t.ahead === 0 ? 'Berikutnya' : (t.etaMinutes ? t.etaMinutes + ' mnt' : '-');
      const sp = $('sPrio');
      sp.innerHTML = t.priority ? P.icon('star') + 'Prioritas' : '';
      sp.classList.toggle('hidden', !t.priority);
      // QR ke halaman pantau di ponsel; disembunyikan bila gambar gagal dimuat.
      const qr = $('qr');
      $('track').classList.toggle('hidden', !t.token);
      qr.onerror = () => $('track').classList.add('hidden');
      if (t.token) qr.src = '/api/ticket/' + t.token + '/qr.svg';
      // Mulai ulang animasi sisa waktu tampil slip.
      const life = $('sLife');
      life.style.animation = 'none';
      void life.offsetWidth;
      life.style.animation = '';
      $('overlay').classList.remove('hidden');
      if (settings.sound_enabled !== '0') P.chime();
      clearTimeout(hideTimer);
      hideTimer = setTimeout(close, 20000);
      $('prio').checked = false;
      loadCats().catch(() => {});
    } catch (e) {
      P.toast(e.message || 'Gagal mengambil nomor');
    } finally {
      btn.disabled = false;
      busy = false;
    }
  }

  function close() {
    clearTimeout(hideTimer);
    $('overlay').classList.add('hidden');
    render();
  }
  $('overlay').addEventListener('click', close);

  loadSettings();
  loadCats().catch(() => P.toast('Gagal memuat layanan'));
  P.timeSync.sync().then(tickClock);
  setInterval(tickClock, 1000);
  setInterval(() => P.timeSync.sync(), 60000);
  P.connectWS((msg) => {
    if (msg.type === 'settings') loadSettings();
    if (msg.type === 'categories' || msg.type === 'queue' || msg.type === 'hello') loadCats().catch(() => {});
  });
})();
