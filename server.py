import asyncio
import base64
import json
import logging
import os
import sys
from typing import Dict, Any

import websockets
from websockets.exceptions import ConnectionClosed
from dotenv import load_dotenv

from live_avatar_agent import ClientMessage, ServerMessage, SetupMessage
from live_avatar_agent import root_agent, get_agent_setup_config

# Load Environment Variables from the root .env file
load_dotenv()

# Configure Logger
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger("adk_live_backend")

def get_service_url() -> str:
    override_url = os.environ.get("GEMINI_LIVE_API_URL")
    if override_url:
        return override_url
    region = os.environ.get("GCP_REGION", "us-central1")
    return f"wss://{region}-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent"

SERVICE_URL = get_service_url()
API_KEY = os.environ.get("GEMINI_API_KEY", "")
BEARER_TOKEN = os.environ.get("GEMINI_BEARER_TOKEN", "")

def get_vertex_url() -> str:
    base_url = get_service_url()
    if API_KEY and "generativelanguage.googleapis.com" in base_url:
        return f"{base_url}?key={API_KEY}"
    return base_url

def get_vertex_headers() -> dict:
    headers = {}
    if BEARER_TOKEN and not API_KEY:
        headers["Authorization"] = f"Bearer {BEARER_TOKEN}"
    return headers

async def proxy_bidirectional(client_ws: Any, vertex_ws: Any):
    """Bidirectional proxy between client browser and Vertex AI Live API."""

    async def client_to_vertex():
        try:
            async for message in client_ws:
                msg_preview = str(message)[:200] + "..." if len(str(message)) > 200 else message
                logger.debug(f"Received from client: {msg_preview}")
                try:
                    # Validate and parse incoming client message
                    parsed = ClientMessage.model_validate_json(message)
                    
                    if parsed.realtime_input and parsed.realtime_input.text:
                        logger.info(f"User Query: {parsed.realtime_input.text}")
                    
                    # Forward to Vertex AI
                    await vertex_ws.send(parsed.model_dump_json(by_alias=True, exclude_none=True))
                except Exception as e:
                    logger.error(f"Error parsing or forwarding client message: {e}")
                    # Fallback forwarding just in case
                    await vertex_ws.send(message)
        except ConnectionClosed:
            logger.info("Client disconnected.")
        except Exception as e:
            logger.error(f"Error in client_to_vertex: {e}")

    async def vertex_to_client():
        try:
            async for message in vertex_ws:
                # 1. FAST PATH: Forward immediately to minimize latency
                if isinstance(message, bytes):
                    try:
                        message_str = message.decode('utf-8')
                        await client_ws.send(message_str)
                    except UnicodeDecodeError:
                        await client_ws.send(message)
                else:
                    await client_ws.send(message)

                # 2. LOGGING: Avoid parsing/printing massive video payloads to prevent CPU/IO blocking
                try:
                    if len(message) < 10000:
                        parsed = ServerMessage.model_validate_json(message)
                        
                        if parsed.error:
                            logger.error(f"Vertex AI Error: Code={parsed.error.code}, Message='{parsed.error.message}'")
                        
                        if parsed.setup_complete:
                            logger.info("Vertex AI Session Setup Completed successfully.")

                        if parsed.server_content:
                            if parsed.server_content.interrupted:
                                logger.warning("Model interrupted by user input.")
                            if parsed.server_content.input_transcription and parsed.server_content.input_transcription.text:
                                logger.info(f"User Spoke: {parsed.server_content.input_transcription.text}")
                            if parsed.server_content.output_transcription and parsed.server_content.output_transcription.text:
                                logger.info(f"Model Spoke: {parsed.server_content.output_transcription.text}")
                            if parsed.server_content.model_turn and parsed.server_content.model_turn.parts:
                                for part in parsed.server_content.model_turn.parts:
                                    if part.text:
                                        logger.info(f"Model Response Text: {part.text}")
                except Exception as e:
                    pass
        except ConnectionClosed as e:
            logger.error(f"Vertex AI connection closed. Code: {e.code}, Reason: '{e.reason}'")
        except Exception as e:
            logger.error(f"Error in vertex_to_client: {e}")

    # Run both tasks concurrently and clean up pending tasks instantly when one completes or fails
    done, pending = await asyncio.wait(
        [
            asyncio.create_task(client_to_vertex()),
            asyncio.create_task(vertex_to_client())
        ],
        return_when=asyncio.FIRST_COMPLETED
    )
    for task in pending:
        task.cancel()

async def handler(websocket: Any):
    logger.info(f"New client connection established from {websocket.remote_address}")
    
    vertex_url = get_vertex_url()
    headers = get_vertex_headers()
    
    logger.info(f"Connecting to Vertex AI Live API at {SERVICE_URL}...")
    try:
        async with websockets.connect(vertex_url, additional_headers=headers if headers else None) as vertex_ws:
            logger.info("Connected to Vertex AI Live API successfully.")
            
            # 1. Send Setup Message using ADK Agent configuration
            setup_payload = get_agent_setup_config(root_agent)
            logger.info(f"Sending Setup Message with model: {root_agent.model}...")
            
            # Validate with Pydantic SetupMessage
            setup_msg = SetupMessage.model_validate(setup_payload)
            await vertex_ws.send(setup_msg.model_dump_json(by_alias=True, exclude_none=True))
            logger.info("Session setup message sent.")
            
            # 2. Start bidirectional proxying
            await proxy_bidirectional(websocket, vertex_ws)
    except Exception as e:
        logger.error(f"Failed to connect or maintain session with Vertex AI: {e}")
        try:
            await websocket.send(json.dumps({"error": str(e)}))
        except:
            pass

async def main():
    host = "0.0.0.0"
    port = int(os.environ.get("PORT", 8080))
    logger.info(f"Starting ADK Live API Backend WebSocket Server on {host}:{port}...")
    async with websockets.serve(handler, host, port):
        await asyncio.Future()  # run forever

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Server shutdown by user.")
