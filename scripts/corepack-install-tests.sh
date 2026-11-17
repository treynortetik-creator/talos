#!/usr/bin/env bash
# The installer's core tests (root-install, install-bughunt, uninstall-bughunt) once more, with a corepack pnpm first on PATH.
# A Mac set up by SETUP.md has `corepack enable pnpm` done, so the pnpm an installer meets is corepack's, which downloads pnpm
# into HOME when it is asked its version. A harness fault that only that pnpm shows reached main (KIT-8, red at 05676ca3: the
# test harness's pnpm stand-in hid the corepack link install.sh recognises it by; no CI machine had such a pnpm, and a
# Homebrew one passes). The shims go in a temp folder of this run, put first on PATH for the one Vitest run: the machine's real
# corepack setup and PATH are never touched, and the folder is removed on every way out.
# No corepack is a failure ("corepack missing"), never a skip. Used by scripts/gate.sh (the corepack-install step of the plan) and
# CI's check job (`pnpm test:corepack-install`). Usage: scripts/corepack-install-tests.sh [extra vitest arguments]
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2
command -v corepack >/dev/null 2>&1 || {
  echo "corepack missing: the installer tests with a corepack pnpm cannot run here (corepack ships with Node; this PATH has none)" >&2
  exit 1
}
[ -x node_modules/.bin/vitest ] || {
  echo "no node_modules/.bin/vitest: run pnpm install" >&2
  exit 1
}
shims="$(mktemp -d "${TMPDIR:-/tmp}/pnpm-shims.XXXXXX")" || {
  echo "no temp folder for the corepack shims" >&2
  exit 1
}
trap 'rm -rf "$shims"' EXIT
corepack enable --install-directory "$shims" pnpm || {
  echo "corepack enable --install-directory failed: no corepack pnpm to test with" >&2
  exit 1
}
[ -e "$shims/pnpm" ] || {
  echo "corepack made no pnpm shim in $shims" >&2
  exit 1
}
# the shim must really be corepack's (the harness and install.sh know a corepack pnpm by where its link ends): or this run proves nothing
real="$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$shims/pnpm")" || real=""
case "$real" in
  *corepack*) ;;
  *)
    echo "the pnpm shim ${real:-$shims/pnpm} is not corepack's (its real path has no 'corepack'): the variant would test nothing" >&2
    exit 1
    ;;
esac
# vitest itself, not pnpm: a corepack pnpm would be asked to download itself just to start it
PATH="$shims:$PATH" node_modules/.bin/vitest run --project scripts \
  scripts/root-install.test.ts scripts/install-bughunt.test.ts scripts/uninstall-bughunt.test.ts "$@"
