#!/usr/bin/env python3
"""站点构建器（全面替换版）：数据源换成 Bangumi 全量目录，AniList 退为补充/回退。

三张页面：
  index.html    首页 —— 今年新番，按「本周 / 本月」两种排列
  anime.html    番剧 —— 全量目录（8.8k），年份/类型/排序 + 搜索 + 加载更多
  movie.html    电影 —— 豆瓣 + TMDB 双源海报墙

前后端分离：页面只是壳，数据全部走 site/data/*.json，前端按需拉。

数据来源：
  catalog.json          bangumi-data 索引（id / 原名 / 中文名 / 类型 / 年份）
  site/anime/*.json     64 个分片（评分 / 话数 / 简介 / 标签 / 封面原图）
  data/fresh.json       AniList 当季（banner / 预告 / 倒计时）+ 豆瓣电影
  site/tmdb.json        TMDB 热门 / 正在上映（fetch_tmdb.py 产出）
"""
import datetime as dt
import json
import os
import pathlib
import re
import shutil

BASE = pathlib.Path(__file__).resolve().parent
SITE = BASE / "site"
TPL = BASE / "tpl"
DATA = BASE / "data"

MODELSCOPE = os.environ.get(
    "MODELSCOPE_BASE",
    "https://modelscope.cn/datasets/jingjiangze/Anime-JPG/resolve/master")
BUILD_TAG = dt.datetime.now().strftime("%m-%d %H:%M")
TODAY = dt.date.today()
WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]


def min_css(text):
    while "/*" in text:
        a = text.index("/*")
        b = text.index("*/", a) + 2
        text = text[:a] + text[b:]
    return " ".join(text.split())


def min_js(text):
    """保守压缩：只去「整行注释 / 行首缩进 / 行尾空白 / 空行」。

    不合并行 —— 合并会踩 ASI（自动分号插入）的坑；不动行内 `//` 与字符串内容。
    """
    out = []
    in_block = False
    for line in text.splitlines():
        s = line.strip()
        if in_block:
            if "*/" in s:
                s = s.split("*/", 1)[1].strip()
                in_block = False
            else:
                continue
        if s.startswith("/*"):
            if "*/" not in s:
                in_block = True
                continue
            s = s.split("*/", 1)[1].strip()
        if not s or s.startswith("//"):
            continue
        out.append(s)
    return "\n".join(out)


def norm(s):
    s = str(s or "").lower()
    s = re.sub(r"[\s\-_.·・:：!！?？,，。'\"()\[\]【】（）]", "", s)
    return s


def load_shards():
    out = {}
    d = SITE / "anime"
    if not d.is_dir():
        return out
    for p in sorted(d.glob("*.json")):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            continue
        if not isinstance(data, list):
            continue          # data.json 之类的非分片文件，跳过
        for rec in data:
            if isinstance(rec, dict) and rec.get("id"):
                out[rec["id"]] = rec
    return out


def build_anime():
    cat = json.loads((DATA / "catalog.json").read_text(encoding="utf-8"))
    shards = load_shards()

    # AniList 补充/回退：按标题归一化对齐到 Bangumi 条目
    al = {}
    fp = SITE / "fresh.json"
    if fp.is_file():
        try:
            fresh = json.loads(fp.read_text(encoding="utf-8"))
            for x in (fresh.get("anime") or []):
                for key in (x.get("n"), x.get("o")):
                    k = norm(key)
                    if k and k not in al:
                        al[k] = x
        except (ValueError, OSError):
            pass

    # 老站留下的 179 条磁力（key 是 AniList 体系，值里带种子标题），
    # 按「片名是否出现在种子标题里」映射到 bgm 条目，只用来点卡片角标。
    # 分集索引（magnet-eps.json）里出现的条目 = 真有磁力，角标以它为准；
    # 179 条旧 magnet.json 的映射作为补充。
    eps_ids, eps_names = set(), set()
    ep = SITE / "magnet-eps.json"
    if ep.is_file():
        try:
            for k, v in (json.loads(ep.read_text(encoding="utf-8")) or {}).items():
                if isinstance(k, str):
                    # 实测索引的键是纯数字 bgm id（8,797 个键全数字、bgm 前缀 0 个），
                    # 旧版只认 "bgm" 前缀 -> eps_ids 恒空、有磁力少算 943 部。
                    kk = k[3:] if k.startswith("bgm") else k
                    if kk.isdigit():
                        eps_ids.add(kk)
                nm = norm((v or {}).get("n"))
                if nm:
                    eps_names.add(nm)
        except (ValueError, OSError):
            pass

    mag_titles = []
    mp = SITE / "magnet.json"
    if mp.is_file():
        try:
            for v in (json.loads(mp.read_text(encoding="utf-8")) or {}).values():
                t = norm((v or {}).get("t"))
                if len(t) >= 4:
                    mag_titles.append(t)
        except (ValueError, OSError):
            pass

    rows, extra = [], {}
    for it in cat.get("items") or []:
        sid = it.get("id")
        d = shards.get(sid) or {}
        air = (it.get("d") or d.get("air") or "")
        y = int((air[:4] or it.get("y") or 0) or 0) or None
        month = int(air[5:7]) if len(air) >= 7 and air[5:7].isdigit() else 0
        day = int(air[8:10]) if len(air) >= 10 and air[8:10].isdigit() else 0
        wd = 0
        try:
            wd = dt.date(int(air[:4]), int(air[5:7]), int(air[8:10])).weekday() + 1
        except (ValueError, TypeError):
            pass
        name = it.get("n") or d.get("name") or ""
        cn = it.get("cn") or d.get("name_cn") or ""
        key = norm(cn or name)
        has_mag = 1 if (str(sid) in eps_ids or key in eps_names
                      or (len(key) >= 4 and any(key in t for t in mag_titles))) else 0
        # r[12] = bgm 排名：榜单要用「人气+评分综合」排序，
        # 只按评分排会让「1 人打 10 分」的冷门片霸榜
        rows.append([sid, name, cn, (it.get("t") or "").lower(), y, month, wd,
                     d.get("rating"), d.get("episodes") or 0, 1 if d else 0, has_mag, day,
                     (d or {}).get("rank") or 0])

        # 只给能匹配到 AniList 的条目挂补充字段，避免索引膨胀。
        # 固定槽位 [banner, img, trailer, next_at]，缺项填 null —— 前端按 ex[1]
        # 取封面、ex[2] 取预告。以前是「有才 append」，缺 banner 时整体前移，
        # 实测 32 条（名侦探柯南 / 海贼王等）把 next_at 时间戳当成了 YouTube id。
        a = al.get(norm(cn)) or al.get(norm(name))
        if a:
            ex = [a.get("banner") or None, a.get("img") or None,
                  a.get("trailer") or None, a.get("next_at") or None]
            if any(v is not None for v in ex):
                extra[str(sid)] = ex

    rows.sort(key=lambda r: (-(r[4] or 0), -(r[7] or 0)))
    payload = {"built": BUILD_TAG, "poster": f"{MODELSCOPE}/posters/bgm-",
               "posterSd": f"{MODELSCOPE}/posters-c/bgm-",
               "year": TODAY.year, "extra": extra, "rows": rows}
    out = SITE / "data"
    out.mkdir(parents=True, exist_ok=True)
    (out / "anime.json").write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"anime: {len(rows)} 条（有评分 {sum(1 for r in rows if r[7])} / 有详情 "
          f"{sum(1 for r in rows if r[9])} / 有磁力 {sum(1 for r in rows if r[10])} / AniList 补充 {len(extra)}）")
    return rows


def shard_of(title, n=16):
    """片名 -> 分片号，必须与打包端（src/shard_eps.py）逐字符一致。

    两边都是：按 Unicode 码点迭代 `h = (h*31 + ord(ch)) % 2**32`，取 `h % n`；
    tpl/magnet-eps.js 的 shardOf 也是同一算法 —— 改任一处必须同步另外两处，
    否则算出的片号对不上、永远查不到（src/test_shard_parity.py 对拍）。
    """
    h = 0
    for ch in str(title or "").strip():
        h = (h * 31 + ord(ch)) % 4294967296
    return h % n


def _nm(s):
    return "".join(ch for ch in str(s or "").lower()
                   if ch not in " \t\r\n-_.·・:：!！?？,，。'\"()[]【】（）～~")


def build_movies():
    """电影页数据：豆瓣（fresh.json 的 movies）+ TMDB（fetch_tmdb.py 的 tmdb.json）。"""
    # 豆瓣条目简介：movies-intro.json 由单独脚本抓（按豆瓣 subject_id 索引）。
    # 文件缺失 / 解析失败一律当空，不影响构建。
    intros = {}
    ip = SITE / "movies-intro.json"
    if ip.is_file():
        try:
            intros = (json.loads(ip.read_text(encoding="utf-8")).get("items") or {})
        except (ValueError, OSError):
            intros = {}

    douban = []
    fp = SITE / "fresh.json"
    if fp.is_file():
        try:
            fresh = json.loads(fp.read_text(encoding="utf-8"))
            for x in (fresh.get("movies") or []):
                if not isinstance(x, dict) or not x.get("n"):
                    continue
                u = x.get("u") or ""
                m = re.search(r"/subject/(\d+)", u)
                subj_id = m.group(1) if m else ""
                info = intros.get(subj_id)
                if not isinstance(info, dict):
                    info = {}
                # 本地有抓下来的豆瓣封面就用数据集地址（豆瓣图有防盗链，外链在浏览器里 403），
                # 没有就回退原外链，至少境外/直连场景还能出图。
                local_pic = SITE / "posters" / f"db-{subj_id}.jpg" if subj_id else None
                img = (f"{MODELSCOPE}/posters/db-{subj_id}.jpg"
                       if local_pic is not None and local_pic.is_file()
                       else (x.get("img") or ""))
                douban.append({"n": x["n"], "u": u,
                               "img": img, "r": x.get("r"),
                               "k": x.get("k") or "",
                               "id": subj_id,
                               "intro": info.get("intro") or "",
                               "sub": info.get("sub") or ""})
        except (ValueError, OSError):
            pass

    tmdb = []
    tp = SITE / "tmdb.json"
    if tp.is_file():
        try:
            for x in (json.loads(tp.read_text(encoding="utf-8")).get("items") or []):
                if not isinstance(x, dict) or not x.get("n"):
                    continue
                tmdb.append({"n": x["n"], "u": x.get("u") or "",
                             "img": x.get("img") or "", "r": x.get("r"),
                             "y": x.get("y"), "id": x.get("id"),
                             "ov": x.get("ov") or "",
                             "ot": x.get("ot") or "",
                             "tr": x.get("tr") or ""})
        except (ValueError, OSError):
            pass

    # 豆瓣 / TMDB 会各存一份同片（译名不同），列表里就重复出现两次。
    # 按归一化片名判同片，保留简介更长的一侧作为主条目，另一侧整条去掉 ——
    # 不合并字段，否则两套链接/海报会混在同一张卡片上。
    db_by_name = {}
    for i, d in enumerate(douban):
        k = _nm(d.get("n"))
        if k:
            db_by_name.setdefault(k, []).append(i)
    claimed, drop_db, drop_tm = set(), set(), set()
    n_same = 0
    for j, t in enumerate(tmdb):
        k = _nm(t.get("n"))
        if not k:
            continue
        i = next((x for x in db_by_name.get(k, []) if x not in claimed), None)
        if i is None:
            continue
        claimed.add(i)
        n_same += 1
        if len(t.get("ov") or "") > len(douban[i].get("intro") or ""):
            drop_db.add(i)
        else:
            drop_tm.add(j)
    if n_same:
        douban = [d for i, d in enumerate(douban) if i not in drop_db]
        tmdb = [t for j, t in enumerate(tmdb) if j not in drop_tm]
        print(f"movies: 去重 {n_same} 部（豆瓣 {len(drop_db)} / TMDB {len(drop_tm)} → "
              f"合计 {len(douban) + len(tmdb)}）")

    out = SITE / "data"
    out.mkdir(parents=True, exist_ok=True)
    (out / "movies.json").write_text(
        json.dumps({"built": BUILD_TAG, "douban": douban, "tmdb": tmdb},
                   ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    n_intro = sum(1 for d in douban if d["intro"])
    n_ov = sum(1 for t in tmdb if t["ov"])
    print(f"movies: douban {len(douban)} / tmdb {len(tmdb)} / "
          f"有简介 {n_intro}（豆瓣）+ {n_ov}（TMDB）")
    return douban, tmdb


# 页面骨架两种模式（PAGES 的第 8 字段选）：
#   modal  默认，弹窗预览：<main> 只有加载占位，mask + #modal 挂在 body 末尾，
#          点卡片才由前端填充；
#   inline 整页详情（detail.html）：mask 留空壳（不改弹窗行为时可继续用），
#          #modal 搬进 <main> 直接当页面主体 —— id 不变，前端详情模块只认 #modal，
#          所以两种模式共用同一套渲染代码，不用分支。
SHELL_MODAL = ('<main class=wrap id=main><div class=loading>加载中…</div></main>'
               '<div class=mask id=mask><div class=modal id=modal></div></div>')
SHELL_INLINE = ('<div class="mask" id="mask"></div>'
                '<main class="wrap" id="main"><div id="modal" class="dp"></div></main>')
SHELLS = {"modal": SHELL_MODAL, "inline": SHELL_INLINE}

PAGE = """<!doctype html><html lang=zh-CN><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>__TITLE__</title><link rel=preconnect href=https://modelscope.cn crossorigin><link rel=preconnect href=https://cdn-lfs-cn-1.modelscope.cn crossorigin><meta name=color-scheme content="dark light"><script>try{var t=localStorage.getItem('theme');if(t==='dark'||(!t&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.setAttribute('data-theme','dark')}catch(e){}</script><style>html{background:#f6f6fa}html[data-theme=dark]{background:#101013}</style><script>(function(){var B=['https://modelscope.cn/datasets/jingjiangze/Anime-JPG/resolve/master/assets/','https://gh-proxy.com/https://raw.githubusercontent.com/jingjiangze/jellyfin-mpv-shim-mpv-lazy/main/media/assets/','/'];var CSSF=['style-__CV__.css','style.css?v=__CV__'];function css(f,i){if(f>=CSSF.length)return;if(i>=B.length)return css(f+1,0);var l=document.createElement('link');l.rel='stylesheet';l.href=B[i]+CSSF[f];l.onerror=function(){l.parentNode&&l.parentNode.removeChild(l);css(f,i+1)};document.head.appendChild(l)}var JSF=['app-__JV__.js','app.js?v=__JV__','magnet-eps.js'];function ld(f,i){if(f>=JSF.length)return;if(i>=B.length)return ld(f+1,0);var s=document.createElement('script');s.src=B[i]+JSF[f];s.onload=function(){ld(f+1,0)};s.onerror=function(){s.parentNode&&s.parentNode.removeChild(s);ld(f,i+1)};document.body.appendChild(s)}css(0,0);if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){ld(0,0)});else ld(0,0)})()</script></head><body data-page=__PAGE__ data-build="__BUILD__"><header class=site-head id=topbar></header>__SHELL__</body></html>"""

PAGES = [
    ("index.html", "home", "番组计划 · 新番表", "搜索番剧…", 'class="is-on"', "", ""),
    ("anime.html", "anime", "番剧全收录 · 番组计划", "在 8,000+ 部里搜…", "", 'class="is-on"', ""),
    ("movie.html", "movie", "电影 · 番组计划", "搜索电影…", "", "", 'class="is-on"'),
    ("rank.html", "rank", "排行榜 · 番组计划", "搜索番剧…", "", "", ""),
    ("user.html", "user", "我的主页 · 番组计划", "搜索番剧…", "", "", ""),
    # 第 8 字段 = 骨架模式（见 SHELLS）；缺省按 "modal" 处理，所以上面的行不用动。
    # detail 走 inline：详情本身就是整页，#modal 直接当页面主体（路由 detail?id=<id>）。
    # 仍然是同一份静态壳，不预渲染 per-id。
    ("detail.html", "detail", "番剧详情 · 番组计划", "搜索番剧…", "", "", "", "inline"),
]


def main():
    build_anime()
    build_movies()

    css = min_css((TPL / "style.css").read_text(encoding="utf-8"))
    # 前端源码按文件名排序拼接（NN-*.js 的数字前缀就是拼接顺序），
    # 外壳只在这里包一次；各模块靠同一个 IIFE 作用域共享变量。
    src_dir = TPL / "src"
    parts = sorted(src_dir.glob("*.js"))
    if not parts:
        raise SystemExit("tpl/src 为空：前端源码缺失")
    raw_js = "(function () {\n'use strict';\n" + "\n".join(
        p.read_text(encoding="utf-8") for p in parts) + "\n})();\n"
    js = min_js(raw_js)
    # HTML 只留骨架：CSS/JS 落成独立文件由浏览器并行取，且能被 _headers 缓存。
    # 文件名不带哈希 —— 带哈希后每次部署旧文件名消失，缓存了旧 HTML 的浏览器会
    # 404；改用「短 max-age + must-revalidate」（见 tpl/_headers）。
    (SITE / "style.css").write_text(css, encoding="utf-8")
    (SITE / "app.js").write_text(js, encoding="utf-8")
    print(f"  app.js: {len(raw_js.encode('utf-8'))} -> "
          f"{len(js.encode('utf-8'))} B")
    # 内容版本号：这两个文件名固定（带哈希会让缓存了旧页的浏览器 404），
    # 靠 ?v= 换 URL 来绕过缓存。历史坑：早先 /style.css 不存在却标了
    # immutable，浏览器把 404 兜底的 HTML 永久缓存成 CSS/JS，页面直接白屏。
    import hashlib as _h
    cv = _h.sha1(css.encode("utf-8")).hexdigest()[:10]
    jv = _h.sha1(js.encode("utf-8")).hexdigest()[:10]
    # 2026-11-07：ModelScope 的 CDN 会无视 ?v=（按路径缓存），部署后 app.js 可能
    # 长时间停留在旧版本（实测 style 新 / app 旧混跑）。所以**同时**落一份带哈希
    # 名的副本：新 HTML 先加载 app-<jv>.js / style-<cv>.css（路径全新，CDN 必新），
    # 加载链第二位仍是固定名 + ?v=，给缓存了旧 HTML 的浏览器兜底（404 → 顺位下一个）。
    (SITE / f"app-{jv}.js").write_text(js, encoding="utf-8")
    (SITE / f"style-{cv}.css").write_text(css, encoding="utf-8")
    for row in PAGES:
        name, page, title, ph, on_home, on_anime, on_movie = row[:7]
        # 第 8 字段是骨架模式；只有一个页面走 inline，其余沿用 modal（不写第 8 字段即 modal，
        # 所以老行不用补空串）。未知值直接报错，别静默拼出一个没有 #modal 的壳。
        mode = row[7] if len(row) > 7 else "modal"
        if mode not in SHELLS:
            raise SystemExit(f"{name}: 未知骨架模式 {mode!r}")
        html = (PAGE.replace("__TITLE__", title).replace("__PAGE__", page)
                .replace("__CV__", cv).replace("__JV__", jv)
                .replace("__BUILD__", BUILD_TAG)
                .replace("__PH__", ph)
                .replace("__ON_HOME__", on_home).replace("__ON_ANIME__", on_anime)
                .replace("__ON_MOVIE__", on_movie)
                .replace("__SHELL__", SHELLS[mode]))
        (SITE / name).write_text(html, encoding="utf-8")
        print(f"  {name}: {len(html.encode('utf-8'))/1024:.0f} KB")
    print(f"pages: {len(PAGES)} 个"
          f"（{'/'.join(p[0].replace('.html', '') for p in PAGES)}）")

    # 分片给详情弹窗按需拉
    ddir = SITE / "data"
    ddir.mkdir(parents=True, exist_ok=True)
    for old in ddir.glob("s[0-9]*.json"):
        old.unlink()
    n = 0
    for p in sorted((SITE / "anime").glob("*.json")):
        try:
            shutil.copy2(p, ddir / f"s{p.stem}.json")
            n += 1
        except OSError:
            pass
    # 分片缺失会让详情弹窗（简介/标签/评分分布）大面积失效：生产是 64 片，
    # 少于 60 说明这一轮的数据不完整，宁可让构建失败也不要发一个残废站点。
    if n < 60:
        raise SystemExit(f"shards only {n}, expected >= 60 —— 分片缺失，拒绝发布")
    print(f"shards: {n} (flat, data/s<N>.json)")

    # tag 索引：番剧页按标签筛选用。tags 只在详情分片里有，这里汇总成
    # {tag: [id...]}，前端选标签时才按需拉（约几百 KB）。
    tagmap = {}
    for p2 in sorted((SITE / "anime").glob("*.json")):
        try:
            recs = json.loads(p2.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            continue
        if not isinstance(recs, list):
            continue
        for rec in recs:
            if not isinstance(rec, dict) or not rec.get("id"):
                continue
            for t in (rec.get("tags") or [])[:12]:
                t = str(t).strip()
                if not t or len(t) > 20:
                    continue
                tagmap.setdefault(t, []).append(rec["id"])
    # 出现 3 次以下的多半是噪音标签；另外 TV/剧场版/OVA 这些和「类型」筛选重复，
    # 留在标签里只会让下拉更难找
    DUP_TYPE = {"TV", "剧场版", "OVA", "网络", "短片", "音乐", "其他", "WEB", "ONA"}
    tagmap = {t: ids for t, ids in tagmap.items()
              if len(ids) >= 3 and t not in DUP_TYPE}
    (ddir / "tags.json").write_text(
        json.dumps(tagmap, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    # 详情页要显示「标签 + 全站计数」，但没必要为几十个数字拉 365KB 的 tags.json，
    # 单独出一份 tag→count 的小表（约 40KB）。
    counts = {t: len(ids) for t, ids in tagmap.items()}
    (ddir / "tagcounts.json").write_text(
        json.dumps(counts, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"tags: {len(tagmap)} 个 / {sum(len(v) for v in tagmap.values())} 条映射；counts 已出")

    # 磁力层：把 prior 会话的 magnet-eps.js 一起部署，并在页面里引用
    mj = TPL / "magnet-eps.js"
    if mj.is_file():
        raw_me = mj.read_text(encoding="utf-8")
        mep = min_js(raw_me)
        (SITE / "magnet-eps.js").write_text(mep, encoding="utf-8")
        print(f"  magnet-eps.js: {len(raw_me.encode('utf-8'))} -> "
              f"{len(mep.encode('utf-8'))} B")
        print("magnet-eps.js: minified")

    # 媒体库页已下线：清掉旧产物，避免又被快照发布出去
    try:
        (SITE / "data" / "library.json").unlink()
    except OSError:
        pass


if __name__ == "__main__":
    main()
