  /* ---------------- 番剧：全量目录 ---------------- */
  var BROWSE = { view: [], shown: 0, page: 120 };
  /* mode: 'reset' 清空回第一页 | 'more' 追加一页 | 'repaint' 按已显示条数重画（换清晰度等原地刷新） */
  function renderBrowse(mode) {
    var grid = $('#grid');
    if (!grid) return;
    var want;
    if (mode === 'more') {
      want = Math.min(BROWSE.shown + BROWSE.page, BROWSE.view.length);
    } else {
      want = mode === 'repaint'
        ? Math.min(Math.max(BROWSE.shown, BROWSE.page), BROWSE.view.length)
        : Math.min(BROWSE.page, BROWSE.view.length);
      grid.innerHTML = '';
      BROWSE.shown = 0;
    }
    var html = '';
    for (var i = BROWSE.shown; i < want; i++) html += animeCard(BROWSE.view[i], { showYear: 1 });
    /* 空结果不再白屏：给一句可执行的提示 */
    if (!BROWSE.view.length) html = '<div class="empty">这个组合没有作品 —— 换个年份/类型，或点「全部」再试</div>';
    grid.insertAdjacentHTML('beforeend', html);
    BROWSE.shown = want;
    var left = BROWSE.view.length - BROWSE.shown;
    $('#morewrap').hidden = left <= 0;
    if (left > 0) $('#morebtn').textContent = '加载更多 · 还剩 ' + left + ' 部';
    $('#hint').textContent = '筛出 ' + BROWSE.view.length + ' 部，已显示 ' + BROWSE.shown;
  }
  function applyBrowse(reset) {
    var q = nrm(($('#q').value || '').trim());
    var y = ($('#f-year') || {}).value || '';
    var t = ($('#f-type') || {}).value || '';
    var sort = ($('#f-sort') || {}).value || 'year';
    var tg = ($('#f-tag') || {}).value || '';
    var tgSet = null;
    if (tg && TAGS && TAGS[tg]) {
      tgSet = {};
      TAGS[tg].forEach(function (id) { tgSet[id] = 1; });
    }
    BROWSE.view = ANI.rows.filter(function (r) {
      if (tgSet && !tgSet[r[0]]) return false;
      // 有搜索词时不套年份筛选，否则搜老番会被默认年份挡成 0 结果
      if (!q && y && String(r[4] || '') !== y) return false;
      if (t && r[3] !== t) return false;
      if (q && !hit(r[1] + ' ' + (r[2] || ''), q)) return false;
      return true;
    });
    if (sort === 'rating') BROWSE.view.sort(function (a, b) { return (b[7] || 0) - (a[7] || 0); });
    else if (sort === 'rank') BROWSE.view.sort(function (a, b) {
      var ra = a[12] || 0, rb = b[12] || 0;
      if (ra && rb) return ra - rb;
      if (ra) return -1;
      if (rb) return 1;
      return (b[7] || 0) - (a[7] || 0);
    });
    else if (sort === 'name') BROWSE.view.sort(function (a, b) { return String(a[2] || a[1]).localeCompare(String(b[2] || b[1]), 'zh'); });
    else BROWSE.view.sort(function (a, b) { return (b[4] || 0) - (a[4] || 0) || (b[7] || 0) - (a[7] || 0); });
    /* reset===true 表示「原地重画、保留已显示条数」（换清晰度走这条路）；
       无参调用与 change 事件对象照旧清空回第一页 —— 必须用 === true 判定，
       因为 addEventListener('change', applyBrowse) 会把事件对象当 reset 传进来。 */
    renderBrowse(reset === true ? 'repaint' : 'reset');

    /* 选中态：生效中的筛选高亮，默认排序不高亮 */
    [['#f-year', y], ['#f-type', t], ['#f-tag', tg]].forEach(function (p) {
      var el = $(p[0]);
      if (!el) return;
      var lb = el.closest('.f-label');
      if (lb) lb.classList.toggle('on', !!p[1]);
    });
    var so = $('#f-sort');
    if (so) {
      var sl = so.closest('.f-label');
      if (sl) sl.classList.toggle('on', sort !== 'year');
    }
    /* 有搜索词时年份不生效（见上面的过滤条件）——用视觉灰化说明，别让下拉看起来还在生效 */
    var yl = $('#f-year');
    if (yl) {
      var ylb = yl.closest('.f-label');
      if (ylb) ylb.classList.toggle('off', !!(q && y));
    }
  }
  /* 标签索引：进入浏览页就会拉一次（体积大，见 tags.json），拿到后重填下拉。
     8,851 条的 tag→id 映射有几百 KB，进站不背这个包袱。 */
  var TAGS = null;
  /* 深链：/anime.html?tag=xxx 直接把标签筛选选中（标签下拉是异步填的，所以要在填完之后再应用） */
  function pickTagFromUrl() {
    try { return new URLSearchParams(location.search).get('tag') || ''; } catch (e) { return ''; }
  }
  function ensureTags() {
    if (TAGS) return Promise.resolve(TAGS);
    return jd('tags.json').then(function (d) {
      TAGS = d || {};
      return TAGS;
    }, function () { TAGS = {}; return TAGS; });
  }
  function mountTagFilter() {
    var sel = $('#f-tag');
    if (!sel) return;
    sel.onchange = function () {
      /* 手选标签时清空年份：默认年份会再叠一层过滤，容易筛成 0 部。
         复用这一个 change 处理器，不再额外 addEventListener（否则一次改选重绘两次）。 */
      var y = $('#f-year'); if (y) y.value = '';
      if (!TAGS) {
        ensureTags().then(function () { applyBrowse(); });
        return;
      }
      applyBrowse();
    };
    if (sel.getAttribute('data-ready')) return;
    sel.setAttribute('data-ready', '1');
    ensureTags().then(function (t) {
      var names = Object.keys(t).sort(function (a, b) { return t[b].length - t[a].length; });
      sel.innerHTML = '<option value="">全部</option>'
        + names.map(function (n) {
          return '<option value="' + esc(n) + '">' + esc(n) + '（' + t[n].length + '）</option>';
        }).join('');
      /* 选项到齐后再认 ?tag=（早于这里没有 option 可选中）；键不存在就忽略，不报错 */
      var want = pickTagFromUrl();
      if (want && TAGS && TAGS[want]) {
        sel.value = want;
        /* 标签深链跨年份：默认年份会再叠一层过滤，这里清空 */
        var y = $('#f-year'); if (y) y.value = '';
        applyBrowse();
      }
    });
  }

  function initBrowse() {
    var years = {};
    ANI.rows.forEach(function (r) { if (r[4]) years[r[4]] = (years[r[4]] || 0) + 1; });
    var ys = Object.keys(years).map(Number).sort(function (a, b) { return b - a; });
    $('#main').innerHTML = '<div class="filters">'
      + '<label class="f-label">年份 <select id="f-year"><option value="">全部</option>'
      + ys.map(function (v) { return '<option value="' + v + '">' + v + '（' + years[v] + '）</option>'; }).join('')
      + '</select></label>'
      + '<label class="f-label">类型 <select id="f-type"><option value="">全部</option>'
      + '<option value="tv">TV</option><option value="movie">剧场版</option>'
      + '<option value="ova">OVA</option><option value="web">网络</option></select></label>'
      + '<label class="f-label">排序 <select id="f-sort">'
      + '<option value="year">年份（新→旧）</option><option value="rating">评分（高→低）</option>'
      + '<option value="rank">排名（前→后）</option>'
      + '<option value="name">标题</option></select></label>'
      + '<label class="f-label">标签 <select id="f-tag"><option value="">全部</option></select></label>'
      + '<span class="f-hint" id="hint"></span></div>'
      + '<div class="grid" id="grid"></div>'
      + '<div class="morewrap" id="morewrap" hidden><button class="morebtn" id="morebtn" type="button"></button></div>';
    $('#f-year').value = ys[0] ? String(ys[0]) : '';
    $('#morebtn').onclick = function () { renderBrowse('more'); };
    ['#f-year', '#f-type', '#f-sort'].forEach(function (s) { $(s).addEventListener('change', applyBrowse); });
    mountTagFilter();
    /* 首屏：标签索引若已在手就先选中再筛；还没加载时上面 mountTagFilter 会在拉完后补一次 */
    var deepTag = pickTagFromUrl();
    if (deepTag && TAGS && TAGS[deepTag]) { $('#f-tag').value = deepTag; $('#f-year').value = ''; }
    applyBrowse();
  }
