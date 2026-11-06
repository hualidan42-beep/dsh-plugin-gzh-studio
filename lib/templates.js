/**
 * 六套公众号排版风格（模板）。**纯数据**，宿主半与浏览器半共用同一份：
 * 宿主半随 `/api/gzh-studio.state` 下发 `templates`，浏览器半不内置副本
 * （单 bundle import 不到 lib/，抄一份就会漂）。
 *
 * 为什么是「token 而不是 CSS」：同一套 token 要喂给两个渲染器——
 *   1) 浏览器半的手机预览（React inline style）；
 *   2) 导出器（`lib/render.js`，全部内联 style，因为公众号后台会把 `<style>` 与 class 全剥掉）。
 * 只写一份 token，两边就不可能长得不一样。
 *
 * 字段口径：
 * - `ink/sub/accent/...` 一律十六进制色值，导出器直接拼进内联样式。
 * - `bodySize/bodyLine/paraGap` 单位 px / 倍数，落到手机预览与导出两侧。
 * - `h2Prefix` 是二级标题前缀字符（`""` 表示不加），`h2Bar` 控制左侧色条。
 * - `dropCap` 首字下沉只对正文第一段生效；`divider` 是段落分隔符形态。
 * @module lib/templates
 */

/**
 * @typedef {object} TemplateTokens
 * @property {string} ink        正文色
 * @property {string} sub        次要文字色
 * @property {string} accent     强调色（小标题色条 / 数字 / 链接）
 * @property {string} accentSoft 强调色浅底（引用块底色）
 * @property {string} bg         页面底色
 * @property {string} paper      卡片 / 引用块底色
 * @property {string} rule       分割线色
 * @property {string} font       正文字族
 * @property {string} fontTitle  标题字族
 * @property {number} bodySize   正文字号 px
 * @property {number} bodyLine   正文行高倍数
 * @property {number} paraGap    段间距 px
 * @property {number} h2Size     二级标题字号 px
 * @property {string} h2Prefix   二级标题前缀字符
 * @property {boolean} h2Bar     二级标题左侧色条
 * @property {boolean} dropCap   首字下沉
 * @property {"line"|"dots"|"none"} divider 段落分隔符
 * @property {number} radius     配图圆角 px
 * @property {boolean} imgShadow 配图投影
 * @property {number} letterSpacing 字距 px
 * @property {string} caption   图注色
 */

/**
 * 可读性基线 —— **不属于任何一套模板**。
 *
 * 依据两份互相独立的来源（135 编辑器排版指南、腾讯自家 wiki 排版指南），交集如下：
 *   正文字号 15px（14–16 区间里最通用的那个值）
 *   行高 1.75 倍（1.5–2 区间里的「万能值」）
 *   段间距 20px
 *   页边距 10px（8–16 区间的中位）
 *   正文色 #3f3f3f（两份都明确说：不要用纯黑，视觉太硬）
 *   配色 ≤ 3 种
 *
 * 为什么要单独抽出来，而不是留在各模板里：
 * **可读性不该是「风格」的一部分。** 风格是衬线还是黑体、主色是墨绿还是砖红；
 * 「15px 还是 17px」不是风格，是读者眼睛累不累。之前六套模板的正文从 15 到 17、
 * 行高从 1.8 到 2.1，等于让用户选一个「读起来最不吃力的」——那是设计缺陷，不是选项。
 *
 * 模板保留的调整空间：字族、主色、装饰（色条 / 首字下沉 / 分隔符 / 圆角）、
 * 以及**在基线上下 1px 内的字号微调**（12px 级差内的差异属于观感，不影响可读性）。
 */
export const READABILITY = {
  bodySize: 15,
  bodyLine: 1.75,
  paraGap: 20,
  padSide: 10,
  ink: "#3f3f3f",
  caption: "#8a8a8a",
  /** 模板允许的字号偏差：±1px。超过就是可读性问题，不是风格问题。 */
  sizeTolerance: 1,
  /** 全文主色上限（正文字色 + 强调色 + 图注/次要色，合计不超过 3 种有彩色）。 */
  maxAccents: 3,
};

/** 把模板 token 收进基线：越界的值拉回来，合法的保留。 */
export function clampTokens(tokens = {}) {
  const out = { ...tokens };
  const base = READABILITY.bodySize;
  const size = Number(tokens.bodySize) || base;
  out.bodySize = Math.min(base + READABILITY.sizeTolerance, Math.max(base - READABILITY.sizeTolerance, size));
  out.bodyLine = Math.min(1.9, Math.max(1.65, Number(tokens.bodyLine) || READABILITY.bodyLine));
  out.paraGap = Math.min(26, Math.max(16, Number(tokens.paraGap) || READABILITY.paraGap));
  out.padSide = Math.min(16, Math.max(8, Number(tokens.padSide) || READABILITY.padSide));
  return out;
}

/** 六套模板。顺序即面板里的展示顺序。 */
export const TEMPLATES = [
  {
    id: "business",
    name: "商务简报",
    desc: "蓝黑克制，小标题带色条。适合客户案例、复盘、方案说明。",
    tokens: {
      ink: "#3f3f3f", sub: "#6b7280", accent: "#1f6feb", accentSoft: "#f2f6fd",
      bg: "#ffffff", paper: "#f7f9fc", rule: "#e6e9ef",
      font: "-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif",
      fontTitle: "-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif",
      bodySize: 15, bodyLine: 1.75, paraGap: 20, h2Size: 19, padSide: 10,
      h2Prefix: "", h2Bar: true, dropCap: false, divider: "line",
      radius: 8, imgShadow: false, letterSpacing: 0.2, caption: "#8a93a0",
    },
  },
  {
    id: "magazine",
    name: "杂志编辑",
    desc: "衬线标题 + 首字下沉 + 红点缀。适合品牌故事、人物、长文。",
    tokens: {
      ink: "#3f3f3f", sub: "#6b655c", accent: "#c0392b", accentSoft: "#fdf3f1",
      bg: "#fffdf9", paper: "#f7f3ea", rule: "#e8e0d2",
      font: "Georgia,'Songti SC','SimSun',serif",
      fontTitle: "Georgia,'Songti SC','SimSun',serif",
      bodySize: 16, bodyLine: 1.85, paraGap: 22, h2Size: 21, padSide: 12,
      h2Prefix: "—", h2Bar: false, dropCap: true, divider: "dots",
      radius: 2, imgShadow: false, letterSpacing: 0.4, caption: "#9a8f80",
    },
  },
  {
    id: "jp-minimal",
    name: "日系清简",
    desc: "留白大、字距松、细线分隔。适合方法论、清单、观点输出。",
    tokens: {
      ink: "#3f3f3f", sub: "#8a8a8a", accent: "#7a8f7b", accentSoft: "#f3f6f3",
      bg: "#ffffff", paper: "#fafafa", rule: "#eeeeee",
      font: "'Hiragino Sans GB','PingFang SC','Microsoft YaHei',sans-serif",
      fontTitle: "'Hiragino Sans GB','PingFang SC','Microsoft YaHei',sans-serif",
      bodySize: 15, bodyLine: 2.1, paraGap: 30, h2Size: 18,
      h2Prefix: "", h2Bar: false, dropCap: false, divider: "line",
      radius: 4, imgShadow: false, letterSpacing: 1.2, caption: "#a8a8a8",
    },
  },
  {
    id: "blueprint",
    name: "科技蓝图",
    desc: "青蓝网格感、等宽数字。适合产品、技术、数据解读。",
    tokens: {
      ink: "#3f3f3f", sub: "#5a7280", accent: "#0b8ba6", accentSoft: "#eaf7fa",
      bg: "#fbfdfe", paper: "#eff7f9", rule: "#d6e6ea",
      font: "'SF Mono','JetBrains Mono','PingFang SC','Microsoft YaHei',monospace",
      fontTitle: "'PingFang SC','Microsoft YaHei',sans-serif",
      bodySize: 15, bodyLine: 1.8, paraGap: 20, h2Size: 19,
      h2Prefix: "//", h2Bar: false, dropCap: false, divider: "line",
      radius: 6, imgShadow: false, letterSpacing: 0.1, caption: "#7e97a1",
    },
  },
  {
    id: "paper",
    name: "手账纸质",
    desc: "米色纸感、虚线下划线。适合随笔、复盘、内部信。",
    tokens: {
      ink: "#402f22", sub: "#8b8171", accent: "#b07a3c", accentSoft: "#fbf4e9",
      bg: "#fdfaf3", paper: "#f6efe0", rule: "#e0d5bf",
      font: "'Kaiti SC','KaiTi','Songti SC',serif",
      fontTitle: "'Kaiti SC','KaiTi','Songti SC',serif",
      bodySize: 17, bodyLine: 2.0, paraGap: 24, h2Size: 21,
      h2Prefix: "✎", h2Bar: false, dropCap: false, divider: "dots",
      radius: 3, imgShadow: false, letterSpacing: 0.5, caption: "#a2957f",
    },
  },
  {
    id: "night",
    name: "夜间深色",
    desc: "深底浅字，适合观点、夜读。注意：公众号深底长文完读率通常低于浅底。",
    tokens: {
      ink: "#e8e8ea", sub: "#9aa0a8", accent: "#5ec8c6", accentSoft: "#1c2528",
      bg: "#16181c", paper: "#1f2329", rule: "#2c3138",
      font: "-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif",
      fontTitle: "-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif",
      bodySize: 16, bodyLine: 1.9, paraGap: 24, h2Size: 20,
      h2Prefix: "", h2Bar: true, dropCap: false, divider: "line",
      radius: 8, imgShadow: true, letterSpacing: 0.3, caption: "#7d848c",
    },
  },
];

/** 默认模板 id。 */
export const DEFAULT_TEMPLATE = "business";

/**
 * 按 id 取模板；未知 id 退回默认（面板拿到的一定是可渲染的 token 集）。
 * @param {string} id
 * @returns {(typeof TEMPLATES)[number]}
 */
export function templateOf(id) {
  const hit = TEMPLATES.find((t) => t.id === id)
    ?? TEMPLATES.find((t) => t.id === DEFAULT_TEMPLATE)
    ?? TEMPLATES[0];
  // 出口处统一收进可读性基线：**渲染的两条路（手机预览、导出 HTML）都从这里取 token**，
  // 所以在这一处 clamp 就够，不需要在每个模板里手写合规值——手写的东西迟早会漂。
  return { ...hit, tokens: clampTokens(hit.tokens) };
}

/** 模板 id 白名单（校验用）。 */
export const TEMPLATE_IDS = TEMPLATES.map((t) => t.id);
