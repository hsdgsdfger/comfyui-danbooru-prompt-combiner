# Danbooru 抽签机 · ComfyUI Prompt Combiner

把 33 万条 Danbooru 标签按 **42 个槽位**随机组合成提示词的 ComfyUI 插件。带可视化面板、6 套预设、可按槽开关、可锁定、可只出 NSFW。

> **本仓库是二次开发版，原项目由 B 站 @咖喱给给咖喱给给给 制作，详见下方署名。**
> 使用前请务必阅读 [开源协议](#十一开源协议) —— **禁止商用**，衍生作品必须开源。

---

## 目录

- [一、这是什么](#一这是什么)
- [二、来源与原作者署名](#二来源与原作者署名)
- [三、功能说明](#三功能说明)
- [四、本次修改内容](#四本次修改内容)
- [五、安装](#五安装)
- [六、使用](#六使用)
- [七、后续添加词库的方法与注意事项](#七后续添加词库的方法与注意事项)
- [八、目录结构](#八目录结构)
- [九、数据结构说明](#九数据结构说明)
- [十、常见问题](#十常见问题)
- [十一、开源协议](#十一开源协议)

---

## 一、这是什么

ComfyUI 里的提示词插件大多是「手写一段 prompt」，这个插件干的是另一件事：

**把一个 33 万条的 Danbooru 标签库按语义拆成 42 个槽位（发型、上装、袜子、姿势、场景、光照……），每次执行时按热度权重从中各抽一个，拼成一条完整提示词。**

例如一次抽取可能得到：

```
masterpiece, best quality, score_7, anime style, 1girl, solo,
hatsune_miku, vocaloid, smile, closed mouth, long hair, twintails,
grey background, long sleeves, school uniform, white socks,
kneehighs, standing, hand on hip, ...
```

它的价值在于**组合的多样性**——不靠你手写，而是靠一个结构化词库随机生成。适合需要大量不同构图的批量出图场景。

---

## 二、来源与原作者署名

本项目基于以下作者的作品进行二次开发，**原始版权归原作者所有**：

| 项目 | 信息 |
|---|---|
| **原作者** | 咖喱给给咖喱给给给 |
| **平台** | 哔哩哔哩（Bilibili） |
| **UID** | `404690009` |
| **空间地址** | https://space.bilibili.com/404690009?spm_id_from=333.788.upinfo.detail.click |

原项目的核心资产包括：

- **32.7 万条 Danbooru 标签词库**（含中文名、热度、性别、NSFW 标记）
- **槽位体系设计**（42 个槽位、槽间互斥与联动规则）
- **池构建与抽词算法**（热度权重轮盘、互斥组、跨槽协调）
- **前端面板**（预设、槽位开关、实时预览、重抽）

> 本仓库不主张对上述原始资产的著作权。二次修改部分（见第四节）以相同协议开放。
> **如果你喜欢这个插件，请去原作者的 B 站空间点个关注。**

---

## 三、功能说明

### 3.1 节点

| 节点 | 显示名 | 作用 |
|---|---|---|
| `PromptCombiner` | 🎲 Danbooru 抽签机 | 主节点，输出一条拼好的提示词 |
| `PromptCombinerInfo` | ℹ️ 词库状态 | 只读，显示词库规模与槽位统计 |
| `PromptCombinerMetaWriter` | ✍️ 写入提示词元数据 | **不保存图片**。接住保存节点的 `FILE_PATH` 就直接写进 PNG 元数据；不接则只登记，等钩子补写 |

### 3.2 主节点参数（18 项）

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `preset` | 枚举 | 立绘 | 6 套预设：极简 / 立绘 / 插画 / 双人 / 自由搭配 / 全身立绘 |
| `gender` | 枚举 | 只看女性 | 只看女性 / 只看男性 / 全部 / 非人 |
| `nsfw_filter` | 布尔 | 开 | 开启后剔除所有 NSFW 标签 |
| `seed` | 整数 | 0 | 同 seed 同结果，配合「控制方式」复现 |
| `add_quality` | 布尔 | 开 | 自动追加质量词前缀 |
| `cross_series` | 布尔 | 关 | 允许角色跨作品抽取 |
| `space_out` | 布尔 | 开 | 输出时在标签间加空格（关闭则紧凑） |
| `neg_mode` | 枚举 | WAI精简 | 负向提示词：WAI精简 / 完整 |
| `show_detail` | 布尔 | 关 | 输出时附带每个标签的槽位来源 |
| `slots_json` | 文本 | 空 | 槽位开关表，非空时覆盖预设 |
| `series` | 文本 | 空 | 锁定作品，只抽该作品的角色 |
| `locked_json` | 文本 | 空 | 锁定标签列表，锁定的词不参与随机 |
| `auto_copyright` | 布尔 | 开 | 抽到角色时自动补对应作品名 |
| `auto_boost` | 布尔 | 开 | 抽到角色时自动补该角色的特征词 |
| `anima_mode` | 布尔 | 关 | Anima 模型模式，画师名加 `@` 前缀 |
| `pinned_prompt` | 文本 | 空 | **固定输出**，非空时直接返回这段文本，跳过随机 |
| `panel_state` | 文本 | 空 | 面板自动维护，不影响生成 |
| `nsfw_only` | 布尔 | 关 | 只出 NSFW 标签（见 4.5） |

### 3.3 42 个槽位

```
画师  配色倾向  画风取向  角色  人数  眼睛  视线与朝向  人物特征  表情  发型
发色  场景  光照  上装  下装  连衣裙与制服  泳装与贴身衣物  袖型与领口  装饰与材质  腿部服饰
鞋子  袜子  首饰  头饰配件  景别  相机方位  构图  镜头  景深  运镜
动态效果  基础姿势  动作  手臂与手势  身体与头部协调  双人互动  人物朝向  载具  动物  植物
道具  手持物
```

其中 5 个槽位词库无条目，靠 `rules.json → SLOT_PACK` 硬编码补词：画风取向、光照、运镜、配色倾向、身体与头部协调。

### 3.4 面板

节点上挂了一个可视化面板（`js/panel.js`），提供：

- 四个页签：**组合 / 槽位池 / 词库浏览 / 档位**
- 槽位逐个开关、每槽抽几个词
- 实时预览、单槽重抽
- 标签上右键剔除（写入全局黑名单）
- 词库浏览页可按分类/子分类检索

---

## 四、本次修改内容

以下全部为二次开发部分，逐项说明「问题是什么 / 改了什么」。

### 4.1 修复「抽签不再随机」

**现象**：多次执行输出完全一样，换 seed 也没用。

**根因**：`nodes.py::run()` 开头有这段逻辑 ——

```python
if pinned_prompt.strip():
    return (pinned_prompt, ...)   # 直接返回，seed 根本没被执行
```

面板在用户手动编辑过标签后，会把编辑结果写进 `pinned_prompt`（工作流 widget 第 16 位）。一旦非空，随机逻辑就被整段跳过。

**修复**：

- 清空工作流里 `pinned_prompt` 的值
- `seed` 的控制方式从 `fixed` 改为 `randomize`

**判断方法**：抽取引擎本身没问题，实测连抽 5 次结果 5 次全不同。问题只在调用链的参数上。

### 4.2 黑名单上限 2,000 → 50,000

**现象**：黑名单里的词明明删了，抽签时还会出现。

**根因**：原始代码把黑名单条数写死了两处——

```python
# server.py
u["black"] = data["black"][:2000]

// js/panel.js
if (bl.length > 2000) bl.length = 2000;
```

本项目黑名单有 8,000+ 条。每次打开面板保存，前端会按字母序截断到前 2,000 条，`p`、`r`、`s` 开头的袜子类整段消失。

**修复**：两处上限同步改为 50,000。

### 4.3 黑名单全链路生效

**问题**：`Pool.__init__` 支持 `black` 参数，但 `server.py` 里 6 处构造 `Pool` 时**全都没传**。

结果：节点抽取（走 `Generator(black=...)`）会过滤，但面板的词表接口（走 `pool.slot_list()`）不过滤 —— 面板上能看到已经删掉的词，容易误判成「没删干净」。

**修复**：

| 文件 | 位置 | 改动 |
|---|---|---|
| `server.py` | 6 处 `Pool(...)` | 补 `black=load_user_black()` |
| `server.py` | 角色集合缓存键 | 加入黑名单指纹，避免改黑名单后读旧缓存 |
| `nodes.py` | 2 处 `Pool(...)` | 同样补 `black` |

### 4.4 黑名单写法兼容

**问题**：词库里存的是 `black tights`（带空格），黑名单里写的是 `black_tights`（下划线）。`w["prompt"] not in self.black` 直接比对原样，永远命不中。

**修复**：`load_user_black()` 把每条展开成四种形式 —— 原样 / 小写 / 下划线版 / 空格版。

```python
out.add(s)
out.add(s.lower())
out.add(s.replace(" ", "_").lower())
out.add(s.replace("_", " ").lower())
```

效果：8,314 条黑名单展开后变成 16,576 条匹配项。

### 4.5 新增「只出 NSFW」开关

面板上「NSFW过滤」右边新增一个 **只出NSFW** 按钮，对应节点参数 `nsfw_only`。

**设计取舍**：42 个槽里有 26 个完全没有 NSFW 词（发型、表情、光照、景别、镜头……）。如果按字面「所有槽只抽 NSFW」执行，这些槽会直接空掉，人物连头发都没有。

所以实现为：**有可用 NSFW 词的槽才收紧，没有的保持原样。**

实测效果：

| 槽位 | 普通模式 | 只出NSFW |
|---|---:|---:|
| 泳装与贴身衣物 | 173 | 161 |
| 上装 | 481 | **19** |
| 下装 | 135 | **5** |
| 基础姿势 | 65 | **2** |
| 双人互动 | 90 | **8** |
| 发型 | 130 | 130（不动） |
| 表情 | 57 | 57（不动） |

两个开关互斥：打开「只出NSFW」会自动关掉「NSFW过滤」，反之亦然。

**兼容性**：`nsfw_only` 放在 `INPUT_TYPES` 的最末尾（第 18 位）。老工作流的 `widgets_values` 比现在短，缺的这一项走默认值 `False`，不会导致参数错位。

### 4.6 鞋子逻辑：只有站立且在地面才穿鞋

**规则**：只有「站立类姿势 + 踩在地面上」才保留鞋子；坐、躺、跪、蹲、浮空、下落、跳跃、游泳一律清空鞋槽。

**踩过的三个坑，都已填掉**：

1. `rm()` 删掉的词会被 `_refill_wiped()` 从池里补回来 —— 必须同时 `wiped.pop("鞋子")`，否则 `sitting` 会被补成 `black_shoes`。
2. 补裸脚的判断必须放在**所有协调逻辑之后**。原位置在前面，会出现「当时有袜子→不补裸脚→袜子随后被删→脚部空」。
3. `toeless_legwear`（露趾袜）在 `_BAREFOOT` 集合里会被删除，但它不是裸脚。判断「有没有袜子」时要排除它。

### 4.7 裸脚是合法状态

站立姿势下鞋槽抽空时自动补 `barefoot`，不会什么都不给。非站立且无袜时同样补裸脚。

400 次实测：非站立却有鞋 **0** 次；非站立无袜且无裸脚 **0** 次。

### 4.8 词库清洗（黑名单 8,314 条）

按使用需求逐批清理，全部通过 `user_edits.json → black` 实现（**不物理删除 `dictionary.json`**，因为 `slot_idx.json` 存的是下标，删条目会让 42 个槽整体错位）。

| 清洗项 | 条数 | 说明 |
|---|---:|---|
| 欧美版权 / 角色 | 2,484 | 漫威、DC、迪士尼、英雄联盟、守望先锋、OMORI 等 |
| 日系非二次元 | 1,217 | 宝可梦、索尼克、马力欧、塞尔达、斯普拉遁、星之卡比、街霸、艾尔登法环 |
| 写实风 | 3,808 | `*_(cosplay)` 变体 + realistic / photorealistic / 3d_render / semi-realistic / octane_render / unreal_engine |
| 连裤袜 | 145 | pantyhose / tights / leggings / bodystocking 全系，黑白也删 |
| 彩色袜子 | 77 | 只保留黑白与无颜色词 |
| 手套 | 222 | gloves / mittens / gauntlets / handwear |
| 袖套腕套 | 67 | arm_warmers / wrist_cuffs / arm_cuffs |

**误伤处理**：过程中修正了 30+ 处子串匹配误伤，典型如 ——

- `idolmaster_cinderella_girls` 被「灰姑娘」`cinderella` 命中
- `fate/grail_league` 被 `league` 命中
- `rio_(blue_archive)` 被「里约大冒险」`rio` 命中
- `toyota_crown`（丰田皇冠）被 `crown` 当成头冠
- `black_forest_cake`（黑森林蛋糕）被 `forest` 当成场景
- `livestream` / `lovestruck` 被 `vest` 当成马甲

这些全部通过「短词加词边界 + 歧义词只做前缀匹配 + 反例排除表」解决，具体白名单在 `core.py::load_user_black()` 与 `user_edits.json`。

### 4.9 无槽词补槽 4,396 条

词库里有 70,119 条「有词无槽」——存在于 `dictionary.json` 但不属于任何槽，抽取时根本进不了候选池。

**补槽前后**：

| 指标 | 补槽前 | 补槽后 |
|---|---:|---:|
| 槽引用总数 | 261,705 | **266,101** |
| 仍无槽 | 70,119 | **65,723** |

补槽量最大的几个槽：连衣裙与制服 +697、头饰配件 +477、手持物 +419、人物特征 +358、手臂与手势 +318、上装 +313。

补槽过程中修正了 5 轮正则误伤（`hair` 匹配 chair、`vest` 匹配 livestream、`breast` 匹配 double-breasted、`bow` 匹配 drawing_bow 等），实际写入量从初版的 4,815 降到 4,396。

剩余 65,723 条无槽词主要是**版权（20,304）、元数据（740）与题材泛称**（`artist_name`、`signature`、`watermark`、`meme`、`parody`、`cosplay` 等），它们本来就没有对应槽位。

### 4.10 关闭 5 个摄影技术槽

按槽位逐项核对标签库命中率后，默认关闭了 5 个 SDXL 时代的摄影写法的槽：

| 槽位 | 标准标签命中率 | 典型输出 |
|---|---:|---|
| 镜头 | 4.3% | `85mm_lens` `f/1.4` `wide-angle_lens` |
| 构图 | 11.9% | `rule_of_thirds` `centered_composition` |
| 景别 | 23.5% | `medium_shot` `bust_shot` |
| 相机方位 | 25.0% | `front_three-quarter_view` |
| 景深 | 27.3% | `shallow_depth_of_field` `selective_focus` |

Anima 等新模型用 danbooru 标签训练，这类词在标签库里根本不存在，只会占用 token。关闭后平均标签数从 25.2 降到 20.3。

> 槽位本身没有删除，只是默认关闭。想开回来在面板「槽位池」页签勾选即可。

### 4.11 槽位误判修正 17 条

导入外部标签表后发现一批归错槽的词，逐条搬回正确位置：

| 标签 | 原槽 | 改到 | 错因 |
|---|---|---|---|
| `flat_color` `flat_colors`（平涂） | 头饰配件 | 配色倾向 | `flat` 被联想成 flat cap（鸭舌帽） |
| `nun` `chef`（修女/厨师） | 头饰配件 | 角色 | 抓了「厨师帽/修女头巾」，把佩戴者当配饰 |
| `leaning_on_wall` 等 5 条 | 场景 | 基础姿势 | 抓地点名词，忽略主语是人 |
| `shrug_(clothing)` 等 4 条 | 角色 | 上装 | 看到 `_( )` 就套角色格式，没看括号内是类别词 |
| `pom_pom_(cheerleading)` 等 3 条 | 角色 | 道具 | 同上 |
| `chopper_(motorcycle)` | 角色 | 载具 | 同上 |

**注意**：`aizawa_ema_(1st_costume)` 这类**是合法角色名**（角色的第 N 套服装版本），不能按「括号内是服饰」处理。扫描出的 1,637 条同类词全部保留。

---

## 五、安装

### 5.1 环境要求

- ComfyUI（任意近期版本）
- Python 3.10+
- 无额外第三方依赖（只用 ComfyUI 自带的 `torch` / `numpy` / 标准库）

### 5.2 安装步骤

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/hsdgsdfger/comfyui-danbooru-prompt-combiner.git comfyui-prompt-combiner
```

或者在 ComfyUI-Manager 里用「Install from Git URL」填入仓库地址。

**重启 ComfyUI**（不是刷新网页）。插件在启动时读 `data/*.json`，热重载无效。

### 5.3 验证安装

启动日志里应出现：

```
[prompt-combiner] HTTP 路由注册成功
```

在节点列表里搜索「抽签」或「Danbooru」，应能看到 `🎲 Danbooru 抽签机`。

### 5.4 可选：浏览器标签库

插件本身只依赖 `data/dictionary.json`。如果你想用配套的 Danbooru 标签浏览器（按分类检索 23 万条标签），需要额外安装 `ComfyUI-Danbooru-Anima-Prompt` 并提供 `gelbooru_tags.csv`。

两者数据独立：
- `dictionary.json` 32.7 万条 —— 抽签用
- `gelbooru_tags.csv` 23 万条 —— 浏览器搜索用

---

## 六、使用

### 6.1 最小可用流程

1. 新建节点 → 搜索 `Danbooru 抽签机`
2. `preset` 选一个（推荐先试「立绘」）
3. `seed` 的控制方式设为 `randomize`
4. 连接输出到 `CLIP Text Encode` 的正面提示词
5. 排队执行

### 6.2 面板操作

选中节点后，节点上会出现面板。四个页签：

| 页签 | 用途 |
|---|---|
| **组合** | 当前抽取结果、单槽重抽、锁定标签、手动编辑 |
| **槽位池** | 逐槽开关、每槽抽几个、槽内词表浏览与增删 |
| **词库浏览** | 按分类/子分类检索全部标签，可加入槽位 |
| **档位** | 切换预设、保存自定义预设 |

### 6.3 复现某次结果

把 `seed` 的控制方式改为 `fixed`，填入当前 seed 值，再执行。

### 6.4 只想要某个角色

在 `series` 参数里填作品名（danbooru 写法，如 `genshin_impact`），或在「组合」页签点角色标签上的锁图标。

### 6.5 把提示词写进图片（排查用）

原生 `SaveImage` 只把 **workflow 的静态参数**写进 PNG，里面没有「这次实际抽出了哪些标签」，因为抽签结果是运行时生成的字符串，不在 `widgets_values` 里。想出事后回溯，只能拿 seed 重跑一遍。

本插件用一个**保存后置钩子**解决：抽签机（或登记节点）先把提示词记进进程状态，任何保存节点落盘 PNG 后，钩子自动往文件里插一个 `anima_prompt` 文本块。

**默认就是开着的，工作流一行都不用改。**

#### 覆盖哪些保存节点

钩子遍历 `NODE_CLASS_MAPPINGS`，包装**所有类名含 `saveimage` 的节点**：

| 节点 | 来源 | 状态 |
|---|---|---|
| `SaveImage` | ComfyUI 原生 | ✅ |
| `SaveImageClean` | `comfyui-save-image-organized` | ✅ |
| 其他同类插件 | — | ✅ 自动识别 |

提取文件路径走两条路：优先用返回的 `ui.images`（`filename` + `subfolder` + `output_dir` 拼），其次用 `result` 里的绝对路径（`SaveImageClean` 会把 `FILE_PATH` 直接返回）。两条都不通就跳过，不影响出图。

> 安装时机（这里踩过坑，务必看完）：ComfyUI 是**逐个 import** `custom_nodes` 的。实测本机启动日志，钩子在 `11:11:38` 装好，而 `comfyui-save-image-organized` 到 `11:11:43` 才加载完 —— 结果 `SaveImageClean` 全程没被包装，元数据一个都没写进去。
>
> 现在的做法：`__init__.py` 先试一次，再起一个后台线程每 2 秒重试，连续 3 轮没有新增才收工（最多 90 秒）。启动日志最后会出现 `[prompt-combiner] 图片元数据钩子就绪: ...`，以那行为准。
>
> **但钩子终究是隐式的。想要确定性，用下面的显式接线。**

#### 生效条件

1. 重启 ComfyUI
2. 正常用任意保存节点出图
3. 启动日志或首次出图后出现 `[prompt-combiner] 已安装图片元数据钩子: SaveImage, SaveImageClean`

#### 写入内容

| 键 | 来源 | 说明 |
|---|---|---|
| `anima_prompt` | 钩子 | 最近一次抽签输出，纯文本 |
| `anima_note` | 登记节点 | 备注（模型名 / 版本 / 实验编号），没填就不写 |
| `anima_slots` | 登记节点 | 结构化标签 JSON，没接就不写 |
| `workflow` / `prompt` | 原生 | 完全保留，其他工具读取方式不变 |

实现要点：

- **字节级插入 chunk，不重编码**。PIL 重新 `save()` 会丢掉 `iCCP` / `pHYs` / `sRGB` 等非文本块，色彩配置可能受影响。这里直接在 `IEND` 前插 `iTXt`，像素零改动（实测逐像素一致，文件只增加 67 字节）。
- **幂等**：同名键已存在就跳过，重复保存不会塞多个。
- **时效 300 秒**：超过 5 分钟的旧记录不会写进新图，避免串味。
- **只写 `type == "output"`**：`PreviewImage` 的临时文件不碰。
- **非 PNG 跳过**：只处理 `.png`，webp / jpg 不改。

#### 关闭钩子

启动前设环境变量 `ANIMA_META_HOOK=0`。

#### 推荐：✍️ 写入提示词元数据（显式接线）

一个**不保存图片**的节点，直接往指定 PNG 里写元数据。不依赖钩子、不看加载顺序、写完当场能看到结果。

```
VAE Decode ────────────────images──→ SaveImageClean ──FILE_PATH──→ ✍️ 写入提示词元数据
                                          ↑                              ↑
                                     先落盘出图                    🎲 抽签机.标签组合结果
```

**关键是那根从 `SaveImageClean` 第二个输出（`FILE_PATH`）接到 `file_path` 的线**。`SaveImageClean` 会返回文件的绝对路径，节点拿到路径后直接改文件 —— 这是全流程里唯一确定的事实，不靠猜。

| 参数 | 必填 | 说明 |
|---|---|---|
| `prompt_text` | ✅ | 接抽签机的「标签组合结果」 |
| `file_path` | ⬜ | 接保存节点的 `FILE_PATH`。**填了就直接写这个文件**；留空则退回钩子那条路 |
| `note` | ⬜ | 备注，写进 `anima_note` |
| `tags_json` | ⬜ | 结构化标签 JSON，写进 `anima_slots` |
| `write_log` | ⬜ | 额外追加一行到 `output/_anima_prompts.jsonl`，默认关 |

`file_path` 支持三种形态：

| 传什么 | 行为 |
|---|---|
| PNG 绝对路径 | 写这一张 |
| 目录绝对路径 | 写该目录下所有 PNG（不递归） |
| 非 PNG / 不存在 | 节点上显示 `[失败] 具体原因`，控制台同步打印 |

节点执行完会在自己身上显示写入结果（`已写入 1/1 个文件`），不用去翻日志。

输出透传 `prompt_text`（STRING），可以继续接别的节点。

> 原生 `SaveImage` 没有 `FILE_PATH` 输出，只能走钩子那条路，或者用下面的取巧办法：
> 在 `filename_prefix` 里填绝对路径（如 `D:\out\myimg`），保存后从 `ui.images` 能推出来。

#### 什么时候不需要这个节点

只想在 PNG 里看到提示词、又懒得接线 —— 钩子已经自动做了。但它依赖上面说的重试机制，遇到新插件不保证 100% 覆盖。

#### 怎么查看

Windows 资源管理器的「属性 → 详细信息」不显示 PNG 自定义元数据，用下面任一方式：

```bash
# 1. exiftool（推荐，能列出全部 chunk）
exiftool 图片.png

# 2. Python 一行
python -c "from PIL import Image;im=Image.open(r'图片.png');print(im.text.get('anima_prompt'))"
```

```python
# 3. 批量导出某个文件夹所有图片的提示词
import os
from PIL import Image

for f in os.listdir("output"):
    if f.lower().endswith(".png"):
        im = Image.open(os.path.join("output", f))
        print(f"
=== {f} ===
{im.text.get('anima_prompt', '(无)')}")
```

XnView MP、Honeyview 这类看图软件也能直接看到 PNG 文本块。

#### 并发说明

钩子取的是「进程内最近一次登记」，**并发跑多个工作流时会互相覆盖**。ComfyUI 默认单队列顺序执行，实际不会撞。


## 七、后续添加词库的方法与注意事项

### 7.1 三种添加方式

#### 方式 A · 面板逐个加（推荐，最安全）

1. 选中节点 → 面板切到 **槽位池**
2. 左侧选目标槽位（如「角色」）
3. 在列表底部输入框填英文标签（如 `hatsune_miku`）
4. 回车，提示「已把 xxx 加进「角色」」

存盘位置：`data/user_edits.json → slotEdits.added`

**特点**：不动词库本体，零下标风险。但只能写纯字符串，带不了热度/NSFW/性别标记。

#### 方式 B · 直接改 JSON（批量，中等风险）

编辑 `data/user_edits.json`：

```json
{
  "slotEdits": {
    "added": {
      "角色": ["my_char_(my_series)"],
      "上装": ["oversized_hoodie"],
      "画师": ["some_artist"]
    }
  }
}
```

`added` 的优先级**高于黑名单** —— 同一个词既在 `added` 又在 `black` 里，照样会被抽到。

#### 方式 C · 追加词库本体（大批量、需要正确权重）

要保留热度（`pc`）、NSFW 标记（`n`）、性别（`s`），必须走这条。**三步缺一不可**：

**第 1 步**：在 `data/dictionary.json` 末尾追加，格式是 7 元数组：

```json
["hatsune_miku", "初音未来（VOCALOID）", 0, "f", 145793, 0, "角色"]
```

字段顺序：`[prompt, name, g, s, pc, n, category]`，详见[第九节](#九数据结构说明)。

记下追加的起始下标 `START`（原文件长度）。

**第 2 步**：把新下标追加到 `data/slot_idx.json` 对应槽的数组：

```json
{
  "角色": [..., 331824, 331825]
}
```

**第 3 步**：检查下标不越界。

```python
import json
d = json.load(open("data/dictionary.json", encoding="utf-8"))
s = json.load(open("data/slot_idx.json", encoding="utf-8"))
mx = max(max(v) for v in s.values() if v)
assert mx < len(d), f"下标越界：{mx} >= {len(d)}"
print("OK")
```

### 7.2 必须知道的六条规则

#### ① `slot_idx.json` 只许 append

它存的是**数组下标**，不是字符串。中间插入或排序会让 42 个槽全部错乱 —— 词都对，但全跑到别的槽里去了。

#### ② `prompt` 必须全小写下划线

`db.by_prompt` 是**精确匹配**，不做任何归一化。

- ✅ `black_hair`
- ❌ `black hair`（带空格 → 查不到词库 → 丢失热度权重）
- ❌ `Black_Hair`（含大写 → 同样查不到）

实测原词库 327,702 条里 **0 条带空格**，全部下划线。

#### ③ 热度 `pc` 低于 50 会被过滤

`core.py::_pass` 里写死：

```python
if w["category"] and (w["pc"] or 0) < R.get("MIN_PC", 50):
    return False
```

`rules.json` 里 `MIN_PC = 50`。**新词 `pc` 填 0 会被整条丢弃，导入成功但永远抽不到。**

建议新词给一个真实热度，或在 50 以上给个合理值。

#### ④ 抽取是权重轮盘，`pc` 决定出现频率

最终权重 = `(pc + 1) ** 0.5`。实测各槽竞争强度：

| 槽 | 可用词数 | `pc=60` 时单次出现概率 |
|---|---:|---:|
| 画师 | 48,871 | **0.0013%** |
| 角色 | 33,440 | **0.0014%** |
| 上装 | 492 | 0.0128% |
| 袜子 | 39 | 0.1356% |

含义：一个 `pc=60` 的新角色，800 次抽取期望命中 **0.01 次**。抽不到是数学必然，不是 bug。

想让它常出现：
- 给真实高 `pc`（角色类至少 5,000 以上才有存在感）
- 或用 `user_edits.json → weights` 设倍数：`{"my_char_(series)": 40}`

#### ⑤ 槽位与分类是硬绑定

| category | 只能进 |
|---|---|
| `画师` | 「画师」槽 |
| `角色` | 「角色」槽 |
| `通用` | 其余 37 个通用槽之一 |
| `版权` / `元数据` | **不进任何槽** |

把 `hatsune_miku` 写进「上装」，出图会得到一件名叫初音未来的上衣。

#### ⑥ 改完必须重启 ComfyUI

`data/*.json` 全部是启动时读盘。刷新网页、重载前端都无效。

### 7.3 添加前先备份

```bash
cd data
cp dictionary.json dictionary.json.bak
cp slot_idx.json  slot_idx.json.bak
cp user_edits.json user_edits.json.bak
```

`slot_idx.json` 是三个文件里唯一「改坏救不回来」的一个，回滚时优先恢复它。

### 7.4 添加后怎么验证

```python
import importlib.util, sys
spec = importlib.util.spec_from_file_location("core", "core.py")
core = importlib.util.module_from_spec(spec); spec.loader.exec_module(core)

db = core.Data.get()
pool = core.Pool(db, gender="f", nsfw_filter=True, black=core.load_user_black())
print("角色槽词数:", len(pool.slot_list("角色")))
print("新词在不在:", "my_char_(my_series)" in [w["prompt"] for w in pool.slot_list("角色")])
```

词数应比添加前多，且新词在列表里。

---

## 八、目录结构

```
comfyui-prompt-combiner/
├── __init__.py              # 插件入口：注册节点、挂载 HTTP 路由、声明前端目录
├── nodes.py                 # 节点定义（PromptCombiner / PromptCombinerInfo）
├── save_node.py             # 提示词元数据：登记节点 + 保存后置钩子（独立文件，加载失败不影响主节点）
├── state.py                 # 进程级暂存：记录最近一次提示词/备注/结构化标签（300 秒时效）
├── core.py                  # 核心引擎：数据加载、池构建、抽词、跨槽协调、格式化
├── server.py                # 面板用的 HTTP API（/pc/preview、/pc/slotpool 等）
├── js/
│   └── panel.js             # 前端面板（约 380KB，四个页签）
├── data/
│   ├── dictionary.json      # 词库本体（331,824 条，7 元数组）
│   ├── slot_idx.json        # 槽位 → 词库下标映射（41 个槽，266,101 条引用）
│   ├── rules.json           # 规则表（75 个键：过滤、互斥、预设、槽位补词等）
│   ├── user_edits.json      # 用户数据（黑名单 8,314 条、加词、权重、收藏）
│   ├── cn_extra.json        # 中文补充词表
│   ├── hist.json            # 抽取历史
│   └── README.md            # 词库导出说明（原项目文档）
├── README.md                # 本文件
└── LICENSE                  # 非商业 Copyleft 许可
```

### 各文件说明

| 文件 | 说明 |
|---|---|
| `core.py` | 最核心的文件。`Data` 单例加载全部 JSON；`Pool` 负责按性别/NSFW/黑名单过滤出可用池；`Generator` 负责按权重抽词、处理互斥组、跨槽协调（5.x 系列规则）；`fmt_prompt` 负责拼装输出 |
| `server.py` | 注册 `/pc/preview`、`/pc/slotpool`、`/pc/save`、`/pc/search` 等路由给前端面板用 |
| `rules.json` | 75 个键，包括 `SLOT_ORDER`（42 槽顺序）、`MIN_PC`（热度门槛）、`NEGATIVE_PROMPT_*`（负向词）、`SLOT_PACK`（槽位补词）、`COMPOSE_PRESETS`（预设）等 |
| `slot_idx.json` | 存的是**下标**，不是标签字符串。只许 append，见 7.2 ① |

---

## 九、数据结构说明

### 9.1 `dictionary.json`

每条是 7 元数组，不是对象：

```
[prompt, name, g, s, pc, n, category]
```

| 位 | 字段 | 类型 | 说明 |
|---|---|---|---|
| 0 | `prompt` | str | 英文 danbooru 写法，全小写下划线 |
| 1 | `name` | str | 中文显示名；角色写作 `中文名（作品）` |
| 2 | `g` | str \| 0 | 互斥组名，同组只出一个（如 `g_count`），无则 `0` |
| 3 | `s` | str \| 0 | 性别 `f` / `m`，无则 `0` |
| 4 | `pc` | int | danbooru post count，决定抽取权重 |
| 5 | `n` | int | `1` = NSFW，`0` = 一般 |
| 6 | `category` | str | `画师` / `角色` / `通用` / `版权` / `元数据` |

真实样例：

```json
["hatsune_miku", "初音未来（VOCALOID）", 0, "f", 145793, 0, "角色"]
["1girl", "单人女性", "g_count", "f", 8408224, 0, "通用"]
["dairi", "dairi", 0, 0, 18794, 0, "画师"]
["original", "原创", 0, 0, 1580502, 0, "版权"]
["highres", "高分辨率", 0, 0, 8150944, 0, "元数据"]
```

### 9.2 `user_edits.json`

```json
{
  "slotEdits": {
    "added":    { "角色": ["xxx"], "上装": ["yyy"] },
    "removed":  { "头饰配件": ["zzz"] },
    "renamed":  {},
    "hidden":   ["剔除|头饰配件|ears_through_hood"]
  },
  "black": ["list_of_banned_tags"],
  "weights": { "my_char_(series)": 40 },
  "favorites": [],
  "cnTpl": {},
  "seedParams": {}
}
```

| 键 | 作用 |
|---|---|
| `slotEdits.added` | 往槽位加词，优先级高于 `black` |
| `slotEdits.removed` | 从指定槽剔除词（只影响该槽） |
| `black` | 全局黑名单，任何槽都不会抽到 |
| `weights` | 单个标签的权重倍数，`1.0` 为默认 |

### 9.3 `rules.json` 特殊标记

JSON 装不下 Set / Map / RegExp，导出时用包装对象：

```json
{"__type": "Set",    "v": [...]}
{"__type": "Map",    "v": [[k, v], ...]}
{"__type": "RegExp", "source": "...", "flags": ""}
```

Python 侧读取时要判断 `__type` 再还原。

---

## 十、常见问题

**Q：抽签结果每次都一样？**
检查 `pinned_prompt` 是否非空（非空会直接返回固定文本），以及 `seed` 控制方式是否为 `fixed`。

**Q：新加的标签抽不到？**
按顺序排查：① `pc` 是否 < 50 被过滤；② 是否在 `black` 里；③ 是否给了槽位（`slot_idx` 里有没有它）；④ `prompt` 有没有大写或空格；⑤ 是否重启过 ComfyUI。

**Q：面板上能看到已删除的词？**
面板现在也读黑名单了（4.3）。如果还看到，先 `Ctrl+F5` 硬刷，再确认已重启。

**Q：提示词太长，模型不听话？**
Anima / Illustrious 等新模型对长提示词敏感。去面板「槽位池」关掉不需要的槽，或把 `preset` 换成「极简」。

**Q：质量词重复了两份？**
`rules.json → FIXED_QUALITY` 有 8 条（含 `score_9` / `score_8` / `ultra detailed`），而 Anima 官方推荐只用 `masterpiece, best quality, score_7`。可以手动精简 `FIXED_QUALITY`，或在节点里关掉 `add_quality` 自己写。

**Q：改了 `core.py` 没生效？**
`core.py` 是后端，必须完全退出 ComfyUI 再启动。

---

## 十一、开源协议

本项目采用 **非商业 Copyleft 许可（Non-Commercial Copyleft License v1.0）**，完整条款见 [LICENSE](LICENSE)。

三条核心约束：

| 约束 | 说明 |
|---|---|
| 🚫 **禁止商业使用** | 不得用于任何商业目的，包括但不限于付费服务、商业产品集成、付费课程、以本项目为基础的收费部署 |
| 🔓 **衍生必须开源** | 任何 fork、修改版、衍生作品，必须以**相同协议**公开全部源代码 |
| ✍️ **必须保留署名** | 必须保留原作者（B站 @咖喱给给咖喱给给给，UID 404690009）与本仓库的署名信息 |

简单说：**你可以免费用、随便改，但改了要开源，且不能拿去卖钱。**

商业授权请联系原作者。

---

## 致谢

- **原作者**：[B站 @咖喱给给咖喱给给给](https://space.bilibili.com/404690009?spm_id_from=333.788.upinfo.detail.click)（UID 404690009）—— 词库、槽位体系、抽词算法、前端面板全部来自原作
- **标签数据**：[Danbooru](https://danbooru.donmai.us/) / [Gelbooru](https://gelbooru.com/) 社区
- **运行平台**：[ComfyUI](https://github.com/comfyanonymous/ComfyUI)

如果这个插件帮你省了时间，请去原作者空间点个关注 —— 词库和算法是他一行一行堆出来的。
