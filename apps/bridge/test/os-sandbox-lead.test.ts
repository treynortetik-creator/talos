// A lead folder as the real `lead init --sandbox` makes it must start with the extra lock on, and a hook edited by one byte must not.
// The lead's hook scripts pass only as regular files directly in <folder>/.claude/hooks that are byte for byte the kit's templates in the
// recorded clone (<clone>/kit/templates/lead). The home, the user home and the folder are throwaway folders in the test temp tree.
import { afterEach, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import defaultConfig from '../../../examples/config.default.json' with { type: 'json' }
import { paths } from '../src/config.ts'
import { osSandboxPreflight, prepareOsSandbox, readOsSandboxSwitch } from '../src/guards/os-sandbox.ts'
import { folderKitProblem } from '../src/guards/os-sandbox-folder.ts'
import { cmdLead } from '../src/lead/cli.ts'

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (p: string) => {
  const d = mkdtempSync(join(realpathSync(tmpdir()), p))
  made.push(d)
  return d
}
const BRIDGE = resolve(import.meta.dir, '..')
const TRUSTED = { bun: process.execPath, bridgeDir: BRIDGE }

/** The real lead init (--sandbox) into a throwaway Talos home, user home and folder; then the extra lock turned on. */
function leadFolder(parent = 'leads') {
  const talosHome = tmp('tsl-home-')
  const agentDir = tmp('tsl-agent-')
  writeFileSync(join(agentDir, '.talos-version'), '1')
  const userHome = tmp('tsl-user-')
  const dir = join(userHome, parent, 'trip')
  const claudeDir = join(userHome, '.claude')
  const cfg = {
    ...defaultConfig,
    threads: [
      ...(defaultConfig as { threads: unknown[] }).threads,
      {
        id: 'trip',
        name: 'Trip',
        kind: 'agent',
        order: 9,
        notify: 'all',
        archived: false,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ],
  }
  writeFileSync(paths(talosHome).configJson, JSON.stringify(cfg))
  const lines: string[] = []
  const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(`ERR ${l}`), isTerminal: true }
  const code = cmdLead(
    { home: talosHome } as never,
    ['init', 'trip', '--folder', dir, '--agent-dir', agentDir, '--sandbox'],
    io,
    {
      home: userHome,
      claudeDir,
      pathDirs: [],
    },
  )
  expect(code, lines.join('\n')).toBe(0)
  writeFileSync(paths(talosHome).configJson, JSON.stringify({ ...cfg, os_sandbox: true }))
  const start = (trusted: typeof TRUSTED | null = TRUSTED) =>
    prepareOsSandbox(
      { talosHome, userHome, folder: dir, claudeDir, trusted, writableRoots: [] },
      { ownerExcludes: () => [], write: () => {} },
    )
  return { talosHome, userHome, dir, claudeDir, start }
}
const refusal = (r: ReturnType<ReturnType<typeof leadFolder>['start']>) => ('refusal' in r ? r.refusal : null)

describe('a lead folder made by `lead init --sandbox`, with the extra lock on', () => {
  test('passes the home’s preflight, and the settings are built: it starts', () => {
    const w = leadFolder()
    expect(readOsSandboxSwitch(w.talosHome)).toBe(true)
    expect(osSandboxPreflight(w.talosHome)).toBeNull()
    const r = w.start()
    expect(refusal(r)).toBeNull()
    const p = 'pieces' in r ? r.pieces : null
    expect(p?.sandbox.enabled).toBe(true)
    expect(p?.sandbox.filesystem.denyWrite).toContain(join(w.dir, '.claude'))
    // the lead's own settings carry the two hooks the kit's templates make
    const settings = JSON.parse(readFileSync(join(w.dir, '.claude', 'settings.json'), 'utf8')) as {
      sandbox: { allowUnsandboxedCommands: boolean }
    }
    expect(settings.sandbox.allowUnsandboxedCommands).toBe(false)
  })

  test('a hook script edited by one byte is refused, naming the hook', () => {
    const w = leadFolder()
    appendFileSync(join(w.dir, '.claude', 'hooks', 'board-stop.sh'), '#')
    expect(refusal(w.start())).toContain('the Stop hook (number 1)')
    expect(refusal(w.start())).toContain("which is not the kit's own")
  })

  test('without a recorded bridge the lead’s hooks are refused', () => {
    const w = leadFolder()
    expect(refusal(w.start(null))).toContain("which is not the kit's own")
  })

  test('a hook that is a link, or a hard-linked copy elsewhere, is not the template file in place', () => {
    const w = leadFolder()
    const hook = join(w.dir, '.claude', 'hooks', 'turn-start.sh')
    const body = readFileSync(hook)
    rmSync(hook)
    const elsewhere = join(tmp('tsl-else-'), 'turn-start.sh')
    writeFileSync(elsewhere, body)
    symlinkSync(elsewhere, hook)
    expect(refusal(w.start())).not.toBeNull()
    rmSync(hook)
    writeFileSync(hook, body)
    linkSync(hook, join(tmp('tsl-else-'), 'twin'))
    expect(refusal(w.start())).toContain('has another name')
  })

  test('a script of the same name in another folder under .claude does not count', () => {
    const w = leadFolder()
    mkdirSync(join(w.dir, '.claude', 'own'), { recursive: true })
    writeFileSync(
      join(w.dir, '.claude', 'own', 'turn-start.sh'),
      readFileSync(join(w.dir, '.claude', 'hooks', 'turn-start.sh')),
    )
    const s = join(w.dir, '.claude', 'settings.json')
    const j = JSON.parse(readFileSync(s, 'utf8')) as {
      hooks: { UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }> }
    }
    const h = j.hooks.UserPromptSubmit[0]?.hooks[0]
    if (h) h.command = h.command.replace('/.claude/hooks/', '/.claude/own/')
    writeFileSync(s, JSON.stringify(j))
    expect(refusal(w.start())).toContain("which is not the kit's own")
  })
})

describe('the kit link is required only when a command names the folder’s own hooks/ or scripts/', () => {
  test('a command in .claude/hooks does not need a hooks link; one in <folder>/hooks does', () => {
    const w = leadFolder()
    expect(folderKitProblem(w.dir)).toBeNull() // real lead: commands name .claude/hooks/...
    const s = join(w.dir, '.claude', 'settings.json')
    writeFileSync(
      s,
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR"/hooks/x.sh' }] }] },
      }),
    )
    expect(folderKitProblem(w.dir)).toContain('hooks is missing')
    writeFileSync(
      s,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'bash scripts/x.sh' }] }] } }),
    )
    expect(folderKitProblem(w.dir)).toContain('scripts is missing')
  })
})

// A folder whose path has a space in it ("My Agent"): the folder variable is replaced inside one word, so the path stays one word.
describe('a lead folder with a space in its path', () => {
  const spaced = () => {
    const w = leadFolder('My Agent')
    expect(w.dir).toContain(' ')
    return w
  }
  const setCommand = (dir: string, command: string) =>
    writeFileSync(
      join(dir, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } }),
    )

  test('starts with the extra lock on, and needs no hooks link for its own .claude/hooks', () => {
    const w = spaced()
    expect(refusal(w.start())).toBeNull()
    expect(folderKitProblem(w.dir)).toBeNull()
  })

  test('a hook edited by one byte is still refused, naming the hook', () => {
    const w = spaced()
    appendFileSync(join(w.dir, '.claude', 'hooks', 'board-stop.sh'), '#')
    const why = refusal(w.start())
    expect(why).toContain('the Stop hook (number 1)')
    expect(why).not.toContain('board-stop.sh')
    expect(why).toContain("which is not the kit's own")
  })

  test('a command through a kit link that is gone is still caught', () => {
    const w = spaced()
    setCommand(w.dir, '"$CLAUDE_PROJECT_DIR"/hooks/stop.sh')
    expect(folderKitProblem(w.dir)).toContain('hooks is missing')
    setCommand(w.dir, 'bash "$CLAUDE_PROJECT_DIR/scripts/x.sh"')
    expect(folderKitProblem(w.dir)).toContain('scripts is missing')
  })

  test('a quoted path with a space that is not the kit’s own is refused', () => {
    const w = spaced()
    for (const c of [
      '"$CLAUDE_PROJECT_DIR"/tools/guard.sh',
      '"$CLAUDE_PROJECT_DIR/other dir/x.sh"',
      '"/Else Where/x.sh"',
      '"$CLAUDE_PROJECT_DIR"/.claude/hooks/evil.sh',
      // a nested shell cuts the path again; a quote the check misreads (`$'..'`) must not make the variable look quoted
      'sh -c "$CLAUDE_PROJECT_DIR/.claude/hooks/board-stop.sh"',
      'eval "$CLAUDE_PROJECT_DIR/.claude/hooks/board-stop.sh"',
      "true $'\\''\"'\" ; $CLAUDE_PROJECT_DIR/.claude/hooks/board-stop.sh",
      '"$CLAUDE_PROJECT_DIR"/.claude/hooks/board-stop.sh; true',
    ]) {
      setCommand(w.dir, c)
      expect(refusal(w.start()) ?? `ALLOWED ${c}`, c).toContain("which is not the kit's own")
    }
  })
  /** A kit release with a space in its path (hooks/stop.sh, mcp/server.js) and the folder's `hooks` link into it, with TALOS_KIT_HOME on it for `run`. */
  const withKit = (w: ReturnType<typeof spaced>, run: (kit: string) => void) => {
    const kit = join(tmp('tsl-kit-'), 'Kit Release')
    mkdirSync(join(kit, 'mcp'), { recursive: true })
    mkdirSync(join(kit, 'hooks'))
    writeFileSync(join(kit, 'mcp', 'server.js'), '1')
    writeFileSync(join(kit, 'hooks', 'stop.sh'), '#!/bin/sh\n')
    symlinkSync(join(kit, 'hooks'), join(w.dir, 'hooks'))
    const was = process.env.TALOS_KIT_HOME
    process.env.TALOS_KIT_HOME = kit
    try {
      run(kit)
    } finally {
      if (was === undefined) delete process.env.TALOS_KIT_HOME
      else process.env.TALOS_KIT_HOME = was
    }
  }
  const serve = (dir: string, ...args: string[]) => serveWith(dir, 'bash', ...args)
  const serveWith = (dir: string, command: string, ...args: string[]) =>
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { k: { command, args } } }))

  test('only the variable inside double quotes is one word: where the shell would cut the folder’s path, so is it refused', () => {
    const w = spaced()
    withKit(w, () => {
      setCommand(w.dir, '"$CLAUDE_PROJECT_DIR"/hooks/stop.sh')
      expect(refusal(w.start())).toBeNull()
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own braced variable
      setCommand(w.dir, '"${CLAUDE_PROJECT_DIR}/hooks/stop.sh"')
      expect(refusal(w.start())).toBeNull()
      for (const c of [
        '$CLAUDE_PROJECT_DIR/hooks/stop.sh',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own braced variable
        '${CLAUDE_PROJECT_DIR}/hooks/stop.sh',
        "'$CLAUDE_PROJECT_DIR'/hooks/stop.sh",
        'bash $CLAUDE_PROJECT_DIR/hooks/stop.sh',
      ]) {
        setCommand(w.dir, c)
        expect(refusal(w.start()) ?? `ALLOWED ${c}`, c).toContain("which is not the kit's own")
      }
    })
  })

  test('a hook line that keeps the folder in a variable is cut or refused: a second value, a prefix assignment and a nested shell are not the kit’s file', () => {
    const w = spaced()
    withKit(w, () => {
      const set = 'f="$CLAUDE_PROJECT_DIR/hooks/stop.sh"'
      for (const c of [
        `${set}; python3 "$f"`,
        `${set}; f=$TMPDIR/e; bash "$f"`,
        `${set}; f=/tmp/evilzz; bash "$f"`,
        `${set} bash "$f"`,
        `${set}; sh -c "$f"`,
        `${set}; eval "$f"`,
        `${set}; python3 $f`,
        'f="$CLAUDE_PROJECT_DIR/other dir/x.sh"; python3 "$f"',
      ]) {
        setCommand(w.dir, c)
        expect(refusal(w.start()) ?? `ALLOWED ${c}`, c).toContain("which is not the kit's own")
      }
    })
  })

  test('a kit release whose own path has a space: a server that names its file runs; a hook line or a -c argument is cut as the shell cuts it', () => {
    const w = spaced()
    withKit(w, (kit) => {
      const other = join(tmp('tsl-else-'), 'Other Dir')
      mkdirSync(other)
      writeFileSync(join(other, 'server.js'), '1')
      serve(w.dir, join(kit, 'mcp', 'server.js'))
      expect(refusal(w.start())).toBeNull()
      serve(w.dir, join(other, 'server.js'))
      expect(refusal(w.start())).toContain("which is not the kit's own")
      // run as a command line, the path is cut at its space: the program would be the first word
      serve(w.dir, '-c', join(kit, 'mcp', 'server.js'))
      expect(refusal(w.start())).toContain("which is not the kit's own")
      // env, xargs and the like cut an argument again, so only the programs that take a file as one file keep a spaced path whole
      serveWith(w.dir, 'env', '-S', join(kit, 'mcp', 'server.js'))
      expect(refusal(w.start())).toContain("which is not the kit's own")
      serveWith(w.dir, 'env', join(kit, 'mcp', 'server.js'))
      expect(refusal(w.start())).toContain("which is not the kit's own")
      rmSync(join(w.dir, '.mcp.json'))
      setCommand(w.dir, `bash ${join(kit, 'hooks', 'stop.sh')}`)
      expect(refusal(w.start())).toContain("which is not the kit's own")
    })
  })
})

describe('a word that is not a path the kit owns, or that the environment decides, is refused', () => {
  const run = (command: string) => {
    const w = leadFolder()
    writeFileSync(
      join(w.dir, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } }),
    )
    return refusal(w.start())
  }
  const hook = '"$CLAUDE_PROJECT_DIR"/.claude/hooks/board-stop.sh'
  test('the lead’s own hook starts alone and is refused with any other file, variable or substitution beside it', () => {
    expect(run(hook)).toBeNull()
    for (const c of [
      `$TMPDIR/evilzz; ${hook}`,
      `$X; ${hook}`,
      `$(printf /tmp/evilzz); ${hook}`,
      `\`echo /tmp/evilzz\`; ${hook}`,
      `/tmp/evilzz; ${hook}`, // a file that does not exist yet: the session can make it
      '$CLAUDE_PROJECT_DIRS/../trip/.claude/hooks/board-stop.sh', // a longer name is not the project variable
    ])
      expect(run(c) ?? `ALLOWED ${c}`, c).toContain("which is not the kit's own")
  })
})

// R1291: the lines `lead init` really writes start alone; a bare word the shell would run from the folder, in front of one, does not.
describe('the lead’s own hook lines against a bare word', () => {
  const run = (command: string) => {
    const w = leadFolder()
    writeFileSync(
      join(w.dir, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } }),
    )
    return refusal(w.start())
  }
  test('each hook line the lead settings write starts alone, and is refused after a bare word', () => {
    const w = leadFolder()
    const settings = JSON.parse(readFileSync(join(w.dir, '.claude', 'settings.json'), 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    const lines = Object.values(settings.hooks).flatMap((gs) => gs.flatMap((g) => g.hooks.map((h) => h.command)))
    expect(lines.length).toBeGreaterThanOrEqual(2)
    for (const line of lines) {
      expect(run(line), line).toBeNull()
      for (const lead of ['bash evil', 'sh evil', 'node evil', 'bun evil', 'python3 evil', '. evil', 'source evil'])
        expect(run(`${lead}; ${line}`) ?? `ALLOWED ${lead}`, `${lead}; ${line}`).toContain("which is not the kit's own")
    }
  })
})
