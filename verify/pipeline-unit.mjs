/**
 * 流水线状态机的单元测试：**造一棵假文件树**，逐个把门禁打破，看状态词是否指对。
 *
 * 为什么不用真仓：真仓只有「现在恰好是什么」，而这里要验的是「各种坏掉的样子能不能认出来」。
 * 拿真仓当测试等于把某一刻的盘面钉进测试，盘面一变测试就红。
 *
 * 断言里带一条底线：**返回的状态词必须出现在 PIPELINE §4 的词表里**——
 * 这条是防我自己哪天随手加一个「needs-something」。
 *
 * 用法：node verify/pipeline-unit.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { locate, isStatus, articleHash, STATUS } from "../lib/pipeline.js";

const sha = (text) => createHash("sha256").update(Buffer.from(text)).digest("hex");
const EP = "historical-person-099";
const NO = 99;

const ARTICLE_MD = "# 标题\n\n正文第一段。\n";
const LAYOUT_HTML = "<section><p>正文第一段。</p></section>\n";
const COVER = "fake-png-bytes";
const EP_ARTICLE = sha(ARTICLE_MD);
const EP_LAYOUT = sha(LAYOUT_HTML);

/** 造一棵完整通过的树；每个用例只打破自己要测的那一处。 */
async function fixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "gzs-pipe-"));
  const data = join(root, "生产内部", "data");
  const verify = join(data, "verification");
  const approvals = join(verify, "approvals");
  const review = join(root, "审稿", `第099期-测试-审稿`);
  const deliver = join(root, "最终交付", `第099期-测试`);
  for (const dir of [data, verify, approvals, review, deliver, join(data, "research")]) {
    await mkdir(dir, { recursive: true });
  }
  const write = async (path, content) => {
    await writeFile(path, typeof content === "string" ? content : JSON.stringify(content, null, 1), "utf8");
  };

  // 无清单（文件不存在）与清单未标 complete 是两回事：前者本线不适用，后者是真卡住。
  if (overrides.noInventoryFile) { /* 不写文件 */ }
  else if (overrides.noInventory) await write(join(data, "published_people.json"), { complete: false });
  else await write(join(data, "published_people.json"), { complete: true });
  await write(join(data, "research", `${EP}.json`), {
    episode_id: EP,
    episode_no: NO,
    wechat_meta: { audience: "测试读者", evidence_count: 3, research_method: "Chrome 现场抓正文" },
    entries: overrides.badClaims
      ? [{ id: "E01", verified_verbatim: true }, { id: "E02", verified_verbatim: false }]
      : [{ id: "E01", verified_verbatim: true }, { id: "E02", verified_verbatim: true }],
    ...(overrides.noMeta ? { wechat_meta: {} } : {}),
  });
  if (overrides.noResearch) await rm(join(data, "research", `${EP}.json`));

  if (!overrides.noAngles) {
    await write(join(review, "03-公众号-文案草稿.angles.md"), [
      "| 1 | 方案甲 | 钩子甲 | **初判选定** |",
      "| 2 | 方案乙 | 钩子乙 | — |",
      "方案 2 不单独成期，全部并入方案 1。",
    ].join("\n"));
  }
  await write(join(review, "03-公众号-文案草稿.self-review.md"), "编辑审 7 问\n");

  await write(join(deliver, "10-公众号-文案.md"), ARTICLE_MD);
  await write(join(deliver, "11-公众号-排版.html"), LAYOUT_HTML);
  await write(join(deliver, "12-公众号-封面.png"), COVER);

  const auditSha = overrides.auditSha ?? EP_ARTICLE;
  if (!overrides.noAudit) {
    await write(join(verify, `${EP}-wechat-pkg-chrome-audit.json`), { verified: true, article_sha256: auditSha });
  }

  const productionBound = overrides.productionBound ?? EP_ARTICLE;
  if (!overrides.noProduction) {
    await write(join(approvals, `${EP}-production.json`), {
      episode_id: EP, status: overrides.productionStatus ?? "approved", scope: overrides.productionScope ?? ["wechat"],
      approved_at: "2026-10-20T10:00:00+08:00", bound_to: { article_sha256: productionBound },
    });
  }
  if (overrides.draftRebind) {
    await write(join(approvals, `${EP}-wechat-draft.json`), {
      episode_id: EP, status: "approved", scope: ["wechat-draft", "wechat"],
      approved_at: "2026-10-21T10:00:00+08:00", bound_to: { article_sha256: overrides.draftRebind },
    });
  }

  if (!overrides.noQualityGate) {
    await write(join(verify, `${EP}-wechat-10-quality-gate.json`), {
      episode_id: EP,
      generated_at: "2026-10-21T17:00:00+08:00",
      verdict: overrides.gateVerdict ?? "pass",
      content_review: { round1_self: "改 11 处", round2_self: "改 10 处" },
      layout: { sha256: overrides.layoutBound ?? EP_LAYOUT, verdict: "pass" },
    });
  }

  if (!overrides.noDraft) {
    await write(join(verify, `${EP}-wechat-11-draft.json`), {
      episode_id: EP,
      verified: overrides.draftVerified ?? true,
      persisted: overrides.draftPersisted ?? true,
      media_id: overrides.draftMediaId ?? "media-abc-123",
    });
  }

  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const cases = [];
/** 跑一个用例：要求状态词、步骤、以及某道门的结论。 */
async function run(name, overrides, expect) {
  const fx = await fixture(overrides);
  try {
    const result = await locate({ root: fx.root, episodeId: EP });
    assert.equal(result.bound, true, `${name}: 应当已绑定`);
    assert.ok(isStatus(result.status), `${name}: 状态词「${result.status}」不在 PIPELINE §4 词表里`);
    if (expect.status) assert.equal(result.status, expect.status, `${name}: 状态`);
    if (expect.step) assert.equal(result.step, expect.step, `${name}: 下一步`);
    if (expect.gate) {
      const hit = result.gates.find((g) => g.no === expect.gate.no);
      assert.ok(hit, `${name}: 应当有第 ${expect.gate.no} 道门的结论`);
      assert.equal(hit.state, expect.gate.state, `${name}: 第 ${expect.gate.no} 道门结论`);
    }
    if (expect.gateCount) assert.equal(result.gates.length, expect.gateCount, `${name}: 门数`);
    if (expect.unknown !== undefined) assert.equal(result.unknown, expect.unknown, `${name}: 判据不可用项数`);
    cases.push(name);
    return result;
  } finally {
    await fx.cleanup();
  }
}

// ── 全绿 ──────────────────────────────────────────────────────────────────
{
  const r = await run("全部门禁通过", {}, { status: STATUS.READY, step: "11-digest-draft", gateCount: 10, unknown: 0 });
  assert.equal(r.blocking, null, "全绿时不该有卡住的门");
}

// ── 02 → 03：台账 ─────────────────────────────────────────────────────────
await run("台账不存在", { noResearch: true }, {
  status: STATUS.NEEDS_RESEARCH, step: "02-evidence", gate: { no: 3, state: "fail" },
});
await run("台账有条目未核过", { badClaims: true }, {
  status: STATUS.NEEDS_RESEARCH, gate: { no: 3, state: "fail" },
});

// ── frontmatter 四项 ──────────────────────────────────────────────────────
await run("wechat_meta 空", { noMeta: true }, {
  status: STATUS.NEEDS_REVIEW, step: "01-kickoff", gate: { no: 2, state: "fail" },
});

// ── 人物清单 ──────────────────────────────────────────────────────────────
await run("人物清单未标 complete", { noInventory: true }, {
  status: STATUS.NEEDS_INVENTORY, step: "01-kickoff", gate: { no: 1, state: "fail" },
});
await run("本仓没有人物清单（公众号线不适用，跳过而不是判卡）", { noInventoryFile: true }, {
  status: STATUS.READY, gate: { no: 1, state: "skip" },
});

// ── 03 → 04：方案 ─────────────────────────────────────────────────────────
await run("没有方案文件", { noAngles: true }, {
  status: STATUS.NEEDS_REVIEW, step: "03-angles", gate: { no: 4, state: "fail" },
});

// ── 07：核验与制作确认 ────────────────────────────────────────────────────
await run("没有核验收据", { noAudit: true }, {
  status: STATUS.NEEDS_AUDIT, step: "07-deai", gate: { no: 6, state: "fail" },
});
await run("核验收据绑的是旧文字", { auditSha: "deadbeef" }, {
  status: STATUS.NEEDS_AUDIT, gate: { no: 6, state: "stale" },
});
await run("没有制作确认", { noProduction: true }, {
  status: STATUS.NEEDS_USER_APPROVAL, step: "07-deai", gate: { no: 7, state: "fail" },
});
await run("制作确认 scope 不含 wechat", { productionScope: ["video"] }, {
  status: STATUS.NEEDS_USER_APPROVAL, gate: { no: 7, state: "fail" },
});
// 这条是 026 期的真实情形：确认之后正文改过，且没有重签
await run("制作确认哈希过期且无重签", { productionBound: "deadbeef" }, {
  status: STATUS.NEEDS_USER_APPROVAL, step: "07-deai", gate: { no: 7, state: "stale" },
});
// 这条是 027 期的真实情形：过期了，但草稿授权重签覆盖，应当放过
await run("制作确认过期但草稿已重签覆盖", { productionBound: "deadbeef", draftRebind: EP_ARTICLE }, {
  status: STATUS.READY, gate: { no: 7, state: "ok" },
});

// ── 09/10：排版、留痕、推草稿 ─────────────────────────────────────────────
// 没有留痕时先撞的是第 8 道门（排版在、体检结论不在），不是第 9 道——顺序不可颠倒
await run("没有质量门留痕", { noQualityGate: true }, {
  status: STATUS.NEEDS_REVIEW, step: "10-quality-gate", gate: { no: 8, state: "fail" },
});
await run("质量门 verdict 不是 pass", { gateVerdict: "fail" }, {
  status: STATUS.NEEDS_DRAFT_APPROVAL, step: "10-quality-gate", gate: { no: 9, state: "fail" },
});
await run("排版改过、留痕绑的是旧排版", { layoutBound: "deadbeef" }, {
  status: STATUS.NEEDS_REVIEW, step: "10-quality-gate", gate: { no: 8, state: "stale" },
});
await run("没有推草稿回执", { noDraft: true }, {
  status: STATUS.NEEDS_DRAFT_APPROVAL, gate: { no: 10, state: "fail" },
});
await run("草稿只是模拟回执", { draftPersisted: false }, {
  status: STATUS.DRY_RUN, gate: { no: 10, state: "stale" },
});
await run("草稿没回读核实", { draftVerified: false }, {
  status: STATUS.NEEDS_REVIEW, gate: { no: 10, state: "fail" },
});

// ── 未绑定 ────────────────────────────────────────────────────────────────
{
  const r = await locate({ root: "D:/nowhere", episodeId: "" });
  assert.equal(r.bound, false, "没期号就是未绑定");
  assert.equal(r.status, null, "未绑定不返回状态词（不能假装在某一歩）");
  assert.ok(!isStatus(r.status), "null 不是状态词");
  cases.push("未绑定不返回状态词");
}
{
  const r = await locate({ root: "", episodeId: EP });
  assert.equal(r.bound, false, "没根目录也算未绑定");
  cases.push("缺根目录不炸");
}

// ── articleHash：绑定时钉正文用 ────────────────────────────────────────────
{
  const a = { title: "T", subtitle: "", summary: "", sections: [{ heading: "h", body: "b" }] };
  const padded = { title: "T ", subtitle: "", summary: "", sections: [{ heading: "h", body: " b " }] };
  const changed = { title: "T", subtitle: "", summary: "", sections: [{ heading: "h", body: "b。" }] };
  assert.equal(articleHash(a), articleHash({ ...a }), "同样的内容哈希稳定");
  // 首尾空白不算改稿：只差空格就判「全篇作废」会让人不敢动键盘
  assert.equal(articleHash(a), articleHash(padded), "首尾空白不影响哈希");
  assert.notEqual(articleHash(a), articleHash(changed), "真改了字哈希就变");
  assert.equal(articleHash(a).length, 64, "是 sha256");
  cases.push("articleHash 认改动、不认空格");
}

// 用例清单先打，总结论压在最后一行——`tail -1` 就该看到「OK」。
// 反过来的话，跑批量脚本时每格显示的是最后一个用例名，看不出过没过。
console.log(cases.map((name) => `  · ${name}`).join("\n"));
console.log(`pipeline-unit: OK（${cases.length} 个用例 · 状态词全部落在 PIPELINE §4 词表内）`);
