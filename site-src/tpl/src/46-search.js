  /* ---------------- 全网搜索页（/search）----------------
     站内目录 + 十家采集源的「全网」结果。站内用 ANI.rows 本地过滤（零请求）；
     全网走盒子 /ext/search?q=，跨源按片名合组（同一部片的多个线路合成一行），
     点「播放」直接在页内起 hls.js 播放（复用 79-extsrc 的 extCands/extPlay/extPlayEp）。

     入口：顶栏搜索框回车 → /search?q=<关键词>（在别的页面回车不再只是筛本地）。
     为什么单独一页：站内目录只有 Bangumi 收录的条目，用户常搜的是「没收录/译名对不上」
     的东西；外部采集源能补上，但一屏塞进列表页会把原有布局挤乱。 */

  function srchQ() {
    try { return (new URLSearchParams(location.search).get('q') || '').trim(); } catch (e) { return ''; }
  }

  /* 站内过滤（与 40-home 的 bindSearch 同口径：原名 + 中文名） */
  function srchLocal(q, grid, sub) {
    if (!grid) return;
    if (!q) { grid.innerHTML = ''; if (sub) sub.textContent = ''; return; }
    var nq = nrm(q), found = [];
    for (var i = 0; i < ANI.rows.length && found.length < 60; i++) {
      var r = ANI.rows[i];
      if (nrm(r[1] + ' ' + (r[2] || '')).indexOf(nq) !== -1) found.push(r);
    }
    if (sub) sub.textContent = found.length ? (found.length + ' 部') : '没收录';
    grid.innerHTML = found.length
      ? found.map(function (r) { return animeCard(r, { showYear: 1 }); }).join('')
      : '<p class="plot">站内目录没有匹配项 —— 看下面的全网源。</p>';
  }

  /* 全网：浏览器并发拉十家原始数据、本地合组（服务器只转发，不做检测）。
     失败退化成 {groups:[]}，页面只显示提示，不弹错。 */
  function srchExt(q) {
    if (typeof window.__extSearch !== 'function') return Promise.resolve({ groups: [] });
    return window.__extSearch(q, 30).then(function (gs) {
      return { groups: gs || [], total: (gs || []).length, err: '' };
    }, function () { return { groups: [], err: 'network' }; });
  }

  function srchRow(g, i) {
    var srcs = (g.items || []).length;
    var meta = [g.year, g.type, g.remarks].filter(Boolean).join(' · ');
    return '<div class="qp-line-row" data-g="' + i + '">'
      + '<button class="qp-line" type="button" data-act="play">' + esc(g.name)
      + ' · ' + srcs + ' 个源 · ' + (g.epsN || 0) + ' 集'
      + (meta ? '（' + esc(meta) + '）' : '') + '</button>'
      + '<button class="btn" type="button" data-act="play">播放</button>'
      + '</div>';
  }

  function renderSearch() {
    var main = $('#main');
    var q0 = srchQ();
    main.innerHTML = '<section class="sect">'
      +   '<div class="sec-h"><h2>全网搜索</h2><span class="sec-sub" id="locSub"></span></div>'
      +   '<div class="grid" id="locGrid"></div>'
      + '</section>'
      + '<section class="sect"><div class="sec-h"><h2>全网源</h2>'
      +   '<span class="sec-sub" id="extSub">输入片名后回车</span></div>'
      +   '<div class="dp-srcs" id="srchPlayWrap" hidden>'
      +     '<div class="sec-h"><h2>播放</h2><span class="sec-sub" id="srchHint"></span></div>'
      +     '<div id="srchPlay"><div class="dp-player" id="dpPlayer"></div></div>'
      +   '</div>'
      +   '<div class="dp-srcs"><div class="qp-line-list" id="extList"></div></div>'
      + '</section>'
      + '<section class="sect"><div class="sec-h"><h2>网盘资源</h2>'
      +   '<span class="sec-sub" id="panSub">夸克网盘 · 全网分享</span></div>'
      +   '<div class="qp-line-list" id="panList"></div></section>'
      + '<section class="sect"><div class="sec-h"><h2>规则源</h2>'
      +   '<span class="sec-sub" id="ruleSub">HTML 解析 · 站外播放器</span></div>'
      +   '<div class="qp-line-list" id="ruleList"></div></section>';

    var grid = $('#locGrid'), locSub = $('#locSub');
    var list = $('#extList'), extSub = $('#extSub');
    var panList = $('#panList'), panSub = $('#panSub');
    var ruleList = $('#ruleList'), ruleSub = $('#ruleSub');
    var qEl = $('#q');
    var GROUPS = [], GEN = 0;

    function runExt(v) {
      if (!v) { list.innerHTML = ''; extSub.textContent = '输入片名后回车'; return; }
      if (String(v).replace(/s+/g, '').length < 2) {
        GROUPS = []; list.innerHTML = '';
        extSub.textContent = '至少输入 2 个字';
        return;
      }
      var gen = ++GEN;
      extSub.textContent = '正在查外部源…';
      list.innerHTML = '';
      srchExt(v).then(function (d) {
        if (gen !== GEN) return;
        GROUPS = d.groups || [];
        if (d.err) { extSub.textContent = '外部源不可用（' + d.err + '），稍后再试'; return; }
        if (d.short) { extSub.textContent = '至少输入 2 个字'; return; }
        extSub.textContent = GROUPS.length
          ? (GROUPS.length + ' 部' + (d.total > GROUPS.length ? '（共 ' + d.total + '，显示前 ' + GROUPS.length + '）' : ''))
          : '没找到';
        list.innerHTML = GROUPS.length ? GROUPS.map(srchRow).join('')
          : '<p class="plot">外部源没有匹配的片名。换个说法（如只输入主标题）再试试。</p>';
      });
    }

    /* 规则源：逐源搜标题（HTML 解析，播放时再抓分集/播放页） */
    function runRules(v) {
      if (!ruleList) return;
      if (!v || String(v).replace(/s+/g, '').length < 2) { ruleList.innerHTML = ''; return; }
      if (typeof window.__ruleSearchAll !== 'function') { ruleList.innerHTML = ''; return; }
      ruleSub.textContent = '逐源搜索…';
      ruleList.innerHTML = '';
      window.__ruleSearchAll(v, 3).then(function (groups) {
        var rows = [], total = 0;
        (groups || []).forEach(function (g) {
          g.items.forEach(function (it, i) {
            total++;
            rows.push('<div class="qp-line-row" data-rule-src="' + esc(g.id) + '" data-rule-name="'
              + esc(it.name) + '"><button class="qp-line" type="button" data-act="play">'
              + esc(g.name) + ' · ' + esc(it.name) + (g.mode === 'iframe' ? '（站外）' : '')
              + '</button><button class="btn" type="button" data-act="play">播放</button></div>');
          });
        });
        ruleSub.textContent = total ? (total + ' 条候选 · ' + (groups || []).length + ' 个源') : '规则源没有结果';
        ruleList.innerHTML = rows.length ? rows.join('')
          : '<p class="plot">规则源没搜到（换主标题或去掉季号再试）。</p>';
      }, function () { ruleSub.textContent = '规则源不可用'; });
    }

    /* 夸克网盘资源：与「全网源」并行查（盒子 10 分钟缓存），转存直接播 */
    function runPan(v) {
      if (!panList) return;
      if (!v || String(v).replace(/s+/g, '').length < 2) { panList.innerHTML = ''; return; }
      panSub.textContent = '正在搜索夸克分享…';
      panList.innerHTML = '';
      window.__panSearch(window.__panKw(v), false, function () {
        panSub.textContent = '正在搜索夸克分享…首次约 10–25 秒';
      }).then(function (d) {
        var items = (d && d.items) || [];
        panSub.textContent = d && d.err
          ? (d.err === 'timeout' ? '搜索超时 · 回车重试' : ('搜索失败（' + d.err + '）'))
          : (items.length + ' 条夸克分享');
        panList.innerHTML = window.__panListHtml(items);
        window.__panBind(panList, items, $('#srchPlayWrap') || $('#srchPlay'), 'search', v, function () {
          var wrap = $('#srchPlayWrap');
          if (wrap) wrap.hidden = false;
          try { wrap.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) { }
        });
      });
    }

    function playGroup(i) {
      var g = GROUPS[i];
      if (!g) return;
      var items = g.items || [];
      if (!extCands(items, 1).length) { extSub.textContent = '这部没有可播放的线路'; return; }
      if (typeof window.__extAbort === 'function') window.__extAbort();
      var wrap = $('#srchPlayWrap');
      if (wrap) wrap.hidden = false;
      try { wrap.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) { }
      /* 传外层 #srchPlayWrap：它同时含 .dp-srcs 与 #dpPlayer，hint 才落得到 */
      extPlayEp(wrap || $('#srchPlay'), 'search:' + g.name, g.name, 1, items);
    }

    if (ruleList) ruleList.onclick = function (ev) {
      var el = ev.target;
      while (el && el !== ruleList && !(el.getAttribute && el.getAttribute('data-act'))) el = el.parentNode;
      if (!el || el === ruleList) return;
      var row = el.parentNode;
      var sid = row.getAttribute('data-rule-src');
      var nm = row.getAttribute('data-rule-name');
      var wrap = $('#srchPlayWrap');
      if (wrap) wrap.hidden = false;
      try { wrap.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) { }
      if (typeof window.__rulePlay === 'function' && sid && nm) {
        window.__rulePlay($('#srchPlayWrap') || $('#srchPlay'), 'search:' + nm, nm, 1, null, sid);
      }
    };

    list.onclick = function (ev) {
      var t = ev.target;
      while (t && t !== list && !(t.getAttribute && t.getAttribute('data-act'))) t = t.parentNode;
      if (!t || t === list) return;
      var row = t.parentNode;
      var i = Number(row && row.getAttribute ? row.getAttribute('data-g') : -1);
      if (i >= 0) playGroup(i);
    };

    /* 输入：只筛站内（零请求）；回车：跑全网并写入 URL（刷新/分享都能复用） */
    if (qEl) {
      qEl.value = q0;
      qEl.onkeydown = function (ev) {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        var v = String(qEl.value || '').trim();
        try { history.replaceState(null, '', '/search' + (v ? '?q=' + encodeURIComponent(v) : '')); } catch (e) { }
        srchLocal(v, grid, locSub);
        runExt(v);
        runPan(v);
        runRules(v);
      };
      qEl.oninput = function () {
        var v = String(qEl.value || '').trim();
        clearTimeout(qEl.__t);
        qEl.__t = setTimeout(function () { srchLocal(v, grid, locSub); }, 220);
      };
    }

    /* 首屏：URL 带 q 直接跑 */
    srchLocal(q0, grid, locSub);
    if (q0) { runExt(q0); runPan(q0); runRules(q0); }
  }
