/* 分集磁力层（架构无关附加层）
 *
 * 不依赖任何一方的数据/key 体系：监听 #modal 的内容变化，从弹窗标题取片名，
 * 按「归一化片名」查分集索引（magnet-eps.json），把「第 N 集」chip 渲染进弹窗。
 * 索引来源（级联回退）：gcore jsDelivr → gh-proxy → ModelScope → 同源。
 * 点击 chip 复制磁力（页面有 __magnet 就复用，否则 navigator.clipboard）。
 */
(function () {
  'use strict';
  var IDX = null, LOADING = false, LAST_NAME = null;
  var URLS = [
    'https://gcore.jsdelivr.net/gh/jingjiangze/jellyfin-mpv-shim-mpv-lazy@main/media/magnet-eps.json',
    'https://gh-proxy.com/https://raw.githubusercontent.com/jingjiangze/jellyfin-mpv-shim-mpv-lazy/main/media/magnet-eps.json',
    'https://modelscope.cn/datasets/jingjiangze/Anime-JPG/resolve/master/assets/magnet-eps.json',
    'magnet-eps.json'
  ];

  /* 季/部标记。旧版只做子串命中，导致：
       · 「我的英雄学院 I am a hero too」吃到正传 52 集的磁力
       · 「乒乓」吃到「灼热的乒乓妹」
       · 剧场版吃到同名片子的 TV 集数
     现在子串命中必须同时满足「季号一致」且「不是短名的宽松匹配」。 */
  var RE_SEASON = /(第\s*[一二三四五六七八九十\d]+\s*[季期]|Season\s*\d+|Part\.?\s*\d+|\bS\d{1,2}\b|[ⅡⅢⅣⅤⅥ])/i;
  var NUM = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
              'Ⅱ': 2, 'Ⅲ': 3, 'Ⅳ': 4, 'Ⅴ': 5, 'Ⅵ': 6 };

  function norm(s) {
    s = String(s || '').toLowerCase();
    s = s.replace(/[（）【】：]/g, function (c) {
      return { '（': '(', '）': ')', '【': '[', '】': ']', '：': ':' }[c];
    });
    return s.replace(/[\s\-_.·・:：!！?？,，。'"()\[\]（）【】～~]/g, '');
  }

  function seasonsOf(s) {
    var out = {}, m, str = String(s || '');
    var re = new RegExp(RE_SEASON.source, 'gi');
    while ((m = re.exec(str))) {
      var raw = m[1];
      var d = raw.match(/\d+/);
      var n = d ? Number(d[0]) : NUM[raw.charAt(raw.length - 1)];
      if (!n) continue;
      out[(/Part/i.test(raw) ? 'part' : 's') + n] = 1;
    }
    return out;
  }

  function sameSeasons(a, b) {
    var ka = Object.keys(a), kb = Object.keys(b);
    if (!ka.length && !kb.length) return true;
    if (ka.length !== kb.length) return false;
    for (var i = 0; i < ka.length; i++) if (kb.indexOf(ka[i]) < 0) return false;
    return true;
  }

  function load() {
    if (IDX) return Promise.resolve(IDX);
    if (LOADING) return new Promise(function (r) { setTimeout(function () { r(load()); }, 300); });
    LOADING = true;
    var i = 0;
    return new Promise(function (resolve) {
      (function next() {
        if (i >= URLS.length) { LOADING = false; return resolve(null); }
        fetch(URLS[i++]).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        }).then(function (d) {
          IDX = d; LOADING = false; resolve(d);
        }, next);
      })();
    });
  }

  function findByName(name) {
    if (!IDX || !name) return null;
    var q = norm(name);
    if (!q) return null;
    var qs = seasonsOf(name);
    var best = null, bestScore = 0;
    for (var k in IDX) {
      var e = IDX[k];
      var nt = norm(e && e.n);
      if (!nt) continue;
      /* 优先级：完全相同 > 片名被发布名包含 > 发布名被片名包含（后者要求长度占比） */
      var score = 0;
      if (nt === q) score = 1000;
      else if (nt.indexOf(q) >= 0 && q.length >= 5) score = 100 + q.length;
      else if (q.indexOf(nt) >= 0 && nt.length >= 5 && nt.length >= q.length * 0.6) score = 50 + nt.length;
      if (!score) continue;
      if (q.length <= 3) score -= 200;            // 短名（乒乓/虫师）只信完全相同
      if (score <= 0) continue;
      if (!sameSeasons(qs, seasonsOf(e.n))) continue;   // 季号必须一致
      if (score > bestScore) { bestScore = score; best = e; }
    }
    return best || null;
  }

  function fmtSize(n) {
    n = Number(n) || 0;
    if (n <= 0) return '';
    var u = ['GB', 'MB', 'KB'], v = n / (1 << 30), i = 0;
    if (v < 1) { v = n / (1 << 20); i = 1; }
    if (v < 1 && i === 1) { v = n / 1024; i = 2; }
    return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + u[i] || '';
  }

  function render(m, name) {
    var box = m.querySelector('#epsbox');
    if (!box) return;
    var e = findByName(name);
    if (!e || !e.eps) {
      box.innerHTML = '<div class="relhead">分集磁力</div><div class="eps-none">暂无按集索引</div>';
      return;
    }
    var nums = Object.keys(e.eps).map(Number).sort(function (a, b) { return a - b; });
    var h = '<div class="relhead">分集磁力 · ' + nums.length + ' 集（点击复制）</div>';
    nums.forEach(function (n) {
      var arr = e.eps[n] || [];
      if (!arr.length) return;
      var c = arr[0];
      var mg = String(c.m).replace(/"/g, '&quot;').replace(/&/g, '&amp;');
      var bits = [];
      if (c.s) bits.push(fmtSize(c.s));
      if (c.sd) bits.push(c.sd + ' 种');
      if (c.sub) bits.push(c.sub);
      h += '<span class="eps-chip" data-m="' + mg + '" title="' +
        String(c.t || '').replace(/"/g, '&quot;') + '">第 ' + n + ' 集' +
        (bits.length ? ' · ' + bits.join(' · ') : '') + '</span>';
    });
    box.innerHTML = h;
  }

  function arm() {
    var m = document.getElementById('modal');
    if (!m) return;
    if (m.__epsObs) return;
    m.__epsObs = true;
    new MutationObserver(function () {
      var h3 = m.querySelector('h3');
      if (!h3) return;
      var name = h3.textContent.trim();
      if (name === LAST_NAME && m.querySelector('#epsbox')) return;
      LAST_NAME = name;
      var host = m.querySelector('.acts') || m.querySelector('.mb');
      if (!host || host.parentNode.querySelector('#epsbox')) return;
      var box = document.createElement('div');
      box.className = 'relbox';
      box.id = 'epsbox';
      box.innerHTML = '<div class="relhead">分集磁力</div><div class="eps-none">索引加载中…</div>';
      host.parentNode.insertBefore(box, host.nextSibling);
      load().then(function () { render(m, name); });
    }).observe(m, { childList: true, subtree: false });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', arm);
  } else {
    arm();
  }
  document.addEventListener('DOMContentLoaded', arm);

  /* 测试钩子：让离线脚本能验证匹配逻辑（生产路径不使用） */
  window.__epsTest = { find: findByName, norm: norm, setIdx: function (d) { IDX = d; return IDX; } };
})();
