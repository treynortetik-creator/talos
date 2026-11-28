// The app-bound feature budget (fleet rule, 2026-11-12). The relay passes a page that does not list features-64/1 only the
// first 20 (FEATURES_MAX_V1) of the bridge's list, as the deployed relay gets it. Going past 20 is allowed, but the tail is
// what such a page goes without, so the keep-list (what an older page cannot do without) must stay inside the first 20.
// The count is printed on every run, so a list nearing the line is visible before it bites.
import { expect, test } from 'bun:test'
import {
  bridgeHasFeature,
  DRIVING_FEATURE,
  FEATURES_IMPLIED_FEATURE,
  FEATURES_MAX,
  FEATURES_MAX_V1,
  helloFeatures,
  ORIGINAL_TS_FEATURE,
  RUN_FEATURE,
  SESSION_FEATURE,
  SUBTHREADS_FEATURE,
  THREAD_SESSIONS_FEATURE,
  THREADS_FEATURE,
  WIDE_FEATURES_FEATURE,
} from '@talos-app/protocol'
import { bridgeFeatures, hostFeature } from '../src/handshake.ts'

/**
 * What an older page cannot do without: the thread list and its sessions, the session and run controls, re-signing a
 * message that waited (original-ts), driving mode, sub-threads, and the host (which computer to name).
 */
const APP_KEEP_FEATURES = [
  hostFeature(),
  THREADS_FEATURE,
  THREAD_SESSIONS_FEATURE,
  SESSION_FEATURE,
  RUN_FEATURE,
  ORIGINAL_TS_FEATURE,
  DRIVING_FEATURE,
  SUBTHREADS_FEATURE,
]

test(`with every optional feature on, an older page still gets the keep-list within its ${FEATURES_MAX_V1}`, () => {
  const on = { available: true }
  // every option named, by type: a feature behind a new option cannot be left off here by mistake
  const everything: Required<Parameters<typeof bridgeFeatures>[0]> = {
    search: on,
    memory: on,
    health: on,
    speak: on,
    folders: on,
    files: on,
    agentsMd: on,
    filesPut: on,
    filesSent: on,
    memoryRoots: on,
    problems: {},
    peers: {},
    agentPlugins: {},
    paneRun: on,
    term: on,
    config: { subthreadsSupported: () => true },
  }
  const all = bridgeFeatures(everything)
  // as the deployed relay gets it: the retired features folded into features-implied/1
  const sent = helloFeatures(all, [WIDE_FEATURES_FEATURE, FEATURES_IMPLIED_FEATURE])
  const seen = sent.slice(0, FEATURES_MAX_V1)
  console.log(
    `app-bound bridge features: ${sent.length} (an older page sees ${seen.length}${sent.length > FEATURES_MAX_V1 ? `; goes without: ${sent.slice(FEATURES_MAX_V1).join(', ')}` : ''})`,
  )
  const lost = APP_KEEP_FEATURES.filter((f) => !seen.includes(f))
  if (lost.length > 0)
    throw new Error(
      `an older page would lose ${lost.join(', ')}: keep-list features go before the others in bridgeFeatures (apps/bridge/src/handshake.ts), or one retires`,
    )
  expect(lost).toEqual([])
})

// The first-hello cap (red main 2026-11-13): a bridge sends its first hello before the relay says what it takes, assuming
// the wide list (relay-client.ts). Every feature must fit in that hello, or the tail is cut, and a list the relay would take
// more of is the one that makes a start dial twice (presence flaps, an app's request on the first socket is lost). So the
// whole list, by name or through the marker, fits FEATURES_MAX: a 65th feature fails here, not in the e2e suite.
test(`with every optional feature on, the first hello carries every feature (at most ${FEATURES_MAX})`, () => {
  const on = { available: true }
  const everything: Required<Parameters<typeof bridgeFeatures>[0]> = {
    search: on,
    memory: on,
    health: on,
    speak: on,
    folders: on,
    files: on,
    agentsMd: on,
    filesPut: on,
    filesSent: on,
    memoryRoots: on,
    problems: {},
    peers: {},
    agentPlugins: {},
    paneRun: on,
    term: on,
    config: { subthreadsSupported: () => true },
  }
  const all = bridgeFeatures(everything)
  for (const relay of [[WIDE_FEATURES_FEATURE], [WIDE_FEATURES_FEATURE, FEATURES_IMPLIED_FEATURE]]) {
    const first = helloFeatures(all, relay)
    const cut = all.filter((f) => !bridgeHasFeature(first, f))
    if (cut.length > 0)
      throw new Error(
        `the first hello would leave out ${cut.join(', ')}: ${all.length} bridge features is past the ${FEATURES_MAX} a hello carries; retire one (features-cap.ts) before adding another`,
      )
    expect(cut).toEqual([])
  }
  expect(all.length).toBeLessThanOrEqual(FEATURES_MAX)
})
