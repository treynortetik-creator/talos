// WP-I6: Associated Domains (passkeys in the iPhone web view) lives ONLY in the opt-in push entitlements file, so a free
// Personal Team build stays signable. These read the committed files; a drift fails here, not on someone's phone.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../ios/${rel}`, import.meta.url)), 'utf8')
const KEY = 'com.apple.developer.associated-domains'

describe('associated-domains entitlement', () => {
  it('is NOT in the default (free-tier) entitlements, the share extension, or anything project.yml makes default', () => {
    expect(read('App/App/App.entitlements')).not.toContain(KEY)
    expect(read('TalosShareExtension/TalosShareExtension.entitlements')).not.toContain(KEY)
    expect(read('App/project.yml')).not.toMatch(/associated-domains|webcredentials/)
    expect(read('Signing.xcconfig')).toMatch(/^TALOS_APP_ENTITLEMENTS = App\/App\.entitlements$/m)
  })

  it('is in AppPush.entitlements as webcredentials for the configured relay host, and nothing else', () => {
    const push = read('App/App/AppPush.entitlements')
    const m = push.match(new RegExp(`<key>${KEY}</key>\\s*<array>([\\s\\S]*?)</array>`))
    expect(m).not.toBeNull()
    const strings = [...(m?.[1] ?? '').matchAll(/<string>(.*?)<\/string>/g)].map((x) => x[1])
    expect(strings).toEqual(['webcredentials:$(TALOS_RELAY_HOST)'])
    // no applinks: universal links are a later package
    expect(push).not.toMatch(/applinks:/)
  })

  it('has a harmless committed default for the host, set before Local.xcconfig can override it', () => {
    const x = read('Signing.xcconfig')
    const def = x.indexOf('TALOS_RELAY_HOST = unset.invalid')
    const include = x.indexOf('#include? "Local.xcconfig"')
    expect(def).toBeGreaterThan(-1)
    expect(include).toBeGreaterThan(def)
  })

  it('commits no real team id or host', () => {
    for (const f of ['App/App/AppPush.entitlements', 'Signing.xcconfig']) {
      expect(read(f)).not.toMatch(/\.up\.railway\.app|DEVELOPMENT_TEAM = [A-Z0-9]{10}/)
    }
  })
})
