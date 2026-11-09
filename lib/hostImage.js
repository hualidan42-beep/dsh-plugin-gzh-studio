/**
 * 出图：借**宿主已经配好的模型**，不向用户要 key。
 *
 * 为什么改：0.2.x 让用户在自己的配置里填 `baseURL` + `apiKeyEnv`，本质是把
 * 「接一个生图服务」的活推给写稿的人——而且那条路一旦被滥用，就是「把宿主进程里
 * 任意环境变量当 Bearer 发出去」。DSH 自己已经有模型目录（`ctx.llm`），
 * 用户也已经为它配好了 key，插件只需要**借用**，不需要再问一遍。
 *
 * 实测（本机网关 / gpt-image-2，走 openai-completions）：
 * 图片是以 markdown data URI 放在文本里的——
 *
 * ```
 * ![image](data:image/png;base64,iVBORw0KGgo...)
 * ```
 *
 * 所以这里做的事情是：调一次模型 → 从文本里抠出 data URI（或裸链接）→ 解码成字节。
 * 不解析 prompt 结构、不依赖模型返回 JSON，因为这些都随供应商变。
 * @module lib/hostImage
 */

/** 文本里可能的图片形态：data URI 优先，其次 http(s) 链接。 */
const DATA_URI = /data:image\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]{32,})/i;
const HTTP_URL = /https?:\/\/[^\s)"'<>]+\.(?:png|jpe?g|webp|gif)(?:\?[^\s)"'<>]*)?/i;

const MIME_BY_EXT = {
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
};

/**
 * 从模型返回的文本里取出图片。
 *
 * @param {string} text
 * @returns {{kind: "base64"|"url", mime: string, base64?: string, url?: string}|null}
 */
export function extractImage(text) {
  const body = String(text ?? "");
  const data = DATA_URI.exec(body);
  if (data) {
    const subtype = String(data[1]).toLowerCase();
    // `svg+xml` 这种带加号的子类型要还原成合法 mime
    const mime = `image/${subtype}`;
    return { kind: "base64", mime, base64: data[2].replace(/\s+/g, "") };
  }
  const url = HTTP_URL.exec(body);
  if (url) {
    const ext = (/\.([a-z0-9]+)(?:\?|$)/i.exec(url[0])?.[1] ?? "png").toLowerCase();
    return { kind: "url", url: url[0], mime: MIME_BY_EXT[ext] ?? "image/png" };
  }
  return null;
}

/**
 * 在宿主的模型目录里挑一个能出图的。
 *
 * 判据只有一条：**模型 id 里带 image**（`gpt-image-2`、`seedream-image` 之类）。
 * 不猜 `outputModalities`——DSH 的适配器目前只登记输入模态，拿它当出图依据会全线落空。
 *
 * @param {Array<{provider?: string, id?: string, models?: Array<{id?: string, name?: string}>}>} providers
 * @returns {{provider: string, model: string, label: string}|null}
 */
export function findImageModel(providers = []) {
  for (const entry of Array.isArray(providers) ? providers : []) {
    const provider = String(entry?.provider ?? entry?.id ?? "").trim();
    if (!provider) continue;
    for (const model of Array.isArray(entry?.models) ? entry.models : []) {
      const id = String(model?.id ?? "").trim();
      if (id && /image/i.test(id)) {
        return { provider, model: id, label: String(model?.name ?? id) };
      }
    }
  }
  return null;
}

/**
 * 调宿主的模型出一张图。
 *
 * `llm` 是 Cordis 的 `ctx.llm`（有 `stream(options)`）。chunk 协议是
 * `{ type: "text-delta", index, text }` + 终止块 `{ type: "finish", reason }`，
 * 只累加文本块，reasoning 块忽略——推理过程里不会出现图片。
 *
 * @param {{stream: Function, listProviders?: Function}} llm
 * @param {{provider: string, model: string, prompt: string, timeoutMs?: number}} request
 * @returns {Promise<{bytes: Buffer, mime: string, ext: string, raw: string}>}
 */
export async function generateWithHost(llm, request = {}) {
  const prompt = String(request.prompt ?? "").trim();
  if (!prompt) throw new Error("prompt 是空的");
  const provider = String(request.provider ?? "").trim();
  const model = String(request.model ?? "").trim();
  if (!provider || !model) throw new Error("没有指定 provider / model");

  const timeoutMs = Number(request.timeoutMs) || 180_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let text = "";
  try {
    const stream = llm.stream({
      provider,
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      purpose: "gzh-studio-image",
      signal: controller.signal,
    });
    for await (const chunk of stream) {
      if (chunk?.type === "text-delta") text += String(chunk.text ?? "");
      if (chunk?.type === "finish") {
        const kind = chunk?.reason?.kind;
        if (kind === "error" || kind === "aborted") {
          const failure = chunk.reason.failure ?? {};
          throw new Error(`${kind === "aborted" ? "出图超时或被中断" : "模型报错"}：${failure.message ?? failure.code ?? kind}`);
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }

  const image = extractImage(text);
  if (!image) {
    // 把模型说的前 200 字带出去：多数失败原因是配额 / 内容审查，原文比「没拿到图」有用得多
    throw new Error(`模型没有返回图片（它说：${text.trim().slice(0, 200) || "什么都没说"}）`);
  }

  if (image.kind === "base64") {
    const bytes = Buffer.from(image.base64, "base64");
    if (!bytes.length) throw new Error("模型返回了空的 base64");
    return { bytes, mime: image.mime, ext: extOf(image.mime), raw: text };
  }

  const response = await fetch(image.url, { signal: controller.signal });
  if (!response.ok) throw new Error(`图片地址返回 ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return { bytes, mime: image.mime, ext: extOf(image.mime), raw: text };
}

/** mime → 落盘用的扩展名。 */
export function extOf(mime) {
  const key = String(mime ?? "").toLowerCase();
  if (key.includes("jpeg") || key.includes("jpg")) return "jpg";
  if (key.includes("webp")) return "webp";
  if (key.includes("gif")) return "gif";
  if (key.includes("svg")) return "svg";
  return "png";
}
