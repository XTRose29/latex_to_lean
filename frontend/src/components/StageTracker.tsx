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
}

export default function StageTracker({ status }: Props) {
  const current = status.stage_num
  const isDone = status.state === 'DONE'

  return (
    <div className="flex flex-col gap-1 py-2">
      {STAGE_LABELS.map((label, i) => {
        const stageNum = i + 1
        const completed = isDone ? true : stageNum < current
        const active = stageNum === current && !isDone
        const pending = stageNum > current && !isDone

        return (
          <div key={stageNum} className="flex items-center gap-3 px-4 py-1">
            <div
              className={[
                'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                completed
                  ? 'bg-green-600 text-white'
                  : active
                  ? 'bg-blue-500 text-white ring-2 ring-blue-400/40'
                  : 'bg-zinc-800 text-zinc-500',
              ].join(' ')}
            >
              {completed ? '✓' : stageNum}
            </div>
            <span
              className={[
                'text-xs',
                completed
                  ? 'text-zinc-400 line-through'
                  : active
                  ? 'text-zinc-100 font-semibold'
                  : pending
                  ? 'text-zinc-600'
                  : 'text-zinc-400',
              ].join(' ')}
            >
              {label}
            </span>
            {active && status.state === 'RUNNING' && (
              <span className="ml-auto text-xs text-blue-400 animate-pulse">running</span>
            )}
            {active && status.state === 'PAUSED' && (
              <span className="ml-auto text-xs text-amber-400">waiting</span>
            )}
          </div>
        )
      })}
    </div>
  )
}
