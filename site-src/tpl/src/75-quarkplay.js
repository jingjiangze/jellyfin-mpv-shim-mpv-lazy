  /* ---------------- 在线播放（夸克网盘 → 盒子 TV 转码 → 自研播放器） ----------------
     媒体字节不经过任何服务器：这里只向盒子服务要一条夸克 CDN 上的直链，
     再由浏览器直接向 drive.quark.cn / video-play-p-zb.drive.quark.cn 取流
     （支持 Range、不需要 cookie）。

     播放器 UI 在 76-qplayer.js（QPlayer）：本文件只管三件事 ——
       1) 从网盘里找到「当前这一集」的文件（fid）；
       2) 换来一条能播的直链（转码可能要先等）；
       3) 把进度写回 localStorage / 盒子（__prog + /share/progress）。

     契约（已部署实测，token 与 20-state.js / 90-boot.js 同一份 localStorage.gh_token）：
       GET  /tvplay/find?q=<片名>&limit=20
            → {state:'found',items:[{fid,name,size}],best} / none / need_rebind(409) / unauthorized(401)
            ⚠ best 是「体积最大的文件」，按体积降序 = 不区分集号，直接播会串集，别用。
       GET  /tvplay/url?fid=<fid>&wait=45
            → {state:'ready',url,expires_in} / transcoding(202,{retry_after}) / need_rebind(409)
       POST /tvplay/add {magnet,title,ep} → {state:'queued',task_id} / 409 no_quota / 409 duplicate
       GET  /tvplay/task?id=<task_id> → pending+progress / ready{fid,name,size} / failed / 404
       POST /tvplay/share/progress {fid,pos,dur} → 刷 last_play（≥90% 置 watched）
     播放地址有效期短（expires_in），所以不做地址缓存；只缓存 fid（1h，省一次 find）。 */
  var QP_BASE = 'https://120.48.56.189';
  var QP_FID_KEY = 'qp_fid';             // {"<bgm id>:<ep>": {fid,name,size,ts}}
  var QP_FID_TTL = 60 * 60 * 1000;       // fid 缓存 1h：文件不会每分钟改名，地址才会过期
  var QP_TIMER = 0;                      // 挂起的转码 / 转存轮询（模块级：新播放 / 关播放器都要能掐掉）
  var QP_GEN = 0;                        // 每次开播自增：异步回调据此判断自己是否已被后来的一次播放取代

  /* 统一取 JSON：网络失败、空体、非 JSON 一律退化成 {state:'error'}；
     后端已经带了 state 就原样用，只在缺 state 时按 HTTP 码兜底（401/409/202）。 */
  function qpReq(method, path, tk, body, keepalive) {
    var opt = { method: method, headers: { authorization: 'Bearer ' + tk } };
    if (body != null) {
      opt.headers['content-type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    if (keepalive) opt.keepalive = true;      // pagehide 时普通请求会被浏览器掐掉
    return fetch(QP_BASE + path, opt).then(function (res) {
      return res.text().then(function (t) {
        var j = null;
        try { j = JSON.parse(t); } catch (e) { j = null; }
        if (!j || typeof j !== 'object') j = {};
        if (!j.state) {
          if (res.status === 401) j.state = 'unauthorized';
          else if (res.status === 409) j.state = 'need_rebind';
          else if (res.status === 202) j.state = 'transcoding';
          else j.state = 'error';
        }
        return j;
      });
    }).then(null, function () { return { state: 'error' }; });
  }
  function qpJson(path, tk) { return qpReq('GET', path, tk, null, false); }
  function qpPost(path, tk, body, keepalive) { return qpReq('POST', path, tk, body, keepalive); }

  /* ---------------- fid 本地缓存（1h） ---------------- */
  function qpCacheAll() {
    try {
      var v = JSON.parse(localStorage.getItem(QP_FID_KEY) || '{}');
      return v && typeof v === 'object' && Object.prototype.toString.call(v) !== '[object Array]' ? v : {};
    } catch (e) { return {}; }
  }
  function qpCacheGet(id, ep) {
    var c = qpCacheAll()[String(id) + ':' + String(ep)];
    if (!c || !c.fid) return null;
    if (!(Date.now() - Number(c.ts) < QP_FID_TTL)) return null;
    return c;
  }
  function qpCachePut(id, ep, rec) {
    var all = qpCacheAll(), k = String(id) + ':' + String(ep), now = Date.now(), out = {};
    all[k] = { fid: String(rec.fid), name: String(rec.name || ''), size: Number(rec.size) || 0, ts: now };
    Object.keys(all).forEach(function (key) {             // 顺手清掉过期项，别让缓存无限长
      var r = all[key];
      if (r && now - Number(r.ts) < QP_FID_TTL) out[key] = r;
    });
    try { localStorage.setItem(QP_FID_KEY, JSON.stringify(out)); } catch (e) { /* 忽略 */ }
  }

  /* ---------------- 片名 / 集号匹配 ----------------
     find 的 items 是上游按关键词搜出来的整批文件（同一部番的很多集、有时还有字幕/花絮），
     必须自己按「片名归一 + 集号」挑，不能信任后端排序。 */
  var QP_EP_RES = [
    /[Ss]\d{1,2}\s*[Ee](\d{1,3})/,                 // S01E03
    /第\s*(\d{1,3})\s*[话話集期]/,                   // 第3话 / 第3集
    /\[(\d{1,3})(?:v\d)?\]/,                       // [03] / [03v2]
    /(?:^|[^0-9A-Za-z])[Ee][Pp]?(\d{1,3})(?![0-9])/, // E03 / EP03
    /_(\d{1,3})(?![0-9])/,                         // _03
    /[-–—]\s*(\d{1,3})(?![0-9])/                   // - 03
  ];
  function qpEpNo(name) {
    var s = String(name || '');
    for (var i = 0; i < QP_EP_RES.length; i++) {
      var m = QP_EP_RES[i].exec(s);
      if (!m) continue;
      var n = Number(m[1]);
      if (n > 0 && n < 1000) return n;              // 1080 / 264 这类不会进（前面限了位数与后缀）
    }
    return 0;
  }
  /* 片名归一复用 00-base.js 的 nrm（全角转半角 + 去标点空白 + 小写），与站内搜索同一口径。
     季号先剥掉再比：站内标题常带「第二季 / Season 2」，网盘文件名却只写 S2，
     不剥的话包含关系永远不成立，整部番都查不到。 */
  function qpStripSeason(s) {
    return String(s || '')
      .replace(/第[一二三四五六七八九十0-9]{1,2}[季期部]/g, '')
      .replace(/season\s*[0-9]{1,2}/g, '')
      .replace(/[0-9]{1,2}(?:nd|rd|st|th)season/g, '')
      .replace(/s[0-9]{1,2}(?![0-9])/g, '');
  }
  function qpContains(hay, needle) {
    if (!hay || !needle) return false;
    if (hay.indexOf(needle) >= 0) return true;
    return hay.length >= 4 && needle.length >= 4 && needle.indexOf(hay) >= 0
      && hay.length >= needle.length * 0.6;
  }
  function qpTitleOk(name, title) {
    var nt = nrm(name), tt = nrm(title);
    if (!nt || !tt) return false;
    if (qpContains(nt, tt)) return true;
    return qpContains(qpStripSeason(nt), qpStripSeason(tt));
  }
  /* 在候选里挑「片名对得上 + 集号等于目标集」中体积最大的那个。
     识别不到集号的文件只在「整批只有一个视频」时才兜底（剧场版 / OVA 常见），
     否则宁可返回 null 让 UI 明说没找到 —— 播错集比播不了更难受。 */
  function qpPickEp(items, title, ep) {
    var list = items || [], best = null, single = null;
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!it || it.fid == null || it.fid === '') continue;
      var name = String(it.name || '');
      if (!qpTitleOk(name, title)) continue;
      var ne = qpEpNo(name);
      if (ne === ep) {
        if (!best || Number(it.size) > Number(best.size)) best = it;
      } else if (!ne) {
        single = single || it;
      }
    }
    if (best) return best;
    if (list.length === 1 && single) return single;
    return null;
  }

  /* ---------------- 选集（结构化，不抓 DOM） ---------------- */
  function qpEpList(entry) {
    if (!entry || !entry.eps || typeof entry.eps !== 'object') return [];
    var out = [];
    Object.keys(entry.eps).forEach(function (k) {
      var n = Number(k);
      if (!(n > 0) || n !== Math.floor(n)) return;
      var cands = entry.eps[k] || [], mag = '', bestSize = -1;
      (cands || []).forEach(function (c) {
        var m = String((c && (c.m || c.magnet)) || '');
        if (m.indexOf('magnet:') !== 0) return;
        var sz = Number(c && c.s) || 0;
        if (sz > bestSize) { bestSize = sz; mag = m; }
      });
      out.push({ ep: n, label: (n < 10 ? '0' : '') + n, magnet: mag });
    });
    out.sort(function (a, b) { return a.ep - b.ep; });
    return out;
  }
  function qpHasEp(list, ep) {
    for (var i = 0; i < list.length; i++) if (Number(list[i].ep) === Number(ep)) return true;
    return false;
  }
  function qpEpAt(list, ep) {
    for (var i = 0; i < list.length; i++) if (Number(list[i].ep) === Number(ep)) return list[i];
    return null;
  }

  function qpCopy(text) {
    var api = window.__epsApi;
    if (api && typeof api.copyText === 'function') { api.copyText(text); return; }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
    } catch (e) { /* 非安全上下文：无从复制，保持静默 */ }
  }

  /* m = #modal 容器；id / title 是 openModal 里那一代的条目 id 与片名 */
  function openQuarkPlay(m, id, title) {
    if (!m || !window.QPlayer) return;
    var tk = followToken();                       // 20-state.js：读 localStorage.gh_token
    var gen = ++QP_GEN;                           // 换代：上一代在飞的请求与轮询全部作废
    if (QP_TIMER) { clearTimeout(QP_TIMER); QP_TIMER = 0; }

    /* 上次看到哪一集 / 哪一秒：有就接着播，没有从头 */
    var saved = null;
    try { saved = window.__prog && typeof window.__prog.get === 'function' ? window.__prog.get(id) : null; }
    catch (e) { saved = null; }

    var S = {
      m: m,
      id: String(id),
      title: String(title || ''),
      tk: tk,
      gen: gen,
      tok: 0,
      ep: saved && Number(saved.ep) > 0 ? Number(saved.ep) : 1,
      startAt: saved && Number(saved.pos) > 0 ? Number(saved.pos) : 0,
      fid: '',
      name: '',
      size: 0,
      entry: null,
      eps: [],
      epsHint: ''
    };

    S.tok = QPlayer.open({
      m: m,
      id: S.id,
      title: S.title,
      ep: S.ep,
      sources: [],                                // 官方源要等 find + url，先给空数组
      startAt: S.startAt,
      onProgress: function (p) { qpReport(S, p); },
      onPickEp: function (ep) { if (qpAlive(S)) qpSetEp(S, ep); },
      onNext: function () { qpNext(S); },
      onEnded: function () { qpNext(S); },
      onRetry: function () { if (qpAlive(S)) qpResolve(S); }
    });

    if (!tk) {
      QPlayer.state('login', { msg: '登录后才能使用夸克网盘播放' });
      return;
    }

    qpLoadEps(S).then(function () {
      if (!qpAlive(S)) return;
      qpResolve(S);
    });
  }

  /* 当前这一代播放器还在（弹窗没关、没换番、播放器没被重建） */
  function qpAlive(S) {
    return !!(S && S.gen === QP_GEN && S.tok && window.QPlayer && window.QPlayer.isCurrent(S.tok));
  }

  function qpLoadEps(S) {
    var api = window.__epsApi;
    if (!api || typeof api.resolveEntry !== 'function') {
      S.epsHint = '选集信息不可用';
      QPlayer.setEpisodes([], S.ep, S.epsHint);
      return Promise.resolve(null);
    }
    return api.resolveEntry(S.title, S.id).then(function (entry) {
      if (!qpAlive(S)) return null;
      S.entry = entry || null;
      S.eps = qpEpList(entry);
      if (S.eps.length && !qpHasEp(S.eps, S.ep)) S.ep = S.eps[0].ep;
      S.epsHint = S.eps.length ? '' : '暂无按集索引（可在「线路」里自备播放地址）';
      QPlayer.setEpisodes(S.eps, S.ep, S.epsHint);
      return entry;
    }, function () {
      if (!qpAlive(S)) return null;
      S.eps = [];
      S.epsHint = '选集信息加载失败，仍可在线路里自备源';
      QPlayer.setEpisodes([], S.ep, S.epsHint);
      return null;
    });
  }

  function qpSetEp(S, ep) {
    if (!qpAlive(S)) return;
    QPlayer.pause();                              // 先把旧集的进度按旧 ep / 旧 fid 落盘，再改这两个字段
    S.ep = Number(ep) > 0 ? Number(ep) : S.ep;
    S.startAt = 0;                                // 换集不续播：上一集的秒数是另一条视频的
    S.fid = '';
    QPlayer.setFid('');
    QPlayer.setEpisodes(S.eps, S.ep, S.epsHint);
    if (QP_TIMER) { clearTimeout(QP_TIMER); QP_TIMER = 0; }
    qpResolve(S);
  }

  function qpNext(S) {
    if (!qpAlive(S)) return;
    var i = -1;
    for (var k = 0; k < S.eps.length; k++) if (Number(S.eps[k].ep) === Number(S.ep)) i = k;
    if (i < 0 || i + 1 >= S.eps.length) return;   // 没有下一集：不弹任何东西
    qpSetEp(S, S.eps[i + 1].ep);
  }

  /* 第 2 步：拿到 fid（缓存 → find），再进第 3 步换直链 */
  function qpResolve(S) {
    if (!qpAlive(S)) return;
    S.fid = '';
    S.name = '';
    S.size = 0;
    QPlayer.setFid('');

    var hit = qpCacheGet(S.id, S.ep);
    if (hit) {
      S.fid = String(hit.fid);
      S.name = String(hit.name || '');
      S.size = Number(hit.size) || 0;
      QPlayer.setFid(S.fid);
      QPlayer.state('loading', { msg: '正在获取播放地址…' });
      qpAskUrl(S, 0);
      return;
    }

    QPlayer.state('loading', { msg: '正在网盘里查找第 ' + S.ep + ' 集…' });
    qpJson('/tvplay/find?q=' + encodeURIComponent(S.title) + '&limit=20', S.tk).then(function (j) {
      if (!qpAlive(S)) return;
      if (j.state === 'found') {
        var pick = qpPickEp(j.items || [], S.title, S.ep);
        if (!pick) { qpNotFound(S, '网盘里没有匹配第 ' + S.ep + ' 集的文件'); return; }
        S.fid = String(pick.fid);
        S.name = String(pick.name || '');
        S.size = Number(pick.size) || 0;
        QPlayer.setFid(S.fid);
        qpCachePut(S.id, S.ep, { fid: S.fid, name: S.name, size: S.size });
        QPlayer.state('loading', { msg: '找到「' + (S.name || '文件') + '」，正在获取地址…' });
        qpAskUrl(S, 0);
        return;
      }
      if (j.state === 'none') { qpNotFound(S, '夸克网盘里还没有这一集'); return; }
      if (j.state === 'need_rebind') { QPlayer.state('rebind'); return; }
      if (j.state === 'unauthorized') { QPlayer.state('login'); return; }
      QPlayer.state('error', { msg: '播放服务暂时不可用' });
    });
  }

  /* 转码轮询：最多 10 轮，间隔取后端给的 retry_after（夹在 1–60s，防后端回 0 时打爆） */
  function qpAskUrl(S, tries) {
    if (!qpAlive(S)) return;
    if (!S.fid) { QPlayer.state('error', { msg: '缺少文件 id，请重试' }); return; }
    if (tries > 10) { QPlayer.state('error', { msg: '转码超时，稍后再试' }); return; }
    qpJson('/tvplay/url?fid=' + encodeURIComponent(S.fid) + '&wait=45', S.tk).then(function (j) {
      if (!qpAlive(S)) return;
      if (j.state === 'ready' && j.url) {
        QPlayer.play(String(j.url), '夸克网盘', { fid: S.fid, startAt: S.startAt });
        S.startAt = 0;                            // 续播只作用于这一次；重试时不该再跳回老位置
        return;
      }
      if (j.state === 'transcoding') {
        QPlayer.state('transcoding', { msg: '转码中… 约 1 分钟（' + (tries + 1) + '/10）' });
        var wait = Number(j.retry_after);
        if (!(wait > 0)) wait = 5;
        QP_TIMER = setTimeout(function () {
          QP_TIMER = 0;
          if (!qpAlive(S)) return;               // 弹窗已关 / 已换集：不再排下一轮
          qpAskUrl(S, tries + 1);
        }, Math.min(wait, 60) * 1000);
        return;
      }
      if (j.state === 'need_rebind') { QPlayer.state('rebind'); return; }
      if (j.state === 'unauthorized') { QPlayer.state('login'); return; }
      QPlayer.state('error', { msg: '播放服务暂时不可用' });
    });
  }

  function qpNotFound(S, msg) {
    var actions = [];
    var epInfo = qpEpAt(S.eps, S.ep);
    if (epInfo && epInfo.magnet) {
      actions.push({ label: '复制磁力', fn: function () { qpCopy(epInfo.magnet); } });
      actions.push({ label: '离线转存到网盘', fn: function () { qpAddMagnet(S, epInfo.magnet); } });
    }
    actions.push({ label: '重试', fn: function () { qpResolve(S); } });
    QPlayer.state('none', {
      msg: msg + '。可以粘贴自备播放地址，或复制磁力到夸克离线下载后再试。',
      actions: actions
    });
  }

  /* 磁力离线：POST /add 只回 task_id，进度靠 /task 轮询 */
  function qpAddMagnet(S, magnet) {
    if (!qpAlive(S)) return;
    QPlayer.state('transcoding', { msg: '正在提交离线转存…' });
    qpPost('/tvplay/add', S.tk, { magnet: magnet, title: S.title, ep: String(S.ep) }).then(function (j) {
      if (!qpAlive(S)) return;
      if (j.state === 'queued' && j.task_id) { qpPollTask(S, String(j.task_id), 0); return; }
      if (j.state === 'no_quota') { QPlayer.state('quota', { msg: '网盘离线空间已满，清理后再试' }); return; }
      if (j.state === 'duplicate') {
        QPlayer.state('transcoding', { msg: '网盘里已有这个任务，正在查找文件…' });
        QP_TIMER = setTimeout(function () {
          QP_TIMER = 0;
          if (qpAlive(S)) qpResolve(S);
        }, 4000);
        return;
      }
      if (j.state === 'need_rebind') { QPlayer.state('rebind'); return; }
      if (j.state === 'unauthorized') { QPlayer.state('login'); return; }
      QPlayer.state('error', { msg: '离线转存失败' + (j.msg ? '：' + j.msg : '') });
    });
  }

  function qpPollTask(S, taskId, n) {
    if (!qpAlive(S)) return;
    if (n > 40) { QPlayer.state('error', { msg: '离线转存超时，稍后去网盘里看看' }); return; }
    qpJson('/tvplay/task?id=' + encodeURIComponent(taskId), S.tk).then(function (j) {
      if (!qpAlive(S)) return;
      if (j.state === 'ready' && j.fid) {
        S.fid = String(j.fid);
        S.name = String(j.name || '');
        S.size = Number(j.size) || 0;
        QPlayer.setFid(S.fid);
        qpCachePut(S.id, S.ep, { fid: S.fid, name: S.name, size: S.size });
        qpAskUrl(S, 0);
        return;
      }
      if (j.state === 'pending' || j.state === 'queued') {
        QPlayer.state('transcoding', { msg: '离线转存中… ' + (Number(j.progress) || 0) + '%' });
        QP_TIMER = setTimeout(function () {
          QP_TIMER = 0;
          qpPollTask(S, taskId, n + 1);
        }, 3000);
        return;
      }
      if (j.state === 'need_rebind') { QPlayer.state('rebind'); return; }
      if (j.state === 'unauthorized') { QPlayer.state('login'); return; }
      QPlayer.state('error', { msg: '离线转存失败，稍后去网盘里看看' });
    });
  }

  /* 进度：本地 __prog（localStorage 主存储）+ 盒子 /share/progress（best-effort） */
  function qpReport(S, p) {
    if (!p) return;
    var ep = Number(p.ep) > 0 ? Number(p.ep) : S.ep;
    /* fid 以播放器当前这条线路为准（播放器切到自备源时会清空），不能用 S.fid：
       否则用户改用自备源后，进度会被回写到网盘里那条旧文件上。 */
    var fid = String(p.fid || '');
    var pos = Math.max(0, Number(p.pos) || 0);
    var dur = Math.max(0, Number(p.dur) || 0);
    /* 20-state.js 的 __prog.report 必须收到第三参才会记下 pos/dur */
    if (window.__prog && typeof window.__prog.report === 'function') {
      try { window.__prog.report(S.id, ep, { fid: fid, pos: pos, dur: dur }); } catch (e) { /* 忽略 */ }
    }
    if (!fid) return;                             // 没有 fid 时后端无法定位记录
    qpPost('/tvplay/share/progress', S.tk, { fid: fid, pos: pos, dur: dur }, !!p.final)
      .then(function (j) {
        /* 404 = 这条转存记录已过期被删；不影响本地进度，静默即可 */
        if (j && j.state === 'unauthorized' && qpAlive(S)) QPlayer.state('login');
      }, function () { /* 静默 */ });
  }

  /* 调试入口：控制台可 __qp() 直接触发，不影响线上逻辑 */
  window.__qp = openQuarkPlay;
