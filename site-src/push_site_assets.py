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
# 哈希名文件也要推：页面 loader 的第一候选是 app-<hash>.js / style-<hash>.css
# （CDN 里新路径必然是新内容），只推固定名会让 gh-proxy 这条兜底对哈希名 404。
# 同一目录里**旧的**哈希名文件由 prune_stale() 删掉，否则每轮新增 260KB 进仓库。
for _p in sorted((HERE / "site").glob("app-*.js")) + sorted((HERE / "site").glob("style-*.css")):
    FILES["media/assets/" + _p.name] = _p

MSG = "assets: sync style.css/app.js (+hash names) to CDN [skip ci]"


def prune_stale(head, keep):
    """返回要删除的 tree 条目（旧哈希名文件）：sha=None 表示删除。"""
    r = subprocess.run(
        ["gh", "api", f"repos/{REPO}/contents/media/assets?ref={head}"],
        capture_output=True)
    if r.returncode != 0:
        return []                      # 目录还不存在 / 取不到：本轮不删
    try:
        items = json.loads(r.stdout or b"[]")
    except Exception:
        return []
    out = []
    for it in items if isinstance(items, list) else []:
        name = it.get("name") or ""
        if not (name.startswith("app-") or name.startswith("style-")):
            continue
        if it.get("type") != "blob" or name in keep:
            continue
        out.append({"path": "media/assets/" + name, "mode": "100644", "type": "blob", "sha": None})
    return out


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
        keep = {k.split("/")[-1] for k in FILES}
        stale = prune_stale(head, keep)
        if stale:
            print("prune:", ", ".join(i["path"].split("/")[-1] for i in stale))
        items += stale
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
