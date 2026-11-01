import base64, glob, json, os, pathlib, time, urllib.error, urllib.request

REPO = "jingjiangze/jellyfin-mpv-shim-mpv-lazy"
BR = "main"
TOK = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""
API = "https://api.github.com"

base = {}
p = pathlib.Path("media/magnet-eps.json")
if p.is_file():
    base = json.loads(p.read_text(encoding="utf-8"))
before = len(base)
# 合并规则：空结果（eps 为空，来自 --mark-miss 的「查过但没结果」）不能覆盖
# 已有的非空结果 —— 否则每一轮抓空的分片都会把上一轮建好的分集磁力抹掉
# （实测：1,420 部 → 1,154 部，丢了 266 部）。
empty_over = 0
for f in sorted(glob.glob("eps/*/magnet-eps.json")):
    try:
        part = json.loads(pathlib.Path(f).read_text(encoding="utf-8"))
    except (ValueError, OSError) as e:
        print("skip", f, e)
        continue
    for k, v in part.items():
        old = base.get(k)
        if old and (old.get("eps") or {}) and not ((v or {}).get("eps") or {}):
            empty_over += 1
            continue
        base[k] = v
if empty_over:
    print(f"跳过 {empty_over} 条「空覆盖非空」")
raw = json.dumps(base, ensure_ascii=False, separators=(",", ":"))
# 整份只留在 data/，作为 CI 的 resume 状态（含 mark-miss 的空条目）。
q = pathlib.Path("site-src/data/magnet-eps.json"); q.parent.mkdir(parents=True, exist_ok=True)
q.write_text(raw, encoding="utf-8")
eps = sum(len(v.get("eps") or {}) for v in base.values())
print(f"merged: {before} -> {len(base)} 部 / {eps} 个分集磁力", flush=True)

# 浏览器载荷走分片：整份 7.5MB 手机上首次点开卡片就要下完，太重。
# 分片号算法必须与 tpl/magnet-eps.js 的 shardOf 一致，见 site-src/shard_eps.py。
SHARDS = 16


def shard_of(title, n=SHARDS):
    h = 0
    for ch in str(title or "").strip():
        h = (h * 31 + ord(ch)) % 4294967296
    return h % n


buckets = [{} for _ in range(SHARDS)]
skipped = 0
for aid, rec in base.items():
    if not isinstance(rec, dict) or not (rec.get("eps") or {}):
        skipped += 1
        continue
    buckets[shard_of(rec.get("n"))][aid] = rec
outdir = pathlib.Path("media/eps"); outdir.mkdir(parents=True, exist_ok=True)
for f in outdir.glob("s[0-9][0-9].json"):
    f.unlink()
for i, b in enumerate(buckets):
    (outdir / f"s{i:02d}.json").write_text(
        json.dumps(b, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
(outdir / "index.json").write_text(
    json.dumps({"v": 2, "shards": SHARDS, "count": len(base) - skipped},
               ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print(f"shards: {SHARDS} 片，条目 {len(base) - skipped}（空条目 {skipped} 不入载荷）", flush=True)

if not TOK:
    print("无 GH_TOKEN，跳过推送"); raise SystemExit(0)


def call(method, path, payload=None):
    for i in range(5):
        req = urllib.request.Request(
            API + path, method=method,
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={"authorization": "Bearer " + TOK, "accept": "application/vnd.github+json",
                     "x-github-api-version": "2022-11-28", "user-agent": "magnet-pusher",
                     "content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                return json.loads(r.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            print(f"[gh] {method} {path} -> {e.code} {e.read().decode('utf-8','replace')[:200]}", flush=True)
            if e.code in (409, 422, 500, 502, 503) and i < 4:
                time.sleep(1.5 * (i + 1)); continue
            raise SystemExit(1)
    raise SystemExit(1)


DELETES = []


def push_once(files, msg):
    ref = call("GET", f"/repos/{REPO}/git/ref/heads/{BR}")
    parent = ref["object"]["sha"]
    base_tree = call("GET", f"/repos/{REPO}/git/commits/{parent}")["tree"]["sha"]
    entries = []
    for f in files:
        b = pathlib.Path(f).read_bytes()
        blob = call("POST", f"/repos/{REPO}/git/blobs",
                    {"content": base64.b64encode(b).decode(), "encoding": "base64"})
        print(f"[gh] blob {f} {len(b)}B {blob.get('sha','')[:8]}", flush=True)
        entries.append({"path": f, "mode": "100644", "type": "blob", "sha": blob["sha"]})
    for f in DELETES:
        entries.append({"path": f, "mode": "100644", "type": "blob", "sha": None})
    for f in files:
        assert "\\" not in f, f"路径里出现反斜杠，Git 树会建错：{f}"
    tree = call("POST", f"/repos/{REPO}/git/trees", {"base_tree": base_tree, "tree": entries})
    commit = call("POST", f"/repos/{REPO}/git/commits",
                  {"message": msg, "tree": tree["sha"], "parents": [parent]})
    try:
        out = call("PATCH", f"/repos/{REPO}/git/refs/heads/{BR}", {"sha": commit["sha"], "force": False})
        print("PUSHED", out["object"]["sha"][:8], flush=True)
        return True
    except SystemExit:
        # ref 在 get→patch 之间被别的 workflow 推进了，整段重来（重取 parent）
        print("[gh] ref moved, retry whole commit", flush=True)
        return False


# 必须用 POSIX 分隔符：Windows 上 str(Path) 会给成 "media\eps\s00.json"，
# Git Data API 会把它当成根目录下名字里带反斜杠的单文件（实测推上去 17 个
# 名字里含 "\" 的文件、真正的 media/eps/ 目录根本不存在）。
files = sorted(p.as_posix() for p in pathlib.Path("media/eps").glob("*.json"))
files.append("site-src/data/magnet-eps.json")
# 旧的整份 monolith 从仓库里删掉：浏览器已改读分片，留着等于每轮多推 7.5MB
DELETES = ["media/magnet-eps.json"]
msg = f"magnet-eps: index {len(base)} titles [skip ci]"
for attempt in range(4):
    if push_once(files, msg):
        break
    time.sleep(3)
else:
    raise SystemExit(1)
