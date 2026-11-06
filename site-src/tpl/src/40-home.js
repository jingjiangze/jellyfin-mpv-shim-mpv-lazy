/* ---------------- 首页：年 → 季度 → 周几（三级下钻） ---------------- */
var HOME = { y: 0, q: 0, wd: 0 };
var QS = [1, 2, 3, 4];

function seasonOf(m) { return m ? Math.ceil(m / 3) : 0; }

function yearRows(y) { return ANI.rows.filter(function (r) { return r[4] === y; }); }

function homeRows() {
  return yearRows(HOME.y).filter(function (r) {
    if (HOME.q && seasonOf(r[5]) !== HOME.q) return false;
    if (HOME.wd && r[6] !== HOME.wd) return false;
    return true;
  }).sort(function (a, b) { return (b[7] || 0) - (a[7] || 0); });
}

/* 左侧（竖屏顶部）选择面板 */
function renderLevels() {
  var qs = {};
  yearRows(HOME.y).forEach(function (r) {
    var q = seasonOf(r[5]);
    if (q) qs[q] = (qs[q] || 0) + 1;
  });
  var qlist = Object.keys(qs).map(Number).sort();

  /* 首页只留「季度 + 星期」：年份固定为当前年（顶栏计数里已标明是哪一年），
     少一层选择，季度一眼可选。要看往年去「番剧」页筛。 */
  var h = '<aside class="levels">';
  h += '<div class="lv"><div class="lv-h">季度</div><div class="chips chips--col">'
    + chip('全部', !HOME.q, 'data-q', 0)
    + qlist.map(function (q) {
      return chip('第' + q + '季度<span class="lv-n">' + qs[q] + '</span>', q === HOME.q, 'data-q', q);
    }).join('')
    + '</div></div>';

  h += '<div class="lv"><div class="lv-h">星期</div><div class="chips chips--wd">'
    + chip('全部', !HOME.wd, 'data-wd', 0)
    + WD.map(function (d, i) { return chip(d, HOME.wd === i + 1, 'data-wd', i + 1); }).join('')
    + '</div></div>';

  return h + '</aside>';
}

/* 排行块默认不渲染：先放空壳，滚到附近才排序 + 填卡。
   三块排行要各排一遍 8,851 条再渲染 48 张卡，进站白算很不值。 */
function rankBlock(id, title, sub, extra) {
  return '<section class="block rank-block" data-rank="' + id + '">'
    + '<div class="bhead"><h2>' + title + '</h2><span>' + (extra || sub) + '</span></div>'
    + '<div class="grid" id="' + id + '"></div></section>';
}

function rankSort(a, b) {
  var ra = a[12] || 0, rb = b[12] || 0;
  if (ra && rb) return ra - rb;
  if (ra) return -1;
  if (rb) return 1;
  return (b[7] || 0) - (a[7] || 0);
}

function rankPool(id) {
  if (id === 'rank-q') {
    return yearRows(HOME.y).filter(function (r) {
      return (!HOME.q || seasonOf(r[5]) === HOME.q) && (r[12] || r[7]);
    }).sort(rankSort).slice(0, 12);
  }
  if (id === 'rank-movie') {
    return ANI.rows.filter(function (r) { return r[3] === 'movie' && (r[12] || r[7]); })
      .sort(rankSort).slice(0, 12);
  }
  return ANI.rows.filter(function (r) { return r[12] || r[7]; }).sort(rankSort).slice(0, 24);
}

function mountRanks() {
  var blocks = [].slice.call(document.querySelectorAll('.rank-block'));
  if (!blocks.length) return;
  var done = {};
  function fill(el) {
    var id = el.getAttribute('data-rank');
    if (done[id]) return;
    done[id] = 1;
    var box = el.querySelector('.grid');
    var rows = rankPool(id);
    if (box) box.innerHTML = rows.map(function (r) { return animeCard(r, { showYear: 1 }); }).join('');
  }
  if (!window.IntersectionObserver) { blocks.forEach(fill); return; }
  var io = new IntersectionObserver(function (es) {
    es.forEach(function (e) {
      if (!e.isIntersecting) return;
      fill(e.target);
      io.unobserve(e.target);
    });
  }, { rootMargin: '300px' });
  blocks.forEach(function (b) { io.observe(b); });
}

/* 首页推荐位：1 大 + 4 小（不做 banner 轮播——素材里有 banner 的只有 0.6%）。
   全部取自当前筛选结果 rows，不发新请求；少于 2 条时整块不渲染，避免一张大卡 + 空洞侧栏。 */
function heroBlock(rows) {
  if (!rows || rows.length < 2) return '';

  /* 主位：评分最高（rows 来自 homeRows()，已限当年）；全无评分则退回第一条 */
  var best = null;
  rows.forEach(function (r) {
    if (r[7] && (!best || r[7] > best[7])) best = r;
  });
  if (!best) best = rows[0];

  /* 副位：跳过主位，按评分降序取 4 条 */
  var side = rows.filter(function (r) { return r !== best; })
    .sort(function (a, b) { return (b[7] || 0) - (a[7] || 0); })
    .slice(0, 4);

  var id = best[0];
  /* 海报地址与常态卡同一套（sd 档 + alCover 兜底），取法见 30-view.js 的 animeCard */
  var alCover = (ANI.extra[id] || [])[1] || '';
  var fb = PSZ.mode === 'sd' ? [alCover, ANI.poster + id + '.jpg'] : [alCover];
  var sub = [best[4] || '', TYPE[best[3]] || best[3] || '',
    best[7] ? '★' + Number(best[7]).toFixed(1) : ''].filter(Boolean).join(' · ');

  return '<section class="hero" aria-label="本季推荐">'
    + '<a class="card hero-main" data-id="' + id + '"><div class="pw">'
    + '<img src="' + esc(posterSrc(id)) + '"' + fbAttr(fb) + ' loading="eager" decoding="async" alt="">'
    + '</div><div class="hero-txt"><h2 class="t">' + titleHTML(best[2] || best[1]) + '</h2>'
    + '<p class="sub2">' + esc(sub) + '</p></div></a>'
    + '<div class="hero-side">'
    + side.map(function (r) { return animeCard(r, { showYear: 1 }); }).join('')
    + '</div></section>';
}

/* 全站高分：给「本季高分」用。无评分（r[7] 空 / 0）的条目跳过。
   filter 已产出新数组，这里的 sort 不会动 ANI.rows。 */
function topRows(n) {
  return ANI.rows.filter(function (r) { return r[7]; })
    .sort(function (a, b) { return b[7] - a[7]; })
    .slice(0, n || 8);
}

/* 首页区块：标题 + 计数（+ 可选的「更多」链接）+ 卡片网格。
   list 为空时整块返回空串，由调用方决定是否补空态。 */
function block(title, list, moreHtml, gridClass) {
  if (!list || !list.length) return '';
  return '<section class="block"><div class="sec-h"><h2>' + title + '</h2><span class="sec-sub">'
    + list.length + ' 部 ' + (moreHtml || '') + '</span></div>'
    + '<div class="grid' + (gridClass ? ' ' + gridClass : '') + '">'
    + list.map(function (r) { return animeCard(r, { showYear: 0 }); }).join('')
    + '</div></section>';
}

function renderHome() {
  if (!HOME.y) homeDefaults();
  var rows = homeRows();
  var main = $('#main');

  /* 三段：推荐位（1 大 + 4 小）→ 今天更新 → 本季高分。全部由内存里的 ANI.rows 算出，
     不发新请求；hero 与「今天更新」都吃 homeRows() 的当前筛选结果。 */
  var hero = heroBlock(rows);
  var today = block('今天更新', rows, '');
  if (!today) today = '<div class="empty">这个筛选没有作品 —— 换季度或点「全部」试试</div>';
  var top = block('本季高分', topRows(8), '<a class="morelink" href="rank">排行榜 ›</a>', 'rankgrid');

  main.innerHTML = '<div class="home-cols">' + renderLevels()
    + '<div class="home-main">' + hero + today + top + '</div></div>';

  /* 交互 */
  main.querySelectorAll('[data-q]').forEach(function (b) {
    b.onclick = function () { HOME.q = Number(b.dataset.q); HOME.wd = 0; renderHome(); };
  });
  main.querySelectorAll('[data-wd]').forEach(function (b) {
    b.onclick = function () { HOME.wd = Number(b.dataset.wd); renderHome(); };
  });

  /* 卡片点击由文件底部的全局事件委托处理，这里不需要再绑定 */
}

function homeDefaults() {
  var y = ANI.year || new Date().getFullYear();
  var inY = yearRows(y);
  if (!inY.length) {
    var ys = {};
    ANI.rows.forEach(function (r) { if (r[4]) ys[r[4]] = 1; });
    y = Math.max.apply(null, Object.keys(ys).map(Number));
    inY = yearRows(y);
  }
  /* 默认落在「最新季度」；没有月份信息的则不限季度 */
  var q = 0;
  inY.forEach(function (r) { var s = seasonOf(r[5]); if (s > q) q = s; });
  /* 默认显示「今天」这一周：getDay() 0=周日…6=周六，站点 WD 1=周一…7=周日 */
  HOME = { y: y, q: q, wd: ((new Date().getDay() + 6) % 7) + 1 };
}

/* 首页 / 排行榜共用的搜索绑定：输入即筛番剧，清空后回到调用方指定的页面。
   两页共用一份实现，避免各写一套后行为漂移。 */
function bindSearch(empty) {
  $('#q').addEventListener('input', (function () {
    var t = 0;
    return function () {
      clearTimeout(t);
      var q = nrm(this.value.trim());
      t = setTimeout(function () {
        if (!q) { empty(); return; }
        var found = ANI.rows.filter(function (r) {
          return nrm(r[1] + ' ' + (r[2] || '')).indexOf(q) !== -1;
        }).slice(0, 120);
        $('#main').innerHTML = '<section class="block"><div class="bhead"><h2>搜索</h2><span>'
          + found.length + ' 部</span></div><div class="grid">'
          + found.map(function (r) { return animeCard(r, { showYear: 1 }); }).join('') + '</div></section>';
      }, 220);
    };
  })());
}

/* ---------------- 排行榜（独立页）：季度榜 / 总榜 / 剧场版精选 ---------------- */
function renderRank() {
  if (!HOME.y) homeDefaults();
  var main = $('#main');
  var head = '<div class="bhead"><h2>' + HOME.y + ' 年排行榜</h2><span>按 Bangumi 排名</span></div>';
  /* rankPool('rank-q') 读 HOME.y / HOME.q，所以上面必须先 homeDefaults() */
  var movieAll = ANI.rows.filter(function (r) { return r[3] === 'movie' && (r[12] || r[7]); });
  main.innerHTML = '<div class="home-head">' + head + '</div>'
    + rankBlock('rank-q', (HOME.q ? '第' + HOME.q + '季度' : '全部季度') + '榜',
        '按 Bangumi 排名 Top 12')
    + rankBlock('rank-all', '总榜', '全站排名 Top 24')
    + (movieAll.length
        ? rankBlock('rank-movie', '剧场版 · 精选', '',
            '<a class="morelink" href="movie">全部 ' + movieAll.length + ' 部 ›</a>')
        : '');
  mountRanks();
}
