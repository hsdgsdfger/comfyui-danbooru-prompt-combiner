"""Danbooru 抽签机 · 节点 HTTP API

给前端面板供数据：元信息（预设/槽位/负面词）+ 按参数抽词预览。
照 ComfyUI 插件的惯例：路由挂在 PromptServer.instance.routes 上，
返回统一 envelope {success, data|error}。
"""
import json
import os
import re
import time

from aiohttp import web
from server import PromptServer

try:
    from .core import (Data, Pool, Generator, fmt_prompt, fmt_detail, fmt_tag, fmt_word, order_words,
                       DATA_DIR, load_user_black, load_slot_edits, apply_slot_edits)
except ImportError:
    from core import (Data, Pool, Generator, fmt_prompt, fmt_detail, fmt_tag, fmt_word, order_words,
                      DATA_DIR, load_user_black, load_slot_edits, apply_slot_edits)

import random

try:
    from .core import GENDER_MAP
except Exception:
    from core import GENDER_MAP


def _ok(data):
    return web.json_response({"success": True, "data": data})


def _err(msg, status=400):
    return web.json_response({"success": False, "error": str(msg)}, status=status)


@PromptServer.instance.routes.get("/pc/meta")
async def pc_meta(request):
    """面板初始化用：预设、槽位分组、负面词、画质词。"""
    try:
        db = Data.get()
        db.refresh_slots()   # ⭐ 2026-10-06：带上用户新建/删除的槽位（幂等，见 core.refresh_slots）
        try:
            from .nodes import VERSION as _BUILD
        except Exception:
            try:
                from nodes import VERSION as _BUILD
            except Exception:
                _BUILD = "unknown"
        return _ok({
            "version": _BUILD,
            "presets": [{"name": p["name"], "on": p.get("on") or [],
                         "freeAll": bool(p.get("freeAll")),
                         # 2026-10-17：档位可以指定「某些槽抽几个」——「双人」档用
                         #   {"角色": 2} 让角色槽抽两个角色，配合双人互动。
                         "counts": p.get("counts") or {}} for p in db.presets],
            "slotOrder": db.slot_order,
            "slotGroups": [{"name": g["name"], "slots": g["slots"]} for g in db.slot_groups],
            "quality": [fmt_tag(x["prompt"], True) for x in db.R["FIXED_QUALITY"]],
            "negative": {
                "wai": db.R["NEGATIVE_PROMPT_WAI"],
                "full": db.R["NEGATIVE_PROMPT_FULL"],
            },
            "dictCount": len(db.dict_rows),
            "loadSec": db.load_sec,
        })
    except Exception as e:
        return _err("元信息读取失败: %s" % e, 500)


@PromptServer.instance.routes.get("/pc/pools")
async def pc_pools(request):
    """各槽池大小（面板显示 + 排查用）。"""
    try:
        db = Data.get()
        gender = request.query.get("gender", "f")
        nsfw = request.query.get("nsfw", "1") not in ("0", "false")
        pool = Pool(db, gender=GENDER_MAP.get(gender, gender), nsfw_filter=nsfw, black=load_user_black())
        return _ok({s: len(pool.slot_list(s)) for s in db.slot_order})
    except Exception as e:
        return _err("池大小读取失败: %s" % e, 500)


_SERIES_LIST = None


@PromptServer.instance.routes.get("/pc/series")
async def pc_series(request):
    """全部系列名（给面板的 datalist 用），按角色数从多到少。"""
    global _SERIES_LIST
    try:
        db = Data.get()
        if _SERIES_LIST is None:
            SM = db.R.get("SERIES_MAP") or {}
            arr = []
            for en, v in SM.items():
                n = len(v.get("idx") or [])
                if n <= 0:
                    continue
                arr.append({"en": en, "cn": v.get("cn") or en, "n": n})
            arr.sort(key=lambda x: (-x["n"], x["cn"]))
            _SERIES_LIST = arr
        return _ok({"total": len(_SERIES_LIST), "series": _SERIES_LIST})
    except Exception as e:
        return _err("系列列表读取失败: %s" % e, 500)


@PromptServer.instance.routes.post("/pc/preview")
async def pc_preview(request):
    """按参数抽一组词（与节点执行同一套逻辑）。"""
    try:
        payload = await request.json()
    except Exception:
        return _err("请求不是有效 JSON")
    try:
        db = Data.get()
        preset = payload.get("preset") or db.presets[0]["name"]
        gender = GENDER_MAP.get(payload.get("gender"), "f")
        nsfw = bool(payload.get("nsfw", True))
        # 2026-11-25：「只出 NSFW」开关（面板预览必须跟节点用同一套，否则预览和真跑对不上）
        nsfw_only = bool(payload.get("nsfwOnly", False))
        seed = int(payload.get("seed") or 0)
        space_out = bool(payload.get("spaceOut", True))
        add_quality = bool(payload.get("addQuality", True))
        series = str(payload.get("series") or "").strip()
        # 面板当前的槽位表（含每槽数量；2026-09-29 加）
        #   ⚠️ 不传就退回预设 —— 所以面板改完数量必须把它一起发过来，否则预览和真跑会对不上。
        slots = payload.get("slots")
        if not isinstance(slots, dict):
            slots = None
        # 锁定标签（2026-10-05，对齐网页 state.locked）：面板把锁定的词发过来，
        # 这一组里必须保留它们。空 / 非法 = 不锁定（parse_locked 内部兜底）。
        locked = payload.get("locked")
        # 自动补作品标签（2026-10-11）：抽到角色时补上所属作品版权词；默认开
        auto_cr = payload.get("autoCR", True)
        # 细节联动（2026-10-13）：抽到东西自动带配套词；默认开
        auto_boost = payload.get("autoBoost", True)
        # Anima 模式（2026-10-15）：画师标签加 @ 前缀；默认关
        anima = bool(payload.get("animaMode", False))
        # 跨作品配对（2026-10-18 阿君要的）：开着=两人可来自不同作品；默认关（同作品优先）
        cross_series = bool(payload.get("crossSeries", False))

        pool = Pool(db, gender=gender, nsfw_filter=nsfw, series=series,
                    black=load_user_black(), nsfw_only=nsfw_only)
        rng = random.Random(seed)
        picked = Generator(db, pool, rng, black=load_user_black(), auto_cr=auto_cr,
                           auto_boost=auto_boost).gen(
            preset, space_out, slots, locked=locked, cross_series=cross_series)

        quality = [fmt_tag(x["prompt"], space_out) for x in db.R["FIXED_QUALITY"]] if add_quality else []
        # ⚠️ 排序后的表：tags[] 和 positive 都要用它，否则「整句排了序、逐词条没排」两边不一致
        items = order_words(picked, anima)
        # 系列筛选反馈：命中多少个角色（面板拿它提示用户「匹配对不对」）
        sinfo = None
        if series:
            _, info = pool.series_allow()
            sinfo = dict(info)
            sinfo["count"] = len(pool.slot_list("角色"))
        return _ok({
            # ⚠️ g（互斥组）必须一起回：面板锁定标签时要把 g 原样带回后端，
            #    否则下一组里锁定词占不住互斥组，会跟同组词（黑发/金发…）撞在一起。
            "tags": [{"prompt": x["prompt"], "name": x["name"], "slot": x["slot"],
                      "g": x.get("g"),
                      # 2026-10-17：多人时带出 who（第几个人），面板靠它插入分隔带
                      "who": x.get("who"),
                      "out": fmt_word(x["prompt"], x.get("slot"), space_out, anima)} for x in items],
            "positive": fmt_prompt(picked, quality, space_out, anima),
            "count": len(picked),
            "series": sinfo,
        })
    except Exception as e:
        return _err("抽取失败: %s" % e, 500)


# ===== 网页一键推送（2026-09-25 用户要求）=====
#
# 用途：在**网页版**里调好提示词 → 点「推送到 ComfyUI」→ 工作流里的接收节点就更新。
# 分工：后端只负责**暂存**；前端（js/panel.js）轮询 /pc/latest，发现 seq 变了
#       就写进画布上所有 PromptReceiver 节点的 text widget。
#       （后端改不了前端画布，所以必须由前端来落笔。）
#
# ⚠️ 网页是 file:// 协议（Origin: null），fetch 本机 ComfyUI 属于跨域 —— 必须放行 CORS，
#    而且 POST + JSON 会先发 OPTIONS 预检，所以 OPTIONS 路由也得给。

_PUSHED = {"positive": "", "negative": "", "seq": 0, "at": ""}

_CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
}


@PromptServer.instance.routes.options("/pc/push")
async def pc_push_options(request):
    return web.Response(headers=_CORS)


@PromptServer.instance.routes.post("/pc/push")
async def pc_push(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "请求不是有效 JSON"},
                                 status=400, headers=_CORS)
    _PUSHED["positive"] = str(data.get("positive") or "")
    _PUSHED["negative"] = str(data.get("negative") or "")
    _PUSHED["seq"] = int(_PUSHED.get("seq") or 0) + 1
    _PUSHED["at"] = time.strftime("%H:%M:%S")
    return web.json_response({"success": True, "data": {"seq": _PUSHED["seq"]}}, headers=_CORS)


@PromptServer.instance.routes.get("/pc/latest")
async def pc_latest(request):
    return web.json_response({"success": True, "data": _PUSHED}, headers=_CORS)


@PromptServer.instance.routes.get("/pc/ping")
async def pc_ping(request):
    """网页用它探测「ComfyUI 在不在跑」。"""
    return web.json_response(
        {"success": True, "data": {"ok": True, "app": "comfyui-prompt-combiner"}},
        headers=_CORS)


# ==========================================================================
# 用户改动（槽位池编辑器 / 档位编辑器）2026-09-25
# --------------------------------------------------------------------------
# 存储：插件目录下 data/user_edits.json（**不是** localStorage —— 网页是 file://、
#       ComfyUI 是 http://127.0.0.1:8188，两个 origin 的 localStorage 不互通）。
# 结构：完全对齐网页版的 promptCombinerSlotEdits / promptCombinerPresetEdits，
#       这样「网页导出配置 → 导入插件」这条路以后能直接走通。
# ==========================================================================

_USER_FILE = os.path.join(DATA_DIR, "user_edits.json")
_USER = {}

_USER_DEFAULT = {
    "slotEdits": {"removed": {}, "added": {}, "renamed": {}, "custom": [], "deleted": []},
    "presetEdits": {"removed": [], "renamed": {}, "custom": [], "overrides": {}},
    #   overrides: {档位key: [槽名…]} —— 「覆盖」功能：用当前槽位组合替换内置档的槽位表
    # 收藏夹（2026-09-29）：与网页版 promptCombinerFavs 同构
    # [{k: 标签指纹, t: 时间戳, c: [{prompt,name,slot}]}]
    "favorites": [],
    # 单词收藏（2026-10-19 阿君：「喜欢的角色或者某个标签能不能也收藏」）
    #   [{p: prompt, n: 中文名, s: 槽, t: 时间戳}] —— 与上面的「整组收藏」分开存，
    #   ⛔ 别混进 favorites：那边一条 = 一组，渲染和载入逻辑完全不同。
    "wordFavs": [],
    "black": [],          # 全局剔除（任何槽都不出的词）2026-09-29
    "cnTpl": {},          # 中文对照句式模板（2026-09-29）{cn, fill}
    # 单个标签的**权重倍数**（2026-10-19 阿君「可以自由给某个标签设置权重」）
    #   {prompt: 倍数} · 1.0 = 默认 · 0.05~20 之间 · 不是黑名单（要不出请用 black）
    "weights": {},
    # 单个标签的**提示词括号权重**（2026-10-19 阿君纠正：「是标签在提示词里的权重」）
    #   {prompt: 倍数} · 1.0 = 默认（不加括号）· 0.1~3.0 · 输出成 `(tag:1.5)`
    #   ⛔ 跟上面的 weights（抽取频率）是两套东西，别混
    "promptWeights": {},
    # seed → 当时那组标签的**完整参数快照**（2026-10-19 阿君：换工作流复制 seed 复现不出来）
    #   {"386570": {"preset": "极简", "slotsRaw": "", "locks": [...], "t": 时间戳, ...}}
    #   ⛔ 为什么不放浏览器 localStorage / 不放每个节点的内存历史：
    #      hist 是**每个节点实例一份**的内存数组 ⇒ A 工作流生成的 seed，B 工作流根本看不见。
    #      存这里才能「同一台机器、任何工作流、任何节点」都还原。
    "seedParams": {},
}


def _user_load():
    global _USER
    if not _USER:
        try:
            with open(_USER_FILE, "r", encoding="utf-8") as f:
                _USER = json.load(f) or {}
        except Exception:
            _USER = {}
        for k, v in _USER_DEFAULT.items():
            # ⚠️ 不能一律按 dict 补默认 —— favorites 是 list，
            #    原来的 `if not isinstance(..., dict)` 会把已存的收藏夹清空。
            if isinstance(v, list):
                if not isinstance(_USER.get(k), list):
                    _USER[k] = []
            elif not isinstance(_USER.get(k), dict):
                _USER[k] = json.loads(json.dumps(v))
            else:
                for kk, vv in v.items():
                    _USER[k].setdefault(kk, vv)
    return _USER


def _user_save():
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(_USER_FILE, "w", encoding="utf-8") as f:
            json.dump(_USER, f, ensure_ascii=False, indent=1)
    except Exception as e:
        print("[prompt-combiner] 保存用户改动失败:", e)


@PromptServer.instance.routes.get("/pc/user")
async def pc_user_get(request):
    return _ok(_user_load())


# ============================================================================
# seed → 参数快照（2026-10-20）
#
# 为什么必须记在**后端**，而不是只靠面板的 pushHist：
#   面板的 pushHist 只在点「组合生成」时跑。直接从工作流 Queue 出去跑出来的
#   那一组**没有任何人记**。于是关掉 ComfyUI 再打开、粘 seed 进来，查不到档位
#   （阿君 2026-10-20：「我复制了 seed 到记事本，关掉重开再粘进去就没提示了」）。
#   后端在 run() 里记一笔 = 只要这组词是这台机器出的，就一定有据可查。
#
# ⚠️ 必须走 _user_load/_user_save，不能自己 open(文件) 写：
#    server.py 内存里有一份 _USER 缓存，绕过它直接写盘，下一次 _user_save
#    会把这份缓存整体覆盖回去，刚写的记录就没了。
# ============================================================================
def record_seed_params(seed, p):
    """把「seed → 当时那组标签的参数」写进 user_edits.json.seedParams。

    只增改，不清空；超过 500 条按时间淘汰最旧的（和前端逻辑一致）。
    返回 True/False，调用方不需要处理异常。
    """
    try:
        _s = int(seed)
    except Exception:
        return False
    if _s <= 0 or not isinstance(p, dict):
        return False
    try:
        u = _user_load()
        sp = u.get("seedParams")
        if not isinstance(sp, dict):
            sp = {}
        _rec = dict(p)
        # 毫秒时间戳，和面板的 Date.now() 同一量纲（淘汰排序要能比）
        _rec["t"] = int(time.time() * 1000)
        sp[str(_s)] = _rec
        if len(sp) > 500:
            _old = sorted(sp.items(), key=lambda kv: (kv[1] or {}).get("t", 0))
            for _k, _v in _old[:len(sp) - 500]:
                sp.pop(_k, None)
        u["seedParams"] = sp
        _user_save()
        return True
    except Exception as e:
        print("[prompt-combiner] 记录 seed 归属失败:", e)
        return False


@PromptServer.instance.routes.post("/pc/user")
async def pc_user_post(request):
    """整体提交用户改动（槽位池编辑器 / 档位编辑器都会调这个）。"""
    try:
        data = await request.json()
    except Exception:
        return _err("请求不是有效 JSON")
    u = _user_load()
    if isinstance(data.get("slotEdits"), dict):
        u["slotEdits"] = data["slotEdits"]
    if isinstance(data.get("presetEdits"), dict):
        u["presetEdits"] = data["presetEdits"]
    if isinstance(data.get("favorites"), list):
        u["favorites"] = data["favorites"][:200]      # 上限与网页版一致
    # 单词收藏（2026-10-19）：[{p,n,s,t}]，按 prompt 去重，上限 500
    if isinstance(data.get("wordFavs"), list):
        _wf, _seen = [], set()
        for _x in data["wordFavs"][:1000]:
            if not isinstance(_x, dict):
                continue
            _p = str(_x.get("p") or "").strip()
            if not _p or _p in _seen:
                continue
            _seen.add(_p)
            _wf.append({"p": _p, "n": str(_x.get("n") or ""),
                        "s": str(_x.get("s") or ""),
                        "t": _x.get("t") or 0})
        u["wordFavs"] = _wf[:500]
    if isinstance(data.get("black"), list):
        u["black"] = data["black"][:50000]   # 2026-11-25：2000 太小，7 千条黑名单被截断
    if isinstance(data.get("cnTpl"), dict):
        u["cnTpl"] = data["cnTpl"]
    # 标签权重（2026-10-19）：{prompt: 倍数}
    #   ⚠️ 只收 0.05~20 的有限数，其余丢弃 —— 防手滑写 0/负数/字符串把某个词抽成唯一解或整槽抽空
    if isinstance(data.get("weights"), dict):
        _w = {}
        for _k, _v in list(data["weights"].items())[:5000]:
            try:
                _f = float(_v)
            except Exception:
                continue
            if _f <= 0 or _f != _f or _f in (float("inf"), float("-inf")):
                continue
            _w[str(_k).replace(" ", "_").lower()] = max(0.05, min(20.0, _f))
        u["weights"] = _w
    # 提示词权重（2026-10-19）：{prompt: 倍数} —— 输出成 `(tag:1.5)`
    #   ⚠️ 钳 [0.1, 3.0]；1.0 直接丢掉（默认就是不占坑）
    if isinstance(data.get("promptWeights"), dict):
        _pw = {}
        for _k, _v in list(data["promptWeights"].items())[:5000]:
            try:
                _f = float(_v)
            except Exception:
                continue
            if _f <= 0 or _f != _f or _f in (float("inf"), float("-inf")):
                continue
            _c = max(0.1, min(3.0, _f))
            if abs(_c - 1.0) < 1e-9:
                continue
            _pw[str(_k).replace(" ", "_").lower()] = _c
        u["promptWeights"] = _pw
    # seed → 参数快照（2026-10-19）：**按 key 合并，不做整体替换**。
    #   ⚠️ 前端 saveUserEdits() 提交的是整个 _userEdits 对象，而每个节点面板
    #      各自持有一份可能已经过期的快照 ⇒ 整体替换会把别的工作流刚记下的 seed 冲掉。
    #      合并（只增改、不删）才能让多个工作流同时开着也不互相踩。
    if isinstance(data.get("seedParams"), dict):
        _sp = u.get("seedParams")
        if not isinstance(_sp, dict):
            _sp = {}
        for _k, _v in list(data["seedParams"].items())[:2000]:
            _ks = str(_k).strip()
            if not _ks.isdigit() or not isinstance(_v, dict):
                continue
            _sp[_ks] = _v
        # 上限 500 条，按时间戳丢最旧的（seed 快照很小，但历史会一直长）
        if len(_sp) > 500:
            _old = sorted(_sp.items(), key=lambda kv: (kv[1] or {}).get("t", 0))
            for _k, _ in _old[:len(_sp) - 500]:
                _sp.pop(_k, None)
        u["seedParams"] = _sp
    _user_save()
    _slots_of_drop_cache()      # 槽池变了，反查表必须作废
    if isinstance(data.get("black"), list):
        # 角色搜索缓存不能只靠黑名单长度作键：等长替换也必须立即生效。
        _CHAR_SET_CACHE.clear()
    # ⭐ 2026-10-06：槽位表也跟着重建（新建/删除槽位后立刻生效，不用重启 ComfyUI）
    try:
        Data.get().refresh_slots()
    except Exception as e:
        print("[prompt-combiner] refresh_slots 失败:", e)
    # ⭐ 2026-10-19：权重也立刻重载（否则改完权重得重启 ComfyUI 才生效）
    try:
        Data.get().reload_weights()
    except Exception as e:
        print("[prompt-combiner] reload_weights 失败:", e)
    return _ok({"saved": True})


@PromptServer.instance.routes.post("/pc/user/reset")
async def pc_user_reset(request):
    global _USER
    _USER = {}
    try:
        os.remove(_USER_FILE)
    except Exception:
        pass
    _slots_of_drop_cache()
    _CHAR_SET_CACHE.clear()
    # ⭐ 2026-10-19：重置 = 文件删了 ⇒ 槽位表 + 权重都必须回到默认（否则旧值还挂在内存里）
    try:
        Data.get().refresh_slots()
        Data.get().reload_weights()
    except Exception as e:
        print("[prompt-combiner] 重置后刷新失败:", e)
    return _ok({"reset": True})


def _apply_slot_edits(slot, words, ed):
    """把用户的增删应用到某槽词表上。

    ⚠️ 2026-10-05：实现搬去 `core.apply_slot_edits`（**全项目只有一份**）——
       因为 `Pool.slot_list()` 也必须走它，否则又会变成
       「右键剔除保存成功、但抽词路径完全不读这份改动」那个 bug。
       这里只留薄封装，避免改动一堆调用处（重复应用是幂等的，无害）。
    """
    try:
        return apply_slot_edits(Data.get(), slot, words, ed)
    except Exception:
        return words


_DB_REF = None

# ⚠️ 槽池整表缓存：(gender, nsfw) → {prompt: [槽, …]}
#   网页那边是 `slotsOf(prompt)`（本地 `_slotOfDyn` 反查表），节点没有这张表 ⇒
#   词库区右键永远拿不到"这个词在哪个槽"，菜单里就出不来「剔除/移动/添加」。
#   42 个槽整表构建一次约 1 秒，之后每次右键只要 O(1)。用户改动 / 性别 / NSFW 一变就整体作废。
_SLOTOF_CACHE = {}
_SLOTOF_MAX = 4


def _slots_of_map(gender, nsfw):
    key = (gender, bool(nsfw))
    hit = _SLOTOF_CACHE.get(key)
    if hit is not None:
        return hit
    db = Data.get()
    pool = Pool(db, gender=gender, nsfw_filter=nsfw, black=load_user_black())
    ed = _user_load().get("slotEdits") or {}
    mp = {}
    for s in db.slot_order:
        try:
            words = _apply_slot_edits(s, pool.slot_list(s), ed)
        except Exception:
            continue
        for w in words:
            p = w["prompt"]
            lst = mp.get(p)
            if lst is None:
                mp[p] = [s]
            elif s not in lst:
                lst.append(s)
    # 用户自建的槽：词库里没有归属，只有他自己加进去的那些
    for c in (ed.get("custom") or []):
        nm = c.get("name")
        if not nm:
            continue
        for p in ((ed.get("added") or {}).get(nm) or []):
            lst = mp.get(p)
            if lst is None:
                mp[p] = [nm]
            elif nm not in lst:
                lst.append(nm)
    if len(_SLOTOF_CACHE) >= _SLOTOF_MAX:
        _SLOTOF_CACHE.clear()
    _SLOTOF_CACHE[key] = mp
    return mp


def _slots_of_drop_cache():
    _SLOTOF_CACHE.clear()


@PromptServer.instance.routes.get("/pc/slots_of")
async def pc_slots_of(request):
    """反查：某个词当前在哪些槽里（网页的 slotsOf）。空数组 = 还没被任何槽收录。"""
    try:
        db = Data.get()
        prompt = request.query.get("prompt") or ""
        if not prompt:
            return _ok({"prompt": "", "slots": [], "total": len(db.slot_order)})
        gender = GENDER_MAP.get(request.query.get("gender"), "f")
        nsfw = request.query.get("nsfw", "1") not in ("0", "false")
        mp = _slots_of_map(gender, nsfw)
        slots = list(mp.get(prompt) or [])
        # 按 SLOT_ORDER 排（前端展示顺序稳定）
        order = {s: i for i, s in enumerate(db.slot_order)}
        slots.sort(key=lambda s: order.get(s, 9999))
        # 顺带把中文名带上 —— 选槽弹窗的标题要显示「把「克劳斯（王之逆袭）」…」（对齐网页）
        i = db.by_prompt.get(prompt)
        cn = db.word(i)["name"] if i is not None else ""
        # ⭐ 2026-10-20（阿君：删了角色再搜一个补进来，作品名还是原来那个）：
        #   把「这个词属于哪部作品」一起返回 —— 前端加角色时要把旧的作品词换掉。
        #   用 core 里那条同一条 cr_resolve（和自动补作品完全同源），
        #   ⛔ 别在 JS 里自己猜括号 / 猜前缀，两边猜法不一样就会补出错的作品。
        cr = None
        try:
            _cr = db.cr_resolve(prompt, cn)
            if _cr:
                _j = db.cr_by_prompt.get(_cr)
                if _j is not None:
                    _w = db.word(_j)
                    cr = {"prompt": _w["prompt"], "name": _w["name"]}
        except Exception:
            cr = None
        # ⭐ 2026-10-21（阿君：换了角色没同步补上人物特征）：
        #   把这个角色的标志性特征词（CHAR_TRAITS 映射，和抽取时强制补特征同源）
        #   一起返回 —— 前端手动换角色时把特征词也补上。没有映射返回空数组。
        tr = []
        try:
            _tl = db.traits_for(prompt) or []
            for _t in _tl:
                _ti = db.by_prompt.get(_t)
                tr.append({"prompt": _t,
                           "name": (db.word(_ti)["name"] if _ti is not None else _t)})
        except Exception:
            tr = []
        return _ok({"prompt": prompt, "name": cn or "", "slots": slots,
                    "cr": cr, "tr": tr, "total": len(db.slot_order)})
    except Exception as e:
        return _err("槽位反查失败: %s" % e, 500)


# ⭐ 2026-10-20（阿君：切了工作流再切回来，节点里刚才组合的标签全没了）：
#   「上一组 / 下一组」那份历史原来只存在面板的内存数组里 —— 切工作流 = 节点重建 = 全丢。
#   这里给它一个落盘的家：data/hist.json（**和 user_edits.json 分开**，
#   否则每改一次权重都要把几十万字节的历史一起 POST 上去）。
#   存的是最近 100 组：{tags, pos, seed, pinned, params}。
_HIST_FILE = os.path.join(DATA_DIR, "hist.json")
_HIST = None
_HIST_MAX = 100


def _hist_load():
    global _HIST
    if _HIST is None:
        try:
            with open(_HIST_FILE, "r", encoding="utf-8") as f:
                _HIST = json.load(f)
        except Exception:
            _HIST = []
        if not isinstance(_HIST, list):
            _HIST = []
    return _HIST


def _hist_save():
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(_HIST_FILE, "w", encoding="utf-8") as f:
            json.dump(_HIST, f, ensure_ascii=False)
    except Exception as e:
        print("[prompt-combiner] 保存历史失败:", e)


def _hist_clean(rows):
    """只留认识的字段，顺手限长 —— 前端塞什么进来都不能把文件写坏。"""
    out = []
    for e in (rows or [])[:_HIST_MAX]:
        if not isinstance(e, dict):
            continue
        tags = []
        for t in (e.get("tags") or [])[:120]:
            if not isinstance(t, dict):
                continue
            tags.append({
                "prompt": str(t.get("prompt") or ""),
                "name": str(t.get("name") or ""),
                "slot": str(t.get("slot") or ""),
                "out": str(t.get("out") or ""),
            })
        out.append({
            "tags": tags,
            "pos": str(e.get("pos") or ""),
            "seed": int(e.get("seed") or 0),
            "pinned": bool(e.get("pinned")),
            "params": e.get("params") if isinstance(e.get("params"), dict) else {},
        })
    return out


@PromptServer.instance.routes.get("/pc/hist")
async def pc_hist_get(request):
    return _ok({"hist": _hist_load()})


@PromptServer.instance.routes.post("/pc/hist")
async def pc_hist_post(request):
    global _HIST
    try:
        data = await request.json()
    except Exception:
        return _err("请求不是有效 JSON")
    if not isinstance(data.get("hist"), list):
        return _err("hist 必须是数组")
    _HIST = _hist_clean(data["hist"])
    _hist_save()
    return _ok({"saved": len(_HIST)})


# ⭐ 2026-10-20（阿君：槽位管理里有些标签还是没有中文）：
#   构图 / 镜头 / 光圈那批词是**手动加的**，不在 dictionary.json 里 ——
#   词库查不到就退到 data/cn_extra.json（人工对照表，可自己往里加）。
_CN_EXTRA = None


def _cn_extra():
    global _CN_EXTRA
    if _CN_EXTRA is None:
        try:
            with open(os.path.join(DATA_DIR, "cn_extra.json"), "r", encoding="utf-8") as f:
                _CN_EXTRA = json.load(f) or {}
        except Exception:
            _CN_EXTRA = {}
        if not isinstance(_CN_EXTRA, dict):
            _CN_EXTRA = {}
    return _CN_EXTRA


# ⭐ 2026-10-20（阿君：槽位管理里那些英文标签加个中文对照）：
#   批量查「英文标签 → 中文名」。槽位管理的抽取频率 / 提示词权重 / 全局剔除 /
#   改动历史动辄几十上百个词，逐个调 /pc/slots_of 太浪费，所以一次 POST 全部带回来。
#   查不到就**不返回这个键**（手输词），前端留空显示，不猜、不编。
def _names_for(words):
    """英文标签 → 中文名。词库优先，查不到退到 cn_extra.json；都没有就不返回这个键。

    ⚠️ 抽成函数是为了能被测试直接调（路由是 async，离线测不了）。
    """
    db = Data.get()
    extra = _cn_extra()
    out = {}
    for w in (words or [])[:3000]:
        key = str(w or "")
        if not key:
            continue
        i = db.by_prompt.get(key)
        nm = ""
        if i is not None:
            nm = str(db.word(i).get("name") or "")
        if not nm or nm == key:
            nm = str(extra.get(key) or extra.get(key.replace(" ", "_")) or "")
        if nm and nm != key:
            out[key] = nm
    return out


@PromptServer.instance.routes.post("/pc/names")
async def pc_names(request):
    try:
        data = await request.json()
    except Exception:
        return _err("请求不是有效 JSON")
    words = data.get("words") if isinstance(data, dict) else None
    if not isinstance(words, list):
        return _err("words 必须是数组")
    return _ok(_names_for(words))


@PromptServer.instance.routes.get("/pc/slotpool")
async def pc_slotpool(request):
    """某槽的**当前池**（已应用用户增删），分页返回。

    ⚠️ 角色槽两万多词，绝不能一次下发 —— 必须分页。
    """
    global _DB_REF
    try:
        db = Data.get()
        _DB_REF = db
        slot = request.query.get("slot", "")
        ed_all = _user_load().get("slotEdits") or {}
        custom_names = set(c.get("name") for c in (ed_all.get("custom") or []) if c.get("name"))
        # ⚠️ 槽位列表是静态的（来自 rules.json），用户新建的槽要单独认
        if slot not in db.slot_order and slot not in custom_names:
            return _err("没有这个槽位: " + str(slot))
        page = max(1, int(request.query.get("page", 1) or 1))
        size = min(2000, max(10, int(request.query.get("size", 100) or 100)))
        q = (request.query.get("q") or "").strip().lower()
        gender = GENDER_MAP.get(request.query.get("gender"), "f")
        nsfw = request.query.get("nsfw", "1") not in ("0", "false")

        pool = Pool(db, gender=gender, nsfw_filter=nsfw, black=load_user_black(),
                    nsfw_only=(request.query.get("nsfwOnly", "0") not in ("0", "false", "")))
        # 自定义槽：词库侧没有归属，只用用户手动加进去的词
        if slot in custom_names:
            words = []
        else:
            words = pool.slot_list(slot)
        ed = _user_load().get("slotEdits") or {}
        words = _apply_slot_edits(slot, words, ed)

        if q:
            words = [w for w in words
                     if q in str(w["prompt"]).lower() or q in str(w["name"] or "")]
        total = len(words)
        start = (page - 1) * size
        chunk = words[start:start + size]
        removed = ed.get("removed", {}).get(slot) or []
        added = ed.get("added", {}).get(slot) or []
        return _ok({
            "slot": slot, "total": total, "page": page, "size": size,
            "pages": max(1, (total + size - 1) // size),
            "removed": removed, "added": added,
            "renamed": (ed.get("renamed") or {}).get(slot) or "",
            "words": [{"prompt": w["prompt"], "name": w["name"], "category": w.get("category"),
                       "n": w.get("n"), "pc": w.get("pc"), "g": w.get("g")} for w in chunk],
        })
    except Exception as e:
        return _err("读取槽位池失败: %s" % e, 500)


# ===== 子分类（对齐网页 SUBCAT_RULES 的语义，2026-09-29）=====
# 网页那边 subNameOf() 的规则（**必须逐字对齐**，否则两边数量对不上）：
#   ① SUBCAT_RULES[cat] 是 [[名称, 正则], …] → **首个命中**的子类；都没命中再按热度分
#      「其他·热门」(pc>=10000) / 「其他·长尾」—— 不是"每个命中都算一次"。
#   ② SUBCAT_RULES[cat] === null（版权 / 画师）→ 按 prompt 首字母分 A-F/G-L/M-R/S-Z/其他。
#   ③ 不在 SUBCAT_RULES 里的分类（角色）→ 网页走的是「系列」那套，不是子分类。
_OTHER_HOT = "其他·热门"
_OTHER_LONG = "其他·长尾"
_OTHER_PC = 10000


def _alpha_labels():
    try:
        v = Data.get().R.get("ALPHA_LABELS")
        return list(v) if v else ["A-F", "G-L", "M-R", "S-Z", "其他"]
    except Exception:
        return ["A-F", "G-L", "M-R", "S-Z", "其他"]


_SPEC_CACHE = {}


def _subcat_spec(cat):
    """('rules', [(名称, 已编译正则), …]) | ('alpha', [段名, …]) | (None, [])"""
    if not cat:
        return (None, [])
    if cat in _SPEC_CACHE:
        return _SPEC_CACHE[cat]
    raw = None
    try:
        raw = (Data.get().R.get("SUBCAT_RULES") or {}).get(cat, "__none__")
    except Exception:
        raw = "__none__"
    if raw == "__none__":
        out = (None, [])
    elif raw is None:
        out = ("alpha", _alpha_labels())
    else:
        comp = []
        bad = []
        for item in raw:
            name, pat = item[0], item[1]
            try:
                if isinstance(pat, re.Pattern):       # _unwrap 已编译好
                    comp.append((name, pat))
                elif isinstance(pat, dict) and pat.get("__type") == "RegExp":
                    comp.append((name, re.compile(pat.get("source") or "", re.I)))
                else:
                    comp.append((name, re.compile(pat, re.I)))
            except Exception:
                bad.append(name)
        if bad:
            # ⛔ 2026-09-29 踩过：extract_data.js 只对顶层做 RegExp 打包，
            #    SUBCAT_RULES 是嵌套结构 ⇒ 15 个正则被 JSON.stringify 变成 {}，
            #    这里 except 一吞就"静默无子分类"。所以**必须吵出来**。
            print("[prompt-combiner] ⚠ SUBCAT_RULES[%s] 有 %d 条正则不可用：%s"
                  "（数据坏了 → 见 data/README.md「嵌套 RegExp」）"
                  % (cat, len(bad), "/".join(bad)))
        out = ("rules", comp) if comp else (None, [])
    _SPEC_CACHE[cat] = out
    return out


def _subcat_list(cat):
    """该分类的子分类名（**固定顺序**，含空的「其他·热门/长尾」，前端要摆全）。"""
    kind, spec = _subcat_spec(cat)
    if kind == "alpha":
        return list(spec)
    if kind == "rules":
        return [n for n, _ in spec] + [_OTHER_HOT, _OTHER_LONG]
    return []


_SUB_OF_CACHE = {}


def _subcat_of(cat, prompt, pc):
    """词 → 子分类名（'' = 该分类没有子分类）。"""
    key = (cat, prompt)
    v = _SUB_OF_CACHE.get(key)
    if v is not None:
        return v
    kind, spec = _subcat_spec(cat)
    if kind == "alpha":
        c = re.sub(r"[^a-z]", "", str(prompt).lower())[:1].upper()
        r = ("A-F" if "A" <= c <= "F" else
             "G-L" if "G" <= c <= "L" else
             "M-R" if "M" <= c <= "R" else
             "S-Z" if "S" <= c <= "Z" else "其他")
    elif kind == "rules":
        r = ""
        for name, rx in spec:
            if rx.search(str(prompt)):
                r = name
                break
        if not r:
            r = _OTHER_HOT if (pc or 0) >= _OTHER_PC else _OTHER_LONG
    else:
        r = ""
    if len(_SUB_OF_CACHE) > 400000:
        _SUB_OF_CACHE.clear()
    _SUB_OF_CACHE[key] = r
    return r


@PromptServer.instance.routes.get("/pc/subcats")
async def pc_subcats(request):
    """某分类的子分类 + 各有多少条（给面板的子分类 chips 用）。

    ⚠️ 语义完全照网页 subNameOf()：**首个命中**（一个词只归一个子类）+ 首字母分段。
       原来这里是"每个正则命中都 +1"，同一个词会被算进多个子类 ⇒ 加起来比总数还多。
        5 万条的「通用」一打开就平铺太臃肿，网页的做法是「先按语义域切开」。
    """
    try:
        db = Data.get()
        cat = request.query.get("cat") or ""
        labels = _subcat_list(cat)
        if not labels:
            return _ok({"cat": cat, "subs": [], "total": 0})
        nsfw = request.query.get("nsfw", "1") not in ("0", "false")
        cnt = dict((n, 0) for n in labels)
        total = 0
        for i in range(len(db.dict_rows)):
            w = db.word(i)
            if w["category"] != cat:
                continue
            if nsfw and w["n"] == 1:
                continue
            nm = _subcat_of(cat, w["prompt"], w.get("pc"))
            if nm in cnt:
                cnt[nm] += 1
            total += 1
        # 保序输出（规则顺序 + 其他·热门/长尾），空的不发
        subs = [{"name": n, "n": cnt[n]} for n in labels if cnt[n] > 0]
        return _ok({"cat": cat, "subs": subs, "total": total})
    except Exception as e:
        return _err("子分类统计失败: %s" % e, 500)


def _subcat_rules(cat):
    """取某分类的子分类规则 [[名称, 正则源], …]（来自 rules.json 的 SUBCAT_RULES）"""
    try:
        return (Data.get().R.get("SUBCAT_RULES") or {}).get(cat) or []
    except Exception:
        return []


_SUB_RE_CACHE = {}


def _subcat_regex(cat, sub):
    """把「分类 + 子分类名」编成已编译正则；没有该子分类则返回 None。"""
    if not cat or not sub:
        return None
    key = (cat, sub)
    if key in _SUB_RE_CACHE:
        return _SUB_RE_CACHE[key]
    rx = None
    for name, pat in _subcat_rules(cat):
        if name == sub:
            try:
                rx = re.compile(pat, re.I)
            except Exception:
                rx = None
            break
    _SUB_RE_CACHE[key] = rx
    return rx


# ⭐ 2026-10-20（阿君：选了女性池，角色槽里/搜索里就该全是女性）：
#   角色池是**按性别构建**的（Pool.slot_list("角色")），但 /pc/dict 原来只按
#   分类/关键词过滤，没查性别 ⇒ 能在"只看女性"下搜到男性角色、怪兽。
#   这里缓存每个性别档的角色白名单（一次构建 ~2MB），搜索时做集合判断。
_CHAR_SET_CACHE = {}


def _char_set(gender, nsfw):
    key = (gender, bool(nsfw), len(load_user_black()))   # 黑名单变了要重建缓存
    got = _CHAR_SET_CACHE.get(key)
    if got is None:
        db = Data.get()
        got = {str(w["prompt"]) for w in Pool(db, gender=gender, nsfw_filter=nsfw, black=load_user_black()).slot_list("角色")}
        _CHAR_SET_CACHE[key] = got
    return got


@PromptServer.instance.routes.get("/pc/dict")
async def pc_dict(request):
    """词库浏览：按分类 / 子分类 / 关键词分页查询（25.6 万条不能一次下发）。"""
    try:
        db = Data.get()
        cat = request.query.get("cat") or ""
        sub = request.query.get("sub") or ""            # 子分类名（2026-09-29 对齐网页）
        # meta=1 → 连「元数据」类一起浏览（网页词库里有这一类；标签联想不带，保持干净）
        with_meta = request.query.get("meta", "0") not in ("0", "", "false", "False")
        q = (request.query.get("q") or "").strip().lower()
        page = max(1, int(request.query.get("page", 1) or 1))
        size = min(2000, max(10, int(request.query.get("size", 60) or 60)))
        gender = GENDER_MAP.get(request.query.get("gender"), "f")
        nsfw = request.query.get("nsfw", "1") not in ("0", "false")

        pool = Pool(db, gender=gender, nsfw_filter=nsfw, black=load_user_black())
        _dict_black = {str(p).replace(" ", "_").lower() for p in pool.black}
        # 一个循环同时处理「分类 + 关键词」（两者可叠加）——
        # 原来分两条分支，搜索时 cat 被忽略，且留了段无用的 pass 死代码。
        CAPPED = 3000
        rows = []
        capped = False
        # 角色要按当前性别档过滤（其余分类不受影响）
        _cs = _char_set(gender, nsfw)
        ql = q.lower()
        # 子分类过滤：走 _subcat_of（首个命中 + 首字母分段，与网页/子分类统计同一套语义）
        for i in range(len(db.dict_rows)):
            w = db.word(i)
            # 全局黑名单不只约束角色池；通用/画师/版权等分类的词库浏览
            # 也不能继续展示已剔除标签。此前构造了 pool 却没有实际使用。
            _prompt_key = str(w["prompt"] or "").replace(" ", "_").lower()
            if _prompt_key in _dict_black:
                continue
            if cat and w["category"] != cat:
                continue
            if sub and _subcat_of(cat, w["prompt"], w.get("pc")) != sub:
                continue
            if w["category"] == "元数据" and not with_meta:
                continue
            # 角色：只留当前性别档池子里的（女性池就没有男性角色/怪兽）
            if w["category"] == "角色" and str(w["prompt"]) not in _cs:
                continue
            if nsfw and w["n"] == 1:
                continue
            if ql:
                # ⭐ 2026-10-14 对齐网页 tsSearch 的评分排序：
                #    中文名精确(100) > 中文名前缀(94) > prompt 精确(90) > prompt 前缀(86)
                #    > 中文名包含(74) > prompt 包含(58)；同级按热度 pc 降序。
                #    原来只做 `if ql in ...` 包含匹配 + 词典序，结果排序和质量跟网页完全对不上。
                #   ⚠️ prompt 侧匹配要把空格转下划线：网页 tsSearch 认"cat e"→cat_e
                #     （联想搜索时用户常打空格），中文名侧仍按原文匹配。
                nm = str(w["name"] or "").lower()
                pm = str(w["prompt"] or "").lower()
                qp = ql.replace(" ", "_")
                sc = -1
                at = 0
                if nm == ql:
                    sc = 100
                elif nm.startswith(ql):
                    sc = 94
                elif pm == qp:
                    sc = 90
                elif pm.startswith(qp):
                    sc = 86
                else:
                    j = nm.find(ql)
                    if j > 0:
                        sc = 74
                        at = j
                    else:
                        k = pm.find(qp)
                        if k > 0:
                            sc = 58
                            at = k
                if sc < 0:
                    continue
                rows.append((w, sc, at))
                if len(rows) >= CAPPED:
                    capped = True
                    break
                continue
            rows.append((w, 0, 0))
            if len(rows) >= CAPPED:
                capped = True
                break
        if ql:
            rows.sort(key=lambda t: (-t[1], t[2], -(t[0].get("pc") or 0)))
        total = len(rows)
        start = (page - 1) * size
        chunk = rows[start:start + size]
        chunk = [w for (w, _s, _a) in chunk]
        cats = {}
        for i in range(len(db.dict_rows)):
            c = db.dict_rows[i][6]
            cats[c] = cats.get(c, 0) + 1
        return _ok({
            "total": total, "page": page, "size": size,
            "pages": max(1, (total + size - 1) // size),
            "capped": capped,          # True = 命中超过 3000，total 只是下限
            "cats": cats,
            # 2026-10-18：**必须带 slot** —— 阿君报「搜索选中的标签槽位显示成『自定』」。
            # 面板的 onPick 靠 it.slot 定槽（决定互斥组 / 中文对照 / 是否算角色）。
            "words": [{"prompt": w["prompt"], "name": w["name"], "category": w.get("category"),
                       # ⚠️ slot_of_row 的键是**下划线**写法（shenhe_(genshin_impact)），
                       # 不是带空格的；两种都试一下最稳。
                       "slot": (db.slot_of_row.get(str(w["prompt"]).replace(" ", "_"))
                                or db.slot_of_row.get(w["prompt"]) or ""),
                       "n": w.get("n"), "pc": w.get("pc")} for w in chunk],
        })
    except Exception as e:
        return _err("词库查询失败: %s" % e, 500)


