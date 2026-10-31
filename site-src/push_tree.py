#!/usr/bin/env python3
"""用 Git Data API 提交任意文件/目录，绕开 `git rebase` 的 CRLF 伪差异问题。

仓库里混着 CRLF 文件时，CI 的 `git add` 会算出"归一化差异"，随后的 rebase 一律报
`cannot rebase: You have unstaged changes` 然后跳过 push（已在 site-sync / catalog
两个 workflow 上各踩一次）。Git Data API 不碰工作树，天然免疫。

用法：
  python push_tree.py --message "catalog: 8851" site-src/data/catalog.json
  python push_tree.py --message "anime shards" --dir site-src/site/anime
"""
import argparse
import base64
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request

REPO = os.environ.get("TARGET_REPO", "jingjiangze/jellyfin-mpv-shim-mpv-lazy")
BRANCH = os.environ.get("TARGET_BRANCH", "main")
TOKEN = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""
API = "https://api.github.com"


def call(method, path, payload=None, tries=4):
    for i in range(tries):
        req = urllib.request.Request(
            API + path,
            method=method,
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={
                "authorization": f"Bearer {TOKEN}",
                "accept": "application/vnd.github+json",
                "x-github-api-version": "2022-11-28",
                "user-agent": "anime-catalog-pusher",
                "content-type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                body = r.read().decode("utf-8")
                return json.loads(body) if body.strip() else {}
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:200]
            if e.code in (409, 422) and i < tries - 1:
                time.sleep(1.5 * (i + 1))
                continue
            if e.code >= 500 and i < tries - 1:
                time.sleep(1.5 * (i + 1))
                continue
            raise SystemExit(f"{method} {path} -> {e.code} {detail}")
        except Exception:
            if i < tries - 1:
                time.sleep(1.5 * (i + 1))
                continue
            raise


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--message", required=True)
    ap.add_argument("--dir", default=None, help="目录（递归取其中 *.json）")
    ap.add_argument("paths", nargs="*", help="单个文件路径（仓库相对）")
    a = ap.parse_args()

    if not TOKEN:
        print("无 GH_TOKEN，跳过推送")
        return 0

    files = list(a.paths)
    if a.dir:
        d = pathlib.Path(a.dir)
        files += [str(p).replace("\\", "/") for p in sorted(d.rglob("*.json"))]
    files = [f for f in dict.fromkeys(files) if pathlib.Path(f).is_file()]
    if not files:
        print("没有要推的文件")
        return 0

    ref = call("GET", f"/repos/{REPO}/git/ref/heads/{BRANCH}")
    parent = ref["object"]["sha"]
    base_tree = call("GET", f"/repos/{REPO}/git/commits/{parent}")["tree"]["sha"]

    entries = []
    for f in files:
        raw = pathlib.Path(f).read_bytes()
        blob = call("POST", f"/repos/{REPO}/git/blobs",
                    {"content": base64.b64encode(raw).decode(), "encoding": "base64"})
        entries.append({"path": f, "mode": "100644", "type": "blob", "sha": blob["sha"]})
        time.sleep(0.35)  # 连发太快会被 GitHub 打 500

    tree = call("POST", f"/repos/{REPO}/git/trees", {"base_tree": base_tree, "tree": entries})
    commit = call("POST", f"/repos/{REPO}/git/commits",
                  {"message": a.message, "tree": tree["sha"], "parents": [parent]})
    call("PATCH", f"/repos/{REPO}/git/refs/heads/{BRANCH}", {"sha": commit["sha"], "force": False})
    print(f"pushed {len(files)} files -> {commit['sha'][:8]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
