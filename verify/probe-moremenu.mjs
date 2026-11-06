/**
 * 探针：侧栏「更多」菜单里到底有什么。
 *
 * 排查「新媒体工作台不见了」：它注册在 `sidebar.panellist`（id `gzh-studio`），
 * sidebar-tidy 会把它收进「更多 → 自研插件」。所以要么是没注册上，
 * 要么是被收进菜单却看不见（菜单被裁 / 不能滚 / 分组丢了）。
 *
 * 用法：node verify/probe-moremenu.mjs <token>
 */
import { launch, attach } from "./cdp.mjs";

const TOKEN = process.argv[2];
if (!TOKEN) {
  console.error("用法：node verify/probe-moremenu.mjs <token>");
  process.exit(1);
}
const url = `http://127.0.0.1:3080/?token=${TOKEN}`;
const chrome = await launch({ port: 9379, url, width: 1680, height: 1000 });
const page = await attach(chrome.port);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await page.navigate(url);
  // 关键是**等 gzh 那个按钮真的出现**再读。只等「更多」存在的话，会在插件注册完成前
  // 就读一遍侧栏，把「还没注册」误判成「注册丢了」。
  let sawGzh = true;
  try {
    await page.waitFor(
      `[...document.querySelectorAll("button")].some((b) => (b.textContent || "").includes("新媒体工作台"))`,
      "新媒体工作台按钮",
      30000,
    );
  } catch {
    sawGzh = false;
  }
  await wait(1500);
  console.log("30 秒内等到「新媒体工作台」按钮：", sawGzh);

  // 1) 侧栏本身有哪些面板行（含被收纳的）
  const nav = await page.evaluate(`(() => {
    const rows = [...document.querySelectorAll("button")].filter((b) => !b.hasAttribute("aria-haspopup"));
    return {
      rows: rows.map((b) => {
        const r = b.getBoundingClientRect();
        return {
          t: (b.textContent || "").trim().slice(0, 14),
          id: b.getAttribute("data-dsh-tidy-panel"),
          tucked: b.hasAttribute("data-dsh-tidy-tucked"),
          disp: getComputedStyle(b).display,
          w: Math.round(r.width),
        };
      }).filter((x) => x.t),
      tidy: (() => { try { return localStorage.getItem("dsh-sidebar-tidy:settings"); } catch { return "?"; } })(),
    };
  })()`);
  console.log("侧栏行：");
  for (const r of nav.rows) console.log("  ", JSON.stringify(r));
  console.log("tidy 设置：", nav.tidy);

  // 2) 打开「更多」
  const opened = await page.evaluate(`(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "更多");
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await wait(1600);
  console.log("点了「更多」：", opened);

  const menu = await page.evaluate(`(() => {
    const has = (t) => [...document.querySelectorAll("*")].some((e) => e.children.length === 0 && (e.textContent || "").trim() === t);
    // 菜单容器：包含「自研插件」字样的最近的可滚动祖先
    const label = [...document.querySelectorAll("*")].find((e) => (e.textContent || "").trim() === "自研插件");
    let box = label;
    for (let i = 0; i < 6 && box; i += 1) box = box.parentElement;
    const items = [...document.querySelectorAll('[role="menuitem"], [role="menu"] button, [role="menu"] [role="menuitem"]')]
      .map((e) => (e.textContent || "").trim()).filter(Boolean);
    // 所有可见的菜单项文字（限定在 role=menu 里）
    const menuRoot = document.querySelector('[role="menu"], [role="dialog"]');
    const mr = menuRoot ? menuRoot.getBoundingClientRect() : null;
    return {
      hasOwnGroup: Boolean(label),
      hasGzh: has("新媒体工作台"),
      hasHistory: has("历史工作台"),
      groupText: label ? (label.parentElement?.textContent || "").replace(/\\s+/g, " ").slice(0, 200) : null,
      items,
      menuRoot: mr ? { h: Math.round(mr.height), bottom: Math.round(mr.bottom), winH: window.innerHeight } : null,
      scroll: menuRoot ? { sh: menuRoot.scrollHeight, ch: menuRoot.clientHeight, oy: getComputedStyle(menuRoot).overflowY } : null,
    };
  })()`);
  console.log("菜单：", JSON.stringify(menu, null, 2));
  await page.screenshot("D:/work/skill/plugins/dsh-plugin-gzh-studio/verify/shots/probe-moremenu.png");
} catch (error) {
  console.log("探针失败：", error.message);
} finally {
  page.close();
  chrome.child.kill();
}

