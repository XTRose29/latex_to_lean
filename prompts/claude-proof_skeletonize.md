# Task: Proof Skeletonization

## Objective

Convert a human proof (from `problem_packet.json`) into an explicit sequence of mathematical steps
suitable for dependency graph construction. This is Stage 2 of the benchmark outline pipeline.

Do not emit any Lean code. Do not collapse a long proof into one summary block. Preserve traceability
to the source text.

## Inputs

- Problem packet: `{problem_packet_file}`
- Output file: `{output_file}`
- Project root: `{project_root}`

{reskeletonize_feedback}
## Step kinds

Each step must be assigned one of these kinds:

- `reduction` — "It suffices to show X" or "This reduces to Y"
- `claim` — An intermediate proposition that needs separate justification
- `construction` — "Define X by..." or "Let X be..." (introduces a named object)
- `case_split` — A proof by cases, by contradiction, or by induction setup
- `application` — "By Theorem X..." or "Applying Lemma Y..." (cites a named result)
- `contradiction` — The move that derives the contradiction in a proof by contradiction
- `unpack` — "Unfolding the definition of X..."
- `simplification` — A routine algebraic, arithmetic, or logical simplification

---

## Phase 1: Draft Decomposition

Read `{problem_packet_file}`. Work through the `proof_text` field sentence by sentence.

For each mathematical move you identify, record it as a draft step. At this stage, write your
draft steps in plain prose — do NOT write the output JSON yet.

For each draft step, ask:

1. What mathematical proposition does this step establish?
2. Which earlier steps does it depend on?
3. What kind is it (`reduction`, `claim`, `construction`, ...)?
4. Is the source proof citing a deep external theorem by name?
5. Is anything left implicit that is logically necessary?

Add any implicit steps the proof silently relies on — mark them clearly as implicit.

---

## Phase 2: Self-Review

Before writing the output file, review every draft step against this checklist. Work through
ALL steps in order.

**For every step rated `large` or `medium`:**

- [ ] Does the statement contain "and" (a conjunction of two separate propositions)?
      → If yes: split into two steps, one per conjunct.
- [ ] Does the step establish a proposition AND also justify it in one sentence?
      → If yes: keep the proposition as a `claim`, add a separate step for the justification.
- [ ] Does the step cite or use more than one named external theorem?
      → If yes: split so each theorem application is its own `application` step.
- [ ] Does the step bundle a construction ("Let X be...") with a correctness proof?
      → If yes: split into a `construction` step and a separate `claim` step.
- [ ] Does the step hide a reusable intermediate lemma — a proposition that would make sense
      as a standalone result?
      → If yes: extract it as a separate `claim` step.

**For every step of any size:**

- [ ] Is the `proof_intent` specific enough that someone could prove this step independently,
      without reading adjacent steps?
      → If not: sharpen the statement or split the step.
- [ ] Is the step vacuous (just restates the goal without content)?
      → If yes: delete it.

**Revision rule:** If the checklist triggers a split, replace the original draft step with two
or more finer steps before proceeding. Renumber dependencies accordingly.

After completing the review, you should have a revised list of steps. A step surviving review
with `granularity: large` must be a genuinely indivisible large argument, not a compressed one.

---

## Phase 3: Write Output

Write `{output_file}` as valid JSON using the revised step list from Phase 2:

```json
{{
  "problem_id": "<from problem packet>",
  "target_statement": "<from problem packet natural_statement>",
  "steps": [
    {{
      "id": "short_meaningful_snake_case_id",
      "kind": "reduction|claim|construction|case_split|application|contradiction|unpack|simplification",
      "statement": "<precise mathematical content of this step>",
      "depends_on": ["step_N", "..."],
      "proof_intent": "<one sentence: what does this step achieve and why is it needed?>",
      "evidence_from_source": "<short quote or paraphrase from proof_text, or 'implicit'>",
      "assumption_candidate": true|false,
      "granularity": "small|medium|large",
      "mathlib_search_queries": ["<query 1>", "..."]
    }}
  ],
  "implicit_steps_added": ["<description of each implicit step added>"],
  "ambiguities": ["<anything unclear or potentially missing from the proof>"]
}}
```

Steps must be listed in logical order: if step B depends on step A, then A appears first.

Use meaningful, stable, Lean-safe step IDs instead of generic IDs like `step_1`.
Good IDs are short lower_snake_case summaries of the mathematical move, for example
`prove_contrapositive`, `odd_integer_witness`, `expand_square`, or
`apply_maximum_principle`. IDs must start with a letter and use only ASCII letters,
digits, and underscores. Dependencies must refer to these same IDs exactly.

---

## Assumption Candidate Rules

Mark a step `assumption_candidate: true` if:

- The source proof cites a deep theorem by name (e.g., "By the Jordan curve theorem...",
  "By Zorn's lemma...", "By the Arzelà-Ascoli theorem...").
- The argument requires substantial external infrastructure to formalize from scratch.
- The step is omitted, compressed, or explicitly delegated to another reference.
- Formalizing the step in full would dominate the benchmark and obscure the target.

A step with `assumption_candidate: true` still gets its own node — it becomes a `hypothesis`
node that the human may choose to assume in Stage 4.

## Granularity Rules

- `small`: A single direct move — one definition unpack, one named theorem application, one
  routine algebraic step, one direct logical deduction.
- `medium`: A local argument that bundles 2–3 small moves — one case split, one construction
  with a short correctness argument, one deduction with an inline calculation.
- `large`: A genuinely substantial sub-argument — multiple cases, a nontrivial reduction
  requiring its own sub-lemma, an appeal to deep background that the proof handles in a
  paragraph.

When in doubt between `medium` and `large`, choose `large` and flag it for self-review.

## Hard Rules

- Do not emit any Lean code or tactic suggestions.
- Do not collapse several proof paragraphs into one opaque step.
- Record all steps in logical order; `depends_on` must reference only earlier steps.
- Do not invent mathematical content — every step must be traceable to the source proof or
  be explicitly marked as an implicit step.
- A step with `granularity: large` that survived Phase 2 self-review must have a comment in
  `proof_intent` explaining why it cannot be split further.

## When Done

Print a brief summary:
- Total steps after Phase 2 revision (and how many the Phase 2 review added).
- Number of implicit steps added.
- Number of assumption candidates flagged.
- Number of steps that were split during Phase 2 self-review.
- Any ambiguities.
