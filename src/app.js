/* =============================================================
 * app.js —— 启动引导 + PWA（Service Worker / 安装提示）
 * ============================================================= */
(function (global) {
  'use strict';

  function registerSW() {
    // Service Worker 仅在 http/https 下可用；file:// 直接跳过
    if (!('serviceWorker' in global.navigator)) return;
    if (!/^https?:$/.test(global.location.protocol)) return;

    try {
      global.addEventListener('load', function () {
        global.navigator.serviceWorker
          .register('./sw.js')   // SW 必须位于根目录，scope 才能覆盖整个应用
          .then(function (reg) {
            console.log('[SW] Registered:', reg.scope);
            // 有新版本可用时提示刷新
            reg.addEventListener('updatefound', function () {
              var nw = reg.installing;
              if (!nw) return;
              nw.addEventListener('statechange', function () {
                if (nw.state === 'installed' && global.navigator.serviceWorker.controller) {
                  console.log('[SW] 新版本已就绪，下次刷新生效');
                }
              });
            });
          })
          .catch(function (err) {
            console.warn('[SW] Registration failed:', err);
          });
      });
    } catch (e) {
      console.warn('[SW] 注册异常（已忽略）', e);
    }
  }

  /** Android Chrome 原生安装提示 */
  var deferredPrompt = null;
  function setupInstallBanner() {
    var banner = null;
    try { banner = global.document.getElementById('install-banner'); } catch (e) { return; }
    if (!banner) return;

    var shown = false;
    try { shown = global.localStorage.getItem('els.install.dismissed') === '1'; } catch (e) { }

    function show() {
      if (shown || !deferredPrompt) return;
      banner.classList.remove('hidden');
    }
    function hide(remember) {
      banner.classList.add('hidden');
      if (remember) {
        try { global.localStorage.setItem('els.install.dismissed', '1'); } catch (e) { }
      }
    }

    global.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredPrompt = e;
      setTimeout(show, 1500);
    });

    global.document.getElementById('install-btn').onclick = function () {
      if (!deferredPrompt) { hide(true); return; }
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function (choice) {
        if (choice && choice.outcome === 'accepted') hide(true);
        deferredPrompt = null;
      });
    };
    global.document.getElementById('install-dismiss').onclick = function () { hide(true); };

    // iOS 无 beforeinstallprompt：静默提示一次（可通过 toast 看到说明）
    var isIOS = /iphone|ipad|ipod/i.test(global.navigator.userAgent);
    if (isIOS && !shown) {
      global.addEventListener('load', function () {
        global.ELS.ui.toast('iOS 用户：Safari 底部「分享」→「添加到主屏幕」即可安装');
      });
    }

    global.addEventListener('appinstalled', function () { hide(true); });
  }

  function boot() {
    var UI = global.ELS.ui;
    var Store = global.ELS.store;

    // 错误已由 ui.toast 提示，同时打印日志便于排查
    global.addEventListener('unhandledrejection', function (e) {
      console.warn('[ELS] Unhandled rejection:', e.reason);
      e.preventDefault();
    });

    UI.refreshBadges();
    UI.bind();

    UI.loadPlan()
      .then(UI.loadReview)
      .then(function () {
        var last = Store.latestArticle();
        if (last) global.ELS.ui.S.article = last;
        UI.render();
      });

    // 若已有文章，直接落在阅读页
    if (Store.latestArticle()) UI.go('reading');
    else UI.go('today');

    registerSW();
    setupInstallBanner();
  }

  if (global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
