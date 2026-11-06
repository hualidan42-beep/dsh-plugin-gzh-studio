/**
 * 探针：只量几何，不改任何东西。
 *
 * 目的：搞清「右侧面板被藏起来」到底是哪种情形——
 *   ① 容器本身超宽（root 比窗口宽，谁也滚不到）；
 *   ② 容器正常，内部横向滚动（能滚到，但默认看不见）；
 *   ③ 元素被 overflow:hidden 裁掉。
 * 这三者的修法完全不同，所以先量再改。
 *
 * 用法：node verify/_probe_geom.mjs <token>
 */
import { launch, attach } from "./cdp.mjs";

const TOKEN = process.argv[2];
if (!TOKEN) {
  console.error("用法：node verify/_probe_geom.mjs <token>");
  process.exit(1);
}
const url = `http://127.0.0.1:3080/?token=${TOKEN}`;

const chrome = await launch({ port: 9371, url, width: 1680, height: 1000 });
const page = await attach(chrome.port);

try {
  await page.navigate(url);
  await page.waitFor(
    `[...document.querySelectorAll("button")].some((b) => (b.textContent || "").includes("新媒体工作台"))`,
    "侧栏按钮",
    90000,
  );
  await new Promise((r) => setTimeout(r, 1200));
  await page.evaluate(`(() => {
    [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("新媒体工作台"))?.click();
    return true;
  })()`);
  await page.waitFor('document.querySelector(".gzs-root")', "工作台挂载", 30000);
  await new Promise((r) => setTimeout(r, 2500));

  const geo = await page.evaluate(`(() => {
    const R = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
      return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), r: Math.round(b.right) }; };
    const q = (s) => document.querySelector(s);
    const body = q(".gzs-body");
    const root = q(".gzs-root");
    // 哪些按钮跑出了窗口
    const winW = window.innerWidth;
    const outside = [...document.querySelectorAll(".gzs-root .gzs-btn, .gzs-root .gzs-seg")]
      .map((b) => ({ t: (b.textContent || "").trim().slice(0, 8), ...R(b) }))
      .filter((b) => b.r > winW + 1 || b.x < -1);
    return {
      win: { w: winW, h: window.innerHeight },
      root: R(root),
      panelHost: R(root?.parentElement),
      head: R(q(".gzs-head")),
      body: R(body),
      bodyScroll: body ? { sw: body.scrollWidth, cw: body.clientWidth, ox: getComputedStyle(body).overflowX } : null,
      left: R(q(".gzs-col--left")),
      mid: R(q(".gzs-col--mid")),
      right: R(q(".gzs-col--right")),
      chat: R(q(".gzs-chatcol")),
      splits: [...document.querySelectorAll(".gzs-split")].map((s) => R(s)),
      screen: q(".gzs-home") ? "home" : (q(".gzs-gov") ? "gov" : (q(".gzs-body") ? "article" : "other")),
      outside,
      // 三栏宽度到底来自哪里：localStorage 里存过就用存的，没存过才是 autoCols 算的。
      stored: (() => { try { return localStorage.getItem("gzs.cols.v1"); } catch { return "?"; } })(),
      basis: {
        left: q(".gzs-col--left")?.style.flexBasis || "(css 默认)",
        right: q(".gzs-col--right")?.style.flexBasis || "(css 默认)",
        chat: q(".gzs-chatcol")?.style.flexBasis || "(css 默认)",
      },
      // 全栏截断扫描：谁说自己的内容比盒子宽，就列出来（不预设类名，
      // 否则只查我想到的那几个，剩下的挤成两行也发现不了）
      trunc: [...document.querySelectorAll(".gzs-col *")]
        .filter((el) => el.children.length === 0 && (el.textContent || "").trim()
          && el.scrollWidth > el.clientWidth + 3 && el.clientWidth > 0)
        .map((el) => ({
          c: String(el.className).split(" ")[0],
          t: (el.textContent || "").trim().slice(0, 16),
          need: el.scrollWidth,
          has: el.clientWidth,
          ell: getComputedStyle(el).textOverflow === "ellipsis",
        }))
        .slice(0, 14),
      rootOverflow: root ? { sw: root.scrollWidth, cw: root.clientWidth, ox: getComputedStyle(root).overflowX } : null,
    };
  })()`);
  console.log(JSON.stringify(geo, null, 2));
} catch (error) {
  console.log("探针失败：", error.message);
} finally {
  await page.screenshot("D:/work/skill/plugins/dsh-plugin-gzh-studio/verify/shots/_probe-geom.png");
  page.close();
  chrome.child.kill();
}

