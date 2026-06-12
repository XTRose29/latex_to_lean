import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createJob, createProject } from '../api'

export default function NewProjectPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [name, setName] = useState('')
  const [latex, setLatex] = useState('')
  const [selectedFileName, setSelectedFileName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const createMut = useMutation({
    mutationFn: async () => {
      const project = await createProject({
        name,
        latex_content: latex,
      })
      await qc.invalidateQueries({ queryKey: ['projects'] })
      const job = await createJob(project.id)
      return job
    },
    onSuccess: (job) => navigate(`/jobs/${job.id}`),
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!latex.trim()) {
      setError('LaTeX content is required.')
      return
    }
    setError(null)
    createMut.mutate()
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (!/\.(tex|txt|latex)$/i.test(file.name)) {
      setError('Upload a .tex, .txt, or .latex file.')
      e.target.value = ''
      return
    }
    try {
      const text = await file.text()
      setLatex(text)
      setSelectedFileName(file.name)
      if (!name.trim()) {
        setName(file.name.replace(/\.(tex|txt|latex)$/i, ''))
      }
      setError(null)
    } catch {
      setError('Could not read the selected file.')
    }
  }

  return (
    <div className="page-shell max-w-4xl">
      <section className="mb-6">
        <p className="eyebrow">Source Input</p>
        <h1 className="text-3xl font-extrabold leading-tight text-[var(--ink)]">New project</h1>
        <p className="app-copy mt-3">Paste a theorem and proof directly, or upload a local LaTeX file. The first Claude-eligible step happens only after deterministic extraction and your confirmation.</p>
      </section>
      <form onSubmit={handleSubmit} className="app-card flex flex-col gap-5 p-6">
        <div>
          <label className="field-label">Project name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="e.g. Infinitely many primes"
            autoFocus
            className="field-input"
          />
        </div>

        <div>
          <label className="field-label">
            LaTeX content{' '}
            <span className="text-[var(--muted)] opacity-70">(theorem statement + proof)</span>
          </label>
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--line)] bg-[rgba(255,253,249,0.72)] px-3 py-2">
            <label className="btn-secondary cursor-pointer px-3 py-1.5 text-xs">
              Upload .tex/.txt
              <input
                type="file"
                accept=".tex,.txt,.latex,text/plain,text/x-tex"
                onChange={handleFileUpload}
                className="hidden"
              />
            </label>
            <span className="text-xs text-[var(--muted)]">
              {selectedFileName || 'Or paste/edit LaTeX directly below.'}
            </span>
          </div>
          <textarea
            value={latex}
            onChange={(e) => setLatex(e.target.value)}
            required
            rows={14}
            placeholder="\begin{theorem}&#10;  ...&#10;\end{theorem}&#10;\begin{proof}&#10;  ...&#10;\end{proof}"
            className="code-surface w-full resize-y px-3 py-2 text-sm leading-relaxed outline-none scrollbar-thin focus:ring-2 focus:ring-[rgba(15,94,83,0.2)]"
          />
        </div>

        {error && <p className="text-xs font-semibold text-[#b1482f]">{error}</p>}

        <div className="flex items-center gap-4">
          <button
            type="submit"
            disabled={createMut.isPending}
            className="btn-primary disabled:opacity-50"
          >
            {createMut.isPending ? 'Creating…' : 'Create & start pipeline'}
          </button>
          <button
            type="button"
            onClick={() => navigate('/projects')}
            className="btn-ghost"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}
