/**
 * 打包边界自检：**市场版最先坏的不是功能，是包**。
 *
 * 早期的包有 31 MB —— `verify/` 的 30 MB 截图和探针全被打进去了，
 * 因为 `package.json` 没有 `files`。用户装一个「工作台」要先下 31 MB 的测试图，
 * 而且包里还带着作者自己的业务路径。
 *
 * 这个脚本断言四件事：
 * 1. **该在的在**：入口、浏览器半、lib、patch、README、LICENSE；
 * 2. **不该在的不在**：verify / 备份文件 / seeds / 截图；
 * 3. **体积**：解开后 < 1.5 MB（现在约 0.4 MB）；
 * 4. **没有作者私有痕迹**：`泺枢` / `D:\\work` / 内部网关域名 —— 用户拿到的包里
 *    不该出现别人的目录和服务器。
 * @module verify/pack-check
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "..");

const raw = execSync("npm pack --dry-run --json --ignore-scripts", {
  cwd: PLUGIN,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
const info = JSON.parse(raw)[0];
const files = (info.files ?? []).map((file) => file.path.replace(/\\/g, "/"));
const unpacked = Number(info.unpackedSize) || 0;

// ── 1. 该在的在 ──────────────────────────────────────────────────────────────
for (const required of ["index.js", "client.js", "cordis.patch.yml", "README.md", "CHANGELOG.md", "LICENSE", "package.json"]) {
  assert.ok(files.includes(required), `包里缺 ${required}`);
}
for (const required of ["lib/store.js", "lib/qa.js", "lib/tracks.js", "lib/wechat.js", "lib/video.js", "lib/render.js"]) {
  assert.ok(files.includes(required), `包里缺 ${required}`);
}

// ── 2. 不该在的不在 ──────────────────────────────────────────────────────────
const forbidden = files.filter((path) => /(^|\/)(verify|seeds|node_modules)\//.test(path)
  || /\.bak/.test(path)
  || /\.png$|\.jpg$|\.jpeg$/i.test(path)
  || /(^|\/)shots\//.test(path));
assert.deepEqual(forbidden, [], `包里混进了测试/备份/图片：${forbidden.slice(0, 8).join(", ")}`);
assert.ok(files.length <= 40, `文件数 ${files.length} 太多，检查 files 白名单`);

// ── 3. 体积 ──────────────────────────────────────────────────────────────────
assert.ok(unpacked > 100_000, `解开只有 ${Math.round(unpacked / 1024)} KB，可能漏了主文件`);
assert.ok(unpacked < 1_500_000, `解开 ${(unpacked / 1024 / 1024).toFixed(1)} MB，超过 1.5 MB 上限`);

// ── 4. 没有作者私有痕迹 ──────────────────────────────────────────────────────
const markers = ["泺枢", "D:\\work", "wochengtv", "social-media-management\\03-scripts"];
const hits = [];
for (const path of files) {
  let text = "";
  try {
    text = await readFile(join(PLUGIN, path), "utf8");
  } catch {
    continue; // 二进制 / 读不了的文件跳过（现在白名单里没有二进制）
  }
  for (const marker of markers) {
    if (text.includes(marker)) hits.push(`${path} 含「${marker}」`);
  }
}
assert.deepEqual(hits, [], `包里带着作者私有路径/域名：\n${hits.join("\n")}`);

// 版本号必须是合法 semver（市场索引按它排序）
const pkg = JSON.parse(await readFile(join(PLUGIN, "package.json"), "utf8"));
assert.match(pkg.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, "版本号不是 semver");
assert.equal(pkg.name, "dsh-plugin-gzh-studio", "包名");
assert.ok(Array.isArray(pkg.files) && pkg.files.length, "package.json 必须声明 files 白名单");
assert.ok(pkg.scripts?.verify, "package.json 要有 verify 脚本");

console.log(`pack-check: OK（${files.length} 个文件，解开 ${(unpacked / 1024).toFixed(0)} KB；无测试/备份/私有路径）`);
