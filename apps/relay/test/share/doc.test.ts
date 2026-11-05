// docs/SHARE.md stays true to the code (docs/V2-FEATURES.md V4.6, "Doc test"): the Shortcut recipe uses `file`, the
// manifest uses `files`, and both match the relay's parser. The recipe's own form is posted to a real relay.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SHARE_SECRET_RE } from '@talos-app/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { SHARE_FILE_FIELDS } from '../../src/core/share.ts'
import { ORIGIN, startTestRelay, type TestRelay } from '../core/harness.ts'
import { kit, PNG } from '../core/helpers.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const doc = readFileSync(join(ROOT, 'docs', 'SHARE.md'), 'utf8')
const manifest = JSON.parse(readFileSync(join(ROOT, 'apps', 'web', 'public', 'manifest.webmanifest'), 'utf8'))

const recipeFields = (): Array<{ name: string; value: string }> => {
  const m = /```shortcut-form\n([\s\S]*?)```/.exec(doc)
  if (!m) throw new Error('docs/SHARE.md has no ```shortcut-form block')
  return (m[1] as string)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name = '', ...rest] = l.split('=')
      return { name: name.trim(), value: rest.join('=').trim() }
    })
}

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

describe('docs/SHARE.md', () => {
  it('the recipe sends `file`, the manifest sends `files`, and the relay parser accepts both', () => {
    const names = recipeFields().map((f) => f.name)
    expect(names).toContain('file')
    const target = manifest.share_target
    expect(target.action).toBe('/share-target')
    expect(target.method).toBe('POST')
    expect(target.enctype).toBe('multipart/form-data')
    expect(target.params.files[0].name).toBe('files')
    for (const n of ['file', 'files']) expect(SHARE_FILE_FIELDS).toContain(n)
    for (const n of names) expect(['text', 'url', 'title', 'note', ...SHARE_FILE_FIELDS]).toContain(n)
  })

  it('the manifest params the doc describes are the ones the service worker reads', () => {
    expect(Object.keys(manifest.share_target.params).sort()).toEqual(['files', 'text', 'title', 'url'])
    const sw = readFileSync(join(ROOT, 'apps', 'web', 'src', 'features', 'share', 'shareTarget.ts'), 'utf8')
    for (const k of ['title', 'text', 'url', 'files']) expect(sw).toContain(`'${k}'`)
  })

  it('posting the recipe form (with a photo) to a real relay is accepted', async () => {
    relay = await startTestRelay()
    const dev = 'd_abcdefghijklmnopqrst'
    relay.relay.services.db
      .prepare(
        'insert into auth_devices (id, name, pubkey_jwk, binding, pinned, revoked, created_at) values (?, ?, ?, ?, 1, 0, ?)',
      )
      .run(dev, 'phone', '{}', 'b', Date.now())
    const made = await fetch(`${relay.httpBase}/api/share/tokens`, {
      method: 'POST',
      headers: { 'X-Test-Session': dev, Origin: ORIGIN, 'X-Talos-CSRF': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'doc', scopes: ['text', 'files'] }),
    })
    const { secret } = (await made.json()) as { secret: string }
    expect(secret).toMatch(SHARE_SECRET_RE)
    const bridge = await kit(relay).bridge({ autoReply: false, verifyOwner: false }).connect()
    try {
      const fd = new FormData()
      for (const f of recipeFields()) {
        if (f.name === 'file') fd.append('file', new Blob([PNG as BlobPart], { type: 'image/png' }), 'IMG_0001.png')
        else fd.append(f.name, f.name === 'note' ? 'keep this' : 'https://example.com/doc')
      }
      const res = await fetch(`${relay.httpBase}/api/share`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}` },
        body: fd,
      })
      expect(res.status).toBe(202)
      const item = await bridge.expectFrame('share.item', () => true, { direction: 'in' })
      expect(item.message.text).toBe('keep this')
      expect(item.message.attachments).toHaveLength(1)
    } finally {
      await bridge.close()
    }
  })
})
