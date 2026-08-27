"use client";

/**
 * DSH 风格模型配置 Tab（v2 重构，对齐 ui-settings-models 交互）：
 * - 行卡片稳定：行永远可见（状态点/名称/使用中 + 操作），编辑器展开在行下方；
 *   编辑 / 添加 / 声明三态互斥，一次只开一张卡
 * - Key 主字段化：API Key 是唯一主字段；Base URL、默认模型、模型列表收进
 *   「自定义设置」折叠区
 * - 添加双入口：内置目录选型（预填地址，模型由用户发现/选择）＋
 *   自定义 OpenAI 兼容声明卡（ID / Base URL / 至少一个模型三道门控）
 * - 模型列表可从端点拉取（discover-models，用表单当前值询问），失败可手填
 * - 首次运行姿态：没有任何已配置密钥的 provider 时自动展开 setup 卡
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api, ApiError } from "@/src/lib/api";
import { useAppStore } from "@/src/store/useAppStore";
import type {
  ProviderCatalogEntry,
  ProviderModelPayload,
  ProviderPayload,
  SettingsPayload,
} from "@/src/types/api";

interface EditorProfile {
  id: string;
  name: string;
  model: string;
  baseUrl: string | null;
  temperature: number;
  maxConcurrency: number;
  models: ProviderModelPayload[];
  /** 编辑既有 id 时置 true（跳过 409）；创建态缺省。 */
  overwrite?: boolean;
}

/** 容量输入草稿：焦点期间保留原文，保存时才解析（避免「1000」被打断成「1K」）。 */
/** 行级稳定 key（FE-4）：删除中间行时 React 复用正确 DOM，展开态/IME 不再串位。 */
interface ModelDraft {
  rowKey: string;
  id: string;
  name: string;
  contextText: string;
  maxText: string;
}

let rowKeySeq = 0;
function nextRowKey(): string {
  rowKeySeq += 1;
  return `rk_${Date.now().toString(36)}_${rowKeySeq}`;
}

/** 添加卡按目录条目缓存整卡草稿（DSH：切换目录不丢已填内容）。 */
interface AddCardDraft {
  routeId: string;
  name: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  rows: ModelDraft[];
  temperature: number;
  maxConcurrency: number;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** 解析十进制 K/M 后缀容量；空串 → null（未填），非法 → "invalid"。 */
function parseCapacity(text: string): number | null | "invalid" {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const match = /^(\d+(?:\.\d+)?)\s*([kKmM]?)$/.exec(trimmed);
  if (!match) return "invalid";
  const multiplier = match[2].toUpperCase() === "M" ? 1_000_000 : match[2] ? 1_000 : 1;
  const value = Math.round(parseFloat(match[1]) * multiplier);
  return value > 0 ? value : "invalid";
}

function formatCapacity(value: number | null): string {
  if (value === null) return "";
  if (value % 1_000_000 === 0) return `${value / 1_000_000}M`;
  if (value % 1_000 === 0) return `${value / 1_000}K`;
  return String(value);
}

function draftsFrom(models: ProviderModelPayload[]): ModelDraft[] {
  return models.map((m) => ({
    rowKey: nextRowKey(),
    id: m.id,
    name: m.name,
    contextText: formatCapacity(m.contextWindow),
    maxText: formatCapacity(m.maxTokens),
  }));
}

function ProviderEditorCard({
  provider,
  entry,
  creating,
  onSave,
  onCancel,
  draftCache,
}: {
  /** 编辑既有 provider；null = 创建。 */
  provider: ProviderPayload | null;
  /** 创建来源的目录条目（预填 + placeholder）；自定义声明为 null。 */
  entry: ProviderCatalogEntry | null;
  creating: boolean;
  onSave: (profile: EditorProfile, apiKey: string) => Promise<void>;
  onCancel: () => void;
  /** 添加卡草稿缓存：按目录条目 id 保存/恢复，切换条目不丢草稿（X4）。 */
  draftCache?: Map<string, AddCardDraft> | null;
}) {
  const entryId = entry?.id ?? null;
  // X4：挂载时从按条目缓存的草稿恢复（切换条目靠 key 重挂载触发），
  // 这样「切走再切回」同一目录时已填内容仍在。
  const draft = draftCache?.get(entryId ?? "") ?? null;
  const [routeId, setRouteId] = useState(draft?.routeId ?? provider?.id ?? entry?.id ?? "");
  const [name, setName] = useState(draft?.name ?? provider?.name ?? entry?.name ?? "");
  const [model, setModel] = useState(draft?.model ?? provider?.model ?? "");
  const [baseUrl, setBaseUrl] = useState(draft?.baseUrl ?? provider?.baseUrl ?? entry?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(draft?.apiKey ?? "");
  const [rows, setRows] = useState<ModelDraft[]>(() =>
    draft?.rows ?? draftsFrom(provider?.models ?? entry?.models ?? []),
  );
  // 高级字段：编辑态从既有 provider 初始化真实值，创建态用默认（X2）。
  const [temperature, setTemperature] = useState(draft?.temperature ?? provider?.temperature ?? 0.3);
  const [maxConcurrency, setMaxConcurrency] = useState(draft?.maxConcurrency ?? provider?.maxConcurrency ?? 4);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<ProviderModelPayload[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());

  // 每次渲染后把最新表单快照存入 ref（渲染期不写 ref，effect 期允许）。
  const draftRef = useRef<AddCardDraft | null>(null);
  useEffect(() => {
    draftRef.current = { routeId, name, model, baseUrl, apiKey, rows, temperature, maxConcurrency };
  }, [routeId, name, model, baseUrl, apiKey, rows, temperature, maxConcurrency]);
  // 卸载（切走条目）时把最新草稿写回缓存，供切回时恢复。
  useEffect(() => {
    if (!draftCache || entryId === null) return;
    return () => {
      if (draftRef.current) {
        // FE-4：草稿缓存永不携带明文 apiKey——切走条目即丢弃未提交密钥。
        const { apiKey: _droppedApiKey, ...rest } = draftRef.current;
        void _droppedApiKey;
        draftCache.set(entryId, { ...rest, apiKey: "" });
      }
    };
  }, [entryId, draftCache]);

  const id = provider?.id ?? routeId.trim();
  const idValid = !creating || /^[a-z][a-z0-9-]*$/.test(id);
  const parsedRows = rows.map((row) => ({
    row,
    rowKey: row.rowKey,
    id: row.id.trim(),
    context: parseCapacity(row.contextText),
    max: parseCapacity(row.maxText),
  }));
  const rowIdsValid = parsedRows.every((r) => r.id.length > 0);
  const capacitiesValid = parsedRows.every(
    (r) => r.context !== "invalid" && r.max !== "invalid",
  );
  // 写入即校验（DSH write-time refusal）：默认模型与 Base URL 是激活/构建
  // 的硬前提，两处都空着保存只会产出「保存了却不可用」的配置。
  const canSave =
    idValid &&
    id.length > 0 &&
    baseUrl.trim().length > 0 &&
    model.trim().length > 0 &&
    rowIdsValid &&
    capacitiesValid;

  async function submit() {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      // 编辑态 = 更新既有 id，必须显式 overwrite；创建态不带，撞 id 时由
      // 上层弹 409 覆盖确认（X5）。高级字段编辑态保留真实值（X2）。
      await onSave(
        {
          id,
          name: name.trim(),
          model: model.trim(),
          baseUrl: baseUrl.trim() || null,
          temperature,
          maxConcurrency,
          models: parsedRows.map((r) => ({
            id: r.id,
            name: r.row.name.trim(),
            contextWindow: r.context === "invalid" ? null : r.context,
            maxTokens: r.max === "invalid" ? null : r.max,
          })),
          ...(provider !== null ? { overwrite: true } : {}),
        },
        apiKey.trim(),
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  /** 用表单当前值（未保存的 Base URL + 已键入但未保存的 Key）询问端点。 */
  async function discover() {
    setDiscovering(true);
    setDiscoverError(null);
    try {
      const result = await api.discoverModels({
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || undefined,
        apiKeyEnv: apiKey.trim() ? undefined : provider?.apiKeyEnv ?? undefined,
      });
      setCandidates(result.models);
      // 已配置过的候选默认不勾选：采纳选择绝不覆盖用户已调优的容量。
      setChecked(
        new Set(
          result.models
            .filter((m) => !rows.some((row) => row.id.trim() === m.id))
            .map((m) => m.id),
        ),
      );
    } catch (cause) {
      setDiscoverError(errorMessage(cause));
    } finally {
      setDiscovering(false);
    }
  }

  function adoptCandidates() {
    if (!candidates) return;
    const selected = candidates.filter((m) => checked.has(m.id));
    setRows((current) => [...current, ...draftsFrom(selected)]);
    setCandidates(null);
  }

  function updateRow(index: number, patch: Partial<ModelDraft>) {
    setRows((current) => current.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  // 浏览器和密码管理器可能忽略 autocomplete="off"，尤其是新建表单。
  // 使用 new-password + 非语义化字段名，避免把用户的学号/账号资料误填进 Provider。
  const formAutoComplete = creating ? "new-password" : "off";
  const fieldAutoComplete = creating ? "new-password" : "off";
  const autofillGuardProps = {
    "data-1p-ignore": "true",
    "data-bwignore": "true",
    "data-form-type": "other",
    "data-lpignore": "true",
  } as const;
  const inputClass =
    "h-9 w-full rounded-lg border border-border-line bg-bg-root px-3 text-[13px] text-text-primary outline-none focus:border-accent-focus";
  const selectClass = `${inputClass} appearance-none`;
  // 默认模型候选 = 列表中的模型 ID；当前值不在列表时附加在首位，避免 select 静默改选。
  const rowIds = rows.map((r) => r.id.trim()).filter((v) => v.length > 0);
  const currentModel = model.trim();
  const modelOptions =
    currentModel && !rowIds.includes(currentModel) ? [currentModel, ...rowIds] : rowIds;

  return (
    <form
      autoComplete={formAutoComplete}
      onSubmit={(e) => e.preventDefault()}
      className="rounded-xl bg-bg-card p-4 shadow-lv2"
      {...autofillGuardProps}
    >
      {!creating ? (
        <div className="mb-3 flex items-baseline gap-2">
          <span className="text-sm font-medium text-text-primary">{provider?.name || id}</span>
          <span className="text-xs text-text-faint">{id}</span>
        </div>
      ) : null}

      {/* 主字段：API Key。其余字段全部收进折叠区。 */}
      <label className="flex flex-col gap-1.5 text-xs text-text-secondary">
        API Key
        <input
          type="password"
          autoComplete="new-password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          className={inputClass}
          placeholder={provider?.apiKeyConfigured ? "保留当前密钥，留空不修改" : "输入 API Key"}
          name={`${uid}_secret_value`}
          {...autofillGuardProps}
        />
        {provider?.apiKeyConfigured ? (
          <span className="text-xs text-accent-pass">● 已配置</span>
        ) : (
          <span className="text-xs text-text-faint">当前未检测到密钥</span>
        )}
      </label>

      {creating ? (
        <div className="mt-3 grid grid-cols-1 gap-3 min-[560px]:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-xs text-text-secondary">
            Provider ID
            <input
              value={routeId}
              name={`${uid}_provider_value`}
              onChange={(e) => setRouteId(e.target.value)}
              className={`${inputClass} ${routeId.length > 0 && !idValid ? "border-accent-fail" : ""}`}
              placeholder="acme-gateway"
              autoComplete={fieldAutoComplete}
              {...autofillGuardProps}
            />
            <span className="text-[11px] text-text-faint">小写字母开头，用于生成凭据引用（如 ACME_API_KEY）</span>
          </label>
          <label className="flex flex-col gap-1.5 text-xs text-text-secondary">
            显示名称
            <input
              value={name}
              name={`${uid}_display_value`}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
              placeholder={id || "可选"}
              autoComplete={fieldAutoComplete}
              {...autofillGuardProps}
            />
          </label>
        </div>
      ) : null}

      {creating && routeId.length > 0 && !idValid ? (
        <p className="mt-2 text-xs text-accent-fail">Provider ID 必须以小写字母开头，只含小写字母、数字和连字符</p>
      ) : null}

      <details className="mt-3 rounded-lg border border-border-line bg-bg-panel" open={creating}>
        <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-text-secondary">
          自定义设置
          <span className="ml-2 font-normal text-text-faint">Base URL · 默认模型 · 模型列表</span>
        </summary>
        <div className="flex flex-col gap-3 px-3 pb-3 pt-1">
          <label className="flex flex-col gap-1.5 text-xs text-text-secondary">
            Base URL（必填）
            <input
              value={baseUrl}
              name={`${uid}_endpoint_value`}
              onChange={(e) => setBaseUrl(e.target.value)}
              className={inputClass}
              placeholder={entry?.baseUrl ?? "https://your-gateway.example/v1"}
              autoComplete={fieldAutoComplete}
              {...autofillGuardProps}
            />
            {baseUrl.trim().length === 0 ? (
              <span className="text-[11px] text-accent-warn">必填：模型端点的 OpenAI 兼容 Base URL</span>
            ) : null}
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5 text-xs text-text-secondary">
              温度（temperature）
              <input
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={Number.isFinite(temperature) ? temperature : 0.3}
                onChange={(e) => setTemperature(Number(e.target.value))}
                className={inputClass}
                name={`${uid}_temperature_value`}
                autoComplete={fieldAutoComplete}
                {...autofillGuardProps}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-xs text-text-secondary">
              最大并发（maxConcurrency）
              <input
                type="number"
                min={1}
                max={16}
                step={1}
                value={Number.isFinite(maxConcurrency) ? maxConcurrency : 4}
                onChange={(e) => setMaxConcurrency(Number(e.target.value))}
                className={inputClass}
                name={`${uid}_concurrency_value`}
                autoComplete={fieldAutoComplete}
                {...autofillGuardProps}
              />
            </label>
          </div>

          <label className="flex flex-col gap-1.5 text-xs text-text-secondary">
            默认模型（必填：新对话与课程构建使用）
            {modelOptions.length > 0 ? (
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className={selectClass}
                aria-label="默认模型"
              >
                <option value="" disabled>请选择默认模型</option>
                {modelOptions.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            ) : (
              <input
                value={model}
                name={`${uid}_model_value`}
                onChange={(e) => setModel(e.target.value)}
                className={inputClass}
                placeholder="例如 deepseek-reasoner"
                autoComplete={fieldAutoComplete}
                {...autofillGuardProps}
              />
            )}
            {model.trim().length === 0 ? (
              <span className="text-[11px] text-accent-warn">未选择默认模型：会话内仍可临时切换，但课程构建（/build）不可用</span>
            ) : null}
            {model === "deepseek-chat" || model === "deepseek-reasoner" ? (
              <span className="text-[11px] text-accent-warn">该模型已废弃，请重新选择或从端点获取。</span>
            ) : null}
          </label>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-text-secondary">模型列表</span>
              <div className="flex items-center gap-1.5">
                {entry && (entry.models?.length ?? 0) > 0 ? (
                  <button
                    type="button"
                    onClick={() => setRows(draftsFrom(entry?.models ?? []))}
                    title="放弃当前覆盖，恢复该供应商目录预置的模型列表"
                    className="rounded-lg border border-border-line px-2 py-1 text-xs text-text-muted hover:bg-bg-card"
                  >
                    ↺ 恢复内置列表
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => void discover()}
                  disabled={discovering || busy || baseUrl.trim().length === 0}
                  title={baseUrl.trim().length === 0 ? "先填写 Base URL" : undefined}
                  className="rounded-lg border border-border-line px-2 py-1 text-xs text-text-muted hover:bg-bg-card disabled:opacity-40"
                >
                  {discovering ? "获取中..." : "⟳ 从端点获取"}
                </button>
                <button
                  type="button"
                  onClick={() => setRows((current) => [...current, { rowKey: nextRowKey(), id: "", name: "", contextText: "", maxText: "" }])}
                  className="rounded-lg border border-border-line px-2 py-1 text-xs text-text-muted hover:bg-bg-card"
                >
                  ＋ 手动添加
                </button>
              </div>
            </div>
            {discoverError ? (
              <p className="mb-2 text-xs text-accent-warn" role="alert">
                获取失败：{discoverError}。仍可手动填写下面的列表。
              </p>
            ) : null}
            {rows.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border-line px-3 py-3 text-xs text-text-faint">
                还没有模型；可从端点获取或手动添加。
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {parsedRows.map(({ row, id: rowId, context, max, rowKey }, index) => (
                  <div key={rowKey} className="rounded-lg border border-border-line bg-bg-root p-2">
                    <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
                      <input
                        value={row.id}
                        onChange={(e) => updateRow(index, { id: e.target.value })}
                        className={`${inputClass} ${rowId.length === 0 ? "border-accent-warn" : ""}`}
                        placeholder="模型 ID"
                        autoComplete={fieldAutoComplete}
                        name={`${uid}_catalog_value_${index}`}
                        {...autofillGuardProps}
                        aria-label={`模型 ID ${index + 1}`}
                      />
                      <input
                        value={row.name}
                        onChange={(e) => updateRow(index, { name: e.target.value })}
                        className={inputClass}
                        placeholder="显示名称（可选）"
                        autoComplete={fieldAutoComplete}
                        name={`${uid}_catalog_label_${index}`}
                        {...autofillGuardProps}
                        aria-label={`模型名称 ${index + 1}`}
                      />
                    </div>
                    <details className="mt-1">
                      <summary className="cursor-pointer select-none text-[11px] text-text-faint">
                        容量（可选）
                        {context === "invalid" || max === "invalid" ? (
                          <span className="ml-1 text-accent-fail">· 格式无效</span>
                        ) : null}
                      </summary>
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <input
                          value={row.contextText}
                          onChange={(e) => updateRow(index, { contextText: e.target.value })}
                          className={inputClass}
                          placeholder="上下文窗口，如 128K"
                          autoComplete={fieldAutoComplete}
                          name={`${uid}_context_value_${index}`}
                          {...autofillGuardProps}
                          aria-label={`上下文窗口 ${index + 1}`}
                        />
                        <input
                          value={row.maxText}
                          onChange={(e) => updateRow(index, { maxText: e.target.value })}
                          className={inputClass}
                          placeholder="最大输出，如 8K"
                          autoComplete={fieldAutoComplete}
                          name={`${uid}_output_value_${index}`}
                          {...autofillGuardProps}
                          aria-label={`最大输出 ${index + 1}`}
                        />
                      </div>
                      {context === "invalid" || max === "invalid" ? (
                        <p className="mt-1 text-[11px] text-accent-fail">
                          第 {index + 1} 行容量格式无效；支持 200K / 1M 或纯数字。
                        </p>
                      ) : null}
                    </details>
                    <button
                      type="button"
                      className="mt-1 text-xs text-text-faint hover:text-accent-fail"
                      onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                    >
                      删除
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </details>

      {error ? <p className="mt-3 text-xs text-accent-fail" role="alert">{error}</p> : null}

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-xl border border-border-line px-3 py-1.5 text-xs text-text-muted hover:bg-bg-panel disabled:opacity-40"
        >
          取消
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !canSave}
          className="rounded-xl bg-accent-focus px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-focus-hover disabled:opacity-40"
        >
          {busy ? "保存中..." : "保存"}
        </button>
      </div>

      {candidates ? (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/30 p-4"
          role="presentation"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setCandidates(null); }}
        >
          <div role="dialog" aria-modal="true" aria-label="选择要添加的模型" className="flex max-h-[70vh] w-[440px] flex-col rounded-xl border border-border-line bg-bg-panel p-4 shadow-lv3">
            <h4 className="text-sm font-medium text-text-primary">选择要添加的模型</h4>
            <p className="mt-1 text-xs text-text-faint">已在列表中的模型默认未勾选，采纳不会覆盖已调优的容量。</p>
            <div className="mt-2 flex gap-2 text-xs">
              <button type="button" className="rounded-lg border border-border-line px-2 py-1 text-text-muted hover:bg-bg-card" onClick={() => setChecked(new Set(candidates.map((m) => m.id)))}>全选</button>
              <button type="button" className="rounded-lg border border-border-line px-2 py-1 text-text-muted hover:bg-bg-card" onClick={() => setChecked(new Set())}>全不选</button>
            </div>
            <ul className="m-0 mt-3 flex min-h-0 flex-1 list-none flex-col gap-1 overflow-y-auto p-0">
              {candidates.map((m) => (
                <li key={m.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-bg-card">
                    <input
                      type="checkbox"
                      checked={checked.has(m.id)}
                      onChange={(e) => {
                        setChecked((current) => {
                          const next = new Set(current);
                          if (e.target.checked) next.add(m.id);
                          else next.delete(m.id);
                          return next;
                        });
                      }}
                    />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary">{m.id}</span>
                    {m.contextWindow !== null || m.maxTokens !== null ? (
                      <span className="shrink-0 text-[11px] text-text-faint">
                        {m.contextWindow !== null ? formatCapacity(m.contextWindow) : "?"}
                        {" / "}
                        {m.maxTokens !== null ? formatCapacity(m.maxTokens) : "?"}
                      </span>
                    ) : null}
                  </label>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={() => setCandidates(null)} className="rounded-lg border border-border-line px-3 py-1.5 text-xs text-text-muted hover:bg-bg-card">取消</button>
              <button
                type="button"
                onClick={adoptCandidates}
                disabled={checked.size === 0}
                className="rounded-lg bg-accent-focus px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-focus-hover disabled:opacity-40"
              >
                采纳所选（{checked.size}）
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </form>
  );
}

export default function ModelsSection({ initial }: ModelsSectionProps) {
  const flashStatusBanner = useAppStore((s) => s.flashStatusBanner);
  const [payload, setPayload] = useState<SettingsPayload | null>(initial);
  const [catalog, setCatalog] = useState<ProviderCatalogEntry[] | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addEntryId, setAddEntryId] = useState("");
  const [declaring, setDeclaring] = useState(false);
  const [dismissedSetup, setDismissedSetup] = useState<ReadonlySet<string>>(new Set());
  const [deleteId, setDeleteId] = useState<string | null>(null);
  // X5：创建时撞到已存在 id 的覆盖确认（409 provider-exists）。
  const [conflict, setConflict] = useState<{ profile: EditorProfile; apiKey: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [catalogRetry, setCatalogRetry] = useState(0);
  // X4：添加卡按目录条目缓存整卡草稿（切换条目不丢输入）。
  const addDraftsRef = useRef(new Map<string, AddCardDraft>());

  // SettingsDialog loads its payload asynchronously. Keep the section in
  // sync when it becomes available after the models tab has mounted, while
  // preserving any in-progress editor state in the card itself.
  useEffect(() => {
    if (initial !== null) {
      setPayload(initial);
      // An empty provider directory needs an editor to get started. A
      // provider that exists but lacks a key uses the dsh setup-row posture
      // and must not open a second add card beside it.
      if (initial.providers.length === 0) setAdding(true);
    }
  }, [initial]);

  useEffect(() => {
    let alive = true;
    // 目录加载失败不阻塞页面：手填与编辑既有 provider 的路径完全可用，
    // 但必须显式提示——否则「＋ 添加供应商」会被静默禁用成死按钮。
    setCatalogFailed(false);
    void api.providerCatalog().then(
      (result) => { if (alive) setCatalog(result.catalog); },
      () => { if (alive) { setCatalog([]); setCatalogFailed(true); } },
    );
    return () => { alive = false; };
  }, [catalogRetry]);

  const providers = useMemo(() => payload?.providers ?? [], [payload]);
  const activeId = payload?.activeProviderId ?? "";
  const anyUsable = providers.some((p) => p.apiKeyConfigured);

  const addableCatalog = useMemo(() => {
    if (!catalog) return [];
    return catalog.filter((entry) => entry.id !== "custom" && !providers.some((p) => p.id === entry.id));
  }, [catalog, providers]);

  useEffect(() => {
    if ((adding || !anyUsable) && !addEntryId && addableCatalog.length > 0) {
      setAddEntryId(addableCatalog[0].id);
    }
  }, [adding, anyUsable, addEntryId, addableCatalog]);

  // 首次运行姿态：没有任何可用 provider 时，第一张缺 Key 的行自动展开 setup 卡。
  const setupId = anyUsable
    ? null
    : providers.find((p) => !p.apiKeyConfigured && !dismissedSetup.has(p.id))?.id ?? null;

  function dismissSetup(id: string) {
    setDismissedSetup((current) => new Set([...current, id]));
  }

  function closeAllCards() {
    setEditingId(null);
    setAdding(false);
    setDeclaring(false);
  }

  /** 打开某行的编辑器；一次只开一张卡，打开前先收起其他卡。 */
  function openEditOnly(id: string) {
    setAdding(false);
    setDeclaring(false);
    setEditingId(id);
  }

  async function handleSave(profile: EditorProfile, apiKey: string) {
    const wasActive = payload?.activeProviderId ?? "";
    let saved = await api.saveProvider(profile);
    if (apiKey) {
      saved = await api.setProviderCredential(profile.id, apiKey);
    }
    setPayload(saved);
    // 保存后不再对该行重开 setup 姿态（即使仍未贴 Key）。
    setDismissedSetup((current) => new Set([...current, profile.id]));
    closeAllCards();
    const label = profile.name || profile.id;
    flashStatusBanner(
      saved.activeProviderId === profile.id && wasActive !== profile.id
        ? `已保存并激活 ${label}（新对话与课程构建将使用它）`
        : `模型配置已保存（${label}）`,
    );
  }

  /** X5：保存时若目标 id 已存在且未带 overwrite，后端返回 409；弹确认框。 */
  async function handleSaveWithConflict(profile: EditorProfile, apiKey: string) {
    try {
      await handleSave(profile, apiKey);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "provider-exists") {
        setConflict({ profile, apiKey });
        return;
      }
      throw cause;
    }
  }

  /** 用户在确认框点「覆盖」：带 overwrite 重发。 */
  async function handleOverwrite() {
    if (!conflict) return;
    setBusy(true);
    setError(null);
    try {
      const { profile, apiKey } = conflict;
      let saved = await api.saveProvider({ ...profile, overwrite: true });
      if (apiKey) {
        saved = await api.setProviderCredential(profile.id, apiKey);
      }
      setPayload(saved);
      setConflict(null);
      closeAllCards();
      flashStatusBanner(`已覆盖 ${profile.name || profile.id} 的配置`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string) {
    setBusy(true);
    setError(null);
    try {
      const next = await api.deleteProvider(id);
      setPayload(next);
      setDeleteId(null);
      flashStatusBanner(`已删除 ${id}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleActivate(id: string) {
    try {
      const next = await api.activateProvider(id);
      setPayload(next);
      flashStatusBanner(`已切换为 ${id}`);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  const selectedEntry = addableCatalog.find((entry) => entry.id === addEntryId) ?? null;

  return (
    <section className="flex max-w-[720px] flex-col gap-3">
      <div>
        <h3 className="text-base font-medium text-text-primary">模型配置</h3>
        <p className="mt-1 text-sm leading-6 text-text-faint">
          配置会立即用于新的对话和课程构建任务。API Key 以写入方式保存，不显示明文。
        </p>
      </div>

      {error ? (
        <div className="rounded-xl border border-accent-fail/30 bg-accent-fail/5 p-3 text-xs text-accent-fail" role="alert">
          {error}
        </div>
      ) : null}

      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {providers.map((provider) => {
          const setupPosture = setupId === provider.id;
          const editing = editingId === provider.id;
          return (
            <li key={provider.id} className="rounded-xl border border-border-line bg-bg-panel p-3">
              <div className="flex items-center gap-2.5">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${provider.apiKeyConfigured ? "bg-accent-pass" : "bg-accent-fail"}`}
                  title={provider.apiKeyConfigured ? "API Key 已配置" : "API Key 缺失"}
                />
                <span className="min-w-0 truncate text-sm font-medium text-text-primary">
                  {provider.name || provider.id}
                </span>
                <span className="rounded border border-border-line px-1.5 py-0.5 text-[11px] leading-4 text-text-muted">
                  {provider.id}
                </span>
                {provider.id === activeId ? (
                  <span
                    className="rounded bg-accent-focus/10 px-1.5 py-0.5 text-[11px] font-medium leading-4 text-accent-focus"
                    title="新对话与课程构建（/build）将使用该供应商"
                  >
                    使用中
                  </span>
                ) : null}
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void handleActivate(provider.id)}
                    disabled={provider.id === activeId}
                    title="激活后新对话与课程构建将使用该供应商"
                    className="rounded-full border border-border-line px-2.5 py-1 text-xs text-text-muted hover:bg-bg-card disabled:opacity-40"
                  >
                    激活
                  </button>
                  <button
                    type="button"
                    aria-expanded={editing || setupPosture}
                    onClick={() => {
                      if (editing) setEditingId(null);
                      else openEditOnly(provider.id);
                    }}
                    className="rounded-full border border-border-line px-2.5 py-1 text-xs text-text-muted hover:bg-bg-card"
                  >
                    {editing || setupPosture ? "收起" : "编辑"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteId(provider.id)}
                    className="rounded-full px-2.5 py-1 text-xs text-accent-fail hover:bg-accent-fail/10"
                  >
                    删除
                  </button>
                </div>
              </div>
              {editing || setupPosture ? (
                <div className="mt-3">
                  <ProviderEditorCard
                    provider={provider}
                    entry={null}
                    creating={false}
                    onSave={handleSaveWithConflict}
                    onCancel={() => {
                      setEditingId(null);
                      if (setupPosture) dismissSetup(provider.id);
                    }}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {catalogFailed ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-accent-warn/30 bg-accent-warn/5 p-3 text-xs text-accent-warn" role="alert">
          <span>内置供应商目录加载失败，「＋ 添加供应商」暂不可用；仍可使用自定义 OpenAI 兼容。</span>
          <button
            type="button"
            onClick={() => setCatalogRetry((n) => n + 1)}
            className="shrink-0 rounded-lg border border-accent-warn/40 px-2.5 py-1 text-accent-warn hover:bg-accent-warn/10"
          >
            重试
          </button>
        </div>
      ) : null}

      {adding ? (
        <div className="rounded-xl bg-bg-card p-4 shadow-lv2">
          <label className="mb-3 flex flex-col gap-1.5 text-xs text-text-secondary">
            选择供应商
            <select
              value={addEntryId}
              onChange={(e) => setAddEntryId(e.target.value)}
              className="h-9 w-full rounded-lg border border-border-line bg-bg-root px-3 text-[13px] text-text-primary outline-none focus:border-accent-focus"
            >
              {addableCatalog.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.name}</option>
              ))}
            </select>
            <span className="text-[11px] text-text-faint">地址已预填；模型请手动添加或从端点获取后选择。</span>
          </label>
          {selectedEntry ? (
            <ProviderEditorCard
              key={selectedEntry.id}
              provider={null}
              entry={selectedEntry}
              creating
              onSave={handleSaveWithConflict}
              onCancel={() => setAdding(false)}
              draftCache={addDraftsRef.current}
            />
          ) : (
            <p className="text-xs text-text-faint">正在加载内置供应商目录...</p>
          )}
        </div>
      ) : declaring ? (
        <ProviderEditorCard
          provider={null}
          entry={null}
          creating
          onSave={handleSaveWithConflict}
          onCancel={() => setDeclaring(false)}
        />
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={addableCatalog.length === 0}
            onClick={() => { setEditingId(null); setDeclaring(false); setAdding(true); }}
            className="flex-1 rounded-xl border border-border-line px-3 py-2 text-sm text-text-muted hover:bg-bg-card disabled:opacity-40"
          >
            ＋ 添加供应商
          </button>
          <button
            type="button"
            onClick={() => { setEditingId(null); setAdding(false); setDeclaring(true); }}
            className="flex-1 rounded-xl border border-border-line px-3 py-2 text-sm text-text-muted hover:bg-bg-card"
          >
            ＋ 自定义 OpenAI 兼容
          </button>
        </div>
      )}

      {deleteId ? (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/30 p-4"
          role="presentation"
          onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setDeleteId(null); }}
        >
          <div role="dialog" aria-modal="true" className="w-[380px] rounded-xl border border-border-line bg-bg-panel p-4 shadow-lv3">
            <h4 className="text-sm font-medium text-text-primary">确认删除 Provider</h4>
            <p className="mt-2 text-sm text-text-muted">确定要删除 {deleteId} 吗？该操作同时会移除已保存的 API Key。</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" disabled={busy} onClick={() => setDeleteId(null)} className="rounded-lg border border-border-line px-3 py-1.5 text-xs text-text-muted hover:bg-bg-card disabled:opacity-40">取消</button>
              <button type="button" disabled={busy} onClick={() => void handleDelete(deleteId)} className="rounded-lg bg-accent-fail px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-fail/80 disabled:opacity-40">
                {busy ? "删除中..." : "删除"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {conflict ? (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/30 p-4"
          role="presentation"
          onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setConflict(null); }}
        >
          <div role="dialog" aria-modal="true" aria-label="Provider 已存在" className="w-[380px] rounded-xl border border-border-line bg-bg-panel p-4 shadow-lv3">
            <h4 className="text-sm font-medium text-text-primary">Provider 已存在</h4>
            <p className="mt-2 text-sm text-text-muted">
              「{conflict.profile.id}」已存在。覆盖会保留其 API Key，但会用当前表单内容替换配置。确定覆盖吗？
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" disabled={busy} onClick={() => setConflict(null)} className="rounded-lg border border-border-line px-3 py-1.5 text-xs text-text-muted hover:bg-bg-card disabled:opacity-40">取消</button>
              <button type="button" disabled={busy} onClick={() => void handleOverwrite()} className="rounded-lg bg-accent-focus px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-focus-hover disabled:opacity-40">
                {busy ? "覆盖中..." : "覆盖"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

interface ModelsSectionProps {
  initial: SettingsPayload | null;
}
