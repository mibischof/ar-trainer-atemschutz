// Offline-Fähigkeit: Beim ersten Öffnen werden alle Dateien gespeichert.
// Online wird immer zuerst die neueste Version geladen, offline die gespeicherte.
const CACHE = 'ar-trainer-v4';
const FILES = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'audio.js',
  'hud.js',
  'markers.js',
  'render.js',
  'scenario.js',
  'sensors.js',
  'settings.js',
  'tracker.js',
  'tracker-worker.js',
  'marker.html',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'vendor/three.module.min.js',
  'vendor/cv.js',
  'vendor/aruco.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html'))),
  );
});
