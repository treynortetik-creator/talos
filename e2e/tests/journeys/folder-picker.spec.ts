// Journey: choosing a thread's folder instead of typing it. Real relay, real bridge (a fake Claude drives it), real browser.
//   open the thread's settings -> Choose… -> the folder browser lists the Mac's folders (names only, no dot-folders, never
//   ~/.ssh) -> pick Projects/alpha -> Use this folder -> the Mac wrote it into config.json -> the field and the chip show it.
// The Mac's home is a temp folder (HOME for the bridge process), so nothing here reads the real home.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enrollDevice, expect, test, waitUntil } from '../../harness/fixtures.ts'

test.setTimeout(150_000)

test('folder-picker: open settings, Choose…, pick a folder, and the Mac saves it', async ({ stack, page, context }) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'talos-e2e-home-')))
  const agent = join(home, 'talos-agent')
  for (const d of ['Projects/alpha/src', 'Projects/beta', 'Documents', '.ssh/keys', '.cache', 'talos-agent'])
    mkdirSync(join(home, d), { recursive: true })
  writeFileSync(join(home, 'passwords-backup.txt'), 'not a folder')
  writeFileSync(join(home, 'Projects', 'plan.md'), 'not a folder either')

  // thread sessions on, and a thread of its own session: the config file is the Mac's, written here as the owner would
  const cfgPath = join(stack.home, 'config.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  cfg.dedicated = { enabled: true }
  cfg.threads = [
    ...cfg.threads,
    {
      id: 'work',
      name: 'Work',
      kind: 'fixed',
      order: 9,
      notify: 'all',
      voice_context: 'recent',
      archived: false,
      created_at: '2026-10-28T00:00:00.000Z',
      session: 'dedicated',
    },
  ]
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`)
  // the supervisor's heartbeat, kept fresh (the app offers thread sessions only while it is alive)
  const beat = () =>
    writeFileSync(
      join(stack.home, 'workers.json'),
      JSON.stringify({
        v: 1,
        supervisor: { pid: 1, heartbeat_at: new Date().toISOString(), workers_supported: true },
        threads: {},
      }),
    )
  beat()
  const timer = setInterval(beat, 2000)

  const received: string[] = []
  page.on('websocket', (ws) => ws.on('framereceived', (e) => typeof e.payload === 'string' && received.push(e.payload)))

  try {
    await stack.startBridge({ env: { HOME: home, TALOS_AGENT_DIR: agent } })
    await enrollDevice(stack, page, context)
    await page.goto(`${stack.origin}/t/work`)
    await page.getByTestId('thread-settings-trigger').click()
    const sheet = page.getByTestId('thread-settings')
    await expect(sheet.getByTestId('folder-current')).toContainText('~/talos-agent')

    await sheet.getByRole('button', { name: 'Choose…' }).click()
    const browser = sheet.getByTestId('folder-browser')
    await expect(browser.getByRole('button', { name: 'Projects' })).toBeVisible()
    await expect(browser.getByTestId('folder-entry')).toHaveText(['Documents', 'Projects']) // the agent folder is left out too
    await browser.getByLabel('Show hidden').check()
    await expect(browser.getByText('.cache')).toBeVisible()
    await expect(browser.getByText('.ssh')).toHaveCount(0) // a refused folder is not even listed
    await browser.getByRole('button', { name: 'Projects' }).click()
    await browser.getByRole('button', { name: 'alpha' }).click()
    await expect(browser.getByRole('button', { name: 'src' })).toBeVisible()
    await browser.getByRole('button', { name: 'Use this folder' }).click()

    await waitUntil(
      () =>
        JSON.parse(readFileSync(cfgPath, 'utf8')).threads.find((t: { id: string }) => t.id === 'work')?.session_opts
          ?.cwd === join(home, 'Projects', 'alpha'),
      'config.json to hold the chosen folder',
    )
    await expect(sheet.getByTestId('folder-current')).toContainText('~/Projects/alpha')
    await expect(sheet.getByTestId('recent-folders').getByRole('button', { name: '~/Projects/alpha' })).toBeVisible()

    // on the wire: folder names, no file, no secret folder
    const listings = received.filter((t) => t.includes('"fs.listing"'))
    expect(listings.length).toBeGreaterThan(1)
    for (const t of listings) {
      expect(t).not.toContain('passwords-backup')
      expect(t).not.toContain('plan.md')
      expect(t).not.toContain('.ssh')
    }
  } finally {
    clearInterval(timer)
    rmSync(home, { recursive: true, force: true }) // the temp home is the test's own
  }
})
