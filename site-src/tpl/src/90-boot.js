  /* 当季标记：供 magnet-eps.js 判断「当前看的是不是当季番」。
     详情页打开时由 70-modal.js 的 openModal 按该条目的年 / 月重算并覆盖；
     这里只给默认值——没有条目上下文（如磁力独立页）时一律 false。 */
  window.__CUR_SEASON = false;

  /* 切清晰度只换海报地址，不重排列表：browse / movie 传 reset === true 保留分页游标，
     无参调用会退回第一页（用户已经滚到第 5 屏时切换会被弹回顶部）。 */
  function repaint() {
    if (PAGE === 'anime') applyBrowse(true);
    else if (PAGE === 'movie') refreshMovie(true);
    else if (PAGE === 'rank') renderRank();
    else if (PAGE === 'fav') renderFavPage();
    else renderHome();
  }

  function syncPsz(btn) {
    var hd = PSZ.mode === 'hd';
    btn.textContent = hd ? '高清' : '标准';
    btn.setAttribute('aria-pressed', hd ? 'false' : 'true');
  }

  function initPsz() {
    var btn = document.getElementById('psz');
    if (!btn) return;
    syncPsz(btn);
    btn.onclick = function () {
      PSZ.mode = PSZ.mode === 'hd' ? 'sd' : 'hd';
      try { localStorage.setItem('psz', PSZ.mode); } catch (e) { /* 忽略 */ }
      syncPsz(btn);
      if ($('#mask')) close();
      repaint();
    };
  }

  /* ---------------- 顶栏（HTML 壳里只有一个空 <header>，内容由这里生成） ----------------
     把导航/搜索/计数放进 JS，是为了让每页 HTML 控制在 1KB 以内。
     注意：必须在任何 $('#q') / $('#psz') 绑定之前调用。 */
  function bootHeader() {
    var P = PAGE;
    /* 首页 / 番剧 / 排行榜都搜番剧，电影页搜电影 */
    var ph = P === 'movie' ? '搜索电影…' : '搜索番剧…';
    var nav = [['./', 'home', '首页'], ['anime', 'anime', '番剧'], ['movie', 'movie', '电影'],
      ['rank', 'rank', '排行榜'], ['fav', 'fav', '追番']]
      .map(function (x) {
        return '<a href="' + x[0] + '"' + (P === x[1] ? ' class="is-on"' : '') + '>' + x[2] + '</a>';
      }).join('');
    var host = document.getElementById('topbar');
    if (!host) return;
    host.innerHTML = '<div class="wrap"><a class="brand" href="./"><i></i>番组<b>计划</b></a>'
      + '<nav class="mainnav">' + nav + '</nav><div class="head-spacer"></div>'
      + '<div class="searchbox"><input id="q" type="search" placeholder="' + ph + '" autocomplete="off"></div>'
      + '<button class="psz" id="psz" type="button" aria-pressed="false">高清</button>'
      + '<span class="cnt" id="cnt"></span>'
      + '<span class="build" id="build">' + (document.body.dataset.build || '') + '</span></div>';
  }

  function bootAnime() {
    return jd('anime.json').then(function (d) {
      ANI.poster = d.poster || ''; ANI.posterSd = d.posterSd || '';
      ANI.rows = d.rows || [];
      ANI.extra = d.extra || {}; ANI.year = d.year || new Date().getFullYear();
    });
  }

  document.addEventListener('click', function (e) {
    /* 豆瓣 / TMDB 卡片：就地开详情弹窗，不跳外站。必须 preventDefault，
       否则弹窗与 <a target="_blank"> 跳转会同时发生；⌘/Ctrl/中键 放行原行为。 */
    var mc = e.target.closest && e.target.closest('.mcard');
    if (mc) {
      if (e.metaKey || e.ctrlKey || e.button !== 0) return;
      e.preventDefault();
      openExtModal(mc.dataset.ext, Number(mc.dataset.i));
      return;
    }
    var c = e.target.closest && e.target.closest('.card');
    if (!c) return;
    openModal(Number(c.dataset.id));
  });
  $('#mask') && $('#mask').addEventListener('click', function (e) { if (e.target.id === 'mask') close(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

  bootHeader();
  /* 追番变更（70-modal.js 的 toggleFollow 之后派发）就在地重渲染追番页。
     搜索态下 #main 已被搜索结果覆盖、不含 .favpage，此时不重渲染，
     否则会把用户正在看的搜索结果冲掉。 */
  document.addEventListener('favchange', function () {
    if (PAGE === 'fav' && document.querySelector('.favpage')) renderFavPage();
  });
  bootAnime().then(function () {
    if (PAGE === 'anime') {
      $('#q').placeholder = '在 ' + ANI.rows.length + ' 部里搜…';
      initBrowse();
      var qt = 0;
      $('#q').addEventListener('input', function () {
        clearTimeout(qt);
        qt = setTimeout(applyBrowse, 220);
      });
    } else if (PAGE === 'movie') {
      initMovie();
    } else if (PAGE === 'rank') {
      renderRank();
      bindSearch(renderRank);
    } else if (PAGE === 'fav') {
      renderFavPage();
      bindSearch(renderFavPage);
    } else {
      renderHome();
      bindSearch(renderHome);
    }
    /* #psz 必须在数据就位之后再绑：它的 repaint 依赖 ANI.rows */
    initPsz();
  }).catch(function (e) {
    $('#main').innerHTML = '<div class="loading">数据加载失败：' + esc(e.message || e) + '</div>';
  });
