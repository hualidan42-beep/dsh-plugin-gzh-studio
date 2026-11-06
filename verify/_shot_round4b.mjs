/**
 * 第四轮收尾验收：治理页换肤 / 接上产线展开 / 窄窗 / 搜索筛选 / 导出入口。
 * 只读：不保存、不出图、不新建。
 */
import { launch, attach } from "./cdp.mjs";

const TOKEN = process.argv[2];
const OUT = "D:/work/skill/plugins/dsh-plugin-gzh-studio/verify/shots";
const url = `http://127.0.0.1:3080/?token=${TOKEN}`;
const chrome = await launch({ port: 9351, url, width: 1680, height: 1000 });
const page = await attach(chrome.port);

let bad = 0;
const check = (ok, name, detail = "") => { if (!ok) bad += 1; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };
const openPanel = async () => {
  await page.evaluate(`(() => { [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("新媒体工作台")).click(); return true; })()`);
  await page.waitFor('document.querySelector(".gzs-root")', "挂载", 30000);
};
const overflowCheck = () => page.evaluate(`(() => {
  const root = document.querySelector(".gzs-root"); if (!root) return ["no root"];
  const rr = root.getBoundingClientRect(); const out = [];
  for (const el of root.querySelectorAll(".gzs-card,.gzs-btn,.gzs-panel,.gzs-ver,.gzs-item,.gzs-col,.gzs-stepline,.gzs-shot,.gzs-phone,.gzs-prop,.gzs-qa,.gzs-thumbs figure")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && (r.right > rr.right + 2 || r.left < rr.left - 2)) out.push(String(el.className).split(" ")[0]);
  }
  return out.slice(0, 8);
})()`);

try {
  // ── 宽窗 ──
  await page.navigate(url);
  await page.waitFor("document.body && document.body.innerText.includes('新媒体工作台')", "侧栏", 90000);
  await new Promise((r) => setTimeout(r, 1200));
  await openPanel();
  await page.waitFor('document.querySelector(".gzs-card")', "首页", 30000);
  await new Promise((r) => setTimeout(r, 400));

  // 搜索 + 状态筛选仍可用
  const before = await page.evaluate(`document.querySelectorAll(".gzs-card").length`);
  await page.evaluate(`(() => {
    const input = document.querySelector('input[placeholder^="搜标题"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "审批");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 200));
  await page.clickText("搜索", "button");
  await new Promise((r) => setTimeout(r, 1200));
  const after = await page.evaluate(`document.querySelectorAll(".gzs-card").length`);
  check(after >= 1 && after <= before, "搜索「审批」还有结果", `${before} → ${after} 张卡`);
  const matched = await page.evaluate(`(document.querySelector(".gzs-homestat")?.textContent || "").replace(/\\s+/g, " ").trim()`);
  console.log("   统计：", matched);
  // 清空搜索
  await page.evaluate(`(() => {
    const input = document.querySelector('input[placeholder^="搜标题"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await page.clickText("搜索", "button");
  await new Promise((r) => setTimeout(r, 1000));

  // 进单篇
  await page.evaluate(`(() => { document.querySelector(".gzs-card:not(.gzs-card--new)").click(); return true; })()`);
  await page.waitFor('document.querySelector(".gzs-body")', "三栏", 30000);
  await new Promise((r) => setTimeout(r, 700));

  // 接上产线：点开 → 表单出来 → 收起（不真绑，避免改动数据）
  await page.clickText("接上产线", "button");
  await new Promise((r) => setTimeout(r, 300));
  const form = await page.evaluate(`(() => {
    const rail = document.querySelector(".gzs-rail");
    return {
      hasEpisode: Boolean(rail.querySelector('input[placeholder="historical-person-027"]')),
      hasRoot: Boolean(rail.querySelector('input[placeholder^="D:/"]')),
      hasBind: [...rail.querySelectorAll("button")].some((b) => b.textContent.trim() === "绑定"),
      text: rail.textContent.replace(/\\s+/g, " ").slice(0, 200),
    };
  })()`);
  check(form.hasEpisode && form.hasRoot && form.hasBind, "「接上产线」展开出期号/根目录/绑定", JSON.stringify([form.hasEpisode, form.hasRoot, form.hasBind]));
  await page.screenshot(`${OUT}/r4-10-bind-open.png`);
  await page.clickText("收起", "button");
  await new Promise((r) => setTimeout(r, 300));
  const closed = await page.evaluate(`Boolean(document.querySelector('.gzs-rail input[placeholder="historical-person-027"]'))`);
  check(!closed, "再点「收起」表单收回");

  // 证据 tab 里十道门/账本还在（账本按槽位过滤）
  await page.clickNth(".gzs-itab", 1);
  await new Promise((r) => setTimeout(r, 400));
  const evText = await page.evaluate(`[...document.querySelectorAll(".gzs-itabpanel")].filter((e) => !e.hidden).map((e) => e.textContent.replace(/\\s+/g, " ")).join(" ")`);
  check(evText.includes("十道门"), "证据 tab 有「十道门」", evText.slice(0, 60));
  check(evText.includes("动作记录") || evText.includes("账本"), "证据 tab 有动作记录", "");
  await page.screenshot(`${OUT}/r4-11-evidence-tab.png`);

  // 治理页换肤
  await page.clickText("治理", "button");
  await page.waitFor('document.querySelector(".gzs-gov")', "治理", 30000);
  await new Promise((r) => setTimeout(r, 700));
  const gov = await page.evaluate(`(() => ({
    bg: getComputedStyle(document.querySelector(".gzs-root")).backgroundColor,
    text: document.querySelector(".gzs-gov").textContent.replace(/\\s+/g, " ").slice(0, 120),
    panels: document.querySelectorAll(".gzs-panel").length,
  }))()`);
  check(gov.panels >= 2, "治理页有面板", `${gov.panels} 个`);
  check((await overflowCheck()).length === 0, "治理页无横向越界", JSON.stringify(await overflowCheck()));
  await page.screenshot(`${OUT}/r4-12-governance.png`);

  // 回单篇，窄窗检查
  await page.evaluate(`(() => { [...document.querySelectorAll(".gzs-btn")].find((b) => b.textContent.includes("全部")).click(); return true; })()`);
  await new Promise((r) => setTimeout(r, 900));
  await page.evaluate(`(() => { document.querySelector(".gzs-card:not(.gzs-card--new)")?.click(); return true; })()`);
  await new Promise((r) => setTimeout(r, 900));
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1180, height: 820, deviceScaleFactor: 1, mobile: false });
  await new Promise((r) => setTimeout(r, 700));
  const narrow = await page.evaluate(`(() => {
    const cols = [...document.querySelectorAll(".gzs-col")].map((e) => Math.round(e.getBoundingClientRect().width));
    const doc = document.querySelector(".gzs-doc");
    return { cols, docW: doc ? Math.round(doc.getBoundingClientRect().width) : 0, rootW: Math.round(document.querySelector(".gzs-root").getBoundingClientRect().width) };
  })()`);
  console.log("   窄窗：", JSON.stringify(narrow));
  check(narrow.cols.length === 3 && narrow.docW > 300, "1180 宽下三栏仍在、正文不变形", JSON.stringify(narrow));
  check((await overflowCheck()).length === 0, "窄窗无横向越界", JSON.stringify(await overflowCheck()));
  await page.screenshot(`${OUT}/r4-13-narrow.png`);

  console.log(bad === 0 ? "\n全部通过" : `\n有 ${bad} 项不合格`);
} finally {
  page.close();
  chrome.child.kill();
}

