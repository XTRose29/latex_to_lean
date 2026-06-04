# Task: Dependency Graph Construction

## Objective

Convert the proof skeleton and the human-authored assumption profile into a
formal graph of nodes suitable for Lean blueprint emission. Each node gets a
type (`definition`, `theorem`, `hypothesis`), a name, explicit dependencies,
and a formal stub. This is Stage 5 of the benchmark outline pipeline.

## Inputs

- Problem ID: `{problem_id}`
- Skeleton file: `{skeleton_file}`
- Assumption profile file: `{assumption_profile_file}`
- Selected profile name: `{selected_profile}`
- Output file: `{output_file}`
- Project root: `{project_root}`

## What To Do

1. Read `{skeleton_file}` and `{assumption_profile_file}`.
2. Identify the profile named `{selected_profile}` in the assumption profile.
3. For each step in the skeleton, decide its node type:
   - `hypothesis`: the step is listed in `assumed_nodes` in the selected
     profile. These are background facts the human has chosen to assume.
   - `definition`: the step introduces a mathematical object, structure, or
     notation binding (kind is `construction` and introduces a named object
     that other steps reference).
   - `theorem`: the step is a proposition that will remain open for later
     formalization (listed in `open_nodes` in the selected profile, OR is
     neither assumed nor a pure definition).
4. Unify steps that refer to the same mathematical object into a single node
   when appropriate. For example, if two steps both unpack the definition of
   "compactness", merge them.
5. Assign a unique CamelCase name to every node. Names must:
   - Be valid Lean identifiers (no spaces, no special characters except
     underscores).
   - Clearly describe the mathematical content.
   - **Not shadow Mathlib namespace roots.** The following identifiers are
     reserved Mathlib namespace roots — never use them as node names:
     `Real`, `Complex`, `Nat`, `Int`, `Rat`, `Set`, `Finset`, `Multiset`,
     `List`, `Array`, `Map`, `Function`, `Filter`, `Topology`, `Metric`,
     `Measure`, `MeasureTheory`, `Algebra`, `Ring`, `Field`, `Group`,
     `Module`, `LinearMap`, `Matrix`, `Polynomial`, `Prime`, `Even`, `Odd`,
     `Continuous`, `Differentiable`, `Integrable`.
   - If your chosen name would collide with a Mathlib root, prefix it with
     the theorem name slug (e.g., `MyThm_Real` not `Real`).
6. For every node, list its `inputs`: the names of nodes this node depends on
   directly. Rules:
   - Every input must be the name of another node in this graph.
   - The graph must be acyclic.
   - Node order in the output must respect dependencies (dependencies listed
     before dependents).
7. Write a brief `formal_stub` for each node:
   - For `definition` nodes: `def NodeName ... := ...` (fill in what you can
     from context; use `_` for unknown types or values).
   - For `theorem` nodes: `theorem NodeName ... : ... := by sorry`
   - For `hypothesis` nodes: `def NodeName : Prop := ...` (or a Prop-valued
     def). These represent assumed facts.
   - Keep stubs brief — they are later refined by the blueprint emission agent.
   - **Prefer `_` over guessing.** Whenever you are uncertain about a type,
     universe, or implicit argument in a `formal_stub`, write `_` rather than
     inventing a plausible-looking Lean type. A stub with `_`s that Lean can
     elaborate is far better than a confident wrong type that causes a
     compile error. This applies to both the binder types and the return type.
8. Write `{output_file}` as valid JSON:

```json
{{
  "problem_id": "{problem_id}",
  "selected_profile": "{selected_profile}",
  "main_target": "<name of the primary benchmark target node>",
  "nodes": [
    {{
      "name": "<CamelCase unique node name>",
      "type": "definition|theorem|hypothesis",
      "inputs": ["<node name>", "..."],
      "natural": "<clear one-sentence English description of this node>",
      "formal_stub": "<Lean 4 stub declaration>",
      "NL_proof": "<natural language proof sketch if this is a theorem, else empty string>",
      "source_step_ids": ["step_N", "..."],
      "assumption_candidate": true|false,
      "granularity": "small|medium|large",
      "mathlib_status": "existing|uncertain"
    }}
  ]
}}
```

## Node Graph Rules

1. Every node must have a unique name.
2. Every name in `inputs` must be the name of another node in this graph.
3. The graph must be acyclic — no node may transitively depend on itself.
4. Node order in `nodes` must respect dependencies: a node's inputs must all
   appear earlier.
5. The `main_target` node should depend only on earlier allowed nodes.
6. Hypothesis nodes (assumed facts) should appear early, with `inputs: []` or
   only other hypothesis inputs.
7. If the same mathematical object appears in multiple steps, unify into a
   single node.
8. Do not create a node for a step that is vacuous or that simply states the
   goal without content.

## Mathlib Status

For `mathlib_status`, use only these two values:

- `existing`: the step matches an exact mathlib lemma (this should come from
  the skeleton's annotation or from the Stage 3 mathlib verification results
  if available). Only use `existing` for confirmed matches.
- `uncertain`: anything else. Use this when you are not sure. Do not use
  "likely", "probably", or similar hedging — mark it `uncertain` instead.

Do not guess. `uncertain` is the safe default.

## Hard Rules

- Do not emit complete Lean proofs. Theorem stubs use `by sorry`.
- Do not attempt any proof search.
- Every `formal_stub` for a theorem node must end with `:= by sorry`.
- Every `formal_stub` for a hypothesis node must be a `def NodeName : Prop := ...`
  or equivalent.
- Hypothesis nodes represent ASSUMED facts chosen by the human. Their stubs are
  `def` declarations of the proposition, not proofs of it.

## When Done

Print a brief summary:
- Total number of nodes.
- Number of each type (definition / theorem / hypothesis).
- List of open theorem nodes by name.
- Whether the graph is acyclic (you should verify this by checking for cycles).
