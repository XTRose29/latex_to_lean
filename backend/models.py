from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Project ───────────────────────────────────────────────────────────────────

class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    latex_content: Mapped[str] = mapped_column(Text, nullable=False)
    chapter: Mapped[int] = mapped_column(Integer, default=1)
    theorem_label: Mapped[str] = mapped_column(String(255), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    jobs: Mapped[list[Job]] = relationship(
        "Job",
        back_populates="project",
        cascade="all, delete-orphan",
        order_by="Job.created_at.desc()",
    )


# ── Job ───────────────────────────────────────────────────────────────────────
# State machine: pending → running → paused → running → done
#                                           ↘ error

class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("projects.id"), nullable=False, index=True
    )

    # State: pending | running | paused | done | error
    state: Mapped[str] = mapped_column(String(32), default="pending", nullable=False, index=True)
    stage_num: Mapped[int] = mapped_column(Integer, default=0)
    stage_total: Mapped[int] = mapped_column(Integer, default=9)
    stage_label: Mapped[str] = mapped_column(String(255), default="")

    # Absolute path to benchmark_work/{problem_slug}/ inside the job data dir.
    # Pre-computed at job creation so artifact endpoints can use it immediately.
    work_dir: Mapped[str] = mapped_column(String(1024), default="")
    error_msg: Mapped[str] = mapped_column(Text, default="")

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )

    project: Mapped[Project] = relationship("Project", back_populates="jobs")
