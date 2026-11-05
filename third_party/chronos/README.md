# Chronos (vendored, read-only)

> This copy differs from public Chronos 0.4.0 in one place; see DIVERGENCE.md.

The scheduler Talos's Schedules feature drives (docs/SCHEDULES.md S1.1, S3.1). Vendored so the adapter contract runs
against the REAL CLI (`packages/testkit/test/scheduler-contract-real.test.ts`), not only against FakeScheduler.

- **Source:** https://github.com/treynortetik-creator/chronos, tag `v0.4.0` (commit
  `fe9bb5163bededa06789255990461de1fc221ff1`). Only `bin/`, `lib/`, `LICENSE` and the two test stand-ins
  (`tests/fake-claude.sh`, `tests/fake-launchctl.sh`) are copied, byte for byte (`git archive`).
- **Refresh:** re-vendor from a later tag together with `packages/testkit/fixtures/chronos-0.3/` and `chronos-0.4/`.
- **Licence:** MIT (upstream `LICENSE`). Same owner as this repository.
- Python 3.9+, standard library only. Nothing here is imported by the apps; tests run it as `python3 bin/chronos api …`
  in a temp HOME with a fixed `CHRONOS_NOW`.
