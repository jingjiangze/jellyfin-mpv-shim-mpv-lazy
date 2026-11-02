/* 分集磁力层（架构无关附加层）
 *
 * 不依赖任何一方的数据/key 体系：监听 #modal 的内容变化，从弹窗标题取片名，
 * 按片名查分集索引，把「第 N 集」chip 渲染进弹窗。
 *
 * 索引已分片：整份 7.5MB 在手机上首次点开卡片就要下完，太重。
 *   media/eps/index.json     清单（shards / count，几百字节）
 *   media/eps/s<NN>.json     按「片名哈希 % 16」切的分片，单份约 500KB
 * 客户端只拉当前片名所在的那一片。哈希函数必须与构建端（src/shard_eps.py）
 * 逐字符一致：都按 Unicode 码点、h = (h*31 + cp) mod 2^32。改一边必须改另一边。
 * 来源级联：gcore jsDelivr → gh-proxy → raw.githubusercontent。
 * 点 chip 复制磁力（页面有 __magnet 就复用，否则 navigator.clipboard）。
 */
(function () {
  'use strict';
  var ENTRY = null, LOADING = false, LAST_NAME = null, BASE_I = -1, MANIFEST = null;
  var BASES = [
    'https://gcore.jsdelivr.net/gh/jingjiangze/jellyfin-mpv-shim-mpv-lazy@main/media/eps/',
    'https://gh-proxy.com/https://raw.githubusercontent.com/jingjiangze/jellyfin-mpv-shim-mpv-lazy/main/media/eps/',
    'https://raw.githubusercontent.com/jingjiangze/jellyfin-mpv-shim-mpv-lazy/main/media/eps/'
  ];
  var SHARDS = 16;
  var CACHE = {};                      // shardNo -> { 归一化片名: 条目 }

  /* 与 src/shard_eps.py 的 shard_of 必须逐字节等价 */
  function hashOf(str) {
    var h = 0, i = 0, s = String(str || '');
    while (i < s.length) {
      var cp = s.codePointAt(i);
      i += cp > 0xffff ? 2 : 1;
      h = (h * 31 + cp) % 4294967296;
    }
    return h;
  }
  function shardOf(name) { return hashOf(String(name || '').trim()) % SHARDS; }

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

  /* 清单很小（几百字节），用它确认哪个源是活的；拿不到就整体降级成「暂无」。 */
  /* 每个请求都带超时：CF 边缘抖动时 fetch 会一直 pending，界面就卡在
     「索引加载中…」既不渲染也不降级（实测遇到过一次）。 */
  function getJSON(url, ms) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms || 9000);
    return fetch(url, ctl ? { signal: ctl.signal } : undefined).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }, function (e) {
      clearTimeout(timer);
      throw e;
    });
  }

  function loadManifest() {
    if (MANIFEST) return Promise.resolve(MANIFEST);
    var i = 0;
    return new Promise(function (resolve, reject) {
      (function next() {
        if (i >= BASES.length) return reject(new Error('no manifest'));
        var at = i++;
        getJSON(BASES[at] + 'index.json').then(function (m) {
          if (!m || !m.shards || !m.count) throw new Error('bad manifest');
          MANIFEST = m;
          BASE_I = at;
          resolve(m);
        }).catch(next);
      })();
    });
  }

  function loadShard(n) {
    if (CACHE[n]) return Promise.resolve(CACHE[n]);
    var order = [], i;
    if (BASE_I >= 0) order.push(BASE_I);
    for (i = 0; i < BASES.length; i++) if (order.indexOf(i) < 0) order.push(i);
    var k = 0;
    return new Promise(function (resolve, reject) {
      (function next() {
        if (k >= order.length) return reject(new Error('shard ' + n + ' unavailable'));
        var at = order[k++];
        getJSON(BASES[at] + 's' + (n < 10 ? '0' + n : n) + '.json').then(function (d) {
          if (!d) throw new Error('empty shard');
          CACHE[n] = d;
          resolve(d);
        }).catch(next);
      })();
    });
  }


  /* 静态索引没覆盖到的片名，直接问边缘函数（它在服务端代打 pan-hub）。
     返回与索引条目同形状；拿不到就 null，界面照常显示「暂无按集索引」。 */
  var LIVE = {}, LIVE_DOWN = false;

  /* ---- 按需查询：浏览器直接调 120.48.56.189 的 /eps（nginx 服务端注入
     BasicAuth，客户端拿不到凭据）。盒子未备案、域名入口被百度墙拦，但
     https://120.48.56.189/ 用的是 IP 证书、浏览器直接信任，所以跨域可用；
     nginx 那边已放行本站来源的 CORS。---- */
  var LIVE_URL = 'https://120.48.56.189/eps';

  /* 以下过滤规则与构建端 site-src/index_eps.py 一一对应：
     噪声（音乐单曲/整卷/合集）、整季包、剧场版、季号一致性、话数上限。
     改一边必须改另一边，否则「按需取的」和「预建的」口径会飘。 */
  var RE_RANGE = /第\s*(\d{1,4})\s*[-–~〜]\s*(\d{1,4})\s*[話话集]/;
  var RE_SINGLE = /第\s*(\d{1,4})\s*[話话集](?!\d)/;
  var RE_BRACKET = /[\]\)\s\-–—]\s*\[?(\d{1,4})\]?(?=\s*(?:\[|\(|END|完|【|v\d|$))/;
  var RE_EP = /(?:^|[\s\-–—\[])E[P]?(\d{1,4})/i;
  var RE_DASH = /\s-\s*(\d{1,4})(?:v\d)?\s*(?:\[|\(|$)/;
  var NOISE = /(OP\d?テーマ|ED\d?テーマ|OPテーマ|EDテーマ|主題歌|主题歌|挿入歌|オリジナルサウンドトラック|サントラ|Soundtrack|\bBatch\b|全集|合集|Complete|BDBOX|BOX\s*SET|DVDISO|BDISO|\bvol\.?\s*\d+|\d+\s*[巻卷]|漫画|コミック|小説|小说)/i;
  var RE_PACK = /[\[\(【]\s*\d{1,3}\s*[-–~〜]\s*\d{1,3}\s*[\]\)】]|\b\d{1,3}\s*[-–~〜]\s*\d{1,3}\s*[话話集]/;

  function parseEpsTitle(t) {
    var m = RE_RANGE.exec(t);
    if (m) {
      var a = +m[1], b = +m[2], out = [];
      if (b - a < 0 || b - a > 200) return out;
      for (var i = a; i <= b; i++) out.push(i);
      return out;
    }
    var rxs = [RE_SINGLE, RE_DASH, RE_EP, RE_BRACKET];
    for (var k = 0; k < rxs.length; k++) {
      var x = rxs[k].exec(t);
      if (x) {
        var n = +x[1];
        return (n > 0 && n <= 999) ? [n] : [];
      }
    }
    return [];
  }

  function buildEps(name, epsN, results) {
    var q = norm(name), qs = seasonsOf(name), short = q.length <= 3;
    var cand = {};
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var t = String(r.title || r.name || '');
      if (!t || NOISE.test(t) || RE_PACK.test(t)) continue;
      if (epsN && epsN <= 2) break;                 // 剧场版/OAD 不给分集
      var mg = String(r.magnet || r.m || '');
      if (mg.indexOf('magnet:') !== 0) continue;
      var nt = norm(t);
      if (!(q && nt.indexOf(q) >= 0)) continue;
      if (short) {
        var esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (!new RegExp('[\\[\\]【】()（）\\s\\-_/]' + esc + '[\\[\\]【】()（）\\s\\-_/]').test(t)) continue;
      }
      if (!sameSeasons(qs, seasonsOf(t))) continue;
      var nums = parseEpsTitle(t);
      if (!nums.length || nums.length > 3) continue;
      var item = {
        m: mg,
        s: Number(r.size || 0),
        sd: Number(r.seeders || 0),
        sub: String(r.subs || r.sub || '').slice ? String(r.subs || r.sub || '').slice(0, 12) : '',
        t: t.slice(0, 120)
      };
      for (var j = 0; j < nums.length; j++) {
        var n = nums[j];
        if (epsN && n > epsN + 2) continue;
        (cand[n] = cand[n] || []).push(item);
      }
    }
    var eps = {};
    for (var key in cand) {
      cand[key].sort(function (a, b) { return (b.sd - a.sd) || (b.s - a.s); });
      eps[key] = cand[key].slice(0, 2);
    }
    return eps;
  }
  function episodeCount(m) {
    var dts = m.querySelectorAll('.infobox dt');
    for (var i = 0; i < dts.length; i++) {
      if (String(dts[i].textContent).indexOf('话数') >= 0) {
        var dd = dts[i].nextElementSibling;
        var n = parseInt(String(dd && dd.textContent || '').replace(/[^0-9]/g, ''), 10);
        return isNaN(n) ? 0 : n;
      }
    }
    return 0;
  }
  function fetchLive(name, epsN) {
    if (LIVE[name]) return Promise.resolve(LIVE[name]);
    var u = LIVE_URL + '?kw=' + encodeURIComponent(name);
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 15000);
    return fetch(u, ctl ? { signal: ctl.signal } : undefined).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (d) {
      var eps = buildEps(name, epsN, (d && d.results) || []);
      if (!Object.keys(eps).length) return null;
      var e = { n: name, eps: eps, live: 1 };
      LIVE[name] = e;
      return e;
    }).catch(function () { LIVE_DOWN = true; return null; });
  }

  function resolveEntry(name) {
    if (!name) return Promise.resolve(null);
    var n = shardOf(name);
    return loadManifest().then(function () { return loadShard(n); })
      .then(function (d) { return findByName(d, name); })
      .catch(function () { return null; });
  }

  function findByName(store, name) {
    if (!store || !name) return null;
    var q = norm(name);
    if (!q) return null;
    var qs = seasonsOf(name);
    var best = null, bestScore = 0;
    for (var k in store) {
      var e = store[k];
      var nt = norm(e && e.n);
      if (!nt) continue;
      /* 优先级：完全相同 > 片名被发布名包含 > 发布名被片名包含（后者要求长度占比）。
         归一化后相同的片名可能不止一部（「工作细胞」与「工作细胞!!」都归一成同一串），
         此时按「原始字符串完全相同」再压一层，别让 A 的磁力挂到 B 上。 */
      var score = 0;
      if (nt === q) score = (String(e.n).trim() === String(name).trim()) ? 2000 : 1000;
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

  function render(m, e) {
    var box = m.querySelector('#epsbox');
    if (!box) return;
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
      resolveEntry(name).then(function (e) {
        if (e && e.eps && Object.keys(e.eps).length) return render(m, e);
        box.innerHTML = '<div class="relhead">分集磁力</div><div class="eps-none">索引里没有，正在向后端查询…</div>';
        return fetchLive(name, episodeCount(m)).then(function (live) {
          if (live) return render(m, live);
          if (LIVE_DOWN) {                       // 后端连不上：说清楚，别装作"没有"
            box.innerHTML = '<div class="relhead">分集磁力</div><div class="eps-none">索引里没有，后端暂时连不上</div>';
            return;
          }
          render(m, e);
        });
      });
    }).observe(m, { childList: true, subtree: false });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', arm);
  } else {
    arm();
  }
  document.addEventListener('DOMContentLoaded', arm);

  /* 测试钩子：让离线脚本能验证匹配 / 分片逻辑（生产路径不使用） */
  window.__epsTest = {
    find: findByName,
    norm: norm,
    shardOf: shardOf,
    hashOf: hashOf,
    setIdx: function (d) { ENTRY = d; return ENTRY; },
  };
})();
