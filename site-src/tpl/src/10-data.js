  /* 数据 JSON 三源。顺序是按**国内实测总耗时**定的，不是按字节数：
       数据集 ModelScope：940 KB 原样传输，但国内 CDN 0.31–0.45 s（含 TTFB）→ 第一
       同源 CF Pages    ：brotli 362 KB，可国内回源 2.3–8.3 s（时快时慢）→ 只做兜底
       gh-proxy 镜像    ：第三兜底
     别再按「谁压缩率高」排序 —— 试过把同源提到第一，首屏 JSON 反而慢一个数量级。
     CF Pages 对缺失路径会回 200 + text/html，所以不能只看 r.ok，必须验 content-type：
     同源/CF = application/json；数据集 = application/octet-stream（不是 json，单独放行）；
     GitHub 镜像 = application/json。 */
  var D_BASES = [
    'https://modelscope.cn/datasets/jingjiangze/Anime-JPG/resolve/master/assets/data/',
    '/data/',
    'https://gh-proxy.com/https://raw.githubusercontent.com/jingjiangze/jellyfin-mpv-shim-mpv-lazy/main/media/data/'
  ];
  function jd(name) {
    var i = 0;
    function go() {
      if (i >= D_BASES.length) return Promise.reject(new Error('data ' + name + ' 三源都失败'));
      var u = D_BASES[i++] + name;
      /* 每个源限时 12s：源挂起时 fetch 永不 settle，弹窗会卡在「加载中…」 */
      var ctl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 12000);
      return fetch(u, ctl ? { signal: ctl.signal } : undefined).then(function (r) {
        clearTimeout(timer);
        if (!r.ok) throw 0;
        var ct = (r.headers.get('content-type') || '').toLowerCase();
        if (ct.indexOf('json') < 0 && ct.indexOf('octet-stream') < 0) throw 0;  // CF 兜底 HTML 会命中这里
        return r.json();
      }).catch(function () { clearTimeout(timer); return go(); });
    }
    return go();
  }

  var ANI = { poster: '', posterSd: '', rows: [], extra: {}, year: 0 };
  var shardCache = {};

  /* ---- 大数据文件缓存（Cache API，stale-while-revalidate）----
     页面切换慢的主因不是动画，是每次导航都重新下载 + 解析 940KB 的 anime.json。
     这里把大数据文件存进 Cache API：命中先给（切页 <100ms），后台再回源刷新，
     下一次切换就是新的。build 号变了（站点刚部署）也会先给旧的再刷，最多旧一个视图。 */
  var DCACHE = 'anime-data-v1';
  var DCACHE_FRESH = 30 * 60 * 1000;      // 30 分钟内视为新鲜，不回源
  function dcache() {
    return (typeof caches !== 'undefined' && caches.open) ? caches.open(DCACHE) : null;
  }
  function dcacheGet(name, cb) {
    var c = dcache();
    if (!c) { cb(null); return; }
    c.then(function (store) {
      return store.match('swr/' + name).then(function (hit) {
        if (!hit) { cb(null); return; }
        var ts = Number(hit.headers.get('x-ts')) || 0;
        return hit.json().then(function (d) {
          cb(d, ts && (Date.now() - ts) < DCACHE_FRESH);
        }, function () { cb(null); });
      });
    }, function () { cb(null); }).catch(function () { cb(null); });
  }
  function dcachePut(name, data) {
    var c = dcache();
    if (!c || data == null) return;
    c.then(function (store) {
      var h = { headers: { 'content-type': 'application/json', 'x-ts': String(Date.now()) } };
      store.put('swr/' + name, new Response(JSON.stringify(data), h));
    }).catch(function () { });
  }
  /* 先给缓存，再回源刷新（本视图不重渲染，下一页就是新的）。缓存没有则直取。 */
  function jdSwr(name) {
    return new Promise(function (resolve) {
      var done = false;
      function settle(v) { if (!done) { done = true; resolve(v); } }
      dcacheGet(name, function (cached, fresh) {
        if (cached) settle(cached);
        if (cached && fresh) return;
        jd(name).then(function (d) {
          if (d) dcachePut(name, d);
          settle(d);
        }, function () { if (!cached) settle(null); });
      });
    });
  }

  var TAGCNT = {}, TAGCNT_LOADING = false, TAGCNT_WAIT = [];
  /* 标签全站计数：单独一份小表。首次拉取成功/失败都要复位 LOADING（旧实现成功分支
     不复位，返回空表后永远不再重试）；带回调的调用方可在数据到位后重绘。 */
  function ensureTagCounts(done) {
    if (done) TAGCNT_WAIT.push(done);
    if (TAGCNT_LOADING) return;
    if (Object.keys(TAGCNT).length) { flushTagCounts(); return; }
    TAGCNT_LOADING = true;
    jd('tagcounts.json').then(function (d) { TAGCNT = d || {}; }, function () { /* 失败保持空表，允许下次重试 */ })
      .then(function () { TAGCNT_LOADING = false; flushTagCounts(); });
  }
  function flushTagCounts() {
    var w = TAGCNT_WAIT; TAGCNT_WAIT = [];
    w.forEach(function (f) { try { f(); } catch (e) { /* 单个回调失败不影响其它 */ } });
  }
