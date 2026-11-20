// Agents set up thread agents (P1, protocol): the new thread fields, the atomic create-and-configure, who may change what
// (main, a thread session, its sub-threads), reach never above the parent's, and the risk of each.
import { describe, expect, it } from 'vitest'
import {
  AGENT_PATH_FORMS,
  AgentConfig,
  type AgentConfigT,
  configCardCandidate,
  isAgentConfigPath,
  readConfigPath,
  resolveConfigChanges,
  riskOfChange,
  THREAD_COLORS,
  THREAD_FIELD_RULES,
  undoText,
  verifyConfigPayload,
} from '../src/index.ts'
import { loadExample } from './helpers.ts'

const roots = {
  home: '/Users/example',
  talosHome: '/Users/example/Library/Talos',
}
const T = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  kind: 'agent',
  order: 5,
  notify: 'all',
  voice_context: 'recent',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
  ...over,
})
const base = loadExample('default')
const cfg: AgentConfigT = AgentConfig.parse({
  ...base,
  threads: [
    ...base.threads,
    T('site', { session_opts: { cwd: '/Users/example/Code/site', mcp_allow: ['github', 'linear'] } }),
    T('docs', { parent_id: 'site' }),
    T('blog', { parent_id: 'site' }),
    T('notes'),
    T('bare'),
    T('barekid', { parent_id: 'bare' }),
    T('loose', { session_opts: { cwd: '/Users/example/Code/loose', mcp_allow: ['slack'] } }),
  ],
})
const one = (path: string, value: unknown, opts: Parameters<typeof resolveConfigChanges>[2] = { roots }) =>
  resolveConfigChanges([{ path, value }], cfg, opts)
const many = (items: Array<[string, unknown]>, opts: Parameters<typeof resolveConfigChanges>[2] = { roots }) =>
  resolveConfigChanges(
    items.map(([path, value]) => ({ path, value })),
    cfg,
    opts,
  )
const as = (thread: string) => ({ thread, roots })
const refused = (r: ReturnType<typeof resolveConfigChanges>, words?: string) => {
  expect(r.ok).toBe(false)
  if (!r.ok && words) expect(r.error).toContain(words)
}

describe('the new thread fields', () => {
  it('lists them as paths, and the path regex takes session_opts.cwd and no other 4-part path', () => {
    expect(isAgentConfigPath('threads.notes.session_opts.cwd')).toBe(true)
    for (const bad of [
      'threads.notes.session_opts.model',
      'threads.notes.session_opts',
      'threads.notes.session_opts.cwd.x',
      'threads.notes.a.b',
    ])
      expect(isAgentConfigPath(bad), bad).toBe(false)
    for (const f of ['session_opts.cwd', 'model', 'effort', 'mcp_allow', 'color'])
      expect(AGENT_PATH_FORMS).toContain(`threads.<id>.${f}`)
    expect(Object.keys(THREAD_FIELD_RULES)).toEqual(expect.arrayContaining(['model', 'effort', 'mcp_allow', 'color']))
  })

  it('model: one the app offers (or inherit); a made-up one is refused', () => {
    expect(one('threads.notes.model', 'opus')).toMatchObject({ ok: true, changes: [{ old: 'inherit', new: 'opus' }] })
    expect(one('threads.notes.model', 'inherit').ok).toBe(false) // already that
    refused(one('threads.notes.model', 'gpt-9'), 'not one of the models')
    refused(one('threads.notes.model', 'not a model!'), 'threads.notes.model: Invalid string')
  })

  it('effort: a documented level; anything else is refused', () => {
    expect(one('threads.notes.effort', 'high').ok).toBe(true)
    refused(one('threads.notes.effort', 'turbo'), 'expected one of')
    refused(one('threads.notes.effort', 3), 'expected one of')
  })

  it('mcp_allow: a list of server names as today, [] allowed; a bad name or a repeat is refused', () => {
    expect(one('threads.notes.mcp_allow', ['github', 'claude.ai Gmail']).ok).toBe(true)
    expect(one('threads.notes.mcp_allow', []).ok).toBe(true)
    refused(one('threads.notes.mcp_allow', ['a,b']), 'Invalid string')
    refused(one('threads.notes.mcp_allow', ['a', 'a']), 'named twice')
    refused(one('threads.notes.mcp_allow', 'github'), 'expected array')
  })

  it('color: one of THREAD_COLORS', () => {
    for (const c of THREAD_COLORS) expect(one('threads.notes.color', c).ok, c).toBe(true)
    refused(one('threads.notes.color', 'beige'), 'expected one of')
    refused(one('threads.notes.color', 'Red'), 'expected one of')
  })

  it('session_opts.cwd: an absolute folder inside home; home, ~/.claude, the Talos home, relative, / and outside are refused', () => {
    const ok = one('threads.notes.session_opts.cwd', '/Users/example/Code/other')
    expect(ok).toMatchObject({ ok: true, changes: [{ old: null, new: '/Users/example/Code/other' }] })
    for (const [bad, why] of [
      ['/Users/example', 'inside your home folder'],
      ['/Users/example/.claude', 'inside ~/.claude'],
      ['/Users/example/.claude/projects', 'inside ~/.claude'],
      ['/Users/example/Library/Talos/x', 'Talos data folder'],
      ['Code/site', 'Invalid string'],
      ['/', 'inside your home folder'],
      ['/tmp/elsewhere', 'inside your home folder'],
      ['/Users/example/Code/../.claude', '..'],
    ] as const)
      refused(one('threads.notes.session_opts.cwd', bad), why)
  })

  it('the protected folders are refused whatever the case', () => {
    for (const bad of [
      '/Users/example/.CLAUDE/x',
      '/Users/example/.Claude',
      '/users/EXAMPLE',
      '/Users/example/library/talos/x',
      '/Users/example/LIBRARY/TALOS',
    ])
      expect(one('threads.notes.session_opts.cwd', bad).ok, bad).toBe(false)
    expect(one('threads.notes.session_opts.cwd', '/Users/example/Code/CamelCase').ok).toBe(true)
  })

  it('only the refused folders ignore case; "inside home" and "not home itself" stay as the disk spells them', () => {
    const lin = { home: '/home/alex', talosHome: '/home/alex/.talos' }
    const go = (cwd: string) => one('threads.notes.session_opts.cwd', cwd, { roots: lin })
    for (const bad of ['/HOME/alex/x', '/home/ALEX/x', '/home/ALEX', '/Home/alex'])
      refused(go(bad), 'inside your home folder')
    refused(go('/home/alex/.CLAUDE/x'), '~/.claude')
    refused(go('/home/alex/.Talos/x'), 'Talos data folder')
    expect(go('/home/alex/Code/Site').ok).toBe(true)
  })

  it('a folder with invisible or direction-changing characters is refused, so the text shown is the folder granted', () => {
    for (const bad of [
      '/Users/example/Code/\u202eevil',
      '/Users/example/Code/a\u0085b',
      '/Users/example/Code/a\u200bb',
      '/Users/example/Code/a\u2028b',
      '/Users/example/Code/a\u2029b',
      '/Users/example/Code/a\ufeffb',
      '/Users/example/Code/a\u2066b',
      '/Users/example/Code/a\u061cb',
    ]) {
      refused(one('threads.notes.session_opts.cwd', bad), 'plain text')
      refused(one('threads.made', { name: 'Made', session_opts: { cwd: bad } }), 'plain text')
    }
    expect(one('threads.notes.session_opts.cwd', '/Users/example/Code/caf\u00e9').ok).toBe(true)
  })

  it('session_opts.cwd without roots to check against is refused, never waved through', () => {
    refused(one('threads.notes.session_opts.cwd', '/Users/example/Code/other', {}), "can't be checked")
  })

  it('cwd and the other session fields in one proposal all land (session_opts is merged, not overwritten)', () => {
    const r = many([
      ['threads.notes.session_opts.cwd', '/Users/example/Code/other'],
      ['threads.notes.model', 'opus'],
      ['threads.notes.mcp_allow', ['github']],
      ['threads.notes.idle_park_min', 60],
    ])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const v = verifyConfigPayload(
      { v: 1, base_rev: 0, reason: 'x', changes: r.changes },
      cfg,
      '2026-11-19T00:00:00.000Z',
      { roots },
    )
    expect(v.ok).toBe(true)
    if (!v.ok) return
    const notes = (v.patch.threads as Array<{ id: string; session_opts?: unknown }>).find((t) => t.id === 'notes')
    expect(notes?.session_opts).toMatchObject({
      cwd: '/Users/example/Code/other',
      model: 'opus',
      mcp_allow: ['github'],
      idle_park_min: 60,
    })
  })
})

describe('create and configure in one proposal', () => {
  const full = {
    name: 'Docs site',
    topic: 'the docs',
    icon: 'book',
    color: 'blue',
    model: 'sonnet',
    effort: 'medium',
    mcp_allow: ['github'],
    idle_park_min: 45,
    parent: 'site',
    session: 'dedicated',
    session_opts: { cwd: '/Users/example/Code/site/docs' },
  }
  const patchOf = (r: ReturnType<typeof resolveConfigChanges>) => {
    if (!r.ok) throw new Error(r.error)
    const v = verifyConfigPayload(
      { v: 1, base_rev: 0, reason: 'x', changes: r.changes },
      cfg,
      '2026-11-19T00:00:00.000Z',
      { roots },
    )
    if (!v.ok) throw new Error(v.error)
    return (v.patch.threads as Array<Record<string, unknown> & { id: string }>).find((t) => t.id === 'made')
  }

  it('one proposal makes the thread with every field', () => {
    const t = patchOf(one('threads.made', full))
    expect(t).toMatchObject({
      name: 'Docs site',
      topic: 'the docs',
      icon: 'book',
      color: 'blue',
      parent_id: 'site',
      session: 'dedicated',
      session_opts: {
        cwd: '/Users/example/Code/site/docs',
        model: 'sonnet',
        effort: 'medium',
        mcp_allow: ['github'],
        idle_park_min: 45,
      },
    })
  })

  it('every value goes through the per-field validators', () => {
    // [value, reason, who]: a thread session is held inside its parent's folder; main follows the owner's own folder rules
    for (const [bad, why, as_] of [
      [{ model: 'gpt-9' }, 'not one of the models', undefined],
      [{ effort: 'turbo' }, 'effort', undefined],
      [{ color: 'beige' }, 'color', undefined],
      [{ mcp_allow: ['a', 'a'] }, 'named twice', undefined],
      [{ idle_park_min: 1 }, 'idle_park_min', undefined],
      [{ session_opts: { cwd: '/tmp/x' } }, 'inside your home folder', undefined],
      [{ session_opts: { cwd: 'rel' } }, 'session_opts', undefined],
      [{ session_opts: { cwd: '/Users/example/Code/x', model: 'opus' } }, 'session_opts', undefined], // strict: only cwd
      [{ parent: 'nowhere' }, 'there is no thread "nowhere"', undefined],
      [{ parent: 'docs' }, 'sub-thread itself', undefined],
      [
        { session_opts: { cwd: '/Users/example/Code/site2' }, parent: 'site' },
        'must be inside "site"\'s folder',
        'site',
      ],
      [{ mcp_allow: ['github', 'slack'], parent: 'site' }, 'slack', undefined], // main too
      [{ folder: '/Users/example/x' }, 'folder', undefined],
    ] as const) {
      const r = one('threads.made', { name: 'Made', ...bad }, as_ ? as(as_) : { roots })
      expect(r.ok, JSON.stringify(bad)).toBe(false)
      if (!r.ok) expect(r.error, JSON.stringify(bad)).toContain(why)
    }
  })

  it('a create with every field in the right place is refused for one wrong field, naming it', () => {
    refused(
      many([
        ['threads.made', { name: 'Made', parent: 'site' }],
        ['threads.made.model', 'gpt-9'],
      ]),
      'threads.made.model',
    )
  })
})

describe('the create card says what it grants', () => {
  const body = (value: Record<string, unknown>) => {
    const r = one('threads.made', { name: 'Made', ...value })
    if (!r.ok) throw new Error(r.error)
    return configCardCandidate({
      cardId: 'c1',
      threadId: 'general',
      now: '2026-11-19T00:00:00.000Z',
      expiresAt: '2026-11-19T01:00:00.000Z',
      origin: 'chat',
      baseRev: 1,
      reason: 'why',
      changes: r.changes,
    }).body
  }

  it('names the folder, each MCP server, the model, effort, colour, idle time, icon and topic', () => {
    const b = body({
      topic: 'the docs',
      icon: 'book',
      color: 'blue',
      model: 'sonnet',
      effort: 'medium',
      mcp_allow: ['github', 'linear'],
      idle_park_min: 45,
      parent: 'site',
      session: 'dedicated',
      session_opts: { cwd: '/Users/example/Code/site/docs' },
    })
    for (const w of [
      '/Users/example/Code/site/docs',
      'github',
      'linear',
      'sonnet',
      'medium',
      'blue',
      '45',
      'book',
      'the docs',
      'site',
      'own session',
    ])
      expect(b, w).toContain(w)
  })

  it('an empty MCP list reads "none", and no list under a parent reads "same as <parent>"', () => {
    expect(body({ mcp_allow: [] })).toContain('MCP servers: none')
    // a sub-thread with its own session and no list or folder of its own inherits from its parent
    const kid = body({ parent: 'site', session: 'dedicated' })
    expect(kid).toContain('MCP servers: same as site')
    expect(kid).toContain('folder: same as site')
    expect(kid).not.toContain('the agent folder')
    // a top-level thread with its own session and none: the agent folder, and every server
    const top = body({ session: 'dedicated' })
    expect(top).toContain('MCP servers: all')
    expect(top).toContain('folder: the agent folder')
  })

  it('a thread that stays on the main session has no folder or MCP line of its own', () => {
    for (const v of [{}, { parent: 'site' }]) {
      expect(body(v)).not.toContain('MCP servers')
      expect(body(v)).not.toContain('folder')
    }
    expect(body({ mcp_allow: ['github'] })).toContain('MCP servers: github')
  })
})

describe('the cards for the older value say what "no value" means', () => {
  const card = (path: string, value: unknown) => {
    const r = one(path, value)
    if (!r.ok) throw new Error(r.error)
    return {
      body: configCardCandidate({
        cardId: 'c1',
        threadId: 'general',
        now: '2026-11-19T00:00:00.000Z',
        expiresAt: '2026-11-19T01:00:00.000Z',
        origin: 'chat',
        baseRev: 1,
        reason: 'why',
        changes: r.changes,
        config: cfg,
      }).body,
      undo: undoText(r.changes, cfg),
    }
  }

  it('no MCP list reads "all (no list)", in the card and the undo line; no folder reads "the agent folder"', () => {
    const m = card('threads.notes.mcp_allow', ['github'])
    expect(m.body).toContain('all (no list) → github')
    expect(m.undo).toContain('back to all (no list)')
    const f = card('threads.notes.session_opts.cwd', '/Users/example/Code/x')
    expect(f.body).toContain('the agent folder → /Users/example/Code/x')
    expect(f.undo).toContain('back to the agent folder')
    expect(card('threads.site.mcp_allow', ['github']).body).toContain('github, linear → github')
  })

  it('the value read, compared and bound stays raw: a sub-thread\'s missing folder and list are null, the words alone say "same as"', () => {
    const f = one('threads.docs.session_opts.cwd', '/Users/example/Code/site/docs')
    const m = one('threads.docs.mcp_allow', ['github'])
    if (!f.ok || !m.ok) throw new Error('refused')
    expect(f.changes[0]?.old).toBeNull()
    expect(m.changes[0]?.old).toBeNull()
    expect(readConfigPath(cfg, 'threads.docs.session_opts.cwd')).toBeNull()
    expect(readConfigPath(cfg, 'threads.docs.mcp_allow')).toBeNull()
    // the payload the card binds carries null, and apply still accepts it against the same config
    const payload = { v: 1, base_rev: 0, reason: 'x', changes: [...f.changes, ...m.changes] }
    expect(JSON.stringify(payload)).not.toContain('same as')
    expect(verifyConfigPayload(payload, cfg, undefined, { roots }).ok).toBe(true)
    // without the config the words say plain "no value"
    expect(undoText(f.changes)).toContain('back to the agent folder')
  })

  it('a sub-thread\'s missing folder or list reads "same as <parent>" when the parent has one, else as for a top-level thread', () => {
    const f = card('threads.docs.session_opts.cwd', '/Users/example/Code/site/docs')
    expect(f.body).toContain('same as site → /Users/example/Code/site/docs')
    expect(f.undo).toContain('back to same as site')
    const m = card('threads.docs.mcp_allow', ['github'])
    expect(m.body).toContain('same as site → github')
    expect(m.undo).toContain('back to same as site')
    // its parent has neither: the thread's own default
    const bm = card('threads.barekid.mcp_allow', ['github'])
    expect(bm.body).toContain('all (no list) → github')
    expect(bm.undo).toContain('back to all (no list)')
  })
})

describe('a thread session T (site)', () => {
  it('changes its own low fields', () => {
    for (const [f, v] of [
      ['name', 'Site work'],
      ['topic', 'the site'],
      ['icon', 'globe'],
      ['color', 'cyan'],
      ['notify', 'needs_you'],
      ['idle_park_min', 90],
      ['effort', 'low'],
    ] as const)
      expect(one(`threads.site.${f}`, v, as('site')).ok, f).toBe(true)
  })

  it('is refused on its own session, folder, model, mcp, archived and parent', () => {
    for (const [f, v, why] of [
      ['session', 'dedicated', "its thread's own session"],
      ['session_opts.cwd', '/Users/example/Code/x', "its thread's folder"],
      ['model', 'opus', "its thread's model"],
      ['mcp_allow', ['github'], "its thread's MCP servers"],
      ['archived', true, "its thread's archived"],
      ['parent', 'notes', "can't move its thread"],
    ] as const) {
      const r = one(`threads.site.${f}`, v, as('site'))
      expect(r.ok, f).toBe(false)
      if (!r.ok) {
        expect(r.error, f).toContain(why)
        expect(r.error, f).toContain('Nothing was proposed')
      }
    }
  })

  it('creates a child with parent: site, and configures it in the same proposal', () => {
    expect(
      one(
        'threads.kid',
        { name: 'Kid', parent: 'site', session_opts: { cwd: '/Users/example/Code/site/kid' } },
        as('site'),
      ).ok,
    ).toBe(true)
    expect(
      many(
        [
          ['threads.kid', { name: 'Kid', parent: 'site' }],
          ['threads.kid.model', 'opus'],
          ['threads.kid.mcp_allow', ['github']],
        ],
        as('site'),
      ).ok,
    ).toBe(true)
  })

  it('is refused creating with no parent, or a sibling, or itself unrelated', () => {
    const under = 'can only make threads under it: put "parent":"site"'
    refused(one('threads.kid', { name: 'Kid' }, as('site')), under)
    refused(one('threads.kid', { name: 'Kid', parent: 'notes' }, as('site')), under)
    refused(one('threads.kid', { name: 'Kid', parent: 'docs' }, as('site')), under)
    // a field of a thread that the same proposal creates under someone else
    refused(
      many(
        [
          ['threads.kid', { name: 'Kid', parent: 'notes' }],
          ['threads.kid.color', 'red'],
        ],
        as('site'),
      ),
      under,
    )
  })

  it("changes its child's folder, model and mcp", () => {
    expect(one('threads.docs.session_opts.cwd', '/Users/example/Code/site/docs', as('site')).ok).toBe(true)
    expect(one('threads.docs.model', 'opus', as('site')).ok).toBe(true)
    expect(one('threads.docs.mcp_allow', ['github'], as('site')).ok).toBe(true)
    expect(one('threads.docs.session', 'dedicated', as('site')).ok).toBe(true)
  })

  it("is refused on a sibling's field, another thread, the default thread, and main's settings", () => {
    refused(one('threads.notes.topic', 'x', as('site')), 'own thread')
    refused(one('threads.general.topic', 'x', as('site')), 'own thread')
    refused(one(`threads.${cfg.default_thread}.topic`, 'x', as('site')), 'own thread')
    refused(one('timezone', 'UTC', as('site')), 'own thread')
    refused(one('threads.barekid.topic', 'x', as('site')), 'own thread') // someone else's child
  })

  it("is refused moving its child's parent", () => {
    refused(one('threads.docs.parent', null, as('site')), "can't move its thread")
    refused(one('threads.notes.parent', 'site', as('site')), "can't move its thread")
  })

  it('a sub-thread (docs, which has a parent) is refused creating anything', () => {
    refused(one('threads.kid', { name: 'Kid', parent: 'docs' }, as('docs')), 'sub-thread')
    refused(one('threads.kid', { name: 'Kid', parent: 'site' }, as('docs')), 'sub-thread')
    expect(one('threads.docs.topic', 'x', as('docs')).ok).toBe(true) // its own low fields still are
  })
})

describe('main', () => {
  it('may change any thread and make a sub-thread under any thread', () => {
    expect(one('threads.notes.model', 'opus').ok).toBe(true)
    expect(one('threads.docs.mcp_allow', ['github']).ok).toBe(true)
    expect(one('threads.kid', { name: 'Kid', parent: 'notes' }).ok).toBe(true)
  })
})

describe('reach never exceeds the parent', () => {
  it("a thread session's child folder: inside, or the parent's own, is fine; outside and a same-prefix sibling are refused", () => {
    const go = (cwd: string) => one('threads.docs.session_opts.cwd', cwd, as('site'))
    expect(go('/Users/example/Code/site/docs').ok).toBe(true)
    expect(go('/Users/example/Code/site').ok).toBe(true)
    expect(go('/Users/example/Code/site/').ok).toBe(true)
    refused(go('/Users/example/Code/site2'), 'must be inside "site"\'s folder')
    refused(go('/Users/example/Code/other'), 'must be inside "site"\'s folder')
  })

  it("main's child folder follows the owner's own folder rules (the bridge's subThreadPatchIssue), not P1's reach", () => {
    expect(one('threads.docs.session_opts.cwd', '/Users/example/Code/other').ok).toBe(true)
    expect(one('threads.docs.session_opts.cwd', '/Users/example/Code/site2').ok).toBe(true)
    // the folder rules that are not about the parent still hold for main
    refused(one('threads.docs.session_opts.cwd', '/Users/example/.CLAUDE/x'), '~/.claude')
    refused(one('threads.docs.session_opts.cwd', '/Users/example'), 'inside your home folder')
  })

  it("a child's mcp: a subset is fine, a superset is refused; the inherited list counts when the parent has one", () => {
    expect(one('threads.docs.mcp_allow', ['linear']).ok).toBe(true)
    expect(one('threads.docs.mcp_allow', []).ok).toBe(true)
    refused(one('threads.docs.mcp_allow', ['github', 'slack']), 'slack')
  })

  it('a folderless parent: a thread session gives a child no folder ("give the parent a folder first"); main follows the owner rule', () => {
    const first = 'give "bare" a folder first'
    refused(one('threads.barekid.session_opts.cwd', '/Users/example/Agent/work', as('bare')), first)
    refused(one('threads.barekid.session_opts.cwd', '/Users/example/Code/anywhere', as('bare')), first)
    refused(
      one('threads.kid', { name: 'Kid', parent: 'bare', session_opts: { cwd: '/Users/example/Code/x' } }, as('bare')),
      first,
    )
    // main: the folder is the bridge's call (d92f4285: judged against the agent folder, with the supervisor's capability)
    expect(one('threads.barekid.session_opts.cwd', '/Users/example/Code/anywhere').ok).toBe(true)
    expect(one('threads.kid', { name: 'Kid', parent: 'bare', session_opts: { cwd: '/Users/example/Code/x' } }).ok).toBe(
      true,
    )
    // a child with no folder of its own under it is fine, and its MCP list: a parent with no list limits nothing, as today
    expect(one('threads.kid', { name: 'Kid', parent: 'bare' }).ok).toBe(true)
    expect(one('threads.barekid.mcp_allow', ['anything']).ok).toBe(true)
  })

  it("re-parenting a thread with a folder outside the new parent: main's (the owner's own-folder rules decide), and a thread session creating one is refused", () => {
    // loose names slack, which site lacks: the list is still judged for main; the folder (Code/loose, outside site) is not
    refused(one('threads.loose.parent', 'site'), '"slack" is not on its parent')
    expect(
      many([
        ['threads.loose.mcp_allow', []],
        ['threads.loose.parent', 'site'],
      ]).ok,
    ).toBe(true)
    refused(
      one(
        'threads.kid',
        { name: 'Kid', parent: 'site', session_opts: { cwd: '/Users/example/Code/loose' } },
        as('site'),
      ),
      'must be inside "site"\'s folder',
    )
    // taking it out is never refused
    expect(one('threads.docs.parent', null).ok).toBe(true)
  })

  it("making a child's own session start judges the folder it already has (session dedicated, or archived false on a dedicated one)", () => {
    const owned = AgentConfig.parse({
      ...cfg,
      dedicated: { enabled: true },
      threads: [
        ...cfg.threads,
        T('out', { parent_id: 'site', session_opts: { cwd: '/Users/example/Elsewhere', mcp_allow: ['slack'] } }),
        T('back', {
          parent_id: 'site',
          session: 'dedicated',
          archived: true,
          session_opts: { cwd: '/Users/example/Elsewhere' },
        }),
      ],
    })
    const go = (path: string, value: unknown, thread?: string) =>
      resolveConfigChanges([{ path, value }], owned, { roots, ...(thread ? { thread } : {}) })
    refused(go('threads.out.session', 'dedicated', 'site'), 'must be inside "site"\'s folder')
    // main: the folder is the owner's own rules (the bridge's); its list (slack, not on site's) is still judged
    const mainOut = go('threads.out.session', 'dedicated')
    refused(mainOut, '"slack" is not on its parent')
    if (!mainOut.ok) expect(mainOut.error).not.toContain('must be inside')
    expect(go('threads.back.archived', false).ok).toBe(true)
    refused(go('threads.back.archived', false, 'site'), 'must be inside "site"\'s folder')
    // its MCP list is judged too
    const inside = AgentConfig.parse({
      ...owned,
      threads: owned.threads.map((t) =>
        t.id === 'out' ? { ...t, session_opts: { cwd: '/Users/example/Code/site/o', mcp_allow: ['slack'] } } : t,
      ),
    })
    refused(
      resolveConfigChanges([{ path: 'threads.out.session', value: 'dedicated' }], inside, { roots, thread: 'site' }),
      '"slack" is not on its parent',
    )
    // going to shared, or an unrelated field, is not judged
    expect(go('threads.out.topic', 'x', 'site').ok).toBe(true)
    expect(go('threads.out.color', 'red', 'site').ok).toBe(true)
  })

  it('a new thread can not be given its own session where the thread could never have one (general, inbox)', () => {
    const noGeneral = AgentConfig.parse({
      ...cfg,
      default_thread: 'notes',
      threads: cfg.threads.filter((t) => t.id !== 'general'),
    })
    const r = resolveConfigChanges(
      [{ path: 'threads.general', value: { name: 'General', session: 'dedicated' } }],
      noGeneral,
      { roots },
    )
    refused(r, "can't have its own session")
    expect(
      resolveConfigChanges([{ path: 'threads.general', value: { name: 'General' } }], noGeneral, { roots }).ok,
    ).toBe(true)
  })

  it("a parent in the archive still holds a thread session's children folders; main's unarchive is the owner's own rules", () => {
    const arch = AgentConfig.parse({
      ...cfg,
      threads: [
        ...cfg.threads.map((t) => (t.id === 'site' ? { ...t, archived: true } : t)),
        T('out', { parent_id: 'site', session: 'dedicated', session_opts: { cwd: '/Users/example/Elsewhere' } }),
      ],
    })
    const go = (path: string, value: unknown, thread?: string) =>
      resolveConfigChanges([{ path, value }], arch, { roots, ...(thread ? { thread } : {}) })
    // site's own session setting a child's folder under the archived parent is judged against it
    refused(go('threads.docs.session_opts.cwd', '/Users/example/Code/other', 'site'), 'must be inside "site"\'s folder')
    expect(go('threads.docs.session_opts.cwd', '/Users/example/Code/site/docs', 'site').ok).toBe(true)
    // main brings the parent back: the folders already there are the bridge's (owner) rule
    expect(go('threads.site.archived', false).ok).toBe(true)
  })

  it('model and effort are free', () => {
    expect(one('threads.docs.model', 'haiku').ok).toBe(true)
    expect(one('threads.docs.effort', 'max').ok).toBe(true)
  })

  it('moving a thread under a parent: its list is judged in the same proposal for everyone, its folder for a thread session only', () => {
    refused(
      many([
        ['threads.notes.mcp_allow', ['slack']],
        ['threads.notes.parent', 'site'],
      ]),
      '"slack" is not on its parent',
    )
    expect(
      many([
        ['threads.notes.session_opts.cwd', '/Users/example/Code/n'],
        ['threads.notes.parent', 'site'],
      ]).ok,
    ).toBe(true)
    refused(
      many(
        [
          ['threads.kid', { name: 'Kid', parent: 'site' }],
          ['threads.kid.session_opts.cwd', '/Users/example/Code/n'],
        ],
        as('site'),
      ),
      'must be inside "site"\'s folder',
    )
  })

  it("a thread session's folder is judged again at apply (the card records its scope)", () => {
    const r = one('threads.docs.session_opts.cwd', '/Users/example/Code/site/docs', as('site'))
    if (!r.ok) throw new Error(r.error)
    const moved = AgentConfig.parse({
      ...cfg,
      threads: cfg.threads.map((t) =>
        t.id === 'site' ? { ...t, session_opts: { ...t.session_opts, cwd: '/Users/example/Code/elsewhere' } } : t,
      ),
    })
    const payload = { v: 1, base_rev: 0, reason: 'x', scope: 'site', changes: r.changes }
    const v = verifyConfigPayload(payload, moved, undefined, { roots })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.error).toContain('must be inside "site"\'s folder')
    // main's card (no scope) on the same config: the owner's own rules at the bridge decide
    expect(verifyConfigPayload({ ...payload, scope: undefined }, moved, undefined, { roots }).ok).toBe(true)
  })

  it("a thread session's proposal is judged again at apply, on the config as it is then, for the caller the card records", () => {
    const r = one('threads.docs.model', 'opus', as('site'))
    if (!r.ok) throw new Error(r.error)
    const card = configCardCandidate({
      cardId: 'c1',
      threadId: 'site',
      now: '2026-11-19T00:00:00.000Z',
      expiresAt: '2026-11-19T01:00:00.000Z',
      origin: 'chat',
      baseRev: 1,
      reason: 'why',
      changes: r.changes,
      scope: 'site',
    })
    expect(card.payload).toMatchObject({ scope: 'site' })
    expect(verifyConfigPayload(card.payload, cfg, undefined, { roots }).ok).toBe(true)
    // the owner moved the child under someone else meanwhile
    const moved = AgentConfig.parse({
      ...cfg,
      threads: cfg.threads.map((t) => (t.id === 'docs' ? { ...t, parent_id: 'notes' } : t)),
    })
    const v = verifyConfigPayload(card.payload, moved, undefined, { roots })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.error).toContain('can only change its own thread')
    // a card from main records no scope and is not held to one
    const mainCard = configCardCandidate({
      cardId: 'c2',
      threadId: 'general',
      now: '2026-11-19T00:00:00.000Z',
      expiresAt: '2026-11-19T01:00:00.000Z',
      origin: 'chat',
      baseRev: 1,
      reason: 'why',
      changes: r.changes,
    })
    expect(mainCard.payload).not.toHaveProperty('scope')
    expect(verifyConfigPayload(mainCard.payload, moved, undefined, { roots }).ok).toBe(true)
  })
})

describe('risk', () => {
  it('cwd, model and mcp are high; icon, colour and effort are low', () => {
    for (const [p, v] of [
      ['threads.notes.session_opts.cwd', '/Users/example/Code/x'],
      ['threads.notes.model', 'opus'],
      ['threads.notes.mcp_allow', ['github']],
    ] as const)
      expect(riskOfChange({ path: p, new: v }, cfg), p).toBe('high')
    for (const [p, v] of [
      ['threads.notes.icon', 'x'],
      ['threads.notes.color', 'red'],
      ['threads.notes.effort', 'low'],
    ] as const)
      expect(riskOfChange({ path: p, new: v }, cfg), p).toBe('low')
  })

  it('a card is high only for the new fields (folder, model, MCP list, or a create that sets one); everything older keeps its card risk', () => {
    const card = (path: string, value: unknown) => {
      const r = one(path, value)
      if (!r.ok) throw new Error(r.error)
      return configCardCandidate({
        cardId: 'c1',
        threadId: 'general',
        now: '2026-11-19T00:00:00.000Z',
        expiresAt: '2026-11-19T01:00:00.000Z',
        origin: 'chat',
        baseRev: 1,
        reason: 'why',
        changes: r.changes,
      }).risk
    }
    expect(card('threads.notes.session_opts.cwd', '/Users/example/Code/x')).toBe('high')
    expect(card('threads.notes.model', 'opus')).toBe('high')
    expect(card('threads.notes.mcp_allow', ['github'])).toBe('high')
    // what existed before this change keeps today's card risk (low), whatever the table calls it
    expect(card('threads.notes.session', 'dedicated')).toBe('low')
    expect(card('threads.notes.archived', true)).toBe('low')
    expect(card('threads.notes.parent', 'site')).toBe('low')
    expect(card('threads.notes.notify', 'off')).toBe('low')
    expect(card('quiet_window', { start: '21:30', end: '06:30' })).toBe('low')
    expect(card('threads.made', { name: 'Made', parent: 'site' })).toBe('low')
    expect(card('threads.made', { name: 'Made', session: 'dedicated' })).toBe('low')
    expect(card('threads.made', { name: 'Made', mcp_allow: ['github'] })).toBe('high')
    expect(card('threads.made', { name: 'Made', session_opts: { cwd: '/Users/example/Code/made' } })).toBe('high')
    expect(card('threads.notes.icon', 'x')).toBe('low')
    expect(card('threads.notes.color', 'red')).toBe('low')
    expect(card('threads.made', { name: 'Made' })).toBe('low')
    expect(card('threads.made', { name: 'Made', model: 'opus' })).toBe('high')
  })
})
