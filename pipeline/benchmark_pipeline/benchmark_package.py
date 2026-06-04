"""
Benchmark packaging utilities.

Assembles all generated outline pipeline artifacts into a clean, self-contained
benchmark directory that a downstream model runner can consume.
"""

import json
import os
import shutil
from datetime import datetime, timezone
from typing import Optional


# ---------------------------------------------------------------------------
# Directory layout
# ---------------------------------------------------------------------------

BENCHMARK_LAYOUT = {
    "source": ["problem_packet.json", "theorem_quote.txt", "proof_text.txt"],
    "outline": ["skeleton.json", "outline.json", "mathlib_map.json"],
    "profiles": [],          # populated dynamically from assumption_profile.json
    "blueprint": [
        "problem_blueprint.lean",
        "problem_blueprint.json",
        "problem_graph.mmd",
    ],
    "validation": [
        "spec_validation_report.json",
        "spec_validation_report.md",
        "descendant_shells.lean",
    ],
    "prompts": ["benchmark_formalize_prompt.md"],
}


# ---------------------------------------------------------------------------
# Packaging
# ---------------------------------------------------------------------------

def package_benchmark(
    problem_id: str,
    working_dir: str,
    output_base: str,
    profiles: Optional[list[str]] = None,
) -> dict:
    """
    Assemble all artifacts from `working_dir` into
    `output_base/benchmarks/<problem_id>/`.

    Returns a summary dict describing what was found/missing.
    """
    dest_root = os.path.join(output_base, "benchmarks", problem_id)
    os.makedirs(dest_root, exist_ok=True)

    missing: list[str] = []
    copied: list[str] = []

    # Copy structured directories
    for subdir, files in BENCHMARK_LAYOUT.items():
        dest_subdir = os.path.join(dest_root, subdir)
        src_subdir = os.path.join(working_dir, subdir)
        os.makedirs(dest_subdir, exist_ok=True)

        for fname in files:
            src = os.path.join(src_subdir, fname)
            dst = os.path.join(dest_subdir, fname)
            if os.path.exists(src):
                shutil.copy2(src, dst)
                copied.append(os.path.join(subdir, fname))
            else:
                missing.append(os.path.join(subdir, fname))

        if subdir == "blueprint" and os.path.isdir(src_subdir):
            for fname in sorted(os.listdir(src_subdir)):
                if fname.endswith("_benchmark_question.lean"):
                    src = os.path.join(src_subdir, fname)
                    dst = os.path.join(dest_subdir, fname)
                    shutil.copy2(src, dst)
                    copied.append(os.path.join(subdir, fname))

    # Write derived source files (theorem_quote.txt, proof_text.txt)
    packet_path = os.path.join(dest_root, "source", "problem_packet.json")
    if os.path.exists(packet_path):
        with open(packet_path) as f:
            packet = json.load(f)

        quote_path = os.path.join(dest_root, "source", "theorem_quote.txt")
        with open(quote_path, "w") as f:
            f.write(packet.get("latex_quote", ""))
        copied.append("source/theorem_quote.txt")

        proof_path = os.path.join(dest_root, "source", "proof_text.txt")
        with open(proof_path, "w") as f:
            f.write(packet.get("proof_text", ""))
        copied.append("source/proof_text.txt")

    # Write per-profile JSON files
    profile_src = os.path.join(working_dir, "outline", "assumption_profile.json")
    if os.path.exists(profile_src):
        with open(profile_src) as f:
            profile_data = json.load(f)

        all_profiles = profile_data.get("profiles", [])
        dest_profiles_dir = os.path.join(dest_root, "profiles")
        os.makedirs(dest_profiles_dir, exist_ok=True)

        for prof in all_profiles:
            pname = prof.get("name", "unnamed")
            if profiles and pname not in profiles:
                continue
            prof_path = os.path.join(dest_profiles_dir, f"{pname}.json")
            with open(prof_path, "w") as f:
                json.dump(prof, f, indent=2)
            copied.append(f"profiles/{pname}.json")

    # Write benchmark summary
    summary = _build_summary(problem_id, dest_root, copied, missing)
    summary_path = os.path.join(dest_root, "benchmark_summary.json")
    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2)

    return summary


def _build_summary(
    problem_id: str,
    dest_root: str,
    copied: list[str],
    missing: list[str],
) -> dict:
    """Build the benchmark_summary.json metadata object."""
    summary: dict = {
        "problem_id": problem_id,
        "packaged_at": datetime.now(timezone.utc).isoformat(),
        "theorem_label": "",
        "natural_statement": "",
        "total_nodes": 0,
        "open_nodes_by_profile": {},
        "assumed_nodes_by_profile": {},
        "build_validated": False,
        "spec_verdict": "UNKNOWN",
        "files_copied": sorted(copied),
        "files_missing": sorted(missing),
    }

    # Read problem packet for theorem info
    packet_path = os.path.join(dest_root, "source", "problem_packet.json")
    if os.path.exists(packet_path):
        with open(packet_path) as f:
            packet = json.load(f)
        summary["theorem_label"] = packet.get("theorem_label", "")
        summary["natural_statement"] = packet.get("natural_statement", "")

    # Read outline for node counts
    outline_path = os.path.join(dest_root, "outline", "outline.json")
    if os.path.exists(outline_path):
        with open(outline_path) as f:
            outline = json.load(f)
        summary["total_nodes"] = len(outline.get("nodes", []))

    # Read profiles directory for open/assumed counts
    profiles_dir = os.path.join(dest_root, "profiles")
    if os.path.isdir(profiles_dir):
        for fname in os.listdir(profiles_dir):
            if fname.endswith(".json"):
                pname = fname[:-5]
                with open(os.path.join(profiles_dir, fname)) as f:
                    prof = json.load(f)
                summary["open_nodes_by_profile"][pname] = len(prof.get("open_nodes", []))
                summary["assumed_nodes_by_profile"][pname] = len(prof.get("assumed_nodes", []))

    # Read validation report
    report_path = os.path.join(dest_root, "validation", "spec_validation_report.json")
    if os.path.exists(report_path):
        with open(report_path) as f:
            report = json.load(f)
        summary["build_validated"] = report.get("build_passed", False)
        summary["spec_verdict"] = report.get("verdict", "UNKNOWN")

    return summary


# ---------------------------------------------------------------------------
# Model-facing prompt generator
# ---------------------------------------------------------------------------

def generate_model_prompt(
    problem_id: str,
    dest_root: str,
    default_profile: str = "",
) -> str:
    """
    Generate a model-facing formalization prompt for a benchmark.

    Uses the first human-authored profile found in the profiles/ directory
    (or the profile named by `default_profile` if provided and present).

    Returns the prompt text (also writes it to prompts/benchmark_formalize_prompt.md).
    """
    # Load outline and profile
    outline_path = os.path.join(dest_root, "outline", "outline.json")

    # Resolve which profile file to use.
    profile_path = ""
    profiles_dir = os.path.join(dest_root, "profiles")
    if default_profile:
        candidate = os.path.join(profiles_dir, f"{default_profile}.json")
        if os.path.exists(candidate):
            profile_path = candidate

    if not profile_path and os.path.isdir(profiles_dir):
        # Use the first available profile (alphabetically stable).
        available = sorted(f[:-5] for f in os.listdir(profiles_dir) if f.endswith(".json"))
        if available:
            default_profile = available[0]
            profile_path = os.path.join(profiles_dir, f"{default_profile}.json")

    outline: dict = {}
    profile: dict = {}

    if os.path.exists(outline_path):
        with open(outline_path) as f:
            outline = json.load(f)
    if os.path.exists(profile_path):
        with open(profile_path) as f:
            profile = json.load(f)

    node_map = {n["name"]: n for n in outline.get("nodes", [])}
    open_nodes = profile.get("open_nodes", [])
    assumed_nodes = profile.get("assumed_nodes", [])

    # Read natural statement from problem packet
    natural_statement = ""
    packet_path = os.path.join(dest_root, "source", "problem_packet.json")
    if os.path.exists(packet_path):
        with open(packet_path) as f:
            packet = json.load(f)
        natural_statement = packet.get("natural_statement", "")

    # Build open nodes section
    open_section_lines = []
    for name in open_nodes:
        n = node_map.get(name, {})
        nat = n.get("natural", "")
        open_section_lines.append(f"- **{name}**: {nat}")
    open_section = "\n".join(open_section_lines) if open_section_lines else "(none)"

    # Build assumed nodes section
    assumed_section_lines = []
    for name in assumed_nodes:
        n = node_map.get(name, {})
        nat = n.get("natural", "")
        assumed_section_lines.append(f"- **{name}**: {nat}")
    assumed_section = "\n".join(assumed_section_lines) if assumed_section_lines else "(none)"

    # Build confirmed mathlib section from mathlib_map.json
    mathlib_map_path = os.path.join(dest_root, "outline", "mathlib_map.json")
    mathlib_section = "(none)"
    if os.path.exists(mathlib_map_path):
        try:
            with open(mathlib_map_path) as f:
                mathlib_map = json.load(f)
            mathlib_lines = []
            for entry in mathlib_map.get("nodes", []):
                if entry.get("classification") == "existing":
                    node_name = entry.get("name", "")
                    candidates = entry.get("candidate_lemmas", [])
                    notes = entry.get("notes", "")
                    lemma_str = ", ".join(f"`{l}`" for l in candidates) if candidates else "(see notes)"
                    line = f"- **{node_name}**: {lemma_str}"
                    if notes:
                        line += f" — {notes}"
                    mathlib_lines.append(line)
            if mathlib_lines:
                mathlib_section = "\n".join(mathlib_lines)
        except (json.JSONDecodeError, IOError):
            pass

    prompt = f"""# Benchmark: {problem_id}

## Overview

This benchmark asks you to formalize one open proof node from a structured Lean blueprint.

The blueprint represents: {natural_statement}

## Profile

This task uses the `{default_profile}` profile.

**Open nodes** (your proof targets — these are `:= by sorry` in the blueprint):
{open_section}

**Assumed background facts** (already defined as `def NodeName : Prop := ...`):
{assumed_section}

## Confirmed Mathlib Results

The following nodes have been verified as exact matches in Mathlib. You can use
these lemmas directly rather than re-proving them:

{mathlib_section}

## Files

- Blueprint: `blueprint/problem_blueprint.lean`
- Outline: `outline/outline.json`
- Original proof text: `source/proof_text.txt`
- Original theorem: `source/theorem_quote.txt`
- Mathlib map: `outline/mathlib_map.json`

## Instructions

1. Read `blueprint/problem_blueprint.lean` to understand the full dependency structure.
2. Read `source/proof_text.txt` for the human proof you are formalizing.
3. Read `outline/mathlib_map.json` to see which nodes have confirmed mathlib counterparts.
4. Choose ONE open theorem node from the list above.
5. Replace its `by sorry` body with a complete Lean 4 proof.
6. You may use any assumed node as a hypothesis (it is available as a `def` Prop declaration).
7. You may use mathlib. Use `loogle_search` to find relevant lemmas by type pattern.
8. Do NOT modify any other theorem node's statement or body.
9. This local app uses Python-only Lean-shape checks by default. Run a real
   Lean/Lake build separately if you need typechecking.

## Rules

- Fill in the body of EXACTLY ONE theorem node per run.
- Do not replace `sorry` in any theorem you were not assigned.
- Do not modify assumption or definition nodes.
- Do not change any theorem statement.
- Python-only checks validate file shape and `by sorry` placement. They do not
  prove that imports resolve or statements elaborate in Lean.
"""

    # Write to file
    prompts_dir = os.path.join(dest_root, "prompts")
    os.makedirs(prompts_dir, exist_ok=True)
    prompt_path = os.path.join(prompts_dir, "benchmark_formalize_prompt.md")
    with open(prompt_path, "w") as f:
        f.write(prompt)

    return prompt
