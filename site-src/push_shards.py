#!/usr/bin/env python3
"""用 Git Data API 推送本轮被改动的分片 / 数据文件。

为什么不用 `git push`：site-sync 的 publish 步骤走 `git rebase FETCH_HEAD`，
而同一轮里 push_assets / push_site_assets 已经用 Git Data API 推进过 ref，
rebase 必然冲突 → 走到 `rebase conflict, skip push` 分支，本轮抓到的数据全丢
（2026-11-03 实测：1,500 条角色数据就是这么没的）。

这里改成「先看工作树哪些文件变了，再基于当前 head 的 tree 建一个 commit」，
天然不会有冲突；ref 被并发推进就整段重试。

用法：python push_shards.py [--dry-run]
"""
import base64
import json
import pathlib
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPO = "jingjiangze/jellyfin-mpv-shim-mpv-lazy"
BRANCH = "main"
WATCH = ("site-src/site/anime", "site-src/site/data", "site-src/data")


def gh(args, payload=None, method=None):
    cmd = ["gh", "api"] + args
    if method:
        cmd += ["--method", method]
    data = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None
    if payload is not None:
        cmd += ["--input", "-"]
    p = subprocess.run(cmd, input=data, capture_output=True)
    if p.returncode != 0:
        sys.stderr.write(p.stderr.decode("utf-8", "replace")[:500])
        raise SystemExit(1)
    return json.loads(p.stdout or b"{}")


def changed():
    out = subprocess.run(["git", "status", "--porcelain", "--"] + list(WATCH),
                         capture_output=True, text=True, encoding="utf-8", errors="replace").stdout
    files = []
    for line in out.splitlines():
        if len(line) < 4:
            continue
        path = line[3:].strip().strip('"')
        if path.endswith(".json"):
            files.append(path.replace("\\", "/"))
    return sorted(set(files))


def main():
    files = changed()
    print(f"工作树里变动的分片/数据文件：{len(files)} 个")
    for f in files[:8]:
        print("  ", f)
    if len(files) > 8:
        print("   ...")
    if not files:
        return 0
    if "--dry-run" in sys.argv:
        return 0

    for attempt in range(4):
        head = gh([f"repos/{REPO}/git/ref/heads/{BRANCH}"])["object"]["sha"]
        base_tree = gh([f"repos/{REPO}/git/commits/{head}"])["tree"]["sha"]
        items = []
        for f in files:
            local = pathlib.Path(f)
            if not local.is_file():
                continue
            blob = gh([f"repos/{REPO}/git/blobs"], {
                "content": base64.b64encode(local.read_bytes()).decode(), "encoding": "base64"})
            items.append({"path": f, "mode": "100644", "type": "blob", "sha": blob["sha"]})
        tree = gh([f"repos/{REPO}/git/trees"], {"base_tree": base_tree, "tree": items})
        commit = gh([f"repos/{REPO}/git/commits"], {
            "message": "data: shards + state（%d files）[skip ci]" % len(items),
            "tree": tree["sha"], "parents": [head]})
        try:
            gh([f"repos/{REPO}/git/refs/heads/{BRANCH}"],
               {"sha": commit["sha"], "force": False}, method="PATCH")
            print("PUSHED", commit["sha"][:8], "files =", len(items))
            return 0
        except SystemExit:
            print(f"ref 被并发推进，重试 {attempt + 1}/4")
    raise SystemExit("推送分片失败")


if __name__ == "__main__":
    sys.exit(main())
