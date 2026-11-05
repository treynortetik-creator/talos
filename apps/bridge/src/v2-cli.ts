// CLI entry points for the v2 features (docs/V2-FEATURES.md V8). WP-V0 STUBS: each owning work package replaces its
// branch (WP-V2 `search`, WP-V5 `memory`) without touching cli.ts again. `share` is WP-V4 P1 (below).

import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { ShareTokenId } from '@talos-app/protocol'
import type { CliDeps } from './cli-main.ts'
import type { BridgeEnv } from './config.ts'
import { assertSecureRelayUrl, paths as pathsOf } from './config.ts'
import { DeviceStore } from './devices.ts'
import { ensureDir, writeFileAtomic } from './fsutil.ts'
import { openHistory } from './history-store.ts'
import { loadBridgeKey } from './keys.ts'
import { cmdMemory } from './memory/cli.ts'
import { RelayHttp } from './relay-http.ts'
import { indexerFor } from './search/install.ts'
import {
  buildShortcutPlist,
  exportLabel,
  manualSteps,
  signCommand,
  signWithShortcutsCli,
  slug,
} from './share/shortcut.ts'

type IO = {
  out(line: string): void
  err(line: string): void
  prompt?(question: string): Promise<string>
  now?: () => number
}

export const V2_USAGE = `  search reindex
  memory init [--agent-dir <dir>] | on | off | show | reindex
  share revoke <id> | share shortcut [--label <label>] [--files] [--device <id>]`

const OWNER: Record<string, string> = { search: 'WP-V2', memory: 'WP-V5', share: 'WP-V4' }

/** Returns the exit code. */
export async function cmdV2(
  cmd: 'search' | 'memory' | 'share',
  env: BridgeEnv,
  args: string[],
  io: IO,
  deps: CliDeps = {},
): Promise<number> {
  if (cmd === 'memory') return await cmdMemory(env, args, io)
  const sub = args[0] ?? ''
  if (cmd === 'search' && sub === 'reindex') return await searchReindex(env, io)
  if (cmd === 'share' && sub === 'revoke') return await shareRevoke(env, args.slice(1), io)
  if (cmd === 'share' && sub === 'shortcut') return await shareShortcut(env, args.slice(1), io, deps)
  if (cmd === 'share') {
    io.err(`talos-app share${sub ? ` ${sub}` : ''}: unknown.\n${SHARE_USAGE}`)
    return 2
  }
  io.err(`talos-app ${cmd}${sub ? ` ${sub}` : ''}: not available in this build yet (${OWNER[cmd]}).`)
  return 2
}

/** `talos-app search reindex` (docs/V2-FEATURES.md V3.1): everything again, in one transaction. */
async function searchReindex(env: BridgeEnv, io: IO): Promise<number> {
  const p = pathsOf(env.home)
  if (!existsSync(p.historyDb)) {
    io.err('talos-app search reindex: no history on this Mac yet.')
    return 1
  }
  const store = openHistory(p.historyDb)
  try {
    const ix = indexerFor(store)
    if (!ix) {
      io.err("talos-app search reindex: this Mac's SQLite has no FTS5; search and the memory browser are off.")
      return 1
    }
    const n = await ix.rebuildAll()
    if (ix.dirty()) {
      io.err('talos-app search reindex: the rebuild did not finish; the running bridge will finish it.')
      return 1
    }
    io.out(`Search index rebuilt: ${n} message${n === 1 ? '' : 's'}.`)
    return 0
  } finally {
    store.close()
  }
}

// ---- share (docs/V2-FEATURES.md V4.3, P1) ---------------------------------------------------------------------------

const SHARE_USAGE = 'usage: talos-app share revoke <id> | share shortcut [--label <label>] [--files] [--device <id>]'

async function relayFor(env: BridgeEnv): Promise<{ http: RelayHttp; relayUrl: string }> {
  if (!env.relayUrl) throw new Error('TALOS_APP_RELAY_URL is not set (run: talos-app init --relay-url <url>)')
  assertSecureRelayUrl(env.relayUrl)
  const key = await loadBridgeKey(pathsOf(env.home))
  return { http: new RelayHttp(env.relayUrl, () => key), relayUrl: env.relayUrl }
}

/** `talos-app share revoke <id>`: the next post with that link's secret gets 401. Revoking twice is fine. */
async function shareRevoke(env: BridgeEnv, args: string[], io: IO): Promise<number> {
  const id = args[0]
  if (args.length !== 1 || !id || !ShareTokenId.safeParse(id).success) {
    io.err(`talos-app share revoke: need one share link id (sh_...).\n${SHARE_USAGE}`)
    return 2
  }
  const { http } = await relayFor(env)
  if (!(await http.revokeShareToken(id))) {
    io.err(`talos-app share revoke: no share link ${id} on this relay.`)
    return 1
  }
  io.out(`Share link ${id} revoked. Its secret now gets 401.`)
  return 0
}

/** The newest pinned, not revoked device on this Mac: the one a new link binds to unless `--device` names another. */
function pickDevice(env: BridgeEnv, wanted: string | undefined): string | undefined {
  const live = new DeviceStore(pathsOf(env.home).devicesJson)
    .list()
    .filter((d) => d.pinned_at && !d.revoked_at)
    .sort((a, b) => (b.pinned_at ?? '').localeCompare(a.pinned_at ?? ''))
  if (wanted) return live.find((d) => d.id === wanted)?.id
  return live[0]?.id
}

const dayOf = (ms: number) =>
  new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)

/**
 * `talos-app share shortcut`: mints a FRESH token per export and writes the iOS Shortcut that uses it. Shortcut shares
 * are untrusted Inbox data (a Shortcut cannot sign) and this command has no option to change that.
 */
async function shareShortcut(env: BridgeEnv, args: string[], io: IO, deps: CliDeps): Promise<number> {
  let values: { label?: string; files?: boolean; device?: string }
  try {
    values = parseArgs({
      args,
      options: { label: { type: 'string' }, files: { type: 'boolean' }, device: { type: 'string' } },
      strict: true,
    }).values
  } catch (e) {
    io.err(`talos-app share shortcut: ${(e as Error).message}\n${SHARE_USAGE}`)
    return 2
  }
  const deviceId = pickDevice(env, values.device)
  if (!deviceId) {
    io.err(
      values.device
        ? `talos-app share shortcut: ${values.device} is not a pinned device on this Mac.`
        : 'talos-app share shortcut: no pinned device on this Mac. Enroll Talos on your phone first.',
    )
    return 1
  }
  const { http, relayUrl } = await relayFor(env)
  const day = dayOf(io.now?.() ?? Date.now())
  const label = exportLabel(values.label ?? 'iPhone', day)
  const files = values.files === true
  const { token, secret } = await http.createShareToken({
    label,
    device_id: deviceId,
    scopes: files ? ['text', 'files'] : ['text'],
  })

  const dir = join(env.home, 'shortcuts')
  ensureDir(dir)
  const stem = `talos-share-${slug(values.label ?? 'iPhone')}-${day}`
  // `shortcuts sign` only reads a file named *.shortcut; an XML property list under that name is fine.
  const plistPath = join(dir, `${stem}.unsigned.shortcut`)
  const shortcutPath = join(dir, `${stem}.shortcut`)
  writeFileAtomic(plistPath, buildShortcutPlist({ relayUrl, secret, files, askForNote: true }), 0o600)

  io.out(
    `Share link "${label}" (${token.id}) created for device ${deviceId}${files ? ', photos and files allowed' : ''}.`,
  )
  const revoke = `Revoke it in Settings, Share from other apps, or: talos-app share revoke ${token.id}`
  const platform = deps.platform ?? process.platform
  let signError: string | undefined
  if (platform === 'darwin') {
    const r = await (deps.sign ?? signWithShortcutsCli)(plistPath, shortcutPath)
    if (r.ok) {
      rmSync(plistPath, { force: true }) // one copy of the key on disk, not two
      io.out(`Shortcut written: ${shortcutPath}`)
      io.out('Send it to your iPhone (AirDrop or Messages), open it, tap Add Shortcut.')
      io.out('The file contains the key. Forwarding it forwards the key.')
      io.out(revoke)
      return 0
    }
    signError = r.error
  }
  io.out(`Recipe written, not signed: ${plistPath}`)
  io.out('It contains the key (mode 0600). iOS only imports signed Shortcuts, so sign it on a Mac first:')
  io.out(`  ${signCommand(plistPath, shortcutPath)}`)
  io.out('Then send the .shortcut to your iPhone, open it, tap Add Shortcut.')
  if (signError) io.out(`Signing just now failed (${signError}). It needs macOS 12+ with an iCloud sign-in.`)
  else io.out('This machine is not macOS, so it was not signed here.')
  for (const l of manualSteps(files)) io.out(l)
  io.out('For the by-hand route, the key is the Authorization header inside the unsigned file. Do not forward it.')
  io.out(revoke)
  return 0
}
