/**
 * Command Palette 数据与模糊匹配（T3.5，ui_design_spec §5 Ctrl+K）。
 *
 * - fuzzyScore：空查询全命中；子串命中高权重；否则子序列匹配（如 `swc`
 *   → `:switch-course`），连续命中加分；不匹配返回 -1 过滤。
 * - PALETTE_ITEMS：静态指令条目；`/switch-course` 为动态二级（进入课程
 *   子菜单，不直接执行）；执行逻辑复用 lib/commands.runCommand。
 */

export interface PaletteItem {
  id: string;
  label: string;
  desc: string;
  keywords: string; // 别名/中文描述（模糊匹配也会命中）
  shortcut?: string;
}

export const PALETTE_ITEMS: PaletteItem[] = [
  {
    id: "build",
    label: "/build",
    desc: "构建课程知识索引",
    keywords: "构建 索引 知识 build",
  },
  {
    id: "quiz",
    label: "/quiz",
    desc: "检验掌握度（新题模式）",
    keywords: "新题 检验 出题 测试",
  },
  {
    id: "review",
    label: "/review",
    desc: "SM-2 到期复习",
    keywords: "复习 到期 回顾",
  },
  {
    id: "sync",
    label: "/sync",
    desc: "增量同步资料并构建",
    keywords: "同步 构建 build 增量",
  },
  {
    id: "switch-course",
    label: "/switch-course",
    desc: "切换学习项目",
    keywords: "切换 项目 课程 course 换课",
  },
  {
    id: "switch-model",
    label: "/switch-model",
    desc: "切换模型（全局生效）",
    keywords: "切换 模型 model provider 供应商",
  },
  {
    id: "summary",
    label: "/summary",
    desc: "整理结构化学习笔记",
    keywords: "总结 笔记 summary 学习",
  },
  {
    id: "help",
    label: "/help",
    desc: "查看全部可用命令",
    keywords: "帮助 命令 help 帮助文档 用法",
  },
  {
    id: "new-session",
    label: "新建对话",
    desc: "在当前项目下新建对话",
    keywords: "对话 新开 session",
    shortcut: "Ctrl+N",
  },
];

/**
 * 模糊评分：返回 >=0 分数（越大越靠前）或 -1（不匹配）。
 * 子串命中 1000+ 位置加权；子序列每命中 +1，相邻连续再 +2。
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const t = text.toLowerCase();
  const sub = t.indexOf(q);
  if (sub >= 0) return 1000 - sub;
  let ti = 0;
  let score = 0;
  let prev = -2;
  for (let qi = 0; qi < q.length; qi += 1) {
    const idx = t.indexOf(q[qi], ti);
    if (idx < 0) return -1; // 查询剩余字符无法匹配（含查询比目标长的情况）
    score += idx === prev + 1 ? 2 : 1;
    prev = idx;
    ti = idx + 1;
  }
  return score;
}

/** 按查询对条目过滤排序（分数降序）。 */
export function filterItems<T extends { label: string; keywords: string }>(
  items: T[],
  query: string,
): T[] {
  return items
    .map((item) => {
      const haystack = `${item.label} ${item.keywords}`;
      const score = fuzzyScore(query, haystack);
      return { item, score };
    })
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);
}
