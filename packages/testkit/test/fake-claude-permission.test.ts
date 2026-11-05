// FakeClaude models Claude Code's side of the permission relay (channels reference, "Relay permission prompts"):
// requests go only to servers that declare the capability; a verdict applies only to an open id it issued; the first
// answer wins (terminal or channel); a repeated id makes every channel verdict for it drop.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FakeClaude, permissionFixtures, waitFor } from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const stub = join(here, 'fixtures', 'stub-permission-channel.ts')
const REQ = {
  request_id: 'abcde',
  tool_name: 'Bash',
  description: 'Run the tests',
  input_preview: '{"command": "pnpm test"}',
}

async function launch(env: Record<string, string>) {
  const claude = new FakeClaude({ command: 'bun', args: ['run', stub], env })
  await claude.start()
  return claude
}

describe('FakeClaude: permission relay', () => {
  it('relays to a server that declares the capability and applies its verdict', async () => {
    const c = await launch({ ANSWER: 'allow' })
    try {
      expect(await c.openPermission(REQ)).toEqual({ relayed: true })
      const v = await c.waitForVerdict('abcde')
      expect(v).toMatchObject({ request_id: 'abcde', behavior: 'allow', outcome: 'applied' })
      expect(c.permissionState('abcde')).toBe('allowed')
    } finally {
      await c.stop()
    }
  })
  it('does not relay to a server without the capability', async () => {
    const c = await launch({ PERMISSION: '0' })
    try {
      expect(await c.openPermission(REQ)).toEqual({ relayed: false })
      expect(c.permissionState('abcde')).toBe('open')
    } finally {
      await c.stop()
    }
  })
  it('drops a verdict for an id it never issued', async () => {
    const c = await launch({ ANSWER: 'wrong_id' })
    try {
      await c.openPermission(REQ)
      await waitFor(() => c.permissionVerdicts.length > 0)
      expect(c.permissionVerdicts[0]).toMatchObject({ request_id: 'zzzzz', outcome: 'unknown_id' })
      expect(c.permissionState('abcde')).toBe('open')
    } finally {
      await c.stop()
    }
  })
  it('first answer wins: a terminal answer closes the request and a later channel verdict is dropped', async () => {
    const c = await launch({ ANSWER: 'none' })
    try {
      await c.openPermission(REQ)
      c.answerAtTerminal('abcde', 'deny')
      expect(c.permissionState('abcde')).toBe('denied')
      expect(c.applyChannelVerdict({ request_id: 'abcde', behavior: 'allow' })).toBe('closed')
      expect(c.permissionState('abcde')).toBe('denied')
    } finally {
      await c.stop()
    }
  })
  it('a repeated id drops every channel verdict for it', async () => {
    const c = await launch({ ANSWER: 'none' })
    try {
      await c.openPermission(REQ)
      c.answerAtTerminal('abcde', 'allow')
      await c.openPermission({ ...REQ, input_preview: '{"command": "rm -rf build"}' })
      expect(c.applyChannelVerdict({ request_id: 'abcde', behavior: 'allow' })).toBe('repeated_id')
      expect(c.permissionState('abcde')).toBe('open')
    } finally {
      await c.stop()
    }
  })
  it('refuses to open a request whose fields break the documented format', async () => {
    const c = await launch({ ANSWER: 'none' })
    try {
      await expect(c.openPermission({ ...REQ, request_id: 'abcdl' })).rejects.toThrow()
    } finally {
      await c.stop()
    }
  })
  it('the doc-shaped fixtures are all valid requests', () => {
    expect(permissionFixtures.length).toBeGreaterThanOrEqual(6)
  })
})
