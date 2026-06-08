import type { JobStatus } from '../types/api'

const STAGE_LABELS = [
  'Problem packet',
  'NL graph',
  'Mathlib check',
  'Profile builder',
  'Dependency graph',
  'Mathlib map',
  'Blueprint',
  'Python Lean check',
  'Packaging',
]

interface Props {
  status: JobStatus
  selectedStage?: number
  onSelectStage?: (stageNum: number) => void
}

export { STAGE_LABELS }

export default function StageTracker({ status, selectedStage, onSelectStage }: Props) {
  const current = status.stage_num
  const isDone = status.state === 'DONE'

  return (
    <div className="flex flex-col gap-1 py-2">
      {STAGE_LABELS.map((label, i) => {
        const stageNum = i + 1
        const completed = isDone ? true : stageNum < current
        const active = stageNum === current && !isDone
        const pending = stageNum > current && !isDone
        const selectable = Boolean(onSelectStage) && !pending
        const selected = selectedStage === stageNum

        return (
          <button
            key={stageNum}
            type="button"
            disabled={!selectable}
            onClick={() => selectable && onSelectStage?.(stageNum)}
            title={selectable ? `View ${label}` : undefined}
            className={[
              'flex w-full items-center gap-3 px-4 py-1 text-left transition-colors',
              selectable ? 'hover:bg-[rgba(15,94,83,0.08)] cursor-pointer' : 'cursor-default',
              selected ? 'bg-[rgba(15,94,83,0.10)]' : '',
            ].join(' ')}
          >
            <div
              className={[
                'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                selected
                  ? 'bg-[var(--ink)] text-white'
                  : completed
                  ? 'bg-[var(--accent)] text-white'
                  : active
                  ? 'bg-[#8f2d18] text-white ring-2 ring-[#8f2d18]/25'
                  : 'bg-[#eadfcd] text-[var(--muted)]',
              ].join(' ')}
            >
              {completed ? '✓' : stageNum}
            </div>
            <span
              className={[
                'text-xs',
                selected
                  ? 'text-[var(--ink)] font-extrabold'
                  : completed
                  ? 'text-[var(--muted)] line-through'
                  : active
                  ? 'text-[var(--ink)] font-bold'
                  : pending
                  ? 'text-[var(--muted)] opacity-60'
                  : 'text-[var(--muted)]',
              ].join(' ')}
            >
              {label}
            </span>
            {active && status.state === 'RUNNING' && (
              <span className="ml-auto text-xs text-[var(--accent)] animate-pulse">running</span>
            )}
            {active && status.state === 'PAUSED' && (
              <span className="ml-auto text-xs text-[#8f2d18]">waiting</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
