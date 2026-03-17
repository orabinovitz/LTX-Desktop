"""Route handlers for /api/agent/* endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from agent import project_memory
from agent.types import (
    AddMemoryEntryRequest,
    AgentContinueRequest,
    AgentExecuteRequest,
    AgentExecuteResponse,
    AnalyzeVideoRequest,
    AnalyzeVideoResponse,
    ClarifyRequest,
    ClarifyResponse,
    DecomposeVideoResponse,
    DocumentMeta,
    IntentResolveRequest,
    IntentResolveResponse,
    LiveConfigResponse,
    LiveTokenResponse,
    MemoryManifest,
    MemoryDocument,
    OrchestrateContinueRequest,
    OrchestrateRequest,
    OrchestrateResponse,
    SaveDocumentRequest,
    SkipTaskRequest,
    SubClipInfo,
    UpdateContextRequest,
    UpdateDocumentRequest,
)
from api_types import SuggestAssetMetaRequest, SuggestAssetMetaResponse
from app_handler import AppHandler
from state import get_state_service

router = APIRouter(prefix="/api", tags=["agent"])


@router.post("/agent/execute", response_model=AgentExecuteResponse)
def route_agent_execute(
    req: AgentExecuteRequest,
    handler: AppHandler = Depends(get_state_service),
) -> AgentExecuteResponse:
    return handler.agent.execute(req)


@router.post("/agent/continue", response_model=AgentExecuteResponse)
def route_agent_continue(
    req: AgentContinueRequest,
    handler: AppHandler = Depends(get_state_service),
) -> AgentExecuteResponse:
    return handler.agent.continue_session(req)


@router.post("/agent/analyze-video", response_model=AnalyzeVideoResponse)
def route_analyze_video(
    req: AnalyzeVideoRequest,
    handler: AppHandler = Depends(get_state_service),
) -> AnalyzeVideoResponse:
    return handler.agent.analyze_video(req)


@router.get("/agent/video-metadata/{asset_id}")
def route_get_video_metadata(
    asset_id: str,
    handler: AppHandler = Depends(get_state_service),
) -> dict[str, object]:
    metadata = handler.agent.get_video_metadata(asset_id)
    if metadata is None:
        return {"status": "not_found"}
    result: dict[str, object] = metadata.model_dump(mode="json")
    return result


@router.get("/agent/brain/{project_id}")
def route_get_brain(
    project_id: str,
    handler: AppHandler = Depends(get_state_service),
) -> dict[str, object]:
    """Get the project brain data and formatted summary for display."""
    b = handler.agent.get_brain(project_id)
    if b is None:
        return {
            "status": "not_found",
            "suppressed": handler.agent.is_brain_suppressed(project_id),
        }
    result: dict[str, object] = b.model_dump(mode="json")
    result["formatted_summary"] = handler.agent.get_brain_summary(project_id)
    result["suppressed"] = handler.agent.is_brain_suppressed(project_id)
    return result


@router.delete("/agent/brain/{project_id}")
def route_clear_brain(
    project_id: str,
    handler: AppHandler = Depends(get_state_service),
) -> dict[str, str]:
    """Clear the brain for a project and suppress auto-rebuild."""
    handler.agent.clear_brain(project_id)
    return {"status": "cleared"}


@router.post("/agent/brain/{project_id}/build")
def route_build_brain(
    project_id: str,
    project_save_path: str | None = None,
    handler: AppHandler = Depends(get_state_service),
) -> dict[str, str]:
    """Trigger a brain build from all analyzed video metadata."""
    status = handler.agent.build_brain(project_id, project_save_path)
    messages = {
        "building": "Brain build started in background.",
        "no_metadata": "No completed video analyses found.",
        "error": "No Gemini API key configured.",
    }
    return {"status": status, "message": messages.get(status, "")}


@router.post("/agent/brain/{project_id}/notify-decomposition")
def route_notify_decomposition(
    project_id: str,
    handler: AppHandler = Depends(get_state_service),
) -> dict[str, str]:
    """Notify the brain that scenes have been decomposed (marks dirty)."""
    handler.agent.mark_brain_dirty(project_id)
    return {"status": "ok"}


@router.post("/agent/decompose-video/{asset_id}", response_model=DecomposeVideoResponse)
def route_decompose_video(
    asset_id: str,
    handler: AppHandler = Depends(get_state_service),
) -> DecomposeVideoResponse:
    """Decompose an analyzed video into scene-based sub-clips."""
    subclip_defs, error = handler.agent.decompose_video(asset_id)
    if error:
        return DecomposeVideoResponse(error=error)
    subclips = [
        SubClipInfo(
            parent_asset_id=sc.parent_asset_id,
            source_in=sc.source_in,
            source_out=sc.source_out,
            title=sc.title,
            description=sc.description,
            transcript=sc.transcript,
            topics=sc.topics,
            scene_indices=sc.scene_indices,
        )
        for sc in subclip_defs
    ]
    return DecomposeVideoResponse(subclips=subclips)


# ------------------------------------------------------------------
# Orchestrated multi-agent endpoints
# ------------------------------------------------------------------


@router.post("/agent/orchestrate", response_model=OrchestrateResponse)
def route_orchestrate(
    req: OrchestrateRequest,
    handler: AppHandler = Depends(get_state_service),
) -> OrchestrateResponse:
    return handler.agent.orchestrate(req)


@router.post("/agent/orchestrate/continue", response_model=OrchestrateResponse)
def route_orchestrate_continue(
    req: OrchestrateContinueRequest,
    handler: AppHandler = Depends(get_state_service),
) -> OrchestrateResponse:
    return handler.agent.orchestrate_continue(req)


@router.post("/agent/orchestrate/skip-task", response_model=OrchestrateResponse)
def route_orchestrate_skip_task(
    req: SkipTaskRequest,
    handler: AppHandler = Depends(get_state_service),
) -> OrchestrateResponse:
    return handler.agent.skip_task(req)


@router.get("/agent/classify-complexity")
def route_classify_complexity(
    prompt: str,
    handler: AppHandler = Depends(get_state_service),
) -> dict[str, str]:
    """Classify whether a prompt needs orchestration or the simple agent."""
    complexity = handler.agent.classify_request_complexity(prompt)
    return {"complexity": complexity}


@router.post("/agent/resolve-intent", response_model=IntentResolveResponse)
def route_resolve_intent(
    req: IntentResolveRequest,
    handler: AppHandler = Depends(get_state_service),
) -> IntentResolveResponse:
    """Resolve user intent by grounding the prompt against project context."""
    return handler.agent.resolve_intent(req)


@router.post("/agent/clarify", response_model=ClarifyResponse)
def route_clarify(
    req: ClarifyRequest,
    handler: AppHandler = Depends(get_state_service),
) -> ClarifyResponse:
    """Generate clarification questions for a complex request."""
    return handler.agent.clarify(req)


@router.post("/agent/suggest-asset-meta", response_model=SuggestAssetMetaResponse)
def route_suggest_asset_meta(
    req: SuggestAssetMetaRequest,
    handler: AppHandler = Depends(get_state_service),
) -> SuggestAssetMetaResponse:
    """Suggest a short name and tags for a generated asset."""
    return handler.agent.suggest_asset_meta(req)


@router.post("/agent/live-token", response_model=LiveTokenResponse)
def route_create_live_token(
    handler: AppHandler = Depends(get_state_service),
) -> LiveTokenResponse:
    """Mint a short-lived ephemeral token for client-side Live API access."""
    result = handler.agent.create_live_token()
    if result is None:
        raise HTTPException(
            status_code=503,
            detail="Unable to create Live API token. Check your Gemini API key in Settings.",
        )
    return result


@router.get("/agent/live-config", response_model=LiveConfigResponse)
def route_get_live_config(
    handler: AppHandler = Depends(get_state_service),
) -> LiveConfigResponse:
    """Return system prompt and tool declarations for Live API sessions."""
    return handler.agent.get_live_config()


# ------------------------------------------------------------------
# Project Memory endpoints
# ------------------------------------------------------------------


@router.get("/agent/memory/{project_id}")
def route_list_memory(
    project_id: str,
    assets_path: str | None = None,
) -> MemoryManifest:
    """List all memory documents for a project."""
    manifest = project_memory.get_manifest(project_id, assets_path)
    if manifest is None:
        return MemoryManifest(project_id=project_id, documents=[], updated_at="")
    return manifest


@router.get("/agent/memory/{project_id}/document/{doc_id}")
def route_read_memory_document(
    project_id: str,
    doc_id: str,
    assets_path: str | None = None,
) -> MemoryDocument:
    """Read a specific memory document."""
    doc = project_memory.read_document(project_id, doc_id, assets_path)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    return doc


@router.post("/agent/memory/{project_id}/document", response_model=DocumentMeta)
def route_create_memory_document(
    project_id: str,
    req: SaveDocumentRequest,
) -> DocumentMeta:
    """Create a new memory document."""
    try:
        return project_memory.write_document(
            project_id=project_id,
            title=req.title,
            doc_type=req.type,
            content=req.content,
            description=req.description,
            tags=req.tags,
            created_by=req.created_by,
            assets_path=req.assets_path,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.put("/agent/memory/{project_id}/document/{doc_id}", response_model=DocumentMeta)
def route_update_memory_document(
    project_id: str,
    doc_id: str,
    req: UpdateDocumentRequest,
) -> DocumentMeta:
    """Update an existing memory document."""
    try:
        meta = project_memory.update_document(
            project_id=project_id,
            doc_id=doc_id,
            content=req.content,
            title=req.title,
            description=req.description,
            tags=req.tags,
            assets_path=req.assets_path,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if meta is None:
        raise HTTPException(status_code=404, detail="Document not found")
    return meta


@router.delete("/agent/memory/{project_id}/document/{doc_id}")
def route_delete_memory_document(
    project_id: str,
    doc_id: str,
    assets_path: str | None = None,
) -> dict[str, str]:
    """Delete a memory document."""
    deleted = project_memory.delete_document(project_id, doc_id, assets_path)
    if not deleted:
        raise HTTPException(status_code=404, detail="Document not found")
    return {"status": "deleted"}


@router.get("/agent/memory/{project_id}/context")
def route_read_context(
    project_id: str,
    assets_path: str | None = None,
) -> dict[str, str]:
    """Read the master project context document."""
    content = project_memory.read_context(project_id, assets_path)
    return {"content": content}


@router.put("/agent/memory/{project_id}/context")
def route_update_context(
    project_id: str,
    req: UpdateContextRequest,
) -> dict[str, str]:
    """Update the master project context document."""
    project_memory.update_context(project_id, req.content, req.assets_path)
    return {"status": "updated"}


@router.get("/agent/memory/{project_id}/log")
def route_read_memory_log(
    project_id: str,
    assets_path: str | None = None,
) -> dict[str, str]:
    """Read the memory/preferences log."""
    content = project_memory.read_memory_log(project_id, assets_path)
    return {"content": content}


@router.post("/agent/memory/{project_id}/log")
def route_append_memory_log(
    project_id: str,
    req: AddMemoryEntryRequest,
) -> dict[str, str]:
    """Append an entry to the memory/preferences log."""
    project_memory.append_memory_entry(project_id, req.entry, req.assets_path)
    return {"status": "appended"}


@router.delete("/agent/memory/{project_id}/log")
def route_clear_memory_log(
    project_id: str,
    assets_path: str | None = None,
) -> dict[str, str]:
    """Clear the memory/preferences log."""
    project_memory.clear_memory_log(project_id, assets_path)
    return {"status": "cleared"}


@router.delete("/agent/memory/{project_id}/all")
def route_clear_all_memory(
    project_id: str,
    assets_path: str | None = None,
) -> dict[str, str]:
    """Clear all memory: documents, log, context, and brain cache."""
    project_memory.clear_all_memory(project_id, assets_path)
    return {"status": "cleared"}
