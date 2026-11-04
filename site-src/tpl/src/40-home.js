/* ---------------- 首页：年 → 季度 → 周几（三级下钻）+ 榜单 ---------------- */
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

  /* 榜单单独成页：左侧给一个跳转入口，移动端会自动并进顶部横排 */
  h += '<div class="lv"><div class="lv-h">榜单</div>'
    + '<div class="chips chips--col"><a class="lv-link" href="rank">排行榜 ›</a></div></div>';
  return h + '</aside>';
}

/* 榜单默认不渲染：先放空壳，滚到附近才排序 + 填卡。
   三块榜单要各排一遍 8,851 条再渲染 48 张卡，进站白算很不值。 */
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

/* ---------------- 我的追番：追番页的取数与排序 ----------------
   追番存在 localStorage（见 20-state.js），天然是全站视角：不参与 HOME.y/q/wd 筛选。
   只保留还能在 ANI.rows 里查到的 id（数据换过 / 条目下架的直接跳过），顺序按追番时间
   t 倒序；旧格式条目 t=0 排在最后，同一个 t 再按 id 升序，保证每次渲染顺序一致
   （Array#sort 本身稳定，这里显式定序不依赖实现）。 */
function favRows() {
  var byId = {};
  ANI.rows.forEach(function (r) { byId[String(r[0])] = r; });
  return favEntries()
    .filter(function (e) { return byId[e.id]; })
    .sort(function (a, b) {
      if (a.t !== b.t) return b.t - a.t;
      var na = Number(a.id), nb = Number(b.id);      // id 是数字串：按数值升序更符合直觉
      if (isFinite(na) && isFinite(nb) && na !== nb) return na - nb;
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    })
    .map(function (e) { return byId[e.id]; });
}

/* ---------------- 追番页（fav.html）：整页只渲染追番列表 ----------------
   排序完全沿用 favRows()（t 倒序），这里不按季度/星期筛选——HOME.q / HOME.wd 只属于首页。
   卡片走 animeCard，点击由 90-boot.js 的 .card 事件委托统一处理，无需在此绑定。
   追番增删后由 70-modal.js 派发 favchange，90-boot.js 监听并重新调用本函数。 */
function renderFavPage() {
  var rows = favRows();
  var cards = rows.map(function (r) { return animeCard(r, { showYear: 1, fav: 1 }); }).join('');
  $('#main').innerHTML = '<div class="favpage"><div class="bhead"><h2>我的追番</h2><span>'
    + rows.length + ' 部</span></div>'
    + (rows.length
        ? '<div class="grid" id="favgrid">' + cards + '</div>'
        : '<div class="empty">还没有追番 —— 打开任意作品详情，点「☆ 追番」</div>')
    + '</div>';
}

function renderHome() {
  if (!HOME.y) homeDefaults();
  var rows = homeRows();
  var main = $('#main');

  var head = '<div class="bhead"><h2>'
    + (HOME.q ? '第' + HOME.q + '季度' : '全部季度')
    + (HOME.wd ? ' · ' + WD[HOME.wd - 1] : '')
    + '</h2><span>' + rows.length + ' 部</span></div>';

  var body = '';
  if (rows.length && !HOME.wd) {
    /* 没指定星期：按周一到周日分组，周一~周日固定顺序（和 bgm 一致） */
    for (var w = 1; w <= 7; w++) {
      var g = rows.filter(function (r) { return r[6] === w; });
      if (!g.length) continue;
      body += '<section class="block"><div class="bhead lv2"><h2>' + WD[w - 1] + '</h2><span>'
        + g.length + ' 部</span></div><div class="grid">'
        + g.map(function (r) { return animeCard(r, { showYear: 0 }); }).join('') + '</div></section>';
    }
    var unknown = rows.filter(function (r) { return !r[6]; });
    if (unknown.length) {
      body += '<section class="block"><div class="bhead lv2"><h2>放送日未知</h2><span>'
        + unknown.length + ' 部</span></div><div class="grid">'
        + unknown.map(function (r) { return animeCard(r); }).join('') + '</div></section>';
    }
  } else if (rows.length) {
    body = '<div class="grid">' + rows.map(function (r) {
      return animeCard(r, { showYear: 0 });
    }).join('') + '</div>';
  } else {
    body = '<div class="empty">这个筛选没有作品 —— 换季度或点「全部」试试</div>';
  }

  /* 榜单已搬到独立页（rank.html）：首页只放本周分组网格。
     左侧面板由 renderLevels() 给出「排行榜」入口。 */
  main.innerHTML = '<div class="home-cols">' + renderLevels()
    + '<div class="home-main"><div class="home-head">' + head + '</div>' + body
    + '</div></div>';

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
