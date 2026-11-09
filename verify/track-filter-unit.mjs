/**
 * 验证「内容类型归类」这条链路真的通（不是只读代码）：
 *   1. 建稿时带 track → 落到 article.track 并真的写进盘上的 article.json；
 *   2. 库存接口按 track 筛 → 只回那一类；
 *   3. 计数 byTrack / untracked 和列表自洽；
 *   4. 没选类型的稿落到「通用」（__none 哨兵），不会被算进任何类型；
 *   5. 非法 / 不存在的 track id 当作「不筛」，不静默返回空表；
 *   6. 卡片数据里带 track，前端才能画那个标签。
 *
 * 跑法：node verify/track-filter-unit.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, ROUTES, ROUTES as R, TRACK_NONE } from "../index.js";

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

const provided = {};
const routes = new Map();
const effects = [];
const root = await mkdtemp(join(tmpdir(), "gzs-track-"));
apply({
  logger: { info: () => {}, warn: () => {} },
  effect: (factory) => effects.push(factory),
  provide: (name, service) => { provided[name] = service; },
  connection: { fetch: { register: (spec) => { routes.set(spec.path, spec); return () => routes.delete(spec.path); } } },
}, { root });

const callGet = (path, query = "") => routes.get(path).fetch({ url: `http://x${path}${query}`, headers: new Headers() });
const callPost = (path, body) => routes.get(path).fetch({ url: `http://x${path}`, json: async () => body });
const jsonOf = async (response) => { assert.equal(response.status, 200, `期望 200，实得 ${response.status}`); return response.json(); };

try {
  // 建三篇：医疗 / 母婴 / 不选类型
  const medical = await jsonOf(await callPost(R.create, { title: "医疗稿", track: "medical", sections: 1 }));
  const baby = await jsonOf(await callPost(R.create, { title: "母婴稿", track: "maternal", sections: 1 }));
  const plain = await jsonOf(await callPost(R.create, { title: "通用稿", sections: 1 }));

  await check("建稿时带的 track 落到文章字段上", async () => {
    assert.equal(medical.article.track, "medical");
    assert.equal(baby.article.track, "maternal");
    assert.equal(plain.article.track, undefined, "没选类型就不带 track 字段");
  });

  await check("track 真的写进盘上的 article.json（不是只在内存里）", async () => {
    const raw = JSON.parse(await readFile(join(root, "articles", medical.article.id, "article.json"), "utf8"));
    assert.equal(raw.track, "medical", "盘上有 track");
  });

  await check("选了赛道又没指定模板 → 用这条赛道的默认长相", async () => {
    const tracks = (await jsonOf(await callGet(R.state))).tracks;
    const one = tracks.find((t) => t.id === "medical");
    assert.ok(one, "state 里能拿到赛道包");
    assert.equal(medical.article.template, one.defaultTemplate, `模板该是 ${one.defaultTemplate}`);
  });

  await check("按类型筛：只回这一类", async () => {
    const s = await jsonOf(await callGet(R.state, "?track=medical"));
    assert.equal(s.articles.length, 1);
    assert.equal(s.articles[0].track, "medical");
    assert.equal(s.matched, 1);
    assert.equal(s.filters.track, "medical", "回填筛选项，前端才知道自己停在哪个 chip");
  });

  await check("按「通用」筛（__none 哨兵）：只回没选类型的稿", async () => {
    const s = await jsonOf(await callGet(R.state, `?track=${TRACK_NONE}`));
    assert.equal(s.articles.length, 1);
    assert.equal(s.articles[0].id, plain.article.id);
    assert.ok(!s.articles.some((a) => a.track), "不该混进有类型的稿");
  });

  await check("计数 byTrack / untracked 与列表自洽", async () => {
    const s = await jsonOf(await callGet(R.state));
    assert.equal(s.counts.byTrack.medical, 1);
    assert.equal(s.counts.byTrack["maternal"], 1);
    assert.equal(s.counts.untracked, 1, "没选类型的那篇算 untracked");
    const sum = Object.values(s.counts.byTrack).reduce((a, b) => a + b, 0) + s.counts.untracked;
    assert.equal(sum, s.counts.total, `各类之和要等于总数：${sum} vs ${s.counts.total}`);
  });

  await check("卡片数据带 track（前端要画类型标签）", async () => {
    const s = await jsonOf(await callGet(R.state));
    assert.ok(s.articles.every((a) => "track" in a), "每张卡片都带 track 字段");
  });

  await check("不存在的类型 id 当作不筛（不静默返回空表）", async () => {
    const s = await jsonOf(await callGet(R.state, "?track=no-such-track"));
    assert.equal(s.articles.length, 3, "不认识的 id 不该把列表清空");
  });

  // ── 写入侧必须校验 id：拼错的类型会让这篇稿从分类里消失（实测过）──────────
  await check("建稿时写错的类型 id → 400 并给出可用清单", async () => {
    const res = await callPost(R.create, { title: "拼错的", track: "mother-baby", sections: 1 });
    assert.equal(res.status, 400, "拼错的 id 不该被接受");
    const body = await res.json();
    assert.match(body.error.message, /未知内容类型/, "要说清是什么问题");
    assert.match(body.error.message, /medical/, "要给出可用 id，让调用方照着改");
  });

  await check("改稿时写错的类型 id → 400（否则这篇从分类里消失）", async () => {
    const res = await callPost(R.save, { id: medical.article.id, patch: { track: "mother-baby" } });
    assert.equal(res.status, 400);
  });

  await check("改回「通用」（空串）是合法的", async () => {
    const res = await callPost(R.save, { id: plain.article.id, patch: { track: "" } });
    assert.equal(res.status, 200, "空串 = 通用，不该被拦");
    const after = await jsonOf(await callGet(R.article, `?id=${plain.article.id}`));
    assert.equal(after.article.track ?? "", "", "回落到通用（applyPatch 会把 track 字段整个删掉）");
  });

  await check("改类型（换赛道）会被记进账本", async () => {
    await jsonOf(await callPost(R.save, { id: plain.article.id, patch: { track: "finance" } }));
    const after = await jsonOf(await callGet(R.article, `?id=${plain.article.id}`));
    assert.equal(after.article.track, "finance", "类型改动了");
    const ledger = after.ledger ?? [];
    assert.ok(ledger.some((row) => row.type === "save" && (row.fields ?? []).includes("track")),
      "账本要留下「改过类型」这条，否则日后说不清这篇为什么换了归类");
  });

  // ── brief 里必须给 Agent 足够的归类信息（不然它无从知道 track 填什么）────────
  await check("brief 写明当前内容类型", async () => {
    const text = await (await callGet(R.brief, `?id=${medical.article.id}`)).text();
    assert.ok(text.includes("内容类型："), "brief 要有「内容类型」这一行");
    assert.ok(/内容类型：.+（medical）/.test(text), `要带上类型名和 id，实际：${text.split("\n").find((l) => l.startsWith("内容类型"))}`);
  });

  await check("没归类时 brief 说清「通用」并给可选 id 清单", async () => {
    const fresh = await jsonOf(await callPost(R.create, { title: "未归类稿", sections: 1 }));
    const text = await (await callGet(R.brief, `?id=${fresh.article.id}`)).text();
    assert.ok(text.includes("通用（还没归类）"), "没类型时说「通用（还没归类）」");
    assert.ok(text.includes("可选内容类型"), "要给出可选 id 清单");
    assert.ok(/medical=/.test(text), "清单是 id=名称 形式，Agent 才能照抄");
    assert.ok(text.includes("判断不了就留空"), "要说清「判断不了就留空」，不能逼它猜");
  });

  await check("已归类时 brief 提醒「换类型先问」", async () => {
    const text = await (await callGet(R.brief, `?id=${medical.article.id}`)).text();
    assert.ok(text.includes("已归类"), "已归类的稿要说明");
    assert.ok(text.includes("不要自己改"), "换类型要先问");
  });
} finally {
  await rm(root, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} 通过 / ${failed.length} 失败`);
process.exit(failed.length ? 1 : 0);
