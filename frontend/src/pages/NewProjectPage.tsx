import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createJob, createProject } from '../api'

export default function NewProjectPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [name, setName] = useState('')
  const [chapter, setChapter] = useState('1')
  const [theoremLabel, setTheoremLabel] = useState('')
  const [latex, setLatex] = useState('')
  const [selectedFileName, setSelectedFileName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const createMut = useMutation({
    mutationFn: async () => {
      const project = await createProject({
        name,
        latex_content: latex,
        chapter: parseInt(chapter, 10),
        theorem_label: theoremLabel || undefined,
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
    <div className="mx-auto max-w-2xl px-6 py-8">
      <h2 className="mb-6 text-lg font-semibold">New project</h2>
      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <div>
          <label className="mb-1 block text-xs text-zinc-400">Project name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="e.g. Infinitely many primes"
            autoFocus
            className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500"
          />
        </div>

        <div className="flex gap-4">
          <div className="flex-1">
            <label className="mb-1 block text-xs text-zinc-400">Chapter / section number</label>
            <input
              type="number"
              min={1}
              value={chapter}
              onChange={(e) => setChapter(e.target.value)}
              required
              className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex-1">
            <label className="mb-1 block text-xs text-zinc-400">
              Theorem label{' '}
              <span className="text-zinc-600">(optional)</span>
            </label>
            <input
              type="text"
              value={theoremLabel}
              onChange={(e) => setTheoremLabel(e.target.value)}
              placeholder="e.g. thm_inf_primes"
              className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500"
            />
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs text-zinc-400">
            LaTeX content{' '}
            <span className="text-zinc-600">(theorem statement + proof)</span>
          </label>
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded border border-zinc-800 bg-zinc-950 px-3 py-2">
            <label className="cursor-pointer rounded bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-100 hover:bg-zinc-700">
              Upload .tex/.txt
              <input
                type="file"
                accept=".tex,.txt,.latex,text/plain,text/x-tex"
                onChange={handleFileUpload}
                className="hidden"
              />
            </label>
            <span className="text-xs text-zinc-500">
              {selectedFileName || 'Or paste/edit LaTeX directly below.'}
            </span>
          </div>
          <textarea
            value={latex}
            onChange={(e) => setLatex(e.target.value)}
            required
            rows={14}
            placeholder="\begin{theorem}&#10;  ...&#10;\end{theorem}&#10;\begin{proof}&#10;  ...&#10;\end{proof}"
            className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-300 outline-none focus:border-blue-500 font-mono leading-relaxed resize-y scrollbar-thin"
          />
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex items-center gap-4">
          <button
            type="submit"
            disabled={createMut.isPending}
            className="rounded bg-blue-600 px-6 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {createMut.isPending ? 'Creating…' : 'Create & start pipeline'}
          </button>
          <button
            type="button"
            onClick={() => navigate('/projects')}
            className="text-sm text-zinc-500 hover:text-zinc-300"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}
