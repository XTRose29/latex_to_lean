"""
Utilities for problem packet extraction and I/O.

A problem packet is the normalized input for the outline pipeline:
one theorem + its proof + surrounding context, ready for skeletonization.
"""

import json
import os
import re
from dataclasses import dataclass, field, asdict
from typing import Optional


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class SourceSpan:
    start_line: int
    end_line: int


@dataclass
class ProblemPacket:
    problem_id: str
    chapter_id: str
    source_file: str
    theorem_label: str
    latex_quote: str
    natural_statement: str
    proof_text: str
    local_definitions: list[str] = field(default_factory=list)
    local_notation: list[str] = field(default_factory=list)
    source_span: Optional[SourceSpan] = None
    ambiguities: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        if self.source_span:
            d["source_span"] = {
                "start_line": self.source_span.start_line,
                "end_line": self.source_span.end_line,
            }
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "ProblemPacket":
        span = d.pop("source_span", None)
        packet = cls(**{k: v for k, v in d.items() if k != "source_span"})
        if span:
            packet.source_span = SourceSpan(**span)
        return packet


# ---------------------------------------------------------------------------
# I/O
# ---------------------------------------------------------------------------

def load_problem_packet(path: str) -> ProblemPacket:
    """Load a problem packet from a JSON file."""
    with open(path) as f:
        d = json.load(f)
    return ProblemPacket.from_dict(d)


def save_problem_packet(packet: ProblemPacket, path: str) -> None:
    """Save a problem packet to a JSON file."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(packet.to_dict(), f, indent=2)


# ---------------------------------------------------------------------------
# Extraction helpers
# ---------------------------------------------------------------------------

# LaTeX theorem-like environments
_THEOREM_ENV_PATTERN = re.compile(
    r'(\\begin\{(theorem|lemma|corollary|proposition)\}.*?\\end\{\2\})',
    re.DOTALL | re.IGNORECASE,
)

# LaTeX proof environment
_PROOF_ENV_PATTERN = re.compile(
    r'\\begin\{proof\}(.*?)\\end\{proof\}',
    re.DOTALL | re.IGNORECASE,
)

# LaTeX definition environment
_DEFINITION_ENV_PATTERN = re.compile(
    r'\\begin\{definition\}(.*?)\\end\{definition\}',
    re.DOTALL | re.IGNORECASE,
)

# LaTeX label extractor
_LABEL_PATTERN = re.compile(r'\\label\{([^}]+)\}')

_TITLE_PATTERN = re.compile(
    r'\\title\{((?:[^{}]|\{[^{}]*\})*)\}',
    re.DOTALL | re.IGNORECASE,
)

_GOAL_HEADING_PATTERN = re.compile(
    r'\\(?:noindent\s*)?\\?textbf\{([^}]*(?:Goal|Problem|Claim|Theorem)[^}]*)\}',
    re.IGNORECASE,
)

_NEXT_SECTION_PATTERN = re.compile(
    r'^\s*\\(?:sub)*section\*?\{',
    re.MULTILINE,
)


def find_theorem_block(chapter_text: str, theorem_label: str) -> Optional[tuple[str, int, int]]:
    """
    Find the theorem block matching `theorem_label` in the chapter text.

    Returns (latex_text, start_line, end_line) or None if not found.

    Matching strategy:
    1. Look for a \\label{theorem_label} inside a theorem-like environment.
    2. If no label match, return the first theorem-like environment.
    """
    lines = chapter_text.splitlines(keepends=True)

    for match in _THEOREM_ENV_PATTERN.finditer(chapter_text):
        block = match.group(0)
        # Check label match
        label_match = _LABEL_PATTERN.search(block)
        found_label = label_match.group(1) if label_match else ""

        if theorem_label and theorem_label not in found_label:
            # Also try partial match (last component of label path)
            short = theorem_label.rsplit(":", 1)[-1]
            if short not in found_label:
                continue

        start_char = match.start()
        end_char = match.end()
        start_line = chapter_text[:start_char].count("\n") + 1
        end_line = chapter_text[:end_char].count("\n") + 1
        return block, start_line, end_line

    # Fallback: return first theorem block if no label given
    if not theorem_label:
        match = _THEOREM_ENV_PATTERN.search(chapter_text)
        if match:
            start_char = match.start()
            end_char = match.end()
            start_line = chapter_text[:start_char].count("\n") + 1
            end_line = chapter_text[:end_char].count("\n") + 1
            return match.group(0), start_line, end_line

        goal_match = _GOAL_HEADING_PATTERN.search(chapter_text)
        if goal_match:
            start_char = goal_match.start()
            after_heading = goal_match.end()
            next_section = _NEXT_SECTION_PATTERN.search(chapter_text, after_heading)
            end_char = next_section.start() if next_section else len(chapter_text)
            block = chapter_text[start_char:end_char].strip()
            start_line = chapter_text[:start_char].count("\n") + 1
            end_line = chapter_text[:end_char].count("\n") + 1
            return block, start_line, end_line

        title_match = _TITLE_PATTERN.search(chapter_text)
        proof_match = _PROOF_ENV_PATTERN.search(chapter_text)
        if title_match and proof_match:
            title = re.sub(r"\s+", " ", title_match.group(1)).strip()
            title = re.sub(r"^Proof\s+that\s+", "", title, flags=re.IGNORECASE).strip()
            if title:
                start_char = title_match.start()
                end_char = title_match.end()
                start_line = chapter_text[:start_char].count("\n") + 1
                end_line = chapter_text[:end_char].count("\n") + 1
                return title, start_line, end_line

    return None


def find_proof_after(chapter_text: str, theorem_end_line: int) -> Optional[str]:
    """
    Find the proof environment that follows the theorem block.

    Returns the proof text (inside \\begin{proof}...\\end{proof}) or None.
    """
    lines = chapter_text.splitlines(keepends=True)
    text_after = "".join(lines[theorem_end_line:])  # lines after theorem block

    match = _PROOF_ENV_PATTERN.search(text_after)
    if match:
        return match.group(1).strip()
    return None


def find_local_definitions(chapter_text: str, theorem_start_line: int) -> list[str]:
    """
    Find definition blocks that appear before the theorem in the same chapter.

    Returns a list of definition texts (trimmed content of each definition environment).
    Only collects definitions from roughly the same section (within 200 lines before the theorem).
    """
    lines = chapter_text.splitlines(keepends=True)
    # Look at last 200 lines before the theorem
    start = max(0, theorem_start_line - 200)
    nearby_text = "".join(lines[start:theorem_start_line])

    defs = []
    for match in _DEFINITION_ENV_PATTERN.finditer(nearby_text):
        defs.append(match.group(0).strip())
    return defs


def make_problem_id(chapter_id: str, theorem_label: str, index: int = 1) -> str:
    """
    Generate a stable lowercase slug for a problem ID.

    Example: chapter_id="ch7", theorem_label="theorem:change_of_variables_local"
    → "ch7_change_of_variables_local_01"
    """
    # Strip LaTeX label prefix like "theorem:", "thm:", "lem:"
    slug = re.sub(r'^(theorem|thm|lem|lemma|cor|corollary|prop|proposition):', '', theorem_label)
    slug = re.sub(r'[^a-zA-Z0-9_]', '_', slug).strip('_').lower()
    if not slug:
        slug = "theorem"
    return f"{chapter_id}_{slug}_{index:02d}"
