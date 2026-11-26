// Danbooru 抽签机 · 前端面板
// 照 ComfyUI-Bilingual-Prompt-Inspector 的机制：
//   app.registerExtension + beforeRegisterNodeDef + this.addDOMWidget(..., {serialize:false})
//
// 2026-09-25 布局重做（用户反馈「跟网页版有差距、操作不方便」）：
//   · 槽位从「横排 chips 挤成一片」→ **网格布局**（每格一个槽，整齐好找）
//   · 抽到的标签从「chips 堆」→ **列表**（一行一个，带中英文+槽位，好读）
//   · 分组标题带 **全开/全关**
//   · 节点默认加宽到 720
import { app } from "../../scripts/app.js";
/* ⭐ 2026-11-22：**必须**从 api 层拦排队。
   ⛔ 前端 1.5x 起，「运行」按钮不再调 app.queuePrompt —— 它走命令系统
      （`Comfy.QueuePrompt` → 内部 `xxx.queuePrompt(0, batchCount, {...})`），
      所以上一版挂在 app.queuePrompt 上的钩子在这套新前端里**根本没人调**，
      表现就是「开关亮着，但图完全没变」。
   ✅ api.queuePrompt 是所有提交路径的最终出口（按钮 / 快捷键 / 命令行 / 队列前面插入），
      包它最稳；而且它拿到的是**已经序列化好的 prompt**，直接改里面的 seed 最准。 */
import { api as comfyApi } from "../../scripts/api.js";

const NODE_NAME = "PromptCombiner";

/* ⭐ 2026-10-18（阿君：在节点里加作者 + 社交主页链接）
   —— 这里是唯一要改的地方：links 里 **url 留空就不显示**该按钮。
   ⚠️ 别写 javascript: 开头的地址，浏览器会拦。 */
const PC_AUTHOR = {
  name: "咖喱给给咖喱给给给",
  tagline: "词库随机组合工具 · 作者",
  _ver: "327,700 条 · 42 槽",
  links: [
    { label: "B站", url: "https://space.bilibili.com/404690009" },
  ],
};
const API_ROOT = "/pc";
/* ⭐ 2026-10-20：本次页面会话的随机号。面板状态里带上它，
   用来区分「同一会话里切工作流回来」（要恢复）和「刚启动 ComfyUI」（要空白）。
   ⭐ 2026-10-21（阿君：「不小心按到 Ctrl+F5，跑了一下午的历史组合全没了」）：
     原来这个是**每次页面加载重新生成** ⇒ 刷新后 sid 必然对不上 ⇒
     历史被当成"跨会话"一律不读 —— 切工作流能恢复、刷新却丢，说不通。
     现在存 sessionStorage：**刷新（F5 / Ctrl+F5）存活** ⇒ 历史完整恢复；
     **关掉标签页 / 新开窗口**才失效 ⇒ 冷启动依然"完全干净"
     （v1.4.17/19 定的规矩没破）。 */
const PC_SID = (() => {
  const _gen = () => (Date.now() % 1000000000) * 1000 + Math.floor(Math.random() * 1000);
  try {
    let v = sessionStorage.getItem("pcSid");
    if (!v) { v = String(_gen()); sessionStorage.setItem("pcSid", v); }
    return Number(v);
  } catch (e) { return _gen(); }
})();
/* ⛔ 2026-10-20 三修：ComfyUI 载入工作流时，同一个节点会**建两次面板**。
   第二次读到了 panel_state 并渲染成功，但节点上挂的是**第一次**那个 DOM，
   于是"看得见的那个"还是空的。⇒ 恢复结果放进模块级共享，谁先到手都能看到。 */

const VERSION = "1.4.40";   // 版本号（以后每次改动 +0.0.1）
let META = null;
let META_PROMISE = null;

/* ================= 小工具 ================= */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

async function api(path, options = {}) {
  const res = await fetch(`${API_ROOT}${path}`, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const out = await res.json();
  if (!res.ok || !out.success) throw new Error(out.error || `请求失败 ${res.status}`);
  return out.data;
}

function loadMeta() {
  if (!META_PROMISE) {
    META_PROMISE = api("/meta")
      .then((d) => {
        META = d;
        /* 2026-10-19：后端（core.py/nodes.py）改了必须重启 ComfyUI，光刷页面不生效。
           这里比对 build，不一致就在标题栏旁边红字提示 —— 免得又出现
           「选了非人却出初音」这种看着像 bug、实际是后端没重启的情况。 */
        try {
          const b = d && d.version;
          /* b === undefined ⇒ 后端根本不返回版本号 = 更旧的代码，同样要提示 */
          if ((b === undefined || b === null) || (b !== "unknown" && b !== VERSION)) {
            const el = document.querySelector("#pcFSub");
            if (el) {
              el.textContent = (b === undefined || b === null)
                ? "⚠️ 后端没有版本信息（旧代码），请完全退出 ComfyUI 再启动"
                : "⚠️ 后端代码是旧的（v" + b + "），请完全退出 ComfyUI 再启动";
              el.style.color = "#ff8b7a";
              el.style.fontWeight = "600";
            }
          }
        } catch (e) {}
        return d;
      })
      .catch((e) => { META_PROMISE = null; throw e; });
  }
  return META_PROMISE;
}
/* ⭐ 2026-10-06：强制重拉一次 meta。
   ⛔ 槽位表（新建/删除/改名槽位）变了必须重拉 —— 面板槽位区渲染的就是 meta.slotGroups，
      后端 /pc/meta 会按最新 user_edits 重算 slotOrder/slotGroups。
      不重拉的话「新建的槽位永远不显示在面板上」（阿君报的那个 bug）。 */
function reloadMeta() {
  META_PROMISE = null;
  return loadMeta();
}

async function copyText(text, onDone) {
  try { await navigator.clipboard.writeText(text); onDone && onDone(true); }
  catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); onDone && onDone(true); }
    catch (e2) { onDone && onDone(false); }
    document.body.removeChild(ta);
  }
}

/* ================= 样式 ================= */

function injectStyles() {
  if (document.getElementById("pc-styles")) return;
  const s = document.createElement("style");
  s.id = "pc-styles";
  s.textContent = `
.pc-panel{width:100%;min-height:0;box-sizing:border-box;padding:9px 11px;overflow:auto;
  background:rgba(12,15,22,.75);border:1px solid #333c4a;border-radius:8px;
  color:var(--input-text,#ddd);font:12px/1.5 system-ui,"Microsoft YaHei",sans-serif}
.pc-panel.pc-collapsed .pc-body{display:none}

/* ===== 极简面板（节点上的）===== */
.pc-panel-mini{padding:8px 10px}
.pc-mini-line{display:flex;gap:7px;flex-wrap:wrap;align-items:center;margin-bottom:6px}
.pc-mini-btn{padding:4px 12px;border-radius:6px;border:1px solid #3a4250;background:#1b2028;
  color:#c9d3e2;cursor:pointer;font-size:11.5px;white-space:nowrap}
.pc-mini-btn:hover{border-color:#5ee0d6;color:#8ff0e6}
.pc-mini-btn.pri{background:rgba(94,224,214,.16);border-color:#5ee0d6;color:#8ff0e6;font-weight:600}
.pc-mini-info{font-size:11px;color:#8b9ab0;line-height:1.5;word-break:break-all}

/* ===== 全屏面板的标签页 ===== */
/* 标签页已去掉；下面的 .pc-tabpane 规则保留是给"单页"用的 */
.pc-dictinline{display:flex;flex-direction:column;min-height:0}
/* ===== 标签词库（对齐网页 .cat-title 折叠列表）===== */
.pc-dhead{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.pc-find{width:150px;height:24px;padding:0 8px;font-size:12px;border-radius:6px;
  border:1px solid rgba(120,160,220,.35);background:rgba(255,255,255,.06);color:inherit;outline:none}
.pc-find:focus{border-color:#5ee0d6}
.pc-dsearch{margin-left:auto;flex:0 1 280px;min-width:120px;box-sizing:border-box;
  background:#1b2028;border:1px solid #3a4250;color:#d7dfeb;border-radius:999px;
  padding:4px 12px;font-size:12px;outline:none}
.pc-dsearch:focus{border-color:#5ee0d6}
.pc-dcatlist{display:flex;flex-direction:column;gap:2px}
.pc-dcat{border-radius:8px}
.pc-dcath{display:flex;align-items:center;gap:9px;padding:8px 10px;
  border-bottom:1px dashed #2a323d;cursor:pointer;border-radius:8px;user-select:none}
.pc-dcath:hover{background:rgba(255,255,255,.03)}
.pc-dcat .arr{color:#5ee0d6;font-size:11px;width:14px;display:inline-flex;
  justify-content:center;transition:transform .15s}
.pc-dcat.open .arr{transform:rotate(90deg)}
.pc-dcath .nm{color:#c9d3e2;font-size:13px}
.pc-dcath .n{background:#1b2028;border:1px solid #3a4250;border-radius:999px;
  font-size:11px;padding:1px 8px;color:#5ee0d6}
.pc-dcats{margin-left:auto;flex:0 0 150px;box-sizing:border-box;background:#1b2028;
  color:#d7dfeb;border:1px solid #3a4250;border-radius:999px;padding:3px 10px;
  font-size:12px;outline:none;cursor:text}
.pc-dcats:focus{border-color:#5ee0d6}
.pc-dcatb{padding:8px 2px 10px}
.pc-dinfo{color:#6b7a93;font-size:11px;margin-bottom:7px}
.pc-dwords{display:flex;flex-wrap:wrap;gap:5px;max-height:280px;overflow:auto}
.pc-dfoot{display:flex;gap:8px;justify-content:center;margin-top:9px}
/* --- 子分类 chips（通用/元数据/版权/画师）：对齐网页 .subcat-bar / .subcat-chip --- */
.pc-subbar{display:flex;flex-wrap:wrap;gap:6px;padding:0 0 9px 2px}
.pc-subchip{display:inline-flex;align-items:baseline;gap:6px;font-size:12px;padding:3px 10px;
  border-radius:999px;border:1px solid #3a4250;background:#161b23;color:#8b9ab0;
  cursor:pointer;user-select:none}
.pc-subchip:hover{border-color:#5ee0d6;color:#c9d3e2}
.pc-subchip.on{background:rgba(94,224,214,.14);border-color:#5ee0d6;color:#5ee0d6}
.pc-subchip .n{font-size:10px;color:#6b7a93;background:rgba(255,255,255,.05);
  border-radius:999px;padding:0 5px}
.pc-subchip.on .n{color:#5ee0d6;background:rgba(94,224,214,.12)}
/* --- 角色分类的「系列」小分类：对齐网页 .series-row / .series-item --- */
.pc-serrow{display:flex;gap:10px;flex-wrap:wrap;margin:2px 0 10px}
.pc-serrow input{flex:1 1 240px;box-sizing:border-box;background:#1b2028;color:#d7dfeb;
  border:1px solid #3a4250;border-radius:999px;padding:6px 13px;font-size:12.5px;
  outline:none;text-align:center;cursor:text}
.pc-serrow input:focus{border-color:#5ee0d6}
.pc-serrow input::placeholder{color:#5d6b82}
.pc-serlist{max-height:300px;overflow:auto;padding:2px 1px}
.pc-seritem{display:inline-flex;align-items:center;gap:8px;margin:4px;padding:5px 12px;
  background:#161b23;border:1px solid #3a4250;border-radius:999px;font-size:12px;
  cursor:pointer;transition:border-color .15s,background .15s}
.pc-seritem:hover{border-color:#5ee0d6;background:#1d2430}
.pc-seritem .cn{color:#d7dfeb;font-weight:600}
.pc-seritem .n{background:#0e1319;border:1px solid #3a4250;border-radius:999px;
  font-size:11px;padding:0 7px;color:#5ee0d6}
.pc-seritem .en{color:#6b7a93;font-size:10.5px;font-family:Consolas,monospace}
.pc-sermore{margin:10px auto 4px;text-align:center;color:#5ee0d6;font-size:12px;
  cursor:pointer;padding:6px}
.pc-sermore:hover{text-decoration:underline}
.pc-serback{display:inline-block;margin:0 0 9px 2px;background:#161b23;border:1px solid #3a4250;
  color:#5ee0d6;border-radius:999px;padding:3px 11px;font-size:12px;cursor:pointer}
.pc-serback:hover{border-color:#5ee0d6}
.pc-tab-btn{padding:8px 16px;border:none;background:none;color:#8b9ab0;cursor:pointer;
  font-size:12.5px;border-bottom:2px solid transparent;margin-bottom:-1px}
.pc-tab-btn:hover{color:#c9d3e2}
.pc-tab-btn.on{color:#5ee0d6;border-bottom-color:#5ee0d6;font-weight:600}
.pc-tabpane{display:none;flex:1;min-height:0}
.pc-tabpane.on{display:flex}
.pc-tabpane.pc-standalone{flex-direction:column;padding:12px 14px;overflow:auto}

/* 顶部工具条 */
.pc-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  padding-bottom:7px;margin-bottom:8px;border-bottom:1px solid #2a323d}
.pc-title{color:#5ee0d6;font-weight:600;font-size:12.5px;flex:0 0 auto}
.pc-spacer{flex:1 1 auto}
.pc-mini{padding:2px 8px;border-radius:5px;border:1px solid #3a4250;background:#1b2028;
  color:#9fb0c8;cursor:pointer;font-size:10.5px;white-space:nowrap}
.pc-mini:hover{border-color:#5ee0d6;color:#8ff0e6}

/* 预设行 */
.pc-presets{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:9px}
.pc-lab{color:#7f8ea8;font-size:11px;flex:0 0 auto}
.pc-pchip{padding:3px 11px;border-radius:999px;border:1px solid #3a4250;background:#1b2028;
  color:#c9d3e2;cursor:pointer;user-select:none;font-size:11.5px;white-space:nowrap}
.pc-pchip:hover{border-color:#5ee0d6}
.pc-pchip.on{background:rgba(94,224,214,.16);border-color:#5ee0d6;color:#8ff0e6;font-weight:600}

/* 槽位分组 */
.pc-group{margin-bottom:7px;border:1px solid #262e39;border-radius:7px;overflow:hidden}
.pc-ghead{display:flex;align-items:center;gap:7px;padding:4px 8px;
  background:rgba(255,255,255,.025);cursor:pointer}
.pc-ghead:hover{background:rgba(94,224,214,.06)}
.pc-gname{color:#f0b35e;font-size:11px;font-weight:600;flex:1 1 auto}
.pc-gcnt{color:#6b7a93;font-size:10px}
.pc-gfold{color:#6b7a93;font-size:10px}
.pc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));
  gap:4px;padding:6px 8px 8px}
.pc-group.pc-folded .pc-grid{display:none}

/* 单个槽位开关 */
.pc-slot{display:flex;align-items:center;gap:5px;padding:3px 7px;border-radius:5px;
  border:1px solid #2f3846;background:#161b23;cursor:pointer;user-select:none;
  font-size:11.5px;color:#8b9ab0;min-width:0}
.pc-slot:hover{border-color:#5ee0d6;color:#c9d3e2}
.pc-slot.on{background:rgba(94,224,214,.13);border-color:#5ee0d6;color:#a8f0e8}
.pc-slot .dot{flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:#3a4250}
.pc-slot.on .dot{background:#5ee0d6}
.pc-slot .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* 操作行 */
.pc-acts{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:9px 0 7px}
.pc-btn{padding:4px 13px;border-radius:6px;border:1px solid #3a4250;background:#1b2028;
  color:#c9d3e2;cursor:pointer;font-size:11.5px}
.pc-btn:hover{border-color:#5ee0d6;color:#8ff0e6}
.pc-btn.pri{background:rgba(94,224,214,.16);border-color:#5ee0d6;color:#8ff0e6;font-weight:600}
.pc-btn:disabled{opacity:.5;cursor:default}

/* 抽到的标签：列表式（一行一个，好读） */
.pc-tags{max-height:230px;overflow:auto;border:1px solid #2a323d;border-radius:7px;
  background:rgba(0,0,0,.22);padding:5px 7px}
.pc-tag{display:flex;align-items:baseline;gap:7px;padding:2px 3px;border-radius:4px}
.pc-tag:nth-child(odd){background:rgba(255,255,255,.018)}
.pc-tag .idx{color:#4d5a6e;font-size:10px;flex:0 0 18px;text-align:right}
.pc-tag .en{font-family:Consolas,monospace;color:#5ee0d6;font-size:11.5px;word-break:break-all}
.pc-tag .cn{color:#8fa0bf;font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pc-tag .sl{margin-left:auto;flex:0 0 auto;color:#f0b35e;font-size:9.5px;
  background:rgba(240,179,94,.12);border-radius:3px;padding:0 4px}
.pc-empty{color:#4d5a6e;font-size:11px;padding:10px;text-align:center}

.pc-neg{font-family:Consolas,monospace;font-size:10.5px;color:#9fb0c8;margin-top:7px;
  background:rgba(0,0,0,.25);border:1px solid #2a323d;border-radius:6px;padding:5px 7px;
  max-height:52px;overflow:auto;white-space:pre-wrap;word-break:break-all}
.pc-hint{color:#5d6b82;font-size:10px;line-height:1.6;margin-top:6px}
.pc-err{color:#ff8b7a;font-size:11px}
`;
  document.head.appendChild(s);
}

/* ================= 面板 ================= */

/* ===== 节点面板（2026-09-25 第三次改版：节点加载出来**直接就是完整面板**）=====
   用户原话：「不要这个小面板了，我想一整个节点加载出来就直接是完整面板」。
   所以：节点上不再有「摘要 + 打开按钮」，DOM widget 里放的就是完整面板本体
   （组合 / 槽位池 / 词库浏览 / 档位 四个标签页），节点默认尺寸也直接给到够大。 */
function createPanel(node) {
  const host = el("div", "pc-host");
  let inst = null;
  try {
    /* 不用等 requestAnimationFrame —— 立刻建，避免"先空一块再长出来"的闪烁 */
    inst = openFullPanel(node, host);
  } catch (e) {
    console.error("[prompt-combiner] 面板构建失败", e);
    host.appendChild(el("div", "pc-err", "面板初始化失败：" + e.message));
  }
  return {
    panel: host,
    getMinHeight: () => 780,
    getMaxHeight: () => 4000,
    destroy() {
      try { inst && inst.close(); } catch (e) {}
    },
    /* ⭐ 2026-11-22 修（用户：「提示词可以随机生图了，但预览提示词不生效」）：
       `refreshSeed` 只加在了**内层** openFullPanel 的返回值上，这一层没转出来，
       于是 `node._pcPanel.refreshSeed` 永远是 undefined ——
       「每次随机」换完 seed 后面板纹丝不动（图变了、面板还是上一组词）。
       ⛔ 以后给面板加新能力，**两层都要加**：
          openFullPanel 返回 → createPanel 转发 → node._pcPanel 才拿得到。 */
    refreshSeed: () => { try { inst && inst.refreshSeed && inst.refreshSeed(); } catch (e) {} },
  };
}

/* ================= 注册扩展 ================= */

injectStyles();

app.registerExtension({
  name: "ComfyUI.PromptCombiner",
  /* ⭐ 2026-11-22：把排队出口包一层，实现「每次运行随机抽一次」（见 autoRollInWorkflow）。
     ⚠️ 挂的是 api.queuePrompt，不是 app.queuePrompt —— 前端 1.5x 的「运行」按钮
        走命令系统，压根不碰 app.queuePrompt（第一版就因为这个静默失效）。 */
  async setup() {
    installAutoRollHook();
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const onCreate = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreate?.apply(this, arguments);
      /* 原生 widget 全部隐藏（预设/性别/NSFW/seed/画质/空格/负面档/明细/slots_json）
         —— 这些控制项已经搬到面板顶部了，节点外观只留面板本身。 */
      try { hideNativeWidgets(this); } catch (e) { console.error("[prompt-combiner] 隐藏原生 widget 失败", e); }
      /* ⛔ 2026-10-19（阿君：复现没复现成功）：必须把 seed 的「生成后控制」钉成 fixed，
         否则前端每次排队都随机化 seed，面板显示的 seed 永远不是出图用的那个。 */
      try { pinSeedControl(this); } catch (e) { console.error("[prompt-combiner] 固定 seed 控制失败", e); }
      requestAnimationFrame(() => {
        try {
          const inst = createPanel(this);
          this._pcPanel = inst;
          this.addDOMWidget("pc_panel", "pc-panel", inst.panel, {
            getMinHeight: () => inst.getMinHeight(),
            getMaxHeight: () => inst.getMaxHeight(),
            hideOnZoom: false,
            serialize: false,
          });
          /* 节点现在**直接就是完整面板**，默认就给到够大的尺寸
             （原生 widget 约占 250px 高，面板本身要 740+）。
             ⚠️ 记住：addDOMWidget 后立刻 setSize 会「挂上了但没撑开」，要延迟一拍 + 通知画布重排。 */
          const fit = () => {
            try {
              this.setSize?.([Math.max(this.size?.[0] ?? 0, 1180), Math.max(this.size?.[1] ?? 0, 850)]);
              this.setDirtyCanvas?.(true, true);
              app.graph?.setDirtyCanvas?.(true, true);
            } catch (e) {}
          };
          fit();
          setTimeout(fit, 80);
          setTimeout(fit, 400);
        } catch (e) {
          console.error("[prompt-combiner] 面板挂载失败", e);
        }
      });
    };

    /* ⛔ 2026-09-29：**裁掉工作流里存的老输出口**。
       早期版本 RETURN_NAMES 有过 2~3 个输出（标签组合结果 / 负面提示词 / 本次抽到的标签），
       现在已经只留「标签组合结果」一个；但老工作流的 JSON 里仍然存着那几个 slot，
       LiteGraph `configure()` 会把它们还原回来 ⇒ 用户看到的节点永远挂着 3 个输出口
       （用户原话：「这里的输出接口只留这个标签组合结果就行了，其他 2 个删掉」）。
       ⚠️ 光刷新页面没用（工作流里就存着），必须**加载后按后端定义裁剪**。 */
    const onConf = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      onConf?.apply(this, arguments);
      /* ⛔ 2026-10-19（复现没复现成功的另一半）：
         老工作流的 `widgets_values[4]` 里存着 `'randomize'`，`configure()`
         在 onNodeCreated **之后**按位置把它写回控件 ⇒ 刚钉的 fixed 被冲掉。
         所以加载工作流后必须再钉一次。 */
      try { pinSeedControl(this); } catch (e) { console.error("[prompt-combiner] 固定 seed 控制失败", e); }
      try {
        const decl = nodeData.output_name || nodeData.output || [];
        const want = decl.length;
        if (!want || !Array.isArray(this.outputs) || this.outputs.length <= want) return;
        /* 先把多余输出上的连线摘掉，再截断 —— 直接截会让画布上留半截悬空的线 */
        for (let i = this.outputs.length - 1; i >= want; i--) {
          const o = this.outputs[i];
          (o && o.links ? o.links.slice() : []).forEach((lid) => {
            try { this.disconnectOutput?.(i); } catch (e) {}
            try { this.graph?.removeLink?.(lid); } catch (e) {}
          });
        }
        const dropped = this.outputs.slice(want).map((o) => (o && o.name) || "?");
        this.outputs.length = want;
        if (dropped.length) {
          console.info("[prompt-combiner] 已裁掉老版本遗留的输出口：", dropped.join(" / "));
        }
        try { this.setSize?.(this.computeSize?.() || this.size); } catch (e) {}
        this.setDirtyCanvas?.(true, true);
        app.graph?.setDirtyCanvas?.(true, true);
      } catch (e) { console.error("[prompt-combiner] 裁剪多余输出口失败", e); }
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      /* 顺手停掉 seed 控件的守护轮询，别让被删节点的定时器一直跑 */
      try { clearInterval(this._pcSeedObs); } catch (e) {}
      this._pcSeedObs = null;
      this._pcPanel?.destroy?.();
      onRemoved?.apply(this, arguments);
    };
  },
});

/* ================= 网页一键推送 · 落地端（2026-09-25）=================
   链路：网页点「推送到 ComfyUI」→ POST /pc/push（后端暂存 + seq 自增）
        → 这里轮询 /pc/latest，发现 seq 变了 → 写进画布上所有 PromptReceiver 节点的 widget。

   ⚠️ 为什么必须由前端落笔：后端改不了浏览器里的画布（LiteGraph 在前端）。
   ⚠️ 只在画布上真有 PromptReceiver 节点时才请求，平时零开销。
   ⚠️ 首次轮询只「记位」不刷值，避免把上次推送的旧内容灌进刚拖出来的新节点。 */
let _pcPushSeq = 0;
let _pcPushTimer = null;

function startPushWatcher() {
  if (_pcPushTimer) return;
  _pcPushTimer = setInterval(async () => {
    const nodes = (app.graph?._nodes || []).filter((n) => n.type === "PromptReceiver");
    if (!nodes.length) return;
    try {
      const d = await api("/latest");
      if (!d || typeof d.seq !== "number") return;
      if (_pcPushSeq === 0) { _pcPushSeq = d.seq; return; }
      if (d.seq <= _pcPushSeq) return;
      _pcPushSeq = d.seq;
      nodes.forEach((n) => {
        const wp = n.widgets?.find((w) => w.name === "positive");
        const wn = n.widgets?.find((w) => w.name === "negative");
        if (wp) { wp.value = d.positive || ""; try { wp.callback?.(wp.value); } catch (e) {} }
        if (wn) { wn.value = d.negative || ""; try { wn.callback?.(wn.value); } catch (e) {} }
        n.setDirtyCanvas?.(true, true);
      });
      app.graph?.setDirtyCanvas?.(true, true);
    } catch (e) { /* ComfyUI 重启中之类的，忽略 */ }
  }, 2000);
}

startPushWatcher();

/* ==========================================================================
   全屏完整面板（2026-09-25 用户选定：节点 + 全屏面板）
   ----------------------------------------------------------------------------
   动机：节点容器受尺寸限制（再宽也就 700~900），装不下网页版那套功能。
   做法：另开一个 position:fixed 的 overlay 盖满屏幕，左右两栏
         （左＝控制区：预设/槽位/搜索；右＝结果区：可编辑文本/标签列表/负面词）。
   注意：
     · overlay 挂在 document.body 上，**不受节点尺寸与画布缩放影响**
     · 改的值仍然写回**节点自己的 widget**（slots_json / preset / seed …），
       所以关掉面板后节点照常工作、工作流照常序列化
   ========================================================================== */

/* ⭐ 2026-10-18（阿君：不同标签用不同颜色，节点也要同步）：
   和网页同一套色系。节点结果区是 textarea 没法给单词上色，
   所以把颜色落在**标签 chip** 上（边框 + 槽位徽章同色），一眼能分出类别。 */
const PC_SLOT_HUE = [
  { c: "94,224,214",  slots: ["角色"] },
  { c: "255,183,94",  slots: ["表情", "眼睛", "发型", "发色", "人物特征"] },
  { c: "122,168,255", slots: ["上装", "下装", "连衣裙与制服", "泳装与贴身衣物",
                              "袖型与领口", "装饰与材质", "腿部服饰"] },
  { c: "186,140,255", slots: ["鞋子", "袜子", "首饰", "头饰配件"] },
  { c: "126,220,140", slots: ["基础姿势", "动作", "手臂与手势",
                              "身体与头部协调", "双人互动", "人物朝向"] },
  { c: "236,220,110", slots: ["场景", "光照", "动物", "植物", "载具", "道具", "手持物"] },
  { c: "150,190,230", slots: ["景别", "相机方位", "构图", "镜头", "景深", "运镜", "动态效果"] },
  { c: "232,180,120", slots: ["作品", "画师", "配色倾向", "画风取向"] },
  { c: "160,170,185", slots: ["人数"] },
];
function pcSlotHue(slot) {
  const v = String(slot || "");
  for (const g of PC_SLOT_HUE) if (g.slots.indexOf(v) >= 0) return g.c;
  return "130,150,175";
}

/* ⭐ 2026-10-18（阿君：让节点界面更美观，可以加点特效）
   **只加视觉层**：渐变/阴影/动效，不改任何尺寸与布局 —— 出问题删掉这个函数即可回退。
   · 动效全部走 transform/opacity（GPU），并且尊重 prefers-reduced-motion
   · 不做无限旋转边框那种吃 CPU 的效果 */
function injectPolishStyles() {
  if (document.getElementById("pc-polish")) return;
  const st = document.createElement("style");
  st.id = "pc-polish";
  st.textContent = `
/* ============================================================
   UI v2 —— 参考 Linear / Raycast / Vercel Geist 的暗色工具风：
   一层层"卡片"叠在深底上，边线极淡、圆角统一、强调色只出现在关键处。
   **只覆盖颜色/圆角/边框/阴影/间距**，不动 display/position/flex，
   所以不可能把布局搞塌。整块删掉即回退。
   ============================================================ */
.pc-root{
  --pc-bg:#090b10;
  --pc-card:#12151d;
  --pc-card2:#161a24;
  --pc-line:rgba(255,255,255,.065);
  --pc-line2:rgba(255,255,255,.11);
  --pc-ink:#dde5f2;
  --pc-dim:#8b97ab;
  --pc-acc:#5ee0d6;
  --pc-acc2:#a78bfa;
  --pc-r:12px;
  background:
    radial-gradient(900px 260px at 8% -12%, rgba(94,224,214,.10), transparent 62%),
    radial-gradient(760px 240px at 96% -6%, rgba(167,139,250,.10), transparent 62%),
    var(--pc-bg) !important;
  color: var(--pc-ink) !important;
  font-family: "Inter","Segoe UI Variable","Segoe UI",system-ui,"Microsoft YaHei",sans-serif !important;
  font-size:12.5px !important;
  letter-spacing:.1px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.045), 0 18px 50px rgba(0,0,0,.45) !important;
}
/* ---------- 顶栏 ---------- */
.pc-full-head{
  background: rgba(12,15,21,.72) !important;
  backdrop-filter: blur(10px) saturate(1.2);
  border-bottom:1px solid var(--pc-line) !important;
  position:relative;
}
.pc-full-head::after{
  content:""; position:absolute; left:0; right:0; bottom:-1px; height:1px;
  background: linear-gradient(90deg, transparent, rgba(94,224,214,.6), rgba(167,139,250,.5), transparent);
  opacity:.9;
}
.pc-full-title{ font-weight:650; letter-spacing:.3px; text-shadow:0 0 16px rgba(94,224,214,.28); }
.pc-full-sub{ color: var(--pc-dim) !important; }

/* ---------- 卡片：分层 + 极淡边 ---------- */
.pc-wcard{
  background: var(--pc-card) !important;
  border:1px solid var(--pc-line) !important;
  border-radius: var(--pc-r) !important;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.035), 0 2px 10px rgba(0,0,0,.22) !important;
  transition: border-color .15s ease, box-shadow .15s ease;
}
.pc-wcard:hover{ border-color: var(--pc-line2) !important; }

/* ---------- 按钮：三级 ---------- */
.pc-wbtn{
  border-radius:9px !important;
  border:1px solid rgba(255,255,255,.09) !important;
  background: rgba(255,255,255,.035) !important;
  color: var(--pc-ink) !important;
  font-weight:550;
  transition: transform .12s ease, box-shadow .12s ease, background .12s ease, border-color .12s ease;
}
.pc-wbtn:hover{ background: rgba(255,255,255,.07) !important; border-color: var(--pc-line2) !important; transform: translateY(-1px); }
.pc-wbtn:active{ transform: translateY(0); }
.pc-wbtn.pri{
  background: linear-gradient(180deg,#39c9bd,#1f9c93) !important;
  border-color: rgba(94,224,214,.55) !important;
  color:#04201e !important;
  font-weight:700;
  box-shadow: 0 2px 12px rgba(57,201,189,.30), inset 0 1px 0 rgba(255,255,255,.28) !important;
}
.pc-wbtn.pri:hover{ box-shadow: 0 5px 18px rgba(57,201,189,.42), inset 0 1px 0 rgba(255,255,255,.32) !important; }
.pc-wbtn.warn{ color:#ffb4a2 !important; border-color:rgba(255,120,90,.32) !important; }
.pc-wbtn.warn:hover{ background: rgba(255,120,90,.12) !important; box-shadow:0 3px 14px rgba(255,120,90,.18); }

/* ---------- 胶囊 chip ---------- */
.pc-wchip{
  border-radius:999px !important;
  border:1px solid rgba(255,255,255,.10) !important;
  background: rgba(255,255,255,.03) !important;
  color: var(--pc-dim) !important;
  transition: all .14s ease;
}
.pc-wchip:hover{ color: var(--pc-ink) !important; border-color: var(--pc-line2) !important; transform: translateY(-1px); }
.pc-wchip.on{
  color:#82eee5 !important;
  background: rgba(94,224,214,.13) !important;
  border-color: rgba(94,224,214,.45) !important;
  font-weight:600;
  box-shadow: inset 0 0 0 1px rgba(94,224,214,.10), 0 0 14px rgba(94,224,214,.10);
}

/* ---------- 标签卡片：胶囊 + 左侧类别色点 ---------- */
.pc-wtags{ gap:6px !important; }
.pc-wtag{
  border-radius:999px !important;
  border:1px solid rgba(255,255,255,.10) !important;
  background: rgba(255,255,255,.028) !important;
  padding:3px 9px 3px 8px !important;
  font-size:11.5px !important;
  position:relative;
  transition: transform .12s ease, box-shadow .12s ease, border-color .12s ease, background .12s ease;
  animation: pcTagIn .18s ease both;
}
.pc-wtag{
  border-color: rgba(var(--pc-hue, 255,255,255), .22) !important;
  color:#e7eefb !important;                       /* 文字中性色，别整块染色 */
}
.pc-wtag .s{                                      /* 槽位徽章用类别色淡染 */
  color: rgb(var(--pc-hue, 160,175,200)) !important;
  background: rgba(var(--pc-hue, 160,175,200), .14) !important;
  border-radius:999px !important;
  padding:0 6px !important;
}
.pc-wtag .c{ color:#93a1b6 !important; opacity:1 !important; }
.pc-wtag::before{
  content:""; flex:0 0 auto; width:6px; height:6px; border-radius:50%;
  background: rgb(var(--pc-hue, 200,210,225));
  box-shadow: 0 0 8px rgba(var(--pc-hue, 200,210,225), .55);
  margin-right:1px;
}
.pc-wtag:hover{ border-color: rgba(var(--pc-hue, 255,255,255), .55) !important; }
.pc-wtag .e{ font-weight:600; }
.pc-wtag .c{ opacity:.62 !important; }
.pc-wtag:hover{
  background: rgba(255,255,255,.06) !important;
  border-color: var(--pc-line2) !important;
  transform: translateY(-1px);
  box-shadow: 0 6px 18px rgba(0,0,0,.35);
}
.pc-wtag.sel{
  border-color: rgba(94,224,214,.85) !important;
  background: rgba(94,224,214,.14) !important;
  box-shadow: 0 0 0 1px rgba(94,224,214,.35), 0 0 18px rgba(94,224,214,.22);
}
@keyframes pcTagIn{ from{ opacity:0; transform:translateY(3px) scale(.98);} to{ opacity:1; transform:none;} }

/* ---------- 槽位格子 ---------- */
.pc-wslot{
  border-radius:9px !important;
  border:1px solid rgba(255,255,255,.075) !important;
  background: rgba(255,255,255,.022) !important;
  transition: border-color .14s ease, background .14s ease, box-shadow .14s ease;
}
.pc-wslot:hover{ border-color: rgba(94,224,214,.45) !important; background: rgba(94,224,214,.05) !important; }
.pc-wslot.on{
  border-color: rgba(94,224,214,.42) !important;
  background: linear-gradient(180deg, rgba(94,224,214,.12), rgba(94,224,214,.05)) !important;
  box-shadow: inset 2px 0 0 var(--pc-acc), 0 0 12px rgba(94,224,214,.10) !important;
}
.pc-wgname{ color: var(--pc-dim) !important; letter-spacing:.5px; font-size:10.5px !important; }

/* ---------- 输入 / 文本域 ---------- */
.pc-winput, #pcGText, .pc-cnbox{
  background:#0b0e15 !important;
  border:1px solid rgba(255,255,255,.08) !important;
  border-radius:10px !important;
  color: var(--pc-ink) !important;
  box-shadow: inset 0 1px 3px rgba(0,0,0,.35);
  transition: border-color .14s ease, box-shadow .14s ease;
}
#pcGText{
  line-height:1.72 !important;
  font-family: ui-monospace,"Cascadia Mono","JetBrains Mono",Consolas,monospace !important;
  font-size:12px !important;
}
.pc-winput:focus, #pcGText:focus{
  border-color: rgba(94,224,214,.7) !important;
  box-shadow: 0 0 0 3px rgba(94,224,214,.12), 0 0 20px rgba(94,224,214,.10) !important;
  outline:none !important;
}
.pc-cnbox{ color:#a9b6c9 !important; line-height:1.8 !important; }

/* ---------- 滚动条 ---------- */
.pc-wpane::-webkit-scrollbar, .pc-wtags::-webkit-scrollbar, .pc-cnbox::-webkit-scrollbar,
#pcGGroups::-webkit-scrollbar, #pcGText::-webkit-scrollbar{ width:10px; height:10px; }
.pc-wpane::-webkit-scrollbar-thumb, .pc-wtags::-webkit-scrollbar-thumb, .pc-cnbox::-webkit-scrollbar-thumb,
#pcGGroups::-webkit-scrollbar-thumb, #pcGText::-webkit-scrollbar-thumb{
  background: rgba(140,160,190,.22); border-radius:10px; border:3px solid transparent; background-clip:padding-box;
}
.pc-wpane::-webkit-scrollbar-thumb:hover, #pcGText::-webkit-scrollbar-thumb:hover{
  background: rgba(94,224,214,.42); background-clip:padding-box;
}
.pc-wpane::-webkit-scrollbar-track{ background: transparent; }

/* ---------- seed 徽章 / 小标注 ---------- */
.pc-wseed{ border-radius:999px !important; color: var(--pc-dim) !important; }
.pc-wseed:hover{ color: var(--pc-acc) !important; background: rgba(94,224,214,.12) !important; }
.pc-wsub, .pc-whint{ color: var(--pc-dim) !important; }

/* ---------- 反向同步：隐藏镜像层 + 卡片悬停高亮 ---------- */
.pc-mirror{
  position:absolute; left:-99999px; top:0; visibility:hidden; pointer-events:none;
  white-space:pre-wrap; word-break:break-word; overflow-wrap:break-word;
  box-sizing:content-box; padding:0; border:0; margin:0;
}
.pc-wtag.hl{
  border-color: rgba(94,224,214,.9) !important;
  background: rgba(94,224,214,.16) !important;
  box-shadow: 0 0 0 1px rgba(94,224,214,.35), 0 0 16px rgba(94,224,214,.22) !important;
}

/* ---------- 标题栏右侧：作者 + 社交链接 ---------- */
.pc-head-author{
  display:inline-flex; align-items:center; gap:6px; margin-right:10px;
  font-size:11px; color:var(--pc-dim); white-space:nowrap;
}
.pc-head-author .who{ color:#8ef0e6; font-weight:600; letter-spacing:.2px; }
.pc-head-author .lnk{
  display:inline-flex; align-items:center;
  padding:1px 8px; border-radius:999px; cursor:pointer;
  border:1px solid rgba(94,224,214,.30);
  color:#93eee6; background:rgba(94,224,214,.09);
  font-size:10.5px;
  transition: background .12s ease, transform .12s ease, box-shadow .12s ease;
}
.pc-head-author .lnk:hover{
  background:rgba(94,224,214,.20); transform:translateY(-1px);
  box-shadow:0 4px 14px rgba(94,224,214,.20);
}

/* ---------- 整体入场 ---------- */
@keyframes pcRootIn{ from{ opacity:0; transform: translateY(8px) scale(.995);} to{ opacity:1; transform:none;} }
.pc-root{ animation: pcRootIn .24s cubic-bezier(.2,.7,.3,1) both; }

/* ---------- 无障碍：减少动态 ---------- */
@media (prefers-reduced-motion: reduce){
  .pc-root, .pc-wtag{ animation:none !important; }
  .pc-wbtn:hover, .pc-wchip:hover, .pc-wtag:hover{ transform:none !important; }
}
`;
  document.head.appendChild(st);
}

/* 2026-10-18：底部作者栏（链接来自文件顶部 PC_AUTHOR） */
function renderAuthorBar(wrap) {
  const bar = wrap.querySelector("#pcAuthorBar");
  if (!bar) return;
  bar.replaceChildren();

  const who = document.createElement("span");
  who.className = "who";
  who.textContent = "👤 " + (PC_AUTHOR.name || "作者");
  who.title = PC_AUTHOR.tagline || "";
  bar.appendChild(who);

  (PC_AUTHOR.links || []).forEach((l) => {
    if (!l || !l.url) return;                 // 没配链接就不摆空按钮
    const a = document.createElement("span");
    a.className = "lnk";
    a.textContent = l.label;
    a.title = l.label + "：" + l.url;
    a.onclick = (ev) => {
      ev.stopPropagation();
      try { window.open(l.url, "_blank", "noopener,noreferrer"); }
      catch (e) { try { navigator.clipboard.writeText(l.url); } catch (e2) {} }
    };
    bar.appendChild(a);
  });
}

function injectFullStyles() {
  if (document.getElementById("pc-full-styles")) return;
  const s = document.createElement("style");
  s.id = "pc-full-styles";
  s.textContent = `
.pc-full{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;
  background:rgba(4,6,10,.72);backdrop-filter:blur(3px);padding:18px}
.pc-full-win{width:min(1480px,100%);height:min(94vh,1000px);display:flex;flex-direction:column;
  background:#0e1219;border:1px solid #333c4a;border-radius:12px;overflow:hidden;
  box-shadow:0 24px 70px rgba(0,0,0,.7);color:#d7dfeb;
  font:13px/1.55 system-ui,"Microsoft YaHei",sans-serif}
.pc-full-head{display:flex;align-items:center;gap:10px;padding:11px 16px;
  border-bottom:1px solid #2a323d;background:rgba(255,255,255,.02)}
.pc-full-title{font-size:15px;font-weight:700;color:#5ee0d6}
.pc-full-sub{font-size:11px;color:#6b7a93}
.pc-full-close{margin-left:auto;padding:5px 15px;border-radius:7px;border:1px solid #3a4250;
  background:#1b2028;color:#c9d3e2;cursor:pointer;font-size:12px}
.pc-full-close:hover{border-color:#ff8b7a;color:#ff8b7a}
.pc-full-body{flex:1;display:flex;min-height:0}
/* 左栏 */
.pc-full-left{width:400px;flex:0 0 400px;border-right:1px solid #2a323d;
  display:flex;flex-direction:column;min-height:0}
.pc-full-left-inner{flex:1;overflow:auto;padding:11px 13px}
.pc-full-right{flex:1;display:flex;flex-direction:column;min-height:0;padding:11px 13px;gap:9px}
/* 通用小块 */
.pc-fsec{margin-bottom:13px}
.pc-fsec-h{display:flex;align-items:center;gap:7px;margin-bottom:6px}
.pc-fsec-t{color:#f0b35e;font-size:12px;font-weight:600;flex:1 1 auto}
.pc-mini2{padding:2px 9px;border-radius:5px;border:1px solid #3a4250;background:#1b2028;
  color:#9fb0c8;cursor:pointer;font-size:10.5px}
.pc-mini2:hover{border-color:#5ee0d6;color:#8ff0e6}
.pc-fgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:5px}
.pc-fslot{display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:6px;
  border:1px solid #2f3846;background:#161b23;cursor:pointer;user-select:none;
  font-size:12px;color:#8b9ab0;min-width:0}
.pc-fslot:hover{border-color:#5ee0d6;color:#c9d3e2}
.pc-fslot.on{background:rgba(94,224,214,.14);border-color:#5ee0d6;color:#a8f0e8}
.pc-fslot .d{width:6px;height:6px;border-radius:50%;background:#3a4250;flex:0 0 auto}
.pc-fslot.on .d{background:#5ee0d6}
.pc-fslot .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pc-fchip{padding:4px 13px;border-radius:999px;border:1px solid #3a4250;background:#1b2028;
  color:#c9d3e2;cursor:pointer;font-size:12px;white-space:nowrap}
.pc-fchip:hover{border-color:#5ee0d6}
.pc-fchip.on{background:rgba(94,224,214,.16);border-color:#5ee0d6;color:#8ff0e6;font-weight:600}
/* 右栏 */
.pc-frow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pc-fbtn{padding:5px 14px;border-radius:7px;border:1px solid #3a4250;background:#1b2028;
  color:#c9d3e2;cursor:pointer;font-size:12px}
.pc-fbtn:hover{border-color:#5ee0d6;color:#8ff0e6}
.pc-fbtn.pri{background:rgba(94,224,214,.16);border-color:#5ee0d6;color:#8ff0e6;font-weight:600}
.pc-fbtn:disabled{opacity:.5;cursor:default}
.pc-ftext{width:100%;box-sizing:border-box;min-height:110px;resize:vertical;
  background:#0b0e14;border:1px solid #2a323d;border-radius:8px;padding:9px 11px;
  color:#e7eef8;font:12.5px/1.65 Consolas,monospace;outline:none}
.pc-ftext:focus{border-color:#5ee0d6}
.pc-flist{flex:1;min-height:70px;overflow:auto;border:1px solid #2a323d;border-radius:8px;
  background:rgba(0,0,0,.22);padding:5px 7px}
.pc-ftag{display:flex;align-items:baseline;gap:8px;padding:3px 4px;border-radius:5px}
.pc-ftag:hover{background:rgba(94,224,214,.06)}
.pc-ftag .i{color:#4d5a6e;font-size:10.5px;flex:0 0 20px;text-align:right}
.pc-ftag .e{font-family:Consolas,monospace;color:#5ee0d6;font-size:12px;word-break:break-all;flex:0 1 auto}
.pc-ftag .c{color:#8fa0bf;font-size:11px;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pc-ftag .s{color:#f0b35e;font-size:10px;background:rgba(240,179,94,.12);border-radius:3px;padding:0 5px;flex:0 0 auto}
.pc-ftag .x{margin-left:auto;flex:0 0 auto;color:#4d5a6e;cursor:pointer;font-size:14px;padding:0 4px;line-height:1}
.pc-ftag .x:hover{color:#ff8b7a}
.pc-fhint{color:#5d6b82;font-size:11px;line-height:1.6}
.pc-fempty{color:#4d5a6e;font-size:12px;text-align:center;padding:14px}
/* ===== 内嵌模式：容器就是节点里那块 DOM widget ===== */
.pc-host{width:100%;height:100%;min-height:740px;box-sizing:border-box}
.pc-root{width:100%;height:100%;min-height:740px;box-sizing:border-box;display:flex;
  background:rgba(12,15,22,.88);border:1px solid #333c4a;border-radius:8px;overflow:hidden;
  color:#d7dfeb;font:12px/1.5 system-ui,"Microsoft YaHei",sans-serif}
/* ⚠️ 2026-10-18（阿君：标题上面还露着 anima_mode / 画质 那一小节）：
   那是 **ComfyUI 节点自己画的参数区**，不是面板元素；不能删（删了设置存不进工作流），
   所以把面板整体上移一点**盖住它**。数值 = 那一条的高度。
   如果不同前端/缩放对不上，改这一个负值即可。 */
.pc-root{margin-top:-34px;padding-top:34px;height:calc(100% + 34px);background-clip:padding-box}
/* 内嵌时让内层窗口铺满（去掉弹层的固定尺寸/圆角/阴影） */
.pc-root .pc-full-win{width:100%;height:100%;max-height:none;border:none;border-radius:0;
  box-shadow:none;background:transparent}
.pc-root .pc-full-title{font-size:14px}
/* ===== 组合页：照网页版的单列布局（2026-09-29）===== */
.pc-wpane{flex-direction:column;overflow:auto;padding:10px 12px;gap:9px}
.pc-wbar{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.pc-wsp{flex:1 1 auto}
.pc-wbtn{padding:5px 13px;border-radius:7px;border:1px solid #3a4250;background:#1b2028;
  color:#c9d3e2;cursor:pointer;font-size:12px;white-space:nowrap}
.pc-wbtn:hover{border-color:#5ee0d6;color:#8ff0e6}
.pc-wbtn.pri{background:rgba(94,224,214,.16);border-color:#5ee0d6;color:#8ff0e6;font-weight:600}
.pc-wbtn.warn{border-color:#5a3a3a;color:#e08c8c}
.pc-wbtn.warn:hover{border-color:#ff8b7a;color:#ff8b7a}
.pc-wbtn.sm{padding:3px 9px;font-size:11px;border-radius:5px}
.pc-wbtn:disabled{opacity:.45;cursor:default}
.pc-wbtn.on{background:rgba(94,224,214,.16);border-color:#5ee0d6;color:#8ff0e6}
.pc-wbtn i{font-style:normal;color:#f0b35e;margin-left:3px}
.pc-wchip{padding:4px 12px;border-radius:999px;border:1px solid #3a4250;background:#1b2028;
  color:#c9d3e2;cursor:pointer;font-size:11.5px;white-space:nowrap;user-select:none}
.pc-wchip:hover{border-color:#5ee0d6}
.pc-wchip.on{background:rgba(94,224,214,.16);border-color:#5ee0d6;color:#8ff0e6;font-weight:600}
.pc-wchip.add{border-style:dashed;color:#8b9ab0}
.pc-helpbox{margin:2px 0 6px;border:1px solid #2a323d;border-radius:8px;background:#12171e;
  padding:8px 11px;font-size:11.5px;line-height:1.8;color:#c8d4e6}
.pc-helphead{display:flex;align-items:center;font-size:12px;color:#5ee0d6;margin-bottom:4px}
.pc-helpclose{cursor:pointer;color:#6b7a93;font-size:11px}
.pc-helpclose:hover{color:#5ee0d6}
.pc-helpbody p{margin:3px 0}
.pc-k{display:inline-block;background:#1a212b;border:1px solid #2a323d;border-radius:4px;
  padding:0 5px;font-size:10.5px;color:#f0b35e;white-space:nowrap}
.pc-wchips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.pc-wrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pc-wlab{color:#7f8ea8;font-size:11.5px;flex:0 0 auto}
.pc-wlab2{color:#333c4a}
.pc-winput{background:#161b23;border:1px solid #3a4250;color:#d7dfeb;border-radius:6px;
  padding:5px 9px;font-size:12px;outline:none;flex:1 1 220px;min-width:160px}
.pc-winput:focus{border-color:#5ee0d6}
.pc-wcard{border:1px solid #2a323d;border-radius:9px;background:rgba(255,255,255,.015);
  padding:8px 10px}
.pc-wcardhead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:7px}
/* 2026-10-18（阿君）：槽位区也能自由拖高 —— 只拖列表本体，标题行固定在上面 */
#pcGGroups{height:auto;min-height:0;max-height:none;overflow:auto;resize:vertical;
  padding-right:2px;flex:0 0 auto}
.pc-wtitle{color:#5ee0d6;font-size:13px;font-weight:700}
.pc-wsub{color:#6b7a93;font-size:11px}
/* 历史计数「第几组 / 共几组」（对齐网页 #histStat：12px 暗色、min-width 50、居中） */
.pc-whist{font-size:12px;color:#8b9ab0;min-width:52px;text-align:center;flex:0 0 auto;
  font-variant-numeric:tabular-nums}
.pc-whint{color:#5d6b82;font-size:10.5px}
.pc-wtext{width:100%;box-sizing:border-box;height:auto;min-height:88px;resize:vertical;
  background:#0b0e14;border:1px solid #2a323d;border-radius:7px;padding:8px 10px;
  color:#e7eef8;font:12.5px/1.65 Consolas,monospace;outline:none}
.pc-wtext:focus{border-color:#5ee0d6}
.pc-wtags{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px;height:auto;min-height:0;
  max-height:none;overflow:auto;resize:vertical;flex:0 0 auto}
/* 空的时候不留白（阿君截图：清空组合后下面一大截空白） */
.pc-wtags:empty{display:none}
/* 2026-10-14：词库/槽位池的词格可点选进组合（对齐网页 .sel 高亮 + 手型光标） */
.pc-wtag.cli{cursor:pointer}
.pc-wtag.cli:hover{border-color:#5ee0d6}
.pc-wtag.sel{background:rgba(94,224,214,.14);border-color:#5ee0d6}
/* ⛔ 2026-10-05：原来整个标签 cursor:pointer + onclick=删掉，用户误触一下词就没了。
   现在点标签本身不做事，删除只认右边的 ×（对齐网页 .ctag .x）。 */
.pc-wtag{display:inline-flex;align-items:center;gap:5px;padding:2px 6px;border-radius:6px;
  background:#1e2530;border:1px solid #333c4a}
.pc-wtag:hover{border-color:#ff8b7a}
.pc-wtag .e{font-family:Consolas,monospace;color:#5ee0d6;font-size:11.5px}
.pc-wtag .c{color:#8fa0bf;font-size:10.5px}
/* 🔒 锁定 / × 删除（对齐网页 .ctag .lock-btn / .ctag .x） */
.pc-wtag .lk{cursor:pointer;color:#6b7a93;font-size:10.5px;line-height:1;padding:0 1px;
  display:inline-flex;align-items:center;justify-content:center;user-select:none}
.pc-wtag .lk:hover{color:#5ee0d6}
.pc-wtag .lk svg{display:block}
.pc-wtag .x{cursor:pointer;color:#6b7a93;font-size:13px;line-height:1;padding:0 2px;user-select:none}
.pc-wtag .x:hover{color:#ff8b7a}
.pc-wtag.locked{border-color:#5ee0d6;background:rgba(94,224,214,.09)}
.pc-wtag.locked .lk{color:#5ee0d6}
/* ⭐ 2026-10-08：标签上的「🎲 只换这个槽」（和 🔒/× 同排，样式对齐） */
.pc-wtag .re{cursor:pointer;color:#6b7a93;font-size:10.5px;line-height:1;padding:0 1px;
  display:inline-flex;align-items:center;justify-content:center;user-select:none}
.pc-wtag .re:hover{color:#ffd479}
/* ⭐ 2026-10-08：seed 回查（结果区标题栏） */
.pc-wseed{font-family:Consolas,monospace;font-size:10.5px;color:#7fd8cf;cursor:pointer;
  background:rgba(94,224,214,.08);border:1px solid rgba(94,224,214,.25);border-radius:4px;
  padding:1px 6px;white-space:nowrap;flex:0 0 auto}
.pc-wseed:hover{background:rgba(94,224,214,.18);border-color:#5ee0d6}
.pc-wseedin{width:96px !important;font-size:11px;padding:2px 6px;flex:0 0 auto}
/* seed 归属提示条（2026-10-19 阿君：「不告诉我要切回极简，那我不就一直不知道了」）
   粘进输入框就立刻显示这个 seed 原来是哪个档位抽的，不用等点完复现才发现不对。 */
.pc-seedhint{margin:6px 0 2px;padding:4px 9px;border-radius:6px;font-size:11.5px;
  line-height:1.5;display:none;border:1px solid transparent}
.pc-seedhint.on{display:block}
.pc-seedhint.warn{background:rgba(239,159,39,.10);border-color:rgba(239,159,39,.45);color:#f0b862}
.pc-seedhint.ok{background:rgba(29,158,117,.10);border-color:rgba(29,158,117,.40);color:#5fd0a5}
.pc-seedhint.miss{background:rgba(136,135,128,.10);border-color:rgba(136,135,128,.35);color:#9aa4b2}
.pc-seedhint b{font-weight:500;color:#fff}
/* 中文对照行（对齐网页 #cnRow + #cnInline，2026-10-05 加） */
.pc-cnrow{margin-top:8px}
.pc-exprow{margin-top:8px}
.pc-explab{display:flex;align-items:center;gap:6px;flex-wrap:wrap;color:#6b7a93;font-size:10.5px;margin-bottom:4px}
.pc-wselect{background:#161b23;border:1px solid #3a4250;color:#d7dfeb;border-radius:6px;padding:4px 6px;font-size:11px;outline:none}
.pc-expbox{white-space:pre-wrap;line-height:1.65;background:#0b0e14;border:1px solid #2a323d;border-radius:7px;
  padding:7px 9px;color:#c8d4e6;font-size:12px;max-height:180px;overflow:auto;min-height:22px}
.pc-cnlab{display:flex;align-items:center;gap:6px;color:#6b7a93;font-size:10.5px;margin-bottom:4px}
.pc-cnbox{white-space:pre-wrap;line-height:1.65;background:#0b0e14;border:1px solid #2a323d;
  border-radius:7px;padding:7px 9px;color:#c8d4e6;font-size:12px;
  height:auto;min-height:0;max-height:none;overflow:auto;resize:vertical;flex:0 0 auto}
.pc-wtag .s{color:#f0b35e;font-size:9.5px;background:rgba(240,179,94,.13);
  border-radius:3px;padding:0 4px;white-space:nowrap}
.pc-wtag .p{color:#6b7a93;font-size:9.5px;background:rgba(255,255,255,.04);
  border-radius:3px;padding:0 4px;white-space:nowrap}
/* 收藏夹列表（默认收着，点「★ 收藏夹」展开） */
.pc-wfav{display:none;margin-top:8px;max-height:238px;overflow:auto;
  border:1px solid #262e39;border-radius:8px;background:#12171e;padding:7px}
.pc-wfav.on{display:block}
.pc-fav-item{padding:6px 8px;border-radius:7px;margin-bottom:5px;
  background:#1b2028;border:1px solid #262d38}
.pc-fav-item:last-child{margin-bottom:0}
.pc-fav-head{color:#6b7a93;font-size:10.5px;margin-bottom:5px}
.pc-fav-tags{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:5px}
.pc-fav-tag{display:inline-flex;align-items:baseline;gap:4px;padding:1px 6px;
  border-radius:5px;background:#20262f;border:1px solid #2a3140}
.pc-fav-tag .e{font-family:Consolas,monospace;color:#5ee0d6;font-size:10.5px}
.pc-fav-tag .c{color:#8fa0bf;font-size:10px}
.pc-fav-acts{display:flex;gap:5px}
/* 单词收藏（2026-10-19）：一条一个词，点一下直接锁进当前组合 */
.pc-wfavsec{display:flex;align-items:center;gap:6px;margin:2px 0 6px;
  color:#f0b35e;font-size:10.5px;font-weight:500}
.pc-wfavsec .s{flex:1;height:1px;background:#262e39}
.pc-wfavsec .n{color:#6b7a93;font-weight:400}
.pc-wordfav{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:9px}
.pc-wordfav .w{display:inline-flex;align-items:center;gap:5px;padding:2px 4px 2px 8px;
  border-radius:6px;background:#1b2028;border:1px solid #2a3140;cursor:pointer}
.pc-wordfav .w:hover{border-color:#5ee0d6;background:rgba(94,224,214,.10)}
.pc-wordfav .w .e{font-family:Consolas,monospace;color:#5ee0d6;font-size:10.5px}
.pc-wordfav .w .u{color:#8fa0bf;font-size:10px}
.pc-wordfav .w .x{color:#6b7a93;font-size:11px;padding:0 3px;border-radius:3px}
.pc-wordfav .w .x:hover{color:#ff6b6b;background:rgba(255,107,107,.14)}
/* 槽位分组（网页版那种卡片 + 每槽一格） */
.pc-wgroup{border:1px solid #262e39;border-radius:8px;margin-bottom:7px;overflow:hidden}
.pc-wgrouphead{display:flex;align-items:center;gap:8px;padding:5px 9px;cursor:pointer;
  background:rgba(255,255,255,.025)}
.pc-wgrouphead:hover{background:rgba(94,224,214,.06)}
.pc-wgname{color:#f0b35e;font-size:11.5px;font-weight:600}
.pc-wgcnt{color:#6b7a93;font-size:10.5px;margin-left:auto}
.pc-wslots{display:flex;flex-wrap:wrap;gap:6px;padding:7px 9px}
.pc-wslot{display:flex;align-items:center;gap:7px;padding:4px 10px;border-radius:7px;
  border:1px solid #2f3846;background:#141922;cursor:pointer;user-select:none;font-size:12px;min-width:0}
.pc-wslot:hover{border-color:#5ee0d6}
.pc-wslot.on{border-color:#5ee0d6;background:rgba(94,224,214,.11)}
.pc-wslot .d{width:7px;height:7px;border-radius:50%;background:#3a4250;flex:0 0 auto}
.pc-wslot.on .d{background:#34d399;box-shadow:0 0 6px rgba(52,211,153,.75)}
.pc-wslot .n{color:#c9d3e2;font-weight:600;white-space:nowrap}
.pc-wslot.on .n{color:#a8f0e8}
.pc-wslot .c{color:#6b7a93;font-size:10.5px;white-space:nowrap}
.pc-wgroup.pc-folded .pc-wslots{display:none}
/* 槽位管理弹窗 */
.pc-smmask{position:fixed;inset:0;z-index:100004;display:flex;align-items:center;justify-content:center;
  background:rgba(4,6,10,.72);backdrop-filter:blur(3px);padding:18px}
.pc-smwin{width:min(880px,100%);max-height:90vh;display:flex;flex-direction:column;
  background:#0e1219;border:1px solid #333c4a;border-radius:12px;overflow:hidden;
  box-shadow:0 24px 70px rgba(0,0,0,.7);color:#d7dfeb;
  font:12px/1.55 system-ui,"Microsoft YaHei",sans-serif}
.pc-smhead{display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid #2a323d}
.pc-smsub{font-size:11px;color:#6b7a93}
.pc-smbody{padding:12px 14px;overflow:auto;display:flex;flex-direction:column;gap:10px}
.pc-smsec{border:1px solid #2a323d;border-radius:8px;padding:8px 10px;background:rgba(255,255,255,.014)}
.pc-smsec-t{color:#f0b35e;font-size:12px;font-weight:600;margin-bottom:6px}
.pc-smsec-t small{color:#6b7a93;font-weight:400}
.pc-smrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
/* 底部操作条：贴住弹窗底边，不留空档 */
.pc-smfoot{display:flex;flex-direction:column;gap:4px;padding:8px 14px 9px;
  border-top:1px solid #2a323d;background:rgba(0,0,0,.22);flex:0 0 auto}
.pc-smfoot .pc-smsec{border:none;background:transparent;padding:0}
.pc-smfoot .pc-smsec-t{margin-bottom:4px}
.pc-smtag{font-size:10px;padding:1px 6px;border-radius:4px;background:rgba(240,179,94,.12);
  color:#f0b35e;border:1px solid rgba(240,179,94,.25);flex:0 0 auto}
.pc-smname{color:#a8f0e8;font-size:12px;font-weight:600;flex:0 0 auto}
/* 句式模板模态框 */
.pc-tplmask{position:fixed;inset:0;z-index:100003;display:flex;align-items:center;justify-content:center;
  background:rgba(4,6,10,.72);backdrop-filter:blur(3px);padding:18px}
.pc-tplwin{width:min(820px,100%);max-height:88vh;display:flex;flex-direction:column;
  background:#0e1219;border:1px solid #333c4a;border-radius:12px;overflow:hidden;
  box-shadow:0 24px 70px rgba(0,0,0,.7);color:#d7dfeb;
  font:12px/1.55 system-ui,"Microsoft YaHei",sans-serif}
.pc-tplhead{display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid #2a323d}
.pc-tplbody{padding:12px 14px;overflow:auto;display:flex;flex-direction:column;gap:6px}
.pc-tplpv{padding:8px 10px;border-radius:7px;background:rgba(0,0,0,.28);border:1px solid #2a323d;
  color:#a8d8d2;font-size:12px;line-height:1.7;white-space:pre-wrap;max-height:150px;overflow:auto}
.pc-tplrow{display:flex;gap:9px;justify-content:flex-end;margin-top:6px}
.pc-whint{white-space:pre-wrap}
/* 全局剔除区（槽位池页顶部） */
.pc-gksec{padding:7px 9px;margin-bottom:9px;border:1px dashed #3a4250;border-radius:8px;
  background:rgba(255,255,255,.015)}
.pc-gkbox{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px;max-height:110px;overflow:auto}
.pc-gktag{display:inline-flex;align-items:center;gap:5px;padding:2px 7px;border-radius:6px;
  background:#241a1a;border:1px solid #4a3333}
.pc-gktag .e{font-family:Consolas,monospace;color:#e08c8c;font-size:11.5px}
.pc-gktag .c{color:#8fa0bf;font-size:10.5px}
.pc-gktag .x{color:#6b7a93;cursor:pointer;font-size:12px;line-height:1}
.pc-gktag .x:hover{color:#5ee0d6}
/* 右键菜单 */
.pc-toast{position:fixed;left:50%;bottom:34px;transform:translate(-50%,14px);z-index:100050;
  background:#141b25;border:1px solid #3a4250;color:#d7dfeb;border-radius:9px;
  padding:9px 18px;font-size:12.5px;opacity:0;pointer-events:none;
  transition:opacity .18s,transform .18s;box-shadow:0 10px 30px rgba(0,0,0,.55);
  font-family:system-ui,"Microsoft YaHei",sans-serif}
.pc-toast.show{opacity:1;transform:translate(-50%,0)}
.pc-toast.bad{color:#ff8b7a;border-color:#5a3130}
.pc-ctxmenu{position:fixed;z-index:100002;min-width:170px;background:#101620;border:1px solid #3a4250;
  border-radius:8px;box-shadow:0 12px 34px rgba(0,0,0,.65);padding:4px;font-size:12px;color:#c9d3e2}
.pc-ctxitem{padding:6px 10px;border-radius:5px;cursor:pointer}
.pc-ctxitem:hover{background:rgba(255,139,122,.14);color:#ff8b7a}
.pc-ctxword{padding:4px 10px 6px;color:#5d6b82;font-size:10.5px;font-family:Consolas,monospace;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 配置备份工具行（档位页顶部） */
.pc-cfgbar{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:7px 9px;margin-bottom:9px;
  border:1px dashed #3a4250;border-radius:8px;background:rgba(255,255,255,.015)}
/* 槽位格里的 ⚙ */
.pc-wslot-gear{flex:0 0 auto;opacity:.28;font-size:11px;line-height:1;cursor:pointer;
  padding:0 1px;transition:opacity .12s}
.pc-wslot:hover .pc-wslot-gear{opacity:.8}
.pc-wslot-gear:hover{opacity:1;color:#5ee0d6}
/* 槽位格里的 − N ＋ */
.pc-ctxitem .ic{flex:0 0 16px;font-size:12px;text-align:center}
.pc-ctxitem .lb{flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pc-ctxitem .hint{color:#6b7a93;font-size:10.5px;margin-left:2px;flex:0 0 auto}
.pc-ctxitem.danger{color:#e08c8c}
.pc-ctxitem.danger:hover{background:rgba(255,139,122,.14);color:#ff8b7a}
.pc-wslot-step{display:none;align-items:center;gap:1px;flex:0 0 auto}
.pc-wslot:hover .pc-wslot-step{display:inline-flex}
.pc-wslot-step .mi,.pc-wslot-step .pl{cursor:pointer;color:#6b7a93;font-size:12px;
  line-height:1;padding:0 2px;border-radius:3px}
.pc-wslot-step .mi:hover,.pc-wslot-step .pl:hover{color:#5ee0d6;background:rgba(94,224,214,.12)}
.pc-wslot-step .num{color:#8b9ab0;font-size:10.5px;min-width:12px;text-align:center}
.pc-wslot-step.on .num{color:#5ee0d6;font-weight:600}
/* 槽位格里的 👁 */
.pc-wslot-eye{flex:0 0 auto;opacity:.28;font-size:11px;line-height:1;cursor:pointer;
  padding:0 1px;transition:opacity .12s}
.pc-wslot:hover .pc-wslot-eye{opacity:.75}
.pc-wslot-eye:hover{opacity:1}
/* 槽位预览：模态框（挂 document.body，不占面板布局） */
.pc-peekmask{position:fixed;inset:0;z-index:100001;display:flex;align-items:center;justify-content:center;
  background:rgba(4,6,10,.72);backdrop-filter:blur(3px);padding:18px}
.pc-peekwin{width:min(1200px,100%);max-height:88vh;display:flex;flex-direction:column;
  background:#0e1219;border:1px solid #333c4a;border-radius:12px;overflow:hidden;
  box-shadow:0 24px 70px rgba(0,0,0,.7);color:#d7dfeb;
  font:12px/1.55 system-ui,"Microsoft YaHei",sans-serif}
.pc-peekhead{display:flex;align-items:center;gap:10px;padding:11px 14px;
  border-bottom:1px solid #2a323d;flex-wrap:wrap}
.pc-peekhead .pc-wtitle{font-size:15px}
.pc-peeksearch{flex:1 1 240px;min-width:150px}
/* 槽位选择器（添加到槽位 / 移动到其他槽）—— 样式照抄网页 #slotPickModal
   （网页：标题 + 药丸提示 + 关闭 / 分组 + 横排圆角 chip） */
.pc-pickwin{width:min(860px,100%);max-height:82vh;display:flex;flex-direction:column;
  background:#0e1219;border:1px solid #3a4250;border-radius:14px;overflow:hidden;
  box-shadow:0 20px 60px rgba(0,0,0,.6);color:#d7dfeb;
  font:13px/1.55 system-ui,"Microsoft YaHei",sans-serif}
.pc-pickhead{display:flex;align-items:center;gap:12px;padding:14px 18px;
  border-bottom:1px solid #3a4250;flex-wrap:wrap}
.pc-picktitle{font-size:16px;font-weight:700;white-space:nowrap}
.pc-pickhint{font-size:13px;color:#8b9ab0;background:#161b23;border:1px solid #3a4250;
  padding:6px 12px;border-radius:999px;font-family:Consolas,monospace;
  max-width:100%;overflow:hidden;text-overflow:ellipsis}
.pc-pickclose{margin-left:auto;padding:9px 18px;font-size:14px;font-weight:600;
  border-radius:8px;cursor:pointer;background:#161b23;color:#d7dfeb;border:1px solid #3a4250}
.pc-pickclose:hover{border-color:#5ee0d6;color:#5ee0d6}
.pc-pickbody{overflow-y:auto;padding:16px 18px;flex:1}
.pc-spick-group{margin-bottom:12px}
.pc-spick-group:last-child{margin-bottom:0}
.pc-spick-head{font-size:12px;color:#5ee0d6;font-weight:600;margin-bottom:6px}
.pc-spick-wrap{display:flex;flex-wrap:wrap;gap:6px}
.pc-chip{border:1px solid #3a4250;background:#161b23;color:#8b9ab0;
  padding:6px 14px;border-radius:999px;font-size:13px;cursor:pointer;user-select:none;
  transition:all .15s}
.pc-chip:hover{border-color:#5ee0d6;color:#d7dfeb}
.pc-chip.off{opacity:.35;cursor:default}
.pc-chip.off:hover{border-color:#3a4250;color:#8b9ab0}
.pc-peekseries{display:flex;align-items:center;gap:9px;padding:9px 14px;
  border-bottom:1px solid #2a323d;background:rgba(28,37,64,.35);flex-wrap:wrap}
.pc-peekseries .pc-winput{flex:1 1 260px;min-width:160px}
.pc-peekchips{display:flex;flex-wrap:wrap;gap:6px;padding:9px 14px;
  border-bottom:1px solid #2a323d;background:rgba(28,37,64,.22)}
.pc-schip{padding:3px 10px;border-radius:999px;border:1px solid #3a4250;background:#1b2028;
  color:#8b9ab0;font-size:11.5px;cursor:pointer;white-space:nowrap}
.pc-schip:hover{border-color:#5ee0d6;color:#5ee0d6}
.pc-schip.on{background:rgba(94,224,214,.14);border-color:#5ee0d6;color:#8ff0e6}
.pc-peekbody{flex:1;overflow:auto;padding:12px 14px;display:flex;flex-wrap:wrap;gap:6px;align-content:flex-start}
.pc-peekfoot{display:flex;align-items:center;justify-content:center;gap:12px;
  padding:10px 14px;border-top:1px solid #2a323d}
/* 收藏夹弹层 */
.pc-favbox{flex:0 0 auto;margin:9px 12px 12px;padding:9px 11px;border:1px solid #2a323d;
  border-radius:9px;background:rgba(255,255,255,.02);max-height:260px;overflow:auto}
.pc-favrow{display:flex;align-items:center;gap:9px;padding:4px 3px;border-radius:5px}
.pc-favrow:hover{background:rgba(94,224,214,.05)}
.pc-favtxt{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:Consolas,monospace;color:#8fa0bf;font-size:11.5px}
/* 头部只留「撑开」的空格，参数控件统一放在组合页的 chips 行（对齐网页版） */
.pc-headpad{flex:1 1 auto}
/* 槽位池编辑器 */
.pc-pbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:9px}
.pc-plab{font-size:11.5px;color:#7f8ea8;white-space:nowrap}
.pc-psel{background:#161b23;border:1px solid #3a4250;color:#d7dfeb;border-radius:6px;
  padding:5px 9px;font-size:12.5px;outline:none;min-width:130px}
.pc-psel:focus{border-color:#5ee0d6}
.pc-pq{background:#161b23;border:1px solid #3a4250;color:#d7dfeb;border-radius:6px;
  padding:5px 9px;font-size:12px;outline:none;flex:1 1 150px;min-width:110px}
.pc-pq:focus{border-color:#5ee0d6}
.pc-mini2.warn{border-color:#5a3a3a;color:#e08c8c}
.pc-mini2.warn:hover{border-color:#ff8b7a;color:#ff8b7a}
.pc-prow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.pc-pchk{cursor:pointer;font-size:11.5px;color:#5ee0d6;border:1px solid #3a4250;
  border-radius:5px;padding:3px 9px;background:#161b23;white-space:nowrap}
.pc-pchk:hover{border-color:#5ee0d6}
.pc-plist{flex:1;min-height:120px;overflow:auto;border:1px solid #2a323d;border-radius:8px;
  background:rgba(0,0,0,.22);padding:6px 8px;margin-bottom:9px}
.pc-pitem{display:flex;align-items:baseline;gap:8px;padding:3px 5px;border-radius:5px;cursor:pointer}
.pc-pitem:hover{background:rgba(94,224,214,.06)}
.pc-pitem.on{background:rgba(94,224,214,.13)}
.pc-pcbox{flex:0 0 auto;color:#5ee0d6;font-size:12px}
.pc-pidx{color:#4d5a6e;font-size:10.5px;flex:0 0 36px;text-align:right}
.pc-pp{font-family:Consolas,monospace;color:#5ee0d6;font-size:12px;word-break:break-all}
.pc-pn{color:#8fa0bf;font-size:11px}
.pc-pcat{color:#6b7a93;font-size:10px;background:rgba(255,255,255,.04);
  border-radius:3px;padding:0 5px;white-space:nowrap}
.pc-pfoot{flex:0 0 auto}
.pc-ptag{display:inline-flex;align-items:center;gap:4px;background:#1e2530;border:1px solid #333c4a;
  border-radius:5px;padding:2px 7px;font-size:11px;color:#9fb0c8;cursor:pointer;
  font-family:Consolas,monospace}
.pc-ptag:hover{border-color:#ff8b7a;color:#ff8b7a}
/* 词库浏览 */
.pc-dbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:9px}
.pc-dcats{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:9px}
.pc-dadd{margin-left:auto;flex:0 0 auto;color:#5ee0d6;font-size:15px;line-height:1;
  padding:0 7px;cursor:pointer;border:1px solid #2f3846;border-radius:5px}
.pc-dadd:hover{background:rgba(94,224,214,.16);border-color:#5ee0d6}
/* 标签联想浮层 */
.pc-sug{position:fixed;z-index:100000;max-height:250px;overflow:auto;
  background:#0f141c;border:1px solid #3a4250;border-radius:8px;
  box-shadow:0 12px 34px rgba(0,0,0,.65);padding:4px}
.pc-sugrow{display:flex;align-items:baseline;gap:8px;padding:4px 8px;border-radius:5px;cursor:pointer}
.pc-sugrow:hover{background:rgba(94,224,214,.08)}
.pc-sugrow.on{background:rgba(94,224,214,.16)}
.pc-suge{font-family:Consolas,monospace;color:#5ee0d6;font-size:12px;word-break:break-all}
.pc-sugc{color:#8fa0bf;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pc-sugk{margin-left:auto;color:#6b7a93;font-size:10px;background:rgba(255,255,255,.04);
  border-radius:3px;padding:0 5px;flex:0 0 auto}
`;
  document.head.appendChild(s);
}

function createDictTab(ctx) {
  /* 2026-10-20：_gq 定义在 openFullPanel 里，这里拿不到 ⇒ 由 ctx.gq 传进来。 */
  const _gq = (ctx && typeof ctx.gq === "function") ? ctx.gq : () => "";
  const { pane, meta } = ctx;
  /* st.open 兼作各种展开/选择状态的仓库（原版只存「分类是否展开」）：
     · st.open[cat]           分类是否展开
     · st.open[cat+"__q"]     该分类自己的搜索词
     · st.open[cat+"__sub"]   该分类选中的子分类（通用/元数据/版权/画师）
     · st.open[cat+"__subs"]  子分类列表缓存（[] 也缓存，避免反复请求）
     · st.open["__serQ"]      角色：系列名搜索
     · st.open["__serTag"]    角色：跨全部角色标签的搜索
     · st.open["__serBrowse"] 角色：正在浏览的系列（en）
     2026-09-29 加：对齐网页的「分类 → 子分类 / 系列」两级结构
     —— 用户原话「网页版的都是有分类的，特别是角色池子，comfyui节点的怎么不一样」。 */
  const st = {
    q: "", cat: "", size: 60, cats: null, open: {},
    seriesMax: 400, _series: null,
  };

  /* 顶部：标题 + 总搜索框 */
  const head = el("div", "pc-dhead");
  head.appendChild(el("span", "pc-wtitle", "标签词库"));
  const qAll = el("input", "pc-dsearch");
  qAll.placeholder = "搜索中英文标签…";
  qAll.onkeydown = (e) => {
    if (e.key !== "Enter") return;
    st.q = qAll.value.trim();
    if (st.q) { st.cat = ""; for (const k in st.open) if (/__q$/.test(k)) st.open[k] = ""; }
    refresh();
  };
  /* ⭐ 2026-10-21（阿君：搜索后清空标签不会返回分类）：
     原来只有回车才重查 —— 把搜索框清空后不按回车，就一直卡在全局搜索结果里
     （提示条还写着「清空搜索框回车可返回分类」，谁会去按回车…）。
     现在清空（trim 后为空）就自动回到分类视图。 */
  qAll.addEventListener("input", () => {
    if (!qAll.value.trim() && st.q) {
      st.q = "";
      st.cat = "";
      refresh();
    }
  });
  head.appendChild(qAll);
  pane.appendChild(head);

  const catBox = el("div", "pc-dcatlist");
  pane.appendChild(catBox);

  async function loadCats() {
    if (st.cats) return st.cats;
    try {
      const d = await api("/dict?page=1&size=10" + _gq());
      st.cats = d.cats || {};
    } catch (e) { st.cats = {}; }
    return st.cats;
  }

  /* 默认分类顺序（照网页 CAT_ORDER 的味道；后端 cats 里有的才显示） */
  const CAT_ORDER = ["通用", "元数据", "版权", "角色", "画师"];

  /* ⚠️ meta=1：词库浏览要带上「元数据」这一类（不然点开元数据的子分类是空的）。
       后端默认不带（标签联想那边要保持干净），所以这里显式声明。 */
  async function fetchCat(cat, page, q, sub) {
    const u = new URLSearchParams({ page: page, size: st.size, q: q || "", meta: "1" });
    if (cat) u.set("cat", cat);
    if (sub) u.set("sub", sub);
    /* ⛔ 2026-10-21（阿君：点开分类全是「读取失败：wval is not defined」）：
       这里原来写 wval(...) —— createDictTab 是**顶层函数**，wval 在 openFullPanel
       的闭包里，够不到 ⇒ ReferenceError 被 fillBody 的 catch 接住显示成"读取失败"。
       和 v1.4.25 的 _gq、v1.4.29 的 curTags 是同一类作用域坑。
       性别/NSFW 参数 _gq() 里本来就有（同一个接口同一套过滤），直接拼上。 */
    return await api("/dict?" + u.toString() + _gq());
  }

  /* 子分类列表（懒加载 + 缓存）。返回 [{name,n}]，无子分类则 [] */
  async function ensureSubs(cat) {
    const key = cat + "__subs";
    if (st.open[key]) return st.open[key];
    try {
      const d = await api("/subcats?cat=" + encodeURIComponent(cat));
      st.open[key] = d.subs || [];
    } catch (e) { st.open[key] = []; }
    return st.open[key];
  }

  /* 全部系列（4418 条，懒加载一次） */
  async function ensureSeries() {
    if (st._series) return st._series;
    try {
      const d = await api("/series");
      st._series = d.series || [];
    } catch (e) { st._series = []; }
    return st._series;
  }

  function renderHead() {
    if (document.activeElement !== qAll) qAll.value = st.q;
  }

  /* 单个词格 —— fillWords 和全局搜索共用 */
  function tagEl(w, showCat) {
    const t = el("span", "pc-wtag");
    /* 2026-10-14：在组合里就高亮（对齐网页 .sel）。
       ⛔ createDictTab 是顶层函数，够不到面板作用域的 curTags，
          这里经 ctx.inCombo 转发判断。 */
    if (ctx.inCombo && ctx.inCombo(w.prompt)) t.classList.add("sel");
    t.appendChild(el("span", "e", w.prompt));
    if (w.name && w.name !== w.prompt) t.appendChild(el("span", "c", w.name));
    if (showCat && w.category) t.appendChild(el("span", "s", w.category));
    if (w.pc != null) t.appendChild(el("span", "p", "pc=" + w.pc));
    /* 2026-10-14 改为「点一下进/出当前组合」：toggleCurTag 定义在同作用域后段，
       这里经 ctx.onTagClick 转发，缺注入直接报错（不静默失效）。 */
    t.title = "点一下进/出当前组合；右键可剔除 / 移动";
    t.onclick = () => {
      if (ctx.onTagClick) ctx.onTagClick(w);
      else console.error("[prompt-combiner] onTagClick 未注入");
    };
    t.classList.add("cli");
        t.oncontextmenu = (ev) => {
          ev.preventDefault();
          /* ⚠️ 别再写成 `if (ctx.showWordMenu) …` 一了百了 —— 忘了注入就是**静默失效**，
             用户只会说"右键没反应"。缺了就直接报错，别猜。 */
          if (!ctx.showWordMenu) {
            console.error("[prompt-combiner] 词库右键菜单未接上：createDictTab 的 ctx 少了 showWordMenu");
            return;
          }
          ctx.showWordMenu(ev.clientX, ev.clientY, w.prompt, "");
        };
    return t;
  }

  async function renderCats() {
    if (st.q) return renderGlobal();
    const cats = await loadCats();
    catBox.replaceChildren();
    const names = CAT_ORDER.filter((c) => cats[c] != null).concat(
      Object.keys(cats).filter((c) => CAT_ORDER.indexOf(c) < 0));

    names.forEach((cat) => {
      const isOpen = !!st.open[cat];
      const row = el("div", "pc-dcat" + (isOpen ? " open" : ""));
      const head2 = el("div", "pc-dcath");
      head2.appendChild(el("span", "arr", "▸"));
      head2.appendChild(el("span", "nm", cat));
      head2.appendChild(el("span", "n", String(cats[cat])));
      const cq = el("input", "pc-dcats");
      cq.placeholder = "搜「" + cat + "」…";
      cq.title = "只在这个分类里搜";
      if (st.open[cat + "__q"]) cq.value = st.open[cat + "__q"];
      cq.onclick = (ev) => ev.stopPropagation();
      cq.onkeydown = (ev) => {
        if (ev.key !== "Enter") return;
        ev.stopPropagation();
        st.open[cat] = true;
        st.open[cat + "__q"] = cq.value.trim();
        /* ⚠️ 原来这里写的是 renderCats().then(() => renderItems(cat))，
             而 renderItems 这个函数**根本不存在** —— 回车搜索静默报错。
             改成只 renderCats()：它内部会对所有展开的分类重跑 fillBody。 */
        renderCats();
      };
      head2.appendChild(cq);
      head2.onclick = () => { st.open[cat] = !st.open[cat]; renderCats(); };
      row.appendChild(head2);

      if (isOpen) {
        const body = el("div", "pc-dcatb");
        row.appendChild(body);
        row._body = body;
      }
      catBox.appendChild(row);
    });

    /* 展开的那些，把内容填进去 */
    const opened = names.filter((c) => st.open[c]);
    for (const cat of opened) {
      const row = Array.from(catBox.children).find(
        (r) => ((r.querySelector && r.querySelector(".pc-dcath .nm")) || {}).textContent === cat);
      if (row && row._body) await fillBody(cat, row._body);
    }
  }

  /* 全局搜索：跨分类列出命中词（每格额外标出所属分类） */
  async function renderGlobal() {
    catBox.replaceChildren();
    const holder = el("div", "pc-dcatb");
    catBox.appendChild(holder);
    let d = null;
    try {
      d = await api("/dict?page=1&size=" + st.size + "&meta=1&q=" + encodeURIComponent(st.q) + _gq());
    } catch (e) {
      holder.appendChild(el("div", "pc-err", "读取失败：" + e.message));
      return;
    }
    holder.appendChild(el("div", "pc-dinfo",
      "全局搜索「" + st.q + "」· 共 " + d.total + (d.capped ? "+（只列前 3000）" : "") +
      " 条 · 清空搜索框即可返回分类"));
    const list = el("div", "pc-dwords");
    (d.words || []).forEach((w) => list.appendChild(tagEl(w, true)));
    if (!(d.words || []).length) holder.appendChild(el("div", "pc-fempty", "没有匹配的标签"));
    holder.appendChild(list);
  }

  /* 分类展开后的内容分发：角色 → 系列；有子分类 → chips + 词表；否则直接词表 */
  async function fillBody(cat, box) {
    box.replaceChildren(el("div", "pc-fhint", "加载中…"));
    if (cat === "角色") return fillRole(cat, box);

    const subs = await ensureSubs(cat);
    box.replaceChildren();
    if (subs.length) {
      let cur = st.open[cat + "__sub"];
      if (!subs.some((x) => x.name === cur)) cur = subs[0].name;
      st.open[cat + "__sub"] = cur;
      const bar = el("div", "pc-subbar");
      subs.forEach((s) => {
        const chip = el("span", "pc-subchip" + (s.name === cur ? " on" : ""));
        chip.appendChild(el("span", "nm", s.name));
        chip.appendChild(el("span", "n", String(s.n)));
        chip.title = "只看「" + s.name + "」的 " + s.n + " 条";
        chip.onclick = () => { st.open[cat + "__sub"] = s.name; fillBody(cat, box); };
        bar.appendChild(chip);
      });
      box.appendChild(bar);
      const holder = el("div", "pc-subbody");
      box.appendChild(holder);
      return fillWords(cat, holder, { sub: cur });
    }
    return fillWords(cat, box, {});
  }

  /* 词表（可选：子分类过滤 / 覆盖搜索词） */
  async function fillWords(cat, box, o) {
    o = o || {};
    const q = o.q != null ? o.q : (st.open[cat + "__q"] || "");
    const sub = o.sub || "";
    const per = { page: 1, q: q, sub: sub, words: [], total: 0, pages: 1, capped: false };
    let d = null;
    try { d = await fetchCat(cat, 1, q, sub); }
    catch (e) { box.appendChild(el("div", "pc-err", "读取失败：" + e.message)); return; }
    per.words = d.words || []; per.total = d.total; per.pages = d.pages; per.capped = !!d.capped;

    const info = el("div", "pc-dinfo");
    info.textContent = "共 " + per.total + (per.capped ? "+" : "") + " 条" +
      (sub ? "（" + sub + "）" : "") + (q ? "（搜「" + q + "」）" : "");
    box.appendChild(info);

    const list = el("div", "pc-dwords");
    const draw = (n) => {
      list.replaceChildren();
      (per.words.slice(0, n) || []).forEach((w) => list.appendChild(tagEl(w, false)));
    };
    box.appendChild(list);

    const foot = el("div", "pc-dfoot");
    let shown = Math.min(200, per.words.length);
    const drawAll = () => draw(shown);
    drawAll();
    const bMore = el("button", "pc-wbtn sm", "加载更多");
    bMore.onclick = async () => {
      if (shown < per.words.length) { shown = per.words.length; }
      else if (per.pages > per.page) {
        per.page++;
        try {
          const d2 = await fetchCat(cat, per.page, q, sub);
          per.words = per.words.concat(d2.words || []);
          shown = per.words.length;
        } catch (e) {}
      }
      drawAll();
      updateFoot();
    };
    const bLess = el("button", "pc-wbtn sm", "收起");
    bLess.onclick = () => { st.open[cat] = false; renderCats(); };
    const bReset = el("button", "pc-wbtn sm", "重载");
    bReset.title = "清掉搜索、从头拉一次";
    bReset.onclick = () => { delete st.open[cat + "__q"]; renderCats(); };
    function updateFoot() {
      bMore.style.display = (shown < per.words.length || per.page < per.pages) ? "" : "none";
    }
    foot.append(bMore, bLess, bReset);
    box.appendChild(foot);
    updateFoot();
  }

  /* 角色分类：两个搜索框 + 系列小分类列表（对齐网页 renderSeriesGroups） */
  async function fillRole(cat, box) {
    box.replaceChildren();
    const row = el("div", "pc-serrow");
    const sInp = el("input", "");
    sInp.type = "search";
    sInp.placeholder = "搜系列名，如：原神 / Fate / 东方…";
    sInp.value = st.open["__serQ"] || "";
    const tInp = el("input", "");
    tInp.type = "search";
    tInp.placeholder = "搜标签（跨全部角色标签）…";
    tInp.value = st.open["__serTag"] || "";
    row.append(sInp, tInp);
    const listBox = el("div", "pc-serlist");
    box.append(row, listBox);

    async function draw() {
      listBox.replaceChildren();

      /* ① 跨全部角色的标签搜索 */
      const kwTag = (st.open["__serTag"] || "").trim();
      if (kwTag) {
        const back = el("div", "pc-serback", "← 返回系列列表");
        back.onclick = () => { st.open["__serTag"] = ""; tInp.value = ""; draw(); };
        listBox.appendChild(back);
        const holder = el("div", "");
        listBox.appendChild(holder);
        return fillWords(cat, holder, { q: kwTag });
      }

      /* ② 某个系列里的角色 */
      const cur = st.open["__serBrowse"] || "";
      if (cur) {
        const all = await ensureSeries();
        const s = all.find((x) => x.en === cur);
        const back = el("div", "pc-serback",
          "← 返回系列列表" + (s ? "（" + (s.cn || s.en) + " · " + s.n + " 个角色）" : ""));
        back.onclick = () => { st.open["__serBrowse"] = ""; draw(); };
        listBox.appendChild(back);
        const holder = el("div", "");
        listBox.appendChild(holder);
        return fillWords(cat, holder, { q: "(" + cur + ")" });
      }

      /* ③ 系列列表（按角色数降序，单次 400，可加载更多） */
      const all = await ensureSeries();
      const kw = (st.open["__serQ"] || "").trim().toLowerCase();
      const list = all.filter((x) => !kw || x.en.toLowerCase().includes(kw)
        || String(x.cn || "").toLowerCase().includes(kw));
      if (!list.length) {
        listBox.appendChild(el("div", "pc-fempty", "没有匹配的系列"));
        return;
      }
      const frag = document.createDocumentFragment();
      list.slice(0, st.seriesMax).forEach((x) => {
        const it = el("div", "pc-seritem");
        it.appendChild(el("span", "cn", x.cn || x.en));
        if (x.cn && x.cn !== x.en) it.appendChild(el("span", "en", x.en));
        it.appendChild(el("span", "n", String(x.n)));
        it.title = "只看「" + (x.cn || x.en) + "」的 " + x.n + " 个角色（" + x.en + "）";
        it.onclick = () => { st.open["__serBrowse"] = x.en; draw(); };
        frag.appendChild(it);
      });
      listBox.appendChild(frag);
      if (list.length > st.seriesMax) {
        const more = el("div", "pc-sermore",
          "还有 " + (list.length - st.seriesMax) + " 个系列 · 点击加载更多");
        more.onclick = () => { st.seriesMax += 400; draw(); };
        listBox.appendChild(more);
      }
    }

    /* 输入防抖（照网页 150ms；不重建输入框，避免打断输入法） */
    const deb = (fn) => {
      let t = null;
      return () => { clearTimeout(t); t = setTimeout(fn, 180); };
    };
    sInp.oninput = deb(() => {
      st.open["__serQ"] = sInp.value.trim();
      st.open["__serBrowse"] = "";
      if (st.open["__serTag"]) { st.open["__serTag"] = ""; tInp.value = ""; }
      draw();
    });
    tInp.oninput = deb(() => {
      st.open["__serTag"] = tInp.value.trim();
      draw();
    });
    return draw();
  }

  async function refresh() {
    renderHead();
    await renderCats();
  }

  return { render: refresh, refresh };
}

/* ===== 把 seed 的「生成后控制」钉成 fixed（2026-10-19 阿君报「复现没复现成功」）=====
   ⛔ 真凶：ComfyUI 前端会给**任何名字叫 `seed` / `noise_seed` 的整数控件**
      自动附加一个 `control_after_generate` 下拉，默认值是 **`randomize`**
      （前端源码 `useIntWidget` 里：`control_after_generate ?? ['seed','noise_seed'].includes(name)`
       → `randomize`）。于是**每次排队执行，前端先把 seed 换成随机数再交给节点**。
   后果（实际踩到，证据在工作流 JSON 里）：
     用户 `anima随机标签提示词扩写.json` 里这个节点存的是
       `[3] 983793344230138`  ← seed，15 位，远超面板生成的 2^32
       `[4] 'randomize'`      ← 就是这个下拉
     所以面板上显示的 seed、点徽章复制的 seed，**从来不是出图真正用的那个**，
     「填 seed → 复现」自然是白填。
   ⛔ 不能用 INPUT_TYPES 里写 `"control_after_generate": False` 来禁掉它 ——
      那样前端不再生成这个控件，老工作流的 `widgets_values` 会**整体错位一位**
      （`[4]'randomize'` 会被喂给 `add_quality`，后面全乱），风险太大。
   所以：控件留着，**值强制改回 `fixed`**，而且每次抽取前再确认一次。 */
function pinSeedControl(node) {
  const fix = () => {
    let changed = false;
    (node.widgets || []).forEach((w) => {
      if (w && w.name === "control_after_generate" && w.value !== "fixed") {
        w.value = "fixed";
        changed = true;
      }
    });
    if (changed) {
      try { node.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
    }
    return changed;
  };
  fix();
  /* 前端可能在我们之后再补一次控件（换工作流 / 撤销 / configure），所以持续盯着。
     ⛔ 用 clearInterval —— setInterval 返回的是**数字**，之前写的 `.disconnect()` 必抛异常，
        旧轮询会一直活着（每抽一次就多漏一个）。
     ⛔ 不再设「30 秒后停」的定时器：那个 setTimeout 认不住是哪一代的 id，
        会把之后新建的轮询一起清掉。fix() 只是扫十几个控件，2 秒一次开销可忽略。 */
  const t = [60, 400, 1200, 2500].map((ms) => setTimeout(fix, ms));
  try {
    if (node._pcSeedObs) clearInterval(node._pcSeedObs);
    node._pcSeedObs = setInterval(fix, 2000);
  } catch (e) {}
  return t;
}

/* ===== 「每次随机」：排队那一刻自己换 seed（2026-11-22 阿君）=====
   需求原话：「有没有每次运行随机抽一次的功能」「不接受随机模式下结果查不到出处」。
   ⇒ 两个条件必须同时满足：① 每跑一次换一组词 ② 换的是哪个 seed 必须看得见、抄得走、复现得了。

   ⛔ 不能解开 pinSeedControl、让前端那个 control_after_generate 回到 randomize：
      前端是在**序列化那一刻**偷偷把值换掉，控件上显示的仍是旧数字 ——
      于是「复制 seed → 复现」必然对不上（2026-10-19 已经因为这个被骂过一次）。
   ✅ 改成：点运行之前，**我们自己**把 seed 控件改成新值。
      控件值 = 提交给后端的值 = 面板显示的值，三者同一个数，出处天然成立。

   触发点：包一层 app.queuePrompt（按钮、Ctrl+Enter、右键 Queue 都走它）。
   不随机的情况（三种，都是「用户明确要这一组」）：
     · 开关是关的
     · pinned_prompt 非空（翻历史 / 手改过词 —— 节点本来就无视 seed）
     · 刚点过「复现」（一次性豁免，否则用户填了 seed 一按运行就被换掉）
*/
const AUTO_RAND_KEY = "pc.autoRand";

function autoRandOn() {
  try { return localStorage.getItem(AUTO_RAND_KEY) !== "0"; } catch (e) { return true; }
}
function setAutoRandOn(v) {
  try { localStorage.setItem(AUTO_RAND_KEY, v ? "1" : "0"); } catch (e) {}
}

/* 模块级版 widget 读写（面板闭包里的 wval/setW 拿不到）。
   ⚠️ seed 的合法值是 0，所以不能用 `if (!v)` 判断有没有取到 —— 一律先找控件。 */
function _pcW(node, name) {
  const w = (node.widgets || []).find((x) => x && x.name === name);
  return w || null;
}

/* 在**已经序列化好的 prompt** 里换 seed。
   workflow = api.queuePrompt(n, { output, workflow }) 的第二个参数。
   output[nodeId] = { class_type: "PromptCombiner", inputs: { seed, pinned_prompt, ... } }

   为什么不改 widget：这一层已经过了序列化，改 widget 也追不上这一次提交
   （下一张才会用上，正好错一拍）。所以两处都改：
     · output.inputs.seed = 新值   → 这次真的用它抽
     · 界面上的 seed 控件 = 新值   → 面板显示的就是它，查得到出处
*/
function autoRollInWorkflow(workflow) {
  if (!autoRandOn()) return 0;
  const out = (workflow && (workflow.output || workflow)) || null;
  if (!out || typeof out !== "object") return 0;
  let n = 0;
  Object.keys(out).forEach((k) => {
    const o = out[k];
    if (!o || o.class_type !== NODE_NAME || !o.inputs) return;

    /* 界面上对应的那个节点（要同步 seed 控件 + 让面板跟着重抽） */
    let nd = null;
    try {
      nd = (app.graph && app.graph.getNodeById) ? app.graph.getNodeById(Number(k)) : null;
    } catch (e) {}
    if (!nd) nd = (app.graph?._nodes || []).find((x) => String(x && x.id) === String(k)) || null;

    /* 复现豁免：点过「复现」/ 翻过历史的那一次，原样提交 */
    if (nd && nd._pcKeepSeedOnce) { nd._pcKeepSeedOnce = false; return; }
    /* 手改过的文本：节点直接输出那段文字、完全不看 seed，换了也白换 */
    if (String(o.inputs.pinned_prompt || "").trim()) return;

    const cur = Number(o.inputs.seed) || 0;
    /* 与面板 rollSeed() 同一套算法：保证和上一个不同、不越界 */
    const nv = (cur + 1 + Math.floor(Math.random() * 99999)) % 4294967296;
    o.inputs.seed = nv;
    n++;

    if (nd) {
      const w = _pcW(nd, "seed");
      if (w) w.value = nv;
      try { nd.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
      /* 面板按新 seed 重抽一遍 —— 否则「面板显示 A、出图用 B」 */
      try { nd._pcPanel?.refreshSeed?.(); } catch (e) {}
    }
  });
  return n;
}

/* 包住排队出口（api.queuePrompt）。只包一次。
   ⚠️ 它内部要用 this.clientId / this.authToken，所以必须 orig.call(this, ...)，
      直接 orig(...) 会丢 this，提交带不上 clientId（进度条/中断全失效）。 */
function installAutoRollHook(tries) {
  const t = tries == null ? 40 : tries;
  try {
    const Q = (comfyApi && typeof comfyApi.queuePrompt === "function")
      ? comfyApi
      : (window.comfyAPI && window.comfyAPI.api && window.comfyAPI.api.api);
    if (Q && typeof Q.queuePrompt === "function") {
      if (!Q.__pcAutoRollHooked) {
        const orig = Q.queuePrompt;
        Q.queuePrompt = async function (number, workflow, options) {
          try { autoRollInWorkflow(workflow); }
          catch (e) { console.warn("[prompt-combiner] 自动换 seed 失败", e); }
          return orig.call(this, number, workflow, options);
        };
        Q.__pcAutoRollHooked = true;
      }
      return;
    }
  } catch (e) {}
  if (t > 0) setTimeout(() => installAutoRollHook(t - 1), 250);
}

/* ===== 把节点的原生 widget 全部藏起来（2026-09-29 用户要求）=====
   用户原话：「把这个节点上面这节去掉，只留下面这个 UI，把节点完全做成这个 UI 的样子」。
   ⚠️ **不能删 widget** —— 它们承载着 run() 的输入，删了节点就跑不起来、工作流也没法序列化。
      做法：computeSize 压成 0 + 隐藏真实 DOM（照 ComfyUI-Bilingual-Prompt-Inspector 的路子）。
      对应的控制项**全部搬到面板**（性别 / NSFW / seed 在面板上改）。
   ⚠️ 新版前端的 widget 可能是 DOM 包装（.dom-widget / .p-floatlabel），除了 widget 本身，
      还要顺带把节点容器里那层 DOM 一起隐藏。
   ⚠️ 补两次（60ms / 400ms）—— 前端有时会晚一步重建这些 DOM。
   ⚠️⚠️ 循环里**必须跳过 pc_panel** —— addDOMWidget 之后它也在 node.widgets 里，
      一视同仁地压成 -4 会把整个面板变成 0×0（实测踩过）。 */
function hideNativeWidgets(node) {
  const apply = () => {
    (node.widgets || []).forEach((w) => {
      if (w.name === "pc_panel" || w.type === "pc-panel") return;
      try {
        w.computeSize = () => [0, -4];
        w.label = "";
        w.options = w.options || {};
        w.options.getMinHeight = () => -4;
        w.options.getMaxHeight = () => -4;
        [w.inputEl, w.element, w.domElement].filter(Boolean).forEach((elm) => {
          elm.style.setProperty("display", "none", "important");
        });
      } catch (e) {}
    });
    try {
      const holder = document.querySelector('[data-node-id="' + node.id + '"]');
      if (holder) {
        /* ⛔ 别把**面板自己**藏了 —— addDOMWidget 之后面板也在 .dom-widget 里（实测踩过） */
        const panelEl = (node._pcPanel && node._pcPanel.panel) || null;
        holder.querySelectorAll(".dom-widget, .p-floatlabel").forEach((elm) => {
          if (panelEl && (elm === panelEl || elm.contains(panelEl))) return;
          elm.style.setProperty("display", "none", "important");
          elm.style.setProperty("height", "0", "important");
          elm.style.setProperty("min-height", "0", "important");
        });
      }
      return !!holder;
    } catch (e) { return false; }
  };

  /* ⭐ 2026-10-18（阿君截图：标题上面还露着一行 anima_mode / 画质）：
     原来只在 0/60/400ms 各跑一次 —— 那时**节点的 DOM 还没生成**（holder 为 null），
     DOM 部分根本没执行；等前端渲染出 widget 行时早过了。
     改成：找不到就重试（最多 ~8 秒），找到后挂 MutationObserver 持续压制。 */
  let tries = 0;
  const tick = () => {
    const ok = apply();
    tries += 1;
    if (!ok && tries < 80) setTimeout(tick, 100);
  };
  tick();
  setTimeout(apply, 60);
  setTimeout(apply, 400);
  const attach = () => {
    let holder = null;
    try { holder = document.querySelector('[data-node-id="' + node.id + '"]'); } catch (e) {}
    if (!holder) { tries += 1; if (tries < 120) setTimeout(attach, 120); return; }
    try {
      if (node._pcHideObs) node._pcHideObs.disconnect();
      node._pcHideObs = new MutationObserver(() => { apply(); });
      node._pcHideObs.observe(holder, { childList: true, subtree: true });
    } catch (e) {}
  };
  attach();
}

/* ===== 标签槽位缓存（2026-10-18）=====
   面板本地没有词典索引，从**文本**重建标签时认不出槽位，只能给「自定」。
   这里维护「词 → {slot,name}」：搜索结果、每次生成的 tags 都会灌进来，
   重建时先查缓存 ⇒ 搜过/生成过的词不会再掉成「自定」。 */
/* 2026-10-18（阿君要的「补位」）：手动删掉的标签记下原位置（槽/下标/第几人），
   之后从搜索框选中同槽的标签，就插回原位（角色的 who 一并恢复）。 */
const _vacancies = [];
const _tagCache = new Map();
const _nkCache = (x) => String(x == null ? "" : x).replace(/\\/g, "").replace(/\s+/g, "_").toLowerCase();
function _cacheTags(list) {
  (list || []).forEach((t) => {
    if (!t || !t.prompt) return;
    const slot = t.slot || "";
    if (!slot || slot === "自定") return;        // 别把「自定」当答案缓存
    const info = { slot: slot, name: t.name || t.prompt };
    const k = _nkCache(t.prompt);
    if (k) _tagCache.set(k, info);
    /* ⭐ 2026-10-21（阿君：删角色后 (rule of thirds:1.3) 掉成了「自定」）：
       文本里存的是**输出写法**（带权重括号 / 转义 / @画师），prompt 是原始写法，
       只缓存 prompt 的话，从文本重建时就认不出来了。out 也收一份 key。 */
    if (t.out) { const k2 = _nkCache(t.out); if (k2) _tagCache.set(k2, info); }
  });
}

/* ===== 标签联想（2026-09-29）=====
   给输入框挂一个候选浮层：打字时按 300ms 防抖查 /pc/dict，中英文都能匹配；
   ↑↓ 选择，Enter 采用，Esc 关掉。 */
function attachSuggest(inputEl, opts) {
  /* 2026-10-20：_gq 定义在 openFullPanel 里，这里拿不到 ⇒ 由 opts.gq 传进来。 */
  const _gq = (opts && typeof opts.gq === "function") ? opts.gq : () => "";
  /* ⭐ 2026-10-21（真机抓到：右上角搜索框按 Enter 选词直接崩
     `curTags is not defined`）：attachSuggest 是**顶层函数**，curTags 在
     openFullPanel 的闭包里 —— 顶层函数引用不到，必须显式传进来。
     ⛔ 别再在顶层函数里直接写 curTags（node --check 查不出来，只有真机能抓到）。 */
  const _curTags = (opts && typeof opts.curTags === "function") ? opts.curTags : null;
  opts = opts || {};
  if (!inputEl) return null;
  const box = el("div", "pc-sug");
  box.style.display = "none";
  document.body.appendChild(box);
  const st = { items: [], idx: -1, timer: null, gen: 0, suppress: false };

  const getToken = opts.getToken || (() => {
    const v = inputEl.value;
    const pos = inputEl.selectionStart == null ? v.length : inputEl.selectionStart;
    /* ⛔ 2026-10-14 对齐网页 tsIsSep：中文逗号也是分隔符，
       否则用户打「长发，黑」联想只在上个中文逗号里找词。 */
    let s = Math.max(v.lastIndexOf(",", pos - 1), v.lastIndexOf("，", pos - 1)) + 1;
    while (s < pos && v[s] === " ") s++;
    return { start: s, end: pos, text: v.slice(s, pos) };
  });

  function place() {
    const r = inputEl.getBoundingClientRect();
    box.style.left = r.left + "px";
    box.style.top = (r.bottom + 2) + "px";
    box.style.minWidth = Math.min(420, Math.max(220, r.width)) + "px";
  }
  function hide() { box.style.display = "none"; st.items = []; st.idx = -1; }
  /* ⭐ 2026-10-20（阿君：结果框里就算有别的一大串标签，也要能在任意光标位置搜索、
     选中，并且自动补位到删掉的那个槽里）—— 结果框走这条专用路径。
     旧的 pick() 是给「独立搜索框」设计的：它把「上一个逗号 → 光标」整段当成要替换的
     token，还会把前缀里像标签的碎片搬来搬去 ⇒ 在结果框里会把相邻的标签切碎
     （实测 coco \(yes! precure 5\) 被切成 ", daiwa scarlet \(umamusume\)yes! precure 5"）。 */
  function pickCombo(it) {
    const v = inputEl.value || "";
    const pos = inputEl.selectionStart == null ? v.length : inputEl.selectionStart;
    const tk = getToken();
    const ins = opts.format ? opts.format(it.prompt, it) : it.prompt;
    let a = tk.start, b = Math.min(tk.end, v.length);
    const raw = String(v.slice(a, b) || "").trim();
    /* 光标本来就停在一个已有标签上 ⇒ 只插入，一个字符都不删 */
    const known = raw ? (opts.isKnown ? opts.isKnown(raw) : false) : true;
    if (known) { a = b = pos; }
    else {
      /* 只删「正在输入的搜索串」，再顺手吸掉紧邻的一个分隔符 —— 不碰任何已有标签 */
      while (a > 0 && /\s/.test(v[a - 1])) a--;
      if (a > 0 && /[,\uff0c]/.test(v[a - 1])) a--;
      while (a > 0 && /\s/.test(v[a - 1])) a--;
      while (b < v.length && /\s/.test(v[b])) b++;
      if (b < v.length && /[,\uff0c]/.test(v[b])) b++;
      while (b < v.length && /\s/.test(v[b])) b++;
    }
    const preT = v.slice(0, a).replace(/[\s,\uff0c]+$/, "");
    const postT = v.slice(b).replace(/^[\s,\uff0c]+/, "");
    const nv = preT + (preT.length ? ", " : "") + ins + (postT.length ? ", " : "") + postT;
    const np = (preT + (preT.length ? ", " : "") + ins).length;
    inputEl.value = nv;
    try { inputEl.setSelectionRange(np, np); } catch (e) {}
    hide();
    /* 让面板自己的 input 监听按新文本重建 curTags —— 顺序跟着文本，不会错位。
       suppress 只是别让联想自己再查一次（否则选完浮层又弹出来）。 */
    st.suppress = true;
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    st.suppress = false;
    if (opts.onPick) opts.onPick(it, np);
    inputEl.focus();
    try { inputEl.setSelectionRange(np, np); } catch (e) {}
  }
  function pick(i) {
    const it = st.items[i];
    if (!it) return;
    if (opts.combo) { pickCombo(it); return; }
    const tk = getToken();
    const v = inputEl.value;
    /* 2026-10-14：空格输出开启时插入「空格写法」，与文本框其他词一致 */
    /* 2026-10-15：多传一个候选对象 it —— 这样 format 能拿到 slot，
       Anima 模式下才能正确套 @画师 / 括号转义（只给 prompt 字符串时槽位是不知道的）。 */
    const ins0 = opts.format ? opts.format(it.prompt, it) : it.prompt;
    /* ⭐ 2026-10-18（阿君：选中角色后标签少了）：光标停在某个标签后面打字时，
       「原标签 + 新打的字」是一个 token，直接替换会把原标签一起吃掉。
       若前缀是已知标签，就把它留在新词后面。 */
    let keepPre = "";
    {
      const frag = String(v.slice(tk.start, tk.end) || "").replace(/\\/g, "");
      for (let k = frag.length - 1; k >= 3; k--) {
        const pre = frag.slice(0, k);
        const nk = _nkCache(pre);
        if ((_curTags && _curTags().some((t) => _nkCache(t.prompt) === nk)) || _tagCache.has(nk)) { keepPre = pre; break; }
      }
    }
    const ins = keepPre ? (ins0 + ", " + keepPre) : ins0;
    inputEl.value = v.slice(0, tk.start) + ins + v.slice(tk.end);
    const pos = tk.start + ins.length;
    try { inputEl.setSelectionRange(pos, pos); } catch (e) {}
    hide();
    /* ⛔ 2026-10-18（阿君：选中后浮窗还一直弹）：下面这行 input 事件会让监听器
       拿新文本再查一次 → 浮窗立刻又弹出来。用 suppress 屏蔽掉这一次。 */
    st.suppress = true;
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    st.suppress = false;
    if (opts.onPick) opts.onPick(it);
    inputEl.focus();
  }
  function render() {
    box.replaceChildren();
    if (!st.items.length) {
      /* 2026-10-18：搜不到时给一行提示，方便用户/排查时确认查询串 */
      const q = st.lastQ || "";
      if (q) {
        const row = el("div", "pc-sugrow");
        row.style.opacity = "0.65";
        row.appendChild(el("span", "pc-suge", "没有匹配：「" + q + "」"));
        box.appendChild(row);
        place();
        box.style.display = "block";
        return;
      }
      hide();
      return;
    }
    st.items.forEach((it, i) => {
      const row = el("div", "pc-sugrow" + (i === st.idx ? " on" : ""));
      row.appendChild(el("span", "pc-suge", it.prompt));
      if (it.name && it.name !== it.prompt) row.appendChild(el("span", "pc-sugc", it.name));
      if (it.category) row.appendChild(el("span", "pc-sugk", it.category));
      row.onmousedown = (ev) => { ev.preventDefault(); pick(i); };
      box.appendChild(row);
    });
    place();
    box.style.display = "block";
  }
  async function query(q) {
    const g = ++st.gen;
    st.lastQ = q;
    try {
      let d = await api("/dict?q=" + encodeURIComponent(q) + "&size=20" + _gq());
      if (g !== st.gen) return;
      /* ⭐ 2026-10-18（阿君报「结果框里搜其他标签没反应」）：
         token 是**从上一个逗号切**的，所以「…brush dragon」这种用**空格**接的词
         会把前面整段当成查询串 ⇒ 一条都搜不到、浮层不弹。
         兜底：整串没结果就只搜最后一个空格分隔的词。 */
      /* ⭐ 2026-10-18：中文优先取**末尾连续汉字**去搜（输入法会把字接在上一个词后面，
         任何前缀切分都可能失手）。 */
      if (!(d.words || []).length) {
        const cj = String(q).match(/[\u4e00-\u9fa5]{1,}$/);
        if (cj && cj[0] !== q) {
          d = await api("/dict?q=" + encodeURIComponent(cj[0]) + "&size=20" + _gq());
          if (g !== st.gen) return;
        }
      }
      if (!(d.words || []).length) {
        const last = String(q).split(/\s+/).pop();
        if (last && last !== q) {
          d = await api("/dict?q=" + encodeURIComponent(last) + "&size=20");
          if (g !== st.gen) return;
        }
      }
      /* ⭐ 2026-10-18 二修：用户在结果框末尾**不打分隔符**直接打字时，
         新词会粘在上一个词后面（`hand on own shoulderdragon`）⇒ 整串搜不到。
         锚点法：token 的开头若是**当前组合里已有的标签**，切掉它，剩下的才是新打的字。
         面板的 curTags 不会被文本框回写污染（只有点候选才进组合），所以可以当锚点。 */
      if (!(d.words || []).length) {
        /* ⚠️ 剥反斜杠：文本框里是转义写法（`xxx \(summer\) (pokemon)`），
           curTags 里是原始 prompt，不做规范化永远匹配不上。 */
        const norm = (x) => String(x).replace(/\\/g, "").replace(/\s+/g, "_").toLowerCase();
        /* ⛔ 2026-10-21：这里原来直接写 curTags（顶层函数拿不到闭包变量）
           ⇒ ReferenceError 被 catch 吞掉，这条兜底永远不生效。必须走 _curTags。 */
        const have = new Set((_curTags ? _curTags() : []).map((t) => norm(t.prompt)));
        let cut = null;
        for (let k = String(q).length - 1; k >= 3; k--) {
          if (have.has(norm(String(q).slice(0, k)))) { cut = String(q).slice(k); break; }
        }
        if (cut && (cut.length >= 2 || /[\u4e00-\u9fa5]/.test(cut))) {
          d = await api("/dict?q=" + encodeURIComponent(cut) + "&size=20");
          if (g !== st.gen) return;
        }
      }
      st.items = (d.words || []).slice(0, 20);
      _cacheTags(st.items);
      st.idx = st.items.length ? 0 : -1;
      render();
    } catch (e) { hide(); }
  }
  inputEl.addEventListener("input", () => {
    if (st.suppress) return;          // 选中后由 pick() 自己触发的这次不查
    const tk = getToken();
    const q = (tk.text || "").trim();
    clearTimeout(st.timer);
    if (!q) { hide(); return; }
    st.timer = setTimeout(() => query(q), 300);
  });
  inputEl.addEventListener("keydown", (e) => {
    if (box.style.display === "none") return;
    if (e.key === "ArrowDown") { e.preventDefault(); st.idx = Math.min(st.items.length - 1, st.idx + 1); render(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); st.idx = Math.max(0, st.idx - 1); render(); }
    else if (e.key === "Enter") { if (st.idx >= 0) { e.preventDefault(); e.stopPropagation(); pick(st.idx); } }
    else if (e.key === "Escape") { hide(); }
  }, true);
  inputEl.addEventListener("blur", () => setTimeout(hide, 150));
  window.addEventListener("resize", () => { if (box.style.display !== "none") place(); });
  return { hide: hide, box: box };
}

/* ===== 中文对照句式（2026-09-29 移植网页 tplModal / 行4960-5015）=====
   用途：「复制中文」时把各槽的中文名拼成一段自然语言描述，而不是干巴巴一顿顿标签。
   占位符：{lead}{quality}{subject}{app}{acts}{emo}{wear}{acc}{scene}{light}{cam}
   模板存 data/user_edits.json 的 cnTpl（{cn, fill}）。 */
const CN_TPL_DEFAULT = {
  cn: "{lead}{quality}{subject}{app}{acts}{emo}{wear}{acc}{scene}{light}{cam}。",
  fill: true,
};
const CN_GROUPS = {
  lead: ["画师", "风格"],
  app: ["发色", "发型", "眼睛", "人物特征"],
  acts: ["基础姿势", "动作", "手臂与手势", "身体与头部协调", "双人互动", "人物朝向", "视线与朝向"],
  wear: ["上装", "下装", "连衣裙与制服", "泳装与贴身衣物", "袖型与领口", "装饰与材质", "腿部服饰", "鞋子", "袜子"],
  acc: ["首饰", "头饰配件"],
  scene: ["场景"],
  env: ["载具", "动物", "植物", "道具"],
  light: ["光照"],
  cam: ["景别", "相机方位", "构图", "镜头", "景深", "运镜", "动态效果"],
};

function buildCnText(tags, tpl) {
  const t = Object.assign({}, CN_TPL_DEFAULT, tpl || {});
  const by = {};
  (tags || []).forEach((x) => {
    const nm = x.name || x.prompt;
    if (!nm) return;
    (by[x.slot] = by[x.slot] || []).push(nm);
  });
  const g = (s) => by[s] || [];
  const gs = (arr) => arr.reduce((a, s) => a.concat(g(s)), []);

  const lead = gs(CN_GROUPS.lead);
  const leadPh = lead.length ? lead.join("，") + "：" : "";
  const cnChar = g("角色")[0] || "";
  const cnCount = g("人数")[0] || "";
  const subject = cnChar || cnCount || "一个身影";
  const app = gs(CN_GROUPS.app);
  const appPh = app.length ? "，" + app.join("、") : "";
  const acts = gs(CN_GROUPS.acts);
  const actPh = acts.length ? "，" + acts.join("、") : "";
  const emo = g("表情").join("、");
  const emoPh = emo ? "，" + emo + "的表情" : "";
  const wear = gs(CN_GROUPS.wear);
  const wearPh = wear.length ? "，身着" + wear.join("、") : "";
  const acc = gs(CN_GROUPS.acc);
  const accPh = acc.length ? "，佩戴" + acc.join("、") : "";
  const scene = g("场景").join("、");
  const env = gs(CN_GROUPS.env);
  let scenePh = (scene ? "，置身" + scene : "") + (env.length ? "，画面中有" + env.join("、") : "");
  const light = g("光照").join("、");
  let lightPh = light ? "，" + light + "光线" : "";
  if (t.fill && !scenePh) scenePh = "，置身简洁背景";
  if (t.fill && !lightPh) lightPh = "，柔和光线";
  const cam = gs(CN_GROUPS.cam);
  const camPh = cam.length ? "，" + cam.join("、") : "";

  let out = String(t.cn || CN_TPL_DEFAULT.cn)
    .replace("{lead}", leadPh)
    .replace("{quality}", "")
    .replace("{subject}", subject)
    .replace("{app}", appPh)
    .replace("{acts}", actPh)
    .replace("{emo}", emoPh)
    .replace("{wear}", wearPh)
    .replace("{acc}", accPh)
    .replace("{scene}", scenePh)
    .replace("{light}", lightPh)
    .replace("{cam}", camPh);
  out = out.replace(/：[，、]+/g, "：").replace(/[，、]{2,}/g, "，").replace(/^[，、]+/, "");
  return out;
}

let _pcFullEl = null;      // 当前打开的全屏面板（同时只允许一个）

/* ======================================================================
   用户改动（槽位池编辑器 / 档位编辑器）—— 2026-09-25
   ----------------------------------------------------------------------
   改动落在 _userEdits.slotEdits / .presetEdits（结构**完全对齐网页版**的
   promptCombinerSlotEdits / promptCombinerPresetEdits），统一 POST /pc/user 落盘。
   ⚠️ 不能存 localStorage：网页是 file://、ComfyUI 是 http://127.0.0.1:8188，
      两个 origin 的 localStorage 不互通。所以走插件侧的 data/user_edits.json。
   ====================================================================== */
let _userEdits = null;

async function loadUserEdits(force) {
  if (!_userEdits || force) _userEdits = await api("/user");
  const se = _userEdits.slotEdits = _userEdits.slotEdits || {};
  se.removed = se.removed || {};
  se.added = se.added || {};
  se.renamed = se.renamed || {};
  se.custom = se.custom || [];
  se.deleted = se.deleted || [];
  const pe = _userEdits.presetEdits = _userEdits.presetEdits || {};
  pe.removed = pe.removed || [];
  pe.renamed = pe.renamed || {};
  pe.custom = pe.custom || [];
  if (!pe.overrides || typeof pe.overrides !== "object") pe.overrides = {};   // 档位「覆盖」(2026-09-29)
  /* 收藏夹（2026-09-29）：与网页版 promptCombinerFavs 同结构 */
  if (!Array.isArray(_userEdits.favorites)) _userEdits.favorites = [];
  /* 单词收藏（2026-10-19 阿君：「喜欢的角色或者某个标签能不能也收藏」）：
     [{p,n,s,t}] —— 跟整组收藏分开存，一条 = 一个词。 */
  if (!Array.isArray(_userEdits.wordFavs)) _userEdits.wordFavs = [];
  if (!Array.isArray(_userEdits.black)) _userEdits.black = [];   // 全局剔除（2026-09-29）
  if (!_userEdits.cnTpl || typeof _userEdits.cnTpl !== "object") _userEdits.cnTpl = {};  // 中文句式模板
  /* 单标签权重（2026-10-19）：{prompt: 倍数}，1.0 = 默认。后端 core.load_weights 读同一份 */
  if (!_userEdits.weights || typeof _userEdits.weights !== "object" || Array.isArray(_userEdits.weights))
    _userEdits.weights = {};
  /* 提示词权重（2026-10-19）：{prompt: 倍数}，1.0 = 默认（不加括号），输出成 (tag:1.5) */
  if (!_userEdits.promptWeights || typeof _userEdits.promptWeights !== "object" || Array.isArray(_userEdits.promptWeights))
    _userEdits.promptWeights = {};
  /* seed → 参数快照（2026-10-19）：跨工作流复现用。
     ⛔ hist 是每个节点实例一份的内存数组，A 工作流生成的 seed，B 工作流看不见 ——
       所以「复制 seed 去另一个工作流复现」以前必然抽错。这份落在 user_edits.json 上。 */
  if (!_userEdits.seedParams || typeof _userEdits.seedParams !== "object" || Array.isArray(_userEdits.seedParams))
    _userEdits.seedParams = {};
  return _userEdits;
}

async function saveUserEdits() {
  if (!_userEdits) return false;
  try {
    await api("/user", { method: "POST", body: JSON.stringify(_userEdits) });
    return true;
  } catch (e) { return false; }
}

/* --- 槽位池编辑器（「槽位池」标签页）---
   ctx = { pane, node, meta, afterChange }  afterChange: 改完通知「组合」页重画
*/
function createPoolTab(ctx) {
  const { pane, meta, afterChange } = ctx;
  /* ctx.showWordMenu：词右键菜单（由 openFullPanel 注入，作用域原因不能直接调） */
  const st = { slot: meta.slotOrder[0] || "", page: 1, size: 100, q: "", sel: new Set(), data: null, ed: null };

  /* 可选的槽位 = 内置槽（去掉被删的）+ 自定义槽 */
  function slotNames() {
    const se = (_userEdits && _userEdits.slotEdits) || {};
    const deleted = new Set((se.deleted || []).map((d) => d.name || d));
    const out = meta.slotOrder.filter((s) => !deleted.has(s));
    (se.custom || []).forEach((c) => { if (c.name && out.indexOf(c.name) < 0) out.push(c.name); });
    return out;
  }

  async function fetchPool() {
    const u = new URLSearchParams({ slot: st.slot, page: st.page, size: st.size, q: st.q });
    const d = await api("/slotpool?" + u.toString());
    st.data = d; st.ed = { removed: d.removed || [], added: d.added || [], renamed: d.renamed || "" };
    return d;
  }

  function se() { return _userEdits.slotEdits; }
  function rmList(slot) { se().removed[slot] = se().removed[slot] || []; return se().removed[slot]; }
  function addList(slot) { se().added[slot] = se().added[slot] || []; return se().added[slot]; }

  async function commit(msg) {
    const okSave = await saveUserEdits();
    if (!okSave) { alert("保存失败（ComfyUI 后端没响应？）"); return; }
    if (msg) flash(msg);
    await refresh(true);
    if (afterChange) afterChange();
  }

  const bar = el("div", "pc-pbar");
  const listBox = el("div", "pc-plist");
  const foot = el("div", "pc-pfoot");
  /* ---- 全局剔除（移植网页 state.black）----
     这些词**任何槽位都不出**。加入方式：结果区/预览的词格**右键** → 「🚫 从所有槽剔除」。 */
  const gkSec = el("div", "pc-gksec");
  pane.append(gkSec, bar, listBox, foot);

  function renderGk() {
    gkSec.replaceChildren();
    const list = (_userEdits && _userEdits.black) || [];
    const head = el("div", "pc-wcardhead");
    head.appendChild(el("span", "pc-wtitle", "全局剔除"));
    head.appendChild(el("span", "pc-wsub", list.length + " 个词（任何槽都不出）"));
    const sp = el("span", "pc-wsp"); sp.style.flex = "1"; head.appendChild(sp);
    if (list.length) {
      const bAll = el("button", "pc-wbtn sm warn", "全部解除");
      bAll.onclick = async () => {
        if (!confirm("解除全部 " + list.length + " 个词的剔除？")) return;
        _userEdits.black = [];
        await saveUserEdits();
        renderGk();
        if (afterChange) afterChange();
      };
      head.appendChild(bAll);
    }
    gkSec.appendChild(head);
    if (!list.length) {
      gkSec.appendChild(el("div", "pc-fhint", "没有全局剔除的词。在结果区或预览里的词上**右键**即可加入。"));
      return;
    }
    const box = el("div", "pc-gkbox");
    list.forEach((wname) => {
      const t = el("span", "pc-gktag");
      t.appendChild(el("span", "e", wname));
      const x = el("span", "x", "✕");
      x.title = "解除「" + wname + "」的剔除";
      x.onclick = async () => {
        _userEdits.black = _userEdits.black.filter((x2) => x2 !== wname);
        await saveUserEdits();
        renderGk();
        if (afterChange) afterChange();
      };
      t.appendChild(x);
      box.appendChild(t);
    });
    gkSec.appendChild(box);
  }
  renderGk();

  /* ---- 顶部工具条 ---- */
  function renderBar() {
    bar.replaceChildren();
    const names = slotNames();
    const lab = el("span", "pc-plab", "槽位");
    const sel = el("select", "pc-psel");
    names.forEach((s) => {
      const o = el("option", "", s + (se().renamed[s] ? "（" + se().renamed[s] + "）" : ""));
      o.value = s;
      if (s === st.slot) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = () => { st.slot = sel.value; st.page = 1; st.sel.clear(); st.q = ""; refresh(); };
    bar.appendChild(lab); bar.appendChild(sel);

    const cnt = el("span", "pc-plab", st.data ? "共 " + st.data.total + " 词" : "…");
    bar.appendChild(cnt);

    const q = el("input", "pc-pq");
    q.placeholder = "在本槽内搜索…";
    q.value = st.q;
    q.onkeydown = (e) => { if (e.key === "Enter") { st.q = q.value.trim(); st.page = 1; refresh(); } };
    bar.appendChild(q);

    const bNew = el("button", "pc-mini2", "＋新建槽位");
    bNew.onclick = async () => {
      const name = prompt("新槽位的名字：");
      if (!name || !name.trim()) return;
      const n = name.trim();
      if (slotNames().indexOf(n) >= 0) { alert("已经有这个槽了"); return; }
      se().custom.push({ name: n, group: "自定义" });
      st.slot = n; st.page = 1;
      await commit("已新建槽位「" + n + "」");
    };
    const bRen = el("button", "pc-mini2", "改名");
    bRen.onclick = async () => {
      const cur = se().renamed[st.slot] || st.slot;
      const name = prompt("把「" + st.slot + "」显示成什么名字？\n（留空则恢复原名）", cur);
      if (name === null) return;
      if (!name.trim()) delete se().renamed[st.slot];
      else se().renamed[st.slot] = name.trim();
      await commit("已改名");
    };
    const bDel = el("button", "pc-mini2", "删除此槽");
    bDel.onclick = async () => {
      if (!confirm("把「" + st.slot + "」从界面移除？\n（词库不动，可在下方「已删除的槽位」恢复）")) return;
      const isCustom = (se().custom || []).some((c) => c.name === st.slot);
      /* ⭐ 2026-10-06：自建槽也进「已删除」（带 custom 标记），可恢复、也进改动历史 —— 与弹窗/⚙ 菜单一致 */
      if (isCustom) se().custom = se().custom.filter((c) => c.name !== st.slot);
      const dlc = (se().deleted = se().deleted || []);
      if (!dlc.some((o) => ((o && o.name) || o) === st.slot)) {
        dlc.push({ name: st.slot, group: "自定义", custom: !!isCustom });
      }
      st.slot = slotNames()[0] || ""; st.page = 1;
      await commit("已移除槽位");
    };
    bar.append(bNew, bRen, bDel);
  }

  /* ---- 词列表 ---- */
  function renderList() {
    listBox.replaceChildren();
    if (!st.data) { listBox.appendChild(el("div", "pc-fempty", "加载中…")); return; }
    const d = st.data;

    /* 操作行 */
    const acts = el("div", "pc-prow");
    const all = el("span", "pc-pchk", "全选本页");
    all.onclick = () => {
      const ps = d.words.map((w) => w.prompt);
      const allOn = ps.every((p) => st.sel.has(p));
      ps.forEach((p) => { if (allOn) st.sel.delete(p); else st.sel.add(p); });
      renderList();
    };
    acts.appendChild(all);
    const selLab = el("span", "pc-plab", "已选 " + st.sel.size);
    acts.appendChild(selLab);

    const bRm = el("button", "pc-mini2 warn", "🗑 从本槽剔除");
    bRm.onclick = async () => {
      if (!st.sel.size) { alert("先勾选要剔除的词"); return; }
      const rml = rmList(st.slot), adl = addList(st.slot);
      Array.from(st.sel).forEach((p) => {
        const i = adl.indexOf(p);
        if (i >= 0) adl.splice(i, 1);
        else if (rml.indexOf(p) < 0) rml.push(p);
      });
      const n = st.sel.size; st.sel.clear();
      await commit("已从「" + st.slot + "」剔除 " + n + " 个词");
    };
    const bMv = el("button", "pc-mini2", "➡ 移动到");
    bMv.onclick = async () => {
      if (!st.sel.size) { alert("先勾选要移动的词"); return; }
      const target = prompt("移到哪个槽？（填槽位名）\n可选：" + slotNames().join(" / "));
      if (!target || !target.trim()) return;
      const t = target.trim();
      if (slotNames().indexOf(t) < 0) { alert("没有这个槽位"); return; }
      const rml = rmList(st.slot);
      Array.from(st.sel).forEach((p) => { if (rml.indexOf(p) < 0) rml.push(p); addList(t).push(p); });
      const n = st.sel.size; st.sel.clear();
      await commit("已把 " + n + " 个词移到「" + t + "」");
    };
    acts.append(bRm, bMv);

    const bAdd = el("button", "pc-mini2", "＋加词");
    const addIn = el("input", "pc-pq");
    addIn.placeholder = "输入英文标签（下划线写法）后按 Enter";
    addIn.onkeydown = async (e) => {
      if (e.key !== "Enter") return;
      const p = addIn.value.trim().replace(/ /g, "_");
      if (!p) return;
      const rml = rmList(st.slot), adl = addList(st.slot);
      const ri = rml.indexOf(p); if (ri >= 0) rml.splice(ri, 1);
      if (adl.indexOf(p) < 0) adl.push(p);
      addIn.value = "";
      await commit("已把「" + p + "」加进「" + st.slot + "」");
    };
    acts.append(bAdd, addIn);
    listBox.appendChild(acts);

    /* 词行 */
    d.words.forEach((w, i) => {
      const row = el("div", "pc-pitem" + (st.sel.has(w.prompt) ? " on" : ""));
      const ck = el("span", "pc-pcbox", st.sel.has(w.prompt) ? "☑" : "☐");
      row.appendChild(ck);
      row.appendChild(el("span", "pc-pidx", String((st.page - 1) * st.size + i + 1)));
      row.appendChild(el("span", "pc-pp", w.prompt));
      if (w.name && w.name !== w.prompt) row.appendChild(el("span", "pc-pn", w.name));
      if (w.category) row.appendChild(el("span", "pc-pcat", w.category));
      if (w.pc != null) row.appendChild(el("span", "pc-pcat", "pc=" + w.pc));
      row.onclick = () => {
        if (st.sel.has(w.prompt)) st.sel.delete(w.prompt); else st.sel.add(w.prompt);
        row.classList.toggle("on", st.sel.has(w.prompt));
        ck.textContent = st.sel.has(w.prompt) ? "☑" : "☐";
        selLab.textContent = "已选 " + st.sel.size;
      };
      /* 右键菜单（对齐网页：从本槽剔除 / 移动 / 从所有槽剔除）
         ⚠️ poolTab 这个闭包里访问不到 openFullPanel 的 showWordMenu，
            所以通过 ctx.showWordMenu 传进来（见 createPoolTab 的调用处）。 */
      row.oncontextmenu = (ev) => {
        ev.preventDefault();
        if (ctx.showWordMenu) ctx.showWordMenu(ev.clientX, ev.clientY, w.prompt, st.slot);
      };
      listBox.appendChild(row);
    });
    if (!d.words.length) listBox.appendChild(el("div", "pc-fempty", "这个槽当前没有词"));
  }

  /* ---- 底部：翻页 + 用户改动 ---- */
  function renderFoot() {
    foot.replaceChildren();
    const d = st.data;
    if (d) {
      const pg = el("div", "pc-prow");
      const prev = el("button", "pc-mini2", "◀ 上一页");
      const next = el("button", "pc-mini2", "下一页 ▶");
      prev.disabled = st.page <= 1;
      next.disabled = st.page >= d.pages;
      prev.onclick = () => { st.page = Math.max(1, st.page - 1); refresh(); };
      next.onclick = () => { st.page = Math.min(d.pages, st.page + 1); refresh(); };
      pg.append(prev, el("span", "pc-plab", "第 " + st.page + " / " + d.pages + " 页"), next);
      foot.appendChild(pg);
    }
    /* 被剔除的词（可恢复） */
    const rml = (se().removed[st.slot] || []);
    if (rml.length) {
      const box = el("div", "pc-prow");
      box.appendChild(el("span", "pc-plab", "本槽已剔除 " + rml.length + " 个："));
      rml.slice(0, 40).forEach((p) => {
        const tag = el("span", "pc-ptag", p + " ✕");
        tag.title = "点一下恢复";
        tag.onclick = async () => {
          const a = rmList(st.slot); const i = a.indexOf(p); if (i >= 0) a.splice(i, 1);
          await commit("已恢复「" + p + "」");
        };
        box.appendChild(tag);
      });
      if (rml.length > 40) box.appendChild(el("span", "pc-plab", "…等 " + rml.length + " 个"));
      foot.appendChild(box);
    }
    /* 已删除的槽位（可恢复） */
    const del = se().deleted || [];
    if (del.length) {
      const box = el("div", "pc-prow");
      box.appendChild(el("span", "pc-plab", "已删除的槽位 " + del.length + " 个："));
      del.forEach((o) => {
        const tag = el("span", "pc-ptag", (o.name || o) + " ✕");
        tag.title = "点一下恢复";
        tag.onclick = async () => {
          se().deleted = se().deleted.filter((x) => (x.name || x) !== (o.name || o));
          await commit("已恢复槽位");
        };
        box.appendChild(tag);
      });
      foot.appendChild(box);
    }
  }

  const msgEl = el("div", "pc-fhint");
  foot.appendChild(msgEl);
  let _msgTimer = null;
  function flash(t) {
    msgEl.textContent = t;
    clearTimeout(_msgTimer);
    _msgTimer = setTimeout(() => { msgEl.textContent = ""; }, 2500);
  }

  async function refresh(noFetch) {
    renderBar();
    try {
      if (!noFetch) await fetchPool();
      else await fetchPool();
    } catch (e) {
      listBox.replaceChildren(el("div", "pc-err", "载入失败：" + e.message));
      return;
    }
    renderList();
    renderFoot();
  }

  return {
    render: async () => { await loadUserEdits(); await refresh(); renderGk(); },
    refresh,
    renderGk,           // 供结果区右键加词后刷新（作用域在 createPoolTab 内）
    setSlot: (s) => { st.slot = s; st.page = 1; st.sel.clear(); return refresh(); },
  };
}

/* container 传了 → **直接内嵌**（节点用这个模式，加载出来就是完整面板）；
   不传 → 弹层（保留着，以后需要时还能用）。 */
/* ---- 英文标签 → 中文名（2026-10-20 阿君：「这些改动的标签再加个中文对照意思」）----
   槽位管理里的「全局剔除 / 抽取频率 / 提示词权重 / 我改过的地方」原来只显示英文，
   一堆 `amplified_composition` `o-ring_thigh_strap` 看不出是啥。
   词库里本来就带中文名，只是没查 —— 批量 POST 一次全带回来，命中就存进缓存。
   ⚠️ 查不到（用户手输的词）存空串，**不猜、不编**，界面上就只显示英文。 */
const _cnMap = new Map();
let _cnBusy = false;
async function _loadCn(words) {
  const miss = Array.from(new Set(words.filter((w) => w && !_cnMap.has(w))));
  if (!miss.length || _cnBusy) return false;
  _cnBusy = true;
  try {
    const d = await api("/names", { method: "POST", body: JSON.stringify({ words: miss }) });
    Object.keys(d || {}).forEach((k) => _cnMap.set(k, String(d[k] || "")));
  } catch (e) {
    /* 后端还没重启（没有 /pc/names）时不要反复重试——全部记成"查不到" */
  } finally {
    miss.forEach((w) => { if (!_cnMap.has(w)) _cnMap.set(w, ""); });
    _cnBusy = false;
  }
  return true;
}
const _cnOf = (w) => _cnMap.get(String(w || "")) || "";

function openFullPanel(node, container) {
  injectFullStyles();
  try { injectPolishStyles(); } catch (e) {}
  if (!container && _pcFullEl) { _pcFullEl.remove(); _pcFullEl = null; }

  const wrap = el("div", container ? "pc-root" : "pc-full");
  wrap.innerHTML = `
    <div class="pc-full-win">
      <div class="pc-full-head">
        <span class="pc-full-title">🎲 Danbooru 抽签机</span><span style="font-size:10px;opacity:.4;margin-left:6px;font-family:monospace">v${VERSION}</span>
        <span class="pc-full-sub" id="pcFSub">正在加载…</span>
        <span class="pc-headpad"></span>
        <!-- 2026-10-18：作者 + 社交主页，放在标题栏右侧的富余处（链接在顶部 PC_AUTHOR 里配） -->
        <span class="pc-head-author" id="pcAuthorBar"></span>
        <button class="pc-full-close"${container ? ' style="display:none"' : ""}>关闭 (Esc)</button>
      </div>
      <div class="pc-full-body">
        <div class="pc-tabpane pc-wpane on" id="pcTabGen">
          <!-- 顶栏：动作 + 开关 chips（照网页版） -->
          <div class="pc-wbar">
            <button class="pc-wbtn pri" id="pcGRoll">组合生成</button>
            <button class="pc-wbtn warn" id="pcGClear">清空</button>
            <button class="pc-wbtn sm" id="pcGHelp" title="30 秒上手：怎么看、怎么点、常见问题">❓ 帮助</button>
            <span class="pc-wsp"></span>
            <!-- ⭐ 2026-11-22（阿君：要「每次运行随机抽一次」，但结果必须查得到出处）：
                 亮 = 每次点运行/队列，面板先自己换一个新 seed 再出图。
                 ⛔ 不是放开前端那个 randomize —— 那样控件上的数字和实际用的对不上，
                    又会回到「填 seed 复现不了」。这里换的是控件本身，所以显示即真相。 -->
            <span class="pc-wchip on" id="pcGAutoRand" title="打开：每次点「运行/队列」先自动换一个新 seed 再出图 —— 每跑一次换一组词。新 seed 会显示在下面结果区，点一下就能复制，之后填回复现框就能找回那一组。关掉：seed 固定不动，跑几次都是同一组">每次随机</span>
            <span class="pc-wchip" id="pcGQuality" title="加固定画质词（masterpiece / score_9 …）">固定画质词</span>
            <span class="pc-wchip on" id="pcGSpace" title="下划线转空格（Anima/Qwen/Krea 系更友好）">空格输出</span>
            <span class="pc-wchip" id="pcGCross" title="双人时是否允许两个角色来自不同作品。默认关＝第二人优先同作品；打开后各自独立抽（仍保证同性别）">同作品</span>
            <span class="pc-wchip" id="pcGAnima" title="画师标签写成 @画师名（Anima 系必须，不加 @ 画风几乎不生效）。Illustrious / Pony / NoobAI 保持关闭。注：括号转义与官方标签顺序已改为永远生效，不再受这个开关影响">画师@</span>
            <span class="pc-wchip" id="pcGOutfit" title="穿搭方案：自动 / 只出连衣裙 / 只出上下装 / 只出泳装（点一下循环切换）">穿搭:自动</span>
            <input id="pcFind" class="pc-find" placeholder="搜标签追加…" title="输入中英文标签名，↑↓ 选、Enter 追加到提示词末尾">
          </div>
          <!-- ❓ 帮助卡（2026-10-14）：手动展开，不自动弹（面板是进阶场景，网页版才有首访引导） -->
          <div class="pc-helpbox" id="pcGHelpBox" style="display:none">
            <div class="pc-helphead"><b>30 秒上手</b><span class="pc-wsp"></span><span class="pc-helpclose" id="pcGHelpClose">收起 ▲</span></div>
            <div class="pc-helpbody">

              <p style="color:#8fa3bd"><b>一、两个版本的区别</b></p>
              <p>· <b>节点版</b>（这里）：参数写进节点 widget，<b>存进工作流</b>，换电脑带着工作流走就能复现；多了 seed 回查与「复现」。</p>
              <p>· <b>网页版</b>（桌面那个 html）：功能更全（槽位管理、词库浏览、配置导入导出），设置存在浏览器本地。</p>
              <p>· 两边词库和生成逻辑完全一致，<b>同一个 seed 抽出来是同一组词</b>。</p>

              <p style="color:#8fa3bd;margin-top:10px"><b>二、30 秒上手</b></p>
              <p>① 点一个「搭配预设」（新手用 <b>插画</b>；要干净用 <b>极简</b>；角色立绘用 <b>立绘</b>；两个人用 <b>双人</b>）。</p>
              <p>② 点 <b>组合生成</b>，不满意就再点。只差某个词 → 点那个标签卡片上的 <span class="pc-k">🎲</span>。</p>
              <p>③ 把节点输出口接到 <b>CLIP Text Encode</b> 的 text 输入。</p>

              <p style="color:#8fa3bd;margin-top:10px"><b>三、节点右侧参数（widget 逐个）</b></p>
              <p>· <b>preset</b> 档位；<b>gender</b> 只看女性 / 全部 / 只看男性 / <b>非人</b>（史莱姆、吉祥物、恶魔本体）；<b>nsfw_filter</b> 过滤涩涩。</p>
              <p>· <b>seed</b> 换数字＝换一组；同一个数字可完整复现。面板上的 seed 徽章点一下可复制。</p>
              <p>· <b>add_quality</b> 前置画质词（masterpiece / best quality / score_9 …）。</p>
              <p>· <b>space_out</b> 下划线→空格：Qwen / Anima / Krea 建议开；Pony / Illustrious 建议关。</p>
              <p>· <b>neg_mode</b> 负面词档位；<b>show_detail</b> 输出明细。</p>
              <p>· <b>slots_json</b> 槽位开关（面板自动维护，别手改）；<b>series</b> 系列筛选（留空＝全部作品）。</p>
              <p>· <b>locked_json</b> 锁定词（面板自动维护）；<b>auto_copyright</b> 角色自动补所属作品版权词。</p>
              <p>· <b>auto_boost</b> 细节联动：抽到东西带配套词（折扇→拿着扇子、婚纱→头纱）。</p>
              <p>· <b>anima_mode</b> 画师名加 @（Anima 系必须，其他模型别开）。</p>
              <p>· <b>cross_series</b> 跨作品配对：<b>关</b>＝两人一定同作品（实测 100%），<b>开</b>＝各自独立抽。两种都保证同性别。</p>
              <p style="color:#7f8ea8">※ 这些在面板上都有对应控件，面板和 widget 是双向同步的。</p>

              <p style="color:#8fa3bd;margin-top:10px"><b>四、面板顶栏开关</b></p>
              <p>固定画质词 · 空格输出 · 画师@ · 穿搭（自动/连衣裙/上下装/泳装）· 同作品/跨作品 · NSFW过滤 · 细节联动。悬停都有说明。</p>
              <p>· <b>穿搭:自动</b>：每次在「连衣裙」和「上装+下装」之间随机，<b>三者永远只出一个</b>。</p>
              <p>· <b>泳装</b>：只出泳装槽，并<b>自动跳过</b> 上装 / 下装 / 连衣裙 / 袖型与领口 / 装饰与材质 —— 比基尼没有袖子，堆蕾丝只会画成"布满蕾丝的泳衣"。</p>

              <p style="color:#8fa3bd;margin-top:10px"><b>五、槽位区</b></p>
              <p>· 点槽位名开 / 关；悬停右侧 <b>− N ＋</b> 调每次抽几个（上限 6）。</p>
              <p>· 常用槽可「吸底」，固定在列表最前面。</p>
              <p>· <b>槽位区、标签区、中文对照、结果框都能拖右下角调高度</b>，按自己习惯摆。</p>
              <p>· ⚙ 槽位菜单：重命名 / 预览该槽词池 / 还原改动 / 删除槽位。</p>

              <p style="color:#8fa3bd;margin-top:10px"><b>六、结果区</b></p>
              <p>· 标签卡片<b>按类别上色</b>：青=角色、橙=表情/眼睛/发型/特征、蓝=衣服、紫=鞋袜首饰、绿=姿势动作、黄=场景光照道具、灰蓝=镜头构图、金=作品画师、灰=人数。</p>
              <p>· <b>悬停</b>卡片 → 结果框里选中那个词（移开恢复）；<b>点一下</b> → <b>持续选中</b>，再点取消。</p>
              <p>· 卡片按钮：<span class="pc-k">🔒</span> 锁定 · <span class="pc-k">🎲</span> 只换这个槽 · <span class="pc-k">×</span> 删除。</p>
              <p>· 右键：从本槽剔除 / 从本组移除 / 全局剔除 / 移动到其他槽 /
                ⚖ 抽取频率（倍数，1 = 默认，改抽中概率）/ 🔆 提示词权重（写成 (tag:1.5)，改模型注意力）。</p>
              <p>· 顶部：全锁 / 上一组 / 下一组 / seed 徽章（点击复制）/ 复现 / ☆收藏 / ★收藏夹 / 隐藏中文。</p>

              <p style="color:#8fa3bd;margin-top:10px"><b>七、双人模式（和单人差别很大）</b></p>
              <p>输出分三段：<b>第 1 人 / 第 2 人 / 公共描述</b>，每段一行。</p>
              <p>· <b>每人各一份的槽</b>：人物特征、发色、发型、眼睛、表情、<b>基础姿势、动作</b>、上装、下装、连衣裙、泳装、袖型、装饰、腿部、鞋子、袜子、首饰、头饰。</p>
              <p>· <b>两人各摆各的姿势</b>：双人档默认<b>不抽「双人互动」</b>（拥抱/摸头那类容易把两人画糊）。想互动就手动打开那个槽。</p>
              <p>· 姿势与动作会自动避让：躺着/坐着/跪着时，这个人的「跑步/走路/跳」会被剔掉。</p>
              <p>· <b>穿搭按人随机</b>：可以一人连衣裙、一人上衣+下装，也可以碰巧同款。同一个人身上永远是二选一，不叠穿。</p>
              <p>· <b>同作品 100%</b>：两人一定来自同一部作品（只有该作品筛完只剩 1 人时才退回独立抽）。</p>
              <p>· <b>删了再补位</b>：删掉一个角色后，用搜索框选同槽的新角色，会<b>插回原位置</b>并恢复"第几个人"的身份。</p>
              <p>· <b>人物特征</b>：赛马娘/兽娘这类整套带走（马耳+马尾+马娘）；没有映射的角色（如申鹤）不硬塞，槽位空着。</p>

              <p style="color:#8fa3bd;margin-top:10px"><b>八、搜索标签</b></p>
              <p>· 顶栏右侧「搜标签追加…」：跟光标无关，输入就出候选，点一下追加到末尾。</p>
              <p>· 也可以直接在结果框里打字，同样弹候选；<b>不用先打空格或逗号</b>，粘连着打也能识别（会自动取末尾那段中文/单词）。</p>
              <p>· 搜不到会显示「没有匹配：「查询串」」，方便判断是不是打错。↑↓ 选、Enter 采用、Esc 关闭。</p>

              <p style="color:#8fa3bd;margin-top:10px"><b>九、人数是自动补的</b></p>
              <p>「人数」槽默认关着，但工具会按<b>实际抽到几个角色</b>自动补：1 人 → <b>1girl + solo</b>；2 人 → <b>2girls</b>。</p>
              <p>槽位格子上会显示 <b>「自动2」</b>，告诉你这是自动补的、补了几个。</p>

              <p style="color:#8fa3bd;margin-top:10px"><b>十、热度加权</b></p>
              <p>不是平均随机 —— 按 danbooru 帖子数加权：<b>权重 = 帖子数 ^ 0.5</b>。</p>
              <p>1000 帖的词约为 100 帖的 3 倍机会；冷门词仍可能抽到，但不再主导（角色池原来有一半是 &lt;200 帖）。</p>
              <p>想调：<code>data/rules.json</code> 里的 <b>PC_ALPHA</b> —— 0=完全平均，0.5=默认，1.0=严格按帖子数。</p>

              <p style="color:#8fa3bd;margin-top:10px"><b>十一、中文对照 / 复制</b></p>
              <p>中文对照把当前组合翻成通顺一句；双人时<b>按人分段</b>（人数 / 第1人 / 第2人 / 公共）。</p>

              <p style="color:#8fa3bd;margin-top:10px"><b>十二、状态存哪</b></p>
              <p>槽位开关、数量、锁定、档位都写回节点 widget，<b>保存工作流时一起存</b>；换机器把工作流带过去即可。</p>
              <p>节点上方那条原生参数已经被面板盖住 —— 不是坏了，是刻意盖的（参数还在，能存能读）。</p>

              <p style="color:#8fa3bd;margin-top:10px"><b>十三、常见问题</b></p>
              <p>· <b>某个槽不出词</b>：槽位关着 / 池子被性别或 NSFW 过滤筛空 / 被互斥规则挡掉（如泳装下的袖型、躺姿下的跑步）。</p>
              <p>· <b>角色没带作品词</b>：库里没有对应版权词（宁可少补，不补错）。</p>
              <p>· <b>数量调 2 只出 1 个</b>：基础姿势这类槽整体只出 1 个（双人时每人 1 个），多出会打架。</p>
              <p>· <b>换了新版本没变化</b>：改了 Python 要重启 ComfyUI；只改 JS 刷新页面。右上角能看到构建号。</p>
              <p>· <b>出图手崩</b>：关掉「细节联动」，或把「手持物」「手臂与手势」其中一个关掉。</p>
              <p>· <b>永久排除</b>：《我的英雄学院》整组（系列 + 角色名两层拦截）不会出现在任何池子里。</p>

              <p style="color:#6b7a93;font-size:10.5px;margin-top:8px">版本 2026-10-18 · 与网页版说明同步</p>
            </div>
          </div>
          <!-- 性别筛选 -->
          <div class="pc-wrow">
            <span class="pc-wlab">性别筛选</span>
            <span class="pc-wchips" id="pcGGender">
              <span class="pc-wchip" data-v="只看女性">只看女性</span>
              <span class="pc-wchip" data-v="全部">全部</span>
              <span class="pc-wchip" data-v="只看男性">只看男性</span>
              <span class="pc-wchip" data-v="非人" title="只抽非人类角色：史莱姆 / 吉祥物 / 恶魔本体 / 巨人等（人数词会写成 1other）">非人</span>
            </span>
            <span class="pc-wlab2">|</span>
            <span class="pc-wchip on" id="pcGNsfw" title="关掉就不过滤 NSFW 标签">NSFW过滤</span>
            <span class="pc-wchip" id="pcGNsfwOnly" title="开启后：泳装/上装/下装/姿势/互动等有 NSFW 词的槽只抽 NSFW；发型/表情/光照等照常，不会空槽">只出NSFW</span>
            <span class="pc-wchip on" id="pcGBoost" title="抽到东西时自动带上配套词（折扇→拿着扇子 / 婚纱→头纱 / 背带裙→背带）">细节联动</span>
          </div>
          <!-- 系列筛选 -->
          <div class="pc-wrow">
            <span class="pc-wlab">系列筛选</span>
            <input class="pc-winput" id="pcGSeries" list="pcGSeriesList"
                   placeholder="输入如：原神 / 东方Project / Fate（留空=全部作品）">
            <datalist id="pcGSeriesList"></datalist>
            <span class="pc-whint" id="pcGSeriesHit"></span>
            <button class="pc-wbtn sm" id="pcGSeriesClr">清空</button>
          </div>
          <!-- 搭配预设 -->
          <div class="pc-wrow">
            <span class="pc-wlab">搭配预设</span>
            <span class="pc-wchips" id="pcGPresets"></span>
            <span class="pc-wchip add" id="pcGSavePreset" title="把当前槽位组合存成一个新档位">+ 存为档位</span>
          </div>
          <!-- 组合结果 -->
          <div class="pc-wcard">
            <div class="pc-wcardhead">
              <span class="pc-wtitle">组合结果</span>
              <span class="pc-wsub" id="pcGCount">0 个标签</span>
              <span class="pc-wsp"></span>
              <!-- 2026-10-18（阿君：像网页一样要有全锁/解锁全部） -->
              <button class="pc-wbtn sm" id="pcGLockAll" title="锁定当前全部标签：下次生成原样保留（可再点标签上的锁单独解锁）">🔒 全锁</button>
              <button class="pc-wbtn sm" id="pcGUnlockAll" title="解除全部锁定，恢复随机">🔓 解锁全部</button>
              <button class="pc-wbtn sm" id="pcGPrev">← 上一组</button>
              <button class="pc-wbtn sm" id="pcGNext">下一组 →</button>
              <!-- ⭐ 2026-10-20（阿君：组数一多，上一组/下一组翻太麻烦，要能统一浏览） -->
              <button class="pc-wbtn sm" id="pcGHist" title="打开历史列表，一次看到所有生成过的组合">☰ 历史</button>
              <!-- 2026-09-29 用户要求：要有「第几组 / 共几组」（网页版 histStat 就是它） -->
              <span class="pc-whist" id="pcGHistN" title="当前是第几组 / 共几组">—</span>
              <!-- ⭐ 2026-10-08（阿君要的）：seed 回查 ——
                   出图之后想找回「这张图用的是哪组词」：这张图对应的 seed 就写在旁边，
                   点一下复制；也可以把从 PNG 里读到的 seed 塞进输入框，点「复现」还原那一组。 -->
              <span class="pc-wseed" id="pcGSeed"
                    title="这组标签的 seed（= KSampler 之外那个『组合 seed』）。点一下复制 —— 出图后在 PNG 信息里也能看到它">seed —</span>
              <input class="pc-winput pc-wseedin" id="pcGSeedIn"
                     placeholder="seed 或 386570@极简" title="填 seed（整数）；也可以填「386570@极简」这种带档位的写法 —— 点「复现」会自动切回该档位">
              <button class="pc-wbtn sm" id="pcGReplay" title="按这个 seed 把那组标签原样还原">复现</button>
              <button class="pc-wbtn sm" id="pcGFav">☆ 收藏</button>
              <button class="pc-wbtn sm" id="pcGFavs">★ 收藏夹<i id="pcGFavN">0</i></button>
              <button class="pc-wbtn sm" id="pcGSlotMgr" title="跳到「槽位池」页">⚙ 槽位管理<i id="pcGSlotN">0</i></button>
              <button class="pc-wbtn sm" id="pcGCn" title="隐藏/显示中文对照">隐藏中文</button>
            </div>
            <!-- ⭐ 2026-10-19 阿君：「我在立绘档位粘极简的 seed，出来不一样，
                 你不告诉我要切回极简，那我不就一直不知道了？」
                 ⇒ 粘进 seed 输入框就立刻告诉他这 seed 原来属于哪个档位。 -->
            <div class="pc-seedhint" id="pcGSeedHint"></div>
            <textarea class="pc-wtext" id="pcGText" spellcheck="false"></textarea>
            <div class="pc-wtags" id="pcGTags"></div>
            <!-- 中文对照（2026-10-05 对齐网页 #cnRow：组合结果下面那句中文）-->
            <div class="pc-cnrow" id="pcGCnRow" style="display:none">
              <div class="pc-cnlab"><span>中文对照</span></div>
              <div class="pc-cnbox" id="pcGCnBox"></div>
            </div>
            <!-- 收藏夹列表（默认收着，点「★ 收藏夹」展开）-->
            <div class="pc-wfav" id="pcGFavBox"></div>
          </div>
          <!-- 槽位 -->
          <div class="pc-wcard">
            <div class="pc-wcardhead">
              <span class="pc-wtitle">槽位</span>
              <span class="pc-wsub" id="pcGSlotStat"></span>
              <span class="pc-wsp"></span>
              <span class="pc-whint">点击开关；悬停可调数量（− N ＋）</span>
              <button class="pc-wbtn sm" id="pcGAllOn">全开</button>
              <button class="pc-wbtn sm" id="pcGAllOff">全关</button>
            </div>
            <div id="pcGGroups"></div>
          </div>
          <!-- 标签词库（2026-09-29：原来是个独立标签页，现按网页布局内联到这里） -->
          <div class="pc-wcard" id="pcGenDictCard">
            <div id="pcTabDict" class="pc-dictinline"></div>
          </div>

        </div>
      </div>
    </div>`;
  if (container) {
    container.appendChild(wrap);
  } else {
    document.body.appendChild(wrap);
    _pcFullEl = wrap;
  }
  try { renderAuthorBar(wrap); } catch (e) {}

  const sub = wrap.querySelector("#pcFSub");
  const gText = wrap.querySelector("#pcGText");
  const gTags = wrap.querySelector("#pcGTags");
  const gCount = wrap.querySelector("#pcGCount");
  const gGroups = wrap.querySelector("#pcGGroups");
  const gPresets = wrap.querySelector("#pcGPresets");
  const gSeries = wrap.querySelector("#pcGSeries");
  /* UI 状态（不落盘的小开关） */
  let hideCn = false;              // 隐藏中文对照
  let seriesQ = "";                // 系列筛选取值
  const hist = [];                 // 历史（上一组/下一组）
  let histIdx = -1;

  /* ⭐ 2026-10-19（阿君：翻到第 5 组点运行，出的却是第 10 组）：
     节点是**无状态重算** —— 它只认 widget 上的参数，run() 里按 seed 重新抽一遍。
     面板上「显示哪组」是面板自己的状态，两边从来没同步过。
     ⇒ `_pinned` = 「当前显示的内容，seed 复现不出来，必须原样钉住」。
        · 翻历史 → 那组本来就是某个 seed 抽的 ⇒ 把 seed 退回去就能重算，不用钉
        · 手动改词/加词/删词 → 改过的内容 seed 表达不出来 ⇒ 必须钉
       钉住时 `pinned_prompt` 写上完整文本，nodes.py 直接原样输出、不看 seed。
       ⚠️ 点「组合生成」一定要清掉它，否则之后就永远是那一组、seed 换不动了。 */
  let _pinned = false;
  /* ⭐ 2026-10-19（阿君：换工作流复制 seed 复现不出来）：
     「复现」调 roll() 时置 true —— 这样 pushHist 不会把**用当前配置硬抽出来的**
     结果写进 seedParams，免得把真正的原产地记录覆盖掉
     （否则第一次复现抽错 ⇒ 写进错的配置 ⇒ 之后再也还原不回原档位）。 */
  let _replaying = false;

  /* widget 读写（与节点共用同一份值） */
  const W = (n) => node.widgets?.find((w) => w.name === n);
  const wval = (n, d) => { const w = W(n); return w === undefined || w.value === undefined ? d : w.value; };
  /* ⭐ 2026-10-20（阿君：选了女性池，搜角色/看角色槽就该全是女性）：
     词库搜索（/pc/dict）也要带上当前性别档，否则能搜到男性角色和怪兽。 */
  const _gq = () => "&gender=" + encodeURIComponent(wval("gender", "只看女性"))
    + "&nsfw=" + (wval("nsfw_filter", true) ? 1 : 0) + "&nsfwOnly=" + (wval("nsfw_only", false) ? 1 : 0);
  const setW = (n, v) => {
    const w = W(n);
    if (!w) return;
    w.value = v;
    try { w.callback?.(v); } catch (e) {}
    node.graph?.change?.();
    app.graph?.setDirtyCanvas?.(true, true);
  };
  const readSlots = () => { try { return JSON.parse(wval("slots_json", "") || "{}"); } catch (e) { return {}; } };
  /* ⭐ 2026-10-19：把「当前显示的这组」同步到节点的 pinned_prompt。
     pinned 非空 ⇒ nodes.py 直接输出这段文本、不看 seed。
     什么时候钉：翻历史不需要（seed 能重算），手动改词必须（seed 表达不出来）。 */
  const syncPin = () => setW("pinned_prompt", _pinned ? String(curPos || "") : "");

  /* ⭐ 2026-10-20（阿君：切工作流再切回来，组合结果没了；文本框节点却还在）：
     文本框能保留是因为它是 widget 的值、会被写进工作流 JSON。
     这里把「当前显示的这组」也写进节点控件 panel_state，切工作流回来再读出来。
     ⛔ 只影响显示，不参与生成 —— 生成仍然只看 seed / pinned_prompt。 */
  /* ⭐ 2026-10-21：sessionStorage 镜像的键（按节点 id 分开，多个节点不互相覆盖）。
     只在同一浏览器标签页内存活 —— 刷新能捞回来，关掉标签页就没了。 */
  const _ssKey = () => "pcPanelState:" + String((node && node.id) || 0);

  function _stateJson(st) {
    const _hh = hist.slice(-20).map((h) => ({
      t: (h.tags || []).map((t) => [t.prompt || "", t.name || "", t.slot || "", t.out || ""]),
      p: h.pos || "", s: h.seed || 0, pin: !!h.pinned,
      pr: (h.params && h.params.preset) || "" }));
    const _off = Math.max(0, hist.length - _hh.length);
    return JSON.stringify(st || { v: 1, sid: PC_SID, armed: true,
      i: Math.max(-1, (histIdx | 0) - _off), h: _hh, p: curPos || "",
      s: Number(wval("seed", 0)) || 0,
      t: curTags.map((t) => [t.prompt || "", t.name || "", t.slot || "", t.out || ""]) });
  }
  function _savePanelState() {
    try {
      /* 空面板**不写**：否则启动时 renderResult 会把上次存的快照抹成空的，
         重启后就再也恢复不出来。要清空请走「清空」按钮（它显式写 ""）。 */
      if (!curTags.length && !String(curPos || "").trim()) return;
      const st = _stateJson();
      if (String(wval("panel_state", "")) !== st) { setW("panel_state", st); _syncDirty = true; }
      /* ⭐ 2026-10-21（阿君：Ctrl+F5 后跑了一下午的历史组合全没了）：
         节点控件那条路**扛不住刷新页面** —— 刷新后 ComfyUI 按工作流 JSON 重建
         节点，panel_state 是空的（实测）。所以同步镜像一份到 sessionStorage，
         renderResult 里读不到控件那份就退回读它。
         关掉标签页 sessionStorage 自动清空 ⇒ 冷启动依旧「完全干净」。 */
      try { sessionStorage.setItem(_ssKey(), st); } catch (e) {}
    } catch (e) {}
  }
  /* 任何「让 seed 复现不出来」的编辑都走这里。⚠️ 必须在 renderResult 之前调，
     因为 renderResult 要读 _pinned 决定 seed 徽章怎么写。 */
  const markEdited = () => {
    const _was = _pinned;
    _pinned = true;
    /* ⭐ 2026-10-21（阿君：手改过的组不该还挂着原 seed）：
       「seed X 的原始产物」被改动的那一刻，这就是全新的一组 ⇒ 分配一个新 seed。
       原 seed 仍留在历史里对应改动前那组；新 seed 是手改后这组的身份号。
       ⛔ 只在「干净 → 手改」第一次编辑换 —— 连续删词/敲字不能狂换（每个字符换一个）。
       ⛔ 这个新 seed 在 seedParams 里没有抽签记录（它不是抽签起点），
          复现按钮对它只会走「按当前配置硬抽」；还原手改组靠历史/收藏。 */
    if (!_was) {
      try {
        const _cur = Number(wval("seed", 0)) || 0;
        setW("seed", (_cur + 1 + Math.floor(Math.random() * 99999)) % 4294967296);
      } catch (e) {}
      /* ⭐ 2026-10-21（阿君：删角色再加新角色，历史怎么还是 1 组）：
         手改 = 全新一组 ⇒ 历史里**追加**一条，别把改动前那组覆盖掉。
         原组留在 hist 里，「上一组」能翻回改动前的 seed；
         之后的连续编辑只更新追加出来的这一条（不然敲一个字就多一条）。 */
      if (histIdx >= 0 && hist[histIdx]) {
        hist.push({ tags: curTags.slice(), pos: curPos,
                    seed: Number(wval("seed", 0)) || 0, pinned: true,
                    params: hist[histIdx].params || null });
        if (hist.length > 200) hist.shift();
        histIdx = hist.length - 1;
        lastPushKey = curTags.map((t) => t.prompt).join("|");
      }
    }
    /* 顺手回写到当前那条历史：不然「改完 → 上一组 → 下一组」会把这组变回改之前的样子。
       pinned:true 表示这组不是 seed 抽出来的，翻回来时必须原样钉住。
       seed 也跟着写：翻回来时徽章显示的才是这组自己的新 seed，不是改动前的旧 seed。 */
    const h = hist[histIdx];
    if (h) {
      h.tags = curTags.slice(); h.pos = curPos; h.pinned = true;
      if (!_was) h.seed = Number(wval("seed", 0)) || h.seed;
    }
    syncPin();
    /* 历史条数刚变过 ⇒ 计数器和状态都要立刻刷新/落盘，
       不然切工作流再回来会少一组（2026-10-20 踩过同一条）。 */
    try { renderHist(); } catch (e) {}
    try { _savePanelState(); } catch (e) {}
  };
  /* ⭐ 2026-10-21（阿君：blue sailor collar 跑到标签末尾去了）：
     加词时若**同槽已有词**，插到同槽最后一个的后面 —— 袖型与领口就该挨着袖型与领口，
     别甩到整串末尾。找不到同槽的才追加到末尾；「自定」不参与归位。 */
  const insertBesideSlot = (arr, item) => {
    if (!item || !item.slot || item.slot === "自定") { arr.push(item); return arr; }
    let at = -1;
    for (let i = 0; i < arr.length; i++) if (arr[i].slot === item.slot) at = i;
    if (at >= 0) { arr.splice(at + 1, 0, item); return arr; }
    /* ⭐ 2026-10-21（阿君：加的光照词被甩到整串末尾）：
       同槽没有词时别无脑追加 —— 按槽位全局顺序（meta.slotOrder，即 Anima 官方
       推荐顺序）插进正确区域：光照就该排在场景旁边，而不是手势/手持物后面。 */
    const order = (meta && meta.slotOrder) || [];
    /* 排序权重与后端 OUT_ORDER 同源：前 10 类照抄，其余 100+槽序（保相对顺序） */
    const OUTO = { "配色倾向": -1, "画风取向": -0.5, "人数": 0, "角色": 1, "作品": 2,
                   "版权": 3, "画师": 4, "风格": 5, "人物特征": 6, "发色": 7,
                   "发型": 8, "眼睛": 9 };
    const rank = (sl) => {
      if (sl in OUTO) return OUTO[sl];
      const k = order.indexOf(sl);
      return k < 0 ? 9999 : 100 + k;    /* 槽表里没有的槽 ⇒ 排最后，别插到中间 */
    };
    const r = rank(item.slot);
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].slot === "自定") continue;
      if (rank(arr[i].slot) > r) { arr.splice(i, 0, item); return arr; }
    }
    arr.push(item);
    return arr;
  };

  /* 槽位开关表格：值可能是 true（=1）或数字 1~6（2026-09-29 加每槽数量）。
     统一读成数字，0 表示关。 */
  const slotCountOf = (v) => {
    if (v === true) return 1;
    if (v === false || v === undefined || v === null) return 0;
    const n = Number(v);
    return isFinite(n) ? Math.max(0, Math.min(6, Math.round(n))) : 0;
  };
  const nz2 = (o) => { const r = {}; Object.keys(o || {}).forEach((k) => { const n = slotCountOf(o[k]); if (n > 0) r[k] = n; }); return r; };
  const writeSlots = (o) => setW("slots_json", Object.keys(o).length ? JSON.stringify(o) : "");

  const close = () => {
    wrap.remove();
    if (_pcFullEl === wrap) _pcFullEl = null;
    document.removeEventListener("keydown", onEsc, true);
  };

  /* ---- 标签页已去掉（2026-09-29）----
     槽位池 / 档位 的功能都并进「⚙ 槽位管理」弹窗了；词库浏览按网页布局内联到组合页底部。
     所以这里不再需要 TABS / tabBtns 切换逻辑。 */
  const TABS = { dict: wrap.querySelector("#pcTabDict") };
  /* #28 槽位池编辑器 —— ⚠️ 必须等 meta 到了再建（它要用 meta.slotOrder），
     所以放在下面 loadMeta().then 里创建，这里只留个占位引用。 */
  /* 槽位池/档位已并入「⚙ 槽位管理」弹窗，不再有对应标签页 */
  let poolTab = null;      // 保留：弹窗里的操作会兜底调用（有则刷、无则跳过）
  let dictTab = null;
  const onEsc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  if (!container) {
    /* 弹层模式才要 Esc / 关闭按钮 / 点遮罩关闭；内嵌模式下这些都没意义 */
    document.addEventListener("keydown", onEsc, true);
    wrap.querySelector(".pc-full-close").onclick = close;
    wrap.addEventListener("mousedown", (e) => { if (e.target === wrap) close(); });
  }

  let meta = null;
  let curTags = [];
  let curPos = "", curNeg = "";
  /* 2026-10-18：结果框 → 卡片 反向同步用的镜像层状态 */
  let _syncDirty = true, _mirror = null, _mirrorBoxes = null;
  let curSeries = null;            // 上一次 /preview 返回的系列匹配信息
  let favOpen = false;             // 收藏夹列表是否展开

  /* ---- 锁定标签（2026-10-05，对齐网页 state.locked）--------------------------
     点结果区标签上的 🔒 → 这个词在**下一次「组合生成」里原样保留**（并占用它的互斥组），
     其余槽照常随机。⛔ 与网页不同的一点：节点没有内存态，所以锁定的词写进节点的
     `locked_json` widget —— 这样①刷新面板还在 ②真跑工作流时后端（nodes.py）也认。
     ⛔ 别存 localStorage：网页是 file://、ComfyUI 是 http，两个 origin 不互通（老坑）。
     -------------------------------------------------------------------------- */
  const readLocked = () => {
    try {
      const v = JSON.parse(wval("locked_json", "") || "[]");
      return Array.isArray(v) ? v.filter((x) => x && x.prompt) : [];
    } catch (e) { return []; }
  };
  const writeLocked = (arr) => {
    locked = arr;
    /* ⛔ 静默失效防御：老版本节点没有 locked_json 这个 widget（= ComfyUI 还没重启、
       加载的仍是旧 INPUT_TYPES），setW 会**悄悄什么都不做** —— 用户只会说"锁了没用"。
       这里必须叫出来。（2026-10-05 加此功能时就是靠这条才发现要重启的） */
    if (!W("locked_json")) {
      console.error("[prompt-combiner] 节点没有 locked_json widget：ComfyUI 需重启才能生效");
      try { toast("锁定需要重启 ComfyUI 才生效", true); } catch (e) {}
      return;
    }
    setW("locked_json", arr.length ? JSON.stringify(arr) : "");
  };
  let locked = readLocked();                       // [{prompt,name,slot,g}]
  const isLocked = (p) => locked.some((x) => x.prompt === p);
  /* 锁图标（照抄网页 .lock-btn 的两段 SVG；锁上=实心、没锁=描边） */
  const LOCK_SVG_ON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">'
    + '<rect x="4" y="11" width="16" height="9" rx="2"/>'
    + '<path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  const LOCK_SVG_OFF = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" '
    + 'stroke="currentColor" stroke-width="2">'
    + '<rect x="4" y="11" width="16" height="9" rx="2"/>'
    + '<path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

  /* space_out 规则（与后端 fmt_tag 一致：小写 + 空格代替下划线，score_* 例外） */
  const fmtOut = (p) => {
    const t = String(p == null ? "" : p);
    if (!wval("space_out", true) || /^score_\d/.test(t)) return t;
    return t.replace(/_/g, " ");
  };

  /* 2026-10-17 拆分职责（阿君问「Anima 模式是不是多余了」）：
     ① **括号转义 → 永远开**：ComfyUI/WebUI 把裸 (xxx) 当加权 ×1.1，
        字典里 30.38% 的词自带括号，不转义整条标签就歪了。跟用哪个模型无关。
     ② **@ 画师前缀 → 才归 anima 开关**：只有 Anima 系要 @，Illustrious/Pony 裸写。
     ⚠️ 用户手输的词（slot 为空或「自定」）不转义：他可能本来就想写 (chibi:2) 加权。
     ⚠️ 到处都调它，避免「整句转义了、逐词条没转义」这种两处不一致。 */
  const outOf = (p, slot) => {
    let s = fmtOut(p);
    if (slot && slot !== "自定") s = s.replace(/\(/g, "\\(").replace(/\)/g, "\\)");
    if (wval("anima_mode", false) && slot === "画师" && s && s.charAt(0) !== "@") s = "@" + s;
    return s;
  };

  /* 2026-10-17：档位改名兼容表（旧名 → 现名），与 core.PRESET_ALIASES 保持一致。
     节点端 INPUT_TYPES 里仍保留旧名（否则 ComfyUI 校验直接报「输入值不可用」，
     连 Python 都进不去），所以这里负责把 widget 值改写成现名。 */
  const PRESET_ALIASES = { "全身立绘": "立绘", "极简日常": "极简", "插画美图": "插画", "物件随搭": "插画", "场景大图": "插画", "空景": "插画" };
  const canonPreset = (n) => PRESET_ALIASES[n] || n;

  const slotsOfPreset = (name) => {
    /* 2026-10-14：档位改名「全身立绘」→「立绘」，老工作流里存的旧档名先把名字映射回来，
       否则面板上没有任何档位高亮（其实后端能正常抽）。 */
    name = canonPreset(name);
    const p = (meta.presets.find((x) => x.name === name)) || meta.presets[0];
    const o = {};
    /* 2026-10-17：「双人」档用 counts:{"角色":2} 让角色槽抽两个。
       这里直接把数量写进对象（值可以是数字，也可以是 true=1）。 */
    (p.on || []).forEach((s) => { o[s] = (p.counts && p.counts[s]) || true; });
    return o;
  };
  const currentOn = () => {
    const m = readSlots();
    if (Object.keys(m).length) return nz2(m);          // 手动 → 数字表（旧 bool 也兼容）
    const o = {};
    const _sp = slotsOfPreset(wval("preset", ""));
    Object.keys(_sp).forEach((k) => { o[k] = (typeof _sp[k] === "number" ? _sp[k] : 1); });
    return o;
  };

  /* ⭐ 2026-10-08（阿君要的③）：extraLocked = 「只换这一个槽」用的**临时**锁定。
     把其它槽现有的词全部丢进来，后端就会原样保留它们、只把目标槽重抽一遍。
     ⚠️ 只影响这一次请求 —— 不去动 state.locked（用户真锁的词不受影响）。 */
  async function roll(extraLocked) {
    /* ⛔ 2026-10-19：每次抽签都重新钉一次 fixed。面板上显示的 seed 必须就是
       出图用的那个，否则「复制 seed 复现」整个功能是空的。顺手也把定时兜底续上。 */
    try { pinSeedControl(node); } catch (e) {}
    /* ⭐ 2026-11-22（「每次随机」带来的新竞态）：
       连点两次运行 → 两次 /preview 同时在飞。谁先回来跟谁发起顺序无关，
       晚回来的那个会把面板刷成**旧 seed** 抽出来的词，而控件上是新 seed
       ⇒ 又变成「显示和出图对不上」。
       所以发起时记下 seed，回来时对不上就直接丢弃这次结果。 */
    const _seedAtStart = Number(wval("seed", 0)) || 0;
    try {
      const _lock = (Array.isArray(extraLocked) && extraLocked.length)
        ? locked.concat(extraLocked) : locked;
      const d = await api("/preview", {
        method: "POST",
        body: JSON.stringify({
          preset: wval("preset", ""),
          gender: wval("gender", "只看女性"),
          nsfw: !!wval("nsfw_filter", true),
          nsfwOnly: !!wval("nsfw_only", false),
          seed: _seedAtStart,
          spaceOut: !!wval("space_out", true),
          addQuality: !!wval("add_quality", true),
          series: seriesQ,      // 系列筛选（后端只收窄「角色」槽）
          /* ⚠️ 必须带上当前槽位表（含每槽数量）——
             否则面板上改了数量/开关，预览还是按预设抽，和真跑工作流对不上。
             （2026-09-29 实测踩过：首饰=3 预览仍只出 1 个） */
          slots: (() => {
            /* 有手动表就原样发送，尤其要保留「全关」的全零表；
               不能用 currentOn() 后再按空对象转 null，否则又会回退到预设。 */
            const raw = readSlots();
            return raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length ? raw : null;
          })(),
          /* 锁定标签（2026-10-05）：后端会原样保留这些词，并优先占用它们的互斥组。
             ⛔ 不发的话「锁定」就只是界面上一个装饰，下次生成照样换掉。 */
          locked: _lock,
          /* 自动补作品（2026-10-11）：抽到角色时补上所属作品版权词。默认开。 */
          autoCR: !!wval("auto_copyright", true),
          autoBoost: !!wval("auto_boost", true),
          /* 画师 @ 前缀（2026-10-15 原「Anima 模式」）：只管画师要不要加 @。默认关。 */
          animaMode: !!wval("anima_mode", false),
          /* 跨作品配对（2026-10-18）：false=第二人优先同作品；true=各自独立抽 */
          crossSeries: !!wval("cross_series", false),
        }),
      });
      /* 这次结果已经过期（期间 seed 又被换过）⇒ 丢掉，别覆盖面板 */
      if ((Number(wval("seed", 0)) || 0) !== _seedAtStart) return;
      curTags = d.tags;
      _vacancies.length = 0;        // 新的一组：旧的空位作废
      _cacheTags(d.tags);
      /* 2026-10-19：新抽出来的一组 = 纯 seed 产物 ⇒ 解除固定，
         让节点回到「按 seed 重算」，这样两边一定一致。 */
      _pinned = false;
      syncPin();
      /* 「人数」自动补词后，槽位格子要跟着显示「自动N」（2026-10-18 阿君反馈） */
      try { renderGen(); } catch (e) {}
      curPos = d.positive;
      curSeries = d.series || null;
      /* 后端可能因为「全局剔除 / 槽位被删」没能保住某个锁定词 → 顺手把锁清掉，
         否则界面上会一直显示一个再也抽不到的锁定项（照网页 5499 行的清理写法）。 */
      const _seen = new Set((curTags || []).map((t) => t.prompt));
      if (locked.some((x) => !_seen.has(x.prompt))) {
        writeLocked(locked.filter((x) => _seen.has(x.prompt)));
      }
      renderSeriesHit();
      /* ⛔ 2026-10-20：整组换掉了 ⇒ 文本框必须**无条件**跟着换。
         renderResult() 里那句「用户正在编辑就不覆盖」是给打字用的，
         这里如果不强制，焦点还停在结果框时点「组合生成」文本会**纹丝不动**，
         于是「标签列表是新的一组、框里还是上一组」—— 之后再动一个字，
         旧文本就被当成真相重建回 curTags，凭空多出一堆上一组的词（实测多出 3 个）。 */
      _forceText = true;
      renderResult();
      pushHist();            // 记进历史（上一组/下一组）
      /* ⭐ 2026-10-06 对齐网页 btnRand：给一句明确回执
         （「已生成 18 个标签的组合」/「已生成（保留 N 个锁定标签）」）。
         原来这里没有 toast —— 点了生成只有统计区数字在变，容易被上一条 toast 误导。 */
      const _nl = curTags.filter((t) => isLocked(t.prompt)).length;
      toast(_nl > 0 ? ("已生成（保留 " + _nl + " 个锁定标签）")
                    : ("已生成 " + curTags.length + " 个标签的组合"));
    } catch (e) {
      gCount.className = "pc-err";
      gCount.textContent = "抽取失败：" + e.message;
    }
  }

  /* 换一个新 seed（「组合生成」和「🎲 只换这一个槽」都要用）。
     ⛔ 2026-10-17 阿君报「景别是全景时点骰子没反应」：
        roll() 用的是**当前 seed**，不换 seed 就是同一串随机数
        → 重抽出来的必然还是同一个词，等于空操作。
        「组合生成」原来每次都 setW("seed", 新值) 所以看不出问题，唯独骰子这条路漏了。
     ⚠️ 不能把换 seed 塞进 roll() 里 —— 「复现」是**先写死 seed 再 roll**，
        塞进 roll 会把用户填的 seed 改掉，就复现不出来了。 */
  function rollSeed() {
    const cur = Number(wval("seed", 0)) || 0;
    setW("seed", (cur + 1 + Math.floor(Math.random() * 99999)) % 4294967296);
  }

  /* 从整段提示词里精确摘掉一个标签（含前后逗号）。
     ⭐ 2026-10-21（真机抓到：删「fang \\(arknights\\)」后文本里残了半个词 `fang \\(\\)`）：
        老写法 `indexOf` 命中就删 —— 而作品词 `arknights` 是角色词 `fang \\(arknights\\)` 的
        **子串**，删作品时把角色词中间那截挖掉了，标签删干净了、文本却留下残骸。
        现在要求命中处两侧必须落在分隔符上（开头/结尾/空格/逗号），否则继续往下找。 */
  function removeSeg(text, seg) {
    if (!seg) return text;
    const sep = (c) => !c || /[\s,\uff0c]/.test(c);
    let from = 0;
    for (;;) {
      const i = text.indexOf(seg, from);
      if (i < 0) return text;
      const end = i + seg.length;
      if (sep(text[i - 1]) && sep(text[end])) {
        if (text.slice(end, end + 2) === ", ") return text.slice(0, i) + text.slice(end + 2);
        if (text.slice(Math.max(0, i - 2), i) === ", ") return text.slice(0, Math.max(0, i - 2)) + text.slice(end);
        return text.slice(0, i) + text.slice(end);
      }
      from = i + 1;      /* 这个命中不是独立的一段 ⇒ 找下一个 */
    }
  }

  function renderHist() {
    /* ⭐ 2026-10-18（阿君）：全锁 / 解锁全部 */
    const lockAllBtn = wrap.querySelector("#pcGLockAll");
    if (lockAllBtn) {
      lockAllBtn.onclick = () => {
        const arr = [];
        curTags.forEach((t) => {
          if (!t || !t.prompt) return;
          if (isLocked(t.prompt)) return;          // 已锁的别重复加
          arr.push({ prompt: t.prompt, name: t.name, slot: t.slot, g: t.g });
        });
        if (!arr.length) { toast("已经全锁了（" + curTags.length + " 个标签）"); return; }
        writeLocked(locked.concat(arr));
        renderResult();
        toast("已锁定 " + curTags.length + " 个标签，下次生成保持不变");
      };
    }
    const unlockAllBtn = wrap.querySelector("#pcGUnlockAll");
    if (unlockAllBtn) {
      unlockAllBtn.onclick = () => {
        if (!locked.length) { toast("当前没有锁定任何标签"); return; }
        const n = locked.length;
        writeLocked([]);
        renderResult();
        toast("已解锁 " + n + " 个标签");
      };
    }

    const pv = wrap.querySelector("#pcGPrev");
    const nx = wrap.querySelector("#pcGNext");
    const hn = wrap.querySelector("#pcGHistN");
    /* 空面板但有历史 ⇒「上一组」可点（跳最新）；「下一组」禁用 */
    if (pv) pv.disabled = !hist.length || histIdx === 0;
    if (nx) nx.disabled = histIdx < 0 || histIdx >= hist.length - 1;
    /* 「第几组 / 共几组」—— 网页 histStat 原样：`(histIdx+1) + " / " + hist.length`，空时「—」
       ⛔ 用户原话「不显示抽取了多少组，网页的都有」：以前只有两个按钮，看不出来走到第几组了。 */
    /* ⛔ 2026-10-20（阿君：刚打开怎么会显示有 3 组生成的标签数量）：
       没翻到任何一组时只显示「—」—— 刚打开面板不该摆出任何"已有 N 组"的数字。 */
    const hb = wrap.querySelector("#pcGHist");
    if (hb) { hb.disabled = !hist.length; hb.style.opacity = hist.length ? "" : ".45"; }
    if (hn) hn.textContent = (hist.length && histIdx >= 0)
      ? (histIdx + 1) + " / " + hist.length : "—";
  }

  /* 系列筛选回显：命中了哪个系列、池里还剩多少角色；没命中要明确告诉用户 */
  function renderSeriesHit() {
    const box = q("#pcGSeriesHit");
    if (!box) return;
    if (!seriesQ) {
      box.className = "pc-whint";
      box.textContent = "";
      return;
    }
    if (!curSeries || !curSeries.matched) {
      box.className = "pc-err";
      box.textContent = "没找到「" + seriesQ + "」→ 已按全部作品抽";
      return;
    }
    box.className = "pc-whint";
    box.textContent = "→ " + (curSeries.series || []).join(" / ")
      + " · " + curSeries.count + " 个角色";
  }

  /* 整组替换 / 从标签侧改内容时置 true ⇒ renderResult 无条件重写文本框。
     ⛔ 必须声明在 renderResult **外面** —— 放在里面每次调用都会重置成 false。
     ⛔ 反向标志 _typing：只有用户在框里敲字那一次才为 true，那时**不许**回写
        （一回写光标就被拽到末尾，阿君报的「光标乱跳」有一部分就是这个）。 */
  let _forceText = false;
  let _typing = false;

  function renderResult() {
    /* ⭐ 2026-10-20（阿君：切工作流再切回，组合结果应该像文本框一样还在）：
       面板空着时，顺手看一眼节点控件里存的「上次显示的这组」。
       ⛔ 不做任何"初始化时机"的假设 —— 载入工作流时同一节点会建两个面板，
         只有真正被渲染的那个才该去做恢复，写成**渲染时懒加载**最稳。
       ⛔ 跨会话不恢复：sid 对不上就不读（armed 是防二次初始化的双保险）。 */
    if (!curTags.length && !String(curPos || "").trim()) {
      try {
        let _st = JSON.parse(String(wval("panel_state", "") || "{}"));
        /* ⭐ 2026-10-21（阿君：Ctrl+F5 后历史全没了）：
           节点控件这条恢复路径**刷新页面走不通** —— 实测刷新后 panel_state
           长度是 0（ComfyUI 按工作流 JSON 重建节点，那个控件没带回来）。
           ⇒ 退回 sessionStorage 里那份镜像（_savePanelState 同步写的）。 */
        if (!(_st && _st.h && _st.h.length)) {
          try { _st = JSON.parse(sessionStorage.getItem(_ssKey()) || "{}"); } catch (e) { _st = null; }
        }
        if (_st && Number(_st.sid) === PC_SID && _st.armed !== false) {
          /* 历史也一起恢复 —— 切回来要"和当时一模一样"，包括能往回翻 */
          if (Array.isArray(_st.h) && _st.h.length && !hist.length) {
            _st.h.forEach((e) => {
              if (!e || !Array.isArray(e.t)) return;
              hist.push({ tags: e.t.map((a) => ({ prompt: a[0] || "", name: a[1] || "",
                                                  slot: a[2] || "", out: a[3] || a[0] || "" })),
                          pos: e.p || "", seed: Number(e.s) || 0, pinned: !!e.pin,
                          params: { preset: e.pr || "" } });
            });
            histIdx = Number.isFinite(Number(_st.i)) ? Math.min(Number(_st.i), hist.length - 1)
                                                     : hist.length - 1;
          }
          const _cur = histIdx >= 0 ? hist[histIdx] : null;
          if (Array.isArray(_st.t) && _st.t.length) {
            curTags = _st.t.map((a) => ({ prompt: a[0] || "", name: a[1] || "",
                                          slot: a[2] || "", out: a[3] || a[0] || "" }));
            curPos = _st.p || buildPosFromTags(curTags);
          } else if (_cur) {
            curTags = _cur.tags.slice();
            curPos = _cur.pos || buildPosFromTags(curTags);
          }
          if (curTags.length) {
            _cacheTags(curTags);
            if (_st.s) setW("seed", _st.s);
            /* ⭐ 2026-11-22：刚把「上次显示的那组」摆回面板，紧接着点运行要出这一组
               （所见即所得）。否则「每次随机」会当着用户的面把它换掉，像恢复失败。
               豁免只吃一次，再点第二次运行才换新的。 */
            try { node._pcKeepSeedOnce = true; } catch (e) {}
          }
        }
      } catch (e) {}
    }
    /* ⭐ 2026-10-08（阿君要的①②）：把当前这组用的 seed 显示出来、点一下复制。
       出图之后想找回「这张图用的是哪组词」就靠它 —— 组合 seed 与 KSampler seed 是两个值，
       这个才是能复现标签的那个。 */
    const _sd = wrap.querySelector("#pcGSeed");
    if (_sd) {
      const _sv = Number(wval("seed", 0)) || 0;
      const _pv = String(wval("preset", "") || "");
      /* 复制出去的是 `386570@极简`（seed + 档位）。
         ⛔ 别再只复制纯数字：阿君「我自己也不记得是什么档位的」——
            纯数字抄进记事本，换台机器/记录被淘汰就永久丢失信息。
            带档位的这串粘回「塞 seed 复现」会自动切回该档位。 */
      const _tokSeed = _pv ? (_sv + "@" + _pv) : String(_sv);
      _sd.textContent = _pinned
        ? ("seed " + _sv + " · 已手改")
        : ("seed " + _sv + (_pv ? " · " + _pv : ""));
      _sd.title = _pinned
        ? "这组手动改过，seed 已不能复现它（节点会原样输出当前文本）。点一下仍可复制 seed。"
        : "这组标签的 seed + 档位：" + _tokSeed
          + "\n点一下复制这整串 —— 抄到记事本、换台电脑，粘回「塞 seed 复现」都能自动切回「"
          + _pv + "」档，不用记";
      _sd.onclick = () => {
        try {
          navigator.clipboard.writeText(_pinned ? String(_sv) : _tokSeed);
          toast(_pinned
            ? ("已复制 seed：" + _sv + "（这组手改过，seed 复现不了）")
            : ("已复制 " + _tokSeed + " —— 这串自带档位，粘回复现框会自动切回「" + _pv + "」"));
        } catch (e) { toast("seed：" + _tokSeed + "（复制失败，手动抄一下）"); }
      };
    }
    /* ⭐ 2026-10-20（阿君：刚打开 ComfyUI 节点要完全干净，seed 也要是没生成过东西的）：
       没生成过任何组合时别显示 seed —— 露出上一个 seed，看着像"这组已经生成过"。 */
    if (_sd && !curTags.length && histIdx < 0 && !String(curPos || "").trim()) {
      _sd.textContent = "—";
      _sd.title = "还没生成过任何组合（seed 在点「组合生成」那一刻才产生）";
      _sd.onclick = null;
    }
    /* 标题栏统计：共 N 个标签 · 锁定 M 个（对齐网页 comboStat） */
    const nLock = curTags.filter((t) => isLocked(t.prompt)).length;
    gCount.className = "pc-wsub";
    gCount.textContent = (curTags.length || 0) + " 个标签"
      + (nLock > 0 ? " · 锁定 " + nLock + " 个" : "");
    /* 只有「用户正在框里敲字」这一次不回写；其余一律回写（_forceText 是显式要求）。 */
    const _ft = _forceText; _forceText = false;
    if (_ft || !_typing) gText.value = curPos;
    _syncDirty = true;
    gTags.replaceChildren();
    renderCnRow();
    if (!curTags.length) {
      /* ⛔ 2026-10-06 对齐网页：还没生成过 → 显示引导语（网页占位符是
         「点击「组合生成」生成提示词」）；已经抽过却空了 = 槽位都被关了。 */
      gTags.appendChild(el("div", "pc-fempty",
        !hist.length ? "点「组合生成」出结果 —— 先在上面选个搭配预设、勾好槽位"
          : (histIdx < 0
              ? "还没生成 —— 点右上「上一组」可以翻回之前生成过的组"
              : "这一组没抽到标签（槽位可能都关着）")));
      renderHist();
      updateFavBtn();
      return;
    }
    /* 2026-10-17：多人时在标签流里插分隔带 —— 第1人 / 第2人 / 公共描述。
       原来两个人的标签混在一堆，看不出谁穿什么。 */
    let _prevWho = "__init__";
    curTags.forEach((t, i) => {
      const _w = (t.who === undefined ? null : t.who);
      if (_w !== _prevWho) {
        _prevWho = _w;
        let _label = null;
        if (_w !== null) {
          const _ch = curTags.filter((x) => x.slot === "角色")[_w];
          _label = "第 " + (_w + 1) + " 人" + (_ch ? " · " + _ch.out : "");
        } else if (i > 0) {
          _label = "公共描述（作品 / 场景 / 光照 / 构图 / 镜头）";
        }
        if (_label) {
          const sep = el("div", "pc-whosep", _label);
          sep.style.cssText = "flex-basis:100%;width:100%;margin:8px 0 2px;padding:2px 8px;"
            + "border-left:3px solid #4a6fa5;background:rgba(74,111,165,.10);"
            + "color:#9fb4d0;font-size:11px;border-radius:3px;box-sizing:border-box";
          gTags.appendChild(sep);
        }
      }
      const lockOn = isLocked(t.prompt);
      const tag = el("span", "pc-wtag" + (lockOn ? " locked" : ""));
      /* 按槽位配色（和网页同一套） */
      const _hue = pcSlotHue(t.slot);
      /* 新 UI：颜色走 CSS 变量 —— 左侧色点 + 边框淡染 + 文字本身上色 */
      tag.style.setProperty("--pc-hue", _hue);
      tag.appendChild(el("span", "e", t.out));
      if (!hideCn && t.name && t.name !== t.prompt) tag.appendChild(el("span", "c", t.name));
      /* 槽位标注（2026-09-29 用户要求：标签要显示来自哪个槽） */
      if (t.slot) {
        const _sb = el("span", "s", t.slot);
        _sb.style.color = "rgba(" + _hue + ",.95)";
        _sb.style.background = "rgba(" + _hue + ",.20)";
        tag.appendChild(_sb);
      }
      /* ⭐ 2026-10-18（阿君：节点点选标签也要像网页那样显示）：
         点一下 = 在结果框里**持续选中**该词（和网页的"选中态"对应），再点一次取消。
         textarea 必须聚焦才会画选区，所以这里顺便聚焦；点 🔒/× 时不触发。 */
      tag.classList.add("cli");
      tag.onclick = (ev) => {
        if (ev.target.closest(".lk") || ev.target.closest(".x") || ev.target.closest(".re")) return;
        /* ⛔ 2026-10-18 修「点了没保持」：悬停的 mouseleave 会用 _hlPrevFocus 把焦点收回去，
           鼠标一离开标签，选中就没了。点击是"用户主动选择"，必须把恢复标记清掉。 */
        _hlPrevFocus = null;
        const already = tag.classList.contains("sel");
        gTags.querySelectorAll(".pc-wtag.sel").forEach((n) => { if (n !== tag) n.classList.remove("sel"); });
        if (already) {
          tag.classList.remove("sel");
          _hlPrevFocus = null;
          try { gText.setSelectionRange(0, 0); } catch (e) {}
          return;
        }
        tag.classList.add("sel");
        try {
          const val = String(gText.value || "");
          const _esc = (x) => String(x).replace(/([()])/g, "\\$1");
          const _sp = String(t.prompt || "").replace(/_/g, " ");
          const _p2 = String(t.prompt || "");
          const cands = [String(t.out || ""), _sp, _p2, _p2.replace(/ /g, "_"), _esc(_sp), _esc(_p2)]
            .map((x) => x.trim()).filter(Boolean);
          let needle = "";
          for (const c of cands) { if (val.indexOf(c) >= 0) { needle = c; break; } }
          if (!needle) return;
          const i = val.indexOf(needle);
          gText.focus({ preventScroll: true });
          gText.setSelectionRange(i, i + needle.length);
          /* 兜底：ComfyUI 画布有时会在事件结束后抢走焦点 ⇒ 选区立刻不可见。
             60ms 后再补一次（只补一次，且只在"仍处于选中态"时补）。 */
          setTimeout(() => {
            try {
              if (!tag.classList.contains("sel")) return;
              if (document.activeElement === gText && gText.selectionEnd > gText.selectionStart) return;
              gText.focus({ preventScroll: true });
              gText.setSelectionRange(i, i + needle.length);
            } catch (e) {}
          }, 60);
          const lh = parseFloat(getComputedStyle(gText).lineHeight) || 18;
          const before = val.slice(0, i).split("\n").length - 1;
          gText.scrollTop = Math.max(0, before * lh - gText.clientHeight / 2);
        } catch (e) {}
      };
      /* 🔒 锁定：下次「组合生成」保留这个词（2026-10-05 对齐网页 .lock-btn）
         ⛔ 必须 stopPropagation：不然会冒泡到标签本体/面板其它点击处理。
         ⚠️ 图标用网页同款 SVG，别用 emoji：🔒 在 10.5px 下糊成一团看不清（实测过）。 */
      const lk = el("span", "lk");
      lk.innerHTML = lockOn ? LOCK_SVG_ON : LOCK_SVG_OFF;
      lk.title = lockOn ? "解锁（恢复随机）" : "锁定（下次生成保持不变）";
      lk.onclick = (ev) => {
        ev.stopPropagation();
        if (lockOn) writeLocked(locked.filter((x) => x.prompt !== t.prompt));
        else writeLocked(locked.concat([{ prompt: t.prompt, name: t.name, slot: t.slot, g: t.g }]));
        renderResult();
      };
      tag.appendChild(lk);
      /* × 从本组删掉（2026-10-05：原来点整个标签就删，误触太多 → 只认这个按钮） */
      const x = el("span", "x", "×");
      x.title = "从本组删掉";
      x.onclick = (ev) => {
        ev.stopPropagation();
        if (t.slot) {
          _vacancies.push({ slot: t.slot, idx: i,
                            who: (t.who === undefined ? null : t.who) });
          if (_vacancies.length > 40) _vacancies.shift();
        }
        /* ⭐ 2026-10-20（阿君：删除角色后对应的作品也要自动删除）：
           作品 / 人物特征是挂在角色身上的，角色没了它们就成了孤儿词。
           ⛔ 组里还有别的角色时不动 —— 否则会把另一个人的作品一起删掉。 */
        if (t.slot === "角色") {
          const others = curTags.filter((x2, j2) => x2.slot === "角色" && j2 !== i);
          if (!others.length) {
            const drop = curTags.filter((x2) => x2.slot === "作品" || x2.slot === "人物特征");
            if (drop.length) {
              drop.forEach((d) => { curPos = removeSeg(curPos, d.out); });
              const nm = new Set(drop.map((x2) => x2.prompt));
              if (locked.some((x2) => nm.has(x2.prompt)))
                writeLocked(locked.filter((x2) => !nm.has(x2.prompt)));
              curTags = curTags.filter((x2) => x2.slot !== "作品" && x2.slot !== "人物特征");
            }
          }
        }
        curTags.splice(i, 1);
        curPos = removeSeg(curPos, t.out);
        if (isLocked(t.prompt)) writeLocked(locked.filter((y) => y.prompt !== t.prompt));
        markEdited();          // 手删了一个词 → seed 复现不出来，钉住整段文本
        _forceText = true;     /* 文本是从标签侧改的 ⇒ 必须回写，别让旧文本留在框里 */
        renderResult();
      };
      /* ⭐ 2026-10-18（阿君：节点悬停没和网页一样高亮）：
         textarea **没有焦点时浏览器根本不画选区**（实测截图全空），所以必须
         「临时聚焦 → 选中该词 → 移开时恢复原焦点」。这样悬停期间是浏览器原生高亮，
         松手后焦点回到原处，不会干扰输入。 */
      let _hlPrevFocus = null;
      tag.addEventListener("mouseenter", () => {
        try {
          if (document.activeElement === gText) return;    // 正在编辑时不抢光标
          const val = String(gText.value || "");
          const _esc = (x) => String(x).replace(/([()])/g, "\\$1");
          const _sp = String(t.prompt || "").replace(/_/g, " ");
          const _p2 = String(t.prompt || "");
          const cands = [String(t.out || ""), _sp, _p2, _p2.replace(/ /g, "_"), _esc(_sp), _esc(_p2)]
            .map((x) => x.trim()).filter(Boolean);
          let needle = "";
          for (const c of cands) { if (val.indexOf(c) >= 0) { needle = c; break; } }
          if (!needle) return;
          const i = val.indexOf(needle);
          if (i < 0) return;
          _hlPrevFocus = document.activeElement;
          gText.focus({ preventScroll: true });
          gText.setSelectionRange(i, i + needle.length);
          /* 把选中的词滚到可视区中间 */
          const lh = parseFloat(getComputedStyle(gText).lineHeight) || 18;
          const before = val.slice(0, i).split("\n").length - 1;
          gText.scrollTop = Math.max(0, before * lh - gText.clientHeight / 2);
        } catch (e) {}
      });
      tag.addEventListener("mouseleave", () => {
        try {
          if (!_hlPrevFocus) return;
          const prev = _hlPrevFocus; _hlPrevFocus = null;
          if (prev && prev !== document.body && typeof prev.focus === "function") prev.focus({ preventScroll: true });
          else gText.blur();
        } catch (e) {}
      });
      tag.appendChild(x);
      /* 🎲 只换这一个槽（2026-10-08 阿君要的③）：
         把**其它槽**现有的词全部当临时锁定传过去 → 后端保留它们、只把这个槽重抽一遍。
         ⛔ 不写进 state.locked，所以不会搅乱用户真正锁定的词，也不会显示成「锁定 N 个」。 */
      const re = el("span", "re", "🎲");
      re.title = t.slot ? ("只换「" + t.slot + "」这个槽，其它保持不动") : "这个词没有槽位信息，换不了";
      re.onclick = async (ev) => {
        ev.stopPropagation();
        if (!t.slot) { toast("这个词没有槽位信息，换不了"); return; }
        /* ⛔ 2026-10-14（对齐网页版）：「作品」「人物特征」是角色的附属槽 ——
           换角色时必须跟着一起换，不能当"其它槽"保留，否则旧角色的作品词/特征词残留
           （实测两个作品词同框：hololive + suigetsu；网页版同款问题已修）。 */
        const dropSlots = (t.slot === "角色") ? ["作品", "人物特征"] : [];
        const keep = curTags.filter((y) => y.slot !== t.slot && dropSlots.indexOf(y.slot) < 0)
          .map((y) => ({ prompt: y.prompt, name: y.name, slot: y.slot, g: y.g }));
        /* ⛔ 2026-10-17 修：必须先换 seed 再 roll，否则同一个 seed + 同一组锁定
           = 完全相同的随机序列 → 目标槽重抽出来的还是原来那个词（阿君：景别是全景时点骰子没反应）。 */
        rollSeed();
        toast("只换「" + t.slot + "」…");
        try { await roll(keep); } catch (e) {}
        /* ⭐ 2026-11-22：刚挑好的这个词也算「用户选定的」，下一次运行原样用它 ——
           否则「每次随机」会把整个换掉，跟「组合生成」同一个坑。 */
        try { node._pcKeepSeedOnce = true; } catch (e) {}
      };
      tag.appendChild(re);
      tag.title = (t.slot ? "[" + t.slot + "] " : "") + t.prompt
        + "　（右键可剔除 / 移到别的槽 / 全局剔除）";
      tag.oncontextmenu = (ev) => { ev.preventDefault(); showWordMenu(ev.clientX, ev.clientY, t.prompt, t.slot); };
      /* ⛔ 不要再给 tag 挂 onclick 删除 —— 用户原话：「点了一下就自动从结果里去除了」 */
      gTags.appendChild(tag);
    });
    renderHist();
    updateFavBtn();       // ★/☆ 状态跟着当前这组走（已在收藏夹里就显示「★ 已收藏」）
    _savePanelState();    // ← 写进节点控件，切工作流才不丢（只影响显示）
  }

  /* ---- 中文对照行（2026-10-05，对齐网页 renderCombo 里的 cnRow / cnInline）----
     把这一组标签串成一句中文，显示在标签下方；「隐藏中文」按钮可收起。
     ⛔ 只在组合变化时重算（sig 缓存），否则每渲染一次都要跑一遍分组。 */
  let _cnSig = "", _cnText = "";
  function renderCnRow() {
    const row = wrap.querySelector("#pcGCnRow");
    const box = wrap.querySelector("#pcGCnBox");
    if (!row || !box) return;
    if (hideCn || !curTags.length) {
      _cnSig = ""; _cnText = "";
      box.textContent = "";
      row.style.display = "none";
      return;
    }
    const sig = curTags.map((t) => (t.slot || "") + "|" + t.prompt).join("")
      + "#" + locked.length;
    if (sig !== _cnSig) {
      /* 与「组合结果」一致：一段一行；**不补空的场景/光照**（否则每行尾巴都挂「置身简洁背景」） */
      const gs = splitByWhoT(curTags);
      _cnText = gs.length > 1
        ? gs.map((g) => expandCn(g, { noFill: true })).join("\n")
        : expandCn(curTags);
      _cnSig = sig;
    }
    box.textContent = _cnText;
    row.style.display = "";
  }

  /* ===== 中文对照生成：照抄网页 expandPrompt() 的中文分支（4964-5103 行）=====
     ⛔ 只做中文 —— 网页 cnRow 显示的就是 cn 那一支，英文由节点自己输出。
     ⛔ 网页那边改了槽位分组/句式模板，这里要同步改。
     ⛔ 节点的 curTags 里没有「固定画质」槽（画质词是后端单独拼的），所以没有 quality 段。 */
  const COUNT_CN = { "1girl": "一名少女", solo: "一个孤独的身影", "2girls": "两名少女",
    "3girls": "三名少女", "4girls": "四名少女", "5girls": "五名少女", "6+girls": "一群少女",
    "multiple_girls": "多名少女", "1boy": "一名少年", "2boys": "两名少年",
    "3boys": "三名少年", "4boys": "四名少年", "5boys": "五名少年", "6+boys": "一群少年",
    "multiple_boys": "多名少年", "1other": "一个身影", "2others": "两个身影",
    "3others": "三个身影", "4others": "四个身影", "5others": "五个身影",
    "6+others": "一群身影", "multiple_others": "多个身影" };
  const expReadable = (p) => String(p == null ? "" : p)
    .replace(/\(.*?\)/g, "").replace(/_/g, " ").replace(/\s+/g, " ").trim();
  /* 2026-10-18（阿君：中文对照没按角色分开）：按 who 把组合切段。 */
  function splitByWhoT(list) {
    const out = []; let cur = [], key = "__i";
    (list || []).forEach((c) => {
      const k = (c.who === undefined ? null : c.who);
      if (k !== key) { if (cur.length) out.push(cur); cur = []; key = k; }
      cur.push(c);
    });
    if (cur.length) out.push(cur);
    return out;
  }

  function expandCn(combo, _opt) {
    const _noFill = !!(_opt && _opt.noFill);
    const bySlot = {};
    (combo || []).forEach((it) => { const k = it.slot || ""; (bySlot[k] = bySlot[k] || []).push(it); });
    const g = (s) => bySlot[s] || [];
    const nm = (c) => c.name || expReadable(c.prompt);
    const cnHead = [];
    const artists = g("画师"), styles = g("风格");
    if (artists.length) cnHead.push("由" + artists.map(nm).join("、") + "绘制");
    if (styles.length) cnHead.push(styles.map((s) => {
      const n = nm(s);
      return /风格$/.test(n) ? n : n + "风格";
    }).join("、"));
    const counts = g("人数"), chars = g("角色");
    const cnCount = counts.length ? (COUNT_CN[counts[0].prompt] || nm(counts[0])) : "";
    const cnChar = chars.map(nm).join("、");
    const cnSubject = cnChar || cnCount || "一个身影";
    const cnHair = [];
    g("发色").forEach((c) => cnHair.push(nm(c)));
    g("发型").forEach((c) => cnHair.push(nm(c)));
    const cnEyes = g("眼睛").map(nm);
    const cnFeats = g("人物特征").map(nm);
    const cnApp = (cnHair.length || cnEyes.length || cnFeats.length)
      ? "，" + cnHair.concat(cnEyes, cnFeats).join("、") : "";
    const cnActs = [];
    ["基础姿势", "动作", "手臂与手势", "身体与头部协调", "双人互动",
      "人物朝向", "视线与朝向"].forEach((k) => g(k).forEach((c) => cnActs.push(nm(c))));
    const cnAct = cnActs.length ? "，" + cnActs.join("、") : "";
    const cnEmo = g("表情").map(nm).join("、");
    const cnEmoPhrase = cnEmo ? "，" + cnEmo + "的表情" : "";
    const cnWear = [];
    ["上装", "下装", "连衣裙与制服", "泳装与贴身衣物", "袖型与领口", "装饰与材质",
      "腿部服饰"].forEach((k) => g(k).forEach((c) => cnWear.push(nm(c))));
    g("鞋子").concat(g("袜子")).forEach((c) => cnWear.push(nm(c)));
    const cnWearPhrase = cnWear.length ? "，身着" + cnWear.join("、") : "";
    const cnAcc = [];
    g("首饰").forEach((c) => cnAcc.push(nm(c)));
    g("头饰配件").forEach((c) => cnAcc.push(nm(c)));
    const cnAccPhrase = cnAcc.length ? "，佩戴" + cnAcc.join("、") : "";
    const cnScene = g("场景").map(nm).join("、");
    const cnEnv = [];
    ["载具", "动物", "植物", "道具"].forEach((k) => g(k).forEach((c) => cnEnv.push(nm(c))));
    const cnEnvPhrase = cnEnv.length ? "，画面中有" + cnEnv.join("、") : "";
    let cnScenePhrase = (cnScene ? "，置身" + cnScene : "") + cnEnvPhrase;
    const cnLight = g("光照").map(nm).join("、");
    let cnLightPhrase = cnLight ? "，" + cnLight + "光线" : "";
    if (!_noFill && !cnScenePhrase) cnScenePhrase = "，置身简洁背景";
    if (!_noFill && !cnLightPhrase) cnLightPhrase = "，柔和光线";
    const cnCam = [];
    ["景别", "相机方位", "构图", "镜头", "景深", "运镜", "动态效果"]
      .forEach((k) => g(k).forEach((c) => cnCam.push(nm(c))));
    const cnCamPhrase = cnCam.length ? "，" + cnCam.join("、") : "";
    let out = (cnHead.length ? cnHead.join("，") + "：" : "")
      + cnSubject + cnApp + cnAct + cnEmoPhrase + cnWearPhrase + cnAccPhrase
      + cnScenePhrase + cnLightPhrase + cnCamPhrase + "。";
    /* 清理占位符衔接产生的重复标点（照网页 5102 行） */
    out = out.replace(/：[，、]+/g, "：").replace(/[，、]{2,}/g, "，").replace(/^[，、]+/, "");
    return out;
  }

  /* 各槽词数（/pc/pools），用于槽位格子上显示「N个」 */
  let slotPools = {};
  const folded = {};                     // 分组折叠状态

  /* 重拉各槽词数并重画组合页（槽位格子上的「N个」要跟着增删变） */
  async function refreshSlotPools() {
    try {
      slotPools = await api("/pools?gender="
        + encodeURIComponent(wval("gender", "只看女性"))
        + "&nsfw=" + (wval("nsfw_filter", true) ? 1 : 0) + "&nsfwOnly=" + (wval("nsfw_only", false) ? 1 : 0)) || {};
    } catch (e) {}
    renderGen();
  }

  /* 把档位的「槽表」统一成 {on:[...], counts:{...}}。
     ⛔ overrides 历史上有两种形状：老数据是字符串数组 ["人数","服装"]，
        v1.3.5 起存 {"人数":1,"服装":3} —— 这样「覆盖」不再把「首饰 3 个」这种配置丢掉。
        两种都要能读，**不能只认新的**（用户盘里已经有老数组了）。 */
  function presetTable(raw) {
    if (Array.isArray(raw)) return { on: raw.slice(), counts: {} };
    if (raw && typeof raw === "object") {
      const on = [], counts = {};
      Object.keys(raw).forEach((k) => {
        const n = slotCountOf(raw[k]);
        if (n > 0) { on.push(k); if (n > 1) counts[k] = n; }
      });
      return { on: on, counts: counts };
    }
    return null;
  }

  /* ⭐ 2026-10-19（阿君：「节点端的搭配预设档位右键没功能，网页端的右键有功能」）
     ===== 搭配预设 chip：左键应用 + 右键四项（对齐网页 renderPresetChips）=====
     网页端右键菜单（`词库随机组合工具.html` renderPresetChips 里那段）：
       ✏ 重命名 / 💾 用当前槽位覆盖此档位 / ➕ 存为副本 / 🗑 删除档位
     节点端原来**只有左键**，右键弹的是浏览器默认菜单 ⇒ 看着就是"没功能"。

     ⛔ 同时修掉一个连带 bug：原来这行**只渲染 meta.presets 原始名字**，
        pe.renamed / pe.removed / pe.overrides 三张表只有「⚙ 槽位管理」弹窗里认。
        ⇒ 在弹窗里改名/删除/覆盖了档位，主界面这行纹丝不动（改名还显示旧名、删了还在）。
        现在两边共用同一套表。 */
  function renderPresetChips() {
    gPresets.replaceChildren();
    const pe = (_userEdits && _userEdits.presetEdits) || {};
    const ovr = pe.overrides || {};
    const ren = pe.renamed || {};
    const rm = pe.removed || [];
    const all = [];
    ((meta && meta.presets) || []).forEach((pp, i) => {
      const key = "__bi" + i;
      if (rm.indexOf(key) >= 0) return;
      const ov = presetTable(ovr[key]);
      all.push({
        key: key, name: ren[key] || pp.name,
        on: ov ? ov.on : (pp.on || []),
        /* 被「覆盖」过的以 ovr 的槽表为准（新数据里带 counts，老数组数据数量按 1） */
        counts: ov ? ov.counts : (pp.counts || {}),
        builtin: true, hasOvr: !!ov, freeAll: !!pp.freeAll, presetName: pp.name,
      });
    });
    ((pe && pe.custom) || []).forEach((pp) => {
      if (!pp || !pp.name) return;
      const ov = presetTable(ovr[pp._key]);
      all.push({
        key: pp._key, name: ren[pp._key] || pp.name,
        on: ov ? ov.on : (pp.on || []),
        counts: ov ? ov.counts : (pp.counts || {}),
        builtin: false, hasOvr: !!ov, freeAll: false, presetName: null,
      });
    });

    /* 当前显式槽位表（slots_json）；空 = 走预设。
       ⛔ 只算一次：点完档位会 renderGen()，此刻读到的就是最新的。
       注意「槽位表非空」意味着**显式表压过 preset 参数**（后端同语义），
       所以这时候内置档不能只凭同名就亮 —— 否则点自建档会「两个一起亮」
       （阿君截图里的现象：A 亮了，极简还亮着）。 */
    const cur = (() => {
      let o = {};
      try { o = JSON.parse(wval("slots_json", "") || "{}") || {}; } catch (e) { o = {}; }
      const r = {};
      Object.keys(o).forEach((k) => { const n = slotCountOf(o[k]); if (n > 0) r[k] = n; });
      return r;
    })();
    const hasExplicit = Object.keys(cur).length > 0;
    const activeName = canonPreset(wval("preset", ""));
    const sameTable = (pp) => {
      const b = {};
      (pp.on || []).forEach((k) => { b[k] = (pp.counts && pp.counts[k]) || 1; });
      const ka = Object.keys(cur).sort(), kb = Object.keys(b).sort();
      if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
      return ka.every((k) => cur[k] === b[k]);
    };

    all.forEach((pp) => {
      /* 高亮：内置档且没被覆盖过、且当前没显式槽表 → 按 preset 名比（原逻辑）；
         否则（自建 / 被覆盖 / 有显式表）→ 比槽位表。 */
      const lit = (pp.builtin && !pp.hasOvr && !hasExplicit)
        ? (pp.presetName === activeName) : sameTable(pp);
      const c = el("span", "pc-wchip" + (lit ? " on" : ""), pp.name);
      c.title = (pp.freeAll ? "空白起步（所有槽默认关闭）" : "开启 " + (pp.on || []).length + " 个槽位")
        + "\n左键应用 · 右键可改名 / 覆盖 / 存为副本 / 删除";
      /* ⛔ 2026-10-06 阿君报：「点搭配预设的档位切换过去后都会自动给我抽取，网页的不会」。
         对照网页实测：切档位**只换槽位组合，不抽词**，结果区纹丝不动，
         要出结果必须自己点「组合生成」。这里照抄网页 applyPreset 的收尾。 */
      c.onclick = () => {
        if (pp.builtin && !pp.hasOvr) {
          /* 内置档没被覆盖 → 直接切 preset（保留原语义），并清掉显式槽表 */
          setW("preset", pp.presetName);
          writeSlots({});
        } else {
          const o = {};
          (pp.on || []).forEach((k) => { o[k] = (pp.counts && pp.counts[k]) || 1; });
          writeSlots(o);
        }
        renderGen();
        toast(pp.freeAll
          ? "已切到「" + pp.name + "」：所有槽位已关闭（点「组合生成」生效）"
          : ("已应用搭配预设：" + pp.name + "（点「组合生成」生效）"));
      };
      /* 右键：四项，和网页端一模一样 */
      c.oncontextmenu = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        popMenu(ev.clientX, ev.clientY, [
          { icon: "✏", label: "重命名「" + pp.name + "」…", fn: () => presetRename(pp) },
          { icon: "💾", label: "用当前槽位覆盖此档位", fn: () => presetOverride(pp) },
          { icon: "➕", label: "存为副本…", fn: () => presetDup(pp) },
          { icon: "🗑", label: "删除档位「" + pp.name + "」", danger: true, fn: () => presetDelete(pp) },
        ]);
      };
      gPresets.appendChild(c);
    });
  }

  /* 档位改动的统一收尾：存盘 → 重拉 → 重画（主界面 + 槽位管理弹窗都刷） */
  async function presetSaved(msg) {
    const okk = await saveUserEdits();
    if (!okk) { toast("保存失败（ComfyUI 后端没响应？）", true); return false; }
    await loadUserEdits(true);
    renderGen();
    try { if (_smRedraw) _smRedraw(); } catch (e) {}
    if (msg) toast(msg);
    return true;
  }
  const presetPE = () => {
    const ed = (_userEdits = _userEdits || {});
    ed.presetEdits = ed.presetEdits || {};
    ed.presetEdits.renamed = ed.presetEdits.renamed || {};
    ed.presetEdits.custom = ed.presetEdits.custom || [];
    ed.presetEdits.removed = ed.presetEdits.removed || [];
    ed.presetEdits.overrides = ed.presetEdits.overrides || {};
    return ed.presetEdits;
  };
  function presetRename(pp) {
    const v = prompt("把档位「" + pp.name + "」改名为：", pp.name);
    if (v === null) return;
    /* ⛔ 内置档改名只是**显示层**（节点里的 preset 参数仍存后端认的原名），
       所以这里绝不去改 wval("preset") —— 改了后端就认不出这个档位了。 */
    const pe2 = presetPE();
    const nv = String(v).trim();
    if (!nv) delete pe2.renamed[pp.key]; else pe2.renamed[pp.key] = nv;
    presetSaved(nv ? ("档位已改名为「" + nv + "」") : "已恢复档位原名");
  }
  function presetOverride(pp) {
    const cur = currentOn();
    const on = Object.keys(cur).filter((k) => slotCountOf(cur[k]) > 0);
    if (!on.length) { toast("当前一个槽位都没开，没东西可覆盖", true); return; }
    if (!confirm("用当前开启的槽位覆盖「" + pp.name + "」？\n\n（现在是 " + (pp.on || []).length
      + " 个槽 → 将变成 " + on.length + " 个槽）")) return;
    /* ⛔ 存**带数量的对象**，别存槽名数组 —— 数组会把「首饰 3 个」这类配置丢掉，
        覆盖完再点这个档位就只剩 1 个（v1.3.5 修；读的时候 presetTable 两种都认）。 */
    const tbl = {};
    on.forEach((k) => { tbl[k] = slotCountOf(cur[k]) || 1; });
    presetPE().overrides[pp.key] = tbl;
    presetSaved("已用当前槽位更新「" + pp.name + "」");
  }
  async function presetDup(pp) {
    const v = prompt("把「" + pp.name + "」存为一个新档位，名字是：", pp.name + " 副本");
    if (v === null) return;
    const nv = String(v).trim();
    if (!nv) { toast("档位名不能为空", true); return; }
    /* 直接按这个档位的槽表建一个自建档（不是按当前面板）—— 这才叫"副本" */
    const pe2 = presetPE();
    if (pe2.custom.some((x) => (pe2.renamed[x._key] || x.name) === nv)) {
      toast("已经有叫「" + nv + "」的档位了", true);
      return;
    }
    const counts = {};
    (pp.on || []).forEach((k) => {
      const n = (pp.counts && pp.counts[k]) || 1;
      if (n > 1) counts[k] = n;
    });
    pe2.custom.push({ _key: "__cu" + Date.now(), name: nv, on: (pp.on || []).slice(),
                      counts: counts, at: Date.now() });
    presetSaved("已存为副本「" + nv + "」（" + (pp.on || []).length + " 个槽）");
  }
  function presetDelete(pp) {
    const n = (pp.on || []).length;
    if (!confirm("删除档位「" + pp.name + "」？\n\n· 这是一个槽位组合模板（" + (n ? n + " 个槽位" : "空白起步") + "）\n"
      + "· 不影响任何槽位和标签\n"
      + (pp.builtin ? "· 内置档删掉后可以在「⚙ 槽位管理 → 还原全部改动」里找回" : "· 自建档删掉就没了，要留就先「存为副本」"))) return;
    const pe2 = presetPE();
    if (pp.builtin) {
      if (pe2.removed.indexOf(pp.key) < 0) pe2.removed.push(pp.key);
      /* 正在用这个内置档 → preset 参数会指向一个已删档位，清空退回默认 */
      if (canonPreset(wval("preset", "")) === pp.presetName) setW("preset", "");
    } else {
      pe2.custom = pe2.custom.filter((x) => x._key !== pp.key);
    }
    presetSaved("已删除档位「" + pp.name + "」");
  }

  /* ---- 组合页渲染：照网页版的单列布局 ---- */
  function renderGen() {
    if (!meta) return;
    renderPresetChips();
    /* 性别 chips */
    Array.from(wrap.querySelectorAll("#pcGGender .pc-wchip")).forEach((c) => {
      c.classList.toggle("on", c.dataset.v === wval("gender", "只看女性"));
      /* ⛔ 2026-10-06 同批对齐网页 genderChips：切性别**不抽词**（网页实测结果区不动），
         但槽池大小随性别变，所以要顺手刷新各槽词数。网页同款：点当前项直接返回。 */
      c.onclick = () => {
        if (c.dataset.v === wval("gender", "只看女性")) return;
        setW("gender", c.dataset.v);
        /* 2026-10-19：写回节点后读一次，确认真的写进去了。
           之前出现过「chip 亮着但节点值是旧的」⇒ 后端按女性抽了一堆人类。 */
        if (wval("gender", "") !== c.dataset.v) {
          toast("性别没写进节点（读到的是「" + wval("gender", "?") + "」）—— 请刷新页面再试");
        }
        renderGen();
        refreshSlotPools();
        toast("性别筛选：" + c.dataset.v + "（角色槽按热度加权随机）");
      };
    });
    /* 顶部开关 chips */
    const _ar = wrap.querySelector("#pcGAutoRand");
    if (_ar) _ar.classList.toggle("on", autoRandOn());
    wrap.querySelector("#pcGQuality").classList.toggle("on", !!wval("add_quality", true));
    wrap.querySelector("#pcGSpace").classList.toggle("on", !!wval("space_out", true));
    wrap.querySelector("#pcGNsfw").classList.toggle("on", !!wval("nsfw_filter", true));
    try { wrap.querySelector("#pcGNsfwOnly").classList.toggle("on", !!wval("nsfw_only", false)); } catch(e) {}
    wrap.querySelector("#pcGBoost").classList.toggle("on", !!wval("auto_boost", true));
    wrap.querySelector("#pcGAnima").classList.toggle("on", !!wval("anima_mode", false));
    const _cx = wrap.querySelector("#pcGCross");
    if (_cx) {
      const _cross = !!wval("cross_series", false);
      _cx.classList.toggle("on", !_cross);              // 亮 = 同作品（默认）
      _cx.textContent = _cross ? "跨作品" : "同作品";    // 文字直接显示当前模式
    }
    /* 2026-10-17：老工作流存的是旧档名 → 直接改写成现名。
       不改写的话「档位 chip 一个都不亮」（chip 用 p.name === wval("preset") 判断），
       用户会以为档位丢了。改写后保存工作流也会存成新名。 */
    try {
      const _pn = wval("preset", "");
      if (canonPreset(_pn) !== _pn) setW("preset", canonPreset(_pn));
    } catch (e) {}
    /* 穿搭 chip 的文字跟着"当前槽位状态"走（手动开关槽位后也能对上）。
       ⚠️ 用 try/catch 而不是 typeof —— OUTFIT/inferOutfit 是 const，TDZ 期间 typeof 也会抛。 */
    try {
      outfitIdx = inferOutfit();
      const oe = wrap.querySelector("#pcGOutfit");
      if (oe) oe.textContent = OUTFIT[outfitIdx].label;
    } catch (e) {}
    /* 统计（curRaw 是原始槽位表，含数量；on 只看开没开） */
    const curRaw = currentOn();
    const on = {};
    Object.keys(curRaw).forEach((k) => { on[k] = slotCountOf(curRaw[k]) > 0; });
    const nOn = meta.slotOrder.filter((s) => on[s]).length;
    wrap.querySelector("#pcGSlotStat").textContent = nOn + " / " + meta.slotOrder.length + " 槽已开";
    wrap.querySelector("#pcGSlotN").textContent = String(meta.slotOrder.length);
    /* 槽位分组（每槽一格，绿色 = 已开）
       ⚠️ 2026-09-29：要认用户的「删除槽位」和「改名」——
          之前 renderGen 直接读 meta.slotGroups/原槽名，所以点了删除界面没反应、改名也不显示。 */
    gGroups.replaceChildren();
    const _se = (_userEdits && _userEdits.slotEdits) || {};
    const _delSet = new Set((_se.deleted || []).map((d) => d.name || d));
    const _renMap = _se.renamed || {};
    meta.slotGroups.forEach((g) => {
      const valid = g.slots.filter((s) => meta.slotOrder.includes(s) && !_delSet.has(s));
      if (!valid.length) return;
      const box = el("div", "pc-wgroup" + (folded[g.name] ? " pc-folded" : ""));
      const head = el("div", "pc-wgrouphead");
      head.appendChild(el("span", "pc-wgname", g.name));
      head.appendChild(el("span", "pc-wgcnt", valid.filter((s) => on[s]).length + "/" + valid.length + " 槽"));
      head.title = "点一下折叠/展开这组";
      head.onclick = () => { folded[g.name] = !folded[g.name]; renderGen(); };
      box.appendChild(head);
      const slots = el("div", "pc-wslots");
      valid.forEach((s) => {
        /* 「人数」没开时会被自动补（1girl / 2girls），这里按实际用到的词数显示「自动N」，
           让槽位状态和结果对得上（2026-10-18 阿君反馈） */
        const _autoN = (s === "人数" && !on[s])
          ? (curTags || []).filter((t) => t.slot === "人数").length : 0;
        const cell = el("div", "pc-wslot" + ((on[s] || _autoN) ? " on" : ""));
        cell.appendChild(el("span", "d"));
        const nmEl2 = el("span", "n", _renMap[s] || s);
        if (_renMap[s]) nmEl2.title = "原名：" + s + "（已改名）";
        cell.appendChild(nmEl2);
        const n = slotPools[s];
        if (n != null)         cell.appendChild(el("span", "c", n + "个"));
        if (_autoN) {
          const _ab = el("span", "c", "自动" + _autoN);
          _ab.title = "这个槽没开，但工具按人数自动补了词";
          _ab.style.color = "#5ee0d6";
          cell.appendChild(_ab);
        }
        /* − N ＋ 数量控制（2026-09-29 移植网页 slotCounts；上限 6，发色 1）
           · 0 = 关（数字位置显示「关」）
           · 悬停槽位格才显示，避免太挤 */
        const cnt = slotCountOf(curRaw[s]);
        const stp = el("span", "pc-wslot-step" + (cnt > 0 ? " on" : ""));
        const mi = el("span", "mi", "−");
        const num = el("span", "num", cnt > 0 ? String(cnt) : "关");
        const pl = el("span", "pl", "＋");
        mi.title = "少抽一个（到 0 就是关掉这个槽）";
        pl.title = "多抽一个（上限 6；发色固定 1）";
        /* ⛔ 2026-10-06 对齐网页：改槽位数量属于「改配置」→ 只重画、不重抽 */
        const setCnt = (v) => {
          const c = currentOn();
          const nv = Math.max(0, Math.min(6, v));
          if (nv <= 0) delete c[s];
          else c[s] = nv;
          writeSlots(c);
          renderGen();
          toast(nv <= 0 ? ("已关掉「" + s + "」") : ("「" + s + "」每次抽 " + nv + " 个（点「组合生成」生效）"));
        };
        mi.onclick = (ev) => { ev.stopPropagation(); setCnt(slotCountOf(curRaw[s]) - 1); };
        pl.onclick = (ev) => { ev.stopPropagation(); setCnt(slotCountOf(curRaw[s]) + 1); };
        stp.append(mi, num, pl);
        cell.appendChild(stp);
        /* ⚙ 槽位菜单（对齐网页：重命名 / 预览 / 还原该槽改动 / 删除槽位） */
        const gear = el("span", "pc-wslot-gear", "⚙");
        gear.title = "槽位菜单";
        gear.onclick = (ev) => {
          ev.stopPropagation();
          const r = gear.getBoundingClientRect();
          if (!_userEdits) loadUserEdits(true).then(() => showSlotMenu(r.left, r.bottom + 2, s));
          else showSlotMenu(r.left, r.bottom + 2, s);
        };
        cell.appendChild(gear);
        /* 👁 预览：点开看这个槽里有哪些标签（网页版点槽位名就能看，节点之前缺这个） */
        const eye = el("span", "pc-wslot-eye", "👁");
        eye.title = "看「" + s + "」里有哪些标签";
        eye.onclick = (ev) => { ev.stopPropagation(); openSlotPeek(s); };
        cell.appendChild(eye);
        cell.title = "点击开/关「" + s + "」；点 👁 看里面的标签";
        cell.onclick = (ev) => {
          ev.stopPropagation();
          const c = currentOn();
          if (slotCountOf(c[s]) > 0) delete c[s];     // 开着 → 关（连数量一起清）
          else c[s] = 1;                              // 关着 → 开，默认抽 1 个
          writeSlots(c);
          renderGen();
        };
        slots.appendChild(cell);
      });
      box.appendChild(slots);
      gGroups.appendChild(box);
    });
  }

  /* ---- 槽位预览：固定定位模态框（点槽位格上的 👁 打开）----
     ⚠️ 2026-09-29 改版：原来把弹层插在面板体内，会挤占布局、把「槽位池/词库浏览/档位」
        那几个标签页挡住（用户报「返回不了其他界面」）。
        现在改成挂 document.body 的 position:fixed 模态框 + 遮罩 + 关闭按钮，
        对齐网页版 #slotPickModal 的做法。
     数据源：/pc/slotpool（分页+搜索）、/pc/series（系列名，本地过滤）。 */
  let peek = null;
  let seriesCnMap = null;      // en → cn（系列中文名），懒加载缓存

  async function ensureSeriesCn() {
    if (seriesCnMap) return seriesCnMap;
    seriesCnMap = {};
    try {
      const d = await api("/series");
      (d.series || []).forEach((x) => { seriesCnMap[x.en] = x.cn || x.en; });
    } catch (e) {}
    return seriesCnMap;
  }
  const peekMask = el("div", "pc-peekmask");
  peekMask.style.display = "none";
  document.body.appendChild(peekMask);

  function closePeek() {
    peek = null;
    peekMask.style.display = "none";
    peekMask.replaceChildren();
  }
  function openSlotPeek(slot) {
    peek = { slot: slot, page: 1, size: 200, q: "", series: "", total: 0, shown: 200, words: [] };
    peekMask.style.display = "flex";
    renderPeek();
  }

  /* 槽位池里做完增删（剔除 / 添加 / 移动 / 全局剔除）后，**正在看的 peek 必须重拉重画**。
     ⛔ 2026-09-29 修：原来这里只调 `poolTab.refresh()`，而 poolTab 早就废弃了
        （「槽位池」标签页已删，变量永远是 null）⇒ 剔除完词还挂在列表里，
        用户以为没生效（原话：「从槽位剔除了标签怎么没同步消失掉，网页都是同步消失」）。
     ✅ 网页版就是这样：改完立刻重渲染。 */
  let _slotSig = "";      // 槽位表结构的指纹（custom/deleted/renamed）
  function refreshAfterSlotEdit() {
    try {
      if (peek) loadPeekWords().then(() => renderPeek()).catch(() => {});
      refreshSlotPools().catch(() => {});     // 组合页槽位格子的「N个」
      /* ⛔ 2026-10-06（阿君报「新建的槽位不显示在面板上」）：
         槽位表的**结构**变了（新建/删除/改名）必须重拉 meta 再重画 ——
         面板槽位区渲染的就是 meta.slotGroups。只剔词/加词不算结构变化，那种情况不必重拉。
         ⚠️ 后端 /pc/meta 会按最新 user_edits 重算 slotOrder/slotGroups，所以这里重拉就够。 */
      const se = (_userEdits && _userEdits.slotEdits) || {};
      const sig = JSON.stringify([se.custom || [], se.deleted || [], se.renamed || {}]);
      if (sig !== _slotSig) {
        _slotSig = sig;
        reloadMeta()
          .then((m) => {
            meta = m;
            renderGen();
            /* ⭐ 槽位管理弹窗如果开着，也得用**新 meta** 再画一次 —— 它的「删除槽位」下拉列的是
               meta.slotOrder，不重画就永远少一个新槽（2026-10-06 阿君报的那个）。 */
            if (_smRedraw) _smRedraw();
          })
          .catch((e) => console.error("[prompt-combiner] 重拉 meta 失败", e));
      }
    } catch (e) {
      console.error("[prompt-combiner] 槽位改动后刷新失败", e);
    }
  }

  async function loadPeekWords() {
    const st = peek;
    /* ⚠️ 选了系列就让**后端**搜 "(系列名)" —— 本地过滤只能在前 2000 个词里找，
       角色槽有两万多词，会漏掉绝大部分。 */
    const qq = st.series ? ("(" + st.series + ")") : st.q;
    const u = new URLSearchParams({ slot: st.slot, page: 1, size: 3000, q: qq });
    const d = await api("/slotpool?" + u.toString());
    st.total = d.total;
    st.words = d.words || [];
  }

  async function renderPeek() {
    if (!peek) return;
    const st = peek;
    const pWin = el("div", "pc-peekwin");
    peekMask.replaceChildren(pWin);

    /* 标题行：槽名 + 总数 + 搜索 + 关闭 */
    const head = el("div", "pc-peekhead");
    head.appendChild(el("span", "pc-wtitle", st.slot));
    head.appendChild(el("span", "pc-wsub", st.total + " 个标签"));
    const inp = el("input", "pc-winput pc-peeksearch");
    inp.placeholder = "搜索该槽位标签（中文或英文）…";
    inp.value = st.q;
    inp.onkeydown = async (e) => {
      if (e.key !== "Enter") return;
      st.q = inp.value.trim(); st.shown = 200;
      try { await loadPeekWords(); } catch (er) { alerted(er); }
      renderPeek();
    };
    head.appendChild(inp);
    const bClose = el("button", "pc-wbtn", "关闭");
    bClose.onclick = closePeek;
    head.appendChild(bClose);
    pWin.appendChild(head);

    /* 系列筛选区 —— **只给「角色」槽**。
       ⛔ 2026-09-29 修：原来写成「其它槽也显示，不影响」，用户直接指出来了
          （点「眼睛」「头饰配件」的池子也挂着一条「按系列筛选」的框，看着莫名其妙）。
          `Pool.series_allow()` 只作用于「角色」槽，对别的槽本来就没用，所以直接不渲染。 */
    if (st.slot === "角色") {
      const sbar = el("div", "pc-peekseries");
      const sinp = el("input", "pc-winput");
      sinp.placeholder = "按系列筛选，如：原神 / genshin / 赛马娘 / hololive…（留空=全部）";
      sinp.value = st.series;
      sinp.onkeydown = async (e) => {
        if (e.key !== "Enter") return;
        st.series = sinp.value.trim(); st.shown = 200;
        try { await loadPeekWords(); } catch (er) { alerted(er); }
        renderPeek();
      };
      sbar.appendChild(sinp);
      const bClear = el("button", "pc-wbtn sm", "清空");
      bClear.onclick = () => { st.series = ""; st.shown = 200; renderPeek(); };
      sbar.appendChild(bClear);
      pWin.appendChild(sbar);
    } else {
      st.series = "";        // 非角色槽不该带系列筛选，清掉免得状态残留
    }

    /* 系列 chips（只给「角色」槽）
       ⚠️ 用 /pc/series 的**全局**系列数据（en + cn + 角色数），不要用本地 st.words 统计 ——
          后者只有前 2000 个词，数量会不对。
       格式对齐网页：`中文 (英文) 数量`，例如 `碧蓝航线 (azur_lane) 1793`。 */
    if (st.slot === "角色") {
      let arr = [];
      try { const d = await api("/series"); arr = d.series || []; } catch (e) {}
      const cnMap = {};
      arr.forEach((x) => { cnMap[x.en] = x.cn || x.en; });
      st._cnMap = cnMap;
      if (arr.length) {
        const chips = el("div", "pc-peekchips");
        /* 和网页版一样显示前 20 个（原来只给 16 个，用户报"怎么才那么一点"） */
        arr.slice(0, 20).forEach((x) => {
          const cn = x.cn && x.cn !== x.en ? x.cn + " (" + x.en + ") " + x.n : x.en + " (" + x.n + ")";
          const c = el("span", "pc-schip" + (st.series === x.en ? " on" : ""), cn);
          c.title = "只看「" + (x.cn || x.en) + "」的角色（" + x.n + " 个）";
          c.onclick = async () => {
            st.series = (st.series === x.en ? "" : x.en);
            st.shown = 200;
            try { await loadPeekWords(); } catch (er) {}
            renderPeek();
          };
          chips.appendChild(c);
        });
        pWin.appendChild(chips);
      }
    }

    /* 词表（后端已按搜索/系列过滤，这里只做分片显示） */
    const body = el("div", "pc-peekbody");
    const list = st.words;
    const total2 = list.length;
    const slice = list.slice(0, st.shown);
    slice.forEach((w) => {
      const t = el("span", "pc-wtag");
      t.appendChild(el("span", "e", w.prompt));
      if (w.name && w.name !== w.prompt) t.appendChild(el("span", "c", w.name));
      /* 橙色标识（2026-09-29 用户要求：预览的词格也要有，所有槽位都要）
         · 角色槽 → 显示**作品名**（从 "xxx_(作品)" 里取，比重复显示"角色"有用）
         · 其它槽 → 显示**槽位名**
         注意：pc= 用灰色 .p，别和橙色的作品/槽位标混一起。 */
      let badge = "";
      if (st.slot === "角色") {
        /* 作品名优先从 prompt 的 "xxx_(作品)" 取；
           ⚠️ 但很多角色 prompt 不带后缀（hatsune_miku），作品只在**中文名**里
              （"初音未来 (VOCALOID)"）⇒ 再从中文名尾部括号取一次。
              全角/半角括号都要认。 */
        let mm = String(w.prompt).match(/\(([^)]*)\)\s*$/);
        if (!mm && w.name) mm = String(w.name).match(/[（(]([^）)]*)[）)]\s*$/);
        badge = mm ? mm[1] : st.slot;
      } else {
        badge = st.slot;
      }
      if (badge) t.appendChild(el("span", "s", badge));
      if (w.pc != null) t.appendChild(el("span", "p", "pc=" + w.pc));
      /* 2026-10-14 对齐网页槽位预览弹窗：点一下**进/出当前组合**（网页 toggleTag），
         不是复制。在组合里就高亮，再点一下移出。右键仍是增删槽位/全局剔除。 */
      if (curTags.some((z) => z.prompt === w.prompt)) t.classList.add("sel");
      t.classList.add("cli");
      t.title = "点一下进/出当前组合（" + w.prompt + "）；右键可剔除 / 移动";
      t.onclick = () => toggleCurTag(Object.assign({}, w, { slot: st.slot }));
      t.oncontextmenu = (ev) => { ev.preventDefault(); showWordMenu(ev.clientX, ev.clientY, w.prompt, st.slot); };
      body.appendChild(t);
    });
    if (!slice.length) body.appendChild(el("div", "pc-fempty", st.series ? "这个系列下没有词" : "这个槽当前没有词"));
    pWin.appendChild(body);

    /* 底部：加载更多 / 收起 + 计数（对齐网页词库区的 btnMore + btnLess） */
    const foot = el("div", "pc-peekfoot");
    if (total2 > slice.length) {
      const more = el("button", "pc-wbtn", "加载更多");
      more.onclick = () => { st.shown += 200; renderPeek(); };
      foot.appendChild(more);
    }
    if (st.shown > 200 && slice.length > 200) {
      const less = el("button", "pc-wbtn", "收起");
      less.title = "缩回只显示 200 个";
      less.onclick = () => { st.shown = 200; renderPeek(); };
      foot.appendChild(less);
    }
    foot.appendChild(el("span", "pc-wsub", "已显示 " + slice.length + " / " + total2 +
      (st.series ? "（系列 " + st.series + "）" : "")));
    pWin.appendChild(foot);

    /* 占位：首次进来看总数 */
    if (!st.words.length && !st.q) {
      try { await loadPeekWords(); if (peek) renderPeek(); }
      catch (e) { body.replaceChildren(el("div", "pc-err", "读不到这个槽：" + e.message)); }
    }
  }
  function alerted(e) { alert("读取失败：" + e.message); }

  /* 点遮罩空白处也能关（和网页版一致） */
  peekMask.addEventListener("mousedown", (ev) => { if (ev.target === peekMask) closePeek(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && peekMask.style.display !== "none") { e.stopPropagation(); closePeek(); }
  }, true);

  /* ================= 槽位管理弹窗（2026-09-29 对齐网页 #slotEditModal）=================
     网页那边是个「总管理处」，节点原来把这些功能分散在三个标签页里，看起来不一样。
     这里照网页做成一屏：
       ① 配置备份（导出/导入/复制/粘贴）
       ② 重命名槽位      ③ 新建槽位
       ④ 全局剔除        ⑤ 搭配档位
       ⑥ 删除槽位（含已删除列表）    ⑦ 还原全部改动
     ⚠️「槽位池」标签页保留 —— 那页有完整词表，弹窗里放不下。 */
  const smMask = el("div", "pc-smmask");
  smMask.style.display = "none";
  document.body.appendChild(smMask);
  let smOnChange = null;

  /* ⭐ 2026-10-06：「槽位管理弹窗」当前的重画函数。
     ⛔ 为什么要留这个钩子：弹窗里的「删除槽位」下拉用的是 **meta.slotOrder**，
        而新建槽位后 meta 是**异步**重拉的（`refreshAfterSlotEdit` → `reloadMeta`）——
        弹窗在 meta 回来之前就重画了，于是下拉里永远少一个新槽（面板格子已经 +1 了，下拉还是旧的）。
        ⇒ meta 到手后再让弹窗重画一次，下拉才同步。 */
  let _smRedraw = null;
  function closeSlotMgr() { smMask.style.display = "none"; smMask.replaceChildren(); _smRedraw = null; }
  smMask.addEventListener("mousedown", (ev) => { if (ev.target === smMask) closeSlotMgr(); });

  /* 通用：一行标题 */
  const smSec = (title, sub) => {
    const s = el("div", "pc-smsec");
    const h = el("div", "pc-smsec-t");
    h.appendChild(el("span", "", title));
    if (sub) { const t = el("small", "", "  " + sub); h.appendChild(t); }
    s.appendChild(h);
    return s;
  };
  const smRow = (parent) => { const r = el("div", "pc-smrow"); parent.appendChild(r); return r; };
  const smHint = (parent, txt) => { parent.appendChild(el("div", "pc-whint", txt)); };

  function openSlotMgr(onChange) {
    smOnChange = onChange || null;
    smMask.replaceChildren();
    const win = el("div", "pc-smwin");
    const head = el("div", "pc-smhead");
    const ttl = el("span", "pc-wtitle", "槽位管理");
    const sub = el("span", "pc-wsub", "");
    head.append(ttl, sub);
    const sp = el("span", "pc-wsp"); sp.style.flex = "1"; head.appendChild(sp);
    const bReset = el("button", "pc-wbtn sm warn", "还原全部改动");
    const bClose = el("button", "pc-wbtn sm", "关闭");
    head.append(bReset, bClose);
    win.appendChild(head);
    const body = el("div", "pc-smbody");
    win.appendChild(body);
    /* 底部操作条（2026-10-05）：原来「删除槽位」是 body 里最后一张卡片，
       卡片下沿到弹窗底边总留一条空白，观感"没收住"；窗口矮时还得滚到底才能删。
       ⇒ 拎出来做成固定底栏：贴底、不滚动、不再有空档。 */
    const foot = el("div", "pc-smfoot");
    win.appendChild(foot);
    smMask.appendChild(win);
    smMask.style.display = "flex";
    bClose.onclick = () => { closeSlotMgr(); if (smOnChange) smOnChange(); };

    let ed = null;
    const REDRAW = () => draw();

    async function save() {
      const okk = await saveUserEdits();
      if (!okk) alert("保存失败（ComfyUI 后端没响应？）");
      return okk;
    }
    /* 还原全部改动：只清用户改动，词库/原词都不动 */
    bReset.onclick = async () => {
      if (!confirm("还原**全部**用户改动？\n\n会清掉：槽位增删改名、剔除/添加的词、自建档位、全局剔除、抽取频率、提示词权重。\n收藏夹保留。\n\n词库本身不受影响（原词都还在）。")) return;
      await loadUserEdits(true);
      _userEdits.slotEdits = { removed: {}, added: {}, renamed: {}, custom: [], deleted: [] };
      _userEdits.presetEdits = { removed: [], renamed: {}, custom: [] };
      _userEdits.black = [];
      _userEdits.weights = {};       // 2026-10-19：抽取频率回默认
      _userEdits.promptWeights = {};  // 2026-10-19：提示词权重回默认
      await save();
      await loadUserEdits(true);
      draw();
      if (smOnChange) smOnChange();
    };

    const slotNames = () => {
      const se = (_userEdits && _userEdits.slotEdits) || {};
      const del = new Set((se.deleted || []).map((x) => x.name || x));
      const out = [];
      // 内置槽（按 rules 顺序）—— 用 meta.slotOrder；没有 meta 时留空
      const ord = (meta && meta.slotOrder) ? meta.slotOrder : [];
      ord.forEach((s) => { if (!del.has(s)) out.push(s); });
      (se.custom || []).forEach((x) => { if (x.name && out.indexOf(x.name) < 0) out.push(x.name); });
      return out;
    };
    const groups = () => {
      const gs = (meta && meta.slotGroups) ? meta.slotGroups.map((g) => g.name) : [];
      return gs.length ? gs : ["头部前置", "五官", "人物属性", "环境", "服装", "配饰", "镜头构图", "姿势", "环境物件"];
    };

    function draw() {
      _smRedraw = draw;          // ← 登记给 refreshAfterSlotEdit（meta 到手后要再重画一次）
      ed = _userEdits || {};
      const se = ed.slotEdits || {};
      const pe = ed.presetEdits || {};
      const names = slotNames();
      /* 中文对照：先把这屏要显示的词收齐，缺的异步批量查；查回来再重画一次。
         （同步画一版，中文到货后补第二版 —— 不让面板为了查名字卡住） */
      {
        const _ws = [];
        Object.keys(ed.weights || {}).forEach((w) => _ws.push(w));
        Object.keys(ed.promptWeights || {}).forEach((w) => _ws.push(w));
        (ed.black || []).forEach((w) => _ws.push(w));
        Object.keys(se.removed || {}).forEach((k) => (se.removed[k] || []).forEach((w) => _ws.push(w)));
        Object.keys(se.added || {}).forEach((k) => (se.added[k] || []).forEach((w) => _ws.push(w)));
        _loadCn(_ws).then((did) => { if (did) draw(); }).catch(() => {});
      }
      /* ⭐ 2026-10-06：恢复一个被删的槽位 —— 「已删除」列表的恢复按钮、以及
         「我改过的地方」里那条「删槽」的撤销，**共用这一份**。
         ⛔ 关键是自建槽要**重新登记回 custom**（对齐网页 restoreDeletedSlot）：
            只把 deleted 记录删掉的话，它既不在内置槽表、也不在自建表里 ——
            界面上看着回来了，后端 slot_order 里却没有，等于"恢复了但抽不到"。 */
      const restoreSlot = (nm) => {
        const dl2 = (se.deleted = se.deleted || []);
        const rec = dl2.find((y) => ((y && y.name) || y) === nm);
        se.deleted = dl2.filter((y) => ((y && y.name) || y) !== nm);
        if (rec && rec.custom) {
          se.custom = se.custom || [];
          if (!se.custom.some((c) => c.name === nm)) {
            se.custom.push({ name: nm, group: rec.group || "自定义" });
          }
        }
      };
      const nChg = Object.keys(se.removed || {}).length + Object.keys(se.added || {}).length +
                   Object.keys(se.renamed || {}).length + (se.custom || []).length + (se.deleted || []).length;
      sub.textContent = (meta ? meta.slotOrder.length + " 槽 · " : "") + nChg + " 处改动";
      body.replaceChildren();
      /* ⛔ 2026-10-06 修（阿君报「新建的槽位这里要同步显示有」）：
         foot（固定底栏）原来**没有清空** —— 每重画一次就往里多堆一个「删除槽位」区块。
         实测点 3 次后底栏里躺着 3 个，而 `querySelector` 永远取到**最旧那份**（meta 还是旧的），
         于是「新建的槽位在下拉里看不到、关掉重开才有」。body 和 foot 必须一起清。 */
      foot.replaceChildren();
      smHint(body, "这里改的是**你自己看到的池子**：剔除只影响抽取，词库照样能搜到；新建的槽位可以自己往里放词。");

      /* ① 配置备份 */
      {
        const s = smSec("配置备份（导出 / 导入）");
        smHint(s, "清浏览器数据 / 换浏览器 / 无痕 / 换设备 / 重装系统 都会让改动丢失 —— 改完重要的就导一次。");
        const r = smRow(s);
        const bE = el("button", "pc-wbtn sm", "⬇ 导出配置");
        bE.onclick = async () => {
          await loadUserEdits(true);
          const p = buildCfgPayload();
          const stamp = new Date().toISOString().slice(0, 10);
          if (dlJson("prompt-combiner-" + stamp + ".json", JSON.stringify(p, null, 1)))
            alert("已导出\n概览：" + JSON.stringify(p.summary, null, 1));
        };
        const bI = el("button", "pc-wbtn sm", "⬆ 导入配置");
        bI.onclick = () => pickJsonFile(async (obj) => { if (await applyCfgPayload(obj)) draw(); });
        const bC = el("button", "pc-wbtn sm", "📋 复制配置");
        bC.onclick = async () => {
          await loadUserEdits(true);
          copyText(JSON.stringify(buildCfgPayload()), (okk) => alert(okk ? "已复制到剪贴板" : "复制失败"));
        };
        const bP = el("button", "pc-wbtn sm", "📋 粘贴导入");
        bP.onclick = async () => {
          let t = "";
          try { t = await navigator.clipboard.readText(); } catch (e) {}
          if (!t) t = prompt("把配置 JSON 粘在这里：") || "";
          if (!t.trim()) return;
          try { if (await applyCfgPayload(JSON.parse(t))) draw(); } catch (e) { alert("JSON 解析失败：" + e.message); }
        };
        r.append(bE, bI, bC, bP);
        body.appendChild(s);
      }

      /* ② 重命名槽位 */
      {
        const s = smSec("重命名槽位");
        const r = smRow(s);
        const sel = el("select", "pc-psel");
        names.forEach((x) => { const o = el("option", "", x + (se.renamed[x] ? "（现名：" + se.renamed[x] + "）" : "")); o.value = x; sel.appendChild(o); });
        const inp = el("input", "pc-winput");
        inp.placeholder = "新名字，如：上衣"; inp.style.flex = "1 1 130px";
        const b = el("button", "pc-wbtn sm", "改名");
        b.onclick = async () => {
          const v = inp.value.trim();
          const k = sel.value;
          if (!k) return;
          if (!v) { delete se.renamed[k]; } else { se.renamed[k] = v; }
          if (await save()) { inp.value = ""; draw(); if (smOnChange) smOnChange(); }
        };
        r.append(sel, inp, b);
        body.appendChild(s);
      }

      /* ③ 新建槽位 */
      {
        const s = smSec("新建槽位");
        const r = smRow(s);
        const inp = el("input", "pc-winput");
        inp.placeholder = "新槽位名，如：表情包"; inp.style.flex = "1 1 130px";
        const sel = el("select", "pc-psel");
        groups().forEach((g) => { const o = el("option", "", g); o.value = g; sel.appendChild(o); });
        const b = el("button", "pc-wbtn sm", "创建");
        b.onclick = async () => {
          const v = inp.value.trim();
          if (!v) return;
          if (names.indexOf(v) >= 0) { alert("已经有这个槽了"); return; }
          (se.custom = se.custom || []).push({ name: v, group: sel.value });
          if (await save()) { inp.value = ""; draw(); if (smOnChange) smOnChange(); }
        };
        r.append(inp, sel, b);
        body.appendChild(s);
      }

      /* ④ 全局剔除 */
      {
        const list = ed.black || [];
        /* 同一个词的两种写法（空格 / 下划线）在界面上归成一条 ——
           词库 prompt 本来就混用两种写法，封一个词可能要两种都存才拦得住。 */
        const _bk = (x) => String(x).toLowerCase().replace(/_/g, " ").trim();
        const _uniqN = new Set(list.map(_bk)).size;
        const s = smSec("全局剔除", _uniqN ? _uniqN + " 个" : "");
        smHint(s, "这些词不会出现在任何槽位里。在结果区/预览的词上**右键**选「🚫 从所有槽剔除」也能加入。");
        /* ⭐ 2026-11-22（阿君：「需要可以让某个提示词完全不出现的功能」）：
           原来只有「先抽到它 → 再右键封」这条路，想**提前**封一批词做不到。
           这里补一个输入框：英文直接封；中文自动翻成词库里的英文再封。

           ⚠️ 词库里的 prompt 是**空格 / 下划线混用**的（'flat colors' 和 'cure_mofurun' 并存），
              所以英文也要先拿 /dict 查出**原文**再存 —— 直接拿用户敲的写法去比，有一半封不掉。
           ⚠️ 纯英文只在「同形」时才认（'cat' 不许被模糊成 'cat_ears'），
              中文因为没法同形比对，才退而取搜索第一条。 */
        {
          const r0 = smRow(s);
          const inp = el("input", "pc-winput");
          inp.placeholder = "粘贴要彻底封掉的词，多个用逗号 / 换行隔开（中英文都行）";
          inp.style.flex = "1";
          inp.style.minWidth = "0";
          const bAdd = el("button", "pc-wbtn sm", "加入封杀");

          const doAdd = async () => {
            const parts = String(inp.value || "").split(/[,，、;；\n\r]+/)
              .map((x) => x.trim()).filter(Boolean);
            if (!parts.length) { inp.focus(); return; }

            const oldTxt = bAdd.textContent;
            bAdd.disabled = true;
            bAdd.textContent = "处理中…";
            const got = [], miss = [];
            try {
              for (const raw of parts) {
                const ascii = /^[\x20-\x7E]+$/.test(raw);
                const tries = [raw];
                if (ascii) {
                  if (raw.indexOf("_") >= 0) tries.push(raw.replace(/_/g, " "));
                  if (/\s/.test(raw)) tries.push(raw.replace(/\s+/g, "_"));
                }
                let hit = "";
                for (const qq of tries) {
                  try {
                    const d = await api("/dict?q=" + encodeURIComponent(qq)
                      + "&size=1&nsfw=0&gender=" + encodeURIComponent("全部"));
                    const w0 = (d && d.words && d.words[0]) || null;
                    if (!w0 || !w0.prompt) continue;
                    /* 英文必须同形 —— /dict 会按前缀/包含模糊命中，
                       不卡这一下的话「封 cat」可能被封成「cat_ears」。 */
                    if (ascii && _bk(w0.prompt) !== _bk(raw)) continue;
                    hit = String(w0.prompt);
                    break;
                  } catch (e) { /* 查不到就当这一种写法没命中 */ }
                }
                /* 词库没收录的英文：**两种写法都存**。
                   理由：/dict 只能查 dict_rows 里有的词，像画质类的 'flat colors'
                   根本搜不到；而它在词库里到底写成空格还是下划线，前端无从得知。
                   只存一种写法有一半概率封不掉，索性两种都存（界面会归成一条）。 */
                const addOne = (k) => {
                  if (!k) return;
                  if (!Array.isArray(ed.black)) ed.black = [];
                  if (ed.black.indexOf(k) < 0) { ed.black.push(k); got.push(k); }
                };
                if (!hit) {
                  if (!ascii) { miss.push(raw); continue; }
                  addOne(raw);
                  if (raw.indexOf("_") >= 0) addOne(raw.replace(/_/g, " "));
                  else if (/\s/.test(raw)) addOne(raw.replace(/\s+/g, "_"));
                  continue;
                }
                addOne(hit);
              }
              if (got.length && await save()) {
                inp.value = "";
                draw();
                if (smOnChange) smOnChange();
              }
            } finally {
              bAdd.disabled = false;
              bAdd.textContent = oldTxt;
            }
            const msg = [];
            if (got.length) {
              msg.push("已封杀 " + got.length + " 个：" + got.slice(0, 6).join("、")
                       + (got.length > 6 ? " 等" : ""));
            }
            if (miss.length) {
              msg.push("没找到：" + miss.join("、")
                       + "（换个更准的中文名，或直接抄结果区里那个英文词）");
            }
            if (Array.isArray(ed.black) && ed.black.length > 50000) msg.push("注意：超过 50000 条会被后端截断");
            gCount.textContent = msg.length ? msg.join(" · ") : "没有可加入的词";
          };
          bAdd.onclick = doAdd;
          inp.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); doAdd(); }
          });
          r0.append(inp, bAdd);
        }
        const box = el("div", "pc-gkbox");
        if (!list.length) box.appendChild(el("span", "pc-whint", "（没有全局剔除的词）"));
        /* 同一词的两种写法只显示一条（否则批量封杀后列表会翻倍）；解除时两种一起解。 */
        const _seenB = new Set();
        list.forEach((wname) => {
          const _key = _bk(wname);
          if (_seenB.has(_key)) return;
          _seenB.add(_key);
          const t = el("span", "pc-gktag");
          t.appendChild(el("span", "e", wname));
          const _c = _cnOf(wname);
          if (_c) t.appendChild(el("span", "c", _c));
          const x = el("span", "x", "✕");
          x.title = "解除";
          x.onclick = async () => {
            ed.black = ed.black.filter((y) => _bk(y) !== _key);
            if (await save()) { draw(); if (smOnChange) smOnChange(); }
          };
          t.appendChild(x);
          box.appendChild(t);
        });
        s.appendChild(box);
        if (list.length) {
          const r = smRow(s);
          const b = el("button", "pc-wbtn sm warn", "全部解除");
          b.onclick = async () => {
            if (!confirm("解除全部 " + list.length + " 个词？")) return;
            ed.black = [];
            if (await save()) { draw(); if (smOnChange) smOnChange(); }
          };
          r.appendChild(b);
        }
        body.appendChild(s);
      }

      /* ⑤ 标签权重（2026-10-19）—— 两种，别混：
         · 「⚖ 抽取频率」右键项 → ed.weights（改**概率**，钳 [0.05, 20]）
         · 「🔆 提示词权重」右键项 → ed.promptWeights（改**输出括号** `(tag:1.5)`，钳 [0.1, 3]）
         两块用同一个渲染器，只是键名/符号/说明不同。 */
      const _weightSection = (opts) => {
        const W = (ed[opts.key] = ed[opts.key] || {});
        const ks = Object.keys(W).sort((a, b) => (W[b] - W[a]) || String(a).localeCompare(String(b)));
        const s = smSec(opts.title, ks.length ? ks.length + " 个词" : "");
        smHint(s, opts.hint);
        const box = el("div", "pc-gkbox");
        if (!ks.length) box.appendChild(el("span", "pc-whint", opts.empty));
        ks.forEach((wname) => {
          const t = el("span", "pc-gktag");
          t.appendChild(el("span", "e", wname));
          /* 中文对照（2026-10-20）：一排 `amplified_composition×3` 看不出是什么 */
          const _c = _cnOf(wname);
          if (_c) t.appendChild(el("span", "c", _c));
          const v = el("span", "x", opts.fmt(W[wname]));
          v.title = opts.tip;
          t.appendChild(v);
          const x = el("span", "x", "✕");
          x.title = "恢复默认";
          x.onclick = async () => {
            delete ed[opts.key][wname];
            if (await save()) { draw(); if (smOnChange) smOnChange(); }
          };
          t.appendChild(x);
          box.appendChild(t);
        });
        s.appendChild(box);
        if (ks.length) {
          const r = smRow(s);
          const b = el("button", "pc-wbtn sm warn", "全部恢复默认");
          b.onclick = async () => {
            if (!confirm(opts.allAsk.replace("{n}", ks.length))) return;
            ed[opts.key] = {};
            if (await save()) { draw(); if (smOnChange) smOnChange(); }
          };
          r.appendChild(b);
        }
        body.appendChild(s);
      };
      _weightSection({
        key: "weights", title: "抽取频率",
        hint: "右键 →「⚖ 抽取频率…」设置。倍数 1 = 默认，0.3 = 少出现（约 1/3），3 = 常出现（约 3 倍）。"
          + "只影响**抽不抽得到**，不改提示词里的文字。想让它完全不出请用上面的「全局剔除」。",
        empty: "（还没给任何词设抽取频率）",
        fmt: (v) => "×" + v, tip: "当前抽取频率倍数",
        allAsk: "把 {n} 个词的抽取频率全部恢复默认？\n（词本身不受影响，只是回到按热度抽取）",
      });
      _weightSection({
        key: "promptWeights", title: "提示词权重",
        hint: "右键 →「🔆 提示词权重…」设置。抽到这个词时输出成 (tag:1.5) 这种强调括号："
          + "1.5 = 加强，0.8 = 削弱，范围 " + PW_MIN + "~" + PW_MAX + "。1 = 默认（不加括号）。"
          + "只改**输出写法**，不改抽取概率。",
        empty: "（还没给任何词设提示词权重）",
        fmt: (v) => ":" + v, tip: "提示词括号权重",
        allAsk: "把 {n} 个词的提示词权重全部恢复默认？\n（提示词里会恢复成不括号）",
      });

      /* ⑥ 搭配档位（对齐网页：列出**全部**档位，每个都有 改名/覆盖/删除）
         · 内置 6 档也列出来，不是只列自建的（2026-09-29 补：原来漏了内置档和「覆盖」）
         · 覆盖 = 用当前槽位组合替换这个档位的槽位表（存 presetEdits.overrides[key]）
         · 删除内置档 = 从界面移除（pe.removed，可用右上「还原全部改动」找回） */
      {
        const ovr = (pe.overrides = pe.overrides || {});
        const biName = {};
        const all = [];
        (meta && meta.presets ? meta.presets : []).forEach((pp, i) => {
          const key = "__bi" + i;
          biName[key] = pp.name;
          if ((pe.removed || []).indexOf(key) >= 0) return;
          /* 2026-10-19：overrides 可能是老的槽名数组，也可能是新的 {槽:数量} 对象，
             统一过 presetTable（见主界面 renderPresetChips 上方那段说明）。 */
          const ov = presetTable(ovr[key]);
          all.push({ key: key, name: pe.renamed[key] || pp.name,
                     on: ov ? ov.on : (pp.on || []),
                     counts: ov ? ov.counts : (pp.counts || {}),
                     hasOvr: !!ov,
                     builtin: true, freeAll: !!pp.freeAll, presetName: pp.name });
        });
        (pe.custom || []).forEach((pp) => {
          const ov = presetTable(ovr[pp._key]);
          all.push({
            key: pp._key, name: pe.renamed[pp._key] || pp.name,
            on: ov ? ov.on : (pp.on || []),
            /* 2026-10-19：自建档位带上「每槽几个」（原来只存槽名，首饰抽 3 个这种配置存档位就丢了）。
               被「覆盖」过的以 ovr 的槽表为准（新数据带 counts）。 */
            counts: ov ? ov.counts : (pp.counts || {}),
            hasOvr: !!ov,
            builtin: false, freeAll: false,
          });
        });

        const s = smSec("搭配档位", "共 " + all.length + " 个档位");
        const r = smRow(s);
        const inp = el("input", "pc-winput");
        inp.placeholder = "新档位名（用当前槽位组合）"; inp.style.flex = "1 1 160px";
        const b = el("button", "pc-wbtn sm", "存为档位");
        b.onclick = async () => {
          const v = inp.value.trim();
          if (!v) return;
          /* 2026-10-19：逻辑抽到 saveCustomPreset（顶栏「+ 存为档位」也调它），
             原来两处各写一份，容易改一处漏一处。 */
          const res = await saveCustomPreset(v);
          if (!res.ok) { alert(res.why); return; }
          inp.value = "";
          await loadUserEdits(true);
          draw();
          gCount.textContent = "已存为档位「" + v + "」（" + res.n + " 个槽）" + (res.why || "");
        };
        r.append(inp, b);

        if (!all.length) smHint(s, "（一个档位都没有了 —— 点右上「还原全部改动」可以找回内置档）");
        all.forEach((pp) => {
          const rr = el("div", "pc-smrow");
          const tagEl = el("span", "pc-smtag", pp.builtin ? "内置" : "自建");
          rr.appendChild(tagEl);
          const nmEl = el("span", "pc-smname", pp.name);
          if (pp.hasOvr) nmEl.title = "已被「覆盖」过（槽位表是自定义的）";
          rr.appendChild(nmEl);
          rr.appendChild(el("span", "pc-whint",
            pp.freeAll && !pp.hasOvr ? "空白起步" : (pp.on || []).length + " 个槽位"));
          const sp2 = el("span"); sp2.style.flex = "1"; rr.appendChild(sp2);

          const bUse = el("button", "pc-wbtn sm", "应用");
          bUse.title = "把这个档位的槽位组合套到面板上";
          bUse.onclick = async () => {
            if (pp.builtin && !pp.hasOvr) {
              /* 内置档且没被覆盖 → 直接切 preset（保留原来的语义） */
              setW("preset", pp.presetName);
              writeSlots({});
            } else {
              const on = {};
              (pp.on || []).forEach((k) => { on[k] = (pp.counts && pp.counts[k]) || 1; });
              setW("slots_json", Object.keys(on).length ? JSON.stringify(on) : "");
            }
            if (smOnChange) smOnChange();
            gCount.textContent = "已应用档位「" + pp.name + "」（" + (pp.on || []).length + " 个槽）";
          };

          const bRen = el("button", "pc-wbtn sm", "改名");
          bRen.onclick = async () => {
            const v = prompt("把「" + pp.name + "」改成：", pp.name);
            if (v === null) return;
            if (!v.trim()) delete pe.renamed[pp.key];
            else pe.renamed[pp.key] = v.trim();
            if (await save()) draw();
          };

          const bOvr = el("button", "pc-wbtn sm", "覆盖");
          bOvr.title = "用当前面板上的槽位组合替换这个档位";
          bOvr.onclick = async () => {
            const cur = currentOn();
            const on = Object.keys(cur).filter((k) => slotCountOf(cur[k]) > 0);
            if (!on.length) { alert("当前一个槽位都没开，没东西可覆盖"); return; }
            if (!confirm("用当前槽位组合覆盖「" + pp.name + "」？\n（现在是 " + (pp.on || []).length +
                         " 个槽 → 将变成 " + on.length + " 个槽）")) return;
            /* 存 {槽:数量}，别存数组 —— 数组会丢掉「首饰 3 个」这类配置（v1.3.5） */
            const tbl = {};
            on.forEach((k) => { tbl[k] = slotCountOf(cur[k]) || 1; });
            ovr[pp.key] = tbl;
            if (await save()) { draw(); renderGen(); }
          };

          const bDel = el("button", "pc-wbtn sm warn", "删除");
          bDel.onclick = async () => {
            if (!confirm("把档位「" + pp.name + "」从界面移除？\\n（内置档可恢复，点右上「还原全部改动」）")) return;
            if (pp.builtin) (pe.removed = pe.removed || []).push(pp.key);
            else pe.custom = (pe.custom || []).filter((x) => x._key !== pp.key);
            if (await save()) draw();
          };
          rr.append(bUse, bRen, bOvr, bDel);
          s.appendChild(rr);
        });
        body.appendChild(s);
      }

      /* ⑦ 我改过的地方（改动历史）—— 2026-10-06 补，对齐网页 renderEditList
         ⛔ 阿君原话：「改动历史设置可以删除这些改动历史，comfyui 节点槽位管理里面也没有显示
            这个改动历史」⇒ 网页有这一块、节点没有。五类改动各列一条，右侧「撤销」单条回退。 */
      {
        /* ⭐ 2026-10-06 追加（阿君澄清：「我要的是删除这些改动历史，不是恢复和回退回去啊」）
           ⇒ 把**记录**和**改动**拆开：`se.hidden` 记着"已被从列表里删掉的那些记录"（kind|slot|word），
              「删除这些改动记录」只是把记录藏起来 —— **槽位池的改动照旧生效**
              （剔除的词照旧不出现、加的词照旧会用）。想回退改动本身，那才是右上角「还原全部改动」。 */
        const rowsAll = [];
        Object.keys(se.removed || {}).sort().forEach((k) => (se.removed[k] || []).forEach((w) => rowsAll.push({ kind: "剔除", slot: k, word: w })));
        Object.keys(se.added || {}).sort().forEach((k) => (se.added[k] || []).forEach((w) => rowsAll.push({ kind: "添加", slot: k, word: w })));
        Object.keys(se.renamed || {}).sort().forEach((k) => rowsAll.push({ kind: "改名", slot: k, word: se.renamed[k] }));
        (se.custom || []).forEach((c) => rowsAll.push({ kind: "新槽", slot: c.name, word: c.group }));
        (se.deleted || []).forEach((o) => rowsAll.push({ kind: "删槽", slot: (o && o.name) || o, word: "" }));
        const _ekey = (r) => r.kind + "|" + r.slot + "|" + r.word;
        const _hid = new Set(se.hidden || []);
        const rows = rowsAll.filter((r) => !_hid.has(_ekey(r)));
        const s = smSec("我改过的地方", rows.length ? rows.length + " 处" : "");
        if (!rowsAll.length) {
          smHint(s, "（还没改过任何东西 —— 剔除/添加/改名/新建/删除槽位都会记在这里，随时可撤销）");
        } else {
          if (!rows.length) {
            /* 记录被删光了、但改动仍在生效 —— 必须说清楚，否则用户以为改动也没了 */
            smHint(s, "（改动记录已删除 —— **改动本身照旧生效**。要回退改动点右上「还原全部改动」，只想看回记录点下面「显示全部记录」）");
          }
          const box = el("div", "pc-gkbox");
          if (!rows.length) box.style.display = "none";   // 记录被删光时别在界面上留个空框
          rows.forEach((r) => {
            /* 剔除/添加的词带上中文名（2026-10-20 阿君：「包括删除的标签，增加中文对照」）。
               改名/新槽/删槽本身是槽位名，没有中文可查，保持原样。 */
            const _cnr = (r.kind === "添加" || r.kind === "剔除") ? _cnOf(r.word) : "";
            const label = r.kind === "改名" ? (r.slot + " → " + r.word)
              : r.kind === "新槽" ? (r.slot + "（分组：" + (r.word || "自定义") + "）")
              : r.kind === "删槽" ? ("已删除：" + r.slot)
              : (r.word + (_cnr ? "（" + _cnr + "）" : "") + "　[" + r.slot + "]");
            const t = el("span", "pc-gktag");
            t.appendChild(el("span", "e", r.kind + " " + label));
            const x = el("span", "x", "撤销");
            x.style.color = "#8ff0e6";
            x.title = "撤销这一条改动";
            x.onclick = async () => {
              if (r.kind === "剔除") {
                const a = (se.removed || {})[r.slot] || [];
                const i = a.indexOf(r.word);
                if (i >= 0) a.splice(i, 1);
                if (!a.length && se.removed) delete se.removed[r.slot];
              } else if (r.kind === "添加") {
                const a = (se.added || {})[r.slot] || [];
                const i = a.indexOf(r.word);
                if (i >= 0) a.splice(i, 1);
                if (!a.length && se.added) delete se.added[r.slot];
              } else if (r.kind === "改名") {
                if (se.renamed) delete se.renamed[r.slot];
              } else if (r.kind === "新槽") {
                se.custom = (se.custom || []).filter((c) => c.name !== r.slot);
              } else if (r.kind === "删槽") {
                restoreSlot(r.slot);      // ← 与「已删除」列表的恢复共用（自建槽会登记回 custom）
              }
              /* 撤销了这条改动 → 顺手把它的"已删除记录"标记清掉（以后再改一次能正常显示） */
              se.hidden = (se.hidden || []).filter((k) => k !== _ekey(r));
              if (await save()) { draw(); if (smOnChange) smOnChange(); }
            };
            t.appendChild(x);
            /* ⭐ 2026-10-06 阿君要的「单条删除」：跟左边那个「撤销」分工不同 ——
               「撤销」= 回退这条改动本身；这个「×」= 只把记录从列表里去掉（写进 se.hidden），
               **改动照旧生效**（剔除的词照旧不出现、加的词照旧会用）。 */
            const xd = el("span", "x", "×");
            xd.style.color = "#ff9b9b";
            xd.title = "只删掉这条记录（不改动槽位池；要回退改动点左边「撤销」）";
            xd.onclick = async () => {
              se.hidden = (se.hidden || []).concat([_ekey(r)]);
              if (await save()) { draw(); if (smOnChange) smOnChange(); }
            };
            t.appendChild(xd);
            box.appendChild(t);
          });
          s.appendChild(box);
          /* ⭐ 2026-10-06（阿君澄清后定的语义）：**删记录 ≠ 回退改动**。
             「删除这些改动记录」只把记录从列表里藏起来（写进 `se.hidden`），槽位池一动不动；
              要回退改动本身请用右上角「还原全部改动」（那个也会顺手清掉 hidden）。
             「显示全部记录」= 撤销"删除记录"这一步，把藏起来的记录放回来。 */
          const cr = smRow(s);
          if (rows.length) {
            const cb = el("button", "pc-wbtn sm warn", "删除这些改动记录");
            cb.title = "只把记录从列表里去掉，**不改动槽位池**（剔除的词照旧不出现、加的词照旧会用）；回退改动请用右上「还原全部改动」";
            cb.onclick = async () => {
              if (!confirm("删除这 " + rows.length + " 条改动记录？\n\n**只从列表里移除这些记录，槽位池的改动保持原样**：剔除的词照旧不出现、加的词照旧会用。\n（要回退改动本身，请用右上角「还原全部改动」）")) return;
              se.hidden = (se.hidden || []).concat(rows.map(_ekey));
              if (await save()) { draw(); if (smOnChange) smOnChange(); }
            };
            cr.appendChild(cb);
          }
          if (_hid.size) {
            const rb = el("button", "pc-wbtn sm", "显示全部记录");
            rb.title = "把之前删掉的 " + _hid.size + " 条记录重新显示出来（只影响列表显示）";
            rb.onclick = async () => {
              se.hidden = [];
              if (await save()) { draw(); if (smOnChange) smOnChange(); }
            };
            cr.appendChild(rb);
          }
        }
        body.appendChild(s);
      }

      /* ⑧ 删除槽位 */
      {
        const dl = se.deleted || [];
        const s = smSec("删除槽位", dl.length ? dl.length + " 个已删除" : "");
        const r = smRow(s);
        const sel = el("select", "pc-psel");
        names.forEach((x) => { const o = el("option", "", x); o.value = x; sel.appendChild(o); });
        const b = el("button", "pc-wbtn sm warn", "删除");
        b.onclick = async () => {
          const k = sel.value;
          if (!k) return;
          if (!confirm("把「" + k + "」从界面移除？（词库不动，可在下面恢复）")) return;
          const isCustom = (se.custom || []).some((c) => c.name === k);
          if (isCustom) se.custom = se.custom.filter((c) => c.name !== k);
          /* ⭐ 2026-10-06 对齐网页 deleteSlot：**自建槽也进「已删除」列表**（带 custom 标记）。
             原来自建槽一删就从 custom 直接抹掉、不留痕迹 ⇒ 既没法恢复、也不出现在
             「我改过的地方」里（阿君要的就是"改动历史能看见、能撤销"）。 */
          const dl = (se.deleted = se.deleted || []);
          if (!dl.some((o) => ((o && o.name) || o) === k)) {
            let grp = "自定义";
            ((meta && meta.slotGroups) || []).forEach((g) => { if ((g.slots || []).indexOf(k) >= 0) grp = g.name; });
            dl.push({ name: k, group: grp, custom: !!isCustom });
          }
          if (await save()) { draw(); if (smOnChange) smOnChange(); }
        };
        sel.style.flex = "1";      /* 撑满整行，否则下拉框右边空一大片（2026-10-05 反馈） */
        r.append(sel, b);
        if (dl.length) {
          const box = el("div", "pc-gkbox");
          dl.forEach((o) => {
            const t = el("span", "pc-gktag");
            t.appendChild(el("span", "e", (o.name || o)));
            const x = el("span", "x", "恢复");
            x.style.color = "#8ff0e6";
            x.onclick = async () => {
              restoreSlot(o.name || o);     // ← 与「改动历史」里撤销「删槽」共用同一份
              if (await save()) { draw(); if (smOnChange) smOnChange(); }
            };
            t.appendChild(x);
            box.appendChild(t);
          });
          s.appendChild(box);
        }
        foot.appendChild(s);          /* ⬅ 进底栏，不再拖在 body 末尾 */
      }
    }

    /* ⚠️ 后端拉不到（没启动 / 报错）时也要把弹窗画出来 —— 原来只 `.then(draw)`，
       失败就一个空白弹窗，用户以为界面坏了。现在失败也 draw（各区块都带 `|| {}` 兜底）。 */
    loadUserEdits(true).then(() => draw(), () => draw());
  }

  /* ---- 配置备份的公共函数（弹窗和档位页共用）---- */
  function buildCfgPayload() {
    const widgets = {};
    ((node && node.widgets) || []).forEach((w) => { if (w.name !== "pc_panel") widgets[w.name] = w.value; });
    const u = _userEdits || {};
    const data = {
      slotEdits: u.slotEdits || {}, presetEdits: u.presetEdits || {},
      favorites: u.favorites || [], black: u.black || [], cnTpl: u.cnTpl || {},
      weights: u.weights || {},          // 2026-10-19 抽取频率
      promptWeights: u.promptWeights || {},   // 2026-10-19 提示词权重 (tag:1.5)
      widgets: widgets,
    };
    return {
      app: "prompt-combiner-config", version: 1, exportedAt: new Date().toISOString(),
      summary: {
        槽位改动: Object.keys((data.slotEdits && data.slotEdits.removed) || {}).length +
                  Object.keys((data.slotEdits && data.slotEdits.added) || {}).length,
        自建档位: ((data.presetEdits && data.presetEdits.custom) || []).length,
        收藏: (data.favorites || []).length,
        全局剔除: (data.black || []).length,
        抽取频率: Object.keys(data.weights || {}).length,
        提示词权重: Object.keys(data.promptWeights || {}).length,
        参数: Object.keys(widgets).length,
      },
      data: data,
    };
  }
  function dlJson(name, text) {
    try {
      const blob = new Blob([text], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
      return true;
    } catch (e) { return false; }
  }
  function pickJsonFile(cb) {
    const f = document.createElement("input");
    f.type = "file"; f.accept = ".json,application/json";
    f.onchange = () => {
      const file = f.files && f.files[0];
      if (!file) return;
      const rd = new FileReader();
      rd.onload = () => { try { cb(JSON.parse(String(rd.result))); } catch (e) { alert("JSON 解析失败：" + e.message); } };
      rd.readAsText(file);
    };
    f.click();
  }
  async function applyCfgPayload(obj) {
    if (!obj || obj.app !== "prompt-combiner-config" || !obj.data) {
      alert("这不是本插件的配置文件"); return false;
    }
    const d = obj.data;
    if (!confirm("导入会**覆盖**当前配置：\n" +
      "  槽位改动 " + (d.slotEdits ? "有" : "无") + "\n" +
      "  自建档位 " + ((d.presetEdits && d.presetEdits.custom) || []).length + " 个\n" +
      "  收藏 " + (d.favorites || []).length + " 条\n" +
      "  全局剔除 " + (d.black || []).length + " 个\n" +
      "  抽取频率 " + Object.keys(d.weights || {}).length + " 个\n" +
      "  提示词权重 " + Object.keys(d.promptWeights || {}).length + " 个\n" +
      "  参数 " + Object.keys(d.widgets || {}).length + " 项\n\n建议先「导出配置」留底。继续？")) return false;
    await loadUserEdits(true);
    if (d.slotEdits) _userEdits.slotEdits = d.slotEdits;
    if (d.presetEdits) _userEdits.presetEdits = d.presetEdits;
    if (Array.isArray(d.favorites)) _userEdits.favorites = d.favorites;
    if (Array.isArray(d.black)) _userEdits.black = d.black;
    if (d.cnTpl && typeof d.cnTpl === "object") _userEdits.cnTpl = d.cnTpl;
    /* 2026-10-19：老配置文件没有 weights 字段 ⇒ 不动现有权重（不要清空） */
    if (d.weights && typeof d.weights === "object" && !Array.isArray(d.weights)) _userEdits.weights = d.weights;
    if (d.promptWeights && typeof d.promptWeights === "object" && !Array.isArray(d.promptWeights))
      _userEdits.promptWeights = d.promptWeights;
    await saveUserEdits();
    Object.entries(d.widgets || {}).forEach(([k, v]) => {
      const w = ((node && node.widgets) || []).find((x) => x.name === k);
      if (!w) return;
      w.value = v; try { w.callback?.(v); } catch (e) {}
    });
    try { node.graph?.change?.(); app.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
    return true;
  }

  /* ---- 轻提示 toast ----
     ⛔ 原来这些反馈都写进 `gCount`（节点面板上那个「N 个标签」），
        但紧接着调用的 `roll()` → `renderResult()` 会**立刻把 gCount 覆盖成标签数**
        ⇒ 用户永远看不到"已把某某加进某槽"这类确认。改用浮层 toast。 */
  function toast(msg, bad) {
    let t = document.getElementById("pcToast");
    if (!t) {
      t = el("div", "pc-toast");
      t.id = "pcToast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = "pc-toast show" + (bad ? " bad" : "");
    if (t._tm) clearTimeout(t._tm);
    t._tm = setTimeout(() => { t.className = "pc-toast"; }, 2400);
  }

  /* ---- 通用弹出菜单（挂 document.body 的 fixed 浮层，点别处自动关）----
     items: [{icon, label, hint?, danger?, fn}] */
  function popMenu(x, y, items) {
    document.querySelectorAll(".pc-ctxmenu").forEach((e) => e.remove());
    const m = el("div", "pc-ctxmenu");
    items.forEach((it) => {
      const row = el("div", "pc-ctxitem" + (it.danger ? " danger" : ""));
      if (it.icon) row.appendChild(el("span", "ic", it.icon));
      row.appendChild(el("span", "lb", it.label));
      if (it.hint) row.appendChild(el("span", "hint", it.hint));
      if (it.title) row.title = it.title;
      row.onclick = (ev) => { ev.stopPropagation(); m.remove(); it.fn && it.fn(); };
      m.appendChild(row);
    });
    m.style.left = Math.min(x, (window.innerWidth || 1200) - 260) + "px";
    m.style.top = y + "px";
    document.body.appendChild(m);
    const close = (ev) => {
      if (!m.contains(ev.target)) { m.remove(); document.removeEventListener("mousedown", close, true); }
    };
    setTimeout(() => document.addEventListener("mousedown", close, true), 0);
  }

  /* ---- 词 → 所在槽 反查（网页的 slotsOf；后端 /pc/slots_of 带 42 槽整表缓存）----
     ⚠️ 2026-09-29 补：原来词库区的词右键永远只出「从所有槽剔除」，
        就是因为**没人能说出这个词在哪个槽**（调用方传的 slot 是空串）。
        网页靠 `slotsOf(prompt)` 动态反查，这里照做。不缓存，避免脏读。 */
  let _slotOfWarned = false;
  /* 返回 {slots, name} —— name 是中文名，选槽弹窗标题要用（对齐网页） */
  async function slotInfo(word) {
    try {
      const d = await api("/slots_of?prompt=" + encodeURIComponent(word)
        + "&gender=" + encodeURIComponent(wval("gender", "只看女性"))
        + "&nsfw=" + (wval("nsfw_filter", true) ? 1 : 0) + "&nsfwOnly=" + (wval("nsfw_only", false) ? 1 : 0));
      /* cr = 这个词所属作品的版权词（后端 cr_resolve 解析，可能为 null） */
      return { slots: d.slots || [], name: d.name || "", cr: d.cr || null, tr: d.tr || [] };
    } catch (e) {
      /* ⚠️ 别静默当"这个词不在任何槽"返回 [] —— 那会让已经在槽里的词也显示成
         「添加到槽位…」，菜单是错的还看不出来。后端没重启时就是这个症状。 */
      if (!_slotOfWarned) {
        _slotOfWarned = true;
        console.error("[prompt-combiner] /pc/slots_of 不可用（改过 server.py 需重启 ComfyUI）", e);
        try { toast("槽位反查不可用：请重启 ComfyUI（改了后端 server.py）", true); } catch (e2) {}
      }
      return { slots: [], name: "", cr: null, tr: [] };
    }
  }

  /* 可选的槽位：内置槽去掉用户删掉的 + 用户自建（与 createPoolTab 的 slotNames 同源） */
  function effSlotNames() {
    const e = (_userEdits && _userEdits.slotEdits) || {};
    const deleted = new Set((e.deleted || [])
      .map((x) => (typeof x === "string" ? x : (x && x.name))).filter(Boolean));
    const out = ((meta && meta.slotOrder) ? meta.slotOrder : []).filter((s) => !deleted.has(s));
    (e.custom || []).forEach((c) => {
      const n = c && c.name;
      if (n && out.indexOf(n) < 0) out.push(n);
    });
    return out;
  }
  function slotLabel(s) {
    const r = (_userEdits && _userEdits.slotEdits && _userEdits.slotEdits.renamed) || {};
    return r[s] || s;
  }

  /* 槽位选择器 —— 照抄网页 #slotPickModal 的观感（2026-09-29 用户要求「同步成网页版这个」）：
       头部：把「中文名」从「原槽」移到…  + 「中文名」  英文tag 药丸  +  关闭
       主体：分组标题 + 横排圆角 chip（当前所在槽 = 半透明不可点）
     ⚠️ 原来「移动到其他槽」是用 prompt() 让人**手打槽名**，42 个槽谁记得住。 */
  function openSlotPicker(mode, fromSlot, word, name) {
    const label = name || word;
    const mask = el("div", "pc-peekmask");
    mask.style.display = "flex";
    const win = el("div", "pc-pickwin");

    const head = el("div", "pc-pickhead");
    head.appendChild(el("span", "pc-picktitle", mode === "move"
      ? "把「" + label + "」从「" + slotLabel(fromSlot) + "」移到…"
      : "把「" + label + "」加进…"));
    head.appendChild(el("span", "pc-pickhint", "「" + label + "」  " + word));
    const bClose = el("button", "pc-pickclose", "关闭");
    bClose.onclick = () => mask.remove();
    head.appendChild(bClose);
    win.appendChild(head);

    const body = el("div", "pc-pickbody");
    win.appendChild(body);

    /* 分组：先按内置 SLOT_GROUPS 的顺序，再把用户自建的槽补一个「自建槽位」组 */
    const alive = new Set(effSlotNames());
    const ord = (meta && meta.slotOrder) ? meta.slotOrder : [];
    const groups = ((meta && meta.slotGroups) ? meta.slotGroups : [])
      .map((g) => ({
        name: g.name,
        slots: ord.filter((s) => (g.slots || []).indexOf(s) >= 0 && alive.has(s)),
      }))
      .filter((g) => g.slots.length);
    const inAny = new Set();
    groups.forEach((g) => g.slots.forEach((s) => inAny.add(s)));
    const extra = ord.filter((s) => alive.has(s) && !inAny.has(s))
      .concat(effSlotNames().filter((s) => ord.indexOf(s) < 0));
    if (extra.length) groups.push({ name: "自建槽位", slots: extra });

    groups.forEach((g) => {
      const gd = el("div", "pc-spick-group");
      gd.appendChild(el("div", "pc-spick-head", g.name));
      const wr = el("div", "pc-spick-wrap");
      g.slots.forEach((s) => {
        const isFrom = (s === fromSlot);
        const chip = el("span", "pc-chip" + (isFrom ? " off" : ""), slotLabel(s));
        chip.title = isFrom ? "就是当前所在槽"
          : (mode === "move" ? "移到这里" : "加进这里")
            + (slotLabel(s) !== s ? "（" + s + "）" : "");
        if (!isFrom) chip.onclick = () => { mask.remove(); doPick(mode, fromSlot, s, word); };
        wr.appendChild(chip);
      });
      gd.appendChild(wr);
      body.appendChild(gd);
    });

    mask.appendChild(win);
    document.body.appendChild(mask);
    /* 点遮罩空白处关掉（网页：点 modal-mask 自身关） */
    mask.onclick = (e) => { if (e.target === mask) mask.remove(); };
  }

  async function doPick(mode, fromSlot, target, word) {
    await loadUserEdits();
    const e = _userEdits.slotEdits;
    if (mode === "move" && fromSlot) {
      if (target === fromSlot) return;
      e.added[fromSlot] = e.added[fromSlot] || [];
      const ai = e.added[fromSlot].indexOf(word);
      if (ai >= 0) e.added[fromSlot].splice(ai, 1);        // 是自己加的就直接撤掉
      else {
        e.removed[fromSlot] = e.removed[fromSlot] || [];
        if (e.removed[fromSlot].indexOf(word) < 0) e.removed[fromSlot].push(word);
      }
    }
    e.added[target] = e.added[target] || [];
    if (e.added[target].indexOf(word) < 0) e.added[target].push(word);
    /* 目标槽如果之前被剔过，得把那条撤销，否则「加了又被删」（顺序反了会白干） */
    const ri = (e.removed[target] || []).indexOf(word);
    if (ri >= 0) e.removed[target].splice(ri, 1);
    const okk = await saveUserEdits();
    toast(okk
      ? (mode === "move"
        ? "已把「" + word + "」移到「" + slotLabel(target) + "」"
        : "已把「" + word + "」加进「" + slotLabel(target) + "」")
      : "保存失败", !okk);
    /* ⛔ 2026-10-06 对齐网页：往槽里加词/移动是「改槽池」，**不重抽**（当前这组保持不动），
       只重画槽位计数与预览。（网页同类操作也只 renderSlots，不碰 state.combo） */
    refreshAfterSlotEdit();   // 改完立刻重画 peek + 槽位计数（poolTab 早已废弃）
  }

  /* ⛔ 2026-10-05 修（阿君原话：「在组合结果直接剔除标签没有同步消失掉」）：
     ① 后端 bug：抽词用的 Pool 从来没读 slotEdits ⇒ 剔除保存成功、下次抽词照样出
        （已修在 core.Pool.slot_list —— 见那里的注释）。
     ② 前端行为：网页 removeFromSlot / removeFromAllSlots 改完池子是**立刻把该词从当前
        组合里摘掉**，不是重抽。原来这里叫 `roll()`：即使池子生效了，用户也是看到
        「整组换掉」而不是「这一个词消失」。
     ⇒ 现在统一：改池子 → 立刻把该词从本组摘掉（同步消失），**不重抽**。 */
  function dropFromCurrent(word) {
    const hit = curTags.filter((t) => t.prompt === word);
    if (!hit.length) return false;
    curTags = curTags.filter((t) => t.prompt !== word);
    /* ⚠️ removeSeg 是按「显示文本」(t.out，空格写法) 摘的，所以必须在过滤前把 out 留住 */
    hit.forEach((t) => { curPos = removeSeg(curPos, t.out); });
    if (isLocked(word)) writeLocked(locked.filter((x) => x.prompt !== word));
    markEdited();            // 手删词 → 这组 seed 已复现不出来
    renderResult();
    return true;
  }

  /* ⭐ 2026-10-14 对齐网页 toggleTag：词库/槽位池点一下 →
     在组合里就**移出去**，不在就**加进来**（不是旧版的复制到剪贴板）。
     w 必须带 slot —— 词库区点词不知道槽位时给「自定」空槽，
     槽位池 peek 点词时带所在槽（调用方从闭包传入 w.slot）。 */
  /* ⭐ 2026-10-20（阿君：删了角色、搜索补一个新角色进来，作品名还是原来那个）：
     手动加角色 = 换人，旧角色的「作品」「人物特征」必须跟着换掉。

     ⛔ 别只修一条路径 —— 面板里加词有**三个入口**，全都要走这里：
        ① 词库区/槽位池点词 → toggleCurTag
        ② 搜索框 #pcFind 选中（含「补位」回原位置）→ onPick
        ③ 结果框里打字弹联想 → onPick
     用户报的「搜索添加自动补位」是 ②。
     ⚠️ 只在「组里只剩这一个角色」时动手：
        双人档加第二个人时乱删作品，会把第一个人的作品词也清掉。
     返回 {ok, removed, cr}；**只改 curTags / locked，不碰 curPos** ——
     文本怎么同步由调用方决定（补位要重建、点词要追加）。 */
  async function syncSeriesForCharacter(w) {
    const out = { ok: false, removed: 0, cr: null };
    if (!w || !w.prompt) return out;
    const others = curTags.filter((x) => x.slot === "角色" && x.prompt !== w.prompt);
    if (others.length) return out;     // 双人：不碰，免得清掉别人的作品
    out.ok = true;

    /* ① 清残留：作品 + 人物特征都是角色的附属槽 */
    const gone = curTags.filter((x) => x.slot === "作品" || x.slot === "人物特征");
    if (gone.length) {
      curTags = curTags.filter((x) => x.slot !== "作品" && x.slot !== "人物特征");
      /* 锁着的也要解 —— 否则下次生成又把旧作品拉回来，等于没换 */
      const names = new Set(gone.map((x) => x.prompt));
      if (locked.some((x) => names.has(x.prompt)))
        writeLocked(locked.filter((x) => !names.has(x.prompt)));
      out.removed = gone.length;
    }

    /* ②③ 共用一次反查：cr = 所属作品，tr = 角色标志特征 */
    let inf = null;
    try { inf = await slotInfo(w.prompt); } catch (e) {}
    /* ② 补新作品（后端 cr_resolve 解析，和自动补作品同源），插在角色正后方 */
    const cr = inf && inf.cr;
    if (cr && cr.prompt) {
      const item = {
        prompt: cr.prompt, name: cr.name || cr.prompt, slot: "作品",
        out: outOf(cr.prompt, "作品"),
      };
      const ci = curTags.findIndex((x) => x.prompt === w.prompt && x.slot === "角色");
      if (ci >= 0) curTags = curTags.slice(0, ci + 1).concat([item], curTags.slice(ci + 1));
      else curTags = curTags.concat([item]);
      out.cr = item;
    }
    /* ③ 补新角色的人物特征（⭐ 2026-10-21 阿君：换了角色没同步补上特征）——
       之前只补作品；fang/马耳这类角色标志特征漏了，模型认不出换的是谁。
       tr 来自后端 /pc/slots_of（CHAR_TRAITS 映射，和抽取时强制补特征同源）。
       插在作品词后面：角色, 作品, 特征 才是 danbooru 顺序。 */
    const trs = (inf && inf.tr) || [];
    if (trs.length) {
      const _have = new Set(curTags.map((x) => _nkTag(x.prompt)));
      const adds = [];
      for (let _i = 0; _i < trs.length; _i++) {
        const _tw = trs[_i];
        if (!_tw || !_tw.prompt) continue;
        if (_have.has(_nkTag(_tw.prompt))) continue;
        adds.push({ prompt: _tw.prompt, name: _tw.name || _tw.prompt, slot: "人物特征",
                    out: outOf(_tw.prompt, "人物特征") });
      }
      if (adds.length) {
        let at = curTags.findIndex((x) => x.slot === "作品");
        if (at >= 0) at += 1;
        else {
          at = curTags.findIndex((x) => x.prompt === w.prompt && x.slot === "角色");
          at = at >= 0 ? at + 1 : curTags.length;
        }
        curTags = curTags.slice(0, at).concat(adds, curTags.slice(at));
        out.traits = adds;
      }
    }
    return out;
  }

  /* 加完一个词之后的统一收尾：加的是角色就顺手换作品，返回一句补充说明给 toast。
     三个加词入口共用，别各写一份（漏一条就是「有的地方换、有的地方不换」）。 */
  /* ⭐ 2026-10-20（阿君：结果框里搜到标签却选不进去，而且补不回删掉的槽）：
     结果框选中一个候选之后的统一收尾。pickCombo 已经把词写进文本、面板的 input 监听
     也已经按文本重建过 curTags —— 这里只负责「归位」和「角色换作品」。 */
  async function _comboPick(it) {
    if (!it || !it.prompt) return;
    const p = it.prompt;
    const slot = it.slot || "自定";
    const out = outOf(p, slot);
    let idx = curTags.findIndex((t) => _nkTag(t.prompt) === _nkTag(p));
    let item;
    if (idx >= 0) item = curTags[idx];
    else { item = { prompt: p, name: it.name || p, slot: slot, out: out }; curTags.push(item); idx = curTags.length - 1; }
    item.slot = slot; item.name = it.name || item.name || p; item.out = out;
    curPos = gText.value;
    /* ① 有「刚删掉的同槽空位」⇒ 补回原来的位置（who 一起恢复），文本跟着重排 */
    const vi = slot !== "自定" ? _vacancies.findIndex((v) => v.slot === slot) : -1;
    if (vi >= 0) {
      const v = _vacancies.splice(vi, 1)[0];
      if (v.who !== undefined && v.who !== null) item.who = v.who;
      curTags.splice(idx, 1);
      const at = Math.min(Math.max(0, v.idx), curTags.length);
      curTags = curTags.slice(0, at).concat([item], curTags.slice(at));
      const extra = await _afterAddWord(item);
      curPos = buildPosFromTags(curTags);
      _forceText = true;     /* 补位会把词挪回原来的位置 ⇒ 文本必须重排 */
      markEdited();
      renderResult();
      toast("已补位到「" + slotLabel(slot) + "」：" + (it.name || p) + extra);
      return;
    }
    /* ② 没有空位 ⇒ 插到同槽词的旁边（2026-10-21 前：留在光标处 ⇒ 同槽词被甩到末尾） */
    insertBesideSlot(curTags, item);
    const extra2 = await _afterAddWord(item);
    curPos = buildPosFromTags(curTags); _forceText = true;
    markEdited();
    renderResult();
    toast("已加入：" + (it.name || p) + extra2);
  }

  async function _afterAddWord(item) {
    if (!item || item.slot !== "角色") return "";
    try {
      const sy = await syncSeriesForCharacter(item);
      const _tn = (sy.traits && sy.traits.length) ? "，特征已补 " + sy.traits.length + " 个" : "";
      if (sy.cr) return "，作品已换成「" + (sy.cr.name || sy.cr.prompt) + "」" + _tn;
      if (sy.removed) return "，旧的作品词已移除（这个角色查不到所属作品）" + _tn;
    } catch (e) {}
    return "";
  }

  async function toggleCurTag(w) {
    if (!w || !w.prompt) return;
    const hit = curTags.some((t) => t.prompt === w.prompt);
    if (hit) {
      dropFromCurrent(w.prompt);
      toast("已从本组移出「" + w.prompt + "」（不重抽）");
    } else {
      const slot = w.slot || "";
      /* outOf 而不是 fmtOut —— Anima 模式下画师词要带 @ 前缀 */
      const out = outOf(w.prompt, slot);
      const t = { prompt: w.prompt, name: w.name || w.prompt, slot: slot.length ? slot : "自定", out: out };
      insertBesideSlot(curTags, t);
      /* 追加到提示词文本：已有内容就补分隔符 */
      curPos = curPos ? (curPos.trim() + ", " + out) : out;
      _forceText = true;
      /* 加的是角色 ⇒ 旧角色的作品词/特征词要换掉（否则出现「大和赤骥 + Re:从零」这种同框） */
      let sy = { ok: false, removed: 0, cr: null };
      if (slot === "角色") {
        try { sy = await syncSeriesForCharacter(t); } catch (e) {}
      }
      /* 词的位置变了（插到同槽旁）⇒ 必须重建文本；角色还连带换作品/特征 */
      curPos = buildPosFromTags(curTags);
      markEdited();          // 手加了一个词 → 这组 seed 已复现不出来
      _forceText = true;     /* 同上：从词库加的词必须落进文本框 */
      renderResult();
      let msg = "已加进本组「" + w.prompt + "」（不重抽，对应槽："
        + (slot.length ? slotLabel(slot) : "自定") + "）";
      const _tn = (sy.traits && sy.traits.length) ? "，特征已补 " + sy.traits.length + " 个" : "";
      if (sy.cr) msg += "，作品已换成「" + (sy.cr.name || sy.cr.prompt) + "」" + _tn;
      else if (sy.removed) msg += "，旧的作品词已移除（这个角色查不到所属作品）" + _tn;
      else if (_tn) msg += _tn;
      toast(msg);
    }
    /* ⛔ 2026-10-14：词库区/槽位池的 .sel 高亮要跟着变 —— 否则点完另一处不刷新，
       高亮和组合对不上（用户会以为没点进去）。重画词库和打开中的 peek。 */
    try { if (dictTab && dictTab.refresh) dictTab.refresh(); } catch (e) {}
    try { if (peek) renderPeek(); } catch (e) {}
  }

  /* 从某个槽剔除（自己加的直接撤销，内置词则记进 removed） */
  async function removeWordFromSlot(slot, word) {
    await loadUserEdits();
    const e = _userEdits.slotEdits;
    e.added[slot] = e.added[slot] || [];
    const ai = e.added[slot].indexOf(word);
    if (ai >= 0) e.added[slot].splice(ai, 1);
    else {
      e.removed[slot] = e.removed[slot] || [];
      if (e.removed[slot].indexOf(word) < 0) e.removed[slot].push(word);
    }
    const okk = await saveUserEdits();
    const gone = dropFromCurrent(word);      // 立刻从本组消失（不重抽）
    toast(okk
      ? "已从「" + slotLabel(slot) + "」剔除「" + word + "」" + (gone ? "（已从本组移除）" : "")
      : "保存失败", !okk);
    refreshAfterSlotEdit();   // 改完立刻重画 peek + 槽位计数（poolTab 早已废弃）
  }

  async function toggleBlackWord(word) {
    await loadUserEdits();
    const bl = _userEdits.black = _userEdits.black || [];
    /* ⭐ 2026-11-22：改用「归一化」比对（空格 = 下划线）。
       槽位管理里的「加入封杀」对词库查不到的词会**两种写法一起存**，
       这里若还按原文精确比对，右键同一个词会误判成「还没封」，
       再点一次又加一条，菜单文字也跟着说反。 */
    const _nb = (x) => String(x).toLowerCase().replace(/_/g, " ").trim();
    const key = _nb(word);
    const i = bl.findIndex((y) => _nb(y) === key);
    let msg = "";
    if (i >= 0) {
      /* 同义写法可能存了两条，一起清掉 */
      for (let j = bl.length - 1; j >= 0; j--) if (_nb(bl[j]) === key) bl.splice(j, 1);
      msg = "已恢复「" + word + "」（全局）";
    } else {
      bl.push(word);
      if (bl.length > 50000) bl.length = 50000;
      msg = "已剔除「" + word + "」（任何槽不再出）";
    }
    const okk = await saveUserEdits();
    const gone = dropFromCurrent(word);      // 立刻从本组消失（不重抽）
    toast(okk ? (msg + (gone ? "（已从本组移除）" : "")) : "保存失败", !okk);
    refreshAfterSlotEdit();   // 改完立刻重画 peek + 槽位计数（poolTab 早已废弃）
  }

  /* 词右键菜单（2026-09-29 第二版，对齐网页 attachTagContextMenu）
       · 同时在多个槽 → 每槽一条「从「X」剔除」+「在槽位间移动…」
       · 在某个槽     → 「从「本槽」剔除」+「移动到其他槽…」
       · 哪个槽都不在 → 「➕ 添加到槽位…」
       · 恒定一条「🚫 从所有槽剔除」/「♻ 恢复（全局）」
     ⚠️ 关键：**不能只信调用方传进来的 slot** —— 词库区/全局搜索的词不知道自己在哪个槽，
        必须像网页那样用 slotsOf() 动态反查（用户增删也实时反映）。
     用户原话：「标签词库右键标签怎么没有添加到某槽位选项，网页版的都有」 */
  /* ---- 单标签权重（2026-10-19 阿君：「可以自由给某个标签设置权重」）-------------
     语义与后端 `core.load_weights` + `Pool.pick._wmult` **完全一致**：填的是**倍数**。
       · 1.0 = 默认（等于没设，不会写进文件）
       · 0.3 = 少出现（约 1/3 机会） · 3.0 = 常出现（约 3 倍机会）
       · 钳在 [0.05, 20]，防手滑写 0 / 999 把某个词抽成唯一解
     ⛔ 不要拿 0 表达「不要」—— 那是「从所有槽剔除」（黑名单）的职责，这里 0 会被拒。
     ⚠️ 键归一成「下划线 + 小写」（`full_body`），因为词典里 prompt 有带空格的写法，
        后端 load_weights 用的也是这套归一，两边不同形就查不到。 */
  const WEIGHT_MIN = 0.05, WEIGHT_MAX = 20;
  function wkey(w) { return String(w || "").replace(/ /g, "_").toLowerCase(); }
  function weightOf(word) {
    const W = (_userEdits && _userEdits.weights) || {};
    const v = W[wkey(word)];
    return (typeof v === "number" && isFinite(v) && v > 0) ? v : 1;
  }
  async function setWordWeight(word, cnName) {
    if (!_userEdits) { try { await loadUserEdits(); } catch (e) {} }
    await loadUserEdits();
    const W = _userEdits.weights = _userEdits.weights || {};
    const k = wkey(word);
    const cur = weightOf(word);
    const v = prompt(
      "给「" + (cnName ? cnName + " / " : "") + word + "」设置出现权重（倍数）\n\n" +
      "  1    = 默认\n" +
      "  0.3 = 少出现（约 1/3 机会）\n" +
      "  3   = 常出现（约 3 倍机会）\n\n" +
      "范围 " + WEIGHT_MIN + " ~ " + WEIGHT_MAX + "；留空 = 恢复默认。\n" +
      "（想让它完全不出，请用「从所有槽剔除」——这里填 0 无效）",
      String(cur)
    );
    if (v === null) return;
    const t = String(v).trim();
    let msg;
    if (!t) {
      delete W[k];
      msg = "「" + word + "」权重恢复默认";
    } else {
      const f = Number(t);
      if (!isFinite(f) || f <= 0) { toast("权重要是大于 0 的数字（" + WEIGHT_MIN + " ~ " + WEIGHT_MAX + "）"); return; }
      const c = Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, f));
      const def = Math.abs(c - 1) < 1e-9;
      if (def) delete W[k]; else W[k] = c;
      msg = "「" + word + "」权重 = " + (def ? "默认（1）" : c) + (c !== f ? "（已钳到 " + c + "）" : "");
    }
    const okk = await saveUserEdits();
    /* ⛔ 与「剔除 / 移动」一致：改配置**不重抽**当前这组，只影响以后抽取 */
    toast(okk ? msg + "，下次抽取生效" : "保存失败");
  }

  /* ---- 提示词权重（2026-10-19 阿君纠正：「是标签在提示词里的权重」）-------------
     跟上面的「抽取频率」是**两件完全不同的事**：
       · 抽取频率 = 抽不抽得到 / 抽得多不多（改概率，输出文字不变）
       · 提示词权重 = 抽到之后，在提示词里写成 `(tag:1.5)`（改模型注意力，概率不变）
     语义与后端 `core.load_prompt_weights` + `wrap_prompt_weight` 完全一致：
       · 1.0 = 默认 → **不加括号**，输出跟没这功能一模一样
       · >1 = 加强（1.2 / 1.5 / 2 常见） · <1 = 削弱（0.8 / 0.6 常见）
       · 钳在 [0.1, 3.0]：低于 0.1 模型当没写，高于 3 容易烧糊
     ⚠️ 键同样归一成下划线小写；后端 prompt_weight_of 用的也是这套。 */
  const PW_MIN = 0.1, PW_MAX = 3.0;
  function pwOf(word) {
    const W = (_userEdits && _userEdits.promptWeights) || {};
    const v = W[wkey(word)];
    return (typeof v === "number" && isFinite(v) && v > 0) ? v : 1;
  }
  async function setPromptWeight(word, cnName) {
    if (!_userEdits) { try { await loadUserEdits(); } catch (e) {} }
    await loadUserEdits();
    const W = _userEdits.promptWeights = _userEdits.promptWeights || {};
    const k = wkey(word);
    const cur = pwOf(word);
    const v = prompt(
      "给「" + (cnName ? cnName + " / " : "") + word + "」设置**提示词权重**\n\n" +
      "抽到它时会写成 (" + word + ":倍数) 这种强调括号。\n\n" +
      "  1    = 默认（不加括号）\n" +
      "  1.5  = 加强\n" +
      "  0.8  = 削弱\n\n" +
      "范围 " + PW_MIN + " ~ " + PW_MAX + "；留空 = 恢复默认。\n" +
      "示例：1.5 → (" + word + ":1.5)",
      String(cur)
    );
    if (v === null) return;
    const t = String(v).trim();
    let msg;
    if (!t) {
      delete W[k];
      msg = "「" + word + "」提示词权重恢复默认";
    } else {
      const f = Number(t);
      if (!isFinite(f) || f <= 0) { toast("权重要是大于 0 的数字（" + PW_MIN + " ~ " + PW_MAX + "）"); return; }
      const c = Math.max(PW_MIN, Math.min(PW_MAX, f));
      const def = Math.abs(c - 1) < 1e-9;
      if (def) delete W[k]; else W[k] = c;
      msg = def ? ("「" + word + "」提示词权重 = 默认（不加括号）")
                : ("「" + word + "」提示词权重 = (" + word + ":" + c + ")"
                   + (c !== f ? "（已钳到 " + c + "）" : ""));
    }
    const okk = await saveUserEdits();
    /* ⛔ 不重抽：当前这组保持不动，下一组抽到时才带括号 */
    toast(okk ? msg + "，下一组抽到它时生效" : "保存失败");
  }

  async function showWordMenu(x, y, word, slot) {
    if (!_userEdits) { try { await loadUserEdits(); } catch (e) {} }
    const items = [];
    let dyn = [];
    let cnName = "";
    try { const inf = await slotInfo(word); dyn = inf.slots; cnName = inf.name; }
    catch (e) { dyn = []; }
    let cur = slot && dyn.indexOf(slot) >= 0 ? slot : (dyn.length ? dyn[0] : "");

    if (dyn.length > 1) {
      dyn.forEach((s) => items.push({
        icon: "🗑", label: "从「" + slotLabel(s) + "」剔除", danger: true,
        title: "只从这个槽的池子里剔掉，词库照样能搜到",
        fn: () => removeWordFromSlot(s, word) }));
      items.push({ icon: "⇄", label: "在槽位间移动…",
        fn: () => openSlotPicker("move", cur, word, cnName) });
    } else if (cur) {
      items.push({
        icon: "🗑", label: "从「" + slotLabel(cur) + "」剔除", danger: true,
        title: "只从这个槽的池子里剔掉，词库照样能搜到",
        fn: () => removeWordFromSlot(cur, word) });
      items.push({ icon: "⇄", label: "移动到其他槽…", title: "从这个槽挪到另一个槽",
        fn: () => openSlotPicker("move", cur, word, cnName) });
    } else {
      items.push({ icon: "➕", label: "添加到槽位…", title: "这个词还没被任何槽收录",
        fn: () => openSlotPicker("add", "", word, cnName) });
    }

    /* 归一化判断（空格 = 下划线）——与 toggleBlackWord 保持一致，见那边的注释 */
    const _bkCtx = (x) => String(x).toLowerCase().replace(/_/g, " ").trim();
    const inBlack = !!(_userEdits
      && (_userEdits.black || []).some((y) => _bkCtx(y) === _bkCtx(word)));
    items.push(inBlack
      ? { icon: "♻", label: "恢复「" + word + "」（全局）", fn: () => toggleBlackWord(word) }
      : { icon: "🚫", label: "从所有槽剔除", danger: true,
          title: "加进全局剔除，以后任何槽都不出", fn: () => toggleBlackWord(word) });

    /* ⭐ 2026-10-19：两种权重，名字必须写清是哪一个：
       · 抽取频率 = 影响「抽得多不多」（不改输出文字）
       · 提示词权重 = 影响「写成 (tag:1.5)」（不改抽取概率） */
    const _cw = weightOf(word);
    items.push({
      icon: "⚖",
      label: "抽取频率…",
      hint: _cw === 1 ? "" : "×" + _cw,
      title: "这个标签被抽中的概率倍数：1 = 默认，0.3 = 少出现，3 = 常出现（范围 " + WEIGHT_MIN + "~" + WEIGHT_MAX + "）",
      fn: () => setWordWeight(word, cnName),
    });
    const _pw = pwOf(word);
    items.push({
      icon: "🔆",
      label: "提示词权重…",
      hint: _pw === 1 ? "" : ":" + _pw,
      title: "抽到它时写成 (" + word + ":倍数)，影响模型注意力：1.5 = 加强，0.8 = 削弱（范围 " + PW_MIN + "~" + PW_MAX + "）",
      fn: () => setPromptWeight(word, cnName),
    });

    /* ⭐ 2026-10-05 补（对齐网页 attachTagContextMenu 的同名项）：
       「从本组移除」＝ 只把这一组里的它拿掉，**不动池子、不重抽**。
       ⚠️ 只在它确实在当前组合里时才给 —— 否则点了毫无反应，用户以为坏了（网页原注释）。 */
    if (curTags.some((t) => t.prompt === word)) {
      items.push({ icon: "✂", label: "从本组移除", title: "只从当前这一组拿掉，不影响以后抽取",
        fn: () => { if (dropFromCurrent(word)) toast("已从本组移除「" + word + "」"); } });
    }

    /* ⭐ 2026-10-19（阿君：「喜欢的角色或者某个标签能不能也收藏」）：
       单词收藏。原来只有「整组收藏」，喜欢一个角色却得先抽到一整组再收藏，
       下次想用还得翻组找。放菜单第一项 —— 这是最常用的动作。 */
    const _hasFav = isWordFav(word);
    items.unshift(_hasFav
      ? { icon: "★", label: "取消收藏这个标签",
          title: "从「★ 收藏夹」的单词收藏里移除", fn: () => toggleWordFav(word, cnName, cur) }
      : { icon: "☆", label: "收藏这个标签",
          title: "收进「★ 收藏夹」，以后点一下就能锁进任意组合",
          fn: () => toggleWordFav(word, cnName, cur) });

    popMenu(x, y, items);
    const m = document.querySelector(".pc-ctxmenu");
    if (m) m.appendChild(el("div", "pc-ctxword", word));
  }

  /* 兼容旧调用（只给「从所有槽剔除」的那版）—— 现在统一走 showWordMenu */
  function showCtxMenu(x, y, word) {
    showWordMenu(x, y, word, "");
  }

  /* 槽位上的 ⚙ 菜单（对齐网页：重命名 / 预览 / 还原该槽改动 / 删除槽位） */
  function showSlotMenu(x, y, slot) {
    const se = (_userEdits && _userEdits.slotEdits) || {};
    const nRm = ((se.removed || {})[slot] || []).length;
    const nAdd = ((se.added || {})[slot] || []).length;
    const isCustom = ((se.custom || [])).some((c) => c.name === slot);
    const items = [
      { icon: "✏️", label: "重命名「" + slot + "」…", fn: async () => {
          await loadUserEdits();
          const cur = _userEdits.slotEdits.renamed[slot] || slot;
          const v = prompt("把「" + slot + "」显示成什么名字？\n（留空恢复原名）", cur);
          if (v === null) return;
          if (!v.trim()) delete _userEdits.slotEdits.renamed[slot];
          else _userEdits.slotEdits.renamed[slot] = v.trim();
          const okk = await saveUserEdits();
          gCount.textContent = okk ? "已改名" : "保存失败";
          renderGen();
        } },
      { icon: "👁", label: "预览该槽位标签", fn: () => openSlotPeek(slot) },
      { icon: "♻️", label: "还原「" + slot + "」的改动",
        hint: "（剔 " + nRm + " / 加 " + nAdd + "）",
        title: "把这个槽的剔除/添加记录清掉，恢复成词库原样",
        fn: async () => {
          await loadUserEdits();
          const s2 = _userEdits.slotEdits;
          if (s2.removed) delete s2.removed[slot];
          if (s2.added) delete s2.added[slot];
          if (s2.renamed) delete s2.renamed[slot];
          const okk = await saveUserEdits();
          gCount.textContent = okk ? "已还原「" + slot + "」的改动" : "保存失败";
          renderGen();
          /* ⛔ 2026-10-06 对齐网页：还原槽位改动 = 改槽池，**不重抽** */
          refreshAfterSlotEdit();   // 改完立刻重画 peek + 槽位计数（poolTab 早已废弃）
        } },
      { icon: "🗑", label: "删除槽位「" + slot + "」", danger: true,
        fn: async () => {
          if (!confirm("把「" + slot + "」从界面移除？\n（词库不动，可在「槽位管理 → 删除槽位」里恢复）")) return;
          await loadUserEdits();
          const s2 = _userEdits.slotEdits;
          /* ⭐ 2026-10-06 与弹窗里的删除保持一致：**自建槽也进「已删除」列表**（带 custom 标记），
             否则删了就彻底没痕迹 —— 恢复不回来、也不出现在「我改过的地方」里。 */
          if (isCustom) s2.custom = (s2.custom || []).filter((c) => c.name !== slot);
          const dl2 = (s2.deleted = s2.deleted || []);
          if (!dl2.some((o) => ((o && o.name) || o) === slot)) {
            let grp2 = "自定义";
            ((meta && meta.slotGroups) || []).forEach((g) => { if ((g.slots || []).indexOf(slot) >= 0) grp2 = g.name; });
            dl2.push({ name: slot, group: grp2, custom: !!isCustom });
          }
          const okk = await saveUserEdits();
          gCount.textContent = okk ? "已移除槽位「" + slot + "」" : "保存失败";
          renderGen();
          /* ⛔ 2026-10-06 对齐网页：删槽位 = 改配置，**不重抽**（当前这组保持不动） */
          refreshAfterSlotEdit();   // 改完立刻重画 peek + 槽位计数（poolTab 早已废弃）
        } },
    ];
    popMenu(x, y, items);
  }

  /* ---- 顶栏 / 结果区按钮 ---- */
  const q = (sel) => wrap.querySelector(sel);
  q("#pcGRoll").onclick = async () => {
    /* ⛔ 2026-11-22 修（上一版这里写反了）：原来点「组合生成」是**清掉**豁免，
       于是「挑好一组 → 点运行」中间被「每次随机」又换了一次 seed，
       相当于白挑 —— 正好踩碎本项目最核心的那条契约「面板显示什么，出图就是什么」。
       正确顺序：先抽，抽完就把下一次运行锁在这组上（豁免只吃一次，
       再点第二次运行才换新的）。 */
    rollSeed();
    try { await roll(); } catch (e) {}
    try { node._pcKeepSeedOnce = true; } catch (e) {}
  };
  /* ⭐ 2026-10-08（阿君要的②）：按填进来的 seed 复现那一组标签。
     典型用法：出图后从 PNG 信息里读到组合 seed → 填进来 → 点复现 → 原样还原那组词。
     ⛔ 2026-10-19（阿君：复现没复现成功）：光是 setW("seed", v) 不够 ——
        ComfyUI 给 seed 自动挂的「生成后控制」若是 randomize，**排队时会把 seed 换掉**，
        所以复现/出图永远对不上。这里先把那个控件钉成 fixed 再抽。 */
  q("#pcGReplay").onclick = async () => {
    const inp = wrap.querySelector("#pcGSeedIn");
    const raw = String((inp && inp.value) || "").trim();
    /* 支持 `386570@极简`：seed + 档位写在一串里（换机器/换记事本都不丢） */
    const _tok = parseSeedToken(raw);
    const v = Number(_tok.seed);
    if (!_tok.seed || !Number.isFinite(v) || v < 0) {
      toast("先填一个 seed（整数，或 386570@极简 这种带档位的写法）再点「复现」");
      if (inp) inp.focus();
      return;
    }
    try { pinSeedControl(node); } catch (e) {}
    /* 跨工作流的快照存在服务端 ⇒ 本面板可能还没拉过，先确保有一份最新的。
       （不 force：已经加载过就用内存里的，避免每次复现都打一次请求） */
    if (!_userEdits) { try { await loadUserEdits(); } catch (e) {} }
    /* ⭐ 2026-10-19：如果这个 seed 是**本机生成过的**，连当时的槽位表 / 性别 / 档位 /
       锁定 / 开关一起还原 —— 否则用户在这之间改过任何一项，seed 一样也复现不出同一组。
       查找顺序（阿君「换工作流复制 seed」踩坑后补的）：
         ① 本节点历史 hist —— 最近 200 组，最准
         ② user_edits.json 的 seedParams —— **跨工作流 / 跨节点共享**的那份
         ③ 都没有 ⇒ 只能用当前配置，明确告诉用户结果必然不同
       ⛔ ②是必须的：hist 是每个节点实例一份的内存数组，A 工作流的 seed B 工作流看不见。 */
    const h = hist.find((x) => x.seed === v && x.params);
    let _p = h ? h.params : null;
    let _src = h ? "hist" : "";
    if (!_p && _userEdits && _userEdits.seedParams) {
      const g = _userEdits.seedParams[String(v)];
      if (g && typeof g === "object") { _p = g; _src = "store"; }
    }
    let restored = false;
    /* ③ 这台机器完全没记录，但用户抄来的这串自带档位 —— 至少档位是对的。
       （没记录 = 不知道当时的槽位/锁定/开关，但「档位」本来就是最容易搞错的那一项） */
    let _tokPreset = "";
    if (!_p && _tok.preset) {
      _tokPreset = _tok.preset;
      try { setW("preset", _tokPreset); renderGen(); restored = true; } catch (e) {}
    } else if (_p) {
      restored = restoreParams(_p);
    }
    setW("seed", v);
    _pinned = false;              // 复现 = 让 seed 说了算，先解除手改固定
    syncPin();
    /* ⛔ 别在这里 toast 说明 —— roll() 内部最后会 toast「已生成 N 个标签的组合」，
       把这条说明盖掉，用户根本看不到。所以等 roll 完成后再写到统计行上。 */
    _replaying = true;            // 这轮产物不准写进 seedParams（会覆盖真正的原产地）
    roll().then(() => {
      _replaying = false;
      if (restored && _src === "store") {
        gCount.textContent = "已复现 seed " + v + " · 已还原为「"
          + (_p.preset || "?") + "」档（" + (_p.slotsN || 0) + " 个槽位）";
      } else if (restored && _src === "hist") {
        gCount.textContent = "已复现 seed " + v + "（连同当时的 " + (_p.slotsN || 0)
          + " 个槽位与开关一起还原）";
      } else if (_tokPreset) {
        gCount.textContent = "已复现 seed " + v + " · 按你抄的这串切回「" + _tokPreset
          + "」档（这台机器没当时那组的槽位记录，用的是该档默认槽位）";
      } else {
        gCount.textContent = "已按 seed " + v + " 复现 · 用的是「当前」槽位与开关"
          + "（这台机器没生成过这个 seed，若期间改过配置，结果会不同）";
      }
    }).catch(() => { _replaying = false; });
    /* 复现后档位可能刚被切过 ⇒ 提示条要跟着更新（否则还挂着刚才那句警告） */
    setTimeout(() => { try { window.__pcUpdateSeedHint?.(); } catch (e) {} }, 0);
    /* ⭐ 2026-11-22：刚复现完 ⇒ 下一次点「运行」**不许**被「每次随机」换掉 seed，
       否则用户填 seed → 点复现 → 点运行，出图的又是另一组（等于白复现）。
       一次性豁免，跑完这一次就失效。 */
    node._pcKeepSeedOnce = true;
  };
  /* 输入框里敲回车 = 点「复现」（少点一次鼠标） */
  q("#pcGSeedIn").onkeydown = (e) => { if (e.key === "Enter") q("#pcGReplay").onclick(); };

  /* ===== seed 归属提示（2026-10-19 阿君核心诉求）=====
     「我在立绘档位粘极简的 seed，出来的词不一样，
       你不告诉我要切回极简，那我不就一直不知道了？」
     ⇒ 粘进输入框的**那一刻**就查这个 seed 原来属于哪个档位：
         · 档位不同 → 橙色警告，直说「原档位是极简，点复现会自动切回去」
         · 档位相同 → 绿色，说明可直接复现
         · 没记录   → 灰色，说明这台机器没生成过，只能按当前配置
     ⚠️ 别做成「点复现才提示」—— 那时候词已经抽错了，用户白等一轮。 */
  /* seed 可以**自带档位**：`386570@极简`。
     为什么需要它：光靠「这台机器有没有记录过」是靠不住的 ——
       · 换台电脑、别人拿到的 seed、旧版本生成的、500 条被淘汰的，都查不到档位；
       · 而阿君原话是「我自己也不记得是什么档位的」—— 记不住才是常态。
     把档位跟 seed 写成一串存着，抄到哪儿都不丢，换机器也照样还原。
     纯数字照旧支持（向后兼容，老习惯不用改）。 */
  function parseSeedToken(v) {
    const s = String(v || "").trim().replace(/＠/g, "@");
    if (!s) return { seed: "", preset: "" };
    const at = s.indexOf("@");
    if (at < 0) return { seed: /^\d+$/.test(s) ? s : "", preset: "" };
    const a = s.slice(0, at).trim(), b = s.slice(at + 1).trim();
    return { seed: /^\d+$/.test(a) ? a : "", preset: b };
  }
  function lookSeed(v) {
    const tok = parseSeedToken(v);
    const s = tok.seed;
    if (!s) return null;
    /* ① 本节点历史优先（同一节点里刚抽的，最准） */
    const h = hist.find((x) => String(x.seed) === s && x.params);
    if (h) return { preset: h.params.preset || "", slotsN: h.params.slotsN || 0, src: "hist" };
    /* ② 跨工作流共享快照（后端 nodes.run 也会写，跨机器重启不丢） */
    const g = _userEdits && _userEdits.seedParams && _userEdits.seedParams[s];
    if (g && typeof g === "object")
      return { preset: g.preset || "", slotsN: g.slotsN || 0, src: "store" };
    /* ③ 没记录，但用户抄的这串自带档位 —— 也算「知道」 */
    if (tok.preset) return { preset: tok.preset, slotsN: 0, src: "token" };
    return null;
  }
  /* 「一切正常」这条只报一句、2.2 秒后自己收起（2026-10-20 阿君：
     「这段提示可以不用或者改得更简洁一点，并且不用一直显示」）。
     ⛔ 只给绿色那档加自动收起 —— 橙色（档位不一致）和灰色（查不到）
        是**必须看见**的，收起来等于又回到"用户不知道"的老问题。 */
  let _hintTimer = null;
  function updateSeedHint() {
    const el = q("#pcGSeedHint");
    if (!el) return;
    if (_hintTimer) { clearTimeout(_hintTimer); _hintTimer = null; }
    const raw = String((q("#pcGSeedIn") || {}).value || "").trim();
    if (!raw) { el.className = "pc-seedhint"; el.textContent = ""; return; }
    const tok = parseSeedToken(raw);
    if (!tok.seed) {
      el.className = "pc-seedhint miss on";
      el.textContent = "只认整数 seed，或 386570@极简 这种写法";
      return;
    }
    const s = tok.seed;
    /* ⚠️ 传 raw 不是 s：lookSeed 要能看到 "@档位" 那一段 */
    const info = lookSeed(raw);
    const cur = String(wval("preset", "") || "");
    if (!info) {
      /* ⛔ 这里必须说实话：查不到就是查不到，不能让用户以为能复现。 */
      el.className = "pc-seedhint miss on";
      el.textContent = "seed " + s + " 没记录过，查不到原档位 · 只能用当前「"
        + (cur || "?") + "」档，可能对不上";
      return;
    }
    const p = info.preset || "（未记录）";
    if (p && cur && p !== cur) {
      el.className = "pc-seedhint warn on";
      el.textContent = "⚠ 这是「" + p + "」档的 seed"
        + (info.slotsN ? "（" + info.slotsN + " 个槽位）" : "")
        + "，你现在是「" + cur + "」档，直接跑会出另一组词 · 点「复现」会自动切回";
    } else {
      el.className = "pc-seedhint ok on";
      el.textContent = "✓ 「" + p + "」档 · 可原样复现";
      _hintTimer = setTimeout(() => {
        el.className = "pc-seedhint";
        el.textContent = "";
        _hintTimer = null;
      }, 2200);
    }
  }
  const _seedIn = q("#pcGSeedIn");
  if (_seedIn) {
    _seedIn.addEventListener("input", updateSeedHint);
    _seedIn.addEventListener("paste", () => setTimeout(updateSeedHint, 0));
    _seedIn.addEventListener("change", updateSeedHint);
  }
  /* 切档位时也要重算 —— 从立绘切到极简，上面那条警告要跟着消失 */
  const _presetW = W("preset");
  if (_presetW) {
    const _oldCb = _presetW.callback;
    _presetW.callback = function () {
      try { _oldCb?.apply(this, arguments); } catch (e) {}
      setTimeout(updateSeedHint, 0);
    };
  }
  window.__pcUpdateSeedHint = updateSeedHint;
  /* ⛔ 2026-09-29 用户要求删掉「一键复制 / 复制中文」两个按钮
     （原话：「既然都能直接输出组合结果了，那这里 2 个复制按钮也可以不要了」）。
     连带「编辑句式」按钮和它的中文句式模板弹窗一起删 —— 那个模板只服务于「复制中文」。
     ⚠️ 按钮删了**对应的 onclick 也必须删**：`q("#pcGCopy")` 会返回 null，
        给 null 赋 onclick 直接抛 TypeError，把后面所有初始化全带崩。
     旧实现见 git 历史（pcGCopy / pcGCopyCn / pcGEditTpl / pc-tplmask / buildCnText）。 */
  q("#pcGClear").onclick = () => {
    curTags = []; curPos = ""; gText.value = "";
    try { setW("panel_state", ""); } catch (e) {}   // 清空 = 连"上次显示的那组"一起清
    try { sessionStorage.removeItem(_ssKey()); } catch (e) {}   // 同上：镜像也要清
    writeLocked([]);          // 清空 = 全部解锁（照网页 btnClear：state.locked.clear()）
    /* 清空后 pinned_prompt 本来就该是空（空文本唯一能表达的就是「空」），
       顺手把固定标记复位，免得 seed 徽章一直挂着「已手改」。 */
    _pinned = false; syncPin();
    /* ⭐ 2026-11-22：清空 =「这组我不要了」⇒ 之前攒下的「下次运行别换 seed」豁免也作废，
       下次点运行就该给新的。 */
    try { node._pcKeepSeedOnce = false; } catch (e) {}
    renderResult();
  };
  /* ❓ 帮助卡开关（2026-10-14）：手动展开/收起，不自动弹 */
  {
    const hb = q("#pcGHelpBox");
    if (q("#pcGHelp") && hb) q("#pcGHelp").onclick = () => {
      hb.style.display = (hb.style.display === "none") ? "" : "none";
    };
    if (q("#pcGHelpClose") && hb) q("#pcGHelpClose").onclick = () => { hb.style.display = "none"; };
  }
  /* ⛔ 2026-10-06 对齐网页：chipQuality / chipSpace / chipNsfw 都是**改配置不抽词**
     （网页实测：切完结果区不变，要新结果自己点「组合生成」）。 */
  /* 2026-10-18（阿君报）：从 curTags 重建提示词文本时，**必须保留多人分行**。
     原来 syncQualityWords 直接 `next.map(t => t.out).join(", ")` ——
     一开「固定画质词」，双人档按人分行的结构就被抹平成一坨了。
     规则与 core.fmt_prompt 一致：靠 who 变化切行（who=null 的连续段算同一行）。 */
  function buildPosFromTags(list) {
    const hasWho = list.some((t) => t.who !== undefined && t.who !== null);
    let body;
    if (!hasWho) body = list.map((t) => t.out).join(", ");
    else {
      const lines = [];
      let cur = [], key = "__init__";
      for (const t of list) {
        const k = (t.who === undefined ? null : t.who);
        if (k !== key) {
          if (cur.length) lines.push(cur);
          cur = [];
          key = k;
        }
        cur.push(t.out);
      }
      if (cur.length) lines.push(cur);
      body = lines.map((l) => l.join(", ")).join("\n");
    }
    /* ⭐ 2026-10-21（真机抓到：删角色再补一个新角色，开头那串 masterpiece 全没了）：
       画质词是**后端**拼进 positive 的、**不在 curTags 里**（节点没有「固定画质」槽），
       所以按标签重建文本必然把它们丢掉 —— 出图质量直接掉一档。
       这里按 meta.quality 把前缀补回去；已经带前缀的就不重复加。 */
    try {
      if (!wval("add_quality", true)) return body;
      const Q = (meta && meta.quality) || [];
      if (!Q.length) return body;
      const head = String(body).split(/[\n,]/)[0].trim();
      if (Q.some((w) => w === head)) return body;
      return Q.join(", ") + ", " + body;
    } catch (e) { return body; }
  }

  /* 画质词进/出当前组合（2026-10-17 阿君报「开固定画质词提示词没同步、关了也没消失」）。
     原因：画质词是**后端**在 /pc/preview 里拼到 positive 最前面的，面板自己也把
     FIXED_QUALITY 当特例；而 #pcGQuality 原来只改 widget + renderGen()，
     从头到尾没碰 curTags / curPos ⇒ 文本当然不动。
     这里直接改当前这组：开 → 把这几个词插到最前；关 → 全部摘掉。不重抽。 */
  function syncQualityWords(on) {
    const Q = (meta && meta.quality) || [];
    /* ⛔ 2026-10-18 修：原来用 `had = curTags 里有没有固定画质槽` 做提前返回，
       但**生成时后端只把画质拼进 positive，不往 tags 里塞** ⇒ had 永远是 false。
       于是「画质开着时点关」会被 `!!on === had` 命中而直接 return，文本里的画质词摘不掉。
       改成：以 curTags 为准**无条件重建**（先摘旧画质，再按开关决定是否插入），幂等且不会重复。 */
    let next = curTags.filter((t) => t.slot !== "固定画质");
    if (on && Q.length) {
      next = Q.map((p) => ({ prompt: p, name: p, slot: "固定画质", out: outOf(p, "固定画质") }))
              .concat(next);
    }
    curTags = next;
    curPos = buildPosFromTags(next);   // 2026-10-18：保留多人分行，别用扁平 join
    /* ⭐ 2026-10-21（阿君：全新一组只是开关了下画质词按钮，就变成「新一组/已手改」）：
       开关画质词是**参数**变化（add_quality 本来就在参数快照里），seed 依旧能复现
       （复现时参数一起还原）⇒ 不算手改：不换 seed、不追加历史、不标「已手改」。
       旧注释担心的「点运行被 seed 重抽抹掉开关效果」不成立 —— 节点重算用的就是
       当前 add_quality 开关，画质词跟着开关走，两边一致。
       只有本来就处于手改态的组，才顺手更新当前历史条目（别丢画质词状态）。 */
    if (_pinned) {
      const h = hist[histIdx];
      if (h) { h.tags = curTags.slice(); h.pos = curPos; }
    }
    syncPin();
    _forceText = true;
    try { _savePanelState(); } catch (e) {}
    renderResult();
  }

  /* ⭐ 2026-11-22（阿君要的「每次运行随机抽一次」）：只改记忆开关，不动 seed ——
     关掉时保持当前 seed 不变，跑几次都是同一组（老行为）。
     ⚠️ 记忆存在浏览器里（localStorage），不是节点控件：节点控件按位置序列化，
        中间插一个布尔值会让所有老工作流的 widgets_values 错位。 */
  q("#pcGAutoRand").onclick = () => {
    const nv = !autoRandOn();
    setAutoRandOn(nv);
    q("#pcGAutoRand").classList.toggle("on", nv);
    toast(nv
      ? ("已开启：以后每点一次「运行/队列」会自动换一组词。"
         + "这次用的 seed 会显示在下面结果区，点一下就能复制 —— 留着它，哪天想找回这组词，"
         + "填进「seed 或 386570@极简」那个框里点「复现」就行。")
      : "已关闭：seed 不再自动换，跑几次都是同一组词（想换就点「组合生成」）。");
  };
  q("#pcGQuality").onclick = () => {
    const nv = !wval("add_quality", true);
    setW("add_quality", nv);
    syncQualityWords(nv);          // ⭐ 立刻同步当前提示词（不等重抽）
    renderGen();
    toast(nv ? "固定画质词已加入当前提示词" : "固定画质词已从当前提示词移除");
  };
  q("#pcGSpace").onclick = () => {
    const nv = !wval("space_out", true);
    setW("space_out", nv);
    /* 写法立刻跟着变（对齐网页 chipSpace → renderCombo）：按 prompt 原值重算显示文本。
       ⚠️ 必须**倒序**替换 —— 正序改长度会让后面标签的下标全错位。 */
    const edits = [];
    curTags.forEach((t) => {
      const no = outOf(t.prompt, t.slot);
      if (no === t.out) return;
      const i = curPos.indexOf(t.out);
      if (i >= 0) edits.push([i, t.out.length, no]);
      t.out = no;
    });
    edits.sort((a, b) => b[0] - a[0]);
    edits.forEach((e) => { curPos = curPos.slice(0, e[0]) + e[2] + curPos.slice(e[0] + e[1]); });
    renderGen();
    syncPin();     // 已手改过的话，钉住的文本也要跟着换成新写法
    renderResult();
    toast(nv ? "输出已切换为空格写法" : "输出已切换为下划线写法");
  };
  /* Anima 模式（2026-10-15）：@ 画师前缀。逻辑照抄上面的 pcGSpace ——
     改配置后立刻重算当前这组的显示文本，不必重抽。 */
  q("#pcGCross").onclick = () => {
    const nv = !wval("cross_series", false);
    setW("cross_series", nv);
    const chip = q("#pcGCross");
    chip.classList.toggle("on", !nv);                   // 亮 = 同作品
    chip.textContent = nv ? "跨作品" : "同作品";
    toast(nv ? "跨作品：两名角色可以来自不同作品" : "同作品：两人一定来自同一作品");
  };
  q("#pcGAnima").onclick = () => {
    const nv = !wval("anima_mode", false);
    setW("anima_mode", nv);
    const edits = [];
    curTags.forEach((t) => {
      const no = outOf(t.prompt, t.slot);
      if (no === t.out) return;
      const i = curPos.indexOf(t.out);
      if (i >= 0) edits.push([i, t.out.length, no]);
      t.out = no;
    });
    edits.sort((a, b) => b[0] - a[0]);
    edits.forEach((e) => { curPos = curPos.slice(0, e[0]) + e[2] + curPos.slice(e[0] + e[1]); });
    renderGen();
    syncPin();     // 同上：已钉住的文本要跟着重算 @ 前缀
    renderResult();
    toast(nv ? "Anima 模式已开启（画师标签写成 @画师名）" : "已回到常规模式（画师标签不带 @）");
  };
  /* ⭐ 2026-11-25：只出 NSFW 开关。与 NSFW过滤互斥 —— 打开它时过滤自动关掉 */
  q("#pcGNsfwOnly").onclick = () => {
    const nv = !wval("nsfw_only", false);
    setW("nsfw_only", nv);
    if (nv) setW("nsfw_filter", false);      // 只出 NSFW 时，过滤必须关，否则两边打架
    renderGen();
    refreshSlotPools();
    toast(nv ? "只出 NSFW：泳装/服装/姿势/互动只抽涩涩词（发型表情光照照常）" : "已恢复按 NSFW过滤 走");
  };
  q("#pcGNsfw").onclick = () => {
    const nv = !wval("nsfw_filter", true);
    setW("nsfw_filter", nv);
    if (nv) setW("nsfw_only", false);        // 开过滤就自动关掉「只出NSFW」
    renderGen();
    refreshSlotPools();          // 池子大小随 NSFW 过滤变，顺手刷新各槽词数
    toast(nv ? "NSFW 过滤已开启（隐藏涩涩/血腥标签）" : "NSFW 过滤已关闭（显示全部标签）");
  };
  /* 自动补作品（2026-10-11）：与其它开关一致 —— 只改配置、不重抽，
     下一组/真跑工作流时生效。 */
  /* 细节联动（2026-10-13）：与自动补作品同款 —— 只改配置、不重抽，下次抽取生效 */
  q("#pcGBoost").onclick = () => {
    const nv = !wval("auto_boost", true);
    setW("auto_boost", nv);
    renderGen();
    toast(nv ? "细节联动已开启（抽到折扇会带上拿着扇子、婚纱带头纱）" : "细节联动已关闭");
  };

  /* ---- 穿搭方案（4 态循环）----
     ⚠️ 不改后端：core.py 本来就是「按哪些槽开着」推穿搭（dress/sep/swim/auto），
        所以这里只要改槽位开关就行 —— 所见即所得。
        · 自动     → 上装 / 下装 / 连衣裙与制服 三个都开（抽词时内部二选一）
        · 连衣裙   → 只开 连衣裙与制服，关掉 上装 / 下装
        · 上下装   → 开 上装 + 下装，关掉 连衣裙与制服
        · 泳装     → 只开 泳装与贴身衣物（其余三个都关，core 会走 swim 分支） */
  const OUTFIT = [
    { k: "auto", label: "穿搭:自动",   on: { "上装": 1, "下装": 1, "连衣裙与制服": 1 }, off: { "泳装与贴身衣物": 1 },
      toast: "穿搭：自动（每次随机「连衣裙与制服」或「上装+下装」）" },
    { k: "dress", label: "穿搭:连衣裙", on: { "连衣裙与制服": 1 }, off: { "上装": 1, "下装": 1, "泳装与贴身衣物": 1 },
      toast: "穿搭：只出「连衣裙与制服」" },
    { k: "sep", label: "穿搭:上下装",  on: { "上装": 1, "下装": 1 }, off: { "连衣裙与制服": 1, "泳装与贴身衣物": 1 },
      toast: "穿搭：只出「上装 + 下装」" },
    { k: "swim", label: "穿搭:泳装",   on: { "泳装与贴身衣物": 1 }, off: { "上装": 1, "下装": 1, "连衣裙与制服": 1 },
      toast: "穿搭：只出「泳装与贴身衣物」（该槽强制参与，上装/下装/连衣裙不参与）" },
  ];
  let outfitIdx = 0;
  /* ⛔ 2026-09-29 用户报：「穿搭按钮怎么切换一次我的组合结果就自己抽取一次」。
     原来这里结尾是 `roll()`（= 重新抽一组），**切模式不该重抽** —— 你只是想换穿搭方案，
     不是想换掉整组标签。网页版 `chipOutfit` 结尾是 `renderCombo()`（只重画、不重抽），照抄。
     ⇒ 改成 `renderResult()`（重画当前这组），再补一条 toast 说明当前模式（网页也有）。 */
  const applyOutfit = (i) => {
    const m = OUTFIT[i];
    const c = currentOn();
    Object.keys(m.on).forEach((s) => { if (meta.slotOrder.includes(s)) c[s] = true; });
    Object.keys(m.off).forEach((s) => { if (meta.slotOrder.includes(s)) c[s] = false; });
    writeSlots(c);
    renderGen();
    renderResult();                       // ← 只重画，**不重抽**
    if (m.toast) toast(m.toast);
  };
  const syncOutfitLabel = () => {
    const el2 = q("#pcGOutfit");
    if (el2) el2.textContent = OUTFIT[outfitIdx].label;
  };
  q("#pcGOutfit").onclick = () => {
    outfitIdx = (outfitIdx + 1) % OUTFIT.length;
    syncOutfitLabel();
    applyOutfit(outfitIdx);
  };
  /* 从当前槽位状态反推一次模式（比如手动开关过后） */
  const inferOutfit = () => {
    if (!meta) return 0;
    const on = currentOn();
    if (on["泳装与贴身衣物"] && !on["上装"] && !on["下装"] && !on["连衣裙与制服"]) return 3;
    if (on["连衣裙与制服"] && !on["上装"] && !on["下装"]) return 1;
    if (on["上装"] && on["下装"] && !on["连衣裙与制服"]) return 2;
    return 0;
  };




  /* ⛔ 2026-10-06 对齐网页：全开/全关 = 改槽位配置 → 只重画、**不重抽** */
  q("#pcGAllOn").onclick = () => {
    const c = {}; meta.slotOrder.forEach((s) => { if (s !== "发色") c[s] = 1; });
    if (meta.slotOrder.includes("发色")) c["发色"] = 1;
    writeSlots(c); renderGen();
    toast("已开启全部槽位（点「组合生成」生效）");
  };
  q("#pcGAllOff").onclick = () => {
    /* 空对象/空字符串的既有语义是「跟随预设」，不能拿来表示全关。
       写入显式全零表：readSlots/currentOn 能识别为手动配置，后端也会保留 0。 */
    const c = {}; meta.slotOrder.forEach((s) => { c[s] = 0; });
    writeSlots(c); renderGen();
    toast("已关闭全部槽位（点「组合生成」生效）");
  };
  q("#pcGCn").onclick = () => {
    hideCn = !hideCn;
    q("#pcGCn").classList.toggle("on", hideCn);
    q("#pcGCn").textContent = hideCn ? "显示中文" : "隐藏中文";
    renderResult();
  };
  q("#pcGSlotMgr").onclick = () => openSlotMgr(() => {
    /* 关掉弹窗后刷新主界面（槽位池页也一起刷）
       ⛔ 2026-10-06 对齐网页：管完槽位**不重抽**（当前这组保持不动），只重画 */
    renderGen();
    refreshAfterSlotEdit();   // 改完立刻重画 peek + 槽位计数（poolTab 早已废弃）
  });
  /* ⭐ 2026-10-19（阿君：节点里「存为档位」点了没反应）：
     原实现是**去点一个已经不存在的标签页按钮**：
       `querySelectorAll(".pc-tab-btn")` 里找含「档位」的那个 → b.click()
     而标签页 2026-09-29 就删光了（功能并进「⚙ 槽位管理」弹窗），
     DOM 里一个 .pc-tab-btn 都没有 ⇒ find() 返回 undefined ⇒ `if (b)` 为假
     ⇒ **静默什么都不做，连个提示都没有**。
     ⛔ 这是「被依赖的元素删了，onclick 还留着，而且还用 if 把错误吞掉」的典型，
        比直接报错更难发现。已经登记进 MEMORY.md。
     改法：抽成 saveCustomPreset()，顶栏 chip 和弹窗里的「存为档位」按钮共用一份。 */
  async function saveCustomPreset(name) {
    const v = String(name == null ? "" : name).trim();
    if (!v) return { ok: false, why: "档位名不能为空" };
    const cur = currentOn();
    const on = Object.keys(cur).filter((k) => slotCountOf(cur[k]) > 0);
    if (!on.length) return { ok: false, why: "当前一个槽位都没开" };
    await loadUserEdits();
    const pe = (_userEdits.presetEdits = _userEdits.presetEdits || {});
    pe.custom = pe.custom || [];
    /* 重名不拦（和弹窗里那个按钮行为一致），但给个提示免得以为没存上 */
    const dup = pe.custom.some((x) => (x.name || "") === v);
    pe.custom.push({ _key: "__cu" + Date.now(), name: v, on: on,
                     /* 2026-10-19：连每槽数量一起存 —— 原来只存槽名，
                        「首饰抽 3 个」这种配置存档位后变回 1 个 */
                     counts: (() => {
                       const c = {};
                       on.forEach((k) => { const n = slotCountOf(cur[k]); if (n > 1) c[k] = n; });
                       return c;
                     })() });
    const ok = await saveUserEdits();
    return { ok: !!ok, why: ok ? (dup ? "（已有同名档位，这是新加的一个）" : "") : "保存失败（ComfyUI 后端没响应？）",
             n: on.length, dup: dup };
  }
  q("#pcGSavePreset").onclick = async () => {
    const nm = prompt("把当前槽位组合存成新档位，名字是：", "我的档位");
    if (nm === null) return;                       // 取消
    const r = await saveCustomPreset(nm);
    /* ⚠️ 这里**绝对不能**「失败了就再点一次自己」—— prompt 是阻塞式的，
       名字一直为空就成了无限循环（写完第一版就是这样，测试直接卡死）。
       失败就提示一句，让用户自己再点。 */
    if (!r.ok) { toast(r.why); return; }
    /* 存完立刻重画「搭配预设」那一行 —— 否则新档位要等下次 renderGen 才出现，
       用户会以为没存上（这就是「点了没反应」的另一半原因）。 */
    try { await loadUserEdits(true); } catch (e) {}
    renderGen();
    toast("已存为档位「" + String(nm).trim() + "」（" + r.n + " 个槽）" + (r.why || ""));
  };
  /* 系列筛选 —— 2026-09-29 接上后端：
     取值同步进节点参数 series（这样面板预览和真跑工作流的角色范围一致），
     抽完在输入框右边回显「命中了哪个系列 / 多少个角色」。 */
  seriesQ = String(wval("series", "") || "");
  q("#pcGSeries").value = seriesQ;
  q("#pcGSeries").addEventListener("input", () => {
    seriesQ = q("#pcGSeries").value.trim();
    setW("series", seriesQ);
  });
  /* ⛔ 2026-10-06 对齐网页：系列筛选是「改配置」→ **不重抽**，
     文案照网页 1523 行：「角色已限定：X（N 个角色，点「组合生成」生效）」
     命中多少角色由后端算，所以这里只给提示，回显留到下次「组合生成」后由 renderSeriesHit 填。 */
  q("#pcGSeries").addEventListener("change", () => {
    /* 保险：change 时按输入框当前值再同步一次（有些浏览路径只发 change 不发 input） */
    seriesQ = q("#pcGSeries").value.trim();
    setW("series", seriesQ);
    const box = q("#pcGSeriesHit");
    if (box) { box.className = "pc-whint"; box.textContent = ""; }
    toast(seriesQ
      ? ("角色已限定：" + seriesQ + "（点「组合生成」生效）")
      : "系列筛选已清空（点「组合生成」生效）");
  });
  q("#pcGSeriesClr").onclick = () => {
    q("#pcGSeries").value = ""; seriesQ = ""; setW("series", "");
    const box = q("#pcGSeriesHit");
    if (box) { box.className = "pc-whint"; box.textContent = ""; }
    toast("系列筛选已清空（点「组合生成」生效）");
  };
  /* 系列名候选（datalist）：一次拉全量，4418 个系列按角色数排序 */
  api("/series").then((d) => {
    const dl = q("#pcGSeriesList");
    if (!dl) return;
    const seen = new Set();
    (d.series || []).forEach((s) => {
      const lb = s.cn || s.en;
      if (!lb || seen.has(lb)) return;
      seen.add(lb);
      const op = el("option");
      op.value = lb;
      op.label = s.n + " 个词";
      dl.appendChild(op);
    });
  }).catch(() => {});
  /* 历史：上一组 / 下一组 */
  q("#pcGPrev").onclick = () => {
    if (!hist.length) return;
    /* 空面板（histIdx = -1）时，点「上一组」= 回到**最新那一组** ——
       这才是"我刚才跑的那组"的直觉，也不用从最早一组一步步翻过来。 */
    if (histIdx < 0) { histIdx = hist.length - 1; applyHist(); return; }
    if (histIdx <= 0) return;
    histIdx--; applyHist();
  };
  q("#pcGNext").onclick = () => {
    if (histIdx < 0 || histIdx >= hist.length - 1) return;
    histIdx++; applyHist();
  };
  /* ⭐ 2026-10-20（阿君：组数一多，上一组/下一组翻太麻烦）：
     一个列表把生成过的组合全摆出来，点哪条跳哪条。最新在最上面。 */
  let _histMask = null;
  function openHistList() {
    if (_histMask) { _histMask.remove(); _histMask = null; }
    if (!hist.length) { toast("还没生成过组合"); return; }
    const mask = el("div", "pc-smmask");
    const win = el("div", "pc-smwin");
    win.style.maxWidth = "820px";
    const head = el("div", "pc-smhead");
    head.appendChild(el("span", "pc-wtitle", "生成历史"));
    head.appendChild(el("span", "pc-wsub", "共 " + hist.length + " 组 · 点一条就跳过去"));
    const sp = el("span"); sp.style.flex = "1"; head.appendChild(sp);
    const bClose = el("button", "pc-wbtn sm", "关闭");
    head.appendChild(bClose);
    win.appendChild(head);
    const body = el("div", "pc-smbody");
    body.style.gap = "6px";
    /* 最新在上：从最后一条往前排 */
    for (let i = hist.length - 1; i >= 0; i--) {
      const h = hist[i] || {};
      const cur = (i === histIdx);
      const row = el("div", "pc-histrow");
      row.style.cssText = "display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border-radius:6px;"
        + "cursor:pointer;border:1px solid " + (cur ? "#5ee0d6" : "#2a323d") + ";"
        + "background:" + (cur ? "rgba(94,224,214,.08)" : "rgba(255,255,255,.02)");
      const no = el("span", "", "#" + (i + 1));
      no.style.cssText = "color:" + (cur ? "#5ee0d6" : "#6b7a93")
        + ";font-family:Consolas,monospace;font-size:11px;min-width:34px;padding-top:1px";
      const mid = el("div"); mid.style.flex = "1"; mid.style.minWidth = "0";
      /* 第一行：档位 + seed + 数量（阿君：要能看出是哪个搭配预设抽的） */
      const _preset = (h.params && h.params.preset) || h.pr || "";
      const t0 = el("div");
      t0.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:4px;flex-wrap:wrap";
      if (_preset) {
        const bd = el("span", "", _preset);
        bd.style.cssText = "font-size:10px;padding:1px 6px;border-radius:4px;background:rgba(94,224,214,.14);"
          + "color:#5ee0d6;border:1px solid rgba(94,224,214,.35)";
        t0.appendChild(bd);
      }
      const mt = el("span", "", "seed " + (h.seed || "—") + " · " + (h.tags || []).length + " 个标签"
        + (h.pinned ? " · 手改过" : ""));
      mt.style.cssText = "font-size:10.5px;color:#6b7a93;font-family:Consolas,monospace";
      t0.appendChild(mt);
      /* 第二行：英文原文 */
      const t1 = el("div", "", (h.tags || []).map((t) => t.prompt).join(", "));
      t1.style.cssText = "font-size:11px;line-height:1.45;color:#9fb0c6;word-break:break-all;"
        + "font-family:Consolas,monospace";
      /* 第三行：中文对照（阿君：一长串英文谁看得懂） */
      const _cn = (h.tags || []).map((t) => (t.name && t.name !== t.prompt) ? t.name : "")
        .filter(Boolean).join("，");
      const t2 = el("div", "", _cn || "（这些标签词库里没有中文名）");
      t2.style.cssText = "font-size:11.5px;line-height:1.45;margin-top:3px;word-break:break-all;"
        + "color:" + (_cn ? "#cfd8e3" : "#5c6a80");
      mid.append(t0, t1, t2);
      row.append(no, mid);
      const close = () => { mask.remove(); _histMask = null; };
      row.onclick = () => { histIdx = i; applyHist(); close(); };
      body.appendChild(row);
    }
    win.appendChild(body);
    mask.appendChild(win);
    document.body.appendChild(mask);
    const close = () => { mask.remove(); _histMask = null; };
    bClose.onclick = close;
    mask.addEventListener("mousedown", (e) => { if (e.target === mask) close(); });
    _histMask = mask;
  }
  q("#pcGHist").onclick = openHistList;
  function applyHist() {
    const h = hist[histIdx];
    if (!h) return;
    curTags = h.tags.slice(); curPos = h.pos;
    /* ⭐ 2026-10-19（阿君：点上一组/下一组，seed 好像不会跟着变）：
       每组历史都记着自己是用哪个 seed 抽出来的 —— 翻回去就把 seed 一起退回去，
       节点按这个 seed 重算，出的就正好是这一组。
       ⚠️ 改之前这里压根没碰 seed：探针实测「生成 3 组再连点两次上一组」，
          widget seed 一直停在第三次那个值 → 点运行出的永远是最后一组。
       例外：这组被手动改过（h.pinned）→ seed 复现不出来 ⇒ 钉住整段文本。 */
    if (typeof h.seed === "number") setW("seed", h.seed);
    _pinned = !!h.pinned;
    syncPin();
    /* ⭐ 2026-11-22：翻到哪组就是用户**要看**哪组，下一次运行必须原样用它 ——
       否则「每次随机」会把它换掉，等于重复 2026-10-19 那个坑
       （「翻到第 5 组点运行，出的是别的组」），只是这次是随机撞的。 */
    try { node._pcKeepSeedOnce = true; } catch (e) {}
    _forceText = true;                 /* 同上：翻历史也是整组替换，文本要跟着走 */
    renderResult();
  }
  let lastPushKey = null;
  /* ⭐ 2026-10-19（阿君：复现没复现成功）：
     光记 seed 不够 —— 用户在生成这组之后改过槽位/性别/档位/开关的话，
     seed 一样也抽不出同一组。所以每组历史额外存一份**当时的参数快照**，
     「复现」命中这个 seed 时连参数一起还原。 */
  const snapParams = () => ({
    preset: String(wval("preset", "") || ""),
    gender: String(wval("gender", "只看女性") || ""),
    nsfw: !!wval("nsfw_filter", true),
    nsfwOnly: !!wval("nsfw_only", false),
    /* ⚠️ 存**原始字符串**而不是展开后的表：原来记的是 currentOn() 展开结果，
       复现时写成显式槽位表 ⇒ 之后切档位就不生效了（slots_json 非空会盖住预设）。
       空 = 走预设，必须原样保留这个「空」。 */
    slotsRaw: String(wval("slots_json", "") || ""),
    slotsN: Object.keys(currentOn()).length,
    series: String(wval("series", "") || ""),
    locks: locked.slice(),
    q: !!wval("add_quality", true),
    sp: !!wval("space_out", true),
    an: !!wval("anima_mode", false),
    cr: !!wval("auto_copyright", true),
    bo: !!wval("auto_boost", true),
    cs: !!wval("cross_series", false),
  });
  const restoreParams = (p) => {
    if (!p) return false;
    try {
      pinSeedControl(node);
      if (p.preset) setW("preset", p.preset);
      if (p.gender) setW("gender", p.gender);
      setW("nsfw_filter", !!p.nsfw);
      setW("nsfw_only", !!p.nsfwOnly);
      setW("slots_json", p.slotsRaw || "");
      setW("series", p.series || "");
      seriesQ = p.series || "";
      const si = q("#pcGSeries"); if (si) si.value = seriesQ;
      writeLocked(Array.isArray(p.locks) ? p.locks : []);
      setW("add_quality", !!p.q);
      setW("space_out", !!p.sp);
      setW("anima_mode", !!p.an);
      setW("auto_copyright", !!p.cr);
      setW("auto_boost", !!p.bo);
      setW("cross_series", !!p.cs);
      renderGen();
      return true;
    } catch (e) { return false; }
  };
  function pushHist() {
    /* 用「标签集合」做去重判据（比比较整段文本可靠 —— 文本可能被手动改过） */
    const key = curTags.map((t) => t.prompt).join("|");
    if (key && key === lastPushKey) { renderHist(); return; }
    lastPushKey = key;
    /* seed 必须跟着存：历史组靠它才能被节点重算出来（见 applyHist）。 */
    const _p = snapParams();
    const _sd = Number(wval("seed", 0)) || 0;
    hist.push({ tags: curTags.slice(), pos: curPos,
                seed: _sd, pinned: false,
                params: _p });
    if (hist.length > 200) hist.shift();
    histIdx = hist.length - 1;
    /* ⭐ 2026-10-19（阿君：换工作流复制 seed 复现不出来）：
       顺手把「seed → 参数快照」写进 user_edits.json，跨节点/跨工作流共享。
       ⚠️ 复现过程中（_replaying）不写 —— 那组是拿当前配置硬抽的，
          写进去会把原产地记录覆盖成错的。 */
    if (!_replaying && _sd > 0) recordSeedParams(_sd, _p);
    /* ⭐ 2026-10-20（阿君：切了工作流再切回来，刚才组合的标签全没了）：
       历史原来只在内存数组里，节点一重建就归零。落盘到 data/hist.json。 */
    saveHistSoon();
    /* 新抽了一组 ⇒ 这个 seed 现在有归属记录了，提示条跟着变绿 */
    setTimeout(() => { try { window.__pcUpdateSeedHint?.(); } catch (e) {} }, 0);
    renderHist();
    /* ⛔ 2026-10-20：历史刚变过，必须**立刻**把状态写进控件 ——
       只靠 renderResult 收尾那次会漏（写入发生在 pushHist 之前），
       切回来就少一组。 */
    _savePanelState();
  }
  /* 历史落盘：防抖 800ms —— 连点「组合生成」时别每次都写盘 */
  let _histTimer = null;
  function saveHistSoon() {
    if (_histTimer) clearTimeout(_histTimer);
    _histTimer = setTimeout(() => {
      _histTimer = null;
      try {
        api("/hist", {
          method: "POST",
          body: JSON.stringify({ hist: hist.slice(-100) }),
        }).catch(() => {});
      } catch (e) {}
    }, 800);
  }
  /* seed → 快照。只增改，不清空；上限 500 条由后端兜（这里也顺手裁一次）。 */
  function recordSeedParams(seed, p) {
    if (!_userEdits) return;
    if (!_userEdits.seedParams) _userEdits.seedParams = {};
    const k = String(seed);
    _userEdits.seedParams[k] = Object.assign({}, p, { t: Date.now() });
    const ks = Object.keys(_userEdits.seedParams);
    if (ks.length > 500) {
      ks.sort((a, b) => ((_userEdits.seedParams[a] || {}).t || 0)
                      - ((_userEdits.seedParams[b] || {}).t || 0));
      for (const x of ks.slice(0, ks.length - 500)) delete _userEdits.seedParams[x];
    }
    saveUserEdits();
  }
  /* ===== 收藏夹（2026-09-29 补完）=========================================
     对齐网页版的 promptCombinerFavs：指纹 = 标签集合排序拼接，同一组不会重复收藏。
     落盘走 POST /pc/user（→ data/user_edits.json 的 favorites），
     ⚠️ 不能存 localStorage：网页是 file://、ComfyUI 是 http://127.0.0.1:8188，
        两个 origin 的 localStorage 不互通（插件侧一直是这个坑）。
     ====================================================================== */
  function favList() {
    if (!_userEdits) return [];
    if (!Array.isArray(_userEdits.favorites)) _userEdits.favorites = [];
    return _userEdits.favorites;
  }
  const comboKey = (list) => list.map((c) => String(c.prompt)).sort().join("|");

  /* ===== 单词收藏（2026-10-19 阿君：「喜欢的角色或者某个标签能不能也收藏」）=====
     跟整组收藏分开存（`wordFavs`），一条 = 一个词。
     用法：标签右键 →「☆ 收藏这个标签」；收藏夹里点一下 → **直接锁进当前组合**。 */
  function wordFavList() {
    if (!_userEdits) return [];
    if (!Array.isArray(_userEdits.wordFavs)) _userEdits.wordFavs = [];
    return _userEdits.wordFavs;
  }
  function isWordFav(prompt) {
    return wordFavList().some((x) => x.p === prompt);
  }
  function toggleWordFav(prompt, name, slot) {
    if (!_userEdits) return false;
    const list = wordFavList();
    const i = list.findIndex((x) => x.p === prompt);
    if (i >= 0) {
      list.splice(i, 1);
      saveUserEdits(); updateFavBtn(); if (favOpen) renderFavs();
      toast("已取消收藏「" + prompt + "」");
      return false;
    }
    list.unshift({ p: prompt, n: name || "", s: slot || "", t: Date.now() });
    if (list.length > 500) list.length = 500;
    saveUserEdits(); updateFavBtn(); if (favOpen) renderFavs();
    toast("已收藏「" + prompt + "」（在「★ 收藏夹」里点它就能锁进组合）");
    return true;
  }
  /* 收藏夹里点一个词 = 锁进当前组合（不是「塞进结果文本」——
     锁定的含义是「本次必定出现、且以后点生成也保留」，这才是收藏该有的效果）。
     ⚠️ slot 必须补全：锁定的词要靠 slot 去占用互斥组，slot 空着会出矛盾词
        （比如锁了角色又抽到另一个角色）。收藏时记的 slot 可能为空（老数据/手输词），
        这里补查一次词库。 */
  async function useWordFav(prompt, slot, name) {
    if (locked.some((x) => x.prompt === prompt)) {
      toast("「" + prompt + "」已经锁着了，点「组合生成」就会带上它");
      return;
    }
    let sl = slot || "", nm = name || "";
    if (!sl || !nm) {
      try {
        const inf = await slotInfo(prompt);
        if (!sl) sl = (inf.slots || [])[0] || "";
        if (!nm) nm = inf.name || "";
      } catch (e) {}
    }
    writeLocked(locked.concat([{ prompt: prompt, slot: sl, name: nm || prompt }]));
    renderResult();
    /* ⛔ 别只说「已锁定」就完 —— 这个词如果本来不在结果里，界面上一点变化都没有，
       用户会以为点了没反应（本项目踩过太多次）。 */
    const inNow = curTags.some((t) => t.prompt === prompt);
    toast(inNow
      ? ("已锁定「" + prompt + "」，以后每次生成都会保留")
      : ("已锁定「" + prompt + "」，点「组合生成」就会带上它"));
  }

  function updateFavBtn() {
    const list = favList();
    const wf = wordFavList().length;
    const n = q("#pcGFavN");
    /* 徽章必须同时反映两类收藏。
       ⛔ 只写 list.length 会出现「收藏了角色，按钮还显示 0」——阿君 2026-10-20 报的。
       空间有限，按情况缩写：都有 →「2组·3词」，只有一种 →「2」/「3词」。 */
    if (n) {
      n.textContent = (list.length && wf) ? (list.length + "组·" + wf + "词")
        : list.length ? String(list.length)
          : wf ? (wf + "词") : "0";
    }
    const btnAll = q("#pcGFavs");
    if (btnAll) {
      btnAll.title = "收藏的组合 " + list.length + " 组，收藏的标签 " + wf + " 个 —— 点开查看";
    }
    const add = q("#pcGFav");
    if (add) {
      const has = curTags.length > 0 && list.some((f) => f.k === comboKey(curTags));
      add.textContent = has ? "★ 已收藏" : "☆ 收藏";
    }
    const btn = q("#pcGFavs");
    if (btn) btn.classList.toggle("on", favOpen);
  }

  function addFav() {
    if (!curTags.length) { gCount.textContent = "还没有组合可收藏，先点「组合生成」"; return; }
    const k = comboKey(curTags);
    const list = favList();
    if (list.some((f) => f.k === k)) { gCount.textContent = "这组已经在收藏夹里了"; return; }
    list.unshift({
      k: k, t: Date.now(), p: curPos,          // p = 完整正向文本（含画质词/手改），载入时原样还原
      c: curTags.map((x) => ({ prompt: x.prompt, name: x.name, slot: x.slot })),
    });
    if (list.length > 200) list.length = 200;
    saveUserEdits();
    updateFavBtn();
    if (favOpen) renderFavs();
    gCount.textContent = "已收藏（共 " + list.length + " 组）";
  }

  function renderFavs() {
    const box = q("#pcGFavBox");
    if (!box) return;
    box.classList.toggle("on", favOpen);
    if (!favOpen) { box.replaceChildren(); return; }
    box.replaceChildren();
    const list = favList();

    /* ---- ① 收藏的标签（单个词）---- */
    const wf = wordFavList();
    if (wf.length) {
      const sec1 = el("div", "pc-wfavsec");
      sec1.appendChild(el("span", "", "★ 收藏的标签"));
      /* 这里有数量，跟下面「★ 收藏的组合 N 组」对齐 —— 不然一组都没收藏时
         两段看起来都是空的，用户分不清是「没存进去」还是「这段本来就没数字」 */
      sec1.appendChild(el("span", "n", wf.length + " 个 · 点一下 = 锁进当前组合"));
      sec1.appendChild(el("span", "s"));
      box.appendChild(sec1);
      const wrap = el("div", "pc-wordfav");
      wf.forEach((x) => {
        const chip = el("span", "w");
        /* ⚠️ 换行必须写 "\n"；写成 "\\n" 会原样显示成 \n 两个字符 */
        chip.title = (x.s ? "槽位：" + x.s + "\n" : "") + "点一下锁进当前组合";
        chip.appendChild(el("span", "e", x.p));
        if (x.n) chip.appendChild(el("span", "u", x.n));
        const del = el("span", "x", "×");
        del.title = "取消收藏";
        del.onclick = (ev) => { ev.stopPropagation(); toggleWordFav(x.p, x.n, x.s); };
        chip.appendChild(del);
        chip.onclick = () => useWordFav(x.p, x.s, x.n);
        chip.oncontextmenu = (ev) => { ev.preventDefault(); showWordMenu(ev.clientX, ev.clientY, x.p, x.s); };
        wrap.appendChild(chip);
      });
      box.appendChild(wrap);
    }

    /* ---- ② 收藏的组合 ---- */
    const sec2 = el("div", "pc-wfavsec");
    sec2.appendChild(el("span", "", "★ 收藏的组合"));
    sec2.appendChild(el("span", "n", list.length ? (list.length + " 组") : "暂无"));
    sec2.appendChild(el("span", "s"));
    box.appendChild(sec2);
    if (!list.length) {
      box.appendChild(el("div", "pc-fempty",
        wf.length ? "还没收藏任何组合 —— 生成一组后点「☆ 收藏」"
                  : "还没收藏任何组合 —— 生成一组后点「☆ 收藏」；"
                    + "想收藏单个角色/标签，右键那个词选「☆ 收藏这个标签」"));
      return;
    }
    list.forEach((f, i) => {
      const item = el("div", "pc-fav-item");
      const d = new Date(f.t || 0);
      const pad = (x) => String(x).padStart(2, "0");
      item.appendChild(el("div", "pc-fav-head",
        "#" + (list.length - i) + " · " + (f.c || []).length + " 个标签 · " +
        (d.getMonth() + 1) + "/" + d.getDate() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes())));
      /* 英文 + 中文并排（收藏夹就是拿来对照检查的，只给中文等于把 prompt 藏了） */
      const tags = el("div", "pc-fav-tags");
      (f.c || []).forEach((x) => {
        const s = el("span", "pc-fav-tag");
        s.appendChild(el("span", "e", x.prompt || ""));
        if (x.name) s.appendChild(el("span", "c", x.name));
        tags.appendChild(s);
      });
      item.appendChild(tags);
      const acts = el("div", "pc-fav-acts");
      const b1 = el("button", "pc-wbtn sm", "载入这组");
      b1.onclick = () => {
        curTags = (f.c || []).map((x) => ({
          prompt: x.prompt, name: x.name, slot: x.slot, out: outOf(x.prompt, x.slot),
        }));
        curPos = f.p || curTags.map((t) => t.out).join(", ");
        /* 收藏里的组合不是「当前 seed 的产物」⇒ 必须钉住，否则点运行时节点按 seed 重抽，
           载入的这组白载了。 */
        _pinned = true; syncPin();
        renderResult();
        gCount.textContent = "已载入收藏的组合（" + curTags.length + " 个标签）";
      };
      const b2 = el("button", "pc-wbtn sm", "复制");
      b2.onclick = () => {
        const txt = f.p || (f.c || []).map((x) => outOf(x.prompt, x.slot)).join(", ");
        copyText(txt, (ok) => { gCount.textContent = ok ? "已复制这一组 ✓" : "复制失败"; });
      };
      const b3 = el("button", "pc-wbtn sm warn", "删除");
      b3.onclick = () => {
        list.splice(i, 1);
        saveUserEdits();
        updateFavBtn(); renderFavs();
        gCount.textContent = "已删除（剩 " + list.length + " 组）";
      };
      acts.appendChild(b1); acts.appendChild(b2); acts.appendChild(b3);
      item.appendChild(acts);
      box.appendChild(item);
    });
  }

  q("#pcGFav").onclick = addFav;
  q("#pcGFavs").onclick = () => { favOpen = !favOpen; updateFavBtn(); renderFavs(); };

  q("#pcGCn").classList.toggle("on", false);
  /* ⭐ 2026-10-14 对齐网页 syncComboFromBox：在结果文本框里**手动**增删词，
     标签列表跟着同步 —— 新增的当「自定」进列表、删掉的从列表摘掉。
     原来只改 curPos，标签区和文本会脱节（网页是会同步的）。 */
  /* ⚠️ 统一规范化（2026-10-18 第 4 次踩同一个坑）：
     文本框里是**转义写法** `shenhe \(genshin impact\)`，而 curTags.prompt 是原始下划线写法
     `shenhe_(genshin_impact)`。不剥反斜杠就认不出已有标签 ⇒ 多建一个「自定」条目
     （阿君截图：2 个标签，删掉「自定」连真标签一起没了）。
     **凡「文本 ↔ 标签」比对，先过 _clean + 下划线 + 小写。** */
  const _cleanTxt = (x) => String(x == null ? "" : x).replace(/\\/g, "");
  const _nkTxt = (x) => _cleanTxt(x).replace(/\s+/g, "_").toLowerCase();
  /* ⭐ 2026-10-21（阿君：结果框一动，(rule of thirds:1.3) 就掉成「自定」）：
     文本段是「输出写法」，标签对象里存的是原始 prompt —— 比对前把
     `(xxx:1.3)` 这种权重包装剥掉，两边才对得上。 */
  const _nkTag = (x) => _nkTxt(String(x == null ? "" : x).replace(/^\((.*):[\d.]+\)$/, "$1"));
  /* ===== 2026-10-18（阿君：节点端也要双向同步）=====
     textarea 没有 DOM Range，拿不到"鼠标下面是哪个词"。
     办法：建一个**隐藏镜像层**（字体/宽度/换行规则和 gText 完全一致），
     把每个标签包成 <span>，量出它们的矩形 ⇒ 鼠标坐标命中哪个 span 就是哪个词。
     镜像只在结果变化后重建一次（_syncDirty）。 */
  function _syncBuild() {
    const cs = getComputedStyle(gText);
    if (!_mirror || !_mirror.isConnected) {
      _mirror = document.createElement("div");
      _mirror.id = "pcMirror";
      _mirror.className = "pc-mirror";
      wrap.appendChild(_mirror);
    }
    const pl = parseFloat(cs.paddingLeft) || 0;
    const pr = parseFloat(cs.paddingRight) || 0;
    _mirror.style.width = Math.max(0, gText.clientWidth - pl - pr) + "px";
    _mirror.style.fontFamily = cs.fontFamily;
    _mirror.style.fontSize = cs.fontSize;
    _mirror.style.fontWeight = cs.fontWeight;
    _mirror.style.lineHeight = cs.lineHeight;
    _mirror.style.letterSpacing = cs.letterSpacing;
    const txt = String(gText.value || "");
    const segs = [];
    const re = /[^,\n]+/g;
    let m;
    while ((m = re.exec(txt))) {
      const raw = m[0];
      const a = m.index + (raw.length - raw.trimStart().length);
      const b2 = m.index + raw.trimEnd().length;
      if (b2 > a) segs.push([a, b2]);
    }
    _mirror.replaceChildren();
    let pos = 0;
    segs.forEach(([a, b2]) => {
      if (a > pos) _mirror.appendChild(document.createTextNode(txt.slice(pos, a)));
      const sp = document.createElement("span");
      sp.textContent = txt.slice(a, b2);
      _mirror.appendChild(sp);
      pos = b2;
    });
    if (pos < txt.length) _mirror.appendChild(document.createTextNode(txt.slice(pos)));
    const mr = _mirror.getBoundingClientRect();
    _mirrorBoxes = Array.prototype.map.call(_mirror.querySelectorAll("span"), (sp) => {
      const r = sp.getBoundingClientRect();
      return { txt: sp.textContent, x: r.left - mr.left, y: r.top - mr.top, w: r.width, h: r.height };
    });
    _syncDirty = false;
  }
  function _syncWordAt(ev) {
    if (_syncDirty) { try { _syncBuild(); } catch (e) { return null; } }
    if (!_mirrorBoxes) return null;
    const r = gText.getBoundingClientRect();
    const cs = getComputedStyle(gText);
    const x = ev.clientX - r.left - (parseFloat(cs.paddingLeft) || 0) + gText.scrollLeft;
    const y = ev.clientY - r.top - (parseFloat(cs.paddingTop) || 0) + gText.scrollTop;
    for (let i = 0; i < _mirrorBoxes.length; i++) {
      const b = _mirrorBoxes[i];
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b.txt;
    }
    return null;
  }
  function _syncFindChip(word) {
    const k = _nkTxt(word);
    if (!k) return null;
    const list = gTags.querySelectorAll(".pc-wtag");
    for (let i = 0; i < list.length; i++) {
      const e2 = list[i].querySelector(".e");
      if (e2 && _nkTxt(e2.textContent) === k) return list[i];
    }
    return null;
  }
  function _syncHover(word) {
    const old = gTags.querySelectorAll(".pc-wtag.hl");
    for (let i = 0; i < old.length; i++) old[i].classList.remove("hl");
    if (!word) return;
    const c = _syncFindChip(word);
    if (c) c.classList.add("hl");
  }
  let _syncRaf = 0;
  gText.addEventListener("mousemove", (ev) => {
    if (_syncRaf) return;
    _syncRaf = requestAnimationFrame(() => {
      _syncRaf = 0;
      try { _syncHover(_syncWordAt(ev)); } catch (e) {}
    });
  });
  gText.addEventListener("mouseleave", () => _syncHover(null));
  /* ⛔ 2026-10-20（阿君：结果框里有一串标签时，想在任意位置点一下放光标，光标却乱跳）：
     原来这里会去**点对应的标签卡片**，而卡片的 onclick 会 setSelectionRange 选中
     **整个词**并改 scrollTop ⇒ 用户只想放光标，结果整词被选中、视图还跳走。
     改成只同步高亮，光标和滚动都交回给浏览器。 */
  gText.addEventListener("click", (ev) => {
    try {
      const w = _syncWordAt(ev);
      if (!w) return;
      const chip = _syncFindChip(w);
      if (!chip) return;
      gTags.querySelectorAll(".pc-wtag.sel").forEach((x) => { if (x !== chip) x.classList.remove("sel"); });
      chip.classList.add("sel");
    } catch (e) {}
  });

  gText.addEventListener("input", () => {
    /* ⛔ 这是**唯一**不允许 renderResult 重写文本框的路径：用户正在敲字，
       一重写光标就被拽到末尾。其它路径（生成/翻历史/删标签/加词/补位）都必须回写。 */
    _typing = true;
    curPos = gText.value;
    let toks = curPos.split(/[,，\n]+/).map((s) => s.trim()).filter(Boolean);
    /* ⭐ 2026-10-18（阿君：在结果框里打字搜标签，打字内容自己变成「自定」跑进公共描述）：
       光标在末尾、末尾又不是分隔符 ⇒ 最后一段是"正在输入中"，不落成标签。 */
    try {
      const _pos = gText.selectionStart == null ? curPos.length : gText.selectionStart;
      /* ⚠️ 不能只看"末尾"：阿君是把光标放在**第1人中间**某个标签后面打字的，
         粘连词（`flower_earrings大和`）在中间，末尾判断管不到。
         改成：**光标所在那段**如果不是已知标签，就当作"正在输入"丢弃。 */
      const _sepRe = /[,，\n]+/g;
      const _spans = []; let _m, _last = 0;
      while ((_m = _sepRe.exec(curPos))) { _spans.push([_last, _m.index]); _last = _sepRe.lastIndex; }
      _spans.push([_last, curPos.length]);
      const _ci = _spans.findIndex(([a, b2]) => _pos >= a && _pos <= b2);
      if (_ci >= 0) {
        const _raw = curPos.slice(_spans[_ci][0], _spans[_ci][1]).trim();
        const _known = _raw && (curTags.some((t) => _nkTag(t.prompt) === _nkTag(_raw))
                                || _tagCache.has(_nkTag(_raw)));
        if (_raw && !_known) toks = toks.filter((t) => _nkTag(t) !== _nkTag(_raw));
      }
    } catch (e) {}
    /* ⛔ 2026-10-18（阿君：第 1 人的人物特征直接没了）：原来按「词」去重，
       两个赛马娘的特征词完全相同 ⇒ 只剩一条，先出现的那份（第1人）被丢掉。
       改成**按出现次数**保留：文本里这个词出现几次，就保留几个旧对象。 */
    const needCnt = new Map();
    toks.forEach((s) => { const k = _nkTag(s); needCnt.set(k, (needCnt.get(k) || 0) + 1); });
    const keep = [];
    const keepP = new Set();
    for (const t of curTags) {
      const k = _nkTag(t.prompt);
      const c = needCnt.get(k) || 0;
      if (c > 0) { needCnt.set(k, c - 1); keepP.add(k); keep.push(t); }
    }
    for (const s of toks) {
      const p = _cleanTxt(s).replace(/ /g, "_");
      const _k = _nkTag(p);
      const _c = needCnt.get(_k) || 0;
      if (_c <= 0) continue;
      needCnt.set(_k, _c - 1);
      /* 先查槽位缓存：搜过 / 生成过的词都能认出来，不再一律「自定」 */
      const hit = _tagCache.get(_nkTxt(p)) || _tagCache.get(_nkTag(p));
      keep.push({ prompt: p, name: (hit && hit.name) || p, slot: (hit && hit.slot) || "自定", out: s });
      keepP.add(_k);
    }
    /* ⭐ 2026-10-21（阿君：结果框补进来的角色没有补回原排序，甩到了末尾）：
       这里原来只恢复 who 就完了 —— ① 位置根本没回去；② 单人组的角色 who=null，
       下面的排序把 null 当「公共描述」甩到最后。现在恢复 who 之外还记下
       「钉回原下标」，排完序再钉一次，文本跟着重排，补位才算真的补位。 */
    const _pins = [];
    keep.forEach((c) => {
      if (c.who !== undefined && c.who !== null) return;
      const vi = _vacancies.findIndex((v) => v.slot && v.slot === c.slot);
      if (vi < 0) return;
      const v = _vacancies.splice(vi, 1)[0];
      c.who = (v.who === undefined || v.who === null) ? null : v.who;
      _pins.push({ c: c, idx: v.idx });
    });
    /* 人数（2girls）排最前；公共描述排最后 */
    const _grpT = (c) => c.slot === "人数" ? -1
      : ((c.who === undefined || c.who === null) ? 1e9 : Number(c.who));
    curTags = keep.map((c, i) => [c, i])
      .sort((a, b) => (_grpT(a[0]) - _grpT(b[0])) || (a[1] - b[1]))
      .map((x) => x[0]);
    let _rePinned = false;
    _pins.forEach(({ c: c, idx: idx }) => {
      const i2 = curTags.indexOf(c);
      if (i2 < 0) return;
      curTags.splice(i2, 1);
      curTags.splice(Math.min(Math.max(0, idx), curTags.length), 0, c);
      _rePinned = true;
    });
    if (_rePinned) { curPos = buildPosFromTags(curTags); _forceText = true; }
    /* 锁定词被手动删掉就同步解锁（网页 syncComboFromBox 里锁集会跟着过滤） */
    if (locked.some((x) => !keepP.has(_nkTag(x.prompt)))) {
      writeLocked(locked.filter((x) => keepP.has(_nkTag(x.prompt))));
    }
    /* 手动在结果框里打字 = 这组已经不是 seed 的产物了 ⇒ 钉住整段文本，
       否则点运行节点还会按 seed 重抽一遍，把用户手打的内容抹掉。 */
    markEdited();
    renderResult();
    _typing = false;
  });
  /* ⭐ 2026-10-18（阿君：「光标停在标签后面直接打字搜不出来，得先打个空格」）：
     结果框是 textarea，在**末尾直接打字**时自动补一个 ", "。
     不补的话新字会粘在上一个词后面：① 联想搜索整串搜不到 ② 双人里那个标签会丢 who、
     多出一个「公共描述」分组。与网页版 beforeinput 同款逻辑。
     `_glueDone` 保证「每次放光标只补一次」，连续打字不会把词切碎。 */
  let _glueArmed = true, _glueDone = false;
  const _armGlue = () => { _glueArmed = true; _glueDone = false; };
  gText.addEventListener("focus", _armGlue);
  gText.addEventListener("mousedown", _armGlue);
  gText.addEventListener("beforeinput", (e) => {
    if (!e.inputType || e.inputType !== "insertText" || !e.data) return;
    if (!_glueArmed || _glueDone) return;
    const v = gText.value || "";
    const pos = gText.selectionStart == null ? v.length : gText.selectionStart;
    if (pos !== v.length) return;                        // 只在末尾
    if (gText.selectionEnd !== pos) return;              // 有选区不动
    const prev = v.slice(-1);
    if (!prev || /[,\uff0c\s\n]/.test(prev)) return;     // 前面已是分隔符
    if (!/^[\w\-\u4e00-\u9fa5]$/.test(e.data)) return;
    e.preventDefault();
    _glueDone = true;
    gText.setRangeText(", " + e.data, pos, pos, "end");
    gText.dispatchEvent(new Event("input", { bubbles: true }));
  });

  /* ⭐ 2026-10-18（阿君：「要可以直接搜索的」）：**独立搜索框**，不依赖光标位置。
     输入即搜（/pc/dict），↑↓ 选、Enter/点击 → 追加到提示词末尾，不动已有标签的归属。 */
  try {
    const findInp = q("#pcFind");
    if (findInp) {
      attachSuggest(findInp, {
        gq: _gq,
        curTags: () => curTags,
        format: (p2, it) => outOf(p2, it && it.slot),
        onPick: async (it) => {
          const p2 = (it && it.prompt) || "";
          if (!p2) return;
          const slot = (it && it.slot) || "自定";
          const out = outOf(p2, slot);
          if (curTags.some((t) => t.prompt === p2)) {
            findInp.value = "";
            toast("这个标签已经在组合里了：" + ((it && it.name) || p2));
            return;
          }
          /* ⭐ 补位：该槽刚被手动删过 → 插回原位置（who 一并恢复） */
          const vi = slot !== "自定" ? _vacancies.findIndex((v) => v.slot === slot) : -1;
          if (vi >= 0) {
            const v = _vacancies.splice(vi, 1)[0];
            const item = { prompt: p2, name: (it && it.name) || p2, slot: slot, out: out };
            if (v.who !== undefined && v.who !== null) item.who = v.who;
            const at = Math.min(Math.max(0, v.idx), curTags.length);
            curTags = curTags.slice(0, at).concat([item], curTags.slice(at));
            /* 补进来的是角色 ⇒ 旧角色的作品词要跟着换（2026-10-20 阿君报的问题） */
            const extra = await _afterAddWord(item);
            curPos = buildPosFromTags(curTags);
            markEdited();
            renderResult();
            findInp.value = "";
            toast("已补位到「" + slot + "」：" + ((it && it.name) || p2) + extra);
            return;
          }
          const item = { prompt: p2, name: (it && it.name) || p2, slot: slot, out: out };
          insertBesideSlot(curTags, item);
          const extra2 = await _afterAddWord(item);
          curPos = buildPosFromTags(curTags);
          markEdited();
          renderResult();
          findInp.value = "";
          toast("已追加：" + ((it && it.name) || p2) + extra2);
        },
      });
    }
  } catch (e) { console.error("[prompt-combiner] 搜索框挂载失败", e); }

  /* 标签联想：结果框里打字弹候选 */
  try {
    attachSuggest(gText, {
      gq: _gq,
      curTags: () => curTags,
      combo: true,
      isKnown: (s) => curTags.some((t) => _nkTag(t.prompt) === _nkTag(s)) || _tagCache.has(_nkTag(s)),
      format: (p, it) => outOf(p, it && it.slot),
      onPick: async (it) => { try { await _comboPick(it); } catch (e) {} },
    });
  }
  catch (e) { console.error("[prompt-combiner] 联想挂载失败", e); }

  /* 加载元信息 */
  loadMeta().then((m) => {
    meta = m;
    /* ⭐ 2026-10-21（阿君：一动结果框，masterpiece 那批画质词就掉成「自定」）：
       后端把画质词拼进 positive 但**不算进 tags** —— 文本和标签天生差这一截，
       文本一重建它们就被收编成「自定」。这里把它们预先灌进槽位缓存
       （槽=固定画质），重建时就认得出来了。 */
    _cacheTags(((m && m.quality) || []).map((q) => ({ prompt: q, name: q, slot: "固定画质", out: q })));
    sub.textContent = "词库 " + m.dictCount + " 条 · " + m.slotOrder.length + " 槽 · " + m.presets.length + " 档";
    /* 标签词库（内联在组合页底部）
       ⚠️ 2026-09-29：槽位池 / 档位 两个标签页已去掉 —— 它们的功能都在「⚙ 槽位管理」弹窗里。
         词库浏览按网页布局内联到组合页下面。 */
    try {
      /* ⛔ 2026-09-29 修：这里**必须把 showWordMenu 传进去** ——
         词格的右键写的是 `if (ctx.showWordMenu) …`，不传就**静默什么都不发生**，
         用户右键词库标签"没反应/只有一项"就是这个（网页那边的同类注入也一样）。 */
      dictTab = createDictTab({ pane: TABS.dict, meta, showWordMenu, gq: _gq,
        onTagClick: toggleCurTag, inCombo: (p) => curTags.some((z) => z.prompt === p) });
      dictTab.render();
    } catch (e) { TABS.dict.appendChild(el("div", "pc-err", "词库浏览初始化失败：" + e.message)); }
    renderGen();
    /* 各槽词数（失败不影响主流程） */
    api("/pools?gender=" + encodeURIComponent(wval("gender", "只看女性")) + "&nsfw=" + (wval("nsfw_filter", true) ? 1 : 0) + "&nsfwOnly=" + (wval("nsfw_only", false) ? 1 : 0))
      .then((p) => { slotPools = p || {}; renderGen(); })
      .catch(() => {});
    /* ⛔ 2026-10-06 对齐网页：**打开面板不自动抽词**（网页初始就是「0 个标签」，
       要结果得自己点「组合生成」）。原来这里 `roll()`，所以切档位时手上总有一组
       旧结果、看起来像"切档位自动抽了"。现在只渲染空态提示。 */
    renderResult();
    /* ⭐ 2026-10-20（阿君：切工作流再切回来，组合结果没了）：
       节点控件 panel_state 里存着上一次显示的这组，这里恢复出来。
       ⛔ 但「刚启动 ComfyUI」要空白 —— 用页面会话号区分：
          · 同一会话切走再切回 → sid 一致 → 恢复
          · 重启后第一次打开    → sid 不一致 → 不显示，只把 sid 换成本次的，
            之后再切走切回就能正常恢复。 */
    /* 说明：面板状态不在这里恢复 —— 见 renderResult 开头那段。
       原因是载入工作流时同一个节点会建**两次**面板，任何"初始化时机"的写法
       都可能落到没被挂上去的那个实例上。改成渲染时懒加载，谁渲染谁拿。 */
    /* 用户改动（含收藏夹）—— 到了就刷新计数/列表 */
    loadUserEdits()
      .then(() => { updateFavBtn(); renderFavs(); renderGen(); })
      .catch(() => {});
    /* ⛔ 2026-10-20（阿君：刚打开 ComfyUI 节点要完全干净，点上一组也不该翻出上次的 36 组）：
       历史不再从 data/hist.json 灌进面板 —— 那是跨会话的全局档案，会造成"没跑过却有历史"。
       现在历史跟着节点走：写进 panel_state，同一会话切回来才恢复。 */
  }).catch((e) => {
    sub.className = "pc-err";
    sub.textContent = "加载失败：" + e.message;
  });

  return {
    close,
    /* ⭐ 2026-11-22：「每次随机」换完 seed 后由 autoRollBeforeQueue 调用。
       必须**连词一起重抽** —— 只刷徽章的话，面板上还挂着上一组词，
       出图用的却是新 seed 那一组，两边对不上（正是 2026-10-19 那个坑的反方向）。
       重抽是异步发起、不等结果：排队已经提交出去了，这边慢慢算，算完自己覆盖面板。
       ⚠️ 这里**不换 seed**（只按当前 seed 重算），所以和出图那组必然同一批词。 */
    refreshSeed: () => {
      try { roll().catch(() => {}); } catch (e) {}
    },
  };

}
