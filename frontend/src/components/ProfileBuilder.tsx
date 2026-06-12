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
import type { AssumptionProfile, LatexBlocks, Skeleton, SkeletonStep } from '../types/artifacts'
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

const VISIBLE_ROLES: NodeRole[] = ['unset', 'hypothesis', 'target']

type CombinedGroup = {
  id: string
  originals: EditedNode[]
}

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
  return steps.map((s) => {
    const enriched = s as SkeletonStep & { env?: string; category?: NodeCategory }
    return {
      id: s.id,
      category: enriched.category ?? 'theorem' as NodeCategory,
      label: `${enriched.env ?? 'block'}: ${s.evidence_from_source || deriveLabel({ id: s.id, statement: s.statement })}`,
      statement: s.statement ?? '',
      proof_intent: s.proof_intent ?? '',
      depends_on: s.depends_on ?? [],
      role: enriched.category === 'hypothesis' ? 'hypothesis' as NodeRole : 'unset' as NodeRole,
      is_manual: false,
      validation_notes: [],
    }
  })
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

function dependencyClosure(rootId: string, nodes: EditedNode[]): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const result = new Set<string>()
  const visit = (id: string) => {
    if (result.has(id)) return
    result.add(id)
    const node = byId.get(id)
    node?.depends_on?.forEach(visit)
  }
  visit(rootId)
  return result
}

function blockEnvFromLabel(node: EditedNode): string {
  return node.label.split(':', 1)[0] || node.category
}

function applyProfileRoles(nodes: EditedNode[], profile: AssumptionProfile | null): EditedNode[] {
  const selected = profile?.selected_target || profile?.profiles?.[0]?.selected_target || ''
  const assumed = new Set(profile?.profiles?.[0]?.assumed_nodes ?? [])

  return nodes.map((node) => {
    let role: NodeRole = node.role === 'open' ? 'unset' : (node.role ?? 'unset')
    if (node.id === selected) role = 'target'
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
  return <div className="text-[10px] text-[var(--muted)] uppercase tracking-wider mb-1">{children}</div>
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
      className="w-full rounded border border-[var(--line)] bg-[var(--paper-strong)] px-2 py-1.5 text-xs text-[var(--ink)] outline-none focus:border-[var(--accent)] resize-y scrollbar-thin font-mono"
    />
  )
}

// ── Validation note row ───────────────────────────────────────────────────────

const NOTE_STATUS_COLORS: Record<NoteStatus, string> = {
  pending: 'text-[var(--muted)]',
  pass: 'text-green-400',
  fail: 'text-[#b1482f]',
}

function NoteRow({ note, onChange, onDelete }: {
  note: ValidationNote
  onChange: (updated: ValidationNote) => void
  onDelete: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="rounded-xl border border-[var(--line)] bg-[rgba(255,250,242,0.72)]">
      <div
        className="flex items-center gap-2 px-2 py-1.5 cursor-pointer hover:bg-[rgba(15,94,83,0.08)]"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className={`text-[10px] font-bold ${NOTE_STATUS_COLORS[note.status]}`}>
          {note.status === 'pending' ? '○' : note.status === 'pass' ? '✓' : '✗'}
        </span>
        <span className="flex-1 text-xs text-zinc-300 truncate">{note.title || 'Untitled note'}</span>
        <span className="text-[10px] text-[var(--muted)] opacity-70">{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div className="border-t border-[rgba(99,86,70,0.16)] p-2 flex flex-col gap-2">
          <TextInput value={note.title} onChange={(v) => onChange({ ...note, title: v })} placeholder="Title" />
          <TextInput value={note.description} onChange={(v) => onChange({ ...note, description: v })} placeholder="Description" rows={2} />
          <div className="flex items-center gap-2">
            <FieldLabel>Status</FieldLabel>
            {(['pending', 'pass', 'fail'] as NoteStatus[]).map((s) => (
              <button
                key={s}
                onClick={() => onChange({ ...note, status: s })}
                className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase ${note.status === s ? 'bg-zinc-700' : 'hover:bg-[rgba(15,94,83,0.08)]'} ${NOTE_STATUS_COLORS[s]}`}
              >
                {s}
              </button>
            ))}
            <button onClick={onDelete} className="ml-auto text-[10px] text-red-500 hover:text-[#b1482f]">Remove</button>
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


function NodeBrowser({
  nodes,
  selectedId,
  onSelect,
  onFocusNode,
}: {
  nodes: EditedNode[]
  selectedId: string | null
  onSelect: (id: string) => void
  onFocusNode: (id: string) => void
}) {
  const selectedRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  return (
    <section className="shrink-0 border-b border-[rgba(99,86,70,0.16)] bg-[rgba(255,250,242,0.70)]">
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <div>
          <p className="eyebrow mb-0">Nodes</p>
          <p className="text-[11px] text-[var(--muted)]">↑/↓ select · double-click center</p>
        </div>
        <span className="rounded-full bg-[var(--accent-soft)] px-2 py-1 text-[11px] font-bold text-[var(--accent)]">
          {nodes.length}
        </span>
      </div>
      <div className="max-h-36 overflow-y-auto px-2 pb-2 scrollbar-thin">
        {nodes.map((node, index) => {
          const selected = node.id === selectedId
          const roleColor = ROLE_COLORS[node.role]
          return (
            <button
              key={node.id}
              ref={selected ? selectedRef : undefined}
              type="button"
              onClick={() => onSelect(node.id)}
              onDoubleClick={() => onFocusNode(node.id)}
              className={`mb-1 w-full rounded-xl border px-2.5 py-1.5 text-left transition ${
                selected
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)] shadow-sm'
                  : 'border-transparent hover:border-[rgba(15,94,83,0.20)] hover:bg-[rgba(15,94,83,0.06)]'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--paper-strong)] text-[9px] font-extrabold text-[var(--muted)]">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11px] font-extrabold text-[var(--ink)]">
                  {node.label || node.statement || node.id}
                </span>
                <span className="shrink-0 text-[8px] font-extrabold uppercase tracking-wide" style={{ color: roleColor }}>
                  {ROLE_LABELS[node.role]}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-2 pl-6">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: roleColor }} />
                <span className="min-w-0 truncate font-mono text-[9px] text-[var(--muted)]">
                  {node.id}
                </span>
              </div>
            </button>
          )
        })}
        {nodes.length === 0 && (
          <div className="rounded-2xl border border-dashed border-[var(--line)] px-3 py-4 text-center text-xs text-[var(--muted)]">
            No nodes loaded yet.
          </div>
        )}
      </div>
    </section>
  )
}

function ExtractedBlockBrowser({
  nodes,
  selectedIds,
  targetId,
  onSetTarget,
  onToggle,
  onClear,
}: {
  nodes: EditedNode[]
  selectedIds: Set<string>
  targetId: string
  onSetTarget: (id: string) => void
  onToggle: (id: string) => void
  onClear: () => void
}) {
  return (
    <section className="shrink-0 border-b border-[rgba(99,86,70,0.16)] bg-[rgba(255,250,242,0.84)]">
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <div>
          <p className="eyebrow mb-0">Extracted Blocks</p>
          <p className="text-[11px] text-[var(--muted)]">Target includes parsed dependencies</p>
        </div>
        <button
          type="button"
          onClick={onClear}
          className="rounded border border-[rgba(99,86,70,0.22)] px-2 py-1 text-[10px] font-bold uppercase text-[var(--accent)] hover:bg-[var(--accent-soft)]"
        >
          Clear
        </button>
      </div>
      <div className="max-h-56 overflow-y-auto px-2 pb-2 scrollbar-thin">
        {nodes.map((node, index) => {
          const selected = selectedIds.has(node.id)
          const isTarget = node.id === targetId
          return (
            <div
              key={node.id}
              className={`mb-1 rounded-xl border px-2.5 py-2 transition ${
                selected
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                  : 'border-transparent hover:border-[rgba(15,94,83,0.20)] hover:bg-[rgba(15,94,83,0.06)]'
              }`}
            >
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  onClick={() => onToggle(node.id)}
                  className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded bg-[var(--paper-strong)] text-[9px] font-extrabold text-[var(--muted)]"
                  title="Toggle graph inclusion"
                >
                  {selected ? '✓' : index + 1}
                </button>
                <button
                  type="button"
                  onClick={() => onToggle(node.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="truncate text-[11px] font-extrabold text-[var(--ink)]">
                    {node.label || node.statement || node.id}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[9px] text-[var(--muted)]">
                    {node.id}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => onSetTarget(node.id)}
                  className={`shrink-0 rounded px-2 py-1 text-[9px] font-extrabold uppercase ${
                    isTarget
                      ? 'bg-[#8f2d18] text-white'
                      : 'border border-[rgba(99,86,70,0.22)] text-[var(--accent)] hover:bg-[var(--accent-soft)]'
                  }`}
                >
                  Target
                </button>
              </div>
              {node.depends_on.length > 0 && (
                <div className="mt-1 pl-6 text-[9px] text-[var(--muted)]">
                  refs: {node.depends_on.join(', ')}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function Inspector({ node, allNodeIds, activeTab, onTabChange, onChange, onDelete }: InspectorProps) {
  if (!node) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <InspectorTabs active={activeTab} onChange={onTabChange} />
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-xs text-[var(--muted)] opacity-70 text-center">Click a node to inspect and edit it.</p>
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
    <div className="flex border-b border-[rgba(99,86,70,0.16)] shrink-0">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={`flex-1 py-2 text-xs font-medium transition-colors ${
            active === t.key
              ? 'text-[var(--ink)] border-b-2 border-[var(--accent)] -mb-px'
              : 'text-[var(--muted)] hover:text-[var(--accent)]'
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
              <span className="text-[10px] font-mono text-[var(--muted)] truncate flex-1">{node.id}</span>
              {node.is_manual && (
                <span className="shrink-0 text-[9px] font-bold uppercase border rounded px-1.5 py-0.5" style={{ color: '#f59e0b', borderColor: '#f59e0b' }}>
                  Manual
                </span>
              )}
            </div>

            {/* Role buttons */}
            <div className="flex flex-col gap-1.5">
              {VISIBLE_ROLES.map((r) => (
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
                  <span className={node.role === r ? 'text-[var(--ink)]' : 'text-[var(--muted)]'}>{ROLE_LABELS[r]}</span>
                </button>
              ))}
            </div>

            {/* Keyboard hint */}
            <div className="mt-1 rounded-xl bg-[rgba(15,94,83,0.06)] px-2.5 py-2 text-[10px] text-[var(--muted)] leading-relaxed">
              Shortcuts when this node is selected:<br />
              <span className="font-mono text-[var(--muted)]">↑/↓</span> select node ·{' '}
              <span className="font-mono text-[var(--muted)]">H</span> hypothesis ·{' '}
              <span className="font-mono text-[var(--muted)]">T</span> target ·{' '}
              <span className="font-mono text-[var(--muted)]">Esc</span> deselect
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
                      node.category === c ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--muted)] hover:bg-[rgba(15,94,83,0.08)]'
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
                <div className="mb-1.5 text-[10px] text-[var(--muted)] bg-[rgba(255,253,249,0.75)] rounded-xl p-1.5 leading-relaxed [&_.katex]:text-[var(--ink)]">
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
                  <label key={id} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-[rgba(15,94,83,0.08)] px-1.5 py-1 rounded">
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
                    <span className="font-mono text-[var(--muted)] truncate">{id}</span>
                  </label>
                ))}
                {otherIds.length === 0 && <span className="text-xs text-[var(--muted)] opacity-70">No other nodes</span>}
              </div>
            </div>

            <div className="pt-2 border-t border-[rgba(99,86,70,0.16)]">
              <button
                onClick={onDelete}
                className="w-full rounded border border-red-900 px-3 py-1.5 text-xs text-[#b1482f] hover:bg-red-950 transition-colors"
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
              <button onClick={addNote} className="text-[10px] font-semibold text-[var(--accent)] hover:text-[#8f2d18]">+ Add</button>
            </div>
            {node.validation_notes.length === 0 ? (
              <p className="text-xs text-[var(--muted)] opacity-70">No notes yet. Add a note to track validation tasks for this step.</p>
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
        className="fixed z-50 min-w-[160px] rounded-xl border border-[var(--line)] bg-[var(--paper)] py-1 shadow-xl"
        style={{ left: menu.x, top: menu.y }}
      >
        <div className="px-3 py-1 text-[10px] text-[var(--muted)] opacity-70 font-mono border-b border-[rgba(99,86,70,0.16)] mb-1">
          {menu.nodeId}
        </div>
        {VISIBLE_ROLES.map((r) => (
          <button
            key={r}
            onClick={() => { onSetRole(menu.nodeId, r); onClose() }}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left hover:bg-[rgba(15,94,83,0.08)] transition-colors"
          >
            <span style={{ color: ROLE_COLORS[r] }}>■</span>
            <span className={currentRole === r ? 'text-[var(--ink)] font-semibold' : 'text-[var(--muted)]'}>
              {ROLE_LABELS[r]}
            </span>
            {currentRole === r && <span className="ml-auto text-[10px] text-[var(--muted)] opacity-70">✓</span>}
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
  const unset = nodes.filter((n) => n.role === 'unset' || n.role === 'open').length

  return (
    <div className="border-t border-[rgba(99,86,70,0.16)] px-3 py-2 flex items-center gap-3 text-[10px] shrink-0">
      <span style={{ color: ROLE_COLORS.target }}>Target: {target}</span>
      <span className="text-zinc-700">·</span>
      <span style={{ color: ROLE_COLORS.hypothesis }}>Hyp: {hypotheses}</span>
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
    <div className="absolute bottom-12 left-3 z-10 rounded-xl border border-[var(--line)] bg-[rgba(255,250,242,0.9)] px-3 py-2 text-[10px] backdrop-blur flex flex-col gap-1">
      {VISIBLE_ROLES.map((r) => (
        <div key={r} className="flex items-center gap-1.5">
          <span style={{ color: ROLE_COLORS[r] }}>■</span>
          <span className="text-[var(--muted)]">{ROLE_LABELS[r]}</span>
        </div>
      ))}
      <div className="border-t border-[rgba(99,86,70,0.16)] mt-1 pt-1 flex items-center gap-1.5">
        <span className="text-amber-400 border border-amber-400 rounded px-0.5" style={{ fontSize: '8px' }}>M</span>
        <span className="text-[var(--muted)]">Manually edited</span>
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
      <div className="flex w-80 flex-col gap-3 rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-5 shadow-xl">
        <div className="text-sm font-extrabold text-[var(--ink)]">Add node</div>
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
                  category === c ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--muted)] hover:bg-[rgba(15,94,83,0.08)]'
                }`}
              >
                {c.slice(0, 3)}
              </button>
            ))}
          </div>
        </div>
        <div className="flex gap-2 justify-end mt-1">
          <button onClick={onCancel} className="rounded px-3 py-1.5 text-xs text-[var(--muted)] hover:bg-[rgba(15,94,83,0.08)]">Cancel</button>
          <button
            onClick={() => id.trim() && onAdd(id.trim(), category)}
            disabled={!id.trim()}
            className="btn-primary px-3 py-1.5 text-xs disabled:opacity-50"
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
      <div className="flex w-72 flex-col gap-3 rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-5 shadow-xl">
        <div className="text-sm font-extrabold text-[var(--ink)]">Delete node?</div>
        <p className="text-xs text-[var(--muted)]">
          Remove <code className="font-mono text-zinc-300">{nodeId}</code> and all its edges? This cannot be undone.
        </p>
        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} className="rounded px-3 py-1.5 text-xs text-[var(--muted)] hover:bg-[rgba(15,94,83,0.08)]">Cancel</button>
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
  const { fitView, getNode, setCenter } = useReactFlow()

  // Source-of-truth graph state
  const [editedNodes, setEditedNodes] = useState<EditedNode[]>([])
  const [editedEdges, setEditedEdges] = useState<EditedEdge[]>([])
  const [selectedBlockIds, setSelectedBlockIds] = useState<Set<string>>(new Set())
  const [hasLatexBlocks, setHasLatexBlocks] = useState(false)
  const [latexBlocks, setLatexBlocks] = useState<LatexBlocks | null>(null)
  const [combinedGroups, setCombinedGroups] = useState<Record<string, CombinedGroup>>({})
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
  const [confirmed, setConfirmed] = useState(false)
  const confirmStartedRef = useRef(false)
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [showLegend, setShowLegend] = useState(false)
  const [selectionPhase, setSelectionPhase] = useState<'blocks' | 'graph'>('blocks')

  // ── Load skeleton ────────────────────────────────────────────────────────
  useEffect(() => {
    Promise.allSettled([
      getArtifactFn<Skeleton>(jobId, 'skeleton'),
      getArtifactFn<LatexBlocks>(jobId, 'latex_blocks'),
      getArtifactFn<AssumptionProfile>(jobId, 'assumption_profile'),
      getArtifactFn<EditedGraph>(jobId, 'edited_graph'),
    ])
      .then(([skeletonResult, blocksResult, profileResult, graphResult]) => {
        if (skeletonResult.status !== 'fulfilled') throw skeletonResult.reason
        const skeleton = skeletonResult.value
        const latexBlocks = blocksResult.status === 'fulfilled' ? blocksResult.value : null
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
        setHasLatexBlocks(Boolean(latexBlocks?.blocks?.length))
        setLatexBlocks(latexBlocks)
        const selectedFromGraph = editedGraph?.nodes?.map((n) => n.id) ?? []
        const selectedFromProfile = [
          ...(profile?.profiles?.[0]?.open_nodes ?? []),
          ...(profile?.profiles?.[0]?.assumed_nodes ?? []),
          ...(profile?.selected_target ? [profile.selected_target] : []),
        ]
        setSelectedBlockIds(new Set(selectedFromGraph.length ? selectedFromGraph : selectedFromProfile))
        if (editedGraph?.nodes?.length || profile?.selected_target) setSelectionPhase('graph')
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
    if (hasLatexBlocks && selectedBlockIds.size > 0) return selectedBlockIds
    if (!selectedId) return null
    const ids = new Set([selectedId])
    editedEdges.forEach((e) => {
      if (e.source === selectedId) ids.add(e.target)
      if (e.target === selectedId) ids.add(e.source)
    })
    return ids
  }, [hasLatexBlocks, selectedBlockIds, selectedId, editedEdges])

  // Apply highlight styles as derived values (don't mutate state)
  const displayNodes = useMemo(() => {
    const visible = hasLatexBlocks && selectionPhase === 'graph' && selectedBlockIds.size > 0
      ? rfNodes.filter((n) => selectedBlockIds.has(n.id))
      : rfNodes
    const withSelection = visible.map((n) => ({
      ...n,
      selected: n.id === selectedId,
    }))
    if (!highlightedNodeIds) return withSelection
    return withSelection.map((n) => ({
      ...n,
      style: {
        opacity: highlightedNodeIds.has(n.id) ? 1 : 0.45,
        transition: 'opacity 0.12s',
      },
    }))
  }, [rfNodes, highlightedNodeIds, selectedId, hasLatexBlocks, selectionPhase, selectedBlockIds])

  const displayEdges = useMemo(() => {
    const visible = hasLatexBlocks && selectionPhase === 'graph' && selectedBlockIds.size > 0
      ? rfEdges.filter((e) => selectedBlockIds.has(e.source) && selectedBlockIds.has(e.target))
      : rfEdges
    if (!highlightedNodeIds) return visible
    return visible.map((e) => {
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
  }, [rfEdges, highlightedNodeIds, hasLatexBlocks, selectionPhase, selectedBlockIds])

  // ── Selected node (derived) ──────────────────────────────────────────────
  const selectedNode = useMemo(
    () => editedNodes.find((n) => n.id === selectedId) ?? null,
    [editedNodes, selectedId],
  )

  const selectNodeById = useCallback((id: string | null) => {
    setSelectedId(id)
    setContextMenu(null)
  }, [])

  const centerNodeInGraph = useCallback((id: string) => {
    const node = getNode(id)
    if (!node) return
    const width = node.measured?.width ?? node.width ?? 220
    const height = node.measured?.height ?? node.height ?? 120
    setCenter(node.position.x + width / 2, node.position.y + height / 2, {
      zoom: 1.25,
      duration: 450,
    })
  }, [getNode, setCenter])

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

  const setTargetFromBlock = useCallback((id: string) => {
    const closure = dependencyClosure(id, editedNodes)
    setSelectedBlockIds(closure)
    setRoleForNode(id, 'target')
    setSelectedId(id)
  }, [editedNodes, setRoleForNode])

  const toggleBlockInclusion = useCallback((id: string) => {
    setSelectedBlockIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setSelectedId(id)
  }, [])

  const clearBlockSelection = useCallback(() => {
    setSelectedBlockIds(new Set())
    setSelectedId(null)
    setEditedNodes((prev) => prev.map((n) => n.role === 'target' ? { ...n, role: 'unset' as NodeRole } : n))
    setRfNodes((prev) =>
      prev.map((n) =>
        (n.data as GraphNodeData).role === 'target'
          ? { ...n, data: { ...n.data, role: 'unset' as NodeRole } }
          : n,
      ),
    )
  }, [setRfNodes])

  const selectAllBlocks = useCallback(() => {
    setSelectedBlockIds(new Set(editedNodes.filter((n) => !n.id.startsWith('citation_')).map((n) => n.id)))
    setSubmitError(null)
  }, [editedNodes])

  function combineSelectedBlocks() {
    const selected = editedNodes.filter((n) => selectedBlockIds.has(n.id) && !n.id.startsWith('citation_'))
    if (selected.length < 2) {
      setSubmitError('Select at least two blocks to combine.')
      return
    }
    const selectedIds = new Set(selected.map((n) => n.id))
    const combinedId = `combined_${Date.now()}`
    const targetInside = selected.find((n) => n.role === 'target')
    const combinedNode: EditedNode = {
      id: combinedId,
      category: targetInside?.category ?? selected[0].category,
      label: `combined: ${selected.map((n) => n.id).join(' + ')}`,
      statement: selected.map((n) => n.statement).filter(Boolean).join('\n\n'),
      proof_intent: selected.map((n) => n.proof_intent).filter(Boolean).join('\n\n'),
      depends_on: Array.from(new Set(selected.flatMap((n) => n.depends_on).filter((dep) => !selectedIds.has(dep)))),
      role: targetInside ? 'target' : 'unset',
      is_manual: true,
      validation_notes: [{
        id: `combined_${Date.now()}_note`,
        title: 'Combined LaTeX blocks',
        description: selected.map((n) => n.id).join(', '),
        status: 'pending',
      }],
    }
    setCombinedGroups((prev) => ({ ...prev, [combinedId]: { id: combinedId, originals: selected } }))
    setEditedNodes((prev) => [
      ...prev
        .filter((n) => !selectedIds.has(n.id))
        .map((n) => ({
          ...n,
          depends_on: Array.from(new Set(n.depends_on.map((dep) => selectedIds.has(dep) ? combinedId : dep))),
          role: targetInside && n.role === 'target' ? 'unset' as NodeRole : n.role,
        })),
      combinedNode,
    ])
    setEditedEdges((prev) => [
      ...prev
        .filter((e) => !selectedIds.has(e.source) && !selectedIds.has(e.target))
        .map((e) => ({
          ...e,
          source: selectedIds.has(e.source) ? combinedId : e.source,
          target: selectedIds.has(e.target) ? combinedId : e.target,
          id: `${selectedIds.has(e.source) ? combinedId : e.source}->${selectedIds.has(e.target) ? combinedId : e.target}`,
          is_manual: true,
        })),
      ...combinedNode.depends_on.map((dep) => ({
        id: `${dep}->${combinedId}`,
        source: dep,
        target: combinedId,
        is_manual: true,
      })),
    ])
    setSelectedBlockIds(new Set([combinedId, ...combinedNode.depends_on]))
    setSelectedId(combinedId)
    setSubmitError(null)
  }

  function separateSelectedCombinedBlock() {
    const combinedId = selectedId && combinedGroups[selectedId] ? selectedId : Array.from(selectedBlockIds).find((id) => combinedGroups[id])
    if (!combinedId) {
      setSubmitError('Select a combined block to separate.')
      return
    }
    const group = combinedGroups[combinedId]
    const originalIds = new Set(group.originals.map((n) => n.id))
    setEditedNodes((prev) => [
      ...prev
        .filter((n) => n.id !== combinedId)
        .map((n) => ({
          ...n,
          depends_on: n.depends_on.flatMap((dep) => dep === combinedId ? Array.from(originalIds) : [dep]),
        })),
      ...group.originals,
    ])
    setEditedEdges((prev) => {
      const withoutCombined = prev.filter((e) => e.source !== combinedId && e.target !== combinedId)
      const restored = group.originals.flatMap((n) =>
        n.depends_on.map((dep) => ({
          id: `${dep}->${n.id}`,
          source: dep,
          target: n.id,
          is_manual: false,
        })),
      )
      return [...withoutCombined, ...restored]
    })
    setCombinedGroups((prev) => {
      const next = { ...prev }
      delete next[combinedId]
      return next
    })
    setSelectedBlockIds(originalIds)
    setSelectedId(group.originals[0]?.id ?? null)
    setSubmitError(null)
  }

  // ── Keyboard shortcuts ───────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const tag = target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (editedNodes.length === 0) return
        e.preventDefault()
        const currentIndex = selectedId ? editedNodes.findIndex((n) => n.id === selectedId) : -1
        const delta = e.key === 'ArrowDown' ? 1 : -1
        const fallback = e.key === 'ArrowDown' ? 0 : editedNodes.length - 1
        const nextIndex = currentIndex === -1
          ? fallback
          : (currentIndex + delta + editedNodes.length) % editedNodes.length
        selectNodeById(editedNodes[nextIndex].id)
        return
      }

      if (!selectedId) return
      if (e.key === 'h' || e.key === 'H') setRoleForNode(selectedId, 'hypothesis')
      else if (e.key === 't' || e.key === 'T') setRoleForNode(selectedId, 'target')
      else if (e.key === 'Escape') selectNodeById(null)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [editedNodes, selectedId, selectNodeById, setRoleForNode])

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
  function selectedGraphPayload() {
    const target = editedNodes.find((n) => n.role === 'target')
    if (!target) return null
    const includedIds = hasLatexBlocks
      ? new Set([...selectedBlockIds, target.id])
      : new Set(editedNodes.map((n) => n.id))
    if (!includedIds.has(target.id)) includedIds.add(target.id)
    const graphNodes = editedNodes
      .filter((n) => includedIds.has(n.id))
      .map((n) => ({ ...n, depends_on: n.depends_on.filter((dep) => includedIds.has(dep)) }))
    const graphEdges = editedEdges.filter((e) => includedIds.has(e.source) && includedIds.has(e.target))
    return {
      target,
      graphNodes,
      graphEdges,
      editedGraph: {
        problem_id: problemIdRef.current,
        nodes: graphNodes,
        edges: graphEdges,
      } as EditedGraph,
    }
  }

  async function handleConfirm() {
    if (confirmStartedRef.current || submitting || confirmed) return
    const payload = selectedGraphPayload()
    if (!payload) { setSubmitError('Select a target node before confirming.'); return }
    if (hasLatexBlocks && payload.graphNodes.length === 0) {
      setSubmitError('Highlight at least one block before confirming.')
      return
    }

    confirmStartedRef.current = true
    setSubmitting(true)
    setSubmitError(null)
    try {
      await submitProfileFn(jobId, {
        profile_name: 'default',
        selected_target: payload.target.id,
        assumed_nodes: payload.graphNodes.filter((n) => n.role === 'hypothesis').map((n) => n.id),
        open_nodes: [],
        edited_graph: payload.editedGraph,
        graph_review_confirmed: true,
      })
      try {
        await resumeJobFn(jobId)
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e)
        if (!message.includes("state 'running'")) {
          throw e
        }
      }
      setConfirmed(true)
      onConfirmed()
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)
      if (message.includes("state 'running'") || message.includes("state 'pending'")) {
        setConfirmed(true)
        onConfirmed()
      } else {
        confirmStartedRef.current = false
        setSubmitError(message)
      }
    } finally {
      setSubmitting(false)
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center text-[#b1482f] text-sm">
        Failed to load outline: {loadError}
      </div>
    )
  }

  const targetNode = editedNodes.find((n) => n.role === 'target')
  const selectableBlockNodes = editedNodes.filter((n) => !n.id.startsWith('citation_'))
  const latexBlockById = useMemo(
    () => new Map((latexBlocks?.blocks ?? []).map((block) => [block.id, block])),
    [latexBlocks],
  )

  async function proceedToGraphReview() {
    if (!targetNode) {
      setSubmitError('Select a target theorem before building the dependency graph.')
      return
    }
    const closure = dependencyClosure(targetNode.id, editedNodes)
    const nextSelected = new Set([...selectedBlockIds, ...closure])
    setSelectedBlockIds(nextSelected)
    const payload = selectedGraphPayload()
    if (!payload) {
      setSubmitError('Select a target theorem before building the dependency graph.')
      return
    }
    setSubmitError(null)
    setSubmitting(true)
    try {
      await submitProfileFn(jobId, {
        profile_name: 'default',
        selected_target: payload.target.id,
        assumed_nodes: payload.graphNodes.filter((n) => n.role === 'hypothesis').map((n) => n.id),
        open_nodes: [],
        edited_graph: {
          ...payload.editedGraph,
          nodes: editedNodes
            .filter((n) => nextSelected.has(n.id) || n.id === payload.target.id)
            .map((n) => ({ ...n, depends_on: n.depends_on.filter((dep) => nextSelected.has(dep)) })),
          edges: editedEdges.filter((e) => nextSelected.has(e.source) && nextSelected.has(e.target)),
        },
        graph_review_confirmed: false,
      })
      await resumeJobFn(jobId)
      setConfirmed(true)
      onConfirmed()
    } catch (e: unknown) {
      setSubmitError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  if (hasLatexBlocks && selectionPhase === 'blocks') {
    return (
      <div className="flex h-full flex-col bg-[rgba(255,250,242,0.62)]">
        <div className="shrink-0 border-b border-[rgba(99,86,70,0.16)] px-5 py-4">
          <p className="eyebrow mb-1">1. LaTeX Extraction</p>
          <h2 className="text-lg font-extrabold text-[var(--ink)]">Select the target theorem</h2>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-[var(--muted)]">
            Proof blocks attached to theorem-like blocks are hidden here. Standalone proof blocks remain selectable.
            Choosing a target highlights that block and the dependencies found from parsed ref/cref commands.
          </p>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(460px,1fr)_minmax(360px,0.85fr)] gap-4 overflow-hidden p-4">
          <div className="flex min-h-0 flex-col overflow-hidden rounded border border-[rgba(99,86,70,0.18)] bg-[rgba(255,250,242,0.92)]">
            <div className="grid grid-cols-[56px_92px_minmax(150px,1fr)_minmax(180px,1.5fr)_112px] border-b border-[rgba(99,86,70,0.16)] px-3 py-2 text-[10px] font-extrabold uppercase tracking-wide text-[var(--muted)]">
              <div>#</div>
              <div>Block</div>
              <div>ID</div>
              <div>Preview</div>
              <div>Target</div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto pb-10 scrollbar-thin">
              {selectableBlockNodes.map((node, index) => {
                const selected = selectedBlockIds.has(node.id)
                const isTarget = node.id === targetNode?.id
                const env = blockEnvFromLabel(node)
                return (
                  <div
                    key={node.id}
                    className={`grid grid-cols-[56px_92px_minmax(150px,1fr)_minmax(180px,1.5fr)_112px] items-center gap-3 border-b border-[rgba(99,86,70,0.10)] px-3 py-2 text-xs ${
                      selected ? 'bg-[var(--accent-soft)]' : 'hover:bg-[rgba(15,94,83,0.06)]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleBlockInclusion(node.id)}
                      className="flex h-6 w-8 items-center justify-center rounded border border-[rgba(99,86,70,0.22)] bg-[var(--paper-strong)] font-mono text-[10px] text-[var(--muted)]"
                      title="Select or unselect this block"
                    >
                      {selected ? '✓' : index + 1}
                    </button>
                    <div className="truncate font-bold text-[var(--accent)]">{env}</div>
                    <div className="truncate font-mono text-[10px] text-[var(--muted)]">{node.id}</div>
                    <button
                      type="button"
                      onClick={() => toggleBlockInclusion(node.id)}
                      className="truncate text-left font-medium text-[var(--ink)]"
                    >
                      {node.statement || node.label || node.id}
                    </button>
                    <button
                      type="button"
                      onClick={() => setTargetFromBlock(node.id)}
                      className={`rounded px-2 py-1 text-[10px] font-extrabold uppercase ${
                        isTarget
                          ? 'bg-[#8f2d18] text-white'
                          : 'border border-[rgba(99,86,70,0.22)] text-[var(--accent)] hover:bg-[var(--accent-soft)]'
                      }`}
                    >
                      {isTarget ? 'Selected' : 'Choose'}
                    </button>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="flex min-h-0 flex-col overflow-hidden rounded border border-[rgba(99,86,70,0.18)] bg-[rgba(255,250,242,0.92)]">
            <div className="shrink-0 border-b border-[rgba(99,86,70,0.16)] px-3 py-2">
              <p className="eyebrow mb-0">Source Preview</p>
              <p className="text-[11px] text-[var(--muted)]">Selected sections are highlighted. Click a section to select or unselect it.</p>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-14 pt-3 scrollbar-thin">
              {selectableBlockNodes.map((node) => {
                const selected = selectedBlockIds.has(node.id)
                const isTarget = node.id === targetNode?.id
                const source = latexBlockById.get(node.id)
                return (
                  <button
                    key={node.id}
                    type="button"
                    onClick={() => toggleBlockInclusion(node.id)}
                    className={`mb-3 block h-auto min-h-fit w-full rounded border p-3 text-left align-top transition ${
                      isTarget
                        ? 'border-[#8f2d18] bg-[#fff2df]'
                        : selected
                          ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                          : 'border-[rgba(99,86,70,0.14)] bg-[rgba(255,253,249,0.76)] hover:border-[rgba(15,94,83,0.25)]'
                    }`}
                  >
                    <div className="mb-2 flex items-center gap-2">
                      <span className="rounded bg-[var(--paper-strong)] px-1.5 py-0.5 text-[9px] font-extrabold uppercase text-[var(--accent)]">
                        {blockEnvFromLabel(node)}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[9px] text-[var(--muted)]">{node.id}</span>
                      {source && (
                        <span className="shrink-0 font-mono text-[9px] text-[var(--muted)]">
                          lines {source.start_line}-{source.end_line}
                        </span>
                      )}
                    </div>
                    <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-[var(--ink)]">
                      {(source?.content || node.statement || node.label || node.id).trim()}
                    </pre>
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        <div className="shrink-0 border-t border-[rgba(99,86,70,0.16)] bg-[rgba(255,250,242,0.92)] p-4">
          {submitError && <p className="mb-2 text-xs font-semibold text-[#b1482f]">{submitError}</p>}
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 text-xs text-[var(--muted)]">
              Target:{' '}
              {targetNode ? (
                <span className="font-mono text-[#8f2d18]">{targetNode.id}</span>
              ) : (
                <span className="text-[#8f2d18]">none selected</span>
              )}
              <span className="ml-3">Highlighted blocks: {selectedBlockIds.size}</span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={clearBlockSelection}
                className="rounded border border-[rgba(99,86,70,0.22)] px-3 py-1.5 text-xs font-semibold text-[var(--accent)] hover:bg-[var(--accent-soft)]"
              >
                Clear selection
              </button>
              <button
                type="button"
                onClick={selectAllBlocks}
                className="rounded border border-[rgba(99,86,70,0.22)] px-3 py-1.5 text-xs font-semibold text-[var(--accent)] hover:bg-[var(--accent-soft)]"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={combineSelectedBlocks}
                className="rounded border border-[rgba(99,86,70,0.22)] px-3 py-1.5 text-xs font-semibold text-[var(--accent)] hover:bg-[var(--accent-soft)]"
              >
                Combine selected
              </button>
              <button
                type="button"
                onClick={separateSelectedCombinedBlock}
                className="rounded border border-[rgba(99,86,70,0.22)] px-3 py-1.5 text-xs font-semibold text-[var(--accent)] hover:bg-[var(--accent-soft)]"
              >
                Separate
              </button>
              <button type="button" onClick={proceedToGraphReview} className="btn-primary px-4 py-1.5 text-xs">
                Build Dependency Graph
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

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
              className="rounded-full border border-[rgba(99,86,70,0.22)] bg-[rgba(255,250,242,0.92)] px-3 py-1.5 text-xs font-semibold text-[var(--accent)] shadow-sm backdrop-blur transition hover:-translate-y-0.5"
            >
              + Add node
            </button>
            <button
              onClick={() => fitView({ padding: 0.1, duration: 300 })}
              className="rounded-full border border-[rgba(99,86,70,0.22)] bg-[rgba(255,250,242,0.92)] px-3 py-1.5 text-xs font-semibold text-[var(--accent)] shadow-sm backdrop-blur transition hover:-translate-y-0.5"
            >
              Fit view
            </button>
            <button
              onClick={() => setShowLegend((v) => !v)}
              className={`rounded border px-2.5 py-1 text-xs backdrop-blur transition-colors ${
                showLegend
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'border-[rgba(99,86,70,0.22)] bg-[rgba(255,250,242,0.92)] text-[var(--accent)] hover:bg-[var(--accent-soft)]'
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
            onNodeClick={(_, node) => selectNodeById(node.id)}
            onNodeContextMenu={(e, node) => {
              e.preventDefault()
              selectNodeById(node.id)
              setContextMenu({ nodeId: node.id, x: e.clientX, y: e.clientY })
            }}
            onPaneClick={() => selectNodeById(null)}
            fitView
            className="bg-[rgba(255,250,242,0.35)]"
          >
            <Background color="#d5c6ae" gap={20} />
            <Controls className="[&>button]:border-[var(--line)] [&>button]:bg-[var(--paper)] [&>button]:text-[var(--ink)]" />
            <MiniMap
              nodeColor={(node) => ROLE_COLORS[(node.data as GraphNodeData).role ?? 'unset']}
              maskColor="rgba(245,241,232,0.68)"
              style={{ background: '#fffaf2', border: '1px solid #d5c6ae' }}
            />
          </ReactFlow>
        </Panel>

        <PanelResizeHandle className="w-px bg-[rgba(99,86,70,0.18)] transition-colors hover:bg-[var(--accent)]" />

        <Panel defaultSize={34} minSize={26} className="flex flex-col overflow-hidden">
          {hasLatexBlocks && (
            <ExtractedBlockBrowser
              nodes={selectableBlockNodes}
              selectedIds={selectedBlockIds}
              targetId={targetNode?.id ?? ''}
              onSetTarget={setTargetFromBlock}
              onToggle={toggleBlockInclusion}
              onClear={clearBlockSelection}
            />
          )}

          <NodeBrowser
            nodes={editedNodes}
            selectedId={selectedId}
            onSelect={selectNodeById}
            onFocusNode={centerNodeInGraph}
          />

          <Inspector
            node={selectedNode}
            allNodeIds={editedNodes.map((n) => n.id)}
            activeTab={inspectorTab}
            onTabChange={setInspectorTab}
            onChange={updateNode}
            onDelete={() => selectedNode && setDeleteConfirmId(selectedNode.id)}
          />

          <ProgressSummary nodes={editedNodes} />

          <div className="shrink-0 border-t border-[rgba(99,86,70,0.16)] bg-[rgba(255,250,242,0.82)] p-3">
            {submitError && <p className="mb-2 text-xs font-semibold text-[#b1482f]">{submitError}</p>}
            <div className="mb-2 text-xs text-[var(--muted)]">
              Target:{' '}
              {targetNode ? (
                <span className="font-mono text-[#8f2d18]">{targetNode.id}</span>
              ) : (
                <span className="text-[#8f2d18]">none selected</span>
              )}
            </div>
            <div className="mb-2 rounded-xl border border-[#b1482f]/25 bg-[#fff2df] px-2.5 py-2 text-[11px] leading-relaxed text-[#8f2d18]">
              Review dependencies before resuming. Add or remove edges in the inspector; later stages may call Claude for Lean statement synthesis.
            </div>
            <button
              onClick={handleConfirm}
              disabled={submitting || confirmed}
              className="btn-primary w-full disabled:opacity-50"
            >
              {confirmed ? 'Resuming pipeline…' : submitting ? 'Confirming…' : 'Confirm Profile & Resume'}
            </button>
            {(submitting || confirmed) && (
              <p className="mt-1.5 text-center text-[10px] text-[var(--muted)]">
                The next stage is starting. The page will update automatically.
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
