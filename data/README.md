# 词库工具数据导出说明（供 Python 节点读取）

由 `extract_data.js` + `fix_data.js` 从 HTML 工具导出，源文件：
`C:/Users/Mrxie.X/Desktop/词库随机组合工具.html`

## 文件
| 文件 | 内容 |
|---|---|
| `dictionary.json` | 词库，**只含被槽位引用的 256388 条**（原 327542），字段压成数组 |
| `slot_idx.json` | 41 个槽 → 词典下标（**已重映射到瘦身后的下标**）|
| `rules.json` | 66 个键：池构建规则、过滤表、互斥表、正则、预设等 |

## dictionary.json 行格式
`[prompt, name, g, s, pc, n, category]`
- `prompt` 英文标签（danbooru 写法，下划线）
- `name` 中文名
- `g` 互斥组名（无则 0）
- `s` 性别 f/m（无则 0）
- `pc` 热度（danbooru post count）
- `n` 1 = NSFW（0 为一般）
- `category` 画师/角色/通用/版权/元数据

## rules.json 里的特殊标记
JSON 装不下 Set/Map/RegExp，导出时用包装对象：
- `{"__type":"Set","v":[...]}`
- `{"__type":"Map","v":[[k,v],...]}`
- `{"__type":"RegExp","source":"...","flags":""}`
- `{"__type":"RegExpPairs","v":[[source,flags,traits],...]}`

## ⚠️ 需要 Python 侧重建的派生表
`CHAR_TRAITS_BASE`（原 JS 里的 Map）**没有导出** —— 它的值是 `{sers: Set, traits: []}`，
Set 序列化会丢数据。Python 侧照下面的逻辑从 `CHAR_TRAITS` 重建即可：
```python
CHAR_TRAITS_BASE = {}   # base -> {'sers': set(), 'traits': [...]}
for k, traits in CHAR_TRAITS.items():
    bi = k.find('_(')
    base = k[:bi] if bi > 0 else k
    ser = k[bi:] if bi > 0 else ''
    slot = CHAR_TRAITS_BASE.setdefault(base, {'sers': set(), 'traits': traits})
    slot['sers'].add(ser)
```
（`CHAR_TRAITS_MAP`、`DICT_BY_PROMPT`、`SLOT_OF_PROMPT` 等同理，都是可重建的索引表）

## ⛔ 嵌套 RegExp 事故（2026-09-29，别再踩）

`extract_data.js` 原来只判**顶层** `v instanceof Set/Map/RegExp`，其余一律 `JSON.stringify`。
`SUBCAT_RULES` 是嵌套结构（`{分类: [[名称, /正则/i], …]}`）⇒ **15 条子分类正则全被吞成 `{}`**，
Python 侧 `re.compile({})` 抛错被 `except` 静默吞掉 ⇒「通用/元数据」永远没有子分类，
而且**看不出来**（返回 `subs: []`，跟"这类本来就该没有"长得一样）。

已修：
- `extract_data.js` 加 `deepPack()` 递归打包 + `countRe/countPackedRe` **导出后自检**
  （原始有几个正则、打包后就必须有几个，少了就报进 `failed`）
- `server.py::_subcat_spec` 兼容三种形态（已编译 Pattern / `{__type:"RegExp"}` / 字符串源），
  编译失败会 **print 醒目告警**，不再静默降级
- 回归脚本 `subcat_test.py` 断言 `sum(subs) == total`，数据再坏也跑不过

**规矩：往 `rules.json` 加任何带 RegExp / Set / Map 的嵌套结构前，先确认 `deepPack` 认得。**
