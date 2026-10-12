"use client";

/**
 * 「今天」开篇的陈列句：页面上唯一的"陈列级"元素，不加卡盒、不加装饰。
 *
 * 用字号/行高/字距与一条撑到右缘的细线做层级（短句右侧也不会留出突兀的空白）；
 * 语录全部内置，按本地日期稳定取句，可手动「换一句」，不发任何网络请求。
 */

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { QUOTES, localDayKey, nextQuoteIndex, quoteIndexForDay } from "@/src/lib/quotes";

export default function QuoteCard() {
  const [index, setIndex] = useState(() => quoteIndexForDay(localDayKey(), QUOTES.length));
  const quote = QUOTES[index] ?? QUOTES[0]!;

  return (
    <section data-testid="today-quote" className="flex flex-col">
      <p className="max-w-[54ch] text-[19px] leading-[1.95] tracking-[0.01em] text-text-primary">
        <span aria-hidden className="text-text-faint">“</span>
        {quote.text}
        <span aria-hidden className="text-text-faint">”</span>
      </p>
      <div className="mt-4 flex items-center gap-4">
        <span className="shrink-0 text-[12.5px] text-text-faint">— {quote.author}</span>
        <span aria-hidden className="h-px flex-1 bg-border-line/70" />
        <button
          type="button"
          aria-label="换一句"
          title="换一句"
          onClick={() => setIndex((current) => nextQuoteIndex(current, QUOTES.length))}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-text-faint transition-colors hover:bg-bg-card hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
        >
          <RefreshCw size={12} strokeWidth={1.8} aria-hidden />
        </button>
      </div>
    </section>
  );
}
