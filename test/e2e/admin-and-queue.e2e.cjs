// Tes e2e (Playwright). Dijalankan oleh test/e2e/run.mjs, yang menyiapkan server, fixture, dan variabel:
//   E2E_BASE (alamat server), E2E_FIXTURES (folder fixture), E2E_SHOTS (folder tangkapan layar), E2E_ROOT (akar repo).
const FX = process.env.E2E_FIXTURES;
const SHOTS = process.env.E2E_SHOTS;
const { chromium } = require('playwright');
const fs = require('fs');
const B = process.env.E2E_BASE;
const errs = [];
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; };
const watch = (page, tag) => {
  page.on('pageerror', (e) => errs.push(`[${tag}] pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (401|404|409|403|429)/.test(m.text())) errs.push(`[${tag}] console: ${m.text()}`); });
};
const txt = async (p, sel) => (await p.textContent(sel)).replace(/\s+/g, ' ').trim();

(async () => {
  const browser = await chromium.launch();

  // ================= ADMIN =================
  const actx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const a = await actx.newPage(); watch(a, 'admin');
  await a.goto(B + '/admin');
  await a.waitForSelector('#loginForm:visible');
  await a.fill('#u', 'admin'); await a.fill('#p', 'salah'); await a.click('#loginForm button');
  await a.waitForFunction(() => document.getElementById('loginErr').textContent.length > 0);
  await a.fill('#p', 'rahasia123'); await a.click('#loginForm button');
  await a.waitForSelector('#shell:visible');
  ok(true, 'admin: login');
  ok(await a.isHidden('#crumbRoot'), 'admin: breadcrumb dasbor tidak berulang');
  await a.waitForFunction(() => document.getElementById('kpis').textContent.includes('Konten aktif'), null, { timeout: 10000 }).catch(() => {});
  ok((await txt(a, '#kpis')).includes('Konten aktif'), 'admin: kartu KPI tampil');

  // --- Pengaturan: nama, prioritas kiosk
  await a.click('[data-page=settings]');
  await a.fill('#settingsForm [name=org_name]', 'Dinas Uji Coba');
  await a.locator('#settingsForm [name=priority_enabled]').evaluate((e) => e.click()); // switch memakai input tersembunyi secara visual
  await a.click('#settingsForm button[type=submit]');
  await a.waitForFunction(() => document.getElementById('brandName').textContent.includes('Dinas Uji Coba'));
  ok(true, 'admin: pengaturan disimpan, nama instansi tampil di sidebar');

  // --- Layar lewat laci
  await a.click('[data-page=screens]');
  await a.click('#addScreen');
  await a.waitForSelector('#screenForm:visible');
  ok(true, 'laci: formulir layar tampil');
  for (const [name, slug, cat] of [['Lobi', 'lobi', 'Pelayanan Umum'], ['Layar B', 'layar-b', 'Administrasi']]) {
    if (!(await a.isVisible('#screenForm'))) await a.click('#addScreen');
    await a.fill('#screenForm [name=name]', name);
    await a.fill('#screenForm [name=slug]', slug);
    await a.locator('#screenCats label', { hasText: cat }).locator('input').check();
    await a.click('#screenForm button[type=submit]');
    await a.waitForFunction((n) => [...document.querySelectorAll('#screenRows tr')].some((r) => r.textContent.includes(n)), name);
  }
  ok(true, 'admin: dua layar dibuat lewat laci');

  // --- Pegawai lewat laci
  await a.click('[data-page=users]');
  for (const [name, user, ctrs] of [['Budi Santoso', 'budi', ['Meja 1']], ['Dewi Lestari', 'dewi', ['Meja 2']]]) {
    await a.click('#addUser');
    await a.waitForSelector('#userForm:visible');
    await a.fill('#userForm [name=name]', name);
    await a.fill('#userForm [name=username]', user);
    await a.fill('#userForm [name=password]', 'password1');
    for (const c of ctrs) await a.locator('#userCounters label', { hasText: c }).locator('input').check();
    await a.click('#userForm button[type=submit]');
    await a.waitForFunction((n) => [...document.querySelectorAll('#userRows tr')].some((r) => r.textContent.includes(n)), name);
  }
  ok(true, 'admin: dua pegawai dibuat lewat laci');
  await a.fill('#userSearch', 'dewi');
  ok((await a.locator('#userRows tr').count()) === 1, 'admin: pencarian pegawai menyaring baris');
  await a.fill('#userSearch', '');
  await a.selectOption('#userRoleFilter', 'admin');
  ok((await txt(a, '#userRows')).includes('Administrator') && !(await txt(a, '#userRows')).includes('Budi'), 'admin: filter peran');
  await a.selectOption('#userRoleFilter', '');

  // --- Konten: banyak item lewat API untuk uji pagination, lalu uji UI
  for (let i = 1; i <= 10; i++) {
    await a.evaluate((n) => fetch('/api/admin/content', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'text', title: 'Info ' + n, body: 'isi', duration: 8 }) }), i);
  }
  await a.click('[data-page=content]');
  await a.reload(); await a.waitForSelector('#shell:visible'); // hash #content dipertahankan
  await a.waitForFunction(() => document.getElementById('page-content').classList.contains('on'));
  ok(true, 'admin: hash #content dipertahankan setelah reload');
  ok((await a.locator('#contentRows tr').count()) === 8, 'admin: pagination 8 baris per halaman');
  await a.click('#contentPager button[data-p="2"]');
  ok((await a.locator('#contentRows tr').count()) === 3, 'admin: halaman 2 berisi sisa 3 baris');
  await a.click('#contentPager button[data-p="1"]');
  await a.fill('#contentSearch', 'Info 7');
  ok((await a.locator('#contentRows tr').count()) === 1, 'admin: pencarian konten');
  await a.fill('#contentSearch', '');

  // Tambah konten teks khusus Layar B lewat laci
  await a.click('#addContent');
  await a.waitForSelector('#contentForm:visible');
  await a.fill('#contentForm [name=title]', 'Khusus B');
  await a.fill('#contentForm [name=body]', 'Hanya layar B');
  await a.locator('#contentScreens label', { hasText: 'Layar B' }).locator('input').check();
  await a.click('#contentSave');
  await a.fill('#contentSearch', 'Khusus B');
  await a.waitForFunction(() => [...document.querySelectorAll('#contentRows tr')].some((r) => r.textContent.includes('Khusus B')));
  ok((await txt(a, '#contentRows')).includes('Layar B'), 'admin: konten tersimpan dengan layar tujuan');
  const viaApi = await a.evaluate(async () => (await (await fetch('/api/admin/content')).json()).find((c) => c.title === 'Khusus B'));
  ok(viaApi && viaApi.screens.length === 1, 'admin: server menyimpan tepat 1 layar tujuan untuk konten itu');
  // Ubah
  await a.locator('#contentRows [data-edit]').first().click();
  await a.waitForSelector('#contentForm:visible');
  ok((await a.inputValue('#contentForm [name=title]')) === 'Khusus B', 'laci: formulir ubah terisi data lama');
  await a.fill('#contentForm [name=title]', 'Khusus B (ubah)');
  await a.click('#contentSave');
  await a.waitForFunction(() => [...document.querySelectorAll('#contentRows tr')].some((r) => r.textContent.includes('(ubah)')) || document.getElementById('contentSearch').value !== '');
  await a.fill('#contentSearch', '');

  // Unggah PDF, gambar, video
  const upl = async (type, file, title, extra) => {
    await a.click('#addContent');
    await a.waitForSelector('#contentForm:visible');
    await a.selectOption('#ctype', type);
    await a.fill('#contentForm [name=title]', title);
    await a.setInputFiles('#fileInput', file);
    return extra;
  };
  await upl('pdf', FX + '/tiga-halaman.pdf', 'Dokumen PDF');
  await a.waitForFunction(() => document.getElementById('fileStatus').textContent.includes('Terunggah'));
  ok((await txt(a, '#durLabel')).includes('per halaman'), 'laci: durasi PDF berlabel "per halaman"');
  await a.fill('#contentForm [name=duration]', '4');
  await a.click('#contentSave');
  await a.waitForSelector('#drawer:not(.open)', { state: 'attached' });

  await upl('image', FX + '/promo.png', 'Gambar Promo');
  await a.waitForFunction(() => document.getElementById('fileStatus').textContent.includes('Terunggah'));
  await a.fill('#contentForm [name=duration]', '6');
  await a.locator('#contentForm [name=screensaver]').evaluate((e) => e.click());
  await a.click('#contentSave');
  await a.waitForSelector('#drawer:not(.open)', { state: 'attached' });

  await upl('video', FX + '/clip.webm', 'Video Uji');
  await a.waitForFunction(() => document.getElementById('fileStatus').textContent.length > 0);
  const disabledDuring = await a.isDisabled('#contentSave').catch(() => false);
  await a.waitForFunction(() => document.getElementById('fileStatus').textContent.includes('Video siap'), null, { timeout: 30000 });
  ok(await a.isEnabled('#contentSave'), 'video: tombol Simpan aktif setelah konversi selesai');
  console.log('INFO  Simpan sempat nonaktif saat konversi:', disabledDuring);
  await a.fill('#contentForm [name=duration]', '0');
  await a.click('#contentSave');
  await a.waitForSelector('#drawer:not(.open)', { state: 'attached' });
  ok(true, 'admin: PDF, gambar, dan video (dikonversi) tersimpan');

  // Aksi massal
  await a.click('#contentTabs [data-tab=text]');
  const boxes = a.locator('#contentRows input[data-sel]');
  await boxes.nth(0).check(); await boxes.nth(1).check();
  ok((await txt(a, '#bulkCount')) === '2 dipilih' && await a.isVisible('#bulkbar'), 'admin: bar aksi massal muncul dengan jumlah terpilih');
  await a.click('#bulkbar [data-bulk=deactivate]');
  await a.waitForFunction(() => document.getElementById('bulkbar').classList.contains('hidden'));
  ok((await a.locator('#contentRows .pill.off').count()) >= 2, 'admin: nonaktifkan massal berhasil');
  await boxes.nth(0).check();
  a.once('dialog', (d) => d.accept());
  await a.click('#bulkbar [data-bulk=delete]');
  await a.waitForFunction(() => document.getElementById('bulkbar').classList.contains('hidden'));
  ok(true, 'admin: hapus massal berhasil');
  const apiList = await a.evaluate(async () => (await (await fetch('/api/admin/content')).json()).map((c) => c.type + ':' + c.title));
  ok(apiList.some((x) => x.startsWith('pdf')) && apiList.some((x) => x.startsWith('video')), 'admin: konten PDF dan video ada di server');
  fs.writeFileSync(SHOTS + '/e3-content-list.json', JSON.stringify(apiList));

  // Kategori & meja (laci)
  await a.click('[data-page=queue]');
  await a.click('#addQueue'); await a.waitForSelector('#catForm:visible');
  await a.fill('#catForm [name=name]', 'Pengaduan'); await a.fill('#catForm [name=prefix]', 'c');
  await a.click('#catForm button[type=submit]');
  await a.waitForFunction(() => document.getElementById('queueRows').textContent.includes('Pengaduan'));
  await a.click('#queueTabs [data-tab=ctrs]');
  ok((await a.locator('#queueRows tr').count()) === 3, 'admin: tab Meja menampilkan 3 meja');
  await a.click('#queueTabs [data-tab=cats]');
  ok((await txt(a, '#queueRows')).includes('C') && (await txt(a, '#queueRows')).includes('Pengaduan'), 'admin: kategori baru dengan prefix huruf besar');

  // ================= KIOSK =================
  const kctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const k = await kctx.newPage(); watch(k, 'kiosk');
  await k.goto(B + '/kiosk');
  await k.waitForSelector('.cat');
  ok(await k.isVisible('#prioBox'), 'kiosk: tombol prioritas tampil setelah diaktifkan admin');
  await k.locator('.cat', { hasText: 'Pelayanan Umum' }).click();
  await k.waitForSelector('#overlay:not(.hidden)');
  ok((await txt(k, '#sNum')) === 'A-001' && (await txt(k, '#sAhead')) === '0', 'kiosk: A-001 terbit, 0 orang di depan');
  ok((await txt(k, '#sEta')) === 'Berikutnya', 'kiosk: slip menyatakan "Berikutnya"');
  await k.click('#overlay');
  await k.locator('.cat', { hasText: 'Pelayanan Umum' }).click(); await k.waitForSelector('#overlay:not(.hidden)'); await k.click('#overlay');
  await k.locator('#prio').evaluate((e) => e.click());
  await k.locator('.cat', { hasText: 'Pelayanan Umum' }).click();
  await k.waitForSelector('#overlay:not(.hidden)');
  ok((await txt(k, '#sNum')) === 'A-003' && !(await k.isHidden('#sPrio')), 'kiosk: A-003 bertanda Prioritas');
  ok((await txt(k, '#sAhead')) === '0', 'kiosk: nomor prioritas melompati 2 antrian biasa (0 di depan)');
  await k.screenshot({ path: SHOTS + '/e3-kiosk-slip.png' });
  await k.click('#overlay');
  await k.waitForTimeout(300);
  await k.screenshot({ path: SHOTS + '/e3-kiosk.png' });

  // ================= OPERATOR: Budi =================
  const octx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const o = await octx.newPage(); watch(o, 'budi');
  await o.goto(B + '/operator');
  await o.fill('#u', 'budi'); await o.fill('#p', 'password1'); await o.click('#loginForm button');
  await o.waitForSelector('#pickView:visible');
  await o.locator('#pickList button', { hasText: 'Meja 1' }).click();
  await o.waitForSelector('#panelView:visible');
  ok((await txt(o, '#waiting')) === '3', 'operator: hero menunjukkan 3 menunggu');
  await o.click('#next');
  await o.waitForFunction(() => document.getElementById('cur').textContent === 'A-003');
  ok(await o.locator('#curPill.y').count() === 1, 'operator: nomor prioritas dipanggil lebih dulu (pil kuning)');
  await o.screenshot({ path: SHOTS + '/e3-op-panel.png' });

  // Pindahkan A-003 ke Meja 2
  ok(await o.isVisible('#xferCard'), 'operator: kartu pindah antrian tampil saat memegang nomor');
  await o.selectOption('#xferTo', { label: 'Meja 2 (kosong)' });
  await o.click('#xferBtn');
  await o.waitForFunction(() => document.getElementById('cur').textContent.trim() === '—');
  ok(true, 'operator: A-003 dipindahkan, Meja 1 kosong');

  // Dewi memegang Meja 2: antrian khusus meja dipanggil lebih dulu
  const dctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const d = await dctx.newPage(); watch(d, 'dewi');
  await d.goto(B + '/operator');
  await d.fill('#u', 'dewi'); await d.fill('#p', 'password1'); await d.click('#loginForm button');
  await d.waitForSelector('#pickView:visible');
  await d.locator('#pickList button', { hasText: 'Meja 2' }).click();
  await d.waitForSelector('#panelView:visible');
  ok((await txt(d, '#dedicated')) === '1' && (await txt(d, '#queued')).includes('A-003'), 'operator: Dewi melihat A-003 khusus Meja 2');
  await d.click('#next');
  await d.waitForFunction(() => document.getElementById('cur').textContent === 'A-003');
  ok(true, 'operator: Dewi memanggil A-003 (dedicated mendahului kategori)');
  await d.click('#done');
  await d.waitForFunction(() => document.getElementById('cur').textContent.trim() === '—');

  // Buat nomor khusus meja + prioritas dari panel Budi
  await o.click('#nav-new');
  await o.locator('#newPrio').evaluate((e) => e.click());
  await o.locator('#newDed').evaluate((e) => e.click());
  await o.click('#newBtn');
  await o.waitForSelector('#newResult:not(.hidden)');
  ok((await txt(o, '#nrNum')).startsWith('A-') && !(await o.isHidden('#nrPrio')), 'operator: nomor baru (prioritas) dibuat dari panel meja');
  await o.screenshot({ path: SHOTS + '/e3-op-new.png' });
  await o.click('#nav-panel');
  await o.waitForFunction(() => document.getElementById('dedicated').textContent === '1');
  ok(true, 'operator: nomor khusus meja muncul di hitungan "Khusus meja ini"');
  await o.click('#next');
  await o.waitForFunction(() => /^A-00\d$/.test(document.getElementById('cur').textContent));
  await o.click('#done');
  await o.click('#nav-hist');
  await o.waitForFunction(() => document.getElementById('histList').textContent.includes('Selesai'));
  const hist = await o.evaluate(async () => (await (await fetch('/api/auth/history')).json()));
  console.log('INFO  riwayat Budi:', JSON.stringify(hist.map((h) => h.label + ':' + h.status)));
  ok((await txt(o, '#histCount')) === '1' && hist.length === 1 && hist[0].status === 'done', 'operator: riwayat hanya memuat 1 nomor selesai (A-003 yang dipindah tidak dihitung)');
  await o.screenshot({ path: SHOTS + '/e3-op-hist.png' });

  // ================= DISPLAY =================
  const dispctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const lobi = await dispctx.newPage(); watch(lobi, 'lobi');
  const lb = await dispctx.newPage(); watch(lb, 'layar-b');
  await lobi.goto(B + '/layar/lobi'); await lb.goto(B + '/layar/layar-b');
  await lobi.click('#unlockBtn'); await lb.click('#unlockBtn');
  await lobi.waitForTimeout(1200);
  ok((await txt(lobi, '#screenName')) === 'Lobi' && (await txt(lobi, '#orgName')) === 'Dinas Uji Coba', 'display: nama instansi dan nama layar');
  ok((await txt(lobi, '#counters')).includes('Pelayanan Umum') && !(await txt(lobi, '#counters')).includes('Administrasi'), 'display lobi: hanya kategori A');
  ok((await txt(lb, '#counters')).includes('Administrasi') && !(await txt(lb, '#counters')).includes('Pelayanan'), 'display layar-b: hanya kategori B');
  const plB = await lb.evaluate(async () => (await (await fetch('/api/playlist?screen=layar-b')).json()).main.map((x) => x.title));
  const plL = await lobi.evaluate(async () => (await (await fetch('/api/playlist?screen=lobi')).json()).main.map((x) => x.title));
  ok(plB.some((t) => t.startsWith('Khusus B')) && !plL.some((t) => t.startsWith('Khusus B')), 'display: konten khusus hanya di layar B');
  // Panggilan baru terlihat realtime di display lobi dengan nama meja
  await o.click('#nav-panel');
  await k.locator('.cat', { hasText: 'Pelayanan Umum' }).click(); await k.waitForSelector('#overlay:not(.hidden)'); await k.click('#overlay');
  await o.click('#next');
  await lobi.waitForFunction(() => /A-00\d/.test(document.getElementById('nowBody').textContent) && document.getElementById('nowBody').textContent.includes('Meja 1'), null, { timeout: 8000 });
  ok(true, 'display lobi: hero menampilkan nomor dan Meja 1 secara realtime');
  ok(!(await txt(lb, '#nowBody')).includes('Silakan menuju'), 'display layar-b: panggilan kategori A tidak tampil');
  await lobi.screenshot({ path: SHOTS + '/e3-display.png' });

  // Tracker: segmen sesuai jumlah item playlist
  const segs = await lobi.locator('#tracker .seg').count();
  const nItems = plL.length;
  ok(segs === nItems, `display: penanda progres punya ${segs} segmen = ${nItems} item playlist`);

  // ================= MOBILE ADMIN =================
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const m = await mctx.newPage(); watch(m, 'admin-mobile');
  await m.goto(B + '/admin');
  await m.fill('#u', 'admin'); await m.fill('#p', 'rahasia123'); await m.click('#loginForm button');
  await m.waitForSelector('#shell:visible');
  ok(!(await m.isVisible('#sidebar')) || (await m.evaluate(() => document.getElementById('sidebar').getBoundingClientRect().right <= 0)), 'mobile: sidebar tersembunyi di luar layar');
  await m.click('#menuBtn'); await m.waitForTimeout(350);
  ok(await m.evaluate(() => document.getElementById('sidebar').getBoundingClientRect().left >= 0), 'mobile: menu membuka laci sidebar');
  await m.click('[data-page=content]'); await m.waitForTimeout(400);
  ok(await m.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'mobile: tanpa scroll horizontal (konten)');
  await m.click('#addContent'); await m.waitForSelector('#contentForm:visible');
  ok(await m.evaluate(() => document.getElementById('drawer').getBoundingClientRect().width <= 390), 'mobile: laci penuh lebar layar');
  await m.screenshot({ path: SHOTS + '/e3-m-drawer.png' });
  await m.keyboard.press('Escape');
  await m.screenshot({ path: SHOTS + '/e3-m-content.png' });

  // Screenshot admin desktop
  for (const pg of ['dashboard', 'content', 'screens', 'queue', 'users', 'report', 'settings']) {
    await a.click(`[data-page=${pg}]`); await a.waitForTimeout(350);
    await a.screenshot({ path: `${SHOTS}/e3-a-${pg}.png` });
  }
  await a.click('[data-page=content]'); await a.click('#addContent'); await a.waitForSelector('#contentForm:visible'); await a.waitForTimeout(400);
  await a.screenshot({ path: SHOTS + '/e3-a-drawer.png' });

  console.log('\nGagal:', fails, '| Error konsol/halaman:', errs.length ? '\n' + errs.join('\n') : 'tidak ada');
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('E2E GAGAL:', e.message.split('\n').slice(0, 6).join('\n')); process.exit(1); });
