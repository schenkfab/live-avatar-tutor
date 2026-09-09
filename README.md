# Live Avatar Studio

A talking avatar on the Gemini Live API that can generate and edit images (Nano Banana) and videos (Gemini Omni) in the middle of the conversation, by voice or text. It can also see your camera or screen and use what it sees as a reference for generation.

It is built primarily to show a live avatar as a tutor for educational purposes: the learner asks by voice, the tutor answers and illustrates with a diagram, an image or a short animation, and can look at the learner's notes or screen. The same pattern works for other uses, such as storyboarding, product visualization from a product shown to the camera, virtual try-on, or sales and support assistants that explain with visuals. Users can choose the avatar and the voice from the UI, and the persona is one text block in `live_avatar_agent/agent.py`.

Disclaimer: this is built for demo purposes, not an official Google product.

## What it does

- Real-time voice and text conversation with a Gemini Live avatar (video output with lip sync), with interruptions.
- Image generation with Nano Banana 2 (`gemini-3.1-flash-image`), including diagrams, charts and mockups.
- Video generation with Gemini Omni (`gemini-omni-1.1-flash-preview`), with sound.
- Editing of the last image ("add a hat") and of the last video ("make the car red", "extend it, the camera pans up"), each edit building on the previous result.
- Image to video: "animate this" uses the last generated image as the first frame.
- Camera and screen sharing: ask about what you show, or use it as a reference ("make a video of this product on a beach").
- Choice of the 11 built-in avatars and 30 voices from the UI.

The avatar decides when to generate through function calling; the backend runs the generation in the background, shows the result as a card in the chat, and tells the avatar when it is ready.

## Requirements

- Python 3.10 or later
- A Google Cloud project with the Vertex AI API enabled and access to:
  - `gemini-3.1-flash-live-preview-04-2026` (Live Avatar preview, allowlisted per project, served from `us-central1`)
  - `gemini-3.1-flash-image` (global)
  - `gemini-omni-1.1-flash-preview` (global)
- `gcloud` CLI, Chrome (recommended for microphone and screen sharing)

## Setup

```bash
python -m venv .venv
source .venv/bin/activate          # Windows PowerShell: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
gcloud auth application-default login
gcloud auth application-default set-quota-project YOUR_PROJECT_ID
```

Edit `.env`:

```
GCP_PROJECT_ID=your-project-id
GCP_REGION=us-central1
GEMINI_LIVE_API_URL=wss://us-central1-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent
```

Leave `GEMINI_BEARER_TOKEN` empty to use application default credentials; a fresh token is minted for every session. If local `gcloud` is blocked by Context Aware Access, paste a token from Cloud Shell (`gcloud auth print-access-token`) into `GEMINI_BEARER_TOKEN`; it expires after about an hour.

Check the generators before the first session:

```bash
python test_genmedia.py image
python test_genmedia.py video A cat surfing at sunset, single continuous shot
```

They write `test_image.png` and `test_video.mp4` and print timings.

## Run

```bash
python server.py
```

Open http://localhost:8080. Click Connect, then click once anywhere on the page to unlock audio.

- Mic button: toggles the microphone. Speak, then pause; the avatar answers. Speak over it to interrupt.
- Camera and screen buttons: share a video source with the avatar (one at a time), shown as a small preview in the avatar panel, sent at 1 frame per second.
- Teacher and Voice: choose the avatar and the voice. Changing them during a session reconnects.
- Text box: everything also works typed.

Generated images and videos appear as cards in the chat with a download link. Videos start muted; unmute with the player controls.

## Configuration

All in `.env`:

| Variable | Purpose |
| --- | --- |
| `GCP_PROJECT_ID`, `GCP_REGION` | project and region of the Live avatar model |
| `GEMINI_LIVE_API_URL` | Live API endpoint; for `global` the host is `aiplatform.googleapis.com` without prefix |
| `ENABLE_AVATAR` | `true` for the avatar (VIDEO), `false` for audio only |
| `AVATAR_NAME`, `VOICE_NAME` | defaults when the browser does not choose |
| `GEMINI_BEARER_TOKEN` | optional static token, otherwise ADC |
| `GENMEDIA_BACKEND` | `vertex` (same project and credentials) or `gemini` (uses `GEMINI_API_KEY`) |
| `IMAGE_MODEL`, `IMAGE_MODEL_LOCATION` | image model and location |
| `VIDEO_MODEL`, `VIDEO_MODEL_LOCATION` | video model and location (`gemini-omni-1.1-flash` on the Gemini API backend) |
| `VIDEO_RESOLUTION`, `VIDEO_TIMEOUT_SECONDS` | keep 720p so the clip stays small enough to stream to the browser |
| `PORT` | server port, default 8080 |

The persona and the tool descriptions live in `live_avatar_agent/agent.py` and `live_avatar_agent/tools.py`. Tools are declared once as Python functions; their docstrings become the descriptions the model reads, so wording there changes when the avatar decides to generate.

## How the tool calls work

Function calling on the avatar model is synchronous, so the backend answers each tool call immediately with a "started" response, which lets the avatar keep talking, and runs the generation as a background task. When the media is ready it is pushed to the browser as a `generatedMedia` message and the model is told through a realtime text turn, so it announces the result. Several generations can run at the same time. Per session the backend keeps the last camera frame, the last image and the last video interaction, which is what edits, image to video and camera references use.

## Limits

- Edits apply to the most recent image or video; earlier ones cannot be targeted by name.
- The video is streamed to the browser as base64 over the WebSocket, which is fine at 720p and a few seconds; higher resolutions need a file store.
- Session context resets when changing the teacher or reconnecting.
