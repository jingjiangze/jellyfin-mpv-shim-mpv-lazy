#!/usr/bin/env python3
"""官方频道正片索引：木棉花 / Ani-One 中文 / Ani-One Asia / 回歸線。

两条路：
  1. YT_API_KEY 存在（推荐）：YouTube Data API v3 的 uploads playlist 分页，
     每频道最多 4 页×50 条 —— 整季全覆盖，quota 每频道 ~5 单（日配额 1 万）。
  2. 无 key：退回 RSS（每频道最新 15 条）。2026-11 实测 YouTube 对数据中心 IP
     （GH runner / CF egress）一律 404，RSS 基本只剩本地住宅网能拉。

输出 site/yt.json → build_site 按片名归一匹配进 anime extra 第 5 槽。
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

API_KEY = os.environ.get("YT_API_KEY", "")

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


def fetch_uploads_api(ch_name, channel_id):
    """Data API：uploads 播放列表（UU+channel_id[2:]）分页 4 页。"""
    pl = "UU" + channel_id[2:]
    out, page = [], ""
    for _ in range(4):
        url = (f"https://www.googleapis.com/youtube/v3/playlistItems"
               f"?part=snippet,contentDetails&playlist_id={pl}&maxResults=50"
               f"&key={API_KEY}" + (f"&pageToken={page}" if page else ""))
        body = json.loads(get(url).decode("utf-8"))
        for it in body.get("items") or []:
            vid = ((it.get("contentDetails") or {}).get("videoId")) or ""
            sn = it.get("snippet") or {}
            title = (sn.get("title") or "").strip()
            pub = (sn.get("publishedAt") or "").replace("-", "").replace(":", "").replace("T", "").replace("Z", "")[:14]
            if vid and title:
                out.append({"v": vid, "t": title, "ch": ch_name, "ts": pub})
        page = (body.get("nextPageToken") or "")
        if not page:
            break
    return out


def main():
    videos, errs = [], 0
    if API_KEY:
        for name, cid in CHANNELS:
            try:
                got = fetch_uploads_api(name, cid)
                videos.extend(got)
                print(f"  {name}: {len(got)} 条（Data API）")
            except Exception as e:
                errs += 1
                print(f"! {name}: {type(e).__name__}: {e}")
    else:
        for name, cid in CHANNELS:
            try:
                videos.extend(parse_feed(fetch_feed(cid).decode("utf-8", "replace"), name))
                print(f"  {name}: ok（RSS，最新 15 条）")
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
