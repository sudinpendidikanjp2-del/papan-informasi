import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpDir, sleep } from './helpers.js';

process.env.DATA_DIR = tmpDir('queue-');
const { db, getSettings } = await import('../server/db.js');
const svc = await import('../server/service.js');

after(() => fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }));
const code = (fn) => { try { fn(); return null; } catch (e) { return e.code ?? e.message; } };
// Data awal: kategori A (id 1) dengan Meja 1 dan 2, kategori B (id 2) dengan Meja 3.

describe('penomoran dan urutan panggilan', () => {
  it('nomor berurut per kategori dengan prefix', () => {
    assert.equal(svc.createTicket(1).label, 'A-001');
    assert.equal(svc.createTicket(1).label, 'A-002');
    assert.equal(svc.createTicket(2).label, 'B-001');
  });
  it('tiket prioritas dilayani lebih dulu di kategorinya', () => {
    const p = svc.createTicket(1, { priority: true });
    assert.equal(p.label, 'A-003');
    assert.equal(p.ahead, 0);
    assert.equal(svc.callNext(1, null).label, 'A-003');
  });
  it('meja yang sedang melayani tidak bisa memanggil lagi (409)', () => {
    assert.equal(code(() => svc.callNext(1, null)), 409);
  });
  it('status berjalan: dipanggil, mulai layani, selesai', () => {
    assert.equal(svc.startServing(1).status, 'serving');
    assert.equal(code(() => svc.startServing(1)), 409); // sudah serving
    assert.equal(svc.finish(1).status, 'done');
    assert.equal(code(() => svc.finish(1)), 404); // tidak ada yang dipegang
  });
  it('lewati dan panggil ulang', () => {
    assert.equal(svc.callNext(1, null).label, 'A-001');
    assert.equal(svc.recall(1).label, 'A-001');
    assert.equal(svc.skip(1).status, 'skipped');
    assert.equal(svc.snapshot().counters.find((c) => c.id === 1).current, null);
  });
  it('tidak ada antrian: 404', () => {
    svc.callNext(1, null); // A-002
    svc.finish(1);
    assert.equal(code(() => svc.callNext(1, null)), 404);
  });
  it('antrian khusus meja dipanggil lebih dulu daripada antrian kategori', () => {
    svc.createTicket(1);                                   // A-004 (kategori)
    const d = svc.createTicketAtCounter(2, { dedicated: true }); // A-005 khusus Meja 2
    assert.equal(d.label, 'A-005');
    assert.equal(svc.callNext(2, null).label, 'A-005');
    svc.finish(2);
    assert.equal(svc.callNext(2, null).label, 'A-004');
    svc.finish(2);
  });
  it('Meja 1 tidak bisa mengambil antrian khusus Meja 2', () => {
    svc.createTicketAtCounter(2, { dedicated: true });     // A-006 khusus Meja 2
    assert.equal(code(() => svc.callNext(1, null)), 404);
    assert.equal(svc.callNext(2, null).label, 'A-006');
    svc.finish(2);
  });
  it('tanpa kategori pada meja tanpa kategori: ditolak', () => {
    db.prepare('INSERT INTO counters (name, category_id) VALUES (?, NULL)').run('Meja Lepas');
    const id = db.prepare("SELECT id FROM counters WHERE name = 'Meja Lepas'").get().id;
    assert.equal(code(() => svc.createTicketAtCounter(id, {})), 400);
  });
});

describe('perkiraan tunggu', () => {
  it('ahead dihitung dari tiket yang akan dipanggil lebih dulu, ETA muncul setelah ada data layanan', () => {
    const t1 = svc.createTicket(2); // B-002
    const t2 = svc.createTicket(2); // B-003
    assert.equal(t1.ahead, 1);      // B-001 menunggu di depannya
    assert.equal(t2.ahead, 2);
    assert.equal(svc.ticketStatus(t2.token).ahead, 2);
    // selesaikan satu layanan agar ada rata-rata durasi
    svc.callNext(3, null);
    db.prepare("UPDATE tickets SET called_at = ?, done_at = ? WHERE status = 'called' AND category_id = 2").run(Date.now() - 10 * 60000, Date.now());
    svc.finish(3);
    const st = svc.ticketStatus(t2.token);
    assert.equal(st.ahead, 1);
    assert.ok(st.etaMinutes >= 1, 'ETA harus muncul dari rata-rata durasi layanan');
  });
});

describe('pindah antrian', () => {
  let a, b;
  before(() => {
    db.prepare('DELETE FROM tickets').run();
    a = [svc.createTicket(1), svc.createTicket(1), svc.createTicket(1)];
    b = [svc.createTicket(2), svc.createTicket(2)];
  });

  it('ke meja lain: nomor tetap dan khusus meja tujuan', () => {
    svc.callNext(1, null); // A-001
    const r = svc.transfer(1, { toCounterId: 2 });
    assert.equal(r.kind, 'counter');
    assert.equal(svc.snapshot().counters.find((c) => c.id === 2).dedicatedWaiting[0].label, 'A-001');
    assert.equal(svc.callNext(2, null).label, 'A-001');
    svc.finish(2);
  });
  it('tidak bisa memindahkan ke meja sendiri (400), tanpa tujuan (404), atau tanpa antrian (404)', () => {
    svc.callNext(1, null); // A-002
    assert.equal(code(() => svc.transfer(1, { toCounterId: 1 })), 400);
    assert.equal(code(() => svc.transfer(1, {})), 404);
    assert.equal(code(() => svc.transfer(1, { toCategoryId: 999 })), 404);
    svc.skip(1);
    assert.equal(code(() => svc.transfer(1, { toCategoryId: 2 })), 404);
  });
  it('ke kategori lain: nomor baru, token tetap, waktu ambil dipertahankan, dipanggil menurut waktu datang', () => {
    svc.callNext(1, null); // A-003
    const token = a[2].token;
    const created = db.prepare('SELECT created_at FROM tickets WHERE token = ?').get(token).created_at;
    const r = svc.transfer(1, { toCategoryId: 2 });
    assert.equal(r.kind, 'category');
    assert.equal(r.prevLabel, 'A-003');
    assert.match(r.label, /^B-\d{3}$/);
    const st = svc.ticketStatus(token);
    assert.equal(st.label, r.label);
    assert.equal(st.status, 'waiting');
    assert.equal(st.prevLabel, 'A-003');
    assert.equal(st.categoryName, 'Administrasi');
    assert.equal(db.prepare('SELECT created_at FROM tickets WHERE token = ?').get(token).created_at, created);
    assert.equal(svc.snapshot().counters.find((c) => c.id === 1).current, null, 'Meja asal bebas');
    // tiket pindahan dibuat lebih dulu daripada B-001/B-002, jadi dipanggil lebih dulu menurut waktu datang
    assert.equal(svc.callNext(3, null).label, r.label);
    svc.finish(3);
  });
  it('"dahulukan" memberi prioritas dan mendahului antrian biasa', () => {
    const x = svc.createTicket(1);
    svc.callNext(1, null);
    const r = svc.transfer(1, { toCategoryId: 2, priority: true });
    assert.equal(db.prepare('SELECT priority FROM tickets WHERE token = ?').get(x.token).priority, 1);
    svc.createTicket(2); // tiket biasa yang datang belakangan
    assert.equal(svc.callNext(3, null).label, r.label);
    svc.finish(3);
  });
  it('kategori yang sama = kembalikan ke antrian: nomor tetap, tidak lagi khusus meja', () => {
    const x = svc.createTicketAtCounter(1, { dedicated: true });
    svc.callNext(1, null);
    const r = svc.transfer(1, { toCategoryId: 1 });
    assert.equal(r.prevLabel, null);
    assert.equal(r.label, x.label);
    assert.equal(db.prepare('SELECT counter_id FROM tickets WHERE token = ?').get(x.token).counter_id, null);
    svc.callNext(2, null);
    svc.finish(2);
  });
  it('tidak ada nomor ganda per kategori per hari setelah semua pemindahan', () => {
    const dup = db.prepare('SELECT category_id, day, number, COUNT(*) c FROM tickets GROUP BY category_id, day, number HAVING c > 1').all();
    assert.equal(dup.length, 0);
  });
});

describe('layar: filter antrian dan konten', () => {
  before(() => {
    svc.saveScreen(null, { slug: 'lobi', name: 'Lobi', categoryIds: [1] });
    svc.saveScreen(null, { slug: 'layar-b', name: 'Layar B', categoryIds: [2] });
    svc.createContent({ type: 'text', title: 'Khusus B', body: 'x', duration: 10, screens: [2] });
    svc.createContent({ type: 'text', title: 'Bersama', body: 'x', duration: 10 });
  });
  it('snapshot hanya memuat kategori dan meja milik layar', () => {
    const lobi = svc.snapshot('lobi');
    assert.deepEqual(lobi.categories.map((c) => c.prefix), ['A']);
    assert.deepEqual(lobi.counters.map((c) => c.name), ['Meja 1', 'Meja 2']);
    assert.deepEqual(svc.snapshot('layar-b').counters.map((c) => c.name), ['Meja 3']);
    assert.equal(svc.snapshot().categories.length, 2);
  });
  it('playlist: konten khusus hanya di layarnya, tanpa slug hanya konten bersama', () => {
    const titles = (slug) => svc.playlist(slug).main.map((x) => x.title);
    assert.ok(titles('layar-b').includes('Khusus B'));
    assert.ok(!titles('lobi').includes('Khusus B'));
    assert.ok(!titles(null).includes('Khusus B'));
    assert.ok(titles(null).includes('Bersama'));
  });
  it('slug tidak dikenal = 404; slug tidak valid = 400', () => {
    assert.equal(code(() => svc.snapshot('hantu')), 404);
    assert.equal(code(() => svc.saveScreen(null, { slug: 'Tidak Valid', name: 'x' })), 400);
  });
  it('aktivitas screensaver per layar hanya dipengaruhi kategorinya', async () => {
    const l1 = svc.snapshot('lobi').lastActivity;
    await sleep(15);
    svc.createTicket(2);
    assert.equal(svc.snapshot('lobi').lastActivity, l1);
    assert.ok(svc.snapshot('layar-b').lastActivity > l1);
  });
});

describe('validasi data', () => {
  it('prefix kategori hanya huruf/angka 1-3 karakter, dijadikan huruf besar', () => {
    assert.equal(code(() => svc.saveCategory(null, { name: 'X', prefix: '<s>' })), 400);
    assert.equal(code(() => svc.saveCategory(null, { name: 'X', prefix: 'ABCD' })), 400);
    svc.saveCategory(null, { name: 'Uji', prefix: 'a1' });
    assert.ok(svc.listAdminCategories().some((c) => c.prefix === 'A1'));
    assert.equal(code(() => svc.saveCategory(null, { name: 'Dup', prefix: 'A1' })), 409);
  });
  it('nama berkas konten harus hasil unggahan dan cocok dengan jenisnya', () => {
    const good = 'a'.repeat(20) + '.png';
    assert.equal(code(() => svc.createContent({ type: 'image', file: '../../etc/passwd', duration: 5 })), 400);
    assert.equal(code(() => svc.createContent({ type: 'image', file: 'a'.repeat(20) + '.pdf', duration: 5 })), 400);
    assert.equal(code(() => svc.createContent({ type: 'pdf', file: good, duration: 5 })), 400);
    assert.ok(svc.createContent({ type: 'image', file: good, duration: 5 }).id);
  });
  it('logo harus berkas unggahan; zona waktu harus dikenal', () => {
    assert.equal(code(() => svc.saveSettings({ org_logo: 'javascript:alert(1)' })), 400);
    assert.equal(code(() => svc.saveSettings({ org_logo: 'https://evil.example/x.png' })), 400);
    svc.saveSettings({ org_logo: '/uploads/' + 'b'.repeat(20) + '.png' });
    assert.equal(code(() => svc.saveSettings({ timezone: 'Mars/Phobos' })), 400);
    assert.equal(getSettings().timezone, 'Asia/Jakarta');
    assert.doesNotThrow(() => svc.snapshot()); // API tetap sehat
  });
  it('riwayat pegawai hanya memuat antrian yang ia layani', () => {
    db.prepare("INSERT INTO users (username, name, password_hash, role) VALUES ('uji', 'Uji', 'x', 'staff')").run();
    const uid = db.prepare("SELECT id FROM users WHERE username = 'uji'").get().id;
    svc.createTicket(2);
    svc.callNext(3, uid);
    svc.finish(3);
    const h = svc.historyFor(uid);
    assert.equal(h.length, 1);
    assert.equal(h[0].status, 'done');
  });
});
