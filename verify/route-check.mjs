/**
 * 路由常量自检：代码里 `ROUTES.xxx` 用到的每个键，都必须在 `ROUTES` 字面量里定义。
 *
 * 为什么值得单独一个测试：`ROUTES` 漏一个键不会在研究阶段暴露任何问题——
 * `getJson(ROUTES.video)` 只是 fetch 了 `/undefined`，宿主老老实实回 404，
 * 面板再把 404 解释成「路由未启用，请重启宿主」。于是：
 *   - 症状看起来像后端没加载；
 *   - 排查者反复重启宿主；
 *   - 真正的原因（前端少写了一行常量）在肉眼完全看不见的地方。
 *
 * 同一种事故已经发生两次（`pipeline`、`video`/`videoEpisode`），所以把它变成断言。
 *
 * 还要和宿主半边对齐：客户端请求的路径必须真的被 `index.js` 注册过，
 * 否则「常量有了、路径写错一个字母」同样会稳定 404。
 *
 * @module verify/route-check
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "..");

const clientSrc = await readFile(join(PLUGIN, "client.js"), "utf8");
const hostSrc = await readFile(join(PLUGIN, "index.js"), "utf8");

// ── 1. 取出客户端 ROUTES 字面量 ──────────────────────────────────────────────
const routesBlock = /const ROUTES = \{([\s\S]*?)\n\s*\};/.exec(clientSrc);
assert.ok(routesBlock, "client.js 里找不到 `const ROUTES = { ... };`");

const defined = new Map();
for (const m of routesBlock[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:\s*"([^"]+)"/gm)) {
  defined.set(m[1], m[2]);
}
assert.ok(defined.size >= 10, `ROUTES 只解析出 ${defined.size} 个键，解析器可能失效了`);

// ── 2. 取出代码里实际引用到的键 ──────────────────────────────────────────────
// 只认 `ROUTES.xxx`；`ROUTES` 块内部的自引用（比如注释里的 ROUTES.pipeline）不算。
// 注释里会被误抓，所以先把注释剥掉再扫——否则「注释里提到一个不存在的键」会假失败。
const stripped = clientSrc
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const used = new Set();
for (const m of stripped.matchAll(/\bROUTES\.([A-Za-z_$][\w$]*)/g)) used.add(m[1]);

const missing = [...used].filter((key) => !defined.has(key)).sort();
assert.deepEqual(
  missing,
  [],
  `这些 ROUTES 键被用到但没定义（会请求 /undefined 并稳定 404）：${missing.join(", ")}`,
);

// ── 3. 客户端请求的路径，宿主必须真的注册过 ─────────────────────────────────
const hostRoutesBlock = /const ROUTES = \{([\s\S]*?)\n\};/.exec(hostSrc);
assert.ok(hostRoutesBlock, "index.js 里找不到宿主的 ROUTES 字面量");

const hostPaths = new Set();
for (const m of hostRoutesBlock[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:\s*"([^"]+)"/gm)) {
  hostPaths.add(m[2]);
}
for (const m of clientSrc.matchAll(/ROUTES\.[A-Za-z_$][\w$]*/g)) {
  // 只为下面按值比对时留个计数锚点
  void m;
}

const unregistered = [];
for (const [key, path] of defined) {
  // `/api/gzh-studio.image` 这种带查询串的也算同一路由
  const bare = path.split("?")[0];
  if (!hostPaths.has(bare)) unregistered.push(`${key} → ${bare}`);
}
assert.deepEqual(
  unregistered,
  [],
  `客户端请求了宿主没注册的路径：${unregistered.join(" | ")}`,
);

// ── 4. 视频号这两个键单独点名：它们就是这次的病根 ───────────────────────────
assert.equal(defined.get("video"), "/api/gzh-studio.video", "视频号期列表路由路径");
assert.equal(defined.get("videoEpisode"), "/api/gzh-studio.videoEpisode", "视频号单期路由路径");
assert.ok(
  /routeGet\(\s*ROUTES\.video\s*,/.test(hostSrc),
  "宿主必须用 routeGet 注册视频号期列表",
);

console.log(
  `route-check: OK（ROUTES ${defined.size} 个键全部有定义、宿主全部注册；引用键 ${used.size} 个）`,
);
