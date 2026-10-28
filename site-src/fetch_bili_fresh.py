#!/usr/bin/env python3
"""给首页的新番/新片补 B 站 bvid，合并进 site/bili.json 的 __fresh__ 键。

首页卡片来自 fresh.json，没有媒体库 id，所以 fetch_bili.py 覆盖不到它们。
这里按标题搜索，结果存在 bili["__fresh__"][<fresh 的 k>] = bvid。
带单轮上限（FRESH_BILI_MAX），跑不完下次继续。
"""
import json
import os
import pathlib
import time

import fetch_bili as fb   # 复用它的 search / pick_best / get_buvid

HERE = pathlib.Path(__file__).resolve().parent
SITE = HERE / "site"
OUT = SITE / "bili.json"


def main():
    fresh_p = SITE / "fresh.json"
    if not fresh_p.is_file():
        print("没有 fresh.json，跳过")
        return 0
    fresh = json.loads(fresh_p.read_text(encoding="utf-8"))
    cache = json.loads(OUT.read_text(encoding="utf-8")) if OUT.is_file() else {}
    fmap = cache.get("__fresh__") or {}
    cap = int(os.environ.get("FRESH_BILI_MAX", "80") or 0)
    cookie = fb.get_buvid()
    done = added = 0

    for group in ("anime", "movies"):
        for x in (fresh.get(group) or []):
            k = x.get("k")
            name = x.get("n") or ""
            if not k or not name or k in fmap:
                continue
            if cap and done >= cap:
                print(f"达到 FRESH_BILI_MAX={cap}，本轮停止")
                break
            done += 1
            best = fb.pick_best(fb.search(name, cookie), name, str(x.get("y") or ""))
            if best:
                fmap[k] = best["bvid"]
                added += 1
            time.sleep(1.2)
        if cap and done >= cap:
            break

    cache["__fresh__"] = fmap
    OUT.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"新番/新片 bvid: 共 {len(fmap)} 条（本轮新增 {added}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
