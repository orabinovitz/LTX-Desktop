import {
  Loader2,
  Check,
  X,
  ChevronDown,
  ChevronRight,
  Ban,
  GitBranch,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentProgress, AgentTask } from "@/types/agent-progress";

const AUTO_COLLAPSE_DELAY_MS = 1500;

interface TaskProgressViewProps {
  progress: AgentProgress;
  onSetCollapsed: (value: boolean) => void;
}

function useElapsedTime(startedAt: number, completedAt?: number): string {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (completedAt || startedAt === 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt, completedAt]);

  const end = completedAt ?? now;
  const ms = end - startedAt;
  if (startedAt === 0 || ms < 1000) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function TaskStatusIcon({ status }: { status: AgentTask["status"] }) {
  switch (status) {
    case "pending":
      return (
        <div className="h-4 w-4 flex-shrink-0 rounded-full border border-zinc-600 transition-all duration-300" />
      );
    case "in_progress":
      return (
        <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-blue-400" />
      );
    case "completed":
      return (
        <div className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-emerald-500/20 transition-all duration-300">
          <Check className="h-2.5 w-2.5 text-emerald-400" />
        </div>
      );
    case "failed":
      return (
        <div className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-red-500/20 transition-all duration-300">
          <X className="h-2.5 w-2.5 text-red-400" />
        </div>
      );
    case "cancelled":
      return (
        <div className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-zinc-500/20 transition-all duration-300">
          <Ban className="h-2.5 w-2.5 text-zinc-500" />
        </div>
      );
  }
}

function SkillBadge({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center rounded-sm bg-violet-500/15 px-1.5 py-0.5 text-[9px] font-medium text-violet-400">
      {name}
    </span>
  );
}

function DependencyIndicator({ deps, allTasks }: { deps: string[]; allTasks: AgentTask[] }) {
  if (!deps || deps.length === 0) return null;

  const depTasks = deps
    .map((id) => allTasks.find((t) => t.id === id))
    .filter(Boolean) as AgentTask[];

  const allResolved = depTasks.every(
    (t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled",
  );

  if (allResolved) return null;

  const waitingOn = depTasks
    .filter((t) => t.status !== "completed" && t.status !== "failed" && t.status !== "cancelled")
    .map((t) => t.label);

  return (
    <div className="mt-0.5 flex items-center gap-1 text-[9px] text-zinc-600">
      <GitBranch className="h-2.5 w-2.5" />
      <span>Waiting on: {waitingOn.join(", ")}</span>
    </div>
  );
}

function TaskItem({
  task,
  allTasks,
  isOrchestrated,
}: {
  task: AgentTask;
  allTasks: AgentTask[];
  isOrchestrated: boolean;
}) {
  const isActive = task.status === "in_progress";
  const isFailed = task.status === "failed";
  const isDone = task.status === "completed";
  const isCancelled = task.status === "cancelled";
  const elapsed = useElapsedTime(task.startedAt ?? 0, task.completedAt);

  return (
    <div
      className={`flex items-start gap-2.5 rounded-md px-2.5 py-2 transition-all duration-300 ${
        isActive
          ? "bg-blue-500/8 shadow-[inset_0_0_0_1px_rgba(59,130,246,0.15)]"
          : isFailed
            ? "bg-red-500/5"
            : isDone
              ? "opacity-70"
              : isCancelled
                ? "opacity-40"
                : ""
      }`}
    >
      <div className="mt-[1px]">
        <TaskStatusIcon status={task.status} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={`text-[12px] leading-tight transition-colors duration-300 ${
              isDone
                ? "text-zinc-500 line-through decoration-zinc-700"
                : isFailed
                  ? "text-red-400"
                  : isCancelled
                    ? "text-zinc-600 line-through decoration-zinc-700"
                    : isActive
                      ? "font-medium text-zinc-100"
                      : "text-zinc-400"
            }`}
          >
            {task.label}
          </span>
          {elapsed && (
            <span className="flex-shrink-0 text-[10px] tabular-nums text-zinc-600">
              {elapsed}
            </span>
          )}
        </div>

        {isOrchestrated && task.skillName && (
          <div className="mt-1">
            <SkillBadge name={task.skillName} />
          </div>
        )}

        {isOrchestrated && task.dependsOn && task.status === "pending" && (
          <DependencyIndicator deps={task.dependsOn} allTasks={allTasks} />
        )}

        {task.detail && isActive && (
          <p className="mt-0.5 text-[10px] text-zinc-500 transition-opacity duration-200">
            {task.detail}
          </p>
        )}

        {task.error && (isFailed || isCancelled) && (
          <p className="mt-0.5 text-[10px] text-red-400/70">{task.error}</p>
        )}

        {task.progress !== undefined && task.progress < 100 && isActive && (
          <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-gradient-to-r from-blue-500 to-blue-400 transition-all duration-500 ease-out"
              style={{
                width: `${Math.min(100, Math.max(0, task.progress))}%`,
              }}
            />
          </div>
        )}

        {task.subtasks && task.subtasks.length > 0 && (
          <div className="mt-1.5 space-y-0.5 border-l border-zinc-800 pl-2.5">
            {task.subtasks.map((sub) => (
              <TaskItem
                key={sub.id}
                task={sub}
                allTasks={allTasks}
                isOrchestrated={isOrchestrated}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ThinkingPulse({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 px-2.5">
      <div className="flex gap-1">
        <span
          className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400/60"
          style={{ animationDelay: "0ms" }}
        />
        <span
          className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400/60"
          style={{ animationDelay: "150ms" }}
        />
        <span
          className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400/60"
          style={{ animationDelay: "300ms" }}
        />
      </div>
      <span className="text-[11px] text-zinc-500">{text}</span>
    </div>
  );
}

export function TaskProgressView({
  progress,
  onSetCollapsed,
}: TaskProgressViewProps) {
  const collapsed = progress.collapsed;
  const isFinished = progress.phase === "done" || progress.phase === "error";
  const isOrchestrated = progress.isOrchestrated ?? false;
  const completedCount = progress.tasks.filter(
    (t) => t.status === "completed",
  ).length;
  const failedCount = progress.tasks.filter(
    (t) => t.status === "failed",
  ).length;
  const cancelledCount = progress.tasks.filter(
    (t) => t.status === "cancelled",
  ).length;
  const totalCount = progress.tasks.length;
  const totalElapsed = useElapsedTime(
    progress.startedAt,
    progress.completedAt,
  );

  const autoCollapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (isFinished && !collapsed) {
      autoCollapseTimer.current = setTimeout(() => {
        onSetCollapsed(true);
      }, AUTO_COLLAPSE_DELAY_MS);
    }
    return () => {
      if (autoCollapseTimer.current) {
        clearTimeout(autoCollapseTimer.current);
        autoCollapseTimer.current = null;
      }
    };
  }, [isFinished, collapsed, onSetCollapsed]);

  if (progress.phase === "idle") return null;

  const showTasks = !collapsed && progress.tasks.length > 0;

  const summaryLabel = (() => {
    if (isFinished) {
      const parts: string[] = [];
      if (completedCount > 0) parts.push(`${completedCount} done`);
      if (failedCount > 0) parts.push(`${failedCount} failed`);
      if (cancelledCount > 0) parts.push(`${cancelledCount} cancelled`);
      return parts.join(", ") || `${completedCount}/${totalCount} completed`;
    }
    return `${completedCount}/${totalCount} tasks`;
  })();

  return (
    <div
      className="space-y-2 transition-all duration-300"
      data-testid="task-progress-view"
    >
      {progress.reasoning && !isFinished && (
        <div className="px-2.5" data-testid="reasoning-block">
          <p className="text-[11px] italic leading-relaxed text-zinc-500">
            {progress.reasoning}
          </p>
        </div>
      )}

      {progress.thinkingLine && !isFinished && (
        <ThinkingPulse text={progress.thinkingLine} />
      )}

      {progress.tasks.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/60 transition-all duration-300">
          <button
            onClick={() => onSetCollapsed(!collapsed)}
            className="flex w-full items-center gap-1.5 px-3 py-2 text-left transition-colors hover:bg-zinc-800/40"
            data-testid="collapse-toggle"
          >
            <div className="transition-transform duration-200">
              {collapsed ? (
                <ChevronRight className="h-3 w-3 text-zinc-500" />
              ) : (
                <ChevronDown className="h-3 w-3 text-zinc-500" />
              )}
            </div>

            <div className="flex flex-1 items-center gap-2">
              {isOrchestrated && (
                <span className="rounded-sm bg-violet-500/15 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wider text-violet-400">
                  Multi-Agent
                </span>
              )}
              <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                {summaryLabel}
              </span>

              {!isFinished && totalCount > 0 && (
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-blue-500/50 transition-all duration-500"
                    style={{
                      width: `${(completedCount / totalCount) * 100}%`,
                    }}
                  />
                </div>
              )}
            </div>

            {totalElapsed && (
              <span className="text-[10px] tabular-nums text-zinc-600">
                {totalElapsed}
              </span>
            )}
          </button>

          <div
            className={`transition-all duration-300 ease-in-out ${
              showTasks
                ? "max-h-[600px] opacity-100"
                : "max-h-0 overflow-hidden opacity-0"
            }`}
          >
            <div className="space-y-0.5 overflow-y-auto px-1.5 pb-2" style={{ maxHeight: "400px" }}>
              {progress.tasks.map((task) => (
                <TaskItem
                  key={task.id}
                  task={task}
                  allTasks={progress.tasks}
                  isOrchestrated={isOrchestrated}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {progress.phase === "error" && progress.error && (
        <div className="rounded-md border border-red-900/30 bg-red-900/10 px-3 py-2 text-[11px] text-red-400">
          {progress.error}
        </div>
      )}

      {isFinished && totalCount === 0 && !progress.error && (
        <div className="flex items-center gap-2 px-2.5">
          <Check className="h-3 w-3 text-emerald-400" />
          <span className="text-[11px] text-zinc-400">Done</span>
        </div>
      )}
    </div>
  );
}
