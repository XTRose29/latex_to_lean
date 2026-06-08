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
  bedrock: 'AWS Bedrock',
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
  const [awsProfile, setAwsProfile] = useState('')
  const [bedrockModel, setBedrockModel] = useState('')
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
    if (apiKey) payload.anthropic_api_key = apiKey
    if (baseUrl) payload.anthropic_base_url = baseUrl
    if (model) payload.claude_model = model
    if (awsProfile) payload.aws_profile = awsProfile
    if (bedrockModel) payload.bedrock_model = bedrockModel
    mut.mutate(payload)
  }

  if (isLoading) return <div className="p-8 text-zinc-400 text-sm">Loading…</div>

  return (
    <div className="mx-auto max-w-xl px-6 py-8">
      {/* DEV banner */}
      <div className="mb-6 rounded border border-amber-700/60 bg-amber-950/40 px-4 py-3 text-xs text-amber-400">
        <span className="font-bold">LOCAL ONLY</span> — These settings write to{' '}
        <code className="font-mono">.env</code> in the repo root. You can also keep using{' '}
        <code className="font-mono">claude_api.txt</code>; both files are gitignored.
      </div>

      <h2 className="mb-1 text-base font-semibold">API credentials</h2>
      <p className="mb-6 text-xs text-zinc-400">
        Active provider:{' '}
        <span className="text-zinc-200 font-medium">
          {PROVIDER_LABELS[data?.active_provider ?? ''] ?? data?.active_provider ?? '—'}
        </span>
        <span className="ml-3 text-zinc-500">
          Key source: <span className="font-mono text-zinc-300">{data?.key_source ?? '—'}</span>
        </span>
      </p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        {/* Anthropic API key */}
        <section>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Anthropic API key
          </h3>
          <div className="flex flex-col gap-3">
            <div>
              <label className="mb-1 block text-xs text-zinc-400">
                API key{' '}
                {data?.anthropic_api_key_set && (
                  <span className="text-green-500">✓ set</span>
                )}
              </label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={data?.anthropic_api_key_set ? '(leave blank to keep current)' : 'sk-ant-…'}
                className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500 font-mono"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">
                Base URL{' '}
                <span className="text-zinc-600">(Cornell proxy or custom endpoint)</span>
              </label>
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={data?.anthropic_base_url || 'https://api.anthropic.com (default)'}
                className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-300 outline-none focus:border-blue-500 font-mono"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">Model</label>
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
                          ? 'border-blue-500 bg-blue-500/20 text-blue-300'
                          : 'border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200',
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
                placeholder={data?.claude_model || 'anthropic.claude-4.6-sonnet'}
                className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-300 outline-none focus:border-blue-500 font-mono"
              />
            </div>
          </div>
        </section>

        {/* AWS Bedrock */}
        <section>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
            AWS Bedrock <span className="normal-case text-zinc-600">(alternative)</span>
          </h3>
          <div className="flex flex-col gap-3">
            <div>
              <label className="mb-1 block text-xs text-zinc-400">AWS profile name</label>
              <input
                type="text"
                value={awsProfile}
                onChange={(e) => setAwsProfile(e.target.value)}
                placeholder={data?.aws_profile || 'e.g. cornell-bedrock'}
                className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-300 outline-none focus:border-blue-500 font-mono"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">Bedrock model ID</label>
              <input
                type="text"
                value={bedrockModel}
                onChange={(e) => setBedrockModel(e.target.value)}
                placeholder={data?.bedrock_model || 'us.anthropic.claude-opus-4-6-v1[1m]'}
                className="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-300 outline-none focus:border-blue-500 font-mono"
              />
            </div>
          </div>
        </section>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex items-center gap-4">
          <button
            type="submit"
            disabled={mut.isPending}
            className="rounded bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {mut.isPending ? 'Saving…' : 'Save to .env'}
          </button>
          {saved && <span className="text-xs text-green-400">Saved — new pipeline jobs will use these settings.</span>}
        </div>
      </form>
    </div>
  )
}
