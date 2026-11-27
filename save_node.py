# ComfyUI 组件:把抽签结果写进 PNG 元数据
#
# 两件事，分工明确：
#
#   1. ✍️ 写入提示词元数据（PromptCombinerMetaWriter）
#      纯登记节点 —— **不接收图片、不保存任何文件**。
#      它只把提示词（可选备注 / 结构化标签）记进进程状态，等保存节点落盘后由钩子写入。
#
#   2. install_save_hooks()
#      包装**所有已注册的保存节点**，图片写完就地插入 anima_prompt chunk。
#      覆盖原生 SaveImage、SaveImageClean（comfyui-save-image-organized）等
#      任何 NODE_CLASS_MAPPINGS 里名字含 saveimage 且 FUNCTION 可调用的类。
#
# 为什么不做"接收图片但不保存"的节点：
#   ComfyUI 节点之间只传 tensor，拿不到磁盘路径；PNG 元数据是文件结构的一部分，
#   必须在文件写完之后才能改。所以"写元数据"只能挂在保存动作之后，
#   靠一个纯登记节点 + 保存后置钩子来配合。
#
# 为什么用字节插入而不是 PIL 重存：
#   PIL 重新 save 会丢掉 iCCP / pHYs / sRGB 等非文本 chunk，色彩配置可能受影响。
#   这里直接在 IEND 前插 iTXt，像素零改动（实测逐像素一致，文件仅 +67 字节）。

import json
import os
import time

try:
    import folder_paths
except ImportError:      # 脱离 ComfyUI 单独测试时用
    folder_paths = None

try:
    from comfy.cli_args import args as _cli_args
    _DISABLE_META = bool(getattr(_cli_args, "disable_metadata", False))
except Exception:
    _DISABLE_META = False

try:
    from . import state as _state
except ImportError:
    try:
        import state as _state
    except Exception:
        _state = None


# ================================================================ 纯登记节点

class PromptCombinerMetaWriter:
    """把提示词写进指定图片的元数据。**不保存图片。**

    两种用法，优先走第一种（可靠、可见、不看加载顺序）：

      ① 显式接线（推荐）
         SaveImageClean.FILE_PATH ──→ file_path
         🎲 抽签机.标签组合结果 ────→ prompt_text
         SaveImageClean 先把图写盘并返回绝对路径，本节点拿到路径后直接改文件。

      ② 不接 file_path（后备）
         只把提示词记进进程状态，由保存后置钩子在下次落盘时补写。
         这条路依赖钩子装得上，不如 ① 稳。
    """

    def __init__(self):
        self.output_dir = folder_paths.get_output_directory() if folder_paths else "."

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt_text": ("STRING", {
                    "forceInput": True, "multiline": True,
                    "tooltip": "接抽签机的「标签组合结果」。会写进 PNG 的 anima_prompt",
                }),
            },
            "optional": {
                "file_path": ("STRING", {
                    "forceInput": True, "multiline": False,
                    "tooltip": "接保存节点的 FILE_PATH / 文件路径输出（SaveImageClean 第二个输出）。"
                               "填了就直接写这个文件；留空则只登记，等钩子补写",
                }),
                "note": ("STRING", {
                    "default": "", "multiline": False,
                    "tooltip": "备注，写进 anima_note。可填模型名 / 版本 / 实验编号",
                }),
                "tags_json": ("STRING", {
                    "forceInput": True, "multiline": True,
                    "tooltip": "可选。结构化标签（JSON 数组），写进 anima_slots，方便程序解析",
                }),
                "write_log": ("BOOLEAN", {
                    "default": False,
                    "label_on": "同时记录日志", "label_off": "不记",
                    "tooltip": "额外把每次结果追加一行到 output/_anima_prompts.jsonl，方便批量检索",
                }),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt_text",)
    FUNCTION = "write_meta"
    OUTPUT_NODE = True
    CATEGORY = "Danbooru 抽签机"
    DESCRIPTION = ("把提示词写进指定 PNG 的元数据（anima_prompt / anima_note / anima_slots）。"
                   "不保存图片。接 SaveImageClean 的 FILE_PATH 最稳。")

    def write_meta(self, prompt_text, file_path="", note="", tags_json="", write_log=False):
        text = str(prompt_text or "")
        fp = str(file_path or "").strip().strip('"').strip("'")

        meta = {}
        if text.strip():
            meta["anima_prompt"] = text
        if note:
            meta["anima_note"] = note
        if tags_json and tags_json.strip():
            meta["anima_slots"] = tags_json

        # ① 有明确路径 → 直接写文件（最可靠）
        report = ""
        if fp and meta:
            targets, err = self._resolve_targets(fp)
            if err:
                report = f"[失败] {err}"
                print(f"[prompt-combiner] {err}")
            else:
                done = sum(1 for p in targets if inject_meta(p, meta))
                report = f"已写入 {done}/{len(targets)} 个文件"
                print(f"[prompt-combiner] {report}  ← {fp}")

        # ② 没给路径 → 记进状态，交给钩子
        elif text.strip() and _state is not None:
            _state.remember(text, note=note or "", tags=tags_json or "")
            report = "已登记（等保存节点的钩子补写）"

        if write_log and text.strip() and folder_paths is not None:
            self._append_log(text, note, tags_json)

        # 节点上显示结果，看得见才算数
        ui_text = text if text.strip() else "(空提示词)"
        if report:
            ui_text = f"{ui_text}\n\n---\n{report}"
        return {"ui": {"text": [ui_text]}, "result": (text,)}

    def _resolve_targets(self, fp):
        """把输入路径解析成待写的 PNG 列表。支持单文件 / 目录 / 逗号分隔多路径。"""
        if not os.path.exists(fp):
            return [], f"路径不存在: {fp}"

        out = []
        if os.path.isfile(fp):
            if not fp.lower().endswith(".png"):
                return [], f"只支持 PNG，当前是 {os.path.splitext(fp)[1] or '无扩展名'}"
            return [fp], None

        # 目录：写里面的 PNG（不递归，避免误伤一堆历史图）
        for name in sorted(os.listdir(fp)):
            if name.lower().endswith(".png"):
                out.append(os.path.join(fp, name))
        if not out:
            return [], f"目录里没有 PNG: {fp}"
        return out, None

    def _append_log(self, text, note, tags_json):
        try:
            p = os.path.join(self.output_dir, "_anima_prompts.jsonl")
            rec = {"ts": time.strftime("%Y-%m-%d %H:%M:%S"), "prompt": text}
            if note:
                rec["note"] = note
            if tags_json and tags_json.strip():
                try:
                    rec["tags"] = json.loads(tags_json)
                except Exception:
                    rec["tags_raw"] = tags_json
            with open(p, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        except Exception as e:
            print(f"[prompt-combiner] 写提示词日志失败: {e}")


# ================================================================ PNG 元数据

def _png_find_text(data: bytes, key: str) -> bool:
    return key.encode("latin-1") + b"\x00" in data


def _png_insert_itxt(data: bytes, key: str, value: str) -> bytes:
    """在 IEND 之前插入一个 iTXt chunk（UTF-8，支持中文）。"""
    import struct
    import zlib

    # iTXt 结构：keyword\0 compression_flag compression_method language\0 translated\0 text
    payload = (key.encode("latin-1") + b"\x00"
               + b"\x00" + b"\x00"          # 未压缩
               + b"\x00"                     # language tag 空
               + b"\x00"                     # translated keyword 空
               + value.encode("utf-8"))
    chunk = (struct.pack(">I", len(payload)) + b"iTXt" + payload
             + struct.pack(">I", zlib.crc32(b"iTXt" + payload) & 0xFFFFFFFF))

    pos = data.rfind(b"IEND")
    if pos < 4:
        raise ValueError("不是合法 PNG（找不到 IEND）")
    pos -= 4                                 # IEND 前的长度字段
    return data[:pos] + chunk + data[pos:]


def inject_meta(path, meta, key="anima_prompt"):
    """把元数据写进已保存的 PNG。已存在同名键则跳过（幂等）。

    meta 传 str  → 写单个键（默认 anima_prompt）
    meta 传 dict → 逐个键写入
    """
    try:
        if isinstance(meta, dict):
            items = {k: v for k, v in meta.items() if v not in (None, "")}
        else:
            items = {key: meta}

        if not items:
            return False

        with open(path, "rb") as f:
            data = f.read()
        if not data.startswith(b"\x89PNG\r\n\x1a\n"):
            return False                     # 非 PNG 跳过（webp/jpg 不支持）

        changed = False
        for k, v in items.items():
            if _png_find_text(data, k):
                continue                     # 已有该键，不重复插
            data = _png_insert_itxt(data, k, str(v))
            changed = True

        if not changed:
            return True
        with open(path, "wb") as f:
            f.write(data)
        return True
    except Exception as e:
        print(f"[prompt-combiner] 写元数据失败 {os.path.basename(str(path))}: {e}")
        return False


# ================================================================ 保存节点钩子

_HOOKED_CLASSES = set()


def _paths_from_result(node, res):
    """从保存节点的返回值里提取刚写盘的 PNG 绝对路径。"""
    paths = []

    if not isinstance(res, dict):
        # 少数节点直接返回 tuple
        if isinstance(res, (list, tuple)):
            for v in res:
                if isinstance(v, str) and v.lower().endswith(".png") and os.path.exists(v):
                    paths.append(v)
        return paths

    # ① 标准 ui.images（原生 SaveImage / SaveImageClean 都有）
    base = getattr(node, "output_dir", None)
    for item in (res.get("ui") or {}).get("images") or []:
        if not isinstance(item, dict):
            continue
        fn = item.get("filename")
        if not fn:
            continue
        sub = item.get("subfolder") or ""
        candidates = []
        if base:
            candidates.append(os.path.join(base, sub, fn))
        candidates.append(os.path.join(sub, fn) if sub else fn)
        for p in candidates:
            if os.path.exists(p):
                paths.append(p)
                break

    # ② result 里的绝对路径（SaveImageClean 的 FILE_PATH）
    r = res.get("result")
    if isinstance(r, (list, tuple)):
        for v in r:
            if isinstance(v, str) and v.lower().endswith(".png") and os.path.exists(v):
                paths.append(v)

    return paths


def _inject_after_save(node, res):
    if _state is None or _DISABLE_META:
        return
    if getattr(node, "type", "output") != "output":
        return                          # 不碰 PreviewImage 的临时文件

    info = _state.recent_full() if hasattr(_state, "recent_full") else None
    if not info or not info.get("text"):
        return

    meta = {"anima_prompt": info["text"]}
    if info.get("note"):
        meta["anima_note"] = info["note"]
    if info.get("tags"):
        meta["anima_slots"] = info["tags"]

    for p in dict.fromkeys(_paths_from_result(node, res)):
        if p.lower().endswith(".png"):
            inject_meta(p, meta)


def _wrap_save_class(name, cls):
    """包装一个保存类的 FUNCTION 方法。返回是否新装。"""
    if cls in _HOOKED_CLASSES:
        return False

    fn_name = getattr(cls, "FUNCTION", None)
    if not fn_name or not callable(getattr(cls, fn_name, None)):
        # 少数节点没声明 FUNCTION，按约定俗成的名字兜底
        fn_name = "save_images" if callable(getattr(cls, "save_images", None)) else None
    if not fn_name:
        return False

    orig = getattr(cls, fn_name)
    if getattr(orig, "_anima_hooked", False):
        _HOOKED_CLASSES.add(cls)
        return False

    def patched(self, *args, **kwargs):
        res = orig(self, *args, **kwargs)
        try:
            _inject_after_save(self, res)
        except Exception as e:
            # 写元数据失败绝不能影响出图
            print("[prompt-combiner] 元数据写入异常:", e)
        return res

    patched._anima_hooked = True
    patched.__name__ = getattr(orig, "__name__", "save_images")
    patched.__doc__ = getattr(orig, "__doc__", None)
    setattr(cls, fn_name, patched)
    _HOOKED_CLASSES.add(cls)
    return True


def install_save_hooks(verbose=True):
    """包装所有已注册的保存节点，落盘后自动补写提示词。

    覆盖范围：NODE_CLASS_MAPPINGS 里类名含 saveimage 的全部节点
    （原生 SaveImage、SaveImageClean、以及将来装的同类插件）。

    ⚠️ 必须在**所有插件加载完之后**调用才完整 —— 所以 nodes.py 的 run() 里
       每次都会调一次（内部有幂等判断，重复调用几乎零开销）。

    开关：环境变量 `ANIMA_META_HOOK=0` 关闭。
    """
    if os.environ.get("ANIMA_META_HOOK", "1") == "0":
        if verbose:
            print("[prompt-combiner] ANIMA_META_HOOK=0，图片元数据钩子已关闭")
        return []

    import sys as _sys
    mod = _sys.modules.get("nodes")
    mapping = getattr(mod, "NODE_CLASS_MAPPINGS", None) if mod else None
    if not mapping:
        if verbose:
            print("[prompt-combiner] 找不到 ComfyUI 的节点注册表，钩子暂未安装")
        return []

    newly = []
    for name, cls in list(mapping.items()):
        if "saveimage" not in str(name).lower().replace("_", ""):
            continue
        try:
            if _wrap_save_class(name, cls):
                newly.append(name)
        except Exception as e:
            if verbose:
                print(f"[prompt-combiner] 包装 {name} 失败: {e}")

    if verbose:
        if newly:
            print(f"[prompt-combiner] 已安装图片元数据钩子: {', '.join(newly)}")
        elif not _HOOKED_CLASSES:
            print("[prompt-combiner] 未找到可包装的保存节点")
    return newly


# 兼容旧名（__init__.py 早期版本调用过这个）
install_saveimage_hook = install_save_hooks


def schedule_hook_install(max_wait=90.0, interval=2.0):
    """后台线程反复尝试装钩子，直到保存类数量稳定或超时。

    为什么需要：ComfyUI 是逐个 import custom_nodes 的。先加载的插件调用
    install_save_hooks() 时，后加载插件的节点还没进 NODE_CLASS_MAPPINGS ——
    实测本机启动日志：钩子在 11:11:38 装好，comfyui-save-image-organized
    到 11:11:43 才加载完，SaveImageClean 全程没被包装过。

    所以不能只赌一次。这里每 2 秒重试一遍（install 内部幂等），
    连续 3 轮没有新增就认为注册表稳定，收工。
    """
    import threading

    def _loop():
        deadline = time.time() + max_wait
        last = -1
        stable = 0
        while time.time() < deadline:
            try:
                install_save_hooks(verbose=False)
                n = len(_HOOKED_CLASSES)
                if n == last:
                    stable += 1
                    if stable >= 3:
                        break
                else:
                    stable = 0
                    last = n
            except Exception:
                pass
            time.sleep(interval)

        names = []
        try:
            import sys as _sys
            mod = _sys.modules.get("nodes")
            mapping = getattr(mod, "NODE_CLASS_MAPPINGS", {}) if mod else {}
            for n, cls in mapping.items():
                if "saveimage" not in str(n).lower().replace("_", ""):
                    continue
                fn = getattr(cls, "FUNCTION", "save_images")
                if getattr(getattr(cls, fn, None), "_anima_hooked", False):
                    names.append(n)
        except Exception:
            pass
        print(f"[prompt-combiner] 图片元数据钩子就绪: {', '.join(names) or '（无）'}")

    t = threading.Thread(target=_loop, daemon=True, name="anima-hook-install")
    t.start()
    return t


# ---------------------------------------------------------------- 自测
# 直接跑：python save_node.py
if __name__ == "__main__":
    import tempfile
    from PIL import Image

    tmp = os.path.join(tempfile.gettempdir(), "_anima_meta_test.png")
    Image.new("RGB", (64, 64), (30, 40, 60)).save(tmp, compress_level=4)
    before = os.path.getsize(tmp)

    sample_prompt = ("masterpiece, best quality, score_7, 1girl, solo, "
                     "hatsune_miku, vocaloid, smile, long hair, twintails")
    sample_slots = json.dumps([
        {"slot": "角色", "prompt": "hatsune_miku", "name": "初音未来（VOCALOID）"},
        {"slot": "发型", "prompt": "twintails", "name": "双马尾"},
    ], ensure_ascii=False)

    ok = inject_meta(tmp, {
        "anima_prompt": sample_prompt,
        "anima_note": "MiaoMiao Harem v1.20z + Turbo LoRA · 测试备注",
        "anima_slots": sample_slots,
    })
    print(f"写入: {ok}   文件 {before} → {os.path.getsize(tmp)} 字节")

    back = Image.open(tmp)
    print("\n=== 读回 ===")
    for k in ("anima_prompt", "anima_note", "anima_slots"):
        print(f"[{k}] {back.text.get(k)}")

    print(f"\n提示词一致: {back.text.get('anima_prompt') == sample_prompt}")

    # 幂等
    n1 = os.path.getsize(tmp)
    inject_meta(tmp, {"anima_prompt": "不该覆盖"})
    print(f"幂等（大小不变）: {os.path.getsize(tmp) == n1}")
    print(f"原值保留: {Image.open(tmp).text.get('anima_prompt') == sample_prompt}")
