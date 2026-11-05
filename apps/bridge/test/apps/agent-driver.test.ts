// The real bridge process (server.ts over stdio), a FakeApp through a FakeRelay, and FakeClaude's agent driver: real MCP
// clients to the real probe server with the REAL hook command lines, read from an install-written settings.local.json,
// run around every tool call. Only the model is scripted.
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { newUlid } from '@talos-app/protocol'
import { FakeApp, FakeClaude, FakeRelay, loadExampleConfig, mkFrame } from '@talos-app/testkit'
import { appPaths } from '../../src/apps/paths.ts'
import { runScan } from '../../src/apps/scan.ts'
import { stopRelay, tempHome } from '../helpers.ts'
import { memSecrets, PROBE, readProbe, ScriptedSource, scriptedIO, stdioConfig, tmp } from './helpers.ts'

const BRIDGE_DIR = resolve(import.meta.dir, '..', '..')
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
})

async function rig(o: { appsOn?: boolean } = {}) {
  const relay = await new FakeRelay().start()
  const home = tempHome('talos-apps-e2e-')
  const emptyHome = tmp('empty-home-')
  const agentDir = tmp('agent-')
  const session = tmp('session-')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'config.json'), JSON.stringify(loadExampleConfig('default')), { mode: 0o600 })
  writeFileSync(
    join(home, 'bridge.key'),
    JSON.stringify({
      v: 1,
      pkcs8: relay.bridgeKey.privateKeyPkcs8B64,
      public: relay.bridgeKey.publicKeyB64,
      key_id: relay.bridgeKey.keyId,
    }),
    { mode: 0o600 },
  )
  const app = new FakeApp({ relayWs: relay.wsBase })
  await app.connect()
  writeFileSync(
    join(home, 'devices.json'),
    JSON.stringify({
      version: 1,
      devices: [{ id: app.device.deviceId, name: 'Test', pubkey_jwk: app.device.publicJwk }],
    }),
    { mode: 0o600 },
  )
  // a real scan, approved by "the owner", writes the catalog and the hook entries
  const probe = await readProbe()
  const src = new ScriptedSource(
    '2.1.312',
    [{ name: 'probe', status: 'connected', source: 'local', config: stdioConfig(), tools: probe.tools as never }],
    { 'probe:ui://probe/view.html': probe.contents },
  )
  const t = scriptedIO({ ask: [true], text: ['Probe board', 'auto'] })
  await runScan({
    paths: appPaths(home),
    source: src,
    io: t.io,
    now: () => Date.now(),
    sleep: async () => {},
    secrets: memSecrets().secrets,
    connector: {
      connect: async () => {
        throw new Error('no')
      },
    },
    relayUrl: relay.httpUrl,
    agentDir,
    bridgeDir: BRIDGE_DIR,
    liveVersion: undefined,
    check: false,
    agentNames: [],
  })
  const probeLog = join(tmp('probe-log-'), 'probe.jsonl')
  const settingsPath = join(agentDir, '.claude', 'settings.local.json')
  const claude = new FakeClaude({
    command: 'bun',
    args: ['run', join(BRIDGE_DIR, 'src', 'server.ts')],
    cwd: BRIDGE_DIR,
    clientVersion: '2.1.312',
    env: {
      TALOS_APP_HOME: home,
      TALOS_APP_RELAY_URL: relay.httpUrl,
      TALOS_APP_BRIDGE: '1',
      HOME: emptyHome,
      ...(o.appsOn === false ? {} : { TALOS_APP_APPS: '1' }),
    },
    agentDriver: {
      settingsPath,
      servers: [
        { name: 'probe', source: 'local', command: process.execPath, args: [PROBE], env: { PROBE_LOG: probeLog } },
      ],
      env: { TALOS_APP_BRIDGE: '1', TALOS_APP_APPS: '1', TALOS_APP_HOME: home, HOME: emptyHome },
      cwd: BRIDGE_DIR,
      sessionDir: session,
    },
  })
  await claude.start()
  cleanups.push(async () => {
    await claude.stop().catch(() => {})
    await app.close()
    await stopRelay(relay)
  })
  const probeCalls = () => {
    try {
      return readFileSync(probeLog, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((l) => l.event === 'tools/call')
    } catch {
      return []
    }
  }
  const send = async (fields: Record<string, unknown>) => {
    const f = await app.sign({
      ...mkFrame('app.request'),
      thread_id: 'general',
      request_id: `ar_${newUlid()}`,
      user_gesture: true,
      ...fields,
    } as never)
    app.send(f)
    return f as unknown as { request_id: string }
  }
  const response = (rid: string, final = true) =>
    relay.expectFrame('app.response', (f) => f.request_id === rid && (!final || f.state !== 'pending_card'), {
      direction: 'from_bridge',
      timeoutMs: 15000,
    })
  const driver = claude.driver as NonNullable<typeof claude.driver>
  return { relay, app, claude, driver, home, agentDir, settingsPath, probeCalls, send, response }
}

describe('a real session: bridge process, hook processes, probe server, app', () => {
  it('the instructions only mention apps when they are on; the tools only exist when they are on', async () => {
    const on = await rig()
    expect(on.claude.serverInstructions).toContain('app_show')
    expect((await on.claude.listTools()).map((t) => t.name)).toEqual(
      expect.arrayContaining(['app_show', 'app_result', 'list_apps']),
    )
    expect(readFileSync(appPaths(on.home).liveVersion, 'utf8').trim()).toBe('2.1.312') // recorded from clientInfo
    const off = await rig({ appsOn: false })
    expect(off.claude.serverInstructions).not.toContain('app_show')
    expect((await off.claude.listTools()).map((t) => t.name)).not.toContain('app_show')
    const r = await off.claude.callTool('app_show', { thread_id: 'general', capture_id: 'x' })
    expect(r.isError).toBe(true)
  }, 30_000)

  it('show, read-only tap, card tap, the gate, and what the model sees at each step', async () => {
    const r = await rig()
    // 1. the agent calls a UI tool for the owner: the hooks write a capture and nudge
    const first = await r.driver.callTool('probe', 'show_widget', {})
    const cap = /capture_id "([^"]+)"/.exec(first.modelSees)?.[1] as string
    expect(cap).toBe(first.toolUseId)
    expect(first.hooks.map((h) => h.event)).toEqual(['PreToolUse', 'PostToolUse'])
    expect(first.hooks[0]?.stdout).toBe('') // an ordinary call: the gate says nothing
    const shown = await r.claude.callTool('app_show', { thread_id: 'general', capture_id: cap })
    const viewId = /view (av_\S+)\)/.exec(shown.content[0]?.text ?? '')?.[1] as string
    expect(viewId).toBeDefined()
    const reply = await r.relay.expectFrame('reply', (f) => f.message.kind === 'app', { direction: 'to_app' })
    expect(reply.message.app?.label).toBe('Probe board')

    // 2. a read-only button: no card, the agent is told, the gate runs the approved call, the app gets the result
    const rq = await r.send({ view_id: viewId, method: 'tools/call', tool_name: 'read_note', arguments: { id: 'n7' } })
    const note = await r.claude.waitForNotification((n) => n.meta.kind === 'app_tool_call', 8000)
    expect(note.meta.trust).toBe('external')
    const probeBefore = r.probeCalls().length
    const agentCall = await r.driver.callTool('probe', 'read_note', {}) // the agent sends {} and the gate fills the approved arguments in
    expect(agentCall.hooks.map((h) => h.event)).toEqual(['PreToolUse', 'PostToolUse'])
    expect(agentCall.sentArguments).toEqual({ id: 'n7' })
    expect(r.probeCalls().length).toBe(probeBefore + 1)
    expect(r.probeCalls().at(-1)).toMatchObject({ tool: 'read_note', arguments: { id: 'n7' } })
    expect(agentCall.modelSees).toContain('Result handed to app "Probe board"')
    expect(agentCall.modelSees).not.toContain('buy milk') // the agent never sees the result
    const done = await r.response(rq.request_id)
    expect(done.state).toBe('done')
    expect(done.result?.structuredContent).toEqual({ id: 'n7', body: 'buy milk' })

    // 3. a write: a card; while it waits the gate blocks the call (the probe is not reached)
    const wq = await r.send({
      view_id: viewId,
      method: 'tools/call',
      tool_name: 'set_note',
      arguments: { id: 'n7', body: 'new body' },
    })
    const pending = await r.response(wq.request_id, false)
    expect(pending.state).toBe('pending_card')
    const cardFrame = await r.relay.expectFrame(
      'card.create',
      (f) => (f.card.payload as { request_id?: string } | undefined)?.request_id === wq.request_id,
      { direction: 'from_bridge' },
    )
    const before = r.probeCalls().length
    const blocked = await r.driver.callTool('probe', 'set_note', { id: 'n7', body: 'new body' })
    expect(blocked.blocked?.by).toBe('deny')
    expect(blocked.modelSees).toContain('Waiting for the owner to approve app request')
    expect(r.probeCalls().length).toBe(before)
    // the owner taps Run
    await r.app.resolveCard(cardFrame.card as never, 'primary', cardFrame.card.payload_hash, {
      stepup_token: r.relay.mintStepup(`card:${cardFrame.card.id}`),
    })
    const act = await r.claude.waitForNotification(
      (n) => n.meta.kind === 'card_action' && n.meta.card_action === 'primary',
      8000,
    )
    expect(act.content).toContain('This approves one app request: call set_note on probe once')
    // the agent, steered to change the body, sends other arguments: the gate does not claim them, so they run as the OWNER's call (no hijack)...
    const own = await r.driver.callTool('probe', 'set_note', { id: 'n7', body: 'SOMETHING ELSE' })
    expect(own.sentArguments).toEqual({ id: 'n7', body: 'SOMETHING ELSE' })
    expect(own.modelSees).toContain('wrote note n7') // the owner's own call is a normal call (it still gets the app_show nudge)
    expect(own.modelSees).not.toContain('Result handed to app')
    // ...and the approved request is still waiting, untouched
    const exact = await r.driver.callTool('probe', 'set_note', {})
    expect(exact.sentArguments).toEqual({ id: 'n7', body: 'new body' })
    expect(exact.modelSees).toContain('Result handed to app')
    expect((await r.response(wq.request_id)).state).toBe('done')
    await r.claude.callTool('card_result', { card_id: cardFrame.card.id, ok: true, text: 'ran' })
  }, 60_000)

  it('onFailure:"block" is what stops a call when the gate is killed or stalls (control: without it the call runs)', async () => {
    const r = await rig()
    const cfg = JSON.parse(readFileSync(r.settingsPath, 'utf8'))
    const pre = cfg.hooks.PreToolUse[0].hooks[0]
    expect(pre.onFailure).toBe('block')
    expect(pre.timeout).toBe(10)
    // a stalled gate
    pre.command = 'sleep 30'
    writeFileSync(r.settingsPath, JSON.stringify(cfg))
    const before = r.probeCalls().length
    ;(r.driver as unknown as { o: { hookTimeoutMs?: number } }).o.hookTimeoutMs = 300
    const blocked = await r.driver.callTool('probe', 'set_note', { id: 'z' })
    expect(blocked.blocked?.by).toBe('onFailure')
    expect(r.probeCalls().length).toBe(before)
    // a killed gate
    pre.command = 'kill -9 $$'
    writeFileSync(r.settingsPath, JSON.stringify(cfg))
    expect((await r.driver.callTool('probe', 'set_note', { id: 'z' })).blocked?.by).toBe('onFailure')
    // control: the same failure without the flag lets the call run
    delete pre.onFailure
    writeFileSync(r.settingsPath, JSON.stringify(cfg))
    const ran = await r.driver.callTool('probe', 'set_note', { id: 'z' })
    expect(ran.ran).toBe(true)
    expect(r.probeCalls().length).toBe(before + 1)
  }, 60_000)

  it("a 60,000-character result reaches the hook as Claude Code's oversize string, and the hook reads the session's own file", async () => {
    const r = await rig()
    const big = await r.driver.callTool('probe', 'big', { chars: 60_000 })
    expect(big.modelSees).toMatch(
      /^Error: result \(60000 characters\) exceeds maximum allowed tokens\. Output has been saved to \S+\.txt\./,
    )
    // `big` has no app view, so the post hook stays silent and writes nothing
    expect(big.hooks.every((h) => h.stdout === '')).toBe(true)
  }, 60_000)
})
