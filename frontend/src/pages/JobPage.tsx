import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  cancelJob,
  downloadRawArtifact,
  getJob,
  getJobLog,
  getJobStatus,
  getJobTokens,
  getRawArtifact,
  reopenProfileEditor,
  rerunJobFromStage,
} from '../api'
import StageTracker from '../components/StageTracker'
import ProfileBuilder from '../components/ProfileBuilder'
import type { JobStatus } from '../types/api'

const RUNNING_STATES = new Set(['RUNNING', 'PENDING'])
const TERMINAL_STATES = new Set(['DONE', 'ERROR'])
const LOG_FOLLOW_THRESHOLD_PX = 48

function estimateCost(model: string, inputTokens: number, outputTokens: number): string {
  const m = model.toLowerCase()
  // Pricing per million tokens [input, output]
  let inPrice = 3, outPrice = 15  // default: Sonnet
  if (m.includes('opus'))  { inPrice = 15;   outPrice = 75  }
  if (m.includes('haiku')) { inPrice = 0.80; outPrice = 4   }
  const cost = (inputTokens / 1_000_000) * inPrice + (outputTokens / 1_000_000) * outPrice
  return cost < 0.01 ? '<0.01' : cost.toFixed(2)
}

export default function JobPage() {
  const { jobId } = useParams<{ jobId: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [profileResumeStarted, setProfileResumeStarted] = useState(false)

  if (!jobId) return null

  const { data: job } = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => getJob(jobId),
    refetchInterval: (query) => {
      const j = query.state.data
      if (!j) return 3000
      const jobState = j.state.toUpperCase()
      if (TERMINAL_STATES.has(jobState)) return false
      if (jobState === 'PAUSED') return false
      return 3000
    },
  })

  const { data: status } = useQuery({
    queryKey: ['job-status', jobId],
    queryFn: () => getJobStatus(jobId),
    refetchInterval: (query) => {
      const s = query.state.data as JobStatus | undefined
      if (!s) return 3000
      if (TERMINAL_STATES.has(s.state)) return false
      if (s.state === 'PAUSED') return false
      return 3000
    },
  })

  const { data: tokens } = useQuery({
    queryKey: ['job-tokens', jobId],
    queryFn: () => getJobTokens(jobId),
    refetchInterval: (query) => {
      const s = query.state.data
      // Keep polling while running; stop when terminal or paused
      if (!s) return 5000
      const st = status?.state
      if (!st || TERMINAL_STATES.has(st)) return false
      if (st === 'PAUSED') return 10000
      return 5000
    },
  })

  useEffect(() => {
    if (!profileResumeStarted || !status) return
    if (
      status.stage_num > 4 ||
      TERMINAL_STATES.has(status.state) ||
      (status.state === 'PAUSED' && status.stage_num !== 4)
    ) {
      setProfileResumeStarted(false)
    }
  }, [profileResumeStarted, status])

  const jobState = job?.state.toUpperCase()
  const effectiveStatus: JobStatus | undefined =
    jobState && TERMINAL_STATES.has(jobState)
      ? {
          state: jobState as JobStatus['state'],
          stage_label: job?.stage_label || (jobState === 'DONE' ? 'Complete' : 'Pipeline error'),
          stage_num: job?.stage_num || (jobState === 'DONE' ? 9 : status?.stage_num ?? 0),
          stage_total: job?.stage_total || status?.stage_total || 9,
          details:
            jobState === 'ERROR'
              ? job?.error_msg || status?.details || 'Pipeline error'
              : 'Benchmark complete.',
          chapter: status?.chapter ?? 0,
          phase: status?.phase ?? '',
          pid: status?.pid ?? 0,
          started_at: status?.started_at ?? job?.created_at,
          updated_at: job?.updated_at ?? status?.updated_at,
          history: status?.history ?? [],
        }
      : profileResumeStarted && status?.state === 'PAUSED' && status.stage_num === 4
        ? {
          ...status,
          state: 'PENDING',
          stage_label: 'Starting next stage…',
          details: 'Profile confirmed. The pipeline is resuming.',
          updated_at: new Date().toISOString(),
        }
        : status

  const stateLabel = effectiveStatus?.state ?? jobState ?? 'PENDING'
  const isPaused = stateLabel === 'PAUSED'
  const isDone = stateLabel === 'DONE'
  const isError = stateLabel === 'ERROR'
  const isRunning = RUNNING_STATES.has(stateLabel)

  // Stage 4 = profile builder (1-indexed)
  const atProfileStage = !profileResumeStarted && isPaused && (effectiveStatus?.stage_num === 4)

  async function handleRerunStage(stageNum: number) {
    if (!jobId || isRunning) return
    const ok = window.confirm(
      `Rerun from Stage ${stageNum}? This clears generated artifacts from that stage onward.`,
    )
    if (!ok) return
    try {
      setProfileResumeStarted(false)
      const nextJob = await rerunJobFromStage(jobId, stageNum)
      const nextState = nextJob.state.toUpperCase() as JobStatus['state']
      qc.setQueryData<JobStatus | undefined>(['job-status', jobId], (prev) => ({
        state: nextState,
        stage_label: nextJob.stage_label || `Stage ${stageNum}`,
        stage_num: nextJob.stage_num || stageNum,
        stage_total: nextJob.stage_total || prev?.stage_total || 9,
        details:
          stageNum === 4
            ? 'Returned to graph/profile editing.'
            : `Rerunning from Stage ${stageNum}.`,
        chapter: prev?.chapter ?? 0,
        phase: prev?.phase ?? 'manual_stage_navigation',
        pid: prev?.pid ?? 0,
        started_at: prev?.started_at,
        updated_at: new Date().toISOString(),
        history: prev?.history ?? [],
      }))
      await qc.invalidateQueries({ queryKey: ['job', jobId] })
      await qc.invalidateQueries({ queryKey: ['job-status', jobId] })
      await qc.invalidateQueries({ queryKey: ['job-log', jobId] })
      await qc.invalidateQueries({ queryKey: ['job-tokens', jobId] })
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside className="flex w-52 shrink-0 flex-col border-r border-zinc-800 overflow-y-auto scrollbar-thin">
        <div className="px-4 py-3 border-b border-zinc-800">
          <button
            onClick={() => navigate('/projects')}
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            ← Projects
          </button>
        </div>

        {effectiveStatus && (
          <StageTracker
            status={effectiveStatus}
            disabled={isRunning}
            onRerunStage={handleRerunStage}
          />
        )}

        {/* Token usage counter */}
        {tokens && (tokens.total_tokens > 0) && (
          <div className="border-t border-zinc-800 px-4 py-3">
            <div className="text-xs text-zinc-500 uppercase tracking-wider mb-2">Tokens</div>
            <div className="flex flex-col gap-1 text-xs font-mono">
              <div className="flex justify-between">
                <span className="text-zinc-500">In</span>
                <span className="text-zinc-300">{tokens.total_input_tokens.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Out</span>
                <span className="text-zinc-300">{tokens.total_output_tokens.toLocaleString()}</span>
              </div>
              <div className="flex justify-between border-t border-zinc-800 pt-1 mt-1">
                <span className="text-zinc-400">Total</span>
                <span className="text-zinc-100 font-semibold">{tokens.total_tokens.toLocaleString()}</span>
              </div>
              <div className="flex justify-between border-t border-zinc-800 pt-1 mt-1">
                <span className="text-zinc-400">Cost</span>
                <span className="text-amber-400 font-semibold">
                  ${estimateCost(tokens.model, tokens.total_input_tokens, tokens.total_output_tokens)}
                </span>
              </div>
            </div>
          </div>
        )}

        <div className="mt-auto border-t border-zinc-800 px-4 py-3 flex flex-col gap-2">
          {!isDone && !isError && (
            <button
              onClick={() => {
                if (confirm('Cancel this job?')) {
                  cancelJob(jobId).then(() => {
                    qc.invalidateQueries({ queryKey: ['job', jobId] })
                    qc.invalidateQueries({ queryKey: ['job-status', jobId] })
                  })
                }
              }}
              className="text-xs text-zinc-600 hover:text-red-400"
            >
              Cancel job
            </button>
          )}
        </div>
      </aside>

      {/* Main area */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {atProfileStage ? (
          <ProfileBuilder
            jobId={jobId}
            onConfirmed={() => {
              setProfileResumeStarted(true)
              qc.setQueryData<JobStatus | undefined>(['job-status', jobId], (prev) => ({
                state: 'PENDING',
                stage_label: 'Starting next stage…',
                stage_num: prev?.stage_num ?? 4,
                stage_total: prev?.stage_total ?? 9,
                details: 'Profile confirmed. The pipeline is resuming.',
                chapter: prev?.chapter ?? 0,
                phase: prev?.phase ?? '',
                pid: prev?.pid ?? 0,
                started_at: prev?.started_at,
                updated_at: new Date().toISOString(),
                history: prev?.history ?? [],
              }))
              void qc.invalidateQueries({ queryKey: ['job', jobId] })
              void qc.invalidateQueries({ queryKey: ['job-status', jobId] })
              void qc.invalidateQueries({ queryKey: ['job-log', jobId] })
              void qc.invalidateQueries({ queryKey: ['job-tokens', jobId] })
            }}
          />
        ) : isPaused ? (
          <PausedPanel
            jobId={jobId}
            status={status}
            onEditProfile={async () => {
              await reopenProfileEditor(jobId)
              setProfileResumeStarted(false)
              await qc.invalidateQueries({ queryKey: ['job', jobId] })
              await qc.invalidateQueries({ queryKey: ['job-status', jobId] })
            }}
          />
        ) : isDone ? (
          <DonePanel jobId={jobId} />
        ) : isError ? (
          <ErrorPanel
            message={status?.details ?? job?.error_msg ?? 'Unknown error'}
            jobId={jobId}
            onEditProfile={async () => {
              await reopenProfileEditor(jobId)
              setProfileResumeStarted(false)
              await qc.invalidateQueries({ queryKey: ['job', jobId] })
              await qc.invalidateQueries({ queryKey: ['job-status', jobId] })
            }}
          />
        ) : (
          <RunningPanel
            jobId={jobId}
            status={effectiveStatus}
            isRunning={isRunning}
            startedAt={effectiveStatus?.started_at ?? job?.created_at}
          />
        )}
      </div>
    </div>
  )
}

function PausedPanel({
  jobId,
  status,
  onEditProfile,
}: {
  jobId: string
  status: JobStatus | undefined
  onEditProfile: () => Promise<void>
}) {
  const [showLog, setShowLog] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data: log } = useQuery({
    queryKey: ['job-log', jobId],
    queryFn: () => getJobLog(jobId, 500),
    enabled: showLog,
  })

  async function handleEditProfile() {
    setBusy(true)
    setError(null)
    try {
      await onEditProfile()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 scrollbar-thin">
      <div className="mb-4 flex items-center gap-3">
        <span className="text-amber-400 text-lg">!</span>
        <span className="text-base font-semibold text-zinc-100">{status?.stage_label ?? 'Pipeline paused'}</span>
      </div>
      <p className="mb-4 max-w-3xl text-xs leading-relaxed text-zinc-400">
        {status?.details || 'The pipeline is waiting for a correction before it can continue.'}
      </p>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleEditProfile}
          disabled={busy}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {busy ? 'Opening editor…' : 'Edit graph/profile again'}
        </button>
        <button
          type="button"
          onClick={() => setShowLog((v) => !v)}
          className="rounded bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700"
        >
          {showLog ? 'Hide log' : 'Show log'}
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
      {showLog && log && (
        <pre className="rounded border border-zinc-800 bg-zinc-900 p-4 text-xs text-zinc-400 overflow-x-auto whitespace-pre-wrap leading-relaxed scrollbar-thin max-h-96">
          {log}
        </pre>
      )}
    </div>
  )
}

// ── Elapsed timer hook ────────────────────────────────────────────────────────

function parseTimestamp(value?: string): number | null {
  if (!value) return null

  const parsed = Date.parse(value)
  if (!Number.isNaN(parsed)) return parsed

  // Support the pipeline's legacy "YYYY-MM-DD HH:MM:SS" format as local time.
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/,
  )
  if (!match) return null

  const [, year, month, day, hour, minute, second] = match
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ).getTime()
}

function getElapsedSeconds(active: boolean, startedAt?: string): number {
  if (!active) return 0
  const startedMs = parseTimestamp(startedAt)
  if (startedMs === null) return 0
  return Math.max(0, Math.floor((Date.now() - startedMs) / 1000))
}

function useElapsed(active: boolean, startedAt?: string): string {
  const [secs, setSecs] = useState(() => getElapsedSeconds(active, startedAt))

  useEffect(() => {
    if (!active) {
      setSecs(0)
      return
    }

    const tick = () => setSecs(getElapsedSeconds(true, startedAt))
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [active, startedAt])

  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60

  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

// ── Running / log panel ───────────────────────────────────────────────────────

function RunningPanel({
  jobId,
  status,
  isRunning,
  startedAt,
}: {
  jobId: string
  status: JobStatus | undefined
  isRunning: boolean
  startedAt?: string
}) {
  const logRef = useRef<HTMLPreElement>(null)
  const shouldFollowRef = useRef(true)
  const previousLogRef = useRef('')
  const elapsed = useElapsed(isRunning, startedAt)
  const [hasUnseenUpdates, setHasUnseenUpdates] = useState(false)

  const { data: log = '' } = useQuery({
    queryKey: ['job-log', jobId],
    queryFn: () => getJobLog(jobId, 300),
    refetchInterval: isRunning ? 4000 : false,
    // Keep previous data visible during refetch — prevents flash
    placeholderData: (prev) => prev,
  })

  const scrollToBottom = () => {
    const el = logRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    shouldFollowRef.current = true
    setHasUnseenUpdates(false)
  }

  const handleLogScroll = () => {
    const el = logRef.current
    if (!el) return

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const isNearBottom = distanceFromBottom <= LOG_FOLLOW_THRESHOLD_PX

    shouldFollowRef.current = isNearBottom
    if (isNearBottom) {
      setHasUnseenUpdates(false)
    }
  }

  // Follow the log only while the user is already at the bottom.
  useEffect(() => {
    const el = logRef.current
    if (!el || !log) return

    const previousLog = previousLogRef.current
    const hasNewContent = log !== previousLog
    previousLogRef.current = log

    if (!hasNewContent) return

    if (previousLog === '' || shouldFollowRef.current) {
      scrollToBottom()
    } else {
      setHasUnseenUpdates(true)
    }
  }, [log])

  return (
    <div className="flex-1 overflow-y-auto p-6 scrollbar-thin flex flex-col gap-4">
      {/* Stage header */}
      <div className="flex items-center gap-3">
        {isRunning && (
          <span className="inline-block h-2 w-2 rounded-full bg-blue-400 animate-pulse shrink-0" />
        )}
        <span className="text-sm font-semibold text-zinc-100">
          {status?.stage_label ?? 'Starting…'}
        </span>
        {isRunning && (
          <span className="ml-auto text-xs text-zinc-500 font-mono tabular-nums shrink-0">
            {elapsed}
          </span>
        )}
      </div>

      {status?.details && (
        <p className="text-xs text-zinc-400">{status.details}</p>
      )}

      {/* History entries */}
      {status?.history && status.history.length > 0 && (
        <div className="flex flex-col gap-1">
          {status.history.slice(-8).map((h, i) => (
            <div key={i} className="flex gap-3 text-xs">
              <span className="text-zinc-600 shrink-0 font-mono">{h.time}</span>
              <span className="text-zinc-400">{h.msg}</span>
            </div>
          ))}
        </div>
      )}

      {/* Log — always visible when there's content */}
      {log && (
        <div className="relative flex-1 min-h-0 max-h-[60vh]">
          <pre
            ref={logRef}
            onScroll={handleLogScroll}
            className="h-full rounded border border-zinc-800 bg-zinc-900 p-4 text-xs text-zinc-400 overflow-y-auto whitespace-pre-wrap leading-relaxed scrollbar-thin"
          >
            {log}
          </pre>

          {hasUnseenUpdates && (
            <button
              type="button"
              onClick={scrollToBottom}
              className="absolute bottom-3 right-3 rounded-full border border-blue-400/40 bg-zinc-950/95 px-3 py-1.5 text-[11px] font-medium text-blue-300 shadow-lg shadow-black/30 transition hover:border-blue-300 hover:text-blue-200"
            >
              Jump to latest
            </button>
          )}
        </div>
      )}

      {isRunning && !log && (
        <p className="text-xs text-zinc-600 italic">Waiting for pipeline output…</p>
      )}
    </div>
  )
}

// ── Done panel ────────────────────────────────────────────────────────────────

function DonePanel({ jobId }: { jobId: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const [saveState, setSaveState] = useState<'idle' | 'saved' | 'error'>('idle')

  async function copyLeanBlueprint() {
    try {
      const text = await getRawArtifact(jobId, 'blueprint_lean')
      await navigator.clipboard.writeText(text)
      setCopyState('copied')
      window.setTimeout(() => setCopyState('idle'), 2500)
    } catch {
      setCopyState('error')
    }
  }

  async function saveLeanBlueprint() {
    try {
      await downloadRawArtifact(jobId, 'blueprint_lean', 'problem_blueprint.lean')
      setSaveState('saved')
      window.setTimeout(() => setSaveState('idle'), 2500)
    } catch {
      setSaveState('error')
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 scrollbar-thin">
      <div className="mb-4 flex items-center gap-3">
        <span className="text-green-400 text-lg">✓</span>
        <span className="text-base font-semibold text-zinc-100">Benchmark complete</span>
      </div>
      <p className="text-xs text-zinc-400 mb-6">
        All 9 stages finished. Copy the generated Lean statement file or save it locally.
      </p>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={copyLeanBlueprint}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500"
        >
          Copy Lean file
        </button>
        <button
          type="button"
          onClick={saveLeanBlueprint}
          className="rounded bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700"
        >
          Save Lean file
        </button>
        {copyState === 'copied' && <span className="text-xs text-green-400">Copied.</span>}
        {copyState === 'error' && <span className="text-xs text-red-400">Copy failed.</span>}
        {saveState === 'saved' && <span className="text-xs text-green-400">Download started.</span>}
        {saveState === 'error' && <span className="text-xs text-red-400">Save failed.</span>}
      </div>
      <a
        href={`/jobs/${jobId}/artifacts/spec_report`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block rounded bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700 mr-3"
      >
        View spec report
      </a>
      <a
        href={`/jobs/${jobId}/artifacts/blueprint`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block rounded bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700"
      >
        View blueprint
      </a>
    </div>
  )
}

// ── Error panel ───────────────────────────────────────────────────────────────

function ErrorPanel({
  message,
  jobId,
  onEditProfile,
}: {
  message: string
  jobId: string
  onEditProfile: () => Promise<void>
}) {
  const [showLog, setShowLog] = useState(false)
  const [busy, setBusy] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  const { data: log } = useQuery({
    queryKey: ['job-log', jobId],
    queryFn: () => getJobLog(jobId, 500),
    enabled: showLog,
  })

  async function handleEditProfile() {
    setBusy(true)
    setEditError(null)
    try {
      await onEditProfile()
    } catch (e: unknown) {
      setEditError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 scrollbar-thin">
      <div className="mb-4 flex items-center gap-3">
        <span className="text-red-400 text-lg">✗</span>
        <span className="text-base font-semibold text-zinc-100">Pipeline error</span>
      </div>
      <p className="text-xs text-red-400 mb-4">{message}</p>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleEditProfile}
          disabled={busy}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {busy ? 'Opening editor…' : 'Edit graph/profile again'}
        </button>
        <button
          onClick={() => setShowLog((v) => !v)}
          className="rounded bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700"
        >
          {showLog ? 'Hide log' : 'Show pipeline log'}
        </button>
        {editError && <span className="text-xs text-red-400">{editError}</span>}
      </div>
      {showLog && log && (
        <pre className="mt-3 rounded border border-zinc-800 bg-zinc-900 p-4 text-xs text-zinc-400 overflow-x-auto whitespace-pre-wrap leading-relaxed scrollbar-thin max-h-96">
          {log}
        </pre>
      )}
    </div>
  )
}
