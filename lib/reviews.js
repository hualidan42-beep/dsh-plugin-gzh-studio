/**
 * 05 编辑审 / 06 读者审 两份清单的**逐项确认**。
 *
 * 这两道门原来在盘上只有一个 `self-review` 文件名，状态机只能判「文件在不在」，
 * 判不出「十条问题真答了吗」。结果就是：文件一放上去门就绿了，而清单里可能一片空白。
 *
 * 现在把两份 SKILL.md 的「验收」小节搬进面板（**文案逐字取原文，不自造条目**），
 * 人在面板里逐项勾，勾完即视为这道门过。
 *
 * ## 为什么要「本地存」
 *
 * 勾选状态**不写回真实仓**。理由：那个仓是内容生产的事实源，插件往里面塞一份
 * `panel-checklist.json`，会让「盘上有什么」变得说不清——下游脚本扫到它怎么办？
 * 所以勾选存在插件自己的 `<root>/articles/<id>/reviews.json` 里，
 * 与 `article.json` 同级、同一个 id 作用域。它记的是**面板上的确认动作**，
 * 不是内容事实，两者不该混在一个地方。
 *
 * ## 与「盘上证据」的关系
 *
 * 面板勾选**不能替代**盘上的清单文件。状态机判 gate 5 时的顺序是：
 * 盘上有 self-review → ok（原有判据，优先）；盘上说了但没有 → 面板勾选全过也可判 ok，
 * 但 detail 里必须写明「依据是面板确认，不是盘上清单」。**两种证据要能区分。**
 * @module lib/reviews
 */

/**
 * 两份清单的验收项。**逐字取自**
 * `shareable-skills/wechat/05-editor-review/SKILL.md` 与 `06-reader-review/SKILL.md`
 * 的「## 验收」小节。改 SKILL 就要改这里，`verify/reviews-unit.mjs` 有断言钉死条数。
 */
export const CHECKLISTS = {
  editor: {
    id: "editor",
    no: 5,
    label: "编辑审",
    skill: "wechat-05-editor-review",
    /** 这份清单回答什么问题。取自 SKILL 的定位，不是编的。 */
    about: "十条问题逐条答是/否，指到位置；只指问题，不给修改建议。",
    items: [
      { id: "e1", text: "十条问题逐条答了是/否，无遗漏" },
      { id: "e2", text: "每一条答否都指到了位置（段落号 / 摘引 / 小标题）" },
      { id: "e3", text: "结构性四条中答否的，已写明「建议退回 03-angles」" },
      { id: "e4", text: "「结尾有没有互动」已单独判定" },
      { id: "e5", text: "画面感判据引用 immersion-check.md，未复制其定义" },
      { id: "e6", text: "清单顶部注明所审稿件的 SHA-256" },
      { id: "e7", text: "清单可与读者审的清单并排对照（同段落可对齐）" },
      { id: "e8", text: "未改稿（一个字符都没动）" },
    ],
  },
  reader: {
    id: "reader",
    no: 6,
    label: "读者审",
    skill: "wechat-06-reader-review",
    about: "按目标读者每类各读一遍，记「读到哪」和三种反应；一个字符都不改。",
    items: [
      { id: "r1", text: "按目标读者每类各读一遍，读者画像与立项记录一致" },
      { id: "r2", text: "每位读者都记了「读到哪」" },
      { id: "r3", text: "三种反应（读不下去 / 不信 / 想划走）逐条有记录，含原句摘引" },
      { id: "r4", text: "一个字符都没改稿" },
      { id: "r5", text: "清单里没有修改建议（修改建议属编辑审与 04-write）" },
      { id: "r6", text: "清单顶部注明所审稿件的 SHA-256" },
      { id: "r7", text: "清单可与编辑审的清单并排对照" },
      { id: "r8", text: "未把两份清单合并成一份" },
    ],
  },
};

/** 两份清单的稳定顺序。 */
export const CHECKLIST_ORDER = ["editor", "reader"];

/** 清单 id 白名单。 */
export const CHECK_KIND = /^(editor|reader)$/;
/** 条目 id 白名单（`e1`…`e8` / `r1`…`r8`）。 */
export const CHECK_ITEM = /^[er][1-8]$/;

/**
 * 空状态。
 * @returns {{v: number, items: Record<string, {at: number, note?: string}>, updatedAt: number}}
 */
export function emptyReviews() {
  return { v: 1, items: {}, updatedAt: 0 };
}

/**
 * 归一化从盘上读出来的东西。坏数据（手改、写一半）当空，不整体失败。
 *
 * 只认白名单里的 key：账号里塞了 `../../etc` 这种条目，绝不能让它在后面拼路径或渲染。
 * @param {object} raw
 */
export function normalizeReviews(raw) {
  const out = emptyReviews();
  const items = raw?.items && typeof raw.items === "object" ? raw.items : {};
  for (const [key, value] of Object.entries(items)) {
    // 用 `split(".")` 后**必须核对段数**：`reader.r1.extra` 拆出三段，
    // 只看前两段会让这种 key 混进来，后面渲染或拼路径就成了不可控输入。
    const parts = String(key).split(".");
    if (parts.length !== 2) continue;
    const [kind, itemId] = parts;
    if (!CHECK_KIND.test(kind) || !CHECK_ITEM.test(itemId)) continue;
    if (!value || typeof value !== "object") continue;
    // 条目 id 的前缀必须与清单匹配，否则会出现「编辑审清单里勾了 r1」这种不可能状态
    if (itemId[0] !== (kind === "editor" ? "e" : "r")) continue;
    out.items[key] = {
      at: Number(value.at) || 0,
      note: typeof value.note === "string" ? value.note.slice(0, 200) : "",
    };
  }
  out.updatedAt = Number(raw?.updatedAt) || 0;
  return out;
}

/**
 * 勾 / 取消勾一项。返回新状态（不改入参）。
 *
 * `checked=false` 是**删除**这个 key，不是存一个 false——
 * 「没勾过」和「勾过又取消」在判据上是一回事，存两种状态只会让下游多一处判断。
 * @param {object} state
 * @param {string} kind `editor` / `reader`
 * @param {string} itemId `e1`…`r8`
 * @param {boolean} checked
 * @param {number} [now]
 */
export function toggleItem(state, kind, itemId, checked, now = Date.now()) {
  const next = normalizeReviews(state);
  const key = `${kind}.${itemId}`;
  if (!CHECK_KIND.test(String(kind ?? "")) || !CHECK_ITEM.test(String(itemId ?? ""))) return next;
  if (checked) {
    if (!next.items[key]) next.items[key] = { at: now, note: "" };
  } else {
    delete next.items[key];
  }
  next.updatedAt = now;
  return next;
}

/**
 * 一份清单现在的状态。
 * @param {object} state
 * @param {string} kind
 * @returns {{kind: string, label: string, done: number, total: number, ok: boolean,
 *   items: object[], missing: string[]}}
 */
export function checklistState(state, kind) {
  const spec = CHECKLISTS[kind];
  if (!spec) return null;
  const norm = normalizeReviews(state);
  const items = spec.items.map((item) => {
    const hit = norm.items[`${kind}.${item.id}`];
    return { ...item, checked: Boolean(hit), at: hit?.at ?? 0 };
  });
  const done = items.filter((item) => item.checked).length;
  return {
    kind,
    label: spec.label,
    no: spec.no,
    skill: spec.skill,
    about: spec.about,
    done,
    total: items.length,
    ok: done === items.length,
    items,
    missing: items.filter((item) => !item.checked).map((item) => item.text),
  };
}

/**
 * 两份一起看。
 * @param {object} state
 */
export function reviewStatus(state) {
  const list = CHECKLIST_ORDER.map((kind) => checklistState(state, kind));
  const done = list.reduce((sum, one) => sum + one.done, 0);
  const total = list.reduce((sum, one) => sum + one.total, 0);
  return {
    list,
    done,
    total,
    /** 两份都勾满才算这道门过 */
    ok: list.every((one) => one.ok),
    /** 还差几项，给人话进度用 */
    remaining: total - done,
  };
}

/**
 * 面板勾选与盘上清单的对账。**这是本模块最要紧的一件事**：
 * 让人知道「我勾的这些，盘上到底有没有对应的证据」。
 *
 * @param {{editor: boolean, reader: boolean, shaBound: boolean}} disk 盘上查到什么
 * @param {object} state 面板勾选
 * @returns {{level: string, text: string}}
 */
export function reconcile(disk, state) {
  const view = reviewStatus(state);
  if (!view.done) {
    if (disk?.editor && disk?.reader) {
      return { level: "ok", text: "盘上两份清单都在，面板还没逐项确认过。要留下「我核过了」的记录，就逐项勾一遍。" };
    }
    return { level: "todo", text: "还没逐项确认。两份清单共 16 项，勾完这道门才算过。" };
  }
  if (view.ok && disk?.editor && disk?.reader) {
    return { level: "ok", text: `两份清单都勾满了，盘上也有对应的清单文件${disk.shaBound ? "（且绑了当前稿的哈希）" : ""}。` };
  }
  if (view.ok && !(disk?.editor && disk?.reader)) {
    return {
      level: "warn",
      text: `面板上 16 项都勾了，但盘上缺${[disk?.editor ? "" : "编辑审", disk?.reader ? "" : "读者审"].filter(Boolean).join("、")}清单文件。勾选只是「我看过了」的记录，不能替代清单本身。`,
    };
  }
  return { level: "todo", text: `已勾 ${view.done}/${view.total} 项，还差 ${view.remaining} 项。` };
}
