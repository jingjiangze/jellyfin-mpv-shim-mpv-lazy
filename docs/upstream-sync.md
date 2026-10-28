# 上游同步链路

本项目建立在两条上游之上，两者的行为都可能让这里的结论失效：

| 上游 | 作用 | 关心的东西 |
|---|---|---|
| [jellyfin/jellyfin-mpv-shim](https://github.com/jellyfin/jellyfin-mpv-shim) | 播放器前端 | `mpv_options.py` 里 `--config-dir` 的注入条件、`player.py` 首启建空配置、libmpv 加载方式 |
| [hooke007/mpv_PlayKit](https://github.com/hooke007/mpv_PlayKit) | mpv-lazy 配置集 | `portable_config/mpv.conf` 的 `~~/` 引用、`scripts/` 与 `shaders/` 结构 |

## 1. 镜像 fork（自动同步）

两个上游都已 fork 到本账号。每个 fork 里**只多一个文件** `.github/workflows/sync-upstream.yml`，其余内容与上游逐字节一致：

- https://github.com/jingjiangze/jellyfin-mpv-shim （每天同步 `master`）
- https://github.com/jingjiangze/mpv_PlayKit （每天同步 `main`）

同步逻辑（`sync-upstream.yml`，每天 04:23 Asia/Shanghai 跑一次）：

1. `git fetch upstream`；
2. 若上游已是当前 HEAD 的祖先 → 打印 `already up to date with upstream` 直接退出（**幂等，不产生任何提交**）；
3. 否则 `git rebase upstream/<branch>`，把我们那一个 commit 重新叠到上游最新之上，再 `git push --force-with-lease`；
4. 最后打印 `git diff --stat upstream/<branch> HEAD`——正常情况下只会看到 `sync-upstream.yml` 一个文件。

**为什么用 rebase 而不是官方 `merge-upstream` API**：rebase 让 fork 的历史恒为「上游 + 我们的 1 个 commit」，不会攒出一长串 merge commit；`--force-with-lease` 保证只在预期基线上强推。API 的 `merge-upstream` 也能用（`merge_type` 有 `merge/fast-forward/none`），但长期会分叉成 merge 链。

**为什么不需要任何令牌**：workflow 跑在 fork 自己里面，用 `secrets.GITHUB_TOKEN`（配 `permissions: contents: write`）就能 fetch 公开上游、push 回自己。**没有 PAT、没有 deploy key、没有任何凭据被存进任何仓库。**

**镜像仓的上游 CI 已关**：`jingjiangze/jellyfin-mpv-shim` 里上游自带的 `build` workflow 被手动禁用（状态 `disabled_manually`）。否则每次同步推送都会跑一遍上游的矩阵 CI——镜像仓没有那些 secrets，纯属烧 runner。要恢复：`gh workflow enable build --repo jingjiangze/jellyfin-mpv-shim`。

手动触发 / 自查：

```bash
gh workflow run sync-upstream.yml --repo jingjiangze/jellyfin-mpv-shim --ref master
gh workflow run sync-upstream.yml --repo jingjiangze/mpv_PlayKit --ref main
gh run list --repo jingjiangze/jellyfin-mpv-shim --limit 3
```

> 别往 fork 里再塞别的东西——多一个文件都会让「与上游的差异 = 1 个 workflow」这个前提失效。本项目自己的改动一律放 `jingjiangze/jellyfin-mpv-shim-mpv-lazy`。

## 2. 自动巡检（`.github/workflows/upstream-watch.yml`）

每天 05:17（Asia/Shanghai）跑一次，做三件事：

1. 读两个上游的 latest release tag；
2. 抓 `jellyfin-mpv-shim@master` 的 `mpv_options.py`，统计 `mpv_ext_no_ovr` 出现次数——这个符号是模式 A 的前提，**消失即代表上游可能改了注入逻辑**；
3. 与 `state/upstream.json` 对比：
   - 有变化 → 更新 `state/upstream.json` 并提交，同时开一个带 `upstream` 标签的 issue（已有未关闭的同类 issue 时不重复开）；
   - 无变化 → 什么都不做。

手动触发：

```bash
gh workflow run upstream-watch
gh run list --workflow=upstream-watch --limit 3
```

## 3. 上游变了要复核什么

拿到 issue 之后按这个清单走一遍，别只看版本号：

- [ ] `mpv_options.py` 里 `--config-dir` 的注入条件是否仍是 `not (mpv_ext and mpv_ext_no_ovr)`
- [ ] `player.py` 首启是否仍创建**空**的 `mpv.conf` / `input.conf`（这是「配置被丢掉」的直接原因）
- [ ] libmpv 模式有没有新增「自定义 dll 路径」的开关——如果有，模式 B 的配置镜像就能简化
- [ ] 跑 `player_mode.py b` 播一集，日志里应出现 `Using libmpv playback backend.` 与 `VO: [gpu-next]`
- [ ] 同步两个 fork

## 4. 发布

推一个 `v*` tag 就会触发 `.github/workflows/release.yml`：在 runner 上做语法检查、打包 zip（含 `player_mode.py`、两个 `.cmd`、README、LICENSE、docs）、创建 GitHub Release 并挂上产物。

```bash
git tag v1.0.0
git push origin v1.0.0
```

也可以手动触发并指定 tag：

```bash
gh workflow run release -f tag=v1.0.1
```

`.cmd` 的 CRLF 由 `.gitattributes`（`*.cmd text eol=crlf`）保证，打包前 `scripts/check_crlf.py` 会再断言一次，防止发布出 LF-only 的批处理文件。
