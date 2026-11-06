/**
 * 真源数据源的单元测（**直接调 lib，不走 HTTP**）。
 *
 * 覆盖四件事：
 * 1. `lib/repo.js`：扫 33 篇稿件、七条内容线计数、单篇分节；
 * 2. 栅栏：`../secret`、`C:\Windows`、UNC、绝对路径、符号链接逃逸全部拒绝；
 * 3. `lib/video.js`：`FDE-01` 只有分段索引时也能返回结构完整的结果；
 * 4. 质量门的 JSON 解析（纯函数，快）+ 真跑一次 `gate status`（慢测，允许跳过）。
 *
 * 用法：
 * ```
 * node verify/source-unit.mjs
 * ```
 * 末尾必须打一行 `✅ …`；任何一条断言失败就非零退出。
 * @module verify/source-unit
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  repoRoot, scriptsRoot, scanArticles, readArticle, resolveArticleDir,
  parseDirName, parseSections, parseFrontmatter, parseGateJson, toGateView,
  gateStatus, clearGateCache, HTML_LIMIT, REPO_ENV,
} from "../lib/repo.js";
import {
  scanEpisodes, readEpisode, parseSegments, parseStoryboard, parseStoryboardJson, parseSubtitles, safeEpisodeId,
} from "../lib/video.js";

let passed = 0;
const failures = [];

/** 跑一条断言，打一行 `✓`；失败记下来继续（一次跑完所有问题比断在第一处有用）。 */
async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}（${Date.now() - started} ms）`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n      ${String(error?.message ?? error).split("\n").slice(0, 6).join("\n      ")}`);
  }
}

/** 断言某个调用以指定 HTTP 状态被拒。 */
async function rejects(promise, status, note) {
  let thrown = null;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, `${note}：本该被拒，却成功了`);
  if (status !== "*") assert.equal(thrown.status, status, `${note}：期望 ${status}，实得 ${thrown.status}（${thrown.message}）`);
  return thrown;
}

const tmpRoots = [];

async function main() {
  // ── 1. 真仓库扫描 ─────────────────────────────────────────────────────────
  console.log("\n[1] 扫真源仓库（03-scripts）");
  const scan = await scanArticles();
  let articleTotal = 0;

  await check("repoRoot 指向社媒仓，`03-scripts` 存在", async () => {
    assert.equal(scan.root, repoRoot());
    assert.ok(scan.root.endsWith("social-media-management"), `root 不对劲：${scan.root}`);
    assert.ok(scan.root === scriptsRoot().replace(/[\\/]03-scripts$/, ""));
  });

  await check("扫到 33 篇稿件（一篇一个目录）", async () => {
    articleTotal = scan.articles.length;
    assert.equal(articleTotal, 33, `实得 ${articleTotal} 篇`);
  });

  await check("七条内容线计数与盘面一致，合计等于稿件数", async () => {
    const byLine = Object.fromEntries(scan.lines.map((row) => [row.line, row.count]));
    assert.deepEqual(
      { ...byLine },
      {
        "fde-practice": 21,
        viewpoint: 6,
        "training-event": 5,
        workbuddy: 1,
        // 这三个目录在盘上存在但没有「稿件目录」：
        // knowledge / marketing 只有 README，published 是已发归档（平铺 .md，不是稿件目录）
        knowledge: 0,
        marketing: 0,
        published: 0,
      },
    );
    const sum = scan.lines.reduce((total, row) => total + row.count, 0);
    assert.equal(sum, articleTotal, `线计数合计 ${sum} ≠ 稿件数 ${articleTotal}`);
    // 有稿件的内容线是 4 条；空目录也算线（不藏盘上的东西），面板可以按 count>0 过滤
    assert.equal(scan.lines.filter((row) => row.count > 0).length, 4);
  });

  await check("每条文章的 files 只有五个键，且类型正确（不读正文）", async () => {
    for (const article of scan.articles) {
      assert.deepEqual(Object.keys(article.files).sort(), ["evidence", "html", "images", "intent", "review"]);
      for (const key of ["intent", "evidence", "review", "html"]) {
        assert.equal(typeof article.files[key], "boolean", `${article.dir} 的 files.${key} 不是布尔`);
      }
      assert.equal(typeof article.files.images, "number", `${article.dir} 的 files.images 不是数字`);
      assert.ok(article.dir.includes("/"), `${article.dir} 应该带内容线前缀`);
      assert.ok(article.title && article.title.length > 0, `${article.dir} 没有 title`);
    }
  });

  await check("files 与盘面对得上（第 21 期只有 index+排版；images 只数图）", async () => {
    const one = scan.articles.find((row) => row.id === "2026-08-03_官方号_第21期_AI演示编排");
    assert.ok(one, "没扫到第 21 期");
    assert.equal(one.files.html, true);
    assert.equal(one.files.intent, false);
    assert.equal(one.files.evidence, false);
    assert.equal(one.files.review, false);
    assert.equal(one.files.images, 0);

    const withImages = scan.articles.find((row) => row.id.includes("第二场跨行业私享会"));
    assert.ok(withImages, "没扫到「第二场跨行业私享会」");
    assert.equal(withImages.files.intent, true);
    // images/ 里 8 个文件，其中一个是 README.md → 只数图，实得 7
    assert.equal(withImages.files.images, 7, `实得 ${withImages.files.images} 张`);
  });

  await check("目录名解析：日期_账号_第NN期_标题 / 培训线无账号段", async () => {
    assert.deepEqual(parseDirName("2026-08-03_官方号_第21期_AI演示编排"), { date: "2026-08-03", title: "AI演示编排" });
    assert.deepEqual(parseDirName("2026-07-30_官方号_AI能力测评投放文案"), { date: "2026-07-30", title: "AI能力测评投放文案" });
    assert.deepEqual(parseDirName("2026-08-03_培训回顾_Merck线上AI工作流实战"), { date: "2026-08-03", title: "培训回顾 Merck线上AI工作流实战" });
    assert.deepEqual(parseDirName("没有日期前缀的目录"), { date: "", title: "没有日期前缀的目录" });
    const inList = scan.articles.find((row) => row.id === "2026-08-03_官方号_第21期_AI演示编排");
    assert.equal(inList.title, "AI演示编排");
  });

  // ── 2. 单篇 ───────────────────────────────────────────────────────────────
  console.log("\n[2] 读单篇（readArticle）");
  const HARNESS = "viewpoint/2026-09-18_官方号_用DSH改造你项目的harness";

  await check("真实目录：title / date / line / sections 都读得出来", async () => {
    const one = await readArticle("fde-practice/2026-08-03_官方号_第21期_AI演示编排");
    assert.equal(one.dir, "fde-practice/2026-08-03_官方号_第21期_AI演示编排");
    assert.equal(one.line, "fde-practice");
    assert.equal(one.date, "2026-08-03");
    assert.equal(one.title, "一场 25 分钟 AI 演示，为什么不能全部现场生成？", "title 应取稿件自己的标题");
    assert.ok(one.sections.length >= 5, `只切出 ${one.sections.length} 节`);
    for (const section of one.sections) {
      assert.equal(typeof section.heading, "string");
      assert.equal(typeof section.body, "string");
    }
    assert.ok(one.sections.some((section) => section.heading.startsWith("一、")), "没切到 H2 小标题");
    assert.ok(one.html.includes("<"), "没读到 site/article.html");
    assert.equal(one.htmlTruncated, false);
    assert.equal(one.htmlBytes, Buffer.byteLength(one.html, "utf8"));
    assert.equal(one.intent, "", "第 21 期没有 intent.md，应回空串而不是报错");
    assert.equal(one.evidence, "");
    assert.equal(one.review, "");
    assert.equal(one.frontmatter.issue, "21");
    // 正文里不该带 H1（标题已经单独给了）也不该带 frontmatter
    assert.ok(!/^#\s/m.test(one.sections[0].body), "导语里还留着 H1");
    assert.ok(!one.sections[0].body.includes("confidential:"), "frontmatter 漏进正文了");
  });

  await check("只给稿件目录名也能读（gate 就是这么传的）", async () => {
    const one = await readArticle("2026-08-03_官方号_第21期_AI演示编排");
    assert.equal(one.dir, "fde-practice/2026-08-03_官方号_第21期_AI演示编排");
    assert.equal(one.sections.length >= 5, true);
  });

  await check("四件齐全的稿子：intent / evidence / review / html 都是正文", async () => {
    const one = await readArticle(HARNESS);
    assert.ok(one.intent.includes("意图"), "intent.md 没读出来");
    assert.ok(one.evidence.length > 100, "evidence.md 太短，可能没读到");
    assert.ok(one.review.length > 100, "review.md 太短，可能没读到");
    assert.ok(one.html.includes("<!DOCTYPE") || one.html.includes("<html"), "排版稿不像 HTML");
    assert.equal(one.frontmatter.content_line, "viewpoint");
    assert.equal(one.frontmatter.business_category, "observation");
  });

  await check("sections 用 H2/H3 切节、正文保留段落换行", async () => {
    const one = await readArticle(HARNESS);
    assert.ok(one.sections.length >= 4);
    const body = one.sections.map((section) => section.body).join("\n");
    assert.ok(body.includes("\n\n"), "段落换行被吃掉了");
    const parsed = parseSections("## 甲\n\n一\n\n二\n\n### 乙\n\n三\n");
    assert.deepEqual(parsed.map((section) => section.heading), ["甲", "乙"]);
    assert.equal(parsed[0].body.includes("\n\n"), true);
    // 没有 H2 就整篇一节
    assert.deepEqual(parseSections("只有正文。\n\n第二段。"), [{ heading: "", body: "只有正文。\n\n第二段。" }]);
    assert.deepEqual(parseSections(""), []);
  });

  await check("frontmatter 解析：键值 / 列表 / 去引号", async () => {
    const { data, body } = parseFrontmatter('---\nid: X\nissue: "21"\nsources:\n  - internal: 甲\n  - 乙\n---\n\n正文');
    assert.equal(data.id, "X");
    assert.equal(data.issue, "21");
    assert.deepEqual(data.sources, ["internal: 甲", "乙"]);
    assert.equal(body.trim(), "正文");
  });

  // ── 3. 栅栏 ───────────────────────────────────────────────────────────────
  console.log("\n[3] 路径栅栏（越界一律拒）");
  await check("readArticle 拒绝 ../secret / C:\\Windows / UNC / 绝对路径 / 空参数", async () => {
    const cases = [
      ["../secret", 400],
      ["..\\secret", 400],
      ["C:\\Windows", 400],
      ["c:/windows/system32", 400],
      ["\\\\server\\share\\x", 400],
      ["//server/share/x", 400],
      ["/etc/passwd", 400],
      ["fde-practice/../../../secret", 400],
      ["fde-practice/..", 400],
      ["", 400],
      ["   ", 400],
    ];
    for (const [input, status] of cases) {
      const error = await rejects(readArticle(input), status, `readArticle(${JSON.stringify(input)})`);
      assert.ok(error.message.length > 0, "错误没有说明");
    }
  });

  await check("不存在 / 指到内容线 / 指到文件：404 而不是 200", async () => {
    await rejects(readArticle("fde-practice/不存在的稿件"), 404, "不存在的目录");
    await rejects(readArticle("fde-practice"), 404, "内容线本身不是稿件目录");
    await rejects(readArticle("published/2026-07-08_官方号_FDE正在成为AI落地最稀缺的角色.md"), 404, "平铺的 md 不是稿件目录");
  });

  await check("resolveArticleDir 只回规范相对路径（可直接回传给路由）", async () => {
    const target = await resolveArticleDir("2026-08-03_官方号_第21期_AI演示编排");
    assert.equal(target.dir, "fde-practice/2026-08-03_官方号_第21期_AI演示编排");
    assert.equal(target.id, "2026-08-03_官方号_第21期_AI演示编排");
    assert.ok(target.abs.startsWith(scriptsRoot()));
    const again = await resolveArticleDir(target.dir);
    assert.equal(again.abs, target.abs);
  });

  // ── 4. 视频 ───────────────────────────────────────────────────────────────
  console.log("\n[4] 视频号（07-video/episode）");
  const videoScan = await scanEpisodes();

  await check("扫到 FDE-01，status 是「步骤词 · 完成数/8」，files 八个键", async () => {
    assert.ok(videoScan.root.endsWith(join("07-video", "episode")), `root 不对劲：${videoScan.root}`);
    assert.ok(videoScan.episodes.length >= 1);
    const one = videoScan.episodes.find((episode) => episode.id === "FDE-01");
    assert.ok(one, "没扫到 FDE-01");
    assert.equal(one.dir, "FDE-01");
    assert.match(one.status, /^.* · [0-8]\/8$/, `status 形态不对：${one.status}`);
    assert.equal(one.status, "分段 · 1/8", "盘上只有分段索引，应该只完成 1 步");
    // 八个键全给：面板的方块按这个画，裁成六个就会出现「1/8 但方块全空」
    assert.deepEqual(Object.keys(one.files).sort(),
      ["audio", "cover", "final", "outline", "script", "segments", "storyboard", "subtitle"]);
    for (const [key, value] of Object.entries(one.files)) {
      assert.equal(typeof value, "boolean", `files.${key} 不是布尔`);
    }
    // 与 status 自洽：亮的方块数 == 完成数
    assert.equal(Object.values(one.files).filter(Boolean).length, 1, "只该亮「分段」这一件");
    assert.equal(one.files.segments, true, "分段索引在盘上 → 分段那一步该亮");
  });

  await check("只有分段索引时 readEpisode 不抛错，结构完整", async () => {
    const episode = await readEpisode("FDE-01");
    assert.equal(episode.id, "FDE-01");
    assert.equal(episode.dir, "FDE-01");
    assert.equal(episode.script, "");
    assert.deepEqual(episode.storyboard, []);
    assert.deepEqual(episode.subtitles, []);
    assert.equal(episode.segments.length, 3, `分段表解析出 ${episode.segments.length} 条`);
    assert.deepEqual(episode.segments[0], { no: 1, file: "talk_seg1.wav", range: "0 → 31.999s", duration: "32.00s" });
    assert.equal(episode.segments[2].no, 3);
    assert.ok(episode.note.includes("还没有"), `note 没说明缺什么：${episode.note}`);
    assert.ok(episode.note.includes("口播稿"), "note 应点名缺口播稿");
  });

  await check("分期栅栏：../、路径分隔符、盘符、空参数一律 400", async () => {
    for (const bad of ["../FDE-01", "FDE-01/sub", "C:\\Windows", "", ".", "..", "FDE-01\u0000x"]) {
      await rejects(readEpisode(bad), 400, `readEpisode(${JSON.stringify(bad)})`);
    }
    await rejects(readEpisode("FDE-99"), 404, "不存在的期");
    assert.equal(safeEpisodeId(" FDE-01 "), "FDE-01");
  });

  await check("表格 / 字幕解析（给以后有分镜、有字幕的期用）", async () => {
    const storyboard = parseStoryboard([
      "| 镜号 | 时间 | 画面 | 口播 |",
      "|---|---|---|---|",
      "| 1 | 0-3s | 演播室全景 | 大家好 |",
      "| 2 | 3-8s | 屏幕实操 | 先看这一段 |",
    ].join("\n"));
    assert.deepEqual(storyboard[1], { shot: "2", time: "3-8s", title: "屏幕实操", text: "先看这一段" });

    const subtitles = parseSubtitles("1\n00:00:00,000 --> 00:00:02,500\n第一句\n\n2\n00:00:02,500 --> 00:00:05,000\n第二句\n");
    assert.equal(subtitles.length, 2);
    assert.deepEqual(subtitles[0], { index: 1, start: "00:00:00.000", end: "00:00:02.500", text: "第一句" });

    assert.deepEqual(parseSegments("没有表的正文"), []);
    assert.deepEqual(parseStoryboard(""), []);
    assert.deepEqual(parseSubtitles(""), []);

    // JSON 分镜（以后排版脚本产出时可能用它）
    assert.deepEqual(parseStoryboardJson('[{"镜号":1,"时间":"0-3s","画面":"全景","口播":"大家好"}]'),
      [{ shot: "1", time: "0-3s", title: "全景", text: "大家好" }]);
    assert.deepEqual(parseStoryboardJson("{坏的"), []);
  });

  // ── 5. 临时仓：截断 / 缺件 / 符号链接逃逸 ─────────────────────────────────
  console.log("\n[5] 临时真源仓（不碰真实仓）：截断、缺件、符号链接逃逸");
  const tmp = await mkdtemp(join(tmpdir(), "gzs-source-"));
  tmpRoots.push(tmp);
  const previousRepo = process.env[REPO_ENV];
  process.env[REPO_ENV] = tmp;

  try {
    const bigHtml = `<!DOCTYPE html><html><body>${"很长的排版稿。".repeat(30_000)}</body></html>`;
    const articleDir = join(tmp, "03-scripts", "demo", "2026-01-01_官方号_第01期_超大稿");
    await mkdir(join(articleDir, "site"), { recursive: true });
    await mkdir(join(articleDir, "images"), { recursive: true });
    await writeFile(join(articleDir, "index.md"), "# 超大稿\n\n## 一节\n\n正文。\n\n## 二节\n\n第二段。\n", "utf8");
    await writeFile(join(articleDir, "site", "article.html"), bigHtml, "utf8");
    await writeFile(join(articleDir, "images", "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(articleDir, "images", "README.md"), "不是图", "utf8");

    // 没有 index.md 的空壳稿（第 21 期那种只有排版、或干脆什么都没有）
    const bareDir = join(tmp, "03-scripts", "demo", "2026-01-02_官方号_第02期_空壳");
    await mkdir(bareDir, { recursive: true });

    // 期目录：带分镜表 + 字幕 + 口播稿（验证「以后加了也照读」）
    const episodeDir = join(tmp, "07-video", "episode", "DEMO-01");
    await mkdir(join(episodeDir, "audio-segments"), { recursive: true });
    await writeFile(join(episodeDir, "口播稿.md"), "# 口播稿\n\n大家好，今天讲三件事。\n", "utf8");
    await writeFile(join(episodeDir, "分镜.md"), "| 镜号 | 时间 | 画面 | 口播 |\n|---|---|---|---|\n| 1 | 0-3s | 全景 | 大家好 |\n", "utf8");
    await writeFile(join(episodeDir, "字幕.srt"), "1\n00:00:00,000 --> 00:00:02,000\n大家好\n", "utf8");
    await writeFile(join(episodeDir, "audio-segments", "分段索引.md"), "## 分段表\n\n| 段号 | 文件 | 区间 | 时长 |\n|---|---|---|---|\n| 1 | a.wav | 0 → 2s | 2.00s |\n", "utf8");

    await check("临时仓：扫到 1 篇 + 1 条线，images 只数图不数 README", async () => {
      const list = await scanArticles();
      assert.equal(list.root, tmp);
      assert.deepEqual(list.lines, [{ line: "demo", count: 2 }]);
      const one = list.articles.find((row) => row.id.includes("超大稿"));
      assert.equal(one.files.images, 1, `实得 ${one.files.images}`);
      assert.equal(one.files.html, true);
      assert.equal(one.files.intent, false);
    });

    await check("临时仓：html > 200 KB 截断并标 htmlTruncated", async () => {
      const one = await readArticle("demo/2026-01-01_官方号_第01期_超大稿");
      assert.equal(one.htmlTruncated, true);
      assert.ok(one.htmlBytes > HTML_LIMIT, `htmlBytes=${one.htmlBytes}`);
      assert.ok(Buffer.byteLength(one.html, "utf8") <= HTML_LIMIT, "截断后仍超上限");
      assert.ok(one.html.startsWith("<!DOCTYPE html>"), "截断把开头吃掉就废了");
    });

    await check("临时仓：没有 index.md 的稿子不抛错（sections 空 + 标题回退目录名）", async () => {
      const one = await readArticle("demo/2026-01-02_官方号_第02期_空壳");
      assert.deepEqual(one.sections, []);
      assert.equal(one.title, "空壳");
      assert.equal(one.html, "");
      assert.equal(one.date, "2026-01-02");
    });

    await check("临时仓：符号链接指到 03-scripts 外面 → 拒绝（realpath 第二道）", async () => {
      const outside = join(tmp, "outside-secret");
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "index.md"), "# 外面\n", "utf8");
      const link = join(tmp, "03-scripts", "demo", "link-escape");
      try {
        await symlink(outside, link, "junction");
      } catch (error) {
        console.log(`      （跳过符号链接用例：本机建不了 junction —— ${error.code ?? error.message}）`);
        return;
      }
      const error = await rejects(readArticle("demo/link-escape"), 400, "符号链接逃逸");
      assert.match(error.message, /越界|03-scripts/, `错误信息应说清越界：${error.message}`);
    });

    await check("临时仓：有料的一期能读出分镜 / 字幕 / 口播稿", async () => {
      const list = await scanEpisodes();
      const one = list.episodes.find((episode) => episode.id === "DEMO-01");
      assert.ok(one);
      // 口播稿 / 分镜 / 分段 / 字幕 四步有料；封面与成片还没有 → 停在「字幕」
      assert.equal(one.status, "字幕 · 4/8", `实得 ${one.status}`);
      const episode = await readEpisode("DEMO-01");
      assert.ok(episode.script.includes("今天讲三件事"));
      assert.equal(episode.storyboard.length, 1);
      assert.equal(episode.subtitles.length, 1);
      assert.equal(episode.segments.length, 1);
      assert.equal(episode.note, "", `四件都读到了就不该有 note：${episode.note}`);
    });
  } finally {
    if (previousRepo === undefined) delete process.env[REPO_ENV];
    else process.env[REPO_ENV] = previousRepo;
    for (const dir of tmpRoots) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  // ── 6. 质量门：解析（纯函数）──────────────────────────────────────────────
  console.log("\n[6] 质量门 JSON 解析（纯函数）");
  await check("从最后一个「JSON：」之后取 JSON（前面有同名标记也不误取）", async () => {
    const sample = [
      "⚠ 本机没有配置审阅 key",
      "稿件：… （runId X，内容线 fde-practice）",
      "  0 开工同步  未开始",
      "JSON：",
      '{"命令":"status","runId":"old","步骤":[]}',
      "换一份：",
      "JSON：",
      '{"命令":"status","稿件":"D:\\\\x","runId":"X","内容线":"fde-practice","步骤":[{"编号":0,"名称":"开工同步","结论":"未开始","轮次":0,"过门":true}],"下一步":0}',
    ].join("\n");
    const doc = parseGateJson(sample);
    assert.ok(doc, "没解析到 JSON");
    assert.equal(doc.runId, "X");

    const view = toGateView(doc, "fde-practice/X");
    assert.deepEqual(view, {
      dir: "fde-practice/X",
      runId: "X",
      line: "fde-practice",
      steps: [{ no: 0, name: "开工同步", verdict: "未开始", round: 0, pass: true }],
      next: 0,
    });
    assert.equal(parseGateJson("只有人看的表格，没有 JSON"), null);
    assert.equal(parseGateJson("JSON：\n{坏的"), null);
  });

  await check("英文键的 JSON 也认（check / 老版本口径）", async () => {
    const view = toGateView({ runId: "Y", line: "viewpoint", steps: [{ no: 3, name: "出方案", verdict: "通过", round: 2, pass: true }], next: 4 }, "viewpoint/Y");
    assert.deepEqual(view.steps, [{ no: 3, name: "出方案", verdict: "通过", round: 2, pass: true }]);
    assert.equal(view.next, 4);
  });

  // ── 7. 质量门：真跑（慢测）────────────────────────────────────────────────
  console.log("\n[7] 质量门真跑 gate status（慢测，允许跳过）");
  const gateDir = "fde-practice/2026-08-03_官方号_第21期_AI演示编排";
  const gateScriptMissing = await (async () => {
    try {
      await import("node:fs/promises").then(({ stat }) => stat(join(repoRoot(), "..", "wechat-article-pipeline", "gate", "index.mjs")));
      return false;
    } catch {
      return true;
    }
  })();

  if (gateScriptMissing) {
    console.log("  ⚠ 跳过：本机没有 wechat-article-pipeline/gate/index.mjs，真跑不了");
  } else {
    await check("真跑一次：11 步（0–10）、中文键映射成英文键", async () => {
      const started = Date.now();
      clearGateCache();
      const view = await gateStatus(gateDir);
      const cost = Date.now() - started;
      console.log(`      真跑耗时 ${cost} ms`);
      assert.equal(view.dir, gateDir);
      assert.equal(view.line, "fde-practice");
      assert.equal(view.runId, "2026-08-03_官方号_第21期_AI演示编排");
      assert.equal(view.steps.length, 11, `实得 ${view.steps.length} 步`);
      assert.deepEqual(view.steps.map((step) => step.no), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      assert.equal(view.steps[0].name, "开工同步");
      assert.equal(view.steps[10].name, "自我迭代");
      for (const step of view.steps) {
        assert.equal(typeof step.verdict, "string");
        assert.equal(typeof step.round, "number");
        assert.equal(typeof step.pass, "boolean");
      }
      assert.equal(typeof view.next, "number");
    });

    await check("缓存：同一 dir 第二次不再真跑（< 200 ms，且结果一致）", async () => {
      const first = await gateStatus(gateDir);
      const started = Date.now();
      const second = await gateStatus(gateDir);
      const cost = Date.now() - started;
      console.log(`      缓存命中耗时 ${cost} ms`);
      assert.ok(cost < 200, `第二次仍花了 ${cost} ms，缓存没生效`);
      assert.deepEqual(second, first);
      // ttl=0 强制重跑也要能跑通（面板「强制刷新」那条路）
      const forced = await gateStatus(gateDir, { ttl: 0 });
      assert.equal(forced.steps.length, 11);
    });

    await check("gate 也走同一套栅栏：越界参数 400，且不会起子进程", async () => {
      for (const bad of ["../secret", "C:\\Windows", "/etc/passwd", ""]) {
        await rejects(gateStatus(bad), 400, `gateStatus(${JSON.stringify(bad)})`);
      }
      await rejects(gateStatus("fde-practice/不存在的稿件"), 404, "不存在的稿件");
    });
  }

  // ── 汇总 ──────────────────────────────────────────────────────────────────
  console.log("");
  if (failures.length) {
    console.log(`✗ source-unit 失败 ${failures.length} 条：${failures.map((row) => row.name).join("；")}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `✅ source-unit 全绿：${passed} 条断言 · 稿件 ${articleTotal} 篇 / 内容线 ${scan.lines.length} 条`
    + ` · FDE-01 只有分段索引也能读 · 质量门 11 步（真实跑 + 5 分钟缓存）`,
  );
}

await main();
