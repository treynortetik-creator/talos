// Push-notification regression tests, shell and repo side. Each test pins a bug that was found and fixed. The Swift below imports UIKit, so `swift test` cannot reach it;
// these read the source the same way config.test.ts does. They pin the behaviour named in each finding, not one exact fix.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { swiftBody, withoutComments } from './swift-source'

const ROOT = new URL('..', import.meta.url)
const REPO = fileURLToPath(new URL('../../..', import.meta.url))
const read = (f: string) => readFileSync(new URL(f, ROOT), 'utf8')

describe('I5-L5 git never holds the APNs key', () => {
  it('L5 the AuthKey_XXXXXXXXXX.p8 that docs/IOS-PUSH.md has the owner download is gitignored', () => {
    const r = spawnSync('git', ['check-ignore', '-q', 'apps/mobile/ios/AuthKey_ABCDE12345.p8'], { cwd: REPO })
    expect(r.status).toBe(0)
  })
})

describe('I5-L6 CI runs the new Swift tests', () => {
  it('L6 scripts/ci-local.sh runs TalosPushCore in the loop that runs swift test on the other Swift packages', () => {
    const ci = readFileSync(new URL('scripts/ci-local.sh', `file://${REPO}`), 'utf8')
    expect(ci).toMatch(/for pkg in [^;\n]*\bTalosPushCore\b[^;\n]*; do\n[^\n]*swift test /)
  })
})

describe('I5-L7 which APNs host the app reports', () => {
  it('L7 env comes from how the build was signed (the provisioning profile), not from the Swift DEBUG flag', () => {
    // A Release configuration signed for development is a sandbox token reported as production: BadDeviceToken, deleted.
    // PushCore.environment is covered by PushCoreTests; here the token that is reported must come from it.
    const plugin = withoutComments(read('ios/App/App/Plugins/TalosPush.swift'))
    expect(plugin).toMatch(/"env": PushCore\.environment\(provisioningProfile: Self\.provisioningProfile\)/)
    expect(plugin).not.toMatch(/#if DEBUG|isDebug/)
  })
})

describe('I5-L8 a stale timer', () => {
  it('L8 the 10 s timeout of an answered request is cancelled with it, so it cannot reject a newer one', () => {
    const plugin = withoutComments(read('ios/App/App/Plugins/TalosPush.swift'))
    // answering takes the guard down before it answers anyone
    const finish = swiftBody(plugin, 'private func finish')
    expect(finish).toMatch(/^\s*timeoutGuard\?\.cancel\(\)\s*timeoutGuard = nil/)
    // the one timer is a work item that is kept, so it can be cancelled; there is no bare asyncAfter closure
    const ask = swiftBody(plugin, 'private func ask')
    expect(ask).toMatch(/let guardItem = DispatchWorkItem/)
    expect(ask).toMatch(/self\.timeoutGuard = guardItem/)
    expect(ask).toMatch(/asyncAfter\(deadline: \.now\(\) \+ Self\.timeout, execute: guardItem\)/)
    expect(plugin.match(/asyncAfter/g)).toHaveLength(1)
  })
})

describe('I5-L3 why iOS refused a token', () => {
  it('L3 the page is told the reason iOS gave, not a blanket failure', () => {
    // PushCore.registrationFailureCode (PushCoreTests) tells "capability missing" from "try again later"
    const failed = swiftBody(
      withoutComments(read('ios/App/App/AppDelegate.swift')),
      'didFailToRegisterForRemoteNotificationsWithError',
    )
    expect(failed).toMatch(
      /post\(name: \.talosPushFailed, object: PushCore\.registrationFailureCode\(domain: e\.domain, code: e\.code\)\)/,
    )
    // and the plugin hands that code to the page
    expect(withoutComments(read('ios/App/App/Plugins/TalosPush.swift'))).toMatch(
      /let code = \(n\.object as\? String\) \?\? "failed"/,
    )
  })
})
