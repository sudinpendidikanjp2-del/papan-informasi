import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpDir, sleep } from './helpers.js';

process.env.DATA_DIR = tmpDir('notify-');
const { db, getSettings, getSecret } = await import('../server/db.js');
const svc = await import('../server/service.js');
const notify = await import('../server/notify.js');

const sent = [];
let failWith = null;
notify.setSender(async (sub, payload) => {
  if (failWith) { const e = new Error('gagal'); e.statusCode = failWith; throw e; }
  sent.push({ endpoint: sub.endpoint, ...JSON.parse(payload) });
});
notify.init();

after(() => fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

const keys = { p256dh: 'BP' + 'x'.repeat(86), auth: 'a'.repeat(22) };
const sub = (n) => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/dev' + n, keys });
const code = (fn) => { try { fn(); return null; } catch (e) { return e.code ?? e.message; } };
const subCount = () => db.prepare('SELECT COUNT(*) n FROM push_subscriptions').get().n;
const kinds = (k) => sent.filter((s) => s.kind === k);

describe('kunci VAPID', () => {
  it('dibuat saat init dan stabil setelah init kedua', () => {
    const pub = notify.pushConfig().publicKey;
    assert.ok(pub.length > 40);
    notify.init();
    assert.equal(notify.pushConfig().publicKey, pub);
  });
  it('kunci privat tidak ada di settings publik', () => {
    assert.ok(!Object.keys(getSettings()).some((k) => k.startsWith('vapid')));
    assert.ok(getSecret('vapid_private'));
  });
});

describe('validasi langganan', () => {
  const tickets = [];
  before(() => { for (let i = 0; i < 5; i++) tickets.push(svc.createTicket(1)); });
  const subscribe = (endpoint, k = keys) => code(() => notify.subscribe(tickets[4].token, { endpoint, keys: k }));

  for (const [name, endpoint] of Object.entries({
    'endpoint http': 'http://fcm.googleapis.com/x',
    'localhost': 'https://localhost/x',
    'alamat metadata internal': 'https://169.254.169.254/latest',
    'host tiruan fcm.googleapis.com.evil.example': 'https://fcm.googleapis.com.evil.example/x',
    'host asing dengan nama push di query': 'https://evil.example/x?h=fcm.googleapis.com',
  })) {
    it(`menolak ${name} (SSRF)`, () => assert.equal(subscribe(endpoint), 400));
  }
  it('menolak kunci yang bukan string', () => assert.equal(subscribe(sub(0).endpoint, { p256dh: 1, auth: 2 }), 400));
  it('404 untuk tiket tak dikenal', () => assert.equal(code(() => notify.subscribe('0'.repeat(24), sub(0))), 404));
  it('menerima FCM dan Firefox yang sah, tanpa duplikasi', () => {
    assert.ok(notify.subscribe(tickets[4].token, sub(1)).ok);
    assert.ok(notify.subscribe(tickets[4].token, { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/x', keys }).ok);
    notify.subscribe(tickets[4].token, sub(1));
    assert.equal(subCount(), 2);
  });
  it('menolak perangkat ke-6 untuk satu tiket', () => {
    for (const n of [2, 3, 4]) notify.subscribe(tickets[4].token, sub(n));
    assert.equal(subscribe(sub(5).endpoint), 409);
  });
});

describe('pemicu notifikasi', () => {
  let tk;
  before(async () => {
    db.prepare('DELETE FROM push_subscriptions').run();
    sent.length = 0;
    // 5 tiket baru di kategori B (tidak terpengaruh tiket kategori A di atas)
    tk = [];
    for (let i = 0; i < 5; i++) tk.push(svc.createTicket(2));
    notify.subscribe(tk[4].token, sub(1));
    await notify.checkNear();
  });

  it('belum ada push saat 4 antrian di depan (ambang 3)', () => assert.equal(sent.length, 0));
  it('"hampir giliran" terkirim sekali saat tersisa 3 di depan', async () => {
    svc.callNext(3, null); // Meja 3 melayani kategori B
    await sleep(600);
    assert.equal(kinds('near').length, 1);
    const n = kinds('near')[0];
    assert.match(n.body, /B-005/);
    assert.match(n.body, /3 antrian lagi/);
    assert.equal(n.url, '/antrian/' + tk[4].token);
  });
  it('tidak ada push "hampir giliran" ganda', async () => {
    svc.finish(3); svc.callNext(3, null);
    await sleep(600);
    assert.equal(kinds('near').length, 1);
  });
  it('"giliran Anda tiba" terkirim ke tiket yang dipanggil, dengan nama meja', async () => {
    for (let i = 0; i < 3; i++) { svc.finish(3); svc.callNext(3, null); }
    await sleep(600);
    const called = kinds('called');
    assert.equal(called.length, 1);
    assert.match(called[0].body, /B-005/);
    assert.match(called[0].body, /Meja 3/);
    const st = svc.ticketStatus(tk[4].token);
    assert.equal(st.status, 'serving');
    assert.equal(st.counter, 'Meja 3');
  });
  it('panggil ulang mengirim push lagi', async () => {
    svc.recall(3);
    await sleep(300);
    assert.equal(kinds('called').length, 2);
  });
  it('langganan dibersihkan setelah tiket selesai, dan tiket selesai tidak bisa berlangganan', async () => {
    svc.finish(3);
    await sleep(600);
    assert.equal(subCount(), 0);
    assert.equal(code(() => notify.subscribe(tk[4].token, sub(9))), 409);
  });
});

describe('galat dari layanan push', () => {
  it('respons 410 menghapus langganan', async () => {
    const t = svc.createTicket(2);
    notify.subscribe(t.token, sub(20));
    failWith = 410;
    svc.callNext(3, null);
    await sleep(500);
    failWith = null;
    assert.equal(subCount(), 0);
    svc.finish(3);
  });
  it('galat sementara (500) tidak menghapus langganan', async () => {
    const t = svc.createTicket(2);
    notify.subscribe(t.token, sub(21));
    failWith = 500;
    svc.callNext(3, null);
    await sleep(500);
    failWith = null;
    assert.equal(subCount(), 1);
  });
  it('admin mematikan push: langganan ditolak dan tidak ada pengiriman', async () => {
    svc.saveSettings({ push_enabled: '0' });
    const t = svc.createTicket(2);
    assert.equal(code(() => notify.subscribe(t.token, sub(22))), 403);
    const before = sent.length;
    svc.finish(3);
    svc.callNext(3, null);
    await sleep(500);
    assert.equal(sent.length, before);
    svc.saveSettings({ push_enabled: '1' });
  });
});

describe('pengaturan notifikasi dan QR', () => {
  it('URL dasar tidak valid ditolak dan tidak ada pengaturan lain yang ikut tersimpan', () => {
    const e = code(() => svc.saveSettings({ org_name: 'TIDAK BOLEH TERSIMPAN', public_base_url: 'javascript:alert(1)' }));
    assert.equal(e, 400);
    assert.notEqual(getSettings().org_name, 'TIDAK BOLEH TERSIMPAN');
    assert.equal(code(() => svc.saveSettings({ public_base_url: 'ftp://x' })), 400);
  });
  it('URL dasar dirapikan dan notify_ahead dibatasi 1-20', () => {
    svc.saveSettings({ public_base_url: 'http://192.168.1.10:3000///', notify_ahead: '99' });
    assert.equal(getSettings().public_base_url, 'http://192.168.1.10:3000');
    assert.equal(getSettings().notify_ahead, '20');
  });
  it('trackUrl memakai pengaturan admin, atau alamat kiosk bila kosong', () => {
    assert.equal(notify.trackUrl('abc', 'http://fallback'), 'http://192.168.1.10:3000/antrian/abc');
    svc.saveSettings({ public_base_url: '' });
    assert.equal(notify.trackUrl('abc', 'http://kiosk.local:3000'), 'http://kiosk.local:3000/antrian/abc');
  });
  it('QR berupa SVG yang dapat diskalakan', () => {
    const svg = notify.qrSvg('http://x/antrian/abc');
    assert.ok(svg.startsWith('<svg') && svg.includes('viewBox'));
  });
  it('tiket hari lain ditandai expired, token tak dikenal = 404', () => {
    const t = svc.createTicket(1);
    db.prepare("UPDATE tickets SET day = '2000-01-01' WHERE id = ?").run(t.id);
    assert.equal(svc.ticketStatus(t.token).expired, true);
    assert.equal(code(() => svc.ticketStatus('zzz')), 404);
  });
});
