/**
 * sc-interactive 块的沙箱包装文档：CSP 断网 + 设计 token 桥 + 高度上报脚本。
 *
 * :root 实值必须与 apps/web/app/globals.css @theme（L8-52）逐值一致；
 * 别名区兼容常见 artifact 风格变量名（模型可能从示例里学到这些名字）。
 */

/** 沙箱内 CSP：只允许内联脚本/样式与 data: 资源，断一切外联。 */
export const VIZ_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'";

export const VIZ_THEME_CSS = `:root {
  /* StudyClaw tokens（同步自 globals.css @theme） */
  --color-bg-root: #f9fafb;
  --color-bg-panel: #ffffff;
  --color-bg-card: #f1f3f5;
  --color-bg-main: #ffffff;
  --color-bubble: #edf3fe;
  --color-selector: #f5f6f7;
  --color-code-block: #f9fafb;
  --color-code-inline: #ebeef2;
  --color-border-line: rgba(0, 0, 0, 0.1);
  --color-border-faint: rgba(0, 0, 0, 0.04);
  --color-border-strong: rgba(0, 0, 0, 0.12);
  --color-accent-focus: rgb(65, 118, 230);
  --color-accent-focus-hover: rgb(103, 158, 254);
  --color-accent-pass: #059669;
  --color-accent-warn: rgb(245, 158, 11);
  --color-accent-fail: rgb(236, 19, 19);
  --color-accent-alt: #4f46e5;
  --color-text-primary: rgb(15, 17, 21);
  --color-text-muted: rgb(97, 102, 107);
  --color-text-faint: rgb(129, 133, 140);
  --color-text-caption: rgb(173, 178, 184);
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial,
    sans-serif;
  --font-mono: "SF Mono", "JetBrains Mono", "Fira Code", Consolas,
    "Liberation Mono", Menlo, Courier, "PingFang SC", "Microsoft YaHei",
    ui-monospace, monospace;
  --shadow-lv2: 0 4px 12px 0 rgba(0, 0, 0, 0.02), 0 2px 8px 0 rgba(0, 0, 0, 0.04);
  --shadow-lv3: 0 0 1px 0 rgba(0, 0, 0, 0.2), 0 0 4px 0 rgba(0, 0, 0, 0.02),
    0 12px 32px 0 rgba(0, 0, 0, 0.08);
  /* artifact 风格别名 */
  --color-text-secondary: rgb(97, 102, 107);
  --color-text-tertiary: rgb(129, 133, 140);
  --color-background-secondary: #f1f3f5;
  --color-border-tertiary: rgba(0, 0, 0, 0.1);
  --color-text-info: rgb(65, 118, 230);
  --color-background-info: #edf3fe;
  --color-border-info: rgba(65, 118, 230, 0.35);
  --border-radius-md: 8px;
}
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.5;
  color: var(--color-text-primary);
  background: transparent;
}`;

/** iframe 内高度上报：首帧 + ResizeObserver + resize，parent 侧按内容高调整外框。 */
export const VIZ_HEIGHT_SCRIPT = `(function () {
  function report() {
    try {
      var h = document.body ? document.body.scrollHeight : 0;
      parent.postMessage({ type: "sc-viz-height", h: h }, "*");
    } catch (e) { /* 沙箱受限即静默 */ }
  }
  function init() {
    report();
    if (typeof ResizeObserver !== "undefined" && document.body) {
      new ResizeObserver(report).observe(document.body);
    }
    window.addEventListener("resize", report);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();`;

export function wrapVizDocument(code: string): string {
  return [
    "<!DOCTYPE html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${VIZ_CSP}">`,
    `<style>${VIZ_THEME_CSS}</style>`,
    "</head>",
    "<body>",
    code,
    `<script>${VIZ_HEIGHT_SCRIPT}</script>`,
    "</body>",
    "</html>",
  ].join("\n");
}

export const VIZ_MIN_HEIGHT = 40;
export const VIZ_INITIAL_HEIGHT = 96;
export const VIZ_MAX_HEIGHT = 640;

export const VIZ_HEIGHT_MESSAGE_TYPE = "sc-viz-height";

/** 校验高度 postMessage：来源必须是指定 iframe（沙箱无 same-origin，origin 为 "null"，不可用于比对）。 */
export function vizHeightFromEvent(
  expectedSource: Window | null,
  ev: MessageEvent,
): number | null {
  if (!expectedSource || ev.source !== expectedSource) return null;
  const data = ev.data as { type?: unknown; h?: unknown } | null;
  if (
    !data ||
    data.type !== VIZ_HEIGHT_MESSAGE_TYPE ||
    typeof data.h !== "number" ||
    !Number.isFinite(data.h)
  ) {
    return null;
  }
  return data.h;
}
