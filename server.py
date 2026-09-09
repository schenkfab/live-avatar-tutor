import asyncio
import base64
import json
import logging
import mimetypes
import os
import ssl
import sys
from http import HTTPStatus
from pathlib import Path
from typing import Any, Set
from urllib.parse import parse_qs, urlsplit

import certifi
import websockets
from websockets.datastructures import Headers
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Response
from dotenv import load_dotenv

# before importing the agent package, which reads the environment at import time
load_dotenv()

from live_avatar_agent import ClientMessage, ServerMessage, SetupMessage, SessionState
from live_avatar_agent import root_agent, get_agent_setup_config, run_function_call
from live_avatar_agent import AVATARS, VOICES, default_avatar, default_voice
from live_avatar_agent.auth import get_access_token

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger("adk_live_backend")

FRONTEND_DIR = Path(__file__).resolve().parent / "frontend"


def get_service_url() -> str:
    override_url = os.environ.get("GEMINI_LIVE_API_URL")
    if override_url:
        return override_url
    region = os.environ.get("GCP_REGION", "us-central1")
    host = "aiplatform.googleapis.com" if region == "global" else f"{region}-aiplatform.googleapis.com"
    return f"wss://{host}/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent"


SERVICE_URL = get_service_url()
API_KEY = os.environ.get("GEMINI_API_KEY", "")


def uses_api_key() -> bool:
    return bool(API_KEY) and "generativelanguage.googleapis.com" in SERVICE_URL


def get_vertex_url() -> str:
    if uses_api_key():
        return f"{SERVICE_URL}?key={API_KEY}"
    return SERVICE_URL


def get_vertex_headers() -> dict:
    if uses_api_key():
        return {}
    return {"Authorization": f"Bearer {get_access_token()}"}


def get_ssl_context() -> ssl.SSLContext:
    try:
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


def log_server_message(parsed: ServerMessage):
    if parsed.error:
        logger.error(f"Vertex AI Error: Code={parsed.error.code}, Message='{parsed.error.message}'")
    if parsed.setup_complete:
        logger.info("Vertex AI Session Setup Completed successfully.")
    content = parsed.server_content
    if not content:
        return
    if content.interrupted:
        logger.warning("Model interrupted by user input.")
    if content.input_transcription and content.input_transcription.text:
        logger.info(f"User Spoke: {content.input_transcription.text}")
    if content.output_transcription and content.output_transcription.text:
        logger.info(f"Model Spoke: {content.output_transcription.text}")
    if content.model_turn and content.model_turn.parts:
        for part in content.model_turn.parts:
            if part.text:
                logger.info(f"Model Response Text: {part.text}")


async def proxy_bidirectional(client_ws: Any, vertex_ws: Any):
    """Bidirectional proxy between client browser and Vertex AI Live API."""

    state = SessionState()
    background_tasks: Set[asyncio.Task] = set()

    def spawn(coro):
        task = asyncio.create_task(coro)
        background_tasks.add(task)
        task.add_done_callback(background_tasks.discard)

    async def client_to_vertex():
        audio_chunks = 0
        video_frames = 0
        try:
            async for message in client_ws:
                try:
                    parsed = ClientMessage.model_validate_json(message)
                    realtime = parsed.realtime_input
                    if realtime and realtime.text:
                        logger.info(f"User Query: {realtime.text}")
                    if realtime and (realtime.audio or realtime.media_chunks):
                        audio_chunks += 1
                        if audio_chunks == 1 or audio_chunks % 100 == 0:
                            blob = realtime.audio or realtime.media_chunks[0]
                            logger.info(f"Forwarding audio chunk {audio_chunks} ({blob.mime_type}, {len(blob.data)} base64 chars)")
                    if realtime and realtime.video:
                        state.last_frame = (realtime.video.mime_type, base64.b64decode(realtime.video.data))
                        video_frames += 1
                        if video_frames == 1 or video_frames % 30 == 0:
                            logger.info(f"Forwarding video frame {video_frames} ({realtime.video.mime_type}, {len(realtime.video.data)} base64 chars)")
                    await vertex_ws.send(parsed.model_dump_json(by_alias=True, exclude_none=True))
                except Exception as e:
                    logger.error(f"Error parsing or forwarding client message: {e}")
                    await vertex_ws.send(message)
        except ConnectionClosed:
            logger.info("Client disconnected.")
        except Exception as e:
            logger.error(f"Error in client_to_vertex: {e}")

    async def vertex_to_client():
        try:
            async for message in vertex_ws:
                # forward first, parse after, so logging never delays the stream
                if isinstance(message, bytes):
                    try:
                        message = message.decode('utf-8')
                    except UnicodeDecodeError:
                        await client_ws.send(message)
                        continue
                await client_ws.send(message)

                # video chunks are large, skip parsing them
                if len(message) >= 10000:
                    continue
                try:
                    parsed = ServerMessage.model_validate_json(message)
                except Exception:
                    continue

                log_server_message(parsed)
                if parsed.tool_call:
                    for call in parsed.tool_call.function_calls:
                        spawn(run_function_call(call, state, client_ws, vertex_ws))
                if parsed.tool_call_cancellation:
                    logger.warning(f"Model cancelled tool calls: {parsed.tool_call_cancellation.ids}")
        except ConnectionClosed as e:
            logger.error(f"Vertex AI connection closed. Code: {e.code}, Reason: '{e.reason}'")
        except Exception as e:
            logger.error(f"Error in vertex_to_client: {e}")

    done, pending = await asyncio.wait(
        [asyncio.create_task(client_to_vertex()), asyncio.create_task(vertex_to_client())],
        return_when=asyncio.FIRST_COMPLETED
    )
    for task in pending:
        task.cancel()
    for task in background_tasks:
        task.cancel()


def connection_params(websocket: Any) -> dict:
    """Query parameters of the browser's WebSocket URL, e.g. /?avatar=Kira&voice=Aoede"""
    request = getattr(websocket, "request", None)
    path = getattr(request, "path", "") or ""
    return {key: values[0] for key, values in parse_qs(urlsplit(path).query).items() if values}


async def handler(websocket: Any):
    logger.info(f"New client connection established from {websocket.remote_address}")
    params = connection_params(websocket)

    logger.info(f"Connecting to Vertex AI Live API at {SERVICE_URL}...")
    try:
        vertex_url = get_vertex_url()
        headers = get_vertex_headers()

        ssl_context = get_ssl_context() if vertex_url.startswith("wss://") else None
        async with websockets.connect(
            vertex_url,
            additional_headers=headers if headers else None,
            ssl=ssl_context,
        ) as vertex_ws:
            logger.info("Connected to Vertex AI Live API successfully.")

            setup_payload = get_agent_setup_config(root_agent, params.get("avatar"), params.get("voice"))
            setup = setup_payload["setup"]
            avatar = setup.get("avatar_config", {}).get("avatar_name", "no avatar")
            voice = setup["generation_config"]["speech_config"]["voice_config"]["prebuilt_voice_config"]["voice_name"]
            logger.info(f"Sending Setup Message with model: {root_agent.model}, avatar {avatar}, voice {voice}...")

            setup_msg = SetupMessage.model_validate(setup_payload)
            await vertex_ws.send(setup_msg.model_dump_json(by_alias=True, exclude_none=True))
            logger.info("Session setup message sent.")

            await proxy_bidirectional(websocket, vertex_ws)
    except Exception as e:
        logger.error(f"Failed to connect or maintain session with Vertex AI: {e}")
        try:
            await websocket.send(json.dumps({"error": str(e)}))
        except:
            pass


def json_response(connection: Any, payload: dict):
    body = json.dumps(payload).encode("utf-8")
    headers = Headers([("Content-Type", "application/json"), ("Content-Length", str(len(body))), ("Cache-Control", "no-cache")])
    return Response(HTTPStatus.OK, "OK", headers, body)


def serve_frontend(connection: Any, request: Any):
    """Serves the frontend and /config on the same port; WebSocket upgrades pass through to the handler."""
    if request.headers.get("Upgrade", "").lower() == "websocket":
        return None
    path = request.path.split("?", 1)[0]
    if path == "/config":
        return json_response(connection, {
            "avatars": AVATARS,
            "voices": VOICES,
            "defaults": {"avatar": default_avatar(), "voice": default_voice()},
        })
    if path == "/":
        path = "/index.html"
    file_path = (FRONTEND_DIR / path.lstrip("/")).resolve()
    if not file_path.is_file() or FRONTEND_DIR not in file_path.parents:
        return connection.respond(HTTPStatus.NOT_FOUND, "Not found\n")
    content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    body = file_path.read_bytes()
    headers = Headers([("Content-Type", content_type), ("Content-Length", str(len(body))), ("Cache-Control", "no-cache")])
    return Response(HTTPStatus.OK, "OK", headers, body)


async def main():
    host = "0.0.0.0"
    port = int(os.environ.get("PORT", 8080))
    logger.info(f"Starting Live Avatar backend on {host}:{port}...")
    logger.info(f"Open http://localhost:{port} in your browser.")
    async with websockets.serve(handler, host, port, process_request=serve_frontend, max_size=8 * 1024 * 1024):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Server shutdown by user.")
