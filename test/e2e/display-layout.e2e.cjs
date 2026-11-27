// Tata letak papan: tidak ada meja, badge, atau chip yang terpotong pada 3, 6, dan 12 meja,
// di 1366x768, 1920x1080, dan 3840x2160. Dijalankan oleh test/e2e/run.mjs (lihat catatan di skrip lain).
const SHOTS = process.env.E2E_SHOTS;
const { chromium, request } = require('playwright');
const B = process.env.E2E_BASE;
const errs = [];
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

(async () => {
  const api = await request.newContext({ baseURL: B });
  const call = async (m, u, d) => { const r = await api[m](u, d ? { data: d } : undefined); return { s: r.status(), b: await r.json().catch(() => null) }; };
  await call('post', '/api/auth/login', { username: 'admin', password: 'rahasia123' });
  await call('post', '/api/admin/categories', { name: 'Pelayanan Umum', prefix: 'A' });
  const cats = (await call('get', '/api/admin/categories')).b;
  const catId = cats.find((c) => c.prefix === 'A').id;
  await call('post', '/api/admin/content', { type: 'text', title: 'Selamat datang', body: 'Silakan ambil nomor antrian melalui kiosk. Terima kasih atas kesabaran Anda.', duration: 600, active: true });

  const browser = await chromium.launch();
  const sizes = [[1366, 768], [1920, 1080], [3840, 2160]];
  // Basis data baru sudah berisi beberapa meja bawaan; hitung dari sana.
  let have = (await call('get', '/api/admin/counters')).b.length;
  for (const total of [Math.max(have, 3), 6, 12]) {
    // Tambahkan meja sampai berjumlah `total` (nama panjang pada salah satunya untuk uji elipsis).
    for (; have < total; have += 1) {
      const name = have === 1 ? 'Meja Pelayanan Terpadu Satu Atap Kecamatan' : 'Meja ' + (have + 1);
      await call('post', '/api/admin/counters', { name, categoryId: catId });
    }
    const ctrs = (await call('get', '/api/admin/counters')).b;
    // Layani beberapa nomor lewat API admin agar ada pil "Melayani" dan chip terakhir.
    for (let i = 0; i < Math.min(3, ctrs.length); i += 1) {
      await call('post', '/api/tickets', { categoryId: catId });
      await call('post', `/api/counter/${ctrs[i].id}/next`);
    }
    for (const [w, h] of sizes) {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
      await page.goto(B + '/?sound=on');
      await page.waitForFunction((n) => document.querySelectorAll('#counters .ctr').length === n, total);
      await page.waitForTimeout(400);
      const r = await page.evaluate(() => {
        const inside = (el, box, tol = 1) => {
          const a = el.getBoundingClientRect(); const b = box.getBoundingClientRect();
          return a.top >= b.top - tol && a.bottom <= b.bottom + tol && a.left >= b.left - tol && a.right <= b.right + tol;
        };
        const panel = document.querySelector('.panel.desks');
        const list = document.getElementById('counters');
        const rows = [...document.querySelectorAll('#counters .ctr')];
        const clippedText = [...document.querySelectorAll('#counters .rt .pill, #counters .rt .lb, #counters .av')]
          .filter((e) => e.offsetParent !== null) // elemen yang sengaja disembunyikan tidak dihitung
          .filter((e) => { const row = e.closest('.ctr'); return !inside(e, row, 1); }).length;
        return {
          rowsInside: rows.every((e) => inside(e, list)),
          rows: rows.length,
          clippedText,
          recentInside: [...document.querySelectorAll('#recent .rc')].every((e) => inside(e, panel)),
          panelInsideViewport: inside(panel, document.body),
          scrollX: document.documentElement.scrollWidth > innerWidth + 1,
          scrollY: document.documentElement.scrollHeight > innerHeight + 1,
          noCats: !document.getElementById('cats'),
          noFoot: !document.querySelector('.foot'),
          listOverflow: list.scrollHeight > list.clientHeight + 1,
        };
      });
      const tag = `${total} meja @${w}x${h}`;
      ok(r.rows === total, `${tag}: semua meja dirender`);
      ok(r.rowsInside && !r.listOverflow, `${tag}: setiap baris meja berada penuh di dalam kartu (tidak terpotong)`);
      ok(r.clippedText === 0, `${tag}: avatar, nomor, dan pil tidak keluar dari baris`);
      ok(r.recentInside, `${tag}: chip panggilan terakhir di dalam kartu`);
      ok(r.panelInsideViewport && !r.scrollX && !r.scrollY, `${tag}: tidak ada scroll dan kartu di dalam layar`);
      ok(r.noCats && r.noFoot, `${tag}: kartu "Antrian menunggu" dan footer lama sudah tidak ada`);
      await page.screenshot({ path: `${SHOTS}/papan-${total}meja-${w}x${h}.png` });
      await page.close();
    }
  }
  await browser.close();
  ok(errs.length === 0, 'tanpa galat konsol atau pelanggaran CSP' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  console.log(`\nGagal: ${fails}`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
