from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import get_settings
from .deps import get_db
from .models import Job, Project
from .schemas import JobRead, ProjectCreate, ProjectDetail, ProjectRead

router = APIRouter(prefix="/projects", tags=["projects"])
settings = get_settings()


def _problem_slug(chapter: int, theorem_label: str) -> str:
    clean = theorem_label.strip()
    if clean:
        return f"ch{chapter}_{clean.replace(':', '_').replace(' ', '_')}"
    return f"ch{chapter}_theorem"


@router.post("", response_model=ProjectRead, status_code=status.HTTP_201_CREATED)
async def create_project(
    payload: ProjectCreate,
    db: AsyncSession = Depends(get_db),
):
    project = Project(
        name=payload.name,
        latex_content=payload.latex_content,
        chapter=payload.chapter,
        theorem_label=payload.theorem_label,
    )
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return project


@router.get("", response_model=list[ProjectRead])
async def list_projects(
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Project)
        .order_by(Project.created_at.desc())
    )
    return result.scalars().all()


@router.get("/{project_id}", response_model=ProjectDetail)
async def get_project(
    project_id: str,
    db: AsyncSession = Depends(get_db),
):
    project = await _get_owned_project(project_id, db)
    return project


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: str,
    db: AsyncSession = Depends(get_db),
):
    project = await _get_owned_project(project_id, db)
    await db.delete(project)
    await db.commit()


@router.get("/{project_id}/jobs", response_model=list[JobRead])
async def list_jobs(
    project_id: str,
    db: AsyncSession = Depends(get_db),
):
    await _get_owned_project(project_id, db)
    result = await db.execute(
        select(Job)
        .where(Job.project_id == project_id)
        .order_by(Job.created_at.desc())
    )
    return result.scalars().all()


@router.post("/{project_id}/jobs", response_model=JobRead, status_code=status.HTTP_201_CREATED)
async def start_job(
    project_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Create a new pipeline job for this project and enqueue it."""
    from .local_runner import enqueue_pipeline_job  # avoid circular at import time

    project = await _get_owned_project(project_id, db)

    job = Job(project_id=project.id)
    db.add(job)
    await db.flush()  # populate job.id before computing paths

    # Pre-compute the work_dir so artifact endpoints work before the pipeline
    # creates the directory.
    slug = _problem_slug(project.chapter, project.theorem_label)
    output_dir = settings.job_dir(job.id) / "output"
    job.work_dir = str(output_dir / "benchmark_work" / slug)

    # Write LaTeX content to the input directory.
    input_dir = settings.job_dir(job.id) / "input"
    input_dir.mkdir(parents=True, exist_ok=True)
    chapter_file = input_dir / f"ch{project.chapter}.txt"
    chapter_file.write_text(project.latex_content, encoding="utf-8")

    await db.commit()
    await db.refresh(job)

    await enqueue_pipeline_job(job.id)
    return job


# ── Internal helper ───────────────────────────────────────────────────────────

async def _get_owned_project(project_id: str, db: AsyncSession) -> Project:
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project
