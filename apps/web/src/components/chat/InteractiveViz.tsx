"use client";

/**
 * 交互演示块 InteractiveViz（sc-interactive 围栏渲染器）。
 *
 * 三分支：流式未闭合 → 占位卡；终态未闭合 → 降级代码块；
 * 闭合 → 卡片 + <iframe sandbox="allow-scripts" srcDoc=包装文档>。
 * 关键不变量：闭合后 code 冻结，srcDoc 经 useMemo 不再变化，
 * iframe 不随流式重渲而 remount（块内交互状态不丢）。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Code2 } from "lucide-react";
import {
  VIZ_INITIAL_HEIGHT,
  VIZ_MAX_HEIGHT,
  VIZ_MIN_HEIGHT,
  vizHeightFromEvent,
  wrapVizDocument,
} from "@/src/lib/vizTheme";

interface InteractiveVizProps {
  code: string;
  closed: boolean;
  streaming?: boolean;
}

export default function InteractiveViz({ code, closed, streaming }: InteractiveVizProps) {
  if (!closed) {
    if (streaming) {
      return (
        <div
          data-viz-card=""
          data-viz-state="generating"
          className="rounded-lg border border-border-line bg-bg-panel px-3 py-2"
        >
          <div className="flex h-6 items-center gap-1.5">
            <span className="flex h-4 w-4 shrink-0 items-center justify-center text-text-faint">
              <Activity size={14} strokeWidth={1.7} aria-hidden />
            </span>
            <span className="text-shimmer text-sm text-text-muted">交互演示生成中…</span>
          </div>
        </div>
      );
    }
    // 终态未闭合：降级为普通代码块（复刻 MarkdownView pre 壳，不重喂围栏）
    return (
      <div data-viz-card="" data-viz-state="fallback" className="overflow-hidden rounded-xl bg-code-block">
        <div className="px-3.5 py-2 text-[13px] leading-5 text-text-muted">sc-interactive</div>
        <pre className="whitespace-pre-wrap break-all px-4 py-4 font-mono text-[13px] leading-[22px] text-text-primary">
          {code}
        </pre>
      </div>
    );
  }
  return <VizCard code={code} />;
}

function VizCard({ code }: { code: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(VIZ_INITIAL_HEIGHT);
  const [showSource, setShowSource] = useState(false);
  const srcDoc = useMemo(() => wrapVizDocument(code), [code]);
  const summary = useMemo(
    () => code.split("\n").map((l) => l.trim()).find(Boolean) ?? "",
    [code],
  );

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const h = vizHeightFromEvent(iframeRef.current?.contentWindow ?? null, ev);
      if (h === null) return;
      setHeight(Math.min(VIZ_MAX_HEIGHT, Math.max(VIZ_MIN_HEIGHT, Math.round(h) + 2)));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <div
      data-viz-card=""
      data-viz-state="ready"
      className="overflow-hidden rounded-lg border border-border-line bg-bg-panel"
    >
      <div className="flex items-center gap-1.5 border-b border-border-faint px-3 py-1.5">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-text-faint">
          <Activity size={14} strokeWidth={1.7} aria-hidden />
        </span>
        <span className="shrink-0 text-sm text-text-muted">交互演示</span>
        <span className="mx-1 h-0.5 w-0.5 shrink-0 rounded-[1px] bg-text-caption" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-text-faint">
          {summary}
        </span>
        <button
          type="button"
          onClick={() => setShowSource((v) => !v)}
          aria-expanded={showSource}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-text-faint hover:bg-code-inline hover:text-text-muted"
        >
          <Code2 size={12} strokeWidth={1.8} aria-hidden />
          源码
        </button>
      </div>
      <div className="p-3">
        <iframe
          ref={iframeRef}
          title="交互演示"
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          className="block w-full border-0"
          style={{ height, transition: "height 160ms ease-out" }}
        />
      </div>
      {showSource ? (
        <div className="max-h-64 overflow-auto border-t border-border-faint bg-code-block">
          <pre className="whitespace-pre-wrap break-all px-4 py-3 font-mono text-[13px] leading-[22px] text-text-primary">
            {code}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
