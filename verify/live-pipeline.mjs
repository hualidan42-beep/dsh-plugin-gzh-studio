/**
 * 真界面验证「已绑定期号」那条路：绑定 → 断言 → 截图 → 解绑还原。
 *
 * 为什么单独一个脚本：`live-ui.mjs` 的立场是**不破坏用户数据**（新建流程都只点取消）。
 * 这里要真的写一次 `article.pipeline`，所以分开放，并且**结束时一定解绑**，
 * 账本里会留下 `pipeline:bound` / `pipeline:unbound` 两条——它们是真实操作记录，不算脏数据。
 *
 * 用演示文章绑定真实期号，只为验证**界面能不能正确显示状态**；
 * 语义上这篇药企审批稿与第 027 期无关，所以结尾必须解绑，不能留下错配。
 *
 * 用法：node verify/live-pipeline.mjs <token> [episodeId] [root]
 */
import { launch, attach } from "./cdp.mjs";
import { mkdir } from "node:fs/promises";

const TOKEN = process.argv[2];
const EPISODE = process.argv[3] ?? "historical-person-027";
const ROOT = process.argv[4] ?? "D:/work/历史内容生产";
if (!TOKEN) {
  console.error("用法：node verify/live-pipeline.mjs <token> [episodeId] [root]");
  process.exit(1);
}

const SHOT_DIR = "D:/work/skill/plugins/dsh-plugin-gzh-studio/verify/shots";
await mkdir(SHOT_DIR, { recursive: true });

const steps = [];
const record = (name, ok, detail = "") => {
  steps.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const url = `http://127.0.0.1:3080/?token=${TOKEN}`;
const chrome = await launch({ port: 9341, url, width: 1680, height: 1000 });
const page = await attach(chrome.port);

const call = (path, body) =>
  page.evaluate(`(async () => {
    const init = { credentials: "same-origin", headers: { "content-type": "application/json" } };
    ${body ? `init.method = "POST"; init.body = ${JSON.stringify(JSON.stringify(body))};` : ""}
    const res = await fetch(${JSON.stringify(path)}, init);
    return { status: res.status, text: await res.text() };
  })()`);

/** 读右栏流水线区块的可见内容。 */
const readPipe = () =>
  page.evaluate(`(() => {
    const block = document.querySelector(".gzs-pipe");
    if (!block) return { bound: false, body: document.querySelector(".gzs-col--right")?.innerText ?? "" };
    const q = (s) => (block.querySelector(s)?.textContent || "").trim();
    return {
      // 判「绑定没绑定」用显式的 data 属性，不靠元素在不在：
      // 未绑定分支也渲染 .gzs-pipe（它要显示粗略进度），靠元素存在判会永远报「已绑定」。
      bound: block.dataset.pipe === "bound",
      loose: block.dataset.pipe === "loose",
      // 整块正文：既用于「有没有那个入口」的文案检查，也是排错时的证据
      body: block.innerText,
      word: q(".gzs-pipe__word"),
      wordTitle: block.querySelector(".gzs-pipe__word")?.getAttribute("title") || "",
      ep: q(".gzs-pipe__ep"),
      hint: q(".gzs-pipe__hint"),
      blockLine: q(".gzs-pipe__block"),
      next: (block.textContent.match(/下一步：([^\s·]+)/) || ["", ""])[1],
      // 「下一步」旁边的人话进度条（十段）里的第一个未完成项，用来核「步号」对得上
      nextNode: (() => {
        const node = [...block.querySelectorAll(".gzs-mini")].find((n) => !/--done/.test(n.className));
        return node ? (node.getAttribute("title") || "").split(" ")[0] : "";
      })(),
      unknownLine: (block.textContent.match(/\\d+ 项判据不可用/) || [""])[0],
      gates: block.querySelectorAll(".gzs-gate").length,
    };
  })()`);

const ARTICLE = "gzh-20261026-36ad";
let bound = false;

/**
 * 工作台现在默认落到最近一篇，不再默认首页。这个套件后面要验首页卡片徽标，
 * 所以每次打开后先把界面明确带到「全部文章」，不能再假设 `.gzs-card` 天生存在。
 */
async function ensureHome() {
  // 工作台面板先挂，再异步读文章；在数据到位前 `.gzs-body` 还不存在，不能因为
  // 「暂时没三栏」就误判已经在首页。先等任一稳定视图，再决定要不要回全部文章。
  await page.waitFor(
    `document.querySelector(".gzs-card") || document.querySelector(".gzs-body") || document.querySelector(".gzs-gov")`,
    "工作台数据到位",
    30000,
  );
  const inArticle = await page.evaluate(`Boolean(document.querySelector(".gzs-body"))`);
  if (inArticle) await page.clickText("全部文章", ".gzs-btn");
  await page.waitFor(`document.querySelector(".gzs-card")`, "首页卡片", 30000);
}

/**
 * 侧栏面板列表在当前宿主里可能是 display:none（按钮仍在 DOM，React 委托仍能收到 click）。
 * 这里不能用按坐标点击：零尺寸按钮没有坐标。和 live-ui 的入口验收保持同一做法。
 */
async function openStudio() {
  await page.waitFor(
    `[...document.querySelectorAll("button")].some((b) => (b.textContent || "").includes("新媒体工作台"))`,
    "侧栏「新媒体工作台」按钮出现",
    90000,
  );
  const clicked = await page.evaluate(`(() => {
    const btn = [...document.querySelectorAll("button")]
      .find((node) => (node.textContent || "").includes("新媒体工作台"));
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  if (!clicked) throw new Error("侧栏没有新媒体工作台入口");
  await page.waitFor(`document.querySelector(".gzs-root")`, "工作台挂载", 30000);
}

try {
  await page.waitFor("!document.body.innerText.includes('Loading plugins')", "插件加载完", 90000);
  await new Promise((r) => setTimeout(r, 1500));
  await openStudio();
  await ensureHome();

  // 进文章
  await page.clickText("一家药企", ".gzs-card__title");
  // 中栏默认停在「成稿」，`.gzs-phone` 只有切到「手机预览」才存在；
  // 判单篇是否进来应看三栏容器，而不是某一个可切换的舞台。
  await page.waitFor(`document.querySelector(".gzs-body")`, "单篇", 30000);
  await new Promise((r) => setTimeout(r, 1200));
  // 流水线区在右栏「证据」页签。非当前页签只 hidden、不卸载；不先切页签，
  // querySelector 能读到文字，但几何是 0×0，会制造「DOM 有、用户点不到」的假通过。
  await page.clickText("证据", ".gzs-itab");
  await new Promise((r) => setTimeout(r, 300));

  const before = await readPipe();
  // 未绑定期号时，面板给的是**按内容完整度的粗略五档**（有标题/有正文/有封面/…），
  // 而不是一句「还没绑期号」——小白写文章不该先填绝对路径。
  // 判据落在「给了粗略进度 + 有个不吓人的接入口」上，而不是某一句旧文案还在不在。
  record("绑之前给的是粗略进度，不是流水线术语",
    !before.bound && before.loose && /粗略估计/.test(before.ep),
    `bound=${before.bound} loose=${before.loose} ep=${before.ep}`);
  record("绑之前给了「接上产线」入口，不用先懂期号",
    /接上产线/.test(before.body),
    before.body.slice(0, 60));
  await page.screenshot(`${SHOT_DIR}/09-pipe-unbound.png`);

  // ── 绑定 ────────────────────────────────────────────────────────────────
  const bindRes = await call("/api/gzh-studio.save", { id: ARTICLE, patch: { pipeline: { episodeId: EPISODE, root: ROOT } } });
  record("绑定接口返回 200", bindRes.status === 200, `HTTP ${bindRes.status}`);
  bound = bindRes.status === 200;
  // 让界面重读（等价于点「刷新」，但绑定后首屏还没拉过新状态）
  await page.evaluate(`(async () => { const r = await document.querySelectorAll(".gzs-col--right .gzs-btn"); return r.length; })()`);
  await page.reload?.();
  await page.navigate(url);
  await page.waitFor("!document.body.innerText.includes('Loading plugins')", "重载完", 90000);
  await new Promise((r) => setTimeout(r, 1500));
  await openStudio();
  await ensureHome();
  // state 接口还会逐篇补流水线摘要；卡片先出现、徽标后出现是正常时序。
  // 等到指定演示文章和它的徽标都真正渲染出来，再做几何断言。
  // 真实宿主偶尔会在刚 reload 后给出一轮旧快照；若 12 秒内没看到绑定态，
  // 完整重进一次面板再等，而不是拿旧首页继续往下判。
  const boundHomeReady = async (timeout) => {
    await page.waitFor(
      `[...document.querySelectorAll(".gzs-card__title")].some((node) => (node.textContent || "").includes("一家药企"))
        && Boolean(document.querySelector(".gzs-card__badge"))`,
      "演示文章与绑定状态徽标",
      timeout,
    );
  };
  try {
    await boundHomeReady(12000);
  } catch {
    await page.navigate(url);
    await page.waitFor("!document.body.innerText.includes('Loading plugins')", "二次重载完", 90000);
    await openStudio();
    await ensureHome();
    await boundHomeReady(30000);
  }
  await new Promise((r) => setTimeout(r, 300));

  // 首页卡片上应当有状态徽标。
  // **必须查它真的在卡片里看得见**：只判「存在」不够——徽标是 absolute 定位，
  // 一旦父容器没 relative，它会跑到视口左上角被侧栏盖住，`querySelector` 照样找得到。
  const badge = await page.evaluate(`(() => {
    const b = document.querySelector(".gzs-card__badge");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const card = b.closest(".gzs-card")?.getBoundingClientRect();
    const thumb = b.closest(".gzs-card__thumb")?.getBoundingClientRect();
    const style = getComputedStyle(b);
    return {
      text: b.textContent.trim(),
      w: Math.round(r.width), h: Math.round(r.height),
      visible: r.width > 0 && r.height > 0,
      inCard: Boolean(card) && r.left >= card.left - 1 && r.right <= card.right + 1 && r.top >= card.top - 1 && r.bottom <= card.bottom + 1,
      inThumb: Boolean(thumb) && r.top >= thumb.top - 1 && r.top <= thumb.bottom,
      onScreen: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth + 1,
      opacity: Number(style.opacity ?? 1),
      zIndex: style.zIndex,
    };
  })()`);
  record("首页卡片显示状态徽标", Boolean(badge), badge ? `「${badge.text}」` : "没有徽标");
  if (badge) {
    record("徽标是人话不是状态词", /^[\u4e00-\u9fa5]{2,6}$/.test(badge.text), `「${badge.text}」`);
    record("徽标真的有尺寸（不是 0×0）", badge.visible && badge.w > 20 && badge.h > 10, `${badge.w}×${badge.h}`);
    record("徽标在卡片范围内（父容器定位正确）", badge.inCard, badge.inCard ? "在卡片内" : "跑出卡片了——父容器缺 position:relative");
    record("徽标压在封面上", badge.inThumb, badge.inThumb ? "在封面区" : "不在封面区");
    record("徽标在视口内", badge.onScreen, badge.onScreen ? "可见" : "被挤出视口");
    record("徽标不透明", badge.opacity > 0.9, `opacity ${badge.opacity}`);
  }
  await page.screenshot(`${SHOT_DIR}/10-home-badge.png`);

  await page.clickText("一家药企", ".gzs-card__title");
  // 中栏默认停在「成稿」，`.gzs-phone` 只有切到「手机预览」才存在；
  // 判单篇是否进来应看三栏容器，而不是某一个可切换的舞台。
  await page.waitFor(`document.querySelector(".gzs-body")`, "单篇", 30000);
  await new Promise((r) => setTimeout(r, 1600));
  await page.clickText("证据", ".gzs-itab");
  await new Promise((r) => setTimeout(r, 300));

  const pipe = await readPipe();
  record("绑定后显示状态区", pipe.bound, pipe.bound ? "有" : "没有");
  if (pipe.bound) {
    record("状态词翻成人话", /^[\u4e00-\u9fa5]{2,6}$/.test(pipe.word), `「${pipe.word}」`);
    record("状态词原文留在 title", pipe.wordTitle.length > 0, pipe.wordTitle);
    record("显示期号与期数", pipe.ep.includes(EPISODE), pipe.ep);
    record("给了一句人话的下一步说明", pipe.hint.length > 8, pipe.hint.slice(0, 40));
    // 「下一步」必须落在人话上，**不能是 `07-deai` 这种代码**——面板上不该出现路径。
    // 同时它要指得出是哪一段（进度条上第一个未完成的节点编号与它一致），
    // 否则「下一步」就是一句没有落点的空话。
    record("下一步是人话，不是代码", !/\d{2}-[a-z]+/.test(pipe.next) && /[\u4e00-\u9fa5]/.test(pipe.next), pipe.next);
    record("下一步能对上进度条上的某一段", Boolean(pipe.nextNode), `next=${pipe.next} / 节点=${pipe.nextNode || "无"}`);
    record("如实报「判据不可用」项数", /项判据不可用/.test(pipe.unknownLine) || pipe.unknownLine === "", pipe.unknownLine || "无（全部判据可用）");
  }
  await page.screenshot(`${SHOT_DIR}/11-pipe-bound.png`);

  // 侧栏只留进度概览：11 段细色带，没有 chips（chips 在治理视图的宽版观测台里）
  const mini = await page.evaluate(`(() => ({
    segs: document.querySelectorAll(".gzs-mini").length,
    chips: document.querySelectorAll(".gzs-node").length,
    obsBtn: [...document.querySelectorAll(".gzs-pipe .gzs-btn")].some((b) => b.textContent.includes("看观测")),
  }))()`);
  record("侧栏是进度概览不是 chip 墙", mini.segs === 10 && mini.chips === 0, `${mini.segs} 段 / ${mini.chips} chips`);
  record("侧栏给了去观测台的入口", mini.obsBtn, mini.obsBtn ? "有「看观测」" : "没有");

  // 进度概览必须真的反映状态：有完成的段，也有「无判据」的段
  const segStates = await page.evaluate(`(() => {
    const all = [...document.querySelectorAll(".gzs-mini")];
    return { done: all.filter((e) => e.className.includes("--done")).length,
      skip: all.filter((e) => e.className.includes("--skip")).length };
  })()`);
  record("进度概览有完成段", segStates.done > 5, `完成 ${segStates.done} 段`);
  record("无判据的段单独着色", segStates.skip >= 1, `无判据 ${segStates.skip} 段`);

  // 十道门在治理视图里看。右栏本身可滚动，前面读取了整块状态后按钮可能已经在
  // 可视区外；先滚进视口再派发真鼠标事件，不能把「DOM 里有」误当成「人点得到」。
  const obsButton = await page.evaluate(`(() => {
    const btn = [...document.querySelectorAll(".gzs-pipe .gzs-btn")]
      .find((node) => (node.textContent || "").includes("看观测"));
    btn?.scrollIntoView({ block: "center", inline: "nearest" });
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { text: btn.textContent.trim(), x: r.left, y: r.top, w: r.width, h: r.height,
      display: getComputedStyle(btn).display, visibility: getComputedStyle(btn).visibility };
  })()`);
  record("观测台入口真的可见可点", Boolean(obsButton && obsButton.w > 0 && obsButton.h > 0),
    JSON.stringify(obsButton));
  await new Promise((r) => setTimeout(r, 300));
  if (obsButton?.w > 0 && obsButton?.h > 0) await page.clickText("看观测", ".gzs-btn");
  await new Promise((r) => setTimeout(r, 1600));
  const gates = await page.evaluate(`(() => {
    const rows = [...document.querySelectorAll(".gzs-gate")];
    return {
      count: rows.length,
      states: rows.map((r) => (r.className.match(/gzs-gate--(\\w+)/) || [])[1]),
      details: rows.map((r) => (r.querySelector(".gzs-gate__detail")?.textContent || "").trim()),
      overflow: rows.filter((r) => {
        const rect = r.getBoundingClientRect();
        const box = document.querySelector(".gzs-col--right").getBoundingClientRect();
        return rect.right > box.right + 1;
      }).length,
    };
  })()`);
  record("观测台里节点条排开", await page.evaluate(`document.querySelectorAll(".gzs-node").length`) === 10, "10 个节点");
  record("观测台里有事实核对", await page.evaluate(`document.querySelectorAll(".gzs-fact").length`) === 6, "6 项");
  record("每行都有结论", gates.states.every((s) => Boolean(s)), gates.states.join(","));
  record("每行都有证据说明", gates.details.every((d) => d.length > 0), `空行 ${gates.details.filter((d) => !d).length}`);
  record("门禁行不越出右栏", gates.overflow === 0, `越界 ${gates.overflow}`);
  await page.screenshot(`${SHOT_DIR}/12-pipe-gates.png`);

  const health = await page.evaluate(`(() => {
    const root = document.querySelector(".gzs-root");
    const bad = [];
    for (const el of root.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        if (r.right > window.innerWidth + 2) bad.push((el.className || el.tagName) + ":" + Math.round(r.right));
      }
    }
    return { bad: bad.slice(0, 4), total: bad.length };
  })()`);
  record("绑定后无元素越出视口", health.total === 0, health.bad.join(" | "));
} finally {
  // ── 一定解绑：演示文章绑真实期号只是验证界面，不能留下错配 ──────────────
  if (bound) {
    const res = await call("/api/gzh-studio.save", { id: ARTICLE, patch: { pipeline: { episodeId: "", root: "" } } }).catch(() => null);
    const after = await call(`/api/gzh-studio.pipeline?id=${ARTICLE}`, null).catch(() => null);
    let ok = false;
    try {
      ok = JSON.parse(after?.text ?? "{}").bound === false;
    } catch {
      ok = false;
    }
    record("结尾已解绑还原", res?.status === 200 && ok, ok ? "bound=false" : "解绑可能没生效，需人工确认");
  }
  if (typeof page.close === "function") await page.close();
  if (chrome.child) chrome.child.kill();
}

const failed = steps.filter((s) => !s.ok);
console.log(`\n截图：${SHOT_DIR}`);
console.log(`live-pipeline: ${failed.length ? `FAIL（${failed.length} 项）` : `OK（${steps.length} 项）`}`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exit(1);
}

