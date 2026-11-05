// `list_threads`, `create_thread`, `archive_thread`, `read_thread` (spec 4.4).
import { isInheritedName, THREAD_TOPIC_MAX, ThreadId, type ThreadT, trustOn, wrapExternal } from '@talos-app/protocol'
import { configSyncFrame, threadArchiveFrame, threadUpsertFrame } from '../frames-out.ts'
import { wrapShared } from '../notify.ts'
import { fail, needStr, ok, str, type Tool, ToolError, threadArg, threadProps } from './common.ts'

const MAX_AGENT_THREADS = 20
/** The config schema's own limit on `threads`, trust mode or not. */
const MAX_THREADS_TOTAL = 40

export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  const base = /^[a-z]/.test(s) ? s : `t_${s}`
  const id = base.slice(0, 32).replace(/_+$/, '') || 'thread'
  return isInheritedName(id) ? `${id}_thread` : id
}

export const listThreads: Tool = {
  name: 'list_threads',
  description:
    'List the threads (id, name, topic, kind, notify, unread). `topic` is the owner\'s "what goes here" line: route by it. `unread` counts owner messages in that thread you have been told about and have not answered or touched yet. Also gives default_thread, where proactive messages go when no thread matches.',
  inputSchema: { type: 'object', properties: {} },
  async handler(ctx) {
    const c = ctx.config.config
    // a headless job Chronos started (CHRONOS_JOB) posts to its own thread by default (docs/SCHEDULES.md S3.6)
    const jobThread = ctx.schedules?.jobThreadMark() ?? null
    // A lead (a dedicated thread's session) sees its own lane only, so it cannot learn the other threads' names or topics.
    const own = ctx.worker?.thread
    const threads = c.threads
      .filter((t) => !t.archived && (own === undefined || t.id === own))
      .map((t) => ({
        id: t.id,
        name: t.id === jobThread ? `${t.name} (this job's thread)` : t.name,
        ...(t.topic ? { topic: t.topic } : {}),
        kind: t.kind,
        notify: t.notify,
        unread: ctx.seen.count(t.id),
      }))
    return ok(JSON.stringify({ default_thread: own ?? jobThread ?? c.default_thread, threads }, null, 2))
  },
}

export const createThread: Tool = {
  name: 'create_thread',
  description: 'Create a thread for a topic (agent threads, at most 20). The id is slugged from the name when absent.',
  liveOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Up to 40 characters.' },
      id: { type: 'string' },
      icon: { type: 'string' },
      topic: { type: 'string', description: 'One line on what goes in this thread (up to 200 characters).' },
    },
    required: ['name'],
  },
  async handler(ctx, args) {
    try {
      const name = needStr(args, 'name', 40).trim()
      if (!name) throw new ToolError('name is required')
      const cfg = ctx.config.config
      // Trust mode lifts the twenty-thread limit; the config's own limit (the schema's 40 threads in all) still holds.
      if (!trustOn(cfg) && cfg.threads.filter((t) => t.kind === 'agent' && !t.archived).length >= MAX_AGENT_THREADS)
        throw new ToolError(`at most ${MAX_AGENT_THREADS} agent threads; archive one first`)
      if (cfg.threads.length >= MAX_THREADS_TOTAL)
        throw new ToolError(
          `at most ${MAX_THREADS_TOTAL} threads in all, archived ones included, so archiving does not make room`,
        )
      const taken = new Set(cfg.threads.map((t) => t.id))
      let id = str(args.id)
      if (id !== undefined) {
        if (!ThreadId.safeParse(id).success)
          throw new ToolError('id must match ^[a-z][a-z0-9_]{0,31}$ and not be "all"')
        if (id.startsWith('talos__'))
          throw new ToolError('ids starting with "talos__" are reserved for the app; pick another')
        if (isInheritedName(id)) throw new ToolError(`id "${id}" is a name every object already has; pick another`)
        if (taken.has(id)) throw new ToolError(`thread id "${id}" is already taken`)
      } else {
        const base = slugify(name)
        id = base
        for (let n = 2; taken.has(id) || id === 'all'; n++) id = `${base.slice(0, 29)}_${n}`
      }
      const icon = str(args.icon)
      const topic = str(args.topic)?.trim().slice(0, THREAD_TOPIC_MAX)
      const thread: ThreadT = {
        id,
        name,
        ...(icon ? { icon: icon.slice(0, 16) } : {}),
        ...(topic ? { topic } : {}),
        kind: 'agent',
        order: Math.max(0, ...cfg.threads.map((t) => t.order)) + 1,
        notify: 'all',
        voice_context: 'recent',
        archived: false,
        created_at: new Date(ctx.clock.now()).toISOString(),
      }
      const next = ctx.config.update((c) => ({ ...c, threads: [...c.threads, thread] }))
      const now = ctx.clock.now()
      await ctx.transport.sendDurable(threadUpsertFrame(now, thread))
      await ctx.transport.sendDurable(configSyncFrame(now, next))
      ctx.config.markSynced(next)
      return ok(`created thread ${id} (${name})`)
    } catch (e) {
      return fail((e as Error).message)
    }
  },
}

export const archiveThread: Tool = {
  name: 'archive_thread',
  description: 'Archive an agent-created thread. Fixed and system threads, and the default thread, cannot be archived.',
  liveOnly: true,
  inputSchema: { type: 'object', properties: { thread_id: threadProps.thread_id }, required: ['thread_id'] },
  async handler(ctx, args) {
    try {
      const id = threadArg(ctx, args)
      const t = ctx.config.thread(id)
      if (t?.kind !== 'agent') throw new ToolError(`thread ${id} is not an agent thread and cannot be archived`)
      if (ctx.config.config.default_thread === id)
        throw new ToolError(`thread ${id} is the owner's default thread and cannot be archived; ask the owner first`)
      const next = ctx.config.update((c) => ({
        ...c,
        threads: c.threads.map((x) => (x.id === id ? { ...x, archived: true } : x)),
      }))
      const now = ctx.clock.now()
      await ctx.transport.sendDurable(threadArchiveFrame(now, id))
      await ctx.transport.sendDurable(configSyncFrame(now, next))
      ctx.config.markSynced(next)
      return ok(`archived thread ${id}`)
    } catch (e) {
      return fail((e as Error).message)
    }
  },
}

export const readThread: Tool = {
  name: 'read_thread',
  description:
    'Read recent messages of a thread from the Mac history, oldest first. Useful after compaction. Page back with `before`.',
  inputSchema: {
    type: 'object',
    properties: {
      thread_id: threadProps.thread_id,
      limit: { type: 'number', description: 'Up to 50, default 20.' },
      before: { type: 'string', description: 'A message id: return messages older than it.' },
    },
    required: ['thread_id'],
  },
  async handler(ctx, args) {
    try {
      const id = threadArg(ctx, args)
      const limit = Math.min(50, Math.max(1, Math.floor(typeof args.limit === 'number' ? args.limit : 20)))
      const before = str(args.before)
      if (before !== undefined && !/^m_[0-9A-HJKMNP-TV-Z]{26}$/.test(before))
        throw new ToolError('before must be a message id (m_...)')
      const page = ctx.store.page({ thread_id: id, limit, ...(before ? { beforeId: before } : {}) })
      if (!page.messages.length) return ok('(no messages)')
      const lines = page.messages.map((m) => {
        const n = Array.isArray(m.attachments) ? m.attachments.length : 0
        const files = n ? ` [${n} file(s)]` : ''
        // A Shortcut share (via 'share') is external end to end, its note included (docs/V2-FEATURES.md V4.7); a signed
        // /share page row keeps its typed note as owner words and shows the shared material wrapped.
        if (m.via === 'share')
          return `${m.id} ${m.created_at} share: ${wrapShared(m.share_content ?? {}, 'Shared via a share link', m.text || undefined)}${files}`
        const text = (m.text ?? m.transcript?.text ?? '').replace(/\r?\n/g, '\n  ')
        // A heartbeat row (a digest or a degraded line) holds text from outside, an issue title or a subject: it is returned
        // wrapped as outside text and labelled so, never as a system line the agent might take as Talos speaking.
        if (m.heartbeat === true)
          return `${m.id} ${m.created_at} heartbeat (outside text): ${wrapExternal(m.text ?? '', { source: 'Heartbeat' })}${files}`
        // A card row: the card's title (and summary), labelled as a card, never as anyone's words
        if (m.kind === 'card') return `${m.id} ${m.created_at} card: ${text}${files}`
        const shared = m.share_content ? `\n${wrapShared(m.share_content, 'Shared page')}` : ''
        return `${m.id} ${m.created_at} ${m.author}: ${text}${shared}${files}`
      })
      const more = page.hasMore ? `\n(more: call again with before=${(page.messages[0] as { id: string }).id})` : ''
      return ok(lines.join('\n') + more)
    } catch (e) {
      return fail((e as Error).message)
    }
  },
}
