/**
 * 公众号草稿箱推送（**直连微信**，网关位预留）。
 *
 * 这一层只做「跟微信说话」：拿 token、传图、建草稿、把错误码翻成人话。
 * 文章怎么渲染、图从哪个版本取、账本怎么记，都在宿主 `index.js` 里——
 * 那边有 store 和 render，这边只管协议。
 *
 * 四个踩点，都是硬的：
 *
 * 1. **正文图必须走 `media/uploadimg`**。微信在 `draft/add` 里会过滤外部图片 URL，
 *    直接塞本地地址或 CDN 地址，草稿里就是一片空白。
 * 2. **封面必须是永久素材的 media_id**（`material/add_material?type=image`），
 *    传成正文图的 URL 会回 `40007`。
 * 3. **正文上限 2 万字符 / 1 MB**，标题 32 字、摘要 128 字。超了微信不给你讲道理，
 *    所以推之前自己先量一遍（`checkDraft`）。
 * 4. **出口 IP 必须加白名单**（`40164`）。家庭宽带的 IP 会变，所以错误里要把
 *    微信报的那个 IP 抠出来给用户，让他能直接复制去后台加。
 *
 * token 用 `stable_token`（普通模式），缓存 7200 秒、提前 5 分钟失效；
 * 遇到 `40001/42001/40014` 才强制刷新一次，避免两台机器互相顶掉。
 * @module lib/wechat
 */

import { readFile, writeFile, mkdir, chmod, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

/** 默认 API 根（网关模式会盖掉它）。 */
export const DEFAULT_BASE = "https://api.weixin.qq.com";
/** 配置文件（与 settings.json 分开：里面有 AppSecret，不该混进出图节点那份）。 */
export const CONFIG_FILE = "wechat.json";
/** token 缓存文件。 */
export const TOKEN_FILE = "wechat-token.json";

/** 接口限额。数字来自微信文档，不要拍脑袋改。 */
export const LIMITS = {
  title: 32,
  author: 16,
  digest: 128,
  contentChars: 20000,
  contentBytes: 1024 * 1024,
  imageBytes: 10 * 1024 * 1024,
  uploadImgBytes: 2 * 1024 * 1024,
};

/** 错误码 → 一句能照着做的事。 */
const ERROR_TEXT = {
  40001: "access_token 失效，正在强制刷新后再试",
  40003: "AppID 不对：检查公众号后台「设置与开发 → 基本配置」里的 AppID",
  40007: "封面 media_id 不合法：封面必须先用永久素材接口上传",
  40125: "AppSecret 不对：去公众号后台重置 AppSecret 后再填",
  40164: "出口 IP 不在白名单：把下面这个 IP 加进「基本配置 → IP 白名单」",
  41001: "缺少 access_token，重新保存一次公众号配置再推",
  42001: "access_token 过期，正在刷新后再试",
  45009: "接口调用次数超限：今天先别推了，明天再试",
  48001: "这个接口当前账号没有权限：多半是公众号未认证，或该接口不在权限集里",
  53401: "内容触发平台审核拦截：按返回里的 fail_idx 改那一条再推",
  53402: "内容触发平台审核拦截：按返回里的 fail_idx 改那一条再推",
};

/** 推送侧的错误：带错误码、可复制的 IP、下一步怎么做。 */
export class WeChatError extends Error {
  constructor(message, { code = 0, ip = "", hint = "", detail = "" } = {}) {
    super(message);
    this.name = "WeChatError";
    this.code = code;
    this.ip = ip;
    this.hint = hint;
    this.detail = detail;
  }
}

/**
 * 把微信的错误码翻成人话。
 *
 * `errmsg` 里的 IP 要抠出来：`invalid ip 1.2.3.4, not in whitelist`。
 * 不抠的话用户只知道「IP 不对」，却不知道是哪个 IP。
 * @param {number} code
 * @param {string} errmsg
 */
export function humanError(code, errmsg = "") {
  const numeric = Number(code) || 0;
  const text = ERROR_TEXT[numeric] ?? `微信返回错误 ${numeric || "未知"}：${errmsg || "没有说明"}`;
  const ip = /invalid ip\s+([0-9a-f.:]+)/i.exec(String(errmsg))?.[1] ?? "";
  return { code: numeric, message: text, hint: errmsg ? `微信原文：${errmsg}` : "", ip };
}

/** AppID 掩码：面板上不该整串显示。 */
export function maskAppId(appId) {
  const value = String(appId ?? "");
  if (value.length <= 10) return value ? `${value.slice(0, 3)}…` : "";
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/**
 * 配置归一化。**环境变量优先**：不想把 Secret 落盘的人可以用
 * `GZH_WECHAT_APPID` / `GZH_WECHAT_SECRET` 覆盖文件里的值。
 * @param {object} fileConfig
 * @param {Record<string, string|undefined>} [env]
 */
export function configOf(fileConfig = {}, env = process.env) {
  const appId = String(env?.GZH_WECHAT_APPID ?? fileConfig?.appId ?? "").trim();
  const appSecret = String(env?.GZH_WECHAT_SECRET ?? fileConfig?.appSecret ?? "").trim();
  const mode = fileConfig?.mode === "gateway" ? "gateway" : "direct";
  const baseURL = String(fileConfig?.baseURL || DEFAULT_BASE).replace(/\/+$/, "");
  const gateway = {
    baseURL: String(fileConfig?.gateway?.baseURL ?? "").replace(/\/+$/, ""),
    token: String(fileConfig?.gateway?.token ?? ""),
  };
  return {
    appId,
    appSecret,
    mode,
    baseURL,
    gateway,
    author: String(fileConfig?.author ?? "").slice(0, LIMITS.author),
    configured: Boolean(appId && appSecret),
    // 网关模式下插件不持密钥：密钥在网关那边，这里只要求网关地址。
    usable: mode === "gateway" ? Boolean(gateway.baseURL) : Boolean(appId && appSecret),
  };
}

/**
 * 推之前的自查：标题 / 摘要 / 正文三样都按微信的限额量一遍。
 * **返回问题清单而不是抛错**：面板要一次把三个问题都显示出来，让人一趟改完。
 * @param {{title?: string, digest?: string, content?: string}} payload
 */
export function checkDraft({ title = "", digest = "", content = "" } = {}) {
  const problems = [];
  const stats = {
    title: [...String(title)].length,
    digest: [...String(digest)].length,
    contentChars: String(content).length,
    contentBytes: Buffer.byteLength(String(content), "utf8"),
  };
  if (!String(title).trim()) problems.push({ field: "title", message: "标题是空的" });
  else if (stats.title > LIMITS.title) problems.push({ field: "title", message: `标题 ${stats.title} 字，公众号上限 ${LIMITS.title} 字` });
  if (stats.digest > LIMITS.digest) problems.push({ field: "digest", message: `摘要 ${stats.digest} 字，公众号上限 ${LIMITS.digest} 字` });
  if (stats.contentChars > LIMITS.contentChars) problems.push({ field: "content", message: `正文 ${stats.contentChars} 字符，公众号上限 ${LIMITS.contentChars}` });
  if (stats.contentBytes > LIMITS.contentBytes) problems.push({ field: "content", message: `正文 ${Math.round(stats.contentBytes / 1024)} KB，公众号上限 1 MB` });
  return { ok: problems.length === 0, problems, stats };
}

/**
 * 组一份 multipart 请求体（不引依赖）。
 *
 * 文件名固定成 ASCII：微信对中文文件名偶尔会回「不合法的文件类型」，
 * 而我们本来也不靠文件名区分图片。
 * @param {string} filename
 * @param {string} contentType
 * @param {Buffer} buffer
 */
export function buildMultipart(filename, contentType, buffer) {
  const boundary = `----gzhstudio${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
  const head = Buffer.from(
    `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="media"; filename="${filename}"\r\n`
    + `Content-Type: ${contentType}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return { body: Buffer.concat([head, buffer, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** 把正文里的占位符换掉（一次替换全部出现处）。 */
export function replacePlaceholders(html, replacements = {}) {
  let out = String(html);
  for (const [placeholder, url] of Object.entries(replacements)) {
    if (!placeholder || !url) continue;
    out = out.split(placeholder).join(url);
  }
  return out;
}

/** 读 JSON 响应；不是 JSON 就抛一句能看懂的话（网关回 HTML 错误页时最常见）。 */
async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new WeChatError(`接口返回的不是 JSON（HTTP ${response.status}）`, {
      detail: text.slice(0, 300),
      hint: "多半是网关地址写错，或中间有反向代理回了错误页",
    });
  }
}

/**
 * 客户端。`root` 是插件数据目录（配置与 token 都落这儿），
 * `fetchImpl` 可注入，测试拿本地假服务器跑整条链路。
 * @param {{root: string, fetchImpl?: typeof fetch, env?: Record<string,string|undefined>, logger?: object}} options
 */
export function createClient({ root, fetchImpl = globalThis.fetch, env = process.env, logger = {} } = {}) {
  const configFile = join(root, CONFIG_FILE);
  const tokenFile = join(root, TOKEN_FILE);

  /** 内存里的 token 缓存（落盘是为了重启后不用再换一次）。 */
  let cache = null;

  /**
   * 请求超时：微信/网关不响应时不能无限挂着。
   *
   * 以前四个 `fetchImpl(...)` 都没有 signal：一次推送卡住，`/api/gzh-studio.push`
   * 就永远不返回，浏览器一直转圈，宿主侧还占着连接与内存。
   * 上传类放宽到 60 秒（封面可能几 MB、家宽上行慢）。
   */
  const TIMEOUT_DEFAULT_MS = 15_000;
  const TIMEOUT_UPLOAD_MS = 60_000;

  async function timedFetch(url, init = {}, timeoutMs = TIMEOUT_DEFAULT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new WeChatError(`${Math.round(timeoutMs / 1000)} 秒没有响应，已放弃这次请求`, {
          hint: "多半是网络或代理卡住；过一会儿重试，或先点一次「推前自查」确认本地没问题",
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 原子 + 私有权限地写一个 JSON 文件。
   *
   * `wechat.json` 里是 AppSecret，`wechat-token.json` 里是 access_token：
   * 直接 `writeFile` 一旦断电就是半截 JSON，`readFileConfig` 吞掉解析异常返回 `{}`，
   * 用户的凭据会**一声不响地全丢**；token 那份以前还漏了 chmod。
   */
  async function writePrivateJson(file, value) {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      await chmod(tmp, 0o600).catch(() => { /* Windows 上不生效 */ });
      await rename(tmp, file);
      await chmod(file, 0o600).catch(() => { /* 同上 */ });
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function readFileConfig() {
    try {
      const raw = JSON.parse(await readFile(configFile, "utf8"));
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  }

  async function config() {
    return configOf(await readFileConfig(), env);
  }

  async function writeConfig(patch = {}) {
    const current = await readFileConfig();
    const next = {
      ...current,
      appId: String(patch.appId ?? current.appId ?? "").trim(),
      appSecret: String(patch.appSecret ?? current.appSecret ?? "").trim(),
      author: String(patch.author ?? current.author ?? "").slice(0, LIMITS.author),
      mode: patch.mode === "gateway" || (patch.mode === undefined && current.mode === "gateway") ? "gateway" : "direct",
      gateway: {
        baseURL: String(patch.gateway?.baseURL ?? current.gateway?.baseURL ?? "").trim(),
        token: String(patch.gateway?.token ?? current.gateway?.token ?? "").trim(),
      },
      updatedAt: Date.now(),
    };
    // appSecret 用 `??`：不传就保留原值（面板回填的是掩码，不是密钥），
    // 传空串才是明确「清掉」。
    if (patch.appSecret === undefined && current.appSecret) next.appSecret = current.appSecret;
    await writePrivateJson(configFile, next);
    cache = null;
    return next;
  }

  /** 状态：面板用它在按钮旁边说清「能不能推、还差什么」。 */
  async function status() {
    const cfg = await config();
    return {
      configured: cfg.configured,
      usable: cfg.usable,
      mode: cfg.mode,
      appId: maskAppId(cfg.appId),
      hasSecret: Boolean(cfg.appSecret),
      author: cfg.author,
      gateway: { baseURL: cfg.gateway.baseURL, hasToken: Boolean(cfg.gateway.token) },
      limits: LIMITS,
      token: cache ? { cached: true, expiresAt: cache.expiresAt } : { cached: false, expiresAt: 0 },
    };
  }

  function baseFor(cfg) {
    if (cfg.mode === "gateway") {
      if (!cfg.gateway.baseURL) throw new WeChatError("网关模式还没配地址", { hint: "在公众号设置里填网关 baseURL，或切回直连" });
      return cfg.gateway.baseURL;
    }
    return cfg.baseURL;
  }

  async function loadCachedToken(cfg) {
    if (cache && cache.appId === cfg.appId && cache.expiresAt > Date.now() + 60_000) return cache;
    try {
      const raw = JSON.parse(await readFile(tokenFile, "utf8"));
      if (raw?.token && raw.appId === cfg.appId && Number(raw.expiresAt) > Date.now() + 60_000) {
        cache = { token: raw.token, expiresAt: Number(raw.expiresAt), appId: cfg.appId };
        return cache;
      }
    } catch { /* 没缓存过 / 文件坏了：重新换一个 */ }
    return null;
  }

  async function fetchToken(cfg, { force = false } = {}) {
    const response = await timedFetch(`${baseFor(cfg)}/cgi-bin/stable_token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "client_credential", appid: cfg.appId, secret: cfg.appSecret, force_refresh: force }),
    }).catch((error) => {
      if (error instanceof WeChatError) throw error; // 超时已经是人话了，别再包一层
      throw new WeChatError("连不上微信接口", { hint: "检查网络 / 代理；企业网络常拦 api.weixin.qq.com", detail: String(error?.message ?? error) });
    });
    const data = await readJson(response);
    if (data.errcode) {
      const human = humanError(data.errcode, data.errmsg);
      throw new WeChatError(human.message, human);
    }
    if (!data.access_token) throw new WeChatError("微信没有返回 access_token", { detail: JSON.stringify(data).slice(0, 300) });
    const expiresAt = Date.now() + Math.max(60, Number(data.expires_in) || 7200) * 1000 - 5 * 60 * 1000;
    cache = { token: data.access_token, expiresAt, appId: cfg.appId };
    try {
      await writePrivateJson(tokenFile, { ...cache, savedAt: Date.now() });
    } catch { /* 落不了盘不影响本次推送 */ }
    return cache.token;
  }

  async function token({ force = false } = {}) {
    const cfg = await config();
    if (cfg.mode === "direct" && !cfg.configured) {
      throw new WeChatError("还没配公众号", { hint: "先填 AppID 和 AppSecret（或在环境变量里给 GZH_WECHAT_APPID / GZH_WECHAT_SECRET）" });
    }
    if (cfg.mode === "gateway") return cfg.gateway.token;
    const cached = force ? null : await loadCachedToken(cfg);
    if (cached) return cached.token;
    return fetchToken(cfg, { force });
  }

  /** 带 token 调一次；token 失效（40001/42001/40014）时强制刷新重试一次。 */
  async function withToken(run) {
    let current = await token();
    try {
      return await run(current);
    } catch (error) {
      const code = Number(error?.code) || 0;
      if (code === 40001 || code === 42001 || code === 40014) {
        const fresh = await token({ force: true });
        return await run(fresh);
      }
      throw error;
    }
  }

  function authHeaders(cfg) {
    return cfg.mode === "gateway" && cfg.gateway.token ? { authorization: `Bearer ${cfg.gateway.token}` } : {};
  }

  /** 正文图：返回可直接放进 `<img src>` 的 URL。 */
  async function uploadContentImage(buffer, { filename = "image.png", mime = "image/png" } = {}) {
    if (!buffer?.length) throw new WeChatError("图片是空的");
    if (buffer.length > LIMITS.uploadImgBytes) {
      throw new WeChatError(`图片 ${Math.round(buffer.length / 1024)} KB，正文图上限 ${Math.round(LIMITS.uploadImgBytes / 1024)} KB`, { hint: "换一张小一点的（正文图会按屏幕宽度显示，不需要大图）" });
    }
    const cfg = await config();
    const form = buildMultipart(filename, mime, buffer);
    return withToken(async (accessToken) => {
      const response = await timedFetch(`${baseFor(cfg)}/cgi-bin/media/uploadimg?access_token=${encodeURIComponent(accessToken)}`, {
        method: "POST",
        headers: { "content-type": form.contentType, ...authHeaders(cfg) },
        body: form.body,
      }, TIMEOUT_UPLOAD_MS).catch((error) => {
        if (error instanceof WeChatError) throw error;
        throw new WeChatError("上传正文图失败", { detail: String(error?.message ?? error) });
      });
      const data = await readJson(response);
      if (data.errcode) {
        const human = humanError(data.errcode, data.errmsg);
        throw new WeChatError(human.message, human);
      }
      const url = String(data.url ?? "");
      if (!url) throw new WeChatError("上传正文图没有返回 URL", { detail: JSON.stringify(data).slice(0, 300) });
      return url;
    });
  }

  /** 封面：返回 { mediaId, url }（url 也来自 mmbiz，可以放正文当首图）。 */
  async function uploadThumb(buffer, { filename = "cover.png", mime = "image/png" } = {}) {
    if (!buffer?.length) throw new WeChatError("封面是空的");
    if (buffer.length > LIMITS.imageBytes) {
      throw new WeChatError(`封面 ${Math.round(buffer.length / 1024 / 1024 * 10) / 10} MB，上限 10 MB`, { hint: "先压一下再推" });
    }
    const cfg = await config();
    const form = buildMultipart(filename, mime, buffer);
    return withToken(async (accessToken) => {
      const response = await timedFetch(`${baseFor(cfg)}/cgi-bin/material/add_material?access_token=${encodeURIComponent(accessToken)}&type=image`, {
        method: "POST",
        headers: { "content-type": form.contentType, ...authHeaders(cfg) },
        body: form.body,
      }, TIMEOUT_UPLOAD_MS).catch((error) => {
        if (error instanceof WeChatError) throw error;
        throw new WeChatError("上传封面失败", { detail: String(error?.message ?? error) });
      });
      const data = await readJson(response);
      if (data.errcode) {
        const human = humanError(data.errcode, data.errmsg);
        throw new WeChatError(human.message, human);
      }
      const mediaId = String(data.media_id ?? "");
      if (!mediaId) throw new WeChatError("上传封面没有返回 media_id", { detail: JSON.stringify(data).slice(0, 300) });
      return { mediaId, url: String(data.url ?? "") };
    });
  }

  /** 建草稿：返回 media_id（草稿箱里的那一条）。 */
  async function addDraft({ title, author = "", digest = "", content, thumbMediaId, sourceUrl = "", needOpenComment = 0, onlyFansCanComment = 0 }) {
    if (!thumbMediaId) throw new WeChatError("缺封面 media_id：公众号图文草稿必须有封面");
    const cfg = await config();
    const payload = {
      articles: [{
        article_type: "news",
        title,
        author: String(author ?? "").slice(0, LIMITS.author),
        digest,
        content,
        content_source_url: sourceUrl,
        thumb_media_id: thumbMediaId,
        need_open_comment: needOpenComment ? 1 : 0,
        only_fans_can_comment: onlyFansCanComment ? 1 : 0,
      }],
    };
    return withToken(async (accessToken) => {
      const response = await timedFetch(`${baseFor(cfg)}/cgi-bin/draft/add?access_token=${encodeURIComponent(accessToken)}`, {
        method: "POST",
        // 中文不能转义成 \uXXXX 再发：微信文档明确要求「请将 \uXXXX 格式的编码转换为实际字符后再输入」。
        headers: { "content-type": "application/json; charset=utf-8", ...authHeaders(cfg) },
        body: JSON.stringify(payload),
      }).catch((error) => {
        if (error instanceof WeChatError) throw error;
        throw new WeChatError("建草稿失败（网络层）", { detail: String(error?.message ?? error) });
      });
      const data = await readJson(response);
      if (data.errcode) {
        const human = humanError(data.errcode, data.errmsg);
        throw new WeChatError(human.message, human);
      }
      const mediaId = String(data.media_id ?? "");
      if (!mediaId) throw new WeChatError("建草稿没有返回 media_id", { detail: JSON.stringify(data).slice(0, 300) });
      logger?.info?.(`wechat: draft added ${mediaId}`);
      return mediaId;
    });
  }

  return {
    config,
    status,
    writeConfig,
    token,
    uploadContentImage,
    uploadThumb,
    addDraft,
    files: { configFile, tokenFile },
    /** 测试用：清掉内存缓存。 */
    _resetCache: () => { cache = null; },
  };
}
