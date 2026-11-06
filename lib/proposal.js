/**
 * 改稿提案（proposal）：把「Agent 想改什么」和「正文真的变成什么」分开。
 *
 * 为什么要有这一层：`/save` 与 `/script` 是直接覆盖 `article.json` 的。账本能告诉你
 * 「改了什么」，但拦不住「改坏」——一次写错，正文就没了，只能翻账本手抄回来。
 * 提案把 Agent 的写入拆成两步：**先落提案（不动正文）、人看过对照再确认**。
 * 这套流程与 Deckline 的 proposal → waiting-user → confirm/reject 是同一套（见 README 致谢）。
 *
 * 三条纪律：
 * 1. **本模块纯函数**，不读写文件、不碰时钟以外的 IO（时间由入参传入，单测可钉死）；
 * 2. **提案只描述「打算写什么」**，真正的写入仍然走 `index.js` 的 `applyPatch` / 同一套落盘，
 *    绝不另开一条写入路径——否则会出现「UI 确认了但正文没按确认的内容写」的两套账；
 * 3. **漂移检查**：提案记下创建时的正文内容哈希 `baseHash`（老提案只有 `baseUpdatedAt`）。
 *    确认时比哈希：**只有读者可见文字变了才算过期**。绑定期号、换配图版本这类操作
 *    也会推高 `updatedAt`，但正文一个字没动，不该让提案作废（踩过：被判"已过期"后重提了一遍同一份东西）。
 * @module lib/proposal
 */

import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { lineRows } from "./diff.js";

/** 提案状态。`waiting-user` 之外都是终态。 */
export const PROPOSAL_STATUS = {
  waiting: "waiting-user",
  confirmed: "confirmed",
  rejected: "rejected",
};

/** 终态：不能再裁决。 */
export const PROPOSAL_FINAL = [PROPOSAL_STATUS.confirmed, PROPOSAL_STATUS.rejected];

/** 提案 id 白名单：`p-<8 位十六进制>`。 */
export const PID_PATTERN = /^p-[0-9a-f]{8}$/;

/** 校验提案 id（不合法回 null，调用方 400，绝不进 join）。 */
export const checkPid = (pid) => (PID_PATTERN.test(String(pid ?? "").trim()) ? String(pid).trim() : null);

/** 新提案 id。 */
export function newPid() {
  return `p-${randomBytes(4).toString("hex")}`;
}

/** 段落 id 白名单（与 store 同口径）。 */
const SECTION_ID = /^s[0-9]{1,4}$/;

/** 单篇段落上限（与 `applyPatch` / `writeScript` 一致）。 */
/**
 * 改动性质：**这一步决定提案该退到哪，而不是由谁说了算**。
 *
 * 依据 `wechat/07-deai/SKILL.md` 的红线：07 只改词句，**不改标题、不改摘要、不动图**；
 * 发现是结构问题必须退回 `04-write`；改标题要退 `03-angles`，或整篇只允许在第 11 步改一次并留痕。
 *
 * 判据是「改了什么」，不是「改了多少字」。三段各改一个错别字是 `polish`，
 * 一段被拆成两段才是 `structure`。所以分类只看 target 的**种类**，不看正文长度差异。
 */
export const KINDS = {
  /** 只动段落正文/小标题，不改标题摘要、不增删段：退 07（改词句，要重核重签） */
  polish: "polish",
  /** 增删段落、或小标题与正文同时改（多半是重写这一段）：退 04 */
  structure: "structure",
  /** 动标题/副标题：退 03，或第 11 步改一次并留痕 */
  title: "title",
  /** 动摘要：不属于 07 的许可范围，按 11 步的标题口径处理 */
  summary: "summary",
};

/** 每一种性质要退到哪一步、哪条 skill、红线一句话。文案直接给编辑看。 */
export const KIND_ROUTE = {
  [KINDS.polish]: {
    label: "改词句",
    step: "07-deai",
    skill: "wechat-07-deai",
    rule: "只改词句：不许动标题、摘要、配图。改完要重核、重新交稿确认。",
  },
  [KINDS.structure]: {
    label: "改结构",
    step: "04-write",
    skill: "wechat-04-write",
    rule: "动了段落增删或整段重写：退第 4 步重写，之后编辑审与读者审要重跑。",
  },
  [KINDS.title]: {
    label: "改标题",
    step: "03-angles",
    skill: "wechat-03-angles",
    rule: "标题在方案阶段就定了：要么退第 3 步重挑，要么整篇只在第 11 步改一次并留痕。",
  },
  [KINDS.summary]: {
    label: "改摘要",
    step: "11-digest-draft",
    skill: "wechat-11-digest-draft",
    rule: "摘要的正式修订点在第 11 步（推草稿前）。",
  },
};

/** 每一种性质要退到哪一步。数值即步号——混着改时按「退得最远的那一步」定性质。 */
const KIND_STEP = {
  [KINDS.title]: 3,
  [KINDS.structure]: 4,
  [KINDS.polish]: 7,
  [KINDS.summary]: 11,
};

/**
 * 从改动清单推出性质。**只看种类，不看字数**。
 *
 * 混着改时取**退得最远的那一步**：同时动了摘要和段落结构，不能只退到 11（改摘要），
 * 得先退 4 把结构改完，摘要最后再说。反过来「结构 + 标题」按标题算（退 3），
 * 因为标题一定，后面的结构还得跟着重排。
 *
 * @param {object[]} changes
 * @returns {string} KINDS 之一
 */
export function inferKind(changes) {
  const list = Array.isArray(changes) ? changes : [];
  const fields = new Set(list.map((item) => item?.field ?? ""));
  const hit = [];
  if (fields.has("title") || fields.has("subtitle")) hit.push(KINDS.title);
  if (fields.has("summary")) hit.push(KINDS.summary);
  if (fields.has("new-section") || fields.has("removed-section")) hit.push(KINDS.structure);
  // 同一段的小标题与正文同时改 = 重写这一段，按结构算
  const headed = new Set();
  const bodied = new Set();
  for (const item of list) {
    const match = String(item?.target ?? "").match(/^section:(s[0-9]{1,4}):(heading|body)$/);
    if (!match) continue;
    if (match[2] === "heading") headed.add(match[1]);
    else bodied.add(match[1]);
  }
  for (const id of headed) if (bodied.has(id)) hit.push(KINDS.structure);
  if (!hit.length) return KINDS.polish;
  // 步号最小的那个 = 退得最远的那一步
  return hit.reduce((best, kind) => (KIND_STEP[kind] < KIND_STEP[best] ? kind : best), hit[0]);
}

/** 除主性质之外还动了哪些东西（给编辑看「这份还捎带了什么」）。 */
export function alsoTouches(changes) {
  const list = Array.isArray(changes) ? changes : [];
  const fields = new Set(list.map((item) => item?.field ?? ""));
  const out = [];
  if (fields.has("title") || fields.has("subtitle")) out.push("标题");
  if (fields.has("summary")) out.push("摘要");
  if (fields.has("new-section") || fields.has("removed-section")) out.push("段落增删");
  return out;
}

/**
 * 核对「声明的性质」与「实际改动」是否自洽。
 *
 * 为什么要这一步：Agent 声明 `polish`（只说改词句）却顺手把摘要也改了，
 * 按 07 的红线这是越权。**声明不能当免责声明用**——所以直接查「改动里有没有 07 禁碰的东西」，
 * 而不是绕一圈比对推断结果（`polish + 摘要` 混着改时推断会落在 polish，比对就漏了）。
 *
 * 返回空串表示通过；否则是一句能直接显示给编辑的拒绝理由。
 */
export function checkKind(declared, changes) {
  const kind = String(declared ?? "").trim();
  if (!kind) return ""; // 没声明就只做推断，不拦（人工提案不受影响）
  if (!Object.values(KINDS).includes(kind)) {
    return `性质只认 ${Object.values(KINDS).join(" / ")}，收到「${kind}」`;
  }
  if (kind !== KINDS.polish) return ""; // 只有 polish 是有明确禁区的一档

  const list = Array.isArray(changes) ? changes : [];
  const fields = new Set(list.map((item) => item?.field ?? ""));
  const violations = [];
  if (fields.has("title") || fields.has("subtitle")) violations.push("标题");
  if (fields.has("summary")) violations.push("摘要");
  if (fields.has("new-section") || fields.has("removed-section")) violations.push("段落增删");
  if (!violations.length) return "";
  return `声明是「改词句」，但改动里有${violations.join("、")} —— 07 的规矩是不许动标题、摘要、配图，也不增删段落。请按实际性质重报（改结构退 04，改标题退 03）。`;
}

const MAX_SECTIONS = 24;
/** 字段截断（与 `index.js` 的 MAX_LEN 一致）。 */
const MAX_LEN = { title: 200, subtitle: 400, summary: 400 };
const MAX_BODY = 20_000;
const MAX_HEADING = 200;
const MAX_NOTE = 200;

/** 抛一个带 HTTP 状态的错（路由层直接读 `error.status`）。 */
function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

/** 变化项的一句话标签。 */
const SECTION_LABEL = (index) => `第 ${index + 1} 段`;

/**
 * 建一条变化记录。长文本带行级对照，短字段（标题）也带——改标题恰恰最需要看清。
 * @param {object} input
 * @returns {object}
 */
function change(input) {
  const before = String(input.before ?? "");
  const after = String(input.after ?? "");
  const withDiff = input.withDiff !== false && (before || after);
  return {
    target: input.target,
    field: input.field,
    label: input.label,
    slot: input.slot ?? "",
    before,
    after,
    diff: withDiff ? lineRows(before, after) : { rows: [], truncated: false, added: 0, removed: 0 },
  };
}

/**
 * 从「当前文章 + Agent 的改稿意图」构建一份提案。**不改动入参 article**。
 *
 * `input.sections` 的语义与 `writeScript` 一致：**整表替换**（顺序以传入为准）。
 * 带 `id` 且能在当前文章里找到的段落会保留它的配图槽位；不带 id 的按新增处理。
 *
 * @param {object} article 当前 `article.json`
 * @param {{id?: string, note?: string, title?: string, subtitle?: string, summary?: string, sections?: object[]}} input
 * @param {number} [now] 时间戳（测试可钉死）
 * @returns {object} 提案对象
 */
export function buildProposal(article, input = {}, now = Date.now()) {
  if (!article || typeof article !== "object") throw fail("文章不存在", 404);
  if (!Array.isArray(input.sections) && typeof input.title !== "string"
    && typeof input.subtitle !== "string" && typeof input.summary !== "string") {
    throw fail("提案里没有任何改动（sections / title / subtitle / summary 至少要给一个）");
  }

  /** @type {object[]} */
  const changes = [];
  const currentSections = Array.isArray(article.sections) ? article.sections : [];
  const indexOf = new Map(currentSections.map((section, index) => [section.id, index]));

  // ── 标量字段 ──────────────────────────────────────────────────────────────
  for (const field of ["title", "subtitle", "summary"]) {
    if (typeof input[field] !== "string") continue;
    const after = input[field].slice(0, MAX_LEN[field]);
    const before = String(article[field] ?? "");
    if (before === after) continue;
    changes.push(change({
      target: `article:${field}`,
      field,
      label: field === "title" ? "标题" : field === "subtitle" ? "副标题" : "摘要",
      before,
      after,
    }));
  }

  // ── 段落整表 ──────────────────────────────────────────────────────────────
  /** @type {object[]} */
  const nextSections = [];
  const touched = new Set();

  if (Array.isArray(input.sections)) {
    if (input.sections.length > MAX_SECTIONS) {
      throw fail(`段落最多 ${MAX_SECTIONS} 段，提案里给了 ${input.sections.length} 段`);
    }
    input.sections.forEach((incoming, position) => {
      const raw = incoming && typeof incoming === "object" ? incoming : {};
      const id = typeof raw.id === "string" && SECTION_ID.test(raw.id) && indexOf.has(raw.id) ? raw.id : "";
      const heading = raw.heading === undefined ? undefined : String(raw.heading).slice(0, MAX_HEADING);
      const body = raw.body === undefined ? undefined : String(raw.body).slice(0, MAX_BODY);

      if (!id) {
        // 新增段：正文和小标题都算新增内容
        nextSections.push({ id: "", heading: heading ?? "", body: body ?? "" });
        changes.push(change({
          target: `section:new:${position}`,
          field: "new-section",
          label: `${SECTION_LABEL(position)}（新增）`,
          slot: "",
          before: "",
          after: [heading ?? "", body ?? ""].filter(Boolean).join("\n"),
        }));
        return;
      }

      touched.add(id);
      const existing = currentSections[indexOf.get(id)];
      const nextHeading = heading === undefined ? String(existing.heading ?? "") : heading;
      const nextBody = body === undefined ? String(existing.body ?? "") : body;
      nextSections.push({ id, heading: nextHeading, body: nextBody });

      const label = SECTION_LABEL(indexOf.get(id));
      if (String(existing.heading ?? "") !== nextHeading) {
        changes.push(change({
          target: `section:${id}:heading`, field: "heading", label: `${label} · 小标题`,
          slot: `sec-${id}`, before: String(existing.heading ?? ""), after: nextHeading,
        }));
      }
      if (String(existing.body ?? "") !== nextBody) {
        changes.push(change({
          target: `section:${id}:body`, field: "body", label: `${label} · 正文`,
          slot: `sec-${id}`, before: String(existing.body ?? ""), after: nextBody,
        }));
      }
    });

    // 删段：当前有、提案里没出现
    for (const [id, index] of indexOf.entries()) {
      if (touched.has(id)) continue;
      const existing = currentSections[index];
      changes.push(change({
        target: `section:${id}:removed`, field: "removed-section", label: `${SECTION_LABEL(index)}（删除）`,
        slot: `sec-${id}`, before: [existing.heading ?? "", existing.body ?? ""].filter(Boolean).join("\n"), after: "",
      }));
    }
  }

  if (!changes.length) throw fail("提案与当前正文一致，没有可确认的改动");

  // 声明与实际不一致就当场拒绝：声明「改词句」却动了标题/摘要/段落增删，按 07 的红线是越权。
  const kindProblem = checkKind(input.kind, changes);
  if (kindProblem) throw fail(kindProblem);

  return {
    v: 1,
    pid: newPid(),
    id: String(article.id ?? ""),
    status: PROPOSAL_STATUS.waiting,
    createdAt: now,
    decidedAt: 0,
    decidedBy: "",
    /** 提案基于哪一版正文；确认时用它查「中间有没有人改过盘」 */
    baseUpdatedAt: Number(article.updatedAt) || 0,
    // 内容指纹：判断「正文是否被人动过」只认它，不认 updatedAt
    baseHash: articleContentHash(article),
    note: String(input.note ?? "").slice(0, MAX_NOTE),
    /**
     * 性质：`declared` 是提出方自报的（可空），`inferred` 是从实际改动推出来的。
     * 两者都留着——**声明不能当免责声明用**，所以真伪由 `checkKind` 在构建时已经核过；
     * 这里把两边都存下来，事后回看能知道「当初是按什么性质走的」。
     */
    kind: inferKind(changes),
    kindDeclared: String(input.kind ?? "").trim(),
    changes,
    /** 确认后要写回的内容（与 `writeScript` 的入参同形） */
    next: {
      title: typeof input.title === "string" ? input.title.slice(0, MAX_LEN.title) : undefined,
      subtitle: typeof input.subtitle === "string" ? input.subtitle.slice(0, MAX_LEN.subtitle) : undefined,
      summary: typeof input.summary === "string" ? input.summary.slice(0, MAX_LEN.summary) : undefined,
      sections: Array.isArray(input.sections) ? nextSections : undefined,
    },
  };
}

/**
 * 变化摘要：`改 2 段 · 新增 1 段 · 删 1 段 · 标题`。给账本、给提案卡标题栏用。
 * @param {object[]} changes
 * @returns {string}
 */
export function summarizeChanges(changes) {
  const list = Array.isArray(changes) ? changes : [];
  const edited = new Set();
  let added = 0;
  let removed = 0;
  const scalars = [];

  for (const item of list) {
    if (item?.field === "new-section") added += 1;
    else if (item?.field === "removed-section") removed += 1;
    else if (typeof item?.slot === "string" && item.slot.startsWith("sec-")) edited.add(item.slot);
    else if (item?.target?.startsWith("article:")) scalars.push(item.label);
  }

  const parts = [];
  if (edited.size) parts.push(`改 ${edited.size} 段`);
  if (added) parts.push(`新增 ${added} 段`);
  if (removed) parts.push(`删 ${removed} 段`);
  if (scalars.length) parts.push([...new Set(scalars)].join(" / "));
  return parts.join(" · ") || "无改动";
}

/**
 * 裁决前的守卫：能不能确认 / 驳回。
 * @param {object} proposal
 * @param {object|null} article 当前盘上的文章
 * @returns {string} 空串表示可以裁决；否则是拒绝理由
 */
export function guardDecision(proposal, article) {
  if (!proposal) return "提案不存在";
  if (PROPOSAL_FINAL.includes(proposal.status)) {
    return `提案已经是「${proposal.status}」，不能重复裁决`;
  }
  if (proposal.status !== PROPOSAL_STATUS.waiting) {
    return `提案状态不认识：${proposal.status}`;
  }
  if (!article) return "文章不存在";
  // 漂移判定必须看**内容**，不能看 `updatedAt`。
  // 踩过：绑定期号这种只改配置的操作也会推高 updatedAt，正文一个字没动，
  // 提案却被判「已过期」，然后人就得重提一遍——重提的还是同一份东西。
  // 有 `baseHash` 就用哈希（准确）；老提案没存哈希才退回时间戳（会误判，但至少不放过真改动）。
  const baseHash = String(proposal.baseHash ?? "");
  if (baseHash) {
    if (baseHash !== articleContentHash(article)) {
      return "正文在提案之后被改过（可能是人工编辑），这份对照已经过期。请重新提一次，别盖掉别人的改动。";
    }
    return "";
  }
  if (Number(article.updatedAt) !== Number(proposal.baseUpdatedAt)) {
    return "正文在提案之后被改过（可能是人工编辑），这份对照已经过期。请重新提一次，别盖掉别人的改动。";
  }
  return "";
}

/**
 * 提案「基于哪一版正文」的指纹。
 *
 * 只算读者可见内容：标题 / 副标题 / 摘要 / 每段小标题与正文。
 * 不算 `updatedAt`、不算配图版本指针、不算 `pipeline`——配图换了或绑了期号都不该让提案作废，
 * 它作废的条件只有一个：**它要改的那些字已经被人动过了**。
 *
 * 与 `lib/pipeline.js` 的 `articleHash` 同一口径（那份用于判断「面板里改过没」），
 * 但这里独立算一次，避免提案层反向依赖流水线层。
 */
export function articleContentHash(article) {
  const parts = [
    String(article?.title ?? "").trim(),
    String(article?.subtitle ?? "").trim(),
    String(article?.summary ?? "").trim(),
    ...(Array.isArray(article?.sections) ? article.sections : []).map(
      (s) => `${String(s?.heading ?? "").trim()}\u0001${String(s?.body ?? "").trim()}`,
    ),
  ];
  return createHash("sha256").update(parts.join("\u0002"), "utf8").digest("hex");
}

/** 把提案折成账本事件（append-only 那一行）。 */
export function proposalEvent(proposal, decision, extra = {}) {
  return {
    type: "proposal",
    pid: proposal.pid,
    decision,
    summary: summarizeChanges(proposal.changes),
    note: proposal.note,
    ...extra,
  };
}
