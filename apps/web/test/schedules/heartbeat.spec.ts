// HB5: the Heartbeat part of the Schedules tab, in the real shell on the fake client. Phone (iPhone = WebKit, Pixel =
// Chromium) and desktop, light and dark, by keyboard, and in the loading / empty / failed / partial states. Screenshots for
// review go to proof/ at the repo root only when HB5_PROOF=1 (never committed).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { expectAxeClean } from '../cards/e2e.ts'
import { NOW_ISO } from './clock.ts'
import type { VariantName } from './variants.ts'

test.use({ bypassCSP: true })

async function open(page: Page, route: string, variant: VariantName | null, o: { offline?: boolean } = {}) {
  await page.clock.install({ time: new Date(NOW_ISO) })
  const q = new URLSearchParams({ route })
  if (variant) q.set('variant', variant)
  if (o.offline) q.set('offline', '1')
  await page.goto(`/test/schedules/harness/index.html?${q}`)
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
}
const sent = (page: Page): Promise<Array<Record<string, unknown>>> =>
  page.evaluate(() => JSON.parse(JSON.stringify(window.__talos.sent)))
const hbMode = (page: Page, mode: Window['__hb']['mode']) =>
  page.evaluate((m) => {
    window.__hb.mode = m
  }, mode)
/** The fake config has only General and Inbox: add two ordinary threads, as an owner would have. */
const addThreads = (page: Page) =>
  page.evaluate(() => {
    const c = window.__talos
    const st = c.store.getState()
    if (!st.config) return
    const mk = (id: string, name: string) =>
      ({ ...st.config?.threads[0], id, name, kind: 'normal', archived: false }) as never
    const threads = [...st.config.threads, mk('trips', 'Trips'), mk('heartbeat', 'Heartbeat')]
    c.store.setState({ ...st, config: { ...st.config, threads }, threads })
  })
const row = (page: Page) => page.getByTestId('heartbeat-row')
const outcome = (page: Page) => page.getByTestId('heartbeat-outcome')
const detail = (page: Page) => page.getByTestId('schedule-detail')

const PROOF = process.env.HB5_PROOF ? join(process.cwd(), '..', '..', 'proof') : null
async function shot(page: Page, name: string, info: { project: { name: string } }, scheme: string) {
  if (!PROOF) return
  mkdirSync(PROOF, { recursive: true })
  await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' })
  await page.screenshot({ path: join(PROOF, `${name}-${info.project.name}-${scheme}.png`) })
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme })

    test('the row is pinned above Today and says how the last check went, in words', async ({ page }, info) => {
      await open(page, '/schedules', 'heartbeatOn')
      await expect(row(page)).toBeVisible()
      await expect(page.locator('section[data-group] h2')).toHaveText(['Heartbeat', 'Today'])
      // pinned, not also listed as an ordinary job
      await expect(page.getByTestId('schedule-row-heartbeat')).toHaveCount(0)
      await expect(outcome(page)).toHaveText(/Nothing new/)
      await expect(outcome(page)).toHaveAttribute('data-outcome', 'silent')
      await expect(row(page)).toContainText('Weekdays, 4 times a day')
      await expect(row(page)).toContainText('next today 12:15 PM')
      await expect(row(page)).toContainText('up to 3 wakes a day')
      await shot(page, 'list-quiet', info, scheme) // before axe: that helper leaves the page in dark
      await expectAxeClean(page)
    })

    for (const [variant, key, words] of [
      ['heartbeatPartial', 'partial', "Couldn't check github"],
      ['heartbeatFailed', 'failed', 'Check failed'],
      ['heartbeatBusy', 'busy', 'Busy: the last wake is still open'],
      ['heartbeatWoke', 'woke', 'Checked in, 2 items'],
      ['heartbeatUnknown', 'unknown', 'Unknown'],
    ] as const) {
      test(`${variant}: ${words}`, async ({ page }, info) => {
        await open(page, '/schedules', variant)
        await expect(outcome(page)).toHaveAttribute('data-outcome', key)
        await expect(outcome(page)).toContainText(words)
        await expect(outcome(page)).not.toContainText('Nothing new')
        await shot(page, `list-${key}`, info, scheme)
        await expectAxeClean(page)
      })
    }

    test('only a heartbeat: no "no jobs" page, the row is the list', async ({ page }) => {
      await open(page, '/schedules', 'heartbeatOnly')
      await expect(row(page)).toBeVisible()
      await expect(page.getByText('No scheduled jobs yet')).toHaveCount(0)
    })

    test('detail: sources exactly as set, last result per source with unreadable counts, mutes', async ({
      page,
    }, info) => {
      await open(page, '/schedules/heartbeat', 'heartbeatPartial')
      await expect(detail(page)).toBeVisible()
      const gh = page.getByTestId('hb-source-github')
      await expect(page.getByTestId('heartbeat-detail-outcome')).toHaveText("Couldn't check github")
      await expect(gh).toContainText('Kind: github')
      await expect(gh).toContainText('Class: your own content')
      await expect(gh).toContainText('example-org/example-repo')
      await expect(page.getByTestId('hb-last-github')).toContainText('Last check failed')
      await expect(page.getByTestId('hb-last-inbox')).toContainText("2 couldn't be read")
      await expect(page.getByTestId('hb-last-disk')).toContainText('Last check ok')
      // argv is shown word by word, JSON-quoted, so the space inside the first word is visible and nothing is joined
      await expect(page.getByTestId('hb-argv-disk')).toContainText(
        'Runs: "/home/alex/bin/check disk" "--quiet" "$HOME"',
      )
      await expect(page.getByTestId('hb-argv-disk')).toContainText('In: "/home/alex"')
      await expect(page.getByTestId('hb-argv-disk')).toContainText('With: MODE="brief"')
      await expect(page.getByRole('list', { name: 'Muted' })).toContainText('pr:example-org/example-repo#12')
      await shot(page, 'detail-partial', info, scheme)
      await expectAxeClean(page)
    })

    test('test sheet: loading, then a pass opens Turn on', async ({ page }, info) => {
      await open(page, '/schedules/heartbeat', 'heartbeatOff')
      await hbMode(page, 'hang')
      await page.getByRole('button', { name: 'Test run' }).click()
      const sheet = page.getByTestId('heartbeat-test-sheet')
      await expect(sheet).toBeVisible()
      await sheet.getByRole('button', { name: 'Run test' }).click()
      await expect(sheet.getByTestId('test-running')).toBeVisible()
      await expect(sheet.getByRole('button', { name: 'Turn on' })).toBeDisabled()
      await shot(page, 'test-loading', info, scheme)
      await page.evaluate(() => window.__hb.release?.())
      await expect(sheet.getByTestId('test-result')).toBeVisible()
      await expect(sheet.getByTestId('test-empty')).toBeVisible()
      await expect(sheet.getByRole('button', { name: 'Turn on' })).toBeEnabled()
      await shot(page, 'test-pass-empty', info, scheme)
      await expectAxeClean(page)
    })

    test('test sheet: a failed source keeps Turn on disabled and names what to fix; hostile text is escaped', async ({
      page,
    }, info) => {
      await open(page, '/schedules/heartbeat', 'heartbeatOff')
      await hbMode(page, 'fail')
      await page.getByRole('button', { name: 'Test run' }).click()
      const sheet = page.getByTestId('heartbeat-test-sheet')
      await sheet.getByRole('button', { name: 'Run test' }).click()
      await expect(sheet.getByTestId('test-source-github')).toContainText('gh is not signed in ⟦U+202E⟧')
      await expect(sheet.getByTestId('test-not-passed')).toContainText('Fix github')
      await expect(sheet.getByRole('button', { name: 'Turn on' })).toBeDisabled()
      await shot(page, 'test-failed-source', info, scheme)
      await expectAxeClean(page)
    })

    test('test sheet: partly unreadable is not a pass', async ({ page }, info) => {
      await open(page, '/schedules/heartbeat', 'heartbeatOff')
      await hbMode(page, 'partial')
      await page.getByRole('button', { name: 'Test run' }).click()
      const sheet = page.getByTestId('heartbeat-test-sheet')
      await sheet.getByRole('button', { name: 'Run test' }).click()
      await expect(sheet.getByTestId('test-source-github')).toContainText("2 couldn't be read")
      await expect(sheet.getByRole('button', { name: 'Turn on' })).toBeDisabled()
      await shot(page, 'test-partial', info, scheme)
    })

    test('test sheet: the Mac does not answer', async ({ page }, info) => {
      await open(page, '/schedules/heartbeat', 'heartbeatOff')
      await hbMode(page, 'no_answer')
      await page.getByRole('button', { name: 'Test run' }).click()
      const sheet = page.getByTestId('heartbeat-test-sheet')
      await sheet.getByRole('button', { name: 'Run test' }).click()
      await expect(sheet.getByTestId('test-failed')).toContainText("Your Mac didn't answer")
      await expect(sheet.getByRole('button', { name: 'Turn on' })).toBeDisabled()
      await expect(sheet.getByRole('button', { name: 'Test again' })).toBeEnabled()
      await shot(page, 'test-no-answer', info, scheme)
    })

    test('setup form on a phone: errors under their fields, then a test', async ({ page }, info) => {
      await open(page, '/schedules/heartbeat/new', 'heartbeatNone')
      await expect(page.getByTestId('heartbeat-setup')).toBeVisible()
      await page.getByLabel('Last check').fill('08:00')
      await page.getByRole('button', { name: 'Test run' }).click()
      await expect(page.getByText('The last check must be after the first.')).toBeVisible()
      await expect(page.getByText('Pick a thread for it')).toBeVisible()
      await shot(page, 'setup-errors', info, scheme)
      await expectAxeClean(page)
    })
  })
}

test.describe('the gate on Turn on', () => {
  test('a heartbeat that is off cannot be turned on before a test passes: no card, no frame', async ({ page }) => {
    await open(page, '/schedules/heartbeat', 'heartbeatOff')
    const turnOn = page.getByRole('button', { name: 'Turn on', exact: true })
    await expect(turnOn).toBeDisabled()
    await expect(page.getByTestId('hb-gate-note')).toContainText('needs a passing test')
    // the generic route is gone: the action bar has no Turn on for a heartbeat
    await expect(page.getByTestId('action-bar').getByRole('button', { name: 'Turn on' })).toHaveCount(0)
    expect((await sent(page)).filter((f) => f.type === 'schedule.patch')).toHaveLength(0)
  })

  test('after a pass, Turn on sends one schedule.patch (enabled only) and shows the card; nothing is written', async ({
    page,
  }) => {
    await open(page, '/schedules/heartbeat', 'heartbeatOff')
    await page.getByRole('button', { name: 'Test run' }).click()
    const sheet = page.getByTestId('heartbeat-test-sheet')
    await sheet.getByRole('button', { name: 'Run test' }).click()
    await sheet.getByRole('button', { name: 'Turn on' }).click()
    const proposal = page.getByTestId('proposal-sheet')
    await expect(proposal).toBeVisible()
    await expect(proposal).toContainText('Nothing is saved until you approve the card.')
    const patches = (await sent(page)).filter((f) => f.type === 'schedule.patch')
    expect(patches).toHaveLength(1)
    expect(patches[0]?.change).toMatchObject({ op: 'update', id: 'heartbeat', set: { enabled: true } })
    const tests = (await sent(page)).filter((f) => f.type === 'heartbeat.test')
    expect(tests).toHaveLength(1)
    expect(tests[0]).toMatchObject({ window_h: 24, with_agent: false })
  })

  test('a result for other settings does not open it', async ({ page }) => {
    await open(page, '/schedules/heartbeat', 'heartbeatOff')
    await hbMode(page, 'other_config')
    await page.getByRole('button', { name: 'Test run' }).click()
    const sheet = page.getByTestId('heartbeat-test-sheet')
    await sheet.getByRole('button', { name: 'Run test' }).click()
    await expect(sheet.getByTestId('test-not-passed')).toContainText('different settings')
    await expect(sheet.getByRole('button', { name: 'Turn on' })).toBeDisabled()
  })

  test('a result that cannot be read is a failed test, in words', async ({ page }) => {
    await open(page, '/schedules/heartbeat', 'heartbeatOff')
    await hbMode(page, 'junk')
    await page.getByRole('button', { name: 'Test run' }).click()
    const sheet = page.getByTestId('heartbeat-test-sheet')
    await sheet.getByRole('button', { name: 'Run test' }).click()
    await expect(sheet.getByTestId('test-failed')).toContainText('not readable')
    await expect(sheet.getByRole('button', { name: 'Turn on' })).toBeDisabled()
  })

  test('a second tap while a test runs sends one frame', async ({ page }) => {
    await open(page, '/schedules/heartbeat', 'heartbeatOff')
    await hbMode(page, 'hang')
    await page.getByRole('button', { name: 'Test run' }).click()
    const sheet = page.getByTestId('heartbeat-test-sheet')
    await sheet.getByRole('button', { name: 'Run test' }).dispatchEvent('click')
    await sheet.getByRole('button', { name: /Run test|Test again/ }).dispatchEvent('click')
    await expect(sheet.getByTestId('test-running')).toBeVisible()
    expect((await sent(page)).filter((f) => f.type === 'heartbeat.test')).toHaveLength(1)
  })
})

const cacheWritten = (page: Page) =>
  page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        const o = indexedDB.open('talos-app')
        o.onsuccess = () => {
          const r = o.result.transaction('schedules').objectStore('schedules').get('snapshot')
          r.onsuccess = () => resolve(Boolean(r.result))
          r.onerror = () => resolve(false)
        }
        o.onerror = () => resolve(false)
      }),
  )

test.describe('Mac offline', () => {
  test('the cached row stays with its last outcome; its switch, the list actions and the detail actions are disabled', async ({
    page,
  }) => {
    await open(page, '/schedules', 'heartbeatOff')
    await expect(row(page)).toBeVisible()
    await cacheWritten(page)
    await page.evaluate(() => window.__talos.setMacOnline(false))
    await expect(page.getByTestId('offline-banner')).toBeVisible()
    await expect(row(page)).toBeVisible()
    await expect(page.getByRole('button', { name: 'New' })).toBeDisabled()
    await row(page).getByRole('link').click()
    await expect(detail(page)).toBeVisible()
    for (const b of ['Test run', 'Add a mute'])
      await expect(page.getByRole('button', { name: b, exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Turn on', exact: true })).toBeDisabled()
    // nothing was sent on the Mac's behalf
    expect((await sent(page)).filter((f) => f.type === 'heartbeat.test' || f.type === 'schedule.patch')).toHaveLength(0)
  })

  test('a running heartbeat offline: the row keeps its words and the pause switch is off the table', async ({
    page,
  }) => {
    await open(page, '/schedules', 'heartbeatPartial')
    await cacheWritten(page)
    await page.evaluate(() => window.__talos.setMacOnline(false))
    await expect(outcome(page)).toContainText("Couldn't check github")
    await expect(row(page).getByRole('switch')).toBeDisabled()
  })

  test('a cold start with the Mac away shows the cached heartbeat row', async ({ page }) => {
    await open(page, '/schedules', 'heartbeatPartial')
    await expect(row(page)).toBeVisible()
    await cacheWritten(page)
    await page.clock.install({ time: new Date(NOW_ISO) })
    await page.goto('/test/schedules/harness/index.html?route=/schedules&offline=1')
    await expect(outcome(page)).toContainText("Couldn't check github")
    await expect(row(page).getByRole('switch')).toBeDisabled()
  })
})

test.describe('[+ New] and setup', () => {
  test('Heartbeat is offered when none exists, and not when one does', async ({ page }) => {
    await open(page, '/schedules', 'heartbeatNone')
    await page.getByRole('button', { name: 'New' }).click()
    await expect(page.getByRole('button', { name: 'Heartbeat' })).toBeVisible()
    await open(page, '/schedules', 'heartbeatOn')
    await page.getByRole('button', { name: 'New' }).click()
    await expect(page.getByRole('button', { name: 'Fill in a form' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Heartbeat' })).toHaveCount(0)
  })

  test('it is not offered to a Mac without schedules/2', async ({ page }) => {
    await open(page, '/schedules', 'heartbeatNone')
    await page.evaluate(() => {
      const c = window.__talos
      const s = c.store.getState()
      c.store.setState({ ...s, presence: { ...s.presence, features: ['schedules/1'] } })
    })
    await page.getByRole('button', { name: 'New' }).click()
    await expect(page.getByRole('button', { name: 'Fill in a form' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Heartbeat' })).toHaveCount(0)
  })

  test("the whole way, by keyboard: New, Heartbeat, fill, test, Turn on sends one create with the job's own thread", async ({
    page,
  }) => {
    await open(page, '/schedules', 'heartbeatNone')
    await page.getByRole('button', { name: 'New' }).focus()
    await page.keyboard.press('Enter')
    const choice = page.getByRole('button', { name: 'Heartbeat' })
    await expect(choice).toBeVisible()
    await choice.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('heartbeat-setup')).toBeVisible()
    await addThreads(page)
    const thread = page.getByTestId('heartbeat-setup').getByLabel('Thread')
    await thread.focus()
    // WebKit opens a native popup on ArrowDown instead of stepping the value, so the choice itself is made with selectOption
    await thread.selectOption({ label: 'Heartbeat' })
    const picked = await thread.inputValue()
    expect(picked).not.toBe('')
    await page.getByRole('button', { name: 'Test run' }).focus()
    await page.keyboard.press('Enter')
    const sheet = page.getByTestId('heartbeat-test-sheet')
    await expect(sheet).toBeVisible()
    // focus is inside the dialog
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true)
    await expect(sheet.getByRole('button', { name: 'Turn on' })).toBeDisabled()
    await sheet.getByRole('button', { name: 'Run test' }).focus()
    await page.keyboard.press('Enter')
    await expect(sheet.getByRole('button', { name: 'Turn on' })).toBeEnabled()
    await sheet.getByRole('button', { name: 'Turn on' }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('proposal-sheet')).toBeVisible()
    const patches = (await sent(page)).filter((f) => f.type === 'schedule.patch')
    expect(patches).toHaveLength(1)
    const change = patches[0]?.change as { op: string; draft: Record<string, unknown> }
    expect(change.op).toBe('create')
    expect(change.draft).toMatchObject({
      name: 'Heartbeat',
      enabled: true,
      runner: 'session',
      thread_id: picked,
      when: { type: 'times', days: 'weekdays', times: ['09:45', '12:15', '14:45', '17:15'] },
    })
    expect(JSON.stringify(change.draft.meta)).toContain('"mode":"shadow"')
    expect(patches[0]?.thread_id).toBe(picked)
  })

  test('Escape closes the test sheet and focus goes back to the button that opened it', async ({ page }) => {
    await open(page, '/schedules/heartbeat', 'heartbeatOff')
    const trigger = page.getByRole('button', { name: 'Test run' })
    await trigger.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('heartbeat-test-sheet')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('heartbeat-test-sheet')).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })
})

test.describe('mutes', () => {
  test('Remove sends a patch whose meta lacks only that mute, and shows the card', async ({ page }) => {
    await open(page, '/schedules/heartbeat', 'heartbeatOn')
    await page.getByRole('button', { name: /Remove mute pr:/ }).click()
    await expect(page.getByTestId('proposal-sheet')).toBeVisible()
    const p = (await sent(page)).filter((f) => f.type === 'schedule.patch')
    expect(p).toHaveLength(1)
    type Change = { set: { meta: { 'talos.heartbeat': { mutes: unknown[]; sources: unknown[] } } } }
    const hb = (p[0]?.change as Change | undefined)?.set.meta['talos.heartbeat']
    expect(hb?.mutes).toEqual([])
    expect(hb?.sources).toHaveLength(3)
  })

  test('Add: a key mutes one item; a blank key warns that it mutes the whole source', async ({ page }) => {
    await open(page, '/schedules/heartbeat', 'heartbeatOn')
    await page.getByRole('button', { name: 'Add a mute' }).click()
    const sheet = page.getByTestId('hb-mute-sheet')
    await expect(sheet.getByTestId('hb-mute-whole')).toContainText('mutes everything from github')
    await sheet.getByLabel('Item key').fill('pr:example-org/example-repo#99')
    await expect(sheet.getByTestId('hb-mute-whole')).toHaveCount(0)
    await sheet.getByRole('button', { name: 'Review on a card' }).click()
    await expect(page.getByTestId('proposal-sheet')).toBeVisible()
    const p = (await sent(page)).filter((f) => f.type === 'schedule.patch')
    type Change = { set: { meta: { 'talos.heartbeat': { mutes: Array<{ key?: string; until: string }> } } } }
    const mutes = (p[0]?.change as Change | undefined)?.set.meta['talos.heartbeat'].mutes ?? []
    expect(mutes).toHaveLength(2)
    expect(mutes[1]).toMatchObject({ key: 'pr:example-org/example-repo#99' })
  })

  test('a heartbeat with a source from a newer Talos says so and cannot be changed from the app', async ({ page }) => {
    await open(page, '/schedules/heartbeat', 'heartbeatNewerSource')
    await expect(page.getByTestId('hb-skipped')).toContainText('from a newer Talos')
    await expect(page.getByRole('button', { name: 'Add a mute' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Test run' })).toBeDisabled()
    // the row still draws: one unknown source costs that source, not the list
    await open(page, '/schedules', 'heartbeatNewerSource')
    await expect(row(page)).toBeVisible()
  })
})

test.describe('review round 1', () => {
  test('R1-1: bidi and zero-width characters in argv, cwd and env are shown as visible markers, never raw', async ({
    page,
  }) => {
    await open(page, '/schedules/heartbeat', 'heartbeatHostile')
    const argv = page.getByTestId('hb-argv-disk')
    await expect(argv).toContainText('"safe⟦U+202E⟧evil"')
    await expect(argv).toContainText('"a⟦U+200B⟧b"')
    await expect(argv).toContainText('In: "/home/alex/⟦U+2066⟧x"')
    await expect(argv).toContainText('MODE="br⟦U+202E⟧ief"')
    const raw = await argv.innerText()
    expect(raw).not.toMatch(/[\u202e\u200b\u2066]/)
  })

  test('R1-5: the thread picker leaves out General and Inbox, and leaves a thread another job uses', async ({
    page,
  }) => {
    await open(page, '/schedules/heartbeat/new', 'heartbeatNone')
    await addThreads(page)
    const options = await page.getByTestId('heartbeat-setup').getByLabel('Thread').locator('option').allInnerTexts()
    expect(options).toEqual(['Pick a thread', 'Trips', 'Heartbeat'])
    expect(options).not.toContain('General')
    expect(options).not.toContain('Inbox')
    await page.evaluate(() => {
      const c = window.__talos
      const st = c.store.getState()
      const snap = st.schedules.snapshot
      if (snap)
        c.store.setState({
          ...st,
          schedules: {
            ...st.schedules,
            snapshot: { ...snap, schedules: snap.schedules.map((x) => ({ ...x, thread_id: 'trips' })) },
          },
        })
    })
    await expect(page.getByTestId('heartbeat-setup').getByLabel('Thread').locator('option')).toHaveText([
      'Pick a thread',
      'Heartbeat',
    ])
  })

  test('R1-5: with no Heartbeat thread yet, making one is the offered way (its name starts as Heartbeat)', async ({
    page,
  }) => {
    await open(page, '/schedules/heartbeat/new', 'heartbeatNone')
    await page.getByRole('button', { name: 'New thread' }).click()
    await expect(page.getByTestId('thread-settings').getByRole('textbox').first()).toHaveValue('Heartbeat')
  })

  test('R1-9: a re-test that gets no answer, or an unreadable one, keeps a pass that is still good; a real failing result replaces it', async ({
    page,
  }) => {
    await open(page, '/schedules/heartbeat', 'heartbeatOff')
    await page.getByRole('button', { name: 'Test run' }).click()
    const sheet = page.getByTestId('heartbeat-test-sheet')
    await sheet.getByRole('button', { name: 'Run test' }).click()
    await expect(sheet.getByRole('button', { name: 'Turn on' })).toBeEnabled()
    for (const mode of ['no_answer', 'junk'] as const) {
      await hbMode(page, mode)
      await sheet.getByRole('button', { name: 'Test again' }).click()
      await expect(sheet.getByTestId('test-retest-failed')).toBeVisible()
      await expect(sheet.getByTestId('test-result')).toBeVisible()
      await expect(sheet.getByRole('button', { name: 'Turn on' })).toBeEnabled()
    }
    await hbMode(page, 'fail')
    await sheet.getByRole('button', { name: 'Test again' }).click()
    await expect(sheet.getByTestId('test-not-passed')).toBeVisible()
    await expect(sheet.getByRole('button', { name: 'Turn on' })).toBeDisabled()
  })

  test('R1-13: a failed submit puts focus on the first field with an error, and it is in view', async ({ page }) => {
    await open(page, '/schedules/heartbeat/new', 'heartbeatNone')
    await page.getByLabel('Last check').fill('08:00')
    await page.getByRole('button', { name: 'Test run' }).click()
    const last = page.getByLabel('Last check')
    await expect(last).toBeFocused()
    await expect(last).toHaveAttribute('aria-invalid', 'true')
    await expect(last).toBeInViewport()
  })

  test('R1-13: when only the thread is missing, the thread picker gets focus; when no source is on, the sources message does', async ({
    page,
  }) => {
    await open(page, '/schedules/heartbeat/new', 'heartbeatNone')
    await page.getByRole('button', { name: 'Test run' }).click()
    await expect(page.getByTestId('heartbeat-setup').getByLabel('Thread')).toBeFocused()
    await page.getByLabel('Failed scheduled jobs').uncheck()
    await page.getByLabel('Inbox', { exact: true }).uncheck()
    await page.getByRole('button', { name: 'Test run' }).click()
    await expect(page.getByTestId('hb-sources-error')).toBeFocused()
  })
})
