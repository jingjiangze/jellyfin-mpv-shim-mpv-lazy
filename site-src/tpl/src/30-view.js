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

  /* 海报版本号 = 站点构建号（body[data-build]）。海报在数据集里会被重新抓取/更新，
     浏览器和边缘缓存可能还留着旧图 —— URL 带上构建号，每次部署即「强制刷新」全部海报。 */
  var BUILD = '';
  try { BUILD = String(document.body.getAttribute('data-build') || '').replace(/[^0-9A-Za-z]/g, ''); } catch (e) { }
  if (!BUILD) BUILD = 'x';

  function bust(u) {
    if (!u) return u;
    return u + (u.indexOf('?') < 0 ? '?' : '&') + 'v=' + BUILD;
  }

  /* 海报两档（实测同一部）：
       posters/bgm-<id>.jpg    203–446 KB —— 高清
       posters-c/bgm-<id>.jpg     10 KB   —— 缩略图
     2026-11-07 定版：**默认就要高清**（所有位主图一律高清 + 构建号强制刷新），
     缩略图只作为「高清加载失败」时的自动回退档，没有任何手动切换入口。 */
  function posterHd(id) { return bust((ANI.poster || '') + id + '.jpg'); }

  /* 主图 = 高清（番组卡 / 详情封面 / banner / 播放器封面统一走这里） */
  function posterSrc(id) { return posterHd(id); }

  /* 回退链：高清挂了 → 缩略图 → AniList 封面 */
  function posterFb(id, ex) {
    var base = ANI.posterSd || ANI.poster || '';
    var sd = base ? bust(base + id + '.jpg') : '';
    if (sd === posterHd(id)) sd = '';
    return fbAttr([sd, (ex || [])[1]]);
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
    var img = x.img ? '<img src="' + esc(bust(x.img)) + '" loading="lazy" decoding="async" alt="">'
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
