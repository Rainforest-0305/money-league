/* Money League - offline service worker (Microsoft Store PWA build)
 *
 * 라이브 5종(sumo-bounce / prism-grid / neon-thread / bloom-circuit /
 * territory-clash)과 «같은 전략»이다. 검증된 패턴이라 재작성하지 않았다.
 *
 * 전략
 *   navigation / index.html : network-first, cache fallback
 *       -> 온라인 이용자는 항상 최신 빌드를 받는다. 재배포가 낡은 캐시에
 *          가려지는 일이 없다. 오프라인 이용자는 마지막 정상본을 받는다.
 *   그 외                    : cache-first
 *       -> Vite 산출물은 파일명에 콘텐츠 해시가 박힌다(assets/index-XXXX.js).
 *          재배포하면 «파일명 자체»가 바뀌므로 cache-first 여도 낡은 자산을
 *          물고 있을 수 없다. 폰트·아이콘도 같은 이유로 안전하다.
 *
 * 이 게임은 런타임 외부 네트워크 호출이 0건이라(fetch/XHR/WS/axios 전수 0)
 * 오프라인 대응은 이게 전부다. 배포 때 CACHE 값을 올려 무효화한다.
 *
 * ★ PRECACHE 에 해시 붙은 assets/* 를 넣지 않는 이유:
 *   빌드마다 이름이 바뀌어 하드코딩하면 install 이 404 로 실패한다.
 *   그것들은 첫 방문 때 fetch 핸들러가 자연히 캐싱한다.
 */
const CACHE = 'money-league-v2-20260818';
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-48.png',
  './icons/icon-72.png',
  './icons/icon-96.png',
  './icons/icon-128.png',
  './icons/icon-144.png',
  './icons/icon-152.png',
  './icons/icon-192.png',
  './icons/icon-256.png',
  './icons/icon-384.png',
  './icons/icon-512.png',
  './icons/icon-1024.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
  './icons/maskable-1024.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    }))
  );
});
