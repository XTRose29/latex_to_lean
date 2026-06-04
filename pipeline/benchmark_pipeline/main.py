#!/usr/bin/env python3
"""
Dedicated entrypoint for the benchmark outline pipeline.

This wrapper forces `--mode benchmark` so users can run the new theorem-level
outline workflow without touching the legacy chapter-wide formalization path.
"""

import asyncio
import os
import sys


def _main() -> None:
    code_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if code_dir not in sys.path:
        sys.path.insert(0, code_dir)

    if "--mode" not in sys.argv:
        sys.argv.extend(["--mode", "benchmark"])

    from claude_pipeline import main

    asyncio.run(main())


if __name__ == "__main__":
    _main()
