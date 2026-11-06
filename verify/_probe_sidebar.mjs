import { launch, attach } from "./cdp.mjs";

const TOKEN = process.argv[2];
const url = `http://127.0.0.1:3080/?token=${TOKEN}`;
const chrome = await launch({ port: 9347, url, width: 1680, height: 1000 });
const page = await attach(chrome.port);
try {
  await page.navigate(url);
  await page.waitFor("document.body && document.body.innerText.length > 20", "挂载", 90000);
  await new Promise((r) => setTimeout(r, 2500));
  const dump = await page.evaluate(`(() => ({
    text: document.body.innerText.slice(0, 700),
    buttons: [...document.querySelectorAll("button")].map((b) => (b.textContent || "").trim().slice(0, 24)).filter(Boolean).slice(0, 40),
    href: location.href,
  }))()`);
  console.log(JSON.stringify(dump, null, 2));
  await page.screenshot("D:/work/skill/plugins/dsh-plugin-gzh-studio/verify/shots/r4-00-probe.png");
} finally {
  page.close();
  chrome.child.kill();
}
