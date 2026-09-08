import logging
import os
from google.adk.agents import LlmAgent

# Configure logging
logger = logging.getLogger("live_avatar_agent")
logger.setLevel(logging.INFO)
formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
ch = logging.StreamHandler()
ch.setFormatter(formatter)
logger.addHandler(ch)

# Define the ADK Agent
root_agent = LlmAgent(
    name="live_avatar_assistant",
    model="gemini-3.1-flash-live-preview-04-2026",
    instruction="""You are a professional AI assistant with a live avatar.
Your goal is to answer simple questions based on your knowledge in a polite, direct, and concise manner.
Keep your answers brief as they will be spoken by your avatar.
Always speak clearly and be helpful.
""",
    description="A lightweight production-ready ADK Agent implementation for the Gemini 3.1 Live API with Avatars.",
)

def get_agent_setup_config(agent: LlmAgent) -> dict:
    """Helper to extract setup configuration from an ADK LlmAgent."""
    instruction_text = agent.instruction
    if callable(instruction_text):
        instruction_text = instruction_text(None) # Pass empty context

    use_avatar = os.environ.get("ENABLE_AVATAR", "true").lower() == "true"
    project_id = os.environ.get("GCP_PROJECT_ID", "fabian-genai-bb")
    region = os.environ.get("GCP_REGION", "us-central1")
    
    # Construct canonical Vertex AI model resource URI
    model_name = agent.model
    if "projects/" not in model_name and "publishers/" not in model_name:
        model_name = f"projects/{project_id}/locations/{region}/publishers/google/models/{model_name}"
    elif "publishers/" in model_name and "projects/" not in model_name:
        model_name = f"projects/{project_id}/locations/{region}/{model_name}"

    setup_payload = {
        "setup": {
            "system_instruction": {
                "parts": [{"text": instruction_text}]
            },
            "model": model_name,
            "generation_config": {
                "response_modalities": ["VIDEO"] if use_avatar else ["TEXT", "AUDIO"],
                "speech_config": {
                    "voice_config": {
                        "prebuilt_voice_config": {
                            "voice_name": "aoede"
                        }
                    }
                }
            },
            "input_audio_transcription": {},
            "output_audio_transcription": {}
        }
    }
    
    if use_avatar:
        setup_payload["setup"]["avatar_config"] = {
            "avatar_name": "Kira"
        }
    return setup_payload
