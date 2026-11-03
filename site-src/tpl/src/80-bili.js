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
      + sel + '<div class="dmlist">' + rows + '</div>';
  }

  function renderRp(box, d) {
    if (!d || !d.ok) { box.innerHTML = '<div class="mnote">评论取不到（' + ((d && d.error) || '网络') + '）</div>'; return; }
    if (!d.items.length) { box.innerHTML = '<div class="mnote">还没有评论</div>'; return; }
    box.innerHTML = '<div class="mnote">共 ' + d.total + ' 条 · 来源 B 站</div>'
      + d.items.map(function (it) {
        var dt = it.t ? new Date(it.t * 1000) : null;
        var day = dt ? (dt.getFullYear() + '-' + ('0' + (dt.getMonth() + 1)).slice(-2) + '-' + ('0' + dt.getDate()).slice(-2)) : '';
        return '<div class="rprow' + (it.re === 1 ? ' re' : '') + '">'
          + (it.a ? '<img src="' + esc(it.a) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">' : '')
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
    var bp = m.querySelector('#bplay');
    if (bp) {
      bp.onclick = function () {
        bp.textContent = '匹配中…';
        biliResolve(id, title, year).then(function (v) {
          if (!v || !v.pages || !v.pages.length) { bp.textContent = '▶ B 站弹幕播放'; bp.setAttribute('data-miss', '1'); return; }
          bp.textContent = '▶ B 站弹幕播放';
          var page = 1;
          var on = m.querySelector('#pdm [data-pg].on');
          if (on) page = Number(on.getAttribute('data-pg')) || 1;
          var old = m.querySelector('.trailer');
          if (old) old.remove();
          var oldBar = m.querySelector('.bplay-bar');
          if (oldBar) oldBar.remove();
          /* find 只搜 UGC，OP/ED/MV/合集常把正片顶掉：score<0 时仍允许播放，
             但明确标注这是「最接近的一个相关视频」。 */
          var score = biliScore(v, title);
          var bvid = v.bvid;
          var mkSrc = function (pg) {
            return 'https://player.bilibili.com/player.html?bvid=' + encodeURIComponent(bvid)
              + '&page=' + pg + '&autoplay=1&danmaku=1&high_quality=1';
          };
          var barHtml = '';
          if (score < 0) barHtml += '<div class="mnote">未找到正片源，这是 B 站上最接近的视频（可能是 OP/剪辑/相关视频）</div>';
          if (score < 2) barHtml += '<div class="mnote">B 站官方番剧多为会员专享，这里的「集」是 UP 主上传的分P，不一定对应正片集数</div>';
          if (v.pages.length >= 2) {
            barHtml += '<select id="bsel">' + v.pages.map(function (p, i) {
              return '<option value="' + (p.page || i + 1) + '">' + esc(p.part || ('第 ' + (i + 1) + ' 集')) + '</option>';
            }).join('') + '</select>';
          }
          if (barHtml) {
            var bar = document.createElement('div');
            bar.className = 'bplay-bar';
            bar.innerHTML = barHtml;
            m.appendChild(bar);
          }
          var d = document.createElement('div');
          d.className = 'trailer';
          d.innerHTML = '<iframe src="' + mkSrc(page) + '" '
            + 'allow="autoplay; fullscreen" allowfullscreen referrerpolicy="no-referrer"></iframe>';
          m.appendChild(d);
          var selEl = m.querySelector('#bsel');
          if (selEl) {
            selEl.value = String(page);
            selEl.onchange = function () {
              var fr = d.querySelector('iframe');
              if (fr) fr.src = mkSrc(Number(selEl.value) || 1);
            };
          }
        });
      };
    }
  }
