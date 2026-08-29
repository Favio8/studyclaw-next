/**
 * 吉祥物「爪爪 / Clawzy」状态集。
 *
 * MVP 六态（设计文档决策 4，姿态经原型评审）：
 * - idle       静置（呼吸/眨眼/扫视/尾巴慢摆）
 * - listening  输入框聚焦（侧头倾听）
 * - thinking   思考（歪头、视线游移、半眯眼）
 * - writing    流式输出（打字双爪交替）
 * - celebrate  quiz 答对庆祝（举爪 + 跳跃，2400ms 脉冲）
 * - alerting   会话出错（皱眉抖动，直到用户重试/新消息）
 *
 * P1 八态（设计文档 §7.2，姿态按既有词汇设计，未经原型评审）：
 * - sleeping   静置超 5 分钟（闭眼横线、极缓呼吸；引擎内部由 idle 计时驱动）
 * - waking     从睡眠被唤醒（惊醒→强制双眨→归位，约 1.8s 过渡）
 * - searching  流式期间工具执行中（眼左右扫、单爪前探）
 * - working    课程构建中 buildStatus=running（双爪交替搬卡）
 * - uploading  资料上传中（双爪上举微晃、仰头看进度）
 * - asking     Agent 显式提问等待作答（单爪前伸、期待圆眼）
 * - encourage  quiz 答错（委屈歪头、双爪轻拍加油；与 alerting 严格区分）
 * - progress   同步进行中 syncState=syncing（双爪悬吊、目光固定）
 */
export type MascotState =
  | "idle"
  | "listening"
  | "thinking"
  | "writing"
  | "celebrate"
  | "alerting"
  | "sleeping"
  | "waking"
  | "searching"
  | "working"
  | "uploading"
  | "asking"
  | "encourage"
  | "progress";

/**
 * 渲染分级（评审结论落地）：
 * - icon：14-32px 消息署名 / 流式指示 / 同步 pill。简化脸（无内耳三角、
 *   无眼高光、无嘴线），弹簧子集 bob/spin/squash/lid，裁掉扫视、耳抽动、
 *   hop 与眨眼关键帧花样（保留普通眨眼），为 16px 兜底 + 省帧预算。
 * - full：≥48px hero / quiz 结果。完整脸 + 全部动效（含耳朵抽动）。
 */
export type MascotTier = "icon" | "full";

export interface ClawzyProps {
  /** 受控状态；缺省走 useMascotState() 从全局 store 自动派生。 */
  state?: MascotState;
  /** 渲染边长（px）。SVG viewBox 240 等比缩放，宽高恒等于 size，不产生布局位移。 */
  size: number;
  /** 缺省按 size 自动：<48 → icon，≥48 → full。 */
  tier?: MascotTier;
  /** 无障碍标签；缺省 `爪爪：${state}`。 */
  ariaLabel?: string;
}
