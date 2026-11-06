/**
 * 一次性探针：左栏对话位里到底渲染出了什么。
 *
 * 上一步确认「引用释放」的崩溃已经修掉、面板不再消失，但输入框没找到，
 * 所以要看对话位的 DOM 结构（宿主那侧会渲染什么、缺哪一层）。
 *
 * 用法：node verify/_probe_chatbody.mjs <token>
 */
import { launch, attach } from "./cdp.mjs";

const TOKEN = process.argv[2];
if (!TOKEN) {
  console.error("用法：node verify/_probe_chatbody.mjs <token>");
  process.exit(1);
}
const url = `http://127.0.0.1:3080/?token=${TOKEN}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = await launch({ port: 9387, url, width: 1680, height: 1000 });
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
await wait(5000);

const info = await page.evaluate(`(() => {
  const body = document.querySelector(".gzs-chatbody");
  const out = {
    bodyText: body ? (body.innerText || "").slice(0, 500) : null,
    bodyHtmlHead: body ? body.innerHTML.slice(0, 700) : null,
    kids: body ? [...body.children].map((el) => el.tagName + "." + (el.className || "")) : [],
    editables: [...document.querySelectorAll('[contenteditable="true"]')].map((el) => ({
      cls: el.className, aria: el.getAttribute("aria-multiline"), lexical: el.getAttribute("data-lexical-editor"),
      parent: (el.parentElement && el.parentElement.className) || "",
    })),
    lexical: document.querySelectorAll('[data-lexical-editor="true"]').length,
    textareas: [...document.querySelectorAll("textarea")].map((el) => el.className),
    hero: (document.querySelector(".gzs-chatbody [class*=hero]") || {}).className || null,
  };
  return out;
})()`);
console.log(JSON.stringify(info, null, 2));

await page.screenshot("D:/work/skill/plugins/dsh-plugin-gzh-studio/verify/shots/probe-chatbody.png");
await page.close();
await chrome.child.kill();

