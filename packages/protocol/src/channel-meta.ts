// Meta of `notifications/claude/channel` (spec 4.3). Keys match /^[A-Za-z0-9_]+$/ (a hyphen is silently dropped by
// Claude Code) and every value is a string. WP5 builds it, FakeClaude and the contract tests assert it, WP8 checks it.
import { z } from 'zod'
import { PeerMessageId } from './ids.ts'
import { PeerLabel, PeerName } from './peer.ts'

export const CHANNEL_NOTIFICATION_METHOD = 'notifications/claude/channel' as const

export const CHANNEL_KINDS = [
  'text',
  'file',
  'card_action',
  'hook_event',
  'hook_digest',
  'backlog',
  'system',
  // Schedules (docs/SCHEDULES.md S6.3)
  'schedule_run',
  'schedule_held',
  // Claude Code integration (docs/CLAUDE-CODE.md C4.6): the owner asked for a new session from the Sessions view
  'spawn_request',
  // v2 features (docs/V2-FEATURES.md V4.3): a row from share-to-Talos
  'share',
  // Option C hand-off between the main session and a thread lead (docs/OPTION-C.md "Hand-offs")
  'handoff',
  // A `wake_me` timer the agent set for itself firing (docs/OPTION-C.md "Wake me"): always trust=agent, never the owner's word
  'wake',
  // Linked agents (peer.ts): a message from the owner's other Talos install, always trust=external, never the owner's word
  'peer_message',
  // Setup's one hello (apps/bridge/src/onboarding-hello.ts): a fixed template the bridge itself makes, always trust=system, never the owner's word
  'onboarding',
] as const
/** `agent` is another Talos session (main or a thread lead): never the owner's word, and it approves nothing. */
export const CHANNEL_TRUSTS = ['owner', 'external', 'system', 'agent'] as const
export const ChannelKind = z.enum(CHANNEL_KINDS)
export const ChannelTrust = z.enum(CHANNEL_TRUSTS)

const PEER_META_KEYS = ['peer', 'label', 'peer_msg_id', 'in_reply_to', 'chain', 'from_peer_task'] as const
const META_KEY = /^[A-Za-z0-9_]+$/

/** Always present. Other keys (spec 4.3 table) are optional strings. */
export const ChannelMeta = z
  .object({
    chat_id: z.string(),
    thread_id: z.string(),
    thread_name: z.string(),
    message_id: z.string(),
    ts: z.string(),
    kind: ChannelKind,
    trust: ChannelTrust,
    user: z.string().optional(),
    written_at: z.string().optional(), // a re-signed owner message: when the words were first written
    run: z.enum(['tap']).optional(), // the Mac accepted this as the owner's tap on Run (run.ts); the only thing the agent trusts as one
    duration_s: z.string().optional(),
    file_path: z.string().optional(),
    file_mime: z.string().optional(),
    file_name: z.string().optional(),
    card_id: z.string().optional(),
    card_action: z.enum(['primary', 'kill', 'revise', 'expired']).optional(),
    card_edited: z.enum(['true', 'false']).optional(),
    payload_path: z.string().optional(),
    event_id: z.string().optional(),
    source: z.string().optional(),
    event_kind: z.string().optional(),
    priority: z.string().optional(),
    batch_count: z.string().optional(),
    // schedule_run / schedule_held (docs/SCHEDULES.md S2.2, S6.3)
    schedule_id: z.string().optional(),
    run_id: z.string().optional(),
    ds: z.string().optional(),
    fire_at: z.string().optional(),
    window_ends: z.string().optional(),
    // spawn_request (docs/CLAUDE-CODE.md C4.6)
    spawn_id: z.string().optional(),
    spawn_kind: z.string().optional(),
    // v2 features (docs/V2-FEATURES.md V1.3)
    driving: z.enum(['true']).optional(), // the owner is listening, not reading
    memory_path: z.string().optional(), // absolute, re-checked
    memory_root: z.string().optional(),
    memory_changed: z.enum(['true']).optional(),
    share_id: z.string().optional(),
    share_url: z.string().optional(),
    share_source: z.enum(['shortcut', 'page']).optional(),
    shared_file: z.string().optional(), // the shared-inbox file the bridge filed a token share into
    // Option C (docs/OPTION-C.md 3.3): a dedicated thread's message main answers because its own session didn't
    routed: z.enum(['fallback']).optional(),
    reason: z.string().optional(),
    // handoff: who sent it and what it asks
    handoff_type: z.enum(['TASK', 'RESULT', 'BLOCK']).optional(),
    handoff_from: z.enum(['main', 'lead']).optional(),
    // wake: which wake fired, and whose it is (main's own, a thread session's, or a thread session's that was dropped and
    // reaches main only as a report)
    wake_id: z.string().optional(),
    wake_for: z.enum(['main', 'thread', 'dropped']).optional(),
    // peer_message: `peer` is the receiver's configured name for the CONNECTION, never the sender's own `from`
    peer: PeerName.optional(),
    label: PeerLabel.optional(),
    peer_msg_id: PeerMessageId.optional(),
    in_reply_to: PeerMessageId.optional(),
    chain: z
      .string()
      .regex(/^[0-6]$/)
      .optional(), // PEER_CHAIN_MAX is 6
    from_peer_task: z.enum(['true', 'false']).optional(),
  })
  .catchall(z.string()) // file_path_2 ... file_path_10
  .superRefine((meta, ctx) => {
    for (const k of Object.keys(meta)) {
      if (!META_KEY.test(k))
        ctx.addIssue({ code: 'custom', path: [k], message: 'meta keys must match /^[A-Za-z0-9_]+$/' })
    }
    // linked agents: a peer's words are outside data, and the peer_* keys mean nothing on any other kind
    if (meta.kind === 'peer_message') {
      if (meta.trust !== 'external')
        ctx.addIssue({ code: 'custom', path: ['trust'], message: 'peer_message must be trust external' })
      for (const k of ['peer', 'peer_msg_id', 'chain'] as const)
        if (meta[k] === undefined) ctx.addIssue({ code: 'custom', path: [k], message: `peer_message needs ${k}` })
    } else {
      for (const k of PEER_META_KEYS)
        if (meta[k] !== undefined)
          ctx.addIssue({ code: 'custom', path: [k], message: `${k} is only for kind peer_message` })
    }
    // the setup hello is the bridge's own text: any other trust would make it somebody's words
    if (meta.kind === 'onboarding' && meta.trust !== 'system')
      ctx.addIssue({ code: 'custom', path: ['trust'], message: 'onboarding must be trust system' })
    if (meta.thread_id !== meta.chat_id)
      ctx.addIssue({ code: 'custom', path: ['chat_id'], message: 'chat_id must equal thread_id' })
  })
export type ChannelMetaT = z.infer<typeof ChannelMeta>

/**
 * Claude Code integration tool (docs/CLAUDE-CODE.md C4.6). `session_report` (WP-C7, agent-facing) has no tool yet. The
 * agent tools themselves, their lists and their instruction text are one table in the bridge (apps/bridge/src/tools/table.ts).
 */
export const SESSION_BRIDGE_TOOLS = ['session_report'] as const
