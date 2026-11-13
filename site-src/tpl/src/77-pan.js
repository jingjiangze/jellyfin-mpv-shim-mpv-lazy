  /* ---------------- 夸克网盘资源（全网搜索 → 转存 → 播放）----------------
     2026-11-14 新增（用户口径）：聚合全网夸克分享链接，能在站内直接转存到自己账号并播放。
       ① 搜索：盒子 /pans/search?kw=（PanSou 公开实例转发 + 10 分钟缓存），
          浏览器只在**用户点开**时查，不预取（服务器不替任何人"检测"）；
       ② 转存：/tvplay/share/add（站点会话鉴权，用你自己的夸克绑定）→ /share/task 轮询；
       ③ 播放：落地文件的 fid → /tvplay/url（TV 直链，mp4）；
       ④ 没登录/没绑夸克：给一句能操作的提示（登录面板 / 「我的」页扫码绑定）。
     服务面：盒子只做「转发 + 缓存」和复用已有的 tvplay 接口，不新增业务逻辑。 */
  var PAN_MEM = {};                 // kw -> {ts, data}
  var PAN_TTL = 10 * 60 * 1000;
  var PAN_BASE = (typeof SRC_BASE === 'string' && SRC_BASE) ? SRC_BASE : 'https://120.48.56.189';

  function panKw(title) {
    /* 搜索用主标题：去掉「第二季 / Season 2 / 剧场版」这类后缀，命中率更高 */
    return String(title || '')
      .replace(/第\s*[一二三四五六七八九十两兩\d]{1,3}\s*[季期部]/g, '')
      .replace(/\bseason\s*\d{1,2}\b/gi, '')
      .replace(/剧场版|劇場版/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function panSearch(kw, force) {
    kw = String(kw || '').trim();
    if (kw.length < 2) return Promise.resolve({ items: [], err: 'short' });
    var rec = PAN_MEM[kw];
    if (!force && rec && Date.now() - rec.ts < PAN_TTL) {
      return rec.pend || Promise.resolve(rec.data);
    }
    var o = { ts: Date.now(), data: null, pend: null };
    PAN_MEM[kw] = o;
    o.pend = srcGet('/pans/search?kw=' + encodeURIComponent(kw) + '&n=20', '').then(function (r) {
      var j = (r && r.j) || {};
      var data = { items: (r && r.ok && j.ok) ? (j.items || []) : [], err: (r && r.ok && j.ok) ? '' : ('HTTP ' + (r && r.status)) };
      if (PAN_MEM[kw] === o) { o.data = data; o.ts = Date.now(); }
      return data;
    }, function () {
      var data = { items: [], err: 'network' };
      if (PAN_MEM[kw] === o) { o.data = data; o.ts = Date.now(); }
      return data;
    });
    return o.pend;
  }

  /* 单行：标题 + 来源/时间 + 复制 + 转存并播放 */
  function panRow(it, i) {
    var meta = [it.source, (it.time || '').slice(0, 10)].filter(Boolean).join(' · ');
    return '<div class="qp-line-row pan-row" data-pan="' + i + '">'
      + '<button class="qp-line" type="button" data-act="open" title="在夸克打开">'
      + esc(it.title || it.url) + (meta ? '（' + esc(meta) + '）' : '') + '</button>'
      + '<button class="btn" type="button" data-act="copy">复制链接</button>'
      + '<button class="btn pri" type="button" data-act="save">转存并播放</button>'
      + '</div>';
  }

  function panListHtml(items) {
    if (!items || !items.length) return '<p class="plot">没有找到夸克分享 —— 换个片名再试试。</p>';
    return items.map(panRow).join('');
  }

  /* 绑定一次点击：打开 / 复制 / 转存并播放。box 是播放器容器（#modal）。 */
  function panBind(listEl, items, box, sid, title, beforeSave) {
    if (!listEl) return;
    listEl.onclick = function (ev) {
      var t = ev.target;
      while (t && t !== listEl && !(t.getAttribute && t.getAttribute('data-act'))) t = t.parentNode;
      if (!t || t === listEl) return;
      var row = t.parentNode;
      var i = Number(row && row.getAttribute ? row.getAttribute('data-pan') : -1);
      var it = items[i];
      if (!it) return;
      var act = t.getAttribute('data-act');
      if (act === 'open') {
        try { window.open(it.url, '_blank', 'noopener'); } catch (e) { location.href = it.url; }
        return;
      }
      if (act === 'copy') {
        panCopy(it.url + (it.pass ? (' 提取码 ' + it.pass) : ''));
        srcHint(box, '链接已复制');
        return;
      }
      if (act === 'save') {
        if (typeof beforeSave === 'function') beforeSave();
        panSave(it, box, sid, title);
      }
    };
  }

  function panCopy(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); return; }
    } catch (e) { }
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e2) { }
  }

  /* 转存 → 轮询任务 → 播第一个落地视频 */
  function panSave(it, box, sid, title) {
    if (typeof authToken !== 'function' || !authToken()) {
      srcHint(box, '先登录，再在「我的」页绑定夸克网盘');
      if (typeof openAuthPanel === 'function') openAuthPanel('email');
      return;
    }
    srcHint(box, '正在转存到你的夸克网盘…');
    panReq('/tvplay/share/add', 'POST', { url: it.url, sid: String(sid || 'quark'), title: String(title || '') })
      .then(function (r) {
        var j = (r && r.j) || {};
        if (r && r.status === 401) { srcHint(box, '登录状态失效，重新登录一次'); if (typeof openAuthPanel === 'function') openAuthPanel('email'); return; }
        if (j.state === 'need_rebind' || (r && r.status === 409)) { srcHint(box, '还没绑定夸克网盘 · 去「我的」页扫码'); return; }
        if (j.state === 'invalid_share') { srcHint(box, '这条分享已失效，换一条试试'); return; }
        if (!r || !r.ok || j.state !== 'queued' || !j.task_id) { srcHint(box, '转存失败：' + (j.state || (r && r.status) || 'error')); return; }
        panPoll(j.task_id, box, it, title, 0);
      }, function () { srcHint(box, '转存请求失败，稍后再试'); });
  }

  function panPoll(taskId, box, it, title, n) {
    if (n > 40) { srcHint(box, '转存超时（网盘可能还在下载），稍后到「我的」页看'); return; }
    var wait = n ? 3000 : 1200;
    setTimeout(function () {
      panReq('/tvplay/share/task?id=' + encodeURIComponent(taskId), 'GET', null).then(function (r) {
        var j = (r && r.j) || {};
        if (j.state === 'pending') { srcHint(box, '转存中… 第 ' + (n + 1) + ' 次查询'); panPoll(taskId, box, it, title, n + 1); return; }
        if (j.state === 'failed') { srcHint(box, '转存失败（分享可能已失效或网盘限流）'); return; }
        if (j.state === 'need_rebind') { srcHint(box, '夸克绑定失效 · 去「我的」页重新扫码'); return; }
        if (j.state === 'no_space') { srcHint(box, '夸克网盘空间不足'); return; }
        if (j.state === 'invalid_share') { srcHint(box, '这条分享已失效'); return; }
        var files = (j.files || []).filter(function (f) { return f && f.fid; });
        if (!files.length) { srcHint(box, '转存完成但没有可播放的视频文件'); return; }
        panPlayFile(box, files[0], it, title);
      }, function () { panPoll(taskId, box, it, title, n + 1); });
    }, wait);
  }

  function panPlayFile(box, file, it, title) {
    if (!window.QPlayer) return;
    QPlayer.open({ m: box, id: 'pan', title: String(title || it.title || ''), ep: 1, sources: [] });
    QPlayer.state('loading', { msg: '正在获取播放地址…' });
    panAskUrl(box, file, 0);
  }

  function panAskUrl(box, file, n) {
    if (n > 10) { QPlayer.state('error', { msg: '转码超时，稍后再试' }); return; }
    panReq('/tvplay/url?fid=' + encodeURIComponent(file.fid) + '&wait=45', 'GET', null).then(function (r) {
      var j = (r && r.j) || {};
      if (j.state === 'ready' && j.url) {
        QPlayer.play(String(j.url), String(file.name || '夸克网盘'));
        srcHint(box, '网盘资源 · ' + (file.name || '已转存') + ' · 播放中');
        return;
      }
      if (j.state === 'transcoding') {
        QPlayer.state('transcoding', { msg: '转码中… 约 1 分钟（' + (n + 1) + '/10）' });
        var wait = Number(j.retry_after) > 0 ? Number(j.retry_after) : 5;
        setTimeout(function () { panAskUrl(box, file, n + 1); }, Math.min(wait, 60) * 1000);
        return;
      }
      if (j.state === 'need_rebind') { QPlayer.state('rebind'); return; }
      if (j.state === 'unauthorized') { QPlayer.state('login'); return; }
      QPlayer.state('error', { msg: '播放地址获取失败' });
    }, function () { QPlayer.state('error', { msg: '播放地址获取失败' }); });
  }

  function panReq(path, method, body) {
    var tk = (typeof authToken === 'function' && authToken()) || '';
    var headers = { 'content-type': 'application/json' };
    if (tk) headers.authorization = 'Bearer ' + tk;
    var opt = { method: method || 'GET', headers: headers };
    if (body && opt.method !== 'GET') opt.body = JSON.stringify(body);
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 30000);
    if (ctl) opt.signal = ctl.signal;
    return fetch(PAN_BASE + path, opt).then(function (r) {
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

  /* ---------------- 详情页区块（默认收起，点开才查） ---------------- */
  function panSectionHtml() {
    return '<section class="sect dp-pan" id="dpPan">'
      + '<div class="sec-h"><h2>网盘资源</h2><span class="sec-sub" id="panSub">夸克网盘 · 点开才搜索</span></div>'
      + '<div class="qp-line-list" id="panList" hidden></div>'
      + '<div class="pan-acts"><button class="btn" id="panFind" type="button">查找夸克网盘资源</button></div>'
      + '</section>';
  }

  function panMount(host, id, title) {
    var btn = host.querySelector('#panFind');
    var list = host.querySelector('#panList');
    var sub = host.querySelector('#panSub');
    if (!btn || !list) return;
    var box = host.querySelector('#modal') ? host.querySelector('#modal') : host;
    var played = false;
    btn.onclick = function () {
      var kw = panKw(title);
      if (btn.getAttribute('data-open') === '1') {          // 再点收起
        list.hidden = true;
        btn.setAttribute('data-open', '0');
        btn.textContent = '查找夸克网盘资源';
        return;
      }
      btn.disabled = true;
      if (sub) sub.textContent = '正在搜索「' + kw + '」…';
      panSearch(kw).then(function (d) {
        btn.disabled = false;
        btn.setAttribute('data-open', '1');
        btn.textContent = '收起网盘资源';
        list.hidden = false;
        if (sub) sub.textContent = d.err ? ('搜索失败（' + d.err + '）') : (d.items.length + ' 条夸克分享 · 来自全网');
        list.innerHTML = panListHtml(d.items);
        panBind(list, d.items, box, id, title);
      });
    };
  }

  window.__panSearch = panSearch;
  window.__panListHtml = panListHtml;
  window.__panBind = panBind;
  window.__panKw = panKw;
