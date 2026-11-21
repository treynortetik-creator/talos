// .github/workflows/relay-image.yml: the release image workflow. It reads the YAML as text (the repo has no YAML parser, like the
// other workflow tests) and runs the two decision steps' own bash against a stub gh, so the version and :stable rules are the real ones.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const yml = readFileSync(join(here, '../.github/workflows/relay-image.yml'), 'utf8')
const lines = yml.split('\n')
const code = lines.filter((l) => !/^\s*#/.test(l)).join('\n')

type Step = { name: string; id: string; ifExpr: string; run: string; text: string }
// Steps of the one job: blocks starting at "      - " (6 spaces) until the next one.
const steps: Step[] = []
{
  const start = lines.findIndex((l) => /^ {4}steps:/.test(l))
  let cur: string[] = []
  const flush = () => {
    if (!cur.length) return
    const text = cur.join('\n')
    const runAt = cur.findIndex((l) => /^ {8}run: \|/.test(l))
    const run =
      runAt < 0
        ? ''
        : cur
            .slice(runAt + 1)
            .map((l) => l.replace(/^ {10}/, ''))
            .join('\n')
    steps.push({
      name: /name: (.*)/.exec(text)?.[1] ?? '',
      id: /^ {8}id: (\S+)/m.exec(text)?.[1] ?? '',
      ifExpr: /^ {8}if: (.*)/m.exec(text)?.[1] ?? '',
      run,
      text,
    })
    cur = []
  }
  for (const l of lines.slice(start + 1)) {
    if (/^ {6}- /.test(l)) flush()
    cur.push(l)
  }
  flush()
}
const step = (id: string) => {
  const s = steps.find((x) => x.id === id)
  if (!s) throw new Error(`no step with id ${id}`)
  return s
}
const pushes = (s: Step) => /docker push|docker login/.test(s.run)

describe('triggers, repository, permissions', () => {
  it('runs on a published release and by hand with a version, and on nothing else', () => {
    const on = /^on:\n((?: {2}.*\n|\n)+)/m.exec(yml)?.[1] ?? ''
    expect(on).toMatch(/^ {2}release:\n {4}types: \[published\]/m)
    expect(on).toMatch(/^ {2}workflow_dispatch:\n {4}inputs:\n {6}version:/m)
    expect(on.match(/^ {2}[a-z_]+:/gm)).toEqual(['  release:', '  workflow_dispatch:'])
  })
  it('names the public repository the Mac app clones, and runs only there', () => {
    const swift = readFileSync(join(here, '../apps/desktop/Sources/TalosSupervisor/CloneProvisioner.swift'), 'utf8')
    const pub = /publicRepo = "https:\/\/github\.com\/([^"]+)"/.exec(swift)?.[1]
    expect(pub).toBeTruthy()
    const job = /^ {2}image:\n(?: {4}.*\n)*?^ {4}if: (.*)$/m.exec(yml)?.[1] ?? ''
    expect(job).toContain(`github.repository == '${pub}'`)
    expect(yml.match(new RegExp(pub as string, 'g'))?.length).toBe(1)
  })
  it('a dispatch counts only from main', () => {
    expect(/^ {4}if: (.*)$/m.exec(yml)?.[1]).toContain("github.ref == 'refs/heads/main'")
  })
  it('has permissions {} at the top and exactly contents: read + packages: write on the one job', () => {
    expect(yml).toMatch(/^permissions: \{\}$/m)
    expect(yml.match(/^ {2}[a-z-]+:$/gm)?.filter((j) => !/^ {2}(release|workflow_dispatch):$/.test(j))).toEqual([
      '  image:',
    ])
    const perm = /^ {4}permissions:\n((?: {6}\S.*\n)+)/m.exec(yml)?.[1] ?? ''
    expect(
      perm
        .split('\n')
        .filter(Boolean)
        .map((l) => l.replace(/ #.*$/, '').trim()),
    ).toEqual(['contents: read', 'packages: write'])
    expect(code.match(/permissions:/g)?.length).toBe(2)
  })
  it('uses no secret but the job token', () => {
    const names = [...code.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1])
    expect(names.every((n) => n === 'GITHUB_TOKEN')).toBe(true)
  })
  it('never puts an expression inside a run block (values go through env)', () => {
    for (const s of steps) expect(s.run, s.name).not.toContain('${{')
  })
  it('pins every action by commit sha, checks out the tag with no kept credentials', () => {
    for (const m of code.matchAll(/uses: (\S+)/g)) expect(m[1]).toMatch(/@[0-9a-f]{40}$/)
    const co = steps.find((s) => /actions\/checkout/.test(s.text))
    expect(co?.text).toMatch(/ref: refs\/tags\/\$\{\{ steps\.version\.outputs\.tag \}\}/)
    expect(co?.text).toContain('persist-credentials: false')
  })
})

describe('order and guards', () => {
  it('the image scan comes before every login and push', () => {
    const scan = steps.findIndex((s) => /relay-image-scan\.sh/.test(s.run))
    expect(scan).toBeGreaterThan(0)
    const first = steps.findIndex(pushes)
    expect(first).toBeGreaterThan(scan)
    expect(steps.slice(0, scan).some(pushes)).toBe(false)
    expect(steps.findIndex((s) => /docker build/.test(s.run))).toBeLessThan(scan)
  })
  it('the scan runs on an exported copy of the built image', () => {
    const s = steps.find((x) => /relay-image-scan\.sh/.test(x.run))
    expect(s?.run).toMatch(/docker create/)
    expect(s?.run).toMatch(/docker export/)
  })
  it('refuses a clean-checkout violation before building', () => {
    const clean = steps.findIndex((s) => /git status --porcelain/.test(s.run))
    expect(clean).toBeGreaterThan(-1)
    expect(clean).toBeLessThan(steps.findIndex((s) => /docker build/.test(s.run)))
  })
  it('builds with the release build arg and the three labels', () => {
    const b = steps.find((s) => /docker build/.test(s.run))?.run ?? ''
    expect(b).toContain('--build-arg TALOS_RELEASE="$VERSION"')
    expect(b).toContain('org.opencontainers.image.source=')
    expect(b).toContain('org.opencontainers.image.version=')
    expect(b).toContain('org.opencontainers.image.revision=')
    expect(b).toContain('-f apps/relay/Dockerfile')
  })
  it('the version tag is refused when it exists', () => {
    const p = steps.find((s) => /docker push/.test(s.run) && !/:stable/.test(s.run))
    const exists = steps.find((s) => /docker manifest inspect/.test(s.run))
    expect(exists).toBeTruthy()
    expect(steps.indexOf(exists as Step)).toBeLessThan(steps.indexOf(p as Step))
  })
  it('never pushes :latest', () => {
    expect(code).not.toMatch(/:latest|\/latest|tag latest/i)
  })
  it(':stable is pushed once, in a step guarded by the newest-release check', () => {
    const stable = steps.filter((s) => /docker (push|tag)\b.*:stable/.test(s.run))
    expect(stable).toHaveLength(1)
    expect(stable[0].ifExpr).toContain("steps.newest.outputs.stable == 'true'")
    expect(step('newest').run).toMatch(/sort -V/)
    expect(steps.indexOf(step('newest'))).toBeLessThan(steps.indexOf(stable[0]))
  })
  it('ends with a summary of the version, the digest and whether :stable moved', () => {
    const last = steps[steps.length - 1].run
    expect(last).toMatch(/VERSION/)
    expect(last).toMatch(/DIGEST/)
    expect(last).toMatch(/STABLE/)
  })
})

// The two decision steps, run for real with a gh that answers from files.
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function runStep(id: string, env: Record<string, string>, gh: { code: number; out?: string }) {
  const d = mkdtempSync(join(tmpdir(), 'relay-image-'))
  dirs.push(d)
  writeFileSync(join(d, 'gh'), `#!/bin/sh\nprintf '%s' "$GH_OUT"\nexit ${gh.code}\n`)
  chmodSync(join(d, 'gh'), 0o755)
  writeFileSync(join(d, 'out'), '')
  const r = spawnSync('bash', ['-c', step(id).run], {
    env: {
      PATH: `${d}:/usr/bin:/bin`,
      GITHUB_OUTPUT: join(d, 'out'),
      GH_OUT: gh.out ?? '',
      REPO: 'example/talos',
      ...env,
    },
    encoding: 'utf8',
  })
  const out = Object.fromEntries(
    readFileSync(join(d, 'out'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  )
  return { status: r.status, out, text: r.stdout + r.stderr }
}
const rel = (tag: string, extra: Record<string, string> = {}) => ({
  EVENT_NAME: 'release',
  TAG: tag,
  DRAFT: 'false',
  PRERELEASE: 'false',
  INPUT_VERSION: '',
  ...extra,
})

describe('the version step', () => {
  it('a published mac-v release gives its version and tag', () => {
    const r = runStep('version', rel('mac-v0.1.8'), { code: 0 })
    expect(r.status).toBe(0)
    expect(r.out).toMatchObject({ publish: 'true', version: '0.1.8', tag: 'mac-v0.1.8' })
  })
  it.each([
    ['a prerelease', rel('mac-v0.1.8', { PRERELEASE: 'true' })],
    ['a draft', rel('mac-v0.1.8', { DRAFT: 'true' })],
    ['a suffix', rel('mac-v0.1.8-rc1')],
    ['a leading zero', rel('mac-v01.2.3')],
    ['two parts', rel('mac-v0.1')],
    ['another prefix', rel('v0.1.8')],
    ['an injected tag', rel('mac-v0.1.8";touch pwned;"')],
  ])('%s: says so, exits 0, publishes nothing', (_n, env) => {
    const r = runStep('version', env, { code: 0 })
    expect(r.status).toBe(0)
    expect(r.out.publish).toBe('false')
    expect(r.text).toMatch(/not published|no image/i)
  })
  const dispatch = { EVENT_NAME: 'workflow_dispatch', TAG: '', DRAFT: '', PRERELEASE: '', INPUT_VERSION: '0.1.6' }
  it('a dispatch for a published release gives its version and tag', () => {
    const r = runStep('version', dispatch, { code: 0, out: 'false false' })
    expect(r.status).toBe(0)
    expect(r.out).toMatchObject({ publish: 'true', version: '0.1.6', tag: 'mac-v0.1.6' })
  })
  it('a dispatch looks the release up (not just the tag)', () => {
    expect(step('version').run).toMatch(/gh api "repos\/\$REPO\/releases\/tags\/mac-v\$VERSION"/)
  })
  it.each([
    ['a prerelease', 'false true'],
    ['a draft', 'true false'],
    ['a draft prerelease', 'true true'],
  ])('a dispatch for %s: says so, exits 0, publishes nothing', (_n, out) => {
    const r = runStep('version', dispatch, { code: 0, out })
    expect(r.status).toBe(0)
    expect(r.out.publish).toBe('false')
    expect(r.text).toMatch(/not published/i)
  })
  it('a dispatch for a tag with no release (a draft reads as none) or an unreadable answer fails', () => {
    for (const gh of [{ code: 1 }, { code: 0, out: '' }, { code: 0, out: 'maybe false' }]) {
      const r = runStep('version', dispatch, gh)
      expect(r.status).not.toBe(0)
      expect(r.out.publish).not.toBe('true')
    }
  })
  it('a dispatch with a bad version fails', () => {
    const env = { EVENT_NAME: 'workflow_dispatch', TAG: '', DRAFT: '', PRERELEASE: '', INPUT_VERSION: 'main' }
    const r = runStep('version', env, { code: 0 })
    expect(r.status).not.toBe(0)
    expect(r.out.publish).not.toBe('true')
  })
})

describe('the newest-release step', () => {
  const list = 'mac-v0.1.6\nmac-v0.1.10\nmac-v0.1.8\nweb-v9.9.9\nmac-v0.1.11-rc1\n'
  const stable = (version: string, gh: { code: number; out?: string } = { code: 0, out: list }) =>
    runStep('newest', { VERSION: version }, gh)
  it('the newest published release moves :stable', () => {
    const r = stable('0.1.10')
    expect(r.status).toBe(0)
    expect(r.out.stable).toBe('true')
  })
  it('an older release (numeric order, other tags and suffixes ignored) does not', () => {
    for (const v of ['0.1.8', '0.1.6']) {
      const r = stable(v)
      expect(r.status).toBe(0)
      expect(r.out.stable).toBe('false')
    }
  })
  it('a version that is not itself in the published list never moves :stable, even above the newest', () => {
    for (const v of ['0.1.11', '0.2.0', '0.1.9']) {
      const r = stable(v)
      expect(r.status).toBe(0)
      expect(r.out.stable).toBe('false')
    }
  })
  it('a list that cannot be read fails the job rather than guessing', () => {
    const r = stable('0.1.10', { code: 1, out: '' })
    expect(r.status).not.toBe(0)
    expect(r.out.stable).not.toBe('true')
  })
  it('an empty list fails too', () => {
    expect(stable('0.1.10', { code: 0, out: '' }).status).not.toBe(0)
  })
})

describe('the Dockerfile', () => {
  const docker = readFileSync(join(here, '../apps/relay/Dockerfile'), 'utf8')
  it('removes the deployed @talos-app packages (and their .pnpm copies) right after pnpm deploy: they are bundled into dist', () => {
    const deploy = docker.indexOf('pnpm --filter @talos-app/relay deploy')
    const rm = docker.indexOf('/out/node_modules/@talos-app')
    expect(deploy).toBeGreaterThan(-1)
    expect(rm).toBeGreaterThan(deploy)
    expect(docker.slice(deploy, rm)).not.toContain('FROM ')
    expect(docker).toMatch(
      /rm -rf[^\n]*\/out\/node_modules\/@talos-app\b[^\n]*\/out\/node_modules\/\.pnpm\/@talos-app\+\*/,
    )
  })
  it('the bundle still bundles @talos-app/* (so the runtime never imports them)', () => {
    const build = readFileSync(join(here, '../apps/relay/scripts/build.mjs'), 'utf8')
    expect(build).toContain("args.path.startsWith('@talos-app/') ? undefined")
  })
})
