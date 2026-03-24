# LTX API Batch Generation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add safe app-wide LTX API video generation concurrency with batch submission, per-job tracking, and agent support for up to 10 parallel videos using the LTX 2.3 models.

**Architecture:** Replace the single-slot API generation state with a per-job registry plus optional batches, keep local GPU generation on its existing single-job path, and move API generation onto asynchronous jobs with bounded concurrency. Preserve the legacy blocking `/api/generate` behavior as a compatibility wrapper while migrating the agent and regular UI to explicit async job APIs.

**Tech Stack:** FastAPI, Python handlers/state dataclasses, thread-based background runner, React + TypeScript frontend hooks, existing agent orchestration layer, pytest integration tests.

---

### Task 1: Add failing backend tests for multi-job API generation

**Files:**
- Modify: `backend/tests/fakes/services.py`
- Modify: `backend/tests/test_generation.py`

**Step 1: Write the failing test**

- Add tests that submit API-generation jobs and assert:
  - two forced-API jobs can coexist without overwriting each other
  - a batch submit of multiple requests returns stable job IDs
  - per-job status/progress is queryable independently
  - cancel can target a specific job or batch
  - blocking `/api/generate` still returns a completed video path

**Step 2: Run test to verify it fails**

Run: `pnpm backend:test -- tests/test_generation.py`

Expected: FAIL because the backend only supports a single `api_generation` slot and has no batch/job endpoints.

**Step 3: Write minimal implementation**

- Extend fake task runner so tests can defer background execution.
- Add fake service controls for deterministic async completion.

**Step 4: Run test to verify it passes**

Run: `pnpm backend:test -- tests/test_generation.py`

Expected: PASS for the new cases.

### Task 2: Introduce API generation job and batch state

**Files:**
- Modify: `backend/state/app_state_types.py`
- Modify: `backend/api_types.py`
- Modify: `backend/app_handler.py`
- Modify: `backend/handlers/generation_handler.py`

**Step 1: Write the failing test**

- Add tests that assert `AppState` can represent:
  - multiple API generation jobs
  - batch membership
  - job terminal states and results

**Step 2: Run test to verify it fails**

Run: `pnpm backend:test -- tests/test_generation.py`

Expected: FAIL because the state model only has `api_generation: GenerationState | None`.

**Step 3: Write minimal implementation**

- Replace singleton API state with:
  - `api_generations: dict[str, ApiGenerationRecord]`
  - `api_batches: dict[str, ApiGenerationBatch]`
- Add typed responses for:
  - single async submit
  - batch submit
  - job status
  - batch status

**Step 4: Run test to verify it passes**

Run: `pnpm backend:test -- tests/test_generation.py`

Expected: PASS for state and response-shape assertions.

### Task 3: Implement async LTX API job execution with a global concurrency cap of 10

**Files:**
- Modify: `backend/handlers/video_generation_handler.py`
- Modify: `backend/handlers/generation_handler.py`
- Modify: `backend/app_handler.py`

**Step 1: Write the failing test**

- Add tests that assert:
  - async submit creates queued/running jobs
  - forced API generation uses `ltx-2-3-fast` / `ltx-2-3-pro`
  - per-job progress updates do not overwrite sibling jobs
  - batch size > 10 is rejected

**Step 2: Run test to verify it fails**

Run: `pnpm backend:test -- tests/test_generation.py`

Expected: FAIL because no async submit path exists and progress is global.

**Step 3: Write minimal implementation**

- Extract forced API execution into job-based worker logic.
- Use a bounded semaphore for max 10 concurrent API jobs.
- Keep local GPU generation on the existing single-slot path.
- Preserve old blocking `/api/generate` by internally creating a job and waiting for completion.

**Step 4: Run test to verify it passes**

Run: `pnpm backend:test -- tests/test_generation.py`

Expected: PASS.

### Task 4: Add backend routes for async jobs and batches

**Files:**
- Modify: `backend/_routes/generation.py`
- Modify: `backend/api_types.py`
- Modify: `backend/tests/test_generation.py`

**Step 1: Write the failing test**

- Add integration tests for:
  - `POST /api/generations`
  - `GET /api/generations/{generation_id}`
  - `POST /api/generations/{generation_id}/cancel`
  - `POST /api/generations/batches`
  - `GET /api/generations/batches/{batch_id}`
  - `POST /api/generations/batches/{batch_id}/cancel`
  - compatibility behavior for `/api/generation/progress` and `/api/generate/cancel`

**Step 2: Run test to verify it fails**

Run: `pnpm backend:test -- tests/test_generation.py`

Expected: FAIL because those routes do not exist.

**Step 3: Write minimal implementation**

- Add the new routes.
- Keep legacy routes working, ideally with optional job or batch targeting.

**Step 4: Run test to verify it passes**

Run: `pnpm backend:test -- tests/test_generation.py`

Expected: PASS.

### Task 5: Update the regular UI to use async job APIs

**Files:**
- Modify: `frontend/hooks/use-generation.ts`
- Modify: `frontend/views/editor/utils/agent-generation-helper.ts`
- Modify: `frontend/views/editor/hooks/use-agent-executor.ts`
- Modify: `frontend/types/agent-progress.ts`

**Step 1: Write the failing test**

- If frontend test coverage is impractical, add type-safe API helpers first and rely on TypeScript plus manual verification.
- Verify the regular UI can:
  - submit a job
  - poll that job by `generation_id`
  - cancel that job

**Step 2: Run verification to show the gap**

Run: `pnpm typecheck:ts`

Expected: Existing code still assumes global progress/cancel semantics.

**Step 3: Write minimal implementation**

- Convert `useGeneration` to async job submission + per-job polling.
- Keep the user-facing single-generation UX unchanged.

**Step 4: Run verification**

Run: `pnpm typecheck:ts`

Expected: PASS.

### Task 6: Update the agent orchestration path to submit video batches safely

**Files:**
- Modify: `frontend/hooks/use-orchestrated-agent.ts`
- Modify: `frontend/views/editor/hooks/use-agent-executor.ts`
- Modify: `frontend/views/editor/utils/agent-generation-helper.ts`
- Modify: `backend/agent/skills/ai-video-producer/SKILL.md`

**Step 1: Write the failing test**

- Add backend assertions and frontend-safe contracts so that grouped `generate_video` tool calls can be submitted as one backend batch up to 10 jobs.

**Step 2: Run verification to show the gap**

Run: `pnpm typecheck:ts && pnpm backend:test -- tests/test_generation.py`

Expected: Current agent execution is parallel at the frontend scheduler only, not true batch-backed.

**Step 3: Write minimal implementation**

- When the orchestrated agent groups multiple `generate_video` calls, submit them through the backend batch API.
- Track per-call results against returned job IDs.
- Make stop/cancel cancel the active batch instead of only a single global generation.

**Step 4: Run verification**

Run: `pnpm typecheck:ts && pnpm backend:test -- tests/test_generation.py`

Expected: PASS.

### Task 7: Final verification and cleanup

**Files:**
- Modify as needed based on verification failures.

**Step 1: Run focused backend tests**

Run: `pnpm backend:test -- tests/test_generation.py tests/test_api_calls.py`

Expected: PASS.

**Step 2: Run static verification**

Run: `pnpm typecheck`

Expected: PASS.

**Step 3: Run lints/diagnostics**

- Read IDE diagnostics for changed files and fix any new issues.

**Step 4: Optional broader verification**

Run: `pnpm build:frontend`

Expected: PASS if time allows and no unrelated build issues block.
