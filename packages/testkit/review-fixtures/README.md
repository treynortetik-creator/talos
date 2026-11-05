# Review fixtures (PR #29 review, branch review/s0)

Real Chronos CLI output, used by the `review-s0-*` tests. Not vendored by the PR.

- `chronos-c2/`: every `tests/golden/api/*.json` from Chronos `feat/0.3-runs` (commit e5e8b7e), byte for byte.
  Regenerating them with that commit's `tests/golden.py` in a temp HOME gives identical files (checked).
- `probe/`: `{exit, out}` of the real `chronos api <verb>` in a temp HOME (`TZ=America/New_York`,
  `CHRONOS_NOW=2026-10-05T07:45`). `c1-*` = tag `v0.3.0-rc1` (f39d660), `c2-*` = `feat/0.3-runs`. The inputs are
  hand-written `jobs.json` records and 0.2-era state (a `ran-<id>-<ds>` marker with no runs.jsonl row), the shapes an
  upgraded install or a hand edit holds. The temp HOME is printed as `$HOME`.

Kept outside `fixtures/` so the path-pinned America/New_York allowance in `scripts/denylist.generic.txt` doesn't fire.
