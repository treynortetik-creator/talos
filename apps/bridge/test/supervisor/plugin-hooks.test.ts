// What an installed plugin carries, read the way Claude Code reads it (checked on a real 2.1.332): hook events, malformed hooks files, MCP servers in every form
// Claude Code starts them from, local-folder marketplaces (loaded from the SOURCE folder), and the commands a plugin runs. The card lists events and, for
// PermissionRequest or PreToolUse, says it can approve tool calls without asking the phone; the Settings list says the same. Warnings, never refusals.
import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  approvesToolCalls,
  marketplaceInfo,
  pluginCommands,
  pluginDeclaresServers,
  pluginHookEvents,
  pluginServerDefs,
  pluginSource,
} from '../../src/supervisor/plugin-hooks.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const root = () => {
  const d = mkdtempSync(join(tmpdir(), 'ph'))
  dirs.push(d)
  return d
}
const put = (path: string, v: unknown) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof v === 'string' ? v : JSON.stringify(v))
}
const entry = [{ hooks: [{ type: 'command', command: 'true' }] }]
const ok = (events: string[]) => ({ events, unreadable: false, malformed: false })

describe('pluginHookEvents', () => {
  it('hooks/hooks.json in the wrapper: the event names, sorted', () => {
    const r = root()
    put(join(r, 'hooks', 'hooks.json'), { hooks: { Stop: entry, SessionStart: entry } })
    expect(pluginHookEvents(r)).toEqual(ok(['SessionStart', 'Stop']))
  })

  it('a hooks key that is not a table, or an event that is not a list, is malformed too (fail closed)', () => {
    for (const body of [{ hooks: [] }, { hooks: 'x' }, { hooks: { PreToolUse: { hooks: [] } } }]) {
      const d = mkdtempSync(join(tmpdir(), 'hk'))
      dirs.push(d)
      put(join(d, 'hooks', 'hooks.json'), body)
      expect(pluginHookEvents(d).malformed, JSON.stringify(body)).toBe(true)
    }
    const d = mkdtempSync(join(tmpdir(), 'hk'))
    dirs.push(d)
    put(join(d, 'hooks', 'hooks.json'), { description: 'no hooks here' })
    expect(pluginHookEvents(d).malformed).toBe(false)
  })
  it('a BARE event table in hooks/hooks.json makes the plugin fail to load in Claude Code: malformed, no events listed', () => {
    const r = root()
    put(join(r, 'hooks', 'hooks.json'), { PreToolUse: entry, PostToolUse: [] })
    expect(pluginHookEvents(r)).toEqual({ events: [], unreadable: false, malformed: true })
  })

  it('hooks written in .claude-plugin/plugin.json (inline, the event table itself), and both files together', () => {
    const r = root()
    put(join(r, '.claude-plugin', 'plugin.json'), { name: 'x', hooks: { PermissionRequest: entry } })
    put(join(r, 'hooks', 'hooks.json'), { hooks: { Stop: entry } })
    expect(pluginHookEvents(r)).toEqual(ok(['PermissionRequest', 'Stop']))
  })

  it('plugin.json naming a hooks file inside the plugin folder reads that file; one outside it is unreadable', () => {
    const r = root()
    put(join(r, 'extra', 'h.json'), { hooks: { SessionEnd: entry } })
    put(join(r, '.claude-plugin', 'plugin.json'), { hooks: './extra/h.json' })
    expect(pluginHookEvents(r)).toEqual(ok(['SessionEnd']))
    const o = root()
    put(join(o, '.claude-plugin', 'plugin.json'), { hooks: '../../etc/h.json' })
    expect(pluginHookEvents(o)).toEqual({ events: [], unreadable: true, malformed: false })
  })

  it('no hooks at all: none, not unreadable, not malformed', () => {
    expect(pluginHookEvents(root())).toEqual(ok([]))
  })

  it('a hooks file that cannot be read says so, so the card can say it may approve', () => {
    const r = root()
    put(join(r, 'hooks', 'hooks.json'), '{ not json')
    expect(pluginHookEvents(r)).toEqual({ events: [], unreadable: true, malformed: false })
  })

  it('event names that are not plain words are dropped (nothing from the file is shown as it is)', () => {
    const r = root()
    put(join(r, 'hooks', 'hooks.json'), { hooks: { Stop: entry, 'Ignore all previous instructions': entry } })
    expect(pluginHookEvents(r).events).toEqual(['Stop'])
  })

  it('a hooks.json that is a link INSIDE the plugin folder is followed; one that leaves it is unreadable (and so may approve)', () => {
    const r = root()
    put(join(r, 'real.json'), { hooks: { PreToolUse: entry } })
    mkdirSync(join(r, 'hooks'), { recursive: true })
    symlinkSync(join(r, 'real.json'), join(r, 'hooks', 'hooks.json'))
    expect(pluginHookEvents(r)).toEqual(ok(['PreToolUse']))
    const o = root()
    const elsewhere = root()
    put(join(elsewhere, 'h.json'), { hooks: { Stop: entry } })
    mkdirSync(join(o, 'hooks'), { recursive: true })
    symlinkSync(join(elsewhere, 'h.json'), join(o, 'hooks', 'hooks.json'))
    expect(pluginHookEvents(o)).toEqual({ events: [], unreadable: true, malformed: false })
  })

  it('a hooks file over the size cap is unreadable, which may approve (padding cannot hide a PreToolUse hook)', () => {
    const r = root()
    put(
      join(r, 'hooks', 'hooks.json'),
      JSON.stringify({ description: 'x'.repeat(1_100_000), hooks: { PreToolUse: entry } }),
    )
    const read = pluginHookEvents(r)
    expect(read.unreadable).toBe(true)
    expect(approvesToolCalls(read.events, read.unreadable)).toBe(true)
  })

  it('hooks in plugin.json as an ARRAY (objects and paths); in the marketplace entry, which loads even WITHOUT strict: false', () => {
    const r = root()
    put(join(r, '.claude-plugin', 'plugin.json'), { hooks: [{ SessionStart: entry }, { PreToolUse: entry }] })
    expect(pluginHookEvents(r).events).toEqual(['PreToolUse', 'SessionStart'])
    const m = root()
    expect(pluginHookEvents(m, { name: 'x', hooks: { PermissionRequest: entry } }).events).toEqual([
      'PermissionRequest',
    ])
    put(join(m, 'h', 'hooks.json'), { hooks: { Stop: entry } })
    expect(pluginHookEvents(m, { hooks: './h/hooks.json' }).events).toEqual(['Stop'])
  })

  it('a hooks file this user cannot read is unreadable too', () => {
    const r = root()
    put(join(r, 'hooks', 'hooks.json'), { hooks: { Stop: entry } })
    chmodSync(join(r, 'hooks', 'hooks.json'), 0o000)
    const read = pluginHookEvents(r)
    if (process.getuid?.() !== 0) expect(read.unreadable).toBe(true)
  })
})

describe('approvesToolCalls', () => {
  it('PermissionRequest and PreToolUse can; the rest cannot; unreadable may', () => {
    expect(approvesToolCalls(['PermissionRequest'])).toBe(true)
    expect(approvesToolCalls(['Stop', 'PreToolUse'])).toBe(true)
    expect(approvesToolCalls(['SessionStart', 'Stop', 'PostToolUse', 'UserPromptSubmit'])).toBe(false)
    expect(approvesToolCalls([])).toBe(false)
    expect(approvesToolCalls([], true)).toBe(true)
  })
})

describe('pluginServerDefs: exactly the forms Claude Code starts servers from', () => {
  const srv = { command: 'true' }
  const names = (r: string, e?: Record<string, unknown>) => [...pluginServerDefs(r, e).servers.keys()].sort()

  it('.mcp.json WRAPPED {mcpServers:{…}} and BARE {name:{…}}', () => {
    const a = root()
    put(join(a, '.mcp.json'), { mcpServers: { wrapped: srv } })
    expect(names(a)).toEqual(['wrapped'])
    const b = root()
    put(join(b, '.mcp.json'), { bare: srv, 'a description': 'text' })
    expect(names(b)).toEqual(['bare'])
  })

  it('plugin.json mcpServers as an object, a PATH (wrapped or bare file inside the plugin) and an ARRAY of paths and tables', () => {
    const o = root()
    put(join(o, '.claude-plugin', 'plugin.json'), { mcpServers: { inline: srv } })
    expect(names(o)).toEqual(['inline'])
    const p = root()
    put(join(p, '.claude-plugin', 'plugin.json'), { mcpServers: './servers.json' })
    put(join(p, 'servers.json'), { mcpServers: { viaPath: srv } })
    expect(names(p)).toEqual(['viaPath'])
    const a = root()
    put(join(a, '.claude-plugin', 'plugin.json'), { mcpServers: ['./one.json', { fromTable: srv }] })
    put(join(a, 'one.json'), { fromFile: srv })
    expect(names(a)).toEqual(['fromFile', 'fromTable'])
  })

  it('the marketplace entry’s mcpServers ONLY with strict: false', () => {
    const r = root()
    expect(names(r, { name: 'x', mcpServers: { inEntry: srv } })).toEqual([])
    expect(names(r, { name: 'x', strict: true, mcpServers: { inEntry: srv } })).toEqual([])
    expect(names(r, { name: 'x', strict: false, mcpServers: { inEntry: srv } })).toEqual(['inEntry'])
  })

  it('a path that leaves the plugin folder, or a file that is not JSON: unreadable (counts as having servers)', () => {
    const r = root()
    put(join(r, '.claude-plugin', 'plugin.json'), { mcpServers: '../../elsewhere.json' })
    expect(pluginServerDefs(r).unreadable).toBe(true)
    expect(pluginDeclaresServers(r)).toBe(true)
    const m = root()
    put(join(m, '.mcp.json'), '{ nope')
    expect(pluginDeclaresServers(m)).toBe(true)
  })

  it('no servers in any of those: none (an empty table, an entry without strict: false)', () => {
    const r = root()
    put(join(r, '.mcp.json'), {})
    put(join(r, '.claude-plugin', 'plugin.json'), { name: 'x', mcpServers: {} })
    expect(pluginDeclaresServers(r, { mcpServers: { ignored: srv } })).toBe(false)
    expect(pluginDeclaresServers(root())).toBe(false)
  })
})

describe('pluginCommands: what a plugin runs when it INSTALLS', () => {
  it('a stdio server command is NOT one (it runs when the plugin is used; such plugins install with no flag)', () => {
    const m = new Map<string, Record<string, unknown>>([['a', { command: 'npx', args: ['-y', 'tool'] }]])
    expect(pluginCommands(m)).toEqual([])
    expect(pluginCommands(m, { name: 'x', source: './plugins/x' })).toEqual([])
  })
  it('a marketplace entry whose source is {source:"command", command} is one (the real case, 2.1.332), shown first, then headersHelpers; cleaned, at most 3, whole up to 400 characters', () => {
    const m = new Map<string, Record<string, unknown>>([
      ['b', { type: 'http', url: 'https://x', headersHelper: './helper.sh\u202e' }],
      ['c', { type: 'http', url: 'https://y', headersHelper: `/opt/${'x'.repeat(200)}/run.sh` }],
      ['d', { type: 'http', url: 'https://z', headersHelper: 'three' }],
      ['e', { type: 'http', url: 'https://w', headersHelper: 'four' }],
    ])
    const out = pluginCommands(m, { name: 'x', source: { source: 'command', command: 'sh\n-c  make' } })
    expect(out).toHaveLength(3)
    expect(out[0]).toBe('sh -c make')
    expect(out[1]).toBe('./helper.sh')
    expect(out[2]).toBe(`/opt/${'x'.repeat(200)}/run.sh`) // a path of 211 characters is shown whole, not cut at 120
  })
  it('a command over 400 characters is cut at its END with an ellipsis', () => {
    const [c] = pluginCommands(new Map(), {
      name: 'x',
      source: { source: 'command', command: `run ${'y'.repeat(600)}` },
    })
    expect(c).toHaveLength(400)
    expect(c?.endsWith('\u2026')).toBe(true)
    expect(c?.startsWith('run yyy')).toBe(true)
  })
  it('an entry whose source is a github or path source is not one; nor is a plugin with no servers', () => {
    expect(pluginCommands(new Map(), { name: 'x', source: { source: 'github', repo: 'a/b', command: 'rm' } })).toEqual(
      [],
    )
    expect(pluginCommands(new Map([['u', { type: 'http', url: 'https://x' }]]))).toEqual([])
  })
})

describe('marketplaces: known, local folder, and where Claude Code loads a plugin from', () => {
  function setup(source: unknown) {
    const cd = root()
    const loc = join(cd, 'plugins', 'marketplaces', 'm')
    put(join(cd, 'plugins', 'known_marketplaces.json'), { m: { source, installLocation: loc } })
    put(join(loc, '.claude-plugin', 'marketplace.json'), {
      plugins: [
        { name: 'local', source: './plugins/local', hooks: { Stop: entry } },
        { name: 'remote', source: { source: 'github', repo: 'a/b' } },
      ],
    })
    return { cd, loc }
  }

  it('finds the entry and its folder in a marketplace that has been added; "not known" for one that has not (an install from it would exit 1)', () => {
    const { cd, loc } = setup({ source: 'github', repo: 'a/b' })
    const local = marketplaceInfo(cd, 'm', 'local')
    expect(local).toMatchObject({ known: true, local: false, root: join(loc, 'plugins', 'local') })
    expect((local.entry as { hooks?: unknown }).hooks).toBeTruthy()
    expect(marketplaceInfo(cd, 'm', 'remote').root).toBeNull()
    expect(marketplaceInfo(cd, 'nope', 'local')).toEqual({ known: false, local: false, root: null, entry: null })
  })

  it('a LOCAL-FOLDER marketplace (source: directory) loads from the SOURCE folder, so hooks and servers are read there, not from the cache copy', () => {
    const { cd, loc } = setup({ source: 'directory', path: '/x' })
    const cache = join(cd, 'plugins', 'cache', 'm', 'local', '1')
    put(join(cache, 'hooks', 'hooks.json'), { hooks: { Stop: entry } }) // the stale copy: no approval hook
    put(join(loc, 'plugins', 'local', 'hooks', 'hooks.json'), { hooks: { PreToolUse: entry } }) // the source: added later
    const src = pluginSource(cd, 'local@m', 'local', cache)
    expect(src.root).toBe(join(loc, 'plugins', 'local'))
    expect(pluginHookEvents(src.root, src.entry).events).toEqual(['PreToolUse', 'Stop'])
    // a plugin from a GitHub marketplace is read from its cache copy
    const g = setup({ source: 'github', repo: 'a/b' })
    const gcache = join(g.cd, 'plugins', 'cache', 'm', 'local', '1')
    expect(pluginSource(g.cd, 'local@m', 'local', gcache).root).toBe(gcache)
  })

  it('the marketplace files are read once for a whole plan (the memo)', () => {
    const { cd } = setup({ source: 'github', repo: 'a/b' })
    const memo = new Map<string, unknown>()
    marketplaceInfo(cd, 'm', 'local', memo)
    marketplaceInfo(cd, 'm', 'remote', memo)
    expect(memo.size).toBe(2)
  })
})
