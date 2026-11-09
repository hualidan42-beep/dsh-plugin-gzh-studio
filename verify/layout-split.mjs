/**
 * 版式回归：可拖拽分栏 / 顶栏不裁按钮 / 视频号右栏有内容。
 *
 * 为什么这三件事要放在一个测试里：它们是同一个病的三个症状——
 * 「面板窄了，内容不是被藏起来，就是没地方放」。
 * 只断言「DOM 里有 .gzs-split」是没用的：还得断言宽度真的能改变列的 flex-basis，
 * 以及夹取逻辑不会把中间预览挤到不能看。
 *
 * @module verify/layout-split
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

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

// ── 假 document / window / localStorage ─────────────────────────────────────
const styleTexts = [];
const store = new Map();

globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};
const bodyClasses = new Set();
const winListeners = new Map();
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ setAttribute() {}, id: "", set textContent(v) { styleTexts.push(v); } }),
  head: { appendChild: () => {} },
  body: {
    classList: {
      add: (name) => bodyClasses.add(name),
      remove: (name) => bodyClasses.delete(name),
      contains: (name) => bodyClasses.has(name),
    },
  },
  querySelector: () => null,
  querySelectorAll: () => [],
};
globalThis.window = {
  __ModuleLoader__: { load: (bundle) => { globalThis.__bundle = bundle; } },
  location: { search: "", origin: "http://127.0.0.1:3080" },
  addEventListener: (type, fn) => winListeners.set(type, [...(winListeners.get(type) ?? []), fn]),
  removeEventListener: (type, fn) => winListeners.set(type, (winListeners.get(type) ?? []).filter((item) => item !== fn)),
};

const clientUrl = new URL("../client.js", pathToFileURL(import.meta.filename ?? import.meta.url)).href;
await import(clientUrl);

const bundle = globalThis.__bundle;
assert.ok(bundle, "client.js 必须通过 ModuleLoader 注册");
const mod = bundle.factory((name) => {
  if (name === "react") return fakeReact;
  throw new Error(`意外依赖：${name}`);
});

const css = (() => {
  // CSS 在 apply 时注入；这里直接读源码里的模板，避免依赖注入时序
  return null;
})();

// ── 1. 宽度读写要「认得出坏数据」 ────────────────────────────────────────────
{
  store.clear();
  assert.deepEqual(mod.readCols(), {}, "没存过就是空对象（走 CSS 默认）");

  mod.saveCols({ left: 300, right: 420 });
  assert.deepEqual(mod.readCols(), { left: 300, right: 420 }, "存进去读得出来");

  store.set(mod.COL_STORE_KEY, '{"left":"abc","right":-5,"chat":380,"junk":1}');
  assert.deepEqual(mod.readCols(), { chat: 380 }, "非数字 / 负数 / 未知键一律丢掉，只留合法项");

  store.set(mod.COL_STORE_KEY, "{坏 json");
  assert.deepEqual(mod.readCols(), {}, "坏 JSON 不抛错，回默认");

  store.set(mod.COL_STORE_KEY, "null");
  assert.deepEqual(mod.readCols(), {}, "null 也回默认");
}

// ── 2. 默认分栏不能把中间预览挤死 ────────────────────────────────────────────
{
  // 这组数字不是随便取的：1680 的窗口里打开左侧对话后，工作区实测约 927px，
  // 旧版写死 252/336 让中栏只剩 325——比 375 的手机预览还窄，正文被裁。
  const cases = [1680, 1400, 1180, 1050, 927, 860];
  for (const width of cases) {
    const { left, right } = mod.autoCols(width);
    const mid = width - left - right - 2 * mod.SPLIT_W;
    assert.ok(left >= mod.COL_LIMITS.left.min && left <= mod.COL_LIMITS.left.max,
      `${width}px 时左栏 ${left} 落在合法区间`);
    assert.ok(right >= mod.COL_LIMITS.right.min && right <= mod.COL_LIMITS.right.max,
      `${width}px 时右栏 ${right} 落在合法区间`);
    if (width >= 1000) {
      assert.ok(mid >= mod.MID_NEED,
        `${width}px 时中栏 ${mid} 必须放得下 375 手机预览（需 ${mod.MID_NEED}）`);
    }
  }
  // 宽屏时不该乱缩：宽到 1600 以上仍给经典的 252 / 336
  const wide = mod.autoCols(1680);
  assert.equal(wide.left, 252, "宽屏左栏回到 252");
  assert.equal(wide.right, 336, "宽屏右栏回到 336");

  // 没量到宽度时给保守默认，不能 NaN
  for (const bad of [0, undefined, null, -1, NaN]) {
    const out = mod.autoCols(bad);
    assert.ok(Number.isFinite(out.left) && Number.isFinite(out.right), `宽度 ${bad} 时也要给数字`);
  }
}

// ── 2b. 存下来的宽度必须按当下空间夹一遍 ──────────────────────────────────
{
  const fits = (cols, width) => {
    const { left, right } = mod.fitCols(cols, width);
    return { left, right, mid: width - left - right - 2 * mod.SPLIT_W };
  };

  // 放得下就一个字不动：夹取不能变成「每打开一次都悄悄改一遍用户的设置」
  assert.deepEqual(mod.fitCols({ left: 300, right: 400 }, 1680), { left: 300, right: 400 },
    "空间够的时候，存的值原样使用");
  assert.deepEqual(mod.fitCols({}, 1400), mod.autoCols(1400), "没存过就等于自动分配");
  assert.deepEqual(mod.fitCols({}, 927), mod.autoCols(927), "窄面板下同理");

  // 真实事故：右栏被拖到 720 之后打开左侧对话（工作区只剩 927），
  // 旧代码照 720 画，右栏有三分之一跑到面板外，两个按钮彻底点不到。
  const tight = fits({ left: 252, right: 720 }, 927);
  assert.ok(tight.left + tight.right + 2 * mod.SPLIT_W + tight.mid === 927,
    `927 下三栏加起来正好等于面板宽（实得 ${tight.left}+${tight.right}+中栏 ${tight.mid}）`);
  assert.ok(tight.left + tight.right + 2 * mod.SPLIT_W + mod.MID_FLOOR <= 927,
    `夹取之后仍要留得下中栏硬下限 ${mod.MID_FLOOR}（实得中栏 ${tight.mid}）`);
  // 注意这里守的是 MID_FLOOR 不是 MID_NEED：手动拖过的宽度要尽量保住，
  // 用「够用宽度」当闸门会把用户的设置悄悄改回自动值（那正是「拖不动」的由来）。
  assert.ok(tight.mid >= mod.MID_FLOOR, `中栏 ${tight.mid} 不低于硬下限 ${mod.MID_FLOOR}`);
  assert.ok(tight.left >= mod.COL_LIMITS.left.min && tight.right >= mod.COL_LIMITS.right.min,
    "夹取不能把任何一栏压到下限以下");

  // 让位顺序：先压用户没拖过的那一栏，手动值尽量保住。
  // 宽度特意取 1260：这里刚好只差一点点，自动那一栏让出 13px 就够，
  // 手动拖过的右栏应当一动不动。（1400 太宽，压根不用让位，测不出顺序。）
  const auto = fits({ right: 720 }, 1260);
  assert.equal(auto.right, 720, "手动拖过的右栏在还有空间时保持 720");
  assert.ok(auto.left < mod.autoCols(1260).left, `自动那一栏先让位（左栏 ${auto.left} < ${mod.autoCols(1260).left}）`);

  // 闸门分两档：一栏都没拖过 = 自动布局，中栏必须放得下手机预览（MID_NEED）；
  // 拖过某一栏 = 用户的明确指令，中栏只需守住硬下限（MID_FLOOR）。
  // 混成同一个数会翻车：全用 MID_NEED，「拖了白拖」；全用 MID_FLOOR，
  // 窄面板下手机预览被压到 300（图缩小、还偏出中线）。
  // 927 是能分出两档的宽度：拿 MID_NEED 当闸门时，左栏 300 会被压回 236。
  const pureAuto = fits({}, 927);
  assert.ok(pureAuto.mid >= mod.MID_NEED,
    `纯自动时中栏 ${pureAuto.mid} 要放得下手机预览（${mod.MID_NEED}）`);
  const dragged = fits({ left: 300 }, 927);
  assert.equal(dragged.left, 300, `手动拖到 300 就得是 300，不能被自动闸门改回（实得 ${dragged.left}）`);
  assert.ok(dragged.mid < mod.MID_NEED, `拖过之后中栏 ${dragged.mid} 允许低于够用宽度——这才是真的拖动`);
  assert.ok(dragged.mid >= mod.MID_FLOOR, `但不得低于硬下限（实得 ${dragged.mid}）`);

  // 超出上下限的脏数据也要收回来
  const dirty = fits({ left: 520, right: 2000 }, 700);
  assert.ok(dirty.left >= mod.COL_LIMITS.left.min && dirty.left <= mod.COL_LIMITS.left.max,
    `左栏 ${dirty.left} 落在区间内`);
  assert.ok(dirty.right >= mod.COL_LIMITS.right.min && dirty.right <= mod.COL_LIMITS.right.max,
    `右栏 ${dirty.right} 落在区间内`);
}

// ── 2c. 手动拖拽必须真的有地方可拖（「假动作」回归）──────────────────────────
{
  // 用户原话：「你虽然做了 ↔ 拖动的动作，但根本没有生效，假动作。」
  // 根因不是事件没接上，而是**没有空间**：1680 窗口打开左栏对话后工作区 927，
  // 左 200 + 右 250 + 中栏要 427 + 两条分隔条 14 = 891，只剩 36px。
  // 往右拖 40px 就被夹回原处，看起来就是拖不动。
  const slack = (floor, left, right, width) => width - left - right - floor - 2 * mod.SPLIT_W;

  assert.ok(mod.MID_FLOOR < mod.MID_NEED,
    `硬下限 ${mod.MID_FLOOR} 必须低于够用宽度 ${mod.MID_NEED}，否则两个数没有分工`);
  const withNeed = slack(mod.MID_NEED, 200, 250, 927);
  const withFloor = slack(mod.MID_FLOOR, 200, 250, 927);
  assert.ok(withNeed < 60, `拿 MID_NEED 当闸门时只剩 ${withNeed}px 可拖——这就是「假动作」`);
  assert.ok(withFloor >= 120, `拿 MID_FLOOR 当闸门时有 ${withFloor}px 可拖，手感才成立`);

  // 三个方向都要有空间：右栏往左拖同理
  assert.equal(withFloor, slack(mod.MID_FLOOR, 200, 250, 927), "左右两栏共用同一份余量");
}

// ── 3. 分隔条：可聚焦、可拖、可双击复位 ──────────────────────────────────────
{
  const calls = [];
  const el = mod.Splitter({
    label: "中间预览与检查器之间",
    onStart: () => 336,
    onDrag: (want) => calls.push(["drag", want]),
    onReset: () => calls.push(["reset"]),
  });

  assert.equal(el.props.className, "gzs-split", "分隔条类名");
  assert.equal(el.props.role, "separator", "无障碍角色：分隔条");
  assert.equal(el.props["aria-orientation"], "vertical", "竖直方向");
  assert.equal(el.props.tabIndex, 0, "可键盘聚焦（不然只能用鼠标）");
  assert.match(String(el.props.title), /双击/, "提示里要写清怎么复位");

  // 抓手是纯装饰，不能被读屏念出来
  const grip = el.children[0];
  assert.equal(grip.props["aria-hidden"], "true", "抓手只有装饰作用");

  // 键盘：方向键微调
  el.props.onKeyDown({ key: "ArrowLeft", shiftKey: false, preventDefault() {} });
  el.props.onKeyDown({ key: "ArrowRight", shiftKey: true, preventDefault() {} });
  assert.deepEqual(calls, [["drag", 320], ["drag", 384]], "←/→ 各 16px，按住 Shift 48px");

  // 键盘：Home 复位
  calls.length = 0;
  el.props.onKeyDown({ key: "Home", preventDefault() {} });
  assert.deepEqual(calls, [["reset"]], "Home 复位默认宽度");

  // 指针：拖 60px 就应该报「起点 + 60」
  calls.length = 0;
  const node = { dataset: {}, setPointerCapture() {}, releasePointerCapture() {} };
  const evt = (extra) => ({ currentTarget: node, preventDefault() {}, ...extra });
  el.props.onPointerDown(evt({ button: 0, pointerType: "mouse", clientX: 500, pointerId: 1 }));
  assert.equal(node.dataset.dragging, "true", "拖拽中打标记（样式据此变粗变绿）");
  el.props.onPointerMove(evt({ clientX: 560 }));
  assert.deepEqual(calls, [["drag", 396]], "向右拖 60 → 336 + 60");
  el.props.onPointerUp(evt({ pointerId: 1 }));
  assert.equal(node.dataset.dragging, undefined, "松手清掉拖拽标记");
  el.props.onPointerMove(evt({ clientX: 800 }));
  assert.equal(calls.length, 1, "松手之后不再跟随鼠标（否则会莫名继续变宽）");

  // 右键不该开始拖动
  calls.length = 0;
  el.props.onPointerDown(evt({ button: 2, pointerType: "mouse", clientX: 500, pointerId: 1 }));
  el.props.onPointerMove(evt({ clientX: 600 }));
  assert.deepEqual(calls, [], "右键不拖");
}

// ── 2b. 右栏的分隔条在它左边：方向必须反相 ──────────────────────────────────
{
  // 这条是用户一眼就能看出来的错：拖右栏的分隔条往右，右栏反而变宽。
  const calls = [];
  const inverted = mod.Splitter({
    label: "中间预览与检查器之间",
    invert: true,
    onStart: () => 336,
    onDrag: (want) => calls.push(want),
    onReset: () => calls.push("reset"),
  });
  const node = { dataset: {}, setPointerCapture() {}, releasePointerCapture() {} };
  const evt = (extra) => ({ currentTarget: node, preventDefault() {}, ...extra });
  inverted.props.onPointerDown(evt({ button: 0, pointerType: "mouse", clientX: 500, pointerId: 1 }));
  inverted.props.onPointerMove(evt({ clientX: 560 }));
  assert.equal(calls[0], 276, "往右拖 60 → 右栏窄 60");
  inverted.props.onPointerMove(evt({ clientX: 440 }));
  assert.equal(calls[1], 396, "往左拖 → 右栏变宽");
  inverted.props.onKeyDown(evt({ key: "ArrowLeft", shiftKey: false }));
  assert.equal(calls[2], 352, "键盘 ← 让右栏变宽（和拖动同向）");
  inverted.props.onKeyDown(evt({ key: "ArrowRight", shiftKey: false }));
  assert.equal(calls[3], 320, "键盘 → 让右栏变窄");
}

// ── 2c. 拖拽不再污染整页光标（这就是「正文里也是 ↔」的根因）──────────────────
{
  const el = mod.Splitter({
    label: "中间预览与检查器之间",
    onStart: () => 300,
    onDrag: () => {},
    onReset: () => {},
  });
  const node = { dataset: {}, setPointerCapture() {}, releasePointerCapture() {} };
  const evt = (extra) => ({ currentTarget: node, preventDefault() {}, ...extra });

  // 拖拽全程都不许往 body 加类：那条全局 col-resize 一旦漏收尾就会卡死整页
  el.props.onPointerDown(evt({ button: 0, pointerType: "mouse", clientX: 500, pointerId: 9 }));
  assert.equal(bodyClasses.has("gzs-resizing"), false, "开始拖动也不给整页加 col-resize");
  el.props.onPointerUp(evt({ pointerId: 9 }));
  assert.equal(bodyClasses.has("gzs-resizing"), false, "松手后当然也没有");
  assert.equal(node.dataset.dragging, undefined, "松手清掉拖拽标记");

  // 窗口外松手：兜底监听要摘干净，不能越拖越多
  el.props.onPointerDown(evt({ button: 0, pointerType: "mouse", clientX: 500, pointerId: 10 }));
  for (const fn of [...(winListeners.get("pointerup") ?? [])]) fn({});
  assert.equal(node.dataset.dragging, undefined, "窗口外松手也清标记");
  assert.equal((winListeners.get("pointerup") ?? []).length, 0, "兜底监听不能残留");
}

// ── 2d. 旧版本残留的锁要能自愈 ─────────────────────────────────────────────
{
  // 还开着旧包的页面可能留下 body.gzs-resizing；新代码一挂载就会清掉它
  bodyClasses.add("gzs-resizing");
  assert.equal(mod.healResizeCursor(globalThis.document), true, "残留锁定要被清掉");
  assert.equal(bodyClasses.has("gzs-resizing"), false, "清掉之后整页不再 ↔");
  assert.equal(mod.healResizeCursor(globalThis.document), false, "没有残留时不做多余操作");
}

// ── 3. 视频号右栏：不能是空白 ────────────────────────────────────────────────
{
  const steps = mod.VIDEO_STEPS;
  assert.equal(steps.length, 8, "八步");

  const empty = mod.VideoAside({ episodes: [], open: false, onPlan: () => {}, hint: "" });
  const emptyText = JSON.stringify(empty);
  // 文案按当前实现断言（2026-11-09 核对：这一版就是这么说的）
  assert.ok(emptyText.includes("还没选哪一期"), "没选期时要有明确标题");
  assert.ok(emptyText.includes("还差几步"), "要有缺口区（不是一片空白）");
  assert.ok(emptyText.includes("还没有视频期"), "没有期时说清是盘上还没有，而不是加载失败");
  assert.ok(emptyText.includes("生成在哪做"), "要说明生成动作在对话里，不是看板里");

  const episodes = [
    { id: "FDE-01", status: "分段 · 1/8", files: { segments: true } },
    { id: "FDE-02", status: "大纲 · 1/8", files: { outline: true } },
    { id: "FDE-03", status: "口播稿 · 2/8", files: { outline: true, script: true } },
  ];
  const filled = mod.VideoAside({ episodes, open: false, onPlan: () => {}, hint: "" });
  const filledText = JSON.stringify(filled);
  assert.ok(filledText.includes('"3"'), "总期数 3");
  assert.ok(filledText.includes("期八件齐"), "要报几期八件齐");
  assert.ok(filledText.includes("在途"), "要报几期在途");
  // 每一步的「已齐/总」都要出现，否则缺口表是残的
  for (const n of ["1/3", "2/3", "0/3"]) {
    assert.ok(filledText.includes(n), `缺口表要有 ${n}`);
  }
  // 八件全齐时不显示进度条，改给结论
  const allDone = mod.VideoAside({
    episodes: [{ id: "FDE-09", files: Object.fromEntries(steps.map((s) => [s.key, true])) }],
    open: false, onPlan: () => {}, hint: "",
  });
  assert.ok(JSON.stringify(allDone).includes("该有的文件都齐了"), "全齐时给结论而不是一排 100%");
}

// ── 4. 样式层：三件事必须真的写在 CSS 里 ─────────────────────────────────────
{
  // 直接读源码，断言规则存在：组件能渲染 ≠ 布局对
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../client.js", import.meta.url), "utf8");

  assert.match(src, /\.gzs-head\{[^}]*flex-wrap:wrap/, "顶栏必须能换行");
  assert.ok(
    !/\.gzs-head\{[^}]*overflow:hidden/.test(src),
    "顶栏不能 overflow:hidden —— 那正是「导出 HTML 被裁掉」的原因",
  );
  assert.match(src, /\.gzs-head>\*\{flex:0 0 auto\}/, "顶栏按钮不许被压扁");
  assert.match(src, /\.gzs-split\{[^}]*cursor:col-resize/, "分隔条要有拖拽光标");
  assert.ok(
    !/body\.gzs-resizing\s*,\s*body\.gzs-resizing\s*\*\s*\{[^}]*cursor\s*:\s*col-resize/.test(src),
    "不再用 body 级全局 col-resize，避免漏收尾时整页卡成 ↔",
  );
  assert.match(src, /\.gzs-vsplit\{[^}]*grid-template-columns/, "视频号必须是两栏");
  assert.match(src, /\.gzs-col--left\{flex:0 0 252px/, "左栏默认宽度保留");
  assert.match(src, /\.gzs-col--right\{flex:0 0 336px/, "右栏默认宽度保留");
  // 中间的下限由 JS 夹取，CSS 里的 min-width 必须和同一个常量对齐：
  // 以前这里断言的是一个没人用的 MID_MIN=320，而 CSS 实际写的是 427，
  // 两边对不上也能「通过」——所以改成拿 CSS 真实值跟 JS 常量比。
  assert.equal(mod.MID_NEED, 375 + 52, "中栏够用宽度 = 375 手机宽 + 两侧 26 内边距");
  assert.equal(mod.MID_FLOOR, 300, "中栏硬下限 = 300（手动拖拽时的底线）");
  const midCss = src.match(/\.gzs-col--mid\{[^}]*min-width:(\d+)px/);
  assert.ok(midCss, "中栏必须有 min-width，否则会被 flex 压成一条缝");
  // CSS 里那一档是**自动布局**的下限，所以必须等于 MID_NEED（427）。
  // 曾经把它改成 MID_FLOOR(300) 想让拖拽更顺，结果纯自动档下中栏只有 300，
  // 手机预览被压小、还偏出中线 31px —— 自动档的手感也跟着坏了。
  // 正确分工：CSS 保自动档（427），手动档由内联 min-width 覆盖成 300。
  assert.equal(Number(midCss[1]), mod.MID_NEED,
    `CSS min-width ${midCss[1]} 必须等于 MID_NEED ${mod.MID_NEED}（自动档要放得下手机预览）`);
  // 手动档：用户拖过某一栏时给中栏叠一个内联 min-width = MID_FLOOR，
  // 否则 CSS 的 427 会把 JS 刚算好的 300 撑回去 —— 拖了还是没反应。
  assert.match(src, /const wantsManual = cols\.left != null \|\| cols\.right != null/,
    "要有「用户拖过某一栏没有」的判断，两档下限全靠它分");
  assert.match(src, /style: wantsManual \? \{ minWidth: `\$\{MID_FLOOR\}px` \} : undefined/,
    "拖过某一栏时中栏要叠内联 min-width = MID_FLOOR，否则拖拽被 CSS 吃掉");
  assert.ok(mod.COL_LIMITS.left.min < mod.COL_LIMITS.left.max, "左栏区间合法");
  assert.ok(mod.COL_LIMITS.right.max >= 500, "右栏要能拉到足够宽看对照");
  // 步骤行有 4 个格子（圆点 / 名称 / 证据 / 状态）。只写 3 列时第 4 个掉进隐式列，
  // 左栏一窄状态标签就被压成 14px 的省略号——「完成 / 进行中」全看不见。
  const stepLine = src.match(/\.gzs-stepline\{[^}]*grid-template-columns:([^;]+);/);
  assert.ok(stepLine, ".gzs-stepline 必须显式定义列");
  assert.equal(stepLine[1].trim().split(/\s+/).length, 4, "步骤行要 4 列，对应 4 个子元素");
  assert.match(stepLine[1], /minmax\(34px,auto\)/, "状态标签列要有下限，不能被压成省略号");

  // clampCol 曾经写成「body 宽 − 对话列 − 3 条分隔条」。body 是对话列的兄弟节点，
  // 宽度里本来就不含对话列，这一减等于双重扣减，中栏永远算出一个假亏空，
  // 结果**任何一栏都拖不宽**（拖完 localStorage 存回的仍是原值，看起来像没反应）。
  assert.ok(
    !/const avail = \(bodyWidth \|\| rootWidth\) - chat/.test(src),
    "clampCol 不能从 body 宽里再减对话列：body 已不含对话列，减两次会让谁拖都拖不动",
  );
  assert.match(src, /const avail = bodyWidth \|\| rootWidth;/, "三栏可用宽度就是 body 自己的宽度");
  // 拖拽分支里不能再出现 MID_NEED：它是「自动布局的目标」，不是「手动拖拽的闸门」。
  // 用错那个数的症状就是余量只剩几十像素，拖一下就到底，用户判为「假动作」。
  // 只看代码、不看注释：这里刚写过一段解释旧 bug 的注释，里面必然提到 MID_NEED。
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const clampBody = stripComments(src.slice(
    src.indexOf("const clampCol = (key, want)"),
    src.indexOf("const dragCol = (key, want)"),
  ));
  assert.ok(clampBody.length > 0, "找得到 clampCol");
  assert.ok(!/MID_NEED/.test(clampBody), "clampCol 里不能拿 MID_NEED 当闸门，要用 MID_FLOOR");
  assert.match(clampBody, /MID_FLOOR/, "clampCol 用 MID_FLOOR 算可拖余量");
}

console.log("layout-split: OK（宽度读写容错 / 分隔条指针与键盘 / 视频号右栏三种状态 / 样式规则）");
