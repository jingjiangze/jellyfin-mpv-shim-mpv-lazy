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

  /* 追番进度（看到第几集）：localStorage 是主存储，登录后与盒子远端 best-effort 对齐。
     形状 {"<bgm id>": {ep, fid, pos, dur, ts}}：ep 只收正整数（<=0 视为无效丢弃），
     id 一律 String()；pos/dur 单位秒，ts 是毫秒时间戳。
     契约（同 follow 风格）：GET /auth/progress → {ok:true, items:[{id,ep,fid,pos,dur,ts}]}、
     POST /auth/progress（body {id,ep,fid,pos,dur}），未登录一律跳过。
     URL/token 各用本文件常量与 followToken()：本文件排在 90-boot.js 之前执行，启动那一次
     那里的 var AUTH_BASE / TOKEN_KEY 还没赋值，直接引用会静默拼出 undefined 而不同步。 */
  var PROG_API = 'https://120.48.56.189/auth/progress';
  var PROG_KEY = 'prog';

  /* 一条进度记录；ep 非正整数（0 / 负数 / 小数 / NaN）返回 null，调用方丢弃。
     ts 缺省取 nowTs —— 远端合并时传 0，表示「这条没有可比较的时间」，交给本地 ts 胜出。 */
  function progRec(ep, extra, nowTs) {
    var n = Number(ep);
    if (!isFinite(n) || n <= 0 || n !== Math.floor(n)) return null;
    var x = extra || {}, ts = Number(x.ts);
    return {
      ep: n,
      fid: String(x.fid == null ? '' : x.fid),
      pos: Math.max(0, Number(x.pos) || 0),
      dur: Math.max(0, Number(x.dur) || 0),
      ts: ts > 0 ? ts : (nowTs || 0)
    };
  }

  /* 启动时 parse 一次进内存，之后的读都走 PROG，写则同步内存 + 盘。
     坏数据（JSON 破损 / 数组 / 非对象）一律当空对象，不让它污染卡片渲染。 */
  var PROG = (function () {
    try {
      var v = JSON.parse(localStorage.getItem(PROG_KEY) || '{}');
      return v && typeof v === 'object' && Object.prototype.toString.call(v) !== '[object Array]' ? v : {};
    } catch (e) { return {}; }
  })();

  function progressOf(id) {
    var r = PROG[String(id)];
    return r && Number(r.ep) > 0 ? r : null;
  }
  function progressAll() { return PROG; }

  /* 写本地 → 回写远端。本地先落地，请求失败/超时/未登录都不影响这次调用（同 toggleFollow）；
     多设备一致性靠下次 pullProgress() 的 ts 合并兜回来。ep 无效时既不写盘也不发请求。 */
  function setProgress(id, ep, extra) {
    var k = String(id), rec = progRec(ep, extra, Date.now());
    if (!rec) return null;
    PROG[k] = rec;
    try { localStorage.setItem(PROG_KEY, JSON.stringify(PROG)); } catch (e) { /* 忽略 */ }
    var tk = followToken();
    if (tk) {
      fetch(PROG_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tk },
        body: JSON.stringify({ id: k, ep: rec.ep, fid: rec.fid, pos: rec.pos, dur: rec.dur })
      }).catch(function () { /* 静默：本地已写入，不弹错、不回滚 */ });
    }
    return rec;
  }

  /* 远端条目按 id last-write-wins 合并：本地 ts 更大（或相等）就不动，只有远端更新才覆盖。
     进度不是集合、没有「墓碑」语义，删条目直接删 id 即可。返回 true 表示本地确实变了。 */
  function mergeProgress(items) {
    if (!items || !items.length) return false;
    var changed = false;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || it.id == null) continue;
      var k = String(it.id), rec = progRec(it.ep, it, 0);
      if (!rec) continue;
      var cur = PROG[k];
      if (cur && Number(cur.ts) >= rec.ts) continue;
      PROG[k] = rec;
      changed = true;
    }
    if (changed) { try { localStorage.setItem(PROG_KEY, JSON.stringify(PROG)); } catch (e) { /* 忽略 */ } }
    return changed;
  }

  /* 启动时拉一次远端并合并。没 token 直接返回（不打无意义的 401 请求）；
     任何失败（断网 / 401 / 非 JSON / 后端抖动）都静默忽略，保持本地不动。 */
  function pullProgress() {
    var tk = followToken();
    if (!tk) return;
    fetch(PROG_API, { headers: { authorization: 'Bearer ' + tk } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.ok && d.items) mergeProgress(d.items); })
      .catch(function () { /* 静默：进度是增值功能，拉不到不影响任何页面渲染 */ });
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
  pullProgress();

  /* 磁力层（magnet-eps.js）是独立 IIFE、拿不到本文件的闭包：点行复制后经这个入口
     上报「看到第几集」。id 传 #modal 的 data-bgm，ep 是行上的数字集号（合集行没有）。 */
  window.__prog = { report: function (id, ep) { setProgress(id, ep); } };
