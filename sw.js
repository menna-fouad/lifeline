// Saves every app file on first visit so LIFELINE opens and runs in airplane mode.
const CACHE = 'lifeline-v36';
const FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'src/mesh.js',
  'src/sound.js',
  'src/watch.js',
  'src/app.js',
  'styles/style.css',
  'vendor/ggwave.js',
  'vendor/scene3d.js',
  'assets/icon-192.png',
  'assets/icon-512.png',
  'assets/fonts/instrument-sans.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== TILES).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Map tiles are saved as they load, so an area seen once online still shows offline.
const TILES = 'lifeline-tiles';
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (event.request.url.includes('basemaps.cartocdn.com')) {
    event.respondWith(caches.open(TILES).then((c) => c.match(event.request).then((hit) => hit || fetch(event.request).then((res) => {
      if (res.ok || res.type === 'opaque') c.put(event.request, res.clone());
      return res;
    }))));
    return;
  }
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((hit) => hit || fetch(event.request))
  );
});
