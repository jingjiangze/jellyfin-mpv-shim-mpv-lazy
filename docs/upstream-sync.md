# 上游同步链路

本项目建立在两条上游之上，两者的行为都可能让这里的结论失效：

| 上游 | 作用 | 关心的东西 |
|---|---|---|
| [jellyfin/jellyfin-mpv-shim](https://github.com/jellyfin/jellyfin-mpv-shim) | 播放器前端 | `mpv_options.py` 里 `--config-dir` 的注入条件、`player.py` 首启建空配置、libmpv 加载方式 |
| [hooke007/mpv_PlayKit](https://github.com/hooke007/mpv_PlayKit) | mpv-lazy 配置集 | `portable_config/mpv.conf` 的 `~~/` 引用、`scripts/` 与 `shaders/` 结构 |

## 1. 只读镜像 fork

两个上游都已 fork 到本账号，**保持 pristine（不提交任何东西）**，这样随时能一键快进：

- https://github.com/jingjiangze/jellyfin-mpv-shim
- https://github.com/jingjiangze/mpv_PlayKit

同步命令：

```bash
gh repo sync jingjiangze/jellyfin-mpv-shim --branch master
gh repo sync jingjiangze/mpv_PlayKit --branch main
```

或在网页上点 fork 页面的 **Sync fork → Update branch**。

> 不要往 fork 里提交改动。一旦提交就会和上游分叉，`--branch` 快进会失败，只能改为合并。
> 本项目自己的改动一律放在 `jingjiangze/jellyfin-mpv-shim-mpv-lazy`，不碰 fork。

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
