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
  var SORT = (function(){ try { return localStorage.getItem('bgm_sort') || 'rating'; } catch(e){ return 'rating'; } })();
  var STATUS_F = '';   // '' | RELEASING | FINISHED
  function bySort(list) {
    var a = list.slice();
    var cmp = null;
    if (SORT === 'rating') cmp = function (x, y) { return (y.rating || 0) - (x.rating || 0); };
    else if (SORT === 'new') cmp = function (x, y) { return String(y.air || '').localeCompare(String(x.air || '')); };
    else if (SORT === 'name') cmp = function (x, y) { return String(x.name).localeCompare(String(y.name), 'zh'); };
    /* 播放源优先级：磁力(3) > B 站(2) > 奈飞(1) > 无(0)。
       有磁力的排前面，其次才是能直接播的；同档内沿用原来的评分/时间/名称排序。
       Array.sort 在现代浏览器是稳定排序，同档同值会保持原有相对顺序。 */
    var rank = function (x) {
      if (magnetOf(x)) return 3;
      if (bvidOf(x)) return 2;
      if (x.netflix) return 1;
      return 0;
    };
    a.sort(function (x, y) {
      var d = rank(y) - rank(x);
      if (d) return d;
      return cmp ? cmp(x, y) : 0;
    });
    return a;
  }
  function byStatus(list) {
    return STATUS_F ? list.filter(function (x) { return x.st === STATUS_F; }) : list;
  }
  var ROW_CAP = 24;   // 轨道只渲前 24 张：一次挂 300+ 张远程海报会被 CDN 限流

  /* 区域：/cdn-cgi/trace 在 Pages 上不给 loc，只能用客户端信号。
     时区优先（VPN 下比语言准），语言兜底。 */
  var REGION_AUTO = (function () {
    try {
      var tz = (Intl.DateTimeFormat().resolvedOptions().timeZone || '');
      if (/^Asia\/(Shanghai|Chongqing|Urumqi|Harbin)$/.test(tz)) return true;
      if (tz) return false;
      return /^zh(-|$)/i.test(navigator.language || '');
    } catch (e) { return false; }
  })();
  var RMODE = (function () { try { return localStorage.getItem('bgm_region') || 'auto'; } catch (e) { return 'auto'; } })();
  function useCN() { return RMODE === 'cn' ? true : RMODE === 'intl' ? false : REGION_AUTO; }
  function setRegion(mode) {
    RMODE = mode;
    try { localStorage.setItem('bgm_region', mode); } catch (e) {}
    renderRegionSwitch();
    if (PAGE === 'home') renderHome(); else renderLibrary();
  }
  function renderRegionSwitch() {
    var box = $('#regionsw');
    if (!box) return;
    box.innerHTML = '<span style="opacity:.7">线路</span>';
    [['auto', '自动'], ['cn', '国内'], ['intl', '海外']].forEach(function (p) {
      var el = document.createElement('span');
      el.className = 'r' + (RMODE === p[0] ? ' on' : '');
      el.textContent = p[1];
      el.onclick = function (e) { e.stopPropagation(); setRegion(p[0]); };
      box.appendChild(el);
    });
    var hint = document.createElement('span');
    hint.style.cssText = 'opacity:.55;font-size:11px';
    hint.textContent = '（' + (useCN() ? 'B 站' : '预告') + '）';
    box.appendChild(hint);
  }

  /* ---------- 追番（本地 + GitHub Gist 可选同步） ---------- */
  var FOLLOW_KEY = 'bgm_follow_v1', GIST_KEY = 'bgm_gist_cfg';
  function follows() {
    try { return JSON.parse(localStorage.getItem(FOLLOW_KEY) || '[]'); } catch (e) { return []; }
  }
  function saveFollows(list) {
    localStorage.setItem(FOLLOW_KEY, JSON.stringify(list));
    document.dispatchEvent(new CustomEvent('follow-change'));
  }
  function fkey(it) { return String(it.key || it.id || it.name); }
  function isFollowed(k) { return follows().indexOf(k) >= 0; }
  function toggleFollow(k) {
    var list = follows(), i = list.indexOf(k);
    if (i >= 0) list.splice(i, 1); else list.push(k);
    saveFollows(list);
    return i < 0;
  }
  function gistCfg() {
    try { return JSON.parse(localStorage.getItem(GIST_KEY) || '{}'); } catch (e) { return {}; }
  }
  function pushGist() {
    var cfg = gistCfg();
    if (!cfg.token) { alert('先在「追番同步」里填 GitHub Token（只存在本机浏览器）'); return; }
    var body = {
      description: '番组计划 · 我的追番',
      public: true,
      files: { 'bgm-follow.json': { content: JSON.stringify({ updated: new Date().toISOString(), list: follows() }, null, 1) } }
    };
    var url = cfg.gistId ? 'https://api.github.com/gists/' + cfg.gistId : 'https://api.github.com/gists';
    fetch(url, {
      method: cfg.gistId ? 'PATCH' : 'POST',
      headers: { 'Authorization': 'token ' + cfg.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.id) { cfg.gistId = d.id; localStorage.setItem(GIST_KEY, JSON.stringify(cfg)); alert('已同步到 Gist：' + d.html_url); }
      else alert('同步失败：' + (d.message || '未知错误'));
    }).catch(function (e) { alert('同步失败：' + e.message); });
  }
  function pullGist() {
    var cfg = gistCfg();
    if (!cfg.token || !cfg.gistId) { alert('先填 Token 并推送一次，才能拉取'); return; }
    fetch('https://api.github.com/gists/' + cfg.gistId, { headers: { 'Authorization': 'token ' + cfg.token } })
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
    var inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json';
    inp.onchange = function () {
      var f = inp.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        try {
          var d = JSON.parse(rd.result);
          saveFollows(((d.list || d || [])).map(String));
          alert('已导入 ' + follows().length + ' 条'); location.reload();
        } catch (e) { alert('文件格式不对'); }
      };
      rd.readAsText(f);
    };
    inp.click();
  }


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
    var v = '';
    if (it.id && DATA.bili && DATA.bili[it.id]) v = DATA.bili[it.id];
    else if (it.key && DATA.bili_fresh && DATA.bili_fresh[it.key]) v = DATA.bili_fresh[it.key];
    /* 媒体库里 bili 有两种形态：纯 bvid 字符串，或 {bvid,title,play,duration,score} 对象。
       以前直接把对象塞进 encodeURIComponent，会变成 %5Bobject%20Object%5D，
   	   导致那 156 条的「B站播放」实际是坏的。 */
    if (v && typeof v === 'object') v = v.bvid || '';
    return typeof v === 'string' ? v : '';
  }

  function magnetOf(it) {
    var m = DATA.mag || {};
    if (it.id && m[it.id]) return m[it.id];
    if (it.key && m[it.key]) return m[it.key];
    return null;
  }

  /* 磁力 → 网页播放地址（第三方 KeepShare，纯 URL 拼接，不上传任何东西） */
  function magnetPlay(mg) {
    if (!mg) return '';
    return 'https://keepshare.cc/gv78k1oi/' + encodeURIComponent(String(mg).split('&')[0]);
  }

  function fmtSize(n) {
    n = Number(n) || 0;
    if (n <= 0) return '';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (n >= 100 ? n.toFixed(0) : n.toFixed(n >= 10 ? 1 : 2)) + u[i];
  }

  window.__magnet = function (mg, el) {
    var done = function (okTxt) { if (el) { el.textContent = okTxt; setTimeout(function () { el.textContent = '磁力'; }, 1600); } };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(mg).then(function () { done('已复制'); }, function () { done('复制失败'); });
      } else {
        var t = document.createElement('textarea');
        t.value = mg; document.body.appendChild(t); t.select();
        document.execCommand('copy'); document.body.removeChild(t); done('已复制');
      }
    } catch (e) { done('复制失败'); }
  };

  function cardHTML(it) {
    var bv = bvidOf(it);
    var mg = magnetOf(it);
    var html = '<div class="card" data-key="' + esc(it.key || it.id || it.name) + '">';
    html += '<div class="pw">' + imgHTML(it)
      + (it.rating ? '<span class="rate">★ ' + it.rating.toFixed(1) + '</span>' : '')
      + (it.episodes ? '<span class="ep">' + it.episodes + ' 集</span>' : '')
      + (bv ? '<span class="bili">B站</span>' : '')
      + (mg ? '<span class="mag">磁力</span>' : '')
      + (it.trailer ? '<span class="trailer-mark">预告</span>' : '')
      + (it.st === 'RELEASING' ? '<span class="ep" style="left:8px;right:auto;bottom:auto;top:8px;background:rgba(240,145,153,.92);color:#181820">连载</span>' : '')
      + '</div>';
    var k = fkey(it), fv = isFollowed(k);
    html += '<span class="fav' + (fv ? ' on' : '') + '" data-fav="' + esc(k) + '" title="追番">'
      + (fv ? '★' : '☆') + '</span>';
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
      el.onclick = function (ev) {
        var fv = ev.target.closest ? ev.target.closest('.fav') : null;
        if (fv) {
          ev.stopPropagation();
          var on = toggleFollow(fv.dataset.fav);
          fv.classList.toggle('on', on);
          fv.textContent = on ? '★' : '☆';
          if (PAGE === 'home' && location.hash !== 'skip') renderHome();
          return;
        }
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
    var mg = magnetOf(it);
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
    var cn = useCN();
    /* 磁力优先：有磁力时它就是主按钮，B 站/预告降为次要 */
    if (mg) {
      h += '<span class="btn pri" onclick="__magnet(&#39;' + esc(mg.m) + '&#39;,this)">磁力</span>';
      h += '<a class="btn" target="_blank" rel="noopener" href="' + esc(magnetPlay(mg.m)) + '">在线播放</a>';
    }
    if (bv) {
      h += '<span class="btn' + (!mg && cn ? ' pri' : '') + '" onclick="playBili(&#39;' + esc(bv) + '&#39;,' + (cn ? 'true' : 'false') + ')">▶ B站播放</span>';
    }
    if (it.trailer) {
      h += '<span class="btn' + (!mg && !(bv && cn) ? ' pri' : '') + '" onclick="playTrailer(&#39;' + esc(it.trailer) + '&#39;)">▶ 预告</span>';
    }
    h += '<span class="pill" style="align-self:center;color:var(--dim)">'
      + (mg ? '磁力优先' : (cn ? '国内线路 · 优先 B 站' : '海外线路 · 优先预告')) + '</span>';
    if (!isFresh && it.id) h += '<a class="btn" target="_blank" rel="noopener" href="' + esc((window.JF || 'http://127.0.0.1:8100')) + '/web/#/details?id=' + esc(it.id) + '">Jellyfin</a>';
    if (it.url) h += '<a class="btn" target="_blank" rel="noopener" href="' + esc(it.url) + '">来源页</a>';
    if (it.name) h += '<a class="btn" target="_blank" rel="noopener" href="https://search.bilibili.com/all?keyword=' + encodeURIComponent(it.name) + '">B站搜索</a>';
    h += '</div>';
    /* 备选版本：同一个片子的其他压制/字幕版本，点一下复制对应磁力 */
    if (mg && (mg.alt || []).length) {
      h += '<div class="relbox"><div class="relhead">其他磁力版本</div>';
      (mg.alt || []).forEach(function (a) {
        h += '<span class="relchip" title="' + esc(a.t || '') + '" onclick="__magnet(&#39;' + esc(a.m) + '&#39;,this)">'
          + esc((a.t || '').slice(0, 46))
          + '<em>' + [fmtSize(a.s), a.sd ? a.sd + ' 种' : '', a.sub || ''].filter(Boolean).join(' · ') + '</em></span>';
      });
      h += '</div>';
    }
    h += '</div></div><div class="trailer" id="trailer"></div>';
    $('#modal').innerHTML = h;
    $('#mask').classList.add('on');
    document.body.style.overflow = 'hidden';
    if (useCN() && bv) playBili(bv, true);
    else if (it.trailer && !useCN()) playTrailer(it.trailer);
    else if (useCN() && !bv) {
      $('#trailer').innerHTML = '<div class="tph">国内网络无法直接播放 YouTube 预告<br>'
        + '<a class="btn pri" style="display:inline-block;margin-top:12px" target="_blank" rel="noopener" '
        + 'href="https://search.bilibili.com/all?keyword=' + encodeURIComponent(it.name || '') + '">在 B 站搜索</a></div>';
    }
  }

  function playerHost() {
    var t = $('#trailer');
    if (t) return t;
    var lb = $('#lightbox');
    if (!lb) {
      lb = document.createElement('div');
      lb.id = 'lightbox';
      lb.innerHTML = '<div class="lb-inner"><span class="lb-x" onclick="closeLB()">×</span>'
        + '<div id="trailer"></div></div>';
      lb.onclick = function (e) { if (e.target.id === 'lightbox') closeLB(); };
      document.body.appendChild(lb);
      /* #trailer 在灯箱里要撑满 */
      $('#trailer').style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
    }
    lb.classList.add('on');
    document.body.style.overflow = 'hidden';
    return $('#trailer');
  }
  function closeLB() {
    var lb = $('#lightbox');
    if (lb) { lb.classList.remove('on'); var t = $('#trailer'); if (t) t.innerHTML = ''; }
    document.body.style.overflow = '';
  }
  window.closeLB = closeLB;

  function playTrailer(vid) {
    playerHost().innerHTML = '<iframe src="https://www.youtube.com/embed/' + encodeURIComponent(vid)
      + '?autoplay=1&rel=0" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>';
  }

  function playBili(bvid, auto) {
    playerHost().innerHTML = '<iframe src="//player.bilibili.com/player.html?bvid=' + encodeURIComponent(bvid)
      + '&page=1&high_quality=1&danmaku=0&autoplay=' + (auto ? '1' : '0')
      + '" allowfullscreen scrolling="no" allow="autoplay; fullscreen"></iframe>';
  }

  function closeM() {
    $('#mask').classList.remove('on');
    $('#trailer').innerHTML = '';
    document.body.style.overflow = '';
  }

  /* ---------- 大图轮换（自动 + 拖拽/滑动 + 圆点） ---------- */
  var heroTimer = null, heroIdx = 0, heroN = 0;
  function showSlide(n) {
    if (!heroN) return;
    heroIdx = (n + heroN) % heroN;
    document.querySelectorAll('#hero .slide').forEach(function (el, i) {
      var on = i === heroIdx;
      el.classList.toggle('on', on);
      if (on) {
        var bg = el.querySelector('.hero-bg');
        if (bg && !bg.style.backgroundImage && bg.dataset.bg) {
          bg.style.backgroundImage = 'url(' + bg.dataset.bg + ')';
        }
      }
    });
    document.querySelectorAll('#hero .dots i').forEach(function (el, i) {
      el.classList.toggle('on', i === heroIdx);
    });
  }
  function initHero() {
    var hero = $('#hero');
    if (!hero) return;
    heroN = hero.querySelectorAll('.slide').length;
    if (heroN < 2) return;
    clearInterval(heroTimer);
    heroTimer = setInterval(function () { showSlide(heroIdx + 1); }, 6000);
    hero.querySelectorAll('.dots i').forEach(function (d) {
      d.onclick = function () { showSlide(+d.dataset.dot); restartHero(); };
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
    hero.addEventListener('mouseleave', function () { restartHero(); });
    hero.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; }, { passive: true });
    hero.addEventListener('touchend', function (e) {
      if (x0 === null) return;
      var dx = e.changedTouches[0].clientX - x0; x0 = null;
      if (Math.abs(dx) > 45) { showSlide(heroIdx + (dx < 0 ? 1 : -1)); restartHero(); }
    });
  }
  function restartHero() {
    clearInterval(heroTimer);
    if (heroN > 1) heroTimer = setInterval(function () { showSlide(heroIdx + 1); }, 6000);
  }

  /* ---------- 首页 ---------- */
  function renderHome() {
    var fa = (DATA.fresh && DATA.fresh.anime) || [];
    /* 大图轮换：取有 banner 的前 6 部，自动 6s 切换 + 鼠标拖拽 / 触摸滑动 */
    var slides = fa.filter(function (x) { return x.banner; }).slice(0, 6);
    var out = '';
    if (slides.length) {
      out += '<section class="hero" id="hero">';
      slides.forEach(function (it, i) {
        out += '<div class="slide' + (i === 0 ? ' on' : '') + '" data-i="' + i + '">'
          + (i === 0
              ? '<div class="hero-bg" style="background-image:url(' + "'" + esc(it.banner || it.poster || '') + "'" + ')"></div>'
              : '<div class="hero-bg" data-bg="' + esc(it.banner || it.poster || '') + '"></div>')
          + '<div class="hero-info"><div class="hero-tag">动漫库 · ' + fa.length + ' 部</div>'
          + '<h1>' + esc(it.name) + '</h1><div class="hero-meta">';
        if (it.rating) out += '<span><b>★ ' + it.rating.toFixed(1) + '</b></span>';
        if (it.episodes) out += '<span>' + it.episodes + ' 集</span>';
        if (it.fm) out += '<span>' + esc(FMT[it.fm] || it.fm) + '</span>';
        if (it.st === 'RELEASING' && it.next_at) out += '<span>' + countdown(it.next_at) + '</span>';
        out += '</div><p>' + esc((it.overview || '').slice(0, 180)) + '</p><div class="hero-btns">';
        if (it.trailer) out += '<span class="hbtn primary" onclick="playTrailer(\'' + esc(it.trailer) + '\')">▶ 播放预告</span>';
        out += '<span class="hbtn ghost" data-open="' + esc(fkey(it)) + '">详情</span>';
        out += '</div></div></div>';
      });
      out += '<div class="dots">' + slides.map(function (_, i) {
        return '<i class="' + (i === 0 ? ' on' : '') + '" data-dot="' + i + '"></i>';
      }).join('') + '</div></section>';
    }

    var fl = follows();
    if (fl.length) {
      out += '<section class="block" id="myfollow"><div class="bhead"><h2>我的追番</h2><span>' + fl.length + ' 部</span>'
        + '<span class="syncbar"><a data-act="push">同步 Gist</a><a data-act="pull">恢复</a>'
        + '<a data-act="export">导出</a><a data-act="import">导入</a></span></div>'
        + '<div class="row" id="r-follow"></div></section>';
    }

    out += '<div class="filterbar" id="fbar"></div>';
    out += '<section class="block" id="sched"><div class="bhead"><h2>番剧表</h2><span>按放送日筛选</span></div>'
      + '<div class="wdbar" id="wdbar"></div><div class="grid" id="g-sched"></div></section>';
    var ysel = (DATA.years || []).slice().reverse();
    out += '<section class="block" id="yearsel"><div class="bhead"><h2>按年份</h2><span>每年人气 Top 50</span>'
      + '<select class="yselect" id="ysel">' + ysel.map(function (y) { return '<option>' + y + '</option>'; }).join('') + '</select></div>'
      + '<div class="grid" id="g-year"></div></section>';
    out += '<section class="block"><div class="bhead"><h2>热门动漫</h2><span>Top ' + Math.min(ROW_CAP, fa.length) + '</span></div><div class="row" id="r-anime"></div></section>';
    out += '<section class="block" id="allanime"><div class="bhead"><h2>全部动漫</h2><span>' + fa.length + ' 部</span></div><div class="grid" id="g-all"></div></section>';

    $('#main').innerHTML = out;
    ALL = [];
    initHero();
    var yd = $('#ysel');
    if (yd) {
      var years = (DATA.years || []).slice().reverse();
      yd.onchange = function () { loadYear(+yd.value); };
      /* 下拉是倒序（最新年份在最前），默认加载的年份必须和下拉显示的一致 */
      setTimeout(function () {
        if (!years.length) return;
        yd.value = String(years[0]);
        loadYear(years[0]);
      }, 400);
    }
    renderFilterBar();
    /* 先画 hero + 番剧表；两条轨道用空闲时间补，避免首屏被 48 张远程海报堵住 */
    var later = window.requestIdleCallback || function (fn) { return setTimeout(fn, 60); };
    later(function () {
      fill($('#r-anime'), bySort(fa).slice(0, ROW_CAP), ROW_CAP);
      fill($('#g-all'), bySort(byStatus(fa)), 80);
    });
    if (follows().length) {
      /* fm 以前没定义（只有 fa），只要本地有追番记录这里就抛 ReferenceError，
         后面的 [data-open] 绑定和追番轨道全挂。数据里本来就有 movies。 */
      var fm = (DATA.fresh && DATA.fresh.movies) || [];
      var pool = fa.concat(fm);
      fill($('#r-follow'), pool.filter(function (x) { return isFollowed(fkey(x)); }), 24);
    }
    document.querySelectorAll('[data-open]').forEach(function (el) {
      el.onclick = function () {
        var it = ALL.find(function (x) { return fkey(x) === el.dataset.open; });
        if (it) openModal(it);
      };
    });
    document.querySelectorAll('.syncbar a').forEach(function (a) {
      a.onclick = function () {
        var act = a.dataset.act;
        if (act === 'push') pushGist();
        else if (act === 'pull') pullGist();
        else if (act === 'export') exportFollows();
        else importFollows();
      };
    });

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
    setCnt(fa.length);
  }

  var YEARS_BASE = [window.DATA_URL ? window.DATA_URL.split('/media/')[0] + '/media/years/' : '',
                    window.DATA_FB ? window.DATA_FB.split('/media/')[0] + '/media/years/' : '',
                    './years/'].filter(Boolean);
  /* 年份目录（media/years/*.json）早期用短字段名 k/n/y/r/e/img，卡片渲染读的是长字段名
     name/poster/year/rating/episodes —— 在这里做一次别名归一，两套数据都能渲染 */
  function nzYear(x) {
    if (!x || typeof x !== 'object') return x;
    if (x.name !== undefined && x.poster !== undefined) return x;
    return {key: x.key || x.k, name: x.name || x.n || '',
            poster: x.poster || x.img || '', year: x.year || x.y,
            rating: x.rating !== undefined ? x.rating : x.r,
            episodes: x.episodes || x.e || 0, air: x.air || '', wd: x.wd || '',
            trailer: x.trailer || null, st: x.st, fm: x.fm,
            type: x.type || (x.fm === 'MOVIE' ? 'M' : 'S'),
            next_at: x.next_at || 0, next_ep: x.next_ep || 0,
            overview: x.overview || x.v || '', genres: x.genres || x.g || [],
            url: x.url || x.u || '', banner: x.banner || '', studio: x.sd || '',
            duration: x.du || x.duration || 0, pop: x.pop || 0, rel: x.rel || []};
  }
  function loadYear(y) {
    var hosts = YEARS_BASE.map(function (b) { return b + y + '.json'; });
    var i = 0;
    $('#g-year').innerHTML = '<div class="loading">' + y + ' 年加载中…</div>';
    (function next() {
      if (i >= hosts.length) { $('#g-year').innerHTML = '<div class="empty">' + y + ' 年没有数据</div>'; return; }
      fetchJSON(hosts[i++], 8000)
        .then(function (list) {
          if (!list || !list.length) throw 0;
          list = list.map(nzYear);
          ALL = ALL.concat(list);
          fill($('#g-year'), bySort(list), 60);
        }).catch(next);
    })();
  }

  function renderFilterBar() {
    var bar = $('#fbar'); if (!bar) return;
    bar.innerHTML = '';
    var mk = function (label, on, fn) {
      var el = document.createElement('span');
      el.className = 'chip' + (on ? ' on' : '');
      el.textContent = label;
      el.onclick = fn;
      bar.appendChild(el);
    };
    mk('评分', SORT === 'rating', function () { setSort('rating'); });
    mk('最新', SORT === 'new', function () { setSort('new'); });
    mk('名称', SORT === 'name', function () { setSort('name'); });
    var sep = document.createElement('i'); sep.className = 'sep'; bar.appendChild(sep);
    mk('全部状态', !STATUS_F, function () { setStatus(''); });
    mk('连载中', STATUS_F === 'RELEASING', function () { setStatus('RELEASING'); });
    mk('已完结', STATUS_F === 'FINISHED', function () { setStatus('FINISHED'); });
  }
  function setSort(v) { SORT = v; try { localStorage.setItem('bgm_sort', v); } catch (e) {} renderHome(); }
  function setStatus(v) { STATUS_F = v; renderHome(); }

  function syncWd() {
    document.querySelectorAll('#wdbar .wd-tab').forEach(function (el) {
      var label = el.textContent.split(' ')[0];
      el.classList.toggle('on', WDFILTER ? label === WDFILTER : label === '全部');
    });
  }

  function renderSched(fa) {
    var pool = byStatus(fa);
    var list = bySort(WDFILTER ? pool.filter(function (x) { return x.wd === WDFILTER; }) : pool);
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
    var _old = false;
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
    fill($('#g'), bySort(list), 60);
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
        ? ((DATA.fresh && DATA.fresh.anime) || [])
        : (DATA.lib || []);
      var hits = pool.filter(function (x) { return (x.name || '').toLowerCase().indexOf(kw) >= 0; });
      ALL = [];
      var host = PAGE === 'home' ? ($('#g-all') || $('#g-sched')) : $('#g');
      if (!host) return;
      host.innerHTML = '';
      fill(host, hits, 60);
      if (!hits.length) host.innerHTML = '<div class="empty">没有匹配</div>';
      setCnt(hits.length);
    };
  }

  function allItems() {
    return [].concat((DATA.fresh && DATA.fresh.anime) || [],
                     DATA.lib || []);
  }
  function openFromQuery() {
    var id = new URLSearchParams(location.search).get('id');
    if (!id) return;
    var tryOpen = function () {
      var it = allItems().find(function (x) { return fkey(x) === id || String(x.id) === id; });
      if (it) { ALL = allItems(); openModal(it); return true; }
      return false;
    };
    if (!tryOpen()) setTimeout(tryOpen, 1200);
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

  /* 单档超时：任何一档 CDN 挂住都不能把后面的兜底档一起拖死（曾出现 gh-proxy 卡住、
     页面一直停在「加载中」）。7 秒拿不到就换下一档。 */
  function fetchJSON(url, ms) {
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, ms || 7000) : 0;
    var opt = { cache: 'force-cache' };
    if (ctl) opt.signal = ctl.signal;
    return fetch(url, opt).then(function (r) {
      if (!r.ok) throw 0;
      return r.json();
    }).then(function (d) {
      if (timer) clearTimeout(timer);
      return d;
    }, function (e) {
      if (timer) clearTimeout(timer);
      throw e;
    });
  }
  function loadData(cb) {
    if (window.DATA) { cb(); return; }
    var urls = [window.DATA_URL, window.DATA_FB,
                window.DATA_LOCAL ? './' + window.DATA_LOCAL : null].filter(Boolean);
    var i = 0;
    function next() {
      if (i >= urls.length) { cb(); return; }
      fetchJSON(urls[i++], 8000)
        .then(function (d) { window.DATA = d || {}; DATA = window.DATA; cb(); })
        .catch(next);
    }
    next();
  }

  document.addEventListener('DOMContentLoaded', function () {
    window.JF = window.JF || 'http://127.0.0.1:8100';
    $('#mask').onclick = function (e) { if (e.target.id === 'mask') closeM(); };
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeM(); });
    var top = $('#topbar');
    window.addEventListener('scroll', function () {
      top.classList.toggle('solid', window.scrollY > 12);
    }, { passive: true });
    var sw = document.createElement('div');
    sw.className = 'regionsw'; sw.id = 'regionsw';
    document.querySelector('.tw').appendChild(sw);
    renderRegionSwitch();
    bindSearch();
    loadData(function () {
      if (!window.DATA) { $('#main').innerHTML = '<div class="empty">数据加载失败，请刷新重试</div>'; return; }
      if (PAGE === 'home') renderHome(); else renderLibrary();
      openFromQuery();
    });
  });
})();
