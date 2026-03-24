"""Generation lifecycle handler."""

from __future__ import annotations

import logging
from threading import RLock
from typing import TYPE_CHECKING, Literal

from api_types import CancelResponse, GenerationProgressResponse
from handlers.base import StateHandlerBase, with_state_lock
from state.app_state_types import (
    APIGenerationBatch,
    APIGenerationRecord,
    AppState,
    GenerationCancelled,
    GenerationComplete,
    GenerationError,
    GenerationProgress,
    GenerationQueued,
    GenerationRunning,
    GenerationState,
    GpuSlot,
)

if TYPE_CHECKING:
    from runtime_config.runtime_config import RuntimeConfig

logger = logging.getLogger(__name__)
GenerationSlot = Literal["gpu", "api"]


class GenerationHandler(StateHandlerBase):
    def __init__(self, state: AppState, lock: RLock, config: RuntimeConfig) -> None:
        super().__init__(state, lock, config)

    @with_state_lock
    def start_generation(self, generation_id: str) -> None:
        if self.is_generation_running():
            raise RuntimeError("Generation already in progress")
        if self.state.gpu_slot is None:
            raise RuntimeError("No active GPU pipeline")

        self.state.gpu_slot.generation = GenerationRunning(
            id=generation_id,
            progress=GenerationProgress(phase="", progress=0, current_step=0, total_steps=0),
        )

    @with_state_lock
    def queue_api_generation(self, generation_id: str, *, batch_id: str | None = None) -> None:
        self.state.api_generations[generation_id] = APIGenerationRecord(
            id=generation_id,
            state=GenerationQueued(id=generation_id),
            batch_id=batch_id,
        )

    @with_state_lock
    def start_api_batch(self, batch_id: str, generation_ids: list[str]) -> None:
        self.state.api_batches[batch_id] = APIGenerationBatch(id=batch_id, generation_ids=list(generation_ids))

    @with_state_lock
    def start_api_generation(self, generation_id: str, *, batch_id: str | None = None) -> None:
        record = self.state.api_generations.get(generation_id)
        if record is None:
            self.state.api_generations[generation_id] = APIGenerationRecord(
                id=generation_id,
                state=GenerationRunning(
                    id=generation_id,
                    progress=GenerationProgress(phase="", progress=0, current_step=None, total_steps=None),
                ),
                batch_id=batch_id,
            )
            return

        record.batch_id = batch_id or record.batch_id
        record.state = GenerationRunning(
            id=generation_id,
            progress=GenerationProgress(phase="", progress=0, current_step=None, total_steps=None),
        )

    @with_state_lock
    def _gpu_generation(self) -> GenerationState | None:
        match self.state.gpu_slot:
            case GpuSlot(generation=generation):
                return generation
            case _:
                return None

    def _latest_api_record(self) -> APIGenerationRecord | None:
        if not self.state.api_generations:
            return None
        latest_generation_id = next(reversed(self.state.api_generations))
        return self.state.api_generations[latest_generation_id]

    def _api_record(self, generation_id: str | None = None) -> APIGenerationRecord | None:
        if generation_id is not None:
            return self.state.api_generations.get(generation_id)
        return self._latest_api_record()

    @with_state_lock
    def get_api_generation_state(self, generation_id: str) -> GenerationState | None:
        record = self.state.api_generations.get(generation_id)
        return None if record is None else record.state

    @with_state_lock
    def get_api_generation_batch_id(self, generation_id: str) -> str | None:
        record = self.state.api_generations.get(generation_id)
        return None if record is None else record.batch_id

    @with_state_lock
    def get_api_batch_generation_ids(self, batch_id: str) -> list[str] | None:
        batch = self.state.api_batches.get(batch_id)
        if batch is None:
            return None
        return list(batch.generation_ids)

    def _has_active_api_generation(self) -> bool:
        return any(
            isinstance(record.state, (GenerationQueued, GenerationRunning))
            for record in self.state.api_generations.values()
        )

    @with_state_lock
    def _running_slot(self) -> GenerationSlot | None:
        if isinstance(self._gpu_generation(), GenerationRunning):
            return "gpu"
        if any(isinstance(record.state, GenerationRunning) for record in self.state.api_generations.values()):
            return "api"
        return None

    @with_state_lock
    def _generation_for_polling(self, generation_id: str | None = None) -> GenerationState | None:
        if generation_id is not None:
            record = self.state.api_generations.get(generation_id)
            return None if record is None else record.state

        gpu_gen = self._gpu_generation()
        if gpu_gen is not None:
            return gpu_gen

        record = self._latest_api_record()
        return None if record is None else record.state

    @with_state_lock
    def is_generation_cancelled(self, generation_id: str | None = None) -> bool:
        if generation_id is not None:
            record = self.state.api_generations.get(generation_id)
            return bool(record and isinstance(record.state, GenerationCancelled))

        match self.state.gpu_slot:
            case GpuSlot(generation=GenerationCancelled()):
                return True
            case GpuSlot(generation=GenerationRunning()):
                return False
            case _:
                record = self._latest_api_record()
                return bool(record and isinstance(record.state, GenerationCancelled))

    @with_state_lock
    def update_progress(
        self,
        phase: str,
        progress: int,
        current_step: int | None = None,
        total_steps: int | None = None,
        *,
        generation_id: str | None = None,
    ) -> None:
        if generation_id is not None:
            record = self.state.api_generations.get(generation_id)
            if record is None:
                return
            match record.state:
                case GenerationRunning() as running:
                    running.progress.phase = phase
                    running.progress.progress = progress
                    running.progress.current_step = current_step
                    running.progress.total_steps = total_steps
                case _:
                    return
            return

        match self._running_slot():
            case "gpu":
                match self.state.gpu_slot:
                    case GpuSlot(generation=GenerationRunning() as running):
                        running.progress.phase = phase
                        running.progress.progress = progress
                        running.progress.current_step = current_step
                        running.progress.total_steps = total_steps
                    case _:
                        return
            case "api":
                record = self._latest_api_record()
                if record is None:
                    return
                match record.state:
                    case GenerationRunning() as running:
                        running.progress.phase = phase
                        running.progress.progress = progress
                        running.progress.current_step = current_step
                        running.progress.total_steps = total_steps
                    case _:
                        return
            case _:
                return

    @with_state_lock
    def cancel_generation(self, generation_id: str | None = None, batch_id: str | None = None) -> CancelResponse:
        if generation_id is not None:
            record = self.state.api_generations.get(generation_id)
            if record is None:
                return CancelResponse(status="no_active_generation")
            match record.state:
                case GenerationQueued() | GenerationRunning():
                    record.state = GenerationCancelled(id=generation_id)
                    return CancelResponse(status="cancelling", id=generation_id)
                case GenerationCancelled():
                    return CancelResponse(status="cancelling", id=generation_id)
                case _:
                    return CancelResponse(status="no_active_generation")

        if batch_id is not None:
            batch = self.state.api_batches.get(batch_id)
            if batch is None:
                return CancelResponse(status="no_active_generation")
            cancelled_any = False
            for job_id in batch.generation_ids:
                record = self.state.api_generations.get(job_id)
                if record is None:
                    continue
                if isinstance(record.state, (GenerationQueued, GenerationRunning)):
                    record.state = GenerationCancelled(id=job_id)
                    cancelled_any = True
            if cancelled_any or any(
                isinstance(self.state.api_generations.get(job_id, None), APIGenerationRecord)
                and isinstance(self.state.api_generations[job_id].state, GenerationCancelled)
                for job_id in batch.generation_ids
            ):
                return CancelResponse(status="cancelling", id=batch_id)
            return CancelResponse(status="no_active_generation")

        match self._running_slot():
            case "gpu":
                match self.state.gpu_slot:
                    case GpuSlot(generation=GenerationRunning(id=generation_id)):
                        cancelled = GenerationCancelled(id=generation_id)
                        self.state.gpu_slot.generation = cancelled
                        return CancelResponse(status="cancelling", id=cancelled.id)
                    case _:
                        pass
            case _:
                pass

        cancelled_any = False
        last_cancelled_id: str | None = None
        for record in self.state.api_generations.values():
            if isinstance(record.state, (GenerationQueued, GenerationRunning)):
                record.state = GenerationCancelled(id=record.id)
                cancelled_any = True
                last_cancelled_id = record.id
        if cancelled_any:
            return CancelResponse(status="cancelling", id=last_cancelled_id)

        match self.state.gpu_slot:
            case GpuSlot(generation=GenerationCancelled(id=generation_id)):
                return CancelResponse(status="cancelling", id=generation_id)
            case _:
                pass

        for record in self.state.api_generations.values():
            if isinstance(record.state, GenerationCancelled):
                return CancelResponse(status="cancelling", id=record.id)

        return CancelResponse(status="no_active_generation")

    @with_state_lock
    def complete_generation(self, result: str | list[str], *, generation_id: str | None = None) -> None:
        if generation_id is not None:
            record = self.state.api_generations.get(generation_id)
            if record is None:
                return
            match record.state:
                case GenerationRunning():
                    record.state = GenerationComplete(id=generation_id, result=result)
                case _:
                    return
            return

        match self._running_slot():
            case "gpu":
                match self.state.gpu_slot:
                    case GpuSlot(generation=GenerationRunning(id=generation_id)) as gpu_slot:
                        gpu_slot.generation = GenerationComplete(id=generation_id, result=result)
                    case _:
                        return
            case "api":
                record = self._latest_api_record()
                if record is None:
                    return
                match record.state:
                    case GenerationRunning(id=generation_id):
                        record.state = GenerationComplete(id=generation_id, result=result)
                    case _:
                        return
            case _:
                return

    @with_state_lock
    def fail_generation(self, error: str, *, generation_id: str | None = None, status_code: int = 500) -> None:
        if generation_id is not None:
            record = self.state.api_generations.get(generation_id)
            if record is None:
                logger.error("Generation %s failed without a known API record: %s", generation_id, error)
                return
            if isinstance(record.state, GenerationCancelled):
                return
            match record.state:
                case GenerationRunning() | GenerationQueued():
                    logger.error("Generation %s failed: %s", generation_id, error)
                    record.state = GenerationError(id=generation_id, error=error, status_code=status_code)
                case _:
                    logger.error("Generation %s failed without active running job: %s", generation_id, error)
            return

        match self._running_slot():
            case "gpu":
                match self.state.gpu_slot:
                    case GpuSlot(generation=GenerationRunning(id=generation_id)) as gpu_slot:
                        logger.error("Generation %s failed: %s", generation_id, error)
                        gpu_slot.generation = GenerationError(id=generation_id, error=error, status_code=status_code)
                    case _:
                        logger.error("Generation failed without active running job: %s", error)
                return
            case "api":
                record = self._latest_api_record()
                if record is None:
                    logger.error("Generation failed without active running job: %s", error)
                    return
                if isinstance(record.state, GenerationCancelled):
                    return
                match record.state:
                    case GenerationRunning(id=generation_id) | GenerationQueued(id=generation_id):
                        logger.error("Generation %s failed: %s", generation_id, error)
                        record.state = GenerationError(id=generation_id, error=error, status_code=status_code)
                    case _:
                        logger.error("Generation failed without active running job: %s", error)
                return
            case _:
                if isinstance(self._gpu_generation(), GenerationCancelled):
                    return
                if any(isinstance(record.state, GenerationCancelled) for record in self.state.api_generations.values()):
                    return
                logger.error("Generation failed without active running job: %s", error)
                return

    @with_state_lock
    def get_generation_progress(self, generation_id: str | None = None) -> GenerationProgressResponse:
        gen = self._generation_for_polling(generation_id)

        match gen:
            case GenerationQueued(progress=progress):
                return GenerationProgressResponse(
                    status="queued",
                    phase=progress.phase,
                    progress=int(progress.progress),
                    currentStep=progress.current_step,
                    totalSteps=progress.total_steps,
                )
            case GenerationRunning(progress=progress):
                return GenerationProgressResponse(
                    status="running",
                    phase=progress.phase,
                    progress=int(progress.progress),
                    currentStep=progress.current_step,
                    totalSteps=progress.total_steps,
                )
            case GenerationComplete():
                return GenerationProgressResponse(
                    status="complete",
                    phase="complete",
                    progress=100,
                    currentStep=0,
                    totalSteps=0,
                )
            case GenerationCancelled():
                return GenerationProgressResponse(
                    status="cancelled",
                    phase="cancelled",
                    progress=0,
                    currentStep=0,
                    totalSteps=0,
                )
            case GenerationError():
                return GenerationProgressResponse(
                    status="error",
                    phase="error",
                    progress=0,
                    currentStep=0,
                    totalSteps=0,
                )
            case _:
                return GenerationProgressResponse(
                    status="idle",
                    phase="",
                    progress=0,
                    currentStep=0,
                    totalSteps=0,
                )

    @with_state_lock
    def is_generation_running(self) -> bool:
        return self._running_slot() is not None or self._has_active_api_generation()
