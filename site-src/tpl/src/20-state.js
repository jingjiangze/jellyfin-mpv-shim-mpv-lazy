  /* 追番同步：localStorage 是主存储，登录后与盒子远端 best-effort 对齐。
     契约（已上线实测）：GET /auth/follow → {ok:true, items:[{id,on,ts}]}、
     POST /auth/follow（body {id,on}）→ {ok:true, id, on, ts}，未登录一律 401。
     常量与 magnet-eps.js 各写一份：两个文件独立加载，不跨文件依赖。 */
  var FOLLOW_API = 'https://120.48.56.189/auth/follow';
  function followToken() {
    try { return localStorage.getItem('gh_token') || ''; } catch (e) { return ''; }
  }

  /* 追番：localStorage 存 id 数组。弹窗里 #favbtn 依赖这两个函数——
     之前只加了按钮没加实现，点卡片会抛 ReferenceError 并中断 openModal，
     导致简介/标签/评分分布永远停在「加载中…」。 */
  var FAV_KEY = 'follow';
  function favList() {
    try {
      var a = JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
      return Object.prototype.toString.call(a) === '[object Array]' ? a : [];
    } catch (e) { return []; }
  }
  function isFollowed(id) { return favList().indexOf(String(id)) >= 0; }
  function toggleFollow(id) {
    var a = favList(), k = String(id), i = a.indexOf(k);
    if (i >= 0) a.splice(i, 1); else a.push(k);
    try { localStorage.setItem(FAV_KEY, JSON.stringify(a)); } catch (e) { /* 忽略 */ }
    var now = i < 0;
    /* 本地先落地，远端只是回写：请求失败/超时/未登录都不能影响这次点击的结果，
       多设备一致性靠下次 pullFollow() 的合并兜回来。 */
    var tk = followToken();
    if (tk) {
      fetch(FOLLOW_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tk },
        body: JSON.stringify({ id: k, on: now })
      }).catch(function () { /* 静默：本地已写入，不弹错、不回滚 */ });
    }
    return now;
  }

  /* 远端条目合并进本地数组。on=1 → 本地没有就加入；on=0 → 从本地移除。
     on=0 是「墓碑」：别的设备取消追番时，本地只有靠它才知道要删，
     否则被取消的条目会在下次 pull 时又被本地数组「复活」回去。
     合并前后完全一致就不写盘 —— 每次启动都摸一次 localStorage 没必要，也省得
     在隐私模式/配额满时反复踩异常分支。返回 true 表示本地确实变了。 */
  function mergeRemote(items) {
    if (!items || !items.length) return false;
    var before = favList(), after = before.slice();
    items.forEach(function (it) {
      if (!it || it.id == null) return;
      var k = String(it.id), i = after.indexOf(k);
      if (Number(it.on) === 1) { if (i < 0) after.push(k); }
      else if (i >= 0) after.splice(i, 1);
    });
    var same = after.length === before.length && after.every(function (v, i) { return v === before[i]; });
    if (same) return false;
    try { localStorage.setItem(FAV_KEY, JSON.stringify(after)); } catch (e) { /* 忽略 */ }
    return true;
  }

  /* 启动时拉一次远端并合并。没 token 直接返回（不打无意义的 401 请求）；
     任何失败（断网 / 401 / 非 JSON / 后端抖动）都静默忽略，保持本地不动。 */
  function pullFollow() {
    var tk = followToken();
    if (!tk) return;
    fetch(FOLLOW_API, { headers: { authorization: 'Bearer ' + tk } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.ok && d.items) mergeRemote(d.items); })
      .catch(function () { /* 静默：追番是增值功能，拉不到不影响任何页面渲染 */ });
  }

  /* 海报清晰度：hd 用大图 ANI.poster，sd 用小图 ANI.posterSd（省流量）。
     sd 图缺失或加载失败时由 data-fb 回落到大图，绝不能出现空白封面。 */
  var PSZ = { mode: 'hd' };
  try {
    var _psz = localStorage.getItem('psz');
    if (_psz === 'hd' || _psz === 'sd') PSZ.mode = _psz;
  } catch (e) { /* 隐私模式 / file:// 下 localStorage 可能不可用，忽略 */ }

  /* 立即拉一次：fetch 不依赖 DOM，不需要等 DOMContentLoaded。
     （注意：从 /auth/start 回调落地的那一次，URL 里的 #t=<token> 由 90-boot.js
     的 grabToken 收进 localStorage，晚于本文件执行 —— 那一次 pull 会因没 token 直接返回，
     下次刷新再同步，行为上只差一次。） */
  pullFollow();
