/**
 * 布局算式体检：在用户那块 1496×648 的窗口上量「谁把谁挤出去了」。
 * 用法：node verify/_measure.mjs <token>
 */
import { launch, attach } from "./cdp.mjs";

const TOKEN = process.argv[2];
const url = `http://127.0.0.1:3080/?token=${TOKEN}`;
const chrome = await launch({ port: 9360, url, width: 1496, height: 648 });
const page = await attach(chrome.port);

const report = () => page.evaluate(`(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), right: Math.round(b.right) }; };
  const root = document.querySelector(".gzs-root");
  const head = document.querySelector(".gzs-head");
  const q = (s) => document.querySelector(s);
  const headKids = [...(head?.children ?? [])].map((el) => ({ cls: String(el.className).split(" ")[0] || el.tagName, w: Math.round(el.getBoundingClientRect().width), right: Math.round(el.getBoundingClientRect().right) }));
  const clipped = [];
  for (const el of document.querySelectorAll(".gzs-col--right *")) {
    if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).textOverflow !== "ellipsis" && el.children.length === 0) {
      clipped.push(String(el.className).split(" ")[0] + ":" + (el.textContent || "").trim().slice(0, 18));
    }
  }
  const rows = [...document.querySelectorAll(".gzs-stepline")].map((el) => Math.round(el.getBoundingClientRect().height));
  return {
    win: [window.innerWidth, window.innerHeight],
    root: r(root), rootScroll: root ? [root.scrollWidth, root.clientWidth] : null,
    head: r(head), headScroll: head ? [head.scrollWidth, head.clientWidth] : null,
    headKids,
    left: r(q(".gzs-col--left")), mid: r(q(".gzs-col--mid")), right: r(q(".gzs-col--right")),
    rightScroll: (() => { const el = q(".gzs-col--right"); return el ? [el.scrollWidth, el.clientWidth] : null; })(),
    rightClipped: clipped.slice(0, 8),
    railRowHeights: rows.slice(0, 4),
    jumpText: (q(".gzs-jump")?.textContent || "").replace(/\\s+/g, " ").trim(),
    metaText: (q(".gzs-meta")?.textContent || "").replace(/\\s+/g, " ").trim(),
    cover: r(q(".gzs-doc .gzs-shot")),
    firstP: r(q(".gzs-doc p")),
  };
})()`);

try {
  await page.navigate(url);
  await page.waitFor("document.body && document.body.innerText.includes('新媒体工作台')", "侧栏", 90000);
  await new Promise((r) => setTimeout(r, 1200));
  await page.evaluate(`(() => { [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("新媒体工作台")).click(); return true; })()`);
  await page.waitFor('document.querySelector(".gzs-card")', "首页", 30000);
  await page.evaluate(`(() => { document.querySelector(".gzs-card:not(.gzs-card--new)").click(); return true; })()`);
  await page.waitFor('document.querySelector(".gzs-body")', "三栏", 30000);
  await new Promise((r) => setTimeout(r, 900));
  console.log(JSON.stringify(await report(), null, 2));
  await page.screenshot("D:/work/skill/plugins/dsh-plugin-gzh-studio/verify/shots/r4-20-measure-1496.png");

  await page.send("Emulation.setDeviceMetricsOverride", { width: 1680, height: 900, deviceScaleFactor: 1, mobile: false });
  await new Promise((r) => setTimeout(r, 600));
  console.log("— 1680 —");
  console.log(JSON.stringify(await report(), null, 2));
} finally {
  page.close();
  chrome.child.kill();
}

