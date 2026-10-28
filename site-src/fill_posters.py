#!/usr/bin/env python3
"""批量补全缺失海报：
  1. AniList（本机直连 200/1.7s）→ 番剧 + 当季新番
  2. TMDB v3（api.tmdb.org 走代理）→ 电影
额度控制：每部片固定 1 次搜索 + 1 次下载；带缓存跳过已处理的。
"""
import hashlib
import json
import os
import pathlib
import re
import sys
import time
import urllib.parse
import urllib.request

HERE = pathlib.Path(__file__).parent
SITE = HERE / "site"
PX = "http://127.0.0.1:7897"
DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))
PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({"http": PX, "https": PX}))
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36"
TMDB_KEY = "99bf884d2a3e8403ae8accded44ec73c"
CACHE = HERE / "poster_cache.json"

NOISE = re.compile(
    r"\b(2160p|1080p|720p|480p|4k|8k|uhd|bluray|blu-ray|remux|web-?dl|webrip|hdtv|dvdrip|"
    r"hdr10|hdr|dv|dolby|vision|hevc|h265|h264|x265|x264|avc|av1|10bit|8bit|60fps|50fps|"
    r"dts-hd|dts|truehd|atmos|aac|flac|ddp|eac3|ac3|2audio|3audio|4audio|5audio|proper|repack|"
    r"extended|remastered|complete|mkv|mp4|avi|ts|iso|sdr|bit|fps|movies|anywhere|v2|v3|hq)\b|"
    r"(国语|粤语|日语|英语|台配|双语|三语|四语|多语|国英|国粤|简中|繁中|简体|繁体|中字|中文字幕|"
    r"英字|字幕|内封|内嵌|外挂|特效|原盘|修复版|加长版|高码率|高码|原画|典藏版|收藏版)", re.I)


def clean(it_name):
    s = re.sub(r"[\[\]【】()（）]", " ", it_name or "")
    s = NOISE.sub(" ", s)
    en = re.findall(r"[A-Za-z][A-Za-z']{2,}", s)
    zh = re.findall(r"[\u4e00-\u9fff]{2,}", s)
    return (" ".join(en[:6]).strip() or "".join(zh[:4]).strip() or (it_name or "").strip())


def load_cache():
    if CACHE.exists():
        return json.loads(CACHE.read_text(encoding="utf-8"))
    return {}


def save_cache(c):
    CACHE.write_text(json.dumps(c, ensure_ascii=False, indent=1), encoding="utf-8")


def anilist_search(kw):
    q = ('query($s:String){Page(page:1,perPage:3){media(search:$s,type:ANIME){'
         'id title{romaji native english} coverImage{large} averageScore}}}')
    body = json.dumps({"query": q, "variables": {"s": kw}}).encode()
    for i in range(2):
        try:
            req = urllib.request.Request("https://graphql.anilist.co", data=body,
                                         headers={"Content-Type": "application/json", "User-Agent": UA})
            with DIRECT.open(req, timeout=20) as x:
                d = json.loads(x.read().decode("utf-8", "replace"))
            return ((d.get("data") or {}).get("Page") or {}).get("media") or []
        except Exception:
            time.sleep(1.2)
    return []


def tmdb_search(kw, year=None):
    params = {"api_key": TMDB_KEY, "query": kw, "language": "zh-CN"}
    if year:
        params["year"] = str(year)
    url = f"https://api.tmdb.org/3/search/movie?" + urllib.parse.urlencode(params)
    for i in range(2):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with PROXY.open(req, timeout=18) as x:
                d = json.loads(x.read().decode("utf-8", "replace"))
            return (d.get("results") or [])
        except Exception:
            time.sleep(1.2)
    return []


def dl(url, dest):
    if not url:
        return False
    opener = PROXY if "tmdb" in url else DIRECT
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with opener.open(req, timeout=20) as x:
            b = x.read()
        if len(b) > 2000:
            dest.write_bytes(b)
            return True
    except Exception:
        pass
    return False


def postimg(k, blob, pdir):
    h = hashlib.md5(k.encode()).hexdigest()[:10]
    pdir.joinpath(f"{h}.jpg").write_bytes(blob)
    return f"posters/{h}.jpg"


def norm(s):
    return re.sub(r"[^0-9a-z\u4e00-\u9fff\u3040-\u30ff]+", "", (s or "").lower())


def main():
    data = json.loads((SITE / "data.json").read_text(encoding="utf-8"))
    fresh = json.loads((SITE / "fresh.json").read_text(encoding="utf-8"))
    cache = load_cache()
    pdir = SITE / "posters"; pdir.mkdir(exist_ok=True)

    fixed = 0; total = 0
    # ---- AniList 批量：番剧（库内 + 新番） ----
    anime_names = []
    for x in data:
        if not x[5] and x[2] == 1:          # t=1 Series
            kw = clean(x[1])
            if kw:
                anime_names.append((("lib", x[0]), kw, x))
    for x in (fresh.get("a") or []):
        if not x[3]:
            kw = x[1]
            if kw:
                anime_names.append((("fresh_a", x[0]), kw, x))
    print(f"AniList 目标: {len(anime_names)}")
    cap = int(os.environ.get("POSTER_MAX", "0") or 0)
    tried = 0

    for (src, key), kw, it in anime_names:
        if key in cache:
            path = cache[key]
            if path and (SITE / path).exists():
                if src == "lib":
                    it[5] = 1; it.append(path) if False else None
                    # data.json 里海报路径由 index 动态计算
                    it[5] = 1
                else:
                    x2 = it; x2[3] = path
                fixed += 1
                continue
        if cap and tried >= cap:
            print(f"达到 POSTER_MAX={cap}，本轮停止（下次继续）")
            break
        tried += 1
        res = anilist_search(kw)
        if not res:
            base = re.sub(r"(第\s*[0-9一二三四五六七八九十]+\s*[季期]|S\d{1,2}|Season\s*\d+|\s+\d{1,2}$)", "", kw).strip()
            if base != kw and len(base) >= 2:
                res = anilist_search(base)
        if res:
            m = res[0]
            cover = ((m.get("coverImage") or {}).get("large")) or ""
            blob_ok = dl(cover, pdir / ("tmp_" + hashlib.md5(key.encode()).hexdigest()[:8] + ".jpg"))
            if blob_ok:
                h = hashlib.md5(key.encode()).hexdigest()[:10]
                dest = pdir / f"{h}.jpg"
                (pdir / ("tmp_" + h[:8] + ".jpg")).replace(dest)
                path = f"posters/{h}.jpg"
            else:
                path = cover
            cache[key] = path
            if src == "lib":
                it[5] = 1
                if len(it) <= 7:
                    it.append(path)
                else:
                    it[7] = path
            else:
                it[3] = path
            fixed += 1
            print(f"  AniList OK  {kw[:28]} -> {path[:30]}", flush=True)
        else:
            print(f"  AniList MISS {kw[:30]}", flush=True)
        time.sleep(0.8)
        total += 1

    # ---- TMDB 批量：电影（库内 + 新片） ----
    movie_names = []
    for x in data:
        if not x[5] and x[2] == 0:
            kw = clean(x[1])
            year = x[3] or None
            if kw:
                movie_names.append((("lib", x[0]), kw, year, x))
    for x in (fresh.get("m") or []):
        if not x[3]:
            kw = x[1]
            if kw:
                movie_names.append((("fresh_m", x[0]), kw, None, x))
    print(f"\nTMDB 目标: {len(movie_names)}")

    for (src, key), kw, year, it in movie_names:
        if key in cache:
            path = cache[key]
            if path and (SITE / path).exists():
                if src == "lib":
                    it[5] = 1
                    if len(it) <= 7: it.append(path)
                    else: it[7] = path
                else:
                    it[3] = path
                fixed += 1
                continue
        res = tmdb_search(kw, year)
        if not res:
            raw_name = it[1] if isinstance(it, list) else it.get("name", "")
            base = clean(raw_name)
            if base != kw and len(base) >= 3:
                res = tmdb_search(base, year)
        if res:
            pp = res[0].get("poster_path")
            if pp:
                blob_ok = dl(f"https://image.tmdb.org/t/p/w342{pp}", pdir / ("tmp_t.jpg"))
                if blob_ok:
                    h = hashlib.md5(key.encode()).hexdigest()[:10]
                    dest = pdir / f"{h}.jpg"
                    import shutil; shutil.move(str(pdir / "tmp_t.jpg"), str(dest))
                    path = f"posters/{h}.jpg"
                else:
                    path = f"https://image.tmdb.org/t/p/w342{pp}"
                cache[key] = path
                if src == "lib":
                    it[5] = 1
                    if len(it) <= 7: it.append(path)
                    else: it[7] = path
                else:
                    it[3] = path
                fixed += 1
                print(f"  TMDB OK    {kw[:28]} -> {path[:30]}", flush=True)
            else:
                print(f"  TMDB no-poster {kw[:28]}", flush=True)
        else:
            print(f"  TMDB MISS  {kw[:28]}", flush=True)
        time.sleep(0.8)
        total += 1

    save_cache(cache)
    (SITE / "data.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (SITE / "fresh.json").write_text(json.dumps(fresh, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"\n补到 {fixed} 张，处理 {total} 部")


if __name__ == "__main__":
    main()
