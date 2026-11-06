import { launch, attach } from "./cdp.mjs";
const TOKEN = process.argv[2];
const url = `http://127.0.0.1:3080/?token=${TOKEN}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = await launch({ port: 9389, url, width: 1400, height: 900 });
const page = await attach(chrome.port);
await wait(6000);
const out = await page.evaluate(`(async () => {
  const r = await fetch("/api/gzh-studio.state", { credentials: "same-origin" });
  const data = await r.json();
  return {
    root: data.root, pipelineRoot: data.settings && data.settings.pipelineRoot,
    ws: (data.settings && Object.keys(data.settings)) || [],
    articles: (data.articles || []).length,
  };
})()`);
console.log(JSON.stringify(out, null, 2));
await page.close(); await chrome.child.kill();
