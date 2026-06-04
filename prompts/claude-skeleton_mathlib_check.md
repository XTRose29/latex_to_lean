# Task: Conservative Mathlib Verification of Skeleton Nodes

## Objective

For each step in the proof skeleton, determine whether it corresponds exactly to
an existing mathlib result. Use `loogle_search` to check. Only report a node as
`existing` if you find a concrete exact match. Mark everything else as
`uncertain`. Do not guess.

This stage exists to inform the human who will make profile decisions in the
next step. The results are advisory. The human — not the model — decides which
nodes become assumptions.

This is Stage 3 of the benchmark outline pipeline.

## Inputs

- Problem ID: `{problem_id}`
- Skeleton file: `{skeleton_file}`
- Output file: `{output_file}`
- Project root: `{project_root}`

## What To Do

1. Read `{skeleton_file}`.
2. For each step in `steps`, use `loogle_search` to search for an exact mathlib
   counterpart.
   - Use the step's `mathlib_search_queries` field if present.
   - Also try the step's `statement` as a search phrase.
3. Classify each step as exactly one of:
   - `existing`: you found a specific, named mathlib lemma or theorem that
     matches this step's statement exactly or nearly exactly. Record the lemma
     name(s).
   - `uncertain`: you could not find a confirmed exact match. This includes:
     - "probably in mathlib but no exact match found",
     - "close but not identical",
     - "requires custom arguments",
     - anything you are not certain about.

## Classification Rules — Important

- **Do NOT use `existing` unless you found a specific named lemma via
  `loogle_search` that matches exactly.**
- Do NOT write "likely in mathlib", "probably in mathlib", or similar hedging
  language. A step is either `existing` (confirmed exact match found) or
  `uncertain` (everything else).
- Do NOT infer `existing` from the topic area alone. A step about continuity is
  not automatically `existing` — only mark it `existing` if you found the
  specific lemma that states it.
- There is no `glue`, `new-proof`, or similar category here. Those distinctions
  are made later. Only `existing` or `uncertain`.
- If `loogle_search` returns no results, mark the step `uncertain`. Do not guess.
- If `loogle_search` returns partial matches, mark the step `uncertain` and note
  the closest partial match found.

## Output Format

Write `{output_file}` as valid JSON:

```json
{{
  "problem_id": "{problem_id}",
  "nodes": [
    {{
      "name": "<step id from skeleton>",
      "classification": "existing|uncertain",
      "candidate_lemmas": ["<exact.Mathlib.Lemma.Name>", "..."],
      "search_queries_used": ["<query>", "..."],
      "notes": "<one sentence: what was found or why uncertain>"
    }}
  ]
}}
```

- `candidate_lemmas` must be empty `[]` for `uncertain` nodes.
- `candidate_lemmas` must be exact mathlib lemma identifiers for `existing`
  nodes (e.g., `Nat.even_mul_succ_self`, `Irrational.ne_rat`).
- `notes` must be honest. For `uncertain`, say what you searched and what you
  found (or did not find).

## Hard Rules

- Do not produce an `existing` classification without a confirmed loogle search
  result.
- Do not modify the skeleton file.
- Do not emit Lean code or proof attempts.
- Do not decide which nodes should be assumed — that is the human's decision.
- If a node's statement is custom or domain-specific, it is `uncertain` unless
  you found an exact match.

## When Done

Print a brief summary:
- Total steps checked.
- Number classified `existing` (with confirmed mathlib match).
- Number classified `uncertain`.
- List any `existing` classifications with the lemma names found.
