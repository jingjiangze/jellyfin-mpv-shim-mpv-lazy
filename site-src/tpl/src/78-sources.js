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
  var SRC_QUARK_BIND = 'https://120.48.56.189/qr/';
  var SRC_USER = '/user';                       // B 站绑定在个人主页
  var SRC_KEYS = ['quark', 'bili', 'byo', 'magnet'];
  var SRC_NAME = { quark: '夸克网盘', bili: 'B 站', byo: '自备源', magnet: '磁力' };
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
  function srcPickEp(items, title, ep) {
    if (typeof qpPickEp === 'function') return qpPickEp(items || [], title, ep);
    var list = items || [], re = null;
    try { re = new RegExp('第\\s*' + ep + '\\s*[话話集期]|\\[0?' + ep + '(?:v\\d)?\\]', 'i'); }
    catch (e) { return null; }
    for (var i = 0; i < list.length; i++) {
      if (list[i] && re.test(String(list[i].name || ''))) return list[i];
    }
    return null;
  }

  function srcProbeQuark(title, ep, tk) {
    return srcGet('/tvplay/find?q=' + encodeURIComponent(title) + '&limit=20', tk).then(function (r) {
      var j = r.j || {}, st = String(j.state || '');
      if (st === 'found') return { kind: 'found', hit: !!srcPickEp(j.items, title, ep) };
      if (st === 'none') return { kind: 'none' };
      if (st === 'need_rebind' || st === 'unauthorized') return { kind: 'bind' };
      /* 后端没带 state 时按 HTTP 码兜底（与 75 的 qpReq 同一套码） */
      if (r.status === 409 || r.status === 401) return { kind: 'bind' };
      return { kind: 'error' };
    });
  }

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

  /* 自备源每次渲染都重读（用户在播放器里加一条线，面板重挂时立刻能看到条数）。
     只走 QPlayer 的只读入口，不碰 localStorage 细节 —— 键名与结构归 76 管。 */
  function srcByoCount(id) {
    var qp = window.QPlayer;
    if (!qp || !qp._lines || typeof qp._lines.of !== 'function') return 0;
    try {
      var arr = qp._lines.of(id);
      return Object.prototype.toString.call(arr) === '[object Array]' ? arr.length : 0;
    } catch (e) { return 0; }
  }

  /* 三个探测并发；任一失败只影响自己那一行（各自 .catch 在探测内成形）。
     同一 "<id>:<ep>" 60s 内复用同一次结果/在途 promise：二次 mount 不重复请求。 */
  function srcProbe(id, title, ep, force) {
    var key = String(id) + ':' + String(ep);
    var now = Date.now(), mem = SRC_MEM[key];
    if (!force && mem && now - mem.ts < SRC_TTL) return mem.pend || Promise.resolve(mem.data);
    var rec = { ts: now, data: null, pend: null };
    SRC_MEM[key] = rec;
    var tk = srcToken();
    rec.pend = Promise.all([
      srcProbeQuark(title, ep, tk),
      srcProbeBili(tk),
      srcProbeMagnet(title, id, ep)
    ]).then(function (arr) {
      var data = { quark: arr[0], bili: arr[1], magnet: arr[2] };
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
        + '<button class="btn" type="button" data-act="bind-' + k + '" hidden>绑定</button>'
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
    var bind = row.querySelector('.btn');
    if (bind) bind.hidden = !opt.bind;
  }

  /* 文案总表：data=null 表示还在探测。ep 是当前集（1 起）。 */
  function srcPaint(panel, id, ep, data) {
    var list = panel ? panel.querySelector('.qp-line-list') : null;
    if (!list) return;
    var epNo = Number(ep) > 0 ? Math.floor(Number(ep)) : 1;

    var q = data && data.quark;
    if (!data) srcSetRow(list, 'quark', '夸克网盘 · 检测中…');
    else if (q.kind === 'found') {
      if (q.hit) srcSetRow(list, 'quark', '夸克网盘 · 第 ' + epNo + ' 集已转存', { on: true });
      else srcSetRow(list, 'quark', '夸克网盘 · 本集未转存');
    }
    else if (q.kind === 'bind') srcSetRow(list, 'quark', '夸克网盘 · 需绑定', { bind: true });
    else if (q.kind === 'none') srcSetRow(list, 'quark', '夸克网盘 · 无此片');
    else srcSetRow(list, 'quark', '夸克网盘 · 检测失败 · 点此重试', { bad: true, retry: true });

    var b = data && data.bili;
    if (!data) srcSetRow(list, 'bili', 'B 站 · 检测中…');
    else if (b.kind === 'bound') {
      srcSetRow(list, 'bili', 'B 站 · ' + b.uname + '（VIP' + b.vip + '）', { on: true });
    }
    else if (b.kind === 'unbound') srcSetRow(list, 'bili', 'B 站 · 需绑定', { bind: true });
    else srcSetRow(list, 'bili', 'B 站 · 检测失败 · 点此重试', { bad: true, retry: true });

    /* 自备源不依赖网络：本地有几条就写几条，缓存命中时也是实时值 */
    var n = srcByoCount(id);
    if (n > 0) srcSetRow(list, 'byo', '自备源 · ' + n + ' 条', { on: true });
    else srcSetRow(list, 'byo', '自备源 · 未添加');

    var mg = data && data.magnet;
    if (!data) srcSetRow(list, 'magnet', '磁力 · 检测中…');
    else if (mg.kind === 'has') srcSetRow(list, 'magnet', '磁力 · 第 ' + epNo + ' 集可转存', { on: true });
    else if (mg.kind === 'none') srcSetRow(list, 'magnet', '磁力 · 本集无资源');
    else srcSetRow(list, 'magnet', '磁力 · 检测失败 · 点此重试', { bad: true, retry: true });
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
      if (act === 'bind-quark') {
        /* 绑定页要站点登录：有 token 就带上，没有先弹登录面板 */
        if (typeof authToken === 'function' && authToken()) srcOpenUrl(quarkBindUrl());
        else if (typeof openAuthPanel === 'function') openAuthPanel('email');
        else srcOpenUrl(SRC_QUARK_BIND);
      }
      else if (act === 'bind-bili') {
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

    if (key === 'bili') {
      if (typeof biliPlayEp === 'function') biliPlayEp(box, id, title, epNo);
      return;
    }
    if (key === 'byo') {
      var slot = box.querySelector('#dpPlayer') || box;
      if (typeof openQuarkPlay === 'function') openQuarkPlay(slot, id, title);
      /* 76 目前没有「展开线路」的公开方法（_lines 只有 of/save/del）：有就调，没有就明说 */
      if (!srcOpenLines()) srcHint(box, '在播放器里展开「线路」');
      return;
    }
    if (key === 'quark' || key === 'magnet') {     // 磁力同夸克：none 态由 75 自己给转存动作
      var q = box.querySelector('#dpPlayer') || box;
      if (typeof openQuarkPlay === 'function') openQuarkPlay(q, id, title);
    }
  }

  function srcOpenLines() {
    var qp = window.QPlayer;
    if (!qp) return false;
    var fn = qp.openLines || qp.showLines || qp.expandLines;
    if (typeof fn !== 'function') return false;
    try { fn(); return true; } catch (e) { return false; }
  }
