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

# ---- 可选组件：提示词元数据写入 ----
# 独立成 save_node.py，不塞进 nodes.py：拷贝一份 dict 再合并，
# 避免直接改动 nodes 模块里那个 dict 对象。
# 加载失败只打日志，绝不拖垮主节点。
try:
    try:
        from .save_node import PromptCombinerMetaWriter, install_save_hooks, schedule_hook_install
    except ImportError:
        from save_node import PromptCombinerMetaWriter, install_save_hooks, schedule_hook_install
    NODE_CLASS_MAPPINGS = dict(NODE_CLASS_MAPPINGS)
    NODE_DISPLAY_NAME_MAPPINGS = dict(NODE_DISPLAY_NAME_MAPPINGS)
    NODE_CLASS_MAPPINGS["PromptCombinerMetaWriter"] = PromptCombinerMetaWriter
    NODE_DISPLAY_NAME_MAPPINGS["PromptCombinerMetaWriter"] = "✍️ 写入提示词元数据"
    # 旧名保留为别名：老工作流里若存了 PromptCombinerSaveImage，不会变成失踪节点。
    # 该类已不再保存图片，行为与上面的登记节点一致。
    NODE_CLASS_MAPPINGS["PromptCombinerSaveImage"] = PromptCombinerMetaWriter

    # 装钩子：
    #   ① 立刻试一次（能装多少算多少）
    #   ② 后台循环重试到注册表稳定（ComfyUI 是逐个 import 插件的，
    #      此刻 SaveImageClean 之类的节点很可能还没注册）
    try:
        install_save_hooks(verbose=False)
        schedule_hook_install()
    except Exception as _he:
        print("[prompt-combiner] 元数据钩子安装失败（不影响出图）:", _he)
except Exception as _e:
    print("[prompt-combiner] 提示词元数据组件加载失败（不影响抽签机）:", _e)

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
