const CACHE_NAME = 'attendance-shell-v29';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css?v=attendance-redesign-v11',
  './calc.js?v=attendance-redesign-v9',
  './app.js?v=attendance-redesign-v11',
  './vendor/supabase.js',
  './manifest.json',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-header-copper.png',
  './icon-header-teal.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // The local shell is required for an offline/instant repeat launch.
    // cache:'reload' skips the browser HTTP cache (GitHub Pages sends max-age),
    // otherwise a fresh worker could precache the previous deploy's files.
    await Promise.all(APP_SHELL.map(async (path) => {
      const response = await fetch(path, { cache: 'reload' });
      if(!response.ok) throw new Error('Precache failed: ' + path);
      await cache.put(path, response);
    }));

    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith('attendance-shell-') && key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if(event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  if(url.origin !== self.location.origin) return;

  if(event.request.mode === 'navigate'){
    // Start the refresh while the fetch event is still being dispatched so the
    // browser keeps the worker alive for the background update.
    const refreshPromise = refreshNavigation(event.request);
    event.waitUntil(refreshPromise.then(() => undefined));
    event.respondWith(navigationCacheFirst(refreshPromise));
    return;
  }

  // CSS/JS/icons return from cache immediately and refresh silently for the next
  // request. The cache-version bump guarantees a clean shell on deployments.
  const refreshPromise = refreshAsset(event.request);
  event.waitUntil(refreshPromise.then(() => undefined));
  event.respondWith(staleWhileRevalidate(event.request, refreshPromise));
});

async function navigationCacheFirst(refreshPromise){
  // Prefer the latest app shell whenever online; use cache only if the network is unavailable.
  const fresh = await refreshPromise;
  if(fresh) return fresh;
  const cache = await caches.open(CACHE_NAME);
  return (await cache.match('./index.html')) || Response.error();
}

async function refreshNavigation(request){
  try{
    const response = await fetch(request, { cache: 'no-store' });
    if(response.ok){
      const cache = await caches.open(CACHE_NAME);
      await cache.put('./index.html', response.clone());
    }
    return response;
  }catch{
    return null;
  }
}

async function refreshAsset(request){
  try{
    const response = await fetch(request);
    if(response.ok){
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  }catch{
    return null;
  }
}

async function staleWhileRevalidate(request, refreshPromise){
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  return cached || (await refreshPromise) || Response.error();
}

self.addEventListener('push', (event) => {
  let data = { title: 'נוכחות+', body: 'תזכורת' };
  try{
    if(event.data) data = event.data.json();
  }catch{}

  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    dir: 'rtl',
    lang: 'he',
    tag: 'break-reminder',
    renotify: true
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const openClient = clients.find((client) => 'focus' in client);
      return openClient ? openClient.focus() : self.clients.openWindow('./');
    })
  );
});
