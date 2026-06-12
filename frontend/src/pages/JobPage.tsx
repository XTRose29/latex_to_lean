import { useState, useEffect, useMemo, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  cancelJob,
  downloadRawArtifact,
  getJob,
  getJobLog,
  getJobStatus,
  getJobTokens,
  getArtifact,
  getRawArtifact,
  reopenProfileEditor,
  rerunJobFromStage,
} from '../api'
import StageTracker, { STAGE_LABELS } from '../components/StageTracker'
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
  const [selectedStage, setSelectedStage] = useState<number | null>(null)

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
      (status.state === 'PAUSED' && status.stage_num !== 4 && status.stage_num !== 5)
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
      : profileResumeStarted && status?.state === 'PAUSED' && (status.stage_num === 4 || status.stage_num === 5)
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

  // Stage 4 = target/block selection; Stage 5 pause = dependency graph review.
  const atProfileStage = !profileResumeStarted && isPaused && (
    effectiveStatus?.stage_num === 4 || effectiveStatus?.stage_num === 5
  )

  const currentStage = effectiveStatus?.stage_num ?? 0
  const stageForView = selectedStage ?? currentStage
  const viewingCurrentStage = stageForView === currentStage

  useEffect(() => {
    if (!effectiveStatus) return
    if (selectedStage === null) return
    if (selectedStage > effectiveStatus.stage_num && effectiveStatus.state !== 'DONE') {
      setSelectedStage(effectiveStatus.stage_num)
    }
  }, [effectiveStatus, selectedStage])

  function handleSelectStage(stageNum: number) {
    setSelectedStage(stageNum)
  }


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
    <div className="flex h-full overflow-hidden bg-transparent">
      {/* Sidebar */}
      <aside className="app-panel flex w-56 shrink-0 flex-col overflow-y-auto rounded-none border-y-0 border-l-0 scrollbar-thin">
        <div className="border-b border-[rgba(99,86,70,0.16)] px-4 py-3">
          <button
            onClick={() => navigate('/projects')}
            className="text-xs font-semibold text-[var(--muted)] hover:text-[var(--accent)]"
          >
            ← Projects
          </button>
        </div>

        {effectiveStatus && (
          <StageTracker
            status={effectiveStatus}
            selectedStage={stageForView || undefined}
            onSelectStage={handleSelectStage}
          />
        )}

        {/* Token usage counter */}
        {tokens && (tokens.total_tokens > 0) && (
          <div className="border-t border-[rgba(99,86,70,0.16)] px-4 py-3">
            <div className="eyebrow mb-2">Tokens</div>
            <div className="flex flex-col gap-1 text-xs font-mono text-[var(--ink)]">
              <div className="flex justify-between">
                <span className="text-[var(--muted)]">In</span>
                <span className="text-[var(--ink)]">{tokens.total_input_tokens.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--muted)]">Out</span>
                <span className="text-[var(--ink)]">{tokens.total_output_tokens.toLocaleString()}</span>
              </div>
              <div className="mt-1 flex justify-between border-t border-[rgba(99,86,70,0.16)] pt-1">
                <span className="text-[var(--muted)]">Total</span>
                <span className="font-semibold text-[var(--ink)]">{tokens.total_tokens.toLocaleString()}</span>
              </div>
              <div className="mt-1 flex justify-between border-t border-[rgba(99,86,70,0.16)] pt-1">
                <span className="text-[var(--muted)]">Cost</span>
                <span className="font-semibold text-[#8f2d18]">
                  ${estimateCost(tokens.model, tokens.total_input_tokens, tokens.total_output_tokens)}
                </span>
              </div>
            </div>
          </div>
        )}

        <div className="mt-auto flex flex-col gap-2 border-t border-[rgba(99,86,70,0.16)] px-4 py-3">
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
              className="text-xs font-semibold text-[var(--muted)] hover:text-[#b1482f]"
            >
              Cancel job
            </button>
          )}
        </div>
      </aside>

      {/* Main area */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {atProfileStage && viewingCurrentStage ? (
          <ProfileBuilder
            jobId={jobId}
            onConfirmed={() => {
              setProfileResumeStarted(true)
              setSelectedStage(null)
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
        ) : isDone && viewingCurrentStage ? (
          <DonePanel jobId={jobId} />
        ) : !viewingCurrentStage || (isDone && stageForView !== 9) ? (
          <StageViewerPanel
            jobId={jobId}
            stageNum={stageForView || currentStage || 1}
            currentStage={currentStage}
            isRunning={isRunning}
            onReturnToCurrent={() => setSelectedStage(null)}
            onRerunStage={handleRerunStage}
            onEditProfile={async () => {
              await reopenProfileEditor(jobId)
              setProfileResumeStarted(false)
              setSelectedStage(null)
              await qc.invalidateQueries({ queryKey: ['job', jobId] })
              await qc.invalidateQueries({ queryKey: ['job-status', jobId] })
            }}
          />
        ) : isPaused ? (
          <PausedPanel
            jobId={jobId}
            status={status}
            onEditProfile={async () => {
              await reopenProfileEditor(jobId)
              setProfileResumeStarted(false)
              setSelectedStage(null)
              await qc.invalidateQueries({ queryKey: ['job', jobId] })
              await qc.invalidateQueries({ queryKey: ['job-status', jobId] })
            }}
          />
        ) : isError ? (
          <ErrorPanel
            message={status?.details ?? job?.error_msg ?? 'Unknown error'}
            jobId={jobId}
            onEditProfile={async () => {
              await reopenProfileEditor(jobId)
              setProfileResumeStarted(false)
              setSelectedStage(null)
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


type StageArtifactSpec = {
  name: string
  artifact: string
  raw?: boolean
}

type StageArtifactResult = StageArtifactSpec & {
  ok: boolean
  text: string
}

const STAGE_ARTIFACTS: Record<number, StageArtifactSpec[]> = {
  1: [
    { name: 'Problem packet', artifact: 'problem_packet' },
    { name: 'Extracted LaTeX blocks', artifact: 'latex_blocks' },
  ],
  2: [{ name: 'Parsed block graph', artifact: 'skeleton' }],
  3: [{ name: 'Mathlib/easiness check', artifact: 'mathlib_check' }],
  4: [
    { name: 'Selected block graph', artifact: 'edited_graph' },
    { name: 'Assumption profile', artifact: 'assumption_profile' },
  ],
  5: [
    { name: 'Hidden dependency review', artifact: 'hidden_dependencies' },
    { name: 'Reviewed dependency graph', artifact: 'edited_graph' },
    { name: 'Dependency outline', artifact: 'outline' },
    { name: 'Graph diff', artifact: 'graph_diff' },
  ],
  6: [{ name: 'Mathlib map', artifact: 'mathlib_map' }],
  7: [
    { name: 'Blueprint JSON', artifact: 'blueprint' },
    { name: 'Lean statement file', artifact: 'blueprint_lean', raw: true },
  ],
  8: [{ name: 'Python Lean check report', artifact: 'spec_report' }],
  9: [{ name: 'Packaged Lean file', artifact: 'blueprint_lean', raw: true }],
}

function formatArtifact(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

function StageViewerPanel({
  jobId,
  stageNum,
  currentStage,
  isRunning,
  onReturnToCurrent,
  onRerunStage,
  onEditProfile,
}: {
  jobId: string
  stageNum: number
  currentStage: number
  isRunning: boolean
  onReturnToCurrent: () => void
  onRerunStage: (stageNum: number) => Promise<void>
  onEditProfile: () => Promise<void>
}) {
  const [busyAction, setBusyAction] = useState<'edit' | 'rerun' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const specs = useMemo(() => STAGE_ARTIFACTS[stageNum] ?? [], [stageNum])
  const stageLabel = STAGE_LABELS[stageNum - 1] ?? `Stage ${stageNum}`

  const { data: artifacts = [], isLoading } = useQuery({
    queryKey: ['stage-artifacts', jobId, stageNum],
    queryFn: async (): Promise<StageArtifactResult[]> => {
      return Promise.all(
        specs.map(async (spec) => {
          try {
            const value = spec.raw
              ? await getRawArtifact(jobId, spec.artifact)
              : await getArtifact<unknown>(jobId, spec.artifact)
            return { ...spec, ok: true, text: formatArtifact(value) }
          } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e)
            return { ...spec, ok: false, text: `Not available yet. ${message}` }
          }
        }),
      )
    },
    enabled: specs.length > 0,
  })

  const { data: log = '' } = useQuery({
    queryKey: ['job-log', jobId, 'stage-viewer'],
    queryFn: () => getJobLog(jobId, 500),
    refetchInterval: isRunning ? 5000 : false,
  })

  async function handleEditProfile() {
    setBusyAction('edit')
    setActionError(null)
    try {
      await onEditProfile()
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyAction(null)
    }
  }

  async function handleRerun() {
    setBusyAction('rerun')
    setActionError(null)
    try {
      await onRerunStage(stageNum)
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 scrollbar-thin">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="eyebrow mb-2">Viewing previous stage</p>
          <h1 className="text-xl font-extrabold text-[var(--ink)]">
            Stage {stageNum}: {stageLabel}
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">
            This is a read-only view of artifacts and logs from this stage. Use the separate action buttons to edit or rerun.
          </p>
        </div>
        <button type="button" onClick={onReturnToCurrent} className="btn-secondary">
          Back to current stage
        </button>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        {stageNum === 4 && (
          <button
            type="button"
            onClick={handleEditProfile}
            disabled={isRunning || busyAction !== null}
            className="btn-primary disabled:opacity-50"
          >
            {busyAction === 'edit' ? 'Opening editor...' : 'Modify graph/profile'}
          </button>
        )}
        <button
          type="button"
          onClick={handleRerun}
          disabled={isRunning || busyAction !== null || stageNum > currentStage}
          className="btn-secondary disabled:opacity-50"
        >
          {busyAction === 'rerun' ? 'Starting rerun...' : `Rerun from Stage ${stageNum}`}
        </button>
        {isRunning && (
          <span className="text-xs font-semibold text-[var(--muted)]">
            Rerun/edit actions are disabled while the pipeline is running.
          </span>
        )}
        {actionError && <span className="text-xs font-semibold text-[#b1482f]">{actionError}</span>}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="app-card overflow-hidden">
          <div className="border-b border-[rgba(99,86,70,0.16)] px-4 py-3">
            <p className="eyebrow mb-1">Artifacts</p>
            <h2 className="text-sm font-extrabold text-[var(--ink)]">Stage outputs</h2>
          </div>
          {isLoading ? (
            <div className="px-4 py-5 text-sm text-[var(--muted)]">Loading artifacts...</div>
          ) : artifacts.length > 0 ? (
            <div className="flex flex-col gap-4 p-4">
              {artifacts.map((artifact) => (
                <div key={artifact.artifact}>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <h3 className="text-sm font-bold text-[var(--ink)]">{artifact.name}</h3>
                    {!artifact.ok && <span className="text-xs font-semibold text-[#b1482f]">not ready</span>}
                  </div>
                  <pre className="code-surface max-h-[42vh] overflow-auto p-4 text-xs leading-relaxed scrollbar-thin">
                    {artifact.text}
                  </pre>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-4 py-5 text-sm text-[var(--muted)]">No stored artifact is registered for this stage.</div>
          )}
        </section>

        <section className="app-card overflow-hidden">
          <div className="border-b border-[rgba(99,86,70,0.16)] px-4 py-3">
            <p className="eyebrow mb-1">Pipeline log</p>
            <h2 className="text-sm font-extrabold text-[var(--ink)]">Recent log output</h2>
          </div>
          {log ? (
            <pre className="code-surface max-h-[68vh] overflow-auto rounded-none border-0 p-4 text-xs leading-relaxed scrollbar-thin">
              {log}
            </pre>
          ) : (
            <div className="px-4 py-5 text-sm text-[var(--muted)]">No log output yet.</div>
          )}
        </section>
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
        <span className="text-lg text-[#8f2d18]">!</span>
        <span className="text-base font-extrabold text-[var(--ink)]">{status?.stage_label ?? 'Pipeline paused'}</span>
      </div>
      <p className="mb-4 max-w-3xl text-xs leading-relaxed text-[var(--muted)]">
        {status?.details || 'The pipeline is waiting for a correction before it can continue.'}
      </p>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleEditProfile}
          disabled={busy}
          className="btn-primary disabled:opacity-50"
        >
          {busy ? 'Opening editor…' : 'Edit graph/profile again'}
        </button>
        <button
          type="button"
          onClick={() => setShowLog((v) => !v)}
          className="btn-secondary"
        >
          {showLog ? 'Hide log' : 'Show log'}
        </button>
        {error && <span className="text-xs font-semibold text-[#b1482f]">{error}</span>}
      </div>
      {showLog && log && (
        <pre className="code-surface max-h-96 overflow-x-auto whitespace-pre-wrap p-4 text-xs leading-relaxed scrollbar-thin">
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

type RunningStagePresentation = {
  eyebrow: string
  title: string
  detail: string
  steps: string[]
  callsClaude: boolean
}

function runningStagePresentation(status: JobStatus | undefined): RunningStagePresentation {
  const stage = status?.stage_num ?? 0
  if (stage === 2) {
    return {
      eyebrow: 'Python-only stage',
      title: 'Building the parsed block graph',
      detail: 'Python is converting extracted LaTeX blocks into graph nodes and adding ref/cref dependencies.',
      steps: ['Loading LaTeX blocks', 'Adding parsed dependencies', 'Writing block graph JSON'],
      callsClaude: false,
    }
  }
  if (stage === 5) {
    return {
      eyebrow: 'Claude dependency review',
      title: 'Finding hidden dependencies',
      detail: 'Claude reviews the user-selected graph and parsed LaTeX blocks to suggest missing dependency edges before the graph review pause.',
      steps: ['Reading selected blocks', 'Checking for implicit dependencies', 'Writing suggested edge JSON'],
      callsClaude: true,
    }
  }
  if (stage === 7) {
    return {
      eyebrow: 'Claude call 2',
      title: 'Claude is synthesizing Lean statements',
      detail: 'Only the selected benchmark target nodes are sent for Lean theorem statement candidates. File layout and checks stay Python-only.',
      steps: ['Reading selected target nodes', 'Choosing Lean signatures', 'Returning structured candidates'],
      callsClaude: true,
    }
  }
  if (stage === 1) {
    return {
      eyebrow: 'Python-only stage',
      title: 'Extracting LaTeX blocks',
      detail: 'Python is parsing the LaTeX input, attaching proof blocks, and writing the target-selection block inventory.',
      steps: ['Strip comments', 'Extract begin/end blocks', 'Write problem packet and block inventory'],
      callsClaude: false,
    }
  }
  if (stage === 8) {
    return {
      eyebrow: 'Python-only stage',
      title: 'Checking the Lean file shape',
      detail: 'Python is checking the generated Lean benchmark file structure and sorry shape without running Lake or cloning Mathlib.',
      steps: ['Reading emitted Lean', 'Checking declarations', 'Verifying sorry-only shape'],
      callsClaude: false,
    }
  }
  if (stage === 9) {
    return {
      eyebrow: 'Python-only stage',
      title: 'Packaging benchmark output',
      detail: 'Python is collecting the generated Lean file and reports into the final local output.',
      steps: ['Collecting artifacts', 'Preparing download file', 'Finalizing job'],
      callsClaude: false,
    }
  }
  return {
    eyebrow: 'Python-only stage',
    title: status?.stage_label ?? 'Pipeline is running',
    detail: status?.details || 'Python is validating artifacts and preparing the next pipeline step. No Claude call is used in this stage.',
    steps: ['Loading cached artifacts', 'Running deterministic checks', 'Writing stage output'],
    callsClaude: false,
  }
}

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

  const presentation = runningStagePresentation(status)

  return (
    <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-6 scrollbar-thin">
      <section className="thinking-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 gap-4">
            <span className="thinking-orb mt-1 h-4 w-4 shrink-0 rounded-full" />
            <div className="min-w-0">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <p className="eyebrow mb-0">{presentation.eyebrow}</p>
                {presentation.callsClaude && (
                  <span className="rounded-full bg-[#8f2d18]/10 px-2 py-1 text-[11px] font-extrabold uppercase tracking-wide text-[#8f2d18]">
                    API call in progress
                  </span>
                )}
              </div>
              <h1 className="text-2xl font-extrabold leading-tight text-[var(--ink)]">
                {presentation.title}
                {isRunning && (
                  <span className="ml-2 inline-flex translate-y-[-2px] gap-1 align-middle">
                    <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
                    <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
                    <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
                  </span>
                )}
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--muted)]">
                {presentation.detail}
              </p>
            </div>
          </div>
          {isRunning && (
            <div className="rounded-full bg-[var(--paper-strong)] px-3 py-1.5 font-mono text-xs tabular-nums text-[var(--muted)] shadow-sm">
              {elapsed}
            </div>
          )}
        </div>

        <div className="mt-6 grid gap-3 md:grid-cols-3">
          {presentation.steps.map((step, i) => (
            <div key={step} className="rounded-2xl border border-[rgba(15,94,83,0.14)] bg-white/45 px-4 py-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[11px] font-extrabold text-[var(--accent)]">
                  {i + 1}
                </span>
                <span className="text-xs font-extrabold text-[var(--ink)]">{step}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-[rgba(15,94,83,0.10)]">
                <div
                  className="h-full rounded-full bg-[var(--accent)] transition-all duration-700"
                  style={{ width: `${Math.min(92, 36 + i * 24)}%` }}
                />
              </div>
            </div>
          ))}
        </div>

        {status?.details && (
          <p className="mt-5 rounded-2xl bg-white/40 px-4 py-3 text-xs leading-relaxed text-[var(--muted)]">
            {status.details}
          </p>
        )}
      </section>

      {status?.history && status.history.length > 0 && (
        <section className="app-card px-4 py-3">
          <p className="eyebrow mb-2">Recent events</p>
          <div className="flex flex-col gap-1">
            {status.history.slice(-5).map((h, i) => (
              <div key={i} className="flex gap-3 text-xs">
                <span className="shrink-0 font-mono text-[var(--muted)] opacity-70">{h.time}</span>
                <span className="text-[var(--muted)]">{h.msg}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <details className="app-card overflow-hidden" open={!isRunning}>
        <summary className="cursor-pointer border-b border-[rgba(99,86,70,0.16)] px-4 py-3 text-sm font-extrabold text-[var(--ink)]">
          Technical log
        </summary>
        {log ? (
          <div className="relative max-h-[42vh]">
            <pre
              ref={logRef}
              onScroll={handleLogScroll}
              className="code-surface max-h-[42vh] overflow-y-auto rounded-none border-0 p-4 text-xs leading-relaxed scrollbar-thin"
            >
              {log}
            </pre>

            {hasUnseenUpdates && (
              <button
                type="button"
                onClick={scrollToBottom}
                className="absolute bottom-3 right-3 rounded-full border border-[var(--accent)]/30 bg-[var(--paper)] px-3 py-1.5 text-[11px] font-bold text-[var(--accent)] shadow-lg shadow-black/10 transition hover:-translate-y-0.5"
              >
                Jump to latest
              </button>
            )}
          </div>
        ) : (
          <div className="px-4 py-5 text-sm text-[var(--muted)]">Waiting for pipeline output...</div>
        )}
      </details>
    </div>
  )
}

// ── Done panel ────────────────────────────────────────────────────────────────

function escapeLeanHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function renderLeanLine(line: string): string {
  const escaped = escapeLeanHtml(line)
  const commentIndex = escaped.indexOf('--')
  const code = commentIndex >= 0 ? escaped.slice(0, commentIndex) : escaped
  const comment = commentIndex >= 0 ? escaped.slice(commentIndex) : ''

  let rendered = code
    .replace(/\b(import)\b/g, '<span class="lean-keyword">$1</span>')
    .replace(/\b(theorem|lemma|def|example|by|where|namespace|section|variable|variables|open)\b/g, '<span class="lean-keyword">$1</span>')
    .replace(/\b(sorry)\b/g, '<span class="lean-sorry">$1</span>')
    .replace(/\b(True|False|Prop|Type|Nat|Int|Rat|Real)\b/g, '<span class="lean-type">$1</span>')
    .replace(/\b(theorem|lemma|def)\s+([A-Za-z_][A-Za-z0-9_']*)/g, '<span class="lean-keyword">$1</span> <span class="lean-name">$2</span>')

  if (comment) {
    rendered += `<span class="lean-comment">${comment}</span>`
  }
  return rendered || '&nbsp;'
}

function LeanCodeViewer({ code }: { code: string }) {
  const lines = code.split('\n')
  return (
    <div className="lean-code-viewer max-h-[62vh] overflow-auto scrollbar-thin">
      <ol className="lean-code-lines">
        {lines.map((line, index) => (
          <li key={`${index}-${line.slice(0, 12)}`} className="lean-code-line">
            <span className="lean-line-number">{index + 1}</span>
            <span
              className="lean-line-content"
              dangerouslySetInnerHTML={{ __html: renderLeanLine(line) }}
            />
          </li>
        ))}
      </ol>
    </div>
  )
}

function DonePanel({ jobId }: { jobId: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const [saveState, setSaveState] = useState<'idle' | 'saved' | 'error'>('idle')

  const { data: leanFile = '', isLoading: leanLoading, isError: leanError } = useQuery({
    queryKey: ['raw-artifact', jobId, 'blueprint_lean'],
    queryFn: () => getRawArtifact(jobId, 'blueprint_lean'),
  })

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
        <span className="text-lg text-[var(--accent)]">✓</span>
        <span className="text-base font-extrabold text-[var(--ink)]">Benchmark complete</span>
      </div>
      <p className="mb-6 text-xs text-[var(--muted)]">
        All 9 stages finished. Copy the generated Lean statement file or save it locally.
      </p>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={copyLeanBlueprint}
          className="btn-primary"
        >
          Copy Lean file
        </button>
        <button
          type="button"
          onClick={saveLeanBlueprint}
          className="btn-secondary"
        >
          Save Lean file
        </button>
        {copyState === 'copied' && <span className="text-xs font-semibold text-[var(--accent)]">Copied.</span>}
        {copyState === 'error' && <span className="text-xs font-semibold text-[#b1482f]">Copy failed.</span>}
        {saveState === 'saved' && <span className="text-xs font-semibold text-[var(--accent)]">Download started.</span>}
        {saveState === 'error' && <span className="text-xs font-semibold text-[#b1482f]">Save failed.</span>}
      </div>
      <section className="mt-6 app-card overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-[rgba(99,86,70,0.16)] px-4 py-3">
          <div>
            <p className="eyebrow mb-1">Generated Lean</p>
            <h2 className="text-sm font-extrabold text-[var(--ink)]">Benchmark question file</h2>
          </div>
          {leanLoading && <span className="text-xs text-[var(--muted)]">Loading...</span>}
          {leanError && <span className="text-xs font-semibold text-[#b1482f]">Could not load Lean file.</span>}
        </div>
        {leanFile ? (
          <LeanCodeViewer code={leanFile} />
        ) : !leanLoading && !leanError ? (
          <div className="px-4 py-5 text-sm text-[var(--muted)]">Lean file is not available yet.</div>
        ) : null}
      </section>
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
        <span className="text-lg text-[#b1482f]">✗</span>
        <span className="text-base font-extrabold text-[var(--ink)]">Pipeline error</span>
      </div>
      <p className="mb-4 text-xs font-semibold text-[#b1482f]">{message}</p>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleEditProfile}
          disabled={busy}
          className="btn-primary disabled:opacity-50"
        >
          {busy ? 'Opening editor…' : 'Edit graph/profile again'}
        </button>
        <button
          onClick={() => setShowLog((v) => !v)}
          className="btn-secondary"
        >
          {showLog ? 'Hide log' : 'Show pipeline log'}
        </button>
        {editError && <span className="text-xs font-semibold text-[#b1482f]">{editError}</span>}
      </div>
      {showLog && log && (
        <pre className="code-surface mt-3 max-h-96 overflow-x-auto whitespace-pre-wrap p-4 text-xs leading-relaxed scrollbar-thin">
          {log}
        </pre>
      )}
    </div>
  )
}
