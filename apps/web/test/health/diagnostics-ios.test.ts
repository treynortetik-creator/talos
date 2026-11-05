import { describe, expect, it } from 'vitest'
import { diagnosticsText, iosAppVersion } from '../../src/features/health/diagnostics.ts'

const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TalosIOS/1.0+12'
const base = { app: '0.0.0', protocol: 1, rows: [], at: null }

// Audit D62: the iPhone app's version and build in Copy diagnostics. The shell appends `TalosIOS/<version>+<build>` to its
// user agent (TalosBridgeViewController.userAgentSuffix); diagnosticsText reads it from there.
describe('D62: iPhone app version and build in the diagnostics text', () => {
  it('reads the version and build from the shell user agent', () => {
    expect(iosAppVersion(UA)).toBe('1.0 (build 12)')
    expect(iosAppVersion(`${UA} Other/1`)).toBe('1.0 (build 12)')
    const text = diagnosticsText({ ...base, where: 'iPhone app', userAgent: UA })
    expect(text).toContain('Running in: iPhone app\niPhone app: 1.0 (build 12)\n')
  })

  it('takes the page user agent when none is passed', () => {
    const was = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: UA } })
    try {
      expect(diagnosticsText({ ...base, where: 'iPhone app' })).toContain('iPhone app: 1.0 (build 12)')
    } finally {
      if (was) Object.defineProperty(globalThis, 'navigator', was)
    }
  })

  it('says so, in words, when an older build sent no version', () => {
    const text = diagnosticsText({ ...base, where: 'iPhone app', userAgent: 'Mozilla/5.0 (iPhone) Mobile/15E148' })
    expect(text).toContain('iPhone app: no version reported (an older build?)')
  })

  it('rejects a token that is not the shell format', () => {
    for (const ua of [
      'x TalosIOS/1.0',
      'x TalosIOS/+12',
      'x TalosIOS/1.0+',
      'xTalosIOS/1.0+12',
      'x TalosIOS/1.0+12<script>',
      `x TalosIOS/${'9'.repeat(40)}+1`,
      'x TalosDesktop/1.0',
    ])
      expect(iosAppVersion(ua), ua).toBeNull()
    expect(iosAppVersion(undefined)).toBeNull()
  })

  it('adds nothing in the Mac app or a browser', () => {
    for (const where of ['Mac app', 'Browser'] as const)
      expect(diagnosticsText({ ...base, where, userAgent: UA })).not.toContain('iPhone app:')
  })

  it('an explicit value wins over the user agent', () => {
    expect(diagnosticsText({ ...base, where: 'iPhone app', iosApp: '2.0 (build 3)', userAgent: UA })).toContain(
      'iPhone app: 2.0 (build 3)',
    )
  })
})
