// One answer to "where is Claude Code's config folder", for the lead fence, the guards installer and the worker context reader.
import { isAbsolute, join } from 'node:path'

const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p)

/** Claude Code's config folder: `CLAUDE_CONFIG_DIR` when set, else `<home>/.claude`. A value that is not an absolute path (`~/x` included) is an error. The caller reads the variable once. */
export function claudeConfigDir(home: string, configured?: string): string {
  if (!configured) return join(trim(home), '.claude')
  if (!isAbsolute(configured))
    throw new Error(`CLAUDE_CONFIG_DIR must be an absolute path (it is "${configured}"); fix it or unset it`)
  return trim(configured)
}
