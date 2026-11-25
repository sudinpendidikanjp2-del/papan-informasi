// PDF per halaman (pdf.js) dan cadangan iframe saat pustaka gagal dimuat.
const { chromium, request } = require('playwright');
const fs = require('fs');
const B = process.env.E2E_BASE;
const FX = process.env.E2E_FIXTURES;
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

(async () => {
  const api = await request.newContext({ baseURL: B });
  await api.post('/api/auth/login', { data: { username: 'admin', password: 'rahasia123' } });
  const up = await api.post('/api/admin/upload', { data: fs.readFileSync(FX + '/tiga-halaman.pdf'), headers: { 'x-filename': 'tiga-halaman.pdf' } });
  const file = (await up.json()).file;
  await api.post('/api/admin/content', { data: { type: 'pdf', title: 'Info Layanan', file, duration: 4, sort: -5 } });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(B + '/', { waitUntil: 'networkidle' });
  await p.click('#unlockBtn');
  await p.waitForSelector('#slide canvas', { timeout: 15000 });
  // Cek canvas segera: setelah tiga halaman PDF selesai tayang dan item berikutnya menggantikannya.
  ok(await p.evaluate(() => document.querySelector('#slide canvas').width > 100), 'halaman PDF benar-benar dirender ke canvas');
  const pills = [];
  for (let i = 0; i < 3; i++) { pills.push((await p.textContent('#cdText')).trim()); await p.waitForTimeout(4100); }
  ok(/Hal 1\/3/.test(pills[0]) && /Hal 2\/3/.test(pills[1]) && /Hal 3\/3/.test(pills[2]), 'PDF tampil per halaman dengan hitung mundur per halaman: ' + pills.join(' | '));
  ok(errs.length === 0, 'tanpa error konsol atau pelanggaran CSP' + (errs.length ? ': ' + errs.join(' | ') : ''));

  // pdf.js gagal dimuat -> cadangan iframe
  const ctx2 = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await ctx2.route('**/vendor/pdfjs/**', (r) => r.abort());
  const q = await ctx2.newPage();
  await q.goto(B + '/', { waitUntil: 'load' });
  await q.click('#unlockBtn');
  await q.waitForSelector('#slide iframe', { timeout: 15000 });
  const t = (await q.textContent('#cdText')).trim();
  ok(/^\d+ dtk$/.test(t), 'cadangan iframe memakai hitung mundur tunggal tanpa "Hal": ' + t);

  console.log('\nGagal:', fails);
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('GAGAL:', e.message.split('\n')[0]); process.exit(1); });
