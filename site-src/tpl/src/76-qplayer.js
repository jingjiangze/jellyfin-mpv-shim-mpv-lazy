  /* ---------------- 自研播放器（零依赖原生 <video>，76-qplayer.js） ----------------
     为什么不用第三方播放器：要放的东西只有两类直链 —— 盒子签发的夸克 CDN 地址，
     以及用户自己粘贴的 m3u8 / mp4。只需要 <video> 加一层控件；引 hls.js / CDN
     反而多一个失败点，也违背「不引入第三方」的约束。

     DOM 外壳必须是 .trailer.qplayer：70-modal.js 的 close() 与预告 iframe 共用
     .trailer 的清理逻辑（先 pause + 断源，再摘节点），换外壳会让关闭时视频继续出声。

     契约（75-quarkplay.js 调用）：
       QPlayer.open(ctx) → token
         ctx = {m, id, title, ep, sources:[{label,url,type}], startAt,
                dm: {cid, items},          // 可选：给了 items 直接用，只给 cid 则播放器自己拉 /bili/dm
                onProgress, onEnded, onNext, onPickEp, onRetry}
       QPlayer.state(s, extra)   s ∈ loading|transcoding|none|login|quota|rebind|error|ready
       QPlayer.play(url, label, opt)   切一条直链并播放（opt = {fid, startAt}）
       QPlayer.setSources(list)        替换「官方源」部分（用户自备线路不受影响）
       QPlayer.setEpisodes(list, cur, hint)
       QPlayer.setFid(fid)             进度上报要带的网盘文件 id
       QPlayer.setDanmaku(items)       装/换一集弹幕（空数组 = 关闭），切换集时调用即重置
       QPlayer.toggleDanmaku(on) / QPlayer.danmakuOn()   弹幕开关（偏好存 qp_dm_on）
       QPlayer.clearDanmaku()          清空并停 rAF（close() 内部也会调）
       QPlayer.close()                 幂等

     BYO 线路存 localStorage['qp_lines']：{"<bgm id>":[{label,url,type}]}。
     不内置任何第三方解析线路，也不替用户向任何站点取流。 */
  var QP_LINES_KEY = 'qp_lines';
  var QP_LINE_MAX = 20;                       // 单番最多存 20 条自备线路，防 localStorage 膨胀
  var QP_RATES = [2, 1.5, 1.25, 1, 0.75];     // 倍速循环（初始 1.0×，按钮按数组顺序轮转）
  var QP_REBIND = 'https://120.48.56.189/qr/';

  /* ---------------- 弹幕常量 ----------------
     DM_BASE 是盒子自己的地址（弹幕接口 /bili/dm?cid=… 挂在同域），写常量而不是相对路径，
     是因为 76 也会被 app.js 拼接进别的路径下（/bili/xxx 这类），相对路径会指错地方。 */
  var DM_BASE = 'https://120.48.56.189';
  var QP_DM_KEY = 'qp_dm_on';                    // 弹幕开关偏好：'1' / '0'
  var DM_SPEED = 144;                            // 滚动弹幕速度 px/s（B 站量级；舞台变窄也不会挤成一团）
  var DM_FIX_S = 4;                              // 顶部 / 底部固定弹幕停留秒数
  var DM_LATE = 1;                               // 晚于这个秒数的弹幕直接丢（切后台 / 卡顿后不补投）
  var DM_MAX_ITEMS = 20000;                      // 单集最多装 2 万条，防脏数据把内存撑爆
  var DM_TEXT_MAX = 120;                         // 单条文本上限（B 站单条 100 字）
  var DM_FONT = 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';

  var QPlayer = (function () {
    /* 静态骨架：不含任何用户数据，动态内容一律 textContent / 事件绑定 */
    var TPL = '<div class="qp-head"><b class="qp-title"></b><span class="qp-sub"></span>'
      + '<button class="qp-btn qp-dm-toggle" type="button" aria-label="弹幕开关">弹幕 开</button>'
      + '<button class="qp-btn qp-close" type="button" aria-label="关闭播放器">×</button></div>'
      + '<div class="qp-stage"><video class="qp-video" playsinline preload="metadata"></video>'
      + '<canvas class="qp-dm" aria-hidden="true"></canvas>'
      + '<button class="qp-bigplay" type="button" hidden>▶</button>'
      + '<div class="qp-overlay"><div class="qp-spinner"></div><p class="qp-msg"></p>'
      + '<div class="qp-actions" hidden></div></div></div>'
      + '<div class="qp-bar">'
      + '<button class="qp-btn qp-play" type="button" aria-label="播放 / 暂停">⏸</button>'
      + '<input class="qp-seek" type="range" min="0" max="1000" value="0" aria-label="播放进度">'
      + '<span class="qp-time"><i class="qp-cur">00:00</i>/<i class="qp-dur">00:00</i></span>'
      + '<button class="qp-btn qp-mute" type="button" aria-label="静音">🔊</button>'
      + '<input class="qp-vol" type="range" min="0" max="100" value="100" aria-label="音量">'
      + '<button class="qp-btn qp-rate" type="button" aria-label="倍速">1.0×</button>'
      + '<button class="qp-btn qp-pip" type="button">画中画</button>'
      + '<button class="qp-btn qp-fs" type="button">全屏</button>'
      + '</div>'
      + '<div class="qp-nextbar" hidden><button class="qp-next" type="button">下一集 →</button>'
      + '<span class="qp-autonext"></span><button class="qp-cancel" type="button">取消</button></div>'
      + '<section class="qp-eps" data-open="1">'
      + '<div class="qp-eps-h"><h4>选集</h4><span class="qp-eps-hint"></span>'
      + '<button class="qp-eps-toggle" type="button">收起</button></div>'
      + '<div class="qp-eps-list" role="listbox" aria-label="选集"></div>'
      + '</section>'
      + '<section class="qp-lines" data-open="0">'
      + '<div class="qp-lines-h"><h4>线路</h4><button class="qp-lines-toggle" type="button">展开</button></div>'
      + '<div class="qp-lines-body">'
      + '<input class="qp-line-url" type="url" placeholder="粘贴 m3u8 / mp4 直链（自备源）" aria-label="线路地址">'
      + '<input class="qp-line-label" type="text" placeholder="线路名称（可选）" aria-label="线路名称">'
      + '<button class="qp-btn qp-line-add" type="button">添加并播放</button>'
      + '<div class="qp-line-list"></div>'
      + '</div></section>';

    var STATES = {
      loading: { msg: '正在准备播放…' },
      transcoding: { msg: '转码中… 约 1 分钟' },
      none: { msg: '没有找到可播放的视频源' },
      login: { msg: '登录后才能使用网盘播放' },
      quota: { msg: '网盘空间不足，清理后再试' },
      rebind: { msg: '夸克登录已失效，请重新扫码' },
      error: { msg: '播放失败，请重试或换源' },
      ready: { msg: '' }
    };

    var SEQ = 0;
    var cur = null;              // 同一时刻只有一个播放器（弹窗是单例）

    function pad2(n) { return (n < 10 ? '0' : '') + n; }

    function fmtTime(t) {
      t = Math.max(0, Math.floor(Number(t) || 0));
      var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
      return (h ? h + ':' + pad2(m) : pad2(m)) + ':' + pad2(s);
    }

    function rateLabel(r) { return (r % 1 === 0 ? r.toFixed(1) : String(r)) + '×'; }

    function isUrl(u) {
      u = String(u || '');
      return /^(https?:|blob:)/i.test(u) || /^data:video\//i.test(u);
    }

    function typeOf(u) { return /\.m3u8(?:[?#]|$)/i.test(String(u || '')) ? 'hls' : 'mp4'; }

    /* Safari / iOS 原生支持 HLS；Chrome / Firefox 的 canPlayType 一律返回空串。
       不支持时不偷偷降级（不引 hls.js），直接给用户一句明确的话。 */
    function hlsSupported(v) {
      try { return !!(v && v.canPlayType && v.canPlayType('application/vnd.apple.mpegurl')); }
      catch (e) { return false; }
    }

    function labelOf(u) {
      try { return new URL(u).hostname || '直链'; } catch (e) { return '直链'; }
    }

    /* ---------------- BYO 线路存储 ---------------- */
    function readStore() {
      try {
        var v = JSON.parse(localStorage.getItem(QP_LINES_KEY) || '{}');
        return v && typeof v === 'object' && Object.prototype.toString.call(v) !== '[object Array]' ? v : {};
      } catch (e) { return {}; }
    }
    function writeStore(obj) {
      try { localStorage.setItem(QP_LINES_KEY, JSON.stringify(obj)); } catch (e) { /* 隐私模式 / 配额满：静默 */ }
    }
    function byoOf(id) {
      var arr = readStore()[String(id)];
      return Object.prototype.toString.call(arr) === '[object Array]' ? arr : [];
    }
    function cleanLine(x) {
      if (!x || !isUrl(x.url)) return null;
      var u = String(x.url);
      return { label: String(x.label || ''), url: u, type: x.type === 'hls' ? 'hls' : typeOf(u) };
    }
    function saveByo(id, rec) {
      var all = readStore(), k = String(id), arr = byoOf(k), out = [];
      for (var i = 0; i < arr.length; i++) {
        var x = cleanLine(arr[i]);
        if (!x || x.url === rec.url) continue;      // 同 URL 去重：新记录排最前
        out.push(x);
      }
      out.unshift({ label: String(rec.label || ''), url: rec.url, type: rec.type === 'hls' ? 'hls' : typeOf(rec.url) });
      all[k] = out.slice(0, QP_LINE_MAX);
      writeStore(all);
    }
    function delByo(id, url) {
      var all = readStore(), k = String(id), arr = byoOf(k), out = [];
      for (var i = 0; i < arr.length; i++) {
        var x = cleanLine(arr[i]);
        if (x && x.url !== url) out.push(x);
      }
      all[k] = out;
      writeStore(all);
    }

    /* ---------------- 实例 ---------------- */
    function alive(S) { return !!(S && !S.dead && S.root && S.root.isConnected); }

    function addLine(S, src) {
      if (!src || !isUrl(src.url)) return -1;
      var url = String(src.url);
      for (var i = 0; i < S.lines.length; i++) {
        if (S.lines[i].url === url) {
          if (src.label) S.lines[i].label = String(src.label).trim() || S.lines[i].label;
          return i;                                 // 同地址只留一条（换 label 不必重开）
        }
      }
      S.lines.push({
        label: String(src.label || '').trim() || labelOf(url),
        url: url,
        type: src.type === 'hls' || src.type === 'mp4' ? src.type : typeOf(url),
        kind: src.kind === 'byo' ? 'byo' : 'official',
        fid: String(src.fid || ''),
        tried: false,
        err: ''
      });
      return S.lines.length - 1;
    }

    function renderLines(S) {
      var box = S.root.querySelector('.qp-line-list');
      if (!box) return;
      box.innerHTML = S.lines.map(function (l, i) {
        var on = i === S.lineIdx;
        var cls = 'qp-line' + (on ? ' on' : '') + (l.tried && !on ? ' is-bad' : '');
        return '<span class="qp-line-row">'
          + '<button class="' + cls + '" type="button" data-i="' + i + '" title="'
          + esc(l.err || l.url) + '">' + esc(l.label) + '</button>'
          + (l.kind === 'byo'
            ? '<button class="qp-line-del" type="button" data-i="' + i + '" aria-label="删除线路">×</button>'
            : '')
          + '</span>';
      }).join('');
    }

    function renderEps(S, hint) {
      if (hint !== undefined) S.epsHint = String(hint || '');
      var list = S.root.querySelector('.qp-eps-list');
      if (!list) return;
      list.innerHTML = S.eps.map(function (e) {
        var on = Number(e.ep) === Number(S.ep);
        return '<button class="qp-ep' + (on ? ' on' : '') + '" type="button" role="option" data-ep="'
          + e.ep + '" aria-selected="' + (on ? 'true' : 'false') + '">' + esc(e.label) + '</button>';
      }).join('');
      var h = S.root.querySelector('.qp-eps-hint');
      if (h) h.textContent = S.epsHint;
    }

    function defaultEpsHint(list) {
      return list.length ? list.length + ' 集' : '暂无选集信息';
    }

    function updateSub(S) {
      var sub = S.root.querySelector('.qp-sub');
      if (!sub) return;
      var bits = [];
      if (S.ep > 0) bits.push('第 ' + S.ep + ' 集');
      var l = S.lines[S.lineIdx];
      if (l) bits.push(l.label);
      sub.textContent = bits.join(' · ');
    }

    /* 关闭选集 / 线路的折叠面板；按钮文案跟着翻 */
    function toggleSec(sec, btnSel) {
      if (!sec) return;
      var open = sec.getAttribute('data-open') !== '1';
      sec.setAttribute('data-open', open ? '1' : '0');
      var b = sec.querySelector(btnSel);
      if (b) b.textContent = open ? '收起' : '展开';
    }
    function setSecOpen(sec, btnSel, open) {
      if (!sec) return;
      sec.setAttribute('data-open', open ? '1' : '0');
      var b = sec.querySelector(btnSel);
      if (b) b.textContent = open ? '收起' : '展开';
    }

    /* ---------------- 状态机 ---------------- */
    function actionsFor(S, s) {
      if (s === 'login') return [{ label: '登录', fn: function () { if (window.__openLogin) window.__openLogin('email'); } }];
      if (s === 'rebind') return [{ label: '去扫码', href: QP_REBIND }];
      if (s === 'quota') return [{ label: '重试', fn: function () { retry(S); } }];
      if (s === 'error') return [
        { label: '重试', fn: function () { retry(S); } },
        { label: '换源', fn: function () { setSecOpen(S.root.querySelector('.qp-lines'), '.qp-lines-toggle', true); } }
      ];
      if (s === 'none') return [{ label: '换源', fn: function () { setSecOpen(S.root.querySelector('.qp-lines'), '.qp-lines-toggle', true); } }];
      return [];
    }

    function setState(S, s, extra) {
      if (!alive(S)) return;
      var def = STATES[s] || STATES.loading;
      var x = extra || {};
      S.state = s;
      S.root.setAttribute('data-state', s);
      var msg = S.root.querySelector('.qp-msg');
      if (msg) msg.textContent = x.msg || def.msg || '';
      var box = S.root.querySelector('.qp-actions');
      if (box) {
        var acts = x.actions || actionsFor(S, s);
        box.textContent = '';
        if (!acts.length) box.hidden = true;
        else {
          box.hidden = false;
          acts.forEach(function (a) {
            var b;
            if (a && a.href) {
              b = document.createElement('a');
              b.className = 'btn qp-act';
              b.href = a.href;
              b.target = '_blank';
              b.rel = 'noopener';
            } else {
              b = document.createElement('button');
              b.className = 'btn qp-act';
              b.type = 'button';
              b.onclick = function () { if (alive(S) && typeof a.fn === 'function') a.fn(); };
            }
            b.textContent = (a && a.label) || '';
            box.appendChild(b);
          });
        }
      }
      if (s !== 'loading' && s !== 'transcoding') hideBigPlay(S);
    }

    function state(s, extra) {
      if (!cur) return;
      setState(cur, s, extra);
    }

    /* ---------------- 播放控制 ---------------- */
    function showBigPlay(S) {
      var b = S.root && S.root.querySelector('.qp-bigplay');
      if (b) b.hidden = false;
    }
    function hideBigPlay(S) {
      var b = S.root && S.root.querySelector('.qp-bigplay');
      if (b) b.hidden = true;
    }

    function nextUntried(S) {
      var n = S.lines.length;
      if (!n) return -1;
      var from = S.lineIdx;
      for (var k = 1; k <= n; k++) {
        var i = (from + k + n) % n;
        if (i === from) continue;
        if (!S.lines[i].tried && S.lines[i].url) return i;
      }
      return -1;
    }

    function retry(S) {
      if (!alive(S)) return;
      var l = S.lines[S.lineIdx];
      /* 用户自备源没有「重新取地址」这一说，就地重试同一条；
         官方签名直链会过期，只能交给 75 重新 find + url。 */
      if (!l || l.kind !== 'byo') {
        if (typeof S.ctx.onRetry === 'function') { S.ctx.onRetry(); return; }
      }
      for (var i = 0; i < S.lines.length; i++) S.lines[i].tried = false;
      renderLines(S);
      if (S.lineIdx >= 0) startLine(S, S.lineIdx);
      else if (S.lines.length) startLine(S, 0);
    }

    function onLoadFail(S, line) {
      if (!alive(S)) return;
      clearStall(S);
      if (line) { line.tried = true; line.err = '加载失败'; }
      renderLines(S);
      var next = nextUntried(S);
      if (next >= 0) { startLine(S, next); return; }       // 失败回退：自动切下一条线路
      setState(S, 'error', { msg: '播放失败，试试换一条线路' });
    }

    function startLine(S, idx) {
      var line = S.lines[idx];
      if (!alive(S) || !line) return false;
      if (line.type === 'hls' && !S.hlsOk) {
        line.tried = true;
        line.err = '此浏览器不支持 HLS';
        renderLines(S);
        var nx = nextUntried(S);
        if (nx >= 0) return startLine(S, nx);
        setState(S, 'error', { msg: '此浏览器不支持 HLS，请用 Safari 或换 mp4 源' });
        return false;
      }
      S.lineIdx = idx;
      S.fid = String(line.fid || '');          // 换到自备源 / 另一条官方源时，进度不能记到上一条的 fid 上
      S.resumeDone = !(S.resumeAt > 0);
      renderLines(S);
      updateSub(S);
      setState(S, 'loading', { msg: '正在加载 ' + line.label + '…' });
      clearStall(S);
      try { S.v.pause(); } catch (e) { /* 未加载时 pause 会抛，忽略 */ }
      S.v.setAttribute('src', line.url);       // 签名直链带 & ?：属性赋值不经 HTML 转义
      try { if (S.v.load) S.v.load(); } catch (e) { /* 忽略 */ }
      var p = null;
      try { p = S.v.play(); } catch (e) { p = null; }
      if (p && typeof p.then === 'function') {
        p.then(null, function (err) {
          if (!alive(S)) return;
          if (err && err.name === 'NotAllowedError') {      // 自动播放被拦：给大字按钮，不当作失败
            setState(S, 'ready');
            showBigPlay(S);
            return;
          }
          onLoadFail(S, line);
        });
      } else if (!p) {
        onLoadFail(S, line);
      }
      return true;
    }

    function play(url, label, opt) {
      var S = cur;
      if (!alive(S)) return false;
      if (!isUrl(url)) { setState(S, 'error', { msg: '视频地址无效' }); return false; }
      var o = opt || {};
      if (o.startAt != null) S.resumeAt = Math.max(0, Number(o.startAt) || 0);
      if (o.fid) S.fid = String(o.fid);
      var idx = addLine(S, { url: url, label: label || '直链', kind: 'official', fid: o.fid });
      for (var i = 0; i < S.lines.length; i++) S.lines[i].tried = false;   // 新地址 = 重新开始一轮回退
      renderLines(S);
      return startLine(S, idx);
    }

    function setSources(list) {
      var S = cur;
      if (!alive(S)) return;
      S.lines = S.lines.filter(function (l) { return l.kind === 'byo'; });
      (list || []).forEach(function (src) { if (src && src.url) addLine(S, src); });
      if (S.lineIdx >= S.lines.length) S.lineIdx = -1;
      renderLines(S);
      updateSub(S);
    }

    function setEpisodes(list, curEp, hint) {
      var S = cur;
      if (!alive(S)) return;
      var out = [];
      (list || []).forEach(function (it) {
        if (it == null) return;
        var ep = Number(it.ep != null ? it.ep : it);
        if (!(ep > 0) || ep !== Math.floor(ep)) return;
        out.push({
          ep: ep,
          label: String((it && it.label) || pad2(ep)),
          fid: String((it && it.fid) || ''),
          magnet: String((it && it.magnet) || '')
        });
      });
      S.eps = out;
      var n = Number(curEp);
      if (n > 0) S.ep = n;
      renderEps(S, hint !== undefined ? hint : defaultEpsHint(out));
      updateSub(S);
    }

    function setFid(fid) {
      if (cur) cur.fid = String(fid == null ? '' : fid);
    }

    /* 换集 / 换源前先停：旧视频的 pause 事件会把「旧集 + 旧 fid」的进度落盘，
       必须在改写 ep / fid 之前调用，否则会把上一集的秒数记到新集头上。 */
    function pause() {
      if (!alive(cur)) return;
      try { cur.v.pause(); } catch (e) { /* 忽略 */ }
    }

    /* ---------------- 进度上报 ---------------- */
    /* 纯函数便于离线核对：位移 ≥5s 且距上次 ≥5s 才上报（timeupdate 触发很密，不节流等于每帧一次请求） */
    function gate(prevPos, pos, lastMs, nowMs) {
      var dp = Math.abs(Number(pos) - Number(prevPos));
      var dt = Number(nowMs) - Number(lastMs);
      if (!lastMs) return { send: true, dp: dp, dt: 0 };
      return { send: dt >= 5000 && dp >= 5, dp: dp, dt: dt };
    }

    function report(S, final, atEnd) {
      if (!alive(S)) return;
      var v = S.v;
      var dur = Number(v.duration) || 0;
      var pos = atEnd ? dur : Number(v.currentTime) || 0;
      if (!(dur > 0) || !(pos >= 0)) return;
      S.lastMs = Date.now();
      S.lastPos = pos;
      var payload = {
        ep: S.ep,
        fid: S.fid,
        pos: Math.round(pos * 10) / 10,
        dur: Math.round(dur * 10) / 10
      };
      if (final) payload.final = true;
      if (typeof S.ctx.onProgress === 'function') {
        try { S.ctx.onProgress(payload); } catch (e) { /* 上报失败不影响播放 */ }
      }
    }

    /* ---------------- 进度条 / 时间 / 音量：rAF 合并，避免每次 timeupdate 都重排 ---------------- */
    function paint(S) {
      if (!alive(S)) return;
      var v = S.v, d = Number(v.duration) || 0, p = Number(v.currentTime) || 0;
      var seek = S.root.querySelector('.qp-seek');
      if (seek && !S.seekDrag) seek.value = String(d > 0 ? Math.round(p / d * 1000) : 0);
      var curEl = S.root.querySelector('.qp-cur');
      var durEl = S.root.querySelector('.qp-dur');
      if (curEl) curEl.textContent = fmtTime(p);
      if (durEl) durEl.textContent = fmtTime(d);
      var btn = S.root.querySelector('.qp-play');
      if (btn) btn.textContent = v.paused ? '▶' : '⏸';
      var mute = S.root.querySelector('.qp-mute');
      if (mute) mute.textContent = (v.muted || !v.volume) ? '🔇' : '🔊';
      var rate = S.root.querySelector('.qp-rate');
      if (rate) rate.textContent = rateLabel(Number(v.playbackRate) || 1);
      var fs = S.root.querySelector('.qp-fs');
      if (fs) {
        var full = !!(document.fullscreenElement || document.webkitFullscreenElement);
        fs.textContent = full ? '退出全屏' : '全屏';
      }
    }

    function schedule(S) {
      if (!alive(S) || S.pending) return;
      S.pending = true;
      var raf = window.requestAnimationFrame || function (cb) { return setTimeout(cb, 16); };
      raf(function () { S.pending = false; paint(S); });
    }

    /* ---------------- 卡死看门狗 ---------------- */
    function armStall(S) {
      if (!alive(S) || S.stallTimer) return;
      S.stallTimer = setTimeout(function () {
        S.stallTimer = 0;
        if (!alive(S)) return;
        if (S.v.readyState >= 2) return;            // 已经有数据，只是短暂缓冲
        onLoadFail(S, S.lines[S.lineIdx]);
      }, 15000);
    }
    function clearStall(S) {
      if (S.stallTimer) { clearTimeout(S.stallTimer); S.stallTimer = 0; }
    }

    /* ---------------- 下一集倒计时 ---------------- */
    function cancelNext(S) {
      if (S.nextTimer) { clearInterval(S.nextTimer); S.nextTimer = 0; }
      var bar = S.root && S.root.querySelector('.qp-nextbar');
      if (bar) bar.hidden = true;
    }
    function goNext(S, auto) {
      cancelNext(S);
      if (!alive(S)) return;
      if (auto) {
        if (typeof S.ctx.onEnded === 'function') { S.ctx.onEnded(); return; }
      }
      if (typeof S.ctx.onNext === 'function') { S.ctx.onNext(); return; }
      if (typeof S.ctx.onEnded === 'function') S.ctx.onEnded();
    }
    function showNext(S) {
      var bar = S.root.querySelector('.qp-nextbar');
      if (!bar) return;
      var hint = S.root.querySelector('.qp-autonext');
      S.nextLeft = 5;
      bar.hidden = false;
      if (hint) hint.textContent = S.nextLeft + ' 秒后自动播放下一集';
      if (S.nextTimer) clearInterval(S.nextTimer);
      S.nextTimer = setInterval(function () {
        if (!alive(S)) { cancelNext(S); return; }
        S.nextLeft -= 1;
        if (S.nextLeft > 0) {
          if (hint) hint.textContent = S.nextLeft + ' 秒后自动播放下一集';
          return;
        }
        goNext(S, true);
      }, 1000);
    }

    /* ---------------- 全屏 / 画中画 ---------------- */
    function toggleFs(S) {
      var d = document, root = S.root, v = S.v;
      if (d.fullscreenElement || d.webkitFullscreenElement) {
        try {
          if (d.exitFullscreen) d.exitFullscreen();
          else if (d.webkitExitFullscreen) d.webkitExitFullscreen();
        } catch (e) { /* 忽略 */ }
        return;
      }
      try {
        if (root.requestFullscreen) root.requestFullscreen();
        else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();     // iOS 只允许 video 元素
        else if (v.webkitRequestFullscreen) v.webkitRequestFullscreen();
        else if (v.requestFullscreen) v.requestFullscreen();
      } catch (e) { /* 用户拒绝 / 不支持：保持原状 */ }
    }

    function togglePip(S) {
      var v = S.v;
      try {
        if (document.pictureInPictureElement) { document.exitPictureInPicture(); return; }
        if (v.requestPictureInPicture) v.requestPictureInPicture();
      } catch (e) { /* 忽略 */ }
    }

    /* ---------------- 弹幕层（纯 canvas，零依赖） ----------------
       轨道分配抄 weizhenye/Danmaku 的思路，不引库：按行高分轨，每轨记「上一条的起点时间 / 宽度 / 速度」，
       用宽度与速度换算的时间差判断新条会不会追尾（新条的左边缘追上前条的右边缘之前，前条是否已飞出左边界）；
       放不下就换下一轨，全轨放不下直接丢（B 站也丢）。

       时间全部落在「媒体时间」域：位置 = 用 video.currentTime 现算。
       于是暂停天然不推进、倍速天然跟随（乘 playbackRate 会把倍速算两次）。

       层在 .qp-stage 里 z-index:1，压在视频上、在 .qp-overlay(2) / .qp-bigplay(3) 之下：
       loading 时被状态遮罩盖住，不会出现「遮罩后面还在飘字」。 */

    /* rAF 句柄做成对象：浏览器没有 rAF（极老环境 / 离线桩）时退回 setTimeout 也能被正确取消 */
    function dmRaf(cb) {
      var f = window.requestAnimationFrame;
      if (f) return { id: f(cb), raf: true };
      return { id: setTimeout(function () { cb(Date.now()); }, 16), raf: false };
    }
    function dmCaf(h) {
      if (!h) return;
      try {
        if (h.raf) window.cancelAnimationFrame(h.id);
        else clearTimeout(h.id);
      } catch (e) { /* 忽略 */ }
    }

    function dmPref() {
      try { return localStorage.getItem(QP_DM_KEY) !== '0'; } catch (e) { return true; }
    }
    function dmSavePref(on) {
      try { localStorage.setItem(QP_DM_KEY, on ? '1' : '0'); } catch (e) { /* 隐私模式：静默 */ }
    }

    /* 十进制 RGB（16777215 = 白）→ #rrggbb */
    function dmColor(n) {
      var v = Number(n);
      if (!isFinite(v) || v < 0) return '#ffffff';
      var hex = Math.floor(v % 16777216).toString(16);
      while (hex.length < 6) hex = '0' + hex;
      return '#' + hex;
    }

    /* 字号按舞台宽 / 1280 缩放并夹在 12..20：舞台 390 宽时 25px 原始字号会占掉 11% 高度 */
    function dmFontPx(dm, size) {
      var px = Math.round((Number(size) || 25) * dm.W / 1280);
      return Math.max(12, Math.min(20, px));
    }

    /* 每条弹幕预渲染成一张小 canvas：measureText / strokeText 只做一次，之后每帧只 drawImage。
       按字号的缩放缓存（舞台尺寸变了字号才会变，变了才重画）。 */
    function dmSprite(dm, it, px) {
      if (it._sp && it._px === px) return it._sp;
      var dpr = dm.dpr || 1;
      var font = '600 ' + px + 'px ' + DM_FONT;
      if (!dm.meas) {
        var mc = document.createElement('canvas');
        try { dm.meas = mc.getContext('2d'); } catch (e) { dm.meas = null; }
        if (!dm.meas) return null;
      }
      dm.meas.font = font;
      var tw = 0;
      try { tw = dm.meas.measureText(it.m).width || 0; } catch (e) { tw = 0; }
      if (!(tw > 0)) tw = it.m.length * px * 0.6;       // 无字体信息时的兜底宽度
      var pad = 2;                                     // 描边留白，防边缘被裁
      var w = Math.ceil(tw) + pad * 2;
      var h = Math.ceil(px * 1.22) + pad * 2;
      var c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * dpr));
      c.height = Math.max(1, Math.round(h * dpr));
      var g = null;
      try { g = c.getContext('2d'); } catch (e) { g = null; }
      if (!g) return null;
      g.scale(dpr, dpr);                               // dpr 只在这里缩放一次
      g.font = font;
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.lineJoin = 'round';
      g.strokeStyle = 'rgba(0, 0, 0, .82)';            // 1px 黑描边：浅色画面里也读得清
      g.lineWidth = 2;
      g.strokeText(it.m, pad, h / 2);
      g.fillStyle = dmColor(it.color);
      g.fillText(it.m, pad, h / 2);
      var sp = { c: c, w: w, h: h };
      it._sp = sp;
      it._px = px;
      return sp;
    }

    /* 二分：第一个 t >= x 的下标（seek 后不复扫全表） */
    function dmLower(items, x) {
      var lo = 0, hi = items.length;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (items[mid].t < x) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    }

    /* 尺寸 / dpr / 分行：舞台尺寸变了才重来（客户端读 clientWidth 不会触发重排，每帧读一次可接受） */
    function dmResize(S) {
      var dm = S && S.dm, cv = dm && dm.cv;
      if (!cv) return false;
      var W = cv.clientWidth, H = cv.clientHeight;
      if (!(W > 0) || !(H > 0)) return false;          // 隐藏 / 还没布局：这一帧不画
      var dpr = Math.min(2, Number(window.devicePixelRatio) || 1);
      if (dm.g && W === dm.W && H === dm.H && dpr === dm.dpr) return true;
      dm.W = W;
      dm.H = H;
      dm.dpr = dpr;
      cv.width = Math.max(1, Math.round(W * dpr));
      cv.height = Math.max(1, Math.round(H * dpr));
      var g = null;
      try { g = cv.getContext('2d'); } catch (e) { g = null; }
      dm.g = g;
      if (g) g.setTransform(dpr, 0, 0, dpr, 0, 0);     // dpr 缩放只做这一次
      dmLayout(S);
      return !!g;
    }

    function dmLayout(S) {
      var dm = S.dm;
      dm.lineH = Math.max(18, Math.min(26, Math.round(dm.H / 8)));
      dm.pad = 4;
      dm.rows = Math.max(1, Math.floor((dm.H - dm.pad * 2) / dm.lineH));
      dm.cap = window.innerWidth <= 760 ? 20 : 30;     // 同屏上限：移动端 20，桌面 30
      dm.roll = [];
      dm.top = [];
      dm.bot = [];
      for (var i = 0; i < dm.rows; i++) {
        dm.roll.push(null);                            // null | {t, w, v}
        dm.top.push(0);                                // 该轨被占用到的媒体时间
        dm.bot.push(0);
      }
      dm.live = [];
      dm.next = dmLower(dm.items, (Number(S.v.currentTime) || 0) - DM_LATE);
      dm.lastCt = -1;                                  // 逼下一帧走「重定位」分支
    }

    /* 追尾判定：前一条在 t0 时刻的右边界是否已进画面，且新条（更快时）在追上前是否已让前条飞出左边 */
    function dmFits(rec, t0, w, v, W) {
      if (!rec) return true;                           // 空轨
      var dt = t0 - rec.t;
      if (!(dt >= 0)) return false;
      var left = W - rec.v * dt;                       // 前一条当前左边界
      var right = left + rec.w;                        // 前一条当前右边界
      if (right > W - 6) return false;                 // 尾巴还压在右边界上（留 6px 余量）
      var vNew = Math.max(1, v), vPrev = Math.max(1, rec.v);
      if (vNew <= vPrev) return true;                  // 不会追上
      var exit = (left + rec.w) / vPrev;               // 前一条完全离场还需多久
      return (W - right) / (vNew - vPrev) >= exit;     // 追上前它已经飞出画面
    }

    /* 投放一条：滚动 / 顶部固定 / 底部固定，放不下就丢 */
    function dmSpawn(S, it) {
      var dm = S.dm, W = dm.W, t0 = it.t;
      var px = dmFontPx(dm, it.size);
      var sp = dmSprite(dm, it, px);
      if (!sp) return;

      if (it.c === 4 || it.c === 5) {                  // 4 底部固定 / 5 顶部固定：停留 4s，顶上往下、底上往上
        var isTop = it.c === 5, pool = isTop ? dm.top : dm.bot, row = -1;
        for (var i = 0; i < dm.rows; i++) {
          if (!pool[i] || t0 >= pool[i]) { row = i; break; }
        }
        if (row < 0) return;                           // 固定位全满：丢
        pool[row] = t0 + DM_FIX_S;
        var off = Math.round((dm.lineH - sp.h) / 2);
        var y = isTop
          ? dm.pad + row * dm.lineH + off
          : dm.H - dm.pad - (row + 1) * dm.lineH + off;
        dm.live.push({ mode: isTop ? 'top' : 'bot', t0: t0, w: sp.w, y: y, sp: sp });
        return;
      }

      var v = DM_SPEED, row2 = -1, best = null;
      for (var k = 0; k < dm.rows; k++) {
        var rec = dm.roll[k];
        if (!dmFits(rec, t0, sp.w, v, W)) continue;
        if (!rec) { row2 = k; break; }                 // 空轨优先
        if (!best || rec.t < best.t) { best = rec; row2 = k; }   // 都占着就选最久没用的那轨
      }
      if (row2 < 0) return;                            // 轨道全满：丢弃
      dm.roll[row2] = { t: t0, w: sp.w, v: v };
      dm.live.push({
        mode: 'roll', t0: t0, v: v, w: sp.w,
        y: dm.pad + row2 * dm.lineH + Math.round((dm.lineH - sp.h) / 2),
        sp: sp
      });
    }

    /* 推进到下一条该出现的弹幕（按媒体时间顺排，指针只前进） */
    function dmAdvance(S, ct) {
      var dm = S.dm, items = dm.items;
      while (dm.next < items.length && items[dm.next].t <= ct) {
        var it = items[dm.next];
        dm.next += 1;
        if (ct - it.t > DM_LATE) continue;             // 追不上的旧弹幕：丢，不补投
        if (dm.live.length >= dm.cap) continue;        // 同屏满：丢
        dmSpawn(S, it);
      }
    }

    function dmDraw(S, ct) {
      var dm = S.dm, g = dm.g;
      if (!g) return;
      g.clearRect(0, 0, dm.W, dm.H);                   // 每帧只清一次
      var live = dm.live, keep = [];
      for (var i = 0; i < live.length; i++) {
        var e = live[i], x;
        if (e.mode === 'roll') {
          x = dm.W - e.v * (ct - e.t0);
          if (x + e.w <= 0) continue;                  // 已经完全飞出左边
        } else {
          if (ct >= e.t0 + DM_FIX_S) continue;         // 固定弹幕到期
          x = Math.round((dm.W - e.w) / 2);
        }
        g.drawImage(e.sp.c, x, e.y, e.sp.w, e.sp.h);
        keep.push(e);
      }
      dm.live = keep;
    }

    /* seek / 换集 / 大幅跳时：清屏、重置轨道、二分定位到下一条（不从 0 重扫） */
    function dmJump(S, ct) {
      var dm = S.dm;
      if (!dm) return;
      dm.live = [];
      for (var i = 0; i < dm.rows; i++) { dm.roll[i] = null; dm.top[i] = 0; dm.bot[i] = 0; }
      dm.next = dmLower(dm.items, ct - DM_LATE);
      dm.lastCt = ct;
      if (dm.g) { try { dm.g.clearRect(0, 0, dm.W, dm.H); } catch (e) { /* 忽略 */ } }
    }

    /* 画一次（暂停时也能出画面：seek 后停住也要看到那一刻的弹幕） */
    function dmTick(S) {
      var dm = S && S.dm;
      if (!dm || !dm.on || !dm.items.length) return;
      if (!dmResize(S)) return;
      var ct = Number(S.v.currentTime) || 0;
      dm.lastCt = ct;
      dmAdvance(S, ct);
      dmDraw(S, ct);
    }

    /* 常驻循环：独立于 paint / schedule（那套是按需触发的，弹幕要每帧推进） */
    function dmFrame(S) {
      var dm = S && S.dm;
      if (!dm) return;
      dm.raf = null;
      if (!alive(S) || !dm.on) return;                 // 关掉 / 已销毁：不再排下一帧，循环自然停
      dm.raf = dmRaf(function () { dmFrame(S); });
      if (!dmResize(S)) return;
      var ct = Number(S.v.currentTime) || 0;
      if (dm.lastCt >= 0 && ct === dm.lastCt) return;  // 暂停：不推进、不重绘
      if (dm.lastCt < 0 || Math.abs(ct - dm.lastCt) > DM_LATE) dmJump(S, ct);
      dmTick(S);
    }

    function dmStart(S) {
      var dm = S && S.dm;
      if (!alive(S) || !dm || !dm.on || dm.raf || !dm.items.length || !dm.cv) return;
      dm.lastCt = -1;
      dm.raf = dmRaf(function () { dmFrame(S); });
    }

    function dmStop(S) {
      var dm = S && S.dm;
      if (!dm) return;
      if (dm.raf) { dmCaf(dm.raf); dm.raf = null; }
      dm.live = [];
      dm.lastCt = -1;
      if (dm.g) { try { dm.g.clearRect(0, 0, dm.W || 0, dm.H || 0); } catch (e) { /* 忽略 */ } }
    }

    function dmPaintBtn(S) {
      var b = S && S.root && S.root.querySelector('.qp-dm-toggle');
      if (b) b.textContent = S && S.dm && S.dm.on ? '弹幕 开' : '弹幕 关';
    }

    /* 装载：脏数据一律洗掉（缺 t / 缺文本 / 模式越界都不渲染），按时间排序后重置播放状态 */
    function dmSet(S, list) {
      var dm = S && S.dm;
      if (!dm) return 0;
      dmStop(S);
      var out = [], arr = Object.prototype.toString.call(list) === '[object Array]' ? list : [];
      for (var i = 0; i < arr.length && out.length < DM_MAX_ITEMS; i++) {
        var x = arr[i];
        if (!x) continue;
        var t = Number(x.t);
        var m = String(x.m == null ? '' : x.m).replace(/\s+/g, ' ').trim();
        if (!isFinite(t) || t < 0 || !m) continue;
        var c = Math.round(Number(x.c) || 1);
        if (!(c >= 1 && c <= 5)) c = 1;
        out.push({
          t: t,
          m: m.slice(0, DM_TEXT_MAX),
          c: c,
          size: Math.max(12, Math.min(64, Number(x.size) || 25)),
          color: Number(x.color)
        });
      }
      out.sort(function (a, b) { return a.t - b.t; });
      dm.items = out;
      dm.next = 0;
      dm.live = [];
      dm.lastCt = -1;
      if (out.length) dmStart(S);                      // 空数组 = 关闭：停循环，层上不留东西
      dmPaintBtn(S);
      return out.length;
    }

    /* 拉接口：失败只让弹幕层空着，绝不碰 data-state（否则一次 404 会把「正在播放」变成错误页） */
    function dmFetch(S, cid) {
      var dm = S && S.dm;
      if (!dm || !cid || typeof fetch !== 'function') return;
      var key = String(cid), tok = S.tok;
      dm.cid = key;
      fetch(DM_BASE + '/bili/dm?cid=' + encodeURIComponent(key), { credentials: 'omit' })
        .then(function (r) { return r && r.ok ? r.json() : null; })
        .then(function (j) {
          if (!alive(S) || S.tok !== tok || !cur || cur.tok !== tok || dm.cid !== key) return;
          if (!j || Object.prototype.toString.call(j.items) !== '[object Array]') return;
          dmSet(S, j.items);
        })
        .catch(function () { /* 静默：没弹幕不影响播放 */ });
    }

    function dmToggle(S, on) {
      var dm = S && S.dm;
      if (!dm) return false;
      dm.on = !!on;
      dmSavePref(dm.on);
      if (S.root) S.root.setAttribute('data-dm', dm.on ? '1' : '0');
      dmPaintBtn(S);
      if (dm.on) dmStart(S); else dmStop(S);
      return dm.on;
    }

    function dmClear(S) {
      var dm = S && S.dm;
      if (!dm) return;
      dmStop(S);
      dm.items = [];
      dm.next = 0;
      dm.live = [];
      dm.cid = '';
    }

    function dmInit(S, ctx) {
      var dm = {
        on: dmPref(),
        cv: S.root.querySelector('.qp-dm'),
        g: null,
        W: 0, H: 0, dpr: 1,
        lineH: 22, pad: 4, rows: 1, cap: 30,
        roll: [], top: [], bot: [],
        items: [], next: 0, live: [],
        raf: null, lastCt: -1, meas: null, cid: ''
      };
      S.dm = dm;
      if (S.root) S.root.setAttribute('data-dm', dm.on ? '1' : '0');
      dmPaintBtn(S);
      var opt = (ctx && ctx.dm) || null;
      if (opt && opt.items) dmSet(S, opt.items);       // 调用方带数据：直接用
      else if (opt && opt.cid) dmFetch(S, opt.cid);    // 只给 cid：播放器自己拉
    }

    /* ---------------- 事件绑定 ---------------- */
    function bind(S) {
      var v = S.v, root = S.root;
      function q(sel) { return root.querySelector(sel); }

      v.addEventListener('loadedmetadata', function () {
        if (!alive(S)) return;
        if (!S.resumeDone && S.resumeAt > 0) {
          S.resumeDone = true;
          var d = Number(v.duration) || 0;
          if (!(d > 0) || S.resumeAt < d - 5) {
            try { v.currentTime = S.resumeAt; } catch (e) { /* 忽略 */ }
          }
        }
        schedule(S);
      });
      v.addEventListener('playing', function () {
        if (!alive(S)) return;
        clearStall(S);
        hideBigPlay(S);
        if (S.state !== 'ready') setState(S, 'ready');
        schedule(S);
      });
      v.addEventListener('timeupdate', function () {
        if (!alive(S)) return;
        schedule(S);
        var pos = Number(v.currentTime) || 0;
        if (gate(S.lastPos, pos, S.lastMs, Date.now()).send) report(S, false);
      });
      v.addEventListener('pause', function () {
        if (!alive(S)) return;
        schedule(S);
        report(S, false);
      });
      v.addEventListener('play', function () { schedule(S); });
      v.addEventListener('seeked', function () {
        if (!alive(S)) return;
        /* 拖进度 / 换源：清屏 + 重置轨道 + 按新的 currentTime 二分定位下一条，
           并立刻画一帧（暂停中拖动也要看到那一刻的弹幕，别留一块被清空的画布） */
        if (S.dm && S.dm.on) { dmJump(S, Number(v.currentTime) || 0); dmTick(S); }
        if (S.seekTimer) clearTimeout(S.seekTimer);
        S.seekTimer = setTimeout(function () {
          S.seekTimer = 0;
          report(S, false);                       // 拖动结束 800ms 后再报，避免拖一次发几十条
        }, 800);
        schedule(S);
      });
      v.addEventListener('waiting', function () { if (alive(S)) armStall(S); });
      v.addEventListener('stalled', function () { if (alive(S)) armStall(S); });
      v.addEventListener('error', function () { onLoadFail(S, S.lines[S.lineIdx]); });
      v.addEventListener('volumechange', function () {
        if (!alive(S)) return;
        var vol = q('.qp-vol');
        if (vol) vol.value = String(Math.round((v.muted ? 0 : v.volume) * 100));
        schedule(S);
      });
      v.addEventListener('ratechange', function () { schedule(S); });
      v.addEventListener('ended', function () {
        if (!alive(S)) return;
        report(S, true, true);                     // 先把 pos=dur 记下，再谈下一集
        showNext(S);
        schedule(S);
      });
      v.addEventListener('click', function () {
        if (!alive(S)) return;
        try { root.focus({ preventScroll: true }); } catch (e) { try { root.focus(); } catch (e2) {} }
        togglePlay(S);
      });

      var big = q('.qp-bigplay');
      if (big) big.onclick = function () {
        if (!alive(S)) return;
        hideBigPlay(S);
        var p = v.play();
        if (p && p.then) p.then(null, function () { showBigPlay(S); });
      };

      var closeBtn = q('.qp-close');
      if (closeBtn) closeBtn.onclick = function () { close(); };

      var dmBtn = q('.qp-dm-toggle');
      if (dmBtn) dmBtn.onclick = function () { if (alive(S) && S.dm) dmToggle(S, !S.dm.on); };

      var playBtn = q('.qp-play');
      if (playBtn) playBtn.onclick = function () { togglePlay(S); };

      var muteBtn = q('.qp-mute');
      if (muteBtn) muteBtn.onclick = function () {
        v.muted = !v.muted;
        if (!v.muted && !v.volume) v.volume = 0.6;
      };

      var seek = q('.qp-seek');
      if (seek) {
        seek.addEventListener('pointerdown', function () { S.seekDrag = true; });
        seek.addEventListener('input', function () {
          S.seekDrag = true;
          var d = Number(v.duration) || 0;
          if (d > 0) {
            var t = d * (Number(seek.value) || 0) / 1000;
            try { v.currentTime = Math.max(0, Math.min(d - 0.1, t)); } catch (e) { /* 忽略 */ }
          }
        });
        seek.addEventListener('change', function () { S.seekDrag = false; schedule(S); });
        seek.addEventListener('pointerup', function () { S.seekDrag = false; });
        seek.addEventListener('blur', function () { S.seekDrag = false; });
      }

      var vol = q('.qp-vol');
      if (vol) vol.addEventListener('input', function () {
        var x = Math.max(0, Math.min(100, Number(vol.value) || 0));
        v.volume = x / 100;
        v.muted = x === 0;
      });

      var rate = q('.qp-rate');
      if (rate) rate.onclick = function () {
        var i = QP_RATES.indexOf(Number(v.playbackRate) || 1);
        i = (i < 0 ? 3 : i + 1) % QP_RATES.length;
        try { v.playbackRate = QP_RATES[i]; } catch (e) { /* 忽略 */ }
        rate.textContent = rateLabel(QP_RATES[i]);
      };

      var pip = q('.qp-pip');
      if (pip) {
        if (document.pictureInPictureEnabled && v.requestPictureInPicture) {
          pip.onclick = function () { togglePip(S); };
        } else {
          pip.hidden = true;
        }
      }

      var fs = q('.qp-fs');
      if (fs) fs.onclick = function () { toggleFs(S); };

      var nextBtn = q('.qp-next');
      if (nextBtn) nextBtn.onclick = function () { goNext(S, false); };
      var cancelBtn = q('.qp-cancel');
      if (cancelBtn) cancelBtn.onclick = function () { cancelNext(S); };

      var epsSec = q('.qp-eps');
      var epsToggle = q('.qp-eps-toggle');
      if (epsToggle) epsToggle.onclick = function () { toggleSec(epsSec, '.qp-eps-toggle'); };
      var linesSec = q('.qp-lines');
      var linesToggle = q('.qp-lines-toggle');
      if (linesToggle) linesToggle.onclick = function () { toggleSec(linesSec, '.qp-lines-toggle'); };

      var epsList = q('.qp-eps-list');
      if (epsList) epsList.addEventListener('click', function (ev) {
        var t = ev.target;
        var b = t && t.closest ? t.closest('.qp-ep') : null;
        if (!b || !alive(S)) return;
        var ep = Number(b.getAttribute('data-ep'));
        if (!(ep > 0) || ep === Number(S.ep)) return;
        S.ep = ep;
        renderEps(S, S.epsHint);
        updateSub(S);
        if (window.innerWidth <= 760) setSecOpen(epsSec, '.qp-eps-toggle', false);   // 手机上点完自动收起
        if (typeof S.ctx.onPickEp === 'function') S.ctx.onPickEp(ep);
      });

      var lineList = q('.qp-line-list');
      if (lineList) lineList.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t || !t.classList || !alive(S)) return;
        if (t.classList.contains('qp-line-del')) {
          var di = Number(t.getAttribute('data-i'));
          var dl = S.lines[di];
          if (!dl || dl.kind !== 'byo') return;
          delByo(S.id, dl.url);
          S.lines.splice(di, 1);
          if (di < S.lineIdx) S.lineIdx -= 1;
          else if (di === S.lineIdx) S.lineIdx = -1;
          renderLines(S);
          updateSub(S);
          return;
        }
        if (t.classList.contains('qp-line')) {
          var i = Number(t.getAttribute('data-i'));
          if (!(i >= 0) || i >= S.lines.length) return;
          for (var k = 0; k < S.lines.length; k++) S.lines[k].tried = false;
          startLine(S, i);
        }
      });

      var urlIn = q('.qp-line-url');
      var labIn = q('.qp-line-label');
      var addBtn = q('.qp-line-add');
      if (addBtn) addBtn.onclick = function () {
        if (!alive(S)) return;
        var url = String((urlIn && urlIn.value) || '').trim();
        var label = String((labIn && labIn.value) || '').trim();
        if (!/^https?:\/\//i.test(url)) {
          var old = addBtn.textContent;
          addBtn.textContent = '请粘贴 http(s) 直链';
          setTimeout(function () { if (addBtn.isConnected) addBtn.textContent = old; }, 1400);
          return;
        }
        var type = typeOf(url);
        saveByo(S.id, { label: label || labelOf(url), url: url, type: type });
        if (urlIn) urlIn.value = '';
        if (labIn) labIn.value = '';
        var idx = addLine(S, { url: url, label: label, kind: 'byo' });
        for (var k = 0; k < S.lines.length; k++) S.lines[k].tried = false;
        renderLines(S);
        startLine(S, idx);
      };

      /* 键盘快捷键只在播放器（或其内部控件）获得焦点时生效，不做全局监听 */
      root.addEventListener('keydown', function (ev) {
        if (!alive(S)) return;
        var t = ev.target;
        var tag = t && t.tagName ? String(t.tagName).toUpperCase() : '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;   // 滑块/输入框自己处理方向键
        var k = ev.key;
        if (k === ' ' || k === 'Spacebar') {
          if (tag === 'BUTTON' || tag === 'A') return;    // 让获得焦点的按钮自己响应空格
          ev.preventDefault();
          togglePlay(S);
        } else if (k === 'ArrowLeft') {
          ev.preventDefault(); seekBy(S, -5);
        } else if (k === 'ArrowRight') {
          ev.preventDefault(); seekBy(S, 5);
        } else if (k === 'ArrowUp') {
          ev.preventDefault(); bumpVolume(S, 0.1);
        } else if (k === 'ArrowDown') {
          ev.preventDefault(); bumpVolume(S, -0.1);
        } else if (k === 'f' || k === 'F') {
          ev.preventDefault(); toggleFs(S);
        } else if (k === 'm' || k === 'M') {
          ev.preventDefault(); S.v.muted = !S.v.muted;
        }
      });

      /* 关弹窗 / 切后台：立刻落一次进度（70-modal.js 直接摘节点，靠 isConnected 兜底收尾） */
      S.onVis = function () {
        if (document.visibilityState === 'hidden') report(S, true);
      };
      S.onPageHide = function () { report(S, true); };
      document.addEventListener('visibilitychange', S.onVis);
      window.addEventListener('pagehide', S.onPageHide);
    }

    function togglePlay(S) {
      if (!alive(S)) return;
      var v = S.v;
      if (v.paused) {
        var p = v.play();
        if (p && p.then) p.then(null, function () { showBigPlay(S); });
      } else {
        v.pause();
      }
    }

    function seekBy(S, delta) {
      var v = S.v, d = Number(v.duration) || 0;
      if (!(d > 0)) return;
      try { v.currentTime = Math.max(0, Math.min(d, (Number(v.currentTime) || 0) + delta)); } catch (e) { /* 忽略 */ }
    }

    function bumpVolume(S, delta) {
      var v = S.v;
      var x = Math.max(0, Math.min(1, (Number(v.volume) || 0) + delta));
      v.volume = x;
      if (x > 0 && v.muted) v.muted = false;
    }

    /* ---------------- 打开 / 关闭 ---------------- */
    function open(ctx) {
      var m = ctx && ctx.m;
      if (!m) return 0;
      close();                                    // 同一弹窗只允许一个实例
      /* 摘掉已有 .trailer（预告 / 上一次播放）：先 pause + 断源再移除，否则某些浏览器摘了节点还在出声 */
      var old = m.querySelector('.trailer');
      if (old && old.parentNode) {
        var ov = old.querySelector('video');
        if (ov) {
          try { ov.pause(); ov.removeAttribute('src'); if (ov.load) ov.load(); } catch (e) { /* 忽略 */ }
        }
        old.parentNode.removeChild(old);
      }

      var root = document.createElement('div');
      root.className = 'trailer qplayer';
      root.setAttribute('data-state', 'loading');
      root.setAttribute('tabindex', '0');
      root.innerHTML = TPL;

      var v = root.querySelector('.qp-video');
      var S = {
        tok: ++SEQ,
        ctx: ctx || {},
        m: m,
        root: root,
        v: v,
        id: String(ctx.id == null ? '' : ctx.id),
        title: String(ctx.title || ''),
        ep: Number(ctx.ep) > 0 ? Number(ctx.ep) : 0,
        fid: '',
        state: 'loading',
        lines: [],
        lineIdx: -1,
        eps: [],
        epsHint: '',
        hlsOk: hlsSupported(v),
        resumeAt: Math.max(0, Number(ctx.startAt) || 0),
        resumeDone: false,
        lastMs: 0,
        lastPos: 0,
        seekDrag: false,
        pending: false,
        nextTimer: 0,
        nextLeft: 0,
        stallTimer: 0,
        seekTimer: 0,
        dead: false
      };
      cur = S;

      root.querySelector('.qp-title').textContent = S.title || '在线播放';
      bind(S);
      renderEps(S, S.eps.length ? '' : '正在读取选集…');
      renderLines(S);
      updateSub(S);

      /* 官方源（ctx.sources 里带 url 的才可播；没 url 的等 75 取到地址后调 play） */
      (ctx.sources || []).forEach(function (src) { if (src && src.url) addLine(S, src); });
      renderLines(S);

      m.appendChild(root);
      try { root.scrollIntoView({ block: 'center' }); } catch (e) { /* 忽略 */ }

      /* 弹幕：必须在入 DOM 之后初始化 —— dmSet 会立刻启动 rAF，alive() 需要 root.isConnected 为真 */
      dmInit(S, ctx);

      if (S.lines.length) startLine(S, 0);
      else setState(S, 'loading', { msg: '正在准备播放…' });
      return S.tok;
    }

    function close() {
      var S = cur;
      if (!S) return;                             // 幂等
      cur = null;
      S.dead = true;
      if (S.nextTimer) { clearInterval(S.nextTimer); S.nextTimer = 0; }
      clearStall(S);
      if (S.seekTimer) { clearTimeout(S.seekTimer); S.seekTimer = 0; }
      dmClear(S);                                 // 弹幕：停 rAF + 清引用，防泄漏
      try { document.removeEventListener('visibilitychange', S.onVis); } catch (e) { /* 忽略 */ }
      try { window.removeEventListener('pagehide', S.onPageHide); } catch (e) { /* 忽略 */ }
      try {
        S.v.pause();
        S.v.removeAttribute('src');
        if (S.v.load) S.v.load();                 // 断流：否则移除节点后仍可能继续取流
      } catch (e) { /* 忽略 */ }
      if (S.root && S.root.parentNode) S.root.parentNode.removeChild(S.root);
      S.lines = [];
      S.eps = [];
    }

    function isCurrent(tok) {
      return !!cur && !!tok && cur.tok === tok && isConn(cur.root);
    }
    function isConn(node) { return !!(node && node.isConnected); }

    /* ---------------- 对外弹幕 API（同一时刻只有一个播放器，统一作用在 cur 上） ---------------- */
    function setDanmaku(items) { return cur && cur.dm ? dmSet(cur, items) : 0; }
    function toggleDanmaku(on) {
      if (!cur || !cur.dm) return false;
      return dmToggle(cur, on === undefined ? !cur.dm.on : !!on);
    }
    function danmakuOn() { return !!(cur && cur.dm && cur.dm.on); }
    function clearDanmaku() { if (cur && cur.dm) dmClear(cur); }

    return {
      open: open,
      close: close,
      state: state,
      play: play,
      setSources: setSources,
      setEpisodes: setEpisodes,
      setFid: setFid,
      pause: pause,
      isCurrent: isCurrent,
      setDanmaku: setDanmaku,
      toggleDanmaku: toggleDanmaku,
      danmakuOn: danmakuOn,
      clearDanmaku: clearDanmaku,
      _gate: gate,                                 // 离线自检：进度节流是纯函数
      _lines: { of: byoOf, save: saveByo, del: delByo }
    };
  })();
  /* 控制台调试入口；75-quarkplay.js 与 70-modal.js 走同一 IIFE 作用域的 QPlayer，不依赖 window */
  window.QPlayer = QPlayer;
