/**
 * 只读探针：问服务「出图节点到底能不能用」。
 *
 * 为什么要有这个：节点缺 key 时 generate 会自动降级到占位图，面板上只看到
 * 「切到 fake 了」，看不出是哪个节点为什么被跳过。出图要花额度，**先问清楚再按下去**。
 *
 * 注意 `/api/gzh-studio.node` 是 **POST**（upsertNode），GET 它会把连接挂住——
 * 节点可用性从 `/api/gzh-studio.state` 的 settings.nodes 里读，那是只读的。
 *
 * 用法：node verify/probe-node.mjs <token>
 */
import { launch, attach } from "./cdp.mjs";

const token = process.argv[2];
if (!token) {
  console.error("用法：node verify/probe-node.mjs <token>");
  process.exit(1);
}

const url = `http://127.0.0.1:3080/?token=${token}`;
const chrome = await launch({ port: 9336, url, width: 1440, height: 900 });
const page = await attach(chrome.port);
try {
  await page.waitFor("!document.body.innerText.includes('Loading plugins')", "插件加载完", 90000);
  await new Promise((r) => setTimeout(r, 1200));

  const out = await page.evaluate(`(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch("/api/gzh-studio.state", { credentials: "same-origin", signal: ctrl.signal });
      const data = await res.json();
      return {
        status: res.status,
        root: data.root,
        defaultNode: data.settings?.defaultNode,
        articles: (data.articles ?? []).length,
        activity: (data.activity ?? []).length,
        nodes: (data.settings?.nodes ?? []).map((n) => ({
          id: n.id, name: n.name, usable: n.usable, reason: n.reason ?? "",
          model: n.model ?? "", baseURL: n.baseURL ?? "", size: n.size ?? "",
        })),
      };
    } finally {
      clearTimeout(timer);
    }
  })()`);

  console.log("HTTP", out.status, "| root", out.root);
  console.log(`文章 ${out.articles} 篇 · 动态 ${out.activity} 条 · 默认节点 ${out.defaultNode}`);
  for (const n of out.nodes) {
    console.log(`- ${n.id.padEnd(8)} usable=${String(n.usable).padEnd(5)} model=${n.model || "-"} ${n.reason ? `| ${n.reason}` : ""}`);
  }
} finally {
  if (typeof page.close === "function") await page.close();
  if (chrome.child) chrome.child.kill();
}
