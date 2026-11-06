/**
 * 纯函数单测：QA / 模板 / 导出器 / 占位图 / 尺寸探测。
 * 这一层不碰文件系统、不联网，跑得最快，改规则先跑它。
 * @module verify/qa-unit
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runQa, COVER, TITLE_MAX, SUMMARY_MAX, EXTREME_WORDS, CLICKBAIT_WORDS } from "../lib/qa.js";
import { TEMPLATES, TEMPLATE_IDS, templateOf, DEFAULT_TEMPLATE, READABILITY, clampTokens } from "../lib/templates.js";
import { inferKind, checkKind, alsoTouches, KIND_ROUTE, KINDS } from "../lib/proposal.js";
import { stock, counts, matches, stripSearch, checkState, LIFECYCLE_META, tagCounts, monthCounts } from "../lib/stock.js";
import { LIFECYCLE, LIFECYCLE_VALUES, lifecycleOf, markLifecycle } from "../lib/store.js";
import { renderWechatBody, renderMarkdown, renderChecklistText, imageChecklist, COVER_PLACEHOLDER, sectionPlaceholder } from "../lib/render.js";
import { placeholderSvg, probeSize, defaultSizeFor, describeNode, COVER_SIZE, SECTION_SIZE } from "../lib/generate.js";

// ── 模板 ─────────────────────────────────────────────────────────────────────
assert.equal(TEMPLATES.length, 6, "六套模板");
assert.equal(new Set(TEMPLATE_IDS).size, 6, "模板 id 不重复");
assert.ok(TEMPLATE_IDS.includes(DEFAULT_TEMPLATE), "默认模板在白名单里");
for (const t of TEMPLATES) {
  assert.ok(t.id && t.name && t.desc, `${t.id} 有 id/name/desc`);
  for (const key of ["ink", "sub", "accent", "bg", "paper", "rule", "font", "fontTitle", "caption"]) {
    assert.equal(typeof t.tokens[key], "string", `${t.id}.${key} 是字符串`);
    assert.ok(t.tokens[key].length > 0, `${t.id}.${key} 非空`);
  }
  for (const key of ["bodySize", "bodyLine", "paraGap", "h2Size", "radius", "letterSpacing"]) {
    assert.equal(typeof t.tokens[key], "number", `${t.id}.${key} 是数字`);
    assert.ok(t.tokens[key] > 0, `${t.id}.${key} > 0`);
  }
  assert.ok(["line", "dots", "none"].includes(t.tokens.divider), `${t.id}.divider 合法`);
  // 色值必须是 #rrggbb，导出器直接拼进 style，写错一个字符就是脏样式
  for (const key of ["ink", "sub", "accent", "accentSoft", "bg", "paper", "rule", "caption"]) {
    assert.match(t.tokens[key], /^#[0-9a-f]{6}$/i, `${t.id}.${key} 是 #rrggbb`);
  }
}
assert.equal(templateOf("nope").id, DEFAULT_TEMPLATE, "未知模板退回默认");
assert.equal(templateOf("night").id, "night", "按 id 取得到");

// ── 封面口径一致：qa 与 generate 必须是同一组数 ───────────────────────────────
assert.deepEqual({ width: COVER.width, height: COVER.height }, COVER_SIZE, "qa.COVER 与 generate.COVER_SIZE 一致");
assert.deepEqual(defaultSizeFor("cover"), { width: 900, height: 383, label: "900x383" }, "封面默认 900x383");
assert.deepEqual(defaultSizeFor("sec-s1"), { width: 1024, height: 576, label: "1024x576" }, "配图默认 16:9");

// ── QA：空文章 ───────────────────────────────────────────────────────────────
{
  const qa = runQa({});
  assert.equal(qa.ok, false, "空文章不合格");
  const ids = qa.items.map((i) => i.id);
  assert.ok(ids.includes("title-missing"), "抓没有标题");
  assert.ok(ids.includes("sections-empty"), "抓空正文");
  assert.ok(ids.includes("cover-missing"), "抓没有封面");
  for (const item of qa.items) {
    assert.ok(item.title && item.fix, `${item.id} 带结论与改法`);
    assert.ok(["error", "warn", "info"].includes(item.level), `${item.id} 级别合法`);
  }
}

// ── QA：标题长度 / 标题党 ────────────────────────────────────────────────────
{
  const tooLong = runQa({ title: "字".repeat(TITLE_MAX + 1), sections: [{ id: "s1", body: "正文" }], cover: {} });
  assert.ok(tooLong.items.some((i) => i.id === "title-too-long"), "超过 64 字报错");

  const long = runQa({ title: "字".repeat(40), sections: [{ id: "s1", body: "正文" }] });
  assert.ok(long.items.some((i) => i.id === "title-long" && i.level === "warn"), "超过 30 字提醒");

  const clickbait = runQa({ title: `震惊！${"字".repeat(5)}`, sections: [{ id: "s1", body: "正文" }] });
  assert.ok(clickbait.items.some((i) => i.id === "title-clickbait"), "抓标题党");

  const ok = runQa({
    title: "一家药企把审批从 14 天压到 3 天",
    summary: "据公开年报，自建审批流的两个坑与绕过办法。",
    sections: [{ id: "s1", body: "正文，据年报数据。", image: { slot: "sec-s1", prompt: "工厂", current: "v001", versions: [{ vid: "v001", width: 1024, height: 576 }] } }],
    cover: { slot: "cover", prompt: "封面", current: "v001", versions: [{ vid: "v001", width: 900, height: 383 }] },
  });
  assert.equal(ok.counts.error, 0, `干净文章没有 error（实得 ${ok.items.filter((i) => i.level === "error").map((i) => i.id).join(",")}）`);
}

// ── QA：摘要、段落、重复、极限词、无出处数字 ──────────────────────────────────
{
  const summary = runQa({ title: "标题", summary: "字".repeat(SUMMARY_MAX + 1), sections: [{ id: "s1", body: "正文" }] });
  assert.ok(summary.items.some((i) => i.id === "summary-too-long"), "摘要超长提醒");

  const noSummary = runQa({ title: "标题", sections: [{ id: "s1", body: "正文" }], cover: { versions: [{ vid: "v001", width: 900, height: 383 }], current: "v001" } });
  assert.ok(noSummary.items.some((i) => i.id === "summary-missing" && i.level === "info"), "没摘要给 info 不给 error");

  const empty = runQa({ title: "标题", sections: [{ id: "s1", heading: "小标题", body: "" }] });
  assert.ok(empty.items.some((i) => i.id === "section-empty" && i.scope === "sec-s1"), "空段落 error，且 scope 是 sec-s1");
  // 空段落不该再被算一次「没配图」：它已经报过 section-empty，
  // 分母也不该把这一段算进去（否则会显示成「1/6 段没配图」，而第 6 段根本不存在）。
  assert.ok(!empty.items.some((i) => i.id === "images-missing"), "空段落不进配图检查");
  const mixed = runQa({
    title: "标题",
    sections: [
      { id: "s1", heading: "有正文没图", body: "这一段有正文但没有配图。", image: { current: "", versions: [] } },
      { id: "s2", heading: "", body: "", image: { current: "", versions: [] } },
    ],
  });
  const missing = mixed.items.find((i) => i.id === "images-missing");
  assert.ok(missing, "有正文没配图要报");
  assert.ok(missing.title.startsWith("1/1 段"), `分母只算有正文的段，实际「${missing.title}」`);

  const longBody = runQa({ title: "标题", sections: [{ id: "s1", body: "字".repeat(601) }] });
  assert.ok(longBody.items.some((i) => i.id === "section-long"), "超长段落提醒");

  const dup = "开头一样的一段话，".repeat(8);
  const duplicated = runQa({ title: "标题", sections: [{ id: "s1", body: dup }, { id: "s2", body: dup }] });
  assert.ok(duplicated.items.some((i) => i.id === "section-duplicate"), "重复段落提醒");

  const extreme = runQa({ title: "标题", sections: [{ id: "s1", body: `这是${EXTREME_WORDS[0]}的方案` }] });
  assert.ok(extreme.items.some((i) => i.id === "extreme-words"), "极限词提醒");

  const unsourced = runQa({ title: "标题", sections: [{ id: "s1", body: "转化率提升 37%，成本降 20 万。" }] });
  assert.ok(unsourced.items.some((i) => i.id === "unsourced-numbers"), "无出处数字给 info");

  // 反向：写了出处就不该报
  const sourced = runQa({ title: "标题", sections: [{ id: "s1", body: "据白皮书，转化率提升 37%。" }] });
  assert.ok(!sourced.items.some((i) => i.id === "unsourced-numbers"), "有出处不报");

  // 「最后」这类含「最」的正常词不该被极限词误伤
  assert.ok(!EXTREME_WORDS.some((w) => "最后" === w), "极限词表里没有「最后」");
  const normal = runQa({ title: "标题", sections: [{ id: "s1", body: "最后一步是回滚。" }] });
  assert.ok(!normal.items.some((i) => i.id === "extreme-words"), "「最后」不误判");
  assert.ok(CLICKBAIT_WORDS.length >= 5, "标题党词表不为空");
}

// ── QA：封面比例 ─────────────────────────────────────────────────────────────
{
  const wrong = runQa({
    title: "标题",
    sections: [{ id: "s1", body: "正文，据年报。" }],
    cover: { slot: "cover", current: "v001", versions: [{ vid: "v001", width: 1024, height: 1024 }] },
  });
  assert.ok(wrong.items.some((i) => i.id === "cover-ratio"), "1:1 封面报错");

  const right = runQa({
    title: "标题",
    sections: [{ id: "s1", body: "正文，据年报。" }],
    cover: { slot: "cover", current: "v001", versions: [{ vid: "v001", width: 900, height: 383 }] },
  });
  assert.ok(!right.items.some((i) => i.id === "cover-ratio"), "900×383 不报");

  // current 指向不存在的版本时退回最新一版，而不是判「没有封面」
  const stale = runQa({
    title: "标题",
    sections: [{ id: "s1", body: "正文" }],
    cover: { slot: "cover", current: "v009", versions: [{ vid: "v001", width: 900, height: 383 }] },
  });
  assert.ok(!stale.items.some((i) => i.id === "cover-missing"), "current 失效不算没封面");
}

// ── 导出：公众号 HTML 必须全内联、无 class ────────────────────────────────────
{
  const article = {
    id: "gzh-20261026-abcd",
    title: "标题**加粗**部分",
    subtitle: "副标题",
    summary: "摘要",
    template: "magazine",
    cover: { slot: "cover", prompt: "封面 prompt", current: "v002", versions: [{ vid: "v001", file: "images/cover/v001.svg", width: 900, height: 383 }, { vid: "v002", file: "images/cover/v002.svg", width: 900, height: 383 }] },
    sections: [
      { id: "s1", heading: "第一段", body: "第一段正文。\n\n第二小节。", image: { slot: "sec-s1", caption: "图注", current: "v001", versions: [{ vid: "v001", file: "images/sec-s1/v001.svg", width: 1024, height: 576, prompt: "p" }] } },
      { id: "s2", heading: "", body: "第二段正文。", image: { slot: "sec-s2", current: "", versions: [] } },
    ],
  };
  const { html, checklist } = renderWechatBody(article);
  assert.ok(html.includes("<!".slice(0, 0)), "（占位）");
  assert.ok(!/class=/.test(html), "公众号 HTML 里不能有 class（后台会剥掉）");
  assert.ok(!/<style/.test(html), "不能有 <style>");
  assert.ok(html.includes(`src="${COVER_PLACEHOLDER}"`), "封面用占位符");
  assert.ok(html.includes(`src="${sectionPlaceholder(0)}"`), "第一段图用占位符");
  assert.ok(!html.includes(sectionPlaceholder(1)), "没图的段落不留占位符");
  assert.ok(html.includes("<strong"), "支持 **加粗**");
  assert.ok(html.includes("图注"), "图注渲染");
  assert.ok(html.includes("第一段"), "小标题渲染");
  // 模板 token 真的落进样式了（换模板必须换长相，否则「换风格」是假的）
  const business = renderWechatBody({ ...article, template: "business" }).html;
  assert.notEqual(business, html, "换模板 html 不同");
  const t = templateOf("magazine").tokens;
  assert.ok(html.includes(`font-family:${t.font}`), "正文用模板字族");
  assert.ok(html.includes(`background:${t.accentSoft}`), "摘要块用模板浅底");

  // 首字下沉只出现在 magazine 这类 dropCap 模板，且只出现一次
  assert.ok(html.includes("float:left"), "magazine 首字下沉生效");
  assert.equal((html.match(/float:left/g) ?? []).length, 1, "只下沉第一个字");
  const noDrop = renderWechatBody({ ...article, template: "business" }).html;
  assert.ok(!noDrop.includes("float:left"), "business 不下沉");

  // 清单：封面 + 有图的段，顺序封面在前
  assert.equal(checklist.length, 2, "两张图进清单");
  assert.equal(checklist[0].placeholder, COVER_PLACEHOLDER);
  assert.equal(checklist[0].vid, "v002", "清单用当前版本");
  assert.equal(checklist[1].label, "第 1 段配图");

  // Markdown
  const md = renderMarkdown(article);
  assert.ok(md.startsWith("---"), "md 带 front matter");
  assert.ok(md.includes('title: "标题**加粗**部分"'), "标题进 front matter");
  assert.ok(md.includes("## 第一段"), "小标题是 h2");
  assert.ok(md.includes(`![封面](${COVER_PLACEHOLDER})`), "封面图占位");
  assert.ok(!md.includes("gzh-20261026-abcd/"), "md 里不放绝对路径");

  // 清单文本
  const txt = renderChecklistText(article, { articleDir: "C:/x/y" });
  assert.ok(txt.includes("C:/x/y/images/cover/v002.svg"), "清单带绝对路径");
  assert.ok(txt.includes("900×383"), "清单带尺寸");
  assert.ok(renderChecklistText({ sections: [] }).includes("还没有任何图"), "空清单有话说");
}

// ── 占位图：确定性 + 尺寸 + 转义 ─────────────────────────────────────────────
{
  const a = placeholderSvg({ slot: "cover", prompt: "工厂车间，清晨", vid: "v001" });
  const b = placeholderSvg({ slot: "cover", prompt: "工厂车间，清晨", vid: "v001" });
  assert.equal(a, b, "同入参 → 同字节（可 diff、可缓存）");
  assert.ok(a.startsWith("<svg"), "是 svg");
  assert.ok(a.includes('width="900"') && a.includes('height="383"'), "封面尺寸写进 svg");
  assert.ok(a.includes("封面 2.35:1"), "标了槽位名");
  assert.ok(a.includes("v001"), "标了版本号");
  assert.ok(a.includes("工厂车间"), "prompt 摘要画上去");
  assert.ok(a.includes("900×383"), "标了尺寸文字");
  assert.ok(a.includes("占位图"), "标明是占位图");

  const escaped = placeholderSvg({ slot: "sec-s3", prompt: `<script>&"`, vid: "v002" });
  assert.ok(!escaped.includes("<script>"), "prompt 里的尖括号被转义");
  assert.ok(escaped.includes("&lt;script&gt;"), "转义成实体");
  assert.ok(escaped.includes("第 3 段配图"), "段号从 slot 解析");

  const long = placeholderSvg({ slot: "sec-s1", prompt: "长".repeat(500), vid: "v001" });
  assert.ok(long.includes("…"), "过长 prompt 截断加省略号");
  assert.ok(!long.includes("长".repeat(200)), "没有把 500 字全画上去");
}

// ── 尺寸探测 ─────────────────────────────────────────────────────────────────
{
  const svg = Buffer.from(placeholderSvg({ slot: "cover", prompt: "x", vid: "v001" }), "utf8");
  const probe = probeSize(svg);
  assert.deepEqual(probe, { width: 900, height: 383, ext: "svg", mime: "image/svg+xml" }, "SVG 尺寸探得到");

  // 手搓一个最小 PNG 头：magic + IHDR(宽 640 高 480)
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);
  assert.deepEqual(probeSize(png), { width: 640, height: 480, ext: "png", mime: "image/png" }, "PNG IHDR 探得到");

  assert.equal(probeSize(Buffer.from("not an image")), null, "认不出的返回 null，不瞎猜");
}

// ── 节点可用性 ───────────────────────────────────────────────────────────────
{
  assert.equal(describeNode({ fake: true }).usable, true, "fake 节点永远可用");
  assert.equal(describeNode({ baseURL: "", model: "m", apiKeyEnv: "K" }).usable, false, "缺 baseURL 不可用");
  assert.equal(describeNode({ baseURL: "ftp://x", model: "m", apiKeyEnv: "K" }).usable, false, "非 http 不可用");
  assert.match(describeNode({ baseURL: "https://x/v1", model: "m", apiKeyEnv: "EMPTY_KEY" }, {}).reason, /EMPTY_KEY/, "环境变量没设要说清是哪个");
  assert.equal(describeNode({ baseURL: "https://x", model: "m", apiKeyEnv: "K" }, { K: "sk-x" }).usable, true, "配齐就可用");
}

// ── 单 bundle 的边界：client.js 里不能出现 lib/ 的 import ─────────────────────
// 浏览器半拿不到 Node 能力，`import` 了就是运行期白屏，而假 ctx 冒烟照样会绿。
{
  const clientFile = fileURLToPath(new URL("../client.js", import.meta.url));
  const source = readFileSync(clientFile, "utf8");
  assert.ok(!/^\s*import\s/m.test(source), "client.js 没有顶层 import（只允许 require 平台模块）");
  assert.ok(!/require\(["']\.\//.test(source), "client.js 不许 require 插件内文件");
  assert.ok(!/require\(["']node:/.test(source), "client.js 不许 require node: 内置模块");
  const required = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(required)], ["react"], `client.js 只依赖 react，实得 ${JSON.stringify([...new Set(required)])}`);
}

// ── 插件目录清单（发行包不能漏文件）─────────────────────────────────────────
{
  const dir = fileURLToPath(new URL("../", import.meta.url));
  const top = readdirSync(dir);
  for (const name of ["package.json", "cordis.patch.yml", "index.js", "client.js", "README.md", "lib"]) {
    assert.ok(top.includes(name), `${name} 在包根目录`);
  }
  // 不写死文件清单：每加一个模块就得改测试，等于把某一刻的盘面钉进断言。
  // 改成「应有的都在 + 都是 .js + 没有空文件」，新模块不会被误报、空壳也照样抓得到。
  const libs = readdirSync(fileURLToPath(new URL("../lib/", import.meta.url)));
  for (const name of ["qa.js", "render.js", "store.js", "templates.js", "generate.js", "proposal.js", "diff.js", "pipeline.js"]) {
    assert.ok(libs.includes(name), `lib/${name} 存在`);
  }
  assert.ok(libs.every((n) => n.endsWith(".js")), "lib 下只有 .js");
  for (const name of libs) {
    const size = statSync(fileURLToPath(new URL(`../lib/${name}`, import.meta.url))).size;
    assert.ok(size > 200, `lib/${name} 不是空壳（${size} 字节）`);
  }
}


// ── 提案性质：改词句 / 改结构 / 改标题 / 改摘要 ─────────────────────────────
{
  const mk = (target, field) => ({ target, field, label: "x", before: "旧", after: "新" });
  // 只看种类，不看字数：三段各改一个字仍是 polish
  assert.equal(inferKind([mk("section:s1:body", "body"), mk("section:s2:body", "body"), mk("section:s3:body", "body")]),
    KINDS.polish, "三段各改正文仍是改词句");
  assert.equal(inferKind([mk("section:s1:heading", "heading")]), KINDS.polish, "只改小标题算改词句");
  assert.equal(inferKind([mk("section:s1:heading", "heading"), mk("section:s1:body", "body")]),
    KINDS.structure, "同段小标题+正文一起改 = 重写这一段");
  assert.equal(inferKind([mk("section:new:3", "new-section")]), KINDS.structure, "新增段算结构");
  assert.equal(inferKind([mk("article:title", "title")]), KINDS.title, "改标题");
  assert.equal(inferKind([mk("article:summary", "summary")]), KINDS.summary, "改摘要");
  // 混着改：按**退得最远**的那一步定，不能只退到 11 就完事
  assert.equal(inferKind([mk("article:summary", "summary"), mk("section:new:5", "new-section")]),
    KINDS.structure, "摘要+结构 → 退结构（4 在 11 之前）");
  assert.equal(inferKind([mk("article:title", "title"), mk("section:new:5", "new-section")]),
    KINDS.title, "标题+结构 → 退标题（3 最远）");

  // 声明不能当免责声明用：声明 polish 却动了 07 明令禁碰的东西，必须拦住
  assert.ok(checkKind("polish", [mk("article:summary", "summary")]).includes("摘要"), "polish 碰摘要要拒");
  assert.ok(checkKind("polish", [mk("article:title", "title")]).includes("标题"), "polish 碰标题要拒");
  assert.ok(checkKind("polish", [mk("section:new:3", "new-section")]).includes("段落增删"), "polish 增删段要拒");
  assert.equal(checkKind("polish", [mk("section:s1:body", "body")]), "", "polish 只改正文放行");
  assert.equal(checkKind("structure", [mk("section:new:3", "new-section")]), "", "structure 与改动一致放行");
  assert.equal(checkKind("", [mk("article:title", "title")]), "", "不声明就不拦（人工提案不受影响）");
  assert.ok(checkKind("乱写", [mk("article:title", "title")]).includes("性质只认"), "非法性质词要拒");

  // 四档都要有路由（退哪一步 + 红线一句话），步号格式统一
  for (const kind of Object.values(KINDS)) {
    const route = KIND_ROUTE[kind];
    assert.ok(route?.step && route?.skill && route?.rule, `${kind} 有路由信息`);
    assert.match(route.step, /^\d{2}-/, `${kind} 的步号是两位数字格式`);
  }
  assert.equal(KIND_ROUTE.polish.step, "07-deai", "改词句退 07");
  assert.equal(KIND_ROUTE.structure.step, "04-write", "改结构退 04");
  assert.equal(KIND_ROUTE.title.step, "03-angles", "改标题退 03");
  // 07 的红线必须写进路由文案里，不能只在 SKILL 里躺着
  assert.ok(/不许动标题、摘要/.test(KIND_ROUTE.polish.rule), "polish 的路由写着 07 的红线");

  // 捎带项要能说出来
  assert.deepEqual(alsoTouches([mk("article:summary", "summary")]), ["摘要"], "识别捎带摘要");
  assert.deepEqual(alsoTouches([mk("section:s1:body", "body")]), [], "纯改正文没有捎带");
}


// ── 库存：计数 / 筛选 / 搜索 ───────────────────────────────────────────────
{
  const row = (id, state, extra = {}) => ({
    id, lifecycle: { value: state, source: "manual" }, empty: false, images: 1,
    pipeline: { episodeId: "ep-1" }, search: "", ...extra,
  });
  const rows = [
    row("gzh-a", LIFECYCLE.DRAFT, { search: "审批 流程 药企" }),
    row("gzh-b", LIFECYCLE.DRAFT, { empty: true, images: 0, pipeline: null, search: "空壳" }),
    row("gzh-c", LIFECYCLE.IN_DRAFT_BOX, { search: "审批 数字化" }),
    row("gzh-d", LIFECYCLE.PUBLISHED, { search: "gxp 合规" }),
  ];

  // 计数：三档之和必须等于总数（这条防「少算了一篇」）
  const c = counts(rows);
  assert.equal(c.total, 4, "总数");
  assert.equal(c.byState.draft, 2, "草稿 2");
  assert.equal(c.byState.draftbox, 1, "草稿箱 1");
  assert.equal(c.byState.published, 1, "已发布 1");
  assert.equal(c.byState.draft + c.byState.draftbox + c.byState.published, c.total, "三档之和等于总数");
  assert.equal(c.empty, 1, "空壳 1");
  assert.equal(c.unbound, 1, "未绑期号 1");
  assert.equal(c.active, 3, "进行中 = 总数 - 已发布");

  // 筛选：状态是精确匹配，"all" 等于不筛
  assert.equal(stock(rows, { state: "all" }).matched, 4, "all 不筛");
  assert.equal(stock(rows, { state: LIFECYCLE.DRAFT }).matched, 2, "按草稿筛");
  assert.equal(stock(rows, { state: "乱写" }).matched, 4, "非法状态当不筛（不能筛成 0 篇）");
  assert.equal(stock(rows, { empty: true }).matched, 1, "只列空壳");
  // 计数基于全量：筛了以后总数还是 4（否则用户改了筛选，顶部数字跟着跳，没法对账）
  assert.equal(stock(rows, { state: LIFECYCLE.DRAFT }).counts.total, 4, "筛选后计数仍按全量");

  // 搜索：分词 AND，标题、小标题、正文都进检索串
  assert.equal(stock(rows, { q: "审批" }).matched, 2, "搜「审批」命中 2 篇");
  assert.equal(stock(rows, { q: "审批 数字化" }).matched, 1, "两个词要同时命中");
  assert.equal(stock(rows, { q: "查无此词" }).matched, 0, "搜不到就是 0");
  assert.equal(stock(rows, { q: "" }).matched, 4, "空词不筛");
  assert.ok(matches({ search: "abc def" }, "DEF"), "搜索不分大小写");
  assert.ok(matches({ search: "竞品分析" }, "   "), "只有空格等于没搜");
  // 状态 + 搜索是「与」关系
  assert.equal(stock(rows, { state: LIFECYCLE.DRAFT, q: "审批" }).matched, 1, "状态与搜索取交集");

  // **检索文本不下发**：正文拼串可能几十 KB，首屏载荷不该带
  const view = stock(rows, {});
  assert.ok(view.articles.every((a) => !("search" in a)), "下发项里不能有 search 字段");
  assert.ok(view.articles.every((a) => a.id), "其余字段照常");
  assert.deepEqual(Object.keys(stripSearch({ id: "x", search: "y" })), ["id"], "stripSearch 只去 search");

  // 状态词校验：前端传什么都不能直接信
  assert.equal(checkState("draft"), "draft", "合法状态通过");
  assert.equal(checkState("published"), "published", "合法状态通过");
  assert.equal(checkState("删库"), "", "非法状态给空串");
  assert.equal(checkState(undefined), "", "undefined 给空串");
  // 三档都要有中文名与排序权重
  for (const value of LIFECYCLE_VALUES) {
    assert.ok(LIFECYCLE_META[value]?.label, `${value} 有中文名`);
    assert.equal(typeof LIFECYCLE_META[value].order, "number", `${value} 有排序权重`);
  }
}

// ── 生命周期：推出来的 vs 人标的 ───────────────────────────────────────────
{
  // 没标记、也没有推草稿回执 → draft，来源 default
  const fresh = lifecycleOf({});
  assert.equal(fresh.value, "draft", "新文章默认草稿");
  assert.equal(fresh.source, "default", "来源标 default（不是人标的）");
  // 有推草稿回执 → draftbox，来源 inferred
  const pushed = lifecycleOf({}, { draftPushed: true });
  assert.equal(pushed.value, "draftbox", "推过草稿箱就推到 draftbox");
  assert.equal(pushed.source, "inferred", "来源标 inferred（不是人标的）");
  // 不能凭空猜 published：没有证据的「已发布」会漏掉待发的篇
  assert.notEqual(lifecycleOf({}, { draftPushed: true }).value, "published", "不猜已发布");
  // 人标了就以人标为准，且来源必须是 manual —— 面板要靠这个告诉用户「这是你标的」
  const marked = lifecycleOf({ lifecycle: "published", lifecycleAt: 123 }, { draftPushed: true });
  assert.equal(marked.value, "published", "人标优先");
  assert.equal(marked.source, "manual", "来源标 manual");
  assert.equal(marked.markedAt, 123, "带标记时间");
  // 非法值当作没标
  assert.equal(lifecycleOf({ lifecycle: "删库" }).value, "draft", "非法标记值当作没标");

  // markLifecycle：合法才写，重复写不产生变化
  const article = {};
  assert.equal(markLifecycle(article, "published", 999), true, "首次标记成功");
  assert.equal(article.lifecycle, "published", "写入值");
  assert.equal(article.lifecycleAt, 999, "写入时间");
  assert.equal(markLifecycle(article, "published", 1000), false, "同值再标不算变化");
  assert.equal(markLifecycle(article, "乱写", 1000), false, "非法值不写");
  // 空串 = 取消手标，退回自动推断。只能设不能撤的开关，标错一次就没法回头。
  assert.equal(markLifecycle(article, "", 1001), true, "空串能取消手标");
  assert.equal("lifecycle" in article, false, "取消后字段被删掉（不是留空串）");
  assert.equal("lifecycleAt" in article, false, "时间也一起清掉");
  assert.equal(markLifecycle(article, "", 1002), false, "已经没标了再取消不算变化");
  assert.equal(lifecycleOf(article).value, "draft", "取消后回到默认草稿");
  assert.equal(lifecycleOf(article).source, "default", "来源回到 default");
}


// ── 排版可读性基线（行业硬指标）────────────────────────────────────────────
{
  // 两份互相独立的来源给出的交集：正文 15px、行高 1.75、段距 20px、边距 8–16、正文色不用纯黑。
  // 这些不是「风格偏好」，是读者眼睛累不累的底线，所以六套模板都必须落在区间内。
  assert.equal(READABILITY.bodySize, 15, "基线正文字号 15px");
  assert.equal(READABILITY.bodyLine, 1.75, "基线行高 1.75");
  assert.equal(READABILITY.paraGap, 20, "基线段距 20px");
  assert.ok(READABILITY.padSide >= 8 && READABILITY.padSide <= 16, "基线左右留白落在 8–16");

  for (const id of TEMPLATE_IDS) {
    const t = templateOf(id).tokens;
    assert.ok(t.bodySize >= 14 && t.bodySize <= 16, `${id} 正文 ${t.bodySize}px 在 14–16 区间`);
    assert.ok(t.bodyLine >= 1.5 && t.bodyLine <= 1.9, `${id} 行高 ${t.bodyLine} 在 1.5–1.9`);
    assert.ok(t.paraGap >= 16 && t.paraGap <= 26, `${id} 段距 ${t.paraGap}px 在 16–26`);
    assert.ok(t.padSide >= 8 && t.padSide <= 16, `${id} 左右留白 ${t.padSide}px 在 8–16`);
    // 正文色不能是纯黑：两份指南都明确说视觉太硬
    assert.notEqual(String(t.ink).toLowerCase(), "#000000", `${id} 正文不能用纯黑`);
    assert.notEqual(String(t.ink).toLowerCase(), "#111111", `${id} 正文不能用近纯黑`);
  }

  // clamp 是出口保险：越界的值必须被拉回区间，合法的原样保留
  const pulled = clampTokens({ bodySize: 22, bodyLine: 3, paraGap: 60, padSide: 40 });
  assert.equal(pulled.bodySize, READABILITY.bodySize + READABILITY.sizeTolerance, "超大字号被拉回上界");
  assert.equal(pulled.bodyLine, 1.9, "超松行高被拉回上界");
  assert.equal(pulled.paraGap, 26, "超大段距被拉回上界");
  assert.equal(pulled.padSide, 16, "超大边距被拉回上界");
  const tiny = clampTokens({ bodySize: 9, bodyLine: 1.1, paraGap: 4, padSide: 0 });
  assert.equal(tiny.bodySize, READABILITY.bodySize - READABILITY.sizeTolerance, "过小字号被抬回下界");
  assert.equal(tiny.bodyLine, 1.65, "过紧行高被抬回下界");
  const kept = clampTokens({ bodySize: 16, bodyLine: 1.85 });
  assert.equal(kept.bodySize, 16, "区间内的值原样保留");
  assert.equal(kept.bodyLine, 1.85, "区间内的行高原样保留");

  // 导出 HTML 必须带左右留白：之前是 padding:2px 0，手机上正文直接贴边
  const htmlOut = renderWechatBody({ title: "T", template: "business", sections: [{ id: "s1", heading: "H", body: "正文" }],
    cover: { current: "", versions: [] } }).html;
  assert.match(htmlOut, /padding:2px \d+px/, "导出外层有左右留白");
  assert.ok(!/padding:2px 0[;">]/.test(htmlOut), "不能是左右 0 留白");
}


// ── 标签与月份：目录检索的两个入口 ─────────────────────────────────────────
{
  const row = (id, tags, updatedAt, state = LIFECYCLE.DRAFT) => ({
    id, tags, updatedAt, lifecycle: { value: state, source: "manual" },
    empty: false, images: 0, pipeline: { episodeId: "e" }, search: [...tags].join(" ").toLowerCase(),
  });
  const rows = [
    row("a", ["药企", "审批流"], new Date(2026, 9, 20).getTime()),
    row("b", ["药企"], new Date(2026, 9, 5).getTime()),
    row("c", ["数字化", "GxP"], new Date(2026, 8, 15).getTime()),
    row("d", [], new Date(2026, 8, 1).getTime()),
  ];

  // 标签聚合：计数正确、按篇数降序
  const tags = tagCounts(rows);
  assert.equal(tags.length, 4, "四个不同标签");
  assert.equal(tags[0].name, "药企", "用得最多的排最前");
  assert.equal(tags[0].count, 2, "药企 2 篇");
  assert.ok(tags.every((t) => t.count >= 1), "标签计数不出现 0");
  // 没有标签的文章不该造出空标签
  assert.ok(!tags.some((t) => t.name === ""), "空标签不进清单");

  // 月份聚合：按更新时间，降序
  const months = monthCounts(rows);
  assert.equal(months[0].month, "2026-10", "最近的月份在前");
  assert.equal(months[0].count, 2, "10 月 2 篇");
  assert.equal(months[1].month, "2026-09", "其次 9 月");
  assert.equal(months[1].count, 2, "9 月 2 篇");
  // 时间戳为 0 的行不该凭空算成 1970
  assert.equal(monthCounts([{ updatedAt: 0 }]).length, 0, "没有时间戳不算月份");

  // 标签筛选：精确匹配、不区分大小写
  assert.equal(stock(rows, { tag: "药企" }).matched, 2, "按标签筛到 2 篇");
  assert.equal(stock(rows, { tag: "gxp" }).matched, 1, "标签大小写不敏感");
  assert.equal(stock(rows, { tag: "GXP" }).matched, 1, "大写也能命中");
  assert.equal(stock(rows, { tag: "不存在的" }).matched, 0, "不存在的标签筛出 0");
  assert.equal(stock(rows, { tag: "" }).matched, 4, "空标签等于不筛");
  // 标签 + 状态 + 搜索是「与」关系
  assert.equal(stock(rows, { tag: "药企", state: LIFECYCLE.DRAFT }).matched, 2, "标签与状态取交集");
  assert.equal(stock(rows, { tag: "药企", q: "审批流" }).matched, 1, "标签与搜索取交集");

  // 月份筛选
  assert.equal(stock(rows, { month: "2026-10" }).matched, 2, "按月份筛");
  assert.equal(stock(rows, { month: "1999-01" }).matched, 0, "没有的月份筛出 0");
  assert.equal(stock(rows, { month: "" }).matched, 4, "空月份等于不筛");

  // 计数里带上聚合：前端要能直接点，不必自己算
  const view = stock(rows, {});
  assert.ok(Array.isArray(view.counts.tags), "counts 带标签清单");
  assert.ok(Array.isArray(view.counts.months), "counts 带月份清单");
  // 筛选后计数仍按全量（标签清单也不该随筛选缩水）
  assert.equal(stock(rows, { tag: "药企" }).counts.tags.length, 4, "筛选不改标签清单");
}

console.log(`qa-unit: OK（模板 ${TEMPLATES.length} 套 · QA 规则覆盖 ${new Set(runQa({}).items.map((i) => i.id)).size} 条空文章命中）`);
