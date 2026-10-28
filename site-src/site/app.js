/* 共用交互：首页与媒体库页都加载这一份（由 _headers 长缓存） */
(function () {
  'use strict';
  var DATA = window.DATA || {};
  var $ = function (s) { return document.querySelector(s); };
  var PAGE = document.body.dataset.page || 'home';
  var DAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  var TODAY = DAYS[new Date().getDay()];
  var WDFILTER = PAGE === 'home' ? TODAY : '';
  var ALL = [];
  var ROW_CAP = 24;   // 轨道只渲前 24 张：一次挂 300+ 张远程海报会被 CDN 限流


  var FMT = { TV: 'TV', TV_SHORT: '短片', ONA: '网络放送', OVA: 'OVA', MOVIE: '剧场版',
              SPECIAL: '特别篇', MUSIC: '音乐' };
  var ST = { RELEASING: '连载中', FINISHED: '已完结', NOT_YET_RELEASED: '未播出', CANCELLED: '已取消' };

  function countdown(ts) {
    var d = ts * 1000 - Date.now();
    if (d <= 0) return '待更新';
    var h = Math.floor(d / 3600000);
    if (h >= 24) return Math.floor(h / 24) + ' 天后更新';
    if (h >= 1) return h + ' 小时后更新';
    return Math.max(1, Math.floor(d / 60000)) + ' 分钟后更新';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function imgHTML(it, cls) {
    if (!it.poster) return '<div class="' + (cls || 'ph') + '">🎬</div>';
    var fb = it.pf ? ' data-fb="' + esc(it.pf) + '" onerror="__fb(this)"' : '';
    return '<img class="' + (cls || '') + '" src="' + esc(it.poster) + '"' + fb
      + ' loading="lazy" decoding="async" alt="">';
  }

  /* 海报三级回退：jsDelivr → gh-proxy → 同源 Pages（顺序写在 data-fb 里，用 | 分隔） */
  window.__fb = function (img) {
    var q = (img.dataset.fb || '').split('|').filter(Boolean);
    if (!q.length) { img.onerror = null; return; }
    img.src = q.shift();
    img.dataset.fb = q.join('|');
  };

  function bvidOf(it) {
    if (!it.id || !DATA.bili) return '';
    return DATA.bili[it.id] || '';
  }

  function cardHTML(it) {
    var bv = bvidOf(it);
    var html = '<div class="card" data-key="' + esc(it.key || it.id || it.name) + '">';
    html += '<div class="pw">' + imgHTML(it)
      + (it.rating ? '<span class="rate">★ ' + it.rating.toFixed(1) + '</span>' : '')
      + (it.episodes ? '<span class="ep">' + it.episodes + ' 集</span>' : '')
      + (bv ? '<span class="bili">B站</span>' : '')
      + (it.trailer ? '<span class="trailer-mark">预告</span>' : '')
      + (it.st === 'RELEASING' ? '<span class="ep" style="left:8px;right:auto;bottom:auto;top:8px;background:rgba(240,145,153,.92);color:#181820">连载</span>' : '')
      + '</div>';
    html += '<div class="t">' + esc(it.name) + '</div>';
    var sub = [];
    if (it.st === 'RELEASING' && it.next_at) sub.push(countdown(it.next_at));
    else if (it.type === 'S' && it.wd && it.wd !== '-') sub.push(it.wd);
    if (it.year) sub.push(it.year);
    if (it.air) sub.push(it.air.slice(5));
    html += '<div class="sub2">' + sub.filter(Boolean).map(esc).join(' · ') + '</div>';
    return html + '</div>';
  }

  function bindCards(root) {
    root.querySelectorAll('.card').forEach(function (el) {
      el.onclick = function () {
        var k = el.dataset.key;
        var it = ALL.find(function (x) { return String(x.key || x.id || x.name) === k; });
        if (it) openModal(it);
      };
    });
  }

  function fill(el, items, chunk) {
    if (!el) return;
    el.innerHTML = '';
    ALL = ALL.concat(items);
    var i = 0;
    (function step() {
      var end = Math.min(i + (chunk || 40), items.length);
      var html = '';
      for (; i < end; i++) html += cardHTML(items[i]);
      el.insertAdjacentHTML('beforeend', html);
      bindCards(el);
      if (i < items.length) requestAnimationFrame(step);
    })();
  }

  /* ---------- 弹窗 ---------- */
  function openModal(it) {
    var isFresh = it.kind === 'fresh';
    var bv = bvidOf(it);
    var h = '<span class="x" onclick="closeM()">×</span><div class="mtop">'
      + '<div class="mp">' + imgHTML(it, '') + '</div><div class="mb">';
    h += '<h3>' + esc(it.name) + '</h3><div class="meta">';
    if (it.rating) h += '<span class="pill" style="color:var(--star)">★ ' + it.rating.toFixed(1) + '</span>';
    if (it.year) h += '<span class="pill">' + esc(it.year) + '</span>';
    if (it.episodes) h += '<span class="pill">' + it.episodes + ' 集</span>';
    if (it.wd && it.wd !== '-') h += '<span class="pill">' + esc(it.wd) + '</span>';
    if (it.air) h += '<span class="pill">' + esc(it.air) + '</span>';
    if (it.st) h += '<span class="pill" style="color:var(--accent)">' + esc(ST[it.st] || it.st) + '</span>';
    if (it.fm) h += '<span class="pill">' + esc(FMT[it.fm] || it.fm) + '</span>';
    if (it.du) h += '<span class="pill">' + it.du + ' 分钟</span>';
    if (it.studio) h += '<span class="pill">' + esc(it.studio) + '</span>';
    if (it.st === 'RELEASING' && it.next_at) h += '<span class="pill" style="color:var(--star)">' + countdown(it.next_at) + '</span>';
    (it.genres || []).slice(0, 4).forEach(function (g) { h += '<span class="pill">' + esc(g) + '</span>'; });
    h += '</div>';
    if (it.overview) h += '<p class="plot">' + esc(it.overview) + '</p>';
    if ((it.rel || []).length) {
      h += '<div class="relbox"><div class="relhead">关联作品</div>';
      (it.rel || []).forEach(function (r) {
        if (!r || !r.n) return;
        h += '<a class="relchip" target="_blank" rel="noopener" href="' + esc(r.u || '#') + '">'
          + esc(r.n) + (r.f ? '<em>' + esc(FMT[r.f] || r.f) + '</em>' : '') + '</a>';
      });
      h += '</div>';
    }
    h += '<div class="acts">';
    if (bv) h += '<span class="btn pri" onclick="playBili(\'' + esc(bv) + '\')">▶ B站播放</span>';
    if (it.trailer) h += '<span class="btn' + (bv ? '' : ' pri') + '" onclick="playTrailer(\'' + esc(it.trailer) + '\')">▶ 预告</span>';
    if (!isFresh && it.id) h += '<a class="btn" target="_blank" rel="noopener" href="' + esc((window.JF || 'http://127.0.0.1:8100')) + '/web/#/details?id=' + esc(it.id) + '">Jellyfin</a>';
    if (it.url) h += '<a class="btn" target="_blank" rel="noopener" href="' + esc(it.url) + '">来源页</a>';
    if (it.name) h += '<a class="btn" target="_blank" rel="noopener" href="https://search.bilibili.com/all?keyword=' + encodeURIComponent(it.name) + '">B站搜索</a>';
    h += '</div></div></div><div class="trailer" id="trailer"></div>';
    $('#modal').innerHTML = h;
    $('#mask').classList.add('on');
    document.body.style.overflow = 'hidden';
    if (it.trailer) playTrailer(it.trailer);
  }

  function playTrailer(vid) {
    $('#trailer').innerHTML = '<iframe src="https://www.youtube.com/embed/' + encodeURIComponent(vid)
      + '?autoplay=1&rel=0" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>';
  }

  function playBili(bvid) {
    $('#trailer').innerHTML = '<iframe src="//player.bilibili.com/player.html?bvid=' + encodeURIComponent(bvid)
      + '&page=1&high_quality=1&danmaku=0&autoplay=0" allowfullscreen scrolling="no"></iframe>';
  }

  function closeM() {
    $('#mask').classList.remove('on');
    $('#trailer').innerHTML = '';
    document.body.style.overflow = '';
  }

  /* ---------- 首页 ---------- */
  function renderHome() {
    var fa = (DATA.fresh && DATA.fresh.anime) || [];
    var fm = (DATA.fresh && DATA.fresh.movies) || [];
    var hero = fa.find(function (x) { return x.banner; }) || fa[0] || null;
    var out = '';
    if (hero) {
      out += '<section class="hero"><div class="hero-bg" style="background-image:url(\'' + esc(hero.banner || hero.poster || '') + '\')"></div>'
        + '<div class="hero-info"><div class="hero-tag">本季新番 · ' + esc((DATA.fresh.season || '').split(' ')[0] || '') + '</div>'
        + '<h1>' + esc(hero.name) + '</h1><div class="hero-meta">';
      if (hero.rating) out += '<span><b>★ ' + hero.rating.toFixed(1) + '</b></span>';
      if (hero.episodes) out += '<span>' + hero.episodes + ' 集</span>';
      if (hero.air) out += '<span>' + esc(hero.air) + '</span>';
      if (hero.next_ep) out += '<span>下一话 第 ' + hero.next_ep + ' 集</span>';
      out += '</div><p>' + esc((hero.overview || '').slice(0, 200)) + '</p><div class="hero-btns">';
      if (hero.trailer) out += '<span class="hbtn primary" onclick="playTrailer(\'' + esc(hero.trailer) + '\')">▶ 播放预告</span>';
      out += '<span class="hbtn ghost" onclick="document.getElementById(\'sched\').scrollIntoView({behavior:\'smooth\'})">番剧表</span>';
      out += '</div></div></section>';
    }

    out += '<section class="block" id="sched"><div class="bhead"><h2>番剧表</h2><span>按放送日筛选</span></div>'
      + '<div class="wdbar" id="wdbar"></div><div class="grid" id="g-sched"></div></section>';
    out += '<section class="block"><div class="bhead"><h2>本季新番</h2><span>' + fa.length + ' 部</span></div><div class="row" id="r-anime"></div></section>';
    out += '<section class="block"><div class="bhead"><h2>新片</h2><span>' + fm.length + ' 部</span></div><div class="row" id="r-movie"></div></section>';

    $('#main').innerHTML = out;
    ALL = [];
    fill($('#r-anime'), fa.slice(0, ROW_CAP), ROW_CAP);
    fill($('#r-movie'), fm.slice(0, ROW_CAP), ROW_CAP);

    var days = ['全部'].concat(DAYS.slice(1), DAYS.slice(0, 1));
    var bar = $('#wdbar');
    days.forEach(function (d) {
      var n = d === '全部' ? fa.length : fa.filter(function (x) { return x.wd === d; }).length;
      var el = document.createElement('span');
      el.className = 'wd-tab' + ((d === '全部' && !WDFILTER) || d === WDFILTER ? ' on' : '');
      el.textContent = d + ' ' + n;
      el.onclick = function () { WDFILTER = d === '全部' ? '' : d; renderSched(fa); syncWd(); };
      bar.appendChild(el);
    });
    renderSched(fa);
    setCnt(fa.length + fm.length);
  }

  function syncWd() {
    document.querySelectorAll('#wdbar .wd-tab').forEach(function (el) {
      var label = el.textContent.split(' ')[0];
      el.classList.toggle('on', WDFILTER ? label === WDFILTER : label === '全部');
    });
  }

  function renderSched(fa) {
    var list = WDFILTER ? fa.filter(function (x) { return x.wd === WDFILTER; }) : fa;
    var g = $('#g-sched');
    g.innerHTML = '';
    ALL = ALL.filter(function (x) { return x.kind !== 'fresh' || x.type !== 'S' || !x._sched; });
    list.forEach(function (x) { x._sched = true; });
    fill(g, list, 30);
    if (!list.length) g.innerHTML = '<div class="empty">这一天没有放送</div>';
  }

  /* ---------- 媒体库 ---------- */
  function renderLibrary() {
    var lib = DATA.lib || [];
    var series = lib.filter(function (x) { return x.type === 'S'; });
    var movies = lib.filter(function (x) { return x.type !== 'S'; });
    var out = '<section class="block"><div class="bhead"><h2>我的媒体库</h2><span>番剧 ' + series.length + ' · 电影 ' + movies.length + '</span></div>'
      + '<div class="tabs" id="typebar"></div><div class="grid" id="g"></div></section>';
    $('#main').innerHTML = out;
    ALL = [];
    setCnt(lib.length);
    renderType('all', lib);
  }

  function renderType(kind, lib) {
    lib = lib || (DATA.lib || []);
    var list = kind === 'S' ? lib.filter(function (x) { return x.type === 'S'; })
      : kind === 'M' ? lib.filter(function (x) { return x.type !== 'S'; }) : lib;
    var bar = $('#typebar');
    if (bar && !bar.dataset.built) {
      bar.dataset.built = '1';
      [['all', '全部'], ['S', '番剧'], ['M', '电影']].forEach(function (p) {
        var el = document.createElement('span');
        el.className = 'wd-tab' + (p[0] === kind ? ' on' : '');
        el.textContent = p[1];
        el.onclick = function () {
          bar.querySelectorAll('.wd-tab').forEach(function (x) { x.classList.remove('on'); });
          el.classList.add('on');
          ALL = [];
          renderType(p[0], lib);
        };
        bar.appendChild(el);
      });
    }
    fill($('#g'), list, 60);
    if (!list.length) $('#g').innerHTML = '<div class="empty">没有内容</div>';
  }

  /* ---------- 搜索 ---------- */
  function bindSearch() {
    var q = $('#q');
    if (!q) return;
    q.oninput = function () {
      var kw = q.value.trim().toLowerCase();
      if (!kw) { PAGE === 'home' ? renderHome() : renderLibrary(); return; }
      var pool = PAGE === 'home'
        ? [].concat((DATA.fresh && DATA.fresh.anime) || [], (DATA.fresh && DATA.fresh.movies) || [])
        : (DATA.lib || []);
      var hits = pool.filter(function (x) { return (x.name || '').toLowerCase().indexOf(kw) >= 0; });
      ALL = [];
      var host = PAGE === 'home' ? $('#g-sched') : $('#g');
      if (!host) return;
      host.innerHTML = '';
      fill(host, hits, 60);
      if (!hits.length) host.innerHTML = '<div class="empty">没有匹配</div>';
      setCnt(hits.length);
    };
  }

  function setCnt(n) {
    var el = $('#cnt');
    if (el) el.textContent = n + ' 部';
  }

  /* ---------- 启动 ---------- */
  window.openModal = openModal;
  window.closeM = closeM;
  window.playTrailer = playTrailer;
  window.playBili = playBili;

  document.addEventListener('DOMContentLoaded', function () {
    window.JF = window.JF || 'http://127.0.0.1:8100';
    $('#mask').onclick = function (e) { if (e.target.id === 'mask') closeM(); };
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeM(); });
    var top = $('#topbar');
    window.addEventListener('scroll', function () {
      top.classList.toggle('solid', window.scrollY > 12);
    }, { passive: true });
    bindSearch();
    if (PAGE === 'home') renderHome(); else renderLibrary();
  });
})();
