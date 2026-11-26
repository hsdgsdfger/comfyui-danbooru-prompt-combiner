# ComfyUI 节点:带提示词元数据的图片保存
#
# 原生 SaveImage 只把 workflow 的**静态参数**写进 PNG，其中不含「这次运行时实际
# 抽出了哪些标签」——因为 PromptCombiner 的输出是运行时生成的字符串，不在
# widgets_values 里。想靠图片回溯用了什么标签，只能重新跑一遍 seed。
#
# 这个节点把 PromptCombiner 的实际输出一并写进 PNG 的 iTXt chunk，键名：
#   anima_prompt   完整提示词（纯文本，可直接看）
#   anima_note     用户备注（模型名 / 版本 / 实验编号）
#   anima_slots    结构化标签表（JSON，含槽位，方便程序解析）
#
# iTXt 是 UTF-8，中文备注不会炸；tEXt 只支持 latin-1，中文会 UnicodeEncodeError。

import json
import os

import numpy as np
from PIL import Image, PngImagePlugin

try:
    import folder_paths
except ImportError:      # 脱离 ComfyUI 单独测试时用
    folder_paths = None

try:
    from comfy.cli_args import args as _cli_args
    _DISABLE_META = bool(getattr(_cli_args, "disable_metadata", False))
except Exception:
    _DISABLE_META = False


def write_png_with_meta(path, img, meta: dict, compress_level=4):
    """把 PIL Image 存成 PNG，并把 meta 里的键值写成 iTXt chunk。

    单独抽出来的原因：脱离 ComfyUI 也能测（见文件末尾 __main__）。
    非 ASCII 走 iTXt；纯 ASCII 走 tEXt（兼容更老的读取工具）。
    """
    info = PngImagePlugin.PngInfo()
    for k, v in meta.items():
        if v is None:
            continue
        s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
        try:
            s.encode("latin-1")
            info.add_text(k, s)          # 纯 ASCII，老工具也认
        except UnicodeEncodeError:
            info.add_itxt(k, s)          # 含中文 → UTF-8
    img.save(path, pnginfo=info, compress_level=compress_level)
    return path


class PromptCombinerSaveImage:
    """保存图片，并把抽签机产出的提示词写进图片元数据。"""

    def __init__(self):
        self.output_dir = folder_paths.get_output_directory() if folder_paths else "."
        self.type = "output"
        self.compress_level = 4

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE", {"tooltip": "要保存的图片"}),
                "prompt_text": ("STRING", {
                    "forceInput": True, "multiline": True,
                    "tooltip": "接抽签机的「标签组合结果」。会写进图片的 anima_prompt",
                }),
                "filename_prefix": ("STRING", {"default": "Anima"}),
            },
            "optional": {
                "note": ("STRING", {
                    "default": "", "multiline": False,
                    "tooltip": "备注，写进 anima_note。可填模型名/版本/实验编号",
                }),
                "tags_json": ("STRING", {
                    "forceInput": True, "multiline": True,
                    "tooltip": "可选。接结构化标签（JSON 数组），写进 anima_slots，方便程序解析",
                }),
            },
            "hidden": {
                "prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "save_images"
    OUTPUT_NODE = True
    CATEGORY = "Danbooru 抽签机"
    DESCRIPTION = ("保存图片并把提示词写进 PNG 元数据（anima_prompt / anima_note / "
                   "anima_slots）。替代原生 SaveImage 使用，排查用哪套标签时直接看图片属性。")

    def save_images(self, images, prompt_text, filename_prefix="Anima",
                    note="", tags_json="", prompt=None, extra_pnginfo=None):
        if folder_paths is None:
            raise RuntimeError("此节点需要运行在 ComfyUI 内（folder_paths 不可用）")

        full_output_folder, filename, counter, subfolder, filename_prefix = \
            folder_paths.get_save_image_path(
                filename_prefix, self.output_dir,
                images[0].shape[1], images[0].shape[0])

        results = []
        for batch_number, image in enumerate(images):
            arr = 255. * image.cpu().numpy()
            img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))

            meta = {}
            if not _DISABLE_META:
                # 保留原生行为：workflow 与 API prompt 照写，不影响其他工具读取
                if prompt is not None:
                    meta["prompt"] = json.dumps(prompt, ensure_ascii=False)
                if extra_pnginfo is not None:
                    for x in extra_pnginfo:
                        meta[x] = json.dumps(extra_pnginfo[x], ensure_ascii=False)
                # 本项目新增
                meta["anima_prompt"] = prompt_text or ""
                meta["anima_note"] = note or ""
                if tags_json and tags_json.strip():
                    meta["anima_slots"] = tags_json

            fname = filename.replace("%batch_num%", str(batch_number))
            file = f"{fname}_{counter:05}_.png"
            write_png_with_meta(os.path.join(full_output_folder, file), img, meta,
                                self.compress_level)
            results.append({"filename": file, "subfolder": subfolder, "type": self.type})
            counter += 1

        return {"ui": {"images": results}, "result": (images,)}


# ---------------------------------------------------------------- SaveImage 钩子
#
# 用途：让**原生 SaveImage** 在保存图片后自动补写提示词，用户工作流一行都不用改。
#
# 为什么不是「节点只写元数据」：ComfyUI 节点之间只传 tensor，拿不到图片路径；
# PNG 的元数据又是文件结构的一部分，必须在写文件时或之后重写。
# 所以只能在 SaveImage 保存完之后，就地往文件里插 chunk。
#
# 为什么用字节插入而不是 PIL 重存：PIL 重新 save 会丢掉 iCCP / pHYs / sRGB
# 等非文本 chunk，色彩配置可能受影响。这里直接在 IEND 前插 iTXt，像素零改动。

try:
    from . import state as _state
except ImportError:
    try:
        import state as _state
    except Exception:
        _state = None


def _png_find_text(data: bytes, key: str) -> bool:
    return key.encode("latin-1") in data


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


def inject_meta(path, text, key="anima_prompt"):
    """把提示词写进已保存的 PNG。已存在同名键则跳过（幂等）。"""
    try:
        with open(path, "rb") as f:
            data = f.read()
        if not data.startswith(b"\x89PNG\r\n\x1a\n"):
            return False                     # 非 PNG 跳过
        if _png_find_text(data, key):
            return True
        out = _png_insert_itxt(data, key, text)
        with open(path, "wb") as f:
            f.write(out)
        return True
    except Exception as e:
        print(f"[prompt-combiner] 写元数据失败 {os.path.basename(str(path))}: {e}")
        return False


_HOOKED = False


def install_saveimage_hook():
    """包装 ComfyUI 原生的 SaveImage.save_images，保存后自动补写提示词。

    开关：环境变量 `ANIMA_META_HOOK=0` 可关闭。
    只在 `self.type == "output"` 时写，避免污染 PreviewImage 的临时文件。
    """
    global _HOOKED
    if _HOOKED:
        return True
    if os.environ.get("ANIMA_META_HOOK", "1") == "0":
        print("[prompt-combiner] ANIMA_META_HOOK=0，图片元数据钩子已关闭")
        return False

    import sys as _sys
    mod = _sys.modules.get("nodes")          # ComfyUI 自己的 nodes 模块
    if mod is None or not hasattr(mod, "SaveImage"):
        print("[prompt-combiner] 找不到 ComfyUI 的 nodes.SaveImage，元数据钩子未安装")
        return False
    if getattr(mod.SaveImage, "_anima_hooked", False):
        _HOOKED = True
        return True

    orig = mod.SaveImage.save_images

    def patched(self, images, filename_prefix="ComfyUI", prompt=None, extra_pnginfo=None):
        res = orig(self, images, filename_prefix, prompt, extra_pnginfo)
        try:
            if _state is None or getattr(self, "type", "output") != "output":
                return res
            text = _state.recent()
            if not text:
                return res
            base = getattr(self, "output_dir", ".") or "."
            for item in (res.get("ui") or {}).get("images") or []:
                fn = item.get("filename")
                if not fn:
                    continue
                p = os.path.join(base, item.get("subfolder") or "", fn)
                if os.path.exists(p):
                    inject_meta(p, text)
        except Exception as e:
            # 写元数据失败绝不能影响出图
            print("[prompt-combiner] 元数据钩子异常:", e)
        return res

    mod.SaveImage.save_images = patched
    mod.SaveImage._anima_hooked = True
    _HOOKED = True
    print("[prompt-combiner] 已安装 SaveImage 元数据钩子（提示词会自动写进 PNG）")
    return True


# ---------------------------------------------------------------- 自测
# 直接跑：python save_node.py
# 生成一张小图，写入中英文混合元数据，再读回来验证。
if __name__ == "__main__":
    from tempfile import gettempdir

    tmp = os.path.join(gettempdir(), "_anima_meta_test.png")
    img = Image.new("RGB", (64, 64), (30, 40, 60))

    sample_prompt = ("masterpiece, best quality, score_7, 1girl, solo, "
                     "hatsune_miku, vocaloid, smile, long hair, twintails")
    sample_slots = json.dumps([
        {"slot": "角色", "prompt": "hatsune_miku", "name": "初音未来（VOCALOID）"},
        {"slot": "发型", "prompt": "twintails", "name": "双马尾"},
    ], ensure_ascii=False)

    write_png_with_meta(tmp, img, {
        "anima_prompt": sample_prompt,
        "anima_note": "MiaoMiao Harem v1.20z + Turbo LoRA  ·  测试备注",
        "anima_slots": sample_slots,
    })
    print("已写出:", tmp, os.path.getsize(tmp), "字节")

    back = Image.open(tmp)
    print("\n=== 读回元数据 ===")
    for k in ("anima_prompt", "anima_note", "anima_slots"):
        v = back.text.get(k) if hasattr(back, "text") else None
        print(f"\n[{k}]")
        print(f"  {v}")
    ok = back.text.get("anima_prompt") == sample_prompt
    print(f"\n提示词回读一致: {ok}")
