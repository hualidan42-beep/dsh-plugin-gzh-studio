import { launch, attach } from "./cdp.mjs";
const TOKEN = process.argv[2];
const url = `http://127.0.0.1:3080/?token=${TOKEN}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = await launch({ port: 9373, url, width: 1680, height: 1000 });
const page = await attach(chrome.port);
await page.navigate(url);
await wait(8000);
const out = await page.evaluate(`(() => ({
  href: location.href,
  buttons: [...document.querySelectorAll("button")].map((b) => (b.textContent || "").trim()).filter(Boolean).slice(0, 20),
  bodyLen: (document.body.innerText || "").length,
  title: document.title,
}))()`);
console.log(JSON.stringify(out, null, 2));
for (const ev of page.events) {
  if (ev.method === "Runtime.exceptionThrown") console.log("[ex]", (ev.params.exceptionDetails.exception?.description || "").slice(0, 200));
}
await page.close(); await chrome.child.kill();
