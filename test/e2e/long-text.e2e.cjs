// Teks panjang di papan: diperkecil, dua kolom, lalu gulir otomatis; gulir manual saat dijelajahi di layar interaktif.
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
const bullets = (n, short) => Array.from({ length: n }, (_, i) => short ? `- Butir singkat ${i + 1}` : `- butir nomor ${i + 1} dengan kalimat yang cukup panjang untuk satu baris`).join('\n');
const doc = (n, short) => `## Persyaratan\n\n${bullets(n, short)}\n\n*Catatan: ini contoh catatan akhir yang cukup panjang agar mirip pengumuman layanan.*\n\n## Alur Pelayanan\n\n1. Ambil nomor antrian\n2. Serahkan berkas\n3. Tunggu panggilan`;

(async () => {
  const api = await request.newContext({ baseURL: B });
  const call = async (m, u, d) => { const r = await api[m](u, d ? { data: d } : undefined); return { s: r.status(), b: await r.json().catch(() => null) }; };
  await call('post', '/api/auth/login', { username: 'admin', password: 'rahasia123' });
  const seed = (await call('get', '/api/admin/content')).b;
  if (seed.length) await call('post', '/api/admin/content/bulk', { ids: seed.map((c) => c.id), action: 'delete' });
  const id = (await call('post', '/api/admin/content', { type: 'text', title: 'Pelayanan Legalisasi Ijazah Sekolah Tutup', body: doc(8), duration: 40 })).b.id;
  await call('post', '/api/admin/screens', { name: 'Info', slug: 'info', showQueue: false, resumeSeconds: 5 });
  const setDoc = (n, short) => call('put', '/api/admin/content/' + id, { type: 'text', title: 'Pelayanan Legalisasi Ijazah Sekolah Tutup', body: doc(n, short), duration: 40, active: true });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const p = await ctx.newPage(); watch(p, 'papan');
  await p.goto(B + '/?sound=on');
  await p.waitForSelector('.slide-text .md');
  const state = () => p.evaluate(() => {
    const b = document.querySelector('.slide-text'); const s = document.getElementById('slide');
    return { cols: b.classList.contains('cols2'), mode: b.dataset.mode || '', fit: parseFloat(b.style.getPropertyValue('--fit')), h: b.scrollHeight, stageH: s.clientHeight, w: b.scrollWidth, cw: b.clientWidth, anims: b.getAnimations().length, tr: getComputedStyle(b).transform, h2top: document.querySelector('.slide-text h2').getBoundingClientRect().top - s.getBoundingClientRect().top };
  });
  const waitDoc = async (n, short) => { await setDoc(n, short); await p.waitForFunction((k) => document.querySelectorAll('.slide-text .md li').length >= k, n, { timeout: 8000 }); await p.waitForTimeout(500); };

  // 1) Sedang: cukup diperkecil
  let st = await state();
  ok(!st.cols && !st.mode && st.h <= st.stageH + 1, `teks sedang: cukup satu kolom (fit ${st.fit}, tinggi ${st.h} <= ${st.stageH})`);

  // 2) Cukup panjang: dua kolom
  await waitDoc(26, true);
  st = await state();
  ok(st.cols && !st.mode && st.h <= st.stageH + 1 && st.w <= st.cw + 1, `teks panjang: dibagi dua kolom dan muat (fit ${st.fit}, tinggi ${st.h} <= ${st.stageH})`);
  ok(st.fit >= 0.6, 'ukuran huruf tidak lebih kecil dari batas baca (60%)');
  await p.screenshot({ path: SHOTS + '/lt-two-columns.png' });

  // 3) Sangat panjang: gulir otomatis
  await waitDoc(150);
  st = await state();
  ok(st.mode === 'scroll' && !st.cols && st.anims >= 1, `teks sangat panjang: gulir otomatis aktif (animasi ${st.anims}, tinggi ${st.h} > ${st.stageH})`);
  ok(st.h > st.stageH && st.h2top >= 0 && st.h2top < 120, `gulir dimulai dari judul di atas (jarak ${Math.round(st.h2top)} px)`);
  await p.waitForTimeout(4500);
  const moved = await p.evaluate(() => getComputedStyle(document.querySelector('.slide-text')).transform);
  ok(moved !== 'none' && moved !== 'matrix(1, 0, 0, 1, 0, 0)', 'teks bergeser ke atas seiring waktu: ' + moved.slice(0, 40));
  await p.screenshot({ path: SHOTS + '/lt-autoscroll.png' });
  await p.close();

  // 4) Layar interaktif: gulir manual saat dijelajahi, otomatis lagi setelah diam
  const q = await ctx.newPage(); watch(q, 'info');
  await q.goto(B + '/layar/info');
  await q.waitForSelector('.slide-text .md');
  await q.waitForFunction(() => document.querySelector('.slide-text').dataset.mode === 'scroll');
  await q.mouse.move(900, 500); await q.mouse.move(960, 540);
  await q.waitForSelector('.browse.open');
  await q.waitForTimeout(500);
  const man = await q.evaluate(() => { const s = document.getElementById('slide'); const b = document.querySelector('.slide-text'); return { manual: s.classList.contains('manual'), ov: getComputedStyle(s).overflowY, anims: b.getAnimations().length, tr: getComputedStyle(b).transform }; });
  ok(man.manual && man.ov === 'auto' && man.anims === 0, 'dijelajahi: gulir otomatis berhenti dan panggung bisa digulir manual');
  await q.mouse.move(1200, 500);
  await q.mouse.wheel(0, 700);
  await q.waitForTimeout(400);
  const top = await q.evaluate(() => document.getElementById('slide').scrollTop);
  ok(top > 300, `roda mouse menggulir konten (scrollTop ${Math.round(top)})`);
  await q.screenshot({ path: SHOTS + '/lt-manual.png' });
  await q.waitForFunction(() => !document.querySelector('.browse.open'), null, { timeout: 14000 });
  await q.waitForTimeout(400);
  const back = await q.evaluate(() => { const s = document.getElementById('slide'); const b = document.querySelector('.slide-text'); return { manual: s.classList.contains('manual'), top: s.scrollTop, anims: b.getAnimations().length }; });
  ok(!back.manual && back.top === 0 && back.anims >= 1, 'setelah diam: gulir manual berakhir dan gulir otomatis mulai dari atas lagi');
  await q.close();

  // 5) Ponsel: diperkecil lalu gulir otomatis (tanpa dua kolom)
  const { defaultBrowserType, ...ip } = devices['iPhone 13'];
  const mctx = await browser.newContext(ip);
  const m = await mctx.newPage(); watch(m, 'ponsel');
  await m.goto(B + '/?sound=on');
  await m.waitForSelector('.slide-text .md');
  await m.waitForFunction(() => document.querySelector('.slide-text').dataset.mode === 'scroll');
  const ms = await m.evaluate(() => ({ cols: document.querySelector('.slide-text').classList.contains('cols2'), scroll: document.querySelector('.slide-text').dataset.mode }));
  ok(!ms.cols && ms.scroll === 'scroll', 'ponsel: tanpa dua kolom, teks sangat panjang digulir otomatis');
  await mctx.close();

  await browser.close();
  ok(errs.length === 0, 'tanpa error konsol atau pelanggaran CSP' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  console.log(`\nGagal: ${fails}`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('E2E GAGAL:', e.message); process.exit(1); });
