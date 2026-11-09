/**
 * 视频号面板三种空态必须分开说清楚（0.4.5）。
 *
 * 之前的 bug：`scanEpisodes` 把「期目录不存在」和「目录是空的」返回成同一个形状，
 * 于是面板只有一个「暂无视频期 · 这不是错误：07-video/episode 里还没有期」。
 * 一个根本没有 07-video 目录的用户看到这句，会以为「只是还没开始做」，
 * 于是等一个永远不会出现的期列表。
 *
 * 这里直接给三种后端返回，**真调用一遍 `VideoBoard`**，断言面板说出的是三句不同的话，
 * 且都不把 `07-video/episode` 当成用户盘上必然存在的东西。
 *
 * 组件内部靠 `useEffect` 取数，垫片里的 `useEffect` 是空转的；所以这里把
 * `fetch` 的返回预先摆好，并让垫片的 `useState` 在**首屏**就拿到数据
 * （`loading` 初值给 false、`data` 初值给目标形状），以此渲染出目标分支。
 * @module verify/video-empty-state-unit
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

// ── 假 React ─────────────────────────────────────────────────────────────────
const fakeReact = {
  createElement: (type, props, ...children) => {
    if (typeof type === "function") return type({ ...(props || {}), children });
    return { type, props, children };
  },
  useState: (init) => [typeof init === "function" ? init() : init, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (init) => ({ current: typeof init === "function" ? init() : init }),
  Fragment: Symbol.for("react.fragment"),
};

// ── 假 document ──────────────────────────────────────────────────────────────
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ setAttribute() {}, id: "", textContent: "" }),
  head: { appendChild: () => {} },
};

// ── 假 ModuleLoader ──────────────────────────────────────────────────────────
const loaded = [];
globalThis.window = {
  __ModuleLoader__: { load: (bundle) => loaded.push(bundle) },
  addEventListener: () => {},
  removeEventListener: () => {},
};

const clientUrl = new URL("../client.js", pathToFileURL(import.meta.filename ?? import.meta.url)).href;
await import(clientUrl);

assert.equal(loaded.length, 1, "ModuleLoader.load 恰好一次");
const mod = loaded[0].factory((name) => {
  if (name === "react") return fakeReact;
  throw new Error(`意外依赖：${name}`);
});
assert.equal(typeof mod.VideoBoard, "function", "导出 VideoBoard");

// ── 把 texts 收集出来 ────────────────────────────────────────────────────────
function texts(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((child) => texts(child, out));
    return out;
  }
  if (node && typeof node === "object") {
    if (Array.isArray(node.children)) texts(node.children, out);
  }
  return out;
}

/** 收集所有节点的 title 属性：用来断言「完整路径只在悬停里，不在正文里」。 */
function titles(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    node.forEach((child) => titles(child, out));
    return out;
  }
  const title = node.props?.title;
  if (typeof title === "string") out.push(title);
  if (Array.isArray(node.children)) titles(node.children, out);
  return out;
}

/**
 * 渲染 VideoBoard，让它首屏就落在目标分支上。
 *
 * `useState` 在垫片里不会更新，所以「先 loading 再取到数据」这条路径走不通。
 * 做法：临时替换 `useState`，让它在**第一次调用**（feed）时直接返回目标数据，
 * 后续调用（openId/openTab/chatHint）返回各自的初值。
 */
function renderBoard(data) {
  const realUseState = fakeReact.useState;
  let call = 0;
  fakeReact.useState = (init) => {
    call += 1;
    if (call === 1) {
      return [{ loading: false, refreshing: false, error: "", data, status: 200 }, () => {}];
    }
    return [typeof init === "function" ? init() : init, () => {}];
  };
  try {
    return mod.VideoBoard({ refreshKey: 0, onContext: () => {} });
  } finally {
    fakeReact.useState = realUseState;
  }
}

// ── 1. 期目录不存在（这次改的那一档）────────────────────────────────────────
// 2026-11-09 作者定稿的文案：标题是状态「视频目录未配置」，正文只说现状 + 两条路，
// **屏幕上不许出现实现词**（settings.json / GZH_STUDIO_EPISODES / episodesRoot /
// 真源仓库），也不许用「不是坏了，是还没建」这种辩解句。
check("期目录不存在 → 标题是「视频目录未配置」，给两条路", () => {
  const view = renderBoard({
    root: "D:/我的内容仓/07-video/episode",
    configured: true,
    exists: false,
    episodes: [],
    defaultDir: "D:/我的数据/episodes",
  });
  const joined = texts(view).join(" | ");
  assert.ok(joined.includes("视频目录未配置"), `标题要是「视频目录未配置」，实际：${joined.slice(0, 300)}`);
  assert.ok(joined.includes("尚未指定视频期文件的存放位置"), "要说清是没指定位置");
  assert.ok(joined.includes("选择视频目录"), "路①：指到已有目录");
  assert.ok(joined.includes("创建默认目录"), "路②：建出默认目录");
  // 「建在哪儿」要说清，但**不能把绝对路径摆在正文里**，也不能让用户以为要动他的仓库：
  // `07-video` 是某套内容仓库的编号习惯，不是所有用户的；默认目录归插件自己。
  assert.ok(joined.includes("插件自己的数据目录"), "要说明建在插件自己的目录里");
  assert.ok(joined.includes("不动你的内容仓库"), "要明说不动用户的内容仓库");
  // 顶部会显示**当前实际在读**的目录（那是事实，不是建议）；但「会建在哪」这句
  // 不能把作者的仓库编号习惯（07-video）或盘符当成默认值塞给用户。
  assert.ok(!texts(view).some((t) => /会建/.test(t) && /07-video|D:/.test(t)),
    "「会建在」那句里不许出现 07-video 或盘符");
  // 但完整路径不能丢：要核对的人得能查到（放在 title 里，悬停可见）
  assert.ok(titles(view).some((t) => t.includes("episodes")),
    "完整路径要留在 title 里，供需要核对的人查看");
  // 实现词一个都不许露出来
  for (const jargon of ["settings.json", "GZH_STUDIO_EPISODES", "episodesRoot", "真源仓库"]) {
    assert.ok(!joined.includes(jargon), `屏幕上不该出现实现词「${jargon}」`);
  }
  // 不能只说「还没有期」——那是另一种状态
  assert.ok(!joined.includes("已经在盘上"), "任何空态都不许出现这句");
  // 八步照样摆出来
  for (const label of ["大纲", "口播稿", "分镜", "配音", "分段", "字幕", "封面", "成片"]) {
    assert.ok(joined.includes(label), `八步缺了「${label}」`);
  }
});

// ── 2. 目录存在但空 ─────────────────────────────────────────────────────────
check("目录存在但空 → 只说「还没有期」，不复述路径", () => {
  const view = renderBoard({
    root: "D:/我的内容仓/07-video/episode",
    configured: true,
    exists: true,
    episodes: [],
  });
  const joined = texts(view).join(" | ");
  assert.ok(joined.includes("还没有期"), `没出现「还没有期」，实际：${joined.slice(0, 300)}`);
  assert.ok(!joined.includes("已经在盘上"), "作者要求不许写这句");
  assert.ok(!joined.includes("视频目录未配置"), "目录存在时不该再说「视频目录未配置」");
});

// ── 3. 没配仓库 / 指不出期目录 ───────────────────────────────────────────────
// `configured` 的含义已从「配了真源仓库」改成「**有没有地方可读**」：
// 期目录可以指到插件数据目录或任意绝对路径，不需要仓库。
// 所以「没配仓库」不再单独占一屏——它和「目录不存在」共用同一块：
// 反正用户要做的动作是同一件事：指定一个目录。
check("指不出期目录 → 也走「视频目录未配置」，不再讲环境变量", () => {
  const view = renderBoard({ root: "", configured: false, exists: false, episodes: [] });
  const joined = texts(view).join(" | ");
  assert.ok(joined.includes("视频目录未配置"), `该走同一屏，实际：${joined.slice(0, 300)}`);
  assert.ok(joined.includes("创建默认目录"), "要能给「建一个」这条出路");
  for (const jargon of ["GZH_STUDIO_REPO", "settings.json", "episodesRoot"]) {
    assert.ok(!joined.includes(jargon), `不该再让用户去改「${jargon}」`);
  }
});

// ── 4. 两种状态的文案必须互不相同 ───────────────────────────────────────────
check("「目录不存在」和「目录是空的」说的不是同一句话", () => {
  const a = texts(renderBoard({ root: "R/07-video/episode", configured: true, exists: false, episodes: [] })).join(" ");
  const b = texts(renderBoard({ root: "R/07-video/episode", configured: true, exists: true, episodes: [] })).join(" ");
  assert.notEqual(a, b, "「目录不存在」和「目录是空的」文案不能一样");
});

// ── 4b. 作者 2026-11-09 定：这句话不许出现在任何一处 ─────────────────────────
// 「期目录 07-video/episode 已经在盘上，只是里面还没有期」——读的是哪个目录，
// 页头已经写着；正文再复述一遍既啰嗦，又把内部路径抬进了正文。
check("不再出现「已经在盘上，只是里面还没有期」这句", () => {
  for (const fixture of [
    { root: "R/07-video/episode", configured: true, exists: true, episodes: [] },
    { root: "R/07-video/episode", configured: true, episodes: [] },
    { root: "R/07-video/episode", configured: true, exists: false, episodes: [] },
  ]) {
    const joined = texts(renderBoard(fixture)).join(" ");
    assert.ok(!joined.includes("已经在盘上"), `不该再出现这句，实际：${joined.slice(0, 200)}`);
    assert.ok(!joined.includes("只是里面还没有期"), "也不许换个说法保留");
  }
  // 没期这一屏仍然要有「还没有期」+ 下一步做什么
  const empty = texts(renderBoard({ root: "R/07-video/episode", configured: true, exists: true, episodes: [] })).join(" ");
  assert.ok(empty.includes("还没有期"), "要说清是没期");
  assert.ok(empty.includes("在左侧对话里定下选题和期号"), "要给出下一步");
});

// ── 4c. 侧栏「生成在哪做」也不再解释实现 ─────────────────────────────────────
check("侧栏不再写「看板只读盘 … 不替你生成」（这句是解释实现，不是告诉人去哪做）", () => {
  const aside = mod.VideoAside({ episodes: [], open: false, onPlan: () => {}, hint: "" });
  const joined = texts(aside).join(" ");
  assert.ok(!joined.includes("看板只读盘"), "删掉的那句不许回来");
  assert.ok(!joined.includes("不替你生成"), "同上的另一半也不许回来");
  assert.ok(joined.includes("生成在哪做"), "卡片本身要在");
  assert.ok(joined.includes("都由会话里的 agent 产出"), "要说清生成发生在对话里");
});

// ── 5. 有期时正常列表 ───────────────────────────────────────────────────────
check("有期时列出来，不再走空态", () => {
  const view = renderBoard({
    root: "R/07-video/episode",
    configured: true,
    exists: true,
    episodes: [{
      id: "DEMO-01",
      dir: "DEMO-01",
      status: "大纲 · 1/8",
      files: { outline: true, script: false, storyboard: false, audio: false, segments: false, subtitle: false, cover: false, final: false },
    }],
  });
  const joined = texts(view).join(" | ");
  assert.ok(joined.includes("DEMO-01"), "期号要出现");
  assert.ok(joined.includes("1/8"), "进度要出现");
  assert.ok(!joined.includes("视频目录未配置"), "有期时不该走空态");
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} 通过 / ${failed.length} 失败`);
process.exit(failed.length ? 1 : 0);
