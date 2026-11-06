/**
 * 行级 diff（LCS）。只服务「改稿提案」的对照展示，不追求与 GNU diff 逐字节一致。
 *
 * 为什么要自己做：公众号正文的改动九成是「某一段被换掉」，行级对照能让人一眼看出
 * 「删了哪句、加了哪句」。整段替换（旧 / 新两坨字并排放）看不出差异，等于没对照。
 *
 * 思路与 Deckline 的 `lib/diff.js` 同一套（MIT，见 README 致谢）；这里重写了两处：
 * 1. 用 `Int32Array` 而不是 `Uint16Array` 存 DP 表——正文单段上限 20000 字，
 *    行数超过 65535 时 Uint16 会静默溢出，`Int32` 不会；
 * 2. 加了 `DIFF_MAX_LINES` 上限。超长输入直接退化成「整体替换」，不让一次对照
 *    把浏览器卡住（O(n·m) 的表在 2000 行 × 2000 行时是 400 万格）。
 * @module lib/diff
 */

/** 单侧最大行数；超过就不再逐行比，退化成整体替换。 */
export const DIFF_MAX_LINES = 600;

/** @typedef {{type: "same"|"del"|"add", line: string}} DiffRow */

/**
 * 保守的行数判断：正文里 `\n\n` 分段，行数 ≈ 段数 × 2。超了就退化。
 * @param {string} text
 * @returns {string[]}
 */
export function splitLines(text) {
  // 统一换行：Windows 传来的 `\r\n` 与 `\n` 必须当成同一行，否则整篇都是"改动"
  return String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
}

/**
 * 行级差异（LCS 回溯）。
 * @param {string} oldText
 * @param {string} newText
 * @returns {{rows: DiffRow[], truncated: boolean, added: number, removed: number}}
 */
export function lineRows(oldText, newText) {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  // 完全一致：不做 DP，直接回一行 same（对照区据此显示"没有变化"）
  if (oldText === newText) {
    return { rows: [{ type: "same", line: oldLines[0] ?? "" }], truncated: false, added: 0, removed: 0 };
  }

  // 超长退化：不逐行比，整体标成「删全文 + 加全文」，并在 UI 上说明原因
  if (oldLines.length > DIFF_MAX_LINES || newLines.length > DIFF_MAX_LINES) {
    const rows = [
      { type: "del", line: oldText },
      { type: "add", line: newText },
    ];
    return { rows, truncated: true, added: 1, removed: 1 };
  }

  const n = oldLines.length;
  const m = newLines.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  /** @type {DiffRow[]} */
  const rows = [];
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      rows.push({ type: "same", line: oldLines[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: "del", line: oldLines[i] });
      removed += 1;
      i += 1;
    } else {
      rows.push({ type: "add", line: newLines[j] });
      added += 1;
      j += 1;
    }
  }
  while (i < n) {
    rows.push({ type: "del", line: oldLines[i] });
    removed += 1;
    i += 1;
  }
  while (j < m) {
    rows.push({ type: "add", line: newLines[j] });
    added += 1;
    j += 1;
  }
  return { rows, truncated: false, added, removed };
}

/**
 * 只保留有变化的片段（带上下文行），用于面板上省地方。
 * 段落正文动辄十几行，整篇铺开会把检查器撑到几屏之外。
 * @param {DiffRow[]} rows
 * @param {number} [context] 每个变更片段前后保留几行 context
 * @returns {{type: string, line: string, gap?: boolean}[]}
 */
export function focusRows(rows, context = 1) {
  const list = Array.isArray(rows) ? rows : [];
  const keep = new Set();
  list.forEach((row, index) => {
    if (row.type === "same") return;
    for (let k = Math.max(0, index - context); k <= Math.min(list.length - 1, index + context); k += 1) {
      keep.add(k);
    }
  });
  if (!keep.size) return [];

  const out = [];
  let previous = -2;
  for (const index of [...keep].sort((a, b) => a - b)) {
    if (index > previous + 1) out.push({ type: "gap", line: "" });
    out.push(list[index]);
    previous = index;
  }
  return out;
}

/**
 * 统一格式的 diff 文本（`@@` 块头 + 上下文行）。给 Agent 看、给日志看。
 * @param {string} oldText
 * @param {string} newText
 * @param {{context?: number, from?: string, to?: string}} [options]
 * @returns {string} 无差异时返回空串。
 */
export function lineDiff(oldText, newText, options = {}) {
  const { rows, truncated } = lineRows(oldText, newText);
  if (!rows.some((row) => row.type !== "same")) return "";

  const context = Number.isFinite(options.context) && options.context >= 0 ? Math.floor(options.context) : 2;
  const body = focusRows(rows, context)
    .map((row) => {
      if (row.type === "gap") return "  …";
      if (row.type === "add") return `+ ${row.line}`;
      if (row.type === "del") return `- ${row.line}`;
      return `  ${row.line}`;
    })
    .join("\n");
  const from = options.from ?? "a/before";
  const to = options.to ?? "b/after";
  const head = truncated ? "（内容过长，已退化为整体替换）" : "";
  return `--- ${from}\n+++ ${to}\n${head}${body}`;
}
