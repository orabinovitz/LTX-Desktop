import type { AgentTask } from "@/types/agent-progress";

let nextId = 0;
function makeTaskId(): string {
  return `task-${++nextId}`;
}

export function resetTaskIdCounter(): void {
  nextId = 0;
}

// ---------------------------------------------------------------------------
// Plan parsing
// ---------------------------------------------------------------------------

export interface ParsedPlan {
  reasoning: string;
  tasks: AgentTask[];
}

/**
 * Parse agent plan text into structured tasks and extract reasoning preamble.
 *
 * Recognizes bullet lists (-, *, +) and numbered lists (1., 2.).
 * Non-list lines are collected as reasoning text.
 * Falls back to a single generic task when no list structure is found.
 */
export function parsePlanToTasks(planText: string): ParsedPlan {
  if (!planText || !planText.trim()) {
    return { reasoning: "", tasks: [fallbackTask()] };
  }

  const lines = planText.split("\n");
  const tasks: AgentTask[] = [];
  const reasoningLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const bulletMatch = trimmed.match(/^[*\-+]\s+(.+)/);
    if (bulletMatch) {
      tasks.push({
        id: makeTaskId(),
        label: cleanLabel(bulletMatch[1]),
        status: "pending",
      });
      continue;
    }

    const numberedMatch = trimmed.match(/^\d+[.)]\s+(.+)/);
    if (numberedMatch) {
      tasks.push({
        id: makeTaskId(),
        label: cleanLabel(numberedMatch[1]),
        status: "pending",
      });
      continue;
    }

    reasoningLines.push(trimmed);
  }

  const reasoning = cleanReasoning(reasoningLines.join(" "));

  if (tasks.length === 0) {
    return { reasoning, tasks: [fallbackTask()] };
  }

  return { reasoning, tasks };
}

function cleanLabel(raw: string): string {
  return raw
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .trim();
}

function cleanReasoning(text: string): string {
  return text.replace(/:\s*$/, "").trim();
}

function fallbackTask(): AgentTask {
  return {
    id: makeTaskId(),
    label: "Processing your request...",
    status: "pending",
  };
}

// ---------------------------------------------------------------------------
// Tool labels
// ---------------------------------------------------------------------------

const TOOL_LABEL_MAP: Record<string, string> = {
  generate_image: "Generating image",
  generate_video: "Generating video",
  add_clip_to_track: "Adding clip to timeline",
  set_clip_position: "Positioning clip",
  trim_clip: "Trimming clip",
  split_clip: "Splitting clip",
  remove_clip: "Removing clip",
  set_clip_speed: "Adjusting clip speed",
  duplicate_timeline: "Duplicating timeline",
  create_new_timeline: "Creating new timeline",
  rename_timeline: "Renaming timeline",
  get_project_assets: "Loading project assets",
  get_generation_status: "Checking generation status",
  cancel_generation: "Cancelling generation",
  get_video_metadata: "Loading video metadata",
  delete_asset: "Deleting asset",
  toggle_favorite: "Toggling favorite",
  retake_section: "Retaking section",
  add_transition: "Adding transition",
  set_clip_volume: "Adjusting volume",
  mute_clip: "Muting clip",
  close_gap: "Closing gap",
  close_all_gaps: "Closing all gaps",
};

const TOOL_PLURAL_MAP: Record<string, string> = {
  generate_image: "Generating {n} images",
  generate_video: "Generating {n} videos",
  add_clip_to_track: "Adding {n} clips to timeline",
  trim_clip: "Trimming {n} clips",
  split_clip: "Splitting {n} clips",
  delete_asset: "Deleting {n} assets",
};

export function toolToLabel(toolName: string): string {
  return TOOL_LABEL_MAP[toolName] ?? toolName.replace(/_/g, " ");
}

function toolToGroupLabel(toolName: string, count: number): string {
  if (count === 1) return toolToLabel(toolName);
  const template = TOOL_PLURAL_MAP[toolName];
  if (template) return template.replace("{n}", String(count));
  return `${toolToLabel(toolName)} (x${count})`;
}

// ---------------------------------------------------------------------------
// Tool call grouping
// ---------------------------------------------------------------------------

export interface ToolCallLike {
  tool_name: string;
}

export interface ToolGroup {
  toolName: string;
  indices: number[];
  label: string;
}

/**
 * Group tool calls by name. All calls with the same tool_name are combined
 * into a single group regardless of position.
 */
export function groupToolCalls(toolCalls: ToolCallLike[]): ToolGroup[] {
  const groupMap = new Map<string, number[]>();
  const order: string[] = [];

  for (let i = 0; i < toolCalls.length; i++) {
    const name = toolCalls[i].tool_name;
    const existing = groupMap.get(name);
    if (existing) {
      existing.push(i);
    } else {
      groupMap.set(name, [i]);
      order.push(name);
    }
  }

  return order.map((name) => {
    const indices = groupMap.get(name)!;
    return {
      toolName: name,
      indices,
      label: toolToGroupLabel(name, indices.length),
    };
  });
}

// ---------------------------------------------------------------------------
// Tool-to-task mapping
// ---------------------------------------------------------------------------

/**
 * Map tool groups to existing parsed tasks.
 *
 * Returns a mapping of group index -> taskId.
 * Groups are matched to tasks by keyword overlap. Unlike the old per-call
 * mapping, all calls within a group share one task.
 */
export function mapGroupsToTasks(
  groups: ToolGroup[],
  existingTasks: AgentTask[],
): Map<number, string> {
  const mapping = new Map<number, string>();
  const usedTaskIds = new Set<string>();

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    const matchedTask = findMatchingTask(
      group.toolName,
      existingTasks,
      usedTaskIds,
    );
    if (matchedTask) {
      mapping.set(gi, matchedTask.id);
      usedTaskIds.add(matchedTask.id);
    }
  }

  return mapping;
}

/** @deprecated Use groupToolCalls + mapGroupsToTasks instead */
export function mapToolsToTasks(
  toolCalls: ToolCallLike[],
  existingTasks: AgentTask[],
): Map<number, string> {
  const mapping = new Map<number, string>();
  const usedTaskIds = new Set<string>();

  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    const matchedTask = findMatchingTask(
      tc.tool_name,
      existingTasks,
      usedTaskIds,
    );
    if (matchedTask) {
      mapping.set(i, matchedTask.id);
      usedTaskIds.add(matchedTask.id);
    }
  }

  return mapping;
}

function findMatchingTask(
  toolName: string,
  tasks: AgentTask[],
  usedIds: Set<string>,
): AgentTask | null {
  const keywords = getToolKeywords(toolName);
  for (const task of tasks) {
    if (usedIds.has(task.id)) continue;
    const lower = task.label.toLowerCase();
    if (keywords.some((kw) => lower.includes(kw))) {
      return task;
    }
  }
  return null;
}

function getToolKeywords(toolName: string): string[] {
  switch (toolName) {
    case "generate_image":
      return ["generate", "image", "creating image"];
    case "generate_video":
      return ["generate", "video", "animate", "creating video"];
    case "add_clip_to_track":
    case "set_clip_position":
    case "close_gap":
    case "close_all_gaps":
      return ["timeline", "arrange", "add", "position", "clip", "gap"];
    case "trim_clip":
    case "split_clip":
    case "set_clip_speed":
      return ["trim", "split", "speed", "edit"];
    case "duplicate_timeline":
    case "create_new_timeline":
    case "rename_timeline":
      return ["timeline", "duplicate", "create", "new"];
    default:
      return toolName.split("_");
  }
}
