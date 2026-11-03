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
    return i < 0;
  }

  /* 海报清晰度：hd 用大图 ANI.poster，sd 用小图 ANI.posterSd（省流量）。
     sd 图缺失或加载失败时由 data-fb 回落到大图，绝不能出现空白封面。 */
  var PSZ = { mode: 'hd' };
  try {
    var _psz = localStorage.getItem('psz');
    if (_psz === 'hd' || _psz === 'sd') PSZ.mode = _psz;
  } catch (e) { /* 隐私模式 / file:// 下 localStorage 可能不可用，忽略 */ }
