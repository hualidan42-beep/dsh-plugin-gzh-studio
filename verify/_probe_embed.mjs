/**
 * 一次性探针：内嵌对话实例里到底是谁在决定「显示哪条会话」。
 *
 * 只读，不改任何东西。要看四件事：
 * 1. iframe 与外层共用哪份 localStorage（键名 + 当前值）；
 * 2. iframe 文档里有没有能摸到 cordis ctx 的全局对象；
 * 3. 内嵌实例当前挂在列表里的会话是哪条、标题是什么；
 * 4. `dsh.sessions.current` 的原始值与它是谁写的。
 *
 * 用法：node verify/_probe_embed.mjs <token>
 */
import { launch, attach } from "./cdp.mjs";

const TOKEN = process.argv[2];
if (!TOKEN) {
  console.error("用法：node verify/_probe_embed.mjs <token>");
  process.exit(1);
}
const url = `http://127.0.0.1:3080/?token=${TOKEN}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = await launch({ port: 9381, url, width: 1680, height: 1000 });
const page = await attach(chrome.port);

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
await wait(3000);

const dump = await page.evaluate(`(() => {
  const out = { frames: [], storage: {}, outerCurrent: null, ctxGlobals: [] };
  try { out.outerCurrent = localStorage.getItem("dsh.sessions.current"); } catch (e) { out.outerCurrent = "ERR:" + e.message; }
  try {
    out.storage = Object.fromEntries(Object.keys(localStorage).sort().map((k) => [k, String(localStorage.getItem(k)).slice(0, 120)]));
  } catch (e) { out.storage = { err: String(e) }; }

  const frames = [...document.querySelectorAll("iframe")];
  for (const f of frames) {
    const row = { src: f.getAttribute("src"), w: Math.round(f.getBoundingClientRect().width) };
    try {
      const win = f.contentWindow;
      row.href = win.location.href;
      row.sameOrigin = true;
      row.iframeCurrent = win.localStorage.getItem("dsh.sessions.current");
      row.globals = Object.keys(win).filter((k) => /dsh|cordis|ctx|module/i.test(k)).slice(0, 40);
      row.bodyText = (win.document.body.innerText || "").slice(0, 700);
      row.buttons = [...win.document.querySelectorAll("button")].map((b) => (b.textContent || "").trim()).filter(Boolean).slice(0, 30);
      row.rowTitles = [...win.document.querySelectorAll("[class*=session],[class*=row],[class*=item]")].length;
    } catch (e) {
      row.err = String(e && e.message || e);
    }
    out.frames.push(row);
  }
  return out;
})()`);

console.log(JSON.stringify(dump, null, 2));

await page.close();
await chrome.child.kill();

