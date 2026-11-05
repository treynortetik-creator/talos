// Fails when the committed Xcode project or Info.plist differ from what ios/App/project.yml generates.
// Needs xcodegen (macOS): `node apps/mobile/scripts/check-generated.ts`. Intended for the Mac-side ci-local job.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const appDir = fileURLToPath(new URL('../ios/App/', import.meta.url))
const generated = [
  'App.xcodeproj',
  'App/Info.plist',
  '../TalosShareExtension/Info.plist',
  '../TalosShareExtension/TalosShareExtension.entitlements',
  '../TalosPushExtension/Info.plist',
  '../TalosPushExtension/TalosPushExtension.entitlements',
]

try {
  execFileSync('xcodegen', ['generate', '--spec', 'project.yml'], { cwd: appDir, stdio: 'inherit' })
} catch {
  console.error('check-generated: xcodegen is required (brew install xcodegen)')
  process.exit(2)
}
try {
  execFileSync('git', ['diff', '--exit-code', '--', ...generated], { cwd: appDir, stdio: 'inherit' })
} catch {
  console.error(
    'check-generated: generated files differ from the committed ones. Run `pnpm --filter @talos-app/mobile xcodegen` and commit.',
  )
  process.exit(1)
}
console.log('check-generated: ok')
