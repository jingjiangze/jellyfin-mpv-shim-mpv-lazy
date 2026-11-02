/* 三张页面共用一份脚本：首页（今年新番·周/月）、番剧（全量目录）、媒体库。
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

  var ANI = { poster: '', rows: [], extra: {}, year: 0 };
  var shardCache = {};

  function animeCard(r, opt) {
    var id = r[0], name = r[2] || r[1];
    var ex = ANI.extra[id] || [];
    var alCover = ex[1] || '';
    var src = ANI.poster + id + '.jpg';
    var h = '<article class="card" data-id="' + id + '"><div class="pw">'
      + '<img src="' + esc(src) + '"' + fbAttr([alCover]) + ' loading="lazy" decoding="async" alt="">'
      + (r[7] ? '<span class="rate">★ ' + Number(r[7]).toFixed(1) + '</span>' : '')
      + (r[10] ? '<span class="mag">磁力</span>' : '')
      + (r[8] ? '<span class="ep">' + r[8] + ' 集</span>' : '')
      + '</div><div class="t">' + esc(name) + '</div><div class="sub2">'
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
      if (rec.votes) meta.push(rec.votes + ' 人评分');
      if (rec.rank) meta.push('排名 #' + rec.rank);
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
  var ys = {}, qs = {};
  ANI.rows.forEach(function (r) {
    if (r[4]) ys[r[4]] = (ys[r[4]] || 0) + 1;
    var q = seasonOf(r[5]);
    if (r[4] === HOME.y && q) qs[q] = (qs[q] || 0) + 1;
  });
  var ylist = Object.keys(ys).map(Number).sort(function (a, b) { return b - a; });
  var qlist = Object.keys(qs).map(Number).sort();

  var h = '<aside class="levels">';
  h += '<div class="lv"><div class="lv-h">年份</div><div class="chips">'
    + '<select class="lv-select" id="lv-y">'
    + ylist.map(function (y) {
      return '<option value="' + y + '"' + (y === HOME.y ? ' selected' : '') + '>'
        + y + ' 年（' + ys[y] + '）</option>';
    }).join('')
    + '</select></div></div>';

  h += '<div class="lv"><div class="lv-h">季度</div><div class="chips">'
    + chip('全部', !HOME.q, 'data-q', 0)
    + qlist.map(function (q) {
      return chip('第' + q + '季<span class="lv-n">' + qs[q] + '</span>', q === HOME.q, 'data-q', q);
    }).join('')
    + '</div></div>';

  h += '<div class="lv"><div class="lv-h">星期</div><div class="chips">'
    + chip('全部', !HOME.wd, 'data-wd', 0)
    + WD.map(function (d, i) { return chip(d.slice(1), HOME.wd === i + 1, 'data-wd', i + 1); }).join('')
    + '</div></div>';
  return h + '</aside>';
}

function rankBlock(id, title, sub, rows) {
  if (!rows.length) return '';
  return '<section class="block"><div class="bhead"><h2>' + title + '</h2><span>' + sub + '</span>'
    + '</div><div class="grid" id="' + id + '">'
    + rows.map(function (r) { return animeCard(r, { showYear: 1 }); }).join('')
    + '</div></section>';
}

function renderHome() {
  if (!HOME.y) homeDefaults();
  var rows = homeRows();
  var main = $('#main');

  var head = '<div class="bhead"><h2>' + HOME.y + ' 年'
    + (HOME.q ? ' 第' + HOME.q + ' 季度' : '')
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

  /* 榜单：季度榜取当前季度评分 Top 12；总榜取全站 Top 24（跨年份） */
  /* 榜单排序：有 bgm 排名就按排名（人气+评分综合），没有才退回评分。
     只按评分排会被「1 人打 10 分」的冷门片霸榜。 */
  function rankSort(a, b) {
    var ra = a[12] || 0, rb = b[12] || 0;
    if (ra && rb) return ra - rb;
    if (ra) return -1;
    if (rb) return 1;
    return (b[7] || 0) - (a[7] || 0);
  }
  var qPool = yearRows(HOME.y).filter(function (r) {
    return (!HOME.q || seasonOf(r[5]) === HOME.q) && (r[12] || r[7]);
  }).sort(rankSort).slice(0, 12);
  var allPool = ANI.rows.filter(function (r) { return r[12] || r[7]; })
    .sort(rankSort).slice(0, 24);

  main.innerHTML = '<div class="home-cols">' + renderLevels()
    + '<div class="home-main"><div class="home-head">' + head + '</div>' + body + '</div></div>'
    + rankBlock('rank-q', (HOME.y) + ' 年' + (HOME.q ? ' 第' + HOME.q + ' 季度' : '')
      + '榜', '按 Bangumi 排名 Top 12', qPool)
    + rankBlock('rank-all', '总榜', '全站排名 Top 24', allPool);

  /* 交互 */
  main.querySelectorAll('[data-q]').forEach(function (b) {
    b.onclick = function () { HOME.q = Number(b.dataset.q); HOME.wd = 0; renderHome(); };
  });
  main.querySelectorAll('[data-wd]').forEach(function (b) {
    b.onclick = function () { HOME.wd = Number(b.dataset.wd); renderHome(); };
  });
  var ysel = $('#lv-y');
  if (ysel) ysel.onchange = function () { HOME.y = Number(ysel.value); HOME.q = 0; HOME.wd = 0; renderHome(); };

  bindCards(main);
  return;
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
  HOME = { y: y, q: q, wd: 0 };
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
    BROWSE.view = ANI.rows.filter(function (r) {
      // 有搜索词时不套年份筛选，否则搜老番会被默认年份挡成 0 结果
      if (!q && y && String(r[4] || '') !== y) return false;
      if (t && r[3] !== t) return false;
      if (q && !hit(r[1] + ' ' + (r[2] || ''), q)) return false;
      return true;
    });
    if (sort === 'rating') BROWSE.view.sort(function (a, b) { return (b[7] || 0) - (a[7] || 0); });
    else if (sort === 'name') BROWSE.view.sort(function (a, b) { return String(a[2] || a[1]).localeCompare(String(b[2] || b[1]), 'zh'); });
    else BROWSE.view.sort(function (a, b) { return (b[4] || 0) - (a[4] || 0) || (b[7] || 0) - (a[7] || 0); });
    renderBrowse(true);
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
      + '<option value="name">标题</option></select></label>'
      + '<span class="f-hint" id="hint"></span></div>'
      + '<div class="grid" id="grid"></div>'
      + '<div class="morewrap" id="morewrap" hidden><button class="morebtn" id="morebtn" type="button"></button></div>';
    $('#f-year').value = ys[0] ? String(ys[0]) : '';
    $('#morebtn').onclick = function () { renderBrowse(false); };
    ['#f-year', '#f-type', '#f-sort'].forEach(function (s) { $(s).addEventListener('change', applyBrowse); });
    applyBrowse();
  }

  /* ---------------- 媒体库 ---------------- */
  function initLibrary() {
    j('./data/library.json').then(function (d) {
      var rows = d.rows || [];
      var base = d.poster || '';
      $('#cnt').textContent = rows.length + ' 部';
      function card(r) {
        var id = r[0], name = r[1], isSeries = r[2], year = r[3], rating = r[4], eps = r[5], bv = r[6], hposter = r[7];
        var img = hposter ? '<img src="' + esc(base + id + '.jpg') + '" loading="lazy" decoding="async" alt="">'
                          : '<div class="ph">🎬</div>';
        return '<article class="card" data-id="' + esc(id) + '"><div class="pw">' + img
          + (rating ? '<span class="rate">★ ' + Number(rating).toFixed(1) + '</span>' : '')
          + (eps ? '<span class="ep">' + eps + ' 集</span>' : '')
          + (bv ? '<span class="badge-bili">B站</span>' : '')
          + '</div><div class="t">' + esc(name) + '</div><div class="sub2">'
          + [year, isSeries ? '剧集' : '电影'].filter(Boolean).join(' · ') + '</div></article>';
      }
      function paint(q) {
        var list = rows.filter(function (r) {
          return !q || (r[1] || '').toLowerCase().indexOf(q) !== -1;
        });
        $('#main').innerHTML = '<div class="grid">' + list.map(card).join('') + '</div>';
        $('#hint') && ($('#hint').textContent = list.length + ' 部');
      }
      paint('');
      $('#q').addEventListener('input', function () { paint(this.value.trim().toLowerCase()); });
    });
  }

  /* ---------------- boot ---------------- */
  function bootAnime() {
    return j('./data/anime.json').then(function (d) {
      ANI.poster = d.poster || ''; ANI.rows = d.rows || [];
      ANI.extra = d.extra || {}; ANI.year = d.year || new Date().getFullYear();
    });
  }

  document.addEventListener('click', function (e) {
    var c = e.target.closest && e.target.closest('.card');
    if (!c) return;
    if (PAGE === 'library') {
      var id = c.dataset.id;
      window.open('http://127.0.0.1:8100/web/#/details?id=' + encodeURIComponent(id), '_blank');
      return;
    }
    openModal(Number(c.dataset.id));
  });
  $('#mask') && $('#mask').addEventListener('click', function (e) { if (e.target.id === 'mask') close(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

  if (PAGE === 'library') { initLibrary(); return; }
  bootAnime().then(function () {
    if (PAGE === 'anime') {
      $('#q').placeholder = '在 ' + ANI.rows.length + ' 部里搜…';
      initBrowse();
      var qt = 0;
      $('#q').addEventListener('input', function () {
        clearTimeout(qt);
        qt = setTimeout(applyBrowse, 220);
      });
    } else {
      renderHome();
      $('#q').addEventListener('input', (function () {
        var t = 0;
        return function () {
          clearTimeout(t);
          var q = nrm(this.value.trim());
          t = setTimeout(function () {
            if (!q) { renderHome(); return; }
            var hit = ANI.rows.filter(function (r) {
              return (r[1] + ' ' + (r[2] || '')).toLowerCase().indexOf(q) !== -1;
            }).slice(0, 120);
            $('#main').innerHTML = '<section class="block"><div class="bhead"><h2>搜索</h2><span>'
              + hit.length + ' 部</span></div><div class="grid">'
              + hit.map(function (r) { return animeCard(r, { showYear: 1 }); }).join('') + '</div></section>';
          }, 220);
        };
      })());
    }
  }).catch(function (e) {
    $('#main').innerHTML = '<div class="loading">数据加载失败：' + esc(e.message || e) + '</div>';
  });
})();
