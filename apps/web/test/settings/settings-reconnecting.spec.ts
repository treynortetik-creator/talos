// Settings while this device's connection is down (fake mode, phone and desktop). A switch tapped as the socket dropped used
// to look like a tap that did nothing: the refusal was written at the bottom of the section, off-screen on a phone. Now the
// note is under the switch, in plain words, and while the connection comes back the controls are greyed and say why.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { NOT_CONNECTED_LINE } from '../../src/features/settings/offline.ts'
import { DROPPED_MAYBE_CHANGED, OFFLINE_NOT_CHANGED } from '../../src/features/threads/manage/useThreadPatch.ts'

test.use({ bypassCSP: true, serviceWorkers: 'block' })
const SHOTS = process.env.SHOT_DIR
type Talos = {
  failNextPatchWith: (code: string, message?: string, how?: 'not_sent' | 'no_answer') => void
  setConnection: (state: 'connecting' | 'online' | 'offline' | 'unreachable') => void
  setMacOnline: (on: boolean) => void
  emit: (type: string, fields: Record<string, unknown>) => void
}
const talos = (page: Page, f: (t: Talos) => void) => page.evaluate(`(${f.toString()})(window.__talos)`)
const master = (page: Page) => page.getByRole('switch', { name: 'Chat notifications' })

async function open(page: Page, section: string) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`/settings/${section}`)
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
}

test.beforeEach(async ({ page }, info) => {
  if (info.title.startsWith('[')) return // the cross-section tests open their own section
  await open(page, 'notifications')
  await expect(master(page)).toBeEnabled()
})

/** The note is the next thing under the switch's row, and in view: not at the end of the section. */
async function noteUnderSwitch(page: Page, text: string) {
  const note = page.getByTestId('notifications-note')
  await expect(note).toHaveText(text)
  await expect(note).toBeInViewport()
  const sw = await master(page).boundingBox()
  const box = await note.boundingBox()
  if (!sw || !box) throw new Error('no layout')
  expect(box.y).toBeGreaterThan(sw.y)
  expect(box.y - (sw.y + sw.height)).toBeLessThan(48)
}

test('a switch refused because the change never left the phone stays put and says so under itself', async ({
  page,
}, info) => {
  const before = await master(page).getAttribute('aria-checked')
  await talos(page, (t) => t.failNextPatchWith('internal', "You're offline.", 'not_sent'))
  await master(page).click()
  await noteUnderSwitch(page, OFFLINE_NOT_CHANGED)
  await expect(master(page)).toHaveAttribute('aria-checked', before ?? 'true')
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true })
    await page.screenshot({ path: join(SHOTS, `${info.project.name}-note-under-switch.png`) })
  }
  // the next tap that goes through clears it
  await master(page).click()
  await expect(page.getByTestId('notifications-note')).toHaveCount(0)
  await expect(master(page)).not.toHaveAttribute('aria-checked', before ?? 'true')
})

test('a change the dropped connection lost the answer to says it may still apply, not that nothing changed', async ({
  page,
}) => {
  await talos(page, (t) => t.failNextPatchWith('internal', 'Connection lost', 'no_answer'))
  await master(page).click()
  await noteUnderSwitch(page, DROPPED_MAYBE_CHANGED)
})

test('while the connection comes back the controls are greyed and say why; they come back with it', async ({
  page,
}, info) => {
  await talos(page, (t) => t.setConnection('connecting'))
  await expect(page.getByTestId('settings-not-connected')).toBeVisible()
  await expect(master(page)).toBeDisabled()
  await expect(page.locator('#names')).toBeDisabled()
  // and looks it: a switch that can't work must not look like one that can
  await expect(master(page)).toHaveCSS('opacity', '0.5')
  // it is this device reconnecting, not the Mac offline: no Mac wording
  await expect(body(page).getByText(/Mac is offline/)).toHaveCount(0)
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true })
    await page.screenshot({ path: join(SHOTS, `${info.project.name}-greyed-reconnecting.png`) })
  }
  await talos(page, (t) => t.setConnection('online'))
  await expect(page.getByTestId('settings-not-connected')).toHaveCount(0)
  await expect(master(page)).toBeEnabled()
  await expect(master(page)).toHaveCSS('opacity', '1')
  await expect(page.locator('#names')).toBeEnabled()
  const was = await master(page).getAttribute('aria-checked')
  await master(page).click() // and a tap works again: the switch moves once the change is saved
  await expect(master(page)).not.toHaveAttribute('aria-checked', was ?? '')
  await expect(page.getByTestId('notifications-note')).toHaveCount(0)
})

test('a refused quiet-hours switch shows one message, under quiet hours, with no "Not saved" of its own', async ({
  page,
}) => {
  const quiet = page.getByRole('switch', { name: 'Quiet hours' })
  await talos(page, (t) => t.failNextPatchWith('internal', 'Connection lost', 'no_answer'))
  await quiet.click()
  const qbox = page.getByTestId('quiet-window')
  const note = page.getByTestId('notifications-note')
  await expect(note).toHaveText(DROPPED_MAYBE_CHANGED)
  await expect(page.getByText(/Not saved/)).toHaveCount(0)
  const q = await qbox.boundingBox()
  const n = await note.boundingBox()
  if (!q || !n) throw new Error('no layout')
  expect(n.y).toBeGreaterThanOrEqual(q.y + q.height - 1) // right after the quiet-hours block
  expect(n.y - (q.y + q.height)).toBeLessThan(48)
})

// One rule for every control that changes the Mac's config: not connected is never "Mac is offline", is said in one sentence,
// and every control that can't work is disabled and looks it. The Mac really offline still says so.
const MAC_WORDS = /(Mac|computer):? (is )?(offline|has to be online)/
const body = (page: Page) => page.getByTestId('settings-body')

test('[voice] not connected: greyed, one line, no Mac wording (driving mode too); back with the connection', async ({
  page,
}) => {
  await open(page, 'voice')
  const driving = page.locator('#driving-mode')
  await talos(page, (t) => t.setConnection('offline'))
  await expect(page.getByTestId('settings-not-connected')).toHaveText(NOT_CONNECTED_LINE)
  await expect(body(page).getByText(MAC_WORDS)).toHaveCount(0)
  await expect(driving).toBeDisabled()
  await expect(driving).toHaveCSS('opacity', '0.5')
  const voice = page.locator('select').first() // the voice picker: a select, greyed by the one CSS rule
  await expect(voice).toBeDisabled()
  await expect(voice).toHaveCSS('opacity', '0.5')
  await talos(page, (t) => t.setConnection('online'))
  await expect(page.getByTestId('settings-not-connected')).toHaveCount(0)
  await expect(voice).toBeEnabled()
  await expect(voice).toHaveCSS('opacity', '1')
})

test('[voice] the Mac offline (and connected) still says the Mac is offline', async ({ page }) => {
  await open(page, 'voice')
  await talos(page, (t) => t.setMacOnline(false))
  await expect(body(page).getByText(MAC_WORDS).first()).toBeVisible()
  await expect(page.getByTestId('settings-not-connected')).toHaveCount(0)
})

test('[agent] not connected: the restart row says the one line when tapped, never "Mac is offline"', async ({
  page,
}) => {
  await open(page, 'agent')
  await expect(page.getByRole('button', { name: 'Restart agent' })).toBeVisible()
  await talos(page, (t) => t.setConnection('connecting'))
  await expect(page.getByTestId('settings-not-connected')).toBeVisible()
  await expect(page.getByTestId('agent-recover-offline')).toHaveCount(0)
  await page.getByRole('button', { name: 'Restart agent' }).click()
  await expect(page.getByRole('alert').filter({ hasText: NOT_CONNECTED_LINE })).toBeVisible()
  await expect(body(page).getByText(MAC_WORDS)).toHaveCount(0)
})

test('[account] trust mode, outside the greyed sections, is disabled and says the same line itself', async ({
  page,
}) => {
  await open(page, 'account')
  const sw = page.getByRole('switch', { name: /Trust mode/ })
  await expect(sw).toBeEnabled()
  await talos(page, (t) => t.setConnection('unreachable'))
  await expect(sw).toBeDisabled()
  await expect(sw).toHaveCSS('opacity', '0.5')
  await expect(page.getByTestId('trust-mode-state').getByText(NOT_CONNECTED_LINE)).toBeVisible()
  await expect(body(page).getByText(MAC_WORDS)).toHaveCount(0)
  await talos(page, (t) => t.setConnection('online'))
  await expect(sw).toBeEnabled()
})

test('[agent] not connected: Set up my agent, which stays tappable, says the one line', async ({ page }) => {
  await open(page, 'agent')
  const setup = page.getByRole('button', { name: 'Set up my agent' })
  await expect(setup).toBeVisible()
  await talos(page, (t) => t.setConnection('offline'))
  await setup.click()
  await expect(page.getByRole('alert').filter({ hasText: NOT_CONNECTED_LINE })).toBeVisible()
})

test('[voice] a refused spoken-replies pick is the one whole sentence, with nothing in front', async ({ page }) => {
  await open(page, 'voice')
  const pick = page.getByLabel('Spoken replies')
  await expect(pick).toBeEnabled()
  const other = await pick.evaluate(
    (el: HTMLSelectElement) => [...el.options].map((o) => o.value).find((v) => v !== el.value) ?? '',
  )
  await talos(page, (t) => t.failNextPatchWith('internal', "You're offline.", 'not_sent'))
  await pick.selectOption(other)
  await expect(body(page).getByText(OFFLINE_NOT_CHANGED, { exact: true })).toBeVisible()
  await expect(body(page).getByText(/Couldn.t change/)).toHaveCount(0)
})

test('[integrations] not connected: the work controls are greyed and say the one line, not "Mac is offline"', async ({
  page,
}) => {
  await open(page, 'integrations')
  const thread = page.getByTestId('work-thread').locator('select')
  await expect(thread).toBeEnabled()
  await talos(page, (t) => t.setConnection('connecting'))
  await expect(thread).toBeDisabled()
  await expect(thread).toHaveCSS('opacity', '0.5')
  await expect(page.getByRole('region', { name: 'Integrations' }).getByText(NOT_CONNECTED_LINE)).toBeVisible()
  await expect(page.getByRole('region', { name: 'Integrations' }).getByText(MAC_WORDS)).toHaveCount(0)
  await talos(page, (t) => t.setConnection('online'))
  await expect(thread).toBeEnabled()
})

test('[appearance] not connected: the theme buttons are greyed and say the one line', async ({ page }) => {
  await open(page, 'appearance')
  const radios = page.getByRole('radiogroup', { name: 'Colour theme' }).getByRole('radio')
  await expect(radios.first()).toBeEnabled()
  await talos(page, (t) => t.setConnection('offline'))
  await expect(radios.first()).toBeDisabled()
  await expect(radios.first()).toHaveCSS('opacity', '0.5')
  await expect(body(page).getByText(NOT_CONNECTED_LINE)).toBeVisible()
  await talos(page, (t) => t.setConnection('online'))
  await expect(radios.first()).toBeEnabled()
})

test('[thread sessions] a limit’s error is under that limit, not below them all', async ({ page }) => {
  await open(page, 'thread-sessions')
  await talos(page, (t) =>
    t.emit('workers.status', {
      status: {
        supported: true,
        supervisor_online: true,
        threads: [],
        governor: { state: 'ok' },
        at: new Date().toISOString(),
      },
    }),
  )
  const box = page.getByLabel('Agents running at once')
  await expect(box).toBeEnabled()
  await box.fill('9999')
  await box.blur()
  const err = page.getByTestId('limits-error')
  await expect(err).toBeVisible()
  const b = await box.boundingBox()
  const e = await err.boundingBox()
  if (!b || !e) throw new Error('no layout')
  expect(e.y).toBeGreaterThan(b.y)
  expect(e.y - (b.y + b.height)).toBeLessThan(64) // under its own box (its hint between), not after the last limit
  const last = await page.getByLabel('Park every agent at (usage, %)').boundingBox()
  if (!last) throw new Error('no layout')
  expect(e.y).toBeLessThan(last.y)
})

test('[session] not connected: no stale "Mac offline", and every control greyed (menus open too), until it is back', async ({
  page,
}) => {
  await open(page, 'session')
  // the Mac last heard offline: the section says so while this device is connected
  await talos(page, (t) => t.setMacOnline(false))
  await expect(body(page).getByText(MAC_WORDS).first()).toBeVisible()
  // connected but the Mac offline: a control can't work either, so it is greyed too
  await expect(page.getByRole('button', { name: /^Model/ })).toBeDisabled()
  await talos(page, (t) => t.setMacOnline(true))
  // open what hides controls: the model menu and the Start new confirm
  await page.getByRole('button', { name: /^Model/ }).click()
  const radios = page.getByRole('radiogroup', { name: 'Model' }).getByRole('radio')
  await expect(radios.first()).toBeVisible()
  await page
    .getByRole('button', { name: /Start new|New conversation|Clear/ })
    .first()
    .click()
  const startNew = page.getByRole('button', { name: 'Start new' })
  await expect(startNew).toBeVisible()
  // every control that sends something (Cancel only closes the confirm, here on the phone: it stays usable)
  const controls = page
    .getByTestId('session-controls')
    .getByRole('button')
    .filter({ hasNotText: /^Cancel$/ })
  const n = await controls.count()
  expect(n).toBeGreaterThan(1)
  // last heard offline, then this device lost its connection: it must not say the Mac is offline
  await talos(page, (t) => t.setMacOnline(false))
  await talos(page, (t) => t.setConnection('offline'))
  await expect(page.getByTestId('settings-not-connected')).toHaveText(NOT_CONNECTED_LINE)
  await expect(body(page).getByText(MAC_WORDS)).toHaveCount(0)
  for (let i = 0; i < n; i++) await expect(controls.nth(i)).toBeDisabled()
  await expect(radios.first()).toBeDisabled()
  await expect(radios.first()).toHaveCSS('opacity', '0.5')
  await expect(startNew).toBeDisabled()
  await talos(page, (t) => t.setMacOnline(true))
  await talos(page, (t) => t.setConnection('online'))
  await expect(startNew).toBeEnabled()
  await expect(radios.first()).toBeEnabled()
})

test('a tap refused just as the connection drops: its note under the switch once, the line at the top once', async ({
  page,
}) => {
  // the race Titan saw: the screen still showed online, the socket was already down
  await talos(page, (t) => t.failNextPatchWith('internal', "You're offline.", 'not_sent'))
  await master(page).click()
  await talos(page, (t) => t.setConnection('connecting'))
  await expect(page.getByTestId('notifications-note')).toHaveCount(1)
  await expect(page.getByTestId('notifications-note')).toHaveText(OFFLINE_NOT_CHANGED) // what happened to that tap
  await expect(page.getByTestId('settings-not-connected')).toHaveCount(1) // and what is true now
  await expect(body(page).getByText(MAC_WORDS)).toHaveCount(0)
  await expect(master(page)).toBeDisabled()
})
