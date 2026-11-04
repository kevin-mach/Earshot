// App-shell cache so Earshot opens instantly and works as an installed app.
// Network-first, so a new deploy is picked up on the next load.
const CACHE = 'earshot-v1';
const SHELL = ['./', 'index.html', 'src/styles.css', 'src/app.js', 'src/format.js', 'src/recognizer.js', 'src/storage.js', 'icons/icon.svg', 'manifest.webmanifest'];

self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request))
  );
});
