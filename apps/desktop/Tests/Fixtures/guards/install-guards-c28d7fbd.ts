// The guard files as `talos-app install-guards` wrote them before the refresh existed (apps/bridge/src/guards/install.ts at
// c28d7fbd): the same writer lines, run by the bun that runs this file (process.execPath, as that writer pinned it). The rules come
// from the checkout named here. Used by MainGuardsRefreshTests to stand for an install already on a Mac.
//   bun install-guards-c28d7fbd.ts <rules checkout> <talos home> <checkout to pin> <claude home> <user home>
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const [code, home, checkout, claudeHome, userHome] = process.argv.slice(2) as [string, string, string, string, string]
const { buildGuardConfig, denyRules, WRITE_TOOLS } = await import(join(code, 'apps/bridge/src/guards/rules.ts'))
const { ensureDir, writeJsonAtomic } = await import(join(code, 'apps/bridge/src/fsutil.ts'))

const dir = join(home, 'guards')
const settings = join(dir, 'settings.json')
const rulesFile = join(dir, 'guards.json')
const cfg = buildGuardConfig({ home, checkout, claudeHome, userHome })
ensureDir(dir)
writeJsonAtomic(rulesFile, cfg, 0o600)
const sha = createHash('sha256').update(readFileSync(rulesFile)).digest('hex')
const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(cfg.checkout, 'apps', 'bridge', 'src', 'cli.ts'))} guard-hook --config ${JSON.stringify(rulesFile)} --sha ${sha}`
writeJsonAtomic(
  settings,
  {
    permissions: { deny: denyRules(cfg) },
    hooks: { PreToolUse: [{ matcher: ['Bash', ...WRITE_TOOLS].join('|'), hooks: [{ type: 'command', command }] }] },
  },
  0o600,
)
