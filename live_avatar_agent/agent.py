import os
from typing import Optional

from google.adk.agents import LlmAgent

from .tools import TOOLS, function_declarations

AVATARS = {
    "Professional": ["Kira", "Ingrid", "Vera", "Sam", "Jay", "Paul"],
    "Stylized": ["Ben", "Kai", "Leo", "Carmen", "Piper"],
}
AVATAR_NAMES = [name for names in AVATARS.values() for name in names]

VOICES = {
    "Aoede": "Breezy", "Puck": "Upbeat", "Kore": "Firm", "Zephyr": "Bright", "Charon": "Informative",
    "Leda": "Youthful", "Sulafat": "Warm", "Achird": "Friendly", "Sadaltager": "Knowledgeable",
    "Vindemiatrix": "Gentle", "Fenrir": "Excitable", "Orus": "Firm", "Autonoe": "Bright",
    "Umbriel": "Easy-going", "Erinome": "Clear", "Laomedeia": "Upbeat", "Schedar": "Even",
    "Sadachbia": "Lively", "Enceladus": "Breathy", "Algieba": "Smooth", "Algenib": "Gravelly",
    "Achernar": "Soft", "Gacrux": "Mature", "Zubenelgenubi": "Casual", "Callirrhoe": "Easy-going",
    "Iapetus": "Clear", "Despina": "Smooth", "Rasalgethi": "Informative", "Alnilam": "Firm",
    "Pulcherrima": "Forward",
}

root_agent = LlmAgent(
    name="live_avatar_assistant",
    model="gemini-3.1-flash-live-preview-04-2026",
    instruction="""You are a professional AI assistant with a live avatar.
Your goal is to answer simple questions based on your knowledge in a polite, direct, and concise manner.
Keep your answers brief as they will be spoken by your avatar.
Always speak clearly and be helpful.

When the user shares their camera or screen you can see it. Answer questions about what is shown
and refer to it naturally.

You can also create media for the user:
- Call generate_image when they ask for any visual: a picture, an image, an illustration, a diagram,
  a chart, an infographic, a mockup, a poster, a logo.
- Call generate_video when they ask for a video, a clip or an animation.
- Call edit_image or edit_video when they want to change or extend the image or video that was just made.
- Call generate_video with use_last_image when they want to animate the image that was just made.
You can always create these. Never say that you cannot generate images, diagrams or videos; call the tool.
Turn what the user asked for into a rich, detailed prompt. If they want what they are showing on
camera or screen in the result, set use_current_view to true. When you call one of these tools,
say in one short sentence that you are generating it and keep helping the user.
The result appears in the conversation automatically. When you are told that a generation
is ready, tell the user in one short sentence. Create as many images and videos as the user asks for.
""",
    description="Live avatar tutor on the Gemini Live API with image and video generation tools.",
    tools=TOOLS,
)


def pick(name: Optional[str], options, default: str) -> str:
    """Case-insensitive match against the allowed names, falling back to the default."""
    if name:
        for option in options:
            if option.lower() == name.strip().lower():
                return option
    return default


def default_avatar() -> str:
    return pick(os.environ.get("AVATAR_NAME"), AVATAR_NAMES, "Kira")


def default_voice() -> str:
    return pick(os.environ.get("VOICE_NAME"), VOICES, "Aoede")


def get_agent_setup_config(agent: LlmAgent, avatar_name: Optional[str] = None, voice_name: Optional[str] = None) -> dict:
    """Live API setup message for the agent: model, instruction, tools, avatar and voice."""
    instruction_text = agent.instruction
    if callable(instruction_text):
        instruction_text = instruction_text(None)
    use_avatar = os.environ.get("ENABLE_AVATAR", "true").lower() == "true"
    project_id = os.environ.get("GCP_PROJECT_ID", "")
    region = os.environ.get("GCP_REGION", "us-central1")

    model_name = agent.model
    if "projects/" not in model_name and "publishers/" not in model_name:
        model_name = f"projects/{project_id}/locations/{region}/publishers/google/models/{model_name}"
    elif "publishers/" in model_name and "projects/" not in model_name:
        model_name = f"projects/{project_id}/locations/{region}/{model_name}"

    setup = {
        "system_instruction": {"parts": [{"text": instruction_text}]},
        "model": model_name,
        "generation_config": {
            "response_modalities": ["VIDEO"] if use_avatar else ["TEXT", "AUDIO"],
            "speech_config": {
                "voice_config": {
                    "prebuilt_voice_config": {"voice_name": pick(voice_name, VOICES, default_voice())}
                }
            },
        },
        "tools": [{"function_declarations": function_declarations(agent.tools)}],
        "input_audio_transcription": {},
        "output_audio_transcription": {},
    }
    if use_avatar:
        setup["avatar_config"] = {"avatar_name": pick(avatar_name, AVATAR_NAMES, default_avatar())}
    return {"setup": setup}
