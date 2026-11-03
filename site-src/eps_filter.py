"""分集磁力过滤规则（构建端 index_eps.py 与线上服务 pan_eps_server.py 共用一份）。

历史上这两边各写一套，同一个 bug 要修两次（比如 mikan 的 magnet 字段为空、
合集包 `[1-3]` 识别不到、RE_SEASON 被误删），所以抽出来。改这里即两边同时生效。

依赖：只依赖标准库，两个调用方各自提供 NOISE / RE_PACK 常量也行；本模块自带完整定义。
"""
import re

# 繁→简：目录名是简体、字幕组发布名常用繁体（「皎潔深宵之月」vs「皎洁迎宵之月」），
# 不归一就永远匹配不上。zhconv 是纯 Python 小包，CI/服务器各装一次；
# 装不上就退化成恒等，不影响其它规则。
try:
    from zhconv import convert as _zhconv

    def to_simplified(text, _cache={}):
        t = str(text or "")
        if t in _cache:
            return _cache[t]
        try:
            out = _zhconv(t, "zh-hans")
        except Exception:
            out = t
        if len(_cache) < 20000:
            _cache[t] = out
        return out
except Exception:                                    # 没装 zhconv
    def to_simplified(text, _cache={}):
        return str(text or "")

RE_RANGE = re.compile(r"第\s*(\d{1,4})\s*[-–~〜]\s*(\d{1,4})\s*[話话集]")
RE_SINGLE = re.compile(r"第\s*(\d{1,4})\s*[話话集](?!\d)")
RE_BRACKET = re.compile(r"[\]\)\s\-–—]\s*\[?(\d{1,4})\]?(?=\s*(?:\[|\(|END|完|【|v\d|$))")
RE_EP = re.compile(r"(?:^|[\s\-–—\[])E[P]?(\d{1,4})\b", re.I)
# SxxExx：取 E 后面的集号，S 只作校验（`Season 1` 没有 E数字，不会误吃）
RE_SXXEXX = re.compile(r"(?i)(?<![A-Za-z])S(\d{1,2})\s*E(\d{1,4})\b")
RE_DASH = re.compile(r"\s-\s*(\d{1,4})(?:v\d)?\s*(?:\[|\(|$)")
NOISE = re.compile(
    r"(OP\d?テーマ|ED\d?テーマ|OPテーマ|EDテーマ|主題歌|主题歌|挿入歌|"
    r"オリジナルサウンドトラック|サントラ|Soundtrack|\bBatch\b|全集|合集|Complete|"
    r"BDBOX|BOX\s*SET|DVDISO|BDISO|\bvol\.?\s*\d+|\d+\s*[巻卷]|漫画|コミック|小説|小说)", re.I)
RE_PACK = re.compile(
    r"[\[\(【]\s*\d{1,3}\s*[-–~〜]\s*\d{1,3}"
    r"|\b\d{1,3}\s*[-–~〜]\s*\d{1,3}\s*[话話集]")
RE_SEASON = re.compile(
    r"(第\s*[一二三四五六七八九十\d]+\s*[季期]|Season\s*\d+|Part\.?\s*\d+|\bS\d{1,2}\b|[ⅡⅢⅣⅤⅥ])", re.I)
NUM = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
       "Ⅱ": 2, "Ⅲ": 3, "Ⅳ": 4, "Ⅴ": 5, "Ⅵ": 6}


def norm(s):
    s = to_simplified(s).lower()
    return re.sub(r"[\s\-_.·・:：!！?？,，。'\"()\[\]（）【】～~]", "", s)


def seasons(text):
    out = set()
    for m in RE_SEASON.finditer(str(text or "")):
        raw = m.group(1)
        d = re.search(r"\d+", raw)
        if d:
            n = int(d.group())
        else:
            # 「第二季」的末字是「季」不是「二」，取末字会解析成 0 —— 名字侧
            # 季集合变空、标题侧 "Ao Ashi S2" 解析出 {s2}，不相等 → 整批误杀。
            core = re.sub(r"[第季期部分]|Season|Part\.?", "", raw, flags=re.I).strip()
            n = NUM.get(core[-1], 0) if core else 0
        if n:
            out.add(("part" if re.search(r"Part", raw, re.I) else "s") + str(n))
    return out


def parse_eps(t):
    m = RE_RANGE.search(t)
    if m:
        a, b = int(m.group(1)), int(m.group(2))
        return set(range(a, b + 1)) if 0 <= b - a <= 200 else set()
    for rx in (RE_SINGLE, RE_DASH, RE_EP, RE_SXXEXX, RE_BRACKET):
        m = rx.search(t)
        if m:
            # SxxExx 的集号在 group(2)，季号 group(1) 不参与
            n = int(m.group(2) if rx is RE_SXXEXX else m.group(1))
            return {n} if 0 < n <= 999 else set()
    return set()


def magnet_of(r):
    """取可复制链接。mikan 结果的 magnet 字段为空，但 url 末尾是 40 位 infohash。"""
    m = str(r.get("magnet") or "")
    if m.startswith("magnet:"):
        return m
    u = str(r.get("url") or "")
    tail = u.rstrip("/").split("/")[-1].split("?")[0]
    if re.fullmatch(r"[0-9a-fA-F]{40}", tail or ""):
        return "magnet:?xt=urn:btih:" + tail
    t = str(r.get("torrent") or "")
    return t if t.startswith("http") else ""


def tokens(text):
    parts = re.split(r"[\s\-_/\\|·・:：,.，。!！?？\[\]()（）【】]+", str(text or ""))
    return [norm(x) for x in parts if len(norm(x)) >= 2]


# 字幕组：上游（pan-hub / AnimeGarden）每条结果都带 `group`，部分带 `fansub`
# （实测 group 覆盖率更高），但历史上 item 只保留 {m,s,sd,sub,t}，组名在这里就被丢了。
# 现在统一取一次随 item 下发（键名 g）。构建端走本函数；盒子上的 ops/server.py
# 是 build_eps 的复制实现，那边有同口径的 _grp()，两处必须一起改。
GROUP_MAX = 40
# 黑名单 = 上游实测出现的「非字幕组」脏值：月历下载 / 台配国语 是分类标签而非组名，
# V2_UPDATE_FIX 是发布方的补丁标记，接近完美的动漫 是资源站栏目名，Ñ 是单字符乱码。
# 命中即视为该字段没有组名（继续用另一个字段兜底，两个都脏则为空串）。
GROUP_BLACKLIST = {"月历下载", "台配国语", "v2_update_fix", "接近完美的动漫", "ñ"}


def grp(r):
    """取字幕组名：`group` 优先、`fansub` 兜底；strip → 截断 40 字 → 脏值丢弃。

    不做「像不像组名」的形状过滤：含 字幕/组/Raws/Sub/Team/House/屋/社/工作室 的
    当然保留，其余也原样保留——宁可留一个可疑原值，也不要因为不像组名就整条清空。
    """
    for key in ("group", "fansub"):
        s = str(r.get(key) or "").strip()
        if not s or s.lower() in GROUP_BLACKLIST:
            continue
        return s[:GROUP_MAX]
    return ""


def strip_suffix(text):
    t = re.sub(r"[（(][^）)]*[）)]", "", str(text or ""))
    t = re.split(r"\s*[-–—]\s*|第[一二三四五六七八九十\d]+[季期部分]|最终章|剧场版|特别篇|篇", t)[0]
    return t.strip()


def char_cover(q, nt):
    if len(q) < 4:
        return 0.0
    qs = set(q)
    return len(qs & set(nt)) / len(qs) if qs else 0.0


def build_keys(name, orig, extra=None):
    keys = []
    for raw in (name, orig, strip_suffix(name), strip_suffix(orig)) + tuple(extra or ()):
        k = norm(raw)
        if k and k not in keys:
            keys.append(k)
    return keys


def match_name(release, keys, qtoks):
    nt = norm(release)
    if not nt:
        return 0
    for k in keys:
        if len(k) >= 3 and k in nt:
            return 2
    for k in keys:
        if char_cover(k, nt) >= 0.75:
            return 1
    if qtoks:
        hit = sum(1 for t in qtoks if t in nt)
        if hit and hit * 2 >= len(qtoks):
            return 1
    return 0


def kw_variants(kw, orig):
    out = [kw]
    short = re.sub(r"[（(].*?[)）]", "", kw)
    short = re.split(r"\s*[-–—]\s*|第[一二三四五六七八九十\d]+[季期]|最终章|剧场版|特别篇|篇", short)[0].strip()
    if short and short != kw and len(short) >= 3:
        out.append(short)
    if len(kw) > 6:
        out.append(kw[:6])
    if orig and norm(orig) != norm(kw):
        out.append(orig)
    seen, uniq = set(), []
    for x in out[:4]:
        if x and x not in seen:
            seen.add(x)
            uniq.append(x)
    return uniq


def split_results(name, orig, eps_n, results, per_ep=2, max_batch=8, aliases=None):
    """返回 (eps, batch)。eps: {集号: [条目]}；batch: [整季/合集包条目]。"""
    # 剧场版/OAD（集数 ≤2）天然没有稳定的集号：不再整条丢弃，只禁分集、合集照常收集。
    only_batch = bool(eps_n and eps_n <= 2)
    q, qs = norm(name), seasons(name)
    keys = build_keys(name, orig, aliases)
    qtoks = tokens(name) + tokens(orig)
    short = len(q) <= 3
    # 短名检查同时接受别名：发布名常是异语言（炒翻天→Tetsunabe no Jan）
    short_pats = [re.escape(x) for x in ([name] + list(aliases or [])) if len(x) >= 2] if short else []
    cand, packs = {}, []
    for r in results:
        t = str(r.get("title") or r.get("name") or "")
        if not t or NOISE.search(t):
            continue
        mg = magnet_of(r)
        if not mg:
            continue
        if not match_name(t, keys, qtoks):
            continue
        if short and short_pats and not any(
                re.search(r"[\[\]【】()（）\s\-_/]" + sp + r"[\[\]【】()（）\s\-_/]", t) for sp in short_pats):
            continue
        rs = seasons(t)
        if qs != rs and (qs or rs):
            continue
        # 多带一个 g（字幕组）：上游 group/fansub 在构造 item 时被丢掉后，
        # 索引与 /eps 全链路都不存在组名，前端无从显示。返回结构不变，仅多一个键。
        item = {"m": mg, "s": int(r.get("size") or 0), "sd": int(r.get("seeders") or 0),
                "sub": str(r.get("subs") or r.get("sub") or "")[:12], "t": t[:120],
                "g": grp(r)}
        nums = parse_eps(t)
        if RE_PACK.search(t) or len(nums) > 3:
            packs.append(item)
            continue
        if not nums:
            # 单文件资源（电影/OVA 发布名没有「第12话」「[01-12]」）兜底进 batch，
            # 别再整条丢弃——movie 只有 7.6% 匹配率的根因就是这里。
            packs.append(item)
            continue
        if only_batch:
            # 集数 ≤2：不建分集，但这条资源本身可用 → 收进 batch 而不是 eps。
            packs.append(item)
            continue
        for n in nums:
            cand.setdefault(str(n), []).append(item)
    eps = {}
    for n, lst in cand.items():
        lst.sort(key=lambda x: (x["sd"], x["s"]), reverse=True)
        eps[n] = lst[:per_ep]
    packs.sort(key=lambda x: (x["sd"], x["s"]), reverse=True)
    return eps, packs[:max_batch]
