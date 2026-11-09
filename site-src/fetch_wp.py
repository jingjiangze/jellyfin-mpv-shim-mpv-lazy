#!/usr/bin/env python3
"""TMDB watch providers（「哪里能看」）：把每部电影的订阅/租/买平台抓成一份快照。

为什么要它：本站只有「能不能在自家播放器播」，没有「合法渠道在哪看」。TMDB 的
`/movie/{id}/watch/providers` 是目前唯一成熟的数据源（底层是 JustWatch）。

硬约束（TMDB 条款，写在这里防以后忘）：
  · **必须署名**：数据来源 JustWatch + TMDB（前端已加一行说明）；
  · **缓存不得超过 6 个月**（所以我们每轮刷新，从不长期保留）；
  · TMDB **不给深链**，`link` 是 TMDB 自己的观看页 —— 只能链到它，不能伪装成平台官方播放页；
  · 商用需书面协议，本站非商用。
成本：1 次请求/片（默认上限 80 片），TMDB 限速 ~40 req/s，这里串行 + 0.15s 间隔。

用法：cd site-src && TMDB_KEY=… python -u fetch_wp.py [--max 80]
输出 site/watchproviders.json = {built, items: {"<tmdb_id>": {link, regions: {CN:[名], HK:[…], TW:[…]}}}}
"""
import json
import os
import pathlib
import sys
import time
import urllib.parse
import urllib.request

BASE = pathlib.Path(__file__).resolve().parent
SITE = BASE / "site"
TMDB = json.loads((SITE / "tmdb.json").read_text(encoding="utf-8")) if (SITE / "tmdb.json").is_file() else {}
ITEMS = TMDB.get("items") or []
KEY = (os.environ.get("TMDB_KEY") or "").strip()
WANT = ("CN", "HK", "TW", "SG", "JP", "US")
UA = "anime-site/1.0 (watch providers snapshot)"


def get(url):
    req = urllib.request.Request(url, headers={"user-agent": UA, "accept": "application/json"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    cap = 80
    if "--max" in sys.argv:
        cap = int(sys.argv[sys.argv.index("--max") + 1])
    if not KEY:
        print("::warning::TMDB_KEY 未配置，跳过 watch providers")
        return 0
    out, ok = {}, 0
    for it in ITEMS[:cap]:
        tid = it.get("id")
        if not tid:
            continue
        url = (f"https://api.themoviedb.org/3/movie/{tid}/watch/providers"
               f"?api_key={KEY}")
        try:
            d = get(url)
        except Exception as e:
            print(f"! {tid}: {type(e).__name__}")
            continue
        res = d.get("results") or {}
        regions = {}
        for code in WANT:
            blk = res.get(code) or {}
            names = []
            for kind in ("flatrate", "free", "ads", "rent", "buy"):
                for p in blk.get(kind) or []:
                    n = str(p.get("provider_name") or "").strip()
                    if n and n not in names:
                        names.append(n)
            if names:
                regions[code] = names[:6]
        link = (res.get("CN") or res.get("HK") or res.get("TW") or {}).get("link") \
            or f"https://www.themoviedb.org/movie/{tid}/watch"
        if regions:
            out[str(tid)] = {"link": link, "regions": regions}
            ok += 1
        time.sleep(0.15)
    dest = SITE / "watchproviders.json"
    tmp = dest.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"built": time.strftime("%m-%d %H:%M"), "attrib": "JustWatch / TMDB",
                               "items": out}, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")
    tmp.replace(dest)
    print(f"watch providers: {ok}/{min(cap, len(ITEMS))} 部有渠道 → {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
