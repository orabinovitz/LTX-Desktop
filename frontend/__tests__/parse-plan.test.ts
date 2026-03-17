import { describe, it, expect, beforeEach } from "vitest";
import {
  parsePlanToTasks,
  mapGroupsToTasks,
  groupToolCalls,
  toolToLabel,
  resetTaskIdCounter,
} from "@/lib/parse-plan";

beforeEach(() => {
  resetTaskIdCounter();
});

describe("parsePlanToTasks", () => {
  it("parses bullet-point plan with dashes and extracts reasoning", () => {
    const plan = `Here's my plan:
- Generate 6 images based on your descriptions
- Create video animations from each image
- Build a new timeline and arrange all clips`;

    const { reasoning, tasks } = parsePlanToTasks(plan);
    expect(tasks).toHaveLength(3);
    expect(tasks[0].label).toBe("Generate 6 images based on your descriptions");
    expect(tasks[1].label).toBe("Create video animations from each image");
    expect(tasks[2].label).toBe("Build a new timeline and arrange all clips");
    expect(tasks.every((t) => t.status === "pending")).toBe(true);
    expect(reasoning).toBe("Here's my plan");
  });

  it("parses bullet-point plan with asterisks", () => {
    const plan = `* First step
* Second step`;
    const { tasks } = parsePlanToTasks(plan);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].label).toBe("First step");
  });

  it("parses bullet-point plan with plus signs", () => {
    const plan = `+ Step A
+ Step B`;
    const { tasks } = parsePlanToTasks(plan);
    expect(tasks).toHaveLength(2);
  });

  it("parses numbered list with dots", () => {
    const plan = `1. Generate images
2. Animate them
3. Add to timeline`;
    const { tasks } = parsePlanToTasks(plan);
    expect(tasks).toHaveLength(3);
    expect(tasks[0].label).toBe("Generate images");
    expect(tasks[2].label).toBe("Add to timeline");
  });

  it("parses numbered list with parentheses", () => {
    const plan = `1) First
2) Second`;
    const { tasks } = parsePlanToTasks(plan);
    expect(tasks).toHaveLength(2);
  });

  it("extracts reasoning from mixed content", () => {
    const plan = `I'll help you create this video. Here's my plan:

- Generate 6 images based on your descriptions
- Create video animations

This should take about 5 minutes.`;

    const { reasoning, tasks } = parsePlanToTasks(plan);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].label).toBe("Generate 6 images based on your descriptions");
    expect(reasoning).toContain("I'll help you create this video");
    expect(reasoning).toContain("This should take about 5 minutes.");
  });

  it("strips trailing colon from reasoning", () => {
    const plan = `Here's my plan:
- Step one`;
    const { reasoning } = parsePlanToTasks(plan);
    expect(reasoning).toBe("Here's my plan");
    expect(reasoning).not.toContain(":");
  });

  it("strips markdown bold and italic from labels", () => {
    const plan = `- **Generate** 6 images
- Create *animated* videos`;
    const { tasks } = parsePlanToTasks(plan);
    expect(tasks[0].label).toBe("Generate 6 images");
    expect(tasks[1].label).toBe("Create animated videos");
  });

  it("returns fallback task for empty input", () => {
    const { tasks, reasoning } = parsePlanToTasks("");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].label).toBe("Processing your request...");
    expect(reasoning).toBe("");
  });

  it("returns fallback task for null-ish input", () => {
    // @ts-expect-error testing edge case
    const { tasks } = parsePlanToTasks(null);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].label).toBe("Processing your request...");
  });

  it("returns fallback task with reasoning for plain text with no list structure", () => {
    const { tasks, reasoning } = parsePlanToTasks(
      "I will edit this video for you.",
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].label).toBe("Processing your request...");
    expect(reasoning).toBe("I will edit this video for you.");
  });

  it("handles unicode in plan text", () => {
    const plan = `- Générer des images 🎨
- Créer des vidéos 🎬`;
    const { tasks } = parsePlanToTasks(plan);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].label).toContain("Générer");
  });

  it("handles a long plan with 20+ items", () => {
    const lines = Array.from({ length: 25 }, (_, i) => `- Step ${i + 1}`);
    const plan = lines.join("\n");
    const { tasks } = parsePlanToTasks(plan);
    expect(tasks).toHaveLength(25);
    expect(tasks[24].label).toBe("Step 25");
  });

  it("assigns unique IDs to each task", () => {
    const plan = `- Step A\n- Step B\n- Step C`;
    const { tasks } = parsePlanToTasks(plan);
    const ids = tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("collects multi-line reasoning from before and after tasks", () => {
    const plan = `I analyzed your request carefully.
Here's what I'll do:
- Generate images
- Build timeline
Let me know if you want changes.`;

    const { reasoning, tasks } = parsePlanToTasks(plan);
    expect(tasks).toHaveLength(2);
    expect(reasoning).toContain("I analyzed your request carefully.");
    expect(reasoning).toContain("Let me know if you want changes.");
  });
});

describe("toolToLabel", () => {
  it("maps known tools to human-readable labels", () => {
    expect(toolToLabel("generate_image")).toBe("Generating image");
    expect(toolToLabel("generate_video")).toBe("Generating video");
    expect(toolToLabel("add_clip_to_track")).toBe("Adding clip to timeline");
  });

  it("converts unknown tool names by replacing underscores", () => {
    expect(toolToLabel("some_custom_tool")).toBe("some custom tool");
  });
});

describe("groupToolCalls", () => {
  it("groups identical tool calls together", () => {
    const groups = groupToolCalls([
      { tool_name: "generate_image" },
      { tool_name: "generate_image" },
      { tool_name: "generate_image" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].toolName).toBe("generate_image");
    expect(groups[0].indices).toEqual([0, 1, 2]);
    expect(groups[0].label).toBe("Generating 3 images");
  });

  it("keeps different tools as separate groups", () => {
    const groups = groupToolCalls([
      { tool_name: "generate_image" },
      { tool_name: "add_clip_to_track" },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].label).toBe("Generating image");
    expect(groups[1].label).toBe("Adding clip to timeline");
  });

  it("groups non-adjacent identical tools together", () => {
    const groups = groupToolCalls([
      { tool_name: "generate_image" },
      { tool_name: "add_clip_to_track" },
      { tool_name: "generate_image" },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].toolName).toBe("generate_image");
    expect(groups[0].indices).toEqual([0, 2]);
    expect(groups[0].label).toBe("Generating 2 images");
  });

  it("returns empty array for empty input", () => {
    expect(groupToolCalls([])).toEqual([]);
  });

  it("handles single tool call", () => {
    const groups = groupToolCalls([{ tool_name: "generate_video" }]);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Generating video");
    expect(groups[0].indices).toEqual([0]);
  });

  it("uses (xN) fallback for tools without plural map", () => {
    const groups = groupToolCalls([
      { tool_name: "some_custom_tool" },
      { tool_name: "some_custom_tool" },
    ]);
    expect(groups[0].label).toBe("some custom tool (x2)");
  });
});

describe("mapGroupsToTasks", () => {
  it("maps groups to matching plan tasks", () => {
    const { tasks } = parsePlanToTasks(`- Generate 6 images
- Add clips to timeline`);
    const groups = groupToolCalls([
      { tool_name: "generate_image" },
      { tool_name: "generate_image" },
      { tool_name: "add_clip_to_track" },
    ]);
    const mapping = mapGroupsToTasks(groups, tasks);
    expect(mapping.get(0)).toBe(tasks[0].id);
    expect(mapping.get(1)).toBe(tasks[1].id);
  });

  it("returns empty mapping when no tasks match", () => {
    const { tasks } = parsePlanToTasks(`- Something different`);
    const groups = groupToolCalls([{ tool_name: "generate_image" }]);
    const mapping = mapGroupsToTasks(groups, tasks);
    expect(mapping.size).toBe(0);
  });
});

