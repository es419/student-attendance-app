const CACHE_NAME = 'attendance-shell-2.0.1-b23';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css?v=2.0.1-b23',
  './professional.css?v=2.0.1-b23',
  './release.js?v=2.0.1-b23',
  './records.js?v=2.0.1-b23',
  './report.js?v=2.0.1-b23',
  './enhancements.js?v=2.0.1-b23',
  './updates.js?v=2.0.1-b23',
  './calc.js?v=attendance-calc-v10',
  './app.js?v=2.0.1-b23',
  './planner.js?v=2',
  './planner-ui.js?v=2.0.1-b23',
  './vendor/supabase.js',
  './manifest.json',
  './fonts/heebo-hebrew.woff2',
  './fonts/heebo-latin.woff2',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-header-copper.png',
  './icon-header-teal.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache=await caches.open(CACHE_NAME);
    const results=await Promise.allSettled(APP_SHELL.map(async path=>{
      const response=await fetch(path,{cache:'reload'});
      if(!response.ok)throw new Error('Precache failed: '+path);
      await cache.put(path,response);
    }));
    if(results.some(r=>r.status==='rejected')){await caches.delete(CACHE_NAME);throw new Error('Incomplete app release');}
    // An upgrade waits here until a user explicitly chooses Install.
  })());
});
self.addEventListener('message',event=>{
  if(event.data?.type==='SKIP_WAITING')event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const old=(await caches.keys()).filter(k=>k.startsWith('attendance-shell-')&&k!==CACHE_NAME);
    // Two earlier shells support tabs that have not yet accepted the update.
    await Promise.all(old.slice(0,-2).map(k=>caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);if(url.origin!==self.location.origin)return;
  if(url.pathname.endsWith('/release.json')){event.respondWith(fetch(event.request,{cache:'no-store'}));return;}
  if(event.request.mode==='navigate'){
    event.respondWith(navigationCacheFirst());return;
  }
  event.respondWith(cachedAsset(event.request));
});
async function navigationCacheFirst(refreshPromise){
  const cache=await caches.open(CACHE_NAME),cached=await cache.match('./index.html');
  if(cached)return cached;
  let fresh;
  try{fresh=refreshPromise?await refreshPromise:await fetch('./index.html',{cache:'no-store'});}catch{return Response.error();}
  return fresh&&fresh.ok?fresh:Response.error();
}
async function cachedAsset(request){
  const cache=await caches.open(CACHE_NAME);
  const cached=await cache.match(request)||await caches.match(request);
  if(cached)return cached;
  try{return await fetch(request);}catch{return Response.error();}
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
