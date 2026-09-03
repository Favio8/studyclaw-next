/**
 * 中栏输入的快捷命令（DSH 风格）。
 *
 * `/command` 是主语法，旧版 `:command` 继续兼容。命令后可以带简短参数，
 * 例如 `/build 开始构架`；普通路径中的斜杠不会被误判。
 */

import { api } from "@/src/lib/api";
import { quizLoad } from "@/src/lib/quizFlow";
import { refreshCourseList, refreshPanelData } from "@/src/lib/panelData";
import { useAppStore } from "@/src/store/useAppStore";

const COMMAND_RE = /^[/ :]([a-z][a-z-]*)(?:\s+[\s\S]*)?$/;

export const COMMANDS = [
  { name: "build", description: "构建或刷新课程知识索引" },
  { name: "quiz", description: "生成一组新题" },
  { name: "review", description: "开始到期复习" },
  { name: "summary", description: "整理本课程的结构化学习笔记" },
  { name: "sync", description: "扫描变更并增量构建" },
  { name: "switch-course", description: "切换到下一个课程" },
  { name: "help", description: "查看可用命令" },
] as const;

export const SUMMARY_PROMPT =
  "请基于当前课程资料、课程大纲、当前学习进度和本次对话，生成一份结构化学习笔记。包括：核心概念、概念之间的关系、我的薄弱点、仍待澄清的问题，以及下一步建议。不要编造课程资料中不存在的事实。";

export interface CommandResult {
  handled: boolean;
  feedback?: string;
  /** 命令需要进入导师上下文时，用此文本替换原始命令。 */
  prompt?: string;
}

/** 提取指令名；非指令形态返回 null（调用方按普通消息发送）。 */
export function parseCommand(text: string): string | null {
  const match = COMMAND_RE.exec(text.trim());
  return match ? match[1] : null;
}

function errorMessage(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** UI-8：命令层在途构建互斥（跨实例/重复触发）；真正的并发兜底在服务端
 * JobManager 按 courseDir 去重。 */
const activeBuildCourses = new Set<string>();

export async function runCommand(command: string): Promise<CommandResult> {
  const store = useAppStore.getState();

  switch (command) {
    case "build":
    case "sync": {
      if (!store.activeCourseId) {
        return { handled: true, feedback: `${command}: 未选择项目` };
      }
      const courseId = store.activeCourseId;
      // UI-8：同一课程的构建已在途 → 直接反馈，不再叠加轮询与横幅。
      if (activeBuildCourses.has(courseId)) {
        return { handled: true, feedback: `${command}: 该项目的构建已在进行中，请等待完成` };
      }
      activeBuildCourses.add(courseId);
      try {
        return await runBuildSync(command, courseId);
      } finally {
        activeBuildCourses.delete(courseId);
      }
    }

    case "quiz": {
      store.setActiveTab("quiz");
      void quizLoad("new");
      return { handled: true, feedback: "🎯 QUIZ // 新题模式" };
    }

    case "review": {
      store.setActiveTab("quiz");
      void quizLoad("review", true); // 严格到期复习：不补新卡（对齐 review 命令语义）
      return { handled: true, feedback: "🎯 REVIEW // 复习模式" };
    }

    case "summary":
      return { handled: false, prompt: SUMMARY_PROMPT };

    case "help":
      return {
        handled: true,
        feedback: "可用命令：/build /quiz /review /summary /sync /switch-course",
      };

    case "switch-course": {
      const { courses, activeCourseId } = store;
      if (courses.length === 0) {
        return { handled: true, feedback: "switch-course: 无项目可切换" };
      }
      const idx = courses.findIndex((c) => c.id === activeCourseId);
      const next = courses[(idx + 1) % courses.length] ?? courses[0]!;
      // UI-16：idx=-1（未选课程）时取第一门；若转一圈仍是当前课程
      //（唯一课程），自切换会让 setActiveCourse 清空整个中栏视图——直接反馈。
      if (next.id === activeCourseId) {
        return { handled: true, feedback: "switch-course: 已是最后一个项目" };
      }
      store.setActiveCourse(next.id);
      return { handled: true, feedback: `switch → ${next.title}` };
    }

    default:
      return { handled: false };
  }
}

/** build/sync 的实际执行体（UI-8：从 runCommand 拆出以便互斥包裹）。 */
async function runBuildSync(command: "build" | "sync", courseId: string): Promise<CommandResult> {
  const store = useAppStore.getState();
  store.setBuildStatus("running");
  store.setSyncState("syncing");
  // Give immediate feedback before the async job and LLM work begin.
  // Without this, a long build looks like the command was ignored.
  store.flashStatusBanner(
    command === "build"
      ? "BUILD // 正在构建课程知识索引…"
      : "SYNC // 正在扫描课程资料…",
  );
  try {
    // 带上当前会话：让构建沿用会话内已选的 provider/model（模型座位显示
    // 的那条路由），而不是退回激活供应商的默认模型。
    const res = await api.sync(courseId, store.activeSessionId);
    const done = res.buildJobId
      ? await pollJob(res.buildJobId, courseId, (msg) => {
          useAppStore.getState().flashStatusBanner(`BUILD // ${msg}`);
        })
      : "ok";
    await Promise.all([refreshPanelData(), refreshCourseList()]);
    return {
      handled: true,
      feedback: `✓ ${command} 完成（skipped ${res.skipped}，${done}）`,
    };
  } catch (exc) {
    // buildStatus 是全局态：仅当失败时仍停留在本课程才落 failed，
    // 防止切课后的旧构建失败污染新课的构建指示灯。
    if (useAppStore.getState().activeCourseId === courseId) {
      useAppStore.getState().setBuildStatus("failed");
    }
    return { handled: true, feedback: `✗ ${command} 失败: ${errorMessage(exc)}` };
  } finally {
    // A3（第三轮审查）：收尾同样要有课程归属守卫——切课后旧课程的构建
    // 完成/失败，不能把新课正在进行的 syncing 状态打回 synced。
    const current = useAppStore.getState();
    if (current.activeCourseId === courseId) {
      current.setSyncState("synced");
      if (current.buildStatus === "running") {
        current.setBuildStatus("done");
      }
    }
  }
}

async function pollJob(
  jobId: string,
  courseId: string,
  onProgress?: (msg: string) => void,
): Promise<string> {
  // 真实课程的 build 要跑多轮 LLM 出题（分钟级），60 秒的旧上限会在后端
  // 仍在正常推进时误报「build 超时」；与新建向导对齐放宽到 30 分钟。
  // F-7/PERF-8：消费后端 job.progress，前端不再只看到"正在构建…"黑盒。
  let lastProgress = "";
  for (let i = 0; i < 4500; i += 1) {
    const job = await api.job(jobId);
    if (job.status === "done") return `${job.result?.tasksGenerated ?? 0} 张新卡`;
    if (job.status === "failed") throw new Error(job.error ?? "build 失败");
    const p = job.progress;
    // UI-24：构建进度横幅只在发起课程仍是激活课程时弹出——切课后
    // 30 分钟的旧课程进度不再污染当前会话的状态横幅。
    const progressVisible = onProgress !== undefined
      && useAppStore.getState().activeCourseId === courseId;
    if (progressVisible && p !== undefined && p.total > 0 && p.finished < p.total) {
      const file = p.currentFile ? `（${p.currentFile}）` : "";
      const msg = `正在生成概念卡 ${p.finished}/${p.total}${file}`;
      if (msg !== lastProgress) {
        lastProgress = msg;
        onProgress(msg);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("build 超时（30 分钟仍未完成）");
}
