/**
 * 探针：真开 3080 应用，把屏幕上的东西读出来（不点任何按钮）。
 * 目的是搞清「新媒体工作台」这个入口在 DOM 里长什么样、怎么点。
 */
import { launch, attach } from "./cdp.mjs";

const TOKEN = process.argv[2];
if (!TOKEN) {
  console.error("用法：node verify/probe-app.mjs <token>");
  process.exit(1);
}

const url = `http://127.0.0.1:3080/?token=${TOKEN}`;
const chrome = await launch({ port: 9333, url });
const page = await attach(chrome.port);

try {
  await page.navigate(url);
  // 等插件加载完（壳子会先显示 Loading plugins…）
  await page.waitFor("document.body && document.body.innerText.trim().length > 0", "页面有内容", 30000);
  await page.waitFor("!document.body.innerText.includes('Loading plugins')", "插件加载完", 90000);
  await new Promise((r) => setTimeout(r, 1500));

  const info = await page.evaluate(`(() => {
    const text = document.body.innerText || "";
    const clickables = [...document.querySelectorAll('button,a,[role="button"],[class*="item"],[class*="row"],[class*="tab"]')]
      .map((el) => ({
        tag: el.tagName,
        cls: String(el.className || "").slice(0, 70),
        text: (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 40),
      }))
      .filter((x) => x.text)
      .slice(0, 60);
    return {
      title: document.title,
      href: location.href,
      bodyLen: text.length,
      textHead: text.replace(/\\n{2,}/g, "\\n").slice(0, 1200),
      clickables,
      hasGzs: !!document.querySelector('[class^="gzs-"], [class*=" gzs-"]'),
      styleInjected: !!document.getElementById("gzs-style"),
    };
  })()`);

  console.log(JSON.stringify(info, null, 2));
  await page.screenshot("D:/work/skill/plugins/dsh-plugin-gzh-studio/verify/shot-probe.png");
  console.log("shot: verify/shot-probe.png");
} finally {
  page.close();
  chrome.child.kill();
}

