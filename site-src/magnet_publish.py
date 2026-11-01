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
for f in sorted(glob.glob("eps/*/magnet-eps.json")):
    try:
        base.update(json.loads(pathlib.Path(f).read_text(encoding="utf-8")))
    except (ValueError, OSError) as e:
        print("skip", f, e)
raw = json.dumps(base, ensure_ascii=False, separators=(",", ":"))
for out in ("media/magnet-eps.json", "site-src/data/magnet-eps.json"):
    q = pathlib.Path(out); q.parent.mkdir(parents=True, exist_ok=True)
    q.write_text(raw, encoding="utf-8")
eps = sum(len(v.get("eps") or {}) for v in base.values())
print(f"merged: {before} -> {len(base)} 部 / {eps} 个分集磁力", flush=True)

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


files = [f for f in ("media/magnet-eps.json", "site-src/data/magnet-eps.json") if pathlib.Path(f).is_file()]
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
tree = call("POST", f"/repos/{REPO}/git/trees", {"base_tree": base_tree, "tree": entries})
commit = call("POST", f"/repos/{REPO}/git/commits",
              {"message": f"magnet-eps: index {len(base)} titles [skip ci]",
               "tree": tree["sha"], "parents": [parent]})
out = call("PATCH", f"/repos/{REPO}/git/refs/heads/{BR}", {"sha": commit["sha"], "force": False})
print("PUSHED", out["object"]["sha"][:8], flush=True)
