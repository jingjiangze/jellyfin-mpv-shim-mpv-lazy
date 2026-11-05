(function () {
'use strict';
var ENTRY = null, LOADING = false, LAST_NAME = null, BASE_I = -1, MANIFEST = null;
var REV = '';                        // reload() 期间的时间戳：只用于绕 HTTP 缓存
var EPOCH = 0;
var CUR_BOX = null, CUR_STATE = null;
var BASES = [
'https://modelscope.cn/datasets/jingjiangze/Anime-JPG/resolve/master/assets/eps/',
'https://gcore.jsdelivr.net/gh/jingjiangze/jellyfin-mpv-shim-mpv-lazy@main/media/eps/',
'https://gh-proxy.com/https://raw.githubusercontent.com/jingjiangze/jellyfin-mpv-shim-mpv-lazy/main/media/eps/',
'https://raw.githubusercontent.com/jingjiangze/jellyfin-mpv-shim-mpv-lazy/main/media/eps/'
];
var SHARDS = 16;
var CACHE = {};                      // shardNo -> { 归一化片名: 条目 }
function hashOf(str) {
var h = 0, i = 0, s = String(str || '');
while (i < s.length) {
var cp = s.codePointAt(i);
i += cp > 0xffff ? 2 : 1;
h = (h * 31 + cp) % 4294967296;
}
return h;
}
function shardOf(name) { return hashOf(String(name || '').trim()) % SHARDS; }
var RE_SEASON = /(第\s*[一二三四五六七八九十\d]+\s*[季期]|Season\s*\d+|Part\.?\s*\d+|\bS\d{1,2}\b|[ⅡⅢⅣⅤⅥ])/i;
var NUM = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
'Ⅱ': 2, 'Ⅲ': 3, 'Ⅳ': 4, 'Ⅴ': 5, 'Ⅵ': 6 };
function norm(s) {
s = String(s || '').toLowerCase();
s = s.replace(/[（）【】：]/g, function (c) {
return { '（': '(', '）': ')', '【': '[', '】': ']', '：': ':' }[c];
});
return s.replace(/[\s\-_.·・:：!！?？,，。'"()\[\]（）【】～~]/g, '');
}
function seasonsOf(s) {
var out = {}, m, str = String(s || '');
var re = new RegExp(RE_SEASON.source, 'gi');
while ((m = re.exec(str))) {
var raw = m[1];
var d = raw.match(/\d+/);
var n = 0;
if (d) n = Number(d[0]);
else { /* 「第二季」末字是「季」不是「二」，先剥掉修饰字再查数字表 */
var core = raw.replace(/[第季期部分]/gi, '').trim();
n = NUM[core.charAt(core.length - 1)] || 0;
}
if (!n) continue;
out[(/Part/i.test(raw) ? 'part' : 's') + n] = 1;
}
return out;
}
function sameSeasons(a, b) {
var ka = Object.keys(a), kb = Object.keys(b);
if (!ka.length && !kb.length) return true;
if (ka.length !== kb.length) return false;
for (var i = 0; i < ka.length; i++) if (kb.indexOf(ka[i]) < 0) return false;
return true;
}
function getJSON(url, ms) {
var ctl = typeof AbortController === 'function' ? new AbortController() : null;
var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms || 9000);
return fetch(url, ctl ? { signal: ctl.signal } : undefined).then(function (r) {
clearTimeout(timer);
if (!r.ok) throw new Error('HTTP ' + r.status);
return r.json();
}, function (e) {
clearTimeout(timer);
throw e;
});
}
function bustUrl() {
if (REV) return '?v=' + REV;
if (MANIFEST && MANIFEST.v) return '?v=' + encodeURIComponent(String(MANIFEST.v));
return '';
}
function loadManifest() {
if (MANIFEST) return Promise.resolve(MANIFEST);
var i = 0;
return new Promise(function (resolve, reject) {
(function next() {
if (i >= BASES.length) return reject(new Error('no manifest'));
var at = i++;
getJSON(BASES[at] + 'index.json' + bustUrl()).then(function (m) {
if (!m || !m.shards || !m.count) throw new Error('bad manifest');
MANIFEST = m;
BASE_I = at;
resolve(m);
}).catch(next);
})();
});
}
function loadShard(n) {
if (CACHE[n]) return Promise.resolve(CACHE[n]);
var order = [], i;
if (BASE_I >= 0) order.push(BASE_I);
for (i = 0; i < BASES.length; i++) if (order.indexOf(i) < 0) order.push(i);
var k = 0;
return new Promise(function (resolve, reject) {
(function next() {
if (k >= order.length) return reject(new Error('shard ' + n + ' unavailable'));
var at = order[k++];
getJSON(BASES[at] + 's' + (n < 10 ? '0' + n : n) + '.json' + bustUrl()).then(function (d) {
if (!d) throw new Error('empty shard');
CACHE[n] = d;
resolve(d);
}).catch(next);
})();
});
}
var LIVE = {}, LIVE_DOWN = false;
var NEED_LOGIN = false;
var LIVE_URL = 'https://120.48.56.189/eps';
var TOKEN_KEY = 'gh_token';
function authToken() {
try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
}
var RE_RANGE = /第\s*(\d{1,4})\s*[-–~〜]\s*(\d{1,4})\s*[話话集]/;
var RE_SINGLE = /第\s*(\d{1,4})\s*[話话集](?!\d)/;
var RE_BRACKET = /[\]\)\s\-–—]\s*\[?(\d{1,4})\]?(?=\s*(?:\[|\(|END|完|【|v\d|$))/;
var RE_EP = /(?:^|[\s\-–—\[])[Ee][Pp]?(\d{1,4})\b/i;
var RE_DASH = /\s-\s*(\d{1,4})(?:v\d)?\s*(?:\[|\(|$)/;
var RE_SXXEXX = /(?:^|[^A-Za-z])S(\d{1,2})\s*E(\d{1,4})\b/i;
var NOISE = /(OP\d?テーマ|ED\d?テーマ|OPテーマ|EDテーマ|主題歌|主题歌|挿入歌|オリジナルサウンドトラック|サントラ|Soundtrack|\bBatch\b|全集|合集|Complete|BDBOX|BOX\s*SET|DVDISO|BDISO|\bvol\.?\s*\d+|\d+\s*[巻卷]|漫画|コミック|小説|小说)/i;
var RE_PACK = /[\[\(【]\s*\d{1,3}\s*[-–~〜]\s*\d{1,3}\s*[\]\)】]|\b\d{1,3}\s*[-–~〜]\s*\d{1,3}\s*[话話集]/;
function parseEpsTitle(t) {
var m = RE_RANGE.exec(t);
if (m) {
var a = +m[1], b = +m[2], out = [];
if (b - a < 0 || b - a > 200) return out;
for (var i = a; i <= b; i++) out.push(i);
return out;
}
var rxs = [RE_SINGLE, RE_DASH, RE_EP, RE_SXXEXX, RE_BRACKET];
for (var k = 0; k < rxs.length; k++) {
var x = rxs[k].exec(t);
if (x) {
var n = +(x[2] != null ? x[2] : x[1]);   // SxxExx 取 E 后面的集号
return (n > 0 && n <= 999) ? [n] : [];
}
}
return [];
}
function buildEps(name, orig, epsN, results) {
var q = norm(name), qo = norm(orig), qs = seasonsOf(name), short = q.length <= 3;
var onlyBatch = !!(epsN && epsN <= 2);   // 剧场版/OAD：只留合集，不给分集
var cand = {}, batch = [];
for (var i = 0; i < results.length; i++) {
var r = results[i];
var t = String(r.title || r.name || '');
if (!t || NOISE.test(t)) continue;
var pack = RE_PACK.test(t);
var mg = String(r.magnet || r.m || '');
if (mg.indexOf('magnet:') !== 0) continue;
var nt = norm(t);
var hitCn = q && nt.indexOf(q) >= 0;
var hitOrig = qo && qo.length >= 4 && nt.indexOf(qo) >= 0;
if (!hitCn && !hitOrig) continue;
if (short) {
var esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
if (!new RegExp('[\\[\\]【】()（）\\s\\-_/]' + esc + '[\\[\\]【】()（）\\s\\-_/]').test(t)) continue;
}
if (!sameSeasons(qs, seasonsOf(t))) continue;
var nums = parseEpsTitle(t);
var item = {
m: mg,
s: Number(r.size || 0),
sd: Number(r.seeders || 0),
sub: String(r.subs || r.sub || '').slice ? String(r.subs || r.sub || '').slice(0, 12) : '',
t: t.slice(0, 120)
};
if (pack || !nums.length) { batch.push(item); continue; }
if (nums.length > 3) { batch.push(item); continue; }  // 一条命中多集：与后端 packs 口径一致，进合集
if (onlyBatch) continue;              // epsN<=2：只收 batch，不写分集
for (var j = 0; j < nums.length; j++) {
var n = nums[j];
(cand[n] = cand[n] || []).push(item);
}
}
var eps = {};
for (var key in cand) {
cand[key].sort(function (a, b) { return (b.sd - a.sd) || (b.s - a.s); });
eps[key] = cand[key].slice(0, 2);
}
batch.sort(function (a, b) { return (b.sd - a.sd) || (b.s - a.s); });
return { eps: eps, batch: batch };
}
function episodeCount(m) {
var dts = m.querySelectorAll('.infobox dt');
for (var i = 0; i < dts.length; i++) {
if (String(dts[i].textContent).indexOf('话数') >= 0) {
var dd = dts[i].nextElementSibling;
var n = parseInt(String(dd && dd.textContent || '').replace(/[^0-9]/g, ''), 10);
return isNaN(n) ? 0 : n;
}
}
return 0;
}
function fetchLive(name, epsN, orig, force) {
if (!force && LIVE[name]) return Promise.resolve(LIVE[name]);
var u = LIVE_URL + '?kw=' + encodeURIComponent(name);
if (orig) u += '&o=' + encodeURIComponent(orig);
if (force) u += '&force=1';
var ctl = typeof AbortController === 'function' ? new AbortController() : null;
var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 15000);
var tk = authToken();
var opt = {};
if (ctl) opt.signal = ctl.signal;
if (tk) opt.headers = { authorization: 'Bearer ' + tk };
return fetch(u, opt).then(function (r) {
clearTimeout(timer);
if (r.status === 401) {
NEED_LOGIN = true;
var e401 = new Error('login_required');
e401.status = 401;
throw e401;
}
if (!r.ok) throw new Error('HTTP ' + r.status);
return r.json();
}).then(function (d) {
var eps = (d && d.eps && Object.keys(d.eps).length) ? d.eps : null;
var batch = (d && d.batch) || [];
if (!eps) {
var b = buildEps(name, orig, epsN, (d && d.results) || []);
eps = b.eps;
if (!batch.length) batch = b.batch;
}
if (!Object.keys(eps).length && !batch.length) return null;
var e = { n: name, eps: eps, batch: batch, live: 1 };
LIVE[name] = e;
try {
var tk2 = authToken();
var hdr2 = { 'content-type': 'text/plain;charset=UTF-8' };
if (tk2) hdr2.authorization = 'Bearer ' + tk2;
var ctl2 = typeof AbortController === 'function' ? new AbortController() : null;
var t2 = setTimeout(function () { if (ctl2) ctl2.abort(); }, 8000);
fetch(LIVE_URL + '-save', {
method: 'POST',
headers: hdr2,
body: JSON.stringify({ n: name, eps: eps, batch: (e && e.batch) || [] }),
signal: ctl2 ? ctl2.signal : undefined
}).then(function (r) {
clearTimeout(t2);
if (!r || !r.ok) return;
}, function () { clearTimeout(t2); });
} catch (err) { /* 忽略：只是入库，不影响展示 */ }
return e;
}).catch(function (err) {
if (err && err.status === 401) { NEED_LOGIN = true; return null; }
LIVE_DOWN = true;
return null;
});
}
function dbLive(name, bgm) {
var u = LIVE_URL + '?kw=' + encodeURIComponent(name) + '&db=1&_=' + Date.now();
if (bgm) u += '&bgm=' + encodeURIComponent(bgm);
return getJSON(u, 9000).then(function (d) {
if (!d || d.miss || d.ok === false) return null;
var eps = (d.eps && Object.keys(d.eps).length) ? d.eps : {};
var batch = d.batch || [];
if (!Object.keys(eps).length && !batch.length) return null;
return { n: name, eps: eps, batch: batch, db: 1, key: d.key || '' };
}).catch(function () { return null; });
}
function resolveEntry(name, bgm) {
if (!name) return Promise.resolve(null);
var n = shardOf(name);
return loadManifest().then(function () { return loadShard(n); })
.then(function (d) {
var byId = bgm ? (d && d[String(bgm)]) : null;
if (byId) { byId.key = String(bgm); return byId; }
return findByName(d, name);
})
.catch(function () { return null; });
}
function findByName(store, name) {
if (!store || !name) return null;
var q = norm(name);
if (!q) return null;
var qs = seasonsOf(name);
var best = null, bestScore = 0;
for (var k in store) {
var e = store[k];
var nt = norm(e && e.n);
if (!nt) continue;
var score = 0;
if (nt === q) score = (String(e.n).trim() === String(name).trim()) ? 2000 : 1000;
else if (nt.indexOf(q) >= 0 && q.length >= 5) score = 100 + q.length;
else if (q.indexOf(nt) >= 0 && nt.length >= 5 && nt.length >= q.length * 0.6) score = 50 + nt.length;
if (!score) continue;
if (q.length <= 3) score -= 200;            // 短名（乒乓/虫师）只信完全相同
if (score <= 0) continue;
if (!sameSeasons(qs, seasonsOf(e.n))) continue;   // 季号必须一致
if (score > bestScore) { bestScore = score; best = e; }
}
return best || null;
}
function fmtSize(n) {
n = Number(n) || 0;
if (n <= 0) return '';
var u = ['GB', 'MB', 'KB'], v = n / (1 << 30), i = 0;
if (v < 1) { v = n / (1 << 20); i = 1; }
if (v < 1 && i === 1) { v = n / 1024; i = 2; }
return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + u[i] || '';
}
function escAttr(s) {
return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
function cleanSub(s) {
s = String(s || '').replace(/[\[\]'"\s]/g, '');
return /^[无中简繁英日]+$/.test(s) ? s : '';
}
function chipOf(c, label) {
var mg = escAttr(c.m);
var bits = [], sub = cleanSub(c.sub);
if (c.s) bits.push(fmtSize(c.s));
if (c.sd) bits.push(c.sd + ' 种');
if (sub) bits.push('字幕 ' + sub);   // 不带字段名时「· 无 / · 中」看不出是什么
return '<span class="eps-chip" role="button" tabindex="0" data-m="' + mg + '" title="' +
escAttr(c.t) + '">' + label +
(bits.length ? ' · ' + bits.join(' · ') : '') + '</span>';
}
var RE_BATCH_RANGE = /\[\s*(\d{1,3})\s*[-–~〜]\s*(\d{1,3})\s*(?:END|完)?\s*\]/i;
var RE_BATCH_RANGE_CN = /第\s*(\d{1,3})\s*[-–~〜]\s*(\d{1,3})\s*[话話集]/;
function pad2(n) { return String(n).length < 2 ? '0' + n : String(n); }
function batchLabel(c, i) {
var t = String((c && c.t) || '');
var m = RE_BATCH_RANGE.exec(t) || RE_BATCH_RANGE_CN.exec(t);
if (m) {
var a = +m[1], b = +m[2];
if (b > a) return '合集 ' + pad2(a) + '–' + pad2(b);
}
return '合集 ' + (i + 1);
}
function descOf(c, max) {
var t = String((c && c.t) || '').replace(/\s+/g, ' ').trim();
if (!t) return '';
return t.length > max ? t.slice(0, max) + '…' : t;
}
function escText(s) {
return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function metaOf(c) {
var bits = [], sub = cleanSub(c && c.sub);
if (c && c.s) bits.push(fmtSize(c.s));
if (c && c.sd) bits.push(c.sd + ' 种');
if (sub) bits.push('字幕 ' + sub);   // 不带字段名时「· 无 / · 中」看不出是什么
return bits.join(' · ');
}
function rowOf(c, idx, ep) {
var t = String((c && c.t) || '').replace(/\s+/g, ' ').trim();
return '<button class="mgrow" type="button" data-m="' + escAttr(c && c.m) + '"'
+ (ep == null || ep === '' ? '' : ' data-ep="' + escAttr(ep) + '"')
+ (t ? ' title="' + escAttr(t) + '"' : '') + '>'
+ '<span class="mgidx">' + escText(idx) + '</span>'
+ '<span class="mgmain"><span class="mgt">' + escText(t) + '</span>'
+ '<span class="mgmeta">' + escText(metaOf(c)) + '</span></span>'
+ '<span class="mgcopy">复制</span>'
+ '</button>';
}
function sectHtml(title, sub, rows) {
return '<div class="mgsect"><div class="sec-h"><h2>' + escText(title) + '</h2>'
+ '<span class="sec-sub">' + escText(sub) + '</span></div>'
+ '<div class="mgrows">' + rows + '</div></div>';
}
var G_OTHER = '其他';
var RE_GPREFIX = /^[\[【]([^\]】]{1,40})[\]】]/;
function cleanGroupName(raw) {
var s = String(raw == null ? '' : raw).trim();
s = s.replace(/^[\[\]【】\s]+/, '').replace(/[\[\]【】\s]+$/, '');
s = s.replace(/\s*([\-–—_/~|&+·・])\s*/g, '$1');
s = s.replace(/\s+/g, ' ');
return s.trim();
}
function groupNameOf(item) {
var g = cleanGroupName(item && item.g);
if (g) return g;
var m = RE_GPREFIX.exec(String((item && item.t) || '').trim());
return cleanGroupName(m && m[1]) || G_OTHER;
}
function epNoOf(item, hint) {
var n = Number(hint);
if (n > 0) return n;
var t = String((item && item.t) || '');
if (!t || RE_PACK.test(t)) return null;
var nums = parseEpsTitle(t);
return nums.length === 1 ? nums[0] : null;
}
function groupCmp(a, b) {
if (a === b) return 0;
if (a === G_OTHER) return 1;
if (b === G_OTHER) return -1;
return String(a).localeCompare(String(b), 'zh');
}
function rowCmp(a, b) {
var an = a.ep == null, bn = b.ep == null;
if (an !== bn) return an ? 1 : -1;
if (!an && a.ep !== b.ep) return a.ep - b.ep;
var x = a.it || {}, y = b.it || {};
return ((Number(y.sd) || 0) - (Number(x.sd) || 0))
|| ((Number(y.s) || 0) - (Number(x.s) || 0));
}
function collectRows(a, b) {
var eps = {}, batch = [];
if (a && typeof a === 'object' && ('eps' in a || 'batch' in a)) {
eps = a.eps || {};
batch = a.batch || [];
} else {
eps = a || {};
batch = b || [];
}
var out = [];
Object.keys(eps).forEach(function (k) {
var n = Number(k);
if (!(n > 0)) return;                     // 非数字键（NaN）跳过，与旧实现一致
(eps[k] || []).slice(0, 3).forEach(function (c) {
out.push({ it: c, ep: n, lab: pad2(n) });
});
});
(batch || []).forEach(function (c) { out.push({ it: c, ep: epNoOf(c), lab: '合集' }); });
return out;
}
function groupRows(rows) {
var map = Object.create(null), names = [];
for (var i = 0; i < rows.length; i++) {
var r = rows[i];
if (!r) continue;
var g = groupNameOf(r.it);
if (!map[g]) { map[g] = []; names.push(g); }
map[g].push(r);
}
names.sort(groupCmp);
return names.map(function (g) {
return { name: g, rows: map[g].slice().sort(rowCmp) };
});
}
function defaultOpen(groups) {
var open = Object.create(null), i;
if (groups.length <= 6) {
for (i = 0; i < groups.length; i++) open[groups[i].name] = 1;
return open;
}
var top = groups.map(function (g, j) { return j; })
.sort(function (p, q) { return groups[q].rows.length - groups[p].rows.length; })
.slice(0, 3);
for (i = 0; i < top.length; i++) open[groups[top[i]].name] = 1;
return open;
}
function tgsHtml(groups) {
if (!groups.length) return '';
var open = defaultOpen(groups), h = '<div class="tgs">';
for (var i = 0; i < groups.length; i++) {
var g = groups[i], rows = '';
for (var j = 0; j < g.rows.length; j++) {
rows += rowOf(g.rows[j].it, g.rows[j].lab, g.rows[j].lab === '合集' ? null : g.rows[j].ep);
}
h += '<div class="mgteam" data-open="' + (open[g.name] ? '1' : '0') + '">'
+ '<button class="tg-h" type="button" data-tg="' + escAttr(g.name) + '">'
+ '<span class="tg-n">' + escText(g.name) + '</span>'
+ '<span class="tg-c">' + g.rows.length + '</span>'
+ '<span class="tg-x">›</span>'
+ '</button>'
+ '<div class="mgrows">' + rows + '</div>'
+ '</div>';
}
return h + '</div>';
}
function epsListHtml(a, b) {
return tgsHtml(groupRows(collectRows(a, b)));
}
function render(m, e) {
var box = m.querySelector('#epsbox');
if (!box) return;
var h = epsListHtml(e);
box.innerHTML = h || '<div class="mgsect"><div class="sec-h"><h2>分集磁力</h2></div>'
+ '<div class="eps-none">暂无按集索引</div></div>';
}
function hasRows(e) {
return !!(e && ((e.eps && Object.keys(e.eps).length) || (e.batch && e.batch.length)));
}
function epCount(e) {
return e ? collectRows(e).length : 0;
}
function titleKey(s) {
return String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();
}
function sameTitle(a, b) {
var x = titleKey(a);
return !!x && x === titleKey(b);
}
function identityOk(a, b) {
var x = titleKey(a), y = titleKey(b);
if (!x || !y) return true;
if (x === y) return true;
var strip = function (s) {
return s.replace(/(第[一二三四五六七八九十0-9]{1,2}[季期部])|(season[0-9]{1,2})|(s[0-9]{1,2})|(part[0-9]{1,2})|([0-9]{1,2})|([ivx]{1,3})$/g, '');
};
var xs = strip(x), ys = strip(y);
return !!xs && !!ys && (xs === ys || (xs.length >= 4 && ys.indexOf(xs) === 0) || (ys.length >= 4 && xs.indexOf(ys) === 0));
}
function paint(e, titleHint) {
var m = document.getElementById('modal');
if (!m) return false;
var h3 = m.querySelector('h3');
var cur = h3 ? String(h3.textContent == null ? '' : h3.textContent).trim() : '';
if (!sameTitle(cur, titleHint || (e && e.n))) return false;
if (m.querySelector('#epsbox')) { render(m, e); return true; }
var body = m.querySelector('#mgbody');
if (body) {
var h = epsListHtml(e);
body.innerHTML = h || '<div class="eps-none">暂无按集索引</div>';
return true;
}
return false;
}
function syncState(e) {
if (!CUR_STATE || !CUR_BOX || !CUR_BOX.parentNode) return false;
var m = document.getElementById('modal');
if (!m || m.querySelector('#epsbox') !== CUR_BOX) return false;
CUR_STATE.e = e;
CUR_STATE.cnt = epCount(e);
CUR_STATE.got = true;
return true;
}
function reload(name, epsN, orig) {
var n = String(name == null ? '' : name).trim();
var o = String(orig == null ? '' : orig).trim();   // 两参旧调用 → ''，保持向后兼容
if (!n) return Promise.resolve(null);
EPOCH++;                            // 作废打开详情页时还在飞的 A/B（见 take 的 epoch 守卫）
var my = EPOCH;
delete LIVE[n];
delete CACHE[shardOf(n)];
MANIFEST = null;
BASE_I = 0;
LIVE_DOWN = false;
NEED_LOGIN = false;                // 每次手动刷新都当「重新试一次登录」
REV = String(Date.now());          // 本次刷新的清单/分片 URL 带 ?v= 绕 HTTP 缓存
var box = document.querySelector('#epsbox');
var body = box ? null : document.querySelector('#mgbody');
var phBox = null, phFail = '';
if (box && !String(box.innerHTML || '').trim()) {
phBox = box;
phFail = '<div class="mgsect"><div class="sec-h"><h2>分集磁力</h2></div>'
+ '<div class="eps-none">磁力刷新失败，请重试</div></div>';
box.innerHTML = '<div class="mgsect"><div class="sec-h"><h2>分集磁力</h2></div>'
+ '<div class="eps-none">正在刷新…</div></div>';
} else if (body && !String(body.innerHTML || '').trim()) {
phBox = body;
phFail = '<div class="eps-none">磁力刷新失败，请重试</div>';
body.innerHTML = '<div class="eps-none">正在刷新…</div>';
}
function done(e) {
if (my !== EPOCH) return e || null;  // 期间又刷新了一次：这份结果作废，别回滚更新的那次
REV = '';                          // 时间戳只作用于这一次刷新
if (!e) {
toast('磁力刷新失败，请重试');
if (phBox && phBox.parentNode) phBox.innerHTML = phFail;
return null;
}
if (!paint(e, n)) return e;         // 框里已经是别的番：宁可不画，也不串台
syncState(e);                       // 行数与 state 推进到新结果，旧响应再也盖不回来
return e;
}
var aP = resolveEntry(n);          // A：数据集分片（内部已 catch → null）
return fetchLive(n, Number(epsN) || 0, o, 1).then(function (live) {
if (hasRows(live)) return live;  // 强制查询拿到内容：以最新结果为准
return aP.then(function (a) {    // 否则回落分片，实在没有才交 null
return hasRows(a) ? a : (live || a || null);
});
}).then(done, function () { return done(null); });
}
function legacyCopy(txt) {
var ta = null;
try {
ta = document.createElement('textarea');
ta.value = txt;
ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
document.body.appendChild(ta);
ta.select();
return Promise.resolve(!!document.execCommand('copy'));
} catch (err) {
return Promise.resolve(false);
} finally {
if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
}
}
function copyText(s) {
var txt = String(s || '');
if (!txt) return Promise.resolve(false);
try {
if (navigator.clipboard && navigator.clipboard.writeText) {
return navigator.clipboard.writeText(txt).then(function () { return true; }, function () {
return legacyCopy(txt);
});
}
} catch (err) { /* 非安全上下文等：直接走回退 */ }
return legacyCopy(txt);
}
function toast(msg) {
var el = document.querySelector('.epstoast');
if (!el) {
el = document.createElement('div');
el.className = 'epstoast';
el.style.cssText = 'position:fixed;left:50%;bottom:72px;transform:translateX(-50%);' +
'z-index:9999;padding:9px 16px;border-radius:20px;font-size:13px;' +
'background:rgba(0,0,0,.86);color:#fff;opacity:1;transition:opacity .3s;' +
'pointer-events:none;max-width:80vw;text-align:center';
document.body.appendChild(el);
}
el.textContent = msg;
el.style.opacity = '1';
el.__seq = (el.__seq || 0) + 1;
var seq = el.__seq;
if (el.__t1) clearTimeout(el.__t1);
if (el.__t2) clearTimeout(el.__t2);
el.__t1 = setTimeout(function () {
if (el.__seq !== seq) return;
el.style.opacity = '0';
el.__t2 = setTimeout(function () {
if (el.__seq !== seq) return;
if (el.parentNode) el.parentNode.removeChild(el);
}, 320);
}, 1600);
}
function arm() {
var m = document.getElementById('modal');
if (!m) return;
if (m.__epsObs) return;
m.__epsObs = true;
function toggleTeam(h) {
var g = h && h.closest ? h.closest('.mgteam') : null;
if (!g) return false;
g.setAttribute('data-open', g.getAttribute('data-open') === '1' ? '0' : '1');
return true;
}
function onChip(ev) {
var t = ev.target;
if (t && t.closest && t.closest('[data-login]')) {
ev.preventDefault();
ev.stopPropagation();
if (window.__openLogin) window.__openLogin();
return;
}
if (toggleTeam(t && t.closest ? t.closest('.tg-h') : null)) {
ev.preventDefault();
ev.stopPropagation();          // 别冒泡去触发卡片的开关逻辑
return;
}
var c = t && t.closest && t.closest('.mgrow, .eps-chip');
if (!c) return;
ev.preventDefault();
ev.stopPropagation();            // 别冒泡去触发卡片的开关逻辑
var mg = c.getAttribute('data-m') || '';
if (!mg) return;
copyText(mg).then(function (ok) {
toast(ok ? '已复制磁力链接' : '复制失败，请长按链接手动复制');
});
var epAttr = c.getAttribute('data-ep');
if (epAttr && window.__prog) {
var bgmId = m.getAttribute('data-bgm');
var prev = window.__prog.get ? window.__prog.get(bgmId) : null;
window.__prog.report(bgmId, Number(epAttr), prev && Number(prev.ep) === Number(epAttr) ? {
fid: prev.fid || '', pos: prev.pos || 0, dur: prev.dur || 0
} : null);
}
}
m.addEventListener('click', onChip);
m.addEventListener('keydown', function (ev) {
if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') return;
var t = ev.target;
if (t && t.closest && (t.closest('.mgrow') || t.closest('.tg-h') || t.closest('[data-login]'))) return;
onChip(ev);
});
new MutationObserver(function () {
var h3 = m.querySelector('h3');
if (!h3) return;
var name = h3.textContent.trim();
if (name === LAST_NAME && m.querySelector('#epsbox')) return;
LAST_NAME = name;
var body = m.querySelector('.mbody[data-p="detail"]');
var host = body ? null : (m.querySelector('.acts') || m.querySelector('.mb'));
if (!body && !host) return;
if ((body || host.parentNode).querySelector('#epsbox')) return;   // 已有就不重复插
var box = document.createElement('div');
box.className = 'relbox';
box.id = 'epsbox';
box.innerHTML = '<div class="mgsect"><div class="sec-h"><h2>分集磁力</h2></div>'
+ '<div class="eps-none">索引加载中…</div></div>';
if (body) body.appendChild(box);
else host.parentNode.insertBefore(box, host.nextSibling);
var state = { e: null, cnt: 0, live: false, settled: 0, got: false };
var my = EPOCH;                 // 发起这次 A/B 的刷新代号：期间点过 ⟳ 就把结果作废
CUR_BOX = box;                  // 供 reload() 把行数 / state 同步到最新结果
CUR_STATE = state;
var origEl = m.querySelector('.orig');
var origName = origEl ? origEl.textContent.trim() : '';
var bgm = m.getAttribute('data-bgm') || '';
function stale() { return !box.parentNode || m.querySelector('#epsbox') !== box; }
function take(e) {
if (my !== EPOCH) return false;          // 这几条是刷新前发出的旧响应
if (stale() || !hasRows(e)) return false;
var byId = !!(bgm && e && String(e.key || '') === String(bgm));
if (!byId && !identityOk(e.n, name)) return false;
var c = epCount(e);
if (c <= state.cnt) return false;
state.e = e;
state.cnt = c;
render(m, e);
return true;
}
function finish() {
if (my !== EPOCH || stale() || state.cnt || state.live) return;
state.live = true;
if (window.__CUR_SEASON === false) { render(m, state.e); return; }
box.innerHTML = '<div class="mgsect"><div class="sec-h"><h2>分集磁力</h2></div>'
+ '<div class="eps-none">索引里没有，正在向后端查询…</div></div>';
return fetchLive(name, episodeCount(m), origName).then(function (live) {
if (stale()) return;
if (live) return render(m, live);
if (NEED_LOGIN) {
box.innerHTML = '<div class="mgsect"><div class="sec-h"><h2>分集磁力</h2></div>'
+ '<div class="mnote">实时查询需登录 · '
+ '<button class="mnote-btn" type="button" data-login="1">登录</button></div></div>';
return;
}
if (LIVE_DOWN) {                       // 后端连不上：说清楚，别装作"没有"
box.innerHTML = '<div class="mgsect"><div class="sec-h"><h2>分集磁力</h2></div>'
+ '<div class="eps-none">索引里没有，后端暂时连不上</div></div>';
return;
}
render(m, state.e);
});
}
function one(e) {
state.settled++;
if (take(e)) state.got = true;
if (!state.got && state.settled >= 2) finish();
}
resolveEntry(name, bgm).then(one, function () { one(null); });
dbLive(name, bgm).then(one, function () { one(null); });
}).observe(m, { childList: true, subtree: false });
}
if (document.readyState === 'loading') {
document.addEventListener('DOMContentLoaded', arm);
} else {
arm();
}
document.addEventListener('DOMContentLoaded', arm);
window.__epsTest = {
find: findByName,
norm: norm,
shardOf: shardOf,
buildEps: buildEps,
epsListHtml: epsListHtml,
render: render,
hashOf: hashOf,
setIdx: function (d) { ENTRY = d; return ENTRY; },
cleanGroupName: cleanGroupName,
groupNameOf: groupNameOf,
epNoOf: epNoOf,
collectRows: collectRows,
groupRows: groupRows,
defaultOpen: defaultOpen,
tgsHtml: tgsHtml,
bustUrl: bustUrl,
sameTitle: sameTitle,
curState: function () { return CUR_STATE; },
};
window.__epsApi = {
loadManifest: loadManifest, loadShard: loadShard, resolveEntry: resolveEntry,
findByName: findByName, chipOf: chipOf, copyText: copyText, toast: toast,
fmtSize: fmtSize, norm: norm, shardOf: shardOf, buildEps: buildEps,
epsListHtml: epsListHtml, batchLabel: batchLabel, descOf: descOf,
live: function (name, epsN, orig) { return fetchLive(name, epsN, orig); },
reload: reload
};
})();