const CACHE='seukku-v2';

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
        var cp=r.clone();
        caches.open(CACHE).then(c=>c.put(e.request,cp)); // 오프라인 대비 백업만
        return r;
      }).catch(()=>caches.match(e.request).then(m=>m||caches.match('/index.html')))
    );
    return;
  }

  // 그 외(이미지·JS 등)는 네트워크 우선 + 캐시 백업 (기존 동작 유지)
  e.respondWith(
    fetch(e.request).then(r=>{
      if(e.request.url.indexOf(location.origin)===0){
        var cp=r.clone();
        caches.open(CACHE).then(c=>c.put(e.request,cp));
      }
      return r;
    }).catch(()=>caches.match(e.request))
  );
});
