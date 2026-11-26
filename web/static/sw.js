// Service worker khusus notifikasi push. Tidak menyimpan cache apa pun.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    /* payload bukan JSON */
  }
  const called = d.kind === 'called';
  event.waitUntil(
    self.registration.showNotification(d.title || 'Papan Informasi', {
      body: d.body || '',
      tag: d.tag || 'papan',
      renotify: true,
      // Notifikasi "giliran tiba" tetap tampil sampai disentuh agar tidak terlewat.
      requireInteraction: called,
      vibrate: called ? [300, 150, 300, 150, 600] : [200],
      data: { url: d.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url === target && 'focus' in c) return c.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
