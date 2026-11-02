#!/usr/bin/env python3
"""把 site/style.css 与 site/app.js 推到仓库 media/assets/，供 jsDelivr(gcore) 分发。

为什么单独一个脚本：site-sync 里用 `git add -A media` 那条路没把新目录带进去
（实测 publish 步骤 success 但 media/assets 没进仓库），而站点又需要 CDN 版本
的两个资源。这里走 Git Data API（和 push_assets.py / magnet_publish.py 一致），
不依赖工作树的 git 状态。

用法：python push_site_assets.py [--dry-run]
"""
import base64
import json
import pathlib
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPO = "jingjiangze/jellyfin-mpv-shim-mpv-lazy"
BRANCH = "main"
HERE = pathlib.Path(__file__).resolve().parent
FILES = {
    "media/assets/style.css": HERE / "site" / "style.css",
    "media/assets/app.js": HERE / "site" / "app.js",
}
MSG = "assets: sync style.css/app.js to CDN [skip ci]"


def gh(args, payload=None, method=None):
    cmd = ["gh", "api"] + args
    if method:
        cmd += ["--method", method]
    data = None
    if payload is not None:
        cmd += ["--input", "-"]
        data = json.dumps(payload, ensure_ascii=False).encode()
    p = subprocess.run(cmd, input=data, capture_output=True)
    if p.returncode != 0:
        sys.stderr.write(p.stderr.decode("utf-8", "replace")[:400])
        raise SystemExit(1)
    return json.loads(p.stdout or b"{}")


def main():
    dry = "--dry-run" in sys.argv
    for repo_path, local in FILES.items():
        if not local.is_file():
            print(f"SKIP 缺文件 {local}")
            return 0
        print(f"{repo_path:28s} {local.stat().st_size:7d} B")

    if dry:
        print("[dry-run] 未推送")
        return 0

    for attempt in range(4):
        head = gh([f"repos/{REPO}/git/ref/heads/{BRANCH}"])["object"]["sha"]
        base_tree = gh([f"repos/{REPO}/git/commits/{head}"])["tree"]["sha"]
        items = []
        for repo_path, local in FILES.items():
            blob = gh([f"repos/{REPO}/git/blobs"], {
                "content": base64.b64encode(local.read_bytes()).decode(), "encoding": "base64"})
            items.append({"path": repo_path, "mode": "100644", "type": "blob", "sha": blob["sha"]})
        tree = gh([f"repos/{REPO}/git/trees"], {"base_tree": base_tree, "tree": items})
        commit = gh([f"repos/{REPO}/git/commits"], {
            "message": MSG, "tree": tree["sha"], "parents": [head]})
        try:
            gh([f"repos/{REPO}/git/refs/heads/{BRANCH}"], {"sha": commit["sha"], "force": False},
               method="PATCH")
            print("PUSHED", commit["sha"][:8])
            return 0
        except SystemExit:
            print(f"ref 被并发推进，重试 {attempt + 1}/4")
    raise SystemExit("推送失败")


if __name__ == "__main__":
    sys.exit(main())
