import type { ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export const panelSurfaceClass =
  "rounded-lg border border-border-line bg-bg-panel shadow-[0_1px_2px_rgba(15,17,21,0.03)]";

type Tone = "neutral" | "focus" | "pass" | "warn" | "fail";

const toneClasses: Record<Tone, string> = {
  neutral: "border-border-line bg-bg-root text-text-muted",
  focus: "border-accent-focus/25 bg-accent-focus/8 text-accent-focus",
  pass: "border-accent-pass/25 bg-accent-pass/8 text-accent-pass",
  warn: "border-accent-warn/30 bg-accent-warn/10 text-accent-warn",
  fail: "border-accent-fail/25 bg-accent-fail/8 text-accent-fail",
};

const progressClasses: Record<Tone, string> = {
  neutral: "bg-text-faint",
  focus: "bg-accent-focus",
  pass: "bg-accent-pass",
  warn: "bg-accent-warn",
  fail: "bg-accent-fail",
};

export function PanelSection({
  title,
  icon: Icon,
  action,
  className,
  children,
}: {
  title: string;
  icon: LucideIcon;
  action?: ReactNode;
  /** PERF-3：非激活视图传 "hidden" 保活挂载而不显示。 */
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={className === undefined ? "space-y-2" : `space-y-2 ${className}`}>
      <div className="flex min-h-5 items-center gap-2 px-0.5">
        <Icon size={15} strokeWidth={1.8} className="shrink-0 text-text-muted" aria-hidden />
        <h2 className="min-w-0 flex-1 text-[13px] font-medium text-text-primary">{title}</h2>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function StatusPill({
  tone = "neutral",
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  return (
    <span className={`inline-flex min-h-6 items-center gap-1 rounded-md border px-1.5 text-[11px] leading-4 ${toneClasses[tone]}`}>
      {children}
    </span>
  );
}

export function LinearProgress({
  value,
  tone = "focus",
  label,
}: {
  value: number;
  tone?: Tone;
  label?: string;
}) {
  const percent = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-bg-card"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className={`h-full rounded-full transition-[width] duration-300 ${progressClasses[tone]}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export function PanelSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="正在加载面板内容">
      {Array.from({ length: lines }).map((_, index) => (
        <div
          key={index}
          className={`animate-pulse rounded-lg border border-border-faint bg-bg-card/60 ${index === 0 ? "h-20" : "h-11"}`}
        />
      ))}
    </div>
  );
}

export function PanelEmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-h-32 flex-col items-center justify-center rounded-lg border border-dashed border-border-line bg-bg-root/60 px-5 text-center">
      <Icon size={20} strokeWidth={1.6} className="mb-2 text-text-faint" aria-hidden />
      <p className="text-[13px] font-medium text-text-muted">{title}</p>
      <p className="mt-1 max-w-[240px] text-[11px] leading-5 text-text-faint">{description}</p>
    </div>
  );
}

export function PanelErrorState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-accent-fail/25 bg-accent-fail/8 p-3" role="alert">
      <div className="flex items-start gap-2">
        <AlertCircle size={16} strokeWidth={1.8} className="mt-0.5 shrink-0 text-accent-fail" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-medium text-accent-fail">{title}</p>
          <p className="mt-1 break-words text-[11px] leading-5 text-accent-fail/80">{description}</p>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </div>
  );
}

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string; icon?: LucideIcon }>;
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-lg bg-bg-card p-0.5">
      {options.map(({ value: optionValue, label: optionLabel, icon: Icon }) => {
        const active = optionValue === value;
        return (
          <button
            key={optionValue}
            type="button"
            aria-pressed={active}
            title={optionLabel}
            onClick={() => onChange(optionValue)}
            className={`flex h-7 items-center justify-center gap-1 rounded-md px-2 text-[11px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-focus ${
              active
                ? "bg-bg-panel text-text-primary shadow-[0_1px_2px_rgba(15,17,21,0.08)]"
                : "text-text-muted hover:text-text-primary"
            }`}
          >
            {Icon ? <Icon size={13} strokeWidth={1.8} aria-hidden /> : null}
            <span>{optionLabel}</span>
          </button>
        );
      })}
    </div>
  );
}
