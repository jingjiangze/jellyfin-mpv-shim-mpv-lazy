/* 海报缓存层（Service Worker）
 *
 * 为什么需要它：ModelScope 的 `resolve/master/posters/*.jpg` 会 302 到带时效签名
 * （auth_key）的 cdn-lfs 地址，而**302 与最终响应都没有 Cache-Control/Expires**
 * ⇒ 浏览器无法可靠缓存，每次打开页面都要把可见海报重走一遍「302 + 重新下载」。
 * 这里按“请求 URL（resolve 的稳定路径）”把图片字节缓存一年，命中即秒开；
 * 换源/换主机名都不影响，因为缓存键就是页面实际请求的那个 URL。
 *
 * 只处理图片请求，不碰数据 JSON 与 HTML。
 */
var CACHE = 'posters-v2';
var PATTERNS = [/\/posters\//, /\/resolve\/master\/posters\//, /\/media\/posters\//];

function isPoster(url) {
  if (!/\.(jpg|jpeg|png|webp)$/i.test(url.pathname)) return false;
  for (var i = 0; i < PATTERNS.length; i++) {
    if (PATTERNS[i].test(url.pathname) || PATTERNS[i].test(url.href)) return true;
  }
  return false;
}

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.filter(function (n) {
      return n !== CACHE && n.indexOf('posters-') === 0;
    }).map(function (n) { return caches.delete(n); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (!isPoster(url)) return;
  // 用 URL 字符串当键 + ignoreVary：ModelScope 的 302 带
  // `Vary: Origin, Access-Control-Request-*`，按 Request 匹配会因 Vary 不命中而反复回源
  var key = url.href;
  event.respondWith(caches.open(CACHE).then(function (cache) {
    return cache.match(key, { ignoreVary: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        // 跨域 <img> 是 no-cors，读不到状态码，type 为 opaque；两种都缓存
        if (res && (res.ok || res.type === 'opaque')) {
          cache.put(key, res.clone()).catch(function () {});
        }
        return res;
      });
    });
  }));
});
