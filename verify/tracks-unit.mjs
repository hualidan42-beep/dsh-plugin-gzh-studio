/**
 * 赛道包单测。
 *
 * 赛道是「合规口径」，不是「视觉模板」。所以这一组断言盯的是**规则真的会拦人**：
 * 1. 21 条内置包形状完整，A 档（会出事的那些）必须同时有禁用词和必须声明；
 * 2. `validateTrack` 挡住坏包（用户自加的包写错了，不能把面板带崩）；
 * 3. `checkTrack` 的判级正确：**字面命中只判 warn**（「不根治」也含「根治」），
 *    **缺声明判 error**（那是真的没写）；
 * 4. 宿主侧：新建带赛道用赛道默认模板、`save` 能改赛道、`state?track=` 能筛、
 *    QA 里真的出现赛道条目；
 * 5. 用户自定义包（`<root>/tracks/*.json`）能被拾取。
 * @module verify/tracks-unit
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BUILTIN_TRACKS, TRACK_IDS, TIERS, trackOf, tracksView, validateTrack, checkTrack, withTrackQa, articleText,
} from "../lib/tracks.js";
import { createService, applyPatch } from "../index.js";
import { runQa } from "../lib/qa.js";

// ── 1. 包本身 ────────────────────────────────────────────────────────────────
assert.equal(BUILTIN_TRACKS.length, 21, `内置 21 条，实际 ${BUILTIN_TRACKS.length}`);
assert.equal(new Set(TRACK_IDS).size, 21, "id 不能重复");
for (const track of BUILTIN_TRACKS) {
  assert.ok(/^[a-z][a-z0-9-]{1,31}$/.test(track.id), `id 形状：${track.id}`);
  assert.ok(track.name && track.audience && track.tone, `${track.id} 要有名字、读者、口吻`);
  assert.ok(TIERS[track.tier], `${track.id} 的档位要是 A/B/C`);
  assert.ok(Array.isArray(track.structure) && track.structure.length >= 3, `${track.id} 要有结构骨架`);
  // A 档是「写错会出事」的那批：没有禁用词和必须声明，等于没做合规
  if (track.tier === "A") {
    assert.ok(track.compliance.forbidden.length >= 4, `${track.id}（A 档）禁用词太少`);
    assert.ok(track.compliance.required.length >= 1, `${track.id}（A 档）缺必须声明`);
  }
}

// ── 2. 坏包要挡住 ────────────────────────────────────────────────────────────
assert.equal(validateTrack({ id: "Bad Id", name: "x" }).ok, false, "id 形状不对要拒");
assert.equal(validateTrack({ id: "ok-id" }).ok, false, "缺 name 要拒");
assert.equal(validateTrack({ id: "ok-id", name: "x", compliance: { required: [{ message: "缺 any" }] } }).ok, false, "required 缺 any 要拒");
const goodCustom = validateTrack({
  id: "pet-care", name: "宠物养护", tier: "C",
  compliance: { forbidden: ["包治"], required: [{ any: ["兽医"], message: "宠物稿要提示就医" }] },
});
assert.equal(goodCustom.ok, true, "合法自定义包要过");
// 「自定义」是宿主加载时打的标（validateTrack 只校验形状），所以这里模拟宿主那一步。
assert.equal(tracksView([{ ...goodCustom.track, custom: true }])[0].custom, true, "自定义包要标出来");
assert.equal(tracksView([goodCustom.track])[0].custom, false, "没打标就是内置包");

// ── 3. 规则判级 ──────────────────────────────────────────────────────────────
const medical = trackOf("medical");
const risky = {
  track: "medical",
  title: "治愈率 98% 的新方案",
  summary: "一篇医疗科普",
  sections: [{ id: "s1", heading: "机制", body: "这个方案号称根治，且无副作用。" }],
};
const result = checkTrack(risky, medical);
assert.ok(result.items.some((row) => row.id.includes("word-根治")), "命中「根治」要报");
assert.ok(result.items.every((row) => row.level !== "error" || row.id.includes("required")), "只有「缺声明」才判 error，字面命中一律 warn");
assert.ok(result.items.some((row) => row.level === "error" && row.id.includes("required")), "缺免责声明要判 error");
assert.equal(result.ok, false, "有 error 就是没通过");

// 补上声明 → error 消失（warn 还在，那是「确认一下」，不是拦路）
const fixed = { ...risky, sections: [...risky.sections, { id: "s2", heading: "边界", body: "本文为科普，不构成诊疗建议，请遵医嘱。" }] };
const fixedResult = checkTrack(fixed, medical);
assert.equal(fixedResult.counts.error, 0, `补上声明后不该再有 error：${JSON.stringify(fixedResult.items)}`);
assert.ok(fixedResult.counts.warn >= 1, "「根治」的提醒还在（它确实出现了）");

// 金融：有风险提示 + 稳赚 → 只有 warn，不拦
const finance = trackOf("finance");
const financeResult = checkTrack({
  track: "finance",
  title: "稳赚的理财",
  sections: [{ id: "s1", body: "投资有风险，不构成投资建议。" }],
}, finance);
assert.equal(financeResult.counts.error, 0, "金融稿有风险提示就不该拦");
assert.ok(financeResult.items.some((row) => row.id.includes("word-稳赚")), "「稳赚」要提醒");

// 科技：没写版本/日期要提醒
const ai = trackOf("tech-ai");
assert.ok(checkTrack({ track: "tech-ai", title: "AI 能做什么", sections: [{ id: "s1", body: "它能写代码。" }] }, ai)
  .items.some((row) => row.id.includes("version")), "AI 稿没版本要提醒");

// 科学：有数字没来源 → info
const science = trackOf("science");
const sciResult = checkTrack({ track: "science", title: "研究显示", sections: [{ id: "s1", body: "共 3000 人参与，提升了 20%。" }] }, science);
assert.ok(sciResult.items.some((row) => row.level === "info" && row.id.includes("sources")), "数字没来源要给 info");

// 合并：普通 QA 条目要保留
const merged = withTrackQa(runQa({ title: "", sections: [] }), risky, medical);
assert.ok(merged.items.some((row) => row.id === "title-missing"), "普通 QA 的条目不能被赛道覆盖掉");
assert.ok(merged.counts.error >= 2, "两边 error 要一起算");

// articleText 要含禁忌词那一栏（它也会出现在正文里）
assert.ok(articleText({ forbidden: "治愈" }).includes("治愈"), "禁忌词栏也算文章内容");

// ── 4. 宿主集成 ──────────────────────────────────────────────────────────────
const root = await mkdtemp(join(tmpdir(), "gzs-tracks-"));
// 先放一个自定义包，验证「用户丢文件就能加赛道」
await mkdir(join(root, "tracks"), { recursive: true });
await writeFile(join(root, "tracks", "pet-care.json"), JSON.stringify({
  id: "pet-care", name: "宠物养护", tier: "C",
  structure: ["场景", "怎么做", "何时就医"],
  compliance: { forbidden: ["包治"], required: [{ any: ["兽医"], message: "宠物稿要提示就医" }] },
}, null, 2), "utf8");

const service = createService({ root }, { info() {}, warn() {} });

const created = await service.create({ title: "宠物掉毛怎么办", sections: 2, track: "medical" });
assert.equal(created.article.track, "medical", "新建要带上赛道");
assert.equal(created.article.template, "business", "医疗赛道默认商务模板");

const saved = await service.save({ id: created.article.id, patch: { sections: [{ id: created.article.sections[0].id, body: "这个方案号称根治，且无副作用。" }] } });
assert.ok(saved.qa.items.some((row) => row.id.startsWith("track-medical")), `save 返回的 qa 要带赛道条目：${JSON.stringify(saved.qa.items.map((r) => r.id))}`);

const switched = await service.save({ id: created.article.id, patch: { track: "pet-care" } });
assert.equal(switched.article.track, "pet-care", "能改到自定义赛道");
assert.ok(switched.qa.items.some((row) => row.id === "track-pet-care-required-0"), "自定义包的规则也要生效");

// 出图风格：赛道里的 imageStyle 要真的拼进 prompt（不是只写在 README 里）
const styled = await service.create({ title: "出图风格探针", sections: 1, track: "medical" });
await service.generate({ id: styled.article.id, slot: "cover", prompt: "实验室" });
const styledView = await service.articleView(styled.article.id);
const genEvent = styledView.ledger.filter((row) => row.type === "generate").pop();
assert.ok(String(genEvent?.trackStyle ?? "").startsWith("冷白临床摄影"), `赛道风格要拼进发请求的 prompt，实际「${genEvent?.trackStyle}」`);
assert.equal(genEvent.prompt, "实验室", "槽位 prompt 保持干净原文（风格只在发请求那一刻拼）");

// 非法赛道 id 不写盘
const badPatch = { title: "x", track: "Not A Track" };
const target = { title: "t" };
applyPatch(target, badPatch);
assert.equal(target.track, undefined, "非法赛道 id 不能写进文章");

// state：赛道列表 + 按赛道筛
const all = await service.state({});
assert.ok(all.tracks.some((track) => track.id === "medical"), "state 要下发内置赛道");
assert.ok(all.tracks.some((track) => track.id === "pet-care"), "state 要下发用户自定义赛道");
const only = await service.state({ track: "pet-care" });
assert.equal(only.articles.length, 1, "按赛道筛只剩这一篇");
const typo = await service.state({ track: "pet-car" });
assert.equal(typo.articles.length, all.articles.length, "赛道笔误当作不筛（不能把库筛空）");

// 「通用」筛选：没选内容类型的稿（哨兵 __none，不能用空串——空串是「不筛」）
const untracked = await service.create({ title: "不选类型的通用稿", sections: 1 });
const generic = await service.state({ track: "__none" });
assert.equal(generic.articles.length, 1, "通用筛选只留没选类型的那一篇");
assert.equal(generic.articles[0].id, untracked.article.id, "筛出来的正是通用稿");
assert.equal(generic.filters.track, "__none", "筛选状态要回传，面板上的 chip 才会亮");
assert.ok(generic.counts.untracked >= 1, "counts.untracked 给出通用稿数量");
assert.ok(!("__none" in generic.counts.byTrack), "哨兵不能混进 byTrack 计数");

const allAgain = await service.state({});
assert.equal(allAgain.counts.untracked, generic.counts.untracked, "不筛时也报同样的通用稿数");
assert.equal(allAgain.articles.length, all.articles.length + 1, "新增的通用稿进「全部」");

// 把一篇有类型的稿清成通用：它该从原赛道消失、出现在通用里
await service.save({ id: created.article.id, patch: { track: "" } });
const afterClear = await service.state({ track: "__none" });
assert.ok(afterClear.articles.some((row) => row.id === created.article.id), "清空类型后归到通用");
const petLeft = await service.state({ track: "pet-care" });
assert.equal(petLeft.articles.length, 0, "清空后不再留在原赛道");

await rm(root, { recursive: true, force: true });
console.log("tracks-unit: OK（21 条内置 / 坏包被拒 / 命中只 warn · 缺声明判 error / 合并普通 QA / 宿主新建改赛道与筛选 / 自定义包生效）");



