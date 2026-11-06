/**
 * 一次性探针：抓住「slot entry crashed in 'main'」的完整原文与调用栈。
 *
 * live-ui 报了这一条但把尾巴截断了，看不出是哪一行炸的。这里开
 * Runtime.exceptionThrown + console.error 全量记录，再做一次「收起对话 / 再打开」
 * 的动作（live-ui 就是在这两步之后挂的）。
 *
 * 用法：node verify/_probe_chatcrash.mjs <token>
 */
import { launch, attach } from "./cdp.mjs";

const TOKEN = process.argv[2];
if (!TOKEN) {
  console.error("用法：node verify/_probe_chatcrash.mjs <token>");
  process.exit(1);
}
const url = `http://127.0.0.1:3080/?token=${TOKEN}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = await launch({ port: 9385, url, width: 1680, height: 1000 });
const page = await attach(chrome.port);

const dump = () => {
  const out = [];
  for (const ev of page.events) {
    if (ev.method === "Runtime.exceptionThrown") {
      const d = ev.params.exceptionDetails;
      out.push(`[exception] ${d.exception?.description || d.text}`);
    } else if (ev.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(ev.params.type)) {
      const text = ev.params.args.map((a) => a.value ?? a.description ?? a.preview?.properties?.map?.((p) => `${p.name}=${p.value}`).join(", ") ?? "").join(" ");
      out.push(`[${ev.params.type}] ${text}`);
    }
  }
  return out;
};

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
await wait(3500);

const state = () => page.evaluate(`(() => ({
  panel: Boolean(document.querySelector(".gzs-root")),
  chatcol: Boolean(document.querySelector(".gzs-chatcol")),
  chatbody: Boolean(document.querySelector(".gzs-chatbody")),
  chatNote: (document.querySelector(".gzs-chatnote") || {}).textContent || "",
  bar: (document.querySelector(".gzs-chatcol__bar") || {}).textContent || "",
  conv: Boolean(document.querySelector('[data-lexical-editor="true"]')),
  mid: Boolean(document.querySelector(".gzs-col--mid")),
}))()`);

console.log("挂载后：", JSON.stringify(await state()));
console.log("—— 错误 ——");
for (const line of dump()) console.log(line);

// 收起再打开：live-ui 是在这两步之后开始量不到中栏的
try {
  await page.clickText("×", ".gzs-chatcol__x");
  await wait(900);
  console.log("收起后：", JSON.stringify(await state()));
  await page.clickText("▢ 对话", ".gzs-chattoggle");
  await wait(1800);
  console.log("再打开：", JSON.stringify(await state()));
} catch (err) {
  console.log("操作失败：", err.message);
}

await wait(500);
console.log("—— 错误（操作后）——");
for (const line of dump()) console.log(line);

await page.screenshot("D:/work/skill/plugins/dsh-plugin-gzh-studio/verify/shots/probe-chatcrash.png");
await page.close();
await chrome.child.kill();

