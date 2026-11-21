// The bug reporter in a real browser (fake mode, production build): opened from the palette and from Help, desktop and 375 x 812,
// both themes with axe, the keyboard (focus in, Esc out and back), Blur drawn on the real capture, the preview is the payload,
// and Send reaches the client with a picture. The fake Mac answers `context` from made-up data.
import { expect, type Page } from '@playwright/test'
import { expectAxeClean } from '../cards/e2e.ts'
import { test } from '../helpers/ios-readback.ts'
import { openPalette } from '../helpers/keys.ts'

test.use({ bypassCSP: true, serviceWorkers: 'block' })

async function openFromPalette(page: Page) {
  await page.goto('/')
  await openPalette(page)
  await page.getByRole('combobox').fill('report a bug')
  await page.keyboard.press('Enter')
  // the form loads on first use; on a loaded machine that can take longer than expect's 5 s (see the Help row test)
  await expect(page.getByRole('dialog', { name: 'Report a bug' })).toBeVisible({ timeout: 0 })
}

async function noSidewaysScroll(page: Page) {
  const wide = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  )
  expect(wide).toBe(false)
}

test('palette: Report a bug opens the form with the tools, the fields and the attached list', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'the computer layout; the phone layout has its own test')
  await openFromPalette(page)
  const d = page.getByRole('dialog', { name: 'Report a bug' })
  for (const name of ['Pen', 'Arrow', 'Box', 'Text', 'Blur', 'Undo'])
    await expect(d.getByRole('button', { name: name })).toBeVisible()
  await expect(d.getByRole('radio')).toHaveCount(3)
  await expect(d.getByLabel('What went wrong?')).toBeVisible()
  await expect(d.getByText('Attached automatically')).toBeVisible()
  await expect(d.getByText('Logs, last 200 lines, cleaned')).toBeVisible()
  await expect(d.getByRole('checkbox', { name: 'Last 5 messages in this thread' })).not.toBeChecked() // off by default
  await expect(d.getByText('Keys, sign-in codes and your home folder are removed.', { exact: false })).toBeVisible()
  await expect(
    d.getByText('Goes to: your Talos server and your Mac, with the screenshot. It is not sent anywhere else.'),
  ).toBeVisible()
})

test('nothing is sent without Send, an empty report is refused, and Send needs the words', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'the computer layout; the phone layout has its own test')
  await openFromPalette(page)
  const d = page.getByRole('dialog', { name: 'Report a bug' })
  await d.getByRole('button', { name: 'Send report' }).click()
  await expect(d.getByRole('alert')).toContainText('Tell us what went wrong first.')
  await expect(d.getByText('Sent. Thank you.')).toHaveCount(0)
})

// WebKit on an iPhone, in Safari and in the Mac app cannot read a drawn page back (capture.ts canReadBackPage, 2026-11-15), so
// there it takes no picture and says so; this said WebKit drew one only because Playwright's Linux WebKit can (ios-readback.ts)
test('the screen is really captured where the engine can read it back; WebKit takes none and says so', async ({
  page,
  browserName,
}) => {
  await openFromPalette(page)
  if (browserName === 'webkit') {
    await expect(page.getByTestId('bug-canvas')).toHaveAttribute('data-capture', 'failed')
    await expect(
      page
        .getByRole('dialog', { name: 'Report a bug' })
        .getByText(/can.t take a picture of its own screen here/)
        .filter({ visible: true }), // the phone line also holds every sentence unseen, for its height
    ).toBeVisible()
  } else await expect(page.getByTestId('bug-canvas')).toHaveAttribute('data-capture', 'ok')
})

test('Blur is drawn on the picture, the preview shows the payload, Send finishes', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the computer layout; the phone layout has its own test')
  await openFromPalette(page)
  const d = page.getByRole('dialog', { name: 'Report a bug' })
  await d.getByRole('button', { name: 'Blur' }).click()
  const canvas = d.getByTestId('bug-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('no canvas')
  await page.mouse.move(box.x + 10, box.y + 10)
  await page.mouse.down()
  await page.mouse.move(box.x + 120, box.y + 80, { steps: 4 })
  await page.mouse.up()
  await expect(d.getByRole('button', { name: 'Undo' })).toBeEnabled()
  // the pixels under the blur are in flat blocks: two neighbouring pixels are equal
  const flat = await canvas.evaluate((c: HTMLCanvasElement) => {
    const k = c.width / c.getBoundingClientRect().width
    const x = Math.round(30 * k)
    const y = Math.round(30 * k)
    const px = c.getContext('2d')?.getImageData(x, y, 2, 1).data
    return px ? [px[0] === px[4], px[1] === px[5], px[2] === px[6]] : null
  })
  expect(flat).toEqual([true, true, true])
  await d.getByLabel('What went wrong?').fill('It broke')
  await d.getByRole('button', { name: 'Preview everything that will be sent' }).click()
  await expect(d.getByTestId('bug-preview')).toContainText('"what_went_wrong": "It broke"')
  await d.getByRole('button', { name: 'Send report' }).click()
  await expect(d.getByText('Sent. Thank you.')).toBeVisible()
})

test('Text tool: a word typed on the picture is kept, and Esc in its field leaves the form open', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'the computer layout; the phone layout has its own test')
  await openFromPalette(page)
  const d = page.getByRole('dialog', { name: 'Report a bug' })
  await d.getByRole('button', { name: 'Text' }).click()
  const canvas = d.getByTestId('bug-canvas')
  await canvas.click({ position: { x: 40, y: 40 } })
  await page.keyboard.type('here')
  await page.keyboard.press('Enter')
  await expect(d.getByRole('button', { name: 'Undo' })).toBeEnabled()
  await canvas.click({ position: { x: 60, y: 80 } })
  await page.keyboard.type('dropped')
  await page.keyboard.press('Escape')
  await expect(d).toBeVisible()
  await expect(d.getByLabel('Text to put on the screenshot')).toHaveCount(0)
  // only the first word was kept: one Undo leaves no marks
  await d.getByRole('button', { name: 'Undo' }).click()
  await expect(d.getByRole('button', { name: 'Undo' })).toBeDisabled()
  // Esc on a tick box still closes the form
  await d.getByRole('checkbox', { name: 'Logs, last 200 lines, cleaned' }).focus()
  await page.keyboard.press('Escape')
  await expect(d).toBeHidden()
})

test('keyboard: focus goes into the form and Esc closes it and gives focus back', async ({ page }) => {
  await page.goto('/')
  const opener = page.getByRole('button', { name: /search and commands/i }).first()
  await opener.focus({ timeout: 1000 }).catch(() => undefined)
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox').fill('report a bug')
  await page.keyboard.press('Enter')
  const d = page.getByRole('dialog', { name: 'Report a bug' })
  await expect(d).toBeVisible()
  await page.keyboard.press('Tab')
  expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(d).toBeHidden()
})

test('axe finds nothing serious in both themes', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the computer layout; the phone layout has its own test')
  await openFromPalette(page)
  await page.getByRole('button', { name: 'Preview everything that will be sent' }).click()
  await expectAxeClean(page, ['[role="dialog"]'])
})

test('the form fits the screen: no sideways scroll', async ({ page }) => {
  await openFromPalette(page)
  await noSidewaysScroll(page)
})

test.describe('phone 375 x 812', () => {
  test.use({ viewport: { width: 375, height: 812 } })
  type Sent = Array<{ report: { logs: string; recent_errors: string[]; versions: { bridge: string } } }>
  const sent = (page: Page) =>
    page.evaluate(() =>
      (window as unknown as { __talos: { bugReports: Sent } }).__talos.bugReports.map((r) => r.report),
    )
  /** Replaces the fake Mac's answer to `context` before the form opens: one that never comes, or a refusal. */
  async function macAnswers(page: Page, how: 'never' | 'fails') {
    await page.goto('/')
    await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
    await page.evaluate((h) => {
      const bugs = (window as unknown as { __talos: { bugs: { context: () => Promise<unknown> } } }).__talos.bugs
      bugs.context = () => (h === 'never' ? new Promise(() => undefined) : Promise.reject(new Error('away')))
    }, how)
  }
  async function openHere(page: Page) {
    await page.keyboard.press('ControlOrMeta+k')
    await page.getByRole('combobox').fill('report a bug')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Report a bug' })).toBeVisible()
  }

  test('the phone layout: Cancel, title, Send, the picture, the tool row without inks, the field, the preview row', async ({
    page,
  }, info) => {
    await openFromPalette(page)
    const d = page.getByRole('dialog', { name: 'Report a bug' })
    await expect(d.getByRole('button', { name: 'Cancel' })).toBeVisible()
    await expect(d.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
    for (const name of ['Pen', 'Arrow', 'Box', 'Text', 'Blur', 'Undo'])
      await expect(d.getByRole('button', { name: name })).toBeVisible()
    await expect(d.getByRole('radio')).toHaveCount(0)
    await expect(d.getByTestId('bug-canvas')).toBeVisible()
    await expect(d.getByLabel('What went wrong?')).toBeVisible()
    await expect(d.getByText('Versions, recent errors, cleaned logs')).toBeVisible()
    await expect(d.getByRole('checkbox')).toHaveCount(0)
    await expect(d.getByText('Keys and sign-in codes are removed. Nothing is sent until you tap Send.')).toBeVisible()
    // the picture and the row of tools both fit in the first screen, the field just under them
    const tools = await d.getByRole('button', { name: 'Undo' }).boundingBox()
    expect(tools && tools.y + tools.height).toBeLessThan(812)
    await noSidewaysScroll(page)
    await expectAxeClean(page, ['[role="dialog"]'])
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      await page.screenshot({ path: info.outputPath(`phone-${scheme}.png`) })
    }
  })

  test('Preview opens the tick boxes and the payload; a part left out is not sent', async ({ page }, info) => {
    await openFromPalette(page)
    const d = page.getByRole('dialog', { name: 'Report a bug' })
    await d.getByRole('button', { name: 'Preview' }).click()
    await expect(d.getByRole('heading', { name: 'Attached automatically' })).toBeVisible()
    await expect(d.getByRole('checkbox')).toHaveCount(5)
    await expect(d.getByRole('checkbox', { name: 'Last 5 messages in this thread' })).not.toBeChecked()
    await d.getByRole('checkbox', { name: 'Logs, last 200 lines, cleaned' }).click()
    await d.getByRole('checkbox', { name: 'Recent errors (2)' }).click()
    await expect(d.getByTestId('bug-preview')).not.toContainText('bridge up')
    await noSidewaysScroll(page)
    await expectAxeClean(page, ['[role="dialog"]'])
    await page.screenshot({ path: info.outputPath('phone-preview-dark.png'), fullPage: true })
    await d.getByRole('button', { name: 'Preview' }).click()
    await phoneMarks(page)
    await d.getByLabel('What went wrong?').fill('Phone problem')
    await d.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(d.getByText('Sent. Thank you.')).toBeVisible()
    await expect(d.getByRole('button', { name: 'Done' })).toBeVisible()
    const [report] = await sent(page)
    expect(report?.logs).toBe('')
    expect(report?.recent_errors).toEqual([])
    expect(report?.versions.bridge).toBe('0.4.2')
  })

  /** The picture is centred in its frame, a stroke lands where it was drawn, and a word typed near the right edge stays in view. */
  async function phoneMarks(page: Page) {
    const d = page.getByRole('dialog', { name: 'Report a bug' })
    const canvas = d.getByTestId('bug-canvas')
    await canvas.scrollIntoViewIfNeeded()
    const box = await canvas.boundingBox()
    const frame = await canvas.locator('xpath=../..').boundingBox()
    if (!box || !frame) throw new Error('no canvas')
    expect(Math.abs(box.x + box.width / 2 - (frame.x + frame.width / 2))).toBeLessThan(2)
    const y = Math.round(box.height / 2)
    await page.mouse.move(box.x + 10, box.y + y)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 10, box.y + y, { steps: 6 })
    await page.mouse.up()
    await expect(d.getByRole('button', { name: 'Undo' })).toBeEnabled()
    // the amber ink is on the picture's own pixels under the middle of that stroke
    // (a short column around it: the pointer may be rounded to a whole screen pixel, several picture pixels)
    const amber = await canvas.evaluate(
      (c: HTMLCanvasElement, at) => {
        const k = c.width / c.getBoundingClientRect().width
        const span = Math.ceil(k) * 2
        const d = c.getContext('2d')?.getImageData(Math.round(at.x * k), Math.round(at.y * k) - span, 1, span * 2).data
        for (let i = 0; d && i < d.length; i += 4)
          if (d[i] === 0xf0 && d[i + 1] === 0x92 && d[i + 2] === 0x3a) return true
        return false
      },
      { x: box.width / 2, y },
    )
    expect(amber).toBe(true)
    await d.getByRole('button', { name: 'Text' }).click()
    await canvas.click({ position: { x: box.width - 6, y: 20 } })
    const field = await d.getByLabel('Text to put on the screenshot').boundingBox()
    if (!field) throw new Error('no text field')
    // inside the picture itself, which clips it (the frame around it is wider)
    expect(field.x).toBeGreaterThanOrEqual(box.x - 1)
    expect(field.x + field.width).toBeLessThanOrEqual(box.x + box.width + 1)
    expect(field.y + field.height).toBeLessThanOrEqual(box.y + box.height + 1)
    await page.keyboard.type('here')
    await page.keyboard.press('Enter')
    await d.getByRole('button', { name: 'Pen' }).click()
  }

  test('empty: Send without the words says so and sends nothing', async ({ page }) => {
    await openFromPalette(page)
    const d = page.getByRole('dialog', { name: 'Report a bug' })
    await d.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(d.getByRole('alert')).toContainText('Tell us what went wrong first.')
    expect(await sent(page)).toEqual([])
  })

  test('loading: while the Mac has not answered, Send says it is gathering details and is off', async ({
    page,
  }, info) => {
    await macAnswers(page, 'never')
    await openHere(page)
    const d = page.getByRole('dialog', { name: 'Report a bug' })
    await expect(d.getByRole('button', { name: 'Gathering details…' })).toBeDisabled()
    await noSidewaysScroll(page)
    await expectAxeClean(page, ['[role="dialog"]'])
    await page.screenshot({ path: info.outputPath('phone-loading-dark.png') })
  })

  test('failed: the Mac cannot answer, Send goes with the note; a refused send says so', async ({ page }, info) => {
    await macAnswers(page, 'fails')
    await openHere(page)
    const d = page.getByRole('dialog', { name: 'Report a bug' })
    await expect(d.getByText('Not available from this Mac yet')).toBeVisible()
    await expectAxeClean(page, ['[role="dialog"]'])
    await page.screenshot({ path: info.outputPath('phone-mac-failed-dark.png') })
    await d.getByLabel('What went wrong?').fill('x')
    await page.evaluate(() => {
      const bugs = (window as unknown as { __talos: { bugs: { send: () => Promise<unknown> } } }).__talos.bugs
      const real = bugs.send
      bugs.send = () => {
        bugs.send = real
        return Promise.reject(new Error('no'))
      }
    })
    await d.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(d.getByRole('alert')).toContainText('Could not send the report')
    await page.screenshot({ path: info.outputPath('phone-send-failed-dark.png') })
    await d.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(d.getByText('Sent. Thank you.')).toBeVisible()
    const [report] = await sent(page)
    expect(report?.logs).toBe('Sent without Mac details.')
    expect(report?.versions.bridge).toBe('unknown')
  })
})

test('Help has a Report a bug row that opens the same form', async ({ page }) => {
  await page.goto('/help')
  await page.getByRole('button', { name: 'Report a bug' }).click()
  // the form loads on first use: on a loaded machine that took longer than expect's 5 s, so wait as long as the test may
  await expect(page.getByRole('dialog', { name: 'Report a bug' })).toBeVisible({ timeout: 0 })
})
