/**
 * 真实数据检查（可选）：读**本机数据根**（默认 `~/.dsh/gzh-studio`），
 * 把面板会走的三个接口都跑一遍，并核对「每个版本的文件都真在盘上」。
 *
 * 与 `host-smoke.mjs` 的分工：那支在临时目录里从零跑整条链路（测逻辑）；
 * 这支检查**你现在盘上的数据**能不能渲染（测现场）——图被手删、article.json 手改成坏形状、
 * 版本指针指到不存在的版本，这些只在现场才会出现。
 *
 *     node verify/live-data.mjs
 *     node verify/live-data.mjs D:/tmp/gzs
 * @module verify/live-data
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { apply, ROUTES } from "../index.js";
import { renderWechatBody } from "../lib/render.js";

const root = process.argv[2] || undefined;

// 假 ctx，只为拿到路由（不动真实宿主）
const routes = new Map();
const provided = {};
apply({
  logger: { info: () => {}, warn: () => {} },
  effect: () => {},
  provide: (n, s) => { provided[n] = s; },
  connection: { fetch: { register: (spec) => { routes.set(spec.path, spec); return () => {}; } } },
}, root ? { root } : {});

const call = async (path, query = "") => {
  const response = await routes.get(path).fetch({ url: `http://x${path}${query}`, headers: new Headers() });
  return response;
};

const stateRes = await call(ROUTES.state);
assert.equal(stateRes.status, 200);
const state = await stateRes.json();

console.log(`数据根：${state.root}`);
console.log(`模板：${state.templates.length} 套 · 节点：${state.settings.nodes.map((n) => `${n.name}${n.usable ? "" : "（不可用）"}`).join("、")}`);
console.log(`文章：${state.articles.length} 篇`);
if (!state.articles.length) {
  console.log("（空库。先跑 `node seeds/demo.mjs` 造一篇，或者从面板「＋ 新建」开始。）");
  process.exit(0);
}

for (const summary of state.articles) {
  const view = await (await call(ROUTES.article, `?id=${summary.id}`)).json();
  const { article, qa, ledger, checklist } = view;

  console.log(`\n── ${article.title}  (${article.id})`);
  console.log(`   段落 ${article.sections.length} · 封面 ${article.cover.versions.length} 版 · 已配图 ${checklist.length} 张 · 模板 ${article.template}`);
  console.log(`   QA：${qa.counts.error} 必改 / ${qa.counts.warn} 提醒 / ${qa.counts.info} 提示${qa.ok ? "（可发布）" : ""}`);
  for (const item of qa.items.filter((i) => i.level !== "info").slice(0, 5)) {
    console.log(`     · [${item.level}] ${item.title}`);
  }
  console.log(`   账本 ${ledger.length} 条，最近：${ledger.slice(-3).map((e) => e.type).join(" → ")}`);

  // 每个版本的图必须真在盘上（图被手删是现场最常见的事）
  for (const row of checklist) {
    const res = await call(ROUTES.image, `?id=${article.id}&slot=${row.slot}&v=${row.vid}`);
    assert.equal(res.status, 200, `图缺失：${row.slot}/${row.vid}（${row.file}）`);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.ok(bytes.length > 50, `${row.slot}/${row.vid} 图是空文件`);
  }
  console.log(`   图片可读：${checklist.length} 张全部命中`);

  // 导出必须能出，且全内联
  const htmlRes = await call(ROUTES.export, `?id=${article.id}&format=html`);
  assert.equal(htmlRes.status, 200);
  const html = await htmlRes.text();
  assert.ok(!/class=/.test(html), "导出的 HTML 里出现了 class（公众号后台会剥掉）");
  assert.equal(html, renderWechatBody(article).html, "导出结果与实际渲染一致");
  const md = await (await call(ROUTES.export, `?id=${article.id}&format=md`)).text();
  assert.ok(md.startsWith("---"), "Markdown 少了 front matter");
  const list = await (await call(ROUTES.export, `?id=${article.id}&format=checklist`)).text();
  assert.ok(list.includes("占位符"), "清单没写占位符");
  console.log(`   导出：HTML ${html.length} 字 / MD ${md.length} 字 / 清单 ${list.split("\n").length} 行`);

  // 账本文件本身可解析（append-only 的坏行不该让面板整体失败）
  const raw = await readFile(`${state.root}/articles/${article.id}/ledger.jsonl`, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  assert.ok(lines.length >= ledger.length, "账本行数与回读条数不符");
}

console.log("\nlive-data: OK（真实数据可渲染、图都在盘上、导出无 class、账本可解析）");
