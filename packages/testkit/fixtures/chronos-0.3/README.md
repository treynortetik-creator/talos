# Chronos 0.3 API goldens

The exact stdout of every `chronos api <verb>` call, recorded by Chronos's own golden generator (`tests/golden.py`, also
`tests/run.sh --golden`) against a throwaway HOME with `TZ=America/New_York` and `CHRONOS_NOW=2026-10-05T07:45`. The
temp HOME is printed as `$HOME`. Covers the WP-C1 verbs and the WP-C2 run verbs (claim, finish, orphans, start,
session-prompt, probe, health).

- **Source:** Chronos (https://github.com/treynortetik-creator/chronos), tag `v0.3.0` (commit `eafbb85ec129cc036b51879e8dc99dbcc08796dd`),
  `tests/golden/api/*.json`, copied byte for byte (`git show v0.3.0:tests/golden/api/<file>`). The same commit is
  vendored as code in `third_party/chronos/`.
- **Refresh:** from the next tag, together with `third_party/chronos/`.
- **Licence:** MIT, from the upstream repository's `LICENSE`.
- **Read-only.** `packages/protocol/test/chronos-goldens.test.ts` parses every file with the protocol schema for its
  verb and fails on any file it can't map. `packages/protocol/scripts/gen-fixtures.ts` builds the `schedule*` frame
  fixtures from them. Real-CLI output for unusual records (0.2 upgrades, hand edits) is in `../../review-fixtures/`.
