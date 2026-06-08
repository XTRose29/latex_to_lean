# LaTeX to Lean Benchmark Builder

Local web app for creating Lean benchmark questions from LaTeX theorem/proof
input. The app starts from LaTeX directly; there is no PDF conversion path.

## Quick Start

From the repo root:

```bash
python3 -m pip install -r requirements.txt
python3 run.py
```

Open the web app:

```text
http://127.0.0.1:5173
```

`run.py` starts both local services:

- FastAPI backend: `http://127.0.0.1:8000`
- React/Vite frontend: `http://127.0.0.1:5173`

If `frontend/node_modules/` is missing, `run.py` automatically runs `npm install`
inside `frontend/`.

## Requirements

- Python 3.11+
- Node.js/npm
- Claude Code CLI for real LLM runs

Install Node.js on macOS if needed:

```bash
brew install node
```

## Claude API Setup

For real Claude calls, configure credentials from the web app:

1. Start the app with `python3 run.py`.
2. Open `http://127.0.0.1:5173`.
3. Click **API settings** in the top-right corner.
4. Paste your Claude-compatible API key.
5. Optionally set a custom API endpoint/base URL, such as an institution gateway.
6. Save the settings. New pipeline jobs will use them.

The backend writes these settings to root `.env`, which is gitignored. No
separate local API-key file is needed.

Run without Claude/API calls:

```bash
LATEX_TO_LEAN_DRY_RUN=true python3 run.py
```

## How To Use

1. Create a project.
2. Paste LaTeX containing a theorem statement and proof, or upload a local
   `.tex`, `.txt`, or `.latex` file.
3. Start the pipeline.
4. Review and edit the generated natural-language decomposition graph.
5. Add, delete, edit, and classify nodes.
6. Confirm benchmark target nodes that are not easy and not close to Mathlib.
7. The backend emits Lean benchmark files with natural-language proof comments
   and `by sorry`, then runs Python-only Lean-shape checks.
8. The report does not run Lean/Lake or clone Mathlib; it checks file shape,
   declaration layout, and `by sorry` placement.
9. Copy the generated Lean file directly from the browser or save it as a local
   `.lean` file.

## Current Pipeline

```text
LaTeX input
  -> deterministic theorem/proof extraction
  -> Claude natural-language theorem/proof decomposition graph
  -> user graph editing in the web app
  -> deterministic graph validation and Mathlib/easiness checks
  -> Claude Lean statement synthesis for selected benchmark nodes
  -> Python Lean benchmark file generation with NL proof comments and `by sorry`
  -> Python-only Lean-shape check
```

Claude is only used for semantic math tasks. Python handles file parsing,
artifact storage, graph validation, project generation, file emission, and the
final Python-only Lean-shape check. The default local pipeline intentionally
does not prove that the generated Lean typechecks.

All LLM calls are cached by input hash under:

```text
runs/<run_id>/llm_calls/<call_name>_<input_hash>/
```

## Repository Structure

```text
run.py                 One-command local launcher
requirements.txt       Python dependencies
config.yaml            Pipeline/Claude settings
backend/               FastAPI backend and local background runner
frontend/              React/Vite web app
pipeline/              Benchmark pipeline and deterministic helper scripts
pipeline/benchmark_pipeline/
prompts/               Runtime Claude prompt templates
```

The Lean/lake project template is embedded in `pipeline/scaffold.py`.
