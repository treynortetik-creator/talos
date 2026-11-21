// The relay's version: baked in at build time by scripts/build.mjs (from scripts/version.mjs), TALOS_VERSION overrides,
// and an unbundled run (tests, tsx) reports 'dev'.
declare const __TALOS_VERSION__: string | undefined

export const VERSION: string =
  process.env.TALOS_VERSION ?? (typeof __TALOS_VERSION__ === 'string' ? __TALOS_VERSION__ : 'dev')

/**
 * The release this relay image was built from (build-time TALOS_RELEASE, set by the release image build): a strict X.Y.Z, or
 * nothing. A relay that deploys from main sets nothing and says nothing. Anything else is dropped, with one line that never
 * repeats the value.
 */
export function releaseFrom(
  raw: string | undefined,
  warn: (message: string) => void = console.error,
): string | undefined {
  if (raw === undefined || raw === '') return undefined
  if (/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(raw)) return raw
  warn('TALOS_RELEASE ignored: it is not a plain X.Y.Z version, so this relay reports no release')
  return undefined
}

/** Read once, when the module loads. */
export const RELEASE: string | undefined = releaseFrom(process.env.TALOS_RELEASE)
