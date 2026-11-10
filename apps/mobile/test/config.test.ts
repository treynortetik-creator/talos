import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildConfig, relayOrigin } from '../capacitor.config'
import { swiftBody, withoutComments } from './swift-source'

const ROOT = new URL('..', import.meta.url)

describe('capacitor config', () => {
  it('has no server.url without TALOS_RELAY_URL (no default production URL)', () => {
    const cfg = buildConfig({})
    expect(cfg.server).toBeUndefined()
    expect(cfg.appId).toBe('app.talos.shell')
    expect(buildConfig({ TALOS_RELAY_URL: '   ' }).server).toBeUndefined()
  })

  it('takes the relay origin only from TALOS_RELAY_URL', () => {
    const cfg = buildConfig({ TALOS_RELAY_URL: 'https://relay.example.test' })
    expect(cfg.server?.url).toBe('https://relay.example.test')
    expect(cfg.server?.cleartext).toBeUndefined()
    expect(cfg.server?.errorPath).toBe('offline.html')
    expect(cfg.server?.allowNavigation).toEqual(['relay.example.test'])
  })

  it('rejects http (except loopback), credentials and garbage', () => {
    expect(() => relayOrigin('http://relay.example.test')).toThrow()
    expect(() => relayOrigin(`https://user:pw${'@'}relay.example.test`)).toThrow()
    expect(() => relayOrigin('not a url')).toThrow()
    expect(() => relayOrigin('javascript:alert(1)')).toThrow()
    expect(relayOrigin('http://localhost:8787')).toBe('http://localhost:8787')
    expect(() => relayOrigin('https://relay.example.test/x')).toThrow()
    expect(() => relayOrigin('https://relay.example.test/?q=1')).toThrow()
    expect(buildConfig({ TALOS_RELAY_URL: 'http://localhost:8787', TALOS_DEV_CLEARTEXT: '1' }).server?.cleartext).toBe(
      true,
    )
  })

  it('commits no hard-coded production relay anywhere in the shell sources', () => {
    const files = [
      'capacitor.config.ts',
      'ios/App/project.yml',
      'ios/App/App/TalosBridgeViewController.swift',
      'ios/App/App/AppDelegate.swift',
      'ios/App/App/SceneDelegate.swift',
      'ios/BridgeGuard/Sources/BridgeGuard/BridgeGuard.swift',
    ]
    for (const f of files) {
      const src = readFileSync(new URL(f, ROOT), 'utf8')
      // Any literal http(s) URL in these sources must be a placeholder/doc host, never a real deployment.
      const urls = src.match(/https?:\/\/[^\s'"`)]+/g) ?? []
      for (const u of urls) expect(u, `${f}: ${u}`).toMatch(/example\.test|localhost|127\.0\.0\.1/)
      expect(src, f).not.toMatch(/railway\.app|up\.railway|fly\.dev/i)
    }
  })

  it('declares audio background mode, iOS 17, and no push or associated domains', () => {
    const yml = readFileSync(new URL('ios/App/project.yml', ROOT), 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n')
    expect(yml).toMatch(/UIBackgroundModes: \[audio\]/)
    expect(yml).toMatch(/deploymentTarget:\s+iOS: "17\.0"/)
    expect(yml).not.toMatch(/remote-notification|aps-environment|associated-domains|applinks/i)
    expect(yml).not.toMatch(/DEVELOPMENT_TEAM/)
    const plist = readFileSync(new URL('ios/App/App/Info.plist', ROOT), 'utf8')
    expect(plist).toMatch(/<key>UIBackgroundModes<\/key>\s*<array>\s*<string>audio<\/string>\s*<\/array>/)
    expect(plist).not.toMatch(/remote-notification|aps-environment|applinks/)
    // The only entitlement is Keychain sharing (free tier); nothing that needs the paid program (WP-I3b).
    for (const f of ['ios/App/App/App.entitlements', 'ios/TalosShareExtension/TalosShareExtension.entitlements']) {
      const ent = readFileSync(new URL(f, ROOT), 'utf8')
      expect([...ent.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1])).toEqual(['keychain-access-groups'])
    }
    const pbx = readFileSync(new URL('ios/App/App.xcodeproj/project.pbxproj', ROOT), 'utf8')
    expect(pbx).not.toMatch(/DEVELOPMENT_TEAM/)
    expect(pbx).toMatch(/IPHONEOS_DEPLOYMENT_TARGET = 17\.0/)
  })

  it('parks a mix-friendly audio session at launch and never activates it there', () => {
    const delegate = readFileSync(new URL('ios/App/App/AppDelegate.swift', ROOT), 'utf8')
    expect(delegate).toMatch(/configureAtLaunch\(\)/)
    expect(delegate).not.toMatch(/setActive/)
    const policy = readFileSync(
      new URL('ios/TalosAudioCore/Sources/TalosAudioCore/AudioSessionPolicy.swift', ROOT),
      'utf8',
    )
    expect(policy).toMatch(/parked = SessionConfig\(category: \.playback, spokenAudio: true, mixWithOthers: true\)/)
    const plugin = readFileSync(new URL('ios/App/App/Plugins/TalosAudio.swift', ROOT), 'utf8')
    expect(plugin).toMatch(/TalosPluginGate\.allows\(bridge\)/)
    expect(plugin).toMatch(/notifyOthersOnDeactivation/)
  })

  it('ships the haptics plugin', () => {
    const spm = readFileSync(new URL('ios/App/CapApp-SPM/Package.swift', ROOT), 'utf8')
    expect(spm).toMatch(/CapacitorHaptics/)
  })

  it('pins Capacitor to 8.5.3 exactly', () => {
    const pkg = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8'))
    const all = { ...pkg.dependencies, ...pkg.devDependencies }
    for (const n of ['@capacitor/core', '@capacitor/cli', '@capacitor/ios']) expect(all[n]).toBe('8.5.3')
    const spm = readFileSync(new URL('ios/App/CapApp-SPM/Package.swift', ROOT), 'utf8')
    expect(spm).toMatch(/exact: "8\.5\.3"/)
  })

  it('share extension: no URL scheme, keychain group from the team prefix, no relay taken from JS', () => {
    const yml = readFileSync(new URL('ios/App/project.yml', ROOT), 'utf8')
    expect(yml).not.toMatch(/CFBundleURLTypes/)
    expect(yml).toMatch(/keychain-access-groups: \["\$\(AppIdentifierPrefix\)app\.talos\.shared"\]/)
    expect(yml).not.toMatch(/DEVELOPMENT_TEAM|aps-environment|associated-domains/)
    const plugin = readFileSync(new URL('ios/App/App/Plugins/TalosShare.swift', ROOT), 'utf8')
    expect(plugin).toMatch(/TalosPluginGate\.allows\(bridge\)/)
    expect(plugin).not.toMatch(/getString\("relay"\)|getString\("url"\)/)
    expect(plugin).not.toMatch(/@objc func (getToken|readToken|token)\b/)
    const store = readFileSync(new URL('ios/TalosShareShared/KeychainTokenStore.swift', ROOT), 'utf8')
    expect(store).not.toMatch(/print\(|NSLog|os_log|CAPLog/)
  })

  it('push (WP-I5) is inert by default: no push entitlement unless Local.xcconfig opts in', () => {
    const read = (f: string) => readFileSync(new URL(f, ROOT), 'utf8')
    // default build: Keychain sharing only, chosen through TALOS_APP_ENTITLEMENTS
    expect(read('ios/Signing.xcconfig')).toMatch(/^TALOS_APP_ENTITLEMENTS = App\/App\.entitlements$/m)
    const pbx = read('ios/App/App.xcodeproj/project.pbxproj')
    expect(pbx.match(/CODE_SIGN_ENTITLEMENTS = "\$\(TALOS_APP_ENTITLEMENTS\)"/g)).toHaveLength(2) // Debug + Release
    expect(pbx).not.toMatch(/CODE_SIGN_ENTITLEMENTS = App\/AppPush/)
    // the opt-in file adds exactly aps-environment and associated-domains (WP-I6; and keeps Keychain sharing); it is never listed as a source or default
    const push = read('ios/App/App/AppPush.entitlements')
    expect([...push.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1])).toEqual([
      'aps-environment',
      'com.apple.developer.associated-domains',
      'com.apple.developer.usernotifications.time-sensitive',
      'keychain-access-groups',
    ])
    expect(push).toMatch(/<string>development<\/string>/)
    expect(read('ios/App/project.yml')).not.toMatch(/^[^#\n]*AppPush\.entitlements(?!\s*$)/m)
    // Info.plist keeps audio only: alert pushes need no background mode
    expect(read('ios/App/App/Info.plist')).not.toMatch(/remote-notification/)
  })

  it('push plugin: gated, no relay argument, never prompts at launch, never logs the token', () => {
    const read = (f: string) => readFileSync(new URL(f, ROOT), 'utf8')
    const plugin = read('ios/App/App/Plugins/TalosPush.swift')
    expect(plugin.match(/TalosPluginGate\.allows\(bridge\)/g)?.length).toBeGreaterThanOrEqual(4)
    expect(plugin).not.toMatch(/getString\("(relay|url|host)"\)/)
    expect(plugin).not.toMatch(/print\(|NSLog|os_log|CAPLog/)
    // the permission dialog is reachable only behind `prompt: true`
    expect(plugin).toMatch(/guard mayPrompt else \{ return call\.reject\("prompt"/)
    expect(plugin.match(/requestAuthorization/g)).toHaveLength(1)
    const delegate = read('ios/App/App/AppDelegate.swift')
    expect(delegate).not.toMatch(/requestAuthorization/)
    expect(delegate).toMatch(/didFailToRegisterForRemoteNotificationsWithError/)
    expect(read('ios/App/App/TalosBridgeViewController.swift')).toMatch(/registerPluginInstance\(TalosPushPlugin\(\)\)/)
    // Approve opens the card; nothing in the plugin approves anything
    expect(plugin).not.toMatch(/cards?\/.*resolve|approveCard|card\.resolve/i)
  })

  it('every method the page can call on the push plugin opens with the gate; clearDelivered can only take what PushCore names', () => {
    const plugin = withoutComments(readFileSync(new URL('ios/App/App/Plugins/TalosPush.swift', ROOT), 'utf8'))
    const names = [...plugin.matchAll(/CAPPluginMethod\(name: "(\w+)"/g)].map((m) => m[1])
    expect(names).toContain('clearDelivered')
    for (const n of names) {
      // the first statement, so nothing runs before the gate says yes
      expect(swiftBody(plugin, `@objc func ${n}(`), n).toMatch(
        /^\s*guard TalosPluginGate\.allows\(bridge\) else \{ return call\.reject\(/,
      )
    }
    // the only removal goes through the pure matcher (PushCoreTests): nothing else the app delivered can be swept up
    expect(plugin.match(/removeDeliveredNotifications/g)).toHaveLength(1)
    expect(swiftBody(plugin, 'func removeDelivered')).toMatch(
      /let ids = pick\(delivered\)\s*if !ids\.isEmpty \{ center\.removeDeliveredNotifications\(withIdentifiers: ids\) \}/,
    )
    const clear = swiftBody(plugin, '@objc func clearDelivered(')
    expect(clear).toMatch(/removeDelivered\(\s*pick: \{ delivered in\s*PushCore\.identifiersToClear\(/)
    expect(plugin).not.toMatch(/removeAllDeliveredNotifications/)
  })

  it('sign-out and text off take opened words off the screen: clearGrant removes only notifications the extension marked', () => {
    const plugin = withoutComments(readFileSync(new URL('ios/App/App/Plugins/TalosPush.swift', ROOT), 'utf8'))
    const body = swiftBody(plugin, '@objc func clearGrant(')
    // the keys go first, then the marked notifications, picked by the tested matcher (PushCoreTests)
    expect(body).toMatch(
      /NativeKeyStore\.clearAll\(\)\s*removeDelivered\(\s*pick: \{ delivered in\s*PushCore\.identifiersShowingText\(/,
    )
    const ext = withoutComments(readFileSync(new URL('ios/TalosPushExtension/NotificationService.swift', ROOT), 'utf8'))
    // the marker goes on every notification whose body was replaced, not only those with buttons
    const bodySet = ext.indexOf('out.body = content.body')
    const marker = ext.indexOf('info[PushCore.textMarkerKey] = PushCore.textMarkerValue')
    expect(bodySet).toBeGreaterThan(-1)
    expect(marker).toBeGreaterThan(bodySet)
    expect(marker).toBeLessThan(ext.indexOf('if let category'))
    // and what carries the marker is what is delivered
    expect(ext.indexOf('out.userInfo = info')).toBeGreaterThan(marker)
  })

  it('the categories the app registers are the ones the relay sends', () => {
    const swift = readFileSync(new URL('ios/TalosPushCore/Sources/TalosPushCore/PushCore.swift', ROOT), 'utf8')
    const proto = readFileSync(new URL('../../packages/protocol/src/push.ts', ROOT), 'utf8')
    for (const id of ['TALOS_OPEN', 'TALOS_CARD']) {
      expect(swift, id).toContain(`"${id}"`)
      expect(proto, id).toContain(`'${id}'`)
    }
  })

  it('push taps reach the app: Capacitor does not take the notification delegate, and the categories come from the tested core', () => {
    const read = (f: string) => readFileSync(new URL(f, ROOT), 'utf8')
    expect(buildConfig({}).ios?.handleApplicationNotifications).toBe(false)
    expect(buildConfig({ TALOS_RELAY_URL: 'https://relay.example.com' }).ios?.handleApplicationNotifications).toBe(
      false,
    )
    const plugin = withoutComments(read('ios/App/App/Plugins/TalosPush.swift'))
    // the unlock option is built in TalosPushCore, where PushCoreIosWiringTests builds the real iOS actions and checks it;
    // the plugin must hand the center those categories and not build its own
    expect(swiftBody(plugin, 'func install()')).toMatch(
      /center\.delegate = self\s*center\.setNotificationCategories\(PushCore\.notificationCategories\(\)\)/,
    )
    // and it does so when it loads, in case a build ever turns handleApplicationNotifications back on
    expect(swiftBody(plugin, 'override func load()')).toMatch(/^\s*TalosPushCenter\.shared\.install\(\)/)
    // a tap is only dropped from the waiting slot once the page took it (and is remembered for a moment, in case that page is replaced)
    expect(swiftBody(plugin, 'func flush()')).toMatch(
      /if deliver\(event\) \{\s*waiting = nil\s*delivered = \(event, now\(\)\)\s*\}/,
    )
    expect(swiftBody(plugin, 'override func addListener')).toMatch(/TalosPushCenter\.shared\.flush\(\)/)
    const core = withoutComments(read('ios/TalosPushCore/Sources/TalosPushCore/PushCore.swift'))
    expect(core).toMatch(/approveButton = PushButton\([^)]*requiresAuthentication: true\)/)
  })
})

describe('keyboard plugin', () => {
  it('uses stock @capacitor/keyboard in native resize mode, outside the origin branch', () => {
    for (const env of [{}, { TALOS_RELAY_URL: 'https://relay.example.test' }]) {
      expect(buildConfig(env).plugins?.Keyboard).toEqual({ resize: 'native', autoBackdropColor: 'dom' })
    }
  })

  it('pins the plugin to an exact version and links it into the iOS package', () => {
    const pkg = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8'))
    expect(pkg.dependencies['@capacitor/keyboard']).toBe('8.0.6')
    const spm = readFileSync(new URL('ios/App/CapApp-SPM/Package.swift', ROOT), 'utf8')
    expect(spm).toContain('CapacitorKeyboard')
  })

  it('has no hand-written accessory-bar subclass and no frame hack beyond the hide guard', () => {
    const vc = readFileSync(new URL('ios/App/App/TalosBridgeViewController.swift', ROOT), 'utf8')
    expect(vc).not.toContain('WebViewAccessoryBar')
    expect(vc).toContain('keyboardDidHideNotification')
  })

  it('never drives the plugin from the page', () => {
    const src = new URL('../../web/src/', import.meta.url)
    const hits = (readdirSync(src, { recursive: true, encoding: 'utf8' }) as string[])
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => /setResizeMode|setAccessoryBarVisible/.test(readFileSync(new URL(f, src), 'utf8')))
    expect(hits).toEqual([])
  })
})
