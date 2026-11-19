import { afterAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { runInstallGuards, withGuardsSettings } from '../src/guards/install.ts'
import { buildGuardConfig, denyRules, guardDecision } from '../src/guards/rules.ts'
import { DEFAULT_ASK_RULES } from '../src/permission/ask-rules.ts'
import { fenceDenyRules } from '../src/supervisor/worker-policy.ts'

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

/**
 * Ordinary developer commands that MUST stay allowed (Fable R2 on the supervisor-file entries: a guard that breaks legitimate
 * use is the failure this corpus keeps out). Run against the parent commit's rules too: zero new denials.
 */
export const ORDINARY = (u: string, co: string): string[] => [
  'cd /tmp && tar xf a.tar',
  'cd /tmp && unzip a.zip',
  'cd build && find . -name "*.o" -delete',
  `cd ${u}/proj && npm ci && find . -name '*.map' -delete`,
  'tar xf talos/a.tar',
  'tar czf /tmp/out.tgz src',
  'unzip -o dist.zip -d out',
  "find . -name node_modules -prune -o -name '*.log' -delete",
  'git checkout -- src/app.ts',
  'git --work-tree=/tmp/export checkout HEAD -- .',
  `cd ${u}/Talos/talos-app && git pull --ff-only`,
  `cd ${u}/Talos/talos-app && bun test apps/bridge/test/x.test.ts`,
  'pnpm install',
  'bun install',
  'npm run build',
  'echo x > supervisor.json',
  'touch launch',
  'rm -rf launch',
  'node launch',
  'python3 manage.py launch',
  'cp config/supervisor.json /tmp/x',
  'mkdir -p build/launch',
  "sed -i 's/a/b/' src/launch.ts",
  'grep -rn supervisor-control apps/bridge/src',
  'rg supervisor-stopped docs',
  'git grep -n restart-proof-mark.json',
  'git log -S supervisor-control --oneline',
  'journalctl --user -u talos-supervisor | grep supervisor-stopped',
  'mv build dist',
  'rm -rf node_modules',
  'rsync -a src/ /tmp/backup/',
  `ls ${u}/.config`,
  `cat ${u}/.config/talos/supervisor.json`,
  `jq . ${u}/.config/talos/supervisor.json > /tmp/out.json`,
  'cd /tmp && python3 -m http.server 8000',
  'cd .. && ls',
  'docker build -t x .',
  'make -C build',
  'ssh host ls',
  'tmux ls',
  'screen -ls',
  "find /tmp -name '*.tmp' -delete",
  `unzip ${u}/Downloads/x.zip -d ${u}/proj`,
  `cd ${co} && git status`,
  // a cd the guard cannot resolve (a variable, `-`, a subshell, `..` from an unknown folder) is not taken to reach the home
  'cd "$TMP" && rm -rf *',
  'cd .. && rm *',
  'cd $D && chmod +x *',
  `cd "$ROOT" && python3 -c "print('ready')"`,
  'cd "$X" && tar xf a.tar',
  'cd - && find . -delete',
  'cd "$WT" && pnpm install',
  'cd "$REPO" && git checkout -- .',
  'cd ../.. && cp -r dist/* out/',
  'cd "$(git rev-parse --show-toplevel)" && rm -rf node_modules',
  'cd $HOME/Documents/talos-app-wt/x && bun test',
  'cd "$TMPDIR" && echo hi > notes.txt',
  'cd .. && mv build/* release/',
  'cd "$d" && touch .keep',
  'cd "$OUT" && unzip -o a.zip',
  'cd "$BUILD" && make install',
  "cd - && sed -i '' s/a/b/ config.json",
  'cd "$W" && ln -sf ../shared lib',
]

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
  test("the bridge's key files are never read or touched by a command or a file tool", () => {
    for (const f of ['bridge.key', 'bridge.key.next', 'bridge.key.prev']) {
      expect(bash(`cat ${home}/${f}`), f).toBeDefined()
      expect(write(join(home, f)), f).toBeDefined()
      expect(guardDecision({ tool_name: 'Read', tool_input: { file_path: join(home, f) } }, cfg), f).toBeDefined()
    }
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
  test("denies the Mac app's restart check file to a write, a move, a delete and any command that names it", () => {
    const f = join(home, 'main-restart-check.json')
    for (const tool_name of ['Write', 'Edit', 'MultiEdit'])
      expect(write(f, tool_name)?.deny, tool_name).toContain('main-restart-check.json')
    expect(write(join(home, 'media', '..', 'main-restart-check.json'))).toBeDefined()
    for (const c of [
      `echo '{}' > ${f}`,
      `cd ${home} && printf x > main-restart-check.json`,
      `mv /tmp/forged.json ${f}`,
      `cp /tmp/forged.json ${f}`,
      `ln -sf /tmp/forged.json ${f}`,
      `rm ${f}`,
      `cd ${home} && rm main-restart-check.json`,
      `touch ${f}`,
      `cat ${f}`,
      `python3 -c "open('${f}','w')"`,
      'echo x > ~/.config/talos/main-restart-check.json',
      `rm ${home}/MAIN-RESTART-CHECK.json`,
    ])
      expect(bash(c), c).toBeDefined()
    const rules = denyRules(cfg)
    expect(rules.some((r) => r.startsWith('Edit(/') && r.endsWith('/main-restart-check.json)'))).toBe(true)
    expect(rules).toContain('Bash(*main-restart-check.json*)')
  })
  describe("the Linux supervisor's own files: a session runs as the same user, so the guard is what stands in the way", () => {
    // the control file the supervise loop acts on ("start" undoes the owner's Stop and starts Main past every restart check),
    // the owner's Stop, and the owner's restart proofs already used: never named by any command, never written by a tool
    const NEVER = ['supervisor-control', 'supervisor-stopped', 'restart-proofs-used.json', 'restart-proof-mark.json']
    test.each(NEVER)(
      '%s: every file tool, every shell way to write or remove it, and any command that names it',
      (n) => {
        const f = join(home, n)
        for (const tool_name of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
          expect(write(f, tool_name), tool_name).toBeDefined()
        expect(write(join(home, 'media', '..', n))).toBeDefined()
        expect(write(`${home}//${n}`)).toBeDefined()
        expect(write(`~/.config/talos/${n}`)).toBeDefined()
        for (const c of [
          `echo start > ${f}`,
          `printf start >> ${f}`,
          `cd ${home} && echo start > ${n}`,
          `echo start | tee ${f}`,
          `mv /tmp/x ${f}`,
          `cp /tmp/x ${f}`,
          `rm ${f}`,
          `rm -f ${home}/./${n}`,
          `rm ${home}//${n}`,
          `rm ${home}/media/../${n}`,
          `ln -s ${f} /tmp/link`,
          `touch ${f}`,
          `cat ${f}`,
          `python3 -c "open('${f}','w').write('start')"`,
          `echo start > ~/.config/talos/${n}`,
          `rm ${home}/${n.slice(0, 12)}*`,
        ])
          expect(bash(c), c).toBeDefined()
        const rules = denyRules(cfg)
        expect(rules).toContain(`Edit(/${join(cfg.home, n)})`)
        expect(rules).toContain(`Bash(*${n}*)`)
      },
    )
    test("`talos-app supervise start` and `stop` are open to a session since 2026-11-14 (Pantheon); the owner's own Stop is the CLI's to keep (supervisor/cli.test.ts)", () => {
      for (const c of [
        'talos-app supervise start --anyway',
        'talos-app supervise stop',
        'sh -c "talos-app supervise stop"',
      ])
        expect(bash(c), c).toBeUndefined()
      expect(bash('talos-app supervise status')).toBeUndefined()
      const rules = denyRules(cfg)
      expect(rules).not.toContain('Bash(talos-app supervise start:*)')
      expect(rules).not.toContain('Bash(talos-app supervise stop:*)')
    })
    test('a name broken by quotes or a backslash is the same name to the shell, and to the guard (Fable R1-2)', () => {
      for (const c of [
        `echo start > ${home}/supervisor-""control`,
        `echo start > ${home}/supervisor\\-control`,
        `echo start > ${home}/super"visor-con"trol`,
        `cd ${home} && echo start > 'supervisor-c'ontrol`,
        `rm ${home}/supervisor-"stopped"`,
      ])
        expect(bash(c), c).toBeDefined()
    })
    test('the home by its other common spellings (Fable R1-3)', () => {
      for (const c of [
        'echo start > "$TALOS_APP_HOME/supervisor-control"',
        'echo start > ${TALOS_APP_HOME}/supervisor-control',
        'rm "$TALOS_APP_HOME"/supervisor-stopped',
        // the launch has no bare-name rule: only the variable's expansion finds these
        'echo {} > "$TALOS_APP_HOME/supervisor.json"',
        'echo x > ${TALOS_APP_HOME}/launch/main.sh',
        'echo {} > $HOME/.config/talos/supervisor.json',
        'cd ~/.config && echo {} > talos/supervisor.json',
        `tar -xf /tmp/x.tar -C ${home}`,
        `git --work-tree=${home} checkout -- .`,
        `find ${home} -name 'supervisor*' -delete`,
        `mv ${home} /tmp/elsewhere`,
        `mv ${join(userHome, '.config')} /tmp/elsewhere`,
        `rm -rf ${join(userHome, '.config')}`,
      ])
        expect(bash(c), c).toBeDefined()
    })
    test('a hard link made earlier to the control file: writing through it is refused', () => {
      mkdirSync(home, { recursive: true })
      writeFileSync(join(home, 'supervisor-control'), '')
      const link = join(root, 'hard-link')
      rmSync(link, { force: true })
      linkSync(join(home, 'supervisor-control'), link)
      expect(write(link)).toBeDefined()
      expect(bash(`echo start > ${link}`)).toBeDefined()
      expect(bash(`cat ${link}`)).toBeUndefined() // reading it says nothing to the supervisor
      rmSync(join(home, 'supervisor-control'))
      rmSync(link)
    })
    test('a bare name with no home in the command, after a cd by variable (Fable R1-5)', () => {
      for (const n of NEVER) {
        expect(bash(`cd "$TALOS_APP_HOME" && cat ${n}`), n).toBeDefined()
        expect(bash(`cd "$TALOS_APP_HOME" && echo start > ${n}`), n).toBeDefined()
      }
    })
    test('reading the launch to somewhere else, and the four names as search terms away from the home (Fable R1-7)', () => {
      for (const c of [
        `cat ${home}/supervisor.json | python3 -m json.tool`,
        `jq . ${home}/supervisor.json > /tmp/out.json`,
        `cp ${home}/supervisor.json /tmp/x`,
        `ls ${home}/launch`,
        'grep -rn supervisor-control apps/bridge/src',
        'git grep -n restart-proof-mark.json',
        'journalctl --user -u talos-supervisor | grep supervisor-stopped',
        "rg 'supervisor-control|restart-proofs-used.json' docs",
      ])
        expect(bash(c), c).toBeUndefined()
      // still refused: a search that touches the home, or writes
      for (const c of [
        `grep -r start ${home}/supervisor-control`,
        `grep supervisor-control /tmp/x > ${home}/supervisor-control`,
        'grep -l x supervisor-control > /tmp/y',
        `cd ${home} && grep x supervisor-stopped`,
        `python3 -c "open('${home}/supervisor.json','w')"`,
        `cp /tmp/x ${home}/supervisor.json`,
      ])
        expect(bash(c), c).toBeDefined()
    })
    test('ordinary developer commands stay allowed (the regression corpus, Fable R2-1 and R2-3)', () => {
      // a home laid out as on a real machine: under the user's home, not under /tmp (this file's own home is, which would make
      // /tmp a folder above it)
      const u = '/srv-talos-corpus/user'
      const real = buildGuardConfig({ home: `${u}/.config/talos`, checkout, claudeHome: `${u}/.claude`, userHome: u })
      for (const c of ORDINARY(u, checkout))
        expect(guardDecision({ tool_name: 'Bash', tool_input: { command: c } }, real)?.deny, c).toBeUndefined()
    })
    test('the corpus with a session cwd of the user home, `/`, ~/.config or a project: 0 denials, both layouts (Fable R1-1..R1-3 on fce1adcb)', () => {
      const u = '/srv-talos-corpus/user'
      const extra = [
        "find /tmp -name '*.tmp' -delete",
        'tar xzf /tmp/a.tgz -C /tmp/out',
        'curl -sL https://example.invalid/a.tgz | tar xz',
        'npm pack && tar tf *.tgz',
        'find . -name "*.ts" -exec grep -l foo {} +',
        'for f in *.tar; do tar xf "$f"; done',
        'grep -rn "supervisor-control" .',
        'mkdir -p /tmp/x && cd /tmp/x && tar xf /tmp/a.tar',
        'export FOO=1; cd /tmp; unzip -o a.zip',
        'if [ -d build ]; then cd build && tar xf ../a.tar; fi',
      ]
      for (const h of [`${u}/.config/talos`, `${u}/.config/talos/app`]) {
        const c2 = buildGuardConfig({ home: h, checkout, claudeHome: `${u}/.claude`, userHome: u })
        for (const cwd of [undefined, u, '/', `${u}/.config`, `${u}/proj`])
          for (const c of [...ORDINARY(u, checkout), ...extra])
            expect(
              guardDecision({ tool_name: 'Bash', tool_input: { command: c }, ...(cwd ? { cwd } : {}) }, c2)?.deny,
              `${c} (cwd ${cwd}, home ${h})`,
            ).toBeUndefined()
      }
    })
    test('cd alone goes to the user home, above the Talos home: bare launch names are refused there', () => {
      expect(bash('cd && echo {} > .config/talos/supervisor.json')).toBeDefined()
    })
    test('a cd the guard cannot resolve (a variable, a subshell, `-`) does not count as the home (Pantheon 2026-11-13)', () => {
      for (const c of [
        'cd "$SOMEWHERE" && echo {} > supervisor.json',
        'cd $(dirname x) && rm -rf launch',
        'cd - && touch launch/x',
      ])
        expect(bash(c), c).toBeUndefined()
    })
    describe('a cd into the home stays refused, and the call cwd resolves relative cds (both home layouts)', () => {
      const u = '/srv-talos-cwd/user'
      for (const h of [`${u}/.config/talos`, `${u}/.config/talos/app`]) {
        const c2 = buildGuardConfig({ home: h, checkout, claudeHome: `${u}/.claude`, userHome: u })
        const run = (command: string, cwd?: string) =>
          guardDecision({ tool_name: 'Bash', tool_input: { command }, ...(cwd ? { cwd } : {}) }, c2)?.deny
        test(`explicit cds into ${h}`, () => {
          for (const c of [
            `cd ${u}/.config/talos/app && tar xf a.tar`,
            'cd ~/.config/talos/app && tar xf a.tar',
            'cd "$HOME/.config/talos" && find . -delete',
            'cd $TALOS_APP_HOME && unzip x.zip',
            'cd "${TALOS_APP_HOME}" && git checkout -- .',
          ])
            expect(run(c), c).toContain('Talos home')
        })
        test(`the three regressed commands, with no cwd and with an ordinary cwd (${h})`, () => {
          for (const c of ['cd "$X" && tar xf a.tar', 'cd - && find . -delete', 'cd "$OUT" && unzip -o a.zip']) {
            expect(run(c), c).toBeUndefined()
            expect(run(c, `${u}/proj`), c).toBeUndefined()
          }
        })
        test(`a cwd inside the home: relative unpacks refused, a cd .. resolved against it (${h})`, () => {
          const inside = `${h}/workers/trip`
          expect(run('tar xf a.tar', inside)).toContain('inside the Talos home')
          expect(run('unzip -o a.zip', h)).toContain('inside the Talos home')
          // .. from inside the home is still the home, or the folder holding it
          expect(run('cd .. && find . -delete', inside)).toContain('inside the Talos home')
          expect(run('cd .. && find . -delete', h)).toContain('inside the Talos home')
          // `cd .. && rm *` gets the same answer as a cd to the folder it resolves to
          expect(run('cd .. && rm *', inside)).toEqual(run(`cd ${h}/workers && rm *`))
          expect(run('cd .. && rm launch', h)).toEqual(run(`cd ${dirname(h)} && rm launch`))
          // a bare launch name counts only where it resolves to the launch itself (Fable R1-1 on fce1adcb)
          expect(run('cd .. && rm launch', h)).toBeUndefined()
          expect(run('cd .. && rm -rf launch', `${h}/workers`)).toBeDefined()
          expect(run('echo {} > supervisor.json', h)).toBeDefined()
          expect(run('echo {} > supervisor.json', `${h}/workers/trip`)).toBeUndefined()
          expect(run('echo {} > .config/talos/supervisor.json', u)).toEqual(
            h.endsWith('/app') ? undefined : expect.stringContaining('supervisor.json'),
          )
          // a cd out of it to somewhere ordinary, then relative work: allowed
          expect(run('cd /tmp && tar xf a.tar', inside)).toBeUndefined()
          // only the folder the unpack runs in counts, not one an earlier command ran in (Fable R1-2 on fce1adcb)
          for (const c of [
            'mkdir -p /tmp/x && cd /tmp/x && tar xf a.tar',
            'export FOO=1; cd /tmp; unzip -o a.zip',
            `ls && cd ${u}/proj && find . -delete`,
          ])
            expect(run(c, inside), c).toBeUndefined()
          expect(run('ls && tar xf a.tar && cd /tmp', inside)).toContain('inside the Talos home')
          expect(run(`cd ${u}/proj && find . -delete`, h)).toBeUndefined()
          // a relative cd from an ordinary cwd that lands in the home is refused
          expect(run('cd ../.config/talos && tar xf a.tar', `${u}/proj`)).toContain('inside the Talos home')
          // an ordinary cwd: relative work is fine
          expect(run('cd .. && rm *', `${u}/proj/sub`)).toBeUndefined()
          expect(run('tar xf a.tar', `${u}/proj`)).toBeUndefined()
          // a bare launch name where the cwd is the home
          expect(run('rm -rf launch', h)).toBeDefined()
          expect(run('rm -rf launch', `${u}/proj`)).toBeUndefined()
        })
      }
    })
    test('a pseudo-terminal around a human-only talos-app command: tmux, screen, systemd-run, ssh -t, a pty module (Fable R2-2)', () => {
      for (const c of [
        "tmux new -d 'talos-app devices revoke d_1'",
        'screen -dm talos-app rotate',
        'systemd-run --user --pty talos-app enroll',
        "ssh -tt localhost 'talos-app trust on'",
        `python3 -c 'import os,pty; pty.spawn(["talos-app","devices"])'`,
      ])
        expect(bash(c)?.deny, c).toContain('fakes a terminal')
    })
    test('a symlink made earlier that points at the control file: writing through it is refused', () => {
      mkdirSync(home, { recursive: true })
      writeFileSync(join(home, 'supervisor-control'), '')
      const link = join(root, 'innocent-link')
      rmSync(link, { force: true })
      symlinkSync(join(home, 'supervisor-control'), link)
      expect(write(link)).toBeDefined()
      expect(bash(`echo start > ${link}`)).toBeDefined()
      rmSync(join(home, 'supervisor-control'))
      rmSync(link)
    })
    // the launch and the launch scripts: read, never written
    test.each(['supervisor.json', 'launch/main.sh'])('%s: read freely, never written', (n) => {
      const f = join(home, n)
      for (const tool_name of ['Write', 'Edit', 'MultiEdit']) expect(write(f, tool_name), tool_name).toBeDefined()
      expect(write(join(home, 'media', '..', n))).toBeDefined()
      for (const c of [`echo {} > ${f}`, `sed -i s/a/b/ ${f}`, `rm ${f}`, `mv /tmp/x ${f}`, `echo x | tee ${f}`])
        expect(bash(c), c).toBeDefined()
      expect(bash(`cat ${f}`)).toBeUndefined()
      expect(guardDecision({ tool_name: 'Read', tool_input: { file_path: f } }, cfg)).toBeUndefined()
    })
    test('supervisor.json written from inside the home by its bare name is refused (the home is named: no write there)', () => {
      expect(bash(`cd ${home} && echo {} > supervisor.json`)).toBeDefined()
      expect(bash(`cd ${home} && cat supervisor.json`)).toBeUndefined()
    })
    test('the hook covers the supervisor files even from guards installed before they were guarded (Fable R1-6)', () => {
      const old = {
        ...cfg,
        writeDenied: cfg.writeDenied.filter(
          (p) => !p.includes('supervisor') && !p.includes('restart-proof') && !p.endsWith('/launch'),
        ),
      }
      for (const n of [...NEVER, 'supervisor.json', 'launch/main.sh'])
        expect(guardDecision({ tool_name: 'Write', tool_input: { file_path: join(home, n) } }, old), n).toBeDefined()
    })
    test('what still works: the supervisor status the agent may read, its log, and the other files of the home', () => {
      expect(bash(`cat ${home}/supervisor-status.json`)).toBeUndefined()
      expect(bash(`tail -n 20 ${home}/supervisor.log`)).toBeUndefined()
      expect(bash('talos-app commands')).toBeUndefined()
      expect(write(join(home, 'media', 'note.txt'))).toBeUndefined()
    })
  })
  test('denies the needs-you files and the wake bookkeeping under workers/<thread>/ to a write and to any command that names them', () => {
    const rules = denyRules(cfg)
    for (const n of [
      'dialog-answer.json',
      'dialog-result.json',
      'dialog-card.json',
      'dialog-proofs-used.json',
      'main-dialog-answer.json',
      'main-dialog-proofs-used.json',
      'wake-state.json',
      'wake-written.json',
    ]) {
      expect(write(join(home, 'workers', 'trip', n))?.deny, n).toContain(n)
      expect(write(join(home, 'workers', 'trip', n), 'Edit'), n).toBeDefined()
      expect(bash(`echo '{}' > ${home}/workers/trip/${n}`), n).toBeDefined()
      expect(bash(`cd ${home}/workers/trip && printf x > ${n}`), n).toBeDefined()
      expect(bash(`cat ${home}/workers/trip/${n}`), n).toBeDefined()
      expect(rules, n).toContain(`Bash(*${n}*)`)
      expect(
        rules.some((r) => r.startsWith('Edit(/') && r.endsWith(`/workers/**/${n})`)),
        n,
      ).toBe(true)
    }
    expect(bash(`rm ${home}/workers/trip/dialog-*`)).toBeDefined()
    expect(bash(`cd ${home}/workers/trip && rm dialog-a*`)).toBeDefined()
    // the rest of a worker's folder is as it was
    expect(write(join(home, 'workers', 'trip', 'WORKER.md'))).toBeUndefined()
    expect(bash(`ls ${home}/workers/trip`)).toBeUndefined()
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
    expect(bash('cd /x && bun run src/cli.ts rotate')).toBeDefined()
    expect(bash('cd /x && bun run cli devices revoke d_1')).toBeDefined()
  })
  test('denies claude plugin and the plugin and mod folders from a shell', () => {
    expect(bash('claude plugin install x')?.deny).toContain('claude plugin')
    expect(bash('cp x ~/.claude/plugins/y')).toBeDefined()
    expect(bash('echo hi > ~/.claude/dev-mods/m.js')).toBeDefined()
  })
  test('lets action-rules.py approve through (the kit tells the agent to run it after the owner said yes in chat); denies anything in enroll-pending', () => {
    expect(bash('python3 action-rules.py approve 12')).toBeUndefined()
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
  test('a wildcard that can reach the restart check file is denied and says so', () => {
    for (const c of [
      `rm ${home}/main-restart*`,
      `cd ${home} && rm main-rest*`,
      `mv /tmp/x ${home}/main-restart-che[c]k.json`,
    ])
      expect(bash(c)?.deny, c).toContain('main-restart-check')
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
  test("the screen helper's allowed-apps list is read-only to sessions, by a shell or the Write tools", () => {
    expect(bash(`cat ${home}/screen/allowed-apps.json`)).toBeUndefined()
    for (const c of [
      `echo '{}' > ${home}/screen/allowed-apps.json`,
      `cp /tmp/saved.json ${home}/screen/allowed-apps.json`,
      `mv /tmp/saved.json ${home}/screen/allowed-apps.json`,
      `rm -rf ${home}/screen`,
      `cd ${home} && rm screen/allowed-apps.json`,
    ])
      expect(bash(c), c).toBeDefined()
    expect(write(join(home, 'screen', 'allowed-apps.json'))).toBeDefined()
    expect(write(join(home, 'screen', 'allowed-apps.json'), 'Edit')).toBeDefined()
  })
  test('owner-folders.json (the folders the owner chose, which folder trust relies on) is read-only to sessions: a shell, Write and Edit', () => {
    expect(cfg.writeDenied).toContain(join(realpathSync(root), 'user', '.config', 'talos', 'owner-folders.json'))
    expect(bash(`cat ${home}/owner-folders.json`)).toBeUndefined()
    for (const c of [
      `echo '{"v":1,"threads":{}}' > ${home}/owner-folders.json`,
      `tee ${home}/owner-folders.json`,
      `sed -i '' s/a/b/ ${home}/owner-folders.json`,
      `python3 -c "open('${home}/owner-folders.json','w')"`,
      `cp x ${home}/owner-folders.json`,
      `mv /tmp/x ${home}/owner-folders.json`,
    ])
      expect(bash(c), c).toBeDefined()
    expect(write(join(home, 'owner-folders.json'))).toBeDefined()
    expect(write(join(home, 'owner-folders.json'), 'Edit')).toBeDefined()
    // a thread session's own fence closes the whole Talos home to the file tools, so it is covered there too
    expect(fenceDenyRules(home)).toEqual(expect.arrayContaining([`Write(/${home}/**)`, `Edit(/${home}/**)`]))
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
      'cd apps/bridge && bun run src/cli.ts enroll --label x',
      '"talos-app" enroll',
      't""alos-app enroll',
    ])
      expect(bash(c)?.deny, c).toContain('human-only')
    expect(bash('talos-app trust off')).toBeUndefined()
    expect(bash('talos-app trust show')).toBeUndefined()
    expect(bash('talos-app theme show')).toBeUndefined()
    // the guards: the agent may install them, never remove them (2026-11-14)
    expect(bash('talos-app install-guards --remove')?.deny).toContain('human-only')
    expect(bash('talos-app install-guards')).toBeUndefined()
    // run by the agent when the owner asked (on-request-cli.ts checks that, and the lock): not the guard's to deny
    for (const c of [
      'talos-app theme reset',
      'bun src/cli.ts memory init --agent-dir .',
      'talos-app lead init trip --folder x',
    ])
      expect(bash(c), c).toBeUndefined()
  })
  test('an unreadable input is denied', () => {
    expect(guardDecision({ tool_name: 'Write', tool_input: {} }, cfg)).toBeDefined()
  })
})

describe('the kit updater: an agent cannot update, roll back or restore, or write a release', () => {
  const kit = cfg.protectedPaths[cfg.protectedPaths.length - 1] as string
  test('the kit vendor folder is on the never-change list, for the write tools and for shell writes', () => {
    expect(kit.endsWith(join('talos', 'kit'))).toBe(true)
    expect(write(join(kit, 'releases', '9.9.9-planted', 'talos-kit', 'hooks', 'x.py'))?.deny).toContain(kit)
    expect(write(join(kit, 'current'), 'Edit')).toBeDefined()
    expect(write(join(kit, 'releases', '1.2.0', 'talos-kit', 'allowed_signers'), 'MultiEdit')).toBeDefined()
    expect(bash(`ln -sfn releases/9.9.9 ${kit}/current`)?.deny).toContain(kit)
    expect(bash(`echo evil > ${kit}/releases/1.2.0/talos-kit/allowed_signers`)).toBeDefined()
    expect(bash(`rm -rf ${kit}/releases`)).toBeDefined()
    expect(bash(`ls ${kit}/releases && cat ${kit}/current/talos-kit/VERSION`)).toBeUndefined() // reading is fine
  })
  test('talos update, rollback and restore are open to a session (2026-11-14: signed releases only); the updater called directly stays denied, since trust-key (adding a signer) is reached that way', () => {
    for (const c of ['talos update', 'talos update --dry-run', 'talos rollback 1.2.0', 'talos restore CLAUDE.md'])
      expect(bash(c), c).toBeUndefined()
    for (const c of [
      'talos-update update --source /x',
      'bash -c "talos-update rollback"',
      'python3 /somewhere/kit/scripts/talos-update.py trust-key k.pub',
      'FOO=1 talos-update restore x',
    ])
      expect(bash(c)?.deny, c).toContain('human-only')
    // a path or a message that merely contains the name is not the command
    expect(bash('git commit -m "talos-update restore: docs"')).toBeUndefined()
    expect(bash('grep -n update kit/scripts/talos-update.py')).toBeUndefined()
  })
  test("talos-app update and rollback (the app's own, behind the ask card) are not denied: the phone recovery path", () => {
    for (const c of ['talos-app rollback --yes', 'talos-app rollback', 'talos-app update'])
      expect(bash(c), c).toBeUndefined()
    const rules = denyRules(cfg)
    for (const r of ['Bash(talos-app update:*)', 'Bash(talos-app rollback:*)', 'Bash(talos-app restore:*)'])
      expect(rules, r).not.toContain(r)
    // the ask card is what stands in front of `talos-app rollback`
    expect(DEFAULT_ASK_RULES).toContain('Bash(*talos-app rollback*)')
  })
  test('no deny rule for `talos update` or `talos rollback` any more, so the app forms are open too', () => {
    const rules = denyRules(cfg)
    expect(rules).not.toContain('Bash(talos rollback:*)')
    expect(rules).not.toContain('Bash(talos update:*)')
    expect(bash('talos rollback app --yes')).toBeUndefined()
  })
  test('the permission deny rules name the updater called directly (trust-key), not `talos update/rollback/restore` (open since 2026-11-14)', () => {
    const rules = denyRules(cfg)
    expect(rules).toContain('Bash(talos-update:*)')
    for (const r of ['Bash(talos update:*)', 'Bash(talos rollback:*)', 'Bash(talos restore:*)'])
      expect(rules, r).not.toContain(r)
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
    // what a gone bun does, as measured (guards-refresh.test.ts): the hook cannot start and Claude Code lets the call through
    expect(a.out.join('\n')).toContain('blocks every guarded tool call until the session restarts (it fails closed)')
    expect(a.out.join('\n')).toContain('talos-app guards refresh')
    expect(runInstallGuards(install, [], io().io)).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(first)
  })

  test('--remove undoes it', () => {
    expect(runInstallGuards(install, ['--remove'], io().io)).toBe(0)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(join(home, 'guards'))).toBe(false)
    expect(runInstallGuards(install, ['--remove'], io().io)).toBe(0)
  })
})

const hookCommand = () =>
  JSON.parse(readFileSync(join(home, 'guards', 'settings.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command as string
const sha = () => /--sha ([0-9a-f]{64})/.exec(hookCommand())?.[1] as string
/** The rules file the installed hook names: its own file, by hash (install.ts rulesFileFor). */
const rulesPath = () => JSON.parse(/--config ("(?:[^"\\]|\\.)*")/.exec(hookCommand())?.[1] as string) as string

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
          rulesPath(),
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
    // the hook input's `cwd` (Claude Code sends it to every hook) reaches the rules: the same unpack, inside the home and out
    const unpack = (cwd: unknown) =>
      run(
        JSON.stringify({
          session_id: 's',
          cwd,
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'tar xf a.tar' },
        }),
      )
    expect(JSON.parse((await unpack(join(home, 'workers'))).out).hookSpecificOutput.permissionDecision).toBe('deny')
    expect((await unpack(join(userHome, 'proj'))).out.trim()).toBe('')
    expect((await unpack(42)).out.trim()).toBe('') // a cwd that is not a string is ignored, not trusted
  })

  test('editing, emptying or removing the hash from guards.json fails closed, it never loosens', async () => {
    runInstallGuards(install, [], { out: () => {}, err: () => {} })
    const rules = rulesPath()
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
  test('withGuardsSettings: the guards and the computer-use deny in one --settings first; without the guards, the deny alone', () => {
    runInstallGuards(install, ['--remove'], { out: () => {}, err: () => {} })
    const plain = withGuardsSettings(['--x'], home)
    expect(plain.flags[0]).toBe('--settings')
    expect(JSON.parse(plain.flags[1] as string)).toEqual({ deniedMcpServers: [{ serverName: 'computer-use' }] })
    expect(plain.flags.slice(2)).toEqual(['--x'])
    runInstallGuards(install, [], { out: () => {}, err: () => {} })
    expect(withGuardsSettings(['--x'], home)).toEqual({
      flags: ['--settings', join(home, 'guards', 'main-launch.json'), '--x'],
    })
  })
  test("the owner's own --settings stays in place, the deny beside it; the guards are off and that is said", () => {
    const r = withGuardsSettings(['--settings', '/x.json'], home)
    expect(r.flags).toEqual(['--disallowedTools', 'mcp__computer-use', '--settings', '/x.json'])
    expect(r.warning).toContain('NOT active')
    expect(r.warning).not.toContain("Claude Code's own computer use is NOT turned off")
    expect(withGuardsSettings(['--settings=/x.json'], home).warning).toContain('NOT active')
  })
  test('--remove tells the owner to restart now', () => {
    const out: string[] = []
    runInstallGuards(install, ['--remove'], { out: (l) => out.push(l), err: () => {} })
    expect(out.join(' ')).toContain('Restart the agent now')
    expect(out.join(' ')).toContain('every tool call')
  })
})
