# 根因取证：shim 为什么让 mpv-lazy 失效

> 环境：Windows 11 / jellyfin-mpv-shim 3.3.0（PyInstaller 冻结版）/ mpv-lazy（mpv_PlayKit，`mpv.exe` 75 MB）/ Jellyfin 12.2
> 所有证据都是本机只读取得；上游行号指向 jellyfin-mpv-shim `v3.3.0` 源码。

## 1. 现象

用户主观感受：「播放用的不是我指定的那个播放器」。但进程路径检查显示**就是**指定的那个二进制。

```
$ Get-CimInstance Win32_Process -Filter "Name='mpv.exe'" | Select ProcessId,ExecutablePath
ProcessId Name    ExecutablePath
  19936  mpv.exe C:\…\mpv-lazy\mpv.exe
```

shim 自己的日志也确认走的是外部后端、没有回退：

```
2026-10-28 11:41:27,585 [ INFO] player: Using external mpv playback backend.
2026-10-28 11:41:27,649 [DEBUG] mpv-jsonipc: Staring MPV from C:\…\mpv-lazy\mpv.exe.
2026-10-28 11:41:28,268 [DEBUG] mpv-jsonipc: Found MPV socket.
```

所以问题不在「哪个 exe」，而在「这个 exe 读了什么配置」。

## 2. 第一条证据：命令行里被塞了 `--config-dir`

```
$ Get-CimInstance Win32_Process -Filter "Name='mpv.exe'" | Select -Expand CommandLine
C:\…\mpv-lazy\mpv.exe --input-default-bindings=yes --input-vo-keyboard=yes …
  --osc=no --script=…\mouse.lua --script=…\thumbfast.lua --audio-display=no
  --title=… --geometry=1280x752 --auto-window-resize=no --force-window=yes
  --idle=yes --input-ipc-server=mpv…  --input-terminal=no --terminal=no
```

注意：**没有** `--config-dir` 的这一次是修复后的状态。修复前 shim 会额外附加
`--config=yes --config-dir=%APPDATA%\jellyfin-mpv-shim`。

上游出处 `jellyfin_mpv_shim/mpv_options.py:644-650`：

```python
if not (settings.mpv_ext and settings.mpv_ext_no_ovr):
    mpv_options["config"] = True
    mpv_options["config_dir"] = conffile.confdir(APP_NAME)
```

`conffile.py:20-22` 把 `confdir(APP_NAME)` 解析成 `%APPDATA%\<APP_NAME>`。

## 3. 第二条证据：那个目录是空的

```
$ ls -l %APPDATA%\jellyfin-mpv-shim
mpv.conf     0
input.conf   0
scripts/     (空)
fonts/       (空)
themes/      (空)
```

这些空文件是 shim 首次初始化时自建的（`player.py:1168-1171`：

```python
conffile.get_dir(APP_NAME, "scripts")
conffile.get_dir(APP_NAME, "fonts")
conffile.get(APP_NAME, "input.conf", True)
conffile.get(APP_NAME, "mpv.conf", True)
```

`conffile.get(..., create=True)` 只做 `open(path,"w").close()`，从不写默认内容。）

## 4. 第三条证据：mpv 的 `-v` 日志直接对上

带 shim 的参数时：

```
[cplayer] Reading config file C:\…\jellyfin-mpv-shim/mpv.conf
[input]    Input config file C:\…\jellyfin-mpv-shim/input.conf parsed: 0 binds
```

**0 binds** —— 一个键位都没加载。

去掉该参数、让它自己找配置时：

```
[cplayer] Reading config file C:/…/mpv-lazy/portable_config/mpv.conf
[cplayer] Setting option 'input-conf' = '~~/input_uosc.conf'
[cplayer] Setting option 'include' = '~~/profiles.conf'
[cplayer] Reading config file C:/…/mpv-lazy/portable_config/profiles.conf
[cplayer] Setting option 'vo' = 'gpu-next'
[cplayer] Setting option 'hwdec' = 'auto-copy'
[cplayer] Setting option 'input-builtin-bindings' = 'no'
```

mpv 官方手册（`DOCS/man/mpv.rst`）对 portable 模式的描述：

> If a directory named `portable_config` next to the mpv.exe exists, all config
> will be loaded from this directory only.

所以只要不注入 `--config-dir`，`mpv.exe` 旁边的 `portable_config/` 就会被自动采用。

## 5. 运行时复核（不依赖日志）

连 mpv 的 JSON IPC 问属性：

```
vo                     = [{"name": "gpu-next"}]
hwdec                  = ["auto-copy"]
input-builtin-bindings = false
osc                    = false
```

`vo` 与 `input-builtin-bindings` 这两项 **shim 从不设置**，只有 mpv-lazy 的
`mpv.conf` 会给。两者同时生效 ⇒ 配置确实来自 mpv-lazy。

附带的客观副产物也印证 mpv-lazy 的 Lua 脚本在跑：

- `portable_config/saved-props.json` 的 mtime 在退出后从 `2026-10-20` 变成当天
- `portable_config/_cache/watch_later/` 条目数 27 → 33

## 6. 内嵌（libmpv）模式的额外约束

`mpv_ext=false` 时 shim 走 `import mpv`（`player.py:75-79`），用打包的
`_internal\mpv-2.dll` 渲染，但 **`config_dir` 的注入条件不受 `mpv_ext` 影响**：

```python
if not (settings.mpv_ext and settings.mpv_ext_no_ovr):   # mpv_ext=False 时恒为真
```

所以内嵌模式吃不到 mpv-lazy 的配置，除非把配置镜像进 shim 配置目录（本仓库的做法）。
另外 libmpv 的查找只走 `%PATH%` 里的 `mpv-2.dll` / `libmpv-2.dll` / `mpv-1.dll`
（python-mpv），**shim 没有提供任何「自定义 libmpv 路径」的配置项或环境变量**，
所以内嵌模式用不了 mpv-lazy 的 `mpv.exe` 构建（它本身也不带 libmpv 动态库）。
