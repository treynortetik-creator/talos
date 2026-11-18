// Rich notifications on the phone: the notification extension, the shared Keychain keys and the background buttons are native
// code this suite cannot run, so it pins the wiring that keeps them honest. The behaviour itself is covered by
// ios/TalosPushCore RichPushTests (`swift test`), which reads the vectors the TypeScript side generates.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { swiftBody, withoutComments } from './swift-source'

const ROOT = new URL('../', import.meta.url)
const read = (f: string) => readFileSync(new URL(f, ROOT), 'utf8')

describe('rich notifications: native wiring', () => {
  it('the categories the extension picks are the ones the protocol names, and the relay never sends them', () => {
    const swift = read('ios/TalosPushCore/Sources/TalosPushCore/RichPush.swift')
    const proto = readFileSync(new URL('../../packages/protocol/src/push-rich.ts', ROOT), 'utf8')
    for (const id of ['TALOS_REPLY', 'TALOS_CARD_LOW']) {
      expect(swift, id).toContain(`"${id}"`)
      expect(proto, id).toContain(`'${id}'`)
    }
    const push = readFileSync(new URL('../../packages/protocol/src/push.ts', ROOT), 'utf8')
    expect(push).not.toMatch(/TALOS_REPLY|TALOS_CARD_LOW/)
  })

  it('the extension is a target of the app, embedded, sharing only the Keychain group, with the system extension point', () => {
    const y = read('ios/App/project.yml')
    expect(y).toMatch(/TalosPushExtension:\n\s+type: app-extension/)
    expect(y).toMatch(/- target: TalosPushExtension\n\s+embed: true/)
    expect(y).toMatch(/NSExtensionPointIdentifier: com\.apple\.usernotifications\.service/)
    expect(y).toMatch(/NSExtensionPrincipalClass: \$\(PRODUCT_MODULE_NAME\)\.NotificationService/)
    const ext = y.split('TalosPushExtension:\n  ')[1] ?? y.split('  TalosPushExtension:')[1] ?? ''
    expect(ext).toMatch(/keychain-access-groups: \["\$\(AppIdentifierPrefix\)app\.talos\.shared"\]/)
    // no paid capability: the push entitlement stays out of the extension
    expect(ext).not.toMatch(/aps-environment|AppPush/)
    // the generated files the check compares include the extension's
    expect(read('scripts/check-generated.ts')).toMatch(/TalosPushExtension\/Info\.plist/)
  })

  it('the extension and the key store never touch the network or print, and a failure delivers the plain push with no signing button', () => {
    const svc = read('ios/TalosPushExtension/NotificationService.swift')
    const keys = read('ios/TalosPushShared/NativeKeyStore.swift')
    for (const [name, src] of [
      ['service', svc],
      ['keys', keys],
    ] as const) {
      expect(src, name).not.toMatch(/URLSession|URLRequest|print\(|NSLog|os_log|Logger\(/)
    }
    // a seal that did not open, and the time limit, both deliver the push stripped of the relay's button data (RichPushTests)
    expect(svc).toMatch(/let plain = Self\.content\(RichPush\.deliver\(inbound, opened: nil\)/)
    expect(svc).toMatch(/\?\? plain\)/)
    expect(svc).toMatch(/serviceExtensionTimeWillExpire\(\) \{\s*if let handler, let plain \{ handler\(plain\) \}/)
    expect(svc).not.toMatch(/handler\(original\)|\?\? request\.content/)
    // the sealed bytes are dropped from what stays on the phone
    expect(read('ios/TalosPushCore/Sources/TalosPushCore/RichPush.swift')).toMatch(/removeValue\(forKey: "enc"\)/)
    // the keys are device-bound and readable while locked, and live in the shared group only
    expect(keys).toMatch(/kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/)
    expect(keys).toMatch(/kSecAttrAccessGroup: group/)
  })

  it('a button press is done in the background against the active relay only, with no message text in any notification it shows', () => {
    const q = read('ios/App/App/Plugins/TalosQuickAct.swift')
    expect(q).toMatch(/SharedRelayOrigin\.currentActive\(\)/)
    expect(q).not.toMatch(/CompiledRelay/)
    expect(q).toMatch(/RichPush\.actURL\(relay: active\.origin\)/)
    // the keys and grant are the active pairing's own. A press on a push from another relay is refused before any key is read, and
    // button data without the extension's MAC before the action key or the grant is read (behaviour: TalosQuickActTests)
    expect(q).toMatch(/NativeKeyStore\.grant\(keyId: \$0\)/)
    const at = (needle: string) => q.indexOf(needle, q.indexOf('static func run('))
    expect(at('pressMatchesActiveKey')).toBeGreaterThan(-1)
    expect(at('pressMatchesActiveKey')).toBeLessThan(at('env.encKey(keyId)'))
    expect(at('pressIsAuthentic')).toBeLessThan(at('env.grant(keyId)'))
    expect(at('pressIsAuthentic')).toBeLessThan(at('env.actKey(keyId)'))
    // the app is looked at again just before the frame goes out
    expect(q.match(/env\.activeRelay\(\)/g)).toHaveLength(2)
    expect(q).not.toMatch(/userInfo\[.*(url|host|relay|navigate)/i)
    expect(q).not.toMatch(/print\(|NSLog|os_log/)
    // the Reply text is read once and handed to the signer; it is named nowhere else, so no failure message can be built from it
    expect(withoutComments(q), 'a message with a value spliced into it').not.toMatch(/"[^"\n]*\\\(/)
    const code = withoutComments(q).replace(/"[^"\n]*"/g, '""') // string literals are fixed words
    expect(code.match(/\btext\b/g)).toHaveLength(2) // `let text = ...userText` and `userText: text`
    // `.userText` (read once), `userText: text` (handed to `run`), the `run` parameter, and `userText: userText` (to the signer's parser)
    expect(code.match(/\buserText\b/g)).toHaveLength(5)
    // every notification the failure path shows takes its body from the fixed words it was called with
    expect(swiftBody(code, 'private static func fail')).toMatch(/content\.body = message\b/)
    // an Approve is checked against what the notification on the screen displayed, not against its data alone
    expect(code).toMatch(
      /let content = response\.notification\.request\.content\s*let shown = RichPush\.Shown\(title: content\.title, subtitle: content\.subtitle, body: content\.body\)\s*run\(action, shown: shown, userInfo: content\.userInfo/,
    )
    expect(swiftBody(code, 'static func run(')).toMatch(
      /guard let act = RichPush\.act\(for: action, shown: shown, userInfo: userInfo/,
    )
    // the delegate hands these two buttons to the quick-act path before it ever reaches the page
    const plugin = read('ios/App/App/Plugins/TalosPush.swift')
    expect(plugin).toMatch(
      /if let quick = PushCore\.quickAction\(identifier: response\.actionIdentifier\) \{\s*return TalosQuickAct\.handle\(quick, response: response, done: completionHandler\)/,
    )
    expect(plugin.indexOf('PushCore.quickAction(identifier')).toBeLessThan(plugin.indexOf('PushCore.actionName('))
  })

  it('the plugin hands the page public keys only, keeps a grant only for its own keys, and every new call is behind the gate', () => {
    const plugin = read('ios/App/App/Plugins/TalosPush.swift')
    for (const n of ['nativeKeys', 'storeGrant', 'clearGrant']) {
      const body = plugin.split(new RegExp(`@objc func ${n}\\(`))[1]?.split('@objc')[0] ?? ''
      expect(body, n).toMatch(/TalosPluginGate\.allows\(bridge\)/)
    }
    const keys = plugin.split('@objc func nativeKeys(')[1]?.split('@objc func storeGrant')[0] ?? ''
    expect(keys).toMatch(/enc_pub/)
    expect(keys).not.toMatch(/rawRepresentation|privateKey/)
    expect(read('ios/TalosPushShared/NativeKeyStore.swift')).toMatch(
      /grantNamesKeys\(json, encPub: keys\.encPub, actPub: keys\.actPub\)/,
    )
    // keys are per relay: each call names the relay of the page that made it, never a value the page sends
    for (const n of ['nativeKeys', 'storeGrant', 'clearGrant']) {
      const body = plugin.split(new RegExp(`@objc func ${n}\\(`))[1]?.split('@objc')[0] ?? ''
      expect(body, n).toMatch(/TalosPluginGate\.keyId\(bridge\)/)
      expect(body, n).not.toMatch(/call\.getString\("relay/)
    }
  })

  it('the extension opens a push with the key of the relay that sealed it and gives buttons only to the active relay', () => {
    const svc = read('ios/TalosPushExtension/NotificationService.swift')
    expect(svc).toMatch(/candidates: NativeKeyStore\.sealCandidates\(store: store\)/)
    expect(svc).toMatch(/keyId: \$0\.keyId, sealKey: \$0\.key, activeKeyId: activeKeyId/)
    // the relay list is read once and shared by both questions
    expect(svc.match(/NativeKeyStore\.relayStore\(\)/g)).toHaveLength(1)
    // no relay id is read out of the push itself
    expect(svc).not.toMatch(/relay_id|relayId"\]/)
    // the extension target links the relay list it reads the active relay from
    expect(read('ios/App/project.yml').split('  TalosPushExtension:')[1] ?? '').toMatch(/package: TalosRelayCore/)
  })
})
