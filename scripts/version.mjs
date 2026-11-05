// The one build-time version. Order: APP_VERSION, the deploy platform's commit sha, `git describe`, root package.json.
// Prints the version when run directly; build scripts import `buildVersion`.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function buildVersion() {
  const env = process.env.APP_VERSION?.trim()
  if (env) return env
  const sha = process.env.RAILWAY_GIT_COMMIT_SHA?.trim()
  if (sha) return sha.slice(0, 7)
  try {
    const out = execFileSync('git', ['describe', '--tags', '--always', '--dirty'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
    if (out) return out
  } catch {
    // no git (a Docker build context has none): fall through
  }
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  return pkg.version ?? 'dev'
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(buildVersion())
