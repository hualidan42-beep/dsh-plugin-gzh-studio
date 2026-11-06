/**
 * 客户端半冒烟：假 `ModuleLoader` / 假 React / 假 ctx 跑 `apply`，
 * 再**真调用一遍**三栏里的每个组件（不是只断言"它是函数"——
 * 之前踩过：组件从没被调用过，里面一个未定义标识符能把整块面板炸成白屏，而测试全绿）。
 * @module verify/client-harness
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

// ── 假 React ─────────────────────────────────────────────────────────────────
const elements = [];
const fakeReact = {
  createElement: (type, props, ...children) => {
    if (typeof type === "function") return type({ ...(props || {}), children });
    const el = { type, props, children };
    elements.push(el);
    return el;
  },
  useState: (init) => [typeof init === "function" ? init() : init, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (init) => ({ current: typeof init === "function" ? init() : init }),
  Fragment: Symbol.for("react.fragment"),
};

// ── 假 document（样式注入）───────────────────────────────────────────────────
const styles = [];
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ setAttribute() {}, id: "", set textContent(v) { styles.push(v); } }),
  head: { appendChild: () => {} },
};

// ── 假 window.__ModuleLoader__ ───────────────────────────────────────────────
const loaded = [];
globalThis.window = { __ModuleLoader__: { load: (bundle) => loaded.push(bundle) } };

const clientUrl = new URL("../client.js", pathToFileURL(import.meta.filename ?? import.meta.url)).href;
await import(clientUrl);

assert.equal(loaded.length, 1, "ModuleLoader.load 恰好一次");
const bundle = loaded[0];
assert.equal(bundle.id, "dsh-plugin-gzh-studio", "bundle id 与 package 名一致");
assert.equal(typeof bundle.factory, "function", "factory 是函数");

const mod = bundle.factory((name) => {
  if (name === "react") return fakeReact;
  throw new Error(`意外依赖：${name}`);
});
assert.equal(typeof mod.apply, "function", "导出 apply");
assert.deepEqual(mod.inject, ["slots", "sessions"],
  "注入 slots + sessions：后者用来 retain 左栏那条原生会话");
assert.equal(mod.PANEL_KEY, "gzh-studio", "面板键");
assert.equal(mod.PANEL_LABEL, "新媒体工作台", "侧边栏名字");

// ── 假 ctx ───────────────────────────────────────────────────────────────────
function fakeCtx() {
  const registrations = [];
  const slotInjects = {};
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    effects: [],
    effect: (factory) => ctx.effects.push(factory),
    slots: {
      inject: (name, factory) => { (slotInjects[name] ??= []).push(factory); },
      register: (spec, component) => { registrations.push({ spec, component }); return { spec, component }; },
    },
  };
  const mount = () => { for (const fs of Object.values(slotInjects)) for (const f of fs) f(); };
  return { ctx, registrations, slotInjects, mount };
}

// ── apply：主区面板 + 对话位 + 侧边栏入口 ────────────────────────────────────
{
  const { ctx, registrations, mount } = fakeCtx();
  mod.apply(ctx);
  assert.deepEqual(mod.inject, ["slots", "sessions"],
    "要注入 sessions：apply 里得把 ctx 抓给 useChatSession，没有它左栏开不了会话");
  assert.equal(ctx.effects.length, 3, "main + chat surface + sidebar.panellist 三个 effect");
  for (const factory of ctx.effects) factory();
  mount();

  const mains = registrations.filter((r) => r.spec.name === "main");
  const lists = registrations.filter((r) => r.spec.name === "sidebar.panellist");
  const chats = registrations.filter((r) => r.spec.name === mod.CHAT_SLOT);
  assert.equal(mains.length, 1, "注册了主区面板");
  assert.equal(lists.length, 1, "注册了侧边栏入口");
  assert.equal(chats.length, 1, "注册了 session 作用域的对话位");
  assert.equal(mains[0].spec.key, mod.PANEL_KEY, "主区 key 正确");
  // 对话位必须挂在 main 的 children 上并声明 session 作用域，否则宿主不会把
  // useSession / conversation.content 工厂槽注入进来，renderSlot 拿不到东西。
  assert.deepEqual(mains[0].spec.children, { [mod.CHAT_SLOT]: { kind: "single", scope: "session" } },
    "main 要声明对话位，且作用域是 session");
  assert.equal(typeof chats[0].component, "function", "对话位组件可渲染");
  assert.equal(lists[0].spec.id, mains[0].spec.key, "侧边栏入口与面板同 key（否则点了不亮）");
  assert.equal(typeof lists[0].spec.label, "function", "入口 label 是函数");
  assert.equal(lists[0].spec.label(), "新媒体工作台", "入口写着「新媒体工作台」");
  assert.equal(typeof mains[0].component, "function", "主区组件可渲染");

  // 样式只注入一次
  assert.equal(styles.length, 1, "注入了一份 CSS");
  const css = styles.join("\n");
  for (const cls of [".gzs-root", ".gzs-col--left", ".gzs-col--mid", ".gzs-col--right", ".gzs-phone", ".gzs-ver", ".gzs-qa"]) {
    assert.ok(css.includes(cls), `CSS 里有 ${cls}`);
  }
  assert.ok(css.includes(`width:${mod.PHONE_WIDTH}px`), "手机预览宽度用常量注入（375）");

  // 主区面板渲染（假 React 下是 loading 态，但不能抛）
  const panel = mains[0].component({});
  assert.ok(panel, "MainPanel 能返回元素");
}

// ── 渲染工具 ─────────────────────────────────────────────────────────────────
const texts = (node, out = []) => {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { node.forEach((n) => texts(n, out)); return out; }
  if (typeof node === "object" && node.children) node.children.forEach((n) => texts(n, out));
  return out;
};
const collect = (node, pred, out = []) => {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) { node.forEach((n) => collect(n, pred, out)); return out; }
  if (pred(node)) out.push(node);
  (node.children ?? []).forEach((n) => collect(n, pred, out));
  return out;
};
const cls = (n) => String(n.props?.className ?? "");

// ── 样本载荷（与宿主 `articleView` 同形状）──────────────────────────────────
const TEMPLATES = [
  { id: "business", name: "商务简报", tokens: { ink: "#1a1a1a", sub: "#5b6472", accent: "#1f6feb", accentSoft: "#f2f6fd", bg: "#ffffff", paper: "#f7f9fc", rule: "#e6e9ef", font: "sans", fontTitle: "sans", bodySize: 16, bodyLine: 1.85, paraGap: 22, h2Size: 20, radius: 8, letterSpacing: 0.2, caption: "#8a93a0", h2Bar: true, h2Prefix: "", divider: "line" } },
  { id: "magazine", name: "杂志编辑", tokens: { ink: "#22201d", sub: "#6b655c", accent: "#c0392b", accentSoft: "#fdf3f1", bg: "#fffdf9", paper: "#f7f3ea", rule: "#e8e0d2", font: "serif", fontTitle: "serif", bodySize: 17, bodyLine: 1.95, paraGap: 26, h2Size: 22, radius: 2, letterSpacing: 0.4, caption: "#9a8f80", h2Bar: false, h2Prefix: "—", divider: "dots" } },
];
const ARTICLE = {
  id: "gzh-20261026-abcd",
  title: "一家药企把审批从 14 天压到 3 天",
  subtitle: "两个坑",
  summary: "据公开年报。",
  template: "business",
  cover: { slot: "cover", prompt: "晨光下的工厂车间", negative: "文字", caption: "", current: "v002", versions: [
    { vid: "v001", width: 900, height: 383, node: "fake", model: "placeholder", createdAt: 1, bytes: 2048 },
    { vid: "v002", width: 900, height: 383, node: "fake", model: "placeholder", createdAt: 2, bytes: 3072 },
  ] },
  sections: [
    { id: "s1", heading: "坑一：以为流程是画出来的", body: "流程不是画出来的，是**跑**出来的。\n\n第二句。", image: { slot: "sec-s1", prompt: "白板", negative: "", caption: "图注", current: "v001", versions: [{ vid: "v001", width: 1024, height: 576, node: "fake", model: "placeholder", createdAt: 3, bytes: 1024 }] } },
    { id: "s2", heading: "坑二：以为审批越快越好", body: "快是结果，不是目标。", image: { slot: "sec-s2", prompt: "", negative: "", caption: "", current: "", versions: [] } },
  ],
};
const QA = {
  ok: false,
  counts: { error: 1, warn: 1, info: 1 },
  items: [
    { id: "cover-ratio", level: "error", scope: "cover", title: "封面比例不对", detail: "1024×1024", fix: "按 900×383 重出" },
    { id: "section-long", level: "warn", scope: "sec-s2", title: "第 2 段太长", detail: "800 字", fix: "拆开" },
    { id: "images-missing", level: "info", scope: "article", title: "1/2 段没配图", detail: "", fix: "至少给开篇配图" },
  ],
};
const LEDGER = [
  { v: 1, ts: Date.now() - 60_000, type: "create", note: "新建文章，2 段" },
  { v: 1, ts: Date.now() - 30_000, type: "generate", slot: "cover", vid: "v001", node: "fake", nodeName: "占位图（不联网）", prompt: "晨光下的工厂车间" },
  { v: 1, ts: Date.now() - 10_000, type: "pick", slot: "cover", vid: "v002", from: "v001" },
  { v: 1, ts: Date.now() - 5_000, type: "feedback", slot: "cover", vid: "v002", verbatim: "太干净了，要颗粒感" },
];
const NODES = [{ id: "fake", name: "占位图（不联网）", fake: true, usable: true, reason: "" }];

// ── 中间：手机预览 ───────────────────────────────────────────────────────────
{
  const tree = mod.PhonePreview({ article: ARTICLE, templates: TEMPLATES, selected: "sec-s1", onSelect: () => {} });
  const joined = texts(tree).join(" | ");
  assert.ok(joined.includes("375px"), "顶栏标了 375px");
  assert.ok(joined.includes("一家药企把审批"), "渲染标题");
  assert.ok(joined.includes("两个坑"), "渲染副标题");
  assert.ok(joined.includes("坑一：以为流程是画出来的"), "渲染小标题");
  assert.ok(joined.includes("第二句"), "正文按空行拆成两段");
  assert.ok(joined.includes("图注"), "渲染图注");
  assert.ok(joined.includes("第 2 段还没有配图"), "没图的段落给可点的空态");
  // 图片走宿主 image 路由，且带版本
  const imgs = collect(tree, (n) => n.type === "img");
  assert.equal(imgs.length, 2, "封面 + 第一段图");
  assert.equal(imgs[0].props.src, "/api/gzh-studio.image?id=gzh-20261026-abcd&slot=cover&v=v002", "封面指向当前版本 v002");
  assert.equal(imgs[1].props.src, "/api/gzh-studio.image?id=gzh-20261026-abcd&slot=sec-s1&v=v001", "段落图指向 v001");
  // 选中态高亮
  const selectedRings = collect(tree, (n) => /2px solid/.test(String(n.props?.style?.outline ?? "")));
  assert.equal(selectedRings.length, 1, "只高亮选中的那一块");
  // 预览即编辑：点正文块选中那一段；图片上直接「重出 / 换版」，不用再切 tab
  const clicks = [];
  const regen = [];
  const picks = [];
  const interactive = mod.PhonePreview({
    article: ARTICLE, templates: TEMPLATES, selected: "sec-s1",
    onSelect: (slot) => clicks.push(slot),
    onRegenerate: (slot) => regen.push(slot),
    onPickVersion: (slot, vid) => picks.push(`${slot}:${vid}`),
  });
  const secBlocks = collect(interactive, (n) => /(^| )gzs-psec( |$)/.test(cls(n)));
  assert.equal(secBlocks.length, 2, "两段都成了可点块");
  secBlocks[0].props.onClick({ stopPropagation() {} });
  assert.equal(clicks[0], "sec-s1", "点正文块选中那一段");
  const pimgButtons = collect(interactive, (n) => /(^| )gzs-pimg__b( |$)/.test(cls(n)));
  assert.equal(pimgButtons.filter((n) => texts(n).join("") === "重出").length, 2, "封面 + 第一段都有「重出」");
  pimgButtons.find((n) => texts(n).join("") === "重出").props.onClick({ stopPropagation() {} });
  assert.equal(regen[0], "cover", "重出作用在对应槽位（先到封面）");
  const swapButton = pimgButtons.find((n) => texts(n).join("") === "换版");
  assert.ok(swapButton, "多版本时给「换版」");
  swapButton.props.onClick({ stopPropagation() {} });
  assert.equal(picks[0], "cover:v001", "换版切到下一版");
  // 加粗
  const strongs = collect(tree, (n) => n.type === "strong");
  assert.equal(strongs.length, 1, "**跑** 变成 <strong>");
  // 空文章不崩
  assert.ok(texts(mod.PhonePreview({ article: null, templates: TEMPLATES })).join("").includes("还没有选中文章"), "空载荷有话");
  // 未知模板不崩（退回第一套）
  assert.doesNotThrow(() => mod.PhonePreview({ article: { ...ARTICLE, template: "nope" }, templates: TEMPLATES }), "未知模板不崩");
  assert.doesNotThrow(() => mod.PhonePreview({ article: ARTICLE, templates: [] }), "没有模板也不崩");

  // 空段落（没小标题、没正文、没图）在读者眼里不存在：不该留「还没有配图」的虚线框。
  // 真机上踩过：正文最末尾多出一个「第 6 段还没有配图 · 点这里出图」，像是文章没写完。
  const withEmpty = {
    ...ARTICLE,
    sections: [
      ARTICLE.sections[0],
      { id: "s2", heading: "", body: "", image: { slot: "sec-s2", prompt: "", negative: "", caption: "", current: "", versions: [] } },
      { id: "s3", heading: "收尾", body: "留痕之后再谈加速。", image: { slot: "sec-s3", prompt: "", negative: "", caption: "", current: "", versions: [] } },
    ],
  };
  const emptyTree = mod.PhonePreview({ article: withEmpty, templates: TEMPLATES });
  const emptyText = texts(emptyTree).join(" | ");
  assert.ok(!emptyText.includes("第 2 段还没有配图"), "空段落不渲染空态框");
  // 序号跟原始 index 走：中间跳过一段，后面的「第 3 段」不能变成「第 2 段」
  assert.ok(emptyText.includes("第 3 段还没有配图"), "跳过空段后序号仍按原始位置");

  // 末尾空段被跳过后，正文不能以一条分隔线收尾（那会是页面上一条无来由的横线）
  const rules = collect(emptyTree, (n) => n.props?.style?.height === 1);
  assert.equal(rules.length, 2, "分隔线只留在真正相邻的两段之间（题头线 + 第 1/3 段之间）");
}

// ── 左栏：结构列表 ───────────────────────────────────────────────────────────
{
  const tree = mod.Outline({ article: ARTICLE, selected: "sec-s1", onSelect: () => {}, onAddSection: () => {} });
  const rows = collect(tree, (n) => /(^| )gzs-item( |$)/.test(cls(n)));
  assert.equal(rows.length, 3, "封面 + 两段");
  const joined = texts(tree).join(" | ");
  assert.ok(joined.includes("首图 2.35:1 · v002"), "封面行显示当前版本");
  assert.ok(joined.includes("01"), "段号补零");
  assert.ok(joined.includes("缺图"), "没图的段标「缺图」");
  assert.ok(joined.includes("加一段"), "有加段按钮");
  assert.equal(collect(tree, (n) => cls(n).includes("gzs-item--on")).length, 1, "只有一个选中行");
  assert.ok(texts(mod.Outline({ article: null })).join("").includes("还没有文章"), "空载荷不崩");
}

// ── 右栏：检查器 ─────────────────────────────────────────────────────────────
const props = (selected) => ({
  article: ARTICLE, selected, templates: TEMPLATES, nodes: NODES, qa: QA, ledger: LEDGER, busy: false,
  onSaveArticle: () => {}, onSaveSection: () => {}, onSaveSlot: () => {}, onGenerate: () => {},
  onPick: () => {}, onFeedback: () => {}, onTemplate: () => {}, onSelect: () => {}, onDeleteSection: () => {},
});

// 封面槽位
{
  const tree = mod.Inspector(props("cover"));
  const joined = texts(tree).join(" | ");
  assert.ok(joined.includes("封面（900×383）"), "标题写明槽位与尺寸");
  assert.ok(joined.includes("v002"), "显示当前版本");
  // prompt 必须来自落盘字段（这是「提示词不再一次性」的判据）
  const inputs = collect(tree, (n) => n.type === "input" || n.type === "textarea");
  const promptInput = inputs.find((n) => String(n.props.placeholder ?? "").includes("主体 + 场景"));
  assert.ok(promptInput, "有 prompt 输入框");
  assert.equal(promptInput.props.value, "晨光下的工厂车间", "prompt 从 article.cover.prompt 读出来");
  // 版本条：两版，当前版带「当前」
  const vers = collect(tree, (n) => /(^| )gzs-ver( |$)/.test(cls(n)));
  assert.equal(vers.length, 2, "两个版本都在");
  assert.ok(texts(vers[0]).join("").includes("v002"), "倒序：最新在上");
  assert.ok(collect(tree, (n) => cls(n).includes("gzs-ver--on")).length === 1, "只有当前版高亮");
  assert.ok(joined.includes("旧版不覆盖"), "版本条上有口径说明");
  // 尺寸信息
  assert.ok(joined.includes("900×383"), "显示像素尺寸");
  // 出图按钮在
  const buttons = collect(tree, (n) => n.type === "button");
  assert.ok(buttons.some((b) => texts(b).join("").includes("出图")), "有出图按钮");
  // 只显示本槽位的 QA（封面那条），不串段
  const qaRows = collect(tree, (n) => /(^| )gzs-qa( |$)/.test(cls(n)));
  assert.equal(qaRows.length, 1, "封面只看到封面那条检查");
  assert.ok(texts(qaRows[0]).join("").includes("封面比例不对"), "封面那条是比例问题");
  // 账本按槽位过滤
  assert.ok(joined.includes("太干净了"), "反馈原话在账本里");
}

// 段落槽位
{
  const tree = mod.Inspector(props("sec-s1"));
  const joined = texts(tree).join(" | ");
  assert.ok(joined.includes("第 1 段配图"), "段号正确");
  const inputs = collect(tree, (n) => n.type === "input");
  const heading = inputs.find((n) => n.props.placeholder === "这一段讲什么");
  assert.ok(heading, "有段落小标题输入框");
  assert.equal(heading.props.value, "坑一：以为流程是画出来的", "小标题从载荷读");
  const areas = collect(tree, (n) => n.type === "textarea");
  assert.ok(areas.length >= 1, "正文是 textarea");
  assert.ok(String(areas[0].props.value).includes("流程不是画出来的"), "正文从载荷读");
  assert.ok(joined.includes("删掉这一段"), "有删段入口");
  assert.equal(collect(tree, (n) => /gzs-qa/.test(cls(n))).length, 0, "这一段没有检查项 → 显示「没有问题」");
  assert.ok(joined.includes("这项暂时没有问题"), "没有检查项时也说话");
}

// 整篇
{
  const tree = mod.Inspector(props("article"));
  const joined = texts(tree).join(" | ");
  assert.ok(joined.includes("整篇"), "标题是整篇");
  assert.ok(joined.includes("1 个必改"), "顶栏徽章报必改数");
  const selects = collect(tree, (n) => n.type === "select");
  assert.ok(selects.length >= 1, "有模板下拉");
  assert.equal(selects[0].props.value, "business", "当前模板");
  const options = collect(selects[0], (n) => n.type === "option");
  assert.equal(options.length, 2, "两套模板选项");
  const qaRows = collect(tree, (n) => /(^| )gzs-qa( |$)/.test(cls(n)));
  assert.equal(qaRows.length, 3, "整篇看到全部三条检查");
  assert.ok(joined.includes("改法："), "每条检查都写改法");
}

// 整篇 · 提案区（改稿先看对照，确认后才写）
const PROPOSALS = [
  { pid: "p-aaaa1111", status: "waiting-user", createdAt: Date.now() - 120_000, note: "压缩开头", summary: "改 2 段", count: 2, stale: false },
  { pid: "p-bbbb2222", status: "waiting-user", createdAt: Date.now() - 60_000, note: "", summary: "改 1 段", count: 1, stale: true },
  { pid: "p-cccc3333", status: "confirmed", createdAt: Date.now() - 300_000, decidedAt: Date.now() - 290_000, summary: "改 1 段", count: 1, stale: false },
];
{
  // 提案卡现在只在「检查」抽屉里出现（右栏「意见」栏已去掉），所以直接测组件本身
  const block = (extra = {}) => mod.ProposalBlock({
    proposals: PROPOSALS, detail: null, busy: false,
    onOpen() {}, onClose() {}, onDecide() {}, ...extra,
  });
  const empty = texts(block({ proposals: [] })).join(" | ");
  assert.ok(empty.includes("没有提案"), "无提案时有说明");
  assert.ok(empty.includes("/propose"), "告诉人改稿入口是 /propose");

  const tree = block();
  const joined = texts(tree).join(" | ");
  assert.ok(joined.includes("2 待确认"), "提案区标题报待确认数");
  // 右栏头部仍然报「几份提案」，只是不再展开卡片
  assert.ok(
    texts(mod.Inspector({ ...props("article"), proposals: PROPOSALS })).join(" | ").includes("2 份提案"),
    "整篇顶栏报待确认数（只数 waiting-user）",
  );
  assert.equal(
    collect(mod.Inspector({ ...props("article"), proposals: PROPOSALS }), (n) => /(^| )gzs-prop( |$)/.test(cls(n))).length,
    0,
    "右栏不再画提案卡（统一进「检查」）",
  );

  const cards = collect(tree, (n) => /(^| )gzs-prop( |$)/.test(cls(n)));
  assert.equal(cards.length, 2, "只给待确认的提案出卡片（已终态只留一行历史）");
  assert.equal(collect(tree, (n) => cls(n).includes("gzs-prop--stale")).length, 1, "过期的提案标黄");
  assert.ok(joined.includes("已过期"), "过期有徽章");
  assert.ok(joined.includes("别盖掉别人的改动"), "过期有解释");
  assert.ok(joined.includes("压缩开头"), "提案 note 显示出来");
  assert.ok(joined.includes("已确认"), "历史行标出已确认");

  // 按钮：每张卡都有 看对照 / 确认 / 驳回；驳回原因不默认展开，避免右栏变成表单堆。
  const buttons = cards.map((card) => texts(card).join(""));
  for (const label of ["看对照", "确认", "驳回"]) {
    assert.ok(buttons.some((text) => text.includes(label)), `每张提案卡都有「${label}」`);
  }
  assert.equal(collect(cards[0], (n) => cls(n).includes("gzs-prop__reject")).length, 0, "驳回原因默认收起");
  // 过期的那张不许点确认（防「照着一份过时的对照把正文改了」）
  const staleCard = cards.find((card) => cls(card).includes("gzs-prop--stale"));
  const staleButtons = collect(staleCard, (n) => n.type === "button");
  assert.ok(staleButtons.some((b) => texts(b).join("").includes("确认") && b.props.disabled === true),
    "过期的确认按钮是禁用的");

  // 驳回面板的样式契约存在；交互态在真实 React 中通过点击后重新渲染。
  assert.ok(mod.CSS.includes(".gzs-prop__reject"), "CSS 提供驳回原因面板");
  assert.ok(mod.CSS.includes(".gzs-prop__reject-option"), "CSS 提供驳回原因选项");
}

// 整篇 · 打开一份提案看逐段对照
{
  const detail = {
    proposal: {
      pid: "p-aaaa1111",
      changes: [
        {
          target: "section:s1:body", field: "body", label: "第 1 段 · 正文", truncated: false,
          rows: [
            { type: "same", line: "流程不是画出来的" },
            { type: "del", line: "是**跑**出来的。" },
            { type: "add", line: "是跑出来的。" },
            { type: "gap", line: "" },
            { type: "add", line: "加的一句。" },
          ],
        },
      ],
    },
    blocked: "",
  };
  const tree = mod.ProposalBlock({ proposals: PROPOSALS, detail, busy: false, onOpen() {}, onClose() {}, onDecide() {} });
  const joined = texts(tree).join(" | ");
  assert.ok(joined.includes("第 1 段 · 正文"), "对照标出是哪一处的改动");
  const addRows = collect(tree, (n) => cls(n).includes("gzs-diff__row--add"));
  const delRows = collect(tree, (n) => cls(n).includes("gzs-diff__row--del"));
  assert.equal(addRows.length, 2, "两行新增");
  assert.equal(delRows.length, 1, "一行删除");
  assert.ok(texts(addRows[0]).join("").startsWith("+ "), "新增行带 + 前缀");
  assert.ok(texts(delRows[0]).join("").startsWith("- "), "删除行带 - 前缀");
  assert.equal(collect(tree, (n) => cls(n).includes("gzs-diff__row--gap")).length, 1, "省略处画 …");
  assert.ok(joined.includes("收起"), "打开后可收起");

  // 被宿主拦住（过期 / 已裁决）时把理由写在卡里，而不是让人点了才知道
  const blocked = texts(mod.ProposalBlock({ proposals: PROPOSALS, detail: { ...detail, blocked: "正文在提案之后被改过" }, busy: false, onOpen() {}, onClose() {}, onDecide() {} })).join(" | ");
  assert.ok(blocked.includes("正文在提案之后被改过"), "拦住时显示原因");
  assert.ok(!blocked.includes("gzs-diff"), "拦住时不画对照");

  // 赛道口径：元信息里要说清「按哪套口径写」，并交代规则条数
  const tracked = texts(mod.Inspector({
    ...props("article"),
    proposals: [],
    track: { id: "medical", name: "医疗健康", tierLabel: "强合规", tone: "克制、给依据", structure: ["场景", "证据", "边界"], rules: { forbidden: 9, required: 1 } },
  })).join(" | ");
  assert.ok(tracked.includes("内容类型口径") && tracked.includes("医疗健康"), "元信息里要显示内容类型");
  assert.ok(tracked.includes("禁用词 9 条"), "要交代规则条数（不然用户不知道这套口径管什么）");
  const noTrack = texts(mod.Inspector({ ...props("article"), proposals: [] })).join(" | ");
  // 赛道是可选的：没选的时候不能像「缺了一步」，要说清「通用也能用」
  assert.ok(noTrack.includes("通用模式"), "没选赛道要说明通用模式照常可用");
}


// 空载荷
{
  assert.ok(texts(mod.Inspector({ ...props("cover"), article: null })).join("").includes("左侧选一段"), "空文章不崩");
  assert.doesNotThrow(() => mod.Inspector({ article: ARTICLE, selected: "cover" }), "缺 qa/ledger/nodes 也能渲染");
}

// ── 发布包：一稿多投 ────────────────────────────────────────────────────────
{
  const xhs = mod.platformPack(ARTICLE, "xhs");
  assert.equal(xhs.spec.name, "小红书", "按平台取档案");
  assert.ok(xhs.checks.some((c) => c.id === "cover"), "3:4 平台遇到 2.35:1 封面要提醒裁切");

  const longArticle = { ...ARTICLE, title: "这是一条很长很长很长很长很长很长很长很长很长的标题肯定超过二十个字了" };
  const longPack = mod.platformPack(longArticle, "xhs");
  assert.equal(longPack.titleCut, true, "超 20 字要截断");
  assert.ok(longPack.title.length <= 20, "截到上限内");
  assert.ok(longPack.checks.some((c) => c.id === "title"), "超标题要提醒");

  const linkPack = mod.platformPack(
    { ...ARTICLE, sections: [{ id: "s1", heading: "参考", body: "详见 https://example.com/a" }] },
    "douyin",
  );
  assert.ok(linkPack.checks.some((c) => c.id === "link"), "不能点外链的平台要提醒");

  assert.equal(mod.platformPack(ARTICLE, "wechat").spec.publish, "draft", "只有公众号能直推草稿");
  assert.equal(mod.platformPack(ARTICLE, "xhs").spec.publish, "package", "小红书只能出包");

  const dialogText = texts(mod.PublishPackDialog({ article: ARTICLE, onPush: () => {} })).join(" | ");
  ["公众号", "小红书", "抖音", "快手"].forEach((name) => {
    assert.ok(dialogText.includes(name), `发布包要列出「${name}」`);
  });
  assert.ok(dialogText.includes("复制标题+正文"), "每个平台都要能复制");
  assert.ok(dialogText.includes("去推草稿"), "公众号那行能直接跳推草稿");
  assert.ok(dialogText.includes("不是「一键发布」"), "要说清只有公众号能真推");
  assert.ok(!dialogText.includes("undefined"), "缺字段不能漏到界面上");
  assert.doesNotThrow(() => mod.PublishPackDialog({ article: null }), "空文章不崩");

  // 存过的平台版本优先于原稿
  const withTargets = {
    ...ARTICLE,
    targets: [{ platform: "xhs", title: "小红书版标题", body: "小红书版正文", hashtags: ["AI", "效率"] }],
  };
  const savedPack = mod.platformPack(withTargets, "xhs");
  assert.equal(savedPack.saved, true, "要标出这行用的是已存版本");
  assert.equal(savedPack.title, "小红书版标题", "已存标题覆盖原稿");
  assert.ok(savedPack.copyText.includes("小红书版正文"), "已存正文覆盖原稿");
  assert.ok(savedPack.copyText.includes("#AI #效率"), "话题跟着复制走");

  // 只存差异：和原稿一样的不落盘（否则一份正文会变成四五份）
  const diff = mod.targetsFromDraft(ARTICLE, {
    xhs: { title: "短标题", body: "", hashtags: "AI 效率" },
    wechat: { title: ARTICLE.title, body: "", hashtags: "" },
    douyin: { title: "", body: "", hashtags: "" },
  });
  assert.deepEqual(diff, [{ platform: "xhs", title: "短标题", hashtags: ["AI", "效率"] }], "只存和原稿不同的部分");

  const savedDialog = mod.PublishPackDialog({ article: withTargets, onPush: () => {}, onSave: () => {} });
  const inputs = collect(savedDialog, (n) => n.type === "input");
  assert.ok(inputs.some((n) => n.props.value === "小红书版标题"), "已存版本要回填到输入框");
  assert.ok(texts(savedDialog).join(" ").includes("保存平台版本"), "要有保存按钮");
  assert.ok(texts(savedDialog).join(" ").includes("已存平台版"), "要标出这一行已经存过");

  // 脏数据不能让面板崩（历史文件里 targets 可能是对象 / 字符串）
  assert.doesNotThrow(() => mod.platformPack({ ...ARTICLE, targets: "xhs" }, "xhs"), "targets 不是数组也不崩");
  assert.equal(mod.platformPack({ ...ARTICLE, targets: { xhs: {} } }, "xhs").saved, false, "非数组等于没存过");
  assert.deepEqual(mod.targetsFromDraft(ARTICLE, null), [], "空草稿＝清空");
  assert.equal(
    mod.targetsFromDraft({ ...ARTICLE, title: "T" }, { douyin: { title: 123, hashtags: 5 } }).length,
    1,
    "数字也能转成文本，不抛错",
  );
}

// ── 主题跟随宿主 ────────────────────────────────────────────────────────────
{
  assert.deepEqual(mod.parseCssColor("#338"), [51, 51, 136], "短 hex 也要能解析");
  assert.deepEqual(mod.parseCssColor("rgb(10, 20, 30)"), [10, 20, 30], "rgb() 带空格");
  assert.deepEqual(mod.parseCssColor("rgba(10,20,30,0.5)"), [10, 20, 30], "半透明取 RGB");
  assert.equal(mod.parseCssColor("rgba(0,0,0,0)"), null, "全透明不算背景（否则会一直往上找）");
  assert.equal(mod.parseCssColor("nonsense"), null, "解析不了就当没有");

  assert.equal(mod.themeFromRgb([16, 22, 18]), "dark", "深色背景走深色板");
  assert.equal(mod.themeFromRgb([238, 243, 236]), "light", "浅色背景走浅色板");
  assert.deepEqual(mod.mixRgb([0, 0, 0], [255, 255, 255], 0.5), [128, 128, 128], "混色按比例");

  const dark = mod.paletteFor("dark", [16, 22, 18]);
  const light = mod.paletteFor("light", [238, 243, 236]);
  assert.notEqual(dark["--gzs-ink"], light["--gzs-ink"], "深浅两套文字色不能一样");
  // 漏一个 token，就会有某个控件在深色下「瞎掉」——键必须一一对应
  assert.deepEqual(Object.keys(dark).sort(), Object.keys(light).sort(), "两套调色板的键要完全一致");
  assert.ok(Object.keys(light).length >= 22, `调色板要覆盖全部颜色 token，实际 ${Object.keys(light).length}`);
  assert.ok(mod.parseCssColor(mod.paletteFor("dark")["--gzs-paper"]), "没采样到背景也有默认值");

  // 混合方案：跟随明暗与色温，但不逐像素同色
  const paperOf = (mode, bg) => mod.parseCssColor(mod.paletteFor(mode, bg)["--gzs-paper"]);
  const cardOf = (mode, bg) => mod.parseCssColor(mod.paletteFor(mode, bg)["--gzs-card"]);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const hostLight = [238, 243, 236];
  const lightPaper = paperOf("light", hostLight);
  assert.ok(dist(lightPaper, hostLight) > 0, "纸色不是照抄宿主（要压一层很轻的倾向色）");
  assert.ok(dist(lightPaper, hostLight) < 20, "也不能压太重，否则和宿主脱节");
  assert.ok(dist(cardOf("light", hostLight), lightPaper) >= 3, "卡片与纸至少差一档（层次）");
  const hostDark = [16, 22, 18];
  const darkPaper = paperOf("dark", hostDark);
  assert.ok(dist(darkPaper, hostDark) > 0, "深色板提亮一点");
  assert.ok(dist(cardOf("dark", hostDark), darkPaper) > dist(darkPaper, hostDark), "深色下卡片比纸更亮");

  assert.ok(mod.saturationOf([200, 200, 200]) < 0.05, "灰色饱和度接近 0");
  assert.ok(mod.saturationOf([40, 80, 200]) > 0.5, "蓝主题饱和度高");
  assert.ok(
    mod.tintWeightFor("light", [40, 80, 200]) < mod.tintWeightFor("light", [200, 200, 200]),
    "彩色宿主上自动减少染色，避免绿上叠绿",
  );

  // 调色板里每个值都必须是合法颜色（写错一个就是某个控件变透明 / 变黑）
  for (const [mode, bg] of [["light", [238, 243, 236]], ["dark", [16, 18, 17]]]) {
    const pal = mod.paletteFor(mode, bg);
    for (const [key, value] of Object.entries(pal)) {
      assert.ok(mod.parseCssColor(value), `${mode} 的 ${key} 不是合法颜色：${value}`);
    }
  }

  // 采样：跳过透明，找到第一个不透明背景就停；全透明时退回 body token
  {
    const transparent = "rgba(0, 0, 0, 0)";
    const el = (bg = transparent, vars = {}) => ({
      __bg: bg,
      __vars: vars,
      parentElement: null,
    });
    const body = el(transparent, { "--dsw-alias-bg-base": "#ffffff" });
    const root = el(transparent);
    const mid = el("rgb(20, 30, 40)");
    root.parentElement = mid;
    mid.parentElement = body;
    const win = {
      document: { body, documentElement: { parentElement: null } },
      getComputedStyle: (node) => ({
        backgroundColor: node?.__bg ?? transparent,
        getPropertyValue: (name) => node?.__vars?.[name] ?? "",
      }),
    };
    assert.deepEqual(mod.sampleBackdrop(root, win), [20, 30, 40], "取最近的不透明背景");
    mid.__bg = transparent;
    assert.deepEqual(mod.sampleBackdrop(root, win), [255, 255, 255], "全透明时退回宿主 token");
    body.__vars = {};
    assert.equal(mod.sampleBackdrop(root, win), null, "什么都没有就返回 null（调用方退回系统偏好）");

    // 回归：面板**自己**的背景是上一轮染出来的纸色，不能把它当宿主背景再染一次
    const drift = { __bg: "rgb(229, 235, 228)", parentElement: null, closest: () => null };
    const outside = { __bg: transparent, parentElement: null, closest: () => null };
    const hostBody = { __bg: "rgb(255, 255, 255)", parentElement: null, __vars: {}, closest: () => null };
    drift.parentElement = outside;
    outside.parentElement = hostBody;
    const win2 = {
      document: { body: hostBody, documentElement: { parentElement: null } },
      getComputedStyle: (node) => ({
        backgroundColor: node?.__bg ?? transparent,
        getPropertyValue: (name) => node?.__vars?.[name] ?? "",
      }),
    };
    assert.deepEqual(mod.sampleBackdrop(drift, win2), [255, 255, 255], "不采自己的背景（否则每切一次主题就深一点）");

    // 面板内部的元素同样跳过（它们也用我们的变量）
    const inner = { __bg: "rgb(1, 2, 3)", parentElement: outside, closest: (sel) => (sel === ".gzs-root" ? {} : null) };
    assert.deepEqual(mod.sampleBackdrop({ parentElement: inner }, win2), [255, 255, 255], "面板内的元素不参与采样");

    // 写回：行内变量 + 模式标记；空元素不能抛
    const target = { style: { props: {}, setProperty(k, v) { this.props[k] = v; } }, dataset: {} };
    mod.applyThemeTo(target, "dark", [16, 18, 17]);
    assert.equal(target.dataset.gzsTheme, "dark", "标出当前模式");
    assert.equal(target.style.colorScheme, "dark", "color-scheme 一起设，滚动条/原生控件才跟着变");
    assert.ok(target.style.props["--gzs-paper"] && target.style.props["--gzs-ink"], "行内变量写进去了");
    assert.doesNotThrow(() => mod.applyThemeTo(null, "light", [255, 255, 255]), "没有元素也不能崩");
  }
}

// ── 新建表单 ─────────────────────────────────────────────────────────────────
{
  const tree = mod.NewArticle({ templates: TEMPLATES, onCreate: () => {}, onCancel: () => {}, busy: false });
  const joined = texts(tree).join(" | ");
  assert.ok(joined.includes("新建一篇"), "标题");
  assert.ok(joined.includes("讲给谁"), "问受众");
  assert.ok(joined.includes("想让人带走什么"), "问带走什么");
  assert.ok(joined.includes("先摆几段"), "问段数");
  assert.equal(collect(tree, (n) => n.type === "input").length >= 4, true, "四个输入位（标题/受众/带走/段数）");
  assert.doesNotThrow(() => mod.NewArticle({ templates: [], onCreate: () => {}, onCancel: () => {}, busy: true }), "没有模板也能开");

  // 赛道：新建时就要能选（不选也行，之后在顶栏补）
  const tracked = mod.NewArticle({
    templates: TEMPLATES,
    tracks: [
      { id: "medical", name: "医疗健康", tierLabel: "强合规", tone: "克制、给依据", defaultTemplate: "business" },
      { id: "pet-care", name: "宠物养护", tierLabel: "生活通用", custom: true },
    ],
    onCreate: () => {}, onCancel: () => {}, busy: false,
  });
  const trackedText = texts(tracked).join(" | ");
  assert.ok(trackedText.includes("内容类型"), "新建表单要有内容类型选择");
  assert.ok(trackedText.includes("医疗健康") && trackedText.includes("宠物养护"), "赛道选项来自下发列表");
  assert.ok(trackedText.includes("自定义"), "自定义赛道要标出来");
  assert.doesNotThrow(() => mod.NewArticle({ templates: [], tracks: undefined, onCreate: () => {}, onCancel: () => {} }), "没有赛道列表也能开");
}

// ── 工具函数 ─────────────────────────────────────────────────────────────────
{
  assert.equal(mod.countWords("一二三 4五"), 5, "字数不算空白");
  assert.equal(mod.sectionIndex("sec-s3"), 3, "段号解析");
  assert.equal(mod.sectionIndex("cover"), 0, "封面段号 0");
  assert.equal(mod.sectionIndex("bogus"), 0, "非法不崩");

  const v = mod.currentVersion({ current: "v009", versions: [{ vid: "v001" }, { vid: "v002" }] });
  assert.equal(v.vid, "v002", "current 失效退回最新（与宿主 pickVersion 同口径）");
  assert.equal(mod.currentVersion({ versions: [] }), null, "没有版本回 null");

  assert.equal(mod.imageUrl("gzh-20261026-abcd", "cover", "v001"),
    "/api/gzh-studio.image?id=gzh-20261026-abcd&slot=cover&v=v001", "图片地址");
  assert.equal(mod.imageUrl("", "cover", "v001"), "", "缺 id 返回空串（不发出坏请求）");

  // 账本人话
  assert.ok(mod.ledgerText({ type: "create", note: "新建文章，2 段" }).includes("新建"));
  assert.ok(mod.ledgerText({ type: "generate", slot: "sec-s2", vid: "v001", nodeName: "主节点", prompt: "x" }).includes("第 2 段"));
  assert.ok(mod.ledgerText({ type: "pick", slot: "cover", vid: "v002", from: "v001" }).includes("原 v001"));
  assert.ok(mod.ledgerText({ type: "feedback", slot: "cover", verbatim: "太干净" }).includes("太干净"));
  // 推草稿：文案必须是「进草稿箱」，且模拟回执要写清楚「没真推」
  const pushLine = mod.ledgerText({ type: "publish", persisted: true, mediaId: "D", chars: 6400, images: 3 });
  assert.ok(pushLine.includes("草稿箱") && pushLine.includes("6,400"), `推草稿文案，实际「${pushLine}」`);
  assert.ok(mod.ledgerText({ type: "publish", persisted: false }).includes("模拟"), "模拟回执要说清没真推");
  assert.ok(!/发布/.test(pushLine), "推草稿不能写成发布");
  assert.equal(mod.ledgerText({ type: "unknown-x" }), "unknown-x", "未知类型原样显示");
}

// ── 工作台根组件（假 React 下是 loading，但不能抛）───────────────────────────
{
  assert.doesNotThrow(() => mod.Workspace({}), "Workspace 首次渲染不抛");
  const tree = mod.Workspace({});
  assert.ok(texts(tree).join("").includes("新媒体工作台"), "顶栏标题在");
}

// ── 首页（Home）：卡片网格 ──────────────────────────────────────────────────
{
  const LIST = [
    { id: "gzh-a", title: "第一篇", subtitle: "副标题", template: "business", sections: 3, images: 2, cover: "v001", updatedAt: Date.now() - 3600000 },
    { id: "gzh-b", title: "", subtitle: "", template: "magazine", sections: 0, images: 0, cover: "", updatedAt: Date.now() - 86400000 * 3 },
  ];
  // 关键：总数给 7、列表只给 2 篇 —— 模拟「全量 7 篇，当前筛选出 2 篇」。
  // 若头部用 list.length 就会显示 2 篇，那用户永远看不到自己一共有多少。
  const COUNTS = { total: 7, byState: { draft: 4, draftbox: 1, published: 2 }, empty: 1, unbound: 5, active: 5, images: 2 };
  const tree = mod.Home({ list: LIST, root: "D:/data", onOpen: () => {}, onCreate: () => {},
    counts: COUNTS, filters: { state: "all", q: "" }, matched: 2 });
  const cards = collect(tree, (n) => /(^| )gzs-card( |$)/.test(cls(n)));
  assert.equal(cards.length, 3, "两张文章卡 + 一张新建卡");

  // 赛道：卡片上要标出这篇按哪套口径写的
  const trackHome = mod.Home({
    list: [{ ...LIST[0], track: "medical" }],
    root: "D:/data", onOpen: () => {}, onCreate: () => {},
    counts: COUNTS, filters: { state: "all", q: "" }, matched: 1,
    tracks: [{ id: "medical", name: "医疗健康", tierLabel: "强合规" }],
  });
  assert.ok(texts(trackHome).join(" ").includes("医疗健康"), "卡片要显示赛道名");
  const plainHome = mod.Home({
    list: [{ ...LIST[0] }], root: "", onOpen: () => {}, onCreate: () => {},
    counts: COUNTS, filters: { state: "all", q: "" }, matched: 1,
  });
  assert.ok(!texts(plainHome).join(" ").includes("医疗健康"), "没选赛道就不显示");

  // 首页按赛道筛：只列库里有稿的赛道，点一下切筛选
  const facetHome = mod.Home({
    list: [{ ...LIST[0], track: "medical" }],
    root: "D:/data", onOpen: () => {}, onCreate: () => {},
    counts: { ...COUNTS, byTrack: { medical: 1 } },
    filters: { state: "all", q: "" }, matched: 1,
    tracks: [
      { id: "medical", name: "医疗健康", tierLabel: "强合规" },
      { id: "pet-care", name: "宠物养护", tierLabel: "生活通用", custom: true },
    ],
  });
  const facetText = texts(facetHome).join(" | ");
  assert.ok(facetText.includes("内容类型"), "库存条要有内容类型筛");
  assert.ok(facetText.includes("医疗健康"), "库里有稿的赛道要出现");
  assert.ok(!facetText.includes("宠物养护"), "没有稿的赛道不占位置");
  const facetChips = collect(facetHome, (n) => /(^| )gzs-chip( |$)/.test(cls(n)));
  assert.ok(facetChips.length >= 2, "至少「全部」+ 一个赛道 chip");

  // 「通用」chip：只筛没选内容类型的稿；有这类稿才出现
  const genericFilters = [];
  const genericHome = mod.Home({
    list: [{ ...LIST[0], track: "" }],
    root: "", onOpen: () => {}, onCreate: () => {},
    counts: { ...COUNTS, byTrack: {}, untracked: 3 },
    filters: { state: "all", q: "" }, matched: 1,
    tracks: [{ id: "medical", name: "医疗健康", tierLabel: "强合规" }],
    onFilter: (next) => genericFilters.push(next),
  });
  const genericText = texts(genericHome).join(" | ");
  assert.ok(genericText.includes("通用"), "有通用稿时要出现「通用」chip");
  const genericChip = collect(genericHome, (n) => texts(n).join("") === "通用3")[0];
  assert.ok(genericChip, "能定位到「通用」chip（带篇数）");
  genericChip.props.onClick({});
  assert.equal(genericFilters[0].track, "__none", "点通用 → 用哨兵筛，不能用空串（空串是「不筛」）");

  // 没有通用稿时，chip 不占位置
  const noGeneric = mod.Home({
    list: [{ ...LIST[0], track: "medical" }], root: "", onOpen: () => {}, onCreate: () => {},
    counts: { ...COUNTS, byTrack: { medical: 1 }, untracked: 0 },
    filters: { state: "all", q: "" }, matched: 1,
    tracks: [{ id: "medical", name: "医疗健康", tierLabel: "强合规" }],
  });
  assert.ok(!texts(noGeneric).join(" ").includes("通用"), "没有通用稿时不显示空 chip");

  // 正在按通用筛时：chip 亮着，头部说明写清「内容类型：通用」
  const activeGeneric = mod.Home({
    list: [{ ...LIST[0], track: "" }], root: "", onOpen: () => {}, onCreate: () => {},
    counts: { ...COUNTS, byTrack: {}, untracked: 1 },
    filters: { state: "all", q: "", track: "__none" }, matched: 1,
    tracks: [{ id: "medical", name: "医疗健康", tierLabel: "强合规" }],
  });
  const activeText = texts(activeGeneric).join(" | ");
  assert.ok(activeText.includes("内容类型：通用"), "筛选生效时头部要说清是按通用筛的");
  assert.equal(
    collect(activeGeneric, (n) => cls(n).includes("gzs-chip--on") && texts(n).join("").startsWith("通用")).length,
    1,
    "通用 chip 处于选中态",
  );

  // 「筛出 0 篇」和「一篇都没有」必须分开：前者不该弹首启向导
  const filteredEmpty = mod.Home({
    list: [], root: "", onOpen: () => {}, onCreate: () => {},
    counts: { ...COUNTS, total: 3 }, filters: { state: "all", q: "不存在" }, matched: 0,
  });
  const filteredText = texts(filteredEmpty).join(" | ");
  assert.ok(filteredText.includes("没有匹配的稿"), "筛没了要说「没有匹配」，不是「还没有文章」");
  assert.ok(filteredText.includes("库里共 3 篇"), "要报分母，才不像库被清空");
  assert.ok(!filteredText.includes("三步开始"), "筛没了不该出现首启向导");
  const emptyLibrary = mod.Home({
    list: [], root: "", onOpen: () => {}, onCreate: () => {},
    counts: { ...COUNTS, total: 0 }, filters: { state: "all", q: "" }, matched: 0,
  });
  assert.ok(texts(emptyLibrary).join(" ").includes("三步开始"), "真空库才给首启向导");

  // 「现在可以做这些」：首屏先给待办，点一条直接进那一篇（不用先筛选再找）
  const queueOpenedIds = [];
  const queueFilters = [];
  const queue = mod.TodayQueue({
    list: [
      { id: "gzh-a", title: "配图没齐的那篇", sections: 3, images: 1 },
      { id: "gzh-b", title: "第二篇", sections: 0, images: 0, empty: true },
    ],
    counts: { total: 2, byState: { draft: 1, draftbox: 1, published: 0 }, empty: 1 },
    activity: [{ id: "gzh-b", title: "第二篇", event: { type: "save" }, ts: Date.now() }],
    onOpen: (id) => queueOpenedIds.push(id),
    onFilter: (next) => queueFilters.push(next),
    onCreate: () => {},
  });
  const queueText = texts(queue).join(" | ");
  assert.ok(queueText.includes("在草稿箱等发布"), "草稿箱待发要出现");
  assert.ok(queueText.includes("配图没齐"), "配图没齐要出现（数来自 list，不额外请求）");
  assert.ok(queueText.includes("接着上次改"), "最近在改的也要出现");
  const queueCards = collect(queue, (n) => /(^| )gzs-today__card( |$)/.test(cls(n)));
  queueCards[0].props.onClick({});
  assert.deepEqual(queueFilters[0], { state: "draftbox" }, "点草稿箱卡片去筛选");
  queueCards[1].props.onClick({});
  assert.equal(queueOpenedIds[0], "gzh-a", "点缺图卡片直接打开那一篇");
  assert.equal(mod.TodayQueue({ list: [], counts: { byState: {} }, activity: [] }), null, "没事可做就不占位置");

  const txt = texts(tree).join(" | ");
  assert.ok(txt.includes("第一篇"), "显示标题");
  assert.ok(txt.includes("3 段") && txt.includes("2 图"), "显示段数与已出图数");
  assert.ok(txt.includes("（无标题）"), "空标题有兜底");
  assert.ok(txt.includes("未出封面"), "无封面时给占位文案");
  // 头部总数来自 counts（不是卡片数）：卡片是筛选后的，总数是全量的，两者不能混
  assert.ok(txt.includes("7 篇"), `头部总数取 counts.total 而不是卡片数，实际「${(txt.match(/\d+ 篇/) ?? [""])[0]}」`);
  assert.ok(!txt.includes("2 篇 · 封面"), "不能把筛出的 2 篇当总数");
  // 计数条上四档都要在，且数字来自 counts
  assert.ok(txt.includes("草稿") && txt.includes("草稿箱") && txt.includes("已发布"), "计数条列出三档状态");

  // 筛选提示要把**四个维度都算上**：只看 q 与 state 会漏掉标签和月份，
  // 点了标签却显示「1 篇 · 封面、正文…」，看着像总数变小而不是被筛出来的。
  const tagged = texts(mod.Home({ list: LIST, root: "", onOpen: () => {}, onCreate: () => {},
    counts: COUNTS, filters: { state: "all", q: "", tag: "药企", month: "2026-10" }, matched: 1 })).join(" | ");
  assert.ok(tagged.includes("筛出 1 篇"), "标签/月份筛选也要显示「筛出」");
  assert.ok(tagged.includes("标签「药企」"), "说清按哪个标签筛的");
  assert.ok(tagged.includes("10 月"), "说清按哪个月筛的");
  const st = texts(mod.Home({ list: LIST, root: "", onOpen: () => {}, onCreate: () => {},
    counts: COUNTS, filters: { state: "draft", q: "" }, matched: 4 })).join(" | ");
  assert.ok(st.includes("筛出 4 篇") && st.includes("草稿"), "状态筛选也说清");
  // 标签只有数据存在时才画：空库不该顶一排空按钮
  const noTag = texts(mod.Home({ list: LIST, root: "", onOpen: () => {}, onCreate: () => {},
    counts: { ...COUNTS, tags: [], months: [] }, filters: { state: "all", q: "" } })).join(" ");
  assert.ok(!noTag.includes("标签"), "没有标签时不画标签行");

  // **结构断言**：`node --check` 只保证括号配对，保不住嵌套关系。
  // 踩过：少一个 `)` 让 `gzs-homehead` 没闭合，整个头部变成它的子元素——
  // 语法通过、所有文字断言通过，但页面上库存条跑到屏幕底部、卡片被拆成两处。
  // 所以这里断言顶层结构：首页根节点必须**恰好**是「头部 / 库存条 / 两栏」三段。
  const homeTree = mod.Home({ list: LIST, root: "D:/data", onOpen: () => {}, onCreate: () => {},
    counts: COUNTS, filters: { state: "all", q: "" }, matched: 2 });
  const top = (homeTree.children ?? []).filter((n) => n && typeof n === "object");
  // 顶层五段：头部 / 库存条 / 今日队列 / 两栏 / 往期。
  // 今日队列只在「有活可干」时才渲染，所以这里给它留一个位置但不写死是第几段，
  // 用 class 找位置——否则哪天队列空掉，断言会变成「结构坏了」。
  const topIndex = (needle) => top.findIndex((n) => cls(n).includes(needle));
  assert.ok(top.length === 4 || top.length === 5, `首页顶层 4–5 段，实际 ${top.length}`);
  assert.ok(cls(top[0]).includes("gzs-homehead"), "第一段是头部");
  assert.ok(cls(top[1]).includes("gzs-stock"), "第二段是库存条");
  assert.ok(cls(top[top.length - 2]).includes("gzs-homecols"), "倒数第二段是两栏");
  // 往期（仓库真源）挂在清单下方，不抢「我手上的稿」
  assert.ok(cls(top[top.length - 1]).includes("gzs-repo"), "最后一段是往期（仓库真源）");
  if (topIndex("gzs-today") >= 0) {
    assert.ok(topIndex("gzs-today") < topIndex("gzs-homecols"), "今日队列在两栏之前");
  }
  // 头部里只该有「标题区 + 弹簧 + 目录 + 新建」，不该把库存条或卡片吞进来
  const headKids = (top[0].children ?? []).filter((n) => n && typeof n === "object");
  assert.ok(headKids.length <= 5, `头部不该吞进别的区块，实际 ${headKids.length} 个子节点`);
  assert.ok(!collect(top[0], (n) => cls(n).includes("gzs-stock")).length, "库存条不能出现在头部里");
  assert.ok(!collect(top[0], (n) => /(^| )gzs-card( |$)/.test(cls(n))).length, "卡片不能出现在头部里");
  assert.ok(/4/.test(txt) && /2/.test(txt), "各档数字来自 counts");
  const noCounts = texts(mod.Home({ list: [], root: "", onOpen: () => {}, onCreate: () => {}, activity: [] })).join(" | ");
  assert.ok(noCounts.includes("0 篇"), "没有 counts 时总数按 0 算，不显示 NaN");
  assert.ok(txt.includes("business"), "显示模板名");

  const thumbs = collect(tree, (n) => cls(n).includes("gzs-card__thumb"));
  const withBg = thumbs.filter((n) => n.props?.style?.backgroundImage);
  assert.equal(withBg.length, 1, "只有那篇有封面的才画背景图");
  assert.ok(withBg[0].props.style.backgroundImage.includes("v=v001"), "封面地址带版本号（换版不串缓存）");
  assert.ok(withBg[0].props.style.backgroundImage.includes("gzh-a"), "封面地址带文章 id");

  const empty = mod.Home({ list: [], root: "", onOpen: () => {}, onCreate: () => {} });
  assert.ok(texts(empty).join("").includes("还没有任何文章"), "空列表给空态文案");
  assert.equal(collect(empty, (n) => /(^| )gzs-card( |$)/.test(cls(n))).length, 0, "空列表不画卡片");
  assert.doesNotThrow(() => mod.Home({}), "缺 props 不崩（list 不是数组也不崩）");
  assert.doesNotThrow(() => mod.Home({ list: null }), "list 为 null 不崩");

  // ── 最近动作 ──────────────────────────────────────────────────────────────
  const now = Date.now();
  const NOTES = [
    { id: "gzh-a", title: "第一篇", type: "generate", ts: now - 60_000, event: { type: "generate", ts: now - 60_000, slot: "cover", vid: "v003", nodeName: "网关", size: "1664x704" } },
    { id: "gzh-b", title: "", type: "save", ts: now - 7200_000, event: { type: "save", ts: now - 7200_000, fields: ["title"] } },
  ];
  const withFeed = mod.Home({ list: LIST, root: "", activity: NOTES, onOpen: () => {}, onCreate: () => {} });
  const rows = collect(withFeed, (n) => /(^| )gzs-act( |$)/.test(cls(n)));
  assert.equal(rows.length, 2, "两条动作各一行");
  const feedText = texts(withFeed).join(" | ");
  assert.ok(feedText.includes("最近动作"), "有「最近动作」标题");
  assert.ok(feedText.includes("2 条"), "标题右侧有条数");
  assert.ok(feedText.includes("出图 → v003"), "动作文案走 ledgerText（和账本同一套口径）");
  assert.ok(feedText.includes("1664×704"), "出图行带尺寸");
  assert.ok(feedText.includes("（无标题）"), "空标题在动作行里也有兜底");
  assert.ok(feedText.includes("刚刚") || feedText.includes("分钟前"), "时间用人话（复用 timeText）");

  // 折叠过的动作要显示次数（服务端把连续同种动作合成一条并给 count）
  const repeated = mod.Home({
    list: LIST, root: "", onOpen: () => {}, onCreate: () => {},
    activity: [{ id: "gzh-a", title: "第一篇", type: "export", ts: now, count: 4, event: { type: "export", ts: now, format: "html" } }],
  });
  assert.ok(texts(repeated).join(" | ").includes("×4"), "折叠过的动作显示次数");
  const single = mod.Home({
    list: LIST, root: "", onOpen: () => {}, onCreate: () => {},
    activity: [{ id: "gzh-a", title: "第一篇", type: "export", ts: now, count: 1, event: { type: "export", ts: now, format: "html" } }],
  });
  assert.ok(!texts(single).join(" | ").includes("×1"), "只有一次时不显示 ×1（噪音）");

  // 动态栏用 brief 口径：留尺寸，不留「尺寸吸附说明」和 prompt
  const briefer = mod.Home({
    list: LIST, root: "", onOpen: () => {}, onCreate: () => {},
    activity: [{
      id: "gzh-a", title: "第一篇", type: "generate", ts: now, count: 1,
      event: { type: "generate", ts: now, slot: "cover", vid: "v009", nodeName: "网关", size: "1664x704", note: "尺寸吸附为 1664x704（目标 900x383）", prompt: "晨光下的制药车间" },
    }],
  });
  const briefText = texts(briefer).join(" | ");
  assert.ok(briefText.includes("1664×704"), "动态行保留尺寸");
  assert.ok(!briefText.includes("尺寸吸附"), "动态行不带尺寸吸附说明（那是账本全量视图的事）");
  assert.ok(!briefText.includes("晨光下的制药车间"), "动态行不带 prompt 摘要");
  // 账本全量视图（治理/检查器）仍然要带这两样：brief 只是首页动态的口径
  const full = mod.ledgerText({ type: "generate", slot: "cover", vid: "v009", nodeName: "网关", size: "1664x704", note: "尺寸吸附为 1664x704（目标 900x383）", prompt: "晨光下的制药车间" });
  assert.ok(full.includes("尺寸吸附"), "账本全量口径保留尺寸说明");
  assert.ok(full.includes("晨光下的制药车间"), "账本全量口径保留 prompt 摘要");
  // 点一条要能进对应文章
  let opened = "";
  const clickable = mod.Home({ list: LIST, root: "", activity: NOTES, onOpen: (id) => { opened = id; }, onCreate: () => {} });
  const firstRow = collect(clickable, (n) => /(^| )gzs-act( |$)/.test(cls(n)))[0];
  firstRow.props.onClick();
  assert.equal(opened, "gzh-a", "点动作行打开对应文章");

  // 没有动作时不占版面
  const noFeed = mod.Home({ list: LIST, root: "", activity: [], onOpen: () => {}, onCreate: () => {} });
  assert.equal(collect(noFeed, (n) => /(^| )gzs-actpanel( |$)/.test(cls(n))).length, 0, "没有动作就不画这一栏");
  const soloCols = collect(noFeed, (n) => cls(n).includes("gzs-homecols"))[0];
  assert.ok(soloCols && cls(soloCols).includes("gzs-homecols--solo"), "没有动作时首页走单栏");
  assert.doesNotThrow(() => mod.Home({ list: LIST, activity: null }), "activity 为 null 不崩");
}

// ── 治理视图（Governance）：QA 分组 + 提案 + 账本 ───────────────────────────
{
  const tree = mod.Governance({ qa: QA, proposals: [], ledger: LEDGER, onJump: () => {} });
  const txt = texts(tree).join(" | ");
  assert.ok(txt.includes("检查结果"), "有检查结果面板");
  assert.ok(txt.includes("必改 1") && txt.includes("提醒 1") && txt.includes("提示 1"), "三个级别各自分组并带条数");
  assert.ok(txt.includes("封面比例不对"), "显示具体问题标题");
  assert.ok(txt.includes("改法：按 900×383 重出"), "显示改法（与右栏同一口径）");
  assert.ok(txt.includes("没有提案"), "无提案时给说明，不是空白");
  assert.ok(txt.includes("账本"), "有账本面板");

  const qaNodes = collect(tree, (n) => cls(n).startsWith("gzs-qa "));
  assert.equal(qaNodes.length, 3, "三条问题各渲染一次，不重复不丢");

  let jumped = null;
  const clickable = mod.Governance({ qa: QA, proposals: [], ledger: [], onJump: (s) => { jumped = s; } });
  const firstQa = collect(clickable, (n) => cls(n).startsWith("gzs-qa "))[0];
  assert.equal(typeof firstQa.props.onClick, "function", "给了 onJump 就绑点击");
  firstQa.props.onClick();
  assert.equal(jumped, "cover", "点问题能拿到它所属的段落");

  const plain = mod.Governance({ qa: QA, proposals: [], ledger: [] });
  const plainQa = collect(plain, (n) => cls(n).startsWith("gzs-qa "))[0];
  assert.equal(plainQa.props.onClick, undefined, "没给 onJump 就不绑点击（不会误触）");

  assert.ok(texts(mod.Governance({ qa: null, proposals: [], ledger: [] })).join("").includes("还没有检查结果"), "无 qa 有话");
  const clean = mod.Governance({ qa: { ok: true, counts: { error: 0, warn: 0, info: 0 }, items: [] }, proposals: [], ledger: [] });
  assert.ok(texts(clean).join("").includes("没有问题，可以直接发布"), "零问题时给通过文案而不是空白");
  assert.ok(texts(mod.Governance({ qa: QA, proposals: [], ledger: [] })).join("").includes("还没有动作记录"), "空账本有话");
  assert.doesNotThrow(() => mod.Governance({}), "缺 props 不崩");

  // 账本视图要滤掉配置类事件（绑定/解绑期号），但只在视图层滤——文件里留着做审计
  const noisy = [
    { type: "save", fields: ["pipeline:bound"], episodeId: "historical-person-027" },
    { type: "save", fields: ["summary"], verbatim: "" },
    { type: "save", fields: ["pipeline:unbound"] },
    { type: "export", format: "html" },
  ];
  const govText = texts(mod.Governance({ qa: QA, proposals: [], ledger: noisy })).join(" | ");
  assert.ok(!/绑定期号|解绑期号/.test(govText), "账本视图不显示绑定/解绑");
  assert.ok(govText.includes("改稿") && govText.includes("导出"), "真事仍在");
  assert.ok(/略去 \d+ 条配置/.test(govText), "略去的条数要说出来，不能偷偷藏");

  // 相邻同种动作要折叠：验收跑会连点十几次导出，不折就把 40 行窗口刷满
  const flood = Array.from({ length: 12 }, () => ({ type: "export", format: "html" }));
  const floodText = texts(mod.Governance({ qa: QA, proposals: [], ledger: flood })).join(" | ");
  assert.ok(/×12/.test(floodText), `相邻的 12 次导出要折成一条并记次数，实际「${floodText.slice(0, 80)}」`);
  // 中间夹了别的事就不合并（那是两段不同操作）
  const split = [
    { type: "export", format: "html" }, { type: "save", fields: ["summary"] },
    { type: "export", format: "html" },
  ];
  const splitText = texts(mod.Governance({ qa: QA, proposals: [], ledger: split })).join(" | ");
  assert.ok(!/×2/.test(splitText), "中间夹了别的事就不该合并");

  // 顺序：**最新在最上面**。文件是时间升序的，视图必须先倒过来再折叠，
  // 否则折的是旧记录、显示却是新记录，「×N」会挂在不相干的事上。
  const ordered = [
    { type: "create", note: "最早那件" },
    { type: "generate", slot: "sec-s1", vid: "v001" },
    { type: "feedback", verbatim: "最新那件" },
  ];
  const orderedText = texts(mod.Governance({ qa: QA, proposals: [], ledger: ordered })).join(" | ");
  const posCreate = orderedText.indexOf("新建文章");
  const posFeedback = orderedText.indexOf("最新那件");
  assert.ok(posFeedback >= 0 && posCreate >= 0, "两件都在");
  assert.ok(posFeedback < posCreate, `最新那条要排在前面（最新 ${posFeedback} / 最早 ${posCreate}）`);
}

// ── timeText：首页卡片的时间口径 ────────────────────────────────────────────
{
  const now = Date.now();
  assert.equal(mod.timeText(0), "", "0 回空串（不显示 1970）");
  assert.equal(mod.timeText(now - 1000), "刚刚", "1 秒前");
  assert.equal(mod.timeText(now - 5 * 60000), "5 分钟前");
  assert.equal(mod.timeText(now - 3 * 3600000), "3 小时前");
  assert.equal(mod.timeText(now - 86400000 * 1.5), "昨天");
  assert.equal(mod.timeText(now - 86400000 * 5), "5 天前");
  assert.match(mod.timeText(now - 86400000 * 60), /^\d{4}-\d{2}-\d{2}$/, "超过 30 天给具体日期");
  assert.equal(mod.timeText(now + 5000), "刚刚", "未来时间不出现负数文案");
}

// ── 流水线状态区块 ──────────────────────────────────────────────────────────
{
  // 未绑定：不假装有状态，只给绑定入口
  // 未绑定期号时**不再是空表单**：先给粗略进度，期号/根目录收进「接上产线」的进阶区。
  // 小白写一篇文章不该先被要求填绝对路径——这是调研里最硬的一条（新手 3 秒内要看到能点的按钮）。
  const unbound = mod.PipeBlock({
    pipeline: { bound: false }, busy: false, root: "D:/work/历史内容生产", onRefresh: () => {}, onBind: () => {},
    articleTitle: "一篇测试稿", hasBody: true, hasCover: false, imageGaps: 2, roughProgress: { exported: false },
  });
  const unboundText = texts(unbound).join(" | ");
  assert.ok(unboundText.includes("粗略估计"), "未绑定要标明是估的，不假装精确");
  assert.ok(unboundText.includes("有标题") && unboundText.includes("有正文"), "未绑定给五档粗略进度");
  assert.ok(/完成 2\/5 档/.test(unboundText), `算出完成了几档，实际「${(unboundText.match(/完成 \d+\/\d+ 档/) ?? [""])[0]}」`);
  assert.ok(unboundText.includes("接上产线"), "进阶入口在，但要点开才出现");
  assert.ok(!unboundText.includes("期号（如"), "期号输入默认收起，不挡路");
  assert.ok(!unboundText.includes("下一步"), "未绑定不能编出一个精确的下一步");

  // 点开进阶才出现期号与根目录
  const adv = mod.PipeBlock({
    pipeline: { bound: false }, busy: false, root: "", onRefresh: () => {}, onBind: () => {},
    articleTitle: "", hasBody: false, hasCover: false, imageGaps: 0, roughProgress: {},
  });
  assert.ok(texts(adv).join(" ").includes("接上产线"), "有进阶按钮");

  const BOUND = {
    bound: true, episodeId: "historical-person-026", episodeNo: 26,
    status: "needs-user-approval", step: "07-deai", skill: "wechat-07-deai",
    hint: "缺哈希匹配的制作确认，停在交稿，等人明确说「制作」。",
    blocking: { no: 7, label: "制作确认", detail: "绑的是 6f35a431，现稿 27bee65f" },
    drift: true, unknown: 1,
    gates: [
      { no: 1, key: "inventory", label: "人物清单", state: "ok", detail: "complete=true" },
      { no: 7, key: "production", label: "制作确认", state: "stale", detail: "绑的是 6f35a431" },
      { no: 6, key: "audit", label: "Chrome 终核", state: "unknown", detail: "未绑文章哈希" },
      { no: 1, key: "dup", label: "本线不适用", state: "skip", detail: "跳过" },
    ],
  };
  const boundTree = mod.PipeBlock({ pipeline: BOUND, busy: false, root: "", onRefresh: () => {}, onBind: () => {} });
  const boundText = texts(boundTree).join(" | ");
  assert.ok(boundText.includes("待你确认"), "状态词翻成人话（needs-user-approval → 待你确认）");
  // 下一步必须给，但**不能用步号**：`07-deai` 是路径不是进度，界面上不该出现
  assert.ok(boundText.includes("下一步：润色去 AI 味"), "下一步翻成人话");
  assert.ok(!/下一步：\d{2}-/.test(boundText), "下一步不能露出英文步号");
  assert.ok(!/07-deai/.test(boundText), "整块不能出现 skill 路径");
  assert.ok(boundText.includes("第 7 道门"), "指出卡在第几道门");
  assert.ok(boundText.includes("6f35a431"), "带上门禁的具体证据，不只说「不通过」");
  assert.ok(boundText.includes("判据不可用"), "判据不可用要显式说明项数");
  assert.ok(boundText.includes("面板里改过正文"), "drift 要提示，否则改了字还以为门是过的");

  // 状态词的原文必须在 title 里留一份：面板给人话，接口/排错要原词
  const withTitle = collect(boundTree, (n) => n.props?.title === "needs-user-approval");
  assert.equal(withTitle.length, 1, "状态词原文留在 title 里");

  // 证据默认收起：右栏本来就长，默认全展开会把报价挤下去
  assert.ok(!boundText.includes("Chrome 终核"), "门禁证据默认收起");

  // 全部状态词都能翻成人话，且配色档位只有三档
  for (const [word, meta] of Object.entries(mod.STATUS_TEXT)) {
    assert.ok(meta.text && meta.text.length <= 6, `状态词 ${word} 的人话不超过 6 个字`);
    assert.ok(["ok", "warn", "err"].includes(meta.level), `状态词 ${word} 的档位合法`);
  }
  assert.equal(Object.keys(mod.STATUS_TEXT).length, 9, "PIPELINE §4 是 9 个状态词，不能多也不能少");
  // 账本文案：绑定/解绑不能显示成「改稿 · pipeline:bound」这种黑话
  assert.equal(mod.ledgerText({ type: "save", fields: ["pipeline:bound"], episodeId: "historical-person-027" }), "绑定期号 historical-person-027", "绑定记成一句人话");
  assert.equal(mod.ledgerText({ type: "save", fields: ["pipeline:unbound"] }), "解绑期号", "解绑记成一句人话");
  assert.match(mod.ledgerText({ type: "save", fields: ["title"] }), /^改稿 · title/, "普通改稿口径不变");
  // 直接漏出来的英文事件名要能翻成中文，不然面板上会出现纯英文行
  assert.equal(mod.ledgerText({ type: "pipeline:bound", episodeId: "x" }), "绑定期号 x", "旧式事件也能翻");
  assert.equal(mod.ledgerText({ type: "什么鬼" }), "什么鬼", "未知事件原样显示（不吞掉，方便排查）");
  // 提案事件：不能漏出英文 proposal
  assert.equal(mod.ledgerText({ type: "proposal", decision: "proposed", summary: "改 3 段", count: 5 }), "提了改稿提案 · 改 3 段", "提案提出中文化");
  assert.equal(mod.ledgerText({ type: "proposal", decision: "confirmed", summary: "改 1 段" }), "确认改稿提案 · 改 1 段", "提案确认中文化");
  assert.equal(mod.ledgerText({ type: "proposal", decision: "rejected", summary: "改 2 段" }), "驳回改稿提案 · 改 2 段", "提案驳回中文化");
  // brief 口径更短：306px 的栏放不下长句
  assert.equal(mod.ledgerText({ type: "proposal", decision: "proposed", summary: "改 3 段 · 摘要", count: 5 }, { brief: true }),
    "提了提案 · 5 处", "动态栏用短口径");
}

// ── 首页卡片上的状态徽标 ────────────────────────────────────────────────────
{
  // 自己造样本，不去借上面某个块里的局部 LIST —— 块作用域拿不到，借了就是 ReferenceError。
  const card = {
    id: "gzh-20261026-abcd", title: "一家药企把审批从 14 天压到 3 天", subtitle: "两个坑",
    template: "business", sections: 2, images: 1, cover: "", updatedAt: Date.now(),
  };
  const list = [{ ...card, pipeline: { status: "needs-research", step: "02-evidence" } }];
  const home = mod.Home({ list, root: "", onOpen: () => {}, onCreate: () => {}, activity: [] });
  const badges = collect(home, (n) => cls(n).includes("gzs-card__badge"));
  assert.equal(badges.length, 1, "有状态的卡片带一个徽标");
  assert.equal(texts(badges[0]).join(""), "缺证据台账", "徽标是人话");
  assert.ok(cls(badges[0]).includes("gzs-card__badge--err"), "缺台账是重档颜色");

  const plain = mod.Home({ list: [{ ...card, pipeline: null }], root: "", onOpen: () => {}, onCreate: () => {}, activity: [] });
  assert.equal(collect(plain, (n) => cls(n).includes("gzs-card__badge")).length, 0, "未绑定不画徽标");

  // 徽标是 absolute 定位，父容器必须 relative —— 否则它会跑到视口左上角、
  // 被侧栏盖住，而 querySelector 照样找得到。这类「在 DOM 里但看不见」的错
  // 只查存在性永远发现不了，所以同时断言 CSS 里那句定位在。
  assert.match(mod.CSS, /\.gzs-card__thumb\{[^}]*position:relative/, "封面容器必须有 position:relative（徽标的定位基准）");
  assert.match(mod.CSS, /\.gzs-card__badge\{[^}]*position:absolute/, "徽标用 absolute 压在封面上");
  assert.match(mod.CSS, /\.gzs-card\{[^}]*overflow:hidden/, "卡片裁掉溢出，徽标不能露到外面");
}

// ── 节点条 / 事实核对 / 时间线 ──────────────────────────────────────────────
{
  const NODES = [
    { id: "01", label: "立项", state: "done" },
    { id: "02", label: "证据台账", state: "done" },
    { id: "04", label: "初稿", state: "panel", panel: "draft" },
    { id: "07", label: "去 AI 味", state: "skip", note: "本仓无机器判据，须看审稿包" },
    { id: "09", label: "排版", state: "todo", note: "没有排版 HTML" },
  ];
  // 有正文 → 初稿算完成；无正文 → 算没做。这条判据在面板侧，服务端不查盘
  const withBody = texts(mod.NodeBar({ nodes: NODES, hasBody: true })).join(" | ");
  const noBody = texts(mod.NodeBar({ nodes: NODES, hasBody: false })).join(" | ");
  assert.ok(withBody.includes("立项"), "节点条列出步骤");
  const progress = (text) => (text.match(/\d+\/\d+ 步有据可查/) ?? [""])[0];
  assert.ok(withBody.includes("3/5 步有据可查"), `有正文时初稿算完成，实际「${progress(withBody)}」`);
  assert.ok(noBody.includes("2/5 步有据可查"), "无正文时初稿不算完成");
  // 「无机器判据」必须显式列出来，不能默默当成做完
  assert.ok(withBody.includes("无机器判据的节点：去 AI 味"), "跳过的节点要列名");
  // 每个节点都带 title，能查到具体原因
  // 精确匹配 `gzs-node ` 开头的类名：`includes` 会把 `gzs-nodes`、`gzs-node__mark` 一起吞进来
  const nodeEls = collect(mod.NodeBar({ nodes: NODES, hasBody: true }),
    (n) => /(^|\s)gzs-node(\s|$)/.test(cls(n)));
  assert.equal(nodeEls.length, 5, "五个节点各一个 chip");
  assert.ok(nodeEls.every((n) => (n.props?.title ?? "").length > 4), "每个 chip 都有 title 说明");
  assert.ok(nodeEls[3].props.title.includes("无机器判据"), "跳过节点的 title 说明为什么");

  // 事实核对：缺失项要显示「无」，不能空白
  const facts = mod.Facts({ rows: [
    { key: "research", label: "研究", state: "ok", detail: "50 条" },
    { key: "evidence", label: "证据", state: "none", detail: "无" },
    { key: "audit", label: "核验", state: "unknown", detail: "有收据但未绑文章哈希" },
  ] });
  const factTexts = texts(facts).join(" | ");
  assert.ok(factTexts.includes("研究") && factTexts.includes("有"), "有据可查的显示「有」");
  assert.ok(factTexts.includes("无"), "缺失的显示「无」，不是空白");
  assert.ok(factTexts.includes("查不出"), "判据不可用显示「查不出」，不说成「无」");

  // 时间线：空的时候给话，不画一个空框
  assert.ok(texts(mod.Timeline({ rows: [] })).join("").includes("还没有可读的文件改动记录"), "空时间线有话");
  const tl = texts(mod.Timeline({ rows: [{ at: Date.now() - 60000, label: "正文更新", note: "10-公众号-文案.md" }] })).join(" | ");
  assert.ok(tl.includes("正文更新") && tl.includes("10-公众号-文案.md"), "时间线行有标签与文件名");
  // 时间线必须给**绝对时刻**，不能给「4 天前」：同一天里 8 个文件改动都显示「4 天前」，
  // 看不出谁先谁后，而时间线存在的意义就是看顺序。
  const stamp = mod.stampText(Date.now() - 86400000 * 4);
  assert.match(stamp, /^\d{2}-\d{2} \d{2}:\d{2}$/, `时间线用 月-日 时:分，实际「${stamp}」`);
  const tlText = texts(mod.Timeline({ rows: [{ at: Date.now() - 86400000 * 4, label: "正文更新", note: "x.md" }] })).join(" | ");
  assert.ok(!/天前/.test(tlText), "时间线不出现「N 天前」（那种粒度排不出顺序）");
}

// ── 提案性质在面板上的呈现（分类本身在 qa-unit 测）─────────────────────────
{
  const route = { label: "改结构", step: "04-write", skill: "wechat-04-write",
    rule: "动了段落增删或整段重写：退第 4 步重写，之后编辑审与读者审要重跑。" };
  const prop = {
    pid: "p-11112222", status: "waiting-user", createdAt: Date.now() - 60000,
    summary: "改 3 段 · 摘要", count: 5, note: "补出处", stale: false,
    kind: "structure", alsoTouches: ["摘要"], route,
  };
  const text = texts(mod.Governance({ qa: null, proposals: [prop], ledger: [] })).join(" | ");
  assert.ok(text.includes("改结构"), "提案卡显示性质");
  assert.ok(text.includes("退到「写正文」"), "提案卡显示退到哪一步（用人话）");
  assert.ok(!/退 0\d-/.test(text), "提案卡不露步号");
  assert.ok(text.includes("还捎带摘要"), "提案卡提示捎带动了什么");
  assert.ok(text.includes("编辑审与读者审要重跑"), "提案卡写出这一步的红线");
  // 老提案没有 kind：不显示标签，也不能崩
  const old = { pid: "p-33334444", status: "waiting-user", createdAt: Date.now(), summary: "改 1 段", count: 1, stale: false };
  assert.doesNotThrow(() => mod.Governance({ qa: null, proposals: [old], ledger: [] }), "老提案没有性质也不崩");
  assert.ok(!texts(mod.Governance({ qa: null, proposals: [old], ledger: [] })).join("").includes("退 0"),
    "没有性质就不编一个步号出来");
}

// ── 界面不许露英文枚举（回归防线）─────────────────────────────────────────
{
  // 这条不是测某个组件，是测**整个渲染面**：把所有主要组件都渲染一遍，
  // 扫它们的可见文字里有没有英文枚举。之前 `07-deai`、`needs-user-approval`、
  // `proposal` 都是这样漏出去的——每修一处就冒一处，靠人眼盯不住。
  const FORBIDDEN = [
    /\b\d{2}-[a-z][a-z-]+\b/,            // 07-deai / 04-write 这类步号
    /\bneeds-[a-z-]+\b/,                  // PIPELINE 状态词
    /\b(polish|structure|draftbox|dry-run)\b/, // 内部枚举
    /\bproposal\b/,                      // 账本事件名
    /\bpipeline:(bound|unbound)\b/,       // 账本事件名
  ];
  const surfaces = {
    首页: mod.Home({ list: [{ id: "gzh-a", title: "T", template: "business", sections: 1, images: 0, cover: "", updatedAt: Date.now(),
      lifecycle: { value: "draft", source: "default" }, words: 10, empty: false }],
      root: "", onOpen: () => {}, onCreate: () => {}, activity: [], counts: { total: 1, byState: { draft: 1, draftbox: 0, published: 0 }, empty: 0, unbound: 1, active: 1 }, filters: { state: "all", q: "" }, matched: 1 }),
    流水线: mod.PipeBlock({ pipeline: { bound: true, episodeId: "ep-1", episodeNo: 1, status: "needs-user-approval",
      step: "07-deai", hint: "停在交稿", gates: [{ no: 7, key: "p", label: "制作确认", state: "stale", detail: "哈希过期" }],
      nodes: [{ id: "07", label: "去 AI 味", state: "skip" }], facts: [], timeline: [], unknown: 0 },
      busy: false, root: "", hasBody: true, onRefresh: () => {}, onBind: () => {} }),
    治理: mod.Governance({ qa: QA, proposals: [{ pid: "p-11112222", status: "waiting-user", createdAt: Date.now(),
      summary: "改 1 段", count: 1, stale: false, kind: "structure", alsoTouches: [],
      route: { label: "改结构", step: "04-write", skill: "wechat-04-write", rule: "退第 4 步重写" } }],
      ledger: [{ type: "save", fields: ["pipeline:bound"], episodeId: "ep-1" }] }),
  };
  for (const [name, tree] of Object.entries(surfaces)) {
    const text = texts(tree).join(" ");
    for (const re of FORBIDDEN) {
      assert.ok(!re.test(text), `${name} 面露出英文枚举 ${re}：${(text.match(re) ?? [""])[0]}`);
    }
  }
}

// ── 左栏：本期步骤（inferSteps 的两个来源）──────────────────────────────────
{
  // ① 绑了期号：一道门一行，照抄门禁结论，前端不自己再判一遍
  const bound = mod.inferSteps({
    article: ARTICLE,
    pipeline: {
      bound: true, episodeId: "historical-person-027", status: "needs-user-approval",
      gates: [
        { no: 1, key: "inventory", label: "人物清单", state: "skip", detail: "本线不适用" },
        { no: 3, key: "evidence", label: "证据台账", state: "ok", detail: "12 条全部逐字核过" },
        { no: 6, key: "audit", label: "Chrome 终核", state: "fail", detail: "无核验收据" },
        { no: 8, key: "layout", label: "排版已体检", state: "stale", detail: "留痕绑的是旧文件" },
        { no: 9, key: "quality-gate", label: "排版校验留痕", state: "unknown", detail: "读不到" },
      ],
    },
  });
  assert.equal(bound.bound, true, "绑了期号就走门禁");
  assert.equal(bound.source, "gates", "来源标成 gates");
  assert.equal(bound.rows.length, 5, "一道门一行");
  assert.deepEqual(bound.rows.map((r) => r.no), [1, 3, 6, 8, 9], "步号照搬门号");
  assert.deepEqual(bound.rows.map((r) => r.state), ["todo", "ok", "miss", "miss", "doing"], "门状态 → 四态");
  assert.equal(bound.done, 1, "只数真过了的");
  assert.ok(bound.rows[3].verdict.includes("过期"), "stale 说「过期」，不并进「缺件」");

  // ② 没绑期号：11 条（0–10）全列出来，状态四选一，右边必须有一句结论
  const loose = mod.inferSteps({
    article: ARTICLE, pipeline: { bound: false, reason: "这篇还没有绑定期号", gates: [] },
    qa: QA, ledger: LEDGER, proposals: [], reviews: { done: 0, total: 16 },
  });
  assert.equal(loose.bound, false, "没绑就是没绑");
  assert.equal(loose.source, "inferred", "来源标成 inferred");
  assert.equal(loose.rows.length, 11, "第 0–10 步全列出来（空步骤条会被当成做坏了）");
  assert.deepEqual(loose.rows.map((r) => r.no), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "步号连着");
  const STEPS_ALLOWED = new Set(["ok", "doing", "todo", "miss"]);
  assert.ok(loose.rows.every((r) => STEPS_ALLOWED.has(r.state)), "状态只在四态里");
  assert.ok(loose.rows.every((r) => String(r.verdict ?? "").length > 0), "每行右边都有一句结论");
  const byNo = Object.fromEntries(loose.rows.map((r) => [r.no, r]));
  assert.equal(byNo[0].state, "ok", "有稿件记录就算开了工");
  assert.equal(byNo[1].state, "miss", "没填受众/带走什么 → 缺件");
  assert.equal(byNo[4].state, "doing", "正文齐但双审没勾 → 进行中（不冒充完成）");
  assert.equal(byNo[5].state, "todo", "没有正文诊断 → 未开始");
  assert.equal(byNo[6].verdict, "进行中", "配图没配满 → 进行中（结论列只能放四类词）");
  assert.equal(byNo[6].note, "1/2", "证据「有图的节/总节」挪到 note，不混进结论列");
  assert.equal(byNo[7].state, "todo", "没导出过 → 未开始");
  assert.equal(byNo[8].verdict, "未开始", "排版校验没留痕就说未开始");
  assert.equal(byNo[10].verdict, "未开始", "最后一步没证据就是未开始");
  assert.equal(byNo[10].note, "发布后", "「发布后」是时机不是结论，放 note");
  // 结论列的词表必须收敛：混着「3/6 节」「1 份提案」「导出过」就是一列乱码
  const VERDICT_ALLOWED = new Set(["完成", "进行中", "缺件", "未开始", "过期"]);
  assert.ok(loose.rows.every((r) => VERDICT_ALLOWED.has(r.verdict)),
    `结论列只能是四类词（+过期的门禁结论）：${loose.rows.map((r) => r.verdict).join("/")}`);
  // 导出过就该亮：判据是账本里的 export 事件
  const exported = mod.inferSteps({ article: ARTICLE, pipeline: { bound: false, gates: [] }, ledger: LEDGER.concat([{ type: "export", format: "html", ts: Date.now() }]) });
  assert.equal(exported.rows[7].state, "ok", "导出过 → 排版算完成");
  // 空载荷也不能炸，也不能编数据
  assert.equal(mod.inferSteps(null).rows.length, 11, "空载荷也返回 11 条");
  assert.equal(mod.inferSteps(null).done, 0, "空载荷一条都没过");
  assert.equal(mod.inferSteps(undefined).rows.every((r) => r.state === "todo"), true, "什么都没有就全是未开始");
}

// ── 三栏新形态：左栏步骤条 / 中栏舞台 / 检查器 tab ──────────────────────────
{
  const view = {
    article: ARTICLE, qa: QA, ledger: LEDGER, proposals: [],
    pipeline: { bound: false, reason: "这篇还没有绑定期号", gates: [] },
    reviews: { done: 0, total: 16 }, deai: null, feedback: null,
  };

  // 左栏：未绑期号 → 11 步 + 如实标注 + 绑定入口；结构列表收在底部但还在
  const rail = mod.StepRail({
    view, article: ARTICLE, selected: "sec-s1",
    onSelect: () => {}, onAddSection: () => {}, onBind: () => {}, busy: false, root: "",
  });
  const railText = texts(rail).join(" | ");
  const stepRows = collect(rail, (n) => /(^| )gzs-stepline( |$)/.test(cls(n)));
  assert.equal(stepRows.length, 11, "未绑期号也列满 11 步");
  assert.ok(railText.includes("按稿件推断 · 未绑定期号"), "如实标注「按稿件推断 · 未绑定期号」");
  assert.ok(railText.includes("接上产线"), "给绑定入口");
  assert.ok(railText.includes("结构"), "结构小节还在");
  assert.equal(collect(rail, (n) => /(^| )gzs-item( |$)/.test(cls(n))).length, 3, "结构列表收在底部，照样 3 行");
  // 三重编码：每一行都同时有「点 + 文字」，不能只靠颜色
  assert.equal(collect(rail, (n) => /(^| )gzs-stepdot( |$)/.test(cls(n))).length, 11, "每行一个状态点");
  assert.equal(collect(rail, (n) => /(^| )gzs-steptag( |$)/.test(cls(n))).length, 11, "每行一句结论文字");
  // 点有落点的那一步 → 切到对应槽位（点节仍然要到得了正文那一节）
  let picked = "";
  const clickable = mod.StepRail({ view, article: ARTICLE, selected: "article", onSelect: (s) => { picked = s; } });
  const hit = collect(clickable, (n) => /(^| )gzs-stepline( |$)/.test(cls(n))).find((n) => typeof n.props.onClick === "function");
  assert.ok(hit, "有落点的步骤可点");
  hit.props.onClick();
  assert.ok(picked, `点步骤会切槽位，实际「${picked}」`);
  // 绑定态：显示门名，且不再标「推断」
  const boundRail = mod.StepRail({
    view: { ...view, pipeline: { bound: true, episodeId: "ep-27", episodeNo: 27, blocking: null, gates: [{ no: 3, key: "evidence", label: "证据台账", state: "ok", detail: "12 条" }] } },
    article: ARTICLE, selected: "article",
  });
  const boundText = texts(boundRail).join(" ");
  assert.ok(boundText.includes("证据台账"), "绑定期号显示门禁的门名");
  assert.ok(!boundText.includes("按稿件推断"), "绑定期号就不再标「推断」");
  assert.ok(boundText.includes("ep-27"), "栏头写明是哪一期");

  // 中栏：默认停在「成稿」，宽正文里标题/节标题/正文/内联图都在
  const stage = mod.Stage({ article: ARTICLE, templates: TEMPLATES, selected: "sec-s1", onSelect: () => {}, onExport: () => {} });
  const stageText = texts(stage).join(" | ");
  assert.ok(stageText.includes("一家药企把审批"), "成稿有标题");
  assert.ok(stageText.includes("坑一：以为流程是画出来的"), "成稿有节标题");
  assert.ok(stageText.includes("流程不是画出来的"), "成稿有正文");
  // 2026-11-02 用户指令：中栏只留「成稿 / 手机预览」，排版视图去掉（导出入口进了手机预览上方工具条）
  ["成稿", "手机预览"].forEach((label) => assert.ok(stageText.includes(label), `视图切换里有「${label}」`));
  assert.ok(!stageText.includes("排版件"), "不再有「排版件」这个视图");
  assert.equal(collect(stage, (n) => cls(n).includes("gzs-doch")).length, 2, "两个节标题");
  const stageImgs = collect(stage, (n) => n.type === "img");
  assert.equal(stageImgs.length, 2, "封面 + 第一段图按节内联");
  assert.ok(stageImgs[0].props.src.includes("slot=cover"), "封面图走宿主 image 路由");
  assert.ok(stageImgs[1].props.src.includes("slot=sec-s1&v=v001"), "段落图带当前版本");
  assert.equal(collect(stage, (n) => /(^| )gzs-phone( |$)/.test(cls(n))).length, 0, "默认是成稿，不是手机预览");
  const metaText = collect(stage, (n) => /(^| )gzs-meta( |$)/.test(cls(n))).map((n) => texts(n).join(" ")).join(" ");
  ["字", "节", "图", "模板", "受众", "更新"].forEach((k) => assert.ok(metaText.includes(k), `元信息行里有「${k}」`));
  // 排版视图：导出入口 + 口径说明
  // 2026-11-02：排版视图去掉，导出入口挪进手机预览上方的工具条
  const bar = mod.ExportBar({ article: ARTICLE, onExport: () => {} });
  const barText = texts(bar).join(" ");
  assert.ok(barText.includes("导出 HTML"), "导出工具条给「导出 HTML」");
  assert.ok(barText.includes("Markdown") && barText.includes("图片清单"), "三条导出入口都在");
  assert.equal(texts(mod.ExportBar({ article: null })).length, 0, "空载荷不渲染");
  assert.ok(texts(mod.Manuscript({ article: null })).join("").includes("还没有选中文章"), "空载荷不崩");

  // 推草稿对话框：没配公众号时它必须是「配置向导」，不能只写一句「未配置」
  const pushDlg = mod.PushDialog({ id: "gzh-20261104-0001", onClose: () => {}, onDone: () => {} });
  const pushText = texts(pushDlg).join(" ");
  assert.ok(pushText.includes("推草稿"), "对话框标题");
  assert.ok(pushText.includes("AppID") && pushText.includes("AppSecret"), "配置向导要给 AppID / AppSecret 两个入口");
  assert.ok(pushText.includes("IP 白名单"), "40164 的下一步要直接写在界面上");
  assert.ok(pushText.includes("草稿") && pushText.includes("不是「发布」"), "不许把推草稿说成发布");
  assert.doesNotThrow(() => mod.PushDialog({}), "缺 props 不崩");

  // 「上次推过」提示：推草稿是新建不是覆盖，连点两次会有两条草稿
  const notice = mod.LastPublishNotice({ lastPublish: { ts: Date.now() - 120000, mediaId: "DRAFT-1" } });
  const noticeText = texts(notice).join(" ");
  assert.ok(noticeText.includes("上次推过") && noticeText.includes("DRAFT-1"), "要给出上一次回执");
  assert.ok(noticeText.includes("不会覆盖"), "要说清再推会多一条");
  assert.equal(mod.LastPublishNotice({ lastPublish: null }), null, "没推过就什么都不显示");

  // 首启向导：空库时给的是「三步怎么开始」，不是库存 0 篇
  const firstRun = mod.FirstRun({ onCreate: () => {}, onConfigureNodes: () => {}, onConfigureWechat: () => {} });
  const firstText = texts(firstRun).join(" ");
  assert.ok(firstText.includes("三步开始"), "首启要有明确的三步");
  assert.ok(firstText.includes("可跳过") && firstText.includes("可选"), "第 2、3 步要写明可跳过（否则像强制配置）");
  assert.ok(firstText.includes("AppID"), "公众号那步要提到 AppID");
  assert.doesNotThrow(() => mod.FirstRun({}), "首启缺 props 不崩");

  // 出图节点配置：key 只填环境变量名，界面上不许出现密钥输入
  const nodeDlg = mod.NodeDialog({ onClose: () => {}, onSaved: () => {} });
  const nodeText = texts(nodeDlg).join(" ");
  assert.ok(nodeText.includes("环境变量名"), "节点配置只收环境变量名");
  assert.ok(nodeText.includes("64 的倍数"), "把尺寸坑写在配置界面上");
  assert.ok(!/secret|密码/i.test(nodeText), "不许在节点配置里收密钥");
  assert.doesNotThrow(() => mod.NodeDialog({}), "节点配置缺 props 不崩");

  // 公众号配置提交体：**留空 = 不改**。
  // 踩过的坑：点「改配置」后表单是空的，直接保存会把已存好的 AppID / Secret 抹成空串。
  const blankPayload = mod.wechatConfigPayload({ appId: "", appSecret: "", author: "", mode: "direct" });
  assert.equal("appId" in blankPayload, false, "空 AppID 不能提交（会抹掉已存值）");
  assert.equal("appSecret" in blankPayload, false, "空 Secret 不能提交");
  assert.equal("gateway" in blankPayload, false, "直连模式不该带网关字段");
  const editPayload = mod.wechatConfigPayload({
    appId: "wx1234567890abcdef", appSecret: "s3cret", author: "作者",
    mode: "gateway", gatewayURL: "https://gw.example", gatewayToken: "tk",
  });
  assert.equal(editPayload.appId, "wx1234567890abcdef", "填了就要提交");
  assert.equal(editPayload.mode, "gateway", "模式跟着提交");
  assert.equal(editPayload.gateway.baseURL, "https://gw.example", "网关模式要带地址");

  // 右栏：四个 tab 都在，默认「意见」，同一时刻只亮一个面板
  const insp = mod.Inspector({
    ...props("article"),
    pipeline: { bound: false, gates: [] },
    pipeBlock: { pipeline: null, busy: false, root: "" },
  });
  const tabLabels = collect(insp, (n) => /(^| )gzs-itab( |$)/.test(cls(n))).map((n) => texts(n).join(""));
  assert.deepEqual(tabLabels, ["证据", "图", "元信息"], `三个 tab（意见栏已去掉），实际 ${JSON.stringify(tabLabels)}`);
  assert.equal(collect(insp, (n) => /(^| )gzs-itab( |$)/.test(cls(n)) && cls(n).includes("gzs-itab--on")).length, 1, "只有一个 tab 是亮的");
  assert.equal(texts(collect(insp, (n) => cls(n).includes("gzs-itab--on"))[0]).join(""), "证据", "默认停在「证据」");
  assert.equal(collect(insp, (n) => cls(n).includes("gzs-itabpanel")).length, 3, "三个面板都渲染，靠 hidden 切换");
  assert.equal(collect(insp, (n) => cls(n).includes("gzs-itabpanel") && n.props.hidden !== true).length, 1, "同一时刻只亮一个面板");
  // 受控 tab：切到「证据」能看到十道门的真结论
  const evidenceTab = mod.Inspector({
    ...props("article"), tab: "evidence",
    pipeline: { bound: true, gates: [{ no: 3, key: "evidence", label: "证据台账", state: "ok", detail: "12 条逐字核过" }] },
    pipeBlock: { pipeline: { bound: false, gates: [] }, busy: false, root: "" },
  });
  assert.ok(texts(evidenceTab).join(" ").includes("12 条逐字核过"), "「证据」tab 里能看到十道门结论");
  assert.equal(texts(collect(evidenceTab, (n) => cls(n).includes("gzs-itab--on"))[0]).join(""), "证据", "受控 tab 生效");
  // 「图」tab：一篇里所有槽位的缩略图，点一张切过去
  const board = mod.ImageBoard({ article: ARTICLE, onSelect: () => {} });
  assert.equal(collect(board, (n) => n.type === "img").length, 2, "封面 + 一段有图");
  assert.ok(texts(board).join(" ").includes("缺图"), "没图的槽位标「缺图」");
  assert.doesNotThrow(() => mod.GateList({ gates: [{ no: 1, label: "人物清单", state: "skip", detail: "不适用" }] }), "门列表能渲染");
  assert.doesNotThrow(() => mod.GateList({}), "没有门也不崩");

  // 「意见」栏已从右栏去掉：右栏只做看板，讨论与引用都在左侧 DSH 原生对话。
  assert.equal(collect(insp, (n) => cls(n).includes("gzs-compose")).length, 0, "右栏不再有意见/反馈卡");
  assert.ok(!texts(insp).join(" ").includes("自然语言讨论请在左侧"), "右栏不再提示「去左边聊」——那栏已经没了");
  // 组件本身还在（只是不再挂到右栏），单独测它的文案与行为，别让这段能力悄悄坏掉。
  const composer = mod.OpinionComposer({ scope: "article", scopeLabel: "整篇", articleTitle: "T", onSubmit: () => {} });
  const composeText = texts(composer).join(" ");
  assert.ok(composeText.includes("当前定位"), "composer 标出当前定位");
  assert.ok(composeText.includes("不会发送到聊天"), "后续反馈明确不是聊天消息");
  const copyBtn = collect(composer, (n) => n.type === "button" && texts(n).join("") === "引用此处到左侧对话")[0];
  assert.ok(copyBtn, "主按钮是「引用此处到左侧对话」");
  const noteBtn = collect(composer, (n) => n.type === "button" && texts(n).join("") === "保存为后续反馈")[0];
  assert.ok(noteBtn, "副按钮是「保存为后续反馈」");
  let sent = null;
  assert.doesNotThrow(() => mod.OpinionComposer({ scope: "article", scopeLabel: "整篇", articleTitle: "T", onSubmit: (x) => { sent = x; } }), "composer 能单独渲染");
  assert.equal(sent, null, "没输入就不提交");

  // 往期（仓库真源）：加载态也要有标题和「只读」标识，不能空白一片
  const repoTree = mod.RepoSection();
  assert.ok(texts(repoTree).join(" ").includes("往期"), "往期区块有标题");
  assert.ok(texts(repoTree).join(" ").includes("只读"), "往期标明只读");
  assert.doesNotThrow(() => mod.RepoPreview({ dir: "fde-practice/x", onClose: () => {} }), "预览能渲染（加载态不崩）");
}

// ── 视频号看板：8 步合同必须和宿主对齐 ──────────────────────────────────────
{
  // 6 个方块是面板画的，8 步是宿主数的；两边对不上就会出现
  // 「进度说 3/8，方块只亮 2 个」这种自相矛盾的画面。
  const host = await import(new URL("../lib/video.js", import.meta.url).href);
  const hostKeys = host.EPISODE_STEPS.map((step) => step.key);
  const mine = mod.VIDEO_STEPS.map((step) => step.key);
  assert.deepEqual(mine, hostKeys, `8 个方块要和宿主步骤表一一对应，实际 ${mine.join("/")}`);
  assert.equal(mine.length, 8, "8 步全画（分段、成片也算，不能出现「1/8 但方块全空」）");
  // 列表面必须把 8 个键都给出来，否则方块画不出来
  const probeFiles = host.probeEpisode([]);
  for (const key of hostKeys) {
    assert.ok(Object.prototype.hasOwnProperty.call(probeFiles, key), `probeEpisode 要给出 ${key}`);
  }
  // 颜色语义要一致：有料实心、缺件空心（FDE-01 现在只有分段索引，所以只有「分段」该亮）
  assert.ok(host.progressOf({}).startsWith("未开始"), "一个件都没有 → 未开始");

  const board = mod.VideoBoard();
  assert.ok(texts(board).join(" ").includes("视频号"), "看板有标题");
  // 生成动作不在面板里做：这句话要出现在看板上，不然人会等它自己出片
  assert.ok(texts(board).join(" ").includes("聊天窗口"), "写明「生成动作在聊天窗口」");
  assert.doesNotThrow(() => mod.VideoEpisode({ id: "FDE-01", onClose: () => {} }), "单期详情加载态不崩");
  const ep = mod.VideoEpisode({ id: "FDE-01", onClose: () => {} });
  assert.ok(cls(ep).includes("gzs-vdetail"), "详情挂在自己的容器里");

  // 成片页：有片就出 <video>（走 Range 媒体路由）+ 发布包；没片要说清「还没有成片」
  const player = mod.EpisodePlayer({
    id: "FDE-01",
    data: {
      title: "45 秒讲清",
      dirPath: "D:/repo/07-video/episode/FDE-01",
      media: { final: [{ rel: "final/成片.mp4", name: "成片.mp4", bytes: 2 * 1024 * 1024 }], cover: [], storyboard: [] },
      subtitles: [{ start: "00:00:01.000", end: "00:00:02.000", text: "第一句" }],
    },
  });
  const videoEls = collect(player, (n) => n.type === "video");
  assert.equal(videoEls.length, 1, "有片就要有 <video>");
  assert.ok(String(videoEls[0].props?.src ?? "").includes("/api/gzh-studio.media"), "视频走媒体路由（带 Range）");
  const playerText = texts(player).join(" ");
  assert.ok(playerText.includes("发布包") && playerText.includes("复制发布文案"), "发布包要能给文案");
  assert.ok(playerText.includes("2.0 MB"), "成片大小要标出来");
  const noFinal = mod.EpisodePlayer({ id: "FDE-02", data: { media: { final: [] } } });
  assert.ok(texts(noFinal).join(" ").includes("还没有成片"), "缺片要说清楚，不能空白");

  // 口播稿是 markdown：标题要变标题，`**` 不能漏到屏幕上
  const blocks = mod.markdownBlocks("# 开场\n\n**一句话**说完。\n\n- 第一条\n- 第二条");
  assert.deepEqual(blocks.map((b) => b.kind), ["h", "p", "p"], "标题 + 两段");
  assert.equal(blocks[0].text, "开场", "标题去掉 #");
  assert.ok(!blocks[1].text.includes("**"), "加粗标记不漏到屏幕");
  assert.ok(blocks[2].text.includes("· 第一条"), "列表项转成可读的圆点");
  assert.deepEqual(mod.markdownBlocks(""), [], "空稿不产生空块");
}

// ── 面板不自己发消息：只把带定位的话递进原生输入框，发送由人按下 ──────────────
{
  // 对话在本面板里之后，「递话」不再走 postMessage：等输入框出现 → 填 → 复核。
  // 这里用一个登录式的定时器桩，把「等」和「超时」两条路都走一遍。
  const hadWindow = "window" in globalThis; const hadDocument = "document" in globalThis;
  const intervals = [];
  const timeouts = [];
  globalThis.window = {
    location: { origin: "http://127.0.0.1:3080" },
    setTimeout: (fn) => { timeouts.push(fn); return timeouts.length; },
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearTimeout: () => {},
    clearInterval: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  try {
    const blank = await mod.bringToChat("   ");
    assert.equal(blank.ok, false, "空内容不送");

    // 1) 输入框一直不出现：8 秒后必须给结论，且原因点明是「等输入框」
    globalThis.document = { querySelector: () => null };
    const pending = mod.bringToChat("【新媒体工作台】某文 · sec-s2\n结论太硬");
    assert.equal(mod.chatOpenStore.value, true, "要送话时先把对话列展开，否则没有输入框可填");
    const timedOut = await (async () => {
      timeouts[timeouts.length - 1]();
      return pending;
    })();
    assert.equal(timedOut.ok, false, "没有输入框就明说没送到");
    assert.ok(String(timedOut.reason).includes("8 秒"), `原因要具体：${timedOut.reason}`);
    assert.ok(String(timedOut.reason).includes("输入框"), `要指出卡在输入框：${timedOut.reason}`);

    // 2) 输入框迟一步出现（左栏刚展开 / 会话正在开会）：重试那一轮要填进去
    let host = null;
    globalThis.document = {
      querySelector: (selector) => (selector === ".gzs-chatcol" ? null : host),
      execCommand: (name, _ui, text) => { if (name !== "insertText" || !host) return false; host.textContent += text; return true; },
    };
    intervals.length = 0;
    const late = mod.bringToChat("【新媒体工作台】某文 · sec-s3\n换成一句话故事");
    host = { textContent: "", focus() {}, dispatchEvent() { return true; } };
    intervals[0](); // 模拟 500ms 后的重试
    const landed = await late;
    assert.equal(landed.ok, true, "输入框出现后要真填进去");
    assert.equal(landed.via, "execCommand");
    assert.ok(host.textContent.includes("sec-s3"), "填的是原来那句话，不能丢定位");
  } finally {
    if (!hadWindow) delete globalThis.window;
    if (!hadDocument) delete globalThis.document;
  }
}

// ── 填字通道：把话填进 Lexical 输入框，三种写法都不成要如实回报 ────────────────
{
  const makeHost = () => {
    const host = { textContent: "", focused: false, focus() { this.focused = true; }, dispatchEvent() { return true; } };
    return host;
  };
  const hadDocument = "document" in globalThis;
  try {
    // 1) execCommand 成功
    const host = makeHost();
    globalThis.document = {
      querySelector: () => host,
      execCommand: (name, _ui, text) => { if (name !== "insertText") return false; host.textContent += text; return true; },
      createElement: () => ({}),
    };
    assert.ok(mod.findComposer() === host, "找得到 composer（Lexical 的 contenteditable 根）");
    const good = mod.insertIntoComposer("【新媒体工作台】x · sec-s1\n结论太硬");
    assert.equal(good.ok, true, "execCommand 能落进去");
    assert.equal(good.via, "execCommand");
    assert.equal(host.focused, true, "填之前先给输入框焦点，光标要在那儿");

    // 1b) 页面上有两个输入框时，认左栏那个（对话列里的）
    // 以前对话在 iframe 里，查全局 document 没问题；现在对话就在本面板，
    // 宿主的输入框、侧栏的输入框都可能在 DOM 上，抢错一个等于把话填进了别人的框。
    const inCol = makeHost();
    const elsewhere = makeHost();
    globalThis.document = {
      querySelector: (selector) => {
        if (selector === ".gzs-chatcol") return { querySelector: () => inCol };
        return elsewhere;
      },
      execCommand: (name, _ui, text) => { if (name !== "insertText") return false; inCol.textContent += text; return true; },
      createElement: () => ({}),
    };
    assert.ok(mod.findComposer() === inCol, "优先取左栏对话列里的输入框");
    assert.equal(mod.insertIntoComposer("只填左栏").ok, true, "填进左栏那个");
    assert.equal(elsewhere.textContent, "", "不许写到别处的输入框");

    // 2) 三种写法都不成 → 不许报成功
    const deadHost = makeHost();
    globalThis.document = {
      querySelector: () => deadHost,
      execCommand: () => false,
      createElement: () => ({}),
    };
    const bad = mod.insertIntoComposer("在吗");
    assert.equal(bad.ok, false, "落不进去就说落不进去");
    assert.ok(bad.reason.length > 0, "要给原因");

    // 3) 连输入框都没有（会话还没开完）
    globalThis.document = { querySelector: () => null, createElement: () => ({}) };
    const none = mod.insertIntoComposer("在吗");
    assert.equal(none.ok, false);
    assert.ok(none.reason.includes("输入框"), `原因要点明是输入框：${none.reason}`);

    // 4) 空白不填
    assert.equal(mod.insertIntoComposer("   ").ok, false, "空白不往输入框里塞");
  } finally {
    if (!hadDocument) delete globalThis.document;
  }
}

// ── 左栏原生对话：面板自己 retain 一条会话，交给宿主渲染 ──────────────────────
{
  assert.equal(mod.CHAT_SLOT, "gzh-studio.chat", "对话位槽名固定");
  assert.match(mod.CHAT_KEY, /^gzh-studio\.chat\.session\./, "绑定键带版本，换口径时才敢加 v2");
  assert.equal(mod.CHAT_SOURCE, "gzhStudio", "retain 来源标签固定（宿主按它算引用计数）");

  mod.chatOpenStore.set(true);
  const openTree = mod.Workspace({});
  assert.ok(cls(openTree).includes("gzs-root--split"), "开着对话列时根容器是左右分栏");
  const col = collect(openTree, (n) => cls(n).includes("gzs-chatcol"))[0];
  assert.ok(col, "左栏存在");
  // 关键回归：左栏不许再出现 iframe。iframe 是另一个完整的 Web 应用，
  // 它按 localStorage 的 dsh.sessions.current 恢复「上次看的那条会话」，
  // 于是工作台里显示的是**别的任务**的对话——用户原话「显示的是我其他任务的」。
  assert.equal(collect(openTree, (n) => n.type === "iframe").length, 0,
    "左栏里不许再有 iframe：那是「显示别的任务对话」的根源");
  assert.ok(collect(openTree, (n) => cls(n).includes("gzs-chatdock")).length > 0, "左栏是对话容器");

  // 没有 SessionProvider（宿主这版不给渲染能力）时要说清，不能留一片空白
  const bare = texts(openTree).join(" | ");
  assert.ok(bare.includes("没有原生对话渲染能力"), `缺渲染能力要明说：${bare}`);

  // 给了 SessionProvider + renderSlot 时，必须用它把会话渲染出来
  const rendered = [];
  const withProvider = mod.Workspace({
    SessionProvider: ({ children }) => ({ type: "fake-provider", props: {}, children }),
    renderSlot: (name) => ({ type: "fake-slot", props: { name }, children: [] }),
  });
  const dock = collect(withProvider, (n) => cls(n).includes("gzs-chatdock"))[0];
  assert.ok(dock, "对话容器在");
  // 假 React 下 useState 的初值是 null，会话还没开完 → 显示「正在开会话…」，
  // 而不是把别的会话硬塞进来。这正是「当前没有内容就给我一个崭新对话框」的起点。
  assert.ok(texts(dock).join(" ").includes("正在开会话"), "会话未就绪时说明正在开，不显示别人的对话");

  mod.chatOpenStore.set(false);
  assert.equal(mod.chatOpenStore.value, false, "开关状态记进 store");
  const closedTree = mod.Workspace({});
  assert.ok(!cls(closedTree).includes("gzs-root--split"), "收起后是单栏");
  assert.equal(collect(closedTree, (n) => cls(n).includes("gzs-chatcol")).length, 0, "收起后左栏消失");
}

// ── 会话绑定：只用自己的那条，没有就新开一条（手动驱动 effect 验证副作用）──────
{
  const hadWindow = "window" in globalThis;
  const store = new Map();
  const writes = [];
  globalThis.window = {
    location: { origin: "http://127.0.0.1:3080" },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, v); writes.push([k, v]); },
      removeItem: (k) => { store.delete(k); },
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    clearInterval: () => {},
  };
  // 假 React 的 useEffect 是空操作；这里换成「立刻执行并记下清理函数」，
  // 才能验证 useChatSession 真去开会话、真把 id 记下来。
  const realUseEffect = fakeReact.useEffect;
  const effects = [];
  fakeReact.useEffect = (fn) => { const cleanup = fn(); if (typeof cleanup === "function") effects.push(cleanup); };

  // `broken` 是「开局就已经坏掉的那几条」：只影响存量，新建出来的会话必须是健康的，
  // 否则「旧会话坏了 → 重开一条」就测不出来（新开的那条会跟着一起坏）。
  const makeSessions = (rows = {}, opts = {}) => {
    const broken = new Set(opts.broken ?? []);
    const created = [];
    const retained = [];
    return {
      created,
      retained,
      create: async (options) => {
        created.push(options);
        const id = options.sessionId;
        rows[id] = { id, cwd: opts.cwd ?? options.cwd, blank: true };
        return id;
      },
      retain: (id, options) => {
        retained.push([id, options]);
        const row = rows[id];
        const snapshot = broken.has(id)
          ? { openState: "error", removed: true }
          : { openState: "open", blank: true, removed: false };
        return {
          sessionId: id,
          ready: Promise.resolve({ session: { getSnapshot: () => (row ? snapshot : { removed: true }) } }),
          release: () => retained.push([id, "released"]),
        };
      },
      list: { getSnapshot: () => ({ ids: Object.keys(rows), byId: rows }) },
    };
  };

  /**
   * 跑一遍 useChatSession：返回它抓到的副作用（开没开会话、写没写绑定）。
   *
   * 会话服务是**通过 apply 注入**的（`apply` 会把 ctx 抓给 useChatSession），
   * 所以这里重跑一次 apply，而不是给测试单开一个后门导出。
   */
  const runSession = async (sessions, { repoRoot, workspaceId = null, line = "article" } = {}) => {
    const { ctx } = fakeCtx();
    ctx.sessions = sessions;
    mod.apply(ctx);
    writes.length = 0;
    effects.length = 0;
    mod.useChatSession(repoRoot, workspaceId, true, line);
    // 用 macrotask 排空微任务：开会话这条链上有 retain → ready → 可能抛 → 再 create，
    // 固定次数的 `await Promise.resolve()` 数不准，会漏掉后半段。
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
    for (const cleanup of effects) cleanup();
    return { writes: writes.slice(), bound: store.get(`${mod.CHAT_KEY}.${line}`) };
  };

  try {
    // 1) 没存过 → 开一条**新的**会话（不是复用别人的），并把绑定记下来
    store.clear();
    const fresh = makeSessions();
    const first = await runSession(fresh, { repoRoot: "D:\\work\\历史内容生产" });
    assert.equal(fresh.created.length, 1, "没有绑定过就必须新开一条，不能借别人的会话");
    assert.equal(fresh.created[0].cwd, "D:\\work\\历史内容生产", "会话的 cwd 就是本仓根");
    assert.match(fresh.created[0].sessionId, /^session-/, "预先铸造 id，create 超时也能认领");
    assert.ok(first.bound, "绑定要落盘，下次进来还是这条");
    assert.equal(JSON.parse(first.bound).sessionId, fresh.created[0].sessionId);

    // 2) 再进来一次 → 复用存下来的那条，不再新建
    const again = makeSessions({ [fresh.created[0].sessionId]: { id: fresh.created[0].sessionId, cwd: "D:\\work\\历史内容生产" } });
    store.set(`${mod.CHAT_KEY}.article`, first.bound);
    const second = await runSession(again, { repoRoot: "D:\\work\\历史内容生产" });
    assert.equal(again.created.length, 0, "存过就不该再开新会话");
    assert.deepEqual(again.retained[0], [fresh.created[0].sessionId, { source: mod.CHAT_SOURCE }],
      "按 retain 拿会话，来源标签对得上");

    // 3) 仓根变了 → 旧绑定作废，重开（否则会在一个指向别处的会话里继续说话）
    const moved = makeSessions();
    store.set(`${mod.CHAT_KEY}.article`, first.bound);
    const third = await runSession(moved, { repoRoot: "D:\\work\\别的仓" });
    assert.equal(moved.created.length, 1, "仓根对不上就要重开");
    assert.equal(JSON.parse(third.bound).repoRoot, "D:\\work\\别的仓", "绑定换成新的仓根");

    // 4) 存下来的会话已经不存在 / 被移除 → 丢掉重开，绝不硬撑
    const gone = makeSessions({}, { broken: [JSON.parse(first.bound).sessionId] });
    store.set(`${mod.CHAT_KEY}.article`, first.bound);
    const fourth = await runSession(gone, { repoRoot: "D:\\work\\历史内容生产" });
    assert.equal(gone.created.length, 1, "会话没了就新开一条");
    assert.notEqual(JSON.parse(fourth.bound).sessionId, fresh.created[0].sessionId, "绑定换成新的那条");

    // 5) 两条线各自一条：公众号的绑定不能拿去给视频号用
    store.clear();
    const perLine = makeSessions();
    await runSession(perLine, { repoRoot: "D:\\work\\历史内容生产", line: "article" });
    await runSession(perLine, { repoRoot: "D:\\work\\历史内容生产", line: "video" });
    assert.equal(perLine.created.length, 2, "公众号 / 视频号各开一条");
    assert.ok(store.get(`${mod.CHAT_KEY}.article`), "公众号线有绑定");
    assert.ok(store.get(`${mod.CHAT_KEY}.video`), "视频号线有绑定");
    assert.notEqual(store.get(`${mod.CHAT_KEY}.article`), store.get(`${mod.CHAT_KEY}.video`),
      "两条线的绑定互不相同");

    // 6) 没读到仓根 → 明说，不要拿空 cwd 去开会话
    const noRoot = makeSessions();
    store.clear();
    const noRootRun = await runSession(noRoot, { repoRoot: "" });
    assert.equal(noRoot.created.length, 0, "仓根没读到就不该开会话");
    assert.equal(noRootRun.bound, undefined, "也不该写绑定");

    // 7) 宿主没给会话服务 → 不抛，留给界面一句人话
    {
      const { ctx } = fakeCtx();
      mod.apply(ctx); // 这次不挂 sessions
      assert.doesNotThrow(() => mod.useChatSession("D:/x", null, true, "article"),
        "缺服务时不能抛（界面会显示「宿主这一版没提供会话服务」）");
    }
  } finally {
    fakeReact.useEffect = realUseEffect;
    if (!hadWindow) delete globalThis.window;
  }
}

console.log("client-harness: OK（apply 注册面 + 三栏组件真渲染 + 首页卡片 + 治理分组 + 版本/QA/账本口径 + 流水线状态 + 提案性质 + 步骤推断 + 舞台/检查器 tab + 左栏会话内嵌/绑定/递话通道）");

// ── 去 AI 味面板：重复句必须合并成一行 ───────────────────────────────────────
{
  // 真实踩过的坑：模板稿常见「三段同一句」。按段列会把同一句列三遍，
  // 面板一下变几十行，真正要紧的「整篇节奏」被挤出屏幕——只能靠截图发现。
  const sentence = {
    start: 0, end: 20, before: "接下来我们详细解释这个观点背后的具体原因。", after: "",
    mode: "manual", level: "high", words: ["接下来"],
    reasons: [{ id: "meta-next", kind: "编辑腔", level: "high", words: ["接下来"], why: "编辑腔旁白", fix: "删掉过渡" }],
  };
  const deai = {
    ok: false, total: 3, high: 3, mid: 0, low: 0, auto: 0, scanned: 3, bodyLen: 200, per1000: 15,
    terms: ["接下来"],
    sections: [
      { slot: "sec-s1", index: 1, heading: "A", sentences: [{ ...sentence }], high: 1, words: ["接下来"] },
      { slot: "sec-s2", index: 2, heading: "B", sentences: [{ ...sentence, start: 0 }], high: 1, words: ["接下来"] },
      { slot: "sec-s3", index: 3, heading: "C", sentences: [{ ...sentence, start: 0 }], high: 1, words: ["接下来"] },
    ],
    rhythm: { level: "info", items: [{ id: "rhythm-flat", level: "info", title: "3 段长度太整齐", detail: "各段几乎一样", fix: "写长一段压短一段" }] },
    summary: { level: "high", text: "扫了 3 句，有 3 句是明显的 AI 腔。" },
  };
  const tree = mod.Governance({ qa: QA, proposals: [], ledger: [], deai, onAdoptDeai: () => {} });
  const rows = collect(tree, (n) => cls(n).startsWith("gzs-deai__row"));
  assert.equal(rows.length, 1, `三段同一句只渲染一行，实际 ${rows.length} 行`);
  const txt = texts(tree).join(" | ");
  assert.ok(txt.includes("第 1 段、第 2 段、第 3 段 各出现一次"), "合并后要说清这句出现在哪几段");

  // 这句是 manual：不许可点。让机器「改」一句它自己都说没把握的话，
  // 等于把病句写进正文——所以按钮必须点不动，这是红线不是体验。
  assert.equal(rows[0].props.onClick, undefined, "标「手」的行不许点（否则等于让机器改病句）");

  const autoSentence = { ...sentence, mode: "auto", after: "解释这个观点的具体原因。" };
  const adoptable = {
    ...deai,
    sections: [
      { slot: "sec-s1", index: 1, heading: "A", sentences: [{ ...autoSentence, start: 0 }], high: 0, words: ["接下来"] },
      { slot: "sec-s2", index: 2, heading: "B", sentences: [{ ...autoSentence, start: 0 }], high: 0, words: ["接下来"] },
    ],
  };
  const tree2 = mod.Governance({ qa: QA, proposals: [], ledger: [], deai: adoptable, onAdoptDeai: () => {} });
  const row2 = collect(tree2, (n) => cls(n).startsWith("gzs-deai__row"))[0];
  assert.equal(collect(tree2, (n) => cls(n).startsWith("gzs-deai__row")).length, 1, "两段同一句也只一行");
  assert.equal(typeof row2.props.onClick, "function", "可机器改的行给点击");
  // 按钮文案随勾选状态变：没勾是「勾几句可机器改的」，勾了才是「采纳这 N 句」。
  // 断言落在「有那个动作区」上，别钉死某一句文案——文案会改，入口不该消失。
  assert.ok(collect(tree2, (n) => cls(n).startsWith("gzs-deai__acts")).length === 1, "有采纳动作区");
  assert.ok(texts(tree2).join(" ").includes("勾几句可机器改的"), "没勾时按钮提示怎么开始");

  // 节奏块必须在面板里（这是「句子都对但读起来一顺到底」的唯一出口）
  assert.ok(texts(tree).join(" ").includes("整篇的节奏"), "节奏区块要显示");
  assert.ok(texts(tree).join(" ").includes("3 段长度太整齐"), "节奏项要显示具体结论");

  assert.doesNotThrow(() => mod.Governance({ qa: QA, proposals: [], ledger: [], deai: null }), "deai 为 null 不崩");
  assert.doesNotThrow(() => mod.Governance({ qa: QA, proposals: [], ledger: [], deai: { sections: [], rhythm: { items: [] } } }), "空 deai 不崩");
}

// ── 05/06 清单逐项确认 ──────────────────────────────────────────────────────
{
  const mk = (doneKinds = []) => {
    let done = 0;
    const list = ["editor", "reader"].map((kind, i) => {
      const items = Array.from({ length: 8 }, (_, j) => ({
        id: `${kind === "editor" ? "e" : "r"}${j + 1}`,
        text: `${kind} 第 ${j + 1} 条验收项`,
        checked: doneKinds.includes(kind),
        at: doneKinds.includes(kind) ? 1000 : 0,
      }));
      const d = items.filter((x) => x.checked).length;
      done += d;
      return {
        kind, label: kind === "editor" ? "编辑审" : "读者审", no: 5 + i,
        about: `${kind} 干什么`, done: d, total: 8, ok: d === 8, items, missing: [],
      };
    });
    return { list, done, total: 16, ok: done === 16, remaining: 16 - done };
  };

  const empty = mod.Governance({ qa: QA, proposals: [], ledger: [], reviews: mk([]), onToggleReview: () => {} });
  const items = collect(empty, (n) => cls(n).startsWith("gzs-rev__item"));
  assert.equal(items.length, 16, `16 条验收项各渲染一次，实际 ${items.length}`);
  assert.ok(texts(empty).join(" ").includes("编辑审") && texts(empty).join(" ").includes("读者审"), "两份清单都在");
  assert.ok(texts(empty).join(" ").includes("0/16"), "报出进度 0/16");

  // 勾选回调必须带上「哪份清单、哪一条、勾还是取消」——少一样服务端都不知道改哪里
  let got = null;
  const wired = mod.Governance({ qa: QA, proposals: [], ledger: [], reviews: mk([]), onToggleReview: (x) => { got = x; } });
  const first = collect(wired, (n) => cls(n).startsWith("gzs-rev__item"))[0];
  assert.equal(typeof first.props.onClick, "function", "整行可点（不是只有小方块）");
  first.props.onClick();
  assert.ok(got && got.kind === "editor" && got.item === "e1" && got.checked === true,
    `回调参数不对：${JSON.stringify(got)}`);

  // 已勾的项再点一下是「取消」，不是又勾一次
  const checkedTree = mod.Governance({ qa: QA, proposals: [], ledger: [], reviews: mk(["editor"]), onToggleReview: (x) => { got = x; } });
  const onItem = collect(checkedTree, (n) => cls(n).includes("gzs-rev__item--on"))[0];
  assert.ok(onItem, "已勾项带 --on 类（看着有区别）");
  onItem.props.onClick();
  assert.equal(got.checked, false, "已勾的项点一下是取消");

  // busy 时不许点：正在出图/改稿时点勾选会跟服务端抢写
  const busyTree = mod.Governance({ qa: QA, proposals: [], ledger: [], reviews: mk([]), busy: true, onToggleReview: () => {} });
  const busyItem = collect(busyTree, (n) => cls(n).startsWith("gzs-rev__item"))[0];
  assert.equal(busyItem.props.onClick, undefined, "忙的时候勾选禁用");

  assert.doesNotThrow(() => mod.Governance({ qa: QA, proposals: [], ledger: [], reviews: null }), "reviews 为 null 不崩");
  assert.doesNotThrow(() => mod.Governance({ qa: QA, proposals: [], ledger: [], reviews: { done: 3, total: 16, list: [] } }), "list 为空不崩");
}








