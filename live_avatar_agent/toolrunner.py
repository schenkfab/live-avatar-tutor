import inspect
import json
import logging
from typing import Any, Callable, Dict

from websockets.exceptions import ConnectionClosed

from .models import FunctionCall, GeneratedMediaMessage, GenerationErrorMessage
from .tools import TOOLS, SessionState, current_session

logger = logging.getLogger("live_avatar_agent.toolrunner")

TOOLS_BY_NAME: Dict[str, Callable] = {tool.__name__: tool for tool in TOOLS}


def media_kind(tool_name: str) -> str:
    return "video" if "video" in tool_name else "image"


def shown_prompt(tool_name: str, args: dict) -> str:
    text = str(args.get("instruction") or args.get("prompt") or "").strip()
    return f"Edit: {text}" if tool_name.startswith("edit_") else text


async def send_tool_response(vertex_ws: Any, call: FunctionCall, response: dict):
    message = {"toolResponse": {"functionResponses": [{"id": call.id, "name": call.name, "response": response}]}}
    await vertex_ws.send(json.dumps(message))


async def notify_model(vertex_ws: Any, text: str):
    """Tells the model as realtime text; clientContent only seeds history on this model."""
    await vertex_ws.send(json.dumps({"realtimeInput": {"text": text}}))


async def run_function_call(call: FunctionCall, state: SessionState, client_ws: Any, vertex_ws: Any):
    """Runs one tool call in the background and streams the result to the browser and the model."""
    args = dict(call.args or {})
    kind = media_kind(call.name)
    prompt = shown_prompt(call.name, args)
    logger.info(f"Tool call {call.name} ({call.id}): {json.dumps(args)}")

    # function calling is synchronous on this model, so answer now and let the avatar keep talking
    await send_tool_response(vertex_ws, call, {
        "status": "started",
        "message": f"The {kind} is being generated and will appear in the conversation shortly. "
                   "Tell the user in one short sentence and keep the conversation going."
    })

    tool = TOOLS_BY_NAME.get(call.name)
    token = current_session.set(state)
    try:
        if tool is None:
            raise ValueError(f"Unknown tool: {call.name}")
        accepted = {name: value for name, value in args.items() if name in inspect.signature(tool).parameters}
        media = await tool(**accepted)
    except Exception as e:
        logger.exception(f"{call.name} ({call.id}) failed")
        error = GenerationErrorMessage(id=call.id or "", kind=kind, message=str(e))
        try:
            await client_ws.send(json.dumps({"generationError": error.model_dump()}))
            await notify_model(vertex_ws, f"The {kind} generation failed with this error: {e}. "
                                          "Tell the user in one short sentence and offer to try again.")
        except ConnectionClosed:
            pass
        return
    finally:
        current_session.reset(token)

    logger.info(f"{call.name} ({call.id}) done: {media.mime_type}, {len(media.data)} bytes")
    result = GeneratedMediaMessage(id=call.id or "", kind=media.kind, mime_type=media.mime_type,
                                   data=media.base64, prompt=prompt)
    try:
        await client_ws.send(json.dumps({"generatedMedia": result.model_dump(by_alias=True)}))
        await notify_model(vertex_ws, f"The {kind} for \"{prompt}\" is now displayed to the user. "
                                      "Tell them it is ready in one short sentence.")
    except ConnectionClosed:
        logger.info(f"Session closed before the {kind} ({call.id}) could be delivered.")
