// The lead's roots (docs/OPTION-C.md "Leads"). A lead lives outside the main agent folder and needs nothing in it, so the
// fence does not list files: it names WHOLE ROOTS (the main agent folder, the whole Claude config folder with its
// transcripts, history, settings and hooks, Claude Code's global config files, the Talos home, the kit's default vault and
// credential folders such as ~/.ssh and any root the owner adds). settings.ts turns them into deny
// rules, and Claude Code's OS sandbox (Seatbelt) turns those into kernel-enforced limits on every command the lead runs.
// Nothing here reads a command line: the OS decides what a process can open.
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { real } from '../guards/rules.ts'

const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p)
const uniq = (l: readonly string[]) => [...new Set(l)]

/** Credential folders and files, under the owner's home, that every lead protects: a lead has no use for them, and open network could carry a key out. */
export const LEAD_SECRET_PATHS = ['.ssh', '.config/gh', '.aws', '.npmrc', '.netrc'] as const

/** Claude Code's config folder: `CLAUDE_CONFIG_DIR` when set, else `<home>/.claude`. A value that is not an absolute path (`~/x` included) is an error. The caller reads the variable once. */
export function claudeConfigDir(home: string, configured?: string): string {
  if (!configured) return join(trim(home), '.claude')
  if (!isAbsolute(configured))
    throw new Error(`CLAUDE_CONFIG_DIR must be an absolute path (it is "${configured}"); fix it or unset it`)
  return trim(configured)
}

/** Claude Code's global config file(s): `<claudeDir>/.claude.json`, and `~/.claude.json` too when the folder is the default one. */
function claudeJsonFiles(home: string, claudeDir: string): string[] {
  const h = trim(home)
  const c = trim(claudeDir)
  return c === join(h, '.claude') ? [join(h, '.claude.json'), join(c, '.claude.json')] : [join(c, '.claude.json')]
}

/**
 * The roots every lead protects, plus whatever the owner added with `--protect`. Files and folders alike. The whole Claude
 * config folder is one root (transcripts, history, settings, hooks, skills, agents, commands, CLAUDE.md); `~/.claude` and
 * the global config file and its backup stay roots even when CLAUDE_CONFIG_DIR points elsewhere.
 */
export function defaultLeadRoots(o: {
  agentDir: string
  talosHome: string
  home: string
  claudeDir: string
  protect?: readonly string[]
}): string[] {
  const home = trim(o.home)
  return uniq([
    trim(o.agentDir),
    trim(o.claudeDir),
    join(home, '.claude'),
    join(home, '.claude.json'),
    join(home, '.claude.json.backup'),
    trim(o.talosHome),
    join(home, 'private-agent-vault'),
    ...LEAD_SECRET_PATHS.map((p) => join(home, p)),
    ...(o.protect ?? []).map(trim),
  ])
}

// ---- what the owner already switched off for the main agent -------------------------------------------------------------

/** `disabledMcpServers` of the owner's main project in Claude Code's global config, and the user-scope server names there. */
export function readOwnerMcp(
  home: string,
  agentDir: string,
  claudeDir: string,
): { disabled: string[]; userScope: string[] } {
  const disabled: string[] = []
  const userScope: string[] = []
  for (const file of claudeJsonFiles(home, claudeDir)) {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as {
        mcpServers?: Record<string, unknown>
        projects?: Record<string, { disabledMcpServers?: unknown }>
      }
      if (j.mcpServers && typeof j.mcpServers === 'object') userScope.push(...Object.keys(j.mcpServers))
      for (const key of uniq([agentDir, real(agentDir)])) {
        const d = j.projects?.[key]?.disabledMcpServers
        if (Array.isArray(d)) disabled.push(...d.filter((x): x is string => typeof x === 'string'))
      }
    } catch {
      // no file, or not JSON: nothing to copy
    }
  }
  return { disabled: uniq(disabled), userScope: uniq(userScope) }
}
