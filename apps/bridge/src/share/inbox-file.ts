// Zero-tap filing of token shares (docs/V2-FEATURES.md V4.3; review rev 2 note A). The BRIDGE, not the agent, appends
// every Shortcut share to a day file under `$TALOS_APP_HOME/shared-inbox/`, still inside its wrapExternal markers. No
// agent judgment is involved, so a share has nothing to inject into, and the owner never has to tap "save".
import { appendFileSync, chmodSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type MessageT, sanitizeExternal } from '@talos-app/protocol'
import type { BridgeContext } from '../context.ts'
import { ensureDir } from '../fsutil.ts'
import { wrapShared } from '../notify.ts'

export const SHARED_INBOX_DIR = 'shared-inbox'

export function sharedInboxDir(home: string): string {
  return join(home, SHARED_INBOX_DIR)
}

function localParts(iso: string, zone: string): { day: string; time: string } {
  const d = new Date(iso)
  const ok = Number.isFinite(d.getTime())
  const at = ok ? d : new Date(0)
  try {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(at)
      .slice(0, 10)
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false })
      .format(at)
      .slice(0, 5)
    return { day, time }
  } catch {
    return { day: at.toISOString().slice(0, 10), time: at.toISOString().slice(11, 16) }
  }
}

/**
 * Appends one share to `<home>/shared-inbox/<YYYY-MM-DD>.md` (the owner's time zone) and returns the file path.
 * Idempotent on `share_id`: a replayed `share.item` is never filed twice. Never throws (a failed write only logs).
 */
export function fileShare(
  ctx: Pick<BridgeContext, 'paths' | 'config' | 'log'>,
  a: { shareId: string; label: string; message: MessageT; files: string[] },
): string | undefined {
  try {
    const dir = sharedInboxDir(ctx.paths.home)
    ensureDir(dir)
    const { day, time } = localParts(a.message.created_at, ctx.config.config.timezone)
    const path = join(dir, `${day}.md`)
    const marker = `share ${a.shareId}`
    if (existsSync(path) && readFileSync(path, 'utf8').includes(marker)) return path
    const label = sanitizeExternal(a.label, 40).replace(/[\r\n#]+/g, ' ')
    const lines = [
      `## ${time} · Shared via ${label} · ${marker}`,
      '',
      wrapShared(a.message.share_content ?? {}, `Shared via ${label}`, a.message.text || undefined),
      ...(a.files.length ? ['', ...a.files.map((f) => `- file: ${f}`)] : []),
      '',
      '',
    ]
    const fresh = !existsSync(path)
    appendFileSync(path, `${fresh ? `# Shared ${day}\n\n` : ''}${lines.join('\n')}`, { mode: 0o600 })
    if (fresh) chmodSync(path, 0o600)
    return path
  } catch (e) {
    ctx.log.warn('share not filed', { share_id: a.shareId, error: (e as Error).message })
    return undefined
  }
}
