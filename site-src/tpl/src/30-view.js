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

  function posterSrc(id) {
    var base = PSZ.mode === 'sd' ? (ANI.posterSd || ANI.poster) : ANI.poster;
    return base + id + '.jpg';
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
    var alCover = ex[1] || '';
    var src = posterSrc(id);
    var fb = PSZ.mode === 'sd' ? [alCover, ANI.poster + id + '.jpg'] : [alCover];
    var h = '<article class="card" data-id="' + id + '"><div class="pw">'
      + '<img src="' + esc(src) + '"' + fbAttr(fb) + ' loading="lazy" decoding="async" alt="">'
      + (r[7] ? '<span class="rate">★ ' + Number(r[7]).toFixed(1) + '</span>' : '')
      + (r[8] ? '<span class="ep">' + r[8] + ' 集</span>' : '')
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
