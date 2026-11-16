// The saved web bundle's manifest (docs/OLD-CLIENT.md): which deploy it is and a hash of every file, nothing else.
//   node scripts/web-bundle-manifest.mjs make <dir> <sha> <version> <deployed_at>   prints the manifest JSON
//   node scripts/web-bundle-manifest.mjs verify <dir> <manifest.json>               exit 1 unless the files match exactly
// It holds only sha, version, deployed_at and file hashes: no environment, no host, no names. Source maps are never in a
// saved bundle (make refuses a .map), and nothing outside <dir> is read.
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHA = /^[0-9a-f]{40}$/
const VERSION = /^[0-9A-Za-z._-]{1,40}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

/** Every regular file under dir, as posix paths relative to it. A symlink is refused: a bundle is plain files. */
export function listFiles(dir) {
  const out = []
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const abs = join(d, name)
      const st = lstatSync(abs)
      if (st.isSymbolicLink()) throw new Error(`a symlink in the bundle: ${relative(dir, abs)}`)
      if (st.isDirectory()) walk(abs)
      else if (st.isFile()) out.push(relative(dir, abs).split(sep).join('/'))
    }
  }
  walk(dir)
  return out
}

export function hashFiles(dir) {
  const files = {}
  for (const f of listFiles(dir))
    files[f] = createHash('sha256')
      .update(readFileSync(join(dir, f)))
      .digest('hex')
  return files
}

export function makeManifest(dir, sha, version, deployedAt) {
  if (!SHA.test(sha)) throw new Error('sha: 40 lower-case hex characters')
  if (!VERSION.test(version)) throw new Error('version: up to 40 of [0-9A-Za-z._-]')
  if (!ISO.test(deployedAt)) throw new Error('deployed_at: an ISO time in UTC')
  const files = hashFiles(dir)
  const names = Object.keys(files)
  if (!names.includes('index.html')) throw new Error('no index.html: not a built web app')
  const maps = names.filter((f) => f.endsWith('.map'))
  if (maps.length > 0) throw new Error(`source maps are never saved: ${maps.join(', ')}`)
  return { sha, version, deployed_at: deployedAt, files }
}

/** The differences between dir and the manifest's files; empty when they match exactly. */
export function verifyManifest(dir, manifest) {
  const problems = []
  if (!manifest || typeof manifest !== 'object') return ['not a manifest']
  if (!SHA.test(manifest.sha ?? '')) problems.push('manifest: no valid sha')
  if (!VERSION.test(manifest.version ?? '')) problems.push('manifest: no valid version')
  if (!ISO.test(manifest.deployed_at ?? '')) problems.push('manifest: no valid deployed_at')
  const want = manifest.files
  if (!want || typeof want !== 'object' || !('index.html' in want))
    return [...problems, 'manifest: no files, or no index.html']
  const maps = Object.keys(want).filter((f) => f.endsWith('.map'))
  if (maps.length > 0) problems.push(`manifest: lists source maps (${maps.join(', ')})`)
  const have = hashFiles(dir)
  for (const [f, h] of Object.entries(want)) {
    if (!(f in have)) problems.push(`missing: ${f}`)
    else if (have[f] !== h) problems.push(`changed: ${f}`)
  }
  for (const f of Object.keys(have)) if (!(f in want)) problems.push(`not in the manifest: ${f}`)
  return problems
}

// run directly (also through a symlinked path: node resolves the module's own path, not argv's)
const direct = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (direct) {
  const [cmd, ...args] = process.argv.slice(2)
  try {
    if (cmd === 'make' && args.length === 4) {
      process.stdout.write(`${JSON.stringify(makeManifest(args[0], args[1], args[2], args[3]), null, 2)}\n`)
    } else if (cmd === 'verify' && args.length === 2) {
      const problems = verifyManifest(args[0], JSON.parse(readFileSync(args[1], 'utf8')))
      for (const p of problems) console.error(`web-bundle: ${p}`)
      process.exit(problems.length === 0 ? 0 : 1)
    } else {
      console.error(
        'usage: web-bundle-manifest.mjs make <dir> <sha> <version> <deployed_at> | verify <dir> <manifest.json>',
      )
      process.exit(2)
    }
  } catch (e) {
    console.error(`web-bundle: ${e.message}`)
    process.exit(1)
  }
}
