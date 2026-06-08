/**
 * TypeScript interfaces for all latex_to_lean pipeline artifact schemas.
 *
 * These types are the contract between the FastAPI backend and the React
 * frontend. Keep them in sync with the corresponding Python data structures
 * in pipeline/benchmark_pipeline/.
 *
 * Canonical artifact files (relative to benchmark_work/<problem_slug>/):
 *   source/problem_packet.json      → ProblemPacket
 *   outline/skeleton.json           → Skeleton
 *   outline/skeleton_mathlib_check.json → MathlibCheck
 *   outline/assumption_profile.json → AssumptionProfile
 *   outline/outline.json            → Outline
 *   outline/mathlib_map.json        → MathlibMap
 *   blueprint/problem_blueprint.json → Blueprint
 *   validation/spec_validation_report.json → SpecReport
 */

// ---------------------------------------------------------------------------
// Stage 1: Problem Packet
// ---------------------------------------------------------------------------

export interface ProblemPacket {
  problem_id: string;
  theorem_label: string;
  /** Original LaTeX source quote for the theorem */
  latex_quote: string;
  /** Human-readable English statement of the theorem */
  natural_statement: string;
  /** Full proof text extracted from the source */
  proof_text: string;
  /** Local definitions and context needed to understand the theorem */
  local_definitions: string[];
  /** Anything unclear or potentially ambiguous in the source */
  ambiguities: string[];
}

// ---------------------------------------------------------------------------
// Stage 2: Proof Skeleton
// ---------------------------------------------------------------------------

export type StepKind =
  | "reduction"
  | "claim"
  | "construction"
  | "case_split"
  | "application"
  | "contradiction"
  | "unpack"
  | "simplification";

export type Granularity = "small" | "medium" | "large";

export interface SkeletonStep {
  id: string;
  kind: StepKind;
  /** Precise mathematical content of this step */
  statement: string;
  /** IDs of earlier steps this step depends on */
  depends_on: string[];
  /** One sentence: what does this step achieve and why is it needed? */
  proof_intent: string;
  /** Short quote from proof_text, or "implicit" */
  evidence_from_source: string;
  /** True if this step cites a deep external theorem that may be assumed */
  assumption_candidate: boolean;
  granularity: Granularity;
  mathlib_search_queries: string[];
}

export interface Skeleton {
  problem_id: string;
  target_statement: string;
  steps: SkeletonStep[];
  implicit_steps_added: string[];
  ambiguities: string[];
}

// ---------------------------------------------------------------------------
// Stage 3: Conservative Mathlib Check
// ---------------------------------------------------------------------------

export type MathlibClassification = "existing" | "uncertain";

export interface MathlibCheckNode {
  /** Matches SkeletonStep.id */
  name: string;
  classification: MathlibClassification;
  candidate_lemmas: string[];
  search_queries: string[];
  notes: string;
}

export interface MathlibCheck {
  problem_id: string;
  nodes: MathlibCheckNode[];
}

// ---------------------------------------------------------------------------
// Stage 4: Assumption Profile (human-authored)
// ---------------------------------------------------------------------------

export interface BenchmarkProfile {
  name: string;
  selected_target: string;
  /** Step IDs the human chose to leave open (prove later) */
  open_nodes: string[];
  /** Step IDs the human chose to treat as given background facts */
  assumed_nodes: string[];
  max_open_nodes: number;
}

export interface AssumptionProfile {
  problem_id: string;
  selected_target: string;
  profiles: BenchmarkProfile[];
}

// ---------------------------------------------------------------------------
// Stage 5: Dependency Graph (Outline)
// ---------------------------------------------------------------------------

export type NodeType = "theorem" | "definition" | "hypothesis";

export interface OutlineNode {
  name: string;
  type: NodeType;
  /** Names of nodes this node depends on */
  inputs: string[];
  /** Clear one-sentence English description */
  natural: string;
  /** Lean 4 stub declaration (theorems end with := by sorry) */
  formal_stub: string;
  /** Natural language proof sketch (theorems only, else empty) */
  NL_proof: string;
  /** IDs of skeleton steps this node was derived from */
  source_step_ids: string[];
  assumption_candidate: boolean;
  granularity: Granularity;
  mathlib_status: "existing" | "uncertain";
}

export interface Outline {
  problem_id: string;
  selected_profile: string;
  /** Name of the primary benchmark target node */
  main_target: string;
  nodes: OutlineNode[];
}

// ---------------------------------------------------------------------------
// Stage 6: Mathlib Map
// ---------------------------------------------------------------------------

export type MathlibMapClassification = "existing" | "glue" | "new-proof" | "uncertain";

export interface MathlibMapNode {
  /** Matches OutlineNode.name */
  name: string;
  classification: MathlibMapClassification;
  /** Specific Mathlib lemma names, e.g. "Nat.even_of_even_pow" */
  candidate_lemmas: string[];
  search_queries: string[];
  notes: string;
}

export interface MathlibMap {
  problem_id: string;
  nodes: MathlibMapNode[];
}

// ---------------------------------------------------------------------------
// Stage 7: Blueprint
// ---------------------------------------------------------------------------

export interface BlueprintNode {
  name: string;
  type: NodeType;
  inputs: string[];
  natural: string;
  formal_stub: string;
  lean_declaration: string;
}

export interface Blueprint {
  problem_id: string;
  main_target: string;
  nodes: BlueprintNode[];
  lean_file_path: string;
}

// ---------------------------------------------------------------------------
// Stage 8: Compile Validation Report
// ---------------------------------------------------------------------------

export type SpecVerdict = "DONE" | "CONTINUE";

export interface SpecReport {
  problem_id: string;
  verdict: SpecVerdict;
  build_passed: boolean;
  method?: string;
  spec_verdict?: SpecVerdict;
  regression_notes?: string;
  issues?: string[];
  iteration?: number;
  only_sorry_warnings_remain?: boolean;
  python_only_sorry_shape_valid?: boolean;
  compile?: {
    status: string;
    returncode: number | null;
    stdout: string;
    stderr: string;
    warnings: string[];
    errors: string[];
  };
  static_check?: {
    status: "ok" | "failed";
    errors: string[];
    warnings: string[];
    declaration_count: number;
    theorem_count?: number;
    sorry_count: number;
    sorry_shape_valid: boolean;
  };
}

// ---------------------------------------------------------------------------
// Job status (job_status.json — written by PipelineLogger)
// ---------------------------------------------------------------------------

export type JobState = "RUNNING" | "PAUSED" | "DONE" | "ERROR";

export interface JobStatusHistoryEntry {
  time: string;
  msg: string;
}

export interface JobStatus {
  state: JobState;
  /** Human-readable label like "3/9 Conservative Mathlib Verification" */
  stage_label: string;
  stage_num: number;
  stage_total: number;
  /** One-sentence description of the current activity */
  details: string;
  chapter: number;
  phase: string;
  pid: number;
  started_at: string;
  updated_at: string;
  history: JobStatusHistoryEntry[];
}

// ---------------------------------------------------------------------------
// Node state for the Profile Builder UI (not persisted to disk)
// ---------------------------------------------------------------------------

export type ProfileNodeState = "open" | "assumed" | "target";

export interface ProfileBuilderNode extends SkeletonStep {
  uiState: ProfileNodeState;
  mathlibConfirmed: boolean;
}
