/**
 * 一次性探针：面板入口不见了，先看页面到底报了什么。
 *
 * 不等待「侧栏按钮」——那个错误本身就是问题。这里只加载、等 10 秒、
 * 把 console 与异常全量打出来，再看插件脚本请求成功没有。
 *
 * 用法：node verify/_probe_boot.mjs <token>
 */
import { launch, attach } from "./cdp.mjs";

const TOKEN = process.argv[2];
if (!TOKEN) {
  console.error("用法：node verify/_probe_boot.mjs <token>");
  process.exit(1);
}
const url = `http://127.0.0.1:3080/?token=${TOKEN}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = await launch({ port: 9391, url, width: 1400, height: 900 });
const page = await attach(chrome.port);
await wait(10000);

for (const ev of page.events) {
  if (ev.method === "Runtime.exceptionThrown") {
    const d = ev.params.exceptionDetails;
    console.log(`[exception] ${(d.exception?.description || d.text || "").split("\n").slice(0, 4).join(" ⏎ ")}`);
  } else if (ev.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(ev.params.type)) {
    const text = ev.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    console.log(`[${ev.params.type}] ${String(text).split("\n").slice(0, 3).join(" ⏎ ")}`);
  } else if (ev.method === "Network.loadingFailed") {
    console.log(`[net-fail] ${ev.params.errorText} ${ev.params.blockedReason || ""}`);
  }
}

const probe = await page.evaluate(`(() => ({
  scripts: [...document.querySelectorAll("script[src]")].map((s) => s.getAttribute("src")).filter((s) => s.includes("plugins")),
  buttons: [...document.querySelectorAll("button")].map((b) => (b.textContent || "").trim()).filter(Boolean).slice(0, 25),
  hasRoot: Boolean(document.querySelector(".gzs-root")),
}))()`);
console.log(JSON.stringify(probe, null, 2));

await page.close();
await chrome.child.kill();
