// In-memory SearchClient + MemoryClient for fakeClient (VITE_FAKE=1 and the web tests). Generic content only.
import { foldForSearch, type MemoryEntryT, type MessageT, ownValue, type SearchHitT } from '@talos-app/protocol'
import { TalosClientError } from './client.ts'
import type { FolderClient, MemoryClient, SearchClient, SpeakClient } from './v2Client.ts'

/** Marks (start, end) in `text` for each folded term, mapped back to original string offsets. */
function marksFor(text: string, terms: string[]): Array<[number, number]> {
  let folded = ''
  const map: number[] = []
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i) ?? 0
    const ch = String.fromCodePoint(cp)
    const f = foldForSearch(ch)
    for (let k = 0; k < f.length; k++) map.push(i)
    folded += f
    i += ch.length
  }
  const out: Array<[number, number]> = []
  for (const t of terms) {
    let from = 0
    for (;;) {
      const at = folded.indexOf(t, from)
      if (at < 0 || out.length >= 20) break
      const start = map[at] ?? 0
      const endIdx = at + t.length
      const end = endIdx >= map.length ? text.length : (map[endIdx] ?? text.length)
      out.push([start, end])
      from = at + t.length
    }
  }
  return out.sort((a, b) => a[0] - b[0])
}

const termsOf = (q: string) => foldForSearch(q).split(/\s+/).filter(Boolean)

function checkQuery(q: string) {
  if (!q.trim()) throw new TalosClientError('bad_query', 'Type something to search for.')
}

export function createFakeSearch(deps: {
  messages: () => Record<string, MessageT[]>
  macOnline: () => boolean
}): SearchClient {
  const all = () =>
    Object.values(deps.messages())
      .flat()
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
  return {
    async search({ q, filters, sort, limit }) {
      if (!deps.macOnline()) throw new TalosClientError('mac_offline')
      checkQuery(q)
      const terms = termsOf(q)
      const after = filters.after ? Date.parse(filters.after) : null
      const before = filters.before ? Date.parse(filters.before) : null
      let rows = all().filter((m) => {
        if (filters.thread_ids.length > 0 && !filters.thread_ids.includes(m.thread_id)) return false
        if (filters.from === 'owner' && m.author !== 'owner') return false
        if (filters.from === 'agent' && m.author === 'owner') return false
        const t = Date.parse(m.created_at)
        if (after !== null && t < after) return false
        if (before !== null && t > before) return false
        const folded = foldForSearch(m.text ?? '')
        return terms.every((term) => folded.includes(term))
      })
      if (sort === 'newest') rows = rows.reverse()
      const hits: SearchHitT[] = rows.slice(0, limit).map((m) => {
        const text = m.text ?? ''
        return {
          message_id: m.id,
          thread_id: m.thread_id,
          seq: m.seq ?? null,
          author: m.author,
          kind: m.kind,
          via: m.via,
          created_at: m.created_at,
          match_in: 'text' as const,
          snippet: text.slice(0, 320),
          marks: marksFor(text.slice(0, 320), terms),
        }
      })
      return { hits, nextCursor: null, totalEstimate: rows.length, index: 'ready' as const }
    },
    async context(threadId, args) {
      const list = (ownValue(deps.messages(), threadId) ?? []).slice()
      const id = args.aroundId ?? args.beforeId ?? args.afterId
      const i = list.findIndex((m) => m.id === id)
      if (i < 0) return { messages: [], hasMore: false, hasNewer: false }
      let from = 0
      let to = list.length
      if (args.aroundId) {
        from = Math.max(0, i - 10)
        to = Math.min(list.length, i + 11)
      } else if (args.beforeId) {
        from = Math.max(0, i - 20)
        to = i
      } else {
        from = i + 1
        to = Math.min(list.length, i + 21)
      }
      return { messages: list.slice(from, to), hasMore: from > 0, hasNewer: to < list.length }
    },
  }
}

const TREE: Record<string, string> = {
  'todo.md': '# Todo\n\nBuy groceries, call the plumber, and water the plants.\n\nSee [[ideas]].\n',
  'ideas.md': '# Ideas\n\nA small garden journal. Notes on herbs and tomatoes.\n',
  'projects/plan.md': '# Plan\n\nDraft the outline, review it, then publish.\n',
}

export function createFakeMemory(deps: { macOnline: () => boolean }): MemoryClient {
  const gate = () => {
    if (!deps.macOnline()) throw new TalosClientError('mac_offline')
  }
  const titleOf = (body: string) => /^#\s+(.+)$/m.exec(body)?.[1] ?? ''
  return {
    async tree(rootId, path) {
      gate()
      if (rootId === null) {
        return {
          roots: [{ id: 'notes', label: 'Notes', files: Object.keys(TREE).length }],
          entries: [],
          nextCursor: null,
        }
      }
      if (rootId !== 'notes') throw new TalosClientError('memory_not_found')
      const prefix = path === '' ? '' : `${path.replace(/\/$/, '')}/`
      const entries = new Map<string, MemoryEntryT>()
      for (const [p, body] of Object.entries(TREE)) {
        if (!p.startsWith(prefix)) continue
        const rest = p.slice(prefix.length)
        const slash = rest.indexOf('/')
        if (slash >= 0) {
          const name = rest.slice(0, slash)
          entries.set(name, { name, path: `${prefix}${name}`, type: 'dir' })
        } else {
          entries.set(rest, {
            name: rest,
            path: p,
            type: 'file',
            size: body.length,
            mtime: '2026-10-28T15:00:00.000Z',
            title: titleOf(body),
            previewable: true,
          })
        }
      }
      if (path !== '' && entries.size === 0) throw new TalosClientError('memory_not_found')
      const list = [...entries.values()].sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
      )
      return { entries: list, nextCursor: null }
    },
    async read(rootId, path, offset) {
      gate()
      const body = rootId === 'notes' ? TREE[path] : undefined
      if (body === undefined) throw new TalosClientError('memory_not_found')
      const text = body.slice(offset)
      return {
        text,
        mime: 'text/markdown',
        size: body.length,
        mtime: '2026-10-28T15:00:00.000Z',
        sha256: '0'.repeat(64),
        nextOffset: null,
        ...(offset === 0 && body.includes('[[ideas]]')
          ? { links: [{ text: 'ideas', root_id: 'notes', path: 'ideas.md' }] }
          : {}),
      }
    },
    async search(q, rootIds, _cursor, limit) {
      gate()
      checkQuery(q)
      const terms = termsOf(q)
      const hits = Object.entries(TREE)
        .filter(([, body]) => terms.every((t) => foldForSearch(body).includes(t)))
        .slice(0, limit)
        .map(([path, body]) => ({
          root_id: 'notes',
          path,
          title: titleOf(body),
          snippet: body.slice(0, 320),
          marks: marksFor(body.slice(0, 320), terms),
          mtime: '2026-10-28T15:00:00.000Z',
        }))
      return {
        hits: rootIds.length > 0 && !rootIds.includes('notes') ? [] : hits,
        nextCursor: null,
        index: 'ready' as const,
      }
    },
  }
}

/**
 * Read aloud as a Mac with no voice command would answer it: a message that is not an agent message of that thread is not found,
 * the first ask is 'working', the next is the plain-words no_tts failure. Mac offline rejects like the socket client does.
 */
export function createFakeSpeak(deps: {
  messages: () => Record<string, MessageT[]>
  macOnline: () => boolean
}): SpeakClient {
  const asked = new Set<string>()
  return {
    async request({ messageId, threadId, fresh }) {
      if (!deps.macOnline()) throw new TalosClientError('mac_offline')
      const m = Object.values(deps.messages())
        .flat()
        .find((x) => x.id === messageId)
      if (!m || m.thread_id !== threadId || m.author !== 'agent' || !m.text) {
        return {
          state: 'failed',
          reason: 'not_found',
          message: 'That message is no longer on your Mac, so it cannot be read aloud.',
        }
      }
      if (fresh) asked.delete(messageId)
      if (!asked.has(messageId)) {
        asked.add(messageId)
        return { state: 'working', waitS: 5 }
      }
      return {
        state: 'failed',
        reason: 'no_tts',
        message:
          'Your Mac has no voice set up yet. Set TALOS_APP_TTS_CMD in bridge.env to a text-to-speech command and restart Talos.',
      }
    },
  }
}

/** What a fake Mac's folders look like: a home, an agent folder, and the folder names under each path (dot-folders included). */
export type FakeFolderTree = { home: string; agentDir?: string; tree: Record<string, string[]> }

export type FakeFolders = FolderClient & {
  /** The next `list` rejects with the Mac's one refusal sentence (or this text), then behaves again. */
  failNextWith(message: string): void
  /** Replaces the folder names under `path`. */
  setTree(path: string, names: string[]): void
  /** Says `n` more folders under `path` were not sent. */
  setMore(path: string, n: number): void
  /** Every `list` call, in order, for tests. */
  readonly calls: Array<{ path: string | null; hidden: boolean }>
}

/**
 * The folder picker's Mac as a fake: lists what `tree` holds, hides dot-folders unless asked, refuses a path that is not in
 * the tree with the Mac's sentence, and rejects like the socket client does with the Mac away. Generic made-up folders only.
 */
export function createFakeFolders(deps: { macOnline: () => boolean }, seed: FakeFolderTree): FakeFolders {
  const tree: Record<string, string[]> = { ...seed.tree }
  const more: Record<string, number> = {}
  const calls: FakeFolders['calls'] = []
  let failNext: string | null = null
  const base = { home: seed.home, ...(seed.agentDir ? { agentDir: seed.agentDir } : {}) }
  return {
    calls,
    failNextWith(message) {
      failNext = message
    },
    setTree(path, names) {
      tree[path] = names
    },
    setMore(path, n) {
      more[path] = n
    },
    async list(path, hidden) {
      calls.push({ path, hidden })
      if (!deps.macOnline()) throw new TalosClientError('mac_offline')
      if (failNext !== null) {
        const message = failNext
        failNext = null
        throw new TalosClientError('bad_frame', message)
      }
      if (path === null) return { ...base, parent: null, entries: [], more: 0 }
      const names = tree[path.replace(/\/+$/, '') || '/']
      if (!names) throw new TalosClientError('bad_frame', "That folder can't be opened.")
      const shown = names
        .filter((n) => hidden || !n.startsWith('.'))
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      const cut = path.lastIndexOf('/')
      return {
        ...base,
        path,
        parent: path === seed.home ? null : cut <= 0 ? '/' : path.slice(0, cut),
        entries: shown,
        more: more[path] ?? 0,
      }
    },
  }
}
