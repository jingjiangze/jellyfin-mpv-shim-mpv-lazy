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

容错：单条失败只跳过；按 subject_id 与旧文件合并——本轮抓到的覆盖旧值，
      没抓到的保留旧值，旧文件里已不在 fresh.json 的条目（孤儿）清掉；
      本轮整体抓取失败（OK=0 且旧文件存在）时保留旧文件不动；
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
import urllib.parse
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

# 豆瓣抓不到的条目用 TMDB 同名回填（中文简介）。豆瓣有 IP 级风控，
# 实测稳定缺 20+ 条；TMDB 的 language=zh-CN 对这批片覆盖很好。
TMDB_KEY = os.environ.get("TMDB_KEY", "99bf884d2a3e8403ae8accded44ec73c")
TMDB_SEARCH = "https://api.tmdb.org/3/search/movie"



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

def tmdb_intro(title):
    q = urllib.parse.urlencode({"api_key": TMDB_KEY, "query": title, "language": "zh-CN"})
    try:
        req = urllib.request.Request(TMDB_SEARCH + "?" + q,
                                     headers={"user-agent": "anime-intro"})
        with urllib.request.urlopen(req, timeout=20) as r:
            d = json.loads(r.read().decode("utf-8", "replace"))
    except Exception:
        return ""
    for it in (d.get("results") or [])[:3]:
        ov = _clean_text(it.get("overview"), 600)
        # 只认中文且有实质内容的，避免把英文简介混进来
        if len(ov) >= 20 and re.search(r"[一-鿿]", ov):
            return ov[:INTRO_LEN]
    return ""


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
        intro = _clean_text((d or {}).get("intro"), INTRO_LEN)
        if not intro:
            miss += 1
            continue
        items[sid] = {"intro": intro, "sub": make_sub(d)}

    # 豆瓣没抓到的，用 TMDB 同名回填（只填空，不覆盖已有内容）
    filled = 0
    for m in (fresh.get("movies") or []):
        hit = SUBJ.search(m.get("u") or "")
        if not hit:
            continue
        sid = hit.group(1)
        cur = items.get(sid) or {}
        if cur.get("intro"):
            continue
        ov = tmdb_intro(m.get("n") or "")
        if not ov:
            continue
        items[sid] = {"intro": ov, "sub": cur.get("sub") or "", "src": "tmdb"}
        filled += 1
    if filled:
        print(f"douban-intro: TMDB 回填 {filled} 条")

    dst = OUT.relative_to(HERE).as_posix()
    old_items = {}
    if OUT.is_file():
        try:
            old_items = dict(json.loads(OUT.read_text(encoding="utf-8")).get("items") or {})
        except Exception:
            old_items = {}
    if not items and old_items:      # 整体抓取失败，不覆盖旧文件
        print(f"douban-intro: 本轮 OK 0 / MISS {miss}，抓取整体失败，保留旧数据 {len(old_items)} 条")
        return

    merged = dict(old_items)
    added = updated = 0
    for k, v in items.items():
        if k in merged:
            updated += 1
        else:
            added += 1
        merged[k] = v

    # 孤儿清理：只保留仍在 fresh.movies 里的 subject_id
    want_ids = set()
    for m in (fresh.get("movies") or []):
        hit = SUBJ.search(m.get("u") or "")
        if hit:
            want_ids.add(hit.group(1))
    orphans = [k for k in merged if k not in want_ids]
    for k in orphans:
        del merged[k]

    SITE.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps({"built": dt.datetime.now().strftime("%m-%d %H:%M"), "items": merged},
                   ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"douban-intro: 本轮 OK {len(items)} / MISS {miss}，合并后共 {len(merged)} 条"
          f"（新增 {added} / 更新 {updated} / 清理孤儿 {len(orphans)}）→ {dst}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"! douban-intro 失败：{type(e).__name__}: {e}")
