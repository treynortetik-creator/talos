import Foundation
import Testing
@testable import TalosDesktop

/// D63: the rules for holding the Mac awake, against a fake power source and a fake assertion table that refuses what macOS
/// would refuse (a released id cannot be released twice, and an id that was never taken cannot be released).
fileprivate final class FakePower: PowerSource {
  var onAC = true
}

fileprivate final class FakeAssertions: SleepAssertions {
  var live: Set<UInt32> = []
  var nextId: UInt32 = 100
  var takes = 0
  var refuse = false
  var badReleases = 0
  func take(reason: String) -> UInt32? {
    takes += 1
    if refuse { return nil }
    nextId += 1
    live.insert(nextId)
    return nextId
  }
  func release(_ id: UInt32) {
    if live.remove(id) == nil { badReleases += 1 }
  }
}

@MainActor
@Suite("KeepAwake")
struct KeepAwakeTests {
  fileprivate func make(ac: Bool = true) -> (KeepAwake, FakePower, FakeAssertions) {
    let p = FakePower()
    p.onAC = ac
    let a = FakeAssertions()
    return (KeepAwake(power: p, assertions: a), p, a)
  }

  @Test func offByDefaultHoldsNothing() {
    let (k, _, a) = make()
    k.powerChanged()
    #expect(a.live.isEmpty && a.takes == 0)
    #expect(k.status == .off)
  }

  @Test func onAndPluggedInHoldsExactlyOne() {
    let (k, _, a) = make()
    k.setEnabled(true)
    k.setEnabled(true)
    k.powerChanged()
    #expect(a.live.count == 1 && a.takes == 1)
    #expect(k.status == .holding)
  }

  @Test func onBatteryHoldsNothingAndLetsGoWhenUnplugged() {
    let (k, p, a) = make(ac: false)
    k.setEnabled(true)
    #expect(a.live.isEmpty)
    #expect(k.status == .waitingForPower)
    p.onAC = true
    k.powerChanged()
    #expect(a.live.count == 1)
    p.onAC = false
    k.powerChanged()
    #expect(a.live.isEmpty && a.badReleases == 0)
    #expect(k.status == .waitingForPower)
    p.onAC = true
    k.powerChanged()
    #expect(a.live.count == 1)
  }

  @Test func switchingOffReleases() {
    let (k, _, a) = make()
    k.setEnabled(true)
    k.setEnabled(false)
    #expect(a.live.isEmpty && a.badReleases == 0)
    #expect(k.status == .off)
  }

  @Test func quittingReleasesEvenWhileOn() {
    let (k, _, a) = make()
    k.setEnabled(true)
    #expect(a.live.count == 1)
    k.shutdown()
    #expect(a.live.isEmpty && a.badReleases == 0)
    // and nothing re-takes after quit
    k.powerChanged()
    #expect(a.live.isEmpty)
  }

  @Test func aRefusalIsShownAndRetriedOnTheNextPowerChange() {
    let (k, _, a) = make()
    a.refuse = true
    k.setEnabled(true)
    #expect(k.status == .failed)
    #expect(KeepAwake.caption(.failed).contains("refused"))
    a.refuse = false
    k.powerChanged()
    #expect(k.status == .holding && a.live.count == 1)
  }

  @Test func theCaptionAlwaysSaysAClosedLidMayStillSleep() {
    for s in [KeepAwake.Status.off, .holding, .waitingForPower, .failed] {
      #expect(KeepAwake.caption(s).contains("closed lid"), "\(s)")
    }
  }
}
