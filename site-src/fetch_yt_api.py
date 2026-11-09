#!/usr/bin/env python3
"""官方频道整季索引（**合规路径**）：YouTube Data API v3 的 playlistItems.list 全量枚举。

为什么需要这个脚本（2026-11-09 审计）：
  · 配额是**按 Google Cloud 项目**算的，不是按 IP —— 换 IP / 挂代理**一点用都没有**
    （official: "Projects that enable the YouTube Data API have a default quota allocation…"，
    在 Cloud 控制台的 Quotas 页按项目统计，每天太平洋时间午夜重置）。
  · 而且 YouTube API Services Developer Policies **III.D.6** 明文禁止
    「by creating or using a proxy to create new Google Accounts, API Credentials or API Projects」
    —— 想靠代理多开项目/多开 key 绕配额是违规的，不是灰色地带。
  · 另一个桶：`search.list` 是**独立的 100 次/天**（每次 1），但**我们根本不需要搜索**：
    整季枚举走 `playlistItems.list`，成本 **1 unit/次**，和其他端点共用 **10,000 units/天**
    ⇒ 一个 key 一天就够翻 10,000 页（每页 50 条 = 50 万条视频元数据），足够整季回填。
  · 顺带一提：公司政策 **III.E.6** 禁止抓取 YouTube 应用页面，所以 yt-dlp 那条路
    （fetch_yt_full.py）只作为「没有 key 时的临时兜底」，拿到 key 后应当停用。

配额与中断处理：
  · 每次调用前记 units，超过 BUDGET（默认 9000）就停；已抓到的照旧落盘（并集），
    下一轮从上次停下的地方继续（每频道按已见 videoId 提前停）。
  · 401/403（key 无效/未启用/超额）→ 打 ::error:: 并退出 2，不破坏现有索引。

key 来源：环境变量 YT_API_KEY，或文件 /opt/yt-feed/yt_api_key（一行）。
用法：python3 fetch_yt_api.py [--depth 2000] [--budget 9000] [--dry-run]
"""
import argparse
import datetime as dt
import json
import os
import pathlib
import re
import sys
import urllib.parse
import urllib.request

OUT = pathlib.Path("/var/www/yt/yt-full.json")
CHANNELS_FILE = pathlib.Path("/opt/yt-feed/channels.json")
KEY_FILE = pathlib.Path("/opt/yt-feed/yt_api_key")
API = "https://www.googleapis.com/youtube/v3"
UA = "anime-site-yt-index/1.0"
DEFAULT_CHANNELS = (
    ("Muse木棉花-HK", "UCOsFUU8EtJGDd6-AouF_MwQ"),
    ("Ani-One中文", "UC45ONEZZfMDZCnEhgYmVu-A"),
    ("Ani-One Asia", "UC0wNSTMWIL3qaorLx0jie6A"),
    ("回歸線娛樂", "UCBxsPpM2YiwN6phyYgvc4Pw"),
    ("Muse Asia", "UCGbshtvS9t-8CW11W7TooQg"),
)
EP_NOISE = re.compile(r"合集|全集|重溫|重温|回顧|回顾|總集篇|总集篇|一口氣|一口气|marathon|compilation", re.I)


def api_key():
    k = (os.environ.get("YT_API_KEY") or "").strip()
    if k:
        return k
    try:
        return KEY_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def all_channels():
    out, seen = [], set()
    for name, cid in DEFAULT_CHANNELS:
        if cid not in seen:
            seen.add(cid)
            out.append((name, cid))
    try:
        extra = json.loads(CHANNELS_FILE.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        extra = []
    for row in extra if isinstance(extra, list) else []:
        cid = str((row or {}).get("id") or "").strip()
        if cid.startswith("UC") and cid not in seen:
            seen.add(cid)
            out.append((str(row.get("name") or cid), cid))
    return out


class Quota:
    def __init__(self, budget):
        self.budget = budget
        self.used = 0

    def take(self, units=1):
        if self.used + units > self.budget:
            return False
        self.used += units
        return True

    def left(self):
        return self.budget - self.used


PROXY = os.environ.get("YT_PROXY", "http://127.0.0.1:7890")


def _opener():
    """Google API 在国内直连不通（实测挂死 30s×N）：默认走盒子 mihomo 隧道。
    YT_API_DIRECT=1 可强制直连（在能直连的机器上跑时用）。"""
    if os.environ.get("YT_API_DIRECT") == "1":
        return urllib.request.build_opener()
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}))


_OPEN = _opener()


def get(path, params, key):
    url = f"{API}/{path}?" + urllib.parse.urlencode(dict(params, key=key))
    req = urllib.request.Request(url, headers={"user-agent": UA})
    with _OPEN.open(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def fetch_channel(name, cid, key, quota, depth, known_ids):
    """翻 uploads 播放列表（UU+id[2:]）。

    ⚠ 不要用「连续见过 N 个已索引的 videoId 就停」做增量 —— 实测反了：抓取兜底拿到的最新
    100 条注定是"已知"，于是第 1–2 页就满足停止条件，正好停在最该继续往下的位置
    （首轮 API 只新增 1 条）。整段扫到 depth 的代价极小：2000 条 = 40 次调用 = 40 units，
    而配额是 10,000/天，所以这里全量翻，不要再提前停。
    """
    pl = "UU" + cid[2:]
    rows, page = [], None
    while True:
        if not quota.take(1):
            print(f"  ! {name}: 配额预算用尽（翻到 {len(rows)} 条）")
            break
        params = {"part": "contentDetails,snippet", "playlistId": pl, "maxResults": 50}
        if page:
            params["pageToken"] = page
        try:
            d = get("playlistItems", params, key)
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode("utf-8", "replace")[:200]
            except Exception:
                pass
            print(f"::error::playlistItems 失败 HTTP {e.code} {body}")
            raise
        for it in d.get("items") or []:
            cd = it.get("contentDetails") or {}
            sn = it.get("snippet") or {}
            vid = cd.get("videoId") or ""
            if not vid:
                continue
            title = str(sn.get("title") or "").strip()
            if not title or EP_NOISE.search(title):
                continue
            rows.append({"v": vid, "t": title[:120], "ch": name,
                         "ts": str(sn.get("publishedAt") or "")[:19],
                         "i": len(rows)})
        page = d.get("nextPageToken") or ""
        if not page or len(rows) >= depth:
            break
    print(f"  {name}: {len(rows)} 条（用量 {quota.used}/{quota.budget}）")
    return rows


def load_prev():
    try:
        return json.loads(OUT.read_text(encoding="utf-8")).get("videos") or []
    except (ValueError, OSError):
        return []


def annotate_regions(key, videos, quota):
    """给每条视频打地区标签：`r=1` 中国大陆可播，`r=0` 有地区限制（通常是 HK/MO/TW/SG/MY）。

    为什么必须做（2026-11-09 实测）：官方频道（Muse / Ani-One / 回歸線）的视频 **99%（198/200 抽样）**
    带 `regionRestriction.allowed`，且都不含 CN —— 大陆直连打开就是 "not available in your country"。
    不标注的话，「YouTube 官方 · 60 集可看」是在骗用户。
    成本：`videos.list` 1 unit / 50 个 id（7676 条 ≈ 154 units），远低于日配额。
    """
    todo = [v for v in videos if "r" not in v]
    for i in range(0, len(todo), 50):
        chunk = todo[i:i + 50]
        if not quota.take(1):
            print(f"  ! 配额用完，剩余 {len(todo) - i} 条未标注地区")
            break
        ids = ",".join(v["v"] for v in chunk)
        try:
            d = get("videos", {"part": "contentDetails,status", "id": ids}, key)
        except urllib.error.HTTPError as e:
            print(f"  ! videos.list 失败 HTTP {e.code}（跳过本轮标注）")
            break
        info = {it.get("id"): it for it in d.get("items") or []}
        for v in chunk:
            it = info.get(v["v"])
            if not it:
                v["r"] = 0            # 已删/私有：按不可播处理
                continue
            rr = ((it.get("contentDetails") or {}).get("regionRestriction") or {})
            allowed = rr.get("allowed")
            blocked = rr.get("blocked") or []
            v["r"] = 1 if ("CN" not in blocked and (not allowed or "CN" in allowed)) else 0
    n_ok = sum(1 for v in videos if v.get("r") == 1)
    print(f"  地区标注：中国大陆可播 {n_ok} / {len(videos)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--depth", type=int, default=2000)
    ap.add_argument("--budget", type=int, default=9000)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-region", action="store_true", help="跳过地区标注")
    ap.add_argument("--annotate-only", action="store_true",
                    help="只给已有索引补地区标签，不抓取（新频道/加深后用）")
    a = ap.parse_args()

    key = api_key()
    if not key:
        print("::warning::未配置 YT_API_KEY（env 或 /opt/yt-feed/yt_api_key）—— 跳过 API 枚举")
        return 0
    chans = all_channels()
    prev = load_prev()
    known = {str(v.get("v")) for v in prev if v.get("v")}
    print(f"频道 {len(chans)} 个 | 已有索引 {len(prev)} 条 | 预算 {a.budget} units")
    if a.dry_run:
        return 0

    quota = Quota(a.budget)
    if a.annotate_only:
        rows = list(prev)
        print(f"只看地区：已有 {len(rows)} 条，预计 {len([r for r in rows if 'r' not in r])//50 + 1} units")
        annotate_regions(key, rows, Quota(9000))
        OUT.parent.mkdir(parents=True, exist_ok=True)
        tmp = OUT.with_suffix(".json.tmp")
        meta = {}
        try:
            meta = json.loads(OUT.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            pass
        meta.update({"built": dt.datetime.now().strftime("%m-%d %H:%M"),
                     "source": "data-api", "videos": rows})
        tmp.write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        tmp.replace(OUT)
        n_ok = sum(1 for r in rows if r.get("r") == 1)
        print(f"wrote {OUT}（{len(rows)} 条，其中大陆可播 {n_ok}）")
        return 0
    fresh, ok = [], 0
    try:
        for name, cid in chans:
            got = fetch_channel(name, cid, key, quota, a.depth, known)
            if got:
                ok += 1
                fresh += got
            if quota.left() <= 0:
                print("! 预算用完，本轮到此为止（下次继续）")
                break
    except urllib.error.HTTPError as e:
        # key 无效/未启用/超额：保留旧索引，别写坏的
        return 2 if e.code in (400, 401, 403) else 1

    merged = {}
    for row in fresh:
        merged[row["v"]] = row
    for row in prev:
        v = row.get("v")
        if v and v not in merged:
            merged[v] = row
    print(f"fresh {len(fresh)} | prev {len(prev)} | union {len(merged)} | 用量 {quota.used}")
    if not a.no_region:
        annotate_regions(key, list(merged.values()), quota)
        print(f"  用量合计 {quota.used}")
    if not fresh:
        print("没有新增，保持旧文件不动")
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUT.with_suffix(".json.tmp")
    meta = {}
    try:
        meta = json.loads(OUT.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        pass
    meta.update({"built": dt.datetime.now().strftime("%m-%d %H:%M"),
                 "source": "data-api", "videos": list(merged.values())})
    tmp.write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(OUT)
    print(f"wrote {OUT} (+{len(fresh)} 条，共 {len(merged)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
