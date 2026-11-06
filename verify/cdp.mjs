/**
 * 极简 CDP 驱动：用本机 Chrome 无头模式真开页面、真点击、真截图。
 *
 * 为什么不用 playwright：本机没装，也不想为一次验收引入依赖。
 * Node 22 自带全局 WebSocket 和 fetch，够用了。
 *
 * 用法见底部 `run()`；对外导出 launch / attach / close。
 */
import { spawn } from "node:child_process";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

/**
 * 宿主的登录 cookie 存在这里（Netscape 格式，curl 导出的）。
 *
 * 为什么要读它：3080 上的 DSH 只认 `dsh-auth-*` cookie，URL 里的 `?token=` 换不到
 * 会话。无头 Chrome 每次用独立 profile，一清缓存就变成 401 白页——现象是
 * 「侧栏按钮等不到」，看起来像插件没注册，实际是页面根本没进来。
 * 用环境变量 `DSH_COOKIE_FILE` 可以换一份。
 */
const COOKIE_FILE = process.env.DSH_COOKIE_FILE ?? "D:/work/skill/output/dsh-cookie.txt";

/** 把 cookie 文件里第一条 dsh-auth 灌进当前浏览器。读不到就静默跳过（由调用方报错）。 */
async function seedAuthCookie(send) {
  let text = "";
  try {
    text = await readFile(COOKIE_FILE, "utf8");
  } catch {
    return false;
  }
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    // HttpOnly 行以 `#HttpOnly_` 开头，域名紧跟着，不能当成注释跳过
    const line = raw.startsWith("#HttpOnly_") ? raw.slice("#HttpOnly_".length) : raw;
    if (line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length < 7) continue;
    const [domain, , path, , expires, name, value] = parts;
    if (!/^dsh-auth/.test(name)) continue;
    try {
      await send("Network.setCookie", {
        name,
        value,
        domain: domain.replace(/^\./, ""),
        path,
        httpOnly: true,
        secure: false,
        expires: Number(expires) || undefined,
      });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等 CDP 端口就绪，返回浏览器级 ws 地址。 */
async function waitForPort(port, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch {
      // 还没起来
    }
    await sleep(250);
  }
  throw new Error(`CDP 端口 ${port} 没起来`);
}

/**
 * 启一个无头 Chrome。
 * @param {{port?: number, dir?: string, url?: string, width?: number, height?: number}} [options]
 */
export async function launch(options = {}) {
  const port = options.port ?? 9333;
  const dir = options.dir ?? join(process.env.TEMP ?? ".", "gzs-cdp-profile");
  const width = options.width ?? 1680;
  const height = options.height ?? 1000;
  await mkdir(dir, { recursive: true });

  const args = [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`,
    `--window-size=${width},${height}`,
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--force-device-scale-factor=1",
    options.url ?? "about:blank",
  ];
  const child = spawn(CHROME, args, { stdio: "ignore", windowsHide: true });
  const browserWs = await waitForPort(port);
  return { child, port, browserWs, dir };
}

/** 拿到第一个 page 目标的 ws 地址（Chrome 直接把 url 当启动参数时只会有一个）。 */
async function pageWs(port) {
  for (let i = 0; i < 40; i += 1) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (page) return page;
    await sleep(250);
  }
  throw new Error("没有可用的 page 目标");
}

/** 连上页面，返回一个带 send/evaluate/screenshot 的会话。 */
export async function attach(port) {
  const target = await pageWs(port);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? "")})`));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send("Page.enable");
  await send("Runtime.enable");
  // 先把登录 cookie 灌进去，再让页面加载：否则 3080 回 401，页面是白页，
  // 后面所有「等不到 XX」都会被误读成插件没注册。
  const seeded = await seedAuthCookie(send);
  if (seeded) {
    // 启动参数里的 url 已经先加载过一次（那时还没 cookie），补一次刷新。
    const href = (await send("Runtime.evaluate", { expression: "location.href", returnByValue: true }))?.result?.value;
    if (typeof href === "string" && href.startsWith("http")) {
      await send("Page.reload", {});
      await sleep(1200);
    }
  }

  /**
   * 在页面里执行一段表达式。返回值走 returnByValue。
   * @param {string} expression
   */
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`页面里报错：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result?.value;
  };

  /** 轮询直到表达式为真（或超时）。 */
  const waitFor = async (expression, label = expression, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ok = await evaluate(`(() => { try { return Boolean(${expression}); } catch { return false; } })()`);
      if (ok) return true;
      await sleep(200);
    }
    throw new Error(`等不到：${label}`);
  };

  /** 截图存盘。 */
  const screenshot = async (file, options2 = {}) => {
    const result = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: options2.full ?? false,
    });
    await writeFile(file, Buffer.from(result.data, "base64"));
    return file;
  };

  /** 页面跳转 + 等 load。 */
  const navigate = async (url) => {
    await send("Page.navigate", { url });
    await sleep(1200);
  };

  /**
   * 按可见文字点元素。**用坐标派发完整鼠标事件序列**，不用 `el.click()`。
   *
   * 踩过的坑：`span.click()` 打得到 React 的委托监听，但在这套面板里
   * 点了没反应（`.gzs-card` 里的标题 span 就是这种）；派发
   * pointerdown → mousedown → mouseup → click 才和真人一致。
   */
  const clickText = async (text, selector = "*") => {
    const where = await evaluate(`(() => {
      const wanted = ${JSON.stringify(text)};
      const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const hit = nodes.find((el) => (el.textContent || "").trim() === wanted)
        || nodes.find((el) => (el.textContent || "").includes(wanted) && el.children.length <= 2)
        || nodes.find((el) => (el.textContent || "").includes(wanted));
      if (!hit) return null;
      const target = hit.closest('button,a,[role="button"]') || hit;
      const r = target.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (!where) throw new Error(`点不到「${text}」（选择器 ${selector}）`);
    await clickAt(where.x, where.y);
    return true;
  };

  /**
   * 往受控输入框里打字。
   * React 的受控组件必须走原型上的 value setter 再派发 input，
   * 直接 `el.value = x` 会被 React 认成没变。
   */
  const type = async (selector, value) => {
    const ok = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    if (!ok) throw new Error(`找不到输入框 ${selector}`);
    await sleep(250);
  };

  /** 在给定坐标派发一整套鼠标事件（`.click()` 在这套面板里不生效，见 clickText 注释）。 */
  const clickAt = async (x, y) => {
    await evaluate(`(() => {
      const el = document.elementFromPoint(${x}, ${y});
      const opts = { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y}, view: window };
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        (el || document.body).dispatchEvent(new MouseEvent(type, opts));
      }
      return true;
    })()`);
    await sleep(400);
  };

  /** 按选择器点第 n 个（文字不唯一时用这个，比猜文案可靠）。 */
  const clickNth = async (selector, index = 0) => {
    const where = await evaluate(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})][${index}];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (!where) throw new Error(`点不到 ${selector}[${index}]`);
    await clickAt(where.x, where.y);
    return true;
  };

  const close = () => {
    try {
      ws.close();
    } catch {
      // 已经断了
    }
  };

  return { send, evaluate, waitFor, screenshot, navigate, clickText, clickAt, clickNth, type, close, events };
}
