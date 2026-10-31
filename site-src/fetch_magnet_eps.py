#!/usr/bin/env python3
"""分集磁力索引：读 magnet.json 的 key+标题，逐条查聚合站，解析「第几集」，
写 site/magnet-eps.json（{key: {n: 标题, eps: {集号: [{m,s,sd,sub,t}]}}}）。

与 fetch_magnet.py 的关系：完全独立、只追加（已索引的 key 跳过）、
互不覆盖；数据源同为 pan-hub 聚合站（用户自有服务）。

限流与容错口径与 fetch_magnet.py 一致：MAGNET_MAX 条/轮、单条失败只记日志、
CI 里 continue-on-error。
"""
import base64
import json
import os
import pathlib
import re
import sys
import urllib.parse
import urllib.request

BASE = pathlib.Path(__file__).resolve().parent
SITE = BASE / "site"
API = os.environ.get("PAN_HUB_API", "http://120.48.56.189/pan/api/search")
USER = os.environ.get("PAN_HUB_USER", "")
PASS = os.environ.get("PAN_HUB_PASS", "")
LIMIT = int(os.environ.get("MAGNET_MAX", "150"))
TIMEOUT = int(os.environ.get("MAGNET_TIMEOUT", "90"))

REPO = os.environ.get("TARGET_REPO", "jingjiangze/jellyfin-mpv-shim-mpv-lazy")
BRANCH = os.environ.get("TARGET_BRANCH", "main")

EP_PATTERNS = [
    (re.compile(r"第\s*(\d{1,4})\s*[-–~]\s*(\d{1,4})\s*[話话集]"), "range"),
    (re.compile(r"第\s*(\d{1,4})\s*[話话集](?!\d)"), "single"),
    (re.compile(r"[\]\)\s\-–—]\s*\[?(\d{1,4})\]?(?=\s*(?:\[|\(|END|完|【|$))"), "sep"),
    (re.compile(r"(?:^|[\s\-–—\[])E[P]?(\d{1,4})\b", re.I), "ep"),
]


def parse_ep(title):
    """返回 (kind, a, b)；kind: single/range。巻(卷)不算集。"""
    for pat, kind in EP_PATTERNS:
        m = pat.search(title)
        if not m:
            continue
        if kind == "range":
            a, b = int(m.group(1)), int(m.group(2))
            if 0 < a <= b <= 999:
                return ("range", a, b)
            continue
        n = int(m.group(1))
        if 0 < n <= 999:          # 4 位数几乎都是年份，排除
            return ("single", n, n)
    return None




def clean_title(t):
    """发布标题 → 查询用作品名：剥字幕组/日期/规格/集数标记，「」里的名字优先。"""
    s = str(t or "")
    m = re.search(r"[「『]([^」』]{2,60})[」』]", s)
    if m:
        return m.group(1).strip()
    s = re.sub(r"^\s*(?:【[^】]*】|\[[^\]]*\])+", "", s)
    s = re.sub(r"\[[^\]]*\]|\([^)]*\)|【[^】]*】", " ", s)
    s = re.sub(r"(第?\d+\s*[-–~]?\s*\d*\s*[話话集巻]).*$", "", s)
    s = re.sub(r"(1080p|720p|2160p|4K|HEVC|H\.?264|x265|BDR?ip|WebRip|REMUX|Baha|WEB\-?DL|MKV|MP4|TV|完).*$", "", s, flags=re.I)
    s = re.sub(r"[\s\-–—_.]+$", "", s).strip()
    return s if len(s) >= 2 else str(t or "").strip()


def search(kw):
    url = API + "?kw=" + urllib.parse.quote(kw)
    req = urllib.request.Request(url, headers={"user-agent": "site-sync-magnet-eps/1.0"})
    if USER and PASS:
        tok = base64.b64encode(f"{USER}:{PASS}".encode()).decode()
        req.add_header("authorization", "Basic " + tok)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8"))


def _gh(args, payload=None):
    import subprocess
    cmd = ["gh", "api"] + args
    if payload is not None:
        cmd += ["--input", "-"]
    p = subprocess.run(cmd, input=json.dumps(payload) if payload is not None else None,
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout or "").strip()[:200])
    return json.loads(p.stdout) if (p.stdout or "").strip() else {}


def push_index(index):
    if not (os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")):
        print("· 无 GH_TOKEN，跳过分集索引回写")
        return
    raw = json.dumps(index, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    blob = _gh(["repos/REPO/git/blobs".replace("REPO", REPO)],
               {"content": base64.b64encode(raw).decode(), "encoding": "base64"})
    parent = _gh([f"repos/{REPO}/git/ref/heads/{BRANCH}"])["object"]["sha"]
    base_tree = _gh([f"repos/{REPO}/git/commits/{parent}"])["tree"]["sha"]
    tree = _gh(["repos/{}/git/trees".format(REPO)],
               {"base_tree": base_tree,
                "tree": [{"path": "media/magnet-eps.json", "mode": "100644", "type": "blob", "sha": blob["sha"]}]})
    commit = _gh(["repos/{}/git/commits".format(REPO)],
                 {"message": f"magnet-eps: index {len(index)}", "tree": tree["sha"], "parents": [parent]})
    _gh([f"repos/{REPO}/git/refs/heads/{BRANCH}", "-X", "PATCH"],
        {"sha": commit["sha"], "force": False})
    print(f"✓ 分集索引已回写 media/magnet-eps.json（{len(index)} 条）")


def main():
    mp = SITE / "magnet.json"
    if not mp.is_file():
        print("! magnet.json 不存在（fetch_magnet 需先跑）")
        return 0
    magnet = json.loads(mp.read_text(encoding="utf-8"))
    ep_path = SITE / "magnet-eps.json"
    index = {}
    if ep_path.is_file():
        try:
            index = json.loads(ep_path.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"! 旧索引损坏，重建：{e}")

    todo = [(k, v.get("t") or "") for k, v in magnet.items()
            if k not in index and v.get("t")]
    todo = todo[:LIMIT]
    print(f"magnet {len(magnet)} 条 / 已索引 {len(index)} 条 / 本轮 {len(todo)} 条")
    if not todo:
        (SITE / "magnet-eps.json").write_text(
            json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        push_index(index)
        return 0

    hit = miss = err = 0
    for k, title in todo:
        try:
            q = clean_title(title) or title
            payload = search(q)
        except Exception as e:
            err += 1
            print(f"! {title[:28]} -> {type(e).__name__}: {e}")
            continue
        eps = {}
        for it in payload.get("results") or []:
            mg = it.get("magnet") or ""
            if not mg.startswith("magnet:"):
                continue
            p = parse_ep(it.get("title") or "")
            if not p:
                continue
            if p[0] == "single":
                targets = [p[1]]
            else:                            # 范围包（第01-14話）：展开成每集一条来源
                if p[2] - p[1] + 1 > 99:
                    continue
                targets = list(range(p[1], p[2] + 1))
            subs = "".join(it.get("subs") or [])
            if p[0] == "range":
                subs = (subs + " 合集").strip()
            for n in targets:
                eps.setdefault(str(n), []).append({
                    "m": mg, "s": it.get("size") or 0, "sd": it.get("seeders") or 0,
                    "sub": subs, "t": (it.get("title") or "")[:80],
                })
        if not eps:
            miss += 1
            index[k] = {"n": title, "eps": {}}
            continue
        for n in eps:
            eps[n].sort(key=lambda c: (c.get("sd") or 0, 0 if "中" in c.get("sub", "") else 0,
                                       c.get("s") or 0), reverse=True)
            del eps[n][2:]                   # 每集最多 2 条
        index[k] = {"n": title, "eps": dict(sorted(eps.items(), key=lambda x: int(x[0])))}
        hit += 1

    (SITE / "magnet-eps.json").write_text(
        json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"完成：有分集 {hit} / 无分集 {miss} / 出错 {err}；索引总数 {len(index)}")
    try:
        push_index(index)
    except Exception as e:
        print(f"! 索引回写失败：{type(e).__name__}: {e}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"FATAL {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(0)
