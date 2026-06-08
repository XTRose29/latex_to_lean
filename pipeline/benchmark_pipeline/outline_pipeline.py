"""
Outline pipeline orchestrator.

Runs the benchmark specification-building stages for a single theorem extracted
from a LaTeX chapter.

Invoked with:
    python benchmark_pipeline/main.py --input <extracted_latex_dir> \
        --output <output_dir> --theorem <label>

Stages:
    1. Problem packet extraction
    2. Proof skeletonization  (re-skeletonization loop if human requests)
    3. Conservative mathlib verification of skeleton nodes
    4. Human terminal profile selection (no AI; human decides targets & assumptions)
    5. Dependency graph construction
    6. Mathlib mapping
    7. Lean blueprint emission + spec validation loop
    8. Benchmark packaging
"""

import asyncio
import json
import os
import re
import sys

from benchmark_pipeline.graph_lint import lint_outline_graph
from benchmark_pipeline.problem_packet import (
    ProblemPacket,
    SourceSpan,
    find_local_definitions,
    find_proof_after,
    find_theorem_block,
    make_problem_id,
    save_problem_packet,
)

# Maximum number of re-skeletonization attempts before giving up.
_MAX_RESKEL_ATTEMPTS = 3


async def run_outline_pipeline(
    ch: int,
    theorem_label: str,
    project_root: str,
    output_dir: str,
    claude_opts: dict,
    prompts_dir: str,
    evaluation_dir: str,
    config: dict,
    tracker,        # TokenTracker | None
    load_prompt,    # function from claude_pipeline.py
    run_agent,      # async function from claude_pipeline.py
    run_agent_for_verdict,  # async function from claude_pipeline.py
    loogle_search,  # tool from tools.py
    pipeline_logger_cls,
    allow_ui_pause: bool = False,
) -> bool:
    """
    Orchestrate the full benchmark outline pipeline for one theorem.

    Returns True if the pipeline completed successfully (spec verdict DONE),
    False otherwise.
    """
    pipeline_cfg = config.get("pipeline", {})
    max_spec_iters = pipeline_cfg.get("max_spec_validation_iterations", 3)
    efficient_llm = pipeline_cfg.get("efficient_llm", True)

    problem_slug = (
        f"ch{ch}_{theorem_label.replace(':', '_').replace(' ', '_')}"
        if theorem_label
        else f"ch{ch}_theorem"
    )
    benchmark_work_dir = os.path.join(output_dir, "benchmark_work", problem_slug)
    os.makedirs(benchmark_work_dir, exist_ok=True)

    outline_dir = os.path.join(benchmark_work_dir, "outline")
    blueprint_dir = os.path.join(benchmark_work_dir, "blueprint")
    validation_dir = os.path.join(benchmark_work_dir, "validation")
    source_dir = os.path.join(benchmark_work_dir, "source")
    for d in (outline_dir, blueprint_dir, validation_dir, source_dir):
        os.makedirs(d, exist_ok=True)

    raw_data_dir = os.path.join(project_root, "natural_language", "raw_data")
    chapter_text_file = os.path.join(raw_data_dir, f"ch{ch}.txt")
    theorems_and_defs_file = os.path.join(
        raw_data_dir, "theorems_and_defs", f"ch{ch}.txt"
    )

    logger = pipeline_logger_cls(benchmark_work_dir, ch, "Outline Pipeline")

    # -----------------------------------------------------------------
    # Stage 1: Problem Packet Extraction
    # -----------------------------------------------------------------
    packet_file = os.path.join(source_dir, "problem_packet.json")
    if not _json_complete(packet_file):
        _set_benchmark_status(
            logger,
            1,
            "1/9 Problem Packet Extraction",
            "RUNNING",
            "Extracting the target theorem and proof packet deterministically from the source chapter.",
        )
        logger.log("\n=== STAGE 1: Problem Packet Extraction ===")
        if efficient_llm:
            _write_problem_packet_deterministic(
                chapter_text_file=chapter_text_file,
                theorem_label=theorem_label or "",
                ch=ch,
                packet_file=packet_file,
                logger=logger,
            )
        else:
            prompt = load_prompt(
                prompts_dir, "claude-proof_packet_extract.md",
                ch_num=ch,
                chapter_text_file=chapter_text_file,
                theorems_and_defs_file=theorems_and_defs_file,
                theorem_label=theorem_label or "",
                output_file=packet_file,
                project_root=project_root,
            )
            await run_agent(
                claude_opts, prompt, logger,
                tracker=tracker, call_name=f"ch{ch} Packet Extract",
                expected_outputs=[packet_file],
            )
        if not _json_complete(packet_file):
            logger.log("ERROR: Stage 1 did not produce problem_packet.json. Stopping.")
            return _stop_benchmark_pipeline(
                logger,
                1,
                "1/9 Problem Packet Extraction",
                "Stage 1 did not produce problem_packet.json.",
            )
    else:
        _set_benchmark_status(
            logger,
            1,
            "1/9 Problem Packet Extraction",
            "RUNNING",
            "Using existing problem_packet.json from a previous run.",
        )
        logger.log("Stage 1: problem_packet.json already exists. Skipping.")

    # Validate problem packet has sufficient content before continuing.
    # An empty proof_text means Stage 2 will skeletonize nothing.
    try:
        with open(packet_file) as _pf:
            _packet = json.load(_pf)
        _proof_text = _packet.get("proof_text", "").strip()
        _natural_statement = _packet.get("natural_statement", "").strip()
        if not _proof_text:
            logger.log(
                "ERROR: problem_packet.json has an empty 'proof_text'. "
                "Stage 2 cannot skeletonize an empty proof. "
                "Check that the theorem label is correct and the chapter file contains a proof block."
            )
            return _stop_benchmark_pipeline(
                logger,
                1,
                "1/9 Problem Packet Extraction",
                "problem_packet.json is missing proof_text, so Stage 2 cannot continue.",
            )
        if not _natural_statement:
            logger.log(
                "WARNING: problem_packet.json has an empty 'natural_statement'. "
                "Continuing, but benchmark output quality may be reduced."
            )
    except (json.JSONDecodeError, IOError) as _e:
        logger.log(f"ERROR: Cannot read problem_packet.json for validation: {_e}")
        return _stop_benchmark_pipeline(
            logger,
            1,
            "1/9 Problem Packet Extraction",
            "problem_packet.json could not be read for validation.",
        )

    problem_id = _read_problem_id(packet_file)

    # -----------------------------------------------------------------
    # Stages 2–4: NL decomposition graph → Mathlib check → human graph/profile editing
    #
    # This loop allows the human to request re-skeletonization during
    # Stage 4. On re-skeletonization, skeleton and mathlib-check files
    # are cleared and Stage 2 restarts.
    # -----------------------------------------------------------------
    skeleton_file = os.path.join(outline_dir, "skeleton.json")
    mathlib_check_file = os.path.join(outline_dir, "skeleton_mathlib_check.json")
    profile_file = os.path.join(outline_dir, "assumption_profile.json")

    # Accumulated feedback from human re-skeletonization requests.
    # On the first attempt this is empty; on retries it carries the human's
    # flagged steps (with their statements) so the skeletonizer knows exactly
    # which parts were judged too coarse.
    reskeletonize_feedback: str = ""

    for reskel_attempt in range(_MAX_RESKEL_ATTEMPTS):

        # -- Stage 2: Natural-language proof decomposition graph --
        if not _json_complete(skeleton_file):
            _set_benchmark_status(
                logger,
                2,
                "2/9 Natural-Language Graph",
                "RUNNING",
                f"Building a natural-language decomposition graph (attempt {reskel_attempt + 1} of {_MAX_RESKEL_ATTEMPTS}).",
            )
            logger.log(f"\n=== STAGE 2: Natural-Language Decomposition Graph (attempt {reskel_attempt + 1}) ===")
            prompt = load_prompt(
                prompts_dir, "claude-proof_skeletonize.md",
                problem_id=problem_id,
                problem_packet_file=packet_file,
                output_file=skeleton_file,
                project_root=project_root,
                reskeletonize_feedback=reskeletonize_feedback,
            )
            await run_agent(
                claude_opts, prompt, logger,
                tracker=tracker, call_name=f"ch{ch} Skeletonize",
                expected_outputs=[skeleton_file],
            )
            if not _json_complete(skeleton_file):
                logger.log("ERROR: Stage 2 did not produce skeleton.json. Stopping.")
                return _stop_benchmark_pipeline(
                    logger,
                    2,
                    "2/9 Natural-Language Graph",
                    "Stage 2 did not produce skeleton.json.",
                )
        else:
            _set_benchmark_status(
                logger,
                2,
                "2/9 Natural-Language Graph",
                "RUNNING",
                "Using existing skeleton.json from a previous run.",
            )
            logger.log("Stage 2: skeleton.json already exists. Skipping.")

        # -- Stage 3: Conservative Mathlib Verification --
        if not _json_complete(mathlib_check_file):
            _set_benchmark_status(
                logger,
                3,
                "3/9 Conservative Mathlib Verification",
                "RUNNING",
                "Running deterministic Mathlib/easiness checks before any optional semantic review.",
            )
            logger.log("\n=== STAGE 3: Conservative Mathlib Verification ===")
            if efficient_llm:
                _write_deterministic_mathlib_check(skeleton_file, mathlib_check_file, logger)
            else:
                prompt = load_prompt(
                    prompts_dir, "claude-skeleton_mathlib_check.md",
                    problem_id=problem_id,
                    skeleton_file=skeleton_file,
                    output_file=mathlib_check_file,
                    project_root=project_root,
                )
                await run_agent(
                    claude_opts, prompt, logger, tools=[loogle_search],
                    tracker=tracker, call_name=f"ch{ch} Mathlib Check",
                    expected_outputs=[mathlib_check_file],
                )
            if not _json_complete(mathlib_check_file):
                logger.log(
                    "WARNING: Stage 3 did not produce skeleton_mathlib_check.json. "
                    "Continuing without mathlib verification data."
                )
        else:
            _set_benchmark_status(
                logger,
                3,
                "3/9 Conservative Mathlib Verification",
                "RUNNING",
                "Using existing skeleton_mathlib_check.json from a previous run.",
            )
            logger.log("Stage 3: skeleton_mathlib_check.json already exists. Skipping.")

        # -- Stage 4: Human Terminal Profile Selection --
        if not _json_complete(profile_file):
            if allow_ui_pause and not sys.stdin.isatty():
                logger.log("\n=== STAGE 4: Graph Editing and Target Selection ===")
                logger.log("Pausing for UI-based profile selection.")
                _set_benchmark_status(
                    logger,
                    4,
                    "4/9 Graph Editing",
                    "PAUSED",
                    "Waiting for graph edits and benchmark target selection in the web UI.",
                )
                logger.append_history("Paused for UI profile selection")
                return False

            _set_benchmark_status(
                logger,
                4,
                "4/9 Graph Editing",
                "RUNNING",
                "Waiting for the human to choose the target theorem and assumed steps.",
            )
            logger.log("\n=== STAGE 4: Graph Editing and Target Selection ===")
            logger.log("Pausing for human input in the terminal.")
            result = _human_profile_selection(
                skeleton_file=skeleton_file,
                mathlib_check_file=mathlib_check_file,
                problem_id=problem_id,
                output_file=profile_file,
                logger=logger,
            )

            if result is None:
                logger.log("ERROR: Human profile selection was aborted. Stopping pipeline.")
                return _stop_benchmark_pipeline(
                    logger,
                    4,
                    "4/9 Graph Editing",
                    "Human profile selection was aborted before a profile was saved.",
                )

            if result.get("reskeletonize"):
                nodes_flagged = result["reskeletonize"]
                # Build feedback from the current skeleton BEFORE clearing it.
                # This threads the human's specific critique into the next Stage 2 run.
                reskeletonize_feedback = _build_reskeletonize_feedback(
                    skeleton_file, nodes_flagged
                )
                logger.log(
                    f"Re-skeletonization requested for: {nodes_flagged}. "
                    f"Clearing skeleton and restarting Stage 2 with human feedback."
                )
                _clear_files([skeleton_file, mathlib_check_file])
                continue  # restart the skeletonization loop

            # Extract selected profile from first human-authored profile.
            profiles = result.get("profiles", [])
            if not profiles:
                logger.log("ERROR: No profiles were created in Stage 4. Stopping.")
                return _stop_benchmark_pipeline(
                    logger,
                    4,
                    "4/9 Graph Editing",
                    "No profiles were created in Stage 4.",
                )
            selected_profile = profiles[0]["name"]
            logger.log(
                f"Stage 4 complete. Primary profile: '{selected_profile}', "
                f"{len(profiles)} profile(s) total."
            )
        else:
            _set_benchmark_status(
                logger,
                4,
                "4/9 Graph Editing",
                "RUNNING",
                "Using an existing assumption_profile.json from a previous run.",
            )
            # Profile already exists — determine selected_profile from file.
            try:
                with open(profile_file) as f:
                    existing = json.load(f)
                profiles = existing.get("profiles", [])
                selected_profile = profiles[0]["name"] if profiles else "profile_1"
            except (json.JSONDecodeError, IOError, KeyError, IndexError):
                selected_profile = "profile_1"
            logger.log(
                f"Stage 4: assumption_profile.json already exists. "
                f"Using profile '{selected_profile}'. Skipping."
            )

        break  # Normal exit — no re-skeletonization requested.
    else:
        logger.log(
            f"ERROR: Re-skeletonization limit ({_MAX_RESKEL_ATTEMPTS}) reached. Stopping."
        )
        return _stop_benchmark_pipeline(
            logger,
            4,
            "4/9 Graph Editing",
            f"Re-skeletonization limit ({_MAX_RESKEL_ATTEMPTS}) reached.",
        )

    # -----------------------------------------------------------------
    # Stage 5: Dependency Graph Construction
    # -----------------------------------------------------------------
    outline_file = os.path.join(outline_dir, "outline.json")
    if not _json_complete(outline_file):
        _set_benchmark_status(
            logger,
            5,
            "5/9 Dependency Graph Construction",
            "RUNNING",
            "Constructing the dependency graph for the selected benchmark profile.",
        )
        logger.log("\n=== STAGE 5: Dependency Graph Construction ===")
        if efficient_llm:
            edited_graph_file = os.path.join(outline_dir, "edited_graph.json")
            graph_diff_file = os.path.join(outline_dir, "graph_diff.json")
            _write_outline_from_profile(
                problem_id=problem_id,
                skeleton_file=skeleton_file,
                profile_file=profile_file,
                edited_graph_file=edited_graph_file,
                output_file=outline_file,
                diff_file=graph_diff_file,
                logger=logger,
            )
        else:
            prompt = load_prompt(
                prompts_dir, "claude-dependency_graph_build.md",
                problem_id=problem_id,
                skeleton_file=skeleton_file,
                assumption_profile_file=profile_file,
                selected_profile=selected_profile,
                output_file=outline_file,
                project_root=project_root,
            )
            await run_agent(
                claude_opts, prompt, logger,
                tracker=tracker, call_name=f"ch{ch} Graph Build",
                expected_outputs=[outline_file],
            )
        if not _json_complete(outline_file):
            logger.log("ERROR: Stage 5 did not produce outline.json. Stopping.")
            return _stop_benchmark_pipeline(
                logger,
                5,
                "5/9 Dependency Graph Construction",
                "Stage 5 did not produce outline.json.",
            )
    else:
        _set_benchmark_status(
            logger,
            5,
            "5/9 Dependency Graph Construction",
            "RUNNING",
            "Using existing outline.json from a previous run.",
        )
        logger.log("Stage 5: outline.json already exists. Skipping.")

    # -----------------------------------------------------------------
    # Stage 5 post-check: Graph lint
    #
    # Validate the DAG structure before any downstream stage depends on it.
    # On errors, give the model one targeted repair attempt then re-lint.
    # Warnings are logged but never block progress.
    # -----------------------------------------------------------------
    try:
        with open(outline_file) as _f:
            _outline_data = json.load(_f)
        _lint = lint_outline_graph(_outline_data)
        _lint_errors = _lint.errors()
        if _lint_errors:
            _error_lines = "\n".join(
                f"  [{i.node or 'global'}] {i.message}" for i in _lint_errors
            )
            logger.log(
                f"Stage 5 lint: {len(_lint_errors)} error(s) detected.\n{_error_lines}"
            )
            # One repair attempt. In efficient mode, graph structure repair is
            # deterministic validation feedback only; Claude is not used for it.
            if efficient_llm:
                logger.log("Stage 5 lint: efficient mode will not call Claude for graph repair.")
                _write_json(os.path.join(outline_dir, "outline_lint.json"), _lint.to_dict())
                _lint2 = _lint
            else:
                _lint2 = None
            _repair_prompt = (
                f"The file {outline_file} has graph structure errors that will break "
                f"downstream stages. Read the file, fix ONLY the errors listed below, "
                f"and write the corrected JSON back to {outline_file}.\n\n"
                f"Errors to fix:\n{_error_lines}\n\n"
                f"Rules:\n"
                f"- Every name in 'inputs' must be the exact name of another node.\n"
                f"- Nodes must appear after all their dependencies (topological order).\n"
                f"- No node may (even transitively) depend on itself.\n"
                f"- Every node name must be unique.\n"
                f"Do NOT change any node's mathematical content or type — fix structure only."
            )
            if not efficient_llm:
                await run_agent(
                    claude_opts, _repair_prompt, logger,
                    tracker=tracker, call_name=f"ch{ch} Graph Repair",
                    expected_outputs=[outline_file],
                )
            if not efficient_llm and _json_complete(outline_file):
                with open(outline_file) as _f:
                    _outline_data = json.load(_f)
                _lint2 = lint_outline_graph(_outline_data)
            if _lint2 and _lint2.errors():
                logger.log(
                    f"Stage 5 lint repair: {len(_lint2.errors())} error(s) remain. "
                    "Continuing with best-effort outline."
                )
            elif _lint2:
                logger.log("Stage 5 lint repair: all errors resolved.")
            elif not _json_complete(outline_file):
                logger.log("Stage 5 lint repair: outline.json not readable after repair attempt.")
        else:
            _warn_count = len(_lint.warnings())
            logger.log(
                f"Stage 5 lint: passed "
                f"({_lint.stats.get('total_nodes', '?')} nodes"
                f"{f', {_warn_count} warning(s)' if _warn_count else ''})."
            )
    except (json.JSONDecodeError, IOError) as _e:
        logger.log(f"Stage 5 lint: could not read outline.json — {_e}. Skipping lint.")

    # -----------------------------------------------------------------
    # Stage 6: Mathlib Mapping (on outline nodes)
    # -----------------------------------------------------------------
    mathlib_map_file = os.path.join(outline_dir, "mathlib_map.json")
    if not _json_complete(mathlib_map_file):
        _set_benchmark_status(
            logger,
            6,
            "6/9 Mathlib Mapping",
            "RUNNING",
            "Mapping outline nodes to likely Mathlib lemmas and definitions.",
        )
        logger.log("\n=== STAGE 6: Mathlib Mapping ===")
        if efficient_llm:
            _write_deterministic_mathlib_map(outline_file, mathlib_map_file, logger)
        else:
            prompt = load_prompt(
                prompts_dir, "claude-mathlib_map.md",
                problem_id=problem_id,
                outline_file=outline_file,
                output_file=mathlib_map_file,
                project_root=project_root,
            )
            await run_agent(
                claude_opts, prompt, logger, tools=[loogle_search],
                tracker=tracker, call_name=f"ch{ch} Mathlib Map",
                expected_outputs=[mathlib_map_file],
            )
        if not _json_complete(mathlib_map_file):
            logger.log(
                "WARNING: Stage 6 did not produce mathlib_map.json. Continuing without it."
            )
    else:
        _set_benchmark_status(
            logger,
            6,
            "6/9 Mathlib Mapping",
            "RUNNING",
            "Using existing mathlib_map.json from a previous run.",
        )
        logger.log("Stage 6: mathlib_map.json already exists. Skipping.")

    if efficient_llm:
        blocked_nodes = _disallowed_benchmark_nodes(profile_file, mathlib_map_file, outline_file)
        if blocked_nodes:
            rejection_file = os.path.join(validation_dir, "benchmark_target_rejection.json")
            _write_json(
                rejection_file,
                {
                    "reason": "Selected benchmark nodes must not be easy or already close to Mathlib by deterministic checks.",
                    "blocked_nodes": blocked_nodes,
                    "next_step": "Edit the graph/profile and choose harder benchmark target nodes.",
                },
            )
            _set_benchmark_status(
                logger,
                6,
                "6/9 Mathlib Mapping",
                "PAUSED",
                "Some selected benchmark targets look easy or Mathlib-like. Edit the graph/profile and resume.",
            )
            logger.log(f"Blocked benchmark targets: {blocked_nodes}")
            logger.append_history("Paused because selected targets failed deterministic easiness/Mathlib checks")
            return False

    # -----------------------------------------------------------------
    # Stage 7 + Spec Validation Loop
    # Repeat up to max_spec_iters times: emit blueprint → validate → repair
    # -----------------------------------------------------------------
    blueprint_lean = os.path.join(blueprint_dir, "problem_blueprint.lean")
    lean_statement_candidates_file = os.path.join(blueprint_dir, "lean_statement_candidates.json")
    report_json = os.path.join(validation_dir, "spec_validation_report.json")
    report_md = os.path.join(validation_dir, "spec_validation_report.md")
    shells_file = os.path.join(validation_dir, "descendant_shells.lean")
    spec_contracts_file = os.path.join(validation_dir, "spec_contracts.json")

    for spec_iter in range(1, max_spec_iters + 1):
        _set_benchmark_status(
            logger,
            7,
            "7/9 Blueprint Emission",
            "RUNNING",
            f"Generating blueprint artifacts for spec iteration {spec_iter} of {max_spec_iters}.",
        )
        logger.log(f"\n=== STAGE 7 (iter {spec_iter}/{max_spec_iters}): Blueprint Emission ===")
        if efficient_llm:
            synth_prompt = _build_statement_synthesis_prompt(
                problem_id=problem_id,
                outline_file=outline_file,
                profile_file=profile_file,
                output_file=lean_statement_candidates_file,
            )
            await run_agent(
                claude_opts, synth_prompt, logger,
                tracker=tracker, call_name=f"ch{ch} Lean Statement Synthesis",
                expected_outputs=[lean_statement_candidates_file],
            )
            _emit_blueprint_from_statement_candidates(
                problem_id=problem_id,
                outline_file=outline_file,
                profile_file=profile_file,
                candidates_file=lean_statement_candidates_file,
                blueprint_lean=blueprint_lean,
                blueprint_json=os.path.join(blueprint_dir, "problem_blueprint.json"),
                graph_mmd=os.path.join(blueprint_dir, "problem_graph.mmd"),
                logger=logger,
            )
        else:
            emit_prompt = load_prompt(
                prompts_dir, "claude-blueprint_emit.md",
                problem_id=problem_id,
                outline_file=outline_file,
                mathlib_map_file=mathlib_map_file if os.path.exists(mathlib_map_file) else "(not available)",
                assumption_profile_file=profile_file,
                selected_profile=selected_profile,
                benchmark_dir=benchmark_work_dir,
                lean_project_root=project_root,
            )
            await run_agent(
                claude_opts, emit_prompt, logger, tools=[loogle_search],
                tracker=tracker, call_name=f"ch{ch} Blueprint Emit S{spec_iter}",
                expected_outputs=[
                    blueprint_lean,
                    os.path.join(blueprint_dir, "problem_blueprint.json"),
                    os.path.join(blueprint_dir, "problem_graph.mmd"),
                ],
            )

        if not os.path.exists(blueprint_lean):
            logger.log(
                f"Stage 7 iter {spec_iter}: blueprint not created. Continuing to next iter."
            )
            continue

        if efficient_llm:
            _set_benchmark_status(
                logger,
                8,
                "8/9 Python Lean Check",
                "RUNNING",
                "Running Python-only Lean file checks without Lean, Lake, or Mathlib.",
            )
            logger.log("\n=== STAGE 8: Python Lean Check ===")
            logger.log("Efficient mode: validating emitted Lean blueprint with Python-only checks; no Claude, Lean, Lake, or Mathlib clone.")
            _write_deterministic_spec_report(
                problem_id=problem_id,
                blueprint_lean=blueprint_lean,
                report_json=report_json,
                report_md=report_md,
                logger=logger,
            )
            break

        # Stage 7.5: Spec contract extraction
        logger.log(f"\n=== STAGE 7.5 (iter {spec_iter}): Spec Contract Extraction ===")
        contract_prompt = load_prompt(
            prompts_dir, "claude-spec_contract_extract.md",
            problem_id=problem_id,
            outline_file=outline_file,
            assumption_profile_file=profile_file,
            selected_profile=selected_profile,
            blueprint_lean_file=blueprint_lean,
            output_file=spec_contracts_file,
        )
        await run_agent(
            claude_opts, contract_prompt, logger,
            tracker=tracker, call_name=f"ch{ch} Spec Contracts S{spec_iter}",
            expected_outputs=[spec_contracts_file],
        )

        # Stage 7.6: Descendant shell generation
        logger.log(f"\n=== STAGE 7.6 (iter {spec_iter}): Descendant Shell Generation ===")
        shells_prompt = load_prompt(
            prompts_dir, "claude-descendant_shells.md",
            problem_id=problem_id,
            blueprint_lean_file=blueprint_lean,
            spec_contracts_file=(
                spec_contracts_file
                if os.path.exists(spec_contracts_file)
                else "(not available)"
            ),
            output_file=shells_file,
            lean_project_root=project_root,
        )
        await run_agent(
            claude_opts, shells_prompt, logger,
            tracker=tracker, call_name=f"ch{ch} Desc Shells S{spec_iter}",
            expected_outputs=[shells_file],
        )

        # Stage 8: Spec regression check
        _set_benchmark_status(
            logger,
            8,
            "8/9 Python Lean Check",
            "RUNNING",
            f"Validating the emitted blueprint for iteration {spec_iter} of {max_spec_iters}.",
        )
        logger.log(f"\n=== STAGE 8 (iter {spec_iter}): Python Lean Check ===")
        check_prompt = load_prompt(
            prompts_dir, "claude-spec_regression_check.md",
            problem_id=problem_id,
            benchmark_dir=benchmark_work_dir,
            lean_project_root=project_root,
            selected_profile=selected_profile,
            output_report_json=report_json,
            output_report_md=report_md,
            evaluation_dir=evaluation_dir,
        )
        await run_agent(
            claude_opts, check_prompt, logger, tools=[loogle_search],
            tracker=tracker, call_name=f"ch{ch} Spec Check S{spec_iter}",
            expected_outputs=[report_json, report_md],
        )

        # Verdict
        verdict_prompt = load_prompt(
            prompts_dir, "claude-verdict_spec_with_probes.md",
            problem_id=problem_id,
            validation_report_file=report_json,
        )
        decision = await run_agent_for_verdict(
            claude_opts, verdict_prompt, logger,
            tracker=tracker, call_name=f"ch{ch} Spec Verdict S{spec_iter}",
        )
        logger.log(f"Spec validation iter {spec_iter}: verdict = {decision}")

        if decision == "DONE":
            logger.log("Spec validation DONE. Proceeding to benchmark packaging.")
            break

        if spec_iter < max_spec_iters:
            logger.log(
                f"Spec validation CONTINUE. Running repair iteration {spec_iter + 1}."
            )
            # Clear blueprint and shells to force re-emission next iter.
            for fpath in (
                blueprint_lean,
                shells_file,
                os.path.join(blueprint_dir, "problem_blueprint.json"),
                os.path.join(blueprint_dir, "problem_graph.mmd"),
            ):
                if os.path.exists(fpath):
                    os.remove(fpath)
        else:
            logger.log("Spec validation CONTINUE but max iterations reached.")

    # -----------------------------------------------------------------
    # Stage 9: Benchmark Packaging
    # -----------------------------------------------------------------
    _set_benchmark_status(
        logger,
        9,
        "9/9 Benchmark Packaging",
        "RUNNING",
        "Packaging benchmark artifacts and writing final outputs.",
    )
    logger.log("\n=== STAGE 9: Benchmark Packaging ===")
    profile_names = _read_profile_names(profile_file)
    if not efficient_llm:
        package_prompt = load_prompt(
            prompts_dir, "claude-benchmark_package.md",
            problem_id=problem_id,
            working_benchmark_dir=benchmark_work_dir,
            output_dir=output_dir,
            profiles=",".join(profile_names) if profile_names else selected_profile,
        )
        await run_agent(
            claude_opts, package_prompt, logger,
            tracker=tracker, call_name=f"ch{ch} Benchmark Package",
            expected_outputs=[os.path.join(output_dir, "benchmarks", problem_id, "README.md")],
        )
    else:
        logger.log("Efficient mode: packaging with Python only; no Claude packaging call.")

    # Also run the Python packager directly for determinism.
    try:
        from benchmark_pipeline.benchmark_package import (
            package_benchmark,
            generate_model_prompt,
        )
        summary = package_benchmark(problem_id, benchmark_work_dir, output_dir)
        logger.log(f"Benchmark packaged to: {output_dir}/benchmarks/{problem_id}/")
        logger.log(f"Spec verdict: {summary.get('spec_verdict', 'UNKNOWN')}")
        final_dest = os.path.join(output_dir, "benchmarks", problem_id)
        generate_model_prompt(problem_id, final_dest)
        state = "FINISHED" if summary.get("spec_verdict") == "DONE" else "STOPPED"
        detail = (
            "Benchmark packaged successfully."
            if state == "FINISHED"
            else f"Benchmark packaged, but final spec verdict was {summary.get('spec_verdict', 'UNKNOWN')}."
        )
        _set_benchmark_status(
            logger,
            9,
            "9/9 Benchmark Packaging",
            state,
            detail,
        )
        logger.append_history(detail)
        return summary.get("spec_verdict") == "DONE"
    except Exception as e:
        logger.log(
            f"WARNING: Python packager encountered an error: {e}. "
            "Agent packaging may still have succeeded."
        )
        _set_benchmark_status(
            logger,
            9,
            "9/9 Benchmark Packaging",
            "FINISHED",
            "Agent packaging completed, but the Python packager reported a warning.",
        )
        logger.append_history("Benchmark packaging finished with Python packager warning")
        return True


# ---------------------------------------------------------------------------
# Human terminal interaction — Stage 4
# ---------------------------------------------------------------------------

def _human_profile_selection(
    skeleton_file: str,
    mathlib_check_file: str,
    problem_id: str,
    output_file: str,
    logger,
) -> "dict | None":
    """
    Blocking terminal interaction for human benchmark profile selection.

    The human sees the skeleton steps, any confirmed mathlib matches, and
    decides:
      - which steps to assume (background hypotheses),
      - which step is the primary benchmark target,
      - whether any steps need re-skeletonization.
    Multiple profiles are supported; the first profile is the primary one.

    Returns:
        On success: a dict {"problem_id": ..., "selected_target": ...,
                            "profiles": [...]}
        On re-skeletonization request: {"reskeletonize": ["step_N", ...],
                                        "profiles": []}
        On abort / non-interactive stdin: None
    """
    if not sys.stdin.isatty():
        logger.log(
            "ERROR: Stage 4 requires an interactive terminal (stdin is not a tty).\n"
            "Run the pipeline in a terminal where you can type responses."
        )
        return None

    if not os.path.exists(skeleton_file):
        logger.log(f"ERROR: skeleton_file not found: {skeleton_file}")
        return None

    try:
        with open(skeleton_file) as f:
            skeleton = json.load(f)
    except (json.JSONDecodeError, IOError) as e:
        logger.log(f"ERROR: Cannot read skeleton file: {e}")
        return None

    steps = skeleton.get("steps", [])
    if not steps:
        logger.log("ERROR: Skeleton has no steps. Cannot run profile selection.")
        return None

    # Load confirmed mathlib results (conservative; only show "existing" ones).
    mathlib_confirmed: set[str] = set()
    if os.path.exists(mathlib_check_file):
        try:
            with open(mathlib_check_file) as f:
                check_data = json.load(f)
            for entry in check_data.get("nodes", []):
                sid = entry.get("name", entry.get("id", ""))
                if entry.get("classification") == "existing" and sid:
                    mathlib_confirmed.add(sid)
        except (json.JSONDecodeError, IOError):
            pass  # mathlib check is advisory; proceed without it

    SEP = "=" * 72
    THIN = "-" * 72

    # ---- Display header and step list ----
    print(f"\n{SEP}")
    print("  BENCHMARK PROFILE SELECTION")
    print(f"  Problem: {problem_id}")
    print(SEP)
    print()
    print("Proof skeleton — available steps:")
    print()

    step_ids = []
    for i, step in enumerate(steps, 1):
        sid = step.get("id", f"step_{i}")
        step_ids.append(sid)
        stmt = step.get("statement", "(no statement)")
        kind = step.get("kind", "?")
        intent = step.get("proof_intent", "")
        is_cand = step.get("assumption_candidate", False)

        tags = []
        if is_cand:
            tags.append("assumption candidate")
        if sid in mathlib_confirmed:
            tags.append("CONFIRMED in mathlib")
        tag_str = f"  [{', '.join(tags)}]" if tags else ""

        stmt_display = stmt if len(stmt) <= 88 else stmt[:85] + "..."
        print(f"  [{i:>2}]  {sid}  ({kind}){tag_str}")
        print(f"         {stmt_display}")
        if intent:
            intent_display = intent if len(intent) <= 84 else intent[:81] + "..."
            print(f"         → {intent_display}")
        print()

    # ---- Re-skeletonization request ----
    print(THIN)
    print("RE-SKELETONIZATION (optional)")
    print(
        "If any step needs further decomposition, enter its number(s)\n"
        "(comma-separated, e.g. '2,4'). Press Enter to continue:"
    )
    reskel_raw = input("> ").strip()
    if reskel_raw:
        reskel_ids = _parse_step_indices(reskel_raw, steps)
        if reskel_ids:
            print(f"\nRe-skeletonization requested for: {reskel_ids}")
            print("Pipeline will restart Stage 2 for these steps.")
            return {"reskeletonize": reskel_ids, "profiles": []}

    # ---- Profile creation loop ----
    profiles = []

    while True:
        profile_num = len(profiles) + 1
        print()
        print(THIN)
        print(f"PROFILE {profile_num}")
        print()

        # Profile name
        default_name = f"profile_{profile_num}"
        print(f"Profile name (press Enter for '{default_name}'):")
        name = input("> ").strip() or default_name

        # Primary target theorem
        print()
        print(
            "PRIMARY TARGET: Enter the NUMBER of the step that is the main\n"
            "benchmark theorem (what a model will be asked to prove):"
        )
        target_raw = input("> ").strip()
        target_ids = _parse_step_indices(target_raw, steps)
        if not target_ids:
            print("  No valid step number entered. Using last step as target.")
            target_ids = [step_ids[-1]]
        selected_target = target_ids[0]

        # Assumed nodes
        print()
        print(
            "ASSUMED NODES: Enter number(s) of steps to treat as background\n"
            "hypotheses (the model uses these but does not prove them).\n"
            "Press Enter to assume none:"
        )
        assumed_raw = input("> ").strip()
        assumed_ids = _parse_step_indices(assumed_raw, steps) if assumed_raw else []

        # open_nodes = all non-assumed steps
        open_ids = [sid for sid in step_ids if sid not in assumed_ids]

        # Summary
        print()
        print("  Profile summary:")
        print(f"    Name:            {name}")
        print(f"    Selected target: {selected_target}")
        print(f"    Open nodes:      {', '.join(open_ids)}  ({len(open_ids)} total)")
        if assumed_ids:
            print(f"    Assumed nodes:   {', '.join(assumed_ids)}")
        else:
            print(f"    Assumed nodes:   (none — all steps are open)")
        print()
        print("Confirm this profile? (yes / no / redo):")
        confirm = input("> ").strip().lower()

        if confirm == "redo" or confirm == "no":
            print("Profile discarded. Starting over for this profile.")
            continue
        if confirm not in ("yes", "y", ""):
            print("Unrecognised input — treating as 'yes'.")

        profile = {
            "name": name,
            "selected_target": selected_target,
            "open_nodes": open_ids,
            "assumed_nodes": assumed_ids,
            "max_open_nodes": len(open_ids),
            "prefer_mathlib": True,
        }
        profiles.append(profile)

        print()
        print("Create another profile? (yes/no):")
        another = input("> ").strip().lower()
        if another not in ("yes", "y"):
            break

    if not profiles:
        logger.log("No profiles were created. Aborting profile selection.")
        return None

    # Write assumption_profile.json
    profile_data: dict = {
        "problem_id": problem_id,
        "selected_target": profiles[0]["selected_target"],
        "profiles": profiles,
    }
    try:
        with open(output_file, "w") as f:
            json.dump(profile_data, f, indent=2)
    except IOError as e:
        logger.log(f"ERROR: Cannot write assumption_profile.json: {e}")
        return None

    print()
    print(SEP)
    print(f"  {len(profiles)} profile(s) saved.")
    print(f"  Primary profile: '{profiles[0]['name']}'")
    print(f"  File: {output_file}")
    print(SEP)
    print()

    return profile_data


def _parse_step_indices(raw: str, steps: list) -> list:
    """
    Parse a comma-separated string of 1-based step numbers into step ID strings.
    Invalid numbers are silently ignored.
    """
    ids = []
    for part in raw.split(","):
        part = part.strip()
        if part.isdigit():
            idx = int(part) - 1
            if 0 <= idx < len(steps):
                sid = steps[idx].get("id", f"step_{idx + 1}")
                if sid not in ids:
                    ids.append(sid)
    return ids


# ---------------------------------------------------------------------------
# Efficient-mode deterministic stages
# ---------------------------------------------------------------------------

def _write_problem_packet_deterministic(
    chapter_text_file: str,
    theorem_label: str,
    ch: int,
    packet_file: str,
    logger,
) -> None:
    """Extract one theorem/proof packet with regex/parser logic only."""
    try:
        with open(chapter_text_file) as f:
            chapter_text = f.read()
    except OSError as exc:
        logger.log(f"ERROR: cannot read chapter text for deterministic extraction: {exc}")
        return

    found = find_theorem_block(chapter_text, theorem_label)
    if not found:
        logger.log(f"ERROR: no theorem-like block found for label '{theorem_label or '(first theorem)'}'.")
        return

    theorem_block, start_line, end_line = found
    proof_text = _find_proof_after_block(chapter_text, theorem_block, end_line)
    statement = _strip_latex_environment(theorem_block)
    problem_id = make_problem_id(f"ch{ch}", theorem_label or "theorem", 1)
    packet = ProblemPacket(
        problem_id=problem_id,
        chapter_id=f"ch{ch}",
        source_file=chapter_text_file,
        theorem_label=theorem_label,
        latex_quote=theorem_block,
        natural_statement=statement,
        proof_text=proof_text,
        local_definitions=find_local_definitions(chapter_text, start_line),
        local_notation=_find_nearby_notation(chapter_text, start_line),
        source_span=SourceSpan(start_line=start_line, end_line=end_line),
        ambiguities=[] if proof_text else ["No proof environment was found immediately after the theorem block."],
    )
    save_problem_packet(packet, packet_file)
    logger.log(
        "Stage 1 deterministic extraction wrote problem_packet.json "
        f"({len(packet.proof_text)} proof chars, {len(packet.local_definitions)} nearby definitions)."
    )


def _write_deterministic_mathlib_check(skeleton_file: str, output_file: str, logger) -> None:
    skeleton = _read_json(skeleton_file, default={})
    nodes = []
    for step in skeleton.get("steps", []):
        sid = step.get("id", step.get("name", ""))
        statement = step.get("statement", step.get("natural", ""))
        classification = _classify_statement(statement)
        nodes.append(
            {
                "id": sid,
                "name": sid,
                "classification": classification,
                "method": "deterministic",
                "heuristic": classification != "uncertain",
                "claude_review_available": classification == "uncertain",
                "label": "No Claude call was made. Optional Claude review is heuristic, not proof.",
                "key_terms": _key_terms(statement),
            }
        )
    _write_json(output_file, {"method": "deterministic", "nodes": nodes})
    logger.log(f"Stage 3 deterministic check wrote {len(nodes)} node result(s).")


def _write_outline_from_profile(
    problem_id: str,
    skeleton_file: str,
    profile_file: str,
    edited_graph_file: str,
    output_file: str,
    diff_file: str,
    logger,
) -> None:
    skeleton = _read_json(skeleton_file, default={})
    profile = _read_json(profile_file, default={})
    profiles = profile.get("profiles", [])
    selected = profiles[0] if profiles else {}
    selected_target = selected.get("selected_target") or profile.get("selected_target", "")
    open_nodes = set(selected.get("open_nodes", []))
    benchmark_nodes = set(open_nodes)
    if selected_target:
        benchmark_nodes.add(selected_target)
    assumed_nodes = set(selected.get("assumed_nodes", []))
    edited = _read_json(edited_graph_file, default=None) if os.path.exists(edited_graph_file) else None

    source_nodes = []
    if edited and isinstance(edited.get("nodes"), list):
        source_nodes = edited["nodes"]
        _write_graph_diff(skeleton, edited, diff_file)
    else:
        for step in skeleton.get("steps", []):
            source_nodes.append(
                {
                    "id": step.get("id", step.get("name", "")),
                    "category": "theorem",
                    "statement": step.get("statement", step.get("natural", "")),
                    "proof_intent": step.get("proof_intent", ""),
                    "depends_on": step.get("depends_on", step.get("inputs", [])),
                }
            )
        _write_json(diff_file, {"changed": False, "added_nodes": [], "removed_nodes": [], "changed_nodes": []})

    outline_nodes = []
    for node in source_nodes:
        name = node.get("id", node.get("name", ""))
        if not name:
            continue
        natural = node.get("statement", node.get("natural", ""))
        proof_intent = node.get("proof_intent", node.get("nl_proof", ""))
        role = "target" if name == selected_target else "open" if name in benchmark_nodes else "assumed" if name in assumed_nodes else "background"
        node_type = node.get("category", "theorem")
        outline_nodes.append(
            {
                "name": name,
                "type": node_type if node_type in {"theorem", "definition", "hypothesis"} else "theorem",
                "inputs": node.get("depends_on", node.get("inputs", [])),
                "natural": natural,
                "proof_intent": proof_intent,
                "role": role,
                "mathlib_status": "uncertain",
                "formal_stub": f"theorem {name} : True := by sorry" if role in {"open", "target"} else "",
            }
        )

    if not selected_target and outline_nodes:
        selected_target = outline_nodes[-1]["name"]
    outline = {"problem_id": problem_id, "main_target": selected_target, "nodes": outline_nodes}
    _write_json(output_file, outline)
    logger.log(f"Stage 5 deterministic outline wrote {len(outline_nodes)} node(s); graph diff saved to {diff_file}.")


def _write_deterministic_mathlib_map(outline_file: str, output_file: str, logger) -> None:
    outline = _read_json(outline_file, default={})
    nodes = []
    for node in outline.get("nodes", []):
        natural = node.get("natural", "")
        classification = _classify_statement(natural)
        mapped_classification = "existing" if classification in {"existing", "likely_easy"} else classification
        nodes.append(
            {
                "name": node.get("name", ""),
                "classification": mapped_classification,
                "raw_classification": classification,
                "method": "deterministic",
                "matches": [],
                "key_terms": _key_terms(natural),
                "claude_review_available": classification == "uncertain",
                "label": "Claude-based semantic Mathlib judgments are optional and heuristic, not proof.",
            }
        )
    _write_json(output_file, {"method": "deterministic", "nodes": nodes})
    logger.log(f"Stage 6 deterministic Mathlib map wrote {len(nodes)} node result(s).")


def _disallowed_benchmark_nodes(profile_file: str, mathlib_map_file: str, outline_file: str) -> list[dict]:
    profile = _read_json(profile_file, default={})
    mathlib_map = _read_json(mathlib_map_file, default={})
    outline = _read_json(outline_file, default={})
    profiles = profile.get("profiles", [])
    selected = profiles[0] if profiles else {}
    benchmark_ids = set(selected.get("open_nodes", []))
    selected_target = selected.get("selected_target") or profile.get("selected_target", "")
    if selected_target:
        benchmark_ids.add(selected_target)
    node_map = {node.get("name", ""): node for node in outline.get("nodes", [])}
    check_map = {node.get("name", ""): node for node in mathlib_map.get("nodes", [])}
    disallowed = {"existing", "likely_easy", "likely_too_small"}
    blocked = []
    for node_id in sorted(benchmark_ids):
        check = check_map.get(node_id, {})
        classification = check.get("classification", "uncertain")
        raw = check.get("raw_classification", classification)
        if classification in disallowed or raw in disallowed:
            blocked.append(
                {
                    "node_id": node_id,
                    "classification": classification,
                    "raw_classification": raw,
                    "natural": node_map.get(node_id, {}).get("natural", ""),
                    "reason": "Selected benchmark target appears easy, too small, or Mathlib-like by deterministic checks.",
                }
            )
    return blocked


def _write_deterministic_spec_report(
    problem_id: str,
    blueprint_lean: str,
    report_json: str,
    report_md: str,
    logger,
) -> None:
    static_result = _run_python_lean_static_check(blueprint_lean)
    static_ok = static_result["status"] == "ok"
    sorry_shape_ok = static_ok and static_result["sorry_shape_valid"]
    compile_result = {
        "status": "not_run",
        "returncode": None,
        "stdout": "",
        "stderr": "Lean/Lake/Mathlib typechecking was skipped by Python-only mode.",
        "warnings": [],
        "errors": [],
    }
    report = {
        "problem_id": problem_id,
        "method": "python_static_lean_shape_check",
        "verdict": "DONE" if sorry_shape_ok else "CONTINUE",
        "spec_verdict": "DONE" if sorry_shape_ok else "CONTINUE",
        "build_passed": False,
        "compile": compile_result,
        "static_check": static_result,
        "only_sorry_warnings_remain": False,
        "python_only_sorry_shape_valid": sorry_shape_ok,
        "note": (
            "This is a Python-only Lean-shape check. It does not run Lean/Lake, "
            "does not clone Mathlib, and does not prove that the generated file typechecks."
        ),
        "claude_calls": "No Claude spec-validation call was made in efficient mode.",
    }
    _write_json(report_json, report)
    os.makedirs(os.path.dirname(report_md), exist_ok=True)
    with open(report_md, "w") as f:
        f.write("# Spec Validation Report\n\n")
        f.write(f"Problem: `{problem_id}`\n\n")
        f.write(f"Verdict: `{report['spec_verdict']}`\n\n")
        f.write("Lean/Lake compile status: `not_run`\n\n")
        f.write("Lean return code: `None`\n\n")
        f.write("Only sorry warnings remain: `not_checked`\n\n")
        f.write(f"Python-only check passed: `{static_ok}`\n\n")
        f.write(f"Sorry-shape check passed: `{sorry_shape_ok}`\n\n")
        if static_result["warnings"]:
            f.write("## Warnings\n\n")
            for warning in static_result["warnings"]:
                f.write(f"- {warning}\n")
        if static_result["errors"]:
            f.write("\n## Errors\n\n")
            for error in static_result["errors"]:
                f.write(f"- {error}\n")
        f.write(
            "\nNote: this report intentionally skips real Lean typechecking. "
            "It cannot verify imports, Mathlib names, elaboration, or actual sorry warnings.\n"
        )
    logger.log(
        "Python-only spec report wrote verdict "
        f"{report['spec_verdict']} (sorry_shape_valid={sorry_shape_ok})."
    )


def _build_statement_synthesis_prompt(
    problem_id: str,
    outline_file: str,
    profile_file: str,
    output_file: str,
) -> str:
    return f"""# Task: Lean statement synthesis JSON only

You may use Claude for this task because it requires mathematical language understanding
and faithful Lean theorem statement synthesis.

Read only these files:
- outline: {outline_file}
- human profile: {profile_file}

Do not read the repository, generated build outputs, or unrelated files.
Use only the selected open/target benchmark nodes from the profile.

Write exactly one JSON object to:
{output_file}

Schema:
{{
  "problem_id": "{problem_id}",
  "statements": [
    {{
      "node_id": "node name from outline",
      "name": "valid Lean declaration name",
      "kind": "theorem",
      "imports": ["Mathlib.Tactic"],
      "natural": "source natural-language statement",
      "lean_statement": "theorem declaration signature only, no := and no proof"
    }}
  ]
}}

Rules:
- Return/write JSON only; no markdown fences.
- Do not generate project files.
- Do not run lake, lean, shell commands, or proof search.
- Do not attempt proofs.
- `lean_statement` must be a Lean theorem signature only.
- Python will add `:= by sorry`, file layout, comments, and build checks.
"""


def _emit_blueprint_from_statement_candidates(
    problem_id: str,
    outline_file: str,
    profile_file: str,
    candidates_file: str,
    blueprint_lean: str,
    blueprint_json: str,
    graph_mmd: str,
    logger,
) -> None:
    outline = _read_json(outline_file, default={})
    profile = _read_json(profile_file, default={})
    candidates = _read_json(candidates_file, default={})
    candidate_map = {
        item.get("node_id", item.get("name", "")): item
        for item in candidates.get("statements", [])
        if isinstance(item, dict)
    }
    profiles = profile.get("profiles", [])
    selected = profiles[0] if profiles else {}
    open_nodes = set(selected.get("open_nodes", []))
    selected_target = selected.get("selected_target") or profile.get("selected_target", "")
    if selected_target:
        open_nodes.add(selected_target)

    imports = {"Mathlib.Tactic"}
    for item in candidate_map.values():
        imports.update(imp for imp in item.get("imports", []) if isinstance(imp, str) and imp.strip())

    lean_lines = [
        "-- Generated by latex_to_lean_question pipeline",
        "",
        *[f"import {imp}" for imp in sorted(imports)],
        "",
    ]
    json_nodes = []
    graph_lines = ["graph TD"]
    display_name_map = _meaningful_node_name_map(outline.get("nodes", []), candidate_map)
    for node in outline.get("nodes", []):
        name = node.get("name", "")
        if not name:
            continue
        display_name = display_name_map.get(name, name)
        node_type = node.get("type", "theorem")
        inputs = node.get("inputs", [])
        display_inputs = [display_name_map.get(dep, dep) for dep in inputs]
        natural = node.get("natural", "")
        nl_proof = node.get("proof_intent", "")
        candidate = candidate_map.get(name, {})
        declaration = candidate.get("lean_statement") or node.get("formal_stub") or f"theorem {name} : True"
        declaration = _rename_lean_declaration(declaration, display_name)
        declaration = _lean_signature_with_sorry(declaration, display_name, node_type, name in open_nodes)
        lean_lines.extend(
            [
                "/-! NODE",
                f"  \\name: {display_name}",
                f"  \\source_id: {name}",
                f"  \\inputs: {json.dumps(display_inputs)}",
                f"  \\type: {node_type}",
                f"  \\natural: {natural}",
                f"  \\NL_proof: {nl_proof}",
                "-/",
                declaration,
                "",
            ]
        )
        json_nodes.append(
            {
                "name": display_name,
                "source_id": name,
                "inputs": display_inputs,
                "type": node_type,
                "natural": natural,
                "formal": declaration,
                "NL_proof": nl_proof,
            }
        )
        graph_lines.append(f'    {display_name}["{display_name} ({node_type})"]')
        for dep in display_inputs:
            graph_lines.append(f"    {dep} --> {display_name}")

    os.makedirs(os.path.dirname(blueprint_lean), exist_ok=True)
    with open(blueprint_lean, "w") as f:
        f.write("\n".join(lean_lines).rstrip() + "\n")
    friendly_path = _friendly_blueprint_path(blueprint_lean, problem_id)
    if friendly_path != blueprint_lean:
        with open(friendly_path, "w") as f:
            f.write("\n".join(lean_lines).rstrip() + "\n")
    _write_json(blueprint_json, json_nodes)
    with open(graph_mmd, "w") as f:
        f.write("\n".join(graph_lines) + "\n")
    logger.log(
        "Python emitted blueprint artifacts from structured Lean statement candidates "
        f"({len(json_nodes)} node(s))."
    )


def _meaningful_node_name_map(nodes: list, candidate_map: dict) -> dict[str, str]:
    used: set[str] = set()
    mapping: dict[str, str] = {}
    for node in nodes:
        old_name = node.get("name", "")
        if not old_name:
            continue
        candidate = candidate_map.get(old_name, {})
        candidate_name = candidate.get("name", "") if isinstance(candidate, dict) else ""
        if candidate_name and not re.fullmatch(r"step_\d+", candidate_name):
            base = _lean_identifier_from_text(candidate_name)
        else:
            natural = node.get("natural", "") or node.get("proof_intent", "") or old_name
            base = _lean_identifier_from_text(natural)
        mapping[old_name] = _unique_identifier(base, used)
    return mapping


def _lean_identifier_from_text(text: str) -> str:
    text = text.replace("^2", " squared ")
    text = text.replace("²", " squared ")
    text = re.sub(r"\\mathbb\{Z\}", " integers ", text)
    text = re.sub(r"\\[a-zA-Z]+", " ", text)
    text = re.sub(r"\$|{|}|\[|\]|\(|\)|,", " ", text)
    text = re.sub(r"[^A-Za-z0-9_]+", " ", text)
    words = [w.lower() for w in text.split()]
    stop = {
        "a", "an", "and", "are", "as", "at", "be", "because", "been", "by",
        "can", "for", "from", "has", "have", "if", "in", "is", "it", "let",
        "of", "on", "or", "since", "such", "that", "the", "then", "there",
        "this", "to", "we", "where", "which", "with",
    }
    kept = [w for w in words if w not in stop and len(w) > 1]
    if not kept:
        kept = ["benchmark_node"]
    ident = "_".join(kept[:8])
    ident = re.sub(r"_+", "_", ident).strip("_")
    if not ident or ident[0].isdigit():
        ident = f"node_{ident or 'benchmark'}"
    return ident


def _unique_identifier(base: str, used: set[str]) -> str:
    candidate = base
    index = 2
    while candidate in used:
        candidate = f"{base}_{index}"
        index += 1
    used.add(candidate)
    return candidate


def _rename_lean_declaration(declaration: str, new_name: str) -> str:
    return re.sub(
        r"^(theorem|lemma|def|structure)\s+([A-Za-z_][A-Za-z0-9_']*)\b",
        lambda m: f"{m.group(1)} {new_name}",
        declaration.strip(),
        count=1,
    )


def _friendly_blueprint_path(blueprint_lean: str, problem_id: str) -> str:
    raw_name = os.environ.get("LATEX_TO_LEAN_INPUT_NAME", "").strip() or problem_id
    slug = re.sub(r"[^A-Za-z0-9]+", "_", raw_name).strip("_").lower()
    if not slug:
        slug = problem_id
    return os.path.join(os.path.dirname(blueprint_lean), f"{slug}_benchmark_question.lean")


def _lean_signature_with_sorry(declaration: str, fallback_name: str, node_type: str, is_open: bool) -> str:
    text = declaration.strip().split(":= by", 1)[0].split(":=", 1)[0].strip()
    if node_type == "definition":
        return text if text.startswith(("def ", "structure ")) else f"def {fallback_name} : Prop := {text or 'True'}"
    if node_type == "hypothesis":
        return text if text.startswith("def ") else f"def {fallback_name} : Prop := {text or 'True'}"
    if not text.startswith(("theorem ", "lemma ")):
        text = f"theorem {fallback_name} : {text or 'True'}"
    text = re.sub(r"^lemma\b", "theorem", text, count=1)
    return f"{text} := by\n  sorry" if is_open else f"{text} := by\n  sorry"


def _run_python_lean_static_check(lean_file: str) -> dict:
    errors: list[str] = []
    warnings: list[str] = []
    declarations: list[dict] = []

    if not os.path.exists(lean_file):
        return {
            "status": "failed",
            "file": lean_file,
            "errors": [f"Lean blueprint file does not exist: {lean_file}"],
            "warnings": [],
            "declaration_count": 0,
            "sorry_count": 0,
            "sorry_shape_valid": False,
        }

    with open(lean_file, encoding="utf-8") as f:
        text = f.read()

    if text.count("/-") != text.count("-/"):
        errors.append("Block comments are not balanced.")
    if re.search(r"\b(admit|undefined|TODO|FIXME)\b", text):
        warnings.append("File contains placeholder tokens such as admit/undefined/TODO/FIXME.")

    sorry_count = len(re.findall(r"\bsorry\b", text))
    if sorry_count == 0:
        errors.append("No `sorry` found; benchmark theorem nodes should be emitted with `by sorry`.")

    lines = text.splitlines()
    for index, line in enumerate(lines, start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("--") or stripped.startswith("/-") or stripped.startswith("-/"):
            continue
        if stripped.startswith("import "):
            if not re.match(r"^import\s+[A-Za-z_][A-Za-z0-9_'.]*(\.[A-Za-z_][A-Za-z0-9_'.]*)*$", stripped):
                errors.append(f"Line {index}: malformed import statement.")
            continue
        match = re.match(r"^(theorem|lemma|def|structure)\s+([A-Za-z_][A-Za-z0-9_']*)\b", stripped)
        if match:
            declarations.append({"line": index, "kind": match.group(1), "name": match.group(2)})
            continue

    names = [decl["name"] for decl in declarations]
    duplicates = sorted({name for name in names if names.count(name) > 1})
    if duplicates:
        errors.append(f"Duplicate Lean declaration names: {', '.join(duplicates)}.")
    if not declarations:
        errors.append("No Lean declarations found.")

    for pos, decl in enumerate(declarations):
        if decl["kind"] not in {"theorem", "lemma"}:
            continue
        start = decl["line"] - 1
        end = declarations[pos + 1]["line"] - 1 if pos + 1 < len(declarations) else len(lines)
        block = "\n".join(lines[start:end])
        if ":=" not in block or "sorry" not in block:
            errors.append(f"Line {decl['line']}: theorem/lemma `{decl['name']}` is not emitted with `:= by sorry`.")

    theorem_count = sum(1 for decl in declarations if decl["kind"] in {"theorem", "lemma"})
    if theorem_count == 0:
        warnings.append("No theorem or lemma declarations found.")

    sorry_shape_valid = not any("theorem/lemma" in error for error in errors) and sorry_count >= theorem_count
    return {
        "status": "failed" if errors else "ok",
        "file": lean_file,
        "errors": errors,
        "warnings": warnings,
        "declaration_count": len(declarations),
        "theorem_count": theorem_count,
        "sorry_count": sorry_count,
        "sorry_shape_valid": sorry_shape_valid,
        "declarations": declarations,
    }


def _write_graph_diff(skeleton: dict, edited: dict, diff_file: str) -> None:
    raw_nodes = {
        step.get("id", step.get("name", "")): {
            "statement": step.get("statement", step.get("natural", "")),
            "depends_on": step.get("depends_on", step.get("inputs", [])),
        }
        for step in skeleton.get("steps", [])
    }
    edited_nodes = {
        node.get("id", node.get("name", "")): {
            "statement": node.get("statement", node.get("natural", "")),
            "depends_on": node.get("depends_on", node.get("inputs", [])),
        }
        for node in edited.get("nodes", [])
    }
    added = sorted(set(edited_nodes) - set(raw_nodes))
    removed = sorted(set(raw_nodes) - set(edited_nodes))
    changed = []
    for node_id in sorted(set(raw_nodes) & set(edited_nodes)):
        if raw_nodes[node_id] != edited_nodes[node_id]:
            changed.append({"id": node_id, "before": raw_nodes[node_id], "after": edited_nodes[node_id]})
    _write_json(diff_file, {"changed": bool(added or removed or changed), "added_nodes": added, "removed_nodes": removed, "changed_nodes": changed})


def _strip_latex_environment(block: str) -> str:
    text = re.sub(r"\\begin\{[^}]+\}(\[[^\]]+\])?", "", block)
    text = re.sub(r"\\end\{[^}]+\}", "", text)
    text = re.sub(r"\\label\{[^}]+\}", "", text)
    return text.strip()


def _find_proof_after_block(chapter_text: str, theorem_block: str, end_line: int) -> str:
    proof_text = find_proof_after(chapter_text, end_line) or ""
    if proof_text:
        return proof_text
    start = chapter_text.find(theorem_block)
    if start < 0:
        return ""
    tail = chapter_text[start + len(theorem_block):]
    match = re.search(r"\\begin\{proof\*?\}(.*?)\\end\{proof\*?\}", tail, re.DOTALL | re.IGNORECASE)
    if match:
        return match.group(1).strip()
    if re.search(r"\\textbf\{[^}]*(?:Goal|Problem|Claim|Theorem)[^}]*\}", theorem_block, re.IGNORECASE):
        tail = re.sub(r"\\end\{document\}\s*$", "", tail.strip(), flags=re.IGNORECASE)
        return tail
    return ""


def _find_nearby_notation(chapter_text: str, theorem_start_line: int) -> list[str]:
    lines = chapter_text.splitlines()
    start = max(0, theorem_start_line - 200)
    nearby = "\n".join(lines[start:theorem_start_line])
    patterns = [
        r"\\newcommand\{[^}]+\}(?:\[[^\]]+\])?\{[^}]*\}",
        r"\\DeclareMathOperator\{[^}]+\}\{[^}]+\}",
        r"\\notation\b.*",
    ]
    found: list[str] = []
    for pattern in patterns:
        found.extend(match.group(0).strip() for match in re.finditer(pattern, nearby))
    return found[-20:]


def _classify_statement(statement: str) -> str:
    text = statement.strip()
    normalized = re.sub(r"\s+", " ", text)
    if re.search(r"\b([A-Za-z][A-Za-z0-9_]*)\s*=\s*\1\b", normalized):
        return "likely_easy"
    if normalized in {"True", "trivial", "$a=a$", "\\(a=a\\)"}:
        return "likely_easy"
    if len(normalized.split()) <= 4:
        return "likely_too_small"
    return "uncertain"


def _key_terms(statement: str) -> list[str]:
    return sorted(set(re.findall(r"[A-Za-z][A-Za-z0-9_]{3,}", statement)))[:12]


def _read_json(path: str, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return default


def _write_json(path: str, payload: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(payload, f, indent=2)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _json_complete(output_file: str) -> bool:
    """Return True if the stage output file exists, is non-empty, and contains valid JSON.

    Use this instead of _stage_complete for stages that write JSON.  A truncated
    or corrupted JSON file (e.g. from an agent that hit a token limit mid-write)
    will return False so the stage re-runs rather than silently propagating bad data.
    """
    if not os.path.exists(output_file) or os.path.getsize(output_file) == 0:
        return False
    try:
        with open(output_file) as f:
            json.load(f)
        return True
    except (json.JSONDecodeError, IOError):
        return False


def _set_benchmark_status(
    logger,
    stage_num: int,
    stage_label: str,
    state: str,
    details: str,
) -> None:
    """Update the persistent benchmark status file in a web-UI-friendly format."""
    logger.update_status(stage_num, 9, stage_label, state, details)


def _stop_benchmark_pipeline(
    logger,
    stage_num: int,
    stage_label: str,
    details: str,
) -> bool:
    """Mark the benchmark run as stopped and return False for convenient early exits."""
    _set_benchmark_status(logger, stage_num, stage_label, "STOPPED", details)
    logger.append_history(details)
    return False


def _read_problem_id(packet_file: str) -> str:
    """Read problem_id from a problem_packet.json file, or return a fallback."""
    if not os.path.exists(packet_file):
        return "unknown_problem"
    try:
        with open(packet_file) as f:
            data = json.load(f)
        return data.get("problem_id", "unknown_problem")
    except (json.JSONDecodeError, IOError):
        return "unknown_problem"


def _read_profile_names(profile_file: str) -> list:
    """Return the list of profile names from assumption_profile.json."""
    if not os.path.exists(profile_file):
        return []
    try:
        with open(profile_file) as f:
            data = json.load(f)
        return [p.get("name", f"profile_{i+1}") for i, p in enumerate(data.get("profiles", []))]
    except (json.JSONDecodeError, IOError):
        return []


def _clear_files(paths: list) -> None:
    """Delete files if they exist (used to force stage re-runs)."""
    for path in paths:
        if os.path.exists(path):
            os.remove(path)


def _build_reskeletonize_feedback(skeleton_file: str, flagged_ids: list) -> str:
    """Build a feedback string for Stage 2 re-runs.

    Extracts the statement and kind of each flagged step from the current
    skeleton so the skeletonizer knows which specific moves the human judged
    too coarse.  Returns an empty string if nothing useful can be extracted.
    """
    if not flagged_ids or not os.path.exists(skeleton_file):
        return ""
    try:
        with open(skeleton_file) as f:
            skeleton = json.load(f)
    except (json.JSONDecodeError, IOError):
        return ""

    step_map = {s.get("id", ""): s for s in skeleton.get("steps", [])}
    lines = []
    for sid in flagged_ids:
        step = step_map.get(sid)
        if step:
            kind = step.get("kind", "?")
            stmt = step.get("statement", "(no statement)")
            intent = step.get("proof_intent", "")
            line = f"- **{sid}** ({kind}): {stmt}"
            if intent:
                line += f"\n  _(proof intent: {intent})_"
            lines.append(line)

    if not lines:
        return ""

    items = "\n".join(lines)
    return (
        "## Re-skeletonization Guidance (from previous attempt)\n\n"
        "The human reviewer flagged the following steps as too coarse — they each "
        "hide one or more sub-arguments that should become separate steps.\n\n"
        "For each flagged step, look harder for:\n"
        "- A hidden intermediate lemma that the step silently assumes.\n"
        "- A conjunction of two separate claims bundled into one move.\n"
        "- Two or more named theorems applied in sequence.\n"
        "- A construction followed by a proof of correctness treated as one step.\n\n"
        f"{items}\n\n"
        "When you reach these steps in Pass 1, split them aggressively. "
        "It is better to have too many fine-grained steps than too few.\n\n"
    )
