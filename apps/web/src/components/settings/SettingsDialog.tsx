"use client";

/** DSH 风格设置面板：左侧分区导航，右侧配置内容，覆盖当前控制台。 */

import { useEffect, useRef, useState } from "react";
import { Bot, Database, FileScan, HardDriveDownload, Settings2, ShieldCheck, X } from "lucide-react";
import ModelsSection from "@/src/components/settings/ModelsSection";
import DataSection from "@/src/components/settings/DataSection";
import { MODES } from "@/src/lib/modes";
import { api, ApiError } from "@/src/lib/api";
import { useAppStore } from "@/src/store/useAppStore";
import { useFocusTrap } from "@/src/hooks/useFocusTrap";
import type { SettingsPayload } from "@/src/types/api";

type Section = "general" | "models" | "agent" | "parsing" | "data";
/** 通用设置只管 ui 段（api_spec §2.6 v2.6 部分更新语义）；LLM 配置全部走模型配置 Tab。 */
type Draft = {
  defaultMode: SettingsPayload["ui"]["defaultMode"];
  agentPreset: string;
  permissionPreset: string;
  plugins: Record<string, boolean>;
  /** 资料解析（PRD 需求一）。 */
  parseEngine: "auto" | "mineru" | "builtin";
  parseTier: "basic" | "standard" | "advanced";
  parseTimeoutSec: number;
};

function draftFrom(payload: SettingsPayload): Draft {
  const agent = payload.agent ?? { preset: "studyclaw-learning", presets: [] };
  const permissions = payload.permissions ?? { preset: "workspace-write", presets: [] };
  const plugins = payload.plugins ?? { inventory: [] };
  const parse = payload.parse;
  return {
    defaultMode: payload.ui.defaultMode,
    agentPreset: agent.preset,
    permissionPreset: permissions.preset,
    plugins: Object.fromEntries(plugins.inventory.map((item) => [item.id, item.enabled])),
    parseEngine: (parse?.engine ?? "auto") as Draft["parseEngine"],
    parseTier: (parse?.tier ?? "basic") as Draft["parseTier"],
    parseTimeoutSec: parse?.timeoutSec ?? 300,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

export default function SettingsDialog() {
  const open = useAppStore((state) => state.settingsOpen);
  return open ? <SettingsDialogContent /> : null;
}

function SettingsDialogContent() {
  const setOpen = useAppStore((state) => state.setSettingsOpen);
  const setMode = useAppStore((state) => state.setMode);
  const flashStatusBanner = useAppStore((state) => state.flashStatusBanner);
  const [section, setSection] = useState<Section>("general");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loaded, setLoaded] = useState<SettingsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  // W-10：焦点圈闭（打开聚焦首个控件、Tab 循环、Escape 尊重 busy、关闭还原）。
  useFocusTrap({
    containerRef: dialogRef,
    onEscape: () => { if (!busy) setOpen(false); },
  });

  useEffect(() => {
    let alive = true;
    void api.settings().then((payload) => {
      if (!alive) return;
      setLoaded(payload);
      setDraft(draftFrom(payload));
    }).catch((cause) => {
      if (alive) setError(errorMessage(cause));
    });
    return () => { alive = false; };
  }, []);

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => current ? { ...current, [key]: value } : current);
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const runtime = loaded?.agent === undefined ? {} : { agentPreset: draft.agentPreset, permissionPreset: draft.permissionPreset, plugins: draft.plugins };
      // 部分更新语义（同旧契约）：通用分区只写 ui 段；资料解析分区的字段只在
      // 该分区保存时随请求发出，避免“在通用页点保存”顺手改写解析配置。
      const parsePatch = section === "parsing"
        ? { parseEngine: draft.parseEngine, parseTier: draft.parseTier, parseTimeoutSec: draft.parseTimeoutSec }
        : {};
      const payload = await api.updateSettings({ defaultMode: draft.defaultMode, ...runtime, ...parsePatch });
      setLoaded(payload);
      setDraft(draftFrom(payload));
      setMode(payload.ui.defaultMode);
      flashStatusBanner("设置已保存");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function closeOnMask(event: React.MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget && !busy) setOpen(false);
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4 backdrop-blur-[2px]"
      role="presentation"
      onMouseDown={closeOnMask}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="relative flex h-[min(800px,calc(100vh-48px))] w-[min(800px,calc(100vw-48px))] overflow-hidden rounded-[24px] border border-border-line bg-bg-panel shadow-lv3"
      >
        <nav className="flex w-[188px] shrink-0 flex-col gap-[18px] px-3 pt-[22px]">
          <h2 id="settings-title" className="px-3 text-[16px] font-medium leading-6 text-text-primary">设置</h2>
          <div className="flex flex-col gap-1">
            <button
              type="button"
              aria-current={section === "general" ? "true" : undefined}
              onClick={() => setSection("general")}
              className={`flex h-10 items-center gap-2 rounded-xl px-3 text-left text-[14px] transition-colors ${section === "general" ? "bg-bg-card text-text-primary" : "text-text-muted hover:bg-bg-card/70 hover:text-text-primary"}`}
            >
              <Settings2 size={15} strokeWidth={1.8} aria-hidden />
              <span>通用设置</span>
            </button>
            <button
              type="button"
              aria-current={section === "agent" ? "true" : undefined}
              onClick={() => setSection("agent")}
              className={`flex h-10 items-center gap-2 rounded-xl px-3 text-left text-[14px] transition-colors ${section === "agent" ? "bg-bg-card text-text-primary" : "text-text-muted hover:bg-bg-card/70 hover:text-text-primary"}`}
            >
              <Bot size={15} strokeWidth={1.8} aria-hidden />
              <span>Agent 运行时</span>
            </button>
            <button
              type="button"
              aria-current={section === "models" ? "true" : undefined}
              onClick={() => setSection("models")}
              className={`flex h-10 items-center gap-2 rounded-xl px-3 text-left text-[14px] transition-colors ${section === "models" ? "bg-bg-card text-text-primary" : "text-text-muted hover:bg-bg-card/70 hover:text-text-primary"}`}
            >
              <Database size={15} strokeWidth={1.8} aria-hidden />
              <span>模型配置</span>
            </button>
            <button
              type="button"
              aria-current={section === "parsing" ? "true" : undefined}
              onClick={() => setSection("parsing")}
              className={`flex h-10 items-center gap-2 rounded-xl px-3 text-left text-[14px] transition-colors ${section === "parsing" ? "bg-bg-card text-text-primary" : "text-text-muted hover:bg-bg-card/70 hover:text-text-primary"}`}
            >
              <FileScan size={15} strokeWidth={1.8} aria-hidden />
              <span>资料解析</span>
            </button>
            <button
              type="button"
              aria-current={section === "data" ? "true" : undefined}
              onClick={() => setSection("data")}
              className={`flex h-10 items-center gap-2 rounded-xl px-3 text-left text-[14px] transition-colors ${section === "data" ? "bg-bg-card text-text-primary" : "text-text-muted hover:bg-bg-card/70 hover:text-text-primary"}`}
            >
              <HardDriveDownload size={15} strokeWidth={1.8} aria-hidden />
              <span>数据导出导入</span>
            </button>
          </div>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-[54px] shrink-0 items-start justify-between gap-2 px-[14px] pb-2 pl-2.5 pt-5">
            <span className="text-[14px] font-medium text-text-primary">{section === "general" ? "通用设置" : section === "models" ? "模型配置" : section === "parsing" ? "资料解析" : section === "data" ? "数据导出导入" : "Agent 运行时"}</span>
            <button
              type="button"
              aria-label="关闭设置"
              title="关闭设置"
              disabled={busy}
              onClick={() => setOpen(false)}
              className="flex h-7 w-7 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary disabled:opacity-40"
            >
              <X size={15} aria-hidden />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
            {error ? (
            <div className="flex flex-col gap-3 rounded-xl border border-accent-fail/30 bg-accent-fail/5 p-4 text-[13px] text-accent-fail" role="alert">
              <span>{error}</span>
                <button type="button" className="self-start rounded-lg border border-accent-fail/40 px-3 py-1.5 hover:bg-accent-fail/10" onClick={() => { setError(null); void api.settings().then((payload) => { setLoaded(payload); setDraft(draftFrom(payload)); }).catch((cause) => setError(errorMessage(cause))); }}>重试</button>
              </div>
            ) : draft === null ? (
              <div className="text-[13px] text-text-faint">正在读取设置...</div>
            ) : section === "general" ? (
              <GeneralSettings draft={draft} update={update} />
            ) : section === "parsing" ? (
              <ParseSettings payload={loaded} draft={draft} update={update} />
            ) : section === "models" ? (
              <ModelsSection initial={loaded} />
            ) : section === "data" ? (
              /* 数据分区自有保存语义（下载/上传），不参与底部「保存设置」 */
              <DataSection />
            ) : (
              <RuntimeSettings payload={loaded} draft={draft} update={update} />
            )}
          </div>

          {section !== "models" && section !== "data" ? (
            <div className="flex shrink-0 items-center justify-end gap-2 px-5 py-3">
              <button type="button" disabled={busy} onClick={() => setOpen(false)} className="h-9 rounded-lg px-4 text-[13px] text-text-muted transition-colors hover:bg-bg-card hover:text-text-primary disabled:opacity-40">取消</button>
              <button type="button" disabled={busy || draft === null} onClick={() => void save()} className="h-9 rounded-lg bg-accent-focus px-4 text-[13px] font-medium text-white transition-colors hover:bg-accent-focus-hover disabled:opacity-40">{busy ? "保存中..." : "保存设置"}</button>
            </div>
          ) : (
            <div className="flex shrink-0 items-center justify-end gap-2 px-5 py-3">
              <span className="text-xs text-text-faint">
                {section === "data" ? "导出直接下载，导入即时生效" : "模型配置在对应卡片内保存"}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function GeneralSettings({
  draft,
  update,
}: {
  draft: Draft;
  update: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
}) {
  return (
    <section className="flex max-w-[640px] flex-col gap-5">
      <div>
        <h3 className="text-[16px] font-medium text-text-primary">学习体验</h3>
        <p className="mt-1 text-[13px] leading-5 text-text-muted">这些选项保存在当前项目的 `.studyclaw/config.yaml` 中。</p>
      </div>
      <label className="flex flex-col gap-2 text-[13px] text-text-secondary">
        默认学习模式
        <select value={draft.defaultMode} onChange={(event) => update("defaultMode", event.target.value as Draft["defaultMode"])} className="h-9 w-full max-w-[300px] rounded-lg border border-border-line bg-bg-root px-3 text-[13px] text-text-primary outline-none focus:border-accent-focus">
          {MODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
        </select>
        <span className="text-[12px] text-text-faint">新对话和导师对话默认使用此模式。</span>
      </label>
      <div className="border-t border-border-line pt-4">
        <h3 className="text-[14px] font-medium text-text-primary">当前应用</h3>
        <dl className="mt-3 grid grid-cols-[120px_1fr] gap-y-2 text-[13px]">
          <dt className="text-text-faint">配置文件</dt>
          <dd className="truncate text-text-muted">.studyclaw/config.yaml</dd>
          <dt className="text-text-faint">配置范围</dt>
          <dd className="text-text-muted">当前打开的学习项目</dd>
        </dl>
      </div>
    </section>
  );
}

/** 资料解析（PRD 需求一）：MinerU 可选接入 + 探测状态 + 安装引导。 */
function ParseSettings({
  payload,
  draft,
  update,
}: {
  payload: SettingsPayload | null;
  draft: Draft;
  update: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
}) {
  const parse = payload?.parse;
  const mineru = parse?.mineru;
  const inputClass = "h-9 w-full max-w-[300px] rounded-lg border border-border-line bg-bg-root px-3 text-[13px] text-text-primary outline-none focus:border-accent-focus";
  return (
    <section className="flex max-w-[640px] flex-col gap-5">
      <div>
        <h3 className="text-[16px] font-medium text-text-primary">资料解析引擎</h3>
        <p className="mt-1 text-[13px] leading-5 text-text-muted">
          控制 PDF 等资料转 Markdown 的方式。MinerU 是本地运行的可选增强（版面分析 / OCR / 表格公式），
          未安装时自动回落到内置解析；两种路径都失败的文件会在构建结果里标为 degraded。
        </p>
      </div>

      <div className="flex items-center gap-2 rounded-xl border border-border-line bg-bg-card/50 px-3 py-2.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${mineru?.available ? "bg-accent-pass" : "bg-text-faint"}`} aria-hidden />
        <span className="text-[13px] text-text-primary">
          {mineru?.available ? "MinerU 已安装" : "MinerU 未安装"}
        </span>
        <span className="ml-auto truncate text-[11px] text-text-faint" title={mineru?.command ?? undefined}>
          {mineru?.available ? mineru.command : "使用内置解析（pdf-parse）"}
        </span>
      </div>

      <label className="flex flex-col gap-2 text-[13px] text-text-secondary">
        解析引擎
        <select value={draft.parseEngine} onChange={(event) => update("parseEngine", event.target.value as Draft["parseEngine"])} className={inputClass}>
          <option value="auto">自动（有 MinerU 优先，失败回落内置）</option>
          <option value="mineru">强制 MinerU（失败即记 degraded，不用内置冒充）</option>
          <option value="builtin">仅内置解析</option>
        </select>
      </label>

      <label className="flex flex-col gap-2 text-[13px] text-text-secondary">
        解析质量档位
        <select value={draft.parseTier} onChange={(event) => update("parseTier", event.target.value as Draft["parseTier"])} className={inputClass}>
          <option value="basic">基础解析（约 0.8GB 模型，纯 CPU 可用）</option>
          <option value="standard">标准解析（约 2GB 模型，CPU 可跑、GPU 更快）</option>
          <option value="advanced">高级解析（最难文档最高质量，最慢）</option>
        </select>
        <span className="text-[12px] text-text-faint">切换档位后，已有资料会按新档位重新解析（内容寻址缓存，切回旧档位不重复下载）。</span>
      </label>

      <label className="flex flex-col gap-2 text-[13px] text-text-secondary">
        单文件解析超时（秒）
        <input
          type="number"
          min={30}
          max={3600}
          value={draft.parseTimeoutSec}
          onChange={(event) => update("parseTimeoutSec", Number(event.target.value) || 300)}
          className={inputClass}
        />
        <span className="text-[12px] text-text-faint">超时后该文件回落到内置解析；扫描件大文件建议 600 秒以上。</span>
      </label>

      <div className="border-t border-border-line pt-4">
        <h3 className="text-[14px] font-medium text-text-primary">安装 MinerU（可选）</h3>
        <p className="mt-1 text-[13px] leading-5 text-text-muted">
          MinerU 是独立 Python 程序（Apache-2.0 + 附加条款许可），不会随 StudyClaw 安装包分发。
          需要 Python ≥3.10；模型下载体积见上方档位说明，全部本地处理、不上传文档。
        </p>
        <div className="mt-3 space-y-2 rounded-xl bg-bg-root p-3 font-mono text-[12px] leading-5 text-text-muted">
          <div>uv tool install &quot;mineru&gt;=4.0,&lt;5&quot;</div>
          <div className="text-text-faint"># 或：pipx install &quot;mineru&gt;=4.0,&lt;5&quot;</div>
          <div className="text-text-faint"># 关闭 MinerU 匿名遥测：mineru telemetry disable</div>
        </div>
        <details className="mt-2 rounded-xl border border-border-line">
          <summary className="cursor-pointer px-3 py-2 text-[12px] text-text-muted">uv/pipx 安装失败？用 pip + 虚拟环境（替代路线）</summary>
          <div className="space-y-2 border-t border-border-line p-3 font-mono text-[12px] leading-5 text-text-muted">
            <div>python -m venv .mineru-venv</div>
            <div>.mineru-venv\Scripts\python -m pip install &quot;mineru&gt;=4.0,&lt;5&quot; <span className="text-text-faint"># Windows</span></div>
            <div>.mineru-venv/bin/python -m pip install &quot;mineru&gt;=4.0,&lt;5&quot; <span className="text-text-faint"># macOS / Linux</span></div>
          </div>
          <p className="border-t border-border-line px-3 py-2 text-[11px] leading-5 text-text-faint">
            部分安全软件会拦截 uv/pipx 写入命令行 shim（报「拒绝访问」），此时用 venv + pip 即可。
            装完后把 venv 的 Scripts（Windows）或 bin（macOS/Linux）目录加入 PATH，重启 StudyClaw 后即可探测到。
          </p>
        </details>
        <p className="mt-2 text-[12px] leading-5 text-text-faint">
          Windows 上 uv/pipx 的可执行文件位于 <code className="font-mono">~/.local/bin</code>（默认不在 PATH），Host 已覆盖该目录的探测。
          保存设置后会重新探测一次。
        </p>
      </div>
    </section>
  );
}

function RuntimeSettings({
  payload,
  draft,
  update,
}: {
  payload: SettingsPayload | null;
  draft: Draft;
  update: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
}) {
  if (!payload) return null;
  const agent = payload.agent ?? { presets: [] };
  const permissions = payload.permissions ?? { presets: [] };
  const plugins = payload.plugins ?? { inventory: [] };
  const inputClass = "h-9 w-full max-w-[420px] rounded-lg border border-border-line bg-bg-root px-3 text-[13px] text-text-primary outline-none focus:border-accent-focus";
  return <section className="flex max-w-[640px] flex-col gap-6">
    <div>
      <h3 className="text-[16px] font-medium text-text-primary">Agent preset</h3>
      <p className="mt-1 text-[13px] leading-5 text-text-muted">新建 Agent 时注入的上下文和工具集合。</p>
      <select value={draft.agentPreset} onChange={(event) => update("agentPreset", event.target.value)} className={`${inputClass} mt-3`} aria-label="Agent preset">
        {agent.presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name} · {preset.description}</option>)}
      </select>
    </div>
    <div className="border-t border-border-line pt-5">
      <div className="flex items-center gap-2"><ShieldCheck size={15} className="text-text-muted" aria-hidden /><h3 className="text-[14px] font-medium text-text-primary">权限 preset</h3></div>
      <p className="mt-1 text-[13px] leading-5 text-text-muted">权限只控制默认审批策略；缺少隔离 Provider 的能力仍会 fail-closed。</p>
      <div className="mt-3 flex flex-col gap-2">
        {permissions.presets.map((preset) => <label key={preset.id} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${draft.permissionPreset === preset.id ? "border-accent-focus bg-accent-focus/5" : "border-border-line hover:bg-bg-card"}`}>
          <input type="radio" name="permission-preset" value={preset.id} checked={draft.permissionPreset === preset.id} onChange={() => update("permissionPreset", preset.id)} className="mt-0.5 accent-accent-focus" />
          <span className="min-w-0"><span className="block text-[13px] font-medium text-text-primary">{preset.name}</span><span className="mt-0.5 block text-[12px] text-text-faint">{preset.description}</span></span>
          <span className="ml-auto shrink-0 text-[11px] text-text-caption">{preset.approvalPolicy}</span>
        </label>)}
      </div>
    </div>
    <div className="border-t border-border-line pt-5">
      <h3 className="text-[14px] font-medium text-text-primary">Plugins</h3>
      <p className="mt-1 text-[13px] leading-5 text-text-muted">内置插件状态来自 Host inventory；未配置的部署能力保持 degraded。</p>
      <div className="mt-3 flex flex-col gap-2">
        {plugins.inventory.map((plugin) => <label key={plugin.id} className="flex items-center gap-3 rounded-xl border border-border-line px-3 py-2.5">
          <input type="checkbox" checked={draft.plugins[plugin.id] ?? plugin.enabled} onChange={(event) => update("plugins", { ...draft.plugins, [plugin.id]: event.target.checked })} className="accent-accent-focus" />
          <span className="min-w-0"><span className="block text-[13px] text-text-primary">{plugin.name}</span><span className="block text-[11px] text-text-faint">{plugin.reason ?? `${plugin.source} · ${plugin.id}`}</span></span>
          <span className="ml-auto text-[11px] text-text-caption">{plugin.enabled ? "可用" : "degraded"}</span>
        </label>)}
      </div>
    </div>
  </section>;
}
