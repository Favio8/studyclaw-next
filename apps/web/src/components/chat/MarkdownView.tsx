"use client";

/**
 * Markdown 渲染（v1.4：DSH MarkdownText/CodeBlock 排版复刻；
 * v1.13：sc-interactive 交互演示分段）。
 *
 * - 正文 16px/28px；块间 16px（flex gap，DSH .body 语义）；
 * - 代码块：radius 12 + banner 头（语言名 13px）+ pre-wrap 逐字保留
 *   （ASCII 架构图兼容）；行内代码 0.875em 灰底；
 * - 表格：th l3 下边线 / td l2 下边线、padding 10px 16px；
 * - bubble 模式（用户消息）：纯文本 pre-wrap（DSH 用户气泡为明文）；
 * - sc-interactive 围栏：喂给 react-markdown 之前先按行切段，
 *   viz 段交给 InteractiveViz（围栏是行级构造，切分点永远落在块边界）。
 */

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import InteractiveViz from "./InteractiveViz";
import { splitVizSegments } from "@/src/lib/vizSegments";

function codeLanguage(children: React.ReactNode): string {
  const first = Array.isArray(children) ? children[0] : children;
  const cls =
    first && typeof first === "object" && "props" in first
      ? String((first as { props?: { className?: string } }).props?.className ?? "")
      : "";
  return cls.replace("language-", "");
}

const REMARK_PLUGINS = [remarkGfm];

/** 模块级常量：避免流式每帧重建 components 对象。 */
const MARKDOWN_COMPONENTS = {
  pre({ children }: { children?: React.ReactNode }) {
    const lang = codeLanguage(children);
    return (
      <div className="overflow-hidden rounded-xl bg-code-block">
        {lang ? (
          <div className="px-3.5 py-2 text-[13px] leading-5 text-text-muted">
            {lang}
          </div>
        ) : null}
        <pre className="whitespace-pre-wrap break-all px-4 py-4 font-mono text-[13px] leading-[22px] text-text-primary">
          {children}
        </pre>
      </div>
    );
  },
  code({ className, children, ...props }: { className?: string; children?: React.ReactNode }) {
    const isBlock =
      /language-[\w-]+/.test(className ?? "") ||
      String(children).includes("\n");
    if (isBlock) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="rounded-md bg-code-inline px-[5px] font-mono text-[0.875em] leading-[22px] text-text-primary"
        {...props}
      >
        {children}
      </code>
    );
  },
  a({ children, href }: { children?: React.ReactNode; href?: string }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-accent-focus hover:underline"
      >
        {children}
      </a>
    );
  },
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="text-[24px] leading-[34px] font-bold text-text-primary">
      {children}
    </h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="text-[22px] leading-8 font-bold text-text-primary">
      {children}
    </h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="text-[20px] leading-[30px] font-bold text-text-primary">
      {children}
    </h3>
  ),
  h4: ({ children }: { children?: React.ReactNode }) => (
    <h4 className="text-[16px] leading-7 font-semibold text-text-primary">
      {children}
    </h4>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="list-disc pl-[18px] marker:text-text-muted">
      {children}
    </ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="list-decimal pl-[18px] marker:text-text-muted">
      {children}
    </ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li className="mt-1.5 first:mt-0">{children}</li>
  ),
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="border-l-2 border-border-strong pl-4 text-text-muted">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-t border-border-line" />,
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold text-text-primary">{children}</strong>
  ),
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[15px] leading-[25px]">
        {children}
      </table>
    </div>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="border-b border-border-strong px-4 py-2.5 text-left font-medium text-text-primary">
      {children}
    </th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="border-b border-border-line px-4 py-2.5 text-text-primary">
      {children}
    </td>
  ),
};

export default function MarkdownView({
  content,
  bubble,
  streaming,
}: {
  content: string;
  bubble?: boolean;
  streaming?: boolean;
}) {
  if (bubble) {
    return (
      <p className="whitespace-pre-wrap break-words text-[16px] leading-6">
        {content}
      </p>
    );
  }
  const segments = splitVizSegments(content);
  return (
    <div
      data-markdown-view=""
      className="flex flex-col gap-4 text-[16px] leading-7 text-text-primary"
    >
      {segments.map((seg) =>
        seg.type === "md" ? (
          <ReactMarkdown
            key={seg.key}
            remarkPlugins={REMARK_PLUGINS}
            components={MARKDOWN_COMPONENTS}
          >
            {seg.code}
          </ReactMarkdown>
        ) : (
          <InteractiveViz
            key={seg.key}
            code={seg.code}
            closed={seg.closed}
            streaming={streaming}
          />
        ),
      )}
    </div>
  );
}
