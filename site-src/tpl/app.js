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
  function j(u) { return fetch(u).then(function (r) { if (!r.ok) throw 0; return r.json(); }); }
  var MS = 'https://modelscope.cn/datasets/jingjiangze/Anime-JPG/resolve/master/assets/';
  function jMS(path) {
    return fetch(MS + path).then(function (r) {
      if (!r.ok) throw 0;
      return r.json();
    }).catch(function () { return j(path); });
  }
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
    var pr = shardCache[sfx] || (shardCache[sfx] = jMS('data/s' + sfx + '.json').catch(function () { return []; }));
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

  /* ---------------- 首页：年 → 月 → 周 → 星期 四级下钻 ---------------- */
  var HOME = { y: 0, m: 0, w: 0, wd: 0 };
  var WD_ALL = [1, 2, 3, 4, 5, 6, 7];

  function wkOfDay(day) { return day ? Math.floor((day - 1) / 7) + 1 : 0; }

  function homeRows() {
    return ANI.rows.filter(function (r) {
      if (HOME.y && r[4] !== HOME.y) return false;
      if (HOME.m && r[5] !== HOME.m) return false;
      if (HOME.w && wkOfDay(r[10]) !== HOME.w) return false;
      if (HOME.wd && r[6] !== HOME.wd) return false;
      return true;
    }).sort(function (a, b) { return (b[7] || 0) - (a[7] || 0) || (b[10] || 0) - (a[10] || 0); });
  }

  function chip(label, on, val) {
    return '<button class="chip' + (on ? ' on' : '') + '" data-v="' + val + '" type="button">' + label + '</button>';
  }

  function renderLevels() {
    var years = {};
    ANI.rows.forEach(function (r) { if (r[4]) years[r[4]] = (years[r[4]] || 0) + 1; });
    var ys = Object.keys(years).map(Number).sort(function (a, b) { return b - a; });
    var months = {}; ANI.rows.forEach(function (r) { if (r[4] === HOME.y && r[5]) months[r[5]] = 1; });
    var ms = Object.keys(months).map(Number).sort(function (a, b) { return a - b; });
    var inM = ANI.rows.filter(function (r) { return r[4] === HOME.y && r[5] === HOME.m; });
    var weeks = {}; inM.forEach(function (r) { var w = wkOfDay(r[10]); if (w) weeks[w] = 1; });
    var ws = Object.keys(weeks).map(Number).sort(function (a, b) { return a - b; });

    var h = '<aside class="levels">';
    h += '<div class="lv"><div class="lv-h">年份</div><div class="chips"><select class="lv-select" id="lv-y">'
      + ys.map(function (y) { return '<option value="' + y + '"' + (y === HOME.y ? ' selected' : '') + '>'
        + y + ' 年（' + years[y] + '）</option>'; }).join('')
      + '</select></div></div>';
    h += '<div class="lv"><div class="lv-h">月份</div><div class="chips">'
      + ms.map(function (m) { return chip(m + ' 月', m === HOME.m, m); }).join('') + '</div></div>';
    h += '<div class="lv"><div class="lv-h">周</div><div class="chips">'
      + ws.map(function (w) { return chip('第' + w + '周', w === HOME.w, w); }).join('') + '</div></div>';
    h += '<div class="lv"><div class="lv-h">星期</div><div class="chips">'
      + chip('全部', !HOME.wd, 0)
      + WD_ALL.map(function (w) { return chip(WD[w - 1], w === HOME.wd, w); }).join('') + '</div></div>';
    h += '</aside>';
    return h;
  }

  function renderHomeContent() {
    var list = homeRows();
    var wdLabel = HOME.wd ? WD[HOME.wd - 1] : '本周全部';
    var head = '<div class="bhead"><h2>' + HOME.y + ' 年 ' + HOME.m + ' 月 第' + HOME.w + '周 · '
      + wdLabel + '</h2><span>' + list.length + ' 部</span></div>';
    var body = list.length
      ? '<div class="grid">' + list.map(function (r) { return animeCard(r); }).join('') + '</div>'
      : '<div class="loading">这个时间段没有放送 —— 点左侧选择器换一周试试</div>';
    return head + body;
  }

  function renderHome() {
    if (!HOME.y) homeDefaults();
    var main = $('#main');
    main.innerHTML = '<div class="home-cols">' + renderLevels()
      + '<div class="home-main" id="home-main">' + renderHomeContent() + '</div></div>';
    main.querySelectorAll('.chip').forEach(function (b) {
      b.onclick = function () {
        var v = Number(b.dataset.v);
        var lvName = b.closest('.lv').querySelector('.lv-h').textContent;
        if (lvName === '月份') HOME.m = v;
        else if (lvName === '周') HOME.w = v;
        else HOME.wd = v;
        renderHome();
      };
    });
    var ysel = $('#lv-y');
    if (ysel) ysel.onchange = function () { HOME.y = Number(ysel.value); renderHome(); };
  }

  function homeDefaults() {
    var y = ANI.year || new Date().getFullYear();
    var inY = ANI.rows.filter(function (r) { return r[4] === y; });
    if (!inY.length) {
      var ys = {};
      ANI.rows.forEach(function (r) { if (r[4]) ys[r[4]] = 1; });
      y = Math.max.apply(null, Object.keys(ys).map(Number));
      inY = ANI.rows.filter(function (r) { return r[4] === y; });
    }
    var months = {};
    inY.forEach(function (r) { if (r[5]) months[r[5]] = 1; });
    var m = Math.max.apply(null, Object.keys(months).map(Number));
    var inM = inY.filter(function (r) { return r[5] === m; });
    var weeks = {};
    inM.forEach(function (r) { var w = wkOfDay(r[10]); if (w) weeks[w] = 1; });
    var w = Math.max.apply(null, Object.keys(weeks).map(Number));
    HOME = { y: y, m: m, w: w, wd: 0 };
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
    var q = ($('#q').value || '').trim().toLowerCase();
    var y = ($('#f-year') || {}).value || '';
    var t = ($('#f-type') || {}).value || '';
    var sort = ($('#f-sort') || {}).value || 'year';
    BROWSE.view = ANI.rows.filter(function (r) {
      if (y && String(r[4] || '') !== y) return false;
      if (t && r[3] !== t) return false;
      if (q && (r[1] + ' ' + (r[2] || '')).toLowerCase().indexOf(q) === -1) return false;
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
    jMS('data/library.json').then(function (d) {
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
    return jMS('data/anime.json').then(function (d) {
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
    } else {
      renderHome('week');
      $('#q').addEventListener('input', (function () {
        var t = 0;
        return function () {
          clearTimeout(t);
          var q = this.value.trim().toLowerCase();
          t = setTimeout(function () {
            if (!q) { renderHome('week'); return; }
            var hit = ANI.rows.filter(function (r) {
              return (r[1] + ' ' + (r[2] || '')).toLowerCase().indexOf(q) !== -1;
            }).slice(0, 120);
            if (!$('#home-main')) renderHome();
            $('#home-main').innerHTML = '<div class="bhead"><h2>搜索「' + esc(q) + '」</h2><span>'
              + hit.length + ' 部</span></div><div class="grid">'
              + hit.map(function (r) { return animeCard(r, { showYear: 1 }); }).join('') + '</div>';
          }, 220);
        };
      })());
    }
  }).catch(function (e) {
    $('#main').innerHTML = '<div class="loading">数据加载失败：' + esc(e.message || e) + '</div>';
  });
})();
