#!/usr/bin/env python3
"""拉 TMDB 热门 / 正在上映，写 site/tmdb.json，并把海报落本地供数据集分发。

数据源：TMDB v3 api_key（不是 v4 Bearer）。
  popular     × 2 页（20×2）
  now_playing × 1 页（20）
  → 按 id 去重，取 vote_average 最高的 60 部。

海报：https://image.tmdb.org/t/p/w342{poster_path} → POSTER_DIR/tmdb-<id>.jpg
      （POSTER_DIR 默认 site/posters，相对 cwd；已存在且 >800 字节则跳过）
      build_site 读到的 img 前缀与海报目录一致，走 ModelScope 分发。

输出：site/tmdb.json
  {"built":"MM-DD HH:MM","items":[{"id","n","u","img","r","y","ov","ot"}]}
  ov = 中文剧情简介（TMDB overview，language=zh-CN 下已是中文）；
  ot = 原始标题（original_title）。
  下载失败（或没有 poster_path）的条目**不写 img 字段**，前端显示占位。

容错：单条失败 continue；接口全挂就打印后退出（exit 0），CI 不变红，
      站点继续用上一轮的 tmdb.json。

用法：cd site-src && python -u fetch_tmdb.py
"""
import datetime as dt
import json
import os
import pathlib
import time
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
SITE = HERE / "site"
POSTER_DIR = pathlib.Path(os.environ.get("POSTER_DIR", "site/posters"))

MODELSCOPE = os.environ.get(
    "MODELSCOPE_BASE",
    "https://modelscope.cn/datasets/jingjiangze/Anime-JPG/resolve/master")
TMDB_KEY = os.environ.get("TMDB_KEY") or "99bf884d2a3e8403ae8accded44ec73c"
UA = "jellyfin-mpv-shim-mpv-lazy/anime-tmdb"
LIMIT = int(os.environ.get("TMDB_MAX", "60"))

TASKS = (("popular", 1), ("popular", 2), ("now_playing", 1))


def get(url, accept):
    req = urllib.request.Request(url, headers={"user-agent": UA, "accept": accept})
    with urllib.request.urlopen(req, timeout=25) as r:
        return r.read()


def fetch_page(path, page):
    url = (f"https://api.tmdb.org/3/movie/{path}"
           f"?api_key={TMDB_KEY}&language=zh-CN&page={page}")
    return json.loads(get(url, "application/json").decode("utf-8")).get("results") or []


def pick_trailer(mid):
    """官方预告（YouTube key）：official Trailer 优先，其次任意 Trailer/Teaser。

    失败返回空串（条目照常入库，只是没有预告按钮）。
    """
    try:
        body = json.loads(get(
            f"https://api.tmdb.org/3/movie/{mid}/videos?api_key={TMDB_KEY}&language=zh-CN",
            "application/json").decode("utf-8"))
    except Exception:
        return ""
    yt = [v for v in (body.get("results") or [])
          if v.get("site") == "YouTube" and v.get("key")]

    def rank(v):
        return (1 if v.get("official") else 0,
                1 if v.get("type") == "Trailer" else 0,
                1 if v.get("iso_639_1") == "zh" else 0,
                v.get("published_at") or "")

    yt.sort(key=rank, reverse=True)
    return yt[0]["key"] if yt else ""


def grab_poster(mid, poster_path):
    """下载 w342 海报，成功（含已存在）返回 True。"""
    if not poster_path:
        return False
    dst = POSTER_DIR / f"tmdb-{mid}.jpg"
    try:
        if dst.is_file() and dst.stat().st_size > 800:
            return True
    except OSError:
        pass
    try:
        data = get(f"https://image.tmdb.org/t/p/w342{poster_path}", "image/*")
    except Exception:
        return False
    if len(data) < 800:
        return False
    try:
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(data)
    except OSError:
        return False
    return True


def main():
    seen, raw = set(), []
    for path, page in TASKS:
        try:
            res = fetch_page(path, page)
        except Exception as e:
            print(f"! {path} p{page} 失败：{type(e).__name__}: {e}")
            continue
        print(f"  {path} p{page}: {len(res)} 条")
        for m in res:
            mid = m.get("id")
            if not mid or mid in seen:
                continue
            seen.add(mid)
            raw.append(m)

    if not raw:
        print("tmdb: 0 条（接口全失败），保留旧数据")
        return

    raw.sort(key=lambda m: -(m.get("vote_average") or 0))
    items, with_poster = [], 0
    for m in raw[:LIMIT]:
        mid = m["id"]
        ok = grab_poster(mid, m.get("poster_path") or "")
        time.sleep(0.12)                 # videos 接口限速：60 部 ≈ 8s，换官方预告键
        tr = pick_trailer(mid)
        if ok:
            with_poster += 1
        rel = m.get("release_date") or ""
        rec = {"id": mid,
               "n": m.get("title") or m.get("original_title") or "",
               "u": f"https://www.themoviedb.org/movie/{mid}",
               "img": f"{MODELSCOPE}/posters/tmdb-{mid}.jpg" if ok else "",
               "r": round(float(m.get("vote_average") or 0), 1),
               "y": int(rel[:4]) if rel[:4].isdigit() else None,
               "ov": (m.get("overview") or "").strip(),
               "ot": (m.get("original_title") or "").strip(),
               "tr": tr}
        if not ok:
            rec.pop("img")          # 没下到海报就不给 URL，省得前端全挂空图
        items.append(rec)

    SITE.mkdir(parents=True, exist_ok=True)
    (SITE / "tmdb.json").write_text(
        json.dumps({"built": dt.datetime.now().strftime("%m-%d %H:%M"), "items": items},
                   ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"tmdb: {len(items)} 条（海报 {with_poster} 张 → {POSTER_DIR}）")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"! tmdb 抓取失败：{type(e).__name__}: {e}")
