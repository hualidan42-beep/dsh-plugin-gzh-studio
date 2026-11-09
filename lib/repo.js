/**
 * 真源仓库（**只读**）：`03-scripts` 下的稿件目录 + 质量门状态。
 *
 * 这一层的定位与 `store.js` 正相反：
 * - `store.js` 管的是**工作台自己的库**（可写，`~/.dsh/gzh-studio`）；
 * - 这里管的是**内容生产的事实源**（绝不写、绝不改、绝不建目录），
 *   只回答「盘上有什么」。
 *
 * 三条口径：
 *
 * 1. **列表不读正文**。`scanArticles` 只做 `readdir` + `stat`，一篇稿子都不 open——
 *    33 篇稿子的正文加起来 1.2 MB，首页列表把它们全塞进内存再序列化，
 *    一次刷新就够把面板拖住。正文只在 `readArticle` 里按单篇读。
 * 2. **路径一律「解析后前缀比对」**。`dir` 参数先挡掉盘符 / UNC / 绝对路径 / `..`，
 *    再 `resolve` 到 `03-scripts` 下面，再 `realpath` 比对一次（挡符号链接逃逸）。
 *    两道都过不去就抛 400，**绝不进 `join()`**。
 * 3. **缺文件不是错误**。稿件目录里 `intent.md` / `evidence.md` / `review.md` /
 *    `site/article.html` / `images/` 都可能还没有（第 21 期只有 `index.md` 和排版），
 *    少什么就报 false / 空串 / 0，不抛异常。
 *
 * 质量门的状态查询（`gateStatus`）也放在这里：它读的是同一批稿件目录，
 * 只是把「盘上有没有」换成「编辑部走到第几步」。
 * @module lib/repo
 */

import { execFile } from "node:child_process";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** 覆盖真源根目录的环境变量名。 */
export const REPO_ENV = "GZH_STUDIO_REPO";

/** `site/article.html` 一次最多下发多少字节（超过就截断并标 `htmlTruncated`）。 */
export const HTML_LIMIT = 200 * 1024;

/** 单篇最多切多少节（防一份手写的巨型 md 把面板撑爆）。 */
const MAX_SECTIONS = 80;
/** 单节正文上限。 */
const MAX_SECTION_CHARS = 50_000;

/** 质量门结果缓存时长（毫秒）：5 分钟。 */
export const GATE_TTL = 5 * 60 * 1000;
/** 缓存条目上限（超了先扔最老的）。 */
const GATE_CACHE_MAX = 128;

/** 目录名里的账号段（`日期_官方号_第NN期_标题` 的中间那段）。 */
const ACCOUNT_SEGMENTS = new Set(["官方号", "视频号", "小红书", "公众号", "服务号", "订阅号", "知乎", "B站"]);

/** 图像扩展名（`images/` 里算几张图）。 */
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|svg|avif)$/i;

/**
 * 真源仓库**没有**内置默认值。
 *
 * 早期这里写死了作者自己的业务目录。对市场版来说那是个假默认：
 * 对市场版来说那是个假默认：用户装上以后，面板会去读一个不存在的路径，
 * 或者更糟——读到别人的稿件。所以现在必须由用户显式配置
 * （环境变量 `GZH_STUDIO_REPO`，或设置页写入 `<root>/settings.json` 的 `pipelineRoot`）。
 * 没配就是「未配置」这个正常状态，不是错误。
 */
export const DEFAULT_REPO_ROOT = "";

/**
 * 真源根目录。
 *
 * **每次调用都读环境变量**（不缓存）：测试要能临时指到别处，装错了也能靠改环境变量救，
 * 而不是重装插件。相对路径按进程 cwd 解析（loader 配置里写相对路径的少数情况）。
 * @param {Record<string, string|undefined>} [env]
 * @returns {string} 没配置时返回空串
 */
export function repoRoot(env = process.env) {
  const raw = String(env?.[REPO_ENV] ?? "").trim();
  return raw ? resolve(raw) : DEFAULT_REPO_ROOT;
}

/** 真源仓库配了没有（面板据此显示「未配置」而不是「读不到」）。 */
export function repoConfigured(env = process.env) {
  return Boolean(String(env?.[REPO_ENV] ?? "").trim());
}

/** 没配真源仓库时的统一错误：说得清「怎么配」，而不是丢一个 ENOENT。 */
function notConfigured() {
  return httpError(`还没配置真源仓库：设置环境变量 ${REPO_ENV}（指向你的内容仓库根目录），或在设置里填「产线根」`, 400);
}

/** `03-scripts`（稿件库）。 */
export const scriptsRoot = () => join(repoRoot(), "03-scripts");

/** workspace 根：真源仓的上一级（质量门与社媒仓在这里并列）。 */
export const workspaceRoot = () => dirname(repoRoot());

/** 质量门入口脚本（`wechat-article-pipeline/gate/index.mjs`）。 */
export const gateScript = () => join(workspaceRoot(), "wechat-article-pipeline", "gate", "index.mjs");

/**
 * 视频期目录的**约定值**：`<真源仓库>/07-video/episode`。
 *
 * 这是 `episodesRoot()` 解析不到配置时的兜底，也是面板文案里该出现的那个路径。
 * 单列出来是为了让「约定」只有一个出处——散在 lib/index/client 三处就会各写各的。
 */
export const EPISODE_SUBDIR = join("07-video", "episode");

/** 覆盖期目录的环境变量名（`settings.json` 的 `episodesRoot` 在启动时写进这里）。 */
export const EPISODES_ENV = "GZH_STUDIO_EPISODES";

/**
 * 视频期根目录：环境变量 / 设置里有就用它，否则回落到约定值 `<真源仓库>/07-video/episode`。
 *
 * 为什么要有这个开关：`07-video/episode` 是**一套工作流约定**，不是每个用户都长这样
 * （有人把一期直接放在 `视频/` 下，有人按年份分目录）。以前这里是硬编码，
 * 想换只剩「改源码」一条路——那不该是市场版的答案。
 *
 * 值可以是绝对路径，也可以是相对真源仓库根的相对路径（相对值 `resolve` 到仓库下，
 * 搬仓库时配置不用跟着改）。带 `..` 的一律视为无效，回落到约定值：这个字段决定读哪个目录，
 * 不该成为爬出仓库的通道。
 * @param {Record<string, string|undefined>} [env]
 * @returns {string} 没配真源仓库时返回空串（调用方本来就要先判 `repoConfigured()`）
 */
export function episodesRoot(env = process.env) {
  const root = repoRoot(env);
  const raw = String(env?.[EPISODES_ENV] ?? "").trim();
  if (!raw) return root ? join(root, EPISODE_SUBDIR) : "";
  if (hasParentEscape(raw)) return root ? join(root, EPISODE_SUBDIR) : "";
  /**
   * **绝对路径不依赖真源仓库。**
   *
   * 原来这里是 `if (!root) return ""`，于是「视频期目录」被绑死在内容仓库上：
   * 没配仓库的人连「建一个自己的视频目录」都做不到。可视频这条线和文章仓库本来无关——
   * 有人根本不写公众号稿，只做视频。所以显式指了绝对路径就用它；
   * 相对路径仍按仓库根解析（那种写法本来就意味着「我有个仓库」）。
   */
  if (isAbsolute(raw)) return resolve(raw);
  return root ? resolve(root, raw) : "";
}

/** 路径里有没有 `..` 段（`episodesRoot` 这种纯路径字段的栅栏；`.` 段无害，不拦）。 */
function hasParentEscape(text) {
  return String(text ?? "")
    .split(/[\\/]+/)
    .some((part) => part === "..");
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

/** 带 HTTP 状态的错误（路由层据此回 400 / 404 / 502，与 `store` 的写法一致）。 */
function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 列出目录里的条目（不存在 / 不可读一律回空表，不抛）。 */
async function listEntries(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** 读文本；不存在 / 读坏了回空串。 */
async function readText(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/** 隐藏 / 临时目录：`.` 与 `_` 开头的一律不当作稿件或内容线。 */
const isHidden = (name) => !name || name.startsWith(".") || name.startsWith("_");

/**
 * `target` 是否真的在 `base` 下面（同层不算）。
 * Windows 上大小写不敏感由 `relative` 自己处理。
 */
function inside(base, target) {
  const rel = relative(base, target);
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * 把外部传进来的 `dir` 拆成路径段。
 *
 * 这一步是**栅栏的第一道**，只做形态检查、不碰盘：
 * 盘符（`C:\`）、UNC（`\\server`）、绝对路径（`/x`）、`..`、`.`、空段、NUL 全部拒绝。
 * 拒绝而不是「清洗」——清洗过的路径还能继续用，人会以为自己传对了。
 * @param {string} input
 * @returns {string[]}
 */
export function splitDirParam(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw httpError("缺少 dir 参数（要 03-scripts 下的相对目录，或稿件目录名）");
  if (raw.includes("\u0000")) throw httpError("dir 参数不合法（含 NUL）");
  if (/^[a-zA-Z]:/.test(raw)) throw httpError("dir 参数不合法：不接受盘符，只收 03-scripts 下的相对目录");
  if (/^[\\/]/.test(raw)) throw httpError("dir 参数不合法：不接受绝对路径 / UNC");
  const parts = raw.replace(/\\/g, "/").split("/").filter((part) => part !== "");
  if (!parts.length) throw httpError("dir 参数不合法（空路径）");
  if (parts.some((part) => part === "." || part === "..")) {
    throw httpError("dir 参数不合法：不接受 . 或 ..");
  }
  return parts;
}

/**
 * 目录名 → `{date, title}`。
 *
 * 口径是合同写的 `日期_账号_第NN期_标题`：
 * - `2026-08-03_官方号_第21期_AI演示编排` → date `2026-08-03`，title `AI演示编排`；
 * - `2026-08-03_培训回顾_Merck线上AI工作流实战`（培训线，没有账号段也没有期号）
 *   → date `2026-08-03`，title `培训回顾 Merck线上AI工作流实战`（把分隔符还原成空格，
 *   不然标题里会带一串下划线）；
 * - 取不到就退回目录名本身。
 * @param {string} name
 * @returns {{date: string, title: string}}
 */
export function parseDirName(name) {
  const text = String(name ?? "").trim();
  const matched = /^(\d{4}-\d{2}-\d{2})_(.+)$/.exec(text);
  if (!matched) return { date: "", title: text };

  const rest = matched[2];
  const parts = rest.split("_").filter(Boolean);
  let stripped = false;
  if (parts.length > 1 && ACCOUNT_SEGMENTS.has(parts[0])) {
    parts.shift();
    stripped = true;
  }
  if (parts.length > 1 && /^第[0-9一二三四五六七八九十百]+期$/.test(parts[0])) {
    parts.shift();
    stripped = true;
  }
  // 既没有账号段也没有期号（培训 / 复盘 / 私享会这类）：保留全部，只把下划线还原成空格
  const title = stripped ? parts.join("_") : rest.replace(/_/g, " ");
  return { date: matched[1], title: title || text };
}

// ── 稿件目录的定位（栅栏）──────────────────────────────────────────────────

/**
 * 把 `dir` 解析成一个真实存在的稿件目录。
 *
 * 三种入参形态都收：
 * 1. `<内容线>/<稿件目录>`（规范形态，也是返回值）；
 * 2. 只给 `<稿件目录>`（`gate` 那边就是这么传的），跨内容线找一次；
 * 3. 大小写不同的写法（Windows 上 `readdir` 回的是盘上的真实名，这里按真实名回填）。
 *
 * 解析链：形态检查 → `resolve` → 前缀比对 → `realpath` → 再比对一次 → `stat` 确认是目录。
 * @param {string} input
 * @returns {Promise<{root: string, dir: string, abs: string, line: string, id: string}>}
 */
export async function resolveArticleDir(input) {
  if (!repoRoot()) throw notConfigured();
  const parts = splitDirParam(input);
  const scripts = scriptsRoot();
  const root = repoRoot();

  let dir = parts.join("/");
  if (parts.length === 1) {
    // 只给了目录名：跨内容线找（不猜，只认盘上真实存在的那个）
    const found = await findArticleDirByName(parts[0]);
    if (!found) throw httpError(`找不到稿件目录：${parts[0]}`, 404);
    dir = found;
  }

  const candidate = resolve(scripts, dir);
  if (!inside(scripts, candidate)) {
    throw httpError("dir 越界：解析后不在 03-scripts 下面");
  }

  const realBase = await realpath(scripts).catch(() => null);
  const realDir = await realpath(candidate).catch(() => null);
  if (!realBase) throw httpError(`真源仓库里没有 03-scripts：${scripts}`, 404);
  if (!realDir) throw httpError(`稿件目录不存在：${dir}`, 404);
  // 第二道：符号链接指到 03-scripts 外面也拦掉
  if (!inside(realBase, realDir)) throw httpError("dir 越界：符号链接指到了 03-scripts 外面");

  const info = await stat(realDir).catch(() => null);
  if (!info?.isDirectory()) throw httpError(`不是稿件目录：${dir}`, 404);

  const segments = dir.split("/");
  const id = segments[segments.length - 1];
  return { root, dir, abs: realDir, line: segments.slice(0, -1).join("/") || segments[0], id };
}

/** 在全部内容线里按目录名找一个稿件目录，返回 `<内容线>/<目录名>`。 */
async function findArticleDirByName(name) {
  const scripts = scriptsRoot();
  for (const line of await listEntries(scripts)) {
    if (!line.isDirectory() || isHidden(line.name)) continue;
    for (const entry of await listEntries(join(scripts, line.name))) {
      if (entry.isDirectory() && !isHidden(entry.name) && entry.name === name) {
        return `${line.name}/${entry.name}`;
      }
    }
  }
  return null;
}

// ── 列表 ────────────────────────────────────────────────────────────────────

/** 数 `images/` 里的图（只看扩展名，不读内容）。 */
async function countImages(path) {
  let count = 0;
  for (const entry of await listEntries(path)) {
    if (entry.isDirectory()) {
      // 图不多，但允许一层子目录（`images/封面/…`）
      count += await countImages(join(path, entry.name));
      continue;
    }
    if (IMAGE_EXT.test(entry.name)) count += 1;
    if (count > 500) return count; // 兜底上限
  }
  return count;
}

/**
 * 探一篇稿子「有哪些件」。**只 stat / readdir，不读正文**。
 * @param {string} abs
 * @returns {Promise<{intent: boolean, evidence: boolean, review: boolean, html: boolean, images: number}>}
 */
export async function probeArticleFiles(abs) {
  const [intent, evidence, review, html, images] = await Promise.all([
    exists(join(abs, "intent.md")),
    exists(join(abs, "evidence.md")),
    exists(join(abs, "review.md")),
    exists(join(abs, "site", "article.html")),
    countImages(join(abs, "images")),
  ]);
  return { intent, evidence, review, html, images };
}

/**
 * 扫全部稿件。
 *
 * `lines` 是**盘上的内容线目录**（含空的：`knowledge/`、`marketing/` 现在只有 README，
 * `published/` 是已发归档、里面是平铺的 `.md` 而不是稿件目录，所以它的 count 是 0）。
 * 计数与列表来自同一次遍历，不会出现「说 33 篇、列表 32 篇」。
 *
 * @returns {Promise<{root: string, lines: {line: string, count: number}[], articles: object[]}>}
 */
export async function scanArticles() {
  const root = repoRoot();
  // 没配真源仓库：这是「未配置」，不是「读坏了」。面板要能区分这两件事。
  if (!root) return { root: "", configured: false, lines: [], articles: [] };
  const scripts = join(root, "03-scripts");
  const lines = [];
  const articles = [];

  for (const lineEntry of await listEntries(scripts)) {
    if (!lineEntry.isDirectory() || isHidden(lineEntry.name)) continue;
    const line = lineEntry.name;
    const lineDir = join(scripts, line);
    let count = 0;

    for (const entry of await listEntries(lineDir)) {
      if (!entry.isDirectory() || isHidden(entry.name)) continue;
      const abs = join(lineDir, entry.name);
      const meta = parseDirName(entry.name);
      articles.push({
        dir: `${line}/${entry.name}`,
        line,
        id: entry.name,
        title: meta.title,
        date: meta.date,
        files: await probeArticleFiles(abs),
      });
      count += 1;
    }
    lines.push({ line, count });
  }

  // 排序：线按条数从多到少（空线沉底），稿子按日期从新到旧（同日按目录名，结果稳定）
  lines.sort((a, b) => b.count - a.count || a.line.localeCompare(b.line, "zh"));
  articles.sort((a, b) => (b.date || "").localeCompare(a.date || "") || a.dir.localeCompare(b.dir, "zh"));
  return { root, lines, articles };
}

// ── 单篇 ────────────────────────────────────────────────────────────────────

/**
 * 拆 frontmatter（尽力解析，不是完整 YAML）。
 *
 * 只要四样：`key: value`、`- 列表项`、去引号、跳过缩进更深的嵌套块。
 * 解析不了的行直接忽略——**渲染靠的是正文，不是 frontmatter**，
 * 这里挂掉只会让面板少显示一个字段，不该让整篇读不出来。
 * @param {string} text
 * @returns {{data: Record<string, string|string[]>, body: string}}
 */
export function parseFrontmatter(text) {
  const src = String(text ?? "").replace(/\r\n?/g, "\n");
  const matched = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (!matched) return { data: {}, body: src };

  const data = {};
  let lastKey = "";
  for (const line of matched[1].split("\n")) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      const key = kv[1];
      const value = kv[2].trim();
      lastKey = key;
      if (!value) { data[key] = []; continue; } // 后面跟列表
      data[key] = value.replace(/^["']|["']$/g, "").slice(0, 400);
      continue;
    }
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && lastKey) {
      if (!Array.isArray(data[lastKey])) data[lastKey] = [];
      data[lastKey].push(item[1].trim().replace(/^["']|["']$/g, "").slice(0, 400));
    }
  }
  return { data, body: src.slice(matched[0].length) };
}

/**
 * `index.md` → 节。
 *
 * 按 H2 / H3 切（合同口径），正文原样保留段落换行（只 trim 两端）；
 * **没有 H2 就整篇一节**，`heading` 为空串；第一个 H2 之前的内容（导语、内联卡）
 * 也成一节，`heading` 为空串——那确实是正文，丢掉就等于读残了。
 * 首个 H1 从导语里摘掉：标题已经由 `title` 单独给了，正文里再来一条会重复显示。
 * @param {string} text
 * @returns {{heading: string, body: string}[]}
 */
export function parseSections(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  // 开头的空行先去掉，否则「首个 H1 摘掉」那条永远轮不到（第一行空行已经把节开起来了）
  while (lines.length && !lines[0].trim()) lines.shift();
  const sections = [];
  let current = null;
  let seenH1 = false;

  const flush = () => {
    if (!current) return;
    const body = current.lines.join("\n").trim();
    if (current.heading || body) {
      sections.push({ heading: current.heading, body: body.slice(0, MAX_SECTION_CHARS) });
    }
    current = null;
  };

  for (const line of lines) {
    const heading = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      current = { heading: heading[2].trim(), lines: [] };
      continue;
    }
    if (!current && !seenH1 && /^#\s+\S/.test(line)) {
      seenH1 = true; // 首个 H1 = 标题，正文里不重复
      continue;
    }
    current ??= { heading: "", lines: [] };
    current.lines.push(line);
  }
  flush();
  return sections.slice(0, MAX_SECTIONS);
}

/**
 * 正文标题：frontmatter 的 `title` → 第一个 H1 → 目录名推出来的标题。
 * @param {Record<string, unknown>} frontmatter
 * @param {string} body
 * @param {string} fallback
 */
function pickTitle(frontmatter, body, fallback) {
  const declared = String(frontmatter?.title ?? "").trim();
  if (declared) return declared;
  const h1 = /^#\s+(.+?)\s*$/m.exec(body ?? "");
  if (h1) return h1[1].trim();
  return fallback;
}

/**
 * 读单篇。
 *
 * 返回的 `dir` 是**规范相对路径**（`<内容线>/<目录名>`），可以直接回传给本模块的
 * 任何函数——不返回绝对路径，是为了让面板不用做「绝对路径转相对」这种必错的转换。
 *
 * `title` 取稿件自己的标题（frontmatter / H1），取不到才退回目录名：
 * 列表里的 `title` 按合同来自目录名，详情页显示稿件真标题——两处不一致是**有意的**，
 * 目录名里的「标题段」只是给列表用的短名。
 *
 * `html` 超过 200 KB 就截断并标 `htmlTruncated`（`htmlBytes` 是原始字节数，
 * 面板要显示「已截断，共 312 KB」时不用再猜）。
 * @param {string} input `03-scripts` 下的相对目录，或稿件目录名
 */
export async function readArticle(input) {
  const target = await resolveArticleDir(input);
  const meta = parseDirName(target.id);

  const [rawIndex, intent, evidence, review, htmlInfo] = await Promise.all([
    readText(join(target.abs, "index.md")),
    readText(join(target.abs, "intent.md")),
    readText(join(target.abs, "evidence.md")),
    readText(join(target.abs, "review.md")),
    readHtml(join(target.abs, "site", "article.html")),
  ]);
  const { data, body } = parseFrontmatter(rawIndex);

  return {
    dir: target.dir,
    title: pickTitle(data, body, meta.title || target.id),
    // 目录名里的日期优先；老稿偶尔没写日期，退回 frontmatter 的 updated
    date: meta.date || String(data.updated ?? "").slice(0, 10),
    line: target.line,
    intent,
    evidence,
    review,
    html: htmlInfo.text,
    htmlTruncated: htmlInfo.truncated,
    htmlBytes: htmlInfo.bytes,
    sections: parseSections(body),
    // 附加：稿件自述（status / digest / cover / content_line / business_category …）。
    // 合同里没有这个键，但下一轮 UI 要显示「草稿 / 摘要 / 封面路径」时不必再读一遍盘。
    frontmatter: data,
  };
}

/** 读排版稿：超过上限按**字节**截断，别把整块 HTML 塞进首屏。 */
async function readHtml(path) {
  let buffer;
  try {
    buffer = await readFile(path);
  } catch {
    return { text: "", truncated: false, bytes: 0 };
  }
  const bytes = buffer.length;
  if (bytes <= HTML_LIMIT) return { text: buffer.toString("utf8"), truncated: false, bytes };

  // 按字节切，但不能切在 UTF-8 多字节字符中间：`fatal` 解码失败就往回退一格再试。
  // 中文排版稿一个字 3 字节，直接 `slice` 字符串会把 200 KB 砍成几十 KB 的「字符」，
  // 也可能留下半个字符（浏览器显示成 ）。
  for (let end = HTML_LIMIT; end > HTML_LIMIT - 4; end -= 1) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, end));
      return { text, truncated: true, bytes };
    } catch {
      // 退一格再试（最多三次，UTF-8 最长 4 字节）
    }
  }
  return { text: buffer.subarray(0, HTML_LIMIT).toString("utf8"), truncated: true, bytes };
}

// ── 质量门 ──────────────────────────────────────────────────────────────────

/** 缓存：键 = `dir` + 稿件目录 mtime，值是已经映射好的视图。 */
const gateCache = new Map();

/** 清缓存（测试 / 手工救急用；`dir` 省略表示全清）。 */
export function clearGateCache(dir) {
  if (!dir) { gateCache.clear(); return; }
  const key = String(dir);
  for (const cacheKey of gateCache.keys()) {
    if (cacheKey.startsWith(`${key}\u0000`)) gateCache.delete(cacheKey);
  }
}

/**
 * 从 gate 输出里抠 JSON。
 *
 * gate 先打一段人看的提示和表格，再打 `JSON：` 后跟一段 JSON，**所以要从最后一个
 * `JSON：` 之后取**（前面可能还有一份给人看的样例）。找不到标记或解析不了返回 `null`，
 * 由调用方给出可读的错误——这里不抛，解析函数不该决定 HTTP 状态。
 *
 * 注意 JSON 字符串里的换行是转义过的 `\n`（两个字符），所以「最后一个 `\nJSON：`」
 * 一定落在真正的分隔行上，不会误命中 JSON 内容里的同名字样。
 * @param {string} text
 * @returns {object|null}
 */
export function parseGateJson(text) {
  const src = String(text ?? "").replace(/\r\n?/g, "\n");
  const hits = [...src.matchAll(/(?:^|\n)JSON[：:]/g)];
  const last = hits[hits.length - 1];
  if (!last) return null;
  const rest = src.slice(last.index + last[0].length);
  const start = rest.indexOf("{");
  const end = rest.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(rest.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * gate 的中文 JSON → 合同里的英文键。
 *
 * `编号→no`、`名称→name`、`结论→verdict`、`轮次→round`、`过门→pass`、`下一步→next`。
 * 英文键也认（`check` 子命令与老版本可能给英文），两套都读，输出只有一套。
 * @param {object} doc
 * @param {string} dir 规范相对目录（回给面板的就是它）
 */
export function toGateView(doc, dir) {
  const rawSteps = Array.isArray(doc?.步骤) ? doc.步骤 : Array.isArray(doc?.steps) ? doc.steps : [];
  const steps = rawSteps.map((step) => ({
    no: Number(step?.编号 ?? step?.no) || 0,
    name: String(step?.名称 ?? step?.name ?? ""),
    verdict: String(step?.结论 ?? step?.verdict ?? ""),
    round: Number(step?.轮次 ?? step?.round) || 0,
    pass: step?.过门 === true || step?.pass === true,
  }));
  return {
    dir,
    runId: String(doc?.runId ?? ""),
    line: String(doc?.内容线 ?? doc?.line ?? ""),
    steps,
    next: doc?.下一步 ?? doc?.next ?? null,
  };
}

/** execFile 的 promise 包装：**非零退出也算拿到输出**（gate 的 check 会以 1–3 退出）。 */
function runFile(file, args, options) {
  return new Promise((done) => {
    execFile(file, args, { ...options }, (error, stdout, stderr) => {
      done({ error, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/**
 * 质量门状态：`gate status <稿件目录>`。
 *
 * 为什么必须缓存：一次 `gate status` 要几百毫秒到数秒（要读 `review.md` 判轮次），
 * 首页列表每篇跑一次就是几十秒。**同一目录 5 分钟内只真跑一次**，
 * 键里带稿件目录的 mtime——目录一动（新审阅记录写进来）缓存自然失效，
 * 不用手工点「刷新」。
 *
 * @param {string} input `03-scripts` 下的相对目录，或稿件目录名
 * @param {{ttl?: number, timeout?: number}} [options]
 * @returns {Promise<{dir: string, runId: string, line: string, steps: object[], next: unknown}>}
 */
export async function gateStatus(input, options = {}) {
  const target = await resolveArticleDir(input);
  const scripts = String(gateScript());
  const workspace = workspaceRoot();

  const info = await stat(target.abs).catch(() => null);
  const mtime = Math.round(Number(info?.mtimeMs) || 0);
  const key = `${target.dir}\u0000${mtime}`;
  const now = Date.now();
  const ttl = Number(options.ttl) >= 0 ? Number(options.ttl) : GATE_TTL;

  const hit = gateCache.get(key);
  if (hit && now - hit.at < ttl) return hit.view;

  if (!(await exists(scripts))) {
    throw httpError(`找不到质量门：${scripts}（本机没装 wechat-article-pipeline？）`, 502);
  }

  // gate 的路径参数必须相对 **workspace 根**（它就是这么解析的）
  const relPath = relative(workspace, target.abs).replace(/\\/g, "/");
  if (!relPath || relPath.startsWith("..")) {
    throw httpError(`稿件目录不在 workspace 根下面，质量门跑不了：${target.abs}`, 502);
  }

  const { error, stdout, stderr } = await runFile(process.execPath, [scripts, "status", relPath], {
    cwd: workspace,
    timeout: Number(options.timeout) > 0 ? Number(options.timeout) : 20_000,
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    encoding: "utf8",
    env: process.env,
  });

  const combined = `${stdout}\n${stderr}`;
  const doc = parseGateJson(stdout) ?? parseGateJson(combined);
  if (!doc) {
    if (error) {
      const timedOut = error.killed || error.signal || /timed? ?out/i.test(String(error.message));
      const detail = String(error.message ?? error).split("\n")[0].slice(0, 200);
      throw httpError(
        timedOut
          ? `质量门超时（20 秒）：${relPath}`
          : `质量门跑失败：${detail}${stderr.trim() ? `（stderr：${stderr.trim().slice(0, 200)}）` : ""}`,
        502,
      );
    }
    throw httpError(`质量门输出里找不到可解析的 JSON：${relPath}`, 502);
  }

  const view = toGateView(doc, target.dir);
  gateCache.set(key, { at: now, view });
  if (gateCache.size > GATE_CACHE_MAX) {
    // 超上限就扔最老的一条（Map 保留插入顺序）
    const oldest = gateCache.keys().next().value;
    if (oldest !== undefined) gateCache.delete(oldest);
  }
  return view;
}
