#!/usr/bin/env python3
"""
CLI tool to validate an assumption profile against an outline.json.

Usage:
    python check_profile_consistency.py outline.json profile.json

    `profile.json` may be either:
    - A full assumption_profile.json with a "profiles" list, or
    - A single profile object (e.g., the contents of profiles/medium.json).

Exit codes:
    0 = PASS (all profiles valid, no errors)
    1 = FAIL (one or more errors in any profile)
"""

import json
import sys
import os

from benchmark_pipeline.graph_lint import lint_profile_consistency


def main():
    if len(sys.argv) != 3:
        print(f"Usage: python {os.path.basename(__file__)} <outline.json> <profile.json>")
        sys.exit(1)

    outline_path, profile_path = sys.argv[1], sys.argv[2]

    for path in (outline_path, profile_path):
        if not os.path.exists(path):
            print(f"Error: File not found: {path}")
            sys.exit(1)

    with open(outline_path) as f:
        try:
            outline = json.load(f)
        except json.JSONDecodeError as e:
            print(f"Error: Invalid JSON in {outline_path}: {e}")
            sys.exit(1)

    with open(profile_path) as f:
        try:
            profile_data = json.load(f)
        except json.JSONDecodeError as e:
            print(f"Error: Invalid JSON in {profile_path}: {e}")
            sys.exit(1)

    # Normalize: profile_data may be a full assumption_profile.json or a single profile
    if "profiles" in profile_data:
        profiles = profile_data["profiles"]
    elif "name" in profile_data and "open_nodes" in profile_data:
        # Single profile object
        profiles = [profile_data]
    else:
        print(f"Error: {profile_path} does not look like a profile or assumption_profile.json")
        sys.exit(1)

    print(f"\n=== Profile Consistency Check ===")
    print(f"Outline:  {outline_path}")
    print(f"Profiles: {profile_path}\n")

    all_passed = True
    for prof in profiles:
        result = lint_profile_consistency(outline, prof)
        pname = prof.get("name", "<unnamed>")
        errors = result.errors()
        warnings = result.warnings()

        print(f"Profile: {pname}")
        stats = result.stats
        print(f"  Open nodes:    {stats.get('open_count', 0)}")
        print(f"  Assumed nodes: {stats.get('assumed_count', 0)}")
        print(f"  Target:        {stats.get('selected_target', '(none)')}")

        if errors:
            print(f"  ERRORS ({len(errors)}):")
            for issue in errors:
                node_tag = f" [{issue.node}]" if issue.node else ""
                print(f"    ERROR{node_tag}: {issue.message}")
            all_passed = False

        if warnings:
            print(f"  WARNINGS ({len(warnings)}):")
            for issue in warnings:
                node_tag = f" [{issue.node}]" if issue.node else ""
                print(f"    WARNING{node_tag}: {issue.message}")

        status = "PASS" if result.passed else "FAIL"
        print(f"  Result: {status}\n")

    overall = "PASS" if all_passed else "FAIL"
    print(f"Overall: {overall}")
    sys.exit(0 if all_passed else 1)


if __name__ == "__main__":
    main()
