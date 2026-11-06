/**
 * 导出器：把一篇 `article.json` 渲染成公众号能直接吃的 HTML、Markdown，以及图片上传清单。
 * **纯函数**（除了读模板 token），宿主半与 verify 单测共用。
 *
 * 为什么全部内联 style：公众号后台保存草稿时会把 `<style>` 标签、`class` 属性整段剥掉，
 * 只留行内样式。所以这里一条 class 都不发，所有样式都写在 `style="…"` 里。
 *
 * 图片为什么不内嵌：正文里的图必须是 `mmbiz.qpic.cn` 的远端地址，本地文件贴不进去。
 * 所以导出时图片位置写成占位符 `__IMG_01__`，另附一份「先传哪张、对应哪个占位符」的清单，
 * 上传完在后台把占位符替换成素材库地址。**不假装能一键发布**。
 * @module lib/render
 */

import { templateOf } from "./templates.js";

/** HTML 转义（正文里的 `<` `&` 不能原样吐进去）。 */
export function esc(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 正文极简行内语法：`**加粗**` → `<strong>`。
 * 有意只支持这一条——多一条语法，作者就会开始写 Markdown 里公众号不支持的东西。
 */
function inline(text) {
  return esc(text).replace(/\*\*([^*\n]+)\*\*/g, '<strong style="font-weight:600">$1</strong>');
}

/** 段落的占位符名（封面单独一个，正文按顺序）。 */
export const COVER_PLACEHOLDER = "__IMG_COVER__";
/** @param {number} index 段落下标（0 起） */
export const sectionPlaceholder = (index) => `__IMG_${String(index + 1).padStart(2, "0")}__`;

/**
 * 图片清单：导出前先告诉人「这几张要手工传、对应哪个占位符」。
 * @param {object} article
 * @returns {Array<{placeholder: string, slot: string, vid: string, file: string, width: number, height: number, label: string, prompt: string}>}
 */
export function imageChecklist(article) {
  const out = [];
  const cover = article?.cover ?? {};
  const coverVersion = pickVersion(cover);
  if (coverVersion) {
    out.push({
      placeholder: COVER_PLACEHOLDER,
      slot: "cover",
      vid: coverVersion.vid,
      file: coverVersion.file,
      width: coverVersion.width,
      height: coverVersion.height,
      label: "封面（首图 2.35:1）",
      prompt: coverVersion.prompt ?? cover.prompt ?? "",
    });
  }
  (article?.sections ?? []).forEach((section, index) => {
    const version = pickVersion(section?.image);
    if (!version) return;
    out.push({
      placeholder: sectionPlaceholder(index),
      slot: section?.image?.slot ?? `sec-${index + 1}`,
      vid: version.vid,
      file: version.file,
      width: version.width,
      height: version.height,
      label: `第 ${index + 1} 段配图`,
      prompt: version.prompt ?? section?.image?.prompt ?? "",
    });
  });
  return out;
}

/** 取某个槽位的「当前版本」；current 指向失效时退回最新一版（不返回 null 让调用方崩）。 */
export function pickVersion(image) {
  const versions = Array.isArray(image?.versions) ? image.versions : [];
  if (!versions.length) return null;
  return versions.find((v) => v.vid === image.current) ?? versions[versions.length - 1];
}

/**
 * 公众号正文 HTML（不含 <html>/<body>，直接粘进后台编辑器）。
 * @param {object} article
 * @param {{template?: string}} [options]
 * @returns {{html: string, checklist: ReturnType<typeof imageChecklist>}}
 */
export function renderWechatBody(article, options = {}) {
  const t = templateOf(article?.template ?? options.template).tokens;
  const parts = [];

  const h2 = (text) =>
    `<h2 style="margin:34px 0 14px;font-size:${t.h2Size}px;line-height:1.5;font-weight:700;color:${t.ink};font-family:${t.fontTitle};` +
    (t.h2Bar ? `border-left:4px solid ${t.accent};padding-left:10px;` : "") +
    `">${t.h2Prefix ? `<span style="color:${t.accent};margin-right:6px">${esc(t.h2Prefix)}</span>` : ""}${inline(text)}</h2>`;

  const p = (text, extra = "") =>
    `<p style="margin:0 0 ${t.paraGap}px;font-size:${t.bodySize}px;line-height:${t.bodyLine};color:${t.ink};font-family:${t.font};letter-spacing:${t.letterSpacing}px;${extra}">${inline(text)}</p>`;

  const divider = () => {
    if (t.divider === "line") {
      return `<section style="margin:30px 0;border-top:1px solid ${t.rule};line-height:0;font-size:0">&nbsp;</section>`;
    }
    if (t.divider === "dots") {
      return `<p style="margin:30px 0;text-align:center;color:${t.rule};letter-spacing:8px;font-size:14px">· · ·</p>`;
    }
    return "";
  };

  // 封面
  const coverVersion = pickVersion(article?.cover);
  if (coverVersion) {
    parts.push(
      `<section style="margin:0 0 26px;text-align:center">` +
        `<img src="${COVER_PLACEHOLDER}" style="width:100%;display:block;border-radius:${t.radius}px${t.imgShadow ? `;box-shadow:0 8px 24px rgba(0,0,0,.12)` : ""}" alt="${esc(article?.title ?? "封面")}" />` +
        `</section>`,
    );
  }

  // 标题 + 摘要 + 署名行
  if (article?.title) {
    parts.push(
      `<h1 style="margin:0 0 12px;font-size:24px;line-height:1.45;font-weight:700;color:${t.ink};font-family:${t.fontTitle};letter-spacing:.5px">${inline(article.title)}</h1>`,
    );
  }
  if (article?.subtitle) {
    parts.push(
      `<p style="margin:0 0 16px;font-size:14px;line-height:1.7;color:${t.sub};font-family:${t.font}">${inline(article.subtitle)}</p>`,
    );
  }
  if (article?.summary) {
    parts.push(
      `<section style="margin:0 0 28px;padding:14px 16px;background:${t.accentSoft};border-radius:${t.radius}px">` +
        `<p style="margin:0;font-size:14px;line-height:1.8;color:${t.sub};font-family:${t.font}">${inline(article.summary)}</p>` +
        `</section>`,
    );
  }
  parts.push(divider());

  // 正文分段落
  const sections = Array.isArray(article?.sections) ? article.sections : [];
  sections.forEach((section, index) => {
    const heading = String(section?.heading ?? "").trim();
    const body = String(section?.body ?? "").trim();
    if (heading) parts.push(h2(heading));

    // 首字下沉只对「正文的第一段」生效，插在第一个 <p> 里
    let injected = false;
    const paragraphs = body.split(/\n{2,}|\r\n{2,}/).map((s) => s.replace(/\r?\n/g, " ").trim()).filter(Boolean);
    for (const paragraph of paragraphs) {
      if (t.dropCap && !injected && index === 0 && paragraph.length > 2) {
        const first = [...paragraph][0];
        const rest = paragraph.slice(first.length);
        parts.push(
          `<p style="margin:0 0 ${t.paraGap}px;font-size:${t.bodySize}px;line-height:${t.bodyLine};color:${t.ink};font-family:${t.font};letter-spacing:${t.letterSpacing}px">` +
            `<span style="float:left;font-size:${Math.round(t.bodySize * 2.8)}px;line-height:.9;padding:2px 8px 0 0;color:${t.accent};font-family:${t.fontTitle}">${esc(first)}</span>${inline(rest)}</p>`,
        );
        injected = true;
      } else {
        parts.push(p(paragraph));
      }
    }

    // 配图 + 图注
    const version = pickVersion(section?.image);
    if (version) {
      parts.push(
        `<section style="margin:6px 0 26px;text-align:center">` +
          `<img src="${sectionPlaceholder(index)}" style="width:100%;display:block;border-radius:${t.radius}px${t.imgShadow ? `;box-shadow:0 8px 24px rgba(0,0,0,.12)` : ""}" alt="${esc(heading || `配图 ${index + 1}`)}" />` +
          (() => {
            const caption = String(section?.image?.caption ?? "").trim();
            return caption
              ? `<p style="margin:8px 0 0;font-size:12px;line-height:1.6;color:${t.caption};font-family:${t.font}">${inline(caption)}</p>`
              : "";
          })() +
          `</section>`,
      );
    }

    if (index < sections.length - 1) parts.push(divider());
  });

  return {
    // 左右留白：两份排版指南都给 8–16px（中位 10）。之前这里只有上下 2px、左右 0，
    // 手机上正文直接贴边——这是「排完版还是歪」最典型的来源。
    html: `<section style="background:${t.bg};padding:2px ${t.padSide ?? 10}px">${parts.join("\n")}</section>`,
    checklist: imageChecklist(article),
  };
}

/**
 * Markdown 导出：带 front matter，图片用占位符，方便丢进任意编辑器再加工。
 * @param {object} article
 */
export function renderMarkdown(article) {
  const lines = [];
  const yaml = (v) => String(v ?? "").replace(/\r?\n/g, " ").replace(/"/g, '\\"');
  lines.push("---");
  lines.push(`title: "${yaml(article?.title)}"`);
  if (article?.subtitle) lines.push(`subtitle: "${yaml(article.subtitle)}"`);
  if (article?.summary) lines.push(`summary: "${yaml(article.summary)}"`);
  if (article?.audience) lines.push(`audience: "${yaml(article.audience)}"`);
  if (article?.takeaway) lines.push(`takeaway: "${yaml(article.takeaway)}"`);
  lines.push(`template: "${yaml(article?.template)}"`);
  lines.push(`updated: "${new Date(Number(article?.updatedAt) || Date.now()).toISOString()}"`);
  lines.push("---", "");

  const coverVersion = pickVersion(article?.cover);
  if (coverVersion) lines.push(`![封面](${COVER_PLACEHOLDER})`, "");

  lines.push(`# ${String(article?.title ?? "").trim()}`, "");
  (Array.isArray(article?.sections) ? article.sections : []).forEach((section, index) => {
    const heading = String(section?.heading ?? "").trim();
    if (heading) lines.push(`## ${heading}`, "");
    const body = String(section?.body ?? "").trim();
    if (body) lines.push(body, "");
    if (pickVersion(section?.image)) lines.push(`![配图 ${index + 1}](${sectionPlaceholder(index)})`, "");
  });
  return lines.join("\n");
}

/**
 * 图片清单的文本版（导出面板右侧直接显示，也可以另存为 `图片清单.txt`）。
 * @param {object} article
 * @param {{articleDir?: string}} [options]
 */
export function renderChecklistText(article, options = {}) {
  const dir = options.articleDir ? String(options.articleDir) : "";
  const rows = imageChecklist(article);
  if (!rows.length) return "（还没有任何图。先在左侧逐张出图。）";
  const lines = ["公众号图片上传清单（先传素材库，再把占位符换成素材库地址）", ""];
  rows.forEach((row, index) => {
    lines.push(`${index + 1}. ${row.label}  →  占位符 ${row.placeholder}`);
    lines.push(`   版本 ${row.vid}  ·  ${row.width}×${row.height}${row.width && row.height ? `  ·  ${(row.width / row.height).toFixed(2)}:1` : ""}`);
    lines.push(`   文件 ${dir ? `${dir}/` : ""}${row.file}`);
    if (row.prompt) lines.push(`   prompt ${row.prompt}`);
    lines.push("");
  });
  return lines.join("\n");
}
