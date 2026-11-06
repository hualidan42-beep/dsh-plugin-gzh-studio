import { launch, attach } from "./cdp.mjs";

const TOKEN = process.argv[2];
const url = `http://127.0.0.1:3080/?token=${TOKEN}`;
const chrome = await launch({ port: 9348, url, width: 1680, height: 1000 });
const page = await attach(chrome.port);
try {
  await page.navigate(url);
  await page.waitFor("document.body && document.body.innerText.length > 20", "挂载", 90000);
  await new Promise((r) => setTimeout(r, 2500));
  const probe = await page.evaluate(`(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("新媒体工作台"));
    if (!btn) return { found: false };
    const cs = getComputedStyle(btn);
    const r = btn.getBoundingClientRect();
    return {
      found: true, rect: [r.left, r.top, r.width, r.height],
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
      parentChain: (() => { const out = []; let el = btn; for (let i = 0; i < 6 && el; i += 1) { out.push(el.tagName + "." + String(el.className).slice(0, 40) + "|" + getComputedStyle(el).display); el = el.parentElement; } return out; })(),
    };
  })()`);
  console.log(JSON.stringify(probe, null, 2));

  // 直接 .click() 试试
  const clicked = await page.evaluate(`(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("新媒体工作台"));
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 2000));
  const hasRoot = await page.evaluate(`Boolean(document.querySelector(".gzs-root"))`);
  console.log("clipped click=", clicked, "gzs-root=", hasRoot);
  if (!hasRoot) {
    const html = await page.evaluate(`(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("新媒体工作台"));
      return btn ? btn.outerHTML.slice(0, 400) : "";
    })()`);
    console.log("outer:", html);
  }
  await page.screenshot("D:/work/skill/plugins/dsh-plugin-gzh-studio/verify/shots/r4-00b-after-click.png");
} finally {
  page.close();
  chrome.child.kill();
}

