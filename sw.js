const CACHE_NAME = 'attendance-shell-v9';
const SUPABASE_LIB = 'https://unpkg.com/@supabase/supabase-js@2.109.0/dist/umd/supabase.js';

const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
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
    await cache.addAll(APP_SHELL);

    // Warm the exact Supabase browser bundle too. A CDN failure must never block
    // installation of the app shell, so this cache fill is best-effort.
    try{
      const response = await fetch(SUPABASE_LIB, { cache: 'reload' });
      if(response.ok || response.type === 'opaque'){
        await cache.put(SUPABASE_LIB, response.clone());
      }
    }catch(error){
      console.warn('Supabase bundle could not be pre-cached', error);
    }

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

  // Keep the pinned Supabase runtime available locally after the first successful
  // install/fetch. Because the URL is version-pinned, cache-first is safe here.
  if(url.href === SUPABASE_LIB){
    event.respondWith(cacheFirstExternal(event.request));
    return;
  }

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
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match('./index.html');
  if(cached) return cached;
  return (await refreshPromise) || Response.error();
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

async function cacheFirstExternal(request){
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if(cached) return cached;

  try{
    const response = await fetch(request);
    if(response.ok || response.type === 'opaque'){
      await cache.put(request, response.clone());
    }
    return response;
  }catch{
    return Response.error();
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
