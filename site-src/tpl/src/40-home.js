/* ---------------- 首页（照 ani.gamer.com.tw：无筛选条，区块按当天/当季自动出） ---------------- */
var HOME = { y: 0, q: 0 };
var QS = [1, 2, 3, 4];

function seasonOf(m) { return m ? Math.ceil(m / 3) : 0; }

function yearRows(y) { return ANI.rows.filter(function (r) { return r[4] === y; }); }

function byScore(a, b) { return (b[7] || 0) - (a[7] || 0); }

/* 当天星期（站点口径 1=周一 … 7=周日）。首页「今天更新」不让人选，
   直接按今天出 —— gamer 首页也是这个行为，筛选一律去番剧页做。 */
function wdToday() { return ((new Date().getDay() + 6) % 7) + 1; }

function todayRows() {
  var wd = wdToday();
  return yearRows(HOME.y).filter(function (r) { return r[6] === wd; }).sort(byScore);
}

/* 本季新番：当前年 + 最新季度全部，按评分排 */
function seasonRows() {
  return yearRows(HOME.y).filter(function (r) {
    return !HOME.q || seasonOf(r[5]) === HOME.q;
  }).sort(byScore);
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
    if (box) box.innerHTML = rows.map(function (r, i) {
      return animeCard(r, { showYear: 1, rank: i + 1 });
    }).join('');
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

/* 全站高分：给「本季高分」用。无评分（r[7] 空 / 0）的条目跳过。
   filter 已产出新数组，这里的 sort 不会动 ANI.rows。 */
function topRows(n) {
  return ANI.rows.filter(function (r) { return r[7]; })
    .sort(function (a, b) { return b[7] - a[7]; })
    .slice(0, n || 8);
}

/* 首页区块：标题 + 计数（+ 可选的「更多」链接）+ 卡片网格。
   list 为空时整块返回空串，由调用方决定是否补空态。
   ranked=true 时卡片带名次件（热门排行用；其余区块用普通卡）。 */
function block(title, list, moreHtml, gridClass, ranked) {
  if (!list || !list.length) return '';
  return '<section class="block"><div class="sec-h"><h2>' + title + '</h2><span class="sec-sub">'
    + list.length + ' 部 ' + (moreHtml || '') + '</span></div>'
    + '<div class="grid' + (gridClass ? ' ' + gridClass : '') + '">'
    + list.map(function (r, i) {
      return animeCard(r, ranked ? { showYear: 0, rank: i + 1 } : { showYear: 0 });
    }).join('')
    + '</div></section>';
}

/* 首页 banner（gamer 的 .big_banner，整条 250px）：照 gamer 做成轮播 —— 多张 + 左右箭头 +
   圆点，6s 自动、hover 暂停。取当前筛选结果里评分最高的 5 部，凑不到 5 部有几部放几部。
   列表行不带简介，简介等**该张**的详情分片回来再补；拉不到就留空 <p>（空元素无高度，不撑版）。 */
var BANNER_GEN = 0;
var BB_TIMER = 0;          // 轮播定时器（模块级：重画首页必须先清掉上一代，否则它还在拨旧 DOM）
var BB_N = 5;

function bannerPick(rows, n) {
  var out = [];
  for (var i = 0; i < rows.length && out.length < (n || 1); i++) {
    if (rows[i] && rows[i][7]) out.push(rows[i]);
  }
  return out;
}

function bannerHtml(r, on) {
  var id = r[0], name = r[2] || r[1];
  /* 副标题：年 · 类型 · 评分 · 话数，缺哪项就不占位（与弹窗 .mbadges 的口径一致） */
  var sub = [r[4] || '', TYPE[r[3]] || r[3] || '',
    r[7] ? '★' + Number(r[7]).toFixed(1) : '', r[8] ? r[8] + ' 话' : '']
    .filter(Boolean).join(' · ');
  return '<a class="bigbanner' + (on ? ' is-on' : '') + '" href="./detail?id=' + id + '">'
    + '<img class="bigbanner-bg" src="' + esc(posterSrc(id)) + '" alt="">'
    + '<div class="bigbanner-in">'
    + '<span class="bigbanner-tag">本季推荐</span>'
    + '<h2>' + titleHTML(name) + '</h2>'
    + '<p class="bigbanner-sub">' + esc(sub) + '</p>'
    + '<p class="bigbanner-plot"></p>'
    + '</div></a>';
}

function bannerCarousel(rows) {
  var slides = rows.map(function (r, i) { return bannerHtml(r, i === 0); }).join('');
  var dots = rows.map(function (r, i) {
    return '<i data-i="' + i + '"' + (i ? '' : ' class="on"') + '></i>';
  }).join('');
  return '<div class="bb">' + slides
    + '<button class="bb-nav bb-prev" type="button" aria-label="上一张">‹</button>'
    + '<button class="bb-nav bb-next" type="button" aria-label="下一张">›</button>'
    + '<div class="bb-dots">' + dots + '</div></div>';
}

/* gen：renderHome 每次重画自增，异步回来的简介只落最后一代（否则切筛选后会写进新 DOM） */
function fillBannerPlot(slide, r, gen) {
  if (!slide) return;
  detailShard(r[0]).then(function (list) {
    if (gen !== BANNER_GEN || !list) return;
    var box = slide.querySelector('.bigbanner-plot');
    if (!box) return;
    var rec = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === r[0]) { rec = list[i]; break; }
    }
    var txt = String((rec && rec.overview) || '').replace(/\s+/g, ' ').trim();
    if (txt) box.textContent = txt.slice(0, 80) + (txt.length > 80 ? '…' : '');
  }, function () { /* 分片拉不到：banner 其余部分照常，简介留空 */ });
}

/* 轮播交互：只给「当前张」补简介（不预拉 5 个分片），hover 暂停，切张后重置计时。 */
function initCarousel(main, rows, gen) {
  var root = main.querySelector('.bb');
  if (!root) return;
  var slides = [].slice.call(root.querySelectorAll('.bigbanner'));
  var dots = [].slice.call(root.querySelectorAll('.bb-dots i'));
  var n = slides.length;
  if (!n) return;
  var at = 0;

  function plot(i) {
    var box = slides[i] && slides[i].querySelector('.bigbanner-plot');
    if (box && !box.textContent) fillBannerPlot(slides[i], rows[i], gen);
  }
  function go(i) {
    at = ((i % n) + n) % n;
    slides.forEach(function (e, k) { e.classList.toggle('is-on', k === at); });
    dots.forEach(function (d, k) { d.classList.toggle('on', k === at); });
    plot(at);
  }
  function stop() { if (BB_TIMER) { clearInterval(BB_TIMER); BB_TIMER = 0; } }
  /* 跳页时 #main 整段被换掉，定时器还活着就会一直拨已脱离文档的节点 —— 一旦断开就自停 */
  function tick() {
    stop();
    BB_TIMER = setInterval(function () {
      if (!root.isConnected) { stop(); return; }
      go(at + 1);
    }, 6000);
  }

  root.querySelector('.bb-prev').onclick = function (e) { e.preventDefault(); go(at - 1); tick(); };
  root.querySelector('.bb-next').onclick = function (e) { e.preventDefault(); go(at + 1); tick(); };
  dots.forEach(function (d) {
    d.onclick = function (e) { e.preventDefault(); go(Number(d.getAttribute('data-i'))); tick(); };
  });
  root.onmouseenter = stop;
  root.onmouseleave = tick;
  plot(0);
  if (n > 1) tick();
}

/* 继续观看（gamer 首页同样有这个区块）：读本地/远端进度，按最近观看排序。
   进度里可能留着已下架条目的 id，找不到列表行就跳过，不做占位卡。 */
function contList(n) {
  var all = progressAll();
  var idx = {};
  for (var i = 0; i < ANI.rows.length; i++) idx[String(ANI.rows[i][0])] = ANI.rows[i];
  var out = [];
  for (var k in all) {
    if (!Object.prototype.hasOwnProperty.call(all, k)) continue;
    var rec = progressOf(k);
    var row = idx[String(k)];
    if (!rec || !row) continue;
    out.push({ r: row, ep: Math.floor(Number(rec.ep)), pos: Number(rec.pos) || 0,
      dur: Number(rec.dur) || 0, ts: Number(rec.ts) || 0 });
  }
  out.sort(function (a, b) { return b.ts - a.ts; });
  return out.slice(0, n || 7);
}

function contCard(it) {
  var r = it.r, id = r[0], name = r[2] || r[1];
  var pc = it.dur > 0 && it.pos > 0 ? Math.min(100, Math.round(it.pos / it.dur * 100)) : 0;
  var left = it.dur > 0 && it.pos > 0 ? Math.round((it.dur - it.pos) / 60) : 0;
  return '<article class="card cont" data-id="' + id + '"><div class="pw">'
    + '<img src="' + esc(posterSrc(id)) + '"' + fbAttr([(ANI.extra[id] || [])[1]])
    + ' loading="lazy" decoding="async" alt="">'
    + (r[8] ? '<span class="ep">' + r[8] + ' 集</span>' : '')
    /* 没时长（只上报过「看到第 N 集」）就留 6% 起始痕，别画成 0 宽的假进度 */
    + '<span class="cont-bar"><i style="width:' + (pc || 6) + '%"></i></span>'
    + '</div><div class="t">' + titleHTML(name) + '</div>'
    + '<div class="sub2">看到第 ' + it.ep + ' 集' + (left ? ' · 剩 ' + left + ' 分钟' : '') + '</div></article>';
}

function contBlock() {
  var list = contList(7);
  if (!list.length) return '';
  return '<section class="block"><div class="sec-h"><h2>继续观看</h2>'
    + '<span class="sec-sub">' + list.length + ' 部 '
    + '<a class="morelink" href="./user">观看记录 ›</a></span></div>'
    + '<div class="grid">' + list.map(contCard).join('') + '</div></section>';
}

function renderHome() {
  if (!HOME.y) homeDefaults();
  var main = $('#main');

  /* 区块（自上而下，照 gamer 首页）：继续观看 → 今天更新 → 本季新番 → 本季高分 → 热门排行。
     全部由内存里的 ANI.rows + 本地进度算出，不发新请求。空块自动不出。 */
  var wd = wdToday();
  var seasonPool = seasonRows();
  var cont = contBlock();
  /* 每块只放一行 7 张（gamer 的首页区块就是这个节奏），整季/整年去番剧页看 */
  var today = block('今天更新 · ' + (WD[wd - 1] || ''), todayRows().slice(0, 7),
    '<a class="morelink" href="./anime">全部番剧 ›</a>');
  var season = block('本季新番 · ' + (HOME.q ? '第' + HOME.q + '季度' : HOME.y), seasonPool.slice(0, 7),
    '<a class="morelink" href="./anime">更多 ›</a>');
  var top = block('本季高分', topRows(7), '<a class="morelink" href="./rank">排行榜 ›</a>');
  var hot = block('热门排行', rankPool('rank-all').slice(0, 7),
    '<a class="morelink" href="./rank">全部排行 ›</a>', '', true);

  /* banner 全宽，放在内容之前；一张可用的都没有就不出 banner */
  var picks = bannerPick(seasonPool.length ? seasonPool : ANI.rows, BB_N);
  var gen = ++BANNER_GEN;
  if (BB_TIMER) { clearInterval(BB_TIMER); BB_TIMER = 0; }   // 上一代的自动轮播先停

  main.innerHTML = (picks.length ? bannerCarousel(picks) : '')
    + '<div class="home-main">' + cont + today + season + top + hot + '</div>';
  if (picks.length) initCarousel(main, picks, gen);

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
  HOME = { y: y, q: q };
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
