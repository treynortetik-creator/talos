#!/usr/bin/env node
// Microphone preflight for the local CI browser job (scripts/ci-local.sh, docs/CI-LOCAL.md).
// On the CI Mac, Chromium's getUserMedia({audio:true}) sometimes never answers even with the fake-device flags (a stuck macOS
// audio device). The voice specs then time out one by one. This asks once, with a hard limit, and says so plainly.
//   prints `ok` and exits 0            getUserMedia answered
//   prints `stuck` and exits 3         it did not answer in time
//   prints `error: <why>` and exits 2  the check itself could not run (no browser, launch failed): never read as ok
// It never hangs: one overall timer, and the browser is closed in `finally` under its own limit.
import { pathToFileURL } from 'node:url'

export const TIMEOUT_MS = 8000 // for getUserMedia to answer
export const LAUNCH_MS = 30000 // for Chromium to start and load the page: a loaded Mac can be slow, and that is not a stuck microphone
// The same flags apps/web/playwright.config.ts gives the chromium-media project.
export const MEDIA_ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
const ORIGIN = 'https://mic-preflight.invalid/' // a secure origin, answered from memory below: nothing goes on the network
const TIMEOUT = Symbol('timeout')

const within = (p, ms) => {
  let t
  const timer = new Promise((r) => {
    t = setTimeout(() => r(TIMEOUT), ms)
  })
  return Promise.race([p, timer]).finally(() => clearTimeout(t))
}

/** launch: () => Promise<Browser>, injectable for tests. Returns {status: 'ok' | 'stuck' | 'error', detail?}. */
export async function preflight({ launch, timeoutMs = TIMEOUT_MS, launchMs = LAUNCH_MS } = {}) {
  let browser
  try {
    // Two limits: starting Chromium can be slow on a loaded Mac, which is not a stuck microphone.
    const start = (async () => {
      browser = await launch()
      const context = await browser.newContext({ permissions: ['microphone'] })
      const page = await context.newPage()
      await page.route('**/*', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>mic</title>' }),
      )
      await page.goto(ORIGIN)
      return page
    })()
    start.catch(() => {}) // a failure after the timer won is not an unhandled rejection
    const page = await within(start, launchMs)
    // Only an unanswered getUserMedia is "stuck"; a browser that never got that far is a broken check.
    if (page === TIMEOUT) return { status: 'error', detail: `the browser did not reach getUserMedia in ${launchMs} ms` }
    const ask = page.evaluate(async () => {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true })
      for (const t of s.getTracks()) t.stop()
    })
    ask.catch(() => {})
    const res = await within(ask, timeoutMs)
    return res === TIMEOUT ? { status: 'stuck' } : { status: 'ok' }
  } catch (e) {
    return { status: 'error', detail: e instanceof Error ? e.message : String(e) }
  } finally {
    if (browser)
      await within(
        Promise.resolve()
          .then(() => browser.close())
          .catch(() => {}),
        3000,
      )
  }
}

async function main() {
  const { chromium } = await import('@playwright/test')
  const r = await preflight({
    launch: () =>
      chromium.launch({ args: MEDIA_ARGS, executablePath: process.env.MIC_PREFLIGHT_CHROMIUM || undefined }),
  })
  console.log(r.status === 'error' ? `error: ${r.detail}` : r.status)
  // exit explicitly: a wedged browser process must not keep node alive
  process.exit(r.status === 'ok' ? 0 : r.status === 'stuck' ? 3 : 2)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  setTimeout(
    () => {
      console.log('error: the preflight itself ran past its hard limit')
      process.exit(2)
    },
    LAUNCH_MS + TIMEOUT_MS + 6000,
  ).unref()
  main().catch((e) => {
    console.log(`error: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(2)
  })
}
