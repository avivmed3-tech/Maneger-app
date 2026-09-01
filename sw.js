const CACHE='omniview-v33';
const ASSETS=['./','./index.html','./manifest.json','./app-icon-192.png','./app-icon-512.png','./app-icon-maskable-512.png'];

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  // Only this app's own files are cached; everything else goes straight to the
  // network. In practice "everything else" is the Supabase REST traffic.
  //
  // This handler used to cache every GET there was. One full read of the progress
  // table is ~56 responses of a few hundred KB, and each of them was cloned and
  // written into Cache Storage on the way past. Worse, the incremental log queries
  // carry a moving timestamp in the URL, so every sweep minted cache entries under
  // brand-new keys that nothing would ever ask for again — a cache that only grew,
  // on devices that do not have the room for it, holding stale copies of API
  // answers that must never be served stale anyway.
  let url;
  try{url=new URL(e.request.url)}catch{return}
  if(url.origin!==self.location.origin)return;
  e.respondWith(
    fetch(e.request).then(r=>{
      const clone=r.clone();
      caches.open(CACHE).then(c=>c.put(e.request,clone)).catch(()=>{});
      return r;
    }).catch(()=>caches.match(e.request))
  );
});

self.addEventListener('message',e=>{
  if(e.data&&e.data.type==='SKIP_WAITING')self.skipWaiting();
  if(e.data&&e.data.type==='NOTIFY'){
    self.registration.showNotification(e.data.title,{
      body:e.data.body,
      icon:'./app-icon-192.png',
      badge:'./app-icon-192.png',
      tag:e.data.tag||'omniview-notify',
      renotify:true,
      data:{url:e.data.url||'/'}
    });
  }
});

self.addEventListener('notificationclick',e=>{
  e.notification.close();
  e.waitUntil(clients.matchAll({type:'window'}).then(cs=>{
    if(cs.length>0){cs[0].focus();return}
    return clients.openWindow(e.notification.data?.url||'/');
  }));
});
