#!/usr/bin/env python3
"""生成番剧全量索引 site-src/data/catalog.json。

为什么不用 Bangumi 自己的搜索接口：`/v0/search/subjects` 空关键词时 total 被硬截断
在 1000，`date` / `air_date` 过滤实测失效，**拿不到全量**。
改用官方索引仓 bangumi-data（每周更新），它把每部动画的 bgm.tv id 都列好了。

产物：{"built":"2026-10-31T..","count":8862,"items":[{id,n,cn,t,d,y}...]}
  id = bgm.tv subject id（数字，唯一键）
  n  = 原名, cn = 中文名（可能为空）, t = tv/movie/ova/web, d = 首播日期, y = 年份
"""
import datetime as dt
import json
import os
import pathlib
import sys
import urllib.request

SRC = os.environ.get("BANGUMI_DATA_URL",
                     "https://cdn.jsdelivr.net/npm/bangumi-data@latest/dist/data.json")
HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "data" / "catalog.json"
UA = "jellyfin-mpv-shim-mpv-lazy/anime-catalog (+https://github.com/jingjiangze)"


def main():
    req = urllib.request.Request(SRC, headers={"user-agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read()
    data = json.loads(raw)

    items, seen = [], set()
    for x in data.get("items") or []:
        bid = None
        for s in x.get("sites") or []:
            if s.get("site") == "bangumi":
                try:
                    bid = int(s.get("id"))
                except (TypeError, ValueError):
                    bid = None
                break
        # 更稳的取法：有些条目 sites.bangumi.id 是相对链接
        if bid is None and isinstance(x.get("sites"), list):
            for s in x["sites"]:
                if s.get("site") == "bangumi" and str(s.get("id", "")).isdigit():
                    bid = int(s["id"])
                    break
        if not bid or bid in seen:
            continue
        seen.add(bid)
        beg = (x.get("begin") or "")[:10]
        zh = (x.get("titleTranslate") or {}).get("zh-Hans") or []
        items.append({
            "id": bid,
            "n": x.get("title") or "",
            "cn": (zh[0] if zh else ""),
            "t": x.get("type") or "",
            "d": beg,
            "y": beg[:4],
        })

    items.sort(key=lambda z: z["id"])
    payload = {
        "built": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": SRC,
        "count": len(items),
        "items": items,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"catalog: {len(items)} 条 → {OUT} ({OUT.stat().st_size/1024:.0f} KB)")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"FATAL {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)
