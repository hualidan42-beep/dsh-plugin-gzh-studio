/**
 * 视频号（`07-video/episode/*`）：只看盘，**不生成**。
 *
 * 这一轮的口径是「先做成看得见」——进度、分镜、口播稿、分段、字幕能从盘上读出来就够，
 * 生成动作仍留在会话里跑 agent。所以本模块只做两件事：
 *
 * 1. `scanEpisodes()`：每期有哪些件、走到第几步（`状态 · 完成数/总步数`）；
 * 2. `readEpisode(id)`：单期的口播稿正文、分镜表、分段表、字幕。
 *
 * **缺文件一律不算错**：现在盘上 `FDE-01` 只有一个 `audio-segments/分段索引.md`，
 * 口播稿 / 分镜 / 字幕都还没有；以后加了也照读，不加就是空数组 + 一句 `note`。
 * 任何「文件不在」都返回空值，绝不抛异常——面板上「还没有」是一个正常状态。
 *
 * 步骤是怎么数出来的：**文件在就算那一步有料**，不猜业务状态（不猜「审过了」「录完了」）。
 * 8 步：大纲 → 口播稿 → 分镜 → 配音 → 分段 → 字幕 → 封面 → 成片。
 * @module lib/video
 */

import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";

import { repoRoot } from "./repo.js";

/** 视频号每期的步骤表（顺序即进度顺序；`key` 与 `files` 的键对得上）。 */
export const EPISODE_STEPS = [
  { key: "outline", label: "大纲" },
  { key: "script", label: "口播稿" },
  { key: "storyboard", label: "分镜" },
  { key: "audio", label: "配音" },
  { key: "segments", label: "分段" },
  { key: "subtitle", label: "字幕" },
  { key: "cover", label: "封面" },
  { key: "final", label: "成片" },
];

const AUDIO_EXT = /\.(wav|mp3|m4a|aac|flac|ogg|opus)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif)$/i;
const SUBTITLE_EXT = /\.(srt|vtt|ass|ssa)$/i;

/** 每期目录（`07-video/episode`）。 */
export const episodeRoot = () => join(repoRoot(), "07-video", "episode");

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

async function listEntries(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readText(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const isHidden = (name) => !name || name.startsWith(".") || name.startsWith("_");

// ── 探件 ────────────────────────────────────────────────────────────────────

/**
 * 一期的件有哪些。**只看名字**（不读内容），8 步各有各的判据。
 *
 * 文件名先按常见中英文两种写法配对（`script.md` / `口播稿.md`），
 * 再按扩展名兜底（根目录下任意 `.wav` 都算配音）——真实仓里的命名比规范松，
 * 这里宁可宽一点也别报「没有」，因为「没有」会让人以为活白干了。
 * @param {import('node:fs').Dirent[]} entries
 */
export function probeEpisode(entries) {
  const isFile = (re) => entries.some((entry) => entry.isFile() && re.test(entry.name));
  const isDir = (re) => entries.some((entry) => entry.isDirectory() && re.test(entry.name));

  return {
    outline: isFile(/^(outline|大纲)(\.(md|txt|json))?$/i) || isDir(/^(outline|大纲)$/i),
    script: isFile(/^(script|口播稿|口播)(\.(md|txt))?$/i) || isDir(/^(script|口播稿|口播)$/i),
    storyboard: isFile(/^(storyboard|分镜)(\.(md|json|txt|ya?ml))?$/i) || isDir(/^(storyboard|分镜)$/i),
    audio: isDir(/^(audio|音频|配音)$/i) || isFile(AUDIO_EXT),
    segments: isDir(/^(audio-segments|segments|分段)$/i) || isFile(/^(分段索引|段索引)\.md$/i),
    subtitle: isDir(/^(subtitles?|字幕)$/i) || isFile(SUBTITLE_EXT),
    cover: isFile(/^(cover|封面)[^.]*\.(png|jpe?g|webp|gif)$/i) || isDir(/^(cover|封面)$/i),
    final: isDir(/^(final|成片|export)$/i) || isFile(VIDEO_EXT),
  };
}

/**
 * 进度词：`口播稿 · 4/8`。
 *
 * 前半段是**最后一个有料的步骤**，后半段是「完成数 / 总步数」。
 * 一个文件都没有就是 `未开始 · 0/8`——不写成「待录制」之类的业务判断，
 * 因为盘上没有任何证据能证明它在录。
 * @param {Record<string, boolean>} files
 */
export function progressOf(files) {
  const done = EPISODE_STEPS.filter((step) => files?.[step.key]);
  const total = EPISODE_STEPS.length;
  const last = done[done.length - 1];
  return `${last ? last.label : "未开始"} · ${done.length}/${total}`;
}

/**
 * 扫全部期。
 *
 * `dir` 回的是**期目录名**（相对 `07-video/episode`），可以直接回传给 `readEpisode` 的 `id`。
 * @returns {Promise<{root: string, episodes: {id: string, dir: string, status: string, files: object}[]}>}
 */
export async function scanEpisodes() {
  // 没配真源仓库：返回「未配置」而不是去读一个相对路径（那会静默扫当前工作目录）。
  if (!repoRoot()) return { root: "", configured: false, episodes: [] };
  const root = episodeRoot();
  const episodes = [];
  for (const entry of await listEntries(root)) {
    if (!entry.isDirectory() || isHidden(entry.name)) continue;
    const files = probeEpisode(await listEntries(join(root, entry.name)));
    episodes.push({
      id: entry.name,
      dir: entry.name,
      status: progressOf(files),
      // 8 个键全给出去：面板的方块是按「哪一件有料」画的，少给一件就会出现
      // 「进度说 1/8、方块全空」这种自相矛盾的画面（FDE-01 正好是分段这一件）。
      files: {
        outline: files.outline,
        script: files.script,
        storyboard: files.storyboard,
        audio: files.audio,
        segments: files.segments,
        subtitle: files.subtitle,
        cover: files.cover,
        final: files.final,
      },
    });
  }
  episodes.sort((a, b) => a.id.localeCompare(b.id, "zh", { numeric: true }));
  return { root, episodes };
}

/**
 * 期号栅栏：只收单段名字（`FDE-01`），不接受任何分隔符 / 盘符 / `..`。
 * @param {string} input
 */
export function safeEpisodeId(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw httpError("缺少 id 参数（期目录名，如 FDE-01）");
  if (raw.includes("\u0000")) throw httpError("id 参数不合法（含 NUL）");
  if (/^[a-zA-Z]:/.test(raw)) throw httpError("id 参数不合法：不接受盘符");
  if (/[\\/]/.test(raw)) throw httpError("id 参数不合法：不接受路径分隔符");
  if (raw === "." || raw === ".." || raw.startsWith(".")) throw httpError("id 参数不合法：不接受 . / ..");
  if (!/^[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5.\-]*$/.test(raw) || raw.length > 80) {
    throw httpError("id 参数不合法：只收期目录名");
  }
  return raw;
}

// ── 表格 / 字幕解析 ─────────────────────────────────────────────────────────

/**
 * 把 markdown 里的表格都抠出来（`| a | b |` 连着的块）。
 *
 * 不做语义判断，只回 `{header, rows}`；认列名的事交给各自的调用方。
 * 分隔行（`|---|---|`）跳过；单元格里的反引号与加粗标记顺手去掉，
 * 否则面板上会显示 `` `talk_seg1.wav` `` 这种原文。
 * @param {string} text
 */
export function parseTables(text) {
  const tables = [];
  let current = null;
  for (const line of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) { current = null; continue; }
    const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
    if (cells.every((cell) => cell === "" || /^:?-{2,}:?$/.test(cell))) continue;
    if (!current) {
      current = { header: cells, rows: [] };
      tables.push(current);
      continue;
    }
    current.rows.push(cells);
  }
  return tables;
}

/** 单元格清洗：去掉反引号与 `**`，免得把 markdown 语法递给面板。 */
const cleanCell = (cell) => String(cell ?? "").replace(/`/g, "").replace(/\*\*/g, "").trim();

function indexOfColumn(header, pattern) {
  const index = header.findIndex((cell) => pattern.test(cleanCell(cell)));
  return index;
}

/**
 * 分段表 → `{no, file, range, duration}`。
 *
 * 认列名（段号 / 文件 / 区间 / 时长），认不出来就按位置取。
 * 盘上没有 `分段索引.md`（或里面没有表）时回空数组，由调用方补 `note`。
 * @param {string} text
 */
export function parseSegments(text) {
  const table = parseTables(text).find((one) => one.rows.length
    && indexOfColumn(one.header, /段号|序号|编号|^no$|^#$/i) >= 0);
  if (!table) return [];
  const at = {
    no: indexOfColumn(table.header, /段号|序号|编号|^no$|^#$/i),
    file: indexOfColumn(table.header, /文件|file|文件名/i),
    range: indexOfColumn(table.header, /区间|范围|时间|range|time/i),
    duration: indexOfColumn(table.header, /时长|长度|duration/i),
  };
  return table.rows.map((cells, order) => ({
    no: Number(cleanCell(cells[at.no])) || order + 1,
    file: at.file >= 0 ? cleanCell(cells[at.file]) : "",
    range: at.range >= 0 ? cleanCell(cells[at.range]) : "",
    duration: at.duration >= 0 ? cleanCell(cells[at.duration]) : "",
  }));
}

/**
 * 分镜表 → `{shot, time, title, text}`。
 *
 * 列名认镜号 / 时间 / 标题 / 文字；认不全就按位置取（第 1 列镜号、第 2 列时间…）。
 * 没有分镜文件时调用方传空串进来，这里回空数组。
 * @param {string} text
 */
export function parseStoryboard(text) {
  const table = parseTables(text).find((one) => one.rows.length);
  if (!table) return [];
  const at = {
    shot: indexOfColumn(table.header, /镜号|镜头|^镜$|序号|^no$|^shot$/i),
    time: indexOfColumn(table.header, /时间|时长|区间|^time$/i),
    title: indexOfColumn(table.header, /标题|画面|场景|^title$|^scene$/i),
    text: indexOfColumn(table.header, /文字|口播|台词|文案|内容|^text$|^voice$/i),
  };
  return table.rows.map((cells) => ({
    shot: at.shot >= 0 ? cleanCell(cells[at.shot]) : cleanCell(cells[0]),
    time: at.time >= 0 ? cleanCell(cells[at.time]) : cleanCell(cells[1]),
    title: at.title >= 0 ? cleanCell(cells[at.title]) : cleanCell(cells[2]),
    text: at.text >= 0 ? cleanCell(cells[at.text]) : cleanCell(cells[3] ?? cells[cells.length - 1]),
  }));
}

/**
 * SRT / VTT → `[{index, start, end, text}]`。
 *
 * 时间轴不动（面板要按原时间对齐），只把 `,` 换成 `.` 统一成秒.毫秒的写法。
 * 解析不了的行跳过；文件不存在时回空数组。
 * @param {string} text
 */
export function parseSubtitles(text) {
  const src = String(text ?? "").replace(/\r\n?/g, "\n").replace(/^WEBVTT[^\n]*\n+/, "");
  const out = [];
  for (const block of src.split(/\n{2,}/)) {
    const lines = block.split("\n").filter((line) => line.trim() !== "");
    if (!lines.length) continue;
    const timeAt = lines.findIndex((line) => /-->/.test(line));
    if (timeAt < 0) continue;
    const [start = "", end = ""] = lines[timeAt].split("-->").map((part) => part.trim().replace(",", "."));
    const body = lines.slice(timeAt + 1).map((line) => line.replace(/<[^>]+>/g, "").trim()).filter(Boolean).join("\n");
    if (!body) continue;
    out.push({
      index: Number(lines[0]) || out.length + 1,
      start,
      end,
      text: body,
    });
    if (out.length >= 2000) break; // 兜底：一集字幕不该有这么多条
  }
  return out;
}

// ── 单期 ────────────────────────────────────────────────────────────────────

/**
 * JSON 分镜（`[{镜号, 时间, 画面, 口播}]` 或 `{shots:[…]}`）→ 统一形状。
 * 现在的盘上还没有这种文件，但分镜由排版脚本产出时很可能是 JSON；解析不了回空数组。
 * @param {string} text
 */
export function parseStoryboardJson(text) {
  let doc = null;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(doc) ? doc
    : Array.isArray(doc?.shots) ? doc.shots
      : Array.isArray(doc?.storyboard) ? doc.storyboard : [];
  return list.slice(0, 400).map((row, index) => ({
    shot: String(row?.shot ?? row?.镜号 ?? row?.no ?? index + 1),
    time: String(row?.time ?? row?.时间 ?? ""),
    title: String(row?.title ?? row?.画面 ?? row?.scene ?? ""),
    text: String(row?.text ?? row?.口播 ?? row?.voice ?? ""),
  }));
}

/** 按优先级找第一个存在的候选文件。 */
async function firstExisting(dir, names) {
  for (const name of names) {
    const path = join(dir, name);
    if (await exists(path)) return path;
  }
  return "";
}

/**
 * 读一期。
 *
 * 返回的 `dir` 是期目录名（相对 `07-video/episode`），与 `scanEpisodes` 里的一致。
 * 缺件不抛：`script` 回空串、`storyboard` / `subtitles` 回空数组，
 * 并在 `note` 里写清「盘上还没有什么」——**对现在的 FDE-01 就是这种情况**。
 * @param {string} input 期目录名（`FDE-01`）
 */
export async function readEpisode(input) {
  if (!repoRoot()) throw httpError(`还没配置真源仓库：设置环境变量 GZH_STUDIO_REPO（指向 social-media-management 那一级）`, 400);
  const id = safeEpisodeId(input);
  const root = episodeRoot();
  const candidate = resolve(root, id);
  const rel = relative(root, candidate);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw httpError("id 越界：不在视频期目录下面");

  const realRoot = await realpath(root).catch(() => null);
  const realDir = await realpath(candidate).catch(() => null);
  if (!realRoot) throw httpError(`找不到视频期目录：${root}`, 404);
  if (!realDir) throw httpError(`找不到这一期：${id}`, 404);
  if (!relative(realRoot, realDir) || relative(realRoot, realDir).startsWith("..")) {
    throw httpError("id 越界：符号链接指到了期目录外面");
  }
  const info = await stat(realDir).catch(() => null);
  if (!info?.isDirectory()) throw httpError(`不是期目录：${id}`, 404);  const files = probeEpisode(await listEntries(realDir));

  // 空目录也算「这一期在，但什么都还没做」：照常往下读，读出空数组 + note，
  // 不因为缺件抛错（缺件是正常状态，不是错误）。
  const scriptPath = await firstExisting(realDir, ["口播稿.md", "script.md", "口播稿.txt", "script.txt", "口播.md"]);
  const storyboardPath = await firstExisting(realDir, ["分镜.md", "storyboard.md", "storyboard.json", "分镜.json"]);
  const segmentPath = await firstExisting(realDir, [
    join("audio-segments", "分段索引.md"),
    join("audio-segments", "index.md"),
    "分段索引.md",
  ]);
  const subtitlePath = await firstExisting(realDir, ["字幕.srt", "subtitle.srt", "字幕.vtt", "subtitle.vtt"]);
  const outlinePath = await firstExisting(realDir, ["大纲.md", "outline.md", "大纲.txt", "outline.txt"]);

  const script = scriptPath ? await readText(scriptPath) : "";
  const storyboard = !storyboardPath
    ? []
    : /\.json$/i.test(storyboardPath)
      ? parseStoryboardJson(await readText(storyboardPath))
      : parseStoryboard(await readText(storyboardPath));
  const segments = segmentPath ? parseSegments(await readText(segmentPath)) : [];
  const subtitles = subtitlePath ? parseSubtitles(await readText(subtitlePath)) : [];

  // 缺什么就说什么（面板上「还没有」是正常状态，但要能看出缺的是哪几件）
  const missing = [];
  if (!script) missing.push("口播稿");
  if (!storyboard.length) missing.push("分镜");
  if (!segmentPath) missing.push("分段索引");
  if (!subtitles.length) missing.push("字幕");
  const note = missing.length
    ? `盘上还没有：${missing.join("、")}${segments.length ? `；分段取自 ${relative(realDir, segmentPath).replace(/\\/g, "/")}` : ""}`
    : "";

  return {
    id,
    dir: id,
    // 期目录的绝对路径：面板要能「复制产物路径」，好让人直接去文件夹里拿成片。
    dirPath: realDir,
    title: firstHeading(outlinePath ? await readText(outlinePath) : "") || firstHeading(script) || id,
    outline: outlinePath ? await readText(outlinePath) : "",
    script,
    storyboard,
    segments,
    subtitles,
    // 可视媒体：成片 / 封面 / 分镜图 / 字幕文件。面板据此出 <video>、封面和字幕轨。
    media: await listEpisodeMedia(realDir),
    note,
    // 单期详情也返回八步件状态，前端可以在缺件空态中逐步解释，避免只显示空白 tab。
    files: {
      outline: files.outline,
      script: files.script,
      storyboard: files.storyboard,
      audio: files.audio,
      segments: files.segments,
      subtitle: files.subtitle,
      cover: files.cover,
      final: files.final,
    },
  };
}

// ── 可视媒体（成片 / 封面 / 分镜图 / 字幕）──────────────────────────────────
//
// 面板要「视频跑出来就能在面板上放」，所以这一层得回答两个问题：
// 这一期盘上有什么能放的（`listEpisodeMedia`），以及某个文件怎么安全地发出去（`mediaFile`）。
// 视频走 Range 流式发（见 `index.js` 的 `ROUTES.media`），不整文件读进内存。

/** 媒体类型白名单：只发这几种，别的一律 415（`.exe` / `.ps1` 不该被浏览器当资源取走）。 */
const MEDIA_MIME = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".vtt": "text/vtt; charset=utf-8",
  ".srt": "text/plain; charset=utf-8",
  ".ass": "text/plain; charset=utf-8",
};

/** 文档里的第一个标题（`# xxx`，没有就取第一行正文）。取不到回空串，不抛。 */
export function firstHeading(text) {
  for (const line of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const heading = /^#{1,3}\s+(.+)$/.exec(trimmed);
    if (heading) return cleanCell(heading[1]).slice(0, 80);
    if (/^[-*>|`]/.test(trimmed)) continue;
    return cleanCell(trimmed).slice(0, 80);
  }
  return "";
}

/** 递归列文件（限深度 3、总数 400：一期目录里通常只有几十个文件）。 */
async function walkFiles(dir, base = "", out = [], depth = 0) {
  if (depth > 3 || out.length > 400) return out;
  for (const entry of await listEntries(join(dir, base))) {
    if (isHidden(entry.name)) continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walkFiles(dir, rel, out, depth + 1);
    } else if (entry.isFile()) {
      const info = await stat(join(dir, rel)).catch(() => null);
      if (info) out.push({ rel, name: entry.name, bytes: info.size, mtime: info.mtimeMs });
    }
  }
  return out;
}

/**
 * 一期里的可视媒体。路径一律是**相对期目录的 POSIX 路径**（`final/xxx.mp4`），
 * 面板拿去拼 `?id=` + `?rel=`，不碰盘上绝对路径。
 * @param {string} dir 期目录（已经过校验的绝对路径）
 */
export async function listEpisodeMedia(dir) {
  const files = await walkFiles(dir);
  const pick = (test) => files.filter((file) => test(file)).slice(0, 40);
  return {
    // 成片：任何视频文件都算（不苛求放在 final/ 下）
    final: pick((file) => VIDEO_EXT.test(file.name)).sort((a, b) => a.rel.localeCompare(b.rel)),
    cover: pick((file) => IMAGE_EXT.test(file.name) && /(^|\/)(cover|封面)/i.test(file.rel)),
    storyboard: pick((file) => IMAGE_EXT.test(file.name) && /(^|\/)(storyboard|分镜)/i.test(file.rel)),
    subtitle: pick((file) => SUBTITLE_EXT.test(file.name))[0] ?? null,
    audio: pick((file) => AUDIO_EXT.test(file.name)).slice(0, 6),
  };
}

/**
 * 把「期号 + 相对路径」解析成一个可下发的文件。
 *
 * 三道闸：`id` 只能是期目录名；`rel` 不能是绝对路径 / 盘符 / 含 `..`；
 * 解析后（含符号链接）必须仍在期目录下面。类型不在白名单里直接 415。
 * @param {string} input 期目录名
 * @param {string} relPath 相对期目录的文件路径
 */
export async function mediaFile(input, relPath) {
  if (!repoRoot()) throw httpError(`还没配置真源仓库：设置环境变量 GZH_STUDIO_REPO（指向 social-media-management 那一级）`, 400);
  const id = safeEpisodeId(input);
  const root = episodeRoot();
  const dir = resolve(root, id);
  const realRoot = await realpath(root).catch(() => null);
  const realDir = await realpath(dir).catch(() => null);
  if (!realRoot || !realDir) throw httpError(`找不到这一期：${id}`, 404);
  if (!relative(realRoot, realDir) || relative(realRoot, realDir).startsWith("..")) throw httpError("id 越界：不在视频期目录下面", 400);

  const clean = String(relPath ?? "").trim().replace(/\\/g, "/");
  if (!clean) throw httpError("缺少 rel 参数（相对期目录的文件路径）");
  if (clean.includes("\u0000")) throw httpError("rel 不合法（含 NUL）");
  if (isAbsolute(clean) || /^[a-zA-Z]:/.test(clean)) throw httpError("rel 不合法：不接受绝对路径");
  const target = resolve(realDir, clean);
  const relToDir = relative(realDir, target);
  if (!relToDir || relToDir.startsWith("..") || isAbsolute(relToDir)) throw httpError("rel 越界：不在这一期目录下面", 400);

  const real = await realpath(target).catch(() => null);
  if (!real) throw httpError("文件不存在", 404);
  if (relative(realDir, real).startsWith("..")) throw httpError("rel 越界：符号链接指到期目录外面", 400);
  const info = await stat(real).catch(() => null);
  if (!info?.isFile()) throw httpError("不是文件", 404);
  const ext = extname(real).toLowerCase();
  const mime = MEDIA_MIME[ext];
  if (!mime) throw httpError(`不支持的文件类型：${ext || "无扩展名"}`, 415);
  return { path: real, size: info.size, mime, name: basename(real), mtime: info.mtimeMs };
}
