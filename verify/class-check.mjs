/**
 * 样式覆盖自检：客户端里 `className` 用到的 `gzs-*` 类，是否都在 CSS 里定义过。
 *
 * 为什么单独查这个：类名拼错（gzs-card__thum 少个 b）不会有任何报错，
 * 组件照常渲染、测试照常通过，只是界面上那块没有样式。这类问题只能靠比对发现。
 *
 * 两类分别处理：
 * - 静态类（`className: "gzs-card__thumb"`）→ 必须精确存在
 * - 模板类（`gzs-badge--${map[level]}`）→ 变体值由组件内部决定，只校验
 *   「前缀有没有对应的变体定义」。否则把 Badge 的 error→err 映射误报成缺失。
 * @module verify/class-check
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "client.js"), "utf8");

const defined = new Set([...src.matchAll(/\.(gzs-[a-z0-9_-]+)/g)].map((m) => m[1]));

const staticUsed = new Set();
const templatePrefixes = new Set();

const scan = (raw) => {
  for (const part of raw.split(/\s+/)) {
    if (!part.startsWith("gzs-")) continue;
    const idx = part.indexOf("${");
    if (idx === -1) {
      // 模板字符串里的条件类可能带收尾引号（如 `... ? " gzs-root--split" : ...`），
      // 引号不是类名的一部分，先剥掉再做 CSS 对照。
      const normalized = part.replace(/["'`),;]+$/g, "");
      if (normalized) staticUsed.add(normalized);
      continue;
    }
    // `gzs-badge--${...}` → 前缀取到 `--` 结束；`gzs-x-${...}` 则取到插值前
    const dash = part.lastIndexOf("--", idx);
    const prefix = dash > 0 ? part.slice(0, dash + 2) : part.slice(0, idx);
    templatePrefixes.add(prefix.replace(/["'`),;]+$/g, ""));
  }
};

for (const m of src.matchAll(/className:\s*"([^"]+)"/g)) scan(m[1]);
for (const m of src.matchAll(/className:\s*`([^`]+)`/g)) scan(m[1]);

const missingStatic = [...staticUsed].filter((c) => !defined.has(c)).sort();
const missingVariants = [...templatePrefixes]
  .filter((p) => !p || ![...defined].some((d) => d.startsWith(p)))
  .sort();

console.log(`类名自检：静态类 ${staticUsed.size} 个，模板前缀 ${templatePrefixes.size} 个，CSS 定义 ${defined.size} 个`);
if (missingStatic.length) console.log(`静态类未定义（${missingStatic.length}）：${missingStatic.join(", ")}`);
if (missingVariants.length) console.log(`模板前缀无任何变体（${missingVariants.length}）：${missingVariants.join(", ")}`);
if (missingStatic.length || missingVariants.length) process.exit(1);
console.log("类名自检：OK（没有用到未定义的类）");
