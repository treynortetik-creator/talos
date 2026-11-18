import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { swiftBody, withoutComments } from './swift-source'

// The active relay origin comes only from a native scan (BYOR.md 3.1, 10d). The Swift cannot run under Node, so these pin the
// places a path in could appear. What a grep cannot pin (which origin a live web view, guard or gate really uses) is tested by
// AppTests/RelayActiveOriginTests.swift and AppTests/SharedRelayOriginTests.swift on a simulator.
const IOS = new URL('../ios/', import.meta.url).pathname
const APP = `${IOS}App/App/`
const SOURCE_DIRS = ['App/App', 'TalosShareShared', 'TalosShareExtension', 'TalosPushShared']

function swiftFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? swiftFiles(join(dir, e.name)) : e.name.endsWith('.swift') ? [join(dir, e.name)] : [],
  )
}

const allSources = SOURCE_DIRS.flatMap((d) => swiftFiles(`${IOS}${d}`))
const rel = (f: string) => f.slice(IOS.length)
const read = (f: string) => withoutComments(readFileSync(f, 'utf8'))
const filesWith = (re: RegExp) =>
  allSources
    .filter((f) => re.test(read(f)))
    .map(rel)
    .sort()

/** The text of every call to `name(`, from its opening parenthesis to the matching one. */
function callsTo(src: string, name: string): string[] {
  const out: string[] = []
  let from = 0
  for (;;) {
    const at = src.indexOf(name, from)
    if (at < 0) return out
    let depth = 0
    let i = src.indexOf('(', at)
    const start = i
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++
      else if (src[i] === ')' && --depth === 0) break
    }
    out.push(src.slice(start, i + 1))
    from = i
  }
}

describe('the active relay origin is set only by a native scan', () => {
  it('only the Add-relay save path writes the relay list, and only the scan sheet reaches it', () => {
    // Any write to a RelayStore (add, setActive, reset) or a call into the save path, whatever the variable is called.
    const writes = filesWith(
      /\b(?:(?:[a-z][A-Za-z]*)?[sS]tore(?:\(\))?\??|runtime|self\.runtime)\.(?:add|setActive|reset|save)\(|AddRelayFlow\.save\(/,
    )
    expect(writes).toEqual([
      'App/App/Relay/AddRelayFlow.swift',
      'App/App/Relay/AddRelayViewController.swift',
      'App/App/Relay/RelayRuntime.swift',
    ])
    const sheet = read(`${APP}Relay/AddRelayViewController.swift`)
    expect(swiftBody(sheet, 'func handle(link: String)')).toContain('flow.prepare(link: link)')
    expect(swiftBody(sheet, 'private func save()')).toContain('runtime.save(')
    // A relay list is only ever built in the runtime, the DEBUG hook, and the shared lookup that reads it.
    expect(filesWith(/\bRelayStore\(/)).toEqual([
      'App/App/Relay/DebugAddRelay.swift',
      'App/App/Relay/RelayRuntime.swift',
      'TalosPushShared/NativeKeyStore.swift', // reads the list for the notification extension (which has no share code)
      'TalosShareShared/SharedRelayOrigin.swift',
    ])
  })

  it('openAddRelay takes no argument from the page', () => {
    const plugin = read(`${APP}Plugins/TalosRelay.swift`)
    const body = swiftBody(plugin, '@objc func openAddRelay')
    // The call object is only ever answered (reject, resolve), never read.
    expect(body.replace(/\bcall\.(?:reject|resolve)\(/g, '')).not.toMatch(/\bcall\b/)
    expect(plugin).not.toMatch(
      /\bgetString\b|\bgetObject\b|\bgetArray\b|\bgetInt\b|\bgetBool\b|\bhasOption\b|\boptions\b/,
    )
  })

  it('the build-time relay is read in two places only, and only as the profile-less DEBUG fallback', () => {
    // `serverURL` is Capacitor's descriptor field: read once to find the fallback and set once from the active profile.
    expect(filesWith(/\bserverURL\b/)).toEqual(['App/App/TalosBridgeViewController.swift'])
    const vc = read(`${APP}TalosBridgeViewController.swift`)
    expect(swiftBody(vc, 'override func instanceDescriptor()')).toContain('buildTimeURL: descriptor.serverURL')
    expect(vc.match(/\bserverURL\b/g)?.length).toBe(
      swiftBody(vc, 'override func instanceDescriptor()').match(/\bserverURL\b/g)?.length,
    )
    // CompiledRelay (capacitor.config.json in the bundle) is defined once and used only behind the DEBUG fallback flag.
    expect(filesWith(/\bCompiledRelay\b/)).toEqual([
      'TalosShareShared/CompiledRelay.swift',
      'TalosShareShared/SharedRelayOrigin.swift',
    ])
    expect(read(`${IOS}TalosShareShared/SharedRelayOrigin.swift`)).toMatch(
      /allowsBuildTimeFallback \? CompiledRelay\.url\(bundle: bundle\) : nil/,
    )
    // The extension and the quick actions ask for the active relay, not the build-time one.
    expect(read(`${IOS}TalosShareExtension/ShareModel.swift`)).toContain('SharedRelayOrigin.current()')
    expect(read(`${APP}Plugins/TalosQuickAct.swift`)).toContain('SharedRelayOrigin.currentActive()')
  })

  it("the plugin gate reads the controller's relay context, not a compiled origin", () => {
    const gate = read(`${APP}Plugins/TalosPluginGate.swift`)
    expect(gate).toContain('relayContext')
    expect(gate).toContain('context.trust.state')
    expect(gate).toContain('context.guardian')
    expect(gate).not.toMatch(/serverURL|BridgeGuard\(/)
  })

  it('the shell gives each relay its own data store and removes it with the relay', () => {
    const vc = read(`${APP}TalosBridgeViewController.swift`)
    expect(vc).toMatch(/websiteDataStore\s*=\s*WKWebsiteDataStore\(\s*forIdentifier:/)
    expect(vc).not.toMatch(/websiteDataStore\s*=\s*\.?default|nonPersistent/)
    const runtime = read(`${APP}Relay/RelayRuntime.swift`)
    const remove = swiftBody(runtime, 'func remove(id: String)')
    expect(remove).toContain('dataStores.remove(own)')
  })

  it("Capacitor's cookie and HTTP plugins are refused before any other check", () => {
    const vc = read(`${APP}TalosBridgeViewController.swift`)
    const handler = swiftBody(vc, 'final class GuardedMessageHandler')
    const receive = swiftBody(handler, 'func userContentController')
    expect(receive.indexOf('BridgeGuard.blocksPluginCall(body: message.body)')).toBeGreaterThanOrEqual(0)
    expect(receive.indexOf('blocksPluginCall')).toBeLessThan(receive.indexOf('allowsPluginCall'))
    const guardSrc = read(`${IOS}BridgeGuard/Sources/BridgeGuard/BridgeGuard.swift`)
    expect(guardSrc).toMatch(/blockedPluginIds: Set<String> = \["CapacitorCookies", "CapacitorHttp"\]/)
  })

  it('the prompt() channel refuses cookie and HTTP plugin prompts before it forwards anything', () => {
    const vc = read(`${APP}TalosBridgeViewController.swift`)
    const prompt = swiftBody(vc, 'runJavaScriptTextInputPanelWithPrompt prompt')
    expect(prompt).toContain('BridgeGuard.blocksPrompt(prompt)')
    expect(prompt.indexOf('blocksPrompt')).toBeLessThan(prompt.indexOf('promptChannelAllowed'))
    expect(prompt.indexOf('blocksPrompt')).toBeLessThan(prompt.indexOf('inner as?'))
  })

  it("every prompt() Capacitor's own bridge script sends is one the guard blocks, and the Swift test lists them all", () => {
    const bridge = readFileSync(
      join(
        dirname(createRequire(import.meta.url).resolve('@capacitor/ios/package.json')),
        'Capacitor/Capacitor/assets/native-bridge.js',
      ),
      'utf8',
    )
    // Every payload is `prompt(JSON.stringify(payload))` with a `type`; nothing else in the script calls prompt().
    expect([...bridge.matchAll(/\bprompt\(/g)].length).toBe(
      [...bridge.matchAll(/\bprompt\(JSON\.stringify\(payload\)\)/g)].length,
    )
    const types = [...bridge.matchAll(/type:\s*'([^']+)'/g)].map((m) => m[1]).filter((t) => t.startsWith('Capacitor'))
    expect(new Set(types)).toEqual(
      new Set(['CapacitorCookies.isEnabled', 'CapacitorCookies.get', 'CapacitorCookies.set', 'CapacitorHttp']),
    )
    const ids =
      read(`${IOS}BridgeGuard/Sources/BridgeGuard/BridgeGuard.swift`).match(
        /blockedPluginIds: Set<String> = \[(.*)\]/,
      )?.[1] ?? ''
    for (const t of types) expect(ids, t).toMatch(new RegExp(`"${t.split('.')[0]}"`))
    const swiftTest = read(`${IOS}BridgeGuard/Tests/BridgeGuardTests/BlockedPluginTests.swift`)
    for (const t of types) expect(swiftTest, t).toContain(`"type":"${t}"`)
  })

  it('a relay switch clears the relay-bound state after retiring the old controller, and the gate wants the root controller', () => {
    const scene = read(`${APP}SceneDelegate.swift`)
    const body = swiftBody(scene, 'func switchRelay')
    expect(body.indexOf('.retire()')).toBeGreaterThanOrEqual(0)
    expect(body.indexOf('.retire()')).toBeLessThan(body.indexOf('clearRelayBoundState()'))
    expect(read(`${APP}Plugins/TalosPluginGate.swift`)).toMatch(/rootViewController === controller/)
  })

  it('the trust state reaches every guarded call, in the app and in the gate', () => {
    const vc = read(`${APP}TalosBridgeViewController.swift`)
    for (const name of ['guardian.allowsPluginCall', 'guardian.allowsPromptChannel', 'guardian.devicePermission']) {
      const calls = callsTo(vc, name)
      expect(calls.length, name).toBeGreaterThan(0)
      for (const call of calls) expect(call, name).toMatch(/trust:\s*trust\.state\)$/)
    }
    // No call to a guarded method may skip the argument anywhere else in the app either.
    for (const f of allSources.filter((f) => f.startsWith(APP))) {
      for (const name of ['.allowsPluginCall', '.allowsPromptChannel', '.devicePermission']) {
        for (const call of callsTo(read(f), name)) expect(call, `${rel(f)} ${name}`).toContain('trust:')
      }
    }
  })
})
