const CACHE='seukku-v4';   /* ★ v3 → v4 로 올림: activate에서 깨진 HTML 들어있던 옛 캐시를 통째로 삭제 */
self.addEventListener('install', e=>{
  // index.html을 미리 캐싱하지 않음 → 배포 직후 옛날 HTML이 먼저 뜨는 깜빡임 방지
  self.skipWaiting();
});
self.addEventListener('activate', e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e=>{
  if(e.request.method!=='GET') return;
  // HTML 문서(페이지 진입/새로고침)는 항상 네트워크 우선 → 늘 최신 화면
  var isDoc = e.request.mode==='navigate' ||
              (e.request.headers.get('accept')||'').indexOf('text/html')>-1;
  if(isDoc){
    e.respondWith(
      fetch(e.request).then(r=>{
        if(r && r.ok){                                  // ★ 정상(200)일 때만 캐시 → 깨진/빈 응답이 캐시 오염 못 시킴
          var cp=r.clone();
          caches.open(CACHE).then(c=>c.put(e.request,cp)); // 오프라인 대비 백업만
        }
        return r;
      }).catch(()=>caches.match(e.request).then(m=>m||caches.match('/index.html')))
    );
    return;
  }
  // 그 외(이미지·JS 등)는 네트워크 우선 + 캐시 백업 (기존 동작 유지)
  e.respondWith(
    fetch(e.request).then(r=>{
      if(r && r.ok && e.request.url.indexOf(location.origin)===0){  // ★ 여기도 200만 캐시
        var cp=r.clone();
        caches.open(CACHE).then(c=>c.put(e.request,cp));
      }
      return r;
    }).catch(()=>caches.match(e.request))
  );
});
/* ===== ↓↓↓ 웹 푸시 (추가) ↓↓↓ ===== */
self.addEventListener('push', function(event){
  var data={};
  try{ data = event.data ? event.data.json() : {}; }catch(e){}
  var title = data.title || '스꾸 새 스티커 🆕';
  var options = {
    body: data.body || '새 스티커가 올라왔어요!',
    icon: data.icon || '/icon-192.png',
    badge: '/favicon-32x32.png',
    image: data.image || undefined,
    data: { url: data.url || '/' },
    tag: data.tag || 'skku-new',
    renotify: true
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener('notificationclick', function(event){
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async function(){
    var all = await self.clients.matchAll({ type:'window', includeUncontrolled:true });
    for (var i=0;i<all.length;i++){
      var c=all[i];
      if('focus' in c){ try{ await c.navigate(url); }catch(e){} return c.focus(); }
    }
    if(self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
