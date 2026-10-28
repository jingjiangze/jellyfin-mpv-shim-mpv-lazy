# jellyfin-mpv-shim + mpv-lazy

让 [jellyfin-mpv-shim](https://github.com/jellyfin/jellyfin-mpv-shim) 真正吃上
[mpv-lazy / mpv_PlayKit](https://github.com/hooke007/mpv_PlayKit) 的 `portable_config`，
并提供 **外部 mpv** 与 **内嵌 libmpv** 两种播放后端的一键切换。

---

## 问题：shim 会把你的 mpv 配置整包丢掉

shim 3.x 拉起外部 mpv 时，强制注入下面两个参数（上游 `mpv_options.py:644-650`）：

```python
if not (settings.mpv_ext and settings.mpv_ext_no_ovr):
    mpv_options["config"] = True
    mpv_options["config_dir"] = conffile.confdir(APP_NAME)   # %APPDATA%\jellyfin-mpv-shim
```

这个目录里只有 shim 首启自建的空占位文件（`player.py:1168-1171`）：

```
mpv.conf     0 字节
input.conf   0 字节
scripts/    空    fonts/  空    themes/  空
```

于是 `mpv.exe` 虽然是 mpv-lazy 的那个二进制，跑的却是**空配置**：没有 uosc、
没有 `vo=gpu-next`、没有 `hwdec=auto-copy`、没有着色器、**一个键位都没有**。

实测对照（`mpv.exe -v` 日志）：

| 启动方式 | 实际读到的配置 | 关键值 |
|---|---|---|
| 带 `--config-dir=<shim 目录>` | `…\jellyfin-mpv-shim\mpv.conf`（空） | `input.conf parsed: 0 binds` |
| 不带该参数 | `…\mpv-lazy\portable_config\mpv.conf` | `vo=gpu-next`、`hwdec=auto-copy`、`input-builtin-bindings=no` |

---

## 两种模式

| | **模式 A：外部 mpv** | **模式 B：内嵌 libmpv**（推荐） |
|---|---|---|
| 后端 | 独立 `mpv.exe` 进程 | shim 自带的 `mpv-2.dll`，视频在 shim 进程内渲染 |
| 任务栏 | 多一个 mpv 窗口 | 只有一个窗口 |
| mpv-lazy 配置 | 直接读 `portable_config`，零改动 | 复制到 shim 配置目录 + 目录联接回 mpv-lazy |
| 控件 | shim 与 mpv-lazy 的键位/OSC 会互相干扰 | uosc 独占（`osc_style=custom`） |
| 适合 | 想要纯净的 mpv-lazy 播放器体验 | 想要「一个窗口看片 + 可调节」的媒体中心体验 |

## 用法

```bat
python player_mode.py b        :: 切到内嵌 libmpv（推荐）
python player_mode.py a        :: 切到外部 mpv
python player_mode.py status   :: 查看当前模式与目录联接状态
```

找不到 mpv-lazy 时显式指定：

```bat
python player_mode.py b --mpv-dir D:\apps\mpv-lazy
set MPV_LAZY_DIR=D:\apps\mpv-lazy && python player_mode.py b
```

Windows 上也可以直接双击 `player-mode-a.cmd` / `player-mode-b.cmd`，它们会先结束
`run.exe` / `mpv.exe` 再改配置，重启「媒体库」快捷方式后生效。

切换前建议备份 `%APPDATA%\jellyfin-mpv-shim\conf.json`。

## 前置条件

- Windows 10 / 11
- jellyfin-mpv-shim **3.3.0**（其他 3.x 行为一致，上游行号可能变动）
- mpv-lazy / mpv_PlayKit 懒人包，目录内包含 `portable_config/`
- Python 3.8+（只用标准库）

## 已验证环境与证据

jellyfin-mpv-shim 3.3.0 + mpv-lazy + Jellyfin 12.2（Windows 11）：

| 检查项 | 模式 A | 模式 B |
|---|---|---|
| 后端日志 | `Using external mpv playback backend.` + `Staring MPV from …\mpv.exe` | `Using libmpv playback backend.` |
| 进程 | 存在 `mpv.exe` | `mpv.exe` 计数 = **0** |
| 命令行 | **不含** `--config-dir` | — |
| 生效属性 | `vo=gpu-next`、`hwdec=auto-copy`、`input-builtin-bindings=false`（经 mpv JSON IPC 读取） | 日志 `VO: [gpu-next] 1920x1080 nv12` |
| mpv-lazy 脚本 | `saved-props.json` 退出时被重写、`_cache/watch_later/` 新增条目 | 日志出现 `save_global_props`、`uosc`、`input_plus`、`thumb_engine` |

`vo` 与 `input-builtin-bindings` 这两项 shim 命令行从不设置，只有 mpv-lazy 的
`mpv.conf` 会给，所以它们是「配置真的来自 mpv-lazy」的判据。

## 已知限制

- 内嵌模式用的是 shim 打包的 `mpv-2.dll`，与 mpv-lazy 的 `mpv.exe` **不是同一个构建**；
  mpv-lazy 配置里的冷门选项可能只报 `option not found` 告警。
- VapourSynth（MEMC 类滤镜）需要 `VSScript.dll` 可被加载；内嵌模式下它由 `run.exe`
  加载，通常找不到，VS 滤镜大概率不可用。
- `yt-dlp` 集成在内嵌模式下不生效（shim 自己处理流地址）。
- shim 仍会绑定少量按键（`q`、`<`、`>`、`c` 等）；若与 uosc 冲突，可在 shim 设置里改。
- 模式 A 下 shim 会传 `--osc=no` 并注入自己的键位，mpv-lazy 的屏上控件体验会被削弱。

## 工作原理（模式 B 的配置迁移）

libmpv 路径下 shim **同样**把 `config_dir` 钉在 `%APPDATA%\jellyfin-mpv-shim`
（`mpv_ext=false` 时 `mpv_ext_no_ovr` 不起作用，因为条件是 `not (mpv_ext and mpv_ext_no_ovr)`），
所以脚本把 mpv-lazy 的配置镜像过去：

- 复制：`mpv.conf`、`profiles.conf`、`script-opts.conf`、`input_uosc.conf`、`menu.conf`
  （这些文件里的 `~~/` 会解析到 shim 配置目录，include 链自然成立）
- 目录联接（`mklink /J`）：`scripts/`、`shaders/`、`fonts/`、`vs/`

## 卸载 / 回滚

1. `python player_mode.py a` 切回外部 mpv，或把备份的 `conf.json` 覆盖回去；
2. 可选：删除 `%APPDATA%\jellyfin-mpv-shim\` 下被复制进来的 `.conf` 与四个联接目录。

## 发布与上游同步

- **发布**：推 `v*` tag 触发 [`.github/workflows/release.yml`](.github/workflows/release.yml)，在 GitHub Actions 上做语法检查、打包 zip（脚本 + `.cmd` + README + LICENSE + docs）并创建 Release 并挂产物。
- **上游巡检**：[`.github/workflows/upstream-watch.yml`](.github/workflows/upstream-watch.yml) 每天 05:17 读 `jellyfin/jellyfin-mpv-shim` 与 `hooke007/mpv_PlayKit` 的 latest release，并抓 `mpv_options.py` 检查 `mpv_ext_no_ovr` 是否还在；有变化就更新 `state/upstream.json` 并开 issue。
- **自动镜像 fork**：[jingjiangze/jellyfin-mpv-shim](https://github.com/jingjiangze/jellyfin-mpv-shim)、[jingjiangze/mpv_PlayKit](https://github.com/jingjiangze/mpv_PlayKit)。每个 fork 只多一个 `.github/workflows/sync-upstream.yml`，每天 04:23 用 fork 自己的 `GITHUB_TOKEN` 做 `fetch 上游 → rebase → force-with-lease`，跑完仍是「上游 + 1 个文件」。细节与复核清单见 [docs/upstream-sync.md](docs/upstream-sync.md)。

## License

MIT
