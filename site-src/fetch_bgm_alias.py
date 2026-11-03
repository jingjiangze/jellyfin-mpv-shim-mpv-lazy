#!/usr/bin/env python3
"""抓 Bangumi 条目的别名，补 bangumi-data 覆盖不到的译名。

为什么需要：`bangumi-data` 的 `titleTranslate` 只给 zh-Hans / zh-Hant / en，
但 bgm 条目的 infobox 里还有一批「别名」（实测：炒翻天 → 铁锅料理王 / Iron Wok Jan /
Tetsunabe no Jan；航海王 埃鲁巴夫篇 → 海贼王 艾尔巴夫篇 / ワンピース エルバフ編）。
上游（dmhy/mikan/nyaa）用的是这些别名，用主标题查是 0 条、用别名能查到上百条。

策略：只抓「索引里还空着」的条目，每轮上限 `ALIAS_MAX`（默认 400），增量合并进
`site/bgm-alias.json`，下次 site-sync 的 Publish 步骤会把它提交到 `site-src/data/`，
磁力构建端 `index_eps.py` 直接读。

用法：ALIAS_MAX=400 python fetch_bgm_alias.py
"""
import datetime as dt
import json
import os
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
SITE = HERE / "site"
OUT = SITE / "bgm-alias.json"
API = "https://api.bgm.tv/v0/subjects/{}"
UA = "jellyfin-mpv-shim-mpv-lazy/anime-alias (+https://github.com/jingjiangze)"
MAX = int(os.environ.get("ALIAS_MAX", "400") or 0)
GAP = 1.1                      # bgm 有速率限制，保守一点
KEYS = ("别名", "別名", "alias")


def load_json(p, default):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return default


def alias_of(d):
    """从 subject 详情里取 name / name_cn / infobox 别名。"""
    out = []
    for k in ("name", "name_cn"):
        v = str(d.get(k) or "").strip()
        if v:
            out.append(v)
    for it in (d.get("infobox") or []):
        if str(it.get("key") or "") not in KEYS:
            continue
        v = it.get("value")
        vals = v if isinstance(v, list) else [v]
        for x in vals:
            s = str(x.get("v") if isinstance(x, dict) else x or "").strip()
            if s:
                out.append(s)
    seen, uniq = set(), []
    for s in out:
        if s not in seen and len(s) >= 2:
            seen.add(s)
            uniq.append(s)
    return uniq[:8]


def get(aid):
    req = urllib.request.Request(API.format(aid), headers={
        "user-agent": UA, "accept": "application/json"})
    for attempt in range(2):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(1.2 * (attempt + 1))
        except Exception:
            time.sleep(1.2 * (attempt + 1))
    return None


def empty_ids():
    """索引里 eps 和 batch 都为空的 id（这些才值得补别名）。"""
    cur = load_json(SITE / "magnet-eps.json", None)
    if not isinstance(cur, dict):
        cur = load_json(HERE / "data" / "magnet-eps.json", {})
    out = []
    for k, v in (cur or {}).items():
        if not isinstance(v, dict):
            continue
        if v.get("eps") or v.get("batch"):
            continue
        kk = k[3:] if isinstance(k, str) and k.startswith("bgm") else str(k)
        if kk.isdigit():
            out.append(kk)
    return out


def main():
    olds = load_json(OUT, {})
    items = dict(olds.get("items") or {})
    todo = [i for i in empty_ids() if i not in items]
    if MAX:
        todo = todo[:MAX]
    print(f"bgm-alias: 目标 {len(todo)} 条（已缓存 {len(items)}，空条目待补）", flush=True)
    ok = miss = 0
    for i, aid in enumerate(todo, 1):
        d = get(aid)
        if d:
            al = alias_of(d)
            if al:
                items[aid] = al
                ok += 1
            else:
                items[aid] = []
                miss += 1
        else:
            miss += 1
        if i % 50 == 0:
            print(f"  {i}/{len(todo)}  ok={ok} miss={miss}", flush=True)
            SITE.mkdir(parents=True, exist_ok=True)
            OUT.write_text(json.dumps(
                {"built": dt.datetime.now().strftime("%m-%d %H:%M"), "items": items},
                ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        time.sleep(GAP)
    SITE.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(
        {"built": dt.datetime.now().strftime("%m-%d %H:%M"), "items": items},
        ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"bgm-alias: 本轮 OK {ok} / MISS {miss}，累计 {len(items)} 条 → {OUT.relative_to(HERE).as_posix()}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"! bgm-alias 失败：{type(e).__name__}: {e}")
