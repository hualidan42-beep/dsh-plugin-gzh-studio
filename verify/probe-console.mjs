/**
 * 只读探针：把页面里的 console.error 原文完整抓下来，并按来源归堆。
 *
 * 目的：live-ui 的「无 console.error」一旦红，需要立刻分清是**本插件**的错，
 * 还是别的插件（同为 shell.overlay 的邻居）崩了在连累这条断言。
 *
 * 用法：node verify/probe-console.mjs <token>
 */
import { launch, attach } from "./cdp.mjs";

const TOKEN = process.argv[2];
if (!TOKEN) {
  console.error("用法：node verify/probe-console.mjs <token>");
  process.exit(1);
}
const url = `http://127.0.0.1:3080/?token=${TOKEN}`;
const chrome = await launch({ port: 9375, url, width: 1680, height: 1000 });
const page = await attach(chrome.port);

try {
  await page.navigate(url);
  await page.waitFor(
    `[...document.querySelectorAll("button")].some((b) => (b.textContent || "").includes("新媒体工作台"))`,
    "侧栏按钮",
    90000,
  );
  await new Promise((r) => setTimeout(r, 3000));
  await page.evaluate(`(() => {
    [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("新媒体工作台"))?.click();
    return true;
  })()`);
  await page.waitFor('document.querySelector(".gzs-root")', "工作台挂载", 30000);
  await new Promise((r) => setTimeout(r, 3000));

  const errs = page.events
    .filter((e) => e.method === "Runtime.consoleAPICalled" && e.params.type === "error")
    .map((e) => String(e.params.args?.[0]?.value ?? e.params.args?.[0]?.description ?? ""));
  const uniq = [...new Set(errs)];
  console.log(`console.error 共 ${errs.length} 条，去重 ${uniq.length} 条：`);
  for (const t of uniq) console.log("---\n" + t.slice(0, 700));

  // 工作小管家/任务雷达到底还在不在页面上
  const radar = await page.evaluate(`(() => {
    const root = document.querySelector(".dtr");
    const r = root ? root.getBoundingClientRect() : null;
    return {
      radar: Boolean(root),
      box: r ? [Math.round(r.width), Math.round(r.height)] : null,
      text: (root?.textContent || "").replace(/\\s+/g, " ").slice(0, 60),
    };
  })()`);
  console.log("任务雷达：", JSON.stringify(radar));
  await page.screenshot("D:/work/skill/plugins/dsh-plugin-gzh-studio/verify/shots/probe-console.png");
} finally {
  page.close();
  chrome.child.kill();
}

