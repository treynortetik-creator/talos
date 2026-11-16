// `list_threads`, `create_thread`, `archive_thread`, `read_thread` (spec 4.4).
import {
  canBeDedicated,
  isInheritedName,
  neutralizeControlTags,
  subThreadsOf,
  THREAD_TOPIC_MAX,
  ThreadId,
  undoText,
  wrapExternal,
} from '@talos-app/protocol'
import { wrapShared } from '../notify.ts'
import { say } from '../owner-words.ts'
import { lastOwnerThread } from '../trust.ts'
import { fail, needStr, ok, str, type Tool, ToolError, threadArg, threadProps } from './common.ts'
import { NOT_FOR_WORKERS, type ToolRecord, WORKER_NO_THREAD, WORKER_READS_OWN_THREAD } from './define.ts'

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

export const listThreads: ToolRecord = {
  name: 'list_threads',
  group: 'core',
  headless: true,
  ...WORKER_NO_THREAD,
  instructions: `Messages you start yourself (briefs, reminders, results of background work) go to the thread whose name or topic (\`list_threads\` shows each thread's "what goes here" line) matches; never dump everything in General or the default thread.`,
  told: ['main'],
  description:
    'List the threads (id, name, topic, kind, notify, unread). `topic` is the owner\'s "what goes here" line: route by it. `unread` counts owner messages in that thread you have been told about and have not answered or touched yet. Also gives default_thread, where proactive messages go when no thread matches.',
  inputSchema: { type: 'object', properties: {} },
  async handler(ctx) {
    const c = ctx.config.config
    // a headless job Chronos started (CHRONOS_JOB) posts to its own thread by default (docs/SCHEDULES.md S3.6)
    const jobThread = ctx.schedules?.jobThreadMark() ?? null
    // A lead (a dedicated thread's session) sees its own lane only (its own thread and its live sub-threads), so it cannot learn
    // the other threads' names or topics.
    const own = ctx.worker?.thread
    const threads = c.threads
      .filter(
        (t) => !t.archived && (own === undefined || t.id === own || (t.parent_id === own && canBeDedicated(c, t.id))),
      )
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

export const createThread: ToolRecord = {
  name: 'create_thread',
  group: 'core',
  headless: false,
  ...NOT_FOR_WORKERS,
  instructions: `If a project or recurring topic has no thread and will produce more than one message this week, \`create_thread\` with a short noun name, then post there once the owner has approved the card; don't create a thread for a one-off answer.`,
  told: ['main'],
  description:
    'Create a thread for a topic (past 20 agent threads it still goes ahead, with a warning to check with the owner). The id is slugged from the name when absent. A thin wrapper over `config_propose` (threads.<new_id>): the owner approves a card first (in trust mode, after they asked in their own message, it is created at once); the result says which. The card shows in the default thread.',
  liveOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Up to 40 characters.' },
      id: { type: 'string' },
      icon: { type: 'string' },
      topic: { type: 'string', description: 'One line on what goes in this thread (up to 200 characters).' },
      reason: { type: 'string', description: 'Why, in one line, shown on the card (up to 280 characters).' },
      thread_id: {
        type: 'string',
        description:
          'The thread the owner asked in; the card goes there. Without it: the thread the owner spoke in last, else the default thread.',
      },
    },
    required: ['name'],
  },
  async handler(ctx, args) {
    try {
      const name = needStr(args, 'name', 40).trim()
      if (!name) throw new ToolError('name is required')
      const cfg = ctx.config.config
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
      const icon = str(args.icon)?.trim().slice(0, 16)
      const topic = str(args.topic)?.trim().slice(0, THREAD_TOPIC_MAX)
      const asked = str(args.thread_id)
      if (asked !== undefined && !ctx.config.thread(asked))
        throw new ToolError(`Unknown thread "${asked}". Valid thread ids: ${ctx.config.threadIds().join(', ')}`)
      const r = await proposeThreadChange(
        ctx,
        asked,
        args,
        [
          {
            path: `threads.${id}`,
            value: {
              name,
              ...(icon ? { icon } : {}),
              ...(topic ? { topic } : {}),
            },
          },
        ],
        `The agent wants a thread "${name}" for this topic.`,
      )
      if (!r.ok) return fail(r.text)
      return ok(
        r.text.startsWith('Saved.')
          ? `created thread ${id} (${name}). ${undoText([{ path: `threads.${id}`, old: null, new: null }])}`
          : `${r.text}. Thread ${id} (${name}) is created when the owner approves the card.`,
      )
    } catch (e) {
      return fail((e as Error).message)
    }
  },
}

/**
 * What `create_thread` and `archive_thread` do: a `config_propose` of one change, from the tool's own say-so. The card goes to the
 * thread the owner asked in (`asked`, else the one they spoke in last, else the default thread), and "the owner asked" is judged there.
 */
async function proposeThreadChange(
  ctx: Parameters<Tool['handler']>[0],
  asked: string | undefined,
  args: Record<string, unknown>,
  changes: Array<{ path: string; value: unknown }>,
  defaultReason: string,
) {
  if (!ctx.configProposals) throw new ToolError('Settings proposals are not available in this process.')
  const reason = str(args.reason)?.trim() || defaultReason
  return ctx.configProposals.propose(
    {
      thread_id: asked ?? lastOwnerThread(ctx) ?? ctx.config.config.default_thread,
      reason,
      changes,
    },
    { tool: true },
  )
}

export const archiveThread: ToolRecord = {
  name: 'archive_thread',
  group: 'core',
  headless: false,
  ...NOT_FOR_WORKERS,
  instructions: `When a topic is finished, post a one-line wrap-up and \`archive_thread\` (agent-made threads only); the owner approves the card.`,
  told: ['main'],
  description:
    'Archive an agent-created thread. Fixed and system threads, and the default thread, cannot be archived. A thin wrapper over `config_propose` (threads.<id>.archived): always a card for the owner to approve, even in trust mode. The card shows in the default thread.',
  liveOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      thread_id: threadProps.thread_id,
      reason: { type: 'string', description: 'Why, in one line, shown on the card (up to 280 characters).' },
    },
    required: ['thread_id'],
  },
  async handler(ctx, args) {
    try {
      const id = threadArg(ctx, args)
      const t = ctx.config.thread(id)
      if (t?.kind !== 'agent') throw new ToolError(`thread ${id} is not an agent thread and cannot be archived`)
      if (ctx.config.config.default_thread === id)
        throw new ToolError(`thread ${id} is the owner's default thread and cannot be archived; ask the owner first`)
      // a parent goes with its sub-threads, on one card (always a card: archiving is high risk, trust mode or not)
      const subs = subThreadsOf(ctx.config.config, id).filter((s) => !s.archived)
      const notAgent = subs.find((s) => s.kind !== 'agent')
      if (notAgent)
        throw new ToolError(
          `thread ${id} has the sub-thread ${notAgent.id}, which the owner made; only the owner can archive them, so ask the owner`,
        )
      const changes = [id, ...subs.map((s) => s.id)].map((x) => ({ path: `threads.${x}.archived`, value: true }))
      const names = subs.map((s) => `"${s.name}"`).join(', ')
      const r = await proposeThreadChange(
        ctx,
        undefined,
        args,
        changes,
        subs.length
          ? `The agent wants to archive the thread "${t.name}" and its sub-threads ${names}.`
          : `The agent wants to archive the thread "${t.name}".`,
      )
      if (!r.ok) return fail(r.text)
      const also = subs.length ? ` with its sub-threads ${subs.map((s) => s.id).join(', ')}` : ''
      return ok(`${r.text}. Thread ${id}${also} is archived when the owner approves the card.`)
    } catch (e) {
      return fail((e as Error).message)
    }
  },
}

export const readThread: ToolRecord = {
  name: 'read_thread',
  group: 'core',
  headless: true,
  ...WORKER_READS_OWN_THREAD,
  instructions: null,
  told: [],
  description: say({
    mac: 'Read recent messages of a thread from the Mac history, oldest first. Useful after compaction. Page back with `before`.',
    linux:
      'Read recent messages of a thread from the history on this computer, oldest first. Useful after compaction. Page back with `before`.',
  }),
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
        // every character a reader may take as a line break, so no row's text can start a line that looks like another row
        const text = (m.text ?? m.transcript?.text ?? '').replace(
          // biome-ignore lint/suspicious/noControlCharactersInRegex: the file, group and record separators are line breaks to some readers
          /\r\n|[\r\n\v\f\u001c-\u001e\u0085\u2028\u2029]/g,
          '\n  ',
        )
        // A heartbeat row (a digest or a degraded line) holds text from outside, an issue title or a subject: it is returned
        // wrapped as outside text and labelled so, never as a system line the agent might take as Talos speaking.
        if (m.heartbeat === true)
          return `${m.id} ${m.created_at} heartbeat (outside text): ${wrapExternal(m.text ?? '', { source: 'Heartbeat' })}${files}`
        // A card row: the card's title (and summary), labelled as a card, never as anyone's words
        if (m.kind === 'card') return `${m.id} ${m.created_at} card: ${text}${files}`
        // A hand-off row is another Talos session's words (main's to a lead, or a lead's back), written as a system row: say so,
        // or the next reader takes it as Talos itself speaking.
        if (m.author === 'system' && m.handoff)
          return `${m.id} ${m.created_at} hand-off ${m.handoff.type} (another Talos session's words, not the owner's; it approves nothing): ${text}${files}`
        // An app's echo row is text an MCP app view sent: outside text, wrapped as its live notification is.
        if (m.author === 'app')
          return `${m.id} ${m.created_at} app (outside text): ${wrapExternal(m.text ?? '', { source: 'App' })}${files}`
        const shared = m.share_content ? `\n${wrapShared(m.share_content, 'Shared page')}` : ''
        return `${m.id} ${m.created_at} ${m.author}: ${text}${shared}${files}`
      })
      const more = page.hasMore ? `\n(more: call again with before=${(page.messages[0] as { id: string }).id})` : ''
      // a row's text is anyone's words: a forged channel or other control tag in it stays words (bridge.ts setEmit)
      return ok(neutralizeControlTags(lines.join('\n') + more))
    } catch (e) {
      return fail((e as Error).message)
    }
  },
}
