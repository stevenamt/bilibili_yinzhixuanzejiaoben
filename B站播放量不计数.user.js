// ==UserScript==
// @name         B站播放量不计数
// @name:zh-CN   B站播放量不计数
// @namespace    https://github.com/stevenamt/bilibili_yinzhixuanzejiaoben
// @version      0.2.0
// @description  播放量跟着点赞走：没点赞的视频不计播放量，点赞后才计入。观看历史、播放时长、完播一律照常上报，也不向推荐系统发送任何负反馈。
// @author       stevenamt
// @license      MIT
// @homepageURL  https://github.com/stevenamt/bilibili_yinzhixuanzejiaoben
// @supportURL   https://github.com/stevenamt/bilibili_yinzhixuanzejiaoben/issues
// @icon         https://raw.githubusercontent.com/stevenamt/bilibili_yinzhixuanzejiaoben/main/icon.png
// @updateURL    https://raw.githubusercontent.com/stevenamt/bilibili_yinzhixuanzejiaoben/main/B%E7%AB%99%E6%92%AD%E6%94%BE%E9%87%8F%E4%B8%8D%E8%AE%A1%E6%95%B0.user.js
// @downloadURL  https://raw.githubusercontent.com/stevenamt/bilibili_yinzhixuanzejiaoben/main/B%E7%AB%99%E6%92%AD%E6%94%BE%E9%87%8F%E4%B8%8D%E8%AE%A1%E6%95%B0.user.js
// @match        https://www.bilibili.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * 原理
 * -----
 * B 站的播放量不是点开就 +1，而是由 x/click-interface/click/web/h5 这个
 * 「开始观看」请求计数（官方文档：该接口亦被用于计算播放量，播放量更新不是实时的）。
 * 它是一次 fire-and-forget 上报，播放器不读响应，所以拦掉它不影响播放。
 *
 * 这里只拦这一个接口：
 *   - 观看历史、播放时长、完播走的是 x/click-interface/web/heartbeat，照常放行
 *   - 推荐系统的兴趣画像来自历史与互动，同样不受影响
 *   - 不发任何「不感兴趣 / 拉黑 / 点踩」类请求，不去动推荐算法
 *
 * 放行条件只有一个：你给这个视频点了赞。
 *   - 进页面先查 x/web-interface/archive/has/like，赞过就直接放行
 *   - 页面内点赞成功（archive/like 返回 code 0 且 like=1）立刻放行，并把拦下的计数请求补发一次
 *   - 取消赞不收回已经补发的请求（播放量撤不回），但换到别的视频会重新从「未计」开始
 *
 * 代价与边界
 * ----------
 * - 播放量有统计延迟，拦下后大约 10 分钟内看不出差别，别当场比对数字
 * - 只处理网页播放器；App、直播、番剧付费流不在此列（番剧页是同一套播放器，理论上也覆盖）
 * - 这是自用脚本：只影响「这次观看是否给视频计入播放量」，不提供任何绕过权限的能力
 */

(function () {
  'use strict';

  if (window.__biliNoCount) return; // 已经注入过

  // ---------------------------------------------------------------- 配置

  // 只匹配播放量计数接口。注意别写成 click-interface/web/heartbeat，那是历史/时长，要放行
  var COUNT_RE = /\/x\/click-interface\/click\/web\//;
  var LIKE_RE = /\/x\/web-interface\/archive\/like\b/;
  var HASLIKE_RE = /\/x\/web-interface\/archive\/has\/like/;

  var S = window.__biliNoCount = {
    pass: false,   // 本页是否已放行（点赞 / 手动点按钮后置 true）
    bv: '',        // 当前视频的 bvid，换视频时重置
    held: []       // 被拦下的请求，放行时原样补发
  };

  function isCount(url) {
    return typeof url === 'string' && COUNT_RE.test(url);
  }

  function isLike(url) {
    return typeof url === 'string' && LIKE_RE.test(url) && !HASLIKE_RE.test(url);
  }

  // 点赞请求体里 like=1 是点赞、2 是取消。只认点赞
  function isLikeOn(body) {
    return /(^|&)like=1(&|$)/.test(String(body || ''));
  }

  // ---------------------------------------------------------- 请求拦截

  // XHR：不要调用 rawSend，直接伪造一个成功响应，播放器不会卡住
  function fakeDone(xhr) {
    try {
      Object.defineProperty(xhr, 'readyState', { get: function () { return 4; }, configurable: true });
      Object.defineProperty(xhr, 'status', { get: function () { return 200; }, configurable: true });
      Object.defineProperty(xhr, 'statusText', { get: function () { return 'OK'; }, configurable: true });
      Object.defineProperty(xhr, 'responseText', { get: function () { return '{"code":0,"message":"0","ttl":1}'; }, configurable: true });
      Object.defineProperty(xhr, 'response', { get: function () { return '{"code":0,"message":"0","ttl":1}'; }, configurable: true });
    } catch (e) {}
    setTimeout(function () {
      try {
        xhr.dispatchEvent(new Event('readystatechange'));
        xhr.dispatchEvent(new Event('load'));
        xhr.dispatchEvent(new Event('loadend'));
      } catch (e) {}
    }, 0);
  }

  var rawOpen = XMLHttpRequest.prototype.open;
  var rawSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ncUrl = url;
    this.__ncMethod = method;
    return rawOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    var url = this.__ncUrl;

    if (!S.pass && isCount(url)) {
      S.held.push({ url: url, method: this.__ncMethod || 'POST', body: body });
      fakeDone(this);
      return;
    }

    // 点赞成功就放行并补发被拦下的计数请求
    if (!S.pass && isLike(url) && isLikeOn(body)) {
      var xhr = this;
      xhr.addEventListener('readystatechange', function () {
        if (xhr.readyState !== 4) return;
        try {
          var j = JSON.parse(xhr.responseText);
          if (j && j.code === 0) release();
        } catch (e) {}
      });
    }

    return rawSend.apply(this, arguments);
  };

  // fetch：返回一个伪造的 JSON 响应
  var rawFetch = window.fetch;
  if (typeof rawFetch === 'function') {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url);
      if (!S.pass && isCount(url)) {
        S.held.push({
          url: url,
          method: (init && init.method) || (input && input.method) || 'POST',
          body: init && init.body,
          headers: init && init.headers
        });
        return Promise.resolve(new Response('{"code":0,"message":"0","ttl":1}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }));
      }

      var pending = rawFetch.apply(this, arguments);

      if (!S.pass && isLike(url) && isLikeOn(init && init.body)) {
        return pending.then(function (res) {
          res.clone().json().then(function (j) {
            if (j && j.code === 0 && !S.pass) release();
          }).catch(function () {});
          return res;
        });
      }
      return pending;
    };
  }

  // sendBeacon：埋点/上报有时走这个通道，同样拦
  if (navigator.sendBeacon) {
    var rawBeacon = navigator.sendBeacon;
    navigator.sendBeacon = function (url, data) {
      if (!S.pass && isCount(url)) {
        S.held.push({ url: url, method: 'POST', body: data });
        return true;
      }
      return rawBeacon.apply(navigator, arguments);
    };
  }

  // 放行：把拦下的请求原样补发一次。晚了几十秒，B 站按稿件计数，不要求实时
  function release() {
    if (S.pass) return;
    S.pass = true;
    var queue = S.held.splice(0, S.held.length);
    queue.forEach(function (h) {
      try {
        var body = h.body;
        var headers = h.headers || { 'Content-Type': 'application/x-www-form-urlencoded' };
        if (body && typeof body !== 'string' && !(body instanceof Blob) &&
            typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
          body = body.toString();
        }
        rawFetch.call(window, h.url, {
          method: h.method || 'POST',
          credentials: 'include',
          headers: headers,
          body: body
        });
      } catch (e) {}
    });
    refreshBtn();
  }

  // -------------------------------------------------- 点赞状态与视频切换

  function refreshBtn() {
    var btn = document.querySelector('.nc-ctrl');
    if (btn) paint(btn);
  }

  // 已经赞过的视频直接放行；新视频一律从「不计」开始
  function queryLiked(bv) {
    try {
      rawFetch.call(window, 'https://api.bilibili.com/x/web-interface/archive/has/like?bvid=' + bv, {
        credentials: 'include'
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (j && j.code === 0 && j.data === 1 && S.bv === bv && !S.pass) release();
      }).catch(function () {});
    } catch (e) {}
  }

  // B 站换视频是前端路由，路径变了要重新判断
  function syncBv() {
    var m = /\/video\/(BV[0-9A-Za-z]+)/.exec(location.pathname);
    var bv = m ? m[1] : '';
    if (bv === S.bv) return;
    S.bv = bv;
    S.pass = false;
    S.held.length = 0; // 上一个视频没补发的请求作废
    refreshBtn();
    if (bv) queryLiked(bv);
  }

  // ------------------------------------------------------------ 控制栏按钮

  var CSS =
    '.nc-ctrl .bpx-player-ctrl-quality-result-name{white-space:nowrap}' +
    '.nc-ctrl[data-counted] .bpx-player-ctrl-quality-result-name{color:#00aeec}' +
    '.nc-ctrl:focus-visible{outline:2px solid #00aeec;outline-offset:-2px}';

  function ensureStyle() {
    if (document.getElementById('nc-style')) return;
    var style = document.createElement('style');
    style.id = 'nc-style';
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function paint(btn) {
    var label = btn.querySelector('.bpx-player-ctrl-quality-result-name');
    var text = S.pass ? '已计' : '未计';
    if (label && label.textContent !== text) label.textContent = text;
    if (S.pass) btn.setAttribute('data-counted', ''); else btn.removeAttribute('data-counted');
    btn.title = S.pass
      ? '已点赞：这个视频正常计入播放量'
      : '未点赞：这个视频不计播放量；点赞或点这里改为正常计数';
    btn.setAttribute('aria-label', btn.title);
  }

  // 放在音质按钮右边；音质脚本没装/还没插入时退到清晰度右边
  function place(btn, bar) {
    var prev = bar.querySelector('.aq-ctrl') || bar.querySelector('.bpx-player-ctrl-quality');
    if (!prev || prev.parentElement !== bar) return;
    if (prev.nextElementSibling !== btn) prev.insertAdjacentElement('afterend', btn);
  }

  function ensure() {
    if (!/^\/(video|bangumi\/play|list|festival)/.test(location.pathname)) return;
    syncBv();
    ensureStyle();

    var bar = document.querySelector('.bpx-player-control-bottom-right');
    if (!bar) return;

    var btn = bar.querySelector('.nc-ctrl');
    if (btn) { place(btn, bar); paint(btn); return; }

    btn = document.createElement('div');
    btn.className = 'bpx-player-ctrl-btn bpx-player-ctrl-nc nc-ctrl';
    btn.setAttribute('role', 'button');
    btn.tabIndex = 0;
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        release();
        paint(btn);
      }
    });

    var result = document.createElement('div');
    result.className = 'bpx-player-ctrl-quality-result';
    var label = document.createElement('span');
    label.className = 'bpx-player-ctrl-quality-result-name';
    result.appendChild(label);
    btn.appendChild(result);

    bar.appendChild(btn);
    place(btn, bar);
    paint(btn);
  }

  // 播放器对控制栏有全局点击监听，点我们的按钮要在捕获阶段拦下
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var btn = t.closest('.nc-ctrl');
    if (!btn) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    release();
    paint(btn);
  }, true);

  // 控制栏是懒渲染的：DOM 一变就补一次。
  // document-start 时 documentElement 可能还不存在，observe 会抛错并带崩后面的注册，
  // 所以这里做幂等 + 兜底，DOM 就绪后再挂一次
  var watching = false;
  function watch() {
    if (watching || !document.documentElement) return;
    watching = true;
    var queued = false;
    new MutationObserver(function () {
      if (queued) return;
      queued = true;
      setTimeout(function () { queued = false; ensure(); }, 120);
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
  watch();

  document.addEventListener('fullscreenchange', function () {
    setTimeout(ensure, 300);
  });
  document.addEventListener('loadedmetadata', function () { setTimeout(ensure, 500); }, true);

  document.addEventListener('DOMContentLoaded', function () {
    watch();
    ensure();
  });

  if (document.readyState !== 'loading') {
    watch();
    ensure();
  }
})();
