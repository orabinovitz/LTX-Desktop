import {
  Loader2,
  Check,
  X,
  ChevronDown,
  ChevronRight,
  Ban,
  GitBranch,
  Zap,
  Brain,
  Eye,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import { useEffect, useRef, useState, useMemo } from "react";
import type { AgentProgress, AgentTask, OrchestratorStatus } from "@/types/agent-progress";

const AUTO_COLLAPSE_DELAY_MS = 2500;
const COMPLETED_COLLAPSE_THRESHOLD = 3;

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

interface GroupedTasks {
  active: AgentTask[];
  pending: AgentTask[];
  completed: AgentTask[];
  failed: AgentTask[];
}

function groupTasksByStatus(tasks: AgentTask[]): GroupedTasks {
  const active: AgentTask[] = [];
  const pending: AgentTask[] = [];
  const completed: AgentTask[] = [];
  const failed: AgentTask[] = [];

  for (const task of tasks) {
    switch (task.status) {
      case "in_progress":
        active.push(task);
        break;
      case "pending":
        pending.push(task);
        break;
      case "completed":
        completed.push(task);
        break;
      case "failed":
      case "cancelled":
        failed.push(task);
        break;
    }
  }

  return { active, pending, completed, failed };
}

// --- Phase Badge ---

const PHASE_CONFIG: Record<string, { label: string; color: string; icon: typeof Zap }> = {
  planning: { label: "Planning", color: "bg-amber-500/15 text-amber-400 border-amber-500/20", icon: Brain },
  executing: { label: "Executing", color: "bg-blue-500/15 text-blue-400 border-blue-500/20", icon: Zap },
  awaiting_tool_results: { label: "Executing", color: "bg-blue-500/15 text-blue-400 border-blue-500/20", icon: Zap },
  reviewing: { label: "Reviewing", color: "bg-violet-500/15 text-violet-400 border-violet-500/20", icon: Eye },
  done: { label: "Complete", color: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20", icon: CheckCircle2 },
  error: { label: "Error", color: "bg-red-500/15 text-red-400 border-red-500/20", icon: AlertCircle },
};

function PhaseBadge({ status }: { status: OrchestratorStatus | undefined }) {
  const config = PHASE_CONFIG[status ?? "executing"] ?? PHASE_CONFIG["executing"];
  const Icon = config.icon;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-all duration-300 ${config.color}`}
    >
      <Icon className="h-2.5 w-2.5" />
      {config.label}
    </span>
  );
}

// --- Task Status Icons ---

function TaskStatusIcon({ status }: { status: AgentTask["status"] }) {
  switch (status) {
    case "pending":
      return (
        <div className="h-3.5 w-3.5 flex-shrink-0 rounded-full border border-zinc-600/60 transition-all duration-300" />
      );
    case "in_progress":
      return (
        <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-blue-400" />
      );
    case "completed":
      return (
        <div className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full bg-emerald-500/20 transition-all duration-300">
          <Check className="h-2 w-2 text-emerald-400" />
        </div>
      );
    case "failed":
      return (
        <div className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full bg-red-500/20 transition-all duration-300">
          <X className="h-2 w-2 text-red-400" />
        </div>
      );
    case "cancelled":
      return (
        <div className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full bg-zinc-500/20 transition-all duration-300">
          <Ban className="h-2 w-2 text-zinc-500" />
        </div>
      );
  }
}

function SkillBadge({ name, muted }: { name: string; muted?: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded px-1 py-0.5 text-[9px] font-medium ${
        muted
          ? "bg-zinc-700/40 text-zinc-500"
          : "bg-violet-500/15 text-violet-400"
      }`}
    >
      {name}
    </span>
  );
}

// --- Task Card (three modes) ---

function ActiveTaskCard({
  task,
  index,
}: {
  task: AgentTask;
  index: number;
}) {
  const elapsed = useElapsedTime(task.startedAt ?? 0, task.completedAt);

  return (
    <div
      className="flex items-start gap-2 rounded-md border-l-[3px] border-l-blue-500 bg-blue-500/[0.06] px-2.5 py-2 transition-all duration-300"
      style={{ animationDelay: `${index * 50}ms` }}
    >
      <div className="mt-px">
        <TaskStatusIcon status={task.status} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[12px] font-medium leading-tight text-zinc-100">
            {task.label}
          </span>
          {elapsed && (
            <span className="flex-shrink-0 text-[10px] tabular-nums text-zinc-500">
              {elapsed}
            </span>
          )}
        </div>

        {task.skillName && (
          <div className="mt-1">
            <SkillBadge name={task.skillName} />
          </div>
        )}

        {task.activeToolCalls && task.activeToolCalls.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {task.activeToolCalls.map((name) => (
              <span
                key={name}
                className="inline-flex items-center gap-1 rounded bg-zinc-800/80 px-1.5 py-0.5 text-[9px] text-zinc-400"
              >
                <Loader2 className="h-2 w-2 animate-spin text-blue-400" />
                {name}
              </span>
            ))}
          </div>
        )}

        {task.detail && (
          <p className="mt-0.5 text-[10px] text-zinc-500">{task.detail}</p>
        )}

        {task.progress !== undefined && task.progress < 100 && (
          <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-gradient-to-r from-blue-500 to-blue-400 transition-all duration-500 ease-out"
              style={{
                width: `${Math.min(100, Math.max(0, task.progress))}%`,
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function PendingTaskCard({
  task,
  allTasks,
  index,
}: {
  task: AgentTask;
  allTasks: AgentTask[];
  index: number;
}) {
  const waitingOn = useMemo(() => {
    if (!task.dependsOn || task.dependsOn.length === 0) return [];
    return task.dependsOn
      .map((id) => allTasks.find((t) => t.id === id))
      .filter(
        (t): t is AgentTask =>
          t !== undefined &&
          t.status !== "completed" &&
          t.status !== "failed" &&
          t.status !== "cancelled",
      );
  }, [task.dependsOn, allTasks]);

  return (
    <div
      className="flex items-start gap-2 rounded-md border-l-[3px] border-l-zinc-700 px-2.5 py-1.5 transition-all duration-300"
      style={{ animationDelay: `${index * 50}ms` }}
    >
      <div className="mt-px">
        <TaskStatusIcon status={task.status} />
      </div>
      <div className="min-w-0 flex-1">
        <span className="text-[11px] leading-tight text-zinc-500">
          {task.label}
        </span>
        {task.skillName && (
          <span className="ml-1.5">
            <SkillBadge name={task.skillName} muted />
          </span>
        )}
        {waitingOn.length > 0 && (
          <div className="mt-0.5 flex items-center gap-1 text-[9px] text-zinc-600">
            <GitBranch className="h-2.5 w-2.5 flex-shrink-0" />
            <span className="truncate">
              Blocked by: {waitingOn.map((t) => t.label).join(", ")}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function CompletedTaskCard({ task }: { task: AgentTask }) {
  const elapsed = useElapsedTime(task.startedAt ?? 0, task.completedAt);
  const isFailed = task.status === "failed" || task.status === "cancelled";

  return (
    <div
      className={`flex items-center gap-2 rounded-md border-l-[2px] px-2.5 py-1 transition-all duration-300 ${
        isFailed ? "border-l-red-500/50" : "border-l-emerald-500/40"
      }`}
    >
      <TaskStatusIcon status={task.status} />
      <span
        className={`min-w-0 flex-1 truncate text-[11px] ${
          isFailed ? "text-red-400/70" : "text-zinc-500"
        }`}
      >
        {task.label}
      </span>
      {elapsed && (
        <span className="flex-shrink-0 text-[9px] tabular-nums text-zinc-600">
          {elapsed}
        </span>
      )}
    </div>
  );
}

// --- Planning Skeleton ---

function PlanningSkeleton() {
  return (
    <div className="space-y-2 px-1">
      <div className="flex items-center gap-2 px-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" />
        <span className="text-[11px] text-zinc-400">
          Decomposing your request into tasks...
        </span>
      </div>
      <div className="space-y-1.5 px-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-2" style={{ animationDelay: `${i * 100}ms` }}>
            <div className="h-3 w-3 animate-pulse rounded-full bg-zinc-800" />
            <div
              className="h-3 animate-pulse rounded bg-zinc-800"
              style={{ width: `${60 + i * 10}%`, animationDelay: `${i * 150}ms` }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Section Headers ---

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pb-1 pt-2 text-[9px] font-semibold uppercase tracking-widest text-zinc-600">
      {children}
    </div>
  );
}

// --- Orchestrator Header ---

function OrchestratorHeader({
  progress,
  collapsed,
  onToggle,
}: {
  progress: AgentProgress;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const isFinished = progress.phase === "done" || progress.phase === "error";
  const totalCount = progress.tasks.length;
  const completedCount = progress.tasks.filter((t) => t.status === "completed").length;
  const failedCount = progress.tasks.filter((t) => t.status === "failed" || t.status === "cancelled").length;
  const activeCount = progress.tasks.filter((t) => t.status === "in_progress").length;
  const pendingCount = progress.tasks.filter((t) => t.status === "pending").length;
  const totalElapsed = useElapsedTime(progress.startedAt, progress.completedAt);

  const statParts: string[] = [];
  if (activeCount > 0) statParts.push(`${activeCount} running`);
  if (completedCount > 0) statParts.push(`${completedCount} done`);
  if (failedCount > 0) statParts.push(`${failedCount} failed`);
  if (pendingCount > 0) statParts.push(`${pendingCount} pending`);
  const statLine = statParts.join("  ·  ");

  const progressPercent =
    totalCount > 0 ? ((completedCount + failedCount) / totalCount) * 100 : 0;

  return (
    <button
      onClick={onToggle}
      className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-zinc-800/30"
      data-testid="collapse-toggle"
    >
      <div className="transition-transform duration-200">
        {collapsed ? (
          <ChevronRight className="h-3 w-3 text-zinc-500" />
        ) : (
          <ChevronDown className="h-3 w-3 text-zinc-500" />
        )}
      </div>

      <PhaseBadge status={progress.orchestratorStatus} />

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[10px] text-zinc-500">{statLine}</span>
        {!isFinished && totalCount > 0 && (
          <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-blue-500/60 transition-all duration-500"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        )}
      </div>

      {totalElapsed && (
        <span className="flex-shrink-0 text-[10px] tabular-nums text-zinc-600">
          {totalElapsed}
        </span>
      )}
    </button>
  );
}

// --- Main Component ---

export function TaskProgressView({
  progress,
  onSetCollapsed,
}: TaskProgressViewProps) {
  const collapsed = progress.collapsed;
  const isFinished = progress.phase === "done" || progress.phase === "error";
  const isOrchestrated = progress.isOrchestrated ?? false;
  const isPlanning = progress.orchestratorStatus === "planning";

  const [completedExpanded, setCompletedExpanded] = useState(false);

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

  const grouped = useMemo(
    () => groupTasksByStatus(progress.tasks),
    [progress.tasks],
  );

  const finishedTasks = useMemo(
    () => [...grouped.completed, ...grouped.failed],
    [grouped.completed, grouped.failed],
  );

  if (progress.phase === "idle") return null;

  // Non-orchestrated mode: use the old simple layout
  if (!isOrchestrated) {
    return (
      <SimpleTaskProgressView progress={progress} onSetCollapsed={onSetCollapsed} />
    );
  }

  const showBody = !collapsed;
  const shouldAutoCollapseCompleted =
    finishedTasks.length >= COMPLETED_COLLAPSE_THRESHOLD;

  return (
    <div
      className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/60 transition-all duration-300"
      data-testid="task-progress-view"
    >
      <OrchestratorHeader
        progress={progress}
        collapsed={collapsed}
        onToggle={() => onSetCollapsed(!collapsed)}
      />

      <div
        className={`transition-all duration-300 ease-in-out ${
          showBody ? "max-h-[500px] opacity-100" : "max-h-0 overflow-hidden opacity-0"
        }`}
      >
        <div
          className="space-y-0.5 overflow-y-auto border-t border-zinc-800/50 pb-2"
          style={{ maxHeight: "380px" }}
        >
          {/* Planning state — skeleton */}
          {isPlanning && progress.tasks.length === 0 && <PlanningSkeleton />}

          {/* Reasoning */}
          {progress.reasoning && !isFinished && (
            <div className="px-3 pt-2">
              <p className="text-[11px] italic leading-relaxed text-zinc-500">
                {progress.reasoning}
              </p>
            </div>
          )}

          {/* Active Tasks */}
          {grouped.active.length > 0 && (
            <div>
              <SectionLabel>
                Running ({grouped.active.length})
              </SectionLabel>
              <div className="space-y-1 px-1">
                {grouped.active.map((task, i) => (
                  <ActiveTaskCard key={task.id} task={task} index={i} />
                ))}
              </div>
            </div>
          )}

          {/* Pending Tasks */}
          {grouped.pending.length > 0 && (
            <div>
              <SectionLabel>
                Pending ({grouped.pending.length})
              </SectionLabel>
              <div className="space-y-0.5 px-1">
                {grouped.pending.map((task, i) => (
                  <PendingTaskCard
                    key={task.id}
                    task={task}
                    allTasks={progress.tasks}
                    index={i}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Completed / Failed Tasks */}
          {finishedTasks.length > 0 && (
            <div>
              {shouldAutoCollapseCompleted ? (
                <button
                  onClick={() => setCompletedExpanded((v) => !v)}
                  className="flex w-full items-center gap-1 px-2.5 pb-1 pt-2 text-left"
                >
                  <div className="transition-transform duration-200">
                    {completedExpanded ? (
                      <ChevronDown className="h-2.5 w-2.5 text-zinc-600" />
                    ) : (
                      <ChevronRight className="h-2.5 w-2.5 text-zinc-600" />
                    )}
                  </div>
                  <span className="text-[9px] font-semibold uppercase tracking-widest text-zinc-600">
                    Completed ({grouped.completed.length})
                    {grouped.failed.length > 0 && (
                      <span className="ml-1 text-red-500/70">
                        · {grouped.failed.length} failed
                      </span>
                    )}
                  </span>
                </button>
              ) : (
                <SectionLabel>
                  Completed ({grouped.completed.length})
                  {grouped.failed.length > 0 && (
                    <span className="ml-1 text-red-500/70">
                      · {grouped.failed.length} failed
                    </span>
                  )}
                </SectionLabel>
              )}

              <div
                className={`space-y-0.5 px-1 transition-all duration-300 ease-in-out ${
                  shouldAutoCollapseCompleted && !completedExpanded
                    ? "max-h-0 overflow-hidden opacity-0"
                    : "max-h-[300px] opacity-100"
                }`}
              >
                {finishedTasks.map((task) => (
                  <CompletedTaskCard key={task.id} task={task} />
                ))}
              </div>
            </div>
          )}

          {/* Thinking line */}
          {progress.thinkingLine && !isFinished && (
            <div className="flex items-center gap-2 px-3 py-1">
              <div className="flex gap-0.5">
                <span
                  className="inline-block h-1 w-1 animate-pulse rounded-full bg-blue-400/60"
                  style={{ animationDelay: "0ms" }}
                />
                <span
                  className="inline-block h-1 w-1 animate-pulse rounded-full bg-blue-400/60"
                  style={{ animationDelay: "150ms" }}
                />
                <span
                  className="inline-block h-1 w-1 animate-pulse rounded-full bg-blue-400/60"
                  style={{ animationDelay: "300ms" }}
                />
              </div>
              <span className="text-[10px] text-zinc-500">{progress.thinkingLine}</span>
            </div>
          )}
        </div>
      </div>

      {/* Error banner */}
      {progress.phase === "error" && progress.error && (
        <div className="border-t border-red-900/30 bg-red-900/10 px-3 py-2 text-[11px] text-red-400">
          {progress.error}
        </div>
      )}
    </div>
  );
}

// --- Simple (non-orchestrated) mode - preserved from original ---

function SimpleTaskProgressView({
  progress,
  onSetCollapsed,
}: TaskProgressViewProps) {
  const collapsed = progress.collapsed;
  const isFinished = progress.phase === "done" || progress.phase === "error";
  const completedCount = progress.tasks.filter((t) => t.status === "completed").length;
  const failedCount = progress.tasks.filter((t) => t.status === "failed").length;
  const cancelledCount = progress.tasks.filter((t) => t.status === "cancelled").length;
  const totalCount = progress.tasks.length;
  const totalElapsed = useElapsedTime(progress.startedAt, progress.completedAt);

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
    <div className="space-y-2 transition-all duration-300" data-testid="task-progress-view">
      {progress.reasoning && !isFinished && (
        <div className="px-2.5" data-testid="reasoning-block">
          <p className="text-[11px] italic leading-relaxed text-zinc-500">
            {progress.reasoning}
          </p>
        </div>
      )}

      {progress.thinkingLine && !isFinished && (
        <div className="flex items-center gap-2 px-2.5">
          <div className="flex gap-1">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400/60" style={{ animationDelay: "0ms" }} />
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400/60" style={{ animationDelay: "150ms" }} />
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400/60" style={{ animationDelay: "300ms" }} />
          </div>
          <span className="text-[11px] text-zinc-500">{progress.thinkingLine}</span>
        </div>
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
              <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                {summaryLabel}
              </span>
              {!isFinished && totalCount > 0 && (
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-blue-500/50 transition-all duration-500"
                    style={{ width: `${(completedCount / totalCount) * 100}%` }}
                  />
                </div>
              )}
            </div>
            {totalElapsed && (
              <span className="text-[10px] tabular-nums text-zinc-600">{totalElapsed}</span>
            )}
          </button>

          <div
            className={`transition-all duration-300 ease-in-out ${
              showTasks ? "max-h-[600px] opacity-100" : "max-h-0 overflow-hidden opacity-0"
            }`}
          >
            <div className="space-y-0.5 overflow-y-auto px-1.5 pb-2" style={{ maxHeight: "400px" }}>
              {progress.tasks.map((task) => (
                <SimpleTaskItem key={task.id} task={task} allTasks={progress.tasks} />
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

function SimpleTaskItem({ task, allTasks }: { task: AgentTask; allTasks: AgentTask[] }) {
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
              style={{ width: `${Math.min(100, Math.max(0, task.progress))}%` }}
            />
          </div>
        )}

        {task.subtasks && task.subtasks.length > 0 && (
          <div className="mt-1.5 space-y-0.5 border-l border-zinc-800 pl-2.5">
            {task.subtasks.map((sub) => (
              <SimpleTaskItem key={sub.id} task={sub} allTasks={allTasks} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
