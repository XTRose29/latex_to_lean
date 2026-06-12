from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import yaml
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ── Database ─────────────────────────────────────────────────────────────
    # SQLite for local dev; swap for postgresql+asyncpg://... in production.
    database_url: str = "sqlite+aiosqlite:///./backend/data/app.db"

    # ── Claude / Anthropic — server-side only; never sent from the browser ──
    anthropic_api_key: str = ""
    anthropic_base_url: str = ""       # empty → Anthropic default endpoint
    claude_model: str = ""
    latex_to_lean_dry_run: bool = False
    latex_to_lean_efficient_llm: bool = True

    # ── AWS Bedrock (alternative provider) ──────────────────────────────────
    aws_profile: str = ""
    bedrock_model: str = "claude-opus-4-8"

    # ── CORS ─────────────────────────────────────────────────────────────────
    # In production replace with the actual frontend origin.
    cors_origins: list[str] = ["http://localhost:5173", "http://localhost:3000"]

    # ── Paths (computed from repo layout) ───────────────────────────────────
    # backend/ sits one level below the repo root.
    @property
    def repo_root(self) -> Path:
        return Path(__file__).resolve().parent.parent

    @property
    def data_dir(self) -> Path:
        return Path(__file__).resolve().parent / "data"

    @property
    def pipeline_code_dir(self) -> Path:
        return self.repo_root / "pipeline"

    @property
    def prompts_dir(self) -> Path:
        return self.repo_root / "prompts"

    @property
    def jobs_dir(self) -> Path:
        return self.data_dir / "jobs"

    # ── Derived helpers ──────────────────────────────────────────────────────
    def root_config(self) -> dict:
        path = self.repo_root / "config.yaml"
        if not path.exists():
            return {}
        try:
            return yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        except yaml.YAMLError:
            return {}

    def effective_anthropic_api_key(self) -> str:
        return self.anthropic_api_key.strip()

    def effective_anthropic_base_url(self) -> str:
        if self.anthropic_base_url.strip():
            return self.anthropic_base_url.strip()
        return (
            self.root_config()
            .get("claude", {})
            .get("api_key", {})
            .get("base_url", "")
            .strip()
        )

    def effective_claude_model(self) -> str:
        if self.claude_model.strip():
            return self.claude_model.strip()
        return (
            self.root_config()
            .get("claude", {})
            .get("api_key", {})
            .get("model", "")
            .strip()
            or "claude-sonnet-4-6"
        )

    def active_provider(self) -> str:
        configured = (
            self.root_config()
            .get("claude", {})
            .get("provider", "")
            .strip()
        )
        if configured in {"api_key", "bedrock", "subscription"}:
            return configured
        if self.effective_anthropic_api_key():
            return "api_key"
        if self.aws_profile:
            return "bedrock"
        return "subscription"

    def job_dir(self, job_id: str) -> Path:
        return self.jobs_dir / job_id


@lru_cache
def get_settings() -> Settings:
    return Settings()
