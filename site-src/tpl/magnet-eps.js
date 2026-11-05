/* 分集磁力层（架构无关附加层）
 *
 * 不依赖任何一方的数据/key 体系：监听 #modal 的内容变化，从弹窗标题取片名，
 * 按片名查分集索引，按字幕组渲染成可折叠的行式列表
 * （.tgs > .mgteam[data-open] > .tg-h + .mgrows > .mgrow），不再分「分集 / 整季」两段。
 * 组名口径：条目 g 键（后端算）→ 发布标题前缀 `[组名]` / `【组名】` → 「其他」。
 * 自动向后端透传只在当季发生（只读 window.__CUR_SEASON；undefined = 还没判定 = 允许）；
 * 非当季要透传只能点详情页 ⟳（window.__epsApi.reload）。
 * 取源顺序：打开详情页时静态分片与后端 SQLite（/eps?db=1，no-store 无副作用）**并行**发，
 * 先到先画、后到者条目数严格更多才重画；两边都空才按当季规则透传完整 /eps。
 *
 * 索引已分片：整份 7.5MB 在手机上首次点开卡片就要下完，太重。
 *   media/eps/index.json     清单（shards / count，几百字节）
 *   media/eps/s<NN>.json     按「片名哈希 % 16」切的分片，单份约 500KB
 * 客户端只拉当前片名所在的那一片。哈希函数必须与构建端（src/shard_eps.py）
 * 逐字符一致：都按 Unicode 码点、h = (h*31 + cp) mod 2^32。改一边必须改另一边。
 * 来源级联：gcore jsDelivr → gh-proxy → raw.githubusercontent。
 * 点行复制磁力（navigator.clipboard 优先，失败回退 execCommand）。
 */
(function () {
  'use strict';
  var ENTRY = null, LOADING = false, LAST_NAME = null, BASE_I = -1, MANIFEST = null;
  var REV = '';                        // reload() 期间的时间戳：只用于绕 HTTP 缓存
  /* 刷新代号：每次 reload() 自增。打开详情页时发出的 A/B 在发起时记下当时的 EPOCH，
     响应回来若已不是最新代号就整条作废（慢网下它可能比刷新结果更晚到）。 */
  var EPOCH = 0;
  /* 当前注入的 #epsbox 与它的渲染状态（{ e, cnt, ... }，arm() 里创建）。
     reload() 拿新结果覆盖后要同步它，否则随后的旧响应会因「行数更多」把刷新盖回去。 */
  var CUR_BOX = null, CUR_STATE = null;
  var BASES = [
    /* 数据集为主源：国内 CDN，实测 0.2–0.5s；后续几个只作兜底 */
    'https://modelscope.cn/datasets/jingjiangze/Anime-JPG/resolve/master/assets/eps/',
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
      var n = 0;
      if (d) n = Number(d[0]);
      else { /* 「第二季」末字是「季」不是「二」，先剥掉修饰字再查数字表 */
        var core = raw.replace(/[第季期部分]/gi, '').trim();
        n = NUM[core.charAt(core.length - 1)] || 0;
      }
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

  /* 防缓存参数。优先级：reload() 的时间戳（REV）> 构建版本（MANIFEST.v）> 不带。
     时间戳必须在最前：线上清单一直带 `{"v":2,...}`，若让 v 优先，⟳ 刷新取到的
     仍是同一个 URL，浏览器/CDN 缓存原样返回，刷新按钮就成了摆设。
     BASES 全部以 `/` 结尾，query 必须接在文件名后面，别缀到目录上。 */
  function bustUrl() {
    if (REV) return '?v=' + REV;
    if (MANIFEST && MANIFEST.v) return '?v=' + encodeURIComponent(String(MANIFEST.v));
    return '';
  }

  function loadManifest() {
    if (MANIFEST) return Promise.resolve(MANIFEST);
    var i = 0;
    return new Promise(function (resolve, reject) {
      (function next() {
        if (i >= BASES.length) return reject(new Error('no manifest'));
        var at = i++;
        getJSON(BASES[at] + 'index.json' + bustUrl()).then(function (m) {
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
        getJSON(BASES[at] + 's' + (n < 10 ? '0' + n : n) + '.json' + bustUrl()).then(function (d) {
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
  /* 401（实时查询要登录）与「后端连不上」必须分开：前者置 NEED_LOGIN、**不动** LIVE_DOWN，
     否则界面会把「没登录」报成「后端暂时连不上」。reload() 每次开头清掉，手动重试。 */
  var NEED_LOGIN = false;

  /* ---- 按需查询：浏览器直接调 120.48.56.189 的 /eps（nginx 服务端注入
     BasicAuth，客户端拿不到凭据）。盒子未备案、域名入口被百度墙拦，但
     https://120.48.56.189/ 用的是 IP 证书、浏览器直接信任，所以跨域可用；
     nginx 那边已放行本站来源的 CORS。---- */
  var LIVE_URL = 'https://120.48.56.189/eps';

  /* 实时查询要登录：token 由 90-boot.js 的登录面板写入 localStorage['gh_token']。
     本文件是独立 IIFE，拿不到 90-boot.js 的 authToken()，故各写一份。
     `db=1`（纯 SQLite 查询）匿名可用，不要带这个头。 */
  var TOKEN_KEY = 'gh_token';
  function authToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  /* 以下过滤规则与构建端 site-src/index_eps.py 一一对应：
     噪声（音乐单曲/整卷/合集）、整季包、剧场版、季号一致性、话数上限。
     改一边必须改另一边，否则「按需取的」和「预建的」口径会飘。 */
  var RE_RANGE = /第\s*(\d{1,4})\s*[-–~〜]\s*(\d{1,4})\s*[話话集]/;
  var RE_SINGLE = /第\s*(\d{1,4})\s*[話话集](?!\d)/;
  var RE_BRACKET = /[\]\)\s\-–—]\s*\[?(\d{1,4})\]?(?=\s*(?:\[|\(|END|完|【|v\d|$))/;
  var RE_EP = /(?:^|[\s\-–—\[])[Ee][Pp]?(\d{1,4})\b/i;
  var RE_DASH = /\s-\s*(\d{1,4})(?:v\d)?\s*(?:\[|\(|$)/;
  /* SxxExx 发布名（如「xxx - S01E05 1080p」）；集号取 E 后面的数字（分组 2）。
     前缀用 (?:^|[^A-Za-z]) 而不是 (?![A-Za-z])：前瞻检查的是 S 自己那个位置
     （必然是字母）→ 永远不命中；也不用后行断言，老 Safari 会直接解析报错。 */
  var RE_SXXEXX = /(?:^|[^A-Za-z])S(\d{1,2})\s*E(\d{1,4})\b/i;
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
    var rxs = [RE_SINGLE, RE_DASH, RE_EP, RE_SXXEXX, RE_BRACKET];
    for (var k = 0; k < rxs.length; k++) {
      var x = rxs[k].exec(t);
      if (x) {
        var n = +(x[2] != null ? x[2] : x[1]);   // SxxExx 取 E 后面的集号
        return (n > 0 && n <= 999) ? [n] : [];
      }
    }
    return [];
  }

  function buildEps(name, orig, epsN, results) {
    var q = norm(name), qo = norm(orig), qs = seasonsOf(name), short = q.length <= 3;
    var onlyBatch = !!(epsN && epsN <= 2);   // 剧场版/OAD：只留合集，不给分集
    var cand = {}, batch = [];
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var t = String(r.title || r.name || '');
      if (!t || NOISE.test(t)) continue;
      var pack = RE_PACK.test(t);
      var mg = String(r.magnet || r.m || '');
      if (mg.indexOf('magnet:') !== 0) continue;
      var nt = norm(t);
      var hitCn = q && nt.indexOf(q) >= 0;
      var hitOrig = qo && qo.length >= 4 && nt.indexOf(qo) >= 0;
      if (!hitCn && !hitOrig) continue;
      if (short) {
        var esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (!new RegExp('[\\[\\]【】()（）\\s\\-_/]' + esc + '[\\[\\]【】()（）\\s\\-_/]').test(t)) continue;
      }
      if (!sameSeasons(qs, seasonsOf(t))) continue;
      var nums = parseEpsTitle(t);
      var item = {
        m: mg,
        s: Number(r.size || 0),
        sd: Number(r.seeders || 0),
        sub: String(r.subs || r.sub || '').slice ? String(r.subs || r.sub || '').slice(0, 12) : '',
        t: t.slice(0, 120)
      };
      /* 合集包（[01-12]、Batch）与解析不出集号的单文件都进 batch 兜底：
         新番早期往往只有这两种资源，丢了就等于「暂无按集索引」。 */
      if (pack || !nums.length) { batch.push(item); continue; }
      if (nums.length > 3) { batch.push(item); continue; }  // 一条命中多集：与后端 packs 口径一致，进合集
      if (onlyBatch) continue;              // epsN<=2：只收 batch，不写分集
      for (var j = 0; j < nums.length; j++) {
        var n = nums[j];
        /* 不再用「<= 目录话数 + 2」过滤：很多片用连续编号（黄金神威最终章
           目录 13 集、发布名是第 60 集），那条上限会把整片判成无结果。
           「剧场版/OVA 不给分集」已由上面的 onlyBatch 规则兜住。 */
        (cand[n] = cand[n] || []).push(item);
      }
    }
    var eps = {};
    for (var key in cand) {
      cand[key].sort(function (a, b) { return (b.sd - a.sd) || (b.s - a.s); });
      eps[key] = cand[key].slice(0, 2);
    }
    batch.sort(function (a, b) { return (b.sd - a.sd) || (b.s - a.s); });
    return { eps: eps, batch: batch };
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
  /* force=1：跳过服务端 SQLite、强制重查上游并写回（详情页 ⟳ 用）。
     强制刷新时不读 LIVE 缓存，但仍以最新结果覆盖它。 */
  function fetchLive(name, epsN, orig, force) {
    if (!force && LIVE[name]) return Promise.resolve(LIVE[name]);
    var u = LIVE_URL + '?kw=' + encodeURIComponent(name);
    if (orig) u += '&o=' + encodeURIComponent(orig);
    if (force) u += '&force=1';
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 15000);
    /* 登录态才带头：没 token 时连 headers 都不给（保持匿名简单请求的原样） */
    var tk = authToken();
    var opt = {};
    if (ctl) opt.signal = ctl.signal;
    if (tk) opt.headers = { authorization: 'Bearer ' + tk };
    return fetch(u, opt).then(function (r) {
      clearTimeout(timer);
      /* 401 = 实时查询要登录（后端已强制），不是网络故障：置 NEED_LOGIN，
         并让错误带上 status，下面的 catch 才不会把它记成 LIVE_DOWN。 */
      if (r.status === 401) {
        NEED_LOGIN = true;
        var e401 = new Error('login_required');
        e401.status = 401;
        throw e401;
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (d) {
      /* 服务端现在优先查 SQLite，命中就直接回 {eps}；未命中才走上游并回 {eps}。
         两种形状都兼容：有 eps 就用，没有就退回本地过滤（旧版 responses）。 */
      var eps = (d && d.eps && Object.keys(d.eps).length) ? d.eps : null;
      var batch = (d && d.batch) || [];
      if (!eps) {
        var b = buildEps(name, orig, epsN, (d && d.results) || []);
        eps = b.eps;
        if (!batch.length) batch = b.batch;
      }
      /* 只有整季包、没有可按集索引的片名（早期新番常见）也要保留条目 */
      if (!Object.keys(eps).length && !batch.length) return null;
      var e = { n: name, eps: eps, batch: batch, live: 1 };
      LIVE[name] = e;
      /* 回传给服务器队列：CI 每轮把它并进静态索引，下次就是静态命中。
         入库同样要登录态（带 Bearer）；text/plain 仍是简单请求，浏览器不预检。 */
      try {
        var tk2 = authToken();
        var hdr2 = { 'content-type': 'text/plain;charset=UTF-8' };
        if (tk2) hdr2.authorization = 'Bearer ' + tk2;
        var ctl2 = typeof AbortController === 'function' ? new AbortController() : null;
        var t2 = setTimeout(function () { if (ctl2) ctl2.abort(); }, 8000);
        fetch(LIVE_URL + '-save', {
          method: 'POST',
          headers: hdr2,
          body: JSON.stringify({ n: name, eps: eps, batch: (e && e.batch) || [] }),
          signal: ctl2 ? ctl2.signal : undefined
        }).then(function (r) {
          clearTimeout(t2);
          /* 现在真的看 r.ok（旧代码连状态码都不读，401 被当成功）：失败只是这次没入库，
             静默吞掉、不打断已渲染内容，也不再假装成功。 */
          if (!r || !r.ok) return;
        }, function () { clearTimeout(t2); });
      } catch (err) { /* 忽略：只是入库，不影响展示 */ }
      return e;
    }).catch(function (err) {
      /* 401 是「要登录」，不是「后端挂了」：只置 NEED_LOGIN，别碰 LIVE_DOWN，
         否则界面会把没登录报成后端暂时连不上。 */
      if (err && err.status === 401) { NEED_LOGIN = true; return null; }
      LIVE_DOWN = true;
      return null;
    });
  }

  /* 只查服务端 SQLite（db=1）：响应 no-store、不打上游、不写库，所以和静态分片
     并行发是安全的（无副作用）。命中/未命中都只想抢个先手：未命中、坏响应、
     SQLite 挂掉一律 null，**不置 LIVE_DOWN**（库挂了不该把整条透传关掉）。 */
  function dbLive(name, bgm) {
    /* `&_=` 破缓存：服务端给了 cache-control: no-store，但 nginx 在同一个响应上
       **又**加了一条 `Cache-Control: public, max-age=600`（双头并存），CF 有可能按
       后者缓存 —— 那样「点进详情先读 SQLite」会读到 10 分钟前的库。URL 每次不同即
       绕开，代价只是这条请求不复用缓存（SQLite 命中本来就只有几毫秒）。 */
    var u = LIVE_URL + '?kw=' + encodeURIComponent(name) + '&db=1&_=' + Date.now();
    /* bgm = Bangumi 条目 id，带上它后端就能按 id 直取，不再走
       `LIKE '%kw%' ORDER BY length(n_norm) LIMIT 1`（那会取到「名字最短的包含者」，
       实测「海贼王」查回「海贼王女」的 12 条）。没拿到 id 时保持原查询不变。 */
    if (bgm) u += '&bgm=' + encodeURIComponent(bgm);
    return getJSON(u, 9000).then(function (d) {
      /* miss:true 是「库里没有」，ok:false 视作坏响应；两者都当空 */
      if (!d || d.miss || d.ok === false) return null;
      var eps = (d.eps && Object.keys(d.eps).length) ? d.eps : {};
      var batch = d.batch || [];
      if (!Object.keys(eps).length && !batch.length) return null;
      return { n: name, eps: eps, batch: batch, db: 1, key: d.key || '' };
    }).catch(function () { return null; });
  }

  function resolveEntry(name, bgm) {
    if (!name) return Promise.resolve(null);
    var n = shardOf(name);
    return loadManifest().then(function () { return loadShard(n); })
      .then(function (d) {
        /* 身份准绳是 bgm id：分片就是 { bgm id 字符串: 条目 }（70-modal.js 的磁力视图也按
           String(id) 直取）。按 id 命中即用，片名重名/包含名不会串台；分片是按片名哈希
           切的，id 可能落在别的分片，故未命中仍回落到 findByName。 */
        var byId = bgm ? (d && d[String(bgm)]) : null;
        if (byId) { byId.key = String(bgm); return byId; }
        return findByName(d, name);
      })
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

  /* 先转 & 再转引号，否则 &quot; 会被二次转义成 &amp;quot; */
  function escAttr(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }

  /* 上游把 Python 列表 str() 成了 "['中']" / "['无']"（实测 16,681/30,485 条）；
     只放行纯字幕语言串，其余一律当没有。 */
  function cleanSub(s) {
    s = String(s || '').replace(/[\[\]'"\s]/g, '');
    return /^[无中简繁英日]+$/.test(s) ? s : '';
  }

  /* 胶囊渲染（兼容层）：分集/合集行已改走 rowOf，这里只为还调用 chipOf 的旧代码
     （如 openMagView 的合集段）保留原样，不再由本文件产出。 */
  function chipOf(c, label) {
    var mg = escAttr(c.m);
    var bits = [], sub = cleanSub(c.sub);
    if (c.s) bits.push(fmtSize(c.s));
    if (c.sd) bits.push(c.sd + ' 种');
    if (sub) bits.push('字幕 ' + sub);   // 不带字段名时「· 无 / · 中」看不出是什么
    return '<span class="eps-chip" role="button" tabindex="0" data-m="' + mg + '" title="' +
      escAttr(c.t) + '">' + label +
      (bits.length ? ' · ' + bits.join(' · ') : '') + '</span>';
  }

  /* 合集包标题里的集数范围：优先显示「合集 01–12」，没范围才退回序号。 */
  var RE_BATCH_RANGE = /\[\s*(\d{1,3})\s*[-–~〜]\s*(\d{1,3})\s*(?:END|完)?\s*\]/i;
  var RE_BATCH_RANGE_CN = /第\s*(\d{1,3})\s*[-–~〜]\s*(\d{1,3})\s*[话話集]/;
  function pad2(n) { return String(n).length < 2 ? '0' + n : String(n); }
  function batchLabel(c, i) {
    var t = String((c && c.t) || '');
    var m = RE_BATCH_RANGE.exec(t) || RE_BATCH_RANGE_CN.exec(t);
    if (m) {
      var a = +m[1], b = +m[2];
      if (b > a) return '合集 ' + pad2(a) + '–' + pad2(b);
    }
    return '合集 ' + (i + 1);
  }

  /* 每条磁力自己的发布标题就是最好的描述（用户要求：不要「线路 1/线路 2」这种人造标签）。
     descOf 只负责折空白 + 短标题，仍供外部调用方（batchLabel + desc 的旧组合）使用；
     分集/合集行本身用完整标题，单行省略交给 CSS（.mgt）。
     同一集仍最多 3 条（buildEps 已按做种/体积排过序），每条各占一行。 */
  function descOf(c, max) {
    var t = String((c && c.t) || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    return t.length > max ? t.slice(0, max) + '…' : t;
  }

  /* 文本节点转义：发布标题里实测出现过 & < >，属性另走 escAttr（那只管 & 和 "） */
  function escText(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* 元信息：体积 · 做种数 · 字幕（沿用 chipOf 的老格式，字段间用 ` · `） */
  function metaOf(c) {
    var bits = [], sub = cleanSub(c && c.sub);
    if (c && c.s) bits.push(fmtSize(c.s));
    if (c && c.sd) bits.push(c.sd + ' 种');
    if (sub) bits.push('字幕 ' + sub);   // 不带字段名时「· 无 / · 中」看不出是什么
    return bits.join(' · ');
  }

  /* 一行 = <button class="mgrow" data-m>：集号 / 「合集」+ 完整标题 + 元信息 + 复制。
     data-ep 只在分集行输出（数字集号）；合集行没有单集号，缺省不输出该属性 ——
     点行上报追番进度（onChip → window.__prog）只认分集行。
     点击复制由 arm() 挂在 #modal 上的委托接管（认 .mgrow 与旧 .eps-chip）。 */
  function rowOf(c, idx, ep) {
    var t = String((c && c.t) || '').replace(/\s+/g, ' ').trim();
    return '<button class="mgrow" type="button" data-m="' + escAttr(c && c.m) + '"'
      + (ep == null || ep === '' ? '' : ' data-ep="' + escAttr(ep) + '"')
      + (t ? ' title="' + escAttr(t) + '"' : '') + '>'
      + '<span class="mgidx">' + escText(idx) + '</span>'
      + '<span class="mgmain"><span class="mgt">' + escText(t) + '</span>'
      + '<span class="mgmeta">' + escText(metaOf(c)) + '</span></span>'
      + '<span class="mgcopy">复制</span>'
      + '</button>';
  }

  /* 一段 = .mgsect（.sec-h 区块标题 + .mgrows 行容器），与 DESIGN-SPEC §2.3 逐字一致 */
  function sectHtml(title, sub, rows) {
    return '<div class="mgsect"><div class="sec-h"><h2>' + escText(title) + '</h2>'
      + '<span class="sec-sub">' + escText(sub) + '</span></div>'
      + '<div class="mgrows">' + rows + '</div></div>';
  }

  /* ---------------- 字幕组分组（纯函数，无副作用，可离线单测） ----------------
     条目只有 { m, s, sd, sub, t }（后端新增 g），组名多数只能从发布标题前缀取：
     实测 95% 的发布名以 `[组名]` / `【组名】` 开头。 */

  var G_OTHER = '其他';
  /* 前缀：[组名] / 【组名】，1–40 字且不含括号本身 */
  var RE_GPREFIX = /^[\[【]([^\]】]{1,40})[\]】]/;

  /* 前缀清洗：去首尾 【】[] 残片（`[【A】]` 会把 `【A` 抓进捕获组）；
     分隔符两侧空格归一（`[Lilith - Raws]` 与 `[Lilith-Raws]` 落同一组）；
     连续空格折叠成一个、**不删**（`[Nekomoe kissaten]` 要正常显示，不能挤成
     `Nekomoekissaten`）；清完是空串时由调用方兜底成「其他」。 */
  function cleanGroupName(raw) {
    var s = String(raw == null ? '' : raw).trim();
    s = s.replace(/^[\[\]【】\s]+/, '').replace(/[\[\]【】\s]+$/, '');
    s = s.replace(/\s*([\-–—_/~|&+·・])\s*/g, '$1');
    s = s.replace(/\s+/g, ' ');
    return s.trim();
  }

  /* 组名判定顺序：g 键 → 标题前缀 → 「其他」 */
  function groupNameOf(item) {
    var g = cleanGroupName(item && item.g);
    if (g) return g;
    var m = RE_GPREFIX.exec(String((item && item.t) || '').trim());
    return cleanGroupName(m && m[1]) || G_OTHER;
  }

  /* 集号：eps 映射的键优先；合集包（[01-12] / 第1-12话）与解析不出的返回 null → 排后面 */
  function epNoOf(item, hint) {
    var n = Number(hint);
    if (n > 0) return n;
    var t = String((item && item.t) || '');
    if (!t || RE_PACK.test(t)) return null;
    var nums = parseEpsTitle(t);
    return nums.length === 1 ? nums[0] : null;
  }

  /* 组排序：中文排序，「其他」恒在最后（不再靠 localeCompare 把汉字排到英文后碰运气） */
  function groupCmp(a, b) {
    if (a === b) return 0;
    if (a === G_OTHER) return 1;
    if (b === G_OTHER) return -1;
    return String(a).localeCompare(String(b), 'zh');
  }

  /* 组内排序：集号升序（合集垫底）→ 做种降序 → 体积降序 */
  function rowCmp(a, b) {
    var an = a.ep == null, bn = b.ep == null;
    if (an !== bn) return an ? 1 : -1;
    if (!an && a.ep !== b.ep) return a.ep - b.ep;
    var x = a.it || {}, y = b.it || {};
    return ((Number(y.sd) || 0) - (Number(x.sd) || 0))
      || ((Number(y.s) || 0) - (Number(x.s) || 0));
  }

  /* 两种入参形状 → 扁平行 [{ it, ep, lab }]
       { eps: { 集号: [条目] }, batch: [...] }（70-modal.js 的磁力视图 / 后端 live）
       (eps, batch)（旧调用）
     每个集号最多 3 条（旧口径）；batch 的行一律标「合集」，能解析出单个集号仍按集号排序。 */
  function collectRows(a, b) {
    var eps = {}, batch = [];
    if (a && typeof a === 'object' && ('eps' in a || 'batch' in a)) {
      eps = a.eps || {};
      batch = a.batch || [];
    } else {
      eps = a || {};
      batch = b || [];
    }
    var out = [];
    Object.keys(eps).forEach(function (k) {
      var n = Number(k);
      if (!(n > 0)) return;                     // 非数字键（NaN）跳过，与旧实现一致
      (eps[k] || []).slice(0, 3).forEach(function (c) {
        out.push({ it: c, ep: n, lab: pad2(n) });
      });
    });
    (batch || []).forEach(function (c) { out.push({ it: c, ep: epNoOf(c), lab: '合集' }); });
    return out;
  }

  /* 扁平行 → 组 [{ name, rows }]，组序按 groupCmp、组内按 rowCmp */
  function groupRows(rows) {
    var map = Object.create(null), names = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r) continue;
      var g = groupNameOf(r.it);
      if (!map[g]) { map[g] = []; names.push(g); }
      map[g].push(r);
    }
    names.sort(groupCmp);
    return names.map(function (g) {
      return { name: g, rows: map[g].slice().sort(rowCmp) };
    });
  }

  /* 默认展开：组数 ≤ 6 全展开；> 6 只展开条目数最多的前 3 组（并列按组名序） */
  function defaultOpen(groups) {
    var open = Object.create(null), i;
    if (groups.length <= 6) {
      for (i = 0; i < groups.length; i++) open[groups[i].name] = 1;
      return open;
    }
    var top = groups.map(function (g, j) { return j; })
      .sort(function (p, q) { return groups[q].rows.length - groups[p].rows.length; })
      .slice(0, 3);
    for (i = 0; i < top.length; i++) open[groups[top[i]].name] = 1;
    return open;
  }

  /* 全部组 → .tgs 容器。组头切换与行复制都走 arm() 挂在 #modal 上的委托。 */
  function tgsHtml(groups) {
    if (!groups.length) return '';
    var open = defaultOpen(groups), h = '<div class="tgs">';
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i], rows = '';
      /* 第三参只传分集行：batch（合集包）的 lab 是「合集」，即便标题能解析出单集号
         也不代表「看到第 N 集」，一律传 null 让 rowOf 不输出 data-ep。 */
      for (var j = 0; j < g.rows.length; j++) {
        rows += rowOf(g.rows[j].it, g.rows[j].lab, g.rows[j].lab === '合集' ? null : g.rows[j].ep);
      }
      h += '<div class="mgteam" data-open="' + (open[g.name] ? '1' : '0') + '">'
        + '<button class="tg-h" type="button" data-tg="' + escAttr(g.name) + '">'
        + '<span class="tg-n">' + escText(g.name) + '</span>'
        + '<span class="tg-c">' + g.rows.length + '</span>'
        + '<span class="tg-x">›</span>'
        + '</button>'
        + '<div class="mgrows">' + rows + '</div>'
        + '</div>';
    }
    return h + '</div>';
  }

  /* 按字幕组分组渲染（替换旧的「分集磁力」+「整季 / 合集」两段）。
     入参两种形状都吃：
       epsListHtml(entry)       { eps: { 集号: [条目] }, batch: [...] }（70-modal.js 的磁力视图）
       epsListHtml(eps, batch)  旧调用：入参直接是 eps 映射，合集走第二个参数
     同一组的条目在同一个 .mgrows 里平铺，.mgidx 写集号或「合集」。 */
  function epsListHtml(a, b) {
    return tgsHtml(groupRows(collectRows(a, b)));
  }

  function render(m, e) {
    var box = m.querySelector('#epsbox');
    if (!box) return;
    /* 组头 + 行整段都由 epsListHtml 出（旧实现里「分集 / 整季 / 合集」两段拼接与
       「同范围多条追加来源 N」的文本处理一并收进分组渲染）。 */
    var h = epsListHtml(e);
    box.innerHTML = h || '<div class="mgsect"><div class="sec-h"><h2>分集磁力</h2></div>'
      + '<div class="eps-none">暂无按集索引</div></div>';
  }

  /* 入口带了可显示的内容吗：只有 batch、没有分集也算有 */
  function hasRows(e) {
    return !!(e && ((e.eps && Object.keys(e.eps).length) || (e.batch && e.batch.length)));
  }

  /* 条目数（与渲染同口径：collectRows 的行数）。两个数据源竞争时只有
     「严格多于已渲染行数」才允许重画，等量/更少一律忽略，避免列表闪一下。 */
  function epCount(e) {
    return e ? collectRows(e).length : 0;
  }

  /* 片名身份键：只折空白与大小写，保留标点符号。paint() 用它判断「这块框现在装的是不是
     同一部片」。不用现成的 norm()：它会把 ! ？ 【 】 一起去掉，《工作细胞》与《工作细胞!!》
     会被判成同一部，正好就是「把 A 的磁力画进 B」的错法；也不用严格 ===：DOM 文本可能有
     空白差异（全角空格 / 折叠空格），宁可少画也不能画错。 */
  function titleKey(s) {
    return String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();
  }
  function sameTitle(a, b) {
    var x = titleKey(a);
    return !!x && x === titleKey(b);
  }

  /* 磁力结果的身份：名字必须「同一条目」才允许画。
     放行三种：归一化后完全相同 / 只有季号章后缀差异 / 双方任一侧为空（拿不到名字时不拦）。
     归一化复用本文件既有的身份键 titleKey（sameTitle 用的同一套，见上面的说明），不另造第二套；
     不用 norm()：它会连 ! ？ 【 】 一起抹掉，《工作细胞》与《工作细胞!!》就成了同一个名字，
     那正是这里要拦的错法。季号/章后缀差异由下面的 strip 单独放行。 */
  function identityOk(a, b) {
    var x = titleKey(a), y = titleKey(b);
    if (!x || !y) return true;
    if (x === y) return true;
    var strip = function (s) {
      return s.replace(/(第[一二三四五六七八九十0-9]{1,2}[季期部])|(season[0-9]{1,2})|(s[0-9]{1,2})|(part[0-9]{1,2})|([0-9]{1,2})|([ivx]{1,3})$/g, '');
    };
    var xs = strip(x), ys = strip(y);
    return !!xs && !!ys && (xs === ys || (xs.length >= 4 && ys.indexOf(xs) === 0) || (ys.length >= 4 && xs.indexOf(ys) === 0));
  }

  /* 把入口画进当前弹窗：详情页画 #epsbox；openMagView 那种整屏磁力视图画 #mgbody。
     画之前先核对身份：取 #modal 里 h3 的片名与本次请求的片名比对，不一致（或取不到）就直接
     返回不画 —— 刷新是 fire-and-forget、fetchLive 最长 15s，这期间用户完全可能已经打开另一部番，
     旧结果必须整条丢掉。返回是否真的画了（reload 靠它决定要不要同步 state）。 */
  function paint(e, titleHint) {
    var m = document.getElementById('modal');
    if (!m) return false;
    var h3 = m.querySelector('h3');
    var cur = h3 ? String(h3.textContent == null ? '' : h3.textContent).trim() : '';
    /* 比对基准优先用调用方给的本次请求片名（详情页 title），没有才退回 e.n。
       为什么不是只用 e.n：`resolveEntry` 交回来的是**分片里的索引名**（如
       「进击的巨人 最终季 完结篇」），而 h3 显示的是站点标题（r[2]||r[1]），
       两者在该片名上未必逐字相同 —— 只用 e.n 会把「刷新失败后回落静态分片」
       这条路也一并误杀。 */
    if (!sameTitle(cur, titleHint || (e && e.n))) return false;
    if (m.querySelector('#epsbox')) { render(m, e); return true; }
    var body = m.querySelector('#mgbody');
    if (body) {
      var h = epsListHtml(e);
      body.innerHTML = h || '<div class="eps-none">暂无按集索引</div>';
      return true;
    }
    return false;
  }

  /* reload() 的成功结果落地后，把「当前已渲染」推进到这份新结果：还在飞的旧响应随后到达时，
     即使行数更多也过不了 take() 的 state.cnt 比较（与 epoch 守卫互为兜底）。 */
  function syncState(e) {
    if (!CUR_STATE || !CUR_BOX || !CUR_BOX.parentNode) return false;
    var m = document.getElementById('modal');
    if (!m || m.querySelector('#epsbox') !== CUR_BOX) return false;
    CUR_STATE.e = e;
    CUR_STATE.cnt = epCount(e);
    CUR_STATE.got = true;
    return true;
  }

  /* 手动刷新（详情页 ⟳）：清掉该片名的全部缓存层 → 分片（A）与 `force=1` 完整查询
     并行（force 跳过 SQLite、强制重查上游并写回，回灌仍走 fetchLive 里的 /eps-save）。
     force 拿到内容就以它为准；force 空/失败则回落到 A 的结果，而不是直接显示错误。
     刷新不受 __CUR_SEASON 限制。orig 是本片原名（中文标题与发布名差得远时全靠它命中）。
     返回 Promise，resolve 为最终入口或 null，不 reject。 */
  function reload(name, epsN, orig) {
    var n = String(name == null ? '' : name).trim();
    var o = String(orig == null ? '' : orig).trim();   // 两参旧调用 → ''，保持向后兼容
    if (!n) return Promise.resolve(null);
    EPOCH++;                            // 作废打开详情页时还在飞的 A/B（见 take 的 epoch 守卫）
    var my = EPOCH;
    delete LIVE[n];
    delete CACHE[shardOf(n)];
    MANIFEST = null;
    BASE_I = 0;
    LIVE_DOWN = false;
    NEED_LOGIN = false;                // 每次手动刷新都当「重新试一次登录」
    REV = String(Date.now());          // 本次刷新的清单/分片 URL 带 ?v= 绕 HTTP 缓存
    /* 占位只在框里还没有内容时写：已有内容保持不动，刷新失败也不会把列表清空
       （进度反馈由 70-modal.js 的 ⟳ 按钮文字负责）。 */
    var box = document.querySelector('#epsbox');
    var body = box ? null : document.querySelector('#mgbody');
    var phBox = null, phFail = '';
    if (box && !String(box.innerHTML || '').trim()) {
      phBox = box;
      phFail = '<div class="mgsect"><div class="sec-h"><h2>分集磁力</h2></div>'
        + '<div class="eps-none">磁力刷新失败，请重试</div></div>';
      box.innerHTML = '<div class="mgsect"><div class="sec-h"><h2>分集磁力</h2></div>'
        + '<div class="eps-none">正在刷新…</div></div>';
    } else if (body && !String(body.innerHTML || '').trim()) {
      phBox = body;
      phFail = '<div class="eps-none">磁力刷新失败，请重试</div>';
      body.innerHTML = '<div class="eps-none">正在刷新…</div>';
    }
    function done(e) {
      if (my !== EPOCH) return e || null;  // 期间又刷新了一次：这份结果作废，别回滚更新的那次
      REV = '';                          // 时间戳只作用于这一次刷新
      if (!e) {
        /* 刷新没拿到内容：说成「失败」，别伪装成「暂无按集索引」；框里已有内容就原样留着 */
        toast('磁力刷新失败，请重试');
        if (phBox && phBox.parentNode) phBox.innerHTML = phFail;
        return null;
      }
      if (!paint(e, n)) return e;         // 框里已经是别的番：宁可不画，也不串台
      syncState(e);                       // 行数与 state 推进到新结果，旧响应再也盖不回来
      return e;
    }
    var aP = resolveEntry(n);          // A：数据集分片（内部已 catch → null）
    return fetchLive(n, Number(epsN) || 0, o, 1).then(function (live) {
      if (hasRows(live)) return live;  // 强制查询拿到内容：以最新结果为准
      return aP.then(function (a) {    // 否则回落分片，实在没有才交 null
        return hasRows(a) ? a : (live || a || null);
      });
    }).then(done, function () { return done(null); });
  }

  /* ---- 点击复制：clipboard API 优先，失败回退 execCommand。统一返回 Promise<boolean> ---- */
  function legacyCopy(txt) {
    var ta = null;
    try {
      ta = document.createElement('textarea');
      ta.value = txt;
      ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      return Promise.resolve(!!document.execCommand('copy'));
    } catch (err) {
      return Promise.resolve(false);
    } finally {
      if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
    }
  }

  function copyText(s) {
    var txt = String(s || '');
    if (!txt) return Promise.resolve(false);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(txt).then(function () { return true; }, function () {
          return legacyCopy(txt);
        });
      }
    } catch (err) { /* 非安全上下文等：直接走回退 */ }
    return legacyCopy(txt);
  }

  /* 同一个 toast 节点复用，连点不会堆一屏；用 setTimeout 淡出，不依赖动画事件 */
  function toast(msg) {
    var el = document.querySelector('.epstoast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'epstoast';
      el.style.cssText = 'position:fixed;left:50%;bottom:72px;transform:translateX(-50%);' +
        'z-index:9999;padding:9px 16px;border-radius:20px;font-size:13px;' +
        'background:rgba(0,0,0,.86);color:#fff;opacity:1;transition:opacity .3s;' +
        'pointer-events:none;max-width:80vw;text-align:center';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    el.__seq = (el.__seq || 0) + 1;
    var seq = el.__seq;
    if (el.__t1) clearTimeout(el.__t1);
    if (el.__t2) clearTimeout(el.__t2);
    el.__t1 = setTimeout(function () {
      if (el.__seq !== seq) return;
      el.style.opacity = '0';
      el.__t2 = setTimeout(function () {
        if (el.__seq !== seq) return;
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 320);
    }, 1600);
  }

  function arm() {
    var m = document.getElementById('modal');
    if (!m) return;
    if (m.__epsObs) return;
    m.__epsObs = true;
    /* 事件委托：弹窗内容会被反复重写，不能给行逐个绑。
       认 .mgrow（行式列表）与旧的 span 胶囊 .eps-chip（兼容层，还带 data-m）。 */
    /* 组头（.tg-h）只切 data-open。它不是 .mgrow，若放行到复制分支会读到空 data-m */
    function toggleTeam(h) {
      var g = h && h.closest ? h.closest('.mgteam') : null;
      if (!g) return false;
      g.setAttribute('data-open', g.getAttribute('data-open') === '1' ? '0' : '1');
      return true;
    }
    function onChip(ev) {
      var t = ev.target;
      /* 登录提示（401 时渲染的 .mnote-btn）：先于复制分支接走，别落到 data-m 空值那一步 */
      if (t && t.closest && t.closest('[data-login]')) {
        ev.preventDefault();
        ev.stopPropagation();
        if (window.__openLogin) window.__openLogin();
        return;
      }
      if (toggleTeam(t && t.closest ? t.closest('.tg-h') : null)) {
        ev.preventDefault();
        ev.stopPropagation();          // 别冒泡去触发卡片的开关逻辑
        return;
      }
      var c = t && t.closest && t.closest('.mgrow, .eps-chip');
      if (!c) return;
      ev.preventDefault();
      ev.stopPropagation();            // 别冒泡去触发卡片的开关逻辑
      var mg = c.getAttribute('data-m') || '';
      if (!mg) return;
      copyText(mg).then(function (ok) {
        toast(ok ? '已复制磁力链接' : '复制失败，请长按链接手动复制');
      });
      /* 复制成功与否都上报：点击本身就是「看到这集」的意图（列表只挂 #modal，
         data-bgm 由 70-modal.js 在打开详情时写入）。合集行没有 data-ep，这里自然跳过。 */
      var epAttr = c.getAttribute('data-ep');
      if (epAttr && window.__prog) {
        window.__prog.report(m.getAttribute('data-bgm'), Number(epAttr));
      }
    }
    m.addEventListener('click', onChip);
    m.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') return;
      /* .mgrow / .tg-h / .mnote-btn 都是 <button>，Enter/空格会原生发 click，这里只给旧的
         span 胶囊补键位，否则同一次按键既切换/复制/登录一次、又再走一遍委托 */
      var t = ev.target;
      if (t && t.closest && (t.closest('.mgrow') || t.closest('.tg-h') || t.closest('[data-login]'))) return;
      onChip(ev);
    });
    new MutationObserver(function () {
      var h3 = m.querySelector('h3');
      if (!h3) return;
      var name = h3.textContent.trim();
      if (name === LAST_NAME && m.querySelector('#epsbox')) return;
      LAST_NAME = name;
      /* 插入锚点：单栏区块流里磁力是最后一节，挂在 .mbody[data-p="detail"] 末尾
         （.acts 现在在 .mh-info 内部，插在它后面会落进封面右侧信息栏）。
         没有 .mbody 时（如 openMagView 那种整屏换内容的视图）退回旧的 .acts 相邻逻辑。 */
      var body = m.querySelector('.mbody[data-p="detail"]');
      var host = body ? null : (m.querySelector('.acts') || m.querySelector('.mb'));
      if (!body && !host) return;
      if ((body || host.parentNode).querySelector('#epsbox')) return;   // 已有就不重复插
      var box = document.createElement('div');
      box.className = 'relbox';
      box.id = 'epsbox';
      box.innerHTML = '<div class="mgsect"><div class="sec-h"><h2>分集磁力</h2></div>'
        + '<div class="eps-none">索引加载中…</div></div>';
      if (body) body.appendChild(box);
      else host.parentNode.insertBefore(box, host.nextSibling);
      /* 两条源并行：A = 数据集分片（resolveEntry，镜像备用），B = 服务端 SQLite
         （dbLive → /eps?db=1，无副作用）。先到先画；后到者条目数**严格多于**
         已渲染的才重画，等量/更少忽略（防闪烁）。A/B 都空才讨论透传。 */
      var state = { e: null, cnt: 0, live: false, settled: 0, got: false };
      var my = EPOCH;                 // 发起这次 A/B 的刷新代号：期间点过 ⟳ 就把结果作废
      CUR_BOX = box;                  // 供 reload() 把行数 / state 同步到最新结果
      CUR_STATE = state;
      var origEl = m.querySelector('.orig');
      var origName = origEl ? origEl.textContent.trim() : '';
      /* 本弹窗的 bgm 条目 id（openModal 写在 #modal 上）：查询与身份校验都以它为准 */
      var bgm = m.getAttribute('data-bgm') || '';
      /* 弹窗已被换片 / #epsbox 被重插：这次响应作废，别画进别人的框 */
      function stale() { return !box.parentNode || m.querySelector('#epsbox') !== box; }
      function take(e) {
        if (my !== EPOCH) return false;          // 这几条是刷新前发出的旧响应
        if (stale() || !hasRows(e)) return false;
        /* 按 bgm id 命中的结果是权威的：索引里的 n 可能是旧标题（如 975 写着「航海王」），
           不能因为名字漂移把正确结果丢掉；只有「按名字查到」的才做身份校验。 */
        var byId = !!(bgm && e && String(e.key || '') === String(bgm));
        if (!byId && !identityOk(e.n, name)) return false;
        var c = epCount(e);
        if (c <= state.cnt) return false;
        state.e = e;
        state.cnt = c;
        render(m, e);
        return true;
      }
      function finish() {
        /* A/B 都空：自动透传只限当季（__CUR_SEASON 由 70-modal.js 判定，
           undefined = 还没判定 = 允许）。非当季到此为止，要查只能点详情页 ⟳。
           刷新过就别再把「正在向后端查询…」写进已经换成新结果的框。 */
        if (my !== EPOCH || stale() || state.cnt || state.live) return;
        state.live = true;
        if (window.__CUR_SEASON === false) { render(m, state.e); return; }
        box.innerHTML = '<div class="mgsect"><div class="sec-h"><h2>分集磁力</h2></div>'
          + '<div class="eps-none">索引里没有，正在向后端查询…</div></div>';
        return fetchLive(name, episodeCount(m), origName).then(function (live) {
          if (stale()) return;
          if (live) return render(m, live);
          /* 401 先判：实时查询要登录，别报成「后端暂时连不上」。登录按钮由 #modal 上
             的点击委托（[data-login] 分支）接走，调 90-boot.js 暴露的 window.__openLogin。 */
          if (NEED_LOGIN) {
            box.innerHTML = '<div class="mgsect"><div class="sec-h"><h2>分集磁力</h2></div>'
              + '<div class="mnote">实时查询需登录 · '
              + '<button class="mnote-btn" type="button" data-login="1">登录</button></div></div>';
            return;
          }
          if (LIVE_DOWN) {                       // 后端连不上：说清楚，别装作"没有"
            box.innerHTML = '<div class="mgsect"><div class="sec-h"><h2>分集磁力</h2></div>'
              + '<div class="eps-none">索引里没有，后端暂时连不上</div></div>';
            return;
          }
          render(m, state.e);
        });
      }
      function one(e) {
        state.settled++;
        if (take(e)) state.got = true;
        if (!state.got && state.settled >= 2) finish();
      }
      resolveEntry(name, bgm).then(one, function () { one(null); });
      dbLive(name, bgm).then(one, function () { one(null); });
    }).observe(m, { childList: true, subtree: false });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', arm);
  } else {
    arm();
  }
  document.addEventListener('DOMContentLoaded', arm);

  /* 测试钩子：让离线脚本能验证匹配 / 分片 / 分组逻辑（生产路径不使用） */
  window.__epsTest = {
    find: findByName,
    norm: norm,
    shardOf: shardOf,
    buildEps: buildEps,
    epsListHtml: epsListHtml,
    render: render,
    hashOf: hashOf,
    setIdx: function (d) { ENTRY = d; return ENTRY; },
    /* 分组 / 排序 / 组名抽取：纯函数，供离线单测逐项断言 */
    cleanGroupName: cleanGroupName,
    groupNameOf: groupNameOf,
    epNoOf: epNoOf,
    collectRows: collectRows,
    groupRows: groupRows,
    defaultOpen: defaultOpen,
    tgsHtml: tgsHtml,
    bustUrl: bustUrl,
    /* 刷新身份校验与"当前已渲染"状态：供离线脚本断言「刷新后 state 与 DOM 行数一致」 */
    sameTitle: sameTitle,
    curState: function () { return CUR_STATE; },
  };

  /* 磁力独立页用：这些函数本身不依赖 #modal，导出后可安全复用 */
  window.__epsApi = {
    loadManifest: loadManifest, loadShard: loadShard, resolveEntry: resolveEntry,
    findByName: findByName, chipOf: chipOf, copyText: copyText, toast: toast,
    fmtSize: fmtSize, norm: norm, shardOf: shardOf, buildEps: buildEps,
    epsListHtml: epsListHtml, batchLabel: batchLabel, descOf: descOf,
    live: function (name, epsN, orig) { return fetchLive(name, epsN, orig); },
    /* 详情页 ⟳：清缓存 + 重查静态索引 + 无条件透传，返回 Promise */
    reload: reload
  };
})();
