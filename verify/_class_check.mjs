import { readFileSync } from "node:fs";
const path = "D:/work/skill/plugins/dsh-plugin-gzh-studio/client.js";
const src = readFileSync(path, "utf8");
const start = src.indexOf("    const CSS = `") + "    const CSS = `".length;
const end = src.indexOf("\n`;", start);
const css = src.slice(start, end);
const js = src.slice(0, src.indexOf("    const CSS = `")) + src.slice(end);

const cssClasses = new Set([...css.matchAll(/\.(gzs-[a-zA-Z0-9_-]+)/g)].map((m) => m[1]));
const jsTokens = new Set([...js.matchAll(/(gzs-[a-zA-Z0-9_-]+)/g)].map((m) => m[1]));

const missing = [...jsTokens].filter((t) => !cssClasses.has(t) && !t.endsWith("--") && !t.startsWith("gzs-style")).sort();
const unused = [...cssClasses].filter((t) => !jsTokens.has(t)).sort();

console.log("JS 用到但 CSS 里没有的类（可为模板前缀）：");
console.log(missing.join("\n"));
console.log("\nCSS 里有但 JS 没直接写的类（可能是前缀/父类，正常）：");
console.log(unused.join("\n"));

const BAD = /f4f1e9|ece6da|0c4651|0f6975|1496a8|c5882f|fffdf8|e2f1ef|eaf4f2|f7f3e9|cfc7b8|bfae97|d5ece9|0a3c46|052329|0d5560|1aa7bb|0b5a64/i;
const hits = css.split("\n").map((line, i) => [i + 1, line]).filter(([, line]) => BAD.test(line));
console.log("\n暖纸/青/墨绿 残留：", hits.length);
for (const [n, line] of hits) console.log(`  ${n}: ${line.trim().slice(0, 120)}`);
