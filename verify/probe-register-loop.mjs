/**
 * 探针：同一台宿主连续刷新 N 次，看「新媒体工作台」是否每次都注册上来。
 *
 * 现象：有几次页面加载后侧栏里根本没有 `gzh-studio` 这一行（历史工作台一起消失），
 * 于是「更多 → 自研插件」里也就没有它——用户看到的就是「找不到入口了」。
 * 这个探针只做一件事：量出它到底有多频繁，别靠一次观察下结论。
 *
 * 用法：node verify/probe-register-loop.mjs <token> [次数]
 */
import { launch, attach } from "./cdp.mjs";

const TOKEN = process.argv[2];
const ROUNDS = Number(process.argv[3] || 6);
if (!TOKEN) {
  console.error("用法：node verify/probe-register-loop.mjs <token> [次数]");
  process.exit(1);
}
const url = `http://127.0.0.1:3080/?token=${TOKEN}`;
const chrome = await launch({ port: 9385, url: "about:blank", width: 1440, height: 900 });
const page = await attach(chrome.port);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const read = () =>
  page.evaluate(`(() => {
    const rows = [...document.querySelectorAll("button[data-dsh-tidy-panel]")]
      .map((b) => b.getAttribute("data-dsh-tidy-panel"));
    const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("新媒体工作台"));
    return {
      rows,
      gzh: rows.includes("gzh-studio"),
      history: rows.includes("history-studio"),
      anyGzhButton: Boolean(btn),
      tidy: (() => { try { return localStorage.getItem("dsh-sidebar-tidy:settings"); } catch { return "?"; } })(),
    };
  })()`);

let miss = 0;
try {
  for (let i = 1; i <= ROUNDS; i += 1) {
    await page.navigate(url);
    await wait(7000);
    const r = await read();
    if (!r.gzh) miss += 1;
    console.log(`第 ${i} 次：gzh=${r.gzh} history=${r.history} 按钮=${r.anyGzhButton} 已注册 ${r.rows.length} 项` +
      (r.gzh ? "" : `  缺：${["gzh-studio", "history-studio"].filter((id) => !r.rows.includes(id)).join(",")}`));
  }
  console.log(`\n${ROUNDS} 次里缺 ${miss} 次`);
} catch (error) {
  console.log("探针失败：", error.message);
} finally {
  page.close();
  chrome.child.kill();
}

