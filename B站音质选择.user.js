// ==UserScript==
// @name         B站网页版音质选择
// @name:zh-CN   B站网页版音质选择
// @namespace    https://github.com/stevenamt/bilibili_yinzhixuanzejiaoben
// @version      1.0.1
// @description  在 B 站网页播放器的控制栏里选择音频档位（自动 / 最高可用 / 64K / 132K / 192K / 杜比全景声 / Hi-Res 无损），并显示当前实际在用的那一档。
// @author       stevenamt
// @license      MIT
// @homepageURL  https://github.com/stevenamt/bilibili_yinzhixuanzejiaoben
// @supportURL   https://github.com/stevenamt/bilibili_yinzhixuanzejiaoben/issues
// @icon         https://raw.githubusercontent.com/stevenamt/bilibili_yinzhixuanzejiaoben/main/icon.png
// @updateURL    https://raw.githubusercontent.com/stevenamt/bilibili_yinzhixuanzejiaoben/main/B%E7%AB%99%E9%9F%B3%E8%B4%A8%E9%80%89%E6%8B%A9.user.js
// @downloadURL  https://raw.githubusercontent.com/stevenamt/bilibili_yinzhixuanzejiaoben/main/B%E7%AB%99%E9%9F%B3%E8%B4%A8%E9%80%89%E6%8B%A9.user.js
// @match        https://www.bilibili.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * 原理
 * -----
 * B 站网页播放器没有独立的音质选项：x/player/playurl 的响应里 dash.audio 同时带多路音频，
 * 选哪一路由播放器自己决定，服务端也没有“指定音质”的参数。
 * 所以这里只做一件事：在播放器读到响应之前把 dash.audio 过滤成只剩目标那一路，播放器没得挑。
 *
 * 三条路径都要拦：首屏内联的 window.__playinfo__、fetch、XMLHttpRequest。
 *
 * 已知限制
 * --------
 * - 档位名（64K/132K/192K）是目标码率，实际码率取决于投稿源，源差时明显偏低。
 * - 无损 / 杜比取决于片源和账号权限，平台不下发就没有。
 */

(function () {
  'use strict';

  if (window.__biliAQ) return; // 已经注入过

  // ------------------------------------------------------------------ 配置

  var LEVEL_KEY = 'aq_level'; // 0 = 自动（不拦取流）；-1 = 最高可用；其余为目标音轨 id
  var SEEK_KEY = 'aq_seek';
  var SEEK_TTL = 120000;      // 换档记录 2 分钟内有效

  // [音轨 id, 栏里简称, 菜单全称]。顺序即高低，id 大小和音质无关（30251 无损的 id 比 30280 小）
  var TIERS = [
    [30216, '64K', '64K'],
    [30232, '132K', '132K'],
    [30280, '192K', '192K'],
    [30250, '杜比', '杜比全景声'],
    [30251, '无损', 'Hi-Res 无损']
  ];
  var ORDER = TIERS.map(function (t) { return t[0]; });
  var VIP_FROM = ORDER.indexOf(30250); // 从这里开始是大会员档

  var NAMES = {};
  TIERS.forEach(function (t) { NAMES[t[0]] = t; });

  function name(id, full) {
    var t = NAMES[id];
    if (t) return full ? t[2] : t[1];
    return id ? '#' + id : '自动';
  }

  function kbps(stream) {
    return Math.round(((stream && stream.bandwidth) || 0) / 1000);
  }

  // ------------------------------------------------------------------ 存储

  function selected() {
    try {
      var n = parseInt(localStorage.getItem(LEVEL_KEY), 10);
      return isNaN(n) ? 0 : n;
    } catch (e) { return 0; }
  }

  function save(id) {
    try { localStorage.setItem(LEVEL_KEY, String(id)); } catch (e) {}
  }

  // ------------------------------------------------------------ 取流处理

  function codecOk(codec) {
    try {
      if (!codec || !window.MediaSource) return true;
      return MediaSource.isTypeSupported('audio/mp4; codecs="' + codec + '"');
    } catch (e) { return true; }
  }

  // 把普通 / 无损 / 杜比三处音频合成一张表，按档位高低排序
  function collect(dash) {
    var list = [];

    function add(a, defId, defCodec) {
      if (!a) return;
      list.push({ id: a.id || defId, kbps: kbps(a), codec: a.codecs || defCodec, raw: a });
    }

    (dash.audio || []).forEach(function (a) { add(a, a.id, ''); });

    var flac = dash.flac && dash.flac.audio; // 无损是单个对象
    if (flac && flac.baseUrl) add(flac, 30251, 'flac');

    var dolby = dash.dolby && dash.dolby.audio; // 杜比是数组
    if (Array.isArray(dolby)) dolby.forEach(function (a) { add(a, 30250, 'ec-3'); });

    return list.sort(function (x, y) { return ORDER.indexOf(x.id) - ORDER.indexOf(y.id); });
  }

  // 挑一路：命中就用；否则退到不高于它的普通档；target = -1 取能播的最高档
  function choose(list, target) {
    var playable = list.filter(function (x) { return codecOk(x.codec); });
    if (!playable.length) return list[list.length - 1];
    if (target === -1) return playable[playable.length - 1];

    var want = ORDER.indexOf(target);
    for (var i = playable.length - 1; i >= 0; i--) {
      var idx = ORDER.indexOf(playable[i].id);
      if (idx > -1 && idx <= want && idx < VIP_FROM) return playable[i];
    }
    return playable[0];
  }

  function handle(json) {
    try {
      var dash = json && json.data && json.data.dash;
      if (!dash) return json;

      var list = collect(dash);
      if (!list.length) return json;

      var target = selected();
      var applied = 0;

      if (target) {
        var hit = choose(list, target);
        if (hit) {
          dash.audio = [hit.raw]; // 只留一路，播放器没得挑
          dash.dolby = { type: 0, audio: null };
          dash.flac = { display: false, audio: null };
          applied = hit.id;
        }
      }

      window.__biliAQ = {
        all: list.map(function (x) {
          return { id: x.id, kbps: x.kbps, codec: x.codec, ok: codecOk(x.codec) };
        }),
        applied: applied
      };
    } catch (e) {}
    return json;
  }

  function isPlayurl(url) {
    return typeof url === 'string' && url.indexOf('playurl') > -1;
  }

  // 1) 首屏内联数据
  var inline;
  try {
    Object.defineProperty(window, '__playinfo__', {
      configurable: true,
      get: function () { return inline; },
      set: function (v) { inline = handle(v); }
    });
  } catch (e) {}

  // 2) fetch
  var rawFetch = window.fetch;
  if (typeof rawFetch === 'function') {
    window.fetch = function (input) {
      var url = typeof input === 'string' ? input : (input && input.url);
      var pending = rawFetch.apply(this, arguments);
      if (!isPlayurl(url)) return pending;

      return pending.then(function (res) {
        return res.clone().json().then(function (json) {
          return new Response(JSON.stringify(handle(json)), {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers
          });
        }).catch(function () { return res; });
      });
    };
  }

  // 3) XMLHttpRequest：在 send 之前注册 readystatechange，早于播放器读取
  var rawOpen = XMLHttpRequest.prototype.open;
  var rawSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__aqUrl = url;
    return rawOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    if (isPlayurl(xhr.__aqUrl)) {
      var patched = false;
      xhr.addEventListener('readystatechange', function () {
        if (patched || xhr.readyState !== 4) return;
        patched = true;
        try {
          var text = JSON.stringify(handle(JSON.parse(xhr.responseText)));
          Object.defineProperty(xhr, 'responseText', { get: function () { return text; }, configurable: true });
          Object.defineProperty(xhr, 'response', { get: function () { return text; }, configurable: true });
        } catch (e) {}
      });
    }
    return rawSend.apply(this, arguments);
  };

  // ------------------------------------------------------------ 控制栏按钮

  function streams() {
    return (window.__biliAQ && window.__biliAQ.all) || [];
  }

  function applied() {
    return (window.__biliAQ && window.__biliAQ.applied) || 0;
  }

  // 实际在跑的那一路：分片 URL 形如 xxx-1-30280.m4s，取最近出现的一条
  function runningId() {
    try {
      var entries = performance.getEntriesByType('resource');
      for (var i = entries.length - 1; i >= 0; i--) {
        var m = /-(\d{5})\.m4s/.exec(entries[i].name);
        if (m && ORDER.indexOf(+m[1]) > -1) return +m[1];
      }
    } catch (e) {}
    return 0;
  }

  var CSS =
    '.aq-menu{position:absolute;z-index:2147483000;padding:4px 0;background:#1b1b1b;' +
    'border:1px solid rgba(255,255,255,.08);border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.55);' +
    'min-width:210px;color:#eee;white-space:nowrap;cursor:default;text-align:left;' +
    'font:13px/1.6 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}' +
    '.aq-item{padding:4px 14px;cursor:pointer}' +
    '.aq-item:hover{background:rgba(255,255,255,.12)}' +
    '.aq-item.aq-on{color:#00aeec}' +
    '.aq-item[data-off]{opacity:.4;cursor:not-allowed}' +
    '.aq-item[data-off]:hover{background:transparent}' +
    '.aq-tip{padding:4px 14px;opacity:.6}' +
    '.aq-ctrl .bpx-player-ctrl-quality-result-name{white-space:nowrap}';

  function ensureStyle() {
    if (document.getElementById('aq-style')) return;
    var style = document.createElement('style');
    style.id = 'aq-style';
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function menu() {
    return document.getElementById('aq-menu');
  }

  function closeMenu() {
    var m = menu();
    if (m) m.remove();
  }

  function playerRoot() {
    var c = document.querySelector('.bpx-player-container');
    return c && getComputedStyle(c).position !== 'static' ? c : document.body;
  }

  function openMenu(btn) {
    closeMenu();
    ensureStyle();

    var root = playerRoot();
    var fixed = root === document.body;

    var m = document.createElement('div');
    m.className = 'aq-menu';
    m.id = 'aq-menu';
    if (fixed) m.style.position = 'fixed';

    var cur = selected();
    var rows = [
      { id: 0, label: '自动', on: cur === 0 },
      { id: -1, label: '最高可用', on: cur === -1 }
    ];
    streams().forEach(function (a) {
      rows.push({
        id: a.id,
        label: name(a.id, true),
        note: a.kbps + ' kbps' + (a.ok ? '' : ' · 当前浏览器不支持'),
        on: cur === a.id,
        off: !a.ok
      });
    });

    rows.forEach(function (row) {
      var item = document.createElement('div');
      item.className = 'aq-item' + (row.on ? ' aq-on' : '');
      item.setAttribute('data-id', String(row.id));
      if (row.off) item.setAttribute('data-off', '');
      item.textContent = (row.on ? '✓ ' : '') + row.label + (row.note ? '  ' + row.note : '');
      m.appendChild(item);
    });

    if (!streams().length) {
      var tip = document.createElement('div');
      tip.className = 'aq-tip';
      tip.textContent = '还没拿到档位，稍等一下';
      m.appendChild(tip);
    }

    (fixed ? document.body : root).appendChild(m);

    // 贴着按钮弹出：右下角对齐，上方放不下就翻到下面
    var b = btn.getBoundingClientRect();
    var box = fixed ? { left: 0, top: 0 } : root.getBoundingClientRect();
    var size = m.getBoundingClientRect();
    var left = Math.max(8, b.right - size.width - box.left);
    var top = b.top - size.height - 8 - box.top;
    if (top < 8 - box.top) top = b.bottom + 8 - box.top;

    m.style.left = left + 'px';
    m.style.top = top + 'px';
  }

  // 显示真正在跑的那一路：选「自动」时播放器挑的可能不是最高档，也要如实显示
  function paint(btn) {
    var id = runningId() || applied() || selected();
    var stream = streams().filter(function (x) { return x.id === id; })[0];
    var label = btn.querySelector('.bpx-player-ctrl-quality-result-name');
    if (label) label.textContent = name(id);
    btn.title = '音质：' + name(id, true) + (stream ? ' ' + stream.kbps + ' kbps' : '');
  }

  // 让按钮和原生按钮同宽同边距：清晰度、倍速怎么排，它就怎么排。
  // 原生按钮还没渲染时先跳过，后面的轮询会补上（B 站播放器是懒渲染的）
  function fitNative(btn) {
    var ref = document.querySelector('.bpx-player-control-bottom-right .bpx-player-ctrl-btn:not(.aq-ctrl)');
    if (!ref) return;
    var cs = getComputedStyle(ref);
    if (btn.style.width === cs.width && btn.style.marginRight === cs.marginRight) return;
    btn.style.width = cs.width;
    btn.style.marginLeft = cs.marginLeft;
    btn.style.marginRight = cs.marginRight;
  }

  function ensure() {
    if (!/^\/(video|bangumi\/play|list|festival)/.test(location.pathname)) return;

    var bar = document.querySelector('.bpx-player-control-bottom-right');
    if (!bar) return;

    var btn = bar.querySelector('.aq-ctrl');
    if (btn) { fitNative(btn); paint(btn); return; }

    btn = document.createElement('div');
    btn.className = 'bpx-player-ctrl-btn bpx-player-ctrl-aq aq-ctrl';
    btn.setAttribute('role', 'button');
    btn.setAttribute('aria-label', '音质');

    // 不覆盖宽高和边距，直接沿用原生按钮的盒模型
    fitNative(btn);

    var result = document.createElement('div');
    result.className = 'bpx-player-ctrl-quality-result';
    var label = document.createElement('span');
    label.className = 'bpx-player-ctrl-quality-result-name';
    result.appendChild(label);
    btn.appendChild(result);

    var quality = bar.querySelector('.bpx-player-ctrl-quality');
    if (quality && quality.parentElement === bar) bar.insertBefore(btn, quality);
    else bar.appendChild(btn);

    paint(btn);
  }

  // -------------------------------------------------------- 换档保留进度

  // 换档只能重载页面，视频会回到起点。把时间点临时存进 sessionStorage，重载后 seek 回去。
  function savePlayback() {
    try {
      var v = document.querySelector('video');
      if (!v || !(v.currentTime > 0.5)) return;
      sessionStorage.setItem(SEEK_KEY, v.currentTime + ',' + Date.now());
    } catch (e) {}
  }

  function restorePlayback() {
    var t = 0;
    try {
      var parts = (sessionStorage.getItem(SEEK_KEY) || '').split(',');
      var at = +parts[1];
      if (at && Date.now() - at <= SEEK_TTL) t = +parts[0] || 0;
    } catch (e) { return; }
    if (!(t > 0)) return;

    // document-start 时还没有 video，等播放器就绪后再 seek
    var tries = 0;
    var timer = setInterval(function () {
      var v = document.querySelector('video');
      if (v && v.readyState >= 1) {
        clearInterval(timer);
        try { v.currentTime = t; sessionStorage.removeItem(SEEK_KEY); } catch (e) {}
      } else if (++tries > 40) {
        clearInterval(timer);
      }
    }, 250);
  }

  // ------------------------------------------------------------------ 交互

  // 播放器对控制栏有全局点击监听，点我们的按钮会顺带弹出原生菜单，所以要在捕获阶段拦下
  document.addEventListener('click', function (e) {
    var target = e.target;
    if (!target || !target.closest) return;

    var item = target.closest('.aq-item');
    if (item) {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      if (item.hasAttribute('data-off')) return;
      var id = parseInt(item.getAttribute('data-id'), 10);
      if (isNaN(id)) return;
      save(id);
      savePlayback();
      location.reload(); // 取流已经发生，改档位只能重载
      return;
    }

    var btn = target.closest('.aq-ctrl');
    if (btn) {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      if (menu()) closeMenu(); else openMenu(btn);
      return;
    }

    closeMenu();
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeMenu();
  });

  document.addEventListener('fullscreenchange', function () {
    setTimeout(function () { closeMenu(); ensure(); }, 300);
  });

  // 播放器 DOM 是动态渲染的，轮询补齐按钮并刷新档位显示
  setInterval(ensure, 2000);

  // 切清晰度 / 换 P 之后会重新取流，栏里要跟着变
  document.addEventListener('loadedmetadata', function () { setTimeout(ensure, 500); }, true);

  restorePlayback();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensure);
  } else {
    ensure();
  }
})();
