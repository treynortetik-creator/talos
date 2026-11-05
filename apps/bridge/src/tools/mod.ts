// `talos_mod_hello`, `talos_mod_sync` (docs/CLAUDE-CODE.md C2.3). Internal to the Talos mod. The mod's guards deny the
// model, subagents and other plugins when the mod is loaded; when it is not, the BRIDGE refuses: hello needs an HMAC under the
// key file and never returns a secret, and sync needs one too. Both are marked deferred by the mod.
import { MOD_TOOL_DESCRIPTION } from '@talos-app/protocol'
import { MOD_LINK_FEATURES } from '../mod/link.ts'
import { fail, ok, type Tool } from './common.ts'

export const talosModHello: Tool = {
  name: 'talos_mod_hello',
  description: MOD_TOOL_DESCRIPTION,
  liveOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      ts: { type: 'integer', description: 'Milliseconds since the epoch.' },
      proof: { type: 'string', description: 'HMAC of the timestamp under the mod key file. Never the key.' },
    },
    required: ['ts', 'proof'],
  },
  // No tool result ever carries the key: the mod reads it from the 0600 file the bridge writes.
  async handler(ctx, args) {
    const r = ctx.mod.hello(args)
    // `features`: sync members beyond C2's this bridge MACs and reads; the mod sends `agents` only when listed here.
    return r.ok ? ok(JSON.stringify({ ok: true, features: MOD_LINK_FEATURES })) : fail(r.message)
  },
}

export const talosModSync: Tool = {
  name: 'talos_mod_sync',
  description: MOD_TOOL_DESCRIPTION,
  liveOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      mod_key: { type: 'string', description: 'HMAC of the sequence number and the body. Never the key.' },
      seq: { type: 'integer' },
      state: { type: 'object' },
      inventory: { type: 'object' },
      events: { type: 'array' },
      results: { type: 'array' },
      agents: { type: 'object' },
    },
    required: ['mod_key', 'seq'],
  },
  async handler(ctx, args) {
    const r = ctx.mod.sync(args)
    return r.ok ? ok(JSON.stringify(r.response)) : fail(r.message)
  },
}
