export interface ProjectCreate {
  name: string
  latex_content: string
  chapter: number
  theorem_label?: string
}

export interface ProjectRead {
  id: string
  name: string
  chapter: number
  theorem_label?: string
  created_at: string
}

export interface JobRead {
  id: string
  project_id: string
  state: 'pending' | 'running' | 'paused' | 'done' | 'error'
  stage_num: number
  stage_total: number
  stage_label: string
  error_msg?: string
  created_at: string
  updated_at: string
}

export interface JobStatusHistoryEntry {
  time: string
  msg: string
}

export interface JobStatus {
  state: 'PENDING' | 'RUNNING' | 'PAUSED' | 'DONE' | 'ERROR'
  stage_label: string
  stage_num: number
  stage_total: number
  details: string
  chapter: number
  phase: string
  pid?: number
  started_at?: string
  updated_at?: string
  history: JobStatusHistoryEntry[]
}

// ── Edited graph types (Stage 4 graph editor) ────────────────────────────────

export type NodeCategory = 'theorem' | 'definition' | 'hypothesis'
export type NodeRole = 'unset' | 'hypothesis' | 'open' | 'target'
export type NoteStatus = 'pending' | 'pass' | 'fail'

export interface ValidationNote {
  id: string
  title: string
  description: string
  status: NoteStatus
}

export interface EditedNode {
  id: string
  category: NodeCategory
  label: string
  statement: string
  proof_intent: string
  depends_on: string[]
  role: NodeRole
  is_manual: boolean
  validation_notes: ValidationNote[]
}

export interface EditedEdge {
  id: string
  source: string
  target: string
  is_manual: boolean
}

export interface EditedGraph {
  problem_id: string
  nodes: EditedNode[]
  edges: EditedEdge[]
}

// ── Profile submission ────────────────────────────────────────────────────────

export interface ProfileSubmit {
  profile_name: string
  selected_target: string
  assumed_nodes: string[]
  open_nodes: string[]
  edited_graph?: EditedGraph
}
