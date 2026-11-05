import Foundation
import Testing
@testable import TalosDesktopCore

@Suite("Backoff and crash loop")
struct RestartRulesTests {
  @Test func backoffStepsJitterAndCap() {
    let b = Backoff()
    #expect([0, 1, 2, 3, 4, 9].map { b.delay(attempt: $0, unit: 0) } == [2, 5, 15, 30, 60, 60])
    #expect(b.delay(attempt: 0, unit: 1) == 2.4)
    #expect(b.delay(attempt: 0, unit: -1) == 1.6)
    #expect(b.delay(attempt: 4, unit: 1) == 60, "capped at 60 s even with +20 %")
  }

  @Test func resetsOnlyAfterTenHealthyMinutes() {
    let b = Backoff()
    #expect(b.nextAttempt(previous: -1, runStartedAt: 0, crashAt: 5) == 0)
    #expect(b.nextAttempt(previous: 2, runStartedAt: 100, crashAt: 699) == 3)
    #expect(b.nextAttempt(previous: 2, runStartedAt: 100, crashAt: 700) == 0)
  }

  @Test func aClockJumpBackwardsNeverResets() {
    // Reviewer attack: "clock jumps across the 10-minute reset". A negative run never counts as healthy.
    #expect(Backoff().nextAttempt(previous: 3, runStartedAt: 10_000, crashAt: 100) == 4)
  }

  @Test func fiveRestartsInFifteenMinutesThenStop() {
    var l = CrashLoop()
    for t in [0.0, 10, 20, 30, 40] {
      #expect(l.mayRestart(now: t))
      l.recordRestart(now: t)
    }
    #expect(!l.mayRestart(now: 50), "the 6th crash stops")
    #expect(l.mayRestart(now: 901), "the first restart left the window")
  }

  @Test func threeAutoConfirmsInAnHour() {
    var l = CrashLoop()
    for t in [0.0, 100, 200] { l.recordAutoConfirm(now: t) }
    #expect(!l.mayAutoConfirm(now: 300))
    #expect(l.mayAutoConfirm(now: 3601))
  }

  @Test func entriesFromTheFutureStillCount() {
    var l = CrashLoop()
    for t in [1000.0, 1001, 1002, 1003, 1004] { l.recordRestart(now: t) }
    #expect(!l.mayRestart(now: 10), "a clock moved back must not empty the window")
  }
}
