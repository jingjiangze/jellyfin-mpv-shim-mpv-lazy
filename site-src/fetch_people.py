#!/usr/bin/env python3
"""补「角色 / 制作人员 / 收藏统计」到详情分片。

数据源（Bangumi v0）：
  GET /v0/subjects/{id}/characters?limit=12  → [{name, relation, images:{grid}}]
  GET /v0/subjects/{id}/persons?limit=10     → [{name, relation, images:{grid}}]
  GET /v0/subjects/{id}                      → collection{wish,doing,collect,on_hold,dropped}

写回分片的三个短字段（控制体积）：
  ch: [[名, 关系, 头像URL], ...]   最多 10
  st: [[名, 关系, 头像URL], ...]   最多 8
  co: [想看, 在看, 看过]           三个整数

头像镜像：lain.bgm.tv 在国内不可达，ch[i][2] / st[i][2] 是它的绝对 URL 时一律镜像到
site/posters/ch-<id>-<i>.jpg（角色）/ st-<id>-<i>.jpg（制作人）（CI 的 Sync posters to
ModelScope 会顺带上云），分片里改写成本仓库裸名；下载失败保留原 URL（前端 onerror 会
露出首字），下轮继续重试。同一次运行内按人名复用已下好的图（{人名: 裸文件名}），
同名角色/制作人不重复请求。
该步骤与 ch/st/co 抓取独立，自身也最多补 AVATAR_MAX 部作品。开工前先探一次来源
可达性，来源不可达或连续失败即整批跳过——不能让慢源把这一步拖到超时。

已知风险：头像文件名用数组下标（ch-<id>-<i>.jpg / st-<id>-<i>.jpg）而不是人物 id，
Bangumi 调整 characters/persons 的顺序或条数会让已镜像的文件错位；改成人物 id 会让
线上已镜像的文件（约 2,682 个）全部失效，权衡后维持现状。

用法：PEOPLE_MAX=3000 python fetch_people.py
      AVATAR_MAX=3000 python fetch_people.py --avatars-only  # 只镜像头像
      AVATAR_TIMEOUT=20 AVATAR_RETRIES=1 AVATAR_PER=3 ...    # runner 慢时放宽下载参数
每轮只补 PEOPLE_MAX 条，ch 已有且 st 每项 3 段的跳过，多轮收敛。
"""
import concurrent.futures as cf
import json
import os
import pathlib
import sys
import threading
import time
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def env_int(name, default):
    """读整数环境变量；缺失或非数字时回落到默认值。"""
    try:
        return int(os.environ.get(name, "") or default)
    except (TypeError, ValueError):
        return default


BASE = pathlib.Path(__file__).resolve().parent
SHARDS = BASE / "site" / "anime"
API = "https://api.bgm.tv/v0/subjects/%s"
UA = "anime-site/1.0 (+https://github.com/jingjiangze)"
LIMIT = env_int("PEOPLE_MAX", 3000)
WORKERS = env_int("PEOPLE_WORKERS", 3)
SLEEP = float(os.environ.get("PEOPLE_SLEEP", "0.25") or 0.25)

POSTERS = BASE / "site" / "posters"
AVATAR_MAX = env_int("AVATAR_MAX", 3000)         # 本轮最多处理多少部作品
AVATAR_WORKERS = env_int("AVATAR_WORKERS", 6)    # 并发下载数；单张有 AVATAR_TIMEOUT 兜底
AVATAR_PER = env_int("AVATAR_PER", 10)           # 每条记录最多处理前 10 个角色 / 制作人
AVATAR_MIN = 800          # < 这个字节数的响应视为坏图（占位图 / 报错页）
AVATAR_TIMEOUT = env_int("AVATAR_TIMEOUT", 8)    # 单张下载上限（runner 慢可由 workflow 放宽）
AVATAR_RETRIES = env_int("AVATAR_RETRIES", 0)    # 重试次数（默认 0，失败留给下一轮）
AVATAR_PROBE_TIMEOUT = 6  # 预检固定 6s 单次，不受上面两个环境变量影响
AVATAR_STREAK_FAIL = 5    # 连续失败达到这个数就停止派发新任务
# 零下载成功 + 失败数达到这个量，判定为网络整体不可达（而不是零星 404），放弃本轮改写
AVATAR_ABORT_FAIL = int(os.environ.get("AVATAR_ABORT_FAIL", "3") or 3)
# 制作人接口一律 4xx 视为「该作品没有制作人」。若本轮这类结果达到下面的量、且一条
# 制作人数据都没拿到，更像是 /persons 整体失效（路径变更 / 封禁），此时不写 st、下轮重试。
PERSONS_ABORT = env_int("PERSONS_ABORT", 20)
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


class PeopleError(Exception):
    """制作人接口暂时故障（超时 / 5xx / 限流）：本轮不写 st，下轮重试。"""


def persons_missing(e):
    """4xx（408 超时 / 429 限流除外）视为该作品本就没有制作人；其余当暂时故障。"""
    code = getattr(e, "code", None)
    return isinstance(code, int) and 400 <= code < 500 and code not in (408, 429)


def build(sid, people_only=False):
    """返回 (ch, st, co, st_state) / None / 'err:xxx'；st_state 为 'ok' 或 'nobody'。

    people_only=True 时只打 /persons，ch / co 返回 None（重抓老记录的 st 头像用）。

    制作人接口失败不再一律吞成 st=[]（旧版因此让该作品永久不再重试）：
      - 4xx（408/429 除外）= 该作品没有制作人 → st=[] + 'nobody'，正常写回、视为完成；
      - 其它（超时 / 5xx / 限流）= 暂时故障 → 抛 PeopleError，本轮不写 st，下轮重试。
    """
    ch = None
    if not people_only:
        try:
            chs = get("%s/characters?limit=12" % sid)
        except Exception as e:
            return "err:" + type(e).__name__
        time.sleep(SLEEP)
        ch = []
        for c in (chs or [])[:10]:
            n = str(c.get("name") or "").strip()
            if not n:
                continue
            ch.append([n[:20], str(c.get("relation") or "")[:12], grid(c.get("images"))[:120]])

    st_state = "ok"
    try:
        sts = get("%s/persons?limit=10" % sid)
    except Exception as e:
        if not persons_missing(e):
            raise PeopleError(f"{sid} 制作人接口 {type(e).__name__}") from e
        sts, st_state = [], "nobody"
    time.sleep(SLEEP)
    st = []
    for p in (sts or [])[:8]:
        n = str(p.get("name") or "").strip()
        if not n:
            continue
        st.append([n[:20], str(p.get("relation") or "")[:12], grid(p.get("images"))[:120]])

    co = None
    if not people_only:
        try:
            sub = get(str(sid))
        except Exception:
            sub = {}
        col = (sub or {}).get("collection") or {}
        co = [int(col.get("wish") or 0), int(col.get("doing") or 0), int(col.get("collect") or 0)]
        if not ch and not st and not any(co):
            return None
    return (ch, st, co, st_state)


def download_img(url, timeout=AVATAR_TIMEOUT, retries=AVATAR_RETRIES):
    """下载一张图，返回 bytes；content-type 不是 image/* 也当失败。"""
    req = urllib.request.Request(url, headers={
        "user-agent": IMG_UA,
        "referer": "https://bgm.tv/",
        "accept": "image/avif,image/webp,image/*,*/*;q=0.8",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    })
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


def entry_jobs(rec):
    """单条记录待镜像的头像：[(前缀, 下标, 人名, URL), ...]。

    前缀 'ch' = 角色、'st' = 制作人。已是 ch-/st- 裸名或空串的跳过。
    """
    out = []
    for kind in ("ch", "st"):
        arr = rec.get(kind)
        if not isinstance(arr, list):
            continue
        for i, c in enumerate(arr[:AVATAR_PER]):
            if not isinstance(c, list) or len(c) < 3 or not isinstance(c[2], str):
                continue
            u = c[2].strip()
            if not u or u.startswith("ch-") or u.startswith("st-"):
                continue
            if u.startswith("http://") or u.startswith("https://"):
                out.append((kind, i, str(c[0] or ""), u))
    return out


def mirror_avatar(kind, sid, i, url, posters, name="", name_map=None, name_lock=None):
    """返回 (结果, 裸文件名)。结果 'reuse' / 'reuse-name' / 'dl' / 'fail'；失败时文件名 None。

    优先级：本地同名文件够大 → 直接复用；本运行内同名已下过 → 复用那张；
    都没有才下载。绝不写坏图（< AVATAR_MIN 字节的不落盘）。
    """
    bare = f"{kind}-{sid}-{i}.jpg"
    dst = posters / bare
    try:
        if dst.is_file() and dst.stat().st_size >= AVATAR_MIN:
            return "reuse", bare
    except OSError:
        pass
    if name and name_map is not None:
        with (name_lock or threading.Lock()):
            known = name_map.get(name)
        if known:
            return "reuse-name", known
    try:
        data = download_img(url)
    except Exception as e:
        print(f"! 头像 {sid}-{i} {type(e).__name__}: {e}", flush=True)
        return "fail", None
    if len(data) < AVATAR_MIN:
        return "fail", None
    posters.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(data)
    if name and name_map is not None:
        with (name_lock or threading.Lock()):
            name_map.setdefault(name, bare)
    return "dl", bare


def avatars_only(shards=None, posters=None, limit=None, workers=None):
    """把分片里 lain.bgm.tv 的角色/制作人头像镜像成 site/posters/{ch,st}-<id>-<i>.jpg。

    与 ch/st/co 抓取完全独立：镜像成功就把 ch[i][2] / st[i][2] 改写成分片内裸名
    ch-<id>-<i>.jpg / st-<id>-<i>.jpg（前端按 ANI.poster 拼 CDN 地址）；下载失败保留
    原 URL 不动（前端 onerror 会露出首字圆），下轮继续重试。
    本地文件已存在且够大直接复用；同一次运行内按人名复用已下好的图，同名不重复请求。

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
            jobs = entry_jobs(rec)
            if jobs:
                tasks.append((rec["id"], jobs, p, rec))
    if not tasks:
        print("头像：titles=0 dl=0 reuse=0 fail=0")
        return 0
    work = tasks[:max(0, limit)]
    print(f"头像待办 {len(work)} 部（上限 {limit}，并发 {max(1, workers)}）", flush=True)

    # 预检：拿第一个待办 URL 探一次。慢了/挂了就整批跳过，一张都不下载。
    try:
        download_img(work[0][1][0][3], timeout=AVATAR_PROBE_TIMEOUT, retries=0)
    except Exception as e:
        print(f"! 头像探测失败 {type(e).__name__}: {e}", flush=True)
        print("! 头像源不可达，本轮跳过", flush=True)
        return 0
    posters.mkdir(parents=True, exist_ok=True)

    stat = {"dl": 0, "reuse": 0, "reuse-name": 0, "fail": 0}
    results, streak, aborted = [], 0, False
    name_map, name_lock = {}, threading.Lock()   # 本运行内 {人名: 裸文件名}，跨轮不做缓存

    def run(task):
        sid, jobs = task[0], task[1]
        return sid, [(kind, i) + mirror_avatar(kind, sid, i, u, posters, name, name_map, name_lock)
                     for kind, i, name, u in jobs]

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
                for _kind, _i, r, _bare in res:
                    stat[r] = stat.get(r, 0) + 1
                    if r == "fail":
                        streak += 1
                        if streak >= AVATAR_STREAK_FAIL:
                            aborted = True
                    else:
                        streak = 0
            pump()   # aborted 后 pump() 立即返回：已派发的跑完，不再派新的

    line = (f"头像：titles={len(results)} dl={stat['dl']} reuse={stat['reuse']}"
            f" reuse-name={stat['reuse-name']} fail={stat['fail']}")
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
    for (_sid, _jobs, p, rec), res in results:
        for kind, i, r, bare in res:
            if r == "fail":      # 失败保留原 http URL，下轮还能重试（前端 onerror 露首字）
                continue
            arr = rec.get(kind)
            if not isinstance(arr, list) or len(arr) <= i or not isinstance(arr[i], list) or len(arr[i]) < 3:
                continue
            # 裸文件名；'reuse-name' 时指向本轮同名角色/制作人已下好的那张
            arr[i][2] = bare
            touched.add(p)

    changed = 0
    for p in sorted(touched):
        p.write_text(json.dumps(files[p], ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        changed += 1
    print(line, flush=True)
    print(f"改写分片 {changed} 个", flush=True)
    return 0


def st_done(rec):
    """制作人员是否已完成：st 键存在且每项都有 3 段（名 / 关系 / 头像）。

    st=[] 也算完成——该作品本就没有制作人（接口成功返回空列表，或 4xx 判「无制作人」）；
    键缺失 / 旧版只有 2 段则需要重抓（只打 /persons，不再重抓角色）。
    """
    st = rec.get("st")
    if not isinstance(st, list):
        return False
    return all(isinstance(e, list) and len(e) >= 3 for e in st)


def fill_people():
    if not SHARDS.is_dir():
        print("! 找不到分片目录", SHARDS)
        return 1
    files, todo, st_todo = {}, [], []
    for p in sorted(SHARDS.glob("*.json")):
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
            if not rec.get("ch"):
                todo.append(rec["id"])          # 全量：ch / st / co 一起抓
            elif not st_done(rec):
                st_todo.append(rec["id"])       # 只补制作人：旧版 2 段项 / 上轮暂时失败
    if not todo and not st_todo:
        print("全部已有角色与制作人员数据")
        return 0

    # 两组交替取、合计不超过 PEOPLE_MAX：既保证老数据能补上头像，也不让预算翻倍
    jobs = []
    for k in range(max(len(todo), len(st_todo))):
        if k < len(todo):
            jobs.append((todo[k], False))
        if len(jobs) >= LIMIT:
            break
        if k < len(st_todo):
            jobs.append((st_todo[k], True))
        if len(jobs) >= LIMIT:
            break
    print(f"待补 全量 {len(todo)} 条 / 仅制作人 {len(st_todo)} 条，本轮 {len(jobs)} 条"
          f"（上限 {LIMIT}，并发 {WORKERS}）", flush=True)

    got, got_st, stat = {}, {}, {}

    def work(item):
        sid, people_only = item
        time.sleep(SLEEP)
        try:
            return sid, people_only, build(sid, people_only)
        except PeopleError:
            return sid, people_only, "err:persons"

    with cf.ThreadPoolExecutor(max_workers=max(1, WORKERS)) as ex:
        for i, (sid, people_only, r) in enumerate(ex.map(work, jobs), 1):
            if isinstance(r, tuple):
                key = "nobody" if r[3] == "nobody" else "ok"
            else:
                key = "none" if r is None else str(r)
            stat[key] = stat.get(key, 0) + 1
            if isinstance(r, tuple):
                if people_only:
                    got_st[sid] = (r[1], r[3])
                else:
                    got[sid] = r
            if i % 100 == 0:
                print(f"  {i}/{len(jobs)} {stat}", flush=True)

    # 「无制作人」成片出现、且本轮一条制作人数据都没拿到 → 疑 /persons 整体失效
    # （路径变更 / 封禁），此时 st=[] 是假信息：整批不写 st，留到下一轮重试。
    nobody_ok = (any(r[3] == "ok" and r[1] for r in got.values())
                 or any(v[1] == "ok" and v[0] for v in got_st.values()))
    nobody_n = (sum(1 for r in got.values() if r[3] == "nobody")
                + sum(1 for v in got_st.values() if v[1] == "nobody"))
    drop_nobody = nobody_n >= PERSONS_ABORT and not nobody_ok
    if drop_nobody:
        print(f"! {nobody_n} 部被判「无制作人」且本轮无一条制作人数据，"
              f"疑似 persons 接口整体失效：本轮不写 st，下轮重试", flush=True)

    changed = 0
    for p, recs in files.items():
        hit = False
        for rec in recs:
            if not isinstance(rec, dict):
                continue
            sid = rec.get("id")
            r = got.get(sid)
            if r:
                ch, st, co, st_state = r
                rec["ch"], rec["co"] = ch, co
                if not (st_state == "nobody" and drop_nobody):
                    rec["st"] = st       # 暂时故障时根本没进 got，这里只写成功拿到的 st
                hit = True
                continue
            st_info = got_st.get(sid)
            if st_info is not None:
                st, st_state = st_info
                if st_state == "nobody" and drop_nobody:
                    continue
                rec["st"] = st
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
