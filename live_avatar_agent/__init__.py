import os

try:
    import certifi
    ca_bundle = certifi.where()
    if os.path.exists(ca_bundle):
        os.environ.setdefault("SSL_CERT_FILE", ca_bundle)
        os.environ.setdefault("REQUESTS_CA_BUNDLE", ca_bundle)
except ImportError:
    pass

from .agent import root_agent, get_agent_setup_config, AVATARS, VOICES, default_avatar, default_voice
from .models import ClientMessage, ServerMessage, SetupMessage
from .tools import SessionState
from .toolrunner import run_function_call
from . import genmedia
