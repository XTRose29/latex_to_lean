import type {
  ProjectCreate,
  ProjectRead,
  JobRead,
  JobStatus,
  ProfileSubmit,
  EditedGraph,
} from '../types/api'

// Re-export for consumers who import from api/index
export type { EditedGraph }

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: { ...(options.headers ?? {}) },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

// ── Projects ──────────────────────────────────────────────────────────────────

export async function createProject(data: ProjectCreate): Promise<ProjectRead> {
  return request('/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export async function listProjects(): Promise<ProjectRead[]> {
  return request('/projects')
}

export async function deleteProject(id: string): Promise<void> {
  await fetch(`/projects/${id}`, { method: 'DELETE' })
}

// ── Jobs ──────────────────────────────────────────────────────────────────────

export async function createJob(projectId: string): Promise<JobRead> {
  return request(`/projects/${projectId}/jobs`, { method: 'POST' })
}

export async function listProjectJobs(projectId: string): Promise<JobRead[]> {
  return request(`/projects/${projectId}/jobs`)
}

export async function getJob(jobId: string): Promise<JobRead> {
  return request(`/jobs/${jobId}`)
}

export async function getJobStatus(jobId: string): Promise<JobStatus> {
  return request(`/jobs/${jobId}/status`)
}

export interface TokenUsage {
  total_input_tokens: number
  total_output_tokens: number
  total_tokens: number
  model: string
}

export async function getJobTokens(jobId: string): Promise<TokenUsage> {
  return request(`/jobs/${jobId}/tokens`)
}

export async function getJobLog(jobId: string, lines = 200): Promise<string> {
  const res = await fetch(`/jobs/${jobId}/log?lines=${lines}`)
  if (!res.ok) throw new Error(`${res.status}`)
  return res.text()
}

export async function getArtifact<T>(jobId: string, name: string): Promise<T> {
  return request(`/jobs/${jobId}/artifacts/${name}`)
}

export async function getRawArtifact(jobId: string, name: string): Promise<string> {
  const res = await fetch(`/jobs/${jobId}/artifacts/${name}/raw`)
  if (!res.ok) throw new Error(`${res.status}`)
  return res.text()
}

export async function downloadRawArtifact(jobId: string, name: string, fallbackFilename: string): Promise<void> {
  const res = await fetch(`/jobs/${jobId}/artifacts/${name}/raw?download=true`)
  if (!res.ok) throw new Error(`${res.status}`)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  const disposition = res.headers.get('Content-Disposition') ?? ''
  const filenameMatch = disposition.match(/filename="?([^";]+)"?/i)
  link.href = url
  link.download = filenameMatch?.[1] ?? fallbackFilename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export async function submitProfile(jobId: string, data: ProfileSubmit): Promise<JobRead> {
  return request(`/jobs/${jobId}/profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export async function resumeJob(jobId: string): Promise<JobRead> {
  return request(`/jobs/${jobId}/resume`, { method: 'POST' })
}

export async function reopenProfileEditor(jobId: string): Promise<JobRead> {
  return request(`/jobs/${jobId}/edit-profile`, { method: 'POST' })
}

export async function cancelJob(jobId: string): Promise<JobRead> {
  return request(`/jobs/${jobId}`, { method: 'DELETE' })
}

// ── Dev settings (DEV-ONLY — remove with dev_settings.py) ────────────────────

export interface ApiSettingsRead {
  anthropic_api_key_set: boolean
  key_source: string
  anthropic_base_url: string
  claude_model: string
  aws_profile: string
  bedrock_model: string
  active_provider: string
}

export interface ApiSettingsWrite {
  anthropic_api_key?: string
  anthropic_base_url?: string
  claude_model?: string
  aws_profile?: string
  bedrock_model?: string
}

export async function getApiSettings(): Promise<ApiSettingsRead> {
  return request('/dev/settings')
}

export async function saveApiSettings(data: ApiSettingsWrite): Promise<ApiSettingsRead> {
  return request('/dev/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}
