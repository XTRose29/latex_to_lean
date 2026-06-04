#!/usr/bin/env python3
"""
CLI tool to validate an outline.json dependency graph.

Usage:
    python check_outline_graph.py outline.json

Exit codes:
    0 = PASS (no errors; warnings may be present)
    1 = FAIL (one or more errors)
"""

import json
import sys
import os

from benchmark_pipeline.graph_lint import lint_outline_graph


def main():
    if len(sys.argv) != 2:
        print(f"Usage: python {os.path.basename(__file__)} <outline.json>")
        sys.exit(1)

    path = sys.argv[1]
    if not os.path.exists(path):
        print(f"Error: File not found: {path}")
        sys.exit(1)

    with open(path) as f:
        try:
            outline = json.load(f)
        except json.JSONDecodeError as e:
            print(f"Error: Invalid JSON in {path}: {e}")
            sys.exit(1)

    result = lint_outline_graph(outline)

    # Print human-readable output
    print(f"\n=== Outline Graph Lint: {path} ===\n")

    stats = result.stats
    print(f"Problem ID:  {outline.get('problem_id', '(unknown)')}")
    print(f"Main target: {stats.get('main_target', '(unknown)')}")
    print(f"Total nodes: {stats.get('total_nodes', 0)}")
    type_counts = stats.get("type_counts", {})
    for t in ("theorem", "hypothesis", "definition"):
        print(f"  {t}: {type_counts.get(t, 0)}")
    print()

    errors = result.errors()
    warnings = result.warnings()

    if errors:
        print(f"ERRORS ({len(errors)}):")
        for issue in errors:
            node_tag = f" [{issue.node}]" if issue.node else ""
            print(f"  ERROR{node_tag}: {issue.message}")
        print()

    if warnings:
        print(f"WARNINGS ({len(warnings)}):")
        for issue in warnings:
            node_tag = f" [{issue.node}]" if issue.node else ""
            print(f"  WARNING{node_tag}: {issue.message}")
        print()

    if result.passed:
        print(f"RESULT: PASS ({len(warnings)} warnings)")
    else:
        print(f"RESULT: FAIL ({len(errors)} errors, {len(warnings)} warnings)")

    sys.exit(0 if result.passed else 1)


if __name__ == "__main__":
    main()
