// 쌍정 일정함 서비스워커 — 화면 캐시(오프라인에서도 열림) + 푸시 알림 표시
const CACHE = 'sj-v1';
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/', '/manifest.webmanifest', '/icon-192.png']))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  // 화면은 새 버전 우선, 안 되면 저장본
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request).then(r => r || caches.match('/'))));
});
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch { d = { title: '쌍정 일정함', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || '쌍정 일정함', { body: d.body || '', tag: d.tag, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: d.url || '/' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    for (const w of ws) if ('focus' in w) { w.navigate(url); return w.focus(); }
    return clients.openWindow(url);
  }));
});
