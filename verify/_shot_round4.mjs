/**
 * 第四轮验收：新三栏（本期步骤 / 成稿舞台 / 检查器 tab）+ 苔绿配色，真机截图 + 几何检查。
 *
 * 只读：不新建、不保存、不出图。点开一篇、切视图、切 tab、量几何、截图。
 * 用法：node verify/_shot_round4.mjs <token>
 */
import { launch, attach } from "./cdp.mjs";
import { mkdir } from "node:fs/promises";

const TOKEN = process.argv[2];
if (!TOKEN) {
  console.error("用法：node verify/_shot_round4.mjs <token>");
  process.exit(1);
}
const OUT = "D:/work/skill/plugins/dsh-plugin-gzh-studio/verify/shots";
await mkdir(OUT, { recursive: true });

const url = `http://127.0.0.1:3080/?token=${TOKEN}`;
const chrome = await launch({ port: 9346, url, width: 1680, height: 1000 });
const page = await attach(chrome.port);

const say = (ok, name, detail = "") => console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
let bad = 0;
const check = (ok, name, detail = "") => { if (!ok) bad += 1; say(ok, name, detail); };

const info = () =>
  page.evaluate(`(() => {
    const root = document.querySelector(".gzs-root");
    if (!root) return { mounted: false };
    const q = (s) => document.querySelector(s);
    const n = (s) => document.querySelectorAll(s).length;
    const t = (s) => (q(s)?.textContent || "").trim().replace(/\\s+/g, " ");
    const cs = (s, p) => (q(s) ? getComputedStyle(q(s))[p] : "");
    const rr = root.getBoundingClientRect();
    const rect = (s) => { const el = q(s); if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };

    const overflow = [];
    for (const el of root.querySelectorAll(".gzs-card,.gzs-btn,.gzs-panel,.gzs-ver,.gzs-item,.gzs-col,.gzs-stepline,.gzs-shot,.gzs-phone,.gzs-thumbs figure")) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > rr.right + 2 || r.left < rr.left - 2)) overflow.push(String(el.className).split(" ")[0] + "@" + Math.round(r.left) + ".." + Math.round(r.right));
    }
    const clipped = [];
    for (const el of root.querySelectorAll(".gzs-title,.gzs-card__title,.gzs-item__name,.gzs-ver__meta,.gzs-panel__head,.gzs-stagetitle,.gzs-steptext")) {
      if (el.scrollWidth > el.clientWidth + 3 && getComputedStyle(el).textOverflow !== "ellipsis") clipped.push(String(el.className).split(" ")[0] + ":" + (el.textContent || "").trim().slice(0, 16));
    }
    // 竖向裁切：右栏/左栏有元素被父容器切掉一半（高度为 0 的不算）
    return {
      mounted: true,
      screen: n(".gzs-home") ? "home" : (n(".gzs-gov") ? "governance" : (n(".gzs-body") ? "article" : "other")),
      rootBg: cs(".gzs-root", "backgroundColor"),
      headBg: cs(".gzs-head", "backgroundColor"),
      headBorder: cs(".gzs-head", "borderBottomColor"),
      titleFont: cs(".gzs-stagetitle", "fontFamily"),
      bodyFont: cs(".gzs-root", "fontFamily"),
      docMaxWidth: cs(".gzs-doc", "maxWidth"),
      docP: cs(".gzs-doc p", "fontSize") + "/" + cs(".gzs-doc p", "lineHeight"),
      docH: cs(".gzs-doc h3.gzs-doch", "borderLeft"),
      cols: [rect(".gzs-col--left"), rect(".gzs-col--mid"), rect(".gzs-col--right")],
      stepRows: n(".gzs-stepline"),
      stepTags: [...document.querySelectorAll(".gzs-steptag")].map((e) => e.textContent.trim()).slice(0, 12),
      stepDots: [...document.querySelectorAll(".gzs-stepdot")].map((e) => getComputedStyle(e).borderColor + "/" + getComputedStyle(e).backgroundColor).slice(0, 4),
      railNote: t(".gzs-railnote"),
      railHead: t(".gzs-railhead"),
      outlineRows: n(".gzs-item"),
      metaText: t(".gzs-meta"),
      segs: [...document.querySelectorAll(".gzs-seg--view .gzs-btn")].map((e) => e.textContent.trim()),
      inspTabs: [...document.querySelectorAll(".gzs-itab")].map((e) => e.textContent.trim()),
      inspHead: t(".gzs-insphead"),
      inspVisible: [...document.querySelectorAll(".gzs-itabpanel")].map((e) => e.hidden ? "hidden" : "shown"),
      docParas: n(".gzs-doc p"),
      docHeads: n(".gzs-doc h3.gzs-doch"),
      shots: n(".gzs-doc .gzs-shot"),
      docRuler: t(".gzs-docgap"),
      imgs: [...document.querySelectorAll(".gzs-root img")].map((i) => ({ w: i.naturalWidth, src: (i.currentSrc || i.src || "").split("/").pop() })),
      empty: t(".gzs-empty"),
      overflow: overflow.slice(0, 8),
      clipped: clipped.slice(0, 8),
    };
  })()`);

try {
  await page.navigate(url);
  await page.waitFor("document.body && document.body.innerText.includes('新媒体工作台')", "侧栏出现", 90000);
  await new Promise((r) => setTimeout(r, 1000));
  // 侧栏面板列表默认是收起的（display:none），所以直接调按钮的 click()：
  // 坐标派发对零尺寸元素无效，但 React 的委托监听照样收得到。
  await page.evaluate(`(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("新媒体工作台"));
    if (!btn) throw new Error("侧栏没有「新媒体工作台」入口");
    btn.click();
    return true;
  })()`);
  await page.waitFor('document.querySelector(".gzs-root")', "工作台挂载", 30000);
  await page.waitFor('document.querySelector(".gzs-card")', "首页卡片", 30000);
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot(`${OUT}/r4-01-home.png`);
  let s = await info();
  check(s.headBg === "rgb(255, 255, 255)", "顶栏是白底（不再是墨绿实条）", s.headBg);
  check(s.rootBg === "rgb(238, 243, 236)", "面板底色是苔绿纸 #eef3ec", s.rootBg);
  check((s.overflow ?? []).length === 0, "首页无横向越界", (s.overflow ?? []).join(" | "));

  // 点第一篇（不是「新建」那张卡片）
  await page.clickNth(".gzs-card:not(.gzs-card--new)", 0);
  await page.waitFor('document.querySelector(".gzs-body")', "进入三栏", 30000);
  await new Promise((r) => setTimeout(r, 900));
  await page.screenshot(`${OUT}/r4-02-article-doc.png`);
  s = await info();
  console.log("—— 三栏 ——");
  check(s.screen === "article", "落在单篇三栏", s.screen);
  check(s.cols[0]?.[2] === 252, "左栏 252px", JSON.stringify(s.cols[0]));
  check(s.cols[2]?.[2] === 336, "右栏 336px", JSON.stringify(s.cols[2]));
  check((s.overflow ?? []).length === 0, "三栏无横向越界", (s.overflow ?? []).join(" | "));
  check((s.clipped ?? []).length === 0, "没有文字被硬裁", (s.clipped ?? []).join(" | "));

  console.log("—— 左栏：本期步骤 ——");
  check(s.stepRows === 11, "未绑期号也列满 11 步", `${s.stepRows} 行`);
  check(String(s.railNote).includes("按稿件推断 · 未绑定期号"), "如实标注「按稿件推断 · 未绑定期号」", s.railNote);
  check(s.stepTags.length === 11 && s.stepTags.every((x) => x.length > 0), "每行右侧都有结论文字", JSON.stringify(s.stepTags));
  check(s.outlineRows >= 3, "结构列表仍收在底部", `${s.outlineRows} 行`);
  console.log("   步结论：", JSON.stringify(s.stepTags));
  console.log("   点样式：", JSON.stringify(s.stepDots));

  console.log("—— 中栏：成稿 ——");
  check(String(s.titleFont).includes("Noto Serif SC") || String(s.titleFont).includes("Songti") || String(s.titleFont).includes("serif"), "标题是衬线", s.titleFont);
  check(s.docMaxWidth === "660px", "成稿最大宽度 660px", s.docMaxWidth);
  // 浏览器把 1.95 折算成 px（15 × 1.95 = 29.25），两种写法都算过
  check(/^15px\/(1\.95|29\.25px)$/.test(s.docP), "正文 15px / 行高 1.95", s.docP);
  check(String(s.docH).includes("3px"), "节标题左侧 3px 主色竖线", s.docH);
  check(s.docHeads >= 1 && s.docParas >= 1, "正文按节渲染", `${s.docHeads} 节标题 / ${s.docParas} 段`);
  check(s.shots >= 1, "图片按节内联", `${s.shots} 张`);
  check((s.imgs ?? []).every((i) => i.w > 0), "图片全部解码成功", JSON.stringify((s.imgs ?? []).map((i) => i.w)));
  check(JSON.stringify(s.segs) === JSON.stringify(["成稿", "手机预览", "排版"]), "分段控件三档", JSON.stringify(s.segs));
  ["字", "节", "图", "模板", "受众", "更新"].forEach((k) => check(String(s.metaText).includes(k), `元信息行有「${k}」`));
  console.log("   meta：", s.metaText);

  console.log("—— 右栏：检查器 tab ——");
  check(JSON.stringify(s.inspTabs) === JSON.stringify(["意见", "证据", "图", "元信息"]), "四个 tab", JSON.stringify(s.inspTabs));
  check(s.inspVisible.filter((x) => x === "shown").length === 1, "同一时刻只亮一个面板", JSON.stringify(s.inspVisible));

  // 切「手机预览」
  await page.clickText("手机预览", "button");
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot(`${OUT}/r4-03-phone.png`);
  let phone = await page.evaluate(`(() => {
    const box = document.querySelector(".gzs-phonebox"); const ph = document.querySelector(".gzs-phone"); const wrap = document.querySelector(".gzs-phonewrap");
    const r = (el) => el ? [Math.round(el.getBoundingClientRect().left), Math.round(el.getBoundingClientRect().width)] : null;
    return { wrap: r(wrap), phone: r(ph), wrapBg: wrap ? getComputedStyle(wrap).backgroundColor : "", phoneW: ph ? getComputedStyle(ph).width : "" };
  })()`);
  console.log("   手机壳：", JSON.stringify(phone));
  check(phone.wrap && phone.wrap[1] >= 390, "深色手机壳 ≥ 390px", JSON.stringify(phone.wrap));
  check(phone.phoneW === "375px", "手机预览仍是 375 真机宽度", phone.phoneW);
  check(String(phone.wrapBg).startsWith("rgb(16, 27, 22)"), "手机壳是深色（不是白纸）", phone.wrapBg);

  // 切「排版」
  await page.clickText("排版", "button");
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot(`${OUT}/r4-04-layout.png`);
  const layoutText = await page.evaluate(`(document.querySelector(".gzs-layout")?.textContent || "").replace(/\\s+/g, " ").trim()`);
  check(layoutText.includes("导出 HTML"), "排版视图有「导出 HTML」", layoutText.slice(0, 80));

  // 回「成稿」
  await page.clickText("成稿", "button");
  await new Promise((r) => setTimeout(r, 300));

  // 检查器 tab：证据 / 图 / 元信息
  for (const [index, name, file] of [[1, "证据", "r4-05-evidence"], [2, "图", "r4-06-images"], [3, "元信息", "r4-07-meta"]]) {
    await page.clickNth(".gzs-itab", index);
    await new Promise((r) => setTimeout(r, 350));
    await page.screenshot(`${OUT}/${file}.png`);
    const shown = await page.evaluate(`[...document.querySelectorAll(".gzs-itabpanel")].map((e) => e.hidden)`);
    check(shown.filter((x) => x === false).length === 1 && shown[index] === false, `「${name}」tab 点了会切`, JSON.stringify(shown));
  }

  // 点左栏第 7 行（配图）→ 右栏应切到某个槽位
  await page.clickNth(".gzs-itab", 0);
  await new Promise((r) => setTimeout(r, 200));
  const before = (await info()).inspHead;
  await page.evaluate(`(() => {
    const rows = [...document.querySelectorAll(".gzs-stepline")];
    const hit = rows.find((r) => r.textContent.includes("配图")) || rows[7];
    const r = hit.getBoundingClientRect();
    const el = document.elementFromPoint(Math.round(r.left + 40), Math.round(r.top + r.height / 2));
    const opts = { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + r.height / 2, view: window };
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) (el || hit).dispatchEvent(new MouseEvent(type, opts));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 500));
  const after = (await info()).inspHead;
  check(before !== after || String(after).includes("配图"), "点左栏步骤能切到槽位", `${before} → ${after}`);
  await page.screenshot(`${OUT}/r4-08-step-click.png`);

  console.log(bad === 0 ? "\n全部通过" : `\n有 ${bad} 项不合格`);
} finally {
  page.close();
  chrome.child.kill();
}

