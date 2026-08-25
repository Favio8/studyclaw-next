import { chromium } from "playwright-core";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const url = process.env.STUDYCLAW_URL || "http://127.0.0.1:3000";
const out = process.env.OUT || "artifacts/ui-current.png";

const browser = await chromium.launch({ executablePath: EDGE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(1000);
await page.screenshot({ path: out });
await browser.close();
console.log(`saved ${out}`);
