# Task: Descendant Shell Generation

## Objective

Generate a temporary Lean file containing shell theorem declarations for selected downstream nodes.
These shells test that the blueprint's formal statements elaborate consistently in a larger
dependency structure. This is a structural coherence check only — no proofs are attempted.

## Inputs

- Problem ID: `{problem_id}`
- Blueprint Lean file: `{blueprint_lean_file}`
- Spec contracts file: `{spec_contracts_file}`
- Output file: `{output_file}` (the scratch shell file to write)
- Lean project root: `{lean_project_root}`

## What To Do

1. Read `{blueprint_lean_file}` and `{spec_contracts_file}`.
2. For each `shell_stub` in the spec contracts, include it in the output file.
3. Add a header importing the blueprint file (or the project root's main import).
4. Run `lake build` with the shell file present to confirm elaboration succeeds.
5. If `lake build` fails:
   - Diagnose whether the failure is a TYPE error in the shell (indicating an incoherent node
     statement) or a SYNTAX error (fix the shell syntax).
   - Do NOT fix failures by modifying the blueprint. Do NOT replace sorry. Do NOT attempt proofs.
   - Record each type error as an incoherence issue in a brief report section at the top of the
     file as a comment.
6. Write `{output_file}` as a Lean 4 file:

```lean
-- Descendant shells for {problem_id}
-- These are temporary coherence-check declarations only.
-- All bodies are `by sorry`. Do not attempt to prove these.

import <project root main import>

namespace Shell_{problem_id}

-- shell stubs from spec contracts, one per node
<shell_stub_1>

<shell_stub_2>

end Shell_{problem_id}
```

## Hard Rules

1. Every shell declaration in this file must end with `:= by sorry`.
2. Do not insert any tactic beyond `by sorry`.
3. Do not modify the canonical blueprint file (`problem_blueprint.lean`).
4. Do not attempt to prove any shell theorem.
5. Do not attempt to prove any benchmark theorem.
6. This file is TEMPORARY and is used ONLY for coherence checking. It will not be part of the
   final benchmark bundle.
7. If the build passes with these shells, that confirms structural coherence.
8. If the build fails due to type errors in the shells, this flags incoherent statements in the
   blueprint for the spec repairer.

## When Done

Print:
- Number of shell stubs included.
- `lake build` result (pass/fail).
- If failed: list each type error with the node name it affects.
- Confirm: "No `sorry` was replaced. No proof was attempted."
