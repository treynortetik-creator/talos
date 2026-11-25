// The scripts project's setup file (vitest.config.ts): runs before every test file in scripts/. The machine's shared heavy lock
// (CI_SHARED_LOCK: Titan's runner .env and gate env) must never reach a test: a test's copy of ci-local.sh, heavy-lock.sh or
// gate.sh would take the machine's real lock on /mnt/wsl, wait behind real CI and time out, or pass straight through on a
// holder's marker. Tests that build their own environment from process.env (heavy-lock.test.ts, pre-push.test.ts) get it too,
// so it goes here, once, rather than in each file.
// Nor do check's per-test report folders (scripts/ci-test-results.ts): a runner a test starts would write into the real run's.
for (const k of [
  'CI_SHARED_LOCK',
  'TALOS_SHARED_LOCK_HELD',
  'CI_SHARED_CI_FRESH',
  'CI_TEST_RESULTS_DIR',
  'TALOS_TEST_JUNIT_DIR',
  'CI_TEST_RESULTS_ROOT',
  'CI_MOD_REAL', // the mod job's opt-in to the real claude and npm (ci-runner.sh sets it): no test inherits it
])
  delete process.env[k]
