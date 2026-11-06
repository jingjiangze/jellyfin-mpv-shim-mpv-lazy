  function fbAttr(list) {
    var q = list.filter(Boolean);
    return q.length ? ' data-fb="' + esc(q.join('|')) + '" onerror="__fb(this)"' : '';
  }
  window.__fb = function (img) {
    var q = (img.dataset.fb || '').split('|').filter(Boolean);
    if (!q.length) { img.onerror = null; img.style.visibility = 'hidden'; return; }
    img.src = q.shift();
    img.dataset.fb = q.join('|');
  };

  /* 海报有两种尺寸档（实测同一部）：
       posters/bgm-632061.jpg    203–446 KB   —— 大图
       posters-c/bgm-632061.jpg     10 KB     —— 缩略图
     卡片宽度只有 183px、详情页封面 184px，用 400KB 的大图纯属浪费（首屏 28 张 ≈ 7MB）。
     所以：**按显示尺寸选档** —— 卡片/弹窗封面用缩略图，全宽 banner / 播放器封面用大图；
     任何一档加载失败都由 data-fb 链自动换下一档，用户不需要手动切换。 */
  function posterBig(id) { return (ANI.poster || '') + id + '.jpg'; }

  /* 卡片与详情页封面（≈184px 宽）：优先缩略图，没有小图档时退回大图 */
  function posterSrc(id) {
    var base = ANI.posterSd || ANI.poster || '';
    return base + id + '.jpg';
  }

  /* 大图（banner 250px 高全宽、播放器封面 688×387 用得上） */
  function posterHd(id) { return posterBig(id); }

  /* 小图 → 大图 → AniList 封面。第一档挂了浏览器报 onerror，链条自动降级。 */
  function posterFb(id, ex) {
    return fbAttr([posterBig(id), (ex || [])[1]]);
  }

  /* 大图 → 小图 → AniList：给 banner / 播放器封面用（首档就是大图） */
  function posterFbHd(id, ex) {
    var sd = posterSrc(id);
    return fbAttr([sd === posterBig(id) ? '' : sd, (ex || [])[1]]);
  }

  /* 角色头像：CI 会把 lain.bgm.tv 的图下载到自家 CDN，分片里存的是 ch-<id>-<i>.jpg 裸文件名。
     未镜像的条目仍是完整 https URL，而 lain.bgm.tv 在国内不可达（img.complete 永假、onerror 也不触发），
     直连只会被 .chcard img 的不透明底色盖成灰圆 —— 一律返回空串，交给 .chin 首字兜底。 */
  function avatarSrc(u) {
    if (!u || /^https?:/i.test(u)) return '';   // 未镜像的 lain.bgm.tv 图在国内不可达，直接出首字
    return String(ANI.poster || '').replace(/bgm-$/, '') + u;
  }

  /* 卡片标题用：连字符是 CSS 的合法断行点，"Yu-hachi" 会被拆成 "Yu-"/"hachi"。
     在连字符后插 word joiner（U+2060）阻止断行。只用于 .t —— 弹窗里的 h3
     要拿去做磁力匹配，绝不能掺入不可见字符。 */
  function titleHTML(s) {
    return esc(s).replace(/-/g, '-⁠');
  }

  function animeCard(r, opt) {
    var id = r[0], name = r[2] || r[1];
    var ex = ANI.extra[id] || [];
    var src = posterSrc(id);
    var h = '<article class="card" data-id="' + id + '"><div class="pw">'
      + '<img src="' + esc(src) + '"' + posterFb(id, ex) + ' loading="lazy" decoding="async" alt="">'
      /* 名次件（只有排行块传 opt.rank）：gamer 排行榜的角标是左上角一块深色方块 */
      + (opt && opt.rank ? '<span class="rnum' + (opt.rank <= 3 ? ' top' : '') + '">'
          + opt.rank + '</span>' : '')
      + (r[7] ? '<span class="rate">★ ' + Number(r[7]).toFixed(1) + '</span>' : '')
      + (r[8] ? '<span class="ep">' + r[8] + ' 集</span>' : '')
      + (function () { var pr = progressOf(id); return pr && pr.ep ? '<span class="prg">看到 第 ' + pr.ep + ' 集</span>' : ''; })()
      + '</div><div class="t">' + titleHTML(name) + '</div><div class="sub2">'
      + [(opt && opt.showYear ? (r[4] || '') : ''), TYPE[r[3]] || r[3] || ''].filter(Boolean).join(' · ')
      + '</div></article>';
    return h;
  }

  function mcard(x, kind, idx) {
    var img = x.img ? '<img src="' + esc(x.img) + '" loading="lazy" decoding="async" alt="">'
                    : '<div class="ph">🎬</div>';
    var rate = (x.r != null && x.r !== '') ? x.r : x.rating;
    var sub = [(rate ? '★ ' + Number(rate).toFixed(1) : ''), (x.y || x.year || '')]
      .filter(Boolean).join(' · ');
    return '<article class="mcard" data-ext="' + esc(kind || '') + '" data-i="'
      + (idx == null ? '' : idx) + '"><a href="' + esc(x.u || x.url || '#') + '" target="_blank" rel="noopener">'
      + '<div class="pw">' + img + '</div><div class="t">' + esc(x.n || x.title || '') + '</div>'
      + '<div class="sub2">' + sub + '</div></a></article>';
  }

  function msec(title, list, kind) {
    return '<section class="msect"><div class="mhead"><h2>' + title + '</h2><span>'
      + list.length + ' 部</span></div><div class="grid mgrid">'
      + list.map(function (x, i) { return mcard(x, kind, i); }).join('') + '</div></section>';
  }
