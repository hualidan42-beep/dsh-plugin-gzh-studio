/**
 * 逐屏截「手机预览」，人眼过一遍每段配图在正文里的样子。
 *
 * 为什么不用导出 HTML 截图：导出里图位是 `__IMG_01__` 占位符（公众号后台不认外部图，
 * 得手工往占位符上传），渲染出来看不到真图。要看图只能看面板里的手机预览。
 *
 * 顺带断言：每张 img 的 naturalWidth > 0，否则截出来的白框会被当成"排版留白"糊过去。
 *
 * 用法：node verify/shot-sections.mjs <token> [id]
 */
import { launch, attach } from "./cdp.mjs";
import { mkdir } from "node:fs/promises";

const TOKEN = process.argv[2];
if (!TOKEN) {
  console.error("用法：node verify/shot-sections.mjs <token>");
  process.exit(1);
}
const OUT = "D:/work/skill/plugins/dsh-plugin-gzh-studio/verify/shots";
await mkdir(OUT, { recursive: true });

const chrome = await launch({ port: 9340, url: `http://127.0.0.1:3080/?token=${TOKEN}`, width: 1680, height: 1000 });
const page = await attach(chrome.port);

try {
  await page.waitFor("!document.body.innerText.includes('Loading plugins')", "插件加载完", 90000);
  await new Promise((r) => setTimeout(r, 1500));
  // 侧栏入口要先点开：面板不点不会挂载，直接等 .gzs-card 会一直等不到
  await page.clickText("新媒体工作台");
  await page.waitFor(`document.querySelector(".gzs-card")`, "首页卡片", 30000);
  await page.clickText("一家药企", ".gzs-card__title");
  await page.waitFor(`document.querySelector(".gzs-phone")`, "手机预览", 30000);
  await new Promise((r) => setTimeout(r, 2500));

  const info = await page.evaluate(`(() => {
    const mid = document.querySelector(".gzs-col--mid");
    const paper = document.querySelector(".gzs-paper");
    const imgs = [...(paper?.querySelectorAll("img") ?? [])];
    return {
      scrollH: mid?.scrollHeight ?? 0,
      clientH: mid?.clientHeight ?? 0,
      paperH: paper?.getBoundingClientRect().height ?? 0,
      imgs: imgs.map((i) => ({ w: i.naturalWidth, h: i.naturalHeight, ok: i.complete && i.naturalWidth > 0 })),
    };
  })()`);
  console.log(`中栏可滚 ${Math.round(info.scrollH)}px / 可见 ${Math.round(info.clientH)}px · 纸张高 ${Math.round(info.paperH)}px`);
  console.log(`正文图 ${info.imgs.length} 张：` + info.imgs.map((i) => `${i.w}×${i.h}${i.ok ? "" : "(未加载)"}`).join(" "));
  const broken = info.imgs.filter((i) => !i.ok);
  if (broken.length) console.log(`⚠ ${broken.length} 张没加载出来`);

  // 按「一屏一张图」推进：手机预览按 zoom 缩过，所以用固定步长扫，命中就截
  const step = Math.round(info.clientH * 0.82);
  const total = Math.max(1, Math.ceil(info.scrollH / step));
  for (let i = 0; i < total; i += 1) {
    const top = i * step;
    await page.evaluate(`(() => {
      const mid = document.querySelector(".gzs-col--mid");
      if (mid) mid.scrollTop = ${top};
      return mid?.scrollTop ?? 0;
    })()`);
    await new Promise((r) => setTimeout(r, 700));
    const file = `${OUT}/08-phone-${String(i + 1).padStart(2, "0")}.png`;
    await page.screenshot(file);
    console.log(`截图：${file}`);
  }
} finally {
  if (typeof page.close === "function") await page.close();
  if (chrome.child) chrome.child.kill();
}

