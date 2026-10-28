#!/usr/bin/env python3
"""按年份补全动漫目录（2000 → 今年）。

策略：每年取 AniList 上人气 Top 50，写 site/years/<year>.json，并推到
GitHub 仓库 media/years/（站点经 jsDelivr 懒加载）。

增量：site/years_state.json 记录已覆盖的年份与更新时间。
每轮只处理 YEARS_PER_RUN 个年份（默认 6），全部覆盖后从最旧的开始刷新。
"""
import datetime
import json
import os
import pathlib
import time

import fetch_fresh_v2 as core   # 复用 DIRECT/UA/解析/推送

HERE = pathlib.Path(__file__).resolve().parent
YEARS_DIR = HERE / "site" / "years"
STATE = HERE / "site" / "years_state.json"
REPO = "jingjiangze/jellyfin-mpv-shim-mpv-lazy"
BR = "main"
YEARS_PER_RUN = int(os.environ.get("YEARS_PER_RUN", "6"))
PER = int(os.environ.get("PER_YEAR", "50"))


def q_year(year, per):
    return ('query($y:Int,$p:Int){Page(page:$p,perPage:%d){media('
            'type:ANIME,seasonYear:$y,sort:POPULARITY_DESC){'
            'id title{romaji native english} startDate{year month day} '
            'coverImage{large} bannerImage averageScore episodes '
            'description(asHtml:false) genres siteUrl popularity status format duration '
            'studios(isMain:true){nodes{name}} '
            'trailer{id site} nextAiringEpisode{airingAt episode}}}}' % per)


def fetch_year(year):
    out = []
    for page in (1, 2):   # 每年最多 100 部
        body = json.dumps({"query": q_year(year, PER), "variables": {"y": year, "p": page}}).encode()
        got = 0
        for i in range(3):
            try:
                req = core.urllib.request.Request("https://graphql.anilist.co", data=body,
                                                  headers={"Content-Type": "application/json",
                                                           "User-Agent": core.UA})
                with core.DIRECT.open(req, timeout=25) as x:
                    d = json.loads(x.read().decode("utf-8", "replace"))
                ms = (((d.get("data") or {}).get("Page") or {}).get("media")) or []
                out += ms
                got = len(ms)
                break
            except Exception:
                time.sleep(1.5 * (i + 1))
        if got < PER:
            break
        time.sleep(0.6)
    return out


def parse(m):
    t = m.get("title") or {}
    name = t.get("native") or t.get("romaji") or t.get("english")
    if not name:
        return None
    tr = m.get("trailer") or {}
    na = m.get("nextAiringEpisode") or {}
    wd = ""
    if na.get("airingAt"):
        dt = datetime.datetime.fromtimestamp(na["airingAt"],
                                             tz=datetime.timezone(datetime.timedelta(hours=8)))
        wd = core.WD[dt.weekday()]
    sd = m.get("startDate") or {}
    ymd = "-".join(f"{sd.get(k):02d}" if isinstance(sd.get(k), int) else str(sd.get(k) or "")
                   for k in ("year", "month", "day")).strip("-")
    rel = []
    for r in ((m.get("relations") or {}).get("nodes")) or []:
        if r.get("type") == "ANIME" and r.get("format") != "MUSIC":
            rel.append({"n": ((r.get("title") or {}).get("native")) or ((r.get("title") or {}).get("romaji")),
                        "f": r.get("format"), "u": r.get("siteUrl"),
                        "i": ((r.get("coverImage") or {}).get("large"))})
    return {
        "k": "a" + core.hashlib.md5(str(m["id"]).encode()).hexdigest()[:10],
        "n": name,
        "y": sd.get("year"),
        "r": round(m["averageScore"] / 10, 1) if m.get("averageScore") else None,
        "e": m.get("episodes"),
        "g": (m.get("genres") or [])[:3],
        "v": core.clean_desc(m.get("description"), 110),
        "u": m.get("siteUrl"),
        "img": (m.get("coverImage") or {}).get("large") or "",
        "banner": m.get("bannerImage") or "",
        "trailer": tr.get("id") if tr.get("site") == "youtube" else None,
        "wd": wd, "next_ep": na.get("episode") or 0, "next_at": na.get("airingAt") or 0,
        "air": ymd, "pop": m.get("popularity"), "st": m.get("status"),
        "fm": m.get("format"), "du": m.get("duration"),
        "sd": (((m.get("studios") or {}).get("nodes")) or [{}])[0].get("name"),
        "rel": rel[:6],
    }


def gh(args, payload=None):
    import subprocess
    cmd = ["gh", "api"] + args + (["--input", "-"] if payload is not None else [])
    r = subprocess.run(cmd, input=json.dumps(payload) if payload is not None else None,
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode:
        raise RuntimeError(r.stderr.strip()[:200])
    return json.loads(r.stdout) if r.stdout.strip() else None


def push_year(year, data):
    path = f"media/years/{year}.json"
    raw = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()
    import base64
    blob = gh([f"repos/{REPO}/git/blobs"], {"content": base64.b64encode(raw).decode(), "encoding": "base64"})
    parent = gh([f"repos/{REPO}/git/ref/heads/{BR}"])["object"]["sha"]
    base_tree = gh([f"repos/{REPO}/git/commits/{parent}"])["tree"]["sha"]
    tree = gh([f"repos/{REPO}/git/trees"], {"base_tree": base_tree,
              "tree": [{"path": path, "mode": "100644", "type": "blob", "sha": blob["sha"]}]})
    commit = gh([f"repos/{REPO}/git/commits"], {"message": f"catalog: year {year} ({len(data)})",
                                                "tree": tree["sha"], "parents": [parent]})
    gh([f"repos/{REPO}/git/refs/heads/{BR}", "-X", "PATCH"], {"sha": commit["sha"], "force": False})
    return commit["sha"]


def main():
    this_year = datetime.date.today().year
    years = list(range(2000, this_year + 1))
    state = {}
    if STATE.is_file():
        try:
            state = json.loads(STATE.read_text(encoding="utf-8"))
        except Exception:
            state = {}
    todo = [y for y in years if str(y) not in state]
    if not todo:   # 全覆盖后从最旧的刷新
        todo = sorted(state, key=lambda y: state[str(y)])[0]
        todo = [int(todo)]
    batch = todo[:YEARS_PER_RUN]
    print(f"本轮年份: {batch}（剩余未覆盖 {len(todo)}）")
    YEARS_DIR.mkdir(exist_ok=True)

    for y in batch:
        raw = fetch_year(y)
        items = [x for x in (parse(m) for m in raw) if x]
        items.sort(key=lambda x: x.get("pop") or 0, reverse=True)
        fp = YEARS_DIR / f"{y}.json"
        fp.write_text(json.dumps(items, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        try:
            push_year(y, items)
            pushed = True
        except Exception as exc:
            pushed = False
            print(f"year {y} push failed: {str(exc)[:120]}")
        state[str(y)] = datetime.datetime.now().strftime("%Y-%m-%d")
        print(f"year {y}: {len(items)} 部, push={pushed}")
        time.sleep(0.8)

    STATE.parent.mkdir(exist_ok=True)
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"已覆盖 {len(state)}/{len(years)} 个年份")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
