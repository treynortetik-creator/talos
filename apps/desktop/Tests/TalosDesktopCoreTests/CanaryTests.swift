import Testing

/// Proves the CLT test flags are not silently skipping tests: with TALOS_CANARY_FAIL=1 this deliberately fails, and
/// scripts/guards-test.sh asserts that `test.sh` then exits non-zero (so `job_desktop` goes red). Off by default.
@Suite("Canary")
struct CanaryTests {
  @Test(.enabled(if: envFlag("TALOS_CANARY_FAIL")))
  func deliberatelyFails() {
    #expect(Bool(false), "canary: this failure is expected when TALOS_CANARY_FAIL=1")
  }
}
