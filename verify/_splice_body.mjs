import { readFileSync, writeFileSync } from "node:fs";

const clientPath = "D:/work/skill/plugins/dsh-plugin-gzh-studio/client.js";
const bodyPath = "D:/work/skill/plugins/dsh-plugin-gzh-studio/verify/_new_body.txt";

const src = readFileSync(clientPath, "utf8");
const startMark = '        body = h("div", { className: "gzs-body" },\n';
const endMark = "              onToggleReview,\n            })));\n      }\n";

const start = src.indexOf(startMark);
if (start < 0) throw new Error("找不到三栏起点");
if (src.indexOf(startMark, start + 1) >= 0) throw new Error("起点不唯一");
const end = src.indexOf(endMark, start);
if (end < 0) throw new Error("找不到三栏终点");
if (src.indexOf(endMark, end + 1) >= 0) throw new Error("终点不唯一");

const body = readFileSync(bodyPath, "utf8");
const next = src.slice(0, start) + body + src.slice(end + endMark.length);
writeFileSync(clientPath, next, "utf8");
console.log(`spliced body: ${start}..${end + endMark.length}`);
