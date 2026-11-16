// `settings_read`: what each setting the agent may propose is right now, and which settings cards still wait for the owner, so
// a session checks before it tells him a change is "pending" or "done" (it must not read the Talos home to find out). A thread's
// own session sees the global rows and its own thread only.
import { AGENT_PATH_FORMS, type AgentConfigPath, ConfigCardPayload, readConfigPath } from '@talos-app/protocol'
import type { BridgeContext } from '../context.ts'
import { isScreenAllowCard } from '../screen-consent.ts'

const MAX_VALUE = 120
const THREAD_FORM = /^threads\.<id>\.(\w+)$/

function show(path: string, value: unknown, scope?: string): string {
  if (path === 'default_thread' && scope !== undefined) return value === scope ? '"this thread"' : '"another thread"'
  if (value === undefined) return '(not set)'
  if (path === 'agent.voice_persona')
    return typeof value === 'string' && value ? `(set, ${value.length} characters)` : '(none)'
  if (path === 'theme')
    return value && typeof value === 'object' && Object.keys(value).length ? '(custom theme)' : '(default)'
  const j = JSON.stringify(value) ?? '(not set)'
  return j.length > MAX_VALUE ? `${j.slice(0, MAX_VALUE)}…` : j
}

export function settingsReadText(ctx: BridgeContext, scope?: string): string {
  ctx.config.refresh()
  const cfg = ctx.config.config
  const lines: string[] = []
  for (const form of AGENT_PATH_FORMS) {
    if (form.includes('<')) continue
    lines.push(`${form}: ${show(form, readConfigPath(cfg, form as AgentConfigPath), scope)}`)
  }
  const fields = AGENT_PATH_FORMS.flatMap((f) => THREAD_FORM.exec(f)?.[1] ?? [])
  for (const t of cfg.threads) {
    if (t.archived || (scope !== undefined && t.id !== scope)) continue
    for (const f of fields) {
      const path = `threads.${t.id}.${f}`
      lines.push(`${path}: ${show(path, readConfigPath(cfg, path as AgentConfigPath))}`)
    }
  }
  const pending = ctx.ledger
    .list('pending')
    .filter((r) => r.actor === 'bridge' && r.binding.kind === 'config' && !isScreenAllowCard(r.binding))
    .filter((r) => scope === undefined || r.thread_id === scope)
  if (!pending.length) lines.push('Pending settings cards: none')
  for (const r of pending) {
    const p = ConfigCardPayload.safeParse(r.binding.payload)
    const mine = (path: string) => scope === undefined || !path.startsWith('threads.') || path.split('.')[1] === scope
    const paths = p.success
      ? p.data.changes.map((c) => (mine(c.path) ? c.path : "another thread's setting")).join(', ')
      : 'unreadable'
    lines.push(`Pending settings cards: ${r.id} (${paths}, expires ${r.expires_at})`)
  }
  return lines.join('\n')
}
