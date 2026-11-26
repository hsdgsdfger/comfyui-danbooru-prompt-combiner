# ComfyUI 词库随机组合节点 · 核心逻辑
# 从 C:/Users/Mrxie.X/Desktop/词库随机组合工具.html 移植
# 数据由 extract_data.js / verify_data.js / fix_data.js 导出到 ./data/
import json
import os
import random
import re

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")


def _unwrap(v):
    """还原导出时的 Set/Map/RegExp 包装（见 data/README.md）"""
    if isinstance(v, dict):
        t = v.get("__type")
        if t == "Set":
            return set(v["v"])
        if t == "Map":
            return dict(v["v"])
        if t == "RegExp":
            return re.compile(v["source"], _flags(v["flags"]))
        if t == "RegExpPairs":
            return [(re.compile(s, _flags(f)), tr) for s, f, tr in v["v"]]
        return {k: _unwrap(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_unwrap(x) for x in v]
    return v


def _flags(f):
    n = 0
    if "i" in f:
        n |= re.I
    if "m" in f:
        n |= re.M
    if "s" in f:
        n |= re.S
    return n


_CN_SERIES_RE = re.compile(r"[（(]([^）)]*)[）)]\s*$")

# ===== 自动补作品标签：解析用正则 / 阈值（2026-10-11 第二轮）=====
_EN_ALL_RE = re.compile(r"\(([^)]*)\)")           # prompt 里**每一对**英文括号
_EN_LAST_RE = re.compile(r"\(([^)]*)\)\s*$")       # 最后一对（变体回退用）
_CN_ALL_RE = re.compile(r"[（(]([^）)]*)[）)]")     # 中文名里**每一对**括号
_CR_CN_NORM_RE = re.compile(r"[\s·・\-—_!！?？:：,，、.。'\"“”‘’/\\+&~～]+")
_CR_ASCII_RE = re.compile(r"[A-Za-z]")             # 中文名括号里写的是英文作品名（Code_Geass）
_CR_CN_MIN_PC = 500        # 中文名「归一化后完全相等」才算命中；再叠热度门槛挡同名冷门词
# 「一眼不是作品」的括号内容形态：服装 / 形态 / 年份批次（精确词如 human/male/summer
# 另有 SERIES_CR_NONE 表兜住）。命中就不当系列后缀去解析。
# ⚠️ 只做「跳过」（少补），绝不猜（补错）——错词进提示词比不补更糟。
_CR_SHAPE_RE = re.compile(
    r"(_costume|_swimsuit|_dress|_wear|_uniform|_ascension|_casual|_loungewear|"
    r"_style|_form|_ver\b|_version|^\d{4}_|_\d{4}$|^alt$"
    r"|_outfit\b|_attire\b|_mode\b|_type\b|_look\b|_garb\b|_suit\b"
    r"|[_-]servant\b|[_-]beast\b|[_-]spirit\b|_skin\b|[_-]variant\b|[_-]alternate\b|[_-]counterpart\b"
    r"|[_-]cosplay\b|[_-]parody\b|[_-]role\b|[_-]job\b|[_-]class\b|[_-]occupation\b"
    r"|older|younger|adult\b|elder\b|child\b|baby\b"
    r"|fall/winter|spring/summer|summer/winter|winter/summer"
    r"|_drawn_by|_commission|_paid\b|_reward\b|_prize\b|_contest\b|_appli\b"
    r"|^new$|^old$|^first$|^second$|^third$|^zero$)")
# 「一眼不是作品」的中文括号内容（类别 / 形态词）。⛔ 这类词在 SERIES_ARR 里被上游错配过：
#   「机体」→ 机动战士高达（魔神Z 被补成高达）、「暗世界」→ 黑暗世界。命中就跳过。
_CR_CN_NONE = {"机体", "人类", "人类形态", "原型", "角色", "人物", "拟人化", "未知",
               "其他", "其它", "男", "女", "男性", "女性", "性别不明", "种族", "生物",
               "形态", "版本", "皮肤", "兽", "动物", "植物", "物品", "服装", "衣服"}


def nz(x):
    """prompt 里的空格换成下划线（网页的 nzP / nzC）"""
    return str((x or {}).get("prompt") if isinstance(x, dict) else (x or "")).replace(" ", "_")


def series_of(prompt):
    """从角色名尾部取 _(作品)  里的作品名（没有则返回空串）。
    对齐网页侧 `p.match(/\\(([^)]*)\\)\\s*$/)` —— 用于系列级特征与排除表。"""
    m = re.search(r"\(([^)]*)\)\s*$", str(prompt or ""))
    return m.group(1) if m else ""


def tok_match(p, words):
    """词元匹配：单 token 词要求词元集合精确包含；含 _ 或 - 的复合词用子串匹配"""
    t = str(p or "").replace(" ", "_")
    toks = t.split("_")
    for w in words:
        wt = str(w).replace(" ", "_")
        if "_" in wt or "-" in wt:
            if wt in t:
                return True
        elif wt in toks:
            return True
    return False


# ===== 系列筛选（2026-09-29 补完）=========================================
# 移植网页版 seriesSlotList()：精确命中 → 包含匹配 → 字符重合率近似（兜一字之差的
# 误记，如「碧蓝档案」vs「蔚蓝档案」）→ 系列族扩展（Fate → FGO/Fate Zero…）。
# 再叠一层「中文名/英文 prompt 子串」兜底 —— SERIES_MAP 只覆盖 46% 的角色，
# 剩下的一万多词（新番 / 同人 / 小作品）只能靠名字里那对括号定位。
# ==========================================================================

_SER_SEP = re.compile(r"[\s\u3000_·・:：\-—/]+")
_SER_CACHE_MAX = 256


def _flat(s):
    """去掉分隔符 + 转小写，用于「近似相等」比较"""
    return _SER_SEP.sub("", str(s or "")).lower()


def _char_sim(a, b):
    """字符集合重合率（网页 seriesCharSim 的 Python 版）"""
    if not a or not b:
        return 0.0
    sa, sb = set(a), set(b)
    return sum(1 for ch in sa if ch in sb) / max(len(sa), len(sb))


def series_resolve(db, kw):
    """把系列名解析成「角色 prompt 集合」。

    返回 (allow|None, info)：
      allow = None  → 不筛选（输入为空，或压根没命中任何系列）
      info  = {"q","matched","series","count","sub"}
    """
    kw = str(kw or "").strip()
    if not kw:
        return None, {"q": "", "matched": True, "series": [], "count": 0, "sub": 0}

    cache = db._series_cache
    if kw in cache:
        return cache[kw]

    R = db.R
    SM = R.get("SERIES_MAP") or {}
    SF = R.get("SERIES_FAMILY") or {}

    # 归一化：全角空格 → 普通空格 → 下划线
    k = re.sub(r"[\u3000]+", " ", kw).lower().replace(" ", "_").strip("_")
    kwFlat = _flat(kw)
    kNoSep = kwFlat

    # 1) 精确命中（中文名 / 英文名 / 去分隔符后相等）
    mains = []
    for en, v in SM.items():
        label = v.get("cn") or en
        if label == kw or en == k or _flat(label) == kwFlat \
                or en.replace("_", "").replace("-", "") == kNoSep:
            mains.append(en)
    # 同名小系列剔除：精确命中多个时，角色数不足最大系列 10% 的判为「碰瓷」
    if len(mains) > 1:
        mx = max(len(SM[e].get("idx") or []) for e in mains)
        mains = [e for e in mains if len(SM[e].get("idx") or []) * 10 >= mx]
    # 2) 退化为包含匹配
    if not mains:
        for en, v in SM.items():
            label = str(v.get("cn") or en)
            if (label and (kw in label or label in kw)) or (k and (k in en or en in k)):
                mains.append(en)
        # ⛔ 包含匹配必须同样过「碰瓷」过滤 —— 否则输入 genshin 会把
        #    en 键叫 shin / in / gen 的三个小系列一起拖进来（网页版就有这个洞）。
        if len(mains) > 1:
            mx = max(len(SM[e].get("idx") or []) for e in mains)
            mains = [e for e in mains
                     if len(SM[e].get("idx") or []) * 10 >= mx]
    # 3) 再退化：字符重合率近似（同字数 + 重合 ≥0.6）
    if not mains and len(kwFlat) >= 2:
        best, bs = None, 0.0
        for en, v in SM.items():
            lf = _flat(v.get("cn") or en)
            if len(lf) != len(kwFlat):
                continue
            s = _char_sim(lf, kwFlat)
            if s >= 0.6 and s > bs:
                bs, best = s, en
        if best:
            mains.append(best)

    # 4) 系列族扩展
    want = set(mains)
    for en in SM:
        for m in mains:
            if (SF.get(en) and SF.get(en) == SF.get(m)) or en.startswith(m):
                want.add(en)
                break

    allow = set()
    for en in want:
        for i in (SM[en].get("idx") or []):
            allow.add(db.dict_rows[i][0])

    # 5) 子串兜底（SERIES_MAP 没收录的作品）
    sub = 0
    if kwFlat:
        for fn, fp, pr in db.role_index:
            if kwFlat in fn or kwFlat in fp:
                allow.add(pr)
                sub += 1

    labels = []
    for c in mains:
        lb = SM[c].get("cn") or c
        if lb not in labels:
            labels.append(lb)

    out = (frozenset(allow) if allow else None,
           {"q": kw, "matched": bool(allow), "series": labels[:8],
            "count": 0, "sub": sub})
    if len(cache) >= _SER_CACHE_MAX:
        cache.clear()
    cache[kw] = out
    return out


class Data:
    """全部数据只加载一次（ComfyUI 是常驻进程）"""
    _inst = None

    @classmethod
    def get(cls):
        if cls._inst is None:
            cls._inst = cls()
        return cls._inst

    def __init__(self):
        import time
        t0 = time.time()
        with open(os.path.join(DATA_DIR, "dictionary.json"), "r", encoding="utf-8") as f:
            self.dict_rows = json.load(f)
        with open(os.path.join(DATA_DIR, "slot_idx.json"), "r", encoding="utf-8") as f:
            self.slot_idx = json.load(f)
        with open(os.path.join(DATA_DIR, "rules.json"), "r", encoding="utf-8") as f:
            self.R = _unwrap(json.load(f))
        self.load_sec = round(time.time() - t0, 2)

        self._words = {}
        self.presets = self.R["COMBO_PRESETS"]
        self.slot_pack = self.R["SLOT_PACK"]
        # ⭐ 2026-10-06：槽位表**不能直接引用 rules.json** —— 必须合并用户自建/删除的槽位
        #   （见 refresh_slots 的说明）
        self.refresh_slots()

        self.by_prompt = {}
        for i, r in enumerate(self.dict_rows):
            if r[0] not in self.by_prompt:
                self.by_prompt[r[0]] = i

        # 系列筛选用：角色行的 (扁平化中文名, 扁平化英文 prompt, prompt) 三元组
        # —— 预建一次，避免每次查询都遍历 32.7 万行
        self.role_index = []
        for r in self.dict_rows:
            if r[6] == "角色":
                self.role_index.append((_flat(r[1]), _flat(r[0]), r[0]))
        self._series_cache = {}

        # ===== 系列 → 作品（版权）标签映射（2026-10-11，自动补作品tag）=====
        #   角色 prompt 尾部 _(xxx) 取系列后缀，解析成真正的版权词：
        #     ① 后缀本身是版权词（原神 / 明日方舟 …）
        #     ② 后缀 + _(series)/_(franchise) 是版权词（fate → fate_(series)）
        #     ③ SERIES_CR_OVERRIDE 人工映射（kancolle → kantai_collection）
        #   ⚠️ 故意**不做**「唯一前缀」猜测：实测 kancolle→kancolle_arcade、
        #      character→character_select_collab 全是错的，错词进提示词比不补更糟。
        #   SERIES_CR_NONE = 明确不是作品的后缀（1st_costume / vtuber / racehorse …），
        #   留作文档；解析不到本来就是「不补」，不读它也行。
        self.cr_by_prompt = {}       # 版权 prompt -> 词典行号
        for i, r in enumerate(self.dict_rows):
            if r[6] == "版权":
                self.cr_by_prompt[r[0]] = i
        # ⭐ 中文名兜底（2026-10-11 补）：45.5% 的角色**没有**英文 _(系列) 后缀
        #   （danbooru 只给重名角色加限定词），但中文名里带「（作品名）」。
        #   ⇒ 建一张「中文作品名 -> 版权词」，让 初音未来/博丽灵梦 这类也能补上。
        #   ⚠️ 一个中文名可能对应多个版权词（东方Project → touhou / touhou_(pc-98)）：
        #      排序**优先无括号的总集词**，其次 _(series)，最后才按热度 ——
        #      否则会选到 `sonic_the_hedgehog_(idw)` / `silent_hill_(movie)` 这种分作。
        self.cr_by_cn = {}
        _tmp = {}
        for p, i in self.cr_by_prompt.items():
            w = self.word(i)
            cn = re.sub(r"[（(][^）)]*[）)]\s*$", "", str(w.get("name") or "")).strip()
            if cn:
                _tmp.setdefault(cn, []).append(i)

        def _rank(i):
            pp = str(self.word(i).get("prompt") or "")
            pc = int(self.word(i).get("pc") or 0)
            if pp.endswith(("_(series)", "_(franchise)")):
                tier = 0                       # 总集词最优先（dark_souls_(series)）
            elif ("(" not in pp and ":" not in pp) and pc >= 1000:
                tier = 1                       # 真正的本传（touhou / pokemon / vocaloid）
            else:
                tier = 2                       # 分作 / 冷门（silent_hills / sonic_the_hedgehog_(idw)）
            return (tier, -pc)
        for cn, idxs in _tmp.items():
            self.cr_by_cn[cn] = self.word(sorted(idxs, key=_rank)[0])["prompt"]
        self._series_cr_cache = {}   # 系列后缀（归一化）-> 版权 prompt / None
        self._cr_resolve_cache = {}  # (prompt, 中文名) -> 版权 prompt / None

        # ===== 第二轮扩容（2026-10-11 下午）：把 63.7% 的覆盖率往上抬 =====
        #   实测口径（10.2 万角色池）：63.7% → 65.9%，净增 2.26%。逐级增量（每级都抽样人工判过）：
        #     L2 「更早的括号」      0.46% —— (_(人类形态) / _(画师名) 挡在作品名前面
        #     L3 SERIES_ARR 桥接     0.63% —— 英文系列 key ↔ 中文作品名，两侧都能搭桥
        #     L4 中文名归一化命中     1.16% —— 「偶像大师_灰姑娘女孩」vs「偶像大师灰姑娘女孩」
        #   ⛔ 被否决的扩容手段（都实测过、错得离谱，**别再拾回来**）：
        #     · 「去数字」兜底：FF8/FF4 全塞成 final_fantasy_vii、铁拳→tekken_8、
        #       皮克敏→pikmin_4、马力欧→super_mario_64 …… 868 条 100% 落在错的分作上。
        #     · 「唯一前缀」猜测（更早否决）：kancolle→kancolle_arcade。
        # L4 索引：中文名去掉空格/标点后**完全相等**才算命中 —— 不做任何近似/包含匹配。
        self.cr_cn_norm = {}
        for _cn, _cr in self.cr_by_cn.items():
            _k = _CR_CN_NORM_RE.sub("", str(_cn)).lower()
            if len(_k) < 2:
                continue
            _cur = self.cr_cn_norm.get(_k)
            if _cur is None or self._cr_pc(_cr) > self._cr_pc(_cur):
                self.cr_cn_norm[_k] = _cr
        self.cr_cn_norm = {k: v for k, v in self.cr_cn_norm.items()
                           if self._cr_pc(v) >= _CR_CN_MIN_PC}
        # L3 桥接表：SERIES_ARR 的 key ↔ 中文名（两向都建，setdefault 保住热度最高的那条）
        self.arr_key2cn = {}
        self.arr_cn2key = {}
        for _s in (self.R.get("SERIES_ARR") or []):
            try:
                _k = str(_s.get("key") or "").strip().lower()
                _c = str(_s.get("cn") or "").strip()
            except Exception:
                continue
            if _k and _c:
                self.arr_key2cn.setdefault(_k, _c)
                self.arr_cn2key.setdefault(_c, _k)
        self.cr_none = set(self.R.get("SERIES_CR_NONE") or ())

        # ===== L5：danbooru posts 实证兜底表（2026-10-11）=====
        #   来源：danbooru 2023-11-30 全量 posts（686 万帖）里「恰好 1 个角色 tag」的帖，
        #         统计同帖 tag_string_copyright 的多数票（n≥3 且占比≥50%，排除 original/twitter 等平台词，
        #         有总集词时优先 _(series)/_(franchise)）。9255 条，把覆盖率 66.0% 抬到 75.0%。
        #   ⚠️ **只兜底、不覆盖**：L1~L4 解析出来的（角色名里直接写着作品）一律优先 ——
        #      实证票在我们「名字里写着」的证据面前只是其次。
        self.cr_by_char = {}
        for _p, _c in (self.R.get("CR_BY_CHAR") or {}).items():
            if _c in self.cr_by_prompt:
                self.cr_by_char[_p] = _c
        # ⭐ 2026-10-17：角色 -> 作品 的**全量**索引（懒加载）。
        #   为什么不用现成的 cr_by_char：那张只是 cr_resolve 的第 5 级兜底（9255 条，
        #   角色池里只覆盖 14.2%）。而 cr_resolve 走完 5 级能覆盖 99.2%，且很快
        #   （实测 3000 个角色 0.01 秒，全量 9.9 万约 0.3 秒）。
        #   只在「一次抽多个角色」时才建，单角色用法不受影响。
        self._cr_of_char = None
        # L6 变体回退用：角色 prompt -> 中文名（回退时要用**本体自己**的中文名）
        self.role_name = {}
        for _r in self.dict_rows:
            if _r[6] == "角色":
                self.role_name[_r[0]] = _r[1]

        # ===== 标签对互斥 PAIR_MUTEX（2026-10-13）=====
        #   来源：danbooru 686 万帖共现 → 18546 个跨槽候选 → 拿工具自己跑 900 组探测，
        #         只有 81 对真漏（既有规则已拦 99.6%）→ 人工筛出 30 对真冲突。
        #   典型：全套制服/运动服 × 袖型领口词（两套袖子）、表情细节 × 广角远景（根本看不到脸）。
        #   ⚠️ 只做「与已抽到的词冲突就跳过」，不改任何已有过滤逻辑。
        self.pair_mutex = {}
        for _a, _b in (self.R.get("PAIR_MUTEX") or []):
            _a = str(_a).replace(" ", "_"); _b = str(_b).replace(" ", "_")
            self.pair_mutex.setdefault(_a, set()).add(_b)
            self.pair_mutex.setdefault(_b, set()).add(_a)
        # ⭐ 2026-10-20（阿君：这张图「手都错位背到身后去了」）：
        #   「把刀/武器背在身后」× 「手举起」是硬冲突 —— 一个要求手臂在身后，
        #   一个要求抬起来，同时给模型的结果就是手臂穿到背后 / 多一只手。
        #   实测那组（seed 1672170）正是 holding_sword_behind_back + hand_up。
        # ⚠️ 只补这几对，不去改 rules.json（那是 extract/fix 脚本生成的，会被重跑覆盖）。
        for _a, _b in (("holding_sword_behind_back", "hand_up"),
                       ("holding_sword_behind_back", "arm_up"),
                       ("holding_sword_behind_back", "arms_up"),
                       ("holding_weapon_behind_back", "hand_up"),
                       ("holding_weapon_behind_back", "arm_up"),
                       ("holding_weapon_behind_back", "arms_up")):
            self.pair_mutex.setdefault(_a, set()).add(_b)
            self.pair_mutex.setdefault(_b, set()).add(_a)

        # ⭐ 2026-10-20（阿君：「你找一下啊，你找应该比我跑图快得多」）——
        #   把「臂势槽」里**必须两只手**的姿势补进「忙手」名单。
        #   为什么原来会漏：HANDS_BUSY/HANDS_FULL 是按**复数写法**收的
        #   （hands_on_own_hips / hands_in_pockets），单数变体和另一批词没被收录。
        #   实测 3200 组里：paw_pose 14 次、claw_pose 10 次、arm_hug 2 次与「手持物」同框
        #   ⇒ 手里拿着东西还在比「双手猫爪」/「双手比心」，手必然崩。
        # ⚠️ 只补**两只手都被占**的。hand_in_pocket / hand_up / arm_up 这类单数词**不要加**——
        #    一只手持物、另一只手做动作是完全正常的，加了会白白砍掉大量合理组合。
        _hand_busy_extra = ("paw_pose", "claw_pose", "half-heart_hands", "finger_heart",
                            "shrugging", "arm_hug")
        _hb = self.R.get("HANDS_BUSY_PROMPTS")
        if isinstance(_hb, set):
            _hb.update(_hand_busy_extra)
        elif isinstance(_hb, (list, tuple)):
            self.R["HANDS_BUSY_PROMPTS"] = set(_hb) | set(_hand_busy_extra)

        # ===== 细节联动 PAIR_BOOST（2026-10-13，阿君拍板「5」）=====
        #   语义：抽到「东西」时自动带上配套词 —— 道具→「拿着它」（folding_fan → holding_fan）、
        #   服装自带部件（wedding_dress → bridal_veil、suspender_skirt → suspenders）。
        #   来源：danbooru 686 万帖高共现（lift≥15 且共现≥300），剔掉特定角色私搭
        #   （超合达毛衣→时计井制服那种是御坂的梗，不是规则）与子串冗余。
        #   ⚠️ 只补不占：已被抽走的槽位/互斥组不重复占；手持物槽已出词就不抢手。
        self.pair_boost = {}
        for _a, _b in (self.R.get("PAIR_BOOST") or []):
            self.pair_boost[str(_a).replace(" ", "_")] = str(_b).replace(" ", "_")

        # ===== 景别权重 SHOT_WEIGHTS（2026-10-18，阿君「极简景别老出远景」）=====
        #   景别槽 17 个词里只有 5 个带 pc，另外 12 个是手写词包（pc=0）→ 靠中位数兜底，
        #   结果这 12 个各占约 6%，其中 5 个是宽景变体 ⇒ 宽景率 26.3%（实测 300 组）。
        #   ⇒ 给每个景别词**显式权重**，让分布靠向真实拍摄习惯：
        #     半身/中景 56%、特写 22%、全身 13%、宽景 8%（原 47 / 18 / 10 / 26）。
        #   ⚠️ 不是禁用词 —— 每个词仍然抽得到，只是极端构图的份额被压回合理区间。
        #   ⚠️ 与网页 `SHOT_WEIGHTS`（词库随机组合工具.html）同源，改一处要同步另一处。
        self.shot_weight = {}
        for _k, _v in (self.R.get("SHOT_WEIGHTS") or {}).items():
            self.shot_weight[str(_k).replace(" ", "_").lower()] = float(_v)
        _sw = sorted(self.shot_weight.values())
        self.shot_weight_default = _sw[len(_sw) // 2] if _sw else 1.0

        # ===== 用户自定义标签权重 WEIGHTS（2026-10-19 阿君「可以自由给某个标签设置权重」）=====
        #   {prompt: 倍数}，乘在 pick() 的最终权重上。1.0 = 默认，读不到就是空字典。
        #   ⚠️ 会随用户在界面上改而变 ⇒ server 改完 user_edits.json 后必须调
        #      `Data.get().reload_weights()`，否则要重启 ComfyUI 才生效。
        self.weights = load_weights()

        # ===== 用户自定义**提示词权重** PROMPT_W（2026-10-19 阿君纠正：
        #   「我要的不是这个抽取权重啊，是标签在提示词里的权重」）=====
        #   {prompt: 倍数} —— 抽到这个词时，输出成 `(tag:1.5)` 这种**强调语法**。
        #   ⚠️ 与上面的 `weights`（抽取频率）完全是两件事，别混：
        #      · weights        = 抽不抽得到 / 抽得多不多（影响概率，不改文字）
        #      · prompt_weights = 抽到之后在提示词里写多重的括号（影响模型注意力）
        #   1.0 = 默认（**不加括号**，输出跟以前一模一样）。
        #   ⚠️ 真正被 fmt_word 读的是模块级 `_PROMPT_W`，这里只是给出同一份快照。
        self.prompt_weights = load_prompt_weights()

        self.row_by_prompt = {}
        for _i, _r in enumerate(self.dict_rows):
            if _r[0] not in self.row_by_prompt:
                self.row_by_prompt[_r[0]] = _i
        # 词 -> 它被抽的槽（细节联动要用真槽名判断「手持物槽是否已被占」）
        self.slot_of_row = {}
        for _s, _arr in self.slot_idx.items():
            for _i in _arr:
                _p = self.dict_rows[_i][0]
                if _p not in self.slot_of_row:
                    self.slot_of_row[_p] = _s
        # ⭐ 2026-10-21（阿君：加的光照词被甩到标签末尾）：
        #   slot_idx 只覆盖 dictionary.json 里**建过索引**的词，而
        #   光照 / 运镜 / 风格 / 身体与头部协调 / 配色倾向 / 画风取向 这 6 个槽
        #   的词**只存在于 SLOT_PACK**（slot_idx 里都是 0 条）。
        #   ⇒ 「词 → 槽」这张反查表漏了它们 ⇒ /pc/dict 返回 slot:"" ⇒ 面板当「自定」
        #     ⇒ 加进组合时无槽可归位，只能追加到末尾。
        #   抽词能抽到是因为 raw_pool 是 slot_idx + slot_pack **两份合并**，
        #   所以只有这张反查表漏了 —— 这里补上（只填空缺，不覆盖已有归属）。
        for _s, _arr in (self.slot_pack or {}).items():
            for _w in (_arr or []):
                _p = _w.get("prompt") if isinstance(_w, dict) else _w
                _p = str(_p or "").strip()
                if not _p:
                    continue
                for _k in (_p, _p.replace(" ", "_")):
                    if _k and _k not in self.slot_of_row:
                        self.slot_of_row[_k] = _s

        # 派生表（见 data/README.md，Python 侧重建）
        self.char_traits_base = {}
        for k, traits in self.R["CHAR_TRAITS"].items():
            bi = k.find("_(")
            base = k[:bi] if bi > 0 else k
            ser = k[bi:] if bi > 0 else ""
            slot = self.char_traits_base.setdefault(base, {"sers": set(), "traits": traits})
            slot["sers"].add(ser)

        # ANIMAL_ROOT_TRAITS 的正则**预编译**（网页侧同样做法：
        # 每次调用都 new RegExp 会慢，39 项 × 每次抽词 = 浪费）
        self.animal_root_re = []
        for item in self.R.get("ANIMAL_ROOT_TRAITS", []):
            try:
                root, traits = item[0], item[1]
                self.animal_root_re.append(
                    (re.compile(r"(^|_)" + re.escape(str(root)) + r"(_|$)"), traits))
            except Exception:
                continue

    def series_cr(self, series):
        """系列后缀（可带空格/下划线）-> 版权 prompt；解析不到返回 None。带缓存。"""
        key = str(series or "").replace(" ", "_").lower()
        if not key:
            return None
        if key in self._series_cr_cache:
            return self._series_cr_cache[key]
        cr = None
        ovr = self.R.get("SERIES_CR_OVERRIDE") or {}
        if key in ovr:
            cr = ovr.get(key)
        elif key in self.cr_by_prompt:
            cr = key
        elif (key + "_(series)") in self.cr_by_prompt:
            cr = key + "_(series)"
        elif (key + "_(franchise)") in self.cr_by_prompt:
            cr = key + "_(franchise)"
        if cr and cr not in self.cr_by_prompt:
            cr = None               # 映射表里的目标词不存在 → 响亮的「不补」，别输出错词
        self._series_cr_cache[key] = cr
        return cr

    def cr_of_name(self, name):
        """中文名兜底：「雷破山（时空勇士）」→ live_a_live。取不到返回 None。
           ⛔ 与 series_cr 是**两条独立路径**：series_cr 看英文 prompt 的 _(系列)，
              这个看中文名末尾的（作品名）—— 覆盖那 45.5% 没有英文后缀的角色。"""
        m = _CN_SERIES_RE.search(str(name or ""))
        if not m:
            return None
        cr = self.cr_by_cn.get(m.group(1).strip())
        return cr if cr in self.cr_by_prompt else None

    # ---------- 自动补作品标签：统一解析入口（2026-10-11 第二轮）----------

    def char_gender(self, prompt):
        """角色标签的性别标记（'f'/'m'/'0'/''）。查不到返回 ''。"""
        i = self.by_prompt.get(prompt)
        if i is None:
            i = self.by_prompt.get(str(prompt).replace("_", " "))
        if i is None:
            return ""
        return str(self.dict_rows[i][3] or "")

    def cr_of_char(self):
        """角色 prompt(下划线) -> 作品版权词。懒加载，第一次调用时建表。"""
        if self._cr_of_char is None:
            m = {}
            for i in self.slot_idx.get("角色", []):
                r = self.dict_rows[i]
                cr = self.cr_resolve(r[0], r[1])
                if cr:
                    m[str(r[0]).replace(" ", "_")] = cr
            self._cr_of_char = m
        return self._cr_of_char

    def _cr_pc(self, cr):
        """版权词热度（建设索引用，取不到算 0）。"""
        i = self.cr_by_prompt.get(cr)
        return int(self.word(i).get("pc") or 0) if i is not None else 0

    def _cr_group_ok(self, g):
        """这对括号值不值得当「系列后缀」去解析（排除服装/形态/年份批次）。"""
        k = str(g or "").strip().replace(" ", "_").lower()
        if not k or k in self.cr_none:
            return False
        return not _CR_SHAPE_RE.search(k)

    def cr_resolve(self, prompt, name):
        """角色 prompt + 中文名 → 作品版权 prompt；解析不到返回 None。

        四级，从最可信到最宽松（每一级都是「先试到就先返回」）：
          L1 最后一对括号 —— 英文 _(系列) 前缀；再中文名末尾（作品名）。= 旧行为
          L2 更早的括号   —— `diana_(sailor_moon)_(human)`：作品名被 _(人类形态) 挡在后面
          L3 SERIES_ARR 桥接 —— 英文系列 key ↔ 中文作品名 双向搭桥
             （`nargacuga_(...)` 解析不出，但中文名「炎戈龙（怪物猎人）」→ monster_hunter_(series)）
          L4 中文名归一化完全相等 + 热度 ≥ _CR_CN_MIN_PC（去空格/标点，不做近似）
          L5 danbooru posts 实证表 CR_BY_CHAR（9255 条，**只兜底不覆盖**；覆盖率 66.0% → 75.0%）
        ⚠️ L3/L4 都叠了「目标版权词 pc≥_CR_CN_MIN_PC」的门槛（L1/L2 不设：括号本身就写着作品名）。
        ⛔ 故意**不做**任何「猜」：不猜唯一前缀、不做去数字近似（见 __init__ 里的否决记录）。
        """
        key = (str(prompt or ""), str(name or ""))
        if key in self._cr_resolve_cache:
            return self._cr_resolve_cache[key]
        if len(self._cr_resolve_cache) > 20000:   # 兜底：长会话里别让缓存无限涨
            self._cr_resolve_cache.clear()
        en = _EN_ALL_RE.findall(key[0])
        cn = _CN_ALL_RE.findall(key[1])
        cr = None
        # L1
        if en:
            cr = self.series_cr(en[-1])
        if not cr and cn:
            c = self.cr_by_cn.get(cn[-1].strip())
            cr = c if c in self.cr_by_prompt else None
            if not cr and _CR_ASCII_RE.search(cn[-1]):
                cr = self.series_cr(cn[-1])      # 中文名括号里写英文作品名（Code_Geass）
        # L2
        if not cr:
            for g in reversed(en[:-1]):
                if not self._cr_group_ok(g):
                    continue
                cr = self.series_cr(g)
                if cr:
                    break
        if not cr:
            for g in reversed(cn[:-1]):
                gs = str(g).strip()
                c = self.cr_by_cn.get(gs)
                if c in self.cr_by_prompt:
                    cr = c
                    break
                if _CR_ASCII_RE.search(gs):      # 同上：括号里是英文作品名
                    cr = self.series_cr(gs)
                    if cr:
                        break
        # L3 / L4 一律要求目标版权词热度 >= _CR_CN_MIN_PC。
        #   热度是「这个作品词靠不靠得住」的唯一代理：实测 L3 英文侧的低热度条目里混着
        #   SERIES_ARR 上游错配（fairilu→精灵宝钻、dark_world→黑暗世界、bunny→兔女郎），
        #   而 L1/L2 的括号本身写着作品名，可信，**不设门槛**（否则会误杀冷门真作）。
        if not cr:
            for g in reversed(en):
                if not self._cr_group_ok(g):
                    continue
                c2 = self.arr_key2cn.get(str(g).strip().replace(" ", "_").lower())
                if not c2:
                    continue
                c = self.cr_by_cn.get(c2)
                if c in self.cr_by_prompt and self._cr_pc(c) >= _CR_CN_MIN_PC:
                    cr = c
                    break
        if not cr:
            for g in reversed(cn):
                if str(g).strip() in _CR_CN_NONE:
                    continue
                k2 = self.arr_cn2key.get(str(g).strip())
                if not k2:
                    continue
                c = self.series_cr(k2)
                if c and self._cr_pc(c) >= _CR_CN_MIN_PC:
                    cr = c
                    break
        # L4
        if not cr:
            for g in reversed(cn):
                g = str(g).strip()
                if len(g) < 2 or g in _CR_CN_NONE:
                    continue
                c = self.cr_cn_norm.get(_CR_CN_NORM_RE.sub("", g).lower())
                if c:
                    cr = c
                    break
        # L5
        if not cr:
            cr = self.cr_by_char.get(key[0])       # danbooru posts 实证兜底（只兜底不覆盖）
        # L6 变体回退（2026-10-11）：X_(1st_costume) / X_(young) / X_(女) 这类**非作品**括号
        #    本身不指向任何作品 ⇒ 回退到本体 X 再解析一次（用本体自己的中文名）。
        #    ⛔ 只回退「非作品」括号（cr_none / _CR_SHAPE_RE / _CR_CN_NONE 命中才算），
        #      绝不砍 _(street_fighter) 这种真作品括号 —— 那会把角色认到别人家去。
        if not cr and "(" in key[0]:
            g = _EN_LAST_RE.search(key[0])
            if g:
                gv = g.group(1).strip()
                gk = gv.replace(" ", "_").lower()
                if gk in self.cr_none or _CR_SHAPE_RE.search(gk) or gv in _CR_CN_NONE:
                    base = _EN_LAST_RE.sub("", key[0]).rstrip("_")
                    bn = self.role_name.get(base)
                    if bn is not None:
                        cr = self.cr_resolve(base, bn)
        self._cr_resolve_cache[key] = cr
        return cr

    def reload_weights(self):
        """重新读 user_edits.json 的两种权重（面板改完立即生效，不用重启 ComfyUI）。

        · `weights`        → 抽取频率，乘在 `Pool.pick` 的权重上
        · `prompt_weights` → 提示词括号权重，`fmt_word` 输出 `(tag:1.5)` 用

        ⚠️ `weights`：只有 `Data` 单例持有，但**每个 Pool 都拿 db.weights 引用** ——
           这里整个字典换掉，Pool 侧 getattr(self.db, "weights") 拿到的是新对象，所以够用。
        ⚠️ `prompt_weights`：`fmt_word` 是模块级函数、拿不到 db，读的是**模块级 `_PROMPT_W`**,
           所以这里必须调 load_prompt_weights() 让它就地刷新（这个函数负责写 `_PROMPT_W`）。
        """
        self.weights = load_weights()
        self.prompt_weights = load_prompt_weights()
        return {"weights": self.weights, "prompt_weights": self.prompt_weights}

    def refresh_slots(self):
        """按「内置槽位表 + 用户自建/删除」重建 `slot_order` / `slot_groups`（幂等）。

        ⛔ 2026-10-06 修（阿君原话：「我创建新的槽位发现居然不会显示在面板上」）：
           以前这两张表**直接引用 `rules.json`**，用户新建的槽位后端完全不认 ——
             ① 面板槽位区渲染的就是 `/pc/meta` 的 slotGroups ⇒ **新建的槽位不显示**；
             ② 更严重：`Generator.gen` 的开关表是按 `db.slot_order` 遍历的 ⇒
                自定义槽**永远不参与抽取**（在弹窗里加了词也抽不出来）；
             ③ 删掉的槽位反过来 —— 界面看不见，后端却还在池子里。
           ⇒ 这里统一合并：删的去掉、新建的按它选的分组插进去；分组不存在就新建。
        ⚠️ 只此一份实现。`/pc/meta`、`/pc/user` 保存后都会重调一次（幂等，代价 = 42 项列表操作），
           所以用户在面板里新建槽位**不用重启 ComfyUI**。
        ⚠️ 重命名**不在这里处理**：`renamed` 的语义是「只改显示名、内部键名不变」
           （前端 `_renMap[s]` 负责显示），后端一律用内部名。
        """
        order = list(self.R["SLOT_ORDER"])
        groups = [{"name": g.get("name"), "slots": list(g.get("slots") or [])}
                  for g in self.R["SLOT_GROUPS"]]
        try:
            ed = load_slot_edits()
        except Exception:
            ed = {}
        if ed:
            # ① 用户删掉的槽位：顺序表 + 分组一起去掉
            deleted = set()
            for d in (ed.get("deleted") or []):
                nm = d.get("name") if isinstance(d, dict) else d
                if nm:
                    deleted.add(nm)
            if deleted:
                order = [s for s in order if s not in deleted]
                for g in groups:
                    g["slots"] = [s for s in g["slots"] if s not in deleted]
            # ② 用户新建的槽位：进顺序表 + 塞进指定分组
            for c in (ed.get("custom") or []):
                if not isinstance(c, dict):
                    continue
                nm = c.get("name")
                if not nm or nm in order:
                    continue
                order.append(nm)
                gp = c.get("group") or "自定义"
                g = next((x for x in groups if x["name"] == gp), None)
                if g is None:
                    g = {"name": gp, "slots": []}
                    groups.append(g)
                g["slots"].append(nm)
        self.slot_order = order
        self.slot_groups = [g for g in groups if g["slots"]]

    def word(self, i):
        w = self._words.get(i)
        if w is None:
            r = self.dict_rows[i]
            w = {"prompt": r[0], "name": r[1], "g": (r[2] or None), "s": (r[3] or ""),
                 "pc": r[4], "n": r[5], "category": r[6], "idx": i}
            self._words[i] = w
        return w



    # ⭐ 2026-10-21：角色 → 代表性特征。原先只挂在 Generator 上，
    #    后端 /pc/slots_of 要单独查它（总不能为了查特征去造一个 Generator）
    #    ⇒ 整段搬到 Data，Generator 那份改成转发。
    def _with_series(self, p, base):
        """角色级命中后**叠加系列级特征** + 部位去重（对齐网页 withSeries）。

        兽娘动物园系列级是 animal_ears + tail，而角色级可能已有 bear_ears/bear_tail，
        直接叠会变成同部位两个词。规则：
          · 系列级的词若与 base 里某个词**同部位** → 不追加
          · 但如果 base 里那个是**泛词**（animal_ears / tail / wings / horns / fang / ears）
            而系列级是**具体词**（horse_ears）→ **用具体词替换泛词**
        """
        R = self.R
        st = R.get("SERIES_TRAITS", {}).get(series_of(p)) if series_of(p) else None
        if not st:
            return list(base)
        ex = R.get("SERIES_TRAITS_EXCEPT", {}).get(series_of(p))
        if ex and any(p.startswith(x) for x in ex):
            return list(base)

        def part_of(w):
            if re.search(r"(^|_)ears?$", w) or w == "animal_ears":
                return "ears"
            if re.search(r"(^|_)tails?$", w) or w == "tail":
                return "tail"
            if re.search(r"(horns?|antlers?)$", w):
                return "horns"
            if re.search(r"(^|_)wings?$", w) or w == "wings":
                return "wings"
            if re.search(r"(fang|sharp_teeth)", w):
                return "fang"
            if re.search(r"(_girl|_boy)$", w):
                return "species"
            return "solo:" + w

        generic = {"animal_ears", "tail", "wings", "horns", "fang", "ears", "ear"}
        out = list(base)
        for w in st:
            if w in out:
                continue
            gp = part_of(w)
            bi = next((i for i, x in enumerate(out) if part_of(x) == gp), -1)
            if bi >= 0:
                if out[bi] in generic and w not in generic:
                    out[bi] = w        # 具体词替换泛词
                continue
            out.append(w)
        return out

    def traits_for(self, prompt):
        """角色 → 代表性特征。**完整对齐网页 traitsForCharacter**。

        ⚠️ 2026-09-29 补齐：原先只有「精确命中 / base+系列 / 系列级」三层，
           漏了 4 处，实测节点人物特征产出率 16.6% vs 网页 42.4%（差 25.8%）：
             · 1b  去掉尾部 _(作品) 再试
             · 1c  变体/异格：base 剥离 _the_ 后缀（且系列必须一致）
             · 2   SERIES_TRAITS_EXCEPT 排除（如 umamusume 的 trainer / blue_archive 的 sensei）
             · 3   ANIMAL_SERIES 系列按角色名的**物种词根**匹配（39 项，影响最大）
        """
        R = self.R
        p = str(prompt or "").lower().strip()
        if not p:
            return None

        # 1) 角色级：精确命中
        if p in R["CHAR_TRAITS"]:
            return self._with_series(p, R["CHAR_TRAITS"][p])

        # 1b) 去掉尾部 _(作品) 再试
        no_ser = re.sub(r"\([^)]*\)\s*$", "", p)
        no_ser = re.sub(r"_$", "", no_ser)
        if no_ser and no_ser in R["CHAR_TRAITS"]:
            return self._with_series(p, R["CHAR_TRAITS"][no_ser])

        # 2) 先取系列（下面变体兜底和系列级都要用）
        sm = re.search(r"\(([^)]*)\)\s*$", p)
        series = sm.group(1) if sm else ""
        p_ser = ("(" + series + ")") if series else ""

        # 1c) 变体/异格：base_the_xxx_(series) → 取 base 查，但**系列必须一致**
        #     否则 orange_(among_us) 会命中另一个作品里叫 orange 的兽娘
        base = re.sub(r"_$", "", no_ser.split("_the_")[0])
        if base and p_ser:
            slot = self.char_traits_base.get(base)
            if slot and p_ser in slot["sers"]:
                return list(slot["traits"])

        if not series:
            return None
        ex = R.get("SERIES_TRAITS_EXCEPT", {}).get(series)
        if ex and any(p.startswith(x) for x in ex):
            return None

        # 3) 系列内按角色名的物种词根（沙丘猫→猫耳猫尾、银狐→狐耳狐尾…）
        if series in R.get("ANIMAL_SERIES", []):
            bm = re.match(r"^(.*)_\(", p)
            name = bm.group(1) if bm else p
            for rex, traits in self.animal_root_re:
                if rex.search(name):
                    return self._with_series(p, list(traits))

        # 4) 系列级兜底
        st = R.get("SERIES_TRAITS", {}).get(series)
        return list(st) if st else None
# ===== 池构建 =====

HAND_PART_RULES = [
    ("g_hp_face", ["face", "cheek", "chin"]),
    ("g_hp_mouth", ["mouth", "lips"]),
    ("g_hp_eye", ["own_eye", "over_eye", "one_eye", "shading_eye"]),
    ("g_hp_hair", ["hair"]),
    ("g_hp_chest", ["chest"]),
    ("g_hp_hip", ["_hip"]),
    ("g_hp_head", ["own_head", "to_head"]),
    ("g_hp_neck", ["neck"]),
    ("g_hp_stomach", ["stomach"]),
    ("g_hp_ass", ["_ass"]),
    ("g_hp_knee", ["_knee", "_lap"]),
    ("g_hp_shoulder", ["shoulder"]),
    ("g_hp_ear", ["own_ear", "_ears"]),
    ("g_hp_forehead", ["forehead"]),
]
KEEP_G = {"g_arm_up", "g_arm_pocket", "g_arm_back", "g_arm_head",
          "g_arm_side", "g_arm_crossed", "g_armpose"}
# ⚠️ 2026-09-30 修：「基础姿势」槽的 blanket 覆盖（下面 _apply_group_rules 里）
#    会把**所有**词打成 g_basepose，连词典里本来标了 g_pose_dynamic 的
#    「双腿交叉 / 脚踝交叉」也被洗掉 ⇒ 于是
#    「crossed_legs（基础姿势）+ jumping/skipping（动作）」——"跳跃却双腿交叉"——能同框
#    （5004 组里中 2 组，只在「自由搭配」同时开这两个槽时出现）。
#    ⇒ 这三个「交叉腿」词保留 g_pose_dynamic，跟「动作」槽的走/跑/跳/飞/爬行互斥。
#    与网页 CROSS_LEGS_POSE 保持一致。
CROSS_LEGS_POSE = {"crossed_legs", "crossed_ankles", "crossed legs while standing"}


class Pool:
    """原始池 slotPool[s] = SLOT_IDX + SLOT_PACK + 互斥组覆盖规则；
       可用池 slotList(s) = 原始池经完整过滤链。"""

    def __init__(self, db, gender="f", nsfw_filter=True, black=frozenset(), series="",
                 slot_edits=None, nsfw_only=False):
        self.db = db
        self.gender = gender
        self.nsfw_filter = nsfw_filter
        # 2026-11-25：只出 NSFW（与 nsfw_filter 互斥，优先级更高）。
        #   只在「有 NSFW 词」的槽生效，见 _pass 里的注释。
        self.nsfw_only = bool(nsfw_only)
        self._nsfw_slot_cache = {}
        self._nsfw_probe = False        # 探测「该槽有没有可用 NSFW 词」期间置 True，避免自递归
        self.black = set(black)
        self.series = str(series or "").strip()      # 系列筛选（只作用于「角色」槽）
        # ⚠️ slot_edits=None → **自动读盘**（用户对槽池的增删）。
        #    刻意不强制调用方传：少一个调用点忘了传，就又变成"剔除不生效"（2026-10-05 的 bug 就是这来的）。
        self.slot_edits = load_slot_edits() if slot_edits is None else \
            (slot_edits if isinstance(slot_edits, dict) else {})
        self._ser_done = False
        self._ser_allow = None
        self._ser_info = None
        self._raw = {}
        self._out = {}

    def series_allow(self):
        """(allow|None, info)。allow=None 表示不筛选（空输入或没命中）。"""
        if not self._ser_done:
            self._ser_allow, self._ser_info = series_resolve(self.db, self.series)
            self._ser_done = True
        return self._ser_allow, self._ser_info

    def raw_pool(self, slot):
        if slot in self._raw:
            return self._raw[slot]
        db = self.db
        words = []
        seen = set()
        for i in db.slot_idx.get(slot, []):
            w = dict(db.word(i))
            if w["prompt"] in seen:
                continue
            seen.add(w["prompt"])
            words.append(w)
        for p in db.slot_pack.get(slot, []):
            # ⚠️ PACK 词必须**原样保留字段**，不能补全 ——
            # 网页的 pcOK 是 `!b.category || b.pc >= MIN_PC`，缺 category 直接放行、
            # 有 category 却没 pc 的会被挡掉（leg warmers / garter straps）；
            # n=1 的要被 NSFW 挡（large breasts / cleavage）、s="m" 的被子性别挡（mountain）。
            if isinstance(p, str):
                obj = {"name": p, "prompt": p, "g": None, "s": "", "pc": None, "n": None, "category": None}
            else:
                obj = {
                    "name": p.get("name") or p.get("prompt") or "",
                    "prompt": p.get("prompt") or p.get("name") or "",
                    "g": p.get("g") or None,
                    "s": p.get("s") or "",
                    "pc": p.get("pc"),
                    "n": p.get("n"),
                    "category": p.get("category"),
                }
            pr = obj["prompt"]
            if not pr or pr in seen:
                continue
            seen.add(pr)
            obj["idx"] = -1
            obj["pack"] = True
            words.append(obj)
        self._apply_group_rules(slot, words)
        self._raw[slot] = words
        return words

    def _apply_group_rules(self, slot, words):
        for w in words:
            p = w["prompt"]
            n = p.replace(" ", "_").lower()
            if slot == "鞋子":
                if not w["g"]:
                    w["g"] = "g_footwear"
            elif slot == "袜子":
                if not w["g"]:
                    w["g"] = "g_hosiery"
            elif slot in ("下装", "连衣裙与制服"):
                w["g"] = "g_lowerall"
            elif slot == "泳装与贴身衣物":
                if re.search(r"swimsuit|bikini", p):
                    w["g"] = "g_lowerall"
            elif slot == "袖型与领口":
                if "sleeve" in p:
                    w["g"] = "g_sleeve"
            elif slot == "基础姿势":
                w["g"] = "g_pose_dynamic" if p in CROSS_LEGS_POSE else "g_basepose"
            elif slot in ("角色", "画师"):
                w["g"] = None
            elif slot == "动作":
                if not w["g"]:
                    w["g"] = "g_action"
            elif slot == "手臂与手势":   # 2026-10-14：手部动作已并入本槽
                if w["g"] and w["g"] in KEEP_G:
                    continue
                hit = None
                for g, kws in HAND_PART_RULES:
                    if any(k in n for k in kws):
                        hit = g
                        break
                if hit:
                    w["g"] = hit
            elif slot == "相机方位":
                w["g"] = "g_camdir"
            elif slot == "镜头":
                w["g"] = "g_lens"
            elif slot == "景别":
                if not w["g"]:
                    w["g"] = "g_shottype"
            elif slot == "构图":
                if not w["g"]:
                    w["g"] = "g_composition"
            elif slot == "眼睛":
                w["g"] = "g_eyecolor"
            elif slot in ("场景", "植物", "道具"):
                if w["g"] == "g_hair_color":
                    w["g"] = None
            elif slot == "视线与朝向":
                w["g"] = "g_gaze"
            elif slot == "人物朝向":
                if not w["g"]:
                    w["g"] = "g_orient"

    def slot_list(self, slot):
        if slot in self._out:
            return self._out[slot]
        out = [w for w in self.raw_pool(slot) if self._pass(slot, w)]
        # ⛔ 2026-10-18 阿君：某些系列**永远不收录**（我的英雄学院）。
        #    这里作为最后一道闸 —— 就算以后加词脚本出错把它塞进词库，也抽不到。
        if slot == "角色":
            _block = set(self.db.R.get("BLOCK_SERIES") or [])
            _blockch = set(x.lower().replace(" ", "_") for x in (self.db.R.get("BLOCK_CHARS") or []))
            if _block or _blockch:
                _crmap = self.db.cr_of_char()
                out = [w for w in out
                       if _crmap.get(str(w["prompt"]).replace(" ", "_")) not in _block
                       and str(w["prompt"]).replace(" ", "_").lower() not in _blockch]
        # 系列筛选：只收窄「角色」槽（其余槽没有作品归属的概念）
        if slot == "角色" and self.series:
            allow, _ = self.series_allow()
            if allow is not None:
                out = [w for w in out if w["prompt"] in allow]
        # ⭐ 2026-10-05：最后应用用户对槽池的增删（对齐网页 slotList：先自动过滤、再用户改动）
        #    ⛔ 这一行是「剔除/添加不生效」的修复点 —— 少了它，用户在结果区右键剔除的词
        #       保存成功、槽位预览里也没了，但抽词时照样出。
        out = apply_slot_edits(self.db, slot, out, self.slot_edits)
        # ⚠️ 2026-10-18：apply_slot_edits 加进来的用户词**绕过了过滤链**，
        #   性别模式（尤其「非人」）必须再过一遍，否则非人池里会混进正经角色。
        if slot == "角色":
            if self.gender == "n":
                out = [w for w in out if _is_nonperson_char(w["prompt"])
                       or _is_species_char(w.get("name"))]
                # 再补上词典里有、但槽索引里被剔掉的非人角色（动物/兽人/机甲…）
                _have = {str(w["prompt"]) for w in out}
                out = out + [w for w in self.nonperson_extra()
                             if str(w["prompt"]) not in _have]
            else:
                # ⚠️ 2026-10-19（阿君报「奇怪龙在人类女性池里」）：光靠 `_is_nonperson_char`
                #   不够 —— 它只认名字形状（titan/dragon/slime…），`khezu`（奇怪龙）、
                #   `rathian`（雌火龙）这种**只有长得像人名**的怪物全部漏网。
                #   补一条「物种向 IP + 中文名带物种字」的判据（见 `_is_species_char`）。
                out = [w for w in out if not _is_nonperson_char(w["prompt"])
                       and not _is_species_char(w.get("name"))]
        self._out[slot] = out
        return out

    def nonperson_extra(self):
        """非人模式下额外补进来的角色（词典里有、但槽索引里被剔掉的那批）。

        · `_is_nonperson_char` 命中的（吉祥物/史莱姆/巨人…）
        · 生物/机甲类 IP 下**单词名**的角色（pikachu / agumon / gundam）
        结果缓存在实例上，只算一次。
        """
        if getattr(self, "_npe_cache", None) is not None:
            return self._npe_cache
        # ⛔ 不能在这里调 slot_list("角色") —— 那个函数在非人模式下又会调本函数，死递归。
        #    用 raw_pool 去重就够了（extras 本来就是"槽索引里没有的那批"）。
        if getattr(self, "_npe_busy", False):
            return []
        self._npe_busy = True
        # 只在本函数内部去重；与主池的重叠由 slot_list 用 _have 再滤一次。
        # （不能拿 raw_pool 去重 —— 那里面的词可能正是被 n 模式排除掉的）
        seen = set()
        cr = self.db.cr_of_char()
        out = []
        for i, row in enumerate(self.db.dict_rows):
            if str(row[6]) != "角色":
                continue
            nm = str(row[0])
            key = nm.replace(" ", "_").lower()
            if key in seen:
                continue
            ok = _is_nonperson_char(nm) or _is_species_char(row[1])
            if not ok and "_" not in key and key not in _NONHUMAN_IP_EXCEPT:
                c = _ip_key(cr.get(key))
                if c in _NONHUMAN_IP:
                    ok = True
                else:
                    cn = str(row[1])
                    if any(m in cn for m in _NONHUMAN_NAME_MARK):
                        ok = True
            if not ok:
                continue
            w = self.db.word(i)
            # ⛔ 不能用 self._pass()：它内部对「非人」模式只放行 _is_nonperson_char 的词，
            #    这里要补的恰恰是**不被那个函数认出来**的物种/机体。只做最小检查。
            try:
                if w["prompt"] in self.black:
                    continue
                if self.nsfw_filter and w["n"] == 1:
                    continue
                if w["category"] == "元数据":
                    continue
                if w["category"] and (w["pc"] or 0) < self.db.R.get("MIN_PC", 50):
                    continue
            except Exception:
                continue
            out.append(w)
            seen.add(key)
        self._npe_busy = False
        self._npe_cache = out
        return out

    def _wmult(self, w):
        """用户给单个标签设的**权重倍数**（1.0 = 默认，没设就是 1.0）。

        ⚠️ 键归一成「下划线 + 小写」查（词典里 prompt 有带空格的写法，如 `full body`）。
        ⚠️ 空字典直接返回 1.0 —— 不设权重的用户零额外开销（每次 pick 每个候选都会调一次）。
        """
        W = getattr(self.db, "weights", None)
        if not W:
            return 1.0
        return W.get(str(w.get("prompt") or "").replace(" ", "_").lower(), 1.0)

    def _wpick(self, cands, ws, rng):
        """按权重表轮盘抽一个（权重和 <=0 时退回均匀）。"""
        tot = sum(ws)
        if tot <= 0:
            return rng.choice(cands)
        r = rng.random() * tot
        acc = 0.0
        for w, ww in zip(cands, ws):
            acc += ww
            if r <= acc:
                return w
        return cands[-1]

    def pick(self, cands, rng=None, slot=None):
        """按**热度加权**抽一个（阿君 2026-10-18：极冷门标签也能抽到，不合理）。

        权重 = (pc + 1) ** PC_ALPHA，alpha 越小越接近均匀。
        · alpha=0   → 完全均匀（老行为）
        · alpha=0.5 → 1000 帖的词约为 100 帖的 3 倍机会（默认）
        · alpha=1   → 严格按帖子数
        pc 缺失/为 0 的按 1 算，保证冷门词仍有机会（不会把槽抽空）。

        ⭐ 2026-10-18：传 `slot="景别"` 时**改用手写权重表**（SHOT_WEIGHTS），
           不走 pc —— 景别槽 12/17 个词没有 pc，中位数兜底会让宽景变体各占 6%。
        ⭐ 2026-10-19：再乘上**用户给单个标签设的倍数**（`self.db.weights`），
           三个分支都乘，否则"设了权重不生效"（就像 10-18 那个空格的 bug）。
        """
        if not cands:
            return None
        rng = rng or getattr(self, "rng", None) or __import__("random")
        # ===== 景别专用权重（见 Data.__init__ 的 SHOT_WEIGHTS 注释）=====
        if slot == "景别" and self.db.shot_weight:
            # ⭐ 2026-10-19：再乘上「族倍率」`_shot_bias`（由 Generator._tier_filter 按
            #   「有没有抽到下装/袜子/鞋子」算出）。没有它 → 全身只占 13.8%，
            #   人物被切在膝盖以上（阿君 5 张图的直接原因）。
            bias = getattr(self, "_shot_bias", None)
            def _bw(w):
                k = str(w.get("prompt") or "").replace(" ", "_").lower()
                vw = self.db.shot_weight.get(k, self.db.shot_weight_default)
                if bias:
                    f = _shot_family(k)
                    if f:
                        vw *= bias.get(f, 1.0)
                return vw * self._wmult(w)
            ws = [_bw(w) for w in cands]
            if sum(ws) > 0:
                return self._wpick(cands, ws, rng)
        alpha = float(self.db.R.get("PC_ALPHA", 0.5))
        if alpha <= 0:
            # 纯均匀模式：仍尊重用户权重（否则设了权重等于白设）
            if getattr(self.db, "weights", None):
                return self._wpick(cands, [self._wmult(w) for w in cands], rng)
            return rng.choice(cands)
        # ⚠️ 2026-10-18 阿君问「pc=0 是不是冷门」：不是 —— 是**没记热度**
        #   （人工整理词包里的词，如景别 extreme close-up / medium shot 全是 0）。
        #   直接按 1 算会把它们权重压到 0.03%，等于禁掉 ⇒ 用「本槽已知 pc 的中位数」代替。
        _known = [float(w.get("pc")) for w in cands if (w.get("pc") or 0) > 0]
        _fallback = 1.0
        if _known:
            _known.sort()
            _fallback = _known[len(_known) // 2]
        ws = [(float(w.get("pc")) if (w.get("pc") or 0) > 0 else _fallback) ** alpha * self._wmult(w)
              for w in cands]
        return self._wpick(cands, ws, rng)

    def _slot_has_nsfw(self, slot):
        """该槽在**真实可用池**里有没有 NSFW 词（n==1）。结果按槽缓存。

        「只出 NSFW」开关靠它决定这个槽要不要收紧：
          有可用 NSFW 词 → 只放行 NSFW；没有 → 保持原样，避免整槽抽空。

        ⛔ 不能用 raw_pool 判断（第一版就错在这）：raw_pool 里 `表情` 有 8 个 NSFW 词
           （cum_in_mouth / blood_from_mouth…），但它们早被 MIN_PC / BODY_MOD_RE /
           slot_edits 等规则剔光，可用池实际是 0 ⇒ 判成 True 后把整槽滤空，
           出图直接没有表情（实测「只出NSFW」模式下 表情=0 条）。
           所以这里必须跑一遍 _pass 才算数。

        ⛔ 也不能直接调 slot_list()：它会写 self._out 缓存，把「过滤前的池」缓存下来，
           之后正式取池就全错了。这里手动遍历 + _pass，不碰缓存。

        探测期间 _nsfw_probe=True → _pass 跳过 nsfw_only 自身；
        同时临时把 nsfw_filter 置 False，探测的是「不过滤时有没有 NSFW 词」。
        """
        if slot in self._nsfw_slot_cache:
            return self._nsfw_slot_cache[slot]
        self._nsfw_slot_cache[slot] = False      # 占位，防重入
        ok = False
        _old_filter = self.nsfw_filter
        try:
            self._nsfw_probe = True
            self.nsfw_filter = False
            for w in (self.raw_pool(slot) or []):
                if (w.get("n") or 0) == 1 and self._pass(slot, w):
                    ok = True
                    break
        except Exception:
            ok = False
        finally:
            self.nsfw_filter = _old_filter
            self._nsfw_probe = False
        self._nsfw_slot_cache[slot] = ok
        return ok

    def _pass(self, slot, w):
        R = self.db.R
        p = w["prompt"]
        n = p.replace(" ", "_").lower()
        if p in self.black:
            return False
        # ⛔ 2026-10-17（阿君报「怎么无垢巨人都来了」）：角色槽剔掉**非人类 / 群体**标签。
        #   数据里 `titan_(generic)_(shingeki_no_kyojin)` 被标成 s='f'（女池 100% 都是 f，
        #   性别筛选救不了），所以只能按命名规则判：**只认本体名**，剥掉结尾的 (系列) 括号，
        #   否则 `ymir_(shingeki_no_kyojin)`（真人类）会被系列名误伤。
        # 2026-10-18：非人角色**独立成池**（gender == "n"），其余模式照旧排除
        if slot == "角色":
            _np = _is_nonperson_char(p)
            if self.gender == "n":
                if not _np:
                    return False
            elif _np:
                return False
        if self.nsfw_only and not self._nsfw_probe and self._slot_has_nsfw(slot):
            # 2026-11-25：「只出 NSFW」开关。
            #   只在**本身含 NSFW 词**的槽生效 —— 实测 42 个槽里 26 个完全没有 NSFW 词
            #   （发型/发色/表情/光照/景别/构图…），一刀切会让这些槽直接空掉，
            #   出图变成没头发没表情的怪物。有 NSFW 词的槽（泳装 93%、双人互动 8.9%、
            #   上装/下装 3.7%…）才收紧到只要 NSFW。
            if (w.get("n") or 0) != 1:
                return False
        elif self.nsfw_filter and w["n"] == 1:
            if slot == R.get("SWIM_NSFW_SLOT"):
                if p in R["SWIM_NSFW_BLOCK"]:
                    return False
            else:
                return False
        # 「结构性暴露」服装词等同 NSFW（见 SHEER_RE 注释）
        # nsfw_only 打开时这条要跳过 —— 用户就是要暴露款，别再按 NSFW 剔掉
        if self.nsfw_filter and not self.nsfw_only and slot in SHEER_NSFW_SLOTS and SHEER_RE.search(n):
            return False
        if not self._gender_ok(w):
            return False
        if w["category"] and (w["pc"] or 0) < R.get("MIN_PC", 50):
            return False
        if w["category"] == "元数据":
            return False
        no_bad = slot in R.get("NO_BADTAG_SLOTS", set())
        if not no_bad and R["BODY_MOD_RE"].search(n):
            return False
        if p in R.get("META_JUNK_SET", set()):
            return False
        if p in R.get("NEUTRAL_GENERAL_SET", set()):
            return False
        exempt = R.get("SLOT_EXEMPT", {}).get(slot)
        if not (exempt and p in exempt):
            if not no_bad and any(k in n for k in R.get("BAD_TAG_KW", [])):
                return False
        if any(k in n for k in R.get("SLOT_BAN_KW", {}).get(slot, [])):
            return False
        if slot == "表情" and p not in R.get("EMO_WHITELIST", set()):
            return False
        return True

    def _gender_ok(self, w):
        R = self.db.R
        g = self.gender
        if g in ("all", "n"):
            # 「非人」模式不分男女：池子已在 _pass 里按「非人」筛过
            return True
        if w["category"] in ("画师", "版权", "元数据"):
            return True
        # ⚠️ COUNT_SET 里没性别标记的词一律挡掉 —— 本意是防止 1boy / 2boys 漏进女池。
        #   2026-10-17：`solo` 是**无性别**的（男图女图都该有），被这条误伤了，
        #   实测「人数」槽池里从来没有 solo，用户手动开人数槽也抽不到它。这里放行。
        if (w["prompt"] in R.get("COUNT_SET", []) and not w["s"]
                and w["prompt"] not in ("solo",)):
            return False
        if g == "f":
            n = w["prompt"].replace(" ", "_").lower()
            if n in R.get("MALE_BALD_EXACT", set()):
                return False
            # ⭐ 2026-10-07：男性角色黑名单 —— 这 47 条在词库里被标成 s="f"（数据错误），
            #    于是「只看女性」会抽到男性角色（用户报 umio_(neptunia) 海男）。
            #    精确匹配、只在女性模式拦截，「全部 / 只看男性」不受影响。
            if n in R.get("MALE_ROLE_EXACT", set()):
                return False
            if any(k in n for k in R.get("MALE_FEATURE_KW", [])):
                return False
        if w["s"] == g:
            return True
        if not w["s"]:
            # ⚠️ 没标性别的「角色」词要排除，否则男性角色会混进女性模式
            return w["category"] != "角色"
        return False


# ===== 互斥常量（照抄网页 genLogic 内的定义）=====

DOF_DEEP = {"deep_depth_of_field", "background_in_focus", "narrow_aperture", "f/8"}
DOF_SHALLOW = {"shallow_depth_of_field", "bokeh", "background_blur", "foreground_blur",
               "sharp_subject,_blurred_background", "selective_focus", "wide_aperture",
               "f/1.4", "f/1.8", "f/2.8"}

SHOT_CLOSE = ["close-up", "closeup", "extreme_close-up", "headshot", "bust", "bust_shot", "portrait",
              "head_and_shoulders", "medium_close-up", "medium_closeup", "upper_body", "face_focus"]
# ⚠️ 2026-09-30 修：半身景别（medium / thigh-up / waist-up / cowboy / knee-up / detail）
# 原来不属于任何景别组，被当成「中性景别」混进「全身立绘」档 → 用户实测
# N_全身立绘_01=waist-up shot、N_全身立绘_12=medium shot、N_极简日常_01/06/10 只出半身
# ⇒ 单独立组，只在 fullbody 档剔除（不动 auto/closeup/wide 的既有行为）。
SHOT_HALF = ["medium_shot", "medium-shot", "thigh-up_shot", "thigh-up", "waist-up_shot", "waist-up",
             "cowboy_shot", "cowboy-shot", "knee-up_shot", "knee-up", "detail_shot"]
# 2026-09-30：超远景词 —— 人物被缩到几乎不可辨认，auto 档禁用
# （用户实证 W_极简日常_14 = establishing shot → 画面只剩两条腿）
SHOT_ULTRA_WIDE = ["establishing_shot", "long_shot", "extreme_wide_shot", "absurdly_wide_shot",
                   "medium_wide_shot", "panoramic", "panorama", "360_panorama"]

# ⚠️ 2026-09-30：「结构性暴露」的服装词（frontless / sideless / bottomless / crotchless / topless）
# 在 danbooru 里就是"衣服缺一块"，画出来必然漏点。用户实证：
#   N_场景大图_05 / N_场景大图_07 = frontless outfit、N_自由搭配_10 = sideless outfit
# ⇒ 等同 NSFW：NSFW 过滤开着（默认）时这些服装槽不抽它们；开了 NSFW 才可选。
# ⚠️ 不动「泳装与贴身衣物」槽 —— 那个槽有自己的 SWIM_NSFW_* 放行逻辑。
SHEER_NSFW_SLOTS = {"上装", "下装", "连衣裙与制服", "装饰与材质", "袖型与领口"}
SHEER_RE = re.compile(r"frontless|sideless|bottomless|crotchless|\btopless\b")
# 车厢/车内场景：脚下没有可站稳的平面，"踮脚"画出来必然别扭（N_插画美图_10 实证）
VEHICLE_INTERIOR = ("vehicle_interior", "train_interior")
SHOT_FULL = ["full_body", "standing_full_body", "full-length", "whole_body", "full_shot", "standing_full"]
SHOT_WIDE = ["wide_shot", "wide-angle_shot", "establishing_shot", "long_shot", "extreme_wide_shot",
             "panoramic", "landscape", "group_shot", "panorama", "360_panorama", "absurdly_wide_shot"]
SHOT_ACTION = ["dutch_angle", "action_shot", "motion_blur", "panning_camera", "zooming_in",
               "zooming_out", "dynamic_angle", "tracking_shot", "candid"]


def _shot_family(t):
    """把一个景别词归到 ultra / full / wide / half / close 五族之一（认不出返回 None）。

    ⚠️ 判定顺序不能动：`long_shot` 同时在 SHOT_WIDE 和 SHOT_ULTRA_WIDE 里，
       `medium_wide_shot` 里也含 `wide_shot` —— 必须先判 ultra，否则会被误判成普通 wide。
    """
    for name, words in (("ultra", SHOT_ULTRA_WIDE), ("full", SHOT_FULL),
                        ("wide", SHOT_WIDE), ("half", SHOT_HALF), ("close", SHOT_CLOSE)):
        if any(w in t for w in words):
            return name
    return None

TILT_UP = ["from_above", "top_view", "top-down_view", "aerial_view", "aerial", "bird's-eye_view",
           "bird's-eye", "overhead_view", "overhead", "high_angle", "top-down"]
TILT_DOWN = ["from_below", "bottom_view", "low_angle", "worm's-eye_view", "worm's-eye",
             "ground-level_shot", "under_shot"]
WIDE_HARD = ["panorama", "360_panorama", "wide_angle", "wide-angle_shot", "absurdly_wide_shot",
             "fisheye", "wide-angle", "aerial_view", "establishing_shot", "long_shot",
             "extreme_wide_shot", "panoramic", "landscape"]

CROPS = ["cropped_composition"]          # 2026-09-22 用户拍板后只剩这 1 个
CLOSE_SHOTS = ["close-up", "closeup", "extreme_close-up", "headshot", "bust", "bust_shot",
               "portrait", "head_and_shoulders", "medium_close-up", "medium_closeup",
               "detail_shot", "tight_close-up"]
TILT_VIEWS = ["from_above", "top_view", "top-down_view", "aerial_view", "aerial", "bird's-eye_view",
              "bird's-eye", "overhead_view", "overhead", "overhead_shot", "high_angle",
              "drone_view", "drone", "from_below", "bottom_view", "low_angle",
              "worm's-eye_view", "worm's-eye"]

CLOSE_FRAME_RE = re.compile(r"close-?up|bust_shot|upper_body|detail_shot|waist-up_shot|_face_focus")
WIDE_FRAME_RE = re.compile(r"wide_shot|long_shot|extreme_wide|establishing_shot|very_wide|panoramic|full_body|full_figure|medium_wide")
BIG_SHOT_RE = re.compile(r"^(full_body|full_body_shot|full_figure)$|wide_shot|long_shot|extreme_wide|establishing_shot|medium_wide")
KNEELIKE_RE = re.compile(r"^(sitting|sitting_on_chair|sitting_on_floor|sitting_on_edge|sitting_on_stairs|"
                         r"sitting_on_table|sitting_on_object|sitting_backwards|sitting_sideways|seiza|kneeling|"
                         r"on_one_knee|crouching|squatting|cross-legged|butterfly_sitting|figure_four_sitting|"
                         r"crossed_legs|hugging_own_legs|knees_up|reclining|lying|on_back|on_side|on_stomach|"
                         r"knees_together|knees_together_feet_apart)$")
LYING_RE = re.compile(r"^(lying|on_back|on_side|on_stomach|reclining)$")
OFF_GROUND_RE = re.compile(r"^(arm_up|arms_up|arm_above_head|arm_over_head|holding_above_head|arm_on_own_head|"
                           r"arm_behind_head|arms_behind_head|arm_at_side|arms_at_sides|hands_in_pockets|"
                           r"arm_across_chest|arm_across_waist|arms_across_body|holding_own_hair|arms?_on_knees?|"
                           r"arms?_on_table|praying|hands_clasped|holding_behind_back|holding_own_wrist|"
                           r"arm_out_of_sleeve|holding_own_foot)$")
LONG_PANTS_RE = re.compile(r"^(?!.*(shorts|bloomer|skirt)).*(pants|jeans|trousers|slacks|leggings|jeggings|sweatpants|chaps)$")
POSE_HANDS_FULL_RE = re.compile(r"^(hugging_own_legs|hugging_doll|hugging_book)$")
OUTDOOR_RE = re.compile(r"^(busy_street|street|empty_street|city|cityscape|skyline|park|beach|shore|forest|"
                        r"bamboo_forest|field|grassland|mountain|hill|desert|island|river|lake|ocean|rooftop|road|"
                        r"path|dirt_road|alley|garden|flower_field|sunflower_field|playground|outdoors|cliff|"
                        r"waterfall|ruins|graveyard|volcano|snowy_mountain|tree_shade|pier|bridge|market_stall|"
                        r"courtyard|balcony|veranda|porch|night_sky|starry_sky|milky_way|sea|puddle|pond|shallow_water)$")
SUNNY = ["golden_hour", "sunlight", "sunrise_lighting", "dappled_sunlight", "sunlight_rays", "day", "morning"]
NIGHT_RE = re.compile(r"^(night|night_sky|starry_sky|starry_sky_background|milky_way|moon|galaxy)$")
FLAT_LIGHT_RE = re.compile(r"^(front_lighting|bright_lighting|studio_lighting|high-key_lighting|even_lighting|"
                           r"natural_lighting|soft_diffused_light|sunlight|dappled_sunlight|hard_light)$")

FACIAL_FX = ["autofacial", "simulated_facial"]
LOW_POSE = ["sitting", "kneeling", "seiza", "squatting", "lying", "on_back", "on_stomach", "on_side",
            "reclining", "lounging", "butterfly_sitting", "figure_four_sitting", "crossed_legs",
            "cross-legged", "knees_up", "knee_up", "on_one_knee", "prone_bone", "crouching", "crawl", "all_fours"]
POSE_AREA = {"基础姿势", "动作", "手臂与手势", "身体与头部协调", "双人互动", "人物朝向"}
LEG_KNEEL = ["on_one_knee", "crossed_legs", "cross-legged", "kneeling", "seiza", "figure_four_sitting", "butterfly_sitting"]
STAND_POSE = ["standing", "tiptoes", "contrapposto", "walking", "running", "jumping", "leaning",
              "fighting_stance", "dancing"]
# 2026-10-16（阿君截图：sitting_on_table × hands_on_floor）：人在**离地状态** —— 手不可能撑到地上。
#   实测立绘档 5000 组：姿势×手撑地（ground/floor）共 140 次（2.80%），其中硬矛盾 11 次（0.22%）。
#   ⚠️ 只收「人不在最低平面」的姿势；sitting / sitting_on_floor / kneeling / squatting /
#      on_back / lying / crouching 这些本来就在地上，手撑地完全合理，**绝不能收**。
OFF_GROUND_POSE = {
    "floating", "falling",                                     # 浮空 / 下落：根本没有地面接触
    "sitting_on_table", "leaning_on_table",                    # 桌：手在桌上
    "sitting_on_chair", "sitting_on_stairs",                   # 椅面 / 台阶：手够不到地
    "sitting_on_object", "sitting_on_edge",                    # 物体上 / 边缘
    "sitting_backwards", "sitting_sideways",                   # 通常指背坐 / 侧坐在椅凳上
    "leaning_on_object",
}
# 手撑地 / 手扶地 —— 池里 ground / floor 两种写法 × hand_/hands_ 各一，共 4 个
FLOOR_HANDS = {"hand_on_ground", "hands_on_ground", "hand_on_floor", "hands_on_floor"}

# 2026-10-17：档位改名兼容表（旧名 → 现名）。
#   ⚠️ 只在 gen() 里映射**不够**：ComfyUI 在进 Python 之前，会拿 INPUT_TYPES 的
#      选项列表校验 combo 值；旧名不在表里 → 直接报
#      「preset 输入值 全身立绘 不可用」（阿君 2026-10-17 截图），走不到映射逻辑。
#   ⇒ nodes._preset_names() 会把旧名一起列进选项表（面板隐藏了原生 combo，用户看不到）。
#   ⇒ 面板初始化时也把 widget 值改写成现名，否则档位 chip 一个都不亮。
PRESET_ALIASES = {
    # 2026-10-14：档位更名「全身立绘」→「立绘」
    "全身立绘": "立绘",
    # 2026-10-17：档位从 5 个重构成 3 类（+自由搭配）。老名字全部映射到最接近的新档，
    #   保证老工作流照常出图（否则 ComfyUI 会报「preset 输入值不可用」）。
    #   依据：原来五个档位是**嵌套包含**关系（极简日常 ⊂ 场景大图；立绘 ⊂ 插画美图 ⊂ 物件随搭），
    #   所以怎么调都像「同一个东西少几个槽」。新分类按「画面里有什么」：
    #     立绘 = 只有人物（无场景） / 插画 = 人物+环境 / 空景 = 只有环境（无人物）
    "极简日常": "极简",
    "插画美图": "插画",
    "物件随搭": "插画",
    "场景大图": "插画",
    # 「空景」只短暂存在过（当天就被阿君否掉：这工具是做人物的，不做纯场景）——
    #   万一有人刚好存了带它的工作流，映射到「插画」，不至于掉到默认档。
    "空景": "插画",
}


def canon_preset(name):
    """旧档名 → 现档名；不是旧名就原样返回。"""
    return PRESET_ALIASES.get(name, name)
FOOTWEAR_RE = re.compile(r"shoe|boot|sneaker|sandal|heel|slipper|loafer|clogs|geta|zori|flip.?flop|sock|tights|"
                         r"stockings|pantyhose|legwear|thighhigh|kneehigh|footwear|stiletto|pump|oxford|derby|"
                         r"moccasin|espadrille|tabi")
PLACE_RE = re.compile(r"(?:_field|_room|_house|_station|_park|_building|_school|_store|_shop|_hall|_stage|_arena|"
                      r"_stadium|_court|_track|_platform|_dock|_harbor|_village|_town|_city|_tower|_bridge|_castle|"
                      r"_temple|_shrine|_church|_cafe|_restaurant|_kitchen|_bathroom|_bedroom|_office|_library|"
                      r"_museum|_gym|_factory|_warehouse|_pool|_onsen|_bathhouse|_prison|_jail|_cave|_lake|_river|"
                      r"_beach|_coast|_shore|_cliff|_mountain|_hill|_forest|_garden|_yard|_balcony|_corridor|"
                      r"_staircase|_elevator|_subway|_metro|_tunnel|_train|_bus|_ship|_boat|_space|_sea|_ocean|"
                      r"_desert|_snowfield|_graveyard|_cemetery|_ruin|_rooftop|_interior|_exterior|_floor)$|"
                      r"(?:^|_)(?:classroom|bedroom|bathroom|kitchen|library|hallway|garage|balcony|rooftop|"
                      r"corridor|staircase|elevator|onsen|indoor|indoors|outdoor|inside|outside|beach|museum|"
                      r"forest|city|park|house|castle|temple|church|river|lake|mountain|sea|ocean|desert|space|"
                      r"garden|school|gym|station|airport|cafe|restaurant|store|shop|street|road|bridge|tower|farm|"
                      r"field|village|town|island|pool|cave|factory|warehouse|theater|cinema|stadium|dungeon|attic|"
                      r"basement|courtyard|mansion|playground|zoo|aquarium|harbor|dock|market|plaza|square|fountain|"
                      r"graveyard|cemetery|ruins|cliff|shore|coast|valley|hill|meadow|plain|swamp|jungle|tundra|"
                      r"savanna|waterfall|sauna|arena|pond|aqueduct|dance_floor|amphitheater|colosseum|bowling_alley|"
                      r"arcade|greenhouse|orchard|vineyard|stable|barn|shed|workshop|darkroom|hotel|inn|motel|resort|"
                      r"spa|jacuzzi|hot_spring|dormitory|fort|fortress|palace|manor|estate|cottage|cabin|hut|shack|"
                      r"igloo|yurt|tent|lighthouse|windmill|silo)(?:_|$)")

INDOOR_WORDS = ["indoor", "room", "interior", "inside", "classroom", "bathroom", "bedroom", "kitchen",
                "office", "library", "cafe", "restaurant", "shop", "store", "hall", "stage", "corridor",
                "staircase", "elevator", "subway", "tunnel", "house", "building", "factory", "warehouse",
                "onsen", "bathhouse", "prison", "jail", "garage", "studio", "shed", "barn", "stable",
                "theater", "cinema", "museum", "gym", "locker", "dormitory", "laboratory", "arena",
                "stadium", "train", "bus", "ship", "cockpit", "tent", "cabin", "igloo", "castle",
                "temple", "shrine", "church", "tombstone", "grave", "coffin"]
NIGHT_WORDS = ["night", "nighttime", "midnight", "evening", "sunset", "dusk", "twilight", "moon",
               "moonlight", "starry", "dark", "night_sky", "moon_phases"]
DAYLIGHT_WORDS = ["sunlight", "daylight", "sunbeams", "sunny", "bright_day", "blue_sky", "clear_sky",
                  "morning", "noon", "midday", "day"]

CROTCH_POSES = ["bent_over", "bending_over", "all_fours", "on_all_fours", "front_split", "side_split",
                "standing_split", "sitting_split", "side_sitting_split", "front_sitting_split",
                "standing_front_split", "oversplit", "banana_split", "heel_drop_split", "the_epic_split",
                "thunder_cross_split_attack", "v-split", "split_jump", "split_leap", "legs_apart",
                "legs_spread", "spread_legs", "wide_stance", "feet_apart", "legs_open", "wide_spread_legs",
                "upright_straddle", "reverse_upright_straddle", "straddle", "horse_pose", "knees_up",
                "knees_apart", "legs_up", "legs_lifted", "legs_over_shoulders", "feet_above_head",
                "foot_behind_head", "feet_on_own_head", "legs_in_the_air", "frog_pose", "pretzel_pose",
                "figure_four_sitting", "figure_four_standing", "foot_on_head", "feet_on_head",
                "legs_spread_up", "knees_apart_feet_together", "knees_together_feet_apart", "leg_lift",
                "foot_up_heel_up", "sitting_between_legs", "pantyhose_tug", "foot_on_railing", "legs_on_railing"]
SAFE_BOTTOMS = ["pants", "jeans", "trousers", "leggings", "shorts", "culottes", "slacks", "overalls",
                "capris", "harem_pants", "sweatpants", "track_pants", "joggers", "bike_shorts", "hot_pants",
                "bloomers", "long_skirt", "long_dress", "maxi_dress", "evening_gown", "ball_gown", "gown",
                "floor-length", "full-length", "dress_shirt_untucked"]
UNCOVERED = ["swimsuit", "bikini", "panties", "underwear", "leotard", "bodysuit", "skirt", "dress",
             "cheongsam", "qipao", "sundress", "tutu", "highleg", "micro_bikini", "lingerie", "negligee",
             "camisole", "slip", "petticoat", "impossible_shorts"]

EMO_GROUPS = [
    ["smile", "grin", "happy", "laugh", "joy", "blush", "giggle", "content", "smirk", "cheerful",
     "delighted", "gleeful", "chuckle", "beaming", "playful_smile", "teasing_smile", "gentle_smile",
     "warm_smile", "bright_smile", "open_mouth_smile", "tongue_out", "winking", "wink", "victory_sign",
     "peace_sign", "thumbs_up", "excited", "energetic", "happy_eyes", "sparkling_eyes", "glad",
     "pleasant", "sunny_smile", "smiling_eyes"],
    ["angry", "frown", "scowl", "sad", "cry", "upset", "depressed", "worried", "annoyed", "pout",
     "sigh", "frustrated", "mad", "rage", "sorrow", "gloomy", "crying", "teary", "sulking", "frowning",
     "irritated", "exasperated", "grumpy", "glaring", "glare", "serious", "stern", "severe",
     "cold_glare", "death_glare", "scowling", "biting_lip", "clenching_teeth", "gritting_teeth"],
    ["surprised", "shocked", "astonished", "amazed", "startled", "speechless", "aghast", "stunned",
     "wide_eyes", "eyes_wide", "jaw_drop", "surprised_eyes", "oh", "gasping"],
    ["neutral", "blank", "expressionless", "stoic", "calm", "serene", "composed", "deadpan",
     "emotionless", "indifferent", "uninterested", "bored", "tired", "sleepy", "drowsy", "exhausted",
     "yawn", "yawning", "sighing", "poker_face", "straight_face", "no_expression", "flat_expression"],
]

OUTFIT_SLOTS = ["连衣裙与制服", "上装", "下装", "泳装与贴身衣物"]
HAND_SLOTS = ["手臂与手势", "手持物", "双人互动"]   # 2026-10-14：手部动作并入手臂与手势
OBJECT_SLOTS = ["动物", "植物", "道具", "手持物"]


def load_user_black():
    """读 data/user_edits.json 里的 "black"（全局剔除词表）。

    ⚠️ nodes.py 和 server.py 都要用，所以放 core 里一份，避免两边各写一遍。
       文件不存在 / 读坏 → 返回空集合（不让它影响出图）。

    ⭐ 2026-11-24：**每条都展开成三种写法**（原样 / 下划线 / 空格）。
       起因：词库里存在 `black tights`（带空格）这种标签，而黑名单里写的是
       `black_tights`；所有调用点都是 `w["prompt"] not in self.black` 直接比对原样，
       于是带空格的那批永远删不掉（实测袜子槽 93 条里漏 2 条）。
       在这里统一展开，比改 6 处调用点可靠 —— 以后新增过滤点也不用再管写法。
    """
    try:
        import os as _os
        p = _os.path.join(os.path.dirname(_os.path.abspath(__file__)), "data", "user_edits.json")
        with open(p, "r", encoding="utf-8") as f:
            d = json.load(f) or {}
        v = d.get("black")
        if not isinstance(v, list):
            return set()
        out = set()
        for x in v:
            s = str(x)
            out.add(s)
            out.add(s.lower())
            out.add(s.replace(" ", "_"))
            out.add(s.replace("_", " "))
        return out
    except Exception:
        return set()


def load_weights(path=None):
    """读 data/user_edits.json 里的 "weights"（用户给单个标签设的**权重倍数**）。

    语义：倍数乘在 pick() 算出的权重上。
      · 1.0 = 默认（等于没设）
      · 0.3 = 少出现（约 1/3 机会）
      · 3.0 = 常出现（约 3 倍机会）
    范围钳在 [0.05, 20]，防止手滑输入 0 或 999 把某个词抽成唯一解。
    ⛔ 不要用 0 表达「不要」——那是黑名单（state.black / user_edits.black）的职责。

    键统一归一成「下划线 + 小写」（`black_hair` 形式），
    因为词典里 prompt 有带空格的写法（`full body`），两边必须同形才查得到。

    `path` 只给测试用（指向临时文件）；正常调用留空 = `data/user_edits.json`。
    """
    try:
        import os as _os
        p = path or _os.path.join(_os.path.dirname(_os.path.abspath(__file__)),
                                  "data", "user_edits.json")
        with open(p, "r", encoding="utf-8") as f:
            d = json.load(f) or {}
        v = d.get("weights")
        if not isinstance(v, dict):
            return {}
        out = {}
        for k, x in v.items():
            try:
                f2 = float(x)
            except Exception:
                continue
            if f2 <= 0:
                continue
            out[str(k).replace(" ", "_").lower()] = max(0.05, min(20.0, f2))
        return out
    except Exception:
        return {}


# ===== 提示词权重（2026-10-19 阿君：「我要的不是抽取权重，是标签在提示词里的权重」）=====
#   `_PROMPT_W` 是**模块级**的：`fmt_word` 是普通函数、拿不到 db 实例，
#   只能读这个全局。`load_prompt_weights()` 负责**就地刷新**它（返回同一份对象），
#   `Data.reload_weights()` 调一次就全链路生效。
#   ⚠️ 别把它改成一个「每次都重新查 db」的实现 —— fmt_word 每个标签调一次，
#      一个 50 词的提示词就是 50 次。
_PROMPT_W = {}

PROMPT_W_MIN = 0.1
PROMPT_W_MAX = 3.0


def load_prompt_weights(path=None):
    """读 user_edits.json 的 "promptWeights" —— **输出用**的加权倍数。

    抽到这个词时写成 `(tag:1.5)`（ComfyUI / WebUI 的强调语法）。
      · 1.0 = 默认 → **不加括号**，输出跟没这功能完全一样
      · >1  = 加强（1.2 / 1.5 / 2 常见）
      · <1  = 削弱（0.8 / 0.6 常见）
    范围钳在 [0.1, 3.0]：
      · <0.1 模型基本当没写，等于删除 —— 要删除请用黑名单，别用权重
      · >3   很容易把画面烧糊（ComfyUI 里 2 以上就得小心）
    ⛔ 与 `weights`（抽取频率）是两套不同的东西，键名别写混。

    键同样归一成「下划线 + 小写」（词典里 prompt 有带空格的写法）。
    ⚠️ 返回的就是模块级 `_PROMPT_W` 本体（就地清空再填），不再新建对象 ——
       否则 fmt_word 手里那份旧引用永远不会更新，表现就是"改了不生效"。
    """
    import os as _os
    p = path or _os.path.join(_os.path.dirname(_os.path.abspath(__file__)),
                              "data", "user_edits.json")
    out = {}
    try:
        with open(p, "r", encoding="utf-8") as f:
            d = json.load(f) or {}
        v = d.get("promptWeights")
        if isinstance(v, dict):
            for k, x in v.items():
                try:
                    f2 = float(x)
                except Exception:
                    continue
                if f2 <= 0:
                    continue
                c = max(PROMPT_W_MIN, min(PROMPT_W_MAX, f2))
                if abs(c - 1.0) < 1e-9:      # 1.0 = 默认，不占坑
                    continue
                out[str(k).replace(" ", "_").lower()] = c
    except Exception:
        out = {}
    _PROMPT_W.clear()
    _PROMPT_W.update(out)
    return _PROMPT_W


def prompt_weight_of(prompt):
    """某个词当前的提示词权重（没设 = 1.0）。"""
    if not _PROMPT_W:
        return 1.0
    return _PROMPT_W.get(str(prompt or "").replace(" ", "_").lower(), 1.0)


def wrap_prompt_weight(t, w):
    """把已转义好的标签文本包成 `(t:1.5)`；1.0 / 非法值原样返回。

    ⚠️ 顺序很重要：**先 esc_tag 再包**。
       `ruu (tksymkw)` 正确输出是 `(ruu \\(tksymkw\\):1.5)` ——
       外层括号给解析器当权重语法，内层转义括号是标签字面量。
       反过来先包再转义，会把权重括号自己也转义掉，整条权重失效。
    """
    try:
        w = float(w)
    except Exception:
        return t
    if not t or abs(w - 1.0) < 1e-9:
        return t
    w = max(PROMPT_W_MIN, min(PROMPT_W_MAX, w))
    # 去掉多余小数位：1.5 而不是 1.5000000001
    s = ("%.3f" % w).rstrip("0").rstrip(".")
    return "(%s:%s)" % (t, s)


def load_slot_edits():
    """读 data/user_edits.json 里的 "slotEdits"（用户对槽位池的增删）。

    ⛔ 2026-10-05 修 bug（阿君原话「在组合结果直接剔除标签没有同步消失掉」）：
       这份改动**以前只有 `/pc/slotpool`（槽位预览弹窗）在用**，真正抽词的 `Pool`
       完全没读它 ⇒ 右键「从某槽剔除」保存成功、槽位预览里也真没了，
       但 `/pc/preview` 和真跑工作流的 `run()` 照样抽得到那个词。
       现在统一由 `Pool` 应用（`apply_slot_edits`），和网页 `slotList()` 的语义一致：
       **先跑完自动过滤链，再应用用户改动**（用户 added 的词豁免 pc/性别/黑名单）。
    """
    try:
        import os as _os
        p = _os.path.join(os.path.dirname(_os.path.abspath(__file__)), "data", "user_edits.json")
        with open(p, "r", encoding="utf-8") as f:
            d = json.load(f) or {}
        ed = d.get("slotEdits")
        return ed if isinstance(ed, dict) else {}
    except Exception:
        return {}


def apply_slot_edits(db, slot, words, ed):
    """把用户的增删应用到某槽词表上（对齐网页 slotList 的顺序：先自动过滤、再用户改动）。

    ⚠️ 只有这一份实现：`Pool.slot_list()` 和 server 的 `/pc/slotpool` 都走它，
       别在别处再抄一遍（抄漏一处 = 又变成"剔除不生效"）。
    """
    if not ed:
        return words
    rm = set((ed.get("removed") or {}).get(slot) or [])
    out = [w for w in words if w["prompt"] not in rm] if rm else list(words)
    adds = (ed.get("added") or {}).get(slot) or []
    if not adds:
        return out
    have = set(w["prompt"] for w in out)
    for p in adds:
        if p in have:
            continue
        i = db.by_prompt.get(p) if db else None
        if i is not None:
            out.append(dict(db.word(i)))
        else:
            # 词库里查不到（自己造的词）→ 用最小字段塞进去，别让它把过滤链带崩
            out.append({"name": p, "prompt": p, "g": None, "s": "", "pc": None,
                        "n": None, "category": None, "pack": True})
        have.add(p)
    return out


def parse_locked(v):
    """解析「锁定标签」列表（网页 state.locked 的节点版，2026-10-05 加）。

    面板把锁定的标签以 JSON 数组写进 locked_json widget，元素形如
    {"prompt":..., "name":..., "slot":..., "g":...}；/pc/preview 直接传数组。
    锁定的词在下一次抽取里**原样保留**（并优先占用它的互斥组），其余槽正常随机。

    ⚠️ 与网页一致：「固定画质」槽不可锁定（它由「加画质词」开关统一控制）。
    ⚠️ 非法 / 空一律返回 []（不锁定任何词），**绝不让它把抽取带崩**。
    """
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return []
        try:
            v = json.loads(s)
        except Exception:
            return []
    if not isinstance(v, list):
        return []
    out = []
    for x in v:
        if not isinstance(x, dict):
            continue
        p = str(x.get("prompt") or "").strip()
        if not p or x.get("slot") == "固定画质":
            continue
        out.append({"prompt": p, "name": str(x.get("name") or p),
                    "slot": str(x.get("slot") or ""), "g": x.get("g")})
    return out


class Generator:
    def __init__(self, db, pool, rng, enable_cross=True, black=None, auto_cr=True,
                 auto_boost=True):
        self.db = db
        self.pool = pool
        self.rng = rng
        self.enable_cross = enable_cross      # 是否跑末尾「跨槽协调」
        # 自动补作品标签（2026-10-11 阿君要的）：抽到角色时，把他所属作品的
        # 版权词插到角色词后面（fate → fate_(series) / kancolle → kantai_collection）。
        self.auto_cr = bool(auto_cr)
        # 细节联动（2026-10-13 阿君拍板「5」）：抽到「东西」自动带配套词
        #（folding_fan → holding_fan / wedding_dress → bridal_veil）。默认开。
        self.auto_boost = bool(auto_boost)
        # 全局剔除（2026-09-29 移植网页 state.black）：
        # 这些词**任何槽位都不出**。存 data/user_edits.json 的 "black" 字段。
        self.black = set(black or [])

    # ---------- 主流程 ----------

    def gen(self, preset_name, space_out=True, slots_override=None, locked=None,
            cross_series=False):
        db = self.db
        R = db.R
        # 2026-10-14：档位更名「全身立绘」→「立绘」；已存工作流里的旧名自动映射，
        # 避免老工作流加载时找不到档位掉到默认档。
        # ⚠️ 2026-10-17：光映射这里**不够** —— ComfyUI 在进 Python 之前就拿 INPUT_TYPES 的
        #    选项列表校验 combo 值，旧名不在表里会直接报「preset 输入值 全身立绘 不可用」
        #    （阿君截图），根本走不到这一行。所以 nodes._preset_names() 必须把旧名也列进选项表。
        preset_name = canon_preset(preset_name)
        p = next((x for x in db.presets if x["name"] == preset_name), None)
        if p is None:
            p = db.presets[0]
        # 每轮重置景别族倍率（Pool 是跨 Generator 复用的，不清会串上一轮的值）
        self.pool._shot_bias = None

        # 槽位开关 + **每槽数量**（2026-09-29 移植网页 state.slotCounts）
        #   slots_json 的值可以是 true（=1）或数字 1~6；旧数据是 bool，照旧理解为 1。
        #   网页上限 6，「发色」固定 1（一次只能一个）。
        slot_n = {}
        if slots_override:
            for s in db.slot_order:
                v = slots_override.get(s)
                if v is True:
                    slot_n[s] = 1
                elif v is None or v is False:
                    slot_n[s] = 0
                elif isinstance(v, (int, float)) and not isinstance(v, bool):
                    slot_n[s] = max(0, min(6, int(v)))
                else:
                    slot_n[s] = 1 if v else 0
        else:
            on = set(p.get("on") or [])
            slot_n = {s: (1 if s in on else 0) for s in db.slot_order}
            # ⭐ 2026-10-17：档位可以指定「某些槽抽几个」——「双人」档的 {"角色": 2}。
            #   只在**用户没有手动覆盖这个槽**时才生效（手动优先）。
            _cnt = p.get("counts") or {}
            for _k, _v in _cnt.items():
                if not slots_override or _k not in (slots_override or {}):
                    slot_n[_k] = max(1, min(6, int(_v)))
        # ⚠️ 2026-09-30 修 bug：原来这里是**无条件**清零，
        #    于是「自由搭配」（freeAll）档下，用户手动开的槽（slots_override，来自面板的 slots_json）
        #    会被整个覆盖 ⇒ 无论怎么点槽位都只输出质量词。
        #    网页版的语义是「freeAll = 默认全关，用户自己开槽」，所以只有**没有用户覆盖时**才清零。
        if p.get("freeAll") and not slots_override:
            slot_n = {s: 0 for s in db.slot_order}
        if slot_n.get("发色", 0) > 1:
            slot_n["发色"] = 1
        slot_on = {s: (slot_n.get(s, 0) > 0) for s in db.slot_order}

        # ===== 锁定标签（2026-10-05，对齐网页 state.locked）=====
        #   锁定的词本次必定出现，并优先占用它的互斥组；该槽的抽取数量相应减一。
        #   ⚠️ 槽位本身关着也照样出（用户锁了就是要它），所以 eff_on 要把这些槽算成开。
        locked_items = parse_locked(locked)
        locked_by_slot = {}
        for _lk in locked_items:
            locked_by_slot.setdefault(_lk["slot"], []).append(_lk)
        # ⛔ 末尾「跨槽协调」会删词（景别纠正 / 俯仰互斥 / 赤脚×鞋袜 …），
        #    不保护的话用户刚锁的词可能被它判为矛盾删掉 —— 网页的 removeWhere
        #    每条都带 `!state.locked.has(c.prompt)`，这里照做：**锁定的词永不删**。
        self._lockp = set()
        for _lk in locked_items:
            self._lockp.add(_lk["prompt"])
            self._lockp.add(nz(_lk["prompt"]))

        # 档位（对应网页的 composeMode）+ 两个开关
        tier = {"fullbody": "fullbody", "portrait": "closeup", "scene": "wide",
                "action": "action"}.get(p.get("mode") or "auto", "auto")
        illust = bool(p.get("illustMode"))
        object_random = bool(p.get("objectRandom"))

        def eff_on(s):
            return bool(slot_on.get(s, False)) or bool(locked_by_slot.get(s))

        # ===== 穿搭方案：连衣裙与制服 ⇄ 上装+下装 ⇄ 泳装 —— **三者只出一个**
        # 网页按 outfitMode(auto/dress/sep/swim) 决定；ComfyUI 版没有这个参数，
        # 就按"用户开着的槽"来推：正装（dress/sep）二选一 50/50，泳装只有在前两者都没开时才出。
        # ⚠️ 漏了这段会导致「下装 + 连衣裙」100% 同框（实测 4000/4000）。
        # ⚠️ 2026-10-05：锁定优先于随机（照网页 dressLocked / sepLocked 的写法）。
        dress_avail = eff_on("连衣裙与制服")
        sep_avail = eff_on("上装") or eff_on("下装")
        swim_avail = eff_on("泳装与贴身衣物")
        dress_locked = bool(locked_by_slot.get("连衣裙与制服"))
        sep_locked = bool(locked_by_slot.get("上装") or locked_by_slot.get("下装"))
        swim_locked = bool(locked_by_slot.get("泳装与贴身衣物"))
        if dress_locked or sep_locked:
            # 两边都锁了就两边都出（与网页 outfitDress && outfitSep 一致）
            outfit_dress, outfit_sep, outfit_swim = dress_locked, sep_locked, False
        elif swim_locked:
            outfit_dress, outfit_sep, outfit_swim = False, False, True
        elif dress_avail or sep_avail:
            _d = ("dress" if self.rng.random() < 0.5 else "sep") \
                if (dress_avail and sep_avail) else ("dress" if dress_avail else "sep")
            outfit_dress, outfit_sep, outfit_swim = (_d == "dress"), (_d == "sep"), False
        elif swim_avail:
            outfit_dress, outfit_sep, outfit_swim = False, False, True
        else:
            outfit_dress, outfit_sep, outfit_swim = False, False, False

        # ⭐ 2026-10-18（阿君：双人时一个穿连衣裙、一个穿上衣+下装）：
        #   原来 outfit_dress/outfit_sep 是**全局**二选一 ⇒ 两个人都穿同一类。
        #   双人 + 自动 + 两边都没锁定时，先把两类都抽出来，等分人补齐之后再按人二选一。
        _nchar_hint = 1
        try:
            _nchar_hint = int(slot_n.get("角色", 1) or 1)
        except Exception:
            _nchar_hint = 1
        # ⚠️ 2026-10-18：`_n` 只在「多人物」分支里赋值，单人时不存在 ——
        #    下面「姿势×动作」「按人分穿搭」都要用它 ⇒ 先给个默认值，避免 UnboundLocalError。
        _n = 0
        _split_outfit = bool(_nchar_hint >= 2 and dress_avail and sep_avail
                             and not (dress_locked or sep_locked) and not swim_locked)
        if _split_outfit:
            outfit_dress = outfit_sep = True

        # 手部：≥2 个手部槽参与 → 剔 HANDS_BUSY
        hands_busy = len([x for x in HAND_SLOTS if eff_on(x)]) > 1
        # 2026-10-14：「手部动作」已并入「手臂与手势」（104 词常年休眠、仅网页物件随搭档在用），
        #    两槽掷硬币分路线机制退役；arm_single_route=False 兼容下方 ctx 使用点。
        arm_single_route = False

        # 手持物：50% 概率参与（或物件随搭时由 objectPick 决定）
        hold_on = eff_on("手持物") and self.rng.random() < R.get("HOLD_RATE", 0.5)
        object_pick = None
        if object_random:
            k = 1 + self.rng.randrange(len(OBJECT_SLOTS))
            sh = OBJECT_SLOTS[:]
            for i in range(len(sh) - 1, 0, -1):
                j = self.rng.randrange(i + 1)
                sh[i], sh[j] = sh[j], sh[i]
            object_pick = set(sh[:k])
            hold_on = "手持物" in object_pick
        # 锁了手持物 → 本次必定出（锁定优先于概率，照网页 holdLocked）
        if locked_by_slot.get("手持物"):
            hold_on = True

        HB = R["HANDS_BUSY_PROMPTS"]
        HF = R["HANDS_FULL_PROMPTS"]
        HH = R["HANDS_FULL_HELD"]
        hands_full = lambda c: nz(c) in HF
        hands_full_held = lambda c: nz(c) in HH

        result = []
        used_groups = set()
        picked_prompts = set()
        count_solo = True
        # 锁定标签优先占位：先把互斥组 / 已选集合占住，后面各槽就不会再抽到它们
        for _lk in locked_items:
            picked_prompts.add(_lk["prompt"])
            if _lk.get("g"):
                used_groups.add(_lk["g"])
        locked_used = set()          # 已回填的锁定词（最后用它补「不属于任何槽」的那些）

        for s in db.slot_order:
            locked_here = locked_by_slot.get(s) or []
            # ---- 槽级跳过 ----
            if s == "连衣裙与制服" and not outfit_dress:
                continue
            if s in ("上装", "下装") and not outfit_sep:
                continue
            if s == "泳装与贴身衣物" and not outfit_swim:
                continue
            # ⭐ 2026-10-18（阿君问「泳装模式下这些多余装饰会不会怪」）：
            #   **泳装模式自动跳过「袖型与领口」**。该槽 92 个词里只有 sleeveless / strapless
            #   两个跟比基尼不冲突，其余 90 个都是「衣服的袖子」—— 配泳装会让模型画出
            #   「长袖泳衣 / 比基尼外加长袖」这种自相矛盾的东西（实测截图：frilled bikini + puffy long sleeves）。
            #   锁定词不跳过（用户明确要就照做）。
            if s == "袖型与领口" and outfit_swim and not locked_here:
                continue
            # 2026-10-18（阿君：泳装配装饰材质有点多余）：
            #   泳装模式连「装饰与材质」也跳过 —— lace / frills / pleats / braid 这些
            #   本来是给衣服加细节的，堆到比基尼上只会让模型画成"布满蕾丝的泳衣"。
            if s == "装饰与材质" and outfit_swim and not locked_here:
                continue
            # ⭐ 2026-10-18（阿君：非人不用穿衣服）
            #   史莱姆/皮卡丘/吉祥物没有衣服可穿 —— 非人模式整组跳过服饰与配饰槽。
            #   锁定词不跳过（用户明确要就照做）。
            if self.pool.gender == "n" and s in _NONHUMAN_SKIP_SLOTS and not locked_here:
                continue
            if object_pick is not None and s in OBJECT_SLOTS and s not in object_pick \
                    and not locked_here:
                continue
            if s == "手持物" and not hold_on and not locked_here:
                continue
            # ⛔ 2026-10-17：原来只看 count_solo（由「人数」槽的词决定）。
            #   但预设里人数槽是关的 ⇒ count_solo 恒为 True ⇒ **多角色时双人互动一次都不出**
            #   （实测 角色数=2/3 时 0/200）。这里改成直接看已经抽到几个角色：
            #   角色槽排在双人互动前面，读得到。
            if s == "双人互动" and not locked_here:
                _nch = len([c for c in result if c["slot"] == "角色"])
                if _nch <= 1:
                    continue
            if not eff_on(s):
                continue

            # ---- 锁定标签原样回填（放在任何「池子空了就跳过」之前）----
            for _lk in locked_here:
                result.append({"prompt": _lk["prompt"], "name": _lk["name"],
                               "slot": s, "g": _lk.get("g")})
                locked_used.add(_lk["prompt"])
                if s == "人数":
                    count_solo = bool(re.match(r"^(solo|1girl|1boy|1other)$", nz(_lk["prompt"])))

            words = self.pool.slot_list(s)
            if not words:
                continue
            # 全局剔除：任何槽都不出黑名单里的词
            if self.black:
                words = [w for w in words if w["prompt"] not in self.black]
                if not words:
                    continue
            words = [w for w in words if w["prompt"] not in picked_prompts]

            # ---- 槽内 / 跨槽过滤 ----
            words = self._filter(s, words, result, used_groups, {
                "hands_busy": hands_busy, "arm_single_route": arm_single_route,
                "hands_full": hands_full, "hands_full_held": hands_full_held,
                "tier": tier, "illust": illust, "eff_on": eff_on,
                "SUNNY": SUNNY,
            })
            if not words:
                continue

            # ---- 人物特征：整套带走（2026-10-18 改成**每个角色各自解析**）----
            #   阿君报：双人时只有第 1 个人有马耳马尾，第 2 个同样是赛马娘却没有。
            #   原因：这里只取 `next(角色)` 第一个角色。现在遍历所有角色，各自查自己的特征映射，
            #   并标上各自的 who（单人时不标，保持老行为）。
            if s == "人物特征":
                _chars_now = [c for c in result if c["slot"] == "角色"]
                _multi = len(_chars_now) > 1
                _any = False
                for _ci, _ch in enumerate(_chars_now):
                    allow = self._traits_for(_ch["prompt"])
                    if not allow:
                        continue
                    aset = set(a.replace(" ", "_") for a in allow)
                    keep = [w for w in words if nz(w) in aset]
                    if not keep:
                        continue
                    # ⚠️ 2026-09-29：网页侧是「有特征就**整套带走**」（赛马娘 → 马耳+马尾+马娘本体），
                    #    原来这里只把 keep 当池子、下面又 rng.choice 抽 1 个 ⇒ 一组只出 1 个词。
                    #    实测：网页「人物特征」累计 39.4%、节点 19.7%（组级两者都是 ~20%，
                    #    差的正是"一组出 1 个还是出整套"）。这里改成全部加入，然后 continue。
                    _local = set()
                    for w in keep:
                        wp = nz(w)
                        if not wp or wp in _local:
                            continue
                        # 单人：沿用旧的全局去重；多人：每个角色各带一份（同名特征允许重复）
                        if not _multi and wp in picked_prompts:
                            continue
                        _local.add(wp)
                        result.append({"prompt": w["prompt"], "name": w["name"],
                                       "slot": s, "g": w.get("g"),
                                       **({"who": _ci} if _multi else {})})
                        picked_prompts.add(wp)
                        if w.get("g"):
                            used_groups.add(w["g"])
                    _any = True
                # ⛔ 2026-10-18（阿君：锁定申鹤却配了「牛娘/水獭耳」）：
                #   **没有特征映射也必须跳过**，绝不能退回随机抽。
                #   原来写的是 `if _any: continue` —— 没人有特征时会 fall through 到常规随机，
                #   于是随机特征词被加上 who 兜底，全算到第 1 个人头上。
                continue

            # ---- tierPoolFilter（镜头区提前剔，避免末尾协调删空）----
            words = self._tier_filter(s, words, result, tier, illust)
            if not words:
                continue

            # 该槽要抽几个（2026-09-29：原来恒为 1，现在按 slot_n；上限 6、发色 1）
            # ⚠️ 2026-10-05：锁定的词已经回填了，这里要扣掉，否则会多抽一个
            #    （槽位关着又被锁定时 slot_n=0 → base=0 → 只出锁定词，不再补随机）
            _sn = slot_n.get(s, 0)
            _base = 0 if not slot_on.get(s, False) else max(1, int(_sn or 0))
            need = max(0, _base - len(locked_here))
            # ⛔ 2026-10-14：整体姿态槽只出 1 个 —— 数量调 2 时「交叉腿」三词（为跟动作槽
            #    互斥保留 g_pose_dynamic）会与 g_basepose 词跨组同框（实测 78% 出
            #    「站立交叉腿+躺/坐」类矛盾组合）。锁定 1 个后也不再补抽。
            if s == "基础姿势":
                # 单人只出 1 个（多出会互相打架）；**双人时每人一个**（2026-10-18）
                need = min(need, max(0, (_nchar_hint if _nchar_hint >= 2 else 1) - len(locked_here)))
            # ⭐ 2026-10-17：多角色时**只用有明确性别标记的角色**。
            #   「性别=全部」池里 19% 的角色没有 f/m 标记（6416/34183），
            #   抽到它们就没法确定人数该写 2girls 还是 2boys（实测 87/200 写错）。
            if s == "角色" and need >= 2:
                _known = [w for w in words
                          if self.db.char_gender(w["prompt"]) in ("f", "m")]
                if len(_known) >= need:
                    words = _known
            # ⭐ 2026-10-18（阿君：同作品要 100%）：多人且「同作品优先」时，
            #   **只从有作品信息的角色里抽**。否则第一个角色没有作品映射（约 40% 的角色没有），
            #   后面就只能各自独立抽 ⇒ 实测只有 85%。
            if s == "角色" and need >= 1 and not cross_series:
                _cr_map = self.db.cr_of_char()
                # 先只留有作品信息的，再要求「该作品在本池里至少有 need 个」——
                # 否则抽到独苗角色时根本没有同作品可配，又会掉回独立抽（实测 93%）。
                _cnt = {}
                for _w in words:
                    _c = _cr_map.get(nz(_w["prompt"]))
                    if _c:
                        _cnt[_c] = _cnt.get(_c, 0) + 1
                _withpair = [w for w in words
                             if _cnt.get(_cr_map.get(nz(w["prompt"])), 0) >= need]
                if len(_withpair) >= need:
                    words = _withpair
                else:
                    _withcr = [w for w in words if _cr_map.get(nz(w["prompt"]))]
                    if len(_withcr) >= need:
                        words = _withcr
            _bt_start = len(result)   # 「手臂与手势」手数防崩的裁剪起点（见循环后）
            # ⚠️ 2026-10-18（阿君：锁定一个角色再开双人，第二个**没有**配同作品）：
            #   原来 `_char_start = len(result)` 指向「本次循环开始处」，
            #   而**锁定的角色是在这之前就回填进 result 的** ⇒
            #   `len(result) > _char_start` 恒为 False ⇒ 同作品 / 同性别两个约束全部失效。
            #   改成「指向 result 里第一个角色（含锁定）」，锁定角色也能当锚点。
            _char_start = next((_i for _i, _c in enumerate(result) if _c["slot"] == "角色"),
                               len(result))
            _cr0 = (self.db.cr_of_char().get(nz(result[_char_start]["prompt"]))
                    if len(result) > _char_start else None)   # 第一个角色（含锁定）所属作品
            for _ in range(need):
                avail = [w for w in words if not w.get("g") or w["g"] not in used_groups]
                if not avail:
                    break
                # ⭐ 2026-10-17（阿君要的）：多角色时**尽量同作品配对**。
                #   第一个角色正常抽（均匀），抽到后取其版权词，后面的角色只在同作品里选。
                #   覆盖率：CR_BY_CHAR 有 9255 条（角色池 21,728 → 约 42%），
                #   第一个角色没有作品信息时自动退回「各自独立抽」，不会卡死。
                # ⭐ 2026-10-17：多角色时**先保证同性别** —— 否则「两个男的」会被写成 2girls。
                #   只在第一个角色有明确性别标记（f/m）时才约束；
                #   性别=全部 模式下不做这一步的话，混搭率约 30% 且人数词必错。
                #   2026-10-17 阿君追加：「全部」模式下**允许一男一女**，所以只在
                #   f / m 单性别池里才强制同性别（那里本来也不会混，等于兜底防数据错标）。
                if (s == "角色" and self.pool.gender != "all"
                        and len(result) > _char_start):
                    _g0 = self.db.char_gender(result[_char_start]["prompt"])
                    if _g0 in ("f", "m"):
                        _same_g = [w for w in avail
                                   if self.db.char_gender(w["prompt"]) in (_g0, "")]
                        if _same_g:
                            avail = _same_g
                # 2026-10-18 阿君要的「跨作品组合」开关：开着就**不做同作品约束**，
                # 两个角色各自独立抽（同性别约束仍然生效）。
                if s == "角色" and _cr0 and not cross_series and len(result) > _char_start:
                    _cr_of = self.db.cr_of_char()
                    _same = [w for w in avail
                             if _cr_of.get(nz(w["prompt"])) == _cr0]
                    if _same:
                        avail = _same
                w = self.pool.pick(avail, self.rng, slot=s)
                result.append({"prompt": w["prompt"], "name": w["name"], "slot": s,
                               "g": w.get("g")})
                if s == "角色" and _cr0 is None:
                    _cr0 = self.db.cr_of_char().get(nz(w["prompt"]))
                picked_prompts.add(w["prompt"])
                if w.get("g"):
                    used_groups.add(w["g"])
                if s == "人数":
                    count_solo = bool(re.match(r"^(solo|1girl|1boy|1other)$", nz(w)))
                # 抽下一个前把已抽过的剔掉；抽空了就提前结束（少抽几个总比重复好）
                words = [x for x in words if x["prompt"] not in picked_prompts]
                if not words:
                    break
            # ⛔ 2026-10-14：手数防崩（「手臂与手势」合并后可出多词）——实测数量=2 时
            #    54% 会出「双手占死词 + 另一个词」= 至少三只手。顺序裁剪：最多保留 2 个；
            #    遇到「双手占死」词：是第一个就保留并停止，不是就丢弃并停止（与网页端同款）。
            if s == "手臂与手势" and len(result) - _bt_start > 1:
                _kept, _full_hit, _j = 0, False, _bt_start
                while _j < len(result):
                    if _full_hit or _kept >= 2:
                        _drop = result.pop(_j)
                        picked_prompts.discard(_drop["prompt"])
                        if _drop.get("g"):
                            used_groups.discard(_drop["g"])
                        continue
                    if hands_full(result[_j]):
                        _full_hit = True
                        if _kept == 0:
                            _kept = 1
                            _j += 1
                        else:
                            _drop = result.pop(_j)
                            picked_prompts.discard(_drop["prompt"])
                            if _drop.get("g"):
                                used_groups.discard(_drop["g"])
                        continue
                    _kept += 1
                    _j += 1

        # 锁定了但槽位不在 db.slot_order 里（自定义/已删槽）的词 → 追加到最后
        for _lk in locked_items:
            if _lk["prompt"] in locked_used:
                continue
            result.append({"prompt": _lk["prompt"], "name": _lk["name"],
                           "slot": _lk["slot"], "g": _lk.get("g")})
            locked_used.add(_lk["prompt"])

        if self.enable_cross:
            self._cross_coordinate(result, tier)
        # ⭐ 2026-10-17：**多人分写** —— 每个角色各拿一份表情/服装/配饰/外观。
        #   原来所有属性槽只抽 1 个词 ⇒ 两个角色穿同一件、表情一样。
        #   这里按 who 标号分组：角色 i 拿到第 i 份；不够就从池里补（避开已用词）。
        #   ⚠️ 场景/光照/构图/镜头/景深/景别/双人互动 属于「两人共用」，不参与分写。
        _chars = [c for c in result if c["slot"] == "角色"]
        if len(_chars) >= 2:
            for _i, _c in enumerate(_chars):
                _c["who"] = _i
            _n = len(_chars)
            _used = {nz(c) for c in result}
            for _sl in ATTR_SLOTS:
                if not eff_on(_sl):
                    continue
                # ⭐ 2026-10-19（阿君：双人非人还是出服饰）：
                #   主循环里已经按性别跳过服饰槽，但**分人补齐**这条路又把它补回来了。
                #   这里必须同样门控，否则双人档给数码宝贝穿上校服/靴子/黑丝。
                if self.pool.gender == "n" and _sl in _NONHUMAN_SKIP_SLOTS:
                    continue
                # ⛔ 2026-10-18（阿君：穿搭自动档却同时出「连衣裙 + 上装 + 下装」）：
                #   「分人补齐」会把**穿搭方案故意跳过的槽**重新从池子里补满，
                #   等于把「连衣裙 ⇄ 上装+下装 ⇄ 泳装 三选一」的互斥彻底废掉。
                #   这里必须跟着 outfit_* 一起门控。
                if _sl == "连衣裙与制服" and not outfit_dress:
                    continue
                if _sl in ("上装", "下装") and not outfit_sep:
                    continue
                if _sl == "泳装与贴身衣物" and not outfit_swim:
                    continue
                # ⛔ 2026-10-18（阿君截图：双人公共描述里混进 horse_tail）：
                #   「人物特征」是**整套带走**的（马耳+马尾+马娘本体 一次加 3 个），
                #   而下面按「每人一份」分配 ⇒ 第 3 个词没人认领，who 保持 None ⇒ 掉进公共组。
                #   特征本来就是从**第一个角色**解析出来的，所以整组都归 who=0。
                if _sl == "人物特征":
                    # 上面已经按角色标过 who 的**不要覆盖**；只有没标的（老路径）兜底归第一个角色
                    for _c in result:
                        if _c["slot"] == "人物特征" and _c.get("who") is None:
                            _c["who"] = 0
                    continue
                _items = [c for c in result if c["slot"] == _sl]
                for _i in range(_n):
                    if _i < len(_items):
                        _items[_i]["who"] = _i
                        continue
                    _cand = [w for w in self.pool.slot_list(_sl)
                             if nz(w["prompt"]) not in _used
                             and w["prompt"] not in self.black
                             and w["prompt"] not in self._lockp]
                    # ⚠️ 这里**故意不做互斥组过滤**：互斥组是为了防止「同一个人
                    #    裙子+连衣裙」；而两个人各穿一条下装是合理的，
                    #    按组过滤会导致第二个人永远拿不到衣服。
                    if not _cand:
                        break
                    _w = self.pool.pick(_cand, self.rng, slot=_sl)
                    _used.add(nz(_w["prompt"]))
                    result.append({"prompt": _w["prompt"], "name": _w["name"],
                                   "slot": _sl, "g": _w.get("g"), "who": _i})
        # ⭐ 2026-10-18：双人 + 穿搭自动 → **每个角色各穿一套**，随机「连衣裙」或「上装+下装」。
        #   上面两类都抽好了（各 n 份），这里按人二选一，把另一类里属于这个人的词丢掉。
        #   锁定的词不动（用户明确要的），所以被锁的那一类仍然保留。
        if _split_outfit:
            for _i in range(_n):
                _pd = [c for c in result if c.get("who") == _i
                       and c["slot"] == "连衣裙与制服" and c["prompt"] not in self._lockp]
                _ps = [c for c in result if c.get("who") == _i
                       and c["slot"] in ("上装", "下装") and c["prompt"] not in self._lockp]
                if not (_pd and _ps):
                    continue
                if self.rng.random() < 0.5:
                    result = [c for c in result
                              if not (c.get("who") == _i
                                      and c["slot"] in ("上装", "下装")
                                      and c["prompt"] not in self._lockp)]
                else:
                    result = [c for c in result
                              if not (c.get("who") == _i
                                      and c["slot"] == "连衣裙与制服"
                                      and c["prompt"] not in self._lockp)]

        # ⭐ 2026-10-18（阿君：查一下其他槽位有没有问题）—— 审计出来的三条：
        #   ① 远景（wide/long/establishing…）配表情：远到看不见脸，纯噪音（实测 30~43%）
        #   ② 裸足配袜子/腿部服饰：自相矛盾（4~6%）
        #   ③ 同一个词重复出现两次（跨槽同词）
        _FAR_SHOT = {"wide_shot", "long_shot", "extreme_wide_shot", "establishing_shot",
                     "medium_wide_shot", "extreme_long_shot"}
        _BAREFOOT = {"barefoot", "bare_feet", "bare_legs", "toeless_legwear"}
        _who_all = list(range(_n)) if _n else [None]
        for _i in _who_all:
            _mine = [c for c in result if c.get("who") == _i]
            _far = any(c["slot"] == "景别" and nz(c["prompt"]) in _FAR_SHOT for c in _mine)
            _bare = any(nz(c["prompt"]) in _BAREFOOT for c in _mine)
            if _far or _bare:
                result = [c for c in result
                          if not (c.get("who") == _i and c["prompt"] not in self._lockp
                                  and ((_far and c["slot"] == "表情")
                                       or (_bare and c["slot"] in ("袜子", "腿部服饰"))))]
        #   ③ 跨槽同词去重（`toeless_legwear` 从「袜子」「腿部服饰」各出一份）
        _seen_p = set()
        _dedup = []
        for c in result:
            k = nz(c["prompt"])
            if k in _seen_p and c["prompt"] not in self._lockp:
                continue
            _seen_p.add(k)
            _dedup.append(c)
        result = _dedup

        # ⭐ 2026-10-18：姿势 × 动作 同一人身上别打架（双人分人后实测 3% 出「躺 + 跑步」）。
        #   姿势是静止/低位的（躺、坐、跪、蹲）时，剔掉这个人的移动类动作。
        #   判定改用**动作 → 允许的姿势**映射（2026-10-18 审计又抓出「standing + flying」）：
        #   白名单只能拦"看起来不能动"的姿势，拦不住"动作本身要求空中/趴地"这种情况。
        _STAND = {"standing", "standing_on_one_leg", "contrapposto", "leaning_forward",
                  "leaning_back", "leaning_to_the_side", "leaning", "tiptoes",
                  "legs_together", "knees_together", "knees_together_feet_apart",
                  "knee_up", "leg_up", "feet_apart", "one_foot_forward", "wide_stance",
                  "fighting_stance", "ready_stance", "high_kick", "stretching", "dancing",
                  "walking_toward_viewer", "stepping_forward", "crossed_legs_while_standing",
                  "dynamic_pose", "action_pose", "elegant_pose", "relaxed_pose", "bent_over"}
        _AIR = {"floating", "falling"}
        _ACT_POSE_OK = {
            "walking": _STAND, "running": _STAND, "skipping": _STAND,
            "walking_on_liquid": _STAND, "punching": _STAND,
            "jumping": _STAND | _AIR,
            "crawling": {"bent_over"},
            "flying": _AIR, "flying_kick": _AIR,
        }
        # 单人时 who 全是 None、_n 为 0 —— 也要检查这一条，所以用 [None] 兜底
        _who_iter = list(range(_n)) if _n else [None]
        for _i in _who_iter:
            _pose = {nz(c["prompt"]) for c in result
                     if c.get("who") == _i and c["slot"] == "基础姿势"}
            if not _pose:
                continue
            def _act_ok(act):
                allow = _ACT_POSE_OK.get(act)
                if allow is None:
                    return True                     # 没登记的动作不管
                return bool(_pose & allow)
            result = [c for c in result
                      if not (c.get("who") == _i and c["slot"] == "动作"
                              and not _act_ok(nz(c["prompt"]))
                              and c["prompt"] not in self._lockp)]

        # ⭐ 2026-10-18（阿君：带了人物特征却没放进来）
        #   「人物特征」槽关着时（极简就是），角色的标志性特征（光环/兔耳/马耳…）不会补
        #   ⇒ 抽到美游却没有兔耳和光环，模型根本认不出是谁。
        #   这里在槽关着时按角色映射**强制补上**（有映射才补，没有不瞎加）。
        if not slot_n.get("人物特征", 0):
            _chars_t = [c for c in result if c["slot"] == "角色"]
            _multi_t = len(_chars_t) > 1
            _seen_tr = {nz(c["prompt"]) for c in result if c["slot"] == "人物特征"}
            _tr_pool = self.pool.slot_list("人物特征")
            for _ci, _ch in enumerate(_chars_t):
                _allow = self._traits_for(_ch["prompt"])
                if not _allow:
                    continue
                _aset = set(a.replace(" ", "_") for a in _allow)
                for w in _tr_pool:
                    wp = nz(w["prompt"])
                    if wp not in _aset or wp in _seen_tr:
                        continue
                    _g = w.get("g")
                    if _g and _g in used_groups:
                        continue
                    result.append({"prompt": w["prompt"], "name": w["name"],
                                   "slot": "人物特征", "g": _g,
                                   **({"who": _ci} if _multi_t else {})})
                    _seen_tr.add(wp)
                    if _g:
                        used_groups.add(_g)

        # ⭐ 2026-10-17：自动补「人数」词（1girl / 1boy + solo）。
        #   发现：六个预设**都没开「人数」槽** ⇒ 输出里永远没有 1girl / solo。
        #   而 safebooru 10 万张真实图里 1girl 占 57.4%（全库第 2）、solo 占 51.8%（第 3）；
        #   四份独立指南也都把「人数」列为质量之后的第一条。
        #   缺了它，模型不知道画面里有几个人 —— 多画一个人、主体被裁开都由此而来。
        #   规则：只在「人数槽没开」且「确实抽到了 1 个角色」且「没有双人互动词」时补，
        #        绝不覆盖用户自己开的人数槽。
        if not slot_n.get("人数", 0):
            _nchar = len([c for c in result if c["slot"] == "角色"])
            _duo = any(c["slot"] == "双人互动" for c in result)
            # 双人互动本身就意味着画面里有两个人 —— 只抽到 1 个角色名时按 2 人算
            _n = _nchar + (1 if (_duo and _nchar <= 1) else 0)
            if _n >= 1:
                _m = (self.pool.gender == "m")
                _marks = [self.db.char_gender(c["prompt"]) for c in result
                          if c["slot"] == "角色"]
                _mixed = ("f" in _marks and "m" in _marks)
                if self.pool.gender == "n":
                    # 非人（史莱姆/吉祥物/机甲）在 danbooru 用 1other / 2others
                    _cnt = {1: "1other", 2: "2others", 3: "3others"}.get(_n, "multiple_others")
                elif _n == 1:
                    _cnt = "1boy" if (_marks[0] == "m" or (_m and _marks[0] != "f")) else "1girl"
                elif _n == 2 and _mixed:
                    # 一男一女 → danbooru 写法是两个人数词，不是 2girls
                    _cnt = "1girl"
                elif _n == 2:
                    _cnt = "2boys" if (_marks and all(k == "m" for k in _marks) or (_m and "f" not in _marks)) else "2girls"
                elif _n == 3:
                    _cnt = "3boys" if _m else "3girls"
                else:
                    _cnt = "multiple_boys" if _m else "multiple_girls"
                if _n == 2 and _mixed:
                    # 一男一女 → danbooru 的写法是**两个**人数词，不是 2girls
                    for _w2 in ("1girl", "1boy"):
                        if not any(nz(c) == _w2 for c in result):
                            result.append({"prompt": _w2, "name": _w2, "slot": "人数",
                                           "g": "g_count"})
                else:
                    if not any(nz(c) == _cnt for c in result):
                        result.append({"prompt": _cnt, "name": _cnt, "slot": "人数",
                                       "g": "g_count"})
                # solo 只在「画面里就一个人、且没有双人互动」时才成立
                if _n == 1 and not _duo and not any(nz(c) == "solo" for c in result):
                    result.append({"prompt": "solo", "name": "solo", "slot": "人数", "g": None})
        # 2026-10-17 阿君拍板：**自动补作品固定开启，不再留开关** ——
        #   抽到角色就补所属作品，抽不到就什么也不做。原 auto_cr 参数保留只为兼容。
        self._append_copyright(result)
        if self.auto_boost:
            self._append_boost(result)
        # ⛔ 2026-10-14 终检：手部一致性兜底 —— 后置补位（删了又补回的词）会在时序上绕过
        #    前面所有手部防护；这里对最终组合兜底：手持物 与「忙手/双手占死」词同框 → 移除手持物。
        if any(c["slot"] == "手持物" for c in result):
            _hb2, _hf2 = R["HANDS_BUSY_PROMPTS"], R["HANDS_FULL_PROMPTS"]
            if any(nz(c) in _hb2 or nz(c) in _hf2 for c in result if c["slot"] != "手持物"):
                result[:] = [c for c in result if c["slot"] != "手持物"]
        # ⛔ 2026-10-19：景别族倍率只在**本轮生成内**有效，出去必须清掉。
        #   Pool 是跨调用复用的，漏清 → 下次直接调 Pool.pick()（补位 / 测试）会带上
        #   上一轮的倍率，表现为「什么都没改，全身份额却是 44%」（回归里抓到的）。
        self.pool._shot_bias = None
        return result

    # ---------- 细节联动（2026-10-13，阿君拍板「5」）----------

    def _append_boost(self, result):
        """抽到「东西」时自动带上配套词（danbooru 686 万帖实证的高共现搭配）。
           规则（与网页 genLogic 末尾的 boost 块同构）：
           · 只补不占：词已在、黑名单里、NSFW（开了过滤）、互斥组被占、
             与已抽到的词撞 PAIR_MUTEX、或同槽已有词 —— 一律跳过
           · slot 记词自己的分类（手持物/首饰/道具…），只影响展示与导出
        """
        if not self.db.pair_boost:
            return
        have = set()
        used_g = set()
        used_slot = {}
        for c in result:
            p = str(c.get("prompt") or "").replace(" ", "_")
            have.add(p)
            nzp = str(c.get("prompt") or "").replace(" ", " ")
            have.add(nzp)
            if c.get("g"):
                used_g.add(c["g"])
            s = str(c.get("slot") or "")
            if s:
                used_slot[s] = used_slot.get(s, 0) + 1
        # ⛔ 2026-10-14：手部状态（忙手/双手占死词是否已在）—— 供"拿着东西"类补词检查
        #    （全量扫描漏网：covering_own_eyes(双手遮眼) + 道具 towel → 补了 holding_towel）
        _R = self.db.R
        _hand_loaded = any(
            str(c.get("slot") or "") != "手持物" and
            (nz(c) in _R["HANDS_BUSY_PROMPTS"] or nz(c) in _R["HANDS_FULL_PROMPTS"])
            for c in result)
        out = list(result)
        added = set()
        for c in list(result):
            t = str(c.get("prompt") or "").replace(" ", "_")
            b = self.db.pair_boost.get(t)
            if not b or b in have or b in added:
                continue
            if b in self.black or b.replace("_", " ") in self.black:
                continue
            ri = self.db.row_by_prompt.get(b)
            if ri is None:
                continue
            row = self.db.dict_rows[ri]
            if self.pool.nsfw_filter and row[5] == 1:
                continue
            g = row[2] or None
            if g and g in used_g:
                continue
            slot = self.db.slot_of_row.get(b) or str(row[6] or "")
            # ⛔ 2026-10-18（阿君：穿搭自动档却同时出「下装 + 连衣裙」「上装+下装+连衣裙」）：
            #   联动补词没做**服装互斥**检查 —— 看见 skirt 就补 uniform、看见 shirt 就补
            #   shirt_under_dress，把「连衣裙 ⇄ 上装+下装」的互斥打破了。
            if slot == "连衣裙与制服" and (used_slot.get("上装", 0) or used_slot.get("下装", 0)):
                continue
            if slot in ("上装", "下装") and used_slot.get("连衣裙与制服", 0):
                continue
            if slot in ("手持物", "双人互动") and used_slot.get(slot, 0) > 0:
                continue                       # 手已被占/动作已有，不抢
            if slot == "手持物" and _hand_loaded:
                continue                       # ⛔ 2026-10-14：手上已有忙手/双手词 → 不补"拿着东西"
            if self.db.pair_mutex:
                ban = set()
                for p2 in have:
                    s2 = self.db.pair_mutex.get(p2)
                    if s2:
                        ban |= s2
                if b in ban:
                    continue
            have.add(b)
            have.add(b.replace("_", " "))
            if g:
                used_g.add(g)
            used_slot[slot] = used_slot.get(slot, 0) + 1
            added.add(b)
            out.append({"prompt": row[0], "name": row[1], "slot": slot, "g": g})
        result[:] = out

    # ---------- 自动补作品标签 ----------

    def _append_copyright(self, result):
        """抽到角色 → 把所属作品的版权词插到角色词正后方（阿君 2026-10-11 要的功能）。

        规则：
          - 只在「角色」槽后面插；同一张图抽到多个角色时各自带各自的。
          - 已去重：角色和版权词已经在一起出现（如锁定词已带 / 多角色同作品）就不再重复。
          - 用户黑名单里的版权词不补（用户在面板里剔了就是不要）。
          - slot 记作「作品」，只影响面板显示和明细导出，不参与任何互斥/协调。
        """
        seen = set()
        for c in result:
            seen.add(c["prompt"])
            seen.add(nz(c["prompt"]))
        out = []
        for c in result:
            out.append(c)
            if c.get("slot") != "角色":
                continue
            cr = self.db.cr_resolve(c.get("prompt"), c.get("name"))
            if not cr:
                continue
            if cr in seen or cr.replace("_", " ") in seen:
                continue
            if cr in self.black or cr.replace("_", " ") in self.black:
                continue
            row_idx = self.db.cr_by_prompt.get(cr)
            if row_idx is None:
                continue
            w = self.db.word(row_idx)
            seen.add(cr)
            seen.add(cr.replace("_", " "))
            # 2026-10-17 阿君拍板：作品词**归公共描述**，不给某个角色。
            #   理由：双人档两个人本来就同作品，挂在角色 A 名下会让「第二人」看起来缺了一块；
            #   放公共里只出现一次、两人共用，也符合 danbooru 的写法。
            out.append({"prompt": w["prompt"], "name": w["name"],
                        "slot": "作品", "g": None})
        result[:] = out

    # ---------- 逐槽过滤 ----------

    def _filter(self, s, pool, result, used_groups, ctx):
        R = self.db.R
        hb = ctx["hands_busy"]
        HF_full = ctx["hands_full"]
        HF_held = ctx["hands_full_held"]
        eff_on = ctx["eff_on"]

        # ===== 标签对互斥（PAIR_MUTEX）：与已抽到的词冲突的候选直接剔掉 =====
        if self.db.pair_mutex and result:
            taken_pm = set()
            for _c in result:
                _p = str(_c.get("prompt") or "").replace(" ", "_")
                if _p in self.db.pair_mutex:
                    taken_pm |= self.db.pair_mutex[_p]
            if taken_pm:
                pool = [w for w in pool
                        if str(w["prompt"]).replace(" ", "_") not in taken_pm]

        def keep_if(pred):
            nonlocal pool
            k = [w for w in pool if not pred(w)]
            if k:
                pool = k

        # 1.1 手部忙：四槽剔 HANDS_BUSY
        if hb and s in ("手臂与手势", "基础姿势", "双人互动"):
            pool = [w for w in pool if nz(w) not in R["HANDS_BUSY_PROMPTS"]]

        # 1.2 单臂路线：手臂槽只留单手词
        if s == "手臂与手势" and ctx["arm_single_route"]:
            keep_if(HF_full)

        # POSE_HANDS_FULL：姿势占满双手 → 手臂与手势整槽不出
        if s == "手臂与手势":
            pose = next((c for c in result if c["slot"] == "基础姿势"), None)
            if pose and POSE_HANDS_FULL_RE.match(nz(pose)):
                return []

        # 1.3 / 1.4（2026-10-14 移除：「手部动作」槽专有两条让位随槽合并退役）

        # 1.5 手持物
        if s == "手持物":
            if any(nz(c) in R["HANDS_BUSY_PROMPTS"] or HF_full(c) for c in result):
                return []
            # 2026-09-30：道具槽已经拿了「可手持的物件」→ 手持物整槽不出。
            #   用户实证 W_自由搭配_08：道具 `chocolate-covered food` + 手持物 `holding_cigarette`
            #   ⇒ 出图画成"一只手同时夹着烟和巧克力"（单手同持两物）。
            #   判定是**数据驱动**的：道具名能在「手持物」池里找到对应的 holding_X 词根才算可手持，
            #   于是 bookshelf / van / fighter jet 这类大件不会误伤。
            # ⚠️ 词根用**未过滤的整槽池**推（self.pool.slot_list）—— 用被 HF_held 筛过的
            #   局部 pool 会漏（holding_doll 属 HANDS_FULL_HELD，手臂槽一出词就被筛掉，
            #   于是「道具 doll × 手持物 holding_lollipop」漏网；实测 240 组漏 1 组）。
            hold_roots = {str(w["prompt"] or "").replace(" ", "_")[8:] for w in self.pool.slot_list("手持物")
                          if str(w["prompt"] or "").replace(" ", "_").startswith("holding_")}
            hold_rx = [re.compile(r"^" + re.escape(r) + r"(-|$)") for r in hold_roots if len(r) > 2]
            for c in result:
                if c["slot"] != "道具":
                    continue
                if any(rx.match(t) for t in nz(c).split("_") for rx in hold_rx):
                    return []
            if any(c["slot"] == "手臂与手势" for c in result):
                keep_if(HF_held)

        # 规则 1：景深档位互斥（镜头槽抽到光圈 → 景深不许反档）
        if s == "景深":
            cls = None
            for c in result:
                if c["slot"] != "镜头":
                    continue
                k = nz(c)
                if k in DOF_DEEP:
                    cls = "deep"
                    break
                if k in DOF_SHALLOW:
                    cls = "shallow"
                    break
            if cls:
                ban = DOF_SHALLOW if cls == "deep" else DOF_DEEP
                keep_if(lambda w: nz(w) in ban)

        # 规则 2：景别 ⇄ 镜头
        if s == "镜头":
            shot = next((c for c in result if c["slot"] == "景别"), None)
            if shot:
                sp = nz(shot).lower()
                ban = None
                if CLOSE_FRAME_RE.search(sp):
                    ban = {"fisheye", "wide-angle_lens", "14mm_lens", "24mm_lens", "28mm_lens"}
                elif WIDE_FRAME_RE.search(sp):
                    ban = {"macro_lens"}
                if ban:
                    keep_if(lambda w: nz(w).lower() in ban)

        # 规则 3：景别 ⇄ 构图
        if s == "构图":
            shot = next((c for c in result if c["slot"] == "景别"), None)
            if shot:
                sp = nz(shot).lower()
                ban = None
                if BIG_SHOT_RE.search(sp):
                    ban = set(CROPS) | {"portrait"}
                elif re.search(r"close-?up|bust_shot|detail_shot", sp):
                    ban = {"cropped_head"}
                if ban:
                    keep_if(lambda w: nz(w).lower() in ban)

        # 规则 4：剪影 ⇄ 光照
        if s == "构图":
            lt = next((c for c in result if c["slot"] == "光照"), None)
            if lt and FLAT_LIGHT_RE.match(nz(lt).lower()):
                keep_if(lambda w: nz(w).lower() in {"silhouette", "silhouette_composition"})

        # 规则 5：背面视角 ⇄ 身前手部动作
        if s in ("手臂与手势", "基础姿势"):
            cam = next((c for c in result if c["slot"] == "相机方位"), None)
            if cam and re.match(r"^(from_behind|rear_three-quarter_view)$", nz(cam).lower()):
                keep_if(lambda w: nz(w) in R["FRONT_ONLY_HANDS"])

        # 规则 6：贴地机位 ⇄ 大远景（⚠️ 比对用带空格的原始 prompt）
        if s == "相机方位":
            shot = next((c for c in result if c["slot"] == "景别"), None)
            if shot and BIG_SHOT_RE.search(nz(shot)):
                self_l = {"ground-level shot", "foot-level shot"}
                keep_if(lambda w: str(w["prompt"] or "") in self_l)

        # 规则 7：躺卧 ⇄ 下垂/插兜/搭桌
        if s == "手臂与手势":
            pose = next((c for c in result if c["slot"] == "基础姿势"), None)
            if pose and LYING_RE.match(nz(pose)):
                keep_if(lambda w: re.match(r"^(arms?_at_sides?|hands?_in_pockets?|arms?_on_table)$", nz(w)))

        # 规则 8：水下场景门控
        if s == "场景" and not eff_on("泳装与贴身衣物"):
            keep_if(lambda w: nz(w) == "underwater")

        # 规则 9：摄影棚光 ⇄ 户外场景
        if s == "光照":
            sc = next((c for c in result if c["slot"] == "场景"), None)
            if sc and OUTDOOR_RE.match(nz(sc)):
                keep_if(lambda w: nz(w) == "studio_lighting")

        # 规则 12：夜景观光照
        if s == "光照":
            sc = next((c for c in result if c["slot"] == "场景"), None)
            if sc and NIGHT_RE.match(nz(sc).lower()):
                keep_if(lambda w: nz(w).lower() in set(SUNNY))

        # 规则 10：搭膝 ⇄ 非坐姿
        if s == "手臂与手势":
            pose = next((c for c in result if c["slot"] == "基础姿势"), None)
            if pose and not KNEELIKE_RE.match(nz(pose)):
                keep_if(lambda w: re.match(r"^arms?_on_knees?$", nz(w)))

        # 规则 11：四肢着地 ⇄ 手臂离地
        if s == "手臂与手势":
            pose = next((c for c in result if c["slot"] == "基础姿势"), None)
            if pose and nz(pose) == "all_fours":
                keep_if(lambda w: OFF_GROUND_RE.match(nz(w)))

        # 规则 13：长裤 ⇄ 腿部袜类
        if s == "袜子":
            bot = next((c for c in result if c["slot"] == "下装"), None)
            if bot and LONG_PANTS_RE.match(nz(bot)):
                def is_banned(w):
                    p = nz(w)
                    if p == "sleeve_garter":
                        return False
                    if "garter" in p:
                        return True
                    if re.search(r"pantyhose|tights", p):
                        return True
                    if re.search(r"thighhigh|thigh_high|kneehigh|knee_high|over-knee|stockings|leg_warmers|legwear", p):
                        return True
                    return False
                keep_if(is_banned)

        # 附加 14：身体朝向 × 相机方位
        if s == "身体与头部协调":
            cam = next((c for c in result if c["slot"] == "相机方位"), None)
            if cam:
                cp = nz(cam).lower()
                ban = None
                if re.search(r"from_behind|rear_three-quarter", cp):
                    ban = re.compile(r"^(body_facing_viewer|body_in_profile)")
                elif re.search(r"from_front|front_three-quarter", cp):
                    ban = re.compile(r"^(body_facing_away|body_in_profile)")
                elif re.search(r"from_side|side_view|profile_shot", cp):
                    ban = re.compile(r"^(body_facing_viewer|body_facing_away)")
                if ban:
                    keep_if(lambda w: ban.match(nz(w).lower()))

        # 附加 15：赤脚 × 袜子（避免末尾协调删空鞋子槽）
        if s == "鞋子" and eff_on("袜子"):
            pool = [w for w in pool if nz(w) != "barefoot"]

        # 附加 16（2026-10-17）：**人数必须跟已抽到的角色数一致**。
        #   实测「自由搭配 + 全槽位」800 组：55.4% 出现「3girls / 4girls 却只有 1 个角色名」——
        #   因为「人数」槽在 11 个词里均匀抽，其中 6 个是多人数。
        #   角色槽排在人数前面，这里读得到 n。
        #   ⚠️ 只约束「有几个角色就说几个人」，不改人数词本身的多样性。
        if s == "人数":
            _n = len([c for c in result if c["slot"] == "角色"])
            if _n >= 1:
                _pre = str(_n)
                _ok = {w for w in (nz(x) for x in pool) if w.startswith(_pre)}
                if _n == 1:
                    _ok |= {"1girl", "1boy", "1other", "solo"}
                elif _n == 2:
                    _ok |= {"couple", "group"}
                elif _n >= 3:
                    _ok |= {"multiple_girls", "multiple_boys", "multiple_others", "group", "crowd"}
                _keep = [w for w in pool if nz(w) in _ok]
                if _keep:
                    pool = _keep

        # ⭐ 2026-10-17 阿君拍板「彻底自由」：原来的「插画模式三条」整段删除。
        #   它做的是：① 排除 3 个特写词（注意 keep_if 的语义是「保留**不匹配**的」，
        #   所以这条其实是在**剔除** extreme_close-up / detail_shot / tight_close-up）；
        #   ② 光照 60% 概率偏向 ILLUST_LIGHT 那 31 个词；③ 景深 60% 偏向 ILLUST_DOF。
        #   ⇒ 现在插画美图跟别的档一样，从完整词池等概率抽，不再预筛。

        return pool

    # ---------- tierPoolFilter ----------

    def _tier_filter(self, s, pool, result, shot_tier, illust):
        # ⭐ 2026-10-17 阿君拍板「彻底自由，其他槽位也是」：
        #   这个函数原来是「按构图档位预先收窄词池」的地方 ——
        #   景别按 full/half/close/wide/ultra 分族加权、超远景硬剔；
        #   镜头/景深/动态效果 按档位偏向长焦或广角；相机方位同理。
        #   ⇒ 全部停用，五个槽一律从**自己的完整词池**等概率抽。
        #   仍然生效的约束只剩「真矛盾」那一类（互斥组 / 手部冲突 / 离地姿×手撑地 等），
        #   那些在 5.x 和拾取阶段处理，不在这里。
        #
        # ⛔ 2026-10-19 补：上面这条「彻底自由」连坐把景别搞坏了，实测（极简 600 次）
        #   全身只剩 13.8%、半身 39.8%、特写 40.0% ⇒ 4 张里 3 张切在膝盖以上，
        #   阿君连发 5 张图（两个不同底模）报「人物显示不完整」。
        #   而极简档**100% 都会抽到下装/袜子/鞋子**（实测 400/400），
        #   服饰词出了、画面里没有，等于白抽 + 人物被切。
        #   ⇒ 只恢复「按族加/减倍率」这一条（**不做硬剔**，族内仍然随机，
        #     免得回到 10-17 之前「骰子怎么点都在两三个词之间跳」）。
        #   倍率在 Pool.pick() 里乘到 SHOT_WEIGHTS 上，见那里的注释。
        if s == "景别" and shot_tier == "auto":
            # ⛔ 只对 auto 档生效。立绘档（mode=fullbody）是阿君 2026-10-14 亲自拍板的
            #   「不锁全身、特写/半身/全身都可能出」—— 那边保持自由，别受这条影响。
            legs_on = any(c.get("slot") in ("下装", "袜子", "鞋子", "腿部服饰")
                          for c in result)
            # 目标份额：有腿脚服饰 → 全身 45 / 半身 30 / 特写 15 / 广角+超广 8。
            # 依据：safebooru 10 万张实测「有鞋/袜的图 全身 87.1%」，
            #   这里取 45% 是**观感折中**（真按 87% 会变成「几乎每次都全身」）。
            #   想更完整调大 full、想更随机调小 full —— 只改下面这两个 dict。
            # ⚠️ 挂在 `self.pool` 上（不是 self）—— 真正乘倍率的地方是 `Pool.pick()`。
            #
            # ⛔ 2026-10-19 第五轮（按 danbooru 真实 post 数重排 SHOT_WEIGHTS 之后）：
            #   真实词的基础权重从「full 12 / upper 10 / cowboy 8 / 12 个假词各 2~8」
            #   变成了「full 12 / upper 10 / cowboy 10 / close-up 6 / wide 4 + 假词合计 3.4」
            #   —— 真实词自己就撑到 93%，原来的 full×3.75 一叠就飙到 **65.7%**（实测），
            #   三分之二都是全身，反而单调。所以倍率整体收敛成下面这组（实测 full 46%）。
            self.pool._shot_bias = ({"full": 2.0, "half": 0.8, "close": 1.0,
                                     "wide": 1.0, "ultra": 1.0}
                                    if legs_on else
                                    {"full": 1.6, "half": 0.9, "close": 1.0,
                                     "wide": 1.0, "ultra": 1.0})
        return pool

    def _tier_filter_legacy(self, s, pool, result, shot_tier, illust):
        if s not in ("相机方位", "镜头", "景深", "景别", "动态效果"):
            return pool
        eff = shot_tier
        if eff == "auto":
            has = lambda words: any(tok_match(nz(c), words) for c in result)
            if has(SHOT_CLOSE):
                eff = "closeup"
            elif has(SHOT_FULL):
                eff = "fullbody"
            elif has(SHOT_WIDE) or has(WIDE_HARD):
                eff = "wide"
            else:
                eff = "auto"
        forbid = None
        if eff == "closeup":
            forbid = SHOT_FULL + SHOT_WIDE + WIDE_HARD
        elif eff == "fullbody":
            forbid = SHOT_WIDE + WIDE_HARD
        elif eff == "wide":
            forbid = SHOT_CLOSE + ["telephoto", "telephoto_lens", "macro", "bokeh"]

        def drop(a):
            if not forbid:
                return a
            kept = [w for w in a if not any(tok_match(nz(w), [f]) for f in forbid)]
            return kept if kept else a

        if shot_tier != "auto" and s == "景别":
            # 2026-10-14 阿君拍板：立绘档（原「全身立绘」）景别槽**不锁全身**，全池随机
            # （特写/半身/全身都可能出）。立绘不拘泥于全身构图。
            if shot_tier == "fullbody":
                return pool
            tw = {"closeup": SHOT_CLOSE, "fullbody": SHOT_FULL, "wide": SHOT_WIDE,
                  "action": SHOT_ACTION}.get(shot_tier, SHOT_ACTION)
            tier_pool = [w for w in pool if any(t in nz(w) for t in tw)]
            if not tier_pool:
                return pool
            allw = SHOT_CLOSE + SHOT_FULL + SHOT_WIDE + SHOT_ACTION
            # 2026-09-30：fullbody(全身立绘) 与 wide(场景大图) 都要求人物完整入画，
            # 半身景别不算中性词，否则会抽到它 ⇒ 人物被切。
            # 用户实证：全身立绘 26/30、场景大图 23/30 抽到的都是半身景别。
            if shot_tier in ("fullbody", "wide"):
                allw = allw + SHOT_HALF
            neutral = [w for w in pool if not any(t in nz(w) for t in allw)]
            merged = tier_pool + neutral
            return merged if merged else pool
        # 2026-09-30：auto 档（极简日常/插画美图/物件随搭/自由搭配）原来对景别完全不管。
        #   ① 超远景 → 人物缩到只剩腿（W_极简日常_14 = establishing shot）
        #   ② 特写/半身，而下装/袜子/鞋子槽都出了词 ⇒ 腿脚服饰全被切（N_极简日常_01/06/10）
        #
        # ⛔ 2026-10-17 重写（阿君报「极简日常景别用骰子一直只出远景/全身，随不到别的」）：
        #   原版是**硬剔**：开了下装/袜/鞋就把「特写+半身」全砍，再砍「超远景」
        #   ⇒ 18 个景别只剩 full_body + wide_shot 两个，骰子怎么点都在两点之间跳。
        #   safebooru 10 万张实测的真实分布说明原版**尺度错了**：
        #     · 有鞋/袜的图：全身 87.1% / 半身 8.7% / 特写 3.1% / 广角远景 1.1%
        #     · 全体女性图 ：特写 44.3% / 全身 37.5% / 半身 17.2% / 广角远景 1.0%
        #   ⇒ ① 按「族」加权，而不是硬砍：全身占多数（服装看得见），其余留出合理份额；
        #     ② 只保留「超远景」的硬剔除（实测仅 1%，且人物会缩成一条腿）。
        #   ⚠️ 用「先按权重挑族、再在族内随机」实现加权，**不用重复词条** ——
        #      景别数量>1 时会抽到同一个词两次（重复词条会让概率不可控）。
        if shot_tier == "auto" and s == "景别":
            legs_on = any(c["slot"] in ("下装", "袜子", "鞋子", "腿部服饰") for c in result)
            # 目标份额（族级）。
            # 2026-10-17 三次调：45% → **30%**。阿君连问三次「只出那两三个」——
            #   45% 的情况下连点 5 次会有 2~3 次是全身，观感就是「没随机性」。
            #   现在 30%：14 个词里每个都抽得到，全身仍是单字最高频，但不再压倒。
            #   ⚠️ 这是**观感权衡**，不是真实分布（真实有鞋袜的图 87% 是全身）。
            #   想更贴近真实/更极端均匀，改这四个数即可。
            target = {"full": 30, "half": 42, "close": 21, "wide": 7}
            fams = {}
            for w in pool:
                f = _shot_family(nz(w))
                if f == "ultra" or f is None:
                    continue
                fams.setdefault(f, []).append(w)
            keys = [k for k in target if k in fams]
            if not keys:
                return pool
            tot = float(sum(target[k] for k in keys))
            r = self.rng.random() * tot
            acc, chosen = 0.0, keys[-1]
            for k in keys:
                acc += target[k]
                if r <= acc:
                    chosen = k
                    break
            return fams[chosen]
        if s in ("镜头", "景深", "动态效果"):
            kw = (["telephoto", "lens_focus", "bokeh", "depth_of_field", "macro", "zoom", "lens_flare"]
                  if shot_tier == "closeup" else
                  ["fisheye", "wide_angle", "wide-angle", "zoom", "panorama"] if shot_tier == "wide" else
                  ["zoom", "zoom_lens", "zooming_in", "zooming_out", "depth_of_field"] if shot_tier == "action" else None)
            base = pool
            if kw:
                tp = [w for w in pool if any(k in str(w["prompt"] or "") for k in kw)]
                if len(tp) >= 3 and self.rng.random() < 0.5:
                    base = tp
            return drop(base)
        if s == "相机方位":
            return drop(pool)
        return pool

    # ---------- 人物特征 ----------

    def _with_series(self, p, base):
        return self.db._with_series(p, base)

    def _traits_for(self, prompt):
        return self.db.traits_for(prompt)

    # ---------- 末尾跨槽协调 ----------

    def _cross_coordinate(self, result, shot_tier):
        lockp = getattr(self, "_lockp", None) or set()
        wiped = {}          # ⭐ 2026-10-07：slot -> 被本轮协调删掉的词（末尾据此补位）

        def rm(pred):
            for i in range(len(result) - 1, -1, -1):
                c = result[i]
                # 锁定的词永不删（2026-10-05，对齐网页 removeWhere 的 !locked 分支）
                if c.get("prompt") in lockp or nz(c) in lockp:
                    continue
                if pred(c, i):
                    wiped.setdefault(c["slot"], []).append(c["prompt"])
                    result.pop(i)

        has = lambda words: any(tok_match(nz(c), words) for c in result)

        # 5.1 景别纠正
        tier = shot_tier
        if tier == "auto":
            tier = ("closeup" if has(SHOT_CLOSE) else
                    "fullbody" if has(SHOT_FULL) else
                    "wide" if (has(SHOT_WIDE) or has(WIDE_HARD)) else "medium")
        # ⭐ 2026-10-07：把「景别纠正」的作用范围**限定在景别相关槽**。
        #    原来只排除「人数」= 全槽扫 ⇒ 按词根匹配会误伤别的槽（全池扫描实测）：
        #      · `fantasy landscape`(场景)    ← 命中 landscape
        #      · `portrait_(object)`(道具)     ← 命中 portrait
        #      · `full-length_mirror`(道具) / `full-length_zipper`(装饰与材质) ← 命中 full-length
        #    ⇒ closeup 档误伤 3 槽 3 词、wide 档误伤 2 槽 2 词。
        #    「景深」保留在范围内：wide 档剔 bokeh 是**有意**的（大景别要看清场景）。
        # 2026-10-17 阿君拍板「彻底自由」：景别不再参与末尾纠正 ——
        #   去掉「景别」后，这里只纠正 构图/镜头/相机方位/景深 之间的真矛盾
        #   （比如「特写」+ 长焦/微距 是合理的，但 全景构图 + 长焦 会打架）。
        SHOT_SLOTS = {"构图", "镜头", "相机方位", "景深"}
        fx = lambda c: any(w in nz(c) for w in FACIAL_FX)
        if tier == "closeup":
            rm(lambda c, i: c["slot"] in SHOT_SLOTS and not fx(c) and (
                any(tok_match(nz(c), [w]) for w in SHOT_FULL + SHOT_WIDE + WIDE_HARD)))
        elif tier == "fullbody":
            # 2026-10-14 阿君拍板：立绘档（原「全身立绘」）景别**不再剔除**——
            # 立绘不拘泥全身构图，特写/半身/广角景别都放行，让景别真正随机。
            pass
        elif tier == "wide":
            # 2026-09-30 补：大景档同样不许出现半身景别，否则人物占满画面、场景没了
            rm(lambda c, i: c["slot"] in SHOT_SLOTS and not fx(c) and (
                any(tok_match(nz(c), [w]) for w in SHOT_CLOSE + ["telephoto", "telephoto_lens", "macro", "bokeh"]) or
                any(w in nz(c) for w in SHOT_HALF)))

        # 5.2 俯仰互斥（留后出现那个）
        up = [i for i, c in enumerate(result) if any(tok_match(nz(c), [w]) for w in TILT_UP)]
        dn = [i for i, c in enumerate(result) if any(tok_match(nz(c), [w]) for w in TILT_DOWN)]
        if up and dn:
            keep_i = max(up[0], dn[0])
            rm(lambda c, i: i != keep_i and (
                any(tok_match(nz(c), [w]) for w in TILT_UP + TILT_DOWN)))

        # 5.3 场景多场所去重
        scene_items = [c for c in result if c["slot"] == "场景"]
        places = [c for c in scene_items if PLACE_RE.search(nz(c))]
        if len(places) > 1:
            first = places[0]["prompt"]
            rm(lambda c, i: c["slot"] == "场景" and c["prompt"] != first
               and any(q["prompt"] == c["prompt"] for q in places))

        # 5.4 赤脚 × 鞋袜
        bare = any(nz(c) == "barefoot" for c in result)
        foot = any(FOOTWEAR_RE.search(nz(c)) for c in result)
        if bare and foot:
            rm(lambda c, i: nz(c) == "barefoot")
        if bare and not foot:
            pass

        # 5.4c 姿势 × 鞋子（2026-11-24 用户口径）
        #   只有「站立类姿势」且「人踩在地面上」才保留鞋子；坐 / 躺 / 跪 / 蹲 /
        #   浮空 / 下落 / 跳跃 / 游泳 → 鞋子槽一律清空。
        #   · 裸脚的补位**不在这里做**（见函数末尾 5.12）：本段之后还有若干协调会删「袜子」
        #     （露裆规避 / 景别纠正等），若按当时状态判断「有袜子就不补裸脚」，
        #     会出现「鞋删了、袜子随后也被删、最终脚部什么状态都没有」。
        #   · 没有「基础姿势」槽（用户关掉了）时不介入，避免无姿势信息时误删。
        _pose_it = next((c for c in result if c["slot"] == "基础姿势"), None)
        if _pose_it is not None:
            _pv = nz(_pose_it).lower()
            _off_ground = any(k in _pv for k in OFF_GROUND_POSE) or any(
                k in _pv for k in ("jumping", "midair", "in_air", "airborne",
                                   "flying", "swimming", "underwater"))
            _is_stand = any(k in _pv for k in STAND_POSE)
            if not (_is_stand and not _off_ground):
                rm(lambda c, i: c["slot"] == "鞋子")
                # ⛔ 必须把「鞋子」从 wiped 里摘掉：函数末尾 _refill_wiped() 会把删空的槽
                #    从池里补回来（实测 sitting 被补成 black_shoes，等于白删）。
                wiped.pop("鞋子", None)

        # 5.4b 车内 × 踮脚（2026-09-30）
        # 场景是「车厢内/列车内」时脚下没有可站立的地面，再叠加 tiptoes 会画出
        # 悬浮/扭曲的姿势（N_插画美图_10 = vehicle interior + tiptoes + from behind 实证）
        if any(nz(c) in VEHICLE_INTERIOR for c in scene_items):
            rm(lambda c, i: c["slot"] == "基础姿势" and nz(c) == "tiptoes")

        # 5.5 场景-光照联动（室内/夜间 → 剔日光）
        scene_txt = " ".join(nz(c) for c in scene_items)
        if any(w in scene_txt for w in INDOOR_WORDS) or any(w in scene_txt for w in NIGHT_WORDS):
            rm(lambda c, i: c["slot"] == "光照" and any(w in nz(c) for w in DAYLIGHT_WORDS))

        # 5.6 露裆规避
        # ⚠️ 网页版有「用户锁定」分支（锁定姿势就改剔露腿服装）；ComfyUI 版没有锁定功能，
        #    所以直接走「剔高危姿势」这一支。用统一的 rm() 倒序删，避免手写双循环时索引失效。
        proms = [nz(c) for c in result]
        has_bottom = any(any(k in p for k in SAFE_BOTTOMS) for p in proms)
        if not has_bottom:
            # ⭐ 2026-10-07 修：原来直接 rm() 把「基础姿势」的危险词**整个吞掉**，
            #    姿势约束一丢，模型就自由发挥。实证：catwoman_00085 抽到 `wide stance`
            #    被这条删掉 ⇒ 出图画成蹲姿、多出一只脚；00086 的 `knees apart` 同样被吞。
            #    实测 1500 组「全身立绘」：**8.9% 的组合会丢姿势词**（dress 5.9% / sep 3.0%）。
            #    ⇒ 改成「删掉危险词之后，从安全姿势词里补一个」，防走光的意图不变，
            #      但姿势约束不再丢失。（安全词 = 池里不命中 CROTCH_POSES 的那些）
            # ⚠️ 变量名别叫 wiped —— 那是 _cross_coordinate 开头给「通用补位」用的 dict，
            #    同名会被这里的 list 覆盖掉（2026-10-07 踩过：AttributeError list has no items）
            gone_pose = [c for c in result
                         if c["slot"] == "基础姿势" and any(k in nz(c) for k in CROTCH_POSES)]
            rm(lambda c, i: any(k in nz(c) for k in CROTCH_POSES))
            if gone_pose and not any(c["slot"] == "基础姿势" for c in result):
                used = {c["prompt"] for c in result}
                safe_pool = [w for w in self.pool.slot_list("基础姿势")
                             if w["prompt"] not in used
                             and w["prompt"] not in self.black
                             and not any(k in nz(w) for k in CROTCH_POSES)]
                if safe_pool:
                    _w = self.pool.pick(safe_pool, self.rng, slot="基础姿势")
                    result.append({"prompt": _w["prompt"], "name": _w["name"],
                                   "slot": "基础姿势", "g": _w.get("g")})

        # 5.7 表情协调
        emo = [c for c in result if c["slot"] == "表情"]
        if len(emo) > 1:
            def gi_of(c):
                n = nz(c)
                for k, grp in enumerate(EMO_GROUPS):
                    if any(w in n for w in grp):
                        return k
                return -1
            base = -1
            for c in emo:
                g = gi_of(c)
                if g in (0, 1):
                    base = g
                    break
            if base >= 0:
                conflict = 1 if base == 0 else 0
                rm(lambda c, i: c["slot"] == "表情" and gi_of(c) == conflict)

        # 5.8 低位姿态 × 踢击
        is_low = lambda c, i=None: c["slot"] in POSE_AREA and any(w in nz(c) for w in LOW_POSE)
        is_kick = lambda c, i=None: c["slot"] in POSE_AREA and "kick" in nz(c)
        if any(is_low(c) for c in result) and any(is_kick(c) for c in result):
            rm(is_kick)

        # 5.9 站姿 × 跪坐腿姿
        is_kneel = lambda c, i=None: c["slot"] == "基础姿势" and any(w in nz(c) for w in LEG_KNEEL)
        is_stand = lambda c, i=None: c["slot"] in ("基础姿势", "动作") and any(w in nz(c) for w in STAND_POSE)
        # ⛔ 2026-10-07 修：同一个词可能**同时**命中两张表 —— `crossed legs while standing`
        #    既含 LEG_KNEEL 的 "crossed_legs"、又含 STAND_POSE 的 "standing"，
        #    于是两个 any() 都成立、它把自己当"跪坐"删掉了（实测占姿势池 1/63 ≈ 1.6%，
        #    正是抽样里剩下那 1.5% 的来源）。要求 kneel 词**不是站姿词**才参与互斥。
        _kneel_only = lambda c, i=None: is_kneel(c) and not is_stand(c)
        if any(_kneel_only(c) for c in result) and any(is_stand(c) for c in result):
            rm(_kneel_only)

        # 5.10 同词去重
        #   ⚠️ 2026-10-18（阿君报「第二个赛马娘没马耳马尾」）：原来**只按词**去重、且从后往前扫，
        #   同名词留**最后**一个。两个赛马娘特征完全相同时，第 1 个人的 3 个词就是这么被删掉的。
        #   改成按 (词, who) 去重：同一人内部不重复，但"两个人都长马耳"允许各出现一次。
        seen = set()
        for i in range(len(result) - 1, -1, -1):
            c = result[i]
            key = (c["prompt"], c.get("who"))
            if key in seen:
                result.pop(i)
            else:
                seen.add(key)

        # 5.11 离地姿 × 手撑地（2026-10-16 阿君截图：sitting_on_table × hands_on_floor）
        #   人坐在桌上/椅上/台阶上、浮空、下落时，手是够不到地面的 —— 硬物理矛盾。
        #   处理：剔掉「手撑地」那一侧（姿势定整体构图，保留；手部词只是细节，删了会补位）。
        _offg = lambda c, i=None: c["slot"] == "基础姿势" and nz(c) in OFF_GROUND_POSE
        _floorh = lambda c, i=None: c["slot"] == "手臂与手势" and nz(c) in FLOOR_HANDS
        if any(_offg(c) for c in result) and any(_floorh(c) for c in result):
            rm(_floorh)
            # ⚠️ 补位时不能再捞回**另一个**「手撑地」写法（池里 ground / floor 两个变体，
            #    删掉 hand_on_floor 后若不挡住，补位会把 hands_on_ground 抽回来 = 白改）。
            wiped.setdefault("手臂与手势", []).extend(sorted(FLOOR_HANDS))

        # ⭐ 2026-10-07 补位：**上面的 rm 可能把某个槽整个删空**（删了不补 = 约束丢失）。
        #    实测 5 档 × 400 组：光照 1.2% / 构图 0.9% / 场景 0.3% / 景别 0.1% 会被删空：
        #      · 光照 ← 5.5 室内/夜间 → 剔日光（sunlight / sunlight_rays / dappled_sunlight）
        #      · 构图 ← 5.1 fullbody 剔 panoramic composition
        #      · 场景 ← 5.1 **误伤**：fantasy landscape 命中 SHOT_WIDE/WIDE_HARD 的 landscape
        #      · 景别 ← 5.1 各档互剔
        #    凡是「本来有词、被本轮删光」的槽，从池里补一个**没被本轮删过**的安全词。
        self._refill_wiped(result, wiped, shot_tier)

        # 5.12 脚部收尾（2026-11-24 用户口径：非站立 → 裸脚；裸脚是允许状态）
        #   放在 _refill_wiped 之后，此时所有删词逻辑（露裆规避 / 景别 / 袜子冲突）都跑完了，
        #   再按最终状态判断，避免 5.4c 里「当时有袜子」→ 不补裸脚 → 袜子随后被删 → 脚部空。
        #   规则：只要最终既无鞋也无袜，补一个 barefoot。**不区分站姿** —— 用户明确
        #   「可以有裸脚」，站姿抽到空鞋槽时也应该是赤脚，而不是脚部啥都没有。
        _pz = next((c for c in result if c["slot"] == "基础姿势"), None)
        if _pz is not None:
            # ⛔ 判断「有没有袜子」必须排除 _BAREFOOT 那组词（barefoot / bare_feet /
            #    bare_legs / toeless_legwear）：gen() 后面的「裸足 × 袜」过滤会把它们
            #    从袜子槽里删掉。把 toeless_legwear 当成"穿着袜子" → 不补裸脚 →
            #    随后它被删 → 最终脚部什么状态都没有（实测 seed=20159）。
            _fake_sock = {"barefoot", "bare_feet", "bare_legs", "toeless_legwear"}
            _real_sock = [c for c in result if c["slot"] == "袜子"
                          and nz(c["prompt"]) not in _fake_sock]
            if not any(c["slot"] == "鞋子" for c in result) and not _real_sock:
                result.append({"prompt": "barefoot", "name": "赤脚",
                               "slot": "鞋子", "g": ""})

    def _refill_wiped(self, result, wiped, shot_tier="auto"):
        """把被末尾协调删空的槽补回来。
           ⚠️ 只补「原本有词、被删光」的槽 —— 本来就没出词的槽（如 50% 概率的手持物）不动，
           否则会改变既有行为。补的词从池里取，排除：已用 / 本轮被删过的 / 黑名单 / 锁定。"""
        lockp = getattr(self, "_lockp", None) or set()
        for slot, gone in wiped.items():
            if any(c["slot"] == slot for c in result):
                continue                       # 该槽还有别的词，不用补
            used = {c["prompt"] for c in result}
            banned = set(gone)
            # ⛔ 2026-10-17：补位必须**避让已占用的互斥组**。
            #   原来只查「词没重复」，不查组 —— 实测会补出「striped_pants + hakama_skirt」
            #   这种同属 g_lowerall 的矛盾搭配（网页端 1200 组撞了 1 次）。
            #   宁可不补（该槽空着），也不能补出一个矛盾词。
            used_groups = {c.get("g") for c in result if c.get("g")}
            cand = [w for w in self.pool.slot_list(slot)
                    if w["prompt"] not in used
                    and w["prompt"] not in banned
                    and w["prompt"] not in self.black
                    and w["prompt"] not in lockp
                    and (not w.get("g") or w["g"] not in used_groups)]
            # ⛔ 2026-10-17：补位也得过一遍 tierPoolFilter。
            #   「景别」在 auto 档会剔掉全部超远景，但补位用的是**原始池** ——
            #   实测极简日常 500 组里仍漏出 establishing / long shot / medium wide 各 1 次，
            #   等于把刚剔掉的词又捞回来。这里只对景别收紧，其它槽行为不变。
            if slot == "景别" and cand:
                try:
                    tf = self._tier_filter(slot, cand, result, shot_tier, False)
                    if tf:
                        cand = tf
                except Exception:
                    pass
            if cand:
                w = self.pool.pick(cand, self.rng, slot=slot)
                result.append({"prompt": w["prompt"], "name": w["name"],
                               "slot": slot, "g": w.get("g")})


# ===== 输出格式化 =====

def fmt_tag(t, space_out=True):
    """⚠️ Anima 系要求：小写 + 空格代替下划线，**但 score 标签是唯一例外**"""
    if not space_out:
        return t
    if re.match(r"^score_\d", t):
        return t
    return t.replace("_", " ")


def esc_tag(t):
    """给标签**自带**的字面括号加反斜杠转义。

    为什么必须转义：ComfyUI / WebUI 的提示词解析器把裸 `(xxx)` 当成加权 ×1.1、
    `(xxx:1.3)` 当成指定权重。字典里 30.38% 的标签自带括号（角色 56,204 / 画师 29,741），
    不转义的话 `ruu (tksymkw)` 会被读成 ruu + tksymkw×1.1，整条标签直接歪掉。
    转义成 `ruu \\(tksymkw\\)` 才是原义。
    """
    if not t or ("(" not in t and ")" not in t):
        return t
    return t.replace("(", "\\(").replace(")", "\\)")


def fmt_word(prompt, slot, space_out=True, anima=False):
    """单个词的输出形态 —— fmt_prompt 和 server 的 tags[].out 都走这里，
    保证「整句拼接」和「面板逐词条显示」两处写法一致。

    2026-10-17 拆分职责：
      ① **括号转义 → 永远开**（跟模型无关，是正确性问题）：
         ComfyUI/WebUI 把裸 `(xxx)` 当加权 ×1.1，字典里 30.38% 的词自带括号，
         不转义 `ruu (tksymkw)` 会被读成 ruu + tksymkw×1.1，整条标签就歪了。
      ② **@ 画师前缀 → 仍由 anima 开关控制**：只有 Anima 系要 @，Illustrious/Pony 裸写。
    ⚠️ 用户手输的词（slot 为空或「自定」）**不转义**：他可能本来就想写 (chibi:2) 加权。

    2026-10-19 新增 ③ **用户设的提示词权重** → 包成 `(tag:1.5)`。
       ⚠️ 必须放在转义**之后**（见 wrap_prompt_weight 的说明）。
       ⚠️ 只作用于抽出来的词（有 slot）；手输词自己不转义，也就别替他包括号。
    """
    p = fmt_tag(prompt, space_out)
    if slot and slot != "自定":
        p = esc_tag(p)
    if anima and slot == "画师" and p and not p.startswith("@"):
        p = "@" + p
    if slot and slot != "自定":
        p = wrap_prompt_weight(p, prompt_weight_of(prompt))
    return p


# 输出标签顺序 —— 2026-10-17 起**默认就按这个排**（不再只限 Anima 模式）。
#   四份独立来源一致：质量·年代·安全 → 人数 → 角色名 → 作品名 → 画师 → 普通标签
#   质量前缀由 quality 单独拼在最前；未在表里的槽一律排最后，保持原相对顺序（sort 稳定）。
#   ⚠️ 自动补作品标签（auto_copyright）落的是「作品」槽；字典里另有「版权」槽，两个都排进表里。
# 2026-10-17：改名 + **默认就排**。以前只在 anima=True 时排，默认模式仍是
#   「画师最前、人数在角色后」—— 那是 SDXL 的老习惯，跟现在动漫底模的训练顺序相反。
#   四份独立来源（Anima 官方模型卡 / Moescape ×2 / Xotic / 模型横评）一致给出：
#     质量·年代·安全 → 人数 → 角色名 → 作品名 → 画师 → 外貌/服装/动作/场景…
#   2026-10-17 补：人物特征 / 发色 / 发型 / 眼睛 紧跟角色与风格 —— 真实提示词里
#   这些外观词就在角色名后面、服装前面（实测高分图 97.4% 把发色写在角色旁）。
# 多人时「每个人各自一份」的槽（2026-10-17）：表情/服装/配饰/外观。
# 场景、光照、构图、镜头、景深、景别、双人互动 这些是**两人共用**的，不在此列。
# 非人类 / 群体型「角色」标签（2026-10-17 阿君报「无垢巨人」后加）。
# 判定只看**本体名**：把结尾的 (系列)/(形态) 括号全剥掉再比，
#   否则 `ymir_(shingeki_no_kyojin)` 会被系列名里的 kyojin 误伤。
_NONPERSON_BASE = re.compile(
    r"^(titan|monster|creature|beast|dragon|mecha|robot|android|golem|zombie"
    r"|skeleton|ghost|spirit|colossus|kaiju|statue|doll|puppet"
    # 2026-10-18（阿君：哆啦A梦不属于人）：吉祥物/非人角色单独列一份。
    # 这些大多是 `xxx_(character)` 形式，但 `(character)` 里也混着人形角色，
    # 所以不能按后缀一刀切，只能点名。
    r"|doraemon|hello_kitty|kitty_white|garfield|anpanman|miffy|pikachu|snoopy"
    r"|gekota|temmie_chang|curakuru|totoro|jiji|keroppi|gudetama|cinnamoroll"
    r"|pompompurin|kuromi|my_melody|badtz-maru|predator|deemo|binchou-tan)$")
_NONPERSON_GROUP = re.compile(
    r"_(crew|squad|corps|team|army|fleet|troops|platoon|unit|sect|clan)$")


# 精确点名：整条标签本身就是机体/动物，但**同名**另有正经角色（不能按名字一刀切）。
# 例：`leopard_(yatterman)` 是小双侠里的机体レオパルドン，而 `leopard_(kemono_friends)` 是兽娘。
_NONPERSON_EXACT = {
    "leopard_(yatterman)",                      # 2026-10-18 阿君问「多罗龙是谁」
    # 2026-10-18 阿君：恶魔本体不是人形 —— 从「永久封禁」改为「归入非人池」
    "war_devil_(chainsaw_man)",
    "bomb_devil_(chainsaw_man)",
    "pochita_(chainsaw_man)",
    "bucky_(chainsaw_man)",
    # 2026-10-19 阿君报「奇怪龙在人类女性池里」后扩查：
    #   怪物猎人里中文名**不带物种字**的那几个怪物，`_is_species_char` 抓不到，单独点名。
    #   （带物种字的如「迅龙」「牙猎犬」「妃蜘蛛」「化鲛」已由中文名规则覆盖）
    "kirin_(monster_hunter)",                   # 麒麟（古龙，马形）
    "diablos", "black_diablos",                 # 角龙（迪亚波罗 / 黑角龙）
    "melynx",                                   # 梅拉露（艾露猫的野生种）
    "moofah",                                   # 哞法（羊形草食兽）
    "nu_udra",                                  # 努·乌德拉（甲虫种）
    "cha-cha", "cha-cha_(monster_hunter)",      # 恰恰（奇面族随从）
    "kayamba",                                  # 卡扬巴（奇面族随从）
    "nekoht",                                   # 猫人
    # 2026-10-20 阿君问「这个小鲑鱼是人类吗」后扩查：
    #   《斯普拉遁》里混着一批**真·生物**（鲑鱼 / 水母 / 小丑鱼 / 猫 / 鬼蝠魟），
    #   全被标成 s='f' 躺在女性角色池里。但同一个 IP 的鱿鱼人、章鱼娘、
    #   章鱼男孩都是正经人形 —— **不能按 IP 一刀切**，只能逐个点名。
    #   ⚠️ 别用「中文名带鱼/猫」去自动判：犬走椛、兔田佩克拉、小鸟游星野
    #      这些真人会被整片误伤（实测 1357 条）。人工点名最稳。
    "smallfry_(splatoon)",                      # 小鲑鱼（鲑鱼幼体，玩家的跟班）
    "big_man_(splatoon)",                       # 曼塔鲁（鬼蝠魟）
    "jellyfish_(splatoon)",                     # 水母
    "harmony's_clownfish_(splatoon)",           # 法子的小丑鱼
    "judd_(splatoon)",                          # 贾杰（裁判猫）
    "zapfish",                                  # 电池鲶鱼
    "chum_(splatoon)",                          # 鲑鱼
    "surume_(splatoon)",                        # 鱿鱼干
    "stinger_(splatoon)",                       # 塔台鱼
    "cohock_(splatoon)",                        # 大胖鱼
    "steelhead_(splatoon)",                     # 炸弹鱼
    "big_shot_(splatoon)",                      # 铁球鱼
    "flyfish_(splatoon)",                       # 垫肩飞鱼
    "maws_(splatoon)",                          # 鼹鼠鱼
    "steel_eel_(splatoon)",                     # 蛇鱼
    "super_sea_snail",                          # 超级海螺
    "scrapper_(splatoon)",                      # 铁板鱼
    "fish_stick_(splatoon)",                    # 柱鱼
    "drizzler_(splatoon)",                      # 铁球鲑鱼
    "slammin'_lid_(splatoon)",                  # 锅盖鱼
    "griller_(splatoon)",                       # 烤架鱼
    "goldie_(splatoon)",                        # 金鲑鱼
    "flipper-flopper_(splatoon)",               # 潜水鱼
    "mudmouth_(splatoon)",                      # 泥鲑鱼
    "takotruck_(splatoon)",                     # 章鱼卡车
    # 2026-10-20 阿君：查「杰顿（奥特曼）是不是混进女性池了」—— 是。
    #   奥特曼系的**怪兽**和**光之巨人**都被标成 s='f' 躺在女性池里
    #   （danbooru 里它们常和女角色同图）。这里逐个点名，别按 IP 一刀切 ——
    #   同系列还有人形角色（如 短剑/机甲少女 stylet）要保持原样。
    "zetton",                                   # 杰顿（怪兽）
    "zetton_(shin)",                            # 杰顿（新·奥特曼）
    "eleking",                                  # 艾雷王（怪兽）
    "gomora",                                   # 哥莫拉（怪兽）
    "ultraseven",                               # 赛文奥特曼（光之巨人，不是人）
    "ultraman_tarou",                           # 泰罗奥特曼
    "ultraman_mebius",                          # 梦比优斯奥特曼
}

# 「泛型怪物/器械」按**本体名**判（剥掉系列括号后整词匹配）。
# ⚠️ 绝不能直接对整串做子串匹配 —— 实测会误伤 `sandrone`（名字里有 drone，
#   真人是愚人众）、`specter`（明日方舟干员）、`uzi_(murder_drones)` 等正经角色。
# 2026-10-18（阿君：动物/兽人/机甲都放进非人池）：
#   这些 IP 下的「单词名」角色基本是物种/机体本体（pikachu / agumon / gundam），
#   多词名基本是人类训练家（ash_ketchum / kamille_bidan），所以只收单词名。
_NONHUMAN_IP = {
    "pokemon", "digimon", "gundam", "transformers", "godzilla", "zoids", "medabots",
    "beyblade", "my_little_pony", "sanrio", "peanuts", "disney", "sonic_the_hedgehog",
    "monster_hunter", "yu-gi-oh!",
}

# 中文名里带这些标记的（"皮卡丘（宝可梦）"）也算物种/机体 —— 词典里多数物种没有
# char→series 映射，只能靠名字认。配合「单词名」条件使用，避免人类训练家混进来。
_NONHUMAN_NAME_MARK = ("（宝可梦）", "（数码宝贝）", "（高达）", "（变形金刚）",
                       "（哥斯拉）", "（三丽鸥）", "（花生漫画）", "（刺猬索尼克）",
                       "（迪士尼）", "（索斯机械兽）")

_NONPERSON_MONSTER = re.compile(
    r"^(slime|hilichurl|abyss_mage|blubberbeast|kuuhenki|king_slime|metal_slime"
    r"|healslime|bubble_slime|she-slime|half_slime-chan"
    r"|(pyro|hydro|anemo|electro|dendro|cryo|geo|mutant_electro)_slime"
    # 2026-10-18 阿君点名：匿叶龙 / 鳍游龙（.saurus 系列）、兔兔伯爵（安柏的玩偶炸弹）
    r"|qucusaurus|tepetlisaurus|yumkasaurus|koholasaurus|tatsurisaurus|baron_bunny)$")


# ===== 物种向 IP（2026-10-19 阿君报「奇怪龙在人类女性池里」）=====
#   这些作品里的「角色」绝大多数是怪物/生物本体，**中文名带物种字就不是人**。
#   只列几乎清一色是物种的作品 —— pokemon / gundam / yu-gi-oh! 里人类太多，
#   绝不能进这张表（否则小智、卡缪、阿图姆会被踢出人类池）。
#   ⚠️ 这是「人类池排除」用的，和下面 `_NONHUMAN_IP`（非人池补充）是两套判据。
_SPECIES_IP_MARK = ("（怪物猎人）", "（怪物猎人系列）", "（怪物猎人物语2）",
                    "（怪物猎人_骑士）", "（哥斯拉）", "（哥斯拉系列）",
                    "（哥斯拉_奇点）")

# 中文名里的物种字。命中即「本体不是人」。
# ⚠️ 别加「怪」——「怪盗」「怪医」都是人；「人鱼龙」要能命中，所以「人」也不能当排除词。
_SPECIES_CN_WORDS = ("龙", "兽", "鸟", "猫", "犬", "蟹", "蛛", "虫", "鲛", "狮", "熊",
                     "兔", "猪", "蛙", "马", "狼", "虎", "鱼", "蛇", "龟", "蛾", "蜂",
                     "螳螂", "鲨", "鲸", "猿", "猴", "鳄", "犀", "鼠", "鹰", "蝠",
                     "哥斯拉", "怪兽", "怪物", "史莱姆", "巨人")

# 中文名里的人形词：带这些就不是「本体」，是拟人角色或人类 NPC。
# 例：猫娘（meowstress）、公会看板娘、加工屋的女儿、格蕾酱 —— 一律留人类池。
_HUMANOID_CN = ("娘", "姬", "女", "猎人", "骑士", "看板", "博士", "调查员", "主角",
                "女儿", "少年", "少女", "男孩", "女孩", "酱", "桑")


def _ip_key(v):
    """char→series 的值剥掉结尾 (…) 后的小写，用于和 `_NONHUMAN_IP` 比。

    ⚠️ 2026-10-19 真 bug：词典里存的是 `monster_hunter_(series)`，
       而 `_NONHUMAN_IP` 写的是 `monster_hunter` —— 原样比永远不相等，
       **monster_hunter / godzilla / peanuts / sonic 四个 IP 从加上那天起就没生效过**
       （khezu 就是因此漏进女性池）。这和 10-18 那个「键名带空格」是同一种坑。
    """
    s = str(v or "").replace(" ", "_").lower()
    prev = None
    while prev != s:
        prev = s
        s = re.sub(r"_\([^()]*\)$", "", s)
    return s


def _is_species_char(cn):
    """中文名是不是「物种本体」（奇怪龙 / 迅龙 / 牙猎犬 / 雌火龙）。

    ⚠️ 双条件，缺一不可：
       · 只看物种字 → 误伤「龙崎」「马修」这类普通人名
       · 只看 IP     → 误伤火芽 / 水芸 / 菲奥莱娜（怪物猎人里的正经人类 NPC）
    ⚠️ 查人形词之前必须先把 IP 标记抹掉 —— 「（怪物猎人）」里的**「猎人」**
       本身就命中 `_HUMANOID_CN`，不先抹掉会把整条规则自己废掉（第一版就踩了）。
    """
    s = str(cn or "")
    marks = [m for m in _SPECIES_IP_MARK if m in s]
    if not marks:
        return False
    for m in marks:                       # 去掉「（怪物猎人）」→ 别让「猎人」「骑士」自伤
        s = s.replace(m, "")
    if any(m in s for m in _HUMANOID_CN):
        return False
    return any(w in s for w in _SPECIES_CN_WORDS)


# 物种向 IP 里**确实是人类**的单词名 —— 用来挡住「单词名 + IP」那条粗规则。
# 例：hinoa=火芽 / minoto=水芸 是怪物猎人 Rise 的双胞胎接待员，不是怪物。
_NONHUMAN_IP_EXCEPT = {
    "hinoa", "minoto", "rondine", "ayuria", "milsee",      # 怪物猎人
    "saegusa_miki",                                        # 哥斯拉（人类）
}



def _is_nonperson_char(prompt):
    """角色标签是不是「非人类」或「群体」——这类不该出现在女角色池里。"""
    if str(prompt).replace(" ", "_").lower() in _NONPERSON_EXACT:
        return True
    p = str(prompt).replace(" ", "_").lower()
    prev = None
    while prev != p:                      # 逐层剥掉结尾的 (…)
        prev = p
        p = re.sub(r"_\([^()]*\)$", "", p)
    if "_(generic)" in str(prompt).replace(" ", "_").lower():
        return True
    if _NONPERSON_BASE.match(p):
        return True
    if _NONPERSON_MONSTER.match(p):
        return True
    if _NONPERSON_GROUP.search(p):
        return True
    return False


# 非人模式下跳过的槽：衣服、鞋袜、首饰、头饰（它们没有可穿的）
# ⭐ 2026-10-19（阿君：非人模式还是出人类）：性别映射**只在这里定义一份**。
#   之前 nodes.py 和 server.py 各有一份，server 那份漏了「非人」⇒ 面板预览走
#   /pc/preview 时静默回退成「只看女性」，而节点真正执行却是对的 —— 极难查。
GENDER_MAP = {"只看女性": "f", "只看男性": "m", "全部": "all", "非人": "n"}

_NONHUMAN_SKIP_SLOTS = {
    "上装", "下装", "连衣裙与制服", "泳装与贴身衣物", "袖型与领口",
    "装饰与材质", "腿部服饰", "鞋子", "袜子", "首饰", "头饰配件",
}

ATTR_SLOTS = ("人物特征", "发色", "发型", "眼睛", "表情",
              # 2026-10-18（阿君：双人各自动作/姿势，别用双人互动）：姿势与动作也按人分配
              "基础姿势", "动作",
              "上装", "下装", "连衣裙与制服", "泳装与贴身衣物", "袖型与领口",
              "装饰与材质", "腿部服饰", "鞋子", "袜子", "首饰", "头饰配件")

OUT_ORDER = {
    # 2026-10-18：画风/配色属于"画面整体风格"，排在人数与角色之前
    "配色倾向": -1, "画风取向": -0.5,
    "人数": 0, "角色": 1, "作品": 2, "版权": 3, "画师": 4, "风格": 5,
    "人物特征": 6, "发色": 7, "发型": 8, "眼睛": 9}


def order_words(picked, anima=False):
    """按官方推荐顺序重排（现在**任何模式都排**，anima 参数只为兼容保留）。

    ⚠️ fmt_prompt 与 server 的 tags[] **必须共用它** —— 否则「整句已排好序、
    面板逐词条还是旧顺序」，两边对不上。
    """
    items = list(picked)
    # ⭐ 2026-10-17：多人（≥2 角色且带 who 标号）时按人分组输出：
    #     [人数] [画师/风格] → 角色A·作品A·属性A… → 角色B·作品B·属性B… → [公共词: 场景/光照/构图…]
    #   这是 danbooru 的写法习惯：属性词跟在它所属的角色名后面。
    if len([c for c in items if c.get("slot") == "角色"]) >= 2 \
            and any(c.get("who") is not None for c in items):
        def _rk(c):
            sl = c.get("slot")
            if sl == "角色":
                return (0, 0)
            if sl == "作品":
                return (1, 0)
            return (2, OUT_ORDER.get(sl, 99))
        head = [c for c in items if c.get("who") is None and c.get("slot") == "人数"]
        # 2026-10-18：配色/画风属"整组风格"，与画师版权一起排在人数之后、角色之前
        _META_SLOTS = ("配色倾向", "画风取向", "画师", "风格", "版权")
        meta = [c for c in items if c.get("who") is None
                and c.get("slot") in _META_SLOTS]
        rest = [c for c in items if c.get("who") is None
                and c.get("slot") != "人数" and c.get("slot") not in _META_SLOTS]
        groups = {}
        for c in items:
            if c.get("who") is not None:
                groups.setdefault(c["who"], []).append(c)
        out = head + meta
        for i in sorted(groups):
            g = sorted(groups[i], key=_rk)
            out += g
        rest.sort(key=lambda x: OUT_ORDER.get(x.get("slot"), 99))
        return out + rest
    items.sort(key=lambda x: OUT_ORDER.get(x.get("slot"), 99))
    return items


def fmt_prompt(picked, quality=None, space_out=True, anima=False):
    """拼正向提示词。anima=True 时额外套用 @ 画师前缀 / 括号转义 / 官方顺序。

    2026-10-17：**多人时按人分行**。原来两人四五十个标签全挤成一段，面板上看着很乱。
    现在「人数/画师」一行、每个角色一行、公共描述（场景/构图/镜头…）一行。
    单人时只有一个分组，仍然是一行，行为不变。
    """
    items = order_words(picked, anima)
    lines = []
    cur = []
    cur_key = "__init__"
    for x in items:
        k = x.get("who")
        if k != cur_key:
            if cur:
                lines.append(cur)
            cur = []
            cur_key = k
        cur.append(fmt_word(x["prompt"], x.get("slot"), space_out, anima))
    if cur:
        lines.append(cur)
    if not lines:
        return ", ".join(quality or [])
    out = []
    for i, ln in enumerate(lines):
        body = ", ".join(ln)
        if i == 0:
            pre = ", ".join(quality or [])
            out.append((pre + ", " + body) if pre else body)
        else:
            out.append(body)
    return "\n".join(out)


def fmt_detail(picked):
    return "\n".join("[%s] %s  %s" % (x["slot"], x["prompt"], x["name"]) for x in picked)
