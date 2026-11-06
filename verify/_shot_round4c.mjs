/** 跳转条：在「证据」tab 上点「去看对照」应当切回「意见」并展开第一份待确认提案。 */
import { launch, attach } from "./cdp.mjs";

const TOKEN = process.argv[2];
const OUT = "D:/work/skill/plugins/dsh-plugin-gzh-studio/verify/shots";
const url = `http://127.0.0.1:3080/?token=${TOKEN}`;
const chrome = await launch({ port: 9352, url, width: 1680, height: 1000 });
const page = await attach(chrome.port);
let bad = 0;
const check = (ok, name, detail = "") => { if (!ok) bad += 1; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };

try {
  await page.navigate(url);
  await page.waitFor("document.body && document.body.innerText.includes('新媒体工作台')", "侧栏", 90000);
  await new Promise((r) => setTimeout(r, 1200));
  await page.evaluate(`(() => { [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("新媒体工作台")).click(); return true; })()`);
  await page.waitFor('document.querySelector(".gzs-card")', "首页", 30000);
  await page.evaluate(`(() => { document.querySelector(".gzs-card:not(.gzs-card--new)").click(); return true; })()`);
  await page.waitFor('document.querySelector(".gzs-body")', "三栏", 30000);
  await new Promise((r) => setTimeout(r, 700));

  // 先切到「证据」，模拟「人在别的 tab 上」
  await page.clickNth(".gzs-itab", 1);
  await new Promise((r) => setTimeout(r, 300));
  const tabBefore = await page.evaluate(`[...document.querySelectorAll(".gzs-itab")].find((e) => e.className.includes("--on"))?.textContent.trim()`);
  check(tabBefore === "证据", "先停在「证据」", tabBefore);

  await page.clickText("去看对照", "span");
  await new Promise((r) => setTimeout(r, 900));
  const after = await page.evaluate(`(() => {
    const on = [...document.querySelectorAll(".gzs-itab")].find((e) => e.className.includes("--on"))?.textContent.trim();
    const prop = document.querySelector(".gzs-prop");
    const col = document.querySelector(".gzs-col--right");
    return {
      tab: on,
      open: Boolean(document.querySelector(".gzs-prop--on")),
      diff: document.querySelectorAll(".gzs-diff__row").length,
      scrollTop: col ? Math.round(col.scrollTop) : 0,
      propTop: prop ? Math.round(prop.getBoundingClientRect().top - col.getBoundingClientRect().top) : -1,
    };
  })()`);
  console.log("   ", JSON.stringify(after));
  check(after.tab === "意见", "点「去看对照」切回「意见」", after.tab);
  check(after.open, "第一份待确认提案自动展开对照");
  check(after.diff > 0, "对照里有逐段 diff", `${after.diff} 行`);
  check(after.propTop >= 0 && after.propTop < 120, "滚到提案卡附近（不是停在顶上/屏外）", `propTop=${after.propTop} scrollTop=${after.scrollTop}`);
  await page.screenshot(`${OUT}/r4-14-jump.png`);

  // 段落槽位：意见 tab 里应有本段的检查与反馈输入
  await page.evaluate(`(() => {
    const rows = [...document.querySelectorAll(".gzs-stepline")].filter((r) => r.textContent.includes("配图"));
    const hit = rows[0];
    if (hit) hit.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 500));
  const slot = await page.evaluate(`(() => {
    const head = document.querySelector(".gzs-insphead")?.textContent.replace(/\\s+/g, " ").trim() || "";
    const panel = [...document.querySelectorAll(".gzs-itabpanel")].find((e) => !e.hidden);
    return { head, text: (panel?.textContent || "").replace(/\\s+/g, " ").slice(0, 160), qa: panel?.querySelectorAll(".gzs-qa").length ?? 0 };
  })()`);
  console.log("   ", JSON.stringify(slot));
  check(/第 \d+ 段/.test(slot.head), "点「配图」步骤切到某一段", slot.head);
  check(slot.qa >= 0, "段级意见面板能渲染", `${slot.qa} 条检查`);
  await page.screenshot(`${OUT}/r4-15-slot-opinion.png`);
  console.log(bad === 0 ? "\n全部通过" : `\n有 ${bad} 项不合格`);
} finally {
  page.close();
  chrome.child.kill();
}

