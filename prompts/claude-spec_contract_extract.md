# Task: Spec Contract Extraction

## Objective

For each node in the outline graph, summarize its intended downstream usage so that the descendant
shell generator can create syntactically coherent test shells. This is Stage 7.5 of the benchmark outline pipeline. It is a coherence-check
support stage, not a proof attempt. The assumption profile used here is
human-authored.

Do not attempt any proofs. Do not solve any benchmark theorems. The purpose of this stage is to
clarify how each node is USED by downstream nodes, so that shell declarations elaborate correctly.

## Inputs

- Problem ID: `{problem_id}`
- Outline file: `{outline_file}`
- Assumption profile file: `{assumption_profile_file}`
- Selected profile: `{selected_profile}`
- Blueprint Lean file: `{blueprint_lean_file}`
- Output file: `{output_file}`

## What To Do

1. Read all inputs.
2. For each node in `{outline_file}`, determine:
   - What TYPE does the node produce? (a Prop, a Set, a function type, a structure, etc.)
   - How do downstream nodes USE this node? (as a hypothesis in a theorem statement, as a type
     argument, as a function applied to an argument, etc.)
   - What PARAMETERS does the node take? (extracted from the `formal_stub` or blueprint declaration).
3. For each node, write a "spec contract" describing the downstream interface.
4. Write `{output_file}` as valid JSON:

```json
{{
  "problem_id": "{problem_id}",
  "selected_profile": "{selected_profile}",
  "contracts": [
    {{
      "name": "<node name>",
      "produces": "<description of the type/value the node produces>",
      "parameter_sketch": "<type signature sketch of the node's parameters>",
      "downstream_usage": [
        {{
          "used_by": "<downstream node name>",
          "role": "<how this node is used: as_hypothesis | as_type | as_function | as_value>"
        }}
      ],
      "shell_stub": "<a syntactically valid Lean 4 skeleton theorem that uses this node, ending := by sorry>"
    }}
  ]
}}
```

## Shell Stub Rules

For each node, `shell_stub` is a TEMPORARY test declaration of the form:

```lean
-- Shell: downstream usage test for NodeName
theorem _shell_NodeName_usage
    (h : NodeName ...)  -- or whatever the correct usage is
    : True := by sorry
```

The purpose is not to prove anything. The purpose is to confirm that `NodeName` has the right type
signature to be used the way downstream nodes expect.

If a node is a `definition` that produces a type, the shell might instead be:

```lean
-- Shell: type formation test for NodeName
example (x : NodeName ...) : True := by sorry
```

## Hard Rules

- Do not attempt any proofs.
- Do not insert any tactic beyond `by sorry`.
- Do not modify the blueprint or outline files.
- Shell stubs must end with `:= by sorry`.
- This stage is for coherence checking only. It does NOT produce benchmark artifacts.

## When Done

Print a brief summary:
- Number of contracts produced.
- Number of shell stubs generated.
- Any nodes for which you could not determine downstream usage (mark as `role: unknown`).
