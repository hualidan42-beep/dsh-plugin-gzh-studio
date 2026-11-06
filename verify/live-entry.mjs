/**
 * 真实入口验收：新媒体工作台是**侧栏常驻行**（钉进 sidebar-tidy 的 KEEP_IDS）。
 *
 * 为什么单独一条：live-ui 是直接按按钮文案找元素并 `click()`，绕过了入口本身的可达性。
 * 用户真实遇到的是「入口不见了」——2026-11-02 那次，插件面板注册没执行，
 * 侧栏没有那一行，「更多 → 自研插件」里也就没有它，而 live-ui 69 项照样全绿。
 * 这条守的就是：入口真的在那儿、真的点得开、而且只有一个入口。
 *
 * 用法：node verify/live-entry.mjs <token>
 */
import { launch, attach } from "./cdp.mjs";

const TOKEN = process.argv[2];
if (!TOKEN) {
  console.error("用法：node verify/live-entry.mjs <token>");
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

const chrome = await launch({ port: 9387, url, width: 1680, height: 1000 });
const page = await attach(chrome.port);

try {
  await page.navigate(url);
  await page.waitFor(
    `[...document.querySelectorAll("button")].some((b) => (b.textContent || "").trim() === "更多")`,
    "侧栏出现",
    90000,
  );
  // 从干净的「见过」记录开始：这个 profile 在多个套件之间共用，
  // 上一轮留下的记录会让「缺位提示」误报，掩盖真实结论。
  await page.evaluate(`(() => { localStorage.removeItem("dsh-sidebar-tidy:seen"); return true; })()`);
  await page.navigate(url);
  await page.waitFor(
    `[...document.querySelectorAll("button")].some((b) => (b.textContent || "").trim() === "更多")`,
    "侧栏出现",
    90000,
  );
  await wait(2500);

  // 1) 注册上了，而且**常驻**：既在面板清单里，又没被收进「更多」
  const nav = await page.evaluate(`(() => {
    const rows = [...document.querySelectorAll("button[data-dsh-tidy-panel]")].map((b) => {
      const r = b.getBoundingClientRect();
      return {
        id: b.getAttribute("data-dsh-tidy-panel"),
        label: (b.textContent || "").trim(),
        tucked: b.hasAttribute("data-dsh-tidy-tucked"),
        visible: r.width > 40 && r.height > 10,
      };
    });
    return { rows, gzh: rows.find((r) => r.id === "gzh-studio") || null };
  })()`);
  ok("新媒体工作台注册在侧栏面板清单里", Boolean(nav.gzh), nav.rows.map((r) => r.id).join(","));
  ok("它是常驻行（没有被收进「更多」）", nav.gzh && !nav.gzh.tucked, JSON.stringify(nav.gzh));
  ok("这一行真的看得见（有尺寸）", nav.gzh && nav.gzh.visible, JSON.stringify(nav.gzh));

  // 2) 「更多」里不该再有第二个入口：同一个面板不给两处，否则又是「两个入口」
  await page.evaluate(`(() => {
    [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "更多")?.click();
    return true;
  })()`);
  await wait(1400);
  const menu = await page.evaluate(`(() => {
    const items = [...document.querySelectorAll('[role="menuitem"], [role="menu"] button')]
      .map((e) => (e.textContent || "").trim()).filter(Boolean);
    const css = [...document.querySelectorAll("style")].map((s) => s.textContent || "").join("\\n");
    return {
      items,
      hasGzh: items.some((t) => t === "新媒体工作台"),
      hasGroup: [...document.querySelectorAll("*")].some((e) => (e.textContent || "").trim() === "自研插件"),
      missing: (() => {
        const el = document.querySelector(".dsh-tidy-missing");
        return el ? (el.textContent || "").trim().slice(0, 60) : "";
      })(),
      cssOk: css.includes(".dsh-tidy-missing"),
    };
  })()`);
  ok("「更多」里不再重复出现新媒体工作台", !menu.hasGzh, menu.items.join(" / "));
  ok("「更多」里仍有「自研插件」分组", menu.hasGroup);
  ok("正常状态不该出现「没加载上」提示", !menu.missing, menu.missing);
  ok("缺位提示的样式已注入（用到时才有形）", menu.cssOk);
  await page.screenshot(`${SHOT}/entry-moremenu.png`);

  // 关掉菜单，免得挡住侧栏
  await page.evaluate(`(() => { document.body.dispatchEvent(new MouseEvent("click", { bubbles: true })); return true; })()`);
  await wait(700);

  // 3) 点侧栏那一行，一步打开工作台
  const where = await page.evaluate(`(() => {
    const btn = [...document.querySelectorAll("button[data-dsh-tidy-panel]")]
      .find((b) => b.getAttribute("data-dsh-tidy-panel") === "gzh-studio");
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  ok("侧栏那一行能算出可点坐标", Boolean(where), JSON.stringify(where));
  if (where) {
    // 用完整鼠标事件序列点（这套面板里 el.click() 不生效，见 cdp.mjs 注释）
    await page.evaluate(`(() => {
      const el = document.elementFromPoint(${where.x}, ${where.y});
      const opts = { bubbles: true, cancelable: true, clientX: ${where.x}, clientY: ${where.y}, view: window };
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        (el || document.body).dispatchEvent(new MouseEvent(type, opts));
      }
      return true;
    })()`);
    await wait(2500);
  }
  const opened = await page.evaluate(`(() => ({
    root: Boolean(document.querySelector(".gzs-root")),
    cols: document.querySelectorAll(".gzs-col").length,
  }))()`);
  ok("点侧栏一行就能打开工作台", opened.root, JSON.stringify(opened));
  ok("打开后三栏都在", opened.cols >= 3, `栏 ${opened.cols}`);
  await page.screenshot(`${SHOT}/entry-opened.png`);
} catch (error) {
  ok("流程中断", false, String(error?.message ?? error));
} finally {
  console.log(`\n结果：${pass} PASS / ${bad.length} FAIL`);
  if (bad.length) console.log("待修：\n" + bad.map((b) => `  - ${b}`).join("\n"));
  page.close();
  chrome.child.kill();
}

