from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml
from sqlalchemy import select, update

from .config import get_settings
from .db import SessionLocal
from .models import Job, Project

settings = get_settings()
_tasks: dict[str, asyncio.Task] = {}


async def enqueue_pipeline_job(job_id: str) -> None:
    """Start one local background pipeline task inside the FastAPI process."""
    task = _tasks.get(job_id)
    if task and not task.done():
        return
    _tasks[job_id] = asyncio.create_task(_run_pipeline_job(job_id))


async def _run_pipeline_job(job_id: str) -> dict:
    try:
        return await _run_pipeline_job_impl(job_id)
    except Exception as exc:
        await _update_job(job_id, state="error", error_msg=str(exc))
        return {"state": "error", "job_id": job_id, "error": str(exc)}
    finally:
        _tasks.pop(job_id, None)


async def _run_pipeline_job_impl(job_id: str) -> dict:
    async with SessionLocal() as db:
        row = await db.execute(
            select(Job, Project)
            .join(Project, Job.project_id == Project.id)
            .where(Job.id == job_id)
        )
        pair = row.first()
        if not pair:
            return {"error": f"Job {job_id} not found"}
        job, project = pair

    credential_error = _credential_preflight_error()
    if credential_error:
        await _update_job(job_id, state="error", stage_label="Credential check failed", error_msg=credential_error)
        return {"state": "error", "job_id": job_id, "error": credential_error}

    await _update_job(job_id, state="running", stage_label="Starting pipeline")

    job_dir = settings.job_dir(job_id)
    input_dir = str(job_dir / "input")
    output_dir = str(job_dir / "output")
    work_dir = job.work_dir
    runtime_cfg = _write_runtime_config(job_id)

    cmd = [
        sys.executable,
        str(settings.pipeline_code_dir / "benchmark_pipeline" / "main.py"),
        "--input",
        input_dir,
        "--output",
        output_dir,
        "--config",
        str(runtime_cfg),
        "--chapter",
        str(project.chapter),
        "--ui-pause-for-profile",
    ]
    if project.theorem_label:
        cmd.extend(["--theorem", project.theorem_label])

    env = _build_env()
    env["LATEX_TO_LEAN_RUN_ID"] = job_id
    env["LATEX_TO_LEAN_INPUT_NAME"] = project.name
    log_path = job_dir / "pipeline.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)

    with open(log_path, "a", encoding="utf-8") as log_fh:
        proc = subprocess.Popen(
            cmd,
            cwd=str(settings.repo_root),
            stdout=log_fh,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            env=env,
        )

    final_state = "done"
    while True:
        await asyncio.sleep(2)
        pipeline_status = _read_status_json(work_dir)

        if pipeline_status:
            ps = pipeline_status.get("state", "RUNNING").upper()
            stage_num = pipeline_status.get("stage_num", 0)
            stage_total = pipeline_status.get("stage_total", 9)
            stage_label = pipeline_status.get("stage_label", "")

            if ps == "PAUSED":
                await _update_job(
                    job_id,
                    state="paused",
                    stage_num=stage_num,
                    stage_total=stage_total,
                    stage_label=stage_label,
                )
                final_state = "paused"
                break
            if ps == "STOPPED":
                await _update_job(
                    job_id,
                    state="error",
                    stage_num=stage_num,
                    stage_total=stage_total,
                    stage_label=stage_label,
                    error_msg=pipeline_status.get("details", "Pipeline stopped before completion."),
                )
                final_state = "error"
                break
            if ps in ("DONE", "FINISHED"):
                await _update_job(job_id, state="done", stage_num=stage_total, stage_label="Complete")
                final_state = "done"
                break
            if ps == "ERROR":
                await _update_job(
                    job_id,
                    state="error",
                    stage_num=stage_num,
                    stage_label=stage_label,
                    error_msg=pipeline_status.get("details", "Pipeline error"),
                )
                final_state = "error"
                break

            await _update_job(
                job_id,
                stage_num=stage_num,
                stage_total=stage_total,
                stage_label=stage_label,
            )

        if proc.poll() is not None:
            pipeline_status = _read_status_json(work_dir)
            rc = proc.returncode
            status_state = pipeline_status.get("state", "").upper() if pipeline_status else ""
            if pipeline_status and status_state == "PAUSED":
                await _update_job(
                    job_id,
                    state="paused",
                    stage_num=pipeline_status.get("stage_num", 0),
                    stage_label=pipeline_status.get("stage_label", ""),
                )
                final_state = "paused"
            elif pipeline_status and status_state == "STOPPED":
                await _update_job(
                    job_id,
                    state="error",
                    stage_num=pipeline_status.get("stage_num", 0),
                    stage_label=pipeline_status.get("stage_label", ""),
                    error_msg=pipeline_status.get("details", "Pipeline stopped before completion."),
                )
                final_state = "error"
            elif rc == 0:
                await _update_job(
                    job_id,
                    state="done",
                    stage_num=pipeline_status.get("stage_total", 9) if pipeline_status else 9,
                    stage_total=pipeline_status.get("stage_total", 9) if pipeline_status else 9,
                    stage_label="Complete",
                )
                final_state = "done"
            else:
                await _update_job(job_id, state="error", error_msg=f"Pipeline exited with code {rc}")
                final_state = "error"
            break

    return {"state": final_state, "job_id": job_id}


def _write_runtime_config(job_id: str) -> Path:
    current_settings = get_settings()
    provider = current_settings.active_provider()
    anthropic_api_key = current_settings.effective_anthropic_api_key()
    config = {
        "pipeline": {
            "max_outline_iterations": 1,
            "max_spec_validation_iterations": 3,
            "default_open_nodes": 5,
            "descendant_shell_count": 5,
            "efficient_llm": current_settings.latex_to_lean_efficient_llm,
        },
        "claude": {
            "cli_path": "claude",
            "permission_mode": "bypassPermissions",
            "provider": provider,
            "subscription": {"model": "opus"},
            "api_key": {
                "model": current_settings.effective_claude_model(),
                "key": "",
                "base_url": current_settings.effective_anthropic_base_url(),
            },
            "bedrock": {
                "model": current_settings.bedrock_model,
                "aws_profile": current_settings.aws_profile,
            },
        },
    }
    cfg_path = current_settings.job_dir(job_id) / "runtime_config.yaml"
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    with open(cfg_path, "w", encoding="utf-8") as f:
        yaml.safe_dump(config, f, sort_keys=False)
    return cfg_path


def _credential_preflight_error() -> str:
    current_settings = get_settings()
    provider = current_settings.active_provider()
    if provider == "api_key" and not current_settings.effective_anthropic_api_key():
        return (
            "Anthropic API key is not configured. Add it in Dev Settings or set "
            "ANTHROPIC_API_KEY before starting the pipeline."
        )
    if provider == "bedrock" and not current_settings.aws_profile:
        return "AWS Bedrock provider is configured, but AWS_PROFILE is not set."
    return ""


def _build_env() -> dict:
    current_settings = get_settings()
    env = os.environ.copy()
    anthropic_api_key = current_settings.effective_anthropic_api_key()
    if anthropic_api_key:
        env["ANTHROPIC_AUTH_TOKEN"] = anthropic_api_key
        env["ANTHROPIC_API_KEY"] = anthropic_api_key
    model = current_settings.effective_claude_model()
    env["ANTHROPIC_MODEL"] = model
    env.setdefault("ANTHROPIC_DEFAULT_SONNET_MODEL", model)
    env.setdefault("ANTHROPIC_DEFAULT_OPUS_MODEL", "claude-opus-4-8")
    env.setdefault("ANTHROPIC_DEFAULT_HAIKU_MODEL", "claude-haiku-4-5")
    env["CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"] = "1"
    env["DISABLE_TELEMETRY"] = "1"
    anthropic_base_url = current_settings.effective_anthropic_base_url()
    if anthropic_base_url:
        env["ANTHROPIC_BASE_URL"] = anthropic_base_url
    if current_settings.aws_profile:
        env["AWS_PROFILE"] = current_settings.aws_profile
        env["CLAUDE_CODE_USE_BEDROCK"] = "1"
    if current_settings.latex_to_lean_dry_run:
        env["LATEX_TO_LEAN_DRY_RUN"] = "1"
    return env


def _read_status_json(work_dir: str) -> dict | None:
    path = Path(work_dir) / "job_status.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


async def _update_job(job_id: str, **kwargs) -> None:
    async with SessionLocal() as db:
        await db.execute(
            update(Job)
            .where(Job.id == job_id)
            .values(updated_at=datetime.now(timezone.utc), **kwargs)
        )
        await db.commit()
