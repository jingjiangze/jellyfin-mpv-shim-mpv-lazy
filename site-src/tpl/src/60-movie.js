  /* ---------------- 电影：豆瓣新片 / TMDB 热门 / 剧场版全收录 ---------------- */
  var MOVIE = { all: [], view: [], shown: 0, page: 120, db: [], tm: [] };

  /* 豆瓣 / TMDB 卡片刻意用 .mcard（不是 .card）：两种卡走两条弹窗路径 —
     .card 进 Bangumi 弹窗，.mcard 由 openExtModal 就地展开详情，不直接跳外站。 */
  /* 字段取自 data/movies.json 的契约：douban {n,u,img,r,k,id,intro,sub}、
     tmdb {n,u,img,r,y,id,ov,ot}（豆瓣条目没有 y，intro/ov 可能为空串）。
     兼容 title/url/rating/year 旧写法，免得数据换名就整片空白。
     data-ext / data-i 供全局委托定位到 MOVIE.db / MOVIE.tm 的下标；
     不能挂内联 onclick —— paintMovieDb() 每次整块重写 innerHTML，内联绑定会丢。 */

  /* 豆瓣 / TMDB 条目详情弹窗：在本站看剧情简介，想跳外站点里面的按钮。
     复用 #mask / #modal 外壳与既有的 close()、mask 点击、Esc 关闭。
     结构契约同 openModal：h3 与 .acts 必须保留（magnet-eps.js 靠 h3 取片名、
     靠 .acts 定位插入点），本函数不走 Bangumi 那套分片 / 评分分布逻辑。 */
  function openExtModal(kind, i) {
    var list = kind === 'tm' ? MOVIE.tm : MOVIE.db;
    var x = list && list[i];
    if (!x) return;
    var m = $('#modal');
    if (!m) return;
    var isTm = kind === 'tm';
    var title = x.n || x.title || '';
    var orig = isTm ? (x.ot || '') : (x.sub || '');
    var rate = (x.r != null && x.r !== '') ? x.r : x.rating;
    var year = x.y || x.year || '';
    var src = isTm ? 'TMDB' : '豆瓣';
    var intro = isTm ? x.ov : x.intro;
    var sub2 = x.sub || '';
    m.innerHTML = '<span class="x" aria-label="关闭">×</span>'
      + '<div class="mhd">'
      +   '<div class="mposter">'
      +     (x.img ? '<img src="' + esc(x.img) + '" loading="lazy" decoding="async" alt="">'
                   : '<div class="ph">🎬</div>')
      +   '</div>'
      +   '<div class="mb">'
      +     '<h3>' + esc(title) + '</h3>'
      +     (orig ? '<div class="orig">' + esc(orig) + '</div>' : '')
      +     '<div class="mrate">'
      +       (rate ? '<b class="num">★ ' + Number(rate).toFixed(1) + '</b>' : '<b class="num dim">暂无评分</b>')
      +       '<span class="mvotes">' + esc([year, src].filter(Boolean).join(' · ')) + '</span>'
      +     '</div>'
      +     '<dl class="infobox">'
      +       (year ? '<dt>年份</dt><dd>' + esc(year) + '</dd>' : '')
      +       (sub2 ? '<dt>地区 / 类型</dt><dd>' + esc(sub2) + '</dd>' : '')
      +       '<dt>来源</dt><dd>' + esc(src) + '</dd>'
      +     '</dl>'
      +   '</div>'
      + '</div>'
      + '<div class="mbody"><h4>简介</h4><p class="plot">'
      +   (intro ? esc(intro) : '暂无简介') + '</p></div>'
      + '<div class="acts">'
      +   '<a class="btn pri" href="' + esc(x.u || x.url || '#') + '" target="_blank" rel="noopener">'
      +     esc(src) + ' 页面</a>'
      +   '<a class="btn" target="_blank" rel="noopener" href="https://search.bilibili.com/all?keyword='
      +     encodeURIComponent(title) + '">B 站搜索</a>'
      + '</div>';
    $('#mask').classList.add('on');
    m.querySelector('.x').onclick = close;
  }

  function paintMovieDb() {
    var box = $('#mdb');
    if (!box) return;
    box.innerHTML = msec('豆瓣新片', MOVIE.db, 'db') + msec('TMDB 热门', MOVIE.tm, 'tm');
  }

  function renderMovie(reset) {
    var grid = $('#mgrid');
    if (!grid) return;
    if (reset) { grid.innerHTML = ''; MOVIE.shown = 0; }
    var end = Math.min(MOVIE.shown + MOVIE.page, MOVIE.view.length);
    var html = '';
    for (var i = MOVIE.shown; i < end; i++) html += animeCard(MOVIE.view[i], { showYear: 1 });
    grid.insertAdjacentHTML('beforeend', html);
    MOVIE.shown = end;
    var left = MOVIE.view.length - MOVIE.shown;
    var wrap = $('#mmorewrap');
    if (wrap) wrap.hidden = left <= 0;
    var btn = $('#mmore');
    if (btn) {
      btn.hidden = left <= 0;
      if (left > 0) btn.textContent = '加载更多 · 还剩 ' + left + ' 部';
    }
    var hint = $('#mhint');
    if (hint) hint.textContent = '筛出 ' + MOVIE.view.length + ' 部，已显示 ' + MOVIE.shown;
  }

  function applyMovie(reset) {
    var q = nrm((($('#q') || {}).value || '').trim());
    var y = ($('#m-year') || {}).value || '';
    var sort = ($('#m-sort') || {}).value || 'year';
    MOVIE.view = MOVIE.all.filter(function (r) {
      /* 和番剧页一致：有搜索词时不套年份筛选，否则搜老片会被年份挡成 0 结果 */
      if (!q && y && String(r[4] || '') !== y) return false;
      if (q && !hit(r[1] + ' ' + (r[2] || ''), q)) return false;
      return true;
    });
    if (sort === 'rating') MOVIE.view.sort(function (a, b) { return (b[7] || 0) - (a[7] || 0); });
    else if (sort === 'name') MOVIE.view.sort(function (a, b) { return String(a[2] || a[1]).localeCompare(String(b[2] || b[1]), 'zh'); });
    else MOVIE.view.sort(function (a, b) { return (b[4] || 0) - (a[4] || 0) || (b[7] || 0) - (a[7] || 0); });
    /* reset=true 时保留分页游标（repaint 用）；无参调用与 change 事件对象照旧回第一页。
       必须用 === true 判定：addEventListener('change', applyMovie) 会把事件对象当 reset 传进来。 */
    renderMovie(reset === true ? false : true);
  }

  function initMovie() {
    MOVIE.all = ANI.rows.filter(function (r) { return r[3] === 'movie'; });
    var years = {};
    MOVIE.all.forEach(function (r) { if (r[4]) years[r[4]] = (years[r[4]] || 0) + 1; });
    var ys = Object.keys(years).map(Number).sort(function (a, b) { return b - a; });
    $('#main').innerHTML = '<div id="mdb"></div>'
      + '<section class="block"><div class="bhead"><h2>剧场版 / 电影全收录</h2>'
      + '<span class="f-hint" id="mhint"></span></div>'
      + '<div class="filters">'
      + '<label class="f-label">年份 <select id="m-year"><option value="">全部</option>'
      + ys.map(function (v) { return '<option value="' + v + '">' + v + '（' + years[v] + '）</option>'; }).join('')
      + '</select></label>'
      + '<label class="f-label">排序 <select id="m-sort">'
      + '<option value="year">年份（新→旧）</option><option value="rating">评分（高→低）</option>'
      + '<option value="name">标题</option></select></label></div>'
      + '<div class="grid" id="mgrid"></div>'
      + '<div class="morewrap" id="mmorewrap" hidden><button class="morebtn" id="mmore" type="button"></button></div>'
      + '</section>';
    var more = $('#mmore');
    if (more) more.onclick = function () { renderMovie(false); };
    ['#m-year', '#m-sort'].forEach(function (s) { if ($(s)) $(s).addEventListener('change', applyMovie); });
    var q = $('#q');
    if (q) {
      q.placeholder = '在 ' + MOVIE.all.length + ' 部剧场版里搜…';
      var qt = 0;
      q.addEventListener('input', function () {
        clearTimeout(qt);
        qt = setTimeout(applyMovie, 220);
      });
    }
    applyMovie();
    jd('movies.json').then(function (d) {
      MOVIE.db = (d && d.douban) || [];
      MOVIE.tm = (d && d.tmdb) || [];
      paintMovieDb();
    }).catch(function () {
      var box = $('#mdb');
      if (box) box.innerHTML = '<div class="empty">电影数据加载失败（豆瓣 / TMDB 简介暂不可用），请刷新重试</div>';
    });
  }

  /* 只重画，不重建 DOM：清晰度切换时保留当前筛选与搜索词（状态都在 select / input 上） */
  /* reset=true 时保留分页游标：切清晰度不该把用户翻到的位置清掉（repaint 传 true）。 */
  function refreshMovie(reset) {
    if (!$('#mgrid')) return;
    paintMovieDb();
    applyMovie(reset === true);
  }
