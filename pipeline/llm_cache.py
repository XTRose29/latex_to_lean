"""Cache and artifact helpers for Claude calls.

The pipeline's Claude prompts often write JSON/Lean files as side effects.
This module caches both the model response and declared output file snapshots
so repeated runs with the same input hash can restore those files without
calling Claude again.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def make_input_hash(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def run_id_from_env() -> str:
    run_id = os.environ.get("LATEX_TO_LEAN_RUN_ID", "").strip()
    if run_id:
        return _safe_name(run_id)
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def call_slug(call_name: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_.-]+", "_", call_name.strip()).strip("_")
    return slug or "claude_call"


def call_payload(
    claude_opts: dict[str, Any],
    prompt: str,
    call_name: str,
    tools: list | None,
    instructions: str | None,
    expected_outputs: list[str] | None,
) -> dict[str, Any]:
    tool_names = []
    for tool in tools or []:
        tool_names.append(getattr(tool, "__name__", getattr(tool, "name", str(tool))))
    return {
        "call_name": call_name,
        "model": claude_opts.get("model", ""),
        "prompt": prompt,
        "tools": sorted(tool_names),
        "instructions": instructions or "",
        "expected_outputs": sorted(expected_outputs or []),
    }


def get_cache_dir(run_id: str, call_name: str, digest: str) -> Path:
    return Path("runs") / _safe_name(run_id) / "llm_calls" / f"{call_slug(call_name)}_{digest[:16]}"


def find_valid_cache(call_name: str, digest: str, expected_outputs: list[str] | None) -> dict[str, Any] | None:
    pattern = str(Path("runs") / "*" / "llm_calls" / f"{call_slug(call_name)}_{digest[:16]}" / "artifact.json")
    for artifact_file in sorted(Path().glob(pattern)):
        try:
            artifact = json.loads(artifact_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if artifact.get("input_hash") != digest:
            continue
        snapshots = artifact.get("output_snapshots", [])
        expected = expected_outputs or []
        if expected and not snapshots:
            continue
        return artifact
    return None


def restore_cached_outputs(artifact: dict[str, Any]) -> None:
    for snapshot in artifact.get("output_snapshots", []):
        source = Path(snapshot["snapshot_path"])
        target = Path(snapshot["target_path"])
        if source.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)


def cached_response_text(artifact: dict[str, Any]) -> str:
    response_path = Path(artifact.get("response_path", ""))
    if response_path.exists():
        return response_path.read_text(encoding="utf-8")
    parsed_path = Path(artifact.get("parsed_path", ""))
    if parsed_path.exists():
        return parsed_path.read_text(encoding="utf-8")
    return json.dumps({"cache_hit": True, "source": artifact.get("source", "cache")}, indent=2)


def write_artifact(
    cache_dir: Path,
    payload: dict[str, Any],
    digest: str,
    response_text: str,
    token_usage: dict[str, int],
    expected_outputs: list[str] | None,
    *,
    api_called: bool,
    cache_hit: bool,
    source: str,
) -> dict[str, Any]:
    cache_dir.mkdir(parents=True, exist_ok=True)
    prompt_path = cache_dir / "prompt.json"
    response_path = cache_dir / "response.txt"
    parsed_path = cache_dir / "parsed.json"
    prompt_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    response_path.write_text(response_text, encoding="utf-8")
    parsed_json = _parsed_json(response_text, expected_outputs)
    parsed_path.write_text(json.dumps(parsed_json, indent=2, sort_keys=True), encoding="utf-8")
    snapshots = _snapshot_outputs(cache_dir, expected_outputs)
    artifact = {
        "input_hash": digest,
        "call_name": payload["call_name"],
        "model": payload.get("model", ""),
        "created_at": utc_now(),
        "prompt_path": str(prompt_path),
        "response_path": str(response_path),
        "parsed_path": str(parsed_path),
        "token_usage": token_usage,
        "api_called": api_called,
        "cache_hit": cache_hit,
        "source": source,
        "output_snapshots": snapshots,
    }
    (cache_dir / "artifact.json").write_text(json.dumps(artifact, indent=2, sort_keys=True), encoding="utf-8")
    return artifact


def write_mock_artifact(cache_dir: Path, payload: dict[str, Any], digest: str, expected_outputs: list[str] | None) -> dict[str, Any]:
    response = {
        "mock": True,
        "message": "Dry-run/mock mode: Claude was not called.",
        "call_name": payload["call_name"],
    }
    for output in expected_outputs or []:
        path = Path(output)
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.suffix == ".json" and not path.exists():
            path.write_text(json.dumps(_mock_json_for_output(path), indent=2), encoding="utf-8")
        elif not path.exists():
            path.write_text("Dry-run/mock artifact. Claude was not called.\n", encoding="utf-8")
    return write_artifact(
        cache_dir,
        payload,
        digest,
        json.dumps(response, indent=2),
        {"input_tokens": 0, "output_tokens": 0},
        expected_outputs,
        api_called=False,
        cache_hit=False,
        source="mock",
    )


def _parsed_json(response_text: str, expected_outputs: list[str] | None) -> dict[str, Any]:
    try:
        parsed = json.loads(response_text)
        if isinstance(parsed, dict):
            return parsed
        return {"response_json": parsed}
    except json.JSONDecodeError:
        pass
    for output in expected_outputs or []:
        path = Path(output)
        if path.suffix == ".json" and path.exists():
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
    return {"raw_text": response_text}


def _snapshot_outputs(cache_dir: Path, expected_outputs: list[str] | None) -> list[dict[str, str]]:
    snapshots: list[dict[str, str]] = []
    snapshot_dir = cache_dir / "outputs"
    for output in expected_outputs or []:
        path = Path(output)
        if not path.exists() or not path.is_file():
            continue
        snapshot_dir.mkdir(parents=True, exist_ok=True)
        snapshot_path = snapshot_dir / _safe_name(str(path))
        shutil.copy2(path, snapshot_path)
        snapshots.append({"target_path": str(path), "snapshot_path": str(snapshot_path)})
    return snapshots


def _mock_json_for_output(path: Path) -> dict[str, Any]:
    name = path.name
    if name == "skeleton.json":
        return {
            "problem_id": "mock_problem",
            "steps": [
                {
                    "id": "step_1",
                    "statement": "Mock decomposition node produced without Claude.",
                    "proof_intent": "Dry-run placeholder.",
                    "depends_on": [],
                }
            ],
        }
    if name in {"skeleton_mathlib_check.json", "mathlib_map.json"}:
        return {"method": "deterministic_or_mock", "nodes": []}
    if name == "outline.json":
        return {
            "problem_id": "mock_problem",
            "main_target": "step_1",
            "nodes": [
                {
                    "name": "step_1",
                    "type": "theorem",
                    "inputs": [],
                    "natural": "Mock benchmark target.",
                    "formal_stub": "theorem mock_target : True := by sorry",
                }
            ],
        }
    return {"mock": True, "path": str(path)}


def _safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", value).strip("_") or "artifact"
