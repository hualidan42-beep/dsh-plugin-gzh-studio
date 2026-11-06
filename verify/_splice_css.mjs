import { readFileSync, writeFileSync } from "node:fs";

const clientPath = "D:/work/skill/plugins/dsh-plugin-gzh-studio/client.js";
const cssPath = "D:/work/skill/plugins/dsh-plugin-gzh-studio/verify/_new_css.txt";

const src = readFileSync(clientPath, "utf8");
const startMark = "    const CSS = `";
const start = src.indexOf(startMark);
if (start < 0) throw new Error("找不到 CSS 起点");
const endMark = "\n`;\n";
const end = src.indexOf(endMark, start);
if (end < 0) throw new Error("找不到 CSS 终点");

const body = readFileSync(cssPath, "utf8");
const next = src.slice(0, start) + startMark + "\n" + body.replace(/^\n/, "\n") + src.slice(end + 1);
writeFileSync(clientPath, next, "utf8");
console.log(`spliced: ${start}..${end} → 新长度 ${next.length}`);
