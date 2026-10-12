"use client";
import { readingOpenAt } from "@/src/lib/readingFlow";
import type { Concept } from "@/src/types";
import { ChevronRight } from "lucide-react";
import MarkdownView from "@/src/components/chat/MarkdownView";

export default function ConceptEvidence({ concept }: { concept: Concept }) {
  if (!concept.definition || !concept.evidence?.length) return null;
  return <details className="group border-b border-border-faint px-9 pb-2 text-xs leading-5">
    <summary className="flex cursor-pointer list-none items-center gap-1 rounded py-1 text-accent-focus [&::-webkit-details-marker]:hidden"><ChevronRight size={13} strokeWidth={1.8} className="shrink-0 transition-transform group-open:rotate-90" aria-hidden />定义、学习目标与原文依据</summary>
    <div className="mt-2"><MarkdownView content={concept.definition} compact modelOutput /></div><div className="mt-1 text-text-muted"><p className="mb-1">学习目标：</p><MarkdownView content={concept.learning_objective ?? ""} compact modelOutput /></div>
    {concept.evidence.map((ref, index) => <div key={index} className="mt-2 rounded bg-bg-root p-2"><button type="button" className="text-accent-focus" onClick={() => void readingOpenAt(ref.source, ref.page)}>{ref.source} · 第 {ref.page} 页</button><blockquote className="mt-1 text-text-muted">{ref.quote}</blockquote></div>)}
  </details>;
}
