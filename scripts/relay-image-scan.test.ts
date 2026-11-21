// scripts/relay-image-scan.sh: the release image's filesystem scan, run on small real folders.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const script = join(dirname(fileURLToPath(import.meta.url)), 'relay-image-scan.sh')
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function folder(files: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), 'relay-scan-'))
  dirs.push(d)
  const root = join(d, 'image')
  mkdirSync(root)
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true })
    writeFileSync(join(root, p), body)
  }
  return root
}
const scan = (root: string) =>
  spawnSync('bash', [script, root], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } })
// Built at run time so this file carries no address or home path of its own.
const USERS = ['', 'Users'].join('/')
const MAIL = ['jo.dev', 'gmail.com'].join('@')
const clean = { 'app/dist/index.js': 'console.log(1)\n', 'app/package.json': '{}\n', 'data/.keep': '' }

describe('relay-image-scan.sh', () => {
  it('passes a clean image, printing the file count and the top-level folders', () => {
    const r = scan(folder(clean))
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/2 files in app \(3 in the image\)/)
    expect(r.stdout).toMatch(/top-level of app: dist package\.json/)
  })
  it('looks at /app only: a base-image-like tree (absolute links, a copyright file with addresses, a CA .pem) passes', () => {
    const root = folder({
      ...clean,
      [`usr/share/doc/gawk/copyright`]: `Copyright ${MAIL}\n`,
      'etc/ssl/certs/ca.pem': 'x\n',
      'root/.ssh/id_rsa': 'x\n',
      'usr/bin/mawk': 'bin\n',
    })
    mkdirSync(join(root, 'etc/alternatives'), { recursive: true })
    symlinkSync('/usr/bin/mawk', join(root, 'etc/alternatives/awk'))
    symlinkSync('/etc/alternatives/awk', join(root, 'usr/bin/awk'))
    const r = scan(root)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/in app \(\d+ in the image\)/)
  })
  it('the same shapes inside /app fail: an absolute link, an address, a .pem', () => {
    const root = folder(clean)
    symlinkSync('/usr/bin/awk', join(root, 'app/awk'))
    const r = scan(root)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('app/awk')
    expect(scan(folder({ ...clean, 'app/doc/copyright': `Copyright ${MAIL}\n` })).status).toBe(1)
  })
  it('a relative link inside /app is fine (pnpm node_modules are made of them)', () => {
    const root = folder(clean)
    symlinkSync('dist/index.js', join(root, 'app/main.js'))
    expect(scan(root).status).toBe(0)
  })
  it('an image with no /app is an error, never a pass', () => {
    expect(scan(folder({ 'usr/bin/x': 'x\n' })).status).toBe(2)
  })
  it.each([
    ['a private key block with a key body', `-----BEGIN ${'EC'} PRIVATE KEY-----\nMHcCAQEEIA${'a'.repeat(60)}\n`],
    [
      'a JSON-escaped private key',
      `{"k": "-----BEGIN ${''}PRIVATE KEY-----\\nMIGHAgEAMBMGByqGSM49AgEG${'b'.repeat(40)}"}`,
    ],
    ['a GitHub token', `t = ghp_${'a'.repeat(36)}\n`],
    ['a GitHub oauth token', `t = gho_${'A1'.repeat(15)}\n`],
    ['a fine-grained GitHub token', `t = github_pat_${'a1_'.repeat(20)}\n`],
    ['an Anthropic key', `k = sk-ant-${'api03-'}${'x'.repeat(30)}\n`],
    ['an AWS access key id', `id = AKIA${'ABCDEFGH12345678'}\n`],
    ['a Slack token', `t = xox${'b'}-${'1234567890'}-abcdef\n`],
  ])('refuses %s anywhere in /app (node_modules too), naming the file, never the text', (_n, text) => {
    const r = scan(folder({ ...clean, 'app/node_modules/dep/index.js': text }))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('app/node_modules/dep/index.js')
    expect(r.stderr).not.toContain('xxxxxxxx')
    expect(r.stderr).not.toContain('aaaaaaaa')
  })
  it('passes a bundle that only holds redaction patterns, not values', () => {
    const redactor = [
      'const re = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]+?-----END [A-Z ]*PRIVATE KEY-----/g',
      'const gh = /gh[pousr]_[A-Za-z0-9]{36,}/g, a = /AKIA[0-9A-Z]{16}/g, s = /sk-ant-[A-Za-z0-9_-]+/g, x = /xox[abp]-[0-9A-Za-z-]+/g',
      "const pat = 'github_pat_'",
      '',
    ].join('\n')
    expect(scan(folder({ ...clean, 'app/dist/index.js': redactor })).status).toBe(0)
  })
  it.each([
    ['.env', 'app/.env'],
    ['.env.production', 'app/.env.production'],
    ['a .pem', 'app/certs/server.pem'],
    ['a .key', 'app/tls.key'],
    ['an id_ key', 'app/.ssh/id_ed25519'],
    ['a .p12', 'app/cert.p12'],
    ['a .git folder', 'app/.git/HEAD'],
  ])('refuses %s', (_n, path) => {
    const r = scan(folder({ ...clean, [path]: 'x\n' }))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(path.replace(/\/HEAD$/, ''))
  })
  it('refuses an .npmrc with a token, passes one without', () => {
    expect(scan(folder({ ...clean, 'app/.npmrc': '//registry.example.org/:_authToken=abc123\n' })).status).toBe(1)
    expect(scan(folder({ ...clean, 'app/.npmrc': 'registry=https://registry.example.org/\n' })).status).toBe(0)
  })
  it('refuses text the personal-data check refuses (a home path of a real-looking user)', () => {
    const r = scan(folder({ ...clean, 'app/dist/x.js': `const p = "${USERS}/jdoe/code"\n` }))
    expect(r.status).toBe(1)
    expect(r.stderr).not.toContain('jdoe')
  })
  it('ignores an author e-mail in a bundled web asset only, not in the relay bundle or any other rule', () => {
    const banner = `/*! lib (c) Jo Dev <${MAIL}> MIT */\n`
    expect(scan(folder({ ...clean, 'app/web/assets/lib-AbC123.js': banner })).status).toBe(0)
    expect(scan(folder({ ...clean, 'app/dist/index.js': banner })).status).toBe(1)
    expect(scan(folder({ ...clean, 'app/web/assets/lib-AbC123.js': `${banner}${USERS}/jdoe/x\n` })).status).toBe(1)
  })
  it('an empty folder or a missing one is an error, never a pass', () => {
    expect(scan(folder({})).status).not.toBe(0)
    expect(scan('/nonexistent-relay-scan-dir').status).not.toBe(0)
  })
})
