/**
 * 去 AI 味（第 07 步的机器建议）。**纯函数**，不读写文件、不联网。
 *
 * 为什么要有它：07 这条门禁在本仓**没有机器判据**——谁润过稿、润了几句，盘上一个字都没记。
 * 结果是「去 AI 味」永远停在 to-do，人也不知道该改哪句。这个模块把「读起来像 AI」
 * 拆成可核对的证据：命中哪句、命中什么词、为什么像 AI、改成什么。
 *
 * 三条边界（照 `wechat/07-deai/SKILL.md` 的红线）：
 * 1. **只诊词句**：不动标题、不动摘要、不增删段落、不提配图。建议也只在句子内部改。
 * 2. **不改原文**：只产出建议，写入仍走 `proposal` 那条唯一写路径（人确认才落盘）。
 * 3. **不假装懂语义**：机械替换能凑顺的才判「可直接采纳」，需要重写的标「要人来写」——
 *    硬把「赋能」换成「帮助」而句子还是散的，只是把 AI 腔换成了另一种 AI 腔。
 * @module lib/deai
 */

/**
 * 词表。每条 = 一个「像 AI 写的」的信号。
 *
 * 分级口径：
 * - `high`：编辑腔 / 空心大词。一眼能感到「这不是人在说话」，几乎总能删或换成具体动作。
 * - `mid`：论文连接词、模糊限定。单独出现不算事，**扎堆**才是 AI 味，按句内密度加罚。
 * - `low`：轻微书面腔。只在整句偏长、或同句多个 low 命中时才提示。
 *
 * 词表不追求穷尽，追求「命中即可解释、可动手改」。加词只需往这里加一条。
 */
export const AI_TERMS = [
  // 编辑腔 / meta：作者在替读者解说这篇文章
  { id: "meta-open", words: ["本期", "本篇", "本文"], level: "high", kind: "编辑腔", why: "这是作者在介绍文章，不是文章本身。读者要看事，不想听人报幕。", fix: "删掉报幕句，直接从人、事、局面写起。" },
  { id: "meta-next", words: ["接下来我们", "下面我们", "接下来", "下面进入", "让我们", "一起来看看", "带你了解", "一起看看"], level: "high", kind: "编辑腔", why: "「下面进入名场面」式的旁白，把读者从故事里推出来。", fix: "删掉这句过渡，让上一段的结果直接接下一段的动作。" },
  { id: "meta-depth", words: ["深度解读", "深度解析", "一文读懂", "全面解析", "干货满满", "值得收藏"], level: "high", kind: "平台腔", why: "承诺的是「这篇很有价值」，而不是给读者一个具体的东西。", fix: "换成这篇真正回答的那个问题，或者直接删。" },
  { id: "meta-sum", words: ["综上所述", "总而言之", "总的来说", "由此可见", "不难看出", "不难发现", "可以看出"], level: "high", kind: "论文腔", why: "论文收尾的套话。人讲话收尾会回到具体的人或结果上。", fix: "删掉，改成一句具体结论：谁最后怎样了。" },
  { id: "meta-back", words: ["重新看", "回过头看", "再来看", "话说到这儿"], level: "mid", kind: "编辑腔", why: "把叙述拉回「讲解模式」。", fix: "直接说那件事，不加「重新看」这层壳。" },

  // 空心大词：听着很重，落不到具体动作
  { id: "big-jargon", words: ["赋能", "抓手", "闭环", "颗粒度", "组合拳", "护城河", "势能", "范式", "底层逻辑", "生态位", "第二曲线"], level: "high", kind: "行业黑话", why: "不指向任何可核对的动作，读者读完不知道发生了什么。", fix: "换成具体动作 + 具体结果：谁做了什么，结果变了多少。" },
  { id: "big-all", words: ["全方位", "多维度", "多维度地", "立体化", "深度融合", "深度赋能", "全面提升", "系统性提升"], level: "high", kind: "空心大词", why: "「全方位」等于没说范围，「深度」等于没说深度。", fix: "只留一个维度，把那个维度写到能被核对。" },
  { id: "big-adj", words: ["极大地", "显著提升", "大幅提升", "有效提升", "充分发挥", "切实推进", "持续赋能"], level: "mid", kind: "空心大词", why: "形容词在替数字干活。读者要的是「从多少到多少」。", fix: "给数字：提升前的值、提升后的值、口径。" },
  { id: "big-value", words: ["具有重要意义", "意义重大", "影响深远", "产生深远影响", "里程碑", "划时代"], level: "high", kind: "评价句", why: "这是对结论的评价，不是事实。评价谁都会给，读者要的是判断依据。", fix: "删掉评价，把支撑评价的那件事写出来。" },

  // 论文连接词：扎堆就是 AI 味
  { id: "link-conn", words: ["然而", "此外", "与此同时", "另一方面", "在此基础上", "基于此", "在此背景下", "有鉴于此"], level: "mid", kind: "论文连接词", why: "连接词本身不错，但一段里出现三四个，句子就只剩逻辑骨架、没有画面。", fix: "留一个最必要的，其余删掉——中文靠语序承接，不靠连接词。" },
  { id: "link-ord", words: ["首先", "其次", "再次", "最后一点", "第一，", "第二，", "第三，"], level: "mid", kind: "论文连接词", why: "「首先/其次/最后」是汇报结构。讲故事用不上编号，用时间或因果推进就够。", fix: "改成时间或因果顺序：「先…后来…」。" },
  { id: "link-add", words: ["不仅", "不但", "而且", "甚至", "更重要的"], level: "low", kind: "递进堆砌", why: "一句里叠三层递进，读者记不住重点。", fix: "只留最强的那个分句，其余删。" },

  // 模糊限定：说了等于没说
  { id: "vague-degree", words: ["某种程度上", "一定程度上", "在某种意义上", "或多或少", "可以说是", "应该说"], level: "mid", kind: "模糊限定", why: "自我免责。它让句子永远不算说错，也就永远不算说了什么。", fix: "要么给确定的判断，要么删掉整句。" },
  { id: "vague-count", words: ["一些", "某些", "很多", "大量", "若干", "部分"], level: "low", kind: "模糊量词", why: "数量模糊。有数就写数，没数就别用「大量」撑场面。", fix: "给具体数量或比例；给不出就把量词删掉。" },

  // 抽象主语 / 被动：动作的人不见了
  { id: "subj-we", words: ["我们可以看到", "我们发现", "我们知道", "我们不难"], level: "high", kind: "抽象主语", why: "「我们」在这里不指任何人，作用是躲开「谁做的」。", fix: "换成真正的动作主体：他、团队、报告。" },
  { id: "subj-pass", words: ["被认为是", "被视为", "被称为", "被认为"], level: "mid", kind: "被动", why: "被动句省掉了「谁认为」。", fix: "补出主体，或者直接陈述。" },

  // 装饰：形式感替代了内容
  { id: "deco-quote", words: ["所谓", "所谓的"], level: "mid", kind: "装饰", why: "「所谓」常常是作者在跟自己撇清关系，读起来像在听人转述别人的话。", fix: "直接说那个东西叫什么，不加引号距离。" },
  { id: "deco-dash", words: ["——"], level: "low", kind: "装饰", why: "破折号解释用多了，句子会被切成碎片。", fix: "一句最多一个；多出来的改逗号或拆句。" },

  // 空转的动词
  { id: "verb-shell", words: ["进行", "实现了", "开展了", "推动了", "促进了", "构建了", "打造了"], level: "mid", kind: "空转动词", why: "「进行了一次讨论」不如「讨论了一次」。这类动词把动作包了一层壳。", fix: "把后面的名词当动词用：进行讨论 → 讨论。" },
  // 数据替身：数字说得很满但没有口径
  { id: "big-data", words: ["数据表明", "数据显示", "研究表明", "实践证明", "事实表明"], level: "mid", kind: "数据替身", why: "「数据显示」后面常常没有数据，只有结论。真要引用就写清是谁的数据、多大样本。", fix: "补出处（谁、哪年、多少样本）；补不出就删掉「数据显示」四个字，直接说结论。" },
  // 结论先行但没有依据的过渡
  { id: "link-therefore", words: ["因此", "所以说", "正因为如此", "正是因为"], level: "low", kind: "推论连接", why: "推论连接词不解释因果，只在提醒读者「这里是因果关系」。用得多了句子就空了。", fix: "把因果真的写出来：「因为 A，所以 B」；写不出就说明没有因果。" },
  // 卖点式修辞
  { id: "big-boast", words: ["不得不说", "堪称", "可谓", "令人惊叹", "颠覆性", "革命性", "颠覆"], level: "high", kind: "卖点修辞", why: "这类词在替读者下判断。读者自己会判断，被替代了只会反感。", fix: "删掉评价，把让人惊叹的那个事实写出来，让读者自己惊叹。" },
  // 第一人称复数虚指
  { id: "subj-our", words: ["我们公司", "我们团队", "我们企业", "本公司"], level: "mid", kind: "空泛主体", why: "「我们团队」读完不知道是三个人还是三千人。新的叙述里它常常不指向任何具体的人。", fix: "写成具体的人或角色：三个人、审批组、IT 部。" },
  // 时间模糊
  { id: "vague-time", words: ["近年来", "日前", "前不久", "一直以来", "长期以来", "一段时间以来"], level: "mid", kind: "模糊时间", why: "「近年来」可以是三年也可以是三十年。历史类内容尤其忌讳。", fix: "给出年份或区间；给不出就说明这处不需要时间。" },
  // 空转的形容
  { id: "big-simple", words: ["非常简单", "极其重要", "十分关键", "尤为关键", "至关重要"], level: "mid", kind: "空泛评价", why: "「至关重要」没有说出它对谁重要、重要到什么程度。", fix: "写后果：不做会怎样。后果比形容词有说服力。" },
  // 排比/对仗堆砌
  { id: "deco-parallel", words: ["既要", "又要", "不仅在于", "更在于", "一方面", "两方面"], level: "low", kind: "对仗堆砌", why: "「既要…又要…」把两个方向并列摆出来，读起来齐整，实际没给取舍。", fix: "只留真做的那一件，另一件说明为什么不选。" },
  // 读者招呼
  { id: "meta-you", words: ["你是否", "你有没有", "你是不是", "如果你也", "相信很多人"], level: "mid", kind: "读者招呼", why: "开头就问「你是否…」是模板式钩子。它假装懂读者，其实谁都能套。", fix: "直接给一个具体场景，让读者自己认出自己。" },
  // 收尾留白套话
  { id: "meta-end", words: ["欢迎留言", "欢迎讨论", "你怎么看", "评论区见", "下期再见", "敬请期待"], level: "low", kind: "收尾套话", why: "这类收尾每一篇都能用，等于没有结尾。", fix: "用一句具体的话收：回到人物的选择，或这篇真正回答的那个问题。" },
  // 通篇视角的糊词
  { id: "vague-thing", words: ["相关方面", "有关方面", "相关部门", "有关部门", "相关工作"], level: "high", kind: "责任隐身", why: "「有关部门」是谁？这个词的唯一作用是把责任藏起来。合规稿里尤其危险。", fix: "写出真正的责任主体：哪个部门、哪个岗位。" },
  // 比较级空转
  { id: "big-more", words: ["更加", "更加重要", "越来越", "日益", "进一步提升", "进一步优化"], level: "mid", kind: "比较级空转", why: "「进一步」暗示之前做过一轮，但没说是哪一轮、做了什么。", fix: "写出上一轮做了什么、这一轮改什么。" },
];

/** 展平成 `词 → 条目`。同一词出现两次时先登记的赢。 */
const TERM_INDEX = new Map();
for (const term of AI_TERMS) {
  for (const word of term.words) {
    if (!TERM_INDEX.has(word)) TERM_INDEX.set(word, term);
  }
}

/** 句末标点（保留在句子里，不改原文断句）。 */
const SENTENCE_END = /[。！？!?\n]/;

/**
 * 按句切分，**保留原始偏移**。
 *
 * 不用 `split` 是为了拿到每句在原文里的位置——面板要把「原文 / 改后」并排显示，
 * 采纳某一句时要能精确替换这一段里的那一句，而不是靠文本再搜一次（重复句会错位）。
 * @param {string} text
 * @returns {{text: string, start: number, end: number}[]}
 */
export function splitSentences(text) {
  const source = String(text ?? "");
  const out = [];
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    if (!SENTENCE_END.test(source[i])) continue;
    const end = i + 1;
    const piece = source.slice(start, end);
    if (piece.trim()) out.push({ text: piece, start, end });
    start = end;
  }
  const tail = source.slice(start);
  if (tail.trim()) out.push({ text: tail, start, end: source.length });
  return out;
}

/**
 * 句内命中了哪些词。按长度从长到短试，避免「所谓的」被「所谓」抢先命中。
 * @param {string} sentence
 * @returns {{term: object, word: string}[]}
 */
export function hitsOf(sentence) {
  const text = String(sentence ?? "");
  const hits = [];
  for (let i = 0; i < text.length; i += 1) {
    for (let len = 6; len >= 2; len -= 1) {
      const term = TERM_INDEX.get(text.slice(i, i + len));
      if (!term) continue;
      hits.push({ term, word: text.slice(i, i + len) });
      i += len - 1;
      break;
    }
  }
  return hits;
}

/**
 * 机械可做的替换。**只做两类，都保证不改变句意**：
 *
 * 1. 删掉分句首的过渡词（「接下来，」「综上所述，」「此外，」）——删掉之后句子仍然成立；
 * 2. 去掉「所谓的」这层引号距离——中文里删掉它句子不变。
 *
 * 明确**不做**的：拆壳动词、改写句式、调换语序、补事实。
 * 试过自动拆「进行了长达十年的逃亡」，结果出成「长达十年了的逃亡」——
 * 中文的动宾结构不是正则能拆的。**宁可少改，不能改坏**：这句话交回给人写。
 *
 * @param {string} sentence
 * @returns {{text: string, actions: string[], safe: boolean}}
 *   `safe=false` 表示机器没把握改，`text` 留空由界面标「要人来写」。
 */
export function mechanicalRewrite(sentence) {
  let text = String(sentence ?? "");
  const actions = [];

  // 1) 分句首的过渡词整段删掉。**不留「然而」**：它是真转折，
  //    删掉会把「A，然而 B」变成「A，B」，语义就反了。
  const LEAD = /(^|[，。；！？\n])\s*(?:接下来我们|下面我们|接下来|下面进入|综上所述|总而言之|总的来说|由此可见|不难看出|值得注意的是|事实上|实际上|与此同时|此外|基于此|在此背景下|首先|其次|再次|最后一点)\s*[，,、]\s*/g;
  const beforeLead = text;
  text = text.replace(LEAD, (_all, anchor) => anchor || "");
  if (text !== beforeLead) actions.push("删掉句首过渡词");

  // 2) 「所谓的X」→「X」。只在后面紧跟实词时删，避免「所谓」单用作谓语时被误伤。
  const beforeQuote = text;
  text = text.replace(/所谓的(?=[\u4e00-\u9fa5A-Za-z])/g, "");
  if (text !== beforeQuote) actions.push("去掉「所谓」");

  // 3) 收尾清理：删词留下的「，，」「，。」与句首孤零零的逗号
  text = text.replace(/[，,]\s*(?=[，,。；！？])/g, "").replace(/\s{2,}/g, " ").replace(/^\s*[，,、]\s*/, "");

  // 只剩标点、或删完还是命中 high 级 → 机器治不好
  const bare = text.replace(/[\s。！？，、；：""''（）]/g, "");
  const left = hitsOf(text).filter((hit) => hit.term.level === "high").length;
  const safe = bare.length >= 4 && left === 0;
  return { text: safe ? text : "", actions, safe };
}

/**
 * 句子层面的诊断。
 *
 * 一条建议的判据是「命中 + 句长」双条件：短句里出现一个「然而」不算 AI 味，
 * 30 字以上的句子堆三个连接词才是。所以 low 级命中要求整句够长才报。
 *
 * @param {{text: string, start: number, end: number}} sentence
 * @param {number} index 段内第几句（界面编号用）
 * @returns {object|null}
 */
function diagnoseSentence(sentence, index) {
  const raw = sentence.text;
  const hits = hitsOf(raw);
  if (!hits.length) return null;

  // 同一词在句内重复命中只算一次（「此外…此外…」是同一个毛病）
  const seen = new Set();
  const unique = hits.filter((hit) => {
    if (seen.has(hit.word)) return false;
    seen.add(hit.word);
    return true;
  });

  const high = unique.filter((hit) => hit.term.level === "high");
  const mid = unique.filter((hit) => hit.term.level === "mid");
  const low = unique.filter((hit) => hit.term.level === "low");
  const len = raw.replace(/\s+/g, "").length;

  // 只有 low 级命中且句子不长 → 不报。避免「部分」「甚至」这种正常词满屏报错
  if (!high.length && !mid.length && (low.length < 2 || len < 40)) return null;
  // 单个 mid 级命中、句子又短 → 也不报
  if (!high.length && mid.length === 1 && len < 24 && !low.length) return null;

  /**
   * 按**词表条目**归并，不是按命中的词。
   *
   * 「此外」和「然而」属于同一条规则（论文连接词），一句里同时命中时，
   * 按词拼理由会把同一条 why 拼两遍——面板上就是「连接词本身不错…连接词本身不错…」，
   * 读起来像复读机。所以先按 term.id 归并，一条规则只出一次，把命中的词并列放在它下面。
   */
  const byTerm = new Map();
  for (const hit of unique) {
    const id = hit.term.id;
    if (!byTerm.has(id)) byTerm.set(id, { id, kind: hit.term.kind, level: hit.term.level, why: hit.term.why, fix: hit.term.fix, words: [] });
    byTerm.get(id).words.push(hit.word);
  }
  // 严重的排前面，同级按命中词多的排前面
  const reasons = [...byTerm.values()].sort((a, b) => {
    const rank = { high: 0, mid: 1, low: 2 };
    return (rank[a.level] - rank[b.level]) || (b.words.length - a.words.length);
  });

  const rewrite = mechanicalRewrite(raw);
  const level = high.length ? "high" : mid.length >= 2 ? "mid" : "low";

  return {
    index,
    start: sentence.start,
    end: sentence.end,
    before: raw,
    after: rewrite.text,
    /**
     * `auto` 机器能给出可直接采纳的句子；`manual` 只给方向，得人来写。
     * 严格按 `safe` 判——**不给「半成品也能一键采纳」的口子**，
     * 那等于让机器把病句写进正文。
     */
    mode: rewrite.safe ? "auto" : "manual",
    level,
    words: unique.map((hit) => hit.word),
    kinds: [...new Set(reasons.map((r) => r.kind))],
    /** 按规则归并后的理由，面板按条渲染（一条规则一行，不重复） */
    reasons,
    actions: rewrite.actions,
    length: len,
  };
}

/**
 * 节奏诊断：**段落级 / 全篇级**的问题，词表扫不出来。
 *
 * 为什么要它：查资料时反复看到同一条——AI 味的真正来源不是某个词，是**太整齐**：
 * 每段开头都是中心句、段落长度接近、连续三句都超过 25 字、全篇没有一个短句。
 * 词表只能抓「赋能」「综上所述」这种点状信号，抓不到「读起来像一条直线」。
 *
 * 四条判据都来自可核对的形状，不做文风玄学：
 * 1. 长句连排（连续 ≥3 句都 ≥ 25 字）—— 喘不上气；
 * 2. 段落长度整齐（各段字数极差 < 平均的 35%）—— 像表格而不是文章；
 * 3. 全篇无短句（没有一句 ≤ 12 字）—— 缺停顿；
 * 4. 每段都以中心句开头（首句都不超过 20 字且后面还有内容）—— 模板感。
 *
 * @param {object[]} sections
 * @returns {{level: string, items: object[]}}
 */
export function rhythm(sections) {
  const list = (Array.isArray(sections) ? sections : [])
    .map((section, index) => ({
      index: index + 1,
      heading: String(section?.heading ?? ""),
      body: String(section?.body ?? ""),
    }))
    .filter((row) => row.body.trim());

  const items = [];
  if (!list.length) return { level: "none", items };

  // 全篇句子（带段号，用来定位）
  const all = [];
  for (const row of list) {
    for (const sentence of splitSentences(row.body)) {
      all.push({ text: sentence.text, len: sentence.text.replace(/\s+/g, "").length, index: row.index, start: sentence.start });
    }
  }

  // 1) 长句连排
  let run = [];
  const flushRun = () => {
    if (run.length >= 3) {
      items.push({
        id: "rhythm-long-run",
        level: "warn",
        sectionIndex: run[0].index,
        title: `第 ${run[0].index} 段有连续 ${run.length} 句都超过 25 字`,
        detail: `「${run[0].text.trim().slice(0, 26)}…」起，读起来喘不上气。`,
        fix: "把中间那句拆成两句，或者删掉一个从句。长短交替才有节奏。",
      });
    }
    run = [];
  };
  for (const sentence of all) {
    if (sentence.len >= 25) run.push(sentence);
    else flushRun();
  }
  flushRun();

  // 2) 段落长度整齐（至少 3 段才谈得上「整齐」）
  //
  // 门槛 60 字是校准出来的，不是拍的：一开始定 80 字，结果一篇三段各 71 字的示范稿
  // 被放过了——而公众号真人段落常年在 60~100 字，80 这个数等于把最常见的那一档排除在外。
  // 下限只用来挡「三段都只有十几个字」这种样本太小的情形。
  if (list.length >= 3) {
    const lens = list.map((row) => row.body.replace(/\s+/g, "").length);
    const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
    const spread = Math.max(...lens) - Math.min(...lens);
    if (avg >= 60 && spread / avg < 0.35) {
      items.push({
        id: "rhythm-flat",
        level: "info",
        sectionIndex: 0,
        title: `${list.length} 段长度太整齐（${Math.min(...lens)}–${Math.max(...lens)} 字）`,
        detail: "各段字数几乎一样，看着像表格。AI 生成的稿子最常见这一个形状。",
        fix: "重点那段写长，次要那段压到两三句。宁可长短不齐，也不要平均分配。",
      });
    }
  }

  // 3) 全篇无短句
  if (all.length >= 6 && !all.some((s) => s.len <= 12)) {
    items.push({
      id: "rhythm-no-short",
      level: "info",
      sectionIndex: 0,
      title: `${all.length} 句里没有一句是短的`,
      detail: "最短的一句也有 " + Math.min(...all.map((s) => s.len)) + " 字。",
      fix: "在关键结论后面补一句短句（六七个字就行）。短句是给读者的停顿。",
    });
  }

  // 4) 每段都以中心句开头
  if (list.length >= 3) {
    const centered = list.filter((row) => {
      const first = splitSentences(row.body)[0];
      if (!first) return false;
      const len = first.text.replace(/\s+/g, "").length;
      const rest = splitSentences(row.body).slice(1);
      return len <= 20 && rest.length > 0;
    });
    if (centered.length >= list.length - 1) {
      items.push({
        id: "rhythm-topic-first",
        level: "info",
        sectionIndex: 0,
        title: `${centered.length} 段都是「先说结论再解释」`,
        detail: "每段开头一句短判断，后面跟着解释——这是汇报结构，不是叙述结构。",
        fix: "挑一两段倒过来：先讲事，结论放段末。叙述有悬念，读者才往下走。",
      });
    }
  }

  return {
    level: items.some((x) => x.level === "warn") ? "warn" : (items.length ? "info" : "ok"),
    items,
  };
}

/**
 * 对整篇文章跑一遍去 AI 味诊断。
 *
 * 只看正文与小标题——**标题、摘要不在此列**（07 的红线）。
 *
 * @param {object} article
 * @returns {{ok: boolean, total: number, high: number, mid: number, low: number,
 *   sections: object[], summary: object}}
 */
export function diagnose(article) {
  const sections = Array.isArray(article?.sections) ? article.sections : [];
  const rows = [];

  sections.forEach((section, position) => {
    const body = String(section?.body ?? "");
    if (!body.trim()) return;
    const found = [];
    splitSentences(body).forEach((sentence, i) => {
      const row = diagnoseSentence(sentence, i + 1);
      if (row) found.push(row);
    });
    if (!found.length) return;
    rows.push({
      slot: section?.id && /^s[0-9]{1,4}$/.test(String(section.id)) ? `sec-${section.id}` : `sec-s${position + 1}`,
      index: position + 1,
      heading: String(section?.heading ?? ""),
      sentences: found,
      high: found.filter((r) => r.level === "high").length,
      words: [...new Set(found.flatMap((r) => r.words))],
    });
  });

  const bodyLen = sections.reduce((sum, s) => sum + String(s?.body ?? "").replace(/\s+/g, "").length, 0);
  // 扫描量：0 命中时也要能证明「真扫过了」。只报「没问题」而不给分母，
  // 用户没法区分「稿子干净」和「功能没跑」——这两种情况的面板长得一模一样。
  const scanned = sections.reduce((sum, s) => sum + splitSentences(String(s?.body ?? "")).length, 0);
  const total = rows.reduce((sum, r) => sum + r.sentences.length, 0);
  const high = rows.reduce((sum, r) => sum + r.high, 0);
  const mid = rows.reduce((sum, r) => sum + r.sentences.filter((s) => s.level === "mid").length, 0);
  const low = rows.reduce((sum, r) => sum + r.sentences.filter((s) => s.level === "low").length, 0);
  const auto = rows.reduce((sum, r) => sum + r.sentences.filter((s) => s.mode === "auto").length, 0);
  // 密度按「每千字几句」算：长文命中句数天然多，不归一化就没法横向比
  const per1000 = bodyLen ? Math.round((total / bodyLen) * 1000 * 10) / 10 : 0;
  const flagged = new Set(rows.flatMap((r) => r.words));

  return {
    ok: high === 0,
    total,
    high,
    mid,
    low,
    auto,
    bodyLen,
    per1000,
    /** 一共扫了几句。`total=0 且 scanned>0` 才是「稿子干净」；两个都是 0 说明没正文可扫。 */
    scanned,
    terms: [...flagged],
    sections: rows,
    // 句子级给「哪句有问题」，节奏级给「整篇的形状有问题」。两层都要，缺一层都只能说清一半。
    rhythm: rhythm(sections),
    summary: verdict({ high, mid, total, scanned, per1000, bodyLen }),
  };
}

/** 一句人话结论。不报分数，报「下一步做什么」。 */
function verdict({ high, mid, total, scanned, per1000, bodyLen }) {
  if (!bodyLen) return { level: "none", text: "还没有正文，先写稿再来查。" };
  if (!total) {
    return { level: "ok", text: `扫了 ${scanned} 句，没扫到 AI 腔。可以去读一遍，看有没有拗口的地方。` };
  }
  // 用「处」不用「句」：同一句出现在三段里算三处，但面板上会合并成一行。
  // 说「9 句」而只列 3 行，人会以为列表漏了东西。
  if (high) return { level: "high", text: `扫了 ${scanned} 句，${high} 处是明显的 AI 腔（编辑腔、空心大词），发出去会掉信任，先改这几处。` };
  if (mid) return { level: "mid", text: `扫了 ${scanned} 句，${mid} 处连接词扎堆，读起来像汇报。挑最密的几段改一遍就够。` };
  // 密度口径是「每千字几句命中」，别写成「处」——那会让人以为它数的是词，实际数的是句。
  return { level: "low", text: `扫了 ${scanned} 句，只有 ${total} 处轻微书面腔（每千字约 ${per1000} 句命中），不影响发布。` };
}

/**
 * 把「要采纳哪几句」拼回整段正文。
 *
 * 面板上人可能只勾其中三条。这里按偏移从后往前替换，
 * 这样前面的偏移始终有效——从头改会让后面每句的下标都失效。
 *
 * @param {string} body 原正文
 * @param {{start: number, end: number, after: string}[]} accepted 采纳项
 * @returns {string}
 */
export function applySentences(body, accepted) {
  const list = Array.isArray(accepted) ? accepted : [];
  const valid = list
    .filter((row) => Number.isInteger(row?.start) && Number.isInteger(row?.end))
    .filter((row) => row.start >= 0 && row.end > row.start && row.end <= String(body ?? "").length)
    .filter((row) => typeof row.after === "string" && row.after.trim())
    .sort((a, b) => b.start - a.start);
  let text = String(body ?? "");
  for (const row of valid) {
    text = text.slice(0, row.start) + row.after + text.slice(row.end);
  }
  return text;
}

