#!/usr/bin/env python3
"""官方频道正片索引：拉木棉花 / Ani-One / 回歸線 的 YouTube RSS（每频道最新 15 条，免 key），
写 site/yt.json → build_site 按片名归一匹配进 anime extra 第 5 槽（前端「YouTube 官方」源）。

RSS 每频道只给最新 15 条：覆盖「追当季新番」的场景；要整季回填需要 YouTube Data API
（uploads playlist 分页，等 key）。频道的更多番会轮掉旧条目，属预期。

容错：单频道失败跳过；全部失败写空 videos（build 侧按「无片源」处理，不影响构建）。
"""
import datetime as dt
import json
import os
import pathlib
import re
import xml.etree.ElementTree as ET
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
SITE = HERE / "site"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36"

CHANNELS = (
    ("Muse木棉花-HK", "UCOsFUU8EtJGDd6-AouF_MwQ"),
    ("Ani-One中文", "UC45ONEZZfMDZCnEhgYmVu-A"),
    ("Ani-One Asia", "UC0wNSTMWIL3qaorLx0jie6A"),
    ("回歸線娛樂", "UCBxsPpM2YiwN6phyYgvc4Pw"),
)


def fetch_feed(channel_id):
    url = f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
    req = urllib.request.Request(url, headers={"user-agent": UA})
    with urllib.request.urlopen(req, timeout=25) as r:
        return r.read()


def parse_feed(xml_text, ch_name):
    ns = {"a": "http://www.w3.org/2005/Atom",
          "m": "http://search.yahoo.com/mrss/", "yt": "http://www.youtube.com/xml/schemas/2015"}
    root = ET.fromstring(xml_text)
    out = []
    for e in root.findall("a:entry", ns):
        vid = e.findtext("yt:videoId", default="", namespaces=ns)
        title = (e.findtext("a:title", default="", namespaces=ns) or "").strip()
        pub = e.findtext("a:published", default="", namespaces=ns) or ""
        if not vid or not title:
            continue
        out.append({"v": vid, "t": title, "ch": ch_name,
                    "ts": pub.replace("-", "").replace(":", "").replace("T", "").replace("Z", "")[:14]})
    return out


def main():
    videos, errs = [], 0
    for name, cid in CHANNELS:
        try:
            videos.extend(parse_feed(fetch_feed(cid).decode("utf-8", "replace"), name))
            print(f"  {name}: ok")
        except Exception as e:
            errs += 1
            print(f"! {name}: {type(e).__name__}: {e}")
    seen, uniq = set(), []
    for v in videos:
        if v["v"] in seen:
            continue
        seen.add(v["v"])
        uniq.append(v)
    SITE.mkdir(parents=True, exist_ok=True)
    (SITE / "yt.json").write_text(
        json.dumps({"built": dt.datetime.now().strftime("%m-%d %H:%M"),
                    "videos": uniq}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8")
    print(f"yt: {len(uniq)} 条（频道失败 {errs}）")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"! yt 抓取失败：{type(e).__name__}: {e}")
