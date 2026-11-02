#!/usr/bin/env python3
"""把站点静态资源增量推到 GitHub media/，让 raw / jsDelivr 拿到完整镜像。

背景：站点资源原来只挂在数据集 + CF Pages，GitHub 镜像缺 media/data/ 整个目录
和 media/assets/magnet-eps.js；media/magnet-eps.js 则是旧 loader（前端已改读
media/assets/ 下的新件）。海报 hd 全量约 1.7GB，不进 git，本脚本不碰 posters/。

增量判定：用 Git Data API 取远端 media 树的 blob sha，本地按
sha1("blob <len>\\0" + content) 算 git blob hash，相同即跳过；只有变化的文件
才建 blob，全部变化合并成一个 commit（一次 tree + 一次 commit + 一次 ref
PATCH，force=false）。用 subprocess 调 `gh api`（本机 git 不可靠），payload
一律走 `--input -`，规避 Windows 命令行长度上限。

用法：
    python push_data_cdn.py            # 只打印计划（默认不写）
    python push_data_cdn.py --dry-run  # 同上，显式
    python push_data_cdn.py --yes      # 真推，需要 GH_TOKEN

dry-run 只读远端树：没有 GH_TOKEN 时退回 gh 自己已登录的凭据（只读），
真推（--yes）缺 GH_TOKEN 会打印 ::error:: 并 exit 1。
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
MSG = "assets: sync data+css+js to CDN [skip ci]"
ROOT = pathlib.Path.cwd()
SITE = ROOT / "site"
DATA_DIR = SITE / "data"
ASSETS = ("style.css", "app.js", "magnet-eps.js")
TOP_DATA = ("anime.json", "movies.json", "tags.json")
SHARD_RE = re.compile(r"s\d{1,2}\.json$")
# 旧 loader：前端已改读 media/assets/magnet-eps.js，根目录那份留着会被误用。
DELETES = ("media/magnet-eps.js",)
MAX_RETRY = 3


class GhError(RuntimeError):
    def __init__(self, code, detail):
        super().__init__(f"gh api -> HTTP {code}: {detail}")
        self.code = code
        self.detail = detail


def gh(path, payload=None, method=None):
    """调 gh api；payload 走 stdin，避免命令行长度问题。"""
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
    """git blob 对象的哈希：sha1("blob <len>\\0" + content)。"""
    h = hashlib.sha1()
    h.update(b"blob %d\0" % len(data))
    h.update(data)
    return h.hexdigest()


def plan():
    """(仓库路径, 本地路径) 清单。路径一律 posix，Git 树才建得对。"""
    pairs = [(f"media/assets/{n}", SITE / n) for n in ASSETS]
    pairs += [(f"media/data/{n}", DATA_DIR / n) for n in TOP_DATA]
    for p in sorted(DATA_DIR.glob("s*.json")):
        if SHARD_RE.fullmatch(p.name):
            pairs.append((f"media/data/{p.name}", p))
    return pairs


def remote_blobs(tree_sha):
    tree = gh(f"repos/{REPO}/git/trees/{tree_sha}?recursive=1")
    if tree.get("truncated"):
        print("! 远端树 truncated=true，增量判定可能漏判", file=sys.stderr)
    return {e["path"]: e["sha"] for e in tree.get("tree", []) if e.get("type") == "blob"}


def main():
    push = "--yes" in sys.argv
    token = os.environ.get("GH_TOKEN", "").strip()
    if push and not token:
        print("::error::GH_TOKEN 未设置，无法推送")
        return 1
    if not push and not token:
        print("# 未设置 GH_TOKEN：dry-run 走 gh 已登录凭据（只读）")

    pairs = plan()
    missing = [str(local) for _, local in pairs if not local.is_file()]
    if missing:
        print("::error::缺文件：" + ", ".join(missing))
        return 1

    entries = []
    for repo_path, local_path in pairs:
        data = local_path.read_bytes()
        entries.append({"repo": repo_path, "local": local_path, "data": data,
                        "sha": blob_sha(data), "size": len(data)})

    for attempt in range(1, MAX_RETRY + 2):
        try:
            head = gh(f"repos/{REPO}/git/ref/heads/{BRANCH}")["object"]["sha"]
            base_tree = gh(f"repos/{REPO}/git/commits/{head}")["tree"]["sha"]
            remote = remote_blobs(base_tree)
        except GhError as e:
            print(f"::error::{e}")
            return 1

        same = {e["repo"]: remote.get(e["repo"]) == e["sha"] for e in entries}
        changed = [e for e in entries if not same[e["repo"]]]
        skipped = len(entries) - len(changed)
        deleted = [p for p in DELETES if p in remote]
        names = [e["repo"] for e in changed] + list(deleted)

        for e in entries:
            print(f"{'SKIP  ' if same[e['repo']] else 'CHANGE'} {e['repo']:32s} {e['size']:8d} B")
        for p in DELETES:
            print(f"{'DELETE' if p in remote else 'ABSENT'} {p}")
        print(f"push_data_cdn: changed {len(changed)} / skipped {skipped} / deleted {len(deleted)}")
        for n in names[:20]:
            print(f"  {n}")
        if len(names) > 20:
            print(f"  ... 另有 {len(names) - 20} 个")

        if not push:
            print("[dry-run] 未写远端")
            return 0
        if not names:
            print("无变化，未提交")
            return 0

        try:
            for e in changed:
                blob = gh(f"repos/{REPO}/git/blobs",
                          {"content": base64.b64encode(e["data"]).decode(), "encoding": "base64"})
                if blob.get("sha") != e["sha"]:
                    print(f"::error::blob sha 不一致 {e['repo']}: 本地 {e['sha']} 远端 {blob.get('sha')}")
                    return 1
                print(f"  blob {e['repo']} {e['size']}B")
            tree_items = [{"path": e["repo"], "mode": "100644", "type": "blob", "sha": e["sha"]}
                          for e in changed]
            tree_items += [{"path": p, "mode": "100644", "type": "blob", "sha": None}
                           for p in deleted]
            tree = gh(f"repos/{REPO}/git/trees", {"base_tree": base_tree, "tree": tree_items})
            commit = gh(f"repos/{REPO}/git/commits",
                        {"message": MSG, "tree": tree["sha"], "parents": [head]})
            gh(f"repos/{REPO}/git/refs/heads/{BRANCH}", {"sha": commit["sha"], "force": False},
               method="PATCH")
        except GhError as e:
            conflict = e.code in (409, 422) or "fast forward" in e.detail.lower()
            if conflict and attempt <= MAX_RETRY:
                print(f"ref 被并发推进，重试 {attempt}/{MAX_RETRY}（重取 base）")
                time.sleep(1.5 * attempt)
                continue
            print(f"::error::{e}")
            return 1

        print(f"PUSHED {commit['sha'][:8]}")
        print(f"https://github.com/{REPO}/commit/{commit['sha']}")
        return 0

    print("::error::重试次数用尽，推送失败")
    return 1


if __name__ == "__main__":
    sys.exit(main())
