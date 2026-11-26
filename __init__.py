"""ComfyUI 插件:Danbooru 抽签机

把「词库随机组合工具.html」（32 万 danbooru 标签 / 多槽位 / 5 档预设）搬进 ComfyUI。

- `nodes.py`    节点定义
- `core.py`     数据加载 + 池构建 + 抽词 + 格式化（从网页版移植，池已 42/42 对齐）
- `server.py`   给前端面板供数据的 HTTP API
- `js/`         前端面板（预设 / 槽位 / 预览 / 重抽）
- `data/`       词库与规则表（由网页工具导出，见 data/README.md）
"""

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

try:
    from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
except ImportError:      # 兼容「把插件目录塞进 sys.path 后直接 import」的加载方式
    from nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

# 导入即注册 HTTP 路由（挂在 PromptServer.instance.routes 上）。
# ⚠️ 这里的 `from server import PromptServer` 用的是**绝对导入**，
# 指向 ComfyUI 自己的 `server` 模块，不是本目录的 server.py —— 不会循环。
try:
    from . import server  # noqa: F401
except ImportError:
    try:
        import server  # noqa: F401
    except Exception as _e:      # 路由注册失败不该拖垮整个插件
        print("[prompt-combiner] HTTP 路由注册失败:", _e)

WEB_DIRECTORY = "./js"      # ComfyUI 会自动把该目录下的 JS 作为前端扩展加载

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
