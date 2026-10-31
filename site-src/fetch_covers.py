#!/usr/bin/env python3
"""把新番 / 新片的 AniList 封面下载到 site/posters/<key>.jpg。

为什么要落地：AniList 是海外源，实测单张 28–157KB、TTFB 0.57–4.80s 抖动很大，
而站点一次要挂上百张。落到本地后由 CI 的 "Sync posters to ModelScope" 步骤
自动上云（国内 CDN，实测 0.35s），build_site 再把主源换成 ModelScope。

只补不改：目标文件已存在就跳过；被 ModelScope 审核撤销过的（ms-revert-blocklist.txt）
也跳过，避免反复触发审核。
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
BLOCK = HERE / "ms-revert-blocklist.txt"

LIMIT = int(os.environ.get("COVER_MAX", "150") or 150)
WORKERS = int(os.environ.get("COVER_WORKERS", "4"))
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36"


def blocked():
    if not BLOCK.is_file():
        return set()
    return {l.strip() for l in BLOCK.read_text(encoding="utf-8").splitlines() if l.strip()}


def targets():
    fp = SITE / "fresh.json"
    if not fp.is_file():
        return []
    fresh = json.loads(fp.read_text(encoding="utf-8"))
    out = []
    for bucket in ("anime", "movies"):
        for x in fresh.get(bucket) or []:
            k, img = x.get("k"), x.get("img")
            if k and img:
                out.append((k, img))
    seen, uniq = set(), []
    for k, img in out:
        if k in seen:
            continue
        seen.add(k)
        uniq.append((k, img))
    return uniq


def grab(item):
    k, url = item
    dst = OUT / f"{k}.jpg"
    if dst.is_file() and dst.stat().st_size > 2000:
        return "skip"
    req = urllib.request.Request(url, headers={"user-agent": UA, "accept": "image/*"})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            ctype = (r.headers.get("content-type") or "").lower()
            if not ctype.startswith("image/"):
                return "badtype"
            data = r.read()
    except Exception as e:
        print(f"! {k} {type(e).__name__}: {e}")
        return "err"
    if len(data) < 2000:
        return "tiny"
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(data)
    return "ok"


def main():
    bad = blocked()
    jobs = [(k, u) for k, u in targets() if f"{k}.jpg" not in bad]
    print(f"候选 {len(jobs)} 条（黑名单 {len(bad)} 条已排除），本轮上限 {LIMIT}")
    todo, skipped = [], 0
    for k, u in jobs:
        p = OUT / f"{k}.jpg"
        if p.is_file() and p.stat().st_size > 2000:
            skipped += 1
        else:
            todo.append((k, u))
    todo = todo[:LIMIT]
    print(f"已有 {skipped} 张，本轮下载 {len(todo)} 张")
    if not todo:
        return

    stat = {"ok": 0, "skip": 0, "err": 0, "tiny": 0, "badtype": 0}
    with cf.ThreadPoolExecutor(max_workers=max(1, WORKERS)) as ex:
        for r in ex.map(grab, todo):
            stat[r] = stat.get(r, 0) + 1
    print("完成：" + " / ".join(f"{k} {v}" for k, v in stat.items() if v))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"FATAL {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(0)
