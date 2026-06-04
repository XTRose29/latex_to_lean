# Task: Problem Packet Extraction

## Objective

Extract a single theorem-plus-proof unit from an extracted chapter text and normalize it into a
structured `problem_packet.json`. This is Stage 1 of the benchmark outline pipeline.

Do not create any Lean code. Do not decide final benchmark structure. Only normalize one proof unit
so later stages can reason cleanly.

## Inputs

- Chapter text: `{chapter_text_file}` (full extracted chapter text)
- Theorems-and-defs file: `{theorems_and_defs_file}` (extracted theorem/definition blocks)
- Target theorem label: `{theorem_label}`
- Output file: `{output_file}`
- Project root: `{project_root}`

## What To Do

1. Read `{chapter_text_file}` to get full context.
2. Read `{theorems_and_defs_file}` to find available theorem and definition blocks.
3. Locate the theorem identified by `{theorem_label}` (or the most prominent theorem in the chapter
   if no label is given).
4. Extract the exact LaTeX source of the theorem statement.
5. Find the associated proof text in the chapter (search after the theorem block for
   `\begin{{proof}}...\end{{proof}}` or inline proof text that follows the theorem).
6. Gather:
   - All nearby definitions that the theorem depends on (definitions introduced in the same chapter
     section or referenced by name in the proof).
   - Any local notation specific to this theorem or proof.
   - The start and end line numbers of the theorem block in the chapter text.
7. Identify ambiguities:
   - Is the proof complete or abbreviated (e.g., "see exercise", "analogous to", "it is clear")?
   - Are there implicit intermediate claims not stated as lemmas?
   - Is local notation overloaded?
8. Write `{output_file}` as a valid JSON file matching this schema:

```json
{{
  "problem_id": "<slug derived from chapter and theorem, e.g. ch{ch_num}_<theorem_name>_01>",
  "chapter_id": "ch{ch_num}",
  "source_file": "{chapter_text_file}",
  "theorem_label": "<LaTeX label if present, else inferred name>",
  "latex_quote": "<exact LaTeX text of \\begin{{theorem}}...\\end{{theorem}}>",
  "natural_statement": "<clear English statement of the theorem>",
  "proof_text": "<extracted proof text, verbatim where possible>",
  "local_definitions": ["<definition 1 text>", "..."],
  "local_notation": ["<notation item>", "..."],
  "source_span": {{
    "start_line": <int>,
    "end_line": <int>
  }},
  "ambiguities": ["<ambiguity description>", "..."]
}}
```

## Hard Rules

- Do not write any Lean code.
- Do not invent proof steps not present in the source text.
- Do not decide which nodes should be assumptions — that is Stage 3.
- Preserve the exact LaTeX source in `latex_quote` without paraphrasing.
- `natural_statement` must faithfully capture the full theorem (hypotheses + conclusion).
- If the proof is missing, set `proof_text` to the empty string and record the missing proof as an
  ambiguity.
- `local_definitions` should list only definitions that appear in the same chapter section and that
  the proof explicitly uses or references.
- The `problem_id` should be a stable lowercase slug using underscores, no spaces.

## When Done

Print a brief summary:
- The `problem_id` assigned.
- The `theorem_label` found.
- The number of local definitions gathered.
- Whether the proof text was found (yes/no).
- Any ambiguities flagged.
