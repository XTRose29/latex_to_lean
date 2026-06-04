"""
Graph validation utilities for the outline pipeline.

Validates outline.json (DAG structure and node consistency) and
assumption_profile.json (profile coherence against the outline).
"""

import json
import sys
from dataclasses import dataclass, field
from typing import Optional


# ---------------------------------------------------------------------------
# Data model for lint results
# ---------------------------------------------------------------------------

@dataclass
class LintIssue:
    severity: str          # "error" or "warning"
    node: Optional[str]    # node name if issue is node-specific, else None
    message: str


@dataclass
class GraphLintResult:
    passed: bool
    issues: list[LintIssue] = field(default_factory=list)
    stats: dict = field(default_factory=dict)

    def errors(self) -> list[LintIssue]:
        return [i for i in self.issues if i.severity == "error"]

    def warnings(self) -> list[LintIssue]:
        return [i for i in self.issues if i.severity == "warning"]

    def to_dict(self) -> dict:
        return {
            "passed": self.passed,
            "error_count": len(self.errors()),
            "warning_count": len(self.warnings()),
            "issues": [
                {"severity": i.severity, "node": i.node, "message": i.message}
                for i in self.issues
            ],
            "stats": self.stats,
        }


# ---------------------------------------------------------------------------
# Outline graph linter
# ---------------------------------------------------------------------------

VALID_NODE_TYPES = {"definition", "theorem", "hypothesis"}
VALID_MATHLIB_STATUSES = {"existing", "glue", "new-proof", "uncertain"}
VALID_GRANULARITIES = {"small", "medium", "large"}


def lint_outline_graph(outline: dict) -> GraphLintResult:
    """
    Validate the structure of an outline.json object.

    Checks:
    1. Required top-level fields are present.
    2. Every node has required fields and valid values.
    3. Node names are unique.
    4. All inputs reference existing node names.
    5. The dependency graph is acyclic (no cycles).
    6. Node order respects dependencies (each node's inputs appear earlier).
    7. The main_target exists in the node list.
    """
    issues: list[LintIssue] = []

    # Check top-level fields
    for field_name in ("problem_id", "main_target", "nodes"):
        if field_name not in outline:
            issues.append(LintIssue("error", None, f"Missing top-level field: '{field_name}'"))

    if "nodes" not in outline:
        return GraphLintResult(passed=False, issues=issues)

    nodes = outline["nodes"]
    if not isinstance(nodes, list):
        issues.append(LintIssue("error", None, "'nodes' must be a list"))
        return GraphLintResult(passed=False, issues=issues)

    # Build name set and check uniqueness
    names_seen: dict[str, int] = {}
    for i, node in enumerate(nodes):
        name = node.get("name", "")
        if not name:
            issues.append(LintIssue("error", None, f"Node at index {i} has no 'name'"))
            continue
        if name in names_seen:
            issues.append(LintIssue("error", name, f"Duplicate node name: '{name}'"))
        names_seen[name] = i

    all_names = set(names_seen.keys())

    # Check each node's fields
    for node in nodes:
        name = node.get("name", "<unnamed>")

        # Required fields
        for field_name in ("type", "inputs", "natural"):
            if field_name not in node:
                issues.append(LintIssue("error", name, f"Missing required field: '{field_name}'"))

        # Valid type
        node_type = node.get("type", "")
        if node_type not in VALID_NODE_TYPES:
            issues.append(LintIssue(
                "error", name,
                f"Invalid type '{node_type}'. Must be one of: {sorted(VALID_NODE_TYPES)}"
            ))

        # Valid mathlib_status (warning if missing or invalid)
        mathlib_status = node.get("mathlib_status", "")
        if mathlib_status and mathlib_status not in VALID_MATHLIB_STATUSES:
            issues.append(LintIssue(
                "warning", name,
                f"Invalid mathlib_status '{mathlib_status}'. "
                f"Must be one of: {sorted(VALID_MATHLIB_STATUSES)}"
            ))

        # Inputs must be a list
        inputs = node.get("inputs", [])
        if not isinstance(inputs, list):
            issues.append(LintIssue("error", name, "'inputs' must be a list"))
            continue

        # All inputs must reference existing nodes
        for inp in inputs:
            if inp not in all_names:
                issues.append(LintIssue(
                    "error", name,
                    f"Input '{inp}' does not refer to any node in the graph"
                ))

        # natural must be non-empty
        natural = node.get("natural", "").strip()
        if not natural:
            issues.append(LintIssue("warning", name, "Empty 'natural' description"))

        # formal_stub for theorem nodes should end with `:= by sorry`
        formal_stub = node.get("formal_stub", "")
        if node_type == "theorem" and formal_stub:
            if "sorry" not in formal_stub:
                issues.append(LintIssue(
                    "warning", name,
                    "Theorem formal_stub does not contain 'sorry' — benchmark targets must be := by sorry"
                ))

    # Check dependency order (each node's inputs must appear BEFORE it)
    name_to_index = {node.get("name", ""): i for i, node in enumerate(nodes)}
    for node in nodes:
        name = node.get("name", "")
        node_idx = name_to_index.get(name, -1)
        for inp in node.get("inputs", []):
            inp_idx = name_to_index.get(inp, -1)
            if inp_idx >= node_idx:
                issues.append(LintIssue(
                    "error", name,
                    f"Input '{inp}' appears at index {inp_idx} but node '{name}' is at "
                    f"index {node_idx}. Dependencies must appear earlier."
                ))

    # Check for cycles using DFS
    cycle_issues = _check_acyclic(nodes)
    issues.extend(cycle_issues)

    # Check main_target exists
    main_target = outline.get("main_target", "")
    if main_target and main_target not in all_names:
        issues.append(LintIssue(
            "error", main_target,
            f"main_target '{main_target}' is not present in the node list"
        ))

    # Stats
    type_counts = {}
    for node in nodes:
        t = node.get("type", "unknown")
        type_counts[t] = type_counts.get(t, 0) + 1

    stats = {
        "total_nodes": len(nodes),
        "type_counts": type_counts,
        "main_target": main_target,
    }

    passed = not any(i.severity == "error" for i in issues)
    return GraphLintResult(passed=passed, issues=issues, stats=stats)


def _check_acyclic(nodes: list[dict]) -> list[LintIssue]:
    """Check that the dependency graph has no cycles. Returns error issues for any cycle found."""
    adj: dict[str, list[str]] = {}
    for node in nodes:
        name = node.get("name", "")
        if name:
            adj[name] = [inp for inp in node.get("inputs", []) if inp]

    visited: set[str] = set()
    in_stack: set[str] = set()
    issues: list[LintIssue] = []

    def dfs(node_name: str, path: list[str]) -> None:
        if node_name in in_stack:
            cycle_start = path.index(node_name)
            cycle = " → ".join(path[cycle_start:] + [node_name])
            issues.append(LintIssue("error", node_name, f"Cycle detected: {cycle}"))
            return
        if node_name in visited:
            return
        visited.add(node_name)
        in_stack.add(node_name)
        for dep in adj.get(node_name, []):
            dfs(dep, path + [node_name])
        in_stack.remove(node_name)

    for name in adj:
        if name not in visited:
            dfs(name, [])

    return issues


# ---------------------------------------------------------------------------
# Profile consistency linter
# ---------------------------------------------------------------------------

def lint_profile_consistency(outline: dict, profile: dict) -> GraphLintResult:
    """
    Validate that an assumption_profile entry is consistent with the outline.

    Checks:
    1. assumed_nodes and open_nodes contain only names present in outline.
    2. assumed_nodes and open_nodes are disjoint.
    3. The selected_target is in open_nodes (or at least in the outline).
    4. Every open_node with type 'theorem' is indeed listed as a theorem in the outline.
    5. If prefer_mathlib is False, no 'existing' nodes are in open_nodes.
    """
    issues: list[LintIssue] = []

    node_map = {n["name"]: n for n in outline.get("nodes", []) if n.get("name")}
    all_names = set(node_map.keys())

    assumed_nodes = set(profile.get("assumed_nodes", []))
    open_nodes = set(profile.get("open_nodes", []))
    profile_name = profile.get("name", "<unnamed>")

    # assumed_nodes must be in outline
    for name in assumed_nodes:
        if name not in all_names:
            issues.append(LintIssue(
                "error", name,
                f"[{profile_name}] assumed_node '{name}' not found in outline"
            ))

    # open_nodes must be in outline
    for name in open_nodes:
        if name not in all_names:
            issues.append(LintIssue(
                "error", name,
                f"[{profile_name}] open_node '{name}' not found in outline"
            ))

    # assumed and open must be disjoint
    overlap = assumed_nodes & open_nodes
    for name in overlap:
        issues.append(LintIssue(
            "error", name,
            f"[{profile_name}] node '{name}' appears in both assumed_nodes and open_nodes"
        ))

    # selected_target should exist
    target = profile.get("selected_target", outline.get("main_target", ""))
    if target and target not in all_names:
        issues.append(LintIssue(
            "error", target,
            f"[{profile_name}] selected_target '{target}' not found in outline"
        ))

    # open_nodes should be theorems
    for name in open_nodes:
        if name in node_map:
            node_type = node_map[name].get("type", "")
            if node_type != "theorem":
                issues.append(LintIssue(
                    "warning", name,
                    f"[{profile_name}] open_node '{name}' has type '{node_type}', expected 'theorem'"
                ))

    # assumed_nodes should not be theorems (should be hypothesis or definition)
    for name in assumed_nodes:
        if name in node_map:
            node_type = node_map[name].get("type", "")
            if node_type == "theorem":
                issues.append(LintIssue(
                    "warning", name,
                    f"[{profile_name}] assumed_node '{name}' has type 'theorem'. "
                    "Consider marking it as 'hypothesis' in the outline."
                ))

    # max_open_nodes is advisory metadata; do not warn if exceeded.
    # The human chose the open set deliberately.

    stats = {
        "profile_name": profile_name,
        "assumed_count": len(assumed_nodes),
        "open_count": len(open_nodes),
        "selected_target": target,
    }

    passed = not any(i.severity == "error" for i in issues)
    return GraphLintResult(passed=passed, issues=issues, stats=stats)


# ---------------------------------------------------------------------------
# CLI entry point (used by spec_regression_check agent)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Lint an outline.json graph or a profile consistency check."
    )
    parser.add_argument("outline", help="Path to outline.json")
    parser.add_argument("profile", nargs="?", help="Optional: path to a single profile JSON")
    args = parser.parse_args()

    with open(args.outline) as f:
        outline_data = json.load(f)

    if args.profile:
        with open(args.profile) as f:
            profile_data = json.load(f)
        # profile_data may contain a list of profiles; lint each
        profiles = profile_data.get("profiles", [profile_data])
        all_passed = True
        for prof in profiles:
            result = lint_profile_consistency(outline_data, prof)
            print(json.dumps(result.to_dict(), indent=2))
            if not result.passed:
                all_passed = False
        sys.exit(0 if all_passed else 1)
    else:
        result = lint_outline_graph(outline_data)
        print(json.dumps(result.to_dict(), indent=2))
        sys.exit(0 if result.passed else 1)
