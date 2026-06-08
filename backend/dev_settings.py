"""API credential settings endpoint for the local web app."""
from __future__ import annotations

from pathlib import Path
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .config import get_settings

router = APIRouter(prefix="/dev/settings", tags=["dev-settings"])

REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = REPO_ROOT / ".env"
class ApiSettingsRead(BaseModel):
    anthropic_api_key_set: bool
    key_source: str
    anthropic_base_url: str
    claude_model: str
    aws_profile: str
    bedrock_model: str
    active_provider: str


class ApiSettingsWrite(BaseModel):
    anthropic_api_key: str = ""
    anthropic_base_url: str = ""
    claude_model: str = ""
    aws_profile: str = ""
    bedrock_model: str = ""


def _read_env() -> dict[str, str]:
    if not ENV_PATH.exists():
        return {}
    result: dict[str, str] = {}
    for line in ENV_PATH.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        result[k.strip()] = v.strip()
    return result




def _normalize_base_url(value: str) -> str:
    url = value.strip()
    if not url:
        return ""
    if url == "api.ai.it.cornell.edu":
        return "https://api.ai.it.cornell.edu/"
    if url.startswith("http://api.ai.it.cornell.edu"):
        url = "https://" + url[len("http://"):]
    if not url.startswith(("https://", "http://")):
        url = "https://" + url
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise HTTPException(status_code=400, detail="API endpoint must use https://")
    if parsed.netloc == "api.ai.it.cornell.edu" and not url.endswith("/"):
        url += "/"
    return url

def _write_env(values: dict[str, str]) -> None:
    ENV_PATH.parent.mkdir(parents=True, exist_ok=True)
    existing = _read_env()
    existing.update({k: v for k, v in values.items() if v != ""})
    # Remove keys explicitly cleared (empty string passed explicitly means "unset")
    for k, v in values.items():
        if v == "":
            existing.pop(k, None)
    lines = [f"{k}={v}" for k, v in existing.items()]
    ENV_PATH.write_text("\n".join(lines) + "\n")


@router.get("", response_model=ApiSettingsRead)
async def read_settings():
    s = get_settings()
    return ApiSettingsRead(
        anthropic_api_key_set=bool(s.effective_anthropic_api_key()),
        key_source=_key_source(s),
        anthropic_base_url=s.effective_anthropic_base_url(),
        claude_model=s.effective_claude_model(),
        aws_profile=s.aws_profile,
        bedrock_model=s.bedrock_model,
        active_provider=s.active_provider(),
    )


@router.post("", response_model=ApiSettingsRead)
async def write_settings(
    body: ApiSettingsWrite,
):
    mapping: dict[str, str] = {}
    if body.anthropic_api_key != "":
        mapping["ANTHROPIC_API_KEY"] = body.anthropic_api_key
    if body.anthropic_base_url != "":
        mapping["ANTHROPIC_BASE_URL"] = _normalize_base_url(body.anthropic_base_url)
    if body.claude_model != "":
        mapping["CLAUDE_MODEL"] = body.claude_model
    if body.aws_profile != "":
        mapping["AWS_PROFILE"] = body.aws_profile
    if body.bedrock_model != "":
        mapping["BEDROCK_MODEL"] = body.bedrock_model

    _write_env(mapping)

    # Reload settings from updated .env
    get_settings.cache_clear()

    s = get_settings()
    return ApiSettingsRead(
        anthropic_api_key_set=bool(s.effective_anthropic_api_key()),
        key_source=_key_source(s),
        anthropic_base_url=s.effective_anthropic_base_url(),
        claude_model=s.effective_claude_model(),
        aws_profile=s.aws_profile,
        bedrock_model=s.bedrock_model,
        active_provider=s.active_provider(),
    )


def _key_source(settings) -> str:
    if settings.anthropic_api_key.strip():
        return ".env"
    return "not set"
