// Tampilan mobile dan tablet: tanpa luapan horizontal, target sentuh, ukuran font kolom, tata letak papan satu kolom,
// lembar bawah pada layar tanpa antrian, tabel admin menjadi kartu, laci penuh layar, dan halaman lain di layar sempit.
const SHOTS = process.env.E2E_SHOTS;
const { chromium, request, devices } = require('playwright');
const B = process.env.E2E_BASE;
const errs = [];
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const watch = (p, tag) => {
  p.on('pageerror', (e) => errs.push(`[${tag}] pageerror: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error' && !/status of (400|401|404|409|403)|Failed to load resource/.test(m.text())) errs.push(`[${tag}] console: ${m.text().slice(0, 140)}`); });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dev = (name, extra = {}) => { const { defaultBrowserType, ...d } = devices[name]; return { ...d, ...extra }; };

// Pemeriksaan umum di dalam halaman: elemen yang melewati tepi layar dan target sentuh yang terlalu kecil.
const AUDIT = () => {
  const vw = document.documentElement.clientWidth;
  const skip = '.hidden, .drawer:not(.open), .browse:not(.open), .scrim, .drawer-scrim, #unlock, #saver, .toast, #overlay';
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !el.closest(skip);
  };
  const scrolledAncestor = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (/(auto|scroll)/.test(o) && p.scrollWidth > p.clientWidth) return true;
    }
    return false;
  };
  const over = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if ((r.right > vw + 1 || r.left < -1) && !scrolledAncestor(el)) {
      if (el.closest('.sidebar') && !el.closest('.shell.open')) continue;
      over.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0]) + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
      if (over.length > 4) break;
    }
  }
  const small = [];
  const coarse = matchMedia('(pointer: coarse)').matches;
  if (coarse) {
    for (const el of document.querySelectorAll('button, select, .btn, [role=button], input[type=checkbox]')) {
      if (!visible(el) || el.closest('.sidebar') && !el.closest('.shell.open')) continue;
      const r = el.getBoundingClientRect();
      const hit = el.matches('input[type=checkbox]') ? Math.max(r.width, (el.closest('label, td') || el).getBoundingClientRect().height) : Math.min(r.width, r.height);
      if (el.matches('input[type=checkbox]') ? r.width < 20 : r.height < 40) small.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0]) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + (hit ? '' : ''));
      if (small.length > 5) break;
    }
  }
  const tinyInputs = [];
  if (vw <= 720) {
    for (const el of document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]), select, textarea')) {
      if (visible(el) && parseFloat(getComputedStyle(el).fontSize) < 16) tinyInputs.push(el.name || el.id);
    }
  }
  return { vw, scrollWidth: document.documentElement.scrollWidth, over, small, tinyInputs };
};
const clean = async (p, tag) => {
  const a = await p.evaluate(AUDIT);
  ok(a.scrollWidth <= a.vw + 1, `${tag}: tanpa gulir horizontal (lebar ${a.scrollWidth} <= ${a.vw})`);
  ok(a.over.length === 0, `${tag}: tidak ada elemen melewati tepi layar` + (a.over.length ? ' -> ' + a.over.join('; ') : ''));
  ok(a.small.length === 0, `${tag}: target sentuh >= 40 px` + (a.small.length ? ' -> ' + a.small.join('; ') : ''));
  ok(a.tinyInputs.length === 0, `${tag}: kolom isian berfont >= 16 px` + (a.tinyInputs.length ? ' -> ' + a.tinyInputs.join(', ') : ''));
};

(async () => {
  const api = await request.newContext({ baseURL: B });
  const call = async (m, u, d) => { const r = await api[m](u, d ? { data: d } : undefined); return { s: r.status(), b: await r.json().catch(() => null) }; };
  await call('post', '/api/auth/login', { username: 'admin', password: 'rahasia123' });
  const seed = (await call('get', '/api/admin/content')).b;
  if (seed.length) await call('post', '/api/admin/content/bulk', { ids: seed.map((c) => c.id), action: 'delete' });
  const mk = (t, body) => call('post', '/api/admin/content', { type: 'text', title: t, body: body || 'Isi ' + t, duration: 600 });
  await mk('Selamat Datang', '# Layanan\n\nJam layanan **08.00-15.00**\n\n- Loket 1 umum\n- Loket 2 khusus\n- Loket 3 informasi');
  await mk('Persyaratan', 'Bawa KTP asli dan fotokopi.');
  await mk('Pengumuman', 'Libur nasional: layanan tutup.');
  await call('post', '/api/admin/users', { username: 'budi', name: 'Budi Santoso', password: 'password1', counterIds: [1, 2, 3] });
  await call('post', '/api/admin/screens', { name: 'Info', slug: 'info', showQueue: false, resumeSeconds: 5 });
  await call('post', '/api/admin/screens', { name: 'Lobi', slug: 'lobi' });
  for (let i = 0; i < 4; i++) await call('post', '/api/tickets', { categoryId: 1 });
  const t = await call('post', '/api/tickets', { categoryId: 1, priority: false });
  const token = t.b.token;
  await call('post', '/api/counter/1/next');

  const browser = await chromium.launch();

  // ---------- Papan dengan antrian: ponsel potret ----------
  for (const [name, label] of [['iPhone 13', 'iPhone 13'], ['Pixel 7', 'Pixel 7'], ['iPhone SE', 'iPhone SE']]) {
    const ctx = await browser.newContext(dev(name));
    const p = await ctx.newPage(); watch(p, 'papan-' + label);
    await p.goto(B + '/layar/lobi?sound=on');
    await p.waitForSelector('.slide-text h2');
    await p.waitForSelector('#counters .ctr');
    await p.waitForTimeout(600);
    const g = await p.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      const cs = getComputedStyle(document.body);
      return {
        hero: r('#nowPanel').top, stage: r('.stage').top, desks: r('.desks').top, slideH: r('#slide').height, vw: innerWidth, vh: innerHeight,
        docH: document.documentElement.scrollHeight, overflow: cs.overflow + '/' + getComputedStyle(document.documentElement).overflow,
        ctr: [...document.querySelectorAll('#counters .ctr')].map((e) => e.getBoundingClientRect().width),
        panelW: r('.desks').width, cols: getComputedStyle(document.getElementById('counters')).gridTemplateColumns.split(' ').length,
        heroInView: r('#nowPanel').bottom <= innerHeight,
      };
    });
    ok(g.hero < g.stage && g.stage < g.desks, `${label}: urutan hero -> konten -> meja (${Math.round(g.hero)}, ${Math.round(g.stage)}, ${Math.round(g.desks)})`);
    ok(g.heroInView || g.hero < g.vh / 2, `${label}: kartu panggilan terlihat tanpa menggulir jauh`);
    ok(g.docH > g.vh, `${label}: halaman dapat digulir (${g.docH} > ${g.vh})`);
    ok(!/hidden/.test(g.overflow), `${label}: tidak mengunci gulir (${g.overflow})`);
    ok(g.cols === 1 && g.ctr.every((w) => w >= g.panelW * 0.8), `${label}: daftar meja satu kolom selebar kartu`);
    ok(g.slideH >= g.vw * 0.55 && g.slideH <= g.vw * 0.9, `${label}: panggung berbentuk ±16:10 (${Math.round(g.slideH)} px)`);
    const fit = await p.evaluate(() => { const b = document.querySelector('.slide-text'); const s = document.getElementById('slide'); const cd = document.getElementById('cd').getBoundingClientRect(); const h2 = b.querySelector('h2').getBoundingClientRect(); return b.scrollHeight <= s.clientHeight + 2 && h2.top >= cd.bottom - 1; });
    ok(fit, `${label}: teks pengumuman muat di panggung dan tidak tertutup pil hitung mundur`);
    await clean(p, `papan ${label}`);
    if (label === 'iPhone 13') {
      await p.screenshot({ path: SHOTS + '/m-board-top.png' });
    }
    await ctx.close();
  }

  // ---------- Papan: tablet potret dan landscape ponsel ----------
  {
    const ctx = await browser.newContext(dev('iPad Mini'));
    const p = await ctx.newPage(); watch(p, 'papan-ipad');
    await p.goto(B + '/layar/lobi?sound=on'); await p.waitForSelector('#counters .ctr'); await p.waitForTimeout(500);
    const order = await p.evaluate(() => [document.querySelector('#nowPanel').getBoundingClientRect().top, document.querySelector('.stage').getBoundingClientRect().top, document.querySelector('.desks').getBoundingClientRect().top]);
    ok(order[0] < order[1] && order[1] < order[2], `iPad potret: tata letak satu kolom (${order.map(Math.round).join(', ')})`);
    await clean(p, 'papan iPad potret');
    await p.screenshot({ path: SHOTS + '/m-board-ipad.png' });
    await ctx.close();
    const ctx2 = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true });
    const q = await ctx2.newPage(); watch(q, 'papan-tablet-l');
    await q.goto(B + '/layar/lobi?sound=on'); await q.waitForSelector('#counters .ctr'); await q.waitForTimeout(500);
    const two = await q.evaluate(() => getComputedStyle(document.querySelector('.body')).gridTemplateColumns.split(' ').length);
    ok(two === 2 && (await q.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))) >= 14, 'tablet landscape 1024x768: tata letak TV dua kolom dengan teks dasar >= 14 px');
    const noScroll = await q.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1);
    ok(noScroll, 'tablet landscape: papan tetap muat satu layar tanpa gulir');
    await q.screenshot({ path: SHOTS + '/m-board-tablet-landscape.png' });
    await ctx2.close();
  }

  // ---------- Papan tanpa antrian: lembar bawah ----------
  {
    const ctx = await browser.newContext(dev('iPhone 13'));
    const p = await ctx.newPage(); watch(p, 'info-hp');
    await p.goto(B + '/layar/info');
    await p.waitForSelector('.slide-text h2');
    ok(await p.isVisible('#browseBtn'), 'layar info (ponsel): tombol "Daftar" mengambang tampil');
    ok(await p.isHidden('.queue'), 'layar info (ponsel): tanpa kolom antrian');
    await p.tap('#browseBtn');
    await p.waitForSelector('.browse.open');
    await p.waitForTimeout(450);
    const sheet = await p.evaluate(() => { const r = document.getElementById('browse').getBoundingClientRect(); return { l: r.left, r: r.right, b: r.bottom, vw: innerWidth, vh: innerHeight, items: document.querySelectorAll('#browseList .bi').length, fab: getComputedStyle(document.getElementById('browseBtn')).display }; });
    ok(sheet.l <= 1 && sheet.r >= sheet.vw - 1 && Math.abs(sheet.b - sheet.vh) <= 2, 'lembar bawah selebar layar dan menempel di dasar');
    ok(sheet.items === 3 && sheet.fab === 'none', 'lembar memuat 3 informasi dan tombol mengambang tersembunyi saat terbuka');
    await p.screenshot({ path: SHOTS + '/m-info-sheet.png' });
    await p.locator('#browseList .bi', { hasText: 'Pengumuman' }).tap();
    await p.waitForFunction(() => (document.querySelector('.slide-text h2') || {}).textContent === 'Pengumuman');
    ok(await p.evaluate(() => document.getElementById('cdText').textContent === 'Dijeda'), 'mengetuk judul melompat ke informasi itu dan tayangan dijeda');
    await p.tap('#browseClose');
    await p.waitForFunction(() => !document.querySelector('.browse.open'));
    ok(await p.isVisible('#browseBtn') && /\d+ dtk|Video/.test(await p.textContent('#cdText')), 'tombol tutup menutup lembar, tayangan lanjut, tombol mengambang kembali');
    await clean(p, 'papan info ponsel');
    await ctx.close();
  }

  // ---------- Kiosk ----------
  for (const [label, opt] of [['iPhone SE', dev('iPhone SE')], ['320x568', { viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }], ['iPad Mini', dev('iPad Mini')]]) {
    const ctx = await browser.newContext(opt);
    const p = await ctx.newPage(); watch(p, 'kiosk-' + label);
    await p.goto(B + '/kiosk'); await p.waitForSelector('.cat'); await p.waitForTimeout(400);
    await clean(p, `kiosk ${label}`);
    await p.locator('.cat').first().tap();
    await p.waitForSelector('#overlay:not(.hidden)');
    await p.waitForTimeout(400);
    await clean(p, `kiosk slip ${label}`);
    if (label === 'iPhone SE') await p.screenshot({ path: SHOTS + '/m-kiosk-slip.png' });
    await ctx.close();
  }

  // ---------- Halaman pantau ----------
  for (const [label, opt] of [['360x640', { viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }], ['landscape 844x390', { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }]]) {
    const ctx = await browser.newContext(opt);
    const p = await ctx.newPage(); watch(p, 'pantau-' + label);
    await p.goto(`${B}/antrian/${token}`); await p.waitForSelector('#ticket:visible'); await p.waitForTimeout(400);
    await clean(p, `pantau ${label}`);
    if (label === '360x640') {
      ok(await p.evaluate(() => document.getElementById('hero').getBoundingClientRect().bottom <= innerHeight), 'pantau 360x640: kartu nomor terlihat penuh tanpa menggulir');
      await p.screenshot({ path: SHOTS + '/m-track.png' });
    } else await p.screenshot({ path: SHOTS + '/m-track-landscape.png' });
    await ctx.close();
  }

  // ---------- Panel meja ----------
  for (const [label, opt] of [['iPhone SE', dev('iPhone SE')], ['landscape 844x390', { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }], ['300x600', { viewport: { width: 300, height: 600 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }]]) {
    const ctx = await browser.newContext(opt);
    const p = await ctx.newPage(); watch(p, 'meja-' + label);
    await p.goto(B + '/operator'); await p.waitForSelector('#loginForm:visible');
    await clean(p, `panel meja login ${label}`);
    await p.fill('#u', 'budi'); await p.fill('#p', 'password1'); await p.tap('#loginForm button');
    await p.waitForSelector('#pickView:visible, #panelView:visible');
    if (await p.isVisible('#pickView')) { await p.locator('#pickView button:not([disabled])').first().tap(); await p.waitForSelector('#panelView:visible'); }
    await p.waitForTimeout(500);
    await clean(p, `panel meja ${label}`);
    const nav = await p.evaluate(() => { const r = document.querySelector('.nav').getBoundingClientRect(); return { b: r.bottom, h: r.height, vh: innerHeight }; });
    ok(Math.abs(nav.b - nav.vh) <= 1 && (label.startsWith('landscape') ? nav.h <= 64 : true), `panel meja ${label}: navigasi bawah menempel di dasar (tinggi ${Math.round(nav.h)} px)`);
    if (label === 'iPhone SE') await p.screenshot({ path: SHOTS + '/m-operator.png' });
    if (label.startsWith('landscape')) await p.screenshot({ path: SHOTS + '/m-operator-landscape.png' });
    await ctx.close();
  }

  // ---------- Admin ----------
  for (const [label, opt] of [['iPhone 13', dev('iPhone 13')], ['iPad Mini', dev('iPad Mini')]]) {
    const ctx = await browser.newContext(opt);
    const a = await ctx.newPage(); watch(a, 'admin-' + label);
    await a.goto(B + '/admin#dashboard');
    await a.waitForSelector('#loginForm:visible');
    await clean(a, `admin login ${label}`);
    await a.fill('#u', 'admin'); await a.fill('#p', 'rahasia123'); await a.tap('#loginForm button');
    await a.waitForSelector('#shell:visible');
    await a.waitForTimeout(500);
    const phone = label === 'iPhone 13';
    for (const tab of ['dashboard', 'content', 'screens', 'queue', 'users', 'report', 'settings']) {
      await a.evaluate((h) => { location.hash = h; }, tab);
      await a.waitForTimeout(500);
      await clean(a, `admin ${label} / ${tab}`);
      if (phone) await a.screenshot({ path: SHOTS + `/m-admin-${tab}.png` });
    }
    if (phone) {
     
      // Tabel -> kartu
      await a.evaluate(() => { location.hash = 'content'; });
      await a.waitForSelector('#contentRows tr[data-id]');
      const card = await a.evaluate(() => {
        const tr = document.querySelector('#contentRows tr[data-id]'); const tds = [...tr.cells];
        return { tr: getComputedStyle(tr).display, td: getComputedStyle(tds[2]).display, labels: tds.map((c) => c.dataset.label || '').filter(Boolean), width: tr.getBoundingClientRect().width, vw: innerWidth, thead: document.querySelector('#contentRows').closest('table').tHead.getBoundingClientRect().width };
      });
      ok(card.tr === 'flex' && card.td === 'flex' && card.labels.length >= 3 && card.width <= card.vw - 16, `admin ponsel: baris konten menjadi kartu berlabel (${card.labels.join(' | ')})`);
      ok(card.thead === 0, 'admin ponsel: kepala tabel disembunyikan (label ada di tiap sel)');
     
      // Pilih baris -> bar aksi massal di dalam layar
      // tap (bukan klik mouse): klik mouse membuat Chromium menganggap pointer 'fine' dan mematikan aturan pointer: coarse
      await a.locator('#contentRows input[data-sel]').first().tap();
      await a.waitForSelector('#bulkbar:not(.hidden)');
      const bb = await a.evaluate(() => { const r = document.getElementById('bulkbar').getBoundingClientRect(); return { l: r.left, r: r.right, b: r.bottom, vw: innerWidth, vh: innerHeight }; });
      ok(bb.l >= 0 && bb.r <= bb.vw && bb.b <= bb.vh, 'admin ponsel: bar aksi massal muat di dalam layar');
      await a.screenshot({ path: SHOTS + '/m-admin-bulk.png' });
      await a.locator('#bulkClear').tap();
      // Laci formulir konten: penuh layar, footer menempel, editor muat
      await a.locator('#addContent').tap();
      await a.waitForSelector('#contentForm:visible'); await a.waitForSelector('#mdEditor .ProseMirror'); await a.waitForTimeout(450);
      const dr = await a.evaluate(() => {
        const d = document.getElementById('drawer').getBoundingClientRect(); const f = document.querySelector('#contentForm .dfoot').getBoundingClientRect(); const e = document.querySelector('.md-editor').getBoundingClientRect();
        return { w: d.width, vw: innerWidth, footBottom: f.bottom, vh: innerHeight, edL: e.left, edR: e.right };
      });
      ok(Math.abs(dr.w - dr.vw) <= 1, `admin ponsel: laci selebar layar (${Math.round(dr.w)} = ${dr.vw})`);
      ok(dr.footBottom <= dr.vh + 1 && dr.edL >= 0 && dr.edR <= dr.vw, 'admin ponsel: tombol Simpan terlihat dan editor muat di dalam layar');
      await clean(a, 'admin ponsel: laci konten');
      await a.screenshot({ path: SHOTS + '/m-admin-drawer.png' });
      await a.locator('#ctype').selectOption('image');
      await a.waitForSelector('#fileDz .dz');
      ok((await a.evaluate(() => getComputedStyle(document.querySelector('#fileDz .dz-touch')).display)) !== 'none', 'dropzone pada perangkat sentuh: teks "Ketuk untuk memilih berkas"');
      await a.screenshot({ path: SHOTS + '/m-admin-dropzone.png' });
      await a.locator('#drawerClose').tap();
      // Menu laci sidebar
      await a.locator('.menu-btn').tap();
      await a.waitForSelector('.shell.open');
      await a.waitForTimeout(350);
      await clean(a, 'admin ponsel: sidebar terbuka');
      await a.screenshot({ path: SHOTS + '/m-admin-menu.png' });
    } else {
      const tablet = await a.evaluate(() => getComputedStyle(document.querySelector('#contentRows tr')).display);
      ok(tablet === 'table-row', 'admin tablet 768 px: tabel tetap berupa tabel (bukan kartu)');
      await a.screenshot({ path: SHOTS + '/m-admin-ipad.png' });
    }
    await ctx.close();
  }

  // ---------- Lintasan visual (halaman penuh): setelah semua pemeriksaan sentuh, karena fullPage mereset emulasi pointer ----------
  {
    const ctx = await browser.newContext(dev('iPhone 13'));
    const p = await ctx.newPage();
    await p.goto(B + '/layar/lobi?sound=on'); await p.waitForSelector('#counters .ctr'); await p.waitForTimeout(500);
    await p.screenshot({ path: SHOTS + '/m-board-full.png', fullPage: true });
    await p.goto(B + '/kiosk'); await p.waitForSelector('.cat'); await p.waitForTimeout(400);
    await p.screenshot({ path: SHOTS + '/m-kiosk.png', fullPage: true });
    await ctx.close();
  }

  await browser.close();
  ok(errs.length === 0, 'tanpa error konsol atau pelanggaran CSP' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  console.log(`\nGagal: ${fails}`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('E2E GAGAL:', e.message); process.exit(1); });
