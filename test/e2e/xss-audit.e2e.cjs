// Tes e2e (Playwright). Dijalankan oleh test/e2e/run.mjs, yang menyiapkan server, fixture, dan variabel:
//   E2E_BASE (alamat server), E2E_FIXTURES (folder fixture), E2E_SHOTS (folder tangkapan layar), E2E_ROOT (akar repo).
const FX = process.env.E2E_FIXTURES;
const SHOTS = process.env.E2E_SHOTS;
const { chromium, request } = require('playwright');
const B = process.env.E2E_BASE;
const P = `"><img src=x onerror=window.__xss=1><svg onload=window.__xss=2>'<b id=injected>x</b>`;
let fails = 0; const found = [];
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

(async () => {
  const api = await request.newContext({ baseURL: B });
  const call = async (m, u, d) => { const r = await api[m](u, d ? { data: d } : {}); return { s: r.status(), b: await r.json().catch(() => null) }; };
  await call('post', '/api/auth/login', { username: 'admin', password: 'rahasia123' });

  // --- isi semua field teks bebas dengan payload
  ok((await call('put', '/api/admin/settings', { org_name: P })).s === 200, 'org_name berisi payload tersimpan (teks bebas diizinkan)');
  const cat = (await call('post', '/api/admin/categories', { name: P, prefix: 'P1' }));
  ok(cat.s === 201, 'nama kategori payload tersimpan');
  const cats = (await call('get', '/api/admin/categories')).b; const catId = cats.find((c) => c.prefix === 'P1').id;
  await call('post', '/api/admin/counters', { name: P, categoryId: catId });
  const ctrs = (await call('get', '/api/admin/counters')).b; const ctrId = ctrs.find((c) => c.name === P).id;
  await call('post', '/api/admin/screens', { name: P, slug: 'xss', categoryIds: [catId] });
  await call('post', '/api/admin/content', { type: 'text', title: P, body: P, duration: 30 });
  ok((await call('post', '/api/admin/users', { username: 'xss1', name: P, password: 'password1', counterIds: [ctrId] })).s === 201, 'nama pegawai payload tersimpan');

  // --- field yang divalidasi harus menolak payload
  ok((await call('post', '/api/admin/categories', { name: 'a', prefix: P })).s === 400, 'prefix payload ditolak');
  ok((await call('post', '/api/admin/screens', { name: 'a', slug: P })).s === 400, 'slug payload ditolak');
  ok((await call('post', '/api/admin/users', { username: P, name: 'a', password: 'password1' })).s === 400, 'username payload ditolak');
  ok((await call('put', '/api/admin/settings', { org_logo: P })).s === 400, 'org_logo payload ditolak');

  // --- tiket di kategori payload, dipanggil staf, lalu dipindah (banner "dipindahkan" di halaman pantau)
  const t = (await call('post', '/api/tickets', { categoryId: catId })).b;
  const t2 = (await call('post', '/api/tickets', { categoryId: catId })).b;
  const staff = await request.newContext({ baseURL: B });
  await staff.post('/api/auth/login', { data: { username: 'xss1', password: 'password1' } });
  await staff.post('/api/auth/counter', { data: { counterId: ctrId } });
  await staff.post(`/api/counter/${ctrId}/next`, { data: {} });

  const browser = await chromium.launch();
  const visit = async (label, url, opts = {}) => {
    const ctx = await browser.newContext({ viewport: opts.vp || { width: 1440, height: 900 } });
    await ctx.addInitScript(() => {
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' | ' + (e.sample || e.blockedURI)));
    });
    const page = await ctx.newPage();
    let dialogs = 0; page.on('dialog', (d) => { dialogs++; d.dismiss(); });
    page.on('pageerror', () => {});
    await page.goto(B + url);
    if (opts.setup) await opts.setup(page);
    await page.waitForTimeout(opts.wait || 1500);
    const r = await page.evaluate(() => ({
      xss: window.__xss || 0,
      injected: !!document.getElementById('injected') || !!document.querySelector('img[src="x"]') || !!document.querySelector('svg[onload]'),
      csp: window.__csp || [],
    }));
    const good = !r.xss && !r.injected && r.csp.length === 0 && dialogs === 0;
    ok(good, `${label}: tanpa eksekusi, tanpa elemen tersuntik, tanpa pelanggaran CSP` + (good ? '' : `  -> ${JSON.stringify({ ...r, dialogs })}`));
    if (!good) found.push(label);
    await ctx.close();
  };

  await visit('papan (layar payload)', '/?screen=xss');
  await visit('papan (semua kategori)', '/');
  await visit('kiosk', '/kiosk.html', { setup: async (p) => { await p.waitForSelector('.cat'); } });
  await visit('kiosk (slip nomor)', '/kiosk.html', { setup: async (p) => { await p.locator('.cat', { hasText: 'P1' }).first().click(); await p.waitForSelector('#overlay:not(.hidden)'); } });
  await visit('halaman pantau (dipanggil)', `/t.html?k=${t.token}`);
  await visit('halaman pantau (menunggu)', `/t.html?k=${t2.token}`);
  await staff.post(`/api/counter/${ctrId}/transfer`, { data: { toCategoryId: 1 } }); // t pindah ke kategori lain
  await staff.post('/api/auth/counter', { data: { counterId: null } }); // lepas meja agar bisa dipilih lewat UI
  await visit('halaman pantau (setelah dipindah)', `/t.html?k=${t.token}`);
  await visit('panel meja (pilih meja)', '/operator.html', { vp: { width: 390, height: 844 }, setup: async (p) => { await p.fill('#u', 'xss1'); await p.fill('#p', 'password1'); await p.click('#loginForm button'); await p.waitForSelector('#pickView:visible, #panelView:visible'); } });
  await visit('panel meja (panel, buat nomor, riwayat)', '/operator.html', { vp: { width: 390, height: 844 }, wait: 800, setup: async (p) => {
    await p.fill('#u', 'xss1'); await p.fill('#p', 'password1'); await p.click('#loginForm button');
    await p.waitForSelector('#pickView:visible, #panelView:visible');
    if (await p.isVisible('#pickView')) { await p.locator('#pickList button').first().click(); await p.waitForSelector('#panelView:visible'); }
    await p.click('#nav-new'); await p.click('#nav-hist'); await p.click('#nav-panel');
  } });
  const adminSetup = (pages, drawers) => async (p) => {
    await p.fill('#u', 'admin'); await p.fill('#p', 'rahasia123'); await p.click('#loginForm button');
    await p.waitForSelector('#shell:visible');
    for (const pg of pages) { await p.click(`[data-page=${pg}]`); await p.waitForTimeout(250); }
    if (drawers) {
      for (const [pg, sel] of drawers) { await p.click(`[data-page=${pg}]`); await p.waitForTimeout(250); await p.locator(sel).first().click(); await p.waitForTimeout(350); await p.keyboard.press('Escape'); }
    }
  };
  await visit('admin (semua halaman)', '/admin.html', { wait: 800, setup: adminSetup(['dashboard', 'content', 'screens', 'queue', 'users', 'report', 'settings']) });
  await visit('admin (laci ubah: konten, layar, kategori, meja, pegawai)', '/admin.html', { wait: 800, setup: adminSetup([], [
    ['content', '#contentRows [data-edit]'], ['screens', '#screenRows [data-edit]'], ['queue', '#queueRows [data-ckedit]'], ['users', '#userRows [data-uedit]'],
  ]) });
  await visit('admin (tab meja + sidebar)', '/admin.html', { wait: 800, setup: async (p) => {
    await adminSetup(['queue'])(p); await p.click('#queueTabs [data-tab=ctrs]'); await p.waitForTimeout(250);
    await p.locator('#queueRows [data-ctedit]').first().click(); await p.waitForTimeout(350);
  } });

  console.log('\nGagal:', fails, found.length ? '| titik bocor: ' + found.join(', ') : '');
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('XSS TEST GAGAL:', e.message.split('\n').slice(0, 6).join('\n')); process.exit(1); });
