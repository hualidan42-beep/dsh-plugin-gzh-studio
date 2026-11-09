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
      // 删一篇（移到回收站，不硬删）。宿主没重启时这条不存在，界面会明说
      remove: "/api/gzh-studio.remove",
      save: "/api/gzh-studio.save",
      generate: "/api/gzh-studio.generate",
      pick: "/api/gzh-studio.pick",
      feedback: "/api/gzh-studio.feedback",
      export: "/api/gzh-studio.export",
      // 推草稿箱：状态（配没配）+ 真推一次。宿主没重启时这两条不存在，界面会明说
      wechatStatus: "/api/gzh-studio.wechatStatus",
      push: "/api/gzh-studio.push",
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
      // 仓库真源（只读）：往期稿件列表 + 单篇。写盘的一律不接——
      // 真源归仓库，面板只借来看，改稿仍然改工作台自己库里那份。
      repo: "/api/gzh-studio.repo",
      repoArticle: "/api/gzh-studio.repoArticle",
      // 视频号（只读）：期列表 + 单期。
      //
      // 这两个常量曾经漏写，`getJson(ROUTES.video)` 于是 fetch 了 `/undefined`，
      // 宿主回 404，面板把它判成「路由未启用」并让人去重启宿主 —— 重启一百次也没用。
      // 和上面 `ROUTES.pipeline` 是同一种事故，所以现在有 `verify/route-check.mjs`
      // 专门盯这一件事：代码里用到的 ROUTES 键必须都在这里定义。
      video: "/api/gzh-studio.video",
      videoEpisode: "/api/gzh-studio.videoEpisode",
      // 视频目录空态上的两个动作：指到已有目录（path）/ 建出约定目录（create）
      videoSetup: "/api/gzh-studio.videoSetup",
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

    /**
     * 一条请求最多等 15 秒。
     *
     * 裸 `fetch` 没有上限：宿主进程活着、那条路由却不返回时，按钮点下去永远是「没反应」，
     * 人只能猜是慢还是死。给个硬上限，至少能弹一句人话。
     * 不用 `AbortSignal.timeout`——老 WebView / 内嵌 Electron 里没有它，这里要能直接跑。
     */
    const REQUEST_TIMEOUT_MS = 15_000;

    /**
     * 一次 JSON 请求的公共壳：超时 + 解析 + 非 2xx 抛错。
     *
     * 超时走 `AbortController`，`finally` 里必清定时器：不清的话每个请求都会留一个
     * 15 秒后才响的 timer，长会话里攒着不放。abort 抛出来的错误名各浏览器不一致
     * （`AbortError` / `DOMException`），所以只认 signal 自己的状态。
     */
    async function requestJson(url, init = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(url, { ...init, credentials: "same-origin", signal: controller.signal });
        const data = await response.json().catch(() => null);
        if (!response.ok) throw httpError(response, data);
        return data;
      } catch (error) {
        if (controller.signal.aborted) throw new Error("宿主 15 秒没响应，可能卡住了");
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    /** GET JSON；非 2xx 抛错（把宿主回的 error.message 原样带上，不吞）。 */
    async function getJson(url) {
      return requestJson(url);
    }

    /** POST JSON；同上。 */
    async function postJson(url, body) {
      return requestJson(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
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

    /**
     * 模板的**显示名**：模板清单里有就用中文名，没有就照原样显示 id。
     *
     * 和 `templateOf` 的区别是「猜不猜」：`templateOf` 的职责是永远给出一套能用的 token，
     * 所以拿不到就退回默认那套；但卡片上写的是给人看的名字，拿不到时显示 id（business）
     * 比冒充「默认」诚实——用户会看出这套模板没加载，而不是以为自己的稿被换了模板。
     */
    function templateName(templates, id) {
      if (!id) return "";
      const list = Array.isArray(templates) ? templates : [];
      const hit = list.find((t) => t && t.id === id);
      return hit?.name || String(id);
    }

    /** 正文 `**加粗**` → 片段数组（与导出器的极简语法一致）。 */
    function rich(text) {
      const parts = String(text ?? "").split(/\*\*([^*\n]+)\*\*/g);
      return parts.map((part, index) =>
        index % 2 === 1 ? h("strong", { key: index, style: { fontWeight: 600 } }, part) : part);
    }

    /**
     * 绝对路径压成「看得懂的短路径」：取末两级。
     *
     * 面板上要显示「我正在读哪个目录」，但一整条 `D:\我的内容仓库\07-video\episode`
     * 会顶掉标题。末两级（`07-video/episode`）既能认出是哪儿，又不会撑破一行。
     * 原路径放 `title`，想核对全文再悬停。
     */
    function shortPath(path) {
      const parts = String(path ?? "").split(/[\\/]+/).filter(Boolean);
      if (!parts.length) return "";
      return parts.slice(-2).join("/");
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
   用户找一个「往期」得从左读到右。
   0.3.4：组自己也要能换行（flex-wrap），否则窄面板里是**整条溢出**——
   1100 的窗口上「图片清单」直接被切掉半颗按钮（实测 rootOverflow 54）。 */
.gzs-headgroup{display:flex;align-items:center;gap:6px;flex:0 1 auto;min-width:0;flex-wrap:wrap;row-gap:4px}
/* flex-basis 给小一点：auto 会按内容撑到最大再换行，结果是「左边一组 + 中间一组」
   明明放得下却各占一行（1280 下顶栏被撑成三行）。给个 380 的基准让它先挤进来，
   剩下的空间它再 grow 掉。 */
.gzs-headgroup--mid{flex:1 1 380px;min-width:0;gap:8px}
.gzs-headgroup--mid .gzs-title{flex:0 0 auto}
.gzs-headgroup--mid .gzs-select{flex:0 1 220px;min-width:120px}
.gzs-headgroup__ctx{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:30ch}
/* 窄窗口下别让「当前：…」占着地方把按钮挤到第三行：视口越窄，它越短 */
@media (max-width:1400px){.gzs-headgroup__ctx{max-width:16ch}}
@media (max-width:1320px){.gzs-headgroup__ctx{display:none}}
/* 630 左右的窄面板里，顶栏那三组每行只能放一组：先把「重复信息」摘掉——
   面板标题在侧栏已经写了一次、实时状态在窄屏退成一个点。 */
@media (max-width:1320px){.gzs-head .gzs-title{display:none}.gzs-live{font-size:0;padding:2px 5px}.gzs-live:before{content:"●";font-size:9px}}
@media (max-width:1200px){.gzs-headgroup__ctx{max-width:10ch}}
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
/* 导出收成 meta 行右端的一颗菜单：它是文章级动作，不该占着手机预览头顶那一行 */
.gzs-export{position:relative;flex:0 0 auto}
.gzs-export>summary{list-style:none;cursor:pointer}
.gzs-export>summary::-webkit-details-marker{display:none}
.gzs-export[open]>summary{border-color:var(--gzs-cyan);color:var(--gzs-teal)}
.gzs-export__menu{position:absolute;right:0;top:calc(100% + 6px);z-index:40;min-width:172px;
  display:flex;flex-direction:column;align-items:stretch;gap:4px;padding:8px;background:var(--gzs-card);
  border:1px solid var(--gzs-line);border-radius:10px;box-shadow:0 12px 30px rgba(23,54,42,.16)}
.gzs-export__menu .gzs-btn{justify-content:flex-start}
.gzs-export__menu .gzs-hint{font-size:10.5px;padding:2px 4px}
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
/* ── 窄面板：分段（结构 / 成稿 / 检查器），不横向滚 ────────────────────────
   1280 窗口打开左栏对话后工作区只有 629px，三栏最低要 891。原来靠 overflow-x 兜底，
   滚动条一被 --hide-scrollbars 之类藏掉，右侧那栏就等于消失。 */
.gzs-compact{display:flex;flex-direction:column;flex:1;min-height:0;min-width:0;overflow:hidden}
.gzs-panes{flex:0 0 auto;display:flex;gap:4px;padding:5px 10px;background:var(--gzs-card2);
  border-bottom:1px solid var(--gzs-line2)}
.gzs-panes__b{padding:3px 11px;border:1px solid transparent;border-radius:6px;background:transparent;
  font:inherit;font-size:11.5px;color:var(--gzs-muted);cursor:pointer}
.gzs-panes__b:hover{color:var(--gzs-ink)}
.gzs-panes__b.is-on{background:var(--gzs-card);border-color:var(--gzs-line);color:var(--gzs-teal);font-weight:600}
.gzs-panes__wrap{flex:1;min-height:0;min-width:0;display:flex;overflow:hidden}
.gzs-pane{display:none;flex:1 1 auto;min-width:0;min-height:0;flex-direction:column;overflow:hidden}
.gzs-pane.is-on{display:flex}
.gzs-pane--mid{background:var(--gzs-paper)}
.gzs-pane--right{background:var(--gzs-card);overflow-y:auto}
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
/* 「参数」跳过来时闪一下：窄面板里那一栏可能滚在视野外，没有这一下等于点了没反应 */
.gzs-col--flash{box-shadow:inset 0 0 0 2px var(--gzs-cyan);transition:box-shadow .18s ease-out}

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
.gzs-stagetitle{font-family:var(--gzs-serif);font-size:29px;line-height:1.25;margin:0;
  font-weight:600;color:var(--gzs-ink);letter-spacing:.01em}
.gzs-stage-sub{margin:6px 0 0;font-size:12.5px;line-height:1.6;color:var(--gzs-muted)}
.gzs-meta{display:flex;align-items:center;gap:16px;margin-top:12px;font-size:12px;color:var(--gzs-faint);flex-wrap:wrap}
.gzs-meta b{color:var(--gzs-body);font-weight:500}
.gzs-meta__tpl{white-space:nowrap}
/* 受众可能是整句，截断而不是撑开——撑开会把右边的视图切换挤到第二行 */
.gzs-meta__aud{display:inline-block;max-width:22ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}
.gzs-seg--view{margin-left:auto}
/* 正文列**居中限宽**：中栏再宽也不让一行字横穿 1200px。
   并排去掉之后，宽度换来的应该是留白，不是第二份正文。 */
/* 阅读列 700：15.5px 中文一行约 45 字，再宽眼睛要回头找行首。
   宽度换来的留白是「让眼睛休息」，不是把字铺满整屏。 */
.gzs-stagelay{max-width:700px;margin:0 auto}
.gzs-doc{margin-top:22px;max-width:none}
/* 手机那一列：一张纸 + 一行说明。说明在**纸外**——375 这种工程参数不该印进读者的画面 */
.gzs-phonepane{display:flex;flex-direction:column;align-items:center;min-width:0}
.gzs-phoneview{display:flex;flex-direction:column;align-items:center;margin-top:6px}
.gzs-doc p{font-size:15.5px;line-height:2;color:var(--gzs-body);margin:0 0 22px;letter-spacing:.01em}
.gzs-doc h3.gzs-doch{font-family:var(--gzs-serif);font-size:18px;font-weight:600;line-height:1.45;
  color:var(--gzs-ink);margin:36px 0 14px;padding-left:11px;border-left:3px solid var(--gzs-teal);cursor:pointer}
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
/* 「一页纸」而不是「一部手机」：这套 UI 是浅绿纸 + 细线 + 衬线标题，再压一块黑机身就成了贴纸。
   壳只负责圆角、一条细边和一档极淡的投影，视觉重心还给正文。 */
.gzs-phonewrap{width:${PHONE_WIDTH + 24}px;margin:18px auto 0;padding:12px;background:var(--gzs-card);
  border:1px solid var(--gzs-line);border-radius:14px;box-shadow:0 6px 18px rgba(23,54,42,.06);
  transition:box-shadow .16s,border-color .16s}
.gzs-phonewrap:hover{box-shadow:0 10px 26px rgba(23,54,42,.1);border-color:var(--gzs-line)}
/* 窄窗：375 的真机宽度塞不进中栏时，整块**等比缩小**——不横向裁切、也不用横向滚动条。
   用 zoom 而不是 transform：zoom 会参与布局，后面的内容不会压上来。 */
/* 窄面板才缩「手机预览」：列宽钉死的情况下再叠一层 zoom 就等于缩两次，
   画面会比标注的 375 小一截。 */
@media (max-width:1300px){
  .gzs-phoneview .gzs-phonewrap{zoom:.78}
}
@media (max-width:1150px){
  .gzs-phoneview .gzs-phonewrap{zoom:.66}
}
.gzs-layout{margin-top:18px;max-width:660px}
.gzs-layoutcard{border:1px solid var(--gzs-line);border-radius:10px;background:var(--gzs-card);padding:18px 20px}
.gzs-layouthd{font-family:var(--gzs-serif);font-size:15px;font-weight:600;color:var(--gzs-ink);margin:0 0 6px}
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
/* 屏是纸的一部分：圆角小、无边框、无投影。它不该长得像一台独立的设备。
   （原来屏内那行「375px · 微信正文预览」已经删掉：那是工程参数，
   印在读者画面里等于给读者看我们的调试信息。说明改到纸外做 caption。） */
.gzs-phone{width:${PHONE_WIDTH}px;flex:0 0 auto;margin:0 auto;background:#fff;overflow:hidden;border-radius:6px}
.gzs-phonecap{margin-top:10px;font-size:10.5px;letter-spacing:.08em;color:var(--gzs-faint)}
/* 空稿：给「读者会看到什么」的形状，而不是一张纯白 */
.gzs-pskel{margin-top:16px}
.gzs-pskel i{display:block;height:10px;border-radius:4px;background:var(--gzs-line2);margin:0 0 10px}
.gzs-pskel i:nth-child(1){width:100%}
.gzs-pskel i:nth-child(2){width:92%}
.gzs-pskel i:nth-child(3){width:64%}
.gzs-pskel__note{margin-top:16px;font-size:11px;line-height:1.6;color:var(--gzs-faint);text-align:center}
.gzs-paper{padding:${PHONE_PAD}px;font-size:15px;line-height:1.85;color:#2d2d2d}
/* 预览即编辑：正文块可点（点一下右栏就选中这段），图片悬停出「重出 / 换版」。
   这两件事以前要去右栏或「图」tab 里做，是每天最多余的两次切换。 */
.gzs-psec{cursor:pointer;border-radius:6px;transition:background .12s,box-shadow .12s;padding:2px 4px;margin:0 -4px}
.gzs-psec:hover{background:#4a91690f;box-shadow:0 0 0 1px #4a91692e}
.gzs-psec--on{background:#4a916914;box-shadow:inset 3px 0 0 var(--gzs-teal)}
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

/* ── 右栏检查器：页签（本段 / 图 / 证据 / 元信息）──────────────────────── */
.gzs-insp{display:flex;flex-direction:column;min-height:0}
.gzs-insphead{display:flex;align-items:center;gap:8px;padding:12px 14px 9px;margin:0;
  font-family:var(--gzs-serif);font-size:13.5px;font-weight:700;color:var(--gzs-ink)}

/* 「当前工作上下文」：抄历史工作台右栏顶上那块。用户 2026-11-09 的原话是
   「新媒体工作台的右侧，你参考历史工作台的样子改进下」——他要的是**一眼看清
   这篇在哪条线、第几段、卡在哪**，而不是先读到一串卡片。 */
.gzs-ctx{margin:0 14px 10px;padding:10px 12px;border:1px solid var(--gzs-line);border-radius:10px;
  background:var(--gzs-tint2)}
.gzs-ctx__hd{display:flex;align-items:center;gap:7px;margin:0 0 6px;
  font-family:var(--gzs-serif);font-size:12.5px;font-weight:700;color:var(--gzs-ink)}
.gzs-ctx__grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px 14px;
  font-size:11.5px;line-height:1.65;color:var(--gzs-muted)}
.gzs-ctx__grid b{color:var(--gzs-body);font-weight:600}
.gzs-ctx__note{margin-top:7px;font-size:11px;line-height:1.6;color:var(--gzs-faint)}

/* 页签上的计数：0 不显示（历史工作台也是这个口径——「事件 0」占着一格只是噪音） */
.gzs-itab__n{margin-left:5px;font-size:10.5px;color:var(--gzs-faint);font-variant-numeric:tabular-nums}
.gzs-itab--on .gzs-itab__n{color:var(--gzs-teal)}

.gzs-itabs{display:flex;gap:2px;padding:0 12px;border-bottom:1px solid var(--gzs-line);
  background:var(--gzs-card);flex:0 0 auto}
.gzs-itab{border:0;border-bottom:2px solid transparent;background:transparent;font:inherit;font-size:12.5px;
  color:var(--gzs-muted);padding:7px 10px 8px;cursor:pointer;white-space:nowrap}
.gzs-itab:hover{color:var(--gzs-teal)}
.gzs-itab--on{color:var(--gzs-teal);border-bottom-color:var(--gzs-teal);font-weight:600}
.gzs-itabpanel{padding:12px 14px 34px}
.gzs-itabpanel[hidden]{display:none!important}

/* 本段页：小标题 + 三个规格行 + 「本段原文」引文块。
   引文块刻意和正文预览区分开（左侧竖线 + 浅底），一眼看出那是「原文照抄」，
   而不是又一个可编辑的正文框。 */
.gzs-sech{font-family:var(--gzs-serif);font-size:14.5px;font-weight:650;line-height:1.42;
  color:var(--gzs-ink);margin:0 0 9px;letter-spacing:.2px}
.gzs-kv{display:grid;grid-template-columns:76px minmax(0,1fr);gap:6px 10px;font-size:12.5px;margin:0}
.gzs-kv dt{color:var(--gzs-faint)}
.gzs-kv dd{margin:0;color:var(--gzs-body);word-break:break-word}
.gzs-quote{margin:0;padding:9px 11px;border-radius:9px;background:var(--gzs-tint2);
  border-left:2px solid var(--gzs-teal);font-size:12.5px;line-height:1.78;color:var(--gzs-body);
  white-space:pre-wrap;word-break:break-word;max-height:340px;overflow:auto}
.gzs-quote--empty{color:var(--gzs-faint);font-style:italic;border-left-color:var(--gzs-line)}
/* 整篇页里的「各段小标题」清单：只是索引，不可点（点了也不会跳，别给假按钮） */
.gzs-outline{margin:0;padding-left:18px;font-size:12.5px;line-height:1.85;color:var(--gzs-body)}
.gzs-outline li{margin:0 0 1px}

/* ── 右栏「图」页签：看图，不出图 ─────────────────────────────────────────
   口径照历史工作台：缩略图 → 大图 → 规格行。出图控件在「元信息」，
   这样「图」这一页永远是「现在长什么样」，不会被按钮和输入项搅成生成台。 */
.gzs-galleryhead{display:flex;align-items:center;gap:8px;margin:0 0 8px;
  font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--gzs-muted)}
.gzs-gallery{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin:0 0 12px}
.gzs-gallery__slot{position:relative;padding:0;border:1px solid var(--gzs-line);border-radius:7px;
  overflow:hidden;background:var(--gzs-paper2);cursor:pointer;display:block;aspect-ratio:16/10}
.gzs-gallery__slot--on{border-color:var(--gzs-teal);box-shadow:0 0 0 2px var(--gzs-tint)}
.gzs-gallery__slot img{width:100%;height:100%;object-fit:cover;display:block}
.gzs-gallery__gap{display:flex;align-items:center;justify-content:center;height:100%;
  font-size:10.5px;color:var(--gzs-faint)}
.gzs-gallery__cap{position:absolute;left:0;right:0;bottom:0;padding:1px 5px;font-size:9.5px;
  color:#fff;background:linear-gradient(to top,rgba(18,32,24,.72),rgba(18,32,24,0));text-align:left}
.gzs-bigpic{border:1px solid var(--gzs-line);border-radius:10px;overflow:hidden;background:var(--gzs-paper2)}
.gzs-bigpic img{width:100%;display:block}
/* 规格行：左列标签、右列值 */
.gzs-lines2{display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 10px;
  font-size:11.5px;line-height:1.65;margin:0}
.gzs-lines2 span:nth-child(odd){color:var(--gzs-faint);white-space:nowrap}
.gzs-lines2 span:nth-child(even){color:var(--gzs-body);word-break:break-word}

/* 折叠区（出图控件收在这里，默认收起）：看图页打开来只有图 */
.gzs-collapse{margin-top:14px;border-top:1px solid var(--gzs-line2);padding-top:10px}
.gzs-collapse__hd{display:flex;align-items:center;gap:6px;width:100%;padding:4px 0;border:0;
  background:transparent;font:inherit;font-size:11.5px;color:var(--gzs-muted);cursor:pointer;
  text-align:left}
.gzs-collapse__hd:hover{color:var(--gzs-teal)}
.gzs-collapse__hd--on{color:var(--gzs-teal);font-weight:600}
.gzs-collapse__mark{font-size:9px;width:10px}
.gzs-collapse__body{padding:8px 0 0}
/* 页签下方的固定动作（删这一篇 / 删这一段）：不属于任何一页，所以压在页签外 */
.gzs-inspfoot{padding:10px 14px 16px;border-top:1px solid var(--gzs-line2)}
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
/* 宽屏（≥1500）把卡片摊成多列：一行一张卡在 1600 宽的面板里是「一张卡横着一条」，
   右边半屏空着。不是卡片太大，是没吃下多出来的宽度。 */
@media (min-width:1500px){
  .gzs-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:10px;align-items:start}
}
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

/* ── 「步骤」抽屉：做一篇稿 / 一条视频要过的步子 ────────────────────────────
   以前「≡ 步骤」只是把中间那根左栏收起又展开，而首页（没有左栏）里点了**什么都不会发生**——
   用户的原话是「我点步骤，步骤没有显示出来」。步骤是内容怎么从零到发的过程，
   跟「哪一栏开着」是两件事，所以它现在是一个能随时打开的抽屉。 */
.gzs-stepsb{display:flex;flex-direction:column;gap:14px}
.gzs-stepsb__line{border:1px solid var(--gzs-line);border-radius:10px;background:var(--gzs-card);padding:12px 14px 8px}
.gzs-stepsb__head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:4px}
.gzs-stepsb__t{font-family:var(--gzs-serif);font-size:14px;font-weight:700;color:var(--gzs-ink)}
.gzs-stepsb__meta{font-size:10.5px;color:var(--gzs-faint)}
.gzs-stepsb__p{margin:0 0 8px;font-size:11.5px;line-height:1.7;color:var(--gzs-muted)}
.gzs-stepsb__row{display:grid;grid-template-columns:26px minmax(0,1fr) auto;gap:9px;align-items:baseline;
  padding:6px 2px;border-top:1px solid var(--gzs-line2)}
.gzs-stepsb__row:first-of-type{border-top:0}
/* 可点的步骤行：诊断和处方放在同一行，点一下就去办 */
.gzs-stepsb__row--act{width:100%;border:0;border-top:1px solid var(--gzs-line2);background:transparent;
  font:inherit;color:inherit;text-align:left;cursor:pointer;border-radius:0}
.gzs-stepsb__row--act:first-of-type{border-top:0}
.gzs-stepsb__row--act:hover{background:var(--gzs-tint2)}
.gzs-stepsb__row--act:hover .gzs-stepsb__name{color:var(--gzs-teal)}
.gzs-stepsb__no{font-family:var(--gzs-mono,ui-monospace);font-size:10.5px;color:var(--gzs-faint);
  font-variant-numeric:tabular-nums}
.gzs-stepsb__name{font-size:12px;color:var(--gzs-ink);font-weight:600;min-width:0}
.gzs-stepsb__note{display:block;font-size:10.5px;line-height:1.6;color:var(--gzs-muted);font-weight:400;margin-top:1px}
.gzs-stepsb__v{font-size:11px;color:var(--gzs-muted);white-space:nowrap;text-align:right}
.gzs-stepsb__v--ok{color:var(--gzs-ok);font-weight:650}
.gzs-stepsb__v--doing{color:var(--gzs-warn)}
.gzs-stepsb__v--miss{color:var(--gzs-err)}
.gzs-stepsb__acts{display:flex;gap:7px;flex-wrap:wrap;margin-top:9px}
.gzssplit{height:1px;background:var(--gzs-line2);margin:0}

/* ── 角色条：哪边说话、哪边看板 ─────────────────────────────────────────────
   对话收起之后，面板看起来像一个「点了没反应的编辑器」：输入框没了，
   按钮全是只读的。这条把它说清楚，并给一键把对话打开的出口。 */
.gzs-rolebar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:0 0 auto;
  padding:7px 14px;border-bottom:1px solid var(--gzs-line2);background:var(--gzs-tint2);
  font-size:11px;line-height:1.5;color:var(--gzs-muted)}
.gzs-rolebar b{color:var(--gzs-teal);font-weight:700}
.gzs-rolebar .gzs-spacer{flex:1}

/* ── 弹窗（检查等一次性确认）──────────────────────────────────────────────── */
.gzs-modal{position:absolute;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;
  padding:26px;background:#17362a33;animation:gzs-fade .14s ease-out}

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

.gzs-push__field{display:block;margin:0 0 10px}
.gzs-push__k{display:block;font-size:10.5px;font-weight:600;letter-spacing:.06em;color:var(--gzs-muted);margin:0 0 4px}

/* ── 顶栏内容线切换（公众号 / 视频号）────────────────────────────────────── */
.gzs-chan{display:inline-flex;gap:1px;padding:2px;border:1px solid var(--gzs-line);
  border-radius:7px;background:var(--gzs-paper2)}
.gzs-chan__b{border:0;background:transparent;font:inherit;font-size:11.5px;color:var(--gzs-muted);
  padding:3px 10px;border-radius:5px;cursor:pointer;transition:background .14s,color .14s}
.gzs-chan__b:hover{color:var(--gzs-ink)}
.gzs-chan__b--on{background:var(--gzs-card);color:var(--gzs-teal);font-weight:600;
  box-shadow:0 1px 2px #17362a14}
/* 未接真源仓库的小圆点：视频号那栏**常驻**了，所以「有没有接上」得有个记号，
   否则点进去才发现是空的——那正是上一版把它藏起来想避免的事。 */
.gzs-chan__dot{display:inline-block;width:5px;height:5px;border-radius:50%;margin-left:4px;
  vertical-align:middle;background:var(--gzs-warn);opacity:.85}

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
  flex-wrap:wrap;row-gap:4px;border-bottom:1px solid var(--gzs-line2);background:var(--gzs-card2)}
/* 工作区选择器：内嵌对话的 cwd 必须落在宿主认得的某个工作区上。
   落在别处时输入框只会写「选择一个工作区开始」——那是死路，点哪都没有输入框。 */
.gzs-chatws{flex:0 0 auto;max-width:160px;padding:2px 4px;border:1px solid var(--gzs-line);border-radius:5px;
  background:var(--gzs-card);color:var(--gzs-body);font:inherit;font-size:10px;cursor:pointer}
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

/* ── 批量出图的进度条 ─────────────────────────────────────────────────────── */
.gzs-batchbar{flex:0 0 auto;display:flex;align-items:center;gap:9px;flex-wrap:wrap;
  padding:6px 14px;border-bottom:1px solid var(--gzs-line2);background:var(--gzs-tint2);font-size:11px;color:var(--gzs-body)}
.gzs-batchbar__k{font-weight:700;color:var(--gzs-teal)}
.gzs-batchbar__v{font-variant-numeric:tabular-nums;color:var(--gzs-muted)}
.gzs-batchbar__bar{flex:1 1 140px;height:5px;border-radius:3px;background:var(--gzs-line2);overflow:hidden;min-width:90px}
.gzs-batchbar__bar i{display:block;height:100%;background:var(--gzs-teal);transition:width .25s ease-out}

/* ── 右栏：只读看板的一行 ──────────────────────────────────────────────────
   口径（2026-11-07 用户明确）：**右栏是看板，只看**。改标题、改正文、调 prompt
   都在左栏对话里做。所以右栏里不该出现能打字的东西——出现一次，口径就塌了。 */
.gzs-inspnote{margin:0 0 10px;padding:8px 10px;border-radius:8px;background:var(--gzs-tint2);
  border:1px dashed var(--gzs-ok-line);font-size:10.5px;line-height:1.6;color:var(--gzs-muted)}
.gzs-ro{margin:0 0 9px}
.gzs-ro__k{display:flex;align-items:center;gap:6px;font-size:10px;font-weight:700;letter-spacing:.06em;
  color:var(--gzs-faint);text-transform:uppercase;margin-bottom:3px}
.gzs-ro__k .gzs-btn{margin-left:auto;padding:1px 6px;font-size:10px}
.gzs-ro__v{font-size:12px;line-height:1.7;color:var(--gzs-body);white-space:pre-wrap;word-break:break-word}
.gzs-ro__v--empty{color:var(--gzs-faint);font-style:italic}
.gzs-ro__v--box{max-height:190px;overflow:auto;padding:6px 8px;border:1px solid var(--gzs-line2);
  border-radius:6px;background:var(--gzs-card2)}

/* ── 主区容器（工作台在里面；对话列由工作台自己排）────────────────────────── */
/* ⚠ 宽度要**吃满**宿主给的这一栏。
   .gzs-main__body 是 flex 行容器，.gzs-root 作为它的子项 flex-basis 是 auto：
   宽度只按内容的 max-content 算，也不会 grow。窄窗口看不出来（放不下就被压回来），
   但 2560 这种宽屏下右边会空出七八百像素——用户的原话是「右侧什么都没有，很浪费」。
   那不是配色问题，是面板根本没占满。三处一起给：main 宽、body 允许收缩、root 长。 */
.gzs-main{display:flex;flex-direction:column;height:100%;min-height:0;width:100%;min-width:0;flex:1 1 auto}
.gzs-main__body{flex:1;min-height:0;min-width:0;display:flex}
.gzs-main__body>.gzs-root{flex:1 1 auto;min-width:0;max-width:none}

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

/* 「视频目录未配置」的两条路：有素材（指目录）/ 没素材（建目录）。
   做成有序列表而不是一段大段落：用户要挑一条走，不是读一篇说明。 */
.gzs-vhint-strong{font-size:12px;color:var(--gzs-ink);margin:10px 0 6px}
.gzs-setup{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.gzs-setup li{border:1px solid var(--gzs-line);border-radius:8px;padding:10px 12px;background:var(--gzs-card)}
.gzs-setup__t{font-size:12px;font-weight:650;color:var(--gzs-ink)}
.gzs-setup__d{font-size:11.5px;line-height:1.7;color:var(--gzs-muted);margin-top:3px}
.gzs-setup__pick{margin-top:8px;display:flex;flex-direction:column;gap:6px}
.gzs-setup__msg{font-size:11.5px;line-height:1.7;margin-top:10px;padding:7px 10px;border-radius:6px}
.gzs-setup__msg--ok{color:var(--gzs-ink);background:var(--gzs-okbg, rgba(31,160,120,0.10));border:1px solid rgba(31,160,120,0.35)}
.gzs-setup__msg--error{color:var(--gzs-ink);background:rgba(214,69,69,0.10);border:1px solid rgba(214,69,69,0.38)}
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

/* ── 首屏（空库）：不教配置，只给一句话和一个入口 ─────────────────────────── */
.gzs-welcome{margin:14px 0 0;padding:18px 20px 16px;border:1px solid var(--gzs-ok-line);border-radius:12px;
  background:linear-gradient(180deg,var(--gzs-card) 0%,var(--gzs-card2) 100%)}
.gzs-welcome__lead{font-family:var(--gzs-serif);font-size:16px;font-weight:700;color:var(--gzs-ink);letter-spacing:.2px}
.gzs-welcome__sub{font-size:11.5px;line-height:1.75;color:var(--gzs-muted);margin-top:5px;max-width:52em}
.gzs-welcome__seed{display:flex;gap:8px;align-items:stretch;margin-top:12px}
.gzs-welcome__seed .gzs-area{flex:1;min-width:0}
.gzs-welcome__chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}
.gzs-welcome__alt{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:14px;
  padding-top:12px;border-top:1px dashed var(--gzs-line2)}
.gzs-welcome__more{margin-top:10px}
.gzs-welcome__rows{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px}
/* ① 左栏说 ② 右栏看 ③ 接着说：分工写在最前面，比事后解释「为什么点不动」便宜得多 */
.gzs-welcome__flow{display:flex;flex-wrap:wrap;gap:8px;margin-top:11px}
.gzs-welcome__flow span{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;
  border:1px solid var(--gzs-ok-line);background:var(--gzs-tint2);font-size:11px;line-height:1.5;color:var(--gzs-muted)}
.gzs-welcome__flow b{color:var(--gzs-teal);font-weight:700}
.gzs-welcome__alert{display:flex;flex-direction:column;gap:3px;margin-top:11px;padding:9px 12px;
  border:1px solid var(--gzs-warn-line);border-radius:9px;background:var(--gzs-warn-soft);
  font-size:11.5px;line-height:1.65;color:var(--gzs-body)}
.gzs-welcome__alert b{color:var(--gzs-warn);font-size:12px}

/* ── 内置示例稿：只读整屏 ──────────────────────────────────────────────────── */
.gzs-example{display:flex;flex-direction:column;gap:12px;min-height:0;height:100%}
.gzs-example__head{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:10px 12px;
  border:1px solid var(--gzs-ok-line);border-radius:10px;background:var(--gzs-tint)}
.gzs-example__badge{flex:0 0 auto;font-size:11px;font-weight:650;color:var(--gzs-teal);
  border:1px solid var(--gzs-ok-line);border-radius:999px;padding:1px 8px;background:var(--gzs-card)}
.gzs-example__body{display:flex;gap:18px;align-items:flex-start;min-height:0;overflow:auto}
.gzs-example__phone{flex:0 0 auto}
.gzs-example__side{flex:1;min-width:0;display:flex;flex-direction:column;gap:10px}
.gzs-example__block{border:1px solid var(--gzs-line2);border-radius:10px;padding:10px 12px;background:var(--gzs-card)}
.gzs-example__k{font-size:11.5px;font-weight:650;color:var(--gzs-ink);margin-bottom:6px}
.gzs-example__row{display:flex;gap:8px;align-items:flex-start;font-size:11.5px;line-height:1.65;
  color:var(--gzs-muted);padding:3px 0}
.gzs-example__t{flex:0 0 auto;font-variant-numeric:tabular-nums;opacity:.75}

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
      ready: { text: "可导出", level: "ok" },
      "needs-published-inventory": { text: "缺人物清单", level: "warn" },
      "needs-research": { text: "缺证据台账", level: "err" },
      "needs-browser-audit": { text: "待重新核验", level: "warn" },
      "needs-user-approval": { text: "待你确认", level: "warn" },
      "needs-video-cover": { text: "缺合规封面", level: "warn" },
      "needs-draft-approval": { text: "待排版留痕", level: "warn" },
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
      pipeline: pipe, busy, onRefresh, hasBody, onOpenObs,
      // 未绑定时的粗略进度用这几样：标题、有没有封面、还缺几张配图、导出过没有
      articleTitle, hasCover, imageGaps, roughProgress,
    }) {

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
            `完成 ${doneCount}/${steps.length} 档。这是按稿件估的——这篇没挂到期号上，所以门禁判不出「卡在哪一道门」。`),
          // 「接上产线」那张表（期号 + 绝对路径）2026-11-08 删掉：
          // 它要用户填两个只有自己知道的字符串，而「期号 / 产线 / 真源仓库」对外人就是黑话。
          // 挂期号改由 Agent 在对话里做（它知道仓库在哪）；面板只负责说清「现在这个是估的」。
          h("div", { className: "gzs-hint", style: { marginTop: 2 } },
            "要精确的门禁结论，在左栏说一句「这篇挂到第 N 期」让 Agent 去绑。"));
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
      /**
       * 外部刷新**不许**盖掉正在打的字。
       *
       * SSE 每隔几秒就推一次全量状态，`value` 因此会变；但用户可能正在这个框里写第 3 段，
       * 每推一次就 `setDraft(value)` 等于把敲到一半的字按回上一次落盘的版本——
       * 人只会看到光标跳回开头、刚打的字没了，还以为自己按错了键。
       * 所以「聚焦中」或「本地改过还没提交」时跳过同步；失焦/提交后解除，外部值才能再进来。
       * 用 ref 不用 state：这两个标记只决定要不要同步，改它们不该触发重渲染。
       */
      const focused = React.useRef(false);
      const dirty = React.useRef(false);
      React.useEffect(() => {
        if (focused.current || dirty.current) return;
        setDraft(value ?? "");
      }, [value]);
      const commit = () => {
        // 先清标记再提交：提交成功后外部值就是刚写下去的那份，下次刷新同步回来正好一致
        dirty.current = false;
        if ((draft ?? "") !== (value ?? "")) onCommit(draft);
      };
      const type = (next) => { dirty.current = true; setDraft(next); };
      const onFocus = () => { focused.current = true; };
      const onBlur = () => { focused.current = false; commit(); };
      // `mark` 落到 data 属性上，给「按语义取某个输入框」用（见 promptOnScreen）。
      // 按位置取（第一个 textarea）会取错——正文框排在 prompt 框前面。
      const attrs = mark ? { "data-mark": mark } : {};
      if (rows) {
        return h("textarea", {
          className: "gzs-area", rows, value: draft, placeholder: placeholder ?? "",
          onChange: (e) => type(e.target.value), onFocus, onBlur, ...attrs,
        });
      }
      return h("input", {
        className: "gzs-input", value: draft, placeholder: placeholder ?? "",
        onChange: (e) => type(e.target.value), onFocus, onBlur,
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
          // 除数是**真机宽度本身**：以前除的是 375+4，于是容器正好 375 时算出 0.989，
          // 每次进来都无声地缩 1%，而条上还写着「375px」。等于宽度时就不该缩。
          const next = Math.min(1, Math.max(0.62, Number((width / PHONE_WIDTH).toFixed(3))));
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

      

      // 选中哪一段，预览就滚到哪一段：看的是「这一段在手机上什么位置」。
      React.useEffect(() => {
        if (!selected) return;
        const node = boxRef.current?.querySelector?.(`[data-slot="${selected}"]`);
        try { node?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }); } catch { /* 不支持就算了，不挡事 */ }
      }, [selected]);

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

      // 空稿：给「读者会看到什么」的形状。纯白卡片既没有信息也没有引导，
      // 视觉重心落在最没内容的地方。占位条 + 一句话，比空白诚实。
      if (!visibleSections.length && !coverVersion && !String(article.summary ?? "").trim()) {
        blocks.push(h("div", { key: "skel", className: "gzs-pskel" },
          h("i"), h("i"), h("i")));
        blocks.push(h("div", { key: "skelnote", className: "gzs-pskel__note" },
          "写完第一段，这里就是读者看到的样子"));
      }

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
          "data-slot": slot,
          style: ring(slot) ?? null,
          title: "点一下：右栏切到这一段",
          onClick: pick(slot),
        }, inner));
        if (position < visibleSections.length - 1) {
          blocks.push(h("div", { key: `rule-${section.id}`, style: { height: 1, background: t.rule ?? "#eee", margin: "20px 0" } }));
        }
      });

      return h("div", { className: "gzs-phonebox", ref: boxRef },
        h("div", { className: "gzs-phone", style: zoom === 1 ? null : { zoom } },
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
      set(9, life === "published"
        ? { state: "ok", verdict: "已发布", detail: "生命周期是人工标的" }
        : { state: "todo", verdict: "未开始", detail: "还没有发布记录" });
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
    function StepRail({ view, article, selected, onSelect, onAddSection, busy }) {
      const [structureOpen, setStructureOpen] = React.useState(true);

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
          // 未绑期号就只说清「这是估的」。原来这里还有一颗「接上产线」——它后面是
          // 一张要人填期号与绝对路径的表，2026-11-08 删了（挂期号改由 Agent 在对话里做）。
          : h("div", { className: "gzs-railnote" },
            h("span", {
              className: "gzs-railnote__text",
              title: "推算依据：标题/受众/正文/配图/提案/账本/审阅清单，不是盘上门禁的结论",
            }, headNote)),

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

    /**
     * 「步骤」抽屉：这个工作台到底按什么顺序把一件内容做出来。
     *
     * 以前「≡ 步骤」只是左栏的开关。问题是那个左栏只在**单篇视图**里存在：
     * 首页（以及空库首屏）上点它什么都不会发生——用户的原话是「我点步骤，
     * 步骤没有显示出来」。步骤回答的是「从零到发布要过哪几关、我卡在哪」，
     * 跟「哪一栏开着」是两件事，所以它现在是一个随时能打开的抽屉。
     *
     * 两条线分开列，判据不混：
     * - 公众号：11 步。绑了期号就是盘上门禁的结论，没绑就按稿件推断（标题/正文/
     *   配图/提案/账本/审阅清单），推出来的那句「按稿件推断」照实写在标题下面；
     * - 视频号：8 步，判据是盘上有没有那件文件（大纲/口播稿/分镜/配音/分段/字幕/
     *   封面/成片）。某一期具体缺哪几步，去视频号看板点开那一期看。
     *
     * 抽屉里**不放生成动作**：写稿、出图、配音都在对话里做，面板只报进度。
     *
     * 但「只报进度」不等于每行只能看（0.3.1 冒烟后改）：有落点的行点了直接跳过去
     * （`onStep`），没有落点的行（证据台账这类）点了会把一句带定位的话**填进左栏对话**，
     * 人只要按回车。诊断和处方放在同一行，比「先看诊断、再自己组织语言去问」少两步。
     */
    function StepsBoard({ view, article, videoConfigured = false, onJump, onCreate, onGoChat, onGoVideo, onStep }) {
      const steps = inferSteps(view);
      const rows = Array.isArray(steps.rows) ? steps.rows : [];
      const bound = Boolean(steps.bound);
      const done = Number(steps.done) || 0;
      const total = Number(steps.total) || rows.length || 0;

      const articleLine = h("div", { className: "gzs-stepsb__line" },
        h("div", { className: "gzs-stepsb__head" },
          h("span", { className: "gzs-stepsb__t" }, "公众号 · 一篇稿"),
          h("span", { className: "gzs-stepsb__meta" },
            bound
              ? `门禁结论 · ${done}/${total} 已过`
              : (article?.id ? `按稿件推断 · ${done}/${total} 步有据` : "还没有稿")),
          h("div", { className: "gzs-spacer" }),
          onJump && article?.id
            ? h(Btn, { small: true, kind: "ghost", on: onJump }, "打开这篇")
            : null,
          onGoChat
            ? h(Btn, { small: true, kind: "ghost", on: onGoChat }, "去对话说一句")
            : null),
        h("p", { className: "gzs-stepsb__p" },
          "从建稿到能发，一共过这几关。面板只显示走到哪一步；改稿、出图、改排版都在左侧对话里说。"),
        rows.map((row) => {
          const act = typeof onStep === "function";
          const Row = act ? "button" : "div";
          return h(Row, {
            key: row.key,
            className: `gzs-stepsb__row${act ? " gzs-stepsb__row--act" : ""}`,
            title: act
              ? (row.target ? "打开这一步所在的稿/段落" : "把这一句带进左栏对话，让它先补这一步")
              : undefined,
            onClick: act ? () => onStep(row) : undefined,
          },
            h("span", { className: "gzs-stepsb__no" }, String(row.no).padStart(2, "0")),
            h("span", { className: "gzs-stepsb__name" }, row.label,
              row.detail ? h("span", { className: "gzs-stepsb__note" }, row.detail) : null),
            h("span", { className: `gzs-stepsb__v gzs-stepsb__v--${row.state}` }, row.verdict || STEP_WORD[row.state] || ""));
        }),
        !article?.id
          ? h("div", { className: "gzs-stepsb__acts" },
            onCreate ? h(Btn, { small: true, kind: "primary", on: onCreate }, "＋ 新建一篇") : null,
            h("span", { className: "gzs-hint" }, "还没有稿时，第 0 步以前都是「未开始」——先建一篇，或者在对话里说一句让它建。"))
          : null);

      const videoLine = h("div", { className: "gzs-stepsb__line" },
        h("div", { className: "gzs-stepsb__head" },
          h("span", { className: "gzs-stepsb__t" }, "视频号 · 一期片"),
          h("span", { className: "gzs-stepsb__meta" }, videoConfigured ? "读视频期目录" : "还没指定期目录"),
          h("div", { className: "gzs-spacer" }),
          onGoVideo ? h(Btn, { small: true, kind: "ghost", on: onGoVideo }, "看视频号看板") : null),
        h("p", { className: "gzs-stepsb__p" },
          videoConfigured
            ? "八步都在盘上有判据：有那件文件就算过。某一期具体缺哪几步，去视频号看板点开那一期。"
            : "期目录在「视频号」页里指定：有素材就指到已有目录，没有就让插件建一个。没指定之前这一栏只列步骤、不显示期。"),
        VIDEO_STEPS.map((step, index) => h("div", { key: step.key, className: "gzs-stepsb__row" },
          h("span", { className: "gzs-stepsb__no" }, String(index + 1).padStart(2, "0")),
          h("span", { className: "gzs-stepsb__name" }, step.label),
          h("span", { className: "gzs-stepsb__v" }, videoConfigured ? "按盘判" : "还没配目录"))));

      return h("div", { className: "gzs-stepsb" }, articleLine, videoLine);
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
        return h("div", { className: "gzs-empty" }, h("div", null, "这篇还是空的"), h("div", { className: "gzs-hint" }, "在左侧对话里说一句，让它先把标题和第一段写出来；右栏只读，要改哪一项就点那一行的「让 Agent 改」"));
      }
      return h("div", { className: "gzs-doc" }, blocks);
    }

    /**
     * 手机预览那一列：**工具条在壳外，壳只包屏幕**。
     *
     * 踩过（0.3.9 之前的「并排」）：这一列直接渲染 `ExportBar + PhonePreview`，
     * 手机壳（`.gzs-phonewrap`）只写在「手机预览」分支里，于是同一个预览在两种视图里
     * 长得不一样——并排时是一张浮在角落的白纸，手机预览时才是台手机。
     * 更糟的是列宽由工具条（三个按钮）决定：`.gzs-phonebox{width:100%}` 拿到 352，
     * JS 就按 `352/379` 把 375 的预览缩到 0.93，而条上还印着「375px」。
     *
     * 现在两种视图共用这一个组件：壳固定 397（375 + 两侧 11），列宽也跟着固定，
     * 工具条只能换行、不能反过来把手机挤小。
     */
    function PhonePane({ article, templates, selected, onSelect, onRegenerate, onPickVersion, busy }) {
      return h("div", { className: "gzs-phonepane" },
        h("div", { className: "gzs-phonewrap" },
          h(PhonePreview, { article, templates, selected, onSelect, busy, onRegenerate, onPickVersion })),
        // 说明放在纸**外**：纸里只该有读者会看到的东西
        h("div", { className: "gzs-phonecap" }, `阅读视图 · ${PHONE_WIDTH}`));
    }

    /**
     * 排版视图：**不另造一套排版**。
     *
     * 导出用的就是宿主那份渲染器（`/export?format=html|md|checklist`），这里只给入口和口径说明。
     * 原来的做法是把手机预览当排版看，但那看不出「粘到公众号后台会是什么样」。
     */
    /**
     * 导出菜单：HTML / Markdown / 图片清单。
     *
     * 以前这是三个按钮压在手机预览头顶（旁边还挂一句「还没有排版件」）。那是**文章级**动作，
     * 却占着预览的第一眼，还和「看手机上什么样」抢注意力。收成 meta 行右端一颗「导出 ▾」。
     */
    function ExportMenu({ article, onExport }) {
      if (!article) return null;
      const meta = article.layoutMeta && typeof article.layoutMeta === "object" ? article.layoutMeta : null;
      const close = (event) => { try { event?.currentTarget?.closest?.("details")?.removeAttribute?.("open"); } catch { /* 关不掉也不影响导出 */ } };
      const pick = (format) => (event) => { close(event); onExport?.(format); };
      return h("details", { className: "gzs-export" },
        h("summary", { className: "gzs-btn gzs-btn--sm", title: "导出这篇：HTML / Markdown / 图片清单" }, "导出 ▾"),
        h("div", { className: "gzs-export__menu" },
          h(Btn, { small: true, kind: "primary", on: pick("html") }, "HTML（粘公众号后台）"),
          h(Btn, { small: true, on: pick("md") }, "Markdown"),
          h(Btn, { small: true, on: pick("checklist") }, "图片清单"),
          meta
            ? h("span", { className: "gzs-hint" },
              `排版件 ${String(meta.sha256 ?? "").slice(0, 12)}${meta.generatedAt ? " · " + meta.generatedAt : ""}`)
            : h("span", { className: "gzs-hint" }, "还没有排版件")));
    }

    

    /** 「没选内容类型」的筛选哨兵：与宿主 `TRACK_NONE` 同值（空串是「不筛」，含义相反）。 */
    const TRACK_NONE = "__none";

    /**
     * 中栏：标题 + 一行元信息 + 视图切换（成稿 / 手机预览）。
     *
     * 手机预览**原样复用** `PhonePreview`（375 是真机宽度，不能被压窄），
     * 只是外面套一个 390px 的深色壳，让它看起来像一台手机而不是一张白纸。
     */
    function Stage({ article, templates, selected, onSelect, onExport, onRegenerate, onPickVersion, busy }) {
      /**
       * 两个视图，**一次只看一个**：成稿（读） / 手机预览（真机宽度）。
       *
       * 0.3.x 曾在中栏够宽时自动切成「并排」——左边成稿、右边手机。实测下来是错的：
       * 两栏渲染的是**同一篇文章的同一段字**，并排只是把同一份内容抄了两遍，
       * 读起来累，也没多给任何信息（用户原话：「两处显示正文，保留一个就可以了」）。
       * 排版要看手机上什么样，切成「手机预览」就够了，宽度换来的应该是**留白**，
       * 不是第二份正文。所以这里只留切换，正文只渲染一处，且整列居中限宽。
       */
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
        h("div", { className: "gzs-stagelay" },
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
            // 导出是文章级动作，放 meta 行；不放预览头顶
            h(ExportMenu, { article, onExport }),
            h("div", { className: "gzs-seg gzs-seg--view" },
              STAGE_MODES.map(([key, label]) => h("button", {
                key,
                className: `gzs-btn gzs-btn--sm ${mode === key ? "gzs-btn--on" : ""}`,
                "aria-pressed": mode === key ? "true" : "false",
                onClick: () => setMode(key),
              }, label)))),
          // 正文和标题必须在**同一个居中列**里：分成两个容器时，标题居中了、正文贴着左墙，
          // 右边空出一大片——用户截图里那一条就是这么来的。
          mode === "phone"
            ? h("div", { className: "gzs-phoneview" },
                h(PhonePane, { article, templates, selected, onSelect, onRegenerate, onPickVersion, busy }))
            : h(Manuscript, { article, selected, onSelect })));
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
     * 检查器的三个页签（2026-11-09 用户定稿）：
     *
     *   第 N 段（整篇 / 封面）   这段的字长什么样
     *   图 N                    现在有哪些图、多大、什么规格
     *   版式                     排版按哪套模板、字号行高多少、导出过没有
     *
     * **「证据」和「事件」两页已按用户要求删掉。** 它们的内容没丢：
     * 质量检查、十道门、账本都还在「检查」（治理）抽屉里——那里本来就是
     * 「这一篇有什么问题、刚才动过什么」的完整视图，右栏再放一份只是重复。
     * 右栏从此只回答「眼前这一段和它的图长什么样」。
     */
    const INSP_TABS = [
      ["section", "本段"],
      ["images", "图"],
      ["layout", "版式"],
    ];

    /**
     * 「当前工作上下文」卡：右栏顶上那块。
     *
     * 历史工作台右栏有这块（产线 / 期号 / 人物 / 当前节点 + 一句「现在等你做什么」），
     * 新媒体工作台原来没有——要判断「我在改哪一篇、卡在哪一步」得自己去别的页签里翻。
     * 这里补上等价物：赛道 / 期号 / 当前定位 / 当前卡点。
     *
     * `pending` 决定胶囊颜色与提示语：有必改项时不写「已完成」，
     * 那是历史工作台已经踩过的坑（红色风险配一个绿色「已完成」）。
     */
    function ContextCard(props) {
      const { article, track, selected, scopeLabel, slotLabel, qa, pipeline, waiting, proposed } = props;
      const errCount = qa?.counts?.error ?? 0;
      const warnCount = (qa?.counts?.warn ?? 0);
      const gateFail = (pipeline?.gates ?? []).filter((g) => g.state === "fail" || g.state === "blocked").length;
      const pendingList = waiting ?? [];
      const pending = errCount > 0 || gateFail > 0 || pendingList.length > 0;
      // 「当前卡点」：只说真正拦人的那一件，不把 warn 也算成卡点（warn 只提醒）
      const stuck = errCount > 0
        ? `${errCount} 个必改项`
        : gateFail > 0
          ? `${gateFail} 道门未过`
          : pendingList.length > 0
            ? `${pendingList.length} 份提案等你确认`
            : "";
      // 提示语按「卡点 → 提案 → 提醒 → 无事」排：先说拦人的，再说可选的。
      const bits = [];
      if (stuck) bits.push(`现在等你处理：${stuck}。`);
      if (pendingList.length && !stuck.includes("提案")) bits.push(`${pendingList.length} 份提案可看对照。`);
      if (warnCount) bits.push(`另有 ${warnCount} 条提醒。`);
      const episodeNo = pipeline?.episodeNo;
      return h("div", { className: "gzs-ctx" },
        h("div", { className: "gzs-ctx__hd" },
          "当前工作上下文",
          h(Badge, { level: pending ? "warn" : "ok" }, pending ? "需要关注" : "暂无必改")),
        h("div", { className: "gzs-ctx__grid" },
          h("span", null, "内容类型：", h("b", null, track?.name ?? "通用模式")),
          h("span", null, "期号：", h("b", null,
            episodeNo ? `第 ${String(episodeNo).padStart(3, "0")} 期` : "未绑期号")),
          h("span", null, "当前定位：", h("b", null,
            slotLabel ?? scopeLabel ?? (selected === "article" ? "整篇" : "—"))),
          h("span", null, "当前卡点：", h("b", null, stuck || "没有")),
        ),
        h("div", { className: "gzs-ctx__note" },
          bits.length ? bits.join("") : "当前没有拦人的问题，改字请走左侧对话。"),
      );
    }

    /**
     * 「本段」页：小标题 + 字数/段数/锚点 + 本段原文。
     *
     * 完全照历史工作台的 `WechatSectionPane` 的结构来：先一行「第 N 段」，
     * 再标题，再三行规格，最后一块引文。区别只有一个：新媒体工作台的一段是
     * 一个 JSON 段落（没有 md 行号），所以那一行换成「段内段落数」而不是行号——
     * 给一个假的「第 N 行」比不给更糟。
     */
    function SectionPane(props) {
      const { article, selected, onAsk, artLabel, track, templates, onGovernance } = props;
      if (selected === "cover") {
        return h("div", { className: "gzs-inspnote" },
          "封面在「图」页看（大图与版本），出图控件也在那一页的「出图」折叠区。这一页只给整篇与每一段的原文。");
      }
      const sections = article?.sections ?? [];
      const idx = selected === "article"
        ? -1
        : sections.findIndex((s) => `sec-${s.id}` === selected);
      if (idx < 0) {
        // 整篇：这一段原来叫「元信息」，历史工作台没有那一页——
        // 它本来就属于「这一篇是什么」，和「第 N 段」是同一个问题的两个粒度，所以并进来。
        const totalHan = sections.reduce((sum, s) => sum + countWords(s.body), 0);
        const life = String(article?.lifecycle || "") || "draft";
        return h(React.Fragment, null,
          h("div", { className: "gzs-label" }, "整篇"),
          h("div", { className: "gzs-sech" }, article?.title || "（还没有标题）"),
          h("dl", { className: "gzs-kv" },
            h("dt", null, "字数"), h("dd", null, `${totalHan} 字 / ${sections.length} 段`),
            h("dt", null, "副标题"), h("dd", null, article?.subtitle || "未填"),
            h("dt", null, "摘要"), h("dd", null, article?.summary || "还没有摘要"),
            h("dt", null, "讲给谁"), h("dd", null, article?.audience || "未填"),
            h("dt", null, "带走什么"), h("dd", null, article?.takeaway || "未填"),
            h("dt", null, "标签"), h("dd", null, (article?.tags ?? []).join("，") || "未填"),
            h("dt", null, "内容类型"), h("dd", null, track?.name ?? "通用模式"),
            h("dt", null, "排版模板"), h("dd", null, templateName(templates, article?.template)),
            h("dt", null, "到哪了"), h("dd", null,
              `${life === "published" ? "已发布" : "草稿"}${article?.lifecycleAt
                ? ` · 你标的 ${timeText(article.lifecycleAt)}`
                : " · 没标过，默认算草稿"}`),
          ),
          h("div", { className: "gzs-row", style: { margin: "8px 0 4px", gap: 6, flexWrap: "wrap" } },
            h(Btn, { small: true, kind: "ghost", on: () => onGovernance?.() }, "打开「检查」标状态"),
            h(Btn, {
              small: true, kind: "ghost",
              title: "把一句话填进左栏对话（只填不发）",
              on: () => onAsk?.(`【新媒体工作台】${artLabel} · 改标题/摘要等元信息：现在标题是「${article?.title || "（空）"}」，我想改成 `),
            }, "让 Agent 改元信息")),
          h("div", { className: "gzs-label", style: { marginTop: 12 } }, "各段小标题"),
          h("ol", { className: "gzs-outline" },
            sections.map((s) => h("li", { key: s.id }, s.heading || "（无小标题）"))),
        );
      }
      const section = sections[idx];
      const paras = paragraphsOf(section.body);
      return h(React.Fragment, null,
        h("div", { className: "gzs-label" }, `第 ${idx + 1} 段`),
        h("div", { className: "gzs-sech" }, section.heading || "（无小标题）"),
        h("dl", { className: "gzs-kv" },
          h("dt", null, "字数"), h("dd", null, `${countWords(section.body)} 字 / ${paras.length} 段`),
          h("dt", null, "配图"), h("dd", null, section.image?.versions?.length
            ? `${section.image.versions.length} 个版本`
            : "还没有图"),
          h("dt", null, "意见锚点"), h("dd", null, "段号 + 小标题（任一变了，旧提案就过期）"),
        ),
        h("div", { className: "gzs-label", style: { marginTop: 12 } }, "本节原文"),
        paras.length
          ? h("div", { className: "gzs-quote" }, paras.join("\n\n"))
          : h("div", { className: "gzs-quote gzs-quote--empty" }, "（这一段还没有正文）"),
        // 改稿入口留在下面：口径仍然是「右栏不出输入框」，只把话递到左栏
        h("div", { className: "gzs-row", style: { marginTop: 10 } },
          h(Btn, {
            small: true, kind: "ghost",
            title: "把一句话填进左栏对话（只填不发）",
            on: () => onAsk?.(`【新媒体工作台】${artLabel} · 第 ${idx + 1} 段（${section.heading || "无小标题"}）改正文：现在写的是「${String(section.body || "").slice(0, 60)}…」，改成 `),
          }, "让 Agent 改这一段")),
      );
    }

    /**
     * 折叠区：默认收起，点标题展开。
     *
     * 为什么要有：右栏的口径是「看板」——打开一个页签先看到的是**东西本身**（图、原文、证据），
     * 而不是一排操作按钮。出图这类会花额度的动作收在折叠区里：要看才展开，不会误点。
     */
    function Collapse({ label, children, defaultOpen = false }) {
      const [open, setOpen] = React.useState(defaultOpen);
      return h("div", { className: "gzs-collapse" },
        h("button", {
          type: "button",
          className: `gzs-collapse__hd ${open ? "gzs-collapse__hd--on" : ""}`,
          "aria-expanded": open ? "true" : "false",
          onClick: () => setOpen((value) => !value),
        },
          h("span", { className: "gzs-collapse__mark" }, open ? "▾" : "▸"),
          h("span", null, label)),
        open ? h("div", { className: "gzs-collapse__body" }, children) : null);
    }

    /**
     * 「版式」页：排版按哪套模板、正文规格是多少、导出过没有。
     *
     * 历史工作台的「版式」给的是排版校验收据（门禁 / 逐字相等 / 排版件 / 正文规格 /
     * 长图 / 排版哈希 / 核验时间）。新媒体工作台没有那套外部门禁，等价物就是
     * **模板 tokens + 手机预览宽度 + 账本里的导出记录**——都是「读者最终看到什么」的证据。
     */
    function LayoutPane(props) {
      const { article, templates, ledger, exported } = props;
      const tokens = templateOf(templates, article?.template).tokens ?? {};
      const tpl = templateOf(templates, article?.template);
      const lastExport = (Array.isArray(ledger) ? ledger : [])
        .filter((row) => row?.type === "export")
        .pop() ?? null;
      const fmt = (value, unit = "") => (value === undefined || value === null || value === ""
        ? "—"
        : `${value}${unit}`);
      return h(React.Fragment, null,
        h("div", { className: "gzs-label" }, "排版体检"),
        h("dl", { className: "gzs-lines2" },
          h("span", null, "模板"), h("span", null, `${tpl.name || tpl.id || "—"}${tpl.id && tpl.name ? `（${tpl.id}）` : ""}`),
          h("span", null, "正文字号"), h("span", null, fmt(tokens.bodySize, "px")),
          h("span", null, "行高"), h("span", null, fmt(tokens.bodyLine)),
          h("span", null, "段间距"), h("span", null, fmt(tokens.paraGap, "px")),
          h("span", null, "标题字号"), h("span", null, fmt(tokens.h2Size, "px")),
          h("span", null, "左右内边距"), h("span", null, fmt(tokens.padSide, "px")),
          h("span", null, "强调色"), h("span", null, tokens.accent || "—"),
        ),
        tpl.desc
          ? h(React.Fragment, null,
            h("div", { className: "gzs-label", style: { marginTop: 12 } }, "这套模板的样子"),
            h("div", { className: "gzs-quote", style: { fontSize: 11.5, lineHeight: 1.75 } }, tpl.desc))
          : null,
        h("div", { className: "gzs-label", style: { marginTop: 12 } }, "手机预览"),
        h("dl", { className: "gzs-lines2" },
          h("span", null, "宽度"), h("span", null, `${PHONE_WIDTH}px（真机宽度，不压窄）`),
          h("span", null, "说明"), h("span", null, "中栏「手机预览」就是按这个宽度排的；导出 HTML 也是同一套 tokens。"),
        ),
        h("div", { className: "gzs-label", style: { marginTop: 12 } }, "导出"),
        h("dl", { className: "gzs-lines2" },
          h("span", null, "导出过"), h("span", null, lastExport ? `是 · ${String(lastExport.format || "html")}` : "还没有"),
          h("span", null, "最近一次"), h("span", null, lastExport ? ago(lastExport.ts) : "—"),
        ),
        h("div", { className: "gzs-hint", style: { marginTop: 8 } },
          "导出的 HTML 里正文图是 __IMG_01__ 这类占位符：粘到公众号后台后要按清单替换（这一步插件替不了）。"),
      );
    }



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
        // 「让 Agent 改」的去处：把一句带定位的话填进左栏对话（只填不发，由 Workspace 提供）
        onAsk,
        // 一键出齐缺图（串行、可中断、不覆盖旧版）
        onBatch,
        // 删整篇（移到回收站）
        onRemove,
      } = props;

      /**
       * 右栏是**看板**：只显示"现在是什么"，不给任何能打字的框。
       *
       * 这是用户 2026-11-07 明确的口径——"要对话该文案都在左侧的聊天框"。
       * 之前这里是一整排输入框（标题/摘要/正文/prompt），等于把编辑器搬到看板上，
       * 和「对话是唯一输入口」自相矛盾。现在每一行都配一颗「让 Agent 改」：
       * 点了就把带定位的一句话填进左栏对话，人补完按回车。
       */
      const ask = (text) => {
        if (typeof onAsk === "function") onAsk(text);
      };
      /** 只读一行：`label` 上方小字，下面就是值（空值说"未填"而不是空白）。 */
      const ro = (label, value, options = {}) => {
        const text = String(value ?? "").trim();
        const { ask: askText, box, empty = "未填", askLabel = "让 Agent 改" } = options;
        return h("div", { className: "gzs-ro" },
          h("div", { className: "gzs-ro__k" }, label,
            askText ? h(Btn, {
              small: true, kind: "ghost",
              title: "把一句话填进左栏对话（只填不发），你补完按回车",
              on: () => ask(askText),
            }, askLabel) : null),
          h("div", { className: `gzs-ro__v${text ? "" : " gzs-ro__v--empty"}${box ? " gzs-ro__v--box" : ""}` }, text || empty));
      };

      // hooks 必须无条件执行：article 从 null 变成对象时，早退之后再调 useState 会让 React 报
      // 「Rendered more hooks than during the previous render」，整块面板炸掉。
      const [nodeId, setNodeId] = React.useState("");
      const [feedbackDraft, setFeedbackDraft] = React.useState("");
      /**
       * tab 的受控/非受控两种用法。
       *
       * 外层（Workspace）要能在跳转时把 tab 切到对应面板，所以它传 `tab` + `onTab`；
       * 单测/直接调用时没人管它，就退回自己的 state。两种都得能跑，且 hook 顺序不变。
       *
       * 默认停在「本段」（2026-11-09 对齐历史工作台）：打开一篇稿子先看眼前这段的字，
       * 而不是先读一屏机器结论。要看「还欠什么」就点「证据」，那个页签带条数。
       */
      const [localTab, setLocalTab] = React.useState("section");
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

      /**
       * 「删掉这一段」的二次确认：点一次变成「真的删？」，3 秒内再点才真删。
       *
       * 删段落的是一次 POST `/save`，写下去就没了（没有撤销）。误点一下得回去翻版本、
       * 手工补回来，所以复用文件里已有的手势（提案卡的「确认写入？」），不另造弹窗。
       * 3 秒是「够看清、又不至于一直挂着」的折中：超时自己复位，
       * 免得过一会儿回来随手一点就成确认。
       */
      const [armDelete, setArmDelete] = React.useState("");
      // 删整篇同样要二次确认：一次误点就是几个小时的工作（虽然进的是回收站）
      const [armRemove, setArmRemove] = React.useState(false);
      React.useEffect(() => {
        if (!armRemove) return undefined;
        const timer = setTimeout(() => setArmRemove(false), 4000);
        return () => clearTimeout(timer);
      }, [armRemove]);
      React.useEffect(() => { setArmRemove(false); }, [article?.id]);
      React.useEffect(() => {
        if (!armDelete) return undefined;
        const timer = setTimeout(() => setArmDelete(""), 3000);
        return () => clearTimeout(timer);
      }, [armDelete]);
      // 换了段（或换了文章）就撤销待确认：否则对着新段的第一下就成了「真的删」
      React.useEffect(() => { setArmDelete(""); }, [selected, article?.id]);

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
      const lifeValue = String(article.lifecycle || "") || "draft";
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

      /**
       * 页签栏：数字取自**当前这一篇的真实计数**，不是写死的文案。
       *
       * 「图」给有图的槽位数（封面也算一个），「证据」给质量检查条数。
       * 0 不显示——历史工作台那边「事件 0」也只是一格噪音。
       */
      const imageSlots = [
        article?.cover ? "cover" : null,
        ...(article?.sections ?? []).map((s) => `sec-${s.id}`),
      ].filter(Boolean);
      const slotsWithImage = imageSlots.filter((slot) => {
        const data = slot === "cover" ? article?.cover : (article?.sections ?? []).find((s) => `sec-${s.id}` === slot)?.image;
        return Boolean(currentVersion(data));
      }).length;
      const qaCount = (qa?.items ?? []).length;
      // 页签标签照历史工作台的写法：第一个是**具体定位**（第 1 节 / 全文），不是固定词。
      // 历史工作台：第 1 节 / 图 5 / 版式 / 证据 12 / 事件 0
      const sectionTabLabel = selected === "article"
        ? "整篇"
        : selected === "cover"
          ? "封面"
          : (() => {
            const i = (article?.sections ?? []).findIndex((s) => `sec-${s.id}` === selected);
            return i >= 0 ? `第 ${i + 1} 段` : "本段";
          })();
      const tabLabel = { section: sectionTabLabel, images: "图", layout: "版式" };
      const tabCount = {
        section: null,
        images: slotsWithImage || null,
        layout: null,
      };

      const tabBar = h("div", { className: "gzs-itabs" },
        INSP_TABS.map(([key]) => h("button", {
          key,
          className: `gzs-itab ${tab === key ? "gzs-itab--on" : ""}`,
          onClick: () => setTab(key),
        }, tabLabel[key], tabCount[key] ? h("span", { className: "gzs-itab__n" }, String(tabCount[key])) : null)));

      // 「让 Agent 改」那句话里要带上这是哪一篇：对话里可能同时在聊别的事。
      const artLabel = String(article?.title || "这一篇").slice(0, 24);

      // 槽位标签：尺寸跟着「当前版本的真实尺寸」走。原来写死 900×383，可出图接口实际给的是
      // 1664×704（64 的倍数吸附后的档位），头上一写 900×383 就和下面的版本卡自相矛盾。
      // 提前到这里算，是因为顶部上下文卡的「当前定位」要用它（否则整篇/封面两处口径不一）。
      const realSize = active?.width && active?.height ? `${active.width}×${active.height}` : "";
      const slotLabel = selected === "cover"
        ? `封面${realSize ? `（${realSize}）` : "（目标 2.35:1）"}`
        : selected === "article"
          ? "整篇"
          : `第 ${sectionIndex(selected)} 段配图${realSize ? `（${realSize}）` : ""}`;

      // 上下文卡：两种选中态都要有，只是「当前定位」不同。
      const contextCard = h(ContextCard, {
        article, track, selected, scopeLabel, slotLabel, qa, pipeline, waiting,
        proposed: (proposals ?? []).length,
      });
      if (selected === "article") {
        return h("div", { className: "gzs-insp" },
          contextCard,
          tabBar,

          // 本段：整篇时给标题、全篇字数与各段小标题——「这篇讲到哪」的最短答案
          panel("section", h(SectionPane, { article, selected, onAsk: ask, artLabel, track, templates, onGovernance })),

          // 图：一篇里所有槽位，点一张切到那个槽位（看图，不是出图台）
          panel("images", h(ImageBoard, { article, onSelect, onBatch, busy, onAsk })),

          // 版式：模板 tokens + 手机预览宽度 + 导出记录（对齐历史工作台的「版式」）
          panel("layout", h(LayoutPane, { article, templates, ledger })),

          // 「证据」「事件」两页已按用户要求删掉：质量检查 / 十道门 / 账本都在「检查」抽屉里。

          // 删整篇：只有这里是「再也看不见」的动作，放在第一页（整篇）的最下面，
          // 且要再点一次——它不属于任何一个「看」的页签。
          h("div", { className: "gzs-inspfoot" },
            h(Btn, {
              small: true,
              kind: armRemove ? "primary" : "ghost",
              disabled: Boolean(busy),
              title: armRemove ? "4 秒内再点一次才真的删" : "删之前要再点一次确认",
              on: () => {
                if (!armRemove) { setArmRemove(true); return; }
                setArmRemove(false);
                onRemove?.(article.id);
              },
            }, armRemove ? "真的删？" : "删掉这一篇")));
      }

      // ── 槽位级 ──
      const preset = selected === "cover" ? "900x383" : "1024x576";

      return h("div", { className: "gzs-insp" },
        contextCard,
        tabBar,

        // 本段：这一段的小标题 / 字数 / 锚点 / 原文（对齐历史工作台的同一个页签）
        panel("section", h(SectionPane, { article, selected, onAsk: ask, artLabel, track, templates, onGovernance })),

        // 图：**看图**。缩略图 → 大图 → 规格行 → 版本条；
        // 出图控件收进最下面的折叠区（默认收起），所以这一页打开来只有图。
        panel("images",
          h("div", { className: "gzs-galleryhead" },
            h("span", null, `配图（${imageSlots.filter((slot) => Boolean(currentVersion(
              slot === "cover" ? article?.cover : (article?.sections ?? []).find((s) => `sec-${s.id}` === slot)?.image,
            ))).length}）`),
            h("div", { className: "gzs-spacer" }),
            h("span", { className: "gzs-hint" }, "点缩略图切到那个槽位")),
          h("div", { className: "gzs-gallery" },
            imageSlots.map((slot) => {
              const data = slot === "cover"
                ? article?.cover
                : (article?.sections ?? []).find((s) => `sec-${s.id}` === slot)?.image;
              const version = currentVersion(data);
              const label = slot === "cover" ? "封面" : `第 ${sectionIndex(slot)} 段`;
              return h("button", {
                key: slot, type: "button",
                className: `gzs-gallery__slot ${slot === selected ? "gzs-gallery__slot--on" : ""}`,
                title: version ? `${label} · ${version.vid}` : `${label} · 还没有图`,
                onClick: () => onSelect?.(slot),
              },
                version
                  ? h("img", { src: imageUrl(article.id, slot, version.vid), alt: label, loading: "lazy" })
                  : h("span", { className: "gzs-gallery__gap" }, "缺图"),
                h("span", { className: "gzs-gallery__cap" }, label));
            })),
          active
            ? h("div", { className: "gzs-bigpic" },
              h("img", { src: imageUrl(article.id, selected, active.vid), alt: slotLabel, decoding: "async" }))
            : h("div", { className: "gzs-empty", style: { minHeight: 110 } }, "这个槽位还没有图。"),
          active
            ? h("dl", { className: "gzs-lines2", style: { marginTop: 10 } },
              h("span", null, "类型"), h("span", null, slotLabel),
              h("span", null, "版本"), h("span", null, active.vid),
              h("span", null, "尺寸"), h("span", null,
                active.width && active.height
                  ? `${active.width}×${active.height} · ${(active.width / active.height).toFixed(2)}:1`
                  : "读不到"),
              h("span", null, "大小"), h("span", null, active.bytes ? `${Math.round(active.bytes / 1024)} KB` : "读不到"),
              h("span", null, "模型"), h("span", null, active.model || active.node || "—"),
              h("span", null, "出图时间"), h("span", null, active.createdAt
                ? String(new Date(active.createdAt).toISOString()).slice(0, 16).replace("T", " ")
                : "—"),
              h("span", null, "图注"), h("span", null, slotData?.caption || "未填"),
              active.note ? h("span", null, "说明") : null,
              active.note ? h("span", null, active.note) : null)
            : null,
          versions.length > 1
            ? h(React.Fragment, null,
              h("div", { className: "gzs-sect__head", style: { marginTop: 12, marginBottom: 8 } },
                h("span", null, `版本（${versions.length}）`),
                h("div", { className: "gzs-spacer" }),
                h("span", { className: "gzs-hint" }, "旧版不覆盖，点一下切回")),
              versions.slice().reverse().map((v) => h("div", {
                key: v.vid,
                className: `gzs-ver ${v.vid === active?.vid ? "gzs-ver--on" : ""}`,
                onClick: () => onPick(selected, v.vid),
              },
                h("span", { className: "gzs-ver__vid" }, v.vid),
                h("span", { className: "gzs-ver__meta" },
                  `${v.width}×${v.height} · ${v.node} · ${ago(v.createdAt)}`),
                v.vid === active?.vid ? h(Badge, { level: "ok" }, "当前") : null)))
            : null,
          // 出图：默认收起。看图这一页打开就该只有图，要动手才展开。
          h(Collapse, { label: active ? "换一张（重新出图）" : "出一张" },
            h("div", { className: "gzs-inspnote" },
              "prompt 只显示，不在这里改。要改就点「让 Agent 改」；改好回这里点「出图」。"),
            ro("出图 prompt", slotData?.prompt, {
              box: true,
              empty: "还没有 prompt（会让 Agent 先写字）",
              ask: `【新媒体工作台】${artLabel} · ${selected} 改出图 prompt：现在是「${String(slotData?.prompt || "（空）").slice(0, 60)}…」，改成 `,
            }),
            ro("不要出现（反向）", slotData?.negative, {
              empty: "未填",
              ask: `【新媒体工作台】${artLabel} · ${selected} 的「不要出现」：现在是「${slotData?.negative || "（空）"}」，加上 `,
            }),
            h("div", { className: "gzs-row", style: { gap: 8, marginBottom: 12 } },
              h("div", { className: "gzs-grow" },
                h("label", { className: "gzs-label" }, "这次出图用哪个节点"),
                h("select", {
                  className: "gzs-select", style: { width: "100%" }, value: nodeId || "",
                  onChange: (e) => setNodeId(e.target.value),
                },
                  h("option", { value: "" }, "（用默认）"),
                  (nodes ?? []).map((n) => h("option", { key: n.id, value: n.id, disabled: !n.usable },
                    `${n.name}${n.usable ? "" : `（${n.reason}）`}`)))),
              h("div", { style: { paddingTop: 17 } },
                String(slotData?.prompt ?? "").trim()
                  ? h(Btn, {
                    kind: "primary",
                    title: active ? "会生成一个新版本，旧版不覆盖" : "按上面的 prompt 出图",
                    disabled: Boolean(busy),
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
                  }, busy ? "出图中…" : "出图")
                  : h(Btn, {
                    kind: "primary", disabled: Boolean(busy),
                    title: "出图要先有 prompt（AI 写）。点一下把话递进左栏对话",
                    on: () => ask(`【新媒体工作台】${artLabel} · ${selected} 还没有出图 prompt。请按这一段的小标题与正文写一句出图 prompt（主体 + 场景 + 光线 + 色调，别写「高级感」这类形容词），写完我再出图。`),
                  }, "让 Agent 写 prompt"))),
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
                      : "这个槽位没有待用的反馈，这次只按上面的 prompt 出。")),
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
              : null)),

        // 版式：这一页对每个槽位都一样（模板是文章级的），但页签要在，口径才一致
        panel("layout", h(LayoutPane, { article, templates, ledger })),

        // 「证据」「事件」两页已按用户要求删掉（同上）。

        // 段落级动作：删段只在这一段被选中时出现，所以挂在页签下面而不是塞进某一页
        currentSection
          ? h("div", { className: "gzs-inspfoot" },
            h(Btn, {
              small: true,
              kind: armDelete === currentSection.id ? "primary" : "ghost",
              disabled: Boolean(busy),
              title: armDelete === currentSection.id ? "3 秒内再点一次才真删" : "删之前要再点一次确认",
              on: () => {
                if (armDelete !== currentSection.id) { setArmDelete(currentSection.id); return; }
                setArmDelete("");
                onDeleteSection(currentSection.id);
              },
            }, armDelete === currentSection.id ? "真的删？" : "删掉这一段"))
          : null);
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

    /**
     * 「图」tab：一篇里所有槽位的当前图。点一张切到那个槽位。
     *
     * 缺图多的时候给一颗「一键出齐缺图」：逐格点是 11 步里唯一的体力活。
     * 只挑**当前没有图**的槽位，已有的版本一张都不动；确认卡先说清要花几张额度。
     */
    function ImageBoard({ article, onSelect, onBatch, busy }) {
      // hooks 写在早退之前：article 从 null 到有值时会换一次走法，顺序不能变
      const [askBatch, setAskBatch] = React.useState(false);
      if (!article) return null;
      const sections = Array.isArray(article.sections) ? article.sections : [];
      const slots = [{ slot: "cover", label: "封面", image: article.cover }]
        .concat(sections.map((section, index) => ({ slot: `sec-${section.id}`, label: `第 ${index + 1} 段`, image: section.image })));
      const withImage = slots.filter((row) => currentVersion(row.image)).length;
      /**
       * 缺图分两档：**有 prompt 的**可以直接出，**没 prompt 的**得先让 AI 写。
       *
       * 宿主的 `/generate` 明确要求「先写 prompt 再出图」（空 prompt 直接 400），
       * 而 prompt 现在是 AI 产出的东西（右栏是看板，不给人敲）。所以一键出齐只能
       * 先出有 prompt 的那几张，剩下的把话递给左栏——不能拿小标题硬凑一句 prompt
       * 去糊出图，那出来的图只会更差，还让人觉得"AI 就这水平"。
       */
      const missingSlots = slots.filter((row) => !currentVersion(row.image));
      const ready = missingSlots.filter((row) => String(row.image?.prompt ?? "").trim()).map((row) => row.slot);
      const needPrompt = missingSlots.length - ready.length;
      const missing = ready;
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
          })),
        missingSlots.length
          ? (missing.length
            ? (askBatch
              ? h("div", { className: "gzs-confirm", style: { marginTop: 10 } },
                h("div", { className: "gzs-confirm__t" }, `要一次出齐 ${missing.length} 张吗`),
                h("div", { className: "gzs-confirm__b" },
                  h("div", null, "会消耗出图额度，一次一张串行出：出好一张就刷新一张。"),
                  needPrompt
                    ? h("div", null, `另有 ${needPrompt} 张还没有 prompt（要 AI 先写），这次先跳过。`)
                    : null,
                  h("div", { className: "gzs-hint", style: { marginTop: 4 } }, "已经有图的槽位一张都不动。中途可以停。")),
                h("div", { className: "gzs-confirm__acts" },
                  h(Btn, {
                    kind: "primary", small: true,
                    on: () => { setAskBatch(false); onBatch(missing); },
                  }, "开始出图"),
                  h(Btn, { small: true, kind: "ghost", on: () => setAskBatch(false) }, "算了")))
              : h("div", { style: { marginTop: 10 } },
                h(Btn, { small: true, kind: "primary", disabled: Boolean(busy), on: () => setAskBatch(true) },
                  `一键出齐缺图（${missing.length}）`)))
            : h("div", { className: "gzs-row", style: { marginTop: 10, gap: 8, flexWrap: "wrap" } },
              h(Btn, {
                small: true, kind: "primary", disabled: Boolean(busy),
                title: "出图要先有 prompt，而 prompt 是 AI 写的：点一下把话递进左栏",
                on: () => onAsk?.(`【新媒体工作台】${String(article.title || "这一篇").slice(0, 24)} · 这几张缺图还没有出图 prompt。请按每段的小标题与正文，给${needPrompt} 个槽位各写一句出图 prompt（主体 + 场景 + 光线 + 色调，不要写「高级感」这类形容词），写完我再一键出图。`),
              }, `让 Agent 先写 ${needPrompt} 张的 prompt`),
              h("span", { className: "gzs-hint" }, "出图必须带 prompt；prompt 由 AI 写，写好后这里就能一键出齐。")))
          : null);
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

    /**
     * 左栏对话绑哪个工作区（记本地）。
     *
     * 为什么要记：内嵌对话的 cwd 必须是宿主认得的某个工作区，否则输入框只会显示
     * 「选择一个工作区开始」。自动挑的那个不一定就是用户想聊的那个（他可能有好几个仓），
     * 所以给一个选择器，并把选择记住——不然每次打开面板都得重选一遍。
     */
    const CHAT_WS_KEY = "gzs.chatws.v1";
    function readChatWorkspace() {
      try {
        const value = localStorage.getItem(CHAT_WS_KEY);
        return typeof value === "string" ? value : "";
      } catch {
        return "";
      }
    }
    function writeChatWorkspace(workspaceId) {
      try {
        if (workspaceId) localStorage.setItem(CHAT_WS_KEY, String(workspaceId));
        else localStorage.removeItem(CHAT_WS_KEY);
      } catch {
        /* 隐私模式下写不进去：本次仍然生效，只是记不住 */
      }
    }

    /** 手机预览要占的地方：375 手机宽度 + 中栏左右各 26 内边距。 */
    const MID_NEED = PHONE_WIDTH + 52;    /**
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
      // 内置示例稿开着没有：只在空库首屏点得到。它是静态数据，不发请求、不落库。
      const [exampleOpen, setExampleOpen] = React.useState(false);
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
      /**
       * 首屏落哪一屏，**只在第一次拿到数据时决定一次**。
       *
       * `screen` 的初值是 article，好让「库里有稿」的人一进来就在最近一篇上（和历史工作台一致）。
       * 但库是空的时候，画面其实是首页（`!article` 那个分支），而 `screen` 还写着 article——
       * 于是「空库首屏 → 对话里刚建了一篇 → 状态刷新」这一串会把整块界面**突然跳进三栏**，
       * 用户手上还在首页读那句话。实测冒烟就是在这里对不上账。
       * 所以：第一次加载是空库就明确落到 home，之后不再跟着数据自己跳；进哪篇由人点。
       */
      const landedRef = React.useRef(false);
      React.useEffect(() => {
        if (landedRef.current || boot.loading) return;
        landedRef.current = true;
        if (!(boot.list ?? []).length) setScreen("home");
      }, [boot.loading, boot.list]);
      // 内容线：公众号（做一篇稿）+ 视频号（做一期片）。两条线共用一个面板，顶部一条切换。
      const [channel, setChannel] = React.useState("article");
      // 以前这里有一条「没配真源仓库就把频道拽回公众号」的自愈。它现在删掉了：
      // 视频号那一栏**没配也能看**（八步步骤 + 怎么接），把人拽走反而是「我点了没反应」。
      // 视频号是自读盘的独立组件：换 key 即重新挂载 = 重新拉一次（「刷新」按钮用）
      const [videoEpoch, setVideoEpoch] = React.useState(0);
      /**
       * 右栏检查器当前停在哪个 tab（本段 / 图 / 证据 / 元信息）。
       *
       * 状态放在这里而不是 Inspector 里：顶部那条「N 份提案待确认 · 去检查」要能把 tab
       * 切到对应面板。tab 藏在子组件里的话，跳转只能滚到空气。
       */
      const [inspTab, setInspTab] = React.useState("section");
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
      /** 「检查」抽屉：QA / 提案 / 清单 / 账本集中看，不再是独立视图。 */
      const [inspectOpen, setInspectOpen] = React.useState(false);
      /** 「步骤」抽屉：两条内容线各自要过哪几步。首页 / 单篇 / 视频号都能打开。 */
      const [stepsOpen, setStepsOpen] = React.useState(false);
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
      // 「步骤」抽屉同理。
      React.useEffect(() => {
        if (!stepsOpen) return undefined;
        const onKey = (event) => { if (event?.key === "Escape") setStepsOpen(false); };
        window.addEventListener?.("keydown", onKey);
        return () => window.removeEventListener?.("keydown", onKey);
      }, [stepsOpen]);
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
      // 没配 pipelineRoot 的人占绝大多数，而**没配就没有输入框**：首屏那句
      // 「说一句话，它帮你从选题写到成稿」于是成了空话——点「开始写」，面板这边填不进去、
      // 那边也没有输入框可填，用户看到的结论是「点了根本没反应」。
      // 所以 cwd 按三档退：产线根 → 用户选过的工作区 → 宿主里第一个工作区。
      const useWorkspaces = typeof props?.useWorkspaces === "function" ? props.useWorkspaces : () => undefined;
      const workspaceItems = useWorkspaces((state) => state?.items);
      const workspaceList = Array.isArray(workspaceItems) ? workspaceItems : [];
      const [chatWsPick, setChatWsPick] = React.useState(readChatWorkspace);
      const pickChatWorkspace = React.useCallback((workspaceId) => {
        setChatWsPick(workspaceId);
        writeChatWorkspace(workspaceId);
      }, []);
      const chatRoot = React.useMemo(() => {
        if (boot.pipelineRoot) return boot.pipelineRoot;
        const picked = workspaceList.find((item) => item?.workspaceId === chatWsPick);
        return picked?.path || workspaceList[0]?.path || boot.root || "";
      }, [boot.pipelineRoot, boot.root, chatWsPick, workspaceList]);
      const chatWorkspaceId = React.useMemo(() => {
        const target = normalizeChatPath(chatRoot);
        if (!target) return null;
        return workspaceList.find((item) => normalizeChatPath(item?.path) === target)?.workspaceId ?? null;
      }, [workspaceList, chatRoot]);
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
      }, [screen, channel, chatOpen, Boolean(view?.article)]);

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
      /**
       * 窄面板：放不下就**分段**（结构 / 成稿 / 检查器 三格一次看一格），不再横向滚。
       *
       * 需要的宽度要按**当前真的显示几栏**算：左栏收着的时候（对话一开就自动收起），
       * 只要「427 预览 + 250 检查器 + 一条分隔条」= 684；左栏展开才是 891。
       * 用固定 891 判会把 1600 这种明明放得下两栏的窗口也判成窄面板——
       * 那正是"用户明明有大屏却被塞进标签页"的坏体验。
       */
      const needWidth = (railVisible ? COL_LIMITS.left.min + SPLIT_W : 0) + MID_NEED + COL_LIMITS.right.min + SPLIT_W;
      const compact = bodyW > 0 && bodyW < needWidth + 9;
      /** 分段模式下当前看哪一格。宽屏不用它。 */
      const [pane, setPane] = React.useState("mid");
      React.useEffect(() => {
        const node = colRefs.current.body;
        if (!node) return;
        // 分段模式本来就不横滚，别再报"三栏放不下"
        setBodyOver(compact ? false : node.scrollWidth - node.clientWidth > 2);
      }, [leftW, rightW, bodyW, chatOpen, screen, channel, compact, railVisible]);

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
          setBoot({ loading: false, error: "", list: data.articles ?? [], activity: data.activity ?? [], counts: data.counts ?? null, filters: data.filters ?? null, matched: data.matched ?? null, templates: data.templates ?? [], nodes: data.settings?.nodes ?? [], settings: data.settings ?? null, pipelineRoot: data.settings?.pipelineRoot ?? "", root: data.root ?? "", tracks: data.tracks ?? [], repoConfigured: data.repoConfigured === true });
          const nextId = keep && data.articles?.some((a) => a.id === activeId) ? activeId : (data.articles?.[0]?.id ?? "");
          if (nextId) await loadArticle(nextId);
          else setView(null);
        } catch (error) {
          setBoot((prev) => ({ ...prev, loading: false, error: error.message }));
        }
      };

      /**
       * 请求序号：连着切篇时，**先发的可能后到**。
       *
       * 在「全部文章」里点两下，出一趟 A 一趟 B；B 先回、A 后回，A 的正文就会盖掉 B 的——
       * 列表选中的是 B，中间显示 A，右栏检查器还跟着 A 的槽位跑，三处各指一篇。
       * 用序号认「这份数据还是不是最后一次点击」：不是就整包丢掉，连 toast 都不弹
       * （那次请求本来就已经不是用户想要的了）。
       */
      const loadSeq = React.useRef(0);

      /** 拉单篇；返回这次的结果有没有真的落到视图上（被后来的请求顶掉时是 false）。 */
      const loadArticle = async (id) => {
        if (!id) return false;
        const seq = ++loadSeq.current;
        try {
          const data = await getJson(`${ROUTES.article}?id=${encodeURIComponent(id)}`);
          if (seq !== loadSeq.current) return false;
          setView(data);
          setActiveId(id);
          setContext({ kind: "article", id, label: `${data.article?.title || id} · 公众号` });
          // 换文章（或刷新）后旧提案的对照已经不属于当前这篇，收起
          setProposalDetail(null);
          return true;
        } catch (error) {
          // 被顶掉的那次失败不要报：用户已经在看新的一篇了，弹「读文章失败」只会莫名其妙
          if (seq !== loadSeq.current) return false;
          say(`读文章失败：${error.message}`);
          return false;
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

      /**
       * 一键出齐缺图：**串行**一张一张出，看得见进度，能中途停。
       *
       * 为什么要有：一篇 6 段的稿，逐格点要 7 次，而这是 11 步里唯一的纯体力活
       * （写稿、改稿、合并都由 Agent 做）。为什么串行不发并行：出图是**花额度**的动作，
       * 并行发出去人既看不清进度、又没法在第二张失败时停下来。
       * 为什么不去覆盖旧版：只挑「当前没有图」的槽位，已有的版本一张都不动。
       */
      const batchRef = React.useRef({ stop: false });
      const [batch, setBatch] = React.useState(null);
      const generateMissing = (slots) => {
        const list = Array.isArray(slots) ? slots.filter(Boolean) : [];
        if (!list.length || !article) return;
        batchRef.current = { stop: false };
        const total = list.length;
        setBusy(true);
        (async () => {
          let done = 0;
          let failed = "";
          for (const slot of list) {
            if (batchRef.current.stop) break;
            batchRef.current.last = slot;
            setBatch({ total, done, current: slot });
            try {
              await postJson(ROUTES.generate, {
                id: article.id,
                slot,
                size: slot === "cover" ? "900x383" : "1024x576",
              });
              done += 1;
              // 每张之后立刻刷新：进度不只是数字，是"真的多了一张图"
              await loadArticle(article.id);
            } catch (error) {
              failed = String(error?.message ?? error);
              break;
            }
          }
          setBatch(null);
          setBusy(false);
          const label = (slot) => (slot === "cover" ? "封面" : `第 ${sectionIndex(slot)} 段`);
          if (failed) {
            say(`出图停在「${label(batchRef.current.last ?? "")}」：${failed}。已经出好的 ${done} 张都在`);
          } else if (batchRef.current.stop) {
            say(`已停下：出了 ${done}/${total} 张，剩下的点「一键出齐」接着来`);
          } else {
            say(`${total} 张出齐了（${done} 张本次生成）`);
          }
        })();
      };

      /**
       * 删掉这一篇：**移到回收站，不硬删**（宿主侧 `rename` 到 `~/.dsh/gzh-studio/trash/`）。
       * 不做撤销栈：想找回自己搬回去就行，这比"删了还能撤销 5 秒"可靠。
       * 宿主还没重启时这条路由不存在（404），要说清而不是假装删了。
       */
      const onRemove = (id) => write(async () => {
        try {
          await postJson(ROUTES.remove, { id: id ?? article?.id });
        } catch (error) {
          if (Number(error?.status) === 404) {
            say("删稿这条路由还没生效：重启一次 dsh web 之后才能删（这篇没动）");
            return;
          }
          throw error;
        }
        setView(null);
        setActiveId("");
        setScreen("home");
        await loadState(true);
        say("已移到回收站（~/.dsh/gzh-studio/trash/），想找回可以搬回来");
      });

      const onPick = (slot, vid) => write(async () => {        const result = await postJson(ROUTES.pick, { id: article.id, slot, vid });
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

      /**
       * 新建 = **建一张空白稿，然后请 AI 给几个方向**。
       *
       * 这里原来是一张表单（内容类型 / 标题 / 讲给谁 / 带走什么 / 先摆几段 / 模板）。
       * 用户 2026-11-07 的原话是「从零开始填这样的动作不要有，我们是让 AI 生成的，
       * 标题人物文案所有步骤都是 AI 写、AI 推荐，人只做选择题」，而且那张表看起来
       * 「像在做 PPT，不像做文章」。所以表单整张删掉：
       * 点一下 = 建一张空白稿 + 把「先给我三个方向，我选一个」递进左栏对话。
       * 人接下来只做选择，不做填空。
       */
      const onCreate = () => write(async () => {
        const result = await postJson(ROUTES.create, {
          title: "",
          audience: "",
          takeaway: "",
          // 先摆三段只是给「逐段出图」一个位置，写成什么样由 Agent 定；后面它会自己增删。
          sections: 3,
          template: boot.settings?.defaultTemplate || "business",
          track: "",
        });
        await loadState();            // 列表要有这条
        await loadArticle(result.article.id);
        setSelected("article");
        setScreen("article");
        chatOpenStore.set(true);
        // 不替人按回车：话填进去，发不发由人决定（面板自己发出去的消息，人在输入框里改不了）。
        bringToChat([
          `【新媒体工作台】刚建了一张空白稿（${result.article?.id ?? "新稿"}）。`,
          "别问我怎么填表：先给我 3 个选题方向，每个一行写清「标题 / 讲给谁 / 想让人带走什么」，",
          "我选一个，你再动笔。",
          // 归类靠这一句：类型不会自动推断，不提醒就全落「通用」。
          // 只让它**顺手带**，不设成必填——「一句话就能开始写」的前提不能破。
          (boot.tracks ?? []).length
            ? `动笔时顺手把这批稿归到内容类型里（建稿或保存时带 track，值从这些 id 里选：${(boot.tracks ?? []).map((t) => t.id).slice(0, 12).join("/")}${(boot.tracks ?? []).length > 12 ? " 等" : ""}）；判断不了就留空当「通用」，别瞎猜。`
            : "",
        ].filter(Boolean).join("")).then((sent) => say(sent.ok
          ? "已经请它给方向了：左栏看一眼，按回车发出去"
          : `没带过去：${sent.reason}。直接在左栏说「给我 3 个选题方向」也行`));
      });

      const onExport = (format) => {
        if (!article) return;
        const url = `${ROUTES.export}?id=${encodeURIComponent(article.id)}&format=${format}`;
        /**
         * 先取文本：能复制就复制（公众号后台要粘），同时给下载。
         *
         * `writeText` 返回的是 Promise，**不能同步当成成功了**：
         * - 页面没聚焦（点了别处、切了窗口）时它会 reject，
         *   而 `writeText?.(body)` 的返回值没人接 → 控制台一条「Uncaught (in promise) NotAllowedError」；
         * - 更要紧的是以前 `copied = Boolean(navigator.clipboard?.writeText)` 只要 API 存在就报「已复制」，
         *   实际没复制进去，用户去公众号后台粘贴是空的。**说做过的事，必须真做过。**
         */
        fetch(url, { credentials: "same-origin" })
          .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))))
          .then(async (body) => {
            let copied = false;
            const clip = navigator.clipboard;
            if (clip && typeof clip.writeText === "function") {
              try {
                await clip.writeText(body);
                copied = true;
              } catch {
                copied = false; // 无焦点 / 没权限：不报错，只是这半句提示换成「请手动复制」
              }
            }
            const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
            const href = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = href;
            a.download = `${article.id}.${format === "md" ? "md" : format === "checklist" ? "txt" : "html"}`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(href), 4000);
            say(copied ? "已复制到剪贴板，也下载了一份" : "已下载。浏览器没让写剪贴板（页面未聚焦时常见），从下载的文件里复制即可。");
          })
          .catch((error) => say(`导出失败：${error.message}`));
      };

      // ── 顶栏 ──
      /**
       * 「参数」= 右栏元信息的**只读**视图。
       *
       * 这里只负责把人送到「现在是什么在那儿」，并把那一栏滚进视野 + 闪一下。
       * 改哪一项点那一行的「让 Agent 改」——话会填进左栏对话。右栏不出输入框。
       */
      const [metaFlash, setMetaFlash] = React.useState(false);
      const openMeta = () => {
        setInspTab("meta");
        setMetaFlash(true);
        // 分段模式下右栏可能不是当前那一格：先切过去，否则"点了没反应"
        if (compact) setPane("right");
        const node = colRefs.current.right;
        try { node?.scrollIntoView?.({ block: "nearest", inline: "nearest" }); } catch { /* 老浏览器没有 */ }
        say("参数是只读的：要改哪一项，点它右边的「让 Agent 改」");
        setTimeout(() => setMetaFlash(false), 1400);
      };
      /**
       * 公众号草稿箱：配没配、推没推。
       *
       * 只推到**草稿箱**——发表仍然要人去公众号后台点。这条边界是产品口径，不是技术限制：
       * 插件能帮到「内容进后台」，但不能替人按那个不可撤销的按钮。
       * 配置不走面板（右栏是看板、也不该收密钥）：没配时点按钮会把一句话递进左栏，
       * 让 Agent 去写 ~/.dsh/gzh-studio/wechat.json。
       */
      const [wx, setWx] = React.useState({ usable: false, configured: false, appId: "", author: "", missing: true });
      const [wxBusy, setWxBusy] = React.useState(false);
      React.useEffect(() => {
        let live = true;
        (async () => {
          try {
            const data = await getJson(ROUTES.wechatStatus);
            if (live) setWx({ usable: data?.usable === true, configured: data?.configured === true, appId: data?.appId ?? "", author: data?.author ?? "", missing: false });
          } catch (error) {
            // 宿主还没重启时这条路由是 404：不说清楚，用户会以为"配置丢了"。
            if (live) setWx({ usable: false, configured: false, appId: "", author: "", missing: true, error: Number(error?.status) === 404 ? "宿主还没重启：草稿箱路由不存在" : String(error?.message ?? error) });
          }
        })();
        return () => { live = false; };
      }, [article?.id]);

      const askWechatConfig = () => {
        bringToChat([
          "【新媒体工作台】帮我配公众号草稿箱：把 AppID 与 AppSecret 写进 ~/.dsh/gzh-studio/wechat.json",
          "（字段 appId / appSecret，可选 author），别把密钥回显在对话里。配好我刷新一次就能推。",
        ].join("")).then((result) => say(result.ok
          ? "已把配置方法递进左栏对话，按回车让它去做"
          : `没带过去：${result.reason}`));
      };

      const pushDraft = () => {
        if (!article || wxBusy) return;
        setWxBusy(true);
        postJson(ROUTES.push, { id: article.id })
          .then((result) => say(`已推进公众号草稿箱（media_id ${String(result?.mediaId ?? "").slice(0, 12)}…）：发表仍要你去后台点`))
          .catch((error) => {
            if (Number(error?.status) === 404) say("推送这条路由还没生效：重启一次 dsh web 之后才能推（这篇没动）");
            else say(`没推上去：${error?.message ?? error}`);
          })
          .finally(() => setWxBusy(false));
      };

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
      //
      // 视频号**常驻**（2026-11-07 改）：以前只在配了真源仓库时才出现，理由是
      // 「没配的时候点进去整页都在解释为什么什么都没有」。但那条规则的真实后果是——
      // 用户问「我的视频面板呢？」。一个功能藏起来，用户不会得出「我去配个仓库」，
      // 只会得出「这插件没有视频」。所以它一直在这儿，没配的时候点进去给的是
      // 「八步是哪八步 + 怎么接上真源」，而不是一页空解释。
      const lines = [["article", "公众号"], ["video", "视频号"]];
      const chan = h("div", { className: "gzs-chan", title: "切内容线：公众号（一篇稿）/ 视频号（一期片）" },
        lines.map(([key, label]) => h("button", {
          key,
          className: `gzs-chan__b ${channel === key ? "gzs-chan__b--on" : ""}`,
          title: key === "video" && !boot.repoConfigured ? "视频号：八步步骤已就位，真源仓库还没接（接上就能看期）" : undefined,
          onClick: () => {
            setChannel(key);
            setContext(key === "video"
              ? { kind: "video", id: "", label: "视频号列表" }
              : { kind: "article", id: activeId, label: `${article?.title || activeId || "新媒体工作台"} · 公众号` });
          },
        }, label, key === "video" && !boot.repoConfigured ? h("span", { className: "gzs-chan__dot", title: "真源仓库未配置" }) : null)));
      // 顶栏跟**画面**走，不跟状态走：`screen` 初值是 article，但库是空的时候画面是首页。
      // 于是顶栏会渲染出一整排「检查 / 参数 / 出稿」——它们都绑在 article 上，此刻全是死的。
      // 点了没反应，用户不会去怪「状态和画面不同步」，只会觉得这台机器坏了。
      if (screen === "home" || !article) {
        // 首页自带「新建」按钮，顶栏不再重复；这里只留内容线、步骤、标题和刷新
        head = h("div", { className: "gzs-head" },
          h("button", {
            className: `gzs-chattoggle${chatOpen ? " is-on" : ""}`,
            title: chatOpen ? "收起左侧原生对话，让面板占满" : "在左侧打开 DSH 原生对话（同一条会话）",
            onClick: toggleChat,
          }, chatOpen ? "◧ 对话" : "▢ 对话"),
          h("button", {
            className: `gzs-chattoggle${stepsOpen ? " is-on" : ""}`,
            title: "做一篇稿 / 一期视频要过哪几步、现在卡在哪",
            "aria-pressed": stepsOpen ? "true" : "false",
            onClick: () => setStepsOpen((v) => !v),
          }, "≡ 步骤"),
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
            // 「步骤」= 全局步骤抽屉。收起左栏是另一件事（「▤ 左栏」）：
            // 前者回答「要过哪几关」，后者只是布局。两个都被点过却没反应的功能，
            // 一定有一个被放错了位置。
            h("button", {
              className: `gzs-chattoggle${stepsOpen ? " is-on" : ""}`,
              title: "做一篇稿 / 一期视频要过哪几步、现在卡在哪",
              "aria-pressed": stepsOpen ? "true" : "false",
              onClick: () => setStepsOpen((v) => !v),
            }, "≡ 步骤"),
            isArticle && screen === "article" && !compact
              ? h("button", {
                className: `gzs-chattoggle${railVisible ? " is-on" : ""}`,
                title: railVisible ? "收起左栏（本期进度与结构），把宽度让给预览" : "展开左栏（本期进度与结构）",
                "aria-pressed": railVisible ? "true" : "false",
                onClick: () => setRailOpen((v) => !v),
              }, "▤ 左栏")
              : null,
            chan,
            isArticle
              ? h(Btn, {
                small: true, kind: "ghost", title: "全部文章（含往期）",
                // 回首页时顺手收起往期抽屉：否则它会盖在首页上，像「点了没反应」。
                on: () => { setRepoOpen(false); setScreen("home"); loadState(true).catch(() => {}); },
              }, "全部文章")
              : null),
          h("div", { className: "gzs-headgroup gzs-headgroup--mid" },
            h("span", { className: "gzs-title" }, isArticle ? "新媒体工作台" : "视频号看板"),
            isArticle && boot.list?.length
              ? h("select", {
                className: "gzs-select",
                title: "换一篇",
                value: activeId,
                // 切篇之后才切 screen：慢响应被后来的请求顶掉时（applied 为 false），
                // 别把用户拽去一篇根本不是他最后选的那篇
                onChange: (e) => { setActiveId(e.target.value); loadArticle(e.target.value).then((applied) => { if (applied) setScreen("article"); }); setSelected("article"); },
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
            // 「参数」：内容类型 / 模板 / 讲给谁 / 带走什么 / 标题摘要——建完之后随时改的地方。
            // 以前这几项只在「新建」时填得进，想改等于重来；参数卡就是补这个洞。
            // 「参数」= 右栏「元信息」，不是那个检查抽屉。
            //
            // 踩过（0.3.1 冒烟）：这里原来是 setInspTab("meta") + setInspectOpen(true)——
            // 抽屉里渲染的是 Governance（QA / 提案 / 账本），它根本不认 tab，
            // 于是「参数」打开了一屏**没有任何输入框**的东西，而 tooltip 还在承诺
            // 「内容类型 / 模板 / 讲给谁 / 带走什么」。那就是一个假按钮。
            // 现在它真的把右栏切到元信息，并闪一下边框，让人看见「东西在那儿」。
            isArticle && screen === "article"
              ? h(Btn, {
                small: true, kind: "ghost",
                title: "在右栏「元信息」里看：标题 / 摘要 / 讲给谁 / 带走什么 / 标签 / 模板 / 内容类型（只读；要改点那一行的「让 Agent 改」）",
                on: openMeta,
              }, "参数")
              : null,
            // 推草稿箱：只推到「草稿箱」，发表仍然要人去公众号后台点。
            // 配置不是在这里填（右栏只看、面板不收密钥）：点「未配」那颗，会把一句话递进左栏，
            // 让 Agent 去写 ~/.dsh/gzh-studio/wechat.json。
            isArticle && screen === "article"
              ? h(Btn, {
                small: true,
                kind: wx.usable ? "primary" : "ghost",
                disabled: !article || Boolean(busy) || wxBusy,
                title: wx.usable
                  ? "推到公众号草稿箱（不是发表；发表仍要你去后台点）"
                  : "还没配公众号：点一下，让 Agent 去写 AppID / AppSecret",
                // 三种状态说三句话：路由没生效 / 没配 / 配好了
                on: () => {
                  if (wx.missing) { say("推送要重启一次 dsh web 才会生效（这次是旧的宿主进程）"); return; }
                  if (!wx.usable) { askWechatConfig(); return; }
                  pushDraft();
                },
              }, wxBusy ? "推送中…" : (wx.usable ? "推草稿箱" : "推草稿箱（未配）"))
              : null,
            // 出稿（HTML / Markdown / 图片清单）只留正文 meta 行那颗「导出 ▾」：
            // 同一件事摆两处，窄窗口下就是两行按钮挤掉标题。2026-11-08 删上面那组。
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
      if (exampleOpen) {
        // 示例优先于一切：它是从空库首屏点进来的，看完就关。
        body = h(ExampleSheet, {
          templates,
          onClose: () => setExampleOpen(false),
          onStart: () => { setExampleOpen(false); onCreate(); },
        });
      } else if (channel === "video") {
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
          // 卡上的模板要显示中文名，不能把 id（business）直接摆给人看
          templates: boot.templates,
          onOpenExample: () => setExampleOpen(true),
          // 改筛选就重新拉一次：计数基于全量、列表基于筛选，两者必须来自同一次读取
          onFilter: (next) => loadState(true, next).catch(() => {}),
          // 同一类错序：首页点开一篇，慢响应回来时人可能已经在看别的稿了
          onOpen: (id) => { loadArticle(id).then((applied) => { if (applied) setScreen("article"); }); setSelected("article"); },
          onCreate,
          // 首屏那句「开始写」把字填进左栏对话——所以它得知道左栏在不在、有没有会话。
          // 对话**收着**的时候不能报「对话还没接上」：那时它压根没开会话，
          // 真实情况是「你可以展开它」，不是「它坏了」。两种都不好用时才真的提示。
          chatOpen,
          chatReady: chatOpen ? Boolean(chat.reference) : true,
          onOpenChat: () => chatOpenStore.set(true),
          // 首屏也能直接切到视频号：两条线都在这一个面板里，第一页就该让人知道
          onGoVideo: () => {
            setChannel("video");
            setContext({ kind: "video", id: "", label: "视频号列表" });
          },
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
        };
        // 三个栏位先各自建好，再按「放不放得下」排成三栏或分段——
        // 同一份 JSX 走两条版式，不复制一套代码（复制出来的两套迟早不一致）。
        const railNode = h(StepRail, {
          view, article, selected,
          onSelect: setSelected,
          onAddSection,
          busy,
        });
        const stageNode = h(Stage, {
          article, templates, selected,
          onSelect: setSelected,
          onExport,
          // 预览里的「重出 / 换版」：直连已有的出图与切版动作，不另造一条写入路径。
          onRegenerate: (slot) => onGenerate({ slot }),
          onPickVersion: onPick,
          busy,
        });
        const inspNode = h(React.Fragment, null,
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
            // 右栏是看板：里面每一颗「让 Agent 改」都从这里把话填进左栏对话（只填不发）
            onAsk: (text) => {
              bringToChat(text).then((result) => say(result.ok
                ? "已把这句话填进左栏对话，补完按回车"
                : `没带过去：${result.reason}。也可以直接在左栏说。`));
            },
            proposals: view?.proposals ?? [], proposalDetail,
            onOpenProposal, onCloseProposal, onDecideProposal,
            // 一键出齐缺图（串行、可中断、不覆盖旧版）
            onBatch: generateMissing,
            onRemove,
            feedback: view?.feedback ?? null,
            // 去 AI 味 / 审阅清单只报数（操作台在治理视图），所以只传数不传动作
            deai: view?.deai ?? null,
            reviews: view?.reviews ?? null,
            pipeline: view?.pipeline ?? null,
            track: view?.track ?? null,
            pipeBlock,
            onGovernance: () => setInspectOpen(true),
          }));

        if (compact) {
          /**
           * 窄面板（可用宽度放不下三栏）：**分段**，不横向滚。
           *
           * 1280 的窗口打开左栏对话后，工作区只剩 629px，而三栏最低要 891
           * （左 200 + 中 427 + 右 250 + 两条分隔条 14）。原来靠横向滚动兜底，
           * 滚动条一被藏起来，用户看到的就是"右边那一栏不见了"。
           * 现在改成三格分段：一次看一格，整格满宽，不用滚。
           */
          body = h("div", {
            className: "gzs-compact",
            ref: (node) => {
              colRefs.current.body = node;
              colRefs.current.left = node;
              colRefs.current.right = node;
            },
          },
            h("div", { className: "gzs-panes", role: "tablist", "aria-label": "栏位" },
              [["left", "结构"], ["mid", "成稿"], ["right", "检查器"]].map(([key, text]) => h("button", {
                key, role: "tab", "aria-selected": pane === key ? "true" : "false",
                className: `gzs-panes__b${pane === key ? " is-on" : ""}`,
                onClick: () => setPane(key),
              }, text))),
            h("div", { className: "gzs-panes__wrap" },
              h("div", { className: `gzs-pane${pane === "left" ? " is-on" : ""}` }, railNode),
              h("div", { className: `gzs-pane gzs-pane--mid${pane === "mid" ? " is-on" : ""}` }, stageNode),
              h("div", {
                className: `gzs-pane gzs-pane--right${pane === "right" ? " is-on" : ""}${metaFlash ? " gzs-col--flash" : ""}`,
              }, inspNode)));
        } else {
          body = h("div", { className: "gzs-body", ref: (node) => { colRefs.current.body = node; } },
            // 左栏：本期步骤优先（未绑期号时按稿件推断，结构列表折叠在底部）
            h("div", {
              className: "gzs-col gzs-col--left",
              ref: (node) => { colRefs.current.left = node; },
              // 用户没拖过就不写内联固定值之外的东西：宽度仍来自 autoCols（跟着可用空间走）
              // 收起时不写 display:none 到 CSS 里，而是就地隐藏——DOM 还在，
              // 组件状态（步骤展开到哪、结构折没折）不丢，收回来还是原样。
              style: railVisible ? { flexBasis: `${leftW}px` } : { flexBasis: `${leftW}px`, display: "none" },
            }, railNode),

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
            }, stageNode),

            h(Splitter, {
              label: "中间预览与检查器之间",
              onStart: () => measure("right", rightW),
              onDrag: (want) => dragCol("right", want),
              onReset: () => resetCol("right"),
              // 分隔条在右栏左边：往右拖 = 把右栏挤窄
              invert: true,
            }),

            // 右栏：检查器（证据 / 图 / 元信息）。栏头只写「检查器」不写范围：
            // 范围（整篇 / 封面 / 第 N 段）就在下面一行由检查器自己报，tab 名也在下面。
            h("div", {
              className: `gzs-col gzs-col--right${metaFlash ? " gzs-col--flash" : ""}`,
              ref: (node) => { colRefs.current.right = node; },
              style: { flexBasis: `${rightW}px` },
            }, inspNode));
        }
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
              // 工作区选择器：cwd 落在宿主不认的目录上时，对话区只有一个「选择一个工作区开始」，
              // 点哪都没输入框。给一个能换的地方，比让人去猜「为什么这里不能打字」强。
              workspaces: workspaceList,
              workspaceId: chatWorkspaceId,
              onPickWorkspace: pickChatWorkspace,
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
          // 批量出图的进度条：串行出图可能要好几分钟，没有这条就是"点了没反应"
          batch
            ? h("div", { className: "gzs-batchbar" },
              h("span", { className: "gzs-batchbar__k" }, "正在出图"),
              h("span", { className: "gzs-batchbar__v" },
                `${batch.done}/${batch.total} · ${batch.current === "cover" ? "封面" : `第 ${sectionIndex(batch.current)} 段`}`),
              h("span", { className: "gzs-batchbar__bar" },
                h("i", { style: { width: `${Math.round((batch.done / Math.max(1, batch.total)) * 100)}%` } })),
              h("div", { className: "gzs-spacer" }),
              h(Btn, { small: true, kind: "ghost", on: () => { batchRef.current.stop = true; } }, "停在这张之后"))
            : null,
          // 对话收起时这条常驻：面板此刻看起来就是「一个只能看、不能说的界面」，
          // 不写清楚「话要去左栏说」，用户只会得出「按钮都没反应」。
          !chatOpen
            ? h("div", { className: "gzs-rolebar" },
              h("b", null, "左栏是对话，这里是看板"),
              h("span", null, "改标题、写正文、出图、改排版都在左侧对话里说——这里只显示结果。"),
              h("div", { className: "gzs-spacer" }),
              h(Btn, { small: true, kind: "primary", on: toggleChat }, "打开对话"))
            : null,
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
        // 「步骤」抽屉：两条线的步骤一眼看全，点一下就进来；Esc / 遮罩关掉。
        stepsOpen
          ? h("div", { className: "gzs-scrim", onClick: () => setStepsOpen(false) })
          : null,
        stepsOpen
          ? h("aside", { className: "gzs-drawer", "aria-label": "步骤" },
            h("div", { className: "gzs-drawer__bar" },
              h("span", { className: "gzs-drawer__t" }, "步骤"),
              h("span", { className: "gzs-hint" }, "公众号 11 步 / 视频号 8 步 · 面板只报进度"),
              h("div", { className: "gzs-spacer" }),
              h(Btn, { small: true, kind: "ghost", on: () => setStepsOpen(false) }, "关闭")),
            h("div", { className: "gzs-drawer__body" },
              h(StepsBoard, {
                view,
                article,
                videoConfigured: Boolean(boot.repoConfigured),
                onJump: () => { setStepsOpen(false); setScreen("article"); },
                onCreate: () => { setStepsOpen(false); onCreate(); },
                onGoChat: () => { setStepsOpen(false); chatOpenStore.set(true); },
                onGoVideo: () => {
                  setStepsOpen(false);
                  setChannel("video");
                  setContext({ kind: "video", id: "", label: "视频号列表" });
                },
                // 每行都能"去办"：有落点就跳过去，没落点就起草一句话递进左栏对话。
                // 只报诊断不给下一步，人还得自己组织语言去问——那正是「看板」和「工作台」的区别。
                onStep: (row) => {
                  if (row?.target) {
                    setStepsOpen(false);
                    setChannel("article");
                    setScreen("article");
                    setSelected(row.target);
                    return;
                  }
                  setStepsOpen(false);
                  const label = String(article?.title || "这一篇").slice(0, 24);
                  const text = `【新媒体工作台】${label} · 第 ${String(row.no).padStart(2, "0")} 步「${row.label}」还差：${row.detail || "材料"}。请先只补这一步，别覆盖已有的内容。`;
                  bringToChat(text).then((result) => say(result.ok
                    ? "已把这一句带进左栏对话，按回车发出去"
                    : `没带过去：${result.reason}`));
                },
              })))
          : null,
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
     * 1. **我手上有多少活** —— 顶部计数条（草稿 / 已发布 / 空壳）
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
     * 真源仓库的 `03-scripts` 里。用户原话：「也看不见往期做的内容，
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
            "（指向你的内容仓库根目录），或在 settings.json 里填 pipelineRoot。",
            h("br"),
            "往期从那读；没配之前，工作台自己的库照常能用。视频期目录是另一回事，去「视频号」页单独指定。"));
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

    // ── 往期正文的安全渲染 ────────────────────────────────────────────────────
    /** 富文本白名单：只放行排版本体用得上的语义标签，其余一律当文本。 */
    const RICH_TAGS = new Set([
      "p", "br", "strong", "b", "em", "i", "u", "s", "h2", "h3", "h4",
      "ul", "ol", "li", "blockquote", "a", "img", "span", "code", "pre", "hr",
    ]);
    /** 空元素：没有闭合写法，重建时不要凭空补一个 `</br>`。 */
    const RICH_VOID = new Set(["br", "hr", "img"]);
    /** 每个标签允许留下的属性。`style` / `class` / `id` / `on*` 都不在表里，自然全丢。 */
    const RICH_ATTRS = { a: ["href"], img: ["src", "alt"] };
    /**
     * 链接只许这几种开头。`javascript:` / `vbscript:` / `data:` 不以它们开头，于是被丢。
     *
     * `\/(?!\/)` 是刻意排掉**协议相对**地址（`//evil.com/x`）：它其实是个外链，
     * 却长得像站内路径，一眼看不出会跳出站点。图片那边仍然放行（见 `SAFE_IMG`）——
     * 往期稿里的 CDN 图常写成 `//cdn…`，而图片是纯被动加载，不会导航。
     */
    const SAFE_LINK = /^(?:https?:\/\/|\/(?!\/)|#)/i;
    /** 图片额外允许内联的 `data:image/`（宿主把封面塞进正文时就是这种）与协议相对地址。 */
    const SAFE_IMG = /^(?:https?:\/\/|\/|#|data:image\/)/i;

    /** 文本转义：`&` 必须先转，否则后面转出来的 `&lt;` 会被自己再转一遍。 */
    const escapeText = (text) => String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

    /** 属性值转义：`&` 先、`"` 后；顺序反了 `&quot;` 会变成 `&amp;quot;`。 */
    const escapeAttr = (text) => String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;");

    /** 从标签里那段属性原文挑出白名单属性；没赋值的（`disabled`）或值不合法的一律丢。 */
    function richAttrs(tag, raw) {
      const allowed = RICH_ATTRS[tag] ?? [];
      if (!allowed.length || !raw) return "";
      const out = [];
      const re = /([a-zA-Z-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
      for (const m of String(raw).matchAll(re)) {
        const name = m[1].toLowerCase();
        if (!allowed.includes(name)) continue;
        const value = m[2] ?? m[3] ?? m[4] ?? "";
        // 只校验「地址类」属性；`alt` 是纯文本，不该按 URL 判
        if (name === "href" && !SAFE_LINK.test(value)) continue;
        if (name === "src" && !SAFE_IMG.test(value)) continue;
        out.push(`${name}="${escapeAttr(value)}"`);
      }
      return out.length ? ` ${out.join(" ")}` : "";
    }

    /**
     * 往期正文的安全渲染：**白名单重建**，不是黑名单清洗。
     *
     * 以前这里是三条正则（去 `<script>`、去 `on*=`、去 `javascript:`），实测全线漏：
     * `<img/src=x/onerror=alert(1)>`（属性之间不写空格）、`<a href="&#106;avascript:…">`（实体编码）、
     * `<iframe src=//evil>`、`<meta http-equiv=refresh>`、`<svg onload=…>` 全都能过。
     * 黑名单的毛病是「想不全就漏一个」，所以反过来：只放行认识的那二十个标签，
     * 不认识的整段**转义成看得见的原文**（不是悄悄删掉——用户得知道这里原来写了什么）。
     *
     * 三条实现约束：
     * 1. **不用 DOMParser / innerHTML**：这里要能在没有 DOM 的环境里跑（单测就是），
     *    而且「先让浏览器解析、再序列化回来」本身就把畸形标签的边界交给浏览器去猜了。
     * 2. 只用一条**形状合法**的标签正则认标签；认不出的 `<` 一律转成 `&lt;`，
     *    于是任何漏网的东西都退化成纯文本，不可能变成标记。
     * 3. 属性值输出前重新转义 `"` 与 `&`：否则一个引号就能从属性里逃出来，
     *    在标签里另起一个 `on…=`。
     *
     * @param {string} input 宿主导出的正文片段（来源是本地仓库，不可信）
     * @returns {string} 只含白名单标签的 HTML
     */
    function sanitizeRichHtml(input) {
      const text = String(input ?? "");
      // 每次新建正则：`/g` 带 lastIndex，模块级共用一个实例会被下一次调用从中间开始
      const shape = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g;
      const out = [];
      let last = 0;
      let match;
      while ((match = shape.exec(text)) !== null) {
        // 两个标签之间的内容一律当文本：这里的 `&`、`<` 都要转义
        out.push(escapeText(text.slice(last, match.index)));
        last = shape.lastIndex;
        const [, closing, rawName, rawAttrs, selfClosing] = match;
        const name = rawName.toLowerCase();
        // 不在白名单的标签：整段转义成可见原文。丢掉的话用户会以为这里本来就空着，
        // 反而看不出稿子里混进了怪东西
        if (!RICH_TAGS.has(name)) { out.push(escapeText(match[0])); continue; }
        if (closing) { if (!RICH_VOID.has(name)) out.push(`</${name}>`); continue; }
        const open = `<${name}${richAttrs(name, rawAttrs)}>`;
        // `<span/>` 在 HTML 里并不自闭合，原样留着会把后面的内容全吞进这个 span；
        // 补上闭合，语义等价于「一个空的 span」
        out.push(selfClosing && !RICH_VOID.has(name) ? `${open}</${name}>` : open);
      }
      out.push(escapeText(text.slice(last)));
      return out.join("");
    }

    /**
     * 往期单篇的只读预览：正文分节 + 排版 HTML。
     *
     * 两条约束都是实的：
     * - 正文常是 HTML 片段（模板稿就这么落盘），所以要 **同源** `dangerouslySetInnerHTML`：
     *   进去之前先过 `sanitizeRichHtml` 的白名单重建（不是防外人，是防「往期稿里带了一段能跑的东西」）；
     * - 排版件**原样**进 `sandbox=""`（全禁）的 iframe：样式生效、脚本不跑、表单不提交。
     *   这里**故意**不过 sanitizer——`<style>` 不在白名单里，会被整段转义成文本，
     *   「看排版」就变成看源码了。全禁的 sandbox 已经兜住这一层，不用再剥一次。
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

      const data = state.data;
      const sections = Array.isArray(data?.sections) ? data.sections : [];
      const html = String(data?.html ?? "");

      let body = null;
      if (state.loading) {
        body = h("div", { className: "gzs-hint", style: { padding: 18 } }, "读这篇…");
      } else if (state.error) {
        body = h("div", { className: "gzs-hint", style: { padding: 18 } }, `读不到：${state.error}`);
      } else if (mode === "html") {
        // 原样进 sandbox：这是**唯一**不 sanitize 的一处，理由见上面的注释（`<style>` 要留着）
        body = html
          ? h("iframe", { className: "gzs-repo__frame", title: "排版预览", sandbox: "", srcDoc: html })
          : h("div", { className: "gzs-hint", style: { padding: 18 } }, "这篇没有排版件（site/article.html）");
      } else {
        body = h("div", { className: "gzs-repo__body" },
          sections.length
            ? sections.map((section, index) => h("div", { key: `s-${index}` },
              String(section.heading ?? "").trim() ? h("h4", null, section.heading) : null,
              // 判据要认「<字母」，不能只认「含 `<`」：正文里写 `5 < 10` 会被当成 HTML 送去
              // 解析，`&lt;` 还被当实体，最后显示成一句被吃掉一半的话
              /<[a-zA-Z/]/.test(String(section.body ?? ""))
                ? h("div", { dangerouslySetInnerHTML: { __html: sanitizeRichHtml(section.body) } })
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
      // 「视频目录未配置」这块的两个动作：展开路径输入 / 正在提交 / 结果提示
      const [pickOpen, setPickOpen] = React.useState(false);
      const [pickPath, setPickPath] = React.useState("");
      const [setupBusy, setSetupBusy] = React.useState("");
      const [setupMsg, setSetupMsg] = React.useState({ kind: "", text: "" });

      /**
       * 视频目录的两个动作都走宿主：**先校验再落盘**（不存在 / 不是目录 / 没权限当场说清）。
       * 成功之后重新拉一次，空态自然消失——不需要用户手动刷新。
       */
      const runSetup = async (action, pathValue) => {
        setSetupBusy(action);
        setSetupMsg({ kind: "", text: "" });
        try {
          const result = await postJson(ROUTES.videoSetup, { action, ...(pathValue ? { path: pathValue } : {}) });
          setSetupMsg({
            kind: "ok",
            text: action === "create" ? `已建好：${result.root}` : `已指到：${result.root}`,
          });
          setPickOpen(false);
          setPickPath("");
          await reload();
        } catch (error) {
          setSetupMsg({ kind: "error", text: String(error?.message ?? error) });
        } finally {
          setSetupBusy("");
        }
      };

      const bringVideoPlan = () => {
        // 这段话是给**任何**装了这个插件的人用的，不是某家公司的内部流程：
        // 期目录在哪由用户定（可以是插件建的，也可以是自己指的），所以不写死
        // `07-video/episode`——让 Agent 不确定就先问。
        const plan = "【视频号】请帮我做下一期视频：先确认选题和期号，再依次产出大纲、口播稿、分镜、配音、分段、字幕、封面和成片。"
          + "期是目录：每期一个目录、目录名就是期号，放在视频期目录下面。"
          + "期目录在哪你不确定就先问我——面板「视频号」页顶上显示的就是当前读的那一个。"
          + "先告诉我你建议的期号和第一步。";
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
      // **显示宿主真的在扫的那个目录**（`/video` 回的 `root`），不在前端拼约定路径：
      // 期目录可以配（settings.episodesRoot），前端再拼一遍就等于显示一处、读另一处。
      const where = shortPath(feed.data?.root ?? "");
      // 排查类空态（目录不存在 / 读失败）要给人**完整路径**：这时候他正要去改配置，
      // 只看末两级（`07-video/episode`）没法判断配错在哪一层。
      const fullPath = String(feed.data?.root ?? "");

      const head = h("div", { className: "gzs-vhead" },
        h("div", null,
          h("div", { className: "gzs-vtitle" }, "视频号 · 期"),
          h("div", { className: "gzs-hint", style: { marginTop: 4 } },
            feed.loading ? "读期目录…"
              : feed.data ? `${where || "真源仓库"} · ${episodes.length} 期 · 只读`
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
                  : h("p", { className: "gzs-hint" }, `视频期读的是 ${where || "真源仓库里的期目录"}；面板不会改动那个目录。`),
                h("div", { className: "gzs-vempty__actions" },
                  h(Btn, { small: true, on: bringVideoPlan }, "带到对话"),
                  h(Btn, { small: true, kind: "ghost", on: reload }, "重试")))),
            h(VideoAside, { episodes: [], open: false, onPlan: bringVideoPlan, hint: chatHint })));
      }

      if (!feed.loading && feed.data && feed.data.exists === false) {
        /**
         * 仓库配了、但期目录不存在。该做的事和「目录是空的」完全不同：
         * 这里是**指个地方**，那里是**开工做第一期**。
         *
         * 文案口径（2026-11-09 作者定）：屏幕上不出现 `settings.json` / `GZH_STUDIO_EPISODES` /
         * `episodesRoot` 这些实现词，也不出现「不是坏了，是还没建」这种辩解句——
         * 用户只想知道两件事：**现在是什么状态**、**点哪儿能好**。
         * 所以只留两条路，各给一颗按钮：
         *   有素材 → 指出放各期的那一层目录；没素材 → 在仓库里建出约定目录。
         */
        const creating = setupBusy === "create";
        const picking = setupBusy === "path";
        return h("div", { className: "gzs-vboard" }, head,
          h("div", { className: "gzs-vempty gzs-vempty--start", style: { marginTop: 14, maxWidth: 760 } },
            h("b", null, "视频目录未配置"),
            h("p", null, "尚未指定视频期文件的存放位置，因此暂时读不到各期内容。"),
            h("p", { className: "gzs-vhint-strong" }, "先选一个目录，就能开始读期了："),
            h("ol", { className: "gzs-setup" },
              h("li", null,
                h("div", { className: "gzs-setup__t" }, "已经有素材"),
                h("div", { className: "gzs-setup__d" },
                  "指定**放各期的那一层目录**（里面每个子文件夹就是一期，文件夹名就是期号）。"),
                h("div", { className: "gzs-vempty__actions" },
                  h(Btn, {
                    small: true, kind: "primary",
                    disabled: Boolean(setupBusy),
                    on: () => { setPickOpen((open) => !open); setSetupMsg({ kind: "", text: "" }); },
                  }, pickOpen ? "先不选" : "选择视频目录"),
                  h(Btn, {
                    small: true, kind: "ghost",
                    disabled: Boolean(setupBusy),
                    on: () => reload(),
                  }, "重新读取")),
                pickOpen
                  ? h("div", { className: "gzs-setup__pick" },
                    h("input", {
                      className: "gzs-input gzs-mono",
                      placeholder: "粘贴文件夹的完整路径",
                      value: pickPath,
                      autoFocus: true,
                      onChange: (event) => setPickPath(event.target.value),
                      onKeyDown: (event) => { if (event.key === "Enter" && pickPath.trim()) runSetup("path", pickPath.trim()); },
                    }),
                    h("div", { className: "gzs-hint" },
                      "浏览器拿不到文件夹的真实路径，所以要粘贴：在资源管理器里选中文件夹 → Shift + 右键 → 「复制文件地址」，粘到这里（也可以直接打字）。"),
                    h("div", { className: "gzs-vempty__actions" },
                      h(Btn, {
                        small: true, kind: "primary",
                        disabled: picking || !pickPath.trim(),
                        on: () => runSetup("path", pickPath.trim()),
                      }, picking ? "正在确认…" : "用这个目录")))
                  : null),
              h("li", null,
                h("div", { className: "gzs-setup__t" }, "还没有素材"),
                h("div", { className: "gzs-setup__d" }, "暂无视频内容。建议先建好目录，再让 Agent 做第一期。"),
                h("div", { className: "gzs-vempty__actions" },
                  h(Btn, {
                    small: true, kind: "primary",
                    disabled: Boolean(setupBusy),
                    on: () => runSetup("create"),
                  }, creating ? "正在创建…" : "创建默认目录")),
                // 默认目录归**插件自己**（`<数据目录>/episodes`），不往用户的内容仓库里塞
                // `07-video` 这种编号目录——那是某套仓库的习惯，不是用户的。
                // 正文只说「插件自己的数据目录」，绝对路径放 title，需要核对的人悬停可见。
                h("div", {
                  className: "gzs-hint",
                  title: feed.data?.defaultDir ? `实际路径：${feed.data.defaultDir}` : "建在插件自己的数据目录下",
                }, "会建在插件自己的数据目录里，不动你的内容仓库（鼠标停在这里看完整路径）"))),
            setupMsg.text
              ? h("div", { className: `gzs-setup__msg gzs-setup__msg--${setupMsg.kind}` }, setupMsg.text)
              : null,
            // 八步照样摆出来：用户此刻最想知道的是「建好之后能看见什么」
            h("div", { className: "gzs-vempty__steps" },
              VIDEO_STEPS.map((step, index) => h("span", { key: step.key }, `${index + 1}. ${step.label}`))),
            h("div", { className: "gzs-vempty__actions" },
              h(Btn, { small: true, kind: "ghost", on: bringVideoPlan }, "带到对话，让它做第一期")),
            chatHint ? h("span", { className: "gzs-hint" }, chatHint) : null));
      }

      // 「没配仓库」那一屏已经并进上面的「视频目录未配置」：因为「创建默认目录」现在
      // 建在插件自己的数据目录里、**不需要任何仓库**，再单独给一屏讲环境变量只会让人多跳一次。

      if (!feed.loading && !episodes.length) {
        /**
         * 走到这里 = **有目录可读、但一期都还没有**（宿主回 `exists === true` 且 `episodes` 为空）。
         *
         * 作者 2026-11-09 明确要求：「期目录 07-video/episode 已经在盘上，只是里面还没有期」
         * 这句**不要写**。理由站得住：读的是哪个目录，页头已经写着（`07-video/episode · 0 期`），
         * 正文再复述一遍既啰嗦，又把「某个内部路径」抬到了正文里。
         * 所以正文只留一句「还没有期」+ 下一步该做什么。
         */
        return h("div", { className: "gzs-vboard" }, head,
          h("div", { className: "gzs-vsplit" },
            h("div", { className: "gzs-vlist" },
              h("div", { className: "gzs-vempty gzs-vempty--start" },
                h("b", null, "还没有期"),
                h("p", null, "在左侧对话里定下选题和期号，让它按八步往前做；每期一个目录、目录名就是期号，建好后这里会显示进度。"),
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
                h("p", null, `正在读 ${where || "期目录"} 里有哪些期。`))
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
          h("div", { className: "gzs-vaside__k" }, open ? "这一期已打开" : "还没选哪一期"),
          h("div", { className: "gzs-vaside__v" },
            open ? "左侧高亮的那一期，正文在右边往下看" : "在左边点一期，这里会显示它的解说文字、分镜、分段和字幕"),
          total
            ? h("div", { className: "gzs-vaside__stats" },
              h("span", null, h("b", null, String(total)), " 期"),
              h("span", null, h("b", null, String(complete)), " 期八件齐"),
              h("span", null, h("b", null, String(total - complete)), " 期在途"))
            : h("div", { className: "gzs-vaside__stats" }, h("span", null, "仓库里还没有视频期"))),

        h("div", { className: "gzs-vaside__card" },
          h("div", { className: "gzs-vaside__k" }, "还差几步"),
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
              : h("div", { className: "gzs-vaside__ok" }, "这一步该有的文件都齐了，可以去对话里确认成片与发布。"))
            : h("div", { className: "gzs-hint" }, "有了第一期之后，这里会按步骤显示还差哪些。")),

        h("div", { className: "gzs-vaside__card" },
          h("div", { className: "gzs-vaside__k" }, "生成在哪做"),
          // 作者 2026-11-09 要求删掉「看板只读盘：它显示 <路径> 里有什么，不替你生成」：
          // 这句既复述了页头已经写着的路径，又在对用户解释实现——他要的是「生成去哪做」。
          h("p", { className: "gzs-vaside__p" },
            "大纲、口播稿、分镜、配音、分段、字幕、封面、成片都由会话里的 agent 产出，写完刷新就能看见。"),
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
          h("div", { className: "gzs-eyebrow" }, "发布文案"),
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
     * 配图没齐、空壳、最近在改。每一条都**直接跳到那篇**，
     * 不让人先切筛选再自己找。
     */
    function TodayQueue({ list, counts, activity, onOpen, onFilter, onCreate }) {
      const cards = Array.isArray(list) ? list : [];
      const stat = counts ?? {};
      const empty = Number(stat.empty ?? 0);
      const empties = cards.filter((item) => item.empty);
      /**
       * 「配图没齐」要**排除正文还空着的**。
       *
       * 建稿时会先摆 N 个空段落，这时「段落数 > 配图数」永远成立，于是每一篇新稿
       * 都同时出现在「配图没齐」和「空壳」两格里——冒烟截图里就是「3 配图没齐 / 3 空壳」，
       * 而这三篇一个字都还没写。先有字才谈得上配图：空壳只进「空壳」那一格。
       */
      const lacking = cards.filter((item) => {
        if (item.empty) return false;
        const sections = Number(item.sections ?? 0);
        if (!sections) return false;
        const bodyImages = Number(item.images ?? 0) - (item.cover ? 1 : 0);
        return bodyImages < sections;
      });
      const recent = (Array.isArray(activity) ? activity : []).find((row) => row && row.id && row.event);
      const items = [
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
     * 内置示例稿：**用实物代替说明书**。
     *
     * 空库时讲一段「本工作台支持……」几乎没人看；让人点开一篇成品、看见排版、
     * 看见「必改 1 条 / 提案待确认 1 份 / 账本 5 条」，五秒就懂这东西产出的是什么。
     *
     * 硬约束：**不落库、不发任何写请求**。它就是一份静态数据，渲染时走和真稿
     * 同一套手机预览组件——所以看到的样子和真稿一致，不是另做一套假界面。
     * 这里刻意不带图：预览里的图片地址是按 id 拼接口路径的，示例 id 取不到图，
     * 画出来就是一片「图缺失」，比不带图更难看。
     */
    const EXAMPLE_VIEW = {
      article: {
        id: "example",
        title: "一家药企把审批从 14 天压到 3 天，靠的不是换系统",
        subtitle: "三个动作，其中一个只用了一周",
        template: "business",
        track: "medical",
        updatedAt: Date.now() - 1000 * 60 * 42,
        cover: { slot: "cover", current: "", versions: [] },
        sections: [
          { id: "s1", heading: "先说结论", body: "把审批从 14 天压到 3 天，靠的不是换掉 OA，而是把「谁在等谁」画了出来，然后砍掉了两处互相等人的环节。", image: { slot: "sec-s1", current: "", versions: [] } },
          { id: "s2", heading: "卡在哪：三个部门互相等", body: "流程里真正耗时的不是审批动作本身，而是「我的下一手在等人回消息」。\n\n画完线才发现：中间有 9 天是在等一个其实不需要他拍板的人点同意。", image: { slot: "sec-s2", current: "", versions: [] } },
          { id: "s3", heading: "动作一：把串行改成并行", body: "合规与财务本来可以同时看，之前却是排队的。改成并行之后，这两步加起来从 6 天变成 2 天。", image: { slot: "sec-s3", current: "", versions: [] } },
          { id: "s4", heading: "动作二：给「等待」设到期提醒", body: "不是催人，而是让「这件事卡在谁那儿、卡了几天」对所有人可见。这一条只花了一周就上线。", image: { slot: "sec-s4", current: "", versions: [] } },
          { id: "s5", heading: "动作三：删掉一次重复填报", body: "同一份物料信息在两个系统里各填一次，删掉之后单笔平均省 40 分钟。", image: { slot: "sec-s5", current: "", versions: [] } },
          { id: "s6", heading: "别急着上系统", body: "先画流程再谈工具。换系统往往把旧流程原样搬过去，等待还在，只是换了个界面等。", image: { slot: "sec-s6", current: "", versions: [] } },
        ],
      },
      qa: {
        ok: false,
        counts: { error: 1, warn: 1, info: 0 },
        items: [
          { level: "error", scope: "sec-s3", message: "「据行业报告」没有写来源：医疗类稿件里的数据要能追溯到原文", fix: "补一句出处，或删掉这个数字" },
          { level: "warn", scope: "article", message: "标题 25 字，公众号上限 32 字；转发到群里会显示不全", fix: "把「靠的不是换系统」挪到副标题" },
        ],
      },
      proposals: [
        { pid: "p-example01", status: "waiting-user", summary: "压短开头、补一处来源", changes: [{ target: "第 1 段" }, { target: "第 3 段" }] },
      ],
      ledger: [
        { type: "create", at: Date.now() - 1000 * 60 * 95, note: "新建文章，6 段" },
        { type: "script", at: Date.now() - 1000 * 60 * 80, note: "整篇落稿" },
        { type: "generate", at: Date.now() - 1000 * 60 * 55, note: "封面 v001（900×383）" },
        { type: "propose", at: Date.now() - 1000 * 60 * 30, note: "提案：压短开头、补一处来源" },
        { type: "export", at: Date.now() - 1000 * 60 * 12, note: "导出 HTML" },
      ],
    };

    /**
     * 示例稿整屏（只读）。看完给一条出口：开始我自己的第一篇。
     * @param {{templates?: Array, onClose: Function, onStart?: Function}} props
     */
    function ExampleSheet({ templates, onClose, onStart }) {
      const { article, qa, proposals, ledger } = EXAMPLE_VIEW;
      const LEVEL = { error: "必改", warn: "提醒", info: "提示" };
      return h("div", { className: "gzs-example" },
        h("div", { className: "gzs-example__head" },
          h("span", { className: "gzs-example__badge" }, "示例 · 只读"),
          h("span", { className: "gzs-hint" }, "内置的一篇成品，用来看清「一篇稿在面板里是什么样」。不进你的库，也不能改。"),
          h("span", { className: "gzs-grow" }),
          h(Btn, { small: true, kind: "ghost", on: onClose }, "返回"),
          h(Btn, { small: true, kind: "primary", on: onStart ?? onClose }, "开始我自己的第一篇")),
        h("div", { className: "gzs-example__body" },
          h("div", { className: "gzs-example__phone" },
            h(PhonePreview, { article, templates, selected: "sec-s1", onSelect: () => {}, busy: false })),
          h("div", { className: "gzs-example__side" },
            h("div", { className: "gzs-example__block" },
              h("div", { className: "gzs-example__k" }, `检查结果（必改 ${qa.counts.error} · 提醒 ${qa.counts.warn}）`),
              qa.items.map((item, index) => h("div", { key: index, className: "gzs-example__row" },
                h(Badge, { level: item.level }, LEVEL[item.level] ?? item.level),
                h("span", null, item.message)))),
            h("div", { className: "gzs-example__block" },
              h("div", { className: "gzs-example__k" }, `改稿提案（待确认 ${proposals.length} 份）`),
              proposals.map((item) => h("div", { key: item.pid, className: "gzs-example__row" },
                h(Badge, { level: "info" }, "待确认"),
                h("span", null, `${item.summary}（${item.changes.map((c) => c.target).join(" / ")}）`))),
              h("div", { className: "gzs-hint" }, "提案是「先看对照再确认」，点了同意才写进正文——这是 Agent 改稿和人工改稿的分界线。")),
            h("div", { className: "gzs-example__block" },
              h("div", { className: "gzs-example__k" }, `最近动作（账本 ${ledger.length} 条）`),
              ledger.map((item, index) => h("div", { key: index, className: "gzs-example__row" },
                h("span", { className: "gzs-example__t" }, timeText(item.at)),
                h("span", null, item.note)))))));
    }

    /**
     * 首屏（空库）。
     *
     * 口径：**不教配置，只给一句话和一个入口。**
     *
     * 上一版是「三步开始：新建一篇 / 配出图节点 / 连公众号」，三件事摆在同一个高度上。
     * 对一个刚装插件的人，他此刻只想验证「这东西能不能帮我写稿」；看见 AppID、
     * AppSecret、apiKeyEnv 只会让他先退出去。接管道是**用起来之后**才需要的事。
     *
     * 三个动作按重要性排：
     * 1. 一句话 → 填进原生对话（只填不发）：对话是唯一输入口，面板不自己再造一个编辑器；
     * 2. 示例 chips：给不知从何下手的人一个能改的起点；
     * 3. 「看看成品」：用实物代替说明书——一篇只读示例稿比三段文字有效得多。
     */
    function Welcome({ onCreate, onOpenExample, chatOpen = true, chatReady = true, onOpenChat, onGoVideo }) {
      const SEED = "帮我写一篇关于 ______ 的公众号稿，讲给 ______ 看。";
      const [seed, setSeed] = React.useState(SEED);
      const [hint, setHint] = React.useState("");
      /**
       * 点了「开始写」到字真的落进左栏输入框之间，有一段空窗（左栏刚展开、会话还在开会）。
       * 以前这段空窗里按钮毫无变化，用户的原话就是「点开始写根本没有反应」。
       * 所以先立刻回一句「正在往左栏填」，再等结果；失败时把原因和下一步一起给人话。
       */
      const [pending, setPending] = React.useState(false);
      const chips = [
        "把这段素材整理成一篇公众号稿",
        "帮我改这篇稿的开头，更具体一点",
        "给这篇稿出一张封面图",
      ];
      const send = (text) => {
        if (pending) return;
        setPending(true);
        setHint(chatOpen ? "正在把这句话填进左栏对话…" : "左栏对话收起了，先展开再填…");
        bringToChat(text).then((result) => {
          setPending(false);
          setHint(result.ok
            ? "已填进左栏对话——补完那两句，按回车发送（面板不替你按回车）。"
            : `没填进去：${result.reason}。可以直接在左栏对话里说，或点「让 AI 先给 3 个方向」。`);
        });
      };
      return h("div", { className: "gzs-welcome" },
        h("div", { className: "gzs-welcome__lead" }, "说一句话，它帮你从选题写到成稿"),
        h("div", { className: "gzs-welcome__sub" },
          "对话在左栏，结果落在这里：改标题、写正文、出配图和封面都在左栏说；这一页是看板——你有哪些稿、这篇卡在哪、下一步点什么。"),
        // 三条分工写死在这儿：不问「为什么右边不能打字」，因为「哪边做什么」本来就该先说清。
        h("div", { className: "gzs-welcome__flow" },
          h("span", null, h("b", null, "① 左栏说"), "一句大白话"),
          h("span", null, h("b", null, "② 右栏看"), "稿子和图自己长出来"),
          h("span", null, h("b", null, "③ 接着说"), "改哪一段都行")),
        !chatReady
          ? h("div", { className: "gzs-welcome__alert", role: "alert" },
            h("b", null, "左栏对话还没接上"),
            h("span", null, "它要先绑一个工作区才有输入框。点开左栏顶部的工作区下拉选一个，再回来点「开始写」。"))
          : null,
        h("div", { className: "gzs-welcome__seed" },
          h("textarea", {
            className: "gzs-area", rows: 2, value: seed, "aria-label": "第一句话",
            onChange: (event) => setSeed(event.target.value),
          }),
          h(Btn, { kind: "primary", disabled: pending, on: () => send(seed) }, pending ? "正在填…" : "开始写")),
        h("div", { className: "gzs-hint", style: { marginTop: 5 } },
          "把两条横线换成你的选题和读者。面板只把这句话「填进」左栏对话，按回车才发出去。"),
        h("div", { className: "gzs-welcome__chips" },
          chips.map((text) => h(Btn, { key: text, small: true, kind: "ghost", disabled: pending, on: () => send(text) }, text))),
        h("div", { className: "gzs-welcome__alt" },
          // 没有「从零自己填」了：标题、讲给谁、文案都是 AI 先给、人来选。
          // 点这颗 = 建一张空白稿 + 请它给三个方向（见 Workspace.onCreate）。
          h(Btn, { small: true, kind: "ghost", on: onCreate }, "让 AI 先给 3 个方向"),
          !chatOpen && typeof onOpenChat === "function"
            ? h(Btn, { small: true, kind: "ghost", on: onOpenChat }, "展开左栏对话")
            : null,
          h(Btn, { small: true, kind: "ghost", on: onOpenExample }, "看看一篇成品长什么样")),
        hint ? h("div", { className: "gzs-hint", style: { marginTop: 8 } }, hint) : null,
        h("div", { className: "gzs-welcome__more" },
          h("div", { className: "gzs-welcome__rows" },
            h("span", { className: "gzs-hint" },
              "出图会用这台机器已配置好的模型（id 里带 image 的，例如 gpt-image-2）；要换模型，在 DSH 的模型设置里改，不在这里配。"),
            // 首屏只讲公众号，是「我的视频面板呢」的另一半来源：功能在，但这一页一个字没提。
            typeof onGoVideo === "function"
              ? h(Btn, { small: true, kind: "ghost", on: onGoVideo }, "也能做视频号：八步从大纲到成片 →")
              : null)));
    }

    function VideoEpisode({ id, onClose, refreshKey = 0, tab: tabProp, onTab } = {}) {
      const [state, setState] = React.useState({ loading: true, refreshing: false, error: "", data: null, status: 0 });
      const [localTab, setLocalTab] = React.useState("");
      const tab = tabProp ?? localTab;
      const setTab = onTab ?? setLocalTab;
      const [chatHint, setChatHint] = React.useState("");

      const bringEpisodePlan = () => {
        const plan = `【视频号 · ${id}】请继续做这一期视频。先检查并补齐缺的八步：大纲、口播稿、分镜、配音、分段、字幕、封面、成片；先告诉我当前缺口和下一步，不要直接覆盖已有文件。`;
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

    function Home({ list, root, onOpen, onCreate, activity, counts, filters, matched, onFilter, busy, tracks, templates, onOpenExample,
      chatOpen = true, chatReady = true, onOpenChat, onGoVideo }) {
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
        filterWords.push({ draft: "草稿", published: "已发布" }[cur.state] ?? cur.state);
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
                      // 比段数图数更该被先看到。人标的加「手」字标记，和默认值区分开。
                      a.lifecycle?.value
                        ? h("span", {
                          className: `gzs-card__life gzs-card__life--${a.lifecycle.value}`,
                          title: a.lifecycle.source === "manual" ? "你自己标的" : "没标过，默认算草稿",
                        }, `${{ draft: "草稿", published: "已发布" }[a.lifecycle.value] ?? a.lifecycle.value}${a.lifecycle.source === "manual" ? "·手" : ""}`)
                        : null,
                      // 赛道：一眼看出这篇按哪套口径写的（医疗和职场不能同一套说法）
                      a.track
                        ? h("span", { className: "gzs-card__track", title: `内容类型：${trackName(a.track)}` }, trackName(a.track))
                        : null,
                      h("span", null, a.empty ? "空壳" : `${a.sections ?? 0} 段 · ${a.words ?? 0} 字`),
                      h("span", null, `${a.images ?? 0} 图`),
                      // 模板显示中文名：卡片上写「business」是给开发看的，用户认的是「商务简报」。
                      a.template ? h("span", null, templateName(templates, a.template)) : null,
                      h("span", null, timeText(a.updatedAt)))));
              }),
              h("button", { className: "gzs-card gzs-card--new", onClick: onCreate }, "＋ 新建一篇"))
            : (stat.total ?? 0) === 0
              // 空库：一句话入口（不教配置）。见 Welcome 的注释。
              ? h("div", { className: "gzs-blank" },
                h("b", null, "还没有任何文章"),
                h("p", null, "不用先想清楚全部——标题、段落、配图后面都能改。"),
                h(Welcome, {
                  onCreate,
                  onOpenExample: () => onOpenExample?.(),
                  chatOpen,
                  chatReady,
                  onOpenChat,
                  onGoVideo,
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
      /**
       * 等着被释放的引用（先卸下 UI，再 release）。
       *
       * 2026-11-07 实测抓到的一条：切内容线（公众号 → 视频号 → 公众号）时控制台抛
       * `Error: Session reference "..." is released`，来源是宿主在**读一个已经释放的引用**
       * ——我们 release 的那一刻，`SessionProvider` 还挂在树上。旧代码注释里记的那次
       * 「面板整块消失」也是同一个病。
       *
       * 所以改成两步：换条件时先把 `reference` 置空（宿主把对话卸掉），
       * 等这次渲染过去，再真正 `release()`。释放晚一拍没有代价，早一拍就会崩。
       */
      const retiringRef = React.useRef([]);
      const flushRetired = React.useCallback(() => {
        const list = retiringRef.current;
        retiringRef.current = [];
        for (const item of list) {
          try { item?.release?.(); } catch { /* 已经放掉了 */ }
        }
      }, []);
      /** 把当前按住的引用挪进待释放队列，**不立即 release**。 */
      const retireHeld = React.useCallback(() => {
        if (heldRef.current) retiringRef.current.push(heldRef.current);
        heldRef.current = null;
        tagRef.current = null;
      }, []);
      const dropHeld = React.useCallback(() => {
        try { heldRef.current?.release?.(); } catch { /* 已经放掉了 */ }
        heldRef.current = null;
        tagRef.current = null;
        flushRetired();
      }, [flushRetired]);
      // 面板卸载才释放引用（依赖为空：dropHeld 的 identity 稳定）
      React.useEffect(() => () => dropHeld(), [dropHeld]);
      // 对话已经从 DOM 上卸下来了，这时候再放才安全。见 retiringRef 的注释。
      React.useEffect(() => {
        if (reference === null) flushRetired();
      }, [reference, flushRetired]);

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
        // 条件变了（换了线 / 换了仓根 / 换了工作区 / 点了重开）→ 旧的引用作废。
        // 顺序必须是「先让 UI 卸下 -> 等渲染 -> 再 release」，见 retiringRef 的注释。
        if (tagRef.current !== null && tagRef.current !== tag) {
          setReference(null);
          retireHeld();
        }
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
        // 同样是「先卸下、后释放」：重开时 SessionProvider 还挂着旧引用，
        // 一 release 宿主就会读到已释放的引用（见 retiringRef 的注释）。
        setReference(null);
        retireHeld();
        setProblem(null);
        setNonce((value) => value + 1);
      }, [line, retireHeld]);
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
      const { reference, problem, onReset, onClose, running, SessionProvider, renderSlot, label,
        workspaces = [], workspaceId = null, onPickWorkspace } = props;
      const ready = typeof SessionProvider === "function" && typeof renderSlot === "function";
      // 只有一条可选时不必给选择器：一个只能点的、只有一个选项的下拉比没有更糟。
      // 「默认工作区」在宿主里的 title 是 id（default-workspace），下拉里得说人话。
      const wsLabel = (ws) => {
        if (!ws) return "";
        if (ws.workspaceId === "default-workspace") return "默认工作区";
        return String(ws.title || ws.path || ws.workspaceId);
      };
      const picker = workspaces.length > 1
        ? h("select", {
          className: "gzs-chatws",
          title: "这条对话绑哪个工作区（= 对话的工作目录）。换一个就等于换一个上下文。",
          value: workspaceId ?? "",
          onChange: (event) => onPickWorkspace?.(event.target.value),
        }, workspaces.map((ws) => h("option", { key: ws.workspaceId, value: ws.workspaceId }, wsLabel(ws))))
        : null;
      return h("div", { className: "gzs-chatdock" },
        h("div", { className: "gzs-chatcol__bar" },
          h("span", { className: "gzs-chatcol__t" }, "DSH 原生对话"),
          picker,
          h("span", { className: "gzs-chatcol__ctx", title: label }, label),
          running
            ? h("span", { className: "gzs-chatrun" }, h("span", { className: "gzs-chatdot" }), "在跑")
            : h("span", { className: "gzs-chatcol__s" }, "在这里说 · 右边看板"),
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
      const want = body.replace(/\s+/g, "");
      /**
       * 已经在了就别再塞一遍——但要比**整句话**，不能只比开头八个字。
       *
       * 踩过（0.3.2 验收）：所有面板递话都以「【新媒体工作台】」开头，只比前 8 个字的话，
       * 输入框里已经有上一条时，新的一条会被判成"已经在了"，点了没反应。
       */
      const already = () => String(host.textContent ?? "").replace(/\s+/g, "").includes(want);
      const lands = () => already();
      if (already()) return { ok: true, via: "already" };
      try { host.focus(); } catch { /* 焦点拿不到也继续试 */ }

      /**
       * ① execCommand：Chrome 下触发 beforeinput，编辑器按正常打字处理（带撤销栈）。
       *
       * **不再同步复核**。踩过的坑：Lexical 的 DOM 是下一拍才更新的，`execCommand`
       * 返回 true 之后立刻读 `textContent` 还是旧值 → 复核判失败 → 外层 500ms 重试
       * 再插一遍 → 最后输入框里是同一句话连了三遍。execCommand 返回 true 就是
       * "命令执行了、文档被改了"，这个语义够用；宁可少一次复核，也不要三份稿子。
       */
      try { if (document.execCommand("insertText", false, body)) return { ok: true, via: "execCommand" }; } catch { /* 往下试 */ }
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
    exports.PhonePane = PhonePane;
    exports.Outline = Outline;
    exports.Inspector = Inspector;
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
    exports.ExportMenu = ExportMenu;
    exports.GateList = GateList;
    exports.ImageBoard = ImageBoard;
    exports.STEP_NAMES = STEP_NAMES;
    exports.STEP_WORD = STEP_WORD;
    exports.OpinionComposer = OpinionComposer;
    exports.RepoSection = RepoSection;
    exports.RepoPreview = RepoPreview;
    // 往期正文的白名单重建：**纯字符串**，不需要 DOM，`verify/sanitize-unit.mjs` 直接调它
    exports.sanitizeRichHtml = sanitizeRichHtml;
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
    exports.Welcome = Welcome;
    exports.StepsBoard = StepsBoard;
    exports.ExampleSheet = ExampleSheet;
    exports.EXAMPLE_VIEW = EXAMPLE_VIEW;
    exports.TodayQueue = TodayQueue;
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




















