# Task: Specification Verdict

## Objective

Read the specification validation report and return a single-word verdict: `DONE` or `CONTINUE`.

Return `DONE` only if the benchmark specification is fully coherent and ready for downstream use.
Return `CONTINUE` if any blocking issue remains.

## Inputs

- Problem ID: `{problem_id}`
- Validation report file: `{validation_report_file}`

## Criteria For DONE

Return `DONE` if and only if ALL of the following are true:

1. `build_passed` is `true`.
2. `coverage_passed` is `true`.
3. `semantic_issues` contains no entry with `rating: major_discrepancy`.
4. `graph_issues` is empty or contains only warnings (no errors).
5. `shell_issues` is empty (no type errors from descendant shells).
6. No critical profile inconsistency is present.

Return `CONTINUE` in all other cases.

## What To Do

1. Read `{validation_report_file}`.
2. Check each criterion above.
3. Output a brief list of which criteria passed and which failed.
4. On the final line, output exactly one word: `DONE` or `CONTINUE`.

## Output Format

```
Build check: PASS/FAIL
Coverage check: PASS/FAIL
Semantic issues: <count> major discrepancies
Graph issues: <count> errors
Shell issues: <count> type errors
Profile consistency: PASS/FAIL

DONE
```

or

```
Build check: PASS
Coverage check: PASS
Semantic issues: 1 major discrepancy (NodeName: ...)
Graph issues: 0 errors
Shell issues: 0 type errors
Profile consistency: PASS

CONTINUE
```

The final line must be exactly `DONE` or `CONTINUE` with no other text on that line.
