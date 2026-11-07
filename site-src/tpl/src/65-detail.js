  /* ---------------- 整页详情（detail.html） ----------------
     整页详情与弹窗共用同一个 #modal 外壳和内层类名：build_site.py 的 SHELL_INLINE 把
     #modal 直接放进 <main>，所以这里只负责「把内容画进 #modal」，不碰 #mask。
     结构契约（别的文件按这些取值，改之前先看调用方）：
       · #modal 的 id 必须保留 —— magnet-eps.js / 60-movie.js / 80-bili.js 都按它取；
       · #modal 里**第一个** .mbody[data-p="detail"] 是磁力行容器（magnet-eps.js 取首个并 append），
         所以 .dp-watch > .dp-eps 排在所有 .mbody 之前；
       · h3 的 textContent 必须恰好是片名：不放 titleHTML()、不套 <span>、不掺不可见字符，
         magnet-eps.js 拿它做身份校验；
       · .acts 里保留 #watch / #favbtn（磁力层的回退锚点、追番绑定都认这两个 id）。
     路由：/detail?id=<bgm id>。没有 id / 记录不存在 / 分片拉不到都落到空态。 */
  var DETAIL_GEN = 0;            // 每次 renderDetail 自增：异步结果只落最后一代

  /* 取当前条目的 id，三种入口都认：
       /detail?id=123          整页详情（主入口）
       /anime/123              老深链：_redirects 用 200 重写到这里，地址栏不变
       /detail/123             同上（预留给 path 形式的分享链接）
     顺序必须是 query 优先：用 200 重写时 pathname 与 query 可能同时存在，query 更明确。 */
  function detailId() {
    var m = /[?&]id=(\d+)/.exec(location.search || '');
    if (m) return Number(m[1]);
    m = /\/(?:anime|detail)\/(\d+)\/?$/.exec(location.pathname || '');
    return m ? Number(m[1]) : 0;
  }

  /* 详情分片：片号与 70-modal.js 的 openModal 一致（id % 64 → data/s<N>.json）。
     缓存直接复用 10-data.js 的 shardCache —— 整页与弹窗不会各拉一遍同一片；
     失败要从缓存里摘掉（留一个恒为 null 的 promise 就成了永久负缓存），下次进来还能重试。 */
  function detailShard(id) {
    var sfx = id % 64;
    var pr = shardCache[sfx];
    if (!pr) {
      pr = jd('s' + sfx + '.json').then(function (d) { return d; }, function () {
        delete shardCache[sfx];
        return null;
      });
      shardCache[sfx] = pr;
    }
    return pr;
  }

  /* 空态：一句话 + 回列表的出口；retry=true 时补「重试」。
     正文标题与 <title> 分开传：加载失败时正文要说清是失败，<title> 统一写「条目不存在」。
     这里刻意不出 .acts / h3 —— magnet-eps.js 的观察器只认这两个锚点，空态不该被它插进磁力行。 */
  function detailEmpty(head, sub, retry, docTitle) {
    var m = $('#modal');
    if (!m) return;
    document.title = (docTitle || head) + ' · 番组计划';
    m.innerHTML = '<nav class="dp-crumb"><a href="/anime">番剧</a><span>/</span><b>'
      + esc(head) + '</b></nav>'
      + '<section class="sect"><div class="sec-h"><h2>' + esc(head) + '</h2></div>'
      + '<p class="plot">' + esc(sub) + '</p>'
      + '<p><a class="btn pri" href="/anime">回番剧页</a>'
      + (retry ? ' <button class="btn" id="dpRetry" type="button">重试</button>' : '')
      + '</p></section>';
    var rb = m.querySelector('#dpRetry');
    if (rb) rb.onclick = function () { renderDetail(); };
  }

  /* 相关推荐：详情页不为「同标签」再拉一次 tags.json（几百 KB，只为一个侧栏不划算），
     改成 同年份+同类型 → 同年份 → 同类型且有评分 三级回退，从已有的 ANI.rows 里凑 6 条。
     数据全在手，不发新请求。 */
  function detailRelated(rec, id) {
    var y = String(rec.air || '').slice(0, 4);
    var t = rec.format || '';
    var out = [], seen = {};
    function add(r) {
      if (!r || r[0] === id || seen[r[0]]) return;
      seen[r[0]] = 1;
      out.push(r);
    }
    function fill(fn) {
      for (var i = 0; i < ANI.rows.length && out.length < 6; i++) {
        if (fn(ANI.rows[i])) add(ANI.rows[i]);
      }
    }
    fill(function (r) { return !!y && String(r[4] || '') === y && (!t || r[3] === t); });
    fill(function (r) { return !!y && String(r[4] || '') === y; });
    fill(function (r) { return !!t && r[3] === t && !!r[7]; });
    return out.slice(0, 6);
  }

  /* 豆瓣 / TMDB 条目（没有 bgm id）也走同款整页详情：/detail?ext=db&i=N。
     数据来自 movies.json（同一份 60-movie.js 用的），布局复用 .mhero/.dp-grid/.dp-side，
     视觉上与番剧详情完全一致；**不带** .mbody[data-p="detail"] 锚点 —— 磁力层按锚点 +
     h3 片名做匹配，外源条目没有 bgm 身份，掺进去只会错配。 */
  function extParams() {
    var m = /[?&]ext=(db|tm)(?:&|$)/.exec(location.search || '');
    if (!m) return null;
    var i = Number((/[?&]i=(\d+)/.exec(location.search || '') || [])[1] || 0);
    return { kind: m[1], i: i };
  }

  function renderExtDetail(ext) {
    var m = $('#modal');
    if (!m) return;
    var gen = ++DETAIL_GEN;
    m.setAttribute('data-bgm', '');
    /* 磁力层按 h3 片名做模糊匹配，外源条目没有 bgm 身份 —— 挂上去只会错配，
       打上标记让 magnet-eps 的观察器直接跳过本页。 */
    document.body.setAttribute('data-ext-detail', '1');
    m.innerHTML = '<div class="loading">详情加载中…</div>';
    jd('movies.json').then(function (d) {
      if (gen !== DETAIL_GEN) return;
      var list = (d && (ext.kind === 'tm' ? d.tmdb : d.douban)) || [];
      var x = list[ext.i];
      if (!x) { detailEmpty('条目不存在', '这条豆瓣 / TMDB 记录不在数据里。', false); return; }
      drawExtDetail(m, ext.kind, ext.i, x, list);
    }, function () {
      if (gen !== DETAIL_GEN) return;
      detailEmpty('详情加载失败', 'movies.json 没拉到，检查网络后重试。', true, '条目不存在');
    });
  }

  function drawExtDetail(m, kind, i, x, list) {
    var isTm = kind === 'tm';
    var title = x.n || x.title || ('#' + i);
    var orig = isTm ? (x.ot || '') : (x.sub || '');
    var rate = (x.r != null && x.r !== '') ? Number(x.r) : 0;
    var year = String(x.y || x.year || '');
    var srcName = isTm ? 'TMDB' : '豆瓣';
    var intro = String((isTm ? x.ov : x.intro) || '');
    var meta = [];
    if (year) meta.push(['年份', year]);
    if (orig && orig !== title) meta.push(['原名', orig]);
    if (x.sub) meta.push(['地区 / 类型', x.sub]);
    meta.push(['来源', srcName]);

    /* 相关推荐：同表内同年份优先，凑 6 条（mcard 卡片走全局委托 → 同款 ext 详情） */
    var rel = [];
    for (var k = 0; k < list.length && rel.length < 6; k++) {
      if (k === i) continue;
      if (year && String(list[k].y || '') === year) rel.push([list[k], k]);
    }
    for (var k2 = 0; k2 < list.length && rel.length < 6; k2++) {
      if (k2 === i) continue;
      var dup = rel.some(function (pair) { return pair[1] === k2; });
      if (!dup && (list[k2].r != null && list[k2].r !== '')) rel.push([list[k2], k2]);
    }
    var relHtml = rel.map(function (pair) { return mcard(pair[0], kind, pair[1]); }).join('');

    m.innerHTML = '<nav class="dp-crumb"><a href="/movie">电影</a><span>/</span><b>'
      + esc(title) + '</b></nav>'
      + '<section class="mhero">'
      +   '<div class="mposter">'
      +     (x.img ? '<img src="' + esc(x.img) + '" loading="lazy" decoding="async" alt="">'
                   : '<div class="ph">🎬</div>')
      +   '</div>'
      +   '<div class="mh-info">'
      +     '<h3>' + esc(title) + '</h3>'
      +     (orig && orig !== title ? '<div class="orig">' + esc(orig) + '</div>' : '')
      +     '<div class="mbadges">'
      +       (year ? '<span class="mbadge">' + esc(year) + '</span>' : '')
      +       '<span class="mbadge">' + esc(srcName) + '</span>'
      +     '</div>'
      +     '<div class="mrate-line">'
      +       (rate
                ? '<b class="score">' + rate.toFixed(1) + '</b>'
                  + '<span class="stars" style="--p:' + Math.round(rate * 10) + '"></span>'
                : '<b class="score dim">暂无评分</b>')
      +       '<span class="votes">' + esc(srcName) + ' 评分</span>'
      +     '</div>'
      +     '<div class="acts">'
      +       '<a class="btn pri" href="' + esc(x.u || x.url || '#') + '" target="_blank" rel="noopener">'
      +         esc(srcName) + ' 页面</a>'
      +       '<a class="btn" target="_blank" rel="noopener" href="https://search.bilibili.com/all?keyword='
      +         encodeURIComponent(title) + '">B 站搜索</a>'
      +     '</div>'
      +   '</div>'
      + '</section>'
      + '<div class="dp-grid">'
      +   '<div class="dp-main">'
      +     (x.tr
            ? '<section class="sect" id="dp-trailer"><div class="sec-h"><h2>预告</h2></div>'
              + '<div class="trailer-slot" id="dpTrailerSlot">'
              + '<button class="btn pri" id="dpTrailer" type="button">▶ 播放预告（YouTube）</button></div></section>'
            : '')
      +     '<div class="mbody" data-p="ext">'
      +       '<section class="sect" id="dp-plot"><div class="sec-h"><h2>简介</h2></div>'
      +         '<p class="plot">' + esc(intro || '暂无简介') + '</p></section>'
      +       '<section class="sect"><div class="sec-h"><h2>信息</h2></div>'
      +         '<dl class="infobox">'
      +           meta.map(function (kv) {
                        return '<dt>' + esc(kv[0]) + '</dt><dd>' + esc(kv[1]) + '</dd>';
                      }).join('')
      +         '</dl></section>'
      +     '</div>'
      +   '</div>'
      +   '<aside class="dp-side">'
      +     '<section class="sect"><div class="sec-h"><h2>相关推荐</h2></div>'
      +       (relHtml ? '<div class="grid mgrid dp-rel">' + relHtml + '</div>'
                     : '<p class="plot">暂无相关推荐</p>')
      +     '</section>'
      +     '<section class="sect"><div class="sec-h"><h2>数据来源</h2></div>'
      +       '<p class="dp-src">' + esc(srcName) + '</p></section>'
      +   '</aside>'
      + '</div>';
    document.title = title + ' · 番组计划';
    /* 预告：与番剧详情同一套「点按钮才注 iframe」 */
    var trb = m.querySelector('#dpTrailer');
    if (trb && x.tr) {
      trb.onclick = function () {
        var slot = m.querySelector('#dpTrailerSlot');
        if (!slot || slot.querySelector('iframe')) return;
        slot.innerHTML = '<iframe src="https://www.youtube.com/embed/'
          + encodeURIComponent(x.tr) + '?autoplay=1&rel=0"'
          + ' allow="autoplay; encrypted-media; fullscreen" allowfullscreen'
          + ' style="width:100%;height:100%;border:0"></iframe>';
      };
    }
  }

  /* 90-boot.js 在 detail 分支调这个。分片只有 200–500ms，但慢网下不能白屏，
     先放一句加载中（#modal 的 id 与 .dp 类都不动），数据回来再整段重画。 */
  function renderDetail() {
    var m = $('#modal');
    if (!m) return;                            // 非 detail 页 / 壳缺失：不做任何事
    var gen = ++DETAIL_GEN;
    var ext = extParams();
    if (ext) { renderExtDetail(ext); return; } // 豆瓣 / TMDB：同款整页详情，不走 Bangumi 分片
    var id = detailId();
    m.setAttribute('data-bgm', '');             // 先清掉上一代的 id：磁力层按它做身份校验
    if (!id) { detailEmpty('条目不存在', '地址里没有 id 参数，回番剧页挑一部吧。', false); return; }
    m.innerHTML = '<div class="loading">详情加载中…</div>';
    detailShard(id).then(function (list) {
      if (gen !== DETAIL_GEN) return;          // 期间又重画过（重试 / 换清晰度）：这一代作废
      if (list === null) {
        detailEmpty('详情加载失败', '详情分片没拉到，检查网络后重试。', true, '条目不存在');
        return;
      }
      var rec = null;
      for (var i = 0; i < (list || []).length; i++) {
        if (list[i] && list[i].id === id) { rec = list[i]; break; }
      }
      if (!rec) { detailEmpty('条目不存在', '这条记录不在详情分片里（可能已下架）。', false); return; }
      drawDetail(m, id, rec);
    });
  }

  function drawDetail(m, id, rec) {
    /* 列表行只用来拿「站点标题」和 API 补充（封面回退 / 预告）：两者缺一都能退化，
       真正的详情字段一律以分片里的 rec 为准。 */
    var row = null;
    for (var i = 0; i < ANI.rows.length; i++) { if (ANI.rows[i][0] === id) { row = ANI.rows[i]; break; } }
    var ex = ANI.extra[id] || [];
    var title = (row && (row[2] || row[1])) || rec.name_cn || rec.name || ('#' + id);
    var orig = (row && row[1]) || rec.name || '';
    var air = String(rec.air || '');            // 分片里是完整日期（2006-09-01），列表行只有年份
    var year = (row && row[4]) || Number(air.slice(0, 4)) || 0;
    var month = (row && row[5]) || Number(air.slice(5, 7)) || 0;
    var type = (row && row[3]) || rec.format || '';
    var epsN = (row && row[8]) || rec.episodes || 0;
    var rating = Number(rec.rating || (row && row[7]) || 0);
    var rank = Number(rec.rank || (row && row[12]) || 0);
    var votes = Number(rec.votes || 0);
    var co = rec.co && rec.co.length ? rec.co : [];
    /* 播放源面板要的「当前集」：有进度跟进度，否则第 1 集（与 75 开播时的选集口径一致） */
    var curEp = 1;
    var prog = progressOf(id);
    if (prog && Number(prog.ep) > 0) curEp = Math.floor(Number(prog.ep));

    /* 评分行：数值与星级宽度公式照 70-modal.js 的 #mvotes 那一套（--p 取 score*10），不自创 */
    var meta = [];
    if (votes) meta.push(votes + ' 人评分');
    if (rank) meta.push('排名 #' + rank);
    var collect = ['想看', '在看', '看过'].map(function (lb, k) {
      return '<span><b>' + (co[k] == null || co[k] === '' ? '—' : esc(String(co[k])))
        + '</b><i>' + lb + '</i></span>';
    }).join('');
    var info = [];
    if (air) info.push(['放送', air]);
    else if (year) info.push(['放送', year + ' 年']);
    if (epsN) info.push(['话数', epsN + ' 话']);
    if (type) info.push(['类型', TYPE[type] || type]);
    if (orig && orig !== title) info.push(['原名', orig]);
    info.push(['来源', 'Bangumi']);            // magnet-eps.js 的 episodeCount() 读这里的「话数」
    var infoRows = info.map(function (kv) {
      return '<dt>' + esc(kv[0]) + '</dt><dd>' + esc(kv[1]) + '</dd>';
    }).join('');
    var relHtml = detailRelated(rec, id).map(function (r) {
      return animeCard(r, { showYear: 1 });
    }).join('');

    m.innerHTML = '<nav class="dp-crumb"><a href="/anime">番剧</a><span>/</span><b>'
      + esc(title) + '</b></nav>'
      + '<section class="mhero">'
      +   '<img class="mposter" src="' + esc(posterSrc(id)) + '"' + posterFb(id, ex) + ' alt="">'
      +   '<div class="mh-info">'
      +     '<h3>' + esc(title) + '</h3>'
      +     (orig && orig !== title ? '<div class="orig">' + esc(orig) + '</div>' : '')
      +     '<div class="mbadges">'
      +       (year ? '<span class="mbadge">' + year + (month ? ' 年 ' + month + ' 月' : ' 年') + '</span>' : '')
      +       (type ? '<span class="mbadge">' + esc(TYPE[type] || type) + '</span>' : '')
      +       (epsN ? '<span class="mbadge">' + epsN + ' 话</span>' : '')
      +     '</div>'
      +     '<div class="mrate-line">'
      +       (rating
                ? '<b class="score">' + rating.toFixed(1) + '</b>'
                  + '<span class="stars" style="--p:'
                  + Math.max(0, Math.min(100, Math.round(rating * 10))) + '"></span>'
                : '<b class="score dim">暂无评分</b>')
      +       '<span class="votes">' + esc(meta.join(' · ')) + '</span>'
      +     '</div>'
      +     '<div class="mcollect">' + collect + '</div>'
      +     '<div class="acts">'
      /* gamer 作品页只留一个主按钮「開始觀看」+ 收藏；Bangumi 外链已按要求去掉 */
      +       '<button class="btn pri" id="watch" type="button">▶ 开始观看</button>'
      +       '<button class="btn" id="favbtn" type="button">☆ 追番</button>'
      +     '</div>'
      +   '</div>'
      + '</section>'
      + '<div class="dp-grid">'
      +   '<div class="dp-main">'
      /* 播放源聚合面板：必须在 .dp-watch / .trailer.qplayer 之外（76 的 renderLines
         在播放器 root 内查 .qp-line-list，放进去两边抢同一个选择器） */
      +     srcPanelHtml(id, title, curEp)
      +     '<div class="dp-watch">'
      /* 空态给封面 + 播放钮（gamer 的播放器未开始时就是一张封面），点「开始观看」后
         由 75/76 把这里整段换掉；--cover 只给 CSS 用，不参与逻辑 */
      +       '<div class="dp-player" id="dpPlayer" style="--cover:url(' + esc(posterHd(id)) + ')"></div>'
      /* 磁力锚点：必须是 #modal 里第一个 .mbody[data-p="detail"]（magnet-eps.js 取首个并 append） */
      +       '<div class="mbody dp-eps" data-p="detail"></div>'
      +     '</div>'
      /* 预告（YouTube 官方源，ex[2] 有才出）：点按钮才注 iframe，页面加载不带第三方 JS */
      +     (ex[2]
            ? '<section class="sect" id="dp-trailer"><div class="sec-h"><h2>预告</h2></div>'
              + '<div class="trailer-slot" id="dpTrailerSlot">'
              + '<button class="btn pri" id="dpTrailer" type="button">▶ 播放预告（YouTube）</button></div></section>'
            : '')
      +     '<nav class="mtabs dp-nav">'
      +       '<a class="mtab on" href="#dp-plot">简介</a>'
      +       '<a class="mtab" href="#dp-chars">角色</a>'
      +       '<a class="mtab" href="#dp-staff">制作</a>'
      +       '<a class="mtab" href="#dp-rt">评价</a>'
      +       '<a class="mtab" href="#dp-dm">弹幕</a>'
      +       '<a class="mtab" href="#dp-rp">评论</a>'
      +     '</nav>'
      +     '<div class="mbody" data-p="detail">'
      +       '<section class="sect" id="dp-plot"><div class="sec-h"><h2>简介</h2></div>'
      +         '<p class="plot" id="plot"></p></section>'
      +       '<section class="sect"><div class="sec-h"><h2>标签</h2></div>'
      +         '<div class="tagpills" id="tags"></div></section>'
      +       '<section class="sect" id="dp-chars"><div class="sec-h"><h2>角色</h2></div>'
      +         '<div class="chgrid"></div></section>'
      +       '<section class="sect" id="dp-staff"><div class="sec-h"><h2>制作人员</h2></div>'
      +         '<div class="staffgrid"></div></section>'
      +     '</div>'
      +     '<div class="mbody" data-p="rt" id="dp-rt"><section class="sect">'
      +       '<div class="sec-h"><h2>评分分布</h2></div><div id="prt"></div></section></div>'
      +     '<div class="mbody" data-p="dm" id="dp-dm"><div id="pdm"></div></div>'
      +     '<div class="mbody" data-p="rp" id="dp-rp"><div id="prp"></div></div>'
      +   '</div>'
      +   '<aside class="dp-side">'
      +     '<section class="sect"><div class="sec-h"><h2>信息</h2></div>'
      +       '<dl class="infobox">' + infoRows + '</dl></section>'
      +     '<section class="sect"><div class="sec-h"><h2>相关推荐</h2>'
      +       '<span class="sec-sub">同年份 · 同类型</span></div>'
      +       '<div class="grid dp-rel">' + relHtml + '</div></section>'
      +     '<section class="sect"><div class="sec-h"><h2>数据来源</h2></div>'
      +       '<p class="dp-src">Bangumi · AniList · B 站</p></section>'
      +   '</aside>'
      + '</div>';
    m.setAttribute('data-bgm', String(id));
    document.body.removeAttribute('data-ext-detail');   // 回到番剧详情：磁力层恢复挂载
    document.title = title + ' · 番组计划';
    /* 播放源面板：只探测不播放（3 个状态 GET 由 78 自己发；60s 内二次调用不重探）。
       放在整段 DOM 落地之后：面板要按 data-bgm 认自己这一代。 */
    srcPanelMount(m, id, title, curEp);

    /* 简介：与弹窗同一套处理 —— 原文分段残留的空行在 pre-wrap 下会撑出大块空白 */
    var plot = m.querySelector('#plot');
    if (plot) plot.textContent = String(rec.overview || '暂无简介').replace(/\n{3,}/g, '\n\n');
    renderTags(rec, m.querySelector('#tags'));
    /* 标签计数是另一份小表（tagcounts.json），晚到就只重画标签，与弹窗同一处理 */
    ensureTagCounts(function () { renderTags(rec, m.querySelector('#tags')); });

    /* 角色 / 制作人员：结构与 70-modal.js 一致（.chcard .ph .chin .chav / .staff）；
       没有数据就把整节收起来 —— 只留一个空标题比没有更难看。 */
    var chgrid = m.querySelector('.chgrid');
    if (chgrid && rec.ch && rec.ch.length) {
      chgrid.innerHTML = rec.ch.map(function (c) {
        var av = avatarSrc(c[2]);
        return '<div class="chcard"><span class="ph">'
          + '<span class="chin">' + esc(Array.from(String(c[0] == null ? '' : c[0]))[0] || '?') + '</span>'
          + (av ? '<img class="chav" src="' + esc(av) + '" alt="" referrerpolicy="no-referrer"'
              + ' loading="lazy" decoding="async" onerror="this.remove()">' : '')
          + '</span><div class="chinfo"><b>' + esc(c[0]) + '</b><em>' + esc(c[1]) + '</em></div></div>';
      }).join('');
    } else {
      var sChars = m.querySelector('#dp-chars');
      if (sChars) sChars.hidden = true;
    }
    var staffgrid = m.querySelector('.staffgrid');
    if (staffgrid && rec.st && rec.st.length) {
      staffgrid.innerHTML = rec.st.map(function (p) {
        return '<div class="staff"><b>' + esc(p[0]) + '</b>'
          + (p[1] ? '<em>' + esc(p[1]) + '</em>' : '') + '</div>';
      }).join('');
    } else {
      var sStaff = m.querySelector('#dp-staff');
      if (sStaff) sStaff.hidden = true;
    }

    /* 评分分布：10 根柱子、高度按各档人数归一 —— 与 70-modal.js 的 #prt 同一算法，
       改公式要两边一起改。 */
    var prt = m.querySelector('#prt');
    if (prt) {
      if (rec.rc && rec.rc.length === 10) {
        var mx = Math.max.apply(null, rec.rc);
        var sum = rec.rc.reduce(function (a, b) { return a + b; }, 0);
        var bars = rec.rc.map(function (n, k) {
          var bh = mx ? Math.max(2, Math.round((n / mx) * 100)) : 2;
          return '<i style="height:' + bh + '%" title="' + (k + 1) + ' 分 · ' + n + ' 人">'
            + '<b>' + (k + 1) + '</b></i>';
        }).join('');
        prt.innerHTML = '<div class="rdist" id="rdist"><div class="rdhead">星级分布合计 <b>'
          + sum + '</b> 人'
          + (rank ? ' · 排名 <b>#' + rank + '</b>' : '')
          + (votes ? ' · Bangumi 共 ' + votes + ' 人评分' : '') + '</div>' + bars + '</div>';
      } else {
        prt.innerHTML = '<p class="plot">暂无评分分布</p>';
      }
    }

    /* 播放：与弹窗同一入口（75-quarkplay.js 的 openQuarkPlay(m, id, title)）。
       m 是挂载容器（76-qplayer.js 把 .trailer.qplayer append 到它上面）：整页详情传 16:9 的
       #dpPlayer 槽，播放器才落在框里；槽缺失（壳被换过）才回退到 #modal。
       没有可用播放源时它自己会写状态，这里不预先判。 */
    var wb = m.querySelector('#watch');
    if (wb) wb.onclick = function () {
      /* 播放顺序（2026-11-07）：YouTube 官方正片 → 夸克转存（幕后，不在面板列出） */
      if (window.__srcStart && window.__srcStart(m, id, title, curEp)) return;
      openQuarkPlay(m.querySelector('#dpPlayer') || m, id, title);
    };

    /* 追番：复用卡片星标 / 弹窗同一套存储（key 用条目 id） */
    var fb = m.querySelector('#favbtn');
    if (fb) {
      var fk = String(id);
      fb.textContent = isFollowed(fk) ? '★ 已追' : '☆ 追番';
      fb.classList.toggle('on', isFollowed(fk));
      fb.onclick = function () {
        var now = toggleFollow(fk);
        fb.textContent = now ? '★ 已追' : '☆ 追番';
        fb.classList.toggle('on', now);
      };
    }

    /* 播放器槽的空态就是封面 + 播放钮（gamer 同款），点它等同点「开始观看」。
       开播后 76 会把内容塞进来，这时再有点击就不该重开 —— 用「槽里有没有子节点」判。 */
    var dpslot = m.querySelector('#dpPlayer');
    if (dpslot) {
      dpslot.onclick = function () {
        if (dpslot.childNodes.length) return;
        openQuarkPlay(dpslot, id, title);
      };
    }

    /* 预告：点按钮才注入 YouTube iframe（页面本身不加载任何第三方脚本） */
    var trb = m.querySelector('#dpTrailer');
    if (trb && ex[2]) {
      trb.onclick = function () {
        var slot = m.querySelector('#dpTrailerSlot');
        if (!slot || slot.querySelector('iframe')) return;
        slot.innerHTML = '<iframe src="https://www.youtube.com/embed/'
          + encodeURIComponent(ex[2]) + '?autoplay=1&rel=0"'
          + ' allow="autoplay; encrypted-media; fullscreen" allowfullscreen'
          + ' style="width:100%;height:100%;border:0"></iframe>';
      };
    }

    /* 区块导航：整页滚动到锚点并切 .on。桌面 .dp-nav 吸顶在顶栏下面，会让开两段高度，
       否则目标标题正好被盖住；≤760 .dp-nav 是 static，只让开顶栏。 */
    var nav = m.querySelector('.dp-nav');
    if (nav) {
      nav.onclick = function (ev) {
        var a = ev.target;
        while (a && a !== nav && !(a.tagName === 'A' && String(a.getAttribute('href') || '').charAt(0) === '#')) {
          a = a.parentNode;
        }
        if (!a || a === nav) return;
        var aid = String(a.getAttribute('href')).slice(1);
        var target = document.getElementById(aid);
        if (!target) return;                    // 该节没有内容（角色/制作被收起）就不动
        ev.preventDefault();
        nav.querySelectorAll('.mtab').forEach(function (x) { x.classList.toggle('on', x === a); });
        var off = 0;
        var head = document.querySelector('header.site-head');
        if (head && head.getBoundingClientRect) off += head.getBoundingClientRect().height || 0;
        if (nav.getBoundingClientRect && (window.innerWidth || 0) > 760) {
          off += nav.getBoundingClientRect().height || 0;
        }
        var y = target.getBoundingClientRect
          ? target.getBoundingClientRect().top + (window.pageYOffset || 0) - off - 8
          : 0;
        if (window.scrollTo) {
          try { window.scrollTo({ top: y, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, y); }
        }
        try { history.replaceState(null, '', '#' + aid); } catch (e) { /* 隐私模式忽略 */ }
      };
    }

    /* 相关推荐卡片：页面本身就是详情，再开弹窗没有意义 —— 直接换页。
       （90-boot.js 的卡片委托在 detail 页已显式忽略，不会两套动作同时发生。） */
    var rel = m.querySelector('.dp-rel');
    if (rel) {
      rel.onclick = function (ev) {
        var c = ev.target;
        while (c && c !== rel && !(c.className && /(^|\s)card(\s|$)/.test(c.className))) c = c.parentNode;
        if (!c || c === rel) return;
        var rid = c.getAttribute('data-id');
        if (!rid) return;
        ev.preventDefault();
        location.href = '/detail?id=' + rid;
      };
    }

    /* 弹幕 / 评论：80-bili.js 在 detail 页只挂「进入视口才取」的懒加载，不绑 tab 切换 */
    bindBili(id, title, (row && row[4]) || '');
  }
