from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict


# ── Projects ─────────────────────────────────────────────────────────────────

class ProjectCreate(BaseModel):
    name: str
    latex_content: str
    chapter: int = 1
    theorem_label: str = ""


class ProjectRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    chapter: int
    theorem_label: str
    created_at: datetime


class ProjectDetail(ProjectRead):
    latex_content: str


# ── Jobs ─────────────────────────────────────────────────────────────────────

class JobRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    project_id: str
    state: str
    stage_num: int
    stage_total: int
    stage_label: str
    error_msg: str
    created_at: datetime
    updated_at: datetime


class JobStatus(BaseModel):
    """Structured status read from job_status.json written by PipelineLogger."""

    state: str
    stage_label: str
    stage_num: int
    stage_total: int
    details: str
    chapter: int
    phase: str
    pid: int
    started_at: str
    updated_at: str
    history: list[dict]


# ── Edited graph types (Stage 4 graph editor) ────────────────────────────────

class ValidationNote(BaseModel):
    id: str
    title: str
    description: str = ""
    status: Literal["pending", "pass", "fail"] = "pending"


class EditedNode(BaseModel):
    id: str
    category: Literal["theorem", "definition", "hypothesis"] = "theorem"
    label: str = ""
    statement: str = ""
    proof_intent: str = ""
    depends_on: list[str] = []
    role: Literal["unset", "hypothesis", "open", "target"] = "unset"
    is_manual: bool = False
    validation_notes: list[ValidationNote] = []


class EditedEdge(BaseModel):
    id: str
    source: str
    target: str
    is_manual: bool = False


class EditedGraph(BaseModel):
    problem_id: str = ""
    nodes: list[EditedNode] = []
    edges: list[EditedEdge] = []


# ── Profile submission (Stage 4 → Stage 5 gate) ───────────────────────────────

class ProfileSubmit(BaseModel):
    profile_name: str = "profile_1"
    selected_target: str
    assumed_nodes: list[str]
    open_nodes: list[str]
    edited_graph: EditedGraph | None = None
