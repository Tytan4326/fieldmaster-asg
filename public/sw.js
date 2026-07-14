const CACHE='fieldmaster-shell-v22';
const SHELL=['/','/index.html','/admin.html','/staff.html','/styles.css?v=16','/app.js?v=21','/geo.js?v=1','/vendor/leaflet/leaflet.css','/vendor/leaflet/leaflet.js','/manifest.webmanifest','/admin.webmanifest','/staff.webmanifest','/icon.svg','/icon-player-192.png','/icon-player-512.png','/icon-staff-192.png','/icon-staff-512.png','/icon-admin-192.png','/icon-admin-512.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);
  if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/socket.io/'))return;
  if(event.request.mode==='navigate')event.respondWith(fetch(event.request).catch(()=>caches.match(new URL(event.request.url).pathname).then(response=>response||caches.match('/index.html'))));
  else event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request).then(response=>{const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy));return response;})));
});
self.addEventListener('message',event=>{if(event.data?.type!=='SHOW_NOTIFICATION')return;event.waitUntil(self.registration.showNotification(event.data.title||'Fieldmaster',{body:event.data.body||'',icon:'/icon-player-192.png',badge:'/icon-player-192.png',tag:'fieldmaster-field-mode',renotify:false}));});
self.addEventListener('sync',event=>{if(event.tag!=='fieldmaster-sync')return;event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(clients=>Promise.all(clients.map(client=>client.postMessage({type:'BACKGROUND_SYNC'})))));});
self.addEventListener('notificationclick',event=>{event.notification.close();event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(clients=>clients[0]?.focus()||self.clients.openWindow('/?view=player')));});
