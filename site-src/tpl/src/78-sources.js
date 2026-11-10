  /* ---------------- 播放源聚合面板（整页详情 / 弹窗共用） ----------------
     只做三件事：给出面板 DOM（srcPanelHtml）、探测并填文案（srcPanelMount）、
     点某一行时按源分发（srcPlay）。播放实现全部留在各自模块：
       夸克 / 磁力 → 75-quarkplay.js 的 openQuarkPlay(m, id, title)
       B 站        → 80-bili.js 的 biliPlayEp(m, id, title, ep)
       自备源      → 76-qplayer.js 的「线路」面板（localStorage.qp_lines，只读入口 QPlayer._lines.of）

     硬约束：
       · 面板根 .dp-srcs 必须插在 .trailer.qplayer 之外 —— 76 的 renderLines 在播放器
         root 内查 .qp-line-list，面板放进去两边会抢同一个选择器；
       · 行身份只走 data-row / data-src / data-act，选择器只用 .qp-line-row / .qp-line / .btn
         这类简单形态（离线冒烟的 DOM 桩不支持复合选择器，也便于以后换实现）；
       · 打开详情只探测不播放：探测只发 3 个 GET（夸克 find、B 站 bind、磁力分片），
         自备源条数直接读 localStorage，失败互不影响。

     探测契约（与 75 / 80 同一份）：
       GET {BASE}/tvplay/find?q=<片名>&limit=20 → {state:'found',items:[…]} / none / need_rebind(409) / unauthorized(401)
       GET {BASE}/bili/bind                     → {ok,bound,uname,vip_type} / 404 not_bound
       __epsApi.resolveEntry(title, id)         → {eps:{"3":[{m,…}]}}
     结果按「bgm id + 集号」缓存 60s：详情页来回切标签、弹窗重开都不重复打接口。 */
  var SRC_BASE = 'https://120.48.56.189';
  var SRC_TTL = 60 * 1000;                       // 探测结果缓存时长
  var SRC_USER = '/user';                       // B 站绑定在个人主页
  var SRC_KEYS = ['yt', 'bili', 'magnet'];
  var SRC_NAME = { yt: 'YouTube 官方', bili: 'B 站', magnet: '网盘' };
  /* 绑定按钮各源文案不同：B 站绑的是「登录态（换清晰度）」，网盘绑的是夸克账号（换播放权）。 */
  var SRC_BIND = { bili: '登录高清', magnet: '绑定网盘' };
  var SRC_MEM = {};                              // "<id>:<ep>" -> {ts, data, pend}
  var SRC_MGEN = 0;                              // 每 mount 一次自增：异步结果只落最新那一代

  /* token 与 20-state.js / 90-boot.js 同一份 localStorage.gh_token。
     本文件不跨文件依赖（同 magnet-eps.js 的做法）：常量与取值各写一份。 */
  function srcToken() {
    try { return localStorage.getItem('gh_token') || ''; } catch (e) { return ''; }
  }

  /* 统一 GET：网络失败、空体、非 JSON 一律退化成 {status:0|原码, ok:false, j:{}}；
     AbortController 只做超时兜底（不引出新依赖，环境没有就退化成无超时）。 */
  function srcGet(path, tk) {
    var headers = {};
    if (tk) headers.authorization = 'Bearer ' + tk;
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 15000);
    var opt = { method: 'GET', headers: headers };
    if (ctl) opt.signal = ctl.signal;
    return fetch(SRC_BASE + path, opt).then(function (r) {
      clearTimeout(timer);
      return r.text().then(function (t) {
        var j = null;
        try { j = JSON.parse(t); } catch (e) { j = null; }
        if (!j || typeof j !== 'object') j = {};
        return { status: Number(r.status) || 0, ok: !!r.ok, j: j };
      });
    }, function () {
      clearTimeout(timer);
      return { status: 0, ok: false, j: {} };
    });
  }

  /* 带 Bearer 的写请求（B 站扫码 start/poll 用）。契约与 srcGet 一致：
     失败/非 JSON 一律退化成 {status, ok:false, j:{}}，调用方不必 try/catch。 */
  function srcAuth(path, method, body) {
    var tk = (typeof authToken === 'function' && authToken()) || '';
    var headers = { 'content-type': 'application/json' };
    if (tk) headers.authorization = 'Bearer ' + tk;
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 15000);
    var opt = { method: method || 'POST', headers: headers };
    if (body && method !== 'GET') opt.body = JSON.stringify(body);
    if (ctl) opt.signal = ctl.signal;
    return fetch(SRC_BASE + path, opt).then(function (r) {
      clearTimeout(timer);
      return r.text().then(function (t) {
        var j = null;
        try { j = JSON.parse(t); } catch (e) { j = null; }
        return { status: Number(r.status) || 0, ok: !!r.ok, j: (j && typeof j === 'object') ? j : {} };
      });
    }, function () {
      clearTimeout(timer);
      return { status: 0, ok: false, j: {} };
    });
  }

  /* 当前集在网盘里是否真有文件：复用 75 的挑集逻辑（片名归一 + 集号 + 取体积最大），
     保证「已转存」的判定与点开播放时一致，不另写一套口径。 */
  function srcProbeBili(tk, title) {
    /* 顺带探一次官方番剧（PGC）：面板上能直接写出「免费 M/N 集」，
       比只有「免登录可看」有用；两条请求并行，各自失败不影响对方。 */
    var pgcP = (typeof srcPgc === 'function') ? srcPgc(title) : Promise.resolve(null);
    return Promise.all([srcGet('/bili/bind', tk), pgcP]).then(function (pair) {
      var r = pair[0], j = (r && r.j) || {}, pgc = pair[1];
      var kind;
      if (r && r.ok && j.ok && j.bound) {
        kind = { kind: 'bound', uname: String(j.uname || '已绑定'), vip: Number(j.vip_type) || 0 };
      } else if (r && (r.status === 404 || r.status === 401)) {
        kind = { kind: 'unbound' };
      } else if (j.bound === false || j.error === 'not_bound' || j.ok === false) {
        kind = { kind: 'unbound' };
      } else {
        kind = { kind: 'error' };
      }
      if (pgc) { kind.pgc = pgc; if (kind.kind === 'error') kind.kind = 'unbound'; }
      return kind;
    });
  }


  function srcProbeMagnet(title, id, ep) {
    var api = window.__epsApi;
    if (!api || typeof api.resolveEntry !== 'function') return Promise.resolve({ kind: 'none' });
    return api.resolveEntry(title, id).then(function (entry) {
      var list = typeof qpEpList === 'function' ? qpEpList(entry) : [];
      for (var i = 0; i < list.length; i++) {
        if (Number(list[i].ep) === Number(ep) && list[i].magnet) return { kind: 'has' };
      }
      return { kind: 'none' };
    }, function () { return { kind: 'error' }; });
  }

  /* YouTube 官方正片：数据在 build 期由 AniList streamingEpisodes / 频道 RSS 对齐进 extra[4]，
     这里只读内存，不联网探测。 */
  function srcYtEps(id) {
    var ex = (typeof ANI !== 'undefined' && ANI.extra) ? ANI.extra[id] : null;
    var eps = ex && ex[4];
    return (eps && eps.length) ? eps : null;
  }

  /* 第三方播放器 iframe 一律包一层 .dpv-frame：16:9 由**外壳**自己定，
     不依赖 .dp-player 的高度。历史坑：.dp-player:not(:empty) 还留着自研播放器时代的
     `aspect-ratio: auto`（那时槽里是自带 16:9 的 .qp-stage），直接塞 height:100% 的
     iframe 会塌成 iframe 默认高度 150px（线上实测桌面 784×150、手机 366×150，
     视频被压成一条）。外壳方案对 76 的原生宿主（.nv-*）零影响。 */
  function srcFrame(src, allow) {
    return '<div class="dpv-frame"><iframe src="' + src + '"'
      + ' allow="' + (allow || 'autoplay; encrypted-media; fullscreen; picture-in-picture') + '"'
      + ' allowfullscreen scrolling="no" frameborder="no"'
      + ' referrerpolicy="origin-when-cross-origin"></iframe></div>';
  }

  /* YouTube 官方播放：分集 URL → nocookie embed，塞进 #dpPlayer 槽。
     播放器 UI 直接用 YouTube 官方播放器（用户点名「抄别人的」），国内需代理。 */
  function ytKey(url) {
    var m = /[?&]v=([\w-]{6,})/.exec(url || '') || /youtu\.be\/([\w-]{6,})/.exec(url || '');
    return m ? m[1] : '';
  }
  function srcEmbedYT(box, url, ep, cn) {
    var key = ytKey(url);
    if (!key) return false;
    var slot = box.querySelector('#dpPlayer') || box;
    if (window.__qpAbort === 'function') window.__qpAbort();
    if (window.__biliAbort === 'function') window.__biliAbort();
    if (window.QPlayer && typeof window.QPlayer.close === 'function') window.QPlayer.close();
    slot.innerHTML = srcFrame('https://www.youtube-nocookie.com/embed/'
      + encodeURIComponent(key) + '?autoplay=1&rel=0&modestbranding=1');
    /* 官方频道视频 98.5% 带地区限制（HK/MO/TW/SG/MY，不含 CN）：能直连播的就说能播，
       不能的明确写「需港澳台出口」，别再统一写「国内访问需代理」造成误解。 */
    srcHint(box, cn === 1
      ? 'YouTube 官方频道 · 本集中国大陆可直连播放'
      : 'YouTube 官方频道 · 本集需港澳台/东南亚出口（B 站源不受地区限制）');
    return true;
  }

  /* B 站官方嵌入：直接给 bvid（官方 player iframe，**不需要任何账号**）。 */
  function srcEmbedBvid(box, bvid) {
    if (!bvid) return false;
    if (window.__qpAbort === 'function') window.__qpAbort();
    if (window.__biliAbort === 'function') window.__biliAbort();
    if (window.QPlayer && typeof window.QPlayer.close === 'function') window.QPlayer.close();
    var slot = box.querySelector('#dpPlayer') || box;
    slot.innerHTML = srcFrame('https://player.bilibili.com/player.html?bvid='
      + encodeURIComponent(bvid) + '&page=1&high_quality=1&danmaku=1&autoplay=1');
    srcHint(box, 'B 站官方播放器 · 登录 B 站后本页即可看更高清晰度');
    return true;
  }

  /* 番剧官方源（PGC）：B 站官方「站外播放器」的参数是 **episodeId + seasonId**
     （不是 ep_id/season_id），实测 player.bilibili.com 该形态 200 且无 X-Frame-Options。
     免费集直接嵌；**会员集只返回试看片段**，所以不嵌 —— 交回调方降级并提示去官方页，
     不碰任何会员 cookie / 付费绕过。 */
  function srcEmbedPgc(box, sid, ep, epNo) {
    if (!box || !sid || !ep || !ep.id) return false;
    if (window.__qpAbort === 'function') window.__qpAbort();
    if (window.__biliAbort === 'function') window.__biliAbort();
    if (window.QPlayer && typeof window.QPlayer.close === 'function') window.QPlayer.close();
    var slot = box.querySelector('#dpPlayer') || box;
    slot.innerHTML = srcFrame('https://player.bilibili.com/player.html?episodeId='
      + encodeURIComponent(ep.id) + '&seasonId=' + encodeURIComponent(sid)
      + '&autoplay=1&high_quality=1&danmaku=1');
    srcHint(box, 'B 站官方番剧 · 第 ' + epNo + ' 集（免费集，免登录）');
    return true;
  }

  /* 盒子 /bili/pgc?t=<片名>：匿名（复用 /bili/find 的 buvid3）+ 24h 缓存，
     返回 {sid, eps:[{i,id,vip}]}。匹配在盒子侧收得很紧（季号必须一致），
     宁可 notfound 也不挂错季。 */
  function srcPgc(title) {
    if (typeof biliGet !== 'function') return Promise.resolve(null);
    return biliGet('pgc', { t: title }).then(function (d) {
      return (d && d.ok && d.found && d.sid && (d.eps || []).length) ? d : null;
    }, function () { return null; });
  }

  /* extra[5] 里 build 期对齐好的 bvid（bili.json 索引） */
  function srcEmbedBili(box, id) {
    var exb = (typeof ANI !== 'undefined' && ANI.extra) ? ANI.extra[id] : null;
    return srcEmbedBvid(box, exb && exb[5]);
  }

  /* 匿名实时搜 B 站：盒子 /bili/find 用匿名 buvid3，不碰任何用户绑定。
     解说 / 合集 / OP 之类按 80-bili 同一份 BILI_NOISE 黑名单剔掉，不当正片。 */
  function biliFindBvid(title) {
    if (typeof biliGet !== 'function') return Promise.reject(new Error('no biliGet'));
    return biliGet('find', { t: title }).then(function (f) {
      if (!f || !f.found || !f.bvid) return '';
      var t = String(f.title || '');
      if (typeof BILI_NOISE === 'object' && BILI_NOISE.test && BILI_NOISE.test(t)) return '';
      return String(f.bvid);
    }, function () { return ''; });
  }

  /* YouTube 可达性探测（1.8s 超时，结果缓存 10 分钟）：
     国内直连 youtube.com 会挂起/超时 —— 不做这一步，点「开始观看」会先卡在
     白屏 iframe 上，用户还得手动切到 B 站。探测用 no-cors 的 204 端点，
     只判「网络层通不通」，不涉及任何账号。 */
  var YT_REACH = null;
  function ytReach() {
    if (YT_REACH) return YT_REACH;
    YT_REACH = new Promise(function (resolve) {
      var done = false;
      function fin(ok) { if (!done) { done = true; resolve(ok); } }
      var ctl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctl) ctl.abort(); fin(false); }, 1800);
      try {
        fetch('https://www.youtube.com/generate_204', {
          mode: 'no-cors', cache: 'no-store', signal: ctl ? ctl.signal : undefined
        }).then(function () { clearTimeout(timer); fin(true); },
               function () { clearTimeout(timer); fin(false); });
      } catch (e) { clearTimeout(timer); fin(false); }
    });
    setTimeout(function () { YT_REACH = null; }, 10 * 60 * 1000);   // 10 分钟后重新探
    return YT_REACH;
  }

  /* 自动播放链：YouTube 官方正片（可达时）→ B 站官方嵌入 → 夸克转存（幕后）。
     返回 true = 已接管（可能是异步的，先占住播放器槽），false = 让调用方走兜底。 */
  /* 自动播放链（2026-11-08 定版）：**B 站 → YouTube → 网盘**。
     B 站排第一是因为它**不需要登录**：官方 player iframe 匿名就能播（bvid 来自 build 期索引
     或盒子匿名 /bili/find 实时搜索）。YouTube 要有官方正片且网络可达；网盘兜底（需登录+绑定）。 */
  function srcStart(box, id, title, ep) {
    var epNo = Math.max(1, Math.floor(Number(ep) || 1));
    var slot = box.querySelector('#dpPlayer') || box;
    var tk = (typeof authToken === 'function') ? authToken() : '';

    function toQuark(why) {
      srcHint(box, why + ' · 使用网盘源');
      if (typeof openQuarkPlay === 'function') openQuarkPlay(slot, id, title);
      if (!tk && typeof openAuthPanel === 'function') openAuthPanel('email');
    }

    function toYoutube(why) {
      var eps = srcYtEps(id);
      if (!eps) { toQuark(why + ' · 无官方正片'); return; }
      var idx = Math.max(0, Math.min(eps.length - 1, epNo - 1));
      srcHint(box, why + ' · 检测 YouTube 可达性…');
      ytReach().then(function (ok) {
        var pick = eps[idx] || [];
        if (ok && srcEmbedYT(box, pick[1], epNo, pick[2])) return;
        toQuark(why + ' · YouTube 不可达');
      });
    }

    /* ⓪ 已绑定 B 站 → 直接用**登录态**播放（1080p / 大会员集都能出）。
       这是我 rewiring 播放链时漏掉的一环：biliPlayEp 只被 80-bili 的旧入口引用，
       srcStart 完全走匿名链 —— 于是「扫码绑定成功」对播放体验毫无影响（用户原话：扫码后也没用）。 */
    function anonChain() {
    /* ① 先试**官方番剧（PGC）免费集**：官方正片 + 官方字幕，比 UGC 准（不会搜到解说/搬运）。
       盒子侧 24h 缓存 + nginx 10 分钟边缘缓存，重复点几乎零延迟；会员集只有试看，不嵌。 */
    srcHint(box, '正在匹配 B 站官方番剧…');
    srcPgc(title).then(function (p) {
      if (p) {
        var row = p.eps[Math.max(0, epNo - 1)] || p.eps[0];
        if (row && !row.vip && srcEmbedPgc(box, p.sid, row, epNo)) return;
        if (row && row.vip) {
          srcHint(box, '第 ' + epNo + ' 集是 B 站大会员集（仅试看）· 已换下一个源');
        }
      }
      /* ② build 期索引里的 UGC bvid（同步、零等待） */
      if (srcEmbedBili(box, id)) return;
      /* ③ 匿名实时搜 UGC（盒子用匿名 buvid3，不碰任何用户绑定） */
      srcHint(box, '正在 B 站搜索「' + title + '」…');
      biliFindBvid(title).then(function (bv) {
        if (bv && srcEmbedBvid(box, bv)) return;
        toYoutube('B 站未找到');
      }, function () { toYoutube('B 站搜索失败'); });
    });
    }

    if (tk && typeof biliPlayEp === 'function') {
      srcHint(box, '正在检查 B 站登录态…');
      srcGet('/bili/bind', tk).then(function (r) {
        var j = (r && r.j) || {};
        if (r && r.ok && j.ok && j.bound) {
          srcHint(box, 'B 站已绑定 · 用登录态播放（清晰度/会员集解锁）');
          biliPlayEp(box, id, title, epNo);
          return;
        }
        anonChain();
      }, anonChain);
      return true;
    }
    anonChain();
    return true;
  }

  window.__srcStart = srcStart;          // 65-detail 的「开始观看」用

  /* 三个探测并发；任一失败只影响自己那一行（各自 .catch 在探测内成形）。
     同一 "<id>:<ep>" 60s 内复用同一次结果/在途 promise：二次 mount 不重复请求。 */
  function srcProbe(id, title, ep, force) {
    var key = String(id) + ':' + String(ep);
    var now = Date.now(), mem = SRC_MEM[key];
    if (!force && mem && now - mem.ts < SRC_TTL) return mem.pend || Promise.resolve(mem.data);
    var rec = { ts: now, data: null, pend: null };
    SRC_MEM[key] = rec;
    var tk = srcToken();
    var ytEps = srcYtEps(id);
    rec.pend = Promise.all([
      Promise.resolve(ytEps ? { kind: 'has', eps: ytEps } : { kind: 'none' }),
      srcProbeBili(tk, title),
      srcProbeMagnet(title, id, ep)
    ]).then(function (arr) {
      var data = { yt: arr[0], bili: arr[1], magnet: arr[2] };
      if (SRC_MEM[key] === rec) { rec.data = data; rec.ts = Date.now(); }   // 代次没被重探顶掉才落缓存
      return data;
    });
    return rec.pend;
  }

  /* 面板骨架：四行同构，绑定按钮先收起（hidden），探测出「需绑定」才打开。
     文案初值「检测中…」与 mount 的异步结果无关，JS 没跑完也不会留空白。 */
  function srcPanelHtml(id, title, ep) {
    var rows = SRC_KEYS.map(function (k) {
      return '<span class="qp-line-row" data-row="' + k + '">'
        + '<button class="qp-line" type="button" data-src="' + k + '">'
        + esc(SRC_NAME[k]) + ' · 检测中…</button>'
        + '<button class="btn" type="button" data-act="bind-' + k + '" hidden>'
        + esc(SRC_BIND[k] || '绑定') + '</button>'
        + '</span>';
    }).join('');
    return '<section class="dp-srcs" data-open="1" data-bgm="' + esc(id) + '">'
      + '<div class="sec-h"><h2>播放源</h2>'
      + '<span class="sec-sub" id="srcHint">按可用性排序</span></div>'
      + '<div class="qp-line-list" id="srcList">' + rows + '</div>'
      + '</section>';
  }

  /* 单个行重画：文案 + .on（可用）+ .is-bad（失败）+ 绑定按钮显隐。
     className 用手写拼接而不是 classList：老浏览器与离线 DOM 桩都不必有 classList。 */
  function srcCls(el, cls, on) {
    if (!el) return;
    var parts = String(el.className || '').split(/\s+/), has = false, out = [];
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      if (parts[i] === cls) { has = true; if (!on) continue; }
      out.push(parts[i]);
    }
    if (on && !has) out.push(cls);
    el.className = out.join(' ');
  }

  function srcRowOf(list, key) {
    var rows = list ? list.querySelectorAll('.qp-line-row') : [];
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].getAttribute('data-row') || '') === key) return rows[i];
    }
    return null;
  }

  function srcSetRow(list, key, text, opt) {
    var row = srcRowOf(list, key);
    if (!row) return;
    opt = opt || {};
    var btn = row.querySelector('.qp-line');
    if (btn) {
      btn.textContent = text;
      srcCls(btn, 'on', !!opt.on);
      srcCls(btn, 'is-bad', !!opt.bad);
    }
    /* data-fail=1 的行点下去是「重探」，不是「播放」 */
    row.setAttribute('data-fail', opt.retry ? '1' : '0');
    /* opt.hide：整行隐藏（没有官方正片时别占一行「本季无正片」的灰字噪音） */
    row.hidden = !!opt.hide;
    var bind = row.querySelector('.btn');
    if (bind) bind.hidden = !opt.bind;
  }

  /* 文案总表：data=null 表示还在探测。ep 是当前集（1 起）。 */
  function srcPaint(panel, id, ep, data) {
    var list = panel ? panel.querySelector('.qp-line-list') : null;
    if (!list) return;
    var epNo = Number(ep) > 0 ? Math.floor(Number(ep)) : 1;

    var y = data && data.yt;
    if (!data) srcSetRow(list, 'yt', 'YouTube 官方 · 检测中…');
    else if (y.kind === 'has') {
      /* 官方频道视频绝大多数带地区限制（HK/MO/TW/SG/MY，不含 CN）：把「能直连播几集」说清楚，
         别让用户点了才发现 "not available in your country"。eps 第三位 1=大陆可播。 */
      var cnN = 0, hdN = 0;
      for (var yi = 0; yi < y.eps.length; yi++) {
        var e0 = y.eps[yi];
        if (Array.isArray(e0) && e0[2] === 1) cnN++;
        if (Array.isArray(e0) && e0[3] === 1) hdN++;
      }
      var ytLabel = 'YouTube 官方 · ' + y.eps.length + ' 集'
        + (hdN ? ' · 1080p' : '')
        + (cnN === y.eps.length ? '可看' : (cnN ? '（' + cnN + ' 集大陆直连）' : '（需港澳台出口）'));
      srcSetRow(list, 'yt', ytLabel, { on: true });
    }
    /* 没有官方正片时不再整行隐藏：三个源要能看见（用户口径「就三个源」），
       但文案说清是「没收录」而不是「坏了」，也不加 .on，点它只会退到 B 站。 */
    else srcSetRow(list, 'yt', 'YouTube 官方 · 本季未收录');

    var b = data && data.bili;
    if (!data) srcSetRow(list, 'bili', 'B 站 · 检测中…');
    else if (b.pgc && b.pgc.found) {
      /* 官方番剧命中：直接报「免费几集」，比「免登录可看」更有信息量 */
      var pg = b.pgc.eps || [];
      var freeN = 0;
      for (var pi = 0; pi < pg.length; pi++) if (!pg[pi].vip) freeN++;
      srcSetRow(list, 'bili', 'B 站官方 · 免费 ' + freeN + '/' + pg.length + ' 集',
                { on: freeN > 0, bind: b.kind !== 'bound' });
    }
    else if (b.kind === 'bound') {
      /* 绑定后播放走登录态（biliPlayEp），所以文案要把「能看什么」说清楚 */
      srcSetRow(list, 'bili', 'B 站 · 已绑定 ' + b.uname + '（' + (b.vip ? '大会员' : '已登录') + '）', { on: true });
    }
    /* 未登录也能看：player.bilibili.com 官方嵌入不要求账号，只是清晰度受限。
       所以文案是「免登录可看」，右侧给「登录高清」——绑定是升级，不是门槛。 */
    else if (b.kind === 'unbound') srcSetRow(list, 'bili', 'B 站 · 免登录可看', { on: true, bind: true });
    else srcSetRow(list, 'bili', 'B 站 · 检测失败 · 点此重试', { bad: true, retry: true });

    /* 网盘行常显「绑定」：未登录→弹登录；已登录→带 token 打开夸克绑定页（网页+TV 两步）。
       之前夸克绑定入口只在「我的」页，用户反馈「根本没地方绑」。 */
    var mg = data && data.magnet;
    if (!data) srcSetRow(list, 'magnet', '网盘 · 检测中…', { bind: true });
    else if (mg.kind === 'has') srcSetRow(list, 'magnet', '网盘 · 第 ' + epNo + ' 集可转存', { on: true, bind: true });
    else if (mg.kind === 'none') srcSetRow(list, 'magnet', '网盘 · 本集无资源', { bind: true });
    else srcSetRow(list, 'magnet', '网盘 · 检测失败 · 点此重试', { bad: true, retry: true, bind: true });
  }

  function srcHint(host, text) {
    var panel = host && host.querySelector ? host.querySelector('.dp-srcs') : null;
    var h = panel ? panel.querySelector('.sec-sub') : null;
    if (h) h.textContent = text;
  }

  /* host = 插入点父节点（详情页 #modal、弹窗 #modal）；面板自己在 host 里找。
     force=true 是「检测失败 → 点此重试」那条路：清掉缓存、重画成检测中、重发探测。 */
  function srcMount(host, id, title, ep, force) {
    if (!host || !host.querySelector) return;
    var panel = host.querySelector('.dp-srcs');
    if (!panel) return;
    var list = panel.querySelector('.qp-line-list');
    if (!list) return;
    var epNo = Number(ep) > 0 ? Math.floor(Number(ep)) : 1;
    var gen = ++SRC_MGEN;
    panel.setAttribute('data-mgen', String(gen));
    list.onclick = function (ev) { srcClick(host, list, ev, id, title, epNo); };
    srcHint(host, '按可用性排序');
    if (!force) {
      var key = String(id) + ':' + String(epNo), mem = SRC_MEM[key];
      if (mem && mem.data && Date.now() - mem.ts < SRC_TTL) {
        srcPaint(panel, id, epNo, mem.data);       // 60s 内二次 mount：不重探、立刻有文案
        return;
      }
    }
    srcPaint(panel, id, epNo, null);
    srcProbe(id, title, epNo, force).then(function (data) {
      if (panel.getAttribute('data-mgen') !== String(gen)) return;   // 已被重探/重画取代
      srcPaint(panel, id, epNo, data);
    });
  }

  function srcPanelMount(host, id, title, ep) { srcMount(host, id, title, ep, false); }

  function srcOpenUrl(url) {
    try {
      if (typeof window.open === 'function') {
        var w = window.open(url, '_blank', 'noopener');
        if (w) return;
      }
    } catch (e) { /* 被拦截：退化成同页跳转 */ }
    try { window.location.href = url; } catch (e2) { /* 忽略 */ }
  }

  /* B 站「登录高清」：**站内弹窗扫码**，不再新开标签跳到「我的」页再自己找入口
     （用户反馈「登录高清还是没有」——点了只是换了个标签页，看不出发生了什么）。
     流程与 45-user 的卡片一致：/bili/qr/start 出二维码 → 每 2s 轮询 /bili/qr/poll →
     ok 后关窗、重探播放源，并提示「重开播放即为高清/会员集」。 */
  function openBiliBindPanel() {
    if (document.getElementById('bbmask')) return;
    if (typeof authToken === 'function' && !authToken()) {
      if (typeof openAuthPanel === 'function') openAuthPanel('email');
      return;
    }
    var mask = document.createElement('div');
    mask.className = 'authmask qbmask';
    mask.id = 'bbmask';
    mask.innerHTML = '<div class="authcard qbcard" role="dialog" aria-modal="true">'
      + '<button class="authx" type="button" aria-label="关闭">×</button>'
      + '<h3 class="qbtitle">登录 B 站（换高清 / 会员集）</h3>'
      + '<p class="qbhint">用 B 站 App 扫码，绑定后本页播放会走你的账号（1080p、大会员集）。</p>'
      + '<div class="qbqr" id="bbqr"><p class="authhint">二维码生成中…</p></div>'
      + '<p class="qbhint" id="bbmsg" role="status" aria-live="polite"></p>'
      + '</div>';
    document.body.appendChild(mask);

    var timer = 0, tries = 0, key = '', busy = false, stopped = false;
    function stop() { stopped = true; if (timer) { clearInterval(timer); timer = 0; } }
    function close() { stop(); if (mask.parentNode) mask.parentNode.removeChild(mask); document.removeEventListener('keydown', onKey); }
    function onKey(ev) { if (ev.key === 'Escape') close(); }
    function msg(t) { var el = document.getElementById('bbmsg'); if (el) el.textContent = t || ''; }

    mask.onclick = function (ev) {
      var t = ev.target;
      if (t === mask || (t && String(t.className || '').indexOf('authx') >= 0)) close();
    };
    document.addEventListener('keydown', onKey);

    function poll() {
      timer = setInterval(function () {
        if (stopped || !key || busy) return;
        if (++tries > 90) { msg('二维码已过期，关掉重开一次'); stop(); return; }
        busy = true;
        srcGet('/bili/qr/poll?key=' + encodeURIComponent(key), authToken()).then(function (r) {
          busy = false;
          if (stopped) return;
          var j = (r && r.j) || {};
          var st = String(j.state || '');
          if (st === 'ok') {
            stop();
            close();
            var host = document.querySelector('#modal') || document;
            srcHint(host, 'B 站已绑定（' + (j.uname || '已登录') + '）· 重新点播放即为高清/会员集');
            var panel = host.querySelector ? host.querySelector('.dp-srcs') : null;
            if (panel) srcMount(host, panel.getAttribute('data-bgm') || '', '', 1, true);
            return;
          }
          if (st === 'scanned') msg('已扫码，请在手机上确认');
          else if (st === 'expired') { msg('二维码已过期，关掉重开一次'); stop(); }
        }, function () { busy = false; });
      }, 2000);
    }

    srcAuth('/bili/qr/start', 'POST', {}).then(function (r) {
      if (stopped) return;
      var j = (r && r.j) || {};
      if (!r || !r.ok || !j.ok || !j.png) {
        msg(r && r.status === 429 ? '操作太频繁，等一分钟再试' :
            (r && r.status === 503 ? '服务端缺少二维码组件，请到「我的」页用粘贴 SESSDATA' : '二维码生成失败'));
        return;
      }
      key = String(j.key_id || '');
      var box = document.getElementById('bbqr');
      if (box) {
        box.innerHTML = '<img alt="B站登录二维码" src="' + esc(j.png) + '">'
          + '<button class="mnote-btn" id="bbqrsave" type="button">保存二维码</button>';
        var sv = document.getElementById('bbqrsave');
        if (sv) sv.onclick = function () { srcSaveDataUri(j.png, 'bilibili-login-qr.png'); };
      }
      msg('用 B 站 App 扫码 · 180 秒内有效');
      poll();
    }, function () { msg('二维码生成失败，请重试'); });
  }

  /* data: URI → Blob 下载（手机长按 data URI 常保存不了，见 45-user 的同名逻辑） */
  function srcSaveDataUri(src, filename) {
    var m = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(src || ''));
    if (!m) return;
    try {
      var bin = atob(m[2].replace(/\s+/g, ''));
      var buf = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      var type = m[1].toLowerCase() === 'png' ? 'image/png' : 'image/jpeg';
      var url = URL.createObjectURL(new Blob([buf], { type: type }));
      var a = document.createElement('a');
      a.href = url; a.download = filename || 'qr.png';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 20000);
    } catch (e) { /* 忽略：用户还能长按图片 */ }
  }

  /* 夸克网盘绑定：**内嵌弹窗**，不再新开标签页（用户反馈「怎么还跳转页面」）。
     盒子 /qr 页面没有 X-Frame-Options，可以直接 iframe；加 &embed=1 让它收掉页头，
     绑定成功后它 postMessage({type:'quark-bound'}) —— 我们关窗 + 重探播放源，
     用户直接就能点播放。关掉弹窗也不影响绑定（服务端已落库）。 */
  function openQuarkBindPanel() {
    if (document.getElementById('qbmask')) return;
    if (typeof authToken === 'function' && !authToken()) {
      if (typeof openAuthPanel === 'function') openAuthPanel('email');
      return;
    }
    var mask = document.createElement('div');
    mask.className = 'authmask qbmask';
    mask.id = 'qbmask';
    mask.innerHTML = '<div class="authcard qbcard" role="dialog" aria-modal="true">'
      + '<button class="authx" type="button" aria-label="关闭">×</button>'
      + '<h3 class="qbtitle">绑定夸克网盘</h3>'
      + '<p class="qbhint">用夸克 App 扫码，扫完自动绑定（只需一次）。绑定后网盘源可直接播放。</p>'
      + '<div class="qbframe"><iframe src="' + esc(quarkBindUrl('&embed=1')) + '"'
      + ' referrerpolicy="origin-when-cross-origin" allow="clipboard-write"></iframe></div>'
      + '</div>';
    document.body.appendChild(mask);

    function cleanup() {
      if (mask.parentNode) mask.parentNode.removeChild(mask);
      window.removeEventListener('message', onMsg);
      document.removeEventListener('keydown', onKey);
    }
    function onMsg(ev) {
      if (String(ev.origin).indexOf('120.48.56.189') < 0) return;
      var d = ev.data || {};
      if (d && d.type === 'quark-bound' && d.ok) {
        cleanup();
        var host = document.querySelector('#modal') || document;
        srcHint(host, '夸克网盘已绑定 · 重探播放源…');
        var panel = host.querySelector ? host.querySelector('.dp-srcs') : null;
        if (panel) {
          var bgm = panel.getAttribute('data-bgm') || '';
          srcMount(host, bgm, '', 1, true);       // force 重探
        }
      }
    }
    function onKey(ev) { if (ev.key === 'Escape') cleanup(); }
    mask.onclick = function (ev) {
      var t = ev.target;
      if (t === mask || (t && String(t.className || '').indexOf('authx') >= 0)) cleanup();
    };
    window.addEventListener('message', onMsg);
    document.addEventListener('keydown', onKey);
  }

  function srcClick(host, list, ev, id, title, ep) {
    var t = ev && ev.target ? ev.target : null;
    while (t && t !== list) {
      if (t.getAttribute && (t.getAttribute('data-src') || t.getAttribute('data-act'))) break;
      t = t.parentNode;
    }
    if (!t || t === list) return;
    var act = t.getAttribute('data-act');
    if (act) {                                    // 绑定入口：只导航，不播放
      if (act === 'bind-magnet') {
        /* 网盘绑定：已登录 → 站内弹窗扫码（不再新开标签页）；未登录 → 先弹登录 */
        if (typeof authToken === 'function' && authToken()) openQuarkBindPanel();
        else if (typeof openAuthPanel === 'function') openAuthPanel('email');
        return;
      }
      if (act === 'bind-bili') {
        /* 原来这里 srcOpenUrl('/user') 新开标签 —— 用户反馈「登录高清还是没有」，
           因为跳过去只是「我的」页，还得自己找卡片扫。改成站内弹窗扫码。 */
        if (typeof authToken === 'function' && authToken()) openBiliBindPanel();
        else if (typeof openAuthPanel === 'function') openAuthPanel('email');
      }
      return;
    }
    var key = t.getAttribute('data-src');
    if (!key) return;
    var row = t.parentNode;
    if (row && String(row.getAttribute('data-fail') || '') === '1') {
      srcMount(host, id, title, ep, true);        // 失败行：点一下重探
      return;
    }
    srcPlay(key, host, id, title, ep);
  }

  /* 切源：先关掉当前播放器，再把在途的夸克 / B 站请求作废（各自模块自增代次），
     最后才分发 —— 否则旧的 find/playurl 回来会把新播放器的状态写花。 */
  function srcPlay(key, m, id, title, ep) {
    var epNo = Number(ep) > 0 ? Math.floor(Number(ep)) : 1;
    var box = m && m.querySelector ? m : (typeof $ === 'function' ? $('#modal') : null);
    if (!box) return;
    if (window.QPlayer && typeof window.QPlayer.close === 'function') window.QPlayer.close();
    if (typeof window.__qpAbort === 'function') window.__qpAbort();
    if (typeof window.__biliAbort === 'function') window.__biliAbort();

    if (key === 'yt') {
      var eps = srcYtEps(id);
      if (!eps) { srcHint(box, '本季没有官方 YouTube 正片'); return; }
      var idx = Math.max(0, Math.min(eps.length - 1, epNo - 1));
      var pickYt = eps[idx] || [];
      srcEmbedYT(box, pickYt[1], epNo, pickYt[2]);
      return;
    }
    if (key === 'bili') {
      /* 点「B 站」行 = 手动选这个源：走 srcStart 同一条链（PGC 免费集 → 索引 bvid →
         匿名 find → YouTube → 网盘），不再自己复制一份顺序逻辑，也不掉进需要登录的 biliPlayEp。 */
      srcStart(box, id, title, epNo);
      return;
    }
    if (key === 'magnet') {                        // 磁力 → 转存后在线播放（夸克在幕后，不列出）
      var q = box.querySelector('#dpPlayer') || box;
      if (typeof openQuarkPlay === 'function') openQuarkPlay(q, id, title);
    }
  }


