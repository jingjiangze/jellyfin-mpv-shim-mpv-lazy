#!/usr/bin/env python3
"""把 Bangumi 封面抓到本地，供 ModelScope 数据集分发。

尺寸选择：用 `c`（中图，实测 8.7KB）而不是 `l`（大图 77.7KB）。
  8,800 部 × 77.7KB ≈ 680MB —— 塞不进 GitHub LFS，推 ModelScope 也很重；
  8,800 × 8.7KB ≈ 75MB —— 整个数据集可控，卡片宽 176px 也够用。
`c` 的 URL 可以直接从 `l` 换路径得到：/pic/cover/l/ → /pic/cover/c/

用法：SHARD_LIST=0,1 python fetch_bgm_covers.py
"""
import concurrent.futures as cf
import json
import os
import pathlib
import sys
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
SITE = HERE / "site"
OUT = SITE / "posters"
UA = "jellyfin-mpv-shim-mpv-lazy/anime-covers (+https://github.com/jingjiangze)"

SHARD_TOTAL = int(os.environ.get("SHARD_TOTAL", "64"))
WORKERS = int(os.environ.get("COVER_WORKERS", "8"))
LIMIT = int(os.environ.get("COVER_MAX", "0"))

if os.environ.get("SHARD_LIST"):
    MY = {int(x) for x in os.environ["SHARD_LIST"].split(",") if x.strip()}
else:
    a = int(os.environ.get("SHARD_FROM", "0"))
    b = int(os.environ.get("SHARD_TO", "0"))
    MY = set(range(a, b + 1))


def medium(url):
    if not url:
        return ""
    for a, b in (("/cover/l/", "/cover/c/"), ("/cover/m/", "/cover/c/"), ("/cover/g/", "/cover/c/")):
        if a in url:
            return url.replace(a, b)
    return url


def grab(item):
    sid, url = item
    dst = OUT / f"bgm-{sid}.jpg"
    if dst.is_file() and dst.stat().st_size > 800:
        return "skip"
    try:
        req = urllib.request.Request(url, headers={"user-agent": UA, "accept": "image/*"})
        with urllib.request.urlopen(req, timeout=25) as r:
            ctype = (r.headers.get("content-type") or "").lower()
            if not ctype.startswith("image/"):
                return "badtype"
            data = r.read()
    except Exception:
        return "err"
    if len(data) < 800:
        return "tiny"
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(data)
    return "ok"


def main():
    jobs = []
    for s in sorted(MY):
        p = SITE / "anime" / f"{s}.json"
        if not p.is_file():
            print(f"! 缺分片 {p}")
            continue
        for rec in json.loads(p.read_text(encoding="utf-8")):
            u = medium(rec.get("poster") or "")
            if u and rec.get("id"):
                jobs.append((rec["id"], u))
    if LIMIT:
        jobs = jobs[:LIMIT]
    print(f"shards={sorted(MY)} 待抓 {len(jobs)} 张")

    stat = {}
    with cf.ThreadPoolExecutor(max_workers=max(1, WORKERS)) as ex:
        for r in ex.map(grab, jobs):
            stat[r] = stat.get(r, 0) + 1
    print("完成：" + " / ".join(f"{k} {v}" for k, v in sorted(stat.items())))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"FATAL {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)
