  /* 弹窗代号：每次 openModal 自增，异步回调拿它判断自己这一代是否已被后来打开的番取代 */
  var MODAL_GEN = 0;

  /* 标签胶囊：分片里的 tag 会重复（如《攻壳机动队 SSS》的「神山健治」同时带/不带计数出现），
     先去重再截 12 个，否则重复项会挤掉真实标签。计数表可能晚到（见 ensureTagCounts），
     所以抽成函数，供首次渲染与计数到位后的重绘共用。 */
  function renderTags(rec, el) {
    if (!el) return;
    el.innerHTML = (rec.tags || []).filter(function (t, i, arr) { return arr.indexOf(t) === i; }).slice(0, 12).map(function (t) {
      var n = TAGCNT[t];
      return '<span class="tagpill">' + esc(t) + (n ? '<em>' + n + '</em>' : '') + '</span>';
    }).join('');
  }

  /* 每周更新行（纯函数）：next_at（下一话播出 unix 秒，extra[id][3]）→
       「每周三 12:30 更新 · 下一话 11-05 20:30」
     周几与时刻全按本地时区从 next_at 推算（WD 的下标 0 = 周一，getDay() 的 0 = 周日）；
     没有 next_at 但有周几（rows[6]，1..7）时只给「每周三更新」；两者都无返回空串（不渲染该行）。 */
  function fmtUpd(nextAt, wd) {
    function pad2(n) { return ('0' + n).slice(-2); }    // 两位补零：MM-DD / HH:mm
    var d = nextAt ? new Date(Number(nextAt) * 1000) : null;
    var ok = !!d && !isNaN(d.getTime());
    var wdTxt = ok ? WD[(d.getDay() + 6) % 7] : (wd >= 1 && wd <= 7 ? WD[wd - 1] : '');
    if (!wdTxt) return '';
    if (!ok) return '每' + wdTxt + '更新';
    var hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    return '每' + wdTxt + ' ' + hm + ' 更新 · 下一话 '
      + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + hm;
  }

  /* 当季判定：年份相同且月份落在当前季度（与首页 seasonOf 的口径一致：ceil(m / 3)） */
  function isCurSeason(y, m) {
    var now = new Date();
    if (Number(y) !== now.getFullYear()) return false;
    return Math.ceil(Number(m) / 3) === Math.ceil((now.getMonth() + 1) / 3);
  }

  function openModal(id) {
    var r = ANI.rows.find(function (x) { return x[0] === id; });
    if (!r) return;
    var ex = ANI.extra[id] || [];
    var title = r[2] || r[1];
    /* 当季标记按「这一条」重算：magnet-eps.js 后续插入磁力列表时会读它 */
    window.__CUR_SEASON = isCurSeason(r[4], r[5]);
    var upd = fmtUpd(ex[3], r[6]);
    var m = $('#modal');
    if (!m) return;                              // 页面没有 #modal 壳时别抛引用错
    var host = m, gen = ++MODAL_GEN;             // 这一代弹窗的容器引用与代号
    /* 结构契约：magnet-eps.js 靠 h3 取片名、靠 .acts 定位插入点，别改这两个。
       版式（DESIGN-SPEC §2.2）：.mhero 两栏（200px 封面 + 信息）→ 吸顶 tabs → 单栏 .sect 流。 */
    m.innerHTML = '<button class="x" type="button" aria-label="关闭">×</button>'
      + '<div class="mhero">'
      +   '<img class="mposter" src="' + esc(ANI.poster + id + '.jpg') + '"' + fbAttr([ex[1]]) + ' alt="">'
      +   '<div class="mh-info">'
      +     '<h3>' + esc(title) + '</h3>'
      +     (r[1] !== title ? '<div class="orig">' + esc(r[1]) + '</div>' : '')
      +     '<div class="mbadges">'
      +       (r[4] ? '<span class="mbadge">' + r[4] + (r[5] ? ' 年 ' + r[5] + ' 月' : ' 年') + '</span>' : '')
      +       (r[3] ? '<span class="mbadge">' + esc(TYPE[r[3]] || r[3]) + '</span>' : '')
      +       (r[8] ? '<span class="mbadge">' + r[8] + ' 话</span>' : '')
      +     '</div>'
      +     (upd ? '<div class="mupd" id="mupd">' + esc(upd) + '</div>' : '')
      +     '<div class="mrate-line">'
      +       (r[7] ? '<b class="score">' + Number(r[7]).toFixed(1) + '</b>'
                 + '<span class="stars" style="--p:' + Math.max(0, Math.min(100, Math.round(r[7] * 10))) + '"></span>'
               : '<b class="score dim">暂无评分</b>')
      +       '<span class="votes" id="mvotes"></span>'
      +     '</div>'
      /* .mcollect 不在首屏写占位：收藏统计要等分片数据，rec.co 全空时整块不出现（见 hydrate） */
      +     '<div class="acts">'
      +       '<span class="btn pri" id="watch" type="button">开始观看</span>'
      +       '<span class="btn" id="favbtn" type="button">☆ 追番</span>'
      +       (ex[2] ? '<span class="btn" id="play">▶ 预告</span>' : '')
      +       '<button class="btn" id="mrefresh">⟳ 刷新</button>'
      +     '</div>'
      +   '</div>'
      + '</div>'
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
    m.querySelector('.x').onclick = close;

    /* 开始观看：优先跳分集磁力（真能下载），其次（若还有 B 站播放入口）点它，最后开 Bangumi 页。
       #bplay 入口已删，这里保留判空调用：80-bili.js 自己 querySelector 拿到 null 也有 if (bp) 保护。 */
    var wb = m.querySelector('#watch');
    if (wb) wb.onclick = function () {
      var box = host.querySelector('#epsbox');
      /* 只要 #epsbox 里已经有可点的磁力条目（旧胶囊 .eps-chip / 新行 .mgrow 都带 data-m）就直接滚过去 */
      if (box && box.querySelector('[data-m]')) {
        box.scrollIntoView({ behavior: 'smooth', block: 'center' });
        box.classList.add('flash');
        setTimeout(function () { box.classList.remove('flash'); }, 1200);
        return;
      }
      var bp = host.querySelector('#bplay');
      if (bp) { bp.click(); return; }
      window.open('https://bgm.tv/subject/' + id, '_blank');
    };

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
        /* 状态已落定再通知外部：90-boot.js 监听 favchange，在追番页就地重绘列表（新增/取消都算变化）。
           老浏览器没有 CustomEvent 时静默跳过，不影响按钮自身的显示。 */
        try { document.dispatchEvent(new CustomEvent('favchange')); } catch (e) { /* 忽略 */ }
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

    /* 计数表首次可能晚到：数据到位后若这一代弹窗还活着就用它重绘标签。
       rec 由下面的 hydrate 填；还没到位时直接跳过（那时的首次渲染会读到已就绪的 TAGCNT）。 */
    var rec = null;
    ensureTagCounts(function () {
      if (gen !== MODAL_GEN || !rec) return;
      renderTags(rec, host.querySelector('#tags'));
    });
    bindBili(id, title, r[4] || '');
    var sfx = id % 64;

    /* 分片数据 → DOM。首次加载与「⟳ 刷新」共用这一段：刷新时同一代弹窗原地重绘。 */
    function hydrate(list) {
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
         三块容器：前两块（#sect-chars / #sect-staff）由 openModal 预置，.mcollect 等数据确认后再建，
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
              /* st 每条 = [名, 关系, 头像]；头像镜像后是裸文件名，未镜像的 http(s)
                 会被 avatarSrc 丢弃，此时不输出 .sph，布局回到纯文字。 */
              var sv = avatarSrc(p2[2]);
              return '<div class="staff">'
                + (sv ? '<span class="sph"><img class="sav" src="' + esc(sv) + '" alt="" referrerpolicy="no-referrer" loading="lazy" decoding="async" onerror="this.parentNode.remove()"></span>' : '')
                + '<b>' + esc(p2[0]) + '</b>'
                + (p2[1] ? '<em>' + esc(p2[1]) + '</em>' : '') + '</div>';
            }).join('') + '</div>';
          staff.hidden = false;
        }
      }
      if (Array.isArray(rec.co) && rec.co.some(Boolean)) {
        /* 收藏统计：首屏不写占位，数据确认真有数字才把整块插到 .acts 之前；
           rec.co 全空时这块根本不出现（旧实现恒渲染三个「—」）。 */
        var mcol = host.querySelector('.mcollect');
        if (!mcol) {
          mcol = document.createElement('div');
          mcol.className = 'mcollect';
          mcol.innerHTML = '<span><b>—</b><i>想看</i></span><span><b>—</b><i>在看</i></span>'
            + '<span><b>—</b><i>看过</i></span>';
          var actsEl = host.querySelector('.acts');
          if (actsEl && actsEl.parentNode) actsEl.parentNode.insertBefore(mcol, actsEl);
        }
        var cos = mcol.querySelectorAll('b');
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
    }

    /* 分片缓存取数：命中就复用，未命中才拉；失败不写缓存（下次还能重试） */
    function getShard() {
      var p = shardCache[sfx];
      if (p) return p;
      p = jd('s' + sfx + '.json').then(function (d) { return d; }, function () {
        delete shardCache[sfx];
        return null;
      });
      shardCache[sfx] = p;
      return p;
    }
    getShard().then(function (list) {
      if (gen !== MODAL_GEN) return;      // 这一代已被新打开的番取代：数据与 DOM 都不再属于它
      hydrate(list);
    });

    /* ⟳ 刷新：dropShard 后带 ?v= 重取本片分片并原地重绘；顺带让磁力列表重新拉索引。
       点击期间禁用防连点，成败都恢复。__epsApi.reload 缺失时跳过（不报错）。 */
    var rf = m.querySelector('#mrefresh');
    if (rf) rf.onclick = function () {
      if (rf.disabled) return;
      rf.disabled = true;
      var old = rf.textContent;
      rf.textContent = '⟳ 刷新中…';
      dropShard(sfx);
      var api = window.__epsApi;
      if (api && typeof api.reload === 'function') {
        /* 原名一起传：与上面 h3/.orig 的取值口径一致（title = r[2] || r[1]），
           中文标题和发布名差得远时，只按标题查会漏。 */
        try { api.reload(title, r[8] || 0, r[1] !== title ? r[1] : ''); } catch (e) { /* 磁力刷新失败不影响简介重取 */ }
      }
      jd('s' + sfx + '.json', { bust: true }).then(function (d) {
        shardCache[sfx] = Promise.resolve(d);     // 回填缓存：关掉再开不必重拉
        if (gen !== MODAL_GEN) return;
        /* 评分分布有「只画一次」的保护，刷新先把旧图摘掉，否则新数据进不去 */
        var rd = host.querySelector('#rdist');
        if (rd && rd.parentNode) rd.parentNode.removeChild(rd);
        hydrate(d);
      }, function () {
        if (gen === MODAL_GEN) hydrate(null);     // 走「简介加载失败，请重试」那条
      }).then(function () {
        rf.textContent = old;
        rf.disabled = false;
      });
    };
  }
  /* 关弹窗要把内容一起清掉：旧实现只摘 #mask 的 on，预告 iframe 会在后台继续播放，
     下次打开还留着上一次的残留节点。容器 #modal 本身保留（openMagView 复用它当外壳）。 */
  function close() {
    var m = $('#modal');
    if (m) {
      var tr = m.querySelectorAll('.trailer');
      for (var i = 0; i < tr.length; i++) { if (tr[i].parentNode) tr[i].parentNode.removeChild(tr[i]); }
      m.innerHTML = '';
    }
    $('#mask').classList.remove('on');
  }

  /* ---------------- 详情内磁力视图（整屏视图，不跳首页标签） ----------------
     复用同一个 #modal 外壳整体换内容。（整屏磁力入口按钮已删除，磁力改在详情页内分组展示；
     函数本体保留，供以后复用 / 已有调用方。）‹ 返回详情 重新走
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
