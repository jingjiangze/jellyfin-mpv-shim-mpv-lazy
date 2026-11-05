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
+       '<span class="btn pri" id="watch" role="button" tabindex="0">▶ 播放</span>'
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
var QP_FID_KEY = 'qp_fid';             // {"<bgm id>:<ep>": {fid,name,size,ts}}
var QP_FID_TTL = 60 * 60 * 1000;       // fid 缓存 1h：文件不会每分钟改名，地址才会过期
var QP_TIMER = 0;                      // 挂起的转码 / 转存轮询（模块级：新播放 / 关播放器都要能掐掉）
var QP_GEN = 0;                        // 每次开播自增：异步回调据此判断自己是否已被后来的一次播放取代
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
var QP_LINES_KEY = 'qp_lines';
var QP_LINE_MAX = 20;                       // 单番最多存 20 条自备线路，防 localStorage 膨胀
var QP_RATES = [2, 1.5, 1.25, 1, 0.75];     // 倍速循环（初始 1.0×，按钮按数组顺序轮转）
var QP_REBIND = 'https://120.48.56.189/qr/';
var QPlayer = (function () {
var TPL = '<div class="qp-head"><b class="qp-title"></b><span class="qp-sub"></span>'
+ '<button class="qp-btn qp-close" type="button" aria-label="关闭播放器">×</button></div>'
+ '<div class="qp-stage"><video class="qp-video" playsinline preload="metadata"></video>'
+ '<button class="qp-bigplay" type="button" hidden>▶</button>'
+ '<div class="qp-overlay"><div class="qp-spinner"></div><p class="qp-msg"></p>'
+ '<div class="qp-actions" hidden></div></div></div>'
+ '<div class="qp-bar">'
+ '<button class="qp-btn qp-play" type="button" aria-label="播放 / 暂停">⏸</button>'
+ '<input class="qp-seek" type="range" min="0" max="1000" value="0" aria-label="播放进度">'
+ '<span class="qp-time"><i class="qp-cur">00:00</i>/<i class="qp-dur">00:00</i></span>'
+ '<button class="qp-btn qp-mute" type="button" aria-label="静音">🔊</button>'
+ '<input class="qp-vol" type="range" min="0" max="100" value="100" aria-label="音量">'
+ '<button class="qp-btn qp-rate" type="button" aria-label="倍速">1.0×</button>'
+ '<button class="qp-btn qp-pip" type="button">画中画</button>'
+ '<button class="qp-btn qp-fs" type="button">全屏</button>'
+ '</div>'
+ '<div class="qp-nextbar" hidden><button class="qp-next" type="button">下一集 →</button>'
+ '<span class="qp-autonext"></span><button class="qp-cancel" type="button">取消</button></div>'
+ '<section class="qp-eps" data-open="1">'
+ '<div class="qp-eps-h"><h4>选集</h4><span class="qp-eps-hint"></span>'
+ '<button class="qp-eps-toggle" type="button">收起</button></div>'
+ '<div class="qp-eps-list" role="listbox" aria-label="选集"></div>'
+ '</section>'
+ '<section class="qp-lines" data-open="0">'
+ '<div class="qp-lines-h"><h4>线路</h4><button class="qp-lines-toggle" type="button">展开</button></div>'
+ '<div class="qp-lines-body">'
+ '<input class="qp-line-url" type="url" placeholder="粘贴 m3u8 / mp4 直链（自备源）" aria-label="线路地址">'
+ '<input class="qp-line-label" type="text" placeholder="线路名称（可选）" aria-label="线路名称">'
+ '<button class="qp-btn qp-line-add" type="button">添加并播放</button>'
+ '<div class="qp-line-list"></div>'
+ '</div></section>';
var STATES = {
loading: { msg: '正在准备播放…' },
transcoding: { msg: '转码中… 约 1 分钟' },
none: { msg: '没有找到可播放的视频源' },
login: { msg: '登录后才能使用网盘播放' },
quota: { msg: '网盘空间不足，清理后再试' },
rebind: { msg: '夸克登录已失效，请重新扫码' },
error: { msg: '播放失败，请重试或换源' },
ready: { msg: '' }
};
var SEQ = 0;
var cur = null;              // 同一时刻只有一个播放器（弹窗是单例）
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function fmtTime(t) {
t = Math.max(0, Math.floor(Number(t) || 0));
var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
return (h ? h + ':' + pad2(m) : pad2(m)) + ':' + pad2(s);
}
function rateLabel(r) { return (r % 1 === 0 ? r.toFixed(1) : String(r)) + '×'; }
function isUrl(u) {
u = String(u || '');
return /^(https?:|blob:)/i.test(u) || /^data:video\//i.test(u);
}
function typeOf(u) { return /\.m3u8(?:[?#]|$)/i.test(String(u || '')) ? 'hls' : 'mp4'; }
function hlsSupported(v) {
try { return !!(v && v.canPlayType && v.canPlayType('application/vnd.apple.mpegurl')); }
catch (e) { return false; }
}
function labelOf(u) {
try { return new URL(u).hostname || '直链'; } catch (e) { return '直链'; }
}
function readStore() {
try {
var v = JSON.parse(localStorage.getItem(QP_LINES_KEY) || '{}');
return v && typeof v === 'object' && Object.prototype.toString.call(v) !== '[object Array]' ? v : {};
} catch (e) { return {}; }
}
function writeStore(obj) {
try { localStorage.setItem(QP_LINES_KEY, JSON.stringify(obj)); } catch (e) { /* 隐私模式 / 配额满：静默 */ }
}
function byoOf(id) {
var arr = readStore()[String(id)];
return Object.prototype.toString.call(arr) === '[object Array]' ? arr : [];
}
function cleanLine(x) {
if (!x || !isUrl(x.url)) return null;
var u = String(x.url);
return { label: String(x.label || ''), url: u, type: x.type === 'hls' ? 'hls' : typeOf(u) };
}
function saveByo(id, rec) {
var all = readStore(), k = String(id), arr = byoOf(k), out = [];
for (var i = 0; i < arr.length; i++) {
var x = cleanLine(arr[i]);
if (!x || x.url === rec.url) continue;      // 同 URL 去重：新记录排最前
out.push(x);
}
out.unshift({ label: String(rec.label || ''), url: rec.url, type: rec.type === 'hls' ? 'hls' : typeOf(rec.url) });
all[k] = out.slice(0, QP_LINE_MAX);
writeStore(all);
}
function delByo(id, url) {
var all = readStore(), k = String(id), arr = byoOf(k), out = [];
for (var i = 0; i < arr.length; i++) {
var x = cleanLine(arr[i]);
if (x && x.url !== url) out.push(x);
}
all[k] = out;
writeStore(all);
}
function alive(S) { return !!(S && !S.dead && S.root && S.root.isConnected); }
function addLine(S, src) {
if (!src || !isUrl(src.url)) return -1;
var url = String(src.url);
for (var i = 0; i < S.lines.length; i++) {
if (S.lines[i].url === url) {
if (src.label) S.lines[i].label = String(src.label).trim() || S.lines[i].label;
return i;                                 // 同地址只留一条（换 label 不必重开）
}
}
S.lines.push({
label: String(src.label || '').trim() || labelOf(url),
url: url,
type: src.type === 'hls' || src.type === 'mp4' ? src.type : typeOf(url),
kind: src.kind === 'byo' ? 'byo' : 'official',
fid: String(src.fid || ''),
tried: false,
err: ''
});
return S.lines.length - 1;
}
function renderLines(S) {
var box = S.root.querySelector('.qp-line-list');
if (!box) return;
box.innerHTML = S.lines.map(function (l, i) {
var on = i === S.lineIdx;
var cls = 'qp-line' + (on ? ' on' : '') + (l.tried && !on ? ' is-bad' : '');
return '<span class="qp-line-row">'
+ '<button class="' + cls + '" type="button" data-i="' + i + '" title="'
+ esc(l.err || l.url) + '">' + esc(l.label) + '</button>'
+ (l.kind === 'byo'
? '<button class="qp-line-del" type="button" data-i="' + i + '" aria-label="删除线路">×</button>'
: '')
+ '</span>';
}).join('');
}
function renderEps(S, hint) {
if (hint !== undefined) S.epsHint = String(hint || '');
var list = S.root.querySelector('.qp-eps-list');
if (!list) return;
list.innerHTML = S.eps.map(function (e) {
var on = Number(e.ep) === Number(S.ep);
return '<button class="qp-ep' + (on ? ' on' : '') + '" type="button" role="option" data-ep="'
+ e.ep + '" aria-selected="' + (on ? 'true' : 'false') + '">' + esc(e.label) + '</button>';
}).join('');
var h = S.root.querySelector('.qp-eps-hint');
if (h) h.textContent = S.epsHint;
}
function defaultEpsHint(list) {
return list.length ? list.length + ' 集' : '暂无选集信息';
}
function updateSub(S) {
var sub = S.root.querySelector('.qp-sub');
if (!sub) return;
var bits = [];
if (S.ep > 0) bits.push('第 ' + S.ep + ' 集');
var l = S.lines[S.lineIdx];
if (l) bits.push(l.label);
sub.textContent = bits.join(' · ');
}
function toggleSec(sec, btnSel) {
if (!sec) return;
var open = sec.getAttribute('data-open') !== '1';
sec.setAttribute('data-open', open ? '1' : '0');
var b = sec.querySelector(btnSel);
if (b) b.textContent = open ? '收起' : '展开';
}
function setSecOpen(sec, btnSel, open) {
if (!sec) return;
sec.setAttribute('data-open', open ? '1' : '0');
var b = sec.querySelector(btnSel);
if (b) b.textContent = open ? '收起' : '展开';
}
function actionsFor(S, s) {
if (s === 'login') return [{ label: '登录', fn: function () { if (window.__openLogin) window.__openLogin('email'); } }];
if (s === 'rebind') return [{ label: '去扫码', href: QP_REBIND }];
if (s === 'quota') return [{ label: '重试', fn: function () { retry(S); } }];
if (s === 'error') return [
{ label: '重试', fn: function () { retry(S); } },
{ label: '换源', fn: function () { setSecOpen(S.root.querySelector('.qp-lines'), '.qp-lines-toggle', true); } }
];
if (s === 'none') return [{ label: '换源', fn: function () { setSecOpen(S.root.querySelector('.qp-lines'), '.qp-lines-toggle', true); } }];
return [];
}
function setState(S, s, extra) {
if (!alive(S)) return;
var def = STATES[s] || STATES.loading;
var x = extra || {};
S.state = s;
S.root.setAttribute('data-state', s);
var msg = S.root.querySelector('.qp-msg');
if (msg) msg.textContent = x.msg || def.msg || '';
var box = S.root.querySelector('.qp-actions');
if (box) {
var acts = x.actions || actionsFor(S, s);
box.textContent = '';
if (!acts.length) box.hidden = true;
else {
box.hidden = false;
acts.forEach(function (a) {
var b;
if (a && a.href) {
b = document.createElement('a');
b.className = 'btn qp-act';
b.href = a.href;
b.target = '_blank';
b.rel = 'noopener';
} else {
b = document.createElement('button');
b.className = 'btn qp-act';
b.type = 'button';
b.onclick = function () { if (alive(S) && typeof a.fn === 'function') a.fn(); };
}
b.textContent = (a && a.label) || '';
box.appendChild(b);
});
}
}
if (s !== 'loading' && s !== 'transcoding') hideBigPlay(S);
}
function state(s, extra) {
if (!cur) return;
setState(cur, s, extra);
}
function showBigPlay(S) {
var b = S.root && S.root.querySelector('.qp-bigplay');
if (b) b.hidden = false;
}
function hideBigPlay(S) {
var b = S.root && S.root.querySelector('.qp-bigplay');
if (b) b.hidden = true;
}
function nextUntried(S) {
var n = S.lines.length;
if (!n) return -1;
var from = S.lineIdx;
for (var k = 1; k <= n; k++) {
var i = (from + k + n) % n;
if (i === from) continue;
if (!S.lines[i].tried && S.lines[i].url) return i;
}
return -1;
}
function retry(S) {
if (!alive(S)) return;
var l = S.lines[S.lineIdx];
if (!l || l.kind !== 'byo') {
if (typeof S.ctx.onRetry === 'function') { S.ctx.onRetry(); return; }
}
for (var i = 0; i < S.lines.length; i++) S.lines[i].tried = false;
renderLines(S);
if (S.lineIdx >= 0) startLine(S, S.lineIdx);
else if (S.lines.length) startLine(S, 0);
}
function onLoadFail(S, line) {
if (!alive(S)) return;
clearStall(S);
if (line) { line.tried = true; line.err = '加载失败'; }
renderLines(S);
var next = nextUntried(S);
if (next >= 0) { startLine(S, next); return; }       // 失败回退：自动切下一条线路
setState(S, 'error', { msg: '播放失败，试试换一条线路' });
}
function startLine(S, idx) {
var line = S.lines[idx];
if (!alive(S) || !line) return false;
if (line.type === 'hls' && !S.hlsOk) {
line.tried = true;
line.err = '此浏览器不支持 HLS';
renderLines(S);
var nx = nextUntried(S);
if (nx >= 0) return startLine(S, nx);
setState(S, 'error', { msg: '此浏览器不支持 HLS，请用 Safari 或换 mp4 源' });
return false;
}
S.lineIdx = idx;
S.fid = String(line.fid || '');          // 换到自备源 / 另一条官方源时，进度不能记到上一条的 fid 上
S.resumeDone = !(S.resumeAt > 0);
renderLines(S);
updateSub(S);
setState(S, 'loading', { msg: '正在加载 ' + line.label + '…' });
clearStall(S);
try { S.v.pause(); } catch (e) { /* 未加载时 pause 会抛，忽略 */ }
S.v.setAttribute('src', line.url);       // 签名直链带 & ?：属性赋值不经 HTML 转义
try { if (S.v.load) S.v.load(); } catch (e) { /* 忽略 */ }
var p = null;
try { p = S.v.play(); } catch (e) { p = null; }
if (p && typeof p.then === 'function') {
p.then(null, function (err) {
if (!alive(S)) return;
if (err && err.name === 'NotAllowedError') {      // 自动播放被拦：给大字按钮，不当作失败
setState(S, 'ready');
showBigPlay(S);
return;
}
onLoadFail(S, line);
});
} else if (!p) {
onLoadFail(S, line);
}
return true;
}
function play(url, label, opt) {
var S = cur;
if (!alive(S)) return false;
if (!isUrl(url)) { setState(S, 'error', { msg: '视频地址无效' }); return false; }
var o = opt || {};
if (o.startAt != null) S.resumeAt = Math.max(0, Number(o.startAt) || 0);
if (o.fid) S.fid = String(o.fid);
var idx = addLine(S, { url: url, label: label || '直链', kind: 'official', fid: o.fid });
for (var i = 0; i < S.lines.length; i++) S.lines[i].tried = false;   // 新地址 = 重新开始一轮回退
renderLines(S);
return startLine(S, idx);
}
function setSources(list) {
var S = cur;
if (!alive(S)) return;
S.lines = S.lines.filter(function (l) { return l.kind === 'byo'; });
(list || []).forEach(function (src) { if (src && src.url) addLine(S, src); });
if (S.lineIdx >= S.lines.length) S.lineIdx = -1;
renderLines(S);
updateSub(S);
}
function setEpisodes(list, curEp, hint) {
var S = cur;
if (!alive(S)) return;
var out = [];
(list || []).forEach(function (it) {
if (it == null) return;
var ep = Number(it.ep != null ? it.ep : it);
if (!(ep > 0) || ep !== Math.floor(ep)) return;
out.push({
ep: ep,
label: String((it && it.label) || pad2(ep)),
fid: String((it && it.fid) || ''),
magnet: String((it && it.magnet) || '')
});
});
S.eps = out;
var n = Number(curEp);
if (n > 0) S.ep = n;
renderEps(S, hint !== undefined ? hint : defaultEpsHint(out));
updateSub(S);
}
function setFid(fid) {
if (cur) cur.fid = String(fid == null ? '' : fid);
}
function pause() {
if (!alive(cur)) return;
try { cur.v.pause(); } catch (e) { /* 忽略 */ }
}
function gate(prevPos, pos, lastMs, nowMs) {
var dp = Math.abs(Number(pos) - Number(prevPos));
var dt = Number(nowMs) - Number(lastMs);
if (!lastMs) return { send: true, dp: dp, dt: 0 };
return { send: dt >= 5000 && dp >= 5, dp: dp, dt: dt };
}
function report(S, final, atEnd) {
if (!alive(S)) return;
var v = S.v;
var dur = Number(v.duration) || 0;
var pos = atEnd ? dur : Number(v.currentTime) || 0;
if (!(dur > 0) || !(pos >= 0)) return;
S.lastMs = Date.now();
S.lastPos = pos;
var payload = {
ep: S.ep,
fid: S.fid,
pos: Math.round(pos * 10) / 10,
dur: Math.round(dur * 10) / 10
};
if (final) payload.final = true;
if (typeof S.ctx.onProgress === 'function') {
try { S.ctx.onProgress(payload); } catch (e) { /* 上报失败不影响播放 */ }
}
}
function paint(S) {
if (!alive(S)) return;
var v = S.v, d = Number(v.duration) || 0, p = Number(v.currentTime) || 0;
var seek = S.root.querySelector('.qp-seek');
if (seek && !S.seekDrag) seek.value = String(d > 0 ? Math.round(p / d * 1000) : 0);
var curEl = S.root.querySelector('.qp-cur');
var durEl = S.root.querySelector('.qp-dur');
if (curEl) curEl.textContent = fmtTime(p);
if (durEl) durEl.textContent = fmtTime(d);
var btn = S.root.querySelector('.qp-play');
if (btn) btn.textContent = v.paused ? '▶' : '⏸';
var mute = S.root.querySelector('.qp-mute');
if (mute) mute.textContent = (v.muted || !v.volume) ? '🔇' : '🔊';
var rate = S.root.querySelector('.qp-rate');
if (rate) rate.textContent = rateLabel(Number(v.playbackRate) || 1);
var fs = S.root.querySelector('.qp-fs');
if (fs) {
var full = !!(document.fullscreenElement || document.webkitFullscreenElement);
fs.textContent = full ? '退出全屏' : '全屏';
}
}
function schedule(S) {
if (!alive(S) || S.pending) return;
S.pending = true;
var raf = window.requestAnimationFrame || function (cb) { return setTimeout(cb, 16); };
raf(function () { S.pending = false; paint(S); });
}
function armStall(S) {
if (!alive(S) || S.stallTimer) return;
S.stallTimer = setTimeout(function () {
S.stallTimer = 0;
if (!alive(S)) return;
if (S.v.readyState >= 2) return;            // 已经有数据，只是短暂缓冲
onLoadFail(S, S.lines[S.lineIdx]);
}, 15000);
}
function clearStall(S) {
if (S.stallTimer) { clearTimeout(S.stallTimer); S.stallTimer = 0; }
}
function cancelNext(S) {
if (S.nextTimer) { clearInterval(S.nextTimer); S.nextTimer = 0; }
var bar = S.root && S.root.querySelector('.qp-nextbar');
if (bar) bar.hidden = true;
}
function goNext(S, auto) {
cancelNext(S);
if (!alive(S)) return;
if (auto) {
if (typeof S.ctx.onEnded === 'function') { S.ctx.onEnded(); return; }
}
if (typeof S.ctx.onNext === 'function') { S.ctx.onNext(); return; }
if (typeof S.ctx.onEnded === 'function') S.ctx.onEnded();
}
function showNext(S) {
var bar = S.root.querySelector('.qp-nextbar');
if (!bar) return;
var hint = S.root.querySelector('.qp-autonext');
S.nextLeft = 5;
bar.hidden = false;
if (hint) hint.textContent = S.nextLeft + ' 秒后自动播放下一集';
if (S.nextTimer) clearInterval(S.nextTimer);
S.nextTimer = setInterval(function () {
if (!alive(S)) { cancelNext(S); return; }
S.nextLeft -= 1;
if (S.nextLeft > 0) {
if (hint) hint.textContent = S.nextLeft + ' 秒后自动播放下一集';
return;
}
goNext(S, true);
}, 1000);
}
function toggleFs(S) {
var d = document, root = S.root, v = S.v;
if (d.fullscreenElement || d.webkitFullscreenElement) {
try {
if (d.exitFullscreen) d.exitFullscreen();
else if (d.webkitExitFullscreen) d.webkitExitFullscreen();
} catch (e) { /* 忽略 */ }
return;
}
try {
if (root.requestFullscreen) root.requestFullscreen();
else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();     // iOS 只允许 video 元素
else if (v.webkitRequestFullscreen) v.webkitRequestFullscreen();
else if (v.requestFullscreen) v.requestFullscreen();
} catch (e) { /* 用户拒绝 / 不支持：保持原状 */ }
}
function togglePip(S) {
var v = S.v;
try {
if (document.pictureInPictureElement) { document.exitPictureInPicture(); return; }
if (v.requestPictureInPicture) v.requestPictureInPicture();
} catch (e) { /* 忽略 */ }
}
function bind(S) {
var v = S.v, root = S.root;
function q(sel) { return root.querySelector(sel); }
v.addEventListener('loadedmetadata', function () {
if (!alive(S)) return;
if (!S.resumeDone && S.resumeAt > 0) {
S.resumeDone = true;
var d = Number(v.duration) || 0;
if (!(d > 0) || S.resumeAt < d - 5) {
try { v.currentTime = S.resumeAt; } catch (e) { /* 忽略 */ }
}
}
schedule(S);
});
v.addEventListener('playing', function () {
if (!alive(S)) return;
clearStall(S);
hideBigPlay(S);
if (S.state !== 'ready') setState(S, 'ready');
schedule(S);
});
v.addEventListener('timeupdate', function () {
if (!alive(S)) return;
schedule(S);
var pos = Number(v.currentTime) || 0;
if (gate(S.lastPos, pos, S.lastMs, Date.now()).send) report(S, false);
});
v.addEventListener('pause', function () {
if (!alive(S)) return;
schedule(S);
report(S, false);
});
v.addEventListener('play', function () { schedule(S); });
v.addEventListener('seeked', function () {
if (!alive(S)) return;
if (S.seekTimer) clearTimeout(S.seekTimer);
S.seekTimer = setTimeout(function () {
S.seekTimer = 0;
report(S, false);                       // 拖动结束 800ms 后再报，避免拖一次发几十条
}, 800);
schedule(S);
});
v.addEventListener('waiting', function () { if (alive(S)) armStall(S); });
v.addEventListener('stalled', function () { if (alive(S)) armStall(S); });
v.addEventListener('error', function () { onLoadFail(S, S.lines[S.lineIdx]); });
v.addEventListener('volumechange', function () {
if (!alive(S)) return;
var vol = q('.qp-vol');
if (vol) vol.value = String(Math.round((v.muted ? 0 : v.volume) * 100));
schedule(S);
});
v.addEventListener('ratechange', function () { schedule(S); });
v.addEventListener('ended', function () {
if (!alive(S)) return;
report(S, true, true);                     // 先把 pos=dur 记下，再谈下一集
showNext(S);
schedule(S);
});
v.addEventListener('click', function () {
if (!alive(S)) return;
try { root.focus({ preventScroll: true }); } catch (e) { try { root.focus(); } catch (e2) {} }
togglePlay(S);
});
var big = q('.qp-bigplay');
if (big) big.onclick = function () {
if (!alive(S)) return;
hideBigPlay(S);
var p = v.play();
if (p && p.then) p.then(null, function () { showBigPlay(S); });
};
var closeBtn = q('.qp-close');
if (closeBtn) closeBtn.onclick = function () { close(); };
var playBtn = q('.qp-play');
if (playBtn) playBtn.onclick = function () { togglePlay(S); };
var muteBtn = q('.qp-mute');
if (muteBtn) muteBtn.onclick = function () {
v.muted = !v.muted;
if (!v.muted && !v.volume) v.volume = 0.6;
};
var seek = q('.qp-seek');
if (seek) {
seek.addEventListener('pointerdown', function () { S.seekDrag = true; });
seek.addEventListener('input', function () {
S.seekDrag = true;
var d = Number(v.duration) || 0;
if (d > 0) {
var t = d * (Number(seek.value) || 0) / 1000;
try { v.currentTime = Math.max(0, Math.min(d - 0.1, t)); } catch (e) { /* 忽略 */ }
}
});
seek.addEventListener('change', function () { S.seekDrag = false; schedule(S); });
seek.addEventListener('pointerup', function () { S.seekDrag = false; });
seek.addEventListener('blur', function () { S.seekDrag = false; });
}
var vol = q('.qp-vol');
if (vol) vol.addEventListener('input', function () {
var x = Math.max(0, Math.min(100, Number(vol.value) || 0));
v.volume = x / 100;
v.muted = x === 0;
});
var rate = q('.qp-rate');
if (rate) rate.onclick = function () {
var i = QP_RATES.indexOf(Number(v.playbackRate) || 1);
i = (i < 0 ? 3 : i + 1) % QP_RATES.length;
try { v.playbackRate = QP_RATES[i]; } catch (e) { /* 忽略 */ }
rate.textContent = rateLabel(QP_RATES[i]);
};
var pip = q('.qp-pip');
if (pip) {
if (document.pictureInPictureEnabled && v.requestPictureInPicture) {
pip.onclick = function () { togglePip(S); };
} else {
pip.hidden = true;
}
}
var fs = q('.qp-fs');
if (fs) fs.onclick = function () { toggleFs(S); };
var nextBtn = q('.qp-next');
if (nextBtn) nextBtn.onclick = function () { goNext(S, false); };
var cancelBtn = q('.qp-cancel');
if (cancelBtn) cancelBtn.onclick = function () { cancelNext(S); };
var epsSec = q('.qp-eps');
var epsToggle = q('.qp-eps-toggle');
if (epsToggle) epsToggle.onclick = function () { toggleSec(epsSec, '.qp-eps-toggle'); };
var linesSec = q('.qp-lines');
var linesToggle = q('.qp-lines-toggle');
if (linesToggle) linesToggle.onclick = function () { toggleSec(linesSec, '.qp-lines-toggle'); };
var epsList = q('.qp-eps-list');
if (epsList) epsList.addEventListener('click', function (ev) {
var t = ev.target;
var b = t && t.closest ? t.closest('.qp-ep') : null;
if (!b || !alive(S)) return;
var ep = Number(b.getAttribute('data-ep'));
if (!(ep > 0) || ep === Number(S.ep)) return;
S.ep = ep;
renderEps(S, S.epsHint);
updateSub(S);
if (window.innerWidth <= 760) setSecOpen(epsSec, '.qp-eps-toggle', false);   // 手机上点完自动收起
if (typeof S.ctx.onPickEp === 'function') S.ctx.onPickEp(ep);
});
var lineList = q('.qp-line-list');
if (lineList) lineList.addEventListener('click', function (ev) {
var t = ev.target;
if (!t || !t.classList || !alive(S)) return;
if (t.classList.contains('qp-line-del')) {
var di = Number(t.getAttribute('data-i'));
var dl = S.lines[di];
if (!dl || dl.kind !== 'byo') return;
delByo(S.id, dl.url);
S.lines.splice(di, 1);
if (di < S.lineIdx) S.lineIdx -= 1;
else if (di === S.lineIdx) S.lineIdx = -1;
renderLines(S);
updateSub(S);
return;
}
if (t.classList.contains('qp-line')) {
var i = Number(t.getAttribute('data-i'));
if (!(i >= 0) || i >= S.lines.length) return;
for (var k = 0; k < S.lines.length; k++) S.lines[k].tried = false;
startLine(S, i);
}
});
var urlIn = q('.qp-line-url');
var labIn = q('.qp-line-label');
var addBtn = q('.qp-line-add');
if (addBtn) addBtn.onclick = function () {
if (!alive(S)) return;
var url = String((urlIn && urlIn.value) || '').trim();
var label = String((labIn && labIn.value) || '').trim();
if (!/^https?:\/\//i.test(url)) {
var old = addBtn.textContent;
addBtn.textContent = '请粘贴 http(s) 直链';
setTimeout(function () { if (addBtn.isConnected) addBtn.textContent = old; }, 1400);
return;
}
var type = typeOf(url);
saveByo(S.id, { label: label || labelOf(url), url: url, type: type });
if (urlIn) urlIn.value = '';
if (labIn) labIn.value = '';
var idx = addLine(S, { url: url, label: label, kind: 'byo' });
for (var k = 0; k < S.lines.length; k++) S.lines[k].tried = false;
renderLines(S);
startLine(S, idx);
};
root.addEventListener('keydown', function (ev) {
if (!alive(S)) return;
var t = ev.target;
var tag = t && t.tagName ? String(t.tagName).toUpperCase() : '';
if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;   // 滑块/输入框自己处理方向键
var k = ev.key;
if (k === ' ' || k === 'Spacebar') {
if (tag === 'BUTTON' || tag === 'A') return;    // 让获得焦点的按钮自己响应空格
ev.preventDefault();
togglePlay(S);
} else if (k === 'ArrowLeft') {
ev.preventDefault(); seekBy(S, -5);
} else if (k === 'ArrowRight') {
ev.preventDefault(); seekBy(S, 5);
} else if (k === 'ArrowUp') {
ev.preventDefault(); bumpVolume(S, 0.1);
} else if (k === 'ArrowDown') {
ev.preventDefault(); bumpVolume(S, -0.1);
} else if (k === 'f' || k === 'F') {
ev.preventDefault(); toggleFs(S);
} else if (k === 'm' || k === 'M') {
ev.preventDefault(); S.v.muted = !S.v.muted;
}
});
S.onVis = function () {
if (document.visibilityState === 'hidden') report(S, true);
};
S.onPageHide = function () { report(S, true); };
document.addEventListener('visibilitychange', S.onVis);
window.addEventListener('pagehide', S.onPageHide);
}
function togglePlay(S) {
if (!alive(S)) return;
var v = S.v;
if (v.paused) {
var p = v.play();
if (p && p.then) p.then(null, function () { showBigPlay(S); });
} else {
v.pause();
}
}
function seekBy(S, delta) {
var v = S.v, d = Number(v.duration) || 0;
if (!(d > 0)) return;
try { v.currentTime = Math.max(0, Math.min(d, (Number(v.currentTime) || 0) + delta)); } catch (e) { /* 忽略 */ }
}
function bumpVolume(S, delta) {
var v = S.v;
var x = Math.max(0, Math.min(1, (Number(v.volume) || 0) + delta));
v.volume = x;
if (x > 0 && v.muted) v.muted = false;
}
function open(ctx) {
var m = ctx && ctx.m;
if (!m) return 0;
close();                                    // 同一弹窗只允许一个实例
var old = m.querySelector('.trailer');
if (old && old.parentNode) {
var ov = old.querySelector('video');
if (ov) {
try { ov.pause(); ov.removeAttribute('src'); if (ov.load) ov.load(); } catch (e) { /* 忽略 */ }
}
old.parentNode.removeChild(old);
}
var root = document.createElement('div');
root.className = 'trailer qplayer';
root.setAttribute('data-state', 'loading');
root.setAttribute('tabindex', '0');
root.innerHTML = TPL;
var v = root.querySelector('.qp-video');
var S = {
tok: ++SEQ,
ctx: ctx || {},
m: m,
root: root,
v: v,
id: String(ctx.id == null ? '' : ctx.id),
title: String(ctx.title || ''),
ep: Number(ctx.ep) > 0 ? Number(ctx.ep) : 0,
fid: '',
state: 'loading',
lines: [],
lineIdx: -1,
eps: [],
epsHint: '',
hlsOk: hlsSupported(v),
resumeAt: Math.max(0, Number(ctx.startAt) || 0),
resumeDone: false,
lastMs: 0,
lastPos: 0,
seekDrag: false,
pending: false,
nextTimer: 0,
nextLeft: 0,
stallTimer: 0,
seekTimer: 0,
dead: false
};
cur = S;
root.querySelector('.qp-title').textContent = S.title || '在线播放';
bind(S);
renderEps(S, S.eps.length ? '' : '正在读取选集…');
renderLines(S);
updateSub(S);
(ctx.sources || []).forEach(function (src) { if (src && src.url) addLine(S, src); });
renderLines(S);
m.appendChild(root);
try { root.scrollIntoView({ block: 'center' }); } catch (e) { /* 忽略 */ }
if (S.lines.length) startLine(S, 0);
else setState(S, 'loading', { msg: '正在准备播放…' });
return S.tok;
}
function close() {
var S = cur;
if (!S) return;                             // 幂等
cur = null;
S.dead = true;
if (S.nextTimer) { clearInterval(S.nextTimer); S.nextTimer = 0; }
clearStall(S);
if (S.seekTimer) { clearTimeout(S.seekTimer); S.seekTimer = 0; }
try { document.removeEventListener('visibilitychange', S.onVis); } catch (e) { /* 忽略 */ }
try { window.removeEventListener('pagehide', S.onPageHide); } catch (e) { /* 忽略 */ }
try {
S.v.pause();
S.v.removeAttribute('src');
if (S.v.load) S.v.load();                 // 断流：否则移除节点后仍可能继续取流
} catch (e) { /* 忽略 */ }
if (S.root && S.root.parentNode) S.root.parentNode.removeChild(S.root);
S.lines = [];
S.eps = [];
}
function isCurrent(tok) {
return !!cur && !!tok && cur.tok === tok && isConn(cur.root);
}
function isConn(node) { return !!(node && node.isConnected); }
return {
open: open,
close: close,
state: state,
play: play,
setSources: setSources,
setEpisodes: setEpisodes,
setFid: setFid,
pause: pause,
isCurrent: isCurrent,
_gate: gate,                                 // 离线自检：进度节流是纯函数
_lines: { of: byoOf, save: saveByo, del: delByo }
};
})();
window.QPlayer = QPlayer;
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