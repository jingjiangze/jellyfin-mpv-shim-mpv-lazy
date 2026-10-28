#!/usr/bin/env python3
"""为静态站批量抓 B 站视频（bvid），用于详情页内嵌播放。

B 站搜索 API：GET /x/web-interface/search/type?search_type=video&keyword=xxx
需要 UA + Referer + buvid3 cookie（否则经常返回空）。
"""
import json
import os
import pathlib
import re
import time
import urllib.parse
import urllib.request

OP = urllib.request.build_opener(urllib.request.ProxyHandler({}))
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
OUT = pathlib.Path(__file__).with_name("site") / "bili.json"


def get_buvid():
    try:
        req = urllib.request.Request("https://www.bilibili.com/",
                                     headers={"User-Agent": UA})
        with OP.open(req, timeout=15) as x:
            for sc in x.headers.get_all("Set-Cookie") or []:
                m = re.match(r"(buvid3=[^;]+)", sc)
                if m:
                    return m.group(1)
    except Exception:
        pass
    return "buvid3=A1B2C3D4-1234-5678-9012-345678901234infoc"


def search(kw, cookie, retries=3):
    url = ("https://api.bilibili.com/x/web-interface/search/type?"
           + urllib.parse.urlencode({"search_type": "video", "keyword": kw, "page": 1}))
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Referer": "https://search.bilibili.com/",
                "Cookie": cookie,
            })
            with OP.open(req, timeout=20) as x:
                d = json.loads(x.read().decode("utf-8", "replace"))
            if d.get("code") != 0:
                time.sleep(1.5 * (i + 1))
                continue
            rs = (d.get("data") or {}).get("result") or []
            return rs
        except Exception:
            time.sleep(1.5 * (i + 1))
    return []


def pick_best(rs, name, year=""):
    """按「标题含片名 + 播放量高 + 时长合理」挑一个。"""
    best, bs = None, -1
    nk = re.sub(r"[^\u4e00-\u9fff0-9a-z]", "", (name or "").lower())
    for r in rs:
        title = re.sub(r"<[^>]+>", "", r.get("title") or "")
        tk = re.sub(r"[^\u4e00-\u9fff0-9a-z]", "", title.lower())
        s = 0
        if nk and nk in tk:
            s += 60
        elif nk and len(nk) >= 3 and nk[:3] in tk:
            s += 30
        play = r.get("play") or 0
        s += min(play / 1000000, 12)                # 播放量只作轻微加权
        if year and str(year) in title:
            s += 15
        # 时长：太短（<20min）多半是解说/切片
        dur = r.get("duration") or "0:0"
        try:
            parts = [int(x) for x in dur.split(":")]
            mins = parts[0] * 60 + parts[1] if len(parts) == 2 else parts[0]
        except Exception:
            mins = 0
        # 时长主导：B 站正片通常 90-180 分钟；25-60 分钟基本都是解说/切片
        s += min(mins / 2.0, 90)
        if mins < 25:
            s -= 70
        elif mins < 75:
            s -= 45
        if any(w in title for w in ("解说", "速看", "影评", "吐槽", "预告", "花絮", "混剪",
                                    "盘点", "一口气", "观毕", "reaction", "精读", "课")):
            s -= 70
        if any(w in title for w in ("完整版", "无删减", "全集", "正片", "超清", "修复版")):
            s += 25
        if s > bs:
            bs, best = s, {"bvid": r.get("bvid"), "title": title[:80],
                           "play": play, "duration": dur, "score": round(s, 1)}
    # B 站版权限制严重：很多片只有片段/解说。不设硬阈值，取分最高者并在页面上标注时长，
    # 由用户自己判断是否点播。
    return best if bs >= 0 else None


def main():
    data = json.loads((pathlib.Path(__file__).with_name("site") / "data.json")
                      .read_text(encoding="utf-8"))
    cookie = get_buvid()
    print("buvid:", cookie[:30])
    cache = {}
    if OUT.exists():
        try:
            cache = json.loads(OUT.read_text(encoding="utf-8"))
        except Exception:
            cache = {}
    hit = miss = 0
    cap = int(os.environ.get("BILI_MAX", "0") or 0)
    done = 0

    def field(entry, name, idx):
        """data.json 现在是数组 [id,name,is_series,year,...]；兼容旧的字典形态。"""
        if isinstance(entry, dict):
            return entry.get(name)
        return entry[idx] if len(entry) > idx else None

    for i, it in enumerate(data, 1):
        if cap and done >= cap:
            print(f"达到 BILI_MAX={cap}，本轮停止（下次继续）")
            break
        key = field(it, "id", 0)
        if not key:
            continue
        if key in cache and cache[key]:
            hit += 1
            continue
        kw = field(it, "name", 1) or ""
        year = field(it, "year", 3) or ""
        orig = it.get("orig") if isinstance(it, dict) else None
        rs = search(kw, cookie)
        best = pick_best(rs, kw, year)
        if not best and orig:
            rs = search(orig, cookie)
            best = pick_best(rs, orig, year)
        if best:
            cache[key] = best
            hit += 1
            print(f"[{i}/{len(data)}] OK   {kw[:26]:26s} {best['bvid']} {best['duration']} "
                  f"{best['play']}播放", flush=True)
        else:
            cache[key] = None
            miss += 1
            print(f"[{i}/{len(data)}] MISS {kw[:26]}", flush=True)
        OUT.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
        done += 1
        time.sleep(1.2)
    print(f"\n命中 {hit} / 未命中 {miss} -> {OUT}")


if __name__ == "__main__":
    main()
