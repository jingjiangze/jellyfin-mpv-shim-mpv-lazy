#!/usr/bin/env python3
"""给番剧挂磁力：逐条调聚合站 /api/search，择优后写 site/magnet.json。

产物结构（key 与 build_site.py 里的 key/id 对齐）::

    { "<fresh key 或 lib id>": {
        "m":  "magnet:?xt=urn:btih:...",   # 主磁力
        "t":  标题, "s": 体积字节, "sd": 做种数,
        "sub": "中"/"无"…, "src": 来源站,
        "alt": [ {m,t,s,sd}, … 最多 3 条 ] } }

设计口径：
  * **只补不改** —— 已经在 data/magnet.json 里的 key 本轮直接跳过，不会因为
    上游排序变化把命中结果覆盖掉（同名不同作的误配只能人工改）。
  * **单轮上限** —— MAGNET_MAX 条，宁可多跑几轮也不让一次 CI 卡死。
  * **标题必须命中** —— 归一化后要求「本作名」是候选标题的子串，避免挂错。
  * **失败不致命** —— 单条异常只记日志，整体不抛；CI 里这一步也是 continue-on-error。
"""
import base64
import json
import os
import pathlib
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = pathlib.Path(__file__).resolve().parent
SITE = BASE / "site"
DATA = BASE / "data"

API = os.environ.get("PAN_HUB_API", "http://120.48.56.189/pan/api/search")
USER = os.environ.get("PAN_HUB_USER", "")
PASS = os.environ.get("PAN_HUB_PASS", "")
LIMIT = int(os.environ.get("MAGNET_MAX", "150"))
WORKERS = int(os.environ.get("MAGNET_WORKERS", "3"))
TIMEOUT = int(os.environ.get("MAGNET_TIMEOUT", "90"))
ALT_MAX = 3

CJK = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]")

# 缓存回写走 Git Data API（和 push_assets.py 同一套路）。CI 里那步 git publish
# 因为仓库历史 CRLF 问题会被跳过，所以缓存不能指望它。
REPO = os.environ.get("TARGET_REPO", "jingjiangze/jellyfin-mpv-shim-mpv-lazy")
BRANCH = os.environ.get("TARGET_BRANCH", "main")
CACHE_PATH = "site-src/data/magnet.json"


def _gh(args, payload=None):
    cmd = ["gh", "api"] + args
    if payload is not None:
        cmd += ["--input", "-"]
    p = subprocess.run(cmd, input=json.dumps(payload) if payload is not None else None,
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout or "").strip()[:200])
    return json.loads(p.stdout) if (p.stdout or "").strip() else {}


def push_cache(cache):
    """把缓存推回仓库，保证下一轮只补新增条目。"""
    if not (os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")):
        print("· 无 GH_TOKEN，跳过缓存回写")
        return
    raw = json.dumps(cache, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    blob = _gh([f"repos/{REPO}/git/blobs"],
               {"content": base64.b64encode(raw).decode(), "encoding": "base64"})
    parent = _gh([f"repos/{REPO}/git/ref/heads/{BRANCH}"])["object"]["sha"]
    base_tree = _gh([f"repos/{REPO}/git/commits/{parent}"])["tree"]["sha"]
    tree = _gh([f"repos/{REPO}/git/trees"],
               {"base_tree": base_tree,
                "tree": [{"path": CACHE_PATH, "mode": "100644", "type": "blob", "sha": blob["sha"]}]})
    commit = _gh([f"repos/{REPO}/git/commits"],
                 {"message": f"magnet: cache {len(cache)}", "tree": tree["sha"], "parents": [parent]})
    _gh([f"repos/{REPO}/git/refs/heads/{BRANCH}", "-X", "PATCH"],
        {"sha": commit["sha"], "force": False})
    print(f"✓ 缓存已回写 {CACHE_PATH}（{len(cache)} 条）")


def norm(s):
    """归一化：去标点/空白、全角转半角、剥掉季数后缀，用于子串匹配。"""
    s = str(s or "").lower()
    for a, b in (("（", "("), ("）", ")"), ("【", "["), ("】", "]"), ("：", ":")):
        s = s.replace(a, b)
    s = re.sub(r"[\s\-_.·・:：!！?？,，。'\"()\[\]]", "", s)
    s = re.sub(r"(第[一二三四五六七八九十百\d]+季|season\s*\d+|s\d{1,2})$", "", s)
    return s


def get_json(kw):
    url = API + "?kw=" + urllib.parse.quote(kw)
    req = urllib.request.Request(url, headers={"user-agent": "site-sync-magnet/1.0"})
    if USER and PASS:
        tok = base64.b64encode(f"{USER}:{PASS}".encode()).decode()
        req.add_header("authorization", "Basic " + tok)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8"))


def _size(v):
    return v if isinstance(v, (int, float)) else 0


def _seed(v):
    return v if isinstance(v, int) else 0


def _res_rank(res):
    res = str(res or "")
    if "2160" in res or "4K" in res.upper():
        return 3
    if "1080" in res:
        return 2
    if "720" in res:
        return 1
    return 0


def pick(name, payload):
    """从聚合结果里挑一条主磁力 + 至多 3 条备选。挑不到返回 None。"""
    key = norm(name)
    if not key:
        return None
    seen, cands = set(), []
    for it in payload.get("results") or []:
        mg = it.get("magnet") or ""
        if not mg.startswith("magnet:"):
            continue  # 蜜柑这类只给 .torrent 的，没法当主磁力
        bt = re.search(r"btih:([^&]+)", mg)
        h = bt.group(1).upper() if bt else mg
        if h in seen:
            continue
        title = it.get("title") or ""
        if key not in norm(title):
            continue
        seen.add(h)
        subs = it.get("subs") or []
        cands.append({
            "m": mg,
            "t": title,
            "s": _size(it.get("size")),
            "sd": _seed(it.get("seeders")),
            "sub": "".join(subs),
            "src": it.get("sourceName") or it.get("source") or "",
            "res": it.get("resolution") or "",
        })
    if not cands:
        return None
    # 做种 → 中文字幕 → 分辨率 → 体积
    cands.sort(key=lambda c: (c["sd"], 1 if "中" in c["sub"] else 0, _res_rank(c["res"]), c["s"]),
               reverse=True)
    top = dict(cands[0])
    top.pop("res", None)
    alt = []
    for c in cands[1:1 + ALT_MAX]:
        c2 = dict(c)
        c2.pop("res", None)
        alt.append(c2)
    top["alt"] = alt
    return top


def targets():
    """要挂磁力的条目：(key, 标题)。新番 + 媒体库，年份目录暂不覆盖。"""
    out = []
    fp = SITE / "fresh.json"
    if fp.is_file():
        fresh = json.loads(fp.read_text(encoding="utf-8"))
        for x in fresh.get("anime") or []:
            if x.get("k") and x.get("n"):
                out.append((x["k"], x["n"]))
    dp = SITE / "data.json"
    if dp.is_file():
        lib = json.loads(dp.read_text(encoding="utf-8"))
        for a in lib:
            if isinstance(a, list) and len(a) > 1 and a[0] and a[1]:
                out.append((a[0], a[1]))
    # 去重保序
    seen, uniq = set(), []
    for k, n in out:
        if k in seen:
            continue
        seen.add(k)
        uniq.append((k, n))
    return uniq


def load_cache():
    for p in (SITE / "magnet.json", DATA / "magnet.json"):
        if p.is_file():
            try:
                return json.loads(p.read_text(encoding="utf-8"))
            except Exception as e:  # 损坏就用空表重来，不阻塞发布
                print(f"! cache {p.name} 解析失败：{e}")
    return {}


def main():
    cache = load_cache()
    jobs = [(k, n) for k, n in targets() if k not in cache]
    print(f"目标 {len(targets())} 条，已有缓存 {len(cache)} 条，本轮待抓 {len(jobs)} 条（上限 {LIMIT}）")
    jobs = jobs[:LIMIT]
    if not jobs:
        (SITE / "magnet.json").write_text(
            json.dumps(cache, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print("无事可做")
        try:
            push_cache(cache)
        except Exception as e:
            print(f"! 缓存回写失败：{type(e).__name__}: {e}")
        return

    hit = miss = err = 0

    def work(pair):
        nonlocal hit, miss, err
        k, n = pair
        try:
            payload = get_json(n)
            got = pick(n, payload)
            if not got:
                miss += 1
                return None
            hit += 1
            return k, got
        except Exception as e:
            err += 1
            print(f"! {n[:30]} -> {type(e).__name__}: {e}")
            return None

    with ThreadPoolExecutor(max_workers=max(1, WORKERS)) as ex:
        for res in ex.map(work, jobs):
            if res:
                cache[res[0]] = res[1]

    (SITE / "magnet.json").write_text(
        json.dumps(cache, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"完成：命中 {hit} / 无结果 {miss} / 出错 {err}；缓存总数 {len(cache)}")
    try:
        push_cache(cache)
    except Exception as e:
        print(f"! 缓存回写失败：{type(e).__name__}: {e}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # 兜底：永不把 CI 打红
        print(f"FATAL {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(0)
