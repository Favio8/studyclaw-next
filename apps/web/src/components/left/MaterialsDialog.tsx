"use client";

/**
 * 资料导入 / 上传交互（F3）。
 *
 * 补齐前端三处此前只有封装没有调用的 API：
 *   - `api.workspaceFiles`＋`api.initWorkspace`：勾选项目候选资料 → 新建课程
 *     （模式 A importPaths）→ 异步 build job → 出题闭环；
 *   - `api.uploadSources`：向**当前已打开课程**补充本地资料（浏览器上传）→ 触发
 *     build；inplace 课程被后端以 `INPLACE_SOURCE_BOUND` 拒绝的既有语义在 UI
 *     原样呈现；后端重名自动加序号的落盘名（`foo_2.md`）在完成回执中反馈。
 *
 * 视觉沿用 ui_design_spec 的亮色 DSH token（bg-panel / border-line /
 * accent-focus），与 NewProjectWizard 错误弹层同构。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { FolderPlus, Upload, X } from "lucide-react";
import { api, ApiError } from "@/src/lib/api";
import { refreshCourseList, refreshPanelData } from "@/src/lib/panelData";
import { useAppStore } from "@/src/store/useAppStore";

interface MaterialFile {
  name: string;
  path: string;
  relative: string;
  size: number;
  supported: boolean;
}

type TabKind = "import" | "upload";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : "操作失败";
}

/** 轮询 build job 至 done/failed（与 NewProjectWizard 同款策略）。 */
async function awaitBuild(
  jobId: string,
  courseId: string,
  report: (msg: string) => void,
  signal?: { aborted: boolean },
): Promise<void> {
  try {
    // F-7/PERF-8：消费 job.progress 展示"N/M 当前文件"，30 分钟不再黑盒。
    let lastProgress = "";
    for (let attempt = 0; attempt < 3600; attempt += 1) {
      // FE-4：弹窗已关闭/组件卸载时立即停止轮询并停止 setState。
      if (signal?.aborted) return;
      const job = await api.job(jobId);
      if (signal?.aborted) return;
      if (job.status === "done") {
        report(`✓ 知识索引构建完成（syllabus 生成，共 ${job.result?.tasksGenerated ?? 0} 张题卡）`);
        // FL-05：degraded（抽取失败/零概念块/差卡被闸）此前全线不可见——
        // 用户永远不知道"资料只摄取了一半"。逐条透出。
        const degraded = job.result?.degraded ?? [];
        if (degraded.length > 0) {
          report(`⚠ 构建降级：${degraded.length} 项资料/题卡未正常进入课程`);
          for (const item of degraded) report(`  · ${item}`);
        }
        return;
      }
      if (job.status === "failed") {
        report(`✗ 构建失败：${job.error ?? "未知错误"}`);
        return;
      }
      const p = job.progress;
      if (p !== undefined && p.total > 0 && p.finished < p.total) {
        const file = p.currentFile ? `（${p.currentFile}）` : "";
        const msg = `构建中… ${p.finished}/${p.total}${file}`;
        if (msg !== lastProgress) {
          lastProgress = msg;
          report(msg);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    report("✗ 构建超时");
  } catch {
    report("✗ 构建状态查询失败");
  }
}

export default function MaterialsDialog({ onClose }: { onClose: () => void }) {
  const activeCourseId = useAppStore((s) => s.activeCourseId);
  const setActiveCourse = useAppStore((s) => s.setActiveCourse);
  const setBuildStatus = useAppStore((s) => s.setBuildStatus);
  const flashStatusBanner = useAppStore((s) => s.flashStatusBanner);
  // 爪爪 uploading 态输入源：资料上传期间置位
  const setUploading = useAppStore((s) => s.setUploading);

  const [tab, setTab] = useState<TabKind>("upload");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // FE-4：轮询生命周期绑定——关闭/卸载后不再 setState 空转最长 30 分钟。
  const buildPollSignalRef = useRef({ aborted: false });
  useEffect(() => () => { buildPollSignalRef.current.aborted = true; }, []);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pickedFiles, setPickedFiles] = useState<File[]>([]);
  const [urlInput, setUrlInput] = useState("");
  const [urlBusy, setUrlBusy] = useState(false);
  const [urlNotice, setUrlNotice] = useState<string | null>(null);

  // -- 勾选导入（新建课程）状态 ----------------------------------------------------
  const [candidates, setCandidates] = useState<MaterialFile[] | null>(null);
  const [courseName, setCourseName] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [candidatesError, setCandidatesError] = useState<string | null>(null);

  const ensureCandidates = useCallback(async () => {
    if (candidates !== null) return;
    setCandidatesError(null);
    try {
      const payload = await api.workspaceFiles();
      setCandidates(payload.files);
    } catch (cause) {
      setCandidatesError(errorMessage(cause));
      setCandidates([]);
    }
  }, [candidates]);

  const toggleUploadTab = useCallback(() => {
    setTab("upload");
    setError(null);
    setNotice(null);
  }, []);

  const toggleImportTab = useCallback(() => {
    setTab("import");
    setError(null);
    setNotice(null);
    void ensureCandidates();
  }, [ensureCandidates]);

  // -- 上传补充 -------------------------------------------------------------------

  const onFilesSelected = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setNotice(null);
      setError(null);
      const files = Array.from(event.target.files ?? []);
      setPickedFiles(files);
      if (files.length > 0) {
        setNotice(`已选择 ${files.length} 个文件：${files.map((f) => f.name).join("、")}`);
      }
    },
    [],
  );

  const submitUpload = useCallback(async () => {
    setNotice(null);
    setError(null);
    if (!activeCourseId) {
      setError("请先在左栏打开/创建一个课程，再补充资料");
      return;
    }
    if (pickedFiles.length === 0) {
      setError("请先选择要上传的资料文件");
      return;
    }
    setBusy(true);
    setUploading(true); // 爪爪 uploading 姿态
    try {
      // FL-12：旧实现只解构 {added, buildJobId}——超限被拒的文件（rejected）
      // 与构建失败原因（buildError）静默消失，用户看到"已归档 N 份"却不知道
      // 有文件没进来。
      const { added, buildJobId, buildError, rejected } = await api.uploadSources(activeCourseId, pickedFiles);
      // 重名序号反馈：后端归档 `foo.pdf` + 再次同名会落盘为 `foo_2.pdf` 等
      // （绝不覆盖既有资料），这里把落盘名原样反馈给用户。
      const dupNames = added.filter((name) => /_\d+\.[^./\\]+$/.test(name));
      const lines = added.map((name) => `  · ${name}`);
      const rejectedLines = (rejected ?? []).map((item) => `  · ${item.file}：${item.reason}`);
      const noticeLines = [
        `✓ 已归档 ${added.length} 份资料：`,
        ...lines,
        ...(dupNames.length > 0
          ? [`（${dupNames.length} 份与既有资料重名，已自动加序号保存，未覆盖原文件）`]
          : []),
        ...(rejectedLines.length > 0
          ? ["", `✗ ${rejected!.length} 份资料被拒绝归档：`, ...rejectedLines]
          : []),
        ...(buildError !== undefined ? ["", `✗ 构建失败：${buildError}`] : []),
        ...(buildError === undefined && buildJobId !== null ? ["", "后台开始构建课程索引…"] : []),
      ];
      setNotice(noticeLines.join("\n"));
      setPickedFiles([]);
      if (fileRef.current) fileRef.current.value = "";
      setBuildStatus(buildJobId !== null && buildError === undefined ? "running" : "done");
      if (buildJobId !== null && buildError === undefined) {
        await awaitBuild(buildJobId, activeCourseId, (msg) => {
          setNotice((prev) => `${prev ?? ""}\n${msg}`);
        }, buildPollSignalRef.current);
      }
      setBuildStatus("done");
      await Promise.all([refreshPanelData(), refreshCourseList()]);
    } catch (cause) {
      // list 顺序与 added 一一对应，我们据此判断“重名”仅用于提示；
      // 后端已保证绝不覆盖。inplace 拒绝也走统一错误协议。
      setError(errorMessage(cause));
      flashStatusBanner(`✗ ${errorMessage(cause)}`);
    } finally {
      setBusy(false);
      setUploading(false); // 爪爪退出 uploading 姿态
    }
  }, [activeCourseId, flashStatusBanner, pickedFiles, setBuildStatus, setUploading]);

  const submitUrl = useCallback(async () => {
    setUrlNotice(null);
    setError(null);
    const url = urlInput.trim();
    if (!activeCourseId) {
      setError("请先在左栏打开/创建一个课程");
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      setError("链接仅支持 http/https 协议");
      return;
    }
    setUrlBusy(true);
    setNotice("正在抓取网页并收录…");
    try {
      const result = await api.ingestUrl(activeCourseId, url);
      setUrlInput("");
      setUrlNotice(`✓ 已收录 ${result.added}，后台开始增量构建（${result.buildJobId}）`);
      if (result.buildJobId) {
        await awaitBuild(result.buildJobId, activeCourseId, (msg) => {
          setUrlNotice((prev) => `${prev ?? ""}
${msg}`);
        }, buildPollSignalRef.current);
      }
      setBuildStatus("done");
      await Promise.all([refreshPanelData(), refreshCourseList()]);
    } catch (cause) {
      setError(errorMessage(cause));
      flashStatusBanner(`✗ ${errorMessage(cause)}`);
    } finally {
      setUrlBusy(false);
      setNotice(null);
    }
  }, [activeCourseId, flashStatusBanner, setBuildStatus, setNotice, urlInput]);

  // -- 勾选导入 -------------------------------------------------------------------

  const toggleChecked = useCallback((relative: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(relative)) next.delete(relative);
      else next.add(relative);
      return next;
    });
  }, []);

  const submitImport = useCallback(async () => {
    setError(null);
    setNotice(null);
    if (!courseName.trim()) {
      setError("请填写课程名（小写字母/数字/连字符）");
      return;
    }
    if (!/^[a-z0-9-]+$/.test(courseName.trim())) {
      setError("课程名仅允许小写字母、数字与连字符");
      return;
    }
    const importPaths = (candidates ?? [])
      .filter((f) => checked.has(f.relative) && f.supported)
      .map((f) => f.path);
    if (importPaths.length === 0) {
      setError("请至少勾选一份可摄取（md/txt/pdf）的候选资料");
      return;
    }
    setBusy(true);
    try {
      const created = await api.initWorkspace({
        mode: "create",
        courseName: courseName.trim(),
        importPaths,
        deferBuild: false,
      });
      useAppStore.getState().setCourses(
        await api.courseList(useAppStore.getState().workspacePath ?? "").then((r) => r.courses),
      );
      setActiveCourse(created.course);
      setBuildStatus(created.buildJobId ? "running" : "done");
      setNotice(
        `✓ 已创建课程 ${created.course}，归档 ${importPaths.length} 份资料，开始构建索引…`,
      );
      if (created.buildJobId) {
        // FL-19：轮询绑定弹窗生命周期——关闭弹窗立即停止（旧实现僵尸轮询）。
        await awaitBuild(created.buildJobId, created.course, (msg) => {
          setNotice((prev) => `${prev ?? ""}\n${msg}`);
        }, buildPollSignalRef.current);
      }
      setBuildStatus("done");
      await Promise.all([refreshPanelData(), refreshCourseList()]);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [
    candidates,
    checked,
    courseName,
    onClose,
    setActiveCourse,
    setBuildStatus,
  ]);

  const supportedCount = (candidates ?? []).filter((c) => c.supported).length;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="资料导入/上传"
        className="w-[min(94vw,560px)] overflow-hidden rounded-xl border border-border-line bg-bg-panel shadow-xl"
      >
        <header className="flex h-12 items-center justify-between border-b border-border-line px-4">
          <h2 className="text-[15px] font-medium text-text-primary">资料导入 / 上传</h2>
          <button
            type="button"
            aria-label="关闭"
            className="flex h-7 w-7 items-center justify-center rounded-full text-text-faint transition-colors hover:bg-bg-card hover:text-text-primary"
            onClick={onClose}
          >
            <X size={16} strokeWidth={1.8} aria-hidden />
          </button>
        </header>

        <nav className="flex gap-1 border-b border-border-line px-3 pt-2">
          <button
            type="button"
            className={`flex h-8 items-center gap-1.5 rounded-t-lg px-3 text-[13px] transition-colors ${
              tab === "upload"
                ? "border-b-2 border-accent-focus font-medium text-text-primary"
                : "text-text-muted hover:text-text-primary"
            }`}
            onClick={toggleUploadTab}
          >
            <Upload size={14} strokeWidth={1.8} aria-hidden /> 上传补充
          </button>
          <button
            type="button"
            className={`flex h-8 items-center gap-1.5 rounded-t-lg px-3 text-[13px] transition-colors ${
              tab === "import"
                ? "border-b-2 border-accent-focus font-medium text-text-primary"
                : "text-text-muted hover:text-text-primary"
            }`}
            onClick={toggleImportTab}
          >
            <FolderPlus size={14} strokeWidth={1.8} aria-hidden /> 勾选新建课程
          </button>
        </nav>

        <div className="max-h-[70vh] overflow-y-auto p-4">
          {tab === "upload" ? (
            <div className="space-y-3">
              <p className="text-[13px] leading-5 text-text-muted">
                {activeCourseId
                  ? `上传到当前课程：${activeCourseId}（归档至 sources/，随后自动增量构建出题）`
                  : "当前还没有打开课程 —— 请先用「＋ 新项目」打开/创建一个课程。"}
              </p>
              <label className="flex h-24 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border-line bg-bg-card text-text-muted transition-colors hover:border-accent-focus hover:text-text-primary">
                <Upload size={20} strokeWidth={1.8} aria-hidden />
                <span className="text-[13px]">点击选择本地资料（可多选，md/txt/pdf/docx/xlsx/html）</span>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  accept=".md,.txt,.pdf,.docx,.xlsx,.html,.htm"
                  className="hidden"
                  onChange={onFilesSelected}
                />
              </label>
              <div className="rounded-xl border border-border-line bg-bg-card p-3">
                <p className="text-[13px] text-text-muted">或收录网页链接（http/https，正文自动入 sources 并增量构建出题）：</p>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    aria-label="网页链接"
                    value={urlInput}
                    onChange={(event) => setUrlInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !urlBusy) void submitUrl();
                    }}
                    placeholder="https://example.com/article"
                    className="h-8 min-w-0 flex-1 rounded-lg border border-border-line bg-bg-panel px-3 text-[13px] text-text-primary outline-none focus:border-accent-focus"
                  />
                  <button
                    type="button"
                    disabled={urlBusy || !activeCourseId || !urlInput.trim()}
                    onClick={() => void submitUrl()}
                    className="h-8 shrink-0 rounded-lg border border-border-line px-3 text-[13px] text-text-primary transition-colors hover:bg-bg-panel disabled:opacity-40"
                  >
                    {urlBusy ? "收录中…" : "收录"}
                  </button>
                </div>
                {urlNotice ? (
                  <p role="status" className="mt-2 whitespace-pre-wrap text-[12px] leading-5 text-text-muted">
                    {urlNotice}
                  </p>
                ) : null}
              </div>
              {notice ? (
                <pre className="whitespace-pre-wrap rounded-lg bg-bg-card p-3 text-[12px] leading-5 text-text-muted">
                  {notice}
                </pre>
              ) : null}
              {error ? (
                <p role="alert" className="rounded-lg bg-red-50 p-3 text-[13px] leading-5 text-red-700">
                  {error}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="h-8 rounded-lg px-3 text-[13px] text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary"
                  onClick={onClose}
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={busy || !activeCourseId || pickedFiles.length === 0}
                  className="flex h-8 items-center gap-1.5 rounded-lg bg-accent-focus px-3 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                  onClick={() => void submitUpload()}
                >
                  <Upload size={14} strokeWidth={2} aria-hidden />
                  {busy ? "上传中…" : "上传并构建"}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-[13px] text-text-muted" htmlFor="material-course-name">
                  新课程名（唯一 ID，小写字母/数字/连字符）
                </label>
                <input
                  id="material-course-name"
                  value={courseName}
                  onChange={(event) =>
                    setCourseName(event.target.value.replaceAll(/\s/g, "").toLowerCase())
                  }
                  placeholder="k8s-internals"
                  className="h-9 w-full rounded-lg border border-border-line bg-bg-card px-3 text-[13px] text-text-primary outline-none focus:border-accent-focus"
                />
              </div>

              {candidatesError ? (
                <p role="alert" className="rounded-lg bg-red-50 p-3 text-[13px] leading-5 text-red-700">
                  {candidatesError}
                </p>
              ) : candidates === null ? (
                <p className="text-[13px] text-text-muted">正在枚举项目候选资料…</p>
              ) : (
                <>
                  <p className="text-[13px] text-text-muted">
                    勾选要归档导入的资料（可摄取 {supportedCount} / 共 {candidates.length} 份，mtime 倒序）：
                  </p>
                  <ul className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-border-line bg-bg-card p-2">
                    {candidates.length === 0 ? (
                      <li className="px-2 py-2 text-[13px] text-text-faint">
                        项目根目录暂无可摄取资料，请先用上传 Tab 或把资料放进项目。
                      </li>
                    ) : (
                      candidates.map((file) => {
                        const checkedThis = checked.has(file.relative);
                        return (
                          <li key={file.relative}>
                            <label
                              className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] transition-colors hover:bg-bg-panel ${
                                file.supported ? "text-text-primary" : "text-text-faint"
                              }`}
                            >
                              <input
                                type="checkbox"
                                className="accent-accent-focus"
                                disabled={!file.supported}
                                checked={checkedThis}
                                onChange={() => toggleChecked(file.relative)}
                              />
                              <span className="min-w-0 flex-1 truncate">{file.relative}</span>
                              {!file.supported ? (
                                <span className="shrink-0 text-[11px] text-text-faint">不可摄取</span>
                              ) : null}
                            </label>
                          </li>
                        );
                      })
                    )}
                  </ul>
                </>
              )}

              {error ? (
                <p role="alert" className="rounded-lg bg-red-50 p-3 text-[13px] leading-5 text-red-700">
                  {error}
                </p>
              ) : null}
              {notice ? (
                <pre className="whitespace-pre-wrap rounded-lg bg-bg-card p-3 text-[12px] leading-5 text-text-muted">
                  {notice}
                </pre>
              ) : null}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="h-8 rounded-lg px-3 text-[13px] text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary"
                  onClick={onClose}
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={busy || (candidates ?? []).length === 0 || checked.size === 0}
                  className="flex h-8 items-center gap-1.5 rounded-lg bg-accent-focus px-3 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                  onClick={() => void submitImport()}
                >
                  <FolderPlus size={14} strokeWidth={2} aria-hidden />
                  {busy ? "创建中…" : "勾选并创建课程"}
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
