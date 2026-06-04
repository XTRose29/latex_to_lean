# Task: Spec Regression Check

## Objective

Run the full specification validation loop for a benchmark bundle. Check coverage, build, semantic
equivalence, graph integrity, and descendant shell elaboration. Return a structured validation
report. This is Stage 8 of the benchmark outline pipeline. The assumption profile used here is
human-authored; do not modify it.

DO NOT replace any `sorry`. DO NOT attempt proofs. DO NOT call proof tactics to solve benchmark
nodes. DO NOT enter proof-search mode.

## Inputs

- Problem ID: `{problem_id}`
- Benchmark directory: `{benchmark_dir}`
- Lean project root: `{lean_project_root}`
- Selected profile: `{selected_profile}`
- Output report JSON: `{output_report_json}`
- Output report Markdown: `{output_report_md}`
- Pipeline scripts directory: `{evaluation_dir}`

## What To Do

### Check 1: Coverage Check

Confirm that every node listed in `{benchmark_dir}/outline/outline.json` has a corresponding
`/-! NODE` block in `{benchmark_dir}/blueprint/problem_blueprint.lean`. For each expected node:
- Is the `/-! NODE` block present?
- Are the `\\name:`, `\\inputs:`, `\\type:`, `\\natural:`, `\\NL_proof:` fields present and
  non-empty (where expected)?
- Is the Lean declaration immediately following the comment block (only blank lines between)?

Record: total expected nodes, found, missing, malformed.

### Check 2: Build Check

Run `lake build` in `{lean_project_root}`.

`sorry` IS allowed because the benchmark is intentionally unsolved. The build must pass with sorry
present. Record: pass/fail and any build error messages.

### Check 3: Semantic Equivalence Check

For each theorem and hypothesis node in the blueprint, compare:
- The `\\natural:` field (English description).
- The Lean declaration (formal statement).
- The corresponding entry in `{benchmark_dir}/source/problem_packet.json` (original LaTeX/NL
  statement for the main theorem) or the skeleton step's `statement` field.

Rate each as:
- `equivalent`: the formal statement faithfully captures the natural description.
- `minor_discrepancy`: small difference in quantifier order, implicit argument, or notation that
  does not change mathematical meaning.
- `major_discrepancy`: the formal statement captures a substantially different proposition.

For `major_discrepancy` cases: describe the mismatch concisely.

Use `loogle_search` to verify any mathlib definitions used in formal statements.

### Check 4: Graph Lint

Run the graph linter: `python {evaluation_dir}/claude_check_outline_graph.py {benchmark_dir}/outline/outline.json`

Also run the profile consistency checker for the primary profile:
`python {evaluation_dir}/claude_check_profile_consistency.py {benchmark_dir}/outline/outline.json {benchmark_dir}/outline/assumption_profile.json`

(If `{benchmark_dir}/profiles/{selected_profile}.json` also exists from packaging, you may use that instead.)

Record: pass/fail and any graph or profile errors.

### Check 5: Descendant Shell Check

Run `lake build` with the descendant shells file:
`{benchmark_dir}/validation/descendant_shells.lean`

If the shell file does not yet exist, note this and skip (shell generation is a prerequisite step).

Record: pass/fail, and any type errors in shells that indicate incoherent node statements.

### Step 6: Write reports

Write `{output_report_json}` as valid JSON:

```json
{{
  "problem_id": "{problem_id}",
  "profile_name": "{selected_profile}",
  "build_passed": true|false,
  "coverage_passed": true|false,
  "coverage_details": {{
    "total_nodes": <int>,
    "found": <int>,
    "missing": <int>,
    "malformed": <int>
  }},
  "semantic_issues": [
    {{
      "node": "<name>",
      "rating": "equivalent|minor_discrepancy|major_discrepancy",
      "description": "<description if not equivalent>"
    }}
  ],
  "graph_issues": ["<issue description>", "..."],
  "shell_issues": ["<type error description>", "..."],
  "warnings": ["<non-fatal warning>", "..."],
  "verdict": "DONE|CONTINUE"
}}
```

The `verdict` is `DONE` if and only if ALL of the following are true:
- `build_passed: true`
- `coverage_passed: true`
- No `major_discrepancy` in `semantic_issues`
- No errors in `graph_issues`
- No type errors in `shell_issues`

Write `{output_report_md}` as a human-readable Markdown summary.

## Hard Rules

- DO NOT replace any `sorry`.
- DO NOT call proof tactics to solve benchmark nodes.
- DO NOT enter proof-search mode.
- DO NOT modify `problem_blueprint.lean` — only read it.
- If a build failure is caused by a type annotation or import issue (not a `sorry` issue), you may
  fix the blueprint declaration syntax. You may NOT replace a theorem body that is `by sorry`.
- Shell elaboration failures indicate STATEMENT incoherence, not a missing proof.
- This check measures SPECIFICATION coherence, not actual provability.

## When Done

Print:
- Overall verdict: DONE or CONTINUE.
- Summary of each check result.
- List of any blocking issues that must be repaired.
