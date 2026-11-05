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
var ANI = { poster: '', posterSd: '', rows: [], extra: {}, year: 0 };
var shardCache = {};
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
var PSZ = { mode: 'hd' };
try {
var _psz = localStorage.getItem('psz');
if (_psz === 'hd' || _psz === 'sd') PSZ.mode = _psz;
} catch (e) { /* 隐私模式 / file:// 下 localStorage 可能不可用，忽略 */ }
pullFollow();
pullProgress();
window.__prog = { report: function (id, ep) { setProgress(id, ep); } };
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
return '<div class="pf-hero"></div>'
+ '<div class="empty">登录后查看我的主页 —— 追番、观看进度和账号设置都在这里</div>'
+ '<div class="pf-actions"><button class="btn pri" id="pflogin" type="button">登录</button></div>';
}
function userHTML(u) {
var name = userName(u) || '未登录用户';
var mail = maskEmail(u.email || (String(u.login || '').indexOf('@') >= 0 ? u.login : ''));
var av = String(u.avatar || '');
var avHtml = av
? '<img class="av" src="' + esc(av) + '" alt="">'
: '<span class="av">' + esc(name.slice(0, 1).toUpperCase()) + '</span>';
var rows = favRows(12);
var body;
if (!ANI.rows || !ANI.rows.length) {
body = '<div class="empty">番剧数据还没加载好 —— 稍后刷新看看</div>';
} else if (!rows.length) {
body = '<div class="empty">还没有追番 —— 打开一部番剧，点详情里的「☆ 追番」</div>'
+ '<div class="pf-actions"><a class="btn" href="anime">去番剧页</a></div>';
} else {
body = '<div class="grid">' + rows.map(function (r) {
return animeCard(r, { showYear: 1 });
}).join('') + '</div>';
}
return '<div class="pf-hero"></div>'
+ '<div class="pf-id">' + avHtml
+ '<div class="pf-name"><h1>' + esc(name) + '</h1>'
+ (mail ? '<p>' + esc(mail) + '</p>' : '') + '</div></div>'
+ '<div class="pf-stats">'
+ '<div><b>' + favList().length + '</b><i>追番</i></div>'
+ '<div><b>' + watchedCount() + '</b><i>看过</i></div>'
+ '</div>'
+ '<div class="pf-actions">'
+ '<button class="btn" id="pfpw" type="button">修改密码</button>'
+ '<button class="btn" id="pfout" type="button">退出登录</button>'
+ '<a class="btn" href="https://120.48.56.189/qr/" target="_blank" rel="noopener">绑定夸克网盘</a>'
+ '</div>'
+ '<div class="pf-tabs"><button class="on" type="button">我的追番</button></div>'
+ '<div class="pf-body">' + body + '</div>';
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
var out = document.getElementById('pfout');
if (out) out.onclick = function () {
logoutAccount();
USER = null;
var m = $('#main');
if (m) { m.innerHTML = userLoginHTML(); bindUserLogin(); }
};
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
return;
}
if (!main.querySelector('.pf-hero')) main.innerHTML = '<div class="loading">加载中…</div>';
loadProfile().then(function (u) {
USER = u;
main.innerHTML = userHTML(u);
bindUserActions();
}).catch(function (e) {
main.innerHTML = '<div class="empty">' + esc((e && e.message) || '资料加载失败')
+ '</div><div class="pf-actions"><a class="btn" href="user">重试</a></div>';
});
}
var BROWSE = { view: [], shown: 0, page: 120 };
var FAV_ONLY = /[?&]fav=1\b/.test(location.search);
function renderBrowse(mode) {
var grid = $('#grid');
if (!grid) return;
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
html = FAV_ONLY
? '<div class="empty favhint">还没有追番 —— 去「番剧」点卡片或详情里的 ☆ 追番</div>'
: '<div class="empty">这个组合没有作品 —— 换个年份/类型，或点「全部」再试</div>';
}
grid.insertAdjacentHTML('beforeend', html);
BROWSE.shown = want;
var left = BROWSE.view.length - BROWSE.shown;
$('#morewrap').hidden = left <= 0;
if (left > 0) $('#morebtn').textContent = '加载更多 · 还剩 ' + left + ' 部';
$('#hint').textContent = FAV_ONLY
? '我的追番 · ' + BROWSE.view.length + ' 部'
: '筛出 ' + BROWSE.view.length + ' 部，已显示 ' + BROWSE.shown;
}
function applyBrowse(reset) {
var q = nrm(($('#q').value || '').trim());
var y = ($('#f-year') || {}).value || '';
var t = ($('#f-type') || {}).value || '';
var sort = ($('#f-sort') || {}).value || 'year';
var tg = ($('#f-tag') || {}).value || '';
var favSet = null;
if (FAV_ONLY) {
favSet = {};
favList().forEach(function (id) { favSet[String(id)] = 1; });
y = '';
var fy = $('#f-year');
if (fy) fy.value = '';
}
var tgSet = null;
if (tg && TAGS && TAGS[tg]) {
tgSet = {};
TAGS[tg].forEach(function (id) { tgSet[id] = 1; });
}
BROWSE.view = ANI.rows.filter(function (r) {
if (favSet && !favSet[String(r[0])]) return false;
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
$('#morebtn').onclick = function () { renderBrowse('more'); };
['#f-year', '#f-type', '#f-sort'].forEach(function (s) { $(s).addEventListener('change', applyBrowse); });
mountTagFilter();
var deepTag = pickTagFromUrl();
if (deepTag && TAGS && TAGS[deepTag]) { $('#f-tag').value = deepTag; $('#f-year').value = ''; }
applyBrowse();
if (FAV_ONLY) {
var maskEl = $('#mask');
if (maskEl && window.MutationObserver) {
var wasOpen = maskEl.classList.contains('on');
new MutationObserver(function () {
var open = maskEl.classList.contains('on');
if (wasOpen && !open) applyBrowse();
wasOpen = open;
}).observe(maskEl, { attributes: true, attributeFilter: ['class'] });
}
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
var MODAL_GEN = 0;
function renderTags(rec, el) {
if (!el) return;
el.innerHTML = (rec.tags || []).filter(function (t, i, arr) { return arr.indexOf(t) === i; }).slice(0, 12).map(function (t) {
var n = TAGCNT[t];
var href = './anime.html?tag=' + encodeURIComponent(t);
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
var host = m, gen = ++MODAL_GEN;             // 这一代弹窗的容器引用与代号
m.innerHTML = '<button class="x" type="button" aria-label="关闭">×</button>'
+ '<div class="mhero">'
+   '<img class="mposter" src="' + esc(ANI.poster + id + '.jpg') + '"' + fbAttr([ex[1]]) + ' alt="">'
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
+       '<span class="btn pri" id="watch" role="button" tabindex="0">开始观看</span>'
+       '<span class="btn" id="qplay" role="button" tabindex="0">▶ 在线播放</span>'
+       '<span class="btn" id="favbtn" type="button">☆ 追番</span>'
+       (ex[2] ? '<span class="btn" id="play">▶ 预告</span>' : '')
+       '<a class="btn" target="_blank" rel="noopener" href="https://search.bilibili.com/all?keyword='
+         encodeURIComponent(title) + '">B 站搜索</a>'
+     '</div>'
+   '</div>'
+ '</div>'
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
if (wb) wb.onkeydown = function (ev) {
if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); wb.click(); }
};
var qp = m.querySelector('#qplay');
if (qp) {
qp.onclick = function () { openQuarkPlay(m, id, title); };
qp.onkeydown = function (ev) {
if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); qp.click(); }
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
var rec = null;
ensureTagCounts(function () {
if (gen !== MODAL_GEN || !rec) return;
renderTags(rec, host.querySelector('#tags'));
});
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
if (gen !== MODAL_GEN) return;      // 这一代已被新打开的番取代：数据与 DOM 都不再属于它
var plot = host.querySelector('#plot');
if (!plot) return;      // close() 已清空 / 已切到磁力视图：这一代内容没了，别再往空节点写
if (list === null) { plot.textContent = '简介加载失败，请重试'; return; }  // 分片拉不到，与「记录不存在」区分
rec = (list || []).find(function (x) { return x.id === id; });
if (!rec) { plot.textContent = '暂无详细资料'; return; }
plot.textContent = String(rec.overview || '暂无简介').replace(/\n{3,}/g, '\n\n');
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
var m = $('#modal');
if (m) {
var tr = m.querySelectorAll('.trailer');
for (var i = 0; i < tr.length; i++) { if (tr[i].parentNode) tr[i].parentNode.removeChild(tr[i]); }
m.innerHTML = '';
}
$('#mask').classList.remove('on');
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
var QP_TIMER = 0;      // 挂起的转码轮询（模块级：新播放 / 关弹窗都要能掐掉）
var QP_GEN = 0;        // 每次开播自增：异步回调据此判断自己是否已被后来的一次播放取代
function qpJson(path, tk) {
return fetch(QP_BASE + path, { headers: { authorization: 'Bearer ' + tk } }).then(function (res) {
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
}, function () { return { state: 'error' }; });
}
function openQuarkPlay(m, id, title) {
if (!m) return;
var tk = followToken();                       // 20-state.js：读 localStorage.gh_token
if (!tk) { if (window.__openLogin) window.__openLogin('email'); return; }
var gen = ++QP_GEN;                           // 换代：上一代在飞的请求与轮询全部作废
if (QP_TIMER) { clearTimeout(QP_TIMER); QP_TIMER = 0; }
var old = m.querySelector('.trailer');
if (old && old.parentNode) {
var ov = old.querySelector('video');
if (ov) {
try { ov.pause(); ov.removeAttribute('src'); if (ov.load) ov.load(); } catch (e) { /* 忽略 */ }
}
old.parentNode.removeChild(old);
}
var bar = document.createElement('div');
bar.className = 'trailer qpmsg';
bar.textContent = '正在查找网盘文件…';
m.appendChild(bar);
bar.scrollIntoView({ block: 'center' });
function alive() { return gen === QP_GEN && bar.isConnected; }
function say(text) { if (alive()) bar.textContent = text; }
function needLogin() {
if (!alive()) return;
if (bar.parentNode) bar.parentNode.removeChild(bar);
if (window.__openLogin) window.__openLogin('email');
}
function needRebind() {
if (!alive()) return;
bar.innerHTML = '夸克登录已失效，去 <a href="' + QP_BASE + '/qr/" target="_blank" '
+ 'rel="noopener">https://120.48.56.189/qr/</a> 重新扫码';
}
function play(url) {
if (!alive()) return;
var d = document.createElement('div');
d.className = 'trailer';
d.innerHTML = '<video controls autoplay playsinline preload="metadata"></video>';
var v = d.querySelector('video');
if (v) v.setAttribute('src', url);          // 直链带签名参数，用属性赋值不经 innerHTML 转义
if (bar.parentNode) bar.parentNode.replaceChild(d, bar);   // 换上视频 = 同时移除状态条
else m.appendChild(d);
d.scrollIntoView({ block: 'center' });
}
function askUrl(fid, tries) {
if (!alive()) return;
if (tries > 10) { say('转码超时，稍后再试'); return; }
qpJson('/tvplay/url?fid=' + encodeURIComponent(fid) + '&wait=45', tk).then(function (j) {
if (!alive()) return;
if (j.state === 'ready' && j.url) { play(String(j.url)); return; }
if (j.state === 'transcoding') {
say('转码中… 约 1 分钟');
var wait = Number(j.retry_after);
if (!(wait > 0)) wait = 5;
QP_TIMER = setTimeout(function () {
QP_TIMER = 0;
if (!alive()) return;                 // 弹窗已关：不再排下一轮
askUrl(fid, tries + 1);
}, Math.min(wait, 60) * 1000);
return;
}
if (j.state === 'need_rebind') { needRebind(); return; }
if (j.state === 'unauthorized') { needLogin(); return; }
say('播放服务暂时不可用');
});
}
qpJson('/tvplay/find?q=' + encodeURIComponent(String(title || '')) + '&limit=5', tk).then(function (j) {
if (!alive()) return;
if (j.state === 'found') {
var items = j.items || [];
var best = j.best || items[0] || null;
if (!best || best.fid == null || best.fid === '') { say('播放服务暂时不可用'); return; }
say('找到 ' + items.length + ' 个文件，正在准备播放…');
askUrl(String(best.fid), 0);
return;
}
if (j.state === 'none') {
say('你的夸克网盘里还没有这部；先点磁力行复制链接到夸克离线下载');
return;
}
if (j.state === 'need_rebind') { needRebind(); return; }
if (j.state === 'unauthorized') { needLogin(); return; }
say('播放服务暂时不可用');
});
}
window.__qp = openQuarkPlay;
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
var bp = m.querySelector('#watch');
if (bp) {
bp.onclick = function () {
bp.textContent = '匹配中…';
biliResolve(id, title, year).then(function (v) {
if (!v || !v.pages || !v.pages.length) {
bp.textContent = '未找到 B 站源';
bp.setAttribute('data-miss', '1');
setTimeout(function () { bp.textContent = '开始观看'; }, 2200);
return;
}
bp.textContent = '开始观看';
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
d.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
+ '<p class="authhint" id="authemailtip">邮箱只用于登录与找回，不发推广；验证码 10 分钟内有效。</p>'
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
if (tip) tip.textContent = hint || '验证码已发送';
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
var P = PAGE === 'anime' && FAV_ONLY ? 'fav' : PAGE;
var ph = P === 'movie' ? '搜索电影…' : '搜索番剧…';
var nav = [['./', 'home', '首页'], ['anime', 'anime', '番剧'], ['anime?fav=1', 'fav', '追番'],
['movie', 'movie', '电影'], ['rank', 'rank', '排行榜']]
.map(function (x) {
return '<a href="' + x[0] + '"' + (P === x[1] ? ' class="is-on"' : '') + '>' + x[2] + '</a>';
}).join('');
var host = document.getElementById('topbar');
if (!host) return;
host.innerHTML = '<div class="wrap"><a class="brand" href="./"><i></i>番组<b>计划</b></a>'
+ '<nav class="mainnav">' + nav + '</nav><div class="head-spacer"></div>'
+ '<div class="searchbox"><input id="q" type="search" placeholder="' + ph + '" autocomplete="off"></div>'
+ '<button class="psz" id="psz" type="button" aria-pressed="false">高清</button>'
+ '<button class="thm" id="thm" type="button" aria-label="切换主题">☀</button>'
+ '<span class="cnt" id="cnt"></span>'
+ '<span class="build" id="build">' + (document.body.dataset.build || '') + '</span></div>';
paintAuth();
applyTheme(currentTheme());
var thm = $('#thm');
if (thm) thm.onclick = toggleTheme;
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
} else if (PAGE === 'user') {
renderUser();
} else {
renderHome();
bindSearch(renderHome);
}
initPsz();
}).catch(function (e) {
$('#main').innerHTML = '<div class="loading">数据加载失败：' + esc(e.message || e) + '</div>';
});
})();