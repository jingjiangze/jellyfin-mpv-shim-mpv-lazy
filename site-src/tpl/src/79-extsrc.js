  /* ---------------- 外部线路（检测与选择全部在浏览器）----------------
     2026-11-14 重构（用户口径）：服务器只做「源清单 + 单源转发」两件事，
     检测/匹配/去重/排序/记住上次可用线路全在这里做。

     做法：
       ① 源清单 /ext/list（1h 内存缓存）；
       ② 十家**并发**拉 /ext/raw?p=&wd=（每家最多试 3 个关键词变体），谁先回谁先算；
       ③ **先回先播**：最高优先级线路一回就起播；否则等 900ms 宽限再拿当前最好的；
       ④ 播放中线路报错 → 已到手的下一条顶上；还不够就等剩余源回来再补；
       ⑤ 本页记住「上次成功的线路」，下次同片直取（仍并发探测，它先回就先用）。
     匹配口径与旧服务端一致（片名基底 + 季号 + 完结篇/Part/上下一篇守卫），
     宁可少，不可配错。 */
  var EXT_TTL = 10 * 60 * 1000;                 // 同一关键词的原始响应缓存
  var EXT_GEN = 0;
  var EXT_PROV = null, EXT_PROV_P = null, EXT_PROV_TS = 0;
  var EXT_RAW = {};                             // "p|wd" -> {ts, list}
  var EXT_LAST_KEY = 'anime_ext_last_prov';

  function extMeta(id) {
    var rows = (typeof ANI !== 'undefined' && ANI.rows) ? ANI.rows : [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][0] === id) {
        return { orig: rows[i][1] || '', year: rows[i][4] || 0, epsN: rows[i][8] || 0 };
      }
    }
    return { orig: '', year: 0, epsN: 0 };
  }

  function extProviders() {
    if (EXT_PROV && Date.now() - EXT_PROV_TS < 3600 * 1000) return Promise.resolve(EXT_PROV);
    if (EXT_PROV_P) return EXT_PROV_P;
    EXT_PROV_P = srcGet('/ext/list', '').then(function (r) {
      var j = (r && r.j) || {};
      var arr = (r && r.ok && j.ok && j.providers) ? j.providers : [];
      if (arr.length) { EXT_PROV = arr; EXT_PROV_TS = Date.now(); }
      EXT_PROV_P = null;
      return EXT_PROV || [];
    }, function () { EXT_PROV_P = null; return EXT_PROV || []; });
    return EXT_PROV_P;
  }

  function extRaw(pid, wd) {
    var key = pid + '|' + wd, rec = EXT_RAW[key];
    if (rec && Date.now() - rec.ts < EXT_TTL) return Promise.resolve(rec.list);
    return srcGet('/ext/raw?p=' + encodeURIComponent(pid) + '&wd=' + encodeURIComponent(wd), '')
      .then(function (r) {
        var j = (r && r.j) || {};
        var list = (r && r.ok && j.list) ? j.list : [];
        EXT_RAW[key] = { ts: Date.now(), list: list };
        return list;
      }, function () { return []; });
  }

  /* ---------------- 匹配（与服务端旧实现同口径） ---------------- */
  var EXT_T2S = (function () {
    var pairs = ('藥药 蘭兰 灣湾 們们 兒儿 動动 畫画 話话 劇剧 場场 見见 聽听 實实 國国 會会 ' +
      '來来 後后 間间 開开 關关 門门 問问 時时 點点 長长 東东 車车 馬马 龍龙 戰战 鬥斗 ' +
      '進进 擊击 劍剑 愛爱 戀恋 與与 為为 無无 雙双 頭头 髮发 臉脸 夢梦 願愿 殺杀 靈灵 ' +
      '異异 術术 師师 傳传 記记 總总 節节 約约 區区 學学 園园 鐵铁 銀银 鋼钢 彈弹 獵猎 ' +
      '僕仆 執执 線线 聲声 優优 體体 隊队 寶宝').split(' ');
    var o = {};
    for (var i = 0; i < pairs.length; i++) o[pairs[i].charAt(0)] = pairs[i].charAt(1);
    return o;
  })();
  var EXT_PUNCT = /[\s\-_.·・:：!！?？,，。'"()（）\[\]【】《》〈〉「」『』“”‘’~～&+/|]+/g;
  function extNorm(s) {
    var t = String(s == null ? '' : s).toLowerCase(), out = '';
    for (var i = 0; i < t.length; i++) { var c = t.charAt(i); out += (EXT_T2S[c] || c); }
    return out.replace(EXT_PUNCT, '');
  }
  var EXT_CN = { '一': 1, '二': 2, '两': 2, '兩': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
  var EXT_ROMAN = { 'Ⅱ': 2, 'Ⅲ': 3, 'Ⅳ': 4, 'Ⅴ': 5, 'Ⅵ': 6, 'Ⅶ': 7, 'Ⅷ': 8, 'Ⅸ': 9 };
  var EXT_RE_SEASON = /第\s*([一二三四五六七八九十两兩\d]{1,3})\s*[季期部]|\bseason\s*(\d{1,2})\b|\b(\d{1,2})(?:st|nd|rd|th)\s*season\b|\bpart\.?\s*(\d{1,2})\b|[ⅡⅢⅣⅤⅥⅦⅧⅨ]|\bS(\d{1,2})\b/;
  var EXT_RE_SEASON2 = /\bseason\s*(\d{1,2})\b|\b(\d{1,2})(?:st|nd|rd|th)\s*season\b|\bpart\.?\s*(\d{1,2})\b|\bS(\d{1,2})\b/i;
  function extSeason(s) {
    s = String(s || '');
    var m = EXT_RE_SEASON.exec(s) || EXT_RE_SEASON2.exec(s);
    if (m) {
      for (var i = 1; i < m.length; i++) {
        var g = m[i];
        if (!g) continue;
        g = String(g).trim();
        if (EXT_CN[g]) return EXT_CN[g];
        if (/^\d+$/.test(g)) return Number(g);
        if (EXT_ROMAN[g]) return EXT_ROMAN[g];
      }
      return 1;
    }
    for (var k in EXT_ROMAN) if (s.indexOf(k) >= 0) return EXT_ROMAN[k];
    return 0;
  }
  function extBase(s) {
    s = String(s || '');
    s = s.replace(/[\(（\[【][^\)）\]】]{0,40}[\)）\]】]/g, '');
    s = s.replace(/第\s*[一二三四五六七八九十两兩\d]{1,3}\s*[季期部]/g, '');
    s = s.replace(/\bseason\s*\d{1,2}\b/gi, '');
    s = s.replace(/\b\d{1,2}(?:st|nd|rd|th)\s*season\b/gi, '');
    s = s.replace(/\bpart\.?\s*\d{1,2}\b/gi, '');
    s = s.replace(/[ⅡⅢⅣⅤⅥⅦⅧⅨ]/g, '');
    s = s.replace(/\bS\d{1,2}\b/g, '');
    s = s.replace(/(19|20)\d{2}\s*年?/g, '');
    return s.replace(/^\s+|\s+$/g, '');
  }
  var EXT_NOISE = /解说|解說|速看|盘点|盤點|吐槽|真人|cosplay|\bcos\b|预告|預告|\bPV\b|花絮|特典|制作决定|製作決定|舞台剧|舞台劇|漫剪|混剪/i;
  var EXT_MOVIE = /剧场版|劇場版|电影|電影|movie/i;
  var EXT_MARK = /完结篇|完結篇|总集篇|總集篇|特别篇|特別篇|前篇|后篇|後篇|番外|\bOVA\b|\bOAD\b|特别编辑|特別編輯|总集|總集|[（(]\s*[上中下]\s*[)）]|[（(]\s*(?:前|后|後)篇\s*[)）]/i;

  function extAltNames(v) {
    var out = [], keys = ['vod_name', 'vod_sub'];
    for (var i = 0; i < keys.length; i++) {
      var raw = String(v[keys[i]] || '');
      var parts = raw.split(/[\/／|｜]/);
      for (var k = 0; k < parts.length; k++) {
        var p = parts[k];
        if (!p || !p.trim()) continue;
        out.push([extBase(p), extSeason(p)]);
      }
    }
    return out;
  }

  /* 0 = 不匹配；2 = 同名；+1 = 年份接近 */
  function extMatch(names, season, year, v) {
    var cname = String(v.vod_name || '');
    if (!cname || EXT_NOISE.test(cname)) return 0;
    var candMovie = EXT_MOVIE.test(cname);
    var siteMovie = false;
    for (var i0 = 0; i0 < names.length; i0++) if (EXT_MOVIE.test(names[i0][0] || '')) siteMovie = true;
    if (candMovie && !siteMovie) return 0;
    var cm = EXT_MARK.exec(cname);
    if (cm) {
      var hit = false;
      for (var i1 = 0; i1 < names.length; i1++) {
        if (String(names[i1][0] || '').toLowerCase().indexOf(String(cm[0]).toLowerCase()) >= 0) hit = true;
      }
      if (!hit) return 0;
    }
    var best = 0, alts = extAltNames(v);
    for (var a = 0; a < alts.length; a++) {
      var nb = extNorm(alts[a][0]);
      if (nb.length < 2) continue;
      var craw = alts[a][1], cseason = craw || 1;
      for (var s = 0; s < names.length; s++) {
        var ns = extNorm(names[s][0]);
        if (ns.length < 2) continue;
        var sseason = names[s][1] || 0;
        var exact = (nb === ns), contain = false, ok = false;
        if (sseason) {
          if (cseason !== (sseason || 1)) continue;
          contain = (nb.indexOf(ns) >= 0 || ns.indexOf(nb) >= 0) && Math.min(nb.length, ns.length) >= 3;
          ok = exact || contain;
        } else {
          ok = exact && craw <= 1;
        }
        if (!ok) continue;
        var sc = exact ? 2 : 1;
        var y = String(v.vod_year || '');
        if (year && /^\d+$/.test(y) && Math.abs(Number(y) - Number(year)) <= 1) sc += 1;
        if (sc > best) best = sc;
      }
    }
    return best;
  }

  var EXT_RE_EP = [/第\s*(\d{1,4})\s*[集话話回期]/, /\b[Ee][Pp]?\s*(\d{1,4})\b/, /^\s*(\d{1,4})\s*$/, /(\d{1,4})/];
  function extParseEp(name) {
    var s = String(name || '');
    for (var i = 0; i < EXT_RE_EP.length; i++) {
      var m = EXT_RE_EP[i].exec(s);
      if (m) { var n = Number(m[1]); if (n > 0 && n <= 2000) return n; }
    }
    return 0;
  }
  function extEpMap(group) {
    var out = {}, seq = 0, ents = String(group || '').split('#');
    for (var i = 0; i < ents.length; i++) {
      var ent = ents[i];
      if (!ent || !ent.trim()) continue;
      seq += 1;
      var parts = ent.split('$');
      if (parts.length < 2) continue;
      var url = String(parts[1] || '').trim();
      if (url.indexOf('http') !== 0) continue;
      var ep = extParseEp(parts[0]) || seq;
      if (!out[ep]) out[ep] = url;
    }
    return out;
  }
  /* 挑 m3u8 线路里集数最全的一组 → [{ep,url}] */
  function extPlayEps(v) {
    var froms = String(v.vod_play_from || '').split('$$$');
    var groups = String(v.vod_play_url || '').split('$$$');
    var best = null, bestKey = -1;
    for (var i = 0; i < groups.length; i++) {
      var frm = String(froms[i] || '').toLowerCase();
      var looksHls = frm.indexOf('m3u8') >= 0 || String(groups[i]).toLowerCase().indexOf('.m3u8') >= 0;
      if (!looksHls) continue;
      var m = extEpMap(groups[i]);
      var n = 0;
      for (var k in m) n++;
      if (!n) continue;
      if (n > bestKey) { bestKey = n; best = m; }
    }
    var out = [];
    if (!best) return out;
    for (var ep in best) out.push({ ep: Number(ep), url: best[ep] });
    out.sort(function (a, b) { return a.ep - b.ep; });
    return out;
  }

  /* 单家：按关键词变体顺序查，命中即停 */
  function extSolve(prov, variants, names, season, year) {
    var i = 0;
    function step() {
      if (i >= variants.length) return Promise.resolve(null);
      var wd = String(variants[i++] || '').replace(/\s+/g, '');
      if (!wd) return step();
      return extRaw(prov.p, wd).then(function (list) {
        if (!list || !list.length) return step();
        var pick = null, score = 0;
        for (var k = 0; k < list.length; k++) {
          var v = list[k];
          var sc = extMatch(names, season, year, v);
          if (sc > score) { score = sc; pick = v; }
        }
        if (!pick) return step();
        var eps = extPlayEps(pick);
        if (!eps.length) return step();
        return {
          p: prov.p, name: prov.name,
          src: String(pick.vod_name || ''),
          remarks: String(pick.vod_remarks || ''),
          n: eps.length, eps: eps
        };
      });
    }
    return step();
  }

  /* 并发查十家，每命中一家就回调一次（items 按优先级排好） */
  function extQuery(title, year, orig, onItem) {
    return extProviders().then(function (provs) {
      if (!provs.length) return [];
      var names = [[extBase(title), extSeason(title)]];
      if (orig) names.push([extBase(orig), extSeason(orig) || extSeason(title)]);
      var season = extSeason(title), variants = [title], b = extBase(title);
      if (extNorm(b) !== extNorm(title)) variants.push(b);
      if (orig) variants.push(orig);
      var items = [];
      var jobs = provs.map(function (p, idx) {
        return extSolve(p, variants, names, season, year).then(function (it) {
          if (!it) return;
          it.pri = idx;
          items.push(it);
          if (typeof onItem === 'function') onItem(it, items.slice());
        }, function () { });
      });
      return Promise.all(jobs).then(function () {
        items.sort(function (a, b2) { return a.pri - b2.pri; });
        return items;
      });
    });
  }

  function extLastProv() {
    try { return localStorage.getItem(EXT_LAST_KEY) || ''; } catch (e) { return ''; }
  }
  function extSetLastProv(p) {
    try { localStorage.setItem(EXT_LAST_KEY, String(p || '')); } catch (e) { }
  }

  function extEpOf(item, ep) {
    var eps = (item && item.eps) || [];
    for (var i = 0; i < eps.length; i++) if (Number(eps[i].ep) === Number(ep)) return eps[i].url;
    return '';
  }
  function extCands(items, ep) {
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var u = extEpOf(items[i], ep);
      if (u) out.push({ p: items[i].p, name: items[i].name, url: u, src: items[i].src, n: items[i].n, eps: items[i].eps });
    }
    return out;
  }
  function extEpList(items) {
    var seen = {}, out = [];
    for (var i = 0; i < items.length; i++) {
      var eps = items[i].eps || [];
      for (var k = 0; k < eps.length; k++) {
        var n = Number(eps[k].ep);
        if (n > 0 && !seen[n]) { seen[n] = 1; out.push({ ep: n }); }
      }
    }
    out.sort(function (a, b) { return a.ep - b.ep; });
    return out;
  }

  /* 自动链的一站：先回先播，出错自动换下一条。找不到/全错 → onFail(why)。 */
  function extStart(box, id, title, ep, onFail) {
    var epNo = Math.max(1, Math.floor(Number(ep) || 1));
    var gen = ++EXT_GEN;
    var meta = extMeta(id);
    var items = [], done = false, started = false, grace = 0, pending = null;
    var last = extLastProv();

    function ranked() {
      var list = items.slice();
      list.sort(function (a, b) {
        var la = (a.p === last ? -0.5 : 0), lb = (b.p === last ? -0.5 : 0);
        return (a.pri + la) - (b.pri + lb);
      });
      return list;
    }
    function cands() { return extCands(ranked(), epNo); }
    function tryPlay(force) {
      if (started || gen !== EXT_GEN) return false;
      var c = cands();
      if (!c.length) return false;
      /* 最高优先级那条还没回、也没到宽限时间：再等等（避免先播到低优先级线路） */
      if (!force && !done && ranked()[0] && ranked()[0].pri > 0) return false;
      if (!play(c, 0)) return false;
      started = true;
      return true;
    }
    function play(c, i) {
      var cur = c[i];
      if (!cur) return false;
      var tok = window.QPlayer ? QPlayer.open({
        m: box, id: id, title: title, ep: epNo, sources: [],
        onPickEp: function (e) { extPlayEp(box, id, title, Number(e) || 1, ranked()); },
        onEnded: function () {
          var nx = epNo + 1;
          if (extCands(ranked(), nx).length) extPlayEp(box, id, title, nx, ranked());
        },
        onPlayErr: function (why) {
          if (!(window.QPlayer && QPlayer.isCurrent(tok))) return;
          var c2 = cands();
          if (i + 1 < c2.length) {
            srcHint(box, '「' + cur.name + '」不可用（' + why + '）· 换下一条');
            play(c2, i + 1);
            return;
          }
          if (!done && pending) {
            srcHint(box, '「' + cur.name + '」不可用 · 等其余线路…');
            pending.then(function () {
              if (gen !== EXT_GEN) return;
              var c3 = cands();
              if (c3.length > c2.length) play(c3, c2.length);
              else QPlayer.state('error', { msg: '外部线路都不可用' });
            });
            return;
          }
          QPlayer.state('error', { msg: '外部线路都不可用（' + (why || 'error') + '）' });
        }
      }) : null;
      if (!tok) return false;
      QPlayer.setEpisodes(extEpList(items), epNo, '');
      srcHint(box, '外部线路 · ' + cur.name + ' · 第 ' + epNo + ' 集' + (i ? '（自动换源 ' + (i + 1) + '/' + c.length + '）' : ''));
      QPlayer.play(cur.url, cur.name, { hls: true });
      extSetLastProv(cur.p);
      return true;
    }

    srcHint(box, '正在匹配外部线路…');
    pending = extQuery(title, meta.year, meta.orig, function (it, all) {
      if (gen !== EXT_GEN) return;
      items = all;
      if (started) return;
      if (!grace) grace = setTimeout(function () { grace = 0; tryPlay(true); }, 900);
      if (it.pri === 0 || it.p === last) {
        if (grace) { clearTimeout(grace); grace = 0; }
        tryPlay(true);
      }
    }).then(function (all) {
      if (gen !== EXT_GEN) return all;
      items = all; done = true;
      if (grace) { clearTimeout(grace); grace = 0; }
      if (!started && !tryPlay(true)) {
        if (typeof onFail === 'function') onFail(items.length ? '外部源本集无资源' : '外部源未收录');
      }
      return all;
    });
    return pending;
  }

  function extPlayEp(box, id, title, ep, items) {
    var cand = extCands(items || [], ep);
    if (!cand.length) { srcHint(box, '第 ' + ep + ' 集外部源还没更新'); return; }
    if (typeof window.__extAbort === 'function') window.__extAbort();
    var gen = ++EXT_GEN;
    var tok = QPlayer.open({
      m: box, id: id, title: title, ep: ep, sources: [],
      onPickEp: function (e) { extPlayEp(box, id, title, Number(e) || 1, items); },
      onEnded: function () {
        var nx = ep + 1;
        if (extCands(items || [], nx).length) extPlayEp(box, id, title, nx, items);
      },
      onPlayErr: function (why) {
        if (!(window.QPlayer && QPlayer.isCurrent(tok))) return;
        var c = extCands(items || [], ep);
        var done = 0;
        /* 依次换到能播的那条 */
        (function next() {
          done += 1;
          if (done >= c.length) { QPlayer.state('error', { msg: '外部线路都不可用（' + (why || 'error') + '）' }); return; }
          playAt(done);
        })();
        function playAt(i) {
          var cur = c[i];
          var t2 = QPlayer.open({
            m: box, id: id, title: title, ep: ep, sources: [],
            onPickEp: function (e) { extPlayEp(box, id, title, Number(e) || 1, items); },
            onEnded: function () { var nx = ep + 1; if (extCands(items || [], nx).length) extPlayEp(box, id, title, nx, items); },
            onPlayErr: function () { if (QPlayer.isCurrent(t2)) next(); }
          });
          QPlayer.setEpisodes(extEpList(items || []), ep, '');
          srcHint(box, '外部线路 · ' + cur.name + ' · 第 ' + ep + ' 集（换源 ' + (i + 1) + '/' + c.length + '）');
          QPlayer.play(cur.url, cur.name, { hls: true });
        }
      }
    });
    QPlayer.setEpisodes(extEpList(items || []), ep, '');
    srcHint(box, '外部线路 · ' + cand[0].name + ' · 第 ' + ep + ' 集');
    QPlayer.play(cand[0].url, cand[0].name, { hls: true });
    extSetLastProv(cand[0].p);
  }

  /* ---------- 全网搜索（浏览器侧合组；服务器只转发原始 JSON） ---------- */
  function extSearchGroups(q, limit) {
    var nq = extNorm(q);
    if (nq.length < 2) return Promise.resolve([]);
    return extProviders().then(function (provs) {
      var jobs = provs.map(function (p, idx) {
        return extRaw(p.p, String(q).replace(/s+/g, '')).then(function (list) {
          var out = [];
          for (var i = 0; i < list.length; i++) {
            var v = list[i], cname = String(v.vod_name || '');
            if (!cname || EXT_NOISE.test(cname)) continue;
            var nc = extNorm(cname);
            if (nc.indexOf(nq) < 0 && nq.indexOf(nc) < 0) continue;
            var eps = extPlayEps(v);
            if (!eps.length) continue;
            out.push({ pri: idx, p: p.p, name: p.name, src: cname,
                       remarks: String(v.vod_remarks || ''), year: String(v.vod_year || ''),
                       type: String(v.type_name || ''), n: eps.length, eps: eps });
          }
          return out;
        });
      });
      return Promise.all(jobs).then(function (arrs) {
        var groups = {}, order = [];
        for (var a = 0; a < arrs.length; a++) {
          for (var i2 = 0; i2 < arrs[a].length; i2++) {
            var it = arrs[a][i2];
            var key = extNorm(extBase(it.src)) + '|' + (extSeason(it.src) || 1);
            var g = groups[key];
            if (!g) {
              g = { name: it.src, year: it.year, type: it.type, remarks: it.remarks, items: [], epsN: 0 };
              groups[key] = g; order.push(key);
            }
            var dup = -1;
            for (var k = 0; k < g.items.length; k++) if (g.items[k].p === it.p) { dup = k; break; }
            if (dup < 0) g.items.push(it);
            else if (it.n > g.items[dup].n) g.items[dup] = it;
            if (it.n > g.epsN) g.epsN = it.n;
          }
        }
        var out = [];
        for (var o = 0; o < order.length; o++) {
          var gg = groups[order[o]];
          gg.items.sort(function (x, y) { return x.pri - y.pri; });
          out.push(gg);
        }
        out.sort(function (x, y) {
          return (y.items.length - x.items.length) || (y.epsN - x.epsN) || (x.name.length - y.name.length);
        });
        out = out.slice(0, limit || 30);
        /* 体积预算：每条最多 120 集，全响应 6000 条以后只留前 5 集 */
        var budget = 6000;
        for (var z = 0; z < out.length; z++) {
          for (var w = 0; w < out[z].items.length; w++) {
            var ii = out[z].items[w];
            ii.eps = ii.eps.slice(0, 120);
            if (budget <= 0) ii.eps = ii.eps.slice(0, 5);
            else budget -= ii.eps.length;
          }
        }
        return out;
      });
    });
  }

  window.__extSearch = extSearchGroups;
  window.__extStart = extStart;
  window.__extAbort = function () { EXT_GEN += 1; };
  window.__extQuery = extQuery;
  window.__extEps = function (v) { return extPlayEps(v); };
  window.__extMatch = extMatch;
  window.__extBase = extBase;
  window.__extSeason = extSeason;
  window.__extNorm = extNorm;
