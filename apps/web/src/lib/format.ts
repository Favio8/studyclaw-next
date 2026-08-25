/**
 * 展示层格式化工具（T3.x）。
 */

/** 相对时间：3 分钟内「刚刚」，其余按粒度递进（左栏对话列表用）。 */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 3) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(then).toISOString().slice(0, 10);
}

/** 日期部分（ISO → YYYY-MM-DD；对话横幅「上次」用）。 */
export function dateOnly(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

/** 掌握度语义色 key（≥70 绿 / ≥40 黄 / 其余红，ui_design_spec §1.1）。 */
export function masteryTone(mastery: number): "pass" | "warn" | "fail" {
  if (mastery >= 0.7) return "pass";
  if (mastery >= 0.4) return "warn";
  return "fail";
}

/** 百分比展示（0.625 → 63%，四舍五入）。 */
export function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/** 消息时钟：ISO → 本地 HH:MM（消息 hover 时间显示用）。 */
export function formatMessageTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
