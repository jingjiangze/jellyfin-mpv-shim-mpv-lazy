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

  function norm(s) {
    s = String(s || '').toLowerCase();
    s = s.replace(/[（）【】：]/g, function (c) {
      return { '（': '(', '）': ')', '【': '[', '】': ']', '：': ':' }[c];
    });
    return s.replace(/[\s\-_.·・:：!！?？,，。'"()\[\]（）【】]/g, '');
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
    var best = null;
    for (var k in IDX) {
      var e = IDX[k];
      var nt = norm(e.n);
      if (!nt) continue;
      var hit = nt === q || (nt.indexOf(q) >= 0 && q.length >= 4) || (q.indexOf(nt) >= 0 && nt.length >= 4);
      if (hit && (!best || nt.length > norm(best.n).length)) best = e;
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
})();
