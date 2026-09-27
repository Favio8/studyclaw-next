import { chromium } from "playwright-core";

const EDGE = process.env.STUDYCLAW_EDGE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const url = process.env.STUDYCLAW_URL || "http://127.0.0.1:3000";
const out = process.env.OUT || "artifacts/ui-current.png";

// try/finally 保证 goto/截图抛错（最常见：dev server 未启动）时 headless
// 浏览器进程仍被关闭，不残留僵尸进程。
const browser = await chromium.launch({ executablePath: EDGE, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: out });
  console.log(`saved ${out}`);
} finally {
  await browser.close();
}
