import { launch, attach } from "./cdp.mjs";

const TOKEN = process.argv[2];
const url = `http://127.0.0.1:3080/?token=${TOKEN}`;
const chrome = await launch({ port: 9349, url, width: 1680, height: 1000 });
const page = await attach(chrome.port);
try {
  await page.navigate(url);
  await page.waitFor("document.body && document.body.innerText.length > 20", "挂载", 90000);
  await new Promise((r) => setTimeout(r, 2000));
  await page.evaluate(`(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("新媒体工作台"));
    btn.click();
    return true;
  })()`);
  await page.waitFor('document.querySelector(".gzs-card")', "首页", 30000);
  await page.evaluate(`(() => {
    document.querySelector(".gzs-card:not(.gzs-card--new)").click();
    return true;
  })()`);
  await page.waitFor('document.querySelector(".gzs-body")', "三栏", 30000);
  await new Promise((r) => setTimeout(r, 800));

  const geo = await page.evaluate(`(() => {
    const box = (s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), w: Math.round(r.width), left: Math.round(r.left) }; };
    const rail = document.querySelector(".gzs-rail");
    const bar = document.querySelector(".gzs-stepsbar");
    const rows = [...document.querySelectorAll(".gzs-stepline")];
    const btn = document.querySelector(".gzs-railbind button");
    const foot = document.querySelector(".gzs-railfoot");
    return {
      rail: box(".gzs-rail"), head: box(".gzs-railhead"), note: box(".gzs-railnote"),
      bar: box(".gzs-stepsbar"), barScroll: bar ? { sh: bar.scrollHeight, ch: bar.clientHeight, overflowY: getComputedStyle(bar).overflowY } : null,
      rowsFirst: rows[0] ? { top: Math.round(rows[0].getBoundingClientRect().top), h: Math.round(rows[0].getBoundingClientRect().height) } : null,
      rowsLast: rows.length ? { top: Math.round(rows[rows.length - 1].getBoundingClientRect().top), h: Math.round(rows[rows.length - 1].getBoundingClientRect().height) } : null,
      bindBtn: btn ? { top: Math.round(btn.getBoundingClientRect().top), bottom: Math.round(btn.getBoundingClientRect().bottom), left: Math.round(btn.getBoundingClientRect().left), w: Math.round(btn.getBoundingClientRect().width), bg: getComputedStyle(btn).backgroundColor } : null,
      foot: box(".gzs-railfoot"), footStyle: foot ? { maxH: getComputedStyle(foot).maxHeight, overflow: getComputedStyle(foot).overflowY } : null,
      row07: (() => { const r = rows.find((x) => x.textContent.includes("排版")); if (!r) return null; const b = r.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom) }; })(),
    };
  })()`);
  console.log(JSON.stringify(geo, null, 2));
} finally {
  page.close();
  chrome.child.kill();
}

