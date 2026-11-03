  /* ---------------- 番剧：全量目录 ---------------- */
  var BROWSE = { view: [], shown: 0, page: 120 };
  function renderBrowse(reset) {
    var grid = $('#grid');
    if (!grid) return;
    if (reset) { grid.innerHTML = ''; BROWSE.shown = 0; }
    var end = Math.min(BROWSE.shown + BROWSE.page, BROWSE.view.length);
    var html = '';
    for (var i = BROWSE.shown; i < end; i++) html += animeCard(BROWSE.view[i], { showYear: 1 });
    grid.insertAdjacentHTML('beforeend', html);
    BROWSE.shown = end;
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
    /* reset=true 时保留分页游标（repaint 用）；无参调用与 change 事件对象照旧回第一页。
       必须用 === true 判定：addEventListener('change', applyBrowse) 会把事件对象当 reset 传进来。 */
    renderBrowse(reset === true ? false : true);
  }
  /* 标签索引按需加载：tags.json 只在上万人点开「标签」筛选时才拉，
     8,851 条的 tag→id 映射有几百 KB，进站不背这个包袱。 */
  var TAGS = null;
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
    $('#morebtn').onclick = function () { renderBrowse(false); };
    ['#f-year', '#f-type', '#f-sort'].forEach(function (s) { $(s).addEventListener('change', applyBrowse); });
    mountTagFilter();
    applyBrowse();
  }
