# Chronos "times and meta" fixtures

The exact stdout of `chronos api <verb>` from the vendored Chronos v0.4.0 (`third_party/chronos`; it prints
`"chronos": "0.4.0"`), run against a throwaway HOME with `TZ=America/New_York` and a fixed
`CHRONOS_NOW` (Monday 2026-10-05 unless the name says weekend). Everything is fictional. The temp HOME is `$HOME`.

- **Regenerate:** from the repo root, `python3 packages/testkit/fixtures/chronos-0.4/generate.py third_party/chronos packages/testkit/fixtures/chronos-0.4`
  (checkout first, output folder second). Use a short `TMPDIR`.
- **Read-only.** `packages/protocol/test/chronos-times.test.ts` parses every file with the protocol schema for its verb
  and fails on a file it can't map.
- **What they show that 0.3 did not:** `version.features`; `ds`/`date_key` as a slot key (`2026-10-05T0945`) or a plain
  date for the same job on another day; `meta` on rows and in `validate`; `when` of type `times` with `days` as
  `daily`, `weekdays` or names (`["mon", "wed"]`) for a named list (the PR's first commits printed integers; Talos still reads both); the `{id, error}` row for an over-4-KiB
  `meta`; `today: "missed"` on a slot key; bare runs with null `run_id`/`started_at`/`runner`; Run now's ad-hoc minute
  key (`2026-10-05T1001`); a stalled slot in `probe` and `health`.
- Chronos is tagged v0.4.0 and `third_party/chronos` is that tag (plus the one-line divergence in its DIVERGENCE.md). `start-times-headless.json` holds a run id Chronos mints, so it differs on every regeneration.
