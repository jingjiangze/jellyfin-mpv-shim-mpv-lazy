  /* ---------------- 自研播放器（零依赖原生 <video>，76-qplayer.js） ----------------
     为什么不用第三方播放器：要放的东西只有两类直链 —— 盒子签发的夸克 CDN 地址，
     以及用户自己粘贴的 m3u8 / mp4。只需要 <video> 加一层控件；引 hls.js / CDN
     反而多一个失败点，也违背「不引入第三方」的约束。

     DOM 外壳必须是 .trailer.qplayer：70-modal.js 的 close() 与预告 iframe 共用
     .trailer 的清理逻辑（先 pause + 断源，再摘节点），换外壳会让关闭时视频继续出声。

     契约（75-quarkplay.js 调用）：
       QPlayer.open(ctx) → token
         ctx = {m, id, title, ep, sources:[{label,url,type}], startAt,
                onProgress, onEnded, onNext, onPickEp, onRetry}
       QPlayer.state(s, extra)   s ∈ loading|transcoding|none|login|quota|rebind|error|ready
       QPlayer.play(url, label, opt)   切一条直链并播放（opt = {fid, startAt}）
       QPlayer.setSources(list)        替换「官方源」部分（用户自备线路不受影响）
       QPlayer.setEpisodes(list, cur, hint)
       QPlayer.setFid(fid)             进度上报要带的网盘文件 id
       QPlayer.close()                 幂等

     BYO 线路存 localStorage['qp_lines']：{"<bgm id>":[{label,url,type}]}。
     不内置任何第三方解析线路，也不替用户向任何站点取流。 */
  var QP_LINES_KEY = 'qp_lines';
  var QP_LINE_MAX = 20;                       // 单番最多存 20 条自备线路，防 localStorage 膨胀
  var QP_RATES = [2, 1.5, 1.25, 1, 0.75];     // 倍速循环（初始 1.0×，按钮按数组顺序轮转）
  var QP_REBIND = 'https://120.48.56.189/qr/';

  var QPlayer = (function () {
    /* 静态骨架：不含任何用户数据，动态内容一律 textContent / 事件绑定 */
    var TPL = '<div class="qp-head"><b class="qp-title"></b><span class="qp-sub"></span>'
      + '<button class="qp-btn qp-close" type="button" aria-label="关闭播放器">×</button></div>'
      + '<div class="qp-stage"><video class="qp-video" playsinline preload="metadata"></video>'
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
      _gate: gate,                                 // 离线自检：进度节流是纯函数
      _lines: { of: byoOf, save: saveByo, del: delByo }
    };
  })();
  /* 控制台调试入口；75-quarkplay.js 与 70-modal.js 走同一 IIFE 作用域的 QPlayer，不依赖 window */
  window.QPlayer = QPlayer;
