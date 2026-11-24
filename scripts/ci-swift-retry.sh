#!/usr/bin/env bash
# ci-swift-retry.sh <swift test command...>: runs the command once, as it is. It used to follow a failed `swift test` with a run of the
# failed tests alone; the owner's rule is no retries anywhere, so a failed test fails (scripts/ci-no-retries.test.ts). The name stays,
# for the callers (apps/desktop/scripts/ci.sh, guards-test.sh, ci-local/jobs-swift.sh).
exec "$@"
