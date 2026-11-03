(function () {
'use strict';
var $ = function (s) { return document.querySelector(s); };
var PAGE = document.body.dataset.page || 'home';
var TYPE = { tv: 'TV', movie: '剧场版', ova: 'OVA', web: '网络', music: '音乐', other: '其他' };
var WD = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
var esc = function (s) {
return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
});
};
function nrm(x) {
return String(x == null ? '' : x).toLowerCase()
.replace(/[\uFF01-\uFF5E]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 65248); })
.replace(/[\s\-_.·・:!?,.'"()\[\]{}<>【】（）~〜]/g, '');
}
function hit(hay, q) { return !q || nrm(hay).indexOf(q) !== -1; }
function j(u) { return fetch(u).then(function (r) { if (!r.ok) throw 0; return r.json(); }); }
var D_BASES = [
'https://modelscope.cn/datasets/jingjiangze/Anime-JPG/resolve/master/assets/data/',
'https://gh-proxy.com/https://raw.githubusercontent.com/jingjiangze/jellyfin-mpv-shim-mpv-lazy/main/media/data/',
'./data/'
];
function jd(name) {
var i = 0;
function go() {
if (i >= D_BASES.length) return Promise.reject(new Error('data ' + name + ' 三源都失败'));
var u = D_BASES[i++] + name;
var ctl = typeof AbortController === 'function' ? new AbortController() : null;
var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 12000);
return fetch(u, ctl ? { signal: ctl.signal } : undefined).then(function (r) {
clearTimeout(timer);
if (!r.ok) throw 0;
var ct = (r.headers.get('content-type') || '').toLowerCase();
if (ct.indexOf('json') < 0 && ct.indexOf('octet-stream') < 0) throw 0;  // CF 兜底 HTML 会命中这里
return r.json();
}).catch(function () { clearTimeout(timer); return go(); });
}
return go();
}
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
var ANI = { poster: '', posterSd: '', rows: [], extra: {}, year: 0 };
var shardCache = {};
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
var TAGCNT = {}, TAGCNT_LOADING = false;
function ensureTagCounts() {
if (TAGCNT_LOADING || Object.keys(TAGCNT).length) return;
TAGCNT_LOADING = true;
jd('tagcounts.json').then(function (d) { TAGCNT = d || {}; }, function () { TAGCNT_LOADING = false; });
}
var PSZ = { mode: 'hd' };
try {
var _psz = localStorage.getItem('psz');
if (_psz === 'hd' || _psz === 'sd') PSZ.mode = _psz;
} catch (e) { /* 隐私模式 / file:// 下 localStorage 可能不可用，忽略 */ }
function posterSrc(id) {
var base = PSZ.mode === 'sd' ? (ANI.posterSd || ANI.poster) : ANI.poster;
return base + id + '.jpg';
}
function avatarSrc(u) {
if (!u || /^https?:/i.test(u)) return '';   // 未镜像的 lain.bgm.tv 图在国内不可达，直接出首字
return String(ANI.poster || '').replace(/bgm-$/, '') + u;
}
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
function openModal(id) {
var r = ANI.rows.find(function (x) { return x[0] === id; });
if (!r) return;
var ex = ANI.extra[id] || [];
var title = r[2] || r[1];
var m = $('#modal');
m.innerHTML = '<span class="x" aria-label="关闭">×</span>'
+ '<div class="mhd">'
+   '<div class="mposter"><img src="' + esc(ANI.poster + id + '.jpg') + '"' + fbAttr([ex[1]]) + ' alt=""></div>'
+   '<div class="mb">'
+     '<h3>' + esc(title) + '</h3>'
+     (r[1] !== title ? '<div class="orig">' + esc(r[1]) + '</div>' : '')
+     '<div class="mbadges">'
+       (r[4] ? '<span class="mbadge">' + r[4] + (r[5] ? ' 年 ' + r[5] + ' 月' : ' 年') + '</span>' : '')
+       (r[3] ? '<span class="mbadge">' + esc(TYPE[r[3]] || r[3]) + '</span>' : '')
+       (r[8] ? '<span class="mbadge">' + r[8] + ' 话</span>' : '')
+     '</div>'
+     '<div class="mrate">'
+       (r[7] ? '<i class="stars" style="--p:' + Math.max(0, Math.min(10, Math.round(r[7])))
+ '"></i><b class="num">' + Number(r[7]).toFixed(1) + '</b>' : '<b class="num dim">暂无评分</b>')
+       '<span class="mvotes" id="mvotes"></span>'
+     '</div>'
+     '<dl class="infobox" id="minfo">'
+       (r[4] ? '<dt>放送</dt><dd>' + r[4] + (r[5] ? '.' + String(r[5]).padStart(2, '0') : '') + '</dd>' : '')
+       (r[6] ? '<dt>星期</dt><dd>' + WD[r[6] - 1] + '</dd>' : '')
+       (r[8] ? '<dt>话数</dt><dd>' + r[8] + ' 集</dd>' : '')
+       (r[3] ? '<dt>类型</dt><dd>' + esc(TYPE[r[3]] || r[3]) + '</dd>' : '')
+     '</dl>'
+   '</div>'
+ '</div>'
+ '<div class="mtabs">'
+   '<button class="mtab on" data-p="detail" type="button">详情</button>'
+   '<button class="mtab" data-p="rt" type="button">评价</button>'
+   '<button class="mtab" data-p="dm" type="button">弹幕</button>'
+   '<button class="mtab" data-p="rp" type="button">评论</button>'
+ '</div>'
+ '<div class="mbody" data-p="detail"><h4>简介</h4><p class="plot" id="plot">加载中…</p>'
+   '<div class="tags" id="tags"></div></div>'
+ '<div class="mbody" id="prt" data-p="rt" hidden></div>'
+ '<div class="mbody" id="pdm" data-p="dm" hidden></div>'
+ '<div class="mbody" id="prp" data-p="rp" hidden></div>'
+ '<div class="acts">'
+   '<span class="btn pri" id="watch" type="button">开始观看</span>'
+   '<span class="btn" id="favbtn" type="button">☆ 追番</span>'
+   '<a class="btn" target="_blank" rel="noopener" href="https://bgm.tv/subject/' + id + '">Bangumi</a>'
+   (ex[2] ? '<span class="btn" id="play">▶ 预告</span>' : '')
+   '<span class="btn" id="bplay" type="button">▶ B 站弹幕播放</span>'
+   '<button class="btn" id="mgopen" type="button">磁力详情</button>'
+   '<a class="btn" target="_blank" rel="noopener" href="https://search.bilibili.com/all?keyword='
+     encodeURIComponent(title) + '">B 站搜索</a>'
+ '</div>';
$('#mask').classList.add('on');
m.querySelector('.x').onclick = close;
var wb = m.querySelector('#watch');
if (wb) wb.onclick = function () {
var box = m.querySelector('#epsbox');
if (box && box.querySelector('.eps-chip')) {
box.scrollIntoView({ behavior: 'smooth', block: 'center' });
box.classList.add('flash');
setTimeout(function () { box.classList.remove('flash'); }, 1200);
return;
}
var bp = m.querySelector('#bplay');
if (bp) { bp.click(); return; }
window.open('https://bgm.tv/subject/' + id, '_blank');
};
var fb = m.querySelector('#favbtn');
if (fb) {
var fk = String(id);
fb.textContent = isFollowed(fk) ? '★ 已追' : '☆ 追番';
fb.classList.toggle('on', isFollowed(fk));
fb.onclick = function () {
var now = toggleFollow(fk);
fb.textContent = now ? '★ 已追' : '☆ 追番';
fb.classList.toggle('on', now);
};
}
var mgb = m.querySelector('#mgopen');
if (mgb) mgb.onclick = function () { openMagView(id, title, r[8] || 0); };
if (ex[2]) {
$('#play').onclick = function () {
if (m.querySelector('.trailer')) return;
var d = document.createElement('div');
d.className = 'trailer';
d.innerHTML = '<iframe src="https://www.youtube.com/embed/' + encodeURIComponent(ex[2])
+ '?autoplay=1&rel=0" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>';
m.appendChild(d);
};
}
ensureTagCounts();
bindBili(id, title, r[4] || '');
var sfx = id % 64;
var pr = shardCache[sfx];
if (!pr) {
pr = jd('s' + sfx + '.json').then(function (d) { return d; }, function () {
delete shardCache[sfx];          // 失败不缓存，下次还能重试
return null;
});
shardCache[sfx] = pr;
}
pr.then(function (list) {
var plot = $('#plot'), tags = $('#tags');
if (list === null) { plot.textContent = '简介加载失败，请重试'; return; }  // 分片拉不到，与「记录不存在」区分
var rec = (list || []).find(function (x) { return x.id === id; });
if (!rec) { plot.textContent = '暂无详细资料'; return; }
plot.textContent = rec.overview || '暂无简介';
tags.innerHTML = (rec.tags || []).filter(function (t, i, arr) { return arr.indexOf(t) === i; }).slice(0, 12).map(function (t) {
var n = TAGCNT[t];
return '<span class="tagpill">' + esc(t)
+ (n ? '<em>' + n + '</em>' : '') + '</span>';
}).join('');
var meta = [];
if (Array.isArray(rec.rc) && rec.rc.length === 10 && !document.querySelector('#rdist')) {
var host = document.querySelector('#prt');
if (host) {
var mx = Math.max.apply(null, rec.rc);
var sum = rec.rc.reduce(function (a, b) { return a + b; }, 0);
var bars = rec.rc.map(function (n, i) {
var h = mx ? Math.max(2, Math.round((n / mx) * 100)) : 2;
return '<i style="height:' + h + '%" title="' + (i + 1) + ' 分 · ' + n + ' 人">'
+ '<b>' + (i + 1) + '</b></i>';
}).join('');
var div = document.createElement('div');
div.className = 'rdist';
div.id = 'rdist';
div.innerHTML = '<div class="rdhead">星级分布合计 <b>' + sum + '</b> 人'
+ (rec.rank ? ' · 排名 <b>#' + rec.rank + '</b>' : '')
+ (rec.votes ? ' · Bangumi 共 ' + rec.votes + ' 人评分' : '') + '</div>' + bars;
host.appendChild(div);
}
}
if (Array.isArray(rec.ch) && rec.ch.length) {
var cb = document.createElement('div');
cb.className = 'relbox';
cb.innerHTML = '<div class="relhead">角色</div><div class="chgrid">'
+ rec.ch.map(function (c) {
var av = avatarSrc(c[2]);
var nm = esc(c[0]);
return '<div class="chcard"><span class="ph">'
+ '<span class="chin">' + esc(Array.from(String(c[0] == null ? '' : c[0]))[0] || '?') + '</span>'
+ (av ? '<img class="chav" src="' + esc(av) + '" alt="" referrerpolicy="no-referrer" loading="lazy" decoding="async" onerror="this.remove()">' : '')
+ '</span>'
+ '<div class="chinfo"><b>' + nm + '</b><em>' + esc(c[1]) + '</em></div></div>';
}).join('') + '</div>';
var tbox = document.querySelector('#tags');
if (tbox && tbox.parentNode) tbox.parentNode.insertBefore(cb, tbox.nextSibling);
}
if (Array.isArray(rec.st) && rec.st.length) {
var sb = document.createElement('div');
sb.className = 'relbox';
sb.innerHTML = '<div class="relhead">制作人员</div><div class="staffrow">'
+ rec.st.map(function (p2) {
return '<span class="tagpill">' + esc(p2[0])
+ (p2[1] ? '<em class="strole">' + esc(p2[1]) + '</em>' : '') + '</span>';
}).join('') + '</div>';
var cbn = document.querySelector('.chgrid');
var anchorEl = cbn ? cbn.parentNode : document.querySelector('#tags');
if (anchorEl && anchorEl.parentNode) anchorEl.parentNode.insertBefore(sb, anchorEl.nextSibling);
}
if (Array.isArray(rec.co) && rec.co.some(Boolean)) {
var mb = document.querySelector('.mbadges');
if (mb) mb.insertAdjacentHTML('beforeend',
'<span class="mbadge">想看 ' + rec.co[0] + ' · 在看 ' + rec.co[1] + ' · 看过 ' + rec.co[2] + '</span>');
}
if (rec.votes) meta.push(rec.votes + ' 人评分');
if (rec.rank) {
var total = ANI.rows.length || 1;
var pct = Math.max(0.1, (rec.rank / total) * 100);
meta.push('排名 #' + rec.rank + (pct < 20 ? '（前 ' + pct.toFixed(1) + '%）' : ''));
}
var mv = $('#mvotes'); if (mv) mv.textContent = meta.join(' · ');
});
}
function close() { $('#mask').classList.remove('on'); }
var HOME = { y: 0, q: 0, wd: 0 };
var QS = [1, 2, 3, 4];
function seasonOf(m) { return m ? Math.ceil(m / 3) : 0; }
function yearRows(y) { return ANI.rows.filter(function (r) { return r[4] === y; }); }
function homeRows() {
return yearRows(HOME.y).filter(function (r) {
if (HOME.q && seasonOf(r[5]) !== HOME.q) return false;
if (HOME.wd && r[6] !== HOME.wd) return false;
return true;
}).sort(function (a, b) { return (b[7] || 0) - (a[7] || 0); });
}
function chip(label, on, attr, val) {
return '<button class="chip' + (on ? ' on' : '') + '" type="button" ' + attr + '="' + val + '">'
+ label + '</button>';
}
function renderLevels() {
var qs = {};
yearRows(HOME.y).forEach(function (r) {
var q = seasonOf(r[5]);
if (q) qs[q] = (qs[q] || 0) + 1;
});
var qlist = Object.keys(qs).map(Number).sort();
var h = '<aside class="levels">';
h += '<div class="lv"><div class="lv-h">季度</div><div class="chips chips--col">'
+ chip('全部', !HOME.q, 'data-q', 0)
+ qlist.map(function (q) {
return chip('第' + q + '季度<span class="lv-n">' + qs[q] + '</span>', q === HOME.q, 'data-q', q);
}).join('')
+ '</div></div>';
h += '<div class="lv"><div class="lv-h">星期</div><div class="chips chips--wd">'
+ chip('全部', !HOME.wd, 'data-wd', 0)
+ WD.map(function (d, i) { return chip(d, HOME.wd === i + 1, 'data-wd', i + 1); }).join('')
+ '</div></div>';
h += '<div class="lv"><div class="lv-h">榜单</div>'
+ '<div class="chips chips--col"><a class="lv-link" href="rank">排行榜 ›</a></div></div>';
return h + '</aside>';
}
function rankBlock(id, title, sub, extra) {
return '<section class="block rank-block" data-rank="' + id + '">'
+ '<div class="bhead"><h2>' + title + '</h2><span>' + (extra || sub) + '</span></div>'
+ '<div class="grid" id="' + id + '"></div></section>';
}
function rankSort(a, b) {
var ra = a[12] || 0, rb = b[12] || 0;
if (ra && rb) return ra - rb;
if (ra) return -1;
if (rb) return 1;
return (b[7] || 0) - (a[7] || 0);
}
function rankPool(id) {
if (id === 'rank-q') {
return yearRows(HOME.y).filter(function (r) {
return (!HOME.q || seasonOf(r[5]) === HOME.q) && (r[12] || r[7]);
}).sort(rankSort).slice(0, 12);
}
if (id === 'rank-movie') {
return ANI.rows.filter(function (r) { return r[3] === 'movie' && (r[12] || r[7]); })
.sort(rankSort).slice(0, 12);
}
return ANI.rows.filter(function (r) { return r[12] || r[7]; }).sort(rankSort).slice(0, 24);
}
function mountRanks() {
var blocks = [].slice.call(document.querySelectorAll('.rank-block'));
if (!blocks.length) return;
var done = {};
function fill(el) {
var id = el.getAttribute('data-rank');
if (done[id]) return;
done[id] = 1;
var box = el.querySelector('.grid');
var rows = rankPool(id);
if (box) box.innerHTML = rows.map(function (r) { return animeCard(r, { showYear: 1 }); }).join('');
}
if (!window.IntersectionObserver) { blocks.forEach(fill); return; }
var io = new IntersectionObserver(function (es) {
es.forEach(function (e) {
if (!e.isIntersecting) return;
fill(e.target);
io.unobserve(e.target);
});
}, { rootMargin: '300px' });
blocks.forEach(function (b) { io.observe(b); });
}
function renderHome() {
if (!HOME.y) homeDefaults();
var rows = homeRows();
var main = $('#main');
var head = '<div class="bhead"><h2>'
+ (HOME.q ? '第' + HOME.q + '季度' : '全部季度')
+ (HOME.wd ? ' · ' + WD[HOME.wd - 1] : '')
+ '</h2><span>' + rows.length + ' 部</span></div>';
var body = '';
if (rows.length && !HOME.wd) {
for (var w = 1; w <= 7; w++) {
var g = rows.filter(function (r) { return r[6] === w; });
if (!g.length) continue;
body += '<section class="block"><div class="bhead lv2"><h2>' + WD[w - 1] + '</h2><span>'
+ g.length + ' 部</span></div><div class="grid">'
+ g.map(function (r) { return animeCard(r, { showYear: 0 }); }).join('') + '</div></section>';
}
var unknown = rows.filter(function (r) { return !r[6]; });
if (unknown.length) {
body += '<section class="block"><div class="bhead lv2"><h2>放送日未知</h2><span>'
+ unknown.length + ' 部</span></div><div class="grid">'
+ unknown.map(function (r) { return animeCard(r); }).join('') + '</div></section>';
}
} else if (rows.length) {
body = '<div class="grid">' + rows.map(function (r) {
return animeCard(r, { showYear: 0 });
}).join('') + '</div>';
} else {
body = '<div class="empty">这个筛选没有作品 —— 换季度或点「全部」试试</div>';
}
main.innerHTML = '<div class="home-cols">' + renderLevels()
+ '<div class="home-main"><div class="home-head">' + head + '</div>' + body
+ '</div></div>';
main.querySelectorAll('[data-q]').forEach(function (b) {
b.onclick = function () { HOME.q = Number(b.dataset.q); HOME.wd = 0; renderHome(); };
});
main.querySelectorAll('[data-wd]').forEach(function (b) {
b.onclick = function () { HOME.wd = Number(b.dataset.wd); renderHome(); };
});
}
function homeDefaults() {
var y = ANI.year || new Date().getFullYear();
var inY = yearRows(y);
if (!inY.length) {
var ys = {};
ANI.rows.forEach(function (r) { if (r[4]) ys[r[4]] = 1; });
y = Math.max.apply(null, Object.keys(ys).map(Number));
inY = yearRows(y);
}
var q = 0;
inY.forEach(function (r) { var s = seasonOf(r[5]); if (s > q) q = s; });
HOME = { y: y, q: q, wd: ((new Date().getDay() + 6) % 7) + 1 };
}
function bindSearch(empty) {
$('#q').addEventListener('input', (function () {
var t = 0;
return function () {
clearTimeout(t);
var q = nrm(this.value.trim());
t = setTimeout(function () {
if (!q) { empty(); return; }
var found = ANI.rows.filter(function (r) {
return (r[1] + ' ' + (r[2] || '')).toLowerCase().indexOf(q) !== -1;
}).slice(0, 120);
$('#main').innerHTML = '<section class="block"><div class="bhead"><h2>搜索</h2><span>'
+ found.length + ' 部</span></div><div class="grid">'
+ found.map(function (r) { return animeCard(r, { showYear: 1 }); }).join('') + '</div></section>';
}, 220);
};
})());
}
function renderRank() {
if (!HOME.y) homeDefaults();
var main = $('#main');
var head = '<div class="bhead"><h2>' + HOME.y + ' 年排行榜</h2><span>按 Bangumi 排名</span></div>';
var movieAll = ANI.rows.filter(function (r) { return r[3] === 'movie' && (r[12] || r[7]); });
main.innerHTML = '<div class="home-head">' + head + '</div>'
+ rankBlock('rank-q', (HOME.q ? '第' + HOME.q + '季度' : '全部季度') + '榜',
'按 Bangumi 排名 Top 12')
+ rankBlock('rank-all', '总榜', '全站排名 Top 24')
+ (movieAll.length
? rankBlock('rank-movie', '剧场版 · 精选', '',
'<a class="morelink" href="movie">全部 ' + movieAll.length + ' 部 ›</a>')
: '');
mountRanks();
}
var BROWSE = { view: [], shown: 0, page: 120 };
function renderBrowse(reset) {
var grid = $('#grid');
if (!grid) return;
if (reset) { grid.innerHTML = ''; BROWSE.shown = 0; }
var end = Math.min(BROWSE.shown + BROWSE.page, BROWSE.view.length);
var html = '';
for (var i = BROWSE.shown; i < end; i++) html += animeCard(BROWSE.view[i], { showYear: 1 });
grid.insertAdjacentHTML('beforeend', html);
BROWSE.shown = end;
var left = BROWSE.view.length - BROWSE.shown;
$('#morewrap').hidden = left <= 0;
if (left > 0) $('#morebtn').textContent = '加载更多 · 还剩 ' + left + ' 部';
$('#hint').textContent = '筛出 ' + BROWSE.view.length + ' 部，已显示 ' + BROWSE.shown;
}
function applyBrowse() {
var q = nrm(($('#q').value || '').trim());
var y = ($('#f-year') || {}).value || '';
var t = ($('#f-type') || {}).value || '';
var sort = ($('#f-sort') || {}).value || 'year';
var tg = ($('#f-tag') || {}).value || '';
var tgSet = null;
if (tg && TAGS && TAGS[tg]) {
tgSet = {};
TAGS[tg].forEach(function (id) { tgSet[id] = 1; });
}
BROWSE.view = ANI.rows.filter(function (r) {
if (tgSet && !tgSet[r[0]]) return false;
if (!q && y && String(r[4] || '') !== y) return false;
if (t && r[3] !== t) return false;
if (q && !hit(r[1] + ' ' + (r[2] || ''), q)) return false;
return true;
});
if (sort === 'rating') BROWSE.view.sort(function (a, b) { return (b[7] || 0) - (a[7] || 0); });
else if (sort === 'rank') BROWSE.view.sort(function (a, b) {
var ra = a[12] || 0, rb = b[12] || 0;
if (ra && rb) return ra - rb;
if (ra) return -1;
if (rb) return 1;
return (b[7] || 0) - (a[7] || 0);
});
else if (sort === 'name') BROWSE.view.sort(function (a, b) { return String(a[2] || a[1]).localeCompare(String(b[2] || b[1]), 'zh'); });
else BROWSE.view.sort(function (a, b) { return (b[4] || 0) - (a[4] || 0) || (b[7] || 0) - (a[7] || 0); });
renderBrowse(true);
}
var TAGS = null;
function ensureTags() {
if (TAGS) return Promise.resolve(TAGS);
return jd('tags.json').then(function (d) {
TAGS = d || {};
return TAGS;
}, function () { TAGS = {}; return TAGS; });
}
function mountTagFilter() {
var sel = $('#f-tag');
if (!sel) return;
sel.onchange = function () {
if (!TAGS) {
ensureTags().then(function () { applyBrowse(); });
return;
}
applyBrowse();
};
if (sel.getAttribute('data-ready')) return;
sel.setAttribute('data-ready', '1');
ensureTags().then(function (t) {
var names = Object.keys(t).sort(function (a, b) { return t[b].length - t[a].length; });
sel.innerHTML = '<option value="">全部</option>'
+ names.map(function (n) {
return '<option value="' + n + '">' + n + '（' + t[n].length + '）</option>';
}).join('');
});
}
function initBrowse() {
var years = {};
ANI.rows.forEach(function (r) { if (r[4]) years[r[4]] = (years[r[4]] || 0) + 1; });
var ys = Object.keys(years).map(Number).sort(function (a, b) { return b - a; });
$('#main').innerHTML = '<div class="filters">'
+ '<label class="f-label">年份 <select id="f-year"><option value="">全部</option>'
+ ys.map(function (v) { return '<option value="' + v + '">' + v + '（' + years[v] + '）</option>'; }).join('')
+ '</select></label>'
+ '<label class="f-label">类型 <select id="f-type"><option value="">全部</option>'
+ '<option value="tv">TV</option><option value="movie">剧场版</option>'
+ '<option value="ova">OVA</option><option value="web">网络</option></select></label>'
+ '<label class="f-label">排序 <select id="f-sort">'
+ '<option value="year">年份（新→旧）</option><option value="rating">评分（高→低）</option>'
+ '<option value="rank">排名（前→后）</option>'
+ '<option value="name">标题</option></select></label>'
+ '<label class="f-label">标签 <select id="f-tag"><option value="">全部</option></select></label>'
+ '<span class="f-hint" id="hint"></span></div>'
+ '<div class="grid" id="grid"></div>'
+ '<div class="morewrap" id="morewrap" hidden><button class="morebtn" id="morebtn" type="button"></button></div>';
$('#f-year').value = ys[0] ? String(ys[0]) : '';
$('#morebtn').onclick = function () { renderBrowse(false); };
['#f-year', '#f-type', '#f-sort'].forEach(function (s) { $(s).addEventListener('change', applyBrowse); });
mountTagFilter();
applyBrowse();
}
var MOVIE = { all: [], view: [], shown: 0, page: 120, db: [], tm: [] };
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
function openExtModal(kind, i) {
var list = kind === 'tm' ? MOVIE.tm : MOVIE.db;
var x = list && list[i];
if (!x) return;
var m = $('#modal');
if (!m) return;
var isTm = kind === 'tm';
var title = x.n || x.title || '';
var orig = isTm ? (x.ot || '') : (x.sub || '');
var rate = (x.r != null && x.r !== '') ? x.r : x.rating;
var year = x.y || x.year || '';
var src = isTm ? 'TMDB' : '豆瓣';
var intro = isTm ? x.ov : x.intro;
var sub2 = x.sub || '';
m.innerHTML = '<span class="x" aria-label="关闭">×</span>'
+ '<div class="mhd">'
+   '<div class="mposter">'
+     (x.img ? '<img src="' + esc(x.img) + '" loading="lazy" decoding="async" alt="">'
: '<div class="ph">🎬</div>')
+   '</div>'
+   '<div class="mb">'
+     '<h3>' + esc(title) + '</h3>'
+     (orig ? '<div class="orig">' + esc(orig) + '</div>' : '')
+     '<div class="mrate">'
+       (rate ? '<b class="num">★ ' + Number(rate).toFixed(1) + '</b>' : '<b class="num dim">暂无评分</b>')
+       '<span class="mvotes">' + esc([year, src].filter(Boolean).join(' · ')) + '</span>'
+     '</div>'
+     '<dl class="infobox">'
+       (year ? '<dt>年份</dt><dd>' + esc(year) + '</dd>' : '')
+       (sub2 ? '<dt>地区 / 类型</dt><dd>' + esc(sub2) + '</dd>' : '')
+       '<dt>来源</dt><dd>' + esc(src) + '</dd>'
+     '</dl>'
+   '</div>'
+ '</div>'
+ '<div class="mbody"><h4>简介</h4><p class="plot">'
+   (intro ? esc(intro) : '暂无简介') + '</p></div>'
+ '<div class="acts">'
+   '<a class="btn pri" href="' + esc(x.u || x.url || '#') + '" target="_blank" rel="noopener">'
+     esc(src) + ' 页面</a>'
+   '<a class="btn" target="_blank" rel="noopener" href="https://search.bilibili.com/all?keyword='
+     encodeURIComponent(title) + '">B 站搜索</a>'
+ '</div>';
$('#mask').classList.add('on');
m.querySelector('.x').onclick = close;
}
function paintMovieDb() {
var box = $('#mdb');
if (!box) return;
box.innerHTML = msec('豆瓣新片', MOVIE.db, 'db') + msec('TMDB 热门', MOVIE.tm, 'tm');
}
function renderMovie(reset) {
var grid = $('#mgrid');
if (!grid) return;
if (reset) { grid.innerHTML = ''; MOVIE.shown = 0; }
var end = Math.min(MOVIE.shown + MOVIE.page, MOVIE.view.length);
var html = '';
for (var i = MOVIE.shown; i < end; i++) html += animeCard(MOVIE.view[i], { showYear: 1 });
grid.insertAdjacentHTML('beforeend', html);
MOVIE.shown = end;
var left = MOVIE.view.length - MOVIE.shown;
var wrap = $('#mmorewrap');
if (wrap) wrap.hidden = left <= 0;
var btn = $('#mmore');
if (btn) {
btn.hidden = left <= 0;
if (left > 0) btn.textContent = '加载更多 · 还剩 ' + left + ' 部';
}
var hint = $('#mhint');
if (hint) hint.textContent = '筛出 ' + MOVIE.view.length + ' 部，已显示 ' + MOVIE.shown;
}
function applyMovie() {
var q = nrm((($('#q') || {}).value || '').trim());
var y = ($('#m-year') || {}).value || '';
var sort = ($('#m-sort') || {}).value || 'year';
MOVIE.view = MOVIE.all.filter(function (r) {
if (!q && y && String(r[4] || '') !== y) return false;
if (q && !hit(r[1] + ' ' + (r[2] || ''), q)) return false;
return true;
});
if (sort === 'rating') MOVIE.view.sort(function (a, b) { return (b[7] || 0) - (a[7] || 0); });
else if (sort === 'name') MOVIE.view.sort(function (a, b) { return String(a[2] || a[1]).localeCompare(String(b[2] || b[1]), 'zh'); });
else MOVIE.view.sort(function (a, b) { return (b[4] || 0) - (a[4] || 0) || (b[7] || 0) - (a[7] || 0); });
renderMovie(true);
}
function initMovie() {
MOVIE.all = ANI.rows.filter(function (r) { return r[3] === 'movie'; });
var years = {};
MOVIE.all.forEach(function (r) { if (r[4]) years[r[4]] = (years[r[4]] || 0) + 1; });
var ys = Object.keys(years).map(Number).sort(function (a, b) { return b - a; });
$('#main').innerHTML = '<div id="mdb"></div>'
+ '<section class="block"><div class="bhead"><h2>剧场版 / 电影全收录</h2>'
+ '<span class="f-hint" id="mhint"></span></div>'
+ '<div class="filters">'
+ '<label class="f-label">年份 <select id="m-year"><option value="">全部</option>'
+ ys.map(function (v) { return '<option value="' + v + '">' + v + '（' + years[v] + '）</option>'; }).join('')
+ '</select></label>'
+ '<label class="f-label">排序 <select id="m-sort">'
+ '<option value="year">年份（新→旧）</option><option value="rating">评分（高→低）</option>'
+ '<option value="name">标题</option></select></label></div>'
+ '<div class="grid" id="mgrid"></div>'
+ '<div class="morewrap" id="mmorewrap" hidden><button class="morebtn" id="mmore" type="button"></button></div>'
+ '</section>';
var more = $('#mmore');
if (more) more.onclick = function () { renderMovie(false); };
['#m-year', '#m-sort'].forEach(function (s) { if ($(s)) $(s).addEventListener('change', applyMovie); });
var q = $('#q');
if (q) {
q.placeholder = '在 ' + MOVIE.all.length + ' 部剧场版里搜…';
var qt = 0;
q.addEventListener('input', function () {
clearTimeout(qt);
qt = setTimeout(applyMovie, 220);
});
}
applyMovie();
jd('movies.json').then(function (d) {
MOVIE.db = (d && d.douban) || [];
MOVIE.tm = (d && d.tmdb) || [];
paintMovieDb();
}).catch(function () {
var box = $('#mdb');
if (box) box.innerHTML = '<div class="empty">电影数据加载失败（豆瓣 / TMDB 简介暂不可用），请刷新重试</div>';
});
}
function refreshMovie() {
if (!$('#mgrid')) return;
paintMovieDb();
applyMovie();
}
function openMagView(id, name, epsN) {
var m = $('#modal');
var api = window.__epsApi;
if (!m || !api) return;
m.innerHTML = '<span class="x" aria-label="关闭">×</span>'
+ '<div class="bhead lv2"><h2>' + esc(name) + ' · 磁力</h2><span>'
+   '<button class="mgback" id="mgback" type="button">‹ 返回详情</button>'
+ '</span></div>'
+ '<div id="mgbody"><div class="loading">磁力索引加载中…</div></div>';
$('#mask').classList.add('on');
m.querySelector('.x').onclick = close;
var back = m.querySelector('#mgback');
if (back) back.onclick = function () { openModal(id); };   // 回详情：重跑 openModal 重建绑定
var body = m.querySelector('#mgbody');
function alive() { return body && body.isConnected; }
var fail = function () {
if (!alive()) return;
body.innerHTML = '<div class="eps-none">这部暂无磁力索引</div>';
};
api.loadShard(api.shardOf(name)).then(function (store) {
if (!store) return null;
return store[String(id)] || (api.findByName ? api.findByName(store, name) : null);
}, function () { return null; }).then(function (entry) {
if (entry) return entry;
return api.live(name, epsN || 0, '');
}).then(function (entry) {
if (!alive()) return;
if (!entry) return fail();
var eps = entry.eps || {}, batch = entry.batch || [];
var nums = Object.keys(eps).map(Number).sort(function (a, b) { return a - b; });
var h = '';
if (nums.length) {
h += '<div class="relhead">分集磁力 · ' + nums.length + ' 集（点击复制）</div>'
+ '<div class="epsgrid">' + api.epsListHtml(eps) + '</div>';
}
if (batch.length) {
h += '<div class="relhead">整季 / 合集 · ' + batch.length + ' 个（点击复制）</div>'
+ '<div class="epsgrid">' + batch.map(function (c, i) {
var lb = api.batchLabel(c, i);
var bd = api.descOf ? api.descOf(c, 46) : '';
return api.chipOf(c, lb + (bd ? ' · ' + bd : ''));
}).join('') + '</div>';
}
body.innerHTML = h || '<div class="eps-none">暂无按集索引</div>';
}).catch(fail);
}
var MAGIDX = null;      // [{id,n,e,b,s}]；null = 还没拿到（initMagnet 里填）
var MGBUILT = '';       // 索引构建时间，仅用于左栏展示
var MG = { q: '', cur: null, entry: null, seq: 0, liveQ: '' };
var MG_MAX = 200;       // 列表最多渲染条数：一部一条，200 条足够滚，再多靠搜索
function magnetItems() {
if (MAGIDX) return MAGIDX;
var api = window.__epsApi;
MAGIDX = ANI.rows.filter(function (r) { return r[10]; }).map(function (r) {
var n = r[2] || r[1] || '';
return {
id: Number(r[0]) || 0, n: n, e: Number(r[8]) || 0, b: 0,
s: api && api.shardOf ? api.shardOf(n) : 0
};
});
return MAGIDX;
}
function initMagnet() {
if (!window.__epsApi) {
$('#main').innerHTML = '<div class="empty">磁力模块未加载，请刷新页面</div>';
return;
}
$('#main').innerHTML = '<div class="loading">磁力索引加载中…</div>';
jd('magnet-index.json').then(function (d) {
if (d && d.items && d.items.length) {
MAGIDX = d.items.map(function (x) {
return {
id: Number(x.id) || 0, n: x.n || '', e: Number(x.e) || 0,
b: Number(x.b) || 0, s: Number(x.s) || 0
};
});
MGBUILT = d.built || '';
}
}).catch(function () { /* 文件未产出：下面 magnetItems() 用 ANI.rows 兜底 */ })
.then(function () {
paintMagnet();
bindMagnetSearch();
var q = $('#q');
if (q) q.placeholder = '搜索磁力…';
});
}
function paintMagnet() {
var main = $('#main');
if (!main) return;
var total = magnetItems().length;
main.innerHTML = '<div class="home-cols">'
+ '<aside class="levels"><div class="lv"><div class="lv-h">磁力</div>'
+ '<div class="chips chips--col"><span class="mnote" id="mgtotal">共 ' + total + ' 部有磁力</span></div>'
+ (MGBUILT ? '<div class="mnote">索引 ' + esc(MGBUILT) + '</div>' : '')
+ '</div></aside>'
+ '<div class="home-main">'
+ '<div class="home-head"><div class="bhead"><h2>磁力索引</h2><span>点条目看分集/合集</span></div></div>'
+ '<div class="mglist" id="mglist"></div>'
+ '<div class="mgdetail" id="mgdetail" hidden></div>'
+ '</div></div>';
var box = $('#mglist');
if (box) box.addEventListener('click', onMagnetClick);
var det = $('#mgdetail');
if (det) {
det.addEventListener('click', onMagnetDetailClick);
det.addEventListener('keydown', function (e) {
if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') onMagnetDetailClick(e);
});
}
paintMagnetList();
if (MG.cur) {
var ml = $('#mglist'), md = $('#mgdetail');
if (ml) ml.hidden = true;
if (md) { md.hidden = false; md.innerHTML = '<div class="loading">磁力详情加载中…</div>'; }
}
}
function paintMagnetList() {
var box = $('#mglist');
if (!box) return;
var items = magnetItems();
var q = nrm(MG.q);
var view = q ? items.filter(function (x) { return hit(x.n, q); }) : items.slice();
view.sort(function (a, b) { return (b.e + b.b) - (a.e + a.b); });
var h = '';
if (MG.q) h += '<div class="mnote">搜索「' + esc(String(MG.q).trim()) + '」 ' + view.length + ' 部</div>';
if (!view.length) h += '<div class="empty">没有匹配的磁力条目</div>';
h += view.slice(0, MG_MAX).map(function (x) {
return '<button class="mgrow" type="button" data-id="' + esc(x.id) + '" data-n="' + esc(x.n)
+ '" data-e="' + esc(x.e) + '" data-s="' + esc(x.s) + '">' + esc(x.n)
+ '<span class="mgmeta">' + esc(x.e) + ' 集 · ' + esc(x.b) + ' 合集</span></button>';
}).join('');
if (view.length > MG_MAX) h += '<div class="mnote">仅显示前 ' + MG_MAX + ' 条，用搜索缩小</div>';
box.innerHTML = h;
}
function onMagnetClick(e) {
var b = e.target.closest && e.target.closest('.mgrow');
if (!b) return;
openMagnet({
id: Number(b.getAttribute('data-id')) || 0,
n: b.getAttribute('data-n') || '',
e: Number(b.getAttribute('data-e')) || 0,
s: Number(b.getAttribute('data-s')) || 0
});
}
function openMagnet(it) {
var d = $('#mgdetail');
var api = window.__epsApi;
if (!d || !api) return;
var seq = ++MG.seq;
MG.cur = it; MG.entry = null;
d.hidden = false;
d.innerHTML = '<div class="loading">磁力详情加载中…</div>';
var list = $('#mglist');
if (list) list.hidden = true;
api.loadShard(Number(it.s) || 0).then(function (store) {
if (!store) return null;
return store[it.id] || (api.findByName ? api.findByName(store, it.n) : null);
}).catch(function () { return null; }).then(function (entry) {
if (entry) return entry;
return api.live(it.n, Number(it.e) || 0, '').catch(function () { return null; });
}).then(function (entry) {
if (seq !== MG.seq) return;          // 期间点了别的条目，丢弃这次结果
MG.entry = entry;
showMagnetDetail(it, entry, false);
});
}
function showMagnetDetail(it, entry, keepList) {
var d = $('#mgdetail');
var api = window.__epsApi;
if (!d || !api) return;
var h = '<div class="bhead"><h2>' + esc(it.n) + '</h2><span>'
+ '<button class="mgback" id="mgback" type="button">‹ 返回列表</button></span></div>';
if (entry) {
var eps = entry.eps || {}, batch = entry.batch || [];
var nums = Object.keys(eps).map(Number).sort(function (a, b) { return a - b; });
if (nums.length) {
h += '<div class="bhead lv2"><h2>分集磁力 · ' + nums.length + ' 集</h2></div>'
+ '<div class="epsgrid">' + nums.map(function (n) {
var arr = eps[n] || [];
return arr.length ? api.chipOf(arr[0], '第 ' + n + ' 集') : '';
}).join('') + '</div>';
} else {
h += '<div class="empty">这部暂无按集索引</div>';
}
if (batch.length) {
h += '<div class="bhead lv2"><h2>整季 / 合集 · ' + batch.length + ' 个</h2></div>'
+ '<div class="epsgrid">' + batch.map(function (c, i) {
return api.chipOf(c, '合集 ' + (i + 1));
}).join('') + '</div>';
}
} else {
h += '<div class="empty">这部暂无分集磁力索引</div>';
}
d.innerHTML = h;
d.hidden = false;
var list = $('#mglist');
if (list) list.hidden = !keepList;
}
function onMagnetDetailClick(e) {
var back = e.target.closest && e.target.closest('#mgback');
if (back) { closeMagnetDetail(); return; }
var c = e.target.closest && e.target.closest('.eps-chip');
if (!c || !window.__epsApi) return;
e.preventDefault();
var m = c.getAttribute('data-m') || '';
if (!m) return;
window.__epsApi.copyText(m).then(function (ok) {
window.__epsApi.toast(ok ? '已复制磁力链接' : '复制失败，请长按手动复制');
});
}
function closeMagnetDetail() {
MG.cur = null; MG.entry = null; MG.seq++;
var d = $('#mgdetail');
if (d) { d.hidden = true; d.innerHTML = ''; }
var list = $('#mglist');
if (list) list.hidden = false;
}
function bindMagnetSearch() {
var q = $('#q');
if (!q || q.dataset.mg) return;
q.dataset.mg = '1';
var t = 0;
q.addEventListener('input', function () {
clearTimeout(t);
var v = q.value;
t = setTimeout(function () {
MG.q = v;
MG.liveQ = '';
if (MG.cur) closeMagnetDetail();     // 搜索即回到列表，别让详情挡着
paintMagnetList();
if (nrm(MG.q)) magnetLive(MG.q);
}, 220);
});
}
function magnetLive(q) {
var api = window.__epsApi;
if (!api || !api.live) return;
var qq = nrm(q);
var any = magnetItems().some(function (x) { return hit(x.n, qq); });
if (any || MG.liveQ === qq) return;
MG.liveQ = qq;
var box = $('#mglist');
if (box) {
box.insertAdjacentHTML('afterbegin',
'<div class="mnote" data-live="1">实时查询「' + esc(String(q).trim()) + '」…</div>');
}
api.live(q, 0, '').then(function (entry) {
if (MG.liveQ !== qq) return;
var hint = box && box.querySelector('[data-live]');
if (!entry) {
if (hint) hint.textContent = '「' + String(q).trim() + '」本地与实时查询都没有磁力';
return;
}
if (hint) hint.textContent = '来自实时查询';
MG.cur = { id: 0, n: String(q).trim(), e: 0, s: 0 };
MG.entry = entry;
showMagnetDetail(MG.cur, entry, true);   // 保留列表：顶部那条提示还要看得见
}).catch(function () {
var hint = box && box.querySelector('[data-live]');
if (hint) hint.textContent = '实时查询失败，请稍后再试';
});
}
function refreshMagnet() {
if (!MAGIDX) return;                 // 首屏还没就绪，initMagnet 完成后自己会画
paintMagnet();
if (!MG.cur) return;
if (MG.entry) showMagnetDetail(MG.cur, MG.entry, false);
else openMagnet(MG.cur);
}
function repaint() {
if (PAGE === 'anime') applyBrowse();
else if (PAGE === 'movie') refreshMovie();
else if (PAGE === 'rank') renderRank();
else renderHome();
}
function syncPsz(btn) {
var hd = PSZ.mode === 'hd';
btn.textContent = hd ? '高清' : '标准';
btn.setAttribute('aria-pressed', hd ? 'false' : 'true');
}
function initPsz() {
var btn = document.getElementById('psz');
if (!btn) return;
syncPsz(btn);
btn.onclick = function () {
PSZ.mode = PSZ.mode === 'hd' ? 'sd' : 'hd';
try { localStorage.setItem('psz', PSZ.mode); } catch (e) { /* 忽略 */ }
syncPsz(btn);
if ($('#mask')) close();
repaint();
};
}
function bootHeader() {
var P = PAGE;
var ph = P === 'movie' ? '搜索电影…' : '搜索番剧…';
var nav = [['./', 'home', '首页'], ['anime', 'anime', '番剧'], ['movie', 'movie', '电影'],
['rank', 'rank', '排行榜']]
.map(function (x) {
return '<a href="' + x[0] + '"' + (P === x[1] ? ' class="is-on"' : '') + '>' + x[2] + '</a>';
}).join('');
var host = document.getElementById('topbar');
if (!host) return;
host.innerHTML = '<div class="wrap"><a class="brand" href="./"><i></i>番组<b>计划</b></a>'
+ '<nav class="mainnav">' + nav + '</nav><div class="head-spacer"></div>'
+ '<div class="searchbox"><input id="q" type="search" placeholder="' + ph + '" autocomplete="off"></div>'
+ '<button class="psz" id="psz" type="button" aria-pressed="false">高清</button>'
+ '<span class="cnt" id="cnt"></span>'
+ '<span class="build" id="build">' + (document.body.dataset.build || '') + '</span></div>';
}
var BILI = {};          // id -> {bvid, aid, pages:[{page,cid,part}]}
var BILI_BASE = 'https://120.48.56.189/bili/';
function biliGet(path, params) {
var q = Object.keys(params || {}).map(function (k) {
return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
}).join('&');
var ctl = typeof AbortController === 'function' ? new AbortController() : null;
var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 15000);
return fetch(BILI_BASE + path + (q ? '?' + q : ''), ctl ? { signal: ctl.signal } : undefined)
.then(function (r) { clearTimeout(timer); return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); });
}
var BILI_NOISE = /(主题歌|主題歌|\bOP\d?\b|\bED\d?\b|\bOST\b|原声|原聲|サントラ|Soundtrack|\bMV\b|\bMAD\b|\bAMV\b|混剪|鼓谱|钢琴|ピアノ|反应|reaction|合集|全集|一口气看完)/i;
function biliScore(v, title) {
if (!v || !v.pages) return 0;
var t = v.title || '';
var n = v.pages.length;
var avg = 0;
for (var i = 0; i < n; i++) avg += (v.pages[i].duration || 0);
avg = n ? avg / n : 0;
var score = 0;
if (BILI_NOISE.test(t)) score -= 2;            // 名字像二创/音乐
if (n >= 3 && avg >= 600) score += 2;          // 多P 且每集 10 分钟以上：最像正片
if (n === 1 && avg >= 1200) score += 1;        // 单P 长视频：可能是合集
if (n === 1 && avg < 300) score -= 2;          // 短片基本是 PV/OP
return score;
}
function biliResolve(id, title, year) {
if (BILI[id] !== undefined) return Promise.resolve(BILI[id]);
var direct = (typeof DATA !== 'undefined' && DATA.bili && DATA.bili[id]) || '';
var p = direct
? biliGet('view', { bvid: direct })
: biliGet('find', { t: title }).then(function (f) {
if (!f || !f.found || !f.bvid) return { ok: false };
return biliGet('view', { bvid: f.bvid });
});
return p.then(function (v) {
BILI[id] = (v && v.ok) ? v : null;
return BILI[id];
}).catch(function () { BILI[id] = null; return null; });
}
function renderDm(box, d, pages, curPage) {
if (!d || !d.ok) { box.innerHTML = '<div class="mnote">弹幕取不到（' + ((d && d.error) || '网络') + '）</div>'; return; }
if (!d.items.length) { box.innerHTML = '<div class="mnote">这一集还没有弹幕</div>'; return; }
var DM_SYM = /^[\\/\-_.·…~=*\s]+$/;
var dmItems = d.items.filter(function (it) {
var m = String(it.m == null ? '' : it.m).trim();
return m.length >= 2 && !DM_SYM.test(m);
});
if (!dmItems.length) { box.innerHTML = '<div class="mnote">这一集还没有弹幕</div>'; return; }
var sel = '';
if (pages.length > 1) {
sel = '<div class="pgsel">' + pages.slice(0, 24).map(function (p) {
return '<button class="chip' + (p.page === curPage ? ' on' : '') + '" type="button" data-pg="'
+ p.page + '" data-cid="' + p.cid + '">第 ' + p.page + ' 集</button>';
}).join('') + '</div>';
}
var rows = dmItems.slice(0, 300).map(function (it) {
var mm = Math.floor(it.t / 60), ss = ('0' + Math.floor(it.t % 60)).slice(-2);
return '<div class="dmrow"><em>' + mm + ':' + ss + '</em><span>' + esc(it.m) + '</span></div>';
}).join('');
box.innerHTML = '<div class="mnote">共 ' + d.count + ' 条 · 来源 B 站（显示前 ' + Math.min(300, d.count) + ' 条）</div>'
+ sel + '<div class="dmlist">' + rows + '</div>';
}
function renderRp(box, d) {
if (!d || !d.ok) { box.innerHTML = '<div class="mnote">评论取不到（' + ((d && d.error) || '网络') + '）</div>'; return; }
if (!d.items.length) { box.innerHTML = '<div class="mnote">还没有评论</div>'; return; }
box.innerHTML = '<div class="mnote">共 ' + d.total + ' 条 · 来源 B 站</div>'
+ d.items.map(function (it) {
var dt = it.t ? new Date(it.t * 1000) : null;
var day = dt ? (dt.getFullYear() + '-' + ('0' + (dt.getMonth() + 1)).slice(-2) + '-' + ('0' + dt.getDate()).slice(-2)) : '';
return '<div class="rprow' + (it.re === 1 ? ' re' : '') + '">'
+ (it.a ? '<img src="' + esc(it.a) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">' : '')
+ '<div><b>' + esc(it.u || '匿名') + '</b><em>' + day + (it.l ? ' · 赞 ' + it.l : '') + '</em>'
+ '<p>' + esc(it.m) + '</p></div></div>';
}).join('');
}
function bindBili(id, title, year) {
var m = $('#modal');
if (!m) return;
m.querySelectorAll('.mtab').forEach(function (b) {
b.onclick = function () {
var p = b.getAttribute('data-p');
m.querySelectorAll('.mtab').forEach(function (x) { x.classList.toggle('on', x === b); });
m.querySelectorAll('.mbody').forEach(function (x) {
x.hidden = x.getAttribute('data-p') !== p;
});
if (p === 'dm' && !m.querySelector('#pdm').dataset.done) {
m.querySelector('#pdm').dataset.done = '1';
m.querySelector('#pdm').innerHTML = '<div class="mnote">弹幕加载中…</div>';
biliResolve(id, title, year).then(function (v) {
var box = m.querySelector('#pdm');
if (!v || !v.pages || !v.pages.length) { box.innerHTML = '<div class="mnote">未匹配到 B 站源</div>'; return; }
var pg = v.pages[0];
return biliGet('dm', { cid: pg.cid }).then(function (d) {
renderDm(box, d, v.pages, pg.page);
box.querySelectorAll('[data-pg]').forEach(function (c) {
c.onclick = function () {
box.querySelectorAll('[data-pg]').forEach(function (x) { x.classList.toggle('on', x === c); });
box.innerHTML = '<div class="mnote">弹幕加载中…</div>';
biliGet('dm', { cid: c.getAttribute('data-cid') }).then(function (dd) {
renderDm(box, dd, v.pages, Number(c.getAttribute('data-pg')));
});
};
});
});
}).catch(function () { m.querySelector('#pdm').innerHTML = '<div class="mnote">未匹配到 B 站源</div>'; });
}
if (p === 'rp' && !m.querySelector('#prp').dataset.done) {
m.querySelector('#prp').dataset.done = '1';
m.querySelector('#prp').innerHTML = '<div class="mnote">评论加载中…</div>';
biliResolve(id, title, year).then(function (v) {
if (!v || !v.aid) { m.querySelector('#prp').innerHTML = '<div class="mnote">未匹配到 B 站源</div>'; return; }
return biliGet('reply', { aid: v.aid, ps: 20 }).then(function (d) { renderRp(m.querySelector('#prp'), d); });
}).catch(function () { m.querySelector('#prp').innerHTML = '<div class="mnote">未匹配到 B 站源</div>'; });
}
};
});
var bp = m.querySelector('#bplay');
if (bp) {
bp.onclick = function () {
bp.textContent = '匹配中…';
biliResolve(id, title, year).then(function (v) {
if (!v || !v.pages || !v.pages.length) { bp.textContent = '▶ B 站弹幕播放'; bp.setAttribute('data-miss', '1'); return; }
bp.textContent = '▶ B 站弹幕播放';
var page = 1;
var on = m.querySelector('#pdm [data-pg].on');
if (on) page = Number(on.getAttribute('data-pg')) || 1;
var old = m.querySelector('.trailer');
if (old) old.remove();
var oldBar = m.querySelector('.bplay-bar');
if (oldBar) oldBar.remove();
var score = biliScore(v, title);
var bvid = v.bvid;
var mkSrc = function (pg) {
return 'https://player.bilibili.com/player.html?bvid=' + encodeURIComponent(bvid)
+ '&page=' + pg + '&autoplay=1&danmaku=1&high_quality=1';
};
var barHtml = '';
if (score < 0) barHtml += '<div class="mnote">未找到正片源，这是 B 站上最接近的视频（可能是 OP/剪辑/相关视频）</div>';
if (score < 2) barHtml += '<div class="mnote">B 站官方番剧多为会员专享，这里的「集」是 UP 主上传的分P，不一定对应正片集数</div>';
if (v.pages.length >= 2) {
barHtml += '<select id="bsel">' + v.pages.map(function (p, i) {
return '<option value="' + (p.page || i + 1) + '">' + esc(p.part || ('第 ' + (i + 1) + ' 集')) + '</option>';
}).join('') + '</select>';
}
if (barHtml) {
var bar = document.createElement('div');
bar.className = 'bplay-bar';
bar.innerHTML = barHtml;
m.appendChild(bar);
}
var d = document.createElement('div');
d.className = 'trailer';
d.innerHTML = '<iframe src="' + mkSrc(page) + '" '
+ 'allow="autoplay; fullscreen" allowfullscreen referrerpolicy="no-referrer"></iframe>';
m.appendChild(d);
var selEl = m.querySelector('#bsel');
if (selEl) {
selEl.value = String(page);
selEl.onchange = function () {
var fr = d.querySelector('iframe');
if (fr) fr.src = mkSrc(Number(selEl.value) || 1);
};
}
});
};
}
}
function bootAnime() {
return jd('anime.json').then(function (d) {
ANI.poster = d.poster || ''; ANI.posterSd = d.posterSd || '';
ANI.rows = d.rows || [];
ANI.extra = d.extra || {}; ANI.year = d.year || new Date().getFullYear();
});
}
document.addEventListener('click', function (e) {
var mc = e.target.closest && e.target.closest('.mcard');
if (mc) {
if (e.metaKey || e.ctrlKey || e.button !== 0) return;
e.preventDefault();
openExtModal(mc.dataset.ext, Number(mc.dataset.i));
return;
}
var c = e.target.closest && e.target.closest('.card');
if (!c) return;
openModal(Number(c.dataset.id));
});
$('#mask') && $('#mask').addEventListener('click', function (e) { if (e.target.id === 'mask') close(); });
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
bootHeader();
bootAnime().then(function () {
if (PAGE === 'anime') {
$('#q').placeholder = '在 ' + ANI.rows.length + ' 部里搜…';
initBrowse();
var qt = 0;
$('#q').addEventListener('input', function () {
clearTimeout(qt);
qt = setTimeout(applyBrowse, 220);
});
} else if (PAGE === 'movie') {
initMovie();
} else if (PAGE === 'rank') {
renderRank();
bindSearch(renderRank);
} else {
renderHome();
bindSearch(renderHome);
}
initPsz();
}).catch(function (e) {
$('#main').innerHTML = '<div class="loading">数据加载失败：' + esc(e.message || e) + '</div>';
});
})();