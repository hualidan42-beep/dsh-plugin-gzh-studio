/**
 * 平台版本（一稿多投）单测。
 *
 * 这一层最容易出的不是「存不下来」，而是三种**静默的数据问题**：
 * 1. 存进不该存的东西（非法平台、重复平台、空壳条目）；
 * 2. 把整篇正文复制成四五份（文件膨胀 + 原稿改了平台版还是旧的）；
 * 3. 存了以后又被别的保存顺手冲掉（部分 patch 把 targets 覆盖成空）。
 *
 * 所以这里不只测 happy path，专门拿脏数据打。
 * @module verify/targets-unit
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyPatch, createService } from "../index.js";
import { createStore } from "../lib/store.js";

const root = await mkdtemp(join(tmpdir(), "gzs-targets-"));
const service = createService({ root }, { info() {}, warn() {} });
const store = createStore({ root });

const base = () => ({
  id: "gzh-20261105-abcd",
  title: "原标题",
  template: "business",
  sections: [{ id: "s1", heading: "一", body: "正文" }],
});

// ── 1. 纯函数：脏数据进不来 ─────────────────────────────────────────────────
{
  const article = base();
  const { changed } = applyPatch(article, {
    targets: [
      { platform: "xhs", title: " 短标题 ", hashtags: [" AI ", "", "效率"] },
      { platform: "xhs", title: "重复平台" },          // 同平台只留第一条
      { platform: "Bad Platform", title: "非法 id" },   // 空格 / 大写都不收
      { platform: "wechat" },                           // 空壳（只有平台名）
      { platform: "douyin", body: "   " },              // 全空白等于没写
      { platform: "kuaishou", title: "" },
      null,
      "not-an-object",
    ],
  });
  assert.deepEqual(changed, ["targets"], "只有真的变了才记改动");
  assert.deepEqual(article.targets, [{ platform: "xhs", title: "短标题", hashtags: ["AI", "效率"] }], "只留下合法且非空的那一条");
}

// ── 2. 裁长：不许把整篇文章塞四五份 ─────────────────────────────────────────
{
  const article = base();
  applyPatch(article, {
    targets: [
      { platform: "douyin", title: "标".repeat(300), body: "正".repeat(25_000) },
      { platform: "kuaishou", hashtags: Array.from({ length: 40 }, (_, i) => `#tag${i}`) },
    ],
  });
  const [douyin, kuaishou] = article.targets;
  assert.equal(douyin.title.length, 200, "标题裁到 200");
  assert.equal(douyin.body.length, 20_000, "正文裁到 2 万");
  assert.equal(kuaishou.hashtags.length, 20, "话题最多 20 个");
}

// ── 3. 平台数上限 8：手抖多贴几行不会写进文件 ───────────────────────────────
{
  const article = base();
  applyPatch(article, {
    targets: Array.from({ length: 12 }, (_, i) => ({ platform: `p${i}`, title: `t${i}` })),
  });
  assert.equal(article.targets.length, 8, "最多 8 个平台");
}

// ── 3b. 类型脏：话题里混数字 / null，正文刚好卡在 2 万 ──────────────────────
{
  const article = base();
  applyPatch(article, {
    targets: [
      { platform: "xhs", hashtags: [1, null, " x ", ""] },
      { platform: "douyin", body: "正".repeat(20_000) },
    ],
  });
  assert.deepEqual(article.targets[0].hashtags, ["1", "x"], "数字转文本、null 与空白丢掉");
  assert.equal(article.targets[1].body.length, 20_000, "刚好 2 万不截断");
}

// ── 4. 幂等：同样的 targets 再存一次不算改动 ────────────────────────────────
{
  const article = base();
  applyPatch(article, { targets: [{ platform: "xhs", title: "短" }] });
  const again = applyPatch(article, { targets: [{ platform: "xhs", title: "短" }] });
  assert.deepEqual(again.changed, [], "没变化就不记改动（否则账本会刷屏）");
}

// ── 5. 传空数组 = 清空；传非数组 = 不动 ─────────────────────────────────────
{
  const article = base();
  applyPatch(article, { targets: [{ platform: "xhs", title: "短" }] });
  applyPatch(article, { targets: [] });
  assert.equal(article.targets, undefined, "空数组等于清空（回到用原稿）");

  applyPatch(article, { targets: [{ platform: "xhs", title: "短" }] });
  applyPatch(article, { targets: "xhs" });
  assert.equal(article.targets.length, 1, "非数组输入不能把已有版本冲掉");
}

// ── 6. 只改标题不能顺手把平台版本冲掉（部分 patch）──────────────────────────
{
  const article = base();
  applyPatch(article, { targets: [{ platform: "xhs", title: "短" }] });
  applyPatch(article, { title: "新标题" });
  assert.equal(article.targets?.[0]?.title, "短", "改标题不该影响平台版本");
}

// ── 7. 真落盘：save → 读回 → 还在；清空后文件里真的没了 ────────────────────
{
  const created = await service.create({ title: "多平台稿", sections: 2, template: "business" });
  const id = created.article.id;
  assert.equal(created.article.targets, undefined, "新稿默认没有平台版本");

  const saved = await service.save({
    id,
    patch: {
      targets: [
        { platform: "wechat", title: "公众号版" },
        { platform: "xhs", title: "小红书版", hashtags: ["AI", "#效率"] },
      ],
    },
  });
  assert.equal(saved.article.targets.length, 2, "保存后立刻返回");
  const view = await service.articleView(id);
  assert.deepEqual(
    view.article.targets.map((item) => item.platform),
    ["wechat", "xhs"],
    "读回来的顺序与内容一致",
  );
  assert.deepEqual(view.article.targets[1].hashtags, ["AI", "#效率"], "话题原样回来");

  const disk = await store.readArticle(id);
  assert.equal(disk.targets?.length, 2, "磁盘上确实有");

  await service.save({ id, patch: { targets: [] } });
  const cleared = await store.readArticle(id);
  assert.equal(cleared.targets, undefined, "清空后磁盘上不该留空数组");
}

await rm(root, { recursive: true, force: true, maxRetries: 3 });
console.log("targets-unit: OK（脏数据拦下 · 裁长 · 平台上限 · 幂等 · 清空 · 部分 patch 不冲掉 · 真落盘往返）");
