#!/usr/bin/env python3
"""生成 / 修改 Cache Rule 的 rules 数组（供 .github/workflows/cf-cache-rule.yml 调用）。

用法：
  python3 cf_cache_rule.py show   <ruleset.json>
  python3 cf_cache_rule.py apply  <ruleset.json> <out.json>
  python3 cf_cache_rule.py remove <ruleset.json> <out.json>

ruleset.json 是 CF 的 GET .../http_request_cache_settings/entrypoint 响应；
文件不存在或 404 时按「没有任何规则」处理。
"""
import json
import pathlib
import sys

DESC = "anime site: cache everything at edge"


def load(path):
    p = pathlib.Path(path)
    if not p.is_file():
        return []
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except ValueError:
        return []
    return (d.get("result") or {}).get("rules") or []


def main():
    act = sys.argv[1]
    rules = load(sys.argv[2])
    host = "anime.jiangjiangze.icu"
    mine = [r for r in rules if r.get("description") == DESC]

    print(f"现有规则 {len(rules)} 条，其中本规则 {len(mine)} 条")
    for r in rules:
        print("  -", (r.get("description") or "(无描述)")[:50], "|", (r.get("expression") or "")[:70])

    if act == "show":
        return 0

    if act == "remove":
        rules = [r for r in rules if r.get("description") != DESC]
    elif act == "apply":
        if mine:
            print("已存在，跳过创建")
        else:
            rules.append({
                "action": "set_cache_settings",
                "description": DESC,
                "enabled": True,
                "expression": '(http.host eq "%s")' % host,
                "action_parameters": {
                    "cache": True,
                    # 覆盖源站 60s，让边缘缓存 5 分钟；部署后最多 5 分钟看到新版
                    "edge_ttl": {"mode": "override_origin", "default": 300},
                    "browser_ttl": {"mode": "respect_origin"},
                    # 缓存键忽略查询串：站内请求都是纯路径，带上 ?cb= 之类不该产生新条目
                    "cache_key": {
                        "custom_key": {
                            "query_string": {"exclude": "*"},
                            "header": {"include": []},
                            "cookie": {"include": []},
                            "host": {"resolved": True},
                        }
                    },
                },
            })
            print("已追加规则")
    else:
        print("未知动作", act, file=sys.stderr)
        return 2

    pathlib.Path(sys.argv[3]).write_text(json.dumps({"rules": rules}), encoding="utf-8")
    print("写出", sys.argv[3], "规则数", len(rules))
    return 0


if __name__ == "__main__":
    sys.exit(main())
