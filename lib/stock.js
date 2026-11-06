/**
 * 库存：有多少篇、各在什么状态、搜得到吗。
 *
 * 为什么单独一层：这三件事是用户打开工作台**第一眼**要的（「我手上有多少活」），
 * 而流水线状态回答的是另一个问题（「这一篇卡在哪」）。两个维度混在一处，
 * 「多少篇已发布」就永远答不出来——因为流水线只有绑了期号的文章才算得出。
 *
 * 三条口径：
 * 1. **检索文本不下发**。正文拼起来的字符串可能几十 KB，首屏载荷不该带它。
 *    服务端搜、服务端过滤，前端只收命中项。
 * 2. **计数与列表来自同一次读取**。分成两次请求会出现「说 5 篇、列表 4 篇」。
 * 3. **状态来源要标出来**。`published` 是人工标的，不是验过的——面板必须能区分，
 *    否则用户会以为插件真知道发布状态。
 */

import { LIFECYCLE, LIFECYCLE_VALUES } from "./store.js";

/** 状态的中文名与排序权重（草稿在最前：那是有待处理的部分）。 */
export const LIFECYCLE_META = {
  [LIFECYCLE.DRAFT]: { label: "草稿", order: 0 },
  [LIFECYCLE.IN_DRAFT_BOX]: { label: "草稿箱", order: 1 },
  [LIFECYCLE.PUBLISHED]: { label: "已发布", order: 2 },
};

/** 把一条列表项压成前端要的形状：**去掉检索文本**，其余保留。 */
export function stripSearch(row) {
  const { search, ...rest } = row ?? {};
  return rest;
}

/**
 * 计数。除了三个状态，还要给两个「作者真的关心」的数字：
 * - `empty`：一篇正文都没有的空壳（用户建了但没写，最该被提醒）
 * - `unbound`：没绑期号的（流水线判不出来，进度靠猜）
 *
 * @param {object[]} rows
 */
export function counts(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byState = { [LIFECYCLE.DRAFT]: 0, [LIFECYCLE.IN_DRAFT_BOX]: 0, [LIFECYCLE.PUBLISHED]: 0 };
  let empty = 0;
  let unbound = 0;
  let images = 0;
  for (const row of list) {
    const state = row?.lifecycle?.value;
    if (byState[state] !== undefined) byState[state] += 1;
    if (row?.empty) empty += 1;
    if (!row?.pipeline?.episodeId) unbound += 1;
    images += Number(row?.images) || 0;
  }
  return {
    total: list.length,
    byState,
    empty,
    unbound,
    images,
    // 标签清单（带计数、按用得多的排前面）：前端要直接能点，不必自己去聚合
    tags: tagCounts(list),
    // 月份归档：目录检索的另一个入口（「上个月我写了什么」）
    months: monthCounts(list),
    // 「进行中」= 总数减去已发布。用户嘴里的「还在弄的」就是这部分。
    active: list.length - byState[LIFECYCLE.PUBLISHED],
  };
}

/** 标签聚合：每个标签多少篇，按篇数降序、同数按字母序（结果稳定，不会每次刷新换顺序）。 */
export function tagCounts(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    for (const tag of Array.isArray(row?.tags) ? row.tags : []) {
      const key = String(tag ?? "").trim();
      if (!key) continue;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh"));
}

/** 月份聚合：`2026-10` → 篇数。用更新时间，作者记的是「我上个月动过的」。 */
export function monthCounts(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const ts = Number(row?.updatedAt) || 0;
    if (!ts) continue;
    const d = new Date(ts);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([month, count]) => ({ month, count }))
    .sort((a, b) => b.month.localeCompare(a.month));
}

/** 搜索匹配：分词后逐个 AND，全部命中才算。空词返回全部。 */
export function matches(row, query) {
  const terms = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = String(row?.search ?? "");
  return terms.every((term) => hay.includes(term));
}

/**
 * 一次给出：计数 + 过滤后的列表。
 *
 * 过滤维度：状态（可多选）、搜索词、是否只列空壳。
 * 三个维度是**与**关系——用户要的是「已发布里搜『审批』」，不是任选其一。
 *
 * @param {object[]} rows listArticles 的原样输出（含 search）
 * @param {{state?: string, q?: string, empty?: boolean}} [options]
 */
export function stock(rows, options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  // 状态词必须**先校验再使用**：传进来一个笔误的状态词（`draf`）如果直接拿去比对，
  // 会筛出 0 篇 —— 用户看到的是「文章全没了」，而不是「筛选条件写错了」。
  // 非法值当作不筛，宁可多显示也不能让库看起来是空的。
  const raw = String(options.state ?? "").trim();
  const state = raw === "all" ? "" : checkState(raw);
  const q = String(options.q ?? "").trim();
  const onlyEmpty = options.empty === true;

  const tag = String(options.tag ?? "").trim();
  const month = String(options.month ?? "").trim();

  const filtered = list.filter((row) => {
    if (state && row?.lifecycle?.value !== state) return false;
    if (onlyEmpty && !row?.empty) return false;
    // 标签精确匹配（不区分大小写）：点「GxP」不该把「gxp 合规」也漏掉
    if (tag) {
      const has = (Array.isArray(row?.tags) ? row.tags : [])
        .some((x) => String(x ?? "").toLowerCase() === tag.toLowerCase());
      if (!has) return false;
    }
    if (month) {
      const ts = Number(row?.updatedAt) || 0;
      const d = new Date(ts);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      if (key !== month) return false;
    }
    if (!matches(row, q)) return false;
    return true;
  });

  return {
    // 计数基于**全量**，不是过滤后的：用户改了筛选条件，顶上的总数不该跟着变
    counts: counts(list),
    filters: { state: state || "all", q, tag, month, empty: onlyEmpty, invalid: Boolean(raw && raw !== "all" && !state) },
    articles: filtered.map(stripSearch),
    matched: filtered.length,
  };
}

/** 校验状态词，非法返回空串（不让前端传什么就信什么）。 */
export const checkState = (value) => {
  const text = String(value ?? "").trim();
  return LIFECYCLE_VALUES.includes(text) ? text : "";
};
