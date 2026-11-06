import { launch, attach } from "./cdp.mjs";
const TOKEN = process.argv[2];
const url = `http://127.0.0.1:3080/?token=${TOKEN}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = await launch({ port: 9393, url, width: 1680, height: 1000 });
const page = await attach(chrome.port);
await page.waitFor(`[...document.querySelectorAll("button")].some((b) => (b.textContent || "").includes("新媒体工作台"))`, "btn", 90000);
await wait(1000);
await page.evaluate(`(() => { [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("新媒体工作台")).click(); return true; })()`);
await page.waitFor('document.querySelector(".gzs-body")', "body", 30000);
await wait(2500);
const dump = () => page.evaluate(`(() => {
  const q = (s) => document.querySelector(s);
  const w = (s) => { const e = q(s); return e ? Math.round(e.getBoundingClientRect().width) : null; };
  const st = (s) => { const e = q(s); return e ? e.getAttribute("style") : null; };
  const body = q(".gzs-body");
  return {
    win: window.innerWidth,
    left: w(".gzs-col--left"), mid: w(".gzs-col--mid"), right: w(".gzs-col--right"), chat: w(".gzs-chatcol"),
    leftStyle: st(".gzs-col--left"), rightStyle: st(".gzs-col--right"),
    bodyW: body ? body.clientWidth : null, scroll: body ? body.scrollWidth - body.clientWidth : null,
    stored: localStorage.getItem("gzs.cols.v1"),
  };
})()`);
console.log("宽窗口:", JSON.stringify(await dump()));
await page.send("Emulation.setDeviceMetricsOverride", { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
await wait(2000);
console.log("窄/对话开:", JSON.stringify(await dump()));
await page.clickText("收起对话", ".gzs-narrow__b");
await wait(1500);
console.log("窄/对话关:", JSON.stringify(await dump()));
await page.send("Emulation.clearDeviceMetricsOverride");
await page.close(); await chrome.child.kill();

