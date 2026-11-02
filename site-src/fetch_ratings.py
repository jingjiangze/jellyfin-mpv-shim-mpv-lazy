#!/usr/bin/env python3
"""补「评分分布」：给每个详情分片补上每档分数的人数（rc 字段）。

数据来源：Bangumi 旧接口 `https://api.bgm.tv/subject/<id>?responseGroup=large`
返回的 `rating.count` 是 {"1": n, "2": n, … "10": n}。v0 的 Subject 结构里没有
分布，所以这里必须走旧接口。

为什么在 CI 跑：本机/盒子的出口到 api.bgm.tv 一直不通（实测 000），
GitHub runner 直连只要 0.16s。

用法：RATE_MAX=600 python fetch_ratings.py
每轮只补 RATE_MAX 条，已有 rc 的跳过，多轮自然收敛。
"""
import concurrent.futures as cf
import json
import os
import pathlib
import sys
import time
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = pathlib.Path(__file__).resolve().parent
SITE = BASE / "site"
SHARDS = SITE / "anime"

API = "https://api.bgm.tv/subject/%s?responseGroup=large"
UA = "anime-site/1.0 (+https://github.com/jingjiangze)"
LIMIT = int(os.environ.get("RATE_MAX", "600") or 600)
WORKERS = int(os.environ.get("RATE_WORKERS", "4") or 4)
SLEEP = float(os.environ.get("RATE_SLEEP", "0.12") or 0.12)


def fetch(sid, timeout=20):
    req = urllib.request.Request(API % sid, headers={"user-agent": UA, "accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = json.loads(r.read().decode("utf-8", "replace"))
    cnt = ((d.get("rating") or {}).get("count") or {})
    if not isinstance(cnt, dict):
        return None
    rc = [int(cnt.get(str(i)) or 0) for i in range(1, 11)]
    return rc if sum(rc) > 0 else None


def main():
    if not SHARDS.is_dir():
        print(f"! 找不到分片目录 {SHARDS}")
        return 1
    todo, files = [], {}
    for p in sorted(SHARDS.glob("*.json")):
        try:
            recs = json.loads(p.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            continue
        if not isinstance(recs, list):
            continue
        files[p] = recs
        for rec in recs:
            if isinstance(rec, dict) and rec.get("id") and not rec.get("rc"):
                todo.append(rec["id"])
    if not todo:
        print("全部已有评分分布，跳过")
        return 0
    todo = todo[:LIMIT]
    print(f"待补 {len(todo)} 条（本轮上限 {LIMIT}，并发 {WORKERS}）", flush=True)

    got, stat = {}, {}

    def work(sid):
        time.sleep(SLEEP)
        try:
            return sid, fetch(sid)
        except Exception as e:
            return sid, ("err:" + type(e).__name__)

    with cf.ThreadPoolExecutor(max_workers=max(1, WORKERS)) as ex:
        for i, (sid, rc) in enumerate(ex.map(work, todo), 1):
            key = "ok" if isinstance(rc, list) else str(rc)
            stat[key] = stat.get(key, 0) + 1
            if isinstance(rc, list):
                got[sid] = rc
            if i % 100 == 0:
                print(f"  {i}/{len(todo)} {stat}", flush=True)

    changed = 0
    for p, recs in files.items():
        hit = False
        for rec in recs:
            if not isinstance(rec, dict):
                continue
            rc = got.get(rec.get("id"))
            if rc:
                rec["rc"] = rc
                hit = True
        if hit:
            p.write_text(json.dumps(recs, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            changed += 1
    print(f"完成：{stat}；改写分片 {changed} 个")
    return 0


if __name__ == "__main__":
    sys.exit(main())
