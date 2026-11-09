/**
 * 视频目录的两个动作（面板空态上的两颗按钮）：
 *   create → 在仓库里建出约定目录；path → 指到已有目录。
 *
 * 为什么必须真落盘验证：这两个动作会**动用户的盘**（建目录 / 改配置）。
 * 只在内存里假装成功，用户点完发现「还是空态」，就再也信不过这颗按钮了。
 * @module verify/video-setup-unit
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, ROUTES as R } from "../index.js";
import { EPISODES_ENV, REPO_ENV } from "../lib/repo.js";

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

const repoRoot = await mkdtemp(join(tmpdir(), "gzs-vsetup-"));
const otherDir = await mkdtemp(join(tmpdir(), "gzs-vother-"));
process.env[REPO_ENV] = repoRoot;
delete process.env[EPISODES_ENV];

const routes = new Map();
apply({
  logger: { info: () => {}, warn: () => {} },
  effect: () => {},
  provide: () => {},
  connection: { fetch: { register: (spec) => { routes.set(spec.path, spec); return () => {}; } } },
}, { root: join(repoRoot, ".workbench") });

const callGet = (path, query = "") => routes.get(path).fetch({ url: `http://x${path}${query}`, headers: new Headers() });
const callPost = (path, body) => routes.get(path).fetch({ url: `http://x${path}`, json: async () => body });
const jsonOf = async (response) => { assert.equal(response.status, 200, `期望 200，实得 ${response.status}`); return response.json(); };
const isDir = async (path) => (await stat(path).catch(() => null))?.isDirectory() === true;

try {
  await check("一开始：仓库配了但期目录不存在", async () => {
    const scan = await jsonOf(await callGet(R.video));
    assert.equal(scan.configured, true);
    assert.equal(scan.exists, false, "默认目录还不存在");
  });

  await check("create → 建在插件自己的数据目录，不碰用户的内容仓库", async () => {
    const result = await jsonOf(await callPost(R.videoSetup, { action: "create" }));
    assert.equal(result.ok, true);
    assert.equal(result.exists, true, "建完再扫，目录要存在");
    assert.ok(result.root.replace(/\\/g, "/").endsWith("/episodes"), `要建在 <数据目录>/episodes，实际 ${result.root}`);
    assert.ok(await isDir(result.root), "盘上真有这个目录");
    // 关键：不许往内容仓库里塞 07-video 这种编号目录
    assert.ok(!(await isDir(join(repoRoot, "07-video"))), "内容仓库里不该出现 07-video");
  });

  await check("建完之后没有期时，面板读到的是「目录在、没期」", async () => {
    const scan = await jsonOf(await callGet(R.video));
    assert.equal(scan.exists, true);
    assert.deepEqual(scan.episodes, []);
  });

  await check("path → 指到已有目录，并立刻按新目录读", async () => {
    // 造一个真有期的目录：期号目录 + 成片文件
    await mkdir(join(otherDir, "001"), { recursive: true });
    const result = await jsonOf(await callPost(R.videoSetup, { path: otherDir, action: "path" }));
    assert.equal(result.ok, true);
    assert.equal(result.episodes.length, 1, "要读到刚指过去那一期");
    assert.equal(result.episodes[0].id, "001");
    const scan = await jsonOf(await callGet(R.video));
    assert.equal(scan.root.replace(/\\/g, "/"), otherDir.replace(/\\/g, "/"), "后续扫盘用的是新目录");
  });

  await check("指到一个不存在的路径 → 400，且不落盘", async () => {
    const res = await callPost(R.videoSetup, { action: "path", path: join(otherDir, "根本没有这个目录") });
    assert.equal(res.status, 400, "无效路径不能静默接受");
    const body = await res.json();
    assert.match(body.error.message, /不存在/, "要说清是不存在");
    const scan = await jsonOf(await callGet(R.video));
    assert.equal(scan.root.replace(/\\/g, "/"), otherDir.replace(/\\/g, "/"), "失败之后配置不能被改掉");
  });

  await check("指到一个文件（不是目录）→ 400", async () => {
    const file = join(otherDir, "note.txt");
    await writeFile(file, "x", "utf8");
    const res = await callPost(R.videoSetup, { action: "path", path: file });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /不是文件夹/, "要说清是「不是文件夹」，不是「不存在」");
  });

  await check("路径带 .. → 400（不许爬出仓库）", async () => {
    const res = await callPost(R.videoSetup, { action: "path", path: "../../windows/system32" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /不能有 \.\./);
  });

  await check("不认识的动作 → 400", async () => {
    const res = await callPost(R.videoSetup, { action: "瞎写" });
    assert.equal(res.status, 400);
  });

  // ── 没有内容仓库也要能用（只做视频、不写公众号的人）──────────────────────
  await check("没配仓库：create 照样能建（视频这条线不依赖仓库）", async () => {
    const saved = process.env[REPO_ENV];
    delete process.env[REPO_ENV];
    delete process.env[EPISODES_ENV];
    try {
      const res = await callPost(R.videoSetup, { action: "create" });
      assert.equal(res.status, 200, "没仓库也该建得成");
      const body = await res.json();
      assert.equal(body.exists, true);
      const scan = await jsonOf(await callGet(R.video));
      assert.equal(scan.configured, true, "建完之后要有地方可读");
      assert.equal(scan.exists, true);
    } finally {
      if (saved) process.env[REPO_ENV] = saved;
    }
  });

  await check("没配仓库：path 用绝对路径照样能指过去", async () => {
    const saved = process.env[REPO_ENV];
    delete process.env[REPO_ENV];
    try {
      const res = await callPost(R.videoSetup, { action: "path", path: otherDir });
      assert.equal(res.status, 200, "绝对路径不该依赖仓库");
      assert.equal((await res.json()).episodes.length, 1);
    } finally {
      if (saved) process.env[REPO_ENV] = saved;
    }
  });

  await check("没配仓库：path 填相对路径 → 400，并说清要用完整路径", async () => {
    const saved = process.env[REPO_ENV];
    delete process.env[REPO_ENV];
    try {
      const res = await callPost(R.videoSetup, { action: "path", path: "视频/期目录" });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error.message, /完整路径/, "相对路径没有仓库可解，要说清楚");
    } finally {
      if (saved) process.env[REPO_ENV] = saved;
    }
  });
} finally {
  delete process.env[EPISODES_ENV];
  await rm(repoRoot, { recursive: true, force: true });
  await rm(otherDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} 通过 / ${failed.length} 失败`);
process.exit(failed.length ? 1 : 0);
