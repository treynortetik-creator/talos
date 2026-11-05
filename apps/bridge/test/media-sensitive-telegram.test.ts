// R1-3: the Telegram mirror is gone, but a Telegram token file and the notify env must still never leave the Mac through
// reply/attach, even when they are symlinks to a file with an innocent name. Fixed paths under HOME, resolved at call time.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { paths } from '../src/config.ts'
import { MediaStore } from '../src/media.ts'

const realHome = process.env.HOME
afterEach(() => {
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
})

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'talos-sens-')))
  const home = join(base, 'user')
  mkdirSync(home)
  process.env.HOME = home
  const store = new MediaStore(paths(join(base, 'bridge-home')), {} as never)
  return { base, home, store }
}

describe('isSensitive keeps refusing the Telegram token file and notify.env', () => {
  test('a symlinked ~/.claude/channels/telegram/.env is refused by its real path', () => {
    const { base, home, store } = setup()
    mkdirSync(join(home, '.claude', 'channels', 'telegram'), { recursive: true })
    const real = join(base, 'secrets-token.txt')
    writeFileSync(real, 'TELEGRAM_BOT_TOKEN=x')
    symlinkSync(real, join(home, '.claude', 'channels', 'telegram', '.env'))
    expect(store.isSensitive(realpathSync(real))).toBe(true)
    expect(() => store.checkUploadable(real)).toThrow(/protected file/)
  })
  test('a symlinked ~/.config/talos/notify.env is refused by its real path', () => {
    const { base, home, store } = setup()
    mkdirSync(join(home, '.config', 'talos'), { recursive: true })
    const real = join(base, 'notes.txt')
    writeFileSync(real, 'TALOS_NOTIFY_KEY=x')
    symlinkSync(real, join(home, '.config', 'talos', 'notify.env'))
    expect(() => store.checkUploadable(real)).toThrow(/protected file/)
  })
  test('control: an unrelated file with the same folder name is still allowed', () => {
    const { base, store } = setup()
    const other = join(base, 'photo.txt')
    writeFileSync(other, 'hi')
    expect(store.checkUploadable(other).size).toBe(2)
  })
})
