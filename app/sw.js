// Keeps the app's own files on the phone so it opens with no connection. Songs aren't here: they're in
// IndexedDB (see app.js). Bump VERSION with every change to these files so phones pick up the new ones.
const VERSION = 'mishmusic-1';
const FILES = ['./', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'icon-180.png', 'icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name !== VERSION) await caches.delete(name);
    await self.clients.claim();
  })());
});

// The app's files: the network first (so an update shows at once when online), the saved copy when offline.
// Anything else (the backend) isn't touched.
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || !url.pathname.startsWith(new URL('./', location).pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const fresh = await fetch(event.request, { cache: 'no-store' });
      if (fresh.ok) cache.put(event.request, fresh.clone());
      return fresh;
    } catch {
      return (await cache.match(event.request, { ignoreSearch: true })) || (await cache.match('index.html')) || Response.error();
    }
  })());
});
