from __future__ import annotations

import json
import re
import shutil
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import get_settings
from .deps import get_db

settings = get_settings()
from .models import Job, Project
from .schemas import JobRead, JobStatus, ProfileSubmit, EditedGraph

router = APIRouter(prefix="/jobs", tags=["jobs"])
settings = get_settings()

# Artifact name → path relative to work_dir
_ARTIFACT_MAP: dict[str, str] = {
    "problem_packet": "source/problem_packet.json",
    "skeleton": "outline/skeleton.json",
    "mathlib_check": "outline/skeleton_mathlib_check.json",
    "assumption_profile": "outline/assumption_profile.json",
    "outline": "outline/outline.json",
    "mathlib_map": "outline/mathlib_map.json",
    "graph_diff": "outline/graph_diff.json",
    "blueprint": "blueprint/problem_blueprint.json",
    "spec_report": "validation/spec_validation_report.json",
    "edited_graph": "outline/edited_graph.json",
}

_RAW_ARTIFACT_MAP: dict[str, tuple[str, str, str]] = {
    "blueprint_lean": ("blueprint/problem_blueprint.lean", "text/plain", "problem_blueprint.lean"),
}


def _normalize_status_timestamp(value: str | None) -> str | None:
    """Return an ISO 8601 timestamp with offset for both new and legacy files."""
    if not value:
        return value

    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        try:
            dt = datetime.strptime(value, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            return value
        dt = dt.astimezone()
    else:
        if dt.tzinfo is None:
            dt = dt.astimezone()

    return dt.isoformat(timespec="seconds")


def _coerce_pipeline_status(data: dict) -> dict:
    """Map internal pipeline states into the API state enum."""
    state = str(data.get("state", "")).upper()
    if state == "STOPPED":
        data["state"] = "ERROR"
        data["details"] = data.get("details") or "Pipeline stopped before completion."
    elif state == "FINISHED":
        data["state"] = "DONE"
    return data


# ── Read endpoints ────────────────────────────────────────────────────────────

@router.get("/{job_id}", response_model=JobRead)
async def get_job(
    job_id: str,
    db: AsyncSession = Depends(get_db),
):
    return await _get_owned_job(job_id, db)


@router.get("/{job_id}/status", response_model=JobStatus)
async def get_job_status(
    job_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Return the structured job_status.json written by PipelineLogger."""
    job = await _get_owned_job(job_id, db)
    status_path = Path(job.work_dir) / "job_status.json"
    if job.state in {"done", "error"}:
        history = []
        if status_path.exists():
            try:
                history = json.loads(status_path.read_text()).get("history", [])
            except (json.JSONDecodeError, TypeError, OSError):
                history = []
        return JobStatus(
            state=job.state.upper(),
            stage_label=job.stage_label or ("Complete" if job.state == "done" else "Error"),
            stage_num=job.stage_num or (job.stage_total if job.state == "done" else 0),
            stage_total=job.stage_total,
            details=job.error_msg if job.state == "error" else "Benchmark complete.",
            chapter=0,
            phase="",
            pid=0,
            started_at=job.created_at.isoformat(),
            updated_at=job.updated_at.isoformat(),
            history=history,
        )

    if status_path.exists():
        try:
            data = json.loads(status_path.read_text())
            data = _coerce_pipeline_status(data)
            data["started_at"] = _normalize_status_timestamp(data.get("started_at"))
            data["updated_at"] = _normalize_status_timestamp(data.get("updated_at"))
            return JobStatus(**data)
        except (json.JSONDecodeError, TypeError):
            raise HTTPException(status_code=500, detail="Corrupt job_status.json")

    if not status_path.exists():
        # Job hasn't reached Stage 1 yet — return a synthetic pending status.
        return JobStatus(
            state=job.state.upper(),
            stage_label=job.stage_label or "Waiting to start",
            stage_num=job.stage_num,
            stage_total=job.stage_total,
            details="",
            chapter=0,
            phase="",
            pid=0,
            started_at=job.created_at.isoformat(),
            updated_at=job.updated_at.isoformat(),
            history=[],
        )
    raise HTTPException(status_code=500, detail="Could not read job status")


@router.get("/{job_id}/log", response_class=PlainTextResponse)
async def get_job_log(
    job_id: str,
    lines: int = 200,
    db: AsyncSession = Depends(get_db),
):
    """Tail the pipeline log. Checks AUTO_RUN_LOG.txt then pipeline.log fallback."""
    job = await _get_owned_job(job_id, db)
    # Pipeline writes AUTO_RUN_LOG.txt inside work_dir; local runner writes pipeline.log in job_dir.
    candidates = [
        settings.job_dir(job_id) / "pipeline.log",
        Path(job.work_dir) / "AUTO_RUN_LOG.txt",
    ]
    for log_path in candidates:
        if log_path.exists():
            all_lines = log_path.read_text(errors="ignore").splitlines()
            return "\n".join(all_lines[-lines:])
    return ""


@router.get("/{job_id}/tokens")
async def get_job_tokens(
    job_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Return running token totals from token_usage.json written by TokenTracker."""
    await _get_owned_job(job_id, db)
    token_path = settings.job_dir(job_id) / "output" / "token_usage.json"
    if not token_path.exists():
        return {"total_input_tokens": 0, "total_output_tokens": 0, "total_tokens": 0, "model": ""}
    try:
        data = json.loads(token_path.read_text())
        return {
            "total_input_tokens": data.get("total_input_tokens", 0),
            "total_output_tokens": data.get("total_output_tokens", 0),
            "total_tokens": data.get("total_tokens", 0),
            "model": data.get("model", ""),
        }
    except (json.JSONDecodeError, OSError):
        return {"total_input_tokens": 0, "total_output_tokens": 0, "total_tokens": 0, "model": ""}


@router.get("/{job_id}/artifacts/{artifact_name}")
async def get_artifact(
    job_id: str,
    artifact_name: str,
    db: AsyncSession = Depends(get_db),
):
    """Serve a named pipeline artifact as JSON."""
    if artifact_name not in _ARTIFACT_MAP:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown artifact '{artifact_name}'. Valid names: {list(_ARTIFACT_MAP)}",
        )
    job = await _get_owned_job(job_id, db)
    artifact_path = Path(job.work_dir) / _ARTIFACT_MAP[artifact_name]
    if not artifact_path.exists():
        raise HTTPException(status_code=404, detail=f"Artifact '{artifact_name}' not ready yet")
    try:
        return JSONResponse(content=json.loads(artifact_path.read_text()))
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="Artifact JSON is not yet complete")


@router.get("/{job_id}/artifacts/{artifact_name}/raw")
async def get_raw_artifact(
    job_id: str,
    artifact_name: str,
    download: bool = False,
    db: AsyncSession = Depends(get_db),
):
    """Serve a named text/file artifact for copy or local download."""
    if artifact_name not in _RAW_ARTIFACT_MAP:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown raw artifact '{artifact_name}'. Valid names: {list(_RAW_ARTIFACT_MAP)}",
        )
    job = await _get_owned_job(job_id, db)
    rel_path, media_type, filename = _RAW_ARTIFACT_MAP[artifact_name]
    artifact_path = Path(job.work_dir) / rel_path
    if not artifact_path.exists():
        raise HTTPException(status_code=404, detail=f"Artifact '{artifact_name}' not ready yet")
    if download:
        filename = await _download_filename(job, artifact_name, filename, db)
        return FileResponse(path=artifact_path, media_type=media_type, filename=filename)
    return PlainTextResponse(artifact_path.read_text(encoding="utf-8"), media_type=media_type)


# ── Human-in-the-loop endpoints ───────────────────────────────────────────────

@router.post("/{job_id}/profile", response_model=JobRead)
async def submit_profile(
    job_id: str,
    payload: ProfileSubmit,
    db: AsyncSession = Depends(get_db),
):
    """
    Stage 4 gate: human submits their assumption profile so the pipeline can
    continue from Stage 5.  Writes assumption_profile.json to disk.
    """
    job = await _get_owned_job(job_id, db)
    if job.state not in ("paused", "pending"):
        raise HTTPException(
            status_code=409,
            detail=f"Job is in state '{job.state}', expected 'paused'",
        )

    # Read problem_id from the packet (needed for the profile JSON).
    packet_path = Path(job.work_dir) / "source" / "problem_packet.json"
    problem_id = "unknown_problem"
    if packet_path.exists():
        try:
            problem_id = json.loads(packet_path.read_text()).get("problem_id", problem_id)
        except json.JSONDecodeError:
            pass

    profile_data = {
        "problem_id": problem_id,
        "selected_target": payload.selected_target,
        "profiles": [
            {
                "name": payload.profile_name,
                "selected_target": payload.selected_target,
                "open_nodes": payload.open_nodes,
                "assumed_nodes": payload.assumed_nodes,
                "max_open_nodes": len(payload.open_nodes),
            }
        ],
    }

    profile_path = Path(job.work_dir) / "outline" / "assumption_profile.json"
    profile_path.parent.mkdir(parents=True, exist_ok=True)
    profile_path.write_text(json.dumps(profile_data, indent=2))

    if payload.edited_graph is not None:
        eg_path = Path(job.work_dir) / "outline" / "edited_graph.json"
        eg_path.write_text(payload.edited_graph.model_dump_json(indent=2))

    # Don't change state here — leave as 'paused' so /resume accepts it.
    await db.refresh(job)
    return job


@router.post("/{job_id}/resume", response_model=JobRead)
async def resume_job(
    job_id: str,
    db: AsyncSession = Depends(get_db),
):
    """
    Resume a paused job after the human has submitted their profile.
    The pipeline's file-based resume logic will skip already-completed stages.
    """
    from .local_runner import enqueue_pipeline_job

    job = await _get_owned_job(job_id, db)
    profile_path = Path(job.work_dir) / "outline" / "assumption_profile.json"
    if not profile_path.exists():
        raise HTTPException(
            status_code=409,
            detail="Submit an assumption profile first via POST /jobs/{id}/profile",
        )
    if job.state in ("running", "pending"):
        return job
    if job.state not in ("paused", "error"):
        raise HTTPException(
            status_code=409,
            detail=f"Job is in state '{job.state}'; only paused/error/pending/running jobs can be resumed",
        )

    await enqueue_pipeline_job(job.id)
    job.state = "pending"
    await db.commit()
    await db.refresh(job)
    return job


@router.post("/{job_id}/edit-profile", response_model=JobRead)
async def edit_profile_again(
    job_id: str,
    db: AsyncSession = Depends(get_db),
):
    """
    Reopen the Stage 4 graph/profile editor after a later pause/error/done.

    The expensive upstream artifacts are kept:
    - source/problem_packet.json
    - outline/skeleton.json
    - outline/skeleton_mathlib_check.json
    - outline/assumption_profile.json and outline/edited_graph.json

    Downstream artifacts are cleared so the next resume rebuilds Stage 5+ from
    the edited profile instead of reusing stale graph/map/blueprint files.
    """
    job = await _get_owned_job(job_id, db)
    if job.state in ("running", "pending"):
        raise HTTPException(
            status_code=409,
            detail="Cannot reopen the editor while the pipeline is running.",
        )

    work_dir = Path(job.work_dir)
    if not (work_dir / "outline" / "skeleton.json").exists():
        raise HTTPException(
            status_code=409,
            detail="The natural-language graph is not ready yet.",
        )

    _clear_profile_downstream_artifacts(work_dir)
    _write_profile_pause_status(work_dir, job)

    job.state = "paused"
    job.stage_num = 4
    job.stage_total = 9
    job.stage_label = "4/9 Graph Editing"
    job.error_msg = ""
    await db.commit()
    await db.refresh(job)
    return job


@router.post("/{job_id}/rerun-from-stage/{stage_num}", response_model=JobRead)
async def rerun_from_stage(
    job_id: str,
    stage_num: int,
    db: AsyncSession = Depends(get_db),
):
    """Clear artifacts from a chosen stage onward and restart the local pipeline."""
    from .local_runner import enqueue_pipeline_job

    if stage_num < 1 or stage_num > 9:
        raise HTTPException(status_code=400, detail="stage_num must be between 1 and 9")

    job = await _get_owned_job(job_id, db)
    if job.state in ("running", "pending"):
        raise HTTPException(
            status_code=409,
            detail="Cannot rerun from a previous stage while the pipeline is running.",
        )

    work_dir = Path(job.work_dir)
    _clear_artifacts_from_stage(work_dir, stage_num)

    if stage_num == 4:
        if not (work_dir / "outline" / "skeleton.json").exists():
            raise HTTPException(
                status_code=409,
                detail="The natural-language graph is not ready yet.",
            )
        _write_stage_status(
            work_dir,
            job,
            state="PAUSED",
            stage_num=4,
            stage_label=_stage_label(4),
            details="Edit the graph/profile, then confirm to resume from Stage 5.",
            history_msg="Returned to Stage 4 graph/profile editor",
        )
        job.state = "paused"
        job.stage_num = 4
        job.stage_total = 9
        job.stage_label = _stage_label(4)
        job.error_msg = ""
        await db.commit()
        await db.refresh(job)
        return job

    if stage_num >= 5 and not (work_dir / "outline" / "assumption_profile.json").exists():
        raise HTTPException(
            status_code=409,
            detail="Cannot rerun from Stage 5 or later before an assumption profile exists.",
        )

    _write_stage_status(
        work_dir,
        job,
        state="PENDING",
        stage_num=stage_num,
        stage_label=_stage_label(stage_num),
        details=f"Rerunning from Stage {stage_num}.",
        history_msg=f"Rerun requested from Stage {stage_num}",
    )
    await enqueue_pipeline_job(job.id)
    job.state = "pending"
    job.stage_num = stage_num
    job.stage_total = 9
    job.stage_label = _stage_label(stage_num)
    job.error_msg = ""
    await db.commit()
    await db.refresh(job)
    return job


@router.delete("/{job_id}", status_code=status.HTTP_204_NO_CONTENT)
async def cancel_job(
    job_id: str,
    db: AsyncSession = Depends(get_db),
):
    job = await _get_owned_job(job_id, db)
    if job.state in ("done", "error"):
        raise HTTPException(
            status_code=409, detail="Job is already finished; nothing to cancel"
        )
    job.state = "error"
    job.error_msg = "Cancelled by user"
    await db.commit()


# ── Internal helper ───────────────────────────────────────────────────────────

async def _get_owned_job(job_id: str, db: AsyncSession) -> Job:
    result = await db.execute(select(Job).where(Job.id == job_id))
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


async def _download_filename(
    job: Job,
    artifact_name: str,
    fallback: str,
    db: AsyncSession,
) -> str:
    if artifact_name != "blueprint_lean":
        return fallback
    result = await db.execute(select(Project).where(Project.id == job.project_id))
    project = result.scalar_one_or_none()
    if not project:
        return fallback
    stem = re.sub(r"[^A-Za-z0-9]+", "_", project.name).strip("_").lower()
    if not stem:
        stem = "lean"
    return f"{stem}_benchmark_question.lean"


def _clear_profile_downstream_artifacts(work_dir: Path) -> None:
    """Clear artifacts that depend on the selected profile/roles."""
    files = [
        work_dir / "outline" / "outline.json",
        work_dir / "outline" / "outline_lint.json",
        work_dir / "outline" / "mathlib_map.json",
        work_dir / "outline" / "graph_diff.json",
        work_dir / "blueprint" / "lean_statement_candidates.json",
        work_dir / "blueprint" / "problem_blueprint.json",
        work_dir / "blueprint" / "problem_blueprint.lean",
        work_dir / "blueprint" / "problem_graph.mmd",
        work_dir / "validation" / "benchmark_target_rejection.json",
        work_dir / "validation" / "spec_validation_report.json",
        work_dir / "validation" / "spec_validation_report.md",
        work_dir / "validation" / "descendant_shells.lean",
        work_dir / "validation" / "spec_contracts.json",
    ]
    for path in files:
        try:
            if path.exists():
                path.unlink()
        except OSError:
            pass

    package_root = work_dir.parent.parent / "benchmarks"
    if package_root.exists():
        shutil.rmtree(package_root, ignore_errors=True)


def _clear_artifacts_from_stage(work_dir: Path, stage_num: int) -> None:
    """Delete artifacts that would make the pipeline skip the requested stage."""
    stage_files: dict[int, list[Path]] = {
        1: [
            work_dir / "source" / "problem_packet.json",
        ],
        2: [
            work_dir / "outline" / "skeleton.json",
        ],
        3: [
            work_dir / "outline" / "skeleton_mathlib_check.json",
        ],
        4: [
            work_dir / "outline" / "assumption_profile.json",
            work_dir / "outline" / "edited_graph.json",
        ],
        5: [
            work_dir / "outline" / "outline.json",
            work_dir / "outline" / "outline_lint.json",
            work_dir / "outline" / "graph_diff.json",
        ],
        6: [
            work_dir / "outline" / "mathlib_map.json",
            work_dir / "validation" / "benchmark_target_rejection.json",
        ],
        7: [
            work_dir / "blueprint" / "lean_statement_candidates.json",
            work_dir / "blueprint" / "problem_blueprint.json",
            work_dir / "blueprint" / "problem_blueprint.lean",
            work_dir / "blueprint" / "problem_graph.mmd",
        ],
        8: [
            work_dir / "validation" / "spec_validation_report.json",
            work_dir / "validation" / "spec_validation_report.md",
            work_dir / "validation" / "descendant_shells.lean",
            work_dir / "validation" / "spec_contracts.json",
        ],
        9: [],
    }

    for stage in range(stage_num, 10):
        for path in stage_files.get(stage, []):
            try:
                if path.exists():
                    path.unlink()
            except OSError:
                pass

    blueprint_dir = work_dir / "blueprint"
    if stage_num <= 7 and blueprint_dir.exists():
        for path in blueprint_dir.glob("*_benchmark_question.lean"):
            try:
                path.unlink()
            except OSError:
                pass

    if stage_num <= 9:
        package_root = work_dir.parent.parent / "benchmarks"
        if package_root.exists():
            shutil.rmtree(package_root, ignore_errors=True)


def _write_profile_pause_status(work_dir: Path, job: Job) -> None:
    """Update job_status.json so polling immediately returns to Stage 4."""
    _write_stage_status(
        work_dir,
        job,
        state="PAUSED",
        stage_num=4,
        stage_label="4/9 Graph Editing",
        details="Edit the graph/profile, then confirm to resume from Stage 5.",
        history_msg="Reopened graph/profile editor",
    )


def _write_stage_status(
    work_dir: Path,
    job: Job,
    *,
    state: str,
    stage_num: int,
    stage_label: str,
    details: str,
    history_msg: str,
) -> None:
    """Write job_status.json immediately after manual stage navigation."""
    status_path = work_dir / "job_status.json"
    status_path.parent.mkdir(parents=True, exist_ok=True)
    history = []
    if status_path.exists():
        try:
            history = json.loads(status_path.read_text()).get("history", [])
        except (json.JSONDecodeError, OSError):
            history = []

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    history.append({"time": now, "msg": history_msg})
    status_path.write_text(
        json.dumps(
            {
                "state": state,
                "stage_label": stage_label,
                "stage_num": stage_num,
                "stage_total": 9,
                "details": details,
                "chapter": 0,
                "phase": "manual_stage_navigation",
                "pid": 0,
                "started_at": job.created_at.isoformat(),
                "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
                "history": history[-50:],
            },
            indent=2,
        )
    )


def _stage_label(stage_num: int) -> str:
    labels = {
        1: "1/9 Problem Packet Extraction",
        2: "2/9 Natural-Language Graph",
        3: "3/9 Mathlib Check",
        4: "4/9 Graph Editing",
        5: "5/9 Dependency Graph Construction",
        6: "6/9 Mathlib Mapping",
        7: "7/9 Blueprint Emission",
        8: "8/9 Python Lean Check",
        9: "9/9 Benchmark Packaging",
    }
    return labels.get(stage_num, f"{stage_num}/9 Pipeline Stage")
