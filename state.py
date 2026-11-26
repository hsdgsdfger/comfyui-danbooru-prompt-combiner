# 运行时状态：暂存抽签机最近一次的输出，供保存节点钩子补写图片元数据
#
# 为什么需要全局状态：ComfyUI 的节点之间只传 tensor / 字符串，保存节点拿不到
# 「上游某个节点这次输出了什么」。要让已有的 SaveImage / SaveImageClean 自动带上
# 提示词，只能在抽签机跑完（或登记节点跑完）时把结果暂存，保存时再取。
#
# ⚠️ 这是**进程级**的最近一次记录，并发跑多个工作流时会互相覆盖。
#    ComfyUI 默认单队列顺序执行，实际不会撞。

import time

_LAST = {"text": "", "note": "", "tags": "", "ts": 0.0}

# 超过这个秒数的记录视为过期，不写进图片（防止残留的旧值串到新图上）
MAX_AGE = 300.0


def remember(text, note=None, tags=None):
    """记一次输出。

    note / tags 传 None 表示「保持原值不清空」：
    抽签机只传 text，登记节点再补 note / tags，两者不会互相冲掉。
    """
    _LAST["text"] = text or ""
    _LAST["ts"] = time.time()
    if note is not None:
        _LAST["note"] = note or ""
    if tags is not None:
        _LAST["tags"] = tags or ""


def recent(max_age=None):
    """取最近一次提示词；过期或为空则返回空串。"""
    if not _LAST["text"]:
        return ""
    age = time.time() - _LAST["ts"]
    if age > (max_age if max_age is not None else MAX_AGE):
        return ""
    return _LAST["text"]


def recent_full(max_age=None):
    """取完整记录（text / note / tags）；过期或为空返回 None。"""
    if not _LAST["text"]:
        return None
    age = time.time() - _LAST["ts"]
    if age > (max_age if max_age is not None else MAX_AGE):
        return None
    return {"text": _LAST["text"], "note": _LAST["note"], "tags": _LAST["tags"]}


def clear():
    _LAST["text"] = ""
    _LAST["note"] = ""
    _LAST["tags"] = ""
    _LAST["ts"] = 0.0
