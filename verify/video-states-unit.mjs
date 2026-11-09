/**
 * 验证 scanEpisodes 能分清三个状态：
 *   1. 没配真源仓库        → configured:false
 *   2. 配了、期目录不存在  → configured:true, exists:false
 *   3. 配了、目录存在但空  → configured:true, exists:true, episodes:[]
 *   4. 配了、目录存在有期  → configured:true, exists:true, episodes:[...]
 *
 * 以前第 2 和第 3 种都返回 { root, episodes: [] }，面板只能显示「暂无视频期」。
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const REPO_ENV = "GZH_STUDIO_REPO";
const EPISODES_ENV = "GZH_STUDIO_EPISODES";

const base = await mkdtemp(join(tmpdir(), "gzh-video-states-"));
const results = [];

function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

try {
  const { scanEpisodes } = await import("../lib/video.js");

  // ── 1. 没配真源仓库 ─────────────────────────────────────────────────────
  delete process.env[REPO_ENV];
  delete process.env[EPISODES_ENV];
  const none = await scanEpisodes();
  check("没配仓库 → configured:false, exists:false", () => {
    assert.equal(none.configured, false);
    assert.equal(none.exists, false);
    assert.deepEqual(none.episodes, []);
    assert.equal(none.root, "");
  });

  // ── 2. 配了仓库，但期目录不存在 ─────────────────────────────────────────
  const emptyRepo = join(base, "repo-without-video");
  await mkdir(emptyRepo, { recursive: true });
  process.env[REPO_ENV] = emptyRepo;
  delete process.env[EPISODES_ENV];
  const missing = await scanEpisodes();
  check("配了仓库但期目录不存在 → configured:true, exists:false", () => {
    assert.equal(missing.configured, true);
    assert.equal(missing.exists, false, "期目录不存在时 exists 必须是 false");
    assert.deepEqual(missing.episodes, []);
    assert.ok(missing.root.endsWith(join("07-video", "episode")), `root 不对：${missing.root}`);
  });

  // ── 3. 目录存在但里面没有期 ─────────────────────────────────────────────
  const repo2 = join(base, "repo-empty-episodes");
  const epRoot = join(repo2, "07-video", "episode");
  await mkdir(epRoot, { recursive: true });
  process.env[REPO_ENV] = repo2;
  const empty = await scanEpisodes();
  check("目录存在但空 → configured:true, exists:true, episodes:[]", () => {
    assert.equal(empty.configured, true);
    assert.equal(empty.exists, true, "目录存在时 exists 必须是 true");
    assert.deepEqual(empty.episodes, []);
  });

  // ── 4. 有期 ─────────────────────────────────────────────────────────────
  const ep1 = join(epRoot, "DEMO-01");
  await mkdir(ep1, { recursive: true });
  await writeFile(join(ep1, "大纲.md"), "# 大纲\n");
  await writeFile(join(ep1, "口播稿.md"), "# 口播稿\n");
  const withEpisodes = await scanEpisodes();
  check("有期 → exists:true 且扫得到", () => {
    assert.equal(withEpisodes.exists, true);
    assert.equal(withEpisodes.episodes.length, 1);
    assert.equal(withEpisodes.episodes[0].id, "DEMO-01");
    assert.equal(withEpisodes.episodes[0].files.outline, true);
    assert.equal(withEpisodes.episodes[0].files.script, true);
    assert.equal(withEpisodes.episodes[0].files.final, false);
  });

  // ── 5. episodesRoot 指向别处（自定义期目录）────────────────────────────
  const custom = join(base, "custom-episodes");
  await mkdir(join(custom, "CUS-01"), { recursive: true });
  process.env[EPISODES_ENV] = custom;
  const customScan = await scanEpisodes();
  check("episodesRoot 自定义目录能生效", () => {
    assert.equal(customScan.exists, true);
    assert.equal(customScan.root, custom);
    assert.equal(customScan.episodes[0].id, "CUS-01");
  });

  // ── 6. episodesRoot 指向不存在的目录 → 也应是 exists:false ──────────────
  process.env[EPISODES_ENV] = join(base, "no-such-dir");
  const customMissing = await scanEpisodes();
  check("episodesRoot 配错 → exists:false（不再假装是空的）", () => {
    assert.equal(customMissing.configured, true);
    assert.equal(customMissing.exists, false);
    assert.deepEqual(customMissing.episodes, []);
  });
} finally {
  await rm(base, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} 通过 / ${failed.length} 失败`);
process.exit(failed.length ? 1 : 0);
