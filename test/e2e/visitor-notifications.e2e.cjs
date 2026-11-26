// Tes e2e (Playwright). Dijalankan oleh test/e2e/run.mjs, yang menyiapkan server, fixture, dan variabel:
//   E2E_BASE (alamat server), E2E_FIXTURES (folder fixture), E2E_SHOTS (folder tangkapan layar), E2E_ROOT (akar repo).
const FX = process.env.E2E_FIXTURES;
const SHOTS = process.env.E2E_SHOTS;
const { chromium, request } = require('playwright');
const qrcode = require(process.env.E2E_ROOT + '/node_modules/qrcode-generator');
const B = process.env.E2E_BASE;
const errs = [];
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const watch = (p, tag) => {
  p.on('pageerror', (e) => errs.push(`[${tag}] pageerror: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error' && !/status of (400|401|404|409|403)/.test(m.text())) errs.push(`[${tag}] console: ${m.text()}`); });
};
const txt = async (p, s) => (await p.textContent(s)).replace(/\s+/g, ' ').trim();

(async () => {
  const api = await request.newContext({ baseURL: B });
  const j = async (r) => ({ status: r.status(), body: await r.json().catch(() => null) });
  const post = (u, d) => api.post(u, { data: d }).then(j);
  await post('/api/auth/login', { username: 'admin', password: 'rahasia123' });
  await post('/api/admin/users', { username: 'budi', name: 'Budi', password: 'password1', counterIds: [1] });
  await post('/api/auth/counter', { counterId: 1 }); // admin memegang Meja 1 (untuk memanggil)

  // pengaturan: alamat dasar, ambang 3
  const set = await api.put('/api/admin/settings', { data: { public_base_url: 'http://192.168.1.10:3000', notify_ahead: '3' } });
  ok(set.status() === 200, 'admin API: alamat dasar tersimpan');
  const bad = await api.put('/api/admin/settings', { data: { org_name: 'JANGAN SIMPAN', public_base_url: 'javascript:alert(1)' } });
  ok(bad.status() === 400, 'admin API: alamat dasar berbahaya ditolak');
  ok(!(await (await api.get('/api/settings')).text()).includes('vapid'), 'GET /api/settings publik tidak memuat kunci VAPID');

  // 5 tiket
  const t = [];
  for (let i = 0; i < 5; i++) t.push((await post('/api/tickets', { categoryId: 1 })).body);
  ok(t.every((x) => /^[a-f0-9]{24}$/.test(x.token)), 'tiket punya token');

  // QR: isinya persis URL pantau dengan alamat dasar dari admin
  const svg = await (await api.get(`/api/ticket/${t[2].token}/qr.svg`)).text();
  const q = qrcode(0, 'M'); q.addData(`http://192.168.1.10:3000/antrian/${t[2].token}`); q.make();
  ok(svg === q.createSvgTag({ cellSize: 8, margin: 2, scalable: true }), 'QR memuat tepat URL pantau (alamat dasar dari admin)');
  ok((await api.get('/api/ticket/' + '0'.repeat(24) + '/qr.svg')).status() === 404, 'QR untuk tiket tak dikenal = 404');
  const sw = await api.get('/sw.js');
  ok(sw.status() === 200 && /javascript/.test(sw.headers()['content-type']), 'sw.js disajikan sebagai JavaScript');
  ok((await api.get('/antrian/abc123def456')).headers()['referrer-policy'] === 'no-referrer', 'halaman pantau mengirim Referrer-Policy: no-referrer');

  const browser = await chromium.launch();

  // ===== Kiosk: slip memuat QR =====
  const kctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const k = await kctx.newPage(); watch(k, 'kiosk');
  await k.goto(B + '/kiosk'); await k.waitForSelector('.cat');
  await k.locator('.cat', { hasText: 'Administrasi' }).click();
  await k.waitForSelector('#overlay:not(.hidden)');
  await k.waitForFunction(() => document.getElementById('qr').complete && document.getElementById('qr').naturalWidth > 0);
  ok(await k.isVisible('#track') && (await k.getAttribute('#qr', 'src')).includes('/qr.svg'), 'kiosk: slip menampilkan kode QR yang termuat');
  await k.screenshot({ path: SHOTS + '/e4-kiosk-qr.png' });

  // ===== Ponsel pengunjung: tiket ke-3 di kategori A (ahead 2) =====
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await pctx.addInitScript(() => {
    window.__vib = []; window.__osc = 0;
    navigator.vibrate = (p) => { window.__vib.push(JSON.stringify(p)); return true; };
    const AC = window.AudioContext || window.webkitAudioContext;
    const orig = AC.prototype.createOscillator;
    AC.prototype.createOscillator = function () { window.__osc++; return orig.call(this); };
  });
  const ph = await pctx.newPage(); watch(ph, 'ponsel');
  await ph.goto(`${B}/antrian/${t[2].token}`);
  await ph.waitForSelector('#ticket:visible');
  ok((await txt(ph, '#label')) === 'A-003' && (await txt(ph, '#ahead')) === '2', 'ponsel: nomor A-003 dengan 2 orang di depan');
  ok(await ph.isVisible('#nearBanner'), 'ponsel: banner "hampir giliran" tampil (2 <= ambang 3)');
  ok((await txt(ph, '#alertStates')).includes('Belum aktif'), 'ponsel: peringatan belum aktif sebelum disentuh');
  await ph.screenshot({ path: SHOTS + '/e4-phone-waiting.png' });

  await ph.click('#enable');
  await ph.waitForFunction(() => document.getElementById('alertStates').textContent.includes('Aktif. Berbunyi'));
  ok(true, 'ponsel: peringatan suara dan getar aktif setelah sentuhan');
  ok(await ph.evaluate(() => window.__osc >= 2), 'ponsel: bel diuji saat mengaktifkan (oscillator dibuat)');
  const vibBefore = await ph.evaluate(() => window.__vib.length);

  // Operator memanggil A-001 (ahead tiket3: 2 -> 1), lalu A-002, lalu A-003
  const call = async () => (await post('/api/counter/1/next', {}));
  const fin = async () => (await post('/api/counter/1/done', {}));
  ok((await call()).body.label === 'A-001', 'operator memanggil A-001');
  await ph.waitForFunction(() => document.getElementById('ahead').textContent === '1');
  ok(true, 'ponsel: jumlah di depan turun ke 1 secara realtime (tanpa muat ulang)');
  await fin(); await call(); await fin();
  await ph.waitForFunction(() => document.getElementById('eta').textContent === 'Berikutnya' && document.getElementById('ahead').textContent === '0');
  ok(true, 'ponsel: giliran berikutnya ditampilkan "Berikutnya"');

  const oscBefore = await ph.evaluate(() => window.__osc);
  ok((await call()).body.label === 'A-003', 'operator memanggil A-003 (tiket pengunjung)');
  await ph.waitForFunction(() => document.getElementById('hero').classList.contains('called'));
  ok((await txt(ph, '#callBox')).includes('Silakan menuju Meja 1'), 'ponsel: "Silakan menuju Meja 1"');
  ok(await ph.evaluate((n) => window.__osc > n, oscBefore), 'ponsel: bel berbunyi saat dipanggil');
  ok(await ph.evaluate((n) => window.__vib.length > n && window.__vib.some((v) => v.includes('800')), vibBefore), 'ponsel: perangkat bergetar dengan pola panjang saat dipanggil');
  await ph.waitForFunction(() => document.title.includes('Giliran Anda'), null, { timeout: 4000 });
  ok(true, 'ponsel: judul tab berkedip "Giliran Anda!"');
  await ph.screenshot({ path: SHOTS + '/e4-phone-called.png' });

  // Getar berulang selama belum ditandai "sudah menuju meja"
  const pat = () => ph.evaluate(() => window.__vib.filter((v) => v.startsWith('[400')).length);
  ok(await ph.isVisible('#ack'), 'ponsel: tombol "Saya sudah menuju meja" tampil saat dipanggil');
  const p1 = await pat();
  await ph.waitForTimeout(8000);
  const p2 = await pat();
  ok(p2 - p1 >= 2, `ponsel: getar berulang selama belum ditandai (${p1} -> ${p2} dalam 8 dtk)`);
  await ph.click('#ack');
  await ph.waitForTimeout(500);
  const p3 = await pat();
  await ph.waitForTimeout(5000);
  ok((await pat()) === p3 && await ph.isHidden('#ack'), 'ponsel: getar berhenti setelah diketuk "sudah menuju meja"');

  // Panggil ulang -> bunyi lagi
  const osc2 = await ph.evaluate(() => window.__osc);
  await post('/api/counter/1/recall', {}); // calledAt berubah
  await ph.waitForFunction((n) => window.__osc > n, osc2, { timeout: 5000 });
  ok(true, 'ponsel: panggil ulang membunyikan peringatan lagi');
  await ph.waitForFunction((n) => window.__vib.filter((v) => v.startsWith('[400')).length > n, p3, { timeout: 5000 });
  ok(await ph.isVisible('#ack'), 'ponsel: panggil ulang memulai getar berulang lagi');

  // Selesai
  await fin();
  await ph.waitForFunction(() => document.getElementById('hero').classList.contains('finished'));
  ok((await txt(ph, '#finishBox')).includes('Terima kasih') && await ph.isHidden('#alerts'), 'ponsel: pesan terima kasih, kartu peringatan disembunyikan');
  await ph.screenshot({ path: SHOTS + '/e4-phone-done.png' });

  // Dilewati: tiket A-004 lalu Skip
  const ph4 = await pctx.newPage(); watch(ph4, 'ponsel2');
  await ph4.goto(`${B}/antrian/${t[3].token}`); await ph4.waitForSelector('#ticket:visible');
  await call(); await post('/api/counter/1/skip', {});
  await ph4.waitForFunction(() => document.getElementById('hero').classList.contains('finished'));
  ok((await txt(ph4, '#finishBox')).includes('dilewati'), 'ponsel: tiket dilewati mendapat arahan mengambil nomor baru');

  // Tautan tidak valid / tidak dikenal / kedaluwarsa
  const bad1 = await pctx.newPage(); watch(bad1, 'bad1');
  await bad1.goto(B + '/antrian/bukan-token');
  ok((await txt(bad1, '#missTitle')) === 'Tautan tidak valid', 'ponsel: tautan tidak valid ditolak tanpa memanggil server');
  const bad2 = await pctx.newPage(); watch(bad2, 'bad2');
  await bad2.goto(B + '/antrian/' + 'a'.repeat(24));
  await bad2.waitForFunction(() => document.getElementById('missTitle').textContent.includes('tidak ditemukan'));
  ok(true, 'ponsel: token tidak dikenal menampilkan "tidak ditemukan"');

  // Prioritas: tiket prioritas melompati, ponsel lain melihat "ahead" bertambah/berkurang benar
  await api.put('/api/admin/settings', { data: { priority_enabled: '1' } });
  const pr = (await post('/api/tickets', { categoryId: 1, priority: true })).body;
  const prSt = (await api.get('/api/ticket/' + pr.token).then(j)).body;
  ok(prSt.priority === true && prSt.ahead === 0, 'API: tiket prioritas langsung berada di depan (ahead 0)');
  const t5 = (await api.get('/api/ticket/' + t[4].token).then(j)).body;
  ok(t5.ahead === 1, 'API: tiket biasa terdorong mundur oleh tiket prioritas (ahead 1)');

  // ===== Admin: pengaturan notifikasi =====
  const actx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const a = await actx.newPage(); watch(a, 'admin');
  await a.goto(B + '/admin#settings');
  await a.fill('#u', 'admin'); await a.fill('#p', 'rahasia123'); await a.click('#loginForm button');
  await a.waitForSelector('#page-settings.on');
  await a.fill('#settingsForm [name=public_base_url]', '');
  await a.waitForTimeout(200);
  ok((await txt(a, '#baseHint')).includes('tidak bisa dibuka dari ponsel'), 'admin: peringatan bila alamat QR mengarah ke localhost');
  await a.fill('#settingsForm [name=public_base_url]', 'https://antrian.contoh.go.id');
  await a.waitForTimeout(200);
  ok((await txt(a, '#pushHint')).includes('walau halaman ditutup') && !(await txt(a, '#baseHint')).includes('tidak bisa dibuka'), 'admin: alamat HTTPS dijelaskan mendukung push');
  await a.fill('#settingsForm [name=public_base_url]', 'ngawur');
  await a.click('#settingsForm button[type=submit]');
  await a.waitForSelector('.toast');
  ok((await txt(a, '.toast')).includes('URL'), 'admin: alamat tidak valid ditolak dengan pesan jelas');
  await a.fill('#settingsForm [name=public_base_url]', 'http://192.168.1.10:3000');
  await a.fill('#settingsForm [name=notify_ahead]', '5');
  await a.click('#settingsForm button[type=submit]');
  await a.waitForFunction(() => [...document.querySelectorAll('.toast')].some((e) => e.textContent.includes('disimpan')));
  ok((await (await api.get('/api/settings')).json()).notify_ahead === '5', 'admin: ambang notifikasi tersimpan');
  await a.screenshot({ path: SHOTS + '/e4-admin-settings.png', fullPage: true });

  console.log('\nGagal:', fails, '| Error konsol/halaman:', errs.length ? '\n' + errs.join('\n') : 'tidak ada');
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('E2E GAGAL:', e.message.split('\n').slice(0, 8).join('\n')); process.exit(1); });
