# Task: Benchmark Packaging

## Objective

Assemble all generated artifacts into a clean, self-contained benchmark directory that a downstream
model runner can consume. Write summary metadata and a model-facing prompt file for each profile.
This is Stage 9 (final stage) of the benchmark outline pipeline.

## Inputs

- Problem ID: `{problem_id}`
- Working benchmark directory: `{working_benchmark_dir}`
- Final output directory: `{output_dir}`
- Profiles to package: `{profiles}` (comma-separated list of human-authored profile names)

## What To Do

### Step 1: Assemble the directory structure

Create the following layout under `{output_dir}/benchmarks/{problem_id}/`:

```
source/
  problem_packet.json
  theorem_quote.txt       (just the latex_quote field from problem_packet.json)
  proof_text.txt          (just the proof_text field from problem_packet.json)

outline/
  skeleton.json
  outline.json
  mathlib_map.json

profiles/
  <profile_name>.json    (one file per human-authored profile)

blueprint/
  problem_blueprint.lean
  problem_blueprint.json
  problem_graph.mmd

validation/
  spec_validation_report.json
  spec_validation_report.md
  descendant_shells.lean

prompts/
  benchmark_formalize_prompt.md
```

Copy files from `{working_benchmark_dir}` into this structure.

### Step 2: Write `source/theorem_quote.txt`

Extract the `latex_quote` field from `source/problem_packet.json` and write it as plain text.

### Step 3: Write `source/proof_text.txt`

Extract the `proof_text` field from `source/problem_packet.json` and write it as plain text.

### Step 4: Write per-profile JSON files

For each profile in `{profiles}`, write a separate file `profiles/<profile_name>.json` containing
just that profile's data from `{working_benchmark_dir}/outline/assumption_profile.json`.

The profiles in that file are human-authored. Do not rename them or add extra profiles.

### Step 5: Write `prompts/benchmark_formalize_prompt.md`

Write a model-facing prompt that a downstream formalization agent can use to tackle one open node.
The prompt should:

1. Describe the overall proof architecture (from the blueprint).
2. Identify the selected profile and list the open nodes.
3. Explain which nodes are assumed and what they state.
4. Provide instructions for a downstream agent to pick one open node and attempt to formalize it.
5. Reference the blueprint file and outline for context.

Use the first human-authored profile in `assumption_profile.json` as the default profile.

Template:

```markdown
# Benchmark: {problem_id}

## Overview

This benchmark asks you to formalize one open proof node from a structured Lean blueprint.
The blueprint represents: <natural_statement from problem_packet.json>

## Profile

This task uses the `<profile_name>` profile.

Open nodes (your proof targets):
<list of open_nodes with their natural descriptions>

Assumed background facts:
<list of assumed_nodes with their natural descriptions>

## Instructions

1. Read the blueprint: `blueprint/problem_blueprint.lean`
2. Read the outline: `outline/outline.json`
3. Read the original proof text: `source/proof_text.txt`
4. Choose one open theorem node from the list above.
5. Replace its `by sorry` body with a complete Lean 4 proof.
6. You may use any assumed node as a hypothesis (it is available as a `def`).
7. You may use mathlib. Run `loogle_search` to find relevant lemmas.
8. Do not modify any other theorem node's statement or body.
9. Run `lake build` to verify your proof compiles.

## Rules

- You may only fill in the body of ONE theorem node per run.
- Do not replace `sorry` in any theorem you have not been assigned.
- Do not modify assumption or definition nodes.
```

### Step 6: Write summary metadata

Write `{output_dir}/benchmarks/{problem_id}/benchmark_summary.json`:

```json
{{
  "problem_id": "{problem_id}",
  "packaged_at": "<ISO 8601 timestamp>",
  "theorem_label": "<from problem_packet.json>",
  "natural_statement": "<from problem_packet.json>",
  "total_nodes": <from outline.json>,
  "open_nodes_by_profile": {{
    "<profile_name>": <count>,
    "...": <count>
  }},
  "assumed_nodes_by_profile": {{
    "<profile_name>": <count>,
    "...": <count>
  }},
  "build_validated": <true if spec_validation_report.json shows build_passed: true>,
  "spec_verdict": "<DONE|CONTINUE from spec_validation_report.json>"
}}
```

## Hard Rules

- Do not modify any artifact during packaging. Copy only.
- If a required artifact is missing, note it in the summary as `"missing": ["file_path", ...]`
  rather than failing silently.
- The benchmark directory should be self-contained: a downstream agent should be able to consume it
  without needing access to the working pipeline directory.
- Do not attempt any Lean formalization or proof search.

## When Done

Print:
- The full path to the assembled benchmark directory.
- File count in each subdirectory.
- List any missing artifacts.
- The spec verdict from the validation report.
