/**
 * 反馈绑定（第 4 轮改造的核心）。**纯函数**，只读账本事件，不碰文件。
 *
 * 解决的真问题：原来的「记一句反馈」只是往账本里追加一行 `{type:"feedback", slot, vid, verbatim}`，
 * 然后又没有下文——下一版出图不会带上它，改稿也不会带上它。用户写的那句话，
 * 记完就沉底了，等于让他把同一句不满意的意见说三遍。
 *
 * 两条设计口径：
 *
 * 1. **不新增事实源**。反馈仍然只存账本（append-only），「这条用没用过」也不写回反馈行，
 *    而是由「后面有没有哪次出图/提案引用了它」**推**出来。理由和 pipeline 那边一致：
 *    两处记同一件事，早晚会不一致。
 * 2. **消费要留名**。出图或提案带上哪几条反馈，必须记在那次动作的事件里
 *    （`feedback: [ts...]`）。否则「这条到底改没改」永远说不清，用户会觉得话白说了。
 *
 * @module lib/feedback
 */

/** 一条反馈在账本里最多留多少字（防止一次粘贴把账本撑爆）。 */
export const VERBATIM_MAX = 500;

/** 反馈文本归一：去首尾空白、压空行、截断。 */
export function cleanVerbatim(text) {
  return String(text ?? "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, VERBATIM_MAX);
}

/**
 * 反馈的稳定 key = 时间戳。
 *
 * **不能用账本行号**：同一份账本按槽位过滤后行号会变，换个查询就对不上了。
 * 时间戳是账本自己写的，跟查询方式无关。同毫秒撞了才补后缀（`1712...-2`），
 * 那种情况只手写账本才会出现。
 * @param {number} ts
 * @param {number} [dup] 同毫秒的第几条（从 2 起）
 */
export function keyOf(ts, dup = 1) {
  const stamp = Number(ts) || 0;
  return dup > 1 ? `${stamp}-${dup}` : String(stamp);
}

/**
 * 把账本折成「每条反馈现在什么状态」。
 *
 * @param {object[]} ledger 账本事件（旧→新）
 * @param {{slot?: string}} [options] 只取某个槽位的（`cover` / `sec-s3`）
 * @returns {{all: object[], open: object[], used: object[]}}
 *   - `open` 还没被任何出图/提案引用过
 *   - `used` 已被引用（带 `usedBy` 那次动作）
 */
export function collectFeedback(ledger, options = {}) {
  const rows = Array.isArray(ledger) ? ledger : [];
  const slotFilter = String(options.slot ?? "");

  // 先扫一遍「谁引用了谁」：出图 / 提案事件里的 feedback 数组就是消费凭据
  /** @type {Map<string, object>} 反馈 key → 消费它的那次动作 */
  const consumed = new Map();
  for (const event of rows) {
    const refs = Array.isArray(event?.feedback) ? event.feedback : [];
    if (!refs.length) continue;
    for (const ref of refs) {
      const key = String(ref);
      if (!key) continue;
      // 同一 key 被引用多次时，记**第一次**——那是它真正被带上的那次
      if (!consumed.has(key)) consumed.set(key, event);
    }
  }

  // 同毫秒撞 key 时按出现顺序补后缀，和 keyOf 的约定一致
  const seen = new Map();
  const all = [];
  for (const event of rows) {
    if (event?.type !== "feedback") continue;
    const slot = String(event.slot ?? "");
    if (slotFilter && slot !== slotFilter) continue;
    const verbatim = cleanVerbatim(event.verbatim);
    if (!verbatim) continue;
    const ts = Number(event.ts) || 0;
    const dup = (seen.get(ts) ?? 0) + 1;
    seen.set(ts, dup);
    const key = keyOf(ts, dup);
    const user = consumed.get(key) ?? null;
    all.push({
      key,
      ts,
      slot,
      /** 写这条反馈时看到的是哪一版图（可能为空：改稿反馈没有版本） */
      vid: String(event.vid ?? ""),
      verbatim,
      used: Boolean(user),
      usedAt: Number(user?.ts) || 0,
      usedBy: String(user?.type ?? ""),
    });
  }

  return {
    all,
    open: all.filter((row) => !row.used),
    used: all.filter((row) => row.used),
  };
}

/**
 * 出一张图 / 提一份提案时，该带上哪些反馈。
 *
 * 只带**同槽位的 open**，且**只带比这次动作早的**（时间旅行不可能，但账本可能是
 * 手改过或并发写进来的，所以还是筛一遍）。
 *
 * @param {object[]} ledger
 * @param {{slot: string, before?: number, keys?: string[]}} options
 *   `keys` 给了就只带这几条（面板上人手动勾掉的就不带）
 * @returns {object[]}
 */
export function pickFeedback(ledger, options = {}) {
  const slot = String(options.slot ?? "");
  const before = Number(options.before) || Number.MAX_SAFE_INTEGER;
  const wanted = Array.isArray(options.keys) ? new Set(options.keys.map(String)) : null;
  return collectFeedback(ledger, { slot }).open
    .filter((row) => row.ts <= before)
    .filter((row) => !wanted || wanted.has(row.key));
}

/**
 * 把反馈拼成「这一版要注意什么」的指令段落，追加在 prompt 后面。
 *
 * 为什么拼进 prompt 而不是只显示在界面上：出图是异步的、一次性的，
 * 界面上写一行提示，模型看不到；反馈要真的影响这一版，只能进 prompt。
 * 但**拼接必须显式**——出图事件里要记下带了哪几条，这样「这版为什么长这样」查得到。
 *
 * 中文反馈直接拼在英文 prompt 后面是可行的（主流图像模型都吃混合语言），
 * 所以不翻译——翻译会丢语气，而语气往往是反馈的全部信息量。
 *
 * @param {object[]} items
 * @returns {string} 没有反馈时返回空串
 */
export function promptSuffix(items) {
  const list = (Array.isArray(items) ? items : []).map((row) => row?.verbatim).filter(Boolean);
  if (!list.length) return "";
  const lines = list.map((text, index) => `${index + 1}. ${text.replace(/\s*\n\s*/g, " ")}`);
  return `\n\n这一版必须修正上一版的这些问题（人看过图提出的）：\n${lines.join("\n")}`;
}

/**
 * 反馈列表的一句话摘要（面板顶部用）。
 * @param {{open: object[], used: object[]}} view
 */
export function feedbackSummary(view) {
  const open = view?.open?.length ?? 0;
  const used = view?.used?.length ?? 0;
  if (!open && !used) return { level: "none", text: "还没记过反馈。看到不对的地方，就地写一句。" };
  if (!open) return { level: "ok", text: `${used} 条反馈都已经带进后面的版本了。` };
  return { level: "todo", text: `${open} 条反馈还没带进下一版——下次出图/改稿会自动带上。` };
}
