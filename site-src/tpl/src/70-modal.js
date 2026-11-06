  /* 弹窗代号：每次 openModal 自增，异步回调拿它判断自己这一代是否已被后来打开的番取代 */
  var MODAL_GEN = 0;

  /* 深链写地址栏：只改 id 这一个参数，其它（?tag= / ?fav=1）原样保留 ——
     pushState/replaceState 换的是整条 URL，直接传 '?id=x' 会把筛选条件弄丢。 */
  function urlWithId(id) {
    var parts = location.search.replace(/^\?/, '').split('&');
    var out = [], put = false;
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      if (/^id=/.test(parts[i])) {
        if (put) continue;
        out.push('id=' + encodeURIComponent(id));
        put = true;
      } else out.push(parts[i]);
    }
    if (!put) out.push('id=' + encodeURIComponent(id));
    return location.pathname + '?' + out.join('&');
  }

  /* 标签胶囊：分片里的 tag 会重复（如《攻壳机动队 SSS》的「神山健治」同时带/不带计数出现），
     先去重再截 12 个，否则重复项会挤掉真实标签。计数表可能晚到（见 ensureTagCounts），
     所以抽成函数，供首次渲染与计数到位后的重绘共用。 */
  function renderTags(rec, el) {
    if (!el) return;
    el.innerHTML = (rec.tags || []).filter(function (t, i, arr) { return arr.indexOf(t) === i; }).slice(0, 12).map(function (t) {
      var n = TAGCNT[t];
      /* 标签可点：静态站同目录的番剧页用 ?tag= 接深链，交给浏览器导航，不拦点击、不关弹窗 */
      var href = '/anime?tag=' + encodeURIComponent(t);
      return '<a class="tagpill" href="' + esc(href) + '">' + esc(t) + (n ? '<em>' + n + '</em>' : '') + '</a>';
    }).join('');
  }

  function openModal(id) {
    var r = ANI.rows.find(function (x) { return x[0] === id; });
    if (!r) return;
    var ex = ANI.extra[id] || [];
    var title = r[2] || r[1];
    var m = $('#modal');
    if (!m) return;                              // 页面没有 #modal 壳时别抛引用错
    /* 播放源面板的当前集：与整页详情同一口径（有进度跟进度，否则第 1 集） */
    var curEp = 1;
    var prog = progressOf(id);
    if (prog && Number(prog.ep) > 0) curEp = Math.floor(Number(prog.ep));
    var host = m, gen = ++MODAL_GEN;             // 这一代弹窗的容器引用与代号
    /* 结构契约：magnet-eps.js 靠 h3 取片名、靠 .acts 定位插入点，别改这两个。
       版式（DESIGN-SPEC §2.2）：.mhero 两栏（200px 封面 + 信息）→ 吸顶 tabs → 单栏 .sect 流。 */
    m.innerHTML = '<button class="x" type="button" aria-label="关闭">×</button>'
      + '<div class="mhero">'
      +   '<img class="mposter" src="' + esc(posterSrc(id)) + '"' + posterFb(id, ex) + ' alt="">'
      +   '<div class="mh-info">'
      +     '<h3>' + esc(title) + '</h3>'
      +     (r[1] !== title ? '<div class="orig">' + esc(r[1]) + '</div>' : '')
      +     '<div class="mbadges">'
      +       (r[4] ? '<span class="mbadge">' + r[4] + (r[5] ? ' 年 ' + r[5] + ' 月' : ' 年') + '</span>' : '')
      +       (r[3] ? '<span class="mbadge">' + esc(TYPE[r[3]] || r[3]) + '</span>' : '')
      +       (r[8] ? '<span class="mbadge">' + r[8] + ' 话</span>' : '')
      +     '</div>'
      +     '<div class="mrate-line">'
      +       (r[7] ? '<b class="score">' + Number(r[7]).toFixed(1) + '</b>'
                 + '<span class="stars" style="--p:' + Math.max(0, Math.min(100, Math.round(r[7] * 10))) + '"></span>'
               : '<b class="score dim">暂无评分</b>')
      +       '<span class="votes" id="mvotes"></span>'
      +     '</div>'
      +     '<div class="mcollect">'
      +       '<span><b>—</b><i>想看</i></span><span><b>—</b><i>在看</i></span><span><b>—</b><i>看过</i></span>'
      +     '</div>'
      +     '<div class="acts">'
      +       '<span class="btn pri" id="watch" role="button" tabindex="0">▶ 播放</span>'
      +       '<span class="btn" id="favbtn" type="button">☆ 追番</span>'
      +       (ex[2] ? '<span class="btn" id="play">▶ 预告</span>' : '')
      +       '<a class="btn" target="_blank" rel="noopener" href="https://search.bilibili.com/all?keyword='
      +         encodeURIComponent(title) + '">B 站搜索</a>'
      +     '</div>'
      +   '</div>'
      + '</div>'
      /* 播放源聚合面板：放在 .mtabs 之前、.trailer.qplayer 之外（面板自带 .qp-line-list，
         塞进播放器 root 会和 76 的 renderLines 抢同一个选择器） */
      + srcPanelHtml(id, title, curEp)
      + '<div class="mtabs">'
      +   '<button class="mtab on" data-p="detail" type="button">详情</button>'
      +   '<button class="mtab" data-p="rt" type="button">评价</button>'
      +   '<button class="mtab" data-p="dm" type="button">弹幕</button>'
      +   '<button class="mtab" data-p="rp" type="button">评论</button>'
      + '</div>'
      + '<div class="mbody" data-p="detail">'
      +   '<section class="sect"><div class="sec-h"><h2>简介</h2></div><p class="plot" id="plot">加载中…</p></section>'
      +   '<section class="sect"><div class="sec-h"><h2>标签</h2></div><div class="tagpills" id="tags"></div></section>'
      +   '<section class="sect" id="sect-chars" hidden></section>'
      +   '<section class="sect" id="sect-staff" hidden></section>'
      + '</div>'
      + '<div class="mbody" data-p="rt" hidden><div class="sect"><div class="sec-h"><h2>评分分布</h2></div><div id="prt"></div></div></div>'
      + '<div class="mbody" data-p="dm" hidden><div id="pdm"></div></div>'
      + '<div class="mbody" data-p="rp" hidden><div id="prp"></div></div>';
    $('#mask').classList.add('on');
    /* 磁力查询/身份校验都以 bgm id 为准：标题会漂移、会重名，id 不会 */
    if (m && m.setAttribute) m.setAttribute('data-bgm', String(id));
    m.querySelector('.x').onclick = close;

    /* 「▶ 播放」= 自研播放器（75-quarkplay.js 的 openQuarkPlay）：只跟盒子服务要一条 CDN
       mp4 地址，字节不经服务器。同 IIFE 内的函数声明会提升，这里直接调用。
       span 的 role=button 不会自带键盘激活，键位一并补上。 */
    var wb = m.querySelector('#watch');
    if (wb) {
      wb.onclick = function () { openQuarkPlay(m, id, title); };
      wb.onkeydown = function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); wb.click(); }
      };
    }

    /* 追番：复用卡片星标同一套存储（key 用条目 id） */
    var fb = m.querySelector('#favbtn');
    if (fb) {
      var fk = String(id);
      fb.textContent = isFollowed(fk) ? '★ 已追' : '☆ 追番';
      fb.classList.toggle('on', isFollowed(fk));
      fb.onclick = function () {
        var now = toggleFollow(fk);
        fb.textContent = now ? '★ 已追' : '☆ 追番';
        fb.classList.toggle('on', now);
      };
    }

    if (ex[2]) {
      $('#play').onclick = function () {
        if (host.querySelector('.trailer')) return;
        var d = document.createElement('div');
        d.className = 'trailer';
        d.innerHTML = '<iframe src="https://www.youtube.com/embed/' + encodeURIComponent(ex[2])
          + '?autoplay=1&rel=0" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>';
        m.appendChild(d);
      };
    }

    /* 深链：详情打开后把 id 写进地址栏，刷新/分享都能回到同一部。
       地址栏已经是同一个 id 就不再 push —— 「磁力视图 → ‹ 返回详情」会重跑 openModal，
       否则历史里会叠出一条一模一样的记录。 */
    try {
      if (history.pushState && !new RegExp('[?&]id=' + id + '(?:&|$)').test(location.search)) {
        history.pushState({ id: String(id) }, '', urlWithId(id));
      }
    } catch (e) { /* 沙箱/隐私模式里 pushState 受限：深链只是增强，不影响弹窗本身 */ }

    /* 计数表首次可能晚到：数据到位后若这一代弹窗还活着就用它重绘标签。
       rec 由下面的 pr.then 填；还没到位时直接跳过（那时的首次渲染会读到已就绪的 TAGCNT）。 */
    var rec = null;
    ensureTagCounts(function () {
      if (gen !== MODAL_GEN || !rec) return;
      renderTags(rec, host.querySelector('#tags'));
    });
    bindBili(id, title, r[4] || '');
    /* 播放源面板：只探测不播放；挂载点在面板已进 DOM 之后（60s 内重开同一部不重探） */
    srcPanelMount(m, id, title, curEp);
    var sfx = id % 64;
    var pr = shardCache[sfx];
    if (!pr) {
      pr = jd('s' + sfx + '.json').then(function (d) { return d; }, function () {
        delete shardCache[sfx];          // 失败不缓存，下次还能重试
        return null;
      });
      shardCache[sfx] = pr;
    }
    pr.then(function (list) {
      if (gen !== MODAL_GEN) return;      // 这一代已被新打开的番取代：数据与 DOM 都不再属于它
      var plot = host.querySelector('#plot');
      if (!plot) return;      // close() 已清空 / 已切到磁力视图：这一代内容没了，别再往空节点写
      if (list === null) { plot.textContent = '简介加载失败，请重试'; return; }  // 分片拉不到，与「记录不存在」区分
      rec = (list || []).find(function (x) { return x.id === id; });
      if (!rec) { plot.textContent = '暂无详细资料'; return; }
      /* 简介里常带 3 行以上连续空行（原文分段残留），pre-wrap 下会撑出大块空白 */
      plot.textContent = String(rec.overview || '暂无简介').replace(/\n{3,}/g, '\n\n');
      renderTags(rec, host.querySelector('#tags'));
      var meta = [];
      /* 评分分布放进「评价」tab（10 根柱子，高度按各档人数归一） */
      if (Array.isArray(rec.rc) && rec.rc.length === 10 && !host.querySelector('#rdist')) {
        var prt = host.querySelector('#prt');
        if (prt) {
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
          div.innerHTML = '<div class="rdhead">星级分布合计 <b>' + sum + '</b> 人'
            + (rec.rank ? ' · 排名 <b>#' + rec.rank + '</b>' : '')
            + (rec.votes ? ' · Bangumi 共 ' + rec.votes + ' 人评分' : '') + '</div>' + bars;
          prt.appendChild(div);
        }
      }
      /* 角色 / 制作人员 / 收藏统计 —— 数据来自 CI 抓的 ch/st/co。
         三块容器在 openModal 里已预置（#sect-chars / #sect-staff / .mcollect 的三个 b），
         这里只填内容、把 hidden 打开，不再往 #tags 后面插新节点。 */
      if (Array.isArray(rec.ch) && rec.ch.length) {
        var chars = host.querySelector('#sect-chars');
        if (chars) {
          chars.innerHTML = '<div class="sec-h"><h2>角色</h2></div><div class="chgrid">'
            + rec.ch.map(function (c) {
              var av = avatarSrc(c[2]);
              var nm = esc(c[0]);
              /* 首字常驻在下、图片叠在上：图 404 时 onerror 把 img 摘掉，首字自然露出 */
              return '<div class="chcard"><span class="ph">'
                + '<span class="chin">' + esc(Array.from(String(c[0] == null ? '' : c[0]))[0] || '?') + '</span>'
                + (av ? '<img class="chav" src="' + esc(av) + '" alt="" referrerpolicy="no-referrer" loading="lazy" decoding="async" onerror="this.remove()">' : '')
                + '</span>'
                + '<div class="chinfo"><b>' + nm + '</b><em>' + esc(c[1]) + '</em></div></div>';
            }).join('') + '</div>';
          chars.hidden = false;
        }
      }
      if (Array.isArray(rec.st) && rec.st.length) {
        var staff = host.querySelector('#sect-staff');
        if (staff) {
          staff.innerHTML = '<div class="sec-h"><h2>制作人员</h2></div><div class="staffgrid">'
            + rec.st.map(function (p2) {
              return '<div class="staff"><b>' + esc(p2[0]) + '</b>'
                + (p2[1] ? '<em>' + esc(p2[1]) + '</em>' : '') + '</div>';
            }).join('') + '</div>';
          staff.hidden = false;
        }
      }
      if (Array.isArray(rec.co) && rec.co.some(Boolean)) {
        var cos = host.querySelectorAll('.mcollect b');
        for (var ci = 0; ci < cos.length && ci < 3; ci++) {
          cos[ci].textContent = rec.co[ci] == null ? '—' : String(rec.co[ci]);
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
      var mv = host.querySelector('#mvotes'); if (mv) mv.textContent = meta.join(' · ');
    });
  }
  /* 关弹窗要把内容一起清掉：旧实现只摘 #mask 的 on，预告 iframe 会在后台继续播放，
     下次打开还留着上一次的残留节点。容器 #modal 本身保留（openMagView 复用它当外壳）。 */
  function close() {
    /* 整页详情里 #modal 就是页面主体：Esc / popstate / 点 #mask 都别把它清空 */
    if (PAGE === 'detail') return;
    var m = $('#modal');
    if (m) {
      var tr = m.querySelectorAll('.trailer');
      for (var i = 0; i < tr.length; i++) { if (tr[i].parentNode) tr[i].parentNode.removeChild(tr[i]); }
      m.innerHTML = '';
    }
    $('#mask').classList.remove('on');
    /* 关掉详情就把地址栏的 ?id= 摘掉。用 replaceState 而不是 pushState：
       否则每关一次弹窗就多一条历史，用户按后退会又弹回来。
       ?tag= / ?fav=1 等其它参数原位保留（正则只吃 id 这一段）。 */
    try {
      if (/[?&]id=/.test(location.search)) {
        var rest = location.search.replace(/([?&])id=[^&]*&?/, '$1').replace(/[?&]$/, '');
        history.replaceState(null, '', location.pathname + rest);
      }
    } catch (e) { /* 同上：地址栏清理失败不影响关闭 */ }
  }

  /* ---------------- 详情内磁力视图（「磁力详情」按钮进来，不跳首页标签） ----------------
     复用同一个 #modal 外壳整体换内容：.acts 里的 #mgopen 触发，‹ 返回详情 重新走
     openModal（.mtabs / #epsbox 那套绑定与注入随之重建）。分集与合集的整段列表都交给
     magnet-eps.js 的 epsListHtml(entry)（自带 .mgsect + .sec-h + .mgrows，分集/合集标题
     与行都在里面），点击复制由 arm() 挂在 #modal 上的委托接管（带 data-m 的条目），这里不绑。 */
  function openMagView(id, name, epsN) {
    var m = $('#modal');
    var api = window.__epsApi;
    if (!m || !api) return;
    m.innerHTML = '<button class="x" type="button" aria-label="关闭">×</button>'
      + '<div class="bhead lv2"><h2>' + esc(name) + ' · 磁力</h2><span>'
      +   '<button class="mgback" id="mgback" type="button">‹ 返回详情</button>'
      + '</span></div>'
      + '<div id="mgbody"><div class="loading">磁力索引加载中…</div></div>';
    $('#mask').classList.add('on');
    m.querySelector('.x').onclick = close;
    var back = m.querySelector('#mgback');
    if (back) back.onclick = function () { openModal(id); };   // 回详情：重跑 openModal 重建绑定

    var body = m.querySelector('#mgbody');
    /* 用户可能在这几秒里点了返回 / 关闭：节点已离开文档就不再写 */
    function alive() { return body && body.isConnected; }
    var fail = function () {
      if (!alive()) return;
      body.innerHTML = '<div class="eps-none">这部暂无磁力索引</div>';
    };

    api.loadShard(api.shardOf(name)).then(function (store) {
      if (!store) return null;
      return store[String(id)] || (api.findByName ? api.findByName(store, name) : null);
    }, function () { return null; }).then(function (entry) {
      if (entry) return entry;
      return api.live(name, epsN || 0, '');
    }).then(function (entry) {
      if (!alive()) return;
      if (!entry) return fail();
      var h = '';
      /* 分集与合集的区块标题、行式列表、复制态全部由 epsListHtml(entry) 出（它自带
         .mgsect + .sec-h + .mgrows），这里不再自己拼 .mgsect，也不再调 chipOf/batchLabel/descOf。 */
      h += window.__epsApi.epsListHtml(entry);
      body.innerHTML = h || '<div class="eps-none">暂无按集索引</div>';
    }).catch(fail);
  }
