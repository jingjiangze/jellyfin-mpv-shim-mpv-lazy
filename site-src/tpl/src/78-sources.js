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

  /* 当前集在网盘里是否真有文件：复用 75 的挑集逻辑（片名归一 + 集号 + 取体积最大），
     保证「已转存」的判定与点开播放时一致，不另写一套口径。 */
  function srcProbeBili(tk) {
    return srcGet('/bili/bind', tk).then(function (r) {
      var j = r.j || {};
      if (r.ok && j.ok && j.bound) {
        return { kind: 'bound', uname: String(j.uname || '已绑定'), vip: Number(j.vip_type) || 0 };
      }
      if (r.status === 404 || r.status === 401) return { kind: 'unbound' };
      if (j.bound === false || j.error === 'not_bound' || j.ok === false) return { kind: 'unbound' };
      return { kind: 'error' };
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

  /* YouTube 官方播放：分集 URL → nocookie embed，塞进 #dpPlayer 槽。
     播放器 UI 直接用 YouTube 官方播放器（用户点名「抄别人的」），国内需代理。 */
  function ytKey(url) {
    var m = /[?&]v=([\w-]{6,})/.exec(url || '') || /youtu\.be\/([\w-]{6,})/.exec(url || '');
    return m ? m[1] : '';
  }
  function srcEmbedYT(box, url, ep) {
    var key = ytKey(url);
    if (!key) return false;
    var slot = box.querySelector('#dpPlayer') || box;
    if (window.__qpAbort === 'function') window.__qpAbort();
    if (window.__biliAbort === 'function') window.__biliAbort();
    if (window.QPlayer && typeof window.QPlayer.close === 'function') window.QPlayer.close();
    slot.innerHTML = '<iframe src="https://www.youtube-nocookie.com/embed/'
      + encodeURIComponent(key) + '?autoplay=1&rel=0&modestbranding=1"'
      + ' allow="autoplay; encrypted-media; fullscreen" allowfullscreen'
      + ' style="width:100%;height:100%;border:0;display:block"></iframe>';
    srcHint(box, 'YouTube 官方频道 · 播放器由 YouTube 提供（国内访问需代理，B 站源不受限）');
    return true;
  }

  /* B 站官方嵌入：直接给 bvid（官方 player iframe，**不需要任何账号**）。 */
  function srcEmbedBvid(box, bvid) {
    if (!bvid) return false;
    if (window.__qpAbort === 'function') window.__qpAbort();
    if (window.__biliAbort === 'function') window.__biliAbort();
    if (window.QPlayer && typeof window.QPlayer.close === 'function') window.QPlayer.close();
    var slot = box.querySelector('#dpPlayer') || box;
    slot.innerHTML = '<iframe src="https://player.bilibili.com/player.html?bvid='
      + encodeURIComponent(bvid) + '&page=1&high_quality=1&danmaku=1&autoplay=1"'
      + ' scrolling="no" frameborder="no" framespacing="0" allowfullscreen="true"'
      + ' style="width:100%;height:100%;border:0;display:block"></iframe>';
    srcHint(box, 'B 站官方播放器 · 登录 B 站后本页即可看更高清晰度');
    return true;
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
        if (ok && srcEmbedYT(box, (eps[idx] || [])[1], epNo)) return;
        toQuark(why + ' · YouTube 不可达');
      });
    }

    /* ① B 站（build 期索引命中就直接嵌，同步、最快） */
    if (srcEmbedBili(box, id)) return true;

    /* ①b 没有索引 → 匿名实时搜一次（盒子用匿名 buvid3，不碰任何用户绑定） */
    srcHint(box, '正在 B 站搜索「' + title + '」…');
    biliFindBvid(title).then(function (bv) {
      if (bv && srcEmbedBvid(box, bv)) return;
      toYoutube('B 站未找到');
    }, function () { toYoutube('B 站搜索失败'); });
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
      srcProbeBili(tk),
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
    else if (y.kind === 'has') srcSetRow(list, 'yt', 'YouTube 官方 · ' + y.eps.length + ' 集可看', { on: true });
    /* 没有官方正片时不再整行隐藏：三个源要能看见（用户口径「就三个源」），
       但文案说清是「没收录」而不是「坏了」，也不加 .on，点它只会退到 B 站。 */
    else srcSetRow(list, 'yt', 'YouTube 官方 · 本季未收录');

    var b = data && data.bili;
    if (!data) srcSetRow(list, 'bili', 'B 站 · 检测中…');
    else if (b.kind === 'bound') {
      srcSetRow(list, 'bili', 'B 站 · ' + b.uname + '（VIP' + b.vip + '）', { on: true });
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
        /* 网盘绑定：未登录先弹登录（绑定按站点 uid 归属），已登录带 token 跳绑定页 */
        if (typeof authToken === 'function' && authToken()) srcOpenUrl(quarkBindUrl());
        else if (typeof openAuthPanel === 'function') openAuthPanel('email');
        return;
      }
      if (act === 'bind-bili') {
        /* B 站绑定是按站点 uid 存的（bili_bind 表 uid 主键），没登录就没有「归属」，
           直接跳 /user 只会看到一句登录引导 —— 这里先弹登录面板，登录完再回主页绑定。 */
        if (typeof authToken === 'function' && authToken()) srcOpenUrl(SRC_USER);
        else if (typeof openAuthPanel === 'function') openAuthPanel('email');
        else srcOpenUrl(SRC_USER);
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
      srcEmbedYT(box, (eps[idx] || [])[1], epNo);
      return;
    }
    if (key === 'bili') {
      /* 索引里有官方 bvid → 直接官方嵌入（免登录）。没有就走 srcStart 的同一条匿名链：
         盒子 /bili/find 搜 bvid → YouTube → 网盘，而不是掉进需要登录的 biliPlayEp。 */
      if (srcEmbedBili(box, id)) return;
      srcStart(box, id, title, epNo);
      return;
    }
    if (key === 'magnet') {                        // 磁力 → 转存后在线播放（夸克在幕后，不列出）
      var q = box.querySelector('#dpPlayer') || box;
      if (typeof openQuarkPlay === 'function') openQuarkPlay(q, id, title);
    }
  }


