// The relay's version: baked in at build time by scripts/build.mjs (from scripts/version.mjs), TALOS_VERSION overrides,
// and an unbundled run (tests, tsx) reports 'dev'.
declare const __TALOS_VERSION__: string | undefined

export const VERSION: string =
  process.env.TALOS_VERSION ?? (typeof __TALOS_VERSION__ === 'string' ? __TALOS_VERSION__ : 'dev')
