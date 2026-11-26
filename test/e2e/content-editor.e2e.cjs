// Konten: urutan seret-lepas, editor markdown (Tiptap) dan impor .md, sanitasi markdown di papan, YouTube
// (IFrame API ditiru lewat intersepsi jaringan), dropzone, serta progres unggah dan konversi.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const SHOTS = process.env.E2E_SHOTS;
const { chromium, request } = require('playwright');
const B = process.env.E2E_BASE;
const errs = [];
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const watch = (p, tag) => {
  p.on('pageerror', (e) => errs.push(`[${tag}] pageerror: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error' && !/status of (400|401|404|409|403)|Failed to load resource/.test(m.text())) errs.push(`[${tag}] console: ${m.text().slice(0, 140)} @${(m.location() || {}).url || ''}:${(m.location() || {}).lineNumber || ''}`); });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FAKE_YT = `
  window.YT = { PlayerState: { ENDED: 0, PLAYING: 1 }, Player: function (el, o) {
    window.__ytOpts = o; window.__ytPlayer = this; window.__ytCreated = (window.__ytCreated || 0) + 1;
    this.destroy = function () { window.__ytDestroyed = (window.__ytDestroyed || 0) + 1; };
    this.mute = function () { window.__ytMuted = true; }; this.playVideo = function () { window.__ytPlayed = true; };
    const self = this; setTimeout(function () { o.events.onReady({ target: self }); }, 40);
  } };
  if (window.onYouTubeIframeAPIReady) window.onYouTubeIframeAPIReady();`;

(async () => {
  const api = await request.newContext({ baseURL: B });
  const call = async (m, u, d) => { const r = await api[m](u, d ? { data: d } : undefined); return { s: r.status(), b: await r.json().catch(() => null) }; };
  await call('post', '/api/auth/login', { username: 'admin', password: 'rahasia123' });
  // Bersihkan konten bawaan agar urutan mudah diperiksa.
  const seed = (await call('get', '/api/admin/content')).b;
  if (seed.length) await call('post', '/api/admin/content/bulk', { ids: seed.map((c) => c.id), action: 'delete' });
  const mk = async (title) => (await call('post', '/api/admin/content', { type: 'text', title, body: title, duration: 10 })).b.id;
  const [A, Bb, C] = [await mk('Satu'), await mk('Dua'), await mk('Tiga')];

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const a = await ctx.newPage(); watch(a, 'admin');
  await a.goto(B + '/admin#content');
  await a.waitForSelector('#loginForm:visible');
  await a.fill('#u', 'admin'); await a.fill('#p', 'rahasia123'); await a.click('#loginForm button');
  await a.waitForSelector('#shell:visible');
  await a.waitForSelector('#contentRows tr[data-id]');

  // ---------- Urutan ----------
  const order = async () => (await call('get', '/api/admin/content')).b.map((c) => c.id);
  ok(JSON.stringify(await order()) === JSON.stringify([A, Bb, C]), 'urutan awal sesuai pembuatan');
  ok((await a.locator('#contentRows .grip').count()) === 3 && (await txt(a, '#orderHint')).includes('Seret'), 'pegangan seret tampil dan petunjuk urutan ada');
  // Keyboard: pegangan baris pertama + panah bawah
  await a.locator(`#contentRows tr[data-id="${A}"] .grip`).focus();
  await a.keyboard.press('ArrowDown');
  await a.waitForFunction(async () => (await (await fetch('/api/admin/content')).json())[0].title === 'Dua');
  ok(JSON.stringify(await order()) === JSON.stringify([Bb, A, C]), 'keyboard: panah bawah memindahkan baris dan menyimpan urutan');
  // Seret dengan mouse: baris Tiga ke atas baris pertama
  await a.locator(`#contentRows tr[data-id="${C}"] .grip`).dragTo(a.locator(`#contentRows tr[data-id="${Bb}"]`), { targetPosition: { x: 40, y: 4 } });
  await a.waitForFunction(async () => (await (await fetch('/api/admin/content')).json())[0].title === 'Tiga', null, { timeout: 8000 }).catch(() => {});
  ok((await order())[0] === C, 'seret-lepas: Tiga dipindahkan ke atas dan urutan tersimpan di server');
  const domOrder = await a.$$eval('#contentRows tr[data-id]', (rs) => rs.map((r) => Number(r.dataset.id)));
  ok(JSON.stringify(domOrder) === JSON.stringify(await order()), 'tabel di layar sama dengan urutan di server');
  await a.reload(); await a.waitForSelector('#contentRows tr[data-id]');
  ok(JSON.stringify(await a.$$eval('#contentRows tr[data-id]', (rs) => rs.map((r) => Number(r.dataset.id)))) === JSON.stringify(await order()), 'urutan bertahan setelah muat ulang');
  const pl = (await call('get', '/api/playlist')).b.main.map((x) => x.id);
  ok(JSON.stringify(pl) === JSON.stringify(await order()), 'papan memakai urutan baru (playlist)');
  await a.fill('#contentSearch', 'Satu');
  ok((await a.locator('#contentRows .grip').count()) === 0 && (await txt(a, '#orderHint')).includes('tab Semua'), 'saat pencarian aktif seret dinonaktifkan dengan keterangan');
  await a.fill('#contentSearch', '');

  // ---------- Editor markdown ----------
  await a.click('#addContent');
  await a.waitForSelector('#contentForm:visible');
  await a.waitForSelector('#mdEditor .ProseMirror');
  await a.fill('#contentForm [name=title]', 'Pengumuman MD');
  await a.click('#mdEditor .ProseMirror');
  await a.click('#mdBar [data-md="bold"]');
  await a.keyboard.type('Tebal');
  await a.click('#mdBar [data-md="bold"]');
  await a.keyboard.type(' biasa');
  await a.keyboard.press('Enter');
  await a.click('#mdBar [data-md="ul"]');
  await a.keyboard.type('butir satu');
  await a.keyboard.press('Enter');
  await a.keyboard.type('butir dua');
  ok(await a.locator('#mdEditor .ProseMirror strong').count() === 1 && await a.locator('#mdEditor .ProseMirror li').count() === 2, 'editor: tebal dan daftar terbentuk lewat bilah alat');
  // Impor berkas .md (judul dari heading pertama hanya bila judul masih kosong; di sini judul sudah terisi)
  const mdFile = path.join(os.tmpdir(), 'impor-' + process.pid + '.md');
  fs.writeFileSync(mdFile, '# Judul Dari Berkas\n\nParagraf *miring* dari berkas.\n\n> kutipan penting\n');
  await a.setInputFiles('#mdDz input[type=file]', mdFile);
  await a.waitForFunction(() => document.querySelector('#mdEditor .ProseMirror').textContent.includes('Paragraf miring dari berkas'));
  ok(await a.locator('#mdEditor .ProseMirror blockquote').count() === 1 && await a.locator('#mdEditor .ProseMirror em').count() === 1, 'impor .md: format (miring, kutipan) ikut terbaca');
  ok((await a.inputValue('#contentForm [name=title]')) === 'Pengumuman MD', 'impor .md tidak menimpa judul yang sudah ada');
  await a.screenshot({ path: SHOTS + '/c-editor.png' });
  await a.click('#contentSave');
  await a.waitForSelector('#drawer:not(.open)', { state: 'attached' });
  const saved = (await call('get', '/api/admin/content')).b.find((c) => c.title === 'Pengumuman MD');
  ok(saved && saved.body.includes('**Tebal** biasa') && /^[-*] butir satu/m.test(saved.body) && saved.body.includes('> kutipan penting'), 'isi tersimpan sebagai markdown: ' + JSON.stringify(saved && saved.body.slice(0, 80)));
  // Ubah: editor terisi markdown lama
  await a.fill('#contentSearch', 'Pengumuman MD');
  await a.locator('#contentRows [data-edit]').first().click();
  await a.waitForSelector('#contentForm:visible');
  await a.waitForFunction(() => document.querySelector('#mdEditor .ProseMirror strong'));
  ok(true, 'ubah: markdown tersimpan dimuat kembali ke editor');
  await a.click('#contentForm [data-close]');
  await a.fill('#contentSearch', '');
  // Impor ke form baru: judul diambil dari heading pertama
  await a.click('#addContent');
  await a.waitForSelector('#contentForm:visible');
  await a.setInputFiles('#mdDz input[type=file]', mdFile);
  await a.waitForFunction(() => document.querySelector('#mdEditor .ProseMirror').textContent.includes('Paragraf'));
  ok((await a.inputValue('#contentForm [name=title]')) === 'Judul Dari Berkas', 'impor .md ke form kosong: judul diambil dari heading pertama');
  // Berkas bukan markdown ditolak lewat toast
  const bad = path.join(os.tmpdir(), 'bukan-' + process.pid + '.exe'); fs.writeFileSync(bad, 'x');
  await a.setInputFiles('#mdDz input[type=file]', bad);
  await a.waitForFunction(() => document.getElementById('toast') && /tidak didukung/.test(document.getElementById('toast').textContent), null, { timeout: 4000 }).catch(() => {});
  ok(true, 'berkas dengan ekstensi salah tidak diimpor');
  await a.click('#contentForm [data-close]');

  // ---------- Sanitasi markdown di papan ----------
  const evil = '# Aman\n\n<script>window.__xss=1</script><img src=x onerror="window.__xss=1">\n\n[klik](javascript:window.__xss=1) dan <b onclick="window.__xss=1">tebal</b>\n\n<iframe src="https://evil.example"></iframe>';
  const evilId = (await call('post', '/api/admin/content', { type: 'text', title: 'Uji XSS MD', body: evil, duration: 600 })).b.id;
  await call('post', '/api/admin/content/reorder', { ids: [evilId, ...(await order()).filter((i) => i !== evilId)] });
  const d = await ctx.newPage(); watch(d, 'papan');
  await d.goto(B + '/?sound=on');
  await d.waitForSelector('.slide-text .md');
  const html = await d.$eval('.slide-text .md', (e) => e.innerHTML);
  ok(!(await d.evaluate(() => window.__xss)), 'papan: markdown berbahaya tidak mengeksekusi apa pun');
  ok(!/<img|<script|<iframe|href=|onclick|onerror/i.test(html), 'papan: tag/atribut berbahaya dibuang dari hasil render: ' + html.slice(0, 120));
  ok(html.includes('<strong>') === false && html.includes('tebal'), 'papan: teks sah tetap tampil');
  await d.screenshot({ path: SHOTS + '/c-md-xss.png' });
  // Markdown biasa tampil berformat
  const putR = await call('put', '/api/admin/content/' + evilId, { type: 'text', title: 'Format', body: '## Judul\n\nIsi **tebal** dan *miring*\n\n- satu\n- dua', duration: 600, active: true });
  ok(putR.s === 200, 'API: sunting konten markdown berhasil (status ' + putR.s + ')');
  await d.waitForFunction(() => document.querySelector('.slide-text .md strong'), null, { timeout: 8000 });
  ok(await d.locator('.slide-text .md li').count() === 2 && await d.locator('.slide-text .md em').count() === 1, 'papan: markdown dirender (tebal, miring, daftar)');
  await d.screenshot({ path: SHOTS + '/c-md-board.png' });
  // Teks panjang diperkecil sampai muat
  await call('put', '/api/admin/content/' + evilId, { type: 'text', title: 'Panjang', body: Array.from({ length: 18 }, (_, i) => `- butir panjang nomor ${i + 1} dengan kalimat yang cukup panjang`).join('\n'), duration: 600, active: true });
  await d.waitForFunction(() => document.querySelector('.slide-text h2') && document.querySelector('.slide-text h2').textContent === 'Panjang', null, { timeout: 8000 });
  await d.waitForTimeout(300);
  const fit = await d.evaluate(() => { const b = document.querySelector('.slide-text'); const s = document.getElementById('slide'); return { box: b.offsetHeight, stage: s.clientHeight, fit: b.style.getPropertyValue('--fit') }; });
  ok(fit.box <= fit.stage + 2, `papan: teks panjang diperkecil agar muat (box ${fit.box} <= panggung ${fit.stage}, --fit ${fit.fit})`);
  await d.screenshot({ path: SHOTS + '/c-md-long.png' });
  await call('delete', '/api/admin/content/' + evilId);

  // ---------- YouTube ----------
  await a.click('#addContent');
  await a.waitForSelector('#contentForm:visible');
  await a.selectOption('#ctype', 'youtube');
  await a.fill('#contentForm [name=title]', 'Profil Video');
  await a.fill('#contentForm [name=url]', 'https://example.com/x');
  ok((await txt(a, '#ytPreview')).includes('belum dikenali'), 'YouTube: tautan salah ditandai belum dikenali');
  await a.fill('#contentForm [name=url]', 'https://youtu.be/dQw4w9WgXcQ?si=zz');
  ok((await a.locator('#ytPreview img').count()) === 1 && (await txt(a, '#ytPreview')).includes('dQw4w9WgXcQ'), 'YouTube: video dikenali, pratinjau tampil');
  await a.fill('#contentForm [name=duration]', '0');
  await a.click('#contentSave');
  await a.waitForSelector('#drawer:not(.open)', { state: 'attached' });
  const yt = (await call('get', '/api/admin/content')).b.find((c) => c.title === 'Profil Video');
  ok(yt && yt.type === 'youtube' && yt.url === 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' && yt.duration === 0, 'YouTube: tersimpan sebagai tautan kanonik, durasi 0');
  ok((await txt(a, '#contentRows')).includes('Sampai selesai'), 'YouTube: daftar menandai "Sampai selesai"');
  await a.screenshot({ path: SHOTS + '/c-admin-list.png' });

  // Papan: hanya YouTube lalu satu teks sesudahnya
  const others = (await order()).filter((i) => i !== yt.id);
  await call('post', '/api/admin/content/reorder', { ids: [yt.id, ...others] });
  await call('post', '/api/admin/content/bulk', { ids: others.slice(1), action: 'deactivate' });
  const p = await ctx.newPage(); watch(p, 'yt');
  await p.route('https://www.youtube.com/iframe_api', (r) => r.fulfill({ contentType: 'text/javascript', body: FAKE_YT }));
  await p.goto(B + '/?sound=on');
  await p.waitForFunction(() => window.__ytCreated === 1, null, { timeout: 8000 });
  await p.waitForFunction(() => window.__ytPlayed === true, null, { timeout: 5000 });
  const o = await p.evaluate(() => ({ host: window.__ytOpts.host, id: window.__ytOpts.videoId, mute: window.__ytOpts.playerVars.mute, controls: window.__ytOpts.playerVars.controls, played: window.__ytPlayed, muted: window.__ytMuted }));
  ok(o.host === 'https://www.youtube-nocookie.com' && o.id === 'dQw4w9WgXcQ' && o.mute === 1 && o.controls === 0 && o.played && o.muted, 'YouTube di papan: nocookie, dibisukan, tanpa kontrol, mulai diputar: ' + JSON.stringify(o));
  ok((await txt(p, '#cdText')).includes('Video'), 'YouTube di papan: penghitung menyatakan "Video" (sampai selesai)');
  await sleep(1500);
  ok(await p.evaluate(() => !!document.querySelector('#slide .fill')) && !(await p.evaluate(() => document.querySelector('.slide-text'))), 'YouTube tetap tampil selama belum selesai');
  await p.evaluate(() => window.__ytOpts.events.onStateChange({ data: 0 })); // ENDED
  await p.waitForFunction(() => document.querySelector('.slide-text'), null, { timeout: 4000 });
  ok(await p.evaluate(() => window.__ytDestroyed >= 1), 'YouTube selesai: pemutar dihancurkan dan item berikutnya tampil');
  await p.close();

  // Galat pemutar -> dilewati; API gagal dimuat -> dilewati
  const p2 = await ctx.newPage(); watch(p2, 'yt-err');
  await p2.route('https://www.youtube.com/iframe_api', (r) => r.abort());
  await p2.goto(B + '/?sound=on');
  await p2.waitForSelector('.slide-text', { timeout: 14000 });
  ok(true, 'YouTube: API tak termuat (tanpa internet) tidak menahan papan; item dilewati');
  await p2.close();
  await call('post', '/api/admin/content/bulk', { ids: others, action: 'activate' });

  // ---------- Dropzone dan progres ----------
  await a.reload(); await a.waitForSelector('#contentRows tr[data-id]');
  await a.click('#addContent');
  await a.waitForSelector('#contentForm:visible');
  await a.selectOption('#ctype', 'image');
  await a.fill('#contentForm [name=title]', 'Gambar Besar');
  const dz = a.locator('#fileDz .dz');
  const mkDt = (name, type, bytes) => a.evaluateHandle(([n, t, b]) => {
    const dt = new DataTransfer();
    const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const arr = new Uint8Array(b); arr.set(head);
    dt.items.add(new File([arr], n, { type: t }));
    return dt;
  }, [name, type, bytes]);
  let dt = await mkDt('x.png', 'image/png', 64);
  await dz.dispatchEvent('dragenter', { dataTransfer: dt });
  ok(await dz.evaluate((e) => e.classList.contains('over')), 'dropzone: disorot saat berkas diseret di atasnya');
  await dz.dispatchEvent('dragleave', { dataTransfer: dt });
  ok(!(await dz.evaluate((e) => e.classList.contains('over'))), 'dropzone: sorotan hilang saat berkas keluar');
  // Jenis salah ditolak
  dt = await mkDt('x.exe', 'application/octet-stream', 64);
  await dz.dispatchEvent('drop', { dataTransfer: dt });
  await a.waitForFunction(() => /tidak didukung/.test(document.body.textContent), null, { timeout: 3000 });
  ok((await a.inputValue('#contentForm [name=file]')) === '', 'dropzone: berkas dengan ekstensi salah ditolak dan tidak diunggah');
  // Unggah lewat seret-lepas dengan jaringan dibatasi supaya progres terlihat
  const cdp = await ctx.newCDPSession(a);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 400 * 1024 });
  dt = await mkDt('besar.png', 'image/png', 2 * 1024 * 1024);
  await dz.dispatchEvent('drop', { dataTransfer: dt });
  const seen = []; const metas = [];
  for (let i = 0; i < 80; i++) {
    const t = await a.locator('#fileStatus .prog-top b').textContent().catch(() => null);
    if (t) { seen.push(parseInt(t, 10)); metas.push(await a.locator('#fileStatus .prog-meta').textContent().catch(() => '')); }
    if (await a.locator('#fileStatus .pill.ok').count()) break;
    await sleep(150);
  }
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const distinct = [...new Set(seen)];
  ok(distinct.length >= 3 && distinct.every((v, i) => i === 0 || v >= distinct[i - 1]), 'progres unggah: persen naik bertahap (' + distinct.join(',') + ')');
  ok(metas.some((m) => /(KB|MB)\/dtk/.test(m)), 'progres unggah: kecepatan ditampilkan (' + (metas.find((m) => /dtk/.test(m)) || '') + ')');
  ok(await a.locator('#fileStatus .pill.ok').count() === 1 && !(await a.isDisabled('#contentSave')), 'unggah selesai: status Terunggah dan tombol Simpan aktif');
  await a.screenshot({ path: SHOTS + '/c-dropzone.png' });
  await a.click('#contentForm [data-close]');

  // Progres konversi video (butuh ffmpeg)
  if (spawnSync('ffmpeg', ['-version']).status === 0) {
    const clip = path.join(os.tmpdir(), 'long-' + process.pid + '.mp4');
    spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=duration=40:size=1920x1080:rate=30', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip]);
    await a.click('#addContent');
    await a.waitForSelector('#contentForm:visible');
    await a.selectOption('#ctype', 'video');
    await a.fill('#contentForm [name=title]', 'Video Panjang');
    await a.setInputFiles('#fileDz input[type=file]', clip);
    const pcts = []; let sawLabel = false;
    for (let i = 0; i < 400; i++) {
      const lab = await a.locator('#fileStatus .prog-top span').textContent().catch(() => '');
      if (/Mengonversi/.test(lab)) { sawLabel = true; const v = await a.locator('#fileStatus .prog-top b').textContent().catch(() => null); if (v) pcts.push(parseInt(v, 10)); }
      if (await a.locator('#fileStatus .pill.ok').count()) break;
      await sleep(100);
    }
    const dp = [...new Set(pcts)];
    ok(sawLabel && dp.length >= 2 && dp.every((v, i) => i === 0 || v >= dp[i - 1]), 'progres konversi: label "Mengonversi" dan persen naik (' + dp.join(',') + ')');
    ok(await a.locator('#fileStatus .pill.ok').count() === 1 && !(await a.isDisabled('#contentSave')), 'konversi selesai: Video siap dan Simpan aktif');
    await a.click('#contentForm [data-close]');
  }

  await browser.close();
  ok(errs.length === 0, 'tanpa error konsol atau pelanggaran CSP' + (errs.length ? ': ' + errs.slice(0, 4).join(' | ') : ''));
  console.log(`\nGagal: ${fails}`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('E2E GAGAL:', e.message); process.exit(1); });

async function txt(p, s) { return ((await p.textContent(s)) || '').replace(/\s+/g, ' ').trim(); }
