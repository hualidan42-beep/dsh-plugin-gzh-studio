/**
 * 成品图：收起左侧对话，让工作台占满面板，截一张看排版。
 * 用法：node verify/_shot-wide.mjs <token>
 */
import { launch, attach } from "./cdp.mjs";

const TOKEN = process.argv[2];
const url = `http://127.0.0.1:3080/?token=${TOKEN}`;
const chrome = await launch({ port: 9377, url, width: 1680, height: 1000 });
const page = await attach(chrome.port);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await page.navigate(url);
  await page.waitFor(
    `[...document.querySelectorAll("button")].some((b) => (b.textContent || "").includes("新媒体工作台"))`,
    "侧栏按钮",
    90000,
  );
  await wait(1200);
  await page.evaluate(`(() => {
    [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("新媒体工作台"))?.click();
    return true;
  })()`);
  await page.waitFor('document.querySelector(".gzs-root")', "工作台挂载", 30000);
  await wait(2000);
  // 关掉左侧对话（如果开着）
  await page.evaluate(`(() => {
    const t = document.querySelector(".gzs-chattoggle");
    if (t && t.textContent.includes("对话") && document.querySelector(".gzs-chatcol")) t.click();
    return true;
  })()`);
  await wait(1200);
  const geo = await page.evaluate(`(() => {
    const w = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().width) : 0; };
    return { left: w(".gzs-col--left"), mid: w(".gzs-col--mid"), right: w(".gzs-col--right"),
      chat: w(".gzs-chatcol"), work: w(".gzs-work") };
  })()`);
  console.log("面板占满时：", JSON.stringify(geo));
  await page.screenshot("D:/work/skill/plugins/dsh-plugin-gzh-studio/verify/shots/wide-fullpanel.png");
} finally {
  page.close();
  chrome.child.kill();
}

