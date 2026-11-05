// What the owner approves (M5.1): the manifest behind the approval key, the diff shown when it changes, the labels that
// are refused, and the approval screen text. Pure functions; the terminal I/O lives in scan.ts.
import { type AppCspT, type ApprovalManifestT, approvalKey, type CatalogToolT } from '@talos-app/protocol'
import { runsWithoutTap } from './catalog.ts'

/** Labels containing any of these (and the agent's own name) are refused at scan: they could imitate Talos UI (M4.7). */
export const RESERVED_LABEL_WORDS = ['talos', 'approve', 'card', 'sign in', 'code', 'password'] as const

export function labelProblem(label: string, agentNames: string[] = []): string | undefined {
  const l = label.trim()
  if (l.length === 0) return 'A label is required.'
  if (l.length > 60) return 'A label is at most 60 characters.'
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point of this check
  if (/[\u0000-\u001f\u007f<>]/.test(l)) return 'A label has no control characters or angle brackets.'
  const lower = l.toLowerCase()
  for (const w of [...RESERVED_LABEL_WORDS, ...agentNames.map((a) => a.toLowerCase()).filter(Boolean)])
    if (lower.includes(w)) return `A label can't contain "${w}": it could pass for part of Talos.`
  return undefined
}

export type ManifestInput = {
  server: string
  source: string
  resource: {
    uri: string
    html_sha256: string
    csp: AppCspT
    permissions_requested: string[]
    prefers_border?: boolean | undefined
  }
  tools: CatalogToolT[]
  direct?: ApprovalManifestT['direct'] | undefined
}

export function manifestOf(i: ManifestInput): ApprovalManifestT {
  return {
    server: i.server,
    source: i.source,
    resource_uri: i.resource.uri,
    html_sha256: i.resource.html_sha256,
    csp: i.resource.csp,
    permissions_requested: i.resource.permissions_requested,
    ...(i.resource.prefers_border !== undefined ? { prefers_border: i.resource.prefers_border } : {}),
    tools: i.tools,
    ...(i.direct ? { direct: i.direct } : {}),
  }
}

export const keyOf = (i: ManifestInput): string => approvalKey(manifestOf(i))

/** `show` default: ask when the server is not a local config scope or is remote, else auto. */
export function defaultShow(source: string, directType: string | undefined): 'auto' | 'ask' {
  const local = source === 'local' || source === 'project' || source === 'user'
  const remote = directType === 'http' || directType === 'sse'
  return !local || remote ? 'ask' : 'auto'
}

// ---- tool lines ----------------------------------------------------------------------------------------------------

export function visibilityWords(t: Pick<CatalogToolT, 'visibility'>): string {
  const m = t.visibility.includes('model')
  const a = t.visibility.includes('app')
  return m && a ? 'agent + app' : a ? 'app only' : 'agent only'
}

export const ruleWords = (t: Pick<CatalogToolT, 'read_only' | 'destructive'> & { open_world?: boolean }): string =>
  runsWithoutTap(t) ? 'runs without a tap (server says read-only)' : 'asks you each time (a card, trust mode or not)'

// ---- diff ----------------------------------------------------------------------------------------------------------

const setDiff = (a: string[], b: string[]) => b.filter((x) => !a.includes(x))

export function diffManifests(prev: ApprovalManifestT, next: ApprovalManifestT): string[] {
  const out: string[] = []
  if (prev.html_sha256 !== next.html_sha256) out.push('HTML changed')
  const lists: Array<[keyof AppCspT, string]> = [
    ['connect_domains', 'now may also connect to'],
    ['resource_domains', 'now may also load images, fonts and media from'],
    ['frame_domains', 'now may also embed pages from'],
    ['base_uri_domains', 'now may also set a base address of'],
    ['script_hashes', 'now runs new inline scripts'],
    ['script_urls', 'now loads new remote scripts'],
    ['style_urls', 'now loads new remote styles'],
  ]
  for (const [k, words] of lists) {
    const added = setDiff(prev.csp[k] as string[], next.csp[k] as string[])
    const removed = setDiff(next.csp[k] as string[], prev.csp[k] as string[])
    if (added.length) out.push(`${words}: ${k === 'script_hashes' ? `${added.length} script(s)` : added.join(', ')}`)
    if (removed.length)
      out.push(`no longer ${k.replace('_', ' ')}: ${removed.length} entr${removed.length === 1 ? 'y' : 'ies'}`)
  }
  const pp = prev.permissions_requested.join()
  if (pp !== next.permissions_requested.join()) out.push('requested permissions changed (they are still denied)')
  if (prev.prefers_border !== next.prefers_border) out.push('border preference changed')
  const before = new Map(prev.tools.map((t) => [t.name, t]))
  const after = new Map(next.tools.map((t) => [t.name, t]))
  for (const [name, t] of after) {
    const o = before.get(name)
    if (!o) {
      out.push(`new tool \`${name}\` (${ruleWords(t)})`)
      continue
    }
    if (o.read_only && !t.read_only) out.push(`\`${name}\` is no longer marked read-only`)
    else if (!o.read_only && t.read_only) out.push(`\`${name}\` is now marked read-only, so it would run without a tap`)
    if (!o.destructive && t.destructive) out.push(`\`${name}\` is now marked destructive`)
    else if (o.destructive && !t.destructive) out.push(`\`${name}\` is no longer marked destructive`)
    if (o.open_world !== t.open_world) out.push(`\`${name}\` open-world label changed`)
    if ([...o.visibility].sort().join() !== [...t.visibility].sort().join())
      out.push(`\`${name}\` visibility changed to ${visibilityWords(t)}`)
    if (o.resource_uri !== t.resource_uri) out.push(`\`${name}\` now shows a different view`)
  }
  for (const name of before.keys()) if (!after.has(name)) out.push(`tool \`${name}\` is gone`)
  const pd = prev.direct
  const nd = next.direct
  if (JSON.stringify(pd ?? null) !== JSON.stringify(nd ?? null)) {
    if (pd?.config_fingerprint !== nd?.config_fingerprint)
      out.push("the server's launch command, URL or headers changed")
    if (pd?.type !== nd?.type || pd?.auth !== nd?.auth) out.push('how Talos reaches this server changed')
  }
  const text = out.join('\n')
  if (text.length <= 2000) return out
  const cut: string[] = []
  let n = 0
  for (const l of out) {
    if (n + l.length + 1 > 1950) break
    cut.push(l)
    n += l.length + 1
  }
  cut.push('(more changes not shown)')
  return cut
}

// ---- the screen ------------------------------------------------------------------------------------------------------

const cspWords = (csp: AppCspT): string[] => {
  const l: string[] = []
  const f = (name: string, v: string[]) => l.push(`  ${name}: ${v.length ? v.join(', ') : 'nothing'}`)
  f('may connect to', csp.connect_domains)
  f('images, fonts, media from', csp.resource_domains)
  f('embeds pages from', csp.frame_domains)
  l.push(`  inline scripts pinned: ${csp.script_hashes.length}`)
  if (csp.script_urls.length) l.push(`  remote scripts pinned: ${csp.script_urls.join(', ')}`)
  if (csp.style_urls.length) l.push(`  remote styles pinned: ${csp.style_urls.join(', ')}`)
  return l
}

export type DirectLine = {
  kind:
    | 'static'
    | 'oauth'
    | 'stdio_app_only'
    | 'stdio_no_tap'
    | 'unsupported_app_only'
    | 'unsupported_no_tap'
    | 'strict'
  url?: string
}

/** The direct-connection lines of M5.6 that belong on the approval screen. */
export function directLines(d: DirectLine): string {
  switch (d.kind) {
    case 'static':
      return `App-only buttons, and the label check before each no-tap call, use Talos's own session with ${d.url ?? 'the server'}, with the same headers; state the agent's session holds on the server isn't shared. Talos keeps a copy of this server's settings, headers included, in your login Keychain.`
    case 'oauth':
      return 'This server needs its own sign-in for Talos: run talos-app apps login <server> on this Mac.'
    case 'stdio_app_only':
      return "App-only buttons won't work for this app yet: Claude Code doesn't share this local server's launch settings with Talos."
    case 'stdio_no_tap':
    case 'unsupported_no_tap':
      return "Talos can't re-check this server's labels between scans; buttons marked 'without a tap' run on the labels you approve now. talos-app apps scan --check re-checks them."
    case 'unsupported_app_only':
      return "App-only buttons won't work for this app."
    case 'strict':
      return "Talos can't re-check this server's labels, so every button asks you each time (strict mode)."
  }
}

export function renderApproval(a: {
  server: string
  source: string
  resource: ManifestInput['resource'] & { size: number }
  key: string
  tools: CatalogToolT[]
  boundTools: string[]
  permissions: string[]
  diff?: string[] | undefined
  directLines: string[]
  frameWarning?: boolean
}): string[] {
  const l: string[] = []
  l.push(`App: ${a.resource.uri}`)
  l.push(`Server: ${a.server} (${a.source})`)
  l.push(`Shown by: ${a.boundTools.join(', ') || '(no tool)'}`)
  l.push(`Size: ${a.resource.size} bytes   Approval key: ${a.key.slice(0, 16)}`)
  l.push('What this app is allowed to reach:')
  l.push(...cspWords(a.resource.csp))
  if (a.permissions.length) l.push(`  requested permissions: ${a.permissions.join(', ')} (requested, will be denied)`)
  if (a.frameWarning)
    l.push('  This app embeds pages from the sites above; their code is not pinned. Default answer is N.')
  l.push('Results this app shows are stored on your relay for 7 days.')
  if (a.diff?.length) {
    l.push('Changed since you last approved it:')
    for (const d of a.diff) l.push(`  - ${d}`)
  }
  l.push('')
  l.push(
    "Approving lets this app run the tools marked 'without a tap' whenever its buttons ask. The server decides those labels; a server that mislabels a tool could change things without asking.",
  )
  l.push('Every tool of this server:')
  for (const t of a.tools) l.push(`  ${t.name}  [${visibilityWords(t)}]  ${ruleWords(t)}`)
  for (const d of a.directLines) l.push(d)
  return l
}
