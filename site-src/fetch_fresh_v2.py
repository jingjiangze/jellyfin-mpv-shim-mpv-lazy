#!/usr/bin/env python3
"""增强版新番+新片抓取：
  - AniList: 当季新番 + trailer(YouTube) + nextAiringEpisode(星期/倒计时) + bannerImage
  - TMDB:    新片 + /videos 预告
  - 豆瓣:    新片榜单（海报用远程 URL）
输出: site/fresh.json（含 trailer_id / weekday / banner / next_ep 等字段）
额度: AniList 免费 + TMDB ~60 次 + 豆瓣免费
"""
import datetime
import hashlib
import json
import pathlib
import re
import time
import urllib.parse
import urllib.request

HERE = pathlib.Path(__file__).parent
SITE = HERE / "site"
PX = "http://127.0.0.1:7897"
DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))
PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({"http": PX, "https": PX}))
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
TMDB_KEY = "99bf884d2a3e8403ae8accded44ec73c"
TMDB_BASE = "https://api.tmdb.org/3"
WD = ["周一","周二","周三","周四","周五","周六","周日"]


def season_now():
    m = time.localtime().tm_mon; y = time.localtime().tm_year
    return ("WINTER" if m <= 3 else "SPRING" if m <= 6 else "SUMMER" if m <= 9 else "FALL"), y


def anilist_fetch(per=50):
    s, y = season_now()
    q = ('query($s:MediaSeason,$y:Int,$p:Int){Page(page:$p,perPage:%d){media('
         'type:ANIME,season:$s,seasonYear:$y,sort:POPULARITY_DESC){'
         'id title{romaji native english} startDate{year month day} '
         'coverImage{large} bannerImage averageScore episodes '
         'description(asHtml:false) genres siteUrl popularity status format duration '
         'studios(isMain:true){nodes{name}} '
         'trailer{id site} nextAiringEpisode{airingAt episode} '
         'relations{nodes{id type format siteUrl title{romaji native} coverImage{large}}}}}}' % per)
    out = []
    max_pages = int(os.environ.get("ANIME_PAGES", "0") or 0) or 10 ** 9
    try:
        _st = json.loads((HERE / "site" / "anime_pages.json").read_text(encoding="utf-8"))
    except Exception:
        _st = {}
    _start_page = int(_st.get("last_page", 0)) + 1
    page = _start_page
    _fetched = []
    _reason = "max"
    while page <= _start_page + max_pages - 1:
        body = json.dumps({"query": q, "variables": {"s": s, "y": y, "p": page}}).encode()
        if "seasonYear" not in q and "type:ANIME,sort" in q:
            body = json.dumps({"query": q, "variables": {"p": page}}).encode()
        ms = []
        for i in range(3):
            try:
                req = urllib.request.Request("https://graphql.anilist.co", data=body,
                                             headers={"Content-Type": "application/json", "User-Agent": UA})
                with DIRECT.open(req, timeout=25) as x:
                    d = json.loads(x.read().decode("utf-8", "replace"))
                ms = (((d.get("data") or {}).get("Page") or {}).get("media")) or []
                break
            except Exception:
                time.sleep(1.5 * (i + 1))
        if not ms:
            _reason = "empty"
            break
        out += ms
        _fetched.append(page)
        print(f"    page {page}: +{len(ms)}（累计 {len(out)}）", flush=True)
        if len(ms) < per:
            _reason = "end"
            break
        page += 1
        time.sleep(0.8)
    _st["last_page"] = 0 if _reason in ("empty", "end") else (_fetched[-1] if _fetched else 0)
    (HERE / "site" / "anime_pages.json").write_text(json.dumps(_st), encoding="utf-8")
    print(f"    断点 last_page={_st['last_page']}（{_reason}）", flush=True)

    return out


def tmdb_discover(per=40, pages=2):
    out = []
    for page in range(1, pages + 1):
        qs = urllib.parse.urlencode({
            "api_key": TMDB_KEY, "language": "zh-CN", "sort_by": "popularity.desc",
            "include_video": "true", "page": page,
            "primary_release_date.gte": (datetime.date.today() - datetime.timedelta(days=90)).isoformat(),
            "primary_release_date.lte": datetime.date.today().isoformat(),
        })
        url = f"{TMDB_BASE}/discover/movie?{qs}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with PROXY.open(req, timeout=25) as x:
                d = json.loads(x.read().decode("utf-8", "replace"))
            out += d.get("results") or []
        except Exception:
            pass
        time.sleep(0.8)
    return out


def tmdb_videos(movie_id):
    url = f"{TMDB_BASE}/movie/{movie_id}/videos?api_key={TMDB_KEY}&language=en-US"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with PROXY.open(req, timeout=20) as x:
            d = json.loads(x.read().decode("utf-8", "replace"))
        for v in (d.get("results") or []):
            if v.get("site") == "YouTube" and v.get("type") == "Trailer":
                return v.get("key")
        for v in (d.get("results") or []):
            if v.get("site") == "YouTube":
                return v.get("key")
    except Exception:
        pass
    return None


def douban_fetch(tags=("热门", "最新"), limit=60):
    seen, out = set(), []
    for tag in tags:
        url = ("https://movie.douban.com/j/search_subjects?"
               + urllib.parse.urlencode({"type": "movie", "tag": tag, "page_limit": limit, "page_start": 0}))
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://movie.douban.com/"})
            with DIRECT.open(req, timeout=20) as x:
                d = json.loads(x.read().decode("utf-8", "replace"))
            for s in (d.get("subjects") or []):
                t = (s.get("title") or "").strip()
                if t and t not in seen:
                    seen.add(t)
                    out.append(s)
        except Exception:
            pass
        time.sleep(0.5)
    return out


def clean_desc(s, n=200):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s or "")).strip()[:n]


def main():
    season_label, _ = season_now()
    out = {"season": f"{season_label} {datetime.date.today().year}", "anime": [], "movies": []}

    # ---- AniList 当季新番（含 trailer + weekday + banner）----
    an_raw = anilist_fetch(50)
    print(f"AniList: {len(an_raw)} 部", flush=True)
    for m in an_raw:
        t = m.get("title") or {}
        name = t.get("native") or t.get("romaji") or t.get("english")
        if not name:
            continue
        tr = m.get("trailer") or {}
        trailer_id = tr.get("id") if tr.get("site") == "youtube" else None
        na = m.get("nextAiringEpisode") or {}
        weekday = ""
        next_ep = na.get("episode") or 0
        next_at = na.get("airingAt") or 0
        if next_at:
            dt = datetime.datetime.fromtimestamp(next_at, tz=datetime.timezone(datetime.timedelta(hours=8)))
            weekday = WD[dt.weekday()]
        sd = m.get("startDate") or {}
        ymd = "-".join(f"{sd.get(k):02d}" if isinstance(sd.get(k), int) else str(sd.get(k) or "") for k in ("year", "month", "day")).strip("-")
        key = "a" + hashlib.md5(str(m["id"]).encode()).hexdigest()[:10]
        out["anime"].append({
            "k": key, "n": name,
            "o": t.get("romaji") or t.get("english"),
            "y": sd.get("year"),
            "r": round(m["averageScore"] / 10, 1) if m.get("averageScore") else None,
            "e": m.get("episodes"), "pop": m.get("popularity"),
            "g": (m.get("genres") or [])[:3],
            "v": clean_desc(m.get("description")),
            "u": m.get("siteUrl"),
            "img": (m.get("coverImage") or {}).get("large") or "",
            "banner": m.get("bannerImage") or "",
            "trailer": trailer_id,
            "next_ep": next_ep, "next_at": next_at, "wd": weekday,
            "air": ymd,
            "st": m.get("status"),
            "fm": m.get("format"),
            "du": m.get("duration"),
            "sd": (((m.get("studios") or {}).get("nodes")) or [{}])[0].get("name"),
            "rel": [{"n": (((r.get("title") or {}).get("native")) or ((r.get("title") or {}).get("romaji"))),
                     "f": r.get("format"), "u": r.get("siteUrl"),
                     "i": ((r.get("coverImage") or {}).get("large"))}
                    for r in (((m.get("relations") or {}).get("nodes")) or [])
                    if r.get("type") == "ANIME" and r.get("format") != "MUSIC"][:8],
        })

    # ---- TMDB 热门新片（含 trailer）----
    tm_raw = tmdb_discover(40, 2)
    print(f"TMDB discover: {len(tm_raw)} 部", flush=True)
    for m in tm_raw[:60]:
        title = m.get("title") or m.get("original_title")
        if not title:
            continue
        trailer_id = None
        vid = m.get("id")
        if vid:
            time.sleep(0.3)
            trailer_id = tmdb_videos(vid)
        rd = (m.get("release_date") or "")[:4]
        key = "m" + hashlib.md5(str(vid).encode()).hexdigest()[:10]
        out["movies"].append({
            "k": key, "n": title,
            "y": int(rd) if rd else None,
            "r": round(m["vote_average"], 1) if m.get("vote_average") else None,
            "g": [g for g in (m.get("genre_ids") or [])][:0],   # genre_ids 需查表，跳过
            "v": clean_desc(m.get("overview")),
            "img": f"https://image.tmdb.org/t/p/w342{m['poster_path']}" if m.get("poster_path") else "",
            "banner": f"https://image.tmdb.org/t/p/w780{m['backdrop_path']}" if m.get("backdrop_path") else "",
            "trailer": trailer_id,
            "u": f"https://www.themoviedb.org/movie/{vid}" if vid else "",
        })

    # ---- 豆瓣补充（只加 TMDB 没有的）----
    tm_titles = {x["n"].lower() for x in out["movies"]}
    db_raw = douban_fetch(("热门", "最新"))
    for s in db_raw:
        t = (s.get("title") or "").strip()
        if t and t.lower() not in tm_titles:
            key = "d" + hashlib.md5(str(s.get("id")).encode()).hexdigest()[:10]
            out["movies"].append({
                "k": key, "n": t,
                "r": float(s["rate"]) if s.get("rate") else None,
                "img": s.get("cover") or "",
                "u": s.get("url"), "trailer": None,
            })
    print(f"豆瓣补充: {len(out['movies'])} 部总计", flush=True)

    # 只增不减：与既有目录按 k 合并，避免某轮超时抓不全时目录缩水
    try:
        _prev = json.loads((HERE / "site" / "fresh.json").read_text(encoding="utf-8")).get("anime") or []
    except Exception:
        _prev = []
    out["anime"] += _prev
    _seen = set()
    _dedup = []
    for _x in out["anime"]: 
        if _x["k"] in _seen:
            continue
        _seen.add(_x["k"])
        _dedup.append(_x)
    out["anime"] = _dedup
    print(f"目录合并后: {len(out['anime'])} 部", flush=True)


    (SITE / "fresh.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"-> fresh.json {len(json.dumps(out))/1024:.0f} KB")
    print("新番样例:", [(x["n"][:14], x.get("trailer") or "-", x.get("wd") or "-") for x in out["anime"][:5]])
    print("新片样例:", [(x["n"][:14], x.get("trailer") or "-") for x in out["movies"][:5]])


if __name__ == "__main__":
    main()
