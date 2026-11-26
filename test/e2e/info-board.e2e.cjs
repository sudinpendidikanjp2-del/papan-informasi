// Layar papan-informasi-saja (tanpa antrian), menjelajah dengan kursor, jeda dan lanjut otomatis, serta
// screensaver yang hilang saat pointer bergerak.
const fs = require('node:fs');
const SHOTS = process.env.E2E_SHOTS;
const FX = process.env.E2E_FIXTURES;
const { chromium, request } = require('playwright');
const B = process.env.E2E_BASE;
const errs = [];
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const watch = (p, tag) => {
  p.on('pageerror', (e) => errs.push(`[${tag}] pageerror: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error' && !/status of (400|401|404|409|403)|Failed to load resource/.test(m.text())) errs.push(`[${tag}] console: ${m.text().slice(0, 160)}`); });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = async (p, s) => ((await p.textContent(s)) || '').replace(/\s+/g, ' ').trim();
const title = (p) => p.evaluate(() => (document.querySelector('.slide-text h2') || {}).textContent || '');

(async () => {
  const api = await request.newContext({ baseURL: B });
  const call = async (m, u, d) => { const r = await api[m](u, d ? { data: d } : undefined); return { s: r.status(), b: await r.json().catch(() => null) }; };
  await call('post', '/api/auth/login', { username: 'admin', password: 'rahasia123' });
  const seed = (await call('get', '/api/admin/content')).b;
  if (seed.length) await call('post', '/api/admin/content/bulk', { ids: seed.map((c) => c.id), action: 'delete' });
  const mk = async (t) => (await call('post', '/api/admin/content', { type: 'text', title: t, body: 'Isi ' + t, duration: 6 })).b.id;
  await mk('Info Satu'); await mk('Info Dua'); await mk('Info Tiga');
  // Gambar screensaver
  const up = await api.post('/api/admin/upload', { data: fs.readFileSync(FX + '/promo.png'), headers: { 'x-filename': 'promo.png' } });
  await call('post', '/api/admin/content', { type: 'image', title: 'Saver', file: (await up.json()).file, duration: 8, screensaver: true });
  await call('put', '/api/admin/settings', { idle_minutes: '1' });
  await call('post', '/api/admin/screens', { name: 'Info', slug: 'info', showQueue: false, resumeSeconds: 5 });
  await call('post', '/api/admin/screens', { name: 'Antri', slug: 'antri' });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });

  // ---------- Layar tanpa antrian ----------
  const p = await ctx.newPage(); watch(p, 'info');
  const reqs = [];
  p.on('request', (r) => reqs.push(new URL(r.url()).pathname));
  await p.clock.install();
  await p.goto(B + '/layar/info');
  await p.waitForSelector('.slide-text h2');
  ok(await p.evaluate(() => document.getElementById('board').classList.contains('info-only')), 'layar info: mode papan-informasi-saja aktif');
  ok(await p.isHidden('.queue') && await p.isHidden('#nowPanel'), 'layar info: kolom antrian (hero, meja) tidak tampil');
  ok(await p.isHidden('#unlock'), 'layar info: tanpa overlay "Aktifkan" (tidak ada suara antrian)');
  await sleep(1200);
  ok(!reqs.includes('/api/state'), 'layar info: tidak memuat data antrian (/api/state)');
  ok(await p.evaluate(() => !document.querySelector('.browse.open')), 'layar info: daftar pilihan tersembunyi sebelum ada gerakan');
  await p.screenshot({ path: SHOTS + '/d-info-idle.png' });

  // Gerakan kecil (< 8 px) tidak dihitung
  await p.mouse.move(300, 300); await p.mouse.move(303, 302);
  await sleep(300);
  ok(await p.evaluate(() => !document.querySelector('.browse.open')), 'gerakan kecil (getaran) tidak memunculkan daftar');

  // Gerakan nyata: daftar muncul dan tayangan dijeda
  await p.mouse.move(500, 400); await p.mouse.move(520, 420);
  await p.waitForSelector('.browse.open');
  ok((await p.locator('#browseList .bi').count()) === 3, 'daftar di sisi kiri memuat semua informasi (3)');
  ok((await txt(p, '#cdText')) === 'Dijeda', 'penghitung berubah menjadi "Dijeda"');
  ok(await p.locator('#browseList .bi.on .n').textContent() === 'Info Satu', 'item yang tampil ditandai pada daftar');
  await p.waitForTimeout(450); // tunggu panel selesai meluncur
  await p.screenshot({ path: SHOTS + '/d-info-browse.png' });

  // Tetap bergerak lebih lama daripada durasi item (6 dtk): item tidak boleh berganti
  const before = await title(p);
  for (let i = 0; i < 9; i++) { await p.mouse.move(520 + (i % 2) * 30, 420 + (i % 2) * 30); await sleep(1000); }
  ok((await title(p)) === before && (await txt(p, '#cdText')) === 'Dijeda', `durasi tayang dimatikan selama dijelajahi (tetap "${before}" setelah 9 dtk)`);

  // Pilih item lain
  await p.locator('#browseList .bi', { hasText: 'Info Tiga' }).click();
  await p.waitForFunction(() => document.querySelector('.slide-text h2') && document.querySelector('.slide-text h2').textContent === 'Info Tiga');
  ok(await p.locator('#browseList .bi.on .n').textContent() === 'Info Tiga' && (await txt(p, '#cdText')) === 'Dijeda', 'klik judul melompat ke informasi itu, tetap dijeda');
  await p.waitForTimeout(450);
  await p.screenshot({ path: SHOTS + '/d-info-picked.png' });

  // Diam: setelah resumeSeconds (5 dtk) daftar menutup dan tayangan lanjut
  const t0 = Date.now();
  await p.waitForFunction(() => !document.querySelector('.browse.open'), null, { timeout: 12000 });
  const closedAfter = (Date.now() - t0) / 1000;
  ok(closedAfter >= 3 && closedAfter <= 9, `tanpa gerakan: daftar menutup setelah ±5 dtk (${closedAfter.toFixed(1)} dtk)`);
  ok(/^\d+ dtk$/.test(await txt(p, '#cdText')), 'tayangan dilanjutkan dengan hitung mundur normal: ' + await txt(p, '#cdText'));
  const secs = parseInt(await txt(p, '#cdText'), 10);
  ok(secs >= 5, `lanjut dengan durasi penuh (sisa ${secs} dari 6 dtk)`);
  await p.waitForFunction(() => document.querySelector('.slide-text h2') && document.querySelector('.slide-text h2').textContent !== 'Info Tiga', null, { timeout: 12000 });
  ok(true, 'setelah durasi habis tayangan berganti ke item berikutnya');

  // Screensaver: muncul saat diam > idle_minutes, hilang begitu kursor bergerak
  await p.clock.fastForward(90 * 1000);
  await p.waitForSelector('#saver:not(.hidden)', { timeout: 12000 });
  ok(true, 'layar info: screensaver muncul setelah diam melewati batas idle');
  await p.screenshot({ path: SHOTS + '/d-saver.png' });
  await p.mouse.move(700, 500); await p.mouse.move(760, 540);
  await p.waitForSelector('#saver.hidden', { state: 'attached', timeout: 3000 });
  ok(await p.locator('.browse.open').count() === 1, 'screensaver hilang saat kursor digerakkan dan daftar pilihan muncul');
  await sleep(1500);
  ok(await p.isHidden('#saver'), 'screensaver tidak langsung muncul lagi setelah ada gerakan');
  await p.close();

  // ---------- Layar dengan antrian: screensaver tetap hilang saat pointer bergerak, daftar tidak ada ----------
  const q = await ctx.newPage(); watch(q, 'antri');
  await q.clock.install();
  await q.goto(B + '/layar/antri?sound=on');
  await q.waitForSelector('.slide-text h2');
  ok(!(await q.evaluate(() => document.getElementById('board').classList.contains('info-only'))) && await q.isVisible('.queue'), 'layar antri: tetap menampilkan kolom antrian');
  await q.clock.fastForward(90 * 1000);
  await q.waitForSelector('#saver:not(.hidden)', { timeout: 12000 });
  ok(true, 'layar antri: screensaver muncul setelah diam');
  await q.mouse.move(400, 300); await q.mouse.move(480, 360);
  await q.waitForSelector('#saver.hidden', { state: 'attached', timeout: 3000 });
  ok(await q.evaluate(() => !document.querySelector('.browse.open')) && await q.isHidden('.browse'), 'layar antri: screensaver hilang saat pointer bergerak; tanpa daftar pilihan');
  // Tombol keyboard juga menutup screensaver
  await q.clock.fastForward(90 * 1000);
  await q.waitForSelector('#saver:not(.hidden)', { timeout: 12000 });
  await q.keyboard.press('Shift');
  await q.waitForSelector('#saver.hidden', { state: 'attached', timeout: 3000 });
  ok(true, 'layar antri: tombol keyboard juga menutup screensaver');
  await q.close();

  // ---------- Admin: sakelar mode layar ----------
  const a = await ctx.newPage(); watch(a, 'admin');
  await a.goto(B + '/admin#screens');
  await a.waitForSelector('#loginForm:visible');
  await a.fill('#u', 'admin'); await a.fill('#p', 'rahasia123'); await a.click('#loginForm button');
  await a.waitForSelector('#shell:visible');
  await a.waitForSelector('#screenRows tr');
  ok((await txt(a, '#screenRows')).includes('Hanya informasi') && (await txt(a, '#screenRows')).includes('Antrian + informasi'), 'admin: tabel layar menandai mode tiap layar');
  await a.locator('#screenRows tr', { hasText: 'Antri' }).locator('[data-edit]').click();
  await a.waitForSelector('#screenForm:visible');
  ok(await a.isVisible('#screenCatsField') && await a.isHidden('#resumeField'), 'admin: mode antrian menampilkan kategori, menyembunyikan jeda lanjut');
  await a.uncheck('#showQueue');
  ok(await a.isHidden('#screenCatsField') && await a.isVisible('#resumeField'), 'admin: mematikan antrian menukar isian kategori dengan "lanjut otomatis"');
  await a.fill('#screenForm [name=resumeSeconds]', '12');
  await a.screenshot({ path: SHOTS + '/d-admin-screen.png' });
  await a.click('#screenForm button[type=submit]');
  await a.waitForFunction(() => document.getElementById('screenRows').textContent.split('Hanya informasi').length === 3, null, { timeout: 5000 });
  const cfg = (await call('get', '/api/screen/antri')).b;
  ok(cfg.showQueue === false && cfg.resumeSeconds === 12, 'admin: perubahan mode tersimpan di server (' + JSON.stringify({ q: cfg.showQueue, r: cfg.resumeSeconds }) + ')');

  await browser.close();
  ok(errs.length === 0, 'tanpa error konsol atau pelanggaran CSP' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  console.log(`\nGagal: ${fails}`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('E2E GAGAL:', e.message); process.exit(1); });
