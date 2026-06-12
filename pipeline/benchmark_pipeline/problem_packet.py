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


@dataclass
class LatexBlock:
    id: str
    env: str
    content: str
    raw: str
    preview: str
    labels: list[str]
    refs: list[str]
    cites: list[str]
    dependencies: list[str]
    proof: str = ""
    attached_to: Optional[str] = None
    start_line: int = 0
    end_line: int = 0
    show_in_picker: bool = True

    def to_dict(self) -> dict:
        return asdict(self)


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
_REF_PATTERN = re.compile(r'\\(?:c)?ref\{([^}]+)\}', re.IGNORECASE)
_CITE_PATTERN = re.compile(r'\\cite\{([^}]+)\}', re.IGNORECASE)
_DOCUMENT_PATTERN = re.compile(
    r'\\begin\{document\}(.*?)\\end\{document\}',
    re.DOTALL | re.IGNORECASE,
)
_COMMENT_ENV_PATTERN = re.compile(
    r'\\begin\{comment\}.*?\\end\{comment\}',
    re.DOTALL | re.IGNORECASE,
)
_BLOCK_START_PATTERN = re.compile(r'\\begin\{([^}]+)\}', re.IGNORECASE)

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


def extract_latex_blocks(chapter_text: str) -> dict:
    """
    Extract top-level LaTeX blocks from the document body.

    Rules:
    - only text between \\begin{document} and \\end{document} is considered
      when those markers are present;
    - line comments and comment environments are removed;
    - every \\begin{env}...\\end{env} block is recorded;
    - proof blocks attach to the nearest previous non-proof block unless the
      nearest previous block is itself a proof, in which case the proof remains
      a standalone selectable node;
    - dependencies are inferred from case-insensitive \\ref / \\cref commands
      by matching labels in block statement text.
    """
    body, body_line_offset = _document_body(chapter_text)
    stripped = _strip_comments(body)
    raw_blocks = _scan_latex_blocks(stripped, body_line_offset)

    blocks: list[LatexBlock] = []
    previous_seen: LatexBlock | None = None
    for raw in raw_blocks:
        env = raw["env"]
        content = _strip_begin_end(raw["raw"], env).strip()
        labels = _split_command_args(_LABEL_PATTERN.findall(raw["raw"]))
        refs = _split_command_args(_REF_PATTERN.findall(raw["raw"]))
        cites = _split_command_args(_CITE_PATTERN.findall(raw["raw"]))
        block = LatexBlock(
            id=_make_block_id(env, len(blocks) + 1, labels),
            env=env,
            content=content,
            raw=raw["raw"].strip(),
            preview=_preview_text(content),
            labels=labels,
            refs=refs,
            cites=cites,
            dependencies=[],
            start_line=raw["start_line"],
            end_line=raw["end_line"],
        )

        if env.lower() == "proof" and previous_seen is not None and previous_seen.env.lower() != "proof":
            previous_seen.proof = content
            block.attached_to = previous_seen.id
            block.show_in_picker = False
            blocks.append(block)
        else:
            blocks.append(block)
        previous_seen = block

    label_to_block: dict[str, str] = {}
    for block in blocks:
        for label in block.labels:
            label_to_block[label] = block.id

    for block in blocks:
        deps = []
        for ref in block.refs:
            dep = label_to_block.get(ref)
            if dep and dep != block.id and dep not in deps:
                deps.append(dep)
        block.dependencies = deps

    return {
        "blocks": [block.to_dict() for block in blocks],
        "shown_block_ids": [block.id for block in blocks if block.show_in_picker],
    }


def _document_body(text: str) -> tuple[str, int]:
    match = _DOCUMENT_PATTERN.search(text)
    if not match:
        return text, 0
    return match.group(1), text[:match.start(1)].count("\n")


def _strip_comments(text: str) -> str:
    text = _COMMENT_ENV_PATTERN.sub("", text)
    kept = []
    for line in text.splitlines():
        if line.lstrip().startswith("%"):
            continue
        kept.append(line)
    return "\n".join(kept)


def _scan_latex_blocks(text: str, line_offset: int) -> list[dict]:
    blocks = []
    pos = 0
    while True:
        start = _BLOCK_START_PATTERN.search(text, pos)
        if not start:
            break
        env = start.group(1)
        end_pattern = re.compile(rf'\\end\{{{re.escape(env)}\}}', re.IGNORECASE)
        end = end_pattern.search(text, start.end())
        if not end:
            pos = start.end()
            continue
        raw = text[start.start():end.end()]
        blocks.append(
            {
                "env": env,
                "raw": raw,
                "start_line": line_offset + text[:start.start()].count("\n") + 1,
                "end_line": line_offset + text[:end.end()].count("\n") + 1,
            }
        )
        pos = end.end()
    return blocks


def _strip_begin_end(raw: str, env: str) -> str:
    content = re.sub(rf'^\s*\\begin\{{{re.escape(env)}\}}(?:\[[^\]]*\])?', "", raw, flags=re.IGNORECASE)
    content = re.sub(rf'\\end\{{{re.escape(env)}\}}\s*$', "", content, flags=re.IGNORECASE)
    return content


def _split_command_args(values: list[str]) -> list[str]:
    items: list[str] = []
    for value in values:
        for part in value.split(","):
            item = part.strip()
            if item and item not in items:
                items.append(item)
    return items


def _make_block_id(env: str, index: int, labels: list[str]) -> str:
    source = labels[0] if labels else f"{env}_{index}"
    source = re.sub(r'^(theorem|thm|lem|lemma|cor|corollary|prop|proposition|def|definition):', '', source, flags=re.IGNORECASE)
    slug = re.sub(r'[^A-Za-z0-9]+', '_', source).strip("_").lower()
    if not slug:
        slug = f"{env}_{index}"
    return f"{env.lower()}_{index:03d}_{slug}"


def _preview_text(content: str, limit: int = 24) -> str:
    text = re.sub(r'\\label\{[^}]+\}', ' ', content)
    text = re.sub(r'\\[A-Za-z]+\*?(?:\[[^\]]*\])?(?:\{([^{}]*)\})?', r'\1', text)
    words = re.sub(r'\s+', ' ', text).strip().split()
    return " ".join(words[:limit])
