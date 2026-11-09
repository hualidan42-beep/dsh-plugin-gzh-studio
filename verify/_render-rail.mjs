/**
 * 右栏渲染快照：把 Inspector 的组件树按层级打印出来，人眼确认「上下文卡 → 页签 → 本段原文」
 * 的顺序对，以及文案读起来是通顺的。
 *
 * 这不是测试（不 assert），是给人看的验收工具：
 *   node verify/_render-rail.mjs
 */
import { pathToFileURL } from "node:url";

const fakeReact = {
  createElement: (type, props, ...children) => {
    if (typeof type === "function") return type({ ...(props || {}), children });
    return { type, props: props || {}, children };
  },
  useState: (init) => [typeof init === "function" ? init() : init, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn(),
  useRef: (init) => ({ current: init }),
  Fragment: Symbol.for("react.fragment"),
};

globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ setAttribute() {}, id: "", textContent: "" }),
  head: { appendChild: () => {} },
};
const loaded = [];
globalThis.window = {
  __ModuleLoader__: { load: (b) => loaded.push(b) },
  addEventListener() {}, removeEventListener() {},
};
await import(pathToFileURL("D:/work/skill/plugins/dsh-plugin-gzh-studio/client.js").href);
const mod = loaded[0].factory((name) => {
  if (name === "react") return fakeReact;
  throw new Error("dep " + name);
});

const ARTICLE = {
  id: "gzh-20261026-abcd",
  title: "一家药企把审批从 14 天压到 3 天",
  subtitle: "两个坑",
  summary: "据公开年报。",
  template: "business",
  audience: "IT 负责人",
  takeaway: "知道两个坑",
  cover: { slot: "cover", prompt: "晨光下的工厂车间", current: "v002", versions: [
    { vid: "v001", width: 900, height: 383, node: "fake", createdAt: 1, bytes: 2048 },
    { vid: "v002", width: 900, height: 383, node: "fake", createdAt: 2, bytes: 3072 }] },
  sections: [
    { id: "s1", heading: "坑一：以为流程是画出来的", body: "流程不是画出来的，是**跑**出来的。\n\n第二句。", image: { slot: "sec-s1", prompt: "白板", current: "v001", versions: [{ vid: "v001", width: 1024, height: 576, node: "fake", createdAt: 3, bytes: 1024 }] } },
    { id: "s2", heading: "坑二：以为审批越快越好", body: "快是结果，不是目标。", image: { slot: "sec-s2", current: "", versions: [] } },
  ],
};
const QA = { ok: false, counts: { error: 1, warn: 1, info: 1 }, items: [
  { id: "cover-ratio", level: "error", scope: "cover", title: "封面比例不对", detail: "1024×1024", fix: "按 900×383 重出" },
  { id: "section-long", level: "warn", scope: "sec-s2", title: "第 2 段太长", detail: "800 字", fix: "拆开" },
  { id: "images-missing", level: "info", scope: "article", title: "1/2 段没配图", detail: "", fix: "至少给开篇配图" },
] };

function walk(node, depth = 0, out = []) {
  if (node === null || node === undefined || node === false) return out;
  const pad = "  ".repeat(depth);
  if (typeof node === "string" || typeof node === "number") {
    const text = String(node).trim();
    if (text) out.push(`${pad}「${text}」`);
    return out;
  }
  if (Array.isArray(node)) { node.forEach((child) => walk(child, depth, out)); return out; }
  if (node && typeof node === "object" && node.type) {
    const cls = node.props?.className ?? "";
    const hidden = node.props?.hidden ? "  [hidden]" : "";
    const tag = typeof node.type === "symbol" ? String(node.type) : node.type;
    out.push(`${pad}<${tag}${cls ? ` .${String(cls).replace(/\s+/g, ".")}` : ""}>${hidden}`);
    walk(node.children, depth + 1, out);
  }
  return out;
}

for (const selected of ["sec-s1", "article"]) {
  const tree = mod.Inspector({
    article: ARTICLE, selected, templates: [
      { id: "business", name: "商务", tokens: {} }, { id: "literary", name: "文艺", tokens: {} },
    ], nodes: [], qa: QA, ledger: [], busy: false,
    pipeline: { bound: false, gates: [] }, pipeBlock: { pipeline: null, busy: false, root: "" },
  });
  console.log(`\n════════ selected = ${selected} ════════`);
  walk(tree).forEach((line) => console.log(line));
}
