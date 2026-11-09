/**
 * 出图。两条通道：
 *
 * 1. **占位图（默认，不出网）** —— 生成一张 SVG：尺寸、槽位名、prompt 摘要、版本号都画在上面。
 *    装好就能把「出图 → 看版本 → 改 → 重出 → 导出」整条流程点一遍，不用先配 key。
 *    用 SVG 而不是 PNG 是因为它能直接写字（PNG 编码要自己实现一遍，还没法标字）。
 * 2. **OpenAI 兼容节点** —— `POST {baseURL}/v1/images/generations`，
 *    吃 `b64_json` 或 `url` 两种返回，按返回内容的魔数判扩展名，尺寸优先自己探（不信声明值）。
 *
 * 节点是「多个」的：一个额度不够就切下一个（Deckline 同款动机）。节点配置在
 * `<root>/settings.json`，key 只从环境变量读（`apiKeyEnv`），**不落盘、不进日志**。
 * @module lib/generate
 */

/** 封面推荐尺寸：公众号首图 2.35:1。与 `lib/qa.js` 的 COVER 是同一组数。 */
export const COVER_SIZE = { width: 900, height: 383 };

/** 正文配图默认尺寸（16:9，手机上满宽显示最舒服）。 */
export const SECTION_SIZE = { width: 1024, height: 576 };

/**
 * 出图接口的尺寸步长。
 *
 * 这条是实测出来的，不是猜的：网关**只认 64 的倍数**，不是倍数的尺寸不报错、
 * 直接静默出一张方图。`900x383`（383 是奇数）→ 实际拿到 `1254x1254`；
 * `900x384`（900 不是 64 的倍数）→ 同样 `1254x1254`；而 `1792x768`、`1216x512`、
 * `1344x576` 都按请求返回。所以「请求前先吸附到 64 的倍数」是必须的，
 * 光靠「回来以后再探真实尺寸」只能记录错，不能避免错。
 */
export const SIZE_STEP = 64;

/** 单图像素上限：再大只会更慢更贵，公众号用不上。 */
const SIZE_MAX_PIXELS = 1536 * 1024;

/** 短边下限：太小出图质量差（而且模型对小图的理解也更差）。 */
const SIZE_MIN_SIDE = 512;

/**
 * 把目标尺寸吸附到接口真正接受的档位：64 的倍数，比例尽量贴近目标。
 *
 * 目标是**保住比例**而不是保住数字——公众号首图要的是 2.35:1 这个形状，
 * 900 还是 1664 宽都无所谓（后台会自动缩）。所以按「比例漂移最小」挑，
 * 漂移一样时取像素多的那一档。
 *
 * @param {string} size `900x383` 这样的目标尺寸
 * @returns {{requested: string, sent: string, width: number, height: number, ratio: number, adjusted: boolean}}
 */
export function snapSize(size) {
  const m = /^(\d+)x(\d+)$/.exec(String(size ?? "").trim());
  const target = m ? { width: Number(m[1]), height: Number(m[2]) } : { ...COVER_SIZE };
  const targetRatio = target.width / target.height;
  const exact = target.width % SIZE_STEP === 0 && target.height % SIZE_STEP === 0;

  if (exact) {
    return {
      requested: `${target.width}x${target.height}`,
      sent: `${target.width}x${target.height}`,
      width: target.width,
      height: target.height,
      ratio: targetRatio,
      adjusted: false,
    };
  }

  let best = null;
  for (let width = SIZE_STEP; width <= 2048; width += SIZE_STEP) {
    for (let height = SIZE_STEP; height <= 2048; height += SIZE_STEP) {
      if (width * height > SIZE_MAX_PIXELS) continue;
      if (Math.min(width, height) < SIZE_MIN_SIDE) continue;
      const drift = Math.abs(width / height - targetRatio) / targetRatio;
      // 比例优先，同一比例里取像素多的（面积项放大到能盖过 ≤1 的抖动即可）
      const score = drift * 1e6 - (width * height) / 1e6;
      if (!best || score < best.score) best = { score, width, height };
    }
  }

  const picked = best ?? { width: target.width, height: target.height };
  return {
    requested: `${target.width}x${target.height}`,
    sent: `${picked.width}x${picked.height}`,
    width: picked.width,
    height: picked.height,
    ratio: picked.width / picked.height,
    adjusted: true,
  };
}

/**
 * 槽位的默认尺寸。
 * @param {string} slot `cover` 或 `sec-s<n>`
 * @returns {{width: number, height: number, label: string}}
 */
export function defaultSizeFor(slot) {
  return slot === "cover"
    ? { ...COVER_SIZE, label: "900x383" }
    : { ...SECTION_SIZE, label: "1024x576" };
}

/** XML 转义（SVG 是 XML，`&` `<` 必须转）。 */
const xml = (text) =>
  String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/** 按字符数硬折行（中文没有空格，按宽度折）。 */
function wrap(text, perLine, maxLines) {
  const chars = [...String(text ?? "").replace(/\s+/g, " ").trim()];
  const lines = [];
  for (let i = 0; i < chars.length && lines.length < maxLines; i += perLine) {
    lines.push(chars.slice(i, i + perLine).join(""));
  }
  if (chars.length > perLine * maxLines) {
    const last = lines[lines.length - 1] ?? "";
    lines[lines.length - 1] = `${[...last].slice(0, Math.max(0, perLine - 1)).join("")}…`;
  }
  return lines;
}

/**
 * 占位图 SVG。输出是确定性的（同样的入参 → 同样的字节），单测直接比对。
 * @param {{slot: string, prompt?: string, vid: string, width?: number, height?: number, label?: string}} input
 * @returns {string}
 */
export function placeholderSvg(input) {
  const slot = String(input?.slot ?? "cover");
  const size = defaultSizeFor(slot);
  const width = Number(input?.width) || size.width;
  const height = Number(input?.height) || size.height;
  const isCover = slot === "cover";
  const title = isCover ? "封面 2.35:1" : `第 ${sectionNumber(slot)} 段配图`;
  const prompt = String(input?.prompt ?? "").trim();
  const lines = wrap(prompt || "（还没有写 prompt）", isCover ? 30 : 34, isCover ? 2 : 3);
  const pad = Math.round(width * 0.06);
  const titleSize = Math.max(14, Math.round(width / 34));
  const bodySize = Math.max(11, Math.round(width / 58));
  const step = Math.round(bodySize * 1.6);
  const startY = height / 2 - ((lines.length - 1) * step) / 2 + titleSize;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${xml(title)}占位图">`,
    `<defs><pattern id="g" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="#e8edf3" stroke-width="1"/></pattern></defs>`,
    `<rect width="${width}" height="${height}" fill="#f6f8fb"/>`,
    `<rect width="${width}" height="${height}" fill="url(#g)"/>`,
    `<rect x="1" y="1" width="${width - 2}" height="${height - 2}" fill="none" stroke="#cfd8e3" stroke-width="2" stroke-dasharray="10 8"/>`,
    // 左上角：槽位名 + 版本
    `<text x="${pad}" y="${Math.round(pad + titleSize)}" font-family="-apple-system,'PingFang SC','Microsoft YaHei',sans-serif" font-size="${titleSize}" font-weight="700" fill="#33415c">${xml(title)}</text>`,
    `<text x="${width - pad}" y="${Math.round(pad + titleSize)}" text-anchor="end" font-family="'SF Mono',Consolas,monospace" font-size="${Math.max(10, titleSize - 2)}" fill="#7b8798">${xml(input?.vid ?? "")}</text>`,
    // 中间：prompt 摘要
    ...lines.map(
      (line, index) =>
        `<text x="${width / 2}" y="${Math.round(startY + index * step)}" text-anchor="middle" font-family="-apple-system,'PingFang SC','Microsoft YaHei',sans-serif" font-size="${bodySize}" fill="#5b6472">${xml(line)}</text>`,
    ),
    // 底部：尺寸 + 占位声明
    `<text x="${width / 2}" y="${height - Math.round(pad * 0.55)}" text-anchor="middle" font-family="'SF Mono',Consolas,monospace" font-size="${Math.max(9, bodySize - 1)}" fill="#98a2b3">${width}×${height} · 占位图（配好节点后重出）</text>`,
    `</svg>`,
  ].join("");
}

/** `sec-s3` → `3`。 */
function sectionNumber(slot) {
  const m = /^sec-s(\d+)$/.exec(String(slot ?? ""));
  return m ? Number(m[1]) : 0;
}

/** 探测图片真实尺寸：PNG IHDR / JPEG SOF / SVG 属性；探不到回 null（不猜）。 */
export function probeSize(bytes) {
  const buf = Buffer.from(bytes);
  // PNG: 89 50 4E 47 0D 0A 1A 0A | len(4) | 'IHDR' | w(4) | h(4)
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), ext: "png", mime: "image/png" };
  }
  // JPEG: 从 SOI 起扫段，遇到 SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11 取高宽
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buf[offset + 1];
      const length = buf.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5), ext: "jpg", mime: "image/jpeg" };
      }
      offset += 2 + length;
    }
    return { width: 0, height: 0, ext: "jpg", mime: "image/jpeg" };
  }
  // SVG: 取根元素 width/height/vieWBox
  const head = buf.subarray(0, 2048).toString("utf8");
  if (head.includes("<svg")) {
    const w = /\bwidth="(\d+(?:\.\d+)?)"/.exec(head);
    const h = /\bheight="(\d+(?:\.\d+)?)"/.exec(head);
    if (w && h) return { width: Math.round(Number(w[1])), height: Math.round(Number(h[1])), ext: "svg", mime: "image/svg+xml" };
    const vb = /\bviewBox="[\d.]+ [\d.]+ ([\d.]+) ([\d.]+)"/.exec(head);
    if (vb) return { width: Math.round(Number(vb[1])), height: Math.round(Number(vb[2])), ext: "svg", mime: "image/svg+xml" };
    return { width: 0, height: 0, ext: "svg", mime: "image/svg+xml" };
  }
  return null;
}

/** 节点可用性：fake 永远可用；真节点要求 baseURL 是 http(s) 且 key 在环境变量里。 */
export function describeNode(node, env = process.env) {
  if (node?.fake) return { usable: true, reason: "" };
  const target = checkNodeTarget(node);
  if (!target.usable) return { usable: false, reason: target.reason };
  if (!node?.model) return { usable: false, reason: "没有指定模型" };
  const envName = String(node?.apiKeyEnv ?? "").trim();
  if (!env?.[envName]) return { usable: false, reason: `环境变量 ${envName} 未设置` };
  return { usable: true, reason: "" };
}

/**
 * 出图节点只读取这两个前缀的环境变量：不把宿主进程里的任意密钥当 Bearer 发出去。
 *
 * `GZH_` 是产品前缀（`GZH_IMAGE_KEY`），`GZS_` 是 0.2.0 起就在用的前缀，
 * 保留它是为了不弄坏已有配置。别的名字（`OPENAI_API_KEY`、`AWS_SECRET_ACCESS_KEY`……）
 * 一律不收——那正是「一次写请求就把本机密钥外送」的路径。
 */
export const API_KEY_ENV_PATTERN = /^(GZH|GZS)_[A-Z0-9_]{1,60}$/;

/** 内网 / 回环 / 链路本地地址：出图节点与「节点返回的图片地址」都不允许指向这些。 */
const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i;
const PRIVATE_IPV4 = /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/**
 * 远程地址是否可用（不联网，只做形状判断）。
 *
 * 为什么要有这道闸：节点配置里 `baseURL` 与 `apiKeyEnv` 都是自由填写的，
 * 而出图时会 `env[node.apiKeyEnv]` 当 `authorization: Bearer` 发给 `node.baseURL`。
 * 一次「把 apiKeyEnv 改成 OPENAI_API_KEY、baseURL 改成外部主机」的写请求，
 * 就等于把本机任意密钥外送；`baseURL` 指向 127.0.0.1 / 10.x 时宿主还成了 SSRF 跳板。
 *
 * `allowPrivate` 是给**本地出图服务**留的口子（ComfyUI / SD WebUI 常跑在 127.0.0.1）：
 * 指向本机是用户自己的选择，不算逃逸；但「公网地址返回一个内网 URL」仍然拦。
 *
 * @param {unknown} raw
 * @param {{label?: string, allowPrivate?: boolean}} [options]
 * @returns {{ok: boolean, reason: string, url?: URL, private?: boolean}}
 */
export function checkRemoteUrl(raw, options = {}) {
  const label = options.label ?? "地址";
  const text = String(raw ?? "").trim();
  if (!/^https?:\/\//i.test(text)) return { ok: false, reason: `${label} 必须是 http(s) 地址` };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: `${label} 不是合法 URL` };
  }
  if (url.username || url.password) return { ok: false, reason: `${label} 不能带用户名密码（会把凭证写进配置文件）` };
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return { ok: false, reason: `${label} 没有主机名` };
  const isPrivate = PRIVATE_HOST.test(host) || PRIVATE_IPV4.test(host) || host === "::1";
  if (isPrivate && !options.allowPrivate) {
    return { ok: false, reason: `${label} 不能指向内网或本机（${host}）`, private: true };
  }
  return { ok: true, reason: "", url, private: isPrivate };
}

/**
 * 校验节点配置。`danger` 区分「只是还没填完」与「填法会把密钥送出去」：
 * 前者允许存草稿，后者直接 400。
 *
 * `strict` 只在**写入时**用（`upsertNode`）。读取时（`describeNode`）放宽：
 * 0.2.0 之前存下的节点可能用着别的环境变量名、或者指着本地出图服务，
 * 直接判不可用等于让老用户升级后突然出不了图。
 *
 * @param {unknown} node
 * @param {{strict?: boolean}} [options]
 * @returns {{usable: boolean, danger: boolean, reason: string}}
 */
export function checkNodeTarget(node, options = {}) {
  const strict = options.strict === true;
  const base = String(node?.baseURL ?? "").trim();
  if (!base) return { usable: false, danger: false, reason: "没有填 baseURL" };
  const remote = checkRemoteUrl(base, { label: "baseURL", allowPrivate: !strict });
  if (!remote.ok) {
    // 写法错误（不是 http、不是 URL）归「没填完」；带凭证 / 指向内网归「危险」。
    const danger = /不能带用户名密码|不能指向内网/.test(remote.reason);
    return { usable: false, danger, reason: remote.reason };
  }
  const envName = String(node?.apiKeyEnv ?? "").trim();
  if (!envName) return { usable: false, danger: false, reason: "没有指定 apiKeyEnv" };
  if (!API_KEY_ENV_PATTERN.test(envName)) {
    if (strict) {
      return {
        usable: false,
        danger: true,
        reason: `apiKeyEnv 必须以 GZH_ 或 GZS_ 开头（只从自己的环境变量读 key，避免把宿主里的其它密钥当 Bearer 发出去）`,
      };
    }
    // 老配置：放行，但在原因里说清楚为什么建议改名（面板会把它显示成提醒）
    return { usable: true, danger: false, reason: `建议把 ${envName} 改名为 GZH_ 开头（避免把宿主里的其它密钥当 Bearer 发出去）` };
  }
  return { usable: true, danger: false, reason: "" };
}

/**
 * 出图入口。
 * @param {object} node 节点配置（settings.json 里的一条）
 * @param {{slot: string, prompt: string, negative?: string, vid: string, size?: string, env?: Record<string, string>, timeoutMs?: number}} request
 * @returns {Promise<{bytes: Buffer, ext: string, mime: string, width: number, height: number, model: string, note: string}>}
 */
export async function generateImage(node, request) {
  const slot = String(request?.slot ?? "cover");
  const prompt = String(request?.prompt ?? "").trim();
  if (!prompt) throw new Error("prompt 是空的：先写清主体、场景、色调，再出图");

  const preset = defaultSizeFor(slot);
  const [presetW, presetH] = [preset.width, preset.height];
  const requested = /^\d+x\d+$/.test(String(request?.size ?? "")) ? String(request.size) : `${presetW}x${presetH}`;
  // 发出去的尺寸必须吸附到接口认的档位（64 的倍数），否则会被静默改成方图
  const snapped = snapSize(requested);

  if (node?.fake) {
    const height = Number(requested.split("x")[1]) || presetH;
    const width = Number(requested.split("x")[0]) || presetW;
    const svg = placeholderSvg({ slot, prompt, vid: request?.vid ?? "", width, height });
    return {
      bytes: Buffer.from(svg, "utf8"),
      ext: "svg",
      mime: "image/svg+xml",
      width,
      height,
      model: "placeholder",
      note: "占位图：没有联网出图",
    };
  }

  const check = describeNode(node, request?.env ?? process.env);
  if (!check.usable) throw new Error(`节点不可用：${check.reason}`);

  const key = (request?.env ?? process.env)[node.apiKeyEnv];
  const base = String(node.baseURL).replace(/\/+$/, "");
  const url = `${base}/v1/images/generations`;
  const negative = String(request?.negative ?? "").trim();
  const fullPrompt = negative ? `${prompt}\n\n画面中不要出现：${negative}` : prompt;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(request?.timeoutMs) || 120_000);
  let payload;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: node.model, prompt: fullPrompt, n: 1, size: snapped.sent, response_format: "b64_json" }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      // 只回状态码与前 200 字，**不带请求头**（里面有 key）
      throw new Error(`节点返回 ${response.status}：${text.slice(0, 200)}`);
    }
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`节点返回的不是 JSON：${text.slice(0, 160)}`);
    }
  } finally {
    clearTimeout(timer);
  }

  const first = Array.isArray(payload?.data) ? payload.data[0] : null;
  if (!first) throw new Error("节点没有返回 data[0]");

  let bytes;
  if (typeof first.b64_json === "string" && first.b64_json) {
    bytes = Buffer.from(first.b64_json, "base64");
  } else if (typeof first.url === "string" && first.url) {
    // 有的节点只回 url：再取一次（同样走 abort 超时）。
    // 这个地址是**节点自己给的**，不能无条件 fetch——否则一个被改过的节点
    // 就能让宿主替它访问内网地址（云上的 169.254.169.254 元数据接口首选）。
    // 但节点本身就在本机（本地 ComfyUI / SD WebUI）时，返回本机地址是正常的，放行。
    const nodeIsLocal = checkRemoteUrl(String(node.baseURL).replace(/\/+$/, ""), { allowPrivate: true }).private === true;
    const imageUrl = checkRemoteUrl(first.url, { label: "节点返回的图片地址", allowPrivate: nodeIsLocal });
    if (!imageUrl.ok) throw new Error(`节点给的图片地址不允许取用：${imageUrl.reason}`);
    const controller2 = new AbortController();
    const timer2 = setTimeout(() => controller2.abort(), Number(request?.timeoutMs) || 120_000);
    try {
      const imageResponse = await fetch(imageUrl.url, { signal: controller2.signal });
      if (!imageResponse.ok) throw new Error(`图片地址返回 ${imageResponse.status}`);
      bytes = Buffer.from(await imageResponse.arrayBuffer());
    } finally {
      clearTimeout(timer2);
    }
  } else {
    throw new Error("节点既没回 b64_json 也没回 url");
  }

  const probe = probeSize(bytes);
  if (!probe) throw new Error("认不出返回的图片格式（不是 PNG / JPEG / SVG）");
  const width = probe.width || snapped.width;
  const height = probe.height || snapped.height;
  // note 是给人看的一句话，说清「我改了什么、为什么」——空字符串就表示这图没打过折
  const notes = [];
  if (snapped.adjusted) {
    notes.push(`尺寸吸附为 ${snapped.sent}（目标 ${snapped.requested}，实际比例 ${snapped.ratio.toFixed(2)}:1）`);
  }
  if (probe.width && width && height) {
    const drift = Math.abs(width / height - snapped.ratio) / snapped.ratio;
    // 已经按 64 的倍数发了还被改掉，说明这个节点压根不认 size 参数
    if (drift > 0.02) notes.push(`节点实际返回 ${width}×${height}，没按请求的 ${snapped.sent} 出图（该节点不支持指定尺寸）`);
  } else {
    notes.push("尺寸是从请求值回填的（返回体里没探到尺寸）");
  }
  return {
    bytes,
    ext: probe.ext,
    mime: probe.mime,
    // 尺寸以**文件本身**为准：请求只是意图，落盘要记真实值（面板和 QA 都按这个算比例）
    width,
    height,
    model: String(node.model),
    note: notes.join("；"),
  };
}
