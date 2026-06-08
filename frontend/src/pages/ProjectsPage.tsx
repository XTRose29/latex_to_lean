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
    // Find latest job or create a new one
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
    return <div className="p-8 text-zinc-400 text-sm">Loading…</div>
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Projects</h2>
        <Link
          to="/projects/new"
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
        >
          New project
        </Link>
      </div>

      {projects.length === 0 ? (
        <div className="rounded border border-zinc-800 p-8 text-center text-sm text-zinc-500">
          No projects yet.{' '}
          <Link to="/projects/new" className="text-blue-400 hover:text-blue-300">
            Create one
          </Link>{' '}
          to get started.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {projects.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between rounded border border-zinc-800 bg-zinc-900 px-5 py-4"
            >
              <div>
                <div className="text-sm font-medium text-zinc-100">{p.name}</div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  {p.theorem_label ? `${p.theorem_label} · ` : ''}
                  {new Date(p.created_at).toLocaleDateString()}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => handleOpenJob(p)}
                  className="rounded bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700"
                >
                  Open
                </button>
                <button
                  onClick={() => {
                    if (confirm(`Delete "${p.name}"?`)) deleteMut.mutate(p.id)
                  }}
                  className="text-xs text-zinc-600 hover:text-red-400"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
