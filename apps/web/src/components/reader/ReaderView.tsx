"use client";

/**
 * 辅助阅读视图（P2 落地）。P0 先挂占位空态：活动栏可可达，界面明示
 * 即将到来的能力，不留死按钮。
 */

import { BookOpen } from "lucide-react";

const COMING = [
  "像 Zotero 一样逐页读资料（PDF / Markdown）",
  "划词高亮、翻译、AI 解释（结合课程大纲与掌握度）",
  "划线一键变题卡、批注导出为笔记",
];

export default function ReaderView() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 py-10 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-bg-card text-text-muted">
        <BookOpen size={20} strokeWidth={1.8} aria-hidden />
      </span>
      <h2 className="text-[15px] font-medium text-text-primary">辅助阅读</h2>
      <p className="max-w-[420px] text-[13px] leading-6 text-text-muted">
        资料精读模式正在开发中，即将支持：
      </p>
      <ul className="max-w-[420px] space-y-1 text-left text-[13px] leading-6 text-text-faint">
        {COMING.map((item) => (
          <li key={item} className="flex gap-2">
            <span aria-hidden>·</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
