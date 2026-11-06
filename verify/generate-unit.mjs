/**
 * generate.js 的离线单测：**不发一次网络请求**。
 *
 * 锁住两件本轮实测出来的事实，防止以后改回去：
 * 1. 出去请求的 `size` 必须是 64 的倍数 —— 网关对非倍数尺寸不报错，直接静默出方图
 *    （`900x383` → `1254x1254`）。所以断言点不是「请求值等于目标值」，
 *    而是「请求值都是 64 的倍数，且比例贴着目标」。
 * 2. 封面 2.35:1 靠「比例」保，不靠「数字」保；漂移超过 2% 就算失败（QA 用的是同一口径）。
 *
 * 跑法：node verify/generate-unit.mjs
 */
import assert from "node:assert/strict";
import { snapSize, placeholderSvg, generateImage, probeSize, SIZE_STEP, COVER_SIZE, SECTION_SIZE } from "../lib/generate.js";

const near = (a, b, tol) => Math.abs(a - b) / b <= tol;
const isStep = (n) => n % SIZE_STEP === 0;

// ── snapSize ────────────────────────────────────────────────────────────────
{
  // 封面：900x383 不是 64 的倍数，必须被吸附，且比例要盯着 2.35
  const cover = snapSize("900x383");
  assert.equal(cover.adjusted, true, "900x383 应当被判为需要吸附");
  assert.equal(cover.requested, "900x383");
  assert.ok(isStep(cover.width) && isStep(cover.height), `吸附后必须都是 ${SIZE_STEP} 的倍数，实际 ${cover.width}x${cover.height}`);
  assert.equal(cover.sent, `${cover.width}x${cover.height}`);
  const coverRatio = COVER_SIZE.width / COVER_SIZE.height;
  assert.ok(near(cover.ratio, coverRatio, 0.02), `封面比例漂移超过 2%：${cover.ratio.toFixed(3)} vs ${coverRatio.toFixed(3)}`);

  // 正文配图：1024x576 本来就是 64 的倍数，一个字都不该改
  const section = snapSize("1024x576");
  assert.equal(section.adjusted, false);
  assert.equal(section.sent, "1024x576");
  assert.equal(section.width, SECTION_SIZE.width);
  assert.equal(section.height, SECTION_SIZE.height);

  // 已经合法的尺寸原样透传（不能自作聪明再挪一档）
  assert.equal(snapSize("1536x1024").sent, "1536x1024");

  // 脏输入 / 空值：退回封面口径，且仍然必须是 64 的倍数
  for (const bad of ["", "abc", "900", "0x0", undefined, null]) {
    const s = snapSize(bad);
    assert.ok(isStep(s.width) && isStep(s.height), `${String(bad)} 的兜底结果不是 64 的倍数：${s.sent}`);
  }

  // 竖版也要能吸附（以后加手机竖图时用得上）
  const portrait = snapSize("900x1200");
  assert.ok(isStep(portrait.width) && isStep(portrait.height));
  assert.ok(portrait.height > portrait.width, "竖版目标不该被吸成横版");
}

// ── generateImage 真正发出去的 size ─────────────────────────────────────────
{
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    // 回一张 1x1 的合法 PNG（只要魔数对、IHDR 能读就行）
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }) };
  };
  try {
    const node = { id: "t", name: "t", baseURL: "https://example.invalid", apiKeyEnv: "T_KEY", model: "m", size: "", fake: false };
    const out = await generateImage(node, {
      slot: "cover",
      prompt: "测试用 prompt",
      vid: "v001",
      size: "900x383",
      env: { T_KEY: "x" },
      timeoutMs: 5000,
    });

    assert.equal(calls.length, 1, "应当只发一次请求");
    assert.ok(calls[0].url.endsWith("/v1/images/generations"), `请求地址拼接不对：${calls[0].url}`);
    const sent = calls[0].body.size;
    const [sw, sh] = sent.split("x").map(Number);
    assert.ok(isStep(sw) && isStep(sh), `发出去的 size 必须是 ${SIZE_STEP} 的倍数，实际 ${sent}`);
    assert.equal(sent, snapSize("900x383").sent, `发出去的尺寸应当等于 snapSize 的结果`);
    assert.ok(near(sw / sh, COVER_SIZE.width / COVER_SIZE.height, 0.02), `请求比例偏离 2.35 太多：${(sw / sh).toFixed(3)}`);
    assert.equal(calls[0].body.response_format, "b64_json");

    // note 必须说清「我改过尺寸」，否则人看到 1664x704 会以为是节点乱来
    assert.ok(out.note.includes("吸附"), `note 没说明尺寸被吸附过：${out.note}`);
    assert.ok(out.note.includes(sent), `note 没写出实际请求的尺寸：${out.note}`);
  } finally {
    globalThis.fetch = original;
  }
}

// ── fake 节点：占位图仍按目标尺寸画（SVG 没有 64 的限制）────────────────────
{
  const fake = { id: "fake", name: "占位图", fake: true };
  const out = await generateImage(fake, { slot: "cover", prompt: "占位", vid: "v001", size: "900x383" });
  assert.equal(out.ext, "svg");
  assert.equal(out.width, 900);
  assert.equal(out.height, 383);
  assert.ok(out.note.includes("占位"), "fake 的 note 要说清是占位图");
  const head = Buffer.from(out.bytes).subarray(0, 200).toString("utf8");
  assert.ok(head.includes('width="900"') && head.includes('height="383"'), "占位图尺寸没按目标画");
}

// ── probeSize：三种格式都认 ─────────────────────────────────────────────────
{
  const svg = Buffer.from(placeholderSvg({ slot: "sec-s1", prompt: "x", vid: "v001" }));
  const probe = probeSize(svg);
  assert.equal(probe.ext, "svg");
  assert.equal(probe.width, SECTION_SIZE.width);
  assert.equal(probe.height, SECTION_SIZE.height);

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const p = probeSize(png);
  assert.equal(p.ext, "png");
  assert.equal(p.width, 1);
  assert.equal(probeSize(Buffer.from("not an image")) || null, null, "认不出就该回 null，不能瞎猜");
}

console.log("generate-unit: OK（尺寸吸附到 64 的倍数 · 封面比例漂移 <2% · 请求体与 note 一致 · 占位图不走吸附）");
