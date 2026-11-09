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
function chip(label, on, attr, val) {
return '<button class="chip' + (on ? ' on' : '') + '" type="button" ' + attr + '="' + val + '">'
+ label + '</button>';
}
function splitPlot(overview, overviewJa) {
var mark = '[简介原文]';
var s = String(overview == null ? '' : overview).replace(/\r\n/g, '\n');
var i = s.indexOf(mark);
var zh = s, ja = String(overviewJa == null ? '' : overviewJa);
if (i >= 0) {
zh = s.slice(0, i);
if (!ja.trim()) ja = s.slice(i + mark.length);
}
zh = zh.replace(/\n{3,}/g, '\n\n').trim();
ja = ja.replace(/\n{3,}/g, '\n\n').trim();
if (ja && !/[。．.!?！？…」』）】〕”"]$/.test(ja)) ja = '';
return { zh: zh || '暂无简介', ja: ja };
}
function plotJaHtml(ja) {
return '<details class="plot-ja"><summary>原文</summary><p>' + esc(ja) + '</p></details>';
}
var D_BASES = [
'https://modelscope.cn/datasets/jingjiangze/Anime-JPG/resolve/master/assets/data/',
'/data/',
'https://gh-proxy.com/https://raw.githubusercontent.com/jingjiangze/jellyfin-mpv-shim-mpv-lazy/main/media/data/'
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
var ANI = { poster: '', posterSd: '', rows: [], extra: {}, year: 0 };
var shardCache = {};
var DCACHE = 'anime-data-v1';
var DCACHE_FRESH = 30 * 60 * 1000;      // 30 分钟内视为新鲜，不回源
function dcache() {
return (typeof caches !== 'undefined' && caches.open) ? caches.open(DCACHE) : null;
}
function dcacheGet(name, cb) {
var c = dcache();
if (!c) { cb(null); return; }
c.then(function (store) {
return store.match('swr/' + name).then(function (hit) {
if (!hit) { cb(null); return; }
var ts = Number(hit.headers.get('x-ts')) || 0;
return hit.json().then(function (d) {
cb(d, ts && (Date.now() - ts) < DCACHE_FRESH);
}, function () { cb(null); });
});
}, function () { cb(null); }).catch(function () { cb(null); });
}
function dcachePut(name, data) {
var c = dcache();
if (!c || data == null) return;
c.then(function (store) {
var h = { headers: { 'content-type': 'application/json', 'x-ts': String(Date.now()) } };
store.put('swr/' + name, new Response(JSON.stringify(data), h));
}).catch(function () { });
}
function jdSwr(name) {
return new Promise(function (resolve) {
var done = false;
function settle(v) { if (!done) { done = true; resolve(v); } }
dcacheGet(name, function (cached, fresh) {
if (cached) settle(cached);
if (cached && fresh) return;
jd(name).then(function (d) {
if (d) dcachePut(name, d);
settle(d);
}, function () { if (!cached) settle(null); });
});
});
}
var TAGCNT = {}, TAGCNT_LOADING = false, TAGCNT_WAIT = [];
function ensureTagCounts(done) {
if (done) TAGCNT_WAIT.push(done);
if (TAGCNT_LOADING) return;
if (Object.keys(TAGCNT).length) { flushTagCounts(); return; }
TAGCNT_LOADING = true;
jd('tagcounts.json').then(function (d) { TAGCNT = d || {}; }, function () { /* 失败保持空表，允许下次重试 */ })
.then(function () { TAGCNT_LOADING = false; flushTagCounts(); });
}
function flushTagCounts() {
var w = TAGCNT_WAIT; TAGCNT_WAIT = [];
w.forEach(function (f) { try { f(); } catch (e) { /* 单个回调失败不影响其它 */ } });
}
var FOLLOW_API = 'https://120.48.56.189/auth/follow';
function followToken() {
try { return localStorage.getItem('gh_token') || ''; } catch (e) { return ''; }
}
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
function pullFollow() {
var tk = followToken();
if (!tk) return;
fetch(FOLLOW_API, { headers: { authorization: 'Bearer ' + tk } })
.then(function (r) { return r.ok ? r.json() : null; })
.then(function (d) { if (d && d.ok && d.items) mergeRemote(d.items); })
.catch(function () { /* 静默：追番是增值功能，拉不到不影响任何页面渲染 */ });
}
var PROG_API = 'https://120.48.56.189/auth/progress';
var PROG_KEY = 'prog';
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
function pullProgress() {
var tk = followToken();
if (!tk) return;
fetch(PROG_API, { headers: { authorization: 'Bearer ' + tk } })
.then(function (r) { return r.ok ? r.json() : null; })
.then(function (d) { if (d && d.ok && d.items) mergeProgress(d.items); })
.catch(function () { /* 静默：进度是增值功能，拉不到不影响任何页面渲染 */ });
}
pullFollow();
pullProgress();
function quarkBindUrl(extra) {
var tk = '';
try { tk = (typeof authToken === 'function' && authToken()) || ''; } catch (e) { tk = ''; }
return 'https://120.48.56.189/qr/' + (tk ? '?t=' + encodeURIComponent(tk) : '?')
+ (extra || '');
}
window.__prog = {
report: function (id, ep, extra) { return setProgress(id, ep, extra); },
get: function (id) { return progressOf(id); }
};
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
var BUILD = '';
try { BUILD = String(document.body.getAttribute('data-build') || '').replace(/[^0-9A-Za-z]/g, ''); } catch (e) { }
if (!BUILD) BUILD = 'x';
function bust(u) {
if (!u) return u;
return u + (u.indexOf('?') < 0 ? '?' : '&') + 'v=' + BUILD;
}
function posterHd(id) { return bust((ANI.poster || '') + id + '.jpg'); }
function posterSrc(id) { return posterHd(id); }
function posterFb(id, ex) {
var base = ANI.posterSd || ANI.poster || '';
var sd = base ? bust(base + id + '.jpg') : '';
if (sd === posterHd(id)) sd = '';
return fbAttr([sd, (ex || [])[1]]);
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
var src = posterSrc(id);
var h = '<article class="card" data-id="' + id + '"><div class="pw">'
+ '<img src="' + esc(src) + '"' + posterFb(id, ex) + ' loading="lazy" decoding="async" alt="">'
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
var HOME = { y: 0, q: 0, wd: 0 };   // wd: 0=跟随今天，1-7=用户手选星期
var QS = [1, 2, 3, 4];
function seasonOf(m) { return m ? Math.ceil(m / 3) : 0; }
function yearRows(y) { return ANI.rows.filter(function (r) { return r[4] === y; }); }
function byScore(a, b) { return (b[7] || 0) - (a[7] || 0); }
function wdToday() { return ((new Date().getDay() + 6) % 7) + 1; }
function wdPick() { return HOME.wd || wdToday(); }
function todayRows() {
var wd = wdPick();
return yearRows(HOME.y).filter(function (r) { return r[6] === wd; }).sort(byScore);
}
function weekTabsHtml() {
var wd = wdPick();
var cnt = {};
yearRows(HOME.y).forEach(function (r) { if (r[6]) cnt[r[6]] = (cnt[r[6]] || 0) + 1; });
return '<div class="wk-tabs">' + WD.map(function (d, i) {
var n = i + 1;
return '<button class="wk-tab' + (wd === n ? ' on' : '') + '" type="button" data-wd="' + n + '">'
+ d + '<i>' + (cnt[n] || 0) + '</i></button>';
}).join('') + '</div>';
}
function seasonRows() {
return yearRows(HOME.y).filter(function (r) {
return !HOME.q || seasonOf(r[5]) === HOME.q;
}).sort(byScore);
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
if (box) box.innerHTML = rows.map(function (r, i) {
return animeCard(r, { showYear: 1, rank: i + 1 });
}).join('');
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
function topRows(n) {
return ANI.rows.filter(function (r) { return r[7]; })
.sort(function (a, b) { return b[7] - a[7]; })
.slice(0, n || 8);
}
function block(title, list, moreHtml, gridClass, ranked) {
if (!list || !list.length) return '';
return '<section class="block"><div class="sec-h"><h2>' + title + '</h2><span class="sec-sub">'
+ list.length + ' 部 ' + (moreHtml || '') + '</span></div>'
+ '<div class="grid' + (gridClass ? ' ' + gridClass : '') + '">'
+ list.map(function (r, i) {
return animeCard(r, ranked ? { showYear: 0, rank: i + 1 } : { showYear: 0 });
}).join('')
+ '</div></section>';
}
var BANNER_GEN = 0;
var BB_TIMER = 0;          // 轮播定时器（模块级：重画首页必须先清掉上一代，否则它还在拨旧 DOM）
var BB_N = 5;
function bannerPick(rows, n) {
var out = [];
for (var i = 0; i < rows.length && out.length < (n || 1); i++) {
if (rows[i] && rows[i][7]) out.push(rows[i]);
}
return out;
}
function bannerHtml(r, on) {
var id = r[0], name = r[2] || r[1];
var sub = [r[4] || '', TYPE[r[3]] || r[3] || '',
r[7] ? '★' + Number(r[7]).toFixed(1) : '', r[8] ? r[8] + ' 话' : '']
.filter(Boolean).join(' · ');
return '<a class="bigbanner' + (on ? ' is-on' : '') + '" href="/detail?id=' + id + '">'
+ '<img class="bigbanner-bg" data-src="' + esc(posterHd(id)) + '"'
+   posterFb(id, ANI.extra[id] || []) + (on ? ' fetchpriority="high"' : '') + ' alt="">'
+ '<div class="bigbanner-in">'
+ '<span class="bigbanner-tag">本季推荐</span>'
+ '<h2>' + titleHTML(name) + '</h2>'
+ '<p class="bigbanner-sub">' + esc(sub) + '</p>'
+ '<p class="bigbanner-plot"></p>'
+ '</div></a>';
}
function bannerCarousel(rows) {
var slides = rows.map(function (r, i) { return bannerHtml(r, i === 0); }).join('');
var dots = rows.map(function (r, i) {
return '<i data-i="' + i + '"' + (i ? '' : ' class="on"') + '></i>';
}).join('');
return '<div class="bb">' + slides
+ '<button class="bb-nav bb-prev" type="button" aria-label="上一张">‹</button>'
+ '<button class="bb-nav bb-next" type="button" aria-label="下一张">›</button>'
+ '<div class="bb-dots">' + dots + '</div></div>';
}
function fillBannerPlot(slide, r, gen) {
if (!slide) return;
detailShard(r[0]).then(function (list) {
if (gen !== BANNER_GEN || !list) return;
var box = slide.querySelector('.bigbanner-plot');
if (!box) return;
var rec = null;
for (var i = 0; i < list.length; i++) {
if (list[i] && list[i].id === r[0]) { rec = list[i]; break; }
}
var txt = String((rec && rec.overview) || '').replace(/\s+/g, ' ').trim();
if (txt) box.textContent = txt.slice(0, 80) + (txt.length > 80 ? '…' : '');
}, function () { /* 分片拉不到：banner 其余部分照常，简介留空 */ });
}
function initCarousel(main, rows, gen) {
var root = main.querySelector('.bb');
if (!root) return;
var slides = [].slice.call(root.querySelectorAll('.bigbanner'));
var dots = [].slice.call(root.querySelectorAll('.bb-dots i'));
var n = slides.length;
if (!n) return;
var at = 0;
function loadBg(i) {
var img = slides[i] && slides[i].querySelector('.bigbanner-bg');
if (!img) return;
if (!img.getAttribute('src') && img.getAttribute('data-src')) {
img.src = img.getAttribute('data-src');
}
}
function plot(i) {
loadBg(i);
var box = slides[i] && slides[i].querySelector('.bigbanner-plot');
if (box && !box.textContent) fillBannerPlot(slides[i], rows[i], gen);
}
function go(i) {
at = ((i % n) + n) % n;
slides.forEach(function (e, k) { e.classList.toggle('is-on', k === at); });
dots.forEach(function (d, k) { d.classList.toggle('on', k === at); });
plot(at);
}
function stop() { if (BB_TIMER) { clearInterval(BB_TIMER); BB_TIMER = 0; } }
function tick() {
stop();
BB_TIMER = setInterval(function () {
if (!root.isConnected) { stop(); return; }
go(at + 1);
}, 6000);
}
root.querySelector('.bb-prev').onclick = function (e) { e.preventDefault(); go(at - 1); tick(); };
root.querySelector('.bb-next').onclick = function (e) { e.preventDefault(); go(at + 1); tick(); };
dots.forEach(function (d) {
d.onclick = function (e) { e.preventDefault(); go(Number(d.getAttribute('data-i'))); tick(); };
});
root.onmouseenter = stop;
root.onmouseleave = tick;
plot(0);
if (n > 1) tick();
}
function contList(n) {
var all = progressAll();
var idx = {};
for (var i = 0; i < ANI.rows.length; i++) idx[String(ANI.rows[i][0])] = ANI.rows[i];
var out = [];
for (var k in all) {
if (!Object.prototype.hasOwnProperty.call(all, k)) continue;
var rec = progressOf(k);
var row = idx[String(k)];
if (!rec || !row) continue;
out.push({ r: row, ep: Math.floor(Number(rec.ep)), pos: Number(rec.pos) || 0,
dur: Number(rec.dur) || 0, ts: Number(rec.ts) || 0 });
}
out.sort(function (a, b) { return b.ts - a.ts; });
return out.slice(0, n || 7);
}
function contCard(it) {
var r = it.r, id = r[0], name = r[2] || r[1];
var pc = it.dur > 0 && it.pos > 0 ? Math.min(100, Math.round(it.pos / it.dur * 100)) : 0;
var left = it.dur > 0 && it.pos > 0 ? Math.round((it.dur - it.pos) / 60) : 0;
return '<article class="card cont" data-id="' + id + '"><div class="pw">'
+ '<img src="' + esc(posterSrc(id)) + '"' + posterFb(id, ANI.extra[id] || [])
+ ' loading="lazy" decoding="async" alt="">'
+ (r[8] ? '<span class="ep">' + r[8] + ' 集</span>' : '')
+ '<span class="cont-bar"><i style="width:' + (pc || 6) + '%"></i></span>'
+ '</div><div class="t">' + titleHTML(name) + '</div>'
+ '<div class="sub2">看到第 ' + it.ep + ' 集' + (left ? ' · 剩 ' + left + ' 分钟' : '') + '</div></article>';
}
function contBlock() {
var list = contList(7);
if (!list.length) return '';
return '<section class="block"><div class="sec-h"><h2>继续观看</h2>'
+ '<span class="sec-sub">' + list.length + ' 部 '
+ '<a class="morelink" href="/user">观看记录 ›</a></span></div>'
+ '<div class="grid">' + list.map(contCard).join('') + '</div></section>';
}
function renderHome() {
if (!HOME.y) homeDefaults();
var main = $('#main');
var wd = wdPick();
var seasonPool = seasonRows();
var cont = contBlock();
var todayTitle = HOME.wd ? (WD[wd - 1] + ' 更新') : ('今天更新 · ' + (WD[wd - 1] || ''));
var today = block(todayTitle, todayRows().slice(0, 7),
'<a class="morelink" href="/anime">全部番剧 ›</a>');
if (today) {
var tpos = today.indexOf('<div class="grid');
if (tpos > 0) today = today.slice(0, tpos) + weekTabsHtml() + today.slice(tpos);
}
var season = block('本季新番 · ' + (HOME.q ? '第' + HOME.q + '季度' : HOME.y), seasonPool.slice(0, 7),
'<a class="morelink" href="/anime">更多 ›</a>');
var top = block('本季高分', topRows(7), '<a class="morelink" href="/rank">排行榜 ›</a>');
var hot = block('热门排行', rankPool('rank-all').slice(0, 7),
'<a class="morelink" href="/rank">全部排行 ›</a>', '', true);
var picks = bannerPick(seasonPool.length ? seasonPool : ANI.rows, BB_N);
var gen = ++BANNER_GEN;
if (BB_TIMER) { clearInterval(BB_TIMER); BB_TIMER = 0; }   // 上一代的自动轮播先停
main.innerHTML = (picks.length ? bannerCarousel(picks) : '')
+ '<div class="home-main">' + cont + today + season + top + hot + '</div>';
if (picks.length) initCarousel(main, picks, gen);
main.querySelectorAll('[data-wd]').forEach(function (b) {
b.onclick = function () {
var n = Number(b.getAttribute('data-wd')) || 0;
HOME.wd = n;
renderHome();
};
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
HOME = { y: y, q: q };
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
return nrm(r[1] + ' ' + (r[2] || '')).indexOf(q) !== -1;
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
var USER = null;
var userWatch = 0;
function maskEmail(s) {
var v = String(s || '');
var at = v.indexOf('@');
if (at <= 0) return v;
return v.charAt(0) + '***' + v.slice(at);
}
function userName(u) {
var name = String((u && u.name) || '');
if (name && name.indexOf('@') < 0) return name;
return String((u && (u.login || u.nickname || u.email)) || '');
}
function watchedCount() {
try {
if (typeof progressAll === 'function') {
var m = progressAll();
return m ? Object.keys(m).length : 0;
}
} catch (e) { /* 进度表坏了也不影响主页其它部分 */ }
return 0;
}
function favRows(n) {
var ids = {};
favList().forEach(function (id) { ids[String(id)] = 1; });
return (ANI.rows || []).filter(function (r) { return ids[String(r[0])]; }).slice(0, n);
}
function loadMe() {
var tk = authToken();
return authFetch('/auth/me', null, 12000, { authorization: 'Bearer ' + tk }, { method: 'GET' })
.then(function (r) {
if (r.status === 401) throw new Error('登录已失效，请重新登录');
var j = r.j || {};
if (!r.ok || !j.user) throw new Error('资料加载失败（HTTP ' + r.status + '）');
return j.user;
});
}
function loadProfile() {
var tk = authToken();
return authFetch('/auth/profile', null, 12000, { authorization: 'Bearer ' + tk }, { method: 'GET' })
.then(function (r) {
if (r.status === 404) return loadMe();
if (r.status === 401) throw new Error('登录已失效，请重新登录');
var j = r.j || {};
if (!r.ok) throw new Error('资料加载失败（HTTP ' + r.status + '）');
if (j.user) return j.user;
if (j.login || j.email || j.name) return j;
throw new Error('资料格式不对，稍后重试');
});
}
function userLoginHTML() {
return '<div class="sec-h"><h2>我的</h2><span class="sec-sub">未登录</span></div>'
+ '<div class="empty">登录后查看我的主页 —— 追番、观看进度和账号设置都在这里</div>'
+ '<div class="pf-acts-note">'
+ '<p><b>B 站扫码绑定</b>：绑定结果记在你的账号下（每人对自己的绑定负责），登录后才会出现扫码按钮。</p>'
+ '<p><b>夸克网盘</b>：绑在站点服务器上，全站共用一份，绑定入口在播放源面板。</p>'
+ '</div>'
+ '<div class="pf-actions"><button class="btn pri" id="pflogin" type="button">登录 / 注册</button></div>';
}
var BILI_BIND_PATH = '/bili/bind';
var BILI_QR_START = '/bili/qr/start';
var BILI_QR_POLL = '/bili/qr/poll';
var BILI_QR_MS = 2000;       // 轮询间隔
var BILI_QR_MAX = 90;        // 90 × 2s = 180s，与后端二维码有效期对齐
var BILI_ST = null;          // 上次读到的绑定状态：null=没问过；{bound:true,uname,vip_type} / {bound:false}
var QR_TIMER = 0;            // 扫码轮询定时器（模块级：切后台/卡片被替换都要清掉）
var QR_KEY = '';             // 当前二维码 key_id；空 = 没有在跑的扫码流程
var QR_TRIES = 0;            // 已发出的轮询次数
var QR_GEN = 0;              // 流程代号：重新生成/停止后，旧回调不再落地
var QR_BUSY = false;         // 上一轮请求还没回来时跳过这一拍，避免请求堆叠
var QR_PASTE_OPEN = false;   // 兜底粘贴框是否展开（重画卡片后保持）
function pfNode(id) { return document.getElementById(id); }
function pfBiliCard(st) {
var head = '<div class="mnote" id="pfbili-msg" role="status" aria-live="polite"></div>';
if (st && st.bound) {
return head
+ '<p class="authhint">B 站：<b>' + esc(st.uname || '未知昵称') + '</b>'
+ '（会员 VIP' + (Number(st.vip_type) || 0) + '）</p>'
+ '<div class="pf-actions">'
+ '<button class="btn" id="pfreque" type="button">重新扫码</button>'
+ '<button class="btn" id="pfunbind" type="button">解绑</button>'
+ '</div>'
+ '<div id="pfbili-qr"></div>';
}
return head
+ '<div id="pfbili-qr"></div>'
+ '<div class="pf-actions">'
+ '<button class="btn pri" id="pfbind-qr" type="button">扫码绑定 B 站账号</button>'
+ '</div>'
+ '<div id="pfbili-paste"' + (QR_PASTE_OPEN ? '' : ' style="display:none"') + '>'
+ '<label class="authfield"><span>B 站 SESSDATA</span>'
+ '<input type="password" id="pfsess" placeholder="粘贴 SESSDATA" autocomplete="off" spellcheck="false"></label>'
+ '<div class="pf-actions"><button class="btn pri" id="pfbind" type="button">绑定</button></div>'
+ '<p class="authhint">只用于读取你账号的播放地址与弹幕；只收 SESSDATA，不收 bili_jct。'
+ 'SESSDATA 等于你 B 站账号的登录凭证，绑定后如不放心可随时解绑。</p>'
+ '</div>'
+ '<p class="authhint">扫码在 B 站官方完成，站点不接触你的密码；绑定后随时可解绑。'
+ '<button class="mnote-btn" id="pfsess-open" type="button">'
+ (QR_PASTE_OPEN ? '收起粘贴框' : '改用粘贴 SESSDATA') + '</button></p>';
}
function pfBiliPaint(st, msg) {
var box = pfNode('pfbili');
if (!box) return;
pfBiliQrStop();
if (st && st.bound) QR_PASTE_OPEN = false;   // 绑上以后收起兜底框，下次解绑仍以扫码为主
box.innerHTML = pfBiliCard(st);
pfBiliWire();
if (msg) pfBiliMsg(msg);
}
function pfBiliMsg(msg) {
var el = pfNode('pfbili-msg');
if (el) el.textContent = msg || '';     // textContent：后端文案不解析成 HTML
}
function pfBiliFail(msg) {
var box = pfNode('pfbili');
if (!box) return;
box.innerHTML = '<div class="mnote">' + esc(msg)
+ ' <button class="mnote-btn" id="pfbili-re" type="button">重试</button></div>';
pfBiliWire();
}
function pfBiliWire() {
var q = pfNode('pfbind-qr');                    // 未绑定：主按钮走扫码
if (q) q.onclick = function () { pfBiliQrStart(); };
var rq = pfNode('pfreque');                     // 已绑定：重新扫码覆盖
if (rq) rq.onclick = function () { pfBiliQrStart(); };
var so = pfNode('pfsess-open');                 // 兜底：展开/收起粘贴框
if (so) so.onclick = function () { pfBiliTogglePaste(); };
var b = pfNode('pfbind');
if (b) b.onclick = function () { pfBiliDoBind(b); };
var u = pfNode('pfunbind');
if (u) u.onclick = function () { pfBiliDoUnbind(u); };
var r = pfNode('pfbili-re');
if (r) r.onclick = function () { loadPfBili(true); };
var sv = pfNode('pfqrsave');
if (sv) sv.onclick = function () { pfBiliQrSave(); };
}
function pfBiliQrStop() {
QR_GEN += 1;
if (QR_TIMER) { clearInterval(QR_TIMER); QR_TIMER = 0; }
QR_KEY = '';
QR_TRIES = 0;
QR_BUSY = false;
}
function pfBiliQrPause() {
if (QR_TIMER) { clearInterval(QR_TIMER); QR_TIMER = 0; }
QR_BUSY = false;
}
function pfBiliQrText(msg) {
var el = pfNode('pfbili-qrmsg');
if (el) el.textContent = msg || '';       // textContent：状态文案不当 HTML 解析
}
function pfBiliQrRetryBtn() {
var box = pfNode('pfbili-qractions');
if (!box) return;
box.innerHTML = '<button class="mnote-btn" id="pfqr-re" type="button">重新生成二维码</button>';
var b = pfNode('pfqr-re');
if (b) b.onclick = function () { pfBiliQrStart(); };
}
function pfBiliQrNote(msg, retry) {
var box = pfNode('pfbili-qr');
pfBiliQrStop();
if (!box) return;
box.innerHTML = '<p class="authhint">' + esc(msg) + '</p>'
+ (retry ? '<div class="pf-actions"><button class="mnote-btn" id="pfqr-re" type="button">重新生成</button></div>' : '');
var b = pfNode('pfqr-re');
if (b) b.onclick = function () { pfBiliQrStart(); };
}
function pfBiliQrExpired() {
var box = pfNode('pfbili-qr');
pfBiliQrStop();
if (!box) return;
box.innerHTML = '<div class="pf-actions">'
+ '<button class="mnote-btn" id="pfqr-re" type="button">二维码已过期，点这里重新生成</button></div>';
var b = pfNode('pfqr-re');
if (b) b.onclick = function () { pfBiliQrStart(); };
}
function pfBiliQrShow(png) {
var box = pfNode('pfbili-qr');
if (!box) return;
var src = String(png || '');
if (!/^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(src)) {
pfBiliQrNote('二维码数据格式不对，可改用粘贴 SESSDATA', true);
return;
}
box.innerHTML = '<img class="pf-qr" id="pfqrimg" alt="B站登录二维码" src="' + esc(src) + '"'
+ ' style="width:180px;height:180px;display:block;margin:0 auto 8px;border-radius:8px;background:#fff">'
+ '<p class="authhint" id="pfbili-qrmsg" role="status" aria-live="polite"></p>'
+ '<div id="pfbili-qractions">'
+ '<button class="mnote-btn" id="pfqrsave" type="button">保存二维码</button>'
+ '</div>';
pfBiliWire();
pfBiliQrText('用 B 站 App 扫码 · 180 秒内有效');
}
function pfBiliQrSave() {
var img = pfNode('pfqrimg');
if (!img) return;
var src = String(img.getAttribute('src') || '');
var m = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/i.exec(src);
if (!m) { pfBiliQrNote('二维码不是图片数据，无法保存', true); return; }
try {
var bin = atob(m[2].replace(/\s+/g, ''));
var buf = new Uint8Array(bin.length);
for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
var type = m[1].toLowerCase() === 'png' ? 'image/png' : 'image/jpeg';
var url = URL.createObjectURL(new Blob([buf], { type: type }));
var a = document.createElement('a');
a.href = url;
a.download = 'bilibili-login-qr.' + (type === 'image/png' ? 'png' : 'jpg');
a.rel = 'noopener';
document.body.appendChild(a);
a.click();
document.body.removeChild(a);
setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 20000);
pfBiliQrNote('已发起保存；手机端没反应就长按二维码图片另存', false);
} catch (e) {
pfBiliQrNote('保存失败（' + (e && e.message ? e.message : '浏览器不支持') + '），可长按二维码另存', true);
}
}
function pfBiliQrPoll() {
if (QR_TIMER) { clearInterval(QR_TIMER); QR_TIMER = 0; }
var gen = QR_GEN;
var timer = setInterval(function () {
if (gen !== QR_GEN) { clearInterval(timer); return; }   // 已重新生成/停止
if (!pfNode('pfbili') || !pfNode('pfqrimg')) { pfBiliQrStop(); return; }  // 卡片被换页摘掉
if (QR_BUSY) return;                                     // 上一拍还没回来，跳过
if (!QR_KEY) { pfBiliQrStop(); return; }
if (QR_TRIES >= BILI_QR_MAX) { pfBiliQrExpired(); return; }
var tk = authToken();
if (!tk) { pfBiliQrStop(); pfBiliFail('登录已失效，请重新登录后再试'); return; }
QR_TRIES += 1;
QR_BUSY = true;
authFetch(BILI_QR_POLL + '?key=' + encodeURIComponent(QR_KEY), null, 12000,
{ authorization: 'Bearer ' + tk }, { method: 'GET' })
.then(function (r) {
QR_BUSY = false;
if (gen !== QR_GEN) return;
var j = r.j || {};
if (r.status === 401) { pfBiliQrStop(); pfBiliFail('登录已失效，请重新登录后再试'); return; }
if (r.status === 404 || r.status === 410 || j.error === 'expired') { pfBiliQrExpired(); return; }
if (!r.ok || !j.ok || !j.state) return;               // 其它失败：下一拍再试
pfBiliQrState(j.state, j);
}, function () {
QR_BUSY = false;                                      // 网络抖动：不终止
});
}, BILI_QR_MS);
QR_TIMER = timer;
}
function pfBiliQrState(state, j) {
if (state === 'ok') {
pfBiliQrStop();
BILI_ST = { bound: true, uname: j.uname, vip_type: j.vip_type };
pfBiliPaint(BILI_ST, '扫码绑定成功');       // 重画即清掉二维码 DOM
return;
}
if (state === 'scanned') { pfBiliQrText('已扫码，请在手机上确认'); return; }
if (state === 'expired') { pfBiliQrExpired(); return; }
if (state === 'error') {
pfBiliQrStop();
pfBiliQrText('扫码状态异常，可重新生成二维码');
pfBiliQrRetryBtn();
return;
}
pfBiliQrText('等待扫码…');                    // waiting（及未知态）
}
function pfBiliQrStart() {
var tk = authToken();
if (!tk) { pfBiliFail('登录已失效，请重新登录后再试'); return; }
pfBiliQrStop();                                // 重开时先停旧流程（gen++）
var gen = QR_GEN;
var box = pfNode('pfbili-qr');
if (box) box.innerHTML = '<p class="authhint">二维码生成中…</p>';
pfBiliMsg('');
var done = setBusy(pfNode('pfbind-qr'), '生成中…');
authFetch(BILI_QR_START, {}, 15000, { authorization: 'Bearer ' + tk }, { method: 'POST' })
.then(function (r) {
done();
if (gen !== QR_GEN) return;                // 期间又点了生成/离开页面
var j = r.j || {};
if (r.status === 401) { pfBiliFail('登录已失效，请重新登录后再试'); return; }
if (r.status === 429) { pfBiliQrNote('操作太频繁，等一分钟再试', true); return; }
if (r.status === 503) { pfBiliQrNote('服务端缺少二维码组件，可改用粘贴 SESSDATA', true); return; }
if (!r.ok || !j.ok || !j.key_id || !j.png) {
pfBiliQrNote('二维码生成失败（HTTP ' + r.status + '），可改用粘贴 SESSDATA', true);
return;
}
QR_KEY = String(j.key_id);
QR_TRIES = 0;
pfBiliQrShow(j.png);
pfBiliQrPoll();
}, function (e) {
done();
if (gen !== QR_GEN) return;
pfBiliQrNote((e && e.message) || '二维码生成失败，请重试', true);
});
}
function pfBiliTogglePaste() {
QR_PASTE_OPEN = !QR_PASTE_OPEN;
var box = pfNode('pfbili-paste');
if (box) box.style.display = QR_PASTE_OPEN ? '' : 'none';
var btn = pfNode('pfsess-open');
if (btn) btn.textContent = QR_PASTE_OPEN ? '收起粘贴框' : '改用粘贴 SESSDATA';
if (QR_PASTE_OPEN) {
var inp = pfNode('pfsess');
if (inp) { try { inp.focus(); } catch (e) { /* 老浏览器忽略 */ } }
}
}
document.addEventListener('visibilitychange', function () {
if (document.visibilityState === 'hidden') { pfBiliQrPause(); return; }
if (!QR_TIMER && QR_KEY && QR_TRIES < BILI_QR_MAX && pfNode('pfqrimg')) pfBiliQrPoll();
});
function loadPfBili(force) {
var box = pfNode('pfbili');
if (!box) return;
if (!authToken()) { box.innerHTML = ''; return; }   // 未登录：不画这块
if (BILI_ST && !force) { pfBiliPaint(BILI_ST); return; }
box.innerHTML = '<div class="mnote">B 站账号读取中…</div>';
authFetch(BILI_BIND_PATH, null, 12000, { authorization: 'Bearer ' + authToken() }, { method: 'GET' })
.then(function (r) {
var j = r.j || {};
if (j.ok && j.bound) {
BILI_ST = { bound: true, uname: j.uname, vip_type: j.vip_type };
pfBiliPaint(BILI_ST);
return;
}
if (j.ok && (j.bound === false || j.status === 'none')
|| j.error === 'not_bound' || r.status === 404) {
BILI_ST = { bound: false };
pfBiliPaint(BILI_ST);
return;
}
if (r.status === 401) { pfBiliFail('登录已失效，请重新登录后再试'); return; }
pfBiliFail('B 站账号状态读取失败（HTTP ' + r.status
+ (j.error ? ' · ' + String(j.error).slice(0, 40) : '') + '）');
}, function (e) {
pfBiliFail((e && e.message) || 'B 站账号状态读取失败');
});
}
function pfBiliSess(raw) {
var s = String(raw == null ? '' : raw).trim();
var m = /(?:^|[;\s])SESSDATA\s*=\s*([^;\s"']+)/i.exec(s);
if (m) return m[1];
return s.replace(/^SESSDATA\s*=\s*/i, '').replace(/[;,"'\s]+$/, '');
}
function pfBiliBindMsg(r) {
var j = r.j || {};
if (r.status === 401) return '登录已失效，请重新登录后再试';
if (j.error === 'expired') return '这段 SESSDATA 已失效（或没复制全），请到 B 站重新复制';
if (j.error) return '绑定失败：' + j.error;
return '绑定失败（HTTP ' + r.status + '）';
}
function pfBiliDoBind(btn) {
var inp = pfNode('pfsess');
var sess = pfBiliSess(inp ? inp.value : '');
if (inp) inp.value = '';                        // 提交即清空：DOM 里不留凭证
if (!sess) { pfBiliMsg('请先粘贴 SESSDATA'); return; }
var tk = authToken();
if (!tk) { pfBiliFail('登录已失效，请重新登录后再试'); return; }
var done = setBusy(btn, '绑定中…');
authFetch(BILI_BIND_PATH, { sess: sess }, 20000, { authorization: 'Bearer ' + tk }, { method: 'POST' })
.then(function (r) {
var j = r.j || {};
if (r.ok && j.ok) {
BILI_ST = { bound: true, uname: j.uname, vip_type: j.vip_type };
pfBiliPaint(BILI_ST, '绑定成功');
return;
}
done();
pfBiliMsg(pfBiliBindMsg(r));
}, function (e) {
done();
pfBiliMsg((e && e.message) || '绑定失败，请重试');
});
}
function pfBiliDoUnbind(btn) {
var tk = authToken();
if (!tk) { pfBiliFail('登录已失效，请重新登录后再试'); return; }
var done = setBusy(btn, '解绑中…');
authFetch(BILI_BIND_PATH, null, 15000, { authorization: 'Bearer ' + tk }, { method: 'DELETE' })
.then(function (r) {
var j = r.j || {};
if (r.ok && j.ok) {
BILI_ST = { bound: false };
pfBiliPaint(BILI_ST, '已解绑，可随时重新绑定');
return;
}
done();
pfBiliMsg(r.status === 401 ? '登录已失效，请重新登录后再试'
: '解绑失败（HTTP ' + r.status + '），稍后重试');
}, function (e) {
done();
pfBiliMsg((e && e.message) || '解绑失败，请重试');
});
}
function userHTML(u) {
var name = userName(u) || '未登录用户';
var mail = maskEmail(u.email || (String(u.login || '').indexOf('@') >= 0 ? u.login : ''));
var av = String(u.avatar || '');
var avHtml = av
? '<img class="av" src="' + esc(av) + '" alt="">'
: '<span class="av">' + esc(name.slice(0, 1).toUpperCase()) + '</span>';
var rows = favRows(24);
var cont = typeof contList === 'function' ? contList(24) : [];
var body;
if (!ANI.rows || !ANI.rows.length) {
body = '<div class="empty">番剧数据还没加载好 —— 稍后刷新看看</div>';
} else if (!rows.length) {
body = '<div class="empty">还没有追番 —— 打开一部番剧，点详情里的「☆ 追番」</div>'
+ '<div class="pf-actions is-empty"><a class="btn" href="anime">去番剧页</a></div>';
} else {
body = '<div class="grid">' + rows.map(function (r) {
return animeCard(r, { showYear: 1 });
}).join('') + '</div>';
}
var contBody = cont.length
? '<div class="grid">' + cont.map(contCard).join('') + '</div>'
: '<div class="empty">还没有观看记录 —— 进任意一部番剧点「播放」就会开始记录</div>'
+ '<div class="pf-actions is-empty"><a class="btn" href="anime">去番剧页</a></div>';
return '<div class="pf-hero"></div>'
+ '<div class="pf-id">' + avHtml
+ '<div class="pf-name"><h1>' + esc(name) + '</h1>'
+ (mail ? '<p>' + esc(mail) + '</p>' : '') + '</div></div>'
+ '<div class="pf-stats">'
+ '<div><b>' + favList().length + '</b><i>追番</i></div>'
+ '<div><b>' + watchedCount() + '</b><i>看过</i></div>'
+ '<div><b>' + cont.length + '</b><i>观看记录</i></div>'
+ '</div>'
+ '<div class="pf-actions">'
+ '<button class="btn" id="pfpw" type="button">修改密码</button>'
+ '<button class="btn" id="pfout" type="button">退出登录</button>'
+ '<button class="btn" id="pfquark" type="button">绑定夸克网盘</button>'
+ '</div>'
+ '<div class="pf-bili" id="pfbili"></div>'
+ '<div class="mtabs pf-tabs">'
+ '<button class="mtab on" type="button" data-tab="fav">我的追番（' + rows.length + '）</button>'
+ '<button class="mtab" type="button" data-tab="cont">观看记录（' + cont.length + '）</button>'
+ '</div>'
+ '<div class="pf-body" data-pane="fav">' + body + '</div>'
+ '<div class="pf-body" data-pane="cont" hidden>' + contBody + '</div>';
}
function watchLogin() {
if (userWatch) return;
var n = 0;
userWatch = setInterval(function () {
if (authToken()) {
clearInterval(userWatch);
userWatch = 0;
USER = null;
renderUser();
return;
}
n += 1;
if (n > 450) { clearInterval(userWatch); userWatch = 0; }
}, 400);
}
function bindUserLogin() {
var b = document.getElementById('pflogin');
if (!b) return;
b.onclick = function () {
if (window.__openLogin) window.__openLogin();
watchLogin();
};
}
function bindUserActions() {
var pw = document.getElementById('pfpw');
if (pw) pw.onclick = function () { openAuthPanel('account'); };
var qk = document.getElementById('pfquark');
if (qk) qk.onclick = function () { openQuarkBindPanel(); };
var out = document.getElementById('pfout');
if (out) out.onclick = function () {
logoutAccount();
USER = null;
BILI_ST = null;                 // 换账号后 B 站绑定状态要重新问一次
var m = $('#main');
if (m) { m.innerHTML = userLoginHTML(); bindUserLogin(); }
};
var tabs = document.querySelectorAll('.pf-tabs .mtab');
tabs.forEach(function (b) {
b.onclick = function () {
var want = b.getAttribute('data-tab');
tabs.forEach(function (x) { x.classList.toggle('on', x === b); });
document.querySelectorAll('.pf-body[data-pane]').forEach(function (p) {
p.hidden = p.getAttribute('data-pane') !== want;
});
};
});
}
function renderUser() {
var main = $('#main');
if (!main) return;
if (!authToken()) {
main.innerHTML = userLoginHTML();
bindUserLogin();
return;
}
if (USER) {
main.innerHTML = userHTML(USER);
bindUserActions();
loadPfBili();
return;
}
if (!main.querySelector('.pf-hero')) main.innerHTML = '<div class="loading">加载中…</div>';
loadProfile().then(function (u) {
USER = u;
main.innerHTML = userHTML(u);
bindUserActions();
loadPfBili();
}).catch(function (e) {
main.innerHTML = '<div class="empty">' + esc((e && e.message) || '资料加载失败')
+ '</div><div class="pf-actions"><a class="btn" href="user">重试</a></div>';
});
}
var BROWSE = { view: [], shown: 0, page: 120, busy: false };
function renderBrowse(mode) {
var grid = $('#grid');
if (!grid) { BROWSE.busy = false; return; }
var want;
if (mode === 'more') {
want = Math.min(BROWSE.shown + BROWSE.page, BROWSE.view.length);
} else {
want = mode === 'repaint'
? Math.min(Math.max(BROWSE.shown, BROWSE.page), BROWSE.view.length)
: Math.min(BROWSE.page, BROWSE.view.length);
grid.innerHTML = '';
BROWSE.shown = 0;
}
var html = '';
for (var i = BROWSE.shown; i < want; i++) html += animeCard(BROWSE.view[i], { showYear: 1 });
if (!BROWSE.view.length) {
html = '<div class="empty">这个组合没有作品 —— 换个年份/类型，或点「全部」再试</div>';
}
grid.insertAdjacentHTML('beforeend', html);
BROWSE.shown = want;
var left = BROWSE.view.length - BROWSE.shown;
$('#morewrap').hidden = left <= 0;
if (left > 0) $('#morebtn').textContent = '加载更多 · 还剩 ' + left + ' 部';
var hintText = '筛出 ' + BROWSE.view.length + ' 部，已显示 ' + BROWSE.shown;
$('#hint').textContent = hintText;
var hint2 = $('#hint2');
if (hint2) hint2.textContent = hintText;
BROWSE.busy = false;
}
function applyBrowse(reset) {
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
renderBrowse(reset === true ? 'repaint' : 'reset');
[['#f-year', y], ['#f-type', t], ['#f-tag', tg]].forEach(function (p) {
var el = $(p[0]);
if (!el) return;
var lb = el.closest('.f-label');
if (lb) lb.classList.toggle('on', !!p[1]);
});
var so = $('#f-sort');
if (so) {
var sl = so.closest('.f-label');
if (sl) sl.classList.toggle('on', sort !== 'year');
}
var yl = $('#f-year');
if (yl) {
var ylb = yl.closest('.f-label');
if (ylb) ylb.classList.toggle('off', !!(q && y));
}
}
var TAGS = null;
function pickTagFromUrl() {
try { return new URLSearchParams(location.search).get('tag') || ''; } catch (e) { return ''; }
}
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
var y = $('#f-year'); if (y) y.value = '';
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
return '<option value="' + esc(n) + '">' + esc(n) + '（' + t[n].length + '）</option>';
}).join('');
var want = pickTagFromUrl();
if (want && TAGS && TAGS[want]) {
sel.value = want;
var y = $('#f-year'); if (y) y.value = '';
applyBrowse();
}
});
}
function initBrowse() {
var years = {};
ANI.rows.forEach(function (r) { if (r[4]) years[r[4]] = (years[r[4]] || 0) + 1; });
var ys = Object.keys(years).map(Number).sort(function (a, b) { return b - a; });
$('#main').innerHTML = '<div class="sec-h"><h2>番剧</h2><span class="sec-sub" id="hint2"></span></div>'
+ '<div class="filters-bar"><div class="filters">'
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
+ '<span class="f-hint" id="hint"></span></div></div>'
+ '<div class="grid" id="grid"></div>'
+ '<div class="morewrap" id="morewrap" hidden><button class="morebtn" id="morebtn" type="button"></button></div>';
$('#f-year').value = ys[0] ? String(ys[0]) : '';
$('#morebtn').onclick = function () { renderBrowse('more'); };
['#f-year', '#f-type', '#f-sort'].forEach(function (s) { $(s).addEventListener('change', applyBrowse); });
mountTagFilter();
var deepTag = pickTagFromUrl();
if (deepTag && TAGS && TAGS[deepTag]) { $('#f-tag').value = deepTag; $('#f-year').value = ''; }
applyBrowse();
var wrap = $('#morewrap');
if (wrap && window.IntersectionObserver) {
var io = new IntersectionObserver(function (es) {
for (var i = 0; i < es.length; i++) {
if (!es[i].isIntersecting) continue;
if (wrap.hidden || BROWSE.busy) return;
BROWSE.busy = true;
renderBrowse('more');
return;
}
}, { rootMargin: '600px' });
io.observe(wrap);
}
}
var MOVIE = { all: [], view: [], shown: 0, page: 120, db: [], tm: [] };
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
function applyMovie(reset) {
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
renderMovie(reset === true ? false : true);
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
function refreshMovie(reset) {
if (!$('#mgrid')) return;
paintMovieDb();
applyMovie(reset === true);
}
var DETAIL_GEN = 0;            // 每次 renderDetail 自增：异步结果只落最后一代
function detailId() {
var m = /[?&]id=(\d+)/.exec(location.search || '');
if (m) return Number(m[1]);
m = /\/(?:anime|detail)\/(\d+)\/?$/.exec(location.pathname || '');
return m ? Number(m[1]) : 0;
}
function detailShard(id) {
var sfx = id % 64;
var pr = shardCache[sfx];
if (!pr) {
pr = jd('s' + sfx + '.json').then(function (d) { return d; }, function () {
delete shardCache[sfx];
return null;
});
shardCache[sfx] = pr;
}
return pr;
}
function mountTrailer(slot, key) {
if (!slot || !key) return;
slot.className = 'trailer-slot is-player';
slot.style.backgroundImage = '';
slot.innerHTML = '<div class="dpv-frame"><iframe'
+ ' src="https://www.youtube.com/embed/' + encodeURIComponent(key) + '?rel=0&modestbranding=1&playsinline=1"'
+ ' loading="lazy" allow="autoplay; encrypted-media; fullscreen; picture-in-picture"'
+ ' allowfullscreen referrerpolicy="origin-when-cross-origin"></iframe></div>';
}
function detailEmpty(head, sub, retry, docTitle) {
var m = $('#modal');
if (!m) return;
document.title = (docTitle || head) + ' · 番组计划';
m.innerHTML = '<nav class="dp-crumb"><a href="/anime">番剧</a><span>/</span><b>'
+ esc(head) + '</b></nav>'
+ '<section class="sect"><div class="sec-h"><h2>' + esc(head) + '</h2></div>'
+ '<p class="plot">' + esc(sub) + '</p>'
+ '<p><a class="btn pri" href="/anime">回番剧页</a>'
+ (retry ? ' <button class="btn" id="dpRetry" type="button">重试</button>' : '')
+ '</p></section>';
var rb = m.querySelector('#dpRetry');
if (rb) rb.onclick = function () { renderDetail(); };
}
function detailRelated(rec, id) {
var y = String(rec.air || '').slice(0, 4);
var t = rec.format || '';
var out = [], seen = {};
function add(r) {
if (!r || r[0] === id || seen[r[0]]) return;
seen[r[0]] = 1;
out.push(r);
}
function fill(fn) {
for (var i = 0; i < ANI.rows.length && out.length < 6; i++) {
if (fn(ANI.rows[i])) add(ANI.rows[i]);
}
}
fill(function (r) { return !!y && String(r[4] || '') === y && (!t || r[3] === t); });
fill(function (r) { return !!y && String(r[4] || '') === y; });
fill(function (r) { return !!t && r[3] === t && !!r[7]; });
return out.slice(0, 6);
}
function extParams() {
var m = /[?&]ext=(db|tm)(?:&|$)/.exec(location.search || '');
if (!m) return null;
var i = Number((/[?&]i=(\d+)/.exec(location.search || '') || [])[1] || 0);
return { kind: m[1], i: i };
}
function renderExtDetail(ext) {
var m = $('#modal');
if (!m) return;
var gen = ++DETAIL_GEN;
m.setAttribute('data-bgm', '');
document.body.setAttribute('data-ext-detail', '1');
m.innerHTML = '<div class="loading">详情加载中…</div>';
jd('movies.json').then(function (d) {
if (gen !== DETAIL_GEN) return;
var list = (d && (ext.kind === 'tm' ? d.tmdb : d.douban)) || [];
var x = list[ext.i];
if (!x) { detailEmpty('条目不存在', '这条豆瓣 / TMDB 记录不在数据里。', false); return; }
drawExtDetail(m, ext.kind, ext.i, x, list);
}, function () {
if (gen !== DETAIL_GEN) return;
detailEmpty('详情加载失败', 'movies.json 没拉到，检查网络后重试。', true, '条目不存在');
});
}
function drawExtDetail(m, kind, i, x, list) {
var isTm = kind === 'tm';
var title = x.n || x.title || ('#' + i);
var orig = isTm ? (x.ot || '') : (x.sub || '');
var rate = (x.r != null && x.r !== '') ? Number(x.r) : 0;
var year = String(x.y || x.year || '');
var srcName = isTm ? 'TMDB' : '豆瓣';
var intro = String((isTm ? x.ov : x.intro) || '');
var meta = [];
if (year) meta.push(['年份', year]);
if (orig && orig !== title) meta.push(['原名', orig]);
if (x.sub) meta.push(['地区 / 类型', x.sub]);
meta.push(['来源', srcName]);
var rel = [];
for (var k = 0; k < list.length && rel.length < 6; k++) {
if (k === i) continue;
if (year && String(list[k].y || '') === year) rel.push([list[k], k]);
}
for (var k2 = 0; k2 < list.length && rel.length < 6; k2++) {
if (k2 === i) continue;
var dup = rel.some(function (pair) { return pair[1] === k2; });
if (!dup && (list[k2].r != null && list[k2].r !== '')) rel.push([list[k2], k2]);
}
var relHtml = rel.map(function (pair) { return mcard(pair[0], kind, pair[1]); }).join('');
m.innerHTML = '<nav class="dp-crumb"><a href="/movie">电影</a><span>/</span><b>'
+ esc(title) + '</b></nav>'
+ '<section class="mhero">'
+   '<div class="mposter">'
+     (x.img ? '<img src="' + esc(x.img) + '" loading="lazy" decoding="async" alt="">'
: '<div class="ph">🎬</div>')
+   '</div>'
+   '<div class="mh-info">'
+     '<h3>' + esc(title) + '</h3>'
+     (orig && orig !== title ? '<div class="orig">' + esc(orig) + '</div>' : '')
+     '<div class="mbadges">'
+       (year ? '<span class="mbadge">' + esc(year) + '</span>' : '')
+       '<span class="mbadge">' + esc(srcName) + '</span>'
+     '</div>'
+     '<div class="mrate-line">'
+       (rate
? '<b class="score">' + rate.toFixed(1) + '</b>'
+ '<span class="stars" style="--p:' + Math.round(rate * 10) + '"></span>'
: '<b class="score dim">暂无评分</b>')
+       '<span class="votes">' + esc(srcName) + ' 评分</span>'
+     '</div>'
+     '<div class="acts">'
+       '<a class="btn pri" href="' + esc(x.u || x.url || '#') + '" target="_blank" rel="noopener">'
+         esc(srcName) + ' 页面</a>'
+       '<a class="btn" target="_blank" rel="noopener" href="https://search.bilibili.com/all?keyword='
+         encodeURIComponent(title) + '">B 站搜索</a>'
+     '</div>'
+   '</div>'
+ '</section>'
+ '<div class="dp-grid">'
+   '<div class="dp-main">'
+     (x.tr
? '<section class="sect" id="dp-trailer"><div class="sec-h"><h2>预告</h2></div>'
+ '<div class="trailer-slot" id="dpTrailerSlot">'
+ '<button class="btn pri" id="dpTrailer" type="button">▶ 播放预告（YouTube）</button></div></section>'
: '')
+     '<div class="mbody" data-p="ext">'
+       '<section class="sect" id="dp-plot"><div class="sec-h"><h2>简介</h2></div>'
+         '<p class="plot">' + esc(intro || '暂无简介') + '</p></section>'
+       '<section class="sect"><div class="sec-h"><h2>信息</h2></div>'
+         '<dl class="infobox">'
+           meta.map(function (kv) {
return '<dt>' + esc(kv[0]) + '</dt><dd>' + esc(kv[1]) + '</dd>';
}).join('')
+         '</dl></section>'
+     '</div>'
+   '</div>'
+   '<aside class="dp-side">'
+     '<section class="sect"><div class="sec-h"><h2>相关推荐</h2></div>'
+       (relHtml ? '<div class="grid mgrid dp-rel">' + relHtml + '</div>'
: '<p class="plot">暂无相关推荐</p>')
+     '</section>'
+     '<section class="sect"><div class="sec-h"><h2>数据来源</h2></div>'
+       '<p class="dp-src">' + esc(srcName) + '</p></section>'
+   '</aside>'
+ '</div>';
document.title = title + ' · 番组计划';
var tslotExt = m.querySelector('#dpTrailerSlot');
if (tslotExt && x.tr) mountTrailer(tslotExt, x.tr);
}
function renderDetail() {
var m = $('#modal');
if (!m) return;                            // 非 detail 页 / 壳缺失：不做任何事
var gen = ++DETAIL_GEN;
var ext = extParams();
if (ext) { renderExtDetail(ext); return; } // 豆瓣 / TMDB：同款整页详情，不走 Bangumi 分片
var id = detailId();
m.setAttribute('data-bgm', '');             // 先清掉上一代的 id：磁力层按它做身份校验
if (!id) { detailEmpty('条目不存在', '地址里没有 id 参数，回番剧页挑一部吧。', false); return; }
m.innerHTML = '<div class="loading">详情加载中…</div>';
detailShard(id).then(function (list) {
if (gen !== DETAIL_GEN) return;          // 期间又重画过（重试 / 换清晰度）：这一代作废
if (list === null) {
detailEmpty('详情加载失败', '详情分片没拉到，检查网络后重试。', true, '条目不存在');
return;
}
var rec = null;
for (var i = 0; i < (list || []).length; i++) {
if (list[i] && list[i].id === id) { rec = list[i]; break; }
}
if (!rec) { detailEmpty('条目不存在', '这条记录不在详情分片里（可能已下架）。', false); return; }
drawDetail(m, id, rec);
});
}
function drawDetail(m, id, rec) {
var row = null;
for (var i = 0; i < ANI.rows.length; i++) { if (ANI.rows[i][0] === id) { row = ANI.rows[i]; break; } }
var ex = ANI.extra[id] || [];
var title = (row && (row[2] || row[1])) || rec.name_cn || rec.name || ('#' + id);
var orig = (row && row[1]) || rec.name || '';
var air = String(rec.air || '');            // 分片里是完整日期（2006-09-01），列表行只有年份
var year = (row && row[4]) || Number(air.slice(0, 4)) || 0;
var month = (row && row[5]) || Number(air.slice(5, 7)) || 0;
var type = (row && row[3]) || rec.format || '';
var epsN = (row && row[8]) || rec.episodes || 0;
var rating = Number(rec.rating || (row && row[7]) || 0);
var rank = Number(rec.rank || (row && row[12]) || 0);
var votes = Number(rec.votes || 0);
var co = rec.co && rec.co.length ? rec.co : [];
var curEp = 1;
var prog = progressOf(id);
if (prog && Number(prog.ep) > 0) curEp = Math.floor(Number(prog.ep));
var meta = [];
if (votes) meta.push(votes + ' 人评分');
if (rank) meta.push('排名 #' + rank);
var collect = ['想看', '在看', '看过'].map(function (lb, k) {
return '<span><b>' + (co[k] == null || co[k] === '' ? '—' : esc(String(co[k])))
+ '</b><i>' + lb + '</i></span>';
}).join('');
var info = [];
if (air) info.push(['放送', air]);
else if (year) info.push(['放送', year + ' 年']);
if (epsN) info.push(['话数', epsN + ' 话']);
if (type) info.push(['类型', TYPE[type] || type]);
if (orig && orig !== title) info.push(['原名', orig]);
info.push(['来源', 'Bangumi']);            // magnet-eps.js 的 episodeCount() 读这里的「话数」
var infoRows = info.map(function (kv) {
return '<dt>' + esc(kv[0]) + '</dt><dd>' + esc(kv[1]) + '</dd>';
}).join('');
var relHtml = detailRelated(rec, id).map(function (r) {
return animeCard(r, { showYear: 1 });
}).join('');
m.innerHTML = '<nav class="dp-crumb"><a href="/anime">番剧</a><span>/</span><b>'
+ esc(title) + '</b></nav>'
+ '<section class="mhero">'
+   '<img class="mposter" src="' + esc(posterSrc(id)) + '"' + posterFb(id, ex) + ' alt="">'
+   '<div class="mh-info">'
+     '<h3>' + esc(title) + '</h3>'
+     (orig && orig !== title ? '<div class="orig">' + esc(orig) + '</div>' : '')
+     '<div class="mbadges">'
+       (year ? '<span class="mbadge">' + year + (month ? ' 年 ' + month + ' 月' : ' 年') + '</span>' : '')
+       (type ? '<span class="mbadge">' + esc(TYPE[type] || type) + '</span>' : '')
+       (epsN ? '<span class="mbadge">' + epsN + ' 话</span>' : '')
+     '</div>'
+     '<div class="mrate-line">'
+       (rating
? '<b class="score">' + rating.toFixed(1) + '</b>'
+ '<span class="stars" style="--p:'
+ Math.max(0, Math.min(100, Math.round(rating * 10))) + '"></span>'
: '<b class="score dim">暂无评分</b>')
+       '<span class="votes">' + esc(meta.join(' · ')) + '</span>'
+     '</div>'
+     '<div class="mcollect">' + collect + '</div>'
+     '<div class="acts">'
+       '<button class="btn pri" id="watch" type="button">▶ 开始观看</button>'
+       '<button class="btn" id="favbtn" type="button">☆ 追番</button>'
+     '</div>'
+   '</div>'
+ '</section>'
+ '<div class="dp-grid">'
+   '<div class="dp-main">'
+     srcPanelHtml(id, title, curEp)
+     '<div class="dp-watch">'
+       '<div class="dp-player" id="dpPlayer" style="--cover:url(' + esc(posterHd(id)) + ')"></div>'
+       '<div class="mbody dp-eps" data-p="detail"></div>'
+     '</div>'
+     (ex[2]
? '<section class="sect" id="dp-trailer"><div class="sec-h"><h2>预告</h2></div>'
+ '<div class="trailer-slot" id="dpTrailerSlot">'
+ '<button class="btn pri" id="dpTrailer" type="button">▶ 播放预告（YouTube）</button></div></section>'
: '')
+     '<nav class="mtabs dp-nav">'
+       '<a class="mtab on" href="#dp-plot">简介</a>'
+       '<a class="mtab" href="#dp-chars">角色</a>'
+       '<a class="mtab" href="#dp-staff">制作</a>'
+       '<a class="mtab" href="#dp-rt">评价</a>'
+       '<a class="mtab" href="#dp-dm">弹幕</a>'
+       '<a class="mtab" href="#dp-rp">评论</a>'
+     '</nav>'
+     '<div class="mbody" data-p="detail">'
+       '<section class="sect" id="dp-plot"><div class="sec-h"><h2>简介</h2></div>'
+         '<p class="plot" id="plot"></p></section>'
+       '<section class="sect"><div class="sec-h"><h2>标签</h2></div>'
+         '<div class="tagpills" id="tags"></div></section>'
+       '<section class="sect" id="dp-chars"><div class="sec-h"><h2>角色</h2></div>'
+         '<div class="chgrid"></div></section>'
+       '<section class="sect" id="dp-staff"><div class="sec-h"><h2>制作人员</h2></div>'
+         '<div class="staffgrid"></div></section>'
+     '</div>'
+     '<div class="mbody" data-p="rt" id="dp-rt"><section class="sect">'
+       '<div class="sec-h"><h2>评分分布</h2></div><div id="prt"></div></section></div>'
+     '<div class="mbody" data-p="dm" id="dp-dm"><div id="pdm"></div></div>'
+     '<div class="mbody" data-p="rp" id="dp-rp"><div id="prp"></div></div>'
+   '</div>'
+   '<aside class="dp-side">'
+     '<section class="sect"><div class="sec-h"><h2>信息</h2></div>'
+       '<dl class="infobox">' + infoRows + '</dl></section>'
+     '<section class="sect"><div class="sec-h"><h2>相关推荐</h2>'
+       '<span class="sec-sub">同年份 · 同类型</span></div>'
+       '<div class="grid dp-rel">' + relHtml + '</div></section>'
+     '<section class="sect"><div class="sec-h"><h2>数据来源</h2></div>'
+       '<p class="dp-src">Bangumi · AniList · B 站</p></section>'
+   '</aside>'
+ '</div>';
m.setAttribute('data-bgm', String(id));
document.body.removeAttribute('data-ext-detail');   // 回到番剧详情：磁力层恢复挂载
document.title = title + ' · 番组计划';
srcPanelMount(m, id, title, curEp);
var plot = m.querySelector('#plot');
if (plot) {
var pv = splitPlot(rec.overview, rec.overview_ja);
plot.textContent = pv.zh;
var sect = plot.parentNode;
var oldJa = sect ? sect.querySelector('.plot-ja') : null;
if (oldJa) sect.removeChild(oldJa);
if (pv.ja && sect) sect.insertAdjacentHTML('beforeend', plotJaHtml(pv.ja));
}
renderTags(rec, m.querySelector('#tags'));
ensureTagCounts(function () { renderTags(rec, m.querySelector('#tags')); });
var chgrid = m.querySelector('.chgrid');
if (chgrid && rec.ch && rec.ch.length) {
chgrid.innerHTML = rec.ch.map(function (c) {
var av = avatarSrc(c[2]);
return '<div class="chcard"><span class="ph">'
+ '<span class="chin">' + esc(Array.from(String(c[0] == null ? '' : c[0]))[0] || '?') + '</span>'
+ (av ? '<img class="chav" src="' + esc(av) + '" alt="" referrerpolicy="no-referrer"'
+ ' loading="lazy" decoding="async" onerror="this.remove()">' : '')
+ '</span><div class="chinfo"><b>' + esc(c[0]) + '</b><em>' + esc(c[1]) + '</em></div></div>';
}).join('');
} else {
var sChars = m.querySelector('#dp-chars');
if (sChars) sChars.hidden = true;
}
var staffgrid = m.querySelector('.staffgrid');
if (staffgrid && rec.st && rec.st.length) {
staffgrid.innerHTML = rec.st.map(function (p) {
return '<div class="staff"><b>' + esc(p[0]) + '</b>'
+ (p[1] ? '<em>' + esc(p[1]) + '</em>' : '') + '</div>';
}).join('');
} else {
var sStaff = m.querySelector('#dp-staff');
if (sStaff) sStaff.hidden = true;
}
var prt = m.querySelector('#prt');
if (prt) {
if (rec.rc && rec.rc.length === 10) {
var mx = Math.max.apply(null, rec.rc);
var sum = rec.rc.reduce(function (a, b) { return a + b; }, 0);
var bars = rec.rc.map(function (n, k) {
var bh = mx ? Math.max(2, Math.round((n / mx) * 100)) : 2;
return '<i style="height:' + bh + '%" title="' + (k + 1) + ' 分 · ' + n + ' 人">'
+ '<b>' + (k + 1) + '</b></i>';
}).join('');
prt.innerHTML = '<div class="rdist" id="rdist"><div class="rdhead">星级分布合计 <b>'
+ sum + '</b> 人'
+ (rank ? ' · 排名 <b>#' + rank + '</b>' : '')
+ (votes ? ' · Bangumi 共 ' + votes + ' 人评分' : '') + '</div>' + bars + '</div>';
} else {
prt.innerHTML = '<p class="plot">暂无评分分布</p>';
}
}
var wb = m.querySelector('#watch');
if (wb) wb.onclick = function () {
if (window.__srcStart && window.__srcStart(m, id, title, curEp)) return;
openQuarkPlay(m.querySelector('#dpPlayer') || m, id, title);
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
var dpslot = m.querySelector('#dpPlayer');
if (dpslot) {
dpslot.onclick = function () {
if (dpslot.childNodes.length) return;
openQuarkPlay(dpslot, id, title);
};
}
var tslot = m.querySelector('#dpTrailerSlot');
if (tslot && ex[2]) mountTrailer(tslot, ex[2]);
var nav = m.querySelector('.dp-nav');
if (nav) {
nav.onclick = function (ev) {
var a = ev.target;
while (a && a !== nav && !(a.tagName === 'A' && String(a.getAttribute('href') || '').charAt(0) === '#')) {
a = a.parentNode;
}
if (!a || a === nav) return;
var aid = String(a.getAttribute('href')).slice(1);
var target = document.getElementById(aid);
if (!target) return;                    // 该节没有内容（角色/制作被收起）就不动
ev.preventDefault();
nav.querySelectorAll('.mtab').forEach(function (x) { x.classList.toggle('on', x === a); });
var off = 0;
var head = document.querySelector('header.site-head');
if (head && head.getBoundingClientRect) off += head.getBoundingClientRect().height || 0;
if (nav.getBoundingClientRect && (window.innerWidth || 0) > 760) {
off += nav.getBoundingClientRect().height || 0;
}
var y = target.getBoundingClientRect
? target.getBoundingClientRect().top + (window.pageYOffset || 0) - off - 8
: 0;
if (window.scrollTo) {
try { window.scrollTo({ top: y, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, y); }
}
try { history.replaceState(null, '', '#' + aid); } catch (e) { /* 隐私模式忽略 */ }
};
}
var rel = m.querySelector('.dp-rel');
if (rel) {
rel.onclick = function (ev) {
var c = ev.target;
while (c && c !== rel && !(c.className && /(^|\s)card(\s|$)/.test(c.className))) c = c.parentNode;
if (!c || c === rel) return;
var rid = c.getAttribute('data-id');
if (!rid) return;
ev.preventDefault();
location.href = '/detail?id=' + rid;
};
}
bindBili(id, title, (row && row[4]) || '');
}
var MODAL_GEN = 0;
function urlWithId(id) {
var parts = location.search.replace(/^\?/, '').split('&');
var out = [], put = false;
for (var i = 0; i < parts.length; i++) {
if (!parts[i]) continue;
if (/^id=/.test(parts[i])) {
if (put) continue;
out.push('id=' + encodeURIComponent(id));
put = true;
} else out.push(parts[i]);
}
if (!put) out.push('id=' + encodeURIComponent(id));
return location.pathname + '?' + out.join('&');
}
function renderTags(rec, el) {
if (!el) return;
el.innerHTML = (rec.tags || []).filter(function (t, i, arr) { return arr.indexOf(t) === i; }).slice(0, 12).map(function (t) {
var n = TAGCNT[t];
var href = '/anime?tag=' + encodeURIComponent(t);
return '<a class="tagpill" href="' + esc(href) + '">' + esc(t) + (n ? '<em>' + n + '</em>' : '') + '</a>';
}).join('');
}
function openModal(id) {
var r = ANI.rows.find(function (x) { return x[0] === id; });
if (!r) return;
var ex = ANI.extra[id] || [];
var title = r[2] || r[1];
var m = $('#modal');
if (!m) return;                              // 页面没有 #modal 壳时别抛引用错
var curEp = 1;
var prog = progressOf(id);
if (prog && Number(prog.ep) > 0) curEp = Math.floor(Number(prog.ep));
var host = m, gen = ++MODAL_GEN;             // 这一代弹窗的容器引用与代号
m.innerHTML = '<button class="x" type="button" aria-label="关闭">×</button>'
+ '<div class="mhero">'
+   '<img class="mposter" src="' + esc(posterSrc(id)) + '"' + posterFb(id, ex) + ' alt="">'
+   '<div class="mh-info">'
+     '<h3>' + esc(title) + '</h3>'
+     (r[1] !== title ? '<div class="orig">' + esc(r[1]) + '</div>' : '')
+     '<div class="mbadges">'
+       (r[4] ? '<span class="mbadge">' + r[4] + (r[5] ? ' 年 ' + r[5] + ' 月' : ' 年') + '</span>' : '')
+       (r[3] ? '<span class="mbadge">' + esc(TYPE[r[3]] || r[3]) + '</span>' : '')
+       (r[8] ? '<span class="mbadge">' + r[8] + ' 话</span>' : '')
+     '</div>'
+     '<div class="mrate-line">'
+       (r[7] ? '<b class="score">' + Number(r[7]).toFixed(1) + '</b>'
+ '<span class="stars" style="--p:' + Math.max(0, Math.min(100, Math.round(r[7] * 10))) + '"></span>'
: '<b class="score dim">暂无评分</b>')
+       '<span class="votes" id="mvotes"></span>'
+     '</div>'
+     '<div class="mcollect">'
+       '<span><b>—</b><i>想看</i></span><span><b>—</b><i>在看</i></span><span><b>—</b><i>看过</i></span>'
+     '</div>'
+     '<div class="acts">'
+       '<span class="btn pri" id="watch" role="button" tabindex="0">▶ 播放</span>'
+       '<span class="btn" id="favbtn" type="button">☆ 追番</span>'
+       (ex[2] ? '<span class="btn" id="play">▶ 预告</span>' : '')
+       '<a class="btn" target="_blank" rel="noopener" href="https://search.bilibili.com/all?keyword='
+         encodeURIComponent(title) + '">B 站搜索</a>'
+     '</div>'
+   '</div>'
+ '</div>'
+ srcPanelHtml(id, title, curEp)
+ '<div class="mtabs">'
+   '<button class="mtab on" data-p="detail" type="button">详情</button>'
+   '<button class="mtab" data-p="rt" type="button">评价</button>'
+   '<button class="mtab" data-p="dm" type="button">弹幕</button>'
+   '<button class="mtab" data-p="rp" type="button">评论</button>'
+ '</div>'
+ '<div class="mbody" data-p="detail">'
+   '<section class="sect"><div class="sec-h"><h2>简介</h2></div><p class="plot" id="plot">加载中…</p></section>'
+   '<section class="sect"><div class="sec-h"><h2>标签</h2></div><div class="tagpills" id="tags"></div></section>'
+   '<section class="sect" id="sect-chars" hidden></section>'
+   '<section class="sect" id="sect-staff" hidden></section>'
+ '</div>'
+ '<div class="mbody" data-p="rt" hidden><div class="sect"><div class="sec-h"><h2>评分分布</h2></div><div id="prt"></div></div></div>'
+ '<div class="mbody" data-p="dm" hidden><div id="pdm"></div></div>'
+ '<div class="mbody" data-p="rp" hidden><div id="prp"></div></div>';
$('#mask').classList.add('on');
if (m && m.setAttribute) m.setAttribute('data-bgm', String(id));
m.querySelector('.x').onclick = close;
var wb = m.querySelector('#watch');
if (wb) {
wb.onclick = function () { openQuarkPlay(m, id, title); };
wb.onkeydown = function (ev) {
if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); wb.click(); }
};
}
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
if (ex[2]) {
$('#play').onclick = function () {
if (host.querySelector('.trailer')) return;
var d = document.createElement('div');
d.className = 'trailer';
d.innerHTML = '<iframe src="https://www.youtube.com/embed/' + encodeURIComponent(ex[2])
+ '?autoplay=1&rel=0" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>';
m.appendChild(d);
};
}
try {
if (history.pushState && !new RegExp('[?&]id=' + id + '(?:&|$)').test(location.search)) {
history.pushState({ id: String(id) }, '', urlWithId(id));
}
} catch (e) { /* 沙箱/隐私模式里 pushState 受限：深链只是增强，不影响弹窗本身 */ }
var rec = null;
ensureTagCounts(function () {
if (gen !== MODAL_GEN || !rec) return;
renderTags(rec, host.querySelector('#tags'));
});
bindBili(id, title, r[4] || '');
srcPanelMount(m, id, title, curEp);
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
if (gen !== MODAL_GEN) return;      // 这一代已被新打开的番取代：数据与 DOM 都不再属于它
var plot = host.querySelector('#plot');
if (!plot) return;      // close() 已清空 / 已切到磁力视图：这一代内容没了，别再往空节点写
if (list === null) { plot.textContent = '简介加载失败，请重试'; return; }  // 分片拉不到，与「记录不存在」区分
rec = (list || []).find(function (x) { return x.id === id; });
if (!rec) { plot.textContent = '暂无详细资料'; return; }
var pv = splitPlot(rec.overview, rec.overview_ja);
plot.textContent = pv.zh;
var sect = plot.parentNode, oldJa = sect ? sect.querySelector('.plot-ja') : null;
if (oldJa) sect.removeChild(oldJa);
if (pv.ja && sect) sect.insertAdjacentHTML('beforeend', plotJaHtml(pv.ja));
renderTags(rec, host.querySelector('#tags'));
var meta = [];
if (Array.isArray(rec.rc) && rec.rc.length === 10 && !host.querySelector('#rdist')) {
var prt = host.querySelector('#prt');
if (prt) {
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
prt.appendChild(div);
}
}
if (Array.isArray(rec.ch) && rec.ch.length) {
var chars = host.querySelector('#sect-chars');
if (chars) {
chars.innerHTML = '<div class="sec-h"><h2>角色</h2></div><div class="chgrid">'
+ rec.ch.map(function (c) {
var av = avatarSrc(c[2]);
var nm = esc(c[0]);
return '<div class="chcard"><span class="ph">'
+ '<span class="chin">' + esc(Array.from(String(c[0] == null ? '' : c[0]))[0] || '?') + '</span>'
+ (av ? '<img class="chav" src="' + esc(av) + '" alt="" referrerpolicy="no-referrer" loading="lazy" decoding="async" onerror="this.remove()">' : '')
+ '</span>'
+ '<div class="chinfo"><b>' + nm + '</b><em>' + esc(c[1]) + '</em></div></div>';
}).join('') + '</div>';
chars.hidden = false;
}
}
if (Array.isArray(rec.st) && rec.st.length) {
var staff = host.querySelector('#sect-staff');
if (staff) {
staff.innerHTML = '<div class="sec-h"><h2>制作人员</h2></div><div class="staffgrid">'
+ rec.st.map(function (p2) {
return '<div class="staff"><b>' + esc(p2[0]) + '</b>'
+ (p2[1] ? '<em>' + esc(p2[1]) + '</em>' : '') + '</div>';
}).join('') + '</div>';
staff.hidden = false;
}
}
if (Array.isArray(rec.co) && rec.co.some(Boolean)) {
var cos = host.querySelectorAll('.mcollect b');
for (var ci = 0; ci < cos.length && ci < 3; ci++) {
cos[ci].textContent = rec.co[ci] == null ? '—' : String(rec.co[ci]);
}
}
if (rec.votes) meta.push(rec.votes + ' 人评分');
if (rec.rank) {
var total = ANI.rows.length || 1;
var pct = Math.max(0.1, (rec.rank / total) * 100);
meta.push('排名 #' + rec.rank + (pct < 20 ? '（前 ' + pct.toFixed(1) + '%）' : ''));
}
var mv = host.querySelector('#mvotes'); if (mv) mv.textContent = meta.join(' · ');
});
}
function close() {
if (PAGE === 'detail') return;
var m = $('#modal');
if (m) {
var tr = m.querySelectorAll('.trailer');
for (var i = 0; i < tr.length; i++) { if (tr[i].parentNode) tr[i].parentNode.removeChild(tr[i]); }
m.innerHTML = '';
}
$('#mask').classList.remove('on');
try {
if (/[?&]id=/.test(location.search)) {
var rest = location.search.replace(/([?&])id=[^&]*&?/, '$1').replace(/[?&]$/, '');
history.replaceState(null, '', location.pathname + rest);
}
} catch (e) { /* 同上：地址栏清理失败不影响关闭 */ }
}
function openMagView(id, name, epsN) {
var m = $('#modal');
var api = window.__epsApi;
if (!m || !api) return;
m.innerHTML = '<button class="x" type="button" aria-label="关闭">×</button>'
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
var h = '';
h += window.__epsApi.epsListHtml(entry);
body.innerHTML = h || '<div class="eps-none">暂无按集索引</div>';
}).catch(fail);
}
var QP_BASE = 'https://120.48.56.189';
var QP_FID_KEY = 'qp_fid';             // {"<bgm id>:<ep>": {fid,name,size,ts}}
var QP_FID_TTL = 60 * 60 * 1000;       // fid 缓存 1h：文件不会每分钟改名，地址才会过期
var QP_TIMER = 0;                      // 挂起的转码 / 转存轮询（模块级：新播放 / 关播放器都要能掐掉）
var QP_GEN = 0;                        // 每次开播自增：异步回调据此判断自己是否已被后来的一次播放取代
window.__qpAbort = function () { QP_GEN += 1; };
function qpReq(method, path, tk, body, keepalive) {
var opt = { method: method, headers: { authorization: 'Bearer ' + tk } };
if (body != null) {
opt.headers['content-type'] = 'application/json';
opt.body = JSON.stringify(body);
}
if (keepalive) opt.keepalive = true;      // pagehide 时普通请求会被浏览器掐掉
return fetch(QP_BASE + path, opt).then(function (res) {
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
}).then(null, function () { return { state: 'error' }; });
}
function qpJson(path, tk) { return qpReq('GET', path, tk, null, false); }
function qpPost(path, tk, body, keepalive) { return qpReq('POST', path, tk, body, keepalive); }
function qpCacheAll() {
try {
var v = JSON.parse(localStorage.getItem(QP_FID_KEY) || '{}');
return v && typeof v === 'object' && Object.prototype.toString.call(v) !== '[object Array]' ? v : {};
} catch (e) { return {}; }
}
function qpCacheGet(id, ep) {
var c = qpCacheAll()[String(id) + ':' + String(ep)];
if (!c || !c.fid) return null;
if (!(Date.now() - Number(c.ts) < QP_FID_TTL)) return null;
return c;
}
function qpCachePut(id, ep, rec) {
var all = qpCacheAll(), k = String(id) + ':' + String(ep), now = Date.now(), out = {};
all[k] = { fid: String(rec.fid), name: String(rec.name || ''), size: Number(rec.size) || 0, ts: now };
Object.keys(all).forEach(function (key) {             // 顺手清掉过期项，别让缓存无限长
var r = all[key];
if (r && now - Number(r.ts) < QP_FID_TTL) out[key] = r;
});
try { localStorage.setItem(QP_FID_KEY, JSON.stringify(out)); } catch (e) { /* 忽略 */ }
}
var QP_EP_RES = [
/[Ss]\d{1,2}\s*[Ee](\d{1,3})/,                 // S01E03
/第\s*(\d{1,3})\s*[话話集期]/,                   // 第3话 / 第3集
/\[(\d{1,3})(?:v\d)?\]/,                       // [03] / [03v2]
/(?:^|[^0-9A-Za-z])[Ee][Pp]?(\d{1,3})(?![0-9])/, // E03 / EP03
/_(\d{1,3})(?![0-9])/,                         // _03
/[-–—]\s*(\d{1,3})(?![0-9])/                   // - 03
];
function qpEpNo(name) {
var s = String(name || '');
for (var i = 0; i < QP_EP_RES.length; i++) {
var m = QP_EP_RES[i].exec(s);
if (!m) continue;
var n = Number(m[1]);
if (n > 0 && n < 1000) return n;              // 1080 / 264 这类不会进（前面限了位数与后缀）
}
return 0;
}
function qpStripSeason(s) {
return String(s || '')
.replace(/第[一二三四五六七八九十0-9]{1,2}[季期部]/g, '')
.replace(/season\s*[0-9]{1,2}/g, '')
.replace(/[0-9]{1,2}(?:nd|rd|st|th)season/g, '')
.replace(/s[0-9]{1,2}(?![0-9])/g, '');
}
function qpContains(hay, needle) {
if (!hay || !needle) return false;
if (hay.indexOf(needle) >= 0) return true;
return hay.length >= 4 && needle.length >= 4 && needle.indexOf(hay) >= 0
&& hay.length >= needle.length * 0.6;
}
function qpTitleOk(name, title) {
var nt = nrm(name), tt = nrm(title);
if (!nt || !tt) return false;
if (qpContains(nt, tt)) return true;
return qpContains(qpStripSeason(nt), qpStripSeason(tt));
}
function qpPickEp(items, title, ep) {
var list = items || [], best = null, single = null;
for (var i = 0; i < list.length; i++) {
var it = list[i];
if (!it || it.fid == null || it.fid === '') continue;
var name = String(it.name || '');
if (!qpTitleOk(name, title)) continue;
var ne = qpEpNo(name);
if (ne === ep) {
if (!best || Number(it.size) > Number(best.size)) best = it;
} else if (!ne) {
single = single || it;
}
}
if (best) return best;
if (list.length === 1 && single) return single;
return null;
}
function qpEpList(entry) {
if (!entry || !entry.eps || typeof entry.eps !== 'object') return [];
var out = [];
Object.keys(entry.eps).forEach(function (k) {
var n = Number(k);
if (!(n > 0) || n !== Math.floor(n)) return;
var cands = entry.eps[k] || [], mag = '', bestSize = -1;
(cands || []).forEach(function (c) {
var m = String((c && (c.m || c.magnet)) || '');
if (m.indexOf('magnet:') !== 0) return;
var sz = Number(c && c.s) || 0;
if (sz > bestSize) { bestSize = sz; mag = m; }
});
out.push({ ep: n, label: (n < 10 ? '0' : '') + n, magnet: mag });
});
out.sort(function (a, b) { return a.ep - b.ep; });
return out;
}
function qpHasEp(list, ep) {
for (var i = 0; i < list.length; i++) if (Number(list[i].ep) === Number(ep)) return true;
return false;
}
function qpEpAt(list, ep) {
for (var i = 0; i < list.length; i++) if (Number(list[i].ep) === Number(ep)) return list[i];
return null;
}
function qpCopy(text) {
var api = window.__epsApi;
if (api && typeof api.copyText === 'function') { api.copyText(text); return; }
try {
if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
} catch (e) { /* 非安全上下文：无从复制，保持静默 */ }
}
function openQuarkPlay(m, id, title) {
if (!m || !window.QPlayer) return;
var tk = followToken();                       // 20-state.js：读 localStorage.gh_token
var gen = ++QP_GEN;                           // 换代：上一代在飞的请求与轮询全部作废
if (QP_TIMER) { clearTimeout(QP_TIMER); QP_TIMER = 0; }
var saved = null;
try { saved = window.__prog && typeof window.__prog.get === 'function' ? window.__prog.get(id) : null; }
catch (e) { saved = null; }
var S = {
m: m,
id: String(id),
title: String(title || ''),
tk: tk,
gen: gen,
tok: 0,
ep: saved && Number(saved.ep) > 0 ? Number(saved.ep) : 1,
startAt: saved && Number(saved.pos) > 0 ? Number(saved.pos) : 0,
fid: '',
name: '',
size: 0,
entry: null,
eps: [],
epsHint: ''
};
S.tok = QPlayer.open({
m: m,
id: S.id,
title: S.title,
ep: S.ep,
sources: [],                                // 官方源要等 find + url，先给空数组
startAt: S.startAt,
onProgress: function (p) { qpReport(S, p); },
onPickEp: function (ep) { if (qpAlive(S)) qpSetEp(S, ep); },
onNext: function () { qpNext(S); },
onEnded: function () { qpNext(S); },
onRetry: function () { if (qpAlive(S)) qpResolve(S); }
});
if (!tk) {
QPlayer.state('login', { msg: '登录后才能使用夸克网盘播放' });
return;
}
qpLoadEps(S).then(function () {
if (!qpAlive(S)) return;
qpResolve(S);
});
}
function qpAlive(S) {
return !!(S && S.gen === QP_GEN && S.tok && window.QPlayer && window.QPlayer.isCurrent(S.tok));
}
function qpLoadEps(S) {
var api = window.__epsApi;
if (!api || typeof api.resolveEntry !== 'function') {
S.epsHint = '选集信息不可用';
QPlayer.setEpisodes([], S.ep, S.epsHint);
return Promise.resolve(null);
}
return api.resolveEntry(S.title, S.id).then(function (entry) {
if (!qpAlive(S)) return null;
S.entry = entry || null;
S.eps = qpEpList(entry);
if (S.eps.length && !qpHasEp(S.eps, S.ep)) S.ep = S.eps[0].ep;
S.epsHint = S.eps.length ? '' : '暂无按集索引（可在「线路」里自备播放地址）';
QPlayer.setEpisodes(S.eps, S.ep, S.epsHint);
return entry;
}, function () {
if (!qpAlive(S)) return null;
S.eps = [];
S.epsHint = '选集信息加载失败，仍可在线路里自备源';
QPlayer.setEpisodes([], S.ep, S.epsHint);
return null;
});
}
function qpSetEp(S, ep) {
if (!qpAlive(S)) return;
QPlayer.pause();                              // 先把旧集的进度按旧 ep / 旧 fid 落盘，再改这两个字段
S.ep = Number(ep) > 0 ? Number(ep) : S.ep;
S.startAt = 0;                                // 换集不续播：上一集的秒数是另一条视频的
S.fid = '';
QPlayer.setFid('');
QPlayer.setEpisodes(S.eps, S.ep, S.epsHint);
if (QP_TIMER) { clearTimeout(QP_TIMER); QP_TIMER = 0; }
qpResolve(S);
}
function qpNext(S) {
if (!qpAlive(S)) return;
var i = -1;
for (var k = 0; k < S.eps.length; k++) if (Number(S.eps[k].ep) === Number(S.ep)) i = k;
if (i < 0 || i + 1 >= S.eps.length) return;   // 没有下一集：不弹任何东西
qpSetEp(S, S.eps[i + 1].ep);
}
function qpResolve(S) {
if (!qpAlive(S)) return;
S.fid = '';
S.name = '';
S.size = 0;
QPlayer.setFid('');
var hit = qpCacheGet(S.id, S.ep);
if (hit) {
S.fid = String(hit.fid);
S.name = String(hit.name || '');
S.size = Number(hit.size) || 0;
QPlayer.setFid(S.fid);
QPlayer.state('loading', { msg: '正在获取播放地址…' });
qpAskUrl(S, 0);
return;
}
QPlayer.state('loading', { msg: '正在网盘里查找第 ' + S.ep + ' 集…' });
qpJson('/tvplay/find?q=' + encodeURIComponent(S.title) + '&limit=20', S.tk).then(function (j) {
if (!qpAlive(S)) return;
if (j.state === 'found') {
var pick = qpPickEp(j.items || [], S.title, S.ep);
if (!pick) { qpNotFound(S, '网盘里没有匹配第 ' + S.ep + ' 集的文件'); return; }
S.fid = String(pick.fid);
S.name = String(pick.name || '');
S.size = Number(pick.size) || 0;
QPlayer.setFid(S.fid);
qpCachePut(S.id, S.ep, { fid: S.fid, name: S.name, size: S.size });
QPlayer.state('loading', { msg: '找到「' + (S.name || '文件') + '」，正在获取地址…' });
qpAskUrl(S, 0);
return;
}
if (j.state === 'none') { qpNotFound(S, '夸克网盘里还没有这一集'); return; }
if (j.state === 'need_rebind') { QPlayer.state('rebind'); return; }
if (j.state === 'unauthorized') { QPlayer.state('login'); return; }
QPlayer.state('error', { msg: '播放服务暂时不可用' });
});
}
function qpAskUrl(S, tries) {
if (!qpAlive(S)) return;
if (!S.fid) { QPlayer.state('error', { msg: '缺少文件 id，请重试' }); return; }
if (tries > 10) { QPlayer.state('error', { msg: '转码超时，稍后再试' }); return; }
qpJson('/tvplay/url?fid=' + encodeURIComponent(S.fid) + '&wait=45', S.tk).then(function (j) {
if (!qpAlive(S)) return;
if (j.state === 'ready' && j.url) {
QPlayer.play(String(j.url), '夸克网盘', { fid: S.fid, startAt: S.startAt });
S.startAt = 0;                            // 续播只作用于这一次；重试时不该再跳回老位置
return;
}
if (j.state === 'transcoding') {
QPlayer.state('transcoding', { msg: '转码中… 约 1 分钟（' + (tries + 1) + '/10）' });
var wait = Number(j.retry_after);
if (!(wait > 0)) wait = 5;
QP_TIMER = setTimeout(function () {
QP_TIMER = 0;
if (!qpAlive(S)) return;               // 弹窗已关 / 已换集：不再排下一轮
qpAskUrl(S, tries + 1);
}, Math.min(wait, 60) * 1000);
return;
}
if (j.state === 'need_rebind') { QPlayer.state('rebind'); return; }
if (j.state === 'unauthorized') { QPlayer.state('login'); return; }
QPlayer.state('error', { msg: '播放服务暂时不可用' });
});
}
function qpNotFound(S, msg) {
var actions = [];
var epInfo = qpEpAt(S.eps, S.ep);
if (epInfo && epInfo.magnet) {
actions.push({ label: '复制磁力', fn: function () { qpCopy(epInfo.magnet); } });
actions.push({ label: '离线转存到网盘', fn: function () { qpAddMagnet(S, epInfo.magnet); } });
}
actions.push({ label: '重试', fn: function () { qpResolve(S); } });
QPlayer.state('none', {
msg: msg + '。可以粘贴自备播放地址，或复制磁力到夸克离线下载后再试。',
actions: actions
});
}
function qpAddMagnet(S, magnet) {
if (!qpAlive(S)) return;
QPlayer.state('transcoding', { msg: '正在提交离线转存…' });
qpPost('/tvplay/add', S.tk, { magnet: magnet, title: S.title, ep: String(S.ep) }).then(function (j) {
if (!qpAlive(S)) return;
if (j.state === 'queued' && j.task_id) { qpPollTask(S, String(j.task_id), 0); return; }
if (j.state === 'no_quota') { QPlayer.state('quota', { msg: '网盘离线空间已满，清理后再试' }); return; }
if (j.state === 'duplicate') {
QPlayer.state('transcoding', { msg: '网盘里已有这个任务，正在查找文件…' });
QP_TIMER = setTimeout(function () {
QP_TIMER = 0;
if (qpAlive(S)) qpResolve(S);
}, 4000);
return;
}
if (j.state === 'need_rebind') { QPlayer.state('rebind'); return; }
if (j.state === 'unauthorized') { QPlayer.state('login'); return; }
QPlayer.state('error', { msg: '离线转存失败' + (j.msg ? '：' + j.msg : '') });
});
}
function qpPollTask(S, taskId, n) {
if (!qpAlive(S)) return;
if (n > 40) { QPlayer.state('error', { msg: '离线转存超时，稍后去网盘里看看' }); return; }
qpJson('/tvplay/task?id=' + encodeURIComponent(taskId), S.tk).then(function (j) {
if (!qpAlive(S)) return;
if (j.state === 'ready' && j.fid) {
S.fid = String(j.fid);
S.name = String(j.name || '');
S.size = Number(j.size) || 0;
QPlayer.setFid(S.fid);
qpCachePut(S.id, S.ep, { fid: S.fid, name: S.name, size: S.size });
qpAskUrl(S, 0);
return;
}
if (j.state === 'pending' || j.state === 'queued') {
QPlayer.state('transcoding', { msg: '离线转存中… ' + (Number(j.progress) || 0) + '%' });
QP_TIMER = setTimeout(function () {
QP_TIMER = 0;
qpPollTask(S, taskId, n + 1);
}, 3000);
return;
}
if (j.state === 'need_rebind') { QPlayer.state('rebind'); return; }
if (j.state === 'unauthorized') { QPlayer.state('login'); return; }
QPlayer.state('error', { msg: '离线转存失败，稍后去网盘里看看' });
});
}
function qpReport(S, p) {
if (!p) return;
var ep = Number(p.ep) > 0 ? Number(p.ep) : S.ep;
var fid = String(p.fid || '');
var pos = Math.max(0, Number(p.pos) || 0);
var dur = Math.max(0, Number(p.dur) || 0);
if (window.__prog && typeof window.__prog.report === 'function') {
try { window.__prog.report(S.id, ep, { fid: fid, pos: pos, dur: dur }); } catch (e) { /* 忽略 */ }
}
if (!fid) return;                             // 没有 fid 时后端无法定位记录
qpPost('/tvplay/share/progress', S.tk, { fid: fid, pos: pos, dur: dur }, !!p.final)
.then(function (j) {
if (j && j.state === 'unauthorized' && qpAlive(S)) QPlayer.state('login');
}, function () { /* 静默 */ });
}
window.__qp = openQuarkPlay;
var QPlayer = (function () {
var CUR = null;                            // {gen, m, ctx, ep, fid, last}
var GEN = 0;
var REPORT_EVERY = 8000;                   // timeupdate 节流：8s 上报一次进度
function slot() {
var m = CUR && CUR.m;
return (m && m.querySelector) ? (m.querySelector('#dpPlayer') || m) : null;
}
function esc(s) {
return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
});
}
function clear() {
var s = slot();
if (s) s.innerHTML = '';
}
function report(pos, dur, final) {
if (!CUR || !CUR.ctx || typeof CUR.ctx.onProgress !== 'function') return;
try {
CUR.ctx.onProgress({ ep: CUR.ep, fid: CUR.fid, pos: Math.max(0, pos || 0), dur: Math.max(0, dur || 0), final: !!final });
} catch (e) { /* 上报失败不影响播放 */ }
CUR.last = Date.now();
}
function status(html) {
var s = slot();
if (!s) return;
s.innerHTML = '<div class="nv-status">' + html + '</div>';
}
function stHtml(kind, opt) {
opt = opt || {};
var msg = esc(opt.msg || '');
var btns = '';
if (kind === 'login') {
btns = '<button class="btn pri" id="nvLogin" type="button">登录</button>';
} else if (kind === 'rebind') {
btns = '<button class="btn pri" id="nvRebind" type="button">重新绑定夸克</button>';
} else if (kind === 'error' && CUR && CUR.ctx && typeof CUR.ctx.onRetry === 'function') {
btns = '<button class="btn" id="nvRetry" type="button">重试</button>';
}
var acts = (opt.actions || []).map(function (a, i) {
return '<button class="btn' + (i === 0 ? ' pri' : '') + '" data-nv-act="' + i + '" type="button">' + esc(a.label || '') + '</button>';
}).join('');
return '<p class="nv-msg">' + msg + '</p>' + (acts || btns ? '<div class="nv-acts">' + acts + btns + '</div>' : '');
}
function wireStatus(kind, opt) {
var s = slot();
if (!s) return;
if (kind === 'login') {
var l = s.querySelector('#nvLogin');
if (l) l.onclick = function () { if (typeof window.__openLogin === 'function') window.__openLogin('email'); };
} else if (kind === 'rebind') {
var r = s.querySelector('#nvRebind');
if (r) r.onclick = function () {
if (typeof quarkBindUrl === 'function') { window.open(quarkBindUrl(), '_blank', 'noopener'); return; }
window.location.href = '/user';
};
} else if (kind === 'error' && opt && !opt.actions) {
var t = s.querySelector('#nvRetry');
if (t && CUR && CUR.ctx && typeof CUR.ctx.onRetry === 'function') t.onclick = function () { CUR.ctx.onRetry(); };
}
var acts = (opt && opt.actions) || [];
if (acts.length) {
[].forEach.call(s.querySelectorAll('[data-nv-act]'), function (b) {
b.onclick = function () { var a = acts[Number(b.getAttribute('data-nv-act'))]; if (a && typeof a.fn === 'function') a.fn(); };
});
}
}
function renderEps() {
var s = slot();
if (!s || !CUR) return;
var row = s.querySelector('.nv-eps');
var list = CUR.eps || [];
if (!row || !list.length) return;
row.innerHTML = list.map(function (x) {
var on = Number(x.ep) === Number(CUR.ep) ? ' on' : '';
return '<button class="nv-ep' + on + '" type="button" data-ep="' + Number(x.ep) + '">' + Number(x.ep) + '</button>';
}).join('');
[].forEach.call(row.querySelectorAll('.nv-ep'), function (b) {
b.onclick = function () {
var ep = Number(b.getAttribute('data-ep'));
if (CUR && CUR.ctx && typeof CUR.ctx.onPickEp === 'function') CUR.ctx.onPickEp(ep);
};
});
}
function mountVideo(url, startAt) {
var s = slot();
if (!s || !CUR) return;
clear();
var v = document.createElement('video');
v.setAttribute('controls', '');
v.setAttribute('autoplay', '');
v.setAttribute('playsinline', '');
v.src = url;
if (startAt > 0) v.currentTime = startAt;   // loadedmetadata 前赋值也能生效
v.style.width = '100%';
v.style.aspectRatio = '16 / 9';
v.style.background = '#000';
v.style.display = 'block';
s.appendChild(v);
var epsRow = document.createElement('div');
epsRow.className = 'nv-eps';
s.appendChild(epsRow);
renderEps();
CUR.last = 0;
v.addEventListener('loadedmetadata', function () {
if (startAt > 0) { try { v.currentTime = startAt; } catch (e) { } }
});
v.addEventListener('timeupdate', function () {
if (!CUR) return;
if (Date.now() - CUR.last < REPORT_EVERY) return;
report(v.currentTime, v.duration || 0, false);
});
v.addEventListener('pause', function () {
if (CUR) report(v.currentTime, v.duration || 0, false);
});
v.addEventListener('ended', function () {
report(v.duration, v.duration, true);
if (CUR && CUR.ctx && typeof CUR.ctx.onEnded === 'function') CUR.ctx.onEnded();
});
v.addEventListener('error', function () {
if (!CUR) return;
status(stHtml('error', { msg: '视频加载失败（网络或源已过期）' }));
wireStatus('error');
if (CUR.ctx && typeof CUR.ctx.onRetry === 'function') { /* 重试按钮已给 */ }
});
}
return {
open: function (ctx) {
GEN += 1;
CUR = { gen: GEN, m: ctx.m, ctx: ctx, ep: Number(ctx.ep) > 0 ? Number(ctx.ep) : 1, fid: '', last: 0, eps: [] };
clear();
status(stHtml('loading', { msg: '准备中…' }));
return { gen: GEN };
},
state: function (kind, opt) {
if (!CUR) return;
status(stHtml(kind, opt));
wireStatus(kind, opt);
renderEps();
},
setEpisodes: function (list, ep, hint) {
if (!CUR) return;
CUR.eps = list || [];
if (Number(ep) > 0) CUR.ep = Number(ep);
var s = slot();
if (!s) return;
var row = s.querySelector('.nv-eps');
if (!row) {
row = document.createElement('div');
row.className = 'nv-eps';
s.appendChild(row);
}
if (hint && !CUR.eps.length) {
row.innerHTML = '<span class="nv-hint">' + esc(hint) + '</span>';
} else {
renderEps();
}
},
setFid: function (fid) { if (CUR) CUR.fid = String(fid || ''); },
pause: function () {
var s = slot();
var v = s && s.querySelector('video');
if (v && !v.paused) { try { v.pause(); } catch (e) { } }
if (CUR && CUR.last) report((slot() && slot().querySelector('video') || {}).currentTime || 0, (slot() && slot().querySelector('video') || {}).duration || 0, false);
},
play: function (url, label, opt) {
if (!CUR || !url) return;
mountVideo(url, (opt && Number(opt.startAt)) || 0);
},
isCurrent: function (tok) { return !!(tok && CUR && tok.gen === CUR.gen); },
close: function () {
if (CUR) { try { report(0, 0, false); } catch (e) { } }
CUR = null;
clear();
}
};
})();
window.QPlayer = QPlayer;
var SRC_BASE = 'https://120.48.56.189';
var SRC_TTL = 60 * 1000;                       // 探测结果缓存时长
var SRC_USER = '/user';                       // B 站绑定在个人主页
var SRC_KEYS = ['yt', 'bili', 'magnet'];
var SRC_NAME = { yt: 'YouTube 官方', bili: 'B 站', magnet: '网盘' };
var SRC_BIND = { bili: '登录高清', magnet: '绑定网盘' };
var SRC_MEM = {};                              // "<id>:<ep>" -> {ts, data, pend}
var SRC_MGEN = 0;                              // 每 mount 一次自增：异步结果只落最新那一代
function srcToken() {
try { return localStorage.getItem('gh_token') || ''; } catch (e) { return ''; }
}
function srcGet(path, tk) {
var headers = {};
if (tk) headers.authorization = 'Bearer ' + tk;
var ctl = typeof AbortController === 'function' ? new AbortController() : null;
var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 15000);
var opt = { method: 'GET', headers: headers };
if (ctl) opt.signal = ctl.signal;
return fetch(SRC_BASE + path, opt).then(function (r) {
clearTimeout(timer);
return r.text().then(function (t) {
var j = null;
try { j = JSON.parse(t); } catch (e) { j = null; }
if (!j || typeof j !== 'object') j = {};
return { status: Number(r.status) || 0, ok: !!r.ok, j: j };
});
}, function () {
clearTimeout(timer);
return { status: 0, ok: false, j: {} };
});
}
function srcProbeBili(tk, title) {
var pgcP = (typeof srcPgc === 'function') ? srcPgc(title) : Promise.resolve(null);
return Promise.all([srcGet('/bili/bind', tk), pgcP]).then(function (pair) {
var r = pair[0], j = (r && r.j) || {}, pgc = pair[1];
var kind;
if (r && r.ok && j.ok && j.bound) {
kind = { kind: 'bound', uname: String(j.uname || '已绑定'), vip: Number(j.vip_type) || 0 };
} else if (r && (r.status === 404 || r.status === 401)) {
kind = { kind: 'unbound' };
} else if (j.bound === false || j.error === 'not_bound' || j.ok === false) {
kind = { kind: 'unbound' };
} else {
kind = { kind: 'error' };
}
if (pgc) { kind.pgc = pgc; if (kind.kind === 'error') kind.kind = 'unbound'; }
return kind;
});
}
function srcProbeMagnet(title, id, ep) {
var api = window.__epsApi;
if (!api || typeof api.resolveEntry !== 'function') return Promise.resolve({ kind: 'none' });
return api.resolveEntry(title, id).then(function (entry) {
var list = typeof qpEpList === 'function' ? qpEpList(entry) : [];
for (var i = 0; i < list.length; i++) {
if (Number(list[i].ep) === Number(ep) && list[i].magnet) return { kind: 'has' };
}
return { kind: 'none' };
}, function () { return { kind: 'error' }; });
}
function srcYtEps(id) {
var ex = (typeof ANI !== 'undefined' && ANI.extra) ? ANI.extra[id] : null;
var eps = ex && ex[4];
return (eps && eps.length) ? eps : null;
}
function srcFrame(src, allow) {
return '<div class="dpv-frame"><iframe src="' + src + '"'
+ ' allow="' + (allow || 'autoplay; encrypted-media; fullscreen; picture-in-picture') + '"'
+ ' allowfullscreen scrolling="no" frameborder="no"'
+ ' referrerpolicy="origin-when-cross-origin"></iframe></div>';
}
function ytKey(url) {
var m = /[?&]v=([\w-]{6,})/.exec(url || '') || /youtu\.be\/([\w-]{6,})/.exec(url || '');
return m ? m[1] : '';
}
function srcEmbedYT(box, url, ep, cn) {
var key = ytKey(url);
if (!key) return false;
var slot = box.querySelector('#dpPlayer') || box;
if (window.__qpAbort === 'function') window.__qpAbort();
if (window.__biliAbort === 'function') window.__biliAbort();
if (window.QPlayer && typeof window.QPlayer.close === 'function') window.QPlayer.close();
slot.innerHTML = srcFrame('https://www.youtube-nocookie.com/embed/'
+ encodeURIComponent(key) + '?autoplay=1&rel=0&modestbranding=1');
srcHint(box, cn === 1
? 'YouTube 官方频道 · 本集中国大陆可直连播放'
: 'YouTube 官方频道 · 本集需港澳台/东南亚出口（B 站源不受地区限制）');
return true;
}
function srcEmbedBvid(box, bvid) {
if (!bvid) return false;
if (window.__qpAbort === 'function') window.__qpAbort();
if (window.__biliAbort === 'function') window.__biliAbort();
if (window.QPlayer && typeof window.QPlayer.close === 'function') window.QPlayer.close();
var slot = box.querySelector('#dpPlayer') || box;
slot.innerHTML = srcFrame('https://player.bilibili.com/player.html?bvid='
+ encodeURIComponent(bvid) + '&page=1&high_quality=1&danmaku=1&autoplay=1');
srcHint(box, 'B 站官方播放器 · 登录 B 站后本页即可看更高清晰度');
return true;
}
function srcEmbedPgc(box, sid, ep, epNo) {
if (!box || !sid || !ep || !ep.id) return false;
if (window.__qpAbort === 'function') window.__qpAbort();
if (window.__biliAbort === 'function') window.__biliAbort();
if (window.QPlayer && typeof window.QPlayer.close === 'function') window.QPlayer.close();
var slot = box.querySelector('#dpPlayer') || box;
slot.innerHTML = srcFrame('https://player.bilibili.com/player.html?episodeId='
+ encodeURIComponent(ep.id) + '&seasonId=' + encodeURIComponent(sid)
+ '&autoplay=1&high_quality=1&danmaku=1');
srcHint(box, 'B 站官方番剧 · 第 ' + epNo + ' 集（免费集，免登录）');
return true;
}
function srcPgc(title) {
if (typeof biliGet !== 'function') return Promise.resolve(null);
return biliGet('pgc', { t: title }).then(function (d) {
return (d && d.ok && d.found && d.sid && (d.eps || []).length) ? d : null;
}, function () { return null; });
}
function srcEmbedBili(box, id) {
var exb = (typeof ANI !== 'undefined' && ANI.extra) ? ANI.extra[id] : null;
return srcEmbedBvid(box, exb && exb[5]);
}
function biliFindBvid(title) {
if (typeof biliGet !== 'function') return Promise.reject(new Error('no biliGet'));
return biliGet('find', { t: title }).then(function (f) {
if (!f || !f.found || !f.bvid) return '';
var t = String(f.title || '');
if (typeof BILI_NOISE === 'object' && BILI_NOISE.test && BILI_NOISE.test(t)) return '';
return String(f.bvid);
}, function () { return ''; });
}
var YT_REACH = null;
function ytReach() {
if (YT_REACH) return YT_REACH;
YT_REACH = new Promise(function (resolve) {
var done = false;
function fin(ok) { if (!done) { done = true; resolve(ok); } }
var ctl = typeof AbortController === 'function' ? new AbortController() : null;
var timer = setTimeout(function () { if (ctl) ctl.abort(); fin(false); }, 1800);
try {
fetch('https://www.youtube.com/generate_204', {
mode: 'no-cors', cache: 'no-store', signal: ctl ? ctl.signal : undefined
}).then(function () { clearTimeout(timer); fin(true); },
function () { clearTimeout(timer); fin(false); });
} catch (e) { clearTimeout(timer); fin(false); }
});
setTimeout(function () { YT_REACH = null; }, 10 * 60 * 1000);   // 10 分钟后重新探
return YT_REACH;
}
function srcStart(box, id, title, ep) {
var epNo = Math.max(1, Math.floor(Number(ep) || 1));
var slot = box.querySelector('#dpPlayer') || box;
var tk = (typeof authToken === 'function') ? authToken() : '';
function toQuark(why) {
srcHint(box, why + ' · 使用网盘源');
if (typeof openQuarkPlay === 'function') openQuarkPlay(slot, id, title);
if (!tk && typeof openAuthPanel === 'function') openAuthPanel('email');
}
function toYoutube(why) {
var eps = srcYtEps(id);
if (!eps) { toQuark(why + ' · 无官方正片'); return; }
var idx = Math.max(0, Math.min(eps.length - 1, epNo - 1));
srcHint(box, why + ' · 检测 YouTube 可达性…');
ytReach().then(function (ok) {
var pick = eps[idx] || [];
if (ok && srcEmbedYT(box, pick[1], epNo, pick[2])) return;
toQuark(why + ' · YouTube 不可达');
});
}
srcHint(box, '正在匹配 B 站官方番剧…');
srcPgc(title).then(function (p) {
if (p) {
var row = p.eps[Math.max(0, epNo - 1)] || p.eps[0];
if (row && !row.vip && srcEmbedPgc(box, p.sid, row, epNo)) return;
if (row && row.vip) {
srcHint(box, '第 ' + epNo + ' 集是 B 站大会员集（仅试看）· 已换下一个源');
}
}
if (srcEmbedBili(box, id)) return;
srcHint(box, '正在 B 站搜索「' + title + '」…');
biliFindBvid(title).then(function (bv) {
if (bv && srcEmbedBvid(box, bv)) return;
toYoutube('B 站未找到');
}, function () { toYoutube('B 站搜索失败'); });
});
return true;
}
window.__srcStart = srcStart;          // 65-detail 的「开始观看」用
function srcProbe(id, title, ep, force) {
var key = String(id) + ':' + String(ep);
var now = Date.now(), mem = SRC_MEM[key];
if (!force && mem && now - mem.ts < SRC_TTL) return mem.pend || Promise.resolve(mem.data);
var rec = { ts: now, data: null, pend: null };
SRC_MEM[key] = rec;
var tk = srcToken();
var ytEps = srcYtEps(id);
rec.pend = Promise.all([
Promise.resolve(ytEps ? { kind: 'has', eps: ytEps } : { kind: 'none' }),
srcProbeBili(tk, title),
srcProbeMagnet(title, id, ep)
]).then(function (arr) {
var data = { yt: arr[0], bili: arr[1], magnet: arr[2] };
if (SRC_MEM[key] === rec) { rec.data = data; rec.ts = Date.now(); }   // 代次没被重探顶掉才落缓存
return data;
});
return rec.pend;
}
function srcPanelHtml(id, title, ep) {
var rows = SRC_KEYS.map(function (k) {
return '<span class="qp-line-row" data-row="' + k + '">'
+ '<button class="qp-line" type="button" data-src="' + k + '">'
+ esc(SRC_NAME[k]) + ' · 检测中…</button>'
+ '<button class="btn" type="button" data-act="bind-' + k + '" hidden>'
+ esc(SRC_BIND[k] || '绑定') + '</button>'
+ '</span>';
}).join('');
return '<section class="dp-srcs" data-open="1" data-bgm="' + esc(id) + '">'
+ '<div class="sec-h"><h2>播放源</h2>'
+ '<span class="sec-sub" id="srcHint">按可用性排序</span></div>'
+ '<div class="qp-line-list" id="srcList">' + rows + '</div>'
+ '</section>';
}
function srcCls(el, cls, on) {
if (!el) return;
var parts = String(el.className || '').split(/\s+/), has = false, out = [];
for (var i = 0; i < parts.length; i++) {
if (!parts[i]) continue;
if (parts[i] === cls) { has = true; if (!on) continue; }
out.push(parts[i]);
}
if (on && !has) out.push(cls);
el.className = out.join(' ');
}
function srcRowOf(list, key) {
var rows = list ? list.querySelectorAll('.qp-line-row') : [];
for (var i = 0; i < rows.length; i++) {
if (String(rows[i].getAttribute('data-row') || '') === key) return rows[i];
}
return null;
}
function srcSetRow(list, key, text, opt) {
var row = srcRowOf(list, key);
if (!row) return;
opt = opt || {};
var btn = row.querySelector('.qp-line');
if (btn) {
btn.textContent = text;
srcCls(btn, 'on', !!opt.on);
srcCls(btn, 'is-bad', !!opt.bad);
}
row.setAttribute('data-fail', opt.retry ? '1' : '0');
row.hidden = !!opt.hide;
var bind = row.querySelector('.btn');
if (bind) bind.hidden = !opt.bind;
}
function srcPaint(panel, id, ep, data) {
var list = panel ? panel.querySelector('.qp-line-list') : null;
if (!list) return;
var epNo = Number(ep) > 0 ? Math.floor(Number(ep)) : 1;
var y = data && data.yt;
if (!data) srcSetRow(list, 'yt', 'YouTube 官方 · 检测中…');
else if (y.kind === 'has') {
var cnN = 0;
for (var yi = 0; yi < y.eps.length; yi++) {
if (Array.isArray(y.eps[yi]) && y.eps[yi][2] === 1) cnN++;
}
var ytLabel = 'YouTube 官方 · ' + y.eps.length + ' 集'
+ (cnN === y.eps.length ? '可看' : (cnN ? '可看（' + cnN + ' 集大陆直连）' : '（需港澳台出口）'));
srcSetRow(list, 'yt', ytLabel, { on: true });
}
else srcSetRow(list, 'yt', 'YouTube 官方 · 本季未收录');
var b = data && data.bili;
if (!data) srcSetRow(list, 'bili', 'B 站 · 检测中…');
else if (b.pgc && b.pgc.found) {
var pg = b.pgc.eps || [];
var freeN = 0;
for (var pi = 0; pi < pg.length; pi++) if (!pg[pi].vip) freeN++;
srcSetRow(list, 'bili', 'B 站官方 · 免费 ' + freeN + '/' + pg.length + ' 集',
{ on: freeN > 0, bind: b.kind !== 'bound' });
}
else if (b.kind === 'bound') {
srcSetRow(list, 'bili', 'B 站 · ' + b.uname + '（VIP' + b.vip + '）', { on: true });
}
else if (b.kind === 'unbound') srcSetRow(list, 'bili', 'B 站 · 免登录可看', { on: true, bind: true });
else srcSetRow(list, 'bili', 'B 站 · 检测失败 · 点此重试', { bad: true, retry: true });
var mg = data && data.magnet;
if (!data) srcSetRow(list, 'magnet', '网盘 · 检测中…', { bind: true });
else if (mg.kind === 'has') srcSetRow(list, 'magnet', '网盘 · 第 ' + epNo + ' 集可转存', { on: true, bind: true });
else if (mg.kind === 'none') srcSetRow(list, 'magnet', '网盘 · 本集无资源', { bind: true });
else srcSetRow(list, 'magnet', '网盘 · 检测失败 · 点此重试', { bad: true, retry: true, bind: true });
}
function srcHint(host, text) {
var panel = host && host.querySelector ? host.querySelector('.dp-srcs') : null;
var h = panel ? panel.querySelector('.sec-sub') : null;
if (h) h.textContent = text;
}
function srcMount(host, id, title, ep, force) {
if (!host || !host.querySelector) return;
var panel = host.querySelector('.dp-srcs');
if (!panel) return;
var list = panel.querySelector('.qp-line-list');
if (!list) return;
var epNo = Number(ep) > 0 ? Math.floor(Number(ep)) : 1;
var gen = ++SRC_MGEN;
panel.setAttribute('data-mgen', String(gen));
list.onclick = function (ev) { srcClick(host, list, ev, id, title, epNo); };
srcHint(host, '按可用性排序');
if (!force) {
var key = String(id) + ':' + String(epNo), mem = SRC_MEM[key];
if (mem && mem.data && Date.now() - mem.ts < SRC_TTL) {
srcPaint(panel, id, epNo, mem.data);       // 60s 内二次 mount：不重探、立刻有文案
return;
}
}
srcPaint(panel, id, epNo, null);
srcProbe(id, title, epNo, force).then(function (data) {
if (panel.getAttribute('data-mgen') !== String(gen)) return;   // 已被重探/重画取代
srcPaint(panel, id, epNo, data);
});
}
function srcPanelMount(host, id, title, ep) { srcMount(host, id, title, ep, false); }
function srcOpenUrl(url) {
try {
if (typeof window.open === 'function') {
var w = window.open(url, '_blank', 'noopener');
if (w) return;
}
} catch (e) { /* 被拦截：退化成同页跳转 */ }
try { window.location.href = url; } catch (e2) { /* 忽略 */ }
}
function openQuarkBindPanel() {
if (document.getElementById('qbmask')) return;
if (typeof authToken === 'function' && !authToken()) {
if (typeof openAuthPanel === 'function') openAuthPanel('email');
return;
}
var mask = document.createElement('div');
mask.className = 'authmask qbmask';
mask.id = 'qbmask';
mask.innerHTML = '<div class="authcard qbcard" role="dialog" aria-modal="true">'
+ '<button class="authx" type="button" aria-label="关闭">×</button>'
+ '<h3 class="qbtitle">绑定夸克网盘</h3>'
+ '<p class="qbhint">用夸克 App 扫码，扫完自动绑定（只需一次）。绑定后网盘源可直接播放。</p>'
+ '<div class="qbframe"><iframe src="' + esc(quarkBindUrl('&embed=1')) + '"'
+ ' referrerpolicy="origin-when-cross-origin" allow="clipboard-write"></iframe></div>'
+ '</div>';
document.body.appendChild(mask);
function cleanup() {
if (mask.parentNode) mask.parentNode.removeChild(mask);
window.removeEventListener('message', onMsg);
document.removeEventListener('keydown', onKey);
}
function onMsg(ev) {
if (String(ev.origin).indexOf('120.48.56.189') < 0) return;
var d = ev.data || {};
if (d && d.type === 'quark-bound' && d.ok) {
cleanup();
var host = document.querySelector('#modal') || document;
srcHint(host, '夸克网盘已绑定 · 重探播放源…');
var panel = host.querySelector ? host.querySelector('.dp-srcs') : null;
if (panel) {
var bgm = panel.getAttribute('data-bgm') || '';
srcMount(host, bgm, '', 1, true);       // force 重探
}
}
}
function onKey(ev) { if (ev.key === 'Escape') cleanup(); }
mask.onclick = function (ev) {
var t = ev.target;
if (t === mask || (t && String(t.className || '').indexOf('authx') >= 0)) cleanup();
};
window.addEventListener('message', onMsg);
document.addEventListener('keydown', onKey);
}
function srcClick(host, list, ev, id, title, ep) {
var t = ev && ev.target ? ev.target : null;
while (t && t !== list) {
if (t.getAttribute && (t.getAttribute('data-src') || t.getAttribute('data-act'))) break;
t = t.parentNode;
}
if (!t || t === list) return;
var act = t.getAttribute('data-act');
if (act) {                                    // 绑定入口：只导航，不播放
if (act === 'bind-magnet') {
if (typeof authToken === 'function' && authToken()) openQuarkBindPanel();
else if (typeof openAuthPanel === 'function') openAuthPanel('email');
return;
}
if (act === 'bind-bili') {
if (typeof authToken === 'function' && authToken()) srcOpenUrl(SRC_USER);
else if (typeof openAuthPanel === 'function') openAuthPanel('email');
else srcOpenUrl(SRC_USER);
}
return;
}
var key = t.getAttribute('data-src');
if (!key) return;
var row = t.parentNode;
if (row && String(row.getAttribute('data-fail') || '') === '1') {
srcMount(host, id, title, ep, true);        // 失败行：点一下重探
return;
}
srcPlay(key, host, id, title, ep);
}
function srcPlay(key, m, id, title, ep) {
var epNo = Number(ep) > 0 ? Math.floor(Number(ep)) : 1;
var box = m && m.querySelector ? m : (typeof $ === 'function' ? $('#modal') : null);
if (!box) return;
if (window.QPlayer && typeof window.QPlayer.close === 'function') window.QPlayer.close();
if (typeof window.__qpAbort === 'function') window.__qpAbort();
if (typeof window.__biliAbort === 'function') window.__biliAbort();
if (key === 'yt') {
var eps = srcYtEps(id);
if (!eps) { srcHint(box, '本季没有官方 YouTube 正片'); return; }
var idx = Math.max(0, Math.min(eps.length - 1, epNo - 1));
var pickYt = eps[idx] || [];
srcEmbedYT(box, pickYt[1], epNo, pickYt[2]);
return;
}
if (key === 'bili') {
srcStart(box, id, title, epNo);
return;
}
if (key === 'magnet') {                        // 磁力 → 转存后在线播放（夸克在幕后，不列出）
var q = box.querySelector('#dpPlayer') || box;
if (typeof openQuarkPlay === 'function') openQuarkPlay(q, id, title);
}
}
var BILI = {};          // id -> {bvid, aid, pages:[{page,cid,part}]}
var BILI_P = {};        // id -> 在途的 resolve：同 id 并发共用一次请求
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
if (BILI_P[id]) return BILI_P[id];
var direct = (typeof DATA !== 'undefined' && DATA.bili && DATA.bili[id]) || '';
var p = direct
? biliGet('view', { bvid: direct })
: biliGet('find', { t: title }).then(function (f) {
if (!f || !f.found || !f.bvid) return { ok: false };
return biliGet('view', { bvid: f.bvid });
});
var r = p.then(function (v) {
if (v && v.ok && (v.aid || (v.pages && v.pages.length))) BILI[id] = v;
return (v && v.ok) ? v : null;
}).catch(function () { return null; });
BILI_P[id] = r;
r.then(function () { delete BILI_P[id]; }, function () { delete BILI_P[id]; });
return r;
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
+ sel + '<div class="dmlist"><div class="dmgrid">' + rows + '</div></div>';
}
function renderRp(box, d) {
if (!d || !d.ok) { box.innerHTML = '<div class="mnote">评论取不到（' + ((d && d.error) || '网络') + '）</div>'; return; }
if (!d.items.length) { box.innerHTML = '<div class="mnote">还没有评论</div>'; return; }
box.innerHTML = '<div class="mnote">共 ' + d.total + ' 条 · 来源 B 站</div>'
+ d.items.map(function (it) {
var dt = it.t ? new Date(it.t * 1000) : null;
var day = dt ? (dt.getFullYear() + '-' + ('0' + (dt.getMonth() + 1)).slice(-2) + '-' + ('0' + dt.getDate()).slice(-2)) : '';
return '<div class="rprow' + (it.re === 1 ? ' re' : '') + '">'
+ (it.a ? '<img src="' + esc(it.a) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">'
: '<span class="rpav">' + esc(String(it.u || '匿名').slice(0, 1)) + '</span>')
+ '<div><b>' + esc(it.u || '匿名') + '</b><em>' + day + (it.l ? ' · 赞 ' + it.l : '') + '</em>'
+ '<p>' + esc(it.m) + '</p></div></div>';
}).join('');
}
function biliWhenVisible(box, load) {
if (!box) return;
if (!window.IntersectionObserver) { load(box); return; }
var io = new window.IntersectionObserver(function (es) {
for (var i = 0; i < es.length; i++) {
if (!es[i].isIntersecting) continue;
io.disconnect();
load(box);
return;
}
}, { rootMargin: '200px' });
io.observe(box);
}
function biliLoadDm(box, id, title, year) {
if (!box || box.getAttribute('data-done')) return;
box.setAttribute('data-done', '1');
box.innerHTML = '<div class="mnote">弹幕加载中…</div>';
biliResolve(id, title, year).then(function (v) {
if (!v || !v.pages || !v.pages.length) {
box.innerHTML = '<div class="mnote">未匹配到 B 站源</div>';
return;
}
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
}).catch(function () { box.innerHTML = '<div class="mnote">未匹配到 B 站源</div>'; });
}
function biliLoadRp(box, id, title, year) {
if (!box || box.getAttribute('data-done')) return;
box.setAttribute('data-done', '1');
box.innerHTML = '<div class="mnote">评论加载中…</div>';
biliResolve(id, title, year).then(function (v) {
if (!v || !v.aid) { box.innerHTML = '<div class="mnote">未匹配到 B 站源</div>'; return; }
return biliGet('reply', { aid: v.aid, ps: 20 }).then(function (d) { renderRp(box, d); });
}).catch(function () { box.innerHTML = '<div class="mnote">未匹配到 B 站源</div>'; });
}
function bindBili(id, title, year) {
var m = $('#modal');
if (!m) return;
if (PAGE === 'detail') {
biliWhenVisible(m.querySelector('#pdm'), function (box) { biliLoadDm(box, id, title, year); });
biliWhenVisible(m.querySelector('#prp'), function (box) { biliLoadRp(box, id, title, year); });
return;
}
m.querySelectorAll('.mtab').forEach(function (b) {
b.onclick = function () {
var p = b.getAttribute('data-p');
m.querySelectorAll('.mtab').forEach(function (x) { x.classList.toggle('on', x === b); });
m.querySelectorAll('.mbody').forEach(function (x) {
x.hidden = x.getAttribute('data-p') !== p;
});
if (p === 'dm') biliLoadDm(m.querySelector('#pdm'), id, title, year);
if (p === 'rp') biliLoadRp(m.querySelector('#prp'), id, title, year);
};
});
biliEntry(m, id, title);
}
var BILI_PLAY_GEN = 0;      // 连点两次：只让最后一次的异步结果落地
window.__biliAbort = function () { BILI_PLAY_GEN += 1; };
var BILI_EP_RE = /第\s*(\d+)\s*[话集]|\[(\d{1,3})\]|E(\d{1,3})|S\d+E(\d{1,3})|_(\d{1,3})/;
function biliEpNo(part) {
var m = BILI_EP_RE.exec(String(part == null ? '' : part));
if (!m) return 0;
for (var i = 1; i < m.length; i++) { if (m[i]) return Number(m[i]); }
return 0;
}
function biliPickPage(pages, ep) {
var want = Number(ep) > 0 ? Math.floor(Number(ep)) : 1;
for (var i = 0; i < pages.length; i++) {
if (pages[i] && biliEpNo(pages[i].part) === want) return pages[i];
}
return pages[want - 1] || pages[0] || null;
}
function biliAuth(path, method, body, ms) {
var tk = '';
try { tk = localStorage.getItem('gh_token') || ''; } catch (e) { tk = ''; }
var opt = { method: method || 'GET', headers: { authorization: 'Bearer ' + tk } };
if (body != null) {
opt.headers['content-type'] = 'application/json';
opt.body = JSON.stringify(body);
}
var ctl = typeof AbortController === 'function' ? new AbortController() : null;
var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms || 15000);
if (ctl) opt.signal = ctl.signal;
return fetch(BILI_BASE + path, opt).then(function (r) {
clearTimeout(timer);
return r.json().catch(function () { return null; }).then(function (j) {
return { status: r.status, ok: r.ok, j: j };
});
}, function (e) {
clearTimeout(timer);
if (ctl && ctl.signal && ctl.signal.aborted) throw new Error('网络慢，请重试');
throw new Error('网络异常，请检查连接');
});
}
function biliOpenPlayer(m, id, title, ep, cid, url, eps) {
var list = eps || [];
var ctx = {
m: m,
id: String(id),
title: String(title || ''),
ep: ep,
sources: url ? [{ label: 'B 站（弹幕版）', url: String(url), type: 'mp4' }] : [],
onProgress: function (p) {
if (!p) return;
var prev = null;
try { prev = window.__prog && window.__prog.get ? window.__prog.get(id) : null; } catch (e) { prev = null; }
var extra = prev && Number(prev.ep) === Number(p.ep)
? { fid: prev.fid || '', pos: p.pos || 0, dur: p.dur || 0 }
: { fid: '', pos: p.pos || 0, dur: p.dur || 0 };
if (window.__prog && typeof window.__prog.report === 'function') {
try { window.__prog.report(id, p.ep, extra); } catch (e) { /* 上报失败不影响播放 */ }
}
},
onNext: function () {
var curEp = Number(ep);
if (!list.length) return;
var i = -1;
for (var k = 0; k < list.length; k++) { if (Number(list[k].ep) === curEp) { i = k; break; } }
if (i >= 0 && i + 1 < list.length) biliPlayEp(m, id, title, Number(list[i + 1].ep));
},
onPickEp: function (ep) { biliPlayEp(m, id, title, Number(ep) || 1); }
};
if (cid) ctx.dm = { cid: String(cid) };
var tok = window.QPlayer.open(ctx);
if (list.length) window.QPlayer.setEpisodes(list, ep, '');
else window.QPlayer.setEpisodes([], ep);
return tok;
}
function biliPlayEp(m, id, title, ep) {
var tk = '';
try { tk = localStorage.getItem('gh_token') || ''; } catch (e) { tk = ''; }
if (!tk) { if (window.__openLogin) window.__openLogin('email'); return; }
if (!m || !window.QPlayer) return;
var want = Number(ep) > 0 ? Math.floor(Number(ep)) : 1;
var gen = ++BILI_PLAY_GEN;
var eps = [];             // 分P 列表：resolve 回来才填，失败/超时路径保持空数组
function fail(msg, state) {
biliOpenPlayer(m, id, title, want, 0, '', eps);
window.QPlayer.state(state || 'error', { msg: msg });
}
biliResolve(id, title).then(function (v) {
if (gen !== BILI_PLAY_GEN) return;
if (!v || !v.bvid || !v.pages || !v.pages.length) { fail('没找到这部番的 B 站源，换夸克源试试'); return; }
eps = (v.pages || []).map(function (p) {
var n = biliEpNo(p.part);
return { ep: n || (p.page || 0), label: p.part || ('第 ' + (p.page || '') + ' 集') };
}).filter(function (x) { return x.ep > 0; });
var pg = biliPickPage(v.pages, want);
if (!pg || !pg.cid) { fail('这一集没有可用的 B 站分P'); return; }
return biliAuth('playurl', 'POST', { bvid: v.bvid, cid: pg.cid, qn: 80 }, 20000).then(function (r) {
if (gen !== BILI_PLAY_GEN) return;
var j = r.j || {};
if (r.ok && j.ok && j.url) { biliOpenPlayer(m, id, title, want, pg.cid, j.url, eps); return; }
if (r.status === 401) { fail('站点登录已失效，请重新登录', 'login'); return; }
if (j.error === 'need_rebind' || j.error === 'not_bound') {
biliOpenPlayer(m, id, title, want, 0, '', eps);
window.QPlayer.state('rebind', {
msg: 'B 站登录已失效，去个人主页重新粘贴 SESSDATA',
actions: [{ label: '去个人主页', href: 'user' }]
});
return;
}
fail('B 站播放地址取不到，稍后再试');
});
}).catch(function () {
if (gen !== BILI_PLAY_GEN) return;
if (window.QPlayer && m) fail('B 站播放失败，稍后再试');
});
}
function biliSavedEp(id) {
try {
var p = window.__prog && typeof window.__prog.get === 'function' ? window.__prog.get(id) : null;
if (p && Number(p.ep) > 0) return Math.floor(Number(p.ep));
} catch (e) { /* 进度坏了就从头播 */ }
return 1;
}
function biliEntry(m, id, title) {
var acts = m && m.querySelector ? m.querySelector('.acts') : null;
if (!acts || acts.querySelector('#biliplay')) return;
var b = document.createElement('span');
b.className = 'btn';
b.id = 'biliplay';
b.setAttribute('role', 'button');
b.setAttribute('tabindex', '0');
b.textContent = '▶ B 站（弹幕版）';
b.onclick = function () { biliPlayEp(m, id, title, biliSavedEp(id)); };
b.onkeydown = function (ev) {
if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); b.click(); }
};
acts.appendChild(b);
}
window.__biliPlay = biliPlayEp;
var THEME_KEY = 'theme';
function currentTheme() {
try {
var t = localStorage.getItem(THEME_KEY);
if (t === 'light' || t === 'dark') return t;
} catch (e) { /* 隐私模式 */ }
return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
}
function applyTheme(t) {
document.documentElement.setAttribute('data-theme', t);
var b = document.getElementById('thm');
if (b) {
b.textContent = t === 'dark' ? '☾' : '☀';
b.setAttribute('aria-label', t === 'dark' ? '切到浅色' : '切到深色');
b.title = b.getAttribute('aria-label');
}
}
function toggleTheme() {
var next = currentTheme() === 'dark' ? 'light' : 'dark';
try { localStorage.setItem(THEME_KEY, next); } catch (e) { }
applyTheme(next);
}
applyTheme(currentTheme());
var AUTH_BASE = 'https://120.48.56.189';
var TOKEN_KEY = 'gh_token';
var AUTH_PENDING = '';
var AUTH_LOGIN = '';
function authToken() {
try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
}
function authFetch(path, payload, ms, extraHeaders, opts) {
opts = opts || {};
var headers = {};
var hasBody = payload !== null && payload !== undefined;
if (hasBody) headers['content-type'] = 'application/json';
if (extraHeaders) {
for (var k in extraHeaders) {
if (Object.prototype.hasOwnProperty.call(extraHeaders, k)) headers[k] = extraHeaders[k];
}
}
var opt = { method: opts.method || 'POST', headers: headers };
if (hasBody) opt.body = JSON.stringify(payload);
var ctl = typeof AbortController === 'function' ? new AbortController() : null;
var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms || 12000);
if (ctl) opt.signal = ctl.signal;
return fetch(AUTH_BASE + path, opt).then(function (r) {
clearTimeout(timer);
return r.json().catch(function () { return null; }).then(function (j) {
return { status: r.status, ok: r.ok, j: j };
});
}, function (e) {
clearTimeout(timer);
if (ctl && ctl.signal && ctl.signal.aborted) throw new Error('网络慢，请重试');
throw new Error('网络异常，请检查连接');
});
}
function setBusy(btn, text) {
if (!btn) return function () { };
var old = btn.textContent;
btn.disabled = true;
btn.textContent = text;
return function () {
btn.disabled = false;
btn.textContent = old;
};
}
function showMsg(el, msg, ok) {
if (!el) return;
el.textContent = msg || '';
if (ok) el.classList.add('authok');
else el.classList.remove('authok');
}
(function grabToken() {
var m = /(?:^|[#&])t=([a-f0-9]{32,})/i.exec(location.hash || '');
if (!m) return;
try { localStorage.setItem(TOKEN_KEY, m[1]); } catch (e) { /* 隐私模式忽略 */ }
try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { }
})();
function repaint() {
if (PAGE === 'anime') applyBrowse(true);
else if (PAGE === 'movie') refreshMovie(true);
else if (PAGE === 'rank') renderRank();
else if (PAGE === 'user') renderUser();
else if (PAGE === 'detail') renderDetail();
else renderHome();
}
function loginBtnHtml() {
return '<button class="login" id="loginbtn" type="button">登录</button>';
}
function paintLoginEntry(el) {
el.title = '';
el.onclick = function (e) {
if (e && e.target && e.target.id === 'loginbtn') openAuthPanel();
};
el.innerHTML = loginBtnHtml();
}
var authEsc = null;
function openAuthPanel(mode) {
if (document.getElementById('authmask')) return;
if (mode === 'account' && !authToken()) mode = '';
var mask = document.createElement('div');
mask.className = 'authmask';
mask.id = 'authmask';
mask.innerHTML = '<div class="authcard" role="dialog" aria-modal="true">'
+ '<button class="authx" type="button" aria-label="关闭">×</button>'
+ '<div class="authbody" data-t="email">'
+ '<label class="authfield"><span>邮箱</span><input id="authemail" type="email" autocomplete="username"'
+ ' placeholder="you@example.com"></label>'
+ '<label class="authfield"><span>密码</span><input id="authpw" type="password" autocomplete="current-password"'
+ ' placeholder="至少 8 位"></label>'
+ '<div class="autherr" id="autherr" role="status" aria-live="polite"></div>'
+ '<div class="authacts">'
+ '<button class="btn pri" id="authlogin" type="button">登录</button>'
+ '<button class="btn" id="authreg" type="button">注册</button>'
+ '</div>'
+ '<p class="authhint" id="authemailtip">邮箱只用于登录与找回，不发推广。注册会往这个邮箱发 6 位验证码（10 分钟内有效），验证通过才算注册成功；密码至少 8 位。</p>'
+ '</div>'
+ '<div class="authbody" data-t="verify" hidden>'
+ '<p class="authhint" id="authverifyhint">验证码已发到你的邮箱，10 分钟内有效。</p>'
+ '<label class="authfield"><span>验证码</span><input id="authcode" inputmode="numeric" maxlength="6"'
+ ' autocomplete="one-time-code" placeholder="6 位数字"></label>'
+ '<p class="authhint" id="authverifytip">没收到？先看垃圾箱；60 秒后可重发</p>'
+ '<div class="autherr" id="authcodeerr" role="status" aria-live="polite"></div>'
+ '<div class="authacts">'
+ '<button class="btn pri" id="authconfirm" type="button">确认</button>'
+ '<button class="btn" id="authresend" type="button">重新发送</button>'
+ '<button class="btn" id="authback" type="button">← 改邮箱</button>'
+ '</div>'
+ '</div>'
+ '<div class="authbody" data-t="account" hidden>'
+ '<p class="authhint" id="accthint">已登录</p>'
+ '<label class="authfield"><span>原密码</span><input id="acctold" type="password"'
+ ' autocomplete="current-password"></label>'
+ '<label class="authfield"><span>新密码</span><input id="acctnew" type="password"'
+ ' autocomplete="new-password" placeholder="至少 8 位"></label>'
+ '<div class="autherr" id="accterr" role="status" aria-live="polite"></div>'
+ '<div class="authacts">'
+ '<button class="btn pri" id="acctsave" type="button">修改密码</button>'
+ '<button class="btn" id="acctout" type="button">退出登录</button>'
+ '</div>'
+ '</div>'
+ '</div>';
document.body.appendChild(mask);
mask.querySelector('.authx').onclick = closeAuthPanel;
mask.addEventListener('click', function (e) { if (e.target.id === 'authmask') closeAuthPanel(); });
mask.querySelector('#authlogin').onclick = function () { submitAuth('login'); };
mask.querySelector('#authreg').onclick = function () { submitAuth('register'); };
mask.querySelector('#authconfirm').onclick = confirmCode;
mask.querySelector('#authresend').onclick = resendCode;
mask.querySelector('#authback').onclick = function () {
showAuthView('email');
var em = document.getElementById('authemail');
if (em) { em.focus(); try { em.select(); } catch (e) { /* 忽略 */ } }
};
mask.querySelector('#acctsave').onclick = changePassword;
mask.querySelector('#acctout').onclick = logoutAccount;
mask.querySelectorAll('.authfield input').forEach(function (inp) {
if (inp.id === 'authcode' || inp.id === 'acctold' || inp.id === 'acctnew') return;
inp.addEventListener('keydown', function (e) {
if (e.key === 'Enter') { e.preventDefault(); submitAuth('login'); }
});
});
var acode = document.getElementById('authcode');
if (acode) acode.addEventListener('keydown', function (e) {
if (e.key === 'Enter') { e.preventDefault(); confirmCode(); }
});
var acctFields = ['acctold', 'acctnew'].map(function (id) { return document.getElementById(id); });
acctFields.forEach(function (inp) {
if (!inp) return;
inp.addEventListener('keydown', function (e) {
if (e.key === 'Enter') { e.preventDefault(); changePassword(); }
});
});
authEsc = function (e) { if (e.key === 'Escape') closeAuthPanel(); };
document.addEventListener('keydown', authEsc);
showAuthView(mode === 'account' ? 'account' : 'email');
var first = document.getElementById(mode === 'account' ? 'acctold' : 'authemail');
if (first) first.focus();
}
function showAuthView(name) {
var mask = document.getElementById('authmask');
if (!mask) return;
mask.querySelectorAll('.authbody').forEach(function (x) {
x.hidden = x.getAttribute('data-t') !== name;
});
if (name === 'account') {
var hint = document.getElementById('accthint');
if (hint) hint.textContent = '已登录' + (AUTH_LOGIN ? '：' + AUTH_LOGIN : '');
}
}
window.__openLogin = function () {
openAuthPanel(authToken() ? 'account' : 'email');
};
function closeAuthPanel() {
var m = document.getElementById('authmask');
if (m && m.parentNode) m.parentNode.removeChild(m);
if (authEsc) { document.removeEventListener('keydown', authEsc); authEsc = null; }
if (authResendTimer) { clearInterval(authResendTimer); authResendTimer = 0; }
}
function submitAuth(kind) {
var em = document.getElementById('authemail');
var pw = document.getElementById('authpw');
var err = document.getElementById('autherr');
var bl = document.getElementById('authlogin');
var br = document.getElementById('authreg');
if (!em || !pw) return;
if ((bl && bl.disabled) || (br && br.disabled)) return;
var email = String(em.value || '').trim();
var pwv = String(pw.value || '');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
showMsg(err, '邮箱格式看起来不对');
em.focus();
return;
}
if (pwv.length < 8) {
showMsg(err, '密码至少 8 位');
pw.focus();
return;
}
showMsg(err, '');
var main = kind === 'register' ? br : bl;
var other = kind === 'register' ? bl : br;
var restore = setBusy(main, kind === 'register' ? '发送中…' : '登录中…');
if (other) other.disabled = true;
authFetch(kind === 'register' ? '/auth/register' : '/auth/login', {
email: email,
password: pwv
}).then(function (res) {
var j = res.j || {};
if (res.ok && j.token) {
try { localStorage.setItem(TOKEN_KEY, j.token); } catch (e) { /* 隐私模式忽略 */ }
closeAuthPanel();
paintAuth();
try { pullFollow(); } catch (e) { }
return;
}
if (j.need_verify) {
AUTH_PENDING = email;
showAuthVerify(j.hint || j.error || '验证码已发送', j.dev_code);
return;
}
if (res.status === 429) throw new Error(j.error || '尝试太频繁，稍后再试');
throw new Error(j.error || '请求失败');
}).catch(function (e) {
showMsg(err, (e && e.message) || '请求失败');
}).then(function () {
restore();
if (other) other.disabled = false;
});
}
function showAuthVerify(hint, devCode) {
var mask = document.getElementById('authmask');
if (!mask) return;
showAuthView('verify');
var tip = document.getElementById('authverifyhint');
if (tip) {
tip.innerHTML = '';
tip.appendChild(document.createTextNode(hint || '验证码已发送'));
if (AUTH_PENDING) {
var b = document.createElement('b');
b.textContent = AUTH_PENDING;
tip.appendChild(document.createTextNode(' → '));
tip.appendChild(b);
}
}
var code = document.getElementById('authcode');
if (code) code.value = devCode ? String(devCode) : '';
var ce = document.getElementById('authcodeerr');
showMsg(ce, '');
if (authResendTimer) { clearInterval(authResendTimer); authResendTimer = 0; }
var br = document.getElementById('authresend');
if (br) { br.disabled = false; br.textContent = '重新发送'; }
if (code) code.focus();
}
var RESEND_SECS = 60;
var authResendTimer = 0;
function startResendCooldown(btn) {
if (!btn || !document.getElementById('authmask')) return;
if (authResendTimer) clearInterval(authResendTimer);
var left = RESEND_SECS;
btn.disabled = true;
btn.textContent = '重新发送(' + left + 's)';
authResendTimer = setInterval(function () {
left -= 1;
if (left <= 0) {
clearInterval(authResendTimer);
authResendTimer = 0;
btn.disabled = false;
btn.textContent = '重新发送';
return;
}
btn.textContent = '重新发送(' + left + 's)';
}, 1000);
}
function confirmCode() {
var code = document.getElementById('authcode');
var err = document.getElementById('authcodeerr');
var bc = document.getElementById('authconfirm');
var br = document.getElementById('authresend');
showMsg(err, '');
if (!AUTH_PENDING) { showMsg(err, '先填邮箱注册或登录'); return; }
var v = code ? String(code.value || '').replace(/\s+/g, '') : '';
if (!/^\d{6}$/.test(v)) { showMsg(err, '验证码是 6 位数字'); if (code) code.focus(); return; }
if (bc && bc.disabled) return;
var restore = setBusy(bc, '确认中…');
if (br) br.disabled = true;
authFetch('/auth/verify', { email: AUTH_PENDING, code: v }).then(function (res) {
var j = res.j || {};
if (res.ok && j.token) {
try { localStorage.setItem(TOKEN_KEY, j.token); } catch (e) { /* 隐私模式忽略 */ }
AUTH_PENDING = '';
closeAuthPanel();
paintAuth();
try { pullFollow(); } catch (e) { }
return;
}
throw new Error(j.error || '验证码不对或已过期');
}).catch(function (e) {
showMsg(err, (e && e.message) || '验证码不对或已过期');
}).then(function () {
restore();
if (br && !authResendTimer) br.disabled = false;
});
}
function resendCode() {
var err = document.getElementById('authcodeerr');
var tip = document.getElementById('authverifyhint');
var bc = document.getElementById('authconfirm');
var br = document.getElementById('authresend');
showMsg(err, '');
if (!AUTH_PENDING) { showMsg(err, '先填邮箱注册或登录'); return; }
if ((bc && bc.disabled) || (br && br.disabled)) return;
if (bc) bc.disabled = true;
var restore = setBusy(br, '重发中…');
authFetch('/auth/resend', { email: AUTH_PENDING }).then(function (res) {
var j = res.j || {};
if (res.ok && j.ok) {
if (tip) tip.textContent = j.hint || '验证码已重新发送';
var code = document.getElementById('authcode');
if (code && j.dev_code) code.value = String(j.dev_code);
return;
}
if (res.status === 429) throw new Error(j.error || j.hint || '发送太频繁，稍后再试');
throw new Error(j.error || '发送失败');
}).catch(function (e) {
showMsg(err, (e && e.message) || '发送失败');
}).then(function () {
if (bc) bc.disabled = false;
restore();
startResendCooldown(br);
});
}
function changePassword() {
var oldp = document.getElementById('acctold');
var newp = document.getElementById('acctnew');
var err = document.getElementById('accterr');
var bs = document.getElementById('acctsave');
var bo = document.getElementById('acctout');
if (!oldp || !newp) return;
if ((bs && bs.disabled) || (bo && bo.disabled)) return;
var tk = authToken();
if (!tk) { showMsg(err, '登录已失效，请重新登录'); return; }
if (String(newp.value || '').length < 8) {
showMsg(err, '新密码至少 8 位');
newp.focus();
return;
}
showMsg(err, '');
var restore = setBusy(bs, '保存中…');
if (bo) bo.disabled = true;
authFetch('/auth/password', {
old: String(oldp.value || ''),
new: String(newp.value || '')
}, 12000, { authorization: 'Bearer ' + tk }).then(function (res) {
var j = res.j || {};
if (res.ok && j.ok) {
oldp.value = '';
newp.value = '';
showMsg(err, '密码已更新', true);
return;
}
throw new Error(j.error || '修改失败');
}).catch(function (e) {
showMsg(err, (e && e.message) || '修改失败');
}).then(function () {
restore();
if (bo) bo.disabled = false;
});
}
function logoutAccount() {
var bs = document.getElementById('acctsave');
var bo = document.getElementById('acctout');
if ((bs && bs.disabled) || (bo && bo.disabled)) return;
var tk = authToken();
if (bs) bs.disabled = true;
if (bo) bo.disabled = true;
authFetch('/auth/logout', null, 12000, { authorization: 'Bearer ' + tk })
.catch(function () { /* 退出请求失败/超时也照常清本地态 */ })
.then(function () {
try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* 忽略 */ }
AUTH_LOGIN = '';
closeAuthPanel();
paintAuth();
});
}
function paintAuth() {
var el = document.getElementById('cnt');
if (!el) return;
var tk = authToken();
if (!tk) { paintLoginEntry(el); return; }
el.innerHTML = '<span class="who">登录中…</span>';
authFetch('/auth/me', null, 12000, { authorization: 'Bearer ' + tk }, { method: 'GET' }).then(function (r) {
if (r.status === 401) { var e = new Error('login_required'); e.auth = 1; throw e; }
if (!r.ok) throw new Error('HTTP ' + r.status);
if (!r.j) throw new Error('bad body');
return r.j;
}).then(function (d) {
var u = (d && d.ok && d.user) || null;
if (!u) { var e = new Error('login_required'); e.auth = 1; throw e; }
AUTH_LOGIN = String(u.login || '');
el.title = '我的主页';
var av = u.avatar
? '<img class="av" src="' + esc(u.avatar) + '" alt="">'
: '<span class="avt">' + esc(String(u.login || '?').slice(0, 1).toUpperCase()) + '</span>';
el.innerHTML = av + '<b>' + esc(u.login) + '</b>';
el.onclick = function () { location.href = 'user'; };
el.classList.add('is-user');
}).catch(function (e) {
if (e && e.auth) { try { localStorage.removeItem(TOKEN_KEY); } catch (err) { /* 忽略 */ } }
paintLoginEntry(el);
});
}
function bootHeader() {
var P = PAGE;
var ph = P === 'movie' ? '搜索电影…' : '搜索番剧…';
var nav = [['/', 'home', '首页'], ['/anime', 'anime', '番剧'], ['/movie', 'movie', '电影'],
['/rank', 'rank', '排行榜'], ['/user', 'user', '我的']]
.map(function (x) {
return '<a href="' + x[0] + '"' + (P === x[1] ? ' class="is-on"' : '') + '>' + x[2] + '</a>';
}).join('');
var tabbar = document.getElementById('tabbar');
if (!tabbar) {
tabbar = document.createElement('nav');
tabbar.className = 'tabbar';
tabbar.id = 'tabbar';
document.body.appendChild(tabbar);
}
var items = [['/', 'home', '首页'], ['/anime', 'anime', '番剧'],
['/movie', 'movie', '电影'], ['/user', 'user', '我的']];
tabbar.style.setProperty('--tabn', String(items.length));
tabbar.innerHTML = items
.map(function (x) {
return '<a href="' + x[0] + '"' + (P === x[1] ? ' class="is-on"' : '') + '>' + x[2] + '</a>';
}).join('');
var host = document.getElementById('topbar');
if (!host) return;
host.innerHTML = '<div class="sky"><div class="hd-wrap">'
+ '<a class="brand" href="/"><i></i>番组<b>计划</b></a>'
+ '<div class="searchbox"><input id="q" type="search" placeholder="' + ph + '" autocomplete="off"></div>'
+ '<span class="cnt" id="cnt"></span>'
+ '<button class="thm" id="thm" type="button" aria-label="切换主题">☀</button>'
+ '</div></div>'
+ '<nav class="mainmenu mainnav"><div class="hd-wrap">' + nav + '</div></nav>';
paintAuth();
applyTheme(currentTheme());
var thm = $('#thm');
if (thm) thm.onclick = toggleTheme;
syncHeaderH();
if (window.addEventListener) window.addEventListener('resize', syncHeaderH);
}
function syncHeaderH() {
var head = document.querySelector('header.site-head');
if (!head || !head.getBoundingClientRect) return;
var h = Math.round(head.getBoundingClientRect().height);
var st = document.documentElement && document.documentElement.style;
if (st && st.setProperty) st.setProperty('--header-h', h + 'px');
}
function deepLinkId() {
var m = /[?&]id=(\d+)/.exec(location.search || '');
return m ? Number(m[1]) : 0;
}
var DEEP_REDIRECT = false;
function bootAnime() {
return jdSwr('anime.json').then(function (d) {
if (!d) throw new Error('data anime.json 三源都失败');
ANI.poster = d.poster || ''; ANI.posterSd = d.posterSd || '';
ANI.rows = d.rows || [];
ANI.extra = d.extra || {}; ANI.year = d.year || new Date().getFullYear();
});
}
var NAVBAR = null;
function navStart() {
try { sessionStorage.setItem('navp', '1'); } catch (e) { /* 隐私模式忽略 */ }
if (!NAVBAR) {
NAVBAR = document.createElement('div');
NAVBAR.className = 'nav-bar';
NAVBAR.innerHTML = '<i></i>';
document.body.appendChild(NAVBAR);
}
NAVBAR.className = 'nav-bar on';
}
function navFinish() {
var flagged = false;
try {
flagged = sessionStorage.getItem('navp') === '1';
sessionStorage.removeItem('navp');
} catch (e) { /* 隐私模式忽略 */ }
if (!flagged) return;
if (!NAVBAR) {
NAVBAR = document.createElement('div');
NAVBAR.className = 'nav-bar';
NAVBAR.innerHTML = '<i></i>';
document.body.appendChild(NAVBAR);
}
NAVBAR.className = 'nav-bar done';
setTimeout(function () { if (NAVBAR) NAVBAR.className = 'nav-bar'; }, 320);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', navFinish);
else navFinish();
window.addEventListener('pageshow', navFinish);
document.addEventListener('click', function (e) {
var a = e.target.closest && e.target.closest('a[href]');
if (!a || a.target === '_blank' || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
var href = a.getAttribute('href') || '';
if (href.charAt(0) !== '/' || href.charAt(1) === '/') return;   // 只站内绝对路径
if (a.hasAttribute('download')) return;
navStart();
}, true);
var PF_HREF = {};
document.addEventListener('mouseover', function (e) {
var a = e.target.closest && e.target.closest('a[href^="/"]');
if (!a) return;
var href = a.getAttribute('href') || '';
if (!href || PF_HREF[href] || href.indexOf('/api/') === 0) return;
PF_HREF[href] = 1;
setTimeout(function () {
try {
var l = document.createElement('link');
l.rel = 'prefetch';
l.as = 'document';
l.href = href;
document.head.appendChild(l);
} catch (err) { /* 预取失败不影响任何功能 */ }
}, 120);
});
var PF_LAST = 0, PF_TIMER = 0, PF_ID = 0;
document.addEventListener('mouseover', function (e) {
var c = e.target.closest && e.target.closest('.card[data-id]');
if (!c || PAGE === 'detail') return;
var id = Number(c.dataset.id);
if (!id || id === PF_ID) return;
PF_ID = id;
clearTimeout(PF_TIMER);
PF_TIMER = setTimeout(function () {
if (Date.now() - PF_LAST < 400) return;
PF_LAST = Date.now();
try { detailShard(id); } catch (e) { /* 预热失败不提示 */ }
}, 80);
});
document.addEventListener('click', function (e) {
var mc = e.target.closest && e.target.closest('.mcard');
if (mc) {
if (e.metaKey || e.ctrlKey || e.button !== 0) return;
e.preventDefault();
navStart();
location.href = '/detail?ext=' + encodeURIComponent(mc.dataset.ext || 'db')
+ '&i=' + encodeURIComponent(mc.dataset.i || '0');
return;
}
var c = e.target.closest && e.target.closest('.card');
if (!c) return;
if (e.metaKey || e.ctrlKey || e.button !== 0) return;
e.preventDefault();
navStart();
location.href = '/detail?id=' + encodeURIComponent(c.dataset.id || '');
});
$('#mask') && $('#mask').addEventListener('click', function (e) { if (e.target.id === 'mask') close(); });
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
window.addEventListener('popstate', function () {
if (document.querySelector('#mask.on')) close();
});
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
var deep = deepLinkId();
if (deep && !DEEP_REDIRECT) {
DEEP_REDIRECT = true;
location.replace('/detail?id=' + deep);
}
} else if (PAGE === 'movie') {
initMovie();
} else if (PAGE === 'rank') {
renderRank();
bindSearch(renderRank);
} else if (PAGE === 'user') {
renderUser();
} else if (PAGE === 'detail') {
renderDetail();
} else {
renderHome();
bindSearch(renderHome);
}
}).catch(function (e) {
$('#main').innerHTML = '<div class="loading">数据加载失败：' + esc(e.message || e) + '</div>';
});
})();