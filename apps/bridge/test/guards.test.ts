import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInstallGuards, withGuardsSettings } from '../src/guards/install.ts'
import { buildGuardConfig, denyRules, guardDecision } from '../src/guards/rules.ts'

const root = mkdtempSync('/tmp/gd')
afterAll(() => rmSync(root, { recursive: true, force: true }))

const userHome = join(root, 'user')
const home = join(userHome, '.config', 'talos')
const checkout = join(root, 'checkout')
const claudeHome = join(root, 'claude')
mkdirSync(join(checkout, 'docs'), { recursive: true })
writeFileSync(join(checkout, 'docs', 'protected-paths.txt'), 'apps/bridge/src/keys.ts\napps/relay/src/auth\n')
const cfg = buildGuardConfig({ home, checkout, claudeHome, userHome })
const install = { home, checkout, claudeHome, userHome }

const bash = (command: string) => guardDecision({ tool_name: 'Bash', tool_input: { command } }, cfg)
const write = (file_path: string, tool_name = 'Write') => guardDecision({ tool_name, tool_input: { file_path } }, cfg)

describe('guard decisions', () => {
  test('denies a Write to enroll-pending/x.answer.json', () => {
    const d = write(join(home, 'enroll-pending', 'x.answer.json'))
    expect(d?.deny).toContain('enroll-pending')
  })
  test('denies an Edit of a protected path, a directory entry, and the running checkout', () => {
    expect(write(join(checkout, 'apps/bridge/src/keys.ts'), 'Edit')).toBeDefined()
    expect(write(join(checkout, 'apps/relay/src/auth/session.ts'), 'MultiEdit')).toBeDefined()
    expect(write(join(checkout, 'apps/bridge/src/anything-else.ts'))).toBeDefined()
  })
  test('denies a path that reaches a protected file through ..', () => {
    expect(write(join(home, 'media', '..', 'enroll-pending', 'a.json'))).toBeDefined()
  })
  test('denies writes under the plugin and mod folders and the guard files themselves', () => {
    expect(write(join(claudeHome, 'plugins', 'x', 'hook.sh'))).toBeDefined()
    expect(write(join(claudeHome, 'dev-mods', 'm.js'))).toBeDefined()
    expect(write(join(home, 'guards', 'guards.json'))).toBeDefined()
  })
  test('denies writes to the recovery request file and the saved-setup folders in the Talos home', () => {
    expect(write(join(home, 'agent-request.json'))?.deny).toContain('agent-request.json')
    expect(write(join(home, 'last-good', '2026-11-03', 'CLAUDE.md'), 'Edit')).toBeDefined()
    expect(write(join(home, 'config-history', 'x.json'), 'MultiEdit')).toBeDefined()
    expect(bash(`echo '{}' > ${home}/agent-request.json`)).toBeDefined()
    expect(bash(`cd ${home} && printf x > agent-request.json`)).toBeDefined()
    expect(bash(`rm -rf ${home}/last-good`)).toBeDefined()
    expect(bash(`cp /x ${home}/config-history/a.json`)).toBeDefined()
    // reading the saved setups is still fine
    expect(bash(`ls ${home}/last-good ${home}/config-history`)).toBeUndefined()
    const rules = denyRules(cfg)
    for (const n of ['agent-request.json', 'last-good', 'config-history'])
      expect(rules.some((r) => r.startsWith('Edit(/') && r.endsWith(`/${n})`))).toBe(true)
    expect(rules).toContain('Bash(*agent-request.json*)')
  })
  test('allows an ordinary file', () => {
    expect(write(join(root, 'agent', 'notes.md'))).toBeUndefined()
    expect(bash('ls -la && git status')).toBeUndefined()
  })
  test('denies script -q /dev/null talos-app enroll (a faked terminal)', () => {
    expect(bash('script -q /dev/null talos-app enroll')?.deny).toContain('terminal')
  })
  test('denies the other pty fakers and a plain call of a human-only command', () => {
    expect(bash("python3 -c \"import pty; pty.spawn(['talos-app','devices','revoke','x'])\"")).toBeDefined()
    expect(bash('unbuffer talos-app rotate')).toBeDefined()
    expect(bash('talos-app enroll --confirm')).toBeDefined()
    expect(bash('cd /x && bun run src/cli.ts install-ask-rules --agent-dir .')).toBeDefined()
    expect(bash('cd /x && bun run cli install-ask-rules --agent-dir .')).toBeDefined()
  })
  test('denies claude plugin and the plugin and mod folders from a shell', () => {
    expect(bash('claude plugin install x')?.deny).toContain('claude plugin')
    expect(bash('cp x ~/.claude/plugins/y')).toBeDefined()
    expect(bash('echo hi > ~/.claude/dev-mods/m.js')).toBeDefined()
  })
  test('denies action-rules.py approve and anything in enroll-pending', () => {
    expect(bash('python3 action-rules.py approve 12')).toBeDefined()
    expect(bash(`echo '{"yes":true}' > ${home}/enroll-pending/a.answer.json`)).toBeDefined()
  })
  test('denies a shell write whichever way the path is spelled (/tmp is /private/tmp on a Mac)', () => {
    const real = realpathSync(checkout)
    expect(bash(`sed -i '' s/a/b/ ${real}/apps/bridge/src/keys.ts`)).toBeDefined()
    expect(bash(`sed -i '' s/a/b/ ${checkout}/apps/bridge/src/keys.ts`)).toBeDefined()
    expect(bash(`sed -i '' s/a/b/ ${checkout}/apps/../apps/bridge/src/keys.ts`)).toBeDefined()
    expect(bash(`cd ${checkout} && rm -rf apps`)).toBeDefined()
  })
  test('the tilde, $HOME and braces-HOME spellings are written out before the paths are compared', () => {
    const rel = '.config/talos'
    const c2 = buildGuardConfig({ home, checkout, claudeHome: join(userHome, '.claude'), userHome })
    const run = (command: string) => guardDecision({ tool_name: 'Bash', tool_input: { command } }, c2)
    expect(run(`echo x > ~/${rel}/tripwire.json`)).toBeDefined()
    expect(run(`echo x > $HOME/${rel}/devices.json`)).toBeDefined()
    expect(run(`echo x > \${HOME}/${rel}/config.json`)).toBeDefined()
    expect(run('cp x ~/.claude/plugins/p')).toBeDefined()
  })
  test('a cd plus a relative path elsewhere is still a bypass (known limit, see SECURITY.md)', () => {
    expect(bash('cd src && rm -rf apps')).toBeUndefined()
  })
  test('denies a shell write to a protected file but not a read', () => {
    expect(bash(`sed -i s/a/b/ ${checkout}/apps/bridge/src/keys.ts`)).toBeDefined()
    expect(bash(`cat ${checkout}/apps/bridge/src/keys.ts`)).toBeUndefined()
  })
  test('denies any command that names the guard files, whichever way it is spelled', () => {
    for (const c of [
      `rm -rf ${home}/guards`,
      `cat ${home}/guards/settings.json`,
      `echo {} > ${home}/guards.json`,
      `cat ${home}/tripwire.json`,
      `rm ${home}/tripwire.writing`,
      `rm ${home}/enroll-pending/*`,
      `rm ${home}/enroll-pend*`,
      `rm ${home}/en*`,
      `rm ${home}/enroll-pen[d]ing/x`,
      `rm ${home}/GUARDS.json`,
      `rm ${home}/media/../guards.json`,
      'rm ~/.config/talos/guards.json',
      `cd ${home} && rm guards.json`,
      `cd ${home} && rm -f enroll-pend*`,
      `cd ${home} && echo x > devices.json`,
      `rm ${home}/*`,
    ])
      expect(bash(c), c).toBeDefined()
  })
  test('a wildcard deny names every kind of protected file, agent-request.json included', () => {
    for (const c of [`rm ${home}/agent-req*`, `cd ${home} && rm agent-req*`])
      expect(bash(c)?.deny, c).toContain('agent-request')
  })
  test('devices.json and config.json may be read but not written from a shell', () => {
    expect(bash(`cat ${home}/devices.json`)).toBeUndefined()
    expect(bash(`cat ${home}/config.json | head`)).toBeUndefined()
    expect(bash(`cat ~/.config/talos/devices.json`)).toBeUndefined()
    for (const c of [
      `echo '{}' > ${home}/devices.json`,
      `tee ${home}/config.json`,
      `sed -i '' s/a/b/ ${home}/config.json`,
      `python3 -c "open('${home}/devices.json','w')"`,
      `cp x ${home}/devices.json`,
    ])
      expect(bash(c), c).toBeDefined()
  })
  test('the Write tools are denied on the trust files too', () => {
    for (const f of ['devices.json', 'config.json', 'tripwire.writing', 'tripwire.json', 'guards/guards.json'])
      expect(write(join(home, f), 'Edit'), f).toBeDefined()
    expect(write(join(home, 'media', 'x.png'))).toBeUndefined()
  })
  test('last-good, where restore-last-good reads its saved versions, is on the never-change list', () => {
    expect(cfg.writeDenied).toContain(join(realpathSync(root), 'user', '.config', 'talos', 'last-good'))
    expect(write(join(home, 'last-good', '20261102T170000000Z', '.mcp.json'))).toBeDefined()
    expect(write(join(home, 'last-good', '20261102T170000000Z', 'meta.json'), 'Edit')).toBeDefined()
    expect(denyRules(cfg).some((r) => r.startsWith('Edit(') && r.includes('/last-good'))).toBe(true)
    for (const c of [
      `cp x ${home}/last-good/20261102T170000000Z/.mcp.json`,
      `echo '{}' > ~/.config/talos/last-good/v/.mcp.json`,
      `cd ${home}/last-good && cp /tmp/x .`,
      `mkdir ${home}/last-good/20261102T170000001Z && echo hi > ${home}/last-good/20261102T170000001Z/meta.json`,
    ])
      expect(bash(c), c).toBeDefined()
    // reading the saved versions, and listing them through the command, stay allowed
    expect(bash(`ls ${home}/last-good`)).toBeUndefined()
    expect(bash('talos-app restore-last-good --list')).toBeUndefined()
  })
  test('only a real invocation of a human-only command is gated, not a path or a message', () => {
    expect(bash(`cat ${home}/devices.json`)).toBeUndefined()
    expect(bash('git commit -m "talos: devices fix"')).toBeUndefined()
    expect(bash('git commit -m "run talos-app enroll; then talos-app devices"')).toBeUndefined()
    expect(bash(`bun test ${checkout}/apps/bridge/test/enroll.test.ts`)).toBeUndefined()
    expect(bash('bun test apps/bridge/test/enroll.test.ts')).toBeUndefined()
    expect(bash('grep -rn "talos-app rotate" docs')).toBeUndefined()
    expect(bash('echo talos-app enroll')).toBeUndefined()
    expect(bash('talos-app status && talos-app logs')).toBeUndefined()
  })
  test('a real invocation is gated at any command position', () => {
    for (const c of [
      'talos-app enroll',
      'cd x && talos-app devices revoke d_1',
      'ls; talos-app rotate',
      'ls | talos-app enroll',
      'FOO=1 talos-app enroll',
      'sudo /usr/local/bin/talos-app devices',
      'bash -c "talos-app enroll"',
      "sh -c 'cd x; talos-app rotate'",
      'echo $(talos-app devices)',
      'echo `talos-app devices`',
      'talos trust on',
      'talos-app trust on',
      'talos-app theme reset',
      'talos theme reset',
      'cd x && talos-app theme reset',
      'bun src/cli.ts theme reset',
      'cd apps/bridge && bun run src/cli.ts enroll --label x',
      'bun src/cli.ts memory init --agent-dir .',
      '"talos-app" enroll',
      't""alos-app enroll',
    ])
      expect(bash(c)?.deny, c).toContain('human-only')
    expect(bash('talos-app trust off')).toBeUndefined()
    expect(bash('talos-app trust show')).toBeUndefined()
    expect(bash('talos-app theme show')).toBeUndefined()
  })
  test('an unreadable input is denied', () => {
    expect(guardDecision({ tool_name: 'Write', tool_input: {} }, cfg)).toBeDefined()
  })
})

describe('install-guards', () => {
  const io = () => {
    const out: string[] = []
    return { out, io: { out: (l: string) => out.push(l), err: (l: string) => out.push(l) } }
  }
  const file = join(home, 'guards', 'settings.json')

  test('writes settings with the hook and deny rules outside the agent folder, idempotently', () => {
    const a = io()
    expect(runInstallGuards(install, [], a.io)).toBe(0)
    const first = readFileSync(file, 'utf8')
    const s = JSON.parse(first)
    expect(s.hooks.PreToolUse[0].hooks[0].command).toContain('guard-hook')
    expect(s.permissions.deny).toEqual(denyRules(cfg))
    expect(s.permissions.deny.some((r: string) => r.includes('claude plugin'))).toBe(true)
    expect(a.out.join('\n')).toContain('--settings')
    expect(a.out.join('\n')).toContain('Re-run talos-app install-guards after upgrading bun')
    expect(runInstallGuards(install, [], io().io)).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(first)
  })

  test('--remove undoes it', () => {
    expect(runInstallGuards(install, ['--remove'], io().io)).toBe(0)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(join(home, 'guards', 'guards.json'))).toBe(false)
    expect(runInstallGuards(install, ['--remove'], io().io)).toBe(0)
  })
})

const hookCommand = () =>
  JSON.parse(readFileSync(join(home, 'guards', 'settings.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command as string
const sha = () => /--sha ([0-9a-f]{64})/.exec(hookCommand())?.[1] as string

describe('guard-hook process', () => {
  test('answers a PreToolUse call with a deny, and fails closed on garbage', async () => {
    runInstallGuards(install, [], { out: () => {}, err: () => {} })
    const run = async (stdin: string) => {
      const p = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, '..', 'src', 'cli.ts'),
          'guard-hook',
          '--config',
          join(home, 'guards', 'guards.json'),
          '--sha',
          sha(),
        ],
        { stdin: new Response(stdin), stdout: 'pipe', stderr: 'pipe' },
      )
      return { out: await new Response(p.stdout).text(), code: await p.exited }
    }
    const denied = await run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'claude plugin install x' } }))
    expect(JSON.parse(denied.out).hookSpecificOutput.permissionDecision).toBe('deny')
    const ok = await run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }))
    expect(ok.code).toBe(0)
    expect(ok.out.trim()).toBe('')
    const bad = await run('not json')
    expect(JSON.parse(bad.out).hookSpecificOutput.permissionDecision).toBe('deny')
  })

  test('editing, emptying or removing the hash from guards.json fails closed, it never loosens', async () => {
    runInstallGuards(install, [], { out: () => {}, err: () => {} })
    const rules = join(home, 'guards', 'guards.json')
    const original = readFileSync(rules, 'utf8')
    const ask = async (extra: string[]) => {
      const p = Bun.spawn(
        [process.execPath, join(import.meta.dir, '..', 'src', 'cli.ts'), 'guard-hook', '--config', rules, ...extra],
        { stdin: new Response(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })), stdout: 'pipe' },
      )
      const out = await new Response(p.stdout).text()
      await p.exited
      return out.trim() ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'allow'
    }
    expect(await ask(['--sha', sha()])).toBe('allow') // untouched: an ordinary command passes
    writeFileSync(rules, '{}')
    expect(await ask(['--sha', sha()])).toBe('deny')
    writeFileSync(rules, JSON.stringify({ ...JSON.parse(original), writeDenied: [], protectedPaths: [] }))
    expect(await ask(['--sha', sha()])).toBe('deny')
    writeFileSync(rules, original)
    expect(await ask([])).toBe('deny') // no hash given
    expect(await ask(['--sha', '0'.repeat(64)])).toBe('deny')
    expect(await ask(['--sha', sha()])).toBe('allow')
  })
})

describe('the guards reach every start', () => {
  test('withGuardsSettings adds the settings file when installed, and nothing when not', () => {
    runInstallGuards(install, ['--remove'], { out: () => {}, err: () => {} })
    expect(withGuardsSettings(['--x'], home)).toEqual({ flags: ['--x'] })
    runInstallGuards(install, [], { out: () => {}, err: () => {} })
    expect(withGuardsSettings(['--x'], home)).toEqual({
      flags: ['--x', '--settings', join(home, 'guards', 'settings.json')],
    })
  })
  test("the owner's own --settings is kept and the owner is warned that the guards are off", () => {
    const r = withGuardsSettings(['--settings', '/x.json'], home)
    expect(r.flags).toEqual(['--settings', '/x.json'])
    expect(r.warning).toContain('NOT active')
    expect(withGuardsSettings(['--settings=/x.json'], home).warning).toContain('NOT active')
  })
  test('--remove tells the owner to restart now', () => {
    const out: string[] = []
    runInstallGuards(install, ['--remove'], { out: (l) => out.push(l), err: () => {} })
    expect(out.join(' ')).toContain('Restart the agent now')
    expect(out.join(' ')).toContain('every tool call')
  })
})
