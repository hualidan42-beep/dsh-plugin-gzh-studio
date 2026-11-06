/**
 * 赛道包：**内容方向**，不是视觉模板。
 *
 * 模板回答「长什么样」，赛道回答「写给谁、按什么结构写、哪些话不能说、缺什么声明会出事」。
 * 医疗和母婴的排版可以一样，但「治愈率 98%」「零风险」这种话在医疗稿里是红线、
 * 在职场稿里只是夸张——所以合规口径必须挂在赛道上，不能挂在模板上。
 *
 * 三条设计约束：
 *
 * 1. **规则只做「字面 + 声明」两层**，不做语义判断。字面命中会误伤（「不根治」也含「根治」），
 *    所以命中一律 `warn`，文案写「确认一下」，不写「违规」；只有**必须声明缺失**才判 `error`——
 *    那是真的没写，不是模型猜的。
 * 2. **检查结果和 `lib/qa.js` 同形状**（`{id, level, scope, title, detail, fix}`），
 *    面板不用为赛道再长一套 UI，计数也能一起算。
 * 3. **包是数据，不是代码**：用户往 `<root>/tracks/*.json` 丢一份同形状的包就能加赛道。
 *
 * 内置 21 条（A 档强合规 10 + B 档事实核验 4 + C 档生活 7），全景表见
 * `design/gzh-workbench-v2-plan.md` 第五节。
 * @module lib/tracks
 */

/** 档位说明：A 写错会出事，B 写错会失真，C 写错只是不好读。 */
export const TIERS = {
  A: { label: "强合规", note: "禁用词 + 必须声明 + 敏感红线" },
  B: { label: "事实核验", note: "引用 / 数据 / 版本" },
  C: { label: "生活通用", note: "结构与口吻为主" },
};

/** 出处标记：出现任意一个就算「写了来源」。 */
const SOURCE_MARKERS = ["据", "来源", "数据", "报告", "统计", "样本", "调研", "测算", "白皮书", "官方", "公开", "文献", "年表", "档案"];
/** 「有具体主张」的形态：数字 + 单位，或者明确的年份。 */
const CLAIM_PATTERN = /(\d+(?:\.\d+)?\s*(%|％|倍|万|亿|人|家|篇|条|例|项))|(\b(19|20)\d{2}\s*年)/;
/** 版本 / 日期：科技与 AI 稿要能看出「说的是哪一版」。 */
const VERSION_PATTERN = /(v?\d+\.\d+(\.\d+)?)|(\b(19|20)\d{2}[-年./]\d{1,2})|(\d{1,2}\s*月\s*\d{1,2}\s*日)/;

/**
 * 内置赛道包。
 * `structure` 是骨架（不是硬性段数），`titleFormulas` 是句式参考，
 * `imageStyle` 会作为出图 prompt 的前缀注入（面板出图时读它）。
 */
export const BUILTIN_TRACKS = [
  {
    id: "medical",
    name: "医疗健康",
    tier: "A",
    audience: "关注慢病管理、体检解读的普通读者",
    tone: "克制、给依据、不下诊断",
    structure: ["痛点场景", "机制解释", "证据与数据", "可执行建议", "边界与免责"],
    titleFormulas: ["关于…，先弄清这 3 件事", "体检报告上的…，到底要不要紧", "…的人，后来怎样了"],
    imageStyle: "冷白临床摄影，无人脸特写，无器械特写，构图干净",
    defaultTemplate: "business",
    compliance: {
      forbidden: ["治愈率", "根治", "包治", "无副作用", "疗效确切", "临床验证", "专家推荐", "有效率", "药到病除"],
      required: [{ any: ["不构成诊疗建议", "不替代诊疗", "请及时就医", "遵医嘱"], message: "医疗稿必须写明「科普不构成诊疗建议 / 请遵医嘱」", fix: "在文末加一句边界声明；这是医疗内容最基本的免责口径。" }],
      requireSources: true,
    },
  },
  {
    id: "maternal",
    name: "母婴育儿",
    tier: "A",
    audience: "0–6 岁孩子的家长",
    tone: "具体到月龄、说清安全边界",
    structure: ["月龄与场景", "常见做法", "风险点", "怎么做", "何时就医"],
    titleFormulas: ["…月龄宝宝，…怎么办", "别急着…，先看这几点", "关于…，儿科医生的建议是"],
    imageStyle: "自然光家居场景，柔和暖调，避免婴儿正脸特写",
    defaultTemplate: "paper",
    compliance: {
      forbidden: ["绝对安全", "零风险", "包治", "最安全", "长高", "变聪明", "彻底解决"],
      required: [
        { any: ["月龄", "个月", "周岁"], message: "母婴稿要标清月龄 / 年龄段", fix: "在开头写明适用月龄；同一条建议在 3 个月和 3 岁身上是两件事。" },
        { any: ["就医", "儿科", "医生"], message: "母婴稿要给出「什么情况该就医」", fix: "结尾补一句就医指征，别让家长拿文章当诊断。" },
      ],
    },
  },
  {
    id: "finance",
    name: "金融理财",
    tier: "A",
    audience: "有闲钱但不懂金融产品的普通投资者",
    tone: "讲清机制、不承诺收益",
    structure: ["场景", "机制", "成本与风险", "怎么选", "风险提示"],
    titleFormulas: ["…到底怎么算", "买…之前，先弄清这 3 个成本", "…的坑，不在收益上"],
    imageStyle: "克制的商务摄影或数据插画，不用金币钞票堆叠",
    defaultTemplate: "business",
    compliance: {
      forbidden: ["稳赚", "保本", "零风险", "躺赚", "必涨", "年化收益", "包赚", "无风险套利"],
      required: [{ any: ["不构成投资建议", "投资有风险", "风险提示"], message: "金融稿必须写明「不构成投资建议 / 投资有风险」", fix: "文末补风险提示；这是监管口径，不是客套。" }],
      requireSources: true,
    },
  },
  {
    id: "education",
    name: "教育升学",
    tier: "A",
    audience: "K12 / 考研 / 留学的家长与学生",
    tone: "给方法、不承诺结果",
    structure: ["学段与目标", "常见误区", "方法", "怎么验证有效", "个体差异"],
    titleFormulas: ["…阶段，最该先抓的是…", "为什么…越努力越没效果", "…的 3 个可验证指标"],
    imageStyle: "明亮书桌与纸笔，避免摆拍笑脸",
    defaultTemplate: "jp-minimal",
    compliance: {
      forbidden: ["保过", "包过", "提分保证", "100% 通过", "必上名校", "名师一对一保证"],
      required: [{ any: ["因人而异", "不保证", "个体差异"], message: "教育稿要说明「效果因人而异」", fix: "补一句效果说明，避免变成效果承诺。" }],
    },
  },
  {
    id: "legal",
    name: "法律",
    tier: "A",
    audience: "遇到合同、劳动、婚姻家事问题的普通人",
    tone: "讲规则、讲程序、不替人下结论",
    structure: ["场景", "法律依据", "程序怎么走", "证据清单", "个案差异"],
    titleFormulas: ["…能不能要回来", "遇到…，先做这 3 件事", "…的举证责任在谁"],
    imageStyle: "克制的档案与桌面静物，不用法槌戏剧化摆拍",
    defaultTemplate: "business",
    compliance: {
      forbidden: ["一定能赢", "包赢", "胜诉率", "保证胜诉", "百分百"],
      required: [{ any: ["不构成法律意见", "个案差异", "咨询律师"], message: "法律稿要写明「不构成法律意见 / 个案有差异」", fix: "文末补免责与「具体个案请咨询执业律师」。" }],
      requireSources: true,
    },
  },
  {
    id: "beauty",
    name: "美妆医美",
    tier: "A",
    audience: "关注护肤、轻医美的年轻读者",
    tone: "讲成分与机制、不承诺效果",
    structure: ["皮肤 / 场景", "机制", "成分或项目", "风险与恢复期", "适合谁"],
    titleFormulas: ["…成分到底有没有用", "做…之前，先看这 4 个风险", "…不是人人都适合"],
    imageStyle: "干净的产品与皮肤特写，冷调柔光，无夸张前后对比",
    defaultTemplate: "magazine",
    compliance: {
      forbidden: ["无痛", "零风险", "永久", "一次见效", "药到病除", "包好", "立刻白"],
      required: [{ any: ["因人而异", "专业医师", "正规机构"], message: "医美稿要提示「效果因人而异 / 需正规机构与专业医师」", fix: "补风险与资质提示；医美类内容最容易踩广告法。" }],
    },
  },
  {
    id: "science",
    name: "科学科普",
    tier: "B",
    audience: "对科学话题好奇、但没专业背景的读者",
    tone: "讲清证据强度、不夸大结论",
    structure: ["现象", "已知与未知", "证据", "边界", "进一步阅读"],
    titleFormulas: ["…是真的吗", "科学家怎么知道…", "…的结论，被误读成了…"],
    imageStyle: "纪实科学摄影或简洁示意图，标注清楚",
    defaultTemplate: "blueprint",
    compliance: {
      forbidden: ["颠覆", "证明了", "彻底推翻", "绝对"],
      requireSources: true,
    },
  },
  {
    id: "history",
    name: "历史人文",
    tier: "B",
    audience: "喜欢历史故事、但不想看戏说的读者",
    tone: "有出处、分得清史实与推断",
    structure: ["场景", "史料怎么说", "争议在哪", "我的推断", "延伸阅读"],
    titleFormulas: ["…那一年，发生了什么", "史书里的…，和你想的不一样", "关于…，有三种说法"],
    imageStyle: "档案、古籍、遗址的纪实摄影，不用影视剧剧照",
    defaultTemplate: "paper",
    compliance: {
      forbidden: ["野史", "秘闻", "惊天内幕"],
      requireSources: true,
    },
  },
  {
    id: "tech-ai",
    name: "科技 / AI",
    tier: "B",
    audience: "想用 AI 提效的从业者与管理者",
    tone: "写清版本与实测，不吹能力",
    structure: ["场景", "它现在能做什么", "实测", "成本与限制", "怎么开始"],
    titleFormulas: ["…实测：能做什么、不能做什么", "用…做…，我踩了 3 个坑", "…的边界在哪"],
    imageStyle: "干净的界面截图或抽象数据视觉，不用机器人拟人插画",
    defaultTemplate: "blueprint",
    compliance: {
      forbidden: ["吊打", "秒杀", "完全替代", "无所不能", "颠覆一切"],
      requireVersionDate: true,
      requireSources: true,
    },
  },
  {
    id: "business",
    name: "财经商业",
    tier: "B",
    audience: "关注公司、行业与商业模式的读者",
    tone: "数据说话、区分事实与判断",
    structure: ["现象", "数据", "机制", "反方观点", "结论与边界"],
    titleFormulas: ["…的钱，到底从哪来", "…这份财报，藏着 3 个信号", "…为什么突然不香了"],
    imageStyle: "商务纪实摄影或简洁图表，不用夸张涨跌曲线",
    defaultTemplate: "business",
    compliance: {
      forbidden: ["内幕", "必涨", "稳赚"],
      required: [{ any: ["不构成投资建议", "风险提示"], message: "财经稿涉及投资判断时要加风险提示", fix: "补一句「不构成投资建议」。" }],
      requireSources: true,
    },
  },
  {
    id: "career",
    name: "职场成长",
    tier: "C",
    audience: "工作 3–10 年、想升职或换赛道的人",
    tone: "给可执行动作、不贩卖焦虑",
    structure: ["具体场景", "问题拆解", "动作清单", "怎么衡量"],
    titleFormulas: ["…这件事，我是怎么做的", "别再…了，试试这 3 步", "…的 3 个判断标准"],
    imageStyle: "真实的办公与通勤场景，不用摆拍握手",
    defaultTemplate: "jp-minimal",
    compliance: { forbidden: ["年薪百万保证", "躺平"] },
  },
  {
    id: "food",
    name: "美食菜谱",
    tier: "C",
    audience: "在家做饭的普通家庭",
    tone: "步骤清楚、给克数与火候",
    structure: ["食材", "步骤", "关键点", "变化做法", "保存与安全"],
    titleFormulas: ["…这么做，比外卖还快", "…的关键，在这一步", "10 分钟…"],
    imageStyle: "自然光食物摄影，俯拍或 45 度，不用过度修图",
    defaultTemplate: "paper",
    compliance: {
      forbidden: ["绝对安全", "零失败"],
      required: [{ any: ["过敏", "生熟", "温度", "冷藏"], message: "菜谱要提示食品安全（生熟 / 温度 / 过敏原）", fix: "补一句保存或过敏原提示。" }],
    },
  },

  // ── A 档（续）：四类「说错会出事」的内容 ─────────────────────────────────
  {
    id: "psychology",
    name: "心理",
    tier: "A",
    audience: "关注情绪、压力、亲密关系的普通读者",
    tone: "描述现象、不给诊断、给求助路径",
    structure: ["场景", "这在心理学里叫什么", "可以怎么做", "什么时候要求助", "资源与热线"],
    titleFormulas: ["…的时候，身体在提醒你什么", "为什么…会反复发生", "…不是你的错，但可以这样处理"],
    imageStyle: "自然光下的人物背影或静物，不用戏剧化表情",
    defaultTemplate: "paper",
    compliance: {
      forbidden: ["治愈", "根治", "彻底摆脱", "包好", "人格缺陷"],
      required: [{ any: ["不构成诊断", "不替代专业", "心理咨询", "精神科", "求助"], message: "心理稿要提示「不替代专业帮助」", fix: "结尾给出求助路径（心理咨询 / 精神科），并写明本文不构成诊断。" }],
      requireSources: true,
    },
  },
  {
    id: "supplement",
    name: "保健品营养",
    tier: "A",
    audience: "想通过补剂改善状态的普通消费者",
    tone: "讲成分与证据等级、不承诺效果",
    structure: ["需求场景", "成分是什么", "证据到哪一步", "适宜人群与用量", "风险与停用"],
    titleFormulas: ["…到底要不要补", "…的证据，只到这一步", "买…之前先看这 3 件事"],
    imageStyle: "干净的产品与食材静物，不用夸张前后对比",
    defaultTemplate: "business",
    compliance: {
      forbidden: ["调理", "根治", "替代药物", "无副作用", "包治", "疗效"],
      required: [{ any: ["不能替代药物", "适宜人群", "遵医嘱"], message: "保健品稿必须写明「不能替代药物」", fix: "补一句「本品不能替代药物」，并写清适宜人群与用量。" }],
      requireSources: true,
    },
  },
  {
    id: "policy",
    name: "政策解读",
    tier: "A",
    audience: "需要跟进政策变化的企业与个人",
    tone: "引原文、标生效日期与适用范围",
    structure: ["政策原文", "变了什么", "谁受影响", "怎么应对", "时间与地域"],
    titleFormulas: ["…新规，影响哪些人", "…变了：3 个必须知道的变化", "…从什么时候开始执行"],
    imageStyle: "文件、桌面、城市实景的纪实摄影，不用戏剧化的红头文件特写",
    defaultTemplate: "business",
    compliance: {
      forbidden: ["官方宣布", "内部消息", "独家解读", "百分百确定"],
      required: [{ any: ["原文", "文号", "发布机关"], message: "政策稿要标明原文出处与文号", fix: "贴出政策名称 / 文号 / 发布机关，并注明生效日期与适用范围。" }],
      requireSources: true,
    },
  },
  {
    id: "brand",
    name: "品牌推广",
    tier: "A",
    audience: "准备投放或做种草的商家与操盘手",
    tone: "说清卖点与适用人群、不吹效果",
    structure: ["用户场景", "产品解决什么", "证据与实测", "和替代方案的差别", "适合谁 / 不适合谁"],
    titleFormulas: ["…到底值不值", "…实测：3 个真实使用场景", "…适合谁，不适合谁"],
    imageStyle: "真实使用场景的产品图，不用渲染级效果图",
    defaultTemplate: "magazine",
    compliance: {
      forbidden: ["国家级", "最高级", "第一品牌", "百分百有效", "无效退款", "全网最低"],
      required: [{ any: ["广告", "推广", "合作"], message: "推广内容要标明广告 / 合作关系", fix: "在开头或结尾标明「本文为广告 / 含推广合作」。" }],
      requireSources: true,
    },
  },

  // ── C 档（续）：生活类，规则轻一点，但仍然要「说清楚边界」───────────────
  {
    id: "home",
    name: "家居生活",
    tier: "C",
    audience: "正在装修、收纳、换家电的普通家庭",
    tone: "给尺寸与预算、不吹「高级感」",
    structure: ["场景与预算", "方案对比", "尺寸与材料", "踩坑清单", "维护成本"],
    titleFormulas: ["…花了多少钱，值不值", "小户型…可以这样做", "…的 3 个隐藏成本"],
    imageStyle: "自然光下的真实家居场景，不用渲染级效果图",
    defaultTemplate: "jp-minimal",
    compliance: { forbidden: ["全网最低", "绝对安全", "零甲醛"] },
  },
  {
    id: "fitness",
    name: "运动健身",
    tier: "C",
    audience: "想开始训练但怕受伤的普通人",
    tone: "给强度分级、讲清禁忌",
    structure: ["目标与基础", "动作要点", "强度与频率", "常见错误", "受伤与禁忌"],
    titleFormulas: ["…别急着上重量", "…的 3 个动作要点", "练…之前先看这一条"],
    imageStyle: "真实训练场景的纪实摄影，动作清晰，不用夸张肌肉特写",
    defaultTemplate: "blueprint",
    compliance: {
      forbidden: ["包瘦", "零风险", "一周见效"],
      required: [{ any: ["禁忌", "受伤", "循序渐进", "热身"], message: "运动稿要提示强度分级与禁忌人群", fix: "补一句「有基础疾病 / 伤痛请先咨询医生」。" }],
    },
  },
  {
    id: "pet",
    name: "宠物养护",
    tier: "C",
    audience: "养猫养狗的新手主人",
    tone: "具体、不吓人、说清什么情况要就医",
    structure: ["场景", "常见原因", "在家怎么做", "什么时候必须就医", "日常预防"],
    titleFormulas: ["…到底要不要紧", "…的 3 个信号", "别急着喂药，先看这一点"],
    imageStyle: "自然光下的宠物抓拍，避免拟人化摆拍",
    defaultTemplate: "paper",
    compliance: {
      forbidden: ["包治", "绝对安全"],
      required: [{ any: ["兽医", "就医", "宠物医院"], message: "宠物稿要提示就医指征", fix: "结尾补一句「拿不准就去宠物医院」，别让人拿文章当诊断。" }],
    },
  },
  {
    id: "travel",
    name: "旅行",
    tier: "C",
    audience: "自己规划行程的自由行游客",
    tone: "给价格与时点、讲清风险",
    structure: ["目的地与季节", "行程与预算", "交通与住宿", "避坑", "安全与保险"],
    titleFormulas: ["…几天花了多少钱", "第一次去…，这 3 件事先弄清", "…的淡季，值不值得去"],
    imageStyle: "真实旅行纪实摄影，避免过度调色",
    defaultTemplate: "magazine",
    compliance: {
      forbidden: ["绝对安全", "零风险", "全网最低"],
      required: [{ any: ["价格", "时点", "季节"], message: "旅行稿要标清价格与时点（价格会变）", fix: "补一句「价格为某年某月，出行前请再确认」。" }],
    },
  },
  {
    id: "relationship",
    name: "情感关系",
    tier: "C",
    audience: "在亲密关系、家庭沟通里遇到卡点的人",
    tone: "就事论事、不站队、不制造对立",
    structure: ["场景", "双方各自的逻辑", "可以怎么说", "边界在哪", "什么时候要求助"],
    titleFormulas: ["…的时候，可以这样说", "为什么…总是吵同一件事", "…的边界在哪里"],
    imageStyle: "克制的日常场景，不用撕扯或哭泣的戏剧化画面",
    defaultTemplate: "paper",
    compliance: {
      forbidden: ["一定会", "绝对", "渣男", "渣女"],
      required: [{ any: ["求助", "专业", "心理咨询"], message: "情感稿涉及心理危机时要给求助路径", fix: "补一句「如果出现持续失眠 / 自伤念头，请尽快寻求专业帮助」。" }],
    },
  },
];

/** 内置 id 列表（校验 `article.track` 用）。 */
export const TRACK_IDS = BUILTIN_TRACKS.map((track) => track.id);

/**
 * 校验一份赛道包（内置与用户自定义共用）。**只认形状，不认内容**：
 * 内容对不对是作者的事，插件只保证「面板读它不会崩」。
 * @param {unknown} raw
 * @returns {{ok: boolean, problems: string[], track?: object}}
 */
export function validateTrack(raw) {
  const problems = [];
  const value = raw && typeof raw === "object" ? raw : {};
  const id = String(value.id ?? "").trim();
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(id)) problems.push("id 要是小写字母/数字/短横线（2–32 位）");
  if (!String(value.name ?? "").trim()) problems.push("缺 name");
  if (value.tier !== undefined && !["A", "B", "C"].includes(value.tier)) problems.push("tier 只能是 A / B / C");
  const compliance = value.compliance && typeof value.compliance === "object" ? value.compliance : {};
  if (compliance.forbidden !== undefined && !Array.isArray(compliance.forbidden)) problems.push("compliance.forbidden 要是数组");
  if (compliance.required !== undefined) {
    if (!Array.isArray(compliance.required)) problems.push("compliance.required 要是数组");
    else {
      compliance.required.forEach((rule, index) => {
        if (!Array.isArray(rule?.any) || !rule.any.length) problems.push(`compliance.required[${index}].any 要是非空数组`);
        if (!String(rule?.message ?? "").trim()) problems.push(`compliance.required[${index}] 缺 message`);
      });
    }
  }
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    problems: [],
    track: {
      ...value,
      id,
      name: String(value.name).trim(),
      tier: ["A", "B", "C"].includes(value.tier) ? value.tier : "C",
      audience: String(value.audience ?? ""),
      tone: String(value.tone ?? ""),
      structure: Array.isArray(value.structure) ? value.structure.map(String) : [],
      titleFormulas: Array.isArray(value.titleFormulas) ? value.titleFormulas.map(String) : [],
      imageStyle: String(value.imageStyle ?? ""),
      defaultTemplate: String(value.defaultTemplate ?? ""),
      compliance: {
        forbidden: Array.isArray(compliance.forbidden) ? compliance.forbidden.map(String) : [],
        required: Array.isArray(compliance.required) ? compliance.required : [],
        requireSources: compliance.requireSources === true,
        requireVersionDate: compliance.requireVersionDate === true,
      },
      custom: value.custom === true,
    },
  };
}

/**
 * 取赛道包。`list` 可以传「内置 + 用户自定义」合并后的数组。
 * @param {string} id
 * @param {object[]} [list]
 */
export function trackOf(id, list = BUILTIN_TRACKS) {
  const key = String(id ?? "").trim();
  if (!key) return null;
  return list.find((track) => track.id === key) ?? null;
}

/** 面板下拉用的精简列表（不含规则细节，省得每次刷新都下发一遍词表）。 */
export function tracksView(list = BUILTIN_TRACKS) {
  return list.map((track) => ({
    id: track.id,
    name: track.name,
    tier: track.tier,
    tierLabel: TIERS[track.tier]?.label ?? "",
    audience: track.audience,
    tone: track.tone,
    structure: track.structure,
    titleFormulas: track.titleFormulas,
    imageStyle: track.imageStyle,
    defaultTemplate: track.defaultTemplate,
    custom: track.custom === true,
    rules: {
      forbidden: track.compliance?.forbidden?.length ?? 0,
      required: track.compliance?.required?.length ?? 0,
      requireSources: track.compliance?.requireSources === true,
      requireVersionDate: track.compliance?.requireVersionDate === true,
    },
  }));
}

/** 把文章里所有会被人读到的字拼起来（含禁忌词那一栏，它也会出现在正文里）。 */
export function articleText(article) {
  const parts = [article?.title, article?.subtitle, article?.summary, article?.audience, article?.takeaway, article?.forbidden];
  for (const section of Array.isArray(article?.sections) ? article.sections : []) {
    parts.push(section?.heading, section?.body);
  }
  return parts.filter(Boolean).join("\n");
}

/** 一条赛道检查结果（与 `lib/qa.js` 同形状）。 */
function item(track, code, level, title, detail, fix) {
  return { id: `track-${track.id}-${code}`, level, scope: "article", title, detail, fix };
}

/**
 * 按赛道规则查一遍。
 *
 * **命中禁用词只判 `warn`**：字面匹配分不清「不根治」和「根治」，
 * 判 `error` 会把人逼去改一句本来没错的话。
 * **缺必须声明判 `error`**：那是真的没写，不是猜的。
 * @param {object} article
 * @param {object} [trackOverride] 合并后的赛道包（用户自定义也在里面）
 */
export function checkTrack(article, trackOverride) {
  const track = trackOverride ?? trackOf(article?.track);
  if (!track) return { ok: true, counts: { error: 0, warn: 0, info: 0 }, items: [] };

  const text = articleText(article);
  const items = [];
  const rules = track.compliance ?? {};

  for (const word of rules.forbidden ?? []) {
    if (!word || !text.includes(word)) continue;
    items.push(item(track, `word-${word}`, "warn",
      `「${word}」是${track.name}赛道的敏感词`,
      `在${track.name}里这类表述容易被判成疗效 / 绝对化断言。`,
      `确认一下上下文：如果是在承诺效果，换成可核对的事实（谁、多少、什么条件下）；如果只是引用别人的话，标清出处。`));
  }

  (rules.required ?? []).forEach((rule, index) => {
    const alternatives = Array.isArray(rule?.any) ? rule.any : [];
    if (alternatives.some((phrase) => phrase && text.includes(phrase))) return;
    items.push(item(track, `required-${index}`, "error",
      rule?.message || `${track.name}赛道缺一条必须声明`,
      `稿子里没找到：${alternatives.map((phrase) => `「${phrase}」`).join(" / ")}`,
      rule?.fix || "补上声明；这类内容缺声明比缺配图严重。"));
  });

  if (rules.requireSources && CLAIM_PATTERN.test(text) && !SOURCE_MARKERS.some((marker) => text.includes(marker))) {
    items.push(item(track, "sources", "info",
      "文里有具体数字 / 年份，但没写来源",
      `${track.name}赛道要求数据可核对。`,
      "补一句来源（报告名 + 年份、官方发布、样本量），或者把数字换成定性描述。"));
  }

  if (rules.requireVersionDate && !VERSION_PATTERN.test(text)) {
    items.push(item(track, "version", "warn",
      "没写版本或日期",
      "科技 / AI 的能力、价格、配额都会过期，读者需要知道你说的是哪一版。",
      "在正文第一次提到产品时写清版本号与实测日期。"));
  }

  const counts = {
    error: items.filter((row) => row.level === "error").length,
    warn: items.filter((row) => row.level === "warn").length,
    info: items.filter((row) => row.level === "info").length,
  };
  return { ok: counts.error === 0, counts, items };
}

/**
 * 把赛道检查并进普通 QA。面板只认一套 `{ok, counts, items}`，
 * 不另做「赛道体检」第二块 UI——两块并排时人只会看其中一块。
 * @param {{ok: boolean, counts: object, items: object[]}} qa
 * @param {object} article
 * @param {object} [trackOverride]
 */
export function withTrackQa(qa, article, trackOverride) {
  const extra = checkTrack(article, trackOverride);
  const base = qa && Array.isArray(qa.items) ? qa : { ok: true, counts: { error: 0, warn: 0, info: 0 }, items: [] };
  if (!extra.items.length) return { ...base, track: trackOverride?.id ?? article?.track ?? "" };
  const items = [...base.items, ...extra.items];
  const counts = {
    error: items.filter((row) => row.level === "error").length,
    warn: items.filter((row) => row.level === "warn").length,
    info: items.filter((row) => row.level === "info").length,
  };
  return {
    ...base,
    items,
    counts,
    ok: counts.error === 0,
    track: trackOverride?.id ?? article?.track ?? "",
  };
}
