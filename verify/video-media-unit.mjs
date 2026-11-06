/**
 * 视频媒体单测：面板要能「放」成片与封面，这条路必须同时是**能播**和**安全**的。
 *
 * 三组断言：
 * 1. 列得出：成片 / 封面 / 分镜图 / 字幕都从盘上认出来，路径是相对期目录的 POSIX 路径；
 * 2. 播得动：媒体路由支持 Range（206 + Content-Range），否则 `<video>` 拖不动进度条；
 * 3. 出不去：`../`、绝对路径、盘符、未知扩展名一律拒掉（415 / 400 / 404）。
 * @module verify/video-media-unit
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply, ROUTES } from "../index.js";
import { readEpisode, mediaFile, listEpisodeMedia } from "../lib/video.js";

const repo = await mkdtemp(join(tmpdir(), "gzs-video-"));
process.env.GZH_STUDIO_REPO = repo;

const episodeDir = join(repo, "07-video", "episode", "E01");
await mkdir(join(episodeDir, "final"), { recursive: true });
await mkdir(join(episodeDir, "分镜"), { recursive: true });
await writeFile(join(episodeDir, "final", "成片.mp4"), Buffer.from("0123456789abcdef"));
await writeFile(join(episodeDir, "cover.png"), Buffer.from("89504e470d0a1a0a", "hex"));
await writeFile(join(episodeDir, "分镜", "01.png"), Buffer.from("89504e470d0a1a0a", "hex"));
await writeFile(join(episodeDir, "字幕.vtt"), "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n第一句\n", "utf8");
await writeFile(join(episodeDir, "大纲.md"), "# 45 秒讲清：Agent 上线前先建哪四道防线\n\n开场钩子。\n", "utf8");
await writeFile(join(episodeDir, "口播稿.md"), "口播正文。\n", "utf8");
// 不许被下发的类型：白名单之外
await writeFile(join(episodeDir, "run.exe"), Buffer.from("MZ"), "binary");

// ── 1. 列得出 ────────────────────────────────────────────────────────────────
const listed = await listEpisodeMedia(episodeDir);
assert.equal(listed.final.length, 1, "认出一支成片");
assert.equal(listed.final[0].rel, "final/成片.mp4", "路径是相对期目录的 POSIX 路径");
assert.ok(listed.cover.some((file) => file.rel === "cover.png"), "认出封面");
assert.ok(listed.storyboard.some((file) => file.rel === "分镜/01.png"), "认出分镜图");
assert.equal(listed.subtitle?.rel, "字幕.vtt", "认出字幕");

const episode = await readEpisode("E01");
assert.equal(episode.title, "45 秒讲清：Agent 上线前先建哪四道防线", "标题取自大纲第一个标题");
assert.equal(episode.media.final[0].rel, "final/成片.mp4");
assert.ok(episode.dirPath.endsWith("E01"), "回绝对的期目录，面板要能复制产物路径");

// ── 2. 安全：越界与未知类型 ──────────────────────────────────────────────────
await assert.rejects(() => mediaFile("E01", "../E02/x.mp4"), /越界/, "上跳一级要拒");
await assert.rejects(() => mediaFile("E01", "C:/Windows/System32/cmd.exe"), /绝对路径/, "盘符要拒");
await assert.rejects(() => mediaFile("E01", "/etc/passwd"), /绝对路径/, "绝对路径要拒");
await assert.rejects(() => mediaFile("E01", "nope.mp4"), /不存在/, "缺文件 404");
await assert.rejects(() => mediaFile("E01", "run.exe"), /不支持/, "白名单外的类型要拒");
const found = await mediaFile("E01", "final/成片.mp4");
assert.equal(found.mime, "video/mp4");
assert.equal(found.size, 16);

// ── 3. 播得动：路由的 Range ──────────────────────────────────────────────────
const routes = new Map();
const effects = [];
apply({
  connection: { fetch: { register: (spec) => { routes.set(spec.path, spec); return () => routes.delete(spec.path); } } },
  effect: (fn) => { effects.push(fn()); },
  provide: () => {},
  logger: { info() {}, warn() {} },
}, { root: await mkdtemp(join(tmpdir(), "gzs-video-root-")) });

const media = routes.get(ROUTES.media);
assert.ok(media, "media 路由已注册");
const url = `http://x${ROUTES.media}?id=E01&rel=${encodeURIComponent("final/成片.mp4")}`;

const whole = await media.fetch({ url, headers: new Headers() });
assert.equal(whole.status, 200, "无 Range 时整段发");
assert.equal(whole.headers.get("accept-ranges"), "bytes", "必须声明支持 Range");
assert.equal(await whole.text(), "0123456789abcdef", "整段内容对");

const partial = await media.fetch({ url, headers: new Headers({ range: "bytes=4-9" }) });
assert.equal(partial.status, 206, "带 Range 要回 206");
assert.equal(partial.headers.get("content-range"), "bytes 4-9/16", "Content-Range 要准");
assert.equal(partial.headers.get("content-length"), "6");
assert.equal(await partial.text(), "456789", "切片内容对");

const suffix = await media.fetch({ url, headers: new Headers({ range: "bytes=-4" }) });
assert.equal(suffix.status, 206, "后缀 Range 也要支持");
assert.equal(await suffix.text(), "cdef", "最后 4 字节");

const bad = await media.fetch({ url: `http://x${ROUTES.media}?id=E01&rel=${encodeURIComponent("../E02/x.mp4")}`, headers: new Headers() });
assert.ok(bad.status >= 400 && bad.status < 500, `越界要被拒（实际 ${bad.status}）`);

// 收尾
await Promise.allSettled(effects.map((dispose) => (typeof dispose === "function" ? dispose() : undefined)));
delete process.env.GZH_STUDIO_REPO;
await rm(repo, { recursive: true, force: true });
console.log("video-media-unit: OK（成片/封面/分镜/字幕识别 · 标题取大纲 · 406 段 Range 206 · 越界与未知类型拒）");
