/**
 * 给 6 段正文配图：s1–s5 逐张出真图（走网关），s6 跳过。
 *
 * 为什么 s6 跳过：它 heading 和 body 都是空的（QA 已标「必改」），给一个不存在的段落配图没有意义。
 *
 * 图片来源一律走 `/api/gzh-studio.generate`，也就是面板按钮按下去走的那条路：
 * 落盘 + 记版本 + 写账本都由服务端做，这里不自己拼文件。
 *
 * 幂等：已出过真图的槽位默认跳过（要重出加 `--force`）。每张图都是一条新版本，
 * 旧版本不会被覆盖，所以重跑是安全的、可回退的。
 *
 * 用法：node verify/fill-section-images.mjs <token> [--force] [--dry]
 */
import { launch, attach } from "./cdp.mjs";

const TOKEN = process.argv[2];
const FORCE = process.argv.includes("--force");
const DRY = process.argv.includes("--dry");
const ARTICLE_ID = "gzh-20261026-36ad";

if (!TOKEN) {
  console.error("用法：node verify/fill-section-images.mjs <token> [--force] [--dry]");
  process.exit(1);
}

/**
 * 标题里的信息换成画面，不用抽象概念。
 * 统一风格尾让 5 张看起来是同一组：纪实摄影、冷调、无人、16:9。
 * 三处「字迹虚化 / 内容虚化」是刻意的——模型渲染中文小字会出乱码，
 * 与其事后修，不如让画面本身不需要可读文字。
 */
const STYLE = "，纪实摄影，冷色调，自然光，浅景深，无人，16:9 横构图，商务报道质感";
const SLOTS = [
  {
    slot: "sec-s1",
    why: "等待占全程 91% —— 单据堆着等人签",
    prompt: `堆满打印单据与文件夹的办公桌，俯拍，纸张边缘微翘，单据上的字迹虚化不可辨${STYLE}`,
    negative: "文字，水印，人脸，logo",
  },
  {
    slot: "sec-s2",
    why: "流程不是画出来的 —— 白板上被划掉的箭头",
    prompt: `会议室白板上手绘的流程图，多处箭头被红色马克笔划掉，笔迹潦草不可辨${STYLE}`,
    negative: "文字，水印，人脸",
  },
  {
    slot: "sec-s3",
    why: "删节点删出质量事故 —— 车间看板泛红告警",
    prompt: `制药车间工位旁的电子看板，屏幕泛红告警光，操作台与不锈钢设备，屏幕内容虚化不可辨${STYLE}`,
    negative: "文字，水印，人脸",
  },
  {
    slot: "sec-s4",
    why: "跨系统同步改事件驱动 —— 两块屏幕并置",
    prompt: `办公桌两块显示器并置特写，暗色界面泛蓝光，两块屏内容虚化不可辨${STYLE}`,
    negative: "文字，水印，人脸，logo",
  },
  {
    slot: "sec-s5",
    why: "先做后补 —— 单据要留痕，归档与空白表单的对比",
    prompt: `车间办公室的文件柜与打印机旁，一叠已签字归档的单据整齐夹在文件夹里，旁边散着几张空白表单，冷白灯${STYLE}`,
    negative: "文字，水印，人脸",
  },
];

const SIZE = "1024x576"; // 16:9，且都是 64 的倍数，网关不会二次吸附

const url = `http://127.0.0.1:3080/?token=${TOKEN}`;
const chrome = await launch({ port: 9337, url, width: 1440, height: 900 });
const page = await attach(chrome.port);

/** 页面内 fetch：带 cookie，才有权限；出图慢，不设 abort，只看服务端。 */
const call = (path, body) =>
  page.evaluate(`(async () => {
    const init = { credentials: "same-origin", headers: { "content-type": "application/json" } };
    if (${JSON.stringify(body ?? null)} !== null) {
      init.method = "POST";
      init.body = JSON.stringify(${JSON.stringify(body ?? null)});
    }
    const res = await fetch(${JSON.stringify(path)}, init);
    const text = await res.text();
    return { status: res.status, body: text };
  })()`);

const results = [];
const ok = [];
const bad = [];
const note = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  (pass ? ok : bad).push(`${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`${pass ? "OK  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

try {
  await page.waitFor("!document.body.innerText.includes('Loading plugins')", "插件加载完", 90000);
  await new Promise((r) => setTimeout(r, 1200));

  const state = JSON.parse((await call("/api/gzh-studio.state", null)).body);
  const article = JSON.parse((await call(`/api/gzh-studio.article?id=${ARTICLE_ID}`, null)).body)?.article;
  if (!article) throw new Error("读不到文章");
  console.log(`文章：${article.title}`);
  console.log(`段落：${article.sections.length} 段\n`);

  for (const item of SLOTS) {
    const section = article.sections.find((s) => `sec-${s.id}` === item.slot);
    if (!section) {
      note(`${item.slot} 存在`, false, "文章里没有这个槽位");
      continue;
    }
    const current = section.image?.versions?.find((v) => v.vid === section.image.current);
    if (!FORCE && current && /png|jpe?g|webp/.test(String(current.mime))) {
      note(`${item.slot} 已是真图，跳过`, true, `${current.vid} ${current.width}×${current.height}`);
      continue;
    }

    console.log(`── ${item.slot}｜${item.why}`);
    if (DRY) {
      console.log(`   prompt: ${item.prompt}`);
      continue;
    }

    // 1) 先把 prompt 落到槽位上：面板上看到的要和真正发出去的一致，
    //    否则以后重出图用的是旧 prompt，图对不上话。
    const saved = JSON.parse((await call("/api/gzh-studio.save", {
      id: ARTICLE_ID,
      patch: { slot: { slot: item.slot, prompt: item.prompt, negative: item.negative } },
    })).body);
    const changed = saved.changed ?? [];
    note(`${item.slot} prompt 落到槽位`, changed.includes(`${item.slot}:prompt`), changed.join(",") || "无变化");

    // 2) 出图。显式指定 gateway：万一它挂了要看到报错，而不是悄悄换成占位图。
    const started = Date.now();
    const res = await call("/api/gzh-studio.generate", {
      id: ARTICLE_ID, slot: item.slot, node: "gateway", size: SIZE,
    });
    const ms = Date.now() - started;
    if (res.status !== 200) {
      note(`${item.slot} 出图`, false, `HTTP ${res.status} ${res.body.slice(0, 200)}`);
      continue;
    }
    const out = JSON.parse(res.body);
    const v = out.version ?? {};
    const real = /png|jpe?g|webp/.test(String(v.mime)) && !/占位/.test(String(v.note ?? ""));
    note(
      `${item.slot} 出图`,
      real,
      `${v.vid} ${v.width}×${v.height} · ${Math.round((v.bytes ?? 0) / 1024)}KB · ${v.node} · ${(ms / 1000).toFixed(1)}s${v.note ? ` · ${v.note}` : ""}`,
    );
    if (!real) console.log(`   ⚠ 这张不是真图：${v.note ?? v.mime}`);
  }
} finally {
  if (typeof page.close === "function") await page.close();
  if (chrome.child) chrome.child.kill();
}

console.log(`\n结果：${ok.length} OK / ${bad.length} FAIL`);
if (bad.length) {
  console.log("失败项：");
  for (const b of bad) console.log(`- ${b}`);
  process.exit(1);
}
