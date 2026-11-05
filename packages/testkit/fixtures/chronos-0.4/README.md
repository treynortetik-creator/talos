# Chronos "times and meta" fixtures (HB1)

The exact stdout of `chronos api <verb>` from Chronos PR #6 as merged to Chronos main,
commit `b930c52efb3ab55562e645a50f1b8a31d5849421` (PR head `9acb73e`), run against a throwaway HOME with `TZ=America/New_York` and a fixed
`CHRONOS_NOW` (Monday 2026-10-05 unless the name says weekend). Everything is fictional. The temp HOME is `$HOME`.

- **Regenerate:** `git -C <chronos> archive b930c52 | tar -x -C <dir>` then `python3 generate.py <dir>` (this folder).
- **Read-only.** `packages/protocol/test/chronos-times.test.ts` parses every file with the protocol schema for its verb
  and fails on a file it can't map.
- **What they show that 0.3 did not:** `version.features`; `ds`/`date_key` as a slot key (`2026-10-05T0945`) or a plain
  date for the same job on another day; `meta` on rows and in `validate`; `when` of type `times` with `days` as
  `daily`, `weekdays` or names (`["mon", "wed"]`) for a named list (the PR's first commits printed integers; Talos still reads both); the `{id, error}` row for an over-4-KiB
  `meta`; `today: "missed"` on a slot key; bare runs with null `run_id`/`started_at`/`runner`; Run now's ad-hoc minute
  key (`2026-10-05T1001`); a stalled slot in `probe` and `health`.
- Nothing is tagged yet, so `third_party/chronos` stays at v0.3.0. `start-times-headless.json` holds a run id Chronos mints, so it differs on every regeneration.
