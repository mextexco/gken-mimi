/* オフラインでも開けるように、アプリ本体をキャッシュする(音声はIndexedDBに保存) */
var V = 'gken-v2';
var ASSETS = ['./', 'index.html', 'css/app.css', 'js/data.js', 'js/quiz.js', 'js/app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png'];
self.addEventListener('install', function(e){
  e.waitUntil(caches.open(V).then(function(c){ return c.addAll(ASSETS); }).then(function(){ return self.skipWaiting(); }));
});
self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(ks){ return Promise.all(ks.filter(function(k){ return k !== V; }).map(function(k){ return caches.delete(k); })); }).then(function(){ return self.clients.claim(); }));
});
/* キャッシュをすぐ返し、裏で最新版を取りに行く */
self.addEventListener('fetch', function(e){
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(caches.open(V).then(function(c){
    return c.match(req, { ignoreSearch:true }).then(function(hit){
      var net = fetch(req).then(function(res){ if (res && res.ok) c.put(req, res.clone()); return res; }).catch(function(){ return hit; });
      return hit || net;
    });
  }));
});
