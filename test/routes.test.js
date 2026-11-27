import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer } from './helpers.js';

// Jalur halaman tanpa ekstensi, pengalihan dari alamat lama, dan cache aset hasil build.
describe('jalur halaman bersih', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.stop(); fs.rmSync(srv.dataDir, { recursive: true, force: true }); });

  const get = (p) => fetch(srv.base + p, { redirect: 'manual' });

  it('halaman utama dilayani tanpa ekstensi sebagai HTML', async () => {
    for (const p of ['/', '/kiosk', '/operator', '/admin', '/layar/lobi', '/antrian/abc123def']) {
      const r = await get(p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-type'), /text\/html/, p);
      assert.equal(r.headers.get('cache-control'), 'no-cache', p);
    }
  });

  it('garis miring penutup diperlakukan sama', async () => {
    assert.equal((await get('/admin/')).status, 200);
    assert.equal((await get('/layar/lobi/')).status, 200);
  });

  it('alamat lama dialihkan 301 ke jalur baru dengan parameter lain dipertahankan', async () => {
    const cases = {
      '/display.html': '/',
      '/display.html?screen=lobi&sound=on': '/layar/lobi?sound=on',
      '/?screen=Lobi': '/layar/lobi',
      '/?screen=lobi&sound=on': '/layar/lobi?sound=on',
      '/kiosk.html': '/kiosk',
      '/operator.html': '/operator',
      '/admin.html': '/admin',
      '/t.html?k=ABCdef123456': '/antrian/abcdef123456',
      '/t.html': '/',
    };
    for (const [from, to] of Object.entries(cases)) {
      const r = await get(from);
      assert.equal(r.status, 301, from);
      assert.equal(r.headers.get('location'), to, from);
    }
  });

  it('berkas .html mentah tidak disajikan dan slug/token tak valid ditolak', async () => {
    assert.equal((await get('/antrian.html')).status, 404);
    assert.ok([403, 404].includes((await get('/layar/..%2f..')).status));
    assert.equal((await get('/layar/a%20b')).status, 404);
    assert.equal((await get('/antrian/' + 'a'.repeat(101))).status, 404);
    assert.equal((await get('/layar')).status, 404);
  });

  it('aset ber-hash di /assets disajikan immutable dan bertipe JavaScript/CSS', async () => {
    const html = await (await get('/')).text();
    const js = html.match(/src="(\/assets\/[^"]+\.js)"/)[1];
    const css = html.match(/href="(\/assets\/[^"]+\.css)"/)[1];
    const rj = await get(js);
    assert.equal(rj.status, 200);
    assert.match(rj.headers.get('content-type'), /javascript/);
    assert.match(rj.headers.get('cache-control'), /immutable/);
    const rc = await get(css);
    assert.match(rc.headers.get('content-type'), /text\/css/);
  });

  it('service worker tetap di /sw.js', async () => {
    const r = await get('/sw.js');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /javascript/);
  });
});
