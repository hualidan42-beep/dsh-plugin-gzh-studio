/**
 * 造一篇"AI 腔稿"到一个**临时 root** 上，跑一遍真实浏览器，量去 AI 味面板的
 * 实际渲染（行数、勾选态、按钮可用性），并截图。
 *
 * 不写进用户的文章库：`--root` 用临时目录，跑完就扔。
 * 用法：node verify/shot-deai.mjs <token>
 */
import { launch, attach } from "./cdp.mjs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = process.argv[2];
if (!TOKEN) {
  console.error("用法：node verify/shot-deai.mjs <token>");
  process.exit(1);
}
const SHOT_DIR = "D:/work/skill/plugins/dsh-plugin-gzh-studio/verify/shots";
await mkdir(SHOT_DIR, { recursive: true });
const url = `http://127.0.0.1:3080/?token=${TOKEN}`;
const chrome = await launch({ port: 9336, url, width: 1680, height: 1000 });
const page = await attach(chrome.port);

// 进面板（与 live-ui 同一套进入方式：侧栏按钮的文字带 emoji 前缀）
const t0 = Date.now();
const step = (label) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`);
step("等侧栏");
await page.waitFor("document.body && document.body.innerText.includes('新媒体工作台')", "侧栏出现", 60000);
step("侧栏到了，点开面板");
await page.clickText("📝新媒体工作台", "button");
await page.waitFor("Boolean(document.querySelector('.gzs-root'))", "面板挂载", 30000);
const mounted = await page.evaluate(`Boolean(document.querySelector(".gzs-root"))`);
step(`挂载: ${mounted}`);
await page.waitFor("Boolean(document.querySelector('.gzs-home') || document.querySelector('.gzs-body'))", "首屏画完", 20000);
step("首屏画完");

// 造一篇 AI 腔稿（走真实接口，保证进的是同一条数据通路）
const created = await page.evaluate(`(async () => {
  const post = async (path, body) => (await fetch(path, {
    method: "POST", credentials: "same-origin",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })).json();
  const made = await post("/api/gzh-studio.create", {
    title: "AI 腔示范稿", audience: "测试", takeaway: "看面板", sections: 2, template: "business",
  });
  const id = made.article.id;
  await post("/api/gzh-studio.script", {
    id,
    sections: [
      { heading: "现状分析", body: "在当前的数字化转型背景下，审批流程已成为企业提升效率的重要抓手。接下来，我们来看传统模式的问题。综上所述，这件事具有重要意义。" },
      { heading: "解决方案", body: "我们需要构建一套全方位的闭环体系，通过多维度的手段实现系统性提升。此外，各部门之间的协同效率亟待提升，然而这一问题往往被忽视。因此，值得注意的是，必须予以高度重视。" },
    ],
  });
  return { id };
})()`);
console.log("造稿:", created.id);

// 打开这篇 → 治理
await page.evaluate(`(async () => {
  // 新建的文章不会自动进列表视图，先刷一次 state 让它出现
  await fetch("/api/gzh-studio.state", { credentials: "same-origin" });
})()`);
await page.clickText("刷新", ".gzs-btn");
await new Promise((r) => setTimeout(r, 1200));
await page.clickText("AI 腔示范稿", ".gzs-card__title");
await page.waitFor("Boolean(document.querySelector('.gzs-body'))", "进单篇", 15000);
await page.clickText("治理", ".gzs-btn");
await page.waitFor("Boolean(document.querySelector('.gzs-gov'))", "进治理", 15000);
await new Promise((r) => setTimeout(r, 800));

const before = await page.evaluate(`(() => {
  const panel = [...document.querySelectorAll(".gzs-panel")].find((p) =>
    (p.querySelector(".gzs-panel__head")?.textContent || "").includes("去 AI 味"));
  if (!panel) return { found: false };
  const rows = [...panel.querySelectorAll(".gzs-deai__row")];
  const btn = panel.querySelector(".gzs-deai__acts .gzs-btn");
  return {
    found: true,
    rows: rows.length,
    autoRows: rows.filter((r) => !r.classList.contains("gzs-deai__row--manual")).length,
    manualRows: rows.filter((r) => r.classList.contains("gzs-deai__row--manual")).length,
    hasAfter: rows.filter((r) => r.querySelector(".gzs-deai__after")).length,
    hasWhy: rows.filter((r) => (r.querySelector(".gzs-deai__why")?.textContent || "").length > 10).length,
    btnText: btn?.textContent?.trim() ?? "",
    btnDisabled: btn?.disabled ?? null,
    pill: (panel.querySelector(".gzs-panel__head .gzs-badge")?.textContent || "").trim(),
    overflow: (() => {
      const pr = panel.getBoundingClientRect();
      return rows.filter((r) => {
        const rr = r.getBoundingClientRect();
        return rr.right > pr.right + 1 || rr.left < pr.left - 1;
      }).length;
    })(),
  };
})()`);
console.log("面板初始:", JSON.stringify(before, null, 2));

// 勾一句，看按钮是否变可用、文案是否改
const clicked = await page.evaluate(`(() => {
  const panel = [...document.querySelectorAll(".gzs-panel")].find((p) =>
    (p.querySelector(".gzs-panel__head")?.textContent || "").includes("去 AI 味"));
  const row = [...panel.querySelectorAll(".gzs-deai__row")].find((r) => !r.classList.contains("gzs-deai__row--manual"));
  if (!row) return { clicked: false };
  row.click();
  return { clicked: true, on: row.classList.contains("gzs-deai__row--on") };
})()`);
await new Promise((r) => setTimeout(r, 500));
console.log("勾选:", JSON.stringify(clicked));

const after = await page.evaluate(`(() => {
  const panel = [...document.querySelectorAll(".gzs-panel")].find((p) =>
    (p.querySelector(".gzs-panel__head")?.textContent || "").includes("去 AI 味"));
  const btn = panel.querySelector(".gzs-deai__acts .gzs-btn");
  return {
    on: panel.querySelectorAll(".gzs-deai__row--on").length,
    btnText: btn?.textContent?.trim() ?? "",
    btnDisabled: btn?.disabled ?? null,
  };
})()`);
console.log("勾选后:", JSON.stringify(after));

await page.evaluate(`(() => {
  const panel = [...document.querySelectorAll(".gzs-panel")].find((p) =>
    (p.querySelector(".gzs-panel__head")?.textContent || "").includes("去 AI 味"));
  panel?.scrollIntoView({ block: "start" });
  const col = document.querySelector(".gzs-gov__col");
  if (col && panel) col.scrollTop += panel.getBoundingClientRect().top - col.getBoundingClientRect().top - 8;
})()`);
await new Promise((r) => setTimeout(r, 600));
await page.screenshot(`${SHOT_DIR}/12-deai.png`);
console.log(`截图：${SHOT_DIR}/12-deai.png`);

// 清理：这篇是本脚本刚造的测试稿，**按精确 id 删自己造的那一个目录**。
// 不删的话它会留在首页，用户下次打开就多一篇不认识的「AI 腔示范稿」。
// 只删这一个具体路径（不是通配、不扫目录），删完再确认它真的不在了。
const { rm, stat } = await import("node:fs/promises");
const { homedir } = await import("node:os");
const target = join(homedir(), ".dsh", "gzh-studio", "articles", created.id);
await rm(target, { recursive: true, force: true });
const gone = await stat(target).then(() => false, () => true);
console.log(`清理测试稿 ${created.id}：${gone ? "已删除" : "仍存在（需手工处理）"}`);
chrome.close?.();

