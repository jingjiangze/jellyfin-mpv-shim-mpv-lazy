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
                if isinstance(k, str) and k.startswith("bgm"):
                    eps_ids.add(k[3:])
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


def build_movies():
    """电影页数据：豆瓣（fresh.json 的 movies）+ TMDB（fetch_tmdb.py 的 tmdb.json）。"""
    douban = []
    fp = SITE / "fresh.json"
    if fp.is_file():
        try:
            fresh = json.loads(fp.read_text(encoding="utf-8"))
            for x in (fresh.get("movies") or []):
                if not isinstance(x, dict) or not x.get("n"):
                    continue
                douban.append({"n": x["n"], "u": x.get("u") or "",
                               "img": x.get("img") or "", "r": x.get("r"),
                               "k": x.get("k") or ""})
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
                             "y": x.get("y"), "id": x.get("id")})
        except (ValueError, OSError):
            pass

    out = SITE / "data"
    out.mkdir(parents=True, exist_ok=True)
    (out / "movies.json").write_text(
        json.dumps({"built": BUILD_TAG, "douban": douban, "tmdb": tmdb},
                   ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"movies: douban {len(douban)} / tmdb {len(tmdb)}")
    return douban, tmdb


PAGE = """<!doctype html><html lang=zh-CN><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>__TITLE__</title><link rel=stylesheet href="style.css?v=__CV__"></head><body data-page=__PAGE__ data-build="__BUILD__"><header class=site-head id=topbar></header><main class="wrap" id=main><div class=loading>加载中…</div></main><div class=mask id=mask><div class=modal id=modal></div></div><script src="app.js?v=__JV__"></script><script defer src="./magnet-eps.js"></script></body></html>"""

PAGES = [
    ("index.html", "home", "番组计划 · 新番表", "搜索番剧…", 'class="is-on"', "", ""),
    ("anime.html", "anime", "番剧全收录 · 番组计划", "在 8,000+ 部里搜…", "", 'class="is-on"', ""),
    ("movie.html", "movie", "电影 · 番组计划", "搜索电影…", "", "", 'class="is-on"'),
]


def main():
    build_anime()
    build_movies()

    css = min_css((TPL / "style.css").read_text(encoding="utf-8"))
    js = (TPL / "app.js").read_text(encoding="utf-8")
    # HTML 只留骨架：CSS/JS 落成独立文件由浏览器并行取，且能被 _headers 缓存。
    # 文件名不带哈希 —— 带哈希后每次部署旧文件名消失，缓存了旧 HTML 的浏览器会
    # 404；改用「短 max-age + must-revalidate」（见 tpl/_headers）。
    (SITE / "style.css").write_text(css, encoding="utf-8")
    (SITE / "app.js").write_text(js, encoding="utf-8")
    # 内容版本号：这两个文件名固定（带哈希会让缓存了旧页的浏览器 404），
    # 靠 ?v= 换 URL 来绕过缓存。历史坑：早先 /style.css 不存在却标了
    # immutable，浏览器把 404 兜底的 HTML 永久缓存成 CSS/JS，页面直接白屏。
    import hashlib as _h
    cv = _h.sha1(css.encode("utf-8")).hexdigest()[:10]
    jv = _h.sha1(js.encode("utf-8")).hexdigest()[:10]
    for name, page, title, ph, on_home, on_anime, on_movie in PAGES:
        html = (PAGE.replace("__TITLE__", title).replace("__PAGE__", page)
                .replace("__CV__", cv).replace("__JV__", jv)
                .replace("__BUILD__", BUILD_TAG)
                .replace("__PH__", ph)
                .replace("__ON_HOME__", on_home).replace("__ON_ANIME__", on_anime)
                .replace("__ON_MOVIE__", on_movie))
        (SITE / name).write_text(html, encoding="utf-8")
        print(f"  {name}: {len(html.encode('utf-8'))/1024:.0f} KB")

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
    print(f"tags: {len(tagmap)} 个 / {sum(len(v) for v in tagmap.values())} 条映射")

    # 磁力层：把 prior 会话的 magnet-eps.js 一起部署，并在页面里引用
    mj = TPL / "magnet-eps.js"
    if mj.is_file():
        shutil.copy2(mj, SITE / "magnet-eps.js")
        print("magnet-eps.js: copied")

    # 媒体库页已下线：清掉旧产物，避免又被快照发布出去
    try:
        (SITE / "data" / "library.json").unlink()
    except OSError:
        pass


if __name__ == "__main__":
    main()
