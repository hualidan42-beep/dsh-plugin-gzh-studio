/**
 * 干净安装验收：**从真打出来的 tarball 里跑一遍宿主半**。
 *
 * 为什么单独一条：`pack-check` 只证明「文件清单对」，不证明「装到别处能跑」。
 * 漏一个 `lib/` 文件、少一条相对导入，本地开发永远看不出来（因为开发目录里什么都有）。
 *
 * 做法：`npm pack` → 解到临时目录 → 从**解出来的那份** import `index.js` →
 * 用假 ctx 挂一遍路由 → 真调三条读接口。全程不碰用户真实数据目录。
 * @module verify/install-check
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "..");

const tmp = await mkdtemp(join(tmpdir(), "gzs-install-"));
const dataRoot = join(tmp, "data");
/** 宿主半注册的清理函数（fs.watch / 路由）；不叫它们，进程会被句柄吊住。 */
const effects = [];

try {
  // 1. 真打一个包（--ignore-scripts 防止 prepack 递归）
  execSync(`npm pack --ignore-scripts --pack-destination "${tmp}"`, { cwd: PLUGIN, stdio: "pipe" });
  const tarball = (await readdir(tmp)).find((name) => name.endsWith(".tgz"));
  assert.ok(tarball, "npm pack 没有产出 tarball");

  // 2. 解开（Windows 10+ 自带 bsdtar）
  const pkgRoot = join(tmp, "pkg");
  await mkdir(pkgRoot, { recursive: true });
  execSync(`tar -xzf "${join(tmp, tarball)}" -C "${pkgRoot}"`, { stdio: "pipe" });
  const pkgDir = join(pkgRoot, "package");

  // 3. 从解出来的那份加载宿主半（相对导入走的是包内文件，不是开发目录）
  const mod = await import(pathToFileURL(join(pkgDir, "index.js")).href);
  assert.equal(typeof mod.apply, "function", "包里的 index.js 要能导出 apply");
  assert.ok(mod.ROUTES && Object.keys(mod.ROUTES).length >= 20, "ROUTES 表要完整");

  // 浏览器半也要能过语法检查：单文件 bundle 被截断 / 混进备份时，宿主半照样能跑，
  // 只有加载面板那一刻才白屏——那是最难在发布前发现的一类坏包。
  execSync(`node --check "${join(pkgDir, "client.js")}"`, { stdio: "pipe" });
  const clientSource = await readFile(join(pkgDir, "client.js"), "utf8");
  assert.ok(clientSource.length > 200_000, `client.js 只有 ${clientSource.length} 字节，可能打漏了`);
  assert.ok(clientSource.includes("__ModuleLoader__.load"), "client.js 要是浏览器半的 bundle");
  const patchText = await readFile(join(pkgDir, "cordis.patch.yml"), "utf8");
  assert.ok(patchText.includes("dsh-plugin-gzh-studio"), "cordis.patch.yml 要声明插件名");

  // 4. 假 ctx 挂路由（和 host-smoke 同一套形状，但加载的是打包产物）
  const routes = new Map();
  const ctx = {
    connection: { fetch: { register: (spec) => { routes.set(spec.path, spec); return () => routes.delete(spec.path); } } },
    effect: (fn) => { effects.push(fn()); },
    provide: () => {},
    logger: { info() {}, warn() {} },
  };
  // 干净机器上没有真源仓库：确保这次验收不会被本机环境变量带偏
  delete process.env.GZH_STUDIO_REPO;
  mod.apply(ctx, { root: dataRoot });

  for (const key of Object.keys(mod.ROUTES)) {
    assert.ok(routes.get(mod.ROUTES[key]), `${key} 路由要在包里注册成功`);
  }

  const call = async (path, query = "") => {
    const response = await routes.get(path).fetch({ url: `http://x${path}${query}`, headers: new Headers() });
    return response.json();
  };

  // 5. 三条读接口真跑一遍：空库、未配公众号、未配真源仓库
  const state = await call(mod.ROUTES.state);
  assert.equal(state.articles.length, 0, "干净库应该是空的");
  assert.ok(Array.isArray(state.tracks) && state.tracks.length >= 12, "赛道路径要在包里能读到");

  const wechat = await call(mod.ROUTES.wechatStatus);
  assert.equal(wechat.configured, false, "干净机器上不该假装配好了公众号");

  const video = await call(mod.ROUTES.video);
  assert.equal(video.configured, false, "没配真源仓库要明确回 configured:false（不是空列表）");
  assert.deepEqual(video.episodes, [], "没配就没有期");

  // 6. 建一篇 + 选赛道（写盘路径也要通）
  const created = await routes.get(mod.ROUTES.create).fetch({
    url: `http://x${mod.ROUTES.create}`,
    json: async () => ({ title: "干净安装验收", sections: 2, track: "medical" }),
  }).then((response) => response.json());
  assert.equal(created.article.track, "medical", "赛道要落盘");
  assert.equal(created.article.template, "business", "医疗赛道默认模板");
  assert.ok(created.qa.items.some((row) => String(row.id).startsWith("track-medical")), "赛道规则要在打包产物里生效");
} finally {
  // 先关掉 watch / 路由，再删临时目录：Windows 上被 watch 的目录删不掉（EBUSY），
  // 删不掉又会让测试进程挂着不退出——一个清理顺序就能把验收卡死两分钟。
  await Promise.allSettled(effects.map((dispose) => (typeof dispose === "function" ? dispose() : undefined)));
  await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log("install-check: OK（client bundle 可过语法检查 · 打包产物里路由齐全 · 空库/未配公众号/未配真源仓库三种状态都对 · 新建与赛道规则可用）");

