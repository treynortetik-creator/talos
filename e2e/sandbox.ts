// `pnpm sandbox …`: a throwaway Talos beside the owner's own, and a driver that plays the owner's phone against it.
//   pnpm sandbox up [--fake-claude | --real-claude [--auto-dev-channels]] [--model haiku] [--no-build] [--keep-on-fail]
//   pnpm sandbox status <id>
//   pnpm sandbox list
//   pnpm sandbox drive <id> <action> [--name value …] [--json '{…}'] [--stdin]
//   pnpm sandbox drive help
//   pnpm sandbox down <id> | --all
// Every command prints one JSON object on stdout and exits 0 when it worked, 1 when it did not (`ok: false` or `error`), 2 for
// a command line it could not read. Progress lines go to stderr. docs/SANDBOX.md is the guide.
import { readFileSync } from 'node:fs'
import { ACTIONS, drive, type Params } from './sandbox/drive.ts'
import { cleanEnv, listIds, SandboxError } from './sandbox/state.ts'
import { down, status, up } from './sandbox/up.ts'

// Nothing a sandbox starts may inherit the identity of the session or the Talos install this command was typed in.
const keep = cleanEnv()
for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]

const USAGE = `usage:
  sandbox up [--fake-claude | --real-claude [--auto-dev-channels]] [--model <name>] [--no-build] [--keep-on-fail]
  sandbox status <id>
  sandbox list
  sandbox drive <id> <action> [--name value …] [--json '{…}'] [--stdin]
  sandbox drive help
  sandbox down <id> | --all`

class UsageError extends Error {}

const print = (o: unknown) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`)
const note = (line: string) => process.stderr.write(`sandbox: ${line}\n`)

/** `--name value`, `--name=value` and bare `--name` (true); `--json` and `--stdin` carry a whole object. */
function readParams(args: string[]): Params {
  let out: Params = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (!a.startsWith('--') || a === '--')
      throw new UsageError(`unexpected word ${JSON.stringify(a)} (options look like --name value)`)
    const eq = a.indexOf('=')
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2)
    const next = args[i + 1]
    let value: unknown
    if (eq > 0) value = a.slice(eq + 1)
    else if (next !== undefined && !next.startsWith('--')) {
      value = next
      i++
    } else value = true
    if (name === 'json' || name === 'stdin') {
      const text = name === 'stdin' ? readFileSync(0, 'utf8') : String(value)
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch (e) {
        throw new UsageError(`--${name} is not JSON: ${(e as Error).message}`)
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new UsageError(`--${name} must be a JSON object`)
      out = { ...out, ...(parsed as Params) }
    } else out[name] = value
  }
  return out
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv
  if (cmd === undefined || cmd === 'help' || cmd === '--help') {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (cmd === 'up') {
    const p = readParams(rest)
    const known = ['fake-claude', 'real-claude', 'auto-dev-channels', 'model', 'no-build', 'keep-on-fail']
    const stray = Object.keys(p).filter((k) => !known.includes(k))
    if (stray.length) throw new UsageError(`up does not take --${stray[0]}`)
    if (p['fake-claude'] && p['real-claude']) throw new UsageError('pick one of --fake-claude and --real-claude')
    // only a real claude shows the warning; asking for it on the fake would hide a test that meant to see it unanswered
    if (p['auto-dev-channels'] && !p['real-claude']) throw new UsageError('--auto-dev-channels goes with --real-claude')
    const model = typeof p.model === 'string' ? p.model : 'haiku'
    if (!/^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,79}$/.test(model)) throw new UsageError('--model is not a model name')
    print(
      await up(
        {
          mode: p['real-claude'] ? 'real' : 'fake',
          model,
          build: !p['no-build'],
          keepOnFail: Boolean(p['keep-on-fail']),
          autoDevChannels: Boolean(p['auto-dev-channels']),
        },
        note,
      ),
    )
    return 0
  }
  if (cmd === 'list') {
    if (rest.length) throw new UsageError('list takes nothing else')
    const out: unknown[] = []
    for (const id of listIds()) out.push(await status(id).catch((e) => ({ id, error: (e as Error).message })))
    print({ sandboxes: out })
    return 0
  }
  if (cmd === 'status') {
    if (rest.length !== 1) throw new UsageError('status takes one sandbox id')
    print(await status(rest[0] as string))
    return 0
  }
  if (cmd === 'down') {
    if (rest.length !== 1) throw new UsageError('down takes one sandbox id, or --all')
    const ids = rest[0] === '--all' ? listIds() : [rest[0] as string]
    const results: Array<Record<string, unknown>> = []
    for (const id of ids) results.push(await down(id))
    print(rest[0] === '--all' ? { down: results } : results[0])
    return results.every((r) => r.removed === true && (r.leftovers as unknown[]).length === 0) ? 0 : 1
  }
  if (cmd === 'drive') {
    if (rest[0] === 'help' || rest[0] === undefined) {
      print({
        actions: Object.fromEntries(Object.entries(ACTIONS).map(([k, a]) => [k, { about: a.about, args: a.args }])),
      })
      return rest[0] === 'help' ? 0 : 2
    }
    const [id, action, ...more] = rest
    if (action === undefined) throw new UsageError('drive takes a sandbox id and an action (drive help lists them)')
    const result = await drive(id as string, action, readParams(more))
    print(result)
    return result.ok === false ? 1 : 0
  }
  throw new UsageError(`unknown command ${JSON.stringify(cmd)}`)
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (e) {
  if (e instanceof UsageError) {
    process.stderr.write(`sandbox: ${e.message}\n${USAGE}\n`)
    process.exitCode = 2
  } else {
    const code = e instanceof SandboxError ? e.code : 'internal'
    print({ ok: false, error: { code, message: (e as Error).message } })
    process.exitCode = code === 'bad_args' || code === 'bad_id' ? 2 : 1
  }
}
// an open handle (a pty helper, a socket being closed) must not keep a finished command alive
setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref()
