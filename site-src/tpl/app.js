/* 交互增强层（阶段二）
 *
 * 首屏由构建期直出的静态 DOM 承担，本脚本只做「增强」：
 *   1. 详情弹窗（懒加载数据 JSON，空闲时预取）
 *   2. 排序 / 状态筛选、周几筛选、年份切换、类型切换
 *   3. hero 轮播（自动 + 拖拽 + 圆点）
 *   4. 搜索（对已渲染卡片做过滤）
 *   5. 追番（localStorage + 可选 Gist 同步）
 *   6. 播放（B 站 iframe / YouTube 预告 / 磁力复制）
 *
 * 设计约束：任何一步失败都不能把静态页面弄坏 —— 数据没到就保留静态内容。
 */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var PAGE = document.body.dataset.page || 'home';
  var DAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  var TODAY = DAYS[new Date().getDay()];
  var FMT = { TV: 'TV', TV_SHORT: '短片', ONA: '网络放送', OVA: 'OVA',
              MOVIE: '剧场版', SPECIAL: '特别篇', MUSIC: '音乐' };
  var ST = { RELEASING: '连载中', FINISHED: '已完结',
             NOT_YET_RELEASED: '未播出', CANCELLED: '已取消' };
  var FOLLOW_KEY = 'bgm_follow_v1';
  var GIST_KEY = 'bgm_gist_cfg';

  var SORT = (function () { try { return localStorage.getItem('bgm_sort') || 'rating'; } catch (e) { return 'rating'; } })();
  var STATUS_F = '';                       // '' | RELEASING | FINISHED
  var WDFILTER = PAGE === 'home' ? TODAY : '';
  var DATA = null;
  var LOADING = null;
  var YEAR_ITEMS = null;
  var YEAR_CUR = null;
  var searchKw = '';                       // 非空 = 搜索接管结果区
  var libKind = 'all';                     // 媒体库当前 tab（恢复视图用）

  /* ---------- 基础工具 ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function countdown(ts) {
    var d = ts * 1000 - Date.now();
    if (d <= 0) return '待更新';
    var h = Math.floor(d / 3600000);
    if (h >= 24) return Math.floor(h / 24) + ' 天后更新';
    if (h >= 1) return h + ' 小时后更新';
    return Math.max(1, Math.floor(d / 60000)) + ' 分钟后更新';
  }
  function fmtSize(n) {
    n = Number(n) || 0;
    if (n <= 0) return '';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (n >= 100 ? n.toFixed(0) : n.toFixed(n >= 10 ? 1 : 2)) + u[i];
  }
  function starsHTML(rating) {
    if (!rating) return '';
    var p = Math.max(0, Math.min(10, Math.round(Number(rating))));
    return '<i class="stars" style="--p:' + p + '" title="' + Number(rating).toFixed(1) + ' 分"></i>';
  }
  function fkey(it) { return String(it.key || it.id || it.name); }

  /* ---------- 数据：空闲时预取，点开详情才有等待 ---------- */
  function fetchJSON(url, ms, extSignal) {
    var ctl = ('AbortController' in window) ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms || 8000);
    /* 外部 aborted（竞速里别的档先成功）时立刻跟随中止，省掉重复流量 */
    if (ctl && extSignal) {
      if (extSignal.aborted) ctl.abort();
      else extSignal.addEventListener('abort', function () { ctl.abort(); });
    }
    return fetch(url, ctl ? { signal: ctl.signal } : undefined)
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { clearTimeout(timer); return d; },
            function (e) { clearTimeout(timer); throw e; });
  }
  function loadData() {
    if (DATA) return Promise.resolve(DATA);
    if (LOADING) return LOADING;
    /* 数据源错峰竞速（e1d76409）：同源先发（国内最快），jsDelivr / gh-proxy 延后补位，
       谁先成功用谁，其余立即 abort。以前串行 3 档 × 8s，最坏白等 16 秒。 */
    var cands = [
      [window.DATA_LOCAL ? './' + window.DATA_LOCAL : null, 0],
      [window.DATA_URL, 250],
      [window.DATA_FB, 1200]
    ].filter(function (x) { return x[0]; });
    if (!cands.length) { LOADING = Promise.reject(new Error('无数据源')); LOADING.catch(function () {}); return LOADING; }
    var ctl = window.AbortController ? new AbortController() : null;
    LOADING = new Promise(function (resolve, reject) {
      var settled = false, pending = cands.length;
      function win(d) {
        if (settled) return;
        settled = true;
        if (ctl) ctl.abort();
        resolve(d || {});
      }
      function lose() {
        pending -= 1;
        if (pending <= 0 && !settled) { settled = true; reject(new Error('数据加载失败')); }
      }
      cands.forEach(function (c) {
        setTimeout(function () {
          if (settled) return;
          fetchJSON(c[0], 8000, ctl ? ctl.signal : null).then(win, lose);
        }, c[1]);
      });
    });
    LOADING = LOADING.then(function (d) { DATA = d; return DATA; });
    LOADING.catch(function () { LOADING = null; });
    return LOADING;
  }

  /* ---------- 卡片渲染（与 build_site.py 的静态产物保持一致） ---------- */
  function bvidOf(it) {
    var v = '';
    var bili = (DATA && DATA.bili) || {};
    var bf = (DATA && DATA.bili_fresh) || {};
    if (it.id && bili[it.id]) v = bili[it.id];
    else if (it.key && bf[it.key]) v = bf[it.key];
    if (v && typeof v === 'object') v = v.bvid || '';
    return typeof v === 'string' ? v : '';
  }
  function magnetOf(it) {
    var m = (DATA && DATA.mag) || {};
    if (it.id && m[it.id]) return m[it.id];
    if (it.key && m[it.key]) return m[it.key];
    return null;
  }
  function magnetPlay(mg) {
    if (!mg) return '';
    return 'https://keepshare.cc/gv78k1oi/' + encodeURIComponent(String(mg).split('&')[0]);
  }
  function cardHTML(it) {
    var key = esc(fkey(it));
    var poster = it.poster || '';
    var img = poster
      ? '<img src="' + esc(poster) + '" alt="" loading="lazy" decoding="async"' +
        (it.pf
          ? ' data-fb="' + esc(it.pf) + '" onerror="var q=(this.dataset.fb||\'\').split(\'|\').filter(function(s){return s});' +
            'if(q.length){this.dataset.fb=q.slice(1).join(\'|\');this.src=q[0]}else{this.remove()}">'
          : ' onerror="this.remove()">')
      : '<div class="ph">🎬</div>';
    var tags = '';
    if (it.st === 'RELEASING') tags += '<span class="tag tag-live">连载</span>';
    if (it.trailer) tags += '<span class="tag tag-trailer">预告</span>';
    if (it.episodes) tags += '<span class="tag tag-ep">' + it.episodes + ' 集</span>';
    var srcs = '';
    if (bvidOf(it)) srcs += '<span class="tag tag-bili">B站</span>';
    if (magnetOf(it)) srcs += '<span class="tag tag-mag">磁力</span>';
    var line = srcs ? '<div class="tag-line">' + srcs + '</div>' : '';

    var bits = [];
    if (it.rating) bits.push(starsHTML(it.rating) + '<b class="num">' + Number(it.rating).toFixed(1) + '</b>');
    if (it.st === 'RELEASING' && it.next_at) bits.push('<span>' + esc(countdown(it.next_at)) + '</span>');
    else if (it.wd && it.wd !== '-') bits.push('<span>' + esc(it.wd) + '</span>');
    if (it.year) bits.push('<span>' + esc(it.year) + '</span>');
    var sub = bits.join('<em class="dot">·</em>');
    var followed = isFollowed(fkey(it));

    return '<article class="card" data-key="' + key + '" data-name="' + esc(it.name) + '" ' +
      'data-r="' + (it.rating || 0) + '" data-st="' + esc(it.st || '') + '" ' +
      'data-wd="' + esc(it.wd || '') + '" data-type="' + esc(it.type || '') + '">' +
      '<div class="poster">' + img + tags + line + '</div>' +
      '<div class="card-head"><h3 class="card-title">' + esc(it.name) + '</h3>' +
      '<button class="fav' + (followed ? ' is-on' : '') + '" type="button" data-fav="' + key +
      '" aria-label="追番">' + (followed ? '★' : '☆') + '</button></div>' +
      '<div class="sub">' + sub + '</div></article>';
  }
  function renderInto(el, items) {
    if (!el) return;
    el.innerHTML = items.length ? items.map(cardHTML).join('') : '<div class="empty">没有内容</div>';
  }
  /* 折叠区按需渲染（e1d76409）：首屏只挂前 first 张，其余点「展开」再渲染。
     全部动漫 299 张 + 年份 100 张都在折叠线以下，却会在首屏就抢图片带宽。 */
  function fillCapped(el, items, first, label) {
    if (!el) return;
    var host = el.parentNode;
    var old = host && host.querySelector('.morewrap');
    if (old) old.remove();
    if (items.length <= first) { renderInto(el, items); return; }
    renderInto(el, items.slice(0, first));
    var wrap = document.createElement('div');
    wrap.className = 'morewrap';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'morebtn';
    btn.textContent = (label || '展开更多') + ' · 还有 ' + (items.length - first) + ' 部';
    btn.addEventListener('click', function () { wrap.remove(); renderInto(el, items); });
    wrap.appendChild(btn);
    if (host) host.appendChild(wrap);
  }

  /* ---------- 排序 / 筛选 ---------- */
  function srcRank(it) {
    if (magnetOf(it)) return 3;
    if (bvidOf(it)) return 2;
    if (it.netflix) return 1;
    return 0;
  }
  function sortItems(list) {
    var a = list.slice();
    var cmp;
    if (SORT === 'new') cmp = function (x, y) { return String(y.air || '').localeCompare(String(x.air || '')); };
    else if (SORT === 'name') cmp = function (x, y) { return String(x.name).localeCompare(String(y.name), 'zh'); };
    else cmp = function (x, y) { return (y.rating || 0) - (x.rating || 0); };
    a.sort(function (x, y) { var d = srcRank(y) - srcRank(x); return d || cmp(x, y); });
    return a;
  }
  function byStatus(list) {
    return STATUS_F ? list.filter(function (x) { return x.st === STATUS_F; }) : list;
  }

  function applyAll() {
    if (!DATA) return;
    fillCapped($('#g-all'), sortItems(byStatus((DATA.fresh && DATA.fresh.anime) || [])), 24, '展开全部动漫');
  }
  function applySched() {
    if (!DATA) return;
    /* 静态页只出了「构建当天」的表；JS 起效后按访问者本地星期重建 */
    var fa = (DATA.fresh && DATA.fresh.anime) || [];
    var pool = byStatus(fa).filter(function (x) { return !WDFILTER || x.wd === WDFILTER; });
    var g = $('#g-sched');
    if (!g) return;
    g.innerHTML = pool.length
      ? sortItems(pool).map(cardHTML).join('')
      : '<div class="empty">这一天没有放送</div>';
    if (searchKw) domFilter(searchKw);
    syncWd();
  }
  function applyYear(y) {
    if (!y) return;
    var g = $('#g-year');
    if (!g) return;
    g.innerHTML = '<div class="loading">' + y + ' 年加载中…</div>';
    loadYearItems(y).then(function (items) {
      fillCapped(g, sortItems(items), 24, '展开 ' + y + ' 年全部');
    }).catch(function () {
      g.innerHTML = '<div class="empty">' + y + ' 年没有数据</div>';
    });
  }
  function loadYearItems(y) {
    y = String(y);
    if (YEAR_ITEMS && YEAR_CUR === y) return Promise.resolve(YEAR_ITEMS);
    var bases = [];
    try {
      if (window.DATA_URL) bases.push(window.DATA_URL.split('/media/')[0] + '/media/years/');
      if (window.DATA_FB) bases.push(window.DATA_FB.split('/media/')[0] + '/media/years/');
    } catch (e) {}
    bases.push('./years/');
    return new Promise(function (resolve, reject) {
      (function next(i) {
        if (i >= bases.length) return reject(new Error('无年份数据'));
        fetchJSON(bases[i] + y + '.json', 10000).then(function (list) {
          if (!list || !list.length) throw new Error('empty');
          YEAR_ITEMS = list.map(nzYear);
          YEAR_CUR = y;
          resolve(YEAR_ITEMS);
        }).catch(function () { next(i + 1); });
      })(0);
    });
  }
  /* 年份目录早期用短字段名 */
  function nzYear(x) {
    if (!x || typeof x !== 'object') return x;
    if (x.name !== undefined && x.poster !== undefined) return x;
    return { key: x.key || x.k, name: x.name || x.n || '', poster: x.poster || x.img || '',
      year: x.year || x.y, rating: x.rating !== undefined ? x.rating : x.r,
      episodes: x.episodes || x.e || 0, air: x.air || '', wd: x.wd || '',
      trailer: x.trailer || null, st: x.st, fm: x.fm,
      type: x.type || (x.fm === 'MOVIE' ? 'M' : 'S'),
      url: x.url || x.u || '', banner: x.banner || '', studio: x.sd || '',
      overview: x.overview || x.v || '', genres: x.genres || x.g || [], rel: x.rel || [] };
  }

  /* ---------- 详情弹窗 ---------- */
  function findItem(key) {
    var pools = [];
    if (DATA) {
      pools.push((DATA.fresh && DATA.fresh.anime) || [],
                 (DATA.fresh && DATA.fresh.movies) || [],
                 DATA.lib || []);
    }
    if (YEAR_ITEMS) pools.push(YEAR_ITEMS);
    for (var i = 0; i < pools.length; i++) {
      for (var j = 0; j < pools[i].length; j++) {
        if (String(pools[i][j].key || pools[i][j].id) === String(key)) return pools[i][j];
      }
    }
    return null;
  }

  function openModal(it) {
    var bv = bvidOf(it);
    var mg = magnetOf(it);
    var h = '<span class="x" data-close="1">×</span><div class="mtop">' +
      '<div class="mp">' + (it.poster ? '<img src="' + esc(it.poster) + '" alt="">' : '<div class="ph">🎬</div>') + '</div>' +
      '<div class="mb"><h3>' + esc(it.name) + '</h3>';

    if (it.rating || (it.st === 'RELEASING' && it.next_at)) {
      h += '<div class="mrate">';
      if (it.rating) h += starsHTML(it.rating) + '<b class="num">' + Number(it.rating).toFixed(1) + '</b>';
      if (it.st === 'RELEASING' && it.next_at) {
        h += '<span class="pill" style="color:var(--accent)">' + esc(countdown(it.next_at)) + '</span>';
      }
      h += '</div>';
    }
    var info = [];
    if (it.wd && it.wd !== '-') info.push(['放送', it.wd]);
    if (it.air) info.push(['首播', it.air]);
    if (it.episodes) info.push(['话数', it.episodes + ' 集']);
    if (it.du) info.push(['时长', it.du + ' 分钟']);
    if (it.fm) info.push(['类型', FMT[it.fm] || it.fm]);
    if (it.st) info.push(['状态', ST[it.st] || it.st]);
    if (it.studio) info.push(['制作', it.studio]);
    if (it.year) info.push(['年份', String(it.year)]);
    if ((it.genres || []).length) info.push(['标签', (it.genres || []).join(' / ')]);
    if (info.length) {
      h += '<dl class="infobox">';
      info.forEach(function (kv) { h += '<dt>' + esc(kv[0]) + '</dt><dd>' + esc(String(kv[1])) + '</dd>'; });
      h += '</dl>';
    }
    if (it.overview) h += '<p class="plot">' + esc(it.overview) + '</p>';
    if ((it.rel || []).length) {
      h += '<div class="relbox"><div class="relhead">关联作品</div>';
      (it.rel || []).forEach(function (r) {
        if (!r || !r.n) return;
        h += '<a class="relchip" target="_blank" rel="noopener" href="' + esc(r.u || '#') + '">' + esc(r.n) +
          (r.f ? '<em>' + esc(FMT[r.f] || r.f) + '</em>' : '') + '</a>';
      });
      h += '</div>';
    }
    h += '<div class="acts">';
    if (mg) {
      h += '<span class="btn is-pri" data-magnet="' + esc(mg.m) + '">磁力</span>';
      h += '<a class="btn" target="_blank" rel="noopener" href="' + esc(magnetPlay(mg.m)) + '">在线播放</a>';
    }
    if (bv) h += '<span class="btn' + (!mg ? ' is-pri' : '') + '" data-play="' + esc(bv) + '">▶ B站播放</span>';
    if (it.trailer) h += '<span class="btn' + (!mg && !bv ? ' is-pri' : '') + '" data-trailer="' + esc(it.trailer) + '">▶ 预告</span>';
    if (it.url) h += '<a class="btn" target="_blank" rel="noopener" href="' + esc(it.url) + '">来源页</a>';
    if (it.name) h += '<a class="btn" target="_blank" rel="noopener" href="https://search.bilibili.com/all?keyword=' + encodeURIComponent(it.name) + '">B站搜索</a>';
    if (PAGE === 'library' && it.id) {
      h += '<a class="btn" target="_blank" rel="noopener" href="' + esc((window.JF || 'http://127.0.0.1:8100')) + '/web/#/details?id=' + esc(it.id) + '">Jellyfin</a>';
    }
    h += '</div>';
    if (mg && (mg.alt || []).length) {
      h += '<div class="relbox"><div class="relhead">其他磁力版本</div>';
      (mg.alt || []).forEach(function (a) {
        h += '<span class="relchip" title="' + esc(a.t || '') + '" data-magnet="' + esc(a.m) + '">' +
          esc((a.t || '').slice(0, 46)) + '<em>' +
          [fmtSize(a.s), a.sd ? a.sd + ' 种' : '', a.sub || ''].filter(Boolean).join(' · ') + '</em></span>';
      });
      h += '</div>';
    }
    h += '</div></div><div class="trailer" id="trailer"></div>';
    $('#modal').innerHTML = h;
    $('#mask').classList.add('is-on');
    document.body.style.overflow = 'hidden';
    autoPlay(it, bv);
  }

  /* 线路：时区优先（B 站 / YouTube 预告），没有 UI 开关 */
  var USE_CN = (function () {
    try {
      var tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      if (/^Asia\/(Shanghai|Chongqing|Urumqi|Harbin)$/.test(tz)) return true;
      if (tz) return false;
      return /^zh(-|$)/i.test(navigator.language || '');
    } catch (e) { return false; }
  })();

  function autoPlay(it, bv) {
    var t = $('#trailer');
    if (!t) return;
    if (USE_CN && bv) { playBili(bv, true); return; }
    if (!USE_CN && it.trailer) { playTrailer(it.trailer); return; }
    if (USE_CN && !bv) {
      t.innerHTML = '<div class="tph">国内网络无法直接播放 YouTube 预告<br>' +
        '<a class="btn is-pri" style="display:inline-block;margin-top:12px" target="_blank" rel="noopener" ' +
        'href="https://search.bilibili.com/all?keyword=' + encodeURIComponent(it.name || '') + '">在 B 站搜索</a></div>';
    }
  }

  function playerHost() {
    var t = $('#trailer');
    if (t) return t;
    var lb = $('#lightbox');
    if (!lb) {
      lb = document.createElement('div');
      lb.id = 'lightbox';
      lb.innerHTML = '<div class="lb-inner"><span class="lb-x" data-close-lb="1">×</span><div id="trailer"></div></div>';
      document.body.appendChild(lb);
      $('#' + 'trailer').style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
    }
    lb.classList.add('is-on');
    document.body.style.overflow = 'hidden';
    return $('#trailer');
  }
  function playTrailer(vid) {
    playerHost().innerHTML = '<iframe src="https://www.youtube.com/embed/' + encodeURIComponent(vid) +
      '?autoplay=1&rel=0" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>';
  }
  function playBili(bvid) {
    playerHost().innerHTML = '<iframe src="//player.bilibili.com/player.html?bvid=' + encodeURIComponent(bvid) +
      '&page=1&high_quality=1&danmaku=0&autoplay=1" allowfullscreen scrolling="no" allow="autoplay; fullscreen"></iframe>';
  }
  function closeModal() {
    $('#mask').classList.remove('is-on');
    var t = $('#trailer'); if (t) t.innerHTML = '';
    document.body.style.overflow = '';
  }
  function closeLB() {
    var lb = $('#lightbox');
    if (lb) { lb.classList.remove('is-on'); var t = $('#trailer'); if (t) t.innerHTML = ''; }
    document.body.style.overflow = '';
  }

  /* ---------- 追番 ---------- */
  function follows() {
    try { return JSON.parse(localStorage.getItem(FOLLOW_KEY) || '[]'); } catch (e) { return []; }
  }
  function saveFollows(list) {
    try { localStorage.setItem(FOLLOW_KEY, JSON.stringify(list)); } catch (e) {}
  }
  function isFollowed(k) { return follows().indexOf(String(k)) >= 0; }
  function toggleFollow(k) {
    k = String(k);
    var list = follows(), i = list.indexOf(k);
    if (i >= 0) list.splice(i, 1); else list.push(k);
    saveFollows(list);
    return i < 0;
  }
  function syncFavButtons() {
    $$('.fav').forEach(function (b) {
      var on = isFollowed(b.dataset.fav);
      b.classList.toggle('is-on', on);
      b.textContent = on ? '★' : '☆';
    });
  }
  function renderFollow() {
    if (PAGE !== 'home') return;
    var list = follows();
    var box = $('#myfollow');
    var all = [];
    if (DATA) {
      all = ((DATA.fresh && DATA.fresh.anime) || []).concat((DATA.fresh && DATA.fresh.movies) || [], DATA.lib || []);
    }
    var items = all.filter(function (x) { return isFollowed(fkey(x)); });
    if (!items.length) { if (box) box.remove(); return; }
    if (!box) {
      box = document.createElement('section');
      box.className = 'sect';
      box.id = 'myfollow';
      var anchor = $('#fbar');
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(box, anchor);
      else $('#main').appendChild(box);
    }
    box.innerHTML = '<div class="sect-head"><h2>我的追番</h2><span class="hint">' + items.length + ' 部</span>' +
      '<span class="spacer"><span class="syncbar">' +
      '<a data-act="push">同步 Gist</a><a data-act="pull">恢复</a>' +
      '<a data-act="export">导出</a><a data-act="import">导入</a></span></span></div>' +
      '<div class="row" id="r-follow">' + (items.length ? items.map(cardHTML).join('') : '') + '</div>';
  }

  function gistCfg() { try { return JSON.parse(localStorage.getItem(GIST_KEY) || '{}'); } catch (e) { return {}; } }
  function pushGist() {
    var cfg = gistCfg();
    if (!cfg.token) { alert('先在「追番同步」里填 GitHub Token（只存在本机浏览器）'); return; }
    var body = { description: '番组计划 · 我的追番', public: true,
      files: { 'bgm-follow.json': { content: JSON.stringify({ updated: new Date().toISOString(), list: follows() }, null, 1) } } };
    var url = cfg.gistId ? 'https://api.github.com/gists/' + cfg.gistId : 'https://api.github.com/gists';
    fetch(url, { method: cfg.gistId ? 'PATCH' : 'POST',
      headers: { Authorization: 'token ' + cfg.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.id) { cfg.gistId = d.id; localStorage.setItem(GIST_KEY, JSON.stringify(cfg)); alert('已同步到 Gist：' + d.html_url); }
        else alert('同步失败：' + (d.message || '未知错误'));
      }).catch(function (e) { alert('同步失败：' + e.message); });
  }
  function pullGist() {
    var cfg = gistCfg();
    if (!cfg.token || !cfg.gistId) { alert('先填 Token 并推送一次，才能拉取'); return; }
    fetch('https://api.github.com/gists/' + cfg.gistId, { headers: { Authorization: 'token ' + cfg.token } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var f = (d.files || {})['bgm-follow.json'];
        if (!f) return alert('Gist 里没有 bgm-follow.json');
        var data = JSON.parse(f.content || '{}');
        saveFollows((data.list || []).map(String));
        alert('已从 Gist 恢复 ' + (data.list || []).length + ' 条追番');
        location.reload();
      }).catch(function (e) { alert('拉取失败：' + e.message); });
  }
  function exportFollows() {
    var blob = new Blob([JSON.stringify({ list: follows() }, null, 1)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'bgm-follow.json'; a.click();
  }
  function importFollows() {
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json';
    inp.onchange = function () {
      var f = inp.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        try {
          var d = JSON.parse(rd.result);
          saveFollows((d.list || d || []).map(String));
          alert('已导入 ' + follows().length + ' 条');
          location.reload();
        } catch (e) { alert('文件格式不对'); }
      };
      rd.readAsText(f);
    };
    inp.click();
  }

  /* ---------- hero 轮播 ---------- */
  var heroTimer = null, heroIdx = 0, heroN = 0;
  function showSlide(n) {
    if (!heroN) return;
    heroIdx = (n + heroN) % heroN;
    $$('#hero .slide').forEach(function (el, i) {
      var on = i === heroIdx;
      el.classList.toggle('is-on', on);
      if (on) {
        var bg = el.querySelector('.hero-bg');
        if (bg && !bg.style.backgroundImage && bg.dataset.bg) {
          bg.style.backgroundImage = 'url("' + bg.dataset.bg + '")';
        }
      }
    });
    $$('#hero .dots i').forEach(function (el, i) { el.classList.toggle('is-on', i === heroIdx); });
  }
  function restartHero() {
    clearInterval(heroTimer);
    if (heroN > 1) heroTimer = setInterval(function () { showSlide(heroIdx + 1); }, 6000);
  }
  function bindHero() {
    var hero = $('#hero');
    if (!hero) return;
    heroN = $$('#hero .slide').length;
    if (heroN < 2) return;
    restartHero();
    $$('#hero .dots i').forEach(function (d) {
      d.addEventListener('click', function () { showSlide(+d.dataset.dot); restartHero(); });
    });
    var x0 = null;
    hero.addEventListener('pointerdown', function (e) { x0 = e.clientX; hero.classList.add('grab'); });
    hero.addEventListener('pointerup', function (e) {
      hero.classList.remove('grab');
      if (x0 === null) return;
      var dx = e.clientX - x0; x0 = null;
      if (Math.abs(dx) > 60) { showSlide(heroIdx + (dx < 0 ? 1 : -1)); restartHero(); }
    });
    hero.addEventListener('pointerleave', function () { x0 = null; hero.classList.remove('grab'); });
    hero.addEventListener('mouseenter', function () { clearInterval(heroTimer); });
    hero.addEventListener('mouseleave', restartHero);
  }

  /* ---------- 筛选条 / tab ---------- */
  function renderFilterBar() {
    var bar = $('#fbar');
    if (!bar) return;
    $$('.chip', bar).forEach(function (el) {
      var t = el.textContent.trim();
      var on = (t === '评分' && SORT === 'rating') || (t === '最新' && SORT === 'new') ||
               (t === '名称' && SORT === 'name') || (t === '全部状态' && !STATUS_F) ||
               (t === '连载中' && STATUS_F === 'RELEASING') || (t === '已完结' && STATUS_F === 'FINISHED');
      el.classList.toggle('is-on', on);
    });
  }
  function bindChips() {
    var bar = $('#fbar');
    if (!bar) return;
    bar.addEventListener('click', function (e) {
      var el = e.target.closest('.chip');
      if (!el) return;
      var t = el.textContent.trim();
      if (t === '评分' || t === '最新' || t === '名称') {
        SORT = t === '评分' ? 'rating' : t === '最新' ? 'new' : 'name';
        try { localStorage.setItem('bgm_sort', SORT); } catch (e2) {}
      } else if (t === '全部状态') STATUS_F = '';
      else if (t === '连载中') STATUS_F = 'RELEASING';
      else if (t === '已完结') STATUS_F = 'FINISHED';
      renderFilterBar();
      if (searchKw) runSearch(searchKw);
      else { applyAll(); applySched(); }
    });
  }
  function syncWd() {
    $$('#wdbar .tab').forEach(function (el) {
      var label = el.textContent.trim().split(/\s+/)[0];
      el.classList.toggle('is-on', WDFILTER ? label === WDFILTER : label === '全部');
    });
  }
  function bindWd() {
    var bar = $('#wdbar');
    if (!bar) return;
    bar.addEventListener('click', function (e) {
      var el = e.target.closest('.tab');
      if (!el) return;
      var label = el.textContent.trim().split(/\s+/)[0];
      WDFILTER = label === '全部' ? '' : label;
      applySched();
    });
  }
  function bindType() {
    var bar = $('#typebar');
    if (!bar) return;
    bar.addEventListener('click', function (e) {
      var el = e.target.closest('.tab');
      if (!el || !DATA) return;
      var label = el.textContent.trim().split(/\s+/)[0];
      $$('.tab', bar).forEach(function (x) { x.classList.toggle('is-on', x === el); });
      var lib = DATA.lib || [];
      libKind = label === '番剧' ? 'S' : label === '电影' ? 'M' : 'all';
      if (searchKw) { runSearch(searchKw); return; }
      var list = libKind === 'S' ? lib.filter(function (x) { return x.type === 'S'; })
        : libKind === 'M' ? lib.filter(function (x) { return x.type !== 'S'; }) : lib;
      renderInto($('#g'), sortItems(list));
    });
  }
  function bindYear() {
    var sel = $('#ysel');
    if (!sel) return;
    sel.addEventListener('change', function () { applyYear(sel.value); });
  }

  /* ---------- 搜索 ----------
     折叠渲染（fillCapped）之后，未渲染的卡片不在这个 DOM 里，纯 DOM 过滤会漏。
     所以有数据时搜索改为「接管结果区」：从 DATA 池全量检索后整列渲染；
     清空关键词恢复折叠视图。 */
  function domFilter(kw) {
    $$('#main .card').forEach(function (c) {
      var hit = !kw || (c.dataset.name || '').toLowerCase().indexOf(kw) >= 0;
      c.classList.toggle('is-hidden', !hit);
    });
  }
  function restoreViews() {
    $$('#main .card').forEach(function (c) { c.classList.remove('is-hidden'); });
    if (PAGE === 'home' && DATA) applyAll();
    else if (PAGE === 'library' && DATA) {
      var lib = DATA.lib || [];
      var list = libKind === 'S' ? lib.filter(function (x) { return x.type === 'S'; })
        : libKind === 'M' ? lib.filter(function (x) { return x.type !== 'S'; }) : lib;
      renderInto($('#g'), sortItems(list));
    }
  }
  function runSearch(rawKw) {
    var kw = rawKw.trim().toLowerCase();
    searchKw = kw;
    if (!kw) { restoreViews(); return; }
    var pools = [];
    if (DATA) {
      if (PAGE === 'home') pools.push((DATA.fresh && DATA.fresh.anime) || []);
      else pools.push(DATA.lib || []);
    }
    if (YEAR_ITEMS) pools.push(YEAR_ITEMS);
    var target = PAGE === 'home' ? $('#g-all') : $('#g');
    if (target && pools.length) {
      var seen = {}, matches = [];
      pools.forEach(function (pool) {
        pool.forEach(function (it) {
          var k = String(it.key || it.id || it.name);
          if (seen[k]) return;
          if (String(it.name || '').toLowerCase().indexOf(kw) >= 0) { seen[k] = 1; matches.push(it); }
        });
      });
      var host = target.parentNode;
      var old = host && host.querySelector('.morewrap');
      if (old) old.remove();
      renderInto(target, sortItems(matches));
    }
    /* 其余区块（番剧表/近期更新/热门/年份）保持 DOM 过滤 */
    domFilter(kw);
  }
  function bindSearch() {
    var q = $('#q');
    if (!q) return;
    var timer = null;
    q.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () { runSearch(q.value); }, 120);
    });
  }

  /* ---------- 全局事件委托 ---------- */
  function bindGlobal() {
    document.addEventListener('click', function (e) {
      var t = e.target;

      if (t.closest('[data-close]') || t.id === 'mask') { closeModal(); return; }
      if (t.closest('[data-close-lb]') || t.id === 'lightbox') { closeLB(); return; }

      var fav = t.closest('.fav');
      if (fav) {
        e.preventDefault();
        var k = fav.dataset.fav;
        toggleFollow(k);
        syncFavButtons();
        renderFollow();
        return;
      }
      var mg = t.closest('[data-magnet]');
      if (mg) {
        copyMagnet(mg.dataset.magnet, mg);
        return;
      }
      var pb = t.closest('[data-play]');
      if (pb) { playBili(pb.dataset.play); return; }
      var tr = t.closest('[data-trailer]');
      if (tr) { playTrailer(tr.dataset.trailer); return; }

      var card = t.closest('.card');
      if (card) {
        openByKey(card.dataset.key, card);
        return;
      }
      var opener = t.closest('[data-open]');
      if (opener) {
        openByKey(opener.dataset.open);
        return;
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeModal(); closeLB(); }
    });

    window.addEventListener('scroll', function () {
      var h = $('#topbar');
      if (h) h.classList.toggle('is-solid', window.scrollY > 8);
    }, { passive: true });
  }

  function openByKey(key, el) {
    if (!key) return;
    var it = findItem(key);
    if (it) { openModal(it); return; }
    /* 年份条目只有在拉过那一年的 JSON 后才存在；静态年份格里点开时要按需加载 */
    var inYear = el && el.closest && el.closest('#g-year');
    var y = inYear && $('#ysel') ? $('#ysel').value : '';
    var p = y ? loadYearItems(y) : loadData();
    p.then(function () {
      var x = findItem(key);
      if (x) openModal(x);
    }).catch(function () {});
  }

  function copyMagnet(mg, el) {
    var done = function (txt) {
      var old = el.textContent;
      el.textContent = txt;
      setTimeout(function () { el.textContent = old; }, 1600);
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(mg).then(function () { done('已复制'); }, function () { done('复制失败'); });
      } else {
        var ta = document.createElement('textarea');
        ta.value = mg; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta); done('已复制');
      }
    } catch (e) { done('复制失败'); }
  }

  /* ---------- 启动 ---------- */
  function boot() {
    bindGlobal();
    bindChips();
    bindWd();
    bindType();
    bindYear();
    bindSearch();
    bindHero();
    renderFilterBar();
    syncFavButtons();

    /* 海报缓存层：ModelScope 的 302 与最终响应都没有 Cache-Control、签名 URL 每次还变，
       不缓存的话每次开页都要重下全部可见海报。sw.js 按请求 URL 缓存图片字节一年。 */
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('/sw.js').catch(function () {});
    }

    /* 静态页的番剧表是「构建当天」的；访问者时区不同就第一次纠正 */
    var firstTab = $('#wdbar .tab.is-on');
    if (firstTab) {
      var label = firstTab.textContent.trim().split(/\s+/)[0];
      if (label !== TODAY && PAGE === 'home') { WDFILTER = TODAY; }
    }
    syncWd();

    /* 空闲时预取数据：点卡片就不用等 */
    var later = window.requestIdleCallback || function (fn) { return setTimeout(fn, 400); };
    later(function () {
      loadData().then(function () {
        renderFilterBar();
        syncFavButtons();
        renderFollow();
        applyAll();
        applySched();
        /* 年份网格保持构建期直出的那一份：只有用户改下拉时才重新拉 */
      }).catch(function () {});
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
