#!/usr/bin/env python3
"""构建期直出静态 HTML（重构版 · 阶段一：无交互）

和旧版的区别：
  旧版只产出「空壳 + 内联 JS」，所有内容由 app.js 在浏览器里拼字符串注入
  `#main`。首屏因此要等：下载 HTML → 拉 173KB JSON → 拼 DOM，期间只有
  「加载中…」；布局也由运行时拼接的 class 决定，CSS 一改就可能错位。

  本版把同一批数据在**构建期**渲染成完整 DOM（hero / 近期更新 / 番剧表 /
  按年份 / 热门 / 全部 / 媒体库），页面不依赖任何脚本即可正确显示。后续阶段
  再接回交互（弹窗、筛选、轮播、追番、磁力），脚本只做增强、不再负责首屏。

输出：
  site/index.html      首页
  site/library.html    媒体库
  site/style.css       样式（独立文件，_headers 长缓存）
  site/index-<hash>.json / library-<hash>.json   交互阶段用的数据（保持旧契约）
"""
import datetime
import hashlib
import html as _html
import json
import os
import pathlib
import shutil

BASE = pathlib.Path(__file__).resolve().parent
SITE = BASE / "site"
TPL = BASE / "tpl"

# 海报源：ModelScope（国内 CDN）→ jsDelivr → gh-proxy → 同源 Pages
REPO_PATH = "jingjiangze/jellyfin-mpv-shim-mpv-lazy@main/media"
ASSET_BASE = os.environ.get("ASSET_BASE", f"https://gcore.jsdelivr.net/gh/{REPO_PATH}")
ASSET_PROXY = os.environ.get(
    "ASSET_PROXY",
    "https://gh-proxy.com/https://raw.githubusercontent.com/"
    "jingjiangze/jellyfin-mpv-shim-mpv-lazy/main/media",
)
MODELSCOPE_BASE = os.environ.get(
    "MODELSCOPE_BASE",
    "https://modelscope.cn/datasets/jingjiangze/Anime-JPG/resolve/master",
)
# 本地预览可置空 → 用同源 /posters/<id>.jpg
POSTER_BASE = os.environ.get("POSTER_BASE", MODELSCOPE_BASE).rstrip("/")
POSTER_DIR = pathlib.Path(os.environ.get("POSTER_DIR", str(SITE / "posters")))

# ---------------------------------------------------------------- 数据
fresh = json.loads((SITE / "fresh.json").read_text(encoding="utf-8"))
lib_raw = json.loads((SITE / "data.json").read_text(encoding="utf-8"))
try:
    bili = json.loads((SITE / "bili.json").read_text(encoding="utf-8"))
except (OSError, ValueError):
    bili = {}
try:
    MAG = json.loads((SITE / "magnet.json").read_text(encoding="utf-8"))
except (OSError, ValueError):
    MAG = {}

blocklist = json.loads((BASE / "library_blocklist.json").read_text(encoding="utf-8"))
blocked = {e["id"] for e in blocklist.get("entries") or []}
before = len(lib_raw)
lib_raw = [a for a in lib_raw if a[0] not in blocked]
dropped = before - len(lib_raw)

have_poster = lambda pid: (POSTER_DIR / f"{pid}.jpg").is_file()

# ---------------------------------------------------------------- 新番封面镜像（e1d76409）
# fetch_covers.py 把 AniList 的图下到 site/posters/<key>.jpg（大图带 -b 后缀），
# 随后由 "Sync posters to ModelScope" 上云。有镜像 ⇒ 主源换 ModelScope（国内 0.35s），
# 没有就还回 AniList 原图。大图（hero）不镜像：首屏只加载第 1 张，换源收益不抵复杂度。
COVERS = SITE / "posters"


def have_cover(k, suffix=""):
    name = f"{k}{suffix}.jpg"
    return (COVERS / name).is_file() or (POSTER_DIR / name).is_file()


def fresh_img(k, orig, suffix=""):
    if orig and have_cover(k, suffix):
        return f"{POSTER_BASE}/posters/{k}{suffix}.jpg"
    return orig or ""


def fresh_pf(k, orig, suffix=""):
    """回退链：AniList 原图 → jsDelivr 镜像 → gh-proxy 镜像 → 同源 /poster-img。"""
    if not orig or not have_cover(k, suffix):
        return orig or ""
    return "|".join([
        orig,
        f"{ASSET_BASE}/posters/{k}{suffix}.jpg",
        f"{ASSET_PROXY}/posters/{k}{suffix}.jpg",
        f"/poster-img/{k}{suffix}.jpg",
    ])

# 海报三级回退：data-fb 里按 | 分隔，图挂了就换下一个源，全部失败再移除 <img>
# （纯属性内联，不依赖 app.js，静态页也能兜底）
IMG_FALLBACK = ("var q=(this.dataset.fb||'').split('|').filter(function(s){return s});"
                "if(q.length){this.dataset.fb=q.slice(1).join('|');this.src=q[0]}"
                "else{this.remove()}")

LIB = []
for a in lib_raw:
    pid = a[0]
    ok = bool(a[5]) and have_poster(pid)
    LIB.append({
        "id": pid, "key": pid, "kind": "lib",
        "type": "S" if a[2] else "M",
        "name": a[1], "year": a[3] or None, "rating": a[4] or None,
        "poster": f"{POSTER_BASE}/posters/{pid}.jpg" if ok else "",
        # 回退链：jsDelivr → gh-proxy → 同源 /poster-img（4c17a2c0：/posters/* 会被
        # 边缘按 immutable 缓存死，同源兜底换到 poster-img 目录）
        "pf": (f"{ASSET_BASE}/posters/{pid}.jpg"
               f"|{ASSET_PROXY}/posters/{pid}.jpg"
               f"|/poster-img/{pid}.jpg" if ok and POSTER_BASE else ""),
        "episodes": a[6] or 0,
        "overview": ((a[7] if len(a) > 7 else "") or "")[:180],
        "st": "FINISHED",
        "bili": bool(bili.get(pid)),
        "mag": pid in MAG,
    })

FA = []
for x in fresh.get("anime") or []:
    k = x["k"]
    FA.append({
        "kind": "fresh", "type": "S", "key": k, "name": x["n"],
        "rating": x.get("r"), "poster": fresh_img(k, x.get("img")),
        "pf": fresh_pf(k, x.get("img")),
        "banner": x.get("banner"), "trailer": x.get("trailer"),
        "air": x.get("air") or "", "episodes": x.get("e") or 0,
        "overview": (x.get("v") or "")[:180], "url": x.get("u") or "",
        "next_ep": x.get("next_ep"), "next_at": x.get("next_at"),
        "wd": x.get("wd"), "genres": x.get("g") or [], "pop": x.get("pop"),
        "st": x.get("st"), "fm": x.get("fm"), "du": x.get("du"),
        "studio": x.get("sd"), "rel": x.get("rel") or [],
        "year": x.get("y"),
        "bili": bool(bili.get("__fresh__", {}).get(k)),
        "mag": k in MAG,
        "netflix": bool(x.get("netflix")),
    })

FM = []
for x in fresh.get("movies") or []:
    k = x["k"]
    FM.append({
        "kind": "fresh", "type": "M", "key": k, "name": x["n"],
        "rating": x.get("r"), "poster": fresh_img(k, x.get("img")),
        "pf": fresh_pf(k, x.get("img")),
        "banner": x.get("banner") or "", "trailer": x.get("trailer"),
        "overview": (x.get("v") or "")[:180], "url": x.get("u") or "",
        "year": x.get("y"), "genres": x.get("g") or [], "st": x.get("st"),
        "bili": bool(bili.get("__fresh__", {}).get(k)),
        "mag": k in MAG,
    })

# ---------------------------------------------------------------- 排序
DAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
FMT = {"TV": "TV", "TV_SHORT": "短片", "ONA": "网络放送", "OVA": "OVA",
       "MOVIE": "剧场版", "SPECIAL": "特别篇", "MUSIC": "音乐"}
ST = {"RELEASING": "连载中", "FINISHED": "已完结",
      "NOT_YET_RELEASED": "未播出", "CANCELLED": "已取消"}


def src_rank(it):
    """播放源优先级：磁力 > B站 > 奈飞 > 无（与原 app.js 的 bySort 一致）"""
    if it.get("mag"):
        return 3
    if it.get("bili"):
        return 2
    if it.get("netflix"):
        return 1
    return 0


def sort_items(items, mode="rating"):
    def cmp(it):
        if mode == "new":
            return str(it.get("air") or "")
        if mode == "name":
            return str(it.get("name") or "")
        return it.get("rating") or 0
    if mode == "new":
        return sorted(items, key=lambda x: (-src_rank(x), -_ord(cmp(x)), str(x.get("name"))))
    if mode == "name":
        return sorted(items, key=lambda x: (-src_rank(x), cmp(x)))
    return sorted(items, key=lambda x: (-src_rank(x), -float(cmp(x) or 0)))


def _ord(s):
    """给任意字符串一个可比较的数值（「最新」排序用）"""
    return sum(ord(c) for c in s) if s else 0


# ---------------------------------------------------------------- 片段
def esc(s):
    return _html.escape("" if s is None else str(s), quote=True)


CST = datetime.timezone(datetime.timedelta(hours=8))   # 站点主要访问者在 UTC+8


def fmt_ts_date(ts):
    """next_at 是 unix 秒；按北京时间给一个静态可读的日期"""
    try:
        d = datetime.datetime.fromtimestamp(int(ts), CST)
        return d.strftime("%m-%d") + " 更新"
    except (TypeError, ValueError, OSError, OverflowError):
        return ""


def stars(rating):
    try:
        r = float(rating)
    except (TypeError, ValueError):
        return ""
    p = max(0, min(10, round(r)))
    return (f'<i class="stars" style="--p:{p}" '
            f'title="{r:.1f} 分" aria-label="{r:.1f} 分"></i>')


def card(it):
    key = esc(it.get("key") or it.get("name"))
    poster = it.get("poster") or ""
    if poster:
        # 只有媒体库海报配了多级回退链；没有回退的直接移除，露出卡片底色
        onerr = IMG_FALLBACK if it.get("pf") else "this.remove()"
        fb = f' data-fb="{esc(it["pf"])}"' if it.get("pf") else ""
        img = (f'<img src="{esc(poster)}" alt="" loading="lazy" decoding="async"{fb} '
               f'onerror="{onerr}">')
    else:
        img = '<div class="ph">🎬</div>'

    tags = []
    if it.get("st") == "RELEASING":
        tags.append('<span class="tag tag-live">连载</span>')
    if it.get("trailer"):
        tags.append('<span class="tag tag-trailer">预告</span>')
    if it.get("episodes"):
        tags.append(f'<span class="tag tag-ep">{int(it["episodes"])} 集</span>')
    sources = []
    # B 站角标已按用户要求移除（2026-10-31）；bili 字段保留，仍参与播放源优先级排序
    if it.get("mag"):
        sources.append('<span class="tag tag-mag">磁力</span>')
    src_line = f'<div class="tag-line">{"".join(sources)}</div>' if sources else ""

    bits = []
    if it.get("rating"):
        bits.append(stars(it["rating"]) + f'<b class="num">{float(it["rating"]):.1f}</b>')
    if it.get("st") == "RELEASING" and it.get("next_at"):
        d = fmt_ts_date(it["next_at"])
        if d:
            bits.append(f"<span>{esc(d)}</span>")
    elif it.get("wd") and it["wd"] != "-":
        bits.append(f"<span>{esc(it['wd'])}</span>")
    if it.get("year"):
        bits.append(f"<span>{esc(it['year'])}</span>")
    sub = '<em class="dot">·</em>'.join(bits)

    return (
        f'<article class="card" data-key="{key}" data-name="{esc(it.get("name"))}" '
        f'data-r="{it.get("rating") or 0}" data-st="{esc(it.get("st") or "")}" '
        f'data-wd="{esc(it.get("wd") or "")}" data-type="{esc(it.get("type") or "")}">'
        f'<div class="poster">{img}{"".join(tags)}{src_line}</div>'
        f'<div class="card-head"><h3 class="card-title">{esc(it.get("name"))}</h3>'
        f'<button class="fav" type="button" data-fav="{key}" aria-label="追番">☆</button></div>'
        f'<div class="sub">{sub}</div>'
        f'</article>'
    )


def hero_block(slides, total):
    if not slides:
        return ""
    out = ['<section class="hero" id="hero">']
    for i, it in enumerate(slides):
        on = " is-on" if i == 0 else ""
        bg = it.get("banner") or it.get("poster") or ""
        meta = []
        if it.get("rating"):
            meta.append(f'<span><b>★ {float(it["rating"]):.1f}</b></span>')
        if it.get("episodes"):
            meta.append(f'<span>{int(it["episodes"])} 集</span>')
        if it.get("fm"):
            meta.append(f'<span>{esc(FMT.get(it["fm"], it["fm"]))}</span>')
        if it.get("st") and ST.get(it["st"]):
            meta.append(f'<span>{esc(ST[it["st"]])}</span>')
        btns = ""
        # 内嵌播放已移除（2026-10-31）：hero 只留「详情」，预告走弹窗里的外链
        btns += f'<span class="hbtn is-ghost" data-open="{esc(it.get("key"))}">详情</span>'
        # 只有第一张预载背景图；其余留给 JS 在切换时再挂（6 张 banner 全预载太重）
        bg_attr = (f'style="background-image:url(&quot;{esc(bg)}&quot;)"' if i == 0
                   else f'data-bg="{esc(bg)}"')
        out.append(
            f'<div class="slide{on}" data-i="{i}">'
            f'<div class="hero-bg" {bg_attr}></div>'
            f'<div class="hero-shade"></div>'
            f'<div class="hero-info">'
            f'<div class="hero-tag">动漫库 · {total} 部</div>'
            f'<h1>{esc(it.get("name"))}</h1>'
            f'<div class="hero-meta">{"".join(meta)}</div>'
            f'<p>{esc((it.get("overview") or "")[:160])}</p>'
            f'<div class="hero-btns">{btns}</div>'
            f'</div></div>'
        )
    dots = "".join(
        f'<i class="{"is-on" if i == 0 else ""}" data-dot="{i}"></i>'
        for i in range(len(slides))
    )
    out.append(f'<div class="dots">{dots}</div></section>')
    return "".join(out)


def sect_head(title, hint="", extra=""):
    h = f'<span class="hint">{esc(hint)}</span>' if hint else ""
    sp = f'<span class="spacer">{extra}</span>' if extra else ""
    return f'<div class="sect-head"><h2>{esc(title)}</h2>{h}{sp}</div>'


# ---------------------------------------------------------------- 首页
def render_home():
    slides = [x for x in FA if x.get("banner")][:6]
    parts = []

    hb = hero_block(slides, len(FA))
    if hb:
        parts.append(f'<div class="sect is-first">{hb}</div>')

    recent = sorted([x for x in FA if x.get("st") == "RELEASING" and x.get("next_at")],
                    key=lambda x: x["next_at"])[:12]
    if recent:
        cards = "".join(card(x) for x in recent)
        parts.append(
            f'<section class="sect" id="recent">{sect_head("近期更新", f"{len(recent)} 部连载中")}'
            f'<div class="row" id="r-recent">{cards}</div></section>'
        )

    # 筛选条（静态态：评分 / 全部状态）
    parts.append(
        '<div class="chipbar" id="fbar">'
        '<span class="chip is-on">评分</span><span class="chip">最新</span><span class="chip">名称</span>'
        '<i class="sep"></i>'
        '<span class="chip is-on">全部状态</span><span class="chip">连载中</span><span class="chip">已完结</span>'
        '</div>'
    )

    # 番剧表：构建期按北京时间取当天，静态页直接呈现当天表
    today = DAYS[(datetime.datetime.now(CST).isoweekday()) % 7]
    by_day = [x for x in FA if x.get("wd") == today]
    tabs = []
    for d in ["全部"] + DAYS[1:] + DAYS[:1]:
        n = len(FA) if d == "全部" else sum(1 for x in FA if x.get("wd") == d)
        on = " is-on" if d == today else ""
        tabs.append(f'<span class="tab{on}">{esc(d)} <b>{n}</b></span>')
    sched_cards = "".join(card(x) for x in sort_items(by_day))
    parts.append(
        f'<section class="sect" id="sched">'
        f'{sect_head("番剧表", f"今日 {today} · 共 {len(by_day)} 部")}'
        f'<div class="tabbar" id="wdbar">{"".join(tabs)}</div>'
        f'<div class="grid" id="g-sched">{sched_cards or "<div class=\"empty\">这一天没有放送</div>"}</div>'
        f'</section>'
    )

    # 按年份
    years = available_years()
    ysel = ""
    ycards = ""
    yhint = "按年份浏览"
    if years:
        opts = "".join(f'<option value="{y}">{y}</option>' for y in sorted(years, reverse=True))
        ysel = f'<span class="select-wrap"><select class="yselect" id="ysel">{opts}</select></span>'
        ycards, ytotal = year_cards(max(years))
        if ytotal:
            yhint = f"{max(years)} 年 · {ytotal} 部"
    parts.append(
        f'<section class="sect" id="yearsel">'
        f'{sect_head("按年份", yhint, ysel)}'
        f'<div class="grid" id="g-year">{ycards or "<div class=\"empty\">年份目录尚未生成</div>"}</div>'
        f'</section>'
    )

    hot = sort_items(FA)[:24]
    parts.append(
        f'<section class="sect">{sect_head("热门动漫", f"Top {len(hot)}")}'
        f'<div class="row" id="r-anime">{"".join(card(x) for x in hot)}</div></section>'
    )

    all_cards = "".join(card(x) for x in sort_items(FA))
    parts.append(
        f'<section class="sect" id="allanime">'
        f'{sect_head("全部动漫", f"{len(FA)} 部")}'
        f'<div class="grid" id="g-all">{all_cards}</div></section>'
    )
    return "".join(parts)


def available_years():
    d = BASE.parent / "media" / "years"
    if not d.is_dir():
        return []
    return sorted(int(p.stem) for p in d.glob("*.json") if p.stem.isdigit())


def year_cards(y):
    p = BASE.parent / "media" / "years" / f"{y}.json"
    if not p.is_file():
        return "", 0
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return "", 0
    items = []
    for x in raw[:100]:
        if not isinstance(x, dict):
            continue
        items.append({
            "key": x.get("key") or x.get("k"),
            "name": x.get("name") or x.get("n") or "",
            "poster": x.get("poster") or x.get("img") or "",
            "year": x.get("year") or x.get("y"),
            "rating": x.get("rating") if x.get("rating") is not None else x.get("r"),
            "episodes": x.get("episodes") or x.get("e") or 0,
            "type": x.get("type") or ("M" if x.get("fm") == "MOVIE" else "S"),
            "st": x.get("st"),
            "wd": x.get("wd"),
            "next_at": x.get("next_at"),
            "trailer": x.get("trailer"),
            "bili": bool(x.get("bili")),
            "mag": False,
            "pf": "",
        })
    return "".join(card(x) for x in items), len(items)


# ---------------------------------------------------------------- 媒体库
def render_library():
    series = [x for x in LIB if x["type"] == "S"]
    movies = [x for x in LIB if x["type"] != "S"]
    tabs = (f'<span class="tab is-on">全部 <b>{len(LIB)}</b></span>'
            f'<span class="tab">番剧 <b>{len(series)}</b></span>'
            f'<span class="tab">电影 <b>{len(movies)}</b></span>')
    cards = "".join(card(x) for x in sort_items(LIB))
    return (
        f'<section class="sect is-first">'
        f'{sect_head("我的媒体库", f"番剧 {len(series)} · 电影 {len(movies)}")}'
        f'<div class="tabbar" id="typebar">{tabs}</div>'
        f'<div class="grid" id="g">{cards}</div></section>'
    )


# ---------------------------------------------------------------- 输出
def _min_css(text):
    while "/*" in text:
        a = text.index("/*")
        b = text.index("*/", a) + 2
        text = text[:a] + text[b:]
    return " ".join(text.split())


def dump(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def emit_json(name, obj):
    raw = dump(obj).encode("utf-8")
    tag = hashlib.sha256(raw).hexdigest()[:10]
    fn = f"{name}-{tag}.json"
    (SITE / fn).write_bytes(raw)
    return fn, len(raw)


CSS = _min_css((TPL / "style.css").read_text(encoding="utf-8"))
BUILD_TAG = datetime.datetime.now().strftime("%m-%d %H:%M")

# 独立样式文件（老链接不会 404；_headers 给它长缓存）
(SITE / "style.css").write_bytes((TPL / "style.css").read_bytes())

# 交互脚本：内容哈希命名，避免 _headers 的 immutable 让浏览器一直用旧 JS
JS_URL = ""
if (TPL / "app.js").is_file():
    _js = (TPL / "app.js").read_bytes()
    _jsh = hashlib.sha256(_js).hexdigest()[:10]
    JS_URL = f"app-{_jsh}.js"
    (SITE / JS_URL).write_bytes(_js)
    # 兼容旧路径：CI 的 Snapshot 步骤仍会 cp site/app.js；也给老链接留个落点
    (SITE / "app.js").write_bytes(_js)
    for _old in SITE.glob("app-*.js"):
        if _old.name != JS_URL:
            _old.unlink(missing_ok=True)

# Service Worker（海报缓存层）：CI Snapshot 会 cp site/sw.js
if (TPL / "sw.js").is_file():
    shutil.copyfile(TPL / "sw.js", SITE / "sw.js")

if (BASE / "assets").is_dir():
    shutil.copytree(BASE / "assets", SITE / "assets", dirs_exist_ok=True)

DATA_HOME = {
    "fresh": {"anime": FA, "movies": FM, "season": fresh.get("season")},
    "years": available_years(),
    "mag": {k: v for k, v in MAG.items() if k in {x["key"] for x in FA}},
    "bili_fresh": bili.get("__fresh__") or {},
}
DATA_LIB = {
    "lib": LIB,
    "mag": {k: v for k, v in MAG.items() if k in {x["key"] for x in LIB}},
    "bili": {k: v for k, v in bili.items() if k in {x["key"] for x in LIB} and v},
}

PAGES = [
    ("index.html", "home.html", render_home(), DATA_HOME, len(FA)),
    ("library.html", "library.html", render_library(), DATA_LIB, len(LIB)),
]
emitted = set()
for out, tpl_name, content, data, cnt in PAGES:
    jname, jsize = emit_json(out.replace(".html", ""), data)
    emitted.add(jname)
    data_url = "https://gcore.jsdelivr.net/gh/jingjiangze/jellyfin-mpv-shim-mpv-lazy@main/media/" + jname
    data_fb = "https://gh-proxy.com/https://raw.githubusercontent.com/jingjiangze/jellyfin-mpv-shim-mpv-lazy/main/media/" + jname
    script = ""
    if JS_URL:
        script = (
            '<script>window.DATA_URL="' + data_url + '";'
            'window.DATA_FB="' + data_fb + '";'
            'window.DATA_LOCAL="' + jname + '";</script>\n'
            '<script defer src="' + JS_URL + '"></script>'
        )
    html = ((TPL / tpl_name).read_text(encoding="utf-8")
            .replace("__CSS__", CSS)
            .replace("__CONTENT__", content)
            .replace("__CNT__", f"{cnt} 部")
            .replace("__SCRIPT__", script)
            .replace("__BUILD__", BUILD_TAG))
    (SITE / out).write_text(html, encoding="utf-8")
    print(f"  data {jname} {jsize/1024:.0f} KB -> {out}: {len(html.encode('utf-8'))/1024:.0f} KB")

# 404 页：有了它 CF Pages 退出 SPA 模式，缺失文件返回真 404，
# 否则任何缺失的 JS/JSON 都会被 index.html 以 text/html 兜底 + immutable 缓存死
if (TPL / "404.html").is_file():
    html404 = ((TPL / "404.html").read_text(encoding="utf-8")
               .replace("__CSS__", CSS)
               .replace("__BUILD__", BUILD_TAG))
    (SITE / "404.html").write_text(html404, encoding="utf-8")
    print(f"  404.html: {len(html404.encode('utf-8'))/1024:.0f} KB")

for _p in list(SITE.glob("index-*.json")) + list(SITE.glob("library-*.json")):
    if _p.name not in emitted:
        try:
            _p.unlink()
        except OSError:
            pass

print(f"首页 FA={len(FA)} FM={len(FM)} | 媒体库 LIB={len(LIB)} "
      f"| 磁力 {len(DATA_HOME['mag'])}/{len(DATA_LIB['mag'])} | 黑名单剔除 {dropped} 条")
