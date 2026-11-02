#!/usr/bin/env python3
"""重建分集磁力索引（对当前目录，而不是对旧的 179 条 magnet.json）。

与旧版 fetch_magnet_eps.py 的三点区别：
1. 查询词用**卡片标题本身**（`r[2] or r[1]`，即 h3 显示的那个字符串），
   并把同一个字符串原样写进索引的 `n` 字段 —— 站点靠 h3 文本查表，
   这样 `norm(n) === norm(h3)` 必然成立（旧版存的是发布组原名，中文卡片永远匹配不上）。
2. 过滤噪声：音乐单曲（「OPテーマ / EDテーマ / 主題歌 / 挿入歌」）、
   合集包（Batch / 全集）、漫画/小说（巻/卷）一律丢弃 —— 旧索引里
   `テムパル OPテーマ` 这种条目就是噪声。
3. 每个集号最多留 `MAGNET_MAX_PER_EP` 条，按体积降序（大体积通常含字幕/高码）。

用法：
  python index_eps.py --limit 40 --out eps-probe.json      # 小批验证
  python index_eps.py --out site/magnet-eps.json           # 全量
"""
import argparse
import base64
import json
import os
import pathlib
import re
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = pathlib.Path(__file__).resolve().parent
API = os.environ.get("PAN_HUB_API", "http://120.48.56.189/pan/api/search")
# 凭据只从环境变量读，**不要**再写默认值：这个仓库是公开的，
# 之前把账号密码当默认值提交过（已移除，但 git 历史里仍有，建议轮换）。
USER = os.environ.get("PAN_HUB_USER", "")
PASS = os.environ.get("PAN_HUB_PASS", "")
TIMEOUT = int(os.environ.get("MAGNET_TIMEOUT", "40"))
WORKERS = int(os.environ.get("MAGNET_WORKERS", "6"))
PER_EP = int(os.environ.get("MAGNET_MAX_PER_EP", "2"))

# 集号识别（巻/卷 = 卷，不算集）
RE_RANGE = re.compile(r"第\s*(\d{1,4})\s*[-–~〜]\s*(\d{1,4})\s*[話话集]")
RE_SINGLE = re.compile(r"第\s*(\d{1,4})\s*[話话集](?!\d)")
RE_BRACKET = re.compile(r"[\]\)\s\-–—]\s*\[?(\d{1,4})\]?(?=\s*(?:\[|\(|END|完|【|v\d|$))")
RE_EP = re.compile(r"(?:^|[\s\-–—\[])E[P]?(\d{1,4})\b", re.I)
RE_DASH = re.compile(r"\s-\s*(\d{1,4})(?:v\d)?\s*(?:\[|\(|$)")
# 噪声：音乐单曲、整卷/原盘、合集
NOISE = re.compile(r"(OP\d?テーマ|ED\d?テーマ|OPテーマ|EDテーマ|主題歌|主题歌|挿入歌|"
                   r"オリジナルサウンドトラック|サントラ|Soundtrack|"
                   # 只认 BDBOX/DVDISO 这种整卷盘，别再写裸 \bBOX\b ——
                   # 那会把「NOMAD MEGALO BOX 2」这类片名整体判成噪声
                   r"\bBatch\b|全集|合集|Complete|BDBOX|BOX\s*SET|DVDISO|BDISO|"
                   r"\bvol\.?\s*\d+|\d+\s*[巻卷]|漫画|コミック|小説|小说)", re.I)
# 季/部 标记：查询与发布名必须一致，否则 S3 的磁力会挂到 S1 上
RE_SEASON = re.compile(r"(第\s*[一二三四五六七八九十\d]+\s*[季期]|Season\s*\d+|Part\.?\s*\d+|"
                       r"\bS\d{1,2}\b|[ⅡⅢⅣⅤⅥ])", re.I)
NUM = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
       "Ⅱ": 2, "Ⅲ": 3, "Ⅳ": 4, "Ⅴ": 5, "Ⅵ": 6}


def seasons(text):
    """抽季/部标记，返回可比较的集合（如 {'s3'} / {'part2'}）。"""
    out = set()
    for m in RE_SEASON.finditer(text or ""):
        raw = m.group(1)
        num = re.search(r"\d+", raw)
        n = int(num.group()) if num else NUM.get(raw.strip()[-1], 0)
        if not n:
            continue
        if re.search(r"季|期|Season", raw, re.I):
            out.add(f"s{n}")
        elif re.search(r"Part", raw, re.I):
            out.add(f"part{n}")
        else:
            out.add(f"s{n}")
    return out


def norm(s):
    return re.sub(r"[\s\-_.·・:：!！?？,，。'\"()\[\]（）【】～~]", "", str(s or "").lower())
RE_VOLUME = re.compile(r"\d+\s*[巻卷]")
# 整季包：[01-11] / 01-26 / 第01-26话 —— 这是合集不是单片集
RE_PACK = re.compile(r"[\[\(【]\s*\d{1,3}\s*[-–~〜]\s*\d{1,3}\s*[\]\)】]|"
                     r"\d{1,3}\s*[-–~〜]\s*\d{1,3}\s*[话話集]|")


def parse_eps(title):
    """返回集号集合；识别不到返回空集。"""
    out = set()
    m = RE_RANGE.search(title)
    if m:
        a, b = int(m.group(1)), int(m.group(2))
        if 0 <= b - a <= 200:
            out.update(range(a, b + 1))
        return {n for n in out if 0 < n <= 999}
    for rx in (RE_SINGLE, RE_DASH, RE_EP, RE_BRACKET):
        m = rx.search(title)
        if m:
            n = int(m.group(1))
            if 0 < n <= 999:
                out.add(n)
            break
    return out


def search(kw):
    url = API + "?kw=" + urllib.parse.quote(kw, safe="")
    auth = "Basic " + base64.b64encode(f"{USER}:{PASS}".encode()).decode()
    req = urllib.request.Request(url, headers={"authorization": auth, "user-agent": "anime-eps-index"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def pick(r):
    """从聚合结果里取磁力与体积。"""
    m = r.get("magnet") or r.get("m") or ""
    if not isinstance(m, str) or not m.startswith("magnet:"):
        return None
    return {
        "m": m,
        "s": int(r.get("size") or r.get("s") or 0),
        "sd": int(r.get("seeders") or r.get("sd") or 0),
        "sub": str(r.get("sub") or r.get("subs") or "")[:12],
        "t": str(r.get("title") or r.get("name") or "")[:160],
    }


def build_one(row):
    aid, orig, cn, eps_n = row
    name = cn or orig
    if not name:
        return aid, None, "noname"
    if not USER or not PASS:
        return aid, None, "nocred"
    try:
        d = search(name)
    except Exception as e:
        return aid, None, f"err:{type(e).__name__}"
    res = d.get("results") or []
    if not res and orig and orig != name:
        try:
            res = (search(orig).get("results") or [])
        except Exception:
            res = []

    q = norm(name)
    qo = norm(orig)
    qs = seasons(name)
    short = len(q) <= 3            # 「乒乓」「虫师」这类短名，子串匹配必错

    cand = {}
    for r in res:
        t = str(r.get("title") or r.get("name") or "")
        if not t or NOISE.search(t):
            continue
        item = pick(r)
        if not item:
            continue
        nt = norm(t)
        # 剧场版（目录话数 <= 2）不给分集 chip：同名片子的 TV 版集数会被误抓，
        # 「有一个错的」比「没有」更坏
        if eps_n and int(eps_n) <= 2:
            continue
        # 整季包 / 合集跳过
        if RE_PACK.search(t):
            continue
        # 发布名必须真含本片名（中文名或原名），否则是别片的磁力
        if not ((q and q in nt) or (qo and len(qo) >= 4 and qo in nt)):
            continue
        # 短标题要求词边界，避免「乒乓」吃到「灼热的乒乓妹」
        if short and not re.search(r"[\[\]【】()（）\s\-_/]%s[\[\]【】()（）\s\-_/]" % re.escape(name), t):
            continue
        # 季/部必须对得上：S3 的磁力不能挂到 S1 条目上
        rs = seasons(t)
        if qs != rs and (qs or rs):
            continue
        nums = parse_eps(t)
        if not nums:
            continue
        # 宽范围包（第01-26话 / Batch）不是单片集，直接跳过
        if len(nums) > 3:
            continue
        if eps_n:
            nums = {n for n in nums if n <= int(eps_n) + 2}
        for n in nums:
            cand.setdefault(n, []).append(item)
    if not cand:
        return aid, None, "noep"
    eps = {}
    for n, lst in cand.items():
        lst.sort(key=lambda x: (x["sd"], x["s"]), reverse=True)
        eps[str(n)] = lst[:PER_EP]
    return aid, {"n": name, "eps": eps}, f"eps={len(eps)}"


def load_catalog(a):
    """优先读 anime.json 的 rows；否则从 site/anime/*.json 分片拼出同形状的行。

    行形状：[id, 原名, 中文名, 格式, 年, 月, 星期, 评分, 话数]
    """
    cp = pathlib.Path(a.catalog) if a.catalog else None
    if cp and cp.is_file():
        return json.loads(cp.read_text(encoding="utf-8")).get("rows") or []
    rows = []
    sd = pathlib.Path(a.shards)
    if not sd.is_dir():
        return rows
    for fp in sorted(sd.glob("*.json")):
        try:
            recs = json.loads(fp.read_text(encoding="utf-8"))
        except Exception:
            continue
        for rec in recs or []:
            if not isinstance(rec, dict) or not rec.get("id"):
                continue
            rows.append([rec.get("id"), rec.get("name") or "", rec.get("name_cn") or "",
                         rec.get("format") or "", 0, 0, 0,
                         rec.get("rating") or 0, rec.get("episodes") or 0])
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--catalog", default="", help="anime.json（含 rows）；不传则读 --shards")
    ap.add_argument("--shards", default=str(BASE / "site" / "anime"), help="目录：site/anime/*.json 分片")
    ap.add_argument("--out", default=str(BASE / "site" / "magnet-eps.json"))
    ap.add_argument("--limit", type=int, default=int(os.environ.get("MAGNET_MAX", "0") or 0))
    ap.add_argument("--min-rating", type=float, default=0.0)
    ap.add_argument("--resume", action="store_true", help="跳过 out 里已存在的条目（多轮收敛）")
    ap.add_argument("--save-every", type=int, default=100, help="每 N 条落盘一次，进程被掐也不丢进度")
    ap.add_argument("--shard", type=int, default=int(os.environ.get("SHARD", "-1")))
    ap.add_argument("--shard-total", type=int, default=int(os.environ.get("SHARD_TOTAL", "0") or 0))
    # 记「查过但没结果」的条目（eps 为空），否则每轮都从评分最高那批重查，
    # 永远卡在同一批无结果的作品上、后面的永远轮不到（收敛必须靠这个）
    ap.add_argument("--mark-miss", action="store_true")
    a = ap.parse_args()

    rows = load_catalog(a)
    todo = []
    for r in rows:
        if not r:
            continue
        aid = r[0]
        orig = r[1] if len(r) > 1 else ""
        cn = r[2] if len(r) > 2 else ""
        rating = r[7] if len(r) > 7 else 0
        eps_n = r[8] if len(r) > 8 else 0
        if a.min_rating and (rating or 0) < a.min_rating:
            continue
        todo.append((aid, orig, cn, eps_n, rating or 0))
    # 按评分降序 —— 限流截断时先保热门
    todo.sort(key=lambda x: x[4], reverse=True)
    # 分片：按 id 取模，保证同一部作品永远落在同一片
    if a.shard_total > 0 and a.shard >= 0:
        todo = [t for t in todo if int(t[0]) % a.shard_total == a.shard]
        print(f"分片 {a.shard}/{a.shard_total} -> {len(todo)} 条", flush=True)
    todo = [(t[0], t[1], t[2], t[3]) for t in todo]
    print(f"待建 {len(todo)} 条，并发 {WORKERS}，单条超时 {TIMEOUT}s", flush=True)

    names = {str(t[0]): (t[2] or t[1]) for t in todo}
    out, stat = {}, {}
    outp = pathlib.Path(a.out)
    if a.resume and outp.is_file():
        try:
            out = json.loads(outp.read_text(encoding="utf-8"))
            print(f"resume: 已有 {len(out)} 条，跳过", flush=True)
        except Exception:
            out = {}
    done = set(out)
    todo = [t for t in todo if str(t[0]) not in done]
    # 顺序很关键：必须「先剔除已收录、再截断到 MAGNET_MAX」。
    # 反过来（先取前 150 再剔除）会导致每轮都只剩 0 条可做 —— 实测两轮
    # merged 3066 -> 3066，一条没新增。
    if a.limit:
        todo = todo[: a.limit]
    print(f"本轮可做 {len(todo)} 条（已跳过 {len(done)} 条）", flush=True)

    def save():
        outp.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for i, (aid, rec, msg) in enumerate(ex.map(build_one, todo), 1):
            stat[msg.split("=")[0]] = stat.get(msg.split("=")[0], 0) + 1
            if rec:
                out[str(aid)] = rec
            elif a.mark_miss:
                out[str(aid)] = {"n": names.get(str(aid), ""), "eps": {}}
            if a.save_every and i % a.save_every == 0:
                save()
            if i % 20 == 0 or i == len(todo):
                print(f"  {i}/{len(todo)}  {stat}  已收录 {len(out)}", flush=True)

    save()
    kw = sum(1 for v in out.values() if v.get("eps"))
    print(f"写出 {a.out}: {len(out)} 条，其中带分集 {kw} 条，{pathlib.Path(a.out).stat().st_size} B")


if __name__ == "__main__":
    main()
