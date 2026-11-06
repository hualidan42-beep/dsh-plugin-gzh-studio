/**
 * 去 AI 味 + 反馈绑定 的单元验证。
 *
 * 这两个模块是本轮新加的，都是纯函数，最适合在这里钉死口径。
 * 立场是**挑错**：每条断言后面都写清「错了会怎样」——下沉到代码里看不出来的那种错，
 * 靠测试名字自己说明白。
 *
 * 用法：node verify/deai-unit.mjs
 */
import { diagnose, splitSentences, applySentences, mechanicalRewrite, AI_TERMS, hitsOf } from "../lib/deai.js";
import { collectFeedback, pickFeedback, promptSuffix, cleanVerbatim, keyOf, feedbackSummary } from "../lib/feedback.js";

let pass = 0;
const fails = [];
const ok = (name, condition, detail = "") => {
  if (condition) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fails.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

// ── 词表本身 ────────────────────────────────────────────────────────────────
ok("词表 ≥ 30 条", AI_TERMS.length >= 30, `实际 ${AI_TERMS.length}`);
ok("每条都有 why 和 fix", AI_TERMS.every((t) => t.why && t.fix && t.words.length));
ok("每条 level 合法", AI_TERMS.every((t) => ["high", "mid", "low"].includes(t.level)));
ok("词表里没有单字词", AI_TERMS.every((t) => t.words.every((w) => w.length >= 2)),
  "单字做词表会到处误伤（「的」「了」）");

// ── 断句 ────────────────────────────────────────────────────────────────────
{
  const rows = splitSentences("第一句。第二句！第三句？");
  ok("按句末标点切三段", rows.length === 3, `实际 ${rows.length}`);
  ok("保留原始偏移（0 起）", rows[0].start === 0 && rows[0].end === 4 && rows[1].start === 4);
  ok("切出来的句子能原样拼回原文",
    rows.map((r) => "第一句。第二句！第三句？".slice(r.start, r.end)).join("") === "第一句。第二句！第三句？");
  ok("空文本切出 0 句", splitSentences("").length === 0);
  ok("只有空白的文本切出 0 句", splitSentences("   \n  ").length === 0);
}

// ── 干净稿不误报 ────────────────────────────────────────────────────────────
{
  const clean = "张良在博浪沙扔出铁椎，砸中的却是副车。他改名逃到下邳，在桥上遇见一位老人。";
  const r = diagnose({ sections: [{ id: "s1", body: clean }] });
  ok("人话稿一句都不报", r.total === 0, `报了 ${r.total} 句：${r.sections.flatMap((s) => s.sentences.map((x) => x.before)).join(" | ")}`);
  ok("干净稿 ok=true", r.ok === true);
  ok("干净稿结论是「没扫到」", r.summary.level === "ok");
  ok("干净稿也给出扫描量", r.summary.text.includes("2"), r.summary.text);
}

// ── 典型 AI 腔必须抓到 ──────────────────────────────────────────────────────
{
  const body = "综上所述，我们需要构建一套全方位的闭环体系，通过多维度的手段实现系统性提升。";
  const r = diagnose({ sections: [{ id: "s1", body }] });
  ok("「综上所述 + 闭环 + 全方位」抓到", r.total === 1 && r.high === 1);
  const sentence = r.sections[0].sentences[0];
  ok("命中词包含闭环/全方位", sentence.words.includes("闭环") && sentence.words.includes("全方位"),
    sentence.words.join("/"));
  ok("给出人话理由", (sentence.reasons ?? []).length > 0 && sentence.reasons[0].why.length > 8);
  ok("给出改法", (sentence.reasons ?? []).every((r) => r.fix && r.fix.length > 4));
  ok("这句标 manual（机器不敢直接改）", sentence.mode === "manual",
    "空心大词换词必须人来判断，机器硬换只是把 AI 腔换个说法");
}

// ── 理由不许复读（同一条规则被多个词命中时）──────────────────────────────────
{
  // 「此外」和「然而」属于同一条规则。原来按词拼 why，「连接词本身不错…」会被拼两遍，
  // 面板上读起来像复读机。现在按规则归并：一条规则只出一次，命中词并列在它下面。
  const r = diagnose({ sections: [{ id: "s1", body: "此外，各部门协同效率亟待提升，然而这一问题往往被忽视。" }] });
  const s = r.sections[0].sentences[0];
  ok("一句只报一条连接词规则（不按词重复）", s.reasons.length === 1, `报了 ${s.reasons.length} 条`);
  ok("同规则的命中词并列保留", s.reasons[0].words.length === 2 && s.reasons[0].words.includes("此外"),
    s.reasons[0].words.join("/"));
  const whyText = s.reasons.map((x) => x.why).join(" ");
  ok("理由文本里没有重复句子", whyText.indexOf("连接词本身不错") === whyText.lastIndexOf("连接词本身不错"),
    `同一条 why 出现了 ${whyText.split("连接词本身不错").length - 1} 次`);
}

// ── 不同规则的命中不合并 ────────────────────────────────────────────────────
{
  const r = diagnose({ sections: [{ id: "s1", body: "综上所述，我们需要构建全方位的闭环体系。" }] });
  const s = r.sections[0].sentences[0];
  ok("不同规则各出一条理由", s.reasons.length >= 2, `实际 ${s.reasons.length} 条`);
  ok("理由按严重度排序（high 在前）", s.reasons[0].level === "high", s.reasons.map((x) => x.level).join("/"));
}

// ── 可机器改的要真给出改后句子 ──────────────────────────────────────────────
{
  const body = "接下来，我们来看张良这个人。";
  const r = diagnose({ sections: [{ id: "s1", body }] });
  const s = r.sections[0].sentences[0];
  ok("句首过渡词被抓", s.words.includes("接下来"));
  ok("能给出改后文本", s.mode === "auto" && s.after === "我们来看张良这个人。", JSON.stringify(s.after));
  ok("机械改写不产生空句", s.after.trim().length > 0);
}

// ── 转折词「然而」不能删（删了语义反转）────────────────────────────────────
{
  const { text } = mechanicalRewrite("此外，他没成功，然而这条路走对了。");
  ok("删「此外」但保住「然而」", !text.startsWith("此外") && text.includes("然而"), text);
}

// ── 偏移替换 ────────────────────────────────────────────────────────────────
{
  const body = "接下来，我们来看张良。他说了三句话。他走了。";
  const r = diagnose({ sections: [{ id: "s1", body }] });
  const first = r.sections[0].sentences[0];
  const after = applySentences(body, [first]);
  ok("按偏移替换后原文其余部分不变", after === "我们来看张良。他说了三句话。他走了。", after);
  ok("一次替换多句不互相错位", applySentences(body, r.sections[0].sentences.filter((s) => s.mode === "auto")).includes("他走了。"));
  ok("空采纳列表原样返回", applySentences(body, []) === body);
  ok("非法偏移被忽略", applySentences(body, [{ start: -1, end: 0, after: "x" }]) === body);
}

// ── 段落口径：空段不参与，标题摘要不参与 ────────────────────────────────────
{
  const r = diagnose({
    title: "赋能闭环：全方位提升",
    summary: "综上所述，本文具有重要意义。",
    sections: [
      { id: "s1", body: "" },
      { id: "s2", body: "接下来，我们开始。" },
    ],
  });
  ok("空段不参与诊断", r.sections.length === 1 && r.sections[0].slot === "sec-s2");
  ok("标题、摘要不进正文诊断", r.total === 1, `实际 ${r.total} 句（如果是 3 句说明标题摘要被算进去了）`);
  ok("槽位 id 与前端同口径", r.sections[0].slot === "sec-s2");
}

// ── 每千字密度 ──────────────────────────────────────────────────────────────
{
  const short = diagnose({ sections: [{ id: "s1", body: "接下来，我们开始。" }] });
  const long = diagnose({ sections: [{ id: "s1", body: `接下来，我们开始。${"这是一句正常的叙述，不算 AI 腔。".repeat(20)}` }] });
  ok("密度是每千字句数（短文更高）", short.per1000 > long.per1000,
    `短 ${short.per1000} / 长 ${long.per1000}`);
  ok("密度随文长归一下降", long.per1000 < 10, `实际 ${long.per1000}`);
  // 「没问题」必须能证明「真扫过」：只报干净不给分母，用户分不清是稿子好还是功能没跑
  ok("干净稿也报扫描量", long.scanned > 10, `实际 ${long.scanned}`);
  ok("结论里写出扫了几句", long.summary.text.includes("句"));
  ok("没有正文时扫描量为 0", diagnose({ sections: [] }).scanned === 0);
  ok("空正文的结论是「还没有正文」", diagnose({ sections: [] }).summary.level === "none");
}

// ── 反馈：消费凭据 ──────────────────────────────────────────────────────────
{
  const ledger = [
    { ts: 100, type: "feedback", slot: "sec-s2", vid: "v001", verbatim: "要颗粒感" },
    { ts: 200, type: "generate", slot: "sec-s2", vid: "v002", feedback: ["100"] },
    { ts: 300, type: "feedback", slot: "sec-s2", vid: "v002", verbatim: "人物太靠边" },
    { ts: 400, type: "feedback", slot: "cover", verbatim: "封面字太大" },
  ];
  const view = collectFeedback(ledger, { slot: "sec-s2" });
  ok("同槽位取到 2 条", view.all.length === 2);
  ok("被出图引用过的那条算 used", view.used.length === 1 && view.used[0].verbatim === "要颗粒感");
  ok("usedBy 记的是谁带的", view.used[0].usedBy === "generate");
  ok("没引用的那条算 open", view.open.length === 1 && view.open[0].verbatim === "人物太靠边");
  ok("跨槽位不串（封面那条不在 sec-s2 里）", view.all.every((r) => r.slot === "sec-s2"));

  const pick = pickFeedback(ledger, { slot: "sec-s2" });
  ok("pickFeedback 只带 open", pick.length === 1 && pick[0].verbatim === "人物太靠边");
  ok("pickFeedback 可以按 key 收窄", pickFeedback(ledger, { slot: "sec-s2", keys: ["999"] }).length === 0);

  const suffix = promptSuffix(pick);
  ok("prompt 后缀含原话", suffix.includes("人物太靠边"));
  ok("prompt 后缀带序号", suffix.includes("1. "));
  ok("没有反馈时后缀为空", promptSuffix([]) === "");
}

// ── 反馈：同毫秒撞 key ──────────────────────────────────────────────────────
{
  const view = collectFeedback([
    { ts: 1, type: "feedback", slot: "cover", verbatim: "a" },
    { ts: 1, type: "feedback", slot: "cover", verbatim: "b" },
  ]);
  ok("同毫秒两条不覆盖（key 不同）", view.all.length === 2 && view.all[0].key !== view.all[1].key,
    view.all.map((r) => r.key).join("/"));
  ok("keyOf 单条无后缀", keyOf(100) === "100");
  ok("keyOf 重复补后缀", keyOf(100, 2) === "100-2");
}

// ── 反馈：文本清洗 ──────────────────────────────────────────────────────────
{
  ok("去掉首尾空白", cleanVerbatim("  要颗粒感  ") === "要颗粒感");
  ok("压掉连续空行", cleanVerbatim("第一行\n\n\n\n第二行") === "第一行\n\n第二行");
  ok("超长截断到 500", cleanVerbatim("字".repeat(900)).length === 500);
  ok("空串清理后仍是空串", cleanVerbatim("   \n  ") === "");
}

// ── 反馈：摘要口径 ──────────────────────────────────────────────────────────
{
  ok("没有反馈时的文案不是空白", feedbackSummary({ open: [], used: [] }).text.length > 5);
  ok("有 open 时提示「下次会带上」", feedbackSummary({ open: [{}], used: [] }).text.includes("下一版"));
  ok("全消费完说「都带上了」", feedbackSummary({ open: [], used: [{}] }).text.includes("带进"));
}

// ── hitsOf 长词优先 ─────────────────────────────────────────────────────────
{
  const hits = hitsOf("所谓的闭环");
  ok("长词优先匹配（所谓的 而不是 所谓）", hits.some((h) => h.word === "所谓的"), hits.map((h) => h.word).join("/"));
}


// ── 节奏（段落级/全篇级）：词表扫不出来的那类 AI 味 ──────────────────────────
{
  const { rhythm } = await import("../lib/deai.js");

  // 人话稿：长短交替、段落不齐 → 一条都不该报
  const human = rhythm([
    { id: "s1", body: "张良在博浪沙扔出铁椎。砸中的是副车。他跑了。" },
    { id: "s2", body: "搜捕持续了很久，他改名换姓躲到下邳，在桥上遇见一位老人，三次赴约才拿到兵书，此后才从动手改成出主意，整个人也沉下来了。" },
  ]);
  ok("人话稿节奏零误报", human.items.length === 0, human.items.map((x) => x.id).join("/"));

  // 长句连排：连续 3 句都 ≥25 字
  const runBody = `${"这一句话非常长用来测试连续长句的判断是否真的会触发因为它必须超过二十五个字才行。".repeat(3)}`;
  const run = rhythm([{ id: "s1", body: runBody }]);
  ok("连续三个长句被抓", run.items.some((x) => x.id === "rhythm-long-run"),
    run.items.map((x) => x.id).join("/"));

  // 段长整齐：三段字数几乎一样，且平均长度够（平均 ≤80 字不判，短样本说不清算不算「整齐」）
  // 段长整齐：门槛是「平均段长 > 80 字 且 极差 < 平均的 35%」。
  // 手写中文很容易数错字（写到 70 字就差一点没过门槛，测试会假绿），所以用程序拼到够长。
  const unit = "第一段讲一个观点并且把它解释清楚说明白让读者能够理解这里的意思，";
  const para = unit.repeat(4); // 4 × 26 ≈ 104 字，稳过 80
  const flat = rhythm([
    { id: "s1", body: para },
    { id: "s2", body: para },
    { id: "s3", body: para },
  ]);
  ok("段落长度太整齐会被报出来", flat.items.some((x) => x.id === "rhythm-flat"),
    `段长 ${flat.items.map((x) => x.id).join("/")}`);
  // 门槛校准：一开始定 80 字，结果三段各 71 字的稿子被放过——而公众号真人段落
  // 常年 60~100 字，80 这个数等于把最常见的那一档排除在外。现在门槛是 60。
  ok("60~80 字的整齐段落必须报警（门槛不能高于常见段长）", rhythm([
    { id: "s1", body: "在当前的数字化转型背景下审批流程已成为企业提升效率的重要抓手。接下来我们详细解释这个观点背后的具体原因和运作机制。综上所述这件事具有重要意义。" },
    { id: "s2", body: "在当前的数字化转型背景下审批流程已成为企业提升效率的重要抓手。接下来我们详细解释这个观点背后的具体原因和运作机制。综上所述这件事具有重要意义。" },
    { id: "s3", body: "在当前的数字化转型背景下审批流程已成为企业提升效率的重要抓手。接下来我们详细解释这个观点背后的具体原因和运作机制。综上所述这件事具有重要意义。" },
  ]).items.some((x) => x.id === "rhythm-flat"), "71 字三段一致却没报警，门槛偏高");
  ok("十六字的短段落不判「整齐」", rhythm([
    { id: "s1", body: "短段落，一共十六个字左右吧。" },
    { id: "s2", body: "短段落，一共十六个字左右吧。" },
    { id: "s3", body: "短段落，一共十六个字左右吧。" },
  ]).items.every((x) => x.id !== "rhythm-flat"), "短样本不该判「整齐」");
  ok("长短不一的三段不判「整齐」", !rhythm([
    { id: "s1", body: "在当前的数字化转型背景下审批流程已成为企业提升效率的重要抓手。接下来我们详细解释这个观点背后的具体原因和运作机制。综上所述这件事具有重要意义。" },
    { id: "s2", body: "在当前的数字化转型背景下审批流程已成为企业提升效率的重要抓手。接下来我们详细解释这个观点背后的具体原因和运作机制。综上所述这件事具有重要意义。在当前的数字化转型背景下审批流程已成为企业提升效率的重要抓手。" },
    { id: "s3", body: "他跑了。" },
  ]).items.some((x) => x.id === "rhythm-flat"), "长短差这么大还说整齐，是误报");

  // 全篇无短句：所有句子都 > 12 字
  // 「无短句」的判据要求全篇 ≥6 句才判（样本太小说不清节奏）。
  // 每句 >12 字、共 6 句，才算「全篇没有一句短的」。
  const longSentence = "这一句话的长度超过了十二个字的门槛所以它不算短句。";
  const longOnly = rhythm([{ id: "s1", body: longSentence.repeat(6) }]);
  ok("全篇没有短句会被报出来", longOnly.items.some((x) => x.id === "rhythm-no-short"),
    longOnly.items.map((x) => x.id).join("/"));
  ok("有一句短的就不报「无短句」", !rhythm([{ id: "s1", body: "他跑了。这一句话的长度超过了十二个字所以它不算短句，判据是小等于十二个字才算短句。这一句也超过十二个字。" }])
    .items.some((x) => x.id === "rhythm-no-short"), "有一句短句就该闭嘴");

  // 只有一两段时不谈「整齐」：样本太小，说整齐是瞎猜
  const two = rhythm([
    { id: "s1", body: para },
    { id: "s2", body: para },
  ]);
  ok("段数不足 3 段不谈「整齐」", !two.items.some((x) => x.id === "rhythm-flat"),
    "两段就说整齐是过度推断");

  ok("空文章节奏返回 none", rhythm([]).level === "none");
}

console.log("");
if (fails.length) {
  console.log(`deai-unit: ${fails.length} 个失败 / 共 ${pass + fails.length}`);
  for (const line of fails) console.log(`  ✗ ${line}`);
  process.exit(1);
}
console.log(`deai-unit: OK（${pass} 个用例 · 词表 ${AI_TERMS.length} 条 · 断句/改写/替换/反馈消费全过）`);
