/**
 * 质量检查（QA）。**纯函数**，不碰文件系统、不联网，宿主半与 verify 单测共用。
 *
 * 设计口径（照 Deckline 那条「质量检查不过会说明原因」）：
 * 每条结果都带 `fix` —— 不是「不合格」三个字，而是「怎么改」。
 *
 * 级别：
 * - `error` 发布前必须处理（标题超长会被后台截断、封面缺失就是没头图）；
 * - `warn`  会掉效果或踩合规（极限词、标题党、段落太长）；
 * - `info`  只是提醒（这段还没配图、这个数字没写出处）。
 *
 * 封面尺寸口径：公众号首图推荐 **900×383（2.35:1）**，与 `lib/generate.js` 的
 * `cover` 槽位一致。改了那边就要改这里，`verify/qa-unit.mjs` 有断言钉死这两个数。
 * @module lib/qa
 */

/** 封面推荐尺寸（与 generate.js 的 COVER_SIZE 同一组数）。 */
export const COVER = { width: 900, height: 383, ratio: 900 / 383 };

/** 标题硬上限：公众号后台标题上限 64 字，超出会被截断。 */
export const TITLE_MAX = 64;
/** 标题建议上限：手机列表页大约能显示 20~30 字。 */
export const TITLE_SUGGEST = 30;
/** 摘要上限：公众号摘要上限 120 字。 */
export const SUMMARY_MAX = 120;
/** 单段建议上限：手机屏幕一屏约 150~200 字，超过 600 字读者会划走。 */
export const SECTION_SUGGEST = 600;

/**
 * 广告法极限词 / 绝对化用语。命中即 warn —— 公众号合规审查最常见的退稿原因。
 * 只收「几乎必然是问题」的词，不做模糊匹配（`最后` 这类含 `最` 的正常词不误伤）。
 */
export const EXTREME_WORDS = [
  "最佳", "最好", "最强", "最便宜", "最高级", "最先进",
  "第一品牌", "全国第一", "全球第一", "行业第一", "第一名",
  "唯一", "独家", "顶级", "国家级", "世界级", "顶尖",
  "绝对", "100%", "百分百", "万能", "永久", "彻底解决", "根治",
  "零风险", "稳赚", "包治", "无效退款", "史无前例", "前所未有",
];

/** 标题党词。 */
export const CLICKBAIT_WORDS = ["震惊", "惊呆", "速看", "必看", "删前速看", "不转不是", "你不知道的", "99%的人"];

/** 有出处标记的写法（正文里出现这些就不算「数字无出处」）。 */
const SOURCE_MARKERS = ["据", "来源", "数据", "报告", "统计", "样本", "调研", "测算", "白皮书", "官方", "公开"];

/**
 * 把 `forbidden` 那一栏切成一个个禁忌词。
 * 用户写法很随意（逗号、顿号、分号、换行、竖线都见过），所以分隔符全收；
 * 只留长度 ≥ 2 的片段——单个字做禁忌会到处误伤。
 * @param {string} text
 * @returns {string[]}
 */
export function forbiddenWords(text) {
  return String(text ?? "")
    .split(/[,，、;；\n\r|]+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2);
}

/**
 * 禁忌词是否命中。中文直接 `includes`；纯 ASCII 词加左右边界，
 * 否则 `BI` 会命中 `BIG`、`AI` 会命中 `SAID`，报出一堆假警。
 * @param {string} haystack
 * @param {string} word
 */
function hitWord(haystack, word) {
  if (!haystack) return false;
  if (/^[\x20-\x7e]+$/.test(word)) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "i").test(haystack);
  }
  return haystack.includes(word);
}

/** 图注 / 正文里出现「疑似无出处数字」的形态。 */
const NUMBER_PATTERN = /(\d+(?:\.\d+)?)\s*(%|％|倍|万|亿|人|家|篇|条)/g;

/**
 * 一条检查结果。
 * @typedef {object} QaItem
 * @property {string} id     稳定 id（面板按它分组 / 去重）
 * @property {"error"|"warn"|"info"} level
 * @property {string} scope  `article` / `cover` / `sec-3` 这类槽位
 * @property {string} title  一句话结论
 * @property {string} detail 具体证据（数字 / 命中的词 / 原文片段）
 * @property {string} fix    怎么改
 */

/** @param {string} [s] @returns {string} */
const str = (s) => (typeof s === "string" ? s.trim() : "");
/** 去掉空白，用来比长度（微信的字数不算空白）。 */
const dense = (s) => str(s).replace(/\s+/g, "");

/**
 * 对整篇文章跑一遍检查。
 * @param {object} article - `article.json` 的内容（见 lib/store.js 的 schema）。
 * @returns {{ok: boolean, counts: {error: number, warn: number, info: number}, items: QaItem[]}}
 */
export function runQa(article) {
  /** @type {QaItem[]} */
  const items = [];
  const add = (level, scope, id, title, detail, fix) =>
    items.push({ id, level, scope, title, detail, fix });

  const title = str(article?.title);
  const titleLen = dense(title).length;
  const summary = str(article?.summary);
  const sections = Array.isArray(article?.sections) ? article.sections : [];

  // ── 标题 ──────────────────────────────────────────────────────────────────
  if (!titleLen) {
    add("error", "article", "title-missing", "还没有标题", "标题为空，公众号后台无法保存草稿。", "先定标题；拿不准就一次写 3 个备选，选信息量最大的那个。");
  } else {
    if (titleLen > TITLE_MAX) {
      add("error", "article", "title-too-long", `标题 ${titleLen} 字，超过后台 ${TITLE_MAX} 字上限`,
        `「${title.slice(0, 24)}…」`, `压到 ${TITLE_MAX} 字以内，删掉修饰语而不是删信息。`);
    } else if (titleLen > TITLE_SUGGEST) {
      add("warn", "article", "title-long", `标题 ${titleLen} 字，列表页会折行`, `建议 ≤ ${TITLE_SUGGEST} 字`,
        "把定语往后挪，或者用副标题承接；主标题只留主角和动作。");
    }
    for (const word of CLICKBAIT_WORDS) {
      if (title.includes(word)) {
        add("warn", "article", "title-clickbait", `标题里有「${word}」`, `命中标题党词：${word}`,
          "换成具体事实：谁、做了什么、结果是多少。夸张词换不来点击，只会掉信任。");
      }
    }
  }

  // ── 摘要 ──────────────────────────────────────────────────────────────────
  const summaryLen = dense(summary).length;
  if (!summaryLen) {
    add("info", "article", "summary-missing", "没有写摘要", "留空时后台会抓正文前 54 字，经常抓成半句话。",
      "写 40~80 字摘要：一句话说清这篇给谁、解决什么。");
  } else if (summaryLen > SUMMARY_MAX) {
    add("warn", "article", "summary-too-long", `摘要 ${summaryLen} 字，超过 ${SUMMARY_MAX} 字上限`, summary.slice(0, 30) + "…",
      `压到 ${SUMMARY_MAX} 字以内。`);
  }

  // ── 正文分段 ──────────────────────────────────────────────────────────────
  if (!sections.length) {
    add("error", "article", "sections-empty", "正文还是空的", "没有任何段落，导出会得到一篇空文。",
      "先在左侧把讲稿写出来（每段一个意思），再逐段配图。");
  }

  const bodies = new Map(); // 归一化正文 → 首次出现的段号，用于查重
  let noImage = 0;
  let withBody = 0; // 配图检查的分母：只算真有正文的段
  let longSections = 0;
  let extemeHits = [];
  let unsourced = [];

  sections.forEach((section, index) => {
    const label = `第 ${index + 1} 段`;
    // 槽位 id 与 client 的选中键同口径（`sec-s3`）：检查结果要能按槽位过滤，
    // 两边各写一套编号就会「检查报了 3 条，检查器一条都不显示」。
    const scope = section?.id && /^s[0-9]{1,4}$/.test(String(section.id)) ? `sec-${section.id}` : `sec-s${index + 1}`;
    const body = str(section?.body);
    const heading = str(section?.heading);
    const bodyLen = dense(body).length;

    if (!bodyLen) {
      add("error", scope, "section-empty", `${label} 没有正文`, heading ? `小标题「${heading}」下面是空的` : "这一段的正文是空的",
        "要么补上正文，要么删掉这一段——空段落到公众号里就是一个突兀的空白。");
    } else {
      withBody += 1;
      if (bodyLen > SECTION_SUGGEST) {
        longSections += 1;
        add("warn", scope, "section-long", `${label} 正文 ${bodyLen} 字，手机上要划好几屏`, `建议单段 ≤ ${SECTION_SUGGEST} 字`,
          "按「一个段落一个意思」拆开，并在拆点加小标题。");
      }
      const key = body.replace(/\s+/g, "").slice(0, 80);
      if (key.length >= 40) {
        if (bodies.has(key)) {
          add("warn", scope, "section-duplicate", `${label} 与第 ${bodies.get(key)} 段开头重复`,
            body.slice(0, 40) + "…", "删掉重复那段，或者把它改写成递进而不是重复。");
        } else {
          bodies.set(key, index + 1);
        }
      }

      // 极限词
      for (const word of EXTREME_WORDS) {
        if (body.includes(word) || heading.includes(word)) {
          extemeHits.push(`${label}·${word}`);
        }
      }

      // 疑似无出处数字
      const nums = [...body.matchAll(NUMBER_PATTERN)].map((m) => m[0]);
      if (nums.length && !SOURCE_MARKERS.some((m) => body.includes(m))) {
        unsourced.push(`${label}·${nums.slice(0, 3).join("/")}`);
      }
    }

    // 配图只对「有正文的段」提要求。空段落已经报过 section-empty，
    // 再按「这段没配图」数一遍就是重复噪音，还会把分母虚高成「1/6 段没配图」——
    // 那个第 6 段根本还不存在。
    if (!bodyLen) return;
    const image = section?.image ?? {};
    const versions = Array.isArray(image.versions) ? image.versions : [];
    if (!image.current || !versions.length) {
      noImage += 1;
    } else if (!str(image.prompt)) {
      add("info", scope, "prompt-missing", `${label} 的配图没有 prompt`, `当前版本 ${image.current}`,
        "补一句 prompt 和反向词，下次微调不用重想。");
    }
  });

  if (noImage > 0 && withBody > 0) {
    add("info", "article", "images-missing", `${noImage}/${withBody} 段还没有配图`, "没有配图也能发，但纯文字长文的完读率明显更低。",
      "至少给开篇和结尾两段配图，中间可以留白。");
  }
  if (longSections > 1) {
    add("info", "article", "sections-long-many", `${longSections} 段偏长`, "段落长度普遍超过建议值",
      "长文用小标题切节奏：每 300~400 字给读者一个停靠点。");
  }
  if (extemeHits.length) {
    add("warn", "article", "extreme-words", `命中 ${extemeHits.length} 处极限词`, extemeHits.slice(0, 6).join("、"),
      "换成可核验的说法（「提升 3 倍」比「效果最好」安全，而且更有说服力）。");
  }
  if (unsourced.length) {
    add("info", "article", "unsourced-numbers", `${unsourced.length} 处数字没写出处`, unsourced.slice(0, 5).join("、"),
      "补一句「据 X 报告」或在图注里写出处；没有出处的数字不要写。");
  }

  // ── 禁忌词：用户自己在 brief 里写死的硬约束 ────────────────────────────────
  // 只存不查等于没填。`forbidden` 收了 800 字，正文真写了却一条都不报，
  // 那这一栏就是安慰剂。级别定 error 而不是 warn：这是用户自己声明的「不能出现」，
  // 出现了就不该发，而不是「建议改一下」。
  const forbidden = forbiddenWords(article?.forbidden);
  if (forbidden.length) {
    const hits = [];
    for (const word of forbidden) {
      for (const [where, text] of [["标题", title], ["副标题", str(article?.subtitle)], ["摘要", summary]]) {
        if (hitWord(text, word)) hits.push(`${where}·${word}`);
      }
      sections.forEach((section, index) => {
        if (hitWord(str(section?.heading), word) || hitWord(str(section?.body), word)) {
          hits.push(`第 ${index + 1} 段·${word}`);
        }
      });
    }
    if (hits.length) {
      add("error", "article", "forbidden-hit", `正文命中 ${hits.length} 处禁忌词`, hits.slice(0, 8).join("、"),
        "这些词是你在「禁忌」里自己写死的：删掉或换说法。这次确实要写，就先去右侧把禁忌那一栏改掉——不要绕开检查。");
    }
  }

  // ── 封面 ──────────────────────────────────────────────────────────────────
  const cover = article?.cover ?? {};
  const coverVersions = Array.isArray(cover.versions) ? cover.versions : [];
  if (!coverVersions.length) {
    add("error", "cover", "cover-missing", "还没有封面图", "公众号首图（2.35:1）没出图，草稿发不出去。",
      "点「出图」生成封面；prompt 里写清主体 + 场景 + 色调，不要写「高级感」这种形容词。");
  } else {
    const current = coverVersions.find((v) => v.vid === cover.current) ?? coverVersions[coverVersions.length - 1];
    const w = Number(current?.width) || 0;
    const h = Number(current?.height) || 0;
    if (w && h) {
      const ratio = w / h;
      const drift = Math.abs(ratio - COVER.ratio) / COVER.ratio;
      if (drift > 0.02) {
        add("error", "cover", "cover-ratio", `封面是 ${w}×${h}（${ratio.toFixed(2)}:1），不是 2.35:1`,
          `推荐 ${COVER.width}×${COVER.height}（比例口径，尺寸可等比放大）`,
          "出图接口只认 64 的倍数，900×383 这种写法会被静默改成方图。插件已自动吸附到最接近的比例档；如果出的还是方图，说明这个节点不支持指定尺寸，换一个节点或改用支持尺寸参数的模型。");
      }
    }
  }

  const counts = {
    error: items.filter((i) => i.level === "error").length,
    warn: items.filter((i) => i.level === "warn").length,
    info: items.filter((i) => i.level === "info").length,
  };
  return { ok: counts.error === 0, counts, items };
}
