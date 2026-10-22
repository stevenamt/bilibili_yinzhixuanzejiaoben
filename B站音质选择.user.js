// ==UserScript==
// @name B站网页版音质选择
// @name:zh-CN B站网页版音质选择
// @namespace    https://github.com/stevenamt/bili-audio-quality
// @version      4.2.1
// @description  在 B 站网页播放器的控制栏里选择音频档位（自动 / 最高可用 / 64K / 132K / 192K / 杜比全景声 / Hi-Res 无损），并显示当前实际在用的那一档。
// @author       stevenamt
// @license      MIT
// @homepageURL  https://github.com/stevenamt/bili-audio-quality
// @supportURL   https://github.com/stevenamt/bili-audio-quality/issues
// @icon         https://raw.githubusercontent.com/stevenamt/bili-audio-quality/main/icon.png
// @match        https://www.bilibili.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * 原理
 * -----
 * B 站网页播放器没有独立的音质选项：`x/player/playurl` 返回的 dash.audio 里同时有多路音频，
 * 选哪一路完全由播放器自己决定，服务端也没有“指定音质”的参数。
 * 所以这里只做一件事：在播放器读到取流响应之前，把 dash.audio 过滤成只剩目标档位的那一路，
 * 播放器没得挑，就只能用它。
 *
 * 三条路径都要拦：
 * 1. 首屏内联的 window.__playinfo__ （用 getter/setter 拦截赋值）
 * 2. 后续的 fetch 请求 （包一层，改响应体）
 * 3. 后续的 XMLHttpRequest 请求 （改 responseText / response）
 *
 * 已知限制
 * --------
 * - 档位名（64K/132K/192K）是目标码率，实际码率取决于投稿源，源差的时候会明显偏低。
 * - 杜比全景声（ec-3）在 Linux 下的 Chromium 播不了，会被置灰。
 * - Hi-Res 无损、杜比需要大会员，没有时对应档位不会出现在菜单里。
 */

(function () {
  'use strict';

  if (window.__biliAQ) return; // 防止重复注入

  // ------------------------------------------------------------------ 常量

  var STORE_KEY = 'aq_level'; // 0 = 自动（不拦取流）；-1 = 最高可用；其余为目标音轨 id
  var BTN_MARGIN = 18; // 控制栏按钮右边距，和原生按钮的间距观感对齐

  // 档位顺序同时也是“高低”顺序：id 大小跟音质高低无关（30251 无损的 id 比 30280 还小）
  var TIERS = [
    { id: 30216, short: '64K', full: '64K' },
    { id: 30232, short: '132K', full: '132K' },
    { id: 30280, short: '192K', full: '192K' },
    { id: 30250, short: '杜比', full: '杜比全景声' },
    { id: 30251, short: '无损', full: 'Hi-Res 无损' }
  ];
  var ORDER = TIERS.map(function (t) { return t.id; });
  var FIRST_VIP = ORDER.indexOf(30250); // 从这里开始是大会员档位

  function tier(id) {
    for (var i = 0; i < TIERS.length; i++) if (TIERS[i].id === id) return TIERS[i];
    return null;
  }
  function shortName(id) { var t = tier(id); return t ? t.short : (id ? '#' + id : '自动'); }
  function fullName(id) { var t = tier(id); return t ? t.full : (id ? '#' + id : '自动'); }
  function kbpsOf(stream) { return Math.round(((stream && stream.bandwidth) || 0) / 1000); }

  // ------------------------------------------------------------------ 存储

  function selected() {
    try {
      var v = localStorage.getItem(STORE_KEY);
      var n = v === null ? 0 : parseInt(v, 10);
      return isNaN(n) ? 0 : n;
    } catch (e) { return 0; }
  }

  function save(id) {
    try { localStorage.setItem(STORE_KEY, String(id)); } catch (e) {}
  }

  // ------------------------------------------------------- 取流响应处理

  function codecOk(codec) {
    try {
      if (!codec || !window.MediaSource) return true;
      return MediaSource.isTypeSupported('audio/mp4; codecs="' + codec + '"');
    } catch (e) { return true; }
  }

  // 把 dash 里的普通 / 无损 / 杜比三处音频合成一张表
  function collect(dash) {
    var list = [];

    (dash.audio || []).forEach(function (a) {
      list.push({ id: a.id, kbps: kbpsOf(a), codec: a.codecs || '', raw: a });
    });

    // 无损是单个对象，不是数组
    var flac = dash.flac && dash.flac.audio;
    if (flac && flac.baseUrl) {
      list.push({ id: flac.id || 30251, kbps: kbpsOf(flac), codec: flac.codecs || 'flac', raw: flac });
    }

    // 杜比是数组
    var dolby = dash.dolby && dash.dolby.audio;
    if (Array.isArray(dolby)) {
      dolby.forEach(function (a) {
        list.push({ id: a.id || 30250, kbps: kbpsOf(a), codec: a.codecs || 'ec-3', raw: a });
      });
    }

    list.sort(function (x, y) { return ORDER.indexOf(x.id) - ORDER.indexOf(y.id); });
    return list;
  }

  // 目标档位不可用时，退到“不高于它的最近一档”；普通档之间的回退不跨到会员档
  function pick(list, id) {
    var hit = list.filter(function (x) { return x.id === id; })[0];
    if (hit) return hit;

    var target = ORDER.indexOf(id);
    var lower = list.filter(function (x) {
      var i = ORDER.indexOf(x.id);
      return i > -1 && (target === -1 || i <= target) && i < FIRST_VIP && codecOk(x.codec);
    });
    if (lower.length) return lower[lower.length - 1];

    // 目标档及其以下都没有可用音轨（例如片源只有杜比）：先退到第一个本浏览器能播的，
    // 都播不了才退回列表首项，避免落到 ec-3 这种播不出来的编码上
    var playable = list.filter(function (x) { return codecOk(x.codec); });
    return playable.length ? playable[0] : list[0];
  }

  function pickTop(list) {
    var playable = list.filter(function (x) { return codecOk(x.codec); });
    var pool = playable.length ? playable : list;
    return pool[pool.length - 1];
  }

  function handle(json) {
    try {
      var dash = json && json.data && json.data.dash;
      if (!dash) return json;

      var list = collect(dash);
      if (list.length) {
        window.__biliAQ = {
          all: list.map(function (x) {
            return { id: x.id, kbps: x.kbps, codec: x.codec, ok: codecOk(x.codec) };
          })
        };
      }

      var target = selected();
      if (!target || !list.length) {
        window.__biliAQ = window.__biliAQ || {};
        window.__biliAQ.applied = 0;
        return json;
      }

      var hit = target === -1 ? pickTop(list) : pick(list, target);
      if (!hit) return json;

      // 只留一路，播放器没得挑
      dash.audio = [hit.raw];
      dash.dolby = { type: 0, audio: null };
      dash.flac = { display: false, audio: null };

      window.__biliAQ.applied = hit.id;
    } catch (e) {}
    return json;
  }

  // 1) 首屏内联数据
  var inlineStore;
  try {
    Object.defineProperty(window, '__playinfo__', {
      configurable: true,
      get: function () { return inlineStore; },
      set: function (v) { inlineStore = handle(v); }
    });
  } catch (e) {}

  function isPlayurl(url) { return typeof url === 'string' && url.indexOf('playurl') > -1; }

  // 2) fetch
  var rawFetch = window.fetch;
  if (typeof rawFetch === 'function') {
    window.fetch = function (input) {
      var url = typeof input === 'string' ? input : (input && input.url);
      return rawFetch.apply(this, arguments).then(function (res) {
        if (!isPlayurl(url)) return res;
        return res.clone().json().then(function (json) {
          handle(json);
          return new Response(JSON.stringify(json), {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers
          });
        }).catch(function () { return res; });
      });
    };
  }

  // 3) XMLHttpRequest
  var rawOpen = XMLHttpRequest.prototype.open;
  var rawSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__aqUrl = url;
    return rawOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    if (isPlayurl(xhr.__aqUrl)) {
      // 必须在 send 之前注册：播放器一般在 send 之后才挂自己的 onload，
      // 原先挂在 load 上时，播放器若已先注册就会先读到未过滤的原始响应
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

  // 实际在跑的那一路音频：分段 URL 形如 xxx-1-30280.m4s，取最近的一条
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

  function streams() {
    return (window.__biliAQ && window.__biliAQ.all) || [];
  }

  function appliedId() {
    return (window.__biliAQ && window.__biliAQ.applied) || 0;
  }

  function menuRows() {
    var list = streams();
    var cur = selected();
    var rows = [
      { id: 0, label: '自动', on: cur === 0 },
      { id: -1, label: '最高可用', on: cur === -1 }
    ];
    list.forEach(function (a) {
      rows.push({
        id: a.id,
        label: fullName(a.id),
        note: a.kbps + ' kbps' + (a.ok ? '' : ' · 当前浏览器不支持'),
        on: cur === a.id,
        disabled: !a.ok
      });
    });
    return rows;
  }

  function playerRoot() {
    var c = document.querySelector('.bpx-player-container');
    if (c && getComputedStyle(c).position !== 'static') return c;
    return document.body;
  }

  function ensureStyle() {
    if (document.getElementById('aq-style')) return;
    var style = document.createElement('style');
    style.id = 'aq-style';
    style.textContent = [
      '.aq-menu{position:absolute;z-index:2147483000;margin:0;padding:4px 0;',
      'background:#1b1b1b;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.55);',
      'border:1px solid rgba(255,255,255,.08);min-width:210px;color:#eee;text-align:left;',
      'white-space:nowrap;cursor:default;',
      'font:13px/1.6 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}',
      '.aq-item{padding:4px 14px;cursor:pointer}',
      '.aq-item:hover{background:rgba(255,255,255,.12)}',
      '.aq-item.aq-on{color:#00aeec}',
      '.aq-item[data-off]{opacity:.4;cursor:not-allowed}',
      '.aq-item[data-off]:hover{background:transparent}',
      '.aq-tip{padding:4px 14px;opacity:.6}'
    ].join('');
    (document.head || document.documentElement).appendChild(style);
  }

  function menu() {
    return document.getElementById('aq-menu');
  }

  function closeMenu() {
    var m = menu();
    if (m && m.parentNode) m.parentNode.removeChild(m);
  }

  function openMenu(btn) {
    closeMenu();
    ensureStyle();

    var root = playerRoot();
    var useFixed = root === document.body;

    var m = document.createElement('div');
    m.className = 'aq-menu';
    m.id = 'aq-menu';
    m.style.position = useFixed ? 'fixed' : 'absolute';

    menuRows().forEach(function (row) {
      var item = document.createElement('div');
      item.className = 'aq-item' + (row.on ? ' aq-on' : '');
      item.setAttribute('data-id', String(row.id));
      if (row.disabled) item.setAttribute('data-off', '');
      item.textContent = (row.on ? '✓ ' : '') + row.label + (row.note ? '  ' + row.note : '');
      m.appendChild(item);
    });

    if (!streams().length) {
      var tip = document.createElement('div');
      tip.className = 'aq-tip';
      tip.textContent = '还没拿到档位，稍等一下';
      m.appendChild(tip);
    }

    (useFixed ? document.body : root).appendChild(m);

    // 贴着按钮弹出：右下角对齐，超出视口就往里收
    var b = btn.getBoundingClientRect();
    var size = m.getBoundingClientRect();
    var rootBox = useFixed ? { left: 0, top: 0 } : root.getBoundingClientRect();

    var left = Math.max(8, b.right - size.width - rootBox.left);
    var top = b.top - size.height - 8 - rootBox.top;
    if (top < 8 - rootBox.top) top = b.bottom + 8 - rootBox.top;

    m.style.left = left + 'px';
    m.style.top = top + 'px';
  }

  function paint(btn) {
    var list = streams();
    // 显示“实际在跑”的那一档：选自动时播放器自己挑的可能不是最高档，也要如实显示
    var id = runningId() || appliedId() || selected();
    var stream = list.filter(function (x) { return x.id === id; })[0];
    var label = btn.querySelector('.bpx-player-ctrl-quality-result-name');
    if (label) label.textContent = shortName(id);
    btn.title = '音质：' + fullName(id) + (stream ? ' ' + stream.kbps + ' kbps' : '');
  }

  function ensure() {
    if (!/^\/(video|bangumi\/play|list|festival)/.test(location.pathname)) return;

    var bar = document.querySelector('.bpx-player-control-bottom-right');
    if (!bar) return;

    var btn = bar.querySelector('.aq-ctrl');
    if (btn) { paint(btn); return; }

    btn = document.createElement('div');
    btn.className = 'bpx-player-ctrl-btn bpx-player-ctrl-aq aq-ctrl';
    btn.setAttribute('role', 'button');
    btn.setAttribute('aria-label', '音质');

    // 原生 .bpx-player-ctrl-btn 写死 width:36px 又没有右边距，会把「192K」和「1080P」粘在一起；
    // 这里宽度自适应，右边距手动给，间距才和原生按钮一致
    btn.style.width = 'auto';
    btn.style.marginRight = BTN_MARGIN + 'px';

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

  // ------------------------------------------------------ 换档保留播放进度

  // 换档必须重载页面，视频会回到起点。这里把当前时间点临时存进 sessionStorage，
  // 重载后取出来 seek 回去，尽量接着原来的位置播（尽力而为，B 站自己也会记忆进度）
  var SEEK_KEY = 'aq_seek';
  var SEEK_TTL = 120000; // 超过 2 分钟的旧记录不再用，避免重开页面时跳到莫名其妙的位置

  function clearSeek() {
    try {
      sessionStorage.removeItem(SEEK_KEY);
      sessionStorage.removeItem(SEEK_KEY + '_at');
    } catch (e) {}
  }

  function savePlayback() {
    try {
      var v = document.querySelector('video');
      if (!v || !isFinite(v.currentTime) || v.currentTime < 1) return;
      sessionStorage.setItem(SEEK_KEY, String(v.currentTime));
      sessionStorage.setItem(SEEK_KEY + '_at', String(Date.now()));
    } catch (e) {}
  }

  function restorePlayback() {
    var t = 0;
    try {
      var at = parseInt(sessionStorage.getItem(SEEK_KEY + '_at') || '0', 10);
      t = parseFloat(sessionStorage.getItem(SEEK_KEY) || '0');
      if (!at || Date.now() - at > SEEK_TTL) t = 0;
    } catch (e) { return; }
    if (!t || !isFinite(t)) { clearSeek(); return; }

    // document-start 时页面里还没有 video，轮询等播放器就绪后再 seek；
    // 成功跳到目标位置后才清记录，没等到播放器就下次再试
    var tries = 0;
    var timer = setInterval(function () {
      var v = document.querySelector('video');
      if (v && v.readyState >= 1) {
        clearInterval(timer);
        try { v.currentTime = t; clearSeek(); } catch (e) {}
      } else if (++tries > 40) {
        clearInterval(timer);
      }
    }, 250);
  }

  // ------------------------------------------------------------------ 交互

  // 播放器对控制栏的点击有全局监听，点我们的按钮会顺带弹出原生清晰度菜单，
  // 所以要在捕获阶段拦下来，选中逻辑也放在这里
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

  // 播放器 DOM 是动态渲染的，轮询补齐按钮；顺便刷新栏里的档位
  setInterval(ensure, 2000);

  // 切清晰度 / 换 P 之后音频会重新取流，栏里要跟着变
  document.addEventListener('loadedmetadata', function () { setTimeout(ensure, 500); }, true);

  restorePlayback();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensure);
  } else {
    ensure();
  }
})();
