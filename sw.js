const CACHE_NAME = 'attendance-shell-v8';
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
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if(event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if(url.origin !== self.location.origin) return;

  if(event.request.mode === 'navigate'){
    event.respondWith(networkFirst(event.request, './index.html'));
    return;
  }

  event.respondWith(staleWhileRevalidate(event.request));
});

async function networkFirst(request, fallbackKey){
  try{
    const response = await fetch(request);
    if(response.ok){
      const cache = await caches.open(CACHE_NAME);
      cache.put(fallbackKey, response.clone());
    }
    return response;
  }catch{
    return (await caches.match(fallbackKey)) || Response.error();
  }
}

async function staleWhileRevalidate(request){
  const cached = await caches.match(request);
  const fresh = fetch(request)
    .then(async (response) => {
      if(response.ok){
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  return cached || (await fresh) || Response.error();
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
