/* 分集磁力 · 按需查询（Cloudflare Pages Function，路径 /api/eps?t=片名）
 *
 * 为什么需要这一层：
 *   pan-hub 聚合站只监听 http://120.48.56.189（443 上是 nginx 默认站，返回 404），
 *   站点是 HTTPS —— 浏览器直连会被 mixed content 拦掉，而且它不发 CORS 头。
 *   所以由边缘函数代取：服务端 → HTTP 后端，浏览器 → 同源 /api/eps。
 *
 * 凭据：PAN_HUB_USER / PAN_HUB_PASS 从 Pages 项目的环境变量读，绝不写进本文件。
 *       未配置时返回 503 并说明原因，不静默失败。
 *
 * 返回：{ "ok": true, "n": 片名, "eps": { "1": [{m,s,sd,sub,t}], ... }, "src": "live" }
 *       查不到：{ "ok": true, "n": 片名, "eps": {}, "src": "live" }
 *       出错  ：{ "ok": false, "error": "..." } + 5xx
 *
 * 过滤规则必须与 site-src/index_eps.py（构建端）保持一致：同样的噪声/整卷/
 * 整季包/季号/话数上限规则，否则「按需取的」和「预建的」会出现不一致的结果。
 */

const API = 'http://120.48.56.189/pan/api/search';

const RE_RANGE = /第\s*(\d{1,4})\s*[-–~〜]\s*(\d{1,4})\s*[話话集]/;
const RE_SINGLE = /第\s*(\d{1,4})\s*[話话集](?!\d)/;
const RE_BRACKET = /[\]\)\s\-–—]\s*\[?(\d{1,4})\]?(?=\s*(?:\[|\(|END|完|【|v\d|$))/;
const RE_EP = /(?:^|[\s\-–—\[])E[P]?(\d{1,4})\b/i;
const RE_DASH = /\s-\s*(\d{1,4})(?:v\d)?\s*(?:\[|\(|$)/;
const NOISE = /(OP\d?テーマ|ED\d?テーマ|OPテーマ|EDテーマ|主題歌|主题歌|挿入歌|オリジナルサウンドトラック|サントラ|Soundtrack|\bBatch\b|全集|合集|Complete|BDBOX|BOX\s*SET|DVDISO|BDISO|\bvol\.?\s*\d+|\d+\s*[巻卷]|漫画|コミック|小説|小说)/i;
const RE_PACK = /[\[\(【]\s*\d{1,3}\s*[-–~〜]\s*\d{1,3}\s*[\]\)】]|\b\d{1,3}\s*[-–~〜]\s*\d{1,3}\s*[话話集]|(?<![0-9])\d{1,3}\s*-\s*\d{1,3}(?![0-9])/;
const RE_SEASON = /(第\s*[一二三四五六七八九十\d]+\s*[季期]|Season\s*\d+|Part\.?\s*\d+|\bS\d{1,2}\b|[ⅡⅢⅣⅤⅥ])/i;
const NUM = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
              'Ⅱ': 2, 'Ⅲ': 3, 'Ⅳ': 4, 'Ⅴ': 5, 'Ⅵ': 6 };

function norm(s) {
  return String(s || '').toLowerCase().replace(/[\s\-_.·・:：!！?？,，。'"()\[\]（）【】～~]/g, '');
}

function seasons(text) {
  const out = new Set();
  const re = new RegExp(RE_SEASON.source, 'gi');
  let m;
  while ((m = re.exec(String(text || '')))) {
    const raw = m[1];
    const d = raw.match(/\d+/);
    const n = d ? Number(d[0]) : NUM[raw.trim().slice(-1)];
    if (!n) continue;
    out.add((/Part/i.test(raw) ? 'part' : 's') + n);
  }
  return out;
}

function sameSeasons(a, b) {
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}

function parseEps(t) {
  const m = RE_RANGE.exec(t);
  if (m) {
    const a = +m[1], b = +m[2];
    if (b - a < 0 || b - a > 200) return new Set();
    const s = new Set();
    for (let i = a; i <= b; i++) s.add(i);
    return s;
  }
  for (const rx of [RE_SINGLE, RE_DASH, RE_EP, RE_BRACKET]) {
    const x = rx.exec(t);
    if (x) {
      const n = +x[1];
      return n > 0 && n <= 999 ? new Set([n]) : new Set();
    }
  }
  return new Set();
}

function pick(r) {
  const m = r.magnet || r.m || '';
  if (typeof m !== 'string' || m.indexOf('magnet:') !== 0) return null;
  return {
    m,
    s: Number(r.size || r.s || 0),
    sd: Number(r.seeders || r.sd || 0),
    sub: String(r.sub || r.subs || '').slice(0, 12),
    t: String(r.title || r.name || '').slice(0, 160),
  };
}

function build(name, orig, epsN, results) {
  const q = norm(name), qo = norm(orig), qs = seasons(name);
  const short = q.length <= 3;
  const cand = {};
  for (const r of results) {
    const t = String(r.title || r.name || '');
    if (!t || NOISE.test(t)) continue;
    const item = pick(r);
    if (!item) continue;
    if (epsN && epsN <= 2) continue;               // 剧场版/OAD 不给分集
    if (RE_PACK.test(t)) continue;                 // 整季包
    const nt = norm(t);
    const hit = (q && nt.indexOf(q) >= 0) || (qo && qo.length >= 4 && nt.indexOf(qo) >= 0);
    if (!hit) continue;
    if (short) {
      const re = new RegExp('[\\[\\]【】()（）\\s\\-_/]' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\[\\]【】()（）\\s\\-_/]');
      if (!re.test(t)) continue;
    }
    if (!sameSeasons(qs, seasons(t)) && (qs.size || seasons(t).size)) continue;
    let nums = parseEps(t);
    if (!nums.size) continue;
    if (nums.size > 3) continue;
    if (epsN) nums = new Set([...nums].filter((n) => n <= epsN + 2));
    for (const n of nums) (cand[n] = cand[n] || []).push(item);
  }
  const eps = {};
  for (const n of Object.keys(cand)) {
    cand[n].sort((a, b) => (b.sd - a.sd) || (b.s - a.s));
    eps[n] = cand[n].slice(0, 2);
  }
  return eps;
}

export async function onRequestGet(context) {
  try {
    return await handle(context);
  } catch (e) {
    // 兜底：把真实异常带出来，别让 CF 直接回一个没有信息量的 502 页面
    return new Response(JSON.stringify({ ok: false, error: String(e && e.stack || e) }), {
      status: 500, headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
}

async function handle(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const name = (url.searchParams.get('t') || '').trim();
  const orig = (url.searchParams.get('o') || '').trim();
  const epsN = Number(url.searchParams.get('n') || 0);
  const json = (body, status) => new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': url.origin,
      // 边缘缓存 1 小时：同一片名反复被点不会反复打后端
      'cache-control': 'public, max-age=1800',
    },
  });

  if (!name) return json({ ok: false, error: 'missing t' }, 400);
  const user = env.PAN_HUB_USER, pass = env.PAN_HUB_PASS;
  if (!user || !pass) {
    return json({ ok: false, error: 'backend credentials not configured' }, 503);
  }

  const target = API + '?kw=' + encodeURIComponent(name);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  let data;
  try {
    const r = await fetch(target, {
      headers: { authorization: 'Basic ' + btoa(user + ':' + pass), 'user-agent': 'anime-eps-edge' },
      signal: ctl.signal,
      cf: { cacheTtl: 1800, cacheEverything: false },
    });
    if (!r.ok) throw new Error('backend HTTP ' + r.status);
    data = await r.json();
  } catch (e) {
    clearTimeout(timer);
    return json({ ok: false, error: String(e && e.message || e) }, 502);
  }
  clearTimeout(timer);

  const results = (data && data.results) || [];
  const eps = build(name, orig, epsN, results);
  return json({ ok: true, n: name, eps, src: 'live', raw: results.length });
}
