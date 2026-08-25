"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { BookOpen, ChevronDown, ChevronRight, ListTree, Map, Network, RefreshCw, Search, X } from "lucide-react";
import SyllabusGraph from "@/src/components/panel/SyllabusGraph";
import type { ConceptStatus } from "@/src/components/panel/SyllabusGraph";
import { api } from "@/src/lib/api";
import { pct } from "@/src/lib/format";
import { refreshPanelData } from "@/src/lib/panelData";
import { useAppStore } from "@/src/store/useAppStore";
import type { Syllabus } from "@/src/types";
import {
  LinearProgress,
  PanelEmptyState,
  PanelErrorState,
  PanelSection,
  PanelSkeleton,
  SegmentedControl,
  StatusPill,
  panelSurfaceClass,
} from "@/src/components/panel/PanelPrimitives";

// 思维导图（mind-elixir）走浏览器侧动态导入，SSR 阶段不加载。
const SyllabusMindmap = dynamic(() => import("./SyllabusMindmap"), { ssr: false });

const STATUS_DOT: Record<string, string> = {
  mastered: "bg-accent-pass",
  learning: "bg-accent-warn",
  weak: "bg-accent-fail",
  locked: "bg-text-faint",
};

type View = "tree" | "mindmap" | "graph";

export default function SyllabusTab() {
  const courseId = useAppStore((s) => s.activeCourseId);
  const buildStatus = useAppStore((s) => s.buildStatus);
  if (!courseId) {
    return (
      <PanelEmptyState
        icon={BookOpen}
        title="请选择一个项目"
        description="激活项目后，这里会显示课程章节、知识点和依赖关系。"
      />
    );
  }
  // The loader's initial state is its loading state. Remounting when the
  // course build changes starts a fresh request without a synchronous effect
  // state update.
  return <SyllabusLoader key={`${courseId}-${buildStatus}`} courseId={courseId} />;
}

/** 把匹配片段用 <mark> 高亮（不区分大小写；搜索词为空原样返回）。 */
function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase();
  if (q === "") return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: Array<{ match: boolean; text: string }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const idx = lower.indexOf(q, cursor);
    if (idx < 0) {
      parts.push({ match: false, text: text.slice(cursor) });
      break;
    }
    if (idx > cursor) parts.push({ match: false, text: text.slice(cursor, idx) });
    parts.push({ match: true, text: text.slice(idx, idx + q.length) });
    cursor = idx + q.length;
  }
  return (
    <>
      {parts.map((part, index) =>
        part.match ? (
          <mark key={index} className="rounded-[2px] bg-accent-warn/20 px-0.5 text-inherit">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

function SyllabusLoader({ courseId }: { courseId: string }) {
  const mastery = useAppStore((s) => s.mastery);
  const buildStatus = useAppStore((s) => s.buildStatus);
  const focusConceptId = useAppStore((s) => s.focusConceptId);
  const setFocusConcept = useAppStore((s) => s.setFocusConcept);
  const flashStatusBanner = useAppStore((s) => s.flashStatusBanner);
  const syllabusCollapsed = useAppStore((s) => s.syllabusCollapsed);
  const setSyllabusCollapsed = useAppStore((s) => s.setSyllabusCollapsed);
  const syllabusSearch = useAppStore((s) => s.syllabusSearch);
  const setSyllabusSearch = useAppStore((s) => s.setSyllabusSearch);

  const [syllabus, setSyllabus] = useState<Syllabus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("tree");
  const [granularityBusy, setGranularityBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .syllabus(courseId)
      .then((data) => {
        if (alive) setSyllabus(data);
      })
      .catch((exc) => {
        if (alive && buildStatus !== "running") {
          setError(exc instanceof Error ? exc.message : String(exc));
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [buildStatus, courseId]);

  const statusMap: Record<string, ConceptStatus> = {};
  mastery?.chapters.forEach((chapter) => {
    chapter.concepts.forEach((concept) => {
      statusMap[concept.id] = { status: concept.status, mastery: concept.mastery };
    });
  });

  const focusConcept = useCallback(
    (conceptId: string, name: string) => {
      setFocusConcept(conceptId);
      flashStatusBanner(`已聚焦：${name}`);
      setView("tree");
    },
    [flashStatusBanner, setFocusConcept],
  );

  const switchGranularity = useCallback(
    async (granularity: "fine" | "coarse") => {
      if (granularityBusy || granularity === syllabus?.granularity) return;
      setGranularityBusy(true);
      flashStatusBanner("正在切换大纲粒度…");
      try {
        const result = await api.setSyllabusGranularity(courseId, granularity);
        setSyllabus(result);
        flashStatusBanner(
          `✓ 已切换为${granularity === "coarse" ? "粗粒度大章节" : "高密度微概念"}（既有掌握度不回退）`,
        );
        await refreshPanelData();
      } catch (exc) {
        flashStatusBanner(`✗ 切换失败：${exc instanceof Error ? exc.message : "未知错误"}`);
      } finally {
        setGranularityBusy(false);
      }
    },
    [courseId, flashStatusBanner, granularityBusy, syllabus?.granularity],
  );

  // 聚焦概念 → 展开其父章节并平滑滚动定位（搜索词非空时先清除，避免被过滤掉）。
  useEffect(() => {
    if (focusConceptId === null || syllabus === null) return;
    const chapter = syllabus.chapters.find((item) => item.concepts.some((concept) => concept.id === focusConceptId));
    if (chapter === undefined) return;
    if (syllabusCollapsed[chapter.id]) setSyllabusCollapsed(chapter.id, false);
    if (syllabusSearch.trim() !== "") setSyllabusSearch("");
    const frame = requestAnimationFrame(() => {
      document
        .getElementById(`concept-${focusConceptId}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusConceptId, setSyllabusCollapsed, setSyllabusSearch, syllabus, syllabusCollapsed, syllabusSearch]);

  // 搜索过滤视图：命中章节展开；仅显示有命中的章节（章节命中显示整章，概念命中只显示命中行）。
  const searchQuery = syllabusSearch.trim().toLowerCase();
  const filteredChapters = useMemo(() => {
    if (syllabus === null || searchQuery === "") return null;
    const out: Array<{ chapter: Syllabus["chapters"][number]; concepts: Syllabus["chapters"][number]["concepts"] }> = [];
    for (const chapter of syllabus.chapters) {
      const chapterHit = chapter.title.toLowerCase().includes(searchQuery);
      const hitConcepts = chapter.concepts.filter((concept) => concept.name.toLowerCase().includes(searchQuery));
      if (chapterHit) out.push({ chapter, concepts: chapter.concepts });
      else if (hitConcepts.length > 0) out.push({ chapter, concepts: hitConcepts });
    }
    return out;
  }, [syllabus, searchQuery]);

  const isCollapsed = (chapterId: string): boolean => {
    if (filteredChapters !== null) return false; // 搜索中强制展开命中章节
    return syllabusCollapsed[chapterId] ?? false;
  };

  return (
    <div className="space-y-4 pb-2">
      <PanelSection
        title="课程大纲"
        icon={BookOpen}
        action={
          syllabus ? (
            <StatusPill tone="neutral">v{syllabus.version}</StatusPill>
          ) : null
        }
      >
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-[11px] text-text-faint">{syllabus?.title ?? "知识结构与学习路径"}</p>
          <SegmentedControl
            label="大纲视图"
            value={view}
            options={[
              { value: "tree", label: "列表", icon: ListTree },
              { value: "mindmap", label: "导图", icon: Map },
              { value: "graph", label: "关系图", icon: Network },
            ]}
            onChange={setView}
          />
        </div>
        {syllabus ? (
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="text-[11px] text-text-faint">
              大纲粒度（粗=大章节 3~5 / 细=微概念 15~30）
            </span>
            <div className={granularityBusy ? "opacity-60" : undefined}>
              <SegmentedControl
                label="大纲粒度"
                value={syllabus.granularity}
                options={[
                  { value: "coarse", label: "粗粒度" },
                  { value: "fine", label: "高密度" },
                ]}
                onChange={(value) => void switchGranularity(value as "fine" | "coarse")}
              />
            </div>
          </div>
        ) : null}
      </PanelSection>

      {loading ? (
        <PanelSkeleton lines={3} />
      ) : !syllabus && buildStatus === "running" ? (
        <div className={`${panelSurfaceClass} flex items-start gap-2.5 p-3`}>
          <RefreshCw size={16} strokeWidth={1.8} className="mt-0.5 shrink-0 animate-spin text-accent-focus" aria-hidden />
          <div>
            <p className="text-[13px] font-medium text-text-primary">课程索引构建中</p>
            <p className="mt-1 text-[11px] leading-5 text-text-faint">完成后会自动生成章节、知识点和题卡。</p>
          </div>
        </div>
      ) : error ? (
        <PanelErrorState title="大纲加载失败" description={error} />
      ) : !syllabus ? (
        <PanelEmptyState
          icon={BookOpen}
          title="还没有课程大纲"
          description="完成课程构建后，这里会显示章节和知识点拓扑。"
        />
      ) : view === "graph" ? (
        <PanelSection title="知识关系" icon={Network}>
          <SyllabusGraph syllabus={syllabus} statusMap={statusMap} onFocusConcept={focusConcept} />
        </PanelSection>
      ) : view === "mindmap" ? (
        <PanelSection title="思维导图" icon={Map}>
          <SyllabusMindmap syllabus={syllabus} statusMap={statusMap} onFocusConcept={focusConcept} />
        </PanelSection>
      ) : (
        <PanelSection title="章节与知识点" icon={ListTree} action={<span className="text-[11px] text-text-faint">{(syllabus.chapters ?? []).length} 个章节</span>}>
          <div className="relative">
            <Search size={14} strokeWidth={1.8} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint" aria-hidden />
            <input
              type="search"
              value={syllabusSearch}
              placeholder="搜索章节或知识点…"
              aria-label="搜索大纲"
              onChange={(event) => setSyllabusSearch(event.target.value)}
              className="mb-1.5 h-8 w-full rounded-lg border border-border-line bg-bg-panel pl-8 pr-8 text-[12px] text-text-primary placeholder:text-text-faint focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
            />
            {syllabusSearch !== "" ? (
              <button
                type="button"
                aria-label="清除搜索"
                onClick={() => setSyllabusSearch("")}
                className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-text-faint transition-colors hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
              >
                <X size={13} strokeWidth={1.8} aria-hidden />
              </button>
            ) : null}
          </div>
          <div className={`${panelSurfaceClass} overflow-hidden`}>
            {(filteredChapters ?? (syllabus.chapters ?? []).map((chapter) => ({ chapter, concepts: chapter.concepts }))).length === 0 ? (
              <div className="px-3 py-5 text-center text-[11px] text-text-faint">没有匹配「{syllabusSearch.trim()}」的章节或知识点</div>
            ) : (
              (filteredChapters ?? (syllabus.chapters ?? []).map((chapter) => ({ chapter, concepts: chapter.concepts }))).map(({ chapter, concepts }) => {
                const collapsed = isCollapsed(chapter.id);
                const chapterStatus = mastery?.chapters.find((item) => item.id === chapter.id);
                return (
                  <div key={chapter.id} className="border-b border-border-line/70 last:border-b-0">
                    <button
                      type="button"
                      aria-expanded={!collapsed}
                      onClick={() => setSyllabusCollapsed(chapter.id, !collapsed)}
                      className="flex min-h-10 w-full items-center gap-2 px-3 text-left transition-colors hover:bg-bg-card/55 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus"
                    >
                      {collapsed ? <ChevronRight size={15} strokeWidth={1.8} className="shrink-0 text-text-faint" aria-hidden /> : <ChevronDown size={15} strokeWidth={1.8} className="shrink-0 text-accent-focus" aria-hidden />}
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-primary">
                        <Highlight text={chapter.title} query={syllabusSearch} />
                      </span>
                      {chapterStatus ? (
                        <span className="flex w-16 shrink-0 items-center gap-1.5">
                          <LinearProgress value={chapterStatus.mastery} tone={chapterStatus.mastery <= 0 ? "neutral" : chapterStatus.mastery >= 0.7 ? "pass" : chapterStatus.mastery >= 0.4 ? "warn" : "fail"} label={`${chapter.title} 掌握度`} />
                          <span className="text-[10px] text-text-faint">{pct(chapterStatus.mastery)}</span>
                        </span>
                      ) : null}
                    </button>
                    {!collapsed ? (
                      <div className="border-t border-border-line/50 bg-bg-root/35 py-1">
                        {concepts.map((concept) => {
                          const st = statusMap[concept.id];
                          const isFocused = focusConceptId === concept.id;
                          const locked = st?.status === "locked";
                          return (
                            <button
                              key={concept.id}
                              id={`concept-${concept.id}`}
                              type="button"
                              disabled={locked}
                              onClick={() => focusConcept(concept.id, concept.name)}
                              title={`${concept.name}（${concept.id}）`}
                              className={`flex min-h-9 w-full items-center gap-2 border-l-2 px-3 pl-9 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus ${
                                isFocused
                                  ? "border-accent-focus bg-accent-focus/8 text-accent-focus"
                                  : locked
                                    ? "cursor-not-allowed border-transparent text-text-faint"
                                    : "border-transparent text-text-muted hover:bg-bg-card/55 hover:text-text-primary"
                              }`}
                            >
                              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[st?.status ?? "locked"]}`} aria-hidden />
                              <span className="min-w-0 flex-1 truncate text-[12px]">
                                <Highlight text={concept.name} query={syllabusSearch} />
                              </span>
                              {st ? <span className="shrink-0 text-[10px] text-text-faint">{pct(st.mastery)}</span> : null}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </PanelSection>
      )}
    </div>
  );
}
