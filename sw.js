// SafeScan service worker: يخزّن ملفات التطبيق ليفتح بدون إنترنت.
// عند تحديث ملفات التطبيق غيّر رقم الإصدار هنا (v1 -> v2).
const V = 'safescan-v1';
const CORE = ['./', 'index.html', 'app.js', 'config.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
const LIBS = ['www.gstatic.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  const same = u.origin === location.origin;
  if (!same && !LIBS.includes(u.hostname)) return; // بيانات Firestore لها تخزينها الخاص
  e.respondWith(
    fetch(r)
      .then((res) => {
        if (res && (res.ok || res.type === 'opaque')) {
          const cp = res.clone();
          caches.open(V).then((c) => c.put(r, cp));
        }
        return res;
      })
      .catch(() =>
        caches.match(r, same ? { ignoreSearch: true } : undefined).then(
          (m) => m || (r.mode === 'navigate' ? caches.match('index.html') : Response.error())
        )
      )
  );
});
