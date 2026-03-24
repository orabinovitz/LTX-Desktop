# Agentic Ad Live Iteration Summary

## Scope
This round used the live authenticated local backend and real Gemini planner / creative calls. It did **not** complete a full rendered end-to-end ad export after the overhaul, but it did validate the two highest-risk stages that were previously failing hardest:

- planner / task graph shape
- script / coverage density before generation

## Before

### Pepsi baseline
- Planner shape: `5` tasks
- No dedicated review gate before the timeline pass
- Live screenwriter output: `4` shots totaling `30s`
- Known bad run behavior: `4` generated clips laid down linearly with no meaningful edit

Result: under-covered and not actually edited.

## After

### Pepsi live rerun
- Planner shape: `7` tasks
- Added dedicated review task before timeline assembly
- Added dedicated final timeline review after the edit pass
- Live screenwriter output moved from the previous `4`-shot hero-shot structure to a denser raw coverage design
- In the full orchestration proxy, the generation stage expanded to **6 per-shot generation tasks** instead of the old `4`-shot batch

Observed improvement:
- The script now explicitly talks about **raw coverage** and **ample handles** for editing
- The concept avoids cheesy character-spoken tagline behavior
- The workflow now expects a real review gate before the edit and another after timeline assembly

### Performance-ad live rerun
- Planner shape: `5` tasks
- Task flow: script -> visual style -> generation -> marketing review -> marketing edit
- Live screenwriter output saved a script described as **including 10 shots for high-coverage fast-paced editing**

Observed improvement:
- The performance profile is no longer inheriting the slow cinematic sports-ad shape
- The script is being written for hook / proof / CTA density rather than a handful of long hero shots

### UGC-native live rerun
- Planner shape: `6` tasks
- Task flow includes creator style, character consistency setup, marketing review, and marketing edit

Observed improvement:
- The system is no longer forcing every ad into the same cinematic branch
- UGC now gets a distinct workflow with creator consistency and native-format review

### Montage promo live rerun
- Planner shape: `6` tasks
- Task flow includes visual identity, cinematography, marketing review, and marketing edit

Observed improvement:
- Montage / promo work is now routed as a rhythm-first commercial flow instead of a generic full-production template

## What materially improved
- The planner stopped collapsing every short ad into one generic five-task flow.
- The Pepsi flow now has a **review gate** before timeline assembly and a **final timeline review** after the edit pass.
- The Pepsi generation proxy expanded to **6** shot tasks instead of **4**.
- The performance-ad script density increased sharply, with the live run explicitly calling for **10** shots.
- The producer / editor / reviewer prompts now encode the principle that **assembly is not editing**.

## Remaining risks
- A full post-overhaul rendered timeline has **not** been revalidated end-to-end yet. That means the creative upstream is substantially better, but final-output quality still depends on the real timeline pass and frontend tool execution.
- Export parity is still limited for some richer timeline features.
- The review loop is now structured, but it still needs more live footage-backed validation on actual generated assets.

## Verdict
This is a **major improvement**, not a cosmetic one.

The old workflow clearly under-covered the edit and mistook linear placement for editing. The new workflow:

- plans more appropriately by profile
- writes denser raw coverage
- inserts a review gate before assembly
- expands Pepsi generation coverage from `4` to `6` live shot tasks
- writes performance creative with `10` shots instead of a sparse hero-shot structure

The system is now much closer to a usable commercial pipeline, though full end-to-end rendered proof is still the next thing to validate.
