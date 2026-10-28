#!/usr/bin/env python3
"""把站点海报增量推到已有仓库的 media/posters/（不新建仓库）。

走 Git Data API：本机 `git push` 到 github.com 间歇性超时（已多次实测），
而 `gh api` 稳定。一次运行最多推 LIMIT 张，避免单次请求过大。

用法：python push_assets.py [--dry-run]
"""
import base64
import json
import pathlib
import subprocess
import sys

REPO = "jingjiangze/jellyfin-mpv-shim-mpv-lazy"
BRANCH = "main"
DIR = "media/posters"
LIMIT = 150

HERE = pathlib.Path(__file__).resolve().parent
POSTERS = HERE / "site" / "posters"


def gh(args, payload=None):
    cmd = ["gh", "api"] + args
    if payload is not None:
        cmd += ["--input", "-"]
    p = subprocess.run(cmd, input=json.dumps(payload) if payload is not None else None,
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if p.returncode != 0:
        raise SystemExit(f"gh failed: {' '.join(cmd)}\n{p.stderr.strip()}")
    out = p.stdout.strip()
    return json.loads(out) if out else None


def remote_names():
    """仓库里 media/posters 下已有的文件名（翻页）。"""
    names, page = set(), 1
    while True:
        try:
            data = gh([f"repos/{REPO}/contents/{DIR}?ref={BRANCH}&per_page=100&page={page}"])
        except SystemExit:
            return names          # 目录还不存在
        if not data:
            break
        names.update(item["name"] for item in data if item.get("type") == "blob")
        if len(data) < 100:
            break
        page += 1
    return names


def main():
    dry = "--dry-run" in sys.argv
    if not POSTERS.is_dir():
        print("没有 site/posters 目录")
        return 0
    have = remote_names()
    local = sorted(p for p in POSTERS.glob("*.jpg"))
    todo = [p for p in local if p.name not in have][:LIMIT]
    print(f"本地 {len(local)} 张 / 远端 {len(have)} 张 / 本次上传 {len(todo)} 张")
    if not todo or dry:
        return 0

    parent = gh([f"repos/{REPO}/git/ref/heads/{BRANCH}"])["object"]["sha"]
    base_tree = gh([f"repos/{REPO}/git/commits/{parent}"])["tree"]["sha"]
    entries = []
    for path in todo:
        # 内容必须走 stdin 的 JSON body：单张海报 base64 后 >25KB，用 -f 会触发
        # Windows "文件名或扩展名太长"(WinError 206)
        blob = gh([f"repos/{REPO}/git/blobs"],
                  {"content": base64.b64encode(path.read_bytes()).decode(), "encoding": "base64"})
        entries.append({"path": f"{DIR}/{path.name}", "mode": "100644", "type": "blob", "sha": blob["sha"]})
    tree = gh([f"repos/{REPO}/git/trees"], {"base_tree": base_tree, "tree": entries})
    commit = gh([f"repos/{REPO}/git/commits"],
                {"message": f"assets: add {len(entries)} posters", "tree": tree["sha"], "parents": [parent]})
    gh([f"repos/{REPO}/git/refs/heads/{BRANCH}", "-X", "PATCH"],
       {"sha": commit["sha"], "force": False})
    print(f"pushed {len(entries)} blobs -> {commit['sha'][:8]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
