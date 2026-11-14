  /* ---------------- 规则源（HTML 抓取 + 浏览器解析）----------------
     2026-11-14：参考 Kazumi 的 XPath 源，但**不用 headless 浏览器**。
     盒子只转发原始 HTML（/ext/page?u=，域名白名单 + 5 分钟缓存 + 并发闸），
     解析全在用户浏览器里：搜索 → 详情 → 分集 → 播放。

     两种模式（体检结论：17 个源里只有 MXdm 的播放页直接给 m3u8）：
       · mode:'m3u8'   —— 播放页 HTML 里抽 m3u8，原生 <video> + hls.js
       · mode:'iframe' —— 播放页没有裸 m3u8（hex 编码 / Doki token / 自有播放器），
                          且**没有 X-Frame-Options** ⇒ 直接 iframe 嵌它的播放页，
                          让对方的播放器在用户浏览器里自己跑（Kazumi 用 webview 的等价做法）

     优先级 = 数组顺序：直连 m3u8 的排前面，iframe 的按「体检可播 + 站点稳定」排。
     自动链只在采集站全挂后才按顺序试**前 3 个**，避免一集打十几个站。 */
  var RULE_TTL = 10 * 60 * 1000;
  var RULE_MEM = {};              // 缓存：搜索 / 详情
  var RULE_SRC = [
    { id: 'mxdm',    name: 'MXdm',    base: 'https://www.dcc3.com',     search: '/search/?wd={kw}',                         mode: 'm3u8' },
    { id: '7sefun',  name: '7sefun',  base: 'https://www.7sefun.top',   search: '/vodsearch/-------------.html?wd={kw}',    mode: 'iframe' },
    { id: 'akianime',name: 'akianime',base: 'https://www.akianime.cc',  search: '/bgmsearch/-------------.html?wd={kw}',    mode: 'iframe' },
    { id: 'baimao',  name: '白毛动漫', base: 'https://www.baimaodm.com', search: '/s_all?ex=1&kw={kw}',                      mode: 'iframe' },
    { id: 'dm84',    name: 'DM84',    base: 'https://dmbus.cc',         search: '/s----------.html?wd={kw}',                mode: 'iframe' }
  ];
  var RULE_CHAIN_MAX = 3;          // 自动链最多试几个

  /* 规则页抓取：单独放宽到 25s（站点首包常 8–15s，srcGet 的 15s 会先掐断） */
  function ruleGet(url) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 25000);
    return fetch(SRC_BASE + '/ext/page?u=' + encodeURIComponent(url), {
      method: 'GET', cache: 'no-store', signal: ctl ? ctl.signal : undefined
    }).then(function (r) {
      clearTimeout(timer);
      return r.text().then(function (t) {
        var j = null;
        try { j = JSON.parse(t); } catch (e) { j = null; }
        if (!r.ok || !j || !j.ok || !j.text) {
          throw new Error((j && j.error) || ('HTTP ' + r.status));
        }
        return String(j.text);
      });
    }, function () { clearTimeout(timer); throw new Error('network'); });
  }

  function ruleDoc(html) {
    try { return new DOMParser().parseFromString(html, 'text/html'); } catch (e) { return null; }
  }

  function ruleCache(key, fn) {
    var rec = RULE_MEM[key];
    if (rec && Date.now() - rec.ts < RULE_TTL) return Promise.resolve(rec.data);
    return fn().then(function (data) {
      RULE_MEM[key] = { ts: Date.now(), data: data };
      return data;
    });
  }

  var RULE_DETAILISH = /(\/detail|\/voddetail|\/subject|\/anime\/|\/media|\/show\/|\/video\/)/i;
  /* 播放链接：/play/ /vodplay /bgmplay /watch /p/<id>-<line>-<ep> 或任意 …-<line>-<ep>.html */
  var RULE_PLAYISH = /(\/play\/|\/vodplay|\/bgmplay|\/watch|\/p\/\d+-\d+|\/index\.php\/vod\/play|\/episode|-\d+-\d+\.html)/i;

  /* 把 href 解析成绝对地址（同源才算，外链留给 iframe） */
  function ruleAbs(base, href) {
    try { return new URL(href, base).href; } catch (e) { return ''; }
  }

  /* 搜索：返回 [{id, name, href}]；按片名归一化挑最像的一条 */
  /* 关键词变体：全角括号/叹号这类字符常让站内搜索直接 0 结果 */
  function ruleKwVariants(kw) {
    var k = String(kw || '').trim();
    var out = [k];
    var k2 = k.replace(/[【】\[\]（）()《》「」『』!！?？:：·・,，。]/g, '').replace(/\s+/g, ' ').trim();
    if (k2 && k2 !== k) out.push(k2);
    return out;
  }

  function ruleSearch(src, kw) {
    var variants = ruleKwVariants(kw);
    return ruleCache(src.id + '|s|' + kw, function () {
      var i = 0;
      function step() {
        if (i >= variants.length) return Promise.resolve([]);
        var v = variants[i++];
        var u = src.base + src.search.replace('{kw}', encodeURIComponent(v));
        return ruleGet(u).then(function (html) {
          var got = ruleParseSearch(src, html, v);
          /* 有结果就用；没有就换下一个关键词变体（最多 2 次） */
          if (got.length || i >= variants.length) return got;
          return step();
        }, function () {
          if (i >= variants.length) throw new Error('search failed');
          return step();
        });
      }
      return step();
    });
  }

  function ruleParseSearch(src, html, kw) {
        var doc = ruleDoc(html), out = [], seen = {};
        if (!doc) return out;
        var as = doc.querySelectorAll('a[href]');
        for (var i = 0; i < as.length; i++) {
          var href = as[i].getAttribute('href') || '';
          var abs = ruleAbs(src.base, href);
          if (!abs) continue;
          var name = String(as[i].textContent || '').replace(/\s+/g, ' ').trim();
          /* 很多站是「封面图 + 标题」的链接，a 里没有文字：退到 title / img.alt / 容器文本 */
          if (!name) name = String(as[i].getAttribute('title') || '').trim();
          if (!name) {
            var im = as[i].querySelector ? as[i].querySelector('img') : null;
            if (im) name = String(im.getAttribute('alt') || '').trim();
          }
          if (!name && as[i].closest) {
            var par = as[i].closest('li,div,article,section');
            if (par) name = String(par.textContent || '').replace(/s+/g, ' ').trim().slice(0, 60);
          }
          if (!name || name.length < 2) continue;
          if (/查看详情|全部|更多|上一页|下一页|登录|注册/.test(name)) continue;
          var looksDetail = RULE_DETAILISH.test(abs);
          var looksText = extNorm(name).indexOf(extNorm(extBase(kw))) >= 0;
          if (!looksDetail && !looksText) continue;
          if (seen[abs]) continue;
          seen[abs] = 1;
          out.push({ id: abs, name: name, href: abs });
        }
        return out;
  }

  /* 详情：返回 [{line, ep, href}]，取集数最多的那条线路 */
  function ruleEps(src, detailHref) {
    return ruleCache(src.id + '|d|' + detailHref, function () {
      return ruleGet(detailHref).then(function (html) {
        var doc = ruleDoc(html), lines = {}, best = null, bestN = -1;
        if (!doc) return [];
        var as = doc.querySelectorAll('a[href]');
        for (var i = 0; i < as.length; i++) {
          var href = as[i].getAttribute('href') || '';
          if (!RULE_PLAYISH.test(href)) continue;
          var abs = ruleAbs(src.base, href);
          if (!abs) continue;
          /* 线路/集号：取 href 里最后两个数字段（"…/32644-1-3.html" → 1 / 3） */
          var nums = (href.match(/(\d+)/g) || []);
          var ep = 0, line = '0';
          /* 只有 …-<线路>-<集号>.html 这种两段数字才当集号；
             单段（/v/1621.html 这类整片一页）一律当第 1 集，避免编出「第 1621 集」 */
          if (nums.length >= 2) {
            ep = Number(nums[nums.length - 1]);
            line = nums[nums.length - 2];
          }
          if (!(ep > 0)) ep = 1;
          /* 单段 id 的站点（如 DM84 的 /v/5963.html）：集号在链接文字里 */
          if (nums.length < 2) {
            var txt = String(as[i].textContent || '');
            var em = /第\s*(\d{1,4})\s*[集话話回期]/.exec(txt);
            if (!em) em = /^\s*(\d{1,4})\s*$/.exec(txt);
            if (em && Number(em[1]) > 0) ep = Number(em[1]);
          }
          if (!lines[line]) lines[line] = [];
          lines[line].push({ ep: ep, href: abs });
        }
        for (var k in lines) {
          if (lines[k].length > bestN) { bestN = lines[k].length; best = lines[k]; }
        }
        if (!best) return [];
        best.sort(function (a, b) { return a.ep - b.ep; });
        return best;
      });
    });
  }

  /* 播放页：抽 m3u8（裸地址 / 转义地址 / JSON 里的 url 字段） */
  function ruleM3u8(src, playHref) {
    return ruleCache(src.id + '|p|' + playHref, function () {
      return ruleGet(playHref).then(function (html) {
        var h = html.replace(/\\\//g, '/');
        var m = /(https?:\/\/[^"'\\\s<>]+?\.m3u8[^"'\\\s<>]*)/i.exec(h);
        if (m) return m[1];
        throw new Error('no m3u8');
      });
    });
  }

  function rulePick(list, title) {
    var ns = extNorm(extBase(title)), ss = extSeason(title) || 0, best = null, bestScore = -1;
    for (var i = 0; i < list.length; i++) {
      var nm = String(list[i].name || '');
      var nc = extNorm(extBase(nm)), sc = extSeason(nm) || 1;
      var exact = nc === ns;
      var contain = (nc.indexOf(ns) >= 0 || ns.indexOf(nc) >= 0) && Math.min(nc.length, ns.length) >= 3;
      if (!exact && !contain) continue;
      if (ss && sc !== ss) continue;
      var score = (exact ? 2 : 1) + (ss && sc === ss ? 1 : 0);
      if (score > bestScore) { bestScore = score; best = list[i]; }
    }
    return best;
  }

  /* 单源播一集：m3u8 直连 / iframe 兜底 */
  function rulePlayOne(src, box, id, title, ep) {
    var epNo = Math.max(1, Math.floor(Number(ep) || 1));
    srcHint(box, '规则源 · ' + src.name + ' · 搜索中…');
    return ruleSearch(src, panKw(title)).then(function (list) {
      var pick = rulePick(list, title);
      if (!pick) throw new Error('not found');
      srcHint(box, '规则源 · ' + src.name + ' · 读取分集…');
      return ruleEps(src, pick.href).then(function (eps) {
        if (!eps.length) throw new Error('no eps');
        var hit = null;
        for (var i = 0; i < eps.length; i++) if (eps[i].ep === epNo) { hit = eps[i]; break; }
        if (!hit) hit = eps[0];
        if (src.mode === 'iframe') {
          /* 对方播放器自带广告/选集；这里只负责嵌进来 */
          srcAbortOthers();
          srcPlayerSlot(box).innerHTML = srcFrame(hit.href, 'autoplay; fullscreen; picture-in-picture');
          srcHint(box, '规则源 · ' + src.name + ' · 第 ' + hit.ep + ' 集（站外播放器）');
          srcLineSet(box, '规则源 · ' + src.name);
          return true;
        }
        srcHint(box, '规则源 · ' + src.name + ' · 第 ' + hit.ep + ' 集…');
        return ruleM3u8(src, hit.href).then(function (m3u8) {
          if (!window.QPlayer) throw new Error('no player');
          QPlayer.open({ m: box, id: id, title: title, ep: epNo, sources: [] });
          QPlayer.play(m3u8, '规则源 · ' + src.name, { hls: true });
          srcHint(box, '规则源 · ' + src.name + ' · 第 ' + epNo + ' 集');
          srcLineSet(box, '规则源 · ' + src.name);
          return true;
        });
      });
    });
  }

  /* 按优先级顺序试：手动选某个源时 onlyId 精确匹配 */
  function rulePlay(box, id, title, ep, onFail, onlyId, maxN) {
    var list = RULE_SRC.filter(function (s) { return !onlyId || s.id === onlyId; });
    if (!list.length) { if (onFail) onFail('无规则源'); return; }
    var cap = onlyId ? 1 : (maxN || list.length);
    var i = 0, errs = [];
    function step() {
      if (i >= Math.min(cap, list.length)) {
        if (onFail) onFail('规则源都不可用' + (errs.length ? ('（' + errs[0] + '）') : ''));
        return;
      }
      var src = list[i++];
      rulePlayOne(src, box, id, title, ep).catch(function (e) {
        errs.push(src.name + ':' + ((e && e.message) || 'error'));
        if (onlyId) srcHint(box, '规则源 ' + src.name + ' 不可用（' + ((e && e.message) || 'error') + '）');
        step();
      });
    }
    step();
  }

  /* 验收用：只解析不播放，逐源返回「有没有匹配 / 有多少集 / 这一集的地址」 */
  function ruleResolveAll(title, ep) {
    var out = [], kw = panKw(title), epNo = Math.max(1, Number(ep) || 1);
    return RULE_SRC.reduce(function (chain, src) {
      return chain.then(function () {
        return ruleSearch(src, kw).then(function (list) {
          var pick = rulePick(list, title);
          if (!pick) { out.push({ id: src.id, ok: false, why: 'no-match', cands: list.length }); return; }
          return ruleEps(src, pick.href).then(function (eps) {
            var hit = null;
            for (var i = 0; i < eps.length; i++) if (eps[i].ep === epNo) { hit = eps[i]; break; }
            out.push({ id: src.id, ok: !!hit, matched: pick.name, nEps: eps.length,
                       epHref: hit ? hit.href : '', mode: src.mode });
          });
        }).catch(function (e) { out.push({ id: src.id, ok: false, why: String((e && e.message) || e) }); });
      });
    }, Promise.resolve()).then(function () { return out; });
  }

  /* 全网搜索页用：逐源搜关键词，返回每个源的前 3 条候选（不播放） */
  function ruleSearchAll(kw, perSrc) {
    var out = [], n = perSrc || 3;
    return RULE_SRC.reduce(function (chain, src) {
      return chain.then(function () {
        return ruleSearch(src, kw).then(function (list) {
          if (!list.length) return;
          out.push({
            id: src.id, name: src.name, mode: src.mode,
            items: list.slice(0, n).map(function (x) { return { name: x.name, href: x.href }; })
          });
        }).catch(function () { });
      });
    }, Promise.resolve()).then(function () { return out; });
  }

  window.__ruleSources = function () { return RULE_SRC.slice(); };
  window.__ruleSearchAll = ruleSearchAll;
  window.__ruleResolveAll = ruleResolveAll;
  window.__rulePlay = rulePlay;
