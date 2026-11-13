  /* ---------------- 原生播放器宿主（76，2026-11-07 重写） ----------------
     用户决定：删掉自研播放器皮肤（自绘控制条 + canvas 弹幕），改用原生样式——
       · 有 sources（夸克 / B 站直链）→ 原生 <video controls>，控制条用浏览器自带；
       · 没有直链 → 一条状态行（加载 / 转码 / 登录 / 需要重新绑定 / 错误 + 动作按钮）；
       · 选集 = 视频下方一排集数按钮（回调 ctx.onPickEp，与旧版一致）。
     对外接口与旧 QPlayer 完全一致（open/state/setEpisodes/setFid/pause/play/
     isCurrent/close）——75（夸克/磁力）与 80（B 站弹幕版）零改动。
     弹幕层随自研皮肤一起删除：B 站源用官方嵌入播放器自带弹幕；夸克源不再有弹幕。 */
  var QPlayer = (function () {
    var CUR = null;                            // {gen, m, ctx, ep, fid, last}
    var GEN = 0;
    var REPORT_EVERY = 8000;                   // timeupdate 节流：8s 上报一次进度

    function slot() {
      var m = CUR && CUR.m;
      return (m && m.querySelector) ? (m.querySelector('#dpPlayer') || m) : null;
    }
    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    function clear() {
      var s = slot();
      if (s) s.innerHTML = '';
    }
    function report(pos, dur, final) {
      if (!CUR || !CUR.ctx || typeof CUR.ctx.onProgress !== 'function') return;
      try {
        CUR.ctx.onProgress({ ep: CUR.ep, fid: CUR.fid, pos: Math.max(0, pos || 0), dur: Math.max(0, dur || 0), final: !!final });
      } catch (e) { /* 上报失败不影响播放 */ }
      CUR.last = Date.now();
    }
    function status(html) {
      var s = slot();
      if (!s) return;
      s.innerHTML = '<div class="nv-status">' + html + '</div>';
    }
    function stHtml(kind, opt) {
      opt = opt || {};
      var msg = esc(opt.msg || '');
      var btns = '';
      if (kind === 'login') {
        btns = '<button class="btn pri" id="nvLogin" type="button">登录</button>';
      } else if (kind === 'rebind') {
        btns = '<button class="btn pri" id="nvRebind" type="button">重新绑定夸克</button>';
      } else if (kind === 'error' && CUR && CUR.ctx && typeof CUR.ctx.onRetry === 'function') {
        btns = '<button class="btn" id="nvRetry" type="button">重试</button>';
      }
      var acts = (opt.actions || []).map(function (a, i) {
        return '<button class="btn' + (i === 0 ? ' pri' : '') + '" data-nv-act="' + i + '" type="button">' + esc(a.label || '') + '</button>';
      }).join('');
      return '<p class="nv-msg">' + msg + '</p>' + (acts || btns ? '<div class="nv-acts">' + acts + btns + '</div>' : '');
    }
    function wireStatus(kind, opt) {
      var s = slot();
      if (!s) return;
      if (kind === 'login') {
        var l = s.querySelector('#nvLogin');
        if (l) l.onclick = function () { if (typeof window.__openLogin === 'function') window.__openLogin('email'); };
      } else if (kind === 'rebind') {
        var r = s.querySelector('#nvRebind');
        if (r) r.onclick = function () {
          if (typeof quarkBindUrl === 'function') { window.open(quarkBindUrl(), '_blank', 'noopener'); return; }
          window.location.href = '/user';
        };
      } else if (kind === 'error' && opt && !opt.actions) {
        var t = s.querySelector('#nvRetry');
        if (t && CUR && CUR.ctx && typeof CUR.ctx.onRetry === 'function') t.onclick = function () { CUR.ctx.onRetry(); };
      }
      var acts = (opt && opt.actions) || [];
      if (acts.length) {
        [].forEach.call(s.querySelectorAll('[data-nv-act]'), function (b) {
          b.onclick = function () { var a = acts[Number(b.getAttribute('data-nv-act'))]; if (a && typeof a.fn === 'function') a.fn(); };
        });
      }
    }
    function renderEps() {
      var s = slot();
      if (!s || !CUR) return;
      var row = s.querySelector('.nv-eps');
      var list = CUR.eps || [];
      if (!row || !list.length) return;
      row.innerHTML = list.map(function (x) {
        var on = Number(x.ep) === Number(CUR.ep) ? ' on' : '';
        return '<button class="nv-ep' + on + '" type="button" data-ep="' + Number(x.ep) + '">' + Number(x.ep) + '</button>';
      }).join('');
      [].forEach.call(row.querySelectorAll('.nv-ep'), function (b) {
        b.onclick = function () {
          var ep = Number(b.getAttribute('data-ep'));
          if (CUR && CUR.ctx && typeof CUR.ctx.onPickEp === 'function') CUR.ctx.onPickEp(ep);
        };
      });
    }
    /* ---- HLS（m3u8）----
       外部采集源全是 m3u8；桌面 Chrome 的 <video> 不支持原生 HLS，必须挂 hls.js。
       组件优先从盒子自托管取（境内稳定、同源无关跨域），公共 CDN 只作兜底。
       加载失败（全部候选都挂）时把错误交给 ctx.onPlayErr，由调用方换下一条线路。 */
    var HLS = null, HLS_PEND = null;
    function hlsSrcs() {
      var base = (typeof SRC_BASE === 'string' && SRC_BASE) ? SRC_BASE : 'https://120.48.56.189';
      return [base + '/ext/hls.js',
              'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js',
              'https://unpkg.com/hls.js@1.5.17/dist/hls.min.js',
              'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.17/hls.min.js'];
    }
    function loadHls(cb) {
      if (window.Hls) { cb(true); return; }
      if (HLS_PEND) { HLS_PEND.push(cb); return; }
      HLS_PEND = [cb];
      var list = hlsSrcs(), i = 0;
      function done(ok) {
        var q = HLS_PEND || []; HLS_PEND = null;
        for (var k = 0; k < q.length; k++) { try { q[k](ok); } catch (e) { } }
      }
      function next() {
        if (i >= list.length) { done(false); return; }
        var el = document.createElement('script');
        var fin = false;
        var t = setTimeout(function () { if (fin) return; fin = true; el.onload = el.onerror = null; if (el.parentNode) el.parentNode.removeChild(el); next(); }, 6000);
        el.onload = function () {
          if (fin) return; fin = true; clearTimeout(t);
          if (window.Hls) { done(true); return; }
          if (el.parentNode) el.parentNode.removeChild(el);
          next();
        };
        el.onerror = function () {
          if (fin) return; fin = true; clearTimeout(t);
          if (el.parentNode) el.parentNode.removeChild(el);
          next();
        };
        el.src = list[i++];
        document.head.appendChild(el);
      }
      next();
    }
    function hlsFail(detail) {
      if (!CUR) return;
      if (CUR.ctx && typeof CUR.ctx.onPlayErr === 'function') { try { CUR.ctx.onPlayErr(detail || 'hls'); return; } catch (e) { } }
      status(stHtml('error', { msg: '视频加载失败（网络或源已过期）' }));
      wireStatus('error');
    }
    function killHls() {
      if (HLS) { try { HLS.destroy(); } catch (e) { } HLS = null; }
    }

    function mountVideo(url, startAt, opt) {
      var s = slot();
      if (!s || !CUR) return;
      clear();
      killHls();
      CUR.hlsOk = false;
      var v = document.createElement('video');
      v.setAttribute('controls', '');
      v.setAttribute('autoplay', '');
      v.setAttribute('playsinline', '');
      var isHls = (opt && opt.hls) || /\.m3u8(\?|#|$)/i.test(String(url || ''));
      var nativeHls = !!(v.canPlayType && v.canPlayType('application/vnd.apple.mpegurl'));
      if (!isHls || nativeHls) v.src = url;
      if (startAt > 0) v.currentTime = startAt;   // loadedmetadata 前赋值也能生效
      v.style.width = '100%';
      v.style.aspectRatio = '16 / 9';
      v.style.background = '#000';
      v.style.display = 'block';
      s.appendChild(v);
      var epsRow = document.createElement('div');
      epsRow.className = 'nv-eps';
      s.appendChild(epsRow);
      renderEps();
      CUR.last = 0;
      v.addEventListener('loadedmetadata', function () {
        if (startAt > 0) { try { v.currentTime = startAt; } catch (e) { } }
      });
      v.addEventListener('timeupdate', function () {
        if (!CUR) return;
        if (Date.now() - CUR.last < REPORT_EVERY) return;
        report(v.currentTime, v.duration || 0, false);
      });
      v.addEventListener('pause', function () {
        if (CUR) report(v.currentTime, v.duration || 0, false);
      });
      v.addEventListener('ended', function () {
        report(v.duration, v.duration, true);
        if (CUR && CUR.ctx && typeof CUR.ctx.onEnded === 'function') CUR.ctx.onEnded();
      });
      v.addEventListener('error', function () {
        if (!CUR) return;
        /* 外部源有下一条线路可换：先把错误交出去（CUR.ctx.onPlayErr），
           没有回调才落成静态错误行。 */
        if (CUR.ctx && typeof CUR.ctx.onPlayErr === 'function') { hlsFail('video'); return; }
        status(stHtml('error', { msg: '视频加载失败（网络或源已过期）' }));
        wireStatus('error');
        if (CUR.ctx && typeof CUR.ctx.onRetry === 'function') { /* 重试按钮已给 */ }
      });

      if (isHls && !nativeHls) {
        var myGen = CUR.gen;
        loadHls(function (ok) {
          if (!CUR || CUR.gen !== myGen) return;
          if (!ok || !window.Hls) { hlsFail('hls-load'); return; }
          try {
            HLS = new window.Hls({ maxBufferLength: 30, manifestLoadingTimeOut: 9000 });
            HLS.loadSource(url);
            HLS.attachMedia(v);
            /* 9s 内没解析出清单就当这条线路坏了（采集站死链常见形态：连接成功但永不返回） */
            var guard = setTimeout(function () {
              if (CUR && CUR.gen === myGen && !(CUR.hlsOk)) { hlsFail('hls-timeout'); }
            }, 12000);
            HLS.on(window.Hls.Events.MANIFEST_PARSED, function () {
              if (CUR) CUR.hlsOk = true;
              clearTimeout(guard);
              try { var pr = v.play(); if (pr && pr.catch) pr.catch(function () { }); } catch (e) { }
            });
            HLS.on(window.Hls.Events.ERROR, function (ev, data) {
              if (!data || !data.fatal) return;
              clearTimeout(guard);
              hlsFail('hls:' + String(data.details || data.type || 'error'));
            });
          } catch (e) { hlsFail('hls-init'); }
        });
      }
    }

    return {
      /* 打开播放器骨架：ctx = {m, id, title, ep, sources, startAt, onProgress, onPickEp, onNext, onEnded, onRetry, dm} */
      open: function (ctx) {
        GEN += 1;
        CUR = { gen: GEN, m: ctx.m, ctx: ctx, ep: Number(ctx.ep) > 0 ? Number(ctx.ep) : 1, fid: '', last: 0, eps: [] };
        clear();
        status(stHtml('loading', { msg: '准备中…' }));
        return { gen: GEN };
      },
      /* 状态行：loading / transcoding / error / login / rebind / none / quota */
      state: function (kind, opt) {
        if (!CUR) return;
        status(stHtml(kind, opt));
        wireStatus(kind, opt);
        renderEps();
      },
      /* 选集：list = [{ep, name?, magnet?…}]；只渲染集号按钮（点选走 ctx.onPickEp） */
      setEpisodes: function (list, ep, hint) {
        if (!CUR) return;
        CUR.eps = list || [];
        if (Number(ep) > 0) CUR.ep = Number(ep);
        var s = slot();
        if (!s) return;
        var row = s.querySelector('.nv-eps');
        if (!row) {
          row = document.createElement('div');
          row.className = 'nv-eps';
          s.appendChild(row);
        }
        if (hint && !CUR.eps.length) {
          row.innerHTML = '<span class="nv-hint">' + esc(hint) + '</span>';
        } else {
          renderEps();
        }
      },
      setFid: function (fid) { if (CUR) CUR.fid = String(fid || ''); },
      pause: function () {
        var s = slot();
        var v = s && s.querySelector('video');
        if (v && !v.paused) { try { v.pause(); } catch (e) { } }
        if (CUR && CUR.last) report((slot() && slot().querySelector('video') || {}).currentTime || 0, (slot() && slot().querySelector('video') || {}).duration || 0, false);
      },
      /* 起播：url = 直链（夸克 CDN / B 站 upos / 外部源 m3u8），startAt = 续播秒数 */
      play: function (url, label, opt) {
        if (!CUR || !url) return;
        mountVideo(url, (opt && Number(opt.startAt)) || 0, opt);
      },
      isCurrent: function (tok) { return !!(tok && CUR && tok.gen === CUR.gen); },
      close: function () {
        if (CUR) { try { report(0, 0, false); } catch (e) { } }
        CUR = null;
        killHls();
        clear();
      }
    };
  })();
  window.QPlayer = QPlayer;
