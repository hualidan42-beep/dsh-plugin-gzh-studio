/**
 * 探针：抓「加载期异常」。
 *
 * `console.error` 看不到模块加载期抛的错 —— 那是 uncaught exception，
 * 走 `Runtime.exceptionThrown` / `Log.entryAdded`。一个模块抛错，bundle 里排在它
 * 后面的插件就全都不会执行，症状是「好几个面板同时从侧栏消失」。
 *
 * 用法：node verify/probe-exception.mjs <token>
 */
import { launch, attach } from "./cdp.mjs";

const TOKEN = process.argv[2];
if (!TOKEN) {
  console.error("用法：node verify/probe-exception.mjs <token>");
  process.exit(1);
}
const url = `http://127.0.0.1:3080/?token=${TOKEN}`;
const chrome = await launch({ port: 9383, url: "about:blank", width: 1440, height: 900 });
const page = await attach(chrome.port);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await page.send("Log.enable");
  await page.navigate(url);
  await wait(8000);

  const exceptions = page.events.filter((e) => e.method === "Runtime.exceptionThrown");
  const logs = page.events.filter((e) => e.method === "Log.entryAdded").map((e) => e.params.entry);

  console.log(`uncaught 异常 ${exceptions.length} 条，Log 条目 ${logs.length} 条`);
  for (const e of exceptions.slice(0, 8)) {
    const d = e.params.exceptionDetails;
    console.log("---");
    console.log("text :", d.text);
    console.log("desc :", String(d.exception?.description ?? "").slice(0, 600));
    console.log("url  :", d.url, "line", d.lineNumber);
  }
  const bad = logs.filter((l) => l.level === "error");
  console.log(`Log error ${bad.length} 条`);
  for (const l of bad.slice(0, 10)) console.log("  *", String(l.text).slice(0, 200), l.url || "");
} catch (error) {
  console.log("探针失败：", error.message);
} finally {
  page.close();
  chrome.child.kill();
}
