import contextvars
import inspect
from dataclasses import dataclass
from typing import Callable, Dict, List, Literal, Optional, Tuple

from google.genai import types

from . import genmedia
from .genmedia import GeneratedMedia

Frame = Optional[Tuple[str, bytes]]


@dataclass
class SessionState:
    last_frame: Frame = None  # latest camera or screen frame sent by the browser
    last_image: Frame = None  # latest generated or edited image
    last_video_interaction: Optional[str] = None  # Omni interaction of the latest video, for edits


# Set by the tool runner around each call, so the tool functions keep model-facing signatures
current_session: contextvars.ContextVar[SessionState] = contextvars.ContextVar("current_session")


async def generate_image(
    prompt: str,
    aspect_ratio: Literal["16:9", "9:16", "1:1", "4:3", "3:4"] = "16:9",
    use_current_view: bool = False,
) -> GeneratedMedia:
    """Generate an image with Nano Banana from a text description. Use it whenever the user asks to
    see, draw, show, sketch, create, make or generate any visual: a picture, photo, illustration,
    diagram, chart, infographic, schema, flowchart, mockup, poster, logo, icon, map or scene. Write
    the prompt in English and describe the subject, setting, style, lighting and composition. For
    diagrams, charts and infographics describe the layout, every element, the labels and the exact
    text to render. Each call creates a new image, so call it again if the user wants another one
    or a variation.

    Args:
        prompt: Detailed description of the image to generate.
        aspect_ratio: Aspect ratio of the image. Use 16:9 unless the user asks otherwise.
        use_current_view: Set to true when the user refers to what they are showing on their camera
            or screen (this object, what you see, my screen, this design). The current frame is
            then used as a reference image.
    """
    state = current_session.get()
    reference = state.last_frame if use_current_view else None
    media = await genmedia.generate_image(prompt, aspect_ratio, reference)
    state.last_image = (media.mime_type, media.data)
    return media


async def generate_video(
    prompt: str,
    aspect_ratio: Literal["16:9", "9:16"] = "16:9",
    use_last_image: bool = False,
    use_current_view: bool = False,
) -> GeneratedMedia:
    """Generate a short video clip with sound using Gemini Omni from a text description. Use it
    whenever the user asks for a video, clip, animation or something in motion. Write the prompt
    in English and describe the scene, camera movement, lighting, mood and audio. To animate the
    image that was just generated (make a video from it, bring it to life, animate this) set
    use_last_image: the image becomes the first frame, so describe the motion and the camera move
    rather than the scene. Generation takes about a minute, so tell the user you are working on it
    and keep the conversation going. Each call creates a new video, so call it again if the user
    wants another one or a variation.

    Args:
        prompt: Detailed description of the video to generate.
        aspect_ratio: Aspect ratio of the video. Use 16:9 unless the user asks for a vertical video.
        use_last_image: Set to true to animate the most recently generated image: it is used as
            the first frame of the video.
        use_current_view: Set to true when the user refers to what they are showing on their camera
            or screen and wants it in the video. The current frame is then used as a reference.
    """
    state = current_session.get()
    reference = None
    if use_last_image and state.last_image:
        reference = state.last_image
        prompt = f"<FIRST_FRAME> {prompt}"
    elif use_current_view:
        reference = state.last_frame
    media = await genmedia.generate_video(prompt, aspect_ratio, reference)
    state.last_video_interaction = media.interaction_id
    return media


async def edit_image(instruction: str) -> GeneratedMedia:
    """Edit the most recently generated image (or its latest edit) following the user's instruction:
    change colours, add or remove elements, change the style, the background, the lighting or the
    text. Use it when the user refers to the image that was just made (this image, the picture,
    make it, change it, add, remove). Keep the instruction short, in English, and end it with
    'Keep everything else the same' unless the user wants a big change.

    Args:
        instruction: What to change in the image.
    """
    state = current_session.get()
    if not state.last_image:
        raise RuntimeError("There is no generated image to edit yet")
    media = await genmedia.edit_image(instruction, state.last_image)
    state.last_image = (media.mime_type, media.data)
    return media


async def edit_video(instruction: str) -> GeneratedMedia:
    """Edit or extend the most recently generated video (or its latest edit) following the user's
    instruction. Use it when the user refers to the video that was just made. Simple instructions
    in English work best, for example 'Make the car red. Keep everything else the same.' or
    'Extend this video: the camera pans up to the sky.' Generation takes about a minute, so tell
    the user you are working on it and keep the conversation going.

    Args:
        instruction: What to change in the video, or how to extend it.
    """
    state = current_session.get()
    if not state.last_video_interaction:
        raise RuntimeError("There is no generated video to edit yet")
    media = await genmedia.edit_video(instruction, state.last_video_interaction)
    state.last_video_interaction = media.interaction_id or state.last_video_interaction
    return media


TOOLS: List[Callable] = [generate_image, generate_video, edit_image, edit_video]


def split_docstring(doc: Optional[str]) -> Tuple[str, Dict[str, str]]:
    """Summary text and one description per parameter, from a docstring with an Args section."""
    summary: List[str] = []
    params: Dict[str, str] = {}
    name = None
    in_args = False
    for line in inspect.cleandoc(doc or "").splitlines():
        stripped = line.strip()
        if stripped == "Args:":
            in_args = True
            continue
        if not in_args:
            summary.append(stripped)
        elif ":" in stripped and not line.startswith("        "):
            name, text = stripped.split(":", 1)
            params[name.strip()] = text.strip()
        elif name:
            params[name] = f"{params[name]} {stripped}".strip()
    return " ".join(part for part in summary if part), params


def function_declarations(tools: List[Callable]) -> List[dict]:
    """Live API function declarations built from the tool functions' signatures and docstrings."""
    declarations = []
    for tool in tools:
        # the GEMINI_API option skips the response schema, which the return type cannot express; parameters are the same
        declaration = types.FunctionDeclaration.from_callable_with_api_option(callable=tool, api_option="GEMINI_API")
        data = declaration.model_dump(exclude_none=True)
        summary, params = split_docstring(tool.__doc__)
        data["description"] = summary
        for param_name, schema in data.get("parameters", {}).get("properties", {}).items():
            schema.pop("default", None)
            if param_name in params:
                schema["description"] = params[param_name]
        declarations.append(data)
    return declarations
