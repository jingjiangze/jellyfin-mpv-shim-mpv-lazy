  /* ---------------- 在线播放（夸克网盘 → 盒子 TV 转码） ----------------
     媒体字节不经过任何服务器：这里只向盒子服务要一条夸克 CDN 上的 mp4 直链，
     再由浏览器直接向 video-play-p-zb.drive.quark.cn 取流（支持 Range、不需要 cookie）。
     契约（已部署实测，token 与 20-state.js / 90-boot.js 同一份 localStorage.gh_token）：
       GET /tvplay/find?q=<片名>&limit=5 → {state:'found',items,best} / none / need_rebind(409) / unauthorized(401)
       GET /tvplay/url?fid=<fid>&wait=45  → {state:'ready',url,expires_in} / transcoding(202) / need_rebind(409)
     播放地址有效期短（expires_in），所以不做缓存：每次点按钮都重新 find + url。 */
  var QP_BASE = 'https://120.48.56.189';
  var QP_TIMER = 0;      // 挂起的转码轮询（模块级：新播放 / 关弹窗都要能掐掉）
  var QP_GEN = 0;        // 每次开播自增：异步回调据此判断自己是否已被后来的一次播放取代

  /* 统一取 JSON：网络失败、空体、非 JSON 一律退化成 {state:'error'}；
     后端已经带了 state 就原样用，只在缺 state 时按 HTTP 码兜底（401/409/202）。 */
  function qpJson(path, tk) {
    return fetch(QP_BASE + path, { headers: { authorization: 'Bearer ' + tk } }).then(function (res) {
      return res.text().then(function (t) {
        var j = null;
        try { j = JSON.parse(t); } catch (e) { j = null; }
        if (!j || typeof j !== 'object') j = {};
        if (!j.state) {
          if (res.status === 401) j.state = 'unauthorized';
          else if (res.status === 409) j.state = 'need_rebind';
          else if (res.status === 202) j.state = 'transcoding';
          else j.state = 'error';
        }
        return j;
      });
    }, function () { return { state: 'error' }; });
  }

  /* m = #modal 容器；id / title 是 openModal 里那一代的条目 id 与片名 */
  function openQuarkPlay(m, id, title) {
    if (!m) return;
    var tk = followToken();                       // 20-state.js：读 localStorage.gh_token
    if (!tk) { if (window.__openLogin) window.__openLogin('email'); return; }

    var gen = ++QP_GEN;                           // 换代：上一代在飞的请求与轮询全部作废
    if (QP_TIMER) { clearTimeout(QP_TIMER); QP_TIMER = 0; }

    /* 状态条复用 .trailer 容器（.qpmsg 只把它从 16:9 视频框改成自适应高的文字条）；
       先摘掉已有的 .trailer，避免预告 iframe / 上一次播放的 video 与状态条并存。 */
    var old = m.querySelector('.trailer');
    if (old && old.parentNode) {
      /* 摘掉的 <video> 在部分浏览器里仍会继续出声（close() 对预告 iframe 也踩过这个坑）：
         先暂停并断源，再移除节点。 */
      var ov = old.querySelector('video');
      if (ov) {
        try { ov.pause(); ov.removeAttribute('src'); if (ov.load) ov.load(); } catch (e) { /* 忽略 */ }
      }
      old.parentNode.removeChild(old);
    }
    var bar = document.createElement('div');
    bar.className = 'trailer qpmsg';
    bar.textContent = '正在查找网盘文件…';
    m.appendChild(bar);
    bar.scrollIntoView({ block: 'center' });

    /* 状态条还在文档里、且仍是这一代，才允许往它写（弹窗关掉/换番后内容已清空） */
    function alive() { return gen === QP_GEN && bar.isConnected; }
    function say(text) { if (alive()) bar.textContent = text; }
    function needLogin() {
      if (!alive()) return;
      if (bar.parentNode) bar.parentNode.removeChild(bar);
      if (window.__openLogin) window.__openLogin('email');
    }
    function needRebind() {
      if (!alive()) return;
      bar.innerHTML = '夸克登录已失效，去 <a href="' + QP_BASE + '/qr/" target="_blank" '
        + 'rel="noopener">https://120.48.56.189/qr/</a> 重新扫码';
    }

    function play(url) {
      if (!alive()) return;
      var d = document.createElement('div');
      d.className = 'trailer';
      d.innerHTML = '<video controls autoplay playsinline preload="metadata"></video>';
      var v = d.querySelector('video');
      if (v) v.setAttribute('src', url);          // 直链带签名参数，用属性赋值不经 innerHTML 转义
      if (bar.parentNode) bar.parentNode.replaceChild(d, bar);   // 换上视频 = 同时移除状态条
      else m.appendChild(d);
      d.scrollIntoView({ block: 'center' });
    }

    /* 转码轮询：最多 10 轮，间隔取后端给的 retry_after（夹在 1–60s，防后端回 0 时打爆） */
    function askUrl(fid, tries) {
      if (!alive()) return;
      if (tries > 10) { say('转码超时，稍后再试'); return; }
      qpJson('/tvplay/url?fid=' + encodeURIComponent(fid) + '&wait=45', tk).then(function (j) {
        if (!alive()) return;
        if (j.state === 'ready' && j.url) { play(String(j.url)); return; }
        if (j.state === 'transcoding') {
          say('转码中… 约 1 分钟');
          var wait = Number(j.retry_after);
          if (!(wait > 0)) wait = 5;
          QP_TIMER = setTimeout(function () {
            QP_TIMER = 0;
            if (!alive()) return;                 // 弹窗已关：不再排下一轮
            askUrl(fid, tries + 1);
          }, Math.min(wait, 60) * 1000);
          return;
        }
        if (j.state === 'need_rebind') { needRebind(); return; }
        if (j.state === 'unauthorized') { needLogin(); return; }
        say('播放服务暂时不可用');
      });
    }

    qpJson('/tvplay/find?q=' + encodeURIComponent(String(title || '')) + '&limit=5', tk).then(function (j) {
      if (!alive()) return;
      if (j.state === 'found') {
        var items = j.items || [];
        var best = j.best || items[0] || null;
        if (!best || best.fid == null || best.fid === '') { say('播放服务暂时不可用'); return; }
        say('找到 ' + items.length + ' 个文件，正在准备播放…');
        askUrl(String(best.fid), 0);
        return;
      }
      if (j.state === 'none') {
        say('你的夸克网盘里还没有这部；先点磁力行复制链接到夸克离线下载');
        return;
      }
      if (j.state === 'need_rebind') { needRebind(); return; }
      if (j.state === 'unauthorized') { needLogin(); return; }
      say('播放服务暂时不可用');
    });
  }

  /* 调试入口：控制台可 __qp() 直接触发，不影响线上逻辑 */
  window.__qp = openQuarkPlay;
