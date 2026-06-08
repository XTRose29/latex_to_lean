/**
 * DEV-ONLY settings page for API credentials.
 * Remove this file and its route in App.tsx when moving to production.
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getApiSettings, saveApiSettings } from '../api'
import type { ApiSettingsWrite } from '../api'

const PROVIDER_LABELS: Record<string, string> = {
  api_key: 'Anthropic API key',
  subscription: 'Claude subscription (CLI)',
}

export default function DevSettingsPage() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['dev-settings'],
    queryFn: getApiSettings,
  })

  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const endpointWarning = baseUrl.trim().startsWith('http://')

  const mut = useMutation({
    mutationFn: (payload: ApiSettingsWrite) => saveApiSettings(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dev-settings'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
      setApiKey('')  // clear after save — don't keep key in state
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const payload: ApiSettingsWrite = {}
    const normalizedBaseUrl = baseUrl.trim() === 'api.ai.it.cornell.edu'
      ? 'https://api.ai.it.cornell.edu/'
      : baseUrl.trim().startsWith('http://api.ai.it.cornell.edu')
        ? baseUrl.trim().replace('http://', 'https://')
        : baseUrl.trim()
    if (apiKey) payload.anthropic_api_key = apiKey
    if (normalizedBaseUrl) payload.anthropic_base_url = normalizedBaseUrl
    if (model) payload.claude_model = model
    mut.mutate(payload)
  }

  if (isLoading) return <div className="page-shell text-sm text-[var(--muted)]">Loading...</div>

  return (
    <div className="page-shell max-w-3xl">
      {/* DEV banner */}
      <div className="mb-6 rounded-xl border border-[#b1482f]/30 bg-[#fff2df] px-4 py-3 text-xs leading-relaxed text-[#8f2d18]">
        <span className="font-bold">LOCAL CREDENTIALS</span> — Enter your own Claude-compatible API key and endpoint here.
        The backend saves these settings to <code className="font-mono">.env</code> in the repo root, which is gitignored.
        No separate local API-key file is needed.
      </div>

      <div className="mb-6">
        <p className="eyebrow mb-2">Claude access</p>
        <h2 className="text-3xl font-extrabold text-[var(--ink)]">API settings</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--muted)]">
          The pipeline calls Claude only for natural-language proof decomposition and Lean statement synthesis.
          Paste a personal Anthropic key, or use a compatible gateway/proxy endpoint such as your institution endpoint.
        </p>
        <div className="mt-3 flex flex-wrap gap-3 text-xs text-[var(--muted)]">
          <span>Active provider: <span className="font-semibold text-[var(--ink)]">{PROVIDER_LABELS[data?.active_provider ?? ''] ?? data?.active_provider ?? '—'}</span></span>
          <span>Key source: <span className="font-mono text-[var(--ink)]">{data?.key_source ?? '—'}</span></span>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="app-card flex flex-col gap-6 p-6">
        {/* Anthropic API key */}
        <section>
          <h3 className="eyebrow mb-2">
            Credentials
          </h3>
          <p className="mb-4 text-sm leading-6 text-[var(--muted)]">
            Use an Anthropic API key or a key issued by a Claude-compatible gateway. Leave a field blank to keep the current saved value.
          </p>
          <div className="flex flex-col gap-3">
            <div>
              <label className="field-label">
                API key{' '}
                {data?.anthropic_api_key_set && (
                  <span className="text-[var(--accent)]">✓ currently set</span>
                )}
              </label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={data?.anthropic_api_key_set ? '(leave blank to keep current key)' : 'sk-ant-... or gateway key'}
                className="field-input font-mono"
              />
            </div>
            <div>
              <label className="field-label">
                API endpoint / base URL{' '}
                <span className="text-[var(--muted)] opacity-70">(optional)</span>
              </label>
              <div className="mb-2 flex flex-wrap gap-2">
                {[
                  { label: 'Anthropic default', value: 'https://api.anthropic.com' },
                  { label: 'Cornell gateway', value: 'https://api.ai.it.cornell.edu/' },
                ].map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setBaseUrl(opt.value)}
                    className="rounded border border-[var(--line)] px-3 py-1 text-xs font-medium text-[var(--muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={data?.anthropic_base_url || 'https://api.anthropic.com or https://api.ai.it.cornell.edu/'}
                className="field-input font-mono"
              />
              {endpointWarning && (
                <p className="mt-1.5 text-xs font-semibold text-[#b1482f]">
                  Use https:// for API endpoints. The Cornell gateway should be https://api.ai.it.cornell.edu/.
                </p>
              )}
            </div>
            <div>
              <label className="field-label">Model used for Claude calls</label>
              <p className="mb-2 text-xs leading-relaxed text-[var(--muted)]">
                This model is used only for the two LLM stages: proof-to-graph and Lean statement synthesis.
              </p>
              {/* Quick-select buttons */}
              <div className="flex gap-2 mb-2 flex-wrap">
                {[
                  { label: 'Sonnet 4.5', value: 'claude-sonnet-4-5' },
                  { label: 'Sonnet 4.6', value: 'claude-sonnet-4-6' },
                  { label: 'Opus 4.5', value: 'claude-opus-4-5' },
                  { label: 'Opus 4.7', value: 'claude-opus-4-7' },
                ].map((opt) => {
                  const active = (model || data?.claude_model || '') === opt.value
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setModel(opt.value)}
                      className={[
                        'rounded px-3 py-1 text-xs font-medium border transition-colors',
                        active
                          ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                          : 'border-[var(--line)] text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]',
                      ].join(' ')}
                    >
                      {opt.label}
                    </button>
                  )
                })}
              </div>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={data?.claude_model || 'claude-sonnet-4-6'}
                className="field-input font-mono"
              />
            </div>
          </div>
        </section>


        {error && <p className="text-xs font-semibold text-[#b1482f]">{error}</p>}

        <div className="flex items-center gap-4">
          <button
            type="submit"
            disabled={mut.isPending}
            className="btn-primary disabled:opacity-50"
          >
            {mut.isPending ? 'Saving...' : 'Save API settings'}
          </button>
          {saved && <span className="text-xs font-semibold text-[var(--accent)]">Saved. New pipeline jobs will use these settings.</span>}
        </div>
      </form>
    </div>
  )
}
