  /* 追番：localStorage 存 [{id, t}]（t = 追番时间戳 ms，首页「我的追番」按它倒序）。
     弹窗里 #favbtn 依赖这些函数——之前只加了按钮没加实现，点卡片会抛
     ReferenceError 并中断 openModal，导致简介/标签/评分分布永远停在「加载中…」。
     兼容旧格式：早期存的是纯字符串 id 数组（['123']），一律当作 {id:'123', t:0}，
     旧条目在首页排在最后；写回永远是新格式。 */
  var FAV_KEY = 'follow';
  /* 内部解包：两种格式混存时统一成 {id, t}，非法元素（null / 空串 / 缺 id）直接跳过；
     t 不是正数就按 0（旧格式条目与坏时间戳同等对待）。解析异常回退空数组。 */
  function favEntries() {
    var raw;
    try { raw = JSON.parse(localStorage.getItem(FAV_KEY) || '[]'); } catch (e) { return []; }
    if (Object.prototype.toString.call(raw) !== '[object Array]') return [];
    var out = [];
    raw.forEach(function (x) {
      var id, t;
      if (x && typeof x === 'object') {
        if (x.id == null) return;
        id = String(x.id);
        t = Number(x.t);
        if (!isFinite(t) || t < 0) t = 0;
      } else {
        if (x == null) return;
        id = String(x);
        t = 0;
      }
      if (id) out.push({ id: id, t: t });
    });
    return out;
  }
  /* 对外签名保持不变：字符串 id 数组（70-modal.js 的 isFollowed / toggleFollow 依赖） */
  function favList() {
    return favEntries().map(function (e) { return e.id; });
  }
  function isFollowed(id) { return favList().indexOf(String(id)) >= 0; }
  function toggleFollow(id) {
    var a = favEntries(), k = String(id), i = -1;
    a.forEach(function (e, n) { if (i < 0 && e.id === k) i = n; });  // 旧格式已解包，两种都能删
    if (i >= 0) a.splice(i, 1); else a.push({ id: k, t: Date.now() });
    try { localStorage.setItem(FAV_KEY, JSON.stringify(a)); } catch (e) { /* 忽略 */ }
    var now = i < 0;
    /* 本地先落地，远端只是回写：请求失败 / 超时 / 未登录都不能影响这次点击的结果，
       多设备一致性靠下次 pullFollow() 的合并兜回来。 */
    var tk = followToken();
    if (tk) {
      try {
        fetch(FOLLOW_API, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tk },
          body: JSON.stringify({ id: k, on: now })
        }).catch(function () { /* 静默：本地已写入，不弹错、不回滚 */ });
      } catch (e) { /* fetch 不可用 / 同步抛错也忽略：本地已写入 */ }
    }
    return now;
  }

  /* 追番同步：localStorage（FAV_KEY='follow'，格式 [{id,t}]）是主存储，登录后与盒子远端
     best-effort 对齐。token 读取故意与 90-boot.js 各写一份：本文件在 90-boot.js 之前求值，
     共享的 var 此刻还是 undefined。 */
  var FOLLOW_API = 'https://120.48.56.189/auth/follow';
  function followToken() {
    try { return localStorage.getItem('gh_token') || ''; } catch (e) { return ''; }
  }

  /* 远端条目合并进本地（以 id 为键做并集，本地条目结构不变）。
     on=1 → 本地没有就加入，t 取远端 ts（epoch 毫秒；非法 / 缺失退 Date.now()）；
     on=0 → 从本地移除。on=0 是「墓碑」：别的设备取消追番时本地只有靠它才知道要删，
     否则按「远端没有 ≠ 删除」的规则被取消的条目会永远留在本地。
     只在本地有的条目一律保留。合并前后连 t 一起比对，完全一致就返回 false 且不写盘
     （每次启动都摸一次 localStorage 没必要，也避开隐私模式 / 配额满的异常分支）。 */
  function mergeRemote(items) {
    if (!items || !items.length) return false;
    var before = favEntries(), after = before.slice();
    items.forEach(function (it) {
      if (!it || it.id == null) return;
      var k = String(it.id), i = -1;
      after.forEach(function (e, n) { if (i < 0 && e.id === k) i = n; });
      if (it.on === true || Number(it.on) === 1) {
        if (i < 0) {
          var t = Number(it.ts);
          after.push({ id: k, t: isFinite(t) && t > 0 ? t : Date.now() });
        }
      } else if (it.on === false || Number(it.on) === 0) {
        if (i >= 0) after.splice(i, 1);
      }
      /* 其它 on 值（脏数据）忽略，不当成删除 */
    });
    var same = after.length === before.length;
    if (same) {
      for (var n = 0; n < after.length; n++) {
        if (!(after[n].id === before[n].id && after[n].t === before[n].t)) { same = false; break; }
      }
    }
    if (same) return false;
    try { localStorage.setItem(FAV_KEY, JSON.stringify(after)); } catch (e) { /* 忽略 */ }
    return true;
  }

  /* 启动时拉一次远端并合并。没 token 直接返回（不打无意义的 401 请求）；
     任何失败（断网 / 401 / 非 JSON / 后端抖动）都静默忽略，保持本地不动。 */
  function pullFollow() {
    var tk = followToken();
    if (!tk) return;
    try {
      fetch(FOLLOW_API, { headers: { authorization: 'Bearer ' + tk } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d || !d.ok || !d.items) return;
          /* 只有真变了才通知：追番页（40-home.js 的 renderFavPage）靠 favchange 就地重绘 */
          if (mergeRemote(d.items)) {
            try { document.dispatchEvent(new CustomEvent('favchange')); } catch (e) { /* 忽略 */ }
          }
        })
        .catch(function () { /* 静默：追番是增值功能，拉不到不影响任何页面渲染 */ });
    } catch (e) { /* fetch 不可用 / 同步抛错也忽略 */ }
  }

  /* 海报清晰度：hd 用大图 ANI.poster，sd 用小图 ANI.posterSd（省流量）。
     sd 图缺失或加载失败时由 data-fb 回落到大图，绝不能出现空白封面。 */
  var PSZ = { mode: 'hd' };
  try {
    var _psz = localStorage.getItem('psz');
    if (_psz === 'hd' || _psz === 'sd') PSZ.mode = _psz;
  } catch (e) { /* 隐私模式 / file:// 下 localStorage 可能不可用，忽略 */ }

  /* 立即拉一次：fetch 不依赖 DOM，不用等 DOMContentLoaded。
     注意执行顺序：从 URL #t=<token> 收 token 的是 90-boot.js，而本文件更早求值——
     那一次拿不到 token 会直接返回，下次刷新再同步，行为上只差一次。 */
  pullFollow();
