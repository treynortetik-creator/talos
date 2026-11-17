// Sub-threads: `Thread.parent_id` reads tolerantly and survives a partial thread patch; the write rule keeps the tree one
// level deep, waits for the Mac app, and keeps a sub-thread's folder and MCP list inside its parent's; inheritance fills
// only what the sub-thread left unset.
import { describe, expect, it } from 'vitest'
import {
  AgentConfig,
  type AgentConfigT,
  effectiveSessionOpts,
  folderInside,
  folderSame,
  leadPostThreads,
  leadReadThreads,
  leadThreadFor,
  parentThread,
  parseWorkersFile,
  resolveThreadsPatch,
  sessionFieldsIssue,
  subThreadPatchIssue,
  subThreadsOf,
  subThreadWarnings,
} from '../src/index.ts'
import { loadExample } from './helpers.ts'

const yes = { macSupports: true }

function withThreads(extra: Array<Record<string, unknown>>): AgentConfigT {
  const base = loadExample('default')
  const created_at = '2026-01-01T00:00:00Z'
  return AgentConfig.parse({
    ...base,
    threads: [...base.threads, ...extra.map((t) => ({ kind: 'fixed', created_at, ...t }))],
  })
}

const project = {
  id: 'project',
  name: 'Project',
  session_opts: { cwd: '/home/alex/code', mcp_allow: ['github', 'linear'] },
}
const docs = { id: 'docs', name: 'Docs', parent_id: 'project' }

describe('the parent_id field', () => {
  it('is kept when read and absent on threads without one', () => {
    const cfg = withThreads([project, docs])
    expect(cfg.threads.find((t) => t.id === 'docs')?.parent_id).toBe('project')
    expect(cfg.threads.find((t) => t.id === 'project')?.parent_id).toBeUndefined()
  })

  it('reads a value that is not a thread id as none, never failing the config', () => {
    const cfg = withThreads([project, { ...docs, parent_id: 'Not An Id' }])
    expect(cfg.threads.find((t) => t.id === 'docs')?.parent_id).toBeUndefined()
  })

  it('survives a thread patch that leaves it out (an older app renaming the thread)', () => {
    const cfg = withThreads([project, docs])
    const patched = resolveThreadsPatch(
      cfg.threads,
      cfg.threads.map(({ parent_id: _p, ...t }) => (t.id === 'docs' ? { ...t, name: 'Docs site' } : t)),
    ) as Array<Record<string, unknown>>
    expect(patched.find((t) => t.id === 'docs')).toMatchObject({ name: 'Docs site', parent_id: 'project' })
  })

  it('is cleared by an explicit null', () => {
    const cfg = withThreads([project, docs])
    const patched = resolveThreadsPatch(
      cfg.threads,
      cfg.threads.map((t) => (t.id === 'docs' ? { ...t, parent_id: null } : t)),
    ) as Array<Record<string, unknown>>
    expect(patched.find((t) => t.id === 'docs')).not.toHaveProperty('parent_id')
  })

  it('is refused in a write when it is not a thread id, so a patch never lands with the parent silently left off', () => {
    const cfg = withThreads([project, docs])
    const merged = (parent_id: unknown) => ({
      threads: cfg.threads.map((t) => (t.id === 'docs' ? { ...t, parent_id } : t)),
    })
    for (const bad of ['Not An Id', '', 7, {}, 'all']) expect(sessionFieldsIssue(merged(bad))).toMatch(/"docs".*parent/)
    expect(sessionFieldsIssue(merged('project'))).toBeNull()
    expect(sessionFieldsIssue({ threads: cfg.threads })).toBeNull()
  })
})

describe('workers.json subthreads_supported', () => {
  const file = (supervisor: Record<string, unknown>) =>
    JSON.stringify({ v: 1, supervisor: { pid: 1, heartbeat_at: '2026-01-01T00:00:00Z', ...supervisor }, threads: {} })
  it('is off when an older Mac app leaves it out, or writes something unreadable', () => {
    expect(parseWorkersFile(file({}))?.supervisor.subthreads_supported).toBe(false)
    expect(parseWorkersFile(file({ subthreads_supported: 'yes' }))?.supervisor.subthreads_supported).toBe(false)
  })
  it('is on when the Mac app says so', () => {
    expect(parseWorkersFile(file({ subthreads_supported: true }))?.supervisor.subthreads_supported).toBe(true)
  })
  it('subthreads_shared_folder is off when absent or unreadable, on only for a literal true', () => {
    expect(parseWorkersFile(file({ subthreads_own_folder: true }))?.supervisor.subthreads_shared_folder).toBe(false)
    expect(parseWorkersFile(file({ subthreads_shared_folder: 1 }))?.supervisor.subthreads_shared_folder).toBe(false)
    expect(parseWorkersFile(file({ subthreads_shared_folder: true }))?.supervisor.subthreads_shared_folder).toBe(true)
  })
  it('subthreads_own_folder is off when absent or unreadable, on only for a literal true', () => {
    expect(parseWorkersFile(file({ subthreads_supported: true }))?.supervisor.subthreads_own_folder).toBe(false)
    expect(parseWorkersFile(file({ subthreads_own_folder: 'yes' }))?.supervisor.subthreads_own_folder).toBe(false)
    expect(parseWorkersFile(file({ subthreads_own_folder: true }))?.supervisor.subthreads_own_folder).toBe(true)
  })
  it('workers_supported that is not a boolean reads as off and keeps the rest of the file', () => {
    const f = parseWorkersFile(file({ workers_supported: 'yes', subthreads_supported: true }))
    expect(f?.supervisor).toMatchObject({ workers_supported: false, subthreads_supported: true })
  })
})

describe('subThreadPatchIssue', () => {
  const before = withThreads([project, { id: 'docs', name: 'Docs' }])

  it('lets a thread be put under a parent once the Mac supports it', () => {
    expect(subThreadPatchIssue(before, withThreads([project, docs]), yes)).toBeNull()
  })

  it('refuses a new parent while the Mac app does not support sub-threads', () => {
    expect(subThreadPatchIssue(before, withThreads([project, docs]), { macSupports: false })).toMatch(/updated/)
  })

  it('never refuses taking a thread out from under its parent, even without Mac support', () => {
    expect(subThreadPatchIssue(withThreads([project, docs]), before, { macSupports: false })).toBeNull()
  })

  it('does not judge an untouched sub-thread when the Mac stops reporting support', () => {
    const cfg = withThreads([project, docs])
    const renamed = withThreads([{ ...project, name: 'Project two' }, docs])
    expect(subThreadPatchIssue(cfg, renamed, { macSupports: false })).toBeNull()
  })

  it('refuses a missing, archived or system parent, and itself as parent', () => {
    expect(subThreadPatchIssue(before, withThreads([project, { ...docs, parent_id: 'nope' }]), yes)).toMatch(
      /no thread/,
    )
    const archived = withThreads([{ ...project, archived: true }, docs])
    expect(
      subThreadPatchIssue(
        withThreads([
          { ...project, archived: true },
          { id: 'docs', name: 'Docs' },
        ]),
        archived,
        yes,
      ),
    ).toMatch(/archived/)
    expect(subThreadPatchIssue(before, withThreads([project, { ...docs, parent_id: 'inbox' }]), yes)).toMatch(/inbox/)
    expect(subThreadPatchIssue(before, withThreads([project, { ...docs, parent_id: 'docs' }]), yes)).toMatch(
      /own parent/,
    )
  })

  it('keeps the tree one level deep, both ways round', () => {
    const notes = { id: 'notes', name: 'Notes' }
    const twoDeep = withThreads([project, docs, { ...notes, parent_id: 'docs' }])
    expect(subThreadPatchIssue(withThreads([project, docs, notes]), twoDeep, yes)).toMatch(/one level/)
    // a parent with sub-threads can't itself be put under another thread
    const parentMoved = withThreads([{ ...project, parent_id: 'notes' }, docs, notes])
    expect(subThreadPatchIssue(withThreads([project, docs, notes]), parentMoved, yes)).toMatch(/one level/)
  })

  it("keeps a sub-thread's folder inside its parent's", () => {
    const outside = withThreads([project, { ...docs, session_opts: { cwd: '/home/alex/other' } }])
    expect(subThreadPatchIssue(before, outside, yes)).toMatch(/inside its parent/)
    const same = withThreads([project, { ...docs, session_opts: { cwd: '/home/alex/code' } }])
    expect(subThreadPatchIssue(before, same, yes)).toMatch(/inside its parent/)
    const sibling = withThreads([project, { ...docs, session_opts: { cwd: '/home/alex/code-two' } }])
    expect(subThreadPatchIssue(before, sibling, yes)).toMatch(/inside its parent/)
    const inside = withThreads([project, { ...docs, session_opts: { cwd: '/home/alex/code/docs' } }])
    expect(subThreadPatchIssue(before, inside, yes)).toBeNull()
  })

  it("re-judges a sub-thread when its parent's folder moves", () => {
    const cfg = withThreads([project, { ...docs, session_opts: { cwd: '/home/alex/code/docs' } }])
    const moved = withThreads([
      { ...project, session_opts: { ...project.session_opts, cwd: '/home/alex/elsewhere' } },
      { ...docs, session_opts: { cwd: '/home/alex/code/docs' } },
    ])
    expect(subThreadPatchIssue(cfg, moved, yes)).toMatch(/inside its parent/)
  })

  it('wants its own folder for a sub-thread with its own session', () => {
    const noFolder = withThreads([project, { ...docs, session: 'dedicated' }])
    expect(subThreadPatchIssue(before, noFolder, yes)).toMatch(/needs its own folder/)
    const parentNoFolder = withThreads([
      { id: 'project', name: 'Project' },
      { ...docs, session: 'dedicated', session_opts: { cwd: '/home/alex/code/docs' } },
    ])
    expect(
      subThreadPatchIssue(
        withThreads([
          { id: 'project', name: 'Project' },
          { id: 'docs', name: 'Docs' },
        ]),
        parentNoFolder,
        yes,
      ),
    ).toMatch(/folder first/)
  })

  it('refuses archiving or removing a parent while a live sub-thread still depends on it', () => {
    const cfg = withThreads([project, docs])
    expect(subThreadPatchIssue(cfg, withThreads([{ ...project, archived: true }, docs]), yes)).toMatch(
      /archive its sub-threads/,
    )
    expect(subThreadPatchIssue(cfg, withThreads([docs]), yes)).toMatch(/no thread "project"/)
    // archiving both together, or the sub-thread alone, is fine
    expect(
      subThreadPatchIssue(
        cfg,
        withThreads([
          { ...project, archived: true },
          { ...docs, archived: true },
        ]),
        yes,
      ),
    ).toBeNull()
    expect(
      subThreadPatchIssue(cfg, withThreads([project, { ...docs, archived: true }]), { macSupports: false }),
    ).toBeNull()
  })

  it('refuses restoring a sub-thread whose parent is still archived', () => {
    const both = withThreads([
      { ...project, archived: true },
      { ...docs, archived: true },
    ])
    expect(subThreadPatchIssue(both, withThreads([{ ...project, archived: true }, docs]), yes)).toMatch(/archived/)
  })

  it('refuses any change to an existing sub-thread while the Mac app does not support sub-threads', () => {
    const cfg = withThreads([project, { ...docs, session_opts: { cwd: '/home/alex/code/docs' } }])
    const no = { macSupports: false }
    const dedicated = withThreads([
      project,
      { ...docs, session: 'dedicated', session_opts: { cwd: '/home/alex/code/docs' } },
    ])
    expect(subThreadPatchIssue(cfg, dedicated, no)).toMatch(/updated/)
    const moved = withThreads([project, { ...docs, session_opts: { cwd: '/home/alex/code/site' } }])
    expect(subThreadPatchIssue(cfg, moved, no)).toMatch(/updated/)
  })

  it("lets a parent's MCP list get narrower even when a sub-thread's own list names what it dropped", () => {
    const sub = { ...docs, session_opts: { mcp_allow: ['github', 'linear'] } }
    const cfg = withThreads([project, sub])
    const narrower = withThreads([
      { ...project, session_opts: { ...project.session_opts, mcp_allow: ['github'] } },
      sub,
    ])
    for (const macSupports of [true, false]) expect(subThreadPatchIssue(cfg, narrower, { macSupports })).toBeNull()
    expect(effectiveSessionOpts(narrower, 'docs')).toMatchObject({ mcp_allow: ['github'], dropped: ['linear'] })
  })

  it("lets a parent's MCP list get narrower over a sub-thread that already broke a rule (a hand edit)", () => {
    // taking access away is never held back by something this change did not touch
    const outside = { ...docs, session: 'dedicated', session_opts: { cwd: '/home/alex/elsewhere' } }
    const cfg = withThreads([project, outside])
    const narrower = withThreads([
      { ...project, session_opts: { ...project.session_opts, mcp_allow: ['github'] } },
      outside,
    ])
    for (const macSupports of [true, false]) expect(subThreadPatchIssue(cfg, narrower, { macSupports })).toBeNull()
    // touching the sub-thread itself is still judged
    const renamedFolder = withThreads([project, { ...outside, session_opts: { cwd: '/home/alex/other' } }])
    expect(subThreadPatchIssue(cfg, renamedFolder, yes)).toMatch(/inside its parent/)
  })

  it("lets a parent's MCP list get narrower without Mac support, never wider", () => {
    const cfg = withThreads([project, docs])
    const no = { macSupports: false }
    const narrower = withThreads([{ ...project, session_opts: { ...project.session_opts, mcp_allow: [] } }, docs])
    expect(subThreadPatchIssue(cfg, narrower, no)).toBeNull()
    const wider = withThreads([
      { ...project, session_opts: { ...project.session_opts, mcp_allow: ['github', 'linear', 'gmail'] } },
      docs,
    ])
    expect(subThreadPatchIssue(cfg, wider, no)).toMatch(/updated/)
    const moved = withThreads([
      { ...project, session_opts: { ...project.session_opts, cwd: '/home/alex/other' } },
      docs,
    ])
    expect(subThreadPatchIssue(cfg, moved, no)).toMatch(/updated/)
  })

  it("gives a sub-thread no MCP server its parent's list leaves out", () => {
    const wider = withThreads([project, { ...docs, session_opts: { mcp_allow: ['github', 'gmail'] } }])
    expect(subThreadPatchIssue(before, wider, yes)).toMatch(/"gmail"/)
    const narrower = withThreads([project, { ...docs, session_opts: { mcp_allow: ['github'] } }])
    expect(subThreadPatchIssue(before, narrower, yes)).toBeNull()
  })
})

describe('a sub-thread with its own folder outside its parent', () => {
  const own = { ...docs, session: 'dedicated', session_opts: { cwd: '/home/alex/talos-repo' } }
  const outside = withThreads([project, own])
  const base = withThreads([project, { id: 'docs', name: 'Docs' }])
  const line = `thread "docs" keeps its own folder, so it does not get "project"'s instructions; the parent's privacy rules still apply`
  const supports = { macSupports: true, ownFolder: true }

  it('is accepted with one warning when the supervisor says it can run one', () => {
    expect(subThreadPatchIssue(base, outside, supports)).toBeNull()
    expect(subThreadWarnings(outside)).toEqual([line])
  })
  it('is refused with the old text when the supervisor cannot', () => {
    expect(subThreadPatchIssue(base, outside, yes)).toMatch(/must be inside its parent's folder/)
    expect(subThreadPatchIssue(base, outside, { macSupports: true, ownFolder: false })).toMatch(/inside its parent/)
  })
  it('is still refused when the folder is the parent itself (a trailing slash too)', () => {
    for (const cwd of ['/home/alex/code', '/home/alex/code/']) {
      const same = withThreads([project, { ...own, session_opts: { cwd } }])
      expect(subThreadPatchIssue(base, same, supports)).toMatch(/inside its parent/)
    }
  })
  it('keeps the inside rule, with no warning', () => {
    const inside = withThreads([project, { ...own, session_opts: { cwd: '/home/alex/code/docs' } }])
    expect(subThreadPatchIssue(base, inside, supports)).toBeNull()
    expect(subThreadWarnings(inside)).toEqual([])
  })
  it('is not widened to a sub-thread without its own session, or to relative and dotted paths', () => {
    const shared = withThreads([project, { ...docs, session_opts: { cwd: '/home/alex/talos-repo' } }])
    expect(subThreadPatchIssue(base, shared, supports)).toMatch(/inside its parent/)
    expect(subThreadWarnings(shared)).toEqual([])
    for (const cwd of ['talos-repo', '/home/alex/code/../talos-repo', '~/talos-repo']) {
      const odd = withThreads([project, { ...own, session_opts: { cwd } }])
      expect(subThreadPatchIssue(base, odd, supports)).toMatch(/inside its parent/)
    }
  })
  it('keeps the other refusals: no folder, a parent without one, an archived one is not warned', () => {
    const noFolder = withThreads([project, { ...own, session_opts: {} }])
    expect(subThreadPatchIssue(base, noFolder, supports)).toMatch(/needs its own folder/)
    const parentNone = withThreads([{ id: 'project', name: 'Project' }, own])
    expect(subThreadPatchIssue(base, parentNone, supports)).toMatch(/give "project" a folder/)
    expect(subThreadWarnings(withThreads([project, { ...own, archived: true }]))).toEqual([])
  })
  it('still narrows the MCP list to the parent', () => {
    const wider = withThreads([project, { ...own, session_opts: { ...own.session_opts, mcp_allow: ['gmail'] } }])
    expect(subThreadPatchIssue(base, wider, supports)).toMatch(/"gmail"/)
  })
})

describe("a dedicated sub-thread in its parent's folder (subthreads_shared_folder)", () => {
  const base = withThreads([project, { id: 'docs', name: 'Docs' }])
  const shares = { macSupports: true, ownFolder: true, sharedFolder: true }
  const dedicated = (session_opts?: Record<string, unknown>) =>
    withThreads([project, { ...docs, session: 'dedicated', ...(session_opts ? { session_opts } : {}) }])
  const line = 'thread "docs" and its parent "project" work in the same folder; they can edit the same files'

  it('may have no folder, or the very same one (a trailing slash too), when the supervisor says so', () => {
    expect(subThreadPatchIssue(base, dedicated(), shares)).toBeNull()
    for (const cwd of ['/home/alex/code', '/home/alex/code/'])
      expect(subThreadPatchIssue(base, dedicated({ cwd }), shares)).toBeNull()
  })
  it('keeps the old refusals without the capability', () => {
    const old = { macSupports: true, ownFolder: true }
    expect(subThreadPatchIssue(base, dedicated(), old)).toMatch(/needs its own folder/)
    expect(subThreadPatchIssue(base, dedicated({ cwd: '/home/alex/code' }), old)).toMatch(/inside its parent/)
    expect(subThreadPatchIssue(base, dedicated(), { macSupports: true, sharedFolder: false })).toMatch(/own folder/)
  })
  it('allows a no-folder child under a parent with no folder, but not a child folder under one', () => {
    const none = { id: 'project', name: 'Project' }
    expect(subThreadPatchIssue(base, withThreads([none, { ...docs, session: 'dedicated' }]), shares)).toBeNull()
    expect(
      subThreadPatchIssue(
        base,
        withThreads([none, { ...docs, session: 'dedicated', session_opts: { cwd: '/home/alex/code/docs' } }]),
        shares,
      ),
    ).toMatch(/give "project" a folder/)
  })
  it('leaves the other folders as they were: inside is fine, outside needs its own existing folder, siblings are refused', () => {
    expect(subThreadPatchIssue(base, dedicated({ cwd: '/home/alex/code/docs' }), shares)).toBeNull()
    expect(subThreadPatchIssue(base, dedicated({ cwd: '/home/alex/talos-repo' }), shares)).toBeNull() // own folder, 998b660c
    expect(
      subThreadPatchIssue(base, dedicated({ cwd: '/home/alex/talos-repo' }), { macSupports: true, sharedFolder: true }),
    ).toMatch(/inside its parent/)
    for (const cwd of ['/home/alex/code/../code', '/home/alex/./code'])
      expect(subThreadPatchIssue(base, dedicated({ cwd }), { ...shares, ownFolder: false })).toMatch(
        /inside its parent/,
      )
  })
  it('folderSame wants both paths absolute, and no . or .. in the child (the Mac says the same)', () => {
    expect(folderSame('/a/b', '/a/b/')).toBe(true)
    expect(folderSame('a/b', 'a/b')).toBe(false)
    expect(folderSame('/a/b', 'a/b')).toBe(false)
    expect(folderSame('/a/./b', '/a/b')).toBe(false)
    expect(folderSame('/a/../a/b', '/a/b')).toBe(false)
  })
  it("is for a dedicated sub-thread only: one sharing its parent's session still may not name the same folder", () => {
    const shared = withThreads([project, { ...docs, session_opts: { cwd: '/home/alex/code' } }])
    expect(subThreadPatchIssue(base, shared, shares)).toMatch(/inside its parent/)
  })
  it('still narrows the MCP list to the parent', () => {
    expect(subThreadPatchIssue(base, dedicated({ mcp_allow: ['gmail'] }), shares)).toMatch(/"gmail"/)
  })
  it('warns once for a dedicated child with no folder or the same folder, and not for one inside or own', () => {
    expect(subThreadWarnings(dedicated())).toEqual([line])
    expect(subThreadWarnings(dedicated({ cwd: '/home/alex/code/' }))).toEqual([line])
    expect(subThreadWarnings(dedicated({ cwd: '/home/alex/code/docs' }))).toEqual([])
    expect(subThreadWarnings(withThreads([project, docs]))).toEqual([]) // shares the parent's session: nothing new
    expect(subThreadWarnings(withThreads([project, { ...docs, session: 'dedicated', archived: true }]))).toEqual([])
    // no parent folder at all: both run in the agent folder, which is still the same folder
    expect(
      subThreadWarnings(
        withThreads([
          { id: 'project', name: 'Project' },
          { ...docs, session: 'dedicated' },
        ]),
      ),
    ).toEqual([line])
  })
})

describe('effectiveSessionOpts', () => {
  it('fills what the sub-thread left unset from its parent, and says which', () => {
    const cfg = withThreads([
      { ...project, session_opts: { ...project.session_opts, model: 'opus', effort: 'high', ops_read: true } },
      { ...docs, session_opts: { cwd: '/home/alex/code/docs', model: 'inherit' } },
    ])
    const eff = effectiveSessionOpts(cfg, 'docs')
    expect(eff).toMatchObject({
      cwd: '/home/alex/code/docs',
      model: 'opus',
      effort: 'high',
      mcp_allow: ['github', 'linear'],
    })
    expect(eff.inherited).toEqual(['model', 'effort', 'mcp_allow'])
    expect(eff).not.toHaveProperty('ops_read')
  })

  it("keeps the sub-thread's own values, an empty MCP list included", () => {
    const cfg = withThreads([project, { ...docs, session_opts: { model: 'haiku', mcp_allow: [] } }])
    expect(effectiveSessionOpts(cfg, 'docs')).toMatchObject({ model: 'haiku', mcp_allow: [], cwd: '/home/alex/code' })
    expect(effectiveSessionOpts(cfg, 'docs').inherited).toEqual(['cwd'])
  })

  it('inherits nothing from an archived or missing parent, and fails closed on MCP servers', () => {
    for (const cfg of [withThreads([{ ...project, archived: true }, docs]), withThreads([docs])]) {
      expect(parentThread(cfg, 'docs')).toBeUndefined()
      expect(effectiveSessionOpts(cfg, 'docs')).toEqual({
        model: 'inherit',
        inherited: [],
        mcp_allow: [],
        orphaned: true,
      })
    }
    // its own list still stands
    const own = withThreads([
      { ...project, archived: true },
      { ...docs, session_opts: { mcp_allow: ['github'] } },
    ])
    expect(effectiveSessionOpts(own, 'docs').mcp_allow).toEqual(['github'])
  })

  it('does not call a sub-thread orphaned when its live parent simply has no session settings', () => {
    const cfg = withThreads([{ id: 'project', name: 'Project' }, docs])
    expect(effectiveSessionOpts(cfg, 'docs')).toEqual({ model: 'inherit', inherited: [] })
  })

  it('treats a thread that is its own parent, or one under a sub-thread, as having none (hand edits only)', () => {
    const self = withThreads([{ ...docs, parent_id: 'docs' }])
    expect(effectiveSessionOpts(self, 'docs')).toMatchObject({ orphaned: true, mcp_allow: [] })
    // a loop drops even its own list, as the Mac app does
    const selfWithList = withThreads([{ ...docs, parent_id: 'docs', session_opts: { mcp_allow: ['github'] } }])
    expect(effectiveSessionOpts(selfWithList, 'docs')).toMatchObject({
      orphaned: true,
      mcp_allow: [],
      dropped: ['github'],
    })
    const twoDeep = withThreads([project, docs, { id: 'notes', name: 'Notes', parent_id: 'docs' }])
    expect(parentThread(twoDeep, 'notes')).toBeUndefined()
    expect(effectiveSessionOpts(twoDeep, 'notes')).toMatchObject({ orphaned: true, mcp_allow: [] })
  })

  it("narrows a sub-thread's own list to its parent's, whoever wrote the config", () => {
    const cfg = withThreads([project, { ...docs, session_opts: { mcp_allow: ['github', 'gmail', 'slack'] } }])
    expect(effectiveSessionOpts(cfg, 'docs')).toMatchObject({ mcp_allow: ['github'], dropped: ['gmail', 'slack'] })
  })

  it('leaves a top-level thread alone', () => {
    const cfg = withThreads([project])
    expect(effectiveSessionOpts(cfg, 'project')).toEqual({
      model: 'inherit',
      inherited: [],
      cwd: '/home/alex/code',
      mcp_allow: ['github', 'linear'],
    })
  })

  it('lists sub-threads in config order', () => {
    const cfg = withThreads([project, docs, { id: 'site', name: 'Site', parent_id: 'project' }])
    expect(subThreadsOf(cfg, 'project').map((t) => t.id)).toEqual(['docs', 'site'])
  })
})

describe('folderInside', () => {
  it('refuses . and .. segments that could lead back out', () => {
    expect(folderInside('/home/alex/code/../other', '/home/alex/code')).toBe(false)
    expect(folderInside('/home/alex/code/.', '/home/alex/code')).toBe(false)
    expect(folderInside('/home/alex/code/./docs', '/home/alex/code')).toBe(false)
  })
  it('is strict and ignores trailing slashes', () => {
    expect(folderInside('/home/alex/a/b', '/home/alex/a/')).toBe(true)
    expect(folderInside('/home/alex/a/', '/home/alex/a')).toBe(false)
    expect(folderInside('/home/alex/ab', '/home/alex/a')).toBe(false)
  })
})

describe('who answers a sub-thread, and where a lead may post and read', () => {
  const lanes = () =>
    AgentConfig.parse({
      ...withThreads([]),
      dedicated: { enabled: true },
      threads: [
        ...withThreads([]).threads,
        ...[
          { id: 'trip', name: 'Trip', session: 'dedicated' },
          { id: 'packing', name: 'Packing', parent_id: 'trip' },
          { id: 'visas', name: 'Visas', parent_id: 'trip', session: 'dedicated' },
          { id: 'old', name: 'Old', parent_id: 'trip', archived: true },
          { id: 'notes', name: 'Notes' },
          { id: 'drafts', name: 'Drafts', parent_id: 'notes' },
        ].map((t) => ({ kind: 'fixed', created_at: '2026-01-01T00:00:00Z', ...t })),
      ],
    })

  it("sends a sub-thread without its own lead to its parent's lead, and nothing else", () => {
    const cfg = lanes()
    expect(leadThreadFor(cfg, 'trip')).toBe('trip')
    expect(leadThreadFor(cfg, 'packing')).toBe('trip')
    expect(leadThreadFor(cfg, 'visas')).toBe('visas')
    expect(leadThreadFor(cfg, 'old')).toBeUndefined()
    expect(leadThreadFor(cfg, 'drafts')).toBeUndefined() // its parent has no lead: main answers
    expect(leadThreadFor({ ...cfg, dedicated: { enabled: false } }, 'packing')).toBeUndefined()
    // main's front doors are main's, whatever their parent (only a hand edit makes this)
    const general = { ...cfg, threads: cfg.threads.map((t) => (t.id === 'general' ? { ...t, parent_id: 'trip' } : t)) }
    expect(leadThreadFor(general, 'general')).toBeUndefined()
    expect(leadPostThreads(general, 'trip')).toEqual(['trip', 'packing'])
    expect(leadReadThreads(general, 'trip')).toEqual(['trip', 'packing', 'visas', 'old'])
  })

  it('lets a lead post in its own thread and the live sub-threads it answers, never a led or archived one', () => {
    const cfg = lanes()
    expect(leadPostThreads(cfg, 'trip')).toEqual(['trip', 'packing'])
    expect(leadPostThreads(cfg, 'visas')).toEqual(['visas'])
    expect(leadPostThreads(cfg, 'notes')).toEqual([])
  })

  it('lets a parent lead read every sub-thread, and a sub-thread lead only its own', () => {
    const cfg = lanes()
    expect(leadReadThreads(cfg, 'trip')).toEqual(['trip', 'packing', 'visas', 'old'])
    expect(leadReadThreads(cfg, 'visas')).toEqual(['visas'])
    expect(leadReadThreads(cfg, 'notes')).toEqual([])
  })
})
