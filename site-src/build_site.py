#!/usr/bin/env python3
"""生成两个页面：

  index.html    首页 —— hero + 番剧表 + 本季新番 + 新片（只内联 fresh 数据）
  library.html  媒体库 —— 我的番剧/我的电影（只内联 lib + bili 数据）

样式与交互抽到 style.css / app.js（两页共用，_headers 长缓存），数据仍然内联，
所以每个页面依旧只有 1 次数据请求。
"""
import json
import os
import pathlib

BASE = pathlib.Path(__file__).resolve().parent
SITE = BASE / "site"
TPL = BASE / "tpl"

# 海报走 GitHub 仓库 + CDN（见 PLAN 第七节测速：gcore 7 天缓存 / gh-proxy 60s / 同源兜底）
# 仓库沿用 jellyfin-mpv-shim-mpv-lazy 的 media/ 目录，不新建仓库。
REPO_PATH = "jingjiangze/jellyfin-mpv-shim-mpv-lazy@main/media"
ASSET_BASE = os.environ.get("ASSET_BASE",
                            f"https://gcore.jsdelivr.net/gh/{REPO_PATH}")
POSTER_DIR = pathlib.Path(os.environ.get("POSTER_DIR", str(SITE / "posters")))

ASSET_PROXY = os.environ.get("ASSET_PROXY",
                             "https://gh-proxy.com/https://raw.githubusercontent.com/"
                             "jingjiangze/jellyfin-mpv-shim-mpv-lazy/main/media")

fresh = json.loads((SITE / "fresh.json").read_text(encoding="utf-8"))
lib_raw = json.loads((SITE / "data.json").read_text(encoding="utf-8"))
bili = json.loads((SITE / "bili.json").read_text(encoding="utf-8"))

blocklist = json.loads((BASE / "library_blocklist.json").read_text(encoding="utf-8"))
blocked = {e["id"] for e in blocklist.get("entries") or []}
before = len(lib_raw)
lib_raw = [a for a in lib_raw if a[0] not in blocked]
dropped = before - len(lib_raw)

have_poster = lambda pid: (POSTER_DIR / f"{pid}.jpg").is_file()
LIB = [{"id": a[0], "kind": "lib", "type": "S" if a[2] else "M", "name": a[1],
        "year": a[3] or None, "rating": a[4] or None,
        "poster": f"{ASSET_BASE}/posters/{a[0]}.jpg" if a[5] and have_poster(a[0]) else "",
        "pf": (f"{ASSET_PROXY}/posters/{a[0]}.jpg|/posters/{a[0]}.jpg"
               if a[5] and have_poster(a[0]) else ""),
        "episodes": a[6] or 0, "overview": (a[7] if len(a) > 7 else "") or ""} for a in lib_raw]
FA = [{"kind": "fresh", "type": "S", "key": x["k"], "name": x["n"],
       "rating": x.get("r"), "poster": x.get("img") or "",
       "air": x.get("air") or "", "episodes": x.get("e") or 0,
       "overview": x.get("v") or "", "url": x.get("u") or "",
       "trailer": x.get("trailer"), "banner": x.get("banner"),
       "next_ep": x.get("next_ep"), "next_at": x.get("next_at"),
       "wd": x.get("wd"), "genres": x.get("g") or [], "pop": x.get("pop"),
       "st": x.get("st"), "fm": x.get("fm"), "du": x.get("du"),
       "studio": x.get("sd"), "rel": x.get("rel") or []}
      for x in fresh.get("anime") or []]
FM = [{"kind": "fresh", "type": "M", "key": x["k"], "name": x["n"],
       "rating": x.get("r"), "poster": x.get("img") or "",
       "banner": x.get("banner") or "", "trailer": x.get("trailer"),
       "overview": x.get("v") or "", "url": x.get("u") or "",
       "year": x.get("y"), "genres": x.get("g") or []}
      for x in fresh.get("movies") or []]

keep_ids = {a[0] for a in lib_raw}
DATA_HOME = {"fresh": {"anime": FA, "movies": FM, "season": fresh.get("season")}}
DATA_LIB = {"lib": LIB, "bili": {k: v for k, v in bili.items() if k in keep_ids and v}}

for name in ("style.css", "app.js"):
    (SITE / name).write_bytes((TPL / name).read_bytes())


def dump(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


PAGES = [
    ("index.html", "home.html", DATA_HOME),
    ("library.html", "library.html", DATA_LIB),
]
for out, tpl_name, data in PAGES:
    html = (TPL / tpl_name).read_text(encoding="utf-8").replace("__DATA__", dump(data))
    (SITE / out).write_text(html, encoding="utf-8")
    print(f"{out}: {len(html.encode('utf-8'))/1024:.0f} KB")

print(f"首页 FA={len(FA)} FM={len(FM)} | 媒体库 LIB={len(LIB)} BILI={len(DATA_LIB['bili'])}"
      f" | 黑名单剔除 {dropped} 条")
