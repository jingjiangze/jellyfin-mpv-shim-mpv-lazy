#!/usr/bin/env python3
"""把整份分集磁力索引切成 16 片 + 一份清单，供站点按需只拉当前片名那一片。

为什么分片：整份已经 7.5MB，手机上第一次点开任意卡片就要下完。
分片后清单几百字节、单份约 500KB。

产物（相对 media/）：
  eps/index.json    {"v":2,"shards":16,"count":N}
  eps/s00..s15.json { "<id>": {"n": 片名, "eps": {...}} }

关键约束：分片号必须与浏览器端（tpl/magnet-eps.js 的 shardOf）**逐字符一致**，
否则算出的片号对不上、永远查不到。两边都是：
     h = 0;  for ch in 片名.strip(): h = (h*31 + ord(ch)) % 2**32;  shard = h % 16
Python 的 str 迭代与 JS 的 codePointAt 都按 Unicode 码点，非 BMP 字符也一致。
改这里必须同时改 magnet-eps.js，并用 src/test_shard_parity.py 对拍。

用法：python shard_eps.py --src eps.json --out-dir eps/
"""
import argparse
import json
import pathlib
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def shard_of(title, n=16):
    h = 0
    for ch in str(title or "").strip():
        h = (h * 31 + ord(ch)) % 4294967296
    return h % n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="整份索引（含空条目也可以，会被跳过）")
    ap.add_argument("--out-dir", required=True, help="输出目录，例如 media/eps")
    ap.add_argument("--shards", type=int, default=16)
    a = ap.parse_args()

    full = json.loads(pathlib.Path(a.src).read_text(encoding="utf-8"))
    out = pathlib.Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    # 清掉上次的旧分片，避免片数变化后残留
    for old in out.glob("s[0-9][0-9].json"):
        old.unlink()

    buckets = [{} for _ in range(a.shards)]
    kept = skipped = 0
    for aid, rec in full.items():
        if not isinstance(rec, dict) or not (rec.get("eps") or {}):
            skipped += 1          # 空条目只用于 CI 的 resume 状态，不进浏览器载荷
            continue
        buckets[shard_of(rec.get("n"))][aid] = rec
        kept += 1

    for i, b in enumerate(buckets):
        (out / f"s{i:02d}.json").write_text(
            json.dumps(b, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    manifest = {"v": 2, "shards": a.shards, "count": kept}
    (out / "index.json").write_text(
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    sizes = [(out / f"s{i:02d}.json").stat().st_size for i in range(a.shards)]
    print(f"写入 {out}/index.json  {manifest}")
    print(f"分片 {a.shards} 个，条目 {kept}（跳过空条目 {skipped}）")
    print(f"单片 {min(sizes)/1024:.0f}–{max(sizes)/1024:.0f} KB，合计 {sum(sizes)/1048576:.1f} MB")


if __name__ == "__main__":
    main()
