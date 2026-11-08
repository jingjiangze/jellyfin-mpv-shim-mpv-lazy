#!/usr/bin/env python3
"""站点构建器（全面替换版）：数据源换成 Bangumi 全量目录，AniList 退为补充/回退。

三张页面：
  index.html    首页 —— 今年新番，按「本周 / 本月」两种排列
  anime.html    番剧 —— 全量目录（8.8k），年份/类型/排序 + 搜索 + 加载更多
  movie.html    电影 —— 豆瓣 + TMDB 双源海报墙

前后端分离：页面只是壳，数据全部走 site/data/*.json，前端按需拉。

数据来源：
  catalog.json          bangumi-data 索引（id / 原名 / 中文名 / 类型 / 年份）
  site/anime/*.json     64 个分片（评分 / 话数 / 简介 / 标签 / 封面原图）
  data/fresh.json       AniList 当季（banner / 预告 / 倒计时）+ 豆瓣电影
  site/tmdb.json        TMDB 热门 / 正在上映（fetch_tmdb.py 产出）
"""
import datetime as dt
import json
import os
import pathlib
import re
import shutil

BASE = pathlib.Path(__file__).resolve().parent
SITE = BASE / "site"
TPL = BASE / "tpl"
DATA = BASE / "data"

MODELSCOPE = os.environ.get(
    "MODELSCOPE_BASE",
    "https://modelscope.cn/datasets/jingjiangze/Anime-JPG/resolve/master")
BUILD_TAG = dt.datetime.now().strftime("%m-%d %H:%M")
TODAY = dt.date.today()
WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]


def min_css(text):
    while "/*" in text:
        a = text.index("/*")
        b = text.index("*/", a) + 2
        text = text[:a] + text[b:]
    return " ".join(text.split())


def min_js(text):
    """保守压缩：只去「整行注释 / 行首缩进 / 行尾空白 / 空行」。

    不合并行 —— 合并会踩 ASI（自动分号插入）的坑；不动行内 `//` 与字符串内容。
    """
    out = []
    in_block = False
    for line in text.splitlines():
        s = line.strip()
        if in_block:
            if "*/" in s:
                s = s.split("*/", 1)[1].strip()
                in_block = False
            else:
                continue
        if s.startswith("/*"):
            if "*/" not in s:
                in_block = True
                continue
            s = s.split("*/", 1)[1].strip()
        if not s or s.startswith("//"):
            continue
        out.append(s)
    return "\n".join(out)


def norm(s):
    s = str(s or "").lower()
    s = re.sub(r"[\s\-_.·・:：!！?？,，。'\"()\[\]【】（）]", "", s)
    return s


def load_shards():
    out = {}
    d = SITE / "anime"
    if not d.is_dir():
        return out
    for p in sorted(d.glob("*.json")):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            continue
        if not isinstance(data, list):
            continue          # data.json 之类的非分片文件，跳过
        for rec in data:
            if isinstance(rec, dict) and rec.get("id"):
                out[rec["id"]] = rec
    return out


# 官方 YouTube 正片（木棉花 / Ani-One / 回歸線 RSS）：标题多为繁体，
# 用一张高频繁→简小映射做归一，再按「片名包含」匹配。命中偏少的常见原因
# 就是简繁不一致 —— 别急着改匹配算法，先看映射表。
_T2S_PAIRS = (
    "藥药 啰啰 蘭兰 灣湾 們们 兒儿 動动 畫画 話话 劇剧 場场 見见"
    "聽听 實实 國国 會会 來来 後后 間间 開开 關关 門门 問问 時时"
    "東东 無无 為为 與与 業业 當当 處处 歸归 還还 這这 裡里 個个"
    "學学 體体 氣气 電电 機机 護护 衛卫 靈灵 夢梦 銀银 戰战 劍剑"
    "傳传 說说 讀读 變变 讓让 認认 態态 藝艺 歷历 觸触 麗丽 織织"
    "終终 結结 絕绝 習习 龍龙 獅狮 獵猎 貴贵 異异 類类 轉转 訊讯"
    "員员 壞坏 壓压 廢废 嬌娇 蘇苏 聖圣 陰阴 陽阳 雙双 隊队 禍祸"
    "頁页 驅驱 鬥斗 寶宝 築筑 鐵铁 隨随 險险 隱隐 雲云 術术 廳厅"
    "備备 傑杰 僅仅 傷伤 構构 樸朴 歡欢 滅灭 潛潜 燒烧 獨独 環环"
    "療疗 監监 確确 稱称 筆笔 節节 級级 紀纪 約约 紅红 純纯 細细"
    "組组 緒绪 續续 維维 總总 義义 聯联 腦脑 臨临 舉举 葉叶 融融"
    "衝冲 複复 親亲 覺觉 觀观 記记 識识 負负 財财 貨货 質质 費费"
    "車车 軍军 輕轻 較较 輪轮 輸输 辦办 遠远 適适 選选 遺遗 邊边"
    "鄉乡 醫医 錄录 錢钱 閃闪 陸陆 際际 雖虽 難难 雜杂 顧顾 飛飞"
    "養养 樂乐 齊齐 點点 頻频 麽么 齣出 週周 給给 語语 誰谁 課课"
    "論论 請请 談谈 應应 愛爱 戲戏 戰战 擁拥 過过 道道 達达 遊游"
    "運运 配配 鄭郑 醸酿 重重 鈴铃 錯错 鍵键 鎖锁 鏡镜 關关 闇暗"
    "靜静 響响 頭头 類类 飆飙 香香 驗验 魔魔 麗丽 黑黑"
)
_T2S = {ord(a): b for pair in _T2S_PAIRS.split() for a, b in [(pair[0], pair[1])] if a != b}

def _t2s(s):
    return (s or "").translate(_T2S)

def _t2s(s):
    return (s or "").translate(_T2S)


def load_yt_videos():
    """官方频道 RSS 视频（fetch_yt_rss.py 产出）；缺失/坏数据一律当空。"""
    fp = SITE / "yt.json"
    if not fp.is_file():
        return []
    try:
        return json.loads(fp.read_text(encoding="utf-8")).get("videos") or []
    except (ValueError, OSError):
        return []


def yt_for(norm_title, videos):
    """片名包含匹配（双向都试），只收带集数标记的视频（第N話/集/EP）。

    视频按时间倒序排，一部番最多挂 30 条 —— 太长会让 anime.json 膨胀。
    """
    if not norm_title or len(norm_title) < 2:
        return []
    ep_re = re.compile(r"第\s*\d+\s*[話话集期]|EP?\.?\s*\d{1,3}", re.I)
    out, seen = [], set()
    for v in videos:
        vid = str(v.get("v") or "")
        vt = norm(_t2s(str(v.get("t") or "")))     # 双侧都过 norm：繁体、空格、标点统一
        if vid in seen:
            continue
        if norm_title not in vt:
            # 译名差异兜底：片名较长时用前 6 字做前缀匹配（「歡迎光臨遊之家」类
            # Ani-One 译名与 Bangumi 不一致时，靠开头一段仍能对上）
            pre = norm_title[:6] if len(norm_title) >= 6 else ""
            if not pre or pre not in vt:
                continue
        if not ep_re.search(vt):
            continue
        seen.add(vid)
        out.append([str(v.get("t") or "")[:80],
                    "https://www.youtube.com/watch?v=" + vid])
    return out[:30]


def build_anime():
    cat = json.loads((DATA / "catalog.json").read_text(encoding="utf-8"))
    shards = load_shards()
    YT_VIDEOS = load_yt_videos()
    print(f"  yt: 官方频道视频 {len(YT_VIDEOS)} 条")
    # B 站官方嵌入：fetch_bili.py 的 bvid 索引（id -> {bvid,title,…}）。
    # 旧索引的键是 md5（历史 data.json 体系），先按标题归一建倒排兜底；
    # 新键是 bgm id，直查命中。返回统一函数 bili_bvid(sid, cn, name)。
    BILI = {}
    bp = SITE / "bili.json"
    if bp.is_file():
        try:
            BILI = json.loads(bp.read_text(encoding="utf-8")) or {}
        except (ValueError, OSError):
            BILI = {}
    BILI_BY_TITLE = {}
    for _k, _v in BILI.items():
        if isinstance(_v, dict) and _v.get("bvid"):
            for t in (_v.get("title"),):
                nt = norm(t)
                if nt and nt not in BILI_BY_TITLE:
                    BILI_BY_TITLE[nt] = _v["bvid"]

    def bili_bvid(sid, cn, name):
        hit = BILI.get(str(sid)) or {}
        if hit.get("bvid"):
            return hit["bvid"]
        nt = norm(cn) or norm(name)
        if nt and len(nt) >= 4:
            for bt, bvid in BILI_BY_TITLE.items():
                if nt in bt or (len(bt) >= 4 and bt in nt):
                    return bvid
        return None
    print(f"  bili: bvid 索引 {len(BILI)} 条（标题兜底 {len(BILI_BY_TITLE)}）")

    # AniList 补充/回退：按标题归一化对齐到 Bangumi 条目
    al = {}
    fp = SITE / "fresh.json"
    if fp.is_file():
        try:
            fresh = json.loads(fp.read_text(encoding="utf-8"))
            for x in (fresh.get("anime") or []):
                for key in (x.get("n"), x.get("o")):
                    k = norm(key)
                    if k and k not in al:
                        al[k] = x
        except (ValueError, OSError):
            pass

    # 老站留下的 179 条磁力（key 是 AniList 体系，值里带种子标题），
    # 按「片名是否出现在种子标题里」映射到 bgm 条目，只用来点卡片角标。
    # 分集索引（magnet-eps.json）里出现的条目 = 真有磁力，角标以它为准；
    # 179 条旧 magnet.json 的映射作为补充。
    eps_ids, eps_names = set(), set()
    ep = SITE / "magnet-eps.json"
    if ep.is_file():
        try:
            for k, v in (json.loads(ep.read_text(encoding="utf-8")) or {}).items():
                if isinstance(k, str):
                    # 实测索引的键是纯数字 bgm id（8,797 个键全数字、bgm 前缀 0 个），
                    # 旧版只认 "bgm" 前缀 -> eps_ids 恒空、有磁力少算 943 部。
                    kk = k[3:] if k.startswith("bgm") else k
                    if kk.isdigit():
                        eps_ids.add(kk)
                nm = norm((v or {}).get("n"))
                if nm:
                    eps_names.add(nm)
        except (ValueError, OSError):
            pass

    mag_titles = []
    mp = SITE / "magnet.json"
    if mp.is_file():
        try:
            for v in (json.loads(mp.read_text(encoding="utf-8")) or {}).values():
                t = norm((v or {}).get("t"))
                if len(t) >= 4:
                    mag_titles.append(t)
        except (ValueError, OSError):
            pass

    rows, extra = [], {}
    for it in cat.get("items") or []:
        sid = it.get("id")
        d = shards.get(sid) or {}
        air = (it.get("d") or d.get("air") or "")
        y = int((air[:4] or it.get("y") or 0) or 0) or None
        month = int(air[5:7]) if len(air) >= 7 and air[5:7].isdigit() else 0
        day = int(air[8:10]) if len(air) >= 10 and air[8:10].isdigit() else 0
        wd = 0
        try:
            wd = dt.date(int(air[:4]), int(air[5:7]), int(air[8:10])).weekday() + 1
        except (ValueError, TypeError):
            pass
        name = it.get("n") or d.get("name") or ""
        cn = it.get("cn") or d.get("name_cn") or ""
        key = norm(cn or name)
        has_mag = 1 if (str(sid) in eps_ids or key in eps_names
                      or (len(key) >= 4 and any(key in t for t in mag_titles))) else 0
        # r[12] = bgm 排名：榜单要用「人气+评分综合」排序，
        # 只按评分排会让「1 人打 10 分」的冷门片霸榜
        rows.append([sid, name, cn, (it.get("t") or "").lower(), y, month, wd,
                     d.get("rating"), d.get("episodes") or 0, 1 if d else 0, has_mag, day,
                     (d or {}).get("rank") or 0])

        # 只给能匹配到 AniList 的条目挂补充字段，避免索引膨胀。
        # 固定槽位 [banner, img, trailer, next_at]，缺项填 null —— 前端按 ex[1]
        # 取封面、ex[2] 取预告。以前是「有才 append」，缺 banner 时整体前移，
        # 实测 32 条（名侦探柯南 / 海贼王等）把 next_at 时间戳当成了 YouTube id。
        a = al.get(norm(cn)) or al.get(norm(name)) or {}
        bvid = bili_bvid(sid, cn, name)
        if a or bvid:
            # 第 5 槽 = 官方 YouTube 正片分集 [[标题, 链接], …]（RSS 频道匹配为主）。
            # 第 6 槽 = B 站官方嵌入的 bvid（fetch_bili.py 索引）。
            # 空数组也写入：前端据 ex[4] 区分「无官方片源」与「还没探测」。
            _yt = yt_for(norm(cn or name), YT_VIDEOS) or (a.get("yt") or [])
            ex = [a.get("banner") or None, a.get("img") or None,
                  a.get("trailer") or None, a.get("next_at") or None,
                  _yt, bvid or None]
            if any(v not in (None,) and v != [] for v in ex):
                extra[str(sid)] = ex

    _yt_n = sum(1 for v in extra.values() if isinstance(v, list) and len(v) > 4 and v[4])
    print(f"  yt 匹配: {_yt_n} 部挂上官方正片（RSS {len(YT_VIDEOS)} 条）")
    rows.sort(key=lambda r: (-(r[4] or 0), -(r[7] or 0)))
    payload = {"built": BUILD_TAG, "poster": f"{MODELSCOPE}/posters/bgm-",
               "posterSd": f"{MODELSCOPE}/posters-c/bgm-",
               "year": TODAY.year, "extra": extra, "rows": rows}
    out = SITE / "data"
    out.mkdir(parents=True, exist_ok=True)
    (out / "anime.json").write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"anime: {len(rows)} 条（有评分 {sum(1 for r in rows if r[7])} / 有详情 "
          f"{sum(1 for r in rows if r[9])} / 有磁力 {sum(1 for r in rows if r[10])} / AniList 补充 {len(extra)}）")
    return rows


def shard_of(title, n=16):
    """片名 -> 分片号，必须与打包端（src/shard_eps.py）逐字符一致。

    两边都是：按 Unicode 码点迭代 `h = (h*31 + ord(ch)) % 2**32`，取 `h % n`；
    tpl/magnet-eps.js 的 shardOf 也是同一算法 —— 改任一处必须同步另外两处，
    否则算出的片号对不上、永远查不到（src/test_shard_parity.py 对拍）。
    """
    h = 0
    for ch in str(title or "").strip():
        h = (h * 31 + ord(ch)) % 4294967296
    return h % n


def _nm(s):
    return "".join(ch for ch in str(s or "").lower()
                   if ch not in " \t\r\n-_.·・:：!！?？,，。'\"()[]【】（）～~")


def build_movies():
    """电影页数据：豆瓣（fresh.json 的 movies）+ TMDB（fetch_tmdb.py 的 tmdb.json）。"""
    # 豆瓣条目简介：movies-intro.json 由单独脚本抓（按豆瓣 subject_id 索引）。
    # 文件缺失 / 解析失败一律当空，不影响构建。
    intros = {}
    ip = SITE / "movies-intro.json"
    if ip.is_file():
        try:
            intros = (json.loads(ip.read_text(encoding="utf-8")).get("items") or {})
        except (ValueError, OSError):
            intros = {}

    douban = []
    fp = SITE / "fresh.json"
    if fp.is_file():
        try:
            fresh = json.loads(fp.read_text(encoding="utf-8"))
            for x in (fresh.get("movies") or []):
                if not isinstance(x, dict) or not x.get("n"):
                    continue
                u = x.get("u") or ""
                m = re.search(r"/subject/(\d+)", u)
                subj_id = m.group(1) if m else ""
                info = intros.get(subj_id)
                if not isinstance(info, dict):
                    info = {}
                # 本地有抓下来的豆瓣封面就用数据集地址（豆瓣图有防盗链，外链在浏览器里 403），
                # 没有就回退原外链，至少境外/直连场景还能出图。
                local_pic = SITE / "posters" / f"db-{subj_id}.jpg" if subj_id else None
                img = (f"{MODELSCOPE}/posters/db-{subj_id}.jpg"
                       if local_pic is not None and local_pic.is_file()
                       else (x.get("img") or ""))
                douban.append({"n": x["n"], "u": u,
                               "img": img, "r": x.get("r"),
                               "k": x.get("k") or "",
                               "id": subj_id,
                               "intro": info.get("intro") or "",
                               "sub": info.get("sub") or ""})
        except (ValueError, OSError):
            pass

    tmdb = []
    tp = SITE / "tmdb.json"
    if tp.is_file():
        try:
            for x in (json.loads(tp.read_text(encoding="utf-8")).get("items") or []):
                if not isinstance(x, dict) or not x.get("n"):
                    continue
                tmdb.append({"n": x["n"], "u": x.get("u") or "",
                             "img": x.get("img") or "", "r": x.get("r"),
                             "y": x.get("y"), "id": x.get("id"),
                             "ov": x.get("ov") or "",
                             "ot": x.get("ot") or "",
                             "tr": x.get("tr") or ""})
        except (ValueError, OSError):
            pass

    # 豆瓣 / TMDB 会各存一份同片（译名不同），列表里就重复出现两次。
    # 按归一化片名判同片，保留简介更长的一侧作为主条目，另一侧整条去掉 ——
    # 不合并字段，否则两套链接/海报会混在同一张卡片上。
    db_by_name = {}
    for i, d in enumerate(douban):
        k = _nm(d.get("n"))
        if k:
            db_by_name.setdefault(k, []).append(i)
    claimed, drop_db, drop_tm = set(), set(), set()
    n_same = 0
    for j, t in enumerate(tmdb):
        k = _nm(t.get("n"))
        if not k:
            continue
        i = next((x for x in db_by_name.get(k, []) if x not in claimed), None)
        if i is None:
            continue
        claimed.add(i)
        n_same += 1
        if len(t.get("ov") or "") > len(douban[i].get("intro") or ""):
            drop_db.add(i)
        else:
            drop_tm.add(j)
    if n_same:
        douban = [d for i, d in enumerate(douban) if i not in drop_db]
        tmdb = [t for j, t in enumerate(tmdb) if j not in drop_tm]
        print(f"movies: 去重 {n_same} 部（豆瓣 {len(drop_db)} / TMDB {len(drop_tm)} → "
              f"合计 {len(douban) + len(tmdb)}）")

    out = SITE / "data"
    out.mkdir(parents=True, exist_ok=True)
    (out / "movies.json").write_text(
        json.dumps({"built": BUILD_TAG, "douban": douban, "tmdb": tmdb},
                   ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    n_intro = sum(1 for d in douban if d["intro"])
    n_ov = sum(1 for t in tmdb if t["ov"])
    print(f"movies: douban {len(douban)} / tmdb {len(tmdb)} / "
          f"有简介 {n_intro}（豆瓣）+ {n_ov}（TMDB）")
    return douban, tmdb


# 页面骨架两种模式（PAGES 的第 8 字段选）：
#   modal  默认，弹窗预览：<main> 只有加载占位，mask + #modal 挂在 body 末尾，
#          点卡片才由前端填充；
#   inline 整页详情（detail.html）：mask 留空壳（不改弹窗行为时可继续用），
#          #modal 搬进 <main> 直接当页面主体 —— id 不变，前端详情模块只认 #modal，
#          所以两种模式共用同一套渲染代码，不用分支。
SHELL_MODAL = ('<main class=wrap id=main><div class=loading>加载中…</div></main>'
               '<div class=mask id=mask><div class=modal id=modal></div></div>')
SHELL_INLINE = ('<div class="mask" id="mask"></div>'
                '<main class="wrap" id="main"><div id="modal" class="dp"></div></main>')
SHELLS = {"modal": SHELL_MODAL, "inline": SHELL_INLINE}

PAGE = """<!doctype html><html lang=zh-CN><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>__TITLE__</title><link rel=preconnect href=https://modelscope.cn crossorigin><link rel=preconnect href=https://cdn-lfs-cn-1.modelscope.cn crossorigin><meta name=color-scheme content="dark light"><script>try{var t=localStorage.getItem('theme');if(t==='dark'||(!t&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.setAttribute('data-theme','dark')}catch(e){}</script><style>html{background:#f6f6fa}html[data-theme=dark]{background:#101013}</style><link rel=stylesheet href="/style-__CV__.css" onerror="var l=document.createElement('link');l.rel='stylesheet';l.href='https://modelscope.cn/datasets/jingjiangze/Anime-JPG/resolve/master/assets/style-__CV__.css';document.head.appendChild(l)"><link rel=preload as=script href="https://modelscope.cn/datasets/jingjiangze/Anime-JPG/resolve/master/assets/app-__JV__.js"><script>(function(){
  /* 资源加载：每类资源一份「候选链」，命中即停 + 单候选超时。
     血泪三条（都踩过，别再改回去）：
       ① 不能写成「先 app-<hash>.js 再 app.js?v=」的顺序双加载 —— 两个都会执行，第二个
          从 ModelScope 取到的是没更新的旧 app.js，旧代码覆盖新代码，新功能静默失效。
       ② 候选不能只有一个源：ModelScope 数据集同步失败时哈希名在数据集是 404，必须能退。
       ③ **每个候选必须带超时**：Cloudflare Pages 国内偶尔卡到 20s+ 不回包，没有超时就
          整页空白（实测 iPhone UA 那次 25s 还没响应，__srcStart 一直是 undefined）。
          超时即移除该 <script> 试下一个；元素在未执行前被移除，浏览器不会再执行它。
     顺序：ModelScope（国内最快，0.3s 级）→ 同源 Pages（权威，HTML 都从这来）→
           gh-proxy（第三方代理，最后兜底）。固定名 app.js?v= 只在哈希名全军覆没时用。 */
  var MS='https://modelscope.cn/datasets/jingjiangze/Anime-JPG/resolve/master/assets/';
  var GH='https://gh-proxy.com/https://raw.githubusercontent.com/jingjiangze/jellyfin-mpv-shim-mpv-lazy/main/media/assets/';
  var JS=[MS+'app-__JV__.js','/app-__JV__.js','/app.js?v=__JV__',MS+'app.js?v=__JV__',GH+'app-__JV__.js',GH+'app.js?v=__JV__'];
  var ME=[MS+'magnet-eps.js','/magnet-eps.js',GH+'magnet-eps.js'];
  var TMO=7000;
  function load(list,i,done){
    if(i>=list.length) return;
    var s=document.createElement('script'),settled=false;
    var timer=setTimeout(function(){
      if(settled) return; settled=true;
      if(s.parentNode) s.parentNode.removeChild(s);
      load(list,i+1,done);
    },TMO);
    s.onload=function(){ if(settled) return; settled=true; clearTimeout(timer); if(done) done(); };
    s.onerror=function(){
      if(settled) return; settled=true; clearTimeout(timer);
      if(s.parentNode) s.parentNode.removeChild(s);
      load(list,i+1,done);
    };
    s.src=list[i];
    document.body.appendChild(s);
  }
  function boot(){ load(JS,0,function(){ load(ME,0,null); }); }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot);
  else boot();
})()</script></head><body data-page=__PAGE__ data-build="__BUILD__"><header class=site-head id=topbar></header>__SHELL__</body></html>"""

PAGES = [
    ("index.html", "home", "番组计划 · 新番表", "搜索番剧…", 'class="is-on"', "", ""),
    ("anime.html", "anime", "番剧全收录 · 番组计划", "在 8,000+ 部里搜…", "", 'class="is-on"', ""),
    ("movie.html", "movie", "电影 · 番组计划", "搜索电影…", "", "", 'class="is-on"'),
    ("rank.html", "rank", "排行榜 · 番组计划", "搜索番剧…", "", "", ""),
    ("user.html", "user", "我的主页 · 番组计划", "搜索番剧…", "", "", ""),
    # 第 8 字段 = 骨架模式（见 SHELLS）；缺省按 "modal" 处理，所以上面的行不用动。
    # detail 走 inline：详情本身就是整页，#modal 直接当页面主体（路由 detail?id=<id>）。
    # 仍然是同一份静态壳，不预渲染 per-id。
    ("detail.html", "detail", "番剧详情 · 番组计划", "搜索番剧…", "", "", "", "inline"),
]


def main():
    build_anime()
    build_movies()

    css = min_css((TPL / "style.css").read_text(encoding="utf-8"))
    # 前端源码按文件名排序拼接（NN-*.js 的数字前缀就是拼接顺序），
    # 外壳只在这里包一次；各模块靠同一个 IIFE 作用域共享变量。
    src_dir = TPL / "src"
    parts = sorted(src_dir.glob("*.js"))
    if not parts:
        raise SystemExit("tpl/src 为空：前端源码缺失")
    raw_js = "(function () {\n'use strict';\n" + "\n".join(
        p.read_text(encoding="utf-8") for p in parts) + "\n})();\n"
    js = min_js(raw_js)
    # HTML 只留骨架：CSS/JS 落成独立文件由浏览器并行取，且能被 _headers 缓存。
    # 文件名不带哈希 —— 带哈希后每次部署旧文件名消失，缓存了旧 HTML 的浏览器会
    # 404；改用「短 max-age + must-revalidate」（见 tpl/_headers）。
    (SITE / "style.css").write_text(css, encoding="utf-8")
    (SITE / "app.js").write_text(js, encoding="utf-8")
    print(f"  app.js: {len(raw_js.encode('utf-8'))} -> "
          f"{len(js.encode('utf-8'))} B")
    # 内容版本号：这两个文件名固定（带哈希会让缓存了旧页的浏览器 404），
    # 靠 ?v= 换 URL 来绕过缓存。历史坑：早先 /style.css 不存在却标了
    # immutable，浏览器把 404 兜底的 HTML 永久缓存成 CSS/JS，页面直接白屏。
    import hashlib as _h
    cv = _h.sha1(css.encode("utf-8")).hexdigest()[:10]
    jv = _h.sha1(js.encode("utf-8")).hexdigest()[:10]
    # 2026-11-07：ModelScope 的 CDN 会无视 ?v=（按路径缓存），部署后 app.js 可能
    # 长时间停留在旧版本（实测 style 新 / app 旧混跑）。所以**同时**落一份带哈希
    # 名的副本：新 HTML 先加载 app-<jv>.js / style-<cv>.css（路径全新，CDN 必新），
    # 加载链第二位仍是固定名 + ?v=，给缓存了旧 HTML 的浏览器兜底（404 → 顺位下一个）。
    (SITE / f"app-{jv}.js").write_text(js, encoding="utf-8")
    (SITE / f"style-{cv}.css").write_text(css, encoding="utf-8")
    for row in PAGES:
        name, page, title, ph, on_home, on_anime, on_movie = row[:7]
        # 第 8 字段是骨架模式；只有一个页面走 inline，其余沿用 modal（不写第 8 字段即 modal，
        # 所以老行不用补空串）。未知值直接报错，别静默拼出一个没有 #modal 的壳。
        mode = row[7] if len(row) > 7 else "modal"
        if mode not in SHELLS:
            raise SystemExit(f"{name}: 未知骨架模式 {mode!r}")
        html = (PAGE.replace("__TITLE__", title).replace("__PAGE__", page)
                .replace("__CV__", cv).replace("__JV__", jv)
                .replace("__BUILD__", BUILD_TAG)
                .replace("__PH__", ph)
                .replace("__ON_HOME__", on_home).replace("__ON_ANIME__", on_anime)
                .replace("__ON_MOVIE__", on_movie)
                .replace("__SHELL__", SHELLS[mode]))
        (SITE / name).write_text(html, encoding="utf-8")
        print(f"  {name}: {len(html.encode('utf-8'))/1024:.0f} KB")
    print(f"pages: {len(PAGES)} 个"
          f"（{'/'.join(p[0].replace('.html', '') for p in PAGES)}）")

    # 分片给详情弹窗按需拉
    ddir = SITE / "data"
    ddir.mkdir(parents=True, exist_ok=True)
    for old in ddir.glob("s[0-9]*.json"):
        old.unlink()
    n = 0
    for p in sorted((SITE / "anime").glob("*.json")):
        try:
            shutil.copy2(p, ddir / f"s{p.stem}.json")
            n += 1
        except OSError:
            pass
    # 分片缺失会让详情弹窗（简介/标签/评分分布）大面积失效：生产是 64 片，
    # 少于 60 说明这一轮的数据不完整，宁可让构建失败也不要发一个残废站点。
    if n < 60:
        raise SystemExit(f"shards only {n}, expected >= 60 —— 分片缺失，拒绝发布")
    print(f"shards: {n} (flat, data/s<N>.json)")

    # tag 索引：番剧页按标签筛选用。tags 只在详情分片里有，这里汇总成
    # {tag: [id...]}，前端选标签时才按需拉（约几百 KB）。
    tagmap = {}
    for p2 in sorted((SITE / "anime").glob("*.json")):
        try:
            recs = json.loads(p2.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            continue
        if not isinstance(recs, list):
            continue
        for rec in recs:
            if not isinstance(rec, dict) or not rec.get("id"):
                continue
            for t in (rec.get("tags") or [])[:12]:
                t = str(t).strip()
                if not t or len(t) > 20:
                    continue
                tagmap.setdefault(t, []).append(rec["id"])
    # 出现 3 次以下的多半是噪音标签；另外 TV/剧场版/OVA 这些和「类型」筛选重复，
    # 留在标签里只会让下拉更难找
    DUP_TYPE = {"TV", "剧场版", "OVA", "网络", "短片", "音乐", "其他", "WEB", "ONA"}
    tagmap = {t: ids for t, ids in tagmap.items()
              if len(ids) >= 3 and t not in DUP_TYPE}
    (ddir / "tags.json").write_text(
        json.dumps(tagmap, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    # 详情页要显示「标签 + 全站计数」，但没必要为几十个数字拉 365KB 的 tags.json，
    # 单独出一份 tag→count 的小表（约 40KB）。
    counts = {t: len(ids) for t, ids in tagmap.items()}
    (ddir / "tagcounts.json").write_text(
        json.dumps(counts, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"tags: {len(tagmap)} 个 / {sum(len(v) for v in tagmap.values())} 条映射；counts 已出")

    # 磁力层：把 prior 会话的 magnet-eps.js 一起部署，并在页面里引用
    mj = TPL / "magnet-eps.js"
    if mj.is_file():
        raw_me = mj.read_text(encoding="utf-8")
        mep = min_js(raw_me)
        (SITE / "magnet-eps.js").write_text(mep, encoding="utf-8")
        print(f"  magnet-eps.js: {len(raw_me.encode('utf-8'))} -> "
              f"{len(mep.encode('utf-8'))} B")
        print("magnet-eps.js: minified")

    # 媒体库页已下线：清掉旧产物，避免又被快照发布出去
    try:
        (SITE / "data" / "library.json").unlink()
    except OSError:
        pass


if __name__ == "__main__":
    main()
