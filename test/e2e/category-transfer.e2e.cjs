// Tes e2e (Playwright). Dijalankan oleh test/e2e/run.mjs, yang menyiapkan server, fixture, dan variabel:
//   E2E_BASE (alamat server), E2E_FIXTURES (folder fixture), E2E_SHOTS (folder tangkapan layar), E2E_ROOT (akar repo).
const FX = process.env.E2E_FIXTURES;
const SHOTS = process.env.E2E_SHOTS;
const { chromium, request } = require('playwright');
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
  const post = async (u, d) => { const r = await api.post(u, { data: d }); return { status: r.status(), body: await r.json().catch(() => null) }; };
  await post('/api/auth/login', { username: 'admin', password: 'rahasia123' });
  await post('/api/admin/users', { username: 'budi', name: 'Budi', password: 'password1', counterIds: [1] });
  await post('/api/admin/users', { username: 'sari', name: 'Sari', password: 'password2', counterIds: [3] });
  const tA = [(await post('/api/tickets', { categoryId: 1 })).body, (await post('/api/tickets', { categoryId: 1 })).body];
  const tB = (await post('/api/tickets', { categoryId: 2 })).body;
  ok(tA[0].label === 'A-001' && tB.label === 'B-001', 'siap: A-001, A-002, B-001');

  const browser = await chromium.launch();
  const login = async (user, pass, counter, vp = { width: 390, height: 844 }) => {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2 });
    const p = await ctx.newPage(); watch(p, user);
    await p.goto(B + '/operator');
    await p.fill('#u', user); await p.fill('#p', pass); await p.click('#loginForm button');
    await p.waitForSelector('#pickView:visible');
    await p.locator('#pickList button', { hasText: counter }).click();
    await p.waitForSelector('#panelView:visible');
    return p;
  };

  // Ponsel pengunjung tiket A-001, peringatan diaktifkan
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await pctx.addInitScript(() => {
    window.__vib = []; navigator.vibrate = (p) => { window.__vib.push(JSON.stringify(p)); return true; };
  });
  const ph = await pctx.newPage(); watch(ph, 'ponsel');
  await ph.goto(`${B}/antrian/${tA[0].token}`); await ph.waitForSelector('#ticket:visible');
  await ph.click('#enable');
  await ph.waitForFunction(() => document.getElementById('alertStates').textContent.includes('Aktif. Berbunyi'));
  ok((await txt(ph, '#label')) === 'A-001' && await ph.isHidden('#movedBanner'), 'ponsel: A-001 tanpa banner pindah');

  // Budi memanggil A-001 lalu memindahkan ke kategori Administrasi lewat UI
  const budi = await login('budi', 'password1', 'Meja 1');
  await budi.click('#next');
  await budi.waitForFunction(() => document.getElementById('cur').textContent === 'A-001');
  ok(await budi.isVisible('#xferCard'), 'operator: kartu pindah tampil');
  ok(await budi.isVisible('#xferCounter') && await budi.isHidden('#xferCategory'), 'operator: mode awal "Ke meja lain"');
  await budi.click('#xferMode [data-m=category]');
  ok(await budi.isVisible('#xferCategory') && await budi.isHidden('#xferCounter'), 'operator: tab "Ke kategori lain" menampilkan pilihan kategori');
  const opts = await budi.locator('#xferCat option').allTextContents();
  ok(opts.some((o) => o.includes('Administrasi') && o.includes('1 menunggu')) && opts.some((o) => o.includes('kembalikan ke antrian')), 'operator: opsi kategori memuat jumlah menunggu dan "kembalikan ke antrian" untuk kategori sendiri');
  await budi.selectOption('#xferCat', { label: opts.find((o) => o.startsWith('Administrasi')) });
  ok((await txt(budi, '#xferCatHint')).includes('Nomor baru diterbitkan di kategori Administrasi') && (await txt(budi, '#xferCatHint')).includes('Waktu tunggu awal tetap dihitung'), 'operator: petunjuk menjelaskan nomor baru dan waktu tunggu');
  await budi.screenshot({ path: SHOTS + '/e5-op-xfer.png' });
  await budi.click('#xferCatBtn');
  await budi.waitForFunction(() => document.getElementById('cur').textContent.trim() === '—');
  await budi.waitForFunction(() => [...document.querySelectorAll('.toast')].some((e) => e.textContent.includes('A-001 dipindahkan: kini B-002')));
  ok(true, 'operator: toast menyebut nomor lama dan baru (B-002)');

  // Ponsel: nomor berganti, banner tampil, perangkat bergetar, tetap menunggu
  await ph.waitForFunction(() => document.getElementById('label').textContent === 'B-002');
  ok(await ph.isVisible('#movedBanner') && (await txt(ph, '#movedText')).includes('A-001') && (await txt(ph, '#movedText')).includes('B-002'), 'ponsel: banner "dipindahkan dari A-001 ke B-002"');
  ok((await txt(ph, '#cat')) === 'Administrasi', 'ponsel: kategori kini Administrasi');
  ok(await ph.evaluate(() => window.__vib.some((v) => v === '[200,100,200]')), 'ponsel: bergetar saat nomor berganti');
  await ph.screenshot({ path: SHOTS + '/e5-phone-moved.png' });
  const st = await (await api.get('/api/ticket/' + tA[0].token)).json();
  ok(st.status === 'waiting' && st.ahead === 0, 'API: tiket pindahan menunggu di B dan paling depan (datang lebih awal dari B-001)');

  // Sari (Meja 3, kategori B) memanggil: tiket pindahan lebih dulu daripada B-001
  const sari = await login('sari', 'password2', 'Meja 3');
  ok((await txt(sari, '#waiting')) === '2', 'operator Sari: 2 menunggu di kategori B (B-001 dan pindahan)');
  await sari.click('#next');
  await sari.waitForFunction(() => document.getElementById('cur').textContent === 'B-002');
  ok(true, 'operator Sari: memanggil B-002 (pindahan, datang lebih awal) lebih dulu');
  await ph.waitForFunction(() => document.getElementById('hero').classList.contains('called'));
  ok((await txt(ph, '#callBox')).includes('Meja 3') && await ph.isHidden('#movedBanner'), 'ponsel: "Silakan menuju Meja 3", banner pindah hilang');
  await sari.click('#start'); await sari.click('#done');

  // Kembalikan ke antrian kategori sendiri (kategori sama): nomor tetap
  await budi.click('#next');
  await budi.waitForFunction(() => document.getElementById('cur').textContent === 'A-002');
  await budi.click('#xferMode [data-m=category]');
  const same = (await budi.locator('#xferCat option').allTextContents()).find((o) => o.includes('kembalikan ke antrian'));
  await budi.selectOption('#xferCat', { label: same });
  ok((await txt(budi, '#xferCatHint')).includes('Nomor tetap A-002'), 'operator: petunjuk "Nomor tetap A-002" untuk kategori sama');
  await budi.locator('#xferPrio').evaluate((e) => e.click());
  await budi.click('#xferCatBtn');
  await budi.waitForFunction(() => document.getElementById('cur').textContent.trim() === '—');
  await budi.waitForFunction(() => [...document.querySelectorAll('.toast')].some((e) => e.textContent.includes('A-002 dikembalikan ke antrian')));
  ok(true, 'operator: toast "dikembalikan ke antrian"');
  const s2 = await (await api.get('/api/ticket/' + tA[1].token)).json();
  ok(s2.label === 'A-002' && s2.status === 'waiting' && s2.priority === true && s2.prevLabel === null, 'API: A-002 kembali menunggu, nomor sama, kini prioritas');

  // Pindah ke meja lain tetap bekerja lewat UI
  await budi.click('#next');
  await budi.waitForFunction(() => document.getElementById('cur').textContent === 'A-002');
  await budi.click('#xferMode [data-m=counter]');
  ok(await budi.isVisible('#xferCounter') && await budi.isHidden('#xferCategory'), 'operator: tab "Ke meja lain" dapat dipilih kembali');
  await budi.screenshot({ path: SHOTS + '/e5-op-xfer-counter.png' });

  console.log('\nGagal:', fails, '| Error konsol/halaman:', errs.length ? '\n' + errs.join('\n') : 'tidak ada');
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('E2E GAGAL:', e.message.split('\n').slice(0, 8).join('\n')); process.exit(1); });
