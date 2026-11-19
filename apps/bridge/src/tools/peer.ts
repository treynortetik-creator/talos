// `peer_send` (docs/LINKED-AGENTS.md): the main session sends a message to the owner's other Talos install. The checks and the
// outbox are in ../peer/service.ts; this is the record and who may call it. Main only: a thread's own session never gets it.
import { PEER_LABELS, PEER_TEXT_MAX_BYTES } from '@talos-app/protocol'
import { threadRef } from '../context.ts'
import { fail, ok, str, threadArg } from './common.ts'
import { NOT_FOR_WORKERS, type ToolRecord } from './define.ts'

export const peerSendTool: ToolRecord = {
  name: 'peer_send',
  group: 'handoff',
  headless: false,
  ...NOT_FOR_WORKERS,
  instructions: `\`peer_send\` messages a linked agent (the owner's other Talos), by the name in a peer_message's \`peer\` meta or the one the owner gives. Label a fresh request TASK, an answer RESULT (it ends the exchange: nothing replies to a RESULT) and a need for the owner BLOCK; answer a peer_message by passing its \`peer_msg_id\` as \`in_reply_to\`, and only to the peer it came from. It queues at once; the text is scrubbed of secrets first.`,
  told: ['main'],
  description: `Send a message to a linked agent (the owner's other Talos install). peer: its configured name. text: at most ${PEER_TEXT_MAX_BYTES} bytes, scrubbed of secrets before it leaves. label: TASK, RESULT or BLOCK. in_reply_to: the peer_msg_id of a peer_message you are answering (only to the peer it came from; a RESULT is never answered; an exchange stops after a few turns). It queues at once and is delivered in the background. Only the owner links a peer, at the computer. Finances, health and family content do not go to a peer unless the owner asks.`,
  inputSchema: {
    type: 'object',
    properties: {
      peer: { type: 'string', description: "The linked agent's configured name." },
      text: { type: 'string', description: `The message (at most ${PEER_TEXT_MAX_BYTES} bytes).` },
      label: { type: 'string', enum: [...PEER_LABELS] },
      in_reply_to: { type: 'string', description: 'The peer_msg_id of the peer_message you are answering.' },
      thread_id: {
        type: 'string',
        description: 'The thread the owner sees the "Sent to" row in (default: the default thread).',
      },
    },
    required: ['peer', 'text'],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    if (ctx.worker || ctx.mode !== 'live' || ctx.superseded || !ctx.peers)
      return fail('peer_send needs the live main session.')
    const peer = str(args.peer)
    const text = str(args.text)
    if (!peer) return fail('peer is required')
    if (text === undefined || text === '') return fail('text is required')
    const label = str(args.label)
    if (label !== undefined && !(PEER_LABELS as readonly string[]).includes(label))
      return fail(`label must be one of ${PEER_LABELS.join(', ')}`)
    const thread = str(args.thread_id) ? threadRef(ctx, threadArg(ctx, { thread_id: args.thread_id })) : undefined
    const r = await ctx.peers.send({
      peer,
      text,
      label: label as (typeof PEER_LABELS)[number] | undefined,
      in_reply_to: str(args.in_reply_to),
      thread,
    })
    return r.ok ? ok(r.text) : fail(r.text)
  },
}
