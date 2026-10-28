#!/usr/bin/env python3
"""Fail if any shipped .cmd is not CRLF - cmd.exe mis-parses LF-only batch files."""
import pathlib
import sys


def main(directory):
    bad = []
    for path in pathlib.Path(directory).glob("*.cmd"):
        data = path.read_bytes()
        lf_only = data.count(b"\n") - data.count(b"\r\n")
        crlf = data.count(b"\r\n")
        print(f"{path.name}: crlf={crlf} lf_only={lf_only}")
        if lf_only or not crlf:
            bad.append(path.name)
    if bad:
        print(f"FAIL: not CRLF -> {bad}")
        return 1
    print("OK: all .cmd files are CRLF")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "."))
