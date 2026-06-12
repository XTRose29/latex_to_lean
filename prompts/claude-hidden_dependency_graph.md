# Task: Hidden dependency graph review JSON only

You are reviewing a user-selected LaTeX block graph for missing mathematical
dependencies.

Read only these files:
- selected graph: `{edited_graph_file}`
- parsed LaTeX blocks: `{latex_blocks_file}`
- profile: `{profile_file}`

The selected graph already contains dependencies found by deterministic
`\ref{{...}}` / `\cref{{...}}` parsing and any user-selected extra blocks.

Write exactly one JSON object to:
`{output_file}`

Schema:
{{
  "problem_id": "{problem_id}",
  "method": "llm_hidden_dependency_review",
  "llm_review": "complete",
  "suggested_edges": [
    {{
      "source": "node id that is used as a dependency",
      "target": "node id that depends on source",
      "confidence": "high|medium|low",
      "reason": "short mathematical reason"
    }}
  ],
  "rejected_or_uncertain": [
    {{
      "source": "possible source id",
      "target": "possible target id",
      "reason": "why this was not suggested as an edge"
    }}
  ],
  "notes": "short summary"
}}

Rules:
- Return/write JSON only; no markdown fences.
- Do not invent new node ids. Use only node ids present in the selected graph.
- Do not suggest edges that already exist.
- Only suggest an edge when the target statement or proof intent appears to use
  the source statement, definition, notation, construction, or cited result.
- Prefer conservative edges. If unsure, put the candidate in `rejected_or_uncertain`.
- Edge direction is `source -> target`, meaning target depends on source.
- Do not write Lean code. Do not run shell commands.
