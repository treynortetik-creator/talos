// Mod control contract (docs/CLAUDE-CODE.md C2.5, C4.1, C4.4). The same assertions run against FakeMod (this kit) and,
// from WP-C2, against the real mod under `claude plugin test` through a driver that implements ModDriver/EngineDriver.
import type { ModControlResultT, ModControlT, SessionInventoryT, SessionStateT } from '@talos-app/protocol'
import { MODEL_SWITCH_TIMEOUT_MS } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import type { FakeClock } from '../clock.ts'

/** What the engine (Claude Code) looks like to a test: drive turns, the cache and the user's own hooks. */
export interface EngineDriver {
  startTurn(turnId: string): void
  completeTurn(): void
  /** The user pressed Esc at the Mac: new work is refused until the user's next input. */
  userInterrupt(): void
  userInput(): void
  readonly model: string
  readonly effort: string | undefined
  readonly compactions: number
  readonly clears: number
}

export interface ModDriver {
  /** Runs one control the bridge handed over; resolves with the result the mod reports back. */
  execute(control: ModControlT): Promise<ModControlResultT>
  state(): SessionStateT
  inventory(): SessionInventoryT
}

export type ModEngineOptions = {
  version?: string
  model?: string
  effort?: string
  /** Prompt cache warm (the last response came from the current model). */
  cacheWarm?: boolean
  /** The user's own PreModelSwitch hook. */
  userModelHook?: 'none' | 'allow' | 'deny' | 'ask'
  userModelHookReason?: string
  /** Whether a mod's classic.PreModelSwitch hook may return a decision (SMOKE S4b). Default true. */
  modDecisionHonoured?: boolean
  /** Engine methods the mod finds missing at its typeof check. */
  missingMethods?: string[]
  /** More `$.command.list()` rows, e.g. a skill that shadows a built-in name. */
  extraCommands?: Array<{ name: string; description: string; source: string }>
}

export type ModHarness = (opts: ModEngineOptions) => { mod: ModDriver; engine: EngineDriver; clock: FakeClock }

const ID = (n: number) =>
  `01JBF3V7Q8K2M4N6P8R0S2T4${'0123456789ABCDEFGHJKMNPQRSTVWXYZ'[n % 32]}${'0123456789ABCDEFGHJKMNPQRSTVWXYZ'[(n >> 5) % 32]}`

/** Runs `execute` and advances the fake clock until it settles (the model-switch wait is clock driven). */
async function run(h: ReturnType<ModHarness>, control: ModControlT, advanceMs = 0): Promise<ModControlResultT> {
  const p = h.mod.execute(control)
  for (let waited = 0; waited <= advanceMs; waited += 1000) {
    await Promise.resolve()
    await new Promise((r) => setImmediate(r))
    h.clock.advance(1000)
  }
  return p
}

export function defineModControlContract(name: string, make: ModHarness) {
  describe(`mod control contract: ${name}`, () => {
    it('stop aborts the running turn named by turn_id', async () => {
      const h = make({})
      h.engine.startTurn('t1')
      const r = await run(h, { control_id: ID(1), action: 'stop', turn_id: 't1' })
      expect(r).toMatchObject({ control_id: ID(1), ok: true })
      expect(h.mod.state().busy).toBe(false)
    })
    it('a stale stop for an earlier turn never cancels the current one (turn_mismatch)', async () => {
      const h = make({})
      h.engine.startTurn('t1')
      h.engine.completeTurn()
      h.engine.startTurn('t2')
      const r = await run(h, { control_id: ID(2), action: 'stop', turn_id: 't1' })
      expect(r).toMatchObject({ ok: false, code: 'turn_mismatch' })
      expect(h.mod.state().busy).toBe(true)
      expect(h.mod.state().turn_id).toBe('t2')
    })
    it('compact while idle compacts; mid-turn it waits for turn.complete', async () => {
      const h = make({})
      expect(await run(h, { control_id: ID(3), action: 'compact' })).toMatchObject({ ok: true })
      expect(h.engine.compactions).toBe(1)
      h.engine.startTurn('t1')
      const mid = await run(h, { control_id: ID(4), action: 'compact', args: 'keep the plan' })
      expect(mid).toMatchObject({ ok: true, text: 'Compacts after this turn.' })
      expect(h.engine.compactions).toBe(1)
      h.engine.completeTurn()
      expect(h.engine.compactions).toBe(2)
    })
    it('clear starts a new conversation', async () => {
      const h = make({})
      expect(await run(h, { control_id: ID(5), action: 'clear' })).toMatchObject({ ok: true })
      expect(h.engine.clears).toBe(1)
    })
    it('a non-allowlisted command is refused by the mod too (defence in depth)', async () => {
      const h = make({})
      const r = await run(h, { control_id: ID(6), action: 'command', command: 'permissions', source: 'builtin' })
      expect(r).toMatchObject({ ok: false, code: 'command_not_allowed' })
    })
    it('a built-in name that a skill also uses is refused: $.command.run could run either (review R3)', async () => {
      const h = make({ extraCommands: [{ name: 'context', description: 'My context skill', source: 'user' }] })
      const r = await run(h, { control_id: ID(16), action: 'command', command: 'context', source: 'builtin' })
      expect(r).toMatchObject({ ok: false, code: 'command_not_allowed' })
      expect(h.mod.inventory().commands.find((c) => c.name === 'context' && c.source === 'builtin')?.route).toBe(
        'local_only',
      )
    })
    it('after the user interrupts at the Mac, new work is refused with stopped_at_mac until the next input', async () => {
      const h = make({})
      h.engine.userInterrupt()
      expect(await run(h, { control_id: ID(7), action: 'compact' })).toMatchObject({
        ok: false,
        code: 'stopped_at_mac',
      })
      expect(h.mod.state().stopped_at_mac).toBe(true)
      h.engine.userInput()
      expect(await run(h, { control_id: ID(8), action: 'compact' })).toMatchObject({ ok: true })
    })
    it('a missing engine method is capability_missing, never a throw', async () => {
      const h = make({ missingMethods: ['turn.abort'] })
      h.engine.startTurn('t1')
      expect(await run(h, { control_id: ID(9), action: 'stop', turn_id: 't1' })).toMatchObject({
        ok: false,
        code: 'capability_missing',
      })
    })

    describe('model switch (C4.4)', () => {
      const model = (n: number, to: string) =>
        ({
          control_id: ID(n),
          action: 'command',
          command: 'model',
          source: 'builtin',
          args: to,
          model_ticket: { to_model: to, expires_at: '2026-10-29T12:00:15.000Z' },
        }) as ModControlT
      it('cold cache: switches without asking', async () => {
        const h = make({ cacheWarm: false })
        expect(await run(h, model(10, 'sonnet'))).toMatchObject({ ok: true })
        expect(h.engine.model).toBe('sonnet')
      })
      it('warm cache: the one-shot ticket pre-approves exactly that switch', async () => {
        const h = make({ cacheWarm: true })
        expect(await run(h, model(11, 'sonnet'))).toMatchObject({ ok: true })
        expect(h.engine.model).toBe('sonnet')
      })
      it("the user's own deny hook wins, and its reason reaches the result (model_switch_denied)", async () => {
        const h = make({ cacheWarm: true, userModelHook: 'deny', userModelHookReason: 'policy: stay on opus' })
        const r = await run(h, model(12, 'sonnet'))
        expect(r).toMatchObject({ ok: false, code: 'model_switch_denied' })
        expect(r.text).toContain('policy: stay on opus')
        expect(h.engine.model).not.toBe('sonnet')
      })
      it('an ask hook is a refusal off the terminal (model_switch_denied)', async () => {
        const h = make({ cacheWarm: true, userModelHook: 'ask' })
        expect(await run(h, model(13, 'sonnet'))).toMatchObject({ ok: false, code: 'model_switch_denied' })
      })
      it('if the mod decision is not honoured, the switch waits at the Mac and the result is model_switch_pending after 15 s', async () => {
        const h = make({ cacheWarm: true, modDecisionHonoured: false })
        const r = await run(h, model(14, 'sonnet'), MODEL_SWITCH_TIMEOUT_MS + 1000)
        expect(r).toMatchObject({
          ok: false,
          code: 'model_switch_pending',
          text: 'Waiting for confirmation at the Mac.',
        })
        expect(h.engine.model).not.toBe('sonnet')
      })
      it('a model command without a matching ticket is refused', async () => {
        const h = make({ cacheWarm: true })
        const c = {
          ...model(15, 'sonnet'),
          model_ticket: { to_model: 'haiku', expires_at: '2026-10-29T12:00:15.000Z' },
        }
        expect(await run(h, c)).toMatchObject({ ok: false, code: 'args_invalid' })
      })
    })

    describe('effort (C4.4)', () => {
      const effort = (n: number, level: string) =>
        ({ control_id: ID(n), action: 'command', command: 'effort', source: 'builtin', args: level }) as ModControlT
      it('on a model that keeps the cache, applies without asking', async () => {
        const h = make({ model: 'claude-opus-5-5', cacheWarm: true })
        expect(await run(h, effort(20, 'high'))).toMatchObject({ ok: true })
        expect(h.engine.effort).toBe('high')
      })
      it('on another model with a warm cache, it asks at the Mac: effort_change_pending after 15 s', async () => {
        const h = make({ model: 'claude-opus-4-7', cacheWarm: true })
        const r = await run(h, effort(21, 'high'), MODEL_SWITCH_TIMEOUT_MS + 1000)
        expect(r).toMatchObject({ ok: false, code: 'effort_change_pending' })
      })
    })
  })
}
