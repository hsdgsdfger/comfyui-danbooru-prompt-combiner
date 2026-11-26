# ComfyUI 节点定义:Danbooru 抽签机
import json
import random

try:
    # ⛔ 2026-09-29 修：原来漏了 load_user_black ⇒ run() 里一调用就
    #    `NameError: name 'load_user_black' is not defined`，节点**整个跑不起来**
    #    （面板预览正常，所以只会在真跑工作流时才暴露）。
    #    ⚠️ 以后往 run() 里加 core 的函数，**先确认这个 import 列表里有**。
    from .core import (Data, Pool, Generator, fmt_prompt, fmt_detail, fmt_tag, fmt_word, order_words,
                            PRESET_ALIASES,
                       load_user_black, parse_locked)
except ImportError:      # 兼容「把插件目录塞进 sys.path 后直接 import」的加载方式
    from core import (Data, Pool, Generator, fmt_prompt, fmt_detail, fmt_tag, fmt_word, order_words,
                          PRESET_ALIASES,
                      load_user_black, parse_locked)

VERSION = "1.4.40"        # 版本号（面板会比对，不一致就提示重启）
try:
    from .core import GENDER_MAP
except Exception:
    from core import GENDER_MAP


def _is_nonperson_word(word):
    """角色词是不是非人（含「非人池额外补的那批」：宝可梦/数码宝贝/吉祥物）。"""
    try:
        from .core import _is_nonperson_char, _NONHUMAN_IP, _NONHUMAN_NAME_MARK
    except Exception:
        try:
            from core import _is_nonperson_char, _NONHUMAN_IP, _NONHUMAN_NAME_MARK
        except Exception:
            return True                      # 拿不到判定就放行，别误报
    if _is_nonperson_char(word):
        return True
    key = str(word).replace(" ", "_").lower()
    if "_" in key:
        return False                          # 多词名 = 人类
    try:
        db = Data.get()
        cr = db.cr_of_char().get(key)
        if cr in _NONHUMAN_IP:
            return True
        i = db.by_prompt.get(key)
        if i is not None:
            cn = str(db.dict_rows[i][1] if False else db.word(i)["name"])
            if any(m in cn for m in _NONHUMAN_NAME_MARK):
                return True
    except Exception:
        pass
    return False


def _preset_names():
    try:
        names = [p["name"] for p in Data.get().presets]
    except Exception:
        return ["极简日常"]        # 数据没加载成功时给个兜底，避免节点直接崩
    # ⚠️ 2026-10-17：**老档名必须留在选项表里**。
    #   ComfyUI 在进 Python 之前就拿这张表校验 combo 值，旧名（如「全身立绘」）不在表里
    #   → 直接报「词库随机组合 的 preset 输入值 全身立绘 不可用」（阿君截图），
    #     连 core.gen() 里的名称映射都轮不到执行。
    #   面板把原生 combo 隐藏了（computeSize 压 0），所以多这一项用户看不见；
    #   真抽签时由 core.canon_preset() 映射回现名，行为完全一致。
    for _old, _new in PRESET_ALIASES.items():
        if _new in names and _old not in names:
            names.append(_old)
    return names


def _parse_slots(txt):
    """解析面板写进来的槽位开关 JSON；空 / 非法 → None（表示用预设）"""
    s = str(txt or "").strip()
    if not s:
        return None
    try:
        o = json.loads(s)
        return o if isinstance(o, dict) and o else None
    except Exception:
        return None


def _parse_locked(txt):
    """解析面板写进来的「锁定标签」JSON；空 / 非法 → []（= 不锁定）。

    ⚠️ nodes.py 和 server.py 两条独立代码路径都要支持锁定，
       所以解析逻辑统一放 core.parse_locked，这里只做字符串→对象的入口。
    """
    return parse_locked(txt)


class PromptCombiner:
    """按「搭配预设」从 danbooru 词库里随机抽标签，拼成一段提示词。

    数据来自网页版工具 `词库随机组合工具.html`（32.7 万标签 / 42 槽 / 6 档预设）。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "preset": (_preset_names(), {"default": "立绘"}),
                "gender": (list(GENDER_MAP.keys()), {"default": "只看女性"}),
                "nsfw_filter": ("BOOLEAN", {"default": True,
                    "label_on": "过滤 NSFW", "label_off": "不过滤"}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF,
                    "tooltip": "换一个数字就换一组标签；填相同数字可复现同一组"}),
                "add_quality": ("BOOLEAN", {"default": True,
                    "label_on": "加画质词", "label_off": "不加",
                    "tooltip": "masterpiece, best quality, score_9/8/7 —— 与 Anima 系模型官方推荐一致"}),
                "cross_series": ("BOOLEAN", {"default": False,
                    "label_on": "跨作品配对", "label_off": "同作品优先",
                    "tooltip": "双人时是否允许两个角色来自不同作品。默认关（第二人优先同作品，实测覆盖率约 85%）；打开后各自独立抽，仅保留同性别。"}),
                "space_out": ("BOOLEAN", {"default": True,
                    "label_on": "空格写法", "label_off": "下划线",
                    "tooltip": "Anima/Qwen/Krea 系要求：小写 + 空格代替下划线（只有 score 标签保留下划线）"}),
                "neg_mode": (["WAI精简", "完整"], {"default": "WAI精简",
                    "tooltip": "WAI精简 = 官方推荐 10 项；完整 = 另含手脚修复词"}),
                "show_detail": ("BOOLEAN", {"default": False,
                    "label_on": "输出明细", "label_off": "不输出"}),
                "slots_json": ("STRING", {"default": "", "multiline": False,
                    "tooltip": "槽位开关（由面板自动维护：点面板上的槽位即写入；清空则回落到预设）"}),
                # 2026-09-29：系列筛选从「面板自用」提升为节点参数 ——
                # 否则面板预览限定在原神、真跑工作流时角色又是随机的，两边对不上。
                "series": ("STRING", {"default": "", "multiline": False,
                    "tooltip": "系列筛选：只从指定作品里抽角色（如 原神 / 东方Project / Fate）；留空 = 全部作品"}),
                # 2026-10-05：锁定标签（对齐网页 state.locked）。
                #   点结果区标签上的 🔒 就写进这里；锁定的词在**下一次抽取和真跑工作流**里都保留。
                #   ⚠️ 必须放在 required 的**最后**：老工作流存的 widgets_values 比现在短，
                #      缺的那个会拿默认值 ""（= 不锁定），不会影响已有工作流。
                "locked_json": ("STRING", {"default": "", "multiline": False,
                    "tooltip": "锁定标签（由面板自动维护：点标签上的 🔒 即写入；清空 = 全部解锁）"}),
                # 2026-10-17：阿君拍板「自动补作品固定开启，不要开关」。
                # ⚠️ 这个 widget **不能从列表里删**：ComfyUI 的 widgets_values 是**按位置**存的，
                #    删掉中间一项会让后面所有控件的值错位，老工作流全乱。
                #    所以保留占位，但核心逻辑已经不看它了（core.gen 无条件补）。
                "auto_copyright": ("BOOLEAN", {"default": True,
                    "label_on": "自动补作品(固定)", "label_off": "自动补作品(固定)",
                    "tooltip": "已固定开启：抽到角色就补所属作品（fate → fate_(series)）。"
                               "此项仅为兼容旧工作流保留，改了也不生效。"}),
                # 2026-10-13：细节联动（阿君拍板「5」）。道具→拿着它 / 婚纱→头纱
                "auto_boost": ("BOOLEAN", {"default": True,
                    "label_on": "细节联动", "label_off": "不加",
                    "tooltip": "抽到东西时自动带上配套词（折扇→拿着扇子 / 婚纱→头纱 / 背带裙→背带）"}),
                # 2026-10-15：画师 @ 前缀（原「Anima 模式」）。⚠️ 放最后保持老工作流兼容。
                # 2026-10-17：括号转义和标签顺序都已改成**永远生效**，这个开关现在只管 @。
                "anima_mode": ("BOOLEAN", {"default": False,
                    "label_on": "画师@", "label_off": "画师裸写",
                    "tooltip": "打开：画师标签写成 @画师名（Anima 系必须，不加 @ 画风几乎不生效）。"
                               "Illustrious / Pony / NoobAI 保持关闭。"}),
                # ⭐ 2026-10-19（阿君：翻历史后点运行，出的是最后一组而不是我停留的那组）：
                #   节点是**无状态重算** —— run() 里 `random.Random(seed)` 重新抽一遍，
                #   所以面板上「翻到第 5 组 / 手动改了个词」它根本不知道，只会按当前 seed 重抽。
                #   ⇒ 加这个参数：非空 = 直接用这段文本当输出，忽略 seed。
                #   面板维护规则：
                #     · 点「组合生成」→ 清空（回到"seed 说了算"）
                #     · 点「上一组/下一组」→ 清空 + 把 seed 退回那组的 seed（那组本来就能复现）
                #     · 手动改词 / 加词 / 删词 → 写入当前文本（改过的内容 seed 表达不出来）
                #   ⚠️ 必须放在 required 的**最后**：老工作流的 widgets_values 比现在短，
                #      缺的那项拿默认值 ""（= 不固定），不影响已有工作流。
                "pinned_prompt": ("STRING", {"default": "", "multiline": False,
                    "tooltip": "面板自动维护：非空时节点直接输出这段文本（用于「翻到历史组」"
                               "「手动改过词」）；点「组合生成」会清空，回到按 seed 抽取"}),
                # ⭐ 2026-10-20（阿君：切了工作流再切回来，组合结果就没了；文本框节点却还在）：
                #   文本框能保留，是因为文字是 **widget 的值**，会被存进工作流 JSON。
                #   面板的 curTags/curPos 是 JS 内存变量，节点一重建就归零。
                #   ⇒ 加这个「面板状态」控件：面板每次出结果就写进去（标签 + 文本 + seed），
                #     载入工作流时再读出来显示。**只影响显示，不参与生成** ——
                #     生成仍然只看 seed / pinned_prompt，所以不会改变出图。
                #   ⚠️ 必须放在 required 的**最后**（老工作流 widgets_values 较短，缺省为 ""）。
                "panel_state": ("STRING", {"default": "", "multiline": False,
                    "tooltip": "面板自动维护：记录上一次显示的组合（切工作流后能恢复）。不影响生成"}),
                # ⭐ 2026-11-25 用户要的「只出 NSFW」开关。
                #   ⚠️ 必须放在 required 的**最末尾**：老工作流的 widgets_values 比现在短，
                #      缺的这一项拿默认 False（= 关），不会让已有工作流的参数错位。
                "nsfw_only": ("BOOLEAN", {"default": False,
                    "label_on": "只出 NSFW", "label_off": "关",
                    "tooltip": "开启后：有 NSFW 词的槽（泳装/上装/下装/姿势/互动/袜子…）只抽 NSFW 词；"
                               "本身没有 NSFW 词的槽（发型/表情/光照/景别…）照常抽，避免整槽空掉"}),
            },
        }

    # 2026-09-29 用户改了三次,最终定为:**只留一个输出** ——「标签组合结果」。
    #   演变:全不要 → 正+负两个 → 只留一个组合结果。
    #   ⚠️ 负向词仍照旧算好放在面板/内部(默认 WAI精简),只是**不再单独输出**。
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("标签组合结果",)
    OUTPUT_NODE = False
    FUNCTION = "run"
    CATEGORY = "阿灯"
    DESCRIPTION = "从 32 万 danbooru 标签按档位抽签，拼出完整提示词（含互斥校验 / 多人分写 / 同作品配对）"

    def run(self, preset, gender, nsfw_filter, seed, add_quality, space_out, neg_mode,
            show_detail, slots_json="", series="", locked_json="", auto_copyright=True,
            auto_boost=True, anima_mode=False, cross_series=False, pinned_prompt="",
            panel_state="", nsfw_only=False):
        # ⚠️ panel_state 必须收下但**不用**：它只是面板给"切工作流恢复显示"存的快照。
        #    不收会 TypeError（INPUT_TYPES 里的键都会当 kwargs 传进来）。
        # ⭐ 2026-10-19（阿君：翻历史后运行，出的是最后一组）：
        #   面板显示什么，节点就输出什么 —— 否则「翻到第 5 组点运行」会按当前 seed
        #   重抽成第 10 组。pinned 非空时**完全不看 seed**，也不做词库校验
        #   （内容可能是用户手改的，跟 seed 推不出来）。
        _pinned = str(pinned_prompt or "").strip()
        if _pinned:
            return (_pinned,)

        db = Data.get()
        R = db.R
        # ⛔ 2026-10-19（阿君：选了「非人」却出初音）：
        #   旧版 Python 的 GENDER_MAP 没有「非人」→ 静默回退成「只看女性」，
        #   看起来像功能坏了，实际是**后端没重启**。这里改成：认不出的值直接报错，
        #   让人一眼看到"后端是旧代码"。
        _g = GENDER_MAP.get(gender)
        if _g is None:
            raise ValueError(
                "性别参数「%s」不被当前后端识别 —— 说明 ComfyUI 还在跑旧版 Python 代码，"
                "请**完全退出 ComfyUI 再启动**（只刷新页面不够）。" % gender)
        pool = Pool(db, gender=_g, nsfw_filter=nsfw_filter, black=load_user_black(),
                    series=series, nsfw_only=nsfw_only)
        rng = random.Random(int(seed))
        picked = Generator(db, pool, rng, black=load_user_black(),
                           auto_cr=auto_copyright, auto_boost=auto_boost).gen(
            preset, space_out, _parse_slots(slots_json), locked=_parse_locked(locked_json),
            cross_series=bool(cross_series))

        # ⭐ 2026-10-19（阿君：非人还是出人类）：硬校验。
        #   抽到人类角色 ⇒ 说明后端拿到的 gender 根本不是「非人」，问题在参数传递，
        #   不是池子。报错里带实参和抽到的角色，方便一眼定位。
        if GENDER_MAP.get(gender) == "n":
            _humans = [c["prompt"] for c in picked
                       if c.get("slot") == "角色"
                       and not _is_nonperson_word(c["prompt"])]
            if _humans:
                raise RuntimeError(
                    "非人模式抽到了人类角色：%s。\n"
                    "说明节点收到的 gender 参数是「%s」，而不是「非人」——"
                    "请把这条报给作者（这属于参数传递问题，不是词库问题）。"
                    % ("、".join(_humans[:5]), gender)
                    + "（后端实际用的性别 = %r）" % (pool.gender,))

        quality = []
        if add_quality:
            for x in R["FIXED_QUALITY"]:
                quality.append(fmt_tag(x["prompt"], space_out))

        # ⭐ 2026-10-20（阿君：关掉 ComfyUI 重开，粘 seed 进来查不到档位了）：
        #   只要这组词是这台机器出的，就必须有据可查 —— 不能只在面板点「组合生成」时
        #   才记（直接 Queue 跑工作流的那一组原来根本没人记）。
        #   ⚠️ 走 server.record_seed_params，别自己写文件（会跟 server 的内存缓存打架）。
        try:
            try:
                from .server import record_seed_params
            except ImportError:
                from server import record_seed_params
            record_seed_params(seed, {
                "preset": str(preset or ""),
                "gender": str(gender or ""),
                "nsfw": bool(nsfw_filter),
                # 存**原始字符串**：空 = 走预设，非空 = 显式槽位表。
                # 展开成表会盖住预设，切档位就不生效了（面板 snapParams 同一个坑）。
                "slotsRaw": str(slots_json or ""),
                "series": str(series or ""),
                "locks": _parse_locked(locked_json),
                # 这组结果实际覆盖了几个槽（够用来提示"原档位是 N 个槽"）
                "slotsN": len({x.get("slot") for x in picked if x.get("slot")}),
                "q": bool(add_quality), "sp": bool(space_out), "an": bool(anima_mode),
                "cr": bool(auto_copyright), "bo": bool(auto_boost),
                "cs": bool(cross_series),
                "src": "node",     # 标记来源：节点真跑出来的（面板记的没有这个字段）
            })
        except Exception as _e:
            # 记不上不能影响出图 —— 顶多这个 seed 查不到档位
            print("[prompt-combiner] seed 归属记录跳过:", _e)

        positive = fmt_prompt(picked, quality, space_out, anima_mode)
        # 负向词仍算好（面板/内部要用,默认 WAI精简），但**不再输出**
        negative = R["NEGATIVE_PROMPT_WAI"] if neg_mode == "WAI精简" else R["NEGATIVE_PROMPT_FULL"]
        _ = negative

        return (positive,)

    @classmethod
    def IS_CHANGED(cls, seed, **kw):
        """seed 或任何**影响输出的开关**变了就重跑（否则 ComfyUI 会拿缓存）。

        ⚠️ 2026-10-17 修：原来只看了 seed（外加已回退的扩写参数 expand_*）——
           于是「切了 Anima 模式 / 空格输出 / 画质词 / 档位，但 seed 没变」时
           ComfyUI 直接把上一次的缓存结果吐回来，用户会以为开关坏了、改了没反应。
        ⚠️ 2026-10-19：`pinned_prompt` **必须**进这个签名。它一变输出就整个变，
           而 seed 往往没变（翻历史 / 手改一个词）—— 不加就会一直吐缓存，
           表现成「翻了历史点运行还是老样子」，比不修还糟。
        """
        keys = ("preset", "gender", "nsfw_filter", "nsfw_only", "add_quality", "space_out",
                "neg_mode", "show_detail", "slots_json", "series", "locked_json",
                "auto_copyright", "auto_boost", "anima_mode", "cross_series",
                "pinned_prompt")
        return "%s|%s" % (seed, "|".join("%s=%s" % (k, kw.get(k)) for k in keys))


class PromptCombinerInfo:
    """查看词库状态（槽位数量、数据加载耗时等），排查用。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("信息",)
    FUNCTION = "run"
    CATEGORY = "阿灯"

    def run(self):
        try:
            db = Data.get()
            lines = [
                "词库：%d 条（被槽位引用的）" % len(db.dict_rows),
                "槽位：%d 个" % len(db.slot_order),
                "分组：%d 个 · 预设：%d 个" % (len(db.slot_groups), len(db.presets)),
                "数据加载耗时：%s 秒（仅首次）" % db.load_sec,
                "",
                "各槽池大小（只看女性 / 过滤NSFW）：",
            ]
            pool = Pool(db, gender="f", nsfw_filter=True, black=load_user_black())
            for s in db.slot_order:
                # ⚠️ 2026-09-29 修：原来写的是 pool.slot_pool(s) —— Pool 没有这个方法，
                #    每次点这个节点都必然抛 AttributeError（被 except 吞掉，只显示「加载失败」）。
                lines.append("  %-14s %d" % (s, len(pool.slot_list(s))))
            lines.append("")
            lines.append("系列库：%d 个（SERIES_MAP）" % len(db.R.get("SERIES_MAP") or {}))
            return ("\n".join(lines),)
        except Exception as e:
            return ("加载失败: %s" % e,)


NODE_CLASS_MAPPINGS = {
    "PromptCombiner": PromptCombiner,
    "PromptCombinerInfo": PromptCombinerInfo,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptCombiner": "🎲 Danbooru 抽签机",
    "PromptCombinerInfo": "ℹ️ 词库状态",
}
