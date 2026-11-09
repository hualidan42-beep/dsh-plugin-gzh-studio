/**
 * 宿主半冒烟：假 ctx（含 `connection.fetch.register` 捕获）跑 apply，
 * 然后把**整条链路真跑一遍**：建文章 → 改稿 → 出图（占位节点，真落盘）→ 再出一版 →
 * 切回旧版 → 读图 → 导出 → 越权探针。
 *
 * 为什么必须真落盘：这条链路的坑全在盘上（版本号自增、旧版不覆盖、current 指针、
 * 原子写、路径白名单），假一把内存 Map 全都能绿，装上去就炸。
 * @module verify/host-smoke
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, ROUTES, ROUTES as R } from "../index.js";
import { ID_PATTERN } from "../lib/store.js";

// ── 假宿主 ───────────────────────────────────────────────────────────────────
const provided = {};
const routes = new Map();
const effects = [];
function fakeCtx() {
  return {
    logger: { info: () => {}, warn: () => {} },
    effect: (factory) => effects.push(factory),
    provide: (name, service) => { provided[name] = service; },
    connection: {
      fetch: {
        register: (spec) => { routes.set(spec.path, spec); return () => routes.delete(spec.path); },
      },
    },
  };
}

const root = await mkdtemp(join(tmpdir(), "gzs-smoke-"));
apply(fakeCtx(), { root });

assert.equal(effects.length, 1, "注册了一个 effect（路由清理）");
for (const key of ["status", "state", "article", "create", "save", "script", "generate", "pick", "feedback", "export", "image", "node", "brief", "propose", "proposal", "decide", "deai", "adoptDeai"]) {
  assert.ok(routes.get(R[key]), `${key} 路由已注册：${R[key]}`);
}
assert.ok(provided.gzhStudio, "gzhStudio 服务已 provide");

/** 调一条路由。 */
const callGet = (path, query = "") => routes.get(path).fetch({ url: `http://x${path}${query}`, headers: new Headers() });
const callPost = (path, body) => routes.get(path).fetch({ url: `http://x${path}`, json: async () => body });
const jsonOf = async (response) => { assert.equal(response.status, 200, `期望 200，实得 ${response.status}`); return response.json(); };

// ── status / state（空库）────────────────────────────────────────────────────
{
  const status = await jsonOf(await callGet(R.status));
  assert.equal(status.ok, true, "status ok");
  assert.equal(status.root, root, "status 回的 root 是配置的 root");

  const state = await jsonOf(await callGet(R.state));
  assert.deepEqual(state.articles, [], "空库没有文章");
  assert.equal(state.templates.length, 6, "state 下发六套模板");
  assert.equal(state.settings.nodes.length, 1, "默认一个 fake 节点");
  assert.equal(state.settings.nodes[0].fake, true, "默认节点是占位的");
  assert.equal(state.settings.nodes[0].usable, true, "fake 节点可用");
  assert.deepEqual(state.activity, [], "空库没有最近动作");
}

// ── 新建 ─────────────────────────────────────────────────────────────────────
let article;
{
  const created = await jsonOf(await callPost(R.create, { title: "一家药企把审批从 14 天压到 3 天", audience: "IT 负责人", takeaway: "知道两个坑", sections: 3, template: "business" }));
  article = created.article;
  // id 形态跟着 store 的 ID_PATTERN 走：`gzh-<8位日期>-<4~32位十六进制>`。
  // 旧包生成 4 位、现在 16 位（randomBytes(8)），所以这里不能只认 4 位，
  // 否则宿主一改生成方式、这条断言就把正常功能当成坏了。
  assert.match(article.id, ID_PATTERN, "id 形态合法");
  assert.equal(article.sections.length, 3, "三段落位");
  assert.equal(article.template, "business", "模板生效");
  assert.equal(article.sections[0].image.slot, "sec-s1", "段落配图槽位是 sec-s1");
  assert.equal(created.qa.ok, false, "刚建的文章还不合格（没正文没封面）");

  const onDisk = JSON.parse(await readFile(join(root, "articles", article.id, "article.json"), "utf8"));
  assert.equal(onDisk.title, article.title, "真写到盘上了");

  const ledger = await readFile(join(root, "articles", article.id, "ledger.jsonl"), "utf8");
  assert.ok(ledger.includes('"type":"create"'), "建文章进账本");
}

// ── 改稿 ─────────────────────────────────────────────────────────────────────
{
  const saved = await jsonOf(await callPost(R.save, {
    id: article.id,
    patch: {
      title: "改过的标题",
      summary: "据公开年报，自建审批流的两个坑。",
      sections: [
        { id: "s1", heading: "坑一：以为流程是画出来的", body: "流程不是画出来的，是**跑**出来的。" },
        { id: "s2", heading: "坑二：以为审批越快越好", body: "快是结果，不是目标。" },
      ],
    },
  }));
  assert.equal(saved.article.title, "改过的标题", "标题改了");
  assert.ok(saved.changed.includes("title"), "changed 里报出改了 title");
  assert.equal(saved.article.sections[0].heading, "坑一：以为流程是画出来的", "段落标题改了");
  assert.equal(saved.article.sections.length, 3, "没写进去的段不会被删（只按 id 合并）");
  assert.equal(saved.qa.counts.error >= 1, true, "还没封面 → 仍有必改项");

  // 白名单：请求里塞进来的字段不许落盘
  const injected = await jsonOf(await callPost(R.save, { id: article.id, patch: { title: "x", evil: "boom", id: "hacked", sections: [{ id: "s1", body: "b", __proto__: { polluted: 1 } }] } }));
  assert.equal(injected.article.id, article.id, "id 不能被 patch 改掉");
  assert.equal("evil" in injected.article, false, "未知字段被忽略");
  assert.equal({}.polluted, undefined, "没有原型污染");

  // 槽位 prompt 落盘（这是「提示词不再一次性」的地基）
  const slotSaved = await jsonOf(await callPost(R.save, { id: article.id, patch: { slot: { slot: "cover", prompt: "晨光下的工厂车间，冷蓝调", negative: "文字，水印" } } }));
  assert.equal(slotSaved.article.cover.prompt, "晨光下的工厂车间，冷蓝调", "封面 prompt 落盘");
  assert.equal(slotSaved.article.cover.negative, "文字，水印", "反向词落盘");

  // 加段
  const added = await jsonOf(await callPost(R.save, { id: article.id, patch: { sections: [{ heading: "坑三", body: "新的一段" }] } }));
  assert.equal(added.article.sections.length, 4, "加了一段");
  const addedId = added.article.sections[3].id;
  assert.match(addedId, /^s[0-9]{1,4}$/, "新段 id 合法");

  // 删段
  const removed = await jsonOf(await callPost(R.save, { id: article.id, patch: { removeSections: [addedId] } }));
  assert.equal(removed.article.sections.length, 3, "删掉那段");
}

// ── 出图：fake 节点，真落盘，旧版不覆盖 ───────────────────────────────────────
let v1;
let v2;
{
  const first = await jsonOf(await callPost(R.generate, { id: article.id, slot: "cover", prompt: "晨光下的工厂车间，冷蓝调" }));
  v1 = first.version;
  assert.equal(v1.vid, "v001", "第一次是 v001");
  assert.equal(v1.width, 900, "封面宽 900");
  assert.equal(v1.height, 383, "封面高 383");
  assert.equal(v1.mime, "image/svg+xml", "占位图是 svg");
  assert.equal(first.article.cover.current, "v001", "current 指到 v001");

  const file1 = join(root, "articles", article.id, v1.file);
  const bytes1 = await readFile(file1);
  assert.ok(bytes1.length > 100, "图真在盘上");
  assert.ok(bytes1.toString("utf8").startsWith("<svg"), "内容真是 svg");
  assert.ok(bytes1.toString("utf8").includes("晨光下的工厂车间"), "prompt 画进占位图");

  const second = await jsonOf(await callPost(R.generate, { id: article.id, slot: "cover", prompt: "夜班，暖黄灯光" }));
  v2 = second.version;
  assert.equal(v2.vid, "v002", "第二次是 v002");
  assert.equal(second.article.cover.current, "v002", "current 跟到 v002");
  assert.equal(second.article.cover.versions.length, 2, "两版都在");
  // prompt 必须跟着最近一次出图走。旧逻辑是 `if (!prompt) 才写`，
  // 结果改了 prompt 出图后槽位里留的还是第一句，面板显示旧值、下次又用回旧的。
  assert.equal(second.article.cover.prompt, "夜班，暖黄灯光", "改过的 prompt 回写到槽位（不是留着第一次那句）");
  assert.equal(v2.prompt, "夜班，暖黄灯光", "版本上记的也是这一句");

  // **旧版不覆盖**：v001 的文件必须还在、且没被改动
  const stillThere = await readFile(file1);
  assert.deepEqual(stillThere, bytes1, "v001 一个字节都没变（旧版不覆盖）");
  assert.notEqual(await readFile(join(root, "articles", article.id, v2.file)).then((b) => b.toString("utf8")),
    bytes1.toString("utf8"), "v002 与 v001 内容不同");

  // 段落配图
  const sectionImage = await jsonOf(await callPost(R.generate, { id: article.id, slot: "sec-s1", prompt: "审批流白板" }));
  assert.equal(sectionImage.version.vid, "v001", "段落配图从 v001 起（版本号按槽位各自算）");
  assert.equal(sectionImage.version.width, 1024, "配图宽 1024");

  // 空 prompt 拒绝
  const noPrompt = await callPost(R.generate, { id: article.id, slot: "sec-s2" });
  assert.equal(noPrompt.status, 400, "没有 prompt 拒绝出图");

  // 不存在的槽位
  const badSlot = await callPost(R.generate, { id: article.id, slot: "sec-s9" });
  assert.equal(badSlot.status, 400, "没有这个槽位");

  // 不存在的文章
  const badId = await callPost(R.generate, { id: "gzh-20260101-0000", slot: "cover", prompt: "x" });
  assert.equal(badId.status, 404, "文章不存在");
}

// ── 账本 ─────────────────────────────────────────────────────────────────────
{
  const view = await jsonOf(await callGet(R.article, `?id=${article.id}`));
  const types = view.ledger.map((e) => e.type);
  assert.ok(types.includes("create"), "账本有 create");
  assert.ok(types.includes("save"), "账本有 save");
  assert.ok(types.filter((t) => t === "generate").length >= 3, "账本有三次 generate");
  const gen = view.ledger.filter((e) => e.type === "generate" && e.slot === "cover");
  assert.equal(gen.length, 2, "封面两次出图都在账本里");
  assert.equal(gen[0].vid, "v001");
  assert.equal(gen[0].prompt, "晨光下的工厂车间，冷蓝调", "账本记了当时的 prompt（改完 prompt 也能回查）");
  assert.equal(view.qa.items.some((i) => i.id === "cover-missing"), false, "出完封面就没有「没封面」这条");
  // 第 3 段是建文章时摆的空段、一直没填：报 section-empty 是对的（不替它掩盖）
  assert.equal(view.qa.items.some((i) => i.id === "section-empty" && i.scope === "sec-s3"), true, "空段落该报就报");
  assert.equal(view.qa.items.some((i) => i.level === "error" && i.scope !== "sec-s3"), false,
    `除空段外不该有别的 error（实得 ${view.qa.items.filter((i) => i.level === "error").map((i) => i.id).join(",")}）`);
  assert.equal(view.checklist.length, 2, "清单：封面 + 第一段图");
  assert.equal(view.checklist[0].vid, "v002", "清单用当前版本");
}

// ── 切版本 ───────────────────────────────────────────────────────────────────
{
  const picked = await jsonOf(await callPost(R.pick, { id: article.id, slot: "cover", vid: "v001" }));
  assert.equal(picked.article.cover.current, "v001", "切回 v001");
  assert.equal(picked.article.cover.versions.length, 2, "切版本不删版本");
  const ledger = await readFile(join(root, "articles", article.id, "ledger.jsonl"), "utf8");
  assert.ok(ledger.includes('"type":"pick"'), "切版本进账本");

  const badVid = await callPost(R.pick, { id: article.id, slot: "cover", vid: "v099" });
  assert.equal(badVid.status, 500, "切不存在的版本失败");

  // 切回最新，后面导出用 v002
  await jsonOf(await callPost(R.pick, { id: article.id, slot: "cover", vid: "v002" }));
}

// ── 读图 ─────────────────────────────────────────────────────────────────────
{
  const hit = await callGet(R.image, `?id=${article.id}&slot=cover&v=v002`);
  assert.equal(hit.status, 200, "读到图");
  assert.equal(hit.headers.get("content-type"), "image/svg+xml", "content-type 正确");
  assert.equal(hit.headers.get("cache-control"), "no-cache", "图片走 no-cache（换版本立刻生效）");
  const etag = hit.headers.get("etag");
  assert.match(etag ?? "", /^"v002-\d+"$/, "ETag 带版本与字节数");

  const cached = await routes.get(R.image).fetch({ url: `http://x${R.image}?id=${article.id}&slot=cover&v=v002`, headers: new Headers({ "if-none-match": etag }) });
  assert.equal(cached.status, 304, "ETag 命中回 304");

  const missing = await callGet(R.image, `?id=${article.id}&slot=cover&v=v009`);
  assert.equal(missing.status, 404, "没有的版本 404");

  // 白名单 / 越权：形态不合法的槽位 400（连拼路径的机会都不给）
  for (const probe of ["../article.json", "../../package.json", "cover/../x", "", "sec-s999999"]) {
    const res = await callGet(R.image, `?id=${article.id}&slot=${encodeURIComponent(probe)}&v=v001`);
    assert.equal(res.status, 400, `非法槽位 ${JSON.stringify(probe)} 一律 400`);
    assert.ok(!(await res.text()).includes("dsh-plugin"), "越权输入读不到插件文件");
  }
  // 形态合法但文章里没这个槽位 → 404（不是 400：参数没错，是东西不在）
  {
    const res = await callGet(R.image, `?id=${article.id}&slot=sec-s99&v=v001`);
    assert.equal(res.status, 404, "合法但不存在的槽位 404");
  }
  for (const probe of ["../../package.json", "../article.json", "gzh-20260101-9999", ""]) {
    const res = await callGet(R.article, `?id=${encodeURIComponent(probe)}`);
    assert.equal(res.status, 404, `非法/不存在的 id ${JSON.stringify(probe)} 404`);
    assert.ok(!(await res.text()).includes("dsh-plugin"), "越权输入读不到插件文件");
  }
  const badV = await callGet(R.image, `?id=${article.id}&slot=cover&v=v1`);
  assert.equal(badV.status, 400, "版本号形态不对 400");
}

// ── 反馈 ─────────────────────────────────────────────────────────────────────
{
  const bad = await callPost(R.feedback, { id: article.id, slot: "cover", vid: "v002" });
  assert.equal(bad.status, 400, "没有原话拒绝");

  const ok = await jsonOf(await callPost(R.feedback, { id: article.id, slot: "cover", vid: "v002", verbatim: "这张太干净了，要有点颗粒感" }));
  assert.ok(ok.ok, "记下反馈");
  const last = ok.ledger[ok.ledger.length - 1];
  assert.equal(last.type, "feedback");
  assert.equal(last.verbatim, "这张太干净了，要有点颗粒感", "原话逐字进账本");
  // 反馈不是记完就算了：接口要把「这个槽位有几条待带上」一并回给面板，
  // 否则面板只能自己再扫一遍账本，扫出来的口径和出图时用的那份不一定一样。
  assert.equal(ok.feedback.open, 1, "回包里带「待带上 1 条」");
  assert.equal(ok.feedback.bySlot.cover.open, 1, "按槽位分好组");
}

// ── Agent 起草入口 ───────────────────────────────────────────────────────────
{
  const written = await jsonOf(await callPost(R.script, {
    id: article.id,
    title: "Agent 写的标题",
    sections: [{ heading: "开头", body: "第一段" }, { heading: "中段", body: "第二段" }],
  }));
  assert.equal(written.article.title, "Agent 写的标题", "整篇脚本写入");
  assert.equal(written.article.sections.length, 2, "段数按脚本重排");
  assert.equal(written.article.cover.versions.length, 2, "写讲稿不动已出的图");
}

// ── 导出 ─────────────────────────────────────────────────────────────────────
{
  const htmlRes = await callGet(R.export, `?id=${article.id}&format=html`);
  assert.equal(htmlRes.status, 200);
  assert.match(htmlRes.headers.get("content-type") ?? "", /text\/html/);
  const html = await htmlRes.text();
  assert.ok(html.includes("__IMG_COVER__"), "封面占位符");
  assert.ok(!/class=/.test(html), "没有 class");
  assert.ok(html.includes("Agent 写的标题"), "正文有标题");

  const mdRes = await callGet(R.export, `?id=${article.id}&format=md`);
  const md = await mdRes.text();
  assert.ok(md.startsWith("---"), "md 有 front matter");
  assert.ok(md.includes("## 开头"), "md 有小标题");

  const listRes = await callGet(R.export, `?id=${article.id}&format=checklist`);
  const list = await listRes.text();
  assert.ok(list.includes("images/cover/v002.svg"), `清单指向当前版本文件（实得 ${list.slice(0, 120)}）`);

  const badFormat = await callGet(R.export, `?id=${article.id}&format=exe`);
  assert.equal(badFormat.status, 200, "未知格式退回 html 而不是崩");
  assert.match(badFormat.headers.get("content-type") ?? "", /text\/html/);

  const noArticle = await callGet(R.export, `?id=gzh-20260101-0000&format=html`);
  assert.equal(noArticle.status, 404, "导出不存在的文章 404");

  // 账本里记了导出
  const ledger = await readFile(join(root, "articles", article.id, "ledger.jsonl"), "utf8");
  assert.ok(ledger.includes('"type":"export"'), "导出进账本");

  // 连点三次同一个导出 → 「最近动作」里应该折叠成一条 ×3，而不是三行一样的
  await callGet(R.export, `?id=${article.id}&format=checklist`);
  await callGet(R.export, `?id=${article.id}&format=checklist`);
  await callGet(R.export, `?id=${article.id}&format=checklist`);
  const feed = await jsonOf(await callGet(R.state));
  const collapsed = feed.activity.find((r) => r.type === "export" && r.event?.format === "checklist");
  assert.ok(collapsed, "最近动作里有导出记录");
  assert.ok(collapsed.count >= 3, `连续的同种动作要折叠计数，实际 count=${collapsed.count}`);
  // 签名要和 store 里的判定口径一致：改的是不同字段（fields 不同）就是两件事，不能算重复。
  const sig = (r) => [
    r.id, r.event?.type, r.event?.format ?? "", r.event?.vid ?? "", r.event?.slot ?? "",
    r.event?.pid ?? "", (r.event?.fields ?? []).join(","), r.event?.verbatim ?? "",
  ].join("|");
  for (let i = 1; i < feed.activity.length; i += 1) {
    assert.notEqual(sig(feed.activity[i - 1]), sig(feed.activity[i]), "相邻的同种动作必须已经折叠");
  }
  assert.ok(feed.activity.every((r) => Number(r.count) >= 1), "每条动作都带 count");

  // 刷屏不能把别的动作挤出窗口：一次验收跑会连点十几次导出，
  // 若每篇只取 12 条原始账本，折叠完这栏就只剩「导出 ×12」一行。
  for (let i = 0; i < 12; i += 1) await callGet(R.export, `?id=${article.id}&format=html`);
  const flood = await jsonOf(await callGet(R.state));
  const kinds = new Set(flood.activity.map((r) => r.type));
  assert.ok(kinds.size >= 2, `连点导出后仍要看到别的动作，实际只有 ${[...kinds].join("/")}`);
  const exportRow = flood.activity.find((r) => r.event?.format === "html");
  assert.ok(exportRow && exportRow.count >= 12, "刷屏的那一串仍折叠成一条并计数");
}

// ── 改稿提案：先对照，人确认后才写正文 ─────────────────────────────────────────
{
  const view0 = await jsonOf(await callGet(R.article, `?id=${article.id}`));
  const before = view0.article;
  const first = before.sections[0];
  const second = before.sections[1];

  // 1) 提案：只落提案，正文一个字节都不动
  const proposed = await jsonOf(await callPost(R.propose, {
    id: article.id,
    note: "把开头压短，加一段",
    sections: [
      { id: first.id, heading: first.heading, body: "压短后的开头。" },
      { id: second.id, heading: second.heading, body: second.body },
      { heading: "新增段", body: "多出来的一段。" },
    ],
  }));
  const pid = proposed.proposal.pid;
  assert.match(pid, /^p-[0-9a-f]{8}$/, "提案 id 形态合法");
  assert.equal(proposed.proposal.status, "waiting-user", "提案停在待确认");
  const untouched = (await jsonOf(await callGet(R.article, `?id=${article.id}`))).article;
  assert.equal(untouched.sections[0].body, first.body, "**提案不改正文**");
  assert.equal(untouched.updatedAt, before.updatedAt, "提案不动 updatedAt（否则会把自己判成过期）");

  // 2) 提案独立落盘在文章目录里
  const pfile = JSON.parse(await readFile(join(root, "articles", article.id, "proposals", `${pid}.json`), "utf8"));
  assert.equal(pfile.status, "waiting-user", "提案落盘成 proposals/<pid>.json");
  assert.equal(pfile.baseUpdatedAt, before.updatedAt, "记住提案基于哪一版正文");

  // 3) 单份对照：能看出删了什么、加了什么
  const detail = await jsonOf(await callGet(R.proposal, `?id=${article.id}&pid=${pid}`));
  assert.equal(detail.blocked, "", "没漂移时可以裁决");
  const bodyChange = detail.proposal.changes.find((c) => c.field === "body");
  assert.ok(bodyChange, "正文改动单独成一条");
  assert.ok(bodyChange.rows.some((r) => r.type === "del"), "对照里有删的行");
  assert.ok(bodyChange.rows.some((r) => r.type === "add"), "对照里有加的行");
  assert.ok(detail.proposal.changes.some((c) => c.field === "new-section"), "新增段也进对照");
  assert.equal(detail.proposal.changes[0].diff, undefined, "不下发整份 diff（只给裁好的 rows）");

  // 4) 确认 → 正文真写入，且不动已经出好的图
  const decided = await jsonOf(await callPost(R.decide, { id: article.id, pid, confirmed: true }));
  assert.equal(decided.proposal.status, "confirmed", "确认后转终态");
  assert.equal(decided.article.sections[0].body, "压短后的开头。", "确认后正文真的写了");
  assert.equal(decided.article.sections.length, 3, "新增段进来了");
  assert.equal(decided.article.cover.versions.length, 2, "写讲稿不动已出的图");

  // 5) 终态不能重复裁决
  const again = await callPost(R.decide, { id: article.id, pid, confirmed: true });
  assert.equal(again.status, 409, "已裁决的提案拒绝再次裁决");

  // 6) 漂移：提案之后有人改盘 → 拒绝确认，而不是默默盖掉
  const afterConfirm = (await jsonOf(await callGet(R.article, `?id=${article.id}`))).article;
  const p2 = await jsonOf(await callPost(R.propose, {
    id: article.id,
    sections: [{ id: afterConfirm.sections[0].id, heading: afterConfirm.sections[0].heading, body: "再改一次" }],
  }));
  await jsonOf(await callPost(R.save, { id: article.id, patch: { summary: "人工插了一手" } }));
  const drift = await callPost(R.decide, { id: article.id, pid: p2.proposal.pid, confirmed: true });
  assert.equal(drift.status, 409, "正文中间被改过 → 拒绝确认");
  assert.match((await drift.json()).error.message, /过期/, "说清是过期，不是「出错了」");
  assert.equal((await jsonOf(await callGet(R.article, `?id=${article.id}`))).article.sections[0].body,
    "压短后的开头。", "被拒之后正文没被改");

  // 6b) 反例：只改**配置**（改摘要之外的东西）不能把提案判过期。
  //     踩过真实事故：绑定期号推高了 updatedAt，正文一个字没动，提案却被标「已过期」，
  //     人只好重提一遍同一份东西。所以过期的判据是**内容哈希**，不是 updatedAt。
  const p2b = await jsonOf(await callPost(R.propose, {
    id: article.id, summary: "提案想改的摘要",
  }));
  const beforeBind = (await jsonOf(await callGet(R.article, `?id=${article.id}`))).article;
  const sectionCountBefore = beforeBind.sections.length;
  await callPost(R.save, { id: article.id, patch: { pipeline: { episodeId: "historical-person-099", root: "/tmp/x" } } });
  const afterBind = (await jsonOf(await callGet(R.article, `?id=${article.id}`))).article;
  assert.notEqual(afterBind.updatedAt, beforeBind.updatedAt, "绑定确实推高了 updatedAt（前提成立才值得测）");
  const notStale = (await jsonOf(await callGet(R.article, `?id=${article.id}`))).proposals
    .find((p) => p.pid === p2b.proposal.pid);
  assert.equal(notStale.stale, false, "只改配置不该把提案判成过期（以前用 updatedAt 就会误判）");
  const stillOk = await callPost(R.decide, { id: article.id, pid: p2b.proposal.pid, confirmed: true });
  assert.equal(stillOk.status, 200, "配置改动之后仍能确认提案");
  const metaWritten = (await jsonOf(await callGet(R.article, `?id=${article.id}`))).article;
  assert.equal(metaWritten.summary, "提案想改的摘要", "只改摘要的提案能确认（以前永远 400「sections 必填」）");
  assert.equal(metaWritten.sections.length, sectionCountBefore, "只改元信息时段落一个不动、也不清空");
  assert.equal(metaWritten.sections[0].body, beforeBind.sections[0].body, "段落正文原样保留");
  // 6c) 性质交叉核对：声明 polish 却动摘要 → 服务端当场拒，不靠前端拦
  {
    const before = (await jsonOf(await callGet(R.article, `?id=${article.id}`))).article;
    const bad = await callPost(R.propose, {
      id: article.id, kind: "polish",
      sections: [{ id: before.sections[0].id, heading: before.sections[0].heading, body: "只改词句" }],
      summary: "顺手把摘要也改了",
    });
    assert.equal(bad.status, 400, "声明改词句却改摘要 → 400");
    assert.match((await bad.json()).error.message, /摘要/, "拒绝理由点出撞了哪条红线");
    const still = (await jsonOf(await callGet(R.article, `?id=${article.id}`))).article;
    assert.equal(still.summary, before.summary, "被拒的提案没写进正文");

    // 声明对了就放行，并且摘要里带上性质与路由
    const good = await jsonOf(await callPost(R.propose, {
      id: article.id, kind: "structure",
      sections: [{ id: still.sections[0].id, heading: still.sections[0].heading, body: "重写这一段的结构" }],
    }));
    const row = (await jsonOf(await callGet(R.article, `?id=${article.id}`))).proposals
      .find((p) => p.pid === good.proposal.pid);
    assert.equal(row.kind, "structure", "提案带上性质");
    assert.equal(row.route?.step, "04-write", "性质对应到该退的步");
    await callPost(R.decide, { id: article.id, pid: good.proposal.pid, confirmed: false });
  }

  // 7) 驳回：只记账本，正文不动
  const p3 = await jsonOf(await callPost(R.propose, { id: article.id, title: "提案里的标题" }));
  const titleBefore = (await jsonOf(await callGet(R.article, `?id=${article.id}`))).article.title;
  const rejected = await jsonOf(await callPost(R.decide, {
    id: article.id,
    pid: p3.proposal.pid,
    confirmed: false,
    quote: "修改方向不合适",
  }));
  assert.equal(rejected.proposal.status, "rejected", "驳回转终态");
  assert.equal(rejected.article.title, titleBefore, "驳回不动正文");
  const rejectionLedger = JSON.parse((await readFile(join(root, "articles", article.id, "ledger.jsonl"), "utf8"))
    .trim().split("\n").filter(Boolean).pop());
  assert.equal(rejectionLedger.quote, "修改方向不合适", "驳回原因写入账本原话");

  // 8) 没有实际改动 / 参数不合法 → 400，不是悄悄生成一条空提案
  const same = await callPost(R.propose, { id: article.id, title: titleBefore });
  assert.equal(same.status, 400, "与正文一致的提案被拒");
  assert.equal((await callPost(R.propose, { id: "gzh-20260101-0000", title: "x" })).status, 404, "文章不存在 404");
  assert.equal((await callGet(R.proposal, `?id=${article.id}&pid=../etc`)).status, 400, "非法 pid 400");

  // 9) 账本记下提案全过程
  const ledger = await readFile(join(root, "articles", article.id, "ledger.jsonl"), "utf8");
  for (const decision of ["proposed", "confirmed", "rejected"]) {
    assert.ok(ledger.includes(`"decision":"${decision}"`), `账本里有 proposal/${decision}`);
  }

  // 10) brief：把 audience/takeaway/forbidden 变成能贴给 Agent 的约束
  const briefRes = await callGet(R.brief, `?id=${article.id}`);
  assert.equal(briefRes.status, 200);
  const brief = await briefRes.text();
  assert.match(briefRes.headers.get("content-type") ?? "", /text\/plain/, "brief 是纯文本（直接粘贴）");
  assert.ok(brief.includes("IT 负责人"), "brief 带上了「讲给谁」");
  assert.ok(brief.includes("知道两个坑"), "brief 带上了「想让人带走什么」");
  assert.ok(brief.includes("gzh-studio.propose"), "brief 里写明改稿走 /propose");
  assert.ok(brief.includes("不要直接 /save"), "brief 提醒不要直接 /save");
  assert.ok(brief.includes("分段现状"), "brief 附分段现状，Agent 好按段号改");
}

// ── 节点配置 ─────────────────────────────────────────────────────────────────
{
  const added = await jsonOf(await callPost(R.node, {
    node: { id: "main-node", name: "主节点", baseURL: "https://api.example.com", apiKeyEnv: "GZS_TEST_KEY", model: "img-1", size: "1024x1024" },
    defaultNode: "main-node",
  }));
  assert.equal(added.settings.defaultNode, "main-node", "默认节点切过去");
  const node = added.settings.nodes.find((n) => n.id === "main-node");
  assert.equal(node.usable, false, "环境变量没设 → 标不可用");
  assert.match(node.reason, /GZS_TEST_KEY/, "说清缺哪个环境变量");

  // 配了 key 的节点不能因为"不可用"就出不了图 —— fake 节点仍然能出
  const stillFake = await jsonOf(await callPost(R.generate, { id: article.id, slot: "sec-s2", prompt: "办公室", node: "fake" }));
  assert.equal(stillFake.version.vid, "v001", "显式指定 fake 节点仍能出图");

  // 用不可用节点出图 → 400 且说明原因（显式指定就只试它，不偷偷换节点）
  const blocked = await callPost(R.generate, { id: article.id, slot: "sec-s2", prompt: "办公室", node: "main-node" });
  assert.equal(blocked.status, 400, "不可用节点拒绝出图");
  assert.match((await blocked.json()).error.message, /GZS_TEST_KEY/, "错误里点名缺的环境变量");

  // 没指定节点时：默认节点不可用 → 自动切到下一个可用节点（failover）
  const failover = await jsonOf(await callPost(R.generate, { id: article.id, slot: "sec-s2", prompt: "办公室 · 自动切节点" }));
  assert.equal(failover.version.node, "fake", "默认节点不可用时自动切到可用的 fake");
  const ledgerAfter = (await jsonOf(await callGet(R.article, `?id=${article.id}`))).ledger;
  const lastGen = ledgerAfter.filter((e) => e.type === "generate" && e.slot === "sec-s2").pop();
  assert.ok(Array.isArray(lastGen?.skipped), "账本记下这次跳过了哪些节点");
  assert.equal(lastGen.skipped[0].id, "main-node", "跳过的是默认节点");
  assert.match(lastGen.skipped[0].reason, /GZS_TEST_KEY/, "跳过原因也留在账本里");
  assert.equal(lastGen.tried, undefined, "配置层面就不可用的不算「试过」，不该混进 tried");

  // 节点配置不能把 key 存进盘（只存环境变量名）
  const settingsRaw = await readFile(join(root, "settings.json"), "utf8");
  assert.ok(settingsRaw.includes("GZS_TEST_KEY"), "存的是环境变量名");
  assert.ok(!/sk-/.test(settingsRaw), "没有任何看起来像 key 的串");
}

// ── 坏数据容错 ───────────────────────────────────────────────────────────────
{
  // 手写坏 article.json（模拟手改 / 断电）：列表跳过它，不整体失败
  const brokenDir = join(root, "articles", "gzh-20260101-beef");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(brokenDir, { recursive: true }));
  await writeFile(join(brokenDir, "article.json"), "{ not json", "utf8");
  const state = await jsonOf(await callGet(R.state));
  assert.equal(state.articles.some((a) => a.id === "gzh-20260101-beef"), false, "坏文章不进列表");
  assert.ok(state.articles.length >= 1, "好文章还在");

  // 最近动作：跨文章账本尾巴，按时间倒序，带得上文章标题与原始事件
  assert.ok(Array.isArray(state.activity) && state.activity.length, "空库之后有最近动作");
  for (const row of state.activity) {
    assert.ok(row.id && row.type, "每条动作都带文章 id 与事件类型");
    assert.equal(typeof row.ts, "number", "每条动作都带时间戳");
    assert.ok(row.event && row.event.type === row.type, "动作行带着原始事件（面板用 ledgerText 统一格式化）");
    assert.ok(!String(row.title).includes("坏文章"), "坏文章的账本不进动作流");
  }
  const desc = state.activity.map((r) => r.ts);
  assert.deepEqual(desc, [...desc].sort((a, b) => b - a), "动作按时间倒序");
  assert.ok(state.activity.length <= 14, "动作条数有上限（默认 14）");

  // 图被手删了：路由 404，不 500
  const files = await readdir(join(root, "articles", article.id, "images", "cover"));
  const victim = files.find((f) => f.startsWith("v001"));
  await import("node:fs/promises").then(({ rm }) => rm(join(root, "articles", article.id, "images", "cover", victim)));
  const gone = await callGet(R.image, `?id=${article.id}&slot=cover&v=v001`);
  assert.equal(gone.status, 404, "图不在盘上回 404");
}

// ── 库存：计数 / 生命周期 / 搜索 ───────────────────────────────────────────
{
  // 新建一篇空文章 → 应当是草稿、且算「空壳」
  const fresh = await jsonOf(await callPost(R.create, { title: "", sections: 2 }));
  const st1 = await jsonOf(await callGet(R.state, ""));
  assert.ok(st1.counts, "state 带 counts");
  // 生命周期只剩 draft / published 两档（草稿箱那一档 0.3.0 删掉了）
  assert.equal(st1.counts.byState.draft + st1.counts.byState.published,
    st1.counts.total, "两档之和等于总数");
  assert.ok(st1.counts.empty >= 1, "新建的空文章算空壳");
  const mine = st1.articles.find((a) => a.id === fresh.article.id);
  assert.equal(mine.lifecycle.value, "draft", "新文章默认草稿");
  assert.equal(mine.lifecycle.source, "default", "来源标 default，不是人标的");

  // 人标已发布 → 计数跟着变，来源变 manual
  const mark = await callPost(R.save, { id: fresh.article.id, patch: { lifecycle: "published" } });
  assert.equal(mark.status, 200, "标生命周期成功");
  const st2 = await jsonOf(await callGet(R.state, ""));
  assert.equal(st2.counts.byState.published, st1.counts.byState.published + 1, "已发布 +1");
  const marked = st2.articles.find((a) => a.id === fresh.article.id);
  assert.equal(marked.lifecycle.source, "manual", "人标之后来源是 manual");

  // 非法生命周期不许写
  const bad = await callPost(R.save, { id: fresh.article.id, patch: { lifecycle: "删库" } });
  const afterBad = (await jsonOf(await callGet(R.article, `?id=${fresh.article.id}`))).article;
  assert.equal(afterBad.lifecycle, "published", "非法值不生效");

  // 搜索：按状态筛 + 按正文搜
  const byState = await jsonOf(await callGet(R.state, "?state=published"));
  assert.ok(byState.articles.every((a) => a.lifecycle.value === "published"), "状态筛选只给已发布");
  assert.equal(byState.counts.total, st2.counts.total, "筛选后总数仍按全量");

  const byText = await jsonOf(await callGet(R.state, `?q=${encodeURIComponent("压短后的开头")}`));
  assert.ok(byText.matched >= 1, "能按正文内容搜到");
  assert.ok(!JSON.stringify(byState.articles).includes('"search"'), "检索文本不下发");

  // 非法状态词不能把库筛成空（用户会以为文章全没了）
  const typo = await jsonOf(await callGet(R.state, "?state=draf"));
  assert.equal(typo.matched, st2.counts.total, `状态词笔误时当作不筛，实际筛出 ${typo.matched}`);
  assert.equal(typo.filters.invalid, true, "并把「条件写错了」标出来");

  // 推送回执才让一篇进「草稿箱」；dry-run 回执不算
  await callPost(R.save, { id: fresh.article.id, patch: { lifecycle: "" } });
  const cleared = (await jsonOf(await callGet(R.article, `?id=${fresh.article.id}`))).article;
  assert.ok(!cleared.lifecycle, "空串能清掉手标");
}

// ── 标签：写入 / 去重 / 筛选 ────────────────────────────────────────────────
{
  const fresh2 = (await jsonOf(await callPost(R.create, { title: "标签测试稿", sections: 1 }))).article;
  // 大小写不敏感去重，但保留用户写的第一种写法
  const r1 = await callPost(R.save, { id: fresh2.id, patch: { tags: ["GxP", "gxp", " 药企 ", "", "药企"] } });
  assert.equal(r1.status, 200, "写标签成功");
  const a1 = (await jsonOf(await callGet(R.article, `?id=${fresh2.id}`))).article;
  assert.deepEqual(a1.tags, ["GxP", "药企"], `去重后剩两个，实际 ${JSON.stringify(a1.tags)}`);

  // 上限 12 个、单个 ≤ 20 字（不让标签变成第二个正文）
  const many = Array.from({ length: 30 }, (_, i) => `标签${i}`);
  await callPost(R.save, { id: fresh2.id, patch: { tags: many } });
  const a2 = (await jsonOf(await callGet(R.article, `?id=${fresh2.id}`))).article;
  assert.equal(a2.tags.length, 12, "最多 12 个标签");
  await callPost(R.save, { id: fresh2.id, patch: { tags: ["字".repeat(50)] } });
  const a3 = (await jsonOf(await callGet(R.article, `?id=${fresh2.id}`))).article;
  assert.equal(a3.tags[0].length, 20, "单个标签截到 20 字");

  // 按标签筛（大小写不敏感）+ 标签清单里带计数
  await callPost(R.save, { id: fresh2.id, patch: { tags: ["GxP", "药企"] } });
  const byTag = await jsonOf(await callGet(R.state, `?tag=${encodeURIComponent("gxp")}`));
  assert.ok(byTag.matched >= 1, "小写标签能筛到");
  assert.ok(byTag.articles.every((a) => (a.tags ?? []).some((t) => t.toLowerCase() === "gxp")), "筛出来的都有这个标签");
  assert.ok(Array.isArray(byTag.counts.tags) && byTag.counts.tags.length, "counts 带标签清单");
  assert.ok(byTag.counts.tags.some((t) => t.name === "GxP"), "清单保留原始大小写");

  // 清空标签
  await callPost(R.save, { id: fresh2.id, patch: { tags: [] } });
  const a4 = (await jsonOf(await callGet(R.article, `?id=${fresh2.id}`))).article;
  assert.deepEqual(a4.tags, [], "空数组能清空标签");

  // 月份筛选：非法格式不生效（不能把库筛成 0 篇）
  const badMonth = await jsonOf(await callGet(R.state, "?month=乱写"));
  assert.equal(badMonth.matched, byTag.counts.total, "非法月份当作不筛");
  assert.ok(Array.isArray(byTag.counts.months), "counts 带月份清单");
}

// ── 流水线绑定：状态是查盘得出的，不是存下来的 ─────────────────────────────
{
  const { mkdir } = await import("node:fs/promises");
  const pipeRoot = await mkdtemp(join(tmpdir(), "gzs-pipe-smoke-"));

  // 空树：台账都没有 → 必须判 needs-research，而且要指出下一步是 02
  const bind1 = await callPost(R.save, {
    id: article.id,
    patch: { pipeline: { episodeId: "historical-person-099", root: pipeRoot } },
  });
  assert.equal(bind1.status, 200, "绑定走 save 能成功");
  const v1pipe = await jsonOf(await callGet(R.pipeline, `?id=${article.id}`));
  assert.equal(v1pipe.bound, true, "绑定后 bound=true");
  assert.equal(v1pipe.status, "needs-research", `空树应判 needs-research，实际 ${v1pipe.status}`);
  assert.equal(v1pipe.step, "02-evidence", "下一步指向 02 证据台账");
  assert.equal(v1pipe.gates.length, 10, "十道门都要报，不能只报到卡住那道");
  assert.equal(v1pipe.drift, false, "刚绑完没有漂移");

  // 绑定那一刻的正文哈希被钉住了：改字之后 drift 必须翻真
  await callPost(R.save, { id: article.id, patch: { sections: [{ id: "s1", body: "改过的正文，与绑定时不同。" }] } });
  const v2pipe = await jsonOf(await callGet(R.pipeline, `?id=${article.id}`));
  assert.equal(v2pipe.drift, true, "面板改过正文，drift 要翻真");

  // 把台账补上 → 状态自己往前走，不需要重新绑定
  await mkdir(join(pipeRoot, "生产内部", "data", "research"), { recursive: true });
  await writeFile(join(pipeRoot, "生产内部", "data", "research", "historical-person-099.json"), JSON.stringify({
    episode_id: "historical-person-099",
    wechat_meta: { audience: "测试读者", evidence_count: 2, research_method: "Chrome 抓正文" },
    entries: [{ id: "E01", verified_verbatim: true }, { id: "E02", verified_verbatim: true }],
  }), "utf8");
  const v3pipe = await jsonOf(await callGet(R.pipeline, `?id=${article.id}`));
  assert.notEqual(v3pipe.status, "needs-research", "台账补上后不该再报缺台账");
  assert.equal(v3pipe.gates.find((g) => g.no === 3).state, "ok", "第 3 道门应当转成 ok");

  // 解绑：不能留一个「假装在某一歩」的状态
  await callPost(R.save, { id: article.id, patch: { pipeline: { episodeId: "", root: "" } } });
  const v4pipe = await jsonOf(await callGet(R.pipeline, `?id=${article.id}`));
  assert.equal(v4pipe.bound, false, "解绑后 bound=false");
  assert.equal(v4pipe.status, null, "未绑定不返回状态词");

  const ledgerText = await readFile(join(root, "articles", article.id, "ledger.jsonl"), "utf8");
  assert.ok(ledgerText.includes("pipeline:bound"), "绑定要进账本（审计留痕）");
  assert.ok(ledgerText.includes("pipeline:unbound"), "解绑也要进账本");

  // 但**不进「最近动作」**：那栏回答「我刚才写了什么」，绑定属于配置杂事。
  // 验收脚本每跑一次就多一对绑定记录，不排除的话会把内容工作全挤掉。
  const feedAfter = await jsonOf(await callGet(R.state));
  assert.ok(!feedAfter.activity.some((r) => (r.event?.fields ?? []).includes("pipeline:bound")), "绑定记录不进最近动作");
  assert.ok(!feedAfter.activity.some((r) => (r.event?.fields ?? []).includes("pipeline:unbound")), "解绑记录不进最近动作");
}

// ── 反馈回流：下一版出图必须真的带上 ─────────────────────────────────────────
{
  // 先记一条，再出一版封面，检查 prompt 里带没带、账本里记没记。
  // 条数不写死：前面几段验证也会出图，会把当时的 open 消费掉——写死数字等于
  // 把「这一段之前跑过什么」偷偷焊进断言里，加一条用例就红。
  const beforeGen = await jsonOf(await callGet(R.article, `?id=${article.id}`));
  const openBefore = beforeGen.feedback.bySlot.cover?.open ?? 0;

  await jsonOf(await callPost(R.feedback, {
    id: article.id, slot: "cover", verbatim: "构图往右偏一点，左边留白",
  }));
  const gen = await jsonOf(await callPost(R.generate, {
    id: article.id, slot: "cover", prompt: "诊室走廊，冷白光",
  }));
  assert.equal(gen.carried.length, openBefore + 1,
    `这一版该带上 ${openBefore + 1} 条待用反馈，实得 ${gen.carried.length}`);
  assert.ok(gen.carried.some((r) => r.verbatim.includes("留白")), "新记的那条也带上了");

  const ledger = await jsonOf(await callGet(R.article, `?id=${article.id}`));
  const genEvent = [...ledger.ledger].reverse().find((e) => e.type === "generate");
  assert.ok(Array.isArray(genEvent.feedback), "出图事件记下带了哪几条（消费凭据）");
  assert.equal(genEvent.feedback.length, openBefore + 1, "凭据条数与实际带的一致");
  // 槽位里存的 prompt 必须是干净原文：拼接只在发给模型那一刻发生，
  // 否则下一次读出来会看到上一轮的反馈被重复拼进 prompt，越拼越长。
  const coverPrompt = ledger.article.cover.prompt;
  assert.equal(coverPrompt, "诊室走廊，冷白光", "槽位 prompt 不落拼接内容");

  const after = await jsonOf(await callGet(R.article, `?id=${article.id}`));
  assert.equal(after.feedback.bySlot.cover?.open ?? 0, 0, "带过之后不再是「待带上」");
  assert.ok(after.feedback.used >= openBefore + 1, "都记为已带上");
}

// ── 去 AI 味：诊断 + 采纳成提案（不直接改正文）────────────────────────────────
{
  await jsonOf(await callPost(R.script, {
    id: article.id,
    sections: [{ heading: "现状", body: "接下来，我们来看审批流程。综上所述，这件事具有重要意义。" }],
  }));

  const diag = await jsonOf(await callGet(R.deai, `?id=${article.id}`));
  assert.ok(diag.ok, "诊断接口可用");
  assert.ok(diag.deai.total >= 2, `该抓到至少 2 句，实得 ${diag.deai.total}`);
  assert.ok(diag.deai.scanned >= 2, "干净与否都要报扫描量");

  const auto = diag.deai.sections
    .flatMap((row) => row.sentences.map((s) => ({ ...s, slot: row.slot })))
    .filter((s) => s.mode === "auto");
  assert.ok(auto.length >= 1, "至少有一句机器能直接改");

  const before = (await jsonOf(await callGet(R.article, `?id=${article.id}`))).article;
  const adopted = await jsonOf(await callPost(R.adoptDeai, {
    id: article.id,
    accepted: auto.map((s) => ({ slot: s.slot, start: s.start, end: s.end, after: s.after })),
  }));
  assert.ok(adopted.proposal.pid, "采纳后产出的是提案，不是直接改稿");
  assert.equal(adopted.proposals.length >= 1, true, "提案列表里能看到");

  const unchanged = (await jsonOf(await callGet(R.article, `?id=${article.id}`))).article;
  assert.equal(unchanged.sections[0].body, before.sections[0].body, "确认之前正文一个字都不能动");

  // 确认之后才真的写进去
  const decided = await jsonOf(await callPost(R.decide, {
    id: article.id, pid: adopted.proposal.pid, confirmed: true,
  }));
  assert.ok(!/接下来/.test(decided.article.sections[0].body), "确认后过渡词被删掉");
  assert.ok(decided.article.sections[0].body.includes("具有重要意义"), "机器没把握的那句原样留着，没被瞎改");

  const bad = await callPost(R.adoptDeai, { id: article.id, accepted: [] });
  assert.equal(bad.status, 400, "空采纳列表 400");
  const badSlot = await callPost(R.adoptDeai, {
    id: article.id, accepted: [{ slot: "../../etc", start: 0, end: 1, after: "x" }],
  });
  assert.equal(badSlot.status, 400, "非法槽位 400（不进 join）");
}

// ── 05/06 清单逐项确认（面板勾选 → 门变绿 → 状态词重算）────────────────────
{
  // 绑一个**盘上一点依据都没有**的期号（016 期：没有两份清单，也没有多轮审稿记录），
  // 才测得到「靠面板勾选把门抬起来」。023/026 都不行：
  //   023 盘上两份清单都在 → 门本来就 ok（basis=disk），测不到 uplift；
  //   026 没有清单但有审稿记录 → 门靠兜底过（basis=fallback），也测不到 uplift。
  await jsonOf(await callPost(R.save, {
    id: article.id,
    patch: { pipeline: { episodeId: "historical-person-016", root: "D:/work/历史内容生产" } },
  }));

  const before = await jsonOf(await callGet(R.article, `?id=${article.id}`));
  assert.equal(before.reviews.done, 0, "一开始一项都没勾");
  assert.equal(before.reviews.total, 16, "两份清单共 16 项");
  const gate5Before = (before.pipeline.gates ?? []).find((g) => g.no === 5);
  assert.ok(gate5Before, "有第 5 道门");
  // 016 盘上没有任何依据 → 勾之前必须是 unknown（不是 fail：判据不可用 ≠ 没做到）
  assert.equal(gate5Before.state, "unknown", `勾之前 016 应是 unknown，实得 ${gate5Before.state}`);

  // 非法参数一律 400：这些值后面要拼进文件路径和渲染
  for (const bad of [
    { id: article.id, kind: "../etc", item: "e1", checked: true },
    { id: article.id, kind: "editor", item: "e99", checked: true },
    { id: article.id, kind: "editor", item: "r1", checked: true },
    { id: article.id, kind: "editor", item: "e1", checked: "yes" },
  ]) {
    const res = await callPost(R.review, bad);
    assert.equal(res.status, 400, `非法参数 400：${JSON.stringify(bad)}`);
  }
  assert.equal((await callPost(R.review, { id: "gzh-bad-id", kind: "editor", item: "e1", checked: true })).status, 400, "坏 id 400");

  // 逐项勾满 16 项
  for (const kind of ["editor", "reader"]) {
    for (let i = 1; i <= 8; i += 1) {
      const res = await jsonOf(await callPost(R.review, {
        id: article.id, kind, item: `${kind === "editor" ? "e" : "r"}${i}`, checked: true,
      }));
      assert.ok(res.ok, `勾 ${kind} 第 ${i} 项`);
    }
  }
  const after = await jsonOf(await callGet(R.article, `?id=${article.id}`));
  assert.equal(after.reviews.done, 16, "16 项都勾上了");
  assert.equal(after.reviews.ok, true, "两份都勾满");
  assert.ok(after.reviews.list.every((one) => one.ok), "每份各自也算勾满");

  // 门要跟着变：勾满就不能还是 unknown
  const gate5After = (after.pipeline.gates ?? []).find((g) => g.no === 5);
  assert.equal(gate5After.state, "ok", "勾满后这道门必须 ok");
  // 依据有三种，**不许含糊**：disk（盘上两份清单）/ fallback（多轮审稿兜底）/
  // panel（面板逐项勾）。016 盘上什么依据都没有，勾满后只能是 panel。
  // 标成 disk 是骗人（人去翻文件会翻不到）；标成 fallback 也不对（没有兜底记录）。
  assert.equal(gate5After.reviewBasis, "panel", "盘上无任何依据时，勾满只能是 panel");
  assert.match(gate5After.detail, /面板/, "panel 的 detail 要说清依据是面板");
  // 盘上到底有没有，要单独给出去，别混进门的 state
  assert.equal(after.pipeline.reviewDisk.editor, false, "盘上确实没有编辑审清单");
  assert.equal(after.pipeline.reviewDisk.reader, false, "盘上确实没有读者审清单");
  // 勾满但盘上没有 → reconcile 必须 warn 并说「不能替代」
  assert.equal(after.pipeline.reviewReconcile.level, "warn", "勾满但盘上无清单要 warn");
  assert.match(after.pipeline.reviewReconcile.text, /不能替代/, "要明说勾选不能替代清单");
  // 节点条要跟着变：`buildNodes` 出来的节点只有 id，照 gate 字段找会永远不命中
  assert.equal((after.pipeline.nodes ?? []).find((n) => n.id === "05")?.state, "done", "节点条第 05 段变 done");

  // 取消勾一项 → 门退回、状态词重算
  const undone = await jsonOf(await callPost(R.review, {
    id: article.id, kind: "reader", item: "r4", checked: false,
  }));
  assert.equal(undone.reviews.done, 15, "取消一项后 15");
  assert.equal(undone.reviews.ok, false, "不再算勾满");
  const gate5Undone = (undone.pipeline.gates ?? []).find((g) => g.no === 5);
  // 016 盘上没有任何依据，唯一凭据就是面板勾选——取消一项，门必须退回去。
  // （如果哪天盘上有了兜底判据，门仍可 ok，那种情况要标 basis=fallback，不能标 panel。）
  assert.notEqual(gate5Undone.state, "ok", "没有盘上依据时，取消一项门就必须退回去");
  assert.equal(gate5Undone.reviewBasis, "none", "退了之后依据是 none");
  assert.match(String(gate5Undone.detail), /还差/, "要说清还差几项");
  assert.equal(undone.reviews.done, 15, "面板进度如实减少");

  // 勾选进账本：这是人对稿子的判断，属于内容工作，要留痕
  const ledger = await jsonOf(await callGet(R.article, `?id=${article.id}`));
  assert.ok(ledger.ledger.some((e) => e.type === "review"), "勾选记进账本");
  const reviewEvent = [...ledger.ledger].reverse().find((e) => e.type === "review");
  assert.equal(typeof reviewEvent.done, "number", "账本里记了当时的进度");

  // 解绑还原，别把测试状态留给后面的用例
  await jsonOf(await callPost(R.save, { id: article.id, patch: { pipeline: null } }));
}


// ── 平台版本（一稿多投）：0.4.x 已整块移除 ──────────────────────────────────
// `applyPatch` 不再处理 `targets`，客户端也没有发布包了（见 CHANGELOG）。
// 这一段的断言随功能一起删掉，别留着当噪音。

// ── dispose 清路由 ───────────────────────────────────────────────────────────
{
  const before = routes.size;
  const dispose = effects[0]();
  await dispose();
  assert.equal(routes.size, 0, `effect dispose 后路由清空（dispose 前 ${before} 条）`);

  // effect 的返回是 async 函数（Cordis 约定），第二遍调用不应炸
  assert.equal(typeof effects[0](), "function", "effect 工厂返回 dispose 函数");
}

console.log(`host-smoke: OK（真落盘 ${root}）
  出图 ${v1.vid}/${v2.vid} 两版并存 · 旧版字节未变 · 越权探针全 400/404 · 账本事件类型齐全`);
