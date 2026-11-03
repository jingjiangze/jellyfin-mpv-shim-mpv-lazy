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
    return i < 0;
  }

  /* 海报清晰度：hd 用大图 ANI.poster，sd 用小图 ANI.posterSd（省流量）。
     sd 图缺失或加载失败时由 data-fb 回落到大图，绝不能出现空白封面。 */
  var PSZ = { mode: 'hd' };
  try {
    var _psz = localStorage.getItem('psz');
    if (_psz === 'hd' || _psz === 'sd') PSZ.mode = _psz;
  } catch (e) { /* 隐私模式 / file:// 下 localStorage 可能不可用，忽略 */ }
