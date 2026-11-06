/**
 * 交互探针：拖拽 / 记忆 / 复位 / 视频号单期。
 *
 * 单测能证明「算得对」，证明不了「真人拖得动」。这里用 CDP 派发真实鼠标事件，
 * 把分隔条拖一遍，再刷新页面看宽度记不记得住。
 *
 * 用法：node verify/_probe_interact.mjs <token>
 */
import { launch, attach } from "./cdp.mjs";

const TOKEN = process.argv[2];
if (!TOKEN) {
  console.error("用法：node verify/_probe_interact.mjs <token>");
  process.exit(1);
}
const url = `http://127.0.0.1:3080/?token=${TOKEN}`;
const SHOT = "D:/work/skill/plugins/dsh-plugin-gzh-studio/verify/shots";

let pass = 0;
const bad = [];
const ok = (name, cond, detail = "") => {
  if (cond) pass += 1;
  else bad.push(`${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** 中栏硬下限，和 client.js 的 MID_FLOOR 必须一致（改了那边要改这里）。 */
const MID_FLOOR_PX = 300;

const chrome = await launch({ port: 9373, url, width: 1680, height: 1000 });
const page = await attach(chrome.port);

/** 打开工作台（侧栏按钮在 DOM 里但零尺寸，直接 click()）。 */
const openStudio = async () => {
  await page.navigate(url);
  try {
    await page.waitFor(
      `[...document.querySelectorAll("button")].some((b) => (b.textContent || "").includes("新媒体工作台"))`,
      "侧栏按钮",
      90000,
    );
  } catch (err) {
    // 失败时把现场打出来：只报一句「等不到」没法判断是白页、401 还是入口没注册。
    const scene = await page.evaluate(`(() => ({
      href: location.href,
      buttons: [...document.querySelectorAll("button")].map((b) => (b.textContent || "").trim()).filter(Boolean).slice(0, 25),
      bodyLen: (document.body.innerText || "").length,
    }))()`);
    throw new Error(`${err.message}；现场 ${JSON.stringify(scene)}`);
  }
  await wait(1200);
  await page.evaluate(`(() => {
    [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("新媒体工作台"))?.click();
    return true;
  })()`);
  await page.waitFor('document.querySelector(".gzs-root")', "工作台挂载", 30000);
  await wait(2000);
};

const geo = () =>
  page.evaluate(`(() => {
    const w = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().width) : 0; };
    const body = document.querySelector(".gzs-body");
    return {
      left: w(".gzs-col--left"), mid: w(".gzs-col--mid"), right: w(".gzs-col--right"), chat: w(".gzs-chatcol"),
      scroll: body ? body.scrollWidth - body.clientWidth : null,
      splits: [...document.querySelectorAll(".gzs-split")].map((s) => {
        const r = s.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 40) };
      }),
      stored: (() => { try { return localStorage.getItem("gzs.cols.v1"); } catch { return "?"; } })(),
    };
  })()`);

/** 派发一整套真实鼠标事件（Chrome 会据此合成 pointerdown/move/up）。 */
const drag = async (x0, y0, dx) => {
  const steps = 8;
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", clickCount: 1 });
  for (let i = 1; i <= steps; i += 1) {
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x0 + (dx * i) / steps), y: y0, button: "left", buttons: 1 });
  }
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x0 + dx, y: y0, button: "left", clickCount: 1 });
  await wait(500);
};

try {
  // ── A. 拖拽 ────────────────────────────────────────────────────────────
  await openStudio();
  await page.evaluate(`(localStorage.removeItem("gzs.cols.v1"), true)`);
  await page.navigate(url);
  await wait(1500);
  await page.evaluate(`(() => {
    [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("新媒体工作台"))?.click();
    return true;
  })()`);
  await page.waitFor('document.querySelector(".gzs-root")', "工作台挂载", 30000);
  await wait(2000);

  const before = await geo();
  console.log("起始：", JSON.stringify(before));
  ok("三条分隔条都在", before.splits.length === 3, `${before.splits.length} 条`);
  ok("起始不横向溢出", before.scroll !== null && before.scroll <= 2, `溢出 ${before.scroll}px`);

  // 分隔条次序：[对话｜工作台] [左栏｜中栏] [中栏｜右栏]
  // 注意这里查的不是「拖了就一定变宽」，而是**物理规则**：
  // 面板总宽固定，一栏变宽必然挤窄中栏；中栏到 MID_FLOOR(300) 之后，另一栏就再也拖不动了。
  // 300 是 client.js 里的 MID_FLOOR（手动拖拽的硬下限）。以前这里是 427（MID_NEED，
  // 自动布局的「够用」标准），拿它当闸门的结果是三栏只剩 36px 可拖——用户说「假动作」。
  const [, sLeft, sRight] = before.splits;
  await drag(sLeft.x, sLeft.y, 80);
  const afterLeft = await geo();
  ok("拖左分隔条 → 左栏变宽", afterLeft.left > before.left,
    `${before.left} → ${afterLeft.left}`);
  ok("左栏变宽是把中栏让出去的（不是撑破面板）", afterLeft.mid <= before.mid && afterLeft.scroll <= 2,
    `中栏 ${before.mid} → ${afterLeft.mid}，溢出 ${afterLeft.scroll}`);

  // 中栏已经顶到下限，此时再拖右栏「应该拖不动」—— 拖不动才是对的
  const g1 = await geo();
  await drag(g1.splits[2].x, g1.splits[2].y, 120);
  const blocked = await geo();
  ok("中栏到硬下限后，右栏再拖也不会挤破它", blocked.mid >= MID_FLOOR_PX && blocked.scroll <= 2,
    `中栏 ${blocked.mid}，右栏 ${blocked.right}，溢出 ${blocked.scroll}`);

  // 先把左栏双击复位（腾出空间），右栏这才该拉得动
  await page.evaluate(`(() => {
    [...document.querySelectorAll(".gzs-split")][2].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    [...document.querySelectorAll(".gzs-split")][1].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    return true;
  })()`);
  await wait(600);
  const back = await geo();
  ok("双击分隔条恢复自动宽度", Math.abs(back.left - before.left) <= 2 && Math.abs(back.right - before.right) <= 2,
    `左 ${back.left}（原 ${before.left}）/ 右 ${back.right}（原 ${before.right}）`);

  await drag(back.splits[2].x, back.splits[2].y, 120);
  const afterRight = await geo();
  ok("腾出空间后，右栏能拖宽", afterRight.right > back.right, `${back.right} → ${afterRight.right}`);
  ok("拖完仍不横向溢出（夹取生效）", afterRight.scroll <= 2, `溢出 ${afterRight.scroll}px`);
  ok("拖完记进 localStorage", /left/.test(afterRight.stored || "") || /right/.test(afterRight.stored || ""),
    afterRight.stored || "空");
  await page.screenshot(`${SHOT}/drag-after.png`);

  // ── B. 拖到极限 ────────────────────────────────────────────────────────
  const g2 = await geo();
  await drag(g2.splits[2].x, g2.splits[2].y, 900); // 右栏猛拉宽
  const wide = await geo();
  ok("右栏拖到头不超过上限", wide.right <= 720, `右栏 ${wide.right}px`);
  ok("右栏拖到头时中栏仍 ≥ 硬下限", wide.mid >= MID_FLOOR_PX, `中栏 ${wide.mid}px`);
  ok("右栏拖到头时整排不溢出", wide.scroll <= 2, `溢出 ${wide.scroll}px`);

  await drag(wide.splits[2].x, wide.splits[2].y, -900); // 右栏猛压窄
  const thin = await geo();
  ok("右栏压到头不低过下限", thin.right >= 250, `右栏 ${thin.right}px`);
  ok("右栏压窄后中栏变宽", thin.mid > wide.mid, `中栏 ${wide.mid} → ${thin.mid}`);
  await page.screenshot(`${SHOT}/drag-extreme.png`);

  // ── C. 刷新后记得住 ────────────────────────────────────────────────────
  // 先用一次明显不是默认值的宽度，否则「记住了」和「本来就是这个值」分不清
  const g3 = await geo();
  await drag(g3.splits[2].x, g3.splits[2].y, 160);
  const keep = await geo();
  ok("刷新前拿到一个非默认宽度", keep.right !== before.right, `右栏 ${before.right} → ${keep.right}`);

  await page.navigate(url);
  await wait(1500);
  await page.evaluate(`(() => {
    [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("新媒体工作台"))?.click();
    return true;
  })()`);
  await page.waitFor('document.querySelector(".gzs-root")', "工作台挂载", 30000);
  await wait(2200);
  const reloaded = await geo();
  ok("刷新后宽度还在", Math.abs(reloaded.right - keep.right) <= 2,
    `右 ${keep.right} → ${reloaded.right}`);

  // ── D. 双击复位 ────────────────────────────────────────────────────────
  await page.evaluate(`(() => {
    [...document.querySelectorAll(".gzs-split")][2].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    return true;
  })()`);
  await wait(700);
  const reset = await geo();
  ok("双击分隔条恢复自动宽度", Math.abs(reset.right - before.right) <= 2,
    `右 ${reloaded.right} → ${reset.right}（自动值 ${before.right}）`);
  ok("复位后 localStorage 里不再有 right", !/right/.test(reset.stored || ""), reset.stored || "空");

  // ── E. 视频号：右栏常驻内容 → 点开单期 → 四个 tab 收起回列表 ────────────
  await page.evaluate(`(() => {
    [...document.querySelectorAll(".gzs-chan__b")].find((b) => b.textContent.trim() === "视频号")?.click();
    return true;
  })()`);
  await wait(1800);
  const vs = await page.evaluate(`(() => {
    const side = document.querySelector(".gzs-vside");
    const list = document.querySelector(".gzs-vlist");
    return {
      side: (side?.textContent || "").replace(/\\s+/g, " ").slice(0, 60),
      rows: document.querySelectorAll(".gzs-vrow, .gzs-vlist button, .gzs-vlist [data-ep]").length,
      listText: (list?.textContent || "").replace(/\\s+/g, " ").slice(0, 80),
      openBtns: [...document.querySelectorAll(".gzs-vlist button, .gzs-vside button")]
        .map((b) => (b.textContent || "").trim()).filter(Boolean).slice(0, 8),
    };
  })()`);
  ok("视频号右栏不是空白", (vs.side || "").length > 10, vs.side);
  ok("视频号左栏列出期", vs.rows > 0 || /期/.test(vs.listText), vs.listText);
  console.log("视频号按钮：", JSON.stringify(vs.openBtns));

  // 点第一期的「打开」
  const opened = await page.evaluate(`(() => {
    const btn = [...document.querySelectorAll(".gzs-vlist button, .gzs-vrow")]
      .find((b) => /打开|→/.test(b.textContent || ""));
    if (!btn) return { ok: false };
    btn.click();
    return { ok: true, text: (btn.textContent || "").trim().slice(0, 20) };
  })()`);
  await wait(1500);
  const detail = await page.evaluate(`(() => {
    const side = document.querySelector(".gzs-vside");
    return {
      text: (side?.textContent || "").replace(/\\s+/g, " ").slice(0, 120),
      tabs: [...document.querySelectorAll(".gzs-vside .gzs-btn, .gzs-vtabs button")]
        .map((b) => (b.textContent || "").trim()).filter(Boolean).slice(0, 8),
      hasAside: Boolean(document.querySelector(".gzs-vside")?.textContent?.includes("生成在哪做")),
    };
  })()`);
  ok("点「打开」后右栏换成单期详情", opened.ok && !detail.hasAside, `按钮「${opened.text}」`);
  console.log("单期右栏：", detail.text);
  console.log("单期 tab：", JSON.stringify(detail.tabs));
  ok("单期详情有内容", (detail.text || "").length > 10, detail.text.slice(0, 40));
  await page.screenshot(`${SHOT}/video-episode.png`);
} catch (error) {
  ok("流程中断", false, String(error?.message ?? error));
} finally {
  console.log(`\n结果：${pass} PASS / ${bad.length} FAIL`);
  if (bad.length) console.log("待修：\n" + bad.map((b) => `  - ${b}`).join("\n"));
  page.close();
  chrome.child.kill();
}

