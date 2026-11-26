# 运行时状态：暂存抽签机最近一次的输出，供 SaveImage 钩子补写图片元数据
#
# 为什么需要全局状态：ComfyUI 的节点之间只传 tensor / 字符串，SaveImage 拿不到
# 「上游某个节点这次输出了什么」。要让原生 SaveImage 自动带上提示词，只能在
# 抽签机跑完时把结果暂存，保存时再取。
#
# ⚠️ 这是**进程级**的最近一次记录，并发跑多个工作流时会互相覆盖。
#    ComfyUI 默认单队列顺序执行，实际不会撞；真要并行，请用
#    「💾 保存图片（含提示词）」节点显式连线，那条路没有共享状态。

import time

_LAST = {"text": "", "ts": 0.0}

# 超过这个秒数的记录视为过期，不写进图片（防止重启后残留的旧值串到新图上）
MAX_AGE = 300.0


def remember(text):
    """抽签机每跑一次就记一次。"""
    _LAST["text"] = text or ""
    _LAST["ts"] = time.time()


def recent(max_age=None):
    """取最近一次输出；过期或为空则返回空串。"""
    if not _LAST["text"]:
        return ""
    age = time.time() - _LAST["ts"]
    if age > (max_age if max_age is not None else MAX_AGE):
        return ""
    return _LAST["text"]


def clear():
    _LAST["text"] = ""
    _LAST["ts"] = 0.0
