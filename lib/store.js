/**
 * 落盘层：一篇文章 = 一个目录。
 *
 * ```
 * <root>/settings.json                    出图节点、默认模板（跨文章共用）
 * <root>/articles/<id>/article.json       当前状态（标题、段落、每张图的版本指针）
 * <root>/articles/<id>/ledger.jsonl       记忆账本（append-only，只加不改）
 * <root>/articles/<id>/images/<slot>/v001.svg|png
 * ```
 *
 * 两条设计口径，都是为了「可观测」：
 * 1. **`article.json` 是当前状态，`ledger.jsonl` 是历史**。状态可以被覆盖，
 *    历史不行——所以「第 3 段出过 v001、v002、v003，哪版说过什么」只能从账本里查，
 *    版本元数据同时留在 `article.json` 是为了面板不用扫账本就能直接画版本条。
 * 2. **旧版永不覆盖**。`nextVid()` 只往后加号，出图落的是新文件；
 *    「现在用哪版」是 `current` 这个指针，切换只改指针，不删文件。
 *
 * 所有 id / slot 都走白名单正则再拼路径（**不做字符串拼接式校验**）：
 * 请求里来的 `id` 只要不匹配就 400，绝不会有 `../` 落到 `join()` 里。
 * @module lib/store
 */

import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { mkdir, readFile, writeFile, rename, appendFile, readdir, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { DEFAULT_TEMPLATE, TEMPLATE_IDS } from "./templates.js";
import { checkPid, PID_PATTERN } from "./proposal.js";
import { emptyReviews, normalizeReviews } from "./reviews.js";

/** 配置默认值（loader config 可覆盖）。 */
export const DEFAULTS = {
  root: "~/.dsh/gzh-studio",
  /** 账本一次最多回读多少行（面板侧边栏只显示最近这些）。 */
  ledgerLimit: 200,
};

/** 文章 id 白名单：`gzh-<8位日期>-<4位十六进制>`。 */
export const ID_PATTERN = /^gzh-\d{8}-[0-9a-f]{4}$/;
/** 槽位 id 白名单：封面 / 段落。 */
export const SLOT_PATTERN = /^(cover|sec-s[0-9]{1,4})$/;
/** 版本 id 白名单。 */
export const VID_PATTERN = /^v\d{3}$/;

/** 展开 `~`。 */
export function expandHome(path) {
  const text = String(path ?? "").trim();
  if (!text) return resolve(DEFAULTS.root.replace(/^~/, homedir()));
  if (text === "~") return homedir();
  if (text.startsWith("~/") || text.startsWith("~\\")) return join(homedir(), text.slice(2));
  return resolve(text);
}

/** 校验 id，返回 null 表示不合法（调用方回 400，绝不进 join）。 */
export const checkId = (id) => (ID_PATTERN.test(String(id ?? "").trim()) ? String(id).trim() : null);
/** 校验槽位。 */
export const checkSlot = (slot) => (SLOT_PATTERN.test(String(slot ?? "").trim()) ? String(slot).trim() : null);
/** 校验版本号。 */
export const checkVid = (vid) => (VID_PATTERN.test(String(vid ?? "").trim()) ? String(vid).trim() : null);

/** 生成一个新 id（时间 + 随机后缀，不含用户输入）。 */
export function newId(now = Date.now()) {
  const d = new Date(now);
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `gzh-${stamp}-${randomBytes(2).toString("hex")}`;
}

/** 版本号自增：`[]` → `v001`；`[v001,v003]` → `v004`（跳号也往后走，不复用）。 */
export function nextVid(versions) {
  let max = 0;
  for (const version of Array.isArray(versions) ? versions : []) {
    const m = /^v(\d{3})$/.exec(String(version?.vid ?? ""));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `v${String(max + 1).padStart(3, "0")}`;
}

/**
 * 空槽位（封面 / 段落配图共用一套形状）。
 * @param {string} slot
 * @param {object} [extra]
 */
export function emptySlot(slot, extra = {}) {
  return { slot, prompt: "", negative: "", caption: "", size: "", current: "", versions: [], ...extra };
}

/**
 * 建一个空段落。
 * @param {{index?: number, id?: string, heading?: string, body?: string}} [input]
 */
export function makeSection(input = {}) {
  const index = Number(input.index) || 0;
  const id = input.id && /^s[0-9]{1,4}$/.test(input.id) ? input.id : `s${index + 1}`;
  return {
    id,
    heading: String(input.heading ?? ""),
    body: String(input.body ?? ""),
    image: emptySlot(`sec-${id}`, { caption: "" }),
  };
}

/**
 * 最长路径边界：所有落盘都从这里的两个方法出去，别处不自己拼路径。
 * @param {{root?: string}} [config]
 */
/**
 * 内容生命周期 —— 与「流水线状态」是**两个维度**，不能混。
 *
 * 流水线状态回答「卡在第几步」（要台账、要审批、要哈希，只有绑了期号才算得出）；
 * 生命周期回答「这篇在作者手里处于哪个位置」（所有文章都有，不需要绑任何东西）。
 * 一篇可以流水线全通但还没发布，也可以已发布但后来改了字要重发。
 *
 * 只留三个值，是有意的：「归档」不算第四种，它是「已发布 + 不再更新」，
 * 多一个值就多一处要同步的判断。
 */
export const LIFECYCLE = {
  DRAFT: "draft",           // 还没推过草稿
  IN_DRAFT_BOX: "draftbox", // 推过草稿箱，还没发布
  PUBLISHED: "published",   // 已发布
};

/** 手动标记的合法值。 */
export const LIFECYCLE_VALUES = Object.values(LIFECYCLE);

/**
 * 归一化生命周期，并**标出这个值是推出来的还是人标的**。
 *
 * 为什么强调来源：`published` 这台机器没有任何办法自动知道（没接公众号 API），
 * 只能靠人标、或绑了期号时用推草稿回执推。所以每个值都带 `source`，
 * 面板上要能看出「这是我标的，不是它验的」——否则用户会以为插件真知道发布状态。
 *
 * @param {object} article
 * @param {{draftPushed?: boolean}} [hint] 来自推草稿回执的旁证
 */
export function lifecycleOf(article, hint = {}) {
  const marked = article?.lifecycle && LIFECYCLE_VALUES.includes(String(article.lifecycle))
    ? String(article.lifecycle)
    : "";
  if (marked) return { value: marked, source: "manual", markedAt: Number(article.lifecycleAt) || 0 };
  // 没手标就推：推过草稿箱 → draftbox，其余 draft。
  // **不猜 published**：没有证据的「已发布」比「草稿箱」更危险（会漏掉待发的那几篇）。
  if (hint.draftPushed) return { value: LIFECYCLE.IN_DRAFT_BOX, source: "inferred" };
  return { value: LIFECYCLE.DRAFT, source: "default" };
}

/**
 * 标生命周期（人显式改的那条路）。返回是否有变化。
 *
 * **空串表示「取消手标」**：标错了要能退回自动推断。
 * 一开始只允许写合法值，结果一旦标了「已发布」就再也取消不掉——
 * 那种「只能设不能撤」的开关，用户第一次标错就会讨厌它。
 */
export function markLifecycle(article, value, now = Date.now()) {
  const next = String(value ?? "").trim();
  if (!next) {
    if (article.lifecycle === undefined || article.lifecycle === "") return false;
    delete article.lifecycle;
    delete article.lifecycleAt;
    return true;
  }
  if (!LIFECYCLE_VALUES.includes(next)) return false;
  if (article.lifecycle === next) return false;
  article.lifecycle = next;
  article.lifecycleAt = now;
  return true;
}

export function createStore(rawConfig = {}) {
  const root = expandHome(rawConfig.root ?? DEFAULTS.root);
  const ledgerLimit = Number(rawConfig.ledgerLimit) > 0 ? Number(rawConfig.ledgerLimit) : DEFAULTS.ledgerLimit;
  const articlesDir = join(root, "articles");
  const settingsFile = join(root, "settings.json");

  const dirOf = (id) => join(articlesDir, id);
  const fileOf = (id) => join(dirOf(id), "article.json");
  const ledgerOf = (id) => join(dirOf(id), "ledger.jsonl");

  /** 原子写：先写 `.tmp` 再 rename（半截文件不会留在盘上）。 */
  async function writeJson(file, value) {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tmp, file);
  }

  /**
   * 默认设置：**先给一个 fake 节点**，装好就能点「出图」看到整条流程，
   * 不用先配 key（Deckline 的 fake 模式同理）。
   */
  async function readSettings() {
    let raw = null;
    try {
      raw = JSON.parse(await readFile(settingsFile, "utf8"));
    } catch {
      raw = null;
    }
    const nodes = Array.isArray(raw?.nodes) && raw.nodes.length ? raw.nodes : [defaultNode()];
    return {
      nodes,
      defaultNode: nodes.some((n) => n.id === raw?.defaultNode) ? raw.defaultNode : nodes[0].id,
      defaultTemplate: TEMPLATE_IDS.includes(raw?.defaultTemplate) ? raw.defaultTemplate : DEFAULT_TEMPLATE,
      // 流水线根目录（如 D:/work/历史内容生产）：绑期号时的默认值，省得每次手输绝对路径
      pipelineRoot: typeof raw?.pipelineRoot === "string" ? raw.pipelineRoot : "",
    };
  }

  /** 内置 fake 节点：不出网，出 SVG 占位图（带尺寸与 prompt 摘要）。 */
  function defaultNode() {
    return {
      id: "fake",
      name: "占位图（不联网）",
      baseURL: "",
      apiKeyEnv: "",
      model: "placeholder",
      size: "900x383",
      fake: true,
    };
  }

  async function writeSettings(next) {
    await writeJson(settingsFile, next);
    return next;
  }

  /** 文章列表（按更新时间倒序，只读目录里能解析的）。 */
  /**
   * 全部文章（按更新时间倒序）。
   *
   * 每条都带**生命周期**与**搜索用的检索文本**。这两样是列表层的责任：
   * 面板要能一眼数出「几篇草稿几篇已发」、要能搜标题和正文，
   * 若让前端逐篇再请求一次，文章一多就现原形（这正是之前「最近动作」踩过的坑）。
   *
   * @param {{draftPushed?: Set<string>}} [hint] 哪些 id 有推草稿回执（由调用方一次性查好传入）
   */
  async function listArticles(hint = {}) {
    let names = [];
    try {
      names = await readdir(articlesDir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      if (!ID_PATTERN.test(name)) continue;
      try {
        const article = JSON.parse(await readFile(fileOf(name), "utf8"));
        const info = await stat(fileOf(name)).catch(() => null);
        const sections = Array.isArray(article.sections) ? article.sections : [];
        const life = lifecycleOf(article, { draftPushed: Boolean(hint.draftPushed?.has?.(article.id ?? name)) });
        out.push({
          id: article.id ?? name,
          title: article.title ?? "",
          subtitle: article.subtitle ?? "",
          summary: article.summary ?? "",
          template: article.template ?? DEFAULT_TEMPLATE,
          // 赛道：首页按赛道筛、卡片上标名字都靠它
          track: typeof article.track === "string" ? article.track : "",
          sections: sections.length,
          // 字数与「有没有正文」：用户要知道哪几篇还是空壳
          words: sections.reduce((sum, s) => sum + String(s?.body ?? "").replace(/\s+/g, "").length, 0),
          empty: sections.every((s) => !String(s?.body ?? "").trim()),
          images: countImages(article),
          cover: article.cover?.current || "",
          lifecycle: life,
          tags: Array.isArray(article.tags) ? article.tags : [],
          // 首页卡片要显示「卡在哪一步」，绑定信息得跟着列表出来，
          // 否则每张卡都要再发一个请求（文章一多就现原形）
          pipeline: article.pipeline ?? null,
          // 检索用：小标题和正文都进来（**只在服务端算，不下发**，见下面的 stripSearch）
          search: [
            article.title, article.subtitle, article.summary,
            ...(Array.isArray(article.tags) ? article.tags : []),
            ...sections.flatMap((s) => [s?.heading, s?.body]),
          ].map((t) => String(t ?? "")).join(" ").toLowerCase(),
          createdAt: Number(article.createdAt) || 0,
          updatedAt: Number(article.updatedAt) || info?.mtimeMs || 0,
        });
      } catch {
        // 目录在但 article.json 坏了：跳过，不阻塞整个列表
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 已出图张数（封面 + 已配图的段落）。 */
  function countImages(article) {
    let n = 0;
    if (article?.cover?.current && (article.cover.versions ?? []).length) n += 1;
    for (const section of article?.sections ?? []) {
      if (section?.image?.current && (section.image.versions ?? []).length) n += 1;
    }
    return n;
  }

  /** 读一篇文章；不存在回 null。 */
  async function readArticle(id) {
    const safe = checkId(id);
    if (!safe) return null;
    try {
      return JSON.parse(await readFile(fileOf(safe), "utf8"));
    } catch {
      return null;
    }
  }

  /** 写一篇文章（补 `updatedAt`）。 */
  async function writeArticle(article) {
    const safe = checkId(article?.id);
    if (!safe) throw new Error("文章 id 不合法");
    const next = { ...article, id: safe, updatedAt: Date.now() };
    await writeJson(fileOf(safe), next);
    return next;
  }

  /**
   * 新建文章。
   * @param {{title?: string, subtitle?: string, summary?: string, audience?: string, takeaway?: string, forbidden?: string, template?: string, sections?: number|object[]}} [input]
   */
  async function createArticle(input = {}) {
    const id = newId();
    const requested = Array.isArray(input.sections) ? input.sections.length : Number(input.sections) || 0;
    const count = Math.min(24, Math.max(0, requested));
    const sections = Array.from({ length: count }, (_, index) => makeSection({ index }));
    const article = {
      v: 1,
      id,
      title: String(input.title ?? ""),
      subtitle: String(input.subtitle ?? ""),
      summary: String(input.summary ?? ""),
      audience: String(input.audience ?? ""),
      takeaway: String(input.takeaway ?? ""),
      forbidden: String(input.forbidden ?? ""),
      template: TEMPLATE_IDS.includes(input.template) ? input.template : DEFAULT_TEMPLATE,
      // 赛道：和 save 侧同一个 id 形状校验；不合法就当没选（而不是写进一个坏 id）。
      ...(typeof input.track === "string" && /^[a-z][a-z0-9-]{1,31}$/.test(input.track) ? { track: input.track } : {}),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cover: emptySlot("cover", { size: "900x383" }),
      sections,
    };
    await writeJson(fileOf(id), article);
    await appendLedger(id, { type: "create", note: `新建文章，${count} 段`, template: article.template });
    return article;
  }

  /**
   * 哪些文章真的推过草稿箱（给「草稿箱」这个生命周期做旁证）。
   *
   * 判据只认账本里的 `publish` 事件，且 `persisted` 不能是 false——
   * `dry-run` 回执（persisted=false）**不算推过**，它只是模拟，
   * 拿它当证据会让「草稿箱」里混进根本没推的篇。
   *
   * 一次读全部，别在列表循环里逐篇查。
   * @returns {Promise<Set<string>>}
   */
  async function idsWithDraftReceipt() {
    const out = new Set();
    let names = [];
    try {
      names = await readdir(articlesDir);
    } catch {
      return out;
    }
    for (const name of names) {
      if (!ID_PATTERN.test(name)) continue;
      let text = "";
      try {
        text = await readFile(ledgerOf(name), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let event = null;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event?.type !== "publish") continue;
        if (event.persisted === false) continue; // 模拟回执不算
        out.add(String(event.id ?? name));
      }
    }
    return out;
  }

  /**
   * 记忆账本：append-only。
   * @param {string} id
   * @param {object} event
   */
  async function appendLedger(id, event) {
    const safe = checkId(id);
    if (!safe) return;
    const line = { v: 1, ts: Date.now(), ...event };
    await mkdir(dirOf(safe), { recursive: true });
    await appendFile(ledgerOf(safe), `${JSON.stringify(line)}\n`, "utf8");
    return line;
  }

  /** 回读账本（新的在后）。坏行跳过，不整体失败。 */
  async function readLedger(id, limit = ledgerLimit) {
    const safe = checkId(id);
    if (!safe) return [];
    let text = "";
    try {
      text = await readFile(ledgerOf(safe), "utf8");
    } catch {
      return [];
    }
    const lines = text.split("\n").filter(Boolean);
    const parsed = [];
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        // 坏行（手改 / 写一半断电）跳过
      }
    }
    return parsed.slice(-Math.max(1, Math.min(2000, Number(limit) || ledgerLimit)));
  }

  /**
   * 跨文章的「最近动作」。
   *
   * 首页要回答的是「我刚才干了什么」，不是「某一篇的完整历史」——后者进单篇的治理视图看。
   * 所以这里把每篇账本的**尾巴**合起来按时间倒序，每篇只取最后几条、总条数封顶：
   * 文章一多也不会把首页拖慢，也不会被某一篇的老历史刷屏。
   *
   * @param {number} [limit] 最多返回几条
   */
  async function recentActivity(limit = 14) {
    const size = Math.max(1, Math.min(50, Number(limit) || 14));
    const articles = await listArticles();
    const rows = [];
    for (const meta of articles.slice(0, 80)) {
      // 每篇取 60 条原始账本：因为下面会把「连续同种动作」折叠掉，原始条数必须远大于展示条数，
      // 否则连点十几次导出就把窗口占满、折叠完只剩一行，真正有价值的「出图」「改稿」被挤到窗口外。
      // 取 12 条时，一次验收跑（连点 12 次导出）就足以让别的动作全部消失——所以放到 60。
      // 成本为零：readLedger 无论如何都要读完整个文件再切片。
      const events = await readLedger(meta.id, 60);
      for (const event of events) {
        // 绑定/解绑期号是**配置杂事**，不是编辑动作。它留在账本里做审计，
        // 但不进「最近动作」——那栏回答的是「我刚才写了什么、改了什么图」。
        // 混进去会挤掉真正的内容工作，尤其验收脚本每跑一次就多一对绑定记录。
        const fields = Array.isArray(event?.fields) ? event.fields : [];
        if (fields.includes("pipeline:bound") || fields.includes("pipeline:unbound")) continue;
        if (event?.type === "pipeline:bound" || event?.type === "pipeline:unbound") continue;
        rows.push({
          id: meta.id,
          title: meta.title || "（无标题）",
          type: String(event?.type ?? ""),
          ts: Number(event?.ts) || 0,
          event,
        });
      }
    }

    /**
     * 连续的同一种动作折叠成一条（`count` 记次数）。
     *
     * 不折的话，「连点五次导出」会把这栏刷成五行一模一样的「导出 html」，
     * 真正有价值的「出图」「改稿」被挤到看不见。折叠只在**相邻**发生时做——
     * 中间夹了别的事就不合并，因为那说明是两段不同的操作。
     */
    const signature = (event) => [
      event?.type ?? "", event?.slot ?? "", event?.vid ?? "", event?.format ?? "",
      event?.pid ?? "", (event?.fields ?? []).join(","), event?.verbatim ?? "",
      // decision 也要进签名：三次「提了改稿提案」pid 不同，本来是三件事；
      // 但如果同一个 pid 的 proposed 与 confirmed 挨着出现，不区分就会折成一条，
      // 让人以为提案既没提也没确认。
      event?.decision ?? "",
    ].join("|");
    const merged = [];
    for (const row of rows.sort((a, b) => b.ts - a.ts)) {
      const previous = merged[merged.length - 1];
      if (previous && previous.id === row.id && signature(previous.event) === signature(row.event)) {
        previous.count += 1;
        continue;
      }
      merged.push({ ...row, count: 1 });
    }
    return merged.slice(0, size);
  }


  /**
   * 改稿提案落盘：`<articleDir>/proposals/<pid>.json`。
   * 放在文章目录里而不是全局目录，是为了「一篇文章的东西都在同一个文件夹」——
   * 拷走一个目录就带走了正文、账本、图和提案，不会漏。
   */
  const proposalsDirOf = (id) => join(dirOf(id), "proposals");
  const proposalFileOf = (id, pid) => join(proposalsDirOf(id), `${pid}.json`);

  /**
   * 05/06 两份清单的逐项确认：`<articleDir>/reviews.json`（与 article.json 同级）。
   *
   * **为什么存在插件目录里、不写回真实仓**：那个仓是内容生产的事实源，插件往里塞一份
   * 面板状态文件，会让「盘上有什么」说不清（下游脚本扫到它算什么？）。而这份文件记的是
   * **面板上的确认动作**，不是内容事实——两者不该混在一个地方。
   *
   * 它与 `proposals/` 同一个作用域，好处一致：拷走一个文章目录，正文、账本、图、
   * 提案、清单确认全都带走。
   */
  const reviewsFileOf = (id) => join(dirOf(id), "reviews.json");

  /** 读清单确认状态；不存在 / 坏了都当空（并归一化掉非法 key）。 */
  async function readReviews(id) {
    const safeId = checkId(id);
    if (!safeId) return emptyReviews();
    try {
      return normalizeReviews(JSON.parse(await readFile(reviewsFileOf(safeId), "utf8")));
    } catch {
      return emptyReviews();
    }
  }

  /** 写清单确认状态（原子写）。 */
  async function writeReviews(id, state) {
    const safeId = checkId(id);
    if (!safeId) throw new Error("文章 id 不合法");
    const next = normalizeReviews(state);
    await writeJson(reviewsFileOf(safeId), next);
    return next;
  }

  /** 写一份提案（整文件原子写；提案一旦落盘，正文不动）。 */
  async function writeProposal(id, proposal) {
    const safeId = checkId(id);
    const safePid = checkPid(proposal?.pid);
    if (!safeId || !safePid) throw new Error("提案 id 不合法");
    await writeJson(proposalFileOf(safeId, safePid), { ...proposal, pid: safePid, id: safeId });
    return proposal;
  }

  /** 读一份提案；不存在 / 坏了都回 null。 */
  async function readProposal(id, pid) {
    const safeId = checkId(id);
    const safePid = checkPid(pid);
    if (!safeId || !safePid) return null;
    try {
      return JSON.parse(await readFile(proposalFileOf(safeId, safePid), "utf8"));
    } catch {
      return null;
    }
  }

  /**
   * 列提案（新的在前，最多 50 份）。
   * 只读目录里能解析的；坏文件跳过，不让一份坏提案把整个面板拖死。
   * @param {string} id
   * @param {{status?: string}} [filter]
   */
  async function listProposals(id, filter = {}) {
    const safeId = checkId(id);
    if (!safeId) return [];
    let names = [];
    try {
      names = await readdir(proposalsDirOf(safeId));
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      const pid = name.replace(/\.json$/, "");
      if (!PID_PATTERN.test(pid) || !name.endsWith(".json")) continue;
      const proposal = await readProposal(safeId, pid);
      if (!proposal) continue;
      if (filter.status && proposal.status !== filter.status) continue;
      out.push(proposal);
    }
    return out.sort((a, b) => Number(b.createdAt) - Number(a.createdAt)).slice(0, 50);
  }

  /**
   * 落一张生成好的图。旧版不覆盖：新版本号一定比现有的都大。
   * @param {string} id
   * @param {string} slot
   * @param {{bytes: Buffer|Uint8Array, ext: string, mime: string, width: number, height: number, prompt: string, negative?: string, node: string, model: string, note?: string}} image
   */
  async function saveImage(id, slot, image) {
    const safeId = checkId(id);
    const safeSlot = checkSlot(slot);
    if (!safeId || !safeSlot) throw new Error("id 或槽位不合法");
    const article = await readArticle(safeId);
    if (!article) throw new Error("文章不存在");

    const target = slotOf(article, safeSlot);
    if (!target) throw new Error("文章里没有这个槽位");

    const vid = nextVid(target.versions);
    const ext = image.ext === "png" ? "png" : image.ext === "jpg" ? "jpg" : "svg";
    const rel = `images/${safeSlot}/${vid}.${ext}`;
    const abs = join(dirOf(safeId), rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, Buffer.from(image.bytes));

    const version = {
      vid,
      file: rel,
      mime: image.mime,
      width: Number(image.width) || 0,
      height: Number(image.height) || 0,
      prompt: String(image.prompt ?? ""),
      negative: String(image.negative ?? ""),
      node: String(image.node ?? ""),
      model: String(image.model ?? ""),
      createdAt: Date.now(),
      bytes: Buffer.from(image.bytes).length,
      note: String(image.note ?? ""),
    };
    target.versions = [...target.versions, version];
    target.current = vid;
    // prompt 无条件跟着最新一次出图走：调用方明确给的 prompt 才是「刚用过的那句」。
    // 旧写法是 `if (!target.prompt) ...`，导致改了 prompt 出图后槽位里留的还是旧 prompt，
    // 面板显示旧值、下次出图又用回旧的——账本记的和正文存的成了两回事。
    if (version.prompt) target.prompt = version.prompt;
    if (version.negative) target.negative = version.negative;
    await writeArticle(article);
    return { version, article };
  }

  /** 切当前版本（只改指针）。 */
  async function pickVersion(id, slot, vid) {
    const safeId = checkId(id);
    const safeSlot = checkSlot(slot);
    const safeVid = checkVid(vid);
    if (!safeId || !safeSlot || !safeVid) throw new Error("参数不合法");
    const article = await readArticle(safeId);
    if (!article) throw new Error("文章不存在");
    const target = slotOf(article, safeSlot);
    if (!target) throw new Error("文章里没有这个槽位");
    if (!target.versions.some((v) => v.vid === safeVid)) throw new Error("没有这个版本");
    target.current = safeVid;
    return writeArticle(article);
  }

  /** 按文章结构取槽位对象（封面或段落配图）。 */
  function slotOf(article, slot) {
    if (slot === "cover") {
      article.cover ??= emptySlot("cover");
      article.cover.versions ??= [];
      return article.cover;
    }
    const section = (article.sections ?? []).find((s) => `sec-${s.id}` === slot);
    if (!section) return null;
    section.image ??= emptySlot(slot);
    section.image.versions ??= [];
    return section.image;
  }

  /** 取某个版本文件在盘上的绝对路径（白名单校验后才拼）。 */
  function imagePath(article, slot, vid) {
    const target = slotOf(article, slot);
    if (!target) return null;
    const version = target.versions.find((v) => v.vid === vid);
    if (!version) return null;
    // `file` 是生成时写死的相对路径；再校验一次形态，防止手改 article.json 注入 `../`
    if (!/^images\/(cover|sec-s[0-9]{1,4})\/v[0-9]{3}\.(svg|png|jpg)$/.test(String(version.file))) return null;
    return { path: join(dirOf(article.id), version.file), mime: version.mime };
  }

  return {
    root,
    articlesDir,
    settingsFile,
    dirOf,
    readSettings,
    writeSettings,
    listArticles,
    readArticle,
    writeArticle,
    createArticle,
    appendLedger,
    readLedger,
    recentActivity,
    idsWithDraftReceipt,
    writeProposal,
    readProposal,
    listProposals,
    proposalsDirOf,
    readReviews,
    writeReviews,
    reviewsFileOf,
    saveImage,
    pickVersion,
    slotOf,
    imagePath,
    countImages,
    defaultNode,
  };
}
