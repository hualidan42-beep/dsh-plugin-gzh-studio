/**
 * 05/06 两份清单逐项确认的单元验证。**纯函数，不碰真实文章库**。
 *
 * 立场是挑错。这里最要紧的四件事：
 * 1. 条目文案必须与 SKILL.md 的「验收」小节对得上（条数、条文字数）；
 * 2. 勾选状态不能存"假值"（没勾和勾了又取消必须是同一个状态）；
 * 3. 面板勾选不能冒充盘上清单——两者对账的话必须说清依据；
 * 4. 非法 key 不许进状态（那东西后面要拼进文件路径和渲染）。
 *
 * 用法：node verify/reviews-unit.mjs
 */
import {
  CHECKLISTS, CHECKLIST_ORDER, CHECK_KIND, CHECK_ITEM,
  emptyReviews, normalizeReviews, toggleItem, checklistState, reviewStatus, reconcile,
} from "../lib/reviews.js";
import { recomputeStatus, STATUS } from "../lib/pipeline.js";

let pass = 0;
const fails = [];
const ok = (name, condition, detail = "") => {
  if (condition) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fails.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

// ── 条目口径：必须与 SKILL.md 的「验收」小节一致 ────────────────────────────
{
  ok("两份清单都在", CHECKLIST_ORDER.length === 2 && CHECKLIST_ORDER.every((k) => CHECKLISTS[k]));
  ok("编辑审 8 条（05 SKILL 的验收小节就是 8 条）", CHECKLISTS.editor.items.length === 8,
    `实际 ${CHECKLISTS.editor.items.length}`);
  ok("读者审 8 条（06 SKILL 的验收小节就是 8 条）", CHECKLISTS.reader.items.length === 8,
    `实际 ${CHECKLISTS.reader.items.length}`);
  ok("每条都有 id 和文案", CHECKLIST_ORDER.every((k) => CHECKLISTS[k].items.every((i) => i.id && i.text.length > 6)));
  ok("条目 id 不重复", (() => {
    const all = CHECKLIST_ORDER.flatMap((k) => CHECKLISTS[k].items.map((i) => i.id));
    return new Set(all).size === all.length;
  })(), "重复 id 会让勾一个跳两个");
  ok("条目 id 都过白名单正则", CHECKLIST_ORDER.every((k) => CHECKLISTS[k].items.every((i) => CHECK_ITEM.test(i.id))));
  ok("每份清单都带步号与 skill 名", CHECKLIST_ORDER.every((k) => CHECKLISTS[k].no && /^wechat-0[56]-/.test(CHECKLISTS[k].skill)));
}

// ── 空状态 ──────────────────────────────────────────────────────────────────
{
  const s = emptyReviews();
  ok("空状态 0/16", reviewStatus(s).done === 0 && reviewStatus(s).total === 16);
  ok("空状态 ok=false", reviewStatus(s).ok === false);
  ok("空状态列两份", reviewStatus(s).list.length === 2);
  ok("空状态剩 16 项", reviewStatus(s).remaining === 16);
}

// ── 勾选 / 取消 ─────────────────────────────────────────────────────────────
{
  let s = emptyReviews();
  s = toggleItem(s, "editor", "e1", true, 1000);
  ok("勾一项后 1/16", reviewStatus(s).done === 1);
  ok("勾了带时间戳", checklistState(s, "editor").items[0].at === 1000);
  ok("别的项不受影响", checklistState(s, "editor").items[1].checked === false);

  // 「没勾过」和「勾了又取消」在判据上是一回事，不能存成两种状态
  const undone = toggleItem(s, "editor", "e1", false, 2000);
  ok("取消后回到 0 项", reviewStatus(undone).done === 0);
  ok("取消是删 key 不是存 false", !("editor.e1" in undone.items),
    `items=${JSON.stringify(undone.items)}`);
  ok("取消后与全新状态等价", JSON.stringify(undone.items) === JSON.stringify(emptyReviews().items));

  // 重复勾同一项不该重复计
  let twice = toggleItem(s, "editor", "e1", true, 3000);
  ok("重复勾同一项不重复计数", reviewStatus(twice).done === 1);
  ok("重复勾保留第一次的时间", checklistState(twice, "editor").items[0].at === 1000);
}

// ── 勾满 ────────────────────────────────────────────────────────────────────
{
  let s = emptyReviews();
  for (const item of CHECKLISTS.editor.items) s = toggleItem(s, "editor", item.id, true, 1000);
  ok("编辑审勾满 8/8", checklistState(s, "editor").ok === true);
  ok("只勾一份时整门不过", reviewStatus(s).ok === false);
  for (const item of CHECKLISTS.reader.items) s = toggleItem(s, "reader", item.id, true, 1000);
  ok("两份勾满 16/16 且整门过", reviewStatus(s).ok === true && reviewStatus(s).done === 16);
  ok("勾满后 missing 为空", checklistState(s, "editor").missing.length === 0);
}

// ── 非法输入 ────────────────────────────────────────────────────────────────
{
  const s = emptyReviews();
  ok("非法清单名被拒（不写入）", reviewStatus(toggleItem(s, "../etc", "e1", true)).done === 0);
  ok("非法条目 id 被拒", reviewStatus(toggleItem(s, "editor", "e99", true)).done === 0);
  ok("编辑审不接受 r 开头", reviewStatus(toggleItem(s, "editor", "r1", true)).done === 0);
  ok("读者审不接受 e 开头", reviewStatus(toggleItem(s, "reader", "e1", true)).done === 0);
  ok("空清单名被拒", reviewStatus(toggleItem(s, "", "e1", true)).done === 0);
  ok("白名单正则本身正确", CHECK_KIND.test("editor") && CHECK_KIND.test("reader")
    && !CHECK_KIND.test("editorx") && !CHECK_KIND.test("../editor"));
}

// ── 归一化：盘上读到脏数据不许炸 ────────────────────────────────────────────
{
  const dirty = normalizeReviews({
    items: {
      "editor.e1": { at: 5 },
      "editor.e2": "不是对象",
      "reader.r3": { at: "abc" },
      "../../etc": { at: 1 },
      "editor.e77": { at: 1 },
      "xx.yy": { at: 1 },
      "reader.r1.extra": { at: 1 },
    },
    updatedAt: "坏值",
  });
  const keys = Object.keys(dirty.items);
  ok("坏数据只留合法项", keys.length === 2 && keys.includes("editor.e1") && keys.includes("reader.r3"),
    keys.join(","));
  ok("非对象值被丢掉", !("editor.e2" in dirty.items));
  ok("坏时间戳归 0", dirty.items["reader.r3"].at === 0);
  ok("坏 updatedAt 归 0", dirty.updatedAt === 0);
  ok("路径穿越 key 被过滤", !Object.keys(dirty.items).some((k) => k.includes("..")));
  ok("null 输入不炸", Object.keys(normalizeReviews(null).items).length === 0);
}

// ── 对账：面板勾选 vs 盘上清单 ──────────────────────────────────────────────
{
  const none = emptyReviews();
  const full = (() => {
    let s = emptyReviews();
    for (const k of CHECKLIST_ORDER) for (const item of CHECKLISTS[k].items) s = toggleItem(s, k, item.id, true, 1);
    return s;
  })();

  ok("都没勾、盘上都有 → ok（提示可以逐项勾）", reconcile({ editor: true, reader: true, shaBound: true }, none).level === "ok");
  ok("都没勾、盘上也没有 → todo", reconcile({ editor: false, reader: false }, none).level === "todo");
  ok("勾满、盘上都有 → ok", reconcile({ editor: true, reader: true, shaBound: true }, full).level === "ok");

  // 最要紧的一条：勾满了但盘上没有，必须 warn 且说清「不能替代」
  const warn = reconcile({ editor: false, reader: false }, full);
  ok("勾满但盘上无清单 → warn", warn.level === "warn");
  ok("warn 文案说清「不能替代」", /不能替代/.test(warn.text), warn.text);
  ok("warn 文案点出缺哪份", /编辑审/.test(warn.text) && /读者审/.test(warn.text));

  const half = reconcile({ editor: true, reader: false }, full);
  ok("只缺读者审时只点读者审", half.level === "warn" && /读者审/.test(half.text) && !/缺编辑审/.test(half.text), half.text);
  ok("部分勾选时说还差几项", /还差/.test(reconcile({ editor: false, reader: false }, toggleItem(emptyReviews(), "editor", "e1", true)).text));
  ok("盘上都没、也没勾 → todo 不提 warn", reconcile({}, none).level === "todo");
}

// ── recomputeStatus：与 locate 同口径 ───────────────────────────────────────
{
  const g = (no, state, stopStatus) => ({ no, state, stopStatus });
  ok("全 ok → ready", recomputeStatus([g(1, "ok"), g(5, "ok"), g(10, "ok")]) === STATUS.READY);
  ok("第一道 fail 的状态词说了算", recomputeStatus([g(1, "ok"), g(3, "fail", STATUS.NEEDS_RESEARCH), g(8, "fail", STATUS.NEEDS_REVIEW)]) === STATUS.NEEDS_RESEARCH);
  ok("不管数组顺序，按门号取第一个", recomputeStatus([g(8, "fail", STATUS.NEEDS_REVIEW), g(3, "fail", STATUS.NEEDS_RESEARCH)]) === STATUS.NEEDS_RESEARCH);
  ok("stale 也算拦路", recomputeStatus([g(6, "stale", STATUS.NEEDS_AUDIT)]) === STATUS.NEEDS_AUDIT);
  ok("unknown 不拦（判据不可用 ≠ 没做到）", recomputeStatus([g(1, "ok"), g(5, "unknown"), g(10, "ok")]) === STATUS.READY);
  ok("skip 不拦", recomputeStatus([g(1, "skip"), g(10, "ok")]) === STATUS.READY);
  ok("stopStatus 缺失时退到 needs-review 而不是 ready", recomputeStatus([g(3, "fail")]) === STATUS.NEEDS_REVIEW,
    "退到 ready 会让卡住的稿子看起来能发");
  ok("空数组 → ready", recomputeStatus([]) === STATUS.READY);
  ok("非数组不炸", recomputeStatus(null) === STATUS.READY);
  ok("返回的词必须在 STATUS 全集内", [STATUS.READY, STATUS.NEEDS_REVIEW].every((x) => Object.values(STATUS).includes(x)));
}

console.log("");
if (fails.length) {
  console.log(`reviews-unit: ${fails.length} 个失败 / 共 ${pass + fails.length}`);
  for (const line of fails) console.log(`  ✗ ${line}`);
  process.exit(1);
}
console.log(`reviews-unit: OK（${pass} 个用例 · 05/06 各 8 条 · 勾选/对账/状态重算全过）`);
