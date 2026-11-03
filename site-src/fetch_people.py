#!/usr/bin/env python3
"""补「角色 / 制作人员 / 收藏统计」到详情分片。

数据源（Bangumi v0）：
  GET /v0/subjects/{id}/characters?limit=12  → [{name, relation, images:{grid}}]
  GET /v0/subjects/{id}/persons?limit=10     → [{name, relation}]
  GET /v0/subjects/{id}                      → collection{wish,doing,collect,on_hold,dropped}

写回分片的三个短字段（控制体积）：
  ch: [[名, 关系, 头像URL], ...]   最多 10
  st: [[名, 关系], ...]            最多 8
  co: [想看, 在看, 看过]           三个整数

用法：PEOPLE_MAX=1500 python fetch_people.py
每轮只补 PEOPLE_MAX 条，已有 ch 的跳过，多轮收敛。
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
SHARDS = BASE / "site" / "anime"
API = "https://api.bgm.tv/v0/subjects/%s"
UA = "anime-site/1.0 (+https://github.com/jingjiangze)"
LIMIT = int(os.environ.get("PEOPLE_MAX", "1500") or 1500)
WORKERS = int(os.environ.get("PEOPLE_WORKERS", "3") or 3)
SLEEP = float(os.environ.get("PEOPLE_SLEEP", "0.25") or 0.25)


def get(path, timeout=20, retries=2):
    req = urllib.request.Request(API % path, headers={"user-agent": UA, "accept": "application/json"})
    last = None
    for i in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8", "replace"))
        except Exception as e:
            last = e
            if i < retries:
                time.sleep(1.0 * (i + 1))
    raise last


def grid(images):
    if not isinstance(images, dict):
        return ""
    return images.get("grid") or images.get("medium") or images.get("small") or ""


def build(sid):
    """返回 (ch, st, co) 或 ('err:xxx',)。"""
    try:
        chs = get("%s/characters?limit=12" % sid)
    except Exception as e:
        return "err:" + type(e).__name__
    time.sleep(SLEEP)
    try:
        sts = get("%s/persons?limit=10" % sid)
    except Exception:
        sts = []
    time.sleep(SLEEP)
    try:
        sub = get(str(sid))
    except Exception:
        sub = {}

    ch = []
    for c in (chs or [])[:10]:
        n = str(c.get("name") or "").strip()
        if not n:
            continue
        ch.append([n[:20], str(c.get("relation") or "")[:12], grid(c.get("images"))[:120]])
    st = []
    for p in (sts or [])[:8]:
        n = str(p.get("name") or "").strip()
        if not n:
            continue
        st.append([n[:20], str(p.get("relation") or "")[:12]])
    col = (sub or {}).get("collection") or {}
    co = [int(col.get("wish") or 0), int(col.get("doing") or 0), int(col.get("collect") or 0)]
    if not ch and not st and not any(co):
        return None
    return (ch, st, co)


def main():
    if not SHARDS.is_dir():
        print("! 找不到分片目录", SHARDS)
        return 1
    files, todo = {}, []
    for p in sorted(SHARDS.glob("*.json")):
        try:
            recs = json.loads(p.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            continue
        if not isinstance(recs, list):
            continue
        files[p] = recs
        for rec in recs:
            if isinstance(rec, dict) and rec.get("id") and not rec.get("ch"):
                todo.append(rec["id"])
    if not todo:
        print("全部已有角色数据")
        return 0
    todo = todo[:LIMIT]
    print(f"待补 {len(todo)} 条（上限 {LIMIT}，并发 {WORKERS}）", flush=True)

    got, stat = {}, {}

    def work(sid):
        time.sleep(SLEEP)
        r = build(sid)
        return sid, r

    with cf.ThreadPoolExecutor(max_workers=max(1, WORKERS)) as ex:
        for i, (sid, r) in enumerate(ex.map(work, todo), 1):
            key = "ok" if isinstance(r, tuple) else ("none" if r is None else str(r))
            stat[key] = stat.get(key, 0) + 1
            if isinstance(r, tuple):
                got[sid] = r
            if i % 100 == 0:
                print(f"  {i}/{len(todo)} {stat}", flush=True)

    changed = 0
    for p, recs in files.items():
        hit = False
        for rec in recs:
            if not isinstance(rec, dict):
                continue
            r = got.get(rec.get("id"))
            if not r:
                continue
            ch, st, co = r
            rec["ch"], rec["st"], rec["co"] = ch, st, co
            hit = True
        if hit:
            p.write_text(json.dumps(recs, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            changed += 1
    print(f"完成：{stat}；改写分片 {changed} 个")
    return 0


if __name__ == "__main__":
    sys.exit(main())
