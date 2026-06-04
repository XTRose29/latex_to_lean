import { Handle, Position, type NodeProps } from '@xyflow/react'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import type { NodeCategory, NodeRole, ValidationNote, NoteStatus } from '../types/api'

// ── Shared types ──────────────────────────────────────────────────────────────

export interface GraphNodeData extends Record<string, unknown> {
  id: string
  category: NodeCategory
  label: string
  statement: string
  proof_intent: string
  role: NodeRole
  is_manual: boolean
  validation_notes: ValidationNote[]
}

// ── Role colours ──────────────────────────────────────────────────────────────

export const ROLE_COLORS: Record<NodeRole, string> = {
  unset:      '#3f3f46',
  hypothesis: '#16a34a',
  open:       '#ef4444',
  target:     '#3b82f6',
}

export const ROLE_LABELS: Record<NodeRole, string> = {
  unset:      'Unset',
  hypothesis: 'Hypothesis',
  open:       'Open (to prove)',
  target:     'Target',
}

// ── Category styling ──────────────────────────────────────────────────────────

interface CategoryStyle {
  borderClass: string
  headerBg: string
  minWidth: string
}

const CATEGORY_STYLE: Record<NodeCategory, CategoryStyle> = {
  theorem: {
    borderClass: 'border-2',
    headerBg: 'bg-zinc-800',
    minWidth: '180px',
  },
  definition: {
    borderClass: 'border',
    headerBg: 'bg-zinc-900',
    minWidth: '160px',
  },
  hypothesis: {
    borderClass: 'border border-dashed',
    headerBg: 'bg-zinc-900',
    minWidth: '160px',
  },
}

const CATEGORY_LABELS: Record<NodeCategory, string> = {
  theorem:    'THM',
  definition: 'DEF',
  hypothesis: 'HYP',
}

// ── Note status dot ───────────────────────────────────────────────────────────

const NOTE_DOT: Record<NoteStatus, string> = {
  pending: 'bg-zinc-500',
  pass:    'bg-green-500',
  fail:    'bg-red-500',
}

// ── Math rendering (inline only, safe for node cards) ────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function renderKatex(expr: string): string {
  return katex.renderToString(expr, { displayMode: false, throwOnError: false })
}

function renderMathInline(text: string): string {
  if (text.includes('$')) {
    const segments = text.split(/(\$\$[\s\S]+?\$\$|\$[^\n$]+?\$)/g)
    return segments.map((seg, i) => {
      if (i % 2 === 0) return escapeHtml(seg)
      if (seg.startsWith('$$')) return renderKatex(seg.slice(2, -2).trim())
      return renderKatex(seg.slice(1, -1).trim())
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

// Truncate rendered HTML safely by truncating the source first, then rendering
function statementPreviewHtml(stmt: string): string {
  const truncated = stmt.slice(0, 120) + (stmt.length > 120 ? '…' : '')
  return renderMathInline(truncated)
}

// ── Node component ────────────────────────────────────────────────────────────

export function GraphNode({ data, selected }: NodeProps) {
  const d = data as GraphNodeData
  const cs = CATEGORY_STYLE[d.category]
  const roleColor = ROLE_COLORS[d.role]
  const borderColor = selected ? '#e4e4e7' : roleColor

  const noteCount = d.validation_notes?.length ?? 0
  const failCount = d.validation_notes?.filter((n) => n.status === 'fail').length ?? 0

  const labelHtml = renderMathInline(d.label || d.id)
  // Show statement preview only when it adds information beyond the label
  const previewHtml = d.statement && d.statement !== d.label
    ? statementPreviewHtml(d.statement)
    : null

  return (
    <>
      <Handle type="target" position={Position.Top} style={{ background: '#71717a' }} />
      <div
        style={{ borderColor, minWidth: cs.minWidth }}
        className={`rounded ${cs.borderClass} bg-zinc-900 overflow-hidden cursor-pointer max-w-[260px]`}
      >
        {/* Header strip */}
        <div
          className={`${cs.headerBg} px-2 py-1 flex items-center gap-1.5`}
          style={{ borderBottom: `1px solid ${borderColor}22` }}
        >
          <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: roleColor }}>
            {CATEGORY_LABELS[d.category]}
          </span>
          {d.is_manual && (
            <span
              className="text-[8px] font-bold uppercase tracking-widest border rounded px-1"
              style={{ color: '#f59e0b', borderColor: '#f59e0b' }}
            >
              Manual
            </span>
          )}
          <span className="ml-auto text-[9px] text-zinc-600 font-mono truncate max-w-[100px]">{d.id}</span>
        </div>

        {/* Body */}
        <div className="px-2.5 py-2">
          {labelHtml ? (
            <div
              className="text-xs font-semibold text-zinc-100 leading-snug break-words [&_.katex]:text-zinc-100 [&_.katex-html]:inline"
              dangerouslySetInnerHTML={{ __html: labelHtml }}
            />
          ) : (
            <div className="text-xs font-semibold text-zinc-100 leading-snug">{d.id}</div>
          )}

          {/* Statement preview (with KaTeX) */}
          {previewHtml && (
            <div
              className="mt-0.5 text-[10px] text-zinc-500 leading-snug line-clamp-2 break-words [&_.katex]:text-zinc-500 [&_.katex-html]:inline"
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          )}

          {d.role !== 'unset' && (
            <div
              className="mt-1 text-[9px] font-bold uppercase tracking-widest"
              style={{ color: roleColor }}
            >
              {ROLE_LABELS[d.role]}
            </div>
          )}
          {noteCount > 0 && (
            <div className="mt-1.5 flex items-center gap-1">
              {d.validation_notes.map((n) => (
                <span key={n.id} className={`inline-block h-1.5 w-1.5 rounded-full ${NOTE_DOT[n.status]}`} />
              ))}
              {failCount > 0 && (
                <span className="text-[9px] text-red-400 ml-0.5">{failCount} issue{failCount > 1 ? 's' : ''}</span>
              )}
            </div>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: '#71717a' }} />
    </>
  )
}

export const nodeTypes = { graph: GraphNode }
