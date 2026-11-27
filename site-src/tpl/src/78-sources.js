  /* ---------------- 播放链（详情页只有「开始观看」，不再有播放源面板）----------------
     2026-11-14 改版（用户口径）：
       · 详情页不再显示「B 站 / 外部线路 / YouTube / 网盘」四行；
       · 线路全自动：外部采集源 → 规则源 → YouTube 官方 → 夸克网盘；
       · B 站只作出处（不再内嵌播放、不再要求绑定），详情页给「去 B 站观看」外链；
       · 状态文案写在播放器下面的 #dpStat（没有面板了，srcHint 落这里）。
     外部采集源的检测/匹配在 79-extsrc.js，本文件只负责编排。 */
  var SRC_BASE = 'https://edge.jiangjiangze.icu';

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
  /* 2026-11-15：站点不再内嵌 B 站、也不做 B 站账号绑定。
     B 站只作「出处」：详情页给「去 B 站观看」外链（bvid 由 CI 索引维护）。
     2026-11-27：夸克网盘链路随盒子退场（/pans、/tvplay 下线），自动链收敛为
     外部采集源 → 规则源 → YouTube 官方；三跳都落空时给明确提示。 */
  function srcStart(box, id, title, ep) {
    var epNo = Math.max(1, Math.floor(Number(ep) || 1));
    if (typeof window.__extAbort === 'function') window.__extAbort();
    if (!box) return false;

    function fail(why) {
      srcLineSet(box, '无可用线路');
      srcHint(box, (why ? why + ' · ' : '') + '没有可用播放线路，可去 B 站或搜索页找');
    }

    function toYoutube(why) {
      var eps = srcYtEps(id);
      if (!eps) { fail(why + ' · 无官方正片'); return; }
      var idx = Math.max(0, Math.min(eps.length - 1, epNo - 1));
      srcHint(box, why + ' · 检测 YouTube 可达性…');
      ytReach().then(function (ok) {
        var pick = eps[idx] || [];
        if (ok && srcEmbedYT(box, pick[1], epNo, pick[2])) return;
        fail(why + ' · YouTube 不可达');
      });
    }

    /* 外部采集源（m3u8 API，浏览器并发探测，先回先播） */
    function toExt(next) {
      if (typeof extStart !== 'function') { next('无外部源'); return; }
      srcLineSet(box, '外部 · 自动');
      srcHint(box, '正在匹配外部线路…');
      extStart(box, id, title, epNo, function (why) { next(why || '外部源未收录'); });
    }

    /* 规则源（HTML 由盒子转发、浏览器解析） */
    function toRule(next) {
      if (typeof window.__rulePlay !== 'function') { next(''); return; }
      srcHint(box, '正在尝试规则源…');
      window.__rulePlay(box, id, title, epNo, function (w) { next(w || '规则源未命中'); }, null, 3);
    }

    srcHint(box, '正在匹配播放源…');
    toExt(function (why1) {
      toRule(function (why2) {
        toYoutube([why1, why2].filter(Boolean).join(' · '));
      });
    });
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
      ['auto', '自动（外部 → 规则源 → YouTube）'],
      ['yt', 'YouTube 官方']
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
    if (line === 'yt') {
      var eps = srcYtEps(id);
      if (!eps) { srcHint(box, '本季没有官方 YouTube 正片'); return; }
      var pick = eps[Math.max(0, Math.min(eps.length - 1, ep - 1))] || [];
      if (srcEmbedYT(box, pick[1], ep, pick[2])) srcLineSet(box, 'YouTube');
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

