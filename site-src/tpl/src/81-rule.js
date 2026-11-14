  /* ---------------- 规则源（HTML 抓取在浏览器里做）----------------
     2026-11-14：参考 Kazumi 的 XPath 源，但**不用 headless 浏览器**——
     盒子只把原始 HTML 转给前端（/ext/page?u=，白名单），解析在用户浏览器里。

     当前接入：MXdm（www.dcc3.com）
       搜索 /search/?wd=<kw> → /detail/<id>/
       详情 /detail/<id>/    → /play/<id>-<line>-<ep>/
       播放 /play/…          → HTML 里直接有 m3u8 地址

     这类源作为「外部线路」的补充：采集站（m3u8 JSON API）全挂时才用，
     也可以在线路菜单里手动选。解析失败一律 onFail，不猜。 */
  var RULE_TTL = 10 * 60 * 1000;
  var RULE_MEM = {};              // 缓存：搜索/详情
  var RULE_SRC = [
    { id: 'mxdm', name: 'MXdm', base: 'https://www.dcc3.com' }
  ];

  function ruleGet(url) {
    return srcGet('/ext/page?u=' + encodeURIComponent(url), '').then(function (r) {
      var j = (r && r.j) || {};
      if (!r || !r.ok || !j.ok || !j.text) {
        throw new Error((j && j.error) || ('HTTP ' + (r && r.status)));
      }
      return String(j.text);
    });
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

  /* 搜索：返回 [{id, name, href}]（同一 id 只留第一条标题） */
  function ruleSearch(src, kw) {
    var u = src.base + '/search/?wd=' + encodeURIComponent(String(kw || '').replace(/\s+/g, ' ').trim());
    return ruleCache(src.id + '|s|' + kw, function () {
      return ruleGet(u).then(function (html) {
        var doc = ruleDoc(html), out = [], seen = {};
        if (!doc) return out;
        var as = doc.querySelectorAll('a[href*="/detail/"]');
        for (var i = 0; i < as.length; i++) {
          var href = as[i].getAttribute('href') || '';
          var m = /\/detail\/(\d+)\/?/.exec(href);
          if (!m) continue;
          var name = String(as[i].textContent || '').replace(/\s+/g, ' ').trim();
          if (!name || /查看详情/.test(name)) continue;
          if (seen[m[1]]) continue;
          seen[m[1]] = 1;
          out.push({ id: m[1], name: name, href: src.base + '/detail/' + m[1] + '/' });
        }
        return out;
      });
    });
  }

  /* 详情：返回 [{line, ep, href}]（同名多线路时保留集数最多的一条线路） */
  function ruleEps(src, detailHref) {
    return ruleCache(src.id + '|d|' + detailHref, function () {
      return ruleGet(detailHref).then(function (html) {
        var doc = ruleDoc(html), lines = {}, best = null, bestN = -1;
        if (!doc) return [];
        var as = doc.querySelectorAll('a[href*="/play/"]');
        for (var i = 0; i < as.length; i++) {
          var href = as[i].getAttribute('href') || '';
          var m = /\/play\/(\d+)-(\d+)-(\d+)\/?/.exec(href);
          if (!m) continue;
          var line = m[2], ep = Number(m[3]);
          if (!lines[line]) lines[line] = [];
          lines[line].push({ ep: ep, href: src.base + href.replace(/^https?:\/\/[^/]+/, '') });
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

  /* 播放页：HTML 里直接抽 m3u8（先找 `xxx.m3u8` 字面量，再找 url: '...'） */
  function ruleM3u8(src, playHref) {
    return ruleCache(src.id + '|p|' + playHref, function () {
      return ruleGet(playHref).then(function (html) {
        var m = /(https?:\/\/[^"'\\\s]+?\.m3u8[^"'\\\s]*)/i.exec(html);
        if (m) return m[1].replace(/\\\//g, '/');
        throw new Error('no m3u8');
      });
    });
  }

  /* 匹配：用 79 的归一化口径（片名基底 + 季号），复用 extNorm/extBase/extSeason */
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

  /* 播放：搜索 → 详情 → 选集 → 抽 m3u8 → 起播（全在浏览器里解析） */
  function rulePlay(box, id, title, ep, onFail, only) {
    var src = null;
    for (var i = 0; i < RULE_SRC.length; i++) {
      if (!only || RULE_SRC[i].id === only) { src = RULE_SRC[i]; break; }
    }
    if (!src) { if (onFail) onFail('无规则源'); return; }
    var epNo = Math.max(1, Math.floor(Number(ep) || 1));
    srcHint(box, '规则源 · ' + src.name + ' · 搜索中…');
    ruleSearch(src, panKw(title)).then(function (list) {
      var pick = rulePick(list, title);
      if (!pick) throw new Error('not found');
      srcHint(box, '规则源 · ' + src.name + ' · 读取分集…');
      return ruleEps(src, pick.href).then(function (eps) {
        if (!eps.length) throw new Error('no eps');
        var hit = null;
        for (var i = 0; i < eps.length; i++) if (eps[i].ep === epNo) { hit = eps[i]; break; }
        if (!hit) hit = eps[0];
        srcHint(box, '规则源 · ' + src.name + ' · 第 ' + hit.ep + ' 集…');
        return ruleM3u8(src, hit.href);
      });
    }).then(function (m3u8) {
      if (!window.QPlayer) throw new Error('no player');
      QPlayer.open({ m: box, id: id, title: title, ep: epNo, sources: [] });
      QPlayer.play(m3u8, '规则源 · ' + src.name, { hls: true });
      srcHint(box, '规则源 · ' + src.name + ' · 第 ' + epNo + ' 集');
      srcLineSet(box, '规则源 · ' + src.name);
    }).catch(function (e) {
      if (onFail) onFail('规则源 ' + src.name + ' 不可用（' + (e && e.message || 'error') + '）');
      else srcHint(box, '规则源 ' + src.name + ' 不可用');
    });
  }

  window.__ruleSources = function () { return RULE_SRC.slice(); };
  window.__rulePlay = rulePlay;
