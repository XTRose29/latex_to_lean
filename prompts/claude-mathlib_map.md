# Task: Mathlib Mapping

## Objective

For each node in the outline graph, determine whether it corresponds exactly to
an existing mathlib result. Use `loogle_search` to check. Only report a node as
`existing` if you find a confirmed exact match via search. Mark everything else
as `uncertain` or `new-proof`. This is Stage 6 of the benchmark outline
pipeline.

Do not silently replace benchmark nodes with imported results. Do not guess.

## Inputs

- Problem ID: `{problem_id}`
- Outline file: `{outline_file}`
- Output file: `{output_file}`
- Project root: `{project_root}`

## What To Do

1. Read `{outline_file}`.
2. For each node, use `loogle_search` to search for exact mathlib counterparts.
   Use the node's `natural` description and any `mathlib_search_queries` from
   the skeleton as search inputs.
3. Classify each node as one of:
   - `existing`: you found a specific named mathlib lemma or theorem that
     matches this node's statement exactly or nearly exactly. Record the
     exact lemma name(s).
   - `glue`: a structural or notational step that directly connects two
     `existing` results with no additional proof content.
   - `new-proof`: specific local reasoning unlikely to be in mathlib as-is,
     with no close loogle search match.
   - `uncertain`: you could not determine the classification confidently.
     Use this when a search returns partial results, no results, or when
     you are not sure.

## Classification Rules — Important

- **Only mark `existing` if `loogle_search` returned a specific named lemma
  that matches exactly.** Do not use "likely in mathlib", "probably in
  mathlib", or similar hedging. If you are not sure, write `uncertain`.
- `uncertain` is the safe conservative default. Use it freely.
- `glue` requires that BOTH connected results are already `existing`.
- `new-proof` means you searched and found no match AND the step contains
  local proof content specific to this theorem.
- If `loogle_search` returns nothing, that is a signal toward `uncertain` or
  `new-proof`, not `existing`.

4. For `existing` nodes: list specific candidate lemma names from mathlib
   (e.g., `Nat.even_of_even_pow`, `Irrational.ne_rat`). Use `loogle_search`
   to confirm them.
5. For all nodes: suggest 2–3 refined mathlib search queries that a downstream
   formalization agent could use.
6. Write `{output_file}` as valid JSON:

```json
{{
  "problem_id": "{problem_id}",
  "nodes": [
    {{
      "name": "<node name from outline>",
      "classification": "existing|glue|new-proof|uncertain",
      "candidate_lemmas": ["<Mathlib.Module.Path.lemmaName>", "..."],
      "search_queries": ["<query 1>", "<query 2>"],
      "notes": "<brief honest explanation of classification>"
    }}
  ]
}}
```

## Hard Rules

- Do not replace or modify any node in the outline.
- Do not mark a node `existing` and then remove it from the benchmark.
  Classification is advisory only. The human decides which nodes to assume.
- Do not attempt any Lean proofs.
- Use `loogle_search` actively — do not infer mathlib lemma names without
  searching.
- Report the actual search queries you used, not theoretical queries.
- `candidate_lemmas` must be empty `[]` for `uncertain` and `new-proof` nodes.

## When Done

Print a brief summary:
- Classification counts: existing / glue / new-proof / uncertain.
- Any `existing` nodes with confirmed lemma names.
- Nodes classified as `new-proof` (genuine benchmark obligations).
