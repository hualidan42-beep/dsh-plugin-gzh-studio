/**
 * 公众号工作台的宿主半。
 *
 * 职责只有三件：**落盘、出图、导出**。所有纯逻辑（QA / 模板 / 渲染 / 存储）在 `lib/` 里，
 * 浏览器半是单 bundle、import 不到 `lib/`，所以它拿到的每个数都从这里下发，
 * 它自己不再算一份（算两份必然漂）。
 *
 * 无第三方依赖；标准 Cordis 插件面：`name` / `inject` / `provide` / `apply`。
 * 鉴权：所有路由挂在 `/api` 下，走 Connection 的浏览器信任栅栏，浏览器半碰不到文件系统。
 * @module dsh-plugin-gzh-studio
 */

import { readFile, stat, readdir, rename } from "node:fs/promises";
import { watch, mkdirSync, createReadStream, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore, checkId, checkSlot, checkVid, DEFAULTS, makeSection, nextVid, nextSectionId, emptySlot } from "./lib/store.js";
import { runQa } from "./lib/qa.js";
import { TEMPLATES, TEMPLATE_IDS, DEFAULT_TEMPLATE } from "./lib/templates.js";
import {
  renderWechatBody, renderMarkdown, renderChecklistText, imageChecklist, pickVersion,
} from "./lib/render.js";
import { generateImage, describeNode, checkNodeTarget, defaultSizeFor, probeSize } from "./lib/generate.js";
import { findImageModel, generateWithHost } from "./lib/hostImage.js";
import * as wechat from "./lib/wechat.js";
import * as pipeline from "./lib/pipeline.js";
import * as stock from "./lib/stock.js";
import * as repo from "./lib/repo.js";
import * as video from "./lib/video.js";
import * as trackLib from "./lib/tracks.js";
import { markLifecycle, lifecycleOf } from "./lib/store.js";
import {
  buildProposal, checkPid, guardDecision, summarizeChanges, proposalEvent,
  articleContentHash, PROPOSAL_STATUS,
  inferKind, alsoTouches, KIND_ROUTE,
} from "./lib/proposal.js";
import { focusRows } from "./lib/diff.js";
import { diagnose as diagnoseDeai, applySentences } from "./lib/deai.js";
import { collectFeedback, pickFeedback, promptSuffix, cleanVerbatim, feedbackSummary } from "./lib/feedback.js";
import {
  CHECKLISTS, CHECKLIST_ORDER, CHECK_KIND, CHECK_ITEM,
  toggleItem, reviewStatus, reconcile,
} from "./lib/reviews.js";

/** 稳定 Cordis 插件名。 */
export const name = "gzh-studio";

/** 激活前需要的服务。`llm` 用于出图时借宿主已配好的模型（见 lib/hostImage.js）。 */
export const inject = ["connection", "llm"];

/** 本插件向服务树提供的服务。 */
export const provide = ["gzhStudio"];

/** 插件根目录（`import.meta.url` 定位，不数 `..`）。 */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

/** 路由表（全部位于 /api 下，走 Connection 鉴权）。 */
export const ROUTES = {
  status: "/api/gzh-studio.status",
  state: "/api/gzh-studio.state",
  article: "/api/gzh-studio.article",
  create: "/api/gzh-studio.create",
  // 删一篇：移到回收站（不硬删），需要重启 dsh web 才会挂上这条
  remove: "/api/gzh-studio.remove",
  // 推草稿箱：状态（配没配）与真推一次。同样需要重启后才有。
  wechatStatus: "/api/gzh-studio.wechatStatus",
  push: "/api/gzh-studio.push",
  save: "/api/gzh-studio.save",
  script: "/api/gzh-studio.script",
  generate: "/api/gzh-studio.generate",
  pick: "/api/gzh-studio.pick",
  feedback: "/api/gzh-studio.feedback",
  export: "/api/gzh-studio.export",
  image: "/api/gzh-studio.image",
  node: "/api/gzh-studio.node",
  brief: "/api/gzh-studio.brief",
  pipeline: "/api/gzh-studio.pipeline",
  propose: "/api/gzh-studio.propose",
  proposal: "/api/gzh-studio.proposal",
  decide: "/api/gzh-studio.decide",
  deai: "/api/gzh-studio.deai",
  adoptDeai: "/api/gzh-studio.adoptDeai",
  review: "/api/gzh-studio.review",
  // 实时同步（SSE）：写盘事件推给面板。浏览器半收不到就退回手动刷新。
  stream: "/api/gzh-studio.stream",
  // 真源仓库（只读）：稿件列表 / 单篇 / 视频期 / 质量门。字段名以
  // `design/contract-gzh-workbench.md` 的路由契约为准，别在这里改名。
  repo: "/api/gzh-studio.repo",
  repoArticle: "/api/gzh-studio.repoArticle",
  video: "/api/gzh-studio.video",
  videoEpisode: "/api/gzh-studio.videoEpisode",
  // 视频期目录的两个动作：指到已有目录（path）/ 建出约定目录（create）
  videoSetup: "/api/gzh-studio.videoSetup",
  // 视频期里的媒体文件（成片 / 封面 / 分镜图 / 字幕）：支持 Range，<video> 才能拖进度条。
  media: "/api/gzh-studio.media",
  gate: "/api/gzh-studio.gate",
};

/** 可被 patch 直接覆盖的标量字段（白名单，别的一律忽略）。 */
const SCALAR_FIELDS = ["title", "subtitle", "summary", "audience", "takeaway", "forbidden"];
/** 字段长度上限（防止一次粘贴把 article.json 撑爆）。 */
const MAX_LEN = { title: 200, subtitle: 400, summary: 400, audience: 200, takeaway: 400, forbidden: 800 };

/**
 * 「没选内容类型」的筛选哨兵。
 *
 * 空串在 `?track=` 里表示**不筛**，所以不能拿空串当「只看通用稿」——
 * 两者含义正好相反，用同一个值会让人点了筛选却发现列表没变。
 */
export const TRACK_NONE = "__none";

/** 解析 loader 配置。 */
function mergeConfig(raw) {
  const config = raw && typeof raw === "object" ? raw : {};
  return {
    root: typeof config.root === "string" && config.root.trim() ? config.root.trim() : DEFAULTS.root,
    ledgerLimit: Number(config.ledgerLimit) > 0 ? Number(config.ledgerLimit) : DEFAULTS.ledgerLimit,
  };
}

/** JSON 响应（实时状态不缓存）。 */
function json(payload, status = 200) {
  return Response.json(payload, { status, headers: { "cache-control": "no-store" } });
}

/** 统一错误体。 */
function failure(error, status = 500) {
  // 错误体除了 message，还要把「能照着做」的字段带出去：
  // 微信的 `40164` 要带 IP（否则用户不知道加哪个），限额要带 problems（一次显示三条）。
  const payload = { message: error?.message ?? String(error) };
  for (const key of ["code", "ip", "hint", "detail", "problems", "stats"]) {
    if (error?.[key] !== undefined && error?.[key] !== null) payload[key] = error[key];
  }
  return json({ error: payload }, status);
}

/** 纯文本响应（导出用）。 */
function text(body, contentType = "text/plain; charset=utf-8") {
  return new Response(body, { status: 200, headers: { "content-type": contentType, "cache-control": "no-store" } });
}

/**
 * 应用一次 patch。**只认白名单键**：请求里多出来的字段直接忽略，不会写进 article.json。
 * @param {object} article
 * @param {object} patch
 * @returns {{article: object, changed: string[]}}
 */
export function applyPatch(article, patch) {
  const changed = [];
  const input = patch && typeof patch === "object" ? patch : {};

  for (const field of SCALAR_FIELDS) {
    if (typeof input[field] !== "string") continue;
    const value = input[field].slice(0, MAX_LEN[field]);
    if (article[field] !== value) {
      article[field] = value;
      changed.push(field);
    }
  }

  if (typeof input.template === "string" && TEMPLATE_IDS.includes(input.template) && article.template !== input.template) {
    article.template = input.template;
    changed.push("template");
  }

  // 段落：按 id 合并（不整表替换——否则并发保存会丢图）
  if (Array.isArray(input.sections)) {
    article.sections ??= [];
    for (const incoming of input.sections) {
      if (!incoming || typeof incoming !== "object") continue;
      const heading = typeof incoming.heading === "string" ? incoming.heading.slice(0, 200) : undefined;
      const body = typeof incoming.body === "string" ? incoming.body.slice(0, 20_000) : undefined;
      const id = typeof incoming.id === "string" && /^s[0-9]{1,4}$/.test(incoming.id) ? incoming.id : null;
      let section = id ? article.sections.find((s) => s.id === id) : null;
      if (!section) {
        if (article.sections.length >= 24) continue;
        // 新增段落的 id 由现有最大序号推出来，不能拿「当前长度 + 1」——删过段就会撞号。
        section = makeSection({ id: nextSectionId(article.sections) });
        article.sections.push(section);
      }
      if (heading !== undefined && section.heading !== heading) {
        section.heading = heading;
        changed.push(`section:${section.id}:heading`);
      }
      if (body !== undefined && section.body !== body) {
        section.body = body;
        changed.push(`section:${section.id}:body`);
      }
    }
  }

  // 删段（显式给 id）
  if (Array.isArray(input.removeSections)) {
    for (const id of input.removeSections) {
      if (typeof id !== "string" || !/^s[0-9]{1,4}$/.test(id)) continue;
      const before = article.sections?.length ?? 0;
      article.sections = (article.sections ?? []).filter((s) => s.id !== id);
      if (article.sections.length !== before) changed.push(`section:${id}:removed`);
    }
  }

  /**
   * 标签：自由填几个词，用来检索。
   *
   * 三条口径，都是为了「不增加复杂度」：
   * 1. 去重、去空、限长（单个 ≤ 20 字、最多 12 个）——不然标签会变成第二个正文；
   * 2. **大小写不敏感去重**（`GxP` 与 `gxp` 是同一个），但**保留用户写的第一种写法**，
   *    否则用户填的 `GxP` 会被我改成小写，看着像被篡改；
   * 3. 传空数组等于清空。
   */
  if (Array.isArray(input.tags)) {
    const seen = new Map();
    for (const raw of input.tags) {
      const text = String(raw ?? "").trim().slice(0, 20);
      if (!text) continue;
      const key = text.toLowerCase();
      if (!seen.has(key)) seen.set(key, text);
      if (seen.size >= 12) break;
    }
    const next = [...seen.values()];
    const before = Array.isArray(article.tags) ? article.tags : [];
    if (JSON.stringify(before) !== JSON.stringify(next)) {
      article.tags = next;
      changed.push("tags");
    }
  }

  /**
   * 赛道：空串表示清掉；其余必须是「小写字母 / 数字 / 短横线」的包 id。
   *
   * 这里**不校验包是否存在**（applyPatch 是纯函数，读不到盘）。包不存在时
   * 面板显示「未选择赛道」、QA 也不跑赛道规则——写一个不存在的 id
   * 比把一段乱七八糟的字符串写进 article.json 好排查。
   */
  if (typeof input.track === "string") {
    const next = input.track.trim();
    if (!next) {
      if (article.track) {
        delete article.track;
        changed.push("track");
      }
    } else if (/^[a-z][a-z0-9-]{1,31}$/.test(next) && article.track !== next) {
      article.track = next;
      changed.push("track");
    }
  }


  // 生命周期：草稿 / 草稿箱 / 已发布。人显式标的那条路。
  // **只有人能标**：账户没接公众号 API，机器无从知晓是否真的发布了。
  if (typeof input.lifecycle === "string") {
    if (markLifecycle(article, input.lifecycle)) changed.push("lifecycle");
  }

  // 槽位：prompt / 反向词 / 图注 / 尺寸
  if (input.slot && typeof input.slot === "object") {
    const slot = checkSlot(input.slot.slot);
    if (slot) {
      const target = slot === "cover"
        ? (article.cover ??= emptySlot("cover", { size: "900x383" }))
        : article.sections?.find((s) => `sec-${s.id}` === slot)?.image;
      if (target) {
        for (const field of ["prompt", "negative", "caption", "size"]) {
          if (typeof input.slot[field] !== "string") continue;
          const value = input.slot[field].slice(0, field === "prompt" ? 2000 : 600);
          if (target[field] !== value) {
            target[field] = value;
            changed.push(`${slot}:${field}`);
          }
        }
      }
    }
  }

  // 流水线绑定：这一篇对应哪一期（期号 + 根目录）。
  // 绑定那一刻把正文哈希钉下来——之后在面板上改过字，状态里立刻能看出 `drift`，
  // 不用等去比文件哈希。期号为空等于解绑。
  if (input.pipeline && typeof input.pipeline === "object") {
    const episodeId = String(input.pipeline.episodeId ?? "").trim().slice(0, 120);
    const root = String(input.pipeline.root ?? "").trim().slice(0, 400);
    if (!episodeId) {
      if (article.pipeline) {
        article.pipeline = null;
        changed.push("pipeline:unbound");
      }
    } else {
      // 期号与根目录最终都会变成路径的一段：在**绑定时**就拦住越界写法，
      // 而不是等 `/pipeline` 去读盘时才失败——那时脏值已经留在 article.json 里了。
      const safeEpisode = pipeline.checkEpisodeId(episodeId);
      if (!safeEpisode) {
        throw Object.assign(new Error("期号不合法：不能含路径分隔符、`..`、Windows 非法字符，最长 80 字符"), { status: 400 });
      }
      if (root) {
        if (!isAbsolute(root)) throw Object.assign(new Error("流水线根目录必须是绝对路径"), { status: 400 });
        if (root.split(/[\\/]+/).some((part) => part === "..")) {
          throw Object.assign(new Error("流水线根目录不合法：不能含 `..`"), { status: 400 });
        }
      }
      article.pipeline = {
        episodeId: safeEpisode,
        root,
        articleHash: pipeline.articleHash(article),
        boundAt: Date.now(),
      };
      changed.push("pipeline:bound");
    }
  }

  return { article, changed };
}

/**
 * 出图模型：显式配置优先（`settings.imageModel` 写 `provider/model`），否则在模型目录里找 id 带 image 的。
 * @param {{imageModel?: string}} settings
 */
function imageModelOf(settings) {
  const raw = String(settings?.imageModel ?? "").trim();
  if (!raw) return null;
  const [provider, ...rest] = raw.split("/");
  const model = rest.join("/");
  if (!provider || !model) return null;
  return { provider, model, label: raw };
}

/** 把尺寸说成人话拼进 prompt：多数出图模型不认 `size` 参数，只认提示词里的比例描述。 */
function imagePromptOf(prompt, size) {
  const matched = /^(\d+)x(\d+)$/.exec(String(size ?? ""));
  if (!matched) return prompt;
  const width = Number(matched[1]);
  const height = Number(matched[2]);
  const ratio = width === height ? "正方形" : width > height ? `横版 ${width}:${height}` : `竖版 ${width}:${height}`;
  return `${prompt}\n\n画面：${ratio}构图，${width}×${height}；不要文字、不要水印、不要拼贴。`;
}

/**
 * 服务体：把落盘 / 出图 / 导出编成方法，`ctx.provide` 之后其它插件也能直接调。
 * @param {{root: string, ledgerLimit: number}} config
 * @param {{info?: Function, warn?: Function}} logger
 */
export function createService(config, logger = {}, deps = {}) {
  const store = createStore(config);
  // 宿主模型服务（`ctx.llm`）。没传就是「这台机器没有模型可用」——
  // 单测与离线环境走这条路，出图会明确报「还没有能出图的模型」，而不是假装成功。
  const llm = deps.llm ?? null;
  // 公众号草稿箱客户端：只读 ~/.dsh/gzh-studio/wechat.json（AppID / AppSecret / 作者）
  const wechatClient = wechat.createClient({ root: store.root, logger });

  /**
   * 全部赛道包：内置 12 条 + 用户自加（`<root>/tracks/*.json`）。
   *
   * 缓存 10 秒：首页每次刷新都会问一遍，每次都 readdir 一遍太浪费；
   * 但也不长缓存——用户刚丢进去一个包，10 秒后就能选到，不用重启。
   */
  let trackCache = { at: 0, list: null };
  async function tracksAll() {
    if (trackCache.list && Date.now() - trackCache.at < 10_000) return trackCache.list;
    const list = [...trackLib.BUILTIN_TRACKS];
    try {
      const dir = join(store.root, "tracks");
      for (const entry of await readdir(dir)) {
        if (!entry.toLowerCase().endsWith(".json")) continue;
        try {
          const raw = JSON.parse(await readFile(join(dir, entry), "utf8"));
          const valid = trackLib.validateTrack(raw);
          if (!valid.ok) {
            logger?.warn?.(`gzh-studio: 赛道包 ${entry} 不合法：${valid.problems.join("；")}`);
            continue;
          }
          const pack = { ...valid.track, custom: true };
          // 撞了内置 id 就不覆盖：内置那套是兜底，被用户包顶掉会让规则来源说不清。
          if (!list.some((track) => track.id === pack.id)) list.push(pack);
        } catch (error) {
          logger?.warn?.(`gzh-studio: 赛道包 ${entry} 读不出来：${error?.message ?? error}`);
        }
      }
    } catch { /* 没有自定义目录是正常状态 */ }
    trackCache = { at: Date.now(), list };
    return list;
  }

  /**
   * 统一的 QA 出口：普通规则 + 赛道规则。
   *
   * 所有返回 `qa` 的地方都必须走这里——**两套规则各算一份，迟早会漂**
   * （面板上「检查通过」但赛道声明其实缺着，是最坏的那种漂）。
   * @param {object} article
   */
  async function qaOf(article) {
    const track = trackLib.trackOf(article?.track, await tracksAll());
    return trackLib.withTrackQa(runQa(article), article, track);
  }

  /** 节点列表 + 可用性（面板上直接标「不可用：环境变量没设」）。 */
  async function nodesView() {
    const settings = await store.readSettings();
    return settings.nodes.map((node) => ({ ...node, ...describeNode(node) }));
  }

  /** 面板首次渲染要的全部东西：文章列表 + 设置 + 模板 + 跨文章的最近动作。 */
  async function state(query = {}) {
    const settings = await store.readSettings();
    // 推草稿回执：哪些 id 真的推过草稿箱。「草稿箱」这个生命周期靠它推出来，
    // 不靠人记——一次查全，别在列表循环里逐篇去读盘。
    const articles = await store.listArticles();
    const view = stock.stock(articles, {
      // 原样传进去，让 stock 自己校验并标出「条件写错了」。
      // 这里先 checkState 一次会把非法值滤成空串，stock 就分不清「没筛」和「写错了」——
      // 用户会以为筛选生效了、结果只是没变化。
      state: String(query.state ?? "").slice(0, 40),
      q: String(query.q ?? "").slice(0, 120),
      // 标签与月份：目录检索的两个入口，都走服务端过滤
      tag: String(query.tag ?? "").trim().slice(0, 40),
      month: /^\d{4}-\d{2}$/.test(String(query.month ?? "")) ? String(query.month) : "",
      empty: query.empty === true || query.empty === "1",
    });
    // 赛道筛选在服务端做（与标签 / 月份同一层）：前端过滤会让「总数」和列表对不上。
    // 非法 / 不存在的赛道 id 当作不筛——和状态词笔误同一个口径。
    //
    // `__none` 是哨兵值：筛「没选内容类型」的稿（通用稿）。
    // 不能拿空串当哨兵——空串是「不筛」，两者含义相反。
    const trackList = await tracksAll();
    const trackFilter = String(query.track ?? "").trim();
    const wantUntracked = trackFilter === TRACK_NONE;
    const knownTrack = !wantUntracked && trackFilter && trackList.some((track) => track.id === trackFilter);
    const filtered = wantUntracked
      ? view.articles.filter((row) => !String(row.track ?? ""))
      : knownTrack
        ? view.articles.filter((row) => String(row.track ?? "") === trackFilter)
        : view.articles;
    const byTrack = {};
    let untrackedCount = 0;
    for (const row of view.articles) {
      const key = String(row.track ?? "");
      if (!key) {
        untrackedCount += 1;
        continue;
      }
      byTrack[key] = (byTrack[key] ?? 0) + 1;
    }
    return {
      root: store.root,
      // 库存三件事：多少篇 / 各在什么状态 / 搜得到谁。计数与列表来自同一次读取。
      counts: { ...view.counts, byTrack, untracked: untrackedCount },
      filters: { ...view.filters, track: trackFilter },
      matched: filtered.length,
      // 赛道包：面板的下拉、卡片标签、Inspector 提示都从这里取，不再各算一份。
      tracks: trackLib.tracksView(trackList),
      // 首页卡片要带「卡在哪一步」：有绑定的才去查盘，没绑定的不查。
      // 上限 20 篇——每篇要读台账/审批/交付件，无上限就等于首页被 IO 拖住。
      articles: await withPipeline(filtered.slice(0, 20)).then((head) => head.concat(filtered.slice(20))),
      // 首页右侧「最近动作」：一次请求给全，别让面板按文章数发 N 个请求
      activity: await store.recentActivity(14),
      settings: {
        defaultNode: settings.defaultNode,
        defaultTemplate: settings.defaultTemplate ?? DEFAULT_TEMPLATE,
        nodes: await nodesView(),
        // 绑期号时给个默认根目录，省得每次手输；settings 里没写就用空串（前端会提示必填）
        pipelineRoot: settings.pipelineRoot ?? "",
        // 期目录：空串 = 约定值。同时把**解析后**的绝对路径给出去，面板照它显示，
        // 不必在前端再拼一遍 `07-video/episode`（拼就要和宿主保持同步，迟早对不上）。
        episodesRoot: settings.episodesRoot ?? "",
        episodesRootResolved: repo.episodesRoot(),
      },
      templates: TEMPLATES,
      // 真源仓库配了没：面板据此决定要不要显示「视频号」那一栏。
      // 不给这个字段，前端就只能先打一次 /video 去猜，或者永远露着一个点进去是空的入口——
      // 新用户第一眼看到「八步缺口 / 还没选期」，最可能的反应是「看不懂」而不是「我去配仓库」。
      repoConfigured: repo.repoConfigured(),
      generatedAt: Date.now(),
    };
  }

  /**
   * 给文章卡片补 `pipeline` 状态。
   *
   * 状态机的判据全在盘上（台账、审批、交付件），所以这一步不是读内存，是**真去查文件**。
   * 查不出来不报错、不阻塞首页：`pipeline.status` 为 null 时卡片就不显示状态徽标。
   */
  async function withPipeline(articles) {
    return Promise.all(articles.map(async (meta) => {
      const binding = meta?.pipeline;
      if (!binding?.episodeId || !binding?.root) return meta;
      try {
        const view = await pipeline.locate({ root: binding.root, episodeId: binding.episodeId });
        return { ...meta, pipeline: { ...binding, ...view } };
      } catch (error) {
        return { ...meta, pipeline: { ...binding, bound: true, status: null, error: String(error?.message ?? error) } };
      }
    }));
  }

  /**
   * 单篇的流水线状态：状态词 + 下一步 + 十道门的证据，外加「面板里改过没」。
   *
   * `drift` 是这里独有的一件事：绑定时把当时的正文哈希记下来，之后正文一动就对不上。
   * 它与文件哈希职责不同——文件哈希认的是 `最终交付/…/10-公众号-文案.md`，
   * 而 drift 认的是「在这台面板上我又改过没有」。两者混用会得出
   * 「改了个空格全篇作废」或「改了半段却说没变」。
   */
  async function pipelineView(article) {
    const binding = article?.pipeline ?? null;
    if (!binding?.episodeId || !binding?.root) {
      return { bound: false, reason: "这篇还没有绑定期号", status: null, gates: [], unknown: 0 };
    }
    let view;
    try {
      view = await pipeline.locate({ root: binding.root, episodeId: binding.episodeId });
    } catch (error) {
      return { bound: true, ...binding, status: null, gates: [], unknown: 0, error: String(error?.message ?? error) };
    }
    const now = pipeline.articleHash(article);

    // ── 05 两份清单：盘上证据 + 面板勾选 合判 ──────────────────────────────
    //
    // `locate` 只查盘，这里再把「人在面板上逐项确认过」算进来。
    // 两种证据**必须能区分**：盘上清单是原始凭证，面板勾选是「我核过了」的留痕。
    // 只有面板勾满、盘上一个文件都没有时，判 ok 但 detail 要写清依据——
    // 否则下游会以为盘上有清单，去翻的时候翻不到。
    const reviews = await store.readReviews(article.id);
    const reviewState = reviewStatus(reviews);
    const disk = view.reviewDisk ?? { editor: false, reader: false };
    const gates = view.gates.map((item) => {
      if (item.no !== 5) return item;
      if (item.state === "ok") {
        // 「盘上有清单」才叫 disk。**多轮审稿兜底那条不算盘上清单**——
        // 026 期就是这样：门靠 `content_review.round*` 过了，但两份清单文件一个都没有。
        // 那时候标 basis=disk 等于骗人：人去翻文件会翻不到。
        const basis = disk.editor && disk.reader ? "disk" : "fallback";
        return {
          ...item,
          reviewBasis: basis,
          detail: basis === "disk"
            ? item.detail
            : `${item.detail}（盘上没有编辑审/读者审两份清单，这条是兜底判据）`,
        };
      }
      if (reviewState.ok) {
        return {
          ...item,
          state: "ok",
          reviewBasis: "panel",
          detail: `面板上 16 项验收已逐项确认${disk.editor || disk.reader ? "（盘上另有部分清单）" : "（盘上无清单文件，依据是面板确认）"}`,
        };
      }
      return {
        ...item,
        reviewBasis: "none",
        detail: reviewState.done
          ? `还差 ${reviewState.remaining}/16 项没勾：${(reviewState.list.flatMap((one) => one.missing)).slice(0, 2).join("；")}${reviewState.remaining > 2 ? "…" : ""}`
          : item.detail,
      };
    });
    // 面板勾满会让第 5 道门从 unknown 变 ok。**状态词必须跟着变**，
    // 否则会出现「门全绿、状态还是 needs-review」这种自相矛盾的面板。
    // 但只在「原本就卡在 05」时才改：卡在别的门（缺核验收据、缺审批）跟清单没关系，
    // 勾满清单不该让它看起来能推草稿了。
    const gate5 = gates.find((g) => g.no === 5);
    const uplift = gate5?.state === "ok" && gate5.reviewBasis === "panel"
      && view.status === pipeline.STATUS.NEEDS_REVIEW;
    const status = uplift ? pipeline.recomputeStatus(gates) : view.status;

    return {
      ...binding,
      ...view,
      status,
      gates,
      // `buildNodes` 出来的节点只有 `id`，没有 `gate` 字段——
      // 照着 `node.gate === 5` 找会永远不命中，改了门但节点条不动，面板自相矛盾。
      nodes: view.nodes?.map((node) => (node.id === "05"
        ? { ...node, state: gate5?.state === "ok" ? "done" : node.state, note: gate5?.detail ?? node.note }
        : node)),
      reviewState,
      reviewDisk: disk,
      reviewReconcile: reconcile(disk, reviews),
      binding,
      localHash: now,
      drift: Boolean(binding.articleHash && binding.articleHash !== now),
      boundAt: binding.boundAt ?? null,
    };
  }

  /** 单篇全文：文章 + QA + 账本 + 图片清单 + 提案摘要 + 流水线状态 + 去 AI 味 + 反馈 + 清单确认。 */
  async function articleView(id) {
    const article = await store.readArticle(id);
    if (!article) return null;
    const ledger = await store.readLedger(id);
    const reviewDoc = await store.readReviews(id);
    // 赛道包（含用户自定义）：没选就是 null，面板据此显示「未选择赛道」。
    const track = trackLib.trackOf(article.track, await tracksAll());
    return {
      article,
      lifecycle: lifecycleOf(article),
      qa: await qaOf(article),
      track: track ? trackLib.tracksView([track])[0] : null,
      ledger,
      checklist: imageChecklist(article),
      templates: TEMPLATES,
      nodes: await nodesView(),
      defaults: { cover: defaultSizeFor("cover").label, section: defaultSizeFor("sec-s1").label },
      proposals: await proposalsSummary(id, article),
      pipeline: await pipelineView(article),
      // 去 AI 味：一次算全篇（句子级），面板按段分组显示。纯 CPU，不读盘不联网。
      deai: diagnoseDeai(article),
      // 反馈：按槽位分好组，面板不用自己再从账本里筛（筛两份必然漂）
      feedback: feedbackGroups(ledger),
      // 05/06 两份清单的逐项确认。条目文案来自 SKILL.md 的「验收」小节，
      // 面板只负责勾，不自己编条目——编了就跟 SKILL 对不上，勾了也不算数。
      reviews: reviewStatus(reviewDoc),
    };
  }

  /**
   * 把账本折成「每个槽位有几条待用反馈」。
   *
   * 一次算全篇而不是每个槽位查一次：槽位有二十几个，逐个查账本就是二十几次全文件解析。
   * 顺带给出 `open` 总数，首页和提案卡要显示「这次会带上几条反馈」。
   */
  function feedbackGroups(ledger) {
    const rows = Array.isArray(ledger) ? ledger : [];
    const slots = new Map();
    for (const row of collectFeedback(rows).all) {
      const slot = row.slot || "";
      if (!slot) continue;
      if (!slots.has(slot)) slots.set(slot, { slot, open: 0, used: 0, items: [] });
      const bucket = slots.get(slot);
      if (row.used) bucket.used += 1;
      else bucket.open += 1;
      bucket.items.push(row);
    }
    const view = collectFeedback(rows);
    return {
      bySlot: Object.fromEntries(slots),
      open: view.open.length,
      used: view.used.length,
      summary: feedbackSummary(view),
    };
  }

  /**
   * 提案摘要：**不带 diff 大字段**（一份提案的对照可能有几十 KB，全塞进首屏载荷会把面板拖慢）。
   * 面板拿到的是"有几份、改了哪几处、要不要点开看"；真要对照再走 `/proposal` 拉单份。
   * @param {string} id
   * @param {object|null} article 当前文章（用来算 `stale`，省一次读盘）
   */
  async function proposalsSummary(id, article) {
    const list = await store.listProposals(id);
    const stamp = Number(article?.updatedAt) || 0;
    // 与 guardDecision 同一口径：有内容哈希就比哈希，老提案才退回时间戳。
    // 两边口径不一致会出现「面板说已过期、点确认却能过」或反过来——那种矛盾比不做检查更糟。
    const contentHash = article ? articleContentHash(article) : "";
    return list.map((proposal) => ({
      pid: proposal.pid,
      status: proposal.status,
      createdAt: Number(proposal.createdAt) || 0,
      decidedAt: Number(proposal.decidedAt) || 0,
      note: String(proposal.note ?? ""),
      summary: summarizeChanges(proposal.changes),
      count: Array.isArray(proposal.changes) ? proposal.changes.length : 0,
      // 性质决定该退到哪一步。老提案没存 kind 就现推一次——推的是实际改动，不是猜的。
      kind: proposal.kind ?? inferKind(proposal.changes),
      alsoTouches: alsoTouches(proposal.changes),
      route: KIND_ROUTE[proposal.kind ?? inferKind(proposal.changes)] ?? null,
      // 正文在提案之后被改过 → 这份对照已经过期，点确认会被 409 拦下
      stale: proposal.baseHash ? proposal.baseHash !== contentHash : Number(proposal.baseUpdatedAt) !== stamp,
    }));
  }

  /** 出图 + 落盘 + 记账。一次调用只出一张（逐张出图才有版本可留）。 */
  async function generate(input = {}) {
    const id = checkId(input.id);
    const slot = checkSlot(input.slot);
    if (!id || !slot) throw Object.assign(new Error("id 或槽位不合法"), { status: 400 });
    const article = await store.readArticle(id);
    if (!article) throw Object.assign(new Error("文章不存在"), { status: 404 });

    const target = store.slotOf(article, slot);
    if (!target) throw Object.assign(new Error("文章里没有这个槽位"), { status: 400 });

    const prompt = String(input.prompt ?? target.prompt ?? "").trim().slice(0, 2000);
    const negative = String(input.negative ?? target.negative ?? "").trim().slice(0, 600);
    if (!prompt) throw Object.assign(new Error("先写 prompt 再出图"), { status: 400 });

    // 反馈回流：这个槽位还没被带进任何一版的反馈，自动拼进 prompt。
    // 出图是异步的一次性动作，界面上写「上次你说要颗粒感」模型看不到；只有进 prompt 才真影响这一版。
    // 但拼接必须留痕——事件里记下带了哪几条，否则「这版为什么长这样」查不到。
    // 人可以在面板上勾掉某条（`feedbackKeys`），勾掉的不带：有些话是当时的临时意见，不该一直跟着。
    const ledgerBefore = await store.readLedger(id, 400);
    const carry = pickFeedback(ledgerBefore, {
      slot,
      keys: Array.isArray(input.feedbackKeys) ? input.feedbackKeys : undefined,
    });
    const suffix = promptSuffix(carry);
    // 赛道风格前缀：医疗要「冷白临床、无人脸特写」，AI 要「界面截图、不要机器人拟人插画」。
    // 拼在 prompt 最前面（风格权重最高），并且一起进账本——将来能查「这版为什么长这样」。
    const generateTrack = trackLib.trackOf(article.track, await tracksAll());
    const stylePrefix = generateTrack?.imageStyle ? `${generateTrack.imageStyle}。` : "";
    const finalPrompt = `${stylePrefix}${prompt}${suffix}`;

    const settings = await store.readSettings();
    const preset = defaultSizeFor(slot);
    const size = /^\d+x\d+$/.test(String(input.size ?? "")) ? String(input.size) : target.size || preset.label;
    // 版本号用 store 的自增口径（跳号也往后走），占位图上的编号与落盘的一致
    const vid = nextVid(target.versions);

    // ── 出图路线 ──────────────────────────────────────────────────────────────
    //
    // 默认走**宿主自己的模型**：用户已经在 DSH 里配好了 provider 与 key，
    // 插件没有理由再问一遍。这也把「让用户填 baseURL/apiKeyEnv」那条路彻底拆掉——
    // 那条路一旦被滥用就是「把宿主进程里任意环境变量当 Bearer 发出去」。
    //
    // 仍然保留两条老路，各有明确理由：
    // - `node: "fake"` → 占位图（不联网）。单测与首次跑通流程靠它，不需要任何模型；
    // - 已经配了节点并且可用 → 照旧用节点（老用户升级后不出图断供）。
    // 顺序：显式 fake > 宿主模型 > 已配节点 > 报错。
    const explicit = typeof input.node === "string" && input.node
      ? settings.nodes.find((n) => n.id === input.node) ?? null
      : null;
    const hostModel = explicit && explicit.id !== "fake" && explicit.fake !== true
      ? null
      : (imageModelOf(settings) ?? findImageModel(llm?.listProviders?.() ?? []));
    const usableNodes = settings.nodes.filter((node) => describeNode(node).usable);
    const wantFake = explicit?.fake === true;

    const tried = [];
    let image = null;
    let node = null;

    /**
     * 「这次跳过了哪些节点」——和 `tried` 是两件事，别混：
     *
     * - `tried`：真去试了、失败了（网络 / 额度 / 模型报错）；
     * - `skipped`：**配置层面就不可用**（没配环境变量、key 缺失），根本没试。
     *
     * 账本里少了这一项，用户看到图是 `fake` 出的、却不知道为什么没用自己的节点，
     * 只能去翻设置。所以换节点这件事要留下证据。
     */
    const skipped = [];
    if (!explicit) {
      const defaultNode = settings.nodes.find((n) => n.id === settings.defaultNode) ?? settings.nodes[0] ?? null;
      if (defaultNode && defaultNode.fake !== true && !describeNode(defaultNode).usable) {
        skipped.push({ id: defaultNode.id, name: defaultNode.name, reason: describeNode(defaultNode).reason });
      }
    }

    // 显式点名了一个真节点却不可用：**直接说清楚，不偷偷换人**。
    // 「尊重人的选择」这条比「尽量出图」重要——换了节点出的图，用户会以为是那个节点出的。
    if (explicit && explicit.fake !== true && !describeNode(explicit).usable) {
      throw Object.assign(new Error(`节点「${explicit.name}」不可用：${describeNode(explicit).reason}`), { status: 400 });
    }

    if (wantFake) {
      image = await generateImage(explicit, { slot, prompt: finalPrompt, negative, vid, size });
      node = explicit;
    }

    if (!image && hostModel) {
      try {
        const produced = await generateWithHost(llm, {
          provider: hostModel.provider,
          model: hostModel.model,
          prompt: imagePromptOf(finalPrompt, size),
        });
        const probe = probeSize(produced.bytes);
        image = {
          bytes: produced.bytes,
          ext: produced.ext,
          mime: produced.mime,
          width: probe?.width ?? 0,
          height: probe?.height ?? 0,
          model: `${hostModel.provider}/${hostModel.model}`,
          note: "",
        };
        node = { id: "host", name: hostModel.label };
      } catch (error) {
        tried.push({ id: "host", name: hostModel.label, error: String(error?.message ?? error).slice(0, 300) });
        logger.warn?.(`gzh-studio: 宿主模型 ${hostModel.label} 出图失败：${error?.message ?? error}`);
      }
    }

    if (!image && usableNodes.length) {
      // 老路：节点逐个试，一个额度不够自动切下一个
      for (const candidate of usableNodes) {
        try {
          image = await generateImage(candidate, { slot, prompt: finalPrompt, negative, vid, size });
          node = candidate;
          break;
        } catch (error) {
          tried.push({ id: candidate.id, name: candidate.name, error: String(error?.message ?? error).slice(0, 160) });
          logger.warn?.(`gzh-studio: 节点 ${candidate.id} 出图失败：${error?.message ?? error}`);
        }
      }
    }

    if (!image) {
      const detail = tried.map((t) => `${t.name}：${t.error}`).join("；");
      throw Object.assign(new Error(tried.length
        ? `没出成图 —— ${detail}`
        : "这台机器上还没有能出图的模型：在 DSH 的模型设置里加一个出图模型（id 里带 image，例如 gpt-image-2），或者在对话里让我用占位图先跑通流程"), { status: 400 });
    }

    // prompt / negative 的槽位回写由 store.saveImage 负责（那里才是唯一写文章的地方）
    const { version, article: saved } = await store.saveImage(id, slot, {
      ...image,
      prompt,
      negative,
      node: node.id,
      model: image.model,
      note: image.note,
    });

    await store.appendLedger(id, {
      type: "generate",
      slot,
      vid: version.vid,
      prompt,
      negative,
      // 赛道风格前缀单独记：`prompt` 保持干净原文（与反馈拼接同一个口径），
      // 但「这版为什么长这样」要查得到风格是从哪条赛道来的。
      trackStyle: stylePrefix || undefined,
      node: node.id,
      nodeName: node.name,
      model: version.model,
      size: `${version.width}x${version.height}`,
      bytes: version.bytes,
      note: version.note,
      // 这一版把哪几条反馈带进去了。**必须记**：不记的话「上次说的改了没」永远说不清，
      // 面板也没法把已消费的反馈从「待用」里摘掉（消费凭据就是这一行）。
      // 槽位的 prompt 存的是**干净原文**（不带拼接），拼接只发生在发给模型的那一刻。
      feedback: carry.length ? carry.map((row) => row.key) : undefined,
      feedbackWords: carry.length ? carry.map((row) => row.verbatim) : undefined,
      // 只有真的试失败过才记，一次干净的普通出图不该多一行噪音
      tried: tried.length ? tried : undefined,
      // 配置层面就不可用、因此没去试的节点（与 `tried` 分开记，见上面的注释）
      skipped: skipped.length ? skipped : undefined,
    });
    logger.info?.(`gzh-studio: ${id} ${slot} → ${version.vid} (${node.id})${carry.length ? ` 带 ${carry.length} 条反馈` : ""}`);
    return { version, article: saved, qa: await qaOf(saved), carried: carry };
  }

  /** 保存（改稿）。返回改动字段列表，面板据此提示「写了哪几处」。 */
  async function save(input = {}) {
    const id = checkId(input.id);
    if (!id) throw Object.assign(new Error("id 不合法"), { status: 400 });
    const article = await store.readArticle(id);
    if (!article) throw Object.assign(new Error("文章不存在"), { status: 404 });
    /**
     * 换内容类型同样要校验：写进去一个不存在的 id，这篇稿在首页分类里就消失了
     * （chip 是按赛道包生成的）。空串是「改回通用」，合法，不用查。
     */
    const wantedTrack = typeof input.patch?.track === "string" ? input.patch.track.trim() : "";
    if (wantedTrack) {
      const list = await tracksAll();
      if (!list.some((track) => track.id === wantedTrack)) {
        throw Object.assign(
          new Error(`未知内容类型「${wantedTrack}」。可用的 id：${list.map((t) => t.id).join("、")}`),
          { status: 400 },
        );
      }
    }
    const { article: next, changed } = applyPatch(article, input.patch);
    const saved = await store.writeArticle(next);
    if (changed.length) {
      // 绑定/解绑要记下**绑的是哪一期**：只记一个 `pipeline:bound` 的话，
      // 以后回看账本不知道当时绑的对不对，等于没记。
      const binding = changed.find((f) => f === "pipeline:bound" || f === "pipeline:unbound");
      const extra = binding && binding === "pipeline:bound"
        ? { episodeId: saved.pipeline?.episodeId ?? "", root: saved.pipeline?.root ?? "" }
        : {};
      await store.appendLedger(id, { type: "save", fields: changed, ...extra });
    }
    return { article: saved, changed, qa: await qaOf(saved) };
  }

  /** Agent 起草入口：整篇脚本一次写入（标题 + 段落 + 摘要）。 */
  /**
   * 写入标题/段落/摘要。
   *
   * `sections` **不是必填**：只改摘要、只换标题的提案确认时也得能写进去。
   * 之前这里硬要求 sections，结果是「改摘要」的提案点确认永远 400 `sections 必填`——
   * 提案能提、能看对照，就是确认不了。段落没给就不动段落，其余照写。
   */
  async function writeScript(input = {}) {
    const id = checkId(input.id);
    if (!id) throw Object.assign(new Error("id 不合法"), { status: 400 });
    const article = await store.readArticle(id);
    if (!article) throw Object.assign(new Error("文章不存在"), { status: 404 });
    const sections = Array.isArray(input.sections) ? input.sections : null;
    const hasScalar = typeof input.title === "string" || typeof input.subtitle === "string" || typeof input.summary === "string";
    if (!sections && !hasScalar) {
      throw Object.assign(new Error("sections / title / subtitle / summary 至少要给一个"), { status: 400 });
    }
    // 没给段落就沿用现有段落：字段级写入不该把整篇段落清空
    if (!sections) {
      if (typeof input.title === "string") article.title = input.title.slice(0, MAX_LEN.title);
      if (typeof input.subtitle === "string") article.subtitle = input.subtitle.slice(0, MAX_LEN.subtitle);
      if (typeof input.summary === "string") article.summary = input.summary.slice(0, MAX_LEN.summary);
      const saved = await store.writeArticle(article);
      await store.appendLedger(id, {
        type: "script",
        sections: (saved.sections ?? []).length,
        note: String(input.note ?? "").slice(0, 200) || "只改元信息（标题/副标题/摘要）",
      });
      return { article: saved, qa: await qaOf(saved) };
    }

    const kept = new Map((article.sections ?? []).map((s) => [s.id, s]));
    const next = [];
    // 新增段落的 id 仍按位置起算（整表重写时 s1..sN 不动），但**撞号就往后让**：
    // 删过段之后位置与现有 id 会错开（留下 s1、s3 时第 2 个新增会被推成 s3），
    // 撞了以后两段共用同一个 id 与同一个配图槽位，后面每一步都会作用在错的那段。
    const used = new Set();
    const freeId = (start) => {
      let n = Math.max(1, Number(start) || 1);
      while (used.has(`s${n}`) && n < 9999) n += 1;
      return `s${n}`;
    };
    sections.slice(0, 24).forEach((incoming, index) => {
      const idMatch = typeof incoming?.id === "string" && /^s[0-9]{1,4}$/.test(incoming.id) ? incoming.id : null;
      const existing = idMatch ? kept.get(idMatch) : null;
      const section = existing ?? makeSection({ id: freeId(index + 1) });
      used.add(section.id);
      section.heading = String(incoming?.heading ?? "").slice(0, 200);
      section.body = String(incoming?.body ?? "").slice(0, 20_000);
      next.push(section);
    });
    if (typeof input.title === "string") article.title = input.title.slice(0, MAX_LEN.title);
    if (typeof input.summary === "string") article.summary = input.summary.slice(0, MAX_LEN.summary);
    if (typeof input.subtitle === "string") article.subtitle = input.subtitle.slice(0, MAX_LEN.subtitle);
    article.sections = next;
    const saved = await store.writeArticle(article);
    await store.appendLedger(id, { type: "script", sections: next.length, note: String(input.note ?? "") });
    return { article: saved, qa: await qaOf(saved) };
  }

  /**
   * 改稿提案：**只落提案，不动正文**。
   *
   * 这是 Agent 改稿的正确入口。直接 `/save`、`/script` 会当场覆盖 `article.json`，
   * 写坏了只能翻账本手抄；走这里则是「先看对照，人确认再写」。
   * @param {{id?: string, note?: string, title?: string, subtitle?: string, summary?: string, sections?: object[]}} input
   */
  async function propose(input = {}) {
    const id = checkId(input.id);
    if (!id) throw Object.assign(new Error("id 不合法"), { status: 400 });
    const article = await store.readArticle(id);
    if (!article) throw Object.assign(new Error("文章不存在"), { status: 404 });

    const proposal = buildProposal(article, input);

    // 反馈回流（改稿这一侧）：这个槽位还没被带进任何一版的反馈，附在提案摘要上。
    // **不自动改进正文**——那等于机器替人改稿。只把「上次你说过什么」摆到人眼前，
    // 让他确认这次要不要一起处理。提案事件里记下引用，已消费的反馈就不会一直跟着。
    const carried = input.feedback === false
      ? []
      : pickFeedback(await store.readLedger(id, 400), {
        slot: String(input.feedbackSlot ?? ""),
        keys: Array.isArray(input.feedbackKeys) ? input.feedbackKeys : undefined,
      });
    if (carried.length) {
      proposal.feedback = carried.map((row) => ({ key: row.key, slot: row.slot, verbatim: row.verbatim }));
    }

    await store.writeProposal(id, proposal);
    await store.appendLedger(id, proposalEvent(proposal, "proposed", {
      // 带上哪几条反馈：这就是「已消费」的凭据（见 lib/feedback.js 的推法）
      feedback: carried.length ? carried.map((row) => row.key) : undefined,
    }));
    logger.info?.(`gzh-studio: ${id} 收到提案 ${proposal.pid}（${summarizeChanges(proposal.changes)}）`);
    return {
      proposal: { pid: proposal.pid, status: proposal.status, summary: summarizeChanges(proposal.changes), feedback: carried.length },
      article,
      qa: await qaOf(article),
      proposals: await proposalsSummary(id, article),
      carried,
    };
  }

  /** 单份提案全文（含逐段对照）。面板点开提案卡时才拉。 */
  async function proposalView(id, pid) {
    const safeId = checkId(id);
    const safePid = checkPid(pid);
    if (!safeId || !safePid) throw Object.assign(new Error("参数不合法"), { status: 400 });
    const proposal = await store.readProposal(safeId, safePid);
    if (!proposal) throw Object.assign(new Error("提案不存在"), { status: 404 });
    const article = await store.readArticle(safeId);
    return {
      proposal: {
        ...proposal,
        // 只下发「变化 + 一行上下文」：整篇对照可能有几十 KB，面板一屏放不下也没必要。
        // 收起哪几行由宿主算好（浏览器半不算数，两边各算一次必然漂）。
        changes: (proposal.changes ?? []).map((item) => {
          const { diff, ...rest } = item;
          return { ...rest, rows: focusRows(diff?.rows, 1), truncated: Boolean(diff?.truncated) };
        }),
      },
      // 能不能裁决、为什么不能——面板据此禁用按钮并把理由显示出来
      blocked: guardDecision(proposal, article),
      article: article ? { id: article.id, title: article.title, updatedAt: article.updatedAt } : null,
    };
  }

  /**
   * 裁决提案。确认时**复用 `writeScript`**——同一个写入路径，不另开一套账。
   * @param {{id?: string, pid?: string, confirmed?: boolean, quote?: string}} input
   */
  async function decide(input = {}) {
    const id = checkId(input.id);
    const pid = checkPid(input.pid);
    if (!id || !pid) throw Object.assign(new Error("id 或 pid 不合法"), { status: 400 });

    const article = await store.readArticle(id);
    const proposal = await store.readProposal(id, pid);
    // 对象没了是 404，内容漂移才是 409。以前两种都包成 409，客户端没法区分
    // 「提案过期了，重看一遍」和「这篇/这份提案根本不存在」。
    if (!article) throw Object.assign(new Error("文章不存在"), { status: 404 });
    if (!proposal) throw Object.assign(new Error("提案不存在"), { status: 404 });
    // 三态：只有显式 false 才是驳回。以前写成 `!== true`，漏传字段 / 传 "true" 字符串
    // 都会走驳回分支——驳回是终态，一次字段写错就永久毁掉一份提案。
    if (typeof input.confirmed !== "boolean") {
      throw Object.assign(new Error("confirmed 必须是 true 或 false"), { status: 400 });
    }
    const blocked = guardDecision(proposal, article);
    if (blocked) throw Object.assign(new Error(blocked), { status: 409 });

    if (input.confirmed === false) {
      const decided = { ...proposal, status: PROPOSAL_STATUS.rejected, decidedAt: Date.now(), decidedBy: "user" };
      await store.writeProposal(id, decided);
      await store.appendLedger(id, proposalEvent(decided, "rejected", {
        quote: String(input.quote ?? "").slice(0, 300),
      }));
      return { proposal: { pid, status: decided.status }, article, qa: await qaOf(article), proposals: await proposalsSummary(id, article) };
    }

    // 正文与提案状态是两个文件，写不出事务。顺序选「先正文、后提案」，
    // 第二步失败就把正文写回裁决前那份并记一条失败事件：
    // 宁可提案仍是「待确认」（用户再点一次即可），也不能留下「正文已改、提案还说没裁」的错位状态。
    const written = await writeScript({ id, ...proposal.next, note: `确认提案 ${pid}` });
    const decided = { ...proposal, status: PROPOSAL_STATUS.confirmed, decidedAt: Date.now(), decidedBy: "user" };
    try {
      await store.writeProposal(id, decided);
    } catch (error) {
      await store.writeArticle(article).catch(() => {});
      await store.appendLedger(id, {
        type: "decide-failed", pid, note: `确认提案 ${pid} 时写提案状态失败，正文已回滚`,
      }).catch(() => {});
      throw Object.assign(new Error(`确认没落盘：${error?.message ?? error}；正文已回滚，提案仍是待确认`), { status: 500 });
    }
    await store.appendLedger(id, proposalEvent(decided, "confirmed", {
      // 只记目标，不记全文——账本是索引，正文和对照在别处
      changed: (proposal.changes ?? []).map((item) => item.target),
    }));
    return {
      proposal: { pid, status: decided.status },
      article: written.article,
      qa: written.qa,
      proposals: await proposalsSummary(id, written.article),
    };
  }

  /**
   * brief 文本：一段可以**直接贴进对话**的约束说明。
   *
   * 为什么要有这条路由：`audience / takeaway / forbidden` 存在 article.json 里，
   * 但 Agent 在对话里起草时看不到它（它读不到插件内存，也很难自己找到那个目录）。
   * 有了这份文本，「讲给谁、想让人带走什么、什么词不能写」才真正参与起草，
   * 而不是填完就躺在文件里。
   */
  async function briefText(id) {
    const article = await store.readArticle(checkId(id) ?? "");
    if (!article) throw Object.assign(new Error("文章不存在"), { status: 404 });
    const sections = Array.isArray(article.sections) ? article.sections : [];
    const template = TEMPLATES.find((t) => t.id === article.template);
    const images = store.countImages(article);
    /**
     * 内容类型（赛道）：brief 里必须写清楚，并给出可选 id。
     *
     * 归类**不会自动发生**（2026-11-09 与作者确认的口径：手动选，不猜）。
     * 但 Agent 起草时读的就是这份 brief——不在这里给它 id，它就没有地方知道
     * `track` 该填什么，最后所有稿子都会掉进「通用」。所以这里把当前值、
     * 可选清单、以及「判断不了就留空」一起给它。
     */
    const trackList = await tracksAll();
    const trackId = String(article.track ?? "");
    const trackName = trackId ? (trackList.find((t) => t.id === trackId)?.name ?? trackId) : "";

    const head = [
      `【公众号 brief】${article.id}`,
      `标题：${article.title || "（还没定）"}`,
      article.subtitle ? `副标题：${article.subtitle}` : "",
      article.summary ? `摘要：${article.summary}` : "",
      `讲给谁：${article.audience || "（没填——起草前先问清楚）"}`,
      `想让人带走：${article.takeaway || "（没填）"}`,
      `禁忌（正文里不能出现）：${article.forbidden || "（无）"}`,
      `内容类型：${trackName ? `${trackName}（${trackId}）` : "通用（还没归类）"}`,
      `排版模板：${template ? `${template.name}（${template.id}）` : article.template}`,
      `现状：${sections.length} 段，已出图 ${images} 张`,
    ].filter(Boolean);

    const outline = ["分段现状："];
    sections.forEach((section, index) => {
      const words = String(section.body ?? "").replace(/\s+/g, "").length;
      const image = section.image?.current ? `图 ${section.image.current}` : "缺图";
      outline.push(`  ${index + 1}. ${section.heading || "（无小标题）"} · ${words} 字 · ${image}`);
    });

    const rules = [
      "改稿规矩：",
      "1. 改稿走 POST /api/gzh-studio.propose 提提案，**不要直接 /save 或 /script**——那两个会当场覆盖正文；",
      "2. 提案只给逐段对照，人确认后才写入；提案过期（正文中间被改过）会被拒绝，需要重新提；",
      "3. 禁忌词命中会被 QA 报 error；要写就先去改「禁忌」那一栏，不要绕开检查。",
      trackId
        ? `4. 这篇已归类为「${trackName}」，换类型才要动 track；不确定就先问，不要自己改。`
        : `4. 这篇还没归类。如果你从标题/正文能明确判断它属于哪一类，就在 /save 的 patch.track 里带上对应 id；**判断不了就留空（通用），不要瞎猜**——猜错比不归类更难收拾。`,
      trackList.length
        ? `可选内容类型（id=名称）：${trackList.map((t) => `${t.id}=${t.name}`).join("、")}`
        : "",
    ].filter(Boolean);

    return [head.join("\n"), outline.join("\n"), rules.join("\n")].join("\n\n");
  }

  /**
   * 导出。
   * @param {string} id
   * @param {"html"|"md"|"checklist"} format
   */
  async function exportArticle(id, format = "html") {
    const article = await store.readArticle(checkId(id) ?? "");
    if (!article) throw Object.assign(new Error("文章不存在"), { status: 404 });
    const articleDir = store.dirOf(article.id).replace(/\\/g, "/");
    let body;
    let contentType;
    if (format === "md") {
      body = renderMarkdown(article);
      contentType = "text/markdown; charset=utf-8";
    } else if (format === "checklist") {
      body = renderChecklistText(article, { articleDir });
      contentType = "text/plain; charset=utf-8";
    } else {
      body = renderWechatBody(article).html;
      contentType = "text/html; charset=utf-8";
    }
    await store.appendLedger(article.id, { type: "export", format, bytes: Buffer.byteLength(body) });
    return { body, contentType, filename: `${article.id}.${format === "md" ? "md" : format === "checklist" ? "txt" : "html"}` };
  }

  /** 只读重算：给面板「刷新状态」和 Agent 自己查进度用。 */
  async function pipelineOf(id) {    const article = await store.readArticle(checkId(id) ?? "");
    if (!article) throw Object.assign(new Error("文章不存在"), { status: 404 });
    return pipelineView(article);
  }

  // ── 真源仓库（只读）──────────────────────────────────────────────────────
  //
  // 这五条与上面那些**不是同一份数据**：上面读写的是工作台自己的库
  // （`~/.dsh/gzh-studio/articles`，可写），这里读的是内容生产的事实源
  // （`<真源仓库>`，只读）。
  // 两边将来要在面板上合并成一条，但合并是 UI 的事，宿主不替它合——
  // 合在宿主里，就再也分不清哪条是「库里的稿」、哪条是「盘上的稿」。

  /** 稿件列表（只 stat / readdir，不读正文）。 */
  async function repoScan() {
    return repo.scanArticles();
  }

  /** 单篇全文 + 分节 + 排版稿（`dir` 走包含校验，越界一律 400）。 */
  async function repoArticle(dir) {
    return repo.readArticle(dir);
  }

  /** 视频号各期的进度与件。`defaultDir` = 「创建默认目录」会建到哪儿（面板要照实写出来）。 */
  async function videoScan() {
    return { ...(await video.scanEpisodes()), defaultDir: defaultEpisodesDir() };
  }

  /**
   * 「创建默认目录」的落点：**插件自己的数据目录**，不是用户的内容仓库。
   *
   * 原来这里建的是 `<内容仓库>/07-video/episode`——`07-video` 是我这套仓库的编号习惯，
   * 用户的内容仓库凭什么要有这一层？有人根本不写文章、只做视频；有人仓库结构完全不同。
   * 所以默认目录归插件自己（和 `articles/`、`trash/` 同一个父目录），
   * 不往用户的仓库里塞东西。想要放自己仓库里的，用「选择视频目录」指过去。
   */
  function defaultEpisodesDir() {
    return join(store.root, "episodes");
  }

  /**
   * 视频期目录的两种“指路”动作（面板空态上的两个按钮）。
   *
   * 为什么要有：原来空态只把「改哪个环境变量 / 改哪个 settings 字段」写在屏幕上，
   * 用户看了不知道该动哪里——那是实现语言，不是操作。这里把两条路做成动作：
   *
   * - `path`：用户已经有素材，把**放各期的那一层目录**指过来（绝对路径，或相对仓库根的相对路径）；
   * - `create`：用户还没有素材，就在**插件自己的数据目录**里建一个（`<数据目录>/episodes`）。
   *
   * 两个动作都**先校验再落盘**：指错了当场说清（不存在 / 不是目录 / 没权限），
   * 不把无效路径存进去——存了之后每次打开都是空态，用户只会以为插件坏了。
   * @param {{action?: string, path?: string}} input
   */
  async function setupVideo(input = {}) {
    const action = String(input.action ?? "").trim();
    const settings = await store.readSettings();

    if (action === "create") {
      const target = defaultEpisodesDir();
      try {
        await mkdir(target, { recursive: true });
      } catch (error) {
        throw Object.assign(
          new Error(`建不出来这个目录：${target}（${error?.code ?? error?.message ?? "原因不明"}）`),
          { status: 400 },
        );
      }
      // 建成之后**显式记住这个绝对路径**：不记住的话，配了内容仓库的用户会被
      // 「仓库/07-video/episode」这个兜底抢回去，白建一次。
      settings.episodesRoot = target;
      process.env[repo.EPISODES_ENV] = target;
      await store.writeSettings(settings);
      return { ok: true, root: target, defaultDir: target, ...(await video.scanEpisodes()) };
    }

    if (action === "path") {
      const raw = String(input.path ?? "").trim().slice(0, 400);
      if (!raw) throw Object.assign(new Error("请填写目录路径"), { status: 400 });
      if (raw.split(/[\\/]+/).includes("..")) {
        throw Object.assign(new Error("路径里不能有 ..（不允许指到外面去）"), { status: 400 });
      }
      // 相对路径按内容仓库根解析（那种写法本来就意味着「我有个仓库」）；
      // 绝对路径独立使用，不需要仓库——有人只用视频这条线。
      const rawRoot = repo.repoRoot();
      let resolved;
      if (isAbsolute(raw)) {
        resolved = resolve(raw);
      } else if (rawRoot) {
        resolved = resolve(rawRoot, raw);
      } else {
        throw Object.assign(
          new Error("没配内容仓库时只能填完整路径（例如 D:\\我的视频\\期目录）"),
          { status: 400 },
        );
      }
      let found = null;
      try {
        found = await stat(resolved);
      } catch {
        found = null;
      }
      if (!found) {
        throw Object.assign(new Error(`这个路径不存在：${resolved}`), { status: 400 });
      }
      if (!found.isDirectory()) {
        throw Object.assign(new Error(`这个路径不是文件夹：${resolved}`), { status: 400 });
      }
      settings.episodesRoot = isAbsolute(raw) ? resolved : raw;
      process.env[repo.EPISODES_ENV] = settings.episodesRoot;
      await store.writeSettings(settings);
      return { ok: true, root: repo.episodesRoot(), defaultDir: defaultEpisodesDir(), ...(await video.scanEpisodes()) };
    }

    throw Object.assign(new Error(`不认识的视频目录动作：${action || "（空）"}`), { status: 400 });
  }

  /** 单期：口播稿 / 分镜 / 分段 / 字幕（缺件不抛错）。 */
  async function videoEpisode(id) {
    return video.readEpisode(id);
  }

  /** 质量门状态（真跑 `gate status`，同一目录 5 分钟内复用结果）。 */
  async function gateOf(dir) {
    return repo.gateStatus(dir);
  }

  return {
    get config() { return config; },
    get store() { return store; },
    root: store.root,
    status() {
      return { ok: true, root: store.root, routes: ROUTES, pluginDir: PLUGIN_DIR };
    },
    state,
    articleView,
    pipelineOf,
    repoScan,
    repoArticle,
    videoScan,
    setupVideo,
    videoEpisode,
    gateOf,
    generate,
    save,
    writeScript,
    exportArticle,
    nodesView,
    briefText,
    propose,
    proposalView,
    decide,
    async pick(input = {}) {
      const id = checkId(input.id);
      const slot = checkSlot(input.slot);
      const vid = checkVid(input.vid);
      if (!id || !slot || !vid) throw Object.assign(new Error("参数不合法"), { status: 400 });
      const before = await store.readArticle(id);
      const previous = before ? store.slotOf(before, slot)?.current ?? "" : "";
      const article = await store.pickVersion(id, slot, vid);
      await store.appendLedger(id, { type: "pick", slot, vid, from: previous });
      return { article, qa: await qaOf(article) };
    },
    /**
     * 记一句反馈。
     *
     * 与旧版的差别：以前只记 `{slot, vid, verbatim}` 就完了，下一版出图不会带上它——
     * 用户写完等于把话扔进了井里。现在仍然只往账本追加（不新增事实源），
     * 但**出图/提案会自动带上同槽位未消费的那几条**（见 `generate` 与 `propose 的 feedback`）。
     *
     * @param {{id: string, slot?: string, vid?: string, verbatim: string}} input
     */
    async feedback(input = {}) {
      const id = checkId(input.id);
      if (!id) throw Object.assign(new Error("id 不合法"), { status: 400 });
      const verbatim = cleanVerbatim(input.verbatim);
      if (!verbatim) throw Object.assign(new Error("写一句反馈原话"), { status: 400 });
      const slot = checkSlot(input.slot) ?? "";
      const vid = checkVid(input.vid) ?? "";
      const event = await store.appendLedger(id, { type: "feedback", slot, vid, verbatim });
      const ledger = await store.readLedger(id);
      return {
        ok: true,
        event,
        ledger,
        feedback: feedbackGroups(ledger),
      };
    },

    /**
     * 05/06 两份清单：勾 / 取消勾一项。
     *
     * 面板上能逐项确认，是为了让「我核过了」这件事留下痕迹——
     * 原来这道门只判盘上有没有文件，文件在但清单是空的，门照样绿。
     *
     * **但勾选不能替代盘上清单**：这里只写插件自己的 `reviews.json`，
     * 一个字节都不往真实仓里写。两者对账的结果由 `reconcile` 说清楚。
     *
     * @param {{id?: string, kind?: string, item?: string, checked?: boolean}} input
     */
    async review(input = {}) {
      const id = checkId(input.id);
      if (!id) throw Object.assign(new Error("id 不合法"), { status: 400 });
      const kind = String(input.kind ?? "").trim();
      const item = String(input.item ?? "").trim();
      if (!CHECK_KIND.test(kind)) {
        throw Object.assign(new Error(`清单只认 ${CHECKLIST_ORDER.join(" / ")}，收到「${kind}」`), { status: 400 });
      }
      if (!CHECK_ITEM.test(item) || item[0] !== (kind === "editor" ? "e" : "r")) {
        throw Object.assign(new Error(`条目 id 不合法：${kind} 清单只认 e1…e8 / r1…r8`), { status: 400 });
      }
      if (typeof input.checked !== "boolean") {
        throw Object.assign(new Error("checked 必须是 true 或 false"), { status: 400 });
      }

      const article = await store.readArticle(id);
      if (!article) throw Object.assign(new Error("文章不存在"), { status: 404 });

      const before = await store.readReviews(id);
      const after = toggleItem(before, kind, item, input.checked);
      const saved = await store.writeReviews(id, after);

      const status = reviewStatus(saved);
      // 勾选进账本：这是人对稿子做的判断，属于内容工作，得留痕（不像绑定期号那种配置杂事）。
      await store.appendLedger(id, {
        type: "review",
        kind,
        item,
        checked: input.checked,
        done: status.done,
        total: status.total,
      });

      // 勾完立刻重算流水线：门变了，状态词也该变，不能等人再点一次「刷新」
      const fresh = await pipelineView(article);
      return { ok: true, reviews: status, pipeline: fresh };
    },

    /** 去 AI 味诊断（只读，不改正文）。 */
    async deai(input = {}) {
      const id = checkId(input.id);
      if (!id) throw Object.assign(new Error("id 不合法"), { status: 400 });
      const article = await store.readArticle(id);
      if (!article) throw Object.assign(new Error("文章不存在"), { status: 404 });
      return { ok: true, deai: diagnoseDeai(article) };
    },

    /**
     * 采纳几句去 AI 味的建议 —— **产出的是提案，不是直接改稿**。
     *
     * 为什么不让面板直接把新正文 POST 给 `/save`：那条路一按就落盘，写坏了只能翻账本抄。
     * 采纳本质上就是改词句（07 的性质 = `polish`），必须走同一条「先看对照再确认」的路。
     * 面板只把「勾了哪几句」发上来，**新旧正文的拼接在宿主侧做**——
     * 浏览器半算一遍、宿主再算一遍，两份结果早晚会漂。
     *
     * @param {{id?: string, accepted?: {slot: string, start: number, end: number, after: string}[]}} input
     */
    async adoptDeai(input = {}) {
      const id = checkId(input.id);
      if (!id) throw Object.assign(new Error("id 不合法"), { status: 400 });
      const article = await store.readArticle(id);
      if (!article) throw Object.assign(new Error("文章不存在"), { status: 404 });

      const rows = Array.isArray(input.accepted) ? input.accepted : [];
      if (!rows.length) throw Object.assign(new Error("没有勾选任何一句"), { status: 400 });

      // 按槽位分组，每段只拼接自己那几句（偏移是段内偏移，跨段混用会错位）
      const bySlot = new Map();
      for (const row of rows) {
        const slot = checkSlot(row?.slot);
        if (!slot) continue;
        if (!bySlot.has(slot)) bySlot.set(slot, []);
        bySlot.get(slot).push(row);
      }
      if (!bySlot.size) throw Object.assign(new Error("勾选的句子没有合法槽位"), { status: 400 });

      let changed = 0;
      const sections = (article.sections ?? []).map((section) => {
        const slot = section?.id ? `sec-${section.id}` : "";
        const list = bySlot.get(slot);
        if (!list?.length) return section;
        const before = String(section.body ?? "");
        const after = applySentences(before, list);
        if (after === before) return section;
        changed += 1;
        return { ...section, body: after };
      });
      if (!changed) throw Object.assign(new Error("勾选的句子改完与原文一致，没有可确认的改动"), { status: 400 });

      const proposal = buildProposal(article, {
        sections,
        note: `采纳 ${rows.length} 句去 AI 味建议`,
        kind: "polish",
      });
      await store.writeProposal(id, proposal);
      await store.appendLedger(id, proposalEvent(proposal, "proposed", { deai: rows.length }));
      return {
        ok: true,
        proposal: { pid: proposal.pid, status: proposal.status, summary: summarizeChanges(proposal.changes) },
        proposals: await proposalsSummary(id, article),
      };
    },
    /** 节点配置：新增 / 更新 / 切默认。key 永远只存环境变量名。 */
    async upsertNode(input = {}) {
      const settings = await store.readSettings();
      const node = input.node && typeof input.node === "object" ? input.node : null;
      if (node) {
        const clean = {
          id: String(node.id ?? "").trim().replace(/[^a-z0-9-]/gi, "").slice(0, 32) || `node-${settings.nodes.length + 1}`,
          name: String(node.name ?? "").slice(0, 60) || "未命名节点",
          baseURL: String(node.baseURL ?? "").slice(0, 300),
          apiKeyEnv: String(node.apiKeyEnv ?? "").slice(0, 80),
          model: String(node.model ?? "").slice(0, 80),
          size: String(node.size ?? "").slice(0, 20),
          fake: Boolean(node.fake),
        };
        // 危险写法当场拒（带凭证的内网地址、任意环境变量名）；只是没填完的允许存草稿。
        const target = checkNodeTarget(clean, { strict: true });
        if (!clean.fake && target.danger) {
          throw Object.assign(new Error(`节点配置不可用：${target.reason}`), { status: 400 });
        }
        const index = settings.nodes.findIndex((n) => n.id === clean.id);
        if (index >= 0) settings.nodes[index] = clean;
        else settings.nodes.push(clean);
      }
      if (typeof input.defaultNode === "string" && settings.nodes.some((n) => n.id === input.defaultNode)) {
        settings.defaultNode = input.defaultNode;
      }
      if (typeof input.defaultTemplate === "string" && TEMPLATE_IDS.includes(input.defaultTemplate)) {
        settings.defaultTemplate = input.defaultTemplate;
      }
      // 期目录：空串 = 回到约定值。写进来的值当场跑一遍 `episodesRoot()` 再看结果对不对，
      // 免得存下一个 `..` 爬出去的路径、或者存了个 readdir 读不到的地方却一声不吭。
      if (typeof input.episodesRoot === "string") {
        const next = input.episodesRoot.trim().slice(0, 400);
        settings.episodesRoot = next;
        // 环境变量是运行时真值（`lib/repo.js` 只认它），存盘同时写进去，不用重启。
        if (next) process.env[repo.EPISODES_ENV] = next;
        else delete process.env[repo.EPISODES_ENV];
      }
      await store.writeSettings(settings);
      return {
        settings: { ...settings, nodes: await nodesView() },
        // 面板据此显示「我正在读哪个目录」，而不是让人去猜约定值
        episodesRoot: repo.episodesRoot(),
      };
    },
    /** 新建。input.sections 可以是段数，也可以是 `[{heading, body}]`。 */
    async create(input = {}) {
      const payload = { ...input };
      /**
       * 内容类型：**写进来就要能归到对应的栏**。
       *
       * 踩过的坑（2026-11-09 实测）：track 原来只校验格式（`[a-z][a-z0-9-]{1,31}`），
       * 于是 `mother-baby` 这种拼错的 id 也能存下来——首页筛选条的 chip 是按
       * 赛道包生成的，没有这个 id 的 chip，这篇稿就**永远筛不到**：
       * 只在「全部」里看得见，分类里等于不存在。这比不归类更糟，所以当场 400。
       */
      if (payload.track) {
        const list = await tracksAll();
        const hit = list.find((track) => track.id === payload.track);
        if (!hit) {
          throw Object.assign(
            new Error(`未知内容类型「${payload.track}」。可用的 id：${list.map((t) => t.id).join("、")}`),
            { status: 400 },
          );
        }
        // 选了赛道又没指定模板：用这条赛道的默认长相（医疗偏商务、母婴偏手账、AI 偏蓝图）。
        if (!payload.template && hit.defaultTemplate) payload.template = hit.defaultTemplate;
      }
      const article = await store.createArticle(payload);
      return { article, qa: await qaOf(article) };
    },

    /**
     * 删掉一篇：**移到回收站，不硬删**。
     *
     * 为什么是移走而不是 rm：稿子里有正文、图版本、账本、勾选清单，删错一次就是
     * 几个小时的工作。移到 `~/.dsh/gzh-studio/trash/<id>-<时间>/` 之后，
     * 面板上立刻看不见（"真的删了"），但盘上还留着，想找回自己搬回去就行。
     * 这也是唯一一个不需要撤销栈就能做到"可后悔"的做法。
     */
    /** 公众号推送状态：面板用它决定按钮是「推草稿箱」还是「先配一下」。密钥只回掩码。 */
    async wechatStatus() {
      return wechatClient.status();
    },

    /**
     * 推一次草稿到公众号草稿箱。
     *
     * 三步，每步失败都要给人话：
     * 1. **本地能查的先查**（封面有没有、图是不是 SVG 占位、标题/正文超没超限），不联网就拦下来；
     * 2. 传图：封面走永久素材拿 media_id，正文图走 uploadimg 拿 URL（外链会被微信过滤）；
     * 3. 建草稿 + 落回执（media_id 进账本）。
     *
     * 边界没变：**推的是草稿箱**，发表仍然要人去公众号后台点。这条线只到草稿为止。
     * dryRun 只做第 1 步：不联网也能自查「还差什么」，第一次配的时候最有用。
     */
    async pushDraft(input = {}) {
      const id = checkId(input.id);
      if (!id) throw Object.assign(new Error("id 不合法：要推的那篇没选中，或 id 传错了"), { status: 400 });
      const article = await store.readArticle(id);
      if (!article) throw Object.assign(new Error("文章不存在"), { status: 404 });
      const dryRun = input.dryRun === true;
      const cfg = await wechatClient.config();
      if (!dryRun && !cfg.usable) {
        throw Object.assign(new Error("还没配公众号：在左边对话里让它写一下 AppID 与 AppSecret（存到 ~/.dsh/gzh-studio/wechat.json）"), { status: 400 });
      }

      const rows = imageChecklist(article);
      if (!rows.some((row) => row.slot === "cover")) {
        throw Object.assign(new Error("封面还没出图：公众号图文草稿必须有封面"), { status: 400 });
      }

      const images = [];
      for (const row of rows) {
        const found = store.imagePath(article, row.slot, row.vid);
        if (!found) throw Object.assign(new Error(`${row.label}：版本 ${row.vid} 的文件不在盘上`), { status: 400 });
        let bytes = 0;
        try { bytes = (await stat(found.path)).size; } catch { bytes = 0; }
        images.push({ slot: row.slot, vid: row.vid, label: row.label, placeholder: row.placeholder, path: found.path, mime: found.mime, bytes });
      }
      const svgCount = images.filter((image) => /svg/i.test(image.mime)).length;
      if (!dryRun && svgCount) {
        throw Object.assign(new Error(`还有 ${svgCount} 张是占位图（SVG），公众号不认：先出真图再推`), { status: 400 });
      }

      const title = String(article.title ?? "").trim();
      const digest = String(article.summary ?? "").trim().slice(0, wechat.LIMITS.digest);
      const html = renderWechatBody(article).html;

      // 先量一遍再传图：标题/摘要超限、正文明显超长，都不该先把几张图传上去再报错。
      // 用一条 100 字符的假 URL 占位——真 URL 就这个量级，占位符 12 个字符会低估。
      const FAKE_IMG_URL = "https://mmbiz.qpic.cn/mmbiz_png/0000000000000000000000000000/0?wx_fmt=png";
      const preview = wechat.replacePlaceholders(html, Object.fromEntries(images.map((image) => [image.placeholder, FAKE_IMG_URL])));
      const pre = wechat.checkDraft({ title, digest, content: preview });
      if (!pre.ok) {
        const error = Object.assign(new Error(pre.problems.map((problem) => problem.message).join("；")), { status: 400 });
        error.problems = pre.problems;
        error.stats = pre.stats;
        throw error;
      }

      if (dryRun) {
        return {
          dryRun: true, ok: true, problems: [],
          stats: { ...pre.stats, estimated: true },
          images, svgCount, limits: wechat.LIMITS, configured: cfg.usable,
        };
      }

      const replacements = {};
      let thumbMediaId = "";
      for (const image of images) {
        try {
          const buffer = await readFile(image.path);
          if (image.slot === "cover") {
            const uploaded = await wechatClient.uploadThumb(buffer, { filename: "cover.png", mime: image.mime });
            thumbMediaId = uploaded.mediaId;
            if (uploaded.url) replacements[image.placeholder] = uploaded.url;
          } else {
            replacements[image.placeholder] = await wechatClient.uploadContentImage(buffer, { filename: `${image.slot}.png`, mime: image.mime });
          }
        } catch (error) {
          // 一步失败要说清是**哪张**：一篇文章五六张图，只回「上传失败」等于没说。
          throw Object.assign(new Error(`${image.label}（${image.vid}）没传上去：${error?.message ?? error}`), {
            status: error?.status ?? 502, code: error?.code, ip: error?.ip, hint: error?.hint,
          });
        }
      }

      // 传完再量一次：真 URL 比假 URL 长，刚好卡线时这一遍才发现。
      const content = wechat.replacePlaceholders(html, replacements);
      const check = wechat.checkDraft({ title, digest, content });
      if (!check.ok) {
        const error = Object.assign(new Error(check.problems.map((problem) => problem.message).join("；")), { status: 400 });
        error.problems = check.problems;
        error.stats = check.stats;
        throw error;
      }

      const mediaId = await wechatClient.addDraft({ title, author: cfg.author, digest, content, thumbMediaId });
      // 回执才算推过：不写 lifecycle（那是人标的），只落一条 publish 事件。
      await store.appendLedger(article.id, {
        type: "publish", persisted: true, mode: "draft", mediaId,
        chars: check.stats.contentChars, images: images.length,
      });
      return { dryRun: false, ok: true, mediaId, stats: check.stats, images };
    },

    async remove(input = {}) {
      const id = checkId(input.id);
      if (!id) throw Object.assign(new Error("id 不合法"), { status: 400 });
      const from = join(store.root, "articles", id);
      const exists = await stat(from).then(() => true, () => false);
      if (!exists) throw Object.assign(new Error("文章不存在（可能已经删过）"), { status: 404 });
      const to = join(store.root, "trash", `${id}-${Date.now()}`);
      await mkdir(dirname(to), { recursive: true });
      await rename(from, to);
      return { ok: true, id, trashedTo: to };
    },
    // 公众号推送：状态 / 配置 / 推一次
  };
}

/**
 * 注册路由。标准 Cordis apply。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const config = mergeConfig(rawConfig);
  const service = createService(config, ctx.logger ?? {}, { llm: ctx.llm });
  const disposers = [];

  // 兼容老配置：`settings.json` 里的 `pipelineRoot` 就是「产线根」（真源仓库那一级）。
  // 环境变量优先；两个都没有就不写默认值——市场版绝不去读作者的业务目录。
  // 视频期根目录同理：`episodesRoot` 只是「期放哪」的覆盖值，配了才写进环境。
  // 两条一起读，避免为了一个字段把 settings.json 解析两次。
  if (!process.env[repo.REPO_ENV] || !process.env[repo.EPISODES_ENV]) {
    try {
      const stored = JSON.parse(readFileSync(join(service.root, "settings.json"), "utf8"));
      const pipelineRoot = String(stored?.pipelineRoot ?? "").trim();
      if (pipelineRoot && !process.env[repo.REPO_ENV]) process.env[repo.REPO_ENV] = pipelineRoot;
      const episodesRoot = String(stored?.episodesRoot ?? "").trim();
      if (episodesRoot && !process.env[repo.EPISODES_ENV]) process.env[repo.EPISODES_ENV] = episodesRoot;
    } catch { /* 没有设置文件是正常状态 */ }
  }

  // ── 实时同步 ────────────────────────────────────────────────────────────────
  //
  // 面板的痛点很具体：会话里 agent 改完稿、出完图，人要手动点一次「刷新」才看得见。
  // 这里把「写盘了」这件事推下去：POST 改数据成功、或盘上文件被外部改动（agent 直接
  // 写视频期目录、手改 article.json），都发一条事件；浏览器半边收到就重拉当前这篇。
  //
  // 只推「有事发生」，不推内容：正文可能几十 KB，推事件让人自己 GET 一次更省也更好排查。
  const listeners = new Set();
  const publish = (event) => {
    for (const push of listeners) {
      try { push(event); } catch { listeners.delete(push); }
    }
  };
  /** 盘上事件先攒 400ms 再发：一次保存会连着写 article.json + ledger.jsonl。 */
  let fsTimer = null;
  const publishFs = () => {
    if (fsTimer) return;
    fsTimer = setTimeout(() => {
      fsTimer = null;
      publish({ kind: "fs", at: Date.now() });
    }, 400);
    fsTimer.unref?.();
  };
  /** 起一个递归监视；目录不存在是正常状态（用户还没建库），不报错。 */
  const watchers = [];
  const addWatch = (dir) => {
    if (!dir) return;
    try {
      const watcher = watch(dir, { recursive: true }, () => publishFs());
      // FSWatcher 的 'error' 没有监听时是未捕获异常（EMFILE 用尽、网络盘 EPERM、
      // 目录被删/改名都会走到）。监视掉了顶多退回手动刷新，不该让宿主进程跟着倒。
      watcher.on("error", (error) => {
        ctx.logger?.warn?.(`gzh-studio: 监视 ${dir} 出错（${error?.code ?? error?.message ?? error}），已退回手动刷新`);
      });
      watchers.push(watcher);
    } catch { /* 目录不存在 / 平台不支持递归监视：退回手动刷新，不影响别的功能 */ }
  };

  /** 注册一条 GET 路由。 */
  const routeGet = (path, handler) => {
    disposers.push(ctx.connection.fetch.register({
      path,
      methods: ["GET"],
      requestBody: "buffered",
      fetch: async (request) => {
        try {
          return await handler(new URL(request.url).searchParams, request);
        } catch (error) {
          ctx.logger?.warn?.(`gzh-studio: ${path} failed: ${error?.message ?? error}`);
          return failure(error, error?.status ?? 500);
        }
      },
    }));
  };

  /** 注册一条 POST 路由（body 一律 JSON）。 */
  const routePost = (path, handler) => {
    disposers.push(ctx.connection.fetch.register({
      path,
      methods: ["POST"],
      requestBody: "buffered",
      fetch: async (request) => {
        try {
          const body = await request.json().catch(() => null);
          const payload = body && typeof body === "object" ? body : {};
          const response = await handler(payload, request);
          // 只有写成功才推。失败也推的话，面板会为一次 400 白刷一遍，
          // 而且「刷新了但还是老样子」比「没刷新」更像坏了。
          if (!(response && response.status >= 400)) {
            let id = String(payload.id ?? payload.pid ?? "");
            // create 的 id 是服务端生成的，不在请求体里：从响应里补一下。
            // 有了 id，面板以后能只刷「被改的那一篇」，不用整库重拉。
            if (!id && typeof response?.clone === "function" && /json/.test(response.headers?.get?.("content-type") ?? "")) {
              try {
                const data = await response.clone().json();
                id = String(data?.article?.id ?? data?.id ?? "");
              } catch { /* 响应体读不出来就不带 id，不影响刷新 */ }
            }
            publish({ kind: "write", route: path, id, at: Date.now() });
          }
          return response;
        } catch (error) {
          ctx.logger?.warn?.(`gzh-studio: ${path} failed: ${error?.message ?? error}`);
          return failure(error, error?.status ?? 500);
        }
      },
    }));
  };

  /**
   * SSE：写盘事件长连接。
   *
   * 为什么要自己推而不用轮询：面板一开着就每 3 秒打一次 `/state`，
   * 一次就要 stat 一遍所有稿件目录；文章多起来这是纯浪费。
   * 事件里只带 `kind / id / at`——正文几十 KB，让人自己 GET 一次更省也更好排查。
   * 浏览器半收不到（老宿主没这条路由 / EventSource 被禁）就安静退回手动刷新。
   */
  routeGet(ROUTES.stream, (query, request) => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        // 心跳与「连接已断」是同一件事的两半：enqueue 抛错就说明浏览器走了，
        // 这时必须把心跳也停掉——只把监听函数从集合里删掉的话，这个 interval
        // 会一直对着一个关掉的 controller 打，进程不退出、内存也不回收。
        let beat = null;
        const done = () => {
          if (beat) clearInterval(beat);
          beat = null;
          listeners.delete(push);
          try { controller.close(); } catch { /* 已经关过 */ }
        };
        const push = (event) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            done();
          }
        };
        push({ kind: "hello", at: Date.now() });
        listeners.add(push);
        beat = setInterval(() => push({ kind: "ping", at: Date.now() }), 25_000);
        beat.unref?.();
        request?.signal?.addEventListener?.("abort", done, { once: true });
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        // 有反向代理时别攒着：攒了 SSE 就变成「一次收到几百条」。
        "x-accel-buffering": "no",
      },
    });
  });

  routeGet(ROUTES.status, () => json(service.status()));
  // 带查询参数：状态筛选与搜索都在服务端做（正文检索文本不下发）
  routeGet(ROUTES.state, async (query) => json(await service.state(Object.fromEntries(query ?? []))));
  routeGet(ROUTES.article, async (query) => {
    const view = await service.articleView(query.get("id") ?? "");
    return view ? json(view) : failure(new Error("文章不存在"), 404);
  });
  routeGet(ROUTES.export, async (query) => {
    const format = String(query.get("format") ?? "html");
    const result = await service.exportArticle(query.get("id") ?? "", format === "md" || format === "checklist" ? format : "html");
    return text(result.body, result.contentType);
  });
  routeGet(ROUTES.image, async (query, request) => {
    const id = checkId(query.get("id"));
    const slot = checkSlot(query.get("slot"));
    const vid = checkVid(query.get("v"));
    if (!id || !slot || !vid) return failure(new Error("参数不合法"), 400);
    const article = await service.store.readArticle(id);
    if (!article) return failure(new Error("文章不存在"), 404);
    const found = service.store.imagePath(article, slot, vid);
    if (!found) return failure(new Error("没有这个版本"), 404);
    try {
      const buffer = await readFile(found.path);
      const etag = `"${vid}-${buffer.length}"`;
      const headers = { "content-type": found.mime, "cache-control": "no-cache", etag };
      if (request?.headers?.get?.("if-none-match") === etag) return new Response(null, { status: 304, headers });
      return new Response(buffer, { status: 200, headers });
    } catch {
      // 文件不在盘上（手删了 / 换了机器）：404 让面板画「图缺失」，不至于整块报错
      return failure(new Error("图片文件不存在"), 404);
    }
  });

  routePost(ROUTES.create, async (body) => json(await service.create(body)));
  routePost(ROUTES.save, async (body) => json(await service.save(body)));
  routePost(ROUTES.script, async (body) => json(await service.writeScript(body)));
  routePost(ROUTES.generate, async (body) => json(await service.generate(body)));
  routePost(ROUTES.pick, async (body) => json(await service.pick(body)));
  routePost(ROUTES.feedback, async (body) => json(await service.feedback(body)));
  routePost(ROUTES.node, async (body) => json(await service.upsertNode(body)));

  // ── 改稿提案 ────────────────────────────────────────────────────────────────
  routeGet(ROUTES.brief, async (query) => text(await service.briefText(query.get("id") ?? "")));
  // 只读：重算某一篇的流水线状态。绑定完、或刚在某一步做完事之后刷新用。
  routeGet(ROUTES.pipeline, async (query) => json(await service.pipelineOf(query.get("id") ?? "")));
  routeGet(ROUTES.proposal, async (query) => json(await service.proposalView(query.get("id") ?? "", query.get("pid") ?? "")));
  routePost(ROUTES.propose, async (body) => json(await service.propose(body)));
  routePost(ROUTES.decide, async (body) => json(await service.decide(body)));
  routeGet(ROUTES.deai, async (query) => json(await service.deai(Object.fromEntries(query ?? []))));
  routePost(ROUTES.adoptDeai, async (body) => json(await service.adoptDeai(body)));
  routePost(ROUTES.review, async (body) => json(await service.review(body)));

  // ── 真源仓库（只读）────────────────────────────────────────────────────────
  //
  // 全部 GET、全部只读、全部走包含校验（见 `lib/repo.js` 与 `lib/video.js`）：
  // `dir` / `id` 解析后必须落在允许的根下面，越界回 400、找不到回 404，
  // 质量门跑崩了回 502 并带一句能看懂的原因——不会把面板打成白屏。
  //
  // `gate` 这一条会真起子进程（`gate status`，20 秒超时），所以结果按
  // `dir + 稿件目录 mtime` 缓存 5 分钟：首页列表不能每篇都真跑一次。
  routeGet(ROUTES.repo, async () => json(await service.repoScan()));
  routeGet(ROUTES.repoArticle, async (query) => json(await service.repoArticle(query.get("dir") ?? "")));
  routeGet(ROUTES.video, async () => json(await service.videoScan()));
  // 视频目录空态上的两个按钮：指到已有目录（path）/ 建出约定目录（create）
  routePost(ROUTES.videoSetup, async (input) => json(await service.setupVideo(input)));
  routeGet(ROUTES.videoEpisode, async (query) => json(await service.videoEpisode(query.get("id") ?? "")));
  // 媒体文件：支持 Range（`<video>` 拖进度条靠它）。不整文件读进内存，走流。
  routeGet(ROUTES.media, async (query, request) => {
    const found = await video.mediaFile(query.get("id") ?? "", query.get("rel") ?? "");
    const headers = {
      "content-type": found.mime,
      "accept-ranges": "bytes",
      "cache-control": "no-cache",
      etag: `"${found.size}-${Math.round(found.mtime ?? 0)}"`,
    };
    if (!found.size) return new Response(null, { status: 200, headers });
    const open = (start, end) => Readable.toWeb(createReadStream(found.path, { start, end }));
    const range = String(request?.headers?.get?.("range") ?? "").trim();
    const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
    if (!match) {
      return new Response(open(0, found.size - 1), {
        status: 200,
        headers: { ...headers, "content-length": String(found.size) },
      });
    }
    let start = match[1] === "" ? null : Number(match[1]);
    let end = match[2] === "" ? null : Number(match[2]);
    if (start === null && end === null) return failure(new Error("Range 写法不认识"), 400);
    if (start === null) {
      // `bytes=-500`：最后 500 字节
      start = Math.max(0, found.size - end);
      end = found.size - 1;
    } else {
      end = end === null ? found.size - 1 : Math.min(end, found.size - 1);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= found.size) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${found.size}` } });
    }
    return new Response(open(start, end), {
      status: 206,
      headers: {
        ...headers,
        "content-range": `bytes ${start}-${end}/${found.size}`,
        "content-length": String(end - start + 1),
      },
    });
  });
  routeGet(ROUTES.gate, async (query) => json(await service.gateOf(query.get("dir") ?? "")));
  // 删一篇（移到 ~/.dsh/gzh-studio/trash/，可手动搬回）
  routePost(ROUTES.remove, async (input) => json(await service.remove(input)));
  // 公众号草稿箱：状态 + 真推一次（不发表，只进草稿箱）
  routeGet(ROUTES.wechatStatus, async () => json(await service.wechatStatus()));
  routePost(ROUTES.push, async (input) => json(await service.pushDraft(input)));


  // 监视两个「会被人 / agent 从外面写」的目录：工作台自己的文章库，和视频期目录。
  // 面板内的写有 POST 事件兜着，这两个 watch 负责看不见的那部分（agent 直接落文件）。
  // 自己的库目录先建出来：新装用户第一次打开时它还不存在，watch 起不来就永远收不到外部改动。
  try { mkdirSync(join(service.root, "articles"), { recursive: true }); } catch { /* 只读盘 / 权限不足：退回手动刷新 */ }
  addWatch(join(service.root, "articles"));
  // 视频期目录只在配了真源仓库时才监视：没配就 watch 一个相对路径，
  // 会变成「静默监视当前工作目录」，比不监视更糟。
  // 监视的是**实际在读的那个期目录**（可能是 episodesRoot 配过的位置），不是约定值：
  // 监视约定值而面板读别处，就等于「agent 新建了一期，看板不会自己刷新」。
  if (repo.repoConfigured()) addWatch(repo.episodesRoot());

  ctx.effect(
    () => async () => {
      if (fsTimer) clearTimeout(fsTimer);
      for (const watcher of watchers) {
        try { watcher.close(); } catch { /* 已关 */ }
      }
      listeners.clear();
      await Promise.allSettled(disposers.map((dispose) => dispose()));
    },
    "gzh-studio: fetch routes",
  );

  ctx.provide("gzhStudio", service);
  ctx.logger?.info?.(`gzh-studio ready (root=${service.root})`);
}

// 供 verify 直接比对的一组导出（避免测试里手抄常量）
export { TEMPLATES, TEMPLATE_IDS, runQa, renderWechatBody, renderMarkdown, imageChecklist, pickVersion, generateImage };
export { buildProposal, summarizeChanges, guardDecision, inferKind, alsoTouches, checkKind, KIND_ROUTE, KINDS } from "./lib/proposal.js";
export { lineRows, lineDiff } from "./lib/diff.js";

