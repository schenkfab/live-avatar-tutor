import asyncio
import base64
import logging
import os
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple

from google import genai
from google.genai import types

from .auth import get_credentials

logger = logging.getLogger("live_avatar_agent.genmedia")

IMAGE_ASPECT_RATIOS = {"1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"}
VIDEO_ASPECT_RATIOS = {"16:9", "9:16"}

_clients: Dict[str, genai.Client] = {}


@dataclass
class GeneratedMedia:
    kind: str
    mime_type: str
    data: bytes
    interaction_id: Optional[str] = None  # Omni interaction, lets a later edit build on this video

    @property
    def base64(self) -> str:
        return base64.b64encode(self.data).decode("ascii")


def use_gemini_api() -> bool:
    return os.environ.get("GENMEDIA_BACKEND", "vertex").lower() == "gemini"


def image_model() -> str:
    return os.environ.get("IMAGE_MODEL", "gemini-3.1-flash-image")


def video_model() -> str:
    default = "gemini-omni-1.1-flash" if use_gemini_api() else "gemini-omni-1.1-flash-preview"
    return os.environ.get("VIDEO_MODEL", default)


def get_client(location: str) -> genai.Client:
    key = "gemini" if use_gemini_api() else location
    if key not in _clients:
        if use_gemini_api():
            _clients[key] = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
        else:
            _clients[key] = genai.Client(
                vertexai=True,
                project=os.environ.get("GCP_PROJECT_ID"),
                location=location,
                credentials=get_credentials(),
            )
    return _clients[key]


def _field(obj: Any, name: str):
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


Reference = Optional[Tuple[str, bytes]]  # (mime type, bytes) of a frame the user is showing


def _generate_image_sync(prompt: str, aspect_ratio: Optional[str], reference: Reference = None) -> GeneratedMedia:
    client = get_client(os.environ.get("IMAGE_MODEL_LOCATION", "global"))
    contents: Any = prompt
    if reference:
        contents = [types.Part.from_bytes(data=reference[1], mime_type=reference[0]), prompt]
    response = client.models.generate_content(
        model=image_model(),
        contents=contents,
        config=types.GenerateContentConfig(
            response_modalities=["TEXT", "IMAGE"],
            image_config=types.ImageConfig(aspect_ratio=aspect_ratio) if aspect_ratio else None,
        ),
    )
    for candidate in response.candidates or []:
        content = candidate.content
        for part in (content.parts if content and content.parts else []):
            if part.inline_data and part.inline_data.data:
                return GeneratedMedia(
                    kind="image",
                    mime_type=part.inline_data.mime_type or "image/png",
                    data=part.inline_data.data,
                )
    raise RuntimeError(f"{image_model()} returned no image for this prompt")


def _generate_video_sync(prompt: str, aspect_ratio: str, reference: Reference = None,
                         previous_interaction_id: Optional[str] = None) -> GeneratedMedia:
    client = get_client(os.environ.get("VIDEO_MODEL_LOCATION", "global"))
    video_input: Any = prompt
    if reference:
        video_input = [
            {"type": "image", "data": base64.b64encode(reference[1]).decode("ascii"), "mime_type": reference[0]},
            {"type": "text", "text": prompt},
        ]
    request: Dict[str, Any] = {
        "model": video_model(),
        "input": video_input,
        "response_format": {
            "type": "video",
            "resolution": os.environ.get("VIDEO_RESOLUTION", "720p"),
        },
        "timeout": float(os.environ.get("VIDEO_TIMEOUT_SECONDS", "600")),
    }
    if previous_interaction_id:
        request["previous_interaction_id"] = previous_interaction_id
    else:
        request["response_format"]["aspect_ratio"] = aspect_ratio
    interaction = client.interactions.create(**request)
    interaction_id = _field(interaction, "id")
    video = _field(interaction, "output_video")
    if video is None:
        status = _field(interaction, "status")
        raise RuntimeError(f"{video_model()} returned no video (status: {status})")

    data = _field(video, "data")
    if data:
        raw = base64.b64decode(data) if isinstance(data, str) else bytes(data)
        return GeneratedMedia(kind="video", mime_type=_field(video, "mime_type") or "video/mp4", data=raw,
                              interaction_id=interaction_id)

    uri = _field(video, "uri")
    raise RuntimeError(f"{video_model()} returned the video as a URI instead of inline data: {uri}")


async def generate_image(prompt: str, aspect_ratio: Optional[str] = None, reference: Reference = None) -> GeneratedMedia:
    ratio = aspect_ratio if aspect_ratio in IMAGE_ASPECT_RATIOS else "16:9"
    return await asyncio.to_thread(_generate_image_sync, prompt, ratio, reference)


async def generate_video(prompt: str, aspect_ratio: Optional[str] = None, reference: Reference = None) -> GeneratedMedia:
    ratio = aspect_ratio if aspect_ratio in VIDEO_ASPECT_RATIOS else "16:9"
    return await asyncio.to_thread(_generate_video_sync, prompt, ratio, reference)


async def edit_image(instruction: str, source: Reference) -> GeneratedMedia:
    """Edits a previously generated image; the model receives the image and the instruction."""
    return await asyncio.to_thread(_generate_image_sync, instruction, None, source)


async def edit_video(instruction: str, previous_interaction_id: str) -> GeneratedMedia:
    """Edits or extends a previously generated video through the stateful Omni interaction."""
    return await asyncio.to_thread(_generate_video_sync, instruction, "16:9", None, previous_interaction_id)
