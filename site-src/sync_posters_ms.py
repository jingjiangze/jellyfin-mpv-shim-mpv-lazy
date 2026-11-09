#!/usr/bin/env python3
"""把海报与站点资产同步到 ModelScope 数据集（站点的主 CDN 源）。

为什么重写（2026-11-09）：
  原来这段是 workflow 里 ~90 行 bash：`for f in ...; do grep -o 'size N' "$dst"; done`
  —— 2.4 万张海报**每条 fork 一个 grep**，实测每轮要 ~10 分钟，而且 git 的 rebase/冲突
  处理只能靠 graft 兜底（见下）。改成单进程 Python：
    · 尺寸表一次读完（只读每个 LFS 指针的前 200 字节），2.4 万条约 1–2 秒；
    · 复制/提交/推送全部在这里，失败语义明确（clone 三次失败只 warning，不判红）。
  clone 只取 --depth 1（数据集历史没必要拉），push 冲突先 rebase -X theirs，
  仍冲突就 graft（把本轮树挂到上游最新提交上）——与之前 CI 里的兜底逻辑等价。

环境变量：MS_TOKEN（必需）；可选 MS_REPO / MS_BRANCH / RUNNER_TEMP。
用法：在仓库根目录 `python -u site-src/sync_posters_ms.py [--dry-run]`。
"""
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = pathlib.Path.cwd()
SITE = ROOT / "site-src" / "site"
TPL = ROOT / "site-src" / "tpl"
MEDIA_POSTERS = ROOT / "media" / "posters"
BLOCK = ROOT / "site-src" / "ms-revert-blocklist.txt"
TMP = pathlib.Path(os.environ.get("RUNNER_TEMP", "/tmp"))
MS = TMP / "ms"
TOKEN = os.environ.get("MS_TOKEN", "").strip()
URL = f"https://oauth2:{TOKEN}@www.modelscope.cn/datasets/jingjiangze/Anime-JPG.git"
POINTER_MAX = 400          # LFS 指针就是 ~130 字节；超过这个就当真实文件
SKIP_EPS_NOTE = (
    "eps 分片不在这里同步：anime-magnet 自己 publish 完立刻推数据集，"
    "site-sync 的 checkout 通常比它旧，拷一次会把新版覆盖回旧版（历史事故：count 4490→4279）。"
)


# **必须有 GIT_LFS_SKIP_SMUDGE=1**：数据集里 2.4 万张海报是 LFS 对象（合计 7GB+），
# 不跳过 smudge 时 clone 会把它们全拉下来 —— 2026-11-09 重写时漏了它，实测直接卡到
# step 超时（12 分钟）且日志里一行输出都没有。同时禁掉交互提示、给每次 git 调用设超时。
GIT_ENV = dict(os.environ,
               GIT_LFS_SKIP_SMUDGE="1", GIT_TERMINAL_PROMPT="0",
               GIT_ASKPASS="/bin/true", GCM_INTERACTIVE="never")


def sh(*args, cwd=None, check=True, capture=True, timeout=600):
    p = subprocess.run(args, cwd=str(cwd) if cwd else None, env=GIT_ENV,
                       capture_output=capture, text=True, timeout=timeout,
                       stdin=subprocess.DEVNULL)
    if check and p.returncode != 0:
        err = (p.stderr or "")[-500:] if capture else ""
        raise RuntimeError("%s -> %s\n%s" % (" ".join(map(str, args)), p.returncode, err))
    return p


def redact(text):
    return re.sub(r"oauth2:[^@]*@", "oauth2:***@", text or "")


def on_disk_size(path):
    """远端海报的「逻辑尺寸」：LFS 指针取 size 字段，真实文件取 stat。"""
    try:
        size = path.stat().st_size
    except OSError:
        return None
    if size > POINTER_MAX:
        return size
    try:
        head = path.read_bytes()[:POINTER_MAX].decode("utf-8", "replace")
    except OSError:
        return None
    if "git-lfs" not in head:
        return size
    m = re.search(r"size (\d+)", head)
    return int(m.group(1)) if m else None


def clone():
    if not TOKEN:
        print("::warning::MS_TOKEN 未配置，跳过镜像同步")
        return False
    shutil.rmtree(MS, ignore_errors=True)
    for attempt in (1, 2, 3):
        # --no-checkout：先只拿 git 元数据，再单 checkout 需要的目录（避免 assets/data 的
        # 23MB 级大 JSON 被拉一遍；LFS 实体由 GIT_LFS_SKIP_SMUDGE 跳过）
        p = sh("git", "-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=120",
               "clone", "--depth", "1", "--no-checkout", URL, str(MS),
               check=False, capture=False, timeout=900)
        if p.returncode == 0:
            # 只检出 posters/ 与 assets/（数据集里还有 eps/ 等其它目录，本轮用不到）
            sh("git", "-C", str(MS), "sparse-checkout", "set", "--no-cone", "posters", "assets",
               check=False)
            p = sh("git", "-C", str(MS), "checkout", "-q", "HEAD", check=False, timeout=900)
        if p.returncode == 0:
            print(f"cloned (attempt {attempt})")
            return True
        print(redact(p.stderr or "")[-400:])
        print(f"clone 第 {attempt} 次失败，{attempt * 10}s 后重试")
        shutil.rmtree(MS, ignore_errors=True)
        time.sleep(attempt * 10)
    print("::warning::ModelScope 数据集 clone 失败（3 次）—— 本轮跳过镜像同步，"
          "站点仍从 gh-proxy / 同源加载 assets")
    return False


def blocked_names():
    if not BLOCK.is_file():
        return set()
    return {ln.strip() for ln in BLOCK.read_text(encoding="utf-8").splitlines()
            if ln.strip() and not ln.strip().startswith("#")}


def sync_posters(blocked):
    dst_dir = MS / "posters"
    dst_dir.mkdir(parents=True, exist_ok=True)
    # 一次读完远端尺寸表（原来是每条 fork 一个 grep）
    remote = {}
    for p in dst_dir.glob("*.jpg"):
        remote[p.name] = on_disk_size(p)
    print(f"remote posters: {len(remote)}")

    src = {}
    for d in (SITE / "posters", MEDIA_POSTERS):
        if d.is_dir():
            for p in d.glob("*.jpg"):
                src[p.name] = p                      # 后写覆盖：media/posters 优先
    added = updated = skipped = blocked_n = 0
    for name, local in sorted(src.items()):
        if name in blocked:
            blocked_n += 1
            continue
        want = local.stat().st_size
        have = remote.get(name)
        if have == want:
            skipped += 1
            continue
        shutil.copyfile(local, dst_dir / name)
        if have is None:
            added += 1
        else:
            updated += 1
    print(f"posters: added={added} updated={updated} unchanged={skipped} blocklisted={blocked_n}")
    return added + updated


def sync_assets():
    """站点静态资源镜像进 assets/（浏览器可能从数据集取 CSS/JS/HTML 与数据）。"""
    assets = MS / "assets"
    (assets / "data").mkdir(parents=True, exist_ok=True)
    n = 0
    for p in (SITE / "data").glob("*.json"):
        shutil.copyfile(p, assets / "data" / p.name)
        n += 1
    # 哈希名会随内容变：先清掉旧的 app-*.js / style-*.css，再拷当前这版
    for old in list(assets.glob("app-*.js")) + list(assets.glob("style-*.css")):
        old.unlink(missing_ok=True)
    for p in sorted((SITE / "app-*.js")) + sorted((SITE / "style-*.css")):
        shutil.copyfile(p, assets / p.name)
        n += 1
    for name in ("style.css", "app.js"):
        src = SITE / name
        if src.is_file():
            shutil.copyfile(src, assets / name)
            n += 1
    mep = TPL / "magnet-eps.js"
    if mep.is_file():
        shutil.copyfile(mep, assets / "magnet-eps.js")
        n += 1
    site_dir = assets / "site"
    site_dir.mkdir(parents=True, exist_ok=True)
    for p in SITE.glob("*.html"):
        shutil.copyfile(p, site_dir / p.name)
        n += 1
    print(f"assets: copied {n} 个文件（data JSON + 哈希名 + 固定名 + html 镜像）")
    print("  " + SKIP_EPS_NOTE)
    return n


def commit_and_push():
    git = lambda *a, **kw: sh("git", "-C", str(MS), *a, **kw)
    status = git("status", "--porcelain", "--", "posters", "assets").stdout.strip()
    if not status:
        print("dataset already in sync")
        return True
    git("-c", "commit.gpgsign=false", "-c", "user.name=github-actions",
        "-c", "user.email=actions@users.noreply.github.com",
        "add", "-A", "posters", "assets")
    git("-c", "commit.gpgsign=false", "-c", "user.name=github-actions",
        "-c", "user.email=actions@users.noreply.github.com",
        "commit", "-qm", "sync posters + assets from site repo")
    last = ""
    for attempt in (1, 2, 3):
        p = git("push", URL, "HEAD:master", check=False)
        if p.returncode == 0:
            print("pushed to dataset")
            return True
        last = p.stderr or ""
        print(f"push 第 {attempt} 次失败，尝试同步远端后重试")
        if git("fetch", "-q", "--depth", "1", URL, "master", check=False).returncode != 0:
            time.sleep(3)
            continue
        if git("-c", "rebase.autoStash=true", "rebase", "-X", "theirs", "FETCH_HEAD",
               check=False).returncode == 0:
            continue
        git("rebase", "--abort", check=False)
        # 删除/修改型冲突 rebase -X 也解决不了：把本轮树挂到上游最新提交上（graft）
        ok = git("fetch", "-q", "--depth", "1", URL, "master", check=False).returncode == 0
        ok = ok and git("reset", "--soft", "FETCH_HEAD", check=False).returncode == 0
        ok = ok and git("-c", "commit.gpgsign=false", "-c", "user.name=github-actions",
                        "-c", "user.email=actions@users.noreply.github.com",
                        "commit", "--allow-empty", "-qm",
                        "sync posters + assets (grafted on upstream)", check=False).returncode == 0
        print("rebase 冲突 → " + ("改用 graft 提交" if ok else "graft 也失败，放弃"))
        if not ok:
            break
        time.sleep(3)
    print(f"::error::push to ModelScope failed: {redact(last)[-300:]}")
    return False


def main():
    dry = "--dry-run" in sys.argv
    if dry:
        print(f"dry-run: site/posters={len(list((SITE / 'posters').glob('*.jpg'))) if (SITE / 'posters').is_dir() else 0}"
              f" media/posters={len(list(MEDIA_POSTERS.glob('*.jpg'))) if MEDIA_POSTERS.is_dir() else 0}")
        return 0
    t0 = time.time()
    if not clone():
        return 0                              # 非致命：站点还有 gh-proxy / 同源
    n = sync_posters(blocked_names())
    sync_assets()
    print(f"changed posters: {n}（耗时 {time.time() - t0:.1f}s）")
    return 0 if commit_and_push() else 1


if __name__ == "__main__":
    sys.exit(main())
