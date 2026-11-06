/**
 * 一次性视觉验收：把「有入口这次没加载上」这条提示真逼出来看一眼。
 *
 * 怎么造：`isOwnPanel` 会把 `dsh-` 前缀去掉再比对，所以往「见过」记录里塞
 * `dsh-task-radar`（列表里写的是 `task-radar`）就等价于「它以前来过、这次不在」，
 * 而真实的面板 id 一个都不用动。看完把记录清掉，别污染后续测试。
 *
 * 用法：node verify/_shot-missing.mjs <token>
 */
import { launch, attach } from "./cdp.mjs";

const TOKEN = process.argv[2];
if (!TOKEN) {
  console.error("用法：node verify/_shot-missing.mjs <token>");
  process.exit(1);
}
const url = `http://127.0.0.1:3080/?token=${TOKEN}`;
const SHOT = "D:/work/skill/plugins/dsh-plugin-gzh-studio/verify/shots";
const chrome = await launch({ port: 9389, url, width: 1440, height: 900 });
const page = await attach(chrome.port);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const openMenu = async () => {
  await page.evaluate(`(() => {
    [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "更多")?.click();
    return true;
  })()`);
  await wait(1200);
};

try {
  await page.navigate(url);
  await page.waitFor(
    `[...document.querySelectorAll("button")].some((b) => (b.textContent || "").trim() === "更多")`,
    "侧栏",
    90000,
  );
  await wait(2500);

  // 造一条「以前见过」的记录，然后重载让 sync 按它判断
  await page.evaluate(`(() => {
    const key = "dsh-sidebar-tidy:seen";
    const now = JSON.parse(localStorage.getItem(key) || "{}");
    now["dsh-task-radar"] = "任务雷达";
    localStorage.setItem(key, JSON.stringify(now));
    return true;
  })()`);
  await page.navigate(url);
  await page.waitFor(
    `[...document.querySelectorAll("button")].some((b) => (b.textContent || "").trim() === "更多")`,
    "侧栏",
    90000,
  );
  await wait(2500);
  await openMenu();

  const notice = await page.evaluate(`(() => {
    const el = document.querySelector(".dsh-tidy-missing");
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    return {
      found: true,
      text: (el.textContent || "").trim(),
      size: [Math.round(r.width), Math.round(r.height)],
      inViewport: r.top >= 0 && r.bottom <= window.innerHeight,
      btn: [...el.querySelectorAll("button")].map((b) => (b.textContent || "").trim()),
      overflows: el.scrollWidth > el.clientWidth + 2,
    };
  })()`);
  console.log("缺位提示：", JSON.stringify(notice));
  await page.screenshot(`${SHOT}/missing-notice.png`);

  // 清掉造的数据，并**等它落盘**：localStorage 是异步刷盘的，
  // 清完立刻关页面会把删除丢掉，下次加载又读到残留（踩过一次）。
  await page.evaluate(`(() => { localStorage.removeItem("dsh-sidebar-tidy:seen"); return true; })()`);
  await wait(800);
  const left = await page.evaluate(`(() => localStorage.getItem("dsh-sidebar-tidy:seen"))()`);
  console.log("已清除测试记录：", left === null ? "干净" : `仍有残留 ${left}`);
} catch (error) {
  console.log("失败：", error.message);
} finally {
  page.close();
  chrome.child.kill();
}
