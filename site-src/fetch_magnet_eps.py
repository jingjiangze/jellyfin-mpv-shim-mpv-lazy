#!/usr/bin/env python3
"""分集磁力索引 · CI 入口（实现见同目录 index_eps.py）。

为什么只做入口：这里原来是一份独立实现，建索引时用的是**发布组原名**
（`[JMAX] … OPテーマ「…」` 这种），而站点是靠弹窗里的片名查表的，
所以 8,851 条目录里只有 1.3% 能查到 —— 而且纯子串匹配会把
「我的英雄学院 I am a hero too」挂到正传 52 集上。现在统一走
index_eps.py：查询词用卡片标题本身，索引里也存同一个字符串，
匹配走精确 + 季号一致性。

保留文件名的原因：anime-magnet.yml 的 16 分片 matrix 直接
`python -u fetch_magnet_eps.py`，换实现不换入口，workflow 不用动。
"""
import pathlib
import runpy
import sys

sys.argv[0] = "index_eps.py"
runpy.run_path(str(pathlib.Path(__file__).with_name("index_eps.py")), run_name="__main__")
