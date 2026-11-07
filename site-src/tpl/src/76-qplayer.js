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
    function mountVideo(url, startAt) {
      var s = slot();
      if (!s || !CUR) return;
      clear();
      var v = document.createElement('video');
      v.setAttribute('controls', '');
      v.setAttribute('autoplay', '');
      v.setAttribute('playsinline', '');
      v.src = url;
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
        status(stHtml('error', { msg: '视频加载失败（网络或源已过期）' }));
        wireStatus('error');
        if (CUR.ctx && typeof CUR.ctx.onRetry === 'function') { /* 重试按钮已给 */ }
      });
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
      /* 起播：url = 直链（夸克 CDN / B 站 upos），startAt = 续播秒数 */
      play: function (url, label, opt) {
        if (!CUR || !url) return;
        mountVideo(url, (opt && Number(opt.startAt)) || 0);
      },
      isCurrent: function (tok) { return !!(tok && CUR && tok.gen === CUR.gen); },
      close: function () {
        if (CUR) { try { report(0, 0, false); } catch (e) { } }
        CUR = null;
        clear();
      }
    };
  })();
  window.QPlayer = QPlayer;
