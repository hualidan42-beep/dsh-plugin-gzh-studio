/**
 * 实时同步（SSE）单测：一条长连接能不能真的把「写盘了」这件事推下来。
 *
 * 三件事都要成立，否则面板会显示「实时」却永远不动：
 * 1. 连上就有 `hello` 帧（浏览器据此把指示灯点亮）；
 * 2. 面板内的写（POST 成功）推一条 `write`，带上文章 id；
 * 3. 盘上的外部改动（agent 直接落文件）推一条 `fs`。
 *
 * 断言的是**帧内容**而不是「有个路由」：路由注册了但没接广播，
 * 是这一层最容易出的假通过。
 * @module verify/stream-unit
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, ROUTES } from "../index.js";

const routes = new Map();
const effects = [];
const ctx = {
  connection: {
    fetch: {
      register: (spec) => {
        routes.set(spec.path, spec);
        return () => routes.delete(spec.path);
      },
    },
  },
  effect: (fn) => { effects.push(fn()); },
  provide: () => {},
  logger: { info() {}, warn() {} },
};

const root = await mkdtemp(join(tmpdir(), "gzs-stream-"));
apply(ctx, { root });

const spec = routes.get(ROUTES.stream);
assert.ok(spec, "stream 路由已注册");

const abort = new AbortController();
const response = await spec.fetch({
  url: `http://x${ROUTES.stream}`,
  headers: new Headers(),
  signal: abort.signal,
});
assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/, "SSE content-type");
assert.match(response.headers.get("cache-control") ?? "", /no-cache/, "SSE 不能被缓存");

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
/** 读一次（最多等 ms），把拿到的字节追加进 buffer。 */
const drain = async (ms) => {
  const got = await Promise.race([reader.read(), new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
  if (got && got.value) buffer += decoder.decode(got.value);
};

await drain(600);
assert.ok(buffer.includes('"kind":"hello"'), `连上先发 hello，实际「${buffer.slice(0, 120)}」`);

// 面板内的写：POST 成功必须推一条 write，并带上 id
const created = await routes.get(ROUTES.create).fetch({
  url: `http://x${ROUTES.create}`,
  json: async () => ({ title: "实时同步探针", sections: 2, template: "business" }),
});
assert.equal(created.status, 200, "create 成功");
await drain(700);
const writeFrame = buffer.split("\n\n").find((frame) => frame.includes('"kind":"write"'));
assert.ok(writeFrame, `POST 成功要推 write 帧，实际「${buffer.slice(0, 300)}」`);
assert.match(writeFrame, /"id":"gzh-/, "write 帧带文章 id");

// 盘上的外部改动：agent 直接落文件也要能被看见
await writeFile(join(root, "articles", "external-probe.json"), "{}");
await new Promise((resolve) => setTimeout(resolve, 900));
await drain(400);
assert.ok(buffer.includes('"kind":"fs"'), `盘上改动要推 fs 帧，实际「${buffer.slice(-240)}」`);

// 断开：不许留下悬挂的心跳与监听
abort.abort();
await new Promise((resolve) => setTimeout(resolve, 60));

// 断开后重连：新连接照样收得到事件。
// 这条能抓到「旧连接的监听没摘干净」——广播时会对着一个已经关掉的 controller 打。
const ac2 = new AbortController();
const second = await routes.get(ROUTES.stream).fetch({
  url: `http://x${ROUTES.stream}`,
  headers: new Headers(),
  signal: ac2.signal,
});
const reader2 = second.body.getReader();
let buffer2 = "";
const drainSecond = async (ms) => {
  const got = await Promise.race([reader2.read(), new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
  if (got && got.value) buffer2 += decoder.decode(got.value);
};
await drainSecond(500);
assert.ok(buffer2.includes('"kind":"hello"'), "重连要有 hello 帧");
await routes.get(ROUTES.create).fetch({
  url: `http://x${ROUTES.create}`,
  json: async () => ({ title: "重连后的第二篇", sections: 1 }),
});
await drainSecond(700);
assert.ok(buffer2.includes('"kind":"write"'), "重连后照样收得到写事件");
ac2.abort();
await new Promise((resolve) => setTimeout(resolve, 60));
await Promise.allSettled(effects.map((dispose) => (typeof dispose === "function" ? dispose() : undefined)));
assert.equal(routes.size, 0, "dispose 后路由清空");

await rm(root, { recursive: true, force: true });
console.log("stream-unit: OK（hello 帧 / POST write 帧带 id / 盘上改动 fs 帧 / 断开清理 / 重连）");

