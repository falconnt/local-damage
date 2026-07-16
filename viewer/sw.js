// Local Damage service worker — maakt de app installeerbaar en (na eerste
// bezoek) offline bruikbaar. Strategie: network-first met cache-fallback,
// zodat updates altijd voorrang krijgen maar de app zonder netwerk blijft werken.
const CACHE = 'local-damage-v4';

const SHELL = [
  './',
  './index.html',
  './main.js',
  './game/stickman.js',
  './game/race.js',
  './manifest.webmanifest',
  './palettes/palettes.json',
  './vendor/three/three.module.js',
  './vendor/three/examples/jsm/loaders/GLTFLoader.js',
  './vendor/three/examples/jsm/utils/BufferGeometryUtils.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || !request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        // gelukte responses (ook de GLB-tiles) in de runtime-cache bijwerken
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true }))
  );
});
