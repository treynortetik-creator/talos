// Settings > Developer in a real browser (fake mode: the fake client applies dev patches like the Mac). The two rows and Developer
// mode are there; a row's line follows its switch; Developer mode sets every row to its open value.
import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

test('Developer page: a row, then Developer mode', async ({ page }, info) => {
  await page.goto('/settings/developer')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  const mode = page.getByTestId('dev-mode').getByRole('switch')
  const fence = page.getByTestId('dev-row-thread_fence')
  const notes = page.getByTestId('dev-row-note_lookup')
  await expect(mode).toBeVisible()
  await expect(fence).toBeVisible()
  await expect(notes).toBeVisible()
  await expect(fence).toContainText("can't read or write the Talos home")

  await fence.getByRole('switch').click()
  await expect(fence.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  await expect(fence).toContainText('They get the same access the main session has')

  // back to the default (fence on), where Developer mode is off
  await fence.getByRole('switch').click()
  await expect(fence.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  await expect(mode).toHaveAttribute('aria-checked', 'false')
  await mode.click()
  await expect(mode).toHaveAttribute('aria-checked', 'true')
  await expect(fence.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  await expect(notes.getByRole('switch')).toHaveAttribute('aria-checked', 'true')

  // the experimental extra lock: off, with its limits in view, and a tap turns it on (no overflow at phone width)
  const lock = page.getByTestId('dev-row-os_sandbox')
  await lock.scrollIntoViewIfNeeded()
  await expect(lock).toContainText('(experimental)')
  await expect(lock).toContainText("Experimental. It doesn't stop everything:")
  await expect(lock).toContainText('claude mcp add')
  await expect(lock.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  await lock.getByRole('switch').click()
  await expect(lock.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await lock.getByRole('switch').click()
  await expect(lock.getByRole('switch')).toHaveAttribute('aria-checked', 'false')

  await expect(mode).toHaveAttribute('aria-busy', 'false')
  // the switches slide to their new place: let them settle so the picture matches the state
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'))
  // a frame is drawn after the animations ended, so the picture shows the final state
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))))
  await page.screenshot({ path: info.outputPath(`developer-${info.project.name}.png`), fullPage: true })
})
