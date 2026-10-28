// Keeps ImadeIt working with no internet. Bump VERSION whenever any app file changes
// so installed copies pick up the new version the next time they open.
const VERSION = 'imadeit-v1.4.0';
const FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './db.js',
  './images.js',
  './autocomplete.js',
  './yarn-catalog.js',
  './rustic-patterns.js',
  './csv.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(request).catch(() =>
        request.mode === 'navigate' ? caches.match('./index.html') : Response.error());
    }),
  );
});
