import { launch, attach } from "./cdp.mjs";
import { writeFile } from "node:fs/promises";

const TOKEN = process.argv[2];
const url = `http://127.0.0.1:3080/?token=${TOKEN}`;
const chrome = await launch({ port: 9350, url, width: 1680, height: 1000 });
const page = await attach(chrome.port);
try {
  await page.navigate(url);
  await page.waitFor("document.body && document.body.innerText.length > 20", "挂载", 90000);
  await new Promise((r) => setTimeout(r, 2000));
  await page.evaluate(`(() => { [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("新媒体工作台")).click(); return true; })()`);
  await page.waitFor('document.querySelector(".gzs-card")', "首页", 30000);
  await page.evaluate(`(() => { document.querySelector(".gzs-card:not(.gzs-card--new)").click(); return true; })()`);
  await page.waitFor('document.querySelector(".gzs-body")', "三栏", 30000);
  await new Promise((r) => setTimeout(r, 800));

  const shot = await page.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: 280, y: 370, width: 251, height: 110, scale: 2.4 },
    captureBeyondViewport: true,
  });
  await writeFile("D:/work/skill/plugins/dsh-plugin-gzh-studio/verify/shots/r4-09-rail-zoom.png", Buffer.from(shot.data, "base64"));
  console.log("saved zoom");
} finally {
  page.close();
  chrome.child.kill();
}

