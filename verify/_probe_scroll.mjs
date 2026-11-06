import { launch, attach } from "./cdp.mjs";

const TOKEN = process.argv[2];
const url = `http://127.0.0.1:3080/?token=${TOKEN}`;
const chrome = await launch({ port: 9354, url, width: 1680, height: 1000 });
const page = await attach(chrome.port);
try {
  await page.navigate(url);
  await page.waitFor("document.body && document.body.innerText.includes('新媒体工作台')", "侧栏", 90000);
  await new Promise((r) => setTimeout(r, 1200));
  await page.evaluate(`(() => { [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("新媒体工作台")).click(); return true; })()`);
  await page.waitFor('document.querySelector(".gzs-card")', "首页", 30000);
  await page.evaluate(`(() => { document.querySelector(".gzs-card:not(.gzs-card--new)").click(); return true; })()`);
  await page.waitFor('document.querySelector(".gzs-body")', "三栏", 30000);
  await new Promise((r) => setTimeout(r, 900));
  const m = await page.evaluate(`(() => {
    const d = (el) => el ? { h: Math.round(el.getBoundingClientRect().height), sh: el.scrollHeight, ch: el.clientHeight, of: getComputedStyle(el).overflowY, flex: getComputedStyle(el).flex } : null;
    const col = document.querySelector(".gzs-col--right");
    const insp = document.querySelector(".gzs-insp");
    const panel = [...document.querySelectorAll(".gzs-itabpanel")].find((e) => !e.hidden);
    const last = panel?.lastElementChild;
    return { col: d(col), insp: d(insp), panel: d(panel), lastBottom: last ? Math.round(last.getBoundingClientRect().bottom) : -1, winH: window.innerHeight };
  })()`);
  console.log(JSON.stringify(m, null, 2));
} finally {
  page.close();
  chrome.child.kill();
}

