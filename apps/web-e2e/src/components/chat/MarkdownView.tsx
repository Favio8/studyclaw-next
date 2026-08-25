"use client";

/**
 * Markdown 渲染（v1.4：DSH MarkdownText/CodeBlock 排版复刻）。
 *
 * - 正文 16px/28px；块间 16px（flex gap，DSH .body 语义）；
 * - 代码块：radius 12 + banner 头（语言名 13px）+ pre-wrap 逐字保留
 *   （ASCII 架构图兼容）；行内代码 0.875em 灰底；
 * - 表格：th l3 下边线 / td l2 下边线、padding 10px 16px；
 * - bubble 模式（用户消息）：纯文本 pre-wrap（DSH 用户气泡为明文）。
 */

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function codeLanguage(children: React.ReactNode): string {
  const first = Array.isArray(children) ? children[0] : children;
  const cls =
    first && typeof first === "object" && "props" in first
      ? String((first as { props?: { className?: string } }).props?.className ?? "")
      : "";
  return cls.replace("language-", "");
}

export default function MarkdownView({
  content,
  bubble,
}: {
  content: string;
  bubble?: boolean;
}) {
  if (bubble) {
    return (
      <p className="whitespace-pre-wrap break-words text-[16px] leading-6">
        {content}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4 text-[16px] leading-7 text-text-primary">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre({ children }) {
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
          code({ className, children, ...props }) {
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
          a({ children, href }) {
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
          h1: ({ children }) => (
            <h1 className="text-[24px] leading-[34px] font-bold text-text-primary">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-[22px] leading-8 font-bold text-text-primary">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-[20px] leading-[30px] font-bold text-text-primary">
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4 className="text-[16px] leading-7 font-semibold text-text-primary">
              {children}
            </h4>
          ),
          ul: ({ children }) => (
            <ul className="list-disc pl-[18px] marker:text-text-muted">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal pl-[18px] marker:text-text-muted">
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className="mt-1.5 first:mt-0">{children}</li>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-border-strong pl-4 text-text-muted">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="border-t border-border-line" />,
          strong: ({ children }) => (
            <strong className="font-semibold text-text-primary">{children}</strong>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[15px] leading-[25px]">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-border-strong px-4 py-2.5 text-left font-medium text-text-primary">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-border-line px-4 py-2.5 text-text-primary">
              {children}
            </td>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
