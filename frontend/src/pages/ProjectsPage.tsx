import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { createJob, deleteProject, listProjects, listProjectJobs } from '../api'
import type { ProjectRead } from '../types/api'

export default function ProjectsPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
  })

  const deleteMut = useMutation({
    mutationFn: deleteProject,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  })

  async function handleOpenJob(project: ProjectRead) {
    try {
      const jobs = await listProjectJobs(project.id)
      if (jobs.length > 0) {
        const latest = jobs.sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        )[0]
        navigate(`/jobs/${latest.id}`)
      } else {
        const job = await createJob(project.id)
        navigate(`/jobs/${job.id}`)
      }
    } catch {
      const job = await createJob(project.id)
      navigate(`/jobs/${job.id}`)
    }
  }

  if (isLoading) {
    return <div className="page-shell text-sm text-[var(--muted)]">Loading...</div>
  }

  return (
    <div className="page-shell">
      <section className="mb-7 grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
        <div>
          <p className="eyebrow">Benchmark Builder</p>
          <h1 className="app-title">LaTeX to Lean</h1>
          <p className="mt-4 max-w-5xl text-base leading-7 text-[var(--muted)] md:text-lg">
            Welcome. This local pipeline turns a LaTeX theorem with its proof into a Lean benchmark question: first it extracts the theorem and proof, then builds an editable natural-language dependency graph, lets you choose the benchmark target, and finally emits a Lean statement file with the proof context in comments and `by sorry`. Start by creating a project, then paste LaTeX directly or upload a local `.tex` file.
          </p>
        </div>
        <Link to="/projects/new" className="btn-primary self-start">
          New project
        </Link>
      </section>

      {projects.length === 0 ? (
        <div className="app-card px-8 py-10 text-center text-sm text-[var(--muted)]">
          No projects yet.{' '}
          <Link to="/projects/new" className="font-semibold text-[var(--accent)] hover:text-[#8f2d18]">
            Create one
          </Link>{' '}
          to get started.
        </div>
      ) : (
        <div className="grid gap-3">
          {projects.map((p) => (
            <article key={p.id} className="app-card flex items-center justify-between gap-5 px-5 py-4">
              <div className="min-w-0">
                <div className="truncate text-sm font-bold text-[var(--ink)]">{p.name}</div>
                <div className="mt-1 text-xs text-[var(--muted)]">
                  {p.theorem_label ? `${p.theorem_label} · ` : ''}
                  {new Date(p.created_at).toLocaleDateString()}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button onClick={() => handleOpenJob(p)} className="btn-secondary px-4 py-1.5 text-xs">
                  Open
                </button>
                <button
                  onClick={() => {
                    if (confirm(`Delete "${p.name}"?`)) deleteMut.mutate(p.id)
                  }}
                  className="btn-ghost px-4 py-1.5 text-xs hover:text-[#8f2d18]"
                >
                  Delete
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      <footer className="mt-10 max-w-5xl border-t border-[rgba(99,86,70,0.16)] pt-5 text-sm leading-6 text-[var(--muted)]">
        <p>
          This is part of the project Autoformalization Benchmark for the Working Mathematician from{' '}
          <a
            href="https://danielhl.github.io/math-ai.html"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-[var(--accent)] hover:text-[#8f2d18]"
          >
            Cornell Math+AI Lab
          </a>
          .
        </p>
        <p className="mt-2">
          Developed by Konrad Hartung and Tianruo Rose Xu (
          <a href="mailto:tx88@cornell.edu" className="font-semibold text-[var(--accent)] hover:text-[#8f2d18]">
            tx88@cornell.edu
          </a>
          ). Thanks to our great mentors: Professor Daniel Halpern-Leistner and Hanxi (Gary) Chen.
        </p>
      </footer>
    </div>
  )
}
