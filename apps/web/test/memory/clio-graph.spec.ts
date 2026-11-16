// The Clio graph in a real browser (fake mode: the made-up notes in lib/fakeV2.ts). From Clio, Graph opens the 3D view of
// the notes and their links; it says how many it shows, draws into a canvas, and Back returns to Clio. The 3D library loads
// only here.
import { expect, test } from '@playwright/test'

test('Graph opens the notes in 3D, says what it shows, and Back returns to Clio', async ({ page }, info) => {
  await page.goto('/memory')
  await expect(page.getByRole('heading', { level: 1, name: 'Clio' })).toBeVisible()
  await page.getByRole('link', { name: 'Graph' }).click()
  await expect(page).toHaveURL(/\/memory\/graph$/)
  const graph = page.getByTestId('clio-graph')
  await expect(graph.getByRole('heading', { name: 'Clio graph' })).toBeVisible()
  await expect(graph.getByTestId('clio-graph-meta')).toHaveText(/^\d+ notes · \d+ links?$/)
  await expect(graph.locator('canvas')).toHaveCount(1, { timeout: 15_000 })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: info.outputPath(`clio-graph-${info.project.name}.png`) })
  await graph.getByRole('searchbox', { name: 'Find a note' }).fill('zzzz-nothing')
  await expect(graph.getByText('No note matches.')).toBeVisible()
  await graph.getByRole('link', { name: 'Back to Clio' }).click()
  await expect(page).toHaveURL(/\/memory(\?.*)?$/) // a phone opens on its only folder (?r=)
})
