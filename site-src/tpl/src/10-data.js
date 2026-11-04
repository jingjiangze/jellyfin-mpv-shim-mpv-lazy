  /* 数据 JSON 三源：同源 → 数据集（国内快，实测 0.2–0.5s）→ GitHub 镜像。
     CF Pages 对缺失路径会回 200 + text/html，所以不能只看 r.ok，必须验 content-type。
     实测 content-type：同源/CF = application/json；数据集 = application/octet-stream
     （不是 json，所以单独放行，否则主源会被误判失败）；GitHub 镜像 = application/json。 */
  var D_BASES = [
    'https://modelscope.cn/datasets/jingjiangze/Anime-JPG/resolve/master/assets/data/',
    'https://gh-proxy.com/https://raw.githubusercontent.com/jingjiangze/jellyfin-mpv-shim-mpv-lazy/main/media/data/',
    './data/'
  ];
  /* opts.bust：给三个源都加同一个 ?v=时间戳（刷新按钮用来绕开浏览器与 CDN 的旧副本）。
     时间戳一次算好、三源共用，避免一次逻辑取数出现三个不同版本号。 */
  function jd(name, opts) {
    var v = opts && opts.bust ? Date.now() : 0;
    var i = 0;
    function go() {
      if (i >= D_BASES.length) return Promise.reject(new Error('data ' + name + ' 三源都失败'));
      var u = D_BASES[i++] + name;
      if (v) u += (u.indexOf('?') < 0 ? '?' : '&') + 'v=' + v;
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
  var shardCache = {};                 // 分片号（id % 64）-> 该分片的 promise
  /* 丢弃某个分片的缓存：刷新按钮先 dropShard 再带 bust 重取，否则会直接命中旧 promise。
     全部源码打包进同一个 IIFE，所以这里是「导出」给 70-modal.js 用的共享函数。 */
  function dropShard(sfx) { delete shardCache[sfx]; }

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
