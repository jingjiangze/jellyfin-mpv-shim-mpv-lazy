#!/usr/bin/env python3
"""给豆瓣电影条目补剧情简介，写 site/movies-intro.json。

数据源：豆瓣移动端 rexxar 接口（必须带 referer: https://m.douban.com/）
  https://m.douban.com/rexxar/api/v2/movie/<subject_id>?for_mobile=1
  返回 intro（完整剧情简介）、card_subtitle、genres、countries、durations。
  旧的 j/subject_abstract 接口**没有** intro 字段，已实测排除。

输入：site/fresh.json 的 movies[]（每条 {k,n,r,img,u,trailer}），
      subject_id 从 u 的 /subject/<id> 里取；取不到就跳过。

输出：site/movies-intro.json
  {"built":"MM-DD HH:MM","items":{"<subject_id>":{"intro":"…","sub":"2026 / 中国大陆 / 武侠"}}}
  intro 压掉连续空白、截断 600 字；sub 取 card_subtitle，
  缺则 genres + countries 用 " / " 拼，再缺则空串。

容错：单条失败只跳过；本轮条数少于旧文件时保留旧数据不覆盖；
      整体失败也 exit 0，CI 不变红。
      请求之间间隔 0.8s、单条最多 3 次尝试，避免触发豆瓣风控。

用法：cd site-src && python -u fetch_douban_intro.py
"""
import datetime as dt
import json
import os
import pathlib
import re
import time
import urllib.error
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
SITE = HERE / "site"
FRESH = SITE / "fresh.json"
OUT = SITE / "movies-intro.json"

UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
      "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
API = "https://m.douban.com/rexxar/api/v2/movie/{}?for_mobile=1"
MAX = int(os.environ.get("DOUBAN_MAX", "120"))
INTRO_LEN = 600
GAP = 0.8
SUBJ = re.compile(r"/subject/(\d+)")


def get_json(url):
    req = urllib.request.Request(url, headers={
        "user-agent": UA,
        "referer": "https://m.douban.com/",
        "accept": "application/json"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 404:       # 条目被删/合并，重试也没用
                return None
            time.sleep(1.2 * (attempt + 1))
        except Exception:
            time.sleep(1.2 * (attempt + 1))
    return None


def make_sub(d):
    """副标题：优先 card_subtitle 原样，缺则 genres + countries 拼。"""
    sub = (d.get("card_subtitle") or "").strip()
    if sub:
        return sub
    parts = [x for x in (d.get("genres") or []) + (d.get("countries") or []) if x]
    return " / ".join(parts)


def main():
    fresh = json.loads(FRESH.read_text(encoding="utf-8"))
    movies = (fresh.get("movies") or [])[:MAX]
    print(f"douban-intro: 目标 {len(movies)} 条（DOUBAN_MAX={MAX}）")

    items, miss, req_n = {}, 0, 0
    for m in movies:
        hit = SUBJ.search(m.get("u") or "")
        if not hit:
            miss += 1
            continue
        sid = hit.group(1)
        if req_n:
            time.sleep(GAP)
        req_n += 1
        d = get_json(API.format(sid))
        intro = " ".join(((d or {}).get("intro") or "").split())[:INTRO_LEN]
        if not intro:
            miss += 1
            continue
        items[sid] = {"intro": intro, "sub": make_sub(d)}

    dst = OUT.relative_to(HERE).as_posix()
    old_n = 0
    if OUT.is_file():
        try:
            old_n = len((json.loads(OUT.read_text(encoding="utf-8")).get("items") or {}))
        except Exception:
            old_n = 0
    if old_n > len(items):
        print(f"douban-intro: 保留旧数据（新抓 {len(items)} < 旧 {old_n}）")
        return

    SITE.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps({"built": dt.datetime.now().strftime("%m-%d %H:%M"), "items": items},
                   ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"douban-intro: OK {len(items)} 条 / MISS {miss} 条 → {dst}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"! douban-intro 失败：{type(e).__name__}: {e}")
