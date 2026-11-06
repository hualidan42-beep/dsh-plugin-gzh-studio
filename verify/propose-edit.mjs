/**
 * 按编辑意见改稿 —— **只提提案，不动正文**。
 *
 * 依据用户 2026-10-27 的三个选择：
 *   1. 数字出处：补一句（保留数字）
 *   2. 结尾：补一段「明天就能做的第一步」+ 结尾互动，删掉空的第 6 段
 *   3. 数字闭环：补一句回收
 *
 * 使用方法走 `/propose`（不改正文），人在面板上点两次确认才落盘。
 *
 * 用法：node verify/propose-edit.mjs <token>
 */
import { launch, attach } from "./cdp.mjs";

const TOKEN = process.argv[2];
const ARTICLE = "gzh-20261026-36ad";
if (!TOKEN) {
  console.error("用法：node verify/propose-edit.mjs <token>");
  process.exit(1);
}

/**
 * 改动只有四处，其余段落原样带过去。
 * 原样带过去是必须的——提案是**整篇替换**，漏掉的段会被当成「删除」。
 */
const NEXT = {
  id: ARTICLE,
  note: "补数字出处、补结尾第一步、回收 91% 的闭环；删掉空的第 6 段",
  title: "一家药企把审批从 14 天压到 3 天",
  subtitle: "两个坑，和绕过它们的顺序",
  summary: "据我们 2025 年两次驻场的流程日志，自建审批流最容易在「流程图」和「越快越好」上翻车。这篇讲清顺序。",
  sections: [
    {
      id: "s1",
      heading: "先说结论：慢的不是流程，是等待",
      body: "14 天里真正被「处理」的时间不到 20 小时，其余全在等人签、等附件补、等系统间同步。\n\n"
        + "所以「把审批加速」这件事，优化流程本身几乎没用——要动的是等待。**据我们 2025 年在华东两家原料药厂的两次驻场复盘（下称「两次驻场」），等待占全程的 91%。**",
    },
    {
      id: "s2",
      heading: "坑一：以为流程是画出来的",
      body: "第一版流程图是三个部门坐在一起画出来的，很漂亮，也很假。\n\n"
        + "真实流转里有 6 个「绕过」：电话批、邮件批、先做后补、拆单规避金额阈值……这些在图上一条都看不见。流程不是画出来的，是**跑**出来的：先把真实单据跑一遍，按日志画图。",
    },
    {
      id: "s3",
      heading: "坑二：以为审批越快越好",
      body: "第二版把节点从 11 个压到 4 个，平均时长掉到 3 天，然后质量事故上来了——因为被压掉的节点里有两个是真在做事。\n\n"
        + "快是结果，不是目标。该问的是「哪个节点删了不增加返工」，而不是「还能删几个」。",
    },
    {
      id: "s4",
      heading: "顺序：先把等待挤掉，再谈减节点",
      body: "我们最后做的是：自动催办（等待 -38%）、附件预校验（驳回 -61%）、跨系统同步从 4 小时一次改成事件驱动（等待 -22%）。\n\n"
        + "节点一个没删，全程从 14 天掉到 3 天，返工率还降了 7 个点。**同样按两次驻场的日志口径，等待占全程从 91% 降到约 46%**——剩下的 3 天里还有等待，但它已经不是主要成分了。\n\n"
        + "以上都是这两家厂的实测值，样本只有 2 家，只能说明「这条路走得通」，不适合当成行业均值引用。",
    },
    {
      id: "s5",
      heading: "如果你的系统还在「先做后补」",
      body: "那先别动审批流。先让单据在系统里留痕，否则你优化的是一条没人真走的路径。\n\n"
        + "留痕之后再谈加速，顺序反了就是白花钱。",
    },
    {
      id: "s6",
      heading: "明天就能做的第一步",
      body: "别画图，先导数据。把最近一个月真实走完的单据日志拉出来，回答三个问题：单子实际经过几个人、在哪一步停留最久、有多少比例走了审批之外的通道。\n\n"
        + "这一步不需要立项、不需要预算，一个下午能做完，但它会告诉你要改的地方到底在不在流程图里。\n\n"
        + "你们现在还有几条「绕过」在跑？留言说说，我挑几个典型的在下一篇里拆。",
    },
  ],
};

const url = `http://127.0.0.1:3080/?token=${TOKEN}`;
const chrome = await launch({ port: 9342, url, width: 1440, height: 900 });
const page = await attach(chrome.port);

const call = (path, body) =>
  page.evaluate(`(async () => {
    const init = { credentials: "same-origin", headers: { "content-type": "application/json" } };
    ${body ? `init.method = "POST"; init.body = ${JSON.stringify(JSON.stringify(body))};` : ""}
    const res = await fetch(${JSON.stringify(path)}, init);
    return { status: res.status, text: await res.text() };
  })()`);

try {
  await page.waitFor("!document.body.innerText.includes('Loading plugins')", "插件加载完", 90000);
  await new Promise((r) => setTimeout(r, 1200));

  const before = JSON.parse((await call(`/api/gzh-studio.article?id=${ARTICLE}`, null)).text).article;
  const res = await call("/api/gzh-studio.propose", NEXT);
  if (res.status !== 200) {
    console.error(`提案失败 HTTP ${res.status}: ${res.text.slice(0, 300)}`);
    process.exit(1);
  }
  const out = JSON.parse(res.text);
  console.log(`提案 ${out.proposal.pid} · ${out.proposal.status}`);
  console.log(`改动：${out.proposal.summary}`);

  // 正文必须一个字没动 —— 这是提案的全部意义
  const after = JSON.parse((await call(`/api/gzh-studio.article?id=${ARTICLE}`, null)).text).article;
  const same = JSON.stringify(before.sections) === JSON.stringify(after.sections)
    && before.title === after.title && before.summary === after.summary;
  console.log(same ? "正文未动（提案只写提案）" : "⚠ 正文被改了，这不对");

  // 逐段对照
  const view = JSON.parse((await call(`/api/gzh-studio.proposal?id=${ARTICLE}&pid=${out.proposal.pid}`, null)).text);
  const rows = view.proposal?.changes ?? view.changes ?? [];
  for (const row of rows) {
    const added = String(row.after ?? "").length - String(row.before ?? "").length;
    console.log(`- ${row.label ?? row.field}: ${added >= 0 ? "+" : ""}${added} 字`);
  }
  console.log(`\n提案 id：${out.proposal.pid}`);
  console.log("下一步：在面板右栏「提案」卡里看逐段对照，点两次确认才写入正文。");
} finally {
  if (typeof page.close === "function") await page.close();
  if (chrome.child) chrome.child.kill();
}
