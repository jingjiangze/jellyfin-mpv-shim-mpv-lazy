#!/usr/bin/env python3
"""生成两个页面：

  index.html    首页 —— hero + 番剧表 + 本季新番 + 新片（只内联 fresh 数据）
  library.html  媒体库 —— 我的番剧/我的电影（只内联 lib + bili 数据）

样式与交互抽到 style.css / app.js（两页共用，_headers 长缓存），数据仍然内联，
所以每个页面依旧只有 1 次数据请求。
"""
import json
import os
import re
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
        "episodes": a[6] or 0, "overview": ((a[7] if len(a) > 7 else "") or "")[:110]} for a in lib_raw]
FA = [{"kind": "fresh", "type": "S", "key": x["k"], "name": x["n"],
       "rating": x.get("r"), "poster": x.get("img") or "",
       "air": x.get("air") or "", "episodes": x.get("e") or 0,
       "overview": (x.get("v") or "")[:110], "url": x.get("u") or "",
       "trailer": x.get("trailer"), "banner": x.get("banner"),
       "next_ep": x.get("next_ep"), "next_at": x.get("next_at"),
       "wd": x.get("wd"), "genres": x.get("g") or [], "pop": x.get("pop"),
       "st": x.get("st"), "fm": x.get("fm"), "du": x.get("du"),
       "studio": x.get("sd"), "rel": x.get("rel") or []}
      for x in fresh.get("anime") or []]
FM = [{"kind": "fresh", "type": "M", "key": x["k"], "name": x["n"],
       "rating": x.get("r"), "poster": x.get("img") or "",
       "banner": x.get("banner") or "", "trailer": x.get("trailer"),
       "overview": (x.get("v") or "")[:110], "url": x.get("u") or "",
       "year": x.get("y"), "genres": x.get("g") or []}
      for x in fresh.get("movies") or []]

keep_ids = {a[0] for a in lib_raw}
import datetime as _dt2
# 年份下拉只列「真有目录文件」的年份（media/years/<y>.json）。以前写死 2000..今年，
# 结果 2012 之后的年份选得到但文件不存在，默认年份又指向它 ⇒ 网格空着。
_years_dir = BASE.parent / "media" / "years"
_avail = sorted(int(p.stem) for p in _years_dir.glob("*.json") if p.stem.isdigit()) if _years_dir.is_dir() else []
YEARS = _avail or list(range(2000, _dt2.date.today().year + 1))
DATA_HOME = {"fresh": {"anime": FA, "season": fresh.get("season")},
             "years": YEARS,
             "bili_fresh": bili.get("__fresh__") or {}}
DATA_LIB = {"lib": LIB, "bili": {k: v for k, v in bili.items() if k in keep_ids and v}}

# 看板娘等静态素材
ASSETS_SRC = BASE / "assets"
if ASSETS_SRC.is_dir():
    import shutil as _sh
    _sh.copytree(ASSETS_SRC, SITE / "assets", dirs_exist_ok=True)

def _min_css(text):
    while "/*" in text:
        a = text.index("/*")
        b = text.index("*/", a) + 2
        text = text[:a] + text[b:]
    return " ".join(text.split())


def _min_js(text):
    return chr(10).join(l.strip() for l in text.splitlines() if l.strip())


CSS = _min_css((TPL / "style.css").read_text(encoding="utf-8"))
JS = _min_js((TPL / "app.js").read_text(encoding="utf-8"))
# 同时留一份独立文件（老链接/缓存不会 404）
for name in ("style.css", "app.js"):
    (SITE / name).write_bytes((TPL / name).read_bytes())


def dump(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


import datetime as _dt
BUILD_TAG = _dt.datetime.now().strftime("%m-%d %H:%M")

import hashlib as _hl

def _emit_json(name, obj):
    raw = dump(obj).encode("utf-8")
    tag = _hl.sha256(raw).hexdigest()[:10]
    fn = f"{name}-{tag}.json"
    (SITE / fn).write_bytes(raw)
    return fn, len(raw)


PAGES = [
    ("index.html", "home.html", DATA_HOME),
    ("library.html", "library.html", DATA_LIB),
]
emitted = set()
for out, tpl_name, data in PAGES:
    jname, jsize = _emit_json(out.replace(".html", ""), data)
    emitted.add(jname)
    data_url = "https://gcore.jsdelivr.net/gh/jingjiangze/jellyfin-mpv-shim-mpv-lazy@main/media/" + jname
    data_fb = "https://gh-proxy.com/https://raw.githubusercontent.com/jingjiangze/jellyfin-mpv-shim-mpv-lazy/main/media/" + jname
    data_local = jname
    html = ((TPL / tpl_name).read_text(encoding="utf-8")
            .replace("__CSS__", CSS).replace("__JS__", JS)
            .replace("__BUILD__", BUILD_TAG)
            .replace("__DATA_URL__", data_url)
            .replace("__DATA_FB__", data_fb)
            .replace("__DATA_LOCAL__", data_local)
            .replace("__DATA__", "null"))
    print(f"  data {jname} {jsize/1024:.0f} KB")
    (SITE / out).write_text(html, encoding="utf-8")
    print(f"{out}: {len(html.encode('utf-8'))/1024:.0f} KB")

# 只保留本轮生成的两份数据 JSON：否则每轮换个内容哈希就多一份，仓库与 dist 无限膨胀
for _p in list(SITE.glob("index-*.json")) + list(SITE.glob("library-*.json")):
    if _p.name not in emitted:
        try:
            _p.unlink()
        except OSError:
            pass

print(f"首页 FA={len(FA)} FM={len(FM)} | 媒体库 LIB={len(LIB)} BILI={len(DATA_LIB['bili'])}"
      f" | 黑名单剔除 {dropped} 条")
