import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  type Node,
  type Edge,
  type Connection,
  useReactFlow,
  ReactFlowProvider,
} from '@xyflow/react'
import dagre from 'dagre'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { getArtifact, submitProfile, resumeJob } from '../api'
import type { AssumptionProfile, Skeleton, SkeletonStep } from '../types/artifacts'
import type {
  NodeCategory,
  NodeRole,
  NoteStatus,
  ValidationNote,
  EditedNode,
  EditedEdge,
  EditedGraph,
} from '../types/api'
import { nodeTypes, type GraphNodeData, ROLE_COLORS, ROLE_LABELS } from './ProfileBuilderNodes'

// ── Math rendering ────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function renderKatex(expr: string, display = false): string {
  return katex.renderToString(expr, { displayMode: display, throwOnError: false })
}

function renderMath(text: string): string {
  if (text.includes('$')) {
    const segments = text.split(/(\$\$[\s\S]+?\$\$|\$[^\n$]+?\$)/g)
    return segments.map((seg, i) => {
      if (i % 2 === 0) return escapeHtml(seg)
      if (seg.startsWith('$$')) return renderKatex(seg.slice(2, -2).trim(), true)
      return renderKatex(seg.slice(1, -1).trim(), false)
    }).join('')
  }
  let result = escapeHtml(text)
  result = result.replace(
    /\b([A-Za-z][A-Za-z0-9]*)\^(\{[^}]+\}|[A-Za-z0-9]+)/g,
    (whole, base, exp) => {
      const inner = exp.replace(/^\{|\}$/g, '')
      try { return renderKatex(`${base}^{${inner}}`) } catch { return whole }
    },
  )
  result = result.replace(
    /\b([A-Za-z])_([A-Za-z0-9])\b/g,
    (whole, base, sub) => {
      try { return renderKatex(`${base}_{${sub}}`) } catch { return whole }
    },
  )
  return result
}

function MathText({ text, className }: { text: string; className?: string }) {
  return (
    <span className={className} dangerouslySetInnerHTML={{ __html: renderMath(text) }} />
  )
}

// ── Dagre layout ──────────────────────────────────────────────────────────────

function computeLayout(nodes: EditedNode[]): {
  rfNodes: Node<GraphNodeData>[]
  rfEdges: Edge[]
} {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 80 })

  nodes.forEach((n) => g.setNode(n.id, { width: 260, height: 90 }))
  nodes.forEach((n) =>
    (n.depends_on ?? []).forEach((dep) => g.setEdge(dep, n.id)),
  )
  dagre.layout(g)

  const rfNodes: Node<GraphNodeData>[] = nodes.map((n) => {
    const pos = g.node(n.id)
    return {
      id: n.id,
      type: 'graph',
      position: { x: pos.x - 130, y: pos.y - 45 },
      data: nodeToData(n),
    }
  })

  const rfEdges: Edge[] = buildRfEdges(nodes)
  return { rfNodes, rfEdges }
}

function nodeToData(n: EditedNode): GraphNodeData {
  return {
    id: n.id,
    category: n.category,
    label: n.label || deriveLabel(n),
    statement: n.statement,
    proof_intent: n.proof_intent,
    role: n.role,
    is_manual: n.is_manual,
    validation_notes: n.validation_notes,
  }
}

function buildRfEdges(nodes: EditedNode[], manualEdges: EditedEdge[] = []): Edge[] {
  const depEdges: Edge[] = nodes.flatMap((n) =>
    (n.depends_on ?? []).map((dep) => ({
      id: `${dep}->${n.id}`,
      source: dep,
      target: n.id,
      style: { stroke: '#52525b' },
    })),
  )
  const manualOnly = manualEdges
    .filter((e) => e.is_manual && !depEdges.some((d) => d.id === e.id))
    .map((e) => ({ id: e.id, source: e.source, target: e.target, style: { stroke: '#6366f1' } }))
  return [...depEdges, ...manualOnly]
}

function deriveLabel(n: Pick<EditedNode, 'id' | 'statement'>): string {
  const stmt = n.statement ?? ''
  const first = stmt.split(/[.\n]/)[0].trim().slice(0, 72)
  return first || n.id
}

// ── Skeleton → EditedNode converter ──────────────────────────────────────────

function skeletonToEditedNodes(steps: SkeletonStep[]): EditedNode[] {
  return steps.map((s) => ({
    id: s.id,
    category: 'theorem' as NodeCategory,
    label: '',
    statement: s.statement ?? '',
    proof_intent: s.proof_intent ?? '',
    depends_on: s.depends_on ?? [],
    role: 'unset' as NodeRole,
    is_manual: false,
    validation_notes: [],
  }))
}

function skeletonToEditedEdges(steps: SkeletonStep[]): EditedEdge[] {
  return steps.flatMap((s) =>
    (s.depends_on ?? []).map((dep) => ({
      id: `${dep}->${s.id}`,
      source: dep,
      target: s.id,
      is_manual: false,
    })),
  )
}

function applyProfileRoles(nodes: EditedNode[], profile: AssumptionProfile | null): EditedNode[] {
  const selected = profile?.selected_target || profile?.profiles?.[0]?.selected_target || ''
  const open = new Set(profile?.profiles?.[0]?.open_nodes ?? [])
  const assumed = new Set(profile?.profiles?.[0]?.assumed_nodes ?? [])

  return nodes.map((node) => {
    let role: NodeRole = node.role ?? 'unset'
    if (node.id === selected) role = 'target'
    else if (open.has(node.id)) role = 'open'
    else if (assumed.has(node.id)) role = 'hypothesis'
    return { ...node, role }
  })
}

function isEditedGraph(value: unknown): value is EditedGraph {
  if (!value || typeof value !== 'object') return false
  const graph = value as Partial<EditedGraph>
  return Array.isArray(graph.nodes) && Array.isArray(graph.edges)
}

// ── Small UI atoms ────────────────────────────────────────────────────────────

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">{children}</div>
}

function TextInput({ value, onChange, placeholder, rows }: {
  value: string; onChange: (v: string) => void; placeholder?: string; rows?: number
}) {
  const Tag = rows && rows > 1 ? 'textarea' : 'input'
  return (
    <Tag
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-blue-500 resize-y scrollbar-thin font-mono"
    />
  )
}

// ── Validation note row ───────────────────────────────────────────────────────

const NOTE_STATUS_COLORS: Record<NoteStatus, string> = {
  pending: 'text-zinc-500',
  pass: 'text-green-400',
  fail: 'text-red-400',
}

function NoteRow({ note, onChange, onDelete }: {
  note: ValidationNote
  onChange: (updated: ValidationNote) => void
  onDelete: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950">
      <div
        className="flex items-center gap-2 px-2 py-1.5 cursor-pointer hover:bg-zinc-900"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className={`text-[10px] font-bold ${NOTE_STATUS_COLORS[note.status]}`}>
          {note.status === 'pending' ? '○' : note.status === 'pass' ? '✓' : '✗'}
        </span>
        <span className="flex-1 text-xs text-zinc-300 truncate">{note.title || 'Untitled note'}</span>
        <span className="text-[10px] text-zinc-600">{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div className="border-t border-zinc-800 p-2 flex flex-col gap-2">
          <TextInput value={note.title} onChange={(v) => onChange({ ...note, title: v })} placeholder="Title" />
          <TextInput value={note.description} onChange={(v) => onChange({ ...note, description: v })} placeholder="Description" rows={2} />
          <div className="flex items-center gap-2">
            <FieldLabel>Status</FieldLabel>
            {(['pending', 'pass', 'fail'] as NoteStatus[]).map((s) => (
              <button
                key={s}
                onClick={() => onChange({ ...note, status: s })}
                className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase ${note.status === s ? 'bg-zinc-700' : 'hover:bg-zinc-800'} ${NOTE_STATUS_COLORS[s]}`}
              >
                {s}
              </button>
            ))}
            <button onClick={onDelete} className="ml-auto text-[10px] text-red-500 hover:text-red-400">Remove</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Inspector panel ───────────────────────────────────────────────────────────

type InspectorTab = 'role' | 'details' | 'notes'

interface InspectorProps {
  node: EditedNode | null
  allNodeIds: string[]
  activeTab: InspectorTab
  onTabChange: (t: InspectorTab) => void
  onChange: (updated: EditedNode) => void
  onDelete: () => void
}

function Inspector({ node, allNodeIds, activeTab, onTabChange, onChange, onDelete }: InspectorProps) {
  if (!node) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <InspectorTabs active={activeTab} onChange={onTabChange} />
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-xs text-zinc-600 text-center">Click a node to inspect and edit it.</p>
        </div>
      </div>
    )
  }
  return (
    <InspectorContent
      node={node}
      allNodeIds={allNodeIds}
      activeTab={activeTab}
      onTabChange={onTabChange}
      onChange={onChange}
      onDelete={onDelete}
    />
  )
}

function InspectorTabs({ active, onChange }: { active: InspectorTab; onChange: (t: InspectorTab) => void }) {
  const tabs: { key: InspectorTab; label: string }[] = [
    { key: 'role', label: 'Role' },
    { key: 'details', label: 'Details' },
    { key: 'notes', label: 'Notes' },
  ]
  return (
    <div className="flex border-b border-zinc-800 shrink-0">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={`flex-1 py-2 text-xs font-medium transition-colors ${
            active === t.key
              ? 'text-zinc-100 border-b-2 border-blue-500 -mb-px'
              : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

function InspectorContent({
  node,
  allNodeIds,
  activeTab,
  onTabChange,
  onChange,
  onDelete,
}: InspectorProps & { node: EditedNode }) {
  const otherIds = allNodeIds.filter((id) => id !== node.id)
  const depsSet = new Set(node.depends_on)

  function addNote() {
    const noteId = `note_${Date.now()}`
    onChange({ ...node, validation_notes: [...node.validation_notes, { id: noteId, title: '', description: '', status: 'pending' }] })
  }
  function updateNote(idx: number, updated: ValidationNote) {
    const notes = [...node.validation_notes]
    notes[idx] = updated
    onChange({ ...node, validation_notes: notes })
  }
  function deleteNote(idx: number) {
    onChange({ ...node, validation_notes: node.validation_notes.filter((_, i) => i !== idx) })
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <InspectorTabs active={activeTab} onChange={onTabChange} />

      {/* Scrollable content area */}
      <div className="flex-1 overflow-y-auto p-3 scrollbar-thin">
        {activeTab === 'role' && (
          <div className="flex flex-col gap-3">
            {/* ID line */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono text-zinc-500 truncate flex-1">{node.id}</span>
              {node.is_manual && (
                <span className="shrink-0 text-[9px] font-bold uppercase border rounded px-1.5 py-0.5" style={{ color: '#f59e0b', borderColor: '#f59e0b' }}>
                  Manual
                </span>
              )}
            </div>

            {/* Role buttons */}
            <div className="flex flex-col gap-1.5">
              {(['unset', 'hypothesis', 'open', 'target'] as NodeRole[]).map((r) => (
                <button
                  key={r}
                  onClick={() => onChange({ ...node, role: r })}
                  className="rounded px-2.5 py-2 text-xs text-left font-medium transition-colors"
                  style={node.role === r ? {
                    backgroundColor: ROLE_COLORS[r] + '22',
                    border: `1px solid ${ROLE_COLORS[r]}`,
                  } : {
                    border: '1px solid transparent',
                  }}
                >
                  <span style={{ color: ROLE_COLORS[r] }}>■</span>{' '}
                  <span className={node.role === r ? 'text-zinc-100' : 'text-zinc-400'}>{ROLE_LABELS[r]}</span>
                </button>
              ))}
            </div>

            {/* Keyboard hint */}
            <div className="mt-1 rounded bg-zinc-900 px-2.5 py-2 text-[10px] text-zinc-600 leading-relaxed">
              Shortcuts when this node is selected:<br />
              <span className="font-mono text-zinc-500">H</span> hypothesis ·{' '}
              <span className="font-mono text-zinc-500">O</span> open ·{' '}
              <span className="font-mono text-zinc-500">T</span> target ·{' '}
              <span className="font-mono text-zinc-500">Esc</span> deselect
            </div>
          </div>
        )}

        {activeTab === 'details' && (
          <div className="flex flex-col gap-4">
            <div>
              <FieldLabel>Label</FieldLabel>
              <TextInput
                value={node.label}
                onChange={(v) => onChange({ ...node, label: v })}
                placeholder="Human-readable title"
              />
            </div>

            <div>
              <FieldLabel>Category</FieldLabel>
              <div className="flex gap-1">
                {(['theorem', 'definition', 'hypothesis'] as NodeCategory[]).map((c) => (
                  <button
                    key={c}
                    onClick={() => onChange({ ...node, category: c, is_manual: true })}
                    className={`rounded px-2 py-1 text-[10px] uppercase font-bold tracking-wider transition-colors ${
                      node.category === c ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:bg-zinc-800'
                    }`}
                  >
                    {c.slice(0, 3)}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <FieldLabel>Statement</FieldLabel>
              {node.statement && (
                <div className="mb-1.5 text-[10px] text-zinc-300 bg-zinc-900 rounded p-1.5 leading-relaxed [&_.katex]:text-zinc-200">
                  <MathText text={node.statement} />
                </div>
              )}
              <TextInput
                value={node.statement}
                onChange={(v) => onChange({ ...node, statement: v, is_manual: true })}
                placeholder="LaTeX/math statement"
                rows={3}
              />
            </div>

            <div>
              <FieldLabel>Proof intent</FieldLabel>
              <TextInput
                value={node.proof_intent}
                onChange={(v) => onChange({ ...node, proof_intent: v, is_manual: true })}
                placeholder="How this step will be proved"
                rows={2}
              />
            </div>

            <div>
              <FieldLabel>Depends on</FieldLabel>
              <div className="flex flex-col gap-1 max-h-40 overflow-y-auto scrollbar-thin">
                {otherIds.map((id) => (
                  <label key={id} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-zinc-800 px-1.5 py-1 rounded">
                    <input
                      type="checkbox"
                      checked={depsSet.has(id)}
                      onChange={(e) => {
                        const next = new Set(depsSet)
                        e.target.checked ? next.add(id) : next.delete(id)
                        onChange({ ...node, depends_on: [...next], is_manual: true })
                      }}
                      className="accent-blue-500"
                    />
                    <span className="text-zinc-400 font-mono truncate">{id}</span>
                  </label>
                ))}
                {otherIds.length === 0 && <span className="text-xs text-zinc-600">No other nodes</span>}
              </div>
            </div>

            <div className="pt-2 border-t border-zinc-800">
              <button
                onClick={onDelete}
                className="w-full rounded border border-red-900 px-3 py-1.5 text-xs text-red-400 hover:bg-red-950 transition-colors"
              >
                Delete node
              </button>
            </div>
          </div>
        )}

        {activeTab === 'notes' && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <FieldLabel>Validation notes</FieldLabel>
              <button onClick={addNote} className="text-[10px] text-blue-400 hover:text-blue-300">+ Add</button>
            </div>
            {node.validation_notes.length === 0 ? (
              <p className="text-xs text-zinc-600">No notes yet. Add a note to track validation tasks for this step.</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {node.validation_notes.map((note, i) => (
                  <NoteRow key={note.id} note={note} onChange={(u) => updateNote(i, u)} onDelete={() => deleteNote(i)} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Right-click context menu ──────────────────────────────────────────────────

interface ContextMenuState {
  nodeId: string
  x: number
  y: number
}

function NodeContextMenu({ menu, currentRole, onSetRole, onClose }: {
  menu: ContextMenuState
  currentRole: NodeRole
  onSetRole: (id: string, role: NodeRole) => void
  onClose: () => void
}) {
  return (
    <>
      {/* invisible backdrop */}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed z-50 rounded border border-zinc-700 bg-zinc-900 shadow-xl py-1 min-w-[160px]"
        style={{ left: menu.x, top: menu.y }}
      >
        <div className="px-3 py-1 text-[10px] text-zinc-600 font-mono border-b border-zinc-800 mb-1">
          {menu.nodeId}
        </div>
        {(['unset', 'hypothesis', 'open', 'target'] as NodeRole[]).map((r) => (
          <button
            key={r}
            onClick={() => { onSetRole(menu.nodeId, r); onClose() }}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left hover:bg-zinc-800 transition-colors"
          >
            <span style={{ color: ROLE_COLORS[r] }}>■</span>
            <span className={currentRole === r ? 'text-zinc-100 font-semibold' : 'text-zinc-400'}>
              {ROLE_LABELS[r]}
            </span>
            {currentRole === r && <span className="ml-auto text-[10px] text-zinc-600">✓</span>}
          </button>
        ))}
      </div>
    </>
  )
}

// ── Progress summary ──────────────────────────────────────────────────────────

function ProgressSummary({ nodes }: { nodes: EditedNode[] }) {
  const target = nodes.filter((n) => n.role === 'target').length
  const hypotheses = nodes.filter((n) => n.role === 'hypothesis').length
  const open = nodes.filter((n) => n.role === 'open').length
  const unset = nodes.filter((n) => n.role === 'unset').length

  return (
    <div className="border-t border-zinc-800 px-3 py-2 flex items-center gap-3 text-[10px] shrink-0">
      <span style={{ color: ROLE_COLORS.target }}>Target: {target}</span>
      <span className="text-zinc-700">·</span>
      <span style={{ color: ROLE_COLORS.hypothesis }}>Hyp: {hypotheses}</span>
      <span className="text-zinc-700">·</span>
      <span style={{ color: ROLE_COLORS.open }}>Open: {open}</span>
      {unset > 0 && (
        <>
          <span className="text-zinc-700">·</span>
          <span className="text-amber-500">Unset: {unset}</span>
        </>
      )}
    </div>
  )
}

// ── Legend ────────────────────────────────────────────────────────────────────

function Legend() {
  return (
    <div className="absolute bottom-12 left-3 z-10 rounded border border-zinc-800 bg-zinc-950/90 px-3 py-2 text-[10px] backdrop-blur flex flex-col gap-1">
      {(['unset', 'hypothesis', 'open', 'target'] as NodeRole[]).map((r) => (
        <div key={r} className="flex items-center gap-1.5">
          <span style={{ color: ROLE_COLORS[r] }}>■</span>
          <span className="text-zinc-400">{ROLE_LABELS[r]}</span>
        </div>
      ))}
      <div className="border-t border-zinc-800 mt-1 pt-1 flex items-center gap-1.5">
        <span className="text-amber-400 border border-amber-400 rounded px-0.5" style={{ fontSize: '8px' }}>M</span>
        <span className="text-zinc-400">Manually edited</span>
      </div>
    </div>
  )
}

// ── Add node dialog ───────────────────────────────────────────────────────────

function AddNodeDialog({ onAdd, onCancel }: {
  onAdd: (id: string, category: NodeCategory) => void
  onCancel: () => void
}) {
  const [id, setId] = useState('')
  const [category, setCategory] = useState<NodeCategory>('theorem')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-5 w-80 flex flex-col gap-3 shadow-xl">
        <div className="text-sm font-semibold text-zinc-100">Add node</div>
        <div>
          <FieldLabel>Node ID</FieldLabel>
          <TextInput value={id} onChange={setId} placeholder="step_N" />
        </div>
        <div>
          <FieldLabel>Category</FieldLabel>
          <div className="flex gap-1">
            {(['theorem', 'definition', 'hypothesis'] as NodeCategory[]).map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={`rounded px-2 py-1 text-[10px] uppercase font-bold transition-colors ${
                  category === c ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:bg-zinc-800'
                }`}
              >
                {c.slice(0, 3)}
              </button>
            ))}
          </div>
        </div>
        <div className="flex gap-2 justify-end mt-1">
          <button onClick={onCancel} className="rounded px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800">Cancel</button>
          <button
            onClick={() => id.trim() && onAdd(id.trim(), category)}
            disabled={!id.trim()}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Delete confirmation ───────────────────────────────────────────────────────

function DeleteConfirm({ nodeId, onConfirm, onCancel }: {
  nodeId: string; onConfirm: () => void; onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-5 w-72 flex flex-col gap-3 shadow-xl">
        <div className="text-sm font-semibold text-zinc-100">Delete node?</div>
        <p className="text-xs text-zinc-400">
          Remove <code className="font-mono text-zinc-300">{nodeId}</code> and all its edges? This cannot be undone.
        </p>
        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} className="rounded px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800">Cancel</button>
          <button onClick={onConfirm} className="rounded bg-red-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-600">Delete</button>
        </div>
      </div>
    </div>
  )
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  jobId: string
  onConfirmed: () => void
  getArtifactFn?: typeof getArtifact
  submitProfileFn?: typeof submitProfile
  resumeJobFn?: typeof resumeJob
}

// ── Main component (inner — requires ReactFlowProvider) ───────────────────────

function ProfileBuilderInner({
  jobId,
  onConfirmed,
  getArtifactFn = getArtifact,
  submitProfileFn = submitProfile,
  resumeJobFn = resumeJob,
}: Props) {
  const { fitView } = useReactFlow()

  // Source-of-truth graph state
  const [editedNodes, setEditedNodes] = useState<EditedNode[]>([])
  const [editedEdges, setEditedEdges] = useState<EditedEdge[]>([])
  const problemIdRef = useRef('')

  // ReactFlow display state
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node<GraphNodeData>>([])
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([])

  // UI state
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('role')
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [showLegend, setShowLegend] = useState(false)

  // ── Load skeleton ────────────────────────────────────────────────────────
  useEffect(() => {
    Promise.allSettled([
      getArtifactFn<Skeleton>(jobId, 'skeleton'),
      getArtifactFn<AssumptionProfile>(jobId, 'assumption_profile'),
      getArtifactFn<EditedGraph>(jobId, 'edited_graph'),
    ])
      .then(([skeletonResult, profileResult, graphResult]) => {
        if (skeletonResult.status !== 'fulfilled') throw skeletonResult.reason
        const skeleton = skeletonResult.value
        const profile = profileResult.status === 'fulfilled' ? profileResult.value : null
        const editedGraph = graphResult.status === 'fulfilled' && isEditedGraph(graphResult.value)
          ? graphResult.value
          : null

        const nodes = applyProfileRoles(
          editedGraph?.nodes?.length ? editedGraph.nodes : skeletonToEditedNodes(skeleton.steps),
          profile,
        )
        const edges = editedGraph?.edges?.length ? editedGraph.edges : skeletonToEditedEdges(skeleton.steps)
        problemIdRef.current = skeleton.problem_id ?? ''
        setEditedNodes(nodes)
        setEditedEdges(edges)
      })
      .catch((e: unknown) => setLoadError(String(e)))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])

  // ── Sync editedNodes → RF nodes (initial layout only) ───────────────────
  useEffect(() => {
    if (editedNodes.length === 0) return
    const { rfNodes: nodes } = computeLayout(editedNodes)
    const posMap = new Map(rfNodes.map((n) => [n.id, n.position]))
    const positioned = nodes.map((n) => ({
      ...n,
      position: posMap.get(n.id) ?? n.position,
    }))
    setRfNodes(positioned)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editedNodes])

  // ── Sync editedEdges → RF edges ──────────────────────────────────────────
  useEffect(() => {
    setRfEdges(buildRfEdges(editedNodes, editedEdges))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editedEdges, editedNodes])

  // ── Edge + neighbour highlighting ────────────────────────────────────────
  const highlightedNodeIds = useMemo((): Set<string> | null => {
    if (!selectedId) return null
    const ids = new Set([selectedId])
    editedEdges.forEach((e) => {
      if (e.source === selectedId) ids.add(e.target)
      if (e.target === selectedId) ids.add(e.source)
    })
    return ids
  }, [selectedId, editedEdges])

  // Apply highlight styles as derived values (don't mutate state)
  const displayNodes = useMemo(() => {
    if (!highlightedNodeIds) return rfNodes
    return rfNodes.map((n) => ({
      ...n,
      style: {
        opacity: highlightedNodeIds.has(n.id) ? 1 : 0.45,
        transition: 'opacity 0.12s',
      },
    }))
  }, [rfNodes, highlightedNodeIds])

  const displayEdges = useMemo(() => {
    if (!highlightedNodeIds) return rfEdges
    return rfEdges.map((e) => {
      const connected = highlightedNodeIds.has(e.source) && highlightedNodeIds.has(e.target)
      return {
        ...e,
        style: {
          ...(e.style as object),
          stroke: connected ? '#94a3b8' : '#2d2d33',
          strokeWidth: connected ? 1.5 : 1,
          transition: 'stroke 0.12s',
        },
      }
    })
  }, [rfEdges, highlightedNodeIds])

  // ── Selected node (derived) ──────────────────────────────────────────────
  const selectedNode = useMemo(
    () => editedNodes.find((n) => n.id === selectedId) ?? null,
    [editedNodes, selectedId],
  )

  // ── Role setter (used by keyboard shortcuts + context menu) ─────────────
  const setRoleForNode = useCallback((id: string, role: NodeRole) => {
    setEditedNodes((prev) =>
      prev.map((n) => {
        if (n.id === id) return { ...n, role }
        if (role === 'target' && n.role === 'target') return { ...n, role: 'unset' }
        return n
      }),
    )
    setRfNodes((prev) =>
      prev.map((rfn) => {
        if (rfn.id === id) return { ...rfn, data: { ...rfn.data, role } }
        if (role === 'target' && (rfn.data as GraphNodeData).role === 'target')
          return { ...rfn, data: { ...rfn.data, role: 'unset' as NodeRole } }
        return rfn
      }),
    )
  }, [setRfNodes])

  // ── Keyboard shortcuts ───────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedId) return
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'h' || e.key === 'H') setRoleForNode(selectedId, 'hypothesis')
      else if (e.key === 'o' || e.key === 'O') setRoleForNode(selectedId, 'open')
      else if (e.key === 't' || e.key === 'T') setRoleForNode(selectedId, 'target')
      else if (e.key === 'Escape') { setSelectedId(null); setContextMenu(null) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [selectedId, setRoleForNode])

  // ── Node update (from inspector) ─────────────────────────────────────────
  function updateNode(updated: EditedNode) {
    const prevNodes = editedNodes.map((n) => n.id === updated.id ? updated : n)
    // Clear previous target if this node is now target
    const nodes = updated.role === 'target'
      ? prevNodes.map((n) => n.id === updated.id ? updated : n.role === 'target' ? { ...n, role: 'unset' as NodeRole } : n)
      : prevNodes

    setEditedNodes(nodes)

    // Update RF node data without full relayout
    setRfNodes((prev) =>
      prev.map((rfn) => {
        if (updated.role === 'target' && rfn.id !== updated.id && (rfn.data as GraphNodeData).role === 'target')
          return { ...rfn, data: { ...rfn.data, role: 'unset' as NodeRole } }
        if (rfn.id !== updated.id) return rfn
        return { ...rfn, data: nodeToData(updated) }
      }),
    )

    // Rebuild edges from updated deps
    const allEdges = nodes.flatMap((n) =>
      n.depends_on.map((dep) => ({
        id: `${dep}->${n.id}`,
        source: dep,
        target: n.id,
        is_manual: false,
      })),
    )
    setEditedEdges(allEdges)
  }

  // ── Add node ─────────────────────────────────────────────────────────────
  function addNode(id: string, category: NodeCategory) {
    if (editedNodes.some((n) => n.id === id)) {
      setSubmitError(`Node ID "${id}" already exists.`)
      setShowAddDialog(false)
      return
    }
    const newNode: EditedNode = {
      id, category, label: '', statement: '', proof_intent: '',
      depends_on: [], role: 'unset', is_manual: true, validation_notes: [],
    }
    const x = 100 + (editedNodes.length % 4) * 280
    const y = 100 + Math.floor(editedNodes.length / 4) * 160
    setEditedNodes((prev) => [...prev, newNode])
    setRfNodes((prev) => [...prev, {
      id, type: 'graph', position: { x, y },
      data: nodeToData(newNode),
    }])
    setShowAddDialog(false)
    setSelectedId(id)
  }

  // ── Delete node ──────────────────────────────────────────────────────────
  function deleteNode(id: string) {
    setEditedNodes((prev) => prev.filter((n) => n.id !== id))
    setEditedEdges((prev) => prev.filter((e) => e.source !== id && e.target !== id))
    setRfNodes((prev) => prev.filter((n) => n.id !== id))
    if (selectedId === id) setSelectedId(null)
    setDeleteConfirmId(null)
  }

  // ── ReactFlow edge connect ───────────────────────────────────────────────
  const onConnect = useCallback(
    (connection: Connection) => {
      const edgeId = `${connection.source}->${connection.target}`
      const newEdge: EditedEdge = { id: edgeId, source: connection.source!, target: connection.target!, is_manual: true }
      setEditedEdges((prev) => prev.some((e) => e.id === edgeId) ? prev : [...prev, newEdge])
      setRfEdges((prev) => addEdge({ ...connection, style: { stroke: '#6366f1' } }, prev))
      setEditedNodes((prev) =>
        prev.map((n) => {
          if (n.id !== connection.target) return n
          if (n.depends_on.includes(connection.source!)) return n
          return { ...n, depends_on: [...n.depends_on, connection.source!] }
        }),
      )
    },
    [setRfEdges],
  )

  // ── Confirm & submit ─────────────────────────────────────────────────────
  async function handleConfirm() {
    const target = editedNodes.find((n) => n.role === 'target')
    if (!target) { setSubmitError('Select a target node before confirming.'); return }

    const editedGraph: EditedGraph = {
      problem_id: problemIdRef.current,
      nodes: editedNodes,
      edges: editedEdges,
    }
    setSubmitting(true)
    setSubmitError(null)
    try {
      await submitProfileFn(jobId, {
        profile_name: 'default',
        selected_target: target.id,
        assumed_nodes: editedNodes.filter((n) => n.role === 'hypothesis').map((n) => n.id),
        open_nodes: editedNodes.filter((n) => n.role === 'open').map((n) => n.id),
        edited_graph: editedGraph,
      })
      try {
        await resumeJobFn(jobId)
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e)
        if (!message.includes("state 'running'")) {
          throw e
        }
      }
      onConfirmed()
    } catch (e: unknown) {
      setSubmitError(String(e))
    } finally {
      setSubmitting(false)
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center text-red-400 text-sm">
        Failed to load outline: {loadError}
      </div>
    )
  }

  const targetNode = editedNodes.find((n) => n.role === 'target')

  return (
    <>
      {showAddDialog && <AddNodeDialog onAdd={addNode} onCancel={() => setShowAddDialog(false)} />}
      {deleteConfirmId && (
        <DeleteConfirm
          nodeId={deleteConfirmId}
          onConfirm={() => deleteNode(deleteConfirmId)}
          onCancel={() => setDeleteConfirmId(null)}
        />
      )}
      {contextMenu && (
        <NodeContextMenu
          menu={contextMenu}
          currentRole={editedNodes.find((n) => n.id === contextMenu.nodeId)?.role ?? 'unset'}
          onSetRole={setRoleForNode}
          onClose={() => setContextMenu(null)}
        />
      )}

      <PanelGroup direction="horizontal" className="h-full">
        <Panel defaultSize={70} minSize={40} className="relative">
          {/* Toolbar */}
          <div className="absolute top-2 left-2 z-10 flex items-center gap-1">
            <button
              onClick={() => setShowAddDialog(true)}
              className="rounded border border-zinc-700 bg-zinc-900/90 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 backdrop-blur transition-colors"
            >
              + Add node
            </button>
            <button
              onClick={() => fitView({ padding: 0.1, duration: 300 })}
              className="rounded border border-zinc-700 bg-zinc-900/90 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 backdrop-blur transition-colors"
            >
              Fit view
            </button>
            <button
              onClick={() => setShowLegend((v) => !v)}
              className={`rounded border px-2.5 py-1 text-xs backdrop-blur transition-colors ${
                showLegend
                  ? 'border-zinc-500 bg-zinc-700/90 text-zinc-100'
                  : 'border-zinc-700 bg-zinc-900/90 text-zinc-300 hover:bg-zinc-800'
              }`}
            >
              Legend
            </button>
          </div>

          {showLegend && <Legend />}

          <ReactFlow
            nodes={displayNodes}
            edges={displayEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => { setSelectedId(node.id); setContextMenu(null) }}
            onNodeContextMenu={(e, node) => {
              e.preventDefault()
              setSelectedId(node.id)
              setContextMenu({ nodeId: node.id, x: e.clientX, y: e.clientY })
            }}
            onPaneClick={() => { setSelectedId(null); setContextMenu(null) }}
            fitView
            className="bg-zinc-950"
          >
            <Background color="#27272a" gap={20} />
            <Controls className="[&>button]:bg-zinc-800 [&>button]:border-zinc-700 [&>button]:text-zinc-300" />
            <MiniMap
              nodeColor={(node) => ROLE_COLORS[(node.data as GraphNodeData).role ?? 'unset']}
              maskColor="rgba(9,9,11,0.7)"
              style={{ background: '#18181b', border: '1px solid #27272a' }}
            />
          </ReactFlow>
        </Panel>

        <PanelResizeHandle className="w-px bg-zinc-800 hover:bg-zinc-600 transition-colors" />

        <Panel defaultSize={30} minSize={22} className="flex flex-col overflow-hidden">
          <Inspector
            node={selectedNode}
            allNodeIds={editedNodes.map((n) => n.id)}
            activeTab={inspectorTab}
            onTabChange={setInspectorTab}
            onChange={updateNode}
            onDelete={() => selectedNode && setDeleteConfirmId(selectedNode.id)}
          />

          <ProgressSummary nodes={editedNodes} />

          <div className="shrink-0 border-t border-zinc-800 p-3">
            {submitError && <p className="mb-2 text-xs text-red-400">{submitError}</p>}
            <div className="mb-2 text-xs text-zinc-500">
              Target:{' '}
              {targetNode ? (
                <span className="text-blue-400 font-mono">{targetNode.id}</span>
              ) : (
                <span className="text-amber-400">none selected</span>
              )}
            </div>
            <div className="mb-2 rounded border border-amber-500/30 bg-amber-950/30 px-2.5 py-2 text-[11px] leading-relaxed text-amber-200">
              Resuming may call Claude for Lean statement synthesis of the selected benchmark nodes.
              Graph validation, diffing, Mathlib heuristics, file generation, and Lean-shape checks are Python-only.
            </div>
            <button
              onClick={handleConfirm}
              disabled={submitting}
              className="w-full rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
            >
              {submitting ? 'Confirming…' : 'Confirm Profile & Resume'}
            </button>
            {submitting && (
              <p className="mt-1.5 text-center text-[10px] text-zinc-500">
                This may take a few seconds…
              </p>
            )}
          </div>
        </Panel>
      </PanelGroup>
    </>
  )
}

// ── Public export ─────────────────────────────────────────────────────────────

export default function ProfileBuilder(props: Props) {
  return (
    <ReactFlowProvider>
      <ProfileBuilderInner {...props} />
    </ReactFlowProvider>
  )
}
