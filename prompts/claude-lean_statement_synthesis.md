# Task: Lean statement synthesis JSON only

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
