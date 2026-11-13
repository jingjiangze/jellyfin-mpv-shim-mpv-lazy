  /* ---------------- 外部播放源（采集站）----------------
     盒子 /ext/find 已经把六家苹果CMS采集接口聚合好并做了片名+季号的严格匹配；
     前端只做三件事：
       ①  探测（面板一行「外部线路 · N 个源」）—— 与播放共用同一份 10 分钟缓存；
       ②  播放：m3u8 交给 76 的 hls.js 分支（原生 <video controls>）；
       ③  按优先级自动降级：当前线路致命错误 / 12s 未出清单 → 换下一家，
           六家都不行才把错误交回调用方。

     优先级由盒子侧 PROVIDERS 顺序决定（非凡→暴风→红牛→量子→360→百度），
     前端不写死任何一家，也不做第二套排序。

     契约（盒子 server.py 的 /ext/find）：
       GET /ext/find?t=<片名>&y=<年>&o=<原名>&force=1
       → {ok, t, items:[{p,name,src,n,eps:[{ep,url}]}], miss?, diag?}
     `items` 只含**季号与片名都匹配上**的源头；宁缺勿错。 */
  var EXT_TTL = 10 * 60 * 1000;              // 与盒子 6h 缓存错开：前端只压 10 分钟
  var EXT_MEM = {};
  var EXT_GEN = 0;                            // 每次开播/切源自增：异步结果只落最新一代

  /* 条目 → 原名/年份/话数（列表行：[0]id [1]原名 [2]中文名 [3]类型 [4]年 [8]话数） */
  function extMeta(id) {
    var rows = (typeof ANI !== 'undefined' && ANI.rows) ? ANI.rows : [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][0] === id) {
        return { orig: rows[i][1] || '', year: rows[i][4] || 0, epsN: rows[i][8] || 0 };
      }
    }
    return { orig: '', year: 0, epsN: 0 };
  }

  function extFind(title, year, orig, force) {
    var key = String(title) + '|' + (year || 0) + '|' + (orig || '');
    var now = Date.now(), mem = EXT_MEM[key];
    if (!force && mem && now - mem.ts < EXT_TTL) return mem.pend || Promise.resolve(mem.data);
    var rec = { ts: now, data: null, pend: null };
    EXT_MEM[key] = rec;
    var qs = '?t=' + encodeURIComponent(title)
      + (year ? '&y=' + encodeURIComponent(String(year)) : '')
      + (orig ? '&o=' + encodeURIComponent(orig) : '')
      + (force ? '&force=1' : '');
    rec.pend = srcGet('/ext/find' + qs, '').then(function (r) {
      var j = (r && r.j) || {};
      var ok = !!(r && r.ok && j.ok);
      var data = {
        items: ok ? (j.items || []) : [],
        miss: !ok || !!j.miss,
        err: ok ? '' : (r && r.status ? ('HTTP ' + r.status) : 'network')
      };
      if (EXT_MEM[key] === rec) { rec.data = data; rec.ts = Date.now(); }
      return data;
    }, function () {
      var data = { items: [], miss: true, err: 'network' };
      if (EXT_MEM[key] === rec) { rec.data = data; rec.ts = Date.now(); }
      return data;
    });
    return rec.pend;
  }

  /* 某集可用的线路（保持盒子给的优先级顺序）。 */
  function extCands(data, ep) {
    var out = [], items = (data && data.items) || [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i], eps = it.eps || [];
      for (var k = 0; k < eps.length; k++) {
        if (Number(eps[k].ep) === Number(ep) && eps[k].url) {
          out.push({ p: it.p, name: it.name, url: String(eps[k].url), n: it.n, src: it.src });
          break;
        }
      }
    }
    return out;
  }

  /* 全集号（各源并集）：给 76 的集数按钮用 */
  function extEpList(data) {
    var seen = {}, out = [];
    var items = (data && data.items) || [];
    for (var i = 0; i < items.length; i++) {
      var eps = items[i].eps || [];
      for (var k = 0; k < eps.length; k++) {
        var n = Number(eps[k].ep);
        if (n > 0 && !seen[n]) { seen[n] = 1; out.push({ ep: n }); }
      }
    }
    out.sort(function (a, b) { return a.ep - b.ep; });
    return out;
  }

  function extProbeText(data, ep) {
    if (!data) return { kind: 'waits' };
    if (data.err && !data.items.length) return { kind: 'error', why: data.err };
    var cand = extCands(data, ep);
    if (!cand.length) return { kind: 'none', n: (data.items || []).length };
    return { kind: 'has', n: cand.length, eps: extEpList(data).length, name: cand[0].name };
  }

  /* 自动链的一站：找到就播，找不到/接口挂了就交回 next（不吞错）。
     onFail(why) 由 78 的链传给下一步（B 站匿名搜 → YouTube → 网盘）。 */
  function extStart(box, id, title, ep, onFail) {
    var epNo = Math.max(1, Math.floor(Number(ep) || 1));
    var gen = ++EXT_GEN;
    var meta = extMeta(id);
    srcHint(box, '正在匹配外部播放源…');
    extFind(title, meta.year, meta.orig, false).then(function (data) {
      if (gen !== EXT_GEN) return;
      var cand = extCands(data, epNo);
      if (!cand.length) {
        if (typeof onFail === 'function') onFail(data && data.err ? ('外部源不可用 ' + data.err) : '外部源未收录');
        return;
      }
      extPlay(box, id, title, epNo, data, cand, 0);
    }, function () {
      if (gen === EXT_GEN && typeof onFail === 'function') onFail('外部源不可用');
    });
  }

  /* 播放某一集（用户点集数按钮 / 自动连播）：重新从 items 里挑可用线路。 */
  function extPlayEp(box, id, title, ep, data) {
    var cand = extCands(data, ep);
    if (!cand.length) {
      srcHint(box, '第 ' + ep + ' 集外部源还没更新');
      return;
    }
    extPlay(box, id, title, ep, data, cand, 0);
  }

  /* 第 idx 条线路；失败自动换 idx+1。QPlayer.open 每次重建，所以换源不会残留旧 listener。 */
  function extPlay(box, id, title, ep, data, cand, idx) {
    if (!window.QPlayer || !box) return;
    var cur = cand[idx];
    if (!cur) return;
    var tok = QPlayer.open({
      m: box,
      id: id,
      title: title,
      ep: ep,
      sources: [],
      onPickEp: function (e) { extPlayEp(box, id, title, Number(e) || 1, data); },
      onEnded: function () {
        var nx = ep + 1;
        if (extCands(data, nx).length) extPlayEp(box, id, title, nx, data);
      },
      onPlayErr: function (why) {
        if (!(window.QPlayer && QPlayer.isCurrent(tok))) return;
        if (idx + 1 < cand.length) {
          srcHint(box, '「' + cur.name + '」线路不可用（' + why + '）· 自动换下一条');
          extPlay(box, id, title, ep, data, cand, idx + 1);
          return;
        }
        QPlayer.state('error', { msg: '外部线路都不可用（' + (why || 'error') + '）' });
      }
    });
    QPlayer.setEpisodes(extEpList(data), ep, '');
    srcHint(box, '外部线路 · ' + cur.name + ' · 第 ' + ep + ' 集'
      + (idx ? '（已自动换源 ' + (idx + 1) + '/' + cand.length + '）' : ''));
    QPlayer.play(cur.url, cur.name, { hls: true });
  }

  window.__extFind = extFind;
  window.__extStart = extStart;
  window.__extAbort = function () { EXT_GEN += 1; };
