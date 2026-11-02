/* 三张页面共用一份脚本：首页（今年新番·周/月）、番剧（全量目录）、电影（豆瓣 / TMDB / 剧场版）。
   数据全部走 ./data/*.json，页面本身只是壳。 */
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var PAGE = document.body.dataset.page || 'home';
  var TYPE = { tv: 'TV', movie: '剧场版', ova: 'OVA', web: '网络', music: '音乐', other: '其他' };
  var WD = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  /* 模糊搜索：全角转半角 + 去标点空白 + 小写；命中任意位置即算 */
  function nrm(x) {
    return String(x == null ? '' : x).toLowerCase()
      .replace(/[\uFF01-\uFF5E]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 65248); })
      .replace(/[\s\-_.·・:!?,.'"()\[\]{}<>【】（）~〜]/g, '');
  }
  function hit(hay, q) { return !q || nrm(hay).indexOf(q) !== -1; }

  function j(u) { return fetch(u).then(function (r) { if (!r.ok) throw 0; return r.json(); }); }
  function fbAttr(list) {
    var q = list.filter(Boolean);
    return q.length ? ' data-fb="' + esc(q.join('|')) + '" onerror="__fb(this)"' : '';
  }
  window.__fb = function (img) {
    var q = (img.dataset.fb || '').split('|').filter(Boolean);
    if (!q.length) { img.onerror = null; img.style.visibility = 'hidden'; return; }
    img.src = q.shift();
    img.dataset.fb = q.join('|');
  };

  var ANI = { poster: '', posterSd: '', rows: [], extra: {}, year: 0 };
  var shardCache = {};

  /* 海报清晰度：hd 用大图 ANI.poster，sd 用小图 ANI.posterSd（省流量）。
     sd 图缺失或加载失败时由 data-fb 回落到大图，绝不能出现空白封面。 */
  var PSZ = { mode: 'hd' };
  try {
    var _psz = localStorage.getItem('psz');
    if (_psz === 'hd' || _psz === 'sd') PSZ.mode = _psz;
  } catch (e) { /* 隐私模式 / file:// 下 localStorage 可能不可用，忽略 */ }

  function posterSrc(id) {
    var base = PSZ.mode === 'sd' ? (ANI.posterSd || ANI.poster) : ANI.poster;
    return base + id + '.jpg';
  }

  /* 卡片标题用：连字符是 CSS 的合法断行点，"Yu-hachi" 会被拆成 "Yu-"/"hachi"。
     在连字符后插 word joiner（U+2060）阻止断行。只用于 .t —— 弹窗里的 h3
     要拿去做磁力匹配，绝不能掺入不可见字符。 */
  function titleHTML(s) {
    return esc(s).replace(/-/g, '-⁠');
  }

  function animeCard(r, opt) {
    var id = r[0], name = r[2] || r[1];
    var ex = ANI.extra[id] || [];
    var alCover = ex[1] || '';
    var src = posterSrc(id);
    var fb = PSZ.mode === 'sd' ? [alCover, ANI.poster + id + '.jpg'] : [alCover];
    var h = '<article class="card" data-id="' + id + '"><div class="pw">'
      + '<img src="' + esc(src) + '"' + fbAttr(fb) + ' loading="lazy" decoding="async" alt="">'
      + (r[7] ? '<span class="rate">★ ' + Number(r[7]).toFixed(1) + '</span>' : '')
      + (r[8] ? '<span class="ep">' + r[8] + ' 集</span>' : '')
      + '</div><div class="t">' + titleHTML(name) + '</div><div class="sub2">'
      + [(opt && opt.showYear ? (r[4] || '') : ''), TYPE[r[3]] || r[3] || ''].filter(Boolean).join(' · ')
      + '</div></article>';
    return h;
  }

  function openModal(id) {
    var r = ANI.rows.find(function (x) { return x[0] === id; });
    if (!r) return;
    var ex = ANI.extra[id] || [];
    var title = r[2] || r[1];
    var m = $('#modal');
    /* 结构契约：magnet-eps.js 靠 h3 取片名、靠 .acts 定位插入点，别改这两个 */
    m.innerHTML = '<span class="x" aria-label="关闭">×</span>'
      + '<div class="mhd">'
      +   '<div class="mposter"><img src="' + esc(ANI.poster + id + '.jpg') + '"' + fbAttr([ex[1]]) + ' alt=""></div>'
      +   '<div class="mb">'
      +     '<h3>' + esc(title) + '</h3>'
      +     (r[1] !== title ? '<div class="orig">' + esc(r[1]) + '</div>' : '')
      +     '<div class="mrate">'
      +       (r[7] ? '<i class="stars" style="--p:' + Math.max(0, Math.min(10, Math.round(r[7])))
                 + '"></i><b class="num">' + Number(r[7]).toFixed(1) + '</b>' : '<b class="num dim">暂无评分</b>')
      +       '<span class="mvotes" id="mvotes"></span>'
      +     '</div>'
      +     '<dl class="infobox" id="minfo">'
      +       (r[4] ? '<dt>放送</dt><dd>' + r[4] + (r[5] ? '.' + String(r[5]).padStart(2, '0') : '') + '</dd>' : '')
      +       (r[6] ? '<dt>星期</dt><dd>' + WD[r[6] - 1] + '</dd>' : '')
      +       (r[8] ? '<dt>话数</dt><dd>' + r[8] + ' 集</dd>' : '')
      +       (r[3] ? '<dt>类型</dt><dd>' + esc(TYPE[r[3]] || r[3]) + '</dd>' : '')
      +     '</dl>'
      +   '</div>'
      + '</div>'
      + '<div class="mbody"><h4>简介</h4><p class="plot" id="plot">加载中…</p>'
      +   '<div class="tags" id="tags"></div></div>'
      + '<div class="acts">'
      +   '<a class="btn pri" target="_blank" rel="noopener" href="https://bgm.tv/subject/' + id + '">Bangumi</a>'
      +   (ex[2] ? '<span class="btn" id="play">▶ 预告</span>' : '')
      +   '<a class="btn" target="_blank" rel="noopener" href="https://search.bilibili.com/all?keyword='
      +     encodeURIComponent(title) + '">B 站搜索</a>'
      + '</div>';
    $('#mask').classList.add('on');
    m.querySelector('.x').onclick = close;

    if (ex[2]) {
      $('#play').onclick = function () {
        if (m.querySelector('.trailer')) return;
        var d = document.createElement('div');
        d.className = 'trailer';
        d.innerHTML = '<iframe src="https://www.youtube.com/embed/' + encodeURIComponent(ex[2])
          + '?autoplay=1&rel=0" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>';
        m.appendChild(d);
      };
    }

    var sfx = id % 64;
    var pr = shardCache[sfx] || (shardCache[sfx] = j('./data/s' + sfx + '.json').catch(function () { return []; }));
    pr.then(function (list) {
      var rec = (list || []).find(function (x) { return x.id === id; });
      var plot = $('#plot'), tags = $('#tags');
      if (!rec) { plot.textContent = '暂无详细资料'; return; }
      plot.textContent = rec.overview || '暂无简介';
      tags.innerHTML = (rec.tags || []).slice(0, 12)
        .map(function (t) { return '<span class="tagpill">' + esc(t) + '</span>'; }).join('');
      var meta = [];
      /* 评分分布：10 根柱子（1…10 分），高度按各档人数归一 */
      if (Array.isArray(rec.rc) && rec.rc.length === 10 && !document.querySelector('#rdist')) {
        var host = document.querySelector('#modal .mrate');
        if (host && host.parentNode) {
          var mx = Math.max.apply(null, rec.rc);
          var sum = rec.rc.reduce(function (a, b) { return a + b; }, 0);
          var bars = rec.rc.map(function (n, i) {
            var h = mx ? Math.max(2, Math.round((n / mx) * 100)) : 2;
            return '<i style="height:' + h + '%" title="' + (i + 1) + ' 分 · ' + n + ' 人">'
              + '<b>' + (i + 1) + '</b></i>';
          }).join('');
          var div = document.createElement('div');
          div.className = 'rdist';
          div.id = 'rdist';
          div.innerHTML = bars + '<em>' + sum + ' 人评分</em>';
          host.parentNode.insertBefore(div, host.nextSibling);
        }
      }
      if (rec.votes) meta.push(rec.votes + ' 人评分');
      if (rec.rank) {
        /* 排名分位：bgm 那种「评分分布」要每档人数，我们数据里没有（要调
           Bangumi API，浏览器跨域取不到）；能真算的是排名在全体里的位置。 */
        var total = ANI.rows.length || 1;
        var pct = Math.max(0.1, (rec.rank / total) * 100);
        meta.push('排名 #' + rec.rank + (pct < 20 ? '（前 ' + pct.toFixed(1) + '%）' : ''));
      }
      var mv = $('#mvotes'); if (mv) mv.textContent = meta.join(' · ');
    });
  }
  function close() { $('#mask').classList.remove('on'); }

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

function chip(label, on, attr, val) {
  return '<button class="chip' + (on ? ' on' : '') + '" type="button" ' + attr + '="' + val + '">'
    + label + '</button>';
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
          return (r[1] + ' ' + (r[2] || '')).toLowerCase().indexOf(q) !== -1;
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
  function applyBrowse() {
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
    renderBrowse(true);
  }
  /* 标签索引按需加载：tags.json 只在上万人点开「标签」筛选时才拉，
     8,851 条的 tag→id 映射有几百 KB，进站不背这个包袱。 */
  var TAGS = null;
  function ensureTags() {
    if (TAGS) return Promise.resolve(TAGS);
    return j('./data/tags.json').then(function (d) {
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
          return '<option value="' + n + '">' + n + '（' + t[n].length + '）</option>';
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

  /* ---------------- 电影：豆瓣新片 / TMDB 热门 / 剧场版全收录 ---------------- */
  var MOVIE = { all: [], view: [], shown: 0, page: 120, db: [], tm: [] };

  /* 豆瓣 / TMDB 卡片刻意用 .mcard（不是 .card）：两种卡走两条弹窗路径 —
     .card 进 Bangumi 弹窗，.mcard 由 openExtModal 就地展开详情，不直接跳外站。 */
  /* 字段取自 data/movies.json 的契约：douban {n,u,img,r,k,id,intro,sub}、
     tmdb {n,u,img,r,y,id,ov,ot}（豆瓣条目没有 y，intro/ov 可能为空串）。
     兼容 title/url/rating/year 旧写法，免得数据换名就整片空白。
     data-ext / data-i 供全局委托定位到 MOVIE.db / MOVIE.tm 的下标；
     不能挂内联 onclick —— paintMovieDb() 每次整块重写 innerHTML，内联绑定会丢。 */
  function mcard(x, kind, idx) {
    var img = x.img ? '<img src="' + esc(x.img) + '" loading="lazy" decoding="async" alt="">'
                    : '<div class="ph">🎬</div>';
    var rate = (x.r != null && x.r !== '') ? x.r : x.rating;
    var sub = [(rate ? '★ ' + Number(rate).toFixed(1) : ''), (x.y || x.year || '')]
      .filter(Boolean).join(' · ');
    return '<article class="mcard" data-ext="' + esc(kind || '') + '" data-i="'
      + (idx == null ? '' : idx) + '"><a href="' + esc(x.u || x.url || '#') + '" target="_blank" rel="noopener">'
      + '<div class="pw">' + img + '</div><div class="t">' + esc(x.n || x.title || '') + '</div>'
      + '<div class="sub2">' + sub + '</div></a></article>';
  }

  function msec(title, list, kind) {
    return '<section class="msect"><div class="mhead"><h2>' + title + '</h2><span>'
      + list.length + ' 部</span></div><div class="grid mgrid">'
      + list.map(function (x, i) { return mcard(x, kind, i); }).join('') + '</div></section>';
  }

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

  function applyMovie() {
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
    renderMovie(true);
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
    j('./data/movies.json').then(function (d) {
      MOVIE.db = (d && d.douban) || [];
      MOVIE.tm = (d && d.tmdb) || [];
      paintMovieDb();
    }).catch(function () { paintMovieDb(); });
  }

  /* 只重画，不重建 DOM：清晰度切换时保留当前筛选与搜索词（状态都在 select / input 上） */
  function refreshMovie() {
    if (!$('#mgrid')) return;
    paintMovieDb();
    applyMovie();
  }

  /* ---------------- 海报清晰度开关（#psz 按钮由生成器输出） ---------------- */
  function repaint() {
    if (PAGE === 'anime') applyBrowse();
    else if (PAGE === 'movie') refreshMovie();
    else if (PAGE === 'rank') renderRank();
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
    /* 首页 / 番剧 / 排行榜都搜番剧，只有电影页搜电影 */
    var ph = P === 'movie' ? '搜索电影…' : '搜索番剧…';
    var nav = [['./', 'home', '首页'], ['anime', 'anime', '番剧'], ['movie', 'movie', '电影'],
      ['rank', 'rank', '排行榜']]
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

  /* ---------------- boot ---------------- */
  function bootAnime() {
    return j('./data/anime.json').then(function (d) {
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
    } else {
      renderHome();
      bindSearch(renderHome);
    }
    /* #psz 必须在数据就位之后再绑：它的 repaint 依赖 ANI.rows */
    initPsz();
  }).catch(function (e) {
    $('#main').innerHTML = '<div class="loading">数据加载失败：' + esc(e.message || e) + '</div>';
  });
})();
