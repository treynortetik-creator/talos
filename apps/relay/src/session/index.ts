// Relay side of the Claude Code session frames (docs/CLAUDE-CODE.md C2.5). The relay stores nothing durable of its own
// here: it keeps the LAST session.state, session.inventory and session.list for `ready` (so a reconnecting app sees the session at
// once), fans the bridge's state out, passes control results to the apps, and queues a signed `session.control` for the
// bridge. It never reads or changes a control: the bridge verifies the owner signature and applies the command policy.
// session.agents (docs/SUBAGENTS.md) is handled exactly like session.state: the last snapshot lives in this closure and
// nowhere else (no SQLite row, no push, no log line), so a relay restart forgets it and the bridge's next send (at least
// every AGENTS_HEARTBEAT_MS) refills it. A session.state naming another session retires it, and only the validated
// fields are forwarded, so the 64 KB cap covers the whole frame.
import {
  AGENTS_FEATURE,
  MAX_THREAD_SESSION_STATES,
  newUlid,
  THREAD_SESSIONS_FEATURE,
  UNDO_FEATURE,
  USAGE_AS_OF_FEATURE,
} from '@talos-app/protocol'
import { registerRelayFeature } from '../core/features.ts'
import { findRuntime } from '../core/runtime.ts'
import type { RelayServices } from '../services.ts'

const SEEN_MAX = 500

export function register(services: RelayServices): void {
  const { bus, log } = services
  let lastState: Record<string, unknown> | undefined
  let lastInventory: Record<string, unknown> | undefined
  let lastAgents: Record<string, unknown> | undefined
  let lastList: Record<string, unknown> | undefined
  const seenResults = new Set<string>()
  const seenControls = new Set<string>()
  const remember = (set: Set<string>, id: string) => {
    set.add(id)
    if (set.size > SEEN_MAX)
      for (const k of set) {
        set.delete(k)
        break
      }
  }

  let lastWorkers: Record<string, unknown> | undefined
  const threadStates = new Map<string, Record<string, unknown>>()
  bus.readyExtra?.(() => ({
    ...(lastState ? { session_state: lastState.state } : {}),
    ...(lastInventory ? { session_inventory: lastInventory.inventory } : {}),
    ...(lastList ? { session_list: lastList.sessions } : {}),
    ...(lastAgents ? { session_agents: lastAgents.agents } : {}),
    ...(lastWorkers ? { workers_status: lastWorkers.status } : {}),
    ...(threadStates.size
      ? { thread_session_states: [...threadStates].map(([thread_id, state]) => ({ thread_id, state })) }
      : {}),
  }))

  // A Mac that drops mid-turn must not leave `busy` behind for every app that connects while it is away (bug hunt R8): the
  // session stays named, but nothing is running, and the agents, workers, session list and thread pictures are the Mac's to
  // send again (the list's rows say "working", and `ready.session_list` carries no `at` to show its age). The inventory (the
  // command list) is kept: it claims nothing is running, and the Mac only resends it every minute.
  bus.onBridgeGone?.(() => {
    const st = lastState?.state as Record<string, unknown> | undefined
    if (lastState && st) {
      const { turn_id: _turn, ...rest } = st
      lastState = { ...lastState, state: { ...rest, busy: false } }
    }
    lastAgents = undefined
    lastWorkers = undefined
    lastList = undefined
    findRuntime(services)?.sessionWait.update(undefined)
    threadStates.clear()
  })

  // Option C (docs/OPTION-C.md): the thread-session picture, kept for `ready` like session.state
  bus.onBridgeFrame('workers.status', (frame, ctx) => {
    lastWorkers = ctx.raw
    // what each session waits on, for the once-per-wait push (core/session-wait.ts)
    findRuntime(services)?.sessionWait.update(frame.status)
    return bus.toApps(ctx.raw)
  })

  bus.onBridgeFrame('session.state', (frame, ctx) => {
    // Option C: a thread session's state is kept per thread and never replaces main's
    const scope = frame.state.scope
    if (scope !== undefined && scope !== 'main') {
      const was = (threadStates.get(scope.thread_id) as { busy?: boolean } | undefined)?.busy
      if (was === true && frame.state.busy !== true) bus.settleWorking?.({ thread_id: scope.thread_id })
      threadStates.set(scope.thread_id, ctx.raw.state as Record<string, unknown>)
      if (threadStates.size > MAX_THREAD_SESSION_STATES) threadStates.delete(threadStates.keys().next().value as string)
      return bus.toApps(ctx.raw)
    }
    const wasBusy = (lastState?.state as { busy?: boolean } | undefined)?.busy === true
    lastState = ctx.raw
    if (wasBusy && frame.state.busy !== true) bus.settleWorking?.('main')
    const agents = lastAgents?.agents as { session_id?: unknown } | undefined
    if (agents && agents.session_id !== frame.state.session_id) lastAgents = undefined // a new session: old rows retire
    return bus.toApps(ctx.raw)
  })
  bus.onBridgeFrame('session.inventory', (_frame, ctx) => {
    lastInventory = ctx.raw
    return bus.toApps(ctx.raw)
  })
  // the Mac's list of its sessions (SESSION_BRIDGE_FRAME_TYPES): kept for `ready` like the inventory, and passed to the apps.
  // It had no handler, so the bus dropped it and `ready` never carried the `session_list` the protocol promises.
  bus.onBridgeFrame('session.list', (frame, ctx) => {
    // the envelope and the (capped) list only, like session.agents
    lastList = { v: 1, type: 'session.list', id: frame.id, ts: frame.ts, sessions: ctx.raw.sessions, at: frame.at }
    return bus.toApps(lastList)
  })
  bus.onBridgeFrame('session.agents', (frame, ctx) => {
    // the envelope and the (capped) snapshot only: extra top-level fields the schema strips never ride along
    lastAgents = { v: 1, type: 'session.agents', id: frame.id, ts: frame.ts, agents: ctx.raw.agents }
    return bus.toApps(lastAgents)
  })
  registerRelayFeature(AGENTS_FEATURE)
  // Option C: this relay passes thread.session.control and workers.status (and keeps per-thread states for ready)
  registerRelayFeature(THREAD_SESSIONS_FEATURE)
  // this relay's schema (and the app it serves) reads `rate_limits[].as_of`, so the bridge may send it
  registerRelayFeature(USAGE_AS_OF_FEATURE)
  // The bridge sends results durably and waits for an ack by ref.
  bus.onBridgeFrame('session.control.result', async (frame, ctx) => {
    ctx.reply({ v: 1, type: 'ack', id: newUlid(), ref: frame.id })
    if (seenResults.has(frame.id)) return
    remember(seenResults, frame.id)
    await bus.toApps(ctx.raw, { durable: true })
  })

  // Phone recovery: the Mac's answer to agent.recover (the request itself is taken in core/hub-config.ts, which gates it
  // on ownerDeviceOk; the owner's signature is checked at the bridge). Sent durably and acked by ref, like the session control result.
  bus.onBridgeFrame('agent.recover.result', async (frame, ctx) => {
    ctx.reply({ v: 1, type: 'ack', id: newUlid(), ref: frame.id })
    if (seenResults.has(frame.id)) return
    remember(seenResults, frame.id)
    await bus.toApps(ctx.raw, { durable: true })
  })

  // "Undo to here": the Mac's answer to undo.request (the request is taken in core/hub-config.ts; the owner's signature is
  // checked at the bridge). This relay also keeps a message's undo point from its receipt (core/hub-bridge-frames.ts)
  // and knows the undo card, so it says undo/1: the bridge cards nothing, and the app offers nothing, without it.
  bus.onBridgeFrame('undo.request.result', async (frame, ctx) => {
    ctx.reply({ v: 1, type: 'ack', id: newUlid(), ref: frame.id })
    if (seenResults.has(frame.id)) return
    remember(seenResults, frame.id)
    await bus.toApps(ctx.raw, { durable: true })
  })
  registerRelayFeature(UNDO_FEATURE)

  bus.onAppFrame('session.control', async (frame, ctx) => {
    const err = (code: string, message: string) =>
      ctx.reply({ v: 1, type: 'error', id: newUlid(), ref: frame.id, code, message })
    if (!ctx.deviceId || ctx.deviceId !== frame.device_id)
      return err('unauthorized', 'frame signed by a device other than this session')
    if (seenControls.has(frame.id)) return ctx.reply({ v: 1, type: 'ack', id: newUlid(), ref: frame.id })
    if (!bus.bridgeOnline()) return err('mac_offline', 'your Mac is offline')
    remember(seenControls, frame.id)
    // durable: kept until the bridge acks it consumed, i.e. until its result is recorded
    await bus.toBridge(ctx.raw, { durable: true, ttl_s: 300 })
    ctx.reply({ v: 1, type: 'ack', id: newUlid(), ref: frame.id })
  })
  // Option C: park/resume/restart/fresh for one thread's own session. Passed through like session.control.
  bus.onAppFrame('thread.session.control', async (frame, ctx) => {
    const err = (code: string, message: string) =>
      ctx.reply({ v: 1, type: 'error', id: newUlid(), ref: frame.id, code, message })
    if (!ctx.deviceId || ctx.deviceId !== frame.device_id)
      return err('unauthorized', 'frame signed by a device other than this session')
    if (seenControls.has(frame.id)) return ctx.reply({ v: 1, type: 'ack', id: newUlid(), ref: frame.id })
    if (!bus.bridgeOnline()) return err('mac_offline', 'your Mac is offline')
    remember(seenControls, frame.id)
    // durable: kept until the bridge acks it consumed, i.e. until its result is recorded
    await bus.toBridge(ctx.raw, { durable: true, ttl_s: 300 })
    ctx.reply({ v: 1, type: 'ack', id: newUlid(), ref: frame.id })
  })
  log.info({}, 'session module registered')
}
