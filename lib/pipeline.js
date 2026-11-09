/**
 * 流水线状态机：回答「这篇卡在哪一步」。
 *
 * 依据（唯一事实源，不可自造）：
 *   - `~/.workbuddy/skills/PIPELINE.md` §4 状态词表
 *   - `~/.workbuddy/skills/wechat/00-pipeline/SKILL.md` §「定位当前状态」的 10 步顺序
 *
 * 三条设计原则，都是从那条线踩过的坑里来的：
 *
 * 1. **不自造状态词**。词表九个值之外一律不返回；查不出来时返回 `unknown` 的气道由
 *    `needs-review` 承担（它的原意就是「配置/字段/媒体错误，需人看」）。
 * 2. **判据不可用 ≠ 缺件**。找不到机器判据时标 `unknown`，不标 `fail`——
 *    把「没有判据」说成「没做到」，会让人去补一份本来就不该存在的文件。
 * 3. **哈希说了算**。确认记录里绑的是 sha256，所以正文/排版/封面任何一个字节变了，
 *    旧确认就作废。时间戳挡不住「改完又改回来」，哈希能。
 */

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";

/** PIPELINE.md §4 的全集。多一个都不许出现。 */
export const STATUS = {
  READY: "ready",
  NEEDS_INVENTORY: "needs-published-inventory",
  NEEDS_RESEARCH: "needs-research",
  NEEDS_AUDIT: "needs-browser-audit",
  NEEDS_USER_APPROVAL: "needs-user-approval",
  NEEDS_VIDEO_COVER: "needs-video-cover",
  NEEDS_DRAFT_APPROVAL: "needs-draft-approval",
  NEEDS_REVIEW: "needs-review",
  DRY_RUN: "dry-run",
};

/** 状态 → 该回哪一步、加载哪个 skill。文案要能直接照着做。 */
export const STATUS_ROUTE = {
  [STATUS.READY]: { step: "11-digest-draft", skill: "wechat-11-digest-draft", hint: "全部门禁通过，可以补摘要推草稿。" },
  [STATUS.NEEDS_INVENTORY]: { step: "01-kickoff", skill: "wechat-01-kickoff", hint: "人物清单缺失或未标 complete，先补清单再定题。" },
  [STATUS.NEEDS_RESEARCH]: { step: "02-evidence", skill: "wechat-02-evidence", hint: "证据台账缺失，或还有 unverified/rejected 的条目拟入稿。" },
  [STATUS.NEEDS_AUDIT]: { step: "07-deai", skill: "wechat-07-deai", hint: "无匹配当前文字的 Chrome 核验收据，须在文字冻结处重核。" },
  [STATUS.NEEDS_USER_APPROVAL]: { step: "07-deai", skill: "wechat-07-deai", hint: "缺哈希匹配的制作确认，停在交稿，等人明确说「制作」。" },
  [STATUS.NEEDS_VIDEO_COVER]: { step: "05-produce", skill: "history-video-05-produce", hint: "缺合规原生 9:16 封面。" },
  [STATUS.NEEDS_DRAFT_APPROVAL]: { step: "10-quality-gate", skill: "wechat-10-quality-gate", hint: "缺排版校验留痕；在第 10 步同意即授权推草稿。" },
  [STATUS.NEEDS_REVIEW]: { step: "00-pipeline", skill: "wechat-pipeline", hint: "有判据不可用或字段异常，需人看一眼再定去哪个。" },
  [STATUS.DRY_RUN]: { step: "11-digest-draft", skill: "wechat-11-digest-draft", hint: "草稿只是模拟回执（persisted=false），不得宣称已保存。" },
};

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

/**
 * 期号允许的形态：常规文件名字符，**但禁止路径分隔符、Windows 非法字符与 `..`**。
 *
 * 期号会被拼进 `join(dataDir, "research", `${episodeId}.json`)`，
 * 所以它其实是路径的一段。只做 `trim().slice()` 的话，`..\..\x` 就能让
 * `/api/gzh-studio.pipeline` 读到工作台数据目录以外任意 `*.json`
 * （回执里会带条目数与 id，等于白送一个存在性探针）。
 * 这里放行中文与空格，是为了不弄坏已有的「027 史记」这类期号。
 *
 * @param {unknown} value
 * @returns {string|null} 合法则返回 trim 后的期号，否则 null
 */
export function checkEpisodeId(value) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 80) return null;
  if (text === "." || text === ".." || text.includes("..")) return null;
  if (/[\\/\u0000-\u001f<>:"|?*]/.test(text)) return null;
  return text;
}

/** 路径分隔符与 `..` 的同款栅栏，给「产线根目录」这类纯路径字段用。 */
function hasParentEscape(text) {
  return text.split(/[\\/]+/).some((part) => part === "..");
}

/** 读文件算哈希；不存在返回 null（不抛，缺件由调用方按语义判）。 */
export async function sha256File(path) {
  try {
    return sha256(await readFile(path));
  } catch {
    return null;
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

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function listDir(path) {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

/**
 * 工作台自己那份正文的规范化哈希。
 *
 * 用途只有一个：判断「绑定之后我在这台面板上又改过字没有」。
 * 它与文件哈希不是一回事——文件哈希认的是 `最终交付/…/10-公众号-文案.md` 那份，
 * 面板里的分段结构是另一份表示。两者混用会得出「改了一个空格也算全篇作废」或
 * 「改了半段却说没变」两种错，所以分开算、分开报。
 */
export function articleHash(article) {
  const parts = [
    String(article?.title ?? "").trim(),
    String(article?.subtitle ?? "").trim(),
    String(article?.summary ?? "").trim(),
    ...(Array.isArray(article?.sections) ? article.sections : []).map(
      (section) => `${String(section?.heading ?? "").trim()}\u0001${String(section?.body ?? "").trim()}`,
    ),
  ];
  return sha256(Buffer.from(parts.join("\u0002"), "utf8"));
}

/** 从审批记录里挑「最新一次」——重签会新增文件，旧的不删，按 approved_at 取。 */
function latestApproval(list, suffix) {
  const hits = list.filter((name) => name.endsWith(suffix) && !name.startsWith("_superseded"));
  if (!hits.length) return null;
  return hits.sort().pop() ?? null;
}

/**
 * 一条门禁的判据结果。
 * state：`ok` 过 / `fail` 明确不过 / `stale` 记录在但哈希对不上 / `unknown` 找不到判据 / `skip` 本线不适用
 */
const gate = (no, key, label, state, detail, extra = {}) => ({ no, key, label, state, detail, ...extra });

/**
 * 重算状态词：只在**别的层的证据改变了某道门**之后用（当前唯一用途：面板勾满了 05 的清单）。
 *
 * 为什么不能简单地「取第一道非 ok 的门」：门号与状态词**不是一一对应**的
 * （gate 2 和 gate 4 都落到 `needs-review`；gate 6 的 fail 和 stale 都是 `needs-audit`）。
 * 所以 `locate` 在构建每道门时就把「这道门失败时会停在哪」记进 `stopStatus`，
 * 这里按门号顺序取第一条 fail/stale 的 `stopStatus`，与 `locate` 的判断顺序一致。
 *
 * `unknown` 不参与：`locate` 里它是「判据不可用」，遇到时继续往后查——
 * 把它当失败会让「没有判据」变成「没做到」，那正是这个模块最怕的误判。
 *
 * @param {object[]} gates `locate` 产出的门（可含上层改过的 state）
 * @returns {string} 状态词，取自 `STATUS` 全集
 */
export function recomputeStatus(gates) {
  const list = Array.isArray(gates) ? gates : [];
  const blocking = list
    .filter((g) => g.state === "fail" || g.state === "stale")
    .sort((a, b) => (a.no ?? 99) - (b.no ?? 99))[0];
  if (!blocking) return STATUS.READY;
  return blocking.stopStatus ?? STATUS.NEEDS_REVIEW;
}

/**
 * 定位状态。按 00-pipeline 的顺序查，**遇到第一条明确的 fail 就停**；
 * `stale` 与 `unknown` 继续往下查，因为后面那道门可能已经把它覆盖了
 * （027 期就是这样：制作确认过期了，但草稿授权重签过且哈希匹配）。
 *
 * @param {{root: string, episodeId?: string}} options
 * @returns {Promise<object>} 永不带异常抛出——查不到也要给出可读的原因
 */
export async function locate(options = {}) {
  const root = String(options.root ?? "").replace(/[\\/]+$/, "");
  const rawEpisode = String(options.episodeId ?? "").trim();
  if (!root) return unbound("没有配置流水线根目录");
  if (!rawEpisode) return unbound("这篇还没有绑定期号");
  // 两个值都会被拼进路径（`join(root, "生产内部", "data")` / `${episodeId}.json`）：
  // 上游 applyPatch 已拦一次，这里再拦一次——历史数据、`ctx.gzhStudio` 的直接调用、
  // 手改过的 article.json 都不经过上游。
  const episodeId = checkEpisodeId(rawEpisode);
  if (!episodeId) return unbound("期号不合法：不能含路径分隔符、`..` 或 Windows 非法字符");
  if (hasParentEscape(root)) return unbound("流水线根目录不合法：不能含 `..`");

  const episodeNo = Number((episodeId.match(/(\d+)$/) ?? [])[1]) || 0;
  const dataDir = join(root, "生产内部", "data");
  const verifyDir = join(dataDir, "verification");
  const approvalsDir = join(verifyDir, "approvals");
  const gates = [];
  let status = STATUS.READY;

  /**
   * 记下「卡在哪」。
   *
   * 同时把状态词写到**刚刚推入的那道门上**（`stopStatus`）——这样上层要用
   * `recomputeStatus` 重算时，不必再猜「这个门号对应哪个状态词」。
   * 门号与状态词不是一一对应（gate 2 / gate 4 都是 needs-review；
   * gate 6 的 fail 和 stale 都是 needs-audit），靠门号映射表迟早写错一处。
   * **让产生判断的那一行自己记下来，比事后维护一张对照表可靠。**
   */
  const stopAt = (value) => {
    const last = gates[gates.length - 1];
    if (last && !last.stopStatus) last.stopStatus = value;
    if (status === STATUS.READY) status = value;
  };

  // ── 01 人物清单 ────────────────────────────────────────────────────────────
  {
    const path = join(dataDir, "published_people.json");
    const doc = await readJson(path);
    if (!doc) {
      gates.push(gate(1, "inventory", "人物清单", "skip", "本仓无 published_people.json，公众号线不适用", { path }));
    } else if (doc.complete === true) {
      gates.push(gate(1, "inventory", "人物清单", "ok", "complete=true", { path }));
    } else {
      gates.push(gate(1, "inventory", "人物清单", "fail", "未标 complete", { path }));
      stopAt(STATUS.NEEDS_INVENTORY);
    }
  }

  // ── 02 frontmatter 四项（文章 ID / 目标读者 / 料数 / 调研方式）──────────────
  {
    const researchName = (await listDir(join(dataDir, "research")))
      .filter((name) => name.endsWith(".json") && !name.startsWith("_"))
      .find((name) => basename(name, ".json") === episodeId);
    const research = researchName ? await readJson(join(dataDir, "research", researchName)) : null;
    const meta = research?.wechat_meta ?? {};
    const missing = [];
    if (!research?.episode_id) missing.push("文章 ID");
    if (!String(meta.audience ?? "").trim()) missing.push("目标读者");
    if (!Number(meta.evidence_count ?? research?.evidence_count ?? 0)) missing.push("本篇料数");
    if (!String(meta.research_method ?? "").trim()) missing.push("调研方式");
    if (!research) {
      gates.push(gate(2, "frontmatter", "frontmatter 四项", "unknown", "读不到台账，四项无从核对", { path: join(dataDir, "research", `${episodeId}.json`) }));
    } else if (missing.length) {
      // 词表里没有「frontmatter 不全」，用 needs-review 承载，路由指到 01（00-pipeline 原文就是「否则 → 01」）。
      gates.push(gate(2, "frontmatter", "frontmatter 四项", "fail", `缺：${missing.join("、")}`, {
        path: join(dataDir, "research", researchName), step: "01-kickoff", skill: "wechat-01-kickoff",
        hint: "回立项把文章 ID / 目标读者 / 本篇料数 / 调研方式补齐，再往下走。",
      }));
      stopAt(STATUS.NEEDS_REVIEW);
    } else {
      gates.push(gate(2, "frontmatter", "frontmatter 四项", "ok", "四项齐备（来自 wechat_meta）", { path: join(dataDir, "research", researchName) }));
    }
  }

  // ── 03 证据台账：存在 + 无 unverified/rejected ──────────────────────────────
  let researchDoc = null;
  {
    const path = join(dataDir, "research", `${episodeId}.json`);
    researchDoc = await readJson(path);
    if (!researchDoc) {
      gates.push(gate(3, "evidence", "证据台账", "fail", "台账不存在", { path }));
      stopAt(STATUS.NEEDS_RESEARCH);
    } else {
      const entries = Array.isArray(researchDoc.entries) ? researchDoc.entries
        : Array.isArray(researchDoc.claims) ? researchDoc.claims : [];
      // 台账实际用 `verified_verbatim: true` 表示「已逐字核过」；同时也容 status 词表。
      const bad = entries.filter((e) => {
        const s = String(e?.status ?? "").toLowerCase();
        if (s === "unverified" || s === "rejected") return true;
        return e?.verified_verbatim === false;
      });
      if (!entries.length) {
        gates.push(gate(3, "evidence", "证据台账", "unknown", "台账里没有 entries，无法判定", { path }));
      } else if (bad.length) {
        gates.push(gate(3, "evidence", "证据台账", "fail", `${bad.length}/${entries.length} 条未核过（${bad.slice(0, 3).map((e) => e?.id ?? "?").join("、")}）`, { path }));
        stopAt(STATUS.NEEDS_RESEARCH);
      } else {
        gates.push(gate(3, "evidence", "证据台账", "ok", `${entries.length} 条全部逐字核过`, { path }));
      }
    }
  }

  // ── 04 方案是否由人挑定 ────────────────────────────────────────────────────
  const reviewDir = await findReviewDir(root, episodeNo);
  {
    const angles = reviewDir ? (await listDir(reviewDir)).filter((n) => /angles\.md$/i.test(n) && !n.startsWith("_")) : [];
    if (!reviewDir) {
      gates.push(gate(4, "angles", "方案已挑定", "unknown", "找不到审稿包目录", { path: join(root, "审稿") }));
    } else if (!angles.length) {
      // 词表里没有「缺方案」这个状态，用 needs-review 承载，但**下一步必须指到 03**——
      // 只说「需人看」等于让人自己猜，等于没给路。
      gates.push(gate(4, "angles", "方案已挑定", "fail", "审稿包里没有 *.angles.md", {
        path: reviewDir, step: "03-angles", skill: "wechat-03-angles", hint: "先出 3–5 套方案（标题+钩子+前两段+大纲），交人挑定一套。",
      }));
      stopAt(STATUS.NEEDS_REVIEW);
    } else {
      // 「挑了哪套」没有独立文件，但方案 md 里有固定写法：选定那一行的「初判选定」，
      // 或一句「方案 2/3/4/5 不单独成期，全部并入方案 1」。按这个标记判，别一律 unknown——
      // 每期都挂一个「判据不可用」等于没说。
      const text = await readFile(join(reviewDir, angles[0]), "utf8").catch(() => "");
      const marked = /初判选定|选定方案|采用方案|并入方案/.test(text);
      if (marked) {
        // 标记那行常常是 markdown 表格行（`| 1 | **布被之诈** | 汲黯当庭… | 初判选定 |`）。
        // 原样贴进面板就是一堆竖线和星号，编辑看不懂。只取**加粗的方案名**，
        // 取不到就退成「方案文件里有选定标记」，不硬塞一行原始语法。
        const line = (text.split("\n").find((l) => /初判选定|选定方案|采用方案|并入方案/.test(l)) ?? "").trim();
        const name = (line.match(/\*\*(.+?)\*\*/) ?? [])[1] ?? "";
        gates.push(gate(4, "angles", "方案已挑定", "ok", name ? `选定「${name}」` : "方案文件里有选定标记", { path: join(reviewDir, angles[0]) }));
      } else {
        gates.push(gate(4, "angles", "方案已挑定", "unknown", `有方案（${angles[0]}），但没有「挑了哪套」的标记`, { path: join(reviewDir, angles[0]) }));
      }
    }
  }

  // ── 05 编辑审 + 读者审两份清单 ─────────────────────────────────────────────
  //
  // 这里**只判盘上有什么**，不掺面板勾选。理由：`locate` 是「查盘」，
  // 掺进插件自己的状态会让同一个函数有两种事实源，调一次和调两次可能不一样。
  // 面板勾选由上层（index.js 的 pipelineView）合判，合成后的结论会覆盖 state/detail。
  // 但 `disk` 字段要带出去：上层得知道「盘上到底有没有」，才能说清依据是什么。
  let reviewDisk = { editor: false, reader: false, selfReview: 0, roundCount: 0, shaBound: false };
  {
    const files = reviewDir ? await listDir(reviewDir) : [];
    const selfReview = files.filter((n) => /self-review/i.test(n));
    // 两份清单的真实文件名口径：`*.editor-review.md` / `*.reader-review.md`
    const hasEditor = files.some((n) => /editor-review\.md$/i.test(n) && !/superseded/i.test(n));
    const hasReader = files.some((n) => /reader-review\.md$/i.test(n) && !/superseded/i.test(n));
    const gateDoc = await readJson(join(verifyDir, `${episodeId}-wechat-10-quality-gate.json`));
    const rounds = gateDoc?.content_review ?? null;
    const roundCount = rounds ? Object.keys(rounds).filter((k) => /^round/.test(k)).length : 0;
    reviewDisk = { editor: hasEditor, reader: hasReader, selfReview: selfReview.length, roundCount, shaBound: false };

    if (selfReview.length) {
      gates.push(gate(5, "reviews", "编辑审 + 读者审", "ok", `审稿包内有 ${selfReview.length} 份 self-review`, { path: join(reviewDir, selfReview[0]) }));
    } else if (hasEditor && hasReader) {
      gates.push(gate(5, "reviews", "编辑审 + 读者审", "ok", "编辑审与读者审两份清单都在", { path: join(reviewDir, "*.editor-review.md") }));
    } else if (roundCount >= 2) {
      gates.push(gate(5, "reviews", "编辑审 + 读者审", "ok", `以质量门里记录的 ${roundCount} 轮审稿替代（该期没单独存清单）`, { path: join(verifyDir, `${episodeId}-wechat-10-quality-gate.json`) }));
    } else {
      gates.push(gate(5, "reviews", "编辑审 + 读者审", "unknown", "既无清单文件，质量门里也没有多轮审稿记录", { path: reviewDir ?? "" }));
    }
  }

  // ── 06 Chrome 核验收据 + 哈希匹配 ──────────────────────────────────────────
  const deliverDir = await findDeliverDir(root, episodeNo);
  const articleFile = deliverDir ? join(deliverDir, "10-公众号-文案.md") : "";
  const layoutFile = deliverDir ? join(deliverDir, "11-公众号-排版.html") : "";
  const coverFile = deliverDir ? join(deliverDir, "12-公众号-封面.png") : "";
  const articleSha = articleFile ? await sha256File(articleFile) : null;
  const layoutSha = layoutFile ? await sha256File(layoutFile) : null;
  const coverSha = coverFile ? await sha256File(coverFile) : null;
  {
    const verifyFiles = await listDir(verifyDir);
    // 名字口径有三种：`<ep>-wechat-<pkg>-chrome-audit.json`、`<ep>-wechat-chrome-audit.json`、
    // 以及历史遗留的 `chrome-fetch-<NNN>.json`。只认第一种会误判 027 期「没核验过」。
    const auditName = verifyFiles
      .filter((n) => !n.startsWith("_superseded") && /chrome-(audit|fetch)/i.test(n))
      .filter((n) => n.startsWith(episodeId) || new RegExp(`-0*${episodeNo}\\.json$`).test(n))
      // 先认公众号自己的收据，再退到视频线/历史命名的——026 期两种都有，
      // 随手取最后一个会把「视频线的核验」当成「公众号已核验」报出来。
      .sort((a, b) => (Number(/wechat/i.test(a)) - Number(/wechat/i.test(b))) || a.localeCompare(b))
      .pop() ?? null;
    const audit = auditName ? await readJson(join(verifyDir, auditName)) : null;
    const auditSha = String(audit?.article_sha256 ?? audit?.content_sha256 ?? "");
    if (!audit) {
      gates.push(gate(6, "audit", "Chrome 终核", "fail", "无核验收据", { path: join(verifyDir, `${episodeId}-wechat-*-chrome-audit.json`) }));
      stopAt(STATUS.NEEDS_AUDIT);
    } else if (!auditSha) {
      // 有收据但绑不上文章哈希：判据不可用，不判 fail。
      // 说成 fail 会让人去重核一遍已经核过的东西（027 期就是这种：chrome-fetch-027 只绑了《史记》页面）。
      const line = /wechat/i.test(auditName) ? "" : "（这是另一条线的收据，不能算公众号已核验）";
      gates.push(gate(6, "audit", "Chrome 终核", "unknown", `${auditName} 未绑文章哈希，无法验证是否为当前文字${line}`, { path: join(verifyDir, auditName) }));
    } else if (!articleSha) {
      // 交付正文不在盘上：没有可比对的文字。
      // 旧写法是 `articleSha && auditSha !== articleSha`，`null` 让前半短路，直接落到
      // else 的「收据哈希与当前正文一致」——一篇没有正文的稿子被报成全绿。
      // 缺正文是「缺件」，按本文件的原则判 fail（不是 unknown）；假绿比报错坏得多。
      gates.push(gate(6, "audit", "Chrome 终核", "fail", "交付正文缺失（10-公众号-文案.md），收据无从比对", { path: articleFile || deliverDir || "" }));
      stopAt(STATUS.NEEDS_AUDIT);
    } else if (auditSha !== articleSha) {
      gates.push(gate(6, "audit", "Chrome 终核", "stale", "收据绑的是旧文字", { path: join(verifyDir, auditName) }));
      stopAt(STATUS.NEEDS_AUDIT);
    } else {
      gates.push(gate(6, "audit", "Chrome 终核", "ok", "收据哈希与当前正文一致", { path: join(verifyDir, auditName) }));
    }
  }

  // ── 07 制作确认：approved + scope 含 wechat + 哈希匹配 ─────────────────────
  {
    const files = await listDir(approvalsDir);
    const name = latestApproval(files, "-production.json");
    const doc = name ? await readJson(join(approvalsDir, name)) : null;
    const bound = doc?.bound_to?.article_sha256 ?? doc?.content_hashes?.["最终交付\\" + basename(deliverDir ?? "") + "\\10-公众号-文案.md"];
    const scopeOk = Array.isArray(doc?.scope) ? doc.scope.includes("wechat") : false;
    if (!doc || doc.status !== "approved") {
      gates.push(gate(7, "production", "制作确认", "fail", doc ? `status=${doc.status ?? "缺"}` : "确认记录不存在", { path: join(approvalsDir, `${episodeId}-production.json`) }));
      stopAt(STATUS.NEEDS_USER_APPROVAL);
    } else if (!scopeOk) {
      gates.push(gate(7, "production", "制作确认", "fail", `scope 不含 wechat（${(doc.scope ?? []).join(",")}）`, { path: join(approvalsDir, name) }));
      stopAt(STATUS.NEEDS_USER_APPROVAL);
    } else if (!bound) {
      gates.push(gate(7, "production", "制作确认", "unknown", "approved 但没绑正文哈希，无法验证是否对应当前稿", { path: join(approvalsDir, name) }));
    } else if (!articleSha) {
      // 同门 6：没有正文就没有被确认的对象。旧写法同样短路成「approved + 哈希匹配当前正文」。
      gates.push(gate(7, "production", "制作确认", "fail", "交付正文缺失（10-公众号-文案.md），确认无从核对", { path: articleFile || deliverDir || "" }));
      stopAt(STATUS.NEEDS_USER_APPROVAL);
    } else if (bound !== articleSha) {
      // 制作确认之后正文又改过。这时**先别急着判卡住**：草稿授权可能已经重签覆盖
      // （027 期就是这样）。覆盖成立才放过，否则如实判 stale 并停在交稿。
      // 旧写法是在循环之后补一段 fixup 去改状态，结果「先卡住再放行」和
      // 「卡住了但状态没更新」两种错都出现过——就地判定，不留后手。
      const draftName = latestApproval(files, "-wechat-draft.json");
      const draftDoc2 = draftName ? await readJson(join(approvalsDir, draftName)) : null;
      const rebound = draftDoc2?.bound_to?.article_sha256;
      if (rebound && rebound === articleSha) {
        gates.push(gate(7, "production", "制作确认", "ok", `后被 ${draftName} 重签覆盖（绑 ${rebound.slice(0, 8)} 与现稿一致）`, {
          path: join(approvalsDir, name), supersededBy: draftName, staleHash: bound,
        }));
      } else {
        gates.push(gate(7, "production", "制作确认", "stale", `绑的是 ${bound.slice(0, 8)}，现稿 ${articleSha.slice(0, 8)}`, {
          path: join(approvalsDir, name), step: "07-deai", skill: "wechat-07-deai",
          hint: "正文在确认之后改过，旧确认作废：重核 → 重新交稿 → 等人再说一次「制作」。",
        }));
        stopAt(STATUS.NEEDS_USER_APPROVAL);
      }
    } else {
      gates.push(gate(7, "production", "制作确认", "ok", "approved + 哈希匹配当前正文", { path: join(approvalsDir, name) }));
    }
  }

  // ── 08 排版 HTML 已生成且回跑过体检 ────────────────────────────────────────
  {
    const gateDoc = await readJson(join(verifyDir, `${episodeId}-wechat-10-quality-gate.json`));
    const layoutVerdict = String(gateDoc?.layout?.verdict ?? "");
    if (!layoutFile || !layoutSha) {
      gates.push(gate(8, "layout", "排版已体检", "fail", "没有排版 HTML", {
        path: layoutFile, step: "09-layout", skill: "wechat-09-layout", hint: "先排版成能贴进公众号的 HTML，排完回跑一次体检。",
      }));
      stopAt(STATUS.NEEDS_REVIEW);
    } else if (!gateDoc) {
      gates.push(gate(8, "layout", "排版已体检", "fail", "排版 HTML 在，但没有体检留痕", {
        path: layoutFile, step: "10-quality-gate", skill: "wechat-10-quality-gate", hint: "排完必须回跑一次体检门，并把结论留痕。",
      }));
      stopAt(STATUS.NEEDS_REVIEW);
    } else if (gateDoc?.layout?.sha256 && gateDoc.layout.sha256 !== layoutSha) {
      gates.push(gate(8, "layout", "排版已体检", "stale", `留痕绑的是 ${String(gateDoc.layout.sha256).slice(0, 8)}，现文件 ${layoutSha.slice(0, 8)}`, {
        path: layoutFile, step: "10-quality-gate", skill: "wechat-10-quality-gate", hint: "排版改过，旧体检结论作废，重跑体检。",
      }));
      stopAt(STATUS.NEEDS_REVIEW);
    } else {
      // `verdict` 不是 pass 就是**没过**，不能只标 stale 不拦：
      // 原来这里没有 stopAt，结果「排版体检不通过」能一路走到「可推草稿」——
      // 面板上说能推，盘上体检测没通过，这种自相矛盾比不做检查更糟。
      gates.push(gate(8, "layout", "排版已体检", layoutVerdict === "pass" ? "ok" : "stale", `layout.verdict=${layoutVerdict || "缺"}`, { path: layoutFile }));
      if (layoutVerdict !== "pass") stopAt(STATUS.NEEDS_REVIEW);
    }
  }

  // ── 09 质量门留痕：通过 + 日期 + 文章 ID ───────────────────────────────────
  {
    const files = await listDir(verifyDir);
    const name = files.filter((n) => !n.startsWith("_superseded") && n.startsWith(episodeId) && /quality-gate/.test(n)).sort().pop() ?? null;
    const doc = name ? await readJson(join(verifyDir, name)) : null;
    const hasDate = Boolean(doc?.generated_at);
    if (!doc) {
      gates.push(gate(9, "quality-gate", "排版校验留痕", "fail", "没有 quality-gate 留痕", { path: join(verifyDir, `${episodeId}-wechat-*-quality-gate.json`) }));
      stopAt(STATUS.NEEDS_DRAFT_APPROVAL);
    } else if (doc.verdict !== "pass") {
      gates.push(gate(9, "quality-gate", "排版校验留痕", "fail", `verdict=${doc.verdict ?? "缺"}`, { path: join(verifyDir, name) }));
      stopAt(STATUS.NEEDS_DRAFT_APPROVAL);
    } else if (!hasDate) {
      gates.push(gate(9, "quality-gate", "排版校验留痕", "fail", "留痕缺日期", { path: join(verifyDir, name) }));
      stopAt(STATUS.NEEDS_DRAFT_APPROVAL);
    } else {
      gates.push(gate(9, "quality-gate", "排版校验留痕", "ok", `${String(doc.generated_at).slice(0, 10)} 通过`, { path: join(verifyDir, name) }));
    }
  }

  // ── 10 推草稿回执 ──────────────────────────────────────────────────────────
  let draftDoc = null;
  {
    const files = await listDir(verifyDir);
    const name = files.filter((n) => !n.startsWith("_superseded") && n.startsWith(episodeId) && /draft/.test(n) && !/approvals/.test(n)).sort().pop() ?? null;
    draftDoc = name ? await readJson(join(verifyDir, name)) : null;
    if (!draftDoc) {
      gates.push(gate(10, "draft", "推草稿回执", "fail", "没有推草稿回执", { path: join(verifyDir, `${episodeId}-wechat-*-draft.json`) }));
      // 缺回执说明还没推到线上，但本地已齐 → 这才是「草稿待授权」的准确定位
      stopAt(STATUS.NEEDS_DRAFT_APPROVAL);
    } else if (draftDoc.persisted === false) {
      gates.push(gate(10, "draft", "推草稿回执", "stale", "persisted=false，只是模拟回执", { path: join(verifyDir, name) }));
      if (status === STATUS.READY) status = STATUS.DRY_RUN;
    } else if (draftDoc.verified !== true || !String(draftDoc.media_id ?? "").trim()) {
      gates.push(gate(10, "draft", "推草稿回执", "fail", "verified 或 media_id 不成立", { path: join(verifyDir, name) }));
      stopAt(STATUS.NEEDS_REVIEW);
    } else {
      gates.push(gate(10, "draft", "推草稿回执", "ok", `media_id ${String(draftDoc.media_id).slice(0, 10)}… · 已回读`, { path: join(verifyDir, name) }));
    }
  }

  // 制作确认过期、但草稿授权已重签覆盖的情况已在第 7 道门里就地解决，这里不再补后手。

  const route = STATUS_ROUTE[status] ?? STATUS_ROUTE[STATUS.NEEDS_REVIEW];
  // 第一处卡住的门如果是「词表装不下的那种卡」，用它自己指的路，别退回泛泛的 needs-review。
  const blocking = gates.find((g) => g.state === "fail" || g.state === "stale") ?? null;
  const step = blocking?.step ?? route.step;
  const skill = blocking?.skill ?? route.skill;
  const hint = blocking?.hint ?? route.hint;
  return {
    bound: true,
    root,
    episodeId,
    episodeNo,
    status,
    step,
    skill,
    hint,
    blocking: blocking ? { no: blocking.no, label: blocking.label, detail: blocking.detail } : null,
    gates,
    // 三样「一眼看出进度」的东西。只有十道门不够——门是判断题，
    // 而编辑想知道的是「走到哪了、跳了哪步、什么时候动的」。见 README「流水线状态」。
    nodes: buildNodes(gates),
    timeline: await buildTimeline({ root, episodeId, episodeNo, deliverDir, reviewDir, verifyDir }),
    facts: buildFacts(gates, researchDoc),
    hashes: { article: articleSha, layout: layoutSha, cover: coverSha },
    /**
     * 05 两份清单在盘上的实情。上层拿它与面板勾选合判——
     * 「盘上有」和「人勾过」是两种证据，混成一个布尔值就再也说不清依据是什么了。
     */
    reviewDisk,
    unknown: gates.filter((g) => g.state === "unknown").length,
    articleFile,
    layoutFile,
    coverFile,
    checkedAt: Date.now(),
  };
}

/**
 * 节点条：把十道门聚成「13 步流水线」上的节点，每个节点给 done/doing/todo/skip。
 *
 * 为什么要有这个：状态词只有一个（`needs-user-approval`），回答不了「前面过了几步」。
 * 编辑看稿子第一眼想知道的是「初稿有了吗、审过没有、配图配了没」，不是状态词。
 *
 * **不做的事**：不为了凑满 13 个节点去编造判据。哪一步没有机器判据就标 `skip`，
 * 并写明「无机器判据」——假装知道比不知道更糟。
 */
function buildNodes(gates) {
  const at = (no) => gates.find((g) => g.no === no);
  const mark = (g) => {
    if (!g) return "skip";
    if (g.state === "ok") return "done";
    if (g.state === "fail" || g.state === "stale") return "todo";
    return "unknown";
  };
  const NODES = [
    { id: "01", label: "立项", gate: 1 },
    { id: "02", label: "证据台账", gate: 3 },
    { id: "03", label: "方案", gate: 4 },
    // 「初稿」不设门：正文在不在，由面板自己知道（`article.sections` 有非空正文即算）。
    // 这里返回 `panel` 让前端按本地正文判，避免服务端再读一遍盘还判不准。
    { id: "04", label: "初稿", panel: "draft" },
    // 编辑审与读者审在盘上是**同一道门**（审稿包里那几份 self-review 一起判），
    // 合成一个 chip 更诚实：拆成两个会是同一个 ✓ 出现两次，看着像两条独立证据。
    { id: "05", label: "编辑审·读者审", gate: 5 },
    // 去 AI 味（07）在本仓**没有独立判据**：谁润过稿、润了几句，盘上没有记录。
    // 标 skip 并写明「无机器判据」——假装知道比不知道更糟，但也不能因此把整篇判成未知。
    { id: "07", label: "去 AI 味", none: "本仓无机器判据，须看审稿包" },
    { id: "08", label: "配图", coverOnly: true }, // 判据是「交付目录里有没有封面文件」
    { id: "09", label: "排版", gate: 8 },
    { id: "10", label: "排版校验", gate: 9 },
    { id: "11", label: "推草稿", gate: 10 },
  ];
  return NODES.map((node) => {
    if (node.coverOnly) {
      const hasCover = Boolean(gates.find((g) => g.no === 8)?.path);
      return { id: node.id, label: node.label, state: hasCover ? "done" : "todo" };
    }
    if (node.panel) return { id: node.id, label: node.label, state: "panel", panel: node.panel };
    if (node.none) return { id: node.id, label: node.label, state: "skip", note: node.none };
    const g = node.gate ? at(node.gate) : null;
    if (!g) return { id: node.id, label: node.label, state: "skip", note: "无机器判据" };
    return { id: node.id, label: node.label, state: mark(g), note: g.detail };
  });
}

/**
 * 时间线：从真实文件的 mtime 排出来。
 *
 * 不另建事件表——`土木工程的第一原则是别造第二份事实`。文件什么时候被改过，
 * 文件系统已经记着了；再写一份只会两处不一致。账本记的是「谁为什么改」，时间线记的是「什么时候动过」。
 */
async function buildTimeline({ root, episodeId, episodeNo, deliverDir, reviewDir, verifyDir }) {
  const rows = [];
  const push = async (path, label, note) => {
    if (!path) return;
    try {
      const info = await stat(path);
      rows.push({ at: info.mtimeMs, label, note, path });
    } catch {
      // 文件不在就没有这一行，不编造
    }
  };

  if (deliverDir) {
    await push(join(deliverDir, "10-公众号-文案.md"), "正文更新", "10-公众号-文案.md");
    await push(join(deliverDir, "11-公众号-排版.html"), "排版更新", "11-公众号-排版.html");
    const covers = await listDir(deliverDir).catch(() => []);
    const cover = [...covers].reverse().find((n) => /^1[0-9].*(封面|cover).*\.(png|jpe?g)$/i.test(n));
    await push(cover ? join(deliverDir, cover) : "", "封面更新", cover ?? "");
  }
  if (reviewDir) {
    const files = await listDir(reviewDir).catch(() => []);
    if (files.length) {
      // 审稿包按目录里最新的那份算一次「审稿包更新」，不逐文件刷屏
      let newest = 0;
      let name = "";
      for (const f of files) {
        if (f.startsWith("_superseded")) continue;
        const info = await stat(join(reviewDir, f)).catch(() => null);
        if (info && info.mtimeMs > newest) { newest = info.mtimeMs; name = f; }
      }
      if (newest) rows.push({ at: newest, label: "审稿包更新", note: name, path: join(reviewDir, name) });
    }
  }
  for (const [pattern, label] of [
    [/quality-gate/i, "排版校验留痕"],
    [/chrome-(audit|fetch)/i, "核验收据"],
    [/draft/i, "推草稿回执"],
  ]) {
    const files = (await listDir(verifyDir).catch(() => []))
      .filter((n) => !n.startsWith("_superseded") && pattern.test(n))
      .filter((n) => n.startsWith(episodeId) || new RegExp(`-0*${episodeNo}\\.json$`).test(n));
    if (files.length) await push(join(verifyDir, [...files].sort().pop()), label, [...files].sort().pop());
  }
  const approvals = await listDir(join(verifyDir, "approvals")).catch(() => []);
  const mine = approvals.filter((n) => n.startsWith(episodeId) && !n.startsWith("_superseded"));
  if (mine.includes(`${episodeId}-production.json`)) await push(join(verifyDir, "approvals", `${episodeId}-production.json`), "制作确认已签", "production.json");
  if (mine.includes(`${episodeId}-wechat-draft.json`)) await push(join(verifyDir, "approvals", `${episodeId}-wechat-draft.json`), "草稿授权已签", "wechat-draft.json");

  return rows.sort((a, b) => b.at - a.at).slice(0, 8);
}

/**
 * 事实核对：把「事实层」从「流程层」里分出来。
 *
 * 这两类东西混在一张表里，会让人误以为「审稿过了 = 事实对」。事实上审稿只说明有人读过，
 * 台账才说明每条材料有出处。分开列，缺哪一样一眼看到。
 */
function buildFacts(gates, researchDoc) {
  const entries = Array.isArray(researchDoc?.entries) ? researchDoc.entries
    : Array.isArray(researchDoc?.claims) ? researchDoc.claims : [];
  const verified = entries.filter((e) => e?.verified_verbatim === true || String(e?.status ?? "").toLowerCase() === "verified").length;
  const review = gates.find((g) => g.no === 5);
  const evidence = gates.find((g) => g.no === 3);
  const audit = gates.find((g) => g.no === 6);
  return [
    { key: "research", label: "研究", state: entries.length ? "ok" : "none", detail: entries.length ? `${entries.length} 条` : "无" },
    { key: "evidence", label: "证据", state: verified ? "ok" : "none", detail: verified ? `${verified}/${entries.length} 条逐字核过` : "无" },
    { key: "audit", label: "核验", state: audit?.state === "ok" ? "ok" : audit?.state === "unknown" ? "unknown" : "none", detail: audit?.state === "unknown" ? "有收据但未绑文章哈希" : audit?.detail ?? "无" },
    { key: "review", label: "审稿", state: review?.state === "ok" ? "ok" : "none", detail: review?.state === "ok" ? "已审" : "无" },
    { key: "assets", label: "素材包", state: gates.find((g) => g.no === 8)?.path ? "ok" : "none", detail: gates.find((g) => g.no === 8)?.path ? "有交付件" : "无" },
    { key: "ledger", label: "排版校验", state: evidence ? (gates.find((g) => g.no === 9)?.state ?? "none") : "none", detail: gates.find((g) => g.no === 9)?.detail ?? "无" },
  ];
}

/** 未绑定流水线：不是状态词，只是说明。文案不能说成「卡在某一步」。 */
function unbound(reason) {
  return { bound: false, reason, status: null, step: null, skill: null, gates: [], unknown: 0 };
}

/** 审稿包目录按「第0NN期-*」找，不靠拼人名（人名会改口径）。 */
async function findReviewDir(root, episodeNo) {
  if (!episodeNo) return null;
  const names = await listDir(join(root, "审稿"));
  const hit = names.find((name) => new RegExp(`第0*${episodeNo}期`).test(name) && !name.startsWith("_"));
  return hit ? join(root, "审稿", hit) : null;
}

/** 交付目录同上。 */
async function findDeliverDir(root, episodeNo) {
  if (!episodeNo) return null;
  const names = await listDir(join(root, "最终交付"));
  const hit = names.find((name) => new RegExp(`第0*${episodeNo}期`).test(name) && !name.startsWith("_"));
  return hit ? join(root, "最终交付", hit) : null;
}

/** 状态词合法性自检：给测试用，防止哪天手滑写了个新词。 */
export function isStatus(value) {
  return Object.values(STATUS).includes(String(value));
}
