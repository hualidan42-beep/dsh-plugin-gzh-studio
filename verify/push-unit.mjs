/**
 * 推草稿单测：不联网跑完整条链路（本地假微信服务器）。
 *
 * 要证的六件事，每件都对应一个真实会坏的地方：
 * 1. **token 只换一次**（缓存生效）——不然每次推送都多打一次微信接口；
 * 2. **封面走永久素材**（`add_material` → `thumb_media_id`），正文图走 `uploadimg`；
 * 3. **正文里的占位符全被换成 mmbiz URL**——漏一个，草稿里就是一块空白；
 * 4. **限额自查**：标题超 32 字要在本地就被拦住，不能等微信回错误；
 * 5. **回执落账 + 生命周期推到草稿箱**——没有回执就不该显示「在草稿箱」；
 * 6. **错误码翻人话**：`40164` 要带出可复制的 IP。
 * @module verify/push-unit
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createService } from "../index.js";
import { createStore } from "../lib/store.js";
import { humanError, checkDraft, replacePlaceholders, maskAppId } from "../lib/wechat.js";

// ── 假微信服务器 ─────────────────────────────────────────────────────────────
const calls = [];
let override = null;
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://x");
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks);
    const entry = { path: url.pathname, query: Object.fromEntries(url.searchParams), body };
    calls.push(entry);
    const send = (value) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (override) {
      const result = override(entry, send);
      if (result !== false) return;
    }
    if (url.pathname === "/cgi-bin/stable_token") return send({ access_token: "TOKEN-1", expires_in: 7200 });
    if (url.pathname === "/cgi-bin/media/uploadimg") return send({ url: `https://mmbiz.qpic.cn/body/${calls.length}.png` });
    if (url.pathname === "/cgi-bin/material/add_material") return send({ media_id: "THUMB-1", url: "https://mmbiz.qpic.cn/cover/1.png" });
    if (url.pathname === "/cgi-bin/draft/add") return send({ media_id: "DRAFT-1" });
    send({ errcode: 404, errmsg: "unknown endpoint" });
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;

const root = await mkdtemp(join(tmpdir(), "gzs-push-"));
await writeFile(join(root, "wechat.json"), JSON.stringify({
  appId: "wx1234567890abcdef",
  appSecret: "secret-value",
  author: "作者",
  baseURL,
}), "utf8");

const service = createService({ root }, { info() {}, warn() {} });
const store = createStore({ root });

// 一张够用的最小 PNG（内容不重要，链路只关心字节与扩展名）
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** 给文章补上封面 + 每段配图（各一版真 PNG）。 */
async function attachImages(article) {
  const next = structuredClone(article);
  const put = async (slot, path) => {
    const abs = join(store.dirOf(next.id), path);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, PNG);
    return { vid: "v001", file: path, mime: "image/png", width: 900, height: 383, bytes: PNG.length, prompt: "", createdAt: Date.now() };
  };
  const coverVersion = await put("cover", "images/cover/v001.png");
  next.cover = { slot: "cover", prompt: "", current: "v001", versions: [coverVersion] };
  for (let index = 0; index < (next.sections ?? []).length; index += 1) {
    const slot = next.sections[index].image?.slot || `sec-s${index + 1}`;
    const version = await put(slot, `images/${slot}/v001.png`);
    next.sections[index].image = { slot, prompt: "", current: "v001", versions: [version] };
  }
  return store.writeArticle(next);
}

// ── 1. 状态：没推过的时候该说「还差什么」 ─────────────────────────────────────
const status = await service.wechatStatus();
assert.equal(status.configured, true, "读得到配置");
assert.equal(status.appId, maskAppId("wx1234567890abcdef"), "AppID 要打码");
assert.equal(status.hasSecret, true, "有密钥");
assert.equal(status.token.cached, false, "一开始没有 token 缓存");

// ── 2. dryRun：不联网也要能自查 ──────────────────────────────────────────────
const created = await service.create({ title: "一篇用来推草稿的稿子", sections: 2, template: "business" });
await attachImages(created.article);
const dry = await service.pushDraft({ id: created.article.id, dryRun: true });
assert.equal(dry.dryRun, true);
assert.equal(dry.ok, true, `dryRun 应该通过：${JSON.stringify(dry.problems)}`);
assert.equal(dry.images.length, 3, "封面 + 2 段配图");
assert.equal(calls.length, 0, "dryRun 不许打网络");

// ── 3. 真推：整条链路 ────────────────────────────────────────────────────────
const pushed = await service.pushDraft({ id: created.article.id });
assert.equal(pushed.ok, true);
assert.equal(pushed.mediaId, "DRAFT-1");

const paths = calls.map((call) => call.path);
assert.ok(paths.includes("/cgi-bin/stable_token"), "换了 token");
assert.equal(paths.filter((path) => path === "/cgi-bin/stable_token").length, 1, "token 只换一次（缓存生效）");
assert.ok(paths.includes("/cgi-bin/material/add_material"), "封面走永久素材");
assert.ok(paths.includes("/cgi-bin/media/uploadimg"), "正文图走 uploadimg");
assert.equal(paths.filter((path) => path === "/cgi-bin/media/uploadimg").length, 2, "两张正文图");

const draftCall = calls.find((call) => call.path === "/cgi-bin/draft/add");
const draftBody = JSON.parse(draftCall.body.toString("utf8"));
const articlePayload = draftBody.articles[0];
assert.equal(articlePayload.title, "一篇用来推草稿的稿子");
assert.equal(articlePayload.thumb_media_id, "THUMB-1", "封面用永久素材的 media_id");
assert.equal(articlePayload.author, "作者");
assert.ok(articlePayload.content.includes("https://mmbiz.qpic.cn/cover/1.png"), "首图 URL 进正文");
assert.ok(articlePayload.content.includes("https://mmbiz.qpic.cn/body/"), "正文图 URL 进正文");
assert.ok(!/__IMG_\d+__|__IMG_COVER__/.test(articlePayload.content), "占位符必须全部换掉");

// ── 4. 回执：账本里落一条 publish（不自动改生命周期）──────────────────────────
const ledger = await store.readLedger(created.article.id, 50);
const pushEvent = ledger.find((row) => row.type === "publish");
assert.ok(pushEvent, "账本里要有 publish 回执");
assert.equal(pushEvent.persisted, true, "真推过的回执才作数");
assert.equal(pushEvent.mediaId, "DRAFT-1");
// 0.4.x 删掉了 `idsWithDraftReceipt()` 与「草稿箱」这一档：推成功只落回执，
// **不自动改生命周期**——「这篇算写完了没有」是人的判断，机器不替人标。
const afterPush = await store.listArticles();
const afterRow = (Array.isArray(afterPush) ? afterPush : []).find((item) => item.id === created.article.id);
assert.notEqual(afterRow?.lifecycle?.value, "draftbox", "不该再出现「草稿箱」这个推断出来的档位");
assert.notEqual(afterRow?.lifecycle?.source, "inferred", "推草稿不该推出一个人手标或推断状态");

// ── 5. 限额：超标题在本地拦下，不打网络 ───────────────────────────────────────
const longTitle = await service.create({ title: "长".repeat(40), sections: 1, template: "business" });
await attachImages(longTitle.article);
const before = calls.length;
await assert.rejects(
  () => service.pushDraft({ id: longTitle.article.id }),
  (error) => /标题 40 字/.test(error.message),
  "超长标题要在本地报出来",
);
assert.equal(calls.length, before, "本地拦下就不该再打微信接口");

// ── 6. 错误码翻人话：40164 要带出 IP ─────────────────────────────────────────
override = (entry, send) => {
  if (entry.path === "/cgi-bin/draft/add") {
    send({ errcode: 40164, errmsg: "invalid ip 1.2.3.4, not in whitelist" });
    return true;
  }
  return false;
};
await assert.rejects(
  () => service.pushDraft({ id: created.article.id }),
  (error) => {
    assert.match(error.message, /IP 白名单/);
    return true;
  },
  "40164 要翻成「加 IP 白名单」",
);
const human = humanError(40164, "invalid ip 1.2.3.4, not in whitelist");
assert.equal(human.ip, "1.2.3.4", "IP 要能抠出来给人复制");
override = null;

// 传图失败要说清是**哪一张**：一篇文章五六张图，只回「上传失败」等于没说
override = (entry, send) => {
  if (entry.path === "/cgi-bin/media/uploadimg") {
    send({ errcode: -1, errmsg: "system error" });
    return true;
  }
  return false;
};
await assert.rejects(
  () => service.pushDraft({ id: created.article.id }),
  (error) => /配图（v001）没传上去/.test(error.message),
  "上传失败要带上是哪一张",
);
override = null;

// ── 7. 纯函数 ────────────────────────────────────────────────────────────────
assert.equal(checkDraft({ title: "x".repeat(33) }).ok, false, "33 字标题超限");
assert.equal(replacePlaceholders("<img src='__A__'>__A__", { __A__: "U" }), "<img src='U'>U", "占位符要全换");
const svgArticle = await service.create({ title: "占位图不能推", sections: 1, template: "business" });
const svgStore = await store.readArticle(svgArticle.article.id);
const svgPath = join(store.dirOf(svgArticle.article.id), "images/cover/v001.svg");
await mkdir(join(svgPath, ".."), { recursive: true });
await writeFile(svgPath, "<svg/>");
await store.writeArticle({
  ...svgStore,
  cover: { slot: "cover", prompt: "", current: "v001", versions: [{ vid: "v001", file: "images/cover/v001.svg", mime: "image/svg+xml", width: 900, height: 383, bytes: 6 }] },
});
await assert.rejects(() => service.pushDraft({ id: svgArticle.article.id }), /占位图/, "SVG 占位图必须拦下");

// 收尾：把库和假服务器一起关掉（keep-alive 的 socket 也要断，否则进程退出会踩 libuv 断言）
server.closeAllConnections?.();
await new Promise((resolve) => server.close(resolve));
await rm(root, { recursive: true, force: true });
console.log("push-unit: OK（token 缓存 / 封面走素材 / 正文图走 uploadimg / 占位符全替换 / 回执与生命周期 / 限额本地拦 / 40164 带 IP / SVG 拦下）");
