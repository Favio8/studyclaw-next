/**
 * PDF 辅助阅读端到端验收（真实 Edge + 静态导出产物，由 Host 同源托管）。
 *
 * 这是 jsdom 测不到的另一半：pdf.js 画布渲染、文本层命中、真实鼠标划词、
 * 高亮覆盖层的指针事件语义、窄容器下标注浮层的开合。
 *
 * 前置：
 *   1. `pnpm build:web` 产出 apps/web/out；
 *   2. `pnpm serve --port 8080 --insecure-no-token` 启动 Host 并打开一个
 *      含 PDF 资料的课程工作区（阅读树里要有 sources/lecture.pdf）。
 *   3. 本机装有 Edge（STUDYCLAW_EDGE 可覆盖路径）。
 *
 * 用法：node scripts/e2e-reader.mjs   （STUDYCLAW_BASE / OUT_DIR 可覆盖）
 */
import { chromium } from "playwright-core";
import { mkdir } from "node:fs/promises";

const EDGE = process.env.STUDYCLAW_EDGE ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const BASE = process.env.STUDYCLAW_BASE ?? "http://127.0.0.1:8080";
const OUT = process.env.OUT_DIR ?? "C:/Users/19949/AppData/Local/Temp/opencode/e2e";

await mkdir(OUT, { recursive: true });

const results = [];
const step = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch({ executablePath: EDGE, headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();

const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

try {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/01-console.png` });

  // 进入「阅读」学习活动。
  const readingTab = page.getByRole("button", { name: /阅读/ }).first();
  if ((await readingTab.count()) === 0) {
    step("找到阅读活动入口", false, "控制台未渲染阅读入口");
  } else {
    await readingTab.click();
    await page.waitForTimeout(1200);
    step("切到阅读活动", true);
  }

  // 资料树：点击 lecture.pdf（自动打开首份 PDF 时可能已打开）。
  const pdfItem = page.locator('button[title="sources/lecture.pdf"]');
  if ((await pdfItem.count()) > 0) {
    await pdfItem.first().click();
    await page.waitForTimeout(2500);
  }
  await page.screenshot({ path: `${OUT}/02-reader-pdf.png` });

  const pageEl = page.getByTestId("pdf-page");
  step("PDF 页面元素渲染", (await pageEl.count()) > 0);

  const canvasBox = await page.locator("canvas").first().boundingBox();
  step(
    "canvas 有实际尺寸",
    canvasBox !== null && canvasBox.width > 50 && canvasBox.height > 50,
    canvasBox === null ? "no box" : `${Math.round(canvasBox.width)}x${Math.round(canvasBox.height)}`,
  );

  const textLayer = page.getByTestId("pdf-text-layer");
  const spanCount = await textLayer.locator("span").count();
  step("文本层有 span（可选中）", spanCount > 0, `${spanCount} spans`);

  // 文本层字号/定位换算变量是否真的落到 CSS 上。
  const scaleInfo = await pageEl.evaluate((el) => {
    const layer = el.querySelector(".textLayer");
    const span = layer?.querySelector("span");
    const cs = span === null || span === undefined ? null : getComputedStyle(span);
    return {
      totalScaleFactor: getComputedStyle(el).getPropertyValue("--total-scale-factor").trim(),
      spanFontSize: cs === null ? null : cs.fontSize,
      spanLeft: cs === null ? null : cs.left,
      spanTop: cs === null ? null : cs.top,
      spanColor: cs === null ? null : cs.color,
      layerPosition: layer === null ? null : getComputedStyle(layer).position,
    };
  });
  console.log("  textLayer:", JSON.stringify(scaleInfo));
  step(
    "文本层按 --total-scale-factor 换算",
    scaleInfo.totalScaleFactor !== "" && scaleInfo.spanFontSize !== null,
    `factor=${scaleInfo.totalScaleFactor} fontSize=${scaleInfo.spanFontSize}`,
  );
  step("文本层为绝对定位覆盖层", scaleInfo.layerPosition === "absolute", String(scaleInfo.layerPosition));

  // 真实划词：把鼠标拖过第一段文字。
  const target = textLayer.locator("span").filter({ hasText: /\S/ }).first();
  const box = await target.boundingBox();
  if (box === null) {
    step("取得可划词的文本 span", false);
  } else {
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + Math.min(box.width - 2, 120), box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/03-selection.png` });
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    step("浏览器原生选区非空", selected.trim().length > 0, JSON.stringify(selected.slice(0, 40)));
  }

  const popover = page.getByTestId("selection-popover");
  step("划词浮层出现", (await popover.count()) > 0);

  if ((await popover.count()) > 0) {
    await page.getByRole("button", { name: "高亮（黄）" }).click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT}/04-highlighted.png` });
    const railText = await page.locator("text=/标注 \\d+/").first().textContent().catch(() => null);
    step("标注栏计数 +1", railText !== null && /标注 [1-9]/.test(railText), String(railText));
    step("浮层已收起", (await popover.count()) === 0);

    // 命中测试：高亮块坐标处的顶层元素必须属于 textLayer（可被选中的那层）。
    // 这是「已高亮原文仍可划词」的前提——高亮块曾是可点 button 且 DOM 序更靠后。
    step(
      "高亮块不吃指针事件（顶层命中为文本层）",
      await page.evaluate(() => {
        const m = document.querySelector('[data-testid="pdf-highlight-layer"] > div');
        if (m === null) return false;
        const r = m.getBoundingClientRect();
        const el = document.elementFromPoint(r.x + 2, r.y + r.height / 2);
        return el !== null && el.closest(".textLayer") !== null;
      }),
    );

    // 真实用户路径：在仍处于选中状态的原文上再次划词。
    // 先点空白处清掉旧选区（等价于用户换手重选），再跨高亮块拖拽。
    const markRect = await page.evaluate(() => {
      const m = document.querySelector('[data-testid="pdf-highlight-layer"] > div');
      if (m === null) return null;
      const r = m.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });
    if (markRect === null || markRect.w < 10) {
      step("找到已渲染的高亮块", false, JSON.stringify(markRect));
    } else {
      await page.mouse.click(950, 600); // 取消旧选区，避免浏览器启动原生 HTML5 drag
      await page.waitForTimeout(300);
      await page.mouse.move(markRect.x + 1, markRect.y + markRect.h / 2);
      await page.mouse.down();
      await page.mouse.move(markRect.x + Math.min(markRect.w - 1, 80), markRect.y + markRect.h / 2, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(600);
      const reselect = await page.evaluate(() => window.getSelection()?.toString() ?? "");
      step(
        "已高亮的原文仍可再次划词",
        reselect.trim().length > 0 && (await page.getByTestId("selection-popover").count()) > 0,
        JSON.stringify(reselect.slice(0, 30)),
      );
      await page.screenshot({ path: `${OUT}/04b-reselect.png` });
    }
  }

  // 翻页。
  const nextBtn = page.getByRole("button", { name: "下一页" });
  const before = await page.locator("text=/\\d+ · \\d+%/").first().textContent().catch(() => null);
  if ((await nextBtn.count()) > 0 && (await nextBtn.isEnabled())) {
    await nextBtn.click();
    await page.waitForTimeout(1500);
    const after = await page.locator("text=/\\d+ · \\d+%/").first().textContent().catch(() => null);
    step("翻页更新页码", before !== after, `${before} -> ${after}`);
    await page.screenshot({ path: `${OUT}/05-page2.png` });
  }

  // 窄容器：标注栏退场为浮层，且必须能再关掉。
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.waitForTimeout(1500);
  const railToggle = page.getByRole("button", { name: "标注列表" });
  if ((await railToggle.count()) > 0) {
    await railToggle.click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${OUT}/08-narrow-rail.png` });
    const railVisible = await page.locator("text=/标注 \\d+/").first().isVisible().catch(() => false);
    step("窄容器标注浮层可打开", railVisible);
    // 回归：浮层曾盖住切换钮导致无法关闭。
    await railToggle.click({ timeout: 5000 });
    await page.waitForTimeout(500);
    step(
      "窄容器标注浮层可关闭",
      (await railToggle.getAttribute("aria-expanded")) === "false",
    );
    await page.screenshot({ path: `${OUT}/09-narrow-rail-closed.png` });
  } else {
    step("窄容器出现标注浮层切换钮", false, "未找到「标注列表」按钮");
  }

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.waitForTimeout(1200);
  step(
    "回到宽容器后标注栏恢复常驻",
    (await page.getByRole("button", { name: "标注列表" }).count()) === 0
      && (await page.locator("text=/标注 \\d+/").first().isVisible().catch(() => false)),
  );

  // 缩放自适应：窄化视口后 canvas 应按新宽度重排。
  const wideBox = await page.locator("canvas").first().boundingBox();
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.waitForTimeout(1500);
  const narrowBox = await page.locator("canvas").first().boundingBox();
  step(
    "视口收窄后画布重排",
    narrowBox !== null && wideBox !== null && narrowBox.width < wideBox.width,
    `${Math.round(wideBox?.width ?? 0)} -> ${Math.round(narrowBox?.width ?? 0)}`,
  );
  await page.screenshot({ path: `${OUT}/06-narrow.png` });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.waitForTimeout(1500);

  // md 资料：走 MarkdownReader，选区链路一致。
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.waitForTimeout(500);
  const mdItem = page.locator('button[title="sources/notes.md"]');
  if ((await mdItem.count()) > 0) {
    await mdItem.first().click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/07-markdown.png` });
    step("md 资料走 MarkdownReader", (await page.locator("text=阅读笔记示例").count()) > 0);
  }

  step("无未捕获的控制台错误", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;