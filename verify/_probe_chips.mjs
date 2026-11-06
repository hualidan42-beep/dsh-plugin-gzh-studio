import { launch, attach } from "./cdp.mjs";

const TOKEN = process.argv[2];
const OUT = "D:/work/skill/plugins/dsh-plugin-gzh-studio/verify/shots";
const url = `http://127.0.0.1:3080/?token=${TOKEN}`;
const chrome = await launch({ port: 9353, url, width: 1680, height: 1000 });
const page = await attach(chrome.port);
try {
  await page.navigate(url);
  await page.waitFor("document.body && document.body.innerText.includes('新媒体工作台')", "侧栏", 90000);
  await new Promise((r) => setTimeout(r, 1200));
  await page.evaluate(`(() => { [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("新媒体工作台")).click(); return true; })()`);
  await page.waitFor('document.querySelector(".gzs-card")', "首页", 30000);
  await page.evaluate(`(() => { document.querySelector(".gzs-card:not(.gzs-card--new)").click(); return true; })()`);
  await page.waitFor('document.querySelector(".gzs-body")', "三栏", 30000);
  await new Promise((r) => setTimeout(r, 800));
  const info = await page.evaluate(`(() => {
    const col = document.querySelector(".gzs-col--right");
    const panel = [...document.querySelectorAll(".gzs-itabpanel")].find((e) => !e.hidden);
    panel.scrollIntoView?.(false);
    col.scrollTop = col.scrollHeight;
    const chips = [...(panel?.querySelectorAll(".gzs-chip") ?? [])].map((c) => c.textContent.trim() + "|" + getComputedStyle(c).backgroundColor + "|" + getComputedStyle(c).color);
    return { chips, scroll: Math.round(col.scrollTop), h: Math.round(col.scrollHeight) };
  })()`);
  console.log(JSON.stringify(info, null, 2));
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot(`${OUT}/r4-16-opinion-bottom.png`);
} finally {
  page.close();
  chrome.child.kill();
}

