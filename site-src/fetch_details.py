#!/usr/bin/env python3
"""按分片抓 Bangumi 条目详情，输出 site/anime/<shard>.json。

分片规则：shard = id % SHARD_TOTAL（默认 64）。
本脚本只处理属于本 job 的那几个 shard，多个 job 并行跑；产物由 collect job 统一提交。

用法：
  SHARD_FROM=0 SHARD_TO=3 python fetch_details.py     # 处理 shard 0..3
  SHARD_LIST=0,1,2 python fetch_details.py            # 或直接给列表

单条字段映射（Bangumi → 站点长名，和现有 fresh.json 对齐）：
  id→id  name→name  name_cn→name_cn  date→air  eps→episodes
  rating.score→rating  images.large→poster  summary→overview
  platform→format  tags[].name→tags（剔掉人物/staff 噪声）
"""
import concurrent.futures as cf
import json
import os
import pathlib
import random
import re
import sys
import time
import urllib.error
import urllib.request

BASE = "https://api.bgm.tv/v0/subjects/"
UA = "jellyfin-mpv-shim-mpv-lazy/anime-catalog (+https://github.com/jingjiangze)"
HERE = pathlib.Path(__file__).resolve().parent
SITE = HERE / "site"
DATA = HERE / "data"

SHARD_TOTAL = int(os.environ.get("SHARD_TOTAL", "64"))
WORKERS = int(os.environ.get("DETAIL_WORKERS", "6"))
LIMIT = int(os.environ.get("DETAIL_MAX", "0"))  # 0 = 不限

# 这些标签是人物/职位，不是题材，收录时剔掉
NOISE = re.compile(r"^(?:CV|声优|声優|歌手|原作|脚本|导演|监督|制作|动画制作|音乐|人物|角色|"
                   r"分镜|演出|系列构成|美术|摄影|色彩|剪辑|音响|企划|制片)[:：]?")

if os.environ.get("SHARD_LIST"):
    MY = {int(x) for x in os.environ["SHARD_LIST"].split(",") if x.strip()}
else:
    a = int(os.environ.get("SHARD_FROM", "0"))
    b = int(os.environ.get("SHARD_TO", "0"))
    MY = set(range(a, b + 1))



def _clean_text(text, cap=600):
    """简介清洗：保留段落、按句末收口，别把整段压成一行、也别切在半句上。

    旧写法 `" ".join(s.split())[:600]` 有两个硬伤：
      ① split() 把 \n 一起吃掉 ⇒ 多段简介变成一大坨，详情页读起来像小作文；
      ② 直接按字数切 ⇒ 常常停在「……冬月不禁感到」这种半句（实测老数据里
         220 字截断的残留就是这么来的，[简介原文] 那批也是同一代脚本的产物）。
    """
    s = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    out, blank = [], False
    for ln in s.split("\n"):
        ln = re.sub(r"[ \t\u3000]+", " ", ln).strip()
        if not ln:
            if out and not blank:
                out.append("")
            blank = True
            continue
        out.append(ln)
        blank = False
    t = "\n".join(out).strip()
    if len(t) > cap:
        cut = max(t.rfind(ch, 0, cap) for ch in "。！？…）」』")
        if cut >= cap * 0.5:
            t = t[:cut + 1]                    # 正常情况：收在句末
        else:
            t = t[:cap].rstrip() + "…"         # 单句超长只能硬切：补省略号，别假装完整
    return t

def get_json(url):
    req = urllib.request.Request(url, headers={"user-agent": UA, "accept": "application/json"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code in (301, 302, 307, 308):
                continue  # 条目合并重定向，urllib 会自动跟；这里兜底
            time.sleep(1.2 * (attempt + 1))
        except Exception:
            time.sleep(1.2 * (attempt + 1))
    return None


def map_subject(s):
    if not s or s.get("type") != 2:  # 2 = 动画
        return None
    rating = (s.get("rating") or {}).get("score") or 0
    tags = []
    for t in (s.get("tags") or [])[:24]:
        name = t.get("name") or ""
        if not name or NOISE.match(name):
            continue
        tags.append(name)
        if len(tags) >= 8:
            break
    imgs = s.get("images") or {}
    return {
        "id": s.get("id"),
        "kind": "bgm",
        "name": s.get("name") or "",
        "name_cn": s.get("name_cn") or "",
        "air": s.get("date") or "",
        "episodes": s.get("eps") or 0,
        "rating": round(float(rating), 1) if rating else None,
        "rank": (s.get("rating") or {}).get("rank") or None,
        "votes": (s.get("rating") or {}).get("total") or 0,
        "poster": imgs.get("large") or imgs.get("common") or imgs.get("medium") or "",
        # 简介统一空白（去 CRLF / 全角缩进 / 连续空格）后截 600 字：
        # 220 会正好切断句子（实测 s0 有 45.5% 的简介恰好停在 220 字）。
        "overview": _clean_text(s.get("summary"), 600),
        "format": s.get("platform") or "",
        "tags": tags,
        "url": f"https://bgm.tv/subject/{s.get('id')}",
    }


def main():
    cat = json.loads((DATA / "catalog.json").read_text(encoding="utf-8"))
    ids = [x["id"] for x in cat["items"] if x["id"] % SHARD_TOTAL in MY]
    if LIMIT:
        ids = ids[:LIMIT]
    print(f"shards={sorted(MY)} 目标 {len(ids)} 条（catalog 共 {cat['count']}）")

    SITE.joinpath("anime").mkdir(parents=True, exist_ok=True)
    buckets = {s: [] for s in MY}
    done = fail = 0

    def work(sid):
        nonlocal done, fail
        s = get_json(f"{BASE}{sid}")
        rec = map_subject(s)
        done += 1
        if not rec:
            fail += 1
            return None
        return sid % SHARD_TOTAL, rec

    with cf.ThreadPoolExecutor(max_workers=max(1, WORKERS)) as ex:
        for res in ex.map(work, ids):
            if res:
                buckets[res[0]].append(res[1])

    for s, rows in buckets.items():
        rows.sort(key=lambda z: z["id"])
        p = SITE / "anime" / f"{s}.json"
        p.write_text(json.dumps(rows, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"  shard {s}: {len(rows)} 条 → {p.stat().st_size/1024:.0f} KB")

    print(f"完成：请求 {done} / 有效 {sum(len(v) for v in buckets.values())} / 失败或非动画 {fail}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"FATAL {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)
