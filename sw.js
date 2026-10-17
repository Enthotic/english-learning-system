/* =============================================================
 * sw.js —— Service Worker（离线缓存）
 * 注意：必须放在项目根目录，scope 才能覆盖整个应用；
 *       放在 src/ 下会被限制到 /src/ 路径导致页面无法被接管。
 *
 * 缓存策略：
 *   - 页面导航（HTML）：network-first，离线时回退 index.html
 *   - 静态资源（CSS/JS/图标）：cache-first
 *   - 跨域 AI 请求：直接透传，绝不缓存
 * ============================================================= */
var CACHE_NAME = 'english-learning-v1.0.0';

var CORE_FILES = [
  './',
  './index.html',
  './manifest.json',
  './assets/styles.css',
  './src/store.js',
  './src/srs.js',
  './src/prompts.js',
  './src/ai.js',
  './src/services.js',
  './src/commands.js',
  './src/ui.js',
  './src/app.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png'
];

/* ---------------- install：预缓存核心资源 ---------------- */
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      // 逐个缓存，单个失败不阻断整体安装
      return Promise.all(CORE_FILES.map(function (url) {
        return cache.add(url).catch(function (e) {
          console.warn('[SW] 预缓存失败（忽略）:', url, e);
        });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

/* ---------------- activate：清理旧版本缓存 ---------------- */
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (n) {
        return n === CACHE_NAME ? null : caches.delete(n);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

/* ---------------- fetch：按资源类型分流 ---------------- */
self.addEventListener('fetch', function (event) {
  var req = event.request;

  // 只处理 GET；AI 接口等跨域请求一律透传
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 页面导航：network-first（保证有网时能拿到最新版本）
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').indexOf('text/html') > -1) {
    event.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE_NAME).then(function (c) { c.put('./index.html', copy); });
        return res;
      }).catch(function () {
        return caches.match('./index.html').then(function (r) {
          return r || new Response('离线且无缓存', { status: 503 });
        });
      })
    );
    return;
  }

  // 其余同源静态资源：cache-first
  event.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function (c) { c.put(req, copy); });
        }
        return res;
      });
    })
  );
});
