"use client";

/**
 * M3 设置 → 数据：课程导出 / 导入。
 *
 * 走二进制通道（`/api/courses.export` / `.import`）而不是 JSON+base64——
 * 后者会被 2 MiB 请求体上限截断，真实课程根本导不出来。
 *
 * 两条产品约束在这一层落地：
 * - **导出物不含任何凭据**（不含 API Key / Token / 主密钥），文案必须写明，
 *   因为用户会把文件存到随手的地方；
 * - **导入会覆盖同名课程**，服务端默认拒绝，覆盖必须由用户在 UI 上明确确认，
 *   不能默认勾选。
 */

import { useRef, useState } from "react";
import { AlertTriangle, Download, FolderOpen, Upload } from "lucide-react";
import { api, ApiError } from "@/src/lib/api";
import { useAppStore } from "@/src/store/useAppStore";

/** 服务端错误码 → 用户看得懂的中文。未知码兜底为服务端原文，不吞掉信息。 */
function describe(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "target-exists") return "目标课程已存在。勾选「覆盖同名课程」后可继续——原有数据会被替换。";
    if (error.code === "unsupported-version") return "这个备份来自更高版本的 StudyClaw，请先升级再导入。";
    if (error.code === "invalid-archive") return "文件不是有效的 StudyClaw 备份。";
    if (error.code === "unsafe-path") return "备份内容包含非法路径，已拒绝导入。";
    if (error.code === "payload-too-large" || error.status === 413) return "备份文件太大，超过了服务端上限。";
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** 桌面壳通过 preload 暴露固定白名单桥；纯 Web 端 `window.studyclawDesktop` 不存在。 */
interface DesktopBridge {
  isDesktop: true;
  openDataDir?: () => Promise<{ opened: boolean }>;
}

function desktopBridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as { studyclawDesktop?: DesktopBridge }).studyclawDesktop;
  return bridge?.isDesktop === true ? bridge : null;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 立刻 revoke 会让部分浏览器下载中断，给一个事件循环再释放。
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default function DataSection() {
  const activeCourseId = useAppStore((s) => s.activeCourseId);
  const archiveInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"export" | "import" | "dir" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [force, setForce] = useState(false);
  const [renameTo, setRenameTo] = useState("");
  // 选中文件放 state 而不是只在点击时读 ref：能显示已选文件名、能在未选时禁用
  // 按钮，也避免 ref.current 在重渲染后为空的边界。
  const [archive, setArchive] = useState<File | null>(null);
  // 桌面壳才有的能力；纯 Web 端整块「数据目录」不渲染，避免点了没反应。
  const bridge = desktopBridge();
  const canOpenDataDir = bridge?.openDataDir !== undefined;

  /** 统一的动作包装：忙态 + 成功/失败提示，失败一律转成可读中文。 */
async function run(kind: "export" | "import" | "dir", task: () => Promise<string>): Promise<void> {
    setBusy(kind);
    setError(null);
    setMessage(null);
    try {
      setMessage(await task());
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(null);
    }
  }

  async function doExport(format: "markdown" | "backup"): Promise<void> {
    if (activeCourseId === null) {
      setError("尚未打开课程项目，无法导出。");
      return;
    }
    await run("export", async () => {
      const { blob, filename } = await api.exportCourse(activeCourseId, format);
      triggerDownload(blob, filename);
      return `已导出 ${filename}（${(blob.size / 1024).toFixed(1)} KB）`;
    });
  }

  async function doImport(): Promise<void> {
    if (archive === null) {
      setError("请先选择一个 .studyclaw.zip 备份文件。");
      return;
    }
    // 覆盖是不可逆的：服务端默认拒绝，这里再要求一次显式勾选。
    if (force && !window.confirm("同名课程将被完全替换，此操作不可撤销。确定继续？")) return;
    // 读文件也放进 run()：arrayBuffer() 在个别环境不可用或读盘失败时，
    // 若在外面 await 会变成**未被处理的 Promise 拒绝**，用户点了完全没反应。
    await run("import", async () => {
      const buffer = await archive.arrayBuffer();
      const result = await api.importCourse(buffer, { courseId: renameTo.trim(), force });
      return `已还原课程「${result.courseId}」（${result.files} 个文件）。刷新页面后可在左栏打开还原的项目。`;
    });
  }

  return (
    <div className="flex flex-col gap-5 text-[13px]">
      <section className="rounded-xl border border-border-line p-4">
        <h3 className="flex items-center gap-2 text-[14px] font-medium text-text-primary">
          <Download size={15} strokeWidth={1.8} aria-hidden />
          导出课程
        </h3>
        <p className="mt-1.5 leading-6 text-text-muted">
          把学习数据导出成你能自己拿走的文件。<strong className="font-medium text-text-secondary">导出物不含任何凭据</strong>
          （不含 API Key、Token、主密钥）。换电脑、迁移工具或留档都用它。
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void doExport("markdown")}
            className="h-9 rounded-lg border border-border-line px-3 text-[13px] text-text-primary transition-colors hover:bg-bg-card disabled:opacity-40"
          >
            {busy === "export" ? "导出中..." : "导出 Markdown（可读、可迁移）"}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void doExport("backup")}
            className="h-9 rounded-lg border border-border-line px-3 text-[13px] text-text-primary transition-colors hover:bg-bg-card disabled:opacity-40"
          >
            {busy === "export" ? "导出中..." : "导出完整备份（可原样还原）"}
          </button>
        </div>
        <p className="mt-2 text-[11px] leading-5 text-text-faint">
          Markdown 适合阅读与检索；备份包含题卡答案和会话历史。原始资料需另行复制，模型配置与凭据需重新设置。
        </p>
      </section>

      <section className="rounded-xl border border-border-line p-4">
        <h3 className="flex items-center gap-2 text-[14px] font-medium text-text-primary">
          <Upload size={15} strokeWidth={1.8} aria-hidden />
          从备份还原
        </h3>
        <p className="mt-1.5 leading-6 text-text-muted">选择先前导出的 <code className="text-text-secondary">.studyclaw.zip</code>。默认按备份自带的课程名还原。</p>
        <div className="mt-3 flex flex-col gap-2.5">
          <label className="flex flex-col gap-1 text-[12px] text-text-muted">
            还原为（留空则用备份里的课程名）
            <input
              value={renameTo}
              onChange={(event) => setRenameTo(event.target.value)}
              placeholder="例如：期末复习"
              className="h-9 rounded-lg border border-border-line bg-bg-panel px-2.5 text-[13px] text-text-primary outline-none focus-visible:border-accent-focus"
            />
          </label>
          <label className="flex items-center gap-2 text-[12px] text-text-muted">
            <input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} />
            <span className="inline-flex items-center gap-1">
              <AlertTriangle size={12} strokeWidth={1.8} className="text-accent-warn" aria-hidden />
              覆盖同名课程（原有数据会被替换，不可撤销）
            </span>
          </label>
          <div className="flex items-center gap-2">
            <input
              ref={archiveInput}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(event) => setArchive(event.target.files?.[0] ?? null)}
            />
            <span className="min-w-0 flex-1 truncate text-[12px] text-text-faint" title={archive?.name ?? ""}>
              {archive === null ? "尚未选择文件" : archive.name}
            </span>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => archiveInput.current?.click()}
              className="h-9 rounded-lg border border-border-line px-3 text-[13px] text-text-primary transition-colors hover:bg-bg-card disabled:opacity-40"
            >
              选择备份文件
            </button>
            <button
              type="button"
              disabled={busy !== null || archive === null}
              onClick={() => void doImport()}
              className="h-9 rounded-lg bg-accent-focus px-4 text-[13px] font-medium text-white transition-colors hover:bg-accent-focus-hover disabled:opacity-40"
            >
              {busy === "import" ? "还原中..." : "开始还原"}
            </button>
          </div>
        </div>
      </section>

      {canOpenDataDir ? (
        <section className="rounded-xl border border-border-line p-4">
          <h3 className="flex items-center gap-2 text-[14px] font-medium text-text-primary">
            <FolderOpen size={15} strokeWidth={1.8} aria-hidden />
            数据目录
          </h3>
          <p className="mt-1.5 leading-6 text-text-muted">这里打开宿主的配置与项目注册目录。课程学习数据保存在各项目的 .studyclaw 目录中。</p>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void run("dir", async () => {
              await bridge?.openDataDir?.();
              return "已打开数据目录";
            })}
            className="mt-3 h-9 rounded-lg border border-border-line px-3 text-[13px] text-text-primary transition-colors hover:bg-bg-card disabled:opacity-40"
          >
            {busy === "dir" ? "打开中..." : "打开数据目录"}
          </button>
        </section>
      ) : null}

      {message !== null ? (
        <p className="rounded-lg border border-accent-pass/30 bg-accent-pass/5 px-3 py-2 text-[12px] text-accent-pass" role="status">{message}</p>
      ) : null}
      {error !== null ? (
        <p className="rounded-lg border border-accent-fail/30 bg-accent-fail/5 px-3 py-2 text-[12px] text-accent-fail" role="alert">{error}</p>
      ) : null}
    </div>
  );
}
