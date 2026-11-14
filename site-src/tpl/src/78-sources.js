  /* ---------------- 播放链（详情页只有「开始观看」，不再有播放源面板）----------------
     2026-11-14 改版（用户口径）：
       · 详情页不再显示「B 站 / 外部线路 / YouTube / 网盘」四行，绑定入口挪到「我的」页；
       · 线路选择全自动：B 站登录态 → B 站官方番剧(免费集) → 索引 bvid → 外部采集源
         （浏览器并发探测，先回先播）→ B 站匿名搜 → YouTube 官方 → 网盘转存；
       · 状态文案写在播放器下面的 #dpStat（没有面板了，srcHint 落这里）。
     外部采集源的检测/匹配在 79-extsrc.js，本文件只负责编排。 */
  var SRC_BASE = 'https://120.48.56.189';

  /* 统一 GET（79 / 46 共用）：网络失败、空体、非 JSON 一律退化成 {status, ok:false, j:{}} */
  function srcGet(path, tk) {
    var headers = {};
    if (tk) headers.authorization = 'Bearer ' + tk;
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 15000);
    var opt = { method: 'GET', headers: headers };
    if (ctl) opt.signal = ctl.signal;
    return fetch(SRC_BASE + path, opt).then(function (r) {
      clearTimeout(timer);
      return r.text().then(function (t) {
        var j = null;
        try { j = JSON.parse(t); } catch (e) { j = null; }
        if (!j || typeof j !== 'object') j = {};
        return { status: Number(r.status) || 0, ok: !!r.ok, j: j };
      });
    }, function () {
      clearTimeout(timer);
      return { status: 0, ok: false, j: {} };
    });
  }

  /* 状态行：详情页播放器下方的 #dpStat；老面板若还在（弹窗残留）就写 .sec-sub */
  function srcHint(host, text) {
    if (!host || !host.querySelector) {
      try { host = document; } catch (e) { return; }
    }
    var stat = host.querySelector ? host.querySelector('#dpStat') : null;
    if (stat) { stat.textContent = text || ''; return; }
    var panel = host.querySelector('.dp-srcs');
    if (!panel && host.className && String(host.className).indexOf('dp-srcs') >= 0) panel = host;
    var h = panel ? panel.querySelector('.sec-sub') : null;
    if (h) h.textContent = text;
  }

  /* 第三方播放器 iframe 一律包 .dpv-frame（16:9 由外壳定，见历史坑） */
  function srcFrame(src, allow) {
    return '<div class="dpv-frame"><iframe src="' + src + '"'
      + ' allow="' + (allow || 'autoplay; encrypted-media; fullscreen; picture-in-picture') + '"'
      + ' allowfullscreen scrolling="no" frameborder="no"'
      + ' referrerpolicy="origin-when-cross-origin"></iframe></div>';
  }

  function ytKey(url) {
    var m = /[?&]v=([\w-]{6,})/.exec(url || '') || /youtu\.be\/([\w-]{6,})/.exec(url || '');
    return m ? m[1] : '';
  }

  function srcPlayerSlot(box) {
    return (box && box.querySelector ? box.querySelector('#dpPlayer') : null) || box;
  }
  function srcAbortOthers() {
    if (window.__qpAbort === 'function') window.__qpAbort();
    if (window.__biliAbort === 'function') window.__biliAbort();
    if (typeof window.__extAbort === 'function') window.__extAbort();
    if (window.QPlayer && typeof window.QPlayer.close === 'function') window.QPlayer.close();
  }

  function srcEmbedYT(box, url, ep, cn) {
    var key = ytKey(url);
    if (!key) return false;
    var slot = srcPlayerSlot(box);
    srcAbortOthers();
    slot.innerHTML = srcFrame('https://www.youtube-nocookie.com/embed/'
      + encodeURIComponent(key) + '?autoplay=1&rel=0&modestbranding=1');
    srcLineSet(box, 'YouTube');
    srcHint(box, cn === 1
      ? 'YouTube 官方频道 · 本集中国大陆可直连播放'
      : 'YouTube 官方频道 · 本集需港澳台/东南亚出口');
    return true;
  }

  function srcEmbedBvid(box, bvid) {
    if (!bvid) return false;
    var slot = srcPlayerSlot(box);
    srcAbortOthers();
    slot.innerHTML = srcFrame('https://player.bilibili.com/player.html?bvid='
      + encodeURIComponent(bvid) + '&page=1&high_quality=1&danmaku=1&autoplay=1');
    srcLineSet(box, 'B 站');
    srcHint(box, 'B 站官方播放器 · 登录 B 站后本页即可看更高清晰度');
    return true;
  }

  /* 番剧官方源（PGC）：参数是 episodeId + seasonId；会员集只给试看，不嵌 */
  function srcEmbedPgc(box, sid, ep, epNo) {
    if (!box || !sid || !ep || !ep.id) return false;
    var slot = srcPlayerSlot(box);
    srcAbortOthers();
    slot.innerHTML = srcFrame('https://player.bilibili.com/player.html?episodeId='
      + encodeURIComponent(ep.id) + '&seasonId=' + encodeURIComponent(sid)
      + '&autoplay=1&high_quality=1&danmaku=1');
    srcLineSet(box, 'B 站官方番剧');
    srcHint(box, 'B 站官方番剧 · 第 ' + epNo + ' 集（免费集，免登录）');
    return true;
  }

  function srcPgc(title) {
    if (typeof biliGet !== 'function') return Promise.resolve(null);
    return biliGet('pgc', { t: title }).then(function (d) {
      return (d && d.ok && d.found && d.sid && (d.eps || []).length) ? d : null;
    }, function () { return null; });
  }

  function srcEmbedBili(box, id) {
    var exb = (typeof ANI !== 'undefined' && ANI.extra) ? ANI.extra[id] : null;
    return srcEmbedBvid(box, exb && exb[5]);
  }

  /* 匿名实时搜 B 站：**必须校验片名**——匿名搜索没有片名校验，
     实测「金牌得主 第二季」被配成花滑 cos 视频（BV1U7dYBLEZP）。 */
  function biliFindBvid(title) {
    if (typeof biliGet !== 'function') return Promise.reject(new Error('no biliGet'));
    return biliGet('find', { t: title }).then(function (f) {
      if (!f || !f.found || !f.bvid) return '';
      var t = String(f.title || '');
      if (typeof BILI_NOISE === 'object' && BILI_NOISE.test && BILI_NOISE.test(t)) return '';
      if (!srcTitleOk(t, title)) return '';
      return String(f.bvid);
    }, function () { return ''; });
  }

  /* 片名粗校验：归一化后互含（≥2 字）才算同一部 */
  function srcTitleOk(cand, title) {
    var a = nrm(String(cand || '')), b = nrm(String(title || ''));
    if (!a || !b) return false;
    if (b.length < 2) return a.indexOf(b) >= 0;
    return a.indexOf(b) >= 0 || b.indexOf(a) >= 0;
  }

  function srcYtEps(id) {
    var ex = (typeof ANI !== 'undefined' && ANI.extra) ? ANI.extra[id] : null;
    var eps = ex && ex[4];
    return (eps && eps.length) ? eps : null;
  }

  /* YouTube 可达性（1.8s 超时，10 分钟缓存） */
  var YT_REACH = null;
  function ytReach() {
    if (YT_REACH) return YT_REACH;
    YT_REACH = new Promise(function (resolve) {
      var done = false;
      function fin(ok) { if (!done) { done = true; resolve(ok); } }
      var ctl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctl) ctl.abort(); fin(false); }, 1800);
      try {
        fetch('https://www.youtube.com/generate_204', {
          mode: 'no-cors', cache: 'no-store', signal: ctl ? ctl.signal : undefined
        }).then(function () { clearTimeout(timer); fin(true); },
               function () { clearTimeout(timer); fin(false); });
      } catch (e) { clearTimeout(timer); fin(false); }
    });
    setTimeout(function () { YT_REACH = null; }, 10 * 60 * 1000);
    return YT_REACH;
  }

  /* ---------------- 自动播放链 ---------------- */
  function srcStart(box, id, title, ep, skipExt) {
    var epNo = Math.max(1, Math.floor(Number(ep) || 1));
    var tk = (typeof authToken === 'function') ? authToken() : '';
    if (typeof window.__extAbort === 'function') window.__extAbort();
    if (!box) return false;

    function toQuark(why) {
      srcLineSet(box, '夸克网盘');
      srcHint(box, why + ' · 使用网盘源');
      if (typeof openQuarkPlay === 'function') openQuarkPlay(srcPlayerSlot(box), id, title);
      if (!tk && typeof openAuthPanel === 'function') openAuthPanel('email');
    }

    function toYoutube(why) {
      var eps = srcYtEps(id);
      if (!eps) { toQuark(why + ' · 无官方正片'); return; }
      var idx = Math.max(0, Math.min(eps.length - 1, epNo - 1));
      srcHint(box, why + ' · 检测 YouTube 可达性…');
      ytReach().then(function (ok) {
        var pick = eps[idx] || [];
        if (ok && srcEmbedYT(box, pick[1], epNo, pick[2])) return;
        toQuark(why + ' · YouTube 不可达');
      });
    }

    /* 外部采集源：浏览器并发探测，先回先播（79-extsrc） */
    function toExt(next) {
      if (skipExt) { next('已选 B 站'); return; }
      if (typeof extStart !== 'function') { next('无外部源'); return; }
      srcLineSet(box, '外部 · 自动');
      srcHint(box, '正在匹配外部线路…');
      extStart(box, id, title, epNo, function (why) { next(why || '外部源未收录'); });
    }

    /* 规则源（HTML 在浏览器里解析）：采集站全挂时的补充线路 */
    function toRule(next) {
      if (typeof window.__rulePlay !== 'function') { next(''); return; }
      srcHint(box, '正在尝试规则源…');
      /* 按优先级最多试 3 个：一集打十几个站既慢又容易被风控 */
      window.__rulePlay(box, id, title, epNo, function (w) { next(w || '规则源未命中'); }, null, 3);
    }

    function anonChain() {
      srcHint(box, '正在匹配 B 站官方番剧…');
      srcPgc(title).then(function (p) {
        if (p) {
          var row = p.eps[Math.max(0, epNo - 1)] || p.eps[0];
          if (row && !row.vip && srcEmbedPgc(box, p.sid, row, epNo)) return;
          if (row && row.vip) srcHint(box, '第 ' + epNo + ' 集是 B 站大会员集（仅试看）· 已换下一个源');
        }
        if (srcEmbedBili(box, id)) return;
        toExt(function (why) {
        toRule(function (why2) {
          srcHint(box, '正在 B 站搜索「' + title + '」…');
          biliFindBvid(title).then(function (bv) {
            if (bv && srcEmbedBvid(box, bv)) return;
            toYoutube(why + ' · B 站未找到');
          }, function () { toYoutube(why + ' · B 站搜索失败'); });
        });
      });
      });
    }

    /* 已绑定 B 站：先用登录态播（清晰度/大会员集） */
    if (tk && typeof biliPlayEp === 'function') {
      srcHint(box, '正在检查 B 站登录态…');
      srcGet('/bili/bind', tk).then(function (r) {
        var j = (r && r.j) || {};
        if (r && r.ok && j.ok && j.bound) {
          srcHint(box, 'B 站已绑定 · 用登录态播放');
          biliPlayEp(box, id, title, epNo);
          return;
        }
        anonChain();
      }, anonChain);
      return true;
    }
    anonChain();
    return true;
  }

  /* ---------------- 手动切换线路（播放器下方）----------------
     自动链还是默认；这里给不想等/想指定的人一个入口：
       · 自动（B站 → 外部 → YouTube → 网盘）
       · B 站优先（跳过外部源，直接走官方/匿名搜索）
       · 外部 · <源名>（列出最近一次匹配到的线路，按源指定）
       · YouTube 官方 / 夸克网盘
     外部线路清单来自 79 的 window.__extItems(id)（自动链跑过一次就有一份）。 */
  function srcLineBarHtml() {
    return '<div class="line-bar">'
      + '<span class="line-now" id="lineNow">线路：自动</span>'
      + '<button class="line-btn" id="lineBtn" type="button">切换线路<i>\u25BE</i></button>'
      + '<div class="line-menu" id="lineMenu" hidden></div>'
      + '</div>';
  }

  function srcLineMenuHtml(id) {
    var rows = [
      ['auto', '自动（B站 → 外部 → YouTube → 网盘）'],
      ['bili', 'B 站优先'],
      ['yt', 'YouTube 官方'],
      ['quark', '夸克网盘']
    ];
    var items = (typeof window.__extItems === 'function') ? window.__extItems(id) : [];
    if (items.length) {
      for (var i = 0; i < items.length; i++) {
        rows.push(['ext:' + items[i].p, '外部 · ' + items[i].name + ' · ' + items[i].n + ' 集']);
      }
    } else {
      rows.push(['ext:auto', '外部线路（还没探测，选它自动匹配）']);
    }
    var rules = (typeof window.__ruleSources === 'function') ? window.__ruleSources() : [];
    for (var r = 0; r < rules.length; r++) {
      rows.push(['rule:' + rules[r].id,
        '规则源 · ' + rules[r].name + (rules[r].mode === 'iframe' ? '（站外播放器）' : '')]);
    }
    return rows.map(function (r) {
      return '<button class="line-item" type="button" data-line="' + esc(r[0]) + '">' + esc(r[1]) + '</button>';
    }).join('');
  }

  function srcLineSet(host, text) {
    var el = host.querySelector('#lineNow');
    if (el) el.textContent = '线路：' + text;
  }

  function srcLineBind(host, id, title, ep) {
    var btn = host.querySelector('#lineBtn');
    var menu = host.querySelector('#lineMenu');
    if (!btn || !menu) return;
    var epNo = Math.max(1, Math.floor(Number(ep) || 1));
    function close() { menu.hidden = true; }
    btn.onclick = function (e) {
      e.stopPropagation();
      if (!menu.hidden) { close(); return; }
      menu.innerHTML = srcLineMenuHtml(id);
      menu.hidden = false;
    };
    menu.onclick = function (e) {
      var t = e.target;
      while (t && t !== menu && !(t.getAttribute && t.getAttribute('data-line'))) t = t.parentNode;
      if (!t || t === menu) return;
      var line = t.getAttribute('data-line');
      close();
      srcLinePick(host, id, title, epNo, line);
    };
    document.addEventListener('click', function (ev) {
      if (!menu.hidden && !host.contains(ev.target)) close();
    });
  }

  function srcLinePick(box, id, title, ep, line) {
    var slot = srcPlayerSlot(box);
    if (line === 'auto') { srcLineSet(box, '自动'); srcStart(box, id, title, ep, false); return; }
    if (line === 'bili') { srcLineSet(box, 'B 站优先'); srcStart(box, id, title, ep, true); return; }
    if (line === 'yt') {
      var eps = srcYtEps(id);
      if (!eps) { srcHint(box, '本季没有官方 YouTube 正片'); return; }
      var pick = eps[Math.max(0, Math.min(eps.length - 1, ep - 1))] || [];
      if (srcEmbedYT(box, pick[1], ep, pick[2])) srcLineSet(box, 'YouTube');
      return;
    }
    if (line === 'quark') {
      srcLineSet(box, '夸克网盘');
      if (typeof openQuarkPlay === 'function') openQuarkPlay(slot, id, title);
      return;
    }
    if (line.indexOf('rule:') === 0) {
      if (typeof window.__rulePlay === 'function') {
        window.__rulePlay(box, id, title, ep, null, line.slice(5));
      } else {
        srcHint(box, '规则源不可用');
      }
      return;
    }
    if (line.indexOf('ext:') === 0) {
      var pid = line.slice(4);
      var items = (typeof window.__extItems === 'function') ? window.__extItems(id) : [];
      if (pid === 'auto' || !items.length) {
        srcLineSet(box, '外部 · 自动匹配');
        if (typeof extStart === 'function') {
          extStart(box, id, title, ep, function (why) { srcHint(box, why || '外部源未收录'); });
        }
        return;
      }
      var mine = items.filter(function (x) { return x.p === pid; });
      if (!mine.length) { srcHint(box, '这条线路还没有匹配结果'); return; }
      srcLineSet(box, '外部 · ' + (mine[0].name || pid));
      if (typeof extPlayEp === 'function') extPlayEp(box, id, title, ep, mine);
    }
  }

  window.__srcStart = srcStart;
  window.__srcLineBarHtml = srcLineBarHtml;
  window.__srcLineBind = srcLineBind;

  /* ---------------- 夸克绑定入口（「我的」页用；详情页面板已删除） ---------------- */
  function openQuarkBindPanel() {
    if (document.getElementById('qbmask')) return;
    if (typeof authToken === 'function' && !authToken()) {
      if (typeof openAuthPanel === 'function') openAuthPanel('email');
      return;
    }
    var mask = document.createElement('div');
    mask.className = 'authmask qbmask';
    mask.id = 'qbmask';
    mask.innerHTML = '<div class="authcard qbcard" role="dialog" aria-modal="true">'
      + '<button class="authx" type="button" aria-label="关闭">×</button>'
      + '<h3 class="qbtitle">绑定夸克网盘</h3>'
      + '<p class="qbhint">用夸克 App 扫码，扫完自动绑定（只需一次）。绑定后网盘源可直接播放。</p>'
      + '<div class="qbframe"><iframe src="' + esc(quarkBindUrl('&embed=1')) + '"'
      + ' referrerpolicy="origin-when-cross-origin" allow="clipboard-write"></iframe></div>'
      + '</div>';
    document.body.appendChild(mask);

    function cleanup() {
      if (mask.parentNode) mask.parentNode.removeChild(mask);
      window.removeEventListener('message', onMsg);
      document.removeEventListener('keydown', onKey);
    }
    function onMsg(ev) {
      if (String(ev.origin).indexOf('120.48.56.189') < 0) return;
      var d = ev.data || {};
      if (d && d.type === 'quark-bound' && d.ok) {
        cleanup();
        srcHint(document, '夸克网盘已绑定');
      }
    }
    function onKey(ev) { if (ev.key === 'Escape') cleanup(); }
    mask.onclick = function (ev) {
      var t = ev.target;
      if (t === mask || (t && String(t.className || '').indexOf('authx') >= 0)) cleanup();
    };
    window.addEventListener('message', onMsg);
    document.addEventListener('keydown', onKey);
  }
