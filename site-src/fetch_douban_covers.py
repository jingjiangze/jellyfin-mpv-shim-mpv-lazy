#!/usr/bin/env python3
"""把豆瓣「新片」封面抓到本地，供 ModelScope 数据集分发。

背景（实测）：豆瓣图站 img3/img9/img2.doubanio.com 有防盗链——
  - 不带 referer            → 418
  - 带本站 referer          → 3/5 被 403
  - 带 movie.douban.com     → 12/12 = 200
所以构建期必须带豆瓣自己的 referer 把图下下来，再由数据集（site/posters 的
glob 已在 site-sync.yml 的同步步骤里）分发。
另有部分图站 host（实测 img9）会回 988B 的 JS 挑战页（200 + text/html），
同一 p 码在 img1/img2/img3 上是正常 JPEG，故失败后再换 host 兜底。

落盘命名：site/posters/db-<subject_id>.jpg
  subject_id 从 fresh.json 的 movies[].u（https://movie.douban.com/subject/<id>/）
  里提取，与页面侧引用的文件名逐字对齐。

用法：python -u fetch_douban_covers.py
      DOUBAN_COVER_MAX=50 WORKERS=4 python -u fetch_douban_covers.py

容错：这是 CI 的 continue-on-error 步骤 —— 读不到 fresh.json 直接 exit 0，
任何异常都打印后返回，不用非 0 退出码把流水线弄红。
"""
import concurrent.futures as cf
import json
import os
import pathlib
import re
import sys
import time
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
SITE = HERE / "site"
OUT = pathlib.Path(os.environ.get("DOUBAN_COVER_OUT") or (SITE / "posters"))
FRESH = SITE / "fresh.json"

# 常见移动浏览器 UA（豆瓣对默认 urllib UA 会直接拒）
UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)
HEADERS = {
    "referer": "https://movie.douban.com/",
    "user-agent": UA,
    "accept": "image/*",
}

WORKERS = int(os.environ.get("WORKERS", "6"))
LIMIT = int(os.environ.get("DOUBAN_COVER_MAX", "0"))

SUBJECT_RE = re.compile(r"/subject/(\d+)")
HOST_RE = re.compile(r"^https?://img\d+\.doubanio\.com/")

# 实测：img9 会对一部分图直接回 988B 的 JS 反爬挑战页（200 + text/html），
# 但同一 public code 在 img1/img2/img3 上是正常 JPEG（已验 ffd8ffe0），换 host 就能拿到。
ALT_HOSTS = ("img1.doubanio.com", "img2.doubanio.com", "img3.doubanio.com")


def alt_hosts(url):
    """同一路径换到其它图站 host（挡掉当前 host），非 doubanio 图站返回空。"""
    if not HOST_RE.match(url):
        return []
    cur = url.split("/", 3)[2]
    return [HOST_RE.sub(f"https://{h}/", url) for h in ALT_HOSTS if h != cur]


def fetch_once(url):
    """单次下载：返回 (kind, data)。kind ∈ ok / badtype / tiny / err。"""
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=25) as r:
            ctype = (r.headers.get("content-type") or "").lower()
            if not ctype.startswith("image/"):
                return "badtype", None
            data = r.read()
    except Exception:
        return "err", None
    if len(data) < 800:
        return "tiny", None
    return "ok", data


def grab(item):
    """抓一张：成功写盘返回 (ok, sid)，否则返回失败类别。"""
    sid, url = item
    dst = OUT / f"db-{sid}.jpg"
    if dst.is_file() and dst.stat().st_size > 800:
        return "skip", sid
    try:
        kind, data = fetch_once(url)
        if kind != "ok":
            # 失败重试 1 次，退避 1.2s
            time.sleep(1.2)
            kind, data = fetch_once(url)
        if kind != "ok":
            # 仍是挑战页/失败：换图站 host 再试（img9 ↔ img1/2/3）
            for alt in alt_hosts(url):
                kind, data = fetch_once(alt)
                if kind == "ok":
                    break
                time.sleep(0.3)
        if kind != "ok":
            return kind, sid
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(data)
        return "ok", sid
    except Exception:
        return "err", sid
    finally:
        # 每条之间留间隔，避免把豆瓣图站打成风控目标
        time.sleep(0.15)


def main():
    try:
        raw = FRESH.read_text(encoding="utf-8")
        doc = json.loads(raw)
    except Exception as e:
        print(f"douban-covers: 读不到 {FRESH}（{type(e).__name__}: {e}），跳过本轮")
        return
    movies = doc.get("movies") or []
    jobs = []
    seen = set()
    for rec in movies:
        if not isinstance(rec, dict):
            continue
        u = rec.get("u") or ""
        img = rec.get("img") or ""
        m = SUBJECT_RE.search(u)
        if not m or not img:
            continue
        sid = m.group(1)
        if sid in seen:
            continue
        seen.add(sid)
        jobs.append((sid, img))
    if LIMIT:
        jobs = jobs[:LIMIT]
    print(f"douban-covers: 待抓 {len(jobs)} 张（movies {len(movies)} 条）")

    stat = {"ok": 0, "skip": 0, "err": 0, "tiny": 0}
    bad = []
    with cf.ThreadPoolExecutor(max_workers=max(1, WORKERS)) as ex:
        for kind, sid in ex.map(grab, jobs):
            if kind in stat:
                stat[kind] += 1
            else:
                stat["err"] += 1  # badtype 等统一记 err
            if kind != "ok" and kind != "skip":
                bad.append((kind, sid))
    print(
        f"douban-covers: ok {stat['ok']} / skip {stat['skip']} / "
        f"err {stat['err']} / tiny {stat['tiny']}"
    )
    for kind, sid in bad[:10]:
        print(f"! {sid} {kind}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # 不 exit(1)：continue-on-error 步骤，别把 CI 弄红
        print(f"douban-covers FATAL {type(e).__name__}: {e}", file=sys.stderr)
