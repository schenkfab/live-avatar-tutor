import os

import google.auth
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials

SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]

_adc_credentials = None


def static_token() -> str:
    token = os.environ.get("GEMINI_BEARER_TOKEN", "").strip()
    if token and not token.startswith("your_"):
        return token
    return ""


def get_credentials():
    """Static bearer token from .env when set, otherwise application default credentials."""
    global _adc_credentials
    token = static_token()
    if token:
        return Credentials(token=token)
    if _adc_credentials is None:
        _adc_credentials, _ = google.auth.default(scopes=SCOPES)
    return _adc_credentials


def get_access_token() -> str:
    token = static_token()
    if token:
        return token
    credentials = get_credentials()
    if not credentials.valid:
        credentials.refresh(Request())
    return credentials.token
