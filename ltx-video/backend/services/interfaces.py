"""Compatibility re-exports for service interfaces."""

from __future__ import annotations

from typing import Literal

from services.fast_native_video_pipeline.fast_native_video_pipeline import FastNativeVideoPipeline
from services.fast_video_pipeline.fast_video_pipeline import FastVideoPipeline
from services.gpu_cleaner.gpu_cleaner import GpuCleaner
from services.gpu_info.gpu_info import GpuInfo, GpuTelemetryPayload
from services.http_client.http_client import HTTPClient, HttpResponseLike, HttpTimeoutError
from services.ic_lora_model_downloader.ic_lora_model_downloader import (
    IcLoraDownloadPayload,
    IcLoraModelDownloader,
    IcLoraModelPayload,
)
from services.ic_lora_pipeline.ic_lora_pipeline import IcLoraPipeline
from services.image_generation_pipeline.image_generation_pipeline import ImageGenerationPipeline
from services.model_downloader.model_downloader import ModelDownloader
from services.pro_native_video_pipeline.pro_native_video_pipeline import ProNativeVideoPipeline
from services.pro_video_pipeline.pro_video_pipeline import ProVideoPipeline
from services.services_utils import JSONScalar, JSONValue
from services.task_runner.task_runner import TaskRunner
from services.text_encoder.text_encoder import TextEncoder
from services.video_processor.video_processor import VideoInfoPayload, VideoProcessor

VideoPipelineModelType = Literal["fast", "fast-native", "pro", "pro-native"]

__all__ = [
    "JSONScalar",
    "JSONValue",
    "GpuTelemetryPayload",
    "VideoInfoPayload",
    "IcLoraModelPayload",
    "IcLoraDownloadPayload",
    "HttpTimeoutError",
    "HttpResponseLike",
    "HTTPClient",
    "ModelDownloader",
    "GpuCleaner",
    "GpuInfo",
    "VideoProcessor",
    "TaskRunner",
    "VideoPipelineModelType",
    "FastVideoPipeline",
    "FastNativeVideoPipeline",
    "ProVideoPipeline",
    "ProNativeVideoPipeline",
    "ImageGenerationPipeline",
    "IcLoraPipeline",
    "IcLoraModelDownloader",
    "TextEncoder",
]
