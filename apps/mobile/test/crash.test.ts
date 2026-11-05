// The crash subscriber imports MetricKit, which `swift test` cannot reach and the simulator never fills, so this reads the three
// places its wiring lives: the launch call, `start`, and what `didReceive` and `take` do.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { swiftBody, withoutComments } from './swift-source'

const swift = (f: string) => withoutComments(readFileSync(new URL(`../ios/App/App/${f}`, import.meta.url), 'utf8'))
const src = swift('Plugins/TalosCrash.swift')

describe('crash reports from the system', () => {
  it('the app subscribes at launch, and a report is taken when the system delivers it', () => {
    expect(swiftBody(swift('AppDelegate.swift'), 'didFinishLaunchingWithOptions')).toMatch(
      /^\s*TalosCrashSubscriber\.shared\.start\(\)\s*$/m,
    )
    expect(swiftBody(src, 'func start()')).toMatch(/^\s*MXMetricManager\.shared\.add\(self\)\s*$/)
    expect(swiftBody(src, 'func didReceive')).toMatch(/^\s*take\(payloads\)\s*$/)
    // `take` turns each payload into content-free summaries and queues them; nothing else is kept or sent from here
    expect(swiftBody(src, 'private func take')).toMatch(
      /^\s*for p in payloads \{ TalosCrashStore\.shared\.add\(CrashCore\.summaries\(fromPayloadJSON: p\.jsonRepresentation\(\)\)\) \}\s*$/,
    )
  })

  it('the past payloads are not read at launch (Apple says they leave out earlier launches, so the read adds nothing)', () => {
    expect(src).not.toMatch(/pastDiagnosticPayloads|pastPayloads/)
  })
})
