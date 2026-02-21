"""State action and invariant tests for AppState."""

from __future__ import annotations

import pytest

from state.app_settings import UpdateSettingsRequest
from state.app_state_types import CpuSlot, GpuSlot, StartupError, StartupLoading, StartupPending, StartupReady, VideoPipelineState, VideoPipelineWarmth


def test_start_generation_requires_gpu(test_state):
    with pytest.raises(RuntimeError, match="No active GPU pipeline"):
        test_state.generation.start_generation("gen-1")


def test_generation_mutex_prevents_second_start(test_state):
    test_state.pipelines.load_gpu_pipeline("fast")
    test_state.generation.start_generation("gen-1")

    with pytest.raises(RuntimeError, match="Generation already in progress"):
        test_state.generation.start_generation("gen-2")


def test_cancel_marks_running_generation(test_state):
    test_state.pipelines.load_gpu_pipeline("fast")
    test_state.generation.start_generation("gen-1")

    out = test_state.generation.cancel_generation()
    assert out.status == "cancelling"
    assert out.id == "gen-1"


def test_flux_slot_invariant_enforced(test_state, fake_services):
    flux = fake_services.image_generation_pipeline
    test_state.state.gpu_slot = GpuSlot(active_pipeline=flux, generation=None)
    test_state.state.cpu_slot = CpuSlot(active_pipeline=flux)

    with test_state._lock:  # noqa: SLF001 - explicit invariant check in tests
        with pytest.raises(RuntimeError, match="Invariant violation"):
            test_state.pipelines._assert_invariants()  # noqa: SLF001


def test_download_terminal_state_is_sticky_until_next_session(test_state):
    test_state.downloads.start_download({"checkpoint": ("checkpoint", 100)})
    test_state.downloads.complete_file("checkpoint")

    progress = test_state.downloads.get_download_progress()
    assert progress.status == "complete"


def test_generation_progress_resets_when_pipeline_unset(test_state):
    test_state.pipelines.load_gpu_pipeline("fast")
    test_state.generation.start_generation("gen-1")
    test_state.generation.complete_generation("/tmp/out.mp4")
    test_state.state.gpu_slot = None

    progress = test_state.generation.get_generation_progress()
    assert progress.status == "idle"


def test_startup_state_transitions_are_tracked(test_state):
    test_state.health.set_startup_pending("waiting")
    assert isinstance(test_state.state.startup, StartupPending)

    test_state.health.set_startup_loading("warming", 60)
    assert isinstance(test_state.state.startup, StartupLoading)

    test_state.health.set_startup_ready()
    assert isinstance(test_state.state.startup, StartupReady)

    test_state.health.set_startup_error("boom")
    assert isinstance(test_state.state.startup, StartupError)


def test_handler_attributes_are_wired(test_state):
    assert test_state.settings is not None
    assert test_state.models is not None
    assert test_state.downloads is not None
    assert test_state.text is not None
    assert test_state.pipelines is not None
    assert test_state.generation is not None
    assert test_state.video_generation is not None
    assert test_state.image_generation is not None
    assert test_state.health is not None
    assert test_state.prompt is not None
    assert test_state.retake is not None
    assert test_state.ic_lora is not None


def test_rlock_allows_nested_handler_calls(test_state):
    test_state.settings.update_settings(UpdateSettingsRequest(useTorchCompile=True))
    assert test_state.state.app_settings.use_torch_compile is True


def test_warmup_marks_pipeline_warm_and_leaves_no_temp_artifact(test_state):
    out = test_state.pipelines.load_gpu_pipeline("fast", should_warm=True)
    expected_path = test_state.config.outputs_dir / "_warmup_fast.mp4"

    assert out.warmth.value == "warm"
    assert not expected_path.exists()


def test_startup_warmup_keeps_fast_on_gpu_and_preloads_flux_on_cpu(test_state, fake_services, create_fake_model_files):
    create_fake_model_files(include_flux=True)
    test_state.state.app_settings.load_on_startup = True

    test_state.health.default_warmup()

    assert isinstance(test_state.state.gpu_slot, GpuSlot)
    active = test_state.state.gpu_slot.active_pipeline
    assert isinstance(active, VideoPipelineState)
    assert active.pipeline.pipeline_kind == "fast"
    assert active.warmth == VideoPipelineWarmth.WARM

    assert isinstance(test_state.state.cpu_slot, CpuSlot)
    assert test_state.state.cpu_slot.active_pipeline is fake_services.image_generation_pipeline
    assert fake_services.image_generation_pipeline.device is None
