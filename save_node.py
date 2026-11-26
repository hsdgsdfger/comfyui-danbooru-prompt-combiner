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
