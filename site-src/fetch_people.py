#!/usr/bin/env python3
"""补「角色 / 制作人员 / 收藏统计」到详情分片。

数据源（Bangumi v0）：
  GET /v0/subjects/{id}/characters?limit=12  → [{name, relation, images:{grid}}]
  GET /v0/subjects/{id}/persons?limit=10     → [{name, relation}]
  GET /v0/subjects/{id}                      → collection{wish,doing,collect,on_hold,dropped}

写回分片的三个短字段（控制体积）：
  ch: [[名, 关系, 头像URL], ...]   最多 10
  st: [[名, 关系], ...]            最多 8
  co: [想看, 在看, 看过]           三个整数

头像镜像：lain.bgm.tv 在国内不可达，ch[i][2] 是它的绝对 URL 时一律镜像到
site/posters/ch-<id>-<i>.jpg（CI 的 Sync posters to ModelScope 会顺带上云），
分片里改写成本仓库裸名；下载失败保留原 URL（前端 onerror 会露出首字），下轮继续重试。
该步骤与 ch/st/co 抓取独立，自身也最多补 AVATAR_MAX 部作品。开工前先探一次来源
可达性，来源不可达或连续失败即整批跳过——不能让慢源把这一步拖到超时。

用法：PEOPLE_MAX=1500 python fetch_people.py
      AVATAR_MAX=200 python fetch_people.py --avatars-only   # 只镜像头像
每轮只补 PEOPLE_MAX 条，已有 ch 的跳过，多轮收敛。
"""
import concurrent.futures as cf
import json
import os
import pathlib
import sys
import time
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = pathlib.Path(__file__).resolve().parent
SHARDS = BASE / "site" / "anime"
API = "https://api.bgm.tv/v0/subjects/%s"
UA = "anime-site/1.0 (+https://github.com/jingjiangze)"
LIMIT = int(os.environ.get("PEOPLE_MAX", "1500") or 1500)
WORKERS = int(os.environ.get("PEOPLE_WORKERS", "3") or 3)
SLEEP = float(os.environ.get("PEOPLE_SLEEP", "0.25") or 0.25)

POSTERS = BASE / "site" / "posters"
AVATAR_MAX = int(os.environ.get("AVATAR_MAX", "200") or 200)          # 本轮最多处理多少部作品
AVATAR_WORKERS = int(os.environ.get("AVATAR_WORKERS", "6") or 6)
AVATAR_PER = 6            # 每条记录最多处理前 6 个角色
AVATAR_MIN = 800          # < 这个字节数的响应视为坏图（占位图 / 报错页）
AVATAR_TIMEOUT = 8        # 单张下载上限（runner 上 lain 也慢，不能等 20s）
AVATAR_RETRIES = 0        # 不重试：失败留给下一轮，别把整步拖死
AVATAR_PROBE_TIMEOUT = 6  # 开工前探一次来源可达性的上限
AVATAR_STREAK_FAIL = 5    # 连续失败达到这个数就停止派发新任务
# 零下载成功 + 失败数达到这个量，判定为网络整体不可达（而不是零星 404），放弃本轮改写
AVATAR_ABORT_FAIL = int(os.environ.get("AVATAR_ABORT_FAIL", "3") or 3)
IMG_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36"


def get(path, timeout=20, retries=2):
    req = urllib.request.Request(API % path, headers={"user-agent": UA, "accept": "application/json"})
    last = None
    for i in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8", "replace"))
        except Exception as e:
            last = e
            if i < retries:
                time.sleep(1.0 * (i + 1))
    raise last


def grid(images):
    if not isinstance(images, dict):
        return ""
    return images.get("grid") or images.get("medium") or images.get("small") or ""


def build(sid):
    """返回 (ch, st, co) 或 ('err:xxx',)。"""
    try:
        chs = get("%s/characters?limit=12" % sid)
    except Exception as e:
        return "err:" + type(e).__name__
    time.sleep(SLEEP)
    try:
        sts = get("%s/persons?limit=10" % sid)
    except Exception:
        sts = []
    time.sleep(SLEEP)
    try:
        sub = get(str(sid))
    except Exception:
        sub = {}

    ch = []
    for c in (chs or [])[:10]:
        n = str(c.get("name") or "").strip()
        if not n:
            continue
        ch.append([n[:20], str(c.get("relation") or "")[:12], grid(c.get("images"))[:120]])
    st = []
    for p in (sts or [])[:8]:
        n = str(p.get("name") or "").strip()
        if not n:
            continue
        st.append([n[:20], str(p.get("relation") or "")[:12]])
    col = (sub or {}).get("collection") or {}
    co = [int(col.get("wish") or 0), int(col.get("doing") or 0), int(col.get("collect") or 0)]
    if not ch and not st and not any(co):
        return None
    return (ch, st, co)


def download_img(url, timeout=AVATAR_TIMEOUT, retries=AVATAR_RETRIES):
    """下载一张图，返回 bytes；content-type 不是 image/* 也当失败。"""
    req = urllib.request.Request(url, headers={"user-agent": IMG_UA, "accept": "image/*"})
    last = None
    for i in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                ctype = (r.headers.get("content-type") or "").lower()
                data = r.read()
            if ctype and not ctype.startswith("image/"):
                raise ValueError("content-type " + ctype.split(";")[0])
            return data
        except Exception as e:
            last = e
            if i < retries:
                time.sleep(1.0)
    raise last


def avatar_jobs(rec):
    """单条记录待镜像的头像：[(下标, URL), ...]。已是 ch- 裸名或空串的跳过。"""
    ch = rec.get("ch")
    if not isinstance(ch, list):
        return []
    out = []
    for i, c in enumerate(ch[:AVATAR_PER]):
        if not isinstance(c, list) or len(c) < 3 or not isinstance(c[2], str):
            continue
        u = c[2].strip()
        if not u or u.startswith("ch-"):
            continue
        if u.startswith("http://") or u.startswith("https://"):
            out.append((i, u))
    return out


def mirror_avatar(sid, i, url, posters):
    """返回 'reuse' / 'dl' / 'fail'。已有够大的同名文件直接复用，绝不写坏图。"""
    dst = posters / f"ch-{sid}-{i}.jpg"
    try:
        if dst.is_file() and dst.stat().st_size >= AVATAR_MIN:
            return "reuse"
    except OSError:
        pass
    try:
        data = download_img(url)
    except Exception as e:
        print(f"! 头像 {sid}-{i} {type(e).__name__}: {e}", flush=True)
        return "fail"
    if len(data) < AVATAR_MIN:
        return "fail"
    posters.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(data)
    return "dl"


def avatars_only(shards=None, posters=None, limit=None, workers=None):
    """把分片里 lain.bgm.tv 的头像 URL 镜像成 site/posters/ch-<id>-<i>.jpg。

    与 ch/st/co 抓取完全独立：镜像成功就把 ch[i][2] 改写成分片内裸名
    ch-<id>-<i>.jpg（前端按 ANI.poster 拼 CDN 地址）；下载失败保留原 URL 不动
    （前端 onerror 会露出首字圆），下轮继续重试。

    防拖死：开工前拿第一个 URL 探一次（6s、不重试），探不通直接整批跳过；
    运行中连续 AVATAR_STREAK_FAIL 次失败也停止派发新任务、本轮不写回。
    """
    shards = pathlib.Path(shards) if shards else SHARDS
    posters = pathlib.Path(posters) if posters else POSTERS
    limit = AVATAR_MAX if limit is None else int(limit)
    workers = AVATAR_WORKERS if workers is None else int(workers)
    if not shards.is_dir():
        print("! 找不到分片目录", shards)
        return 1

    files, tasks = {}, []
    for p in sorted(shards.glob("*.json")):
        try:
            recs = json.loads(p.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            continue
        if not isinstance(recs, list):
            continue
        files[p] = recs
        for rec in recs:
            if not isinstance(rec, dict) or not rec.get("id"):
                continue
            jobs = avatar_jobs(rec)
            if jobs:
                tasks.append((rec["id"], jobs, p, rec))
    if not tasks:
        print("头像：titles=0 dl=0 reuse=0 fail=0")
        return 0
    work = tasks[:max(0, limit)]
    print(f"头像待办 {len(work)} 部（上限 {limit}，并发 {max(1, workers)}）", flush=True)

    # 预检：拿第一个待办 URL 探一次。慢了/挂了就整批跳过，一张都不下载。
    try:
        download_img(work[0][1][0][1], timeout=AVATAR_PROBE_TIMEOUT, retries=0)
    except Exception as e:
        print(f"! 头像探测失败 {type(e).__name__}: {e}", flush=True)
        print("! 头像源不可达，本轮跳过", flush=True)
        return 0
    posters.mkdir(parents=True, exist_ok=True)

    stat = {"dl": 0, "reuse": 0, "fail": 0}
    results, streak, aborted = [], 0, False

    def run(task):
        sid, jobs = task[0], task[1]
        return sid, [(i, mirror_avatar(sid, i, u, posters)) for i, u in jobs]

    # 手写派发而不是 ex.map：ex.map 会一次性提交全部任务，连续失败时来不及收手。
    pool = max(1, workers)
    pending = iter(work)
    inflight = {}
    with cf.ThreadPoolExecutor(max_workers=pool) as ex:
        def pump():
            while not aborted and len(inflight) < pool:
                try:
                    task = next(pending)
                except StopIteration:
                    return
                inflight[ex.submit(run, task)] = task

        pump()
        while inflight:
            done, _ = cf.wait(inflight, return_when=cf.FIRST_COMPLETED)
            for fut in done:
                task = inflight.pop(fut)
                sid, res = fut.result()
                results.append((task, res))
                for _i, r in res:
                    stat[r] = stat.get(r, 0) + 1
                    if r == "fail":
                        streak += 1
                        if streak >= AVATAR_STREAK_FAIL:
                            aborted = True
                    else:
                        streak = 0
            pump()   # aborted 后 pump() 立即返回：已派发的跑完，不再派新的

    line = f"头像：titles={len(results)} dl={stat['dl']} reuse={stat['reuse']} fail={stat['fail']}"
    if aborted:
        # 连续失败 → 多半是源不可达/被限流：停派新任务，本轮不写回（原 URL 全保留）
        print(f"! 连续 {AVATAR_STREAK_FAIL} 次头像下载失败，停止派发新任务，本轮跳过", flush=True)
        print(line, flush=True)
        return 0
    if stat["fail"] >= AVATAR_ABORT_FAIL and not stat["dl"]:
        # 一张都没下载成功且失败成片（本机/盒子上 lain.bgm.tv 不可达）→ 视为网络级
        # 故障：整体跳过写回，原 URL 全部保留，下轮重试，不把好数据清空。
        print(f"! 本轮 {stat['fail']} 个头像全部下载失败，疑似网络不可达，保留原 URL 不写回", flush=True)
        print(line, flush=True)
        return 0

    touched = set()
    for (sid, _jobs, p, rec), res in results:
        for i, r in res:
            if r == "fail":      # 失败保留原 http URL，下轮还能重试（前端 onerror 露首字）
                continue
            rec["ch"][i][2] = f"ch-{sid}-{i}.jpg"
            touched.add(p)

    changed = 0
    for p in sorted(touched):
        p.write_text(json.dumps(files[p], ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        changed += 1
    print(line, flush=True)
    print(f"改写分片 {changed} 个", flush=True)
    return 0


def fill_people():
    if not SHARDS.is_dir():
        print("! 找不到分片目录", SHARDS)
        return 1
    files, todo = {}, []
    for p in sorted(SHARDS.glob("*.json")):
        try:
            recs = json.loads(p.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            continue
        if not isinstance(recs, list):
            continue
        files[p] = recs
        for rec in recs:
            if isinstance(rec, dict) and rec.get("id") and not rec.get("ch"):
                todo.append(rec["id"])
    if not todo:
        print("全部已有角色数据")
        return 0
    todo = todo[:LIMIT]
    print(f"待补 {len(todo)} 条（上限 {LIMIT}，并发 {WORKERS}）", flush=True)

    got, stat = {}, {}

    def work(sid):
        time.sleep(SLEEP)
        r = build(sid)
        return sid, r

    with cf.ThreadPoolExecutor(max_workers=max(1, WORKERS)) as ex:
        for i, (sid, r) in enumerate(ex.map(work, todo), 1):
            key = "ok" if isinstance(r, tuple) else ("none" if r is None else str(r))
            stat[key] = stat.get(key, 0) + 1
            if isinstance(r, tuple):
                got[sid] = r
            if i % 100 == 0:
                print(f"  {i}/{len(todo)} {stat}", flush=True)

    changed = 0
    for p, recs in files.items():
        hit = False
        for rec in recs:
            if not isinstance(rec, dict):
                continue
            r = got.get(rec.get("id"))
            if not r:
                continue
            ch, st, co = r
            rec["ch"], rec["st"], rec["co"] = ch, st, co
            hit = True
        if hit:
            p.write_text(json.dumps(recs, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            changed += 1
    print(f"完成：{stat}；改写分片 {changed} 个")
    return 0


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--avatars-only" in argv:
        return avatars_only()
    rc = fill_people()
    if rc:
        return rc
    avatars_only()
    return 0


if __name__ == "__main__":
    sys.exit(main())
