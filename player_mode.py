#!/usr/bin/env python3
"""Wire mpv-lazy (mpv_PlayKit) into jellyfin-mpv-shim.

Two playback backends are supported, switchable with one command:

  a  external mpv
     mpv_ext=true + mpv_ext_no_ovr=true
     The shim stops injecting --config/--config-dir, so mpv.exe discovers the
     portable_config directory sitting next to it and loads the full mpv-lazy
     set (uosc, menu.conf, shaders, hwdec presets).
     Trade-off: video plays in its own mpv window, and the shim keeps its own
     key bindings, so mpv-lazy on-screen controls fight with shim shortcuts.

  b  embedded libmpv (recommended)
     mpv_ext=false
     Video is rendered by the libmpv bundled with the shim (mpv-2.dll) inside
     the shim process - no second mpv.exe. libmpv always gets
     config_dir=<shim config dir>, so the mpv-lazy conf files are copied there
     and the heavy directories are junctioned back to the mpv-lazy install.
     osc_style=custom leaves the on-screen controls entirely to uosc.

Why any of this is necessary
----------------------------
jellyfin-mpv-shim >= 3.x always launches the external player with
--config=yes --config-dir=%APPDATA%\\jellyfin-mpv-shim (mpv_options.py:644-650).
That directory only ever contains empty placeholder files, so a stock shim
silently throws away every mpv-lazy setting (vo=gpu-next, hwdec, uosc, shaders,
key bindings). See docs/root-cause.md for the full evidence trail.

Usage
-----
  python player_mode.py b                    # switch to embedded libmpv
  python player_mode.py a                    # switch to external mpv
  python player_mode.py status               # show the current mode
  python player_mode.py b --mpv-dir D:\\apps\\mpv-lazy
  MPV_LAZY_DIR=D:\\apps\\mpv-lazy python player_mode.py b

Restart the shim afterwards (or use the .cmd wrappers, which restart it).
"""

import argparse
import json
import os
import pathlib
import shutil
import subprocess
import sys

SHIM_APP = "jellyfin-mpv-shim"
SHIM_DIR = pathlib.Path(os.environ.get("APPDATA", "")) / SHIM_APP
SHIM_CONF = SHIM_DIR / "conf.json"

# conf files that are small enough to copy; ~~/ inside them resolves to the
# shim config dir, so the include chain stays intact after copying.
COPY_FILES = ["mpv.conf", "profiles.conf", "script-opts.conf", "input_uosc.conf", "menu.conf"]
# directories that are too big to copy; junction them instead
LINK_DIRS = ["scripts", "shaders", "fonts", "vs"]


def candidate_mpv_dirs():
    env = os.environ.get("MPV_LAZY_DIR")
    if env:
        yield pathlib.Path(env)
    for base in (os.environ.get("LOCALAPPDATA"), os.environ.get("USERPROFILE")):
        if base:
            yield pathlib.Path(base) / "mpv-lazy"
    yield pathlib.Path(r"C:\mpv-lazy")
    if os.environ.get("USERPROFILE"):
        yield pathlib.Path(os.environ["USERPROFILE"]) / "Downloads" / "mpv-lazy"


def resolve_mpv_dir(explicit=None):
    if explicit:
        path = pathlib.Path(explicit).expanduser()
        if not (path / "portable_config").is_dir():
            raise SystemExit(f"{path} does not contain portable_config/")
        return path
    for path in candidate_mpv_dirs():
        if (path / "portable_config").is_dir():
            return path
    raise SystemExit(
        "could not find an mpv-lazy install; pass --mpv-dir or set MPV_LAZY_DIR "
        "(directory must contain portable_config/)"
    )


def load_shim_conf():
    if not SHIM_CONF.is_file():
        raise SystemExit(f"{SHIM_CONF} not found - run jellyfin-mpv-shim once first")
    with open(SHIM_CONF, encoding="utf-8") as handle:
        return json.load(handle)


def save_shim_conf(conf):
    tmp = SHIM_CONF.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(conf, handle, indent=4, ensure_ascii=False)
        handle.write("\n")
    os.replace(tmp, SHIM_CONF)


def migrate_config(mpv_dir):
    """Mirror the mpv-lazy config into the shim config dir for the libmpv path."""
    portable = mpv_dir / "portable_config"
    for name in COPY_FILES:
        src = portable / name
        if not src.is_file():
            print(f"[skip] {name} not present in mpv-lazy")
            continue
        shutil.copy2(src, SHIM_DIR / name)
        print(f"[copy] {name} ({src.stat().st_size} bytes)")
    for name in LINK_DIRS:
        src = portable / name
        dst = SHIM_DIR / name
        if not src.is_dir():
            print(f"[skip] {name}/ not present in mpv-lazy")
            continue
        if dst.is_junction() or dst.is_symlink():
            print(f"[skip] {name}/ already linked")
            continue
        if dst.exists():
            try:
                if any(dst.iterdir()):
                    print(f"[skip] {name}/ exists and is not empty")
                    continue
                dst.rmdir()
            except OSError as exc:
                print(f"[skip] {name}/: {exc}")
                continue
        proc = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(dst), str(src)],
            capture_output=True, text=True, encoding="mbcs", errors="replace",
        )
        detail = (proc.stdout or "").strip() or (proc.stderr or "").strip()
        print(f"[link] {name}/ rc={proc.returncode} {detail}")


def apply_mode(mode, mpv_dir):
    conf = load_shim_conf()
    if mode == "a":
        conf["mpv_ext"] = True
        conf["mpv_ext_path"] = str(mpv_dir / "mpv.exe")
        conf["mpv_ext_no_ovr"] = True
        conf["mpv_ext_start"] = True
        conf["osc_style"] = "mpvtk"
    elif mode == "b":
        migrate_config(mpv_dir)
        conf["mpv_ext"] = False
        conf["mpv_ext_no_ovr"] = False
        conf["osc_style"] = "custom"
    else:
        raise SystemExit(f"unknown mode {mode!r}")
    # The shim passes --hwdec=<hwdec> on the command line, which outranks
    # mpv.conf; auto-copy keeps mpv-lazy's QCOM/Anime4K shader chain working.
    conf["hwdec"] = "auto-copy"
    save_shim_conf(conf)
    print(f"mode={mode} mpv_ext={conf['mpv_ext']} mpv_ext_no_ovr={conf['mpv_ext_no_ovr']} "
          f"osc_style={conf['osc_style']} hwdec={conf['hwdec']}")
    print("restart jellyfin-mpv-shim to apply")


def show_status():
    conf = load_shim_conf()
    mode = "b (embedded libmpv)" if not conf.get("mpv_ext") else "a (external mpv)"
    print(f"config dir : {SHIM_DIR}")
    print(f"mode       : {mode}")
    for key in ("mpv_ext", "mpv_ext_no_ovr", "mpv_ext_path", "osc_style", "hwdec"):
        print(f"{key:<14}: {conf.get(key)!r}")
    for name in LINK_DIRS:
        path = SHIM_DIR / name
        target = ""
        if path.is_junction() or path.is_symlink():
            target = f" -> {os.path.realpath(path)}"
        state = "linked" if target else ("dir" if path.is_dir() else "missing")
        print(f"{name + '/':<14}: {state}{target}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("mode", choices=["a", "b", "status"])
    parser.add_argument("--mpv-dir", help="mpv-lazy install directory (contains portable_config/)")
    args = parser.parse_args()

    if args.mode == "status":
        show_status()
        return
    apply_mode(args.mode, resolve_mpv_dir(args.mpv_dir))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
