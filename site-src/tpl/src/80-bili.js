  /* ---------------- 详情弹窗：详情 / 弹幕 / 评论 三 tab ----------------
     数据全部走盒子的 B 站代理（https://120.48.56.189/bili/*，带 buvid3 cookie
     与 SQLite 缓存）；静态资源仍旧走 CDN，这里只有动态取数。 */
  var BILI = {};          // id -> {bvid, aid, pages:[{page,cid,part}]}
  var BILI_P = {};        // id -> 在途的 resolve：同 id 并发共用一次请求
  var BILI_BASE = 'https://120.48.56.189/bili/';

  function biliGet(path, params) {
    var q = Object.keys(params || {}).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 15000);
    return fetch(BILI_BASE + path + (q ? '?' + q : ''), ctl ? { signal: ctl.signal } : undefined)
      .then(function (r) { clearTimeout(timer); return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); });
  }

  /* B 站 UGC 搜索会混进 OP/ED/OST/MV，播放量还特别高。按标题黑名单 +
     分P数量 + 每集时长 粗筛一次「像不像正片」；不通过就只当「相关视频」提示。 */
  var BILI_NOISE = /(主题歌|主題歌|\bOP\d?\b|\bED\d?\b|\bOST\b|原声|原聲|サントラ|Soundtrack|\bMV\b|\bMAD\b|\bAMV\b|混剪|鼓谱|钢琴|ピアノ|反应|reaction|合集|全集|一口气看完)/i;
  function biliScore(v, title) {
    if (!v || !v.pages) return 0;
    var t = v.title || '';
    var n = v.pages.length;
    var avg = 0;
    for (var i = 0; i < n; i++) avg += (v.pages[i].duration || 0);
    avg = n ? avg / n : 0;
    var score = 0;
    if (BILI_NOISE.test(t)) score -= 2;            // 名字像二创/音乐
    if (n >= 3 && avg >= 600) score += 2;          // 多P 且每集 10 分钟以上：最像正片
    if (n === 1 && avg >= 1200) score += 1;        // 单P 长视频：可能是合集
    if (n === 1 && avg < 300) score -= 2;          // 短片基本是 PV/OP
    return score;
  }

  function biliResolve(id, title, year) {
    if (BILI[id] !== undefined) return Promise.resolve(BILI[id]);
    if (BILI_P[id]) return BILI_P[id];
    var direct = (typeof DATA !== 'undefined' && DATA.bili && DATA.bili[id]) || '';
    var p = direct
      ? biliGet('view', { bvid: direct })
      /* 不传 y：盒子的 /bili/find 用「上传年」比对，而这里是「放送年」，
         实测命中率会从 100% 掉到 65%。年份只做前端软过滤（见 biliScore）。 */
      : biliGet('find', { t: title }).then(function (f) {
          if (!f || !f.found || !f.bvid) return { ok: false };
          return biliGet('view', { bvid: f.bvid });
        });
    /* 只缓存成功结果：失败/超时也写 BILI 会变成永久负缓存，这一页生命周期内再也不重试。 */
    var r = p.then(function (v) {
      if (v && v.ok && (v.aid || (v.pages && v.pages.length))) BILI[id] = v;
      return (v && v.ok) ? v : null;
    }).catch(function () { return null; });
    BILI_P[id] = r;
    // 在途标记在请求结束后撤销（成功失败都撤，否则失败后永远拿同一个旧结果）
    r.then(function () { delete BILI_P[id]; }, function () { delete BILI_P[id]; });
    return r;
  }

  function renderDm(box, d, pages, curPage) {
    if (!d || !d.ok) { box.innerHTML = '<div class="mnote">弹幕取不到（' + ((d && d.error) || '网络') + '）</div>'; return; }
    if (!d.items.length) { box.innerHTML = '<div class="mnote">这一集还没有弹幕</div>'; return; }
    /* 脏数据过滤：B 站接口会混进单字符 / 纯符号的条目（实测线上有一条内容就是单个反斜杠）。
       只滤这些，不动 d.count 的展示——顶部「共 N 条」仍是接口原值。 */
    var DM_SYM = /^[\\/\-_.·…~=*\s]+$/;
    var dmItems = d.items.filter(function (it) {
      var m = String(it.m == null ? '' : it.m).trim();
      return m.length >= 2 && !DM_SYM.test(m);
    });
    if (!dmItems.length) { box.innerHTML = '<div class="mnote">这一集还没有弹幕</div>'; return; }
    var sel = '';
    if (pages.length > 1) {
      sel = '<div class="pgsel">' + pages.slice(0, 24).map(function (p) {
        return '<button class="chip' + (p.page === curPage ? ' on' : '') + '" type="button" data-pg="'
          + p.page + '" data-cid="' + p.cid + '">第 ' + p.page + ' 集</button>';
      }).join('') + '</div>';
    }
    var rows = dmItems.slice(0, 300).map(function (it) {
      var mm = Math.floor(it.t / 60), ss = ('0' + Math.floor(it.t % 60)).slice(-2);
      return '<div class="dmrow"><em>' + mm + ':' + ss + '</em><span>' + esc(it.m) + '</span></div>';
    }).join('');
    box.innerHTML = '<div class="mnote">共 ' + d.count + ' 条 · 来源 B 站（显示前 ' + Math.min(300, d.count) + ' 条）</div>'
      + sel + '<div class="dmlist"><div class="dmgrid">' + rows + '</div></div>';
  }

  function renderRp(box, d) {
    if (!d || !d.ok) { box.innerHTML = '<div class="mnote">评论取不到（' + ((d && d.error) || '网络') + '）</div>'; return; }
    if (!d.items.length) { box.innerHTML = '<div class="mnote">还没有评论</div>'; return; }
    box.innerHTML = '<div class="mnote">共 ' + d.total + ' 条 · 来源 B 站</div>'
      + d.items.map(function (it) {
        var dt = it.t ? new Date(it.t * 1000) : null;
        var day = dt ? (dt.getFullYear() + '-' + ('0' + (dt.getMonth() + 1)).slice(-2) + '-' + ('0' + dt.getDate()).slice(-2)) : '';
        return '<div class="rprow' + (it.re === 1 ? ' re' : '') + '">'
          + (it.a ? '<img src="' + esc(it.a) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">'
            : '<span class="rpav">' + esc(String(it.u || '匿名').slice(0, 1)) + '</span>')
          + '<div><b>' + esc(it.u || '匿名') + '</b><em>' + day + (it.l ? ' · 赞 ' + it.l : '') + '</em>'
          + '<p>' + esc(it.m) + '</p></div></div>';
      }).join('');
  }

  function bindBili(id, title, year) {
    var m = $('#modal');
    if (!m) return;
    m.querySelectorAll('.mtab').forEach(function (b) {
      b.onclick = function () {
        var p = b.getAttribute('data-p');
        m.querySelectorAll('.mtab').forEach(function (x) { x.classList.toggle('on', x === b); });
        m.querySelectorAll('.mbody').forEach(function (x) {
          x.hidden = x.getAttribute('data-p') !== p;
        });
        if (p === 'dm' && !m.querySelector('#pdm').dataset.done) {
          m.querySelector('#pdm').dataset.done = '1';
          m.querySelector('#pdm').innerHTML = '<div class="mnote">弹幕加载中…</div>';
          biliResolve(id, title, year).then(function (v) {
            var box = m.querySelector('#pdm');
            if (!v || !v.pages || !v.pages.length) { box.innerHTML = '<div class="mnote">未匹配到 B 站源</div>'; return; }
            var pg = v.pages[0];
            return biliGet('dm', { cid: pg.cid }).then(function (d) {
              renderDm(box, d, v.pages, pg.page);
              box.querySelectorAll('[data-pg]').forEach(function (c) {
                c.onclick = function () {
                  box.querySelectorAll('[data-pg]').forEach(function (x) { x.classList.toggle('on', x === c); });
                  box.innerHTML = '<div class="mnote">弹幕加载中…</div>';
                  biliGet('dm', { cid: c.getAttribute('data-cid') }).then(function (dd) {
                    renderDm(box, dd, v.pages, Number(c.getAttribute('data-pg')));
                  });
                };
              });
            });
          }).catch(function () { m.querySelector('#pdm').innerHTML = '<div class="mnote">未匹配到 B 站源</div>'; });
        }
        if (p === 'rp' && !m.querySelector('#prp').dataset.done) {
          m.querySelector('#prp').dataset.done = '1';
          m.querySelector('#prp').innerHTML = '<div class="mnote">评论加载中…</div>';
          biliResolve(id, title, year).then(function (v) {
            if (!v || !v.aid) { m.querySelector('#prp').innerHTML = '<div class="mnote">未匹配到 B 站源</div>'; return; }
            return biliGet('reply', { aid: v.aid, ps: 20 }).then(function (d) { renderRp(m.querySelector('#prp'), d); });
          }).catch(function () { m.querySelector('#prp').innerHTML = '<div class="mnote">未匹配到 B 站源</div>'; });
        }
      };
    });
    biliEntry(m, id, title);
  }

  /* ---------------- 用自己的 B 站账号看（弹幕版） ----------------
     链路：站点 token（localStorage.gh_token，与 20-state.js 的 followToken 同键）
       → biliResolve 拿 {bvid, aid, pages} → 选 cid
       → POST /bili/playurl（盒子用个人主页里绑定的 SESSDATA 换一条用户自己的 B 站直链）
       → 自研播放器 QPlayer.open（dm.cid 交给 76 自己拉 /bili/dm?cid=）。
     两条链路互不影响：这里只读站点 token 与 biliResolve 缓存，不碰 75-quarkplay.js 的
     任何 QP_* 状态；失败也只落到播放器自己的 rebind / error 态，夸克源照旧可用。
     /bili/playurl 契约：ok{url,quality,size} / need_rebind(409) / not_bound(404) / 未登录 401。 */
  var BILI_PLAY_GEN = 0;      // 连点两次：只让最后一次的异步结果落地

  /* 集号：B 站分P标题写法很杂（「第 3 话」「[03]」「E03」「S01E03」「_03」），统一抽成数字；
     抽不到返回 0，调用方退回按顺序取 pages[ep-1]。 */
  var BILI_EP_RE = /第\s*(\d+)\s*[话集]|\[(\d{1,3})\]|E(\d{1,3})|S\d+E(\d{1,3})|_(\d{1,3})/;
  function biliEpNo(part) {
    var m = BILI_EP_RE.exec(String(part == null ? '' : part));
    if (!m) return 0;
    for (var i = 1; i < m.length; i++) { if (m[i]) return Number(m[i]); }
    return 0;
  }

  function biliPickPage(pages, ep) {
    var want = Number(ep) > 0 ? Math.floor(Number(ep)) : 1;
    for (var i = 0; i < pages.length; i++) {
      if (pages[i] && biliEpNo(pages[i].part) === want) return pages[i];
    }
    return pages[want - 1] || pages[0] || null;
  }

  /* 带站点 token 的请求（biliGet 只管匿名 GET）：返回 {status, ok, j}；
     超时 / 断网抛可读文案，交给调用方落到播放器状态上。 */
  function biliAuth(path, method, body, ms) {
    var tk = '';
    try { tk = localStorage.getItem('gh_token') || ''; } catch (e) { tk = ''; }
    var opt = { method: method || 'GET', headers: { authorization: 'Bearer ' + tk } };
    if (body != null) {
      opt.headers['content-type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms || 15000);
    if (ctl) opt.signal = ctl.signal;
    return fetch(BILI_BASE + path, opt).then(function (r) {
      clearTimeout(timer);
      return r.json().catch(function () { return null; }).then(function (j) {
        return { status: r.status, ok: r.ok, j: j };
      });
    }, function (e) {
      clearTimeout(timer);
      if (ctl && ctl.signal && ctl.signal.aborted) throw new Error('网络慢，请重试');
      throw new Error('网络异常，请检查连接');
    });
  }

  /* 打开播放器骨架。拿不到直链（rebind / error）时也要先建实例，
     否则 QPlayer.state() 没有 cur 可写，用户会看到一片空白。
     有 url 就交给 open 起播：76 的 open() 会对首条源自己 startLine，
     再调一次 QPlayer.play(url) 只会把同一个地址二次 load（addLine 按 url 去重，
     不会多出一条线路，但第一次 load 被中断会白走一次 onLoadFail），所以这里不重复调用。 */
  function biliOpenPlayer(m, id, title, ep, cid, url) {
    var ctx = {
      m: m,
      id: String(id),
      title: String(title || ''),
      ep: ep,
      sources: url ? [{ label: 'B 站（弹幕版）', url: String(url), type: 'mp4' }] : []
    };
    if (cid) ctx.dm = { cid: String(cid) };
    return window.QPlayer.open(ctx);
  }

  function biliPlayEp(m, id, title, ep) {
    var tk = '';
    try { tk = localStorage.getItem('gh_token') || ''; } catch (e) { tk = ''; }
    if (!tk) { if (window.__openLogin) window.__openLogin('email'); return; }
    if (!m || !window.QPlayer) return;
    var want = Number(ep) > 0 ? Math.floor(Number(ep)) : 1;
    var gen = ++BILI_PLAY_GEN;
    function fail(msg, state) {
      biliOpenPlayer(m, id, title, want, 0, '');
      window.QPlayer.state(state || 'error', { msg: msg });
    }
    biliResolve(id, title).then(function (v) {
      if (gen !== BILI_PLAY_GEN) return;
      if (!v || !v.bvid || !v.pages || !v.pages.length) { fail('没找到这部番的 B 站源，换夸克源试试'); return; }
      var pg = biliPickPage(v.pages, want);
      if (!pg || !pg.cid) { fail('这一集没有可用的 B 站分P'); return; }
      return biliAuth('playurl', 'POST', { bvid: v.bvid, cid: pg.cid, qn: 80 }, 20000).then(function (r) {
        if (gen !== BILI_PLAY_GEN) return;
        var j = r.j || {};
        if (r.ok && j.ok && j.url) { biliOpenPlayer(m, id, title, want, pg.cid, j.url); return; }
        if (r.status === 401) { fail('站点登录已失效，请重新登录', 'login'); return; }
        if (j.error === 'need_rebind' || j.error === 'not_bound') {
          biliOpenPlayer(m, id, title, want, 0, '');
          /* rebind：76 的默认动作是「去扫码」指向夸克，这里换成个人主页的绑定入口 */
          window.QPlayer.state('rebind', {
            msg: 'B 站登录已失效，去个人主页重新粘贴 SESSDATA',
            actions: [{ label: '去个人主页', href: 'user' }]
          });
          return;
        }
        fail('B 站播放地址取不到，稍后再试');
      });
    }).catch(function () {
      if (gen !== BILI_PLAY_GEN) return;
      if (window.QPlayer && m) fail('B 站播放失败，稍后再试');
    });
  }

  /* 上次看到第几集：沿用 20-state.js 的进度（window.__prog），没有就第 1 集。
     集号在这里定，播放器内的「换线路」只换源不改集。 */
  function biliSavedEp(id) {
    try {
      var p = window.__prog && typeof window.__prog.get === 'function' ? window.__prog.get(id) : null;
      if (p && Number(p.ep) > 0) return Math.floor(Number(p.ep));
    } catch (e) { /* 进度坏了就从头播 */ }
    return 1;
  }

  /* 详情弹窗入口：插进 .acts，与「▶ 播放」（夸克源）并列。
     绑定/未绑定不在这里判 —— 交给 playurl 的 need_rebind/not_bound 兜，
     少一次往返，也不会因为绑定状态过期就藏掉入口。 */
  function biliEntry(m, id, title) {
    var acts = m && m.querySelector ? m.querySelector('.acts') : null;
    if (!acts || acts.querySelector('#biliplay')) return;
    var b = document.createElement('span');
    b.className = 'btn';
    b.id = 'biliplay';
    b.setAttribute('role', 'button');
    b.setAttribute('tabindex', '0');
    b.textContent = '▶ B 站（弹幕版）';
    b.onclick = function () { biliPlayEp(m, id, title, biliSavedEp(id)); };
    b.onkeydown = function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); b.click(); }
    };
    acts.appendChild(b);
  }

  /* 控制台/其它模块的入口；参数顺序与内部实现一致：弹窗容器、番剧 id、片名、集号 */
  window.__biliPlay = biliPlayEp;
