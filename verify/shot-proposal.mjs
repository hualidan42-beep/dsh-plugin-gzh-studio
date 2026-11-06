/** 截提案卡：确认逐段对照在面板上看得懂（要点的是卡片里的「看对照」按钮，不是卡片本身）。 */
import { launch, attach } from "./cdp.mjs";
const TOKEN = process.argv[2];
if (!TOKEN) { console.error("用法：node verify/shot-proposal.mjs <token>"); process.exit(1); }
const chrome = await launch({ port: 9343, url: `http://127.0.0.1:3080/?token=${TOKEN}`, width: 1680, height: 1100 });
const page = await attach(chrome.port);
const say = (name, ok, d = "") => console.log(`${ok ? "PASS" : "FAIL"}  ${name}${d ? ` — ${d}` : ""}`);
try {
  await page.waitFor("!document.body.innerText.includes('Loading plugins')", "加载完", 90000);
  await new Promise((r) => setTimeout(r, 1500));
  await page.clickText("新媒体工作台");
  await page.waitFor(`document.querySelector(".gzs-card")`, "首页", 30000);
  await page.clickText("一家药企", ".gzs-card__title");
  await page.waitFor(`document.querySelector(".gzs-phone")`, "单篇", 30000);
  await new Promise((r) => setTimeout(r, 1800));

  const cards = await page.evaluate(`(() => [...document.querySelectorAll(".gzs-prop")].map((el) => ({
    sum: (el.querySelector(".gzs-prop__sum")?.textContent || "").trim(),
    meta: (el.querySelector(".gzs-prop__meta")?.textContent || "").trim(),
    badges: [...el.querySelectorAll(".gzs-badge")].map((b) => b.textContent.trim()),
  })))()`);
  say("有提案卡", cards.length === 1, JSON.stringify(cards));

  await page.clickNth(".gzs-prop .gzs-btn", 0);
  await new Promise((r) => setTimeout(r, 1400));
  const detail = await page.evaluate(`(() => {
    const chgs = [...document.querySelectorAll(".gzs-chg")];
    return {
      count: chgs.length,
      labels: chgs.map((c) => (c.querySelector(".gzs-chg__t")?.textContent || "").trim()),
      diffRows: document.querySelectorAll(".gzs-diff__row").length,
      adds: document.querySelectorAll(".gzs-diff__row--add").length,
      dels: document.querySelectorAll(".gzs-diff__row--del").length,
      emptyHint: document.body.innerText.includes("（没有可显示的对照）"),
      confirmBtn: [...document.querySelectorAll(".gzs-prop .gzs-btn")].map((b) => b.textContent.trim()),
    };
  })()`);
  say("对照区展开", detail.count > 0, `${detail.count} 处改动：${detail.labels.join("、")}`);
  say("有增删对照行", detail.adds > 0 && detail.dels > 0, `+${detail.adds} / -${detail.dels}`);
  say("没有「无对照可显示」", !detail.emptyHint);
  say("有确认按钮", detail.confirmBtn.some((t) => /确认/.test(t)), detail.confirmBtn.join("/"));
  await page.screenshot("D:/work/skill/plugins/dsh-plugin-gzh-studio/verify/shots/13-proposal.png");
  console.log("截图：verify/shots/13-proposal.png");
} finally {
  if (typeof page.close === "function") await page.close();
  if (chrome.child) chrome.child.kill();
}

