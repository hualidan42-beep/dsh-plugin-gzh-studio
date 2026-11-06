/**
 * 浏览器半：新媒体工作台（主区全屏面板）。
 *
 * 形态照 Deckline 那张图：**左边结构、中间整篇预览、右边检查器**。
 * 差别只在中间那栏——Deckline 中间是逐页 deck，这里是**手机宽度（375px）的公众号预览**，
 * 因为公众号真正被读的地方是微信里的那一屏，不是编辑器。
 *
 * 三条硬规矩（都是踩过才知道的）：
 * 1. **浏览器半不算数**：模板 token、QA 结果、版本列表全部来自宿主半的载荷。
 *    单 bundle import 不到 `lib/`，抄一份副本就一定会漂（今天长得一样，明天就不一样了）。
 * 2. **一切改动都过宿主**：改一个字也是 POST `/save`。浏览器半不留"本地已改但没保存"的幽灵状态，
 *    否则面板上看着改了、刷新就没了 —— 这正是要治的病。
 * 3. **零依赖**：只有 `react` 一个平台模块，不引任何 UI 库。
 * @module dsh-plugin-gzh-studio/client
 */

window.__ModuleLoader__.load({
  id: "dsh-plugin-gzh-studio",
  factory: (require) => {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const h = React.createElement;

    /**
     * 公众号配置的提交体：**只包含用户真正填过的字段**。
     *
     * 界面回填的是掩码（`wx1234…abcd`），所以「留空」必须等于「不改」——
     * 否则点一次「改配置」再保存，空串会把已经存好的 AppID / AppSecret 抹掉。
     */
    function wechatConfigPayload(form = {}) {
      const payload = { mode: form.mode === "gateway" ? "gateway" : "direct" };
      const appId = String(form.appId ?? "").trim();
      const secret = String(form.appSecret ?? "").trim();
      if (appId) payload.appId = appId;
      if (secret) payload.appSecret = secret;
      payload.author = String(form.author ?? "").trim();
      if (payload.mode === "gateway") {
        payload.gateway = {
          baseURL: String(form.gatewayURL ?? "").trim(),
          token: String(form.gatewayToken ?? "").trim(),
        };
      }
      return payload;
    }

    /**
     * 面板注册键（main 与 sidebar.panellist 必须同一个 key，否则点了没反应）。 */
    const PANEL_KEY = "gzh-studio";
    /** 面板在侧边栏列表里的名字。 */
    const PANEL_LABEL = "新媒体工作台";

    /**
     * 原生对话：**会话内嵌**，不是 iframe。
     *
     * 共用宿主那份会话客户端渲染（SessionProvider + `conversation.content` 工厂槽），
     * 所以流式输出、思考过程、工具调用、审批、附件、断线重连全是真的。
     *
     * 早先左栏嵌的是同源 iframe `/?gzhChat=1`。那个做法有一个治不好的病：
     * iframe 是另一个完整的 Web 应用，它按 localStorage 里 `dsh.sessions.current`
     * 恢复「上次看的那条会话」——于是工作台里显示的是**别的任务**的对话。
     * 会话内嵌没有这个问题：面板自己 retain 一条会话，传给 SessionProvider 的就是它。
     */
    const CHAT_SLOT = "gzh-studio.chat";
    /** 每条线（公众号 / 视频号）各自一条会话，键上带线名。 */
    const CHAT_KEY = "gzh-studio.chat.session.v1";
    /** retain 的来源标签，宿主拿它算引用计数（别和别的面板混用）。 */
    const CHAT_SOURCE = "gzhStudio";
    /** 左栏对话开/关的记忆键（关掉是宽屏排版权重更高的场景）。 */
    const CHAT_OPEN_KEY = "gzs.chat.open";
    const CHAT_SOURCE_CHANGED_TYPE = "gzs:source-changed";
    const CHAT_DECISION_KEY = "gzs.chat.last-decision";
    const CHAT_SYNC_INTERVAL = 5000;
    /**
     * `apply` 时抓到的客户端根上下文。
     *
     * 会话内嵌是**命令式**的：`ctx.sessions.retain()` 要拿真对象，而 TSX 里的组件
     * 只收 props。所以这里留一个模块级引用，供 `useChatSession` 取 `sessions`。
     * 面板卸载后它仍在，但那时也不会有 hook 再调用。
     */
    let clientContext = null;

    const ROUTES = {
      state: "/api/gzh-studio.state",
      article: "/api/gzh-studio.article",
      create: "/api/gzh-studio.create",
      save: "/api/gzh-studio.save",
      generate: "/api/gzh-studio.generate",
      pick: "/api/gzh-studio.pick",
      feedback: "/api/gzh-studio.feedback",
      export: "/api/gzh-studio.export",
      image: "/api/gzh-studio.image",
      node: "/api/gzh-studio.node",
      brief: "/api/gzh-studio.brief",
      // 只读重算某篇的流水线状态：绑定完/做完一步之后刷新用。
      // 原来这行漏了，`ROUTES.pipeline` 是 undefined，绑定之后那次刷新会打到 /undefined，
      // 结果是「期号其实绑上了，面板却弹一句失败」。
      pipeline: "/api/gzh-studio.pipeline",
      propose: "/api/gzh-studio.propose",
      proposal: "/api/gzh-studio.proposal",
      decide: "/api/gzh-studio.decide",
      deai: "/api/gzh-studio.deai",
      adoptDeai: "/api/gzh-studio.adoptDeai",
      review: "/api/gzh-studio.review",
  // 实时同步（SSE）：写盘事件。宿主旧版没有这条路由时，面板安静退回手动刷新。
  stream: "/api/gzh-studio.stream",
  // 推草稿：公众号凭据 / 推一次
  wechatStatus: "/api/gzh-studio.wechatStatus",
  wechatConfig: "/api/gzh-studio.wechatConfig",
  push: "/api/gzh-studio.push",
      // 仓库真源（只读）：往期稿件列表 + 单篇。写盘的一律不接——
      // 真源归仓库，面板只借来看，改稿仍然改工作台自己库里那份。
      repo: "/api/gzh-studio.repo",
      repoArticle: "/api/gzh-studio.repoArticle",
      // 公司视频号（只读）：期列表 + 单期。
      //
      // 这两个常量曾经漏写，`getJson(ROUTES.video)` 于是 fetch 了 `/undefined`，
      // 宿主回 404，面板把它判成「路由未启用」并让人去重启宿主 —— 重启一百次也没用。
      // 和上面 `ROUTES.pipeline` 是同一种事故，所以现在有 `verify/route-check.mjs`
      // 专门盯这一件事：代码里用到的 ROUTES 键必须都在这里定义。
      video: "/api/gzh-studio.video",
      videoEpisode: "/api/gzh-studio.videoEpisode",
      // 视频期里的媒体文件（成片 / 封面 / 分镜图 / 字幕）：带 Range，<video> 才能拖进度条。
      media: "/api/gzh-studio.media",
    };

    /** 手机预览宽度：iPhone 逻辑宽度 375，微信正文两侧各留 20px。 */
    const PHONE_WIDTH = 375;
    const PHONE_PAD = 20;

    // ── 网络 ──────────────────────────────────────────────────────────────────
    /**
     * 非 2xx → Error，并把宿主带上来的「可执行字段」一起挂上去：
     * 微信错误码、要加白名单的 IP、限额的问题清单。
     */
    function httpError(response, data) {
      const error = new Error(data?.error?.message ?? `${response.status} ${response.statusText}`);
      error.status = response.status;
      error.code = data?.error?.code;
      error.ip = data?.error?.ip;
      error.hint = data?.error?.hint;
      error.problems = data?.error?.problems;
      return error;
    }

    /** GET JSON；非 2xx 抛错（把宿主回的 error.message 原样带上，不吞）。 */
    async function getJson(url) {
      const response = await fetch(url, { credentials: "same-origin" });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw httpError(response, data);
      return data;
    }

    /** POST JSON；同上。 */
    async function postJson(url, body) {
      const response = await fetch(url, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw httpError(response, data);
      return data;
    }

    /** 图片地址（带版本，换版本就换地址，不吃旧缓存）。 */
    function imageUrl(articleId, slot, vid) {
      if (!articleId || !slot || !vid) return "";
      return `${ROUTES.image}?id=${encodeURIComponent(articleId)}&slot=${encodeURIComponent(slot)}&v=${encodeURIComponent(vid)}`;
    }

    /** 视频期里某个媒体的地址（`rel` 是相对期目录的 POSIX 路径）。 */
    function mediaUrl(id, rel) {
      if (!id || !rel) return "";
      return `${ROUTES.media}?id=${encodeURIComponent(id)}&rel=${encodeURIComponent(rel)}`;
    }

    /**
     * 把已解析的字幕拼成 WebVTT，给 `<track>` 用。
     *
     * 不额外发请求：字幕本来就随 `/videoEpisode` 下发过了，再为 `.srt` 单开一条
     * 「转 VTT」的路由，等于把同一份数据读两遍。
     * @param {Array<{start:string,end:string,text:string}>} subtitles
     */
    function subtitlesToVtt(subtitles = []) {
      const stamp = (value) => String(value ?? "").replace(",", ".");
      const lines = ["WEBVTT", ""];
      subtitles.forEach((line, index) => {
        if (!line?.start || !line?.end) return;
        lines.push(String(index + 1), `${stamp(line.start)} --> ${stamp(line.end)}`, String(line.text ?? ""), "");
      });
      return lines.join("\n");
    }

    // ── 小工具 ────────────────────────────────────────────────────────────────
    /** 中文字数（不算空白），与 QC 口径一致。 */
    const countWords = (text) => String(text ?? "").replace(/\s+/g, "").length;

    /** 相对时间：账本和版本条都用它。 */
    function ago(ts) {
      const ms = Date.now() - Number(ts || 0);
      if (!Number.isFinite(ms) || ms < 0) return "";
      if (ms < 60_000) return "刚刚";
      if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
      if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时前`;
      return `${Math.floor(ms / 86_400_000)} 天前`;
    }

    /** 按 id 取模板；拿不到退回第一套（面板永不因缺 token 白屏）。 */
    function templateOf(templates, id) {
      const list = Array.isArray(templates) && templates.length ? templates : [{ id: "fallback", name: "默认", tokens: {} }];
      return list.find((t) => t.id === id) ?? list[0];
    }

    /** 正文 `**加粗**` → 片段数组（与导出器的极简语法一致）。 */
    function rich(text) {
      const parts = String(text ?? "").split(/\*\*([^*\n]+)\*\*/g);
      return parts.map((part, index) =>
        index % 2 === 1 ? h("strong", { key: index, style: { fontWeight: 600 } }, part) : part);
    }

    /** 正文按空行切段。 */
    function paragraphsOf(text) {
      return String(text ?? "")
        .split(/\n{2,}|\r\n{2,}/)
        .map((s) => s.replace(/\r?\n/g, " ").trim())
        .filter(Boolean);
    }

    /** `sec-s3` → 3；`cover` → 0。用于排序与标签。 */
    const sectionIndex = (slot) => {
      const m = /^sec-s(\d+)$/.exec(String(slot ?? ""));
      return m ? Number(m[1]) : 0;
    };

    /** 相对时间文案：用于首页卡片，避免一屏都是 2026-10-26 14:03:11。 */
    /** 精确到分钟的绝对时间，用于时间线（「4 天前」八个时间点全一样，看不出先后）。 */
    function stampText(ms) {
      const t = Number(ms) || 0;
      if (!t) return "";
      const d = new Date(t);
      const pad = (n) => String(n).padStart(2, "0");
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function timeText(ms) {
      const t = Number(ms) || 0;
      if (!t) return "";
      const diff = Date.now() - t;
      const day = 86400000;
      if (diff < 0) return "刚刚";
      if (diff < 60000) return "刚刚";
      if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
      if (diff < day) return `${Math.floor(diff / 3600000)} 小时前`;
      if (diff < day * 2) return "昨天";
      if (diff < day * 30) return `${Math.floor(diff / day)} 天前`;
      const d = new Date(t);
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    // ── 样式 ──────────────────────────────────────────────────────────────────
    /**
     * 一次性注入。全部 `gzs-` 前缀，避免和宿主样式打架。
     * 布局：header 48px + 三栏（左侧 264 / 中间自适应 / 右侧 348）。
     * 中间那栏在窄窗口下自己横向滚动（手机预览必须保持 375，不能被压窄——压窄就不是真实比例了）。
     */
    const CSS = `

/* ── 设计口径 ──────────────────────────────────────────────────────────────
   浅绿「苔绿」一套（样稿 data-palette="A"）：纸底 #eef3ec、墨 #17362a、
   主色 #33724f、琥珀 #a8742b（进行中/待办）、红 #a5453a（缺件）。
   标题一律衬线（Noto Serif SC），正文无衬线、行高 1.65 起。
   状态**不靠颜色单独承载**：颜色 + 形状（实心点 / 环 / 空心点 / 方点）+ 文字，
   三样一起给，色弱的人也能读出来。
   ------------------------------------------------------------------------ */
.gzs-root{
  --gzs-paper:#eef3ec; --gzs-paper2:#e7eee5; --gzs-card:#ffffff; --gzs-card2:#f8fbf7;
  --gzs-ink:#17362a; --gzs-body:#33503f; --gzs-muted:#6d8676; --gzs-faint:#93a89a;
  --gzs-line:#d8e3d6; --gzs-line2:#e6eee4;
  --gzs-teal:#33724f; --gzs-teal-deep:#2b6344; --gzs-cyan:#4a9169; --gzs-gold:#a8742b;
  --gzs-tint:#e6f0e5; --gzs-tint2:#f0f6ef;
  --gzs-red:#a5453a; --gzs-green:#33724f;
  --gzs-ok:#33724f; --gzs-ok-soft:#eaf3ec; --gzs-ok-line:#cfe2d6;
  --gzs-warn:#a8742b; --gzs-warn-soft:#f6efe1; --gzs-warn-line:#e8d9bd;
  --gzs-err:#a5453a; --gzs-err-soft:#f7eae7; --gzs-err-line:#e8cdc7;
  --gzs-serif:"Noto Serif SC","Source Han Serif SC","Songti SC",serif;
  position:relative;
  display:flex;flex-direction:column;height:100%;min-height:0;
  background:var(--gzs-paper);color:var(--gzs-body);
  font:12.5px/1.65 Inter,-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;overflow:hidden;
}
.gzs-root *{box-sizing:border-box}
.gzs-root ::-webkit-scrollbar{width:10px;height:10px}
.gzs-root ::-webkit-scrollbar-thumb{background:var(--gzs-line);border-radius:6px;border:3px solid transparent;background-clip:content-box}
.gzs-root ::-webkit-scrollbar-thumb:hover{background:var(--gzs-faint);background-clip:content-box}
.gzs-root ::-webkit-scrollbar-track{background:transparent}

/* ── 顶栏：白底 + 细线 + 墨绿字 ────────────────────────────────────────────
   顶栏原来固定 54px 且 overflow:hidden：右侧按钮一多（治理 / 导出三段 / 刷新），
   窄面板里最后一个「刷新」「图片清单」就被直接裁掉——不是禁用，是看不见。
   现在改为「可换行、不裁切」：宁可多占一行，也不让按钮消失。
   可伸缩的只有标题和「当前：…」，按钮永远 flex:0 0 auto。 */
.gzs-head{display:flex;align-items:center;gap:8px;padding:6px 14px;flex:0 0 auto;min-height:54px;height:auto;
  flex-wrap:wrap;row-gap:6px;background:var(--gzs-card);color:var(--gzs-ink);
  border-bottom:1px solid var(--gzs-line);overflow:visible}
.gzs-head>*{flex:0 0 auto}
.gzs-title{font-family:var(--gzs-serif);font-size:15.5px;font-weight:700;
  letter-spacing:.02em;color:var(--gzs-ink);white-space:nowrap;flex:0 1 auto;
  min-width:0;overflow:hidden;text-overflow:ellipsis}
.gzs-head .gzs-hint{color:var(--gzs-muted);font-size:11px;flex:0 1 auto;min-width:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gzs-headchips{display:flex;align-items:center;gap:6px;flex:0 0 auto}
.gzs-head .gzs-select{background:var(--gzs-card2);border-color:var(--gzs-line);color:var(--gzs-ink);
  max-width:238px;min-width:0}
.gzs-head .gzs-select:focus{outline:1px solid var(--gzs-cyan);outline-offset:1px}
.gzs-head .gzs-btn{background:var(--gzs-card);border-color:var(--gzs-line);color:var(--gzs-body)}
.gzs-head .gzs-btn:hover:not(:disabled){background:var(--gzs-tint);border-color:var(--gzs-cyan);color:var(--gzs-ink)}
.gzs-head .gzs-btn:disabled{opacity:.4}
.gzs-head .gzs-btn--primary{background:var(--gzs-teal);border-color:var(--gzs-teal);color:#fff;font-weight:600}
.gzs-head .gzs-btn--primary:hover:not(:disabled){background:var(--gzs-teal-deep);border-color:var(--gzs-teal-deep);color:#fff}
.gzs-head .gzs-btn--ghost{background:transparent;border-color:var(--gzs-line);color:var(--gzs-muted)}
.gzs-head .gzs-badge{padding:2px 8px}
.gzs-head .gzs-sep{display:none}
.gzs-spacer{flex:1}
.gzs-eyebrow{font-size:10px;letter-spacing:.16em;font-weight:700;color:var(--gzs-teal);
  text-transform:uppercase;white-space:nowrap}
.gzs-head .gzs-eyebrow{color:var(--gzs-faint)}

/* 顶栏分三组（2026-11-04）：左＝版式与频道 / 中＝身份（这是哪篇）/ 右＝动作。
   分组不是为了好看，是为了「动作要一眼找得到」：原来 12 个控件平铺，
   用户找一个「往期」得从左读到右。 */
.gzs-headgroup{display:flex;align-items:center;gap:6px;flex:0 0 auto;min-width:0}
.gzs-headgroup--mid{flex:1 1 auto;min-width:0;gap:8px}
.gzs-headgroup--mid .gzs-title{flex:0 0 auto}
.gzs-headgroup--mid .gzs-select{flex:0 1 220px;min-width:120px}
.gzs-headgroup__ctx{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:30ch}
/* 组与组之间只隔一条细线：比加间距更能说明「这是三块」 */
.gzs-headgroup+.gzs-headgroup{padding-left:8px;border-left:1px solid var(--gzs-line2)}

/* ── 按钮 / 表单 ───────────────────────────────────────────────────────── */
.gzs-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;
  padding:6px 11px;border:1px solid var(--gzs-line);border-radius:6px;background:var(--gzs-card);
  color:var(--gzs-ink);font:inherit;font-size:11.5px;font-weight:500;line-height:1.4;
  cursor:pointer;white-space:nowrap;transition:background .14s,border-color .14s,color .14s}
.gzs-btn:hover:not(:disabled){background:var(--gzs-tint2);border-color:var(--gzs-cyan)}
.gzs-btn:active:not(:disabled){transform:translateY(.5px)}
.gzs-btn:disabled{opacity:.45;cursor:not-allowed}
.gzs-btn:focus-visible{outline:2px solid color-mix(in srgb,var(--gzs-cyan) 45%,transparent);outline-offset:1px}
.gzs-btn--primary{background:var(--gzs-teal);border-color:var(--gzs-teal);color:#fff;font-weight:600}
.gzs-btn--primary:hover:not(:disabled){background:var(--gzs-teal-deep);border-color:var(--gzs-teal-deep);color:#fff}
.gzs-btn--ghost{background:var(--gzs-tint);border-color:transparent;color:var(--gzs-teal);font-weight:600}
.gzs-btn--ghost:hover:not(:disabled){background:var(--gzs-tint);border-color:transparent;color:var(--gzs-teal)}
.gzs-btn--sm{padding:4px 9px;font-size:11px}
.gzs-select{padding:5px 8px;border:1px solid var(--gzs-line);border-radius:6px;background:var(--gzs-card);
  font:inherit;font-size:11.5px;color:var(--gzs-ink);max-width:190px;cursor:pointer}
.gzs-input,.gzs-area{width:100%;padding:7px 9px;border:1px solid var(--gzs-line);border-radius:6px;
  font:inherit;font-size:12px;line-height:1.6;color:var(--gzs-body);background:var(--gzs-card);resize:vertical}
.gzs-input::placeholder,.gzs-area::placeholder{color:var(--gzs-muted)}
.gzs-input:focus,.gzs-area:focus{outline:none;border-color:var(--gzs-cyan);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--gzs-cyan) 16%,transparent)}
.gzs-label{display:block;margin:0 0 5px;font-size:10.5px;font-weight:600;color:var(--gzs-muted);
  letter-spacing:.06em}
.gzs-field{margin:0 0 13px}
.gzs-sep{height:1px;background:var(--gzs-line2);margin:13px 0}

/* ── 徽标 ───────────────────────────────────────────────────────────────── */
.gzs-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:9px;
  font-size:10.5px;font-weight:600;line-height:17px;white-space:nowrap;border:1px solid transparent}
.gzs-badge--err{background:var(--gzs-err-soft);color:var(--gzs-err);border-color:var(--gzs-err-line)}
.gzs-badge--warn{background:var(--gzs-warn-soft);color:var(--gzs-warn);border-color:var(--gzs-warn-line)}
.gzs-badge--info{background:var(--gzs-tint);color:var(--gzs-teal);border-color:var(--gzs-ok-line)}
.gzs-badge--ok{background:var(--gzs-ok-soft);color:var(--gzs-ok);border-color:var(--gzs-ok-line)}
.gzs-badge--mute{background:var(--gzs-paper2);color:var(--gzs-muted);border-color:var(--gzs-line)}

/* 实时同步指示灯：连上就写「实时」，没连上写「手刷」——
   两种状态都要说出来，否则用户分不清「没有新内容」和「没在同步」。 */
.gzs-live{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:9px;
  border:1px solid var(--gzs-line2);background:var(--gzs-card2);color:var(--gzs-muted);
  font-size:10.5px;font-weight:600;line-height:17px;white-space:nowrap}
.gzs-live--live{color:var(--gzs-ok);border-color:var(--gzs-ok-line);background:var(--gzs-ok-soft)}
.gzs-live--dead{border-style:dashed;color:var(--gzs-faint)}

/* ── 主体三栏：宽度由用户决定（默认 252 / 自适应 / 336）─────────────────────
   原来三栏是写死的 flex-basis，面板一窄（左栏对话占掉 32% 时尤其明显）
   右栏的「导出 HTML」就被挤到可视区外，顶栏按钮也被 overflow:hidden 直接裁掉——
   按钮还在 DOM 里、还在响应点击，只是看不见。用户于是以为功能没了。
   现在：左栏 / 右栏各有一条可拖拽的分隔条，宽度记在本地；
   顶栏改成可换行，宁可多占一行也不藏按钮。 */
.gzs-body{display:flex;flex:1;min-height:0;overflow-x:auto;overflow-y:hidden}
.gzs-col{display:flex;flex-direction:column;min-height:0}
.gzs-col--left{flex:0 0 252px;background:var(--gzs-card2);overflow:hidden}
/* 中栏的下限**分两档**，靠出处不同：
   - 自动布局（用户一栏都没拖过）→ 这里的 427（= JS 的 MID_NEED）。
     目标是「375 手机 + 两侧内边距完整放下」，放不下就整排横向滚动，
     宁可滚也不要缩——缩了手机预览会被压小、还会偏出中线。
   - 用户拖过某一栏 → Workspace 给这一栏叠一个内联 min-width:300（= MID_FLOOR），
     覆盖这里的 427。手动拖拽是明确指令，得给它真的空间：
     1680 窗口打开左栏对话后工作区只剩 927px，左 200 + 右 250 + 中 427 + 分隔条 14 = 891，
     只剩 36px 可拖，往右拖 40px 就被夹回去——用户的原话是「↔ 拖动根本没有生效，假动作」。
     降到 300 之后同样的窗口有 127px 可拖，手感才成立。
   两个数都要和 JS 对齐：CSS 的 427 = MID_NEED，内联的 300 = MID_FLOOR，
   否则 JS 以为拖得动、浏览器却把它撑回去。 */
.gzs-col--mid{flex:1;min-width:427px;align-items:stretch;overflow:hidden;padding:0;background:var(--gzs-paper)}
.gzs-col--right{flex:0 0 336px;background:var(--gzs-card);overflow-y:auto}

/* 窄到三栏实在放不下时，给一条明示。
   没有这条，用户看到的只是「右栏不见了」——而「不见了」和「被藏起来了」
   在用户那里是同一件事，问出来的也是同一句话：我的面板呢。 */
.gzs-narrow{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:5px 14px;
  background:var(--gzs-warn-soft);border-bottom:1px solid var(--gzs-warn-line);
  color:var(--gzs-warn);font-size:11.5px;line-height:1.5}
.gzs-narrow__t{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gzs-narrow__b{flex:0 0 auto;margin-left:auto;border:0;background:transparent;
  color:var(--gzs-warn);font:inherit;font-weight:600;text-decoration:underline;cursor:pointer;padding:0}

/* ── 拖拽分隔条 ──────────────────────────────────────────────────────────
   一条 7px 的命中区 + 1px 视觉线：细看得见、宽点得到。
   平时只显示细线（不抢视觉），悬停/聚焦/拖拽时变粗变绿。 */
.gzs-split{position:relative;flex:0 0 7px;align-self:stretch;display:flex;align-items:stretch;
  justify-content:center;padding:0;border:0;background:transparent;cursor:col-resize;
  touch-action:none;z-index:5}
/* 命中区左右各借 4px：7px 要精确点中才拖得动，手感像在考验人。
   借来的这 8px 只吃指针事件、不占布局，所以列宽计算仍按 SPLIT_W=7 走。 */
.gzs-split::after{content:"";position:absolute;top:0;bottom:0;left:-4px;right:-4px;cursor:col-resize}
.gzs-split::before{content:"";width:1px;background:var(--gzs-line);transition:width .12s,background .12s}
.gzs-split:hover::before,.gzs-split:focus-visible::before,.gzs-split[data-dragging="true"]::before{
  width:3px;background:var(--gzs-teal)}
.gzs-split:focus-visible{outline:none}
/* 抓手：只在悬停/聚焦时出现，提示「这里能拖」 */
.gzs-split__grip{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
  width:4px;height:32px;border-radius:2px;background:var(--gzs-teal);opacity:0;transition:opacity .12s}
.gzs-split:hover .gzs-split__grip,.gzs-split:focus-visible .gzs-split__grip,
.gzs-split[data-dragging="true"] .gzs-split__grip{opacity:.55}
/* 拖拽期间**不再**把整页光标改成 col-resize。
   以前这里有一条 body 级的全局规则（cursor: col-resize !important）：拖出分隔条时光标确实
   不会变，但只要收尾漏一次（窗口外松手、宿主吞事件、切窗口），整页光标就卡成 ↔、
   正文也不能选中，而且点什么都不恢复。代价远大于收益，所以删掉；
   现在只有分隔条自己是 col-resize，拖出去光标变回箭头——这是可接受的。 */
.gzs-colhead{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:8px;padding:11px 14px 9px;
  background:var(--gzs-paper);border-bottom:1px solid var(--gzs-line);
  font-size:10px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--gzs-teal)}
.gzs-col--right .gzs-colhead{background:var(--gzs-card);border-bottom-color:var(--gzs-line2)}
.gzs-colhead .gzs-hint{letter-spacing:0;text-transform:none;font-weight:500;color:var(--gzs-faint);font-size:10.5px}
/* 右栏被拖到很窄时，栏头别把「检查器」三个字挤成竖排 */
.gzs-col--right .gzs-colhead{flex-wrap:wrap;row-gap:4px}
/* ── 左栏：本期步骤（步骤条优先，结构收到底部）────────────────────────── */
.gzs-rail{display:flex;flex-direction:column;min-height:0;flex:1}
.gzs-railhead{padding:13px 16px 10px;border-bottom:1px solid var(--gzs-line2)}
.gzs-railhead__k{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--gzs-faint);font-weight:700}
.gzs-railhead__v{font-family:var(--gzs-serif);font-size:13.5px;font-weight:600;color:var(--gzs-ink);margin-top:2px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gzs-bar{height:3px;background:var(--gzs-line);border-radius:2px;margin-top:9px;overflow:hidden}
.gzs-bar i{display:block;height:100%;background:linear-gradient(90deg,var(--gzs-teal),var(--gzs-cyan))}
.gzs-railnote{display:flex;align-items:center;gap:6px;padding:7px 12px 2px 16px;font-size:10.5px;line-height:1.5;color:var(--gzs-faint)}
/* 说明文字最多占一行右半边，超出省略：按钮不能被一段长注释挤到第二行 */
.gzs-railnote__text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gzs-stepsbar{list-style:none;margin:0;padding:4px 0 8px;overflow:auto;flex:1;min-height:0}
/* 一行有 4 个格子：圆点 / 名称 / 证据 / 状态，所以这里必须定义 4 列。
   以前只写了 3 列，第 4 个（状态标签）掉进隐式列，被挤到 14px 高都不够，
   标签只剩一个「…」——状态等于没显示。名称列是 minmax(0,1fr)，让它先让位。 */
.gzs-stepline{display:grid;grid-template-columns:14px minmax(0,1fr) auto minmax(34px,auto);align-items:center;gap:8px;
  width:100%;padding:6px 14px;border:0;border-left:2px solid transparent;background:transparent;
  font:inherit;text-align:left;color:inherit;cursor:pointer}
.gzs-stepline:hover{background:var(--gzs-paper2)}
.gzs-stepline--on{background:var(--gzs-tint);border-left-color:var(--gzs-teal)}
.gzs-stepline--stop{box-shadow:inset 0 0 0 1px var(--gzs-err-line)}
.gzs-stepline--static{cursor:default}
.gzs-stepdot{width:9px;height:9px;border-radius:50%;border:1.5px solid #b9cbbd;background:transparent;justify-self:center}
.gzs-stepdot--ok{background:var(--gzs-ok);border-color:var(--gzs-ok)}
.gzs-stepdot--doing{border-color:var(--gzs-warn);background:var(--gzs-card);box-shadow:0 0 0 3px var(--gzs-warn-soft)}
.gzs-stepdot--todo{border-color:var(--gzs-line);background:transparent}
.gzs-stepdot--miss{background:var(--gzs-err);border-color:var(--gzs-err);border-radius:2px}
.gzs-stepname{display:flex;gap:6px;align-items:baseline;min-width:0}
.gzs-stepno{font-size:10px;color:var(--gzs-faint);font-variant-numeric:tabular-nums;min-width:11px;flex:0 0 auto}
.gzs-steptext{font-size:12.5px;color:var(--gzs-body);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gzs-stepline--ok .gzs-steptext,.gzs-stepline--doing .gzs-steptext{color:var(--gzs-ink)}
/* 证据（3/6、48 条、导出过…）比结论弱一档：它是「凭什么」，不是「结论」 */
.gzs-stepnote{flex:0 0 auto;max-width:64px;font-size:10px;color:var(--gzs-faint);
  font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gzs-steptag{font-size:10.5px;white-space:nowrap;color:var(--gzs-faint);flex:0 0 auto;max-width:88px;
  overflow:hidden;text-overflow:ellipsis}
.gzs-steptag--ok{color:var(--gzs-ok)}
.gzs-steptag--doing{color:var(--gzs-warn)}
.gzs-steptag--miss{color:var(--gzs-err)}
.gzs-railbind{padding:0 12px 10px}
/* 结构列表最多占左栏 38%：再高就会把上面 11 步挤成半行滚动 */
.gzs-railfoot{border-top:1px solid var(--gzs-line2);flex:0 0 auto;max-height:38%;overflow:auto;padding:6px 0 10px}
.gzs-railfoot__head{display:flex;align-items:center;gap:6px;width:100%;border:0;background:transparent;
  font:inherit;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--gzs-muted);
  padding:5px 16px;cursor:pointer;text-align:left;font-weight:700}
.gzs-railfoot__head:hover{color:var(--gzs-teal)}
.gzs-railfoot__n{letter-spacing:0;text-transform:none;font-weight:500;color:var(--gzs-faint);font-size:10.5px}

/* ── 中栏：正文舞台（成稿 / 手机预览 / 排版）──────────────────────────── */
.gzs-stage{flex:1;min-width:0;overflow-y:auto;padding:20px 26px 60px;background:var(--gzs-paper)}
.gzs-stagehead{padding-bottom:12px;border-bottom:1px solid var(--gzs-line)}
.gzs-stagetitle{font-family:var(--gzs-serif);font-size:27px;line-height:1.28;margin:0;
  font-weight:600;color:var(--gzs-ink);letter-spacing:.01em}
.gzs-stage-sub{margin:6px 0 0;font-size:12.5px;line-height:1.6;color:var(--gzs-muted)}
.gzs-meta{display:flex;align-items:center;gap:16px;margin-top:12px;font-size:12px;color:var(--gzs-faint);flex-wrap:wrap}
.gzs-meta b{color:var(--gzs-body);font-weight:500}
.gzs-meta__tpl{white-space:nowrap}
/* 受众可能是整句，截断而不是撑开——撑开会把右边的视图切换挤到第二行 */
.gzs-meta__aud{display:inline-block;max-width:22ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}
.gzs-seg--view{margin-left:auto}
.gzs-doc{margin-top:20px;max-width:660px}
.gzs-doc p{font-size:15px;line-height:1.95;color:var(--gzs-body);margin:0 0 18px}
.gzs-doc h3.gzs-doch{font-family:var(--gzs-serif);font-size:17px;font-weight:600;line-height:1.4;
  color:var(--gzs-ink);margin:30px 0 12px;padding-left:11px;border-left:3px solid var(--gzs-teal);cursor:pointer}
.gzs-doch:hover{color:var(--gzs-teal)}
.gzs-docsummary{background:var(--gzs-card);border:1px solid var(--gzs-line);border-left:3px solid var(--gzs-cyan);
  border-radius:8px;padding:12px 16px;margin:16px 0 0;font-size:13px;line-height:1.7;color:var(--gzs-body)}
.gzs-docsummary .k{display:block;font-size:11px;letter-spacing:.12em;color:var(--gzs-faint);margin-bottom:4px}
/* 封面在「成稿」里不占首屏：缩成一条 52px 的槽位条。
   原来它是撑满中栏的大图（900×380），一屏只剩「一行标题 + 一张图」，看着像幻灯片，
   而正文要往下滚才看得到——这是「感觉像在做 PPT」的根因。整图在「手机预览」里给。 */
.gzs-coverstrip{display:flex;align-items:center;gap:10px;margin:16px 0 2px;padding:6px 10px;
  border:1px solid var(--gzs-line2);border-radius:9px;background:var(--gzs-card2);cursor:pointer;
  transition:border-color .14s,background .14s}
.gzs-coverstrip:hover{border-color:var(--gzs-teal);background:var(--gzs-tint)}
.gzs-coverstrip img{flex:0 0 auto;width:96px;height:40px;object-fit:cover;border-radius:6px;background:var(--gzs-paper2)}
.gzs-coverstrip figcaption{display:flex;align-items:baseline;gap:8px;min-width:0;font-size:11.5px;color:var(--gzs-muted)}
.gzs-coverstrip .t{flex:0 0 auto;font-weight:600;color:var(--gzs-ink)}
.gzs-coverstrip .n{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--gzs-faint)}
.gzs-coverstrip .go{flex:0 0 auto;margin-left:auto;font-size:11px;color:var(--gzs-teal);white-space:nowrap}
.gzs-shot{margin:16px 0 26px;border:1px solid var(--gzs-line);border-radius:10px;overflow:hidden;background:var(--gzs-card)}
.gzs-shot img{display:block;width:100%;height:216px;object-fit:cover;background:var(--gzs-paper2)}
.gzs-shot figcaption{display:flex;justify-content:space-between;gap:10px;font-size:11.5px;color:var(--gzs-faint);
  padding:7px 11px;border-top:1px solid var(--gzs-line2)}
.gzs-docgap{margin:2px 0 18px;padding:10px 12px;border:1px dashed var(--gzs-line);border-radius:8px;
  font-size:11.5px;color:var(--gzs-faint);background:var(--gzs-card2);cursor:pointer;text-align:center}
.gzs-phonewrap{width:${PHONE_WIDTH + 22}px;margin:18px auto 0;background:#101b16;border-radius:34px;padding:11px;
  box-shadow:0 18px 44px rgba(16,32,24,.24)}
/* 窄窗：375 的真机宽度塞不进中栏时，整块**等比缩小**——不横向裁切、也不用横向滚动条。
   用 zoom 而不是 transform：zoom 会参与布局，后面的内容不会压上来。 */
@media (max-width:1300px){
  .gzs-phonewrap{zoom:.78}
}
@media (max-width:1150px){
  .gzs-phonewrap{zoom:.66}
}
.gzs-layout{margin-top:18px;max-width:660px}
.gzs-layoutcard{border:1px solid var(--gzs-line);border-radius:10px;background:var(--gzs-card);padding:18px 20px}
.gzs-layouthd{font-family:var(--gzs-serif);font-size:15px;font-weight:600;color:var(--gzs-ink);margin:0 0 6px}
.gzs-layoutacts{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.gzs-layoutlist{margin:12px 0 0;padding:0;list-style:none;font-size:11.5px;line-height:1.7;color:var(--gzs-muted)}
.gzs-layoutlist li{padding:4px 0;border-top:1px dashed var(--gzs-line2)}
.gzs-layoutlist li:first-child{border-top:0}

/* ── 左栏大纲（结构小节，仍在用）───────────────────────────────────────── */
.gzs-outline{padding:4px 8px 0}
.gzs-item{display:block;width:100%;text-align:left;border:1px solid transparent;border-left:3px solid transparent;
  border-radius:0 6px 6px 0;padding:7px 9px;background:transparent;cursor:pointer;margin:0 0 2px;
  font:inherit;color:inherit;transition:background .14s,border-color .14s}
.gzs-item:hover{background:var(--gzs-paper2)}
.gzs-item--on{background:var(--gzs-tint);border-left-color:var(--gzs-teal)}
.gzs-item--on:hover{background:var(--gzs-tint)}
.gzs-item__top{display:flex;align-items:baseline;gap:7px}
.gzs-item__no{flex:0 0 auto;font-size:10px;font-weight:700;letter-spacing:.04em;
  color:var(--gzs-gold);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.gzs-item__name{flex:1;min-width:0;font-size:12px;font-weight:600;color:var(--gzs-ink);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gzs-item__meta{margin-top:3px;display:flex;align-items:center;gap:7px;font-size:10.5px;
  color:var(--gzs-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gzs-item__meta>*{flex:0 0 auto}
.gzs-dot{width:6px;height:6px;border-radius:50%;background:var(--gzs-line);flex:0 0 auto}
.gzs-dot--done{background:var(--gzs-ok)}
.gzs-dot--busy{background:var(--gzs-warn)}
.gzs-dot--miss{background:var(--gzs-err)}
.gzs-dot--todo{background:transparent;border:1px solid var(--gzs-faint)}

/* ── 中栏：手机预览（375 真机宽度，不压窄）────────────────────────────── */
.gzs-phonebox{width:100%;min-width:0;display:flex;justify-content:center}
.gzs-phone{width:${PHONE_WIDTH}px;flex:0 0 auto;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;
  box-shadow:0 12px 32px #17362a24,0 1px 0 #ffffff inset;border:1px solid var(--gzs-line)}
.gzs-phonebar{height:28px;display:flex;align-items:center;justify-content:center;gap:6px;
  font-size:10px;letter-spacing:.08em;color:var(--gzs-muted);background:var(--gzs-card2);
  border-bottom:1px solid var(--gzs-line2)}
.gzs-paper{padding:${PHONE_PAD}px;font-size:15px;line-height:1.85;color:#2d2d2d}
/* 预览即编辑：正文块可点（点一下右栏就选中这段），图片悬停出「重出 / 换版」。
   这两件事以前要去右栏或「图」tab 里做，是每天最多余的两次切换。 */
.gzs-psec{cursor:pointer;border-radius:6px;transition:background .12s,box-shadow .12s;padding:2px 4px;margin:0 -4px}
.gzs-psec:hover{background:#4a91690f;box-shadow:0 0 0 1px #4a91692e}
.gzs-psec--on{background:#4a916914}
.gzs-pimg{position:relative;cursor:pointer}
.gzs-pimg__bar{position:absolute;right:8px;top:8px;display:flex;align-items:center;gap:4px;
  opacity:0;transition:opacity .12s;pointer-events:none}
.gzs-pimg:hover .gzs-pimg__bar,.gzs-pimg:focus-within .gzs-pimg__bar{opacity:1;pointer-events:auto}
.gzs-pimg__v{font-size:10px;color:#fff;background:#17362ad1;border-radius:6px;padding:2px 6px;
  font-family:ui-monospace,Consolas,monospace}
.gzs-pimg__b{border:0;border-radius:6px;padding:3px 8px;font:inherit;font-size:10.5px;font-weight:600;
  color:#fff;background:#17362adb;cursor:pointer}
.gzs-pimg__b:hover:not(:disabled){background:var(--gzs-teal)}
.gzs-pimg__b:disabled{opacity:.55;cursor:default}
.gzs-row{display:flex;align-items:center;gap:6px}
.gzs-grow{flex:1;min-width:0}
.gzs-thumb{width:100%;display:block;border-radius:8px;background:var(--gzs-paper2)}
.gzs-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:var(--gzs-faint)}

/* ── 右栏检查器：4 个 tab（意见 / 证据 / 图 / 元信息）──────────────────── */
.gzs-insp{display:flex;flex-direction:column;min-height:0}
.gzs-insphead{display:flex;align-items:center;gap:8px;padding:12px 14px 9px;margin:0;
  font-family:var(--gzs-serif);font-size:13.5px;font-weight:700;color:var(--gzs-ink)}
.gzs-itabs{display:flex;gap:2px;padding:0 12px;border-bottom:1px solid var(--gzs-line);
  background:var(--gzs-card);flex:0 0 auto}
.gzs-itab{border:0;border-bottom:2px solid transparent;background:transparent;font:inherit;font-size:12.5px;
  color:var(--gzs-muted);padding:7px 10px 8px;cursor:pointer}
.gzs-itab:hover{color:var(--gzs-teal)}
.gzs-itab--on{color:var(--gzs-teal);border-bottom-color:var(--gzs-teal);font-weight:600}
.gzs-itabpanel{padding:12px 14px 34px}
.gzs-itabpanel[hidden]{display:none!important}
.gzs-kv{display:grid;grid-template-columns:76px minmax(0,1fr);gap:6px 10px;font-size:12.5px;margin:0}
.gzs-kv dt{color:var(--gzs-faint)}
.gzs-kv dd{margin:0;color:var(--gzs-body);word-break:break-word}
.gzs-thumbs{display:grid;grid-template-columns:1fr 1fr;gap:9px}
.gzs-thumbs figure{margin:0;cursor:pointer}
.gzs-thumbs img{width:100%;height:74px;object-fit:cover;border-radius:7px;border:1px solid var(--gzs-line);
  background:var(--gzs-paper2)}
.gzs-thumbs figcaption{display:flex;justify-content:space-between;gap:6px;font-size:10.5px;
  color:var(--gzs-faint);margin-top:4px}
.gzs-sect{margin:0 0 18px}
.gzs-sect__head{display:flex;align-items:center;gap:7px;margin:0 0 9px;padding:0 0 7px;
  border-bottom:1px solid var(--gzs-line2);font-size:10px;font-weight:700;letter-spacing:.14em;
  text-transform:uppercase;color:var(--gzs-teal)}
.gzs-sect__head .gzs-hint{letter-spacing:0;text-transform:none;font-weight:500;font-size:10.5px;
  color:var(--gzs-faint)}
.gzs-ver{display:flex;align-items:center;gap:8px;padding:7px 10px;margin:0 0 6px;cursor:pointer;
  border:1px solid var(--gzs-line2);border-radius:6px;background:var(--gzs-card);transition:border-color .14s,background .14s}
.gzs-ver:hover{border-color:var(--gzs-cyan);background:var(--gzs-tint2)}
.gzs-ver--on{border-color:var(--gzs-teal);background:var(--gzs-tint);box-shadow:inset 3px 0 var(--gzs-teal)}
.gzs-ver__vid{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;font-weight:700;
  color:var(--gzs-ink)}
.gzs-ver__meta{flex:1;min-width:0;font-size:10.5px;color:var(--gzs-muted);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ── QA 条目 ────────────────────────────────────────────────────────────── */
.gzs-qa{padding:9px 11px;border-radius:0 5px 5px 0;margin:0 0 8px;
  border-left:3px solid var(--gzs-line);background:var(--gzs-card2)}
.gzs-qa--error{border-left-color:var(--gzs-err);background:var(--gzs-err-soft)}
.gzs-qa--warn{border-left-color:var(--gzs-warn);background:var(--gzs-warn-soft)}
.gzs-qa--info{border-left-color:var(--gzs-cyan);background:var(--gzs-tint2)}
.gzs-qa__t{font-size:11.5px;font-weight:650;color:var(--gzs-ink);line-height:1.5}
.gzs-qa__d{margin-top:3px;font-size:11px;line-height:1.65;color:var(--gzs-muted);word-break:break-word}
.gzs-qa__f{margin-top:5px;font-size:11px;line-height:1.65;color:var(--gzs-body);word-break:break-word}

/* ── 空态 / 提示 ────────────────────────────────────────────────────────── */
.gzs-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;
  height:100%;min-height:200px;padding:26px;text-align:center;color:var(--gzs-muted);font-size:12px}
.gzs-hint{font-size:11px;line-height:1.65;color:var(--gzs-faint)}
.gzs-blank{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;
  padding:44px 24px;border:1px dashed var(--gzs-line);border-radius:8px;background:var(--gzs-card);
  text-align:center}

/* 新手起手式：三张卡，一张主推。调研里最一致的一条是「首屏要有三个字内能看懂的按钮」 */
.gzs-start{display:grid;grid-template-columns:repeat(auto-fit,minmax(196px,1fr));gap:10px;
  width:100%;max-width:720px;margin:6px 0 0}
.gzs-startcard{display:flex;flex-direction:column;gap:3px;text-align:left;padding:13px 14px;
  border:1px solid var(--gzs-line);border-radius:8px;background:var(--gzs-card);
  font:inherit;cursor:pointer;transition:border-color .15s,box-shadow .15s,transform .15s}
.gzs-startcard:hover{border-color:var(--gzs-cyan);box-shadow:0 6px 18px #17362a1a;transform:translateY(-1px)}
.gzs-startcard--main{background:var(--gzs-teal);border-color:var(--gzs-teal)}
.gzs-startcard--main .gzs-startcard__t{color:#fff}
.gzs-startcard--main .gzs-startcard__d{color:#d6e8dc}
.gzs-startcard--main .gzs-startcard__no{background:#ffffff2e;color:#fff}
.gzs-startcard__no{width:19px;height:19px;border-radius:50%;background:var(--gzs-tint);
  color:var(--gzs-teal);font-size:10.5px;font-weight:700;display:flex;align-items:center;justify-content:center}
.gzs-startcard__t{font-size:13px;font-weight:700;color:var(--gzs-ink);margin-top:3px}
.gzs-startcard__d{font-size:10.5px;line-height:1.55;color:var(--gzs-muted)}
.gzs-blank b{font-family:var(--gzs-serif);font-size:16px;color:var(--gzs-ink);font-weight:700}
.gzs-blank p{margin:0;font-size:11.5px;line-height:1.7;color:var(--gzs-muted);max-width:420px}

/* ── 账本 ───────────────────────────────────────────────────────────────── */
.gzs-ledger{display:flex;flex-direction:column;gap:0}
.gzs-ledger__n{color:var(--gzs-warn);font-weight:650;font-size:10px}
.gzs-ledger__row{display:flex;gap:9px;padding:6px 0;border-bottom:1px solid var(--gzs-line2);
  font-size:11px;line-height:1.6}
.gzs-ledger__row:last-child{border-bottom:none}
.gzs-ledger__t,.gzs-ledger__ts{flex:0 0 auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:10px;color:var(--gzs-gold);padding-top:1px}
.gzs-ledger__ts{flex:0 0 52px;color:var(--gzs-faint)}
.gzs-ledger__txt{flex:1;min-width:0;color:var(--gzs-body);word-break:break-word}

/* ── 提案 / 对照 ────────────────────────────────────────────────────────── */
.gzs-prop{border:1px solid var(--gzs-line2);border-radius:6px;padding:10px 11px;margin:0 0 8px;
  background:var(--gzs-card)}
.gzs-prop--on{border-color:var(--gzs-teal);background:var(--gzs-tint2)}
.gzs-prop--stale{border-color:var(--gzs-warn-line);background:var(--gzs-warn-soft)}
.gzs-prop__top{display:flex;align-items:center;gap:6px;margin-bottom:3px}
.gzs-prop__sum{flex:1;min-width:0;font-size:11.5px;font-weight:650;color:var(--gzs-ink);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gzs-prop__meta{margin-top:3px;font-size:10.5px;color:var(--gzs-muted);line-height:1.55;word-break:break-word}
.gzs-prop__acts{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.gzs-prop__reject{margin-top:8px;padding:8px;border:1px dashed var(--gzs-warn-line);border-radius:7px;background:var(--gzs-warn-soft)}
.gzs-prop__reject-title{font-size:10.5px;font-weight:650;color:var(--gzs-warn);margin-bottom:6px}
.gzs-prop__reject-options{display:flex;flex-wrap:wrap;gap:5px}
.gzs-prop__reject-option{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;color:var(--gzs-body);cursor:pointer}
.gzs-prop__reject-option input{accent-color:var(--gzs-warn)}
.gzs-prop__reject-actions{display:flex;gap:6px;margin-top:7px}
.gzs-chg{margin:0 0 12px}
.gzs-chg__t{display:flex;align-items:center;gap:6px;margin:0 0 5px;font-size:11px;font-weight:650;
  color:var(--gzs-teal)}
.gzs-diff{border:1px solid var(--gzs-line2);border-radius:6px;background:var(--gzs-card2);max-height:220px;
  overflow:auto;padding:6px 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:11px;line-height:1.7}
.gzs-diff__row{padding:1px 10px;white-space:pre-wrap;word-break:break-word}
.gzs-diff__row--add{background:var(--gzs-ok-soft);color:var(--gzs-ok)}
.gzs-diff__row--del{background:var(--gzs-err-soft);color:var(--gzs-err)}
.gzs-diff__row--same{color:var(--gzs-faint)}
.gzs-diff__row--gap{color:var(--gzs-line)}

/* ── 分段控件（顶栏导出 / 中栏视图切换共用）──────────────────────────── */
.gzs-seg{display:inline-flex;align-items:center;border:1px solid var(--gzs-line);border-radius:7px;
  overflow:hidden;background:var(--gzs-card);padding:2px}
.gzs-seg .gzs-btn{border:0;border-radius:5px;background:transparent;padding:4px 10px;font-size:11px;
  color:var(--gzs-muted)}
.gzs-seg .gzs-btn+.gzs-btn{border-left:0}
.gzs-seg .gzs-btn:hover:not(:disabled){background:var(--gzs-tint);color:var(--gzs-teal)}
.gzs-seg .gzs-btn--on{background:var(--gzs-tint);color:var(--gzs-teal);font-weight:600}

/* ── 首页：文章卡片 ─────────────────────────────────────────────────────── */
.gzs-home,.gzs-gov{flex:1;min-height:0;overflow-y:auto}
.gzs-home{padding:26px 30px 40px}
.gzs-homehead{display:flex;align-items:flex-end;gap:12px;margin:0 0 18px;
  padding-bottom:14px;border-bottom:1px solid var(--gzs-line)}
.gzs-hometitle{font-family:var(--gzs-serif);font-size:21px;font-weight:700;
  line-height:1.3;color:var(--gzs-ink);letter-spacing:.01em}
.gzs-cards{display:flex;flex-direction:column;gap:8px}

/* ── 库存条：计数 + 搜索 ─────────────────────────────────────────────────── */
/* ── 首页「现在可以做这些」：先给待办，再给库存 ───────────────────────────── */
.gzs-today{margin:12px 0 2px}
.gzs-today__h{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin:0 0 8px}
.gzs-today__t{font-family:var(--gzs-serif);font-size:13.5px;font-weight:700;color:var(--gzs-ink)}
.gzs-today__grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(178px,1fr));gap:8px}
.gzs-today__card{display:flex;align-items:center;gap:10px;text-align:left;padding:9px 11px;
  border:1px solid var(--gzs-line2);border-radius:10px;background:var(--gzs-card);cursor:pointer;
  font:inherit;color:inherit;transition:border-color .14s,background .14s}
.gzs-today__card:hover{border-color:var(--gzs-teal);background:var(--gzs-card2)}
.gzs-today__n{flex:0 0 auto;min-width:24px;text-align:center;font-family:var(--gzs-serif);
  font-size:17px;font-weight:700;color:var(--gzs-teal);font-variant-numeric:tabular-nums}
.gzs-today__b{min-width:0;display:flex;flex-direction:column;gap:2px}
.gzs-today__title{font-size:12px;font-weight:650;color:var(--gzs-ink);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gzs-today__hint{font-size:10.5px;color:var(--gzs-muted);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.gzs-stock{display:flex;flex-direction:column;gap:0;align-items:stretch;
  margin:0 0 16px;padding:11px 13px;border:1px solid var(--gzs-line2);border-radius:9px;background:var(--gzs-card2)}
.gzs-stock__top{display:flex;align-items:center;gap:14px;flex-wrap:wrap;width:100%}
.gzs-facet{display:flex;flex-direction:column;gap:5px;width:100%;margin-top:9px;
  padding-top:8px;border-top:1px dashed var(--gzs-line2)}
.gzs-facet__row{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.gzs-facet__k{font-size:10px;color:var(--gzs-faint);letter-spacing:.06em;flex:0 0 auto;margin-right:2px}
.gzs-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:11px;
  border:1px solid var(--gzs-line2);background:var(--gzs-card);color:var(--gzs-muted);
  font:inherit;font-size:10.5px;cursor:pointer;line-height:1.6}
.gzs-chip:hover{border-color:var(--gzs-cyan);color:var(--gzs-ink)}
.gzs-chip--on{background:var(--gzs-tint);border-color:var(--gzs-ok-line);color:var(--gzs-teal);font-weight:650}
.gzs-chip__n{font-size:9.5px;color:var(--gzs-faint);font-variant-numeric:tabular-nums}
.gzs-chip--on .gzs-chip__n{color:var(--gzs-teal)}
.gzs-stock__nums{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.gzs-stat{display:inline-flex;align-items:baseline;gap:5px;padding:4px 9px;border-radius:6px;
  border:1px solid transparent;background:transparent;font:inherit;cursor:pointer;line-height:1.3}
.gzs-stat:hover{background:var(--gzs-paper2)}
.gzs-stat--on{background:var(--gzs-tint);border-color:var(--gzs-ok-line)}
.gzs-stat--on .gzs-stat__n{color:var(--gzs-teal)}
.gzs-stat--plain{cursor:default}
.gzs-stat--plain:hover{background:transparent}
.gzs-stat__n{font-size:16px;font-weight:700;color:var(--gzs-ink);font-variant-numeric:tabular-nums}
.gzs-stat--warn .gzs-stat__n{color:var(--gzs-err)}
.gzs-stat--plain .gzs-stat__n{font-size:13px;color:var(--gzs-muted);font-weight:600}
.gzs-stat__k{font-size:10.5px;color:var(--gzs-muted)}
.gzs-search{display:flex;align-items:center;gap:5px;margin-left:auto;flex:0 0 300px;min-width:200px}
.gzs-search__in{flex:1;min-width:0;padding:6px 9px;font:inherit;font-size:11.5px;
  border:1px solid var(--gzs-line);border-radius:6px;background:var(--gzs-card);color:var(--gzs-body)}
.gzs-search__in:focus{outline:2px solid color-mix(in srgb,var(--gzs-cyan) 40%,transparent);outline-offset:1px}
.gzs-search__x{border:0;background:transparent;cursor:pointer;font:inherit;font-size:14px;
  color:var(--gzs-faint);padding:0 2px;line-height:1}
.gzs-search__go{padding:6px 11px;border:1px solid var(--gzs-teal);border-radius:6px;cursor:pointer;
  font:inherit;font-size:11px;background:var(--gzs-teal);color:#fff}
.gzs-search__go:hover{background:#2b6344}
@media (max-width:1080px){ .gzs-search{flex:1 0 100%;margin-left:0} }
.gzs-homecols{display:grid;grid-template-columns:minmax(0,1fr) 306px;gap:20px;align-items:start}
.gzs-homecols--solo{grid-template-columns:minmax(0,1fr)}
@media (max-width:1240px){.gzs-homecols{grid-template-columns:1fr}}
.gzs-actpanel{position:sticky;top:0}
.gzs-actbody{padding:6px 8px 8px}
.gzs-actlist{display:flex;flex-direction:column}
.gzs-act{display:block;width:100%;text-align:left;border:0;border-left:2px solid transparent;
  background:transparent;padding:7px 9px;border-radius:0 5px 5px 0;font:inherit;color:inherit;cursor:pointer}
.gzs-act+.gzs-act{border-top:1px solid var(--gzs-line2)}
.gzs-act:hover{background:var(--gzs-tint2);border-left-color:var(--gzs-line)}
.gzs-act__top{display:flex;align-items:center;gap:6px}
.gzs-act__title{flex:1;min-width:0;font-size:11px;font-weight:650;color:var(--gzs-ink);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gzs-act__time{flex:0 0 auto;font-size:10px;color:var(--gzs-faint);
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.gzs-act__d{margin-top:3px;font-size:10.5px;line-height:1.55;color:var(--gzs-muted);
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.gzs-act__n{color:var(--gzs-warn);font-weight:650}

/* ── 流水线状态（首页徽标 + 右栏区块）────────────────────────────────────── */
/* 徽标压在封面上：半透明墨绿底 + 浅字，深图浅图都能读 */
.gzs-card__life{padding:0 5px;border-radius:4px;font-weight:650;font-size:9.5px}
.gzs-card__life--draft{background:var(--gzs-paper2);color:var(--gzs-muted)}
.gzs-card__life--draftbox{background:var(--gzs-warn-soft);color:var(--gzs-warn)}
.gzs-card__life--published{background:var(--gzs-ok-soft);color:var(--gzs-ok)}
/* 赛道：比生命周期轻一档——它是「按哪套口径写」，不是「到哪一步了」 */
.gzs-card__track{padding:0 5px;border-radius:4px;font-size:9.5px;font-weight:600;
  background:var(--gzs-tint);color:var(--gzs-teal);border:1px solid var(--gzs-ok-line)}

/* 赛道口径卡（Inspector 元信息）：口吻 / 结构骨架 / 规则条数 */
.gzs-trackinfo{padding:7px 9px;border:1px solid var(--gzs-line2);border-radius:8px;background:var(--gzs-card2)}
.gzs-trackinfo__h{font-size:11.5px;font-weight:650;color:var(--gzs-ink)}
.gzs-trackinfo__d{font-size:11px;line-height:1.6;color:var(--gzs-muted);margin-top:2px}
.gzs-trackinfo__s{font-size:10.5px;line-height:1.6;color:var(--gzs-teal);margin-top:4px}
.gzs-card__badge{position:absolute;left:8px;top:8px;z-index:2;
  padding:3px 8px;border-radius:10px;font-size:10px;font-weight:650;letter-spacing:.02em;
  background:rgba(23,54,42,.90);color:#f2f8f3;backdrop-filter:saturate(1.1)}
.gzs-card__badge--warn{background:rgba(168,116,43,.94)}
.gzs-card__badge--err{background:rgba(165,69,58,.94)}
.gzs-card__badge--ok{background:rgba(51,114,79,.94)}

.gzs-pipe{border:1px solid var(--gzs-line2);border-radius:9px;padding:10px 11px 11px;background:var(--gzs-card2)}
.gzs-pipe__status{display:flex;align-items:center;gap:7px;margin:0 0 6px}
.gzs-pipe__word{font-size:13px;font-weight:700;letter-spacing:.01em}
.gzs-pipe__status--ok .gzs-pipe__word{color:var(--gzs-ok)}
.gzs-pipe__status--warn .gzs-pipe__word{color:var(--gzs-warn)}
.gzs-pipe__status--err .gzs-pipe__word{color:var(--gzs-err)}
.gzs-pipe__ep{font-size:10px;color:var(--gzs-faint);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gzs-pipe__hint{font-size:11.5px;line-height:1.6;color:var(--gzs-body);margin:0 0 7px}
.gzs-pipe__block{margin:0 0 6px;padding:6px 8px;border-radius:6px;font-size:11px;line-height:1.55;
  background:var(--gzs-err-soft);color:var(--gzs-err);border-left:3px solid var(--gzs-err)}
.gzs-pipe__block--warn{background:var(--gzs-warn-soft);color:var(--gzs-warn);border-left-color:var(--gzs-warn)}

/* 有待确认提案时的粘性跳转条：右栏太长，提案卡会落在视口外 */
.gzs-jump{position:sticky;top:0;z-index:4;display:flex;align-items:center;gap:7px;width:100%;
  margin:0;padding:8px 14px;border:0;border-bottom:1px solid var(--gzs-warn-line);
  background:var(--gzs-warn-soft);color:var(--gzs-warn);font:inherit;font-size:11.5px;font-weight:650;
  text-align:left;cursor:pointer}
.gzs-jump:hover{background:var(--gzs-warn-soft)}
.gzs-jump__go{margin-left:auto;font-weight:500;color:var(--gzs-warn)}

/* 意见区：右侧负责定位与路由，不再充当第二个聊天窗口。自然语言讨论统一回左侧 DSH 原生对话。
   轻量反馈仍可落账，但它明确标成「后续反馈」，避免被误认为已经发送给 Agent。 */
.gzs-compose{border:1px solid var(--gzs-line2);background:var(--gzs-card2);
  border-radius:9px;padding:10px 11px 9px;margin:0 0 10px}
.gzs-compose__h{display:flex;align-items:center;gap:8px;min-width:0;margin-bottom:5px}
.gzs-compose__h .t{font-size:12px;font-weight:650;color:var(--gzs-ink);white-space:nowrap}
.gzs-compose__h .s{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:10.5px;color:var(--gzs-faint)}
.gzs-compose__context{margin:0 0 8px;font-size:10.5px;line-height:1.6;color:var(--gzs-muted)}
.gzs-compose__quote{padding:7px 8px;border-left:3px solid var(--gzs-teal);border-radius:5px;background:var(--gzs-tint2);
  color:var(--gzs-body);font-size:11px;line-height:1.55;margin-bottom:8px}
.gzs-compose__actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.gzs-compose__actions .gzs-hint{flex:1 1 150px;min-width:0;font-size:10.5px}
.gzs-compose__feedback{margin-top:8px;padding-top:8px;border-top:1px dashed var(--gzs-line2)}
.gzs-compose__feedback textarea{display:block;width:100%;background:var(--gzs-card);border:1px solid var(--gzs-line);
  border-radius:7px;padding:6px 8px;font:inherit;font-size:11.5px;line-height:1.5;color:var(--gzs-body);resize:vertical}
.gzs-compose__feedback textarea:focus{outline:2px solid color-mix(in srgb,var(--gzs-teal) 35%,transparent);
  outline-offset:0;border-color:var(--gzs-teal)}
.gzs-myfb{margin:2px 0 0;padding:0;list-style:none}
.gzs-myfb li{display:flex;align-items:flex-start;gap:6px;padding:4px 0;font-size:11.5px;
  line-height:1.6;color:var(--gzs-body);border-top:1px dashed var(--gzs-line2)}
.gzs-myfb li:first-child{border-top:0}
.gzs-myfb .d{flex:0 0 5px;height:5px;border-radius:50%;background:var(--gzs-warn);margin-top:6px}
.gzs-myfb .x{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.gzs-myfb .g{flex:0 0 auto;font-size:9.5px;color:var(--gzs-faint);border:1px solid var(--gzs-line2);
  border-radius:4px;padding:0 4px;margin-top:1px}

/* 提案的性质标签：改词句 / 改结构 / 改标题 / 改摘要。四档颜色区分退到哪一步 */
.gzs-kind{flex:0 0 auto;padding:1px 6px;border-radius:8px;font-size:9.5px;font-weight:650;
  border:1px solid transparent;white-space:nowrap}
.gzs-kind--polish{background:var(--gzs-tint);color:var(--gzs-teal);border-color:var(--gzs-ok-line)}
.gzs-kind--structure{background:var(--gzs-err-soft);color:var(--gzs-err);border-color:var(--gzs-err-line)}
.gzs-kind--title{background:var(--gzs-warn-soft);color:var(--gzs-warn);border-color:var(--gzs-warn-line)}
.gzs-kind--summary{background:var(--gzs-paper2);color:var(--gzs-muted);border-color:var(--gzs-line)}
.gzs-prop__route{margin-top:4px;font-size:10px;line-height:1.5;color:var(--gzs-muted)}
.gzs-prop__also{color:var(--gzs-err);font-weight:600}
.gzs-prop__rule{display:block;margin-top:2px;color:var(--gzs-faint);font-size:9.5px;line-height:1.45}

/* ── 节点条：13 步走到哪 ─────────────────────────────────────────────────── */
.gzs-nodes{margin:10px 0 0}
.gzs-nodes__top{display:flex;align-items:baseline;gap:7px;margin:0 0 6px}
.gzs-nodes__bar{display:flex;flex-wrap:wrap;gap:4px}
.gzs-node{display:inline-flex;align-items:center;gap:3px;padding:2px 6px;border-radius:5px;
  font-size:10px;line-height:1.5;border:1px solid var(--gzs-line2);background:var(--gzs-card);cursor:default}
.gzs-node__mark{font-weight:700;font-size:9.5px}
.gzs-node__label{white-space:nowrap}
.gzs-node--done{background:var(--gzs-ok-soft);border-color:var(--gzs-ok-line);color:var(--gzs-ok)}
.gzs-node--todo{background:var(--gzs-err-soft);border-color:var(--gzs-err-line);color:var(--gzs-err)}
.gzs-node--doing{background:var(--gzs-tint);border-color:var(--gzs-ok-line);color:#2b6344}
.gzs-node--skip{background:var(--gzs-paper2);border-color:var(--gzs-line);color:var(--gzs-faint)}
.gzs-node--unknown{background:var(--gzs-warn-soft);border-color:var(--gzs-warn-line);color:var(--gzs-warn)}
.gzs-nodes__skip{margin-top:5px;font-size:10px;line-height:1.5;color:var(--gzs-faint)}

/* ── 事实核对 ─────────────────────────────────────────────────────────────── */
.gzs-facts{display:flex;flex-wrap:wrap;gap:5px}
.gzs-fact{display:inline-flex;align-items:baseline;gap:4px;padding:2px 7px;border-radius:5px;
  font-size:10px;border:1px solid var(--gzs-line2);background:var(--gzs-card)}
.gzs-fact__k{color:var(--gzs-muted)}
.gzs-fact__v{font-weight:650}
.gzs-fact--ok .gzs-fact__v{color:var(--gzs-ok)}
.gzs-fact--none{opacity:.72}
.gzs-fact--none .gzs-fact__v{color:var(--gzs-err)}
.gzs-fact--unknown .gzs-fact__v{color:var(--gzs-warn)}

/* ── 时间线 ───────────────────────────────────────────────────────────────── */
.gzs-tl{display:flex;flex-direction:column;gap:1px}
.gzs-tl__row{display:grid;grid-template-columns:86px 1fr;gap:2px 8px;padding:4px 0;
  border-bottom:1px dashed var(--gzs-line2);font-size:10.5px;line-height:1.5}
.gzs-tl__row:last-child{border-bottom:0}
.gzs-tl__at{color:var(--gzs-faint);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9.5px}
.gzs-tl__label{color:var(--gzs-ink);font-weight:600}
.gzs-tl__note{grid-column:2;color:var(--gzs-muted);font-size:9.5px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ── 粗略进度（未接产线时）：五档，完成打勾 ───────────────────────────── */
.gzs-steps{display:flex;flex-wrap:wrap;gap:5px;margin:2px 0 0}
.gzs-step{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:6px;
  font-size:10.5px;border:1px solid var(--gzs-line2);background:var(--gzs-card);color:var(--gzs-muted)}
.gzs-step--done{background:var(--gzs-ok-soft);border-color:var(--gzs-ok-line);color:var(--gzs-ok)}
.gzs-step__mark{width:14px;height:14px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  font-size:9px;font-weight:700;background:var(--gzs-paper2);color:var(--gzs-faint)}
.gzs-step--done .gzs-step__mark{background:var(--gzs-ok);color:#fff}
.gzs-pipe__mini{display:flex;align-items:center;gap:7px;margin:8px 0 0}
.gzs-pipe__minibar{display:flex;gap:2px;flex:1;min-width:0}
.gzs-mini{flex:1;height:5px;border-radius:2px;background:var(--gzs-line)}
.gzs-mini--done{background:var(--gzs-ok)}
.gzs-mini--todo{background:var(--gzs-err)}
.gzs-mini--doing{background:var(--gzs-warn)}
.gzs-mini--skip{background:var(--gzs-line)}
.gzs-mini--unknown{background:var(--gzs-warn);opacity:.5}

/* 治理视图里的观测区（宽版） */
.gzs-obs__hint{font-size:12px;line-height:1.65;color:var(--gzs-body);margin:0 0 10px}
.gzs-obs__facts{margin-top:12px}

/* 十道门的证据：一行一条，编号 / 符号 / 名称 / 说明。说明可省略号截断，title 里给全 */
.gzs-gates{margin:8px 0 0;border-top:1px solid var(--gzs-line2);padding-top:6px}
.gzs-gate{display:grid;grid-template-columns:18px 12px 1fr;gap:5px 6px;align-items:baseline;
  padding:4px 0;font-size:10.5px;line-height:1.5;border-bottom:1px dashed var(--gzs-line2)}
.gzs-gate:last-child{border-bottom:0}
.gzs-gate__no{color:var(--gzs-faint);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9.5px}
.gzs-gate__mark{font-weight:700}
.gzs-gate--ok .gzs-gate__mark{color:var(--gzs-ok)}
.gzs-gate--fail .gzs-gate__mark{color:var(--gzs-err)}
.gzs-gate--stale .gzs-gate__mark{color:var(--gzs-err)}
.gzs-gate--unknown .gzs-gate__mark{color:var(--gzs-warn)}
.gzs-gate--skip .gzs-gate__mark{color:var(--gzs-faint)}
.gzs-gate__label{color:var(--gzs-ink);font-weight:600}
/* 证据要能读全：最多两行，超出才截。整行 nowrap 会把「绑的是 6f35a431，现稿 27bee65f」
   这类关键对照切掉一半，等于没有证据。 */
.gzs-gate__detail{grid-column:2 / -1;color:var(--gzs-muted);font-size:10px;line-height:1.45;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
  word-break:break-word}
/* 首页是**行式清单**，不是卡片网格。
   卡片网格的代价：一屏只能放一张（大封面 + 大留白），第一眼像作品集封面页（用户原话：
   「感觉一进去是做PPT的」）。清单化之后一篇一行，30 篇也扫得完，标题才是主角。 */
.gzs-card{display:grid;grid-template-columns:104px minmax(0,1fr);gap:12px;align-items:center;
  padding:9px 12px 9px 10px;font:inherit;color:inherit;text-align:left;
  cursor:pointer;border:1px solid var(--gzs-line2);border-radius:10px;background:var(--gzs-card);
  overflow:hidden;transition:border-color .14s,background .14s}
.gzs-card:hover{border-color:var(--gzs-teal);background:var(--gzs-card2);box-shadow:none;transform:none}
.gzs-card:focus-visible{outline:2px solid color-mix(in srgb,var(--gzs-cyan) 50%,transparent);outline-offset:2px}
.gzs-card__thumb{position:relative;width:104px;height:68px;border-radius:8px;
  background-color:var(--gzs-paper2);background-position:center;background-size:cover;
  background-repeat:no-repeat;display:flex;align-items:center;justify-content:center;
  font-size:10px;color:var(--gzs-faint);border:1px solid var(--gzs-line2);overflow:hidden}
.gzs-card__body{display:flex;flex-direction:column;gap:4px;min-width:0;padding:0}
.gzs-card__title{font-family:var(--gzs-serif);font-size:13.5px;font-weight:700;
  line-height:1.45;color:var(--gzs-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gzs-card__sub{font-size:11.5px;line-height:1.5;color:var(--gzs-muted);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gzs-card__meta{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin-top:1px;
  font-size:10.5px;color:var(--gzs-faint)}
.gzs-card--new{display:flex;justify-content:center;align-items:center;gap:6px;min-height:64px;
  border-style:dashed;border-color:var(--gzs-line);background:transparent;color:var(--gzs-muted);
  font-size:12px;font-weight:600}
.gzs-card--new:hover{border-color:var(--gzs-teal);color:var(--gzs-teal);background:var(--gzs-card2);
  transform:none;box-shadow:none}

/* ── 往期（仓库真源，只读）────────────────────────────────────────────────── */
.gzs-repo{margin-top:22px}
.gzs-repo__head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:0 0 8px;
  border-bottom:1px solid var(--gzs-line2)}
.gzs-repo__title{font-family:var(--gzs-serif);font-size:14px;font-weight:700;color:var(--gzs-ink)}
.gzs-repo__tag{font-size:10px;font-weight:600;letter-spacing:.06em;color:var(--gzs-warn);
  border:1px solid var(--gzs-warn-line);background:var(--gzs-warn-soft);border-radius:4px;padding:1px 5px}
.gzs-repo__rows{display:flex;flex-direction:column;gap:6px;margin-top:9px}
.gzs-repo__row{display:grid;grid-template-columns:74px minmax(0,1fr) auto;gap:10px;align-items:center;
  padding:7px 11px;border:1px solid var(--gzs-line2);border-radius:9px;background:var(--gzs-card);
  font:inherit;text-align:left;color:inherit;cursor:pointer;transition:border-color .14s,background .14s}
.gzs-repo__row:hover{border-color:var(--gzs-teal);background:var(--gzs-card2)}
.gzs-repo__date{font-size:10.5px;color:var(--gzs-faint);font-variant-numeric:tabular-nums;white-space:nowrap}
.gzs-repo__mid{min-width:0;display:flex;flex-direction:column;gap:2px}
.gzs-repo__t{font-size:12.5px;line-height:1.5;color:var(--gzs-ink);overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.gzs-repo__f{display:flex;gap:5px;flex-wrap:wrap;font-size:10px;color:var(--gzs-faint)}
.gzs-repo__f i{font-style:normal;border:1px solid var(--gzs-line2);border-radius:4px;padding:0 4px}
.gzs-repo__f i.on{color:var(--gzs-ok);border-color:var(--gzs-ok-line);background:var(--gzs-ok-soft)}
.gzs-repo__line{font-size:10px;color:var(--gzs-muted);border:1px solid var(--gzs-line2);
  border-radius:4px;padding:0 5px;white-space:nowrap}
.gzs-repo__more{display:flex;justify-content:center;padding:8px 0 0}
/* 只读预览：盖在清单上方，给「看」不给「改」 */
.gzs-repo__view{margin-top:10px;border:1px solid var(--gzs-line);border-radius:10px;
  background:var(--gzs-card);overflow:hidden}
.gzs-repo__vhead{display:flex;align-items:center;gap:9px;padding:9px 12px;
  border-bottom:1px solid var(--gzs-line2);background:var(--gzs-card2)}
.gzs-repo__vtitle{font-family:var(--gzs-serif);font-size:13px;font-weight:700;color:var(--gzs-ink);
  min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gzs-repo__body{max-height:520px;overflow:auto;padding:14px 18px 22px}
.gzs-repo__body h4{font-family:var(--gzs-serif);font-size:13.5px;color:var(--gzs-ink);
  margin:16px 0 7px;padding-left:9px;border-left:3px solid var(--gzs-teal)}
.gzs-repo__body h4:first-child{margin-top:0}
.gzs-repo__body p{font-size:12.5px;line-height:1.85;color:var(--gzs-body);margin:0 0 11px}
.gzs-repo__frame{width:100%;height:520px;border:0;display:block;background:#fff}

/* ── 往期抽屉（顶栏「往期」打开）───────────────────────────────────────────
   「看以前做过的内容」是一次轻量的查看，不该把人从当前稿件里拽走
   （原来点「往期」是跳回首页再滚到底部，回来还得再点一次这篇文章）。
   抽屉只借右半边：底下的稿件还在，关掉就回到原处。 */
.gzs-scrim{position:absolute;inset:0;z-index:39;background:#17362a1f;
  animation:gzs-fade .14s ease-out}
@keyframes gzs-fade{from{opacity:0}to{opacity:1}}
.gzs-drawer{position:absolute;top:0;right:0;bottom:0;z-index:40;width:min(580px,94%);
  display:flex;flex-direction:column;min-height:0;background:var(--gzs-card);
  border-left:1px solid var(--gzs-line);box-shadow:-16px 0 38px #17362a1f;
  animation:gzs-slide .16s ease-out}
@keyframes gzs-slide{from{transform:translateX(14px);opacity:.6}to{transform:none;opacity:1}}
.gzs-drawer__bar{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:10px 14px;
  border-bottom:1px solid var(--gzs-line);background:var(--gzs-card2)}
.gzs-drawer__t{font-family:var(--gzs-serif);font-size:14px;font-weight:700;color:var(--gzs-ink)}
.gzs-drawer__body{flex:1;min-height:0;overflow:auto;padding:14px 16px 24px}
.gzs-drawer .gzs-repo{margin-top:0}
.gzs-drawer .gzs-repo__body{max-height:none}

/* ── 弹窗（推草稿 / 以后别的确认）──────────────────────────────────────────── */
.gzs-modal{position:absolute;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;
  padding:26px;background:#17362a33;animation:gzs-fade .14s ease-out}
/* 发布包：一稿多投。每行一个平台：规格 → 检查 → 复制。 */
.gzs-pack{padding:16px 18px 24px;display:flex;flex-direction:column;gap:12px}
.gzs-pack__note{line-height:1.7}
.gzs-pack__row{border:1px solid var(--gzs-line2);border-radius:10px;padding:11px 13px;
  background:var(--gzs-card);display:flex;flex-direction:column;gap:7px}
.gzs-pack__head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.gzs-pack__name{font-family:var(--gzs-serif);font-size:14px;font-weight:700;color:var(--gzs-ink)}
.gzs-pack__spec{font-size:10.5px;color:var(--gzs-muted)}
.gzs-pack__mode{margin-left:auto;font-size:10px;padding:1px 6px;border-radius:5px;
  background:var(--gzs-tint);color:var(--gzs-teal)}
.gzs-pack__meta{display:flex;gap:14px;font-size:11px;color:var(--gzs-muted);font-variant-numeric:tabular-nums}
.gzs-pack__warn{color:var(--gzs-warn);font-weight:650}
.gzs-pack__title{font-size:12.5px;color:var(--gzs-ink);line-height:1.6;white-space:pre-wrap}
.gzs-pack__in{width:100%;padding:5px 8px;font:inherit;font-size:11.5px;color:var(--gzs-ink);
  background:var(--gzs-card2);border:1px solid var(--gzs-line2);border-radius:7px;outline:none}
.gzs-pack__in:focus{border-color:var(--gzs-teal)}
.gzs-pack__area{width:100%;padding:6px 8px;font:inherit;font-size:11.5px;line-height:1.65;color:var(--gzs-ink);
  background:var(--gzs-card2);border:1px solid var(--gzs-line2);border-radius:7px;outline:none;resize:vertical}
.gzs-pack__area:focus{border-color:var(--gzs-teal)}
.gzs-pack__checks{margin:0;padding-left:16px;display:flex;flex-direction:column;gap:3px}
.gzs-pack__check{font-size:11px;line-height:1.6;color:var(--gzs-warn)}
.gzs-pack__acts{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.gzs-pack__foot{line-height:1.7;border-top:1px dashed var(--gzs-line2);padding-top:10px}

.gzs-modal__card{width:min(560px,96%);max-height:88%;display:flex;flex-direction:column;
  background:var(--gzs-card);border:1px solid var(--gzs-line);border-radius:12px;overflow:hidden;
  box-shadow:0 24px 60px #17362a2e;animation:gzs-rise .16s ease-out}
/* 检查抽屉：宽一档（里面是两栏 QA/提案/账本），高度也放开一点 */
.gzs-modal__card--wide{width:min(1000px,97%);height:min(88%,920px);max-height:88%}
.gzs-modal__body--flush{padding:0;overflow:auto}
@keyframes gzs-rise{from{transform:translateY(8px);opacity:.7}to{transform:none;opacity:1}}
.gzs-modal__bar{display:flex;align-items:center;gap:8px;padding:11px 14px;
  border-bottom:1px solid var(--gzs-line);background:var(--gzs-card2)}
.gzs-modal__t{font-family:var(--gzs-serif);font-size:15px;font-weight:700;color:var(--gzs-ink)}
.gzs-modal__body{flex:1;min-height:0;overflow:auto;padding:14px 16px}
.gzs-modal__foot{display:flex;gap:8px;justify-content:flex-end;padding:11px 14px;
  border-top:1px solid var(--gzs-line2);background:var(--gzs-card2)}

/* 推草稿：自查结果与错误码都要能一眼读完、能复制 */
.gzs-push__lead{font-size:12px;line-height:1.75;color:var(--gzs-body);margin:0 0 12px}
.gzs-push__lead code{font-size:11px;background:var(--gzs-paper2);border-radius:4px;padding:1px 4px}
.gzs-push__field{display:block;margin:0 0 10px}
.gzs-push__k{display:block;font-size:10.5px;font-weight:600;letter-spacing:.06em;color:var(--gzs-muted);margin:0 0 4px}
.gzs-push__row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11.5px;color:var(--gzs-body);
  padding:8px 10px;border:1px solid var(--gzs-line2);border-radius:8px;background:var(--gzs-card2);margin:0 0 10px}
.gzs-push__stat{display:flex;gap:12px;flex-wrap:wrap;font-size:11.5px;color:var(--gzs-body);margin:0 0 10px}
.gzs-push__stat b{color:var(--gzs-ink);font-variant-numeric:tabular-nums}
.gzs-push__prob{margin:0 0 8px;padding:8px 10px;border-radius:8px;
  background:var(--gzs-err-soft);color:var(--gzs-err);font-size:11.5px;line-height:1.7}
.gzs-push__ok{padding:9px 11px;border-radius:8px;background:var(--gzs-ok-soft);color:var(--gzs-ink);
  font-size:12px;line-height:1.7}
.gzs-push__ip{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:4px;
  font-family:ui-monospace,Consolas,monospace;font-size:11.5px}

/* ── 顶栏内容线切换（公众号 / 视频号）────────────────────────────────────── */
.gzs-chan{display:inline-flex;gap:1px;padding:2px;border:1px solid var(--gzs-line);
  border-radius:7px;background:var(--gzs-paper2)}
.gzs-chan__b{border:0;background:transparent;font:inherit;font-size:11.5px;color:var(--gzs-muted);
  padding:3px 10px;border-radius:5px;cursor:pointer;transition:background .14s,color .14s}
.gzs-chan__b:hover{color:var(--gzs-ink)}
.gzs-chan__b--on{background:var(--gzs-card);color:var(--gzs-teal);font-weight:600;
  box-shadow:0 1px 2px #17362a14}

/* ── 左栏原生对话（会话内嵌，由宿主渲染 conversation.content）──────────────── */
.gzs-root--split{flex-direction:row}
.gzs-root--split>.gzs-chatcol{flex:0 0 clamp(340px,32%,480px)}
.gzs-root--split>.gzs-work{flex:1 1 auto;min-width:0}
.gzs-work{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}
.gzs-chatcol{flex:0 0 clamp(340px, 32%, 480px);display:flex;flex-direction:column;min-height:0;
  background:var(--gzs-card);border-right:1px solid var(--gzs-line);overflow:hidden}
/* 对话容器自己也要能收：宿主那份 conversation 是 flex 子项，父级不给 min-height:0 它就会把列顶爆 */
.gzs-chatdock{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.gzs-chatbody{flex:1 1 auto;min-height:0;display:grid;grid-template-rows:minmax(0,1fr);overflow:hidden}
/* 用 grid 而不是 flex：宿主给的槽位包一层 display:contents 的 div，
   flex 的 > * 选择器打不到真正的对话根节点，结果是对话只按内容高度排版、
   下面留一大片空白（输入框浮在中间）。grid 的行高直接把那个孙节点撑满。 */
.gzs-chatnote{margin:auto;padding:22px 20px;font-size:11.5px;line-height:1.8;color:var(--gzs-muted);text-align:center;max-width:280px}
.gzs-chatcol__bar{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:6px 8px 6px 10px;
  border-bottom:1px solid var(--gzs-line2);background:var(--gzs-card2)}
.gzs-chatcol__t{font-size:10.5px;font-weight:700;letter-spacing:.04em;color:var(--gzs-teal)}
.gzs-chatcol__s{flex:1;min-width:0;font-size:10px;color:var(--gzs-faint);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gzs-chatcol__x{flex:0 0 auto;min-width:20px;height:20px;padding:0 5px;border:1px solid var(--gzs-line);border-radius:5px;
  background:var(--gzs-card);color:var(--gzs-muted);font:inherit;font-size:11px;line-height:1;cursor:pointer}
.gzs-chatcol__x:hover{color:var(--gzs-teal);border-color:var(--gzs-teal)}
.gzs-chatcol__ctx{flex:0 1 auto;max-width:42%;font-size:10px;color:var(--gzs-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gzs-chatrun{flex:0 0 auto;display:inline-flex;align-items:center;gap:4px;font-size:10px;color:var(--gzs-ok,#2f8f5b);white-space:nowrap}
.gzs-chatdot{width:5px;height:5px;border-radius:50%;background:var(--gzs-ok,#2f8f5b);
  animation:gzsChatPulse 1.4s ease-in-out infinite}
@keyframes gzsChatPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.7)}}
.gzs-chattoggle{flex:0 0 auto;height:24px;padding:0 9px;border:1px solid var(--gzs-line);border-radius:6px;
  background:var(--gzs-card2);color:var(--gzs-muted);font:inherit;font-size:11px;cursor:pointer;
  display:inline-flex;align-items:center;gap:4px}
.gzs-chattoggle:hover{color:var(--gzs-teal);border-color:var(--gzs-teal)}
.gzs-chattoggle.is-on{color:var(--gzs-teal);background:var(--gzs-tint);border-color:var(--gzs-teal)}

/* ── 主区容器（工作台在里面；对话列由工作台自己排）────────────────────────── */
.gzs-main{display:flex;flex-direction:column;height:100%;min-height:0}
.gzs-main__body{flex:1;min-height:0;display:flex}

/* ── 视频号看板（只读）───────────────────────────────────────────────────── */
.gzs-vboard{display:flex;flex-direction:column;min-height:0;flex:1;overflow:auto;padding:18px 22px 40px}
.gzs-vhead{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap;padding-bottom:10px;
  border-bottom:1px solid var(--gzs-line2)}
.gzs-vtitle{font-family:var(--gzs-serif);font-size:20px;font-weight:600;color:var(--gzs-ink)}
.gzs-vnote{font-size:10.5px;color:var(--gzs-faint)}
.gzs-vnote--line{padding:7px 2px 0;color:var(--gzs-muted)}
/* 左列表 + 右详情：原来列表铺满整屏、右边一片空白，看着像坏了。
   现在右边常驻一块说明（没选期时给八步缺口与生成入口），选了期就换成正文。 */
.gzs-vsplit{display:grid;grid-template-columns:minmax(280px,0.95fr) minmax(0,1.05fr);
  gap:16px;align-items:start;margin-top:12px;flex:1;min-height:0}
.gzs-vlist{min-width:0;display:flex;flex-direction:column;gap:7px}
.gzs-vside{min-width:0;display:flex;flex-direction:column;gap:10px}
.gzs-vside .gzs-vdetail{margin-top:0}
@media (max-width:1040px){.gzs-vsplit{grid-template-columns:1fr}}
.gzs-vempty{display:flex;flex-direction:column;gap:7px;align-items:flex-start;
  padding:26px 20px;margin-top:14px;border:1px dashed var(--gzs-line);border-radius:10px;
  background:var(--gzs-card)}
.gzs-vlist .gzs-vempty{margin-top:0}
.gzs-vempty--error{border-style:solid;border-color:var(--gzs-err-line);background:var(--gzs-err-soft)}
.gzs-vempty--start{border-color:var(--gzs-warn-line);background:var(--gzs-warn-soft)}
.gzs-vempty b{font-size:13px;color:var(--gzs-ink)}
.gzs-vempty p{margin:0;font-size:12px;line-height:1.7;color:var(--gzs-muted)}
.gzs-vempty__actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:5px}
.gzs-vempty__steps{display:flex;gap:5px;flex-wrap:wrap;margin-top:4px}
.gzs-vempty__steps span{font-size:10.5px;color:var(--gzs-muted);border:1px solid var(--gzs-line);border-radius:999px;padding:2px 7px;background:var(--gzs-card)}
.gzs-vrows{display:flex;flex-direction:column;gap:7px;margin-top:12px}
.gzs-vrow{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;gap:12px;align-items:center;
  padding:11px 14px;border:1px solid var(--gzs-line2);border-radius:10px;background:var(--gzs-card);
  font:inherit;color:inherit;text-align:left;cursor:pointer;transition:border-color .14s,background .14s}
.gzs-vrow:hover{border-color:var(--gzs-teal);background:var(--gzs-card2)}
.gzs-vrow--on{border-color:var(--gzs-teal);background:var(--gzs-tint2)}
.gzs-vrow__id{font-family:var(--gzs-mono,ui-monospace);font-size:12px;font-weight:700;
  color:var(--gzs-ink);letter-spacing:.02em}
/* 8 个小方块 = 盘上到底有没有这件；有料实心，缺件空心 */
.gzs-vsteps{display:flex;gap:4px;align-items:center;flex-wrap:wrap}
.gzs-vsteps i{width:18px;height:7px;border-radius:2px;background:var(--gzs-line2);
  border:1px solid var(--gzs-line);font-style:normal}
.gzs-vsteps i.on{background:var(--gzs-teal);border-color:var(--gzs-teal)}
.gzs-vrow__st{font-size:11px;color:var(--gzs-muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.gzs-vrow__open{font-size:11px;color:var(--gzs-teal);font-weight:600;white-space:nowrap}

/* 右栏常驻说明 */
.gzs-vaside{display:flex;flex-direction:column;gap:10px}
.gzs-vaside__card{border:1px solid var(--gzs-line);border-radius:10px;background:var(--gzs-card);
  padding:13px 15px 15px}
.gzs-vaside__k{font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;
  color:var(--gzs-faint)}
.gzs-vaside__v{font-size:12.5px;line-height:1.7;color:var(--gzs-body);margin-top:5px}
.gzs-vaside__stats{display:flex;gap:14px;flex-wrap:wrap;margin-top:9px;font-size:11.5px;color:var(--gzs-muted)}
.gzs-vaside__stats b{font-family:var(--gzs-serif);font-size:15px;color:var(--gzs-ink);margin-right:2px}
.gzs-vaside__p{margin:7px 0 0;font-size:11.5px;line-height:1.75;color:var(--gzs-muted)}
.gzs-vaside__acts{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}
.gzs-vaside__ok{font-size:12px;line-height:1.7;color:var(--gzs-ok);margin-top:8px}
/* 八步缺口：一根细条就是「已齐 / 总期数」，数字在右 */
.gzs-vgap{display:flex;flex-direction:column;gap:6px;margin-top:9px}
.gzs-vgap__row{display:grid;grid-template-columns:64px minmax(0,1fr) 38px;gap:8px;align-items:center}
.gzs-vgap__name{font-size:11.5px;color:var(--gzs-body);white-space:nowrap}
.gzs-vgap__bar{height:6px;border-radius:999px;background:var(--gzs-line2);overflow:hidden}
.gzs-vgap__bar i{display:block;height:100%;border-radius:999px;
  background:linear-gradient(90deg,var(--gzs-teal),var(--gzs-cyan))}
.gzs-vgap__n{font-size:10.5px;color:var(--gzs-faint);text-align:right;font-variant-numeric:tabular-nums}
.gzs-vdetail{margin-top:12px;border:1px solid var(--gzs-line);border-radius:10px;
  background:var(--gzs-card);overflow:hidden}
.gzs-vdetail__h{display:flex;align-items:center;gap:9px;padding:10px 13px;
  border-bottom:1px solid var(--gzs-line2);background:var(--gzs-card2)}
.gzs-vdetail__id{font-family:var(--gzs-mono,ui-monospace);font-size:13px;font-weight:700;color:var(--gzs-ink)}
.gzs-vtabs{display:flex;gap:2px;padding:8px 10px 0;border-bottom:1px solid var(--gzs-line2)}
.gzs-vtab{display:flex;align-items:center;gap:5px;padding:6px 11px;border:0;border-bottom:2px solid transparent;
  background:transparent;font:inherit;font-size:12px;color:var(--gzs-muted);cursor:pointer}
.gzs-vtab:hover{color:var(--gzs-ink)}
.gzs-vtab--on{color:var(--gzs-teal);border-bottom-color:var(--gzs-teal);font-weight:600}
.gzs-vtab__n{font-size:9.5px;color:var(--gzs-faint);background:var(--gzs-paper2);
  border-radius:999px;padding:0 5px;line-height:14px}
.gzs-vdoc{max-height:520px;overflow:auto;padding:14px 18px 22px}
.gzs-vdoc h4{font-family:var(--gzs-serif);font-size:13.5px;color:var(--gzs-ink);
  margin:16px 0 7px;padding-left:9px;border-left:3px solid var(--gzs-teal)}
.gzs-vdoc h4:first-child{margin-top:0}
.gzs-vdoc p{font-size:12.5px;line-height:1.9;color:var(--gzs-body);margin:0 0 11px;white-space:pre-wrap}
.gzs-vtable{max-height:520px;overflow:auto;font-size:12px}
.gzs-vtable__h,.gzs-vtable__r{display:grid;grid-template-columns:52px 92px 1.2fr 1.6fr;gap:10px;
  padding:7px 14px;align-items:start}
.gzs-vtable__h{position:sticky;top:0;background:var(--gzs-card2);color:var(--gzs-muted);
  font-size:10px;letter-spacing:.08em;text-transform:uppercase;border-bottom:1px solid var(--gzs-line2)}
.gzs-vtable__r{border-bottom:1px solid var(--gzs-line2);color:var(--gzs-body);line-height:1.7}
.gzs-vtable__r:last-child{border-bottom:0}
.gzs-vtable__r .w{white-space:pre-wrap}
.gzs-vsub{max-height:520px;overflow:auto;padding:6px 0}
.gzs-vsub__r{display:grid;grid-template-columns:170px 1fr;gap:12px;padding:6px 14px;font-size:12px;
  border-bottom:1px solid var(--gzs-line2);line-height:1.7}
.gzs-vsub__r:last-child{border-bottom:0}
.gzs-vsub__r .t{color:var(--gzs-faint);font-size:10.5px}
.gzs-vsub__r .x{color:var(--gzs-body);white-space:pre-wrap}

/* ── 视频期「成片」页：播放器 + 封面 + 分镜缩略图 + 发布包 ──────────────────── */
.gzs-vplayer{display:flex;flex-direction:column;gap:11px;padding:12px 14px 20px;min-width:0}
/* 黑底 + 圆角：黑边是视频自己的，不是面板的；圆角让它看起来是「播放器」而不是一块白 */
.gzs-vvideo{width:100%;max-height:400px;display:block;background:#0d1a14;
  border-radius:9px;border:1px solid var(--gzs-line)}
.gzs-vplayer__meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;
  font-size:11px;color:var(--gzs-muted)}
.gzs-vplayer__meta .gzs-mono{max-width:34ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gzs-vcover{width:100%;max-height:240px;object-fit:cover;border-radius:9px;
  border:1px solid var(--gzs-line);background:var(--gzs-paper2)}
.gzs-vthumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:6px}
.gzs-vthumbs img{width:100%;height:66px;object-fit:cover;border-radius:6px;
  border:1px solid var(--gzs-line2);background:var(--gzs-paper2)}
/* 发布包：不是「一键发布」，是「拿得走」——所以给的是复制，不是上传按钮 */
.gzs-vpack{display:flex;flex-direction:column;gap:8px;padding:11px 13px;
  border:1px solid var(--gzs-line2);border-radius:10px;background:var(--gzs-card2)}
.gzs-vpack .gzs-push__field{margin:0}
.gzs-vpack .gzs-hint{margin:0}

/* ── 首启向导：空库时最该回答的是「三步怎么开始」──────────────────────────── */
.gzs-firstrun{margin:14px 0 0;padding:14px 16px;border:1px solid var(--gzs-ok-line);border-radius:12px;
  background:linear-gradient(180deg,var(--gzs-card) 0%,var(--gzs-card2) 100%)}
.gzs-firstrun__h{font-family:var(--gzs-serif);font-size:15px;font-weight:700;color:var(--gzs-ink);margin-bottom:10px}
.gzs-firstrun__steps{display:flex;flex-direction:column;gap:8px}
.gzs-firstrun__step{display:flex;align-items:center;gap:11px;padding:9px 11px;border:1px solid var(--gzs-line2);
  border-radius:9px;background:var(--gzs-card)}
.gzs-firstrun__no{flex:0 0 auto;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;
  justify-content:center;background:var(--gzs-tint);color:var(--gzs-teal);font-size:11px;font-weight:700}
.gzs-firstrun__body{flex:1;min-width:0}
.gzs-firstrun__t{font-size:12.5px;font-weight:650;color:var(--gzs-ink)}
.gzs-firstrun__d{font-size:11px;line-height:1.6;color:var(--gzs-muted);margin-top:2px}

/* ── 新建表单 ───────────────────────────────────────────────────────────── */
.gzs-formwrap{max-width:660px;margin:0 auto}
.gzs-formcard{border:1px solid var(--gzs-line);border-radius:8px;background:var(--gzs-card);
  padding:22px 24px 20px;box-shadow:0 6px 20px #17362a14}
.gzs-formacts{display:flex;gap:9px;margin-top:20px;padding-top:16px;border-top:1px solid var(--gzs-line2)}

/* ── 治理视图 ───────────────────────────────────────────────────────────── */
.gzs-gov{padding:24px 28px 40px;display:flex;flex-direction:column;gap:16px}
.gzs-gov__grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:16px;align-items:start}
.gzs-gov__col{display:flex;flex-direction:column;gap:16px;min-width:0}
@media (max-width:900px){.gzs-gov__grid{grid-template-columns:1fr}}
.gzs-panel{border:1px solid var(--gzs-line);border-radius:8px;background:var(--gzs-card);overflow:hidden}
.gzs-panel__head{display:flex;align-items:center;gap:9px;padding:11px 14px;
  border-bottom:1px solid var(--gzs-line2);background:var(--gzs-card2);
  font-family:var(--gzs-serif);font-size:12.5px;font-weight:700;color:var(--gzs-ink)}
.gzs-panel__body{padding:13px 14px}
.gzs-gov__empty{padding:10px 2px;font-size:11.5px;line-height:1.7;color:var(--gzs-muted)}

/* 去 AI 味：句子级对照。原文一行，改后一行，勾选行整行变色，
   不勾的行保持「纸」色——一眼能看出改了哪几句，而不是满屏彩色。
   不再按段分组（原来的 gzs-deai__sec）：模板稿常有「三段同一句」，
   按段列会把同一句列三遍，把节奏结论挤出屏幕。重复句收成一行并标注出现在哪几段。 */
.gzs-deai__row{display:flex;gap:8px;align-items:flex-start;padding:7px 8px;border:1px solid transparent;
  border-radius:6px;cursor:pointer;transition:background .12s,border-color .12s}
.gzs-deai__row:hover{background:var(--gzs-card2);border-color:var(--gzs-line2)}
.gzs-deai__row--on{background:var(--gzs-tint2);border-color:var(--gzs-ok-line)}
.gzs-deai__row--manual{cursor:default;opacity:.86}
.gzs-deai__mark{flex:0 0 16px;height:16px;margin-top:2px;border:1px solid var(--gzs-line);
  border-radius:3px;font-size:10px;line-height:14px;text-align:center;color:var(--gzs-ok);background:var(--gzs-card)}
.gzs-deai__row--on .gzs-deai__mark{background:var(--gzs-ok);color:#fff;border-color:var(--gzs-ok)}
.gzs-deai__row--manual .gzs-deai__mark{border-style:dashed;font-size:9px;color:var(--gzs-faint);background:transparent}
.gzs-deai__before{font-size:12px;line-height:1.65;color:var(--gzs-body)}
.gzs-deai__at{font-size:9.5px;color:var(--gzs-muted);border:1px solid var(--gzs-line2);
  border-radius:3px;padding:0 4px;margin-right:5px;white-space:nowrap}
.gzs-deai__after{font-size:12px;line-height:1.65;color:var(--gzs-ok);margin-top:3px;
  border-left:2px solid var(--gzs-ok-line);padding-left:7px;margin-left:-8px}
.gzs-deai__why{font-size:10.5px;line-height:1.62;color:var(--gzs-muted);margin-top:4px;
  display:flex;flex-wrap:wrap;gap:0 5px;align-items:baseline}
.gzs-deai__words{color:var(--gzs-warn);font-weight:650}
.gzs-deai__kind{color:var(--gzs-faint);border:1px solid var(--gzs-line2);border-radius:3px;
  padding:0 4px;font-size:9.5px;white-space:nowrap}
.gzs-deai__fix{color:var(--gzs-body)}
.gzs-deai__lvl{flex:0 0 auto;font-size:9.5px;padding:1px 5px;border-radius:3px;margin-top:2px;
  border:1px solid var(--gzs-line2);color:var(--gzs-muted);white-space:nowrap}
.gzs-deai__lvl--high{border-color:var(--gzs-err-line);color:var(--gzs-err);background:var(--gzs-err-soft)}
.gzs-deai__lvl--mid{border-color:var(--gzs-warn-line);color:var(--gzs-warn);background:var(--gzs-warn-soft)}
.gzs-deai__acts{display:flex;align-items:center;gap:10px;margin-top:12px;padding-top:11px;
  border-top:1px solid var(--gzs-line2);flex-wrap:wrap}

/* 节奏：整篇的形状问题。用浅底把它和「逐句」那块分开——两层判据不是一回事。 */
.gzs-deai__rhythm{margin-top:13px;padding:10px 11px;background:var(--gzs-card2);
  border:1px solid var(--gzs-line2);border-radius:6px}
.gzs-deai__rhythmhead{display:flex;align-items:center;gap:8px;margin-bottom:8px;
  font-family:var(--gzs-serif);font-size:11.5px;font-weight:700;color:var(--gzs-ink)}
.gzs-deai__rhythmrow{padding:6px 0;border-top:1px dashed var(--gzs-line2)}
.gzs-deai__rhythmrow:first-of-type{border-top:none;padding-top:2px}
.gzs-deai__rhythmt{font-size:11.5px;line-height:1.6;color:var(--gzs-body);font-weight:600}
.gzs-deai__rhythmd{font-size:10.5px;line-height:1.6;color:var(--gzs-muted);margin-top:2px}

/* 反馈：一行一条，左边一个小点表示"待带上/已带上"。 */
.gzs-fb{display:flex;align-items:flex-start;gap:6px;padding:5px 0;font-size:11.5px;line-height:1.6;color:var(--gzs-body)}
.gzs-fb__dot{flex:0 0 5px;height:5px;border-radius:50%;background:var(--gzs-warn);margin-top:6px}
.gzs-fb--used .gzs-fb__dot{background:var(--gzs-ok-line)}
.gzs-fb--used{color:var(--gzs-muted)}
.gzs-fb__txt{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;
  -webkit-line-clamp:2;-webkit-box-orient:vertical}
.gzs-fb__tag{flex:0 0 auto;font-size:9.5px;color:var(--gzs-muted);border:1px solid var(--gzs-line2);
  border-radius:3px;padding:0 4px;margin-top:1px;white-space:nowrap}
.gzs-fb--used .gzs-fb__tag{color:var(--gzs-faint)}

/* 05/06 清单逐项确认。整行可点（小方块太小，手指点不准），
   勾上之后整行变浅绿——一眼能看出还差哪几行没勾。 */
.gzs-rev{border-top:1px solid var(--gzs-line2);padding:9px 0 3px}
.gzs-rev:first-of-type{border-top:none;padding-top:2px}
.gzs-rev__head{display:flex;align-items:center;gap:7px;margin-bottom:3px}
.gzs-rev__no{font-family:var(--gzs-serif);font-size:10px;font-weight:700;
  color:var(--gzs-warn);letter-spacing:.04em}
.gzs-rev__label{font-family:var(--gzs-serif);font-size:12px;font-weight:700;color:var(--gzs-ink)}
.gzs-rev__about{font-size:10.5px;line-height:1.6;color:var(--gzs-muted);margin-bottom:6px}
.gzs-rev__item{display:flex;gap:7px;align-items:flex-start;padding:4px 6px;border-radius:5px;
  cursor:pointer;border:1px solid transparent;transition:background .12s}
.gzs-rev__item:hover{background:var(--gzs-card2);border-color:var(--gzs-line2)}
.gzs-rev__item--on{background:var(--gzs-tint2);border-color:var(--gzs-ok-line)}
.gzs-rev__mark{flex:0 0 14px;height:14px;margin-top:1px;border:1px solid var(--gzs-line);
  border-radius:3px;font-size:9.5px;line-height:12px;text-align:center;color:var(--gzs-ok);background:var(--gzs-card)}
.gzs-rev__item--on .gzs-rev__mark{background:var(--gzs-ok);color:#fff;border-color:var(--gzs-ok)}
.gzs-rev__text{flex:1 1 auto;min-width:0;font-size:11px;line-height:1.62;color:var(--gzs-body)}
.gzs-rev__item--on .gzs-rev__text{color:#2b5c44}

/* 出图前确认：贴在按钮下面的一张卡。不用 modal — 弹窗会挡住 prompt，
   而人在确认时最想再看一眼的恰恰是 prompt。 */
.gzs-confirm{margin-top:10px;padding:10px 11px;border:1px solid var(--gzs-warn-line);border-radius:7px;
  background:var(--gzs-warn-soft)}
.gzs-confirm__t{font-family:var(--gzs-serif);font-size:12px;font-weight:700;
  color:var(--gzs-warn);margin-bottom:6px}
.gzs-confirm__b{font-size:11px;line-height:1.7;color:var(--gzs-body)}
.gzs-confirm__hd{font-size:10.5px;color:var(--gzs-muted);margin:3px 0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gzs-confirm__acts{display:flex;gap:8px;margin-top:9px}

/* ── 加载态 ─────────────────────────────────────────────────────────────── */
.gzs-skel{display:flex;flex-direction:column;gap:14px;padding:4px 0}
.gzs-skel__row{height:14px;border-radius:5px;
  background:linear-gradient(90deg,var(--gzs-line2) 25%,var(--gzs-card2) 37%,var(--gzs-line2) 63%);
  background-size:400% 100%;animation:gzs-shimmer 1.3s ease-in-out infinite}
.gzs-skel__row--wide{height:120px;border-radius:8px}
@keyframes gzs-shimmer{0%{background-position:100% 0}100%{background-position:0 0}}
@media (prefers-reduced-motion:reduce){.gzs-skel__row{animation:none}}

/* ── 提示条 ─────────────────────────────────────────────────────────────── */
.gzs-toast{position:fixed;left:50%;bottom:30px;transform:translateX(-50%);z-index:99;
  padding:9px 16px;border-radius:8px;background:#1d3a2c;color:#f1f7f2;font-size:12px;
  box-shadow:0 10px 28px #17362a3d;max-width:70vw;line-height:1.5}
`;

    /** 只在第一次挂载时插 <style>（多次热载不重复插）。 */
    function injectStylesheet() {
      try {
        if (typeof document === "undefined" || !document.head) return;
        if (document.getElementById("gzs-style")) return;
        const style = document.createElement("style");
        style.id = "gzs-style";
        style.setAttribute("data-plugin", "dsh-plugin-gzh-studio");
        style.textContent = CSS;
        document.head.appendChild(style);
      } catch {
        // 样式注入失败不该让面板白屏：没有 CSS 也还能点
      }
    }

    // ── 基础组件 ──────────────────────────────────────────────────────────────
    function Btn({ kind = "normal", small, on, disabled, title, children }) {
      const cls = ["gzs-btn"];
      if (kind === "primary") cls.push("gzs-btn--primary");
      if (kind === "ghost") cls.push("gzs-btn--ghost");
      if (small) cls.push("gzs-btn--sm");
      return h("button", { className: cls.join(" "), onClick: on, disabled, title: title ?? "" }, children);
    }

    function Badge({ level, children }) {
      const map = { error: "err", err: "err", warn: "warn", info: "info", ok: "ok", mute: "mute" };
      return h("span", { className: `gzs-badge gzs-badge--${map[level] ?? "mute"}` }, children);
    }

    function Field({ label, children }) {
      return h("div", { className: "gzs-field" }, label ? h("label", { className: "gzs-label" }, label) : null, children);
    }

    /**
     * 流水线状态词 → 人话。
     *
     * 状态词来自 `PIPELINE.md` §4，**不得增删**（服务端 `lib/pipeline.js` 也守着这条）。
     * 这里只做「把机器词翻成一眼能懂的四个字」，原文放在 title 里，
     * 保证面板上看的是人话、而拿得到的东西仍是原词。
     */
    const STATUS_TEXT = {
      ready: { text: "可推草稿", level: "ok" },
      "needs-published-inventory": { text: "缺人物清单", level: "warn" },
      "needs-research": { text: "缺证据台账", level: "err" },
      "needs-browser-audit": { text: "待重新核验", level: "warn" },
      "needs-user-approval": { text: "待你确认", level: "warn" },
      "needs-video-cover": { text: "缺合规封面", level: "warn" },
      "needs-draft-approval": { text: "待授权推草稿", level: "warn" },
      "needs-review": { text: "需人看一眼", level: "warn" },
      "dry-run": { text: "仅模拟回执", level: "warn" },
    };

    /**
     * 步号 → 人话。
     *
     * 界面上不该出现 `07-deai` 这种字符串——那是给开发看的路径，不是给人看的进度。
     * 原文（步号 + skill 名）留在 title 里，排错时仍能拿到。
     */
    const STEP_TEXT = {
      "01-kickoff": "定题",
      "02-evidence": "查事实",
      "03-angles": "挑方案",
      "04-write": "写正文",
      "05-editor-review": "编辑审",
      "06-reader-review": "读者审",
      "07-deai": "润色去 AI 味",
      "08-images": "配图",
      "09-layout": "排版",
      "10-quality-gate": "排版校验",
      "11-digest-draft": "推草稿",
      "12-retro": "复盘",
      "05-produce": "做封面",
      "00-pipeline": "定位状态",
    };

    /** 把 `07-deai` 翻成「润色去 AI 味」；认不出来就退回原文（不假装懂）。 */
    const stepText = (step) => STEP_TEXT[String(step ?? "")] ?? String(step ?? "—");

    /** 门禁行的小图标：过 / 卡住 / 判据不可用 / 本线不适用。文字符号，不引图标字体。 */
    const GATE_MARK = { ok: "✓", fail: "✕", stale: "!", unknown: "?", skip: "–" };

    /** 节点条的四种状态：已完成 / 进行中 / 未做 / 无从判断。 */
    const NODE_TEXT = { done: "已完成", todo: "未完成", doing: "进行中", skip: "无判据", unknown: "查不出" };

    /**
     * 节点条：13 步流水线走到哪了。
     *
     * 借的是同事那个「编辑部观测台」的做法——一排 chips，`✓初稿 ✓审稿` 一眼扫完。
     * 只有一个状态词回答不了「前面过了几步」；而十个门禁是判断题，不是进度条。
     *
     * `panel` 状态的节点（初稿）由这里按**本地正文**判：正文有没有内容是面板自己知道的事，
     * 让服务端再读一遍盘反而判不准。
     */
    function NodeBar({ nodes, hasBody, onPick }) {
      const list = Array.isArray(nodes) ? nodes : [];
      if (!list.length) return null;
      const stateOf = (node) => {
        if (node.state === "panel") return hasBody ? "done" : "todo";
        return node.state;
      };
      const done = list.filter((n) => stateOf(n) === "done").length;
      const skipped = list.filter((n) => stateOf(n) === "skip");
      return h("div", { className: "gzs-nodes" },
        h("div", { className: "gzs-nodes__top" },
          h("span", { className: "gzs-eyebrow" }, "节点"),
          h("span", { className: "gzs-hint" }, `${done}/${list.length} 步有据可查`)),
        h("div", { className: "gzs-nodes__bar" },
          list.map((node) => {
            const state = stateOf(node);
            return h("span", {
              key: node.id,
              className: `gzs-node gzs-node--${state}`,
              title: `${node.id} ${node.label}${node.note ? `：${node.note}` : ""}`,
              onClick: () => onPick?.(node),
            },
              h("span", { className: "gzs-node__mark" }, state === "done" ? "✓" : state === "todo" ? "○" : state === "doing" ? "◐" : "–"),
              h("span", { className: "gzs-node__label" }, node.label));
          })),
        skipped.length
          ? h("div", { className: "gzs-nodes__skip" },
            `无机器判据的节点：${skipped.map((n) => n.label).join(" / ")}`)
          : null);
    }

    /**
     * 时间线：文件什么时候被改过。
     *
     * 与账本分工：账本记「谁为什么改」，时间线记「什么时候动过」。
     * 不另建事件表——文件系统已经记着了，再写一份只会两处不一致。
     */
    function Timeline({ rows }) {
      const list = Array.isArray(rows) ? rows : [];
      if (!list.length) return h("div", { className: "gzs-hint" }, "交付目录里还没有可读的文件改动记录。");
      return h("div", { className: "gzs-tl" },
        list.map((row, index) => h("div", { key: `${row.at}-${index}`, className: "gzs-tl__row", title: row.path ?? "" },
          h("span", { className: "gzs-tl__at" }, stampText(row.at)),
          h("span", { className: "gzs-tl__label" }, row.label),
          h("span", { className: "gzs-tl__note" }, row.note ?? ""))));
    }

    /**
     * 事实核对：把「事实层」从「流程层」里分出来。
     *
     * 混在一张表里会让人误以为「审稿过了 = 事实对」。审稿只说明有人读过，
     * 台账才说明每条材料有出处。缺哪一样，这里一眼看到。
     */
    function Facts({ rows }) {
      const list = Array.isArray(rows) ? rows : [];
      if (!list.length) return null;
      return h("div", { className: "gzs-facts" },
        list.map((row) => h("span", {
          key: row.key,
          className: `gzs-fact gzs-fact--${row.state}`,
          title: row.detail ?? "",
        },
          h("span", { className: "gzs-fact__k" }, row.label),
          h("span", { className: "gzs-fact__v" }, row.state === "none" ? "无" : row.state === "ok" ? "有" : row.state === "unknown" ? "查不出" : row.state)),
        ));
    }

    /**
     * 流水线区块：卡在哪一步、下一步做什么、十道门的证据。
     *
     * 放在右栏最上面，因为「先判状态、再看内容」——顺序反了会让人先改错地方。
     * 未绑定时不假装有状态，只给一个绑定期号的入口。
     */
    function PipeBlock({
      pipeline: pipe, busy, onRefresh, onBind, root, hasBody, onOpenObs,
      // 未绑定时的粗略进度用这几样：标题、有没有封面、还缺几张配图、导出过没有
      articleTitle, hasCover, imageGaps, roughProgress,
    }) {
      const [adv, setAdv] = React.useState(false);
      const [episode, setEpisode] = React.useState(pipe?.episodeId ?? "");
      const [dir, setDir] = React.useState(pipe?.root ?? root ?? "");
      React.useEffect(() => { setEpisode(pipe?.episodeId ?? ""); setDir(pipe?.root ?? root ?? ""); }, [pipe?.episodeId, pipe?.root, root]);

      const head = h("div", { className: "gzs-sect__head", style: { marginBottom: 7 } },
        h("span", null, "流水线"),
        h("div", { className: "gzs-spacer" }),
        pipe?.bound
          ? h(Btn, { small: true, kind: "ghost", on: onRefresh, disabled: busy }, busy ? "查…" : "刷新")
          : null);

      /**
       * 没绑期号时给**粗略进度**，不再只是一张表单。
       *
       * 小白不会懂「期号」和「根目录」——他写一篇文章不需要先填绝对路径。
       * 所以这里按**内容完整度**推五档：有标题 → 有正文 → 有封面 → 配图齐 → 导出过。
       * 这不是流水线的「第几步」，所以**明确标注「粗略估计」**，别让人误以为是精确判定。
       * 绑期号降级成「进阶：接上产线」的折叠项，愿意用的人再用。
       */
      if (!pipe?.bound) {
        const rough = roughProgress ?? {};
        const steps = [
          { key: "title", label: "有标题", done: Boolean(String(articleTitle ?? "").trim()) },
          { key: "body", label: "有正文", done: Boolean(hasBody) },
          { key: "cover", label: "有封面", done: Boolean(hasCover) },
          { key: "images", label: "配图齐", done: Boolean(hasCover) && (imageGaps ?? 1) === 0 },
          { key: "export", label: "导出过", done: Boolean(rough.exported) },
        ];
        const doneCount = steps.filter((x) => x.done).length;
        return h("div", { className: "gzs-sect gzs-pipe", "data-pipe": "loose" }, head,
          h("div", { className: "gzs-pipe__status gzs-pipe__status--ok" },
            h("span", { className: "gzs-dot gzs-dot--done" }),
            h("span", { className: "gzs-pipe__word" }, doneCount === steps.length ? "可以发了" : `写到第 ${doneCount + 1} 档`),
            h("span", { className: "gzs-pipe__ep", title: "没接产线，按内容完整度估的" }, "粗略估计")),
          h("div", { className: "gzs-steps" },
            steps.map((x, i) => h("div", { key: x.key, className: `gzs-step ${x.done ? "gzs-step--done" : ""}` },
              h("span", { className: "gzs-step__mark" }, x.done ? "✓" : String(i + 1)),
              h("span", null, x.label)))),
          h("div", { className: "gzs-hint", style: { marginTop: 8 } },
            `完成 ${doneCount}/${steps.length} 档。想看精确的「卡在哪一道门」，可以接上产线（进阶，需要填期号）。`),
          h("div", { className: "gzs-row", style: { marginTop: 6 } },
            h("div", { className: "gzs-spacer" }),
            h(Btn, { small: true, kind: "ghost", on: () => setAdv((v) => !v) }, adv ? "收起进阶" : "接上产线")),
          adv
            ? h("div", { style: { marginTop: 8 } },
              h(Field, { label: "期号（如 historical-person-027）" },
                h(TextInput, { value: episode, placeholder: "historical-person-027", onCommit: setEpisode })),
              h(Field, { label: "流水线根目录" },
                h(TextInput, { value: dir, placeholder: "D:/work/历史内容生产", onCommit: setDir })),
              h("div", { className: "gzs-row", style: { marginTop: 4 } },
                h(Btn, { kind: "primary", small: true, on: () => onBind({ episodeId: episode.trim(), root: dir.trim() }), disabled: busy || !episode.trim() || !dir.trim() }, "绑定")))
            : null);
      }

      const label = STATUS_TEXT[pipe.status] ?? { text: pipe.status || "状态未知", level: "warn" };
      const tone = label.level === "ok" ? "ok" : label.level === "err" ? "err" : "warn";

      return h("div", { className: "gzs-sect gzs-pipe", "data-pipe": "bound" },
        head,
        h("div", { className: `gzs-pipe__status gzs-pipe__status--${tone}` },
          h("span", { className: `gzs-dot gzs-dot--${tone === "ok" ? "done" : tone === "err" ? "busy" : "miss"}` }),
          h("span", { className: "gzs-pipe__word", title: pipe.status ?? "" }, label.text),
          h("span", { className: "gzs-pipe__ep" }, `${pipe.episodeId}${pipe.episodeNo ? ` · 第 ${pipe.episodeNo} 期` : ""}`)),
        h("div", { className: "gzs-pipe__hint" }, pipe.hint || "—"),
        pipe.blocking
          ? h("div", { className: "gzs-pipe__block" },
            `卡在第 ${pipe.blocking.no} 道门 · ${pipe.blocking.label}：${pipe.blocking.detail}`)
          : null,
        pipe.drift
          ? h("div", { className: "gzs-pipe__block gzs-pipe__block--warn" },
            "面板里改过正文，与绑定时记的哈希不一致 → 按规矩要重核、重新交稿。")
          : null,

        // 侧栏只放「够判断」的信息：状态词 + 卡在哪 + 下一步。
        // 节点条 / 事实核对 / 时间线都在 352px 里挤成一团（11 个节点被压成三行），
        // 移到治理视图的宽版观测台。这里只留一个进度概览和入口。
        pipe.nodes?.length
          ? h("div", { className: "gzs-pipe__mini" },
            h("span", { className: "gzs-pipe__minibar" },
              pipe.nodes.map((node) => {
                const state = node.state === "panel" ? (hasBody ? "done" : "todo") : node.state;
                return h("span", { key: node.id, className: `gzs-mini gzs-mini--${state}`, title: `${node.id} ${node.label}${node.note ? `：${node.note}` : ""}` });
              })),
            h("span", { className: "gzs-hint" },
              `${pipe.nodes.filter((n) => (n.state === "panel" ? hasBody : n.state === "done")).length}/${pipe.nodes.length} 有据`))
          : null,

        h("div", { className: "gzs-row", style: { gap: 8, marginTop: 8, flexWrap: "wrap" } },
          h("span", { className: "gzs-hint", title: pipe.step ?? "" }, `下一步：${stepText(pipe.step)}`),
          pipe.unknown ? h("span", { className: "gzs-hint", title: "判据不可用：不是没做到，是这台机器查不出" }, `· ${pipe.unknown} 项判据不可用`) : null,
          h("div", { className: "gzs-spacer" }),
          h(Btn, { small: true, kind: "ghost", on: onOpenObs }, "看观测 →")));
    }

    /**
     * 受控输入：受控 + 失焦提交。不用 onChange 每敲一下打一次接口（会把账本刷成废纸）。
     * 这是「改动必须过宿主」与「别把带内存打爆」之间的折中。
     */
    function TextInput({ value, placeholder, onCommit, rows, mark }) {
      const [draft, setDraft] = React.useState(value ?? "");
      // 外部值变了（切槽位 / 别的操作刷新）时同步回来；否则输入框会一直显示上一段的字
      React.useEffect(() => { setDraft(value ?? ""); }, [value]);
      const commit = () => { if ((draft ?? "") !== (value ?? "")) onCommit(draft); };
      // `mark` 落到 data 属性上，给「按语义取某个输入框」用（见 promptOnScreen）。
      // 按位置取（第一个 textarea）会取错——正文框排在 prompt 框前面。
      const attrs = mark ? { "data-mark": mark } : {};
      if (rows) {
        return h("textarea", {
          className: "gzs-area", rows, value: draft, placeholder: placeholder ?? "",
          onChange: (e) => setDraft(e.target.value), onBlur: commit, ...attrs,
        });
      }
      return h("input", {
        className: "gzs-input", value: draft, placeholder: placeholder ?? "",
        onChange: (e) => setDraft(e.target.value), onBlur: commit,
        onKeyDown: (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); e.target.blur?.(); } },
        ...attrs,
      });
    }

    function Toast({ text }) {
      return text ? h("div", { className: "gzs-toast" }, text) : null;
    }

    // ── 中间：手机预览 ────────────────────────────────────────────────────────
    /**
     * 手机宽度 WYSIWYG。**这就是「全屏播放」在公众号里的等价物**：
     * 不用导出、不用打开微信，改一个字当场看到手机上什么样。
     *
     * 传入的 `templates` 与 `article.template` 决定 token；图片走宿主 image 路由。
     * 点段落会选中它（右侧检查器跟着切），所以每段都套了一个透明按钮层。
     * @param {{article: object, templates: object[], selected?: string, onSelect?: Function}} props
     */
    function PhonePreview({ article, templates, selected, onSelect, onRegenerate, onPickVersion, busy }) {
      /**
       * 窄窗口等比缩小。
       *
       * 375 是真机宽度，**不能改**——改了字距、折行就都不是用户看到的样子。
       * 所以窗口不够宽时缩的是整块预览（`zoom`），不是排版本身；宁可图小一点，
       * 也不要横向裁掉右半边（裁掉的话滚动条在几千像素高的底部，根本够不着）。
       */
      const boxRef = React.useRef(null);
      const [zoom, setZoom] = React.useState(1);
      React.useEffect(() => {
        const el = boxRef.current;
        if (!el) return undefined;
        const fit = () => {
          const width = el.clientWidth;
          if (!width) return;
          const next = Math.min(1, Math.max(0.62, Number((width / (PHONE_WIDTH + 4)).toFixed(3))));
          setZoom((prev) => (Math.abs(prev - next) < 0.01 ? prev : next));
        };
        fit();
        if (typeof ResizeObserver === "undefined") return undefined;
        const observer = new ResizeObserver(fit);
        observer.observe(el);
        return () => observer.disconnect();
      }, [article]);

      if (!article) {
        return h("div", { className: "gzs-empty" }, h("div", null, "还没有选中文章"), h("div", { className: "gzs-hint" }, "左边新建一篇，或者从顶部切一篇"));
      }
      const t = templateOf(templates, article.template).tokens;
      const sections = Array.isArray(article.sections) ? article.sections : [];
      const coverVersion = currentVersion(article.cover);
      const pick = (slot) => (e) => { e?.stopPropagation?.(); onSelect?.(slot); };
      const ring = (slot) => (selected === slot ? { outline: "2px solid var(--gzs-cyan,#4a9169)", outlineOffset: "4px", borderRadius: 6 } : null);

      const paragraphStyle = {
        margin: `0 0 ${Math.max(14, Math.round((t.paraGap ?? 22) * 0.85))}px`,
        fontSize: `${Math.max(13, (t.bodySize ?? 16) - 1)}px`,
        lineHeight: t.bodyLine ?? 1.85,
        color: t.ink ?? "#1a1a1a",
        fontFamily: t.font,
        letterSpacing: `${t.letterSpacing ?? 0.2}px`,
      };

      const blocks = [];
      if (coverVersion) {
        const coverVersions = Array.isArray(article.cover?.versions) ? article.cover.versions : [];
        const nextCover = coverVersions.length > 1
          ? (coverVersions[(coverVersions.findIndex((v) => v.vid === coverVersion.vid) + 1) % coverVersions.length]?.vid ?? coverVersion.vid)
          : "";
        blocks.push(h("div", { key: "cover", className: "gzs-pimg", style: { marginBottom: 18, ...ring("cover") }, onClick: pick("cover") },
          h("img", {
            className: "gzs-thumb",
            src: imageUrl(article.id, "cover", coverVersion.vid),
            alt: "封面",
            style: { borderRadius: `${t.radius ?? 8}px`, opacity: 0.98 },
          }),
          h("div", { className: "gzs-pimg__bar" },
            h("span", { className: "gzs-pimg__v" }, coverVersion.vid),
            h("button", {
              className: "gzs-pimg__b", disabled: busy,
              onClick: (event) => { event.stopPropagation(); onRegenerate?.("cover"); },
              title: "用封面现在的 prompt 再出一版（不覆盖旧版）",
            }, busy ? "出图中…" : "重出"),
            nextCover
              ? h("button", {
                className: "gzs-pimg__b",
                onClick: (event) => { event.stopPropagation(); onPickVersion?.("cover", nextCover); },
                title: `切到 ${nextCover}`,
              }, "换版")
              : null)));
      }

      blocks.push(h("div", { key: "title", style: { marginBottom: 8 } },
        h("div", { style: { fontSize: 21, fontWeight: 700, lineHeight: 1.42, color: t.ink ?? "#111", fontFamily: t.fontTitle ?? t.font, letterSpacing: ".4px" } },
          article.title || "（还没有标题）")));

      if (article.subtitle) {
        blocks.push(h("div", { key: "sub", style: { marginBottom: 12, fontSize: 12.5, lineHeight: 1.7, color: t.sub ?? "#666" } }, article.subtitle));
      }
      if (article.summary) {
        blocks.push(h("div", {
          key: "sum",
          style: { marginBottom: 18, padding: "11px 12px", background: t.accentSoft ?? "#f4f7fd", borderRadius: `${t.radius ?? 8}px` },
        }, h("div", { style: { fontSize: 12, lineHeight: 1.75, color: t.sub ?? "#666" } }, article.summary)));
      }
      blocks.push(h("div", { key: "rule0", style: { height: 1, background: t.rule ?? "#eee", margin: "0 0 18px" } }));

      // 空段落（没小标题、没正文、没配图）在读者眼里就是不存在的一段，整段跳过。
      // 不跳的话它会在正文最末尾留一个「第 N 段还没有配图 · 点这里出图」的虚线框——
      // 那是编辑器控件，混在读者视角的预览里像是文章没写完。QA 仍然会报「第 N 段没有正文」。
      // 序号沿用**原始** index，否则中间删段会让「第 N 段」和左栏编号对不上。
      const visibleSections = sections
        .map((section, index) => ({ section, index }))
        .filter(({ section }) => (
          String(section.heading ?? "").trim()
          || paragraphsOf(section.body).length
          || currentVersion(section.image)
        ));

      visibleSections.forEach(({ section, index }, position) => {
        const slot = `sec-${section.id}`;
        const version = currentVersion(section.image);
        const head = String(section.heading ?? "").trim();
        const versions = Array.isArray(section.image?.versions) ? section.image.versions : [];
        const nextVid = versions.length > 1
          ? (versions[(versions.findIndex((v) => v.vid === version?.vid) + 1) % versions.length]?.vid ?? "")
          : "";
        // 「预览即编辑」：整段（小标题 + 正文 + 配图）是一块可点区域。
        // 以前只有图能点，点字没反应——而改字恰恰是最常做的事。
        // 选中态只加在**整段外层**：里面再套一个高亮框，预览里会出现两个框。
        const inner = [];
        if (head) {
          inner.push(h("div", {
            key: `h-${section.id}`,
            style: {
              margin: "0 0 10px",
              fontSize: `${(t.h2Size ?? 20) - 2}px`,
              fontWeight: 700,
              lineHeight: 1.5,
              color: t.ink ?? "#111",
              fontFamily: t.fontTitle ?? t.font,
              ...(t.h2Bar ? { borderLeft: `4px solid ${t.accent ?? "#1f6feb"}`, paddingLeft: 9 } : null),
            },
          }, t.h2Prefix ? h("span", { style: { color: t.accent, marginRight: 5 } }, t.h2Prefix) : null, head));
        }
        paragraphsOf(section.body).forEach((text, i) => {
          inner.push(h("p", { key: `p-${section.id}-${i}`, style: paragraphStyle }, rich(text)));
        });
        if (version) {
          inner.push(h("div", { key: `img-${section.id}`, className: "gzs-pimg", style: { margin: "4px 0 4px" } },
            h("img", {
              className: "gzs-thumb",
              src: imageUrl(article.id, slot, version.vid),
              alt: head || `配图 ${index + 1}`,
              style: { borderRadius: `${t.radius ?? 8}px` },
            }),
            h("div", { className: "gzs-pimg__bar" },
              h("span", { className: "gzs-pimg__v" }, version.vid),
              h("button", {
                className: "gzs-pimg__b", disabled: busy,
                onClick: (event) => { event.stopPropagation(); onRegenerate?.(slot); },
                title: "用这个槽位现在的 prompt 再出一版（不覆盖旧版）",
              }, busy ? "出图中…" : "重出"),
              nextVid
                ? h("button", {
                  className: "gzs-pimg__b",
                  onClick: (event) => { event.stopPropagation(); onPickVersion?.(slot, nextVid); },
                  title: `切到 ${nextVid}`,
                }, "换版")
                : null),
            section.image?.caption
              ? h("div", { style: { marginTop: 6, textAlign: "center", fontSize: 10.5, color: t.caption ?? "#999" } }, section.image.caption)
              : null));
        } else {
          inner.push(h("div", {
            key: `noimg-${section.id}`,
            style: {
              margin: "2px 0 4px", padding: "14px 10px", textAlign: "center", fontSize: 11,
              color: t.sub ?? "#888", background: t.paper ?? "#f7f8fa", borderRadius: 6,
              border: `1px dashed ${t.rule ?? "#ddd"}`, opacity: 0.9,
            },
          }, `第 ${index + 1} 段还没有配图 · 点这里去出图`));
        }
        blocks.push(h("div", {
          key: `sec-${section.id}`,
          className: `gzs-psec${selected === slot ? " gzs-psec--on" : ""}`,
          style: ring(slot) ?? null,
          title: "点一下：在右栏编辑这一段",
          onClick: pick(slot),
        }, inner));
        if (position < visibleSections.length - 1) {
          blocks.push(h("div", { key: `rule-${section.id}`, style: { height: 1, background: t.rule ?? "#eee", margin: "20px 0" } }));
        }
      });

      return h("div", { className: "gzs-phonebox", ref: boxRef },
        h("div", { className: "gzs-phone", style: zoom === 1 ? null : { zoom } },
          h("div", { className: "gzs-phonebar" }, `${PHONE_WIDTH}px · 微信正文预览`),
          h("div", { className: "gzs-paper", style: { background: t.bg ?? "#fff" } }, blocks)));
    }

    /** 取槽位的当前版本（与宿主 `pickVersion` 同口径：current 失效退回最新）。 */
    function currentVersion(image) {
      const versions = Array.isArray(image?.versions) ? image.versions : [];
      if (!versions.length) return null;
      return versions.find((v) => v.vid === image.current) ?? versions[versions.length - 1];
    }

    // ── 左栏：结构列表 ────────────────────────────────────────────────────────
    /**
     * 结构树：封面 + 每段。每行显示「段号 / 小标题 / 字数 / 图状态」——
     * 一眼看出哪段缺图、哪段还没写。点一行右侧检查器就切到那一行。
     * @param {{article: object, selected: string, onSelect: Function, onAddSection: Function}} props
     */
    function Outline({ article, selected, onSelect, onAddSection }) {
      if (!article) {
        return h("div", { className: "gzs-outline" }, h("div", { className: "gzs-hint", style: { padding: "10px 4px" } }, "还没有文章。"));
      }
      const sections = Array.isArray(article.sections) ? article.sections : [];
      const coverVersion = currentVersion(article.cover);
      const rows = [];

      rows.push(h("button", {
        key: "cover",
        className: `gzs-item ${selected === "cover" ? "gzs-item--on" : ""}`,
        onClick: () => onSelect("cover"),
      },
      h("div", { className: "gzs-item__top" },
        h("span", { className: "gzs-item__no" }, "封面"),
        h("span", { className: "gzs-item__name" }, coverVersion ? `首图 2.35:1 · ${coverVersion.vid}` : "首图未出"),
        h("span", { className: `gzs-dot ${coverVersion ? "gzs-dot--done" : "gzs-dot--miss"}` })),
      h("div", { className: "gzs-item__meta" }, article.title ? `${countWords(article.title)} 字标题` : "标题未填")));

      sections.forEach((section, index) => {
        const slot = `sec-${section.id}`;
        const version = currentVersion(section.image);
        const words = countWords(section.body);
        rows.push(h("button", {
          key: slot,
          className: `gzs-item ${selected === slot ? "gzs-item--on" : ""}`,
          onClick: () => onSelect(slot),
        },
        h("div", { className: "gzs-item__top" },
          h("span", { className: "gzs-item__no" }, String(index + 1).padStart(2, "0")),
          h("span", { className: "gzs-item__name" }, section.heading || "（无小标题）"),
          h("span", { className: `gzs-dot ${version ? "gzs-dot--done" : "gzs-dot--miss"}` })),
        h("div", { className: "gzs-item__meta" },
          h("span", null, `${words} 字`),
          h("span", null, "·"),
          h("span", null, version ? version.vid : "缺图"),
          section.image?.versions?.length > 1 ? h("span", null, `· ${section.image.versions.length} 版`) : null)));
      });

      return h("div", { className: "gzs-outline" },
        rows,
        h("button", { className: "gzs-btn gzs-btn--ghost gzs-btn--sm", style: { marginTop: 8, width: "100%" }, onClick: onAddSection }, "＋ 加一段"));
    }

    // ── 左栏：本期步骤 ────────────────────────────────────────────────────────
    /**
     * 门禁的机器状态 → 面板四态。
     *
     * 四态只有四个：`ok` 完成 / `doing` 进行中 / `todo` 未开始 / `miss` 缺件。
     * **颜色不是唯一载体**：点的形状（实心 / 环 / 空心 / 方）+ 右侧结论文字一起给。
     */
    const GATE_STEP = { ok: "ok", fail: "miss", stale: "miss", unknown: "doing", skip: "todo" };
    /** 四态的人话。没证据就说没证据，不拿「进行中」糊过去。 */
    const STEP_WORD = { ok: "完成", doing: "进行中", todo: "未开始", miss: "缺件" };

    /**
     * 把一步的结论收敛成四类词（完成 / 进行中 / 缺件 / 未开始），
     * 原来那句话里带的信息（`3/6 节`、`1 份提案`、`导出过`、`0 处`）挪到 `note`。
     *
     * 为什么必须收敛：结论列和证据列混在同一列里，人扫 11 行看到的是四种词性，
     * 第一反应是「这列乱」，而不是「我卡在第 6 步」。证据不是没用——它在，只是小一号。
     */
    function normalizeStepWord(row) {
      const raw = String(row?.verdict ?? "").trim();
      // 「过期」是第五个词，而且**必须**留着：门禁结论作废（stale）跟「缺件」是两件事——
      // 前者是"查过但证据旧了"，后者是"压根没有"。并进缺件会让人白跑一趟去补料。
      const verdict = raw === "过期" ? raw : (STEP_WORD[row?.state] ?? "未开始");
      return { ...row, verdict, note: raw && raw !== verdict ? raw : "" };
    }
    /** 没有绑期号时用的十一步名字（PIPELINE 的第 0 + 十步）。 */
    const STEP_NAMES = [
      "开工同步", "立项对齐", "证据台账", "出方案", "写双审",
      "去 AI 味", "配图", "排版", "排版校验", "摘要推草稿", "自我迭代",
    ];

    /**
     * 证据台账条数：宿主给了就按条数，没给就回 0（界面显示「未开始」）。
     * 绝不按页数/段数编一个数出来——那是这个面板最不该犯的错。
     */
    function evidenceCount(view) {
      const article = view?.article ?? {};
      if (Array.isArray(article.evidence)) return article.evidence.length;
      if (Array.isArray(view?.evidence)) return view.evidence.length;
      const declared = Number(article.evidenceCount ?? view?.evidenceCount ?? 0);
      if (Number.isFinite(declared) && declared > 0) return declared;
      // 绑了期号时，宿主 facts 里那条「证据」的 detail 形如「12/12 条逐字核过」
      const facts = Array.isArray(view?.pipeline?.facts) ? view.pipeline.facts : [];
      const fact = facts.find((row) => row?.key === "evidence");
      const hit = /(\d+)/.exec(String(fact?.detail ?? ""));
      return hit ? Number(hit[1]) : 0;
    }

    /**
     * 左栏「本期步骤」：十一步（0–10），两个来源**不混用**。
     *
     * - 绑了期号：`view.pipeline.gates` 是盘上门禁的真结论，一道门一行照抄，不改判；
     * - 没绑期号：拿稿件本身看得见的东西**推断**（标题 / 正文 / 配图 / 导出…），
     *   调用方必须在标题下标明「按稿件推断 · 未绑定期号」——推出来的不许冒充门禁结论。
     *
     * 纯函数、不读盘、不联网：宿主下一轮接质量门真结论时，只要能给出 gates 就自动走上面那条。
     * @param {object} view `/api/gzh-studio.article` 的整包
     * @returns {{bound:boolean, source:string, rows:object[], done:number, total:number}}
     */
    function inferSteps(view) {
      const pipe = view?.pipeline ?? null;
      const gates = Array.isArray(pipe?.gates) ? pipe.gates : [];

      // ① 绑了期号：门禁说了算
      if (pipe?.bound && gates.length) {
        const rows = gates.map((gate, index) => {
          const state = GATE_STEP[gate?.state] ?? "todo";
          return {
            key: `gate-${gate?.no ?? index}-${gate?.key ?? index}`,
            no: Number(gate?.no) || index + 1,
            label: String(gate?.label ?? "").trim() || `第 ${gate?.no ?? index + 1} 道门`,
            state,
            verdict: gate?.state === "stale" ? "过期" : STEP_WORD[state],
            detail: String(gate?.detail ?? ""),
            target: "",
          };
        });
        return {
          bound: true,
          source: "gates",
          rows: rows.map(normalizeStepWord),
          done: rows.filter((row) => row.state === "ok").length,
          total: rows.length,
        };
      }

      // ② 没绑期号：按稿件推断。每一条都要能说出「凭什么」，说不出的就是「未开始」
      const article = view?.article ?? {};
      const sections = Array.isArray(article.sections) ? article.sections : [];
      const bodyOf = (section) => String(section?.body ?? "").trim();
      const filled = sections.filter((section) => bodyOf(section)).length;
      const emptySection = sections.find((section) => !bodyOf(section)) ?? null;
      const missingImage = sections.find((section) => !currentVersion(section?.image)) ?? null;
      const withImage = sections.filter((section) => currentVersion(section?.image)).length;
      const hasCover = Boolean(currentVersion(article.cover));
      const filledMeta = [article.title, article.audience, article.takeaway]
        .filter((value) => String(value ?? "").trim()).length;
      const proposalList = Array.isArray(view?.proposals) ? view.proposals : [];
      const exports = (Array.isArray(view?.ledger) ? view.ledger : []).filter((row) => row?.type === "export");
      const deai = view?.deai ?? null;
      const reviews = view?.reviews ?? null;
      const life = String(article.lifecycle ?? "");

      const rows = STEP_NAMES.map((label, no) => ({
        key: `step-${no}`, no, label, state: "todo", verdict: "未开始", detail: "", target: "",
      }));
      const set = (no, patch) => { Object.assign(rows[no], patch); };

      // 0 开工同步：有这条稿件记录就算开了工
      set(0, article.id
        ? { state: "ok", verdict: "已建稿", detail: article.updatedAt ? `最后更新 ${timeText(article.updatedAt)}` : "", target: "article" }
        : { state: "todo", verdict: "未开始", detail: "还没有这篇稿件" });

      // 1 立项对齐：标题 + 讲给谁 + 带走什么
      set(1, filledMeta === 3
        ? { state: "ok", verdict: "完成", detail: "标题、讲给谁、想让人带走什么都填了", target: "article" }
        : {
          state: filledMeta ? "miss" : "todo",
          verdict: filledMeta ? `缺 ${3 - filledMeta} 项` : "未开始",
          detail: "还差：标题 / 讲给谁 / 想让人带走什么",
          target: "article",
        });

      // 2 证据台账：宿主下发了条数才敢报条数
      const evidence = evidenceCount(view);
      set(2, evidence
        ? { state: "ok", verdict: `${evidence} 条`, detail: "条数来自宿主下发的证据层" }
        : { state: "todo", verdict: "未开始", detail: "没有证据台账（或宿主没下发条数）" });

      // 3 出方案：有提案说明有方案，但还没逐份确认，所以是「进行中」不是「完成」
      set(3, proposalList.length
        ? { state: "doing", verdict: `${proposalList.length} 份提案`, detail: "有方案/提案，还没有逐份确认", target: "article" }
        : { state: "todo", verdict: "未开始", detail: "还没有提案或方案" });

      // 4 写双审：面板上逐项勾选是唯一的人证。正文齐但没勾，只说「待勾」，不冒充完成
      if (reviews && Number(reviews.total) > 0) {
        const done = Number(reviews.done) || 0;
        const total = Number(reviews.total) || 0;
        if (done >= total) {
          set(4, { state: "ok", verdict: `${done}/${total}`, detail: "编辑审与读者审两份清单逐项勾满", target: "article" });
        } else {
          set(4, {
            state: "doing",
            verdict: done ? `${done}/${total}` : (filled ? "待勾" : "未开始"),
            detail: filled
              ? `正文已写 ${filled}/${sections.length} 节，双审清单还差 ${total - done} 项`
              : `双审清单还差 ${total - done} 项，正文还没写`,
            target: emptySection ? `sec-${emptySection.id}` : "article",
          });
        }
      } else if (sections.length && filled === sections.length) {
        set(4, { state: "doing", verdict: "待勾", detail: "每节都有正文，但双审清单没有可读记录", target: "article" });
      } else if (sections.length) {
        set(4, {
          state: emptySection ? "miss" : "doing",
          verdict: `${filled}/${sections.length} 节`,
          detail: "有段落还没写正文",
          target: emptySection ? `sec-${emptySection.id}` : "article",
        });
      }

      // 5 去 AI 味：宿主扫过正文就有诊断记录
      set(5, deai && Number(deai.bodyLen) > 0
        ? {
          state: "ok",
          verdict: `${Number(deai.total) || 0} 处`,
          detail: `扫了 ${Number(deai.scanned) || 0} 句，命中 ${Number(deai.total) || 0} 处（诊断是建议，不是门禁判定）`,
          target: "article",
        }
        : { state: "todo", verdict: "未开始", detail: "还没有正文可扫" });

      // 6 配图：按「有当前图的节 / 总节」报，没配满就是进行中
      if (sections.length) {
        const allImages = withImage === sections.length && hasCover;
        set(6, {
          state: allImages ? "ok" : (withImage ? "doing" : "todo"),
          verdict: `${withImage}/${sections.length}`,
          detail: `段落配图 ${withImage}/${sections.length}${hasCover ? " · 封面已出" : " · 封面还没出"}`,
          target: missingImage ? `sec-${missingImage.id}` : (hasCover ? "" : "cover"),
        });
      } else {
        set(6, { state: "todo", verdict: "未开始", detail: "还没有段落" });
      }

      // 7 排版：导出过就有排版件（导出走的正是宿主那份渲染器）
      set(7, exports.length
        ? { state: "ok", verdict: "导出过", detail: `最近一次导出：${timeText(exports[exports.length - 1]?.ts)}`, target: "" }
        : { state: "todo", verdict: "未开始", detail: "还没有导出过 HTML" });

      // 8 排版校验 / 9 摘要推草稿 / 10 自我迭代：没有判据就老实标未开始
      set(8, { state: "todo", verdict: "未开始", detail: "没有排版校验的留痕" });
      set(9, life === "draftbox"
        ? { state: "ok", verdict: "已进草稿箱", detail: "生命周期是人工标的" }
        : life === "published"
          ? { state: "ok", verdict: "已发布", detail: "生命周期是人工标的" }
          : { state: "todo", verdict: "未开始", detail: "还没有草稿箱/发布记录" });
      set(10, { state: "todo", verdict: "发布后", detail: "发布之后才有复盘可做", target: "" });

      return {
        bound: false,
        source: "inferred",
        // 结论列只允许四类词（完成/进行中/缺件/未开始）。
        // 「3/6 节」「1 份提案」「导出过」「0 处」是**证据**，不是结论——
        // 同一列里混着四种词性，人扫下来只会觉得乱（用户原话：视觉上感觉有点乱）。
        // 证据挪进 note，渲染时用小一号的灰字贴在结论左边。
        rows: rows.map(normalizeStepWord),
        done: rows.filter((row) => row.state === "ok").length,
        total: rows.length,
      };
    }

    /**
     * 左栏：**本期步骤优先**，结构收到底部。
     *
     * 为什么先列步骤：编辑打开一篇稿子，第一句想问的是「这一期走到哪了、卡在哪」，
     * 不是「第 3 段写了 92 字」。段落列表仍然在（折叠在底部），点一下照样滚到正文那一节。
     *
     * 未绑期号时**不留空白**：十一步照列，状态按稿件推断，并在标题下明写「按稿件推断 · 未绑定期号」。
     * 一根空步骤条会被当成面板坏了。
     */
    function StepRail({ view, article, selected, onSelect, onAddSection, onBind, busy, root }) {
      const [bindOpen, setBindOpen] = React.useState(false);
      const [structureOpen, setStructureOpen] = React.useState(true);
      const [episode, setEpisode] = React.useState(view?.pipeline?.episodeId ?? "");
      const [dir, setDir] = React.useState(view?.pipeline?.root ?? root ?? "");
      React.useEffect(() => {
        setEpisode(view?.pipeline?.episodeId ?? "");
        setDir(view?.pipeline?.root ?? root ?? "");
      }, [view?.pipeline?.episodeId, view?.pipeline?.root, root]);

      const steps = inferSteps(view);
      const pipeline = view?.pipeline ?? null;
      const blockingNo = pipeline?.bound ? (pipeline?.blocking?.no ?? null) : null;
      const percent = steps.total ? Math.round((steps.done / steps.total) * 100) : 0;
      const sections = Array.isArray(article?.sections) ? article.sections : [];

      const headNote = pipeline?.bound
        ? (pipeline?.error
          ? `门禁查不动：${pipeline.error}`
          : (pipeline?.episodeId
            ? `${pipeline.episodeId}${pipeline?.episodeNo ? ` · 第 ${pipeline.episodeNo} 期` : ""} · 结论来自盘上门禁`
            : "结论来自盘上门禁"))
        : "按稿件推断 · 未绑定期号";

      return h("div", { className: "gzs-rail" },
        h("div", { className: "gzs-railhead" },
          h("div", { className: "gzs-railhead__k" }, "本期进度"),
          h("div", { className: "gzs-railhead__v", title: article?.title ?? "" },
            pipeline?.bound ? (steps.done >= steps.total ? "全部门禁已过" : `${steps.done} / ${steps.total} 步已过`) : (article?.title || "这一篇")),
          h("div", { className: "gzs-bar" }, h("i", { style: { width: `${percent}%` } })),
          h("div", { className: "gzs-hint", style: { marginTop: 6 } },
            steps.bound ? headNote : `这篇还没绑定期号 · ${steps.done}/${steps.total} 步有据`)),
        steps.bound
          ? null
          // 未绑期号：说明与「接上产线」同一行——单独一行按钮会把 11 步挤出半行滚动。
          : h("div", { className: "gzs-railnote" },
            h("span", {
              className: "gzs-railnote__text",
              title: "推算依据：标题/受众/正文/配图/提案/账本/审阅清单，不是盘上门禁的结论",
            }, headNote),
            h(Btn, { small: true, kind: "ghost", on: () => setBindOpen((value) => !value) },
              bindOpen ? "收起" : "接上产线")),

        h("div", { className: "gzs-stepsbar" },
          steps.rows.map((row) => {
            const staticRow = !row.target;
            return h("button", {
              key: row.key,
              className: `gzs-stepline gzs-stepline--${row.state} ${staticRow ? "gzs-stepline--static" : ""}`
                + (row.target && row.target === selected ? " gzs-stepline--on" : "")
                + (blockingNo !== null && row.no === blockingNo && row.state === "miss" ? " gzs-stepline--stop" : ""),
              title: row.detail ? `${row.label}：${row.detail}` : row.label,
              onClick: row.target ? () => onSelect?.(row.target) : undefined,
            },
              h("span", { className: `gzs-stepdot gzs-stepdot--${row.state}` }),
              h("span", { className: "gzs-stepname" },
                h("span", { className: "gzs-stepno" }, String(row.no).padStart(2, "0")),
                h("span", { className: "gzs-steptext" }, row.label)),
              // 证据列**常驻**（没证据就留空）：它是 grid 的第 3 格，
              // 只有有 note 时才渲染的话，没有 note 的行会把状态标签挤到第 3 格，
              // 同一栏里两行的列位置就不一样了。
              h("span", { className: "gzs-stepnote", title: row.detail || row.note || undefined }, row.note || ""),
              h("span", { className: `gzs-steptag gzs-steptag--${row.state}` }, row.verdict));
          })),

        // 绑定表单展开时才占位（按钮已经在上面那行了）
        bindOpen
          ? h("div", { className: "gzs-railbind" },
            h(Field, { label: "期号" },
              h(TextInput, { value: episode, placeholder: "historical-person-027", onCommit: setEpisode })),
            h(Field, { label: "流水线根目录" },
              h(TextInput, { value: dir, placeholder: "D:/work/历史内容生产", onCommit: setDir })),
            h(Btn, {
              small: true, kind: "primary",
              disabled: Boolean(busy) || !String(episode).trim() || !String(dir).trim(),
              on: () => onBind?.({ episodeId: String(episode).trim(), root: String(dir).trim() }),
            }, "绑定"),
            h("div", { className: "gzs-hint", style: { marginTop: 6 } },
              "绑上之后这一栏换成盘上门禁的真结论。"))
          : null,

        h("div", { className: "gzs-railfoot" },
          h("button", { className: "gzs-railfoot__head", onClick: () => setStructureOpen((value) => !value) },
            h("span", null, "结构"),
            h("span", { className: "gzs-railfoot__n" }, `${sections.length} 节`),
            h("div", { className: "gzs-spacer" }),
            h("span", { className: "gzs-railfoot__n" }, structureOpen ? "收起" : "展开")),
          structureOpen
            ? h(Outline, { article, selected, onSelect, onAddSection })
            : null));
    }

    // ── 中栏：正文舞台（成稿 / 手机预览 / 排版）──────────────────────────────
    /** 两个视图：成稿（读）/ 手机预览（真机宽度）。排版视图 2026-11-02 按用户指令去掉；
     * 导出入口挪到手机预览上方那条工具条，别再单独占一个 tab。 */
    const STAGE_MODES = [["doc", "成稿"], ["phone", "手机预览"]];

    /**
     * 成稿：宽正文。**不是编辑器**——它回答「这篇读起来是什么样」。
     *
     * 标题衬线 27px、正文 15px/1.95、节标题左侧 3px 主色竖线（样稿口径）；
     * 图片按节内联，走宿主 image 路由（换版本就换地址，不吃旧缓存）。
     * 点节标题或图片会把右栏切到那个槽位，方便「看到哪、改到哪」。
     */
    function Manuscript({ article, selected, onSelect }) {
      if (!article) return h("div", { className: "gzs-empty" }, "还没有选中文章");
      const sections = Array.isArray(article.sections) ? article.sections : [];
      const coverVersion = currentVersion(article.cover);
      const blocks = [];
      const ring = (slot) => (selected === slot ? { outline: "2px solid var(--gzs-cyan)", outlineOffset: 4, borderRadius: 8 } : null);

      // 空段落（没小标题、没正文、没配图）在读者眼里不存在，整段跳过；
      // 序号沿用**原始** index，否则中间删段会让「第 N 段」和左栏编号对不上。
      const visible = sections
        .map((section, index) => ({ section, index }))
        .filter(({ section }) => (
          String(section?.heading ?? "").trim()
          || paragraphsOf(section?.body).length
          || currentVersion(section?.image)
        ));

      if (coverVersion) {
        // 不是大图，是一条槽位条：看得出来有封面、点得进去改，但不抢正文的位置。
        blocks.push(h("figure", {
          key: "cover", className: "gzs-coverstrip", style: ring("cover"),
          onClick: () => onSelect?.("cover"), title: "点一下，右栏切到封面",
        },
        h("img", { src: imageUrl(article.id, "cover", coverVersion.vid), alt: "封面" }),
        h("figcaption", null,
          h("span", { className: "t" }, `封面 · ${coverVersion.vid}`),
          h("span", { className: "n" }, article.cover?.caption || "首图 2.35:1")),
        h("span", { className: "go" }, "改封面")));
      }
      if (String(article.summary ?? "").trim()) {
        blocks.push(h("div", { key: "summary", className: "gzs-docsummary" },
          h("span", { className: "k" }, "摘要"),
          article.summary));
      }

      visible.forEach(({ section, index }) => {
        const slot = `sec-${section.id}`;
        const heading = String(section.heading ?? "").trim();
        const version = currentVersion(section.image);
        if (heading) {
          blocks.push(h("h3", {
            key: `h-${section.id}`,
            className: "gzs-doch",
            title: "点一下，右栏切到这一段",
            onClick: () => onSelect?.(slot),
          }, heading));
        }
        paragraphsOf(section.body).forEach((text, i) => {
          blocks.push(h("p", { key: `p-${section.id}-${i}` }, rich(text)));
        });
        if (version) {
          blocks.push(h("figure", { key: `img-${section.id}`, className: "gzs-shot", style: ring(slot), onClick: () => onSelect?.(slot) },
            h("img", { src: imageUrl(article.id, slot, version.vid), alt: heading || `配图 ${index + 1}` }),
            h("figcaption", null,
              h("span", null, `${slot} · ${version.vid}`),
              h("span", null, section.image?.caption || "待补图注"))));
        } else {
          blocks.push(h("div", {
            key: `gap-${section.id}`,
            className: "gzs-docgap",
            onClick: () => onSelect?.(slot),
          }, `第 ${index + 1} 段还没有配图 · 点这里去配`));
        }
      });

      if (!blocks.length) {
        return h("div", { className: "gzs-empty" }, h("div", null, "这篇还是空的"), h("div", { className: "gzs-hint" }, "先在右栏「元信息」里写标题，再逐段写正文"));
      }
      return h("div", { className: "gzs-doc" }, blocks);
    }

    /**
     * 排版视图：**不另造一套排版**。
     *
     * 导出用的就是宿主那份渲染器（`/export?format=html|md|checklist`），这里只给入口和口径说明。
     * 原来的做法是把手机预览当排版看，但那看不出「粘到公众号后台会是什么样」。
     */
    /**
     * 导出工具条（原「排版」视图 2026-11-02 按用户指令去掉，入口不能跟着消失）。
     *
     * 一条横排：导出 HTML / Markdown / 图片清单 + 当前排版件的来源与哈希。
     * 排版看哪里？看「手机预览」；要发出去的那份 HTML，导出的就是它。
     */
    function ExportBar({ article, onExport }) {
      if (!article) return null;
      const meta = article.layoutMeta && typeof article.layoutMeta === "object" ? article.layoutMeta : null;
      return h("div", { className: "gzs-layoutacts" },
        h(Btn, { kind: "primary", on: () => onExport?.("html") }, "导出 HTML"),
        h(Btn, { on: () => onExport?.("md") }, "Markdown"),
        h(Btn, { on: () => onExport?.("checklist") }, "图片清单"),
        meta
          ? h("span", { className: "gzs-hint", style: { margin: "0 0 0 10px" } },
              `排版件 ${String(meta.sha256 ?? "").slice(0, 12)}${meta.generatedAt ? " · " + meta.generatedAt : ""}`)
          : h("span", { className: "gzs-hint", style: { margin: "0 0 0 10px" } }, "还没有排版件"));
    }

    /**
     * 「上次推过」提示：防止同一篇反复建草稿。
     *
     * 推草稿是**新建**不是覆盖——同一个号里连点两次就是两条草稿。
     * 所以把上一次回执摆出来（时间 + media_id），并写清「再推会多一条」，而不是拦着不让推。
     */
    function LastPublishNotice({ lastPublish }) {
      if (!lastPublish) return null;
      return h("div", { className: "gzs-push__row" },
        h("span", null, "上次推过：", h("b", null, ago(lastPublish.ts)), "（media_id ",
          h("code", { className: "gzs-mono" }, String(lastPublish.mediaId ?? "—")), "）"),
        h("span", { className: "gzs-hint" }, "再推一次会新建一条草稿，不会覆盖上一条。"));
    }

    // ── 多平台：平台档案 / 规格检查 / 发布包 ─────────────────────────────────
    /**
     * 平台档案（spec）。
     *
     * 纪律：**只把确定的值当硬指标**。公众号的 32 / 128 / 2 万是官方文档值；
     * 小红书、抖音、快手的字数与比例按公开资料给默认值，标「参考」——
     * 平台规则会变，用户也不该因为我们的参考值被拦。所以检查一律是提醒，不拦复制、不拦发布。
     *
     * 发布方式三种：`draft`（有草稿接口，能真推）、`package`（只能出包复制）、`manual`（人工）。
     */
    /** 「没选内容类型」的筛选哨兵：与宿主 `TRACK_NONE` 同值（空串是「不筛」，含义相反）。 */
    const TRACK_NONE = "__none";

    const PLATFORM_SPECS = [
      {
        id: "wechat", name: "公众号", titleMax: 32, bodyMax: 20_000,
        coverRatio: "2.35:1", ratio: 2.35, links: true,
        publish: "draft", note: "官方文档值；能直接推草稿",
      },
      {
        id: "xhs", name: "小红书", titleMax: 20, bodyMax: 1_000,
        coverRatio: "3:4", ratio: 0.75, links: false,
        publish: "package", note: "参考值；没有公开发布接口，复制后到 App / 创作中心发",
      },
      {
        id: "douyin", name: "抖音", titleMax: 55, bodyMax: 1_000,
        coverRatio: "3:4", ratio: 0.75, links: false,
        publish: "package", note: "参考值；图文按笔记发，正式发布需企业开发者资质",
      },
      {
        id: "kuaishou", name: "快手", titleMax: 55, bodyMax: 1_000,
        coverRatio: "3:4", ratio: 0.75, links: false,
        publish: "package", note: "参考值；同抖音，先出包复制",
      },
    ];

    const platformSpec = (id) => PLATFORM_SPECS.find((spec) => spec.id === id) ?? PLATFORM_SPECS[0];

    /** 正文纯文本：小标题 + 段落，空行分隔。平台包里用这个，不用带样式。 */
    function plainArticleBody(article) {
      const parts = [];
      for (const section of Array.isArray(article?.sections) ? article.sections : []) {
        const head = String(section?.heading ?? "").trim();
        const body = paragraphsOf(section?.body).map((text) => String(text).trim()).filter(Boolean).join("\n\n");
        if (!head && !body) continue;
        parts.push([head ? `【${head}】` : "", body].filter(Boolean).join("\n\n"));
      }
      return parts.join("\n\n");
    }

    /** 截到上限；尽量在标点处断，断不了就硬截。 */
    function fitText(text, max) {
      const value = String(text ?? "");
      if (value.length <= max) return { text: value, cut: false };
      const slice = value.slice(0, max);
      const lastStop = Math.max(...["。", "！", "？", "；", ".", "!", "?", ";", "，", ","].map((mark) => slice.lastIndexOf(mark)));
      const keep = lastStop > max * 0.6 ? slice.slice(0, lastStop + 1) : slice;
      return { text: keep, cut: true };
    }

    /** 这篇在某平台上存过的版本（没有就是 null）。 */
    function savedTarget(article, platformId) {
      const list = Array.isArray(article?.targets) ? article.targets : [];
      return list.find((item) => item && item.platform === platformId) ?? null;
    }

    /**
     * 一份平台包的规格分析：截断 / 检查 / 可复制文本。
     *
     * 对话框里的实时预览和「复制」必须走同一个函数——两处各算一遍，
     * 迟早出现「检查说超了、复制出来却没超」这种自相矛盾。
     */
    function analyzePack(spec, rawTitle, rawBody, coverVersion, hashtags = []) {
      const titleText = String(rawTitle ?? "").trim();
      const bodyText = String(rawBody ?? "");
      const title = fitText(titleText, spec.titleMax);
      const body = fitText(bodyText, spec.bodyMax);
      const checks = [];
      if (titleText.length > spec.titleMax) {
        checks.push({
          id: "title", level: "warn",
          message: `标题 ${titleText.length}/${spec.titleMax} 字，发出去会被截断：复制时已截到「${title.text}」`,
        });
      }
      if (bodyText.length > spec.bodyMax) {
        checks.push({
          id: "body", level: "warn",
          message: `正文 ${bodyText.length}/${spec.bodyMax} 字，超出 ${bodyText.length - spec.bodyMax} 字`,
        });
      }
      if (!spec.links && /https?:\/\//i.test(bodyText)) {
        checks.push({ id: "link", level: "warn", message: "这个平台正文里的外链不可点，建议删掉或改写成「见评论区 / 主页」" });
      }
      if (coverVersion?.width && coverVersion?.height) {
        const ratio = coverVersion.width / coverVersion.height;
        if (Math.abs(ratio - spec.ratio) > 0.08) {
          checks.push({
            id: "cover", level: "warn",
            message: `封面 ${coverVersion.width}×${coverVersion.height}（${ratio.toFixed(2)}:1），${spec.name}建议 ${spec.coverRatio}，会被裁切`,
          });
        }
      }
      const tags = (Array.isArray(hashtags) ? hashtags : []).filter(Boolean);
      return {
        spec,
        title: title.text,
        body: body.text,
        hashtags: tags,
        titleCut: title.cut,
        bodyCut: body.cut,
        titleLen: titleText.length,
        bodyLen: bodyText.length,
        checks,
        copyText: [title.text, body.text, tags.map((tag) => (tag.startsWith("#") ? tag : `#${tag}`)).join(" ")]
          .filter(Boolean)
          .join("\n\n"),
      };
    }

    /**
     * 出一份平台包：**存过的平台版本 → 原稿**。
     *
     * 原稿是唯一真源，平台版本是它的投影；存过就说明用户按这个平台裁过，
     * 检查和复制都该以那一版为准。
     */
    function platformPack(article, platformId) {
      const spec = platformSpec(platformId);
      const saved = savedTarget(article, platformId);
      const rawTitle = String(saved?.title || article?.title || "");
      const rawBody = String(saved?.body || plainArticleBody(article));
      const pack = analyzePack(spec, rawTitle, rawBody, currentVersion(article?.cover), saved?.hashtags ?? []);
      return { ...pack, saved: Boolean(saved) };
    }

    /**
     * 从编辑框里的草稿生成 `targets`：**只存和原稿不一样的部分**。
     *
     * 不这么做的话，一次「全部保存」会把整篇正文复制成四五份塞进 article.json——
     * 既撑大文件，又让「原稿改了、平台版还是旧的」变成看不见的不一致。
     * 和原稿相同 = 不存 = 永远跟着原稿走。
     */
    function targetsFromDraft(article, draft = {}) {
      const baseTitle = String(article?.title ?? "").trim();
      const baseBody = plainArticleBody(article);
      const targets = [];
      for (const spec of PLATFORM_SPECS) {
        const item = draft?.[spec.id] ?? {};
        const title = String(item.title ?? "").trim();
        const body = String(item.body ?? "").trim();
        const hashtags = String(item.hashtags ?? "")
          .split(/[\s,，]+/)
          .map((tag) => tag.trim())
          .filter(Boolean);
        const entry = { platform: spec.id };
        if (title && title !== baseTitle) entry.title = title;
        if (body && body !== baseBody) entry.body = body;
        if (hashtags.length) entry.hashtags = hashtags;
        if (entry.title || entry.body || entry.hashtags) targets.push(entry);
      }
      return targets;
    }

    /** 复制到剪贴板：优先 Clipboard API，被权限挡住就退回选中文本框。 */
    async function copyToClipboard(text) {
      const value = String(text ?? "");
      try {
        if (navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(value);
          return true;
        }
      } catch { /* 落到下面的兜底 */ }
      try {
        const area = document.createElement("textarea");
        area.value = value;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(area);
        return ok;
      } catch {
        return false;
      }
    }

    /**
     * 发布包：一稿多投的出口。
     *
     * 每行一个平台：可改的标题 / 正文 / 话题 + 规格检查 + 复制。
     * 保存时只写「和原稿不一样的那部分」（targets）——原稿仍是唯一真源，
     * 平台版本只是它的投影；不存的话，下次打开还是按原稿自动裁。
     */
    function PublishPackDialog({ article, onClose, onPush, onSave }) {
      const baseTitle = String(article?.title ?? "").trim();
      const baseBody = plainArticleBody(article);
      const [draft, setDraft] = React.useState(() => {
        const out = {};
        for (const spec of PLATFORM_SPECS) {
          const saved = savedTarget(article, spec.id);
          out[spec.id] = {
            title: saved?.title ?? "",
            body: saved?.body ?? "",
            hashtags: Array.isArray(saved?.hashtags) ? saved.hashtags.join(" ") : "",
          };
        }
        return out;
      });
      const [flash, setFlash] = React.useState("");
      // 和「检查」「往期」一样：Esc 能退出去。少了这个键，弹窗就成了「只能找按钮」。
      React.useEffect(() => {
        const onKey = (event) => { if (event?.key === "Escape") onClose?.(); };
        window.addEventListener?.("keydown", onKey);
        return () => window.removeEventListener?.("keydown", onKey);
      }, [onClose]);
      const patch = (id, key, value) => setDraft((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), [key]: value } }));
      const grab = async (text, key) => {
        const ok = await copyToClipboard(text);
        setFlash(ok ? key : `fail:${key}`);
      };
      const save = () => {
        onSave?.(targetsFromDraft(article, draft));
        setFlash("saved");
      };
      const title = baseTitle || "（还没标题）";
      return h("div", {
        className: "gzs-modal",
        onClick: (event) => { if (event.target === event.currentTarget) onClose?.(); },
      },
        h("div", { className: "gzs-modal__card gzs-modal__card--wide", role: "dialog", "aria-label": "发布包" },
          h("div", { className: "gzs-modal__bar" },
            h("span", { className: "gzs-modal__t" }, "发布包 · 一稿多投"),
            h("span", { className: "gzs-hint" }, title),
            h("div", { className: "gzs-spacer" }),
            flash === "saved" ? h("span", { className: "gzs-hint" }, "已保存到这一篇") : null,
            h(Btn, { small: true, kind: "primary", on: save, disabled: !onSave }, "保存平台版本"),
            h("button", { className: "gzs-chatcol__x", onClick: () => onClose?.(), title: "关闭" }, "×")),
          h("div", { className: "gzs-modal__body gzs-modal__body--flush" },
            h("div", { className: "gzs-pack" },
              h("div", { className: "gzs-hint gzs-pack__note" },
                "同一个稿子，按各平台规格裁一遍。标题 / 正文留空＝用原稿；改了才存，和原稿一样的不占空间。"),
              PLATFORM_SPECS.map((spec) => {
                const item = draft[spec.id] ?? {};
                const saved = savedTarget(article, spec.id);
                const packs = analyzePack(
                  spec,
                  String(item.title ?? "").trim() || baseTitle,
                  String(item.body ?? "").trim() || baseBody,
                  currentVersion(article?.cover),
                  String(item.hashtags ?? "").split(/[\s,，]+/).filter(Boolean),
                );
                return h("div", { key: spec.id, className: "gzs-pack__row" },
                  h("div", { className: "gzs-pack__head" },
                    h("span", { className: "gzs-pack__name" }, spec.name),
                    h("span", { className: "gzs-pack__spec" }, `标题 ≤${spec.titleMax} · 正文 ≤${spec.bodyMax} · 封面 ${spec.coverRatio}`),
                    saved ? h("span", { className: "gzs-pack__mode" }, "已存平台版") : null,
                    h("span", { className: "gzs-pack__mode" }, spec.publish === "draft" ? "可直推草稿" : "出包复制")),
                  h("input", {
                    className: "gzs-pack__in",
                    value: item.title ?? "",
                    placeholder: `标题：留空＝用原标题（${baseTitle.slice(0, 14)}${baseTitle.length > 14 ? "…" : ""}）`,
                    onChange: (event) => patch(spec.id, "title", event.target.value),
                  }),
                  h("textarea", {
                    className: "gzs-pack__area",
                    rows: 3,
                    value: item.body ?? "",
                    placeholder: "正文：留空＝用原稿正文",
                    onChange: (event) => patch(spec.id, "body", event.target.value),
                  }),
                  h("input", {
                    className: "gzs-pack__in",
                    value: item.hashtags ?? "",
                    placeholder: "话题：空格分隔（可选）",
                    onChange: (event) => patch(spec.id, "hashtags", event.target.value),
                  }),
                  h("div", { className: "gzs-pack__meta" },
                    h("span", { className: packs.titleCut ? "gzs-pack__warn" : "" }, `标题 ${packs.titleLen}/${spec.titleMax}`),
                    h("span", { className: packs.bodyCut ? "gzs-pack__warn" : "" }, `正文 ${packs.bodyLen}/${spec.bodyMax}`),
                    h("span", null, `封面 ${spec.coverRatio}`)),
                  packs.checks.length
                    ? h("ul", { className: "gzs-pack__checks" },
                      packs.checks.map((check) => h("li", { key: check.id, className: "gzs-pack__check" }, check.message)))
                    : h("div", { className: "gzs-hint" }, "没有发现规格问题。"),
                  h("div", { className: "gzs-pack__acts" },
                    h(Btn, { small: true, on: () => grab(packs.copyText, spec.id) }, flash === spec.id ? "已复制" : "复制标题+正文"),
                    h(Btn, {
                      small: true, kind: "ghost",
                      on: () => grab([packs.title, packs.checks.map((c) => `· ${c.message}`).join("\n")].join("\n\n"), `${spec.id}-title`),
                    }, flash === `${spec.id}-title` ? "已复制" : "只复制标题"),
                    spec.publish === "draft" && onPush
                      ? h(Btn, { small: true, kind: "primary", on: onPush }, "去推草稿")
                      : null,
                    flash === `fail:${spec.id}`
                      ? h("span", { className: "gzs-hint" }, "浏览器挡住了剪贴板，手动选中再复制")
                      : null));
              }),
              h("div", { className: "gzs-hint gzs-pack__foot" },
                "小红书没有公开的发布接口；抖音 / 快手要企业开发者资质。所以这里是「发布包」，不是「一键发布」——只有公众号那条能直接进草稿箱。")))));
    }

    /**
     * 推草稿对话框。
     *
     * 一次只回答一个问题：「现在能不能推、还差什么」。所以它有两个形态：
     * - 没配公众号 → 配置向导（AppID / AppSecret / 作者 / 直连或网关）；
     * - 配好了 → 推前自查（字符数、图片数、限额问题）+ 推 + 回执。
     *
     * 不用系统 alert：`40164` 的出口 IP 必须能一键复制，弹窗做不到这件事。
     * 也**不假装能发布**：推的是草稿，群发/发表仍然人工在后台点。
     */
    function PushDialog({ id, onClose, onDone, lastPublish }) {
      const [status, setStatus] = React.useState(null);
      const [statusError, setStatusError] = React.useState("");
      const [editing, setEditing] = React.useState(false);
      const [check, setCheck] = React.useState({ loading: false, error: null, data: null });
      const [busy, setBusy] = React.useState(false);
      const [result, setResult] = React.useState(null);
      const [copied, setCopied] = React.useState("");
      const [form, setForm] = React.useState({ appId: "", appSecret: "", author: "", mode: "direct", gatewayURL: "", gatewayToken: "" });
      const patchForm = (patch) => setForm((prev) => ({ ...prev, ...patch }));

      const runCheck = async () => {
        if (!id) return;
        setCheck({ loading: true, error: null, data: null });
        try {
          const data = await postJson(ROUTES.push, { id, dryRun: true });
          setCheck({ loading: false, error: null, data });
        } catch (error) {
          setCheck({ loading: false, error, data: null });
        }
      };

      React.useEffect(() => {
        let live = true;
        (async () => {
          try {
            const data = await getJson(ROUTES.wechatStatus);
            if (!live) return;
            setStatus(data);
            if (data?.configured || data?.usable) {
              setCheck({ loading: true, error: null, data: null });
              try {
                const preview = await postJson(ROUTES.push, { id, dryRun: true });
                if (live) setCheck({ loading: false, error: null, data: preview });
              } catch (error) {
                if (live) setCheck({ loading: false, error, data: null });
              }
            }
          } catch (error) {
            // 老宿主没有这条路由：说清「重启一次就好」，别让人以为插件坏了。
            if (live) {
              setStatusError(error?.status === 404
                ? "宿主这一版还没加载推草稿路由：重启一次 dsh web 后就能用（会话记录在盘上，不会丢）。"
                : error.message);
            }
          }
        })();
        return () => { live = false; };
      }, [id]);

      React.useEffect(() => {
        const onKey = (event) => { if (event?.key === "Escape" && !busy) onClose?.(); };
        window.addEventListener?.("keydown", onKey);
        return () => window.removeEventListener?.("keydown", onKey);
      }, [busy]);

      const copy = (text, tag) => {
        try {
          navigator.clipboard?.writeText?.(String(text ?? ""));
          setCopied(tag);
          window.setTimeout(() => setCopied(""), 1600);
        } catch { setCopied(""); }
      };

      const saveConfig = async () => {
        setBusy(true);
        try {
          const data = await postJson(ROUTES.wechatConfig, wechatConfigPayload(form));
          setStatus(data);
          setStatusError("");
          setEditing(false);
          await runCheck();
        } catch (error) {
          setStatusError(error.message);
        } finally {
          setBusy(false);
        }
      };

      const doPush = async () => {
        setBusy(true);
        setResult(null);
        try {
          const data = await postJson(ROUTES.push, { id });
          setResult(data);
          onDone?.();
        } catch (error) {
          setCheck((prev) => ({ ...prev, error }));
        } finally {
          setBusy(false);
        }
      };

      const configured = Boolean(status && (status.configured || status.usable)) && !editing;
      /**
       * 进「改配置」：**留空的字段等于不改**，所以只回填能回填的（作者 / 模式 / 网关地址），
       * AppID 与 AppSecret 故意留空——回填掩码会被当成新值存进去。
       */
      const startEditing = () => {
        setForm((prev) => ({
          ...prev,
          appId: "",
          appSecret: "",
          author: status?.author ?? "",
          mode: status?.mode === "gateway" ? "gateway" : "direct",
          gatewayURL: status?.gateway?.baseURL ?? "",
          gatewayToken: "",
        }));
        setEditing(true);
      };
      const problems = check.data?.problems ?? check.error?.problems ?? [];
      const stats = check.data?.stats ?? null;
      const images = check.data?.images ?? [];
      const failure = check.error ?? null;

      const field = (label, key, extra = {}) => h("label", { className: "gzs-push__field" },
        h("span", { className: "gzs-push__k" }, label),
        h("input", {
          className: "gzs-input",
          value: form[key],
          onChange: (event) => patchForm({ [key]: event.target.value }),
          ...extra,
        }));

      const configBody = h("div", null,
        h("p", { className: "gzs-push__lead" },
          "推草稿要用公众号的 AppID / AppSecret（公众号后台 → 设置与开发 → 基本配置）。",
          h("br"),
          "密钥只存在本机 ", h("code", null, "~/.dsh/gzh-studio/wechat.json"),
          "，只会发给微信接口；不想落盘就用环境变量 GZH_WECHAT_APPID / GZH_WECHAT_SECRET。"),
        field("AppID", "appId", { placeholder: status?.appId ? `已配置 ${status.appId}，留空不改` : "wx…", spellCheck: false }),
        field("AppSecret", "appSecret", { placeholder: status?.hasSecret ? "已保存，留空不改" : "只在本机保存", type: "password", spellCheck: false }),
        field("作者（可选，≤16 字）", "author", { placeholder: "显示在草稿里的作者名" }),
        h("div", { className: "gzs-push__row" },
          h("span", null, "推送方式"),
          h("div", { className: "gzs-seg" },
            [["direct", "直连微信"], ["gateway", "走网关"]].map(([key, label]) =>
              h(Btn, {
                key, small: true, kind: form.mode === key ? "primary" : "ghost",
                on: () => patchForm({ mode: key }),
              }, label))),
          h("span", { className: "gzs-hint" }, form.mode === "direct" ? "插件直接调微信接口" : "插件只发任务，密钥留在网关")),
        form.mode === "gateway" ? field("网关地址", "gatewayURL", { placeholder: "https://your-gateway.example" }) : null,
        form.mode === "gateway" ? field("网关令牌", "gatewayToken", { type: "password" }) : null,
        h("p", { className: "gzs-hint" },
          "直连模式第一次推大概率遇到 40164：把微信报的出口 IP 加进「基本配置 → IP 白名单」即可，面板会把 IP 直接给你复制。"),
        h("p", { className: "gzs-hint" }, "推的是「草稿」不是「发布」：群发 / 发表仍然要人工在公众号后台点。"),
        statusError ? h("div", { className: "gzs-push__prob" }, statusError) : null);

      const configuredBody = h("div", null,
        h("div", { className: "gzs-push__row" },
          h("span", null, "AppID ", h("b", null, status?.appId || "—")),
          h("span", null, "作者 ", h("b", null, status?.author || "未填")),
          h("span", null, status?.mode === "gateway" ? "网关模式" : "直连模式"),
          h("div", { className: "gzs-spacer" }),
          h(Btn, { small: true, kind: "ghost", on: startEditing }, "改配置")),
        h(LastPublishNotice, { lastPublish }),
        check.loading ? h("div", { className: "gzs-hint", style: { padding: "6px 0" } }, "自查中：数一遍字符和图片…") : null,
        stats
          ? h("div", { className: "gzs-push__stat" },
            h("span", null, "正文 ", h("b", null, stats.contentChars.toLocaleString()), " 字符"),
            h("span", null, "图片 ", h("b", null, String(images.length)), " 张"),
            h("span", null, "标题 ", h("b", null, String(stats.title)), " 字"),
            h("span", null, "摘要 ", h("b", null, String(stats.digest)), " 字"),
            h("span", { className: "gzs-hint" }, "上限 2 万字符 / 1 MB"))
          : null,
        problems.length
          ? h("div", { className: "gzs-push__prob" },
            problems.map((problem, index) => h("div", { key: index }, `· ${problem.message}`)))
          : null,
        failure
          ? h("div", { className: "gzs-push__prob" },
            h("div", null, failure.message),
            failure.hint ? h("div", { className: "gzs-hint" }, failure.hint) : null,
            failure.ip
              ? h("div", { className: "gzs-push__ip" },
                "出口 IP ", h("b", null, failure.ip),
                h(Btn, { small: true, on: () => copy(failure.ip, "ip") }, copied === "ip" ? "已复制" : "复制 IP"))
              : null)
          : null,
        result
          ? h("div", { className: "gzs-push__ok" },
            h("div", null, "已进草稿箱：", h("code", null, result.mediaId ?? "")),
            h("div", { className: "gzs-hint" }, "去公众号后台「内容管理 → 草稿箱」看；发布还是人工点。"),
            h("div", { style: { marginTop: "6px" } },
              h(Btn, { small: true, on: () => copy(result.mediaId, "media") }, copied === "media" ? "已复制" : "复制 media_id"),
              h("a", {
                href: "https://mp.weixin.qq.com/", target: "_blank", rel: "noreferrer",
                className: "gzs-hint", style: { marginLeft: "10px" },
              }, "打开公众号后台 ↗")))
          : h("div", { className: "gzs-hint" }, "推的是「草稿」不是「发布」：群发 / 发表仍然要人工在后台点。"));

      return h("div", {
        className: "gzs-modal",
        onClick: (event) => { if (event.target === event.currentTarget && !busy) onClose?.(); },
      },
        h("div", { className: "gzs-modal__card", role: "dialog", "aria-label": "推草稿" },
          h("div", { className: "gzs-modal__bar" },
            h("span", { className: "gzs-modal__t" }, "推草稿"),
            h("span", { className: "gzs-hint" }, configured ? "推到公众号草稿箱" : "先配一下公众号"),
            h("div", { className: "gzs-spacer" }),
            h("button", { className: "gzs-chatcol__x", onClick: () => { if (!busy) onClose?.(); }, title: "关闭" }, "×")),
          h("div", { className: "gzs-modal__body" },
            status === null && !statusError ? h("div", { className: "gzs-hint" }, "读公众号配置…") : null,
            configured ? configuredBody : configBody),
          h("div", { className: "gzs-modal__foot" },
            configured
              ? h(Btn, { small: true, kind: "ghost", on: runCheck, disabled: busy }, "重新自查")
              : null,
            configured
              ? h(Btn, {
                kind: "primary",
                on: doPush,
                disabled: busy || problems.length > 0 || Boolean(result) || !id,
                title: id ? "" : "先去新建 / 打开一篇，再推",
              }, busy ? "推送中…" : result ? "已推送" : id ? "推草稿" : "先去写一篇")
              : h(Btn, {
                kind: "primary",
                on: saveConfig,
                // 已经配过的账号允许「只改作者 / 模式」：AppID 留空不算错。
                disabled: busy || (!form.appId.trim() && !status?.hasSecret && !status?.usable),
              }, busy ? "保存中…" : "保存并自查"))));
    }

    /**
     * 中栏：标题 + 一行元信息 + 视图切换（成稿 / 手机预览）。
     *
     * 手机预览**原样复用** `PhonePreview`（375 是真机宽度，不能被压窄），
     * 只是外面套一个 390px 的深色壳，让它看起来像一台手机而不是一张白纸。
     */
    function Stage({ article, templates, selected, onSelect, onExport, onRegenerate, onPickVersion, busy }) {
      const [mode, setMode] = React.useState("doc");
      if (!article) {
        return h("div", { className: "gzs-empty" }, h("div", null, "还没有选中文章"), h("div", { className: "gzs-hint" }, "回全部文章挑一篇"));
      }
      const sections = Array.isArray(article.sections) ? article.sections : [];
      const words = sections.reduce((sum, section) => sum + countWords(section?.body), 0);
      const images = sections.filter((section) => currentVersion(section?.image)).length + (currentVersion(article.cover) ? 1 : 0);
      const template = templateOf(templates, article.template);
      const audience = String(article.audience ?? "").trim();

      return h("div", { className: "gzs-stage" },
        h("div", { className: "gzs-stagehead" },
          h("h1", { className: "gzs-stagetitle" }, article.title || "（还没有标题）"),
          article.subtitle ? h("p", { className: "gzs-stage-sub" }, article.subtitle) : null),
        h("div", { className: "gzs-meta" },
          h("span", null, h("b", null, `${words} 字`), ` · ${sections.length} 节 · ${images} 图`),
          h("span", { className: "gzs-meta__tpl" }, "模板 ", h("b", null, template.name ?? template.id ?? "—")),
          // 受众经常是整句（"正在做数字化的药企 IT 负责人"），平铺会把整行撑开、把视图切换挤到折行。
          // 截到 22ch + title 放全文：前面的字够认，要看全就 hover。
          h("span", { className: "gzs-meta__aud", title: `受众：${audience || "未填"}` }, "受众 ", h("b", null, audience || "未填")),
          h("span", null, "更新 ", h("b", null, timeText(article.updatedAt) || "—")),
          h("div", { className: "gzs-seg gzs-seg--view" },
            STAGE_MODES.map(([key, label]) => h("button", {
              key,
              className: `gzs-btn gzs-btn--sm ${mode === key ? "gzs-btn--on" : ""}`,
              onClick: () => setMode(key),
            }, label)))),
        mode === "phone"
          ? h("div", { className: "gzs-phonewrap" },
              h(ExportBar, { article, onExport }),
              h(PhonePreview, { article, templates, selected, onSelect, busy, onRegenerate, onPickVersion }))
          : h(Manuscript, { article, selected, onSelect }));
    }

    // ── 右栏：检查器 ──────────────────────────────────────────────────────────
    /**
     * 检查器：选中什么就检查什么。
     *
     * - `cover` / `sec-sN` 槽位：prompt、反向词、尺寸、节点、「出图」、版本条（可切）、反馈、QA
     * - `article`：标题、副标题、摘要、模板、全文 QA
     *
     * 这里是「提示词不再是一次性的」那条能不能成立的唯一入口 —— 所以 prompt 必须
     * 从 `article.cover.prompt` 这类**落盘字段**读，绝不能只活在输入框里。
     * @param {object} props
     */
    /**
     * 提案区。这是「改稿先看对照」的落点：
     * 待确认的提案列在最上面，点开看逐段增删改；确认走二次点击（防手滑），驳回只记账。
     */
    const REJECTION_REASONS = [
      ["direction", "修改方向不合适"],
      ["scope", "改动范围过大"],
      ["evidence", "需要补充依据"],
      ["style", "语言风格不符合"],
      ["defer", "暂时不修改"],
    ];

    function ProposalBlock({ proposals, detail, busy, onOpen, onClose, onDecide }) {
      const list = Array.isArray(proposals) ? proposals : [];
      const waiting = list.filter((p) => p.status === "waiting-user");
      const history = list.filter((p) => p.status !== "waiting-user").slice(0, 3);
      // 确认和驳回分别维护二次确认状态，避免误把一个动作的确认点带到另一个动作。
      const [armed, setArmed] = React.useState("");
      const [rejecting, setRejecting] = React.useState("");
      const [rejectReason, setRejectReason] = React.useState("direction");
      React.useEffect(() => { setArmed(""); setRejecting(""); setRejectReason("direction"); }, [detail?.proposal?.pid]);

      const head = h("div", { className: "gzs-sect__head", style: { marginBottom: 7 } },
        h("span", null, `提案${waiting.length ? `（${waiting.length} 待确认）` : ""}`),
        h("div", { className: "gzs-spacer" }),
        h("span", { className: "gzs-hint" }, "确认后才写入正文"));

      if (!waiting.length && !history.length) {
        return h("div", null, head, h("div", { className: "gzs-hint" },
          "没有提案。Agent 改稿走 /propose，正文不会被动；人在这里改字仍然直接保存。"));
      }

      const cards = waiting.map((item) => {
        const open = detail?.proposal?.pid === item.pid;
        return h("div", {
          key: item.pid,
          className: `gzs-prop ${open ? "gzs-prop--on" : ""} ${item.stale ? "gzs-prop--stale" : ""}`,
        },
        h("div", { className: "gzs-prop__top" },
          h("span", { className: "gzs-prop__sum" }, item.summary || "提案"),
          // 性质决定该退到哪：改词句退 07、改结构退 04、改标题退 03。
          // 这条比「改了几段」重要得多——不同性质的禁区完全不同，看错就改错地方。
          item.kind
            ? h("span", { className: `gzs-kind gzs-kind--${item.kind}`, title: item.route?.rule ?? "" },
              item.route?.label ?? item.kind)
            : null,
          item.stale ? h(Badge, { level: "warn" }, "已过期") : h(Badge, { level: "info" }, "待确认")),
        item.route
          ? h("div", { className: "gzs-prop__route" },
            h("span", { title: item.route.step }, `退到「${stepText(item.route.step)}」`),
            item.alsoTouches?.length ? h("span", { className: "gzs-prop__also" }, ` · 还捎带${item.alsoTouches.join("、")}`) : null,
            h("span", { className: "gzs-prop__rule" }, item.route.rule))
          : null,
        h("div", { className: "gzs-prop__meta" },
          `${ago(item.createdAt)} · ${item.count} 处改动${item.note ? ` · ${item.note}` : ""}`),
        h("div", { className: "gzs-prop__acts" },
          h(Btn, { small: true, kind: "ghost", on: () => (open ? onClose() : onOpen(item.pid)) }, open ? "收起" : "看对照"),
          h(Btn, {
            small: true, kind: "primary", disabled: Boolean(busy) || item.stale || rejecting === item.pid,
            on: () => {
              if (armed !== item.pid) { setArmed(item.pid); return; }
              setArmed("");
              onDecide({ pid: item.pid, confirmed: true });
            },
          }, armed === item.pid ? "确认写入？" : "确认"),
          h(Btn, {
            small: true, kind: "ghost", disabled: Boolean(busy) || armed === item.pid,
            on: () => {
              setArmed("");
              setRejecting(rejecting === item.pid ? "" : item.pid);
            },
          }, rejecting === item.pid ? "收起驳回" : "驳回")),
        rejecting === item.pid
          ? h("div", { className: "gzs-prop__reject" },
            h("div", { className: "gzs-prop__reject-title" }, "请选择驳回原因，确认后正文不会修改"),
            h("div", { className: "gzs-prop__reject-options" },
              ...REJECTION_REASONS.map(([key, label]) => h("label", { key, className: "gzs-prop__reject-option" },
                h("input", {
                  type: "radio",
                  name: `gzs-reject-${item.pid}`,
                  value: key,
                  checked: rejectReason === key,
                  onChange: () => setRejectReason(key),
                }),
                label))),
            h("div", { className: "gzs-prop__reject-actions" },
              h(Btn, {
                small: true, kind: "primary", disabled: Boolean(busy),
                on: () => {
                  const reason = REJECTION_REASONS.find(([key]) => key === rejectReason)?.[1] || "暂时不修改";
                  setRejecting("");
                  onDecide({ pid: item.pid, confirmed: false, quote: reason });
                },
              }, "确认驳回"),
              h(Btn, { small: true, kind: "ghost", disabled: Boolean(busy), on: () => setRejecting("") }, "取消")))
          : null,
        item.stale
          ? h("div", { className: "gzs-hint", style: { marginTop: 5 } },
            "正文在提案之后被改过，这份对照已经过期——重新提一次，别盖掉别人的改动。")
          : null,
        open ? renderDetail(detail) : null);
      });

      return h("div", null, head, ...cards,
        history.length
          ? h("div", { style: { marginTop: 4 } },
            ...history.map((item) => h("div", { key: item.pid, className: "gzs-hint", style: { marginTop: 3 } },
              `${item.status === "confirmed" ? "已确认" : "已驳回"} · ${ago(item.decidedAt || item.createdAt)} · ${item.summary}`)))
          : null);
    }

    /** 单份提案的逐段对照。 */
    function renderDetail(detail) {
      const changes = detail?.proposal?.changes ?? [];
      if (detail?.blocked) {
        return h("div", { className: "gzs-hint", style: { marginTop: 6, color: "var(--gzs-err)" } }, detail.blocked);
      }
      return h("div", { style: { marginTop: 8 } }, ...changes.map((change, index) => {
        const rows = Array.isArray(change.rows) ? change.rows : [];
        return h("div", { key: `${change.target}-${index}`, className: "gzs-chg" },
          h("div", { className: "gzs-chg__t" },
            h("span", { className: "gzs-grow" }, change.label),
            change.truncated ? h(Badge, { level: "warn" }, "过长·整体替换") : null),
          rows.length
            ? h("div", { className: "gzs-diff" }, ...rows.map((row, i) => {
              if (row.type === "gap") return h("div", { key: i, className: "gzs-diff__row gzs-diff__row--gap" }, "…");
              const kind = row.type === "add" ? "add" : row.type === "del" ? "del" : "same";
              const sign = kind === "add" ? "+ " : kind === "del" ? "- " : "  ";
              return h("div", { key: i, className: `gzs-diff__row gzs-diff__row--${kind}` }, sign + row.line);
            }))
            : h("div", { className: "gzs-hint" }, "（没有可显示的对照）"));
      }));
    }

    /**
     * 读界面上**当前显示**的 prompt 值。
     *
     * 为什么不能只用 `slotData.prompt`：输入框是「失焦才提交」的受控组件。
     * 用户填完 prompt 直接点「出图」，onBlur 先触发、请求还在路上，`slotData` 仍是旧值——
     * 于是出图接口拿不到 prompt，报「先写 prompt 再出图」。真跑起来踩到了。
     *
     * 所以点出图时以**界面上的字**为准：DOM 有值就用 DOM 的，没有才退回 state。
     * 这不是绕过 React，是承认「用户看见的才是他要出的那一版」。
     * @param {string} slot 槽位（`cover` / `sec-s3`）
     * @param {string} fallback state 里的值
     */
    function promptOnScreen(fallback) {
      // 按 `data-mark` 取，不按位置取：正文框排在 prompt 框前面，
      // 取「第一个 textarea」会拿到正文，确认卡上就会显示一段文章内容。
      const field = document.querySelector('[data-mark="prompt"]');
      const value = String(field?.value ?? "").trim();
      if (value) return value;
      return String(fallback ?? "").trim();
    }

    /**
     * 检查器的四个 tab：意见 / 证据 / 图 / 元信息。
     *
     * 原来是一整列长滚动（待确认 / 流水线 / 封面 / 图 / 版本 / 反馈 / 账本全在一条线上），
     * 段落一多就得来回滚。分成四个 tab 之后，**内容一块没少**，只是不再互相挤。
     * 默认「证据」——人打开一篇稿子，先要知道「还欠什么」。
     */
    const INSP_TABS = [["evidence", "证据"], ["images", "图"], ["meta", "元信息"]];

    /**
     * 右栏意见区只做两件事：标出当前上下文，或把这个上下文引用到左栏。
     * 自然语言讨论、改稿要求和 Agent 往返统一在左侧 DSH 原生对话完成；
     * 这里保留一个小型「后续反馈」入口，专门记录给下一次出图/治理使用的事实，
     * 不再让右栏看起来像第二个聊天窗口。
     */
    function OpinionComposer({ scope, scopeLabel, articleTitle, busy, onSubmit }) {
      const [feedback, setFeedback] = React.useState("");
      const [carry, setCarry] = React.useState("");
      const title = String(articleTitle ?? "").trim() || "（未命名稿件）";
      const label = String(scopeLabel ?? "").trim() || "当前范围";
      const slot = String(scope ?? "article");
      const quote = `【新媒体工作台引用】${title} · ${label} · ${slot}`;
      const draft = String(feedback ?? "");

      const bring = () => {
        setCarry("正往左栏送…");
        bringToChat([
          quote,
          "请围绕这个位置讨论或提出修改方案；我会在左侧原生对话中检查后再发送。",
        ].join("\n")).then((result) => {
          setCarry(result.ok
            ? "已填进左栏输入框，检查后回车发送"
            : `没填进去：${result.reason}。请回左栏重试`);
        });
      };

      const saveFeedback = () => {
        if (!draft.trim() || busy) return;
        onSubmit({ slot, verbatim: draft.trim() });
        setFeedback("");
        setCarry("已保存为后续反馈");
      };

      return h("div", { className: "gzs-compose" },
        h("div", { className: "gzs-compose__h" },
          h("span", { className: "t" }, "当前定位"),
          h("span", { className: "s" }, label)),
        h("div", { className: "gzs-compose__context" },
          "自然语言讨论请在左侧 DSH 对话中进行；右侧只负责引用、反馈和治理。"),
        h("div", { className: "gzs-compose__quote" }, quote),
        h("div", { className: "gzs-compose__actions" },
          h("span", { className: "gzs-hint" }, carry || "引用后只填入左栏，不会自动发送"),
          h(Btn, { small: true, kind: "primary", disabled: Boolean(busy), on: bring }, "引用此处到左侧对话")),
        h("div", { className: "gzs-compose__feedback" },
          h("div", { className: "gzs-hint", style: { marginBottom: 5 } }, "保存为后续反馈（不会发送到聊天）"),
          h("textarea", {
            rows: 2,
            value: draft,
            placeholder: "例如：下次出图保留颗粒感，避免过于干净",
            onChange: (e) => setFeedback(e.target.value),
          }),
          h("div", { style: { display: "flex", justifyContent: "flex-end", marginTop: 6 } },
            h(Btn, { small: true, kind: "ghost", disabled: Boolean(busy) || !draft.trim(), on: saveFeedback }, "保存为后续反馈"))));
    }

    function Inspector(props) {
      const {
        article, selected, templates, nodes, qa, ledger, busy, onSaveArticle, onSaveSection, onSaveSlot,
        onGenerate, onPick, onFeedback, onTemplate, onSelect, onDeleteSection,
        proposals, proposalDetail, onOpenProposal, onCloseProposal, onDecideProposal,
        feedback, deai, reviews,
        // 右栏「证据」tab 用的流水线：状态 + 十道门。（受控 tab 让顶部的「去看对照」能切回来）
        pipeline, pipeBlock, tab: tabProp, onTab, onGovernance,
        // 赛道包（宿主下发）：元信息里显示「按哪套口径写」，规则结果在「证据」的质量检查里
        track,
      } = props;

      // hooks 必须无条件执行：article 从 null 变成对象时，早退之后再调 useState 会让 React 报
      // 「Rendered more hooks than during the previous render」，整块面板炸掉。
      const [nodeId, setNodeId] = React.useState("");
      const [feedbackDraft, setFeedbackDraft] = React.useState("");
      /**
       * tab 的受控/非受控两种用法。
       *
       * 外层（Workspace）要能在跳转时把 tab 切到对应面板，所以它传 `tab` + `onTab`；
       * 单测/直接调用时没人管它，就退回自己的 state。两种都得能跑，且 hook 顺序不变。
       */
      const [localTab, setLocalTab] = React.useState("evidence");
      const tab = tabProp ?? localTab;
      const setTab = onTab ?? setLocalTab;

      /**
       * 出图前确认（决策 A：同一篇只问一次）。
       *
       * `useRef` 而不是 `useState`：这个标记只影响「下次点击走哪条分支」，
       * 改它不需要重渲染。用 state 会让每次出图都白重渲染一遍整个检查器。
       * 换成别的文章时 Inspector 会重新挂载（`key` 变了），标记自然重置——
       * 所以「每篇问一次」这件事不需要额外的持久化。
       */
      const confirmedGen = React.useRef(false);
      const [confirm, setConfirm] = React.useState(null);
      /**
       * 确认卡一出现就滚进视野。
       *
       * 卡在右栏底部，点「出图」时它常常整个落在视口外——用户点完看不到任何变化，
       * 会以为按钮坏了再点一次。原来用 ref 回调里直接改 scrollTop，实测不生效：
       * ref 在挂载那一刻调用，此时 React 还没把它接进滚动容器，
       * `closest(".gzs-col--right")` 拿到的位置不对。改到 `useEffect`（挂载后才跑）。
       */
      const confirmRef = React.useRef(null);
      React.useEffect(() => {
        if (!confirm) return;
        // 滚到卡本身，而不是「滚到底」：卡插在按钮和版本条之间，
        // 「滚到底」会滚到版本条那儿，卡反而被顶上去。
        // 用 `requestAnimationFrame` 等一帧——effect 跑的时候高度还没定，
        // 立刻算位置会拿到插入前的老几何（实测卡停在 -974px，整块在视口外）。
        const raf = requestAnimationFrame(() => {
          const el = confirmRef.current;
          if (!el) return;
          const col = el.closest(".gzs-col--right");
          if (col) {
            const top = el.getBoundingClientRect().top - col.getBoundingClientRect().top;
            col.scrollTop += top - 12;
          } else if (el.scrollIntoView) {
            el.scrollIntoView({ block: "nearest" });
          }
        });
        return () => cancelAnimationFrame(raf);
      }, [confirm]);

      if (!article) {
        return h("div", { className: "gzs-insp" }, h("div", { className: "gzs-hint" }, "左侧选一段开始。"));
      }

      const currentSection = selected !== "cover" && selected !== "article"
        ? (article.sections ?? []).find((s) => `sec-${s.id}` === selected)
        : null;
      const slotData = selected === "cover" ? article.cover : currentSection?.image;
      const versions = Array.isArray(slotData?.versions) ? slotData.versions : [];
      const active = currentVersion(slotData);
      const tokens = templateOf(templates, article.template).tokens;
      // 推草稿回执 → 草稿箱（自动推断）。按钮的「当前值」也要跟着它走，
      // 否则刚推完，界面还亮着「草稿」，人以为没推成功。
      const pushedToDraftBox = (ledger ?? []).some((row) => row?.type === "publish" && row.persisted !== false);
      const lifeValue = String(article.lifecycle || "") || (pushedToDraftBox ? "draftbox" : "draft");
      // 这个槽位的反馈：待带上 / 已带上。列表里只看本槽位，跨槽位混着看会误导
      //（封面说「字太大」跟第 3 段配图没关系，混进来会让人以为出图真的会带过去）。
      const fb = feedback ?? { bySlot: {} };
      const myFeedback = fb.bySlot?.[selected]
        ? { all: fb.bySlot[selected].items ?? [], open: (fb.bySlot[selected].items ?? []).filter((r) => !r.used) }
        : { all: [], open: [] };

      // 「提意见」作用于当前选中的范围。整篇 / 封面 / 第 N 段三档，标签要写清楚，
      // 否则人以为提给全文，结果只落到了某一段的槽位上。
      const secIndex = selected === "article" || selected === "cover"
        ? -1
        : (article.sections ?? []).findIndex((s) => `sec-${s.id}` === selected);
      const scopeLabel = selected === "article"
        ? "整篇 · 标题 / 摘要 / 通篇结构"
        : selected === "cover"
          ? "封面 · 这一张图"
          : secIndex >= 0
            ? `第 ${secIndex + 1} 段 · ${String((article.sections ?? [])[secIndex]?.heading ?? "").trim() || "（无小标题）"}`
            : "当前段落";

      // ── 文章级 ──
      const waiting = (proposals ?? []).filter((item) => item.status === "waiting-user");

      /**
       * 四个 tab 的面板。非当前 tab **只 hidden、不卸载**：
       * 切回来不用重算，「出图确认」这种局部状态也不会因为切了个 tab 就丢。
       * （hidden 用属性而不是 display，CSS 里配 `.gzs-itabpanel[hidden]{display:none!important}`。）
       */
      const panel = (key, ...children) => h("div", {
        key,
        className: "gzs-itabpanel",
        hidden: tab !== key,
      }, children);

      const tabBar = h("div", { className: "gzs-itabs" },
        INSP_TABS.map(([key, text]) => h("button", {
          key,
          className: `gzs-itab ${tab === key ? "gzs-itab--on" : ""}`,
          onClick: () => setTab(key),
        }, text)));

      if (selected === "article") {
        const items = qa?.items ?? [];
        return h("div", { className: "gzs-insp" },
          h("div", { className: "gzs-insphead" },
            h("span", null, "整篇"),
            h("div", { className: "gzs-spacer" }),
            waiting.length ? h(Badge, { level: "info" }, `${waiting.length} 份提案`) : null,
            qa ? h(Badge, { level: qa.ok ? "ok" : "error" }, qa.ok ? "可发布" : `${qa.counts.error} 个必改`) : null),
          tabBar,

          // 证据：质量检查 + 流水线 + 十道门 + 动作记录。
          // 「意见」那一栏已经去掉——讨论与改稿都在左侧 DSH 原生对话里完成，
          // 右栏只保留「这篇现在什么状态、哪里有问题」这类看板信息。
          panel("evidence",
            h("div", { className: "gzs-label" }, "质量检查"),
            qaItems(items),
            h("div", { className: "gzs-row", style: { gap: 6, flexWrap: "wrap", margin: "6px 0 2px" } },
              h("button", { className: "gzs-chip", onClick: () => onGovernance?.() },
                deai ? `去 AI 味 · ${deai.total ? `${deai.total} 处` : "干净"}` : "去 AI 味 · 未查"),
              h("button", { className: "gzs-chip", onClick: () => onGovernance?.() },
                reviews ? `审阅 · ${reviews.done}/${reviews.total}` : "审阅 · 未开始"),
              h("button", { className: "gzs-chip gzs-chip--on", onClick: () => onGovernance?.() }, "去「检查」→")),
            h("div", { className: "gzs-sep" }),
            h(PipeBlock, pipeBlock ?? {}),
            h("div", { className: "gzs-sep" }),
            h("div", { className: "gzs-label" }, "十道门"),
            pipeline?.gates?.length
              ? h(GateList, { gates: pipeline.gates })
              : h("div", { className: "gzs-hint" },
                pipeline?.bound ? "门禁这一轮没返回条目，点「刷新」重查一次。" : "绑上期号之后，这里换成盘上门禁的真结论。"),
            h("div", { className: "gzs-sep" }),
            h("div", { className: "gzs-label" }, "动作记录"),
            ledgerBlock(ledger)),

          // 图：一篇里所有槽位，点一张切到那个槽位
          panel("images", h(ImageBoard, { article, onSelect })),

          // 元信息：标题 / 副标题 / 摘要 / 标签 / 生命周期 / 模板
          panel("meta",
            h(Field, { label: "标题（≤64 字，建议 ≤30）" },
              h(TextInput, { value: article.title, placeholder: "谁 + 做了什么 + 结果", onCommit: (v) => onSaveArticle({ title: v }) })),
            h(Field, { label: "副标题（可空）" },
              h(TextInput, { value: article.subtitle, onCommit: (v) => onSaveArticle({ subtitle: v }) })),
            h(Field, { label: "摘要（≤120 字）" },
              h(TextInput, { value: article.summary, rows: 3, placeholder: "一句话说清给谁、解决什么", onCommit: (v) => onSaveArticle({ summary: v }) })),
            // 标签：自由填几个词（逗号分隔），用来检索。不填也不影响什么。
            h(Field, { label: `标签（用来检索，逗号分隔${(article.tags ?? []).length ? ` · ${article.tags.length} 个` : ""}）` },
              h(TextInput, {
                value: (article.tags ?? []).join("，"),
                placeholder: "例：药企，审批流，数字化",
                onCommit: (v) => onSaveArticle({ tags: String(v ?? "").split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean) }),
              })),
            (article.tags ?? []).length
              ? h("div", { className: "gzs-row", style: { gap: 4, flexWrap: "wrap", marginBottom: 10 } },
                (article.tags ?? []).map((tag) => h("span", { key: tag, className: "gzs-chip gzs-chip--on" }, tag)))
              : null,
            h(Field, { label: "这篇到哪了" },
              h("div", { className: "gzs-row", style: { gap: 5, flexWrap: "wrap" } },
                [["draft", "草稿"], ["draftbox", "草稿箱"], ["published", "已发布"]].map(([key, text]) =>
                  h(Btn, {
                    key, small: true, kind: lifeValue === key ? "primary" : "ghost",
                    on: () => onSaveArticle({ lifecycle: key }),
                  }, text)),
                article.lifecycleAt
                  ? h("span", { className: "gzs-hint", style: { alignSelf: "center" } }, `你标的 · ${timeText(article.lifecycleAt)}`)
                  : pushedToDraftBox
                    ? h("span", { className: "gzs-hint", style: { alignSelf: "center" } }, "按账本：已进草稿箱（自动推断）")
                    : null)),
            h(Field, { label: "内容类型口径" },
              track
                ? h("div", { className: "gzs-trackinfo" },
                  h("div", { className: "gzs-trackinfo__h" }, `${track.name} · ${track.tierLabel || ""}`.trim()),
                  track.tone ? h("div", { className: "gzs-trackinfo__d" }, track.tone) : null,
                  (track.structure ?? []).length
                    ? h("div", { className: "gzs-trackinfo__s" }, (track.structure ?? []).join(" → "))
                    : null,
                  h("div", { className: "gzs-hint" },
                    `规则：禁用词 ${track.rules?.forbidden ?? 0} 条 · 必须声明 ${track.rules?.required ?? 0} 条；命中结果在「证据」里。`))
                : h("div", { className: "gzs-hint" }, "通用模式：不套内容类型也能写、能出图、能推；选了才多一套禁用词与必须声明。")),
            h(Field, { label: "排版模板" },
              h("select", {
                className: "gzs-select", style: { width: "100%" }, value: article.template,
                onChange: (e) => onTemplate(e.target.value),
              }, (templates ?? []).map((t) => h("option", { key: t.id, value: t.id }, t.name)))),
            h("div", { className: "gzs-hint" },
              "改稿走 Agent 的 /propose：先在「检查」里看对照，确认后才写正文。")));
      }

      // ── 槽位级 ──
      // 尺寸标签跟着「当前版本的真实尺寸」走。原来写死 900×383，可出图接口实际给的是
      // 1664×704（64 的倍数吸附后的档位），头上一写 900×383 就和下面的版本卡自相矛盾。
      const realSize = active?.width && active?.height ? `${active.width}×${active.height}` : "";
      const label = selected === "cover"
        ? `封面${realSize ? `（${realSize}）` : "（目标 2.35:1）"}`
        : `第 ${sectionIndex(selected)} 段配图${realSize ? `（${realSize}）` : ""}`;
      const preset = selected === "cover" ? "900x383" : "1024x576";
      const scopeQa = (qa?.items ?? []).filter((item) => item.scope === selected);

      return h("div", { className: "gzs-insp" },
        h("div", { className: "gzs-insphead" },
          h("span", null, label),
          h("div", { className: "gzs-spacer" }),
          active ? h(Badge, { level: "ok" }, active.vid) : h(Badge, { level: "warn" }, "未出图")),
        tabBar,

        // 意见：这个槽位的检查项 + 反馈（反馈不改图，下一版出图自动带上）
        // 证据：流水线 + 十道门 + 本槽位的动作记录（跨槽位混着看会误导）
        panel("evidence",
          h("div", { className: "gzs-label" }, "质量检查"),
          qaItems(scopeQa),
          h("div", { className: "gzs-sep" }),
          h(PipeBlock, pipeBlock ?? {}),
          h("div", { className: "gzs-sep" }),
          h("div", { className: "gzs-label" }, "十道门"),
          pipeline?.gates?.length
            ? h(GateList, { gates: pipeline.gates })
            : h("div", { className: "gzs-hint" },
              pipeline?.bound ? "门禁这一轮没返回条目，点「刷新」重查一次。" : "绑上期号之后，这里换成盘上门禁的真结论。"),
          h("div", { className: "gzs-sep" }),
          h("div", { className: "gzs-label" }, "本槽位的动作"),
          ledgerBlock(ledger, selected)),

        // 元信息：段落正文在这里改（选中段时一并可改，省得来回切）
        panel("meta",
          currentSection
            ? h(React.Fragment, null,
              h(Field, { label: "小标题" },
                h(TextInput, { value: currentSection.heading, placeholder: "这一段讲什么", onCommit: (v) => onSaveSection(currentSection.id, { heading: v }) })),
              h(Field, { label: `正文（${countWords(currentSection.body)} 字）` },
                h(TextInput, {
                  value: currentSection.body, rows: 7, placeholder: "一个段落一个意思；空行分段",
                  onCommit: (v) => onSaveSection(currentSection.id, { body: v }),
                })),
              h("div", { className: "gzs-row", style: { margin: "0 0 10px" } },
                h(Btn, { small: true, kind: "ghost", on: () => onDeleteSection(currentSection.id) }, "删掉这一段")))
            : h("dl", { className: "gzs-kv" },
              h("dt", null, "稿件 ID"), h("dd", null, article.id),
              h("dt", null, "槽位"), h("dd", null, selected),
              h("dt", null, "目标尺寸"), h("dd", null, selected === "cover" ? "900×383（2.35:1）" : "1024×576（16:9）"),
              h("dt", null, "当前版本"), h("dd", null, active ? `${active.vid} · ${realSize}` : "还没有图"),
              h("dt", null, "版本数"), h("dd", null, String(versions.length)),
              h("dt", null, "图注"), h("dd", null, slotData?.caption || "未填"))),

        // 图：prompt / 反向词 / 节点 / 出图 / 大图 / 版本条
        panel("images",
          h(Field, { label: "出图 prompt（会存档，下次微调直接用）" },
            h(TextInput, {
              value: slotData?.prompt ?? "", rows: 4, mark: "prompt",
              placeholder: "主体 + 场景 + 光线 + 色调；不要写「高级感」这类形容词",
              onCommit: (v) => onSaveSlot(selected, { prompt: v }),
            })),
          h(Field, { label: "不要出现（反向）" },
            h(TextInput, {
              value: slotData?.negative ?? "", rows: 2, placeholder: "文字、水印、人脸…",
              onCommit: (v) => onSaveSlot(selected, { negative: v }),
            })),
          h(Field, { label: "图注（可空，显示在图下方）" },
            h(TextInput, { value: slotData?.caption ?? "", onCommit: (v) => onSaveSlot(selected, { caption: v }) })),
          h("div", { className: "gzs-row", style: { gap: 8, marginBottom: 12 } },
            h("div", { className: "gzs-grow" },
              h("label", { className: "gzs-label" }, "出图节点"),
              h("select", {
                className: "gzs-select", style: { width: "100%" }, value: nodeId || "",
                onChange: (e) => setNodeId(e.target.value),
              },
                h("option", { value: "" }, "（用默认）"),
                (nodes ?? []).map((n) => h("option", { key: n.id, value: n.id, disabled: !n.usable },
                  `${n.name}${n.usable ? "" : `（${n.reason}）`}`)))),
            h("div", { style: { paddingTop: 17 } },
              h(Btn, {
                kind: "primary",
                title: active ? "会生成一个新版本，旧版不覆盖" : "按上面的 prompt 出图",
                disabled: Boolean(busy),
                // 第一次出图前确认一次（决策：A）。理由有两条，用户都需要知道：
                // ① 这一步**会花额度**，点下去就没了；② 会**自动带上待用的反馈**，
                // 带上之后那些反馈就从「待带上」变「已带上」，下一版不再重复带。
                // 同一篇确认过一次就不再问——一篇文章十几张图，每次都弹会烦到关掉它。
                on: () => {
                  if (confirmedGen.current) {
                    onGenerate({ slot: selected, node: nodeId || undefined, size: slotData?.size || preset, prompt: promptOnScreen(slotData?.prompt), negative: slotData?.negative });
                    return;
                  }
                  const openCount = myFeedback.open.length;
                  setConfirm({
                    slot: selected,
                    count: openCount,
                    isCover: selected === "cover",
                    hd: String(promptOnScreen(slotData?.prompt) || "").slice(0, 60),
                  });
                },
              }, busy ? "出图中…" : "出图"))),

          confirm
            ? h("div", { className: "gzs-confirm", ref: confirmRef },
              h("div", { className: "gzs-confirm__t" },
                `要出${confirm.isCover ? "封面" : `第 ${sectionIndex(confirm.slot)} 段配图`}了`),
              h("div", { className: "gzs-confirm__b" },
                h("div", null, "这一步会消耗出图额度，一次一张。"),
                confirm.hd ? h("div", { className: "gzs-confirm__hd" }, `这次用：${confirm.hd}…`) : null,
                h("div", null,
                  confirm.count
                    ? `会带上 ${confirm.count} 条你之前提的反馈——带上之后它们就标「已带上」，下一版不再重复带。`
                    : "这个槽位没有待用的反馈，这次只按上面的 prompt 出。"),
                h("div", { className: "gzs-hint", style: { marginTop: 4 } }, "同一篇里确认这一次，后面出图不再问。")),
              h("div", { className: "gzs-confirm__acts" },
                h(Btn, {
                  kind: "primary", small: true,
                  on: () => {
                    confirmedGen.current = true;
                    const target = confirm;
                    setConfirm(null);
                    onGenerate({ slot: target.slot, node: nodeId || undefined, size: slotData?.size || preset, prompt: promptOnScreen(slotData?.prompt), negative: slotData?.negative });
                  },
                }, "确认，出图"),
                h(Btn, { small: true, kind: "ghost", on: () => setConfirm(null) }, "先不出")))
            : null,

          // 大图 / 空态
          active
            ? h("div", { style: { margin: "0 0 12px" } },
              h("img", { className: "gzs-thumb", src: imageUrl(article.id, selected, active.vid), alt: label }),
              h("div", { className: "gzs-mono", style: { marginTop: 6 } },
                `${active.width}×${active.height}${active.width && active.height ? ` · ${(active.width / active.height).toFixed(2)}:1` : ""} · ${Math.round((active.bytes ?? 0) / 1024)} KB`),
              active.note ? h("div", { className: "gzs-hint", style: { marginTop: 4 } }, active.note) : null)
            : h("div", { className: "gzs-empty", style: { minHeight: 120 } }, "还没有图。写好 prompt 点「出图」。"),

          h("div", { className: "gzs-sep" }),

          // 版本条
          h("div", { className: "gzs-sect__head", style: { marginBottom: 8 } },
            h("span", null, `版本（${versions.length}）`),
            h("div", { className: "gzs-spacer" }),
            h("span", { className: "gzs-hint" }, "旧版不覆盖，点一下切回")),
          versions.length
            ? versions.slice().reverse().map((v) => h("div", {
              key: v.vid,
              className: `gzs-ver ${v.vid === active?.vid ? "gzs-ver--on" : ""}`,
              onClick: () => onPick(selected, v.vid),
            },
              h("span", { className: "gzs-ver__vid" }, v.vid),
              h("span", { className: "gzs-ver__meta" }, `${v.width}×${v.height} · ${v.node} · ${ago(v.createdAt)}`),
              v.vid === active?.vid ? h(Badge, { level: "ok" }, "当前") : null))
            : h("div", { className: "gzs-hint" }, "还没有版本。")));
    }

    /** 十道门的证据：编号 / 记号 / 名称 / 结论。一行一道门，说明截两行、title 里给全。 */
    function GateList({ gates }) {
      const list = Array.isArray(gates) ? gates : [];
      if (!list.length) return null;
      return h("div", { className: "gzs-gates" },
        list.map((gate, index) => h("div", {
          key: `${gate.no ?? index}-${gate.key ?? index}`,
          className: `gzs-gate gzs-gate--${gate.state ?? "unknown"}`,
          title: gate.detail ?? "",
        },
          h("span", { className: "gzs-gate__no" }, String(gate.no ?? index + 1).padStart(2, "0")),
          h("span", { className: "gzs-gate__mark" }, GATE_MARK[gate.state] ?? "?"),
          h("span", { className: "gzs-gate__label" }, gate.label),
          gate.detail ? h("span", { className: "gzs-gate__detail" }, gate.detail) : null)));
    }

    /** 「图」tab：一篇里所有槽位的当前图。点一张切到那个槽位。 */
    function ImageBoard({ article, onSelect }) {
      if (!article) return null;
      const sections = Array.isArray(article.sections) ? article.sections : [];
      const slots = [{ slot: "cover", label: "封面", image: article.cover }]
        .concat(sections.map((section, index) => ({ slot: `sec-${section.id}`, label: `第 ${index + 1} 段`, image: section.image })));
      const withImage = slots.filter((row) => currentVersion(row.image)).length;
      return h("div", null,
        h("div", { className: "gzs-hint", style: { marginBottom: 8 } },
          `${withImage}/${slots.length} 个槽位有图 · 点一张切到那个槽位`),
        h("div", { className: "gzs-thumbs" },
          slots.map((row) => {
            const version = currentVersion(row.image);
            return h("figure", { key: row.slot, title: row.slot, onClick: () => onSelect?.(row.slot) },
              version
                ? h("img", { src: imageUrl(article.id, row.slot, version.vid), alt: row.label })
                : h("div", {
                  className: "gzs-docgap",
                  style: { margin: 0, height: 74, display: "flex", alignItems: "center", justifyContent: "center" },
                }, "缺图"),
              h("figcaption", null,
                h("span", null, row.label),
                h("span", null, version ? version.vid : "—")));
          })));
    }

    /** QA 列表渲染。空的时候说「这项没有拦路的问题」，而不是空白。 */
    function qaItems(items) {
      if (!items || !items.length) {
        return h("div", { className: "gzs-hint", style: { padding: "4px 0" } }, "这项暂时没有问题。");
      }
      return items.map((item, index) => h("div", { key: `${item.id}-${index}`, className: `gzs-qa gzs-qa--${item.level}` },
        h("div", { className: "gzs-qa__t" }, item.title),
        item.detail ? h("div", { className: "gzs-qa__d" }, item.detail) : null,
        h("div", { className: "gzs-qa__f" }, `改法：${item.fix}`)));
    }

    /** 记忆账本：最近 40 条，按时间倒序。 */
    function ledgerBlock(ledger, scope) {
      const rows = (Array.isArray(ledger) ? ledger : [])
        .filter((e) => !scope || !e.slot || e.slot === scope)
        .slice(-40)
        .reverse();
      if (!rows.length) return h("div", { className: "gzs-hint" }, "账本还是空的——出图、改稿、切版本都会记进来。");
      return h("div", { className: "gzs-ledger" }, rows.map((e, index) => h("div", { key: `${e.ts}-${index}`, className: "gzs-ledger__row" },
        h("span", { className: "gzs-ledger__ts" }, ago(e.ts)),
        h("span", { className: "gzs-ledger__txt" }, ledgerText(e)))));
    }

    /** 一条账本事件的人话。 */
    /**
     * 账本一行的人话。
     * @param {object} e 账本事件
     * @param {{brief?: boolean}} [options] `brief` 给首页的「最近动作」用：只留
     *   「谁出的 · 多大」，把尺寸吸附说明、prompt 摘掉——那两样在账本全量视图里有价值，
     *   挤在 300px 宽的动态栏里只会被截断。
     */
    function ledgerText(e, options) {
      const brief = Boolean(options?.brief);
      const slot = e.slot ? (e.slot === "cover" ? "封面" : `第 ${sectionIndex(e.slot)} 段`) : "";
      switch (e.type) {
        case "create": return `新建文章 · ${e.note ?? ""}`;
        case "save": {
          const fields = Array.isArray(e.fields) ? e.fields : [];
          // 绑定/解绑不是「改稿」，混在改稿里显示成「改稿 · pipeline:bound」既难读也不准确
          if (fields.includes("pipeline:bound")) return e.episodeId ? `绑定期号 ${e.episodeId}` : "绑定期号";
          if (fields.includes("pipeline:unbound")) return "解绑期号";
          return `改稿 · ${fields.slice(0, 4).join("，")}${fields.length > 4 ? "…" : ""}`;
        }
        case "generate": {
          // 账本一行要能扫完：谁出的、多大、什么提示词。
          // 占位图的 note 是「占位图：没有联网出图」，和节点名重复，只保留一次。
          const parts = [`${slot} 出图 → ${e.vid}`];
          const who = String(e.nodeName ?? e.node ?? "");
          parts.push(who && !/占位图/.test(who) ? who : "占位图");
          if (e.size) parts.push(String(e.size).replace("x", "×"));
          if (!brief && e.note && !/^占位图/.test(String(e.note))) parts.push(String(e.note));
          if (!brief && e.prompt) parts.push(`prompt「${String(e.prompt).slice(0, 36)}」`);
          return parts.join(" · ");
        }
        case "pick": return `${slot} 切到 ${e.vid}${e.from ? `（原 ${e.from}）` : ""}`;
        case "feedback": return `${slot} 反馈原话「${e.verbatim ?? ""}」`;
        case "script": return `Agent 写入讲稿 · ${e.sections ?? 0} 段`;
        case "export": return `导出 ${e.format}`;
        // 推草稿回执：文案必须说「进草稿箱」，不是「发布」——
        // 这两个词混用会让人以为已经发出去了。
        case "publish": {
          if (e.persisted === false) return "推草稿（模拟，没有真推）";
          const bits = ["推草稿 → 草稿箱"];
          if (!brief && e.chars) bits.push(`${Number(e.chars).toLocaleString()} 字符`);
          if (!brief && e.images) bits.push(`${e.images} 图`);
          return bits.join(" · ");
        }
        // 流水线绑定：这两条是真实操作，但原文是 `pipeline:bound`，
        // 直接漏到面板上就是一句英文黑话。绑定期号是件有意义的事，要写清楚绑了哪期。
        // 流水线绑定：这两条是真实操作，但原文是 `pipeline:bound`，
        // 直接漏到面板上就是一句英文黑话。绑定期号是件有意义的事，要写清楚绑了哪期。
        case "pipeline:bound": return `绑定期号 ${e.episodeId ?? ""}`.trim();
        case "pipeline:unbound": return "解绑期号";
        // 提案：`decision` 有 proposed / confirmed / rejected 三种，漏出英文就是「proposal」
        case "proposal": {
          const word = e.decision === "confirmed" ? "确认" : e.decision === "rejected" ? "驳回" : "提了";
          // 306px 宽的动态栏放不下「提了改稿提案 · 改 3 段 · 摘要」这种长句，
          // brief 口径只留动作和改动数，细节去治理视图看。
          const briefText = brief ? `${word}提案 · ${e.count ?? 0} 处` : `${word}改稿提案${e.summary ? ` · ${String(e.summary).slice(0, 24)}` : ""}`;
          return briefText;
        }
        default: return e.type ?? "事件";
      }
    }

    // ── 分栏宽度（用户自己拉）────────────────────────────────────────────────
    /**
     * 三栏宽度存本地。
     *
     * 为什么要有：三栏写死成 252 / 自适应 / 336，面板一窄（左栏展开对话吃掉 32%
     * 时最明显）右栏的「导出 HTML」就被挤到可视区外。有人要宽预览、有人要宽检查器，
     * 这不该由我们替所有人定。
     *
     * 约定：
     * - 默认 `null` = 用 CSS 里的默认值；用户拖过之后才写死像素，**不覆盖**用户的决定；
     * - 双击分隔条恢复默认（把那一栏删回 null，跟着 CSS 走）；
     * - 中栏保底 = MID_NEED（375 手机 + 两侧内边距），拖到头也不会把手机预览挤成一条缝。
     */
    const COL_STORE_KEY = "gzs.cols.v1";
    const SPLIT_W = 7;
    const COL_LIMITS = {
      // 左栏下限 200 不是拍脑袋：176 时「11 步」那几行的状态标签会被压成 14px，
      // 只能显示一个省略号——等于没有状态。200 才够「步骤号 + 名称 + 状态」三样并存。
      left: { min: 200, max: 520 },
      right: { min: 250, max: 720 },
      chat: { min: 300, max: 760 },
    };

    /** 读本地宽度；坏数据一律当没存过（宁可回默认，也不要半截数字把布局撑坏）。 */
    function readCols() {
      try {
        const raw = JSON.parse(localStorage.getItem(COL_STORE_KEY) || "{}");
        const out = {};
        for (const key of Object.keys(COL_LIMITS)) {
          const n = Number(raw?.[key]);
          if (Number.isFinite(n) && n > 0) out[key] = Math.round(n);
        }
        return out;
      } catch {
        return {};
      }
    }

    function saveCols(next) {
      try {
        localStorage.setItem(COL_STORE_KEY, JSON.stringify(next));
      } catch {
        /* 隐私模式下写不进去：本次仍然生效，只是记不住 */
      }
    }

    /** 手机预览要占的地方：375 手机宽度 + 中栏左右各 26 内边距。 */
    const MID_NEED = PHONE_WIDTH + 52;
    /**
     * 手动拖拽时中栏的**硬下限**（比 MID_NEED 低）。
     *
     * 为什么需要两个数：MID_NEED 是「够用」的标准，MID_FLOOR 是「还能看」的底线。
     * 只认 MID_NEED 的后果实测过——1680 窗口、左栏展开对话后工作区只剩 927px，
     * 左 200 + 右 250 + 中 427 + 两条分隔条 14 = 891，**只剩 36px 可拖**。
     * 于是往右拖 40px 就被夹回原处，用户看到的就是「拖了没反应，假动作」。
     * 手动拖拽是明确指令：中栏可以缩到 300，再不够才停下。
     */
    const MID_FLOOR = 300;

    /**
     * 没有任何用户设定时，三栏该多宽。
     *
     * 这一段是这次改版的真正理由：三栏原来写死 252 / 自适应 / 336，
     * 在 1680 的窗口里打开左侧对话后，工作区只剩约 927px，
     * 于是中栏被挤到 325px——比手机预览还窄，标题折成三行、右侧内容被裁掉。
     * 「按钮看不见」和「预览被切」是同一个病：**默认值没跟着可用空间走**。
     *
     * 规则：左右按比例取，各自夹在上下限之间；中栏保底 MID_NEED，
     * 不够就先压右栏、再压左栏。用户一旦手动拖过某一栏，那一栏就不再自动。
     */
    function autoCols(width) {
      if (!Number.isFinite(width) || width <= 0) {
        return { left: 252, right: 336 };
      }
      let left = Math.round(Math.min(252, Math.max(COL_LIMITS.left.min, width * 0.19)));
      let right = Math.round(Math.min(336, Math.max(COL_LIMITS.right.min, width * 0.26)));

      const over = left + right + MID_NEED + 2 * SPLIT_W - width;
      if (over <= 0) return { left, right };

      // 先让右栏让位（检查器可以窄一点，正文不能），再让左栏
      const cutRight = Math.min(over, right - COL_LIMITS.right.min);
      right -= cutRight;
      const rest = over - cutRight;
      if (rest > 0) left = Math.max(COL_LIMITS.left.min, left - rest);
      return { left, right };
    }

    /**
     * 把「用户存下来的宽度」夹进当下这块面板放得下的范围。
     *
     * 为什么不能直接用存的值：宽度是**偏好**，可用空间是**变量**。
     * 在 1680 窗口里把右栏拖到 720 挺好用，可一旦打开左侧对话（工作区只剩 927），
     * 再照 720 画，右栏就有三分之一跑到面板外面——这就是「导出按钮不见了」的来历。
     * 所以这里只改**呈现**，不改偏好：窗口变宽回来，仍按存的值显示。
     *
     * 让位顺序：先压用户没拖过的那一栏（自动值，压了不心疼），再压拖过的，
     * 各自不低于下限。
     *
     * 中栏用哪个闸门，取决于「是不是纯自动」：
     * - 用户一栏都没拖过 → MID_NEED。这是自动布局，目标就是把手机预览完整放下；
     *   拿 MID_FLOOR 去算会让窄面板把预览压到 300，图被缩、还偏出中线。
     * - 用户拖过某一栏 → MID_FLOOR。手动拖拽是明确指令，要给它真的空间，
     *   否则存下来的宽度会被悄悄改回自动值（用户看到的就是「拖了白拖」）。
     */
    function fitCols(want, width) {
      const auto = autoCols(width);
      const pick = (key, fallback) => {
        const raw = want?.[key] ?? fallback;
        const limit = COL_LIMITS[key];
        return Math.round(Math.min(limit.max, Math.max(limit.min, raw)));
      };
      let left = pick("left", auto.left);
      let right = pick("right", auto.right);
      if (!Number.isFinite(width) || width <= 0) return { left, right };

      const manual = want?.left != null || want?.right != null;
      let over = left + right + (manual ? MID_FLOOR : MID_NEED) + 2 * SPLIT_W - width;
      if (over <= 0) return { left, right };

      // 自动值先让位，手动值后让位
      const order = [
        ...(want?.left == null ? ["left"] : []),
        ...(want?.right == null ? ["right"] : []),
        ...(want?.left != null ? ["left"] : []),
        ...(want?.right != null ? ["right"] : []),
      ];
      for (const key of order) {
        if (over <= 0) break;
        const cur = key === "left" ? left : right;
        const cut = Math.min(over, cur - COL_LIMITS[key].min);
        if (cut <= 0) continue;
        if (key === "left") left -= cut;
        else right -= cut;
        over -= cut;
      }
      return { left, right };
    }

    /**
     * 清掉旧版本可能残留在 `body` 上的 `gzs-resizing`。
     *
     * 那条规则（整页 `cursor: col-resize !important`）已经删了，这里只是给**还开着旧包的页面**
     * 一个自愈机会：下次鼠标移动 / 按键时把它清掉，不让人卡在 ↔ 里。
     */
    function healResizeCursor(doc) {
      const body = doc?.body;
      if (!body?.classList?.contains?.("gzs-resizing")) return false;
      body.classList.remove("gzs-resizing");
      return true;
    }

    /**
     * 一条可拖拽的分隔条。
     *
     * 只负责「把鼠标位移交给上层」，不自己算宽度——宽度上限取决于另外两栏有多宽，
     * 那件事只有 Workspace 知道。
     *
     * 用 pointer 事件 + `setPointerCapture`：拖到分隔条外面（甚至拖出画布再回来）
     * 也不会断；用 mouse 事件则一滑出 7px 宽的区域就「粘住不动」。
     */
    function Splitter({ label, onStart, onDrag, onReset, invert = false }) {
      const drag = React.useRef(null);
      const listeners = React.useRef(null);

      /**
       * 收尾：清拖拽标记 + 摘掉 window 兜底。
       *
       * 单独抽出来，是因为收尾有**三条路**：元素上的 pointerup、window 上的兜底、
       * 以及组件卸载。少走一条，`body.gzs-resizing` 就会留在页面上——
       * 表现是「整个面板的光标都变成 ↔」，而且怎么点都不恢复。
       */
      const settle = () => {
        const state = drag.current;
        drag.current = null;
        document.body?.classList?.remove("gzs-resizing");
        if (state?.el) {
          try { state.el.releasePointerCapture?.(state.pointerId); } catch { /* 已经松了 */ }
          try { delete state.el.dataset.dragging; } catch { /* 元素没了 */ }
        }
        listeners.current?.();
        listeners.current = null;
      };

      // 卸载也要收尾：拖到一半切走页面，不该把整页锁成 col-resize。
      React.useEffect(() => () => settle(), []);

      const begin = (event) => {
        if (event.button !== 0 && event.pointerType === "mouse") return;
        settle(); // 上一次没清干净的先清掉，避免叠着两个拖拽会话
        drag.current = { x: event.clientX, start: onStart(), pointerId: event.pointerId, el: event.currentTarget };
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 老宿主没有，退化成普通拖动 */ }
        event.currentTarget.dataset.dragging = "true";
        // 不再往 body 加 `gzs-resizing`：那条全局 col-resize 规则已经删了，
        // 锁定现在只靠分隔条自己的 cursor + 指针捕获，漏收尾也不会污染整页。
        // 指针在窗口外松手时，元素上的 pointerup 收不到——补一层 window 兜底。
        const onUp = () => settle();
        window.addEventListener?.("pointerup", onUp, { once: true });
        window.addEventListener?.("pointercancel", onUp, { once: true });
        window.addEventListener?.("blur", onUp, { once: true });
        listeners.current = () => {
          window.removeEventListener?.("pointerup", onUp);
          window.removeEventListener?.("pointercancel", onUp);
          window.removeEventListener?.("blur", onUp);
        };
        event.preventDefault();
      };
      const move = (event) => {
        if (!drag.current) return;
        // 右栏的分隔条在它**左边**：往右拖是把它挤窄，不是变宽。
        const delta = (event.clientX - drag.current.x) * (invert ? -1 : 1);
        onDrag(drag.current.start + delta);
      };
      const end = () => settle();
      const key = (event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          // 右栏反相：← 是「把边界往左拉」，右栏变宽。
          const step = (event.shiftKey ? 48 : 16) * (event.key === "ArrowLeft" ? -1 : 1) * (invert ? -1 : 1);
          onDrag(onStart() + step);
          return;
        }
        if (event.key === "Home" || event.key === "Delete") {
          event.preventDefault();
          onReset();
        }
      };

      return h("div", {
        className: "gzs-split",
        role: "separator",
        "aria-orientation": "vertical",
        "aria-label": label,
        tabIndex: 0,
        title: `${label}：拖动调整宽度 · 双击恢复默认（聚焦后 ←/→ 也可微调）`,
        onPointerDown: begin,
        onPointerMove: move,
        onPointerUp: end,
        onPointerCancel: end,
        onDoubleClick: onReset,
        onKeyDown: key,
      }, h("span", { className: "gzs-split__grip", "aria-hidden": "true" }));
    }
    // ── 主面板 ────────────────────────────────────────────────────────────────
    /**
     * 工作台根组件。**所有状态都在这里**，子组件只收 props（受控），
     * 这样「面板上看到的就是宿主里存的」这条才有单一事实源。
     *
     * 数据流：挂载 → /state（文章列表 + 模板 + 节点）→ 选第一篇 → /article（全文 + QA + 账本）
     * 改动 → POST → 用返回值整体替换（后端返回什么就显示什么，不做本地乐观更新）。
     */
    // ── 跟随宿主主题 ──────────────────────────────────────────────────────────
    //
    // 工作台原来写死一套「米绿纸色」，宿主切深色或换背景时，它就像贴上去的一层。
    // 这里不去猜宿主怎么切主题（class / data-* / 自定义 token 各家不同），
    // 而是**采样面板实际背后的颜色**：往上找到第一个不透明的背景色，
    // 按亮度选深 / 浅两套调色板，纸色直接用宿主背景。
    // 这样任何主题、任何自定义背景都能贴合，也不依赖未公开的宿主内部约定。

    /** 解析 CSS 颜色（#rgb / #rrggbb / rgb() / rgba()）→ [r,g,b]；透明返回 null。 */
    function parseCssColor(value) {
      const text = String(value ?? "").trim();
      if (!text) return null;
      let match = /^#([0-9a-f]{3,8})$/i.exec(text);
      if (match) {
        const hex = match[1];
        if (hex.length === 3 || hex.length === 4) {
          return [0, 1, 2].map((i) => parseInt(hex[i] + hex[i], 16));
        }
        if (hex.length === 6 || hex.length === 8) {
          return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
        }
        return null;
      }
      match = /^rgba?\(([^)]+)\)$/i.exec(text);
      if (match) {
        const parts = match[1].split(/[,/\s]+/).map((part) => part.trim()).filter(Boolean);
        if (parts.length < 3) return null;
        const channels = parts.slice(0, 3).map((part) => (
          part.endsWith("%") ? Math.round(parseFloat(part) * 2.55) : Math.round(parseFloat(part))
        ));
        if (channels.some((n) => !Number.isFinite(n))) return null;
        const alpha = parts[3] === undefined
          ? 1
          : (parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]));
        if (Number.isFinite(alpha) && alpha === 0) return null;
        return channels.map((n) => Math.max(0, Math.min(255, n)));
      }
      return null;
    }

    /** WCAG 相对亮度：0（黑）～1（白）。 */
    function luminanceOf(rgb) {
      const [r, g, b] = rgb.map((channel) => {
        const c = channel / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }

    /** 背景偏暗就用深色板。阈值 0.42：中灰（#808080≈0.22）算暗。 */
    function themeFromRgb(rgb) {
      return luminanceOf(rgb) < 0.42 ? "dark" : "light";
    }

    /** 两个颜色按比例混（weight 是 to 的占比）。 */
    function mixRgb(from, to, weight) {
      const w = Math.max(0, Math.min(1, weight));
      return from.map((channel, i) => Math.round(channel * (1 - w) + to[i] * w));
    }

    const rgbText = (rgb) => `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;

    /** HSL 饱和度（0～1）：用来判断宿主背景是不是「彩色主题」。 */
    function saturationOf(rgb) {
      const [r, g, b] = rgb.map((channel) => channel / 255);
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const l = (max + min) / 2;
      if (max === min) return 0;
      const d = max - min;
      return l > 0.5 ? d / (2 - max - min) : d / (max + min);
    }

    /**
     * 染色权重：常规 4%（深色 3% 提亮），宿主背景明显带彩时减半。
     *
     * 蓝紫主题上再压一层绿会显得脏——「跟随」是跟随明暗与色温，不是把宿主的颜色照抄。
     */
    function tintWeightFor(mode, hostBg) {
      const base = mode === "dark" ? 0.03 : 0.04;
      const sat = Array.isArray(hostBg) ? saturationOf(hostBg) : 0;
      return sat > 0.25 ? base / 2 : base;
    }

    /**
     * 面板调色板：**跟随宿主的明暗与色温，但不逐像素同色**。
     *
     * 纸色 = 宿主背景压一层很轻的倾向色（浅色压墨绿、深色提亮），
     * 卡片再亮一档——「卡片与纸有且只有一档差」是层次的全部来源；
     * 全等于宿主背景，顶栏、卡片、画布会糊成一片，看着像没做完。
     */
    function paletteFor(mode, hostBg) {
      const host = Array.isArray(hostBg) && hostBg.length === 3
        ? hostBg
        : (mode === "dark" ? [16, 22, 18] : [238, 243, 236]);
      const white = [255, 255, 255];
      const weight = tintWeightFor(mode, host);
      if (mode === "dark") {
        return {
          "--gzs-paper": rgbText(mixRgb(host, white, weight)),
          "--gzs-paper2": rgbText(mixRgb(host, white, 0.055)),
          "--gzs-card": rgbText(mixRgb(host, white, 0.09)),
          "--gzs-card2": rgbText(mixRgb(host, white, 0.045)),
          "--gzs-ink": "#e6efe9", "--gzs-body": "#c3d2c9",
          "--gzs-muted": "#8ea69a", "--gzs-faint": "#6d8377",
          "--gzs-line": rgbText(mixRgb(host, white, 0.14)),
          "--gzs-line2": rgbText(mixRgb(host, white, 0.08)),
          "--gzs-teal": "#6fb894", "--gzs-teal-deep": "#4f9a78", "--gzs-cyan": "#7cc79b", "--gzs-gold": "#d3a45f",
          "--gzs-tint": "#1d3328", "--gzs-tint2": "#182a21",
          "--gzs-red": "#e08a7e", "--gzs-green": "#6fb894",
          "--gzs-ok": "#6fb894", "--gzs-ok-soft": "#173026", "--gzs-ok-line": "#27503c",
          "--gzs-warn": "#d3a45f", "--gzs-warn-soft": "#2c2417", "--gzs-warn-line": "#4a3a22",
          "--gzs-err": "#e08a7e", "--gzs-err-soft": "#2f1d1a", "--gzs-err-line": "#54302a",
        };
      }
      return {
        "--gzs-paper": rgbText(mixRgb(host, [23, 54, 42], weight)),
        "--gzs-paper2": rgbText(mixRgb(host, white, 0.55)),
        "--gzs-card": rgbText(mixRgb(host, white, 0.9)),
        "--gzs-card2": rgbText(mixRgb(host, white, 0.65)),
        "--gzs-ink": "#17362a", "--gzs-body": "#33503f",
        "--gzs-muted": "#566e5f", "--gzs-faint": "#81968a",
        "--gzs-line": rgbText(mixRgb(host, [23, 54, 42], 0.12)),
        "--gzs-line2": rgbText(mixRgb(host, [23, 54, 42], 0.06)),
        "--gzs-teal": "#33724f", "--gzs-teal-deep": "#2b6344", "--gzs-cyan": "#4a9169", "--gzs-gold": "#a8742b",
        "--gzs-tint": "#e6f0e5", "--gzs-tint2": "#f0f6ef",
        "--gzs-red": "#a5453a", "--gzs-green": "#33724f",
        "--gzs-ok": "#33724f", "--gzs-ok-soft": "#eaf3ec", "--gzs-ok-line": "#cfe2d6",
        "--gzs-warn": "#a8742b", "--gzs-warn-soft": "#f6efe1", "--gzs-warn-line": "#e8d9bd",
        "--gzs-err": "#a5453a", "--gzs-err-soft": "#f7eae7", "--gzs-err-line": "#e8cdc7",
      };
    }

    /** 从面板往上找第一个不透明的背景色（找不到再用宿主 token / body）。 */
    function sampleBackdrop(el, win) {
      if (!el || !win?.document) return null;
      const doc = win.document;
      // **从父元素开始找**：面板自己的背景就是我们写上去的纸色。
      // 从自己开始，会把「上一轮算出来的颜色」当成宿主背景再染一次——
      // 每切一次主题就暗一点、绿一点，而且很难看出是 bug（只会觉得「越用越脏」）。
      let node = el.parentElement ?? null;
      while (node && node !== doc.documentElement) {
        // 面板内部的元素也不纳入采样（它们用的是我们的变量），否则同样会自我叠加。
        const insidePanel = typeof node.closest === "function" && node.closest(".gzs-root");
        if (!insidePanel) {
          const color = parseCssColor(win.getComputedStyle(node).backgroundColor);
          if (color) return color;
        }
        node = node.parentElement;
      }
      if (doc.body) {
        const bodyColor = parseCssColor(win.getComputedStyle(doc.body).backgroundColor);
        if (bodyColor) return bodyColor;
        const token = parseCssColor(win.getComputedStyle(doc.body).getPropertyValue("--dsw-alias-bg-base"));
        if (token) return token;
      }
      return null;
    }

    /** 把调色板写成行内变量 + 标记模式；color-scheme 让滚动条和原生控件一起变。 */
    function applyThemeTo(el, mode, hostBg) {
      if (!el?.style) return;
      const tokens = paletteFor(mode, hostBg);
      for (const [key, value] of Object.entries(tokens)) el.style.setProperty(key, value);
      el.dataset.gzsTheme = mode;
      el.style.colorScheme = mode;
    }

    function Workspace(props = {}) {
      const [boot, setBoot] = React.useState({ loading: true, error: "", list: [], activity: [], templates: [], nodes: [], settings: null, root: "" });
      const [view, setView] = React.useState(null);          // /article 的整包
      const [activeId, setActiveId] = React.useState("");
      const [selected, setSelected] = React.useState("article");
      const [busy, setBusy] = React.useState(false);
      const [toast, setToast] = React.useState("");
      const [creating, setCreating] = React.useState(false);
      // 打开中的提案详情（含逐段对照）。只存一份：面板一次只让人看一份对照。
      const [proposalDetail, setProposalDetail] = React.useState(null);
      /**
       * 视图：home（全部文章卡片）/ article（三栏编辑）/ governance（治理）。
       * 初值是 article —— 打开面板直接落到最近一篇的三栏，和「历史工作台」一致，
       * 不让用户先看一个首页再点一次。库里一篇都没有、或人主动点了「全部文章」时
       * 才落到 home（见 body 那段的分支）。
       * 注意：loadArticle 只负责取数据，不负责切视图；切视图由用户动作决定。
       */
      const [screen, setScreen] = React.useState("article");
      // 内容线：公众号（工作台）+ 视频号（只读看板）。两条线共用一个面板，顶部一条切换。
      const [channel, setChannel] = React.useState("article");
      // 视频号是自读盘的独立组件：换 key 即重新挂载 = 重新拉一次（「刷新」按钮用）
      const [videoEpoch, setVideoEpoch] = React.useState(0);
      /**
       * 右栏检查器当前停在哪个 tab（证据 / 图 / 元信息）。
       *
       * 状态放在这里而不是 Inspector 里：顶部那条「N 份提案待确认 · 去检查」要能把 tab
       * 切到对应面板。tab 藏在子组件里的话，跳转只能滚到空气。
       */
      const [inspTab, setInspTab] = React.useState("evidence");
      /**
       * 左栏「原生对话」开不开。
       *
       * 这是 Deckline 那个形态的关键：**面板不占掉对话列**，而是自己把 DSH 原生对话
       * 拉进来当左栏。聊天是原生的——权限、附件、模型、思考过程、流式输出、气泡
       * 全是宿主那一套，我这边一行都不用仿。
       * 关闭时退回纯工作台（宽屏看排版更舒服），选择记在本地。
       */
      const [chatOpen, setChatOpen] = useChatOpen();
      /** 往期抽屉：点顶栏「往期」就地看仓库真源，不用离开当前稿件去首页。 */
      const [repoOpen, setRepoOpen] = React.useState(false);
      /** 推草稿对话框：没配公众号时它就是配置向导，配好了就是推前自查。 */
      const [pushOpen, setPushOpen] = React.useState(false);
      /** 出图节点配置：首启向导第 2 步用。 */
      const [nodeOpen, setNodeOpen] = React.useState(false);
      /** 「检查」抽屉：QA / 提案 / 清单 / 账本集中看，不再是独立视图。 */
      const [inspectOpen, setInspectOpen] = React.useState(false);
      /** 「发布包」：一稿多投的出口（小红书 / 抖音 / 快手 出包复制，公众号直推）。 */
      const [packOpen, setPackOpen] = React.useState(false);
      // 抽屉开着时 Esc 关掉：不给这个键，人只能去点遮罩或按钮。
      React.useEffect(() => {
        if (!repoOpen) return undefined;
        const onKey = (event) => { if (event?.key === "Escape") setRepoOpen(false); };
        window.addEventListener?.("keydown", onKey);
        return () => window.removeEventListener?.("keydown", onKey);
      }, [repoOpen]);
      // 「检查」抽屉同理：Esc 关掉。
      React.useEffect(() => {
        if (!inspectOpen) return undefined;
        const onKey = (event) => { if (event?.key === "Escape") setInspectOpen(false); };
        window.addEventListener?.("keydown", onKey);
        return () => window.removeEventListener?.("keydown", onKey);
      }, [inspectOpen]);
      // 跟随宿主主题：挂上去就采样背后的颜色；宿主换主题 / 换背景时重采。
      React.useEffect(() => {
        const root = colRefs.current.root;
        if (!root || typeof window === "undefined") return undefined;
        const apply = () => {
          const bg = sampleBackdrop(root, window);
          const mode = bg
            ? themeFromRgb(bg)
            : (window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light");
          applyThemeTo(root, mode, bg);
        };
        apply();
        const mo = typeof MutationObserver === "function" ? new MutationObserver(() => apply()) : null;
        const filter = { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-appearance"] };
        mo?.observe(document.documentElement, filter);
        if (document.body) mo?.observe(document.body, filter);
        const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
        mq?.addEventListener?.("change", apply);
        return () => { mo?.disconnect(); mq?.removeEventListener?.("change", apply); };
      }, []);
      // 自愈：`body` 还锁着拖拽光标、但页面上已经没有拖拽时，鼠标一动就清掉。
      // 这是「整页光标变 ↔」的最后一道保险——不指望每次都能收到 pointerup。
      React.useEffect(() => {
        if (typeof window === "undefined") return undefined;
        const heal = () => { healResizeCursor(document); };
        window.addEventListener?.("pointermove", heal, { passive: true });
        window.addEventListener?.("pointerdown", heal, { passive: true });
        window.addEventListener?.("keydown", heal);
        heal();
        return () => {
          window.removeEventListener?.("pointermove", heal);
          window.removeEventListener?.("pointerdown", heal);
          window.removeEventListener?.("keydown", heal);
        };
      }, []);
      const [context, setContext] = React.useState({ kind: "article", id: "", label: "新媒体工作台" });
      const contextLabel = context.label || (context.kind === "video" ? "视频号" : "新媒体工作台");
      const toggleChat = () => setChatOpen(!chatOpen);

      /**
       * 左栏（步骤 + 结构）收不收起来。
       *
       * 对话一开，工作区只剩一半宽：左 252 + 中 427 + 右 336 + 两条分隔条 = 1029，
       * 1680 的窗口里一开对话就横向滚动，手机预览被挤到边上。用户的原话是
       * 「中间是对话、右边是面板」——所以对话开着时默认把左栏让出去，预览吃满。
       * 想边看步骤边改，顶栏「≡ 步骤」一键收回。
       */
      const [railOpen, setRailOpen] = React.useState(true);
      React.useEffect(() => { if (chatOpen) setRailOpen(false); }, [chatOpen]);
      // 只关「左栏」；对话关着时它就是完整工作台的一部分，用户也可以手动收起换成专注预览。
      const railVisible = railOpen;

      /**
       * 左栏那条会话：**本工作台自己的**，按线（公众号 / 视频号）绑一条。
       *
       * 以前这里嵌的是同源 iframe `/?gzhChat=1`，那个实例按 `dsh.sessions.current`
       * 恢复「上次看的那条会话」，于是工作台里显示的是别的任务的对话。现在是会话内嵌：
       * 自己 retain、自己检查（目录不对、被移除就重开），没有就新建一条空白会话。
       *
       * cwd 取 **pipelineRoot（产线根，文章仓在那儿）**，不是 `root`：后者是插件的
       * 数据目录（`~/.dsh/gzh-studio`），拿它当工作目录，宿主会认为「这个目录不是任何
       * 工作区」，于是对话区只显示一句「选择一个工作区开始」——实测踩过。
       */
      const chatRoot = boot.pipelineRoot || boot.root || "";
      const useWorkspaces = typeof props?.useWorkspaces === "function" ? props.useWorkspaces : () => undefined;
      const workspaceItems = useWorkspaces((state) => state?.items);
      const chatWorkspaceId = React.useMemo(() => {
        const target = normalizeChatPath(chatRoot);
        if (!target) return null;
        return (workspaceItems ?? []).find((item) => normalizeChatPath(item?.path) === target)?.workspaceId ?? null;
      }, [workspaceItems, chatRoot]);
      const chatLine = channel === "video" ? "video" : "article";
      const chat = useChatSession(chatRoot || null, chatWorkspaceId, chatOpen, chatLine);
      const useSessionStatus = typeof props?.useSessionStatus === "function" ? props.useSessionStatus : () => undefined;
      const chatSessionId = chat.reference?.sessionId ?? null;
      const chatRunning = useSessionStatus((map) => Boolean(chatSessionId && map?.get?.(chatSessionId)?.running)) === true;

      /**
       * 三栏 + 对话列的用户宽度（px）。键不存在 = 走 CSS 默认值。
       * 用 ref 存节点是为了拖动开始时量「当前真实宽度」——CSS 里还有 media query
       * 和 clamp()，猜默认值会一上手就跳一下。
       */
      const [cols, setCols] = React.useState(readCols);
      const colRefs = React.useRef({ left: null, right: null, chat: null, body: null, root: null });
      /** 工作区当前可用宽度：决定三栏的默认分配（用户拖过的栏不受影响）。 */
      const [bodyW, setBodyW] = React.useState(0);

      React.useEffect(() => {
        const node = colRefs.current.body;
        if (!node) return undefined;
        const apply = () => {
          const width = node.getBoundingClientRect?.().width;
          if (Number.isFinite(width) && width > 0) setBodyW(Math.round(width));
        };
        apply();
        if (typeof ResizeObserver !== "function") {
          window.addEventListener?.("resize", apply);
          return () => window.removeEventListener?.("resize", apply);
        }
        const ro = new ResizeObserver(apply);
        ro.observe(node);
        return () => ro.disconnect();
        // 换视图 / 开关对话都会换掉 body 节点，必须重新挂。
        //
        // `Boolean(view?.article)` 这个依赖是补的，不是凑数：首屏 screen 就是 article，
        // 但文章还没拉回来时渲染的是 Home，根本没有 .gzs-body —— 那时 effect 抓到 null
        // 直接 return，等文章到了 body 出现，依赖不变就不会重跑，ResizeObserver 永远没挂上。
        // 结果 bodyW 恒为 0，autoCols 一路走兜底 252/336，面板窄一点右栏就被挤到外面。
      }, [screen, channel, chatOpen, creating, Boolean(view?.article)]);

      /** 用户设过的优先；没设过就按可用宽度算。算完还要按当下空间夹一遍。 */
      const fitted = fitCols(cols, bodyW);
      const leftW = fitted.left;
      const rightW = fitted.right;
      /**
       * 用户拖过某一栏没有。
       *
       * 「拖过」和「没拖过」是两种意图，同一个下限兼不了：
       * - 没拖过 = 自动布局，目标是把 375 的手机预览完整放下（中栏 427），
       *   放不下就整排横向滚，不缩预览；
       * - 拖过 = 明确指令，目标改成「真的拖得动」（中栏 300），否则存下来的宽度
       *   会被 427 顶回去，用户看到的就是「拖了白拖」。
       * 所以中栏渲染时按这个决定要不要叠一个内联 min-width（见下面的 gzs-col--mid）。
       */
      const wantsManual = cols.left != null || cols.right != null;
      /**
       * 三栏在当前宽度下是否真的放得下。
       *
       * `overflow-x:auto` 是保底手段，但滚动条会随 `--hide-scrollbars` 之类被藏掉，
       * 用户看到的就是「右边那一栏不见了」。所以放不下时要**说出来**，
       * 而不是指望人去发现还能横向滚。
       */
      const [bodyOver, setBodyOver] = React.useState(false);
      React.useEffect(() => {
        const node = colRefs.current.body;
        if (!node) return;
        setBodyOver(node.scrollWidth - node.clientWidth > 2);
      }, [leftW, rightW, bodyW, chatOpen, screen, channel, creating]);

      const measure = (key, fallback) => {
        const node = colRefs.current[key];
        const width = node?.getBoundingClientRect?.().width;
        return Number.isFinite(width) && width > 0 ? width : fallback;
      };

      /**
       * 把想要的宽度夹进「合法且不挤死中栏」的区间。
       *
       * 只夹目标那一栏、并且**以下限优先**：宁可中栏短一点，也不能把某一栏拖到看不见。
       */
      const clampCol = (key, want) => {
        const limit = COL_LIMITS[key];
        if (!limit) return Math.round(want);
        let next = Math.round(Math.min(limit.max, Math.max(limit.min, want)));

        const bodyWidth = bodyW || measure("body", 0);
        const rootWidth = measure("root", 0);

        if (key === "chat") {
          // 对话列变宽时，右边的工作台至少要留 520（三栏再挤就没法用了）
          const room = rootWidth - 520 - SPLIT_W;
          if (room > limit.min) next = Math.min(next, Math.round(room));
          return Math.max(limit.min, next);
        }

        /**
         * 三栏能用的总宽就是 body 自己的宽度。
         *
         * 这里曾经写成 `body 宽 - 对话列 - 3 条分隔条`，等于**把对话列扣了两次**：
         * body 是对话列右边的兄弟节点，它的宽度本来就不含对话列。结果中栏永远算出一个
         * 几百像素的假亏空，任何一栏拖宽都被立刻压回下限——表现就是「拖不动」，
         * 而 localStorage 里存回的仍是原值，看起来像没反应。
         *
         * 现在只按**中栏硬下限 MID_FLOOR** 算上限：拖宽的那一栏能吃掉中栏多出来的
         * 余量，吃到 300 为止。以前拿 MID_NEED(427) 当闸门，在真实窗口下余量常常
         * 只有 36px，等于没有——这也是「假动作」的另一半原因。
         */
        const avail = bodyWidth || rootWidth;
        if (avail > 0) {
          const other = key === "left" ? rightW : leftW;
          const room = avail - other - MID_FLOOR - 2 * SPLIT_W;
          if (Number.isFinite(room)) next = Math.min(next, Math.round(room));
        }
        return Math.max(limit.min, next);
      };

      const dragCol = (key, want) => {
        const next = clampCol(key, want);
        setCols((prev) => (prev[key] === next ? prev : { ...prev, [key]: next }));
      };

      const resetCol = (key) => {
        setCols((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      };

      /**
       * 落盘延后 200ms：拖动时每帧都会 setCols，但 localStorage 是同步写，
       * 逐帧写会在拖动最顺的那几帧里卡一下。松手后写一次就够。
       */
      React.useEffect(() => {
        const timer = window.setTimeout(() => saveCols(cols), 200);
        return () => window.clearTimeout(timer);
      }, [cols]);

      const say = (text) => {
        setToast(text);
        // 3 秒后自己消失；不引第三方 toast 库
        setTimeout(() => setToast((prev) => (prev === text ? "" : prev)), 3000);
      };

      /** 拉全量状态；`keep` 为真时保留当前选中（刷新用）。 */
      const loadState = async (keep = false, filter = null) => {
        try {
          // 筛选与搜索走查询参数：服务端过滤（正文检索串不下发），前端只收命中项
          const f = filter ?? boot.filters ?? { state: "all", q: "" };
          const qs = new URLSearchParams();
          if (f.state && f.state !== "all") qs.set("state", f.state);
          if (f.q) qs.set("q", f.q);
          if (f.tag) qs.set("tag", f.tag);
          if (f.month) qs.set("month", f.month);
          if (f.track) qs.set("track", f.track);
          const data = await getJson(`${ROUTES.state}${qs.toString() ? `?${qs}` : ""}`);
          setBoot({ loading: false, error: "", list: data.articles ?? [], activity: data.activity ?? [], counts: data.counts ?? null, filters: data.filters ?? null, matched: data.matched ?? null, templates: data.templates ?? [], nodes: data.settings?.nodes ?? [], settings: data.settings ?? null, pipelineRoot: data.settings?.pipelineRoot ?? "", root: data.root ?? "", tracks: data.tracks ?? [] });
          const nextId = keep && data.articles?.some((a) => a.id === activeId) ? activeId : (data.articles?.[0]?.id ?? "");
          if (nextId) await loadArticle(nextId);
          else setView(null);
        } catch (error) {
          setBoot((prev) => ({ ...prev, loading: false, error: error.message }));
        }
      };

      /** 拉单篇。 */
      const loadArticle = async (id) => {
        if (!id) return;
        try {
          const data = await getJson(`${ROUTES.article}?id=${encodeURIComponent(id)}`);
          setView(data);
          setActiveId(id);
          setContext({ kind: "article", id, label: `${data.article?.title || id} · 公众号` });
          // 换文章（或刷新）后旧提案的对照已经不属于当前这篇，收起
          setProposalDetail(null);
        } catch (error) {
          say(`读文章失败：${error.message}`);
        }
      };

      React.useEffect(() => { loadState().catch(() => {}); }, []);

      /**
       * 实时同步：宿主的写盘事件走 SSE 推下来（`/api/gzh-studio.stream`）。
       * 收不到就安静退回手动刷新——不弹错、不狂重连，老宿主照样能用。
       */
      const lastWriteRef = React.useRef(0);
      const [live, setLive] = React.useState("off");
      // loadState 每次渲染都是新函数，而 effect 只挂一次；用 ref 拿「最新那版」，
      // 否则闭包里是首渲染的 activeId（空），刷新会把人从当前这篇文章切走。
      const loadStateRef = React.useRef(loadState);
      loadStateRef.current = loadState;
      React.useEffect(() => {
        if (typeof EventSource !== "function") { setLive("off"); return undefined; }
        let source = null;
        let closed = false;
        let timer = 0;
        let retryTimer = 0;
        let attempt = 0;
        const flush = () => {
          timer = 0;
          if (closed) return;
          // 自己刚写完：POST 的返回值已经把视图换过了，再拉一次只会闪。
          if (Date.now() - lastWriteRef.current < 800) return;
          loadStateRef.current(true).catch(() => {});
        };
        const connect = () => {
          if (closed) return;
          try { source = new EventSource(ROUTES.stream); } catch { setLive("off"); return; }
          source.onopen = () => { if (!closed) { attempt = 0; setLive("live"); } };
          source.onmessage = (event) => {
            let payload = null;
            try { payload = JSON.parse(event.data); } catch { return; }
            if (payload?.kind === "hello") { setLive("live"); return; }
            if (payload?.kind === "ping") return;
            if (timer) return;
            timer = window.setTimeout(flush, 260);
          };
          source.onerror = () => {
            try { source.close(); } catch { /* 已关 */ }
            if (closed) return;
            attempt += 1;
            // 宿主重启 / 断网：退避重连三次，别让指示灯一直卡在「手刷」。
            // 三次都失败（多半是宿主旧版没有这条路由）就停在「手刷」，不再骚扰。
            if (attempt <= 3) {
              setLive("off");
              retryTimer = window.setTimeout(connect, [4000, 10000, 25000][attempt - 1]);
            } else {
              setLive("dead");
            }
          };
        };
        connect();
        return () => {
          closed = true;
          if (timer) window.clearTimeout(timer);
          if (retryTimer) window.clearTimeout(retryTimer);
          try { source?.close(); } catch { /* 已关 */ }
        };
      }, []);

      /** 统一的写操作包装：置忙、跑请求、拿返回值替换视图、失败弹字。 */
      const write = async (fn, okText) => {
        setBusy(true);
        // 记一笔「我刚写过」：SSE 会跟着把这次写当成外部事件推回来，别自己刷自己。
        lastWriteRef.current = Date.now();
        try {
          await fn();
          if (okText) say(okText);
        } catch (error) {
          say(error.message);
        } finally {
          lastWriteRef.current = Date.now();
          setBusy(false);
        }
      };

      const article = view?.article ?? null;
      const qa = view?.qa ?? null;
      const ledger = view?.ledger ?? [];
      const templates = boot.templates?.length ? boot.templates : (view?.templates ?? []);
      const nodes = view?.nodes?.length ? view.nodes : boot.nodes;

      const onSaveArticle = (patch) => write(async () => {
        const result = await postJson(ROUTES.save, { id: article.id, patch });
        setView((prev) => ({ ...prev, article: result.article, qa: result.qa }));
        // 列表里的标题/时间要跟着变
        setBoot((prev) => ({ ...prev, list: prev.list.map((a) => (a.id === result.article.id ? { ...a, title: result.article.title, updatedAt: result.article.updatedAt } : a)) }));
      });

      // 段落保存：语义与上面一致，只是包一层 sections 数组
      const onSaveSection = (id, patch) => onSaveArticle({ sections: [{ id, ...patch }] });

      const onSaveSlot = (slot, patch) => write(async () => {
        const result = await postJson(ROUTES.save, { id: article.id, patch: { slot: { slot, ...patch } } });
        setView((prev) => ({ ...prev, article: result.article, qa: result.qa }));
      });

      /**
       * 绑定/解绑流水线。
       * 绑定走 `save` 的 pipeline patch —— 服务端在那一刻把正文哈希钉下来，
       * 所以「绑完又改字」能被 `drift` 立刻看出来。
       */
      const onBindPipeline = (binding) => write(async () => {
        const result = await postJson(ROUTES.save, { id: article.id, patch: { pipeline: binding } });
        const fresh = await getJson(`${ROUTES.pipeline}?id=${article.id}`);
        setView((prev) => ({ ...prev, article: result.article, qa: result.qa, pipeline: fresh }));
      }, binding.episodeId ? "已绑定期号，状态是查盘得出的" : "已解绑");

      /** 重算状态：只读盘、不写盘。做完某一步点一下，就知道那道门过了没有。 */
      const onPipelineRefresh = () => write(async () => {
        const fresh = await getJson(`${ROUTES.pipeline}?id=${article.id}`);
        setView((prev) => ({ ...prev, pipeline: fresh }));
      });

      const onGenerate = ({ slot, node, size, prompt, negative, feedbackKeys }) => write(async () => {
        const result = await postJson(ROUTES.generate, { id: article.id, slot, node, size, prompt, negative, feedbackKeys });
        await loadArticle(article.id);
        // 带上几条反馈要说出来。不说的话，用户不知道「我上次那句话到底生效了没」——
        // 那正是这一轮改造要解决的事，静默地把话咽下去等于没做。
        const carried = Array.isArray(result.carried) ? result.carried.length : 0;
        say(`${slot === "cover" ? "封面" : `第 ${sectionIndex(slot)} 段`} 出了 ${result.version.vid}${carried ? `，带上 ${carried} 条反馈` : ""}`);
      }, "出图完成");

      const onPick = (slot, vid) => write(async () => {
        const result = await postJson(ROUTES.pick, { id: article.id, slot, vid });
        setView((prev) => ({ ...prev, article: result.article, qa: result.qa }));
        say(`当前版本切到 ${vid}`);
      });

      const onFeedback = (payload) => write(async () => {
        const result = await postJson(ROUTES.feedback, { id: article.id, ...payload });
        setView((prev) => ({ ...prev, ledger: result.ledger, feedback: result.feedback }));
        say("记下了，下次出图会自动带上");
      });

      /**
       * 采纳去 AI 味的几句。
       *
       * **不直接改正文**：走 `adoptDeai` 落一份提案，人再确认。
       * 理由和提案那一层一致——一次误点就把别人的稿子改掉，代价太大。
       * 勾选传的是「哪段、段内偏移、改后句子」，拼接在宿主侧做（两边各算一次必然漂）。
       */
      const onAdoptDeai = (accepted) => write(async () => {
        const result = await postJson(ROUTES.adoptDeai, { id: article.id, accepted });
        setView((prev) => ({ ...prev, proposals: result.proposals ?? prev.proposals }));
        // 不自动弹对照：一次勾十句，弹出十份对照反而挡路。文案里给出 pid，
        // 人想核对时去「整篇」的提案卡里点开（那里本来就有红绿对照）。
        say(`已生成提案 ${result.proposal.pid}，确认后才会改进正文`);
      }, "已生成提案");

      /**
       * 05/06 清单勾一项。
       *
       * 勾完立刻用服务端回的 pipeline 覆盖本地：门变了状态词会变，
       * 前端自己推一遍「勾满就绿」迟早跟服务端不一致。
       */
      const onToggleReview = ({ kind, item, checked }) => write(async () => {
        const result = await postJson(ROUTES.review, { id: article.id, kind, item, checked });
        setView((prev) => ({ ...prev, reviews: result.reviews, pipeline: result.pipeline }));
      });

      const onTemplate = (template) => write(async () => {
        const result = await postJson(ROUTES.save, { id: article.id, patch: { template } });
        setView((prev) => ({ ...prev, article: result.article }));
      });

      const onDeleteSection = (id) => write(async () => {
        const result = await postJson(ROUTES.save, { id: article.id, patch: { removeSections: [id] } });
        setView((prev) => ({ ...prev, article: result.article, qa: result.qa }));
        setSelected("article");
      });

      const onAddSection = () => write(async () => {
        const result = await postJson(ROUTES.save, { id: article.id, patch: { sections: [{ heading: "", body: "" }] } });
        setView((prev) => ({ ...prev, article: result.article, qa: result.qa }));
        const last = result.article.sections?.[result.article.sections.length - 1];
        if (last) setSelected(`sec-${last.id}`);
      }, "加了一段");

      // ── 提案 ────────────────────────────────────────────────────────────────
      /** 点开一份提案：这时才拉逐段对照（首屏不背这个包）。 */
      const onOpenProposal = (pid) => write(async () => {
        const detail = await getJson(`${ROUTES.proposal}?id=${encodeURIComponent(article.id)}&pid=${encodeURIComponent(pid)}`);
        setProposalDetail(detail);
      });

      const onCloseProposal = () => setProposalDetail(null);

      /**
       * 裁决留痕：记下「这一次是确认还是驳回、驳的是哪句话、作用于哪篇文章」。
       *
       * 这里只写本地一条记录，不往对话里塞消息——对话由人自己发起。
       * 以前这条记录靠 postMessage 递给同源 iframe，现在对话就在本面板里，
       * 直接写同一个键即可（键名保持不变，历史记录还能续上）。
       */
      const notifyChatDecision = (decision, quote = "") => {
        try {
          window.localStorage.setItem(CHAT_DECISION_KEY, JSON.stringify({
            decision: String(decision ?? ""),
            quote: String(quote ?? ""),
            context,
            at: Date.now(),
          }));
        } catch { /* 隐私模式写不进去也不影响右栏裁决 */ }
      };

      /**
       * 裁决。确认时宿主会把提案内容写进正文（走的是同一个 writeScript），
       * 所以这里拿回来的 article/qa 就是写完之后的状态，不做本地乐观更新。
       */
      const onDecideProposal = ({ pid, confirmed, quote = "" }) => write(async () => {
        const result = await postJson(ROUTES.decide, { id: article.id, pid, confirmed, quote });
        setProposalDetail(null);
        setView((prev) => ({
          ...prev,
          article: result.article,
          qa: result.qa,
          proposals: result.proposals ?? prev.proposals,
        }));
        const decision = confirmed ? "confirmed" : "rejected";
        notifyChatDecision(decision, quote);
        say(confirmed ? "提案已确认，正文已写入" : `提案已驳回${quote ? `：${quote}` : ""}`);
      });

      const onCreate = (form) => write(async () => {
        const result = await postJson(ROUTES.create, form);
        setCreating(false);
        await loadState();            // 列表要有这条
        await loadArticle(result.article.id);
        setSelected("article");
        setScreen("article");
        say("建好了：先写讲稿，再逐段出图");
      });

      const onExport = (format) => {
        if (!article) return;
        const url = `${ROUTES.export}?id=${encodeURIComponent(article.id)}&format=${format}`;
        // 先取文本：能复制就复制（公众号后台要粘），同时给下载
        fetch(url, { credentials: "same-origin" })
          .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))))
          .then((body) => {
            let copied = false;
            try {
              navigator.clipboard?.writeText?.(body);
              copied = Boolean(navigator.clipboard?.writeText);
            } catch { copied = false; }
            const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
            const href = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = href;
            a.download = `${article.id}.${format === "md" ? "md" : format === "checklist" ? "txt" : "html"}`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(href), 4000);
            say(copied ? "已复制到剪贴板，也下载了一份" : "已下载（浏览器不让写剪贴板）");
          })
          .catch((error) => say(`导出失败：${error.message}`));
      };

      // ── 顶栏 ──
      const pendingCount = (view?.proposals ?? []).filter((p) => p.status === "waiting-user").length;
      const qaChip = qa
        ? h("span", { style: { cursor: "pointer" }, title: "打开「检查」：全部问题、提案对照、清单与账本", onClick: () => setInspectOpen(true) },
          qa.counts.error
            ? h(Badge, { level: "error" }, `${qa.counts.error} 必改`)
            : (qa.counts.warn ? h(Badge, { level: "warn" }, `${qa.counts.warn} 提醒`) : h(Badge, { level: "ok" }, "检查通过")))
        : null;

      let head;
      // 内容线切换：公众号是「在改的稿」，视频号是「仓库里做到哪一步」。
      // 放顶栏最左，因为它是**换频道**，比换篇更粗一级。
      const chan = h("div", { className: "gzs-chan", title: "切内容线" },
        [["article", "公众号"], ["video", "视频号"]].map(([key, label]) => h("button", {
          key,
          className: `gzs-chan__b ${channel === key ? "gzs-chan__b--on" : ""}`,
          onClick: () => {
            setChannel(key);
            setContext(key === "video"
              ? { kind: "video", id: "", label: "视频号列表" }
              : { kind: "article", id: activeId, label: `${article?.title || activeId || "新媒体工作台"} · 公众号` });
          },
        }, label)));
      if (screen === "home") {
        // 首页自带「新建」按钮，顶栏不再重复；这里只留内容线、标题和刷新
        head = h("div", { className: "gzs-head" },
          h("button", {
            className: `gzs-chattoggle${chatOpen ? " is-on" : ""}`,
            title: chatOpen ? "收起左侧原生对话，让面板占满" : "在左侧打开 DSH 原生对话（同一条会话）",
            onClick: toggleChat,
          }, chatOpen ? "◧ 对话" : "▢ 对话"),
          chan,
          h("span", { className: "gzs-title" }, "新媒体工作台"),
          h("div", { className: "gzs-spacer" }),
          h(Btn, { small: true, kind: "ghost", on: () => loadState(true) }, "刷新"));
      } else {
        // 顶栏分三组（2026-11-04）：左＝版式与频道，中＝身份（这是哪篇），右＝动作。
        // 视频号只看盘：导出 / 治理 / 往期都不归它管，一律不渲染——
        // 按钮留在那儿却不归它管，点了什么也不发生，比没有更糟。
        const isArticle = channel === "article";
        head = h("div", { className: "gzs-head" },
          h("div", { className: "gzs-headgroup" },
            // 对话开关控制的是整个面板的布局，归「版式」这一层，不跟文章动作混在一起。
            h("button", {
              className: `gzs-chattoggle${chatOpen ? " is-on" : ""}`,
              title: chatOpen ? "收起左侧原生对话，让面板占满" : "在左侧打开 DSH 原生对话（同一条会话）",
              onClick: toggleChat,
            }, chatOpen ? "◧ 对话" : "▢ 对话"),
            isArticle && screen === "article"
              ? h("button", {
                className: `gzs-chattoggle${railVisible ? " is-on" : ""}`,
                title: railVisible ? "收起左栏（步骤与结构），把宽度让给预览" : "展开左栏（步骤与结构）",
                "aria-pressed": railVisible ? "true" : "false",
                onClick: () => setRailOpen((v) => !v),
              }, "≡ 步骤")
              : null,
            chan,
            isArticle
              ? h(Btn, {
                small: true, kind: "ghost", title: "全部文章（含往期）",
                // 回首页时顺手收起往期抽屉：否则它会盖在首页上，像「点了没反应」。
                on: () => { setRepoOpen(false); setPushOpen(false); setScreen("home"); loadState(true).catch(() => {}); },
              }, "全部文章")
              : null),
          h("div", { className: "gzs-headgroup gzs-headgroup--mid" },
            h("span", { className: "gzs-title" }, isArticle ? "新媒体工作台" : "视频号看板"),
            isArticle && boot.list?.length
              ? h("select", {
                className: "gzs-select",
                title: "换一篇",
                value: activeId,
                onChange: (e) => { setActiveId(e.target.value); loadArticle(e.target.value).then(() => setScreen("article")); setSelected("article"); },
              }, boot.list.map((a) => h("option", { key: a.id, value: a.id }, `${a.title || "（无标题）"} · ${a.images ?? 0} 图`)))
              : null,
            // 赛道：换赛道就是换一套合规口径（禁用词 + 必须声明）与默认长相。
            isArticle && screen === "article"
              ? h("select", {
                className: "gzs-select",
                title: "内容类型（可选）：决定合规口径、默认模板与出图风格",
                value: article?.track ?? "",
                disabled: busy,
                onChange: (event) => onSaveArticle({ track: event.target.value }),
              }, [
                h("option", { key: "", value: "" }, "通用（不套内容类型）"),
                ...(boot.tracks ?? []).map((track) => h("option", { key: track.id, value: track.id },
                  `${track.name}${track.custom ? " · 自定义" : ""}`)),
              ])
              : null,
            h("span", { className: "gzs-hint gzs-headgroup__ctx", title: contextLabel },
              isArticle ? `当前：${contextLabel}` : contextLabel),
            h("span", {
              className: `gzs-live gzs-live--${live}`,
              title: live === "live"
                ? "实时同步已连上：会话里改稿、出图，面板会自己刷新"
                : live === "dead"
                  ? "实时同步没连上（宿主这一版没有 stream 路由，或连接断了）：点「刷新」手动拉"
                  : "正在连接实时同步…",
            }, live === "live" ? "● 实时" : live === "dead" ? "○ 手刷" : "○ 连接中")),
          h("div", { className: "gzs-headgroup" },
            // 两个徽标之间要有间距：`gap` 管不到「文本节点 + 徽标」这种相邻关系，
            // 它们会贴成「1 份提案待确认1 个必改」。
            isArticle
              ? h("div", { className: "gzs-headchips" },
                pendingCount
                  ? h("span", { style: { cursor: "pointer" }, title: "打开「检查」看提案对照", onClick: () => setInspectOpen(true) },
                    h(Badge, { level: "info" }, `${pendingCount} 待确认`))
                  : null,
                qaChip)
              : null,
            // 往期改成抽屉：就地看标题清单，不把人从当前稿件拽回首页再滚到底。
            isArticle
              ? h(Btn, { small: true, kind: "ghost", title: "往期（仓库真源，只读）：看以前做过的内容", on: () => setRepoOpen(true) }, "往期")
              : null,
            // 「检查」：以前是一级视图（治理），现在是一个抽屉——它从来不是用户的目的地。
            isArticle && screen === "article"
              ? h(Btn, { small: true, title: "QA / 提案 / 清单 / 账本集中看", on: () => setInspectOpen(true) }, "检查")
              : null,
            isArticle && screen === "article"
              ? h(Btn, { small: true, kind: "ghost", title: "多平台发布包：小红书 / 抖音 / 快手 的规格与文案", on: () => setPackOpen(true) }, "发布包")
              : null,
            isArticle && screen === "article"
              ? h(Btn, {
                small: true, kind: "primary",
                disabled: !article,
                title: "推到公众号草稿箱：先自查字符数与图片，再推",
                on: () => setPushOpen(true),
              }, "推草稿")
              : null,
            isArticle && screen === "article"
              ? h("div", { className: "gzs-seg", title: "出稿：HTML 直接粘公众号后台；Markdown 给别的工具；图片清单给设计" },
                h("span", { className: "gzs-eyebrow", style: { padding: "0 4px 0 9px" } }, "出稿"),
                h(Btn, { small: true, disabled: !article, on: () => onExport("html") }, "HTML"),
                h(Btn, { small: true, disabled: !article, on: () => onExport("md") }, "Markdown"),
                h(Btn, { small: true, disabled: !article, on: () => onExport("checklist") }, "图片清单"))
              : null,
            h(Btn, {
              small: true, kind: "ghost",
              title: isArticle ? "重新读工作台数据" : "重新读仓库期目录",
              // 视频号那边是独立组件（自己读盘），换 key 让它重新挂载 = 重新拉一次。
              on: () => (isArticle ? loadState(true) : setVideoEpoch((n) => n + 1)),
            }, "刷新")));
      }

      // ── 主体 ──
      /**
       * 「检查」抽屉的 props：QA / 提案 / 去 AI 味 / 清单 / 账本 / 时间线。
       *
       * 它以前是一级视图（首页 / 单篇 / 治理），但用户从来没有「我要去治理」这个意图——
       * 那是「这篇哪里要改」的聚合。所以现在它是单篇里的一个抽屉，
       * 从右栏的检查结果、顶部的待确认徽标、或者顶栏「检查」都能打开。
       */
      const governanceProps = {
        qa,
        proposals: view?.proposals ?? [],
        ledger,
        proposalDetail,
        busy,
        pipeline: view?.pipeline ?? null,
        hasBody: Boolean((article?.sections ?? []).some((s) => String(s?.body ?? "").trim())),
        deai: view?.deai ?? null,
        onAdoptDeai,
        reviews: view?.reviews ?? null,
        onToggleReview,
        onOpenProposal,
        onCloseProposal,
        onDecideProposal,
        onJump: (scope) => { setSelected(scope || "article"); setScreen("article"); setInspectOpen(false); },
      };
      let body;
      if (channel === "video") {
        // 视频号线不依赖 boot（它读的是仓库期目录），所以放在最前面：
        // 公众号那边 loadState 失败也不该拖累看板。
        body = h(VideoBoard, { refreshKey: videoEpoch, onContext: setContext });
      } else if (boot.loading) {
        // 骨架屏：原来只有一行「读取中…」，一秒的空白就让人觉得点了没反应
        body = h("div", { className: "gzs-home" },
          h("div", { className: "gzs-skel" },
            h("div", { className: "gzs-skel__row", style: { width: "168px", height: "20px" } }),
            h("div", { className: "gzs-skel__row gzs-skel__row--wide" }),
            h("div", { className: "gzs-skel__row", style: { width: "54%" } }),
            h("div", { className: "gzs-skel__row", style: { width: "38%" } })));
      } else if (boot.error) {
        body = h("div", { className: "gzs-empty" },
          h("div", null, "读不到数据："),
          h("div", { className: "gzs-hint" }, boot.error),
          h(Btn, { small: true, on: () => loadState(true) }, "重试"));
      } else if (creating) {
        body = h(NewArticle, { templates, tracks: boot.tracks, onCreate, onCancel: () => setCreating(false), busy });
      } else if (screen === "home" || !article) {
        // 打开就是工作台（和历史工作台一致）：进面板直接落到最近一篇的三栏，
        // 不再先给一个「首页」让人再点一次。`全部文章` 是顶部那个按钮，
        // 只有两种情况会落到这里：人主动点了「全部」，或者库里一篇都没有。
        body = h(Home, {
          list: boot.list,
          activity: boot.activity,
          root: boot.root,
          counts: boot.counts,
          filters: boot.filters,
          matched: boot.matched,
          busy,
          tracks: boot.tracks,
          onConfigureNodes: () => setNodeOpen(true),
          onConfigureWechat: () => setPushOpen(true),
          // 改筛选就重新拉一次：计数基于全量、列表基于筛选，两者必须来自同一次读取
          onFilter: (next) => loadState(true, next).catch(() => {}),
          onOpen: (id) => { loadArticle(id).then(() => setScreen("article")); setSelected("article"); },
          onCreate: () => setCreating(true),
        });
      } else {
        const hasBody = Boolean((article?.sections ?? []).some((s) => String(s?.body ?? "").trim()));
        const pendingProposals = (view?.proposals ?? []).filter((p) => p.status === "waiting-user");
        // 流水线的整包 props 走一个对象传下去：右栏「证据」tab 里的 PipeBlock 与
        // 之前挂在栏顶的是同一个组件、同一份数据，不另算一套。
        const pipeBlock = {
          pipeline: view?.pipeline ?? null,
          busy,
          root: boot.pipelineRoot ?? "",
          // 「初稿」这一步没有服务端判据：正文在不在，面板自己知道
          hasBody,
          // 未绑定时的粗略进度：全在本地算，不额外请求
          articleTitle: article?.title ?? "",
          hasCover: Boolean(currentVersion(article?.cover)),
          imageGaps: (article?.sections ?? []).filter((x) => !currentVersion(x?.image)).length,
          roughProgress: { exported: (ledger ?? []).some((row) => row?.type === "export") },
          onOpenObs: () => setInspectOpen(true),
          onRefresh: onPipelineRefresh,
          onBind: onBindPipeline,
        };
        body = h("div", { className: "gzs-body", ref: (node) => { colRefs.current.body = node; } },
          // 左栏：本期步骤优先（未绑期号时按稿件推断，结构列表折叠在底部）
          h("div", {
            className: "gzs-col gzs-col--left",
            ref: (node) => { colRefs.current.left = node; },
            // 用户没拖过就不写内联固定值之外的东西：宽度仍来自 autoCols（跟着可用空间走）
            // 收起时不写 display:none 到 CSS 里，而是就地隐藏——DOM 还在，
            // 组件状态（步骤展开到哪、结构折没折）不丢，收回来还是原样。
            style: railVisible ? { flexBasis: `${leftW}px` } : { flexBasis: `${leftW}px`, display: "none" },
          },
            h(StepRail, {
              view, article, selected,
              onSelect: setSelected,
              onAddSection,
              onBind: onBindPipeline,
              busy,
              root: boot.pipelineRoot ?? "",
            })),

          railVisible
            ? h(Splitter, {
              label: "本栏与中间预览之间",
              onStart: () => measure("left", leftW),
              onDrag: (want) => dragCol("left", want),
              onReset: () => resetCol("left"),
            })
            : null,

          // 中栏：标题 + 一行元信息 + 成稿 / 手机预览 / 排版
          h("div", {
            className: "gzs-col gzs-col--mid",
            /**
             * 中栏的下限有两档，靠出处不同：
             * - 自动布局（用户没拖过任何一栏）→ CSS 的 min-width:427 兜着，
             *   手机预览必须是原尺寸，宁可整排横向滚动；
             * - 用户拖过某一栏 → 这一栏是明确指令，中栏只需守住 MID_FLOOR(300)，
             *   否则拖到一半被 427 顶回来，手感就是「拖不动」。
             */
            style: wantsManual ? { minWidth: `${MID_FLOOR}px` } : undefined,
          },
            h(Stage, {
              article, templates, selected,
              onSelect: setSelected,
              onExport,
              // 预览里的「重出 / 换版」：直连已有的出图与切版动作，不另造一条写入路径。
              onRegenerate: (slot) => onGenerate({ slot }),
              onPickVersion: onPick,
              busy,
            })),

          h(Splitter, {
            label: "中间预览与检查器之间",
            onStart: () => measure("right", rightW),
            onDrag: (want) => dragCol("right", want),
            onReset: () => resetCol("right"),
            // 分隔条在右栏左边：往右拖 = 把右栏挤窄
            invert: true,
          }),

          // 右栏：检查器（证据 / 图 / 元信息）
          // 栏头只写「检查器」不写范围：范围（整篇 / 封面 / 第 N 段）就在下面一行由检查器自己报，
          // tab 名也在下面，重复一遍只是噪音。
          h("div", {
            className: "gzs-col gzs-col--right",
            ref: (node) => { colRefs.current.right = node; },
            style: { flexBasis: `${rightW}px` },
          },
            h("div", { className: "gzs-colhead" }, "检查器"),

            // 右栏很长（流水线 + 十道门 + 提案 + QA + 账本 + 图）。
            // 有提案待确认时，提案卡会落在视口外面——人在「整篇」视图里根本看不见。
            // 所以顶部加一条粘性跳转条：只要有待确认，就在一进来能看到的位置给入口。
            pendingProposals.length
              ? h("button", {
                className: "gzs-jump",
                onClick: () => {
                  // 提案卡已经不在右栏了（「意见」栏去掉，统一进「检查」抽屉）：
                  // 点它就是打开抽屉并展开第一份待确认的对照。
                  setInspectOpen(true);
                  const first = pendingProposals[0];
                  if (first && !proposalDetail) onOpenProposal(first.pid);
                },
              },
                h("span", { className: "gzs-dot gzs-dot--busy" }),
                `${pendingProposals.length} 份提案待确认`,
                h("span", { className: "gzs-jump__go" }, "去「检查」看对照 →"))
              : null,

            h(Inspector, {
              // `key` 绑文章 id：换文章时重挂载，Inspector 里的局部状态（出图确认标记、
              // 反馈草稿、节点选择）跟着重置。不加 key 会跨文章泄漏——
              // 在 A 篇确认过出图，切到 B 篇就不问了，而 B 篇一次都没确认过。
              key: article.id,
              tab: inspTab, onTab: setInspTab,
              article, selected, templates, nodes, qa, ledger, busy,
              onSaveArticle, onSaveSection, onSaveSlot, onGenerate, onPick, onFeedback, onTemplate,
              onSelect: setSelected, onDeleteSection,
              proposals: view?.proposals ?? [], proposalDetail,
              onOpenProposal, onCloseProposal, onDecideProposal,
              feedback: view?.feedback ?? null,
              // 去 AI 味 / 审阅清单只报数（操作台在治理视图），所以只传数不传动作
              deai: view?.deai ?? null,
              reviews: view?.reviews ?? null,
              pipeline: view?.pipeline ?? null,
              track: view?.track ?? null,
              pipeBlock,
              onGovernance: () => setInspectOpen(true),
            })));
      }

      return h("div", {
        className: `gzs-root${chatOpen ? " gzs-root--split" : ""}`,
        ref: (node) => { colRefs.current.root = node; },
      },
        // 左：DSH 原生对话（会话内嵌）。开着的时候它就是唯一的对话面——
        // 用户在里面说的话、我回的话、工具调用、思考过程，全是宿主原生渲染。
        chatOpen
          ? h("aside", {
            className: "gzs-chatcol",
            ref: (node) => { colRefs.current.chat = node; },
            style: cols.chat ? { flexBasis: `${cols.chat}px` } : undefined,
          },
            h(ChatDock, {
              label: contextLabel,
              reference: chat.reference,
              problem: chat.problem,
              onReset: chat.reset,
              onClose: toggleChat,
              running: chatRunning,
              SessionProvider: props?.SessionProvider,
              renderSlot: props?.renderSlot,
            }))
          : null,
        // 对话列和工作台之间的分隔条：对话默认吃掉 32% 宽度，这恰恰是最该让人调的地方。
        chatOpen
          ? h(Splitter, {
            label: "对话与工作台之间",
            onStart: () => measure("chat", cols.chat ?? 380),
            onDrag: (want) => dragCol("chat", want),
            onReset: () => resetCol("chat"),
          })
          : null,
        h("div", { className: "gzs-work" }, head,
          // 三栏放不下时明说一句，并给一键出路（收起对话是最有效的那一步）
          bodyOver
            ? h("div", { className: "gzs-narrow" },
              h("span", { className: "gzs-narrow__t" },
                "面板偏窄，三栏放不下：可左右滚动，或收起对话 / 拖动分隔条。"),
              chatOpen
                ? h("button", { className: "gzs-narrow__b", onClick: toggleChat }, "收起对话")
                : null)
            : null,
          body),
        // 往期抽屉：借右半边，底下的稿件还在，关掉就回原处。
        // 只读边界沿用 RepoSection 那一套（只 GET，不给保存/删除入口）。
        repoOpen
          ? h("div", { className: "gzs-scrim", onClick: () => setRepoOpen(false) })
          : null,
        repoOpen
          ? h("aside", { className: "gzs-drawer", "aria-label": "往期（仓库真源，只读）" },
            h("div", { className: "gzs-drawer__bar" },
              h("span", { className: "gzs-drawer__t" }, "往期"),
              h("span", { className: "gzs-hint" }, "仓库真源 · 只读"),
              h("div", { className: "gzs-spacer" }),
              h(Btn, { small: true, kind: "ghost", on: () => setRepoOpen(false) }, "关闭")),
            h("div", { className: "gzs-drawer__body" }, h(RepoSection, {})))
          : null,
        // 推草稿：没有当前文章就不渲染（首页 / 治理视图里没有「推这一篇」这件事）
        pushOpen && article
          ? h(PushDialog, {
            id: article.id,
            lastPublish: (view?.ledger ?? []).filter((row) => row?.type === "publish" && row.persisted !== false).pop() ?? null,
            onClose: () => setPushOpen(false),
            onDone: () => loadState(true).catch(() => {}),
          })
          : pushOpen && !article
            // 首页也能打开它（首启向导第 3 步）：没有当前文章就只做配置，不推。
            ? h(PushDialog, {
              id: "",
              onClose: () => setPushOpen(false),
              onDone: () => loadState(true).catch(() => {}),
            })
            : null,
        // 发布包：一稿多投。公众号那行能直接跳去推草稿，其余出包复制；保存只写差异（targets）。
        packOpen && article
          ? h(PublishPackDialog, {
            article,
            onClose: () => setPackOpen(false),
            onPush: () => { setPackOpen(false); setPushOpen(true); },
            onSave: (targets) => onSaveArticle({ targets }),
          })
          : null,
        nodeOpen
          ? h(NodeDialog, {
            onClose: () => setNodeOpen(false),
            onSaved: () => loadState(true).catch(() => {}),
          })
          : null,
        // 「检查」抽屉：QA 分组 + 提案对照 + 去 AI 味 + 清单 + 账本。
        // 它是单篇的附属面，不是一级视图——所以盖在工作台上，关掉就回到原处。
        inspectOpen && article
          ? h("div", {
            className: "gzs-modal",
            onClick: (event) => { if (event.target === event.currentTarget) setInspectOpen(false); },
          },
            h("div", { className: "gzs-modal__card gzs-modal__card--wide", role: "dialog", "aria-label": "检查" },
              h("div", { className: "gzs-modal__bar" },
                h("span", { className: "gzs-modal__t" }, "检查"),
                h("span", { className: "gzs-hint" }, "QA / 提案 / 去 AI 味 / 清单 / 账本"),
                h("div", { className: "gzs-spacer" }),
                h(Btn, { small: true, kind: "ghost", on: () => setInspectOpen(false) }, "关闭")),
              h("div", { className: "gzs-modal__body gzs-modal__body--flush" }, h(Governance, governanceProps))))
          : null,
        h(Toast, { text: toast }));
    }

    /**
     * 首页：全部文章卡片。
     *
     * 原来只有顶栏一个 <select>，文章一多只能靠下拉滚，也看不出「这篇到哪一步了」。
     * 卡片一屏能看到封面、段数、出图数、时间，点一下进文章。
     *
     * 只用 /state 里已有的字段（id/title/subtitle/sections/images/cover/updatedAt/template），
     * 不为首页额外跑一遍 QA —— 那会把首屏拖慢，而且文章越多越明显。QA 去治理视图看。
     */
    /**
     * 首页：库存 + 文章卡 + 最近动作。
     *
     * 三件事按顺序回答用户打开工作台的第一组问题：
     * 1. **我手上有多少活** —— 顶部计数条（草稿 / 草稿箱 / 已发布 / 空壳）
     * 2. **我要找哪一篇** —— 状态筛选 + 搜索（标题、小标题、正文都搜；搜索在服务端做）
     * 3. **我刚才干了什么** —— 右栏最近动作
     *
     * 搜索与筛选都走 `/state?state=&q=`，**不在前端过滤**：
     * 检索文本（正文拼串）可能有几十 KB，不下发；而且前端过滤会让「总数」与「列表」对不上。
     */
    /**
     * 往期（仓库真源，只读）。
     *
     * 为什么要有：工作台自己库里只有「正在改的稿」，而「以前做过什么」全在仓库
     * `social-media-management/03-scripts` 里。用户原话：「也看不见往期做的内容，
     * 公众号（历史工作台）就可以看见往期的」——历史工作台是按期列表做的，这里对齐。
     *
     * 只读边界：这里**只 GET**，不给任何保存/删除入口。真源归仓库，改稿改工作台那份。
     */
    function RepoSection() {
      const [feed, setFeed] = React.useState({ loading: true, error: "", data: null });
      const [line, setLine] = React.useState("");       // 内容线筛选（空 = 全部）
      const [openDir, setOpenDir] = React.useState(""); // 展开的往期
      const [limit, setLimit] = React.useState(12);

      React.useEffect(() => {
        let live = true;
        (async () => {
          try {
            const data = await getJson(ROUTES.repo);
            if (live) setFeed({ loading: false, error: "", data });
          } catch (error) {
            if (live) setFeed({ loading: false, error: String(error?.message ?? error), data: null });
          }
        })();
        return () => { live = false; };
      }, []);

      const all = Array.isArray(feed.data?.articles) ? feed.data.articles : [];
      const lines = (Array.isArray(feed.data?.lines) ? feed.data.lines : []).filter((x) => Number(x.count) > 0);
      const shown = line ? all.filter((x) => x.line === line) : all;
      const rows = shown.slice(0, limit);

      const head = h("div", { className: "gzs-repo__head" },
        h("span", { className: "gzs-repo__title" }, "往期"),
        h("span", { className: "gzs-repo__tag" }, "仓库真源 · 只读"),
        h("span", { className: "gzs-hint" }, feed.loading ? "读仓库…" : `共 ${shown.length} 篇`),
        h("div", { className: "gzs-spacer" }),
        lines.map((x) => h("button", {
          key: x.line,
          className: `gzs-chip ${line === x.line ? "gzs-chip--on" : ""}`,
          onClick: () => { setLine(line === x.line ? "" : x.line); setLimit(12); },
          title: `只看 ${x.line}`,
        }, x.line, h("span", { className: "gzs-chip__n" }, String(x.count)))));

      if (feed.error) {
        return h("div", { className: "gzs-repo" }, head,
          // 错误必须显示 message：宿主那边 400/404/502 都带一句人话，
          // 静默成空列表会让人以为「仓库里根本没有往期」。
          h("div", { className: "gzs-hint", style: { padding: "10px 0" } }, `读不到仓库：${feed.error}`));
      }

      // 没配真源仓库：说清怎么配，别让人以为「以前做过的都没了」。
      if (feed.data && feed.data.configured === false) {
        return h("div", { className: "gzs-repo" }, head,
          h("div", { className: "gzs-hint", style: { padding: "10px 0", lineHeight: 1.8 } },
            "还没配置真源仓库：设置环境变量 ",
            h("code", { className: "gzs-mono" }, "GZH_STUDIO_REPO"),
            "（指向 social-media-management 那一级），或在 settings.json 里填 pipelineRoot。",
            h("br"),
            "往期与视频期都从那里读；没配之前，工作台自己的库照常能用。"));
      }

      return h("div", { className: "gzs-repo" },
        head,
        h("div", { className: "gzs-repo__rows" },
          rows.map((item) => {
            const files = item.files ?? {};
            const marks = [
              [files.intent, "意图"],
              [files.evidence, "台账"],
              [files.review, "审阅"],
              [files.html, "排版"],
            ].filter(([has]) => has);
            return h("button", {
              key: item.dir,
              className: "gzs-repo__row",
              title: `${item.dir}\n点开只读预览`,
              onClick: () => setOpenDir(openDir === item.dir ? "" : item.dir),
            },
              h("span", { className: "gzs-repo__date" }, item.date || "—"),
              h("span", { className: "gzs-repo__mid" },
                h("span", { className: "gzs-repo__t" }, item.title || item.id || item.dir),
                h("span", { className: "gzs-repo__f" },
                  marks.map(([, text]) => h("i", { key: text, className: "on" }, text)),
                  Number(files.images)
                    ? h("i", null, `${files.images} 图`)
                    : h("i", null, "无图"))),
              h("span", { className: "gzs-repo__line" }, item.line || "—"));
          })),
        shown.length > rows.length
          ? h("div", { className: "gzs-repo__more" },
            h(Btn, { small: true, kind: "ghost", on: () => setLimit((n) => n + 20) },
              `再看 ${Math.min(20, shown.length - rows.length)} 篇（还剩 ${shown.length - rows.length}）`))
          : null,
        openDir ? h(RepoPreview, { key: openDir, dir: openDir, onClose: () => setOpenDir("") }) : null);
    }

    /**
     * 往期单篇的只读预览：正文分节 + 排版 HTML。
     *
     * 两条约束都是实的：
     * - 正文常是 HTML 片段（模板稿就这么落盘），所以要 dangerouslySetInnerHTML，
     *   进去之前先剥脚本 / 内联事件 / javascript:（不是防外人，是防「往期稿里带了一段能跑的东西」）；
     * - 排版用 `sandbox=""`（全禁）的 iframe：样式生效、脚本不跑、表单不提交。
     */
    function RepoPreview({ dir, onClose }) {
      const [state, setState] = React.useState({ loading: true, error: "", data: null });
      const [mode, setMode] = React.useState("doc");

      React.useEffect(() => {
        let live = true;
        (async () => {
          try {
            const data = await getJson(`${ROUTES.repoArticle}?dir=${encodeURIComponent(dir)}`);
            if (live) setState({ loading: false, error: "", data });
          } catch (error) {
            if (live) setState({ loading: false, error: String(error?.message ?? error), data: null });
          }
        })();
        return () => { live = false; };
      }, [dir]);

      const cleanHtml = (text) => String(text ?? "")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
        .replace(/javascript:/gi, "");

      const data = state.data;
      const sections = Array.isArray(data?.sections) ? data.sections : [];
      const html = String(data?.html ?? "");

      let body = null;
      if (state.loading) {
        body = h("div", { className: "gzs-hint", style: { padding: 18 } }, "读这篇…");
      } else if (state.error) {
        body = h("div", { className: "gzs-hint", style: { padding: 18 } }, `读不到：${state.error}`);
      } else if (mode === "html") {
        body = html
          ? h("iframe", { className: "gzs-repo__frame", title: "排版预览", sandbox: "", srcDoc: cleanHtml(html) })
          : h("div", { className: "gzs-hint", style: { padding: 18 } }, "这篇没有排版件（site/article.html）");
      } else {
        body = h("div", { className: "gzs-repo__body" },
          sections.length
            ? sections.map((section, index) => h("div", { key: `s-${index}` },
              String(section.heading ?? "").trim() ? h("h4", null, section.heading) : null,
              String(section.body ?? "").includes("<")
                ? h("div", { dangerouslySetInnerHTML: { __html: cleanHtml(section.body) } })
                : paragraphsOf(section.body).map((text, i) => h("p", { key: i }, text))))
            : h("div", { className: "gzs-hint" }, "这篇没有可读的正文"));
      }

      return h("div", { className: "gzs-repo__view" },
        h("div", { className: "gzs-repo__vhead" },
          h("span", { className: "gzs-repo__vtitle", title: dir }, data?.title || dir),
          h("span", { className: "gzs-repo__tag" }, "只读"),
          h("span", { className: "gzs-hint" }, [data?.date, data?.line].filter(Boolean).join(" · ")),
          h("div", { className: "gzs-spacer" }),
          h(Btn, { small: true, on: () => setMode(mode === "doc" ? "html" : "doc") },
            mode === "doc" ? "看排版" : "看正文"),
          h(Btn, { small: true, kind: "ghost", on: onClose }, "收起")),
        body);
    }

    /**
     * 视频号 8 步，顺序与宿主 `EPISODE_STEPS` 完全一致（有断言卡着）。
     *
     * 8 个方块全画，**不裁成 6 个**：`分段` 和 `成片` 虽然没有独立文件名，
     * 但宿主能判出来（`audio-segments/分段索引.md`、`final/*.mp4`）。
     * 少画两个就会出现「进度说 1/8、方块全空」——看着像坏了，其实是没画。
     */
    const VIDEO_STEPS = [
      { key: "outline", label: "大纲" },
      { key: "script", label: "口播稿" },
      { key: "storyboard", label: "分镜" },
      { key: "audio", label: "配音" },
      { key: "segments", label: "分段" },
      { key: "subtitle", label: "字幕" },
      { key: "cover", label: "封面" },
      { key: "final", label: "成片" },
    ];

    /**
     * 视频号看板：**只读**。
     *
     * 这一轮的口径是「先做成看得见」：期、进度、缺哪件、口播稿/分镜/分段/字幕看得到就够。
     * 生成动作（写稿、出图、配音）仍然在聊天窗口里跑——面板没有模型，硬做就是把上下文切开。
     */
    function VideoBoard({ refreshKey = 0, onContext } = {}) {
      const [feed, setFeed] = React.useState({ loading: true, refreshing: false, error: "", data: null, status: 0 });
      const [openId, setOpenId] = React.useState("");
      // 空串 = 「还没选过」：期里有成片就默认落到「成片」，没有才落到口播稿。
      const [openTab, setOpenTab] = React.useState("");
      const [chatHint, setChatHint] = React.useState("");

      const bringVideoPlan = () => {
        const plan = "【公司视频号】请从 07-video/episode 开始创建下一期视频：先确认选题和期号，再依次产出大纲、口播稿、分镜、配音、分段、字幕、封面和成片。先告诉我建议的期号与第一步。";
        bringToChat(plan).then((result) => setChatHint(result.ok
          ? "已带到左侧对话，检查后发送"
          : `没带过去：${result.reason}；可复制这段话到对话`));
      };

      const reload = React.useCallback(async () => {
        const hadData = Boolean(feed.data);
        setFeed((prev) => ({ ...prev, loading: !hadData, refreshing: hadData, error: "" }));
        try {
          const data = await getJson(ROUTES.video);
          setFeed({ loading: false, refreshing: false, error: "", data, status: 200 });
          if (openId && !data.episodes?.some((episode) => episode.id === openId)) {
            setOpenId("");
            onContext?.({ kind: "video", id: "", label: "暂无已打开的视频期" });
          }
          return data;
        } catch (error) {
          setFeed((prev) => ({ ...prev, loading: false, refreshing: false, error: String(error?.message ?? error), status: Number(error?.status ?? 0) || 0 }));
          return null;
        }
      }, [feed.data, openId, onContext]);

      React.useEffect(() => { reload(); }, [refreshKey]);

      React.useEffect(() => {
        const onChanged = (event) => {
          const data = event?.data;
          if (!data || data.type !== CHAT_SOURCE_CHANGED_TYPE || (data.scope && data.scope !== "video")) return;
          reload();
        };
        window.addEventListener("message", onChanged);
        return () => window.removeEventListener("message", onChanged);
      }, [reload]);

      const episodes = Array.isArray(feed.data?.episodes) ? feed.data.episodes : [];

      const head = h("div", { className: "gzs-vhead" },
        h("div", null,
          h("div", { className: "gzs-vtitle" }, "视频号 · 期"),
          h("div", { className: "gzs-hint", style: { marginTop: 4 } },
            feed.loading ? "读期目录…"
              : feed.data ? `仓库 07-video/episode · ${episodes.length} 期 · 只读`
                : feed.status === 404 ? "视频号路由不可用"
                  : "视频期目录读取失败")),
        h("div", { className: "gzs-spacer" }),
        feed.refreshing ? h("span", { className: "gzs-vnote" }, "正在更新…") : null,
        h("span", { className: "gzs-vnote" }, chatHint || "文件存在 ≠ 已审核；生成动作在聊天窗口"));

      if (feed.error) {
        const routeMissing = feed.status === 404;
        return h("div", { className: "gzs-vboard" }, head,
          h("div", { className: "gzs-vsplit" },
            h("div", { className: "gzs-vlist" },
              h("div", { className: `gzs-vempty ${routeMissing ? "gzs-vempty--error" : ""}` },
                h("b", null, routeMissing ? "读不到视频号接口" : "视频期目录读取失败"),
                h("p", null, routeMissing
                  ? "面板请求视频号期列表时宿主回了 404。先确认这次真的是「路由没注册」，而不是前端请求了错的地址。"
                  : feed.error),
                routeMissing
                  ? h("p", { className: "gzs-hint" },
                    "如果插件刚更新过，需要重启 dsh web 让宿主重新挂路由；重启后仍失败，再查插件加载日志。")
                  : h("p", { className: "gzs-hint" }, "公司视频号真源：07-video/episode；面板不会修改真源目录。"),
                h("div", { className: "gzs-vempty__actions" },
                  h(Btn, { small: true, on: bringVideoPlan }, "带到对话"),
                  h(Btn, { small: true, kind: "ghost", on: reload }, "重试")))),
            h(VideoAside, { episodes: [], open: false, onPlan: bringVideoPlan, hint: chatHint })));
      }

      if (!feed.loading && feed.data?.configured === false) {
        return h("div", { className: "gzs-vboard" }, head,
          h("div", { className: "gzs-vsplit" },
            h("div", { className: "gzs-vlist" },
              h("div", { className: "gzs-vempty gzs-vempty--start" },
                h("b", null, "还没配置真源仓库"),
                h("p", null, "视频期从真源仓库的 07-video/episode 读。设一个环境变量就能看见："),
                h("p", { className: "gzs-hint gzs-mono" }, "GZH_STUDIO_REPO=<social-media-management 那一级>"),
                h("p", { className: "gzs-hint" }, "不想用环境变量，就在 settings.json 里写 pipelineRoot。没配之前公众号那条线照常能用。"),
                h("div", { className: "gzs-vempty__actions" },
                  h(Btn, { small: true, kind: "ghost", on: reload }, "重新读取")))),
            h(VideoAside, { episodes: [], open: false, onPlan: bringVideoPlan, hint: chatHint })));
      }

      if (!feed.loading && !episodes.length) {
        return h("div", { className: "gzs-vboard" }, head,
          h("div", { className: "gzs-vsplit" },
            h("div", { className: "gzs-vlist" },
              h("div", { className: "gzs-vempty gzs-vempty--start" },
                h("b", null, "暂无视频期"),
                h("p", null, "这不是错误：公司视频号的 07-video/episode 目前还没有一期可展示。"),
                h("p", null, "可以先在左侧对话里确定选题和期号，看板会随后显示八步进度。"),
                h("div", { className: "gzs-vempty__actions" },
                  h(Btn, { small: true, kind: "primary", on: bringVideoPlan }, "带到对话，开始创建视频")),
                chatHint ? h("span", { className: "gzs-hint" }, chatHint) : null)),
            h(VideoAside, { episodes: [], open: false, onPlan: bringVideoPlan, hint: chatHint })));
      }

      return h("div", { className: "gzs-vboard" },
        head,
        h("div", { className: "gzs-vsplit" },
          h("div", { className: "gzs-vlist" },
            // 首屏还没读到数据时给个占位，否则左栏是一块空——空和「读失败」长得一样
            feed.loading && !feed.data
              ? h("div", { className: "gzs-vempty" },
                h("b", null, "读期目录…"),
                h("p", null, "正在看 07-video/episode 里有哪些期。"))
              : null,
            // 列表本身也标一句「缺几件」：扫一眼就知道哪期最接近能发
            episodes.map((ep) => {
              const files = ep.files ?? {};
              const done = VIDEO_STEPS.filter((step) => files[step.key]).length;
              return h("button", {
                key: ep.id,
                className: `gzs-vrow ${openId === ep.id ? "gzs-vrow--on" : ""}`,
                title: `${ep.id}｜${ep.status}`,
                "aria-pressed": openId === ep.id ? "true" : "false",
                onClick: () => {
                  const next = openId === ep.id ? "" : ep.id;
                  setOpenId(next);
                  onContext?.({ kind: "video", id: next, label: next ? `${next} · 视频号` : "视频号列表" });
                },
              },
                h("span", { className: "gzs-vrow__id" }, ep.id),
                h("span", { className: "gzs-vsteps" },
                  VIDEO_STEPS.map((step) => h("i", {
                    key: step.key,
                    className: files[step.key] ? "on" : "",
                    title: `${step.label}${files[step.key] ? "：有" : "：还缺"}`,
                  }))),
                h("span", { className: "gzs-vrow__st" }, `${done}/${VIDEO_STEPS.length}`),
                h("span", { className: "gzs-vrow__open" }, openId === ep.id ? "收起" : "打开 →"));
            })),
          h("div", { className: "gzs-vside" },
            openId
              ? h(VideoEpisode, {
                key: openId,
                id: openId,
                refreshKey,
                tab: openTab,
                onTab: setOpenTab,
                onClose: () => { setOpenId(""); onContext?.({ kind: "video", id: "", label: "视频号列表" }); },
              })
              : h(VideoAside, { episodes, open: Boolean(openId), onPlan: bringVideoPlan, hint: chatHint }))));
    }

    /**
     * 视频号右栏（没打开某一期时）。
     *
     * 原来这块是**完全空的**：列表铺满整屏，右边什么都没有。用户看到的是
     * 「右边怎么没内容」——因为确实没内容，设计上就没打算给。
     * 但一块空白既不像「空态」也不像「加载中」，只能让人怀疑坏了。
     *
     * 现在这块有活干：说清楚八步各缺几期、点哪一期、生成动作在哪。
     */
    function VideoAside({ episodes = [], open, onPlan, hint = "" } = {}) {
      const total = episodes.length;
      const complete = episodes.filter((ep) => VIDEO_STEPS.every((step) => ep?.files?.[step.key])).length;
      const gaps = VIDEO_STEPS.map((step) => ({
        ...step,
        missing: episodes.filter((ep) => !ep?.files?.[step.key]).length,
      }));
      // 一步都不缺的步骤不占版面；全齐时给一句结论
      const openGaps = gaps.filter((gap) => gap.missing > 0);

      return h("div", { className: "gzs-vaside" },
        h("div", { className: "gzs-vaside__card" },
          h("div", { className: "gzs-vaside__k" }, open ? "这一期已打开" : "还没选期"),
          h("div", { className: "gzs-vaside__v" },
            open ? "左侧高亮的那一期，正文在右边往下看" : "在左边点一期，这里会换成它的口播稿 / 分镜 / 分段 / 字幕"),
          total
            ? h("div", { className: "gzs-vaside__stats" },
              h("span", null, h("b", null, String(total)), " 期"),
              h("span", null, h("b", null, String(complete)), " 期八件齐"),
              h("span", null, h("b", null, String(total - complete)), " 期在途"))
            : h("div", { className: "gzs-vaside__stats" }, h("span", null, "盘上还没有期目录"))),

        h("div", { className: "gzs-vaside__card" },
          h("div", { className: "gzs-vaside__k" }, "八步缺口"),
          total
            ? (openGaps.length
              ? h("div", { className: "gzs-vgap" }, openGaps.map((gap) => {
                const filled = total - gap.missing;
                return h("div", { key: gap.key, className: "gzs-vgap__row" },
                  h("span", { className: "gzs-vgap__name" }, gap.label),
                  h("span", { className: "gzs-vgap__bar" },
                    h("i", { style: { width: `${Math.round((filled / total) * 100)}%` } })),
                  h("span", { className: "gzs-vgap__n" }, `${filled}/${total}`));
              }))
              : h("div", { className: "gzs-vaside__ok" }, "八件都齐了，可以去对话里确认成片与发布。"))
            : h("div", { className: "gzs-hint" }, "有了第一期之后，这里会按步骤统计缺口。")),

        h("div", { className: "gzs-vaside__card" },
          h("div", { className: "gzs-vaside__k" }, "生成在哪做"),
          h("p", { className: "gzs-vaside__p" },
            "看板只读盘：它显示 07-video/episode 里有什么，不替你生成。大纲、口播稿、分镜、配音、分段、字幕、封面、成片都由会话里的 agent 产出，写完刷新就能看见。"),
          h("div", { className: "gzs-vaside__acts" },
            h(Btn, { small: true, kind: "primary", on: onPlan }, "带到对话"),
            hint ? h("span", { className: "gzs-hint" }, hint) : null)));
    }

    /**
     * 单期详情：口播稿 / 分镜 / 分段 / 字幕。
     *
     * 缺件是正常状态（现在的 FDE-01 只有分段索引），所以每个 tab 里都要能说出
     * 「这一件盘上还没有」，而不是画一个空表格让人以为解析坏了。
     */
    /**
     * 视频期「成片」页：能播、能看封面、能看分镜缩略图，还能把发布文案拿走。
     *
     * 视频号没有面向普通账号的开放上传接口，所以这里**不做「一键发视频」**——
     * 只把该拿的东西收拢：成片可播（Range 流式）、封面可见、字幕可叠、文案可复制、
     * 产物路径可复制。上传仍然在视频号助手里做。
     */
    function EpisodePlayer({ id, data }) {
      const media = data?.media ?? {};
      const finals = Array.isArray(media.final) ? media.final : [];
      const covers = Array.isArray(media.cover) ? media.cover : [];
      const shots = Array.isArray(media.storyboard) ? media.storyboard : [];
      const subtitles = Array.isArray(data?.subtitles) ? data.subtitles : [];
      const [pick, setPick] = React.useState(0);
      const [copied, setCopied] = React.useState("");
      const [pack, setPack] = React.useState({
        title: String(data?.title ?? id ?? ""),
        desc: "",
        topics: "",
      });
      const patchPack = (patch) => setPack((prev) => ({ ...prev, ...patch }));

      // 字幕转 VTT 走 Blob URL：浏览器只认 VTT，而盘上多半是 SRT；
      // 再开一条「转格式」的路由等于把同一份数据读两遍。
      const vtt = subtitles.length ? subtitlesToVtt(subtitles) : "";
      const vttUrl = React.useMemo(() => {
        if (!vtt || typeof Blob !== "function" || typeof URL?.createObjectURL !== "function") return "";
        try { return URL.createObjectURL(new Blob([vtt], { type: "text/vtt;charset=utf-8" })); } catch { return ""; }
      }, [vtt]);
      React.useEffect(() => () => {
        if (!vttUrl) return;
        try { URL.revokeObjectURL(vttUrl); } catch { /* 已回收 */ }
      }, [vttUrl]);

      const copy = (text, tag) => {
        try {
          navigator.clipboard?.writeText?.(String(text ?? ""));
          setCopied(tag);
          window.setTimeout(() => setCopied(""), 1600);
        } catch { setCopied(""); }
      };

      const packText = [pack.title, pack.desc, pack.topics]
        .map((part) => String(part ?? "").trim())
        .filter(Boolean)
        .join("\n\n");

      if (!finals.length) {
        return h("div", { className: "gzs-vplayer" },
          h("div", { className: "gzs-vempty", style: { margin: "10px 0" } },
            h("b", null, "还没有成片"),
            h("p", null, "盘上这一期还没有视频文件。成片由会话里的 agent 渲染后写进期目录，写完点「重新读取」就能在这里播。")),
          covers.length
            ? h("div", null,
              h("div", { className: "gzs-eyebrow" }, "封面"),
              h("img", { className: "gzs-vcover", src: mediaUrl(id, covers[0].rel), alt: "封面" }))
            : null);
      }

      const active = finals[Math.min(pick, finals.length - 1)];
      return h("div", { className: "gzs-vplayer" },
        h("video", {
          key: active.rel,
          className: "gzs-vvideo",
          controls: true,
          preload: "metadata",
          playsInline: true,
          poster: covers.length ? mediaUrl(id, covers[0].rel) : undefined,
          src: mediaUrl(id, active.rel),
        }, vttUrl
          ? h("track", { key: "zh", kind: "subtitles", label: "中文字幕", srcLang: "zh", src: vttUrl, default: true })
          : null),
        h("div", { className: "gzs-vplayer__meta" },
          h("span", { className: "gzs-mono" }, active.rel),
          h("span", null, `${(Number(active.bytes || 0) / 1024 / 1024).toFixed(1)} MB`),
          finals.length > 1
            ? h("select", {
              className: "gzs-select", value: String(pick),
              onChange: (event) => setPick(Number(event.target.value) || 0),
            }, finals.map((file, index) => h("option", { key: file.rel, value: String(index) }, file.rel)))
            : null,
          h("div", { className: "gzs-spacer" }),
          h(Btn, { small: true, kind: "ghost", on: () => copy(active.rel, "rel") }, copied === "rel" ? "已复制" : "复制文件名")),
        shots.length
          ? h("div", null,
            h("div", { className: "gzs-eyebrow", style: { marginBottom: "6px" } }, `分镜图 ${shots.length}`),
            h("div", { className: "gzs-vthumbs" },
              shots.map((shot) => h("img", {
                key: shot.rel,
                src: mediaUrl(id, shot.rel),
                alt: shot.name,
                title: shot.rel,
                loading: "lazy",
              }))))
          : null,
        h("div", { className: "gzs-vpack" },
          h("div", { className: "gzs-eyebrow" }, "发布包"),
          h("p", { className: "gzs-hint" }, "视频号没有开放上传接口：这块只负责把文案和产物拿得走，上传仍然在视频号助手里做。"),
          h("label", { className: "gzs-push__field" },
            h("span", { className: "gzs-push__k" }, "标题"),
            h("input", {
              className: "gzs-input", value: pack.title,
              onChange: (event) => patchPack({ title: event.target.value }),
            })),
          h("label", { className: "gzs-push__field" },
            h("span", { className: "gzs-push__k" }, "简介"),
            h("textarea", {
              className: "gzs-area", rows: 3, value: pack.desc, placeholder: "一句话说清这条视频给谁、解决什么",
              onChange: (event) => patchPack({ desc: event.target.value }),
            })),
          h("label", { className: "gzs-push__field" },
            h("span", { className: "gzs-push__k" }, "话题"),
            h("input", {
              className: "gzs-input", value: pack.topics, placeholder: "#智能体 #上线 空格分开",
              onChange: (event) => patchPack({ topics: event.target.value }),
            })),
          h("div", { className: "gzs-row", style: { gap: "8px", flexWrap: "wrap" } },
            h(Btn, { small: true, kind: "primary", on: () => copy(packText, "pack") }, copied === "pack" ? "已复制" : "复制发布文案"),
            h(Btn, { small: true, kind: "ghost", on: () => copy(data?.dirPath ?? "", "dir") }, copied === "dir" ? "已复制" : "复制产物路径"),
            data?.dirPath ? h("span", { className: "gzs-hint" }, data.dirPath) : null)));
    }

    /**
     * 首页「现在可以做这些」：首屏先回答「该干什么」，再回答「我有什么」。
     *
     * 只用 `/state` 已经下发过的字段（不做额外请求、不跑 QA）：
     * 草稿箱待发、配图没齐、空壳、最近在改。每一条都**直接跳到那篇**，
     * 不让人先切筛选再自己找。
     */
    function TodayQueue({ list, counts, activity, onOpen, onFilter, onCreate }) {
      const cards = Array.isArray(list) ? list : [];
      const stat = counts ?? {};
      const toSend = Number(stat.byState?.draftbox ?? 0);
      const empty = Number(stat.empty ?? 0);
      const lacking = cards.filter((item) => {
        const sections = Number(item.sections ?? 0);
        if (!sections) return false;
        const bodyImages = Number(item.images ?? 0) - (item.cover ? 1 : 0);
        return bodyImages < sections;
      });
      const empties = cards.filter((item) => item.empty);
      const recent = (Array.isArray(activity) ? activity : []).find((row) => row && row.id && row.event);
      const items = [
        toSend
          ? { key: "send", n: toSend, title: "在草稿箱等发布", hint: "去后台点发布，或回来再看一眼", on: () => onFilter?.({ state: "draftbox" }) }
          : null,
        lacking.length
          ? { key: "img", n: lacking.length, title: "配图没齐", hint: `先补《${String(lacking[0].title || lacking[0].id).slice(0, 12)}》`, on: () => onOpen?.(lacking[0].id) }
          : null,
        empty
          ? {
            key: "empty", n: empty, title: "空壳（正文还没写）",
            hint: empties.length ? `打开《${String(empties[0].title || "无标题").slice(0, 12)}》接着写` : "先写起来",
            on: () => (empties.length ? onOpen?.(empties[0].id) : onCreate?.()),
          }
          : null,
        recent
          ? { key: "recent", n: 1, title: "接着上次改", hint: String(recent.title || recent.id).slice(0, 16), on: () => onOpen?.(recent.id) }
          : null,
      ].filter(Boolean);
      if (!items.length) return null;
      return h("div", { className: "gzs-today" },
        h("div", { className: "gzs-today__h" },
          h("span", { className: "gzs-today__t" }, "现在可以做这些"),
          h("span", { className: "gzs-hint" }, "点一条直接进那一篇；不用先筛选再找")),
        h("div", { className: "gzs-today__grid" },
          items.map((item) => h("button", {
            key: item.key, className: "gzs-today__card", onClick: item.on,
            title: `${item.title} · ${item.hint}`,
          },
            h("span", { className: "gzs-today__n" }, String(item.n)),
            h("span", { className: "gzs-today__b" },
              h("span", { className: "gzs-today__title" }, item.title),
              h("span", { className: "gzs-today__hint" }, item.hint))))));
    }

    /**
     * 首启向导：空库时先回答「三步怎么开始」，而不是「库存 0 篇」。
     *
     * 不做多步弹窗：用户还没看到界面就被弹窗挡住，第一感觉是「这东西很麻烦」。
     * 三条都列出来，第 2、3 步明确写「可跳过」——默认占位图和导出 HTML 都能把流程走完。
     */
    function FirstRun({ onCreate, onConfigureNodes, onConfigureWechat }) {
      const steps = [
        { no: "1", title: "新建一篇", desc: "内容类型是可选的：不选也能写、能出图、能推；选了只是多一套禁用词与默认长相。", action: "新建第一篇", on: onCreate, main: true },
        { no: "2", title: "配出图节点（可跳过）", desc: "默认用占位图（不联网、出 SVG），足够把流程点一遍；要真图就填一个 OpenAI 兼容节点，key 只写环境变量名。", action: "配置节点", on: onConfigureNodes },
        { no: "3", title: "连公众号（可选）", desc: "填 AppID / AppSecret 后能直接推到草稿箱；不连也能导出 HTML 手工粘。", action: "配置公众号", on: onConfigureWechat },
      ];
      return h("div", { className: "gzs-firstrun" },
        h("div", { className: "gzs-firstrun__h" }, "三步开始"),
        h("div", { className: "gzs-firstrun__steps" },
          steps.map((step) => h("div", { key: step.no, className: "gzs-firstrun__step" },
            h("span", { className: "gzs-firstrun__no" }, step.no),
            h("div", { className: "gzs-firstrun__body" },
              h("div", { className: "gzs-firstrun__t" }, step.title),
              h("div", { className: "gzs-firstrun__d" }, step.desc)),
            h(Btn, { small: true, kind: step.main ? "primary" : "ghost", on: step.on }, step.action)))));
    }

    /**
     * 出图节点配置。**key 只写环境变量名**（和读取侧同一个口径）：
     * 界面上永远不出现密钥本身，避免「填一次就落到 json 里」。
     */
    function NodeDialog({ onClose, onSaved }) {
      const [form, setForm] = React.useState({
        name: "我的出图节点",
        baseURL: "https://api.openai.com",
        apiKeyEnv: "OPENAI_API_KEY",
        model: "gpt-image-1",
        size: "",
      });
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState("");
      const patch = (next) => setForm((prev) => ({ ...prev, ...next }));
      // Esc 关掉：弹窗开着时人是「被打断」的状态，键盘要能退出去。
      React.useEffect(() => {
        const onKey = (event) => { if (event?.key === "Escape" && !busy) onClose?.(); };
        window.addEventListener?.("keydown", onKey);
        return () => window.removeEventListener?.("keydown", onKey);
      }, [busy]);
      const idOf = () => String(form.name ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32) || "custom";

      const save = async () => {
        setBusy(true);
        setError("");
        try {
          const id = idOf();
          await postJson(ROUTES.node, {
            node: { id, name: form.name, baseURL: form.baseURL, apiKeyEnv: form.apiKeyEnv, model: form.model, size: form.size, fake: false },
            defaultNode: id,
          });
          onSaved?.();
          onClose?.();
        } catch (failure) {
          setError(failure.message);
        } finally {
          setBusy(false);
        }
      };

      const field = (label, key, extra = {}) => h("label", { className: "gzs-push__field" },
        h("span", { className: "gzs-push__k" }, label),
        h("input", {
          className: "gzs-input", value: form[key],
          onChange: (event) => patch({ [key]: event.target.value }),
          ...extra,
        }));

      return h("div", { className: "gzs-modal", onClick: (event) => { if (event.target === event.currentTarget && !busy) onClose?.(); } },
        h("div", { className: "gzs-modal__card", role: "dialog", "aria-label": "配置出图节点" },
          h("div", { className: "gzs-modal__bar" },
            h("span", { className: "gzs-modal__t" }, "配置出图节点"),
            h("div", { className: "gzs-spacer" }),
            h("button", { className: "gzs-chatcol__x", onClick: () => { if (!busy) onClose?.(); }, title: "关闭" }, "×")),
          h("div", { className: "gzs-modal__body" },
            h("p", { className: "gzs-push__lead" },
              "只支持 OpenAI 兼容接口：",
              h("code", null, "POST {baseURL}/v1/images/generations"),
              "。密钥不填在这里——填「环境变量名」，插件只从环境变量读，不落盘。"),
            field("节点名", "name", { placeholder: "例：我的出图节点" }),
            field("接口地址", "baseURL", { placeholder: "https://api.openai.com", spellCheck: false }),
            field("密钥的环境变量名", "apiKeyEnv", { placeholder: "OPENAI_API_KEY", spellCheck: false }),
            field("模型", "model", { placeholder: "gpt-image-1", spellCheck: false }),
            field("固定尺寸（可空）", "size", { placeholder: "1024x1024；留空按槽位推荐" }),
            error ? h("div", { className: "gzs-push__prob" }, error) : null,
            h("p", { className: "gzs-hint" },
              "尺寸必须是 64 的倍数：不是倍数时网关不报错、直接给一张方图。插件发请求前会自动吸附到最接近的比例档。")),
          h("div", { className: "gzs-modal__foot" },
            h(Btn, { small: true, kind: "ghost", on: onClose, disabled: busy }, "取消"),
            h(Btn, { kind: "primary", on: save, disabled: busy || !form.baseURL.trim() || !form.apiKeyEnv.trim() }, busy ? "保存中…" : "保存并设为默认"))));
    }

    function VideoEpisode({ id, onClose, refreshKey = 0, tab: tabProp, onTab } = {}) {
      const [state, setState] = React.useState({ loading: true, refreshing: false, error: "", data: null, status: 0 });
      const [localTab, setLocalTab] = React.useState("");
      const tab = tabProp ?? localTab;
      const setTab = onTab ?? setLocalTab;
      const [chatHint, setChatHint] = React.useState("");

      const bringEpisodePlan = () => {
        const plan = `【公司视频号 · ${id}】请继续创建这一期视频。先检查并补齐缺失的八步：大纲、口播稿、分镜、配音、分段、字幕、封面、成片；先告诉我当前缺口和下一步，不要直接覆盖已有文件。`;
        bringToChat(plan).then((result) => setChatHint(result.ok
          ? "已带到左侧对话，检查后发送"
          : `没带过去：${result.reason}；可复制这段话到对话`));
      };

      const reload = React.useCallback(async () => {
        setState((prev) => ({ ...prev, loading: !prev.data, refreshing: Boolean(prev.data), error: "" }));
        try {
          const data = await getJson(`${ROUTES.videoEpisode}?id=${encodeURIComponent(id)}`);
          setState({ loading: false, refreshing: false, error: "", data, status: 200 });
          return data;
        } catch (error) {
          setState((prev) => ({ ...prev, loading: false, refreshing: false, error: String(error?.message ?? error), status: Number(error?.status ?? 0) || 0 }));
          return null;
        }
      }, [id]);

      React.useEffect(() => { reload(); }, [id, refreshKey]);

      const data = state.data;
      const script = String(data?.script ?? "");
      const storyboard = Array.isArray(data?.storyboard) ? data.storyboard : [];
      const segments = Array.isArray(data?.segments) ? data.segments : [];
      const subtitles = Array.isArray(data?.subtitles) ? data.subtitles : [];
      const finals = Array.isArray(data?.media?.final) ? data.media.final : [];
      // 没点过 tab 时按内容挑默认页：有片先看片，没片才看口播稿。
      const shownTab = tab || (finals.length ? "final" : "script");

      const TABS = [
        ["final", "成片", finals.length ? String(finals.length) : "缺"],
        ["script", "口播稿", script ? "" : "缺"],
        ["storyboard", "分镜", storyboard.length ? String(storyboard.length) : "缺"],
        ["segments", "分段", segments.length ? String(segments.length) : "缺"],
        ["subtitles", "字幕", subtitles.length ? String(subtitles.length) : "缺"],
      ];

      const missing = (label) => h("div", { className: "gzs-hint", style: { padding: "14px 2px" } },
        `盘上还没有${label}。这一件由会话里的 agent 产出，面板只负责显示。`);

      let panel = null;
      if (state.loading) panel = h("div", { className: "gzs-hint", style: { padding: 16 } }, "读这一期…");
      else if (state.error) panel = h("div", { className: `gzs-vempty ${state.status === 404 ? "gzs-vempty--error" : ""}`, style: { margin: 12 } },
        h("b", null, state.status === 404 ? "这一期不存在" : "读取这一期失败"),
        h("p", null, state.error),
        h("p", { className: "gzs-hint" }, state.status === 404 ? "请回到视频号列表选择已有期号；如果是新一期，请先在对话中确定期号。" : "请稍后刷新；工作台不会因为缺少制作文件而报错。"));
      else if (shownTab === "final") {
        // 成片页：播视频 / 看封面 / 叠字幕 / 拿发布文案。缺片时它自己会说「还没有成片」。
        panel = h(EpisodePlayer, { id, data });
      } else if (shownTab === "script") {
        panel = script
          ? h("div", { className: "gzs-vdoc" }, markdownBlocks(script).map((block, index) => (
            block.kind === "h"
              ? h("h4", { key: index }, block.text)
              : h("p", { key: index }, block.text))))
          : missing("口播稿");
      } else if (shownTab === "storyboard") {
        panel = storyboard.length
          ? h("div", { className: "gzs-vtable" },
            h("div", { className: "gzs-vtable__h" },
              h("span", null, "镜"), h("span", null, "时间"), h("span", null, "画面"), h("span", null, "口播")),
            storyboard.map((shot, index) => h("div", { key: index, className: "gzs-vtable__r" },
              h("span", null, shot.shot), h("span", null, shot.time || "—"),
              h("span", { className: "w" }, shot.title || "—"),
              h("span", { className: "w" }, shot.text || "—"))))
          : missing("分镜表");
      } else if (shownTab === "segments") {
        panel = segments.length
          ? h("div", { className: "gzs-vtable" },
            h("div", { className: "gzs-vtable__h" },
              h("span", null, "段"), h("span", null, "文件"), h("span", null, "区间"), h("span", null, "时长")),
            segments.map((seg, index) => h("div", { key: index, className: "gzs-vtable__r" },
              h("span", null, String(seg.no ?? index + 1)),
              h("span", { className: "w gzs-mono" }, seg.file || "—"),
              h("span", null, seg.range || "—"), h("span", null, seg.duration || "—"))))
          : missing("分段索引");
      } else {
        panel = subtitles.length
          ? h("div", { className: "gzs-vsub" }, subtitles.map((line, index) => h("div", { key: index, className: "gzs-vsub__r" },
            h("span", { className: "t gzs-mono" }, `${line.start} → ${line.end}`),
            h("span", { className: "x" }, line.text))))
          : missing("字幕");
      }

      return h("div", { className: "gzs-vdetail" },
        h("div", { className: "gzs-vdetail__h" },
          h("span", { className: "gzs-vdetail__id" }, id),
          h("span", { className: "gzs-repo__tag" }, "仓库真源 · 只读"),
          state.refreshing ? h("span", { className: "gzs-vnote" }, "正在更新…") : null,
          h("div", { className: "gzs-spacer" }),
          h(Btn, { small: true, kind: "ghost", on: reload, disabled: state.loading || state.refreshing }, "重新读取"),
          h(Btn, { small: true, kind: "ghost", on: onClose }, "收起")),
        data?.note ? h("div", { className: "gzs-vnote gzs-vnote--line" }, data.note) : null,
        !state.loading && !state.error && data && (!script || !storyboard.length || !segments.length || !subtitles.length)
          ? h("div", { className: "gzs-vempty gzs-vempty--start", style: { margin: "10px 12px 0", padding: "13px 14px" } },
            h("b", null, "这一期还没做完"),
            h("p", null, data.note || "盘上缺少部分制作文件。需要补齐时，可以让对话先列出缺口，再按顺序继续。"),
            h("div", { className: "gzs-vempty__steps" },
              VIDEO_STEPS.map((step) => h("span", { key: step.key }, `${step.label} · ${data?.files?.[step.key] ? "已有" : "待补"}`))),
            h("div", { className: "gzs-vempty__actions" },
              h(Btn, { small: true, kind: "primary", on: bringEpisodePlan }, "带到对话，继续创建")),
            chatHint ? h("span", { className: "gzs-hint" }, chatHint) : null)
          : null,
        h("div", { className: "gzs-vtabs" },
          TABS.map(([key, label, badge]) => h("button", {
            key, className: `gzs-vtab ${shownTab === key ? "gzs-vtab--on" : ""}`,
            onClick: () => setTab(key),
          }, label, badge ? h("span", { className: "gzs-vtab__n" }, badge) : null))),
        panel);
    }

    /**
     * 极简 markdown 分块：`#` 标题、空行分段。够读口播稿，不做完整解析。
     * 不引第三方库（插件不许加依赖），也不把 `**` 直接漏到屏幕上。
     */
    function markdownBlocks(text) {
      const blocks = [];
      for (const chunk of String(text ?? "").replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
        const body = chunk.trim();
        if (!body) continue;
        const head = /^(#{1,6})\s+(.*)$/.exec(body);
        if (head) blocks.push({ kind: "h", text: head[2].replace(/\*\*/g, "") });
        else blocks.push({ kind: "p", text: body.replace(/\*\*/g, "").replace(/^[-*]\s+/gm, "· ") });
      }
      return blocks;
    }

    function Home({ list, root, onOpen, onCreate, activity, counts, filters, matched, onFilter, busy, tracks, onConfigureNodes, onConfigureWechat }) {
      const cards = Array.isArray(list) ? list : [];
      const acts = Array.isArray(activity) ? activity : [];
      // 卡片上的赛道名：只显示名字，不带规则细节（详情在 Inspector 与 QA 里）
      const trackName = (id) => {
        const found = (Array.isArray(tracks) ? tracks : []).find((track) => track.id === id);
        return found?.name ?? id;
      };
      const stat = counts ?? { total: 0, byState: {}, empty: 0, unbound: 0, active: 0 };
      const cur = filters ?? { state: "all", q: "", empty: false };
      const [draft, setDraft] = React.useState(cur.q ?? "");
      React.useEffect(() => { setDraft(cur.q ?? ""); }, [cur.q]);
      const applyQ = () => { if ((draft ?? "") !== (cur.q ?? "")) onFilter?.({ ...cur, q: draft }); };
      // 动作类型的点色：出图/提案=青，切版/反馈=金，改稿/建文=绿，其余灰
      const ACT_DOT = {
        generate: "gzs-dot--busy", propose: "gzs-dot--busy",
        pick: "gzs-dot--miss", feedback: "gzs-dot--miss",
        save: "gzs-dot--done", script: "gzs-dot--done", create: "gzs-dot--done", decide: "gzs-dot--done",
      };

      /**
       * 最近动作：跨文章的账本尾巴。点一条直接进那篇。
       * 这一栏只有在「有历史」时才有意义；空库时不占版面（下面直接不渲染）。
       */
      const actPanel = acts.length
        ? h("div", { className: "gzs-panel gzs-actpanel" },
          h("div", { className: "gzs-panel__head" },
            h("span", null, "最近动作"),
            h("div", { className: "gzs-spacer" }),
            h("span", { className: "gzs-hint" }, `${acts.length} 条`)),
          h("div", { className: "gzs-panel__body gzs-actbody" },
            h("div", { className: "gzs-actlist" },
              acts.map((item, index) => h("button", {
                key: `${item.id}-${item.ts}-${index}`,
                className: "gzs-act",
                title: `${item.title}｜${ledgerText(item.event, { brief: true })}`,
                onClick: () => onOpen(item.id),
              },
                h("div", { className: "gzs-act__top" },
                  h("span", { className: `gzs-dot ${ACT_DOT[item.type] ?? ""}` }),
                  h("span", { className: "gzs-act__title" }, item.title),
                  h("span", { className: "gzs-act__time" }, timeText(item.ts))),
                h("div", { className: "gzs-act__d" },
                  ledgerText(item.event, { brief: true }),
                  item.count > 1 ? h("span", { className: "gzs-act__n" }, ` ×${item.count}`) : null))))))
        : null;

      /**
       * 库存条：四个数字一眼看到，且每个数字**可点**（点就筛到那一档）。
       * 只给数字不给入口的话，用户看到「3 篇草稿」还得自己去列表里翻是哪三篇。
       */
      const stateChip = (key, label, value, warn) => h("button", {
        key,
        className: `gzs-stat ${cur.state === key ? "gzs-stat--on" : ""} ${warn && value ? "gzs-stat--warn" : ""}`,
        onClick: () => onFilter?.({ ...cur, state: key }),
        title: key === "all" ? "全部文章" : `只看${label}`,
      },
        h("span", { className: "gzs-stat__n" }, String(value)),
        h("span", { className: "gzs-stat__k" }, label));

      /**
       * 库存条分两层：
       * 上层「有多少 + 搜什么」（数字 + 搜索框），下层「按什么筛」（赛道 + 标签 + 月份）。
       * 揉成一行会挤——数字要横向铺开、搜索要固定宽度、标签是变长的，三种宽度需求打架。
       */
      // 赛道筛选：只列「库里有稿」的赛道（空赛道不占位置），按篇数排。
      const allTracks = Array.isArray(tracks) ? tracks : [];
      const trackFacet = allTracks
        .map((track) => ({ ...track, count: Number(stat.byTrack?.[track.id] ?? 0) }))
        .filter((track) => track.count > 0)
        .sort((a, b) => b.count - a.count);
      // 「通用」= 没选内容类型的稿。只在有这类稿（或正按它筛）时出现，没稿不占位置。
      const untrackedCount = Number(stat.untracked ?? 0);
      const showUntracked = untrackedCount > 0 || cur.track === TRACK_NONE;
      const stockBar = h("div", { className: "gzs-stock" },
        h("div", { className: "gzs-stock__top" },
          h("div", { className: "gzs-stock__nums" },
            stateChip("all", "全部", stat.total),
            stateChip("draft", "草稿", stat.byState?.draft ?? 0),
            stateChip("draftbox", "草稿箱", stat.byState?.draftbox ?? 0),
            stateChip("published", "已发布", stat.byState?.published ?? 0),
            h("span", { className: "gzs-stat gzs-stat--plain", title: "建了但正文还是空的" },
              h("span", { className: "gzs-stat__n" }, String(stat.empty ?? 0)),
              h("span", { className: "gzs-stat__k" }, "空壳")),
            stat.unbound
              ? h("span", { className: "gzs-stat gzs-stat--plain", title: "没绑期号，流水线状态判不出来" },
                h("span", { className: "gzs-stat__n" }, String(stat.unbound)),
                h("span", { className: "gzs-stat__k" }, "未绑期号"))
              : null),
          h("div", { className: "gzs-search" },
            h("input", {
              className: "gzs-search__in", value: draft, placeholder: "搜标题、小标题、标签或正文…",
              onChange: (e) => setDraft(e.target.value),
              onKeyDown: (e) => { if (e.key === "Enter") { e.preventDefault(); applyQ(); } },
            }),
            draft
              ? h("button", { className: "gzs-search__x", onClick: () => { setDraft(""); onFilter?.({ ...cur, q: "" }); }, title: "清空搜索" }, "×")
              : null,
            h("button", { className: "gzs-search__go", onClick: applyQ }, "搜索"))),

        // 标签与月份：目录检索的两个入口，点一下即筛，不用输字。
        // 只在有数据时出现——空库不该顶一排空按钮。
        (stat.tags ?? []).length || (stat.months ?? []).length || trackFacet.length || showUntracked
          ? h("div", { className: "gzs-facet" },
            trackFacet.length || showUntracked
              ? h("div", { className: "gzs-facet__row" },
                h("span", { className: "gzs-facet__k" }, "内容类型"),
                h("button", {
                  className: `gzs-chip ${!cur.track ? "gzs-chip--on" : ""}`,
                  onClick: () => onFilter?.({ ...cur, track: "" }),
                  title: "不按内容类型筛",
                }, "全部"),
                trackFacet.map((track) => h("button", {
                  key: `track-${track.id}`,
                  className: `gzs-chip ${cur.track === track.id ? "gzs-chip--on" : ""}`,
                  onClick: () => onFilter?.({ ...cur, track: cur.track === track.id ? "" : track.id }),
                  title: `${track.name} · ${track.tierLabel}${track.custom ? " · 自定义" : ""}（按内容类型筛）`,
                }, track.name, h("span", { className: "gzs-chip__n" }, String(track.count)))),
                showUntracked
                  ? h("button", {
                    key: "track-none",
                    className: `gzs-chip ${cur.track === TRACK_NONE ? "gzs-chip--on" : ""}`,
                    onClick: () => onFilter?.({ ...cur, track: cur.track === TRACK_NONE ? "" : TRACK_NONE }),
                    title: "只看没选内容类型的稿（通用模式：不套禁用词与结构骨架）",
                  }, "通用", h("span", { className: "gzs-chip__n" }, String(untrackedCount)))
                  : null)
              : null,
            (stat.tags ?? []).length
              ? h("div", { className: "gzs-facet__row" },
                h("span", { className: "gzs-facet__k" }, "标签"),
                (stat.tags ?? []).slice(0, 12).map((tag) => h("button", {
                  key: `tag-${tag.name}`,
                  className: `gzs-chip ${cur.tag === tag.name ? "gzs-chip--on" : ""}`,
                  onClick: () => onFilter?.({ ...cur, tag: cur.tag === tag.name ? "" : tag.name }),
                  title: `按标签「${tag.name}」筛`,
                }, tag.name, h("span", { className: "gzs-chip__n" }, String(tag.count)))))
              : null,
            (stat.months ?? []).length
              ? h("div", { className: "gzs-facet__row" },
                h("span", { className: "gzs-facet__k" }, "月份"),
                (stat.months ?? []).slice(0, 8).map((m) => h("button", {
                  key: `m-${m.month}`,
                  className: `gzs-chip ${cur.month === m.month ? "gzs-chip--on" : ""}`,
                  onClick: () => onFilter?.({ ...cur, month: cur.month === m.month ? "" : m.month }),
                  title: `按月份「${m.month}」筛（按更新时间）`,
                }, `${m.month.slice(5)} 月`, h("span", { className: "gzs-chip__n" }, String(m.count)))))
              : null)
          : null);

      /**
       * 头部副文案：**筛选生效时要说清「按什么筛的、筛出几篇」**。
       * 只看 q 与 state 会漏掉标签和月份——点了标签却显示「1 篇 · 封面、正文…」，
       * 看着像总数变小了，而不是被筛出来的。
       */
      const filterWords = [];
      if (cur.q) filterWords.push(`含「${cur.q}」`);
      if (cur.tag) filterWords.push(`标签「${cur.tag}」`);
      if (cur.track === TRACK_NONE) filterWords.push("内容类型：通用");
      else if (cur.track) filterWords.push(`内容类型「${(Array.isArray(tracks) ? tracks : []).find((track) => track.id === cur.track)?.name ?? cur.track}」`);
      if (cur.month) filterWords.push(`${cur.month.slice(5)} 月`);
      if (cur.state && cur.state !== "all") {
        filterWords.push({ draft: "草稿", draftbox: "草稿箱", published: "已发布" }[cur.state] ?? cur.state);
      }
      const headHint = filterWords.length
        ? `筛出 ${matched ?? cards.length} 篇 · ${filterWords.join(" + ")}`
        : `${stat.total} 篇 · 封面、正文、配图、检查，一篇里走完`;

      return h("div", { className: "gzs-home" },
        h("div", { className: "gzs-homehead" },
          h("div", null,
            h("div", { className: "gzs-hometitle" }, "全部文章"),
            h("div", { className: "gzs-hint", style: { marginTop: 5 } },
              headHint)),
          h("div", { className: "gzs-spacer" }),
          root
            ? h("span", {
              className: "gzs-mono",
              title: `数据目录：${root}`,
              style: { marginRight: 12, maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
            }, root)
            : null,
          h(Btn, { kind: "primary", on: onCreate }, "＋ 新建一篇")),
        stockBar,
        h(TodayQueue, {
          list: cards, counts: stat, activity: acts,
          onOpen, onFilter,
          onCreate,
        }),
        h("div", { className: acts.length ? "gzs-homecols" : "gzs-homecols gzs-homecols--solo" },
          cards.length
            ? h("div", { className: "gzs-cards" },
              cards.map((a) => {
                const cover = imageUrl(a.id, "cover", a.cover);
                return h("button", {
                  key: a.id, className: "gzs-card",
                  title: a.pipeline?.status
                    ? `${a.title || a.id}\n${a.pipeline.status} · 下一步 ${a.pipeline.step ?? "—"}${a.pipeline.hint ? `\n${a.pipeline.hint}` : ""}`
                    : (a.title || a.id),
                  onClick: () => onOpen(a.id),
                },
                  h("div", {
                    className: "gzs-card__thumb",
                    style: cover ? { backgroundImage: `url("${cover}")` } : null,
                  },
                    // 首页就要能看出「这篇卡在哪」，不必点进去。
                    // 状态词原文留在 title 里，卡片上只放四个字的人话。
                    a.pipeline?.status
                      ? h("span", {
                        className: `gzs-card__badge gzs-card__badge--${STATUS_TEXT[a.pipeline.status]?.level ?? "warn"}`,
                      }, STATUS_TEXT[a.pipeline.status]?.text ?? a.pipeline.status)
                      : null,
                    cover ? null : "未出封面"),
                  h("div", { className: "gzs-card__body" },
                    h("div", { className: "gzs-card__title" }, a.title || "（无标题）"),
                    a.subtitle ? h("div", { className: "gzs-card__sub" }, a.subtitle) : null,
                    h("div", { className: "gzs-card__meta" },
                      // 生命周期放在最前：它回答「这篇在作者手里到哪了」，
                      // 比段数图数更该被先看到。人标的加「手」字标记，区分自动推断。
                      a.lifecycle?.value
                        ? h("span", {
                          className: `gzs-card__life gzs-card__life--${a.lifecycle.value}`,
                          title: a.lifecycle.source === "manual" ? "你自己标的" : "按账本自动推断",
                        }, `${{ draft: "草稿", draftbox: "草稿箱", published: "已发布" }[a.lifecycle.value] ?? a.lifecycle.value}${a.lifecycle.source === "manual" ? "·手" : ""}`)
                        : null,
                      // 赛道：一眼看出这篇按哪套口径写的（医疗和职场不能同一套说法）
                      a.track
                        ? h("span", { className: "gzs-card__track", title: `内容类型：${trackName(a.track)}` }, trackName(a.track))
                        : null,
                      h("span", null, a.empty ? "空壳" : `${a.sections ?? 0} 段 · ${a.words ?? 0} 字`),
                      h("span", null, `${a.images ?? 0} 图`),
                      a.template ? h("span", null, a.template) : null,
                      h("span", null, timeText(a.updatedAt)))));
              }),
              h("button", { className: "gzs-card gzs-card--new", onClick: onCreate }, "＋ 新建一篇"))
            : (stat.total ?? 0) === 0
              // 空库：三步开始（新建 / 配节点 / 连公众号）。
              ? h("div", { className: "gzs-blank" },
                h("b", null, "还没有任何文章"),
                h("p", null, "从下面任一件事开始就行。不用先想清楚全部——标题、段落、配图后面都能改。"),
                h(FirstRun, {
                  onCreate,
                  onConfigureNodes: () => onConfigureNodes?.(),
                  onConfigureWechat: () => onConfigureWechat?.(),
                }))
              // 库里有稿、只是筛没了：说清「是筛出来的 0 篇」，并给一键清筛选。
              : h("div", { className: "gzs-blank" },
                h("b", null, "没有匹配的稿"),
                h("p", null, `当前筛选条件下 0 篇（库里共 ${stat.total ?? 0} 篇）。`),
                h(Btn, { small: true, kind: "primary", on: () => onFilter?.({ state: "all", q: "", tag: "", month: "", track: "" }) }, "清掉筛选")),
          actPanel),
        // 往期在清单下方：先看「我手上的稿」，再往下才是「以前做过的」。
        h(RepoSection, null));
    }

    /**
     * 治理视图：把「哪几处要改、几个提案等着、最近动过什么」放到一屏。
     *
     * 这三样原来都在右栏检查器里，段落一多就得来回滚、来回切。
     * 这里只做「集中呈现」，不做新的判定 —— 数据全部来自 /article 已有的
     * qa / proposals / ledger，口径与右栏完全一致，不另算一套。
     */
    function Governance({ qa, proposals, ledger, onOpenProposal, onCloseProposal, onDecideProposal, onJump, proposalDetail, busy, pipeline: pipe, hasBody, deai, onAdoptDeai, reviews, onToggleReview }) {
      const items = qa?.items ?? [];
      const list = proposals ?? [];
      const rows = Array.isArray(ledger) ? ledger : [];
      const waiting = list.filter((p) => p.status === "waiting-user");
      const LEVEL_LABEL = { error: "必改", warn: "提醒", info: "提示" };
      const LEVEL_BADGE = { error: "error", warn: "warn", info: "info" };

      /**
       * 观测台：节点条 + 事实核对（宽版）。
       *
       * 这一块原来塞在 352px 的右栏里，11 个节点被挤成三行、密得看不清。
       * 同事那个观测台把这类信息放在**宽主区**是对的做法——信息量决定放哪，
       * 不是「相关的放一起」。侧栏只留状态词和卡点原因（够判断就行），
       * 完整进度来这里看。
       */
      const observPanel = pipe?.bound
        ? h("div", { className: "gzs-panel" },
          h("div", { className: "gzs-panel__head" },
            h("span", null, "流水线观测"),
            h("div", { className: "gzs-spacer" }),
            pipe.status ? h(Badge, { level: STATUS_TEXT[pipe.status]?.level ?? "warn" },
              `${pipe.episodeId} · ${STATUS_TEXT[pipe.status]?.text ?? pipe.status}`) : null),
          h("div", { className: "gzs-panel__body" },
            h("div", { className: "gzs-obs__hint" }, pipe.hint || "—"),
            h(NodeBar, { nodes: pipe.nodes, hasBody }),
            h("div", { className: "gzs-obs__facts" },
              h("div", { className: "gzs-eyebrow", style: { marginBottom: 5 } }, "事实核对"),
              h(Facts, { rows: pipe.facts }))))
        : null;

      const qaPanel = h("div", { className: "gzs-panel" },
        h("div", { className: "gzs-panel__head" },
          h("span", null, "检查结果"),
          h("div", { className: "gzs-spacer" }),
          qa
            ? h(Badge, { level: qa.ok ? "ok" : "error" }, qa.ok ? "可发布" : `${qa.counts.error} 个必改`)
            : h(Badge, { level: "mute" }, "未检查")),
        h("div", { className: "gzs-panel__body" },
          !qa
            ? h("div", { className: "gzs-gov__empty" }, "还没有检查结果")
            : items.length === 0
              ? h("div", { className: "gzs-gov__empty" }, "没有问题，可以直接发布")
              : ["error", "warn", "info"].map((level) => {
                const groupItems = items.filter((i) => i.level === level);
                if (!groupItems.length) return null;
                return h("div", { key: level, style: { marginBottom: 14 } },
                  h("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 6 } },
                    h(Badge, { level: LEVEL_BADGE[level] }, `${LEVEL_LABEL[level]} ${groupItems.length}`)),
                  groupItems.map((item, index) => h("div", {
                    key: `${item.id}-${index}`,
                    className: `gzs-qa gzs-qa--${item.level}`,
                    style: { marginBottom: 8, cursor: onJump ? "pointer" : "default" },
                    title: onJump ? "点一下跳到对应段落" : "",
                    onClick: onJump ? () => onJump(item.scope) : undefined,
                  },
                    h("div", { className: "gzs-qa__t" }, item.title),
                    item.detail ? h("div", { className: "gzs-qa__d" }, item.detail) : null,
                    h("div", { className: "gzs-qa__f" }, `改法：${item.fix}`))));
              })));

      // ── 去 AI 味 ──────────────────────────────────────────────────────────
      //
      // 这一块是本轮改造的重点。原来 07 那道门在本仓**没有机器判据**：节点条上永远是
      //「无机器判据，须看审稿包」，用户不知道该改哪句，Agent 也无从下手。
      // 现在把「像 AI 写的」拆成句子级证据：命中哪句、命中什么词、为什么像、怎么改。
      //
      // 交互口径：**勾选 → 生成提案 → 人确认**，三步。不提供「一键全改」按钮，
      // 因为机械替换能保住的只有「删过渡词」这类动作，句式还得人来判断。
      const [picked, setPicked] = React.useState({});
      /**
       * 面板一进来就假设 `deai.summary` 存在，会让老数据/半成品推送直接炸整块面板
       * （`Cannot read properties of undefined`）。宿主一定会给全，但**渲染层不该依赖外部完整性**——
       * 别人少给一个字段，用户看到的是白屏，而不是「这块暂时没有结论」。
       */
      const deaiView = deai
        ? {
          ...deai,
          sections: Array.isArray(deai.sections) ? deai.sections : [],
          rhythm: { items: Array.isArray(deai.rhythm?.items) ? deai.rhythm.items : [] },
          summary: deai.summary && typeof deai.summary.text === "string"
            ? deai.summary
            : { level: "none", text: "没有拿到诊断结论，点上面的「刷新」重算一次。" },
        }
        : null;
      const deaiRows = deaiView?.sections ?? [];
      const pickKey = (slot, start) => `${slot}:${start}`;
      const autoRows = deaiRows.flatMap((row) => (row.sentences ?? [])
        .filter((s) => s.mode === "auto")
        .map((s) => ({ ...s, slot: row.slot, sectionIndex: row.index })));
      const pickedList = autoRows.filter((s) => picked[pickKey(s.slot, s.start)]);
      /**
       * 一句话在多段里重复出现时（模板稿常见：三段同一句），按段列会把同一句列三遍，
       * 面板一下变成几十行，真正要看的节奏结论被挤出屏幕。
       * 所以**按句子文本去重**，把「出现在哪几段」收进一行显示；
       * 勾选仍然按 `slot:start` 各自独立——去重只是显示层，采纳必须落到每一段。
       */
      const mergedRows = [];
      for (const row of deaiRows) {
        for (const sentence of row.sentences ?? []) {
          const key = sentence.before.trim();
          const existing = mergedRows.find((m) => m.text === key);
          if (existing) {
            existing.at.push(row.index);
            existing.items.push({ ...sentence, slot: row.slot });
            continue;
          }
          mergedRows.push({ text: key, at: [row.index], items: [{ ...sentence, slot: row.slot }] });
        }
      }
      const deaiPanel = h("div", { className: "gzs-panel" },
        h("div", { className: "gzs-panel__head" },
          h("span", null, "去 AI 味"),
          h("div", { className: "gzs-spacer" }),
          deai
            ? h(Badge, { level: deaiView.summary.level === "ok" ? "ok" : deaiView.summary.level === "high" ? "error" : (deaiView.summary.level === "none" ? "mute" : "warn") },
              // 徽标说「几处」而不是「几句」：面板上合并后一行可能覆盖三段（三处），
              // 写「9 句」而只列 3 行，人会以为列表丢了东西。
              deaiView.total ? `${deaiView.total} 处` : "干净")
            : h(Badge, { level: "mute" }, "未检查")),
        h("div", { className: "gzs-panel__body" },
          !deai
            ? h("div", { className: "gzs-gov__empty" }, "还没有正文可查。")
            : h(React.Fragment, null,
              h("div", { className: "gzs-obs__hint" }, deaiView.summary.text),
              // 没有命中时**不再补一句空态文案**：上面那句已经说完了。
              // 两句话叠在一起说同一个意思（「没扫到 AI 腔…没扫到 AI 腔」）看着像出了故障。
              mergedRows.length
                ? mergedRows.map((row) => {
                  const sentence = row.items[0];
                  // 一句话可能出现在好几段：一行显示，勾选分别落到每一段。
                  // 这样「三段同一句」只占一行，实际采纳时三段都会改。
                  const keys = row.items.map((it) => pickKey(it.slot, it.start));
                  const on = keys.every((k) => picked[k]);
                  const canPick = row.items.every((it) => it.mode === "auto");
                  return h("div", {
                    key: row.text,
                    className: `gzs-deai__row ${on ? "gzs-deai__row--on" : ""} ${canPick ? "" : "gzs-deai__row--manual"}`,
                    onClick: canPick && !busy
                      ? () => setPicked((prev) => {
                        const next = { ...prev };
                        for (const k of keys) next[k] = !on;
                        return next;
                      })
                      : undefined,
                    title: canPick ? "点一下勾选/取消，勾了的会进提案" : "这句要人来写：机器只给了方向",
                  },
                  h("div", { className: "gzs-deai__mark" }, canPick ? (on ? "✓" : "") : "手"),
                  h("div", { className: "gzs-grow" },
                    h("div", { className: "gzs-deai__before" },
                      row.at.length > 1
                        ? h("span", { className: "gzs-deai__at" }, `${row.at.map((n) => `第 ${n} 段`).join("、")} 各出现一次`)
                        : null,
                      sentence.before.trim()),
                    sentence.after
                      ? h("div", { className: "gzs-deai__after" }, `→ ${sentence.after.trim()}`)
                      : null,
                    // 理由按**规则**逐条列：一条规则一行，命中词挂在它前面。
                    // 原来把两条规则的 why 用空格拼成一句，同一条规则被两个词命中时
                    // 会拼成「…没有画面。…没有画面。」，读起来像复读。
                    (sentence.reasons ?? []).map((reason) => h("div", { key: reason.id, className: "gzs-deai__why" },
                      h("span", { className: "gzs-deai__words" }, reason.words.join(" · ")),
                      h("span", { className: "gzs-deai__kind" }, reason.kind),
                      h("span", null, reason.why),
                      h("span", { className: "gzs-deai__fix" }, `改法：${reason.fix}`)))),
                  h("div", { className: `gzs-deai__lvl gzs-deai__lvl--${sentence.level || "low"}` },
                    sentence.level === "high" ? "明显" : sentence.level === "mid" ? "偏书面" : "轻微"));
                })
                : null,
              autoRows.length
                ? h("div", { className: "gzs-deai__acts" },
                  h(Btn, {
                    kind: "primary", small: true, disabled: busy || !pickedList.length,
                    on: () => {
                      onAdoptDeai(pickedList.map((s) => ({
                        slot: s.slot, start: s.start, end: s.end, after: s.after,
                      })));
                      setPicked({});
                    },
                  }, pickedList.length ? `采纳这 ${pickedList.length} 句，生成提案` : "勾几句可机器改的"),
                  h("span", { className: "gzs-hint" }, "标「手」的要人来写：机器硬凑只会换一种 AI 腔"))
                : null,
              // 节奏：句子层面之外的另一种 AI 味。词表抓不到「每段一样长」「通篇没有短句」，
              // 而这两样恰恰是读者一眼能感到「像机器写的」的地方。所以单列一块，不混进句子列表。
              deaiView.rhythm.items.length
                ? h("div", { className: "gzs-deai__rhythm" },
                  h("div", { className: "gzs-deai__rhythmhead" },
                    h("span", null, "整篇的节奏"),
                    h("div", { className: "gzs-spacer" }),
                    h("span", { className: "gzs-hint" }, "句子都对，读起来还是一顺到底")),
                  deaiView.rhythm.items.map((item) => h("div", { key: item.id, className: "gzs-deai__rhythmrow" },
                    h("div", { className: "gzs-deai__rhythmt" }, item.title),
                    item.detail ? h("div", { className: "gzs-deai__rhythmd" }, item.detail) : null,
                    h("div", { className: "gzs-deai__fix" }, `改法：${item.fix}`))))
                : null)));

      // ── 05/06 两份清单的逐项确认 ─────────────────────────────────────────
      //
      // 这两道门原来只能判「盘上有没有文件」，判不出「十条问题真答了吗」。
      // 文件一放上去门就绿，而清单可能一片空白——所以把 SKILL.md 的验收小节搬进来，
      // 人逐项勾，勾完才算这道门过。
      //
      // 但**勾选不能替代盘上清单**：下面 reconcile 那句会把两者的差距说出来，
      // 勾满了却没盘上文件，面板会明说「依据是面板确认，不是盘上清单」。
      const rv = reviews ?? { done: 0, total: 16, ok: false, list: [] };
      const reviewPanel = h("div", { className: "gzs-panel" },
        h("div", { className: "gzs-panel__head" },
          h("span", null, "编辑审 · 读者审"),
          h("div", { className: "gzs-spacer" }),
          h(Badge, { level: rv.ok ? "ok" : (rv.done ? "info" : "mute") }, `${rv.done}/${rv.total}`)),
        h("div", { className: "gzs-panel__body" },
          (rv.list ?? []).map((one) => h("div", { key: one.kind, className: "gzs-rev" },
            h("div", { className: "gzs-rev__head" },
              h("span", { className: "gzs-rev__no" }, `0${one.no}`),
              h("span", { className: "gzs-rev__label" }, one.label),
              h("div", { className: "gzs-spacer" }),
              one.ok
                ? h(Badge, { level: "ok" }, "勾满")
                : h("span", { className: "gzs-hint" }, `${one.done}/${one.total}`)),
            h("div", { className: "gzs-rev__about" }, one.about),
            one.items.map((item) => h("div", {
              key: item.id,
              className: `gzs-rev__item ${item.checked ? "gzs-rev__item--on" : ""}`,
              // 勾选是**人的动作**，所以要能给整行点，而不是只有小方块能点（小方块太小）
              onClick: busy ? undefined : () => onToggleReview({ kind: one.kind, item: item.id, checked: !item.checked }),
              title: item.checked ? `已勾 · ${stampText(item.at)}` : "点一下勾上",
            },
            h("span", { className: "gzs-rev__mark" }, item.checked ? "✓" : ""),
            h("span", { className: "gzs-rev__text" }, item.text)))),
          rv.done === 0
            ? h("div", { className: "gzs-hint", style: { marginTop: 8 } },
              "两份清单共 16 项。勾完这道门才算过；勾选只记在插件里，不改真实仓的文件。")
            : null)));

      const propPanel = h("div", { className: "gzs-panel" },
        h("div", { className: "gzs-panel__head" },
          h("span", null, "提案"),
          h("div", { className: "gzs-spacer" }),
          waiting.length
            ? h(Badge, { level: "info" }, `${waiting.length} 待确认`)
            : h(Badge, { level: "mute" }, "无待办")),
        h("div", { className: "gzs-panel__body" },
          list.length === 0
            ? h("div", { className: "gzs-gov__empty" },
              "没有提案。Agent 改稿会先提提案，你确认之后才写正文。")
            : h(ProposalBlock, {
              proposals: list,
              detail: proposalDetail,
              busy,
              onOpen: onOpenProposal,
              onClose: onCloseProposal,
              onDecide: onDecideProposal,
            })));

      // 配置类事件（绑定/解绑期号）不进账本视图：它们是操作杂事，不是内容工作。
      // 留在 `ledger.jsonl` 里做审计，但混在「改稿 / 出图 / 导出」中间会把真事冲走
      // ——一次验收跑就多一对绑定记录，40 行窗口能被它们占掉一半。
      const contentRows = rows.filter((row) => {
        const fields = Array.isArray(row?.fields) ? row.fields : [];
        if (fields.includes("pipeline:bound") || fields.includes("pipeline:unbound")) return false;
        return row?.type !== "pipeline:bound" && row?.type !== "pipeline:unbound";
      });
      const hiddenRows = rows.length - contentRows.length;

      /**
       * 相邻的同种动作折叠成一条并记次数，与服务端「最近动作」同一套口径。
       *
       * 不折的话，连点几次导出就会把 40 行窗口刷满——真事（出图、改稿）被挤到看不见。
       * 折叠只在**相邻**时做：中间夹了别的事就是两段不同操作，不该合并。
       */
      const foldSig = (row) => [row?.type ?? "", row?.format ?? "", row?.vid ?? "", row?.slot ?? "",
        (row?.fields ?? []).join(","), row?.decision ?? "", row?.pid ?? ""].join("|");
      // 先倒成「新→旧」再折叠：文件是时间升序的，折叠必须按**显示顺序**做，
      // 否则折的是旧记录、显示却是新记录，「×N」的计数会挂在一件不相关的事上。
      const foldedRows = [];
      const order = contentRows.slice().reverse(); // 新 → 旧
      for (let i = 0; i < order.length; i += 1) {
        const row = order[i];
        const prev = foldedRows[foldedRows.length - 1];
        if (prev && foldSig(prev.row) === foldSig(row)) {
          prev.count += 1;
          // 折叠掉的那几条也要算进编号：编号是「文件里的第几条」，不是「显示的第几行」
          continue;
        }
        foldedRows.push({ row, count: 1, no: contentRows.length - i });
      }

      const ledgerPanel = h("div", { className: "gzs-panel" },
        h("div", { className: "gzs-panel__head" },
          h("span", null, "账本（最近动作）"),
          h("div", { className: "gzs-spacer" }),
          h("span", { className: "gzs-hint", title: hiddenRows ? `另有 ${hiddenRows} 条绑定/解绑记录，只做审计不进视图` : "" },
            hiddenRows ? `${contentRows.length} 条 · 略去 ${hiddenRows} 条配置` : `${rows.length} 条`)),
        h("div", { className: "gzs-panel__body" },
          contentRows.length === 0
            ? h("div", { className: "gzs-gov__empty" }, "还没有动作记录")
            : h("div", { className: "gzs-ledger" },
              foldedRows.slice(0, 40).map((item, index) =>
                h("div", { key: index, className: "gzs-ledger__row" },
                  h("span", { className: "gzs-ledger__t" }, `#${item.no}`),
                  h("span", null, ledgerText(item.row),
                    item.count > 1 ? h("span", { className: "gzs-ledger__n" }, ` ×${item.count}`) : null))))));

      // 右栏「什么时候动过」：时间线在上（一眼看到最近动的是哪份文件），
      // 账本在下（谁为什么改）。两者分工不同，不是同一份东西的两种展示。
      const timePanel = pipe?.bound && (pipe.timeline ?? []).length
        ? h("div", { className: "gzs-panel" },
          h("div", { className: "gzs-panel__head" },
            h("span", null, "时间线"),
            h("div", { className: "gzs-spacer" }),
            h("span", { className: "gzs-hint" }, "交付件的文件改动时间")),
          h("div", { className: "gzs-panel__body" }, h(Timeline, { rows: pipe.timeline })))
        : null;

      return h("div", { className: "gzs-gov" },
        h("div", { className: "gzs-gov__grid" },
          // 左栏放「要处理的」（观测台 + 检查结果 + 提案），右栏放「历史」（时间线 + 账本）。
          // 原来账本跟着提案挤在右栏，左栏一长就在下面留一大块空白。
          h("div", { className: "gzs-gov__col" }, observPanel, qaPanel, deaiPanel, reviewPanel, propPanel),
          h("div", { className: "gzs-gov__col" }, timePanel, ledgerPanel)));
    }

    /**
     * 新建表单：把「讲给谁、讲什么、想带走什么」一次填清（Deckline 那个起手式）。
     * 段数只是先摆好空段落，讲稿本身还是人/Agent 写——工作台不假装会写稿。
     */
    function NewArticle({ templates, tracks, onCreate, onCancel, busy }) {
      const [title, setTitle] = React.useState("");
      const [audience, setAudience] = React.useState("");
      const [takeaway, setTakeaway] = React.useState("");
      const [sections, setSections] = React.useState(4);
      const [template, setTemplate] = React.useState(templates?.[0]?.id ?? "business");
      // 赛道决定「按哪套口径写」：换赛道顺手把模板切到它建议的那套（用户仍可再改）。
      const [track, setTrack] = React.useState("");
      const trackList = Array.isArray(tracks) ? tracks : [];
      const onTrack = (id) => {
        setTrack(id);
        const pack = trackList.find((item) => item.id === id);
        if (pack?.defaultTemplate) setTemplate(pack.defaultTemplate);
      };
      return h("div", { className: "gzs-home" },
        h("div", { className: "gzs-formwrap" },
          h("div", { className: "gzs-homehead" },
            h("div", null,
              h("div", { className: "gzs-hometitle" }, "新建一篇"),
              h("div", { className: "gzs-hint", style: { marginTop: 4 } },
                "先把「讲什么、给谁、带走什么」写清楚；段落和配图后面都能改，这几项定了才好写。"))),
          h("div", { className: "gzs-formcard" },
            h(Field, { label: "内容类型（可选，决定合规口径与默认长相）" },
              h("select", {
                className: "gzs-select", style: { width: "100%", maxWidth: "none" },
                value: track, onChange: (e) => onTrack(e.target.value),
              }, [
                h("option", { key: "", value: "" }, "通用（不套内容类型）"),
                ...trackList.map((item) => h("option", { key: item.id, value: item.id },
                  `${item.name} · ${item.tierLabel}${item.custom ? " · 自定义" : ""}`)),
              ]),
              track
                ? h("div", { className: "gzs-hint", style: { marginTop: 4 } },
                  (trackList.find((item) => item.id === track)?.tone ?? "") || "已选内容类型")
                : h("div", { className: "gzs-hint", style: { marginTop: 4 } },
                  "通用模式：不选也能写、能出图、能推。想加自己的内容类型，把一份 JSON 放进 ~/.dsh/gzh-studio/tracks/。")),
            h(Field, { label: "标题（先写个工作的，后面随时改）" },
              h("input", { className: "gzs-input", value: title, onChange: (e) => setTitle(e.target.value), placeholder: "例：一家药企把审批从 14 天压到 3 天" })),
            h(Field, { label: "讲给谁" },
              h("input", { className: "gzs-input", value: audience, onChange: (e) => setAudience(e.target.value), placeholder: "例：正在做数字化的药企 IT 负责人" })),
            h(Field, { label: "想让人带走什么" },
              h("input", { className: "gzs-input", value: takeaway, onChange: (e) => setTakeaway(e.target.value), placeholder: "例：知道自建审批流的两个坑" })),
            h("div", { className: "gzs-row", style: { gap: 14, alignItems: "flex-start" } },
              h("div", { style: { flex: "0 0 132px" } },
                h(Field, { label: "先摆几段" },
                  h("input", {
                    className: "gzs-input", type: "number", min: 1, max: 24, value: sections,
                    onChange: (e) => setSections(Math.max(1, Math.min(24, Number(e.target.value) || 1))),
                  }))),
              h("div", { className: "gzs-grow" },
                h(Field, { label: "排版模板" },
                  h("select", { className: "gzs-select", style: { width: "100%", maxWidth: "none" }, value: template, onChange: (e) => setTemplate(e.target.value) },
                    (templates ?? []).map((t) => h("option", { key: t.id, value: t.id }, t.name)))))),
            h("div", { className: "gzs-formacts" },
              h(Btn, { kind: "primary", disabled: busy, on: () => onCreate({ title, audience, takeaway, sections, template, track }) }, "建好，开始写"),
              h(Btn, { kind: "ghost", on: onCancel }, "取消")))));
    }

    /**
     * 左栏原生对话的开关状态，做成模块级 store。
     *
     * 提它到模块级是为了「带到对话」：右栏点一下，得先把左栏展开、再往那边的
     * 输入框里送字。工作台和这个动作不在同一棵子树里，用订阅式 store 比传 props 干净。
     */
    const chatOpenStore = (() => {
      let initial = true;
      try { initial = window.localStorage.getItem(CHAT_OPEN_KEY) !== "0"; } catch { initial = true; }
      const subs = new Set();
      return {
        value: initial,
        subs,
        set(next) {
          this.value = Boolean(next);
          try { window.localStorage.setItem(CHAT_OPEN_KEY, this.value ? "1" : "0"); } catch { /* 隐私模式存不了 */ }
          for (const fn of subs) { try { fn(this.value); } catch { /* 单个订阅方炸了不拖累别的 */ } }
        },
      };
    })();

    /** React 侧的订阅入口。 */
    function useChatOpen() {
      const [open, setOpen] = React.useState(() => chatOpenStore.value);
      React.useEffect(() => {
        const receive = (next) => setOpen(next);
        chatOpenStore.subs.add(receive);
        return () => { chatOpenStore.subs.delete(receive); };
      }, []);
      return [open, (next) => chatOpenStore.set(next)];
    }

    // ── 左栏原生对话：面板自己 retain 一条会话，交给宿主渲染 ────────────────────
    /**
     * 会话 id 的铸造方式必须和宿主一致（`session-<uuid v4>`）。
     * 宿主允许调用方预分配 id，好处是**创建之前**就知道 id：万一 create 超时，
     * 后面列表回来还能按这个 id 认领，不至于留下一堆孤儿会话。
     */
    function mintChatSessionId() {
      const bytes = globalThis.crypto?.getRandomValues?.(new Uint8Array(16));
      if (bytes) {
        const hex = Array.from(bytes, (byte, index) => {
          const value = index === 6 ? (byte & 15) | 64 : index === 8 ? (byte & 63) | 128 : byte;
          return value.toString(16).padStart(2, "0");
        }).join("");
        return `session-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      }
      return `session-gzh-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    /** 路径比较统一成「反斜杠 + 无尾斜杠 + 小写」，否则 D:/a 和 d:\a\ 会被判成两个目录。 */
    function normalizeChatPath(value) {
      return String(value ?? "")
        .replace(/\//g, "\\")
        .replace(/\\+$/, "")
        .toLowerCase();
    }

    /**
     * 读「这条线用哪条会话」。
     *
     * 存的是 `{ sessionId, repoRoot, workspaceId }` 而不是光一个 id：仓库根变了
     * （用户换了产线根目录）时，旧会话的 cwd 就是错的，宁可从零开一条，
     * 也不要在一个指向别处的会话里继续说话。
     */
    function readStoredChatSession(key, repoRoot, workspaceId) {
      try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return null;
        const record = JSON.parse(raw);
        if (!record || typeof record !== "object" || typeof record.sessionId !== "string") return null;
        if (normalizeChatPath(record.repoRoot) !== normalizeChatPath(repoRoot)) return null;
        if (String(record.workspaceId ?? "") !== String(workspaceId ?? "")) return null;
        return record.sessionId;
      } catch {
        return null;
      }
    }

    function writeStoredChatSession(key, sessionId, repoRoot, workspaceId) {
      try {
        window.localStorage.setItem(key, JSON.stringify({ sessionId, repoRoot, workspaceId: workspaceId ?? null }));
      } catch { /* 隐私模式记不住：本次仍然用这条会话，只是下次会重开 */ }
    }

    /** 会话生命周期里会挡路的几种状态，翻成一句能照着办的话。 */
    function chatSessionProblem(snapshot) {
      if (!snapshot) return "会话没有返回生命周期状态";
      if (snapshot.removed === true) return "会话已被移除";
      if (snapshot.openState !== "open") {
        const detail = snapshot.openError?.message ?? snapshot.openError?.code ?? snapshot.openState ?? "unknown";
        return `会话历史没有打开（${detail}）`;
      }
      if (snapshot.promptError) {
        const detail = snapshot.promptError.error?.message ?? snapshot.promptError.error?.code ?? "发送失败";
        return `上一条消息没有发送成功（${detail}）`;
      }
      return "";
    }

    /**
     * 按「线」绑定一条原生会话。
     *
     * 为什么按线（公众号 / 视频号）而不是按文章：这是历史工作台验证过的口径——
     * 一条产线一个连续上下文，切文章不切断对话。按文章分会话会有两个副作用：
     * 每点一篇文章就多一条空会话；同一件事分开聊，agent 记不住上一句。
     *
     * 铁律：**只用自己的会话**。存下来的 id 若已经不在列表里、或属于别的目录，
     * 一律丢掉重开，绝不复用别的任务的对话。
     */
    function useChatSession(repoRoot, workspaceId, enabled, line) {
      const [reference, setReference] = React.useState(null);
      const [problem, setProblem] = React.useState(null);
      const [nonce, setNonce] = React.useState(0);
      /**
       * 按住的会话引用，以及它属于哪一组条件（哪条线 / 哪个仓根 / 哪个工作区）。
       *
       * 放在 ref 而不是 state 里，是为了让「关掉左栏再打开」复用同一个引用：
       * 引用一旦 release，宿主那边就是**已释放**状态，接着拿它去渲染会直接抛
       * `Session reference "..." is released`。实测过一次——收起再打开左栏，整个
       * 主区面板被宿主判为崩溃（`slot entry crashed in 'main'`），面板整块消失。
       * 所以：**关左栏不释放，换线 / 换仓根 / 卸载才释放**。
       */
      const heldRef = React.useRef(null);
      const tagRef = React.useRef(null);
      const dropHeld = React.useCallback(() => {
        try { heldRef.current?.release?.(); } catch { /* 已经放掉了 */ }
        heldRef.current = null;
        tagRef.current = null;
      }, []);
      // 面板卸载才释放引用（依赖为空：dropHeld 的 identity 稳定）
      React.useEffect(() => () => dropHeld(), [dropHeld]);

      React.useEffect(() => {
        if (!enabled) return undefined;
        const sessions = clientContext?.sessions;
        if (!sessions || typeof sessions.create !== "function") {
          setProblem("宿主这一版没提供会话服务（ctx.sessions），左栏内嵌不了原生对话。");
          return undefined;
        }
        if (!repoRoot) {
          setProblem("还没读到仓根（state.root），先刷新一次。");
          return undefined;
        }
        const tag = `${line}|${normalizeChatPath(repoRoot)}|${workspaceId ?? ""}`;
        // 条件变了（换了线 / 换了仓根 / 换了工作区 / 点了重开）→ 旧的引用作废
        if (tagRef.current !== null && tagRef.current !== tag) dropHeld();
        // 同一条线已经拿住了：直接把现成的引用交出去，不重开也不释放
        if (heldRef.current && tagRef.current === tag) {
          setReference(heldRef.current);
          setProblem(null);
          return undefined;
        }

        let alive = true;
        let held = null;
        const key = `${CHAT_KEY}.${line}`;
        const forget = () => {
          try { window.localStorage.removeItem(key); } catch { /* 无所谓 */ }
        };
        const release = () => {
          try { held?.release?.(); } catch { /* 已经放掉了 */ }
          if (heldRef.current === held) { heldRef.current = null; tagRef.current = null; }
          held = null;
        };
        setReference(null);
        setProblem(null);
        (async () => {
          try {
            let id = readStoredChatSession(key, repoRoot, workspaceId);
            if (!id) forget();
            if (id) {
              try {
                held = sessions.retain(id, { source: CHAT_SOURCE });
                const binding = await held.ready;
                const lifecycleProblem = chatSessionProblem(binding?.session?.getSnapshot?.());
                const row = sessions.list?.getSnapshot?.()?.byId?.[id];
                const wrongRepo = row?.cwd && normalizeChatPath(row.cwd) !== normalizeChatPath(repoRoot);
                if (lifecycleProblem || wrongRepo) {
                  throw new Error(wrongRepo ? `会话属于其他目录：${row.cwd}` : lifecycleProblem);
                }
              } catch {
                release();
                forget();
                id = null;
              }
            }
            if (heldRef.current && tagRef.current === tag) {
              // 并发里的另一个 run 已经先拿住了：这一份多的退掉，别把引用数记重
              try { held?.release?.(); } catch { /* 同上 */ }
              held = null;
            }
            if (!held) {
              const requestedId = mintChatSessionId();
              const createOptions = workspaceId
                ? { workspaceId, sessionId: requestedId }
                : { cwd: repoRoot, sessionId: requestedId };
              const created = await sessions.create(createOptions);
              if (!alive) return;
              held = sessions.retain(created, { source: CHAT_SOURCE });
              const binding = await held.ready;
              const lifecycleProblem = chatSessionProblem(binding?.session?.getSnapshot?.());
              if (lifecycleProblem) throw new Error(lifecycleProblem);
              const row = sessions.list?.getSnapshot?.()?.byId?.[created];
              if (row?.cwd && normalizeChatPath(row.cwd) !== normalizeChatPath(repoRoot)) {
                throw new Error(`新会话属于其他目录：${row.cwd}`);
              }
              writeStoredChatSession(key, created, repoRoot, workspaceId);
            }
            if (!alive) { release(); return; }
            heldRef.current = held;
            tagRef.current = tag;
            setReference(held);
            setProblem(null);
          } catch (error) {
            release();
            forget();
            if (alive) {
              setReference(null);
              setProblem(`开会话失败：${error?.message ?? String(error)}。请点「重开」重试。`);
            }
          }
        })();
        // 注意这里**不调用 release()**：这个 effect 的清理发生在「关掉左栏 / 换条件」时，
        // 而关掉左栏只是暂时不显示，引用还得留着给下次打开用。真正的释放在 tag 变化
        // 与卸载时（dropHeld）。
        return () => { alive = false; };
      }, [enabled, repoRoot, workspaceId, line, nonce, dropHeld]);

      /** 重开：忘掉这条线的会话，从崭新的一条开始。 */
      const reset = React.useCallback(() => {
        try { window.localStorage.removeItem(`${CHAT_KEY}.${line}`); } catch { /* 同上 */ }
        dropHeld();
        setReference(null);
        setProblem(null);
        setNonce((value) => value + 1);
      }, [line, dropHeld]);
      return { reference, problem, reset };
    }

    /**
     * `session` 作用域里的内容位。
     *
     * 这个组件由宿主在**一条已绑定会话**的上下文里渲染，所以 `useSession` 拿到的是
     * 我们 retain 的那条会话，不可能是别处的。空会话走 `phase: "hero"`，
     * 宿主会渲染成「新对话」的引导态——就是用户要的「崭新的对话框」。
     */
    function ChatSurface(props) {
      const useSession = typeof props.useSession === "function" ? props.useSession : () => null;
      const session = useSession((value) => value);
      if (typeof props.renderFactorySlot !== "function") {
        return h("div", { className: "gzs-chatnote" }, "宿主这一版没给工厂槽位，内嵌不了原生对话。");
      }
      const lifecycleProblem = session?.removed === true
        ? "当前会话已被移除，请点「重开」。"
        : session?.openState === "error"
          ? `会话历史读取失败：${session.openError?.message ?? session.openError?.code ?? "未知错误"}`
          : session?.promptError
            ? `消息发送失败：${session.promptError.error?.message ?? session.promptError.error?.code ?? "未知错误"}`
            : session?.lastAgentError
              ? `Agent 执行失败：${session.lastAgentError}`
              : "";
      const blank = !session || (
        session.blank === true &&
        session.running !== true &&
        session.promptAttempted !== true &&
        session.awaitingFirstTurn !== true
      );
      const content = props.renderFactorySlot("conversation.content", {
        variant: "embedded", phase: blank ? "hero" : "active", hero: blank,
      });
      return lifecycleProblem
        ? h(React.Fragment, null,
          h("div", { className: "gzs-chatnote", role: "alert" }, lifecycleProblem),
          content)
        : content;
    }

    /**
     * 左栏的对话容器。
     *
     * 只在用户展开左栏时才开会话——不展开却先建一条空会话，会在会话列表里
     * 平白多出一行「新对话」，而用户根本没打算聊。
     */
    function ChatDock(props) {
      const { reference, problem, onReset, onClose, running, SessionProvider, renderSlot, label } = props;
      const ready = typeof SessionProvider === "function" && typeof renderSlot === "function";
      return h("div", { className: "gzs-chatdock" },
        h("div", { className: "gzs-chatcol__bar" },
          h("span", { className: "gzs-chatcol__t" }, "DSH 原生对话"),
          h("span", { className: "gzs-chatcol__ctx", title: label }, label),
          running
            ? h("span", { className: "gzs-chatrun" }, h("span", { className: "gzs-chatdot" }), "在跑")
            : h("span", { className: "gzs-chatcol__s" }, "带到对话只填入，不自动发送"),
          h("button", { className: "gzs-chatcol__x", title: "重开一条崭新对话", onClick: onReset }, "重开"),
          h("button", { className: "gzs-chatcol__x", title: "收起对话，面板占满", onClick: onClose }, "×")),
        h("div", { className: "gzs-chatbody" },
          problem
            ? h("div", { className: "gzs-chatnote", role: "alert" }, problem)
            : !ready
              ? h("div", { className: "gzs-chatnote" }, "宿主这一版没有原生对话渲染能力。")
              : !reference
                ? h("div", { className: "gzs-chatnote" }, "正在开会话…")
                : h(SessionProvider, { session: reference }, renderSlot(CHAT_SLOT, {}))));
    }

    // ── 面板 → 左栏原生输入框：只递话，不替人发送 ──────────────────────────────
    /**
     * 找原生输入框：Lexical 的 contenteditable 根。
     *
     * 优先在**左栏对话列里**找。以前这段是给同源 iframe 用的，只能查全局 `document`；
     * 现在对话就在本面板里，宿主自己的输入框也可能在 DOM 上（侧栏、其它面板），
     * 所以先按容器收窄，找不到才退回全文档。
     */
    function findComposer() {
      const scope = (() => { try { return document.querySelector(".gzs-chatcol") ?? document; } catch { return null; } })();
      const queries = [
        '[data-lexical-editor="true"]',
        '[contenteditable="true"][aria-multiline="true"]',
        '[contenteditable="true"]',
      ];
      try {
        for (const root of [scope, document]) {
          if (!root?.querySelector) continue;
          for (const selector of queries) {
            const found = root.querySelector(selector);
            if (found) return found;
          }
        }
        return null;
      } catch { return null; }
    }

    /**
     * 把一段话填进原生输入框（**只填不发送**）。
     *
     * 三种写法依次试，因为 composer 是 Lexical 的 contenteditable：
     * 直接改 textContent 会被编辑器的受控状态覆盖，必须走它认得的输入通道。
     * 1. `execCommand("insertText")` —— Chrome 下触发 beforeinput，编辑器按正常打字处理（带撤销栈）；
     * 2. 编辑器实例上的 `INSERT_TEXT` 命令（DOM 节点上挂着 `__lexicalEditor`）；
     * 3. 带 `DataTransfer` 的 paste 事件 —— 剪贴板插件会接管。
     * 三种都不成，就**如实回报**，别让人以为填进去了。
     * @param {string} text
     */
    function insertIntoComposer(text) {
      const body = String(text ?? "");
      if (!body.trim()) return { ok: false, reason: "内容是空的" };
      const host = findComposer();
      if (!host) return { ok: false, reason: "没找到输入框（左栏还没加载完？）" };
      const lands = () => String(host.textContent ?? "").replace(/\s+/g, "").includes(body.replace(/\s+/g, "").slice(0, 8));
      try { host.focus(); } catch { /* 焦点拿不到也继续试 */ }

      try { if (document.execCommand("insertText", false, body) && lands()) return { ok: true, via: "execCommand" }; } catch { /* 往下试 */ }
      try {
        const editor = host.__lexicalEditor;
        if (editor?.dispatchCommand && editor.dispatchCommand("INSERT_TEXT", body) && lands()) return { ok: true, via: "lexical" };
      } catch { /* 往下试 */ }
      try {
        const data = new DataTransfer();
        data.setData("text/plain", body);
        host.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
        if (lands()) return { ok: true, via: "paste" };
      } catch { /* 落到下面统一回报 */ }
      return { ok: false, reason: "输入框在，但三种写法都没落进去" };
    }

    /**
     * 面板侧：把带定位的一句话送到左栏**原生输入框**里。
     *
     * 面板永远不替用户按回车：填进去、光标落在那儿，发不发由人决定。
     * 这也顺手解决一个诚实问题——面板自己发出去的消息，用户在原生输入框里
     * 看不到、改不了、也撤不回。
     *
     * 对话在本面板里之后这件事简化为「等输入框出现 → 填 → 复核」：
     * 左栏刚展开、会话还在开会时输入框不存在，所以要等，等到就给结论。
     * @param {string} text
     * @returns {Promise<{ok:boolean, reason?:string, via?:string}>}
     */
    function bringToChat(text) {
      const body = String(text ?? "");
      if (!body.trim()) return Promise.resolve({ ok: false, reason: "内容是空的" });
      chatOpenStore.set(true); // 先展开左栏，否则没有输入框可填

      return new Promise((resolve) => {
        let done = false;
        let timer = 0;
        let retry = 0;
        let lastReason = "";
        const finish = (result) => {
          if (done) return;
          done = true;
          try { window.clearTimeout(timer); window.clearInterval(retry); } catch { /* 已卸载 */ }
          resolve(result);
        };
        const attempt = () => {
          if (done) return;
          let result;
          try { result = insertIntoComposer(body); } catch (error) { result = { ok: false, reason: String(error?.message ?? error) }; }
          if (result.ok) { finish(result); return; }
          lastReason = result.reason ?? "";
        };
        // 左栏刚展开 / 会话正在开会：输入框稍后才出现，隔 500ms 再试。
        attempt();
        retry = window.setInterval(attempt, 500);
        timer = window.setTimeout(() => finish({ ok: false, reason: lastReason ? `等左栏输入框 8 秒：${lastReason}` : "等左栏输入框 8 秒没有结果" }), 8000);
      });
    }
    /**
     * 降级/兜底：主区容器。
     *
     * 槽位给的标准 props 要**原样往下传**：`SessionProvider` / `renderSlot` 用来装配
     * 左栏那条原生对话，`useWorkspaces` 用来把仓根对到工作区 id，`useSessionStatus`
     * 用来显示「在跑」。少传一个，左栏就会退化成一句「宿主这一版没有渲染能力」。
     */
    function MainPanel(props) {
      return h("div", { className: "gzs-main" }, h("div", { className: "gzs-main__body" }, h(Workspace, props ?? {})));
    }

    /** 侧边栏面板列表的图标。 */
    function PanelGlyph({ size }) {
      return h("span", { style: { fontSize: size ?? 15, lineHeight: 1 } }, "📝");
    }

    // ── apply ─────────────────────────────────────────────────────────────────
    /**
     * 客户端插件体：注册主区工作台 + 侧边栏入口，并声明左栏那条会话作用域的对话位。
     *
     * 为什么要 `children: { [CHAT_SLOT]: { kind: "single", scope: "session" } }`：
     * 主区面板自己会 retain 一条会话，但「渲染一条会话的对话」这件事必须交给宿主，
     * 而且要有 session 作用域，宿主才会把 `useSession` / `conversation.content`
     * 工厂槽注入进来。少了这行声明，`renderSlot(CHAT_SLOT)` 拿不到东西。
     * @param {import('@deepseek-ai/cordis').Context} ctx
     */
    function apply(ctx) {
      injectStylesheet();
      clientContext = ctx;
      /**
       * 注册一个槽位，失败要留下证据。
       *
       * 为什么要包一层：面板没注册上时，界面上**完全看不出发生了什么**——侧栏少一行、
       * 「更多」里也没有它，用户看到的就是「我的新媒体工作台不见了」。
       * 宿主重建 bundle 的那几秒里 slots 可能还没就绪，所以这里补一次延迟重试；
       * 真失败也要在控制台点名，别让下一次排查又从头猜。
       *
       * @param {string} name 槽位名。
       * @param {() => unknown} register 注册函数（延迟到 inject 回调里执行）。
       * @param {string} label 供宿主/日志辨认的标签。
       */
      const registerSlot = (name, register, label) => {
        let tries = 0;
        const run = () => {
          tries += 1;
          try {
            ctx.effect(() => ctx.slots.inject(name, register), label);
            return true;
          } catch (error) {
            window.console?.error?.(`[gzh-studio] 注册 ${name} 失败（第 ${tries} 次）`, error);
            return false;
          }
        };
        if (run()) return;
        window.setTimeout(() => {
          if (!run()) window.console?.error?.(`[gzh-studio] ${name} 仍未注册成功：面板入口会缺失，请刷新页面`);
        }, 800);
      };

      registerSlot("main", () => ctx.slots.register({
        name: "main",
        key: PANEL_KEY,
        children: { [CHAT_SLOT]: { kind: "single", scope: "session" } },
      }, MainPanel), "gzh-studio: main panel");
      registerSlot(CHAT_SLOT, () => ctx.slots.register({ name: CHAT_SLOT }, ChatSurface), "gzh-studio: chat surface");
      registerSlot("sidebar.panellist", () =>
        ctx.slots.register({ name: "sidebar.panellist", id: PANEL_KEY, order: 50, label: () => PANEL_LABEL }, PanelGlyph),
      "gzh-studio: sidebar entry");
      ctx.logger?.info?.("gzh-studio client: main workspace mode");
    }

    exports.apply = apply;
    // `sessions` 必须在 inject 里：apply 里要抓 ctx 交给 useChatSession，
    // 而会话服务没就绪就抓不到——那时候左栏只能显示「开会话失败」。
    exports.inject = ["slots", "sessions"];
    exports.PANEL_KEY = PANEL_KEY;
    exports.PANEL_LABEL = PANEL_LABEL;
    exports.ROUTES = ROUTES;
    // 可测面（verify/client-harness.mjs 直接调用这些纯组件）
    exports.Workspace = Workspace;
    exports.MainPanel = MainPanel;
    exports.PhonePreview = PhonePreview;
    exports.Outline = Outline;
    exports.Inspector = Inspector;
    exports.NewArticle = NewArticle;
    exports.Home = Home;
    exports.Governance = Governance;
    exports.currentVersion = currentVersion;
    exports.PipeBlock = PipeBlock;
    exports.NodeBar = NodeBar;
    exports.Timeline = Timeline;
    exports.Facts = Facts;
    exports.STATUS_TEXT = STATUS_TEXT;
    exports.sectionIndex = sectionIndex;
    exports.timeText = timeText;
    exports.stampText = stampText;
    exports.countWords = countWords;
    exports.ledgerText = ledgerText;
    exports.imageUrl = imageUrl;
    exports.CSS = CSS;
    exports.PHONE_WIDTH = PHONE_WIDTH;
    // 本轮新增（工作台形态）：左栏步骤 / 中栏舞台 / 检查器 tab
    exports.inferSteps = inferSteps;
    exports.StepRail = StepRail;
    exports.Stage = Stage;
    exports.Manuscript = Manuscript;
    exports.ExportBar = ExportBar;
    exports.GateList = GateList;
    exports.ImageBoard = ImageBoard;
    exports.STEP_NAMES = STEP_NAMES;
    exports.STEP_WORD = STEP_WORD;
    exports.OpinionComposer = OpinionComposer;
    exports.RepoSection = RepoSection;
    exports.RepoPreview = RepoPreview;
    exports.VideoBoard = VideoBoard;
    exports.VideoEpisode = VideoEpisode;
    exports.EpisodePlayer = EpisodePlayer;
    // 版式：可拖拽分栏 + 视频号右栏 + 宽度读写。给 `verify/layout-split.mjs` 用。
    exports.Splitter = Splitter;
    exports.VideoAside = VideoAside;
    exports.COL_LIMITS = COL_LIMITS;
    exports.autoCols = autoCols;
    exports.fitCols = fitCols;
    exports.MID_NEED = MID_NEED;
    exports.MID_FLOOR = MID_FLOOR;
    exports.COL_STORE_KEY = COL_STORE_KEY;
    exports.SPLIT_W = SPLIT_W;
    exports.readCols = readCols;
    exports.saveCols = saveCols;
    exports.ROUTES = ROUTES;
    // 推草稿对话框：单测直接渲染它（没配公众号时是配置向导，配好了是推前自查）
    exports.PushDialog = PushDialog;
    exports.PublishPackDialog = PublishPackDialog;
    exports.PLATFORM_SPECS = PLATFORM_SPECS;
    exports.platformPack = platformPack;
    exports.targetsFromDraft = targetsFromDraft;
    exports.ProposalBlock = ProposalBlock;
    exports.healResizeCursor = healResizeCursor;
    exports.parseCssColor = parseCssColor;
    exports.themeFromRgb = themeFromRgb;
    exports.mixRgb = mixRgb;
    exports.paletteFor = paletteFor;
    exports.saturationOf = saturationOf;
    exports.tintWeightFor = tintWeightFor;
    exports.sampleBackdrop = sampleBackdrop;
    exports.applyThemeTo = applyThemeTo;
    exports.LastPublishNotice = LastPublishNotice;
    exports.FirstRun = FirstRun;
    exports.TodayQueue = TodayQueue;
    exports.NodeDialog = NodeDialog;
    exports.wechatConfigPayload = wechatConfigPayload;
    exports.VIDEO_STEPS = VIDEO_STEPS;
    exports.markdownBlocks = markdownBlocks;
    // 左栏原生对话（会话内嵌形态）+ 只递话不发送的填字通道
    exports.chatOpenStore = chatOpenStore;
    exports.CHAT_SLOT = CHAT_SLOT;
    exports.CHAT_KEY = CHAT_KEY;
    exports.CHAT_SOURCE = CHAT_SOURCE;
    exports.CHAT_DECISION_KEY = CHAT_DECISION_KEY;
    exports.useChatSession = useChatSession;
    exports.ChatSurface = ChatSurface;
    exports.ChatDock = ChatDock;
    exports.mintChatSessionId = mintChatSessionId;
    exports.normalizeChatPath = normalizeChatPath;
    exports.readStoredChatSession = readStoredChatSession;
    exports.writeStoredChatSession = writeStoredChatSession;
    exports.chatSessionProblem = chatSessionProblem;
    exports.insertIntoComposer = insertIntoComposer;
    exports.findComposer = findComposer;
    exports.bringToChat = bringToChat;
    return module.exports;
  },
});




















