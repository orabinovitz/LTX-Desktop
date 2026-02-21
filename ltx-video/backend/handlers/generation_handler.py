"""Generation lifecycle handler."""

from __future__ import annotations

from api_types import CancelResponse, GenerationProgressResponse
from handlers.base import StateHandlerBase, with_state_lock
from state.app_state_types import (
    GenerationCancelled,
    GenerationComplete,
    GenerationError,
    GenerationProgress,
    GenerationRunning,
    GenerationState,
    GpuSlot,
)


class GenerationHandler(StateHandlerBase):
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
    def _current_generation(self) -> GenerationState | None:
        match self.state.gpu_slot:
            case GpuSlot(generation=generation):
                return generation
            case _:
                return None

    @with_state_lock
    def is_generation_cancelled(self) -> bool:
        return isinstance(self._current_generation(), GenerationCancelled)

    @with_state_lock
    def update_progress(self, phase: str, progress: int, current_step: int = 0, total_steps: int = 0) -> None:
        match self.state.gpu_slot:
            case GpuSlot(generation=GenerationRunning() as running):
                running.progress.phase = phase
                running.progress.progress = progress
                running.progress.current_step = current_step
                running.progress.total_steps = total_steps
            case _:
                return

    @with_state_lock
    def cancel_generation(self) -> CancelResponse:
        match self.state.gpu_slot:
            case GpuSlot(generation=GenerationRunning(id=generation_id)):
                cancelled = GenerationCancelled(id=generation_id)
                self.state.gpu_slot.generation = cancelled
                return CancelResponse(status="cancelling", id=cancelled.id)
            case GpuSlot(generation=GenerationCancelled(id=generation_id)):
                return CancelResponse(status="cancelling", id=generation_id)
            case _:
                return CancelResponse(status="no_active_generation")

    @with_state_lock
    def complete_generation(self, result: str | list[str]) -> None:
        match self.state.gpu_slot:
            case GpuSlot(generation=GenerationCancelled(id=_)):
                return
            case GpuSlot(generation=GenerationRunning(id=generation_id)) as gpu_slot:
                gpu_slot.generation = GenerationComplete(id=generation_id, result=result)
            case _:
                return

    @with_state_lock
    def fail_generation(self, error: str) -> None:
        match self.state.gpu_slot:
            case GpuSlot(generation=GenerationCancelled(id=_)):
                return
            case GpuSlot(generation=GenerationRunning(id=generation_id)) as gpu_slot:
                gpu_slot.generation = GenerationError(id=generation_id, error=error)
            case _:
                return

    @with_state_lock
    def get_generation_progress(self) -> GenerationProgressResponse:
        gen = self._current_generation()

        match gen:
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
        match self.state.gpu_slot:
            case GpuSlot(generation=GenerationRunning()):
                return True
            case _:
                return False
