#!/usr/bin/env python3
"""把分片里还是日文的 overview 自动翻成中文（公共谷歌 gtx 接口）。

数据链路：site/anime/<N>.json 是抓取产物（真源），build_site.py 每轮把它平铺成
site/data/s<N>.json 供前端按需拉。本脚本两边都写：只改 data/ 会被下一轮构建
用旧的 anime/ 分片覆盖回去。

翻译接口：https://translate.googleapis.com/translate_a/single?client=gtx
（免 key 的公共接口，实测返回 [[["译文","原文",...],...], ...]）。

为什么逐条翻译而不是拼块翻译：拼成 2000 字再按原文/译文长度比例切回各条目，
在换行、标点、专有名词处会漂移（实测切错条目），逐条一次请求最可靠。

并发：串行 3451 条 × 1–1.5s ≈ 50–85 分钟，超过 CI 的 45 分钟上限（实测跑到
40 分钟仍 in_progress、被 timeout 杀掉）。改为按分片分段 + 片内 WORKERS 线程并行，
每条请求前加 0–GAP 随机抖动避免同时打同一毫秒。实测 ≈10 分钟跑完 3451 条。
片内并发默认 4（2026-11-04 由 8 下调）：gtx 对高并发很快整片限流，上一轮
（site-sync run 41678297541）约 1,624 条成功后连片失败、白跑 20 分钟。

幂等：写回时新增 overview_ja 存日文原文（便于回滚 / 人工复核），
该字段已存在即视为「翻译过」，跳过。每写完一个分片立即落盘，
超时被杀也只丢当前分片，已翻译的部分保留。

容错：单条请求失败（429 / 5xx / 网络）最多尝试 4 次，退避 2s / 4s / 8s / 16s
（每档 ±30% 随机抖动），仍失败就跳过该条并记入 failed。失败原因按 HTTP 状态码 /
异常类名累加直方图，结束时打印——原实现 `except Exception: pass`，日志里看不到
到底是 429 还是超时，限流与网络故障分不开。

熔断：连续失败（按条目计，一条 4 次尝试全挂算 1 条）达到 CIRCUIT=25 就全体暂停
CIRCUIT_SLEEP=120 秒再继续；自上次成功起连续失败达到 CIRCUIT_HARD=120 就停止
整轮：没翻的条目原样保留在分片里（不写盘），下轮接着翻，不空转到 workflow 超时。

用法：
  cd site-src && python -u translate_overviews.py            # 正式翻译并写回
  cd site-src && python -u translate_overviews.py --dry-run  # 只统计，不联网不写盘
"""
import json
import os
import pathlib
import random
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed

HERE = pathlib.Path(__file__).resolve().parent
SITE = HERE / "site"
DATA = SITE / "data"          # s<N>.json（build_site.py 平铺出来的前端分片）
ANIME = SITE / "anime"        # <N>.json（抓取真源）
SHARD_TOTAL = 64

GTX = "https://translate.googleapis.com/translate_a/single"
GAP = 0.5                     # 单条请求前的随机抖动上限（秒），避免同刻并发
WORKERS = int(os.environ.get("TR_WORKERS", "4") or 4)   # 片内并发数

# ---- 重试 / 熔断参数 ----
RETRIES = 4                   # 单条最多尝试次数（原 3 次）
BACKOFF = (2, 4, 8, 16)       # 第 N 次重试前的基准退避（秒），实乘 0.7–1.3
CIRCUIT = 25                  # 连续失败达到即全体休息
CIRCUIT_HARD = 120            # 自上次成功起连续失败达到即停止整轮
CIRCUIT_SLEEP = 120           # 熔断休息时长（秒）

FAIL_REASONS = Counter()      # 本次运行的失败原因直方图：{"429": 1600, "TimeoutError": 71}
_fail_lock = threading.Lock() # Counter 的 += 不是原子读改写，多线程必须加锁
_gate = threading.Event()     # clear = 全体暂停（限流休息中）；worker 请求前等它
_gate.set()
_consec = 0                   # 连续失败（条目计；成功或休息一次后清零）
_consec_total = 0             # 自上次成功起连续失败总数（判硬熔断）
hard_stop = False             # 硬熔断已触发：本轮不再发起翻译

# 假名：平假名 3041-3096 / 309D-309F，片假名 30A1-30FA / 30FD-30FE。
# ・(U+30FB) 间隔号、ー(U+30FC) 长音符都不是假名（日文片假名名也常用），
# 落在区间外才不会把「ア・イ」「コーヒー」这类算错。
KANA = re.compile(r"[\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FD-\u30FE]")
HAN = re.compile(r"[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]")
LATIN = re.compile(r"[A-Za-z]")


def detect_lang(text):
    """返回 'ja' / 'zh' / 'en' / ''。假名占比 >= 0.30 判日文。

    中文条目里夹日文专名（「…的《進撃の巨人》」）假名占比远低于 0.30，
    判 zh；纯日文条目（kana / (kana + han) 通常 0.45 以上）判 ja。
    """
    t = (text or "").strip()
    if not t:
        return ""
    kana = len(KANA.findall(t))
    han = len(HAN.findall(t))
    if kana + han == 0:
        return "en" if LATIN.search(t) else ""
    if kana / (kana + han) >= 0.30:
        return "ja"
    if han:
        return "zh"
    return "en" if LATIN.search(t) else ""


def gtx_translate(text, sl="ja", tl="zh-CN"):
    """调 gtx 接口，返回译文。失败抛异常，由调用方重试。"""
    params = urllib.parse.urlencode(
        {"client": "gtx", "sl": sl, "tl": tl, "dt": "t", "q": text})
    req = urllib.request.Request(GTX + "?" + params, headers={
        "user-agent": "Mozilla/5.0 (compatible; anime-site/1.0)"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read().decode("utf-8"))
    # 返回格式：[[["译","原",...],["译2","原2",...]], ...]
    return "".join(seg[0] for seg in (data[0] or []) if len(seg) > 0)


def translate_one(text):
    """单条翻译：最多 RETRIES 次，退避 2/4/8/16 秒（±30% 抖动）。

    返回 (译文, 失败原因)：成功是 ("译文", "")；全失败是 ("", "429" / "TimeoutError" /
    "empty")。不吞异常——把状态码或异常类名带出去，由调用方累加直方图。
    """
    reason = ""
    for attempt in range(RETRIES):
        try:
            out = (gtx_translate(text) or "").strip()
            if out:
                return out, ""
            reason = "empty"              # 接口返回空译文，同样按失败重试
        except urllib.error.HTTPError as e:
            reason = str(e.code)          # 429 限流 / 5xx，状态码单独记账
        except Exception as e:            # URLError / TimeoutError / JSONDecodeError …
            reason = type(e).__name__
        if attempt < RETRIES - 1:
            base = BACKOFF[min(attempt, len(BACKOFF) - 1)]
            time.sleep(base * random.uniform(0.7, 1.3))
    return "", reason


def note_result(reason):
    """记一条翻译结果（reason 为空 = 成功），返回 True 表示硬熔断触发。

    只在主线程（收集结果那一侧）调用，所以 _consec 这几个计数不加锁；
    FAIL_REASONS 仍套 _fail_lock，免得将来从 worker 里调时静默丢计数。
    """
    global _consec, _consec_total, hard_stop
    if not reason:
        _consec = _consec_total = 0
        return False
    with _fail_lock:
        FAIL_REASONS[reason] += 1
    _consec += 1
    _consec_total += 1
    if _consec_total >= CIRCUIT_HARD:
        hard_stop = True
        _gate.set()               # 放行在等闸门的 worker，让它们收尾返回
        print(f"! 连续失败 {_consec_total} 条，达到硬上限 {CIRCUIT_HARD}，停止整轮",
              flush=True)
        return True
    if _consec >= CIRCUIT:
        _consec = 0
        print(f"! 连续失败 {CIRCUIT} 条，疑似限流，全体暂停 {CIRCUIT_SLEEP} 秒",
              flush=True)
        _gate.clear()
        time.sleep(CIRCUIT_SLEEP)
        _gate.set()
    return False


def load_list(path):
    try:
        rows = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return rows if isinstance(rows, list) else None


def dump(path, rows):
    path.write_text(json.dumps(rows, ensure_ascii=False, separators=(",", ":")),
                    encoding="utf-8")


def sync_source(n, changes):
    """把 {id: (中文, 日文原文)} 同步到 site/anime/<n>.json（真源分片）。

    只在源分片里找得到对应 id 时改那几条，不整表覆盖，避免用 data/ 的旧副本
    盖掉源分片里更完整的记录。
    """
    src = ANIME / f"{n}.json"
    if not src.is_file():
        return 0
    rows = load_list(src)
    if rows is None:
        return 0
    hit = 0
    for rec in rows:
        if not isinstance(rec, dict):
            continue
        ch = changes.get(rec.get("id"))
        if not ch:
            continue
        rec["overview"], rec["overview_ja"] = ch
        hit += 1
    if hit:
        dump(src, rows)
    return hit


def _job(item):
    """线程池任务：等闸门 → 随机抖动 → 翻译一条。

    返回 (rec, 日文原文, 中文, 失败原因)。
    """
    rec, ov = item
    _gate.wait()                  # 熔断休息期间挂起，不往 gtx 上继续打
    time.sleep(random.uniform(0, GAP))
    zh, reason = translate_one(ov)
    return rec, ov, zh, reason


def run_batch(todo):
    """并行翻一批；硬熔断时提前收手。

    返回 (results, pending)：results 是已拿到结果的 (rec, ov, zh, reason)，
    pending 是本批还没拿到结果（原样留待下轮）的条目数。
    """
    results = []
    if WORKERS <= 1:
        for item in todo:
            results.append(_job(item))
            if note_result(results[-1][3]):
                break
        return results, len(todo) - len(results)

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = [ex.submit(_job, it) for it in todo]
        try:
            for fut in as_completed(futs):
                results.append(fut.result())
                if note_result(results[-1][3]):
                    break
        finally:
            for f in futs:
                f.cancel()        # 还没开跑的取消；在跑的会正常返回，等它收尾
    return results, len(todo) - len(results)


def main():
    dry = "--dry-run" in sys.argv[1:]
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    translated = skipped = 0
    failed = []
    files = 0
    remaining = 0                # 硬熔断后没翻的条目数（原样留待下轮）
    for n in range(SHARD_TOTAL):
        p = ANIME / f"{n}.json"   # site-sync 里 Translate 排在 Build pages 之前，此时 data/ 还不存在，真源在 anime/
        if not p.is_file():
            continue
        rows = load_list(p)
        if rows is None:
            print(f"! s{n}.json 不是合法 JSON 数组，跳过")
            continue
        files += 1
        todo = []
        for rec in rows:
            if not isinstance(rec, dict):
                continue
            ov = (rec.get("overview") or "").strip()
            if not ov:
                continue
            if rec.get("overview_ja"):
                skipped += 1
                continue
            if detect_lang(ov) != "ja":
                continue
            if dry:
                translated += 1
                continue
            todo.append((rec, ov))
        if not todo:
            continue
        if hard_stop:
            remaining += len(todo)    # 已熔断：这些条目原样留在分片里
            continue

        results, pending = run_batch(todo)
        remaining += pending

        changes = {}
        for rec, ov, zh, _reason in results:
            if not zh:
                failed.append(rec.get("id"))
                continue
            rec["overview"] = zh
            rec["overview_ja"] = ov
            changes[rec.get("id")] = (zh, ov)
            translated += 1
        if changes:
            # 每个分片写完立刻落盘：超时被杀时前面的成果不会白费
            dump(p, rows)
            back = sync_source(n, changes)
            print(f"  s{n}.json：写入 {len(changes)} 条中文简介"
                  f"（同步到 anime/{n}.json {back} 条，累计 {translated}）",
                  flush=True)

    tag = "（dry-run，未翻译未写盘）" if dry else ""
    print(f"扫描 {files} 个分片{tag}")
    if dry:
        print(f"待翻译 {translated} 条 / 跳过（已翻译）{skipped} 条 / 失败 0 条")
        return
    print(f"翻译完成 {translated} 条 / 跳过（已翻译）{skipped} 条 / 失败 {len(failed)} 条")
    if FAIL_REASONS:
        print(f"失败原因：{dict(FAIL_REASONS.most_common())}")
    if failed:
        print("失败 id（前 20）：" + ", ".join(str(x) for x in failed[:20]))
    if hard_stop:
        print(f"! 触发限流熔断，剩余 {remaining} 条留待下轮", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"! translate 失败：{type(e).__name__}: {e}", file=sys.stderr)
