#!/usr/bin/env python3
"""站点发布：**单一写入者**。一次 run 只产生一个提交，覆盖站点需要的全部仓库路径。

为什么要重构（2026-11-09 审计）：
  重构前有 4 个步骤分别写仓库，彼此抢同一批文件，靠 rebase/graft 硬扛冲突：
    · Push shards (Git Data API)    → site-src/site/anime、site-src/site/data、site-src/data
    · Push data JSON to GitHub CDN  → media/assets/{style.css,app.js,magnet-eps.js}、media/data/*
    · Push style/app to CDN         → media/assets/app-<hash>.js、style-<hash>.css（还会 prune 旧哈希名）
    · Publish data + posters + state→ git 提交 media/posters、site-src/data、site-src/site/*.json
  其中 `site-src/data/*` 被第 1 和第 4 个同时写（实测冲突过一次），
  `media/assets/*` 被第 2、3 个同时写。现在合并成**一个脚本、一次提交**，顺序天然确定。

写什么（全部与「远端 blob sha 不同」才上传）：
  A. 构建产物 → CDN 镜像
     media/assets/{style.css,app.js,magnet-eps.js}
     media/assets/app-<hash>.js / style-<hash>.css（当前这版；旧哈希名删除）
     media/data/<build-out/data/*.json 全部>（anime/movies/tags/index-*/library-*/sNN…）
  B. 海报（HD 全量不进 git，增量）
     media/posters/*.jpg ← media/posters（工作树里由 Sync 步骤从 site/posters 拷来）
  C. 数据真源与状态（下一轮 Restore state / 构建的输入）
     site-src/site/anime/*.json（**已清洗**：简介里的历史 [简介原文] 块在这里落库，之后构建是 no-op）
     site-src/site/*.json（data/bili/magnet/magnet-eps/fresh/tmdb/yt/years_state/movies-intro…）
     site-src/data/*.json、site-src/poster_cache.json
  D. 删除（自管理，不是拍脑袋删）
     旧 media/assets/app-*.js、style-*.css（不在本版清单里）
     media/magnet-eps.js（旧 loader 路径，前端已改读 media/assets/）

不做：media/ 根目录那两个历史遗留 app-<hash>.js（无引用，但删仓文件要单独授权，见 UNTOUCHED）。

用法（在仓库根目录跑）：
    python -u site-src/publish_all.py            # 只打印计划
    python -u site-src/publish_all.py --yes      # 真推（需要 GH_TOKEN）
退出码：0 成功/无变化；1 失败（::error:: 注解）。
"""
import base64
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPO = os.environ.get("REPO", "jingjiangze/jellyfin-mpv-shim-mpv-lazy")
BRANCH = os.environ.get("BRANCH", "main")
ROOT = pathlib.Path.cwd()
BUILD = ROOT / "build-out"
SITE = ROOT / "site-src" / "site"
DATA_STATE = ROOT / "site-src" / "data"
POSTERS_SITE = ROOT / "site-src" / "site" / "posters"
POSTERS_MEDIA = ROOT / "media" / "posters"

MAX_RETRY = 3
HASH_RE = re.compile(r"^(app|style)-[0-9a-f]{10}\.(js|css)$")
# 历史遗留：media/ 根目录的旧 app-<hash>.js 无任何引用，但删仓文件需单独授权，先不动
UNTOUCHED = re.compile(r"^media/app-[0-9a-f]{10}\.js$")


class GhError(RuntimeError):
    def __init__(self, code, detail):
        super().__init__(f"gh api -> HTTP {code}: {detail}")
        self.code = code
        self.detail = detail


def gh(path, payload=None, method=None):
    cmd = ["gh", "api", path]
    if method:
        cmd += ["--method", method]
    data = None
    if payload is not None:
        cmd += ["--input", "-"]
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    p = subprocess.run(cmd, input=data, capture_output=True)
    if p.returncode != 0:
        err = p.stderr.decode("utf-8", "replace").strip()
        m = re.search(r"HTTP (\d{3})", err)
        raise GhError(int(m.group(1)) if m else 0, err[:400] or f"exit {p.returncode}")
    out = p.stdout.strip()
    return json.loads(out or b"{}")


def blob_sha(data):
    h = hashlib.sha1()
    h.update(b"blob %d\0" % len(data))
    h.update(data)
    return h.hexdigest()


def _add(pairs, repo_path, local, required=True):
    if local.is_file():
        pairs.append((repo_path, local))
    elif required:
        print(f"::warning::缺文件 {local}（跳过 {repo_path}）")


# 「Restore state」把 site-src/data/*.json 拷进 site-src/site/，所以这两边必须一致：
# 这里把本轮跑到的最新状态从 site/ 回流到 data/（历史 Publish 步骤做的同一件事，现在并进单一写入者）
STATE_BACK = ("data.json", "bili.json", "magnet.json", "magnet-eps.json",
              "fresh.json", "tmdb.json", "yt.json", "years_state.json", "movies-intro.json")


def sync_state_back():
    copied = []
    for name in STATE_BACK:
        src = SITE / name
        if not src.is_file():
            continue
        dst = DATA_STATE / name
        data = src.read_bytes()
        if dst.is_file() and dst.read_bytes() == data:
            continue
        DATA_STATE.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(data)
        copied.append(name)
    if copied:
        print("state 回流 site→data：" + ", ".join(copied))


def plan():
    """(仓库路径, 本地路径) 清单 + 需要删除的路径集合。"""
    if not BUILD.is_dir():
        print(f"::error::缺构建产物 {BUILD}")
        return None, set(), set()

    pairs = []
    # A. CDN 镜像：固定名资源
    for name in ("style.css", "app.js", "magnet-eps.js"):
        _add(pairs, f"media/assets/{name}", BUILD / name)
    # A. CDN 镜像：本版哈希名（同时算出要删的旧哈希名）
    keep_hash = set()
    for p in sorted(BUILD.glob("app-*.js")) + sorted(BUILD.glob("style-*.css")):
        if HASH_RE.match(p.name):
            _add(pairs, f"media/assets/{p.name}", p)
            keep_hash.add(p.name)
    # A. CDN 镜像：全部数据 JSON（含 index-*/library-*/分片）
    for p in sorted((BUILD / "data").glob("*.json")):
        _add(pairs, f"media/data/{p.name}", p)
    # B. 海报增量：优先用本轮刚抓的 site/posters（fill_posters 的产物），没有才用 media/posters
    poster_dir = POSTERS_SITE if POSTERS_SITE.is_dir() else POSTERS_MEDIA
    if poster_dir.is_dir():
        for p in sorted(poster_dir.glob("*.jpg")):
            _add(pairs, f"media/posters/{p.name}", p, required=False)
        print(f"posters source: {poster_dir}")
    # C. 真源与状态
    for p in sorted((SITE / "anime").glob("*.json")):
        _add(pairs, f"site-src/site/anime/{p.name}", p)
    for p in sorted(SITE.glob("*.json")):
        _add(pairs, f"site-src/site/{p.name}", p, required=False)
    for p in sorted(DATA_STATE.glob("*.json")):
        _add(pairs, f"site-src/data/{p.name}", p, required=False)
    _add(pairs, "site-src/poster_cache.json", ROOT / "site-src" / "poster_cache.json", required=False)
    keep_data = {p.name for p in (BUILD / "data").glob("*.json")}
    return pairs, keep_hash, keep_data


def deletions(remote_paths, keep_hash, keep_data=()):
    """自管理的清理：旧哈希名资源 + 旧哈希名数据索引。

    · media/assets 里不在本版清单里的 app-/style- 哈希名（每版换名，不删会无限积累）
    · media/data 里旧的 index-<hash>.json / library-<hash>.json（HTML 只引当前那份）
    · media/magnet-eps.js（旧 loader 路径，前端已改读 media/assets/）
    media/ 根目录历史遗留的 app-<hash>.js 不动（无引用，但删仓文件要单独授权）。
    """
    out = ["media/magnet-eps.js"]
    keep = set(keep_hash) | set(keep_data)
    for path in remote_paths:
        name = path.rsplit("/", 1)[-1]
        if path.startswith("media/assets/") and not UNTOUCHED.match(path):
            if HASH_RE.match(name) and name not in keep:
                out.append(path)
        elif path.startswith("media/data/") and name not in keep:
            if re.match(r"^(index|library)-[0-9a-f]{10}\.json$", name):
                out.append(path)
    return [p for p in dict.fromkeys(out) if p in remote_paths]


def main():
    push = "--yes" in sys.argv
    if push and not os.environ.get("GH_TOKEN", "").strip():
        print("::error::GH_TOKEN 未设置，无法推送")
        return 1

    sync_state_back()
    pairs, keep_hash, keep_data = plan()
    if pairs is None:
        return 1

    entries = []
    for repo_path, local in pairs:
        data = local.read_bytes()
        entries.append({"repo": repo_path, "data": data, "sha": blob_sha(data), "size": len(data)})
    total = sum(e["size"] for e in entries)
    print(f"plan: {len(entries)} 个文件 / {total/1048576:.1f} MB")

    for attempt in range(1, MAX_RETRY + 2):
        try:
            head = gh(f"repos/{REPO}/git/ref/heads/{BRANCH}")["object"]["sha"]
            base_tree = gh(f"repos/{REPO}/git/commits/{head}")["tree"]["sha"]
            tree = gh(f"repos/{REPO}/git/trees/{base_tree}?recursive=1")
        except GhError as e:
            print(f"::error::{e}")
            return 1
        if tree.get("truncated"):
            print("::warning::远端树 truncated=true，增量判定可能漏判")
        remote = {e["path"]: e["sha"] for e in tree.get("tree", []) if e.get("type") == "blob"}

        changed = [e for e in entries if remote.get(e["repo"]) != e["sha"]]
        dels = deletions(remote, keep_hash, keep_data)
        print(f"changed {len(changed)} / unchanged {len(entries) - len(changed)} / delete {len(dels)}"
              f"（head {head[:8]}）")
        for e in changed[:25]:
            print(f"  CHANGE {e['repo']:46s} {e['size']:9d} B")
        if len(changed) > 25:
            print(f"  ... 另有 {len(changed) - 25} 个")
        for p in dels[:10]:
            print(f"  DELETE {p}")

        if not push:
            print("[dry-run] 未写远端")
            return 0
        if not changed and not dels:
            print("无变化，未提交")
            return 0

        try:
            for e in changed:
                blob = gh(f"repos/{REPO}/git/blobs",
                          {"content": base64.b64encode(e["data"]).decode(), "encoding": "base64"})
                if blob.get("sha") != e["sha"]:
                    print(f"::error::blob sha 不一致 {e['repo']}")
                    return 1
            items = [{"path": e["repo"], "mode": "100644", "type": "blob", "sha": e["sha"]}
                     for e in changed]
            items += [{"path": p, "mode": "100644", "type": "blob", "sha": None} for p in dels]
            new_tree = gh(f"repos/{REPO}/git/trees", {"base_tree": base_tree, "tree": items})
            msg = (f"publish: assets+data+state {len(changed)} files"
                   f"{', -%d' % len(dels) if dels else ''} [skip ci]")
            commit = gh(f"repos/{REPO}/git/commits",
                        {"message": msg, "tree": new_tree["sha"], "parents": [head]})
            gh(f"repos/{REPO}/git/refs/heads/{BRANCH}",
               {"sha": commit["sha"], "force": False}, method="PATCH")
        except GhError as e:
            conflict = e.code in (409, 422) or "fast forward" in e.detail.lower()
            if conflict and attempt <= MAX_RETRY:
                print(f"ref 被并发推进，重试 {attempt}/{MAX_RETRY}（重取 base）")
                time.sleep(1.5 * attempt)
                continue
            print(f"::error::{e}")
            return 1

        print(f"PUSHED {commit['sha'][:8]}  {len(changed)} 个文件"
              f"{'，删 %d' % len(dels) if dels else ''}")
        return 0

    print("::error::重试次数用尽")
    return 1


if __name__ == "__main__":
    sys.exit(main())
