// Service worker: офлайн-кэш + всегда свежий код.
// Код (HTML/JS/CSS) грузится network-first: при наличии сети — последняя версия,
// кэш используется как офлайн-резерв. Картинки/JSON — cache-first.
// При изменении файлов поднимите версию кэша.
const CACHE = 'telo-v3';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './sample-week.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache:'reload' — берём из сети, минуя HTTP-кэш, чтобы не закэшировать старое
    await Promise.all(ASSETS.map(async (u) => {
      try { const res = await fetch(u, { cache: 'reload' }); if (res && res.ok) await cache.put(u, res); } catch (err) {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isShell(url) {
  return /\.(?:html|js|css|webmanifest)$/.test(url.pathname) || url.pathname.endsWith('/');
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Код и навигация — network-first.
  if (req.mode === 'navigate' || isShell(url)) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok) { const c = await caches.open(CACHE); c.put(req, res.clone()); }
        return res;
      } catch (err) {
        const cached = await caches.match(req);
        return cached || (await caches.match('./index.html')) || (await caches.match('./'));
      }
    })());
    return;
  }

  // Картинки/JSON — cache-first + фоновое обновление.
  e.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') { caches.open(CACHE).then((c) => c.put(req, res.clone())); }
      return res;
    }).catch(() => cached);
    return cached || network;
  })());
});
