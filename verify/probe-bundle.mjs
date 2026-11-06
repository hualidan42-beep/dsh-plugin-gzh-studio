/**
 * 探针：宿主下发的插件 bundle 到底加载到哪一步。
 *
 * 症状是「侧栏里 archive-shelf 之后的面板全没了」，而 bundle 的拼接顺序正好是
 * `… archive-shelf, history-studio, modsearch, gzh-studio …`。
 * 一个模块在加载期抛错，后面所有模块都不会执行 —— 表现就是「好几个插件同时消失」。
 *
 * 用法：node verify/probe-bundle.mjs <token>
 */
import { launch, attach } from "./cdp.mjs";

const TOKEN = process.argv[2];
if (!TOKEN) {
  console.error("用法：node verify/probe-bundle.mjs <token>");
  process.exit(1);
}
const url = `http://127.0.0.1:3080/?token=${TOKEN}`;
const chrome = await launch({ port: 9381, url, width: 1440, height: 900 });
const page = await attach(chrome.port);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await page.navigate(url);
  await wait(6000);

  const info = await page.evaluate(`(async () => {
    const urls = performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n.includes("/plugins/"));
    const out = { urls, modules: [], tail: "", len: 0, hasGzh: false, hasHistory: false, error: "" };
    // 取 **js** 那个（不是 .map）：插件资源的清单和源码映射都会出现在 /plugins/ 下，
    // 抓错一个就只看得到 sourcemap 的尾巴。
    const target = urls.find((n) => !n.includes(".map")) || urls[0];
    out.picked = target;
    if (!target) return out;
    try {
      const res = await fetch(target, { cache: "no-store" });
      const text = await res.text();
      out.len = text.length;
      out.tail = text.slice(-500);
      out.hasGzh = text.includes("gzh-studio");
      out.hasHistory = text.includes("history-studio");
      out.hasNarrow = text.includes("gzs-narrow");
      // 「新媒体工作台」注册语句在不在
      out.hasPanelReg = text.includes("PANEL_KEY");
      out.modules = [...text.matchAll(/([a-z0-9@/_.-]*dsh-plugin-[a-z-]+)\\/(?:client|index)\\.js/g)]
        .map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i);
    } catch (e) {
      out.error = String(e && e.message || e);
    }
    return out;
  })()`);

  console.log("插件资源：");
  for (const u of info.urls) console.log("  ", decodeURIComponent(u));
  console.log("抓的是：", String(info.picked).slice(0, 160));
  console.log("bundle 长度：", info.len, " 含 gzh-studio：", info.hasGzh, " 含 history-studio：", info.hasHistory,
    " 含新样式 gzs-narrow：", info.hasNarrow, " 含面板注册语句：", info.hasPanelReg);
  console.log("bundle 里出现的插件顺序：");
  for (const m of info.modules) console.log("  -", m);
  console.log("bundle 结尾 400 字：\\n" + (info.tail || info.error));

  // 侧栏实际注册上来的面板 id
  const panels = await page.evaluate(`(() => [...document.querySelectorAll("button[data-dsh-tidy-panel]")]
    .map((b) => ({ id: b.getAttribute("data-dsh-tidy-panel"), t: (b.textContent || "").trim().slice(0, 16) })))()`);
  console.log("侧栏已注册面板：", JSON.stringify(panels));
} catch (error) {
  console.log("探针失败：", error.message);
} finally {
  page.close();
  chrome.child.kill();
}

