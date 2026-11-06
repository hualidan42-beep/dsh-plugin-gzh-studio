/**
 * 真实 UI 验收：无头 Chrome 打开 3080 → 点进「新媒体工作台」→ 首页 / 单篇 / 治理 / 新建 / 导出 全走一遍。
 *
 * 立场是**挑错**：每步记「期望 / 实际」，出错继续往下跑，一次收集全部问题。
 * 不做破坏性操作——新建流程点了「取消」，不往你的文章库里塞测试数据。
 *
 * 用法：node verify/live-ui.mjs <token>
 */
import { launch, attach } from "./cdp.mjs";
import { mkdir } from "node:fs/promises";

const TOKEN = process.argv[2];
if (!TOKEN) {
  console.error("用法：node verify/live-ui.mjs <token>");
  process.exit(1);
}
const SHOT_DIR = "D:/work/skill/plugins/dsh-plugin-gzh-studio/verify/shots";
await mkdir(SHOT_DIR, { recursive: true });

const steps = [];
const problems = [];
const record = (name, ok, detail = "") => {
  steps.push({ name, ok, detail });
  if (!ok) problems.push(`${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const url = `http://127.0.0.1:3080/?token=${TOKEN}`;
const chrome = await launch({ port: 9334, url, width: 1680, height: 1000 });
const page = await attach(chrome.port);

/**
 * 一次读全：当前是哪个视图、各区域的元素数、以及「看起来会出问题」的几何特征。
 * 几何检查是**通用**的（越界 / 重叠 / 空盒子），不依赖具体设计稿。
 */
const snapshot = () =>
  page.evaluate(`(() => {
    const root = document.querySelector(".gzs-root");
    if (!root) return { mounted: false };
    const n = (sel) => document.querySelectorAll(sel).length;
    const t = (sel) => (document.querySelector(sel)?.textContent || "").trim().replace(/\\s+/g, " ");
    const screen = n(".gzs-home") ? "home" : (n(".gzs-gov") ? "governance" : (n(".gzs-body") ? "article" : "other"));
    const rr = root.getBoundingClientRect();

    // 越界：子元素跑出面板可视区域
    const overflow = [];
    // 重叠：同一行内两个兄弟块相交（只看明确可能的：卡片、按钮、面板）
    const boxes = [...root.querySelectorAll(".gzs-card,.gzs-btn,.gzs-panel,.gzs-ver,.gzs-item,.gzs-col")].map((el) => {
      const r = el.getBoundingClientRect();
      return { cls: String(el.className).split(" ")[0], r };
    });
    for (const b of boxes) {
      if (b.r.width > 0 && (b.r.right > rr.right + 2 || b.r.left < rr.left - 2)) {
        overflow.push(b.cls + "@" + Math.round(b.r.left) + ".." + Math.round(b.r.right));
      }
    }
    // 文字被裁（scrollWidth 明显大于 clientWidth，且没设省略号）
    const clipped = [];
    for (const el of root.querySelectorAll(".gzs-title,.gzs-card__title,.gzs-item__name,.gzs-ver__meta,.gzs-panel__head")) {
      if (el.scrollWidth > el.clientWidth + 3) {
        const ell = getComputedStyle(el).textOverflow === "ellipsis";
        if (!ell) clipped.push(String(el.className).split(" ")[0] + ":" + (el.textContent || "").trim().slice(0, 14));
      }
    }
    return {
      mounted: true,
      screen,
      title: t(".gzs-title"),
      headText: t(".gzs-head"),
      cards: n(".gzs-card"),
      cols: n(".gzs-col"),
      items: n(".gzs-item"),
      versions: n(".gzs-ver"),
      qa: n(".gzs-qa"),
      ledgerRows: n(".gzs-ledger__row"),
      panels: n(".gzs-panel"),
      empty: n(".gzs-empty"),
      buttons: [...document.querySelectorAll(".gzs-btn")].map((b) => b.textContent.trim()).filter(Boolean),
      size: [Math.round(rr.width), Math.round(rr.height)],
      overflow: overflow.slice(0, 6),
      clipped: clipped.slice(0, 6),
      toast: t(".gzs-toast"),
    };
  })()`);

/** 图片解码检查：只查 <img>，背景图另外查。 */
const imageHealth = () =>
  page.evaluate(`(() => {
    const imgs = [...document.querySelectorAll(".gzs-root img")].map((i) => ({
      w: i.naturalWidth, h: i.naturalHeight, src: (i.currentSrc || i.src || "").split("/").pop(),
    }));
    const bg = [...document.querySelectorAll(".gzs-card__thumb")].map((el) => {
      const v = getComputedStyle(el).backgroundImage || "";
      return v.includes("url(") ? "has-url" : "none";
    });
    return { imgs, bg };
  })()`);

try {
  // ── 0. 打开应用 + 从侧栏进工作台 ──────────────────────────────────────
  await page.navigate(url);
  // 不能等 innerText：这一版 GUI 把侧栏的面板列表默认收成 display:none，
  // 隐藏文本不会进 innerText，于是「侧栏出现」会一直假失败（按钮其实早在 DOM 里）。
  // 所以等按钮本身——只看 textContent，不看可见性。
  await page.waitFor(
    `[...document.querySelectorAll("button")].some((b) => (b.textContent || "").includes("新媒体工作台"))`,
    "侧栏「新媒体工作台」按钮出现",
    90000,
  );
  await new Promise((r) => setTimeout(r, 1200));
  // 面板列表是零尺寸，坐标点不了，直接调 click()：React 的委托监听照样收得到。
  // 点击失败时把现场的按钮文案打出来，免得只看到一句「点不到」。
  const clicked = await page.evaluate(`(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("新媒体工作台"));
    if (!btn) return { ok: false, buttons: [...document.querySelectorAll("button")].map((b) => (b.textContent || "").trim()).filter(Boolean).slice(0, 40) };
    btn.click();
    return { ok: true, text: (btn.textContent || "").trim() };
  })()`);
  if (!clicked.ok) throw new Error(`侧栏没有「新媒体工作台」入口；现有按钮：${clicked.buttons.join(" / ")}`);
  await page.waitFor('document.querySelector(".gzs-root")', "工作台挂载", 30000);
  // 挂上不等于数据到了：等首屏真正画完（卡片 / 三栏 / 治理面板 / 明确的空态）
  const settle = (label) =>
    page.waitFor(
      `(document.querySelector(".gzs-card") || document.querySelector(".gzs-body") || document.querySelector(".gzs-gov")
        || (document.querySelector(".gzs-empty") && !document.querySelector(".gzs-empty").textContent.includes("读取中")))`,
      label,
      30000,
    );
  await settle("首屏数据到位");
  await new Promise((r) => setTimeout(r, 600));
  record("侧栏能点开工作台", true);

  // 卡在「读取中」就是真问题，单独记一笔
  const stuck = await page.evaluate(`Boolean((document.querySelector(".gzs-empty")?.textContent || "").includes("读取中"))`);
  record("首屏不会卡在加载态", !stuck, stuck ? "1.5s+ 后仍在「读取中…」" : "");

  // ── 0b. 左栏原生对话：必须是**本工作台自己的**会话 ──────────────────────
  // 用户原话：「我既然用了这新媒体工作台，那原生对话里显示的也应该是当前这个
  // 公众号文章的内容，如果当前没有内容，那应该是崭新的对话框。」
  // 老做法是同源 iframe `/?gzhChat=1`：它是另一个完整的 Web 应用，按
  // `dsh.sessions.current` 恢复「上次看的那条会话」，于是工作台里显示别人的对话。
  const chatMounted = await page
    .waitFor(`document.querySelector('.gzs-chatcol [data-conversation-content]')`, "左栏对话内容", 30000)
    .catch(() => false);
  const chat = await page.evaluate(`(() => {
    const col = document.querySelector(".gzs-chatcol");
    const content = document.querySelector('[data-conversation-content]');
    let bound = null;
    let outer = null;
    try { bound = JSON.parse(localStorage.getItem("gzh-studio.chat.session.v1.article") || "null"); } catch {}
    try { outer = JSON.parse(localStorage.getItem("dsh.sessions.current") || "null"); } catch {}
    return {
      hasCol: Boolean(col),
      iframes: document.querySelectorAll(".gzs-root iframe").length,
      sessionId: (content && content.getAttribute("data-conversation-session")) || "",
      phase: (content && content.getAttribute("data-content-phase")) || "",
      composer: document.querySelectorAll('.gzs-chatcol [data-lexical-editor="true"]').length,
      note: (document.querySelector(".gzs-chatnote") || {}).textContent || "",
      bound,
      outer: outer && outer.sessionId ? outer.sessionId : "",
      bodyText: ((document.querySelector(".gzs-chatbody") || {}).innerText || "").slice(0, 160).replace(/\\s+/g, " "),
    };
  })()`);
  record("左栏是会话内嵌，不是 iframe", chat.iframes === 0 && chat.hasCol, `iframe ${chat.iframes} 个`);
  record("左栏渲染出原生对话", chatMounted === true && Boolean(chat.sessionId), `会话 ${chat.sessionId || "（无）"} 提示「${chat.note}」`);
  record("左栏对话绑定的就是本工作台的会话", Boolean(chat.bound && chat.bound.sessionId === chat.sessionId),
    `绑定 ${chat.bound && chat.bound.sessionId} / 渲染 ${chat.sessionId}`);
  // 这一条直指用户的抱怨：不能是宿主当前选中的那条（那通常是别人的任务）
  record("左栏显示的不是宿主当前那条会话", Boolean(chat.sessionId) && chat.sessionId !== chat.outer,
    `工作台 ${chat.sessionId} / 宿主当前 ${chat.outer || "（无）"}`);
  record("对话工作目录是产线根，不是插件数据目录", Boolean(chat.bound && chat.bound.repoRoot) && !/\.dsh[\\\\/]gzh-studio/i.test(chat.bound.repoRoot),
    `cwd ${chat.bound && chat.bound.repoRoot}`);
  record("空会话给的是崭新对话框", chat.phase === "hero" || chat.phase === "active",
    `phase=${chat.phase}「${chat.bodyText}」`);
  record("左栏有输入框（能直接说话）", chat.composer >= 1, `contenteditable ${chat.composer} 个`);

  // 收起再打开：引用一旦被释放，宿主会判整个主区崩掉（slot entry crashed in 'main'），
  // 面板整块消失——这条是那次事故的回归。
  const chatSessionBefore = chat.sessionId;
  await page.clickText("×", ".gzs-chatcol__x");
  await new Promise((r) => setTimeout(r, 700));
  const folded = await page.evaluate(`Boolean(document.querySelector(".gzs-chatcol"))`);
  await page.clickText("▢ 对话", ".gzs-chattoggle");
  await new Promise((r) => setTimeout(r, 1500));
  const reopened = await page.evaluate(`(() => ({
    panel: Boolean(document.querySelector(".gzs-root")),
    col: Boolean(document.querySelector(".gzs-chatcol")),
    sessionId: (document.querySelector('[data-conversation-content]') || {}).getAttribute?.("data-conversation-session") || "",
  }))()`);
  record("收起对话后左栏消失", folded === false, `folded=${folded}`);
  record("再打开不崩、还是同一条会话", reopened.panel && reopened.col && reopened.sessionId === chatSessionBefore,
    `面板 ${reopened.panel} 左栏 ${reopened.col} 会话 ${reopened.sessionId}（原 ${chatSessionBefore}）`);

  // ── 1. 首屏 ────────────────────────────────────────────────────────────
  // 初值是 article：打开面板直接落到最近一篇的三栏（和「历史工作台」一致），
  // 不给一个首页让人再点一次。所以这里查的是「有没有被塞进错的篇 / 三栏有没有被挤坏」，
  // 「首页」放到 1b 里查——首页不是首屏，但必须一点就到。
  let s = await snapshot();
  record("首屏落到最近一篇的三栏", s.screen === "article" && s.cols >= 3, `screen=${s.screen} 栏 ${s.cols}`);
  record("顶栏不重复篇数", (s.headText.match(/篇/g) || []).length <= 1, `顶栏文案「${s.headText}」`);
  record("首屏无越界元素", s.overflow.length === 0, s.overflow.join(" | "));
  record("首屏无文字被裁", s.clipped.length === 0, s.clipped.join(" | "));
  await page.screenshot(`${SHOT_DIR}/01-first-screen.png`);

  // ── 1a. 回首页：顶栏「全部文章」必须一点就到 ────────────────────────────
  await page.clickText("全部文章", ".gzs-btn");
  await new Promise((r) => setTimeout(r, 1400));
  s = await snapshot();
  record("顶栏「全部文章」能回首页", s.screen === "home", `screen=${s.screen}`);
  record("首页有文章卡 + 新建卡", s.cards >= 2, `卡片 ${s.cards}`);
  record("首页无越界元素", s.overflow.length === 0, s.overflow.join(" | "));
  record("首页无文字被裁", s.clipped.length === 0, s.clipped.join(" | "));
  let health = await imageHealth();
  record("首页封面图解码成功", health.bg.every((b) => b === "has-url"), JSON.stringify(health.bg));
  await page.screenshot(`${SHOT_DIR}/01-home.png`);

  // ── 1b. 最近动作 ──────────────────────────────────────────────────────
  const feed = await page.evaluate(`(() => {
    const panel = document.querySelector(".gzs-actpanel");
    if (!panel) return null;
    const rows = [...panel.querySelectorAll(".gzs-act")];
    return {
      head: (panel.querySelector(".gzs-panel__head")?.textContent || "").trim().replace(/\\s+/g, " "),
      rows: rows.length,
      first: (rows[0]?.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 70),
      cols: !!document.querySelector(".gzs-homecols"),
    };
  })()`);
  record("首页有「最近动作」栏", Boolean(feed) && feed.rows > 0, feed ? `${feed.rows} 条 · ${feed.first}` : "找不到 .gzs-actpanel");
  if (feed) {
    // 时间要说人话：刚刚 / 今天 / 昨天 / 3 天前 / 10-26 都算，别只认「前」字
    record("最近动作带条数与时间",
      /条/.test(feed.head) && /(刚刚|今天|昨天|前天|\d+\s*(天|小时|分钟)前|\d{1,2}[-/月]\d{1,2})/.test(feed.first),
      `${feed.head} / ${feed.first.slice(0, 24)}`);
    // 点一条动作能进那篇文章
    await page.clickNth(".gzs-act", 0);
    await new Promise((r) => setTimeout(r, 1400));
    const jumped = await page.evaluate(`Boolean(document.querySelector(".gzs-body"))`);
    record("点最近动作能进文章", jumped, jumped ? "" : "点了没进单篇");
    await page.screenshot(`${SHOT_DIR}/01b-activity.png`);
    if (jumped) {
      // 回首页的按钮在顶栏，文案是「全部文章」（不是「← 全部」）
      await page.clickText("全部文章", ".gzs-btn");
      await new Promise((r) => setTimeout(r, 1400));
    }
  }

  // ── 2. 进单篇 ──────────────────────────────────────────────────────────
  await page.clickText("一家药企把审批从 14 天压到 3 天", ".gzs-card__title");
  await new Promise((r) => setTimeout(r, 1400));
  s = await snapshot();
  record("点卡片进单篇", s.screen === "article", `screen=${s.screen}`);
  record("单篇是三栏", s.cols >= 3, `栏数 ${s.cols}`);
  record("左栏列出段落", s.items >= 5, `条目 ${s.items}`);
  // 版本条只在选中某个槽位时出现：「整篇」下不该有，选中封面后才该有
  record("整篇视图不显示版本条", s.versions === 0, `版本 ${s.versions}`);
  record("右栏有 QA 条目", s.qa >= 1, `QA ${s.qa}`);

  // ── 流水线状态：先判状态、再看内容 ────────────────────────────────────────
  {
    const pipe = await page.evaluate(`(() => {
      const block = document.querySelector(".gzs-pipe");
      if (!block) {
        // 未绑定时应当是「绑定期号」的表单，而不是空白或假装有状态
        const hint = document.body.innerText.includes("还没绑期号");
        const inputs = document.querySelectorAll(".gzs-col--right .gzs-input, .gzs-col--right .gzs-area").length;
        return { bound: false, hint, inputs };
      }
      // 两种模式都带 gzs-pipe 这个类：绑了期号是精确状态，没绑是粗略进度。
      // 靠「粗略估计」这个标记区分——不能只看容器类名，否则未绑定会被当成已绑定，
      // 后面的「十道门」断言全跑在错的模式上。
      const rough = (block.querySelector(".gzs-pipe__ep")?.textContent || "").includes("粗略估计");
      return {
        bound: !rough,
        rough,
        roughSteps: [...block.querySelectorAll(".gzs-step")].map((e) => e.textContent.trim()),
        word: (block.querySelector(".gzs-pipe__word")?.textContent || "").trim(),
        ep: (block.querySelector(".gzs-pipe__ep")?.textContent || "").trim(),
        hint: (block.querySelector(".gzs-pipe__hint")?.textContent || "").trim(),
        block: (block.querySelector(".gzs-pipe__block")?.textContent || "").trim(),
        gates: block.querySelectorAll(".gzs-gate").length,
        next: (block.textContent.match(/下一步：\\S+/) || [""])[0],
      };
    })()`);
    record("右栏有流水线状态区", Boolean(pipe?.word || pipe?.hint), pipe?.word ? "「" + pipe.word + "」" : "未绑定");
    // 没绑期号时给的是**粗略进度**（五档），不假装知道「第几道门」
    if (pipe.rough) {
      record("未绑定也给进度（粗略）", pipe.roughSteps.length === 5, "五档：" + pipe.roughSteps.join(" / "));
      record("粗略进度标明是估的", pipe.rough === true, "标了「粗略估计」");
      record("粗略进度不编造精确步号", !/\d{2}-[a-z]/.test(pipe.hint), pipe.hint.slice(0, 30));
    }
    if (pipe.bound) {
      record("状态词翻成了人话（≤6 字）", pipe.word.length > 0 && pipe.word.length <= 6, `「${pipe.word}」`);
      record("状态给了下一步", /下一步：\S+/.test(pipe.next), pipe.next);
      record("状态没把证据全摊开（默认收起）", pipe.gates === 0, `门禁行 ${pipe.gates}`);
      // 展开证据：十道门一条不少
      await page.clickText("看证据", ".gzs-pipe .gzs-btn");
      await new Promise((r) => setTimeout(r, 700));
      const open = await page.evaluate(`(() => {
        const gates = [...document.querySelectorAll(".gzs-gate")];
        return {
          count: gates.length,
          nos: gates.map((g) => (g.querySelector(".gzs-gate__no")?.textContent || "").trim()),
          marks: gates.map((g) => (g.querySelector(".gzs-gate__mark")?.textContent || "").trim()),
          clip: gates.filter((g) => {
            const d = g.querySelector(".gzs-gate__detail");
            return d && d.scrollWidth > d.clientWidth + 2;
          }).length,
          emptyDetail: gates.filter((g) => !(g.querySelector(".gzs-gate__detail")?.textContent || "").trim()).length,
        };
      })()`);
      record("展开后有十道门", open.count === 10, `门禁行 ${open.count}`);
      record("每道门都有结论符号", open.marks.filter((m) => /[✓✕!?–]/.test(m)).length === open.count, open.marks.join(""));
      record("每道门都有说明（不留空证据）", open.emptyDetail === 0, `空说明 ${open.emptyDetail}`);
      record("门禁编号是 01–10 齐全", new Set(open.nos).size === 10, open.nos.join(","));
      // 说明可以省略号截断（title 里有全文），但不能把整行挤到看不见
      record("门禁说明不被整行裁掉", open.clip === 0, `被裁 ${open.clip} 行`);
      await page.clickText("收起证据", ".gzs-pipe .gzs-btn");
      await new Promise((r) => setTimeout(r, 500));
      const closed = await page.evaluate(`document.querySelectorAll(".gzs-gate").length`);
      record("证据能收起", closed === 0, `收起后 ${closed} 行`);
    }
  }

  await page.clickText("首图", ".gzs-item__name");
  await new Promise((r) => setTimeout(r, 900));
  const cover = await snapshot();
  record("选中封面后有版本条", cover.versions >= 4, `版本 ${cover.versions}`);
  s = cover;
  record("单篇无越界元素", s.overflow.length === 0, s.overflow.join(" | "));
  record("单篇无文字被裁", s.clipped.length === 0, s.clipped.join(" | "));
  health = await imageHealth();
  record("手机预览里的图解码成功", health.imgs.length > 0 && health.imgs.every((i) => i.w > 0), JSON.stringify(health.imgs.slice(0, 3)));
  await page.screenshot(`${SHOT_DIR}/02-article.png`);

  // 选中一段，看检查器是否跟着换
  const before = await page.evaluate(`(document.querySelector(".gzs-col--right")?.textContent || "").slice(0, 60)`);
  await page.clickText("坑一：以为流程是画出来的", ".gzs-item__name");
  await new Promise((r) => setTimeout(r, 900));
  const after = await page.evaluate(`(document.querySelector(".gzs-col--right")?.textContent || "").slice(0, 60)`);
  record("点段落切换检查器", before !== after, `前「${before.slice(0, 24)}」后「${after.slice(0, 24)}」`);
  await page.screenshot(`${SHOT_DIR}/03-section.png`);

  // ── 3. 治理 ────────────────────────────────────────────────────────────
  const hasGov = await page.evaluate(`Boolean([...document.querySelectorAll(".gzs-btn")].find((b) => b.textContent.trim() === "治理"))`);
  record("单篇里有「治理」入口", hasGov);
  if (hasGov) {
    await page.clickText("治理", ".gzs-btn");
    await new Promise((r) => setTimeout(r, 1200));
    s = await snapshot();
    record("治理视图渲染", s.screen === "governance", `screen=${s.screen}`);
    record("治理视图有面板", s.panels >= 2, `面板 ${s.panels}`);
    record("治理视图有 QA 条目", s.qa >= 1, `QA ${s.qa}`);
    record("治理视图有账本", s.ledgerRows >= 1, `账本行 ${s.ledgerRows}`);
    record("治理视图无越界元素", s.overflow.length === 0, s.overflow.join(" | "));
    record("治理视图无文字被裁", s.clipped.length === 0, s.clipped.join(" | "));
    // 去 AI 味面板必须**在治理视图里看得见**。这条是本轮重点：
    // 功能做完但藏在折叠里，等于没做——用户不会去展开一个他不知道存在的东西。
    const deai = await page.evaluate(`(() => {
      const panel = [...document.querySelectorAll(".gzs-panel")].find((p) =>
        (p.querySelector(".gzs-panel__head")?.textContent || "").includes("去 AI 味"));
      if (!panel) return { found: false };
      const r = panel.getBoundingClientRect();
      const rows = panel.querySelectorAll(".gzs-deai__row").length;
      const acts = panel.querySelector(".gzs-deai__acts");
      return {
        found: true,
        rows,
        hasActs: Boolean(acts),
        visible: r.width > 100 && r.height > 40,
        inViewport: r.top < window.innerHeight && r.bottom > 0,
        text: (panel.querySelector(".gzs-panel__body")?.textContent || "").slice(0, 80),
      };
    })()`);
    record("治理视图有「去 AI 味」面板", deai.found);
    record("去 AI 味面板有尺寸（不是 0 高）", deai.visible, JSON.stringify(deai));
    record("去 AI 味面板报出结论", Boolean(deai.text && deai.text.length > 4), deai.text);

    // 05/06 清单：16 条验收项必须真的画出来，而且要能点。
    // 这条是本轮加的「逐项确认」——面板上没有这 16 行，功能就等于没做。
    const rev = await page.evaluate(`(() => {
      const panel = [...document.querySelectorAll(".gzs-panel")].find((p) =>
        (p.querySelector(".gzs-panel__head")?.textContent || "").includes("编辑审"));
      if (!panel) return { found: false };
      const rows = [...panel.querySelectorAll(".gzs-rev__item")];
      const r = panel.getBoundingClientRect();
      return {
        found: true,
        rows: rows.length,
        clickable: rows.filter((x) => x.onclick !== null || true).length,
        visible: r.width > 100 && r.height > 40,
        progress: (panel.querySelector(".gzs-panel__head .gzs-badge")?.textContent || "").trim(),
        overflow: rows.filter((x) => {
          const rr = x.getBoundingClientRect();
          return rr.right > r.right + 1 || rr.left < r.left - 1;
        }).length,
      };
    })()`);
    record("治理视图有「编辑审·读者审」清单面板", rev.found);
    record("16 条验收项都渲染出来", rev.rows === 16, `实得 ${rev.rows} 行`);
    record("清单面板有尺寸", rev.visible, JSON.stringify(rev));
    record("清单进度徽标可读", /\d+\/16/.test(rev.progress || ""), rev.progress);
    record("清单行不越出面板", rev.overflow === 0, `越界 ${rev.overflow}`);

    // 点第一项：勾上之后应该变类（服务端存了，刷新也还在）
    const toggled = await page.evaluate(`(() => {
      const panel = [...document.querySelectorAll(".gzs-panel")].find((p) =>
        (p.querySelector(".gzs-panel__head")?.textContent || "").includes("编辑审"));
      const first = panel.querySelector(".gzs-rev__item");
      if (!first) return { ok: false };
      const before = first.className;
      first.click();
      return { ok: true, before };
    })()`);
    await new Promise((r) => setTimeout(r, 900));
    const afterToggle = await page.evaluate(`(() => {
      const panel = [...document.querySelectorAll(".gzs-panel")].find((p) =>
        (p.querySelector(".gzs-panel__head")?.textContent || "").includes("编辑审"));
      const items = [...panel.querySelectorAll(".gzs-rev__item")];
      return {
        on: items.filter((x) => x.className.includes("--on")).length,
        badge: (panel.querySelector(".gzs-panel__head .gzs-badge")?.textContent || "").trim(),
      };
    })()`);
    record("清单项能点（点完有视觉变化）", toggled.ok && afterToggle.on >= 1,
      `勾上 ${afterToggle.on} 项`);
    record("勾选后进度徽标跟着变", /\d+\/16/.test(afterToggle.badge || "") && afterToggle.badge !== rev.progress,
      `前 ${rev.progress} → 后 ${afterToggle.badge}`);
    // 撤回来，不给真实文章留测试数据
    await page.evaluate(`(() => {
      const panel = [...document.querySelectorAll(".gzs-panel")].find((p) =>
        (p.querySelector(".gzs-panel__head")?.textContent || "").includes("编辑审"));
      const on = panel.querySelector(".gzs-rev__item--on");
      on?.click();
    })()`);
    await new Promise((r) => setTimeout(r, 700));

    await page.screenshot(`${SHOT_DIR}/04b-deai.png`);
    await page.screenshot(`${SHOT_DIR}/04c-reviews.png`);

    // 出图前确认卡：这是决策 A 的落点。三条都要测到：
    // ① 点「出图」不许直接出图，必须先弹卡（否则用户不知道要花额度）；
    // ② 卡必须**在视口内**（这条踩过：卡在屏外，点完看不到任何变化）；
    // ③ 点「先不出」就真的不出。
    await page.clickText("← 编辑", ".gzs-btn");
    await new Promise((r) => setTimeout(r, 900));
    // 「出图」在检查器的「图」tab 里（新三栏把它和 prompt/版本收在一处），
    // 先切过去再点——不切的话只是在点一个 display:none 的按钮，量出来的卡永远是 0×0。
    await page.clickNth(".gzs-itab", 2);
    await new Promise((r) => setTimeout(r, 400));
    const confirmFlow = await page.evaluate(`(() => {
      const btn = [...document.querySelectorAll(".gzs-btn")].find((b) => b.textContent.trim() === "出图");
      if (!btn) return { found: false };
      btn.click();
      return { found: true };
    })()`);
    await new Promise((r) => setTimeout(r, 700));
    const card = await page.evaluate(`(() => {
      const el = document.querySelector(".gzs-confirm");
      if (!el) return { present: false };
      const r = el.getBoundingClientRect();
      const col = el.closest(".gzs-col--right");
      return {
        present: true,
        inViewport: r.top < window.innerHeight && r.bottom > 0 && r.top >= 0,
        mentionedQuota: /额度/.test(el.textContent || ""),
        mentionedFeedback: /反馈/.test(el.textContent || ""),
        buttons: [...el.querySelectorAll(".gzs-btn")].map((b) => b.textContent.trim()),
        scrolled: col ? Math.round(col.scrollTop) : null,
      };
    })()`);
    record("点出图先弹确认卡（不直接出图）", confirmFlow.found && card.present);
    record("确认卡在视口内（不是飘在屏外）", card.inViewport, JSON.stringify(card));
    record("确认卡说清会花额度", card.mentionedQuota);
    record("确认卡说清会带几条反馈", card.mentionedFeedback);
    record("确认卡有「确认」和「先不出」两个选择",
      (card.buttons || []).some((b) => /确认/.test(b)) && (card.buttons || []).some((b) => /先不出/.test(b)),
      (card.buttons || []).join(" / "));
    await page.screenshot(`${SHOT_DIR}/04d-confirm.png`);

    // 点「先不出」→ 卡消失，且不该出图（版本数不变）
    const beforeVers = await page.evaluate(`document.querySelectorAll(".gzs-ver").length`);
    await page.evaluate(`(() => {
      const el = document.querySelector(".gzs-confirm");
      [...el.querySelectorAll(".gzs-btn")].find((b) => /先不出/.test(b.textContent))?.click();
    })()`);
    await new Promise((r) => setTimeout(r, 800));
    const afterCancel = await page.evaluate(`({
      card: Boolean(document.querySelector(".gzs-confirm")),
      vers: document.querySelectorAll(".gzs-ver").length,
    })`);
    record("点「先不出」关掉卡", !afterCancel.card);
    record("点「先不出」真的没出图", afterCancel.vers === beforeVers, `版本 ${beforeVers} → ${afterCancel.vers}`);

    // 这一段开头已经点过「← 编辑」了，此刻就在文章视图。
    // 确认这一点而不是再点一次——再点会「点不到」（那个按钮在治理视图才有）。
    s = await snapshot();
    record("治理能回编辑", s.screen === "article", `screen=${s.screen}`);
  }

  // ── 4. 导出 ────────────────────────────────────────────────────────────
  const exportSeg = await page.evaluate(`(() => {
    const seg = document.querySelector(".gzs-seg");
    return seg ? [...seg.querySelectorAll(".gzs-btn")].map((b) => b.textContent.trim()) : null;
  })()`);
  const hasExport = Array.isArray(exportSeg) && exportSeg.length === 3;
  record("顶栏导出收成一组三档", hasExport, exportSeg ? exportSeg.join("/") : "找不到 .gzs-seg");
  if (hasExport) {
    await page.clickText("HTML", ".gzs-seg .gzs-btn");
    await new Promise((r) => setTimeout(r, 1800));
    s = await snapshot();
    record("导出有反馈（提示条）", Boolean(s.toast), `toast「${s.toast}」`);
  }

  // ── 5. 新建（点了取消，不留测试数据）──────────────────────────────────
  await page.clickText("全部", ".gzs-btn");
  await new Promise((r) => setTimeout(r, 1000));
  const newCard = await page.evaluate(`Boolean(document.querySelector(".gzs-card--new"))`);
  record("首页有「新建一篇」卡", newCard);
  if (newCard) {
    await page.clickText("新建一篇", ".gzs-card--new");
    await new Promise((r) => setTimeout(r, 1200));
    const form = await page.evaluate(`(() => {
      const inputs = [...document.querySelectorAll(".gzs-root input,.gzs-root textarea,.gzs-root select")];
      return { count: inputs.length, labels: inputs.map((i) => i.getAttribute("placeholder") || i.tagName).slice(0, 8) };
    })()`);
    record("新建表单出现", form.count >= 3, `输入项 ${form.count} 个：${form.labels.join("/")}`);
    await page.screenshot(`${SHOT_DIR}/05-new.png`);
    const hasCancel = await page.evaluate(`Boolean([...document.querySelectorAll(".gzs-btn")].find((b) => /取消/.test(b.textContent)))`);
    record("新建表单能取消", hasCancel);
    if (hasCancel) {
      await page.clickText("取消", ".gzs-btn");
      await new Promise((r) => setTimeout(r, 800));
      s = await snapshot();
      record("取消后回到首页", s.screen === "home", `screen=${s.screen}`);
    }
  }

  // ── 6. 宽窗口几何 + 窄窗口回归 ────────────────────────────────────────
  await page.clickText("一家药企把审批从 14 天压到 3 天", ".gzs-card__title");
  await new Promise((r) => setTimeout(r, 1200));
  // 手机预览现在是中栏的第二档（默认停在「成稿」），要量它得先切过去
  await page.clickText("手机预览", ".gzs-btn");
  await new Promise((r) => setTimeout(r, 700));

  // 几何体检：把关键块的实际尺寸打出来，供人判断「居不居中、宽窄合不合适」
  const geo = await page.evaluate(`(() => {
    const r = (sel) => { const el = document.querySelector(sel); if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.left), w: Math.round(b.width), h: Math.round(b.height), cx: Math.round(b.left + b.width / 2) }; };
    const mid = r(".gzs-col--mid"), phone = r(".gzs-phone");
    return {
      root: r(".gzs-root"), head: r(".gzs-head"), left: r(".gzs-col--left"), mid, right: r(".gzs-col--right"),
      phone, phoneOffset: mid && phone ? phone.cx - mid.cx : null,
    };
  })()`);
  console.log("几何（宽窗口）：", JSON.stringify(geo));
  record("手机预览在中间栏里居中", Math.abs(geo.phoneOffset ?? 99) <= 6, `偏移 ${geo.phoneOffset}px`);

  await page.send("Emulation.setDeviceMetricsOverride", { width: 1180, height: 820, deviceScaleFactor: 1, mobile: false });
  await new Promise((r) => setTimeout(r, 900));
  const narrow = await snapshot();
  record("窄窗口（1180）三栏仍在", narrow.cols >= 3, `栏数 ${narrow.cols}`);
  // 1180 的窗口里，宿主侧栏 280 + 插件对话列 440，工作区只剩约 453，
  // 而三栏最低要 200+250+427+14 = 891 —— 物理上放不下。这时正确的做法不是
  // 假装放得下（右栏被裁、按钮点不到），而是**明说**：能横向滚，并给一键收起对话。
  // 所以这里查的是「有没有说出来」，不是「有没有越界」。
  const tight = await page.evaluate(`(() => {
    const body = document.querySelector(".gzs-body");
    const hint = document.querySelector(".gzs-narrow");
    return {
      fits: body ? body.scrollWidth - body.clientWidth <= 2 : null,
      hint: hint ? (hint.textContent || "").trim() : "",
      overflowX: body ? getComputedStyle(body).overflowX : "",
      hasChat: Boolean(document.querySelector(".gzs-chatcol")),
    };
  })()`);
  record("窄窗口：放不下时必须明说（不静默藏栏）", tight.fits === true || Boolean(tight.hint),
    tight.fits ? "三栏放得下，无需提示" : `提示「${tight.hint}」`);
  record("窄窗口：放不下时仍能横向滚到底", tight.fits === true || tight.overflowX === "auto",
    `overflow-x=${tight.overflowX}`);
  record("窄窗口：提示里给了一键收起对话",
    tight.fits === true || !tight.hasChat || /收起对话/.test(tight.hint), tight.hint);
  if (!tight.fits && tight.hasChat) {
    // 点「收起对话」，工作区应该立刻变宽，右栏回到视野内
    await page.clickText("收起对话", ".gzs-narrow__b");
    await new Promise((r) => setTimeout(r, 900));
    const afterFold = await page.evaluate(`(() => {
      const body = document.querySelector(".gzs-body");
      return { fits: body ? body.scrollWidth - body.clientWidth <= 2 : null,
        chat: Boolean(document.querySelector(".gzs-chatcol")),
        hint: Boolean(document.querySelector(".gzs-narrow")) };
    })()`);
    record("点「收起对话」后三栏放得下", afterFold.fits === true && !afterFold.chat,
      `fits=${afterFold.fits} 对话列=${afterFold.chat} 提示=${afterFold.hint}`);
    record("放得下之后提示自动撤掉", afterFold.hint === false);
    // 收起来是为了验证，验完放回去：这条测试不改用户的习惯（对话列默认开着）
    await page.clickText("▢ 对话", ".gzs-chattoggle");
    await new Promise((r) => setTimeout(r, 900));
  }
  const geoN = await page.evaluate(`(() => {
    const r = (sel) => { const el = document.querySelector(sel); if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.left), w: Math.round(b.width), cx: Math.round(b.left + b.width / 2) }; };
    const box = r(".gzs-phonebox"), mid = r(".gzs-col--mid"), phone = r(".gzs-phone");
    const midEl = document.querySelector(".gzs-col--mid");
    return { mid, box, phone, scrollW: midEl ? midEl.scrollWidth : null, clientW: midEl ? midEl.clientWidth : null,
      offset: mid && phone ? phone.cx - mid.cx : null };
  })()`);
  console.log("几何（窄窗口）：", JSON.stringify(geoN));
  record("窄窗口手机完整可见（不横向裁切）", geoN.scrollW <= geoN.clientW + 2, `内容宽 ${geoN.scrollW} / 可视宽 ${geoN.clientW}`);
  record("窄窗口手机仍居中", Math.abs(geoN.offset ?? 99) <= 6, `偏移 ${geoN.offset}px`);
  await page.screenshot(`${SHOT_DIR}/06-narrow.png`);
  await page.send("Emulation.clearDeviceMetricsOverride");

  // ── 7. 控制台干净 ─────────────────────────────────────────────────────
  // 只算**本插件**的错：宿主自己的账号/会话探测失败（deepseek-account、Sidebar Session）
  // 跟工作台无关，混进来会让这条断言永远红着，久了就没人看。
  // `[dsh-skin]` 是另一个插件（主题与外观）内部报错，和工作台无关；
  // 它被并行改动时会出现 PET_SKINS 未定义，记在这里避免本套件替别人红。
  const HOST_NOISE = /\[deepseek-account\]|Sidebar Session opening failed|account read failed|\[dsh-skin\]/;
  const consoleErrors = page.events
    .filter((e) => e.method === "Runtime.consoleAPICalled" && e.params.type === "error")
    .map((e) => String(e.params.args?.[0]?.value ?? e.params.args?.[0]?.description ?? ""))
    .filter((text) => !HOST_NOISE.test(text));
  record("页面无 console.error", consoleErrors.length === 0,
    consoleErrors.map((t) => t.slice(0, 70)).join(" | "));
} catch (error) {
  record("流程中断", false, String(error?.message ?? error));
} finally {
  await page.screenshot(`${SHOT_DIR}/99-last.png`);
  console.log(`\n截图：${SHOT_DIR}`);
  console.log(`结果：${steps.filter((x) => x.ok).length} PASS / ${problems.length} FAIL`);
  if (problems.length) console.log("待修：\n" + problems.map((p) => `  - ${p}`).join("\n"));
  page.close();
  chrome.child.kill();
}

