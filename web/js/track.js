import './icons.js';
import './common.js';

(function () {
  const P = window.Papan;
  const $ = (id) => document.getElementById(id);
  const token = decodeURIComponent((location.pathname.match(/^\/antrian\/([^/]+)\/?$/) || [])[1] || '').toLowerCase();
  const valid = /^[a-f0-9]{24}$/.test(token);

  let st = null;          // status tiket terakhir
  let prev = null;        // status sebelumnya, untuk mendeteksi perubahan
  let alertsOn = false;   // suara dan getar sudah diaktifkan (butuh sentuhan pengguna)
  let pushOn = false;
  let pushCfg = { enabled: false, publicKey: '' };
  let flashTimer = null;
  const baseTitle = document.title;

  $('nearIc').innerHTML = P.icon('bell');
  $('movedIc').innerHTML = P.icon('swap');
  $('missIc').innerHTML = P.icon('ticket');
  $('enable').innerHTML = P.icon('bell') + 'Aktifkan peringatan';

  // ---------- Dukungan perangkat ----------
  const canPush = () =>
    window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  function b64ToBytes(s) {
    const pad = '='.repeat((4 - (s.length % 4)) % 4);
    const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  // ---------- Tampilan ----------
  function missing(title, text) {
    $('ticket').classList.add('hidden');
    $('missing').classList.remove('hidden');
    $('missTitle').textContent = title;
    $('missText').textContent = text;
  }

  function render() {
    const s = st;
    if (!s) return;
    $('org').textContent = s.orgName || 'Pantau Antrian';
    if (s.expired) return missing('Tiket sudah tidak berlaku', 'Nomor antrian berlaku pada hari pengambilan saja. Silakan ambil nomor baru di kiosk.');
    $('missing').classList.add('hidden');
    $('ticket').classList.remove('hidden');

    const hero = $('hero');
    hero.className = 'hero' + (s.status === 'serving' ? ' called' : '') + (s.status === 'done' || s.status === 'skipped' ? ' finished' : '');
    $('label').textContent = s.label;
    $('cat').textContent = s.categoryName;

    const pill = $('pill');
    const prio = s.priority ? ' y' : '';
    const callBox = $('callBox');
    callBox.classList.add('hidden');
    $('stats').classList.add('hidden');
    $('finishBox').classList.add('hidden');
    $('nearBanner').classList.add('hidden');
    // Nomor berganti karena petugas memindahkan antrian ke kategori lain.
    const moved = s.status === 'waiting' && s.prevLabel;
    $('movedBanner').classList.toggle('hidden', !moved);
    if (moved) {
      $('movedText').textContent = 'Nomor Anda dipindahkan dari ' + s.prevLabel + ' ke ' + s.label +
        ' (' + s.categoryName + '). Gunakan nomor baru ini. Waktu tunggu awal tetap dihitung.';
    }

    if (s.status === 'waiting') {
      pill.className = 'hero-pill' + prio;
      pill.innerHTML = s.priority ? P.icon('star') + 'Prioritas · menunggu' : P.icon('clock') + 'Menunggu';
      $('stats').classList.remove('hidden');
      $('ahead').textContent = s.ahead ?? '-';
      $('eta').textContent = s.ahead === 0 ? 'Berikutnya' : (s.etaMinutes ? s.etaMinutes + ' mnt' : '-');
      if (s.ahead !== null && s.ahead <= s.nearAt) $('nearBanner').classList.remove('hidden');
      if (s.dedicatedTo) {
        callBox.textContent = 'Akan dipanggil oleh ' + s.dedicatedTo;
        callBox.classList.remove('hidden');
      }
    } else if (s.status === 'serving') {
      // Dipanggil berarti sudah dilayani: tidak ada keadaan "dipanggil" terpisah.
      pill.className = 'hero-pill y';
      pill.innerHTML = P.icon('bell') + 'Giliran Anda';
      callBox.textContent = 'Silakan menuju ' + (s.counter || 'meja layanan');
      callBox.classList.remove('hidden');
    } else {
      pill.className = 'hero-pill';
      pill.innerHTML = P.icon(s.status === 'done' ? 'check' : 'x') + (s.status === 'done' ? 'Selesai' : 'Dilewati');
      const fb = $('finishBox');
      fb.classList.remove('hidden');
      fb.innerHTML = '<div class="bigmsg">' + (s.status === 'done'
        ? 'Terima kasih, layanan Anda telah selesai.'
        : 'Nomor Anda dilewati karena tidak hadir saat dipanggil.') + '</div>' +
        (s.status === 'skipped' ? '<div class="cat">Silakan ambil nomor baru di kiosk atau tanyakan kepada petugas.</div>' : '');
    }
    renderAlertStates();
  }

  function renderAlertStates() {
    const rows = [];
    rows.push(['on' , alertsOn, 'Suara dan getar di halaman ini', alertsOn ? 'Aktif. Berbunyi saat hampir giliran dan saat dipanggil.' : 'Belum aktif. Ketuk tombol di bawah.']);
    let pushDesc;
    if (pushOn) pushDesc = 'Aktif. Peringatan tetap datang walau halaman ditutup.';
    else if (!pushCfg.enabled) pushDesc = 'Dimatikan oleh admin.';
    else if (!window.isSecureContext) pushDesc = 'Tidak tersedia: situs ini dibuka lewat HTTP. Notifikasi push butuh HTTPS.';
    else if (!canPush()) pushDesc = 'Browser ini tidak mendukung notifikasi push.';
    else if (typeof Notification !== 'undefined' && Notification.permission === 'denied') pushDesc = 'Diblokir di pengaturan browser. Izinkan notifikasi untuk situs ini.';
    else pushDesc = 'Belum aktif. Ketuk tombol di bawah.';
    rows.push(['push', pushOn, 'Notifikasi saat halaman ditutup', pushDesc]);
    $('alertStates').innerHTML = rows.map(([, on, t, d]) =>
      '<div class="state ' + (on ? 'on' : 'off') + '">' + P.icon(on ? 'check' : 'x') + '<div><div class="t">' + t + '</div><div class="d">' + d + '</div></div></div>').join('');
    const done = st && (st.status === 'done' || st.status === 'skipped');
    $('alerts').classList.toggle('hidden', !!done);
    // Tombol disembunyikan bila tidak ada lagi yang bisa diaktifkan (push sudah aktif, tidak didukung, dimatikan, atau diblokir).
    const blocked = typeof Notification !== 'undefined' && Notification.permission === 'denied';
    $('enable').classList.toggle('hidden', alertsOn && (pushOn || !canPush() || !pushCfg.enabled || blocked));
    $('alertHint').textContent = alertsOn ? '' : 'Ponsel harus tidak dalam mode senyap agar suara terdengar.';
  }

  // ---------- Peringatan ----------
  // Getar berulang selama pengunjung belum menandai "sudah menuju meja" (maks. 90 detik). Hanya jalan di browser
  // yang mendukung Vibration API (Chrome/Firefox Android) dan saat halaman terbuka; iOS Safari tidak mendukungnya.
  const VIB_PATTERN = [400, 150, 400, 150, 800];
  const VIB_EVERY_MS = 3500;
  const VIB_MAX_MS = 90000;
  let vibTimer = null;
  function buzz() { try { navigator.vibrate && navigator.vibrate(VIB_PATTERN); } catch { /* tidak didukung */ } }
  function stopVibrate() {
    clearInterval(vibTimer);
    vibTimer = null;
    try { navigator.vibrate && navigator.vibrate(0); } catch { /* tidak didukung */ }
    $('ack').classList.add('hidden');
  }
  function startVibrate() {
    stopVibrate();
    if (!alertsOn || !navigator.vibrate) return;
    const until = Date.now() + VIB_MAX_MS;
    buzz();
    vibTimer = setInterval(() => { if (Date.now() > until) stopVibrate(); else buzz(); }, VIB_EVERY_MS);
    $('ack').classList.remove('hidden');
  }
  $('ack').addEventListener('click', () => { stopVibrate(); clearInterval(flashTimer); document.title = baseTitle; });

  function alertCalled() {
    if (alertsOn) {
      P.chime();
      startVibrate();
    }
    clearInterval(flashTimer);
    let on = false;
    flashTimer = setInterval(() => {
      on = !on;
      document.title = on ? '🔔 Giliran Anda!' : baseTitle;
    }, 900);
  }

  function alertNear() {
    if (!alertsOn) return;
    P.chime();
    try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch { /* tidak didukung */ }
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { clearInterval(flashTimer); document.title = baseTitle; load(); }
  });

  // Dipicu sentuhan pengguna: membuka kunci audio, lalu meminta izin dan mendaftar push bila bisa.
  $('enable').addEventListener('click', async () => {
    alertsOn = true;
    P.chime();
    try { navigator.vibrate && navigator.vibrate(80); } catch { /* tidak didukung */ }
    if (canPush() && pushCfg.enabled) {
      try {
        const perm = await Notification.requestPermission();
        if (perm === 'granted') await subscribePush();
      } catch (e) {
        P.toast('Notifikasi push gagal diaktifkan');
      }
    }
    renderAlertStates();
  });

  async function subscribePush() {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(pushCfg.publicKey) });
    }
    await P.api('/api/ticket/' + token + '/push', { method: 'POST', body: { subscription: sub.toJSON() } });
    pushOn = true;
  }

  // Pulihkan status push bila perangkat sudah pernah berlangganan.
  async function checkExistingPush() {
    if (!canPush() || !pushCfg.enabled || Notification.permission !== 'granted') return;
    try {
      const reg = await navigator.serviceWorker.getRegistration('/sw.js');
      const sub = reg && (await reg.pushManager.getSubscription());
      if (sub) {
        await P.api('/api/ticket/' + token + '/push', { method: 'POST', body: { subscription: sub.toJSON() } });
        pushOn = true;
      }
    } catch { /* biarkan belum aktif */ }
  }

  // ---------- Data ----------
  let inflight = false;
  async function load() {
    if (inflight) return;
    inflight = true;
    try {
      const s = await P.api('/api/ticket/' + token);
      $('live').classList.remove('off');
      prev = st;
      st = s;
      render();
      if (prev && prev.label !== st.label && st.prevLabel) alertNear(); // nomor berganti (dipindah kategori)
      else if (prev && prev.status === 'waiting' && st.status === 'serving') alertCalled();
      else if (prev && prev.status === 'serving' && st.status === 'serving' && st.calledAt !== prev.calledAt) alertCalled(); // dipanggil ulang
      else if (prev && prev.status === 'waiting' && st.status === 'waiting' && prev.ahead > st.nearAt && st.ahead <= st.nearAt) alertNear();
      if (st.status === 'done' || st.status === 'skipped') { clearInterval(flashTimer); document.title = baseTitle; stopVibrate(); }
    } catch (e) {
      if (e.status === 404) missing('Tiket tidak ditemukan', 'Pindai ulang kode QR pada slip antrian Anda.');
      else $('live').classList.add('off');
    } finally {
      inflight = false;
    }
  }

  if (!valid) {
    missing('Tautan tidak valid', 'Pindai ulang kode QR pada slip antrian Anda.');
    return;
  }

  P.api('/api/push/config').then((c) => { pushCfg = c; checkExistingPush().then(renderAlertStates); }).catch(() => {});
  load();
  P.connectWS((msg) => {
    if (msg.type === 'queue' || msg.type === 'call' || msg.type === 'hello' || msg.type === 'settings') load();
  });
  setInterval(load, 10000);
})();
